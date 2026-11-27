/*
 * Sync with a file KeePassXC itself made and reads (keepassxc-cli), there and back:
 *   KeePassXC makes the database → RegiBase imports it, changes records, adds one, sets a
 *   one-time password and a field of its own, and syncs → KeePassXC opens the file and shows all
 *   of it (the code of the one-time password is the same), its attachment is still there →
 *   KeePassXC changes an entry → the next sync sees it as changed in KeePass only.
 * Needs Playwright, Chrome, podman and an image with keepassxc-cli (KPXC_IMAGE, default
 * localhost/kpxc-test: alpine + "apk add keepassxc").
 * Run: node tests/pwmanager_keepassxc_compat.mjs   (and KPXC_KDBX4=1 for a KDBX 4 file)
 */
import { chromium } from '/root/editbase-tests/pw.mjs';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const here = dirname(fileURLToPath(import.meta.url)); const js = join(here, '..', 'js');
const W = mkdtempSync(join(process.env.KPXC_WORK || tmpdir(), 'kpxc-'));
const IMG = process.env.KPXC_IMAGE || 'localhost/kpxc-test';
const PW = 'kpxc-pw-1';
const kx = (args, input) => execFileSync('podman', ['run', '--rm', '-i', '-v', W + ':/w:Z', IMG, 'keepassxc-cli', ...args], { input: input == null ? PW + '\n' : input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
let fail = 0;
const ok = (c, m, extra = '') => { console.log((c ? 'PASS  ' : 'FAIL  ') + m + (c ? '' : '  (' + extra + ')')); if (!c) fail++; };

const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const page = await b.newPage();
const errs = []; page.on('pageerror', (e) => errs.push(String(e).slice(0, 200)));
await page.route('http://localhost:8123/**', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>t</title>' }));
await page.goto('http://localhost:8123/');
for (const f of ['vendor/kdbxweb.min.js', 'vendor/argon2.umd.min.js', 'pwmanager.js']) await page.addScriptTag({ content: readFileSync(join(js, f), 'utf8') });

// ---- KeePassXC makes the database
// KeePassXC's own new database is KDBX 3.1 (AES-KDF). KPXC_KDBX4=1: an empty KDBX 4 (Argon2d) database is made first
// and KeePassXC adds everything to it, so it saves it as KDBX 4.
if (process.env.KPXC_KDBX4) {
  const b64 = await page.evaluate(async (PW) => { const u = new Uint8Array(await window.RBPw.writeKdbx([], { password: PW, name: 'Argon2' })); let s = ''; for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]); return btoa(s); }, PW);
  writeFileSync(join(W, 't.kdbx'), Buffer.from(b64, 'base64'));
} else kx(['db-create', '-p', '/w/t.kdbx'], PW + '\n' + PW + '\n');
kx(['mkdir', '/w/t.kdbx', 'Bank']);
kx(['add', '-u', 'taro', '-p', '--url', 'https://bank.test', '/w/t.kdbx', 'Bank/Sakura'], PW + '\nsecret-1\n');
kx(['add', '-u', 'me', '-p', '--notes', 'line 1', '/w/t.kdbx', 'Mail'], PW + '\nmail-1\n');
kx(['add', '-u', 'u', '-p', '/w/t.kdbx', 'Shop'], PW + '\nshop-1\n');
writeFileSync(join(W, 'scan.txt'), 'attachment-bytes');
kx(['attachment-import', '/w/t.kdbx', 'Shop', 'scan.txt', '/w/scan.txt']);
console.log('KeePassXC ' + kx(['--version'], '').trim());

// ---- RegiBase: import, change, sync
const TOTP = 'otpauth://totp/Mail?secret=JBSWY3DPEHPK3PXP&period=30&digits=6';
const r1 = await page.evaluate(async ({ b64, PW, TOTP }) => {
  const P = window.RBPw; const u8 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0)).buffer;
  const L = { title: 'Title', group: 'Group', url: 'URL', username: 'User', password: 'Password', totp: 'TOTP', notes: 'Memo', tags: 'Tags', kpid: 'KeePass ID' };
  const file = await P.readKdbx(u8(b64), PW, null);
  const col = P.toCollection(file.entries, L, {});
  let fields = col.fields.concat([{ key: 'pin', label: 'PIN', type: 'password', secret: true }, { key: 'totp', label: 'TOTP', type: 'password', secret: true }]);
  const tk = fields.find((x) => x.is_title).key;
  const records = col.records.map((d, i) => ({ id: i + 1, data: { ...d }, updated_at: '2031-01-01T00:00:00.000Z' }));
  const rec = (t) => records.find((x) => x.data[tk] === t);
  rec('Sakura').data.password = 'secret-2-rb';
  rec('Mail').data.totp = TOTP;
  rec('Shop').data.pin = '0042';
  records.push({ id: 99, data: { [tk]: 'Neu', group: 'Bank/Cards', username: 'nn', password: 'neu-1' }, updated_at: '2031-01-01T00:00:00.000Z' });
  const plan = P.planSync(fields, records, file, L);
  const applied = P.syncApply(plan, {});
  const buf = new Uint8Array(await P.syncSave(file));
  let s = ''; for (let i = 0; i < buf.length; i++) s += String.fromCharCode(buf[i]);
  // RegiBase's side after it, for the next round
  if (plan.fields) fields = plan.fields;
  const updatedAt = {}; for (const x of records) updatedAt[x.id] = x.updated_at;
  for (const u of applied.update) { const x = records.find((y) => y.id === u.id); x.data = u.data; x.updated_at = '2031-01-02T00:00:00.000Z'; updatedAt[x.id] = x.updated_at; }
  const state = P.syncStateAfter(applied, updatedAt, []);
  fields = fields.map((x) => x.key === P.UUID_KEY ? { ...x, options: { kdbx: { sync: state } } } : x);
  window.__rb = { fields, records, L };
  return { b64: btoa(s), conflicts: plan.conflicts.map((c) => c.title), toKp: plan.toKp.map((c) => c.title), addKp: plan.addKp.map((c) => c.title), kpChanged: applied.kpChanged, kpAdded: applied.kpAdded, version: file.version };
}, { b64: readFileSync(join(W, 't.kdbx')).toString('base64'), PW, TOTP });
// all four are "changed on both sides" the first time (the collection was never synced): RegiBase's values fill in what KeePass does not have
ok(r1.kpChanged === 3 && r1.kpAdded === 1, 'RegiBase wrote 3 changed entries and 1 new one (KDBX ' + r1.version + ')', JSON.stringify(r1));
writeFileSync(join(W, 't.kdbx'), Buffer.from(r1.b64, 'base64'));

