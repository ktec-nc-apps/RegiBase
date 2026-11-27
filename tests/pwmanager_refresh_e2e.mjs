/*
 * KeePass file kept in Nextcloud, through the real screens of RegiBase in a real Nextcloud (0.24.0):
 *   - a .kdbx in the user's Files is chosen in the app's own file picker and imported;
 *     the collection keeps each entry's KeePass ID and where the file is;
 *   - the file is changed in "KeePass" (an entry renamed and moved and its password changed,
 *     one removed, one added), and "Refresh from KeePass file" brings exactly that in:
 *     the renamed one is the same record (not a new one), a record made in RegiBase is left alone,
 *     the removed one is deleted only when asked;
 *   - with a master key, the refreshed secret values are stored encrypted;
 *   - the code of a one-time password (TOTP) is shown next to the field of the open record;
 *   - the KeePass file itself is never written to.
 * Needs a Nextcloud with RegiBase, a user who may use it (only for tests: a master key is set), Playwright and Chrome.
 * Run: USER_=name PASS_=password URL_=http://host node tests/pwmanager_refresh_e2e.mjs
 */
import { chromium } from '/root/editbase-tests/pw.mjs';
const { USER_, PASS_, URL_ } = process.env;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox', '--disable-dev-shm-usage', ...(/^http:/.test(URL_ || '') ? ['--unsafely-treat-insecure-origin-as-secure=' + new URL(URL_).origin] : [])] });
const ctx = await b.newContext({ viewport: { width: 1300, height: 950 }, ignoreHTTPSErrors: true });
const page = await ctx.newPage();
const errs = []; page.on('pageerror', (e) => errs.push(String(e).slice(0, 200)));
const vm = (src, arg) => page.evaluate(async ({ src, arg }) => { const el = document.querySelector('#regibase-root'); const p = (el.__vue_app__._instance || el.__vue_app__._container._vnode.component).proxy; return await (new Function('vm', 'arg', 'return (async () => {' + src + '})();'))(p, arg); }, { src, arg });
let bad = 0; const ok = (c, m, extra = '') => { console.log((c ? 'ok   ' : 'FAIL ') + m + (c ? '' : '  (' + extra + ')')); if (!c) bad++; };
const api = (path, opts) => page.evaluate(async ({ path, opts }) => { const r = await fetch(OC.generateUrl('/apps/regibase/api/' + path), { headers: { 'Content-Type': 'application/json', requesttoken: OC.requestToken }, credentials: 'same-origin', ...(opts || {}) }); return r.json(); }, { path, opts });
// the user's Files, through WebDAV
const dav = (method, path, b64) => page.evaluate(async ({ method, path, b64, user }) => {
  const body = b64 ? Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)) : undefined;
  const r = await fetch(OC.linkToRemote('dav') + '/files/' + user + '/' + path, { method, body, headers: { requesttoken: OC.requestToken }, credentials: 'same-origin' });
  if (method !== 'GET') return { status: r.status, etag: r.headers.get('ETag') };
  const u = new Uint8Array(await r.arrayBuffer()); let s = ''; for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
  return { status: r.status, etag: r.headers.get('ETag'), b64: btoa(s) };
}, { method, path, b64, user: USER_ });

await page.goto(URL_ + '/login'); await page.fill('#user', USER_); await page.fill('#password', PASS_); await page.click('button[type=submit]'); await sleep(2500);
await page.goto(URL_ + '/apps/regibase/');
for (let i = 0; i < 50; i++) { await sleep(400); if (await vm('return !!(vm && vm.collections);').catch(() => false)) break; }
const before = (await api('collections')).map((c) => c.id);
await vm('vm.encForm.next = vm.encForm.next2 = arg; await vm.enableEncryption(); return 1;', 'Master-key-2026');
ok(await vm('return vm.enc.enabled && vm.enc.unlocked;'), 'a master key is set (the refreshed passwords must be stored encrypted)');

