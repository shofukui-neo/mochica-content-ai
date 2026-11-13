// APIルーター（Vercel Function 1本）。/api/* はすべてここに来る（vercel.json の rewrites）
import crypto from 'node:crypto';
import * as C from '../lib/core.js';
import { CATALOG, PROFILE_FIELDS, cleanProfile, research, generate, ping } from '../lib/ai.js';

const { db } = C;
const SID = '__Host-sid', PEND = '__Host-pend', DEV = '__Host-dev';
const HOUR = 3600, DAY = 86400;
const BAD_LOGIN = 'メールアドレスまたはパスワードが違います（連続で失敗すると一時的にロックされます）';
const TOO_MANY = '試行回数が多すぎます。しばらくしてからお試しください';

const fail = (status, message, code) => { throw Object.assign(new Error(message), { status, code }); };
const str = (v, max) => String(v ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, max);
const httpUrl = (v) => { const u = str(v, 300); return /^https?:\/\/[^\s]+$/.test(u) ? u : ''; };
const otpCode = () => String(crypto.randomInt(1e6)).padStart(6, '0');
const mask = (email) => email.replace(/^(.{2})[^@]*/, '$1***');
const cookies = (req) => Object.fromEntries((req.headers.cookie || '').split(';').map((c) => {
  const i = c.indexOf('=');
  return [c.slice(0, i).trim(), c.slice(i + 1).trim()];
}));
function setCookie(res, name, value, maxAge) {
  const prev = [].concat(res.getHeader('Set-Cookie') || []);
  res.setHeader('Set-Cookie', [...prev, `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`]);
}

// ---------- 認証まわりの共通処理 ----------
const pub = (u, am) => ({ id: u.id, email: u.email, name: u.name, company: u.company, role: u.role, mustChange: !!u.mustChange && am !== 'google' });
const view = (u, usage) => ({ ...pub(u), active: u.active, locked: (u.fail?.until || 0) > Date.now(), google: !!u.googleSub, lastLoginAt: u.lastLoginAt || null, createdAt: u.createdAt, usage: usage || { research: 0, generate: 0 } });
const newUser = (o) => ({ id: C.uidOf(o.email), name: '', company: '', role: 'user', active: true, mustChange: true, sv: 1, createdAt: Date.now(), ...o });

async function me(ctx, { allowMustChange } = {}) {
  const t = await C.readToken(cookies(ctx.req)[SID], 'sid');
  const u = t && (await db.get(`users/${t.sub}`));
  if (!u || !u.active || u.sv !== t.sv) fail(401, 'ログインが必要です', 'auth');
  ctx.am = t.am;
  if (u.mustChange && t.am !== 'google' && !allowMustChange) fail(403, 'パスワードの変更が必要です', 'must_change');
  return u;
}
async function admin(ctx) {
  const u = await me(ctx);
  if (u.role !== 'admin') fail(403, '権限がありません');
  return u;
}
async function signIn(ctx, u, am, log = true) {
  u.lastLoginAt = Date.now();
  u.fail = null;
  await db.set(`users/${u.id}`, u);
  setCookie(ctx.res, SID, await C.signToken({ p: 'sid', sub: u.id, sv: u.sv, am }, 12 * HOUR), 12 * HOUR);
  setCookie(ctx.res, PEND, '', 0);
  if (log) await C.audit('login', { email: u.email, via: am, ip: ctx.ip });
  return { user: pub(u, am) };
}
async function sendOtp(u, s) {
  if (!(await C.hit('otp-send', u.id, 5, HOUR))) fail(429, '確認コードの送信回数が上限に達しました。1時間後にお試しください');
  const code = otpCode();
  await db.set(`otp/${u.id}`, { h: C.hmac('otp', `${u.id}:${code}`), exp: Date.now() + 600000, n: 0 });
  try { await C.sendCode(u.email, code, s); } catch (e) {
    console.error(e);
    fail(502, '確認コードのメール送信に失敗しました。管理者に連絡してください');
  }
}
// 確認コードの照合（5回まで）。key は otp/… または mailcfg/…
async function checkCode(key, id, input) {
  const rec = await db.get(key);
  if (!rec || rec.exp < Date.now() || rec.n >= 5) fail(401, '確認コードの有効期限が切れました。最初からやり直してください', 'expired');
  if (!C.safeEq(rec.h, C.hmac('otp', `${id}:${str(input, 10)}`))) {
    rec.n++;
    await db.set(key, rec);
    fail(400, '確認コードが違います');
  }
  await db.del(key);
  return rec;
}
async function quota(u, kind, s) {
  const [mine, all] = await Promise.all([C.usage(u.id), C.usage('all')]);
  const lim = kind === 'research' ? s.limitResearch : s.limitGenerate;
  if (mine[kind] >= lim) fail(429, `本日の${kind === 'research' ? '企業調査' : '生成'}回数の上限（${lim}回）に達しました`);
  if (all.research + all.generate >= s.limitGlobal) fail(429, '本日の全体の利用上限に達しました。管理者に連絡してください');
  if (!s.geminiKey) fail(503, 'AIが未設定です。管理者に連絡してください');
}
const aiFail = (e) => {
  console.error(e);
  fail(502, e.status === 429 ? 'AIが混み合っています。少し待ってからお試しください'
    : e.status === 400 || e.status === 403 ? 'AIの設定に問題があります。管理者に連絡してください' : 'AIの呼び出しに失敗しました。もう一度お試しください');
};
const settingsView = (s) => ({ geminiKeySet: !!s.geminiKey, geminiModel: s.geminiModel, limitResearch: s.limitResearch, limitGenerate: s.limitGenerate, limitGlobal: s.limitGlobal, googleClientId: s.googleClientId, gasUrl: s.gasUrl, mailOn: s.mailOn });

