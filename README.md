# コンテンツAI for MOCHICA

企業を調査し、MOCHICAで配信する企業コンテンツ（会社・事業紹介／社員・働き方／選考・イベント案内／フォロー配信）をAIで作成するWebアプリ。

## 構成
- `public/` 画面（ライブラリなしの静的ファイル）
- `api/index.js` API（Vercel Function 1本）
- `lib/core.js` 保存（Vercel Blob 非公開ストア）・認証・暗号・メール・監査
- `lib/web.js` HPからの画像取得（内部ネットワーク宛てを遮断する安全な取得・署名つきURLでの画像中継）。リッチメニュー作成で使う
- `lib/ai.js` AI（Gemini）・分類テンプレート・プロンプト。AIを差し替えるときは `gemini()` だけ置き換える
- `gas/mail-relay.gs` 確認コード送信用のGAS（Vercelにはデプロイしない）

## Vercel側の設定
- 非公開のBlobストアをプロジェクトに接続する（`BLOB_STORE_ID` が自動で入り、認証はOIDC。長期トークン不要）
- 署名・暗号化用の鍵は初回起動時に自動生成してストアの `meta/secret.json` に保存する。環境変数 `APP_SECRET`（32文字以上）を入れればそちらを優先
- 最初の管理者を作る合言葉は `meta/setup-token.json` に自動生成される（初期設定が終わると削除）。環境変数 `SETUP_TOKEN`（20文字以上）でも指定できる

AIのAPIキー・メール中継・Googleログイン・利用上限は、ログイン後の「管理 → 設定」で登録する（APIキー等は暗号化して保存）。

## リッチメニュー作成
企業のHP（トップ＋採用・会社紹介らしいページ最大3つ）から写真の候補を集め、分割テンプレートに並べて、LINE規格（大 2500×1686／小 2500×843、JPEG・1MB以下）の画像を書き出す。画像の合成はブラウザ内で行い、サーバーには保存しない。
HPに写真が無いときは「AIで画像を作る」で生成できる（管理 → 設定 → 画像生成で有効化。Cloudflare Workers AI の FLUX.1 schnell〔毎日の無料枠あり〕か Gemini の画像モデル〔課金設定が必要〕を選ぶ。`lib/image.js`）。

## 認証の仕様
- 新規登録なし。管理者が発行したメールアドレス＋仮パスワードのみ（初回ログインでパスワード変更を強制）
- メール中継を設定すると、未確認のブラウザではメールの確認コード（6桁）が必要
- 5回連続失敗でアカウントを一時ロック（15→30→60分）。管理画面から解除可
- Googleログインは、発行済みメールアドレスと一致するGoogleアカウントのみ（設定でクライアントIDを入れたときだけ有効）

## 困ったとき
- 管理者が全員ログインできない：Blobストアの `meta/setup.json` を削除すると、新しい合言葉（`meta/setup-token.json`）で初期設定をやり直せる
- 確認コードのメールが届かずログインできない：Blobストアの `meta/settings.json` を削除（メール中継とAI設定が初期化される）
- 鍵（`meta/secret.json` または `APP_SECRET`）を変えると全員ログアウトされ、APIキー等の再入力が必要（パスワードは影響なし）

## 容量の目安
Vercel Blob（Hobby）は月あたり読み取り1万回・書き込み/一覧2千回まで。利用者が増えたら `lib/core.js` の `db`（get/set/create/del/keys/all の6関数）をPostgresやRedisに差し替える。

## ローカル確認
```
npm install
APP_SECRET=$(openssl rand -hex 32) SETUP_TOKEN=$(openssl rand -hex 20) STORE_DIR=/tmp/cai AI_MOCK=1 node dev/server.mjs
SETUP_TOKEN=（同じ値） STORE_DIR=/tmp/cai node dev/test.mjs /dev/null   # APIテスト（別ターミナル・初期状態のストアで）
```