// ---- a KeePass database, made with the KeePass library itself (so the entries have real KeePass IDs)
const KP = 'KeePass-pw-1';
const made = await page.evaluate(async (pw) => {
  const k = window.kdbxweb; window.RBPw.parseTotp('JBSWY3DP'); // loads nothing; just checks the module is there
  await window.RBPw.writeKdbx([window.RBPw.entry({ title: 'x' })], { password: pw }); // sets up Argon2 for kdbxweb
  const db = k.Kdbx.create(new k.Credentials(k.ProtectedValue.fromString(pw)), 'Family vault');
  db.setVersion(4); db.setKdf(k.Consts.KdfId.Argon2d);
  const VT = k.VarDictionary.ValueType; db.header.kdfParameters.set('M', VT.UInt64, new k.Int64(8 * 1024 * 1024)); db.header.kdfParameters.set('I', VT.UInt64, new k.Int64(2));
  const root = db.getDefaultGroup(); const bank = db.createGroup(root, 'Bank');
  const add = (g, title, user, pass, more) => { const e = db.createEntry(g); e.fields.set('Title', title); e.fields.set('UserName', user); e.fields.set('Password', k.ProtectedValue.fromString(pass)); for (const [n, v] of Object.entries(more || {})) e.fields.set(n, v); return e; };
  add(bank, 'Sakura Bank', 'taro', 'old-pass-1', { 'TimeOtp-Secret-Base32': k.ProtectedValue.fromString('JBSWY3DPEHPK3PXP') });
  add(root, 'Mail', 'me@mail.test', 'mail-pass-2');
  add(root, 'Old shop', 'u', 'shop-pass-3');
  const buf = await db.save(); const u = new Uint8Array(buf); let s = ''; for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
  return btoa(s);
}, KP);
await dav('MKCOL', 'Vault');
const put1 = await dav('PUT', 'Vault/family.kdbx', made);
ok(put1.status === 201 || put1.status === 204, 'the .kdbx is put into the user\'s Files (Vault/family.kdbx)', String(put1.status));

// ---- import it through the app's own file picker
await vm('vm.openPwImport(); return 1;'); await sleep(300);
await page.locator('.modal-mask .btn', { hasText: /Choose from Nextcloud|Nextcloud から/ }).first().click();
for (let i = 0; i < 40; i++) { await sleep(200); if (await vm('return vm.filePicker.open && !vm.filePicker.loading;')) break; }
await vm('vm.fpClick(vm.filePicker.entries.find((x) => x.name === "Vault")); return 1;');   // as a click on the folder does
for (let i = 0; i < 40; i++) { await sleep(200); if (await vm('return vm.filePicker.path === "Vault" && !vm.filePicker.loading;')) break; }
const listed = await vm('return vm.filePicker.entries.map((x) => x.name + ":" + vm.fpSelectable(x));');
ok(listed.includes('family.kdbx:true'), 'the picker offers the .kdbx file', JSON.stringify(listed));
await vm('vm.filePicker.selected = vm.filePicker.entries.find((x) => x.name === "family.kdbx"); await vm.fpConfirm(); return 1;');
for (let i = 0; i < 40; i++) { await sleep(200); if (await vm('return !vm.pw.busy && !!vm.pw.file;')) break; }
ok(await vm('return vm.pw.ncPath === "Vault/family.kdbx" && vm.pw.isKdbx && vm.pw.file instanceof ArrayBuffer;'), 'it is read from Nextcloud into the dialog', JSON.stringify(await vm('return { p: vm.pw.ncPath, k: vm.pw.isKdbx, e: vm.pw.err };')));
await page.locator('.modal-mask input[type=password]').first().fill(KP);
await page.locator('.modal-mask .btn.primary', { hasText: /Open|開く/ }).first().click();
for (let i = 0; i < 80; i++) { await sleep(250); if ((await vm('return vm.pw.step;')) === 2 || (await vm('return vm.pw.err;'))) break; }
ok((await vm('return vm.pw.step;')) === 2, 'it opens', await vm('return vm.pw.err;'));
await vm('vm.pw.collName = "KP refresh test"; return 1;');
await page.locator('.modal-mask .btn.primary').last().click();
for (let i = 0; i < 120; i++) { await sleep(250); if (!(await vm('return !!(vm.modal && vm.modal.type === "pwimport");'))) break; }
const coll = (await api('collections')).find((c) => c.name === 'KP refresh test');
ok(!!coll, 'the collection is made');
const fields = (await api('collections/' + coll.id)).fields; const kf = fields.find((f) => f.key === 'kp_uuid');
ok(kf && kf.list_show === false && kf.table_show === false && kf.card_show === false, 'it has the KeePass ID field, hidden from the list, table and cards', JSON.stringify(kf));
ok(kf && kf.options && kf.options.kdbx && kf.options.kdbx.path === 'Vault/family.kdbx', 'and remembers where the file is', JSON.stringify(kf && kf.options));
let recs = await api('collections/' + coll.id + '/records');
ok(recs.length === 3 && recs.every((r) => /^[A-Za-z0-9+/=]{20,}$/.test(r.data.kp_uuid || '')), 'three records, each with its KeePass ID', JSON.stringify(recs.map((r) => r.data.kp_uuid)));
const sakura = recs.find((r) => r.data.title === 'Sakura Bank');
ok(sakura && String(sakura.data.totp).startsWith('rbenc1:'), 'KeePass 2\'s own one-time password (TimeOtp-Secret-Base32) comes in, encrypted');
// a record made by hand in RegiBase: the refresh must leave it alone
await api('collections/' + coll.id + '/records', { method: 'POST', body: JSON.stringify({ data: { title: 'Made in RegiBase', username: 'mine' } }) });

