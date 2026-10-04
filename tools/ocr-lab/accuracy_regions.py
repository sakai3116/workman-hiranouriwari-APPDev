"""Field-aware OCR experiment on the authorized sample; manual ROIs, no truth in prompts."""
import argparse
import hashlib
import json
from pathlib import Path
import time
import msvcrt
import psutil
from PIL import Image, ImageOps
from benchmark import HERE, ROOT, Monitor, db_probe, gpu_engine, gpu_info, ram_guard, score_fields

REGIONS = [
    ('01-request-number', '依頼番号', ['receiptNumber'], '数字だけ。'),
    ('02-company', '会社名', ['companyName'], '手書きの会社名。'),
    ('03-customer-kana', 'フリガナ', ['customerKana'], '手書きの姓と名の読みをカタカナで。'),
    ('04-customer-name', '氏名', ['customerName'], '手書きの姓と名を省略せず。'),
    ('05-phone', '電話番号', ['phone'], '括弧と空白を除いた数字だけ。'),
    ('06-product-number', '品番と枝番', ['productNumber', 'branchNumber'], 'ハイフンの前が品番、後が枝番。文字列として返す。'),
    ('07-description', '商品説明', ['productName', 'color', 'size'], '商品名・色・サイズを分離。商品名に色とサイズを含めない。'),
    ('08-quantity', '数量', ['quantity'], '記載された整数。'),
    ('09-unit-price', '単価', ['unitPrice'], '記載された円の整数額。'),
    ('11-total', '合計金額', ['amount'], '記載された円の整数額。'),
    ('12-tax', '内消費税', ['tax'], '記載された円の整数額。'),
    ('13-deposit', '内金ご入金額', ['depositAmount'], '記載された円の整数額。数字の左右の飾り線は値に含めない。'),
    ('14-date', '受付日', ['receivedDate'], '記載された日付をYYYY-MM-DDで。'),
]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--qwen-precision', choices=['nf4', 'bf16'], default='nf4')
    args = parser.parse_args()
    sample = HERE / 'inputs' / 'sample-5747'
    db_path = ROOT / 'data' / 'workman-prototype.sqlite'
    out_dir = HERE / 'results'
    with (out_dir / 'benchmark.lock').open('r+b') as lock:
        msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
        psutil.Process().nice(psutil.BELOW_NORMAL_PRIORITY_CLASS)
        ram_guard(4 if args.qwen_precision == 'bf16' else 6)
        before = hashlib.sha256(db_path.read_bytes()).hexdigest()
        report = {'experiment': 'manual-region-field-aware', 'model': 'Qwen/Qwen3-VL-4B-Instruct',
                  'prompt_version': 'keys-only-v2', 'precision': args.qwen_precision, 'max_pixels': 1000000,
                  'manual_regions': True, 'truth_used_in_prompts': False,
                  'gpu_before': gpu_info(), 'db_baseline': [db_probe(db_path) for _ in range(10)], 'regions': []}
        combined = {}
        with Monitor(db_path) as monitor:
            start = time.perf_counter()
            predict = gpu_engine(False, 4.5, qwen=True, max_pixels=1000000, max_tokens=256,
                                 qwen_precision=args.qwen_precision)
            report['model_load_seconds'] = time.perf_counter() - start
            for stem, label, keys, rule in REGIONS:
                ram_guard(4 if args.qwen_precision == 'bf16' else 6)
                if stem == '14-date':
                    with Image.open(sample / '00-whole.png') as source:
                        source = ImageOps.exif_transpose(source).convert('RGB')
                        w, h = source.size
                        image = source.crop((int(w*.437), int(h*.118), int(w*.68), int(h*.145)))
                else:
                    with Image.open(sample / 'regions' / (stem + '.png')) as source:
                        image = source.convert('RGB')
                prompt = ('この画像は日本語の注文伝票の「' + label + '」欄です。'
                          '実際に書かれている内容だけを読み、以下のJSON形式だけを返してください。'
                          '読めない項目はnullにし、推測や計算で補完しないでください。' + rule +
                          '\n出力するキー: ' + ', '.join(keys))
                start = time.perf_counter()
                text, detail = predict(image, prompt_override=prompt)
                elapsed = time.perf_counter() - start
                # Only parse model output here. Reference is loaded after all inference completes.
                parsed = score_fields(text, {}).get('parsed_fields', {})
                for key in keys:
                    combined[key] = parsed.get(key)
                report['regions'].append({'region': stem, 'label': label, 'keys': keys, 'prompt': prompt,
                                          'text': text, 'seconds': elapsed, **detail})
                print(json.dumps({'region': stem, 'seconds': round(elapsed, 3)}, ensure_ascii=True), flush=True)
        report['resources'] = monitor.summary()
        report['combined_fields'] = combined
        truth = json.loads((sample / '00-whole.json').read_text(encoding='utf-8-sig'))
        report['evaluation'] = score_fields(json.dumps(combined, ensure_ascii=False), truth)
        report['db_file_unchanged_during_test'] = before == hashlib.sha256(db_path.read_bytes()).hexdigest()
        report['recognition_seconds'] = sum(r['seconds'] for r in report['regions'])
        report['gpu_after'] = gpu_info()
        path = out_dir / (time.strftime('%Y%m%d-%H%M%S') + '-regions-' + args.qwen_precision + '.json')
        path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
        print(str(path), flush=True)


if __name__ == '__main__':
    main()
