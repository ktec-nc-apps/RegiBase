/*
 * Passwords in and out, through the real screens of RegiBase in a real Nextcloud (js/pwmanager.js + the dialogs):
 *   - the page loads the KeePass parts and its policy allows WebAssembly;
 *   - a KeePass file, a Bitwarden JSON and a LastPass CSV are imported through the dialog, with and without a master key;
 *   - with a master key the secret fields are stored encrypted and open again with it; nothing secret reaches the server in plain;
 *   - a collection is exported as .kdbx through the dialog and the file opens with the password chosen, and not with a wrong one;
 *   - what is exported can be imported again (a round trip).
 * Needs a Nextcloud with RegiBase, a user who may use it, Playwright and Chrome.
 * Run: USER_=name PASS_=password URL_=http://host node tests/pwmanager_ui_e2e.mjs
 */
import { chromium } from '/root/editbase-tests/pw.mjs';
const { USER_, PASS_, URL_ } = process.env;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox', '--disable-dev-shm-usage', ...(/^http:/.test(URL_ || '') ? ['--unsafely-treat-insecure-origin-as-secure=' + new URL(URL_).origin] : [])] });  // WebCrypto needs https or localhost; a plain-http test server is treated as secure for the test
const ctx = await b.newContext({ viewport: { width: 1300, height: 950 }, ignoreHTTPSErrors: true, acceptDownloads: true });
const page = await ctx.newPage();
const errs = []; page.on('pageerror', (e) => errs.push(String(e).slice(0, 200)));
const vm = (src, arg) => page.evaluate(async ({ src, arg }) => { const el = document.querySelector('#regibase-root'); const p = (el.__vue_app__._instance || el.__vue_app__._container._vnode.component).proxy; return await (new Function('vm', 'arg', 'return (async () => {' + src + '})();'))(p, arg); }, { src, arg });
let bad = 0; const ok = (c, m, extra = '') => { console.log((c ? 'ok   ' : 'FAIL ') + m + (c ? '' : '  (' + extra + ')')); if (!c) bad++; };
const api = (path, opts) => page.evaluate(async ({ path, opts }) => { const r = await fetch(OC.generateUrl('/apps/regibase/api/' + path), { headers: { 'Content-Type': 'application/json', requesttoken: OC.requestToken }, credentials: 'same-origin', ...(opts || {}) }); return r.json(); }, { path, opts });
const closeNoise = async () => { for (let i = 0; i < 3; i++) { await page.keyboard.press('Escape'); await sleep(150); } };

// ---- log in, open RegiBase
await page.goto(URL_ + '/login'); await page.fill('#user', USER_); await page.fill('#password', PASS_); await page.click('button[type=submit]'); await sleep(2500);
const resp = await page.goto(URL_ + '/apps/regibase/');
const csp = (resp.headers()['content-security-policy'] || '');
ok(/script-src[^;]*'wasm-unsafe-eval'/.test(csp), 'the page policy allows WebAssembly (and no eval of text)', csp.split(';').filter((x) => /script-src/.test(x)).join(' | '));
ok(!/script-src[^;]*'unsafe-eval'/.test(csp), 'but not unsafe-eval');
for (let i = 0; i < 50; i++) { await sleep(400); if (await vm('return !!(vm && vm.collections);').catch(() => false)) break; }
const libs = await page.evaluate(() => ({ rb: typeof window.RBPw, kd: typeof window.kdbxweb, hw: typeof (window.hashwasm || {}).argon2d, wasm: typeof WebAssembly }));
ok(libs.rb === 'object' && libs.kd === 'object' && libs.hw === 'function', 'the KeePass parts are loaded in the page', JSON.stringify(libs));
// the existing collections are not touched by this test; what it makes is removed at the end
const before = (await api('collections')).map((c) => c.id);

