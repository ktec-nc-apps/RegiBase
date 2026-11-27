/*
 * "Sync with KeePass file" (0.24.1), both ways, through the real screens of RegiBase in a real Nextcloud:
 *   - a .kdbx in the user's Files is imported; the first sync finds everything in step and only
 *     remembers that (the file is not written);
 *   - changed in KeePass → RegiBase; changed in RegiBase → KeePass (the old version in the entry's
 *     history); a record made in RegiBase → a new entry (with its password, which RegiBase keeps
 *     encrypted); a record deleted in RegiBase → KeePass's recycle bin (when ticked);
 *   - RegiBase keeps the secret values encrypted; a second sync finds nothing to do;
 *   - when the file is changed by "another device" between Compare and Sync, nothing is written.
 * Needs a Nextcloud with RegiBase, a user who may use it (only for tests: a master key is set), Playwright and Chrome.
 * Run: USER_=name PASS_=password URL_=http://host node tests/pwmanager_sync_e2e.mjs
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
const dav = (method, path, b64) => page.evaluate(async ({ method, path, b64, user }) => {
  const body = b64 ? Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)) : undefined;
  const r = await fetch(OC.linkToRemote('dav') + '/files/' + user + '/' + path, { method, body, headers: { requesttoken: OC.requestToken }, credentials: 'same-origin' });
  if (method !== 'GET') return { status: r.status, etag: r.headers.get('ETag') };
  const u = new Uint8Array(await r.arrayBuffer()); let s = ''; for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
  return { status: r.status, etag: r.headers.get('ETag'), b64: btoa(s) };
}, { method, path, b64, user: USER_ });
const KP = 'KeePass-pw-1';
// look into the file the way KeePass would: {title: {user, pw, group, history}}, and what is in the recycle bin
const look = (b64) => page.evaluate(async ({ b64, pw }) => {
  const k = window.kdbxweb; const db = await k.Kdbx.load(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)).buffer, new k.Credentials(k.ProtectedValue.fromString(pw)));
  const out = { entries: {}, bin: [] }; const binId = db.meta.recycleBinUuid && db.meta.recycleBinUuid.id;
  const g = (e, n) => { const v = e.fields.get(n); return v == null ? null : (v instanceof k.ProtectedValue ? v.getText() : String(v)); };
  (function walk(gr, inBin) {
    const bin = inBin || (binId && gr.uuid.id === binId);
    for (const e of gr.entries) { if (bin) out.bin.push(g(e, 'Title')); else out.entries[g(e, 'Title')] = { user: g(e, 'UserName'), pw: g(e, 'Password'), group: gr.name, history: e.history.length }; }
    gr.groups.forEach((c) => walk(c, bin));
  })(db.getDefaultGroup(), false);
  return out;
}, { b64, pw: KP });
const compare = async () => {
  await vm('vm.openPwRefresh("sync"); return 1;'); await sleep(200);
  await page.locator('.modal-mask input[type=password]').first().fill(KP);
  await page.locator('.modal-mask .btn.primary', { hasText: /Compare|比べる|比較/ }).first().click();
  for (let i = 0; i < 80; i++) { await sleep(250); if (await vm('return !vm.pwr.busy && (vm.pwr.step === 2 || !!vm.pwr.err);')) break; }
  return vm('const p = vm.pwr.plan; if (p && !p.toRb) return { err: "not a sync plan (mode " + vm.pwr.mode + ")" }; return p ? { toRb: p.toRb.filter((x) => !x.idOnly).map((x) => x.title + ":" + x.changed.join("|")), toKp: p.toKp.map((x) => x.title + ":" + x.changed.join("|")), conflicts: p.conflicts.map((x) => x.title), addRb: p.addRb.map((x) => x.title), addKp: p.addKp.map((x) => x.title), deletedKp: p.deletedKp.map((x) => x.title), deletedRb: p.deletedRb.map((x) => x.title), same: p.same } : { err: vm.pwr.err };');
};
const syncNow = async () => {
  await page.locator('.modal-mask .btn.primary', { hasText: /Sync now|同期する/ }).first().click();
  for (let i = 0; i < 160; i++) { await sleep(250); if (!(await vm('return !!(vm.modal && vm.modal.type === "pwrefresh");')) || (await vm('return !vm.pwr.busy && !!vm.pwr.err;'))) break; }
  return vm('return vm.modal && vm.modal.type === "pwrefresh" ? (vm.pwr.err || "still open") : "";');
};

await page.goto(URL_ + '/login'); await page.fill('#user', USER_); await page.fill('#password', PASS_); await page.click('button[type=submit]'); await sleep(2500);
await page.goto(URL_ + '/apps/regibase/');
for (let i = 0; i < 50; i++) { await sleep(400); if (await vm('return !!(vm && vm.collections);').catch(() => false)) break; }
const before = (await api('collections')).map((c) => c.id);
await vm('vm.encForm.next = vm.encForm.next2 = arg; await vm.enableEncryption(); return 1;', 'Master-key-2026');
ok(await vm('return vm.enc.enabled && vm.enc.unlocked;'), 'a master key is set (passwords are stored encrypted)');

// ---- a KeePass database in the user's Files, imported
const made = await page.evaluate(async (pw) => {
  const k = window.kdbxweb;
  await window.RBPw.writeKdbx([window.RBPw.entry({ title: 'x' })], { password: pw });
  const db = k.Kdbx.create(new k.Credentials(k.ProtectedValue.fromString(pw)), 'Family vault');
  db.setVersion(4); db.setKdf(k.Consts.KdfId.Argon2d);
  const VT = k.VarDictionary.ValueType; db.header.kdfParameters.set('M', VT.UInt64, new k.Int64(8 * 1024 * 1024)); db.header.kdfParameters.set('I', VT.UInt64, new k.Int64(2));
  const root = db.getDefaultGroup(); const bank = db.createGroup(root, 'Bank');
  const add = (g, title, user, pass) => { const e = db.createEntry(g); e.fields.set('Title', title); e.fields.set('UserName', user); e.fields.set('Password', k.ProtectedValue.fromString(pass)); e.times.lastModTime = new Date('2026-01-01T00:00:00Z'); return e; };
  add(bank, 'Sakura Bank', 'taro', 'sakura-1'); add(root, 'Mail', 'me@mail.test', 'mail-1'); add(root, 'Old shop', 'u', 'shop-1');
  const u = new Uint8Array(await db.save()); let s = ''; for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]); return btoa(s);
}, KP);
await dav('MKCOL', 'Vault'); await dav('PUT', 'Vault/family.kdbx', made);
await vm('vm.openPwImport(); return 1;'); await sleep(200);
await vm('await vm.pwFromNc(vm.pw, { path: "Vault/family.kdbx", name: "family.kdbx", size: 1 }); vm.pw.password = arg; await vm.readPw(); vm.pw.collName = "KP sync test"; await vm.commitPwImport(); return 1;', KP);
const coll = (await api('collections')).find((c) => c.name === 'KP sync test');
ok(!!coll, 'the KeePass file is imported as a collection');
await vm('await vm.selectCollection(arg); return 1;', coll.id); await sleep(600);

// ---- the first sync: all in step; the file is not written, the state is remembered
const etag0 = (await dav('GET', 'Vault/family.kdbx')).etag;
const p1 = await compare();
ok(p1.same === 3 && !p1.toRb.length && !p1.toKp.length && !p1.conflicts.length && !p1.addRb.length && !p1.addKp.length, 'first sync: the 3 records are in step with the file', JSON.stringify(p1));
ok(await page.locator('.modal-mask', { hasText: /already in step|すでに同じ内容/ }).count() === 1, 'and the dialog says so');
let e1 = await syncNow();
ok(e1 === '', 'Sync now finishes', e1);
ok((await dav('GET', 'Vault/family.kdbx')).etag === etag0, 'the file was not written (nothing to change in it)');
let kf = (await api('collections/' + coll.id)).fields.find((f) => f.key === 'kp_uuid');
const st1 = kf && kf.options && kf.options.kdbx && kf.options.kdbx.sync;
ok(st1 && Object.keys(st1).length === 3 && Object.values(st1).every((v) => Array.isArray(v) && typeof v[0] === 'number' && /^\d{4}-/.test(v[1])), 'the sync state is kept: 3 entries, only times', JSON.stringify(st1));
ok(kf.options.kdbx.path === 'Vault/family.kdbx', 'and the file is still remembered');

// ---- changes on both sides
const mod = await page.evaluate(async ({ b64, pw }) => {
  const k = window.kdbxweb; const db = await k.Kdbx.load(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)).buffer, new k.Credentials(k.ProtectedValue.fromString(pw)));
  const all = []; (function w(g) { g.entries.forEach((e) => all.push(e)); g.groups.forEach(w); })(db.getDefaultGroup());
  const m = all.find((e) => e.fields.get('Title') === 'Mail'); m.pushHistory(); m.fields.set('Password', k.ProtectedValue.fromString('mail-2-kp')); m.times.update();
  const u = new Uint8Array(await db.save()); let s = ''; for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]); return btoa(s);
}, { b64: (await dav('GET', 'Vault/family.kdbx')).b64, pw: KP });
await dav('PUT', 'Vault/family.kdbx', mod);                                                                                 // KeePass: Mail's password
let recs = await api('collections/' + coll.id + '/records');
const sak = recs.find((r) => r.data.title === 'Sakura Bank');
await api('records/' + sak.id, { method: 'PUT', body: JSON.stringify({ data: { ...sak.data, username: 'taro-rb' } }) });   // RegiBase: Sakura's user name
const newData = await vm('return await vm.encryptData({ title: "Made in RegiBase", group: "Bank/Cards", username: "mine", password: "made-in-rb-7" });');
ok(String(newData.password).startsWith('rbenc1:'), 'a record made in RegiBase, its password encrypted as the app does');
await api('collections/' + coll.id + '/records', { method: 'POST', body: JSON.stringify({ data: newData }) });
const old = recs.find((r) => r.data.title === 'Old shop');
await api('records/delete', { method: 'POST', body: JSON.stringify({ ids: [old.id] }) });                                   // RegiBase: deleted
await vm('await vm.selectCollection(arg); return 1;', coll.id); await sleep(500);
const p2 = await compare();
ok(JSON.stringify(p2.toRb) === '["Mail:Password"]', 'changed in KeePass → to RegiBase: Mail (Password)', JSON.stringify(p2));
ok(JSON.stringify(p2.toKp) === '["Sakura Bank:Username / ID"]', 'changed in RegiBase → to KeePass: Sakura Bank (user name)', JSON.stringify(p2));
ok(JSON.stringify(p2.addKp) === '["Made in RegiBase"]' && JSON.stringify(p2.deletedRb) === '["Old shop"]' && !p2.conflicts.length, 'new in RegiBase → KeePass; deleted in RegiBase → offered', JSON.stringify(p2));
ok(await page.locator('.modal-mask', { hasText: /RegiBase → KeePass|From RegiBase to KeePass/ }).count() === 1, 'the dialog lists what goes to KeePass');
await vm('vm.pwr.delRb = true; return 1;');
const e2 = await syncNow();
ok(e2 === '', 'Sync now finishes', e2);
const f2 = await dav('GET', 'Vault/family.kdbx');
const kp2 = await look(f2.b64);
ok(kp2.entries['Sakura Bank'] && kp2.entries['Sakura Bank'].user === 'taro-rb' && kp2.entries['Sakura Bank'].history === 1, 'KeePass: Sakura Bank has the user name changed in RegiBase, and the old version in its history', JSON.stringify(kp2.entries['Sakura Bank']));
ok(kp2.entries['Made in RegiBase'] && kp2.entries['Made in RegiBase'].pw === 'made-in-rb-7' && kp2.entries['Made in RegiBase'].group === 'Cards', 'KeePass: the record made in RegiBase is a new entry in Bank/Cards, with its password (decrypted in the browser)', JSON.stringify(kp2.entries['Made in RegiBase']));
ok(!kp2.entries['Old shop'] && kp2.bin.includes('Old shop'), 'KeePass: the record deleted in RegiBase is in the recycle bin', JSON.stringify(kp2));
ok(kp2.entries.Mail && kp2.entries.Mail.pw === 'mail-2-kp', 'KeePass: Mail is as KeePass changed it');
recs = await api('collections/' + coll.id + '/records');
const mail = recs.find((r) => r.data.title === 'Mail'); const mir = recs.find((r) => r.data.title === 'Made in RegiBase');
ok(mail && String(mail.data.password).startsWith('rbenc1:') && (await vm('const r = vm.records.find((x) => x.data.title === "Mail"); return await vm.secretPlain(r.data.password);')) === 'mail-2-kp', 'RegiBase: Mail has KeePass\'s new password, stored encrypted');
ok(mir && /^[A-Za-z0-9+/]{22}==$/.test(mir.data.kp_uuid || '') && String(mir.data.password).startsWith('rbenc1:'), 'RegiBase: the new record now has its KeePass ID; its password is still encrypted', JSON.stringify(mir && mir.data).slice(0, 200));
ok(!/mail-2-kp|made-in-rb-7|sakura-1/.test(JSON.stringify(recs)), 'no password is stored in plain in RegiBase');
kf = (await api('collections/' + coll.id)).fields.find((f) => f.key === 'kp_uuid');
ok(Object.keys(kf.options.kdbx.sync).length === 3, 'the sync state has the 3 entries in step now', JSON.stringify(kf.options.kdbx.sync));

// ---- right after: nothing to do
const p3 = await compare();
ok(p3.same === 3 && !p3.toRb.length && !p3.toKp.length && !p3.conflicts.length && !p3.addRb.length && !p3.addKp.length && !p3.deletedRb.length && !p3.deletedKp.length, 'a second sync finds nothing to do', JSON.stringify(p3));
await vm('vm.closePwRefresh(); return 1;');

// ---- the file changes between Compare and Sync: nothing is overwritten
recs = await api('collections/' + coll.id + '/records');
const m2 = recs.find((r) => r.data.title === 'Mail');
await api('records/' + m2.id, { method: 'PUT', body: JSON.stringify({ data: { ...m2.data, username: 'me-rb-2' } }) });
await vm('await vm.selectCollection(arg); return 1;', coll.id); await sleep(400);
const p4 = await compare();
ok(JSON.stringify(p4.toKp) === '["Mail:Username / ID"]', 'a change in RegiBase is ready to go to KeePass', JSON.stringify(p4));
const other = await page.evaluate(async ({ b64, pw }) => {
  const k = window.kdbxweb; const db = await k.Kdbx.load(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)).buffer, new k.Credentials(k.ProtectedValue.fromString(pw)));
  db.meta.name = 'changed on another device';
  const u = new Uint8Array(await db.save()); let s = ''; for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]); return btoa(s);
}, { b64: (await dav('GET', 'Vault/family.kdbx')).b64, pw: KP });
await dav('PUT', 'Vault/family.kdbx', other);
const etagOther = (await dav('GET', 'Vault/family.kdbx')).etag;
const e4 = await syncNow();
ok(/changed .*after it was compared|比較した後/.test(e4), 'Sync now refuses: the file was changed after Compare — ' + e4, e4);
ok((await dav('GET', 'Vault/family.kdbx')).etag === etagOther, 'and the file is as the other device left it');
recs = await api('collections/' + coll.id + '/records');
ok(recs.find((r) => r.data.title === 'Mail').data.username === 'me-rb-2', 'and RegiBase\'s change is still waiting in RegiBase');
// comparing again and syncing then works
await vm('vm.pwr.step = 1; return 1;');
await page.locator('.modal-mask input[type=password]').first().fill(KP);
await page.locator('.modal-mask .btn.primary', { hasText: /Compare|比べる|比較/ }).first().click();
for (let i = 0; i < 80; i++) { await sleep(250); if (await vm('return !vm.pwr.busy && (vm.pwr.step === 2 || !!vm.pwr.err);')) break; }
const e5 = await syncNow();
const kp5 = await look((await dav('GET', 'Vault/family.kdbx')).b64);
ok(e5 === '' && kp5.entries.Mail.user === 'me-rb-2', 'compared again, the sync goes through', e5 + ' ' + JSON.stringify(kp5.entries.Mail));

for (const c of await api('collections')) if (!before.includes(c.id)) await api('collections/' + c.id, { method: 'DELETE' });
await dav('DELETE', 'Vault');
ok(errs.length === 0, 'no errors in the page', errs.join(' | '));
await b.close(); console.log(bad ? '\n' + bad + ' FAILED' : '\nALL OK'); process.exit(bad ? 1 : 0);
