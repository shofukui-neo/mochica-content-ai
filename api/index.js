// APIルーター（Vercel Function 1本）。/api/* はすべてここに来る（vercel.json の rewrites）
import crypto from 'node:crypto';
import * as C from '../lib/core.js';
import { CATALOG, PROFILE_FIELDS, cleanProfile, research, generate, ping, mergeProfile, transcribe, richText } from '../lib/ai.js';
import { scanSite, fetchImage, crawlText } from '../lib/web.js';
import { generateImage, imageReady } from '../lib/image.js';

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
  const lim = { research: s.limitResearch, generate: s.limitGenerate, image: s.limitImage }[kind];
  if (mine[kind] >= lim) fail(429, `本日の${{ research: '企業調査', generate: '生成', image: '画像生成' }[kind]}回数の上限（${lim}回）に達しました`);
  if (all.research + all.generate + all.image >= s.limitGlobal) fail(429, '本日の全体の利用上限に達しました。管理者に連絡してください');
  if (kind === 'image' ? !imageReady(s) : !s.geminiKey) fail(503, `${kind === 'image' ? '画像生成' : 'AI'}が未設定です。管理者に連絡してください`);
}
const aiFail = (e) => {
  console.error(e);
  fail(502, e.status === 429 ? 'AIが混み合っています。少し待ってからお試しください'
    : e.status === 400 || e.status === 403 ? 'AIの設定に問題があります。管理者に連絡してください' : 'AIの呼び出しに失敗しました。もう一度お試しください');
};
const settingsView = (s) => ({ geminiKeySet: !!s.geminiKey, geminiModel: s.geminiModel, limitResearch: s.limitResearch, limitGenerate: s.limitGenerate, limitGlobal: s.limitGlobal, googleClientId: s.googleClientId, gasUrl: s.gasUrl, mailOn: s.mailOn,
  imageProvider: s.imageProvider, cfAccountId: s.cfAccountId, cfTokenSet: !!s.cfToken, geminiImageModel: s.geminiImageModel, limitImage: s.limitImage, imageOn: imageReady(s) });

// メモリ内の簡易回数制限（ストアの操作回数を消費しない。画像取得のように回数が多い処理用）
const recent = new Map();
function throttle(key, max, windowMs) {
  const now = Date.now();
  const list = (recent.get(key) || []).filter((t) => now - t < windowMs);
  if (list.length >= max) return false;
  list.push(now);
  if (recent.size > 5000) recent.clear();
  recent.set(key, list);
  return true;
}

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
  return { user: pub(u, ctx.am), usage: await C.usage(u.id), limits: { research: s.limitResearch, generate: s.limitGenerate, image: s.limitImage }, imageOn: imageReady(s), catalog: { ...CATALOG, profileFields: PROFILE_FIELDS } };
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
  // 公式サイトが分かっていれば本文も読み込んで調査に使い、素材としても残す
  const pages = input.url ? await crawlText(input.url).catch(() => null) : null;
  const site = pages && pages.map((p) => `【${p.title}】${p.url}\n${p.text}`).join('\n\n');
  const r = await research(s, { ...input, note: str(ctx.body.note, 500), site }).catch(aiFail);
  const c = { id: C.newId(), name: r.name || input.name, url: input.url || r.url, profile: r.profile, sources: r.sources, queries: r.queries, materials: [], createdAt: Date.now(), updatedAt: Date.now() };
  await db.set(`companies/${u.id}/${c.id}`, c);
  if (site) await addMaterial(u, c, { kind: 'HP', name: `${new URL(input.url).hostname}（${pages.length}ページ）`, text: site });
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
on('DELETE companies/:id', async (ctx) => {
  const u = await me(ctx);
  await Promise.all([db.del(`companies/${u.id}/${ctx.params.id}`), db.del(`materials/${u.id}/${ctx.params.id}`)]);
});