// ---------- ルート定義 ----------
const routes = [];
const on = (spec, fn) => { const [method, p] = spec.split(' '); routes.push({ method, parts: p.split('/'), fn }); };
function match(method, pathStr) {
  const segs = pathStr.split('/');
  for (const r of routes) {
    if (r.method !== method || r.parts.length !== segs.length) continue;
    const params = {};
    const ok = r.parts.every((p, i) => (p[0] === ':' ? /^[a-z0-9]{8,40}$/.test(segs[i]) && ((params[p.slice(1)] = segs[i]), true) : p === segs[i]));
    if (ok) return { fn: r.fn, params };
  }
  return null;
}

// --- 初期設定・ログイン ---
let setupDone = false; // 完了後は毎回ストアを読まない
on('GET status', async () => {
  setupDone ||= !!(await db.get('meta/setup'));
  if (!setupDone) await C.setupToken(); // 合言葉を用意しておく
  return { setup: !setupDone, googleClientId: (await C.getSettings()).googleClientId || null };
});

on('POST setup', async (ctx) => {
  if (!(await C.hit('setup', ctx.ip, 10, 600))) fail(429, TOO_MANY);
  if (!C.safeEq(str(ctx.body.token, 200), await C.setupToken())) fail(403, 'セットアップトークンが違います');
  const email = C.normEmail(ctx.body.email);
  if (!email) fail(400, 'メールアドレスの形式が正しくありません');
  const problem = C.passwordProblem(ctx.body.password, email);
  if (problem) fail(400, problem);
  if (!(await db.create('meta/setup', { at: Date.now(), email }))) fail(409, '初期設定は完了済みです');
  const u = newUser({ email, name: str(ctx.body.name, 60), role: 'admin', mustChange: false, pw: await C.hashPassword(ctx.body.password), createdBy: 'setup' });
  await db.del('meta/setup-token');
  await C.audit('setup', { email, ip: ctx.ip });
  return signIn(ctx, u, 'pw');
});