// ---- the TOTP code next to the field of the open record
await vm('await vm.selectCollection(arg); return 1;', coll.id); await sleep(800);
await vm('const r = vm.records.find((x) => x.data.title === "Sakura Bank"); vm.openRecord(r); return 1;');
for (let i = 0; i < 20; i++) { await sleep(250); if (await vm('return !!vm.totpNow.totp;')) break; }
const shown = await vm('return vm.totpNow.totp || null;');
const expect = await page.evaluate(async () => (await window.RBPw.totpCode('JBSWY3DPEHPK3PXP')).code);
ok(shown && /^\d{6}$/.test(shown.code) && shown.code === expect, 'the code for now is shown next to the one-time password field: ' + (shown && shown.code), JSON.stringify(shown));
ok(await page.locator('.modal-mask .totp-now').count() === 1, 'and it is on the screen');
await vm('vm.modal = null; return 1;'); await sleep(300);
await sleep(1300);
ok(await vm('return !Object.keys(vm.totpNow).length;'), 'closing the record stops the code');

// ---- change the file "in KeePass": rename + move + new password, remove one, add one
const mod = await page.evaluate(async ({ b64, pw }) => {
  const k = window.kdbxweb; const data = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)).buffer;
  const db = await k.Kdbx.load(data, new k.Credentials(k.ProtectedValue.fromString(pw)));
  const all = []; (function walk(g) { g.entries.forEach((e) => all.push(e)); g.groups.forEach(walk); })(db.getDefaultGroup());
  const by = (t) => all.find((e) => e.fields.get('Title') === t);
  const s = by('Sakura Bank'); s.fields.set('Title', 'Sakura Bank (main)'); s.fields.set('Password', k.ProtectedValue.fromString('new-pass-9')); s.times.update();
  db.move(s, db.createGroup(db.getDefaultGroup(), 'Money'));
  const old = by('Old shop'); old.parentGroup.entries.splice(old.parentGroup.entries.indexOf(old), 1);
  const n = db.createEntry(db.getDefaultGroup()); n.fields.set('Title', 'New shop'); n.fields.set('UserName', 'new'); n.fields.set('Password', k.ProtectedValue.fromString('new-shop-4'));
  const buf = await db.save(); const u = new Uint8Array(buf); let str = ''; for (let i = 0; i < u.length; i++) str += String.fromCharCode(u[i]);
  return btoa(str);
}, { b64: made, pw: KP });
await dav('PUT', 'Vault/family.kdbx', mod);
const etagBefore = (await dav('GET', 'Vault/family.kdbx')).etag;

