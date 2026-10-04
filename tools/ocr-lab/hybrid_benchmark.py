"""Whole-page extraction plus independent numeric ROI consensus; manual sample ROIs."""
import hashlib
import json
import msvcrt
import re
import time
import unicodedata
import psutil
from PIL import Image
from benchmark import HERE, ROOT, Monitor, db_probe, gpu_engine, cpu_engine, gpu_info, ram_guard, score_fields

RAW_PROMPT = '画像に実際に書かれている文字だけを忠実に転記してください。補完・推測・説明は禁止です。読めない文字は?としてください。'
SPECS = [
    ('01-request-number', ['receiptNumber'], 'receipt'),
    ('05-phone', ['phone'], 'phone'),
    ('06-product-number', ['productNumber', 'branchNumber'], 'product'),
    ('08-quantity', ['quantity'], 'integer'),
    ('09-unit-price', ['unitPrice'], 'integer'),
    ('11-total', ['amount'], 'integer'),
    ('12-tax', ['tax'], 'integer'),
    ('13-deposit', ['depositAmount'], 'deposit'),
]


def parse_numeric(text, kind):
    t = ''.join(unicodedata.normalize('NFKC', text).split())
    if kind == 'product':
        m = re.fullmatch(r'(\d{5})[-−–—](\d{1,3})', t)
        return (m.group(1), m.group(2)) if m else None
    if kind == 'phone':
        t = re.sub(r'[()\-]', '', t)
        return (t,) if re.fullmatch(r'0\d{9,10}', t) else None
    if kind == 'receipt':
        return (t,) if re.fullmatch(r'\d{6}', t) else None
    if kind == 'deposit':
        # Only decorative marks surrounding zero. Never reinterpret a negative nonzero payment.
        if re.fullmatch(r'[−—–\-→←~〜]*0[−—–\-→←~〜]*', t):
            return (0,)
    if re.fullmatch(r'\d+|\d{1,3}(?:,\d{3})+', t):
        return (int(t.replace(',', '')),)
    return None


def numeric_consensus(cpu_text, vlm_text, kind):
    a, b = parse_numeric(cpu_text, kind), parse_numeric(vlm_text, kind)
    return a if a is not None and a == b else None


def main():
    sample = HERE / 'inputs' / 'sample-5747'
    db_path = ROOT / 'data' / 'workman-prototype.sqlite'
    out_dir = HERE / 'results'
    with (out_dir / 'benchmark.lock').open('r+b') as lock:
        msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
        psutil.Process().nice(psutil.BELOW_NORMAL_PRIORITY_CLASS)
        ram_guard(6)
        before = hashlib.sha256(db_path.read_bytes()).hexdigest()
        report = {'experiment': 'whole-page-plus-numeric-consensus-v1',
                  'manual_regions': True, 'truth_used_in_prompts_or_fusion': False,
                  'max_pixels': 1000000, 'gpu_before': gpu_info(),
                  'db_baseline': [db_probe(db_path) for _ in range(10)], 'regions': []}
        with Monitor(db_path) as monitor:
            start = time.perf_counter()
            gpu = gpu_engine(False, 4.5, qwen=True, extract_fields=True,
                             max_pixels=1000000, max_tokens=512)
            cpu = cpu_engine(False, recognize_line=True)
            report['model_load_seconds'] = time.perf_counter() - start
            with Image.open(sample / '00-whole.png') as source:
                whole = source.convert('RGB')
            whole.thumbnail((2400, 2400), Image.Resampling.LANCZOS)
            start = time.perf_counter()
            text, detail = gpu(whole)
            report['whole'] = {'text': text, 'seconds': time.perf_counter() - start, **detail}
            combined = dict(score_fields(text, {}).get('parsed_fields', {}))
            for stem, keys, kind in SPECS:
                ram_guard(6)
                with Image.open(sample / 'regions' / (stem + '.png')) as source:
                    image = source.convert('RGB')
                start = time.perf_counter()
                cpu_text, _ = cpu(image)
                vlm_text, detail = gpu(image, prompt_override=RAW_PROMPT)
                values = numeric_consensus(cpu_text, vlm_text, kind)
                if values is not None:
                    combined.update(zip(keys, values))
                report['regions'].append({'region': stem, 'keys': keys, 'kind': kind,
                                          'cpu_text': cpu_text, 'vlm_text': vlm_text,
                                          'consensus_values': values,
                                          'seconds': time.perf_counter() - start, **detail})
                print(json.dumps({'region': stem, 'accepted_consensus': values is not None}), flush=True)
        report['combined_fields'] = combined
        # Reference is only loaded for scoring after all inference and fusion have finished.
        truth = json.loads((sample / '00-whole.json').read_text(encoding='utf-8-sig'))
        report['evaluation'] = score_fields(json.dumps(combined, ensure_ascii=False), truth)
        report['resources'] = monitor.summary()
        report['recognition_seconds'] = report['whole']['seconds'] + sum(r['seconds'] for r in report['regions'])
        report['db_file_unchanged_during_test'] = before == hashlib.sha256(db_path.read_bytes()).hexdigest()
        report['gpu_after'] = gpu_info()
        report['review_required'] = True
        report['review_note'] = 'OCR consensus is not proof of correctness. Never save these results without human review.'
        path = out_dir / (time.strftime('%Y%m%d-%H%M%S') + '-hybrid.json')
        path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
        print(str(path), flush=True)


if __name__ == '__main__':
    main()