// ---- KeePassXC reads it
let opened = true; let ls = '';
try { ls = kx(['ls', '-R', '-f', '/w/t.kdbx']); } catch (e) { opened = false; ls = String(e.stderr || e.message); }
ok(opened, 'KeePassXC opens the file RegiBase wrote', ls);
ok(/Bank\/Cards\/Neu/.test(ls), 'the new entry is in the group Bank/Cards', ls);
const sk = kx(['show', '-s', '-a', 'Password', '/w/t.kdbx', 'Bank/Sakura']);
ok(/secret-2-rb/.test(sk), 'the password changed in RegiBase is in KeePassXC', sk);
const neu = kx(['show', '-s', '-a', 'UserName', '-a', 'Password', '/w/t.kdbx', 'Bank/Cards/Neu']);
ok(/nn/.test(neu) && /neu-1/.test(neu), 'and the new entry has its user name and password', neu);
const shop = kx(['show', '-s', '--all', '--show-attachments', '/w/t.kdbx', 'Shop']);
ok(/PIN: 0042/.test(shop), 'the field made in RegiBase (PIN) is an attribute in KeePassXC', shop);
ok(/scan\.txt/.test(shop), 'the attachment KeePassXC added is still there', shop);
const t0 = Date.now(); const code = kx(['show', '-t', '/w/t.kdbx', 'Mail']).trim().split('\n').pop().trim(); const t1 = Date.now();
const ours = await page.evaluate(async ({ TOTP, t0, t1 }) => [(await window.RBPw.totpCode(TOTP, t0)).code, (await window.RBPw.totpCode(TOTP, t1)).code], { TOTP, t0, t1 });
ok(ours.includes(code), 'KeePassXC shows the same one-time password code as RegiBase (' + code + ')', code + ' vs ' + ours.join('/'));
const mail = kx(['show', '-s', '-a', 'Notes', '/w/t.kdbx', 'Mail']);
ok(/line 1/.test(mail), 'what RegiBase did not change stays (notes)', mail);

// ---- KeePassXC changes an entry; the next sync sees it as changed in KeePass only
kx(['edit', '-u', 'taro-kpxc', '/w/t.kdbx', 'Bank/Sakura']);
const r2 = await page.evaluate(async ({ b64, PW }) => {
  const P = window.RBPw; const { fields, records, L } = window.__rb; const u8 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0)).buffer;
  const file = await P.readKdbx(u8(b64), PW, null);
  const plan = P.planSync(fields, records, file, L);
  return { toRb: plan.toRb.filter((x) => !x.idOnly).map((x) => x.title + ':' + x.changed.join('+')), toKp: plan.toKp.map((x) => x.title), conflicts: plan.conflicts.map((x) => x.title), addRb: plan.addRb.length, addKp: plan.addKp.length, same: plan.same };
}, { b64: readFileSync(join(W, 't.kdbx')).toString('base64'), PW });
ok(JSON.stringify(r2.toRb) === '["Sakura:User"]' && !r2.toKp.length && !r2.conflicts.length && !r2.addRb && !r2.addKp && r2.same === 3, 'KeePassXC\'s change is "changed in KeePass", nothing else to do', JSON.stringify(r2));

ok(errs.length === 0, 'no errors in the page', errs.join(' | '));
await b.close();
rmSync(W, { recursive: true, force: true });
console.log(fail ? `\n${fail} FAILED` : '\nALL PASS');
process.exit(fail ? 1 : 0);
