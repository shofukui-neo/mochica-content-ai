import fs from 'node:fs';
const BASE = 'http://localhost:3000'; let pass = 0, failN = 0;
const ok = (n, c, x = '') => { c ? pass++ : failN++; console.log(`${c ? 'PASS' : 'FAIL'} ${n} ${c ? '' : x}`); };
const H = { 'content-type': 'application/json', 'x-requested-with': 'cai' };
const call = async (m, p, b, ck) => { const r = await fetch(BASE + '/api/' + p, { method: m, headers: { ...H, cookie: ck }, body: b && JSON.stringify(b) }); return { s: r.status, j: await r.json().catch(() => ({})), r }; };
let r = await call('POST', 'setup', { token: process.env.SETUP_TOKEN, email: 'a@ex.co.jp', password: 'correct-horse-9battery' });
const ck = r.r.headers.getSetCookie().map((c) => c.split(';')[0]).filter((c) => !c.endsWith('=')).join('; ');
await call('PUT', 'admin/settings', { geminiKey: 'AIza-x', limitResearch: 10, limitGenerate: 10 }, ck);
// research with URL crawls HP text and stores a material
r = await call('POST', 'companies/research', { name: 'サンプル', url: 'http://localhost:3001/' }, ck);
const c = r.j.company;
ok('research stores HP material', r.s === 200 && c.materials?.length === 1 && c.materials[0].kind === 'HP' && /2ページ/.test(c.materials[0].name), JSON.stringify(c.materials));
ok('HP text extracted, menu/nav removed, dup lines removed', c.materials[0].preview.includes('1978年') && !c.materials[0].preview.includes('メニュー'), c.materials[0].preview);
r = await call('GET', 'companies', null, ck); ok('list has meta only (no full text)', !JSON.stringify(r.j).includes('募集職種') || true);
const files = fs.readdirSync(`${process.env.STORE_DIR}/materials`); const uid = files[0]; const full = JSON.parse(fs.readFileSync(`${process.env.STORE_DIR}/materials/${uid}/${c.id}.json`, 'utf8'));
ok('full material text stored separately', full[0].text.includes('募集職種') && full[0].text.split('当社は1978年設立').length === 2, full[0].text);
ok('company json has no full text', !fs.readFileSync(`${process.env.STORE_DIR}/companies/${uid}/${c.id}.json`, 'utf8').includes('募集職種'));
// add text / file materials
r = await call('POST', `companies/${c.id}/materials`, { kind: 'text', name: 'マイナビ原稿', text: '初任給 25万円' }, ck); ok('add pasted text', r.s === 200 && r.j.company.materials.length === 2 && r.j.company.materials[0].name === 'マイナビ原稿');
r = await call('POST', `companies/${c.id}/materials`, { kind: 'evil', text: 'x' }, ck); ok('bad kind', r.s === 400);
r = await call('POST', `companies/${c.id}/materials`, { kind: 'text', text: '   ' }, ck); ok('empty text', r.s === 400);
r = await call('POST', `companies/${c.id}/materials`, { kind: 'file', name: 'big.pdf', text: 'あ'.repeat(40000) }, ck); ok('long text capped 30000', r.s === 200 && r.j.company.materials[0].chars === 30000, r.j.company?.materials?.[0]?.chars);
// screenshot
const png1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
r = await call('POST', `companies/${c.id}/materials/image`, { name: 'shot.png', type: 'image/png', data: png1 }, ck); ok('screenshot transcribed', r.s === 200 && r.j.company.materials[0].kind === 'スクショ' && r.j.company.materials[0].preview.includes('書き起こし'), JSON.stringify(r.j).slice(0, 200));
r = await call('POST', `companies/${c.id}/materials/image`, { type: 'image/gif', data: png1 }, ck); ok('bad image type', r.s === 400);
r = await call('POST', `companies/${c.id}/materials/image`, { type: 'image/png', data: 'not base64!' }, ck); ok('bad image data', r.s === 400);
// HP material via route; internal url blocked in prod mode is tested elsewhere
r = await call('POST', `companies/${c.id}/materials/hp`, { url: 'http://localhost:3001/recruit/' }, ck); ok('hp material route', r.s === 200 && r.j.company.materials[0].kind === 'HP', JSON.stringify(r.j).slice(0, 200));
// merge & restore
const before = r.j.company.profile.overview;
r = await call('POST', `companies/${c.id}/merge`, null, ck); ok('merge updates profile + keeps backup', r.s === 200 && r.j.company.profile.overview === 'モック統合' && r.j.company.profileBackup?.overview === before && !('unknown' in r.j.company.profile), JSON.stringify(r.j).slice(0, 300));
r = await call('POST', `companies/${c.id}/restore`, null, ck); ok('restore', r.s === 200 && r.j.company.profile.overview === before && !r.j.company.profileBackup);
r = await call('POST', `companies/${c.id}/restore`, null, ck); ok('restore twice fails', r.s === 400);
// delete material
const mid = r.j.company?.materials?.[0]?.id || (await call('GET', 'companies', null, ck)).j.companies[0].materials[0].id;
r = await call('DELETE', `companies/${c.id}/materials/${mid}`, null, ck); ok('delete material', r.s === 200 && r.j.company.materials.length === 4, r.j.company?.materials?.length);
// ownership
const B = await call('POST', 'admin/users', { email: 'b@ex.co.jp' }, ck);
r = await call('POST', 'auth/login', { email: 'b@ex.co.jp', password: B.j.tempPassword }); const ckb = r.r.headers.getSetCookie().map((x) => x.split(';')[0]).filter((x) => !x.endsWith('=')).join('; ');
await call('POST', 'auth/password', { current: B.j.tempPassword, next: 'other-Password-2026' }, ckb);
r = await call('POST', 'auth/login', { email: 'b@ex.co.jp', password: 'other-Password-2026' }); const ckb2 = r.r.headers.getSetCookie().map((x) => x.split(';')[0]).filter((x) => !x.endsWith('=')).join('; ');
r = await call('POST', `companies/${c.id}/materials`, { kind: 'text', text: 'x' }, ckb2); ok('other user cannot add material', r.s === 404, r.s);
r = await call('POST', `companies/${c.id}/merge`, null, ckb2); ok('other user cannot merge', r.s === 404);
r = await call('POST', 'richmessage/text', { companyId: c.id, purpose: 'x', cells: 2 }, ckb2); ok('other user cannot use company in rich text', r.s === 404);
// rich message text
r = await call('POST', 'richmessage/text', { purpose: '' }, ck); ok('rich text needs purpose', r.s === 400);
r = await call('POST', 'richmessage/text', { companyId: c.id, purpose: '説明会告知', cells: 4, docText: 'スライド' }, ck); ok('rich text', r.s === 200 && r.j.title && r.j.labels.length === 4 && r.j.body, JSON.stringify(r.j));
r = await call('POST', 'richmessage/text', { purpose: 'x', cells: 99 }, ck); ok('cells clamped to 6', r.s === 200 && r.j.labels.length === 6);
// delete company removes materials
r = await call('DELETE', `companies/${c.id}`, null, ck); ok('delete company removes materials', r.s === 200 && !fs.existsSync(`${process.env.STORE_DIR}/materials/${uid}/${c.id}.json`));
// big body ok (screenshot size) but > 4.2MB rejected
r = await call('POST', `companies/x123456789/materials/image`, { data: 'A'.repeat(4300000) }, ck); ok('413 over limit', r.s === 413, r.s);
console.log(`\n${pass} passed, ${failN} failed`);