on('POST auth/login', async (ctx) => {
  if (!(await C.hit('login-ip', ctx.ip, 30, 600))) fail(429, TOO_MANY);
  const email = C.normEmail(ctx.body.email);
  const u = email ? await db.get(`users/${C.uidOf(email)}`) : null;
  const locked = (u?.fail?.until || 0) > Date.now();
  const ok = (await C.checkPassword(str(ctx.body.password, 200), u?.pw)) && !locked;
  if (!u || !ok || !u.active) {
    if (u && !locked) { // 5回連続失敗で15分→30分→60分ロック
      const n = (u.fail?.n || 0) + 1;
      u.fail = { n, until: n >= 5 ? Date.now() + Math.min(15 * 2 ** (n - 5), 60) * 60000 : 0 };
      await db.set(`users/${u.id}`, u);
      if (n >= 5) await C.audit('lockout', { email: u.email, ip: ctx.ip });
    }
    await C.audit('login_failed', { email: email || '(形式不正)', via: 'pw', ip: ctx.ip });
    fail(401, BAD_LOGIN);
  }
  const s = await C.getSettings();
  const dev = await C.readToken(cookies(ctx.req)[DEV], 'dev');
  if (s.mailOn && !(dev && dev.sub === u.id && dev.sv === u.sv)) { // 未確認のブラウザはメールの確認コードで本人確認
    await sendOtp(u, s);
    setCookie(ctx.res, PEND, await C.signToken({ p: 'pend', sub: u.id, sv: u.sv }, 600), 600);
    return { step: 'otp', to: mask(u.email) };
  }
  return signIn(ctx, u, 'pw');
});

async function pending(ctx) {
  const t = await C.readToken(cookies(ctx.req)[PEND], 'pend');
  const u = t && (await db.get(`users/${t.sub}`));
  if (!u || !u.active || u.sv !== t.sv) fail(401, '確認の有効期限が切れました。もう一度ログインしてください', 'expired');
  return u;
}
on('POST auth/otp', async (ctx) => {
  const u = await pending(ctx);
  await checkCode(`otp/${u.id}`, u.id, ctx.body.code);
  if (ctx.body.trust) setCookie(ctx.res, DEV, await C.signToken({ p: 'dev', sub: u.id, sv: u.sv }, 30 * DAY), 30 * DAY);
  return signIn(ctx, u, 'pw');
});
on('POST auth/otp/resend', async (ctx) => { await sendOtp(await pending(ctx), await C.getSettings()); });

// Googleログイン: 管理者が発行済みのメールアドレスと一致するGoogleアカウントのみ（自動登録はしない）
on('POST auth/google', async (ctx) => {
  const s = await C.getSettings();
  if (!s.googleClientId) fail(404, 'Googleログインは無効です');
  if (!(await C.hit('login-ip', ctx.ip, 30, 600))) fail(429, TOO_MANY);
  const g = await C.verifyGoogle(str(ctx.body.credential, 5000), s.googleClientId).catch(() => null);
  const email = g && C.normEmail(g.email);
  const u = email ? await db.get(`users/${C.uidOf(email)}`) : null;
  if (!u || !u.active || (u.googleSub && u.googleSub !== g.sub)) {
    await C.audit('login_failed', { email: email || '(Google)', via: 'google', ip: ctx.ip });
    fail(403, 'このGoogleアカウントでは利用できません。管理者が発行したメールアドレスのGoogleアカウントでログインしてください');
  }
  u.googleSub = g.sub;
  return signIn(ctx, u, 'google');
});

on('POST auth/password', async (ctx) => {
  const u = await me(ctx, { allowMustChange: true });
  if (!(await C.hit('pw-change', u.id, 10, 600))) fail(429, TOO_MANY);
  if (!(await C.checkPassword(str(ctx.body.current, 200), u.pw))) fail(400, '現在のパスワードが違います');
  const problem = C.passwordProblem(ctx.body.next, u.email);
  if (problem) fail(400, problem);
  if (ctx.body.next === ctx.body.current) fail(400, '現在と異なるパスワードにしてください');
  Object.assign(u, { pw: await C.hashPassword(ctx.body.next), mustChange: false, sv: u.sv + 1 }); // sv更新で他端末のセッションを失効
  await C.audit('password_changed', { email: u.email, ip: ctx.ip });
  return signIn(ctx, u, 'pw', false);
});

on('POST auth/logout', async (ctx) => {
  if (ctx.body.all) {
    const u = await me(ctx, { allowMustChange: true });
    u.sv++;
    await db.set(`users/${u.id}`, u);
    await C.audit('logout_all', { email: u.email, ip: ctx.ip });
  }
  setCookie(ctx.res, SID, '', 0);
});

on('GET me', async (ctx) => {
  const u = await me(ctx, { allowMustChange: true });
  const s = await C.getSettings();
  return { user: pub(u, ctx.am), usage: await C.usage(u.id), limits: { research: s.limitResearch, generate: s.limitGenerate }, catalog: { ...CATALOG, profileFields: PROFILE_FIELDS } };
});