// ---- some files, made here
const mk = await page.evaluate(async () => {
  const P = window.RBPw; const b64 = (buf) => { let s = ''; const u = new Uint8Array(buf); for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]); return btoa(s); };
  const entries = [
    P.entry({ title: '三井住友', group: '銀行/カード', url: 'https://smbc.test', username: 'taro', password: 'P@ss-日本語-1', totp: 'otpauth://totp/x?secret=ABC', notes: '合言葉: さくら\n2 行目', tags: ['bank'], custom: [{ name: '暗証番号', value: '4321', secret: true }, { name: '質問', value: '犬' }] }),
    P.entry({ title: 'Mail', url: 'https://mail.test', username: 'me@mail.test', password: 'secret-mail-2' }),
    P.entry({ title: 'no password', url: 'https://x.test', notes: 'only a note' }),
  ];
  const kdbx = await P.writeKdbx(entries, { password: 'KeePass-pw-1', name: 'My KeePass' });
  const bw = JSON.stringify({ encrypted: false, folders: [{ id: 'f1', name: 'Work' }], items: [{ id: '1', folderId: 'f1', type: 1, name: 'GitHub', notes: 'n', login: { uris: [{ uri: 'https://github.com' }], username: 'me', password: 'gh-pass-3', totp: 'SEED' }, fields: [{ name: 'pin', value: '1234', type: 1 }] }] });
  const lp = 'url,username,password,totp,extra,name,grouping,fav\nhttps://shop.test,u,lp-pass-4,,memo,Shop,Shopping,0\n';
  return { kdbx: b64(kdbx), bw, lp };
});
const file = (name, data, mime = 'application/octet-stream') => ({ name, mimeType: mime, buffer: typeof data === 'string' && !/^[A-Za-z0-9+/=]+$/.test(data) ? Buffer.from(data, 'utf8') : (name.endsWith('.kdbx') ? Buffer.from(data, 'base64') : Buffer.from(data, 'utf8')) });
async function importFile(name, data, password, collName) {
  await vm('vm.openPwImport(); return 1;'); await sleep(300);
  if (!(await page.locator('.modal-mask input[type=file]').count())) { console.log('DEBUG modal:', JSON.stringify(await vm('return vm.modal;')), 'visible masks:', await page.locator('.modal-mask').count()); await page.screenshot({ path: '/tmp/claude-0/-root/d8ad6c84-ef95-4ebb-8d49-eea72ad535b4/scratchpad/rb-e2e-debug.png' }); }
  await page.locator('.modal-mask input[type=file]').first().setInputFiles(file(name, data));
  await sleep(300);
  if (password != null) await page.locator('.modal-mask input[type=password]').first().fill(password);
  await page.locator('.modal-mask .btn.primary', { hasText: /Open|開く/ }).first().click();
  for (let i = 0; i < 80; i++) { await sleep(250); if ((await vm('return vm.pw.step;')) === 2 || (await vm('return vm.pw.err;'))) break; }
  const st = await vm('return { step: vm.pw.step, err: vm.pw.err, n: vm.pw.result ? vm.pw.result.entries.length : 0, label: vm.pw.result ? vm.pw.result.label : "", notes: vm.pw.notes };');
  if (st.step !== 2) return { st };
  if (collName) await vm('vm.pw.collName = arg; return 1;', collName);
  await page.locator('.modal-mask .btn.primary', { hasText: /Import \d+ entr|取り込む|Import/ }).last().click();
  for (let i = 0; i < 120; i++) { await sleep(250); if (!(await vm('return !!(vm.modal && vm.modal.type === "pwimport");'))) break; }
  return { st, modalGone: !(await vm('return !!(vm.modal && vm.modal.type === "pwimport");')), err: await vm('return vm.pw.err;') };
}
const collByName = async (name) => (await api('collections')).find((c) => c.name === name);
const recordsOf = async (id) => api('collections/' + id + '/records');

