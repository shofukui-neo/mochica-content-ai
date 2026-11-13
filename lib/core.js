// 共通基盤: 保存（Vercel Blob 非公開ストア）・暗号・トークン・設定・メール・監査・回数制限
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { put, get, del, list } from '@vercel/blob';
import { SignJWT, jwtVerify, createRemoteJWKSet } from 'jose';

// ---------- 保存 ----------
const DIR = process.env.STORE_DIR; // ローカル検証用。本番は未設定＝Vercel Blob
const BLOB = { access: 'private', contentType: 'application/json', cacheControlMaxAge: 60 };
const file = (key) => {
  if (!/^[a-z0-9_\-/]+$/.test(key) || key.includes('//')) throw new Error('bad key');
  return `${key}.json`;
};

export const db = {
  async get(key) {
    if (DIR) {
      try { return JSON.parse(await fs.readFile(path.join(DIR, file(key)), 'utf8')); } catch { return null; }
    }
    const r = await get(file(key), { access: 'private', useCache: false });
    return r?.stream ? JSON.parse(await new Response(r.stream).text()) : null;
  },
  async set(key, value) {
    const body = JSON.stringify(value);
    if (!DIR) return void (await put(file(key), body, { ...BLOB, allowOverwrite: true }));
    const p = path.join(DIR, file(key));
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, body);
  },
  // 新規作成のみ。既に存在すれば false（メールアドレスの一意性・初期設定の一回性を保証）
  async create(key, value) {
    const body = JSON.stringify(value);
    try {
      if (DIR) {
        const p = path.join(DIR, file(key));
        await fs.mkdir(path.dirname(p), { recursive: true });
        await fs.writeFile(p, body, { flag: 'wx' });
      } else await put(file(key), body, { ...BLOB, allowOverwrite: false });
      return true;
    } catch (e) {
      if (await this.get(key)) return false;
      throw e;
    }
  },
  async del(key) {
    if (DIR) return void (await fs.rm(path.join(DIR, file(key)), { force: true }));
    await del(file(key));
  },
  async keys(prefix, limit = 200) {
    let out = [];
    if (DIR) {
      const names = await fs.readdir(path.join(DIR, prefix)).catch(() => []);
      out = names.filter((n) => n.endsWith('.json')).map((n) => prefix + n.slice(0, -5));
    } else {
      let cursor;
      do {
        const r = await list({ prefix, cursor, limit: 1000 });
        out.push(...r.blobs.map((b) => b.pathname.slice(0, -5)));
        cursor = r.hasMore ? r.cursor : null;
      } while (cursor && out.length < limit);
    }
    return out.sort().slice(0, limit);
  },
  async all(prefix, limit) {
    return (await Promise.all((await this.keys(prefix, limit)).map((k) => this.get(k)))).filter(Boolean);
  },
};

// ---------- 暗号・ID ----------
// 署名・暗号化用の鍵。環境変数 APP_SECRET があればそれを使い、無ければ初回起動時に生成して非公開ストアに保存する
let SECRET = process.env.APP_SECRET || '';
const stored = async (key, field, made) =>
  (await db.get(key))?.[field] || ((await db.create(key, { [field]: made })) ? made : (await db.get(key))[field]);
export async function ready() {
  if (SECRET.length < 32) SECRET = await stored('meta/secret', 'v', crypto.randomBytes(32).toString('hex'));
}
// 初期設定用の合言葉。環境変数 SETUP_TOKEN があればそれ、無ければ自動生成して非公開ストア（meta/setup-token.json）に置く
export const setupToken = async () =>
  (process.env.SETUP_TOKEN || '').length >= 20 ? process.env.SETUP_TOKEN : stored('meta/setup-token', 'token', crypto.randomBytes(20).toString('hex'));
const subkey = (label) => crypto.createHmac('sha256', SECRET).update(label).digest();
export const hmac = (label, data) => crypto.createHmac('sha256', subkey(label)).update(String(data)).digest('hex');
const sha = (v) => crypto.createHash('sha256').update(String(v)).digest();
export const safeEq = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));
export const rid = (bytes = 8) => crypto.randomBytes(bytes).toString('hex');
// 新しいものほど辞書順で先頭に来るID（一覧を新しい順で取り出すため）
export const newId = () => Math.floor(9e15 - Date.now()).toString(36) + rid(4);
export const uidOf = (email) => sha(email).toString('hex').slice(0, 32);
export const today = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10); // JST
export const normEmail = (v) => {
  const e = String(v ?? '').trim().toLowerCase();
  return e.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e) ? e : null;
};

// 設定に保存する秘密情報（APIキー等）の暗号化: AES-256-GCM
export function seal(text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', subkey('settings'), iv);
  const body = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]).toString('base64');
}
export function unseal(b64) {
  try {
    const b = Buffer.from(b64, 'base64');
    const d = crypto.createDecipheriv('aes-256-gcm', subkey('settings'), b.subarray(0, 12));
    d.setAuthTag(b.subarray(12, 28));
    return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
  } catch { return ''; }
}