// --- 企業 ---
on('GET companies', async (ctx) => { const u = await me(ctx); return { companies: await db.all(`companies/${u.id}/`, 200) }; });

const companyInput = (b) => {
  const name = str(b.name, 100);
  if (!name) fail(400, '企業名を入力してください');
  return { name, url: httpUrl(b.url) };
};
on('POST companies', async (ctx) => {
  const u = await me(ctx);
  const c = { id: C.newId(), ...companyInput(ctx.body), profile: cleanProfile({}), sources: [], queries: [], createdAt: Date.now(), updatedAt: Date.now() };
  await db.set(`companies/${u.id}/${c.id}`, c);
  return { company: c };
});
on('POST companies/research', async (ctx) => {
  const u = await me(ctx);
  const input = companyInput(ctx.body);
  const s = await C.getSettings();
  await quota(u, 'research', s);
  const r = await research(s, { ...input, note: str(ctx.body.note, 500) }).catch(aiFail);
  const c = { id: C.newId(), name: r.name || input.name, url: input.url || r.url, profile: r.profile, sources: r.sources, queries: r.queries, createdAt: Date.now(), updatedAt: Date.now() };
  await db.set(`companies/${u.id}/${c.id}`, c);
  await C.addUsage(u.id, 'research');
  return { company: c };
});
on('PUT companies/:id', async (ctx) => {
  const u = await me(ctx);
  const key = `companies/${u.id}/${ctx.params.id}`;
  const c = (await db.get(key)) || fail(404, '企業が見つかりません');
  Object.assign(c, companyInput(ctx.body), { profile: cleanProfile(ctx.body.profile), updatedAt: Date.now() });
  await db.set(key, c);
  return { company: c };
});
on('DELETE companies/:id', async (ctx) => { const u = await me(ctx); await db.del(`companies/${u.id}/${ctx.params.id}`); });

// --- コンテンツ ---
on('GET contents', async (ctx) => { const u = await me(ctx); return { contents: await db.all(`contents/${u.id}/`, 100) }; });

on('POST contents/generate', async (ctx) => {
  const u = await me(ctx);
  const b = ctx.body;
  const cat = CATALOG.categories.find((x) => x.id === b.cat);
  const tpl = cat?.templates.find((x) => x.id === b.tpl);
  const format = CATALOG.formats.find((x) => x.id === b.format)?.id;
  const tone = CATALOG.tones.find((x) => x.id === b.tone)?.id;
  if (!tpl || !format || !tone || !/^[a-z0-9]{8,40}$/.test(b.companyId || '')) fail(400, '選択内容が正しくありません');
  const company = (await db.get(`companies/${u.id}/${b.companyId}`)) || fail(404, '企業が見つかりません');
  const s = await C.getSettings();
  await quota(u, 'generate', s);
  const target = str(b.target, 100), extra = str(b.extra, 4000);
  const text = await generate(s, { company, cat, tpl, format, tone, target, extra }).catch(aiFail);
  const c = { id: C.newId(), companyId: company.id, companyName: company.name, cat: cat.id, catLabel: cat.label, tpl: tpl.id, tplLabel: tpl.label, format, tone, target, extra, text, createdAt: Date.now(), updatedAt: Date.now() };
  await db.set(`contents/${u.id}/${c.id}`, c);
  await C.addUsage(u.id, 'generate');
  return { content: c };
});
on('PUT contents/:id', async (ctx) => {
  const u = await me(ctx);
  const key = `contents/${u.id}/${ctx.params.id}`;
  const c = (await db.get(key)) || fail(404, 'コンテンツが見つかりません');
  Object.assign(c, { text: str(ctx.body.text, 20000), updatedAt: Date.now() });
  await db.set(key, c);
  return { content: c };
});
on('DELETE contents/:id', async (ctx) => { const u = await me(ctx); await db.del(`contents/${u.id}/${ctx.params.id}`); });