// ---- A. no master key yet: a wrong password is refused, the right one imports
let r = await importFile('my.kdbx', mk.kdbx, 'wrong-password', 'KP plain');
ok(r.st.step === 1 && /not right|damaged|違/.test(r.st.err), 'a wrong KeePass password is refused in the dialog: ' + r.st.err, JSON.stringify(r.st));
await vm('vm.pw.password = arg; return 1;', 'KeePass-pw-1');
await page.locator('.modal-mask .btn.primary', { hasText: /Open|開く/ }).first().click();
for (let i = 0; i < 80; i++) { await sleep(250); if ((await vm('return vm.pw.step;')) === 2) break; }
ok((await vm('return vm.pw.step;')) === 2, 'the right one opens it');
ok((await vm('return vm.pw.result.entries.length;')) === 3 && (await vm('return vm.pw.collName;')) === 'My KeePass', 'three entries; the collection is named after the database');
await vm('vm.pw.collName = "KP plain"; return 1;');
await page.locator('.modal-mask .btn.primary').last().click();
for (let i = 0; i < 120; i++) { await sleep(250); if (!(await vm('return !!(vm.modal && vm.modal.type === "pwimport");'))) break; }
let c1 = await collByName('KP plain'); ok(!!c1, 'the collection is made');
let recs = c1 ? await recordsOf(c1.id) : [];
ok(recs.length === 3, 'three records saved', String(recs.length));
const smbc = recs.find((x) => x.data.title === '三井住友');
ok(smbc && smbc.data.password === 'P@ss-日本語-1' && smbc.data.group === '銀行/カード' && smbc.data.username === 'taro', 'fields land where they belong (title, group, user, password)', JSON.stringify(smbc && smbc.data));
ok(smbc && smbc.data.c1 === '4321' && smbc.data.c2 === '犬' && smbc.data.totp.startsWith('otpauth'), 'extra fields and the one-time password come along', JSON.stringify(smbc && smbc.data));
const f1 = c1 ? (await api('collections/' + c1.id)).fields : []; const fk = Object.fromEntries(f1.map((f) => [f.key, f]));
ok(fk.password && fk.password.secret && fk.password.type === 'password' && fk.c1.secret && !fk.c2.secret && fk.title.is_title, 'secret fields are marked secret, the title is the emphasis field');

// ---- B. a master key: nothing secret goes to the server in plain
await vm('vm.encForm.next = vm.encForm.next2 = arg; await vm.enableEncryption(); return 1;', 'Master-key-2026');
ok(await vm('return vm.enc.enabled && vm.enc.unlocked;'), 'a master key is set');
r = await importFile('my.kdbx', mk.kdbx, 'KeePass-pw-1', 'KP encrypted');
ok(r.modalGone, 'the import with a master key finishes', JSON.stringify(r));
const c2 = await collByName('KP encrypted'); recs = c2 ? await recordsOf(c2.id) : [];
const sm2 = recs.find((x) => x.data.title === '三井住友');
ok(sm2 && sm2.data.password.startsWith('rbenc1:') && sm2.data.c1.startsWith('rbenc1:') && sm2.data.totp.startsWith('rbenc1:'), 'password, the secret extra field and the one-time password are stored encrypted', JSON.stringify(sm2 && sm2.data).slice(0, 200));
ok(sm2 && sm2.data.username === 'taro' && sm2.data.title === '三井住友', 'what is not secret stays readable');
const plainAll = JSON.stringify(recs);
ok(!/P@ss-日本語|secret-mail-2|4321/.test(plainAll), 'no secret value appears in plain in what the server holds');
await vm('await vm.selectCollection(arg); return 1;', c2.id); await sleep(600);
const back = await vm('const out = []; for (const rec of vm.records) { out.push(rec.data.password ? await vm.secretPlain(rec.data.password) : ""); } return out;');
ok(back.includes('P@ss-日本語-1') && back.includes('secret-mail-2'), 'and they open again with the master key', JSON.stringify(back));

// ---- C. other managers
r = await importFile('bitwarden.json', mk.bw, null, 'From Bitwarden');
const c3 = await collByName('From Bitwarden'); recs = c3 ? await recordsOf(c3.id) : [];
ok(r.st.label === 'Bitwarden (JSON)' && recs.length === 1 && recs[0].data.group === 'Work' && recs[0].data.password.startsWith('rbenc1:'), 'a Bitwarden JSON: group from the folder, password encrypted', JSON.stringify(r.st) + JSON.stringify(recs[0] && recs[0].data).slice(0, 150));
r = await importFile('lastpass.csv', mk.lp, null, 'From LastPass');
const c4 = await collByName('From LastPass'); recs = c4 ? await recordsOf(c4.id) : [];
ok(r.st.label === 'LastPass (CSV)' && recs.length === 1 && recs[0].data.title === 'Shop' && recs[0].data.group === 'Shopping', 'a LastPass CSV', JSON.stringify(r.st));
r = await importFile('other.csv', 'a,b,c\n1,2,3\n', null, 'x');
ok(r.st.step === 1 && /not in a format/.test(r.st.err), 'a CSV of no known manager is declined with a pointer to the other import: ' + r.st.err, JSON.stringify(r.st));
await vm('vm.closePwImport(); return 1;');

