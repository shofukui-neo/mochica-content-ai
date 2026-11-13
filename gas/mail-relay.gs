/**
 * コンテンツAI for MOCHICA — 確認コード送信用のメール中継（GAS ウェブアプリ）
 *
 * 送れるのは「6桁の確認コードの定型メール」だけ。件名・本文を外から指定することはできない
 * （共有シークレットが漏れても、任意の文面を送る踏み台にはならない）。
 *
 * 設定手順
 *  1. https://script.google.com で新しいプロジェクトを作り、このコードを貼り付ける
 *  2. 「プロジェクトの設定」→「スクリプト プロパティ」に RELAY_SECRET を追加
 *     （値は32文字以上のランダムな文字列。パスワード生成ツール等で作る）
 *  3. 「デプロイ」→「新しいデプロイ」→ 種類：ウェブアプリ
 *     実行ユーザー：自分 ／ アクセスできるユーザー：全員
 *  4. 表示された URL（…/exec）と RELAY_SECRET を、アプリの
 *     「管理 → 設定 → メール送信（GAS中継）」に入力して「テスト送信」
 *     → 自分に届いた確認コードを入力すると有効化される
 *
 * 差出人はデプロイした Google アカウントになる。
 */
const APP_NAME = 'コンテンツAI for MOCHICA';

function doPost(e) {
  try {
    const d = JSON.parse(e.postData.contents);
    const secret = PropertiesService.getScriptProperties().getProperty('RELAY_SECRET');
    if (!secret || secret.length < 16 || d.secret !== secret) return json({ ok: false, error: 'forbidden' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(d.to) || !/^\d{6}$/.test(d.code)) return json({ ok: false, error: 'bad_request' });
    MailApp.sendEmail({
      to: d.to,
      name: APP_NAME,
      subject: '【' + APP_NAME + '】確認コードのお知らせ',
      body: [
        APP_NAME + ' へのログイン確認コードです。',
        '',
        '確認コード： ' + d.code,
        '',
        '有効期限は10分です。ログイン画面に入力してください。',
        'このメールに心当たりがない場合、第三者があなたのパスワードを入力した可能性があります。',
        '管理者に連絡のうえ、パスワードを変更してください。',
      ].join('\n'),
    });
    return json({ ok: true });
  } catch (err) {
    return json({ ok: false, error: 'error' });
  }
}

function json(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