// --- 管理者: アカウント ---
on('GET admin/users', async (ctx) => {
  await admin(ctx);
  const users = (await db.all('users/', 1000)).sort((a, b) => a.createdAt - b.createdAt);
  const day = C.today();
  const used = await Promise.all(users.map((u) => db.get(`usage/${day}/${u.id}`)));
  return { users: users.map((u, i) => view(u, used[i])) };
});
on('POST admin/users', async (ctx) => {
  const a = await admin(ctx);
  const email = C.normEmail(ctx.body.email);
  if (!email) fail(400, 'メールアドレスの形式が正しくありません');
  const tempPassword = C.tempPassword();
  const u = newUser({ email, name: str(ctx.body.name, 60), company: str(ctx.body.company, 80), role: ctx.body.role === 'admin' ? 'admin' : 'user', pw: await C.hashPassword(tempPassword), createdBy: a.email });
  if (!(await db.create(`users/${u.id}`, u))) fail(409, 'このメールアドレスは発行済みです');
  await C.audit('user_issued', { email, role: u.role, by: a.email });
  return { user: view(u), tempPassword };
});
on('PATCH admin/users/:id', async (ctx) => {
  const a = await admin(ctx);
  const u = (await db.get(`users/${ctx.params.id}`)) || fail(404, 'アカウントが見つかりません');
  const action = ctx.body.action;
  let tempPassword;
  if (action === 'unlock') u.fail = null;
  else if (u.id === a.id) fail(400, '自分自身のアカウントにはこの操作はできません');
  else if (action === 'reset') {
    tempPassword = C.tempPassword();
    Object.assign(u, { pw: await C.hashPassword(tempPassword), mustChange: true, fail: null, sv: u.sv + 1 });
  } else if (action === 'disable') Object.assign(u, { active: false, sv: u.sv + 1 });
  else if (action === 'enable') u.active = true;
  else if (action === 'role') u.role = ctx.body.role === 'admin' ? 'admin' : 'user';
  else fail(400, '不正な操作です');
  await db.set(`users/${u.id}`, u);
  await C.audit(`user_${action}`, { email: u.email, role: action === 'role' ? u.role : undefined, by: a.email });
  return { user: view(u), tempPassword };
});
on('DELETE admin/users/:id', async (ctx) => {
  const a = await admin(ctx);
  const u = (await db.get(`users/${ctx.params.id}`)) || fail(404, 'アカウントが見つかりません');
  if (u.id === a.id) fail(400, '自分自身のアカウントは削除できません');
  const keys = [...(await db.keys(`companies/${u.id}/`, 1000)), ...(await db.keys(`contents/${u.id}/`, 1000)), `otp/${u.id}`, `users/${u.id}`];
  await Promise.all(keys.map((k) => db.del(k)));
  await C.audit('user_deleted', { email: u.email, by: a.email });
});
on('GET admin/audit', async (ctx) => { await admin(ctx); return { entries: await db.all('audit/', 200) }; });