// ---- D. out: the collection as .kdbx
await vm('const c = vm.collections.find((x) => x.id === arg); await vm.selectCollection(arg); return 1;', c2.id); await sleep(800);
await vm('vm.openPwExport(); return 1;'); await sleep(300);
ok(await vm('return vm.modal && vm.modal.type === "pwexport";'), 'the export dialog opens');
await vm('vm.pwx.password = "short"; vm.pwx.password2 = "other"; await vm.commitPwExport(); return 1;');
ok(/not the same/.test(await vm('return vm.pwx.err;')), 'two different passwords are refused: ' + (await vm('return vm.pwx.err;')));
await vm('vm.pwx.password = vm.pwx.password2 = "Export-pass-2026"; return 1;');
page.on('dialog', (d) => d.accept());
const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), page.locator('.modal-mask .btn.primary', { hasText: /Make the file|ファイル/ }).click()]);
const outPath = '/tmp/claude-0/-root/d8ad6c84-ef95-4ebb-8d49-eea72ad535b4/scratchpad/rb-export-test.kdbx'; await dl.saveAs(outPath);
ok(/\.kdbx$/.test(dl.suggestedFilename()), 'a .kdbx file is downloaded: ' + dl.suggestedFilename());
import { readFileSync, unlinkSync } from 'node:fs';
const data = readFileSync(outPath).toString('base64'); try { unlinkSync(outPath); } catch (e) { /* kept */ }
const opened = await page.evaluate(async (d) => {
  const u = Uint8Array.from(atob(d), (c) => c.charCodeAt(0)).buffer; const out = {};
  try { await window.RBPw.readKdbx(u.slice(0), 'wrong', null); out.wrong = 'opened'; } catch (e) { out.wrong = e.code; }
  const res = await window.RBPw.readKdbx(u.slice(0), 'Export-pass-2026', null); out.n = res.entries.length; out.entries = res.entries; out.version = res.version; return out;
}, data);
ok(opened.wrong === 'badkey', 'the file does not open with a wrong password');
ok(opened.n === 3 && opened.version.startsWith('4.'), 'it opens with the chosen one: 3 entries, KDBX ' + opened.version);
const sm = opened.entries.find((e) => e.title === '三井住友');
ok(sm && sm.password === 'P@ss-日本語-1' && sm.group === '銀行/カード' && sm.username === 'taro' && sm.totp.startsWith('otpauth') && sm.notes === '合言葉: さくら\n2 行目' && sm.tags.includes('bank'),
  'the secret fields were decrypted into it, and the rest is as it was (title, group, user, notes, tags, TOTP)', JSON.stringify(sm));
ok(sm.custom.some((x) => x.name === '暗証番号' && x.value === '4321' && x.secret) && sm.custom.some((x) => x.name === '質問' && x.value === '犬' && !x.secret), 'extra fields keep their name, value and whether they are protected');

// ---- E. round trip: the exported file imported again
r = await importFile('roundtrip.kdbx', data, 'Export-pass-2026', 'Round trip');
const c5 = await collByName('Round trip'); recs = c5 ? await recordsOf(c5.id) : [];
ok(recs.length === 3, 'the exported file imports again: ' + recs.length + ' records', JSON.stringify(r.st));

// ---- clean up what this test made
for (const c of await api('collections')) if (!before.includes(c.id)) await api('collections/' + c.id, { method: 'DELETE' });
await vm('const k = vm.enc; return 1;');
ok(errs.length === 0, 'no errors in the page', errs.join(' | '));
console.log('note: the master key set by this test stays on the user (' + USER_ + '): use a user that is only for tests.');
await b.close(); console.log(bad ? '\n' + bad + ' FAILED' : '\nALL OK'); process.exit(bad ? 1 : 0);