// --- 素材（企業情報の材料: HPの本文・資料・原稿・スクショ） ---
// 本文は企業データとは別に保存し、企業データには一覧用の見出しだけを持たせる（一覧の読み込みを軽くする）
const MAT_MAX = 20, MAT_CHARS = 30000;
const matKey = (u, cid) => `materials/${u.id}/${cid}`;
const matMeta = (m) => ({ id: m.id, kind: m.kind, name: m.name, chars: m.text.length, preview: m.text.slice(0, 140), createdAt: m.createdAt });
const ownCompany = async (u, id) => (await db.get(`companies/${u.id}/${id}`)) || fail(404, '企業が見つかりません');
async function addMaterial(u, c, m) {
  const text = String(m.text || '').replace(/\u0000/g, '').slice(0, MAT_CHARS);
  if (!text.trim()) fail(400, '取り込める文字がありませんでした');
  const list = (await db.get(matKey(u, c.id))) || [];
  if (list.length >= MAT_MAX) fail(400, `素材は1社あたり${MAT_MAX}件までです。不要なものを削除してください`);
  list.unshift({ id: C.newId(), kind: m.kind, name: str(m.name, 100) || '素材', text, createdAt: Date.now() });
  await db.set(matKey(u, c.id), list);
  Object.assign(c, { materials: list.map(matMeta), updatedAt: Date.now() });
  await db.set(`companies/${u.id}/${c.id}`, c);
  return { company: c };
}
on('POST companies/:id/materials', async (ctx) => { // 貼り付けたテキスト、ブラウザで読み取ったPPTX・PDF等の文字
  const u = await me(ctx);
  const kind = { text: '貼り付け', file: '資料' }[ctx.body.kind] || fail(400, '不正な種類です');
  return addMaterial(u, await ownCompany(u, ctx.params.id), { kind, name: ctx.body.name, text: str(ctx.body.text, MAT_CHARS + 1000) });
});
on('POST companies/:id/materials/hp', async (ctx) => {
  const u = await me(ctx);
  const c = await ownCompany(u, ctx.params.id);
  const url = httpUrl(ctx.body.url || c.url) || fail(400, 'HPのURL（https://…）を入力してください');
  if (!throttle(`scan:${u.id}`, 6, 600000)) fail(429, '取得の回数が多すぎます。10分ほど待ってからお試しください');
  const pages = await crawlText(url).catch((e) => fail(e.status || 502, e.status ? e.message : 'サイトを取得できませんでした'));
  return addMaterial(u, c, { kind: 'HP', name: `${new URL(url).hostname}（${pages.length}ページ）`, text: pages.map((p) => `【${p.title}】${p.url}\n${p.text}`).join('\n\n') });
});
on('POST companies/:id/materials/image', async (ctx) => { // スクショをAIで書き起こして素材にする
  const u = await me(ctx);
  const c = await ownCompany(u, ctx.params.id);
  const type = ['image/jpeg', 'image/png', 'image/webp'].includes(ctx.body.type) ? ctx.body.type : fail(400, 'JPEG・PNG・WebPの画像を選んでください');
  const data = typeof ctx.body.data === 'string' && /^[A-Za-z0-9+/=]+$/.test(ctx.body.data) && ctx.body.data.length < 4000000 ? ctx.body.data : fail(400, '画像が大きすぎるか、形式が正しくありません');
  const s = await C.getSettings();
  await quota(u, 'generate', s);
  const text = await transcribe(s, { type, data }).catch(aiFail);
  await C.addUsage(u.id, 'generate');
  return addMaterial(u, c, { kind: 'スクショ', name: ctx.body.name, text });
});
on('DELETE companies/:id/materials/:mid', async (ctx) => {
  const u = await me(ctx);
  const c = await ownCompany(u, ctx.params.id);
  const list = ((await db.get(matKey(u, c.id))) || []).filter((m) => m.id !== ctx.params.mid);
  await db.set(matKey(u, c.id), list);
  Object.assign(c, { materials: list.map(matMeta), updatedAt: Date.now() });
  await db.set(`companies/${u.id}/${c.id}`, c);
  return { company: c };
});
on('POST companies/:id/merge', async (ctx) => { // 素材をAIが読み、企業情報を更新（1つ前の内容は戻せるよう残す）
  const u = await me(ctx);
  const c = await ownCompany(u, ctx.params.id);
  const materials = (await db.get(matKey(u, c.id))) || [];
  if (!materials.length) fail(400, '素材がありません。先にHP・資料・テキストなどを追加してください');
  const s = await C.getSettings();
  await quota(u, 'research', s);
  const profile = await mergeProfile(s, { company: c, materials }).catch(aiFail);
  Object.assign(c, { profileBackup: c.profile, profile, updatedAt: Date.now() });
  await db.set(`companies/${u.id}/${c.id}`, c);
  await C.addUsage(u.id, 'research');
  return { company: c };
});
on('POST companies/:id/restore', async (ctx) => {
  const u = await me(ctx);
  const c = await ownCompany(u, ctx.params.id);
  if (!c.profileBackup) fail(400, '戻せる内容がありません');
  Object.assign(c, { profile: c.profileBackup, profileBackup: null, updatedAt: Date.now() });
  await db.set(`companies/${u.id}/${c.id}`, c);
  return { company: c };
});

