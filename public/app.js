'use strict';
// コンテンツAI for MOCHICA — 画面。外部ライブラリなし。
// 値の表示はすべてテキストノード経由（innerHTML不使用）＝AIの出力や入力値でスクリプトが動かない
const app = document.getElementById('app');
const S = { status: null, user: null, otp: null, tab: 'create', adminTab: 'users', companies: null, draft: {}, open: null };

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k in el) el[k] = v;
    else el.setAttribute(k, v);
  }
  el.append(...kids.flat(Infinity).filter((c) => c != null && c !== false));
  return el;
}
const fmt = (t) => (t ? new Date(t).toLocaleString('ja-JP', { dateStyle: 'short', timeStyle: 'short' }) : '—');
function toast(msg, bad) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = bad ? 'show bad' : 'show';
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.className = ''), bad ? 6000 : 3000);
}

async function api(method, path, body) {
  const r = await fetch('/api/' + path, {
    method, credentials: 'same-origin',
    headers: { 'content-type': 'application/json', 'x-requested-with': 'cai' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (r.ok) return j;
  if (j.code === 'auth' && S.user) { S.user = null; render(); }
  if (j.code === 'must_change' && S.user) { S.user.mustChange = true; render(); }
  if (j.code === 'expired') { S.otp = null; render(); }
  throw Object.assign(new Error(j.error || '通信に失敗しました'), { code: j.code });
}
// 実行中はボタンを無効化（二重送信防止）し、失敗はトーストで知らせる
async function run(b, fn) {
  if (b.disabled) return;
  const label = b.textContent;
  b.disabled = true;
  try { await fn(b); } catch (e) { toast(e.message, true); } finally { b.disabled = false; b.textContent = label; }
}
const btn = (label, onclick, cls) => {
  const b = h('button', { type: 'button', class: cls || '' }, label);
  b.addEventListener('click', () => run(b, onclick));
  return b;
};
function form(submitLabel, onsubmit, ...kids) {
  const b = h('button', { type: 'submit', class: 'primary' }, submitLabel);
  return h('form', { onsubmit: (e) => { e.preventDefault(); run(b, onsubmit); } }, kids, b);
}
const field = (label, control, hint, tag = 'label') => h(tag, { class: 'field' }, h('span', null, label), control, hint && h('small', null, hint));
const card = (title, ...kids) => h('section', { class: 'card' }, title && h('h2', null, title), kids);
const chips = (items, cur, pick) => h('div', { class: 'chips' }, items.map((it) =>
  h('button', { type: 'button', class: it.id === cur ? 'chip on' : 'chip', onclick: () => pick(it.id) }, it.label, it.desc && h('small', null, it.desc))));
const pwInput = (autocomplete) => h('input', { type: 'password', autocomplete, required: true, maxLength: 128 });
const copy = async (text) => { await navigator.clipboard.writeText(text); toast('コピーしました'); };
const go = (tab) => { S.tab = tab; render(); };

async function loadMe() {
  const j = await api('GET', 'me');
  Object.assign(S, { user: j.user, usage: j.usage, limits: j.limits, catalog: j.catalog });
}
async function afterLogin(j) {
  if (j.step === 'otp') S.otp = { to: j.to };
  else { S.otp = null; await loadMe(); }
  render();
}
async function logout(all) {
  await api('POST', 'auth/logout', { all });
  Object.assign(S, { user: null, companies: null, draft: {}, open: null, rm: null, tab: 'create' });
  render();
}

// ---------- ログイン系 ----------
const authCard = (title, lead, ...kids) => h('div', { class: 'auth' },
  h('div', { class: 'logo' }, h('b', null, 'コンテンツAI'), h('span', null, 'for MOCHICA')),
  card(title, h('p', { class: 'muted' }, lead), kids));

function loginView() {
  const email = h('input', { type: 'email', autocomplete: 'username', required: true, maxLength: 254 });
  const pw = pwInput('current-password');
  const box = authCard('ログイン', '管理者から発行されたアカウントでログインしてください。',
    form('ログイン', async () => afterLogin(await api('POST', 'auth/login', { email: email.value, password: pw.value })), field('メールアドレス', email), field('パスワード', pw)));
  if (S.status.googleClientId) box.lastChild.append(h('div', { class: 'or' }, 'または'), googleButton());
  return box;
}
function googleButton() {
  const slot = h('div', { class: 'gbtn' });
  const init = () => {
    window.google.accounts.id.initialize({
      client_id: S.status.googleClientId,
      callback: (r) => api('POST', 'auth/google', { credential: r.credential }).then(afterLogin).catch((e) => toast(e.message, true)),
    });
    window.google.accounts.id.renderButton(slot, { theme: 'outline', size: 'large', width: 320, text: 'signin_with', locale: 'ja' });
  };
  if (window.google?.accounts) init();
  else document.head.append(h('script', { src: 'https://accounts.google.com/gsi/client', async: true, onload: init }));
  return slot;
}
function otpView() {
  const code = h('input', { inputMode: 'numeric', autocomplete: 'one-time-code', required: true, maxLength: 6, placeholder: '6桁の数字' });
  const trust = h('input', { type: 'checkbox' });
  return authCard('確認コードの入力', `${S.otp.to} に確認コードを送信しました（有効期限10分）。`,
    form('確認してログイン', async () => afterLogin(await api('POST', 'auth/otp', { code: code.value, trust: trust.checked })),
      field('確認コード', code), h('label', { class: 'check' }, trust, 'このブラウザを30日間信頼する（共有PCではオフ）')),
    h('div', { class: 'row' },
      btn('コードを再送する', async () => { await api('POST', 'auth/otp/resend'); toast('再送しました'); }, 'link'),
      btn('ログイン画面に戻る', () => { S.otp = null; render(); }, 'link')));
}
function passwordForm() {
  const cur = pwInput('current-password'), next = pwInput('new-password'), again = pwInput('new-password');
  return form('パスワードを変更', async () => {
    if (next.value !== again.value) throw new Error('新しいパスワード（確認）が一致しません');
    await api('POST', 'auth/password', { current: cur.value, next: next.value });
    await loadMe();
    toast('パスワードを変更しました');
    render();
  }, field('現在のパスワード', cur), field('新しいパスワード', next, '12文字以上・英字と数字を両方含む'), field('新しいパスワード（確認）', again));
}
function setupView() {
  const token = h('input', { type: 'password', autocomplete: 'off', required: true, maxLength: 200 });
  const email = h('input', { type: 'email', autocomplete: 'username', required: true, maxLength: 254 });
  const name = h('input', { maxLength: 60 });
  const pw = pwInput('new-password');
  return authCard('初期設定', '最初の管理者アカウントを作成します。この画面は一度しか使えません。',
    form('管理者を作成', async () => {
      await api('POST', 'setup', { token: token.value, email: email.value, name: name.value, password: pw.value });
      S.status.setup = false;
      await loadMe();
      S.tab = 'admin';
      render();
    }, field('セットアップトークン', token, 'Vercelの Storage → このプロジェクトのBlobストア → meta/setup-token.json に入っている値'), field('管理者のメールアドレス', email), field('氏名', name), field('パスワード', pw, '12文字以上・英字と数字を両方含む')));
}

// ---------- 共通部品 ----------
const usagePill = () => h('p', { class: 'usage' }, `本日の利用：企業調査 ${S.usage.research}/${S.limits.research}回・生成 ${S.usage.generate}/${S.limits.generate}回`);

function editor(c, onDelete) {
  const ta = h('textarea', { rows: 16, value: c.text, maxLength: 20000 });
  const count = h('small', null, `${c.text.length}字`);
  ta.addEventListener('input', () => (count.textContent = `${ta.value.length}字`));
  return h('div', { class: 'editor' }, ta, h('div', { class: 'row' }, count, h('span', { class: 'grow' }),
    btn('コピー', () => copy(ta.value)),
    btn('編集を保存', async () => { c.text = (await api('PUT', `contents/${c.id}`, { text: ta.value })).content.text; toast('保存しました'); }),
    onDelete && btn('削除', async () => { if (confirm('このコンテンツを削除しますか？')) { await api('DELETE', `contents/${c.id}`); onDelete(); } }, 'danger')));
}

// ---------- コンテンツ作成 ----------
async function createView(main) {
  S.companies ??= (await api('GET', 'companies')).companies;
  const d = S.draft, cat = S.catalog;
  if (!S.companies.length) {
    return main.replaceChildren(card('コンテンツ作成', h('p', { class: 'muted' }, 'まず「企業」タブで、コンテンツを作る企業を調査（登録）してください。'), btn('企業を登録する', () => go('companies'), 'primary')));
  }
  if (!S.companies.some((c) => c.id === d.companyId)) d.companyId = S.companies[0].id;
  d.cat ||= cat.categories[0].id; d.format ||= 'line'; d.tone ||= 'standard';
  const draw = () => {
    const c = cat.categories.find((x) => x.id === d.cat);
    const t = c.templates.find((x) => x.id === d.tpl) || c.templates[0];
    d.tpl = t.id;
    const company = h('select', { onchange: (e) => (d.companyId = e.target.value) }, S.companies.map((x) => h('option', { value: x.id, selected: x.id === d.companyId }, x.name)));
    const target = h('input', { value: d.target || '', maxLength: 100, placeholder: '例：27卒・理系・営業職志望', oninput: (e) => (d.target = e.target.value) });
    const extra = h('textarea', { rows: 5, maxLength: 4000, value: d.extra || '', placeholder: t.need || '日時・URL・特に伝えたいポイントなど', oninput: (e) => (d.extra = e.target.value) });
    main.replaceChildren(usagePill(),
      card('1. 企業', company),
      card('2. 分類', h('div', { class: 'cats' }, cat.categories.map((x) =>
        h('button', { type: 'button', class: x.id === d.cat ? 'cat on' : 'cat', onclick: () => { d.cat = x.id; d.tpl = null; draw(); } }, h('b', null, x.label), h('small', null, x.desc))))),
      card('3. テンプレート', chips(c.templates, d.tpl, (id) => { d.tpl = id; draw(); }), h('p', { class: 'muted' }, t.brief)),
      card('4. 仕上げ',
        field('形式', chips(cat.formats, d.format, (id) => { d.format = id; draw(); }), null, 'div'),
        field('トーン', chips(cat.tones, d.tone, (id) => { d.tone = id; draw(); }), null, 'div'),
        field('対象の学生（任意）', target),
        field(t.need ? '補足情報（このテンプレートで必要）' : '補足情報（任意）', extra, t.need && `入れてほしい情報：${t.need}。無い項目は【要確認】と表示されます。`),
        btn('この内容で生成する', async (b) => {
          b.textContent = '生成中…（10〜30秒ほど）';
          d.result = (await api('POST', 'contents/generate', { companyId: d.companyId, cat: d.cat, tpl: d.tpl, format: d.format, tone: d.tone, target: d.target, extra: d.extra })).content;
          await loadMe();
          draw();
          toast('生成しました（履歴に自動保存）');
        }, 'primary big')),
      d.result && card('生成結果（内容を確認・修正してから使ってください）', editor(d.result)));
  };
  draw();
}

// ---------- 企業 ----------
async function companiesView(main) {
  S.companies ??= (await api('GET', 'companies')).companies;
  const name = h('input', { required: true, maxLength: 100, placeholder: '例：株式会社〇〇' });
  const url = h('input', { type: 'url', maxLength: 300, placeholder: 'https://…（同名他社との取り違え防止）' });
  const note = h('input', { maxLength: 500, placeholder: '例：本社は大阪、新卒は営業職が中心' });
  const added = (c) => { S.companies.unshift(c); S.open = c.id; name.value = url.value = note.value = ''; };
  const draw = () => main.replaceChildren(usagePill(),
    card('企業を調査', h('p', { class: 'muted' }, 'AIがGoogle検索で公開情報を調べて整理します。結果は必ず目で確認し、誤りは修正してから使ってください。'),
      form('AIで調査する', async (b) => {
        b.textContent = '調査中…（30秒〜1分ほど）';
        added((await api('POST', 'companies/research', { name: name.value, url: url.value, note: note.value })).company);
        await loadMe();
        draw();
        toast('調査が完了しました');
      }, field('企業名', name), field('公式サイトURL（推奨）', url), field('補足（任意）', note)),
      btn('調査せず手入力で登録', async () => {
        if (!name.value.trim()) throw new Error('企業名を入力してください');
        added((await api('POST', 'companies', { name: name.value, url: url.value })).company);
        draw();
      }, 'link')),
    card(`登録済みの企業（${S.companies.length}）`, S.companies.length ? S.companies.map((c) => (S.open === c.id ? companyEditor(c, draw)
      : h('button', { type: 'button', class: 'item', onclick: () => { S.open = c.id; draw(); } }, h('b', null, c.name), h('span', { class: 'muted' }, [c.profile.industry, fmt(c.updatedAt)].filter(Boolean).join('・')))))
      : h('p', { class: 'muted' }, 'まだありません。')));
  draw();
}
function companyEditor(c, redraw) {
  const name = h('input', { value: c.name, maxLength: 100 }), url = h('input', { value: c.url || '', maxLength: 300 });
  const areas = S.catalog.profileFields.map(([k, label]) => [k, label, h('textarea', { rows: k === 'industry' ? 1 : 4, value: c.profile[k] || '', maxLength: 3000 })]);
  const link = (title, uri) => (/^https?:\/\//.test(uri) ? h('a', { href: uri, target: '_blank', rel: 'noopener noreferrer' }, title) : null);
  return h('div', { class: 'item open' },
    h('div', { class: 'row' }, h('b', null, c.name), h('span', { class: 'grow' }), btn('閉じる', () => { S.open = null; redraw(); }, 'link')),
    field('企業名', name), field('公式サイト', url), areas.map(([, label, ta]) => field(label, ta)),
    c.sources?.length ? h('div', { class: 'sources' }, '出典：', c.sources.map((s) => link(s.title, s.uri))) : null,
    c.queries?.length ? h('div', { class: 'sources' }, 'Google検索：', c.queries.map((q) => link(q, 'https://www.google.com/search?q=' + encodeURIComponent(q)))) : null,
    h('div', { class: 'row' },
      btn('保存', async () => {
        Object.assign(c, (await api('PUT', `companies/${c.id}`, { name: name.value, url: url.value, profile: Object.fromEntries(areas.map(([k, , ta]) => [k, ta.value])) })).company);
        toast('保存しました');
        redraw();
      }, 'primary'),
      btn('この企業でコンテンツ作成', () => { S.draft.companyId = c.id; go('create'); }),
      h('span', { class: 'grow' }),
      btn('削除', async () => {
        if (!confirm(`「${c.name}」を削除しますか？`)) return;
        await api('DELETE', `companies/${c.id}`);
        S.companies = S.companies.filter((x) => x !== c);
        S.open = null;
        redraw();
      }, 'danger')));
}

// ---------- 履歴 ----------
async function historyView(main) {
  let items = (await api('GET', 'contents')).contents, openId = null, filter = '';
  const fmtLabel = (id) => S.catalog.formats.find((f) => f.id === id)?.label || id;
  const draw = () => {
    const names = [...new Set(items.map((c) => c.companyName))];
    const shown = items.filter((c) => !filter || c.companyName === filter);
    main.replaceChildren(card(`履歴（${shown.length}）`,
      names.length > 1 && field('企業で絞り込み', h('select', { onchange: (e) => { filter = e.target.value; draw(); } }, h('option', { value: '' }, 'すべての企業'), names.map((n) => h('option', { value: n, selected: n === filter }, n)))),
      shown.length ? shown.map((c) => h('div', { class: openId === c.id ? 'item open' : 'item' },
        h('button', { type: 'button', class: 'head', onclick: () => { openId = openId === c.id ? null : c.id; draw(); } },
          h('b', null, `${c.companyName}｜${c.tplLabel}`), h('span', { class: 'muted' }, `${c.catLabel}・${fmtLabel(c.format)}・${fmt(c.updatedAt)}`)),
        openId === c.id ? editor(c, () => { items = items.filter((x) => x !== c); draw(); toast('削除しました'); }) : h('p', { class: 'preview' }, c.text.slice(0, 90))))
        : h('p', { class: 'muted' }, 'まだありません。「コンテンツ作成」で生成すると自動で保存されます。')));
  };
  draw();
}

// ---------- リッチメニュー（HPの写真や手持ちの画像を並べて、LINE規格の画像を書き出す） ----------
const RM_SIZES = { large: { w: 2500, h: 1686, label: '大', desc: '2500×1686' }, small: { w: 2500, h: 843, label: '小', desc: '2500×843' } };
const RM_LAYOUTS = { // cells: [列, 行, 幅, 高さ]（grid の列数×行数に対する位置）
  large: [
    { id: 'l6', label: '6分割', grid: [3, 2], cells: [[0, 0, 1, 1], [1, 0, 1, 1], [2, 0, 1, 1], [0, 1, 1, 1], [1, 1, 1, 1], [2, 1, 1, 1]] },
    { id: 'l4', label: '4分割', grid: [2, 2], cells: [[0, 0, 1, 1], [1, 0, 1, 1], [0, 1, 1, 1], [1, 1, 1, 1]] },
    { id: 'l13', label: '上1＋下3', grid: [3, 2], cells: [[0, 0, 3, 1], [0, 1, 1, 1], [1, 1, 1, 1], [2, 1, 1, 1]] },
    { id: 'l12', label: '左1＋右2', grid: [3, 2], cells: [[0, 0, 2, 2], [2, 0, 1, 1], [2, 1, 1, 1]] },
    { id: 'l2h', label: '上下2分割', grid: [1, 2], cells: [[0, 0, 1, 1], [0, 1, 1, 1]] },
    { id: 'l2v', label: '左右2分割', grid: [2, 1], cells: [[0, 0, 1, 1], [1, 0, 1, 1]] },
    { id: 'l1', label: '1枚', grid: [1, 1], cells: [[0, 0, 1, 1]] },
  ],
  small: [
    { id: 's3', label: '3分割', grid: [3, 1], cells: [[0, 0, 1, 1], [1, 0, 1, 1], [2, 0, 1, 1]] },
    { id: 's12', label: '左1＋右2', grid: [3, 1], cells: [[0, 0, 1, 1], [1, 0, 2, 1]] },
    { id: 's21', label: '左2＋右1', grid: [3, 1], cells: [[0, 0, 2, 1], [2, 0, 1, 1]] },
    { id: 's2', label: '2分割', grid: [2, 1], cells: [[0, 0, 1, 1], [1, 0, 1, 1]] },
    { id: 's1', label: '1枚', grid: [1, 1], cells: [[0, 0, 1, 1]] },
  ],
};
const RM_LABELS = ['会社紹介', '社員・働き方', '説明会予約', '選考フロー', 'よくある質問', 'お問い合わせ'];
const RM_FONT = '"Hiragino Sans","Noto Sans JP","Yu Gothic UI",Meiryo,sans-serif';
const rmLayout = (rm) => RM_LAYOUTS[rm.size].find((l) => l.id === rm.layout) || RM_LAYOUTS[rm.size][0];
const luminance = (hex) => { const n = parseInt(hex.slice(1), 16); return (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255; };
function rmRects(rm) { // 各マスの実寸（px）。マスの間に白い区切りを入れる
  const { w: W, h: H } = RM_SIZES[rm.size], lay = rmLayout(rm), [gx, gy] = lay.grid, g = 6;
  return lay.cells.map(([x, y, w, h]) => {
    const x0 = Math.round((x * W) / gx) + (x ? g : 0), y0 = Math.round((y * H) / gy) + (y ? g : 0);
    return [x0, y0, Math.round(((x + w) * W) / gx) - (x + w < gx ? g : 0) - x0, Math.round(((y + h) * H) / gy) - (y + h < gy ? g : 0) - y0];
  });
}
function rmDraw(cv, rm, preview) {
  const { w: W, h: H } = RM_SIZES[rm.size];
  cv.width = W; cv.height = H;
  const c = cv.getContext('2d');
  c.fillStyle = '#fff';
  c.fillRect(0, 0, W, H);
  const ink = luminance(rm.color) > 0.6 ? '#1b2430' : '#fff';
  rmRects(rm).forEach(([X, Y, CW, CH], i) => {
    const cell = rm.cells[i], img = cell.img?.el, label = cell.label.trim();
    c.save();
    c.beginPath(); c.rect(X, Y, CW, CH); c.clip();
    c.fillStyle = rm.color;
    c.fillRect(X, Y, CW, CH);
    if (img) { // マス全体を覆うように拡大し、位置はスライダーで調整
      const s = Math.max(CW / img.naturalWidth, CH / img.naturalHeight), dw = img.naturalWidth * s, dh = img.naturalHeight * s;
      c.drawImage(img, X - ((dw - CW) * cell.fx) / 100, Y - ((dh - CH) * cell.fy) / 100, dw, dh);
    }
    if (label) {
      let size = Math.min(CH * 0.16, CW * 0.13, 150);
      c.font = `700 ${size}px ${RM_FONT}`;
      while (c.measureText(label).width > CW * 0.9 && size > 36) { size -= 4; c.font = `700 ${size}px ${RM_FONT}`; }
      c.textAlign = 'center'; c.textBaseline = 'middle';
      const band = size * 1.9;
      if (img) { c.globalAlpha = 0.88; c.fillStyle = rm.color; c.fillRect(X, Y + CH - band, CW, band); c.globalAlpha = 1; }
      c.fillStyle = ink;
      c.fillText(label, X + CW / 2, img ? Y + CH - band / 2 : Y + CH / 2);
    }
    c.restore();
    if (preview && i === rm.sel) { c.lineWidth = 16; c.strokeStyle = '#ffb020'; c.strokeRect(X + 8, Y + 8, CW - 16, CH - 16); }
  });
}
async function rmExport(rm) {
  const cv = document.createElement('canvas');
  rmDraw(cv, rm, false);
  let q = 0.92, blob;
  do { blob = await new Promise((r) => cv.toBlob(r, 'image/jpeg', q)); q -= 0.08; } while (blob && blob.size > 1000000 && q > 0.35); // LINEの上限1MBに収める
  if (!blob) throw new Error('画像を書き出せませんでした');
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: `richmenu-${cv.width}x${cv.height}.jpg` });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  toast(`保存しました（${cv.width}×${cv.height}・${Math.round(blob.size / 1024)}KB）`);
}
async function richMenuView(main) {
  S.companies ??= (await api('GET', 'companies')).companies;
  const rm = (S.rm ??= { size: 'large', layout: 'l6', color: '#0e8f6f', sel: 0, photos: [], url: S.companies.find((c) => c.url)?.url || '', cells: RM_LABELS.map((label) => ({ img: null, label, fx: 50, fy: 50 })) });
  const cv = h('canvas', { class: 'rm-canvas' }), thumbs = h('div', { class: 'thumbs' }), cellBox = h('div', { class: 'col' }), layoutBox = h('div'), note = h('p', { class: 'muted' });
  const urlI = h('input', { type: 'url', value: rm.url, maxLength: 300, placeholder: 'https://（企業のHPや採用サイト）', oninput: (e) => (rm.url = e.target.value) });
  const redraw = () => rmDraw(cv, rm, true);
  const addPhoto = (src, alt) => new Promise((done) => {
    const el = new Image();
    el.alt = alt || '';
    el.onload = () => { if (Math.min(el.naturalWidth, el.naturalHeight) >= 300) rm.photos.push({ el }); done(); }; // 小さい画像（アイコン等）は候補にしない
    el.onerror = done;
    el.src = src;
  });
  function drawThumbs() {
    const used = new Set(rm.cells.map((c) => c.img));
    note.textContent = rm.photos.length ? `写真 ${rm.photos.length}枚。プレビューでオレンジ枠のマスに入れたい写真を押してください。` : 'まだ写真がありません。HPから取得するか、手持ちの画像を追加してください。';
    thumbs.replaceChildren(...rm.photos.map((p) => h('button', { type: 'button', class: used.has(p) ? 'thumb used' : 'thumb', title: p.el.alt, onclick: () => {
      rm.cells[rm.sel].img = p;
      const next = rm.cells.findIndex((c, i) => i < rmLayout(rm).cells.length && !c.img); // 次の空きマスへ
      if (next >= 0) rm.sel = next;
      drawCell(); drawThumbs(); redraw();
    } }, p.el)));
  }
  function drawCell() {
    const cell = rm.cells[rm.sel];
    const slider = (key, label) => field(label, h('input', { type: 'range', min: 0, max: 100, value: cell[key], oninput: (e) => { cell[key] = +e.target.value; redraw(); } }));
    cellBox.replaceChildren(h('b', null, `マス ${rm.sel + 1} の設定`),
      field('ラベル（空欄にすると文字なし）', h('input', { value: cell.label, maxLength: 14, oninput: (e) => { cell.label = e.target.value; redraw(); } })),
      cell.img && h('div', { class: 'grid' }, slider('fx', '写真の横位置'), slider('fy', '写真の縦位置')),
      cell.img && btn('このマスの写真を外す', () => { cell.img = null; drawCell(); drawThumbs(); redraw(); }, 'link'));
  }
  function drawLayout() {
    rm.layout = rmLayout(rm).id;
    rm.sel = Math.min(rm.sel, rmLayout(rm).cells.length - 1);
    layoutBox.replaceChildren(
      field('サイズ', chips(Object.entries(RM_SIZES).map(([id, s]) => ({ id, ...s })), rm.size, (id) => { rm.size = id; rm.layout = null; drawLayout(); }), null, 'div'),
      field('分割', chips(RM_LAYOUTS[rm.size], rm.layout, (id) => { rm.layout = id; drawLayout(); }), null, 'div'));
    drawCell(); redraw();
  }
  cv.addEventListener('click', (e) => {
    const r = cv.getBoundingClientRect(), x = ((e.clientX - r.left) * cv.width) / r.width, y = ((e.clientY - r.top) * cv.height) / r.height;
    const i = rmRects(rm).findIndex(([X, Y, W, H]) => x >= X && x < X + W && y >= Y && y < Y + H);
    if (i >= 0) { rm.sel = i; drawCell(); redraw(); }
  });
  const file = h('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp', multiple: true, hidden: true, onchange: async (e) => {
    await Promise.all([...e.target.files].slice(0, 20).map((f) => addPhoto(URL.createObjectURL(f), f.name)));
    e.target.value = '';
    drawThumbs();
  } });
  const withUrl = S.companies.filter((c) => c.url);
  main.replaceChildren(
    card('1. 写真を集める', h('p', { class: 'muted' }, '企業のHPから写真の候補を集めます。自社が権利を持つ画像だけを使ってください（素材サイトの写真や人物が写った写真は、利用条件と本人の了承を確認）。'),
      withUrl.length > 0 && field('登録済みの企業から選ぶ', h('select', { onchange: (e) => { if (e.target.value) urlI.value = rm.url = e.target.value; } }, h('option', { value: '' }, '選択…'), withUrl.map((c) => h('option', { value: c.url }, c.name)))),
      field('HPのURL', urlI),
      h('div', { class: 'row' },
        btn('HPから写真を取得', async (b) => {
          b.textContent = '取得中…（10〜20秒ほど）';
          const j = await api('POST', 'site/images', { url: urlI.value.trim() });
          const before = rm.photos.length;
          await Promise.all(j.images.map((i) => addPhoto(i.src, i.alt)));
          drawThumbs();
          toast(`${j.pages.length}ページから ${rm.photos.length - before}枚の写真を取得しました`);
        }, 'primary'),
        btn('手持ちの画像を追加', () => file.click()), file),
      note, thumbs),
    card('2. レイアウトと文字', layoutBox,
      field('帯・背景の色', h('input', { type: 'color', value: rm.color, oninput: (e) => { rm.color = e.target.value; redraw(); } })),
      h('p', { class: 'muted' }, 'プレビューのマスを押すと、そのマスを編集できます（オレンジ枠は保存される画像には入りません）。'), cv, cellBox),
    card('3. 保存', h('p', { class: 'muted' }, 'LINEの規格（JPEG・1MB以下）に合わせて書き出します。MOCHICAやLINE公式アカウントの管理画面で、リッチメニューの画像として設定してください。'),
      btn('JPEGで保存', () => rmExport(rm), 'primary')));
  drawThumbs();
  drawLayout();
}

// ---------- 管理 ----------
async function adminView(main) {
  const body = h('div');
  main.replaceChildren(h('div', { class: 'subtabs' }, [['users', 'アカウント'], ['settings', '設定'], ['audit', '監査ログ']].map(([id, label]) =>
    h('button', { type: 'button', class: S.adminTab === id ? 'on' : '', onclick: () => { S.adminTab = id; render(); } }, label))), body);
  await { users: adminUsers, settings: adminSettings, audit: adminAudit }[S.adminTab](body);
}
async function adminUsers(body) {
  let users = (await api('GET', 'admin/users')).users, issued = null;
  const email = h('input', { type: 'email', required: true, maxLength: 254, placeholder: 'saiyo@example.co.jp' });
  const name = h('input', { maxLength: 60 }), company = h('input', { maxLength: 80 });
  const role = h('select', null, h('option', { value: 'user' }, '利用者'), h('option', { value: 'admin' }, '管理者'));
  const act = async (u, action, extra) => {
    const j = await api('PATCH', `admin/users/${u.id}`, { action, ...extra });
    Object.assign(u, j.user);
    if (j.tempPassword) issued = { email: u.email, pw: j.tempPassword };
    draw();
  };
  const row = (u) => {
    const self = u.id === S.user.id;
    return h('tr', null,
      h('td', null, u.email), h('td', null, [u.name, u.company].filter(Boolean).join('／') || '—'), h('td', null, u.role === 'admin' ? '管理者' : '利用者'),
      h('td', null, h('span', { class: 'badge ' + (!u.active ? 'off' : u.locked || u.mustChange ? 'warn' : 'ok') }, !u.active ? '無効' : u.locked ? 'ロック中' : u.mustChange ? '初回ログイン待ち' : '有効')),
      h('td', null, fmt(u.lastLoginAt)), h('td', null, `調査${u.usage.research}・生成${u.usage.generate}`),
      h('td', { class: 'ops' },
        u.locked && btn('ロック解除', () => act(u, 'unlock'), 'link'),
        !self && btn('仮パスワード再発行', async () => { if (confirm(`${u.email} の仮パスワードを再発行しますか？（現在のパスワードとログインは無効になります）`)) await act(u, 'reset'); }, 'link'),
        !self && btn(u.active ? '無効化' : '有効化', () => act(u, u.active ? 'disable' : 'enable'), 'link'),
        !self && btn(u.role === 'admin' ? '利用者にする' : '管理者にする', () => act(u, 'role', { role: u.role === 'admin' ? 'user' : 'admin' }), 'link'),
        !self && btn('削除', async () => {
          if (!confirm(`${u.email} と、その企業・コンテンツのデータをすべて削除しますか？`)) return;
          await api('DELETE', `admin/users/${u.id}`);
          users = users.filter((x) => x !== u);
          draw();
        }, 'link danger')));
  };
  const draw = () => body.replaceChildren(
    card('アカウントを発行', h('p', { class: 'muted' }, '新規登録の画面はありません。ここで発行したメールアドレスと仮パスワードでのみログインできます（初回ログイン時に本人がパスワードを変更します）。'),
      form('発行する', async () => {
        const j = await api('POST', 'admin/users', { email: email.value, name: name.value, company: company.value, role: role.value });
        users.push(j.user);
        issued = { email: j.user.email, pw: j.tempPassword };
        email.value = name.value = company.value = '';
        draw();
      }, h('div', { class: 'grid' }, field('メールアドレス', email), field('氏名', name), field('会社名', company), field('権限', role))),
      issued && h('div', { class: 'issued' }, h('b', null, `${issued.email} の仮パスワード（この表示を閉じると再表示できません）`), h('code', null, issued.pw),
        btn('コピー', () => copy(issued.pw)), h('small', null, 'ログインURLと仮パスワードは別々の経路で本人に伝えると安全です。'))),
    card(`アカウント一覧（${users.length}）`, h('div', { class: 'tablewrap' }, h('table', null,
      h('thead', null, h('tr', null, ['メールアドレス', '氏名／会社', '権限', '状態', '最終ログイン', '本日の利用', '操作'].map((t) => h('th', null, t)))),
      h('tbody', null, users.map(row))))));
  draw();
}
const check = (ok, text) => h('li', { class: ok ? 'ok' : 'ng' }, text);
async function adminSettings(body) {
  let s = await api('GET', 'admin/settings'), pending = null;
  const draw = () => {
    const key = h('input', { type: 'password', autocomplete: 'off', maxLength: 200, placeholder: s.geminiKeySet ? '設定済み（変更するときだけ入力）' : 'Gemini APIキー' });
    const model = h('input', { value: s.geminiModel, maxLength: 60 });
    const num = (v) => h('input', { type: 'number', min: 0, max: 100000, value: v });
    const lr = num(s.limitResearch), lg = num(s.limitGenerate), la = num(s.limitGlobal);
    const gid = h('input', { value: s.googleClientId, maxLength: 200, placeholder: 'xxxxxxxx.apps.googleusercontent.com' });
    const gurl = h('input', { value: s.gasUrl, maxLength: 300, placeholder: 'https://script.google.com/macros/s/…/exec' });
    const gsec = h('input', { type: 'password', autocomplete: 'off', maxLength: 200, placeholder: 'GAS側の RELAY_SECRET と同じ値' });
    const code = h('input', { inputMode: 'numeric', maxLength: 6, placeholder: '6桁の数字' });
    const save = (patch) => async () => { s = await api('PUT', 'admin/settings', patch()); toast('保存しました'); draw(); };
    body.replaceChildren(
      card('セキュリティ状況', h('ul', { class: 'checks' },
        check(true, '新規登録：不可（管理者が発行したアカウントのみ）'),
        check(s.mailOn, s.mailOn ? '2段階認証（メール確認コード）：有効' : '2段階認証（メール確認コード）：無効 — 下の「メール送信」を設定すると有効になります'),
        check(s.geminiKeySet, s.geminiKeySet ? 'AIのAPIキー：設定済み（暗号化して保存）' : 'AIのAPIキー：未設定（企業調査・生成が使えません）'),
        check(true, s.googleClientId ? 'Googleログイン：有効（発行済みメールアドレスのGoogleアカウントのみ）' : 'Googleログイン：無効'))),
      card('AI（Gemini）', field('APIキー', key), field('モデル', model), h('div', { class: 'row' },
        btn('保存', save(() => ({ geminiKey: key.value || undefined, geminiModel: model.value.trim() })), 'primary'),
        btn('接続テスト', async () => toast('接続OK：' + (await api('POST', 'admin/test-ai')).reply)))),
      card('1日あたりの利用上限', h('div', { class: 'grid' }, field('企業調査（1人あたり）', lr), field('生成（1人あたり）', lg), field('全員の合計', la)),
        btn('保存', save(() => ({ limitResearch: +lr.value, limitGenerate: +lg.value, limitGlobal: +la.value })), 'primary')),
      card('メール送信（GAS中継）', h('p', { class: 'muted' }, 'ログイン時の確認コードを送る経路です。テスト送信で自分に届いたコードを入力すると有効になります（設定ミスでログインできなくなるのを防ぐため）。'),
        pending ? [field(`${pending} に届いた確認コード`, code), h('div', { class: 'row' },
          btn('有効化する', async () => { s = await api('POST', 'admin/mail/confirm', { code: code.value }); pending = null; toast('メール送信と2段階認証を有効にしました'); draw(); }, 'primary'),
          btn('やり直す', () => { pending = null; draw(); }, 'link'))]
          : [field('GASウェブアプリのURL', gurl), field('共有シークレット', gsec), h('div', { class: 'row' },
            btn('テスト送信', async () => { pending = (await api('POST', 'admin/mail', { gasUrl: gurl.value.trim(), gasSecret: gsec.value })).to; draw(); }, 'primary'),
            s.mailOn && btn('無効化', async () => { if (confirm('メール送信を無効にすると2段階認証もオフになります。よろしいですか？')) { s = await api('DELETE', 'admin/mail'); draw(); } }, 'link danger'))]),
      card('Googleログイン', h('p', { class: 'muted' }, 'Google Cloudで「OAuthクライアントID（ウェブアプリケーション）」を作成し、「承認済みのJavaScript生成元」にこのサイトのURLを追加してください。空欄で保存すると無効になります。'),
        field('クライアントID', gid), btn('保存', save(() => ({ googleClientId: gid.value.trim() })), 'primary')));
  };
  draw();
}
const AUDIT = { login: 'ログイン', login_failed: 'ログイン失敗', lockout: 'アカウントロック', logout_all: '全端末ログアウト', setup: '初期設定', password_changed: 'パスワード変更', settings: '設定変更',
  user_issued: 'アカウント発行', user_reset: '仮パスワード再発行', user_disable: '無効化', user_enable: '有効化', user_unlock: 'ロック解除', user_role: '権限変更', user_deleted: 'アカウント削除' };
async function adminAudit(body) {
  const { entries } = await api('GET', 'admin/audit');
  body.replaceChildren(card('監査ログ（最新200件）', h('div', { class: 'tablewrap' }, h('table', null,
    h('thead', null, h('tr', null, ['日時', '操作', '対象', '詳細'].map((t) => h('th', null, t)))),
    h('tbody', null, entries.map((e) => h('tr', null, h('td', null, fmt(e.t)), h('td', null, AUDIT[e.type] || e.type), h('td', null, e.email || '—'),
      h('td', { class: 'muted' }, [e.via && `方法:${e.via === 'google' ? 'Google' : 'パスワード'}`, e.role && `権限:${e.role}`, e.keys && `項目:${e.keys}`, e.by && `実行:${e.by}`, e.ip && `IP:${e.ip}`].filter(Boolean).join(' ／ ')))))))));
}

// ---------- アカウント・全体 ----------
function accountView(main) {
  main.replaceChildren(
    card('アカウント', h('p', null, `${S.user.email}（${S.user.role === 'admin' ? '管理者' : '利用者'}）`),
      h('div', { class: 'row' }, btn('ログアウト', () => logout(false)), btn('すべての端末からログアウト', () => logout(true), 'link'))),
    card('パスワード変更', passwordForm()));
}
function shell() {
  const tabs = [['create', 'コンテンツ作成'], ['companies', '企業'], ['history', '履歴'], ['richmenu', 'リッチメニュー'], ...(S.user.role === 'admin' ? [['admin', '管理']] : []), ['account', 'アカウント']];
  const views = { create: createView, companies: companiesView, history: historyView, richmenu: richMenuView, admin: adminView, account: accountView };
  const main = h('main', null, h('p', { class: 'boot' }, '読み込み中…'));
  Promise.resolve().then(() => (views[S.tab] || createView)(main)).catch((e) => { if (S.user && !S.user.mustChange) main.replaceChildren(card('読み込みに失敗しました', h('p', null, e.message))); });
  return h('div', null,
    h('header', null, h('div', { class: 'brand' }, h('b', null, 'コンテンツAI'), h('span', null, 'for MOCHICA')),
      h('nav', null, tabs.map(([id, label]) => h('button', { type: 'button', class: S.tab === id ? 'on' : '', onclick: () => go(id) }, label))),
      h('div', { class: 'who' }, S.user.email)),
    main);
}
function render() {
  app.replaceChildren(S.status.setup ? setupView() : !S.user ? (S.otp ? otpView() : loginView())
    : S.user.mustChange ? authCard('パスワードの変更', '仮パスワードでログインしました。続けるには新しいパスワードを設定してください。', passwordForm(), h('div', { class: 'row' }, btn('ログアウト', () => logout(false), 'link')))
      : shell());
}
(async () => {
  try {
    S.status = await api('GET', 'status');
    if (!S.status.setup) await loadMe().catch(() => {});
    render();
  } catch (e) { app.replaceChildren(h('p', { class: 'boot' }, e.message)); }
})();
