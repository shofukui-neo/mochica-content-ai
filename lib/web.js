// 外部サイトへのアクセス（HPからの画像取得）。
// 内部ネットワーク宛ては「URLの検査」と「接続時の名前解決の検査」の2段で遮断する（SSRF対策）
import dns from 'node:dns';
import net from 'node:net';
import { Agent, fetch as ufetch } from 'undici';
import sharp from 'sharp';

const UA = 'Mozilla/5.0 (compatible; ContentAI-for-MOCHICA/1.0)';
const LOCAL_OK = !process.env.VERCEL && !!process.env.DEV_ALLOW_LOCAL; // ローカル検証専用（自分自身=127.0.0.1 だけ許可）。Vercel上では常に無効
const err = (status, message) => Object.assign(new Error(message), { status });

const block = new net.BlockList();
for (const [a, p] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24],
  ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]]) block.addSubnet(a, p, 'ipv4');
for (const [a, p] of [['::', 128], ['::1', 128], ['64:ff9b::', 96], ['2001:db8::', 32], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]]) block.addSubnet(a, p, 'ipv6');

export function isPrivate(ip) {
  const fam = net.isIP(ip);
  if (!fam) return true;
  if (fam === 4) return block.check(ip, 'ipv4');
  const mapped = ip.toLowerCase().match(/^::ffff:(.+)$/); // IPv4射影アドレス
  if (mapped) return net.isIP(mapped[1]) === 4 ? block.check(mapped[1], 'ipv4') : true;
  return block.check(ip, 'ipv6');
}

const blocked = (ip) => isPrivate(ip) && !(LOCAL_OK && (ip === '::1' || /^127\./.test(ip)));

function checkUrl(s) {
  let u;
  try { u = new URL(s); } catch { throw err(400, 'URLの形式が正しくありません'); }
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const bad = !/^https?:$/.test(u.protocol) || u.username || u.password || (!LOCAL_OK && u.port && !['80', '443'].includes(u.port))
    || (net.isIP(host) && blocked(host)) || (!LOCAL_OK && /(^|\.)(localhost|local|internal|intranet|lan|home|corp)$/i.test(host));
  if (bad) throw err(400, 'このURLにはアクセスできません');
}
// 実際に接続するIPをここで検査する（URL検査のあとで別のIPに差し替える手口を防ぐ）
function lookup(hostname, options, cb) {
  dns.lookup(hostname, { ...options, all: true }, (e, list) => {
    if (e) return cb(e);
    if (!list.length || list.some((a) => blocked(a.address))) return cb(err(400, 'このURLにはアクセスできません'));
    options.all ? cb(null, list) : cb(null, list[0].address, list[0].family);
  });
}
const agent = new Agent({ connect: { lookup, timeout: 8000 }, headersTimeout: 10000, bodyTimeout: 15000 });

// リダイレクトは自前で追い、1回ごとにURLを検査する。サイズ上限つき
export async function safeFetch(start, { maxBytes, accept }) {
  let url = start;
  for (let hop = 0; hop < 5; hop++) {
    checkUrl(url);
    let r;
    try {
      r = await ufetch(url, { dispatcher: agent, redirect: 'manual', headers: { 'user-agent': UA, accept }, signal: AbortSignal.timeout(15000) });
    } catch (e) {
      throw e.cause?.status ? e.cause : err(502, 'サイトに接続できませんでした');
    }
    const loc = r.headers.get('location');
    if (r.status >= 300 && r.status < 400 && loc) {
      await r.body?.cancel();
      url = new URL(loc, url).href;
      continue;
    }
    if (!r.ok) throw err(502, `サイトから取得できませんでした（HTTP ${r.status}）`);
    const chunks = [];
    let size = 0;
    for await (const c of r.body) {
      size += c.length;
      if (size > maxBytes) throw err(413, 'データが大きすぎます');
      chunks.push(c);
    }
    return { url, contentType: (r.headers.get('content-type') || '').toLowerCase(), body: Buffer.concat(chunks) };
  }
  throw err(502, '転送が多すぎます');
}

