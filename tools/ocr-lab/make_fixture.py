"""Generate a printed synthetic receipt: startup/load test, not handwriting accuracy."""
import json
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

root = Path(__file__).resolve().parent / 'samples'
root.mkdir(parents=True, exist_ok=True)
lines = ['受付伝票', '受付日 2026/10/04', 'お客様名 山田太郎', 'フリガナ ヤマダタロウ',
         '電話番号 09012345678', '管理番号 12345', '商品名 作業ズボン',
         '色 ブラック', 'サイズ L', '個数 2', '作業内容 裾上げ', '注文金額 3980円']
image = Image.new('RGB', (1000, 1300), 'white')
draw = ImageDraw.Draw(image)
font = ImageFont.truetype('C:/Windows/Fonts/meiryo.ttc', 44)
draw.rectangle((30, 30, 970, 1270), outline='black', width=2)
for i, line in enumerate(lines):
    draw.text((65, 65 + i * 95), line, font=font, fill='black')
image.save(root / 'synthetic-printed.png')
(root / 'synthetic-printed.json').write_text(json.dumps({
    'synthetic': True, 'text': '\n'.join(lines),
    'fields': {'customerName': '山田太郎', 'phone': '09012345678',
               'productNumber': '12345', 'quantity': '2', 'amount': '3980'}
}, ensure_ascii=False, indent=2), encoding='utf-8')
print('Synthetic printed receipt generated. Not a real receipt accuracy test.')