// ---------- パスワード（scrypt） ----------
const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 128 * 1024 * 1024 };
const DUMMY = crypto.randomBytes(16);
const scrypt = (pw, salt) => new Promise((ok, ng) => crypto.scrypt(String(pw), salt, 64, SCRYPT, (e, k) => (e ? ng(e) : ok(k))));
export async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  return { s: salt.toString('base64'), h: (await scrypt(pw, salt)).toString('base64') };
}
// アカウントが無い場合も同じ計算量をかける（応答時間から存在有無を推測させない）
export async function checkPassword(pw, rec) {
  const k = await scrypt(pw, rec ? Buffer.from(rec.s, 'base64') : DUMMY);
  return !!rec && crypto.timingSafeEqual(k, Buffer.from(rec.h, 'base64'));
}
export function tempPassword() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  let s;
  do s = Array.from({ length: 16 }, () => A[crypto.randomInt(A.length)]).join('');
  while (!/[A-Za-z]/.test(s) || !/\d/.test(s));
  return s;
}
export function passwordProblem(pw, email) {
  if (typeof pw !== 'string' || pw.length < 12 || pw.length > 128) return 'パスワードは12文字以上で入力してください';
  if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) return 'パスワードには英字と数字を両方含めてください';
  const local = email.split('@')[0];
  if (local.length >= 4 && pw.toLowerCase().includes(local)) return 'メールアドレスを含むパスワードは使えません';
  return null;
}

// ---------- 署名トークン（セッション等） ----------
export const signToken = (claims, ttlSec) =>
  new SignJWT(claims).setProtectedHeader({ alg: 'HS256' }).setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + ttlSec).sign(subkey('jwt'));
export async function readToken(token, purpose) {
  try {
    const { payload } = await jwtVerify(String(token || ''), subkey('jwt'), { algorithms: ['HS256'] });
    return payload.p === purpose ? payload : null;
  } catch { return null; }
}
const GOOGLE_KEYS = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));
export async function verifyGoogle(credential, clientId) {
  const { payload } = await jwtVerify(credential, GOOGLE_KEYS, {
    issuer: ['https://accounts.google.com', 'accounts.google.com'], audience: clientId,
  });
  return payload.email_verified === true ? payload : null;
}

// ---------- 設定（管理画面から変更。秘密情報は暗号化して保存） ----------
const DEFAULTS = { geminiModel: 'gemini-3.8-flash', limitResearch: 5, limitGenerate: 30, limitGlobal: 300, googleClientId: '', gasUrl: '' };
let cache = { at: 0, v: null };
export async function getSettings(fresh) {
  if (!fresh && cache.v && Date.now() - cache.at < 30000) return cache.v;
  const s = { ...DEFAULTS, ...((await db.get('meta/settings')) || {}) };
  s.geminiKey = s.geminiKeyEnc ? unseal(s.geminiKeyEnc) : process.env.GEMINI_API_KEY || '';
  s.gasSecret = s.gasSecretEnc ? unseal(s.gasSecretEnc) : '';
  s.mailOn = !!(s.gasUrl && s.gasSecret) || !!process.env.DEV_MAIL_LOG;
  cache = { at: Date.now(), v: s };
  return s;
}
export async function saveSettings(patch) {
  await db.set('meta/settings', { ...((await db.get('meta/settings')) || {}), ...patch });
  cache.at = 0;
}

// ---------- メール（GAS中継。確認コードのみ送る定型メール） ----------
export async function sendCode(to, code, s) {
  if (process.env.DEV_MAIL_LOG) return void console.log(`[dev-mail] to=${to} code=${code}`);
  const r = await fetch(s.gasUrl, {
    method: 'POST', headers: { 'content-type': 'text/plain' },
    body: JSON.stringify({ secret: s.gasSecret, to, code }), signal: AbortSignal.timeout(20000),
  });
  const j = await r.json().catch(() => null);
  if (!j?.ok) throw new Error(`mail relay failed (${r.status})`);
}

// ---------- 監査ログ・回数制限・利用量 ----------
export async function audit(type, info = {}) {
  try {
    const t = Date.now();
    await db.set(`audit/${Math.floor(9e15 - t)}-${rid(3)}`, { t, type, ...info });
  } catch (e) { console.error('audit failed', e); }
}
// 固定ウィンドウの回数制限。上限以内なら true
export async function hit(bucket, id, max, windowSec) {
  const key = `rl/${bucket}/${hmac('rl', id).slice(0, 24)}-${Math.floor(Date.now() / 1000 / windowSec)}`;
  const c = (await db.get(key))?.c || 0;
  if (c >= max) return false; // 上限超過後は書き込まない（連打で保存領域を消費させない）
  await db.set(key, { c: c + 1 });
  return true;
}
export const usage = async (id) => (await db.get(`usage/${today()}/${id}`)) || { research: 0, generate: 0 };
export async function addUsage(uid, kind) {
  for (const id of [uid, 'all']) {
    const u = await usage(id);
    u[kind]++;
    await db.set(`usage/${today()}/${id}`, u);
  }
}
