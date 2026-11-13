// テスト用のダミー企業サイト（:3001）
import http from 'node:http'; import zlib from 'node:zlib'; import crypto from 'node:crypto';
function png(w, h, rgb, noise) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) { const o = y * (w * 3 + 1); for (let x = 0; x < w; x++) { const p = o + 1 + x * 3; if (noise) crypto.randomFillSync(raw, p, 3); else { raw[p] = (rgb[0] + x / 8) & 255; raw[p + 1] = (rgb[1] + y / 8) & 255; raw[p + 2] = rgb[2]; } } }
  const chunk = (t, d) => { const b = Buffer.concat([Buffer.from(t), d]); const len = Buffer.alloc(4); len.writeUInt32BE(d.length); const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(b)); return Buffer.concat([len, b, crc]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const imgs = { 'og.png': png(1200, 630, [200, 60, 60]), 'a.png': png(1600, 1000, [40, 120, 200]), 'b.png': png(900, 900, [60, 180, 90]), 'c.png': png(1200, 800, [220, 170, 40]), 'c-small.png': png(400, 267, [220, 170, 40]),
  'd.png': png(1400, 700, [130, 80, 190]), 'e.png': png(1000, 750, [0, 0, 0], true), 'icon.png': png(32, 32, [0, 0, 0]) };
const top = `<html><head><meta charset="utf-8"><meta property="og:image" content="/img/og.png"></head><body>
<img src="/img/a.png" alt="社屋の写真"><img data-src="img/b.png" src="data:image/gif;base64,R0lGOD" alt="遅延読み込み">
<picture><source srcset="/img/c-small.png 400w, /img/c.png 1200w"><img src="/img/c-small.png" alt="社員"></picture>
<div style="background-image:url('/img/d.png')"></div><img src="/img/icon.png" alt="アイコン"><img src="/img/logo.svg"><img src="/img/r" alt="転送される画像"><img src="/img/notimage" alt="画像でない">
<img src="/img/to-internal" alt="内部へ転送"><nav>メニュー 採用情報</nav><p>当社は1978年設立の精密部品メーカーです。</p><p>従業員数は240名です。</p><a href="/recruit/">採用情報</a><a href="/news/">ニュース</a><a href="https://other.example/company">会社</a></body></html>`;
http.createServer((req, res) => {
  const u = req.url.split('?')[0];
  if (u === '/') return res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(top);
  if (u === '/recruit/') return res.writeHead(200, { 'content-type': 'text/html' }).end('<html><head><title>採用情報｜サンプル</title></head><body><h2>募集職種</h2><p>技術職・営業職</p><p>当社は1978年設立の精密部品メーカーです。</p><img src="../img/e.png" alt="先輩社員"><img src="/img/a.png"></body></html>');
  if (u === '/img/r') return res.writeHead(302, { location: '/img/a.png' }).end();
  if (u === '/img/to-internal') return res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' }).end();
  if (u === '/img/notimage') return res.writeHead(200, { 'content-type': 'text/html' }).end('<script>alert(1)</script>');
  const f = imgs[u.replace('/img/', '')];
  f ? res.writeHead(200, { 'content-type': 'image/png' }).end(f) : res.writeHead(404).end();
}).listen(3001, () => console.log('fixture on 3001'));
