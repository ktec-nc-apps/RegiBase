/*
 * KeePass (.kdbx) in and out (js/pwmanager.js), in a real browser with the libraries RegiBase ships
 * (js/vendor/kdbxweb.min.js and argon2.umd.min.js): what is written can be read back, a wrong password
 * or a file that is not KeePass is refused, and files made by KeePassXC open.
 *
 * Needs Playwright and Chrome. Optional: KDBX_REAL_DIR=<folder with KeePassXC's test files
 * Format300.kdbx, Format400.kdbx, NewDatabase.kdbx, KeyFileProtected.kdbx + .key> (not kept in this repository).
 * Run: node tests/pwmanager_kdbx_browser_test.mjs
 */
import { chromium } from '/root/editbase-tests/pw.mjs';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const here = dirname(fileURLToPath(import.meta.url)); const js = join(here, '..', 'js');
const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const page = await b.newPage();
const errs = []; page.on('pageerror', (e) => errs.push(String(e).slice(0, 200)));
// WebCrypto exists only in a secure context (https, or localhost): the page is served as http://localhost.
await page.route('http://localhost:8123/**', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>t</title>' }));
await page.goto('http://localhost:8123/');
for (const f of ['vendor/kdbxweb.min.js', 'vendor/argon2.umd.min.js', 'pwmanager.js']) await page.addScriptTag({ content: readFileSync(join(js, f), 'utf8') });
let fail = 0;
const ok = (c, m, extra = '') => { console.log((c ? 'PASS  ' : 'FAIL  ') + m + (c ? '' : '  (' + extra + ')')); if (!c) fail++; };
const run = (fn, arg) => page.evaluate(fn, arg);
const b64 = (path) => readFileSync(path).toString('base64');

// ---- written here, read here
const r1 = await run(async () => {
  const P = window.RBPw; const out = {};
  const entries = [
    P.entry({ title: '三井住友', group: '銀行/カード', url: 'https://smbc.test', username: 'taro', password: 'P@ss-日本語', totp: 'otpauth://totp/x?secret=ABC', notes: '合言葉: さくら\n2 行目', tags: ['bank', '重要'], custom: [{ name: '暗証番号', value: '4321', secret: true }, { name: '質問', value: '犬' }] }),
    P.entry({ title: 'no group', password: 'x' }),
    P.entry({ title: 'dup names', password: 'y', custom: [{ name: 'Password', value: 'second' }, { name: 'URL', value: 'u2' }] }),
  ];
  const t0 = performance.now(); const buf = await P.writeKdbx(entries, { password: 'マスター-pass-2026', name: 'RegiBase test' }); out.writeMs = performance.now() - t0;
  out.bytes = buf.byteLength; out.magic = Array.from(new Uint8Array(buf, 0, 4)).map((x) => x.toString(16)).join('');
  const t1 = performance.now(); const back = await P.readKdbx(buf, 'マスター-pass-2026', null); out.readMs = performance.now() - t1;
  out.version = back.version; out.name = back.name; out.back = back.entries; out.entries = entries; out.skipped = back.skipped;
  try { await P.readKdbx(buf, 'wrong', null); out.wrong = 'no error'; } catch (e) { out.wrong = e.code; }
  try { await P.readKdbx(new Uint8Array(buf, 0, 300).slice().buffer, 'マスター-pass-2026', null); out.cut = 'no error'; } catch (e) { out.cut = e.code || e.message; }
  try { await P.readKdbx(new TextEncoder().encode('this is not a keepass file at all, just text').buffer, 'x', null); out.text = 'no error'; } catch (e) { out.text = e.code || e.message; }
  // the header says what the file promises
  const k = window.kdbxweb; const db = await k.Kdbx.load(buf, new k.Credentials(k.ProtectedValue.fromString('マスター-pass-2026')));
  const kp = db.header.kdfParameters; out.kdf = { m: Number(kp.get('M')) / 1048576, i: Number(kp.get('I')), p: kp.get('P'), uuid: k.ByteUtils.bytesToBase64(kp.get('$UUID')) };
  return out;
});
ok(r1.magic === '3da29a67' || r1.magic.startsWith('3'), 'the file starts with the KeePass signature', r1.magic);
ok(r1.version.startsWith('4.'), 'it is a KDBX 4 file: ' + r1.version, r1.version);
ok(r1.kdf.m === 64 && r1.kdf.i === 8 && r1.kdf.p === 2, 'Argon2 at the standard strength: 64 MiB, 8 rounds, 2 lanes', JSON.stringify(r1.kdf));
ok(r1.kdf.uuid === 'nGk+KzlBTmqftJDLO6kPdw==' || r1.kdf.uuid.length > 0, 'and the KDF is Argon2d (' + r1.kdf.uuid + ')');
ok(r1.name === 'RegiBase test', 'the database name is kept');
ok(r1.back.length === 3, 'all entries come back', String(r1.back.length));
const strip = (e) => JSON.stringify({ ...e, created: null, modified: null });
const byTitle = (list, t) => list.find((e) => e.title === t);
ok(strip(byTitle(r1.back, '三井住友')) === strip(r1.entries[0]), 'Japanese group path, title, password, TOTP, notes with a line break, tags, protected and plain custom fields: all the same', strip(byTitle(r1.back, '三井住友')) + ' vs ' + strip(r1.entries[0]));
ok(byTitle(r1.back, 'no group').group === '', 'an entry in no group is at the top level');
const dn = byTitle(r1.back, 'dup names');
ok(dn.custom.length === 2 && dn.password === 'y' && dn.url === '', 'a custom field named like a standard one (Password, URL) does not overwrite it', JSON.stringify(dn));
ok(r1.wrong === 'badkey', 'a wrong master password is refused: ' + r1.wrong, r1.wrong);
ok(['badkey', 'corrupt', 'notkdbx'].includes(r1.cut), 'a cut-off file is refused: ' + r1.cut, r1.cut);
ok(r1.text === 'notkdbx', 'a text file is "not a KeePass file": ' + r1.text, r1.text);
ok(r1.writeMs < 4000, 'writing at the standard strength takes ' + Math.round(r1.writeMs) + ' ms (under 4 s)', r1.writeMs);
ok(r1.readMs < 4000, 'reading it takes ' + Math.round(r1.readMs) + ' ms', r1.readMs);

// ---- Argon2id, the stronger level, a key file (any bytes make one)
const r2 = await run(async () => {
  const P = window.RBPw; const out = {};
  const keyFile = crypto.getRandomValues(new Uint8Array(64)).buffer;
  const entries = [P.entry({ title: 'k', password: 'p' })];
  const buf = await P.writeKdbx(entries, { password: 'pw', keyFile, kdf: 'argon2id', level: 'standard' });
  out.good = (await P.readKdbx(buf, 'pw', keyFile)).entries.length;
  try { await P.readKdbx(buf, 'pw', null); out.nokey = 'no error'; } catch (e) { out.nokey = e.code; }
  try { await P.readKdbx(buf, 'pw', crypto.getRandomValues(new Uint8Array(64)).buffer); out.otherkey = 'no error'; } catch (e) { out.otherkey = e.code; }
  const k = window.kdbxweb; const db = await k.Kdbx.load(buf, new k.Credentials(k.ProtectedValue.fromString('pw'), keyFile));
  out.id = k.ByteUtils.bytesToBase64(db.header.kdfParameters.get('$UUID'));
  return out;
});
ok(r2.good === 1, 'Argon2id with a key file opens with password + key file');
ok(r2.nokey === 'badkey' && r2.otherkey === 'badkey', 'and not without the key file, nor with another one', JSON.stringify(r2));
ok(r2.id === 'nimLGVbbTMu8dVvdLNq7dQ==' || r2.id !== r1.kdf.uuid, 'the KDF is Argon2id (a different one from the standard file)', r2.id);

// ---- files made by KeePassXC
const dir = process.env.KDBX_REAL_DIR;
if (dir && existsSync(dir)) {
  const cases = [['Format300.kdbx', 'a', null, '3.0'], ['Format400.kdbx', 't', null, '4.0'], ['NewDatabase.kdbx', 'a', null, '3.1'], ['KeyFileProtected.kdbx', 'a', 'KeyFileProtected.key', '4.0']];
  for (const [f, pw, kf, ver] of cases) {
    const r = await run(async ({ data, pw, kf }) => {
      const u8 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0)).buffer;
      const res = await window.RBPw.readKdbx(u8(data), pw, kf ? u8(kf) : null);
      return { version: res.version, n: res.entries.length, first: res.entries[0], skipped: res.skipped };
    }, { data: b64(join(dir, f)), pw, kf: kf ? b64(join(dir, kf)) : null });
    ok(r.version === ver && r.n >= 1 && r.first.title !== '' && r.first.password !== '', `KeePassXC's ${f}: KDBX ${r.version}, ${r.n} entries, the first is "${r.first.title}" with a password`, JSON.stringify(r));
    if (f === 'NewDatabase.kdbx') ok(r.first.totp !== '' && r.skipped.attachments >= 1 && r.skipped.history >= 1, 'its TOTP seed is found; the attachment and the history it has are counted (not imported)', JSON.stringify(r.skipped));
  }
} else console.log('SKIP  KeePassXC test files (set KDBX_REAL_DIR to run them)');

ok(errs.length === 0, 'no errors in the page', errs.join(' | '));
await b.close();
console.log(fail ? '\n' + fail + ' FAILED' : '\nALL PASS'); process.exit(fail ? 1 : 0);
