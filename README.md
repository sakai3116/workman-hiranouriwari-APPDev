# ワークマンアプリ（完全個人）

ワークマンプラス平野瓜破店向けの、受付伝票・作業履歴を管理し検索できるアプリの開発プロジェクトです。

## 方針

- AppSheetではなく、コードで開発する。
- 店内に、OCRの稼働とデータ保存を兼ねるローカルマシンを1台設置する。
- スマートフォン、タブレット、PCから、VPN経由でそのマシンへアクセスする。
- データベースはサーバー側だけに置き、クライアントから直接アクセスできない構成にする（ECサイトのような構成）。

## ローカル起動（最小Webアプリ）

Node.jsがインストールされた環境で、次のコマンドを実行します。

```sh
npm start
```

ブラウザで `http://127.0.0.1:3000` を開くと、ワークマンアプリが表示されます。

## Tailscale VPN経由で他端末から使う

WebアプリはサーバーPCの `127.0.0.1:3000` だけで待ち受けます。スマートフォン・ノートPCからのアクセスには **Tailscale Serve** を使います。これにより、自宅LAN全体へ公開せず、同じTailnetに参加している端末だけへHTTPSで公開できます。PostgreSQL（5432番ポート）は公開しません。

### 初回設定（サーバーPCで一度だけ）

1. サーバーPCにTailscaleをインストールし、Tailscaleへログインします。
2. スマートフォン・ノートPCにもTailscaleをインストールし、**同じTailnet**へログインします。
3. サーバーPCでWebサーバーを起動します。サービス管理EXEの「Webサーバー」→「起動」、またはプロジェクトフォルダで `npm start` を実行します。
4. サーバーPCで**管理者として PowerShell を起動**し、次を実行します。

   ```powershell
   tailscale serve --bg 3000
   ```

5. 初回のみ、表示されたTailscaleの許可用URLをブラウザで開き、Serveの利用を許可します。
6. コマンド出力に表示される `https://＜PC名＞.＜Tailnet名＞.ts.net/` が接続用URLです。スマートフォン・ノートPCのブラウザで開きます。

### 日常の起動手順

1. サーバーPCでTailscaleが起動・ログイン済みであることを確認します。
2. Webサーバーを起動します。
3. 別端末では、上記の `https://…ts.net/` のURLを開きます。

`tailscale serve --bg 3000` の設定はバックグラウンドで維持されるため、通常は毎回設定し直す必要はありません。PC再起動後も、Webサーバーさえ起動すれば同じURLから接続できます。

### 状態確認・停止

サーバーPCの管理者 PowerShell で実行します。

```powershell
# Serveの公開URLと状態を確認
tailscale serve status

# Tailnet内への公開を停止
tailscale serve --https=443 off
```

外部端末で `http://127.0.0.1:3000/` を開いてはいけません。`127.0.0.1` はアクセスした端末自身を指すためです。必ず `https://…ts.net/` のURLを使います。インターネット全体へ公開するTailscale Funnelは使用しません。

### URLのPC名を変更する（任意）

URLの先頭にあるPC名はTailscaleのマシン名です。サーバーPCの管理者 PowerShell で、たとえば次のように変更できます。

```powershell
tailscale set --hostname=wm-001
tailscale serve status
```

変更後は、`https://wm-001.＜Tailnet名＞.ts.net/` のような新しいURLを使用します。

WebアプリはNode.jsで動作します。PostgreSQLへ移行するための `pg` パッケージも導入済みです。

## Web・DBの個別管理

WebサーバーとPostgreSQL DBは、それぞれ別のプロセス・ポートで管理します。

| 対象 | IP・ポート | 起動対象 |
| --- | --- | --- |
| Webアプリ | `127.0.0.1:3000`（Tailscale ServeでVPN公開） | Node.js (`server.mjs`) |
| PostgreSQL DB | `127.0.0.1:5432` | Windowsサービス `postgresql-x64-18` |

個別管理用EXEは [WorkmanServiceControlWebDb.exe](tools/WorkmanServiceControlV2/publish/WorkmanServiceControlWebDb.exe) です。Tailscale Serve は管理者 PowerShell で一度設定すればよく、このEXEでは管理しません。

- 起動時に管理者権限を許可します。
- Web／DBを別々に起動・停止できます。
- 各サービスのIP・ポート・状態を表示します。
- PostgreSQLの停止中は、WebアプリのDB処理は利用できません。

## PostgreSQL

- アプリ用データベース: `workman_app`
- アプリ用ロール: `workman_app`
- スキーマ: `scripts/postgres-schema.sql`
- SQLiteからの移行スクリプト: `scripts/migrate-sqlite-to-postgres.mjs`
- 既存の `data/workman-prototype.sqlite` は、移行後もバックアップとして保持します。

## サービス管理EXE

`tools/WorkmanServiceManager` に、ローカルWebサーバーを起動・状態確認するWindows用管理アプリのソースがあります。ビルド済みEXEは `tools/WorkmanServiceManager/publish/WorkmanServiceManager.exe` です。

- ビルド済みの `WorkmanServiceManager.exe` を起動すると、サーバーが稼働中か確認できます。
- 停止中の場合は「サーバーを起動」を押すと、プロジェクト内の `server.mjs` を起動します。
- 「サーバーを停止」は、ポート3000で稼働しているNode.jsのWebサーバーを確認ダイアログ後に停止します。
- このEXEはPC起動時の自動起動を設定するものではありません。PC起動後に手動で起動してください。
- Webアプリの起動にはNode.jsが必要です。
- このビルド済みEXEの実行には .NET 9 Desktop Runtime が必要です（開発PCには導入済み）。

## プロトタイプ用管理画面

- Webサーバー起動後、管理画面は `http://127.0.0.1:3000/admin` で開けます。
- 初期管理者IDは `admin`、パスワードは `software` です。
- 管理画面では、DBの保存先、登録件数、登録済みデータを確認できます。
- この認証はローカルプロトタイプ用です。本番運用前にはパスワード変更、HTTPS、利用者ごとのアカウント管理を実装します。

## 画面

### タイトル画面

- 検索ボタン
- 同期ボタン（PCでのF5相当）
- 複数選択ボタン
- 新規追加ボタン

### 新規追加画面

#### 受付情報

- アプリ内番号（データベース確認用）
- 伝票写真（撮影済みの写真の添付、またはアプリからの撮影・添付）
- アプリへの登録日
- 紙媒体で受付した日
- 受付担当者（初期値は「指定なし」、選択式）
- お客様名
- フリガナ
- 電話番号
- 作業内容
  - 発注、刺繍、裾上げ、プリント、予約、見積、その他から選択する。
  - 「その他」選択時は自由記入できるようにする。

#### 商品情報（複数追加可能）

- 5桁管理番号
- 枝番
- 5桁管理番号＋枝番（上記から自動計算）
- 商品名
- 色
- サイズ
- 個数
- 商品ごとの作業状態
  - 受付全体の作業内容とは別に、商品ごとの作業内容を扱えるようにする。
  - 例：商品Aは裾上げ、商品Bは刺繍など。

#### 作業詳細

- 刺繍・プリント位置
- 刺繍・プリント内容
- 糸色・書体
- 裾上げ方法（総丈、股下、裾から何cm）
- 長さ（cm）
- 裾上げ
- 裾上げ糸色
- 余り布の有無（破棄、お渡し、その他）
- 裾上げ備考

#### 金額・確認

- 注文金額
- 売掛金（あり／なし）
- 内金（あり／なし）
- 備考・注意事項
- 完成写真
- 確認状態（登録済み／要確認）
