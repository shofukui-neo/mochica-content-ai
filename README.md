# コンテンツAI for MOCHICA

企業を調査し、MOCHICAで配信する企業コンテンツ（会社・事業紹介／社員・働き方／選考・イベント案内／フォロー配信）をAIで作成するWebアプリ。

## 構成
- `public/` 画面（ライブラリなしの静的ファイル）
- `api/index.js` API（Vercel Function 1本）
- `lib/core.js` 保存（Vercel Blob 非公開ストア）・認証・暗号・メール・監査
- `lib/web.js` HPからの画像取得（内部ネットワーク宛てを遮断する安全な取得・署名つきURLでの画像中継）。リッチメッセージ作成で使う
- `lib/ai.js` AI（Gemini）・分類テンプレート・プロンプト。AIを差し替えるときは `gemini()` だけ置き換える
- `gas/mail-relay.gs` 確認コード送信用のGAS（Vercelにはデプロイしない）

## Vercel側の設定
- 非公開のBlobストアをプロジェクトに接続する（`BLOB_STORE_ID` が自動で入り、認証はOIDC。長期トークン不要）
- 署名・暗号化用の鍵は初回起動時に自動生成してストアの `meta/secret.json` に保存する。環境変数 `APP_SECRET`（32文字以上）を入れればそちらを優先
- 最初の管理者を作る合言葉は `meta/setup-token.json` に自動生成される（初期設定が終わると削除）。環境変数 `SETUP_TOKEN`（20文字以上）でも指定できる

AIのAPIキー・メール中継・Googleログイン・利用上限は、ログイン後の「管理 → 設定」で登録する（APIキー等は暗号化して保存）。

## 企業の素材（インプット）
企業ごとに「素材」を貯め、「素材から企業情報を更新」でAIが企業情報に統合する（1つ前の内容に戻せる）。
- HP：トップと採用・会社紹介・福利厚生などのページ（最大6つ）の本文。企業調査でURLを入れたときも自動で取り込む
- PowerPoint・PDF・テキスト：ブラウザ内で文字を読み取り、文字だけをサーバーに送る（`public/vendor` の fflate・pdf.js）
- スクショ：AI（Gemini）が書き起こす
- 貼り付け：求人サイトの掲載原稿やSNSの投稿文
マイナビ（サイトポリシーでロボットによる機械的取得を禁止）やSNSは自動取得しない。

## リッチメッセージ作成
画像は「HPから（トップ＋採用・会社紹介らしいページ最大3つ）／ファイルから（写真・PowerPointの中の画像・PDFのページ）／AIで生成」の3つの方法で集め、分割テンプレートに並べて、LINEリッチメッセージ用（幅1040px：正方形1040×1040〔分割可〕・横長1040×520・縦長1040×1560、JPEG）の画像を書き出す。画像の合成はブラウザ内で行い、サーバーには保存しない。HPの大きい画像はサーバーで長辺2080pxに縮小して中継する（sharp）。タイトル・画像の文字・一緒に送るメッセージは、企業情報と読み込んだ資料からAIで作れる。
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
