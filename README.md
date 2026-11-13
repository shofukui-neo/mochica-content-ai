# コンテンツAI for MOCHICA

企業を調査し、MOCHICAで配信する企業コンテンツ（会社・事業紹介／社員・働き方／選考・イベント案内／フォロー配信）をAIで作成するWebアプリ。

## 構成
- `public/` 画面（ライブラリなしの静的ファイル）
- `api/index.js` API（Vercel Function 1本）
- `lib/core.js` 保存（Vercel Blob 非公開ストア）・認証・暗号・メール・監査
- `lib/ai.js` AI（Gemini）・分類テンプレート・プロンプト。AIを差し替えるときは `gemini()` だけ置き換える
- `gas/mail-relay.gs` 確認コード送信用のGAS（Vercelにはデプロイしない）

## Vercelの環境変数
| 名前 | 内容 |
|---|---|
| `APP_SECRET` | 32文字以上のランダム文字列。セッション署名と設定の暗号化に使う |
| `SETUP_TOKEN` | 最初の管理者を作るときだけ使う合言葉（20文字以上） |
| `BLOB_READ_WRITE_TOKEN` | 非公開Blobストアをプロジェクトに接続すると自動で入る |

AIのAPIキー・メール中継・Googleログイン・利用上限は、ログイン後の「管理 → 設定」で登録する（APIキー等は暗号化して保存）。

## 認証の仕様
- 新規登録なし。管理者が発行したメールアドレス＋仮パスワードのみ（初回ログインでパスワード変更を強制）
- メール中継を設定すると、未確認のブラウザではメールの確認コード（6桁）が必要
- 5回連続失敗でアカウントを一時ロック（15→30→60分）。管理画面から解除可
- Googleログインは、発行済みメールアドレスと一致するGoogleアカウントのみ（設定でクライアントIDを入れたときだけ有効）

## 困ったとき
- 管理者が全員ログインできない：Blobストアの `meta/setup.json` を削除すると、`SETUP_TOKEN` で初期設定をやり直せる
- 確認コードのメールが届かずログインできない：Blobストアの `meta/settings.json` を削除（メール中継とAI設定が初期化される）
- `APP_SECRET` を変えると全員ログアウトされ、APIキー等の再入力が必要（パスワードは影響なし）

## ローカル確認
```
npm install
APP_SECRET=$(openssl rand -hex 32) SETUP_TOKEN=$(openssl rand -hex 20) STORE_DIR=/tmp/cai AI_MOCK=1 node dev/server.mjs
SETUP_TOKEN=（同じ値） STORE_DIR=/tmp/cai node dev/test.mjs /dev/null   # APIテスト（別ターミナル・初期状態のストアで）
```
