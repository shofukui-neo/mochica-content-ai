// ローカル検証用サーバー（本番には含まれない）
// 例: APP_SECRET=$(openssl rand -hex 32) SETUP_TOKEN=$(openssl rand -hex 20) STORE_DIR=/tmp/cai AI_MOCK=1 node dev/server.mjs
//     DEV_MAIL_LOG=1 を付けると確認コードをコンソールに出力（メール送信の代わり）
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import handler from '../api/index.js';

const root = path.resolve(import.meta.dirname, '..');
const HEADERS = JSON.parse(fs.readFileSync(path.join(root, 'vercel.json'), 'utf8')).headers[0].headers;
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.bcmap': 'application/octet-stream', '.pfb': 'application/octet-stream' };
http.createServer((req, res) => {
  for (const h of HEADERS) res.setHeader(h.key, h.value);
  if (req.url.startsWith('/api/')) return handler(req, res);
  const f = path.join(root, 'public', req.url === '/' ? 'index.html' : path.normalize(req.url.split('?')[0]));
  fs.readFile(f, (e, d) => (e ? (res.writeHead(404), res.end('not found')) : (res.writeHead(200, { 'content-type': types[path.extname(f)] || 'text/plain' }), res.end(d))));
}).listen(3000, () => console.log('http://localhost:3000'));
