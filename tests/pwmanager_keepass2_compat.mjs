/*
 * Sync with a file the official KeePass 2 writes and reads (KeePass 2 + KPScript under Mono), there and back:
 *   KeePass adds the entries (its own TOTP, TimeOtp-*) → RegiBase imports, changes a password,
 *   changes and adds one-time passwords, adds a record and a field of its own, and syncs →
 *   KeePass opens the file, shows all of it and computes the same one-time password codes
 *   ({TIMEOTP}) → KeePass changes an entry → the next sync sees it as changed in KeePass only.
 * Needs Playwright, Chrome, podman and an image with KeePass 2 and KPScript (KP2_IMAGE, default
 * localhost/kp2-test: debian trixie + keepass2 + KPScript of the same version in /usr/lib/keepass2).
 * Run: node tests/pwmanager_keepass2_compat.mjs
 */
import { chromium } from '/root/editbase-tests/pw.mjs';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const here = dirname(fileURLToPath(import.meta.url)); const js = join(here, '..', 'js');
const W = mkdtempSync(join(process.env.KP2_WORK || tmpdir(), 'kp2-'));
const IMG = process.env.KP2_IMAGE || 'localhost/kp2-test';
const PW = 'kp2-pw-1';
const kp = (cmd, ...args) => execFileSync('podman', ['run', '--rm', '-v', W + ':/w:Z', IMG, 'mono', '/usr/lib/keepass2/KPScript.exe', '-c:' + cmd, '/w/t.kdbx', '-pw:' + PW, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const field = (title, name, spr) => kp('GetEntryString', '-ref-Title:' + title, '-Field:' + name, ...(spr ? ['-Spr'] : [])).split('\n')[0].trim();
let fail = 0;
const ok = (c, m, extra = '') => { console.log((c ? 'PASS  ' : 'FAIL  ') + m + (c ? '' : '  (' + extra + ')')); if (!c) fail++; };

const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const page = await b.newPage();
const errs = []; page.on('pageerror', (e) => errs.push(String(e).slice(0, 200)));
await page.route('http://localhost:8123/**', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>t</title>' }));
await page.goto('http://localhost:8123/');
for (const f of ['vendor/kdbxweb.min.js', 'vendor/argon2.umd.min.js', 'pwmanager.js']) await page.addScriptTag({ content: readFileSync(join(js, f), 'utf8') });
const toB64 = 'const u = new Uint8Array(buf); let s = ""; for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]); return btoa(s);';

// ---- an empty database (KeePass's command line cannot make one), filled by KeePass 2 itself
const empty = await page.evaluate(async (PW) => { const buf = await window.RBPw.writeKdbx([], { password: PW }); const u = new Uint8Array(buf); let s = ''; for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]); return btoa(s); }, PW);
writeFileSync(join(W, 't.kdbx'), Buffer.from(empty, 'base64'));
kp('AddEntry', '-Title:Sakura', '-UserName:taro', '-Password:secret-1', '-GroupPath:Bank');
kp('EditEntry', '-ref-Title:Sakura', '-set-TimeOtp-Secret-Base32:JBSWY3DPEHPK3PXP');
kp('AddEntry', '-Title:Mail', '-UserName:me', '-Password:mail-1', '-Notes:line 1');
kp('AddEntry', '-Title:Shop', '-UserName:u', '-Password:shop-1');
console.log('KeePass ' + (execFileSync('podman', ['run', '--rm', IMG, 'sh', '-c', 'dpkg -s keepass2 | grep Version'], { encoding: 'utf8' }).trim()));

// ---- RegiBase: import, change, sync
const r1 = await page.evaluate(async ({ b64, PW }) => {
  const P = window.RBPw; const u8 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0)).buffer;
  const L = { title: 'Title', group: 'Group', url: 'URL', username: 'User', password: 'Password', totp: 'TOTP', notes: 'Memo', tags: 'Tags', kpid: 'KeePass ID' };
  const file = await P.readKdbx(u8(b64), PW, null);
  const generator = file.db.meta.generator;
  const col = P.toCollection(file.entries, L, {});
  let fields = col.fields.concat([{ key: 'pin', label: 'PIN', type: 'password', secret: true }]);
  const tk = fields.find((x) => x.is_title).key;
  const records = col.records.map((d, i) => ({ id: i + 1, data: { ...d }, updated_at: '2031-01-01T00:00:00.000Z' }));
  const rec = (t) => records.find((x) => x.data[tk] === t);
  rec('Sakura').data.password = 'secret-2-rb';
  rec('Sakura').data.totp = 'otpauth://totp/x?secret=GEZDGNBVGY3TQOJQ&digits=8';
  rec('Mail').data.totp = 'JBSWY3DPEHPK3PXP';
  rec('Shop').data.pin = '0042';
  records.push({ id: 99, data: { [tk]: 'Neu', group: 'Bank/Cards', username: 'nn', password: 'neu-1' }, updated_at: '2031-01-01T00:00:00.000Z' });
  const plan = P.planSync(fields, records, file, L);
  const applied = P.syncApply(plan, {});
  const buf = await P.syncSave(file);
  if (plan.fields) fields = plan.fields;
  const updatedAt = {}; for (const x of records) updatedAt[x.id] = x.updated_at;
  for (const u of applied.update) { const x = records.find((y) => y.id === u.id); x.data = u.data; x.updated_at = '2031-01-02T00:00:00.000Z'; updatedAt[x.id] = x.updated_at; }
  fields = fields.map((x) => x.key === P.UUID_KEY ? { ...x, options: { kdbx: { sync: P.syncStateAfter(applied, updatedAt, []) } } } : x);
  window.__rb = { fields, records, L };
  const u = new Uint8Array(buf); let s = ''; for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
  return { b64: btoa(s), generator, version: file.version, kpChanged: applied.kpChanged, kpAdded: applied.kpAdded };
}, { b64: readFileSync(join(W, 't.kdbx')).toString('base64'), PW });
ok(r1.generator === 'KeePass', 'the file is KeePass 2\'s own (generator "' + r1.generator + '", KDBX ' + r1.version + ')', r1.generator);
ok(r1.kpChanged === 3 && r1.kpAdded === 1, 'RegiBase wrote 3 changed entries and 1 new one', JSON.stringify(r1));
writeFileSync(join(W, 't.kdbx'), Buffer.from(r1.b64, 'base64'));