// ---------- HTMLから画像候補を取り出す ----------
const entities = (s) => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
const attr = (tag, name) => {
  const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  return m ? entities(m[1] ?? m[2] ?? m[3] ?? '').trim() : '';
};
function largestOfSrcset(value) {
  let best = '', bestW = -1;
  for (const part of value.split(',')) {
    const [u, d] = part.trim().split(/\s+/);
    const w = parseFloat(d) || 0;
    if (u && w >= bestW) { best = u; bestW = w; }
  }
  return best;
}
function decodeHtml(body, contentType) {
  const head = body.subarray(0, 3000).toString('latin1');
  const charset = (contentType.match(/charset=([\w-]+)/) || head.match(/<meta[^>]+charset=["']?([\w-]+)/i) || [])[1] || 'utf-8';
  try { return new TextDecoder(charset).decode(body); } catch { return body.toString('utf8'); }
}

export function extractImages(html, pageUrl) {
  let root = pageUrl;
  try { root = new URL(attr((html.match(/<base\b[^>]*>/i) || [''])[0], 'href') || pageUrl, pageUrl).href; } catch { /* baseが不正なら無視 */ }
  const out = new Map();
  const add = (raw, alt = '') => {
    if (!raw || /^(data|blob|javascript):/i.test(raw)) return;
    let u;
    try { u = new URL(raw, root); } catch { return; }
    u.hash = '';
    const p = u.pathname.toLowerCase();
    if (!/^https?:$/.test(u.protocol) || /\.(svg|gif|ico|bmp|mp4|webm|mov|mp3|pdf)$/.test(p) || /(sprite|spacer|blank|pixel|loading|favicon)/.test(p)) return;
    if (!out.has(u.href)) out.set(u.href, { url: u.href, alt: alt.slice(0, 80) });
  };
  for (const [tag] of html.matchAll(/<meta\b[^>]*>/gi)) {
    if (/^(og:image(:secure_url|:url)?|twitter:image(:src)?)$/i.test(attr(tag, 'property') || attr(tag, 'name'))) add(attr(tag, 'content'), 'ページの代表画像');
  }
  for (const [tag] of html.matchAll(/<(?:img|source)\b[^>]*>/gi)) {
    const alt = attr(tag, 'alt');
    for (const n of ['srcset', 'data-srcset']) { const v = attr(tag, n); if (v) add(largestOfSrcset(v), alt); }
    for (const n of ['src', 'data-src', 'data-lazy-src', 'data-original']) add(attr(tag, n), alt);
  }
  for (const m of html.matchAll(/background(?:-image)?\s*:[^;"'}]*url\(\s*(?:&quot;|["'])?([^"')&\s]+)/gi)) add(entities(m[1]));
  return [...out.values()];
}
// 採用・会社紹介らしい同一サイト内のページを最大3つ選ぶ
export function pickLinks(html, pageUrl, max = 3) {
  const origin = new URL(pageUrl).origin;
  const found = new Set();
  for (const m of html.matchAll(/<a\b[^>]*>([\s\S]{0,200}?)<\/a>/gi)) {
    const href = attr(m[0].slice(0, m[0].indexOf('>') + 1), 'href');
    if (!href || !/(recruit|saiyo|career|company|about|corporate|staff|people|interview|benefit|welfare|message|vision|philosophy|business|service|採用|会社|企業|社員|働く|私たち|福利厚生|制度|理念|事業|代表|メッセージ|数字)/i.test(`${href} ${m[1].replace(/<[^>]+>/g, '')}`)) continue;
    try {
      const u = new URL(href, pageUrl);
      u.hash = '';
      if (u.origin === origin && u.href !== pageUrl && !/\.(pdf|zip|docx?|xlsx?|pptx?)$/i.test(u.pathname)) found.add(u.href);
    } catch { /* 不正なリンクは無視 */ }
    if (found.size >= max) break;
  }
  return [...found];
}

async function loadPage(url) {
  const r = await safeFetch(url, { maxBytes: 2000000, accept: 'text/html,application/xhtml+xml' });
  if (!r.contentType.includes('html')) throw err(400, 'HTMLのページではありません');
  return { url: r.url, html: decodeHtml(r.body, r.contentType) };
}
export async function scanSite(startUrl) {
  const first = await loadPage(startUrl);
  const more = await Promise.allSettled(pickLinks(first.html, first.url).map(loadPage));
  const pages = [first, ...more.filter((r) => r.status === 'fulfilled').map((r) => r.value)];
  const seen = new Map();
  for (const p of pages) for (const img of extractImages(p.html, p.url)) if (!seen.has(img.url)) seen.set(img.url, img);
  return { pages: pages.map((p) => p.url), images: [...seen.values()].slice(0, 48) };
}

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/avif'];
export async function fetchImage(url) {
  const r = await safeFetch(url, { maxBytes: 20000000, accept: 'image/webp,image/png,image/jpeg,image/avif' });
  const type = r.contentType.split(';')[0].trim();
  if (!IMAGE_TYPES.includes(type)) throw err(415, '対応していない画像形式です');
  // 大きい画像は長辺2080pxのJPEGに縮小（関数の応答上限4.5MBに収め、画面も軽くする）
  try {
    const img = sharp(r.body, { limitInputPixels: 80e6, failOn: 'error' }).rotate();
    const meta = await img.metadata();
    if (Math.max(meta.width || 0, meta.height || 0) <= 2080 && r.body.length <= 2500000) return { type, body: r.body };
    return { type: 'image/jpeg', body: await img.resize({ width: 2080, height: 2080, fit: 'inside', withoutEnlargement: true }).flatten({ background: '#ffffff' }).jpeg({ quality: 85, mozjpeg: true }).toBuffer() };
  } catch {
    throw err(415, '画像を読み込めませんでした');
  }
}

// ---------- HPの文章を集める（企業情報の素材） ----------
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', reg: '®', yen: '¥', middot: '・', hellip: '…', ndash: '–', mdash: '—', laquo: '«', raquo: '»' };
export function htmlToText(html) {
  const title = ((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '').replace(/\s+/g, ' ').trim();
  const body = html
    .replace(/<(head|script|style|noscript|svg|template|iframe|nav|form|select)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(br|hr)\b[^>]*>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr|dt|dd|section|article|header|footer|table|ul|ol|dl|blockquote)>/gi, '\n')
    .replace(/<(td|th)\b[^>]*>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => (e[0] === '#' ? String.fromCodePoint(parseInt(e[1] === 'x' || e[1] === 'X' ? e.slice(2) : e.slice(1), e[1] === 'x' || e[1] === 'X' ? 16 : 10) || 32) : ENT[e.toLowerCase()] ?? m));
  const lines = body.split('\n').map((l) => l.replace(/[ \t\u3000\u00a0]+/g, ' ').trim()).filter((l) => l.length >= 2);
  return { title: entities(title).slice(0, 120), lines };
}
// トップと、採用・会社紹介らしいページ最大6つの本文を取り出す。メニュー等の繰り返し行はページをまたいで除く
export async function crawlText(startUrl) {
  const first = await loadPage(startUrl);
  const more = await Promise.allSettled(pickLinks(first.html, first.url, 6).map(loadPage));
  const pages = [first, ...more.filter((r) => r.status === 'fulfilled').map((r) => r.value)];
  const seen = new Set();
  let total = 0;
  const out = [];
  for (const p of pages) {
    const { title, lines } = htmlToText(p.html);
    const kept = lines.filter((l) => !seen.has(l) && (seen.add(l), true));
    const text = kept.join('\n').slice(0, Math.max(0, Math.min(12000, 30000 - total)));
    if (!text) continue;
    total += text.length;
    out.push({ url: p.url, title: title || p.url, text });
  }
  if (!out.length) throw err(422, 'ページから文章を取り出せませんでした（画面をJavaScriptで描くサイトの可能性があります）');
  return out;
}
