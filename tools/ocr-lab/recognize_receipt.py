"""Local production trial worker: high-resolution Qwen NF4, no reference/sample lookup."""
import json
import sys
import time
import warnings
import re
import datetime
import unicodedata
import psutil
from PIL import Image, ImageOps
from benchmark import gpu_engine, ram_guard, score_fields


def clean_fields(raw):
    output = {}
    for key in ['companyName', 'customerName', 'customerKana', 'productName', 'color', 'size']:
        value = raw.get(key)
        if isinstance(value, str) and value.strip():
            output[key] = ''.join(c for c in value.strip()[:160] if unicodedata.category(c) != 'Cc')
    for key, pattern in [('receiptNumber', r'\d{1,12}'), ('phone', r'0\d{9,10}'), ('productNumber', r'\d{5}'), ('branchNumber', r'\d{1,3}')]:
        value = unicodedata.normalize('NFKC', str(raw.get(key) or '')).strip()
        if key == 'phone':
            value = re.sub(r'[()\s-]', '', value)
        if re.fullmatch(pattern, value):
            output[key] = value
    for key in ['quantity', 'unitPrice', 'amount', 'tax', 'depositAmount']:
        value = raw.get(key)
        if isinstance(value, bool):
            continue
        value = unicodedata.normalize('NFKC', str(value)).strip()
        if re.fullmatch(r'\d{1,9}', value) and (key != 'quantity' or int(value) > 0):
            output[key] = int(value)
    value = raw.get('receivedDate')
    if isinstance(value, str):
        try:
            output['receivedDate'] = datetime.date.fromisoformat(value).isoformat()
        except ValueError:
            pass
    return output


def main():
    psutil.Process().nice(psutil.BELOW_NORMAL_PRIORITY_CLASS)
    ram_guard(6)
    warnings.simplefilter('error', Image.DecompressionBombWarning)
    with Image.open(sys.argv[1]) as source:
        if source.format not in ('JPEG', 'PNG', 'WEBP') or source.width * source.height > 24000000:
            raise ValueError('Unsupported or oversized image')
        image = ImageOps.exif_transpose(source).convert('RGB')
    image.thumbnail((2400, 2400), Image.Resampling.LANCZOS)
    predict = gpu_engine(False, 4.5, qwen=True, extract_fields=True, max_pixels=1000000, max_tokens=512)
    ram_guard(6)
    start = time.perf_counter()
    text, detail = predict(image)
    parsed = score_fields(text, {}).get('parsed_fields')
    if parsed is None or detail.get('possibly_truncated'):
        raise ValueError('Invalid extraction')
    fields = clean_fields(parsed)
    print(json.dumps({'ok': True, 'fields': fields, 'seconds': round(time.perf_counter() - start, 1),
                      'reviewRequired': True, 'mode': 'qwen4b-nf4-high-resolution-single-product'}, ensure_ascii=False), flush=True)


if __name__ == '__main__':
    try:
        main()
    except (ValueError, Image.DecompressionBombError, Image.DecompressionBombWarning, OSError):
        print(json.dumps({'ok': False, 'status': 422, 'error': '写真を読み取れませんでした。JPEG・PNG・WebPの鮮明な伝票写真で再試行してください。'}, ensure_ascii=False), flush=True)
        sys.exit(1)
    except Exception:
        print(json.dumps({'ok': False, 'status': 503, 'error': 'OCRを実行できませんでした。PCの空きRAM・GPUメモリ、モデルの準備状態を確認してください。'}, ensure_ascii=False), flush=True)
        sys.exit(1)