// --- 管理者: 設定 ---
on('GET admin/settings', async (ctx) => { await admin(ctx); return settingsView(await C.getSettings(true)); });
on('PUT admin/settings', async (ctx) => {
  const a = await admin(ctx);
  const b = ctx.body, p = {};
  if (b.geminiKey) p.geminiKeyEnc = C.seal(str(b.geminiKey, 200));
  if (b.geminiModel !== undefined) {
    if (!/^[a-z0-9.\-]{3,60}$/.test(b.geminiModel)) fail(400, 'モデル名の形式が正しくありません');
    p.geminiModel = b.geminiModel;
  }
  for (const k of ['limitResearch', 'limitGenerate', 'limitGlobal']) {
    if (b[k] === undefined) continue;
    if (!Number.isInteger(b[k]) || b[k] < 0 || b[k] > 100000) fail(400, '上限は0以上の整数で入力してください');
    p[k] = b[k];
  }
  if (b.googleClientId !== undefined) {
    p.googleClientId = str(b.googleClientId, 200);
    if (p.googleClientId && !/^[\w-]+\.apps\.googleusercontent\.com$/.test(p.googleClientId)) fail(400, 'クライアントIDの形式が正しくありません');
  }
  await C.saveSettings(p);
  await C.audit('settings', { keys: Object.keys(p).join(','), by: a.email });
  return settingsView(await C.getSettings(true));
});
on('POST admin/test-ai', async (ctx) => {
  await admin(ctx);
  const s = await C.getSettings(true);
  if (!s.geminiKey) fail(400, 'APIキーが未設定です');
  return { reply: await ping(s).catch((e) => fail(502, `接続に失敗しました: ${e.message}`.slice(0, 300))) };
});
// メール中継は「テスト送信→届いたコードを入力」で初めて有効化（誤設定でのログイン不能を防ぐ）
on('POST admin/mail', async (ctx) => {
  const a = await admin(ctx);
  const gasUrl = str(ctx.body.gasUrl, 300), gasSecret = str(ctx.body.gasSecret, 200);
  if (!/^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(gasUrl)) fail(400, 'GASウェブアプリのURL（https://script.google.com/macros/s/…/exec）を入力してください');
  if (gasSecret.length < 16) fail(400, '共有シークレットは16文字以上にしてください');
  if (!(await C.hit('mailcfg', a.id, 5, HOUR))) fail(429, TOO_MANY);
  const code = otpCode();
  await C.sendCode(a.email, code, { gasUrl, gasSecret }).catch((e) => {
    console.error(e);
    fail(502, 'テスト送信に失敗しました。URL・シークレット・GASの公開設定を確認してください');
  });
  await db.set(`mailcfg/${a.id}`, { h: C.hmac('otp', `${a.id}:${code}`), exp: Date.now() + 600000, n: 0, gasUrl, gasSecretEnc: C.seal(gasSecret) });
  return { to: mask(a.email) };
});
on('POST admin/mail/confirm', async (ctx) => {
  const a = await admin(ctx);
  const rec = await checkCode(`mailcfg/${a.id}`, a.id, ctx.body.code);
  await C.saveSettings({ gasUrl: rec.gasUrl, gasSecretEnc: rec.gasSecretEnc });
  await C.audit('settings', { keys: 'メール送信を有効化', by: a.email });
  return settingsView(await C.getSettings(true));
});
on('DELETE admin/mail', async (ctx) => {
  const a = await admin(ctx);
  await C.saveSettings({ gasUrl: '', gasSecretEnc: '' });
  await C.audit('settings', { keys: 'メール送信を無効化', by: a.email });
  return settingsView(await C.getSettings(true));
});

// ---------- エントリポイント ----------
async function readBody(req) {
  const MAX = 200000;
  if (Number(req.headers['content-length'] || 0) > MAX) fail(413, 'リクエストが大きすぎます');
  let b = req.body; // Vercel上では解析済み。ローカルではストリームから読む
  if (b === undefined) {
    b = '';
    for await (const chunk of req) {
      b += chunk;
      if (b.length > MAX) fail(413, 'リクエストが大きすぎます');
    }
  }
  if (typeof b === 'string') {
    try { b = b ? JSON.parse(b) : {}; } catch { fail(400, '不正なリクエストです'); }
  }
  return b && typeof b === 'object' && !Array.isArray(b) ? b : {};
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  const send = (status, obj) => {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(obj));
  };
  try {
    await C.ready();
    const pathStr = new URL(req.url, 'http://x').pathname.replace(/^\/api\//, '').replace(/\/+$/, '');
    const hit = match(req.method, pathStr) || fail(404, 'Not found');
    const ip = str(req.headers['x-real-ip'] || String(req.headers['x-forwarded-for'] || '').split(',')[0] || req.socket?.remoteAddress || 'unknown', 64);
    const ctx = { req, res, ip, params: hit.params, body: {} };
    if (req.method !== 'GET') {
      // CSRF対策: 専用ヘッダ必須 + Origin一致（Cookie は SameSite=Strict）
      const origin = req.headers.origin, host = req.headers.host;
      const sameOrigin = !origin || origin === `https://${host}` || (!process.env.VERCEL && origin === `http://${host}`);
      if (req.headers['x-requested-with'] !== 'cai' || !sameOrigin) fail(403, '不正なリクエストです');
      ctx.body = await readBody(req);
    }
    send(200, (await hit.fn(ctx)) ?? { ok: true });
  } catch (e) {
    const status = e.status || 500;
    if (!e.status) console.error(e);
    send(status, { error: status === 500 ? 'サーバーエラーが発生しました' : e.message, code: e.code });
  }
}
