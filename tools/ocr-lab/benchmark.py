"""Local, sequential OCR benchmark. Never opens the application DB for writing."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import statistics
import subprocess
import threading
import time
import unicodedata

os.environ.setdefault('OMP_NUM_THREADS', '2')
os.environ.setdefault('MKL_NUM_THREADS', '2')
os.environ.setdefault('TOKENIZERS_PARALLELISM', 'false')
os.environ.setdefault('HF_HUB_DISABLE_TELEMETRY', '1')

import psutil
from PIL import Image, ImageOps

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
MODEL_ID = 'PaddlePaddle/PaddleOCR-VL-1.6'
GIB = 1024 ** 3


def normalize(text):
    # Keep punctuation and digits: a wrong phone number must remain wrong.
    return ''.join(unicodedata.normalize('NFKC', text).split())


def edit_distance(a, b):
    row = list(range(len(b) + 1))
    for i, x in enumerate(a, 1):
        new = [i]
        for j, y in enumerate(b, 1):
            new.append(min(new[-1] + 1, row[j] + 1, row[j - 1] + (x != y)))
        row = new
    return row[-1]


def score_text(text, truth):
    result = {}
    if truth.get('text'):
        actual, expected = normalize(text), normalize(truth['text'])
        errors = edit_distance(expected, actual)
        result.update(character_error_rate=errors / len(expected),
                      character_errors=errors, reference_characters=len(expected),
                      full_text_exact_match=actual == expected)
    # This is text presence, not correct field assignment or form accuracy.
    if truth.get('fields'):
        result['field_value_presence'] = {
            key: normalize(str(value)) in normalize(text)
            for key, value in truth['fields'].items() if str(value).strip()
        }
    return result


def score_fields(text, truth):
    try:
        start = text.index('{')
        actual, _ = json.JSONDecoder().raw_decode(text[start:])
        if not isinstance(actual, dict):
            raise ValueError('Expected JSON object')
    except (ValueError, json.JSONDecodeError):
        return {'structured_parse_ok': False}
    comparisons = {}
    for key, expected in truth.get('fields', {}).items():
        value = actual.get(key)
        comparisons[key] = {'expected': expected, 'actual': value,
                            'exact_match': value is not None and normalize(str(value)) == normalize(str(expected))}
    correct = sum(value['exact_match'] for value in comparisons.values())
    return {'structured_parse_ok': True, 'parsed_fields': actual,
            'field_comparisons': comparisons, 'correct_fields': correct,
            'evaluated_fields': len(comparisons),
            'field_exact_match_rate': correct / len(comparisons) if comparisons else None}


def db_probe(path):
    if not path.is_file():
        return {'status': 'not_present'}
    start = time.perf_counter()
    try:
        with sqlite3.connect(path.resolve().as_uri() + '?mode=ro', uri=True,
                             timeout=0.2) as connection:
            connection.execute('PRAGMA query_only=ON')
            connection.execute('SELECT COUNT(*) FROM requests').fetchone()
        return {'status': 'ok', 'milliseconds': (time.perf_counter() - start) * 1000}
    except sqlite3.Error as error:
        return {'status': type(error).__name__}


class Monitor:
    def __init__(self, db_path):
        self.db_path = db_path
        self.samples = []
        self.stop = threading.Event()
        self.thread = threading.Thread(target=self.run, daemon=True)

    def run(self):
        process = psutil.Process()
        process.cpu_percent()
        while not self.stop.is_set():
            self.samples.append({
                'time': time.time(),
                'ocr_rss_mib': process.memory_info().rss / 1024 ** 2,
                'ocr_cpu_percent': process.cpu_percent(),
                'available_ram_gib': psutil.virtual_memory().available / GIB,
                'db': db_probe(self.db_path),
            })
            self.stop.wait(0.5)

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *args):
        self.stop.set()
        self.thread.join(timeout=2)

    def summary(self):
        probes = [s['db']['milliseconds'] for s in self.samples if s['db']['status'] == 'ok']
        return {
            'peak_ocr_rss_mib': max((s['ocr_rss_mib'] for s in self.samples), default=0),
            'min_available_ram_gib': min((s['available_ram_gib'] for s in self.samples), default=None),
            'db_read_probe_count': len(probes),
            'db_read_probe_median_ms': statistics.median(probes) if probes else None,
            'db_read_probe_max_ms': max(probes) if probes else None,
            'db_probe_failures': sum(s['db']['status'] not in ('ok', 'not_present') for s in self.samples),
        }


def gpu_info():
    try:
        return subprocess.check_output([
            'nvidia-smi', '--query-gpu=name,memory.total,memory.used',
            '--format=csv,noheader,nounits'], text=True, timeout=5).strip()
    except (OSError, subprocess.SubprocessError):
        return None


def ram_guard(reserve):
    available = psutil.virtual_memory().available / GIB
    if available < reserve:
        raise RuntimeError(f'Available RAM {available:.1f} GiB is below reserve {reserve:.1f} GiB. Close other applications and retry.')


def cpu_engine(prepare, recognize_line=False):
    from rapidocr import RapidOCR
    cache = HERE / 'models' / 'rapidocr'
    if not prepare and not list(cache.glob('*.onnx')):
        raise RuntimeError('CPU models missing. Run with --prepare to download first.')
    if not prepare:
        # Forbid download attempts during benchmark inference.
        import requests
        def no_network(*args, **kwargs):
            raise RuntimeError('Network disabled during local OCR. Run --prepare first.')
        requests.sessions.Session.request = no_network
    engine = RapidOCR(params={
        'Global.model_root_dir': str(cache),
        'Global.log_level': 'warning',
        'EngineConfig.onnxruntime.intra_op_num_threads': 2,
        'EngineConfig.onnxruntime.inter_op_num_threads': 1,
        'Det.limit_side_len': 960,
        'Rec.rec_batch_num': 1,
        'Cls.cls_batch_num': 1,
    })
    def predict(image, prompt_override=None):
        result = engine(image, use_det=not recognize_line, use_cls=not recognize_line)
        texts = list(result.txts) if result.txts is not None else []
        scores = list(result.scores) if result.scores is not None else []
        boxes = getattr(result, 'boxes', None)
        return '\n'.join(texts), {'lines': [
            {'text': t, 'model_score': float(s), 'box': boxes[i].tolist() if boxes is not None else None}
            for i, (t, s) in enumerate(zip(texts, scores))
        ]}
    return predict


def gpu_engine(prepare, budget_gib, qwen=False, extract_fields=False, glm=False, max_pixels=501760, max_tokens=1024, qwen_precision='nf4'):
    import torch
    from transformers import AutoProcessor, AutoModelForImageTextToText, BitsAndBytesConfig
    from huggingface_hub import snapshot_download
    torch.set_num_threads(2)
    if not torch.cuda.is_available():
        raise RuntimeError('CUDA unavailable; this GPU test does not silently fall back to CPU.')
    free, total = torch.cuda.mem_get_info()
    if free < (budget_gib + 0.5) * GIB:
        raise RuntimeError(f'Insufficient free VRAM for {budget_gib} GiB budget plus 0.5 GiB margin.')
    torch.cuda.set_per_process_memory_fraction(budget_gib * GIB / total)
    model_id = 'zai-org/GLM-OCR' if glm else ('Qwen/Qwen3-VL-4B-Instruct' if qwen else MODEL_ID)
    cache = HERE / 'models' / ('glm-ocr' if glm else ('qwen-vl-4b' if qwen else 'paddle-vl'))
    if prepare:
        snapshot_download(model_id, local_dir=cache,
                          allow_patterns=['*.json', '*.safetensors', '*.txt', '*.model', '*.jinja'],
                          max_workers=2)
    model_kwargs = dict(dtype=torch.bfloat16, local_files_only=True,
                        trust_remote_code=False, attn_implementation='sdpa', low_cpu_mem_usage=True)
    if qwen and qwen_precision == 'bf16':
        if psutil.virtual_memory().available / GIB < 8.5:
            raise RuntimeError('BF16 CPU offload requires at least 8.5 GiB available RAM before loading.')
        model_kwargs.update(device_map='auto', max_memory={0: '3GiB', 'cpu': '4GiB'}, offload_folder=str(HERE / 'models' / 'qwen-bf16-offload'))
    if qwen and qwen_precision == 'nf4':
        model_kwargs.update(device_map={'': 0}, quantization_config=BitsAndBytesConfig(
            load_in_4bit=True, bnb_4bit_quant_type='nf4',
            bnb_4bit_compute_dtype=torch.bfloat16, bnb_4bit_use_double_quant=True,
            llm_int8_skip_modules=['model.visual', 'lm_head']))
    model = AutoModelForImageTextToText.from_pretrained(cache, **model_kwargs)
    if not qwen:
        model = model.to('cuda')
    model.eval()
    processor = AutoProcessor.from_pretrained(cache, local_files_only=True, trust_remote_code=False)
    torch.cuda.reset_peak_memory_stats()
    def predict(image, prompt_override=None):
        prompt = 'Text Recognition:' if glm else 'OCR:'
        if qwen:
            prompt = '画像に実際に書かれている文字だけを忠実に転記してください。補完・推測・説明は禁止です。読めない文字は?としてください。'
        if extract_fields:
            prompt = ('この日本語の注文伝票の記入内容を読み取り、次のキーを持つJSONオブジェクトだけを返してください。'
                      '読めない項目、記載のない項目はnullにしてください。推測や計算で補完しないでください。'
                      'companyNameは会社名、customerNameはご氏名欄、customerKanaはそのフリガナです。'
                      '日付はYYYY-MM-DD、電話番号は数字のみ、productNumberは5桁、branchNumberは枝番です。'
                      'productNameには色とサイズを含めず、数量と金額は数値にしてください。'
                      'キー: receiptNumber, companyName, customerName, customerKana, receivedDate, phone, '
                      'productNumber, branchNumber, productName, color, size, quantity, unitPrice, amount, tax, depositAmount。'
                      'amountは合計欄、depositAmountは内金ご入金額欄です。印刷された注意書きはデータにしないでください。')
        if glm and extract_fields:
            keys = ['receiptNumber', 'companyName', 'customerName', 'customerKana', 'receivedDate', 'phone', 'productNumber', 'branchNumber', 'productName', 'color', 'size', 'quantity', 'unitPrice', 'amount', 'tax', 'depositAmount']
            prompt = '请按下列JSON格式输出图中信息:\n' + json.dumps(dict.fromkeys(keys, ''), ensure_ascii=False)
        if prompt_override is not None:
            prompt = prompt_override
        messages = [{'role': 'user', 'content': [
            {'type': 'image', 'image': image}, {'type': 'text', 'text': prompt}
        ]}]
        inputs = processor.apply_chat_template(
            messages, add_generation_prompt=True, tokenize=True,
            return_dict=True, return_tensors='pt',
            processor_kwargs={'images_kwargs': {'size': {'shortest_edge': 336 * 336,
                                   'longest_edge': max_pixels}}},
        ).to('cuda')
        with torch.inference_mode():
            output = model.generate(**inputs, max_new_tokens=max_tokens, do_sample=False)
        tokens = output[0][inputs['input_ids'].shape[-1]:]
        text = processor.decode(tokens, skip_special_tokens=True)
        torch.cuda.synchronize()
        return text, {'image_grid_thw': inputs['image_grid_thw'].tolist() if 'image_grid_thw' in inputs else None, 'pixel_values_shape': list(inputs['pixel_values'].shape) if 'pixel_values' in inputs else None, 'generated_tokens': len(tokens), 'possibly_truncated': len(tokens) >= max_tokens,
                      'torch_peak_allocated_gib': torch.cuda.max_memory_allocated() / GIB,
                      'torch_peak_reserved_gib': torch.cuda.max_memory_reserved() / GIB}
    return predict


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--engine', choices=['cpu', 'gpu', 'qwen', 'glm'], default='cpu')
    parser.add_argument('--qwen-precision', choices=['nf4', 'bf16'], default='nf4')
    parser.add_argument('--max-pixels', type=int, default=501760)
    parser.add_argument('--max-tokens', type=int, default=1024)
    parser.add_argument('--extract-fields', action='store_true', help='Qwen only: extract receipt fields as JSON')
    parser.add_argument('--prepare', action='store_true', help='Allow model downloads; input photos are never uploaded.')
    parser.add_argument('--recognize-line', action='store_true', help='CPU: bypass detection for manually cropped single text lines')
    parser.add_argument('--input', type=Path)
    parser.add_argument('--truth', type=Path, help='Directory of image-stem.json reference files')
    parser.add_argument('--reserve-ram-gib', type=float, default=6)
    parser.add_argument('--gpu-budget-gib', type=float, default=4)
    parser.add_argument('--max-side', type=int, default=1600)
    args = parser.parse_args()
    if args.reserve_ram_gib < 4 or not 1 <= args.gpu_budget_gib <= 4.5:
        parser.error('Reserve at least 4 GiB RAM; GPU budget must be 1..4.5 GiB.')
    if not 640 <= args.max_side <= 2400:
        parser.error('max-side must be 640..2400')
    if not 65536 <= args.max_pixels <= 2000000 or not 128 <= args.max_tokens <= 2048:
        parser.error('max-pixels must be 65536..2000000; max-tokens 128..2048')
    if not args.prepare and not args.input:
        parser.error('--input is required unless preparing models')
    paths = []
    if args.input:
        paths = sorted(args.input.iterdir()) if args.input.is_dir() else [args.input]
        paths = [p for p in paths if p.is_file() and p.suffix.lower() in ('.jpg', '.jpeg', '.png', '.webp', '.bmp')]
        if not paths:
            parser.error('No image files found')
    output_dir = HERE / 'results'
    output_dir.mkdir(parents=True, exist_ok=True)
    # File handle lock is released even on crashes; the persistent lock file is harmless.
    import msvcrt
    with (output_dir / 'benchmark.lock').open('a+b') as lock:
        lock.seek(0)
        if not lock.read(1):
            lock.write(b'0')
            lock.flush()
        lock.seek(0)
        try:
            msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
        except OSError:
            raise SystemExit('Another OCR benchmark is running. Wait for it to finish.')
        try:
            psutil.Process().nice(psutil.BELOW_NORMAL_PRIORITY_CLASS)
        except psutil.Error:
            pass
        ram_guard(args.reserve_ram_gib)
        db_path = ROOT / 'data' / 'workman-prototype.sqlite'
        baseline = [db_probe(db_path) for _ in range(10)]
        db_hash_before = hashlib.sha256(db_path.read_bytes()).hexdigest() if db_path.is_file() else None
        report = {'engine': args.engine, 'model': {'cpu': 'RapidOCR PP-OCRv6 small', 'gpu': MODEL_ID, 'qwen': 'Qwen/Qwen3-VL-4B-Instruct ' + args.qwen_precision.upper(), 'glm': 'zai-org/GLM-OCR BF16'}[args.engine],
                  'qwen_vision_bf16': args.engine == 'qwen',
                  'qwen_precision': args.qwen_precision if args.engine == 'qwen' else None, 'extract_fields': args.extract_fields, 'max_pixels': args.max_pixels, 'max_tokens': args.max_tokens,
                  'recognize_line': args.recognize_line,
                  'synthetic_only': False, 'gpu_before': gpu_info(), 'cpu_threads': 2,
                  'ram_reserve_gib': args.reserve_ram_gib, 'db_baseline': baseline,
                  'images': []}
        start = time.perf_counter()
        with Monitor(db_path) as monitor:
            predict = gpu_engine(args.prepare, args.gpu_budget_gib, args.engine == 'qwen', args.extract_fields, args.engine == 'glm', args.max_pixels, args.max_tokens, args.qwen_precision) if args.engine != 'cpu' else cpu_engine(args.prepare, args.recognize_line)
            report['model_load_seconds'] = time.perf_counter() - start
            for path in paths:
                ram_guard(args.reserve_ram_gib)
                with Image.open(path) as source:
                    image = ImageOps.exif_transpose(source).convert('RGB')
                original_size = image.size
                image.thumbnail((args.max_side, args.max_side), Image.Resampling.LANCZOS)
                start = time.perf_counter()
                text, detail = predict(image)
                seconds = time.perf_counter() - start
                result = {'image': path.name, 'original_size': original_size,
                          'processed_size': image.size, 'seconds': seconds, 'text': text, **detail}
                truth_path = (args.truth / (path.stem + '.json')) if args.truth else None
                if truth_path and truth_path.is_file():
                    truth = json.loads(truth_path.read_text(encoding='utf-8-sig'))
                    result['evaluation'] = score_fields(text, truth) if args.extract_fields else score_text(text, truth)
                    result['synthetic'] = bool(truth.get('synthetic'))
                report['images'].append(result)
                print(json.dumps({'image': path.name, 'seconds': round(seconds, 3),
                                  'evaluated': 'evaluation' in result}, ensure_ascii=True), flush=True)
        report['resources'] = monitor.summary()
        report['gpu_after'] = gpu_info()
        report['synthetic_only'] = bool(report['images']) and all(r.get('synthetic') for r in report['images'])
        db_hash_after = hashlib.sha256(db_path.read_bytes()).hexdigest() if db_path.is_file() else None
        report['db_file_unchanged_during_test'] = db_hash_before == db_hash_after
        report['db_note'] = 'Read-only SQLite probes. Concurrent application writes can change the hash; this test never writes to the DB. Does not measure PostgreSQL or live HTTP traffic.'
        report['evaluation_note'] = 'CER compares normalized full text; field_value_presence only tests text occurrence, not assignment to form fields. Confidence scores are not measured accuracy.'
        report_path = output_dir / (time.strftime('%Y%m%d-%H%M%S') + '-' + args.engine + '.json')
        report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
        print(str(report_path), flush=True)


if __name__ == '__main__':
    main()