// ---- KeePass 2 reads it
let list = ''; let opened = true;
try { list = kp('ListEntries'); } catch (e) { opened = false; list = String(e.stdout || '') + String(e.stderr || e.message); }
ok(opened, 'KeePass 2 opens the file RegiBase wrote', list);
ok(/GRPN: Cards[\s\S]*?S: Title = Neu|S: Title = Neu[\s\S]*?GRPN: Cards/.test(list) || /GRPN: Cards/.test(list.split('UUID:').find((x) => /Title = Neu/.test(x)) || ''), 'the new entry is in the group Cards', list.slice(0, 600));
ok(field('Sakura', 'Password') === 'secret-2-rb', 'the password changed in RegiBase is in KeePass 2');
ok(field('Neu', 'Password') === 'neu-1' && field('Neu', 'UserName') === 'nn', 'and the new entry has its user name and password');
ok(field('Shop', 'PIN') === '0042', 'the field made in RegiBase (PIN) is a string field in KeePass 2');
ok(field('Mail', 'Notes') === 'line 1', 'what RegiBase did not change stays (notes)');
ok(field('Mail', 'TimeOtp-Secret-Base32') === 'JBSWY3DPEHPK3PXP', 'a new one-time password is kept the KeePass 2 way (TimeOtp-Secret-Base32)', field('Mail', 'TimeOtp-Secret-Base32'));
ok(field('Sakura', 'TimeOtp-Length') === '8' && field('Sakura', 'TimeOtp-Secret-Base32') === 'GEZDGNBVGY3TQOJQ', 'a changed one stays the KeePass 2 way, 8 digits (TimeOtp-Length)', field('Sakura', 'TimeOtp-Length'));
// KeePass computes the codes itself: {TIMEOTP} in a field, read with placeholders replaced
kp('EditEntry', '-ref-Title:Mail', '-set-Code:{TIMEOTP}');
kp('EditEntry', '-ref-Title:Sakura', '-set-Code:{TIMEOTP}');
for (const [t, spec] of [['Mail', 'JBSWY3DPEHPK3PXP'], ['Sakura', 'otpauth://totp/x?secret=GEZDGNBVGY3TQOJQ&digits=8']]) {
  const t0 = Date.now(); const code = field(t, 'Code', true); const t1 = Date.now();
  const ours = await page.evaluate(async ({ spec, t0, t1 }) => [(await window.RBPw.totpCode(spec, t0)).code, (await window.RBPw.totpCode(spec, t1)).code], { spec, t0, t1 });
  ok(ours.includes(code), 'KeePass 2 computes the same one-time password code as RegiBase for ' + t + ' (' + code + ')', code + ' vs ' + ours.join('/'));
}

// ---- KeePass 2 changes an entry; the next sync sees KeePass's changes only
kp('EditEntry', '-ref-Title:Mail', '-set-UserName:me-kp2');
const r2 = await page.evaluate(async ({ b64, PW }) => {
  const P = window.RBPw; const { fields, records, L } = window.__rb; const u8 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0)).buffer;
  const plan = P.planSync(fields, records, await P.readKdbx(u8(b64), PW, null), L);
  return { toRb: plan.toRb.filter((x) => !x.idOnly).map((x) => x.title + ':' + x.changed.join('+')).sort(), toKp: plan.toKp.length, conflicts: plan.conflicts.length, addRb: plan.addRb.length, addKp: plan.addKp.length };
}, { b64: readFileSync(join(W, 't.kdbx')).toString('base64'), PW });
ok(JSON.stringify(r2.toRb) === JSON.stringify(['Mail:User+Code', 'Sakura:Code']) && !r2.toKp && !r2.conflicts && !r2.addRb && !r2.addKp, 'KeePass 2\'s changes are "changed in KeePass", nothing else', JSON.stringify(r2));

ok(errs.length === 0, 'no errors in the page', errs.join(' | '));
await b.close();
rmSync(W, { recursive: true, force: true });
console.log(fail ? `\n${fail} FAILED` : '\nALL PASS');
process.exit(fail ? 1 : 0);