// ---- refresh
await vm('await vm.selectCollection(arg); return 1;', coll.id); await sleep(600);
ok(await vm('return vm.pwRefreshable && vm.kdbxPath === "Vault/family.kdbx";'), 'the collection offers "Refresh from KeePass file", with the remembered file');
await vm('vm.openPwRefresh(); return 1;'); await sleep(300);
ok(await vm('return vm.modal && vm.modal.type === "pwrefresh" && vm.pwr.ncPath === "Vault/family.kdbx" && vm.pwr.isKdbx;'), 'the dialog starts with that file');
await page.locator('.modal-mask input[type=password]').first().fill('wrong');
await page.locator('.modal-mask .btn.primary', { hasText: /Compare|比べる|比較/ }).first().click();
for (let i = 0; i < 80; i++) { await sleep(250); if (await vm('return !vm.pwr.busy && (vm.pwr.err || vm.pwr.step === 2);')) break; }
ok(await vm('return vm.pwr.step === 1 && /not right|damaged/.test(vm.pwr.err);'), 'a wrong password is refused: ' + (await vm('return vm.pwr.err;')));
await page.locator('.modal-mask input[type=password]').first().fill(KP);
await page.locator('.modal-mask .btn.primary', { hasText: /Compare|比べる|比較/ }).first().click();
for (let i = 0; i < 80; i++) { await sleep(250); if (await vm('return !vm.pwr.busy && (vm.pwr.step === 2 || !!vm.pwr.err);')) break; }
const plan = await vm('const p = vm.pwr.plan; return p ? { add: p.add.length, upd: p.update.map((u) => u.title + ":" + u.changed.join("|")), same: p.same, gone: p.gone.map((g) => g.title), err: vm.pwr.err } : { err: vm.pwr.err };');
ok(plan.add === 1 && plan.same === 1 && plan.upd.length === 1 && JSON.stringify(plan.gone) === '["Old shop"]', 'it finds 1 new, 1 changed, 1 unchanged, 1 no longer in KeePass', JSON.stringify(plan));
ok(plan.upd[0] && /Sakura Bank \(main\)/.test(plan.upd[0]) && /Password/.test(plan.upd[0]) && /Group/.test(plan.upd[0]) && /Title/.test(plan.upd[0]), 'the changed one is the renamed, moved one with its new password: ' + plan.upd[0]);
ok(await page.locator('.modal-mask', { hasText: 'Made in RegiBase' }).count() === 0, 'the record made in RegiBase is not in the plan');
await vm('vm.pwr.delGone = true; return 1;');
await page.locator('.modal-mask .btn.primary', { hasText: /Apply|適用|反映/ }).first().click();
for (let i = 0; i < 120; i++) { await sleep(250); if (!(await vm('return !!(vm.modal && vm.modal.type === "pwrefresh");'))) break; }
ok(!(await vm('return !!(vm.modal && vm.modal.type === "pwrefresh");')), 'the refresh finishes', await vm('return vm.pwr.err;'));
recs = await api('collections/' + coll.id + '/records');
const titles = recs.map((r) => r.data.title).sort();
ok(JSON.stringify(titles) === JSON.stringify(['Made in RegiBase', 'Mail', 'New shop', 'Sakura Bank (main)']), 'the records are now: ' + titles.join(', '), JSON.stringify(titles));
const s2 = recs.find((r) => r.data.title === 'Sakura Bank (main)');
ok(s2 && s2.id === sakura.id, 'the renamed entry is the same record as before (found by its KeePass ID), not a new one', s2 && (s2.id + ' vs ' + sakura.id));
ok(s2 && s2.data.group === 'Money' && String(s2.data.password).startsWith('rbenc1:') && String(s2.data.totp).startsWith('rbenc1:'), 'its group is the new one, and its password and one-time password are stored encrypted', JSON.stringify(s2 && s2.data).slice(0, 220));
ok(!/new-pass-9|new-shop-4|mail-pass-2/.test(JSON.stringify(recs)), 'no password is stored in plain');
await vm('await vm.selectCollection(arg); return 1;', coll.id); await sleep(600);
const plainPw = await vm('const r = vm.records.find((x) => x.data.title === "Sakura Bank (main)"); return await vm.secretPlain(r.data.password);');
ok(plainPw === 'new-pass-9', 'and it opens as the new password: ' + plainPw);
const etagAfter = (await dav('GET', 'Vault/family.kdbx')).etag;
ok(etagBefore && etagBefore === etagAfter, 'the KeePass file was not written to (its ETag is the same)', etagBefore + ' / ' + etagAfter);

// ---- a second refresh finds nothing to do
await vm('vm.openPwRefresh(); vm.pwr.password = arg; await vm.readPwr(); return 1;', KP);
const p2 = await vm('const p = vm.pwr.plan; return p ? { a: p.add.length, u: p.update.length, g: p.gone.length, s: p.same, f: !!p.fields } : vm.pwr.err;');
ok(p2 && p2.a === 0 && p2.u === 0 && p2.g === 0 && p2.s === 3 && !p2.f, 'refreshing again finds nothing to change', JSON.stringify(p2));
await vm('vm.closePwRefresh(); return 1;');

// ---- editing the fields keeps the remembered file
const kept = await vm('vm.openSchemaEditor(); await new Promise((r) => setTimeout(r, 200)); const f = vm.serializeSchemaFields().find((x) => x.key === "kp_uuid"); vm.modal = null; return f ? f.options : "no field";');
ok(kept && kept.kdbx && kept.kdbx.path === 'Vault/family.kdbx', 'the field editor saves the remembered file along with the fields', JSON.stringify(kept));

