# ローカルOCR精度・負荷検証

アプリと独立した試験です。写真を外部AIへ送らず、DBに登録・更新しません。
CPU: RapidOCR / PP-OCRv6 small。GPU: PaddleOCR-VL-1.6とQwen3-VL-4B-Instruct（NF4・画像部分はBF16）。
GPU側は公式Transformers方式の文字認識試験であり、ページ解析パイプラインやフォームへの項目割当はまだ含みません。

## 起動例（プロジェクトのPowerShell）

```powershell
.\.venv-ocr\Scripts\python.exe tools\ocr-lab\benchmark.py --engine cpu --input '写真フォルダ'
.\.venv-ocr\Scripts\python.exe tools\ocr-lab\benchmark.py --engine gpu --input '写真フォルダ'
.\.venv-ocr\Scripts\python.exe tools\ocr-lab\benchmark.py --engine qwen --extract-fields --input '写真フォルダ' --truth '正解フォルダ'
```

モデルの初回取得のみ `--prepare` を使います。通常推論はローカルモデルだけを使用します。
CPUの文字行だけを切り出した画像では `--recognize-line` を指定します。伝票全体には指定しません。
写真は1枚ずつ、CPUは2スレッド、Windowsの優先度は通常より低く設定します。
空きRAMが6GiBを下回ると次の写真の処理を開始しません。これは厳密なRAM上限ではありません。
GPUのPyTorchアロケータ予算は4GiBです。CUDA等の追加メモリもあるため総VRAMの厳密な上限ではありません。
低負荷のSQLite読取を0.5秒ごとに測り、速度と最大RSS・空きRAMも結果JSONへ保存します。
実際の同時アクセスやPostgreSQLへの影響は別途測定が必要です。
試験終了時にモデルは解放され、常駐しません。

## 正解データ

写真と同じファイル名（拡張子だけ `.json`）の正解を別フォルダに置き、`--truth '正解フォルダ'` を指定します。

```json
{
  "text": "写真に書かれた文字を読み順にすべて入力",
  "fields": {"customerName": "山田太郎", "phone": "09012345678"}
}
```

全文の文字誤り率（CER）と完全一致を計算します。CERは小さいほど良い値です。
空白・改行と全角半角を正規化しますが、数字・句読点の誤りは消しません。
`fields` は正解文字列がOCR結果に含まれるかのみを検査します。
これはフォームへの正しい項目割当率ではなく、短い値では偶然の一致もあります。
Qwenの `--extract-fields` ではJSONの各キーと正解の同じキーを比較して、項目完全一致率を計算します。
この抽出は試験用の1商品分のスキーマです。複数商品、チェック項目、既存フォームへの入力は実装していません。
モデルのconfidenceは正解率ではありません。実伝票の誤読は正解データと人の確認で評価します。

`make_fixture.py` の印刷サンプルは動作・負荷確認専用です。実伝票や手書きの精度とは区別します。
`samples/`、`models/`、`results/` はGit対象外です。結果JSONには読取文字が含まれるためローカルで管理してください。

## 今回の実機試験

- i5-14400F / RAM 32GB / RTX 4060 Ti 8GBで実行しました。
- 許可された実伝票1枚を使用。目視の正解は未確定のため暫定評価です。
- `results/sample-5747-report.md` に完全一致数、読み取り結果、負荷計測をまとめています。
- 欄切り出しの座標はこの写真を目視して決めたものです。他の写真への自動位置合わせは未実装です。
- 現在のWebアプリはSQLiteを利用。試験のDB計測はSQLiteだけで、PostgreSQLや複数利用者の本番負荷試験ではありません。
- `.venv-ocr` は既存Python `C:\my_dev\RoMa_test\Python311` を基に作成しました。このPython本体を移動すると再作成が必要です。既存の他環境のパッケージは変更していません。
- `requirements-tested.txt` に今回の導入バージョンを保存。CUDA対応PyTorchは https://download.pytorch.org/whl/cu128 から導入しました。

## 参照

- https://rapidai.github.io/RapidOCRDocs/main/en/install_usage/rapidocr/usage/
- https://huggingface.co/PaddlePaddle/PaddleOCR-VL-1.6
- https://huggingface.co/Qwen/Qwen3-VL-4B-Instruct

## 精度優先の追加試験

- `results/sample-5747-accuracy-report.md` に追加結果を記載。
- `hardware-guidance.md` にDB兼用の必要スペック目安を記載。
- `hybrid_benchmark.py` は今回のサンプル専用。全体抽出と手動切出し数字欄を照合する。自動位置合わせは未実装。
- `accuracy_regions.py` は同じ写真の欄名指定によるJSON抽出の比較用。
- 新しいGPUモデル `--engine glm` はGLM-OCR BF16。初回のみ `--prepare` で取得。
- `--max-side 2400 --max-pixels 1000000` で高解像度比較。画像グリッドは結果JSONにも保存。
- `--qwen-precision bf16` は量子化なし。GPU/CPU/ディスクに自動分散し、空きRAM8.5GiB以上をモデル読込直前にも確認。
- BF16は `--reserve-ram-gib 4 --gpu-budget-gib 4.5` で試験した。CPU配置4GiBはRSS全体の上限ではない。モデル読込後もRAMを確認し、余裕がなければ停止する。
- 高解像度NF4＋数字照合のGPUアロケータ予算は4.5GiB。デスクトップやCUDA追加分は含まない。
- 7件の採点・照合テストが成功。桁の誤りや枝番の違いを一致にしないことを検査。

```powershell
.\.venv-ocr\Scripts\python.exe tools\ocr-lab\hybrid_benchmark.py
.\.venv-ocr\Scripts\python.exe tools\ocr-lab\benchmark.py --engine qwen --extract-fields --input '写真フォルダ' --truth '正解フォルダ' --max-side 2400 --max-pixels 1000000 --gpu-budget-gib 4.5 --max-tokens 512
```

[GLM-OCR公式モデル](https://huggingface.co/zai-org/GLM-OCR)