// --- リッチメッセージの文面（タイトル・画像の文字・添えるメッセージ） ---
on('POST richmessage/text', async (ctx) => {
  const u = await me(ctx);
  const b = ctx.body;
  const purpose = str(b.purpose, 300) || fail(400, '何を伝えるメッセージかを入力してください');
  const cells = Math.min(Math.max(parseInt(b.cells, 10) || 1, 1), 6);
  const company = b.companyId ? (/^[a-z0-9]{8,40}$/.test(b.companyId) ? await ownCompany(u, b.companyId) : fail(400, '企業の指定が正しくありません')) : null;
  const s = await C.getSettings();
  await quota(u, 'generate', s);
  const r = await richText(s, { company, purpose, extra: str(b.extra, 3000), docText: str(b.docText, 20000), cells }).catch(aiFail);
  await C.addUsage(u.id, 'generate');
  return r;
});

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

// --- リッチメッセージ用: HPから画像候補を取得 ---
// 画像は署名つきURL（2時間有効）で中継する。署名があるURLしか取得しないので、任意のURLの中継には使えない
on('POST site/images', async (ctx) => {
  const u = await me(ctx);
  const url = httpUrl(ctx.body.url) || fail(400, 'HPのURL（https://…）を入力してください');
  if (!throttle(`scan:${u.id}`, 6, 600000)) fail(429, '取得の回数が多すぎます。10分ほど待ってからお試しください');
  const r = await scanSite(url).catch((e) => fail(e.status || 502, e.status ? e.message : 'サイトを取得できませんでした'));
  const exp = Date.now() + 2 * HOUR * 1000;
  return { pages: r.pages, images: r.images.map((i) => ({ alt: i.alt, src: `/api/img?u=${encodeURIComponent(i.url)}&e=${exp}&s=${C.hmac('img', `${i.url}|${exp}`)}` })) };
});
// --- リッチメッセージ用: AIで画像を作る（サーバーには保存しない） ---
on('POST image/generate', async (ctx) => {
  const u = await me(ctx);
  const prompt = str(ctx.body.prompt, 500) || fail(400, 'どんな画像にしたいかを入力してください');
  const s = await C.getSettings();
  await quota(u, 'image', s);
  const r = await generateImage(s, { prompt, aspect: ctx.body.aspect === 'wide' ? 'wide' : 'square' }).catch((e) => {
    console.error(e);
    fail(e.status === 429 ? 429 : e.status === 503 ? 503 : 502, e.status === 429 ? '画像生成の無料枠または利用上限に達しました。時間をおいてお試しください' : e.status === 503 ? e.message : '画像を生成できませんでした。表現を変えてもう一度お試しください');
  });
  await C.addUsage(u.id, 'image');
  return { type: r.type, data: r.body.toString('base64') };
});
on('GET img', async (ctx) => {
  const { u = '', e = '', s = '' } = ctx.query;
  if (!(Number(e) > Date.now()) || !C.safeEq(s, C.hmac('img', `${u}|${e}`))) fail(403, '画像の取得期限が切れました。もう一度取得してください');
  if (!throttle(`img:${ctx.ip}`, 400, 600000)) fail(429, TOO_MANY);
  const r = await fetchImage(u).catch((err) => fail(err.status || 502, '画像を取得できませんでした'));
  return { raw: r.body, type: r.type };
});

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
  const keys = [...(await db.keys(`companies/${u.id}/`, 1000)), ...(await db.keys(`contents/${u.id}/`, 1000)), ...(await db.keys(`materials/${u.id}/`, 1000)), `otp/${u.id}`, `users/${u.id}`];
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
  if (b.imageProvider !== undefined) {
    if (!['', 'cloudflare', 'gemini'].includes(b.imageProvider)) fail(400, '画像生成のプロバイダが正しくありません');
    p.imageProvider = b.imageProvider;
  }
  if (b.cfAccountId !== undefined) {
    p.cfAccountId = str(b.cfAccountId, 64);
    if (p.cfAccountId && !/^[0-9a-f]{32}$/.test(p.cfAccountId)) fail(400, 'CloudflareのアカウントIDは32桁の英数字です');
  }
  if (b.cfToken) p.cfTokenEnc = C.seal(str(b.cfToken, 200));
  if (b.geminiImageModel !== undefined) {
    if (!/^[a-z0-9.\-]{3,60}$/.test(b.geminiImageModel)) fail(400, '画像モデル名の形式が正しくありません');
    p.geminiImageModel = b.geminiImageModel;
  }
  for (const k of ['limitResearch', 'limitGenerate', 'limitGlobal', 'limitImage']) {
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
on('POST admin/test-image', async (ctx) => {
  await admin(ctx);
  const s = await C.getSettings(true);
  if (!imageReady(s)) fail(400, '画像生成のプロバイダと認証情報を設定してください');
  const r = await generateImage(s, { prompt: '明るいオフィスで働く人たちの後ろ姿', aspect: 'square' }).catch((e) => fail(502, `生成に失敗しました: ${e.message}`.slice(0, 300)));
  return { type: r.type, data: r.body.toString('base64') };
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
  const MAX = 4200000; // スクショの取り込み（base64）に合わせた上限。各項目は個別に文字数を制限している
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
    const reqUrl = new URL(req.url, 'http://x');
    const pathStr = reqUrl.pathname.replace(/^\/api\//, '').replace(/\/+$/, '');
    const hit = match(req.method, pathStr) || fail(404, 'Not found');
    const ip = str(req.headers['x-real-ip'] || String(req.headers['x-forwarded-for'] || '').split(',')[0] || req.socket?.remoteAddress || 'unknown', 64);
    const ctx = { req, res, ip, params: hit.params, body: {}, query: Object.fromEntries(reqUrl.searchParams) };
    if (req.method !== 'GET') {
      // CSRF対策: 専用ヘッダ必須 + Origin一致（Cookie は SameSite=Strict）
      const origin = req.headers.origin, host = req.headers.host;
      const sameOrigin = !origin || origin === `https://${host}` || (!process.env.VERCEL && origin === `http://${host}`);
      if (req.headers['x-requested-with'] !== 'cai' || !sameOrigin) fail(403, '不正なリクエストです');
      ctx.body = await readBody(req);
    }
    const result = await hit.fn(ctx);
    if (result?.raw) { // 画像の中継
      res.statusCode = 200;
      res.setHeader('Content-Type', result.type);
      res.setHeader('Cache-Control', 'private, max-age=3600');
      return res.end(result.raw);
    }
    send(200, result ?? { ok: true });
  } catch (e) {
    const status = e.status || 500;
    if (!e.status) console.error(e);
    send(status, { error: status === 500 ? 'サーバーエラーが発生しました' : e.message, code: e.code });
  }
}