// ---- a collection imported with 0.23.0 (no KeePass IDs, no one-time password field yet)
const oldc = await api('collections', { method: 'POST', body: JSON.stringify({ name: 'KP from 0.23', icon: '🔑', folder_choice: 'suffix', fields: [
  { key: 'title', label: 'Title', type: 'text', is_title: true }, { key: 'group', label: 'Group', type: 'text' }, { key: 'username', label: 'Username / ID', type: 'text' },
  { key: 'password', label: 'Password', type: 'password', secret: true }] }) });
await vm('await vm.loadCollections(); await vm.selectCollection(arg); return 1;', oldc.id); await sleep(500);
const encPw = await vm('const k = await vm.keyFor(vm.current); return await rbcrypto.encrypt(k, "mail-pass-2");').catch(() => null);
for (const d of [{ title: 'Mail', username: 'me@mail.test', password: encPw || 'mail-pass-2' }, { title: 'Sakura Bank (main)', group: 'Money', username: 'taro', password: encPw || 'x' }, { title: 'Hand made', username: 'h' }])
  await api('collections/' + oldc.id + '/records', { method: 'POST', body: JSON.stringify({ data: d }) });
await vm('await vm.selectCollection(arg); return 1;', oldc.id); await sleep(500);
ok(await vm('return vm.pwRefreshable && !vm.kdbxPath;'), 'a 0.23.0 collection offers the refresh too (no file remembered yet)');
await vm('vm.openPwRefresh(); return 1;'); await sleep(200);
await vm('const x = { path: "Vault/family.kdbx", name: "family.kdbx", size: 1 }; await vm.pwFromNc(vm.pwr, x); vm.pwr.password = arg; await vm.readPwr(); return 1;', KP);
const p3 = await vm('const p = vm.pwr.plan; return p ? { byName: p.byName, add: p.add.length, upd: p.update.map((u) => u.title + ":" + u.changed.join("|")), gone: p.gone.length, nf: p.newFields, notes: vm.pwr.notes } : vm.pwr.err;');
ok(p3 && p3.byName === 2 && p3.add === 1 && p3.gone === 0, 'the two entries it has are matched by group + title + user name; the third is new; nothing is "gone"', JSON.stringify(p3));
ok(p3 && JSON.stringify(p3.nf) === JSON.stringify(['One-time password (TOTP)', 'KeePass ID']), 'the one-time password and KeePass ID fields will be added', JSON.stringify(p3 && p3.nf));
await page.locator('.modal-mask .btn.primary', { hasText: /Apply|反映/ }).first().click();
for (let i = 0; i < 120; i++) { await sleep(250); if (!(await vm('return !!(vm.modal && vm.modal.type === "pwrefresh");'))) break; }
ok(!(await vm('return !!(vm.modal && vm.modal.type === "pwrefresh");')), 'it applies', await vm('return vm.pwr.err;'));
const of = (await api('collections/' + oldc.id)).fields; const ofk = Object.fromEntries(of.map((f) => [f.key, f]));
ok(ofk.kp_uuid && ofk.kp_uuid.options && ofk.kp_uuid.options.kdbx.path === 'Vault/family.kdbx' && ofk.kp_uuid.list_show === false, 'the KeePass ID field is added, hidden, with the file remembered', JSON.stringify(ofk.kp_uuid));
ok(ofk.totp && ofk.totp.secret, 'the one-time password field is added as a secret field', JSON.stringify(ofk.totp));
const orecs = await api('collections/' + oldc.id + '/records');
const os = orecs.find((r) => r.data.title === 'Sakura Bank (main)');
ok(os && os.data.kp_uuid && String(os.data.totp).startsWith('rbenc1:') && String(os.data.password).startsWith('rbenc1:'), 'the matched record has its ID now, and its one-time password, encrypted', JSON.stringify(os && os.data).slice(0, 200));
ok(orecs.length === 4 && orecs.some((r) => r.data.title === 'Hand made' && !r.data.kp_uuid), 'the hand-made record is still there, untouched; one new record', String(orecs.length));

for (const c of await api('collections')) if (!before.includes(c.id)) await api('collections/' + c.id, { method: 'DELETE' });
await dav('DELETE', 'Vault');
ok(errs.length === 0, 'no errors in the page', errs.join(' | '));
await b.close(); console.log(bad ? '\n' + bad + ' FAILED' : '\nALL OK'); process.exit(bad ? 1 : 0);
