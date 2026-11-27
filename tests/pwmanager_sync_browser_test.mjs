/*
 * Sync with a KeePass file, both ways (js/pwmanager.js planSync / syncApply / syncSave), in a real
 * browser with the libraries RegiBase ships. RegiBase's side is played by a list of records.
 *   - a change made on one side only goes to the other; a change on both sides is a conflict that
 *     the newer side wins (or the side the user picks), field by field;
 *   - new on either side is added to the other; deleted on either side only when asked;
 *   - what KeePass keeps that RegiBase does not know (attachments, history, other fields, the
 *     recycle bin, the way a one-time password is kept) stays in the file;
 *   - a second sync right after finds nothing to do;
 *   - KeePassXC's own files (optional, KDBX_REAL_DIR) can be synced and still open.
 * Run: node tests/pwmanager_sync_browser_test.mjs
 */
import { chromium } from '/root/editbase-tests/pw.mjs';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const here = dirname(fileURLToPath(import.meta.url)); const js = join(here, '..', 'js');
const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const page = await b.newPage();
const errs = []; page.on('pageerror', (e) => errs.push(String(e).slice(0, 200)));
await page.route('http://localhost:8123/**', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>t</title>' }));
await page.goto('http://localhost:8123/');
for (const f of ['vendor/kdbxweb.min.js', 'vendor/argon2.umd.min.js', 'pwmanager.js']) await page.addScriptTag({ content: readFileSync(join(js, f), 'utf8') });
let fail = 0;
const ok = (c, m, extra = '') => { console.log((c ? 'PASS  ' : 'FAIL  ') + m + (c ? '' : '  (' + extra + ')')); if (!c) fail++; };

const r = await page.evaluate(async () => {
  const P = window.RBPw; const k = window.kdbxweb; const PW = 'sync-pass-1';
  const out = {};
  await P.writeKdbx([P.entry({ title: 'x' })], { password: 'x' });   // sets up kdbxweb's Argon2 for the file made below
  // ---- a file as KeePassXC would have it
  const db = k.Kdbx.create(new k.Credentials(k.ProtectedValue.fromString(PW)), 'Family');
  db.setVersion(4); db.setKdf(k.Consts.KdfId.Argon2id);
  const VT = k.VarDictionary.ValueType; db.header.kdfParameters.set('M', VT.UInt64, new k.Int64(4 * 1024 * 1024)); db.header.kdfParameters.set('I', VT.UInt64, new k.Int64(2));
  db.meta.generator = 'KeePassXC';
  const root = db.getDefaultGroup(); const bank = db.createGroup(root, 'Bank');
  const T0 = new Date('2026-01-01T00:00:00Z');
  const add = (g, t, u, p, more) => { const e = db.createEntry(g); e.fields.set('Title', t); e.fields.set('UserName', u); e.fields.set('Password', k.ProtectedValue.fromString(p)); for (const [n, v] of Object.entries(more || {})) e.fields.set(n, v); e.times.lastModTime = T0; return e; };
  const eA = add(bank, 'Sakura', 'taro', 'a-1', { 'TimeOtp-Secret-Base32': k.ProtectedValue.fromString('JBSWY3DPEHPK3PXP') });
  const eB = add(root, 'Mail', 'me', 'b-1');
  const eC = add(root, 'Shop', 'u', 'c-1');
  const eD = add(root, 'Cloud', 'ktec', 'd-1', { otp: k.ProtectedValue.fromString('otpauth://totp/Cloud?secret=GEZDGNBVGY3TQOJQ&period=30') });
  const eE = add(root, 'WithFile', 'w', 'e-1', { 'Extra note': 'keep me' });
  const bin = await db.createBinary(k.ProtectedValue.fromBinary(new TextEncoder().encode('attachment-bytes').buffer));
  eE.binaries.set('scan.txt', bin); eE.pushHistory(); eE.fields.set('Password', k.ProtectedValue.fromString('e-1')); eE.times.lastModTime = T0;
  const buf0 = await db.save();
  // ---- import into "RegiBase"
  const f0 = await P.readKdbx(buf0, PW, null);
  const L = { title: 'Title', group: 'Group', url: 'URL', username: 'User', password: 'Password', totp: 'TOTP', notes: 'Memo', tags: 'Tags', kpid: 'KeePass ID' };
  const col = P.toCollection(f0.entries, L, { path: 'KeePass/family.kdbx' });
  let fields = col.fields; let seq = 0; let clock = Date.parse('2026-02-01T00:00:00Z');
  const stamp = () => new Date(clock += 1000).toISOString();
  let records = col.records.map((d) => ({ id: ++seq, data: d, updated_at: stamp() }));
  const titleKey = fields.find((x) => x.is_title).key;
  const rec = (t) => records.find((x) => x.data[titleKey] === t);
  const setState = (s) => { fields = fields.map((x) => x.key === P.UUID_KEY ? { ...x, options: { ...(x.options || {}), kdbx: { ...((x.options || {}).kdbx || {}), sync: s } } } : x); };
  // RegiBase's side of a sync: what the page does after the file is written
  const rbApply = (applied, plan) => {
    if (plan.fields) fields = plan.fields;
    const updatedAt = {}; for (const x of records) updatedAt[x.id] = x.updated_at;
    for (const u of applied.update) { const x = records.find((y) => y.id === u.id); x.data = u.data; x.updated_at = stamp(); updatedAt[x.id] = x.updated_at; }
    const ids = []; for (const a of applied.add) { const x = { id: ++seq, data: a.data, updated_at: stamp() }; records.push(x); ids.push(x.id); updatedAt[x.id] = x.updated_at; }
    records = records.filter((x) => !applied.del.includes(x.id));
    setState(P.syncStateAfter(applied, updatedAt, ids));
  };
  const sync = async (buf, choice) => {
    const file = await P.readKdbx(buf, PW, null);
    const plan = P.planSync(fields, records, file, L);
    const applied = P.syncApply(plan, choice || {});
    const saved = await P.syncSave(file);
    rbApply(applied, plan);
    return { plan, applied, buf: saved };
  };
  const brief = (p) => ({ toRb: p.toRb.filter((x) => !x.idOnly).map((x) => x.title), toKp: p.toKp.map((x) => x.title), conflicts: p.conflicts.map((x) => x.title + ':' + x.winner), addRb: p.addRb.map((x) => x.title), addKp: p.addKp.map((x) => x.title), deletedKp: p.deletedKp.map((x) => x.title), deletedRb: p.deletedRb.map((x) => x.title), same: p.same, newFields: p.newFields });

  // 1. the first sync of a collection imported before: all in step
  const s1 = await sync(buf0);
  out.first = brief(s1.plan); out.firstKpChanged = s1.applied.kpChanged;
  out.stateSize = Object.keys(P.syncState(fields)).length;

  // 2. changes on both sides
  let db2 = await k.Kdbx.load(s1.buf, new k.Credentials(k.ProtectedValue.fromString(PW)));
  const all = (d) => { const a = []; (function w(g) { if (d.meta.recycleBinUuid && g.uuid.id === d.meta.recycleBinUuid.id) return; g.entries.forEach((e) => a.push(e)); g.groups.forEach(w); })(d.getDefaultGroup()); return a; };
  const by = (d, t) => all(d).find((e) => e.fields.get('Title') === t);
  const later = new Date('2026-03-01T00:00:00Z');
  { const e = by(db2, 'Mail'); e.pushHistory(); e.fields.set('Password', k.ProtectedValue.fromString('b-2-kp')); e.times.lastModTime = later; }               // KeePass only
  { const e = by(db2, 'Sakura'); e.pushHistory(); e.fields.set('UserName', 'taro-kp'); e.times.lastModTime = new Date(clock + 3600e3); }              // both (KeePass newer)
  { const n = db2.createEntry(db2.getDefaultGroup()); n.fields.set('Title', 'New in KeePass'); n.fields.set('Password', k.ProtectedValue.fromString('n-1')); }
  db2.remove(by(db2, 'Shop'));                                                                                                                         // to KeePass's recycle bin
  const buf2 = await db2.save();
  rec('Cloud').data.username = 'ktec-rb'; rec('Cloud').updated_at = stamp();                                                                          // RegiBase only
  rec('Sakura').data.password = 'a-2-rb'; rec('Sakura').updated_at = stamp();                                                                          // both (RegiBase older)
  fields = fields.concat([{ key: 'pin', label: 'PIN', type: 'password', secret: true }]); rec('Cloud').data.pin = '0042';                             // a field made in RegiBase
  rec('Cloud').data.totp = 'otpauth://totp/Cloud?secret=GEZDGNBVGY3TQOJQ&period=60';
  rec('Sakura').data.totp = 'JBSWY3DPEHPK3PXQ';
  records.push({ id: ++seq, data: { [titleKey]: 'New in RegiBase', group: 'Bank/Cards', username: 'nr', password: 'r-1' }, updated_at: stamp() });
  records = records.filter((x) => x.data[titleKey] !== 'WithFile');                                                                                  // deleted in RegiBase
  const plan2 = P.planSync(fields, records, await P.readKdbx(buf2, PW, null), L);
  out.second = brief(plan2);
  out.conflictInfo = plan2.conflicts.map((x) => ({ t: x.title, changed: x.changed, first: x.first }));
  // apply with deletions both ways
  const s2 = await sync(buf2, { deleteKp: true, deleteRb: true });
  out.applied2 = { kpChanged: s2.applied.kpChanged, kpAdded: s2.applied.kpAdded, kpDeleted: s2.applied.kpDeleted, update: s2.applied.update.length, add: s2.applied.add.length, del: s2.applied.del.length };
  const db3 = await k.Kdbx.load(s2.buf, new k.Credentials(k.ProtectedValue.fromString(PW)));
  const g = (e, n) => { const v = e && e.fields.get(n); return v == null ? null : (v instanceof k.ProtectedValue ? v.getText() : String(v)); };
  const cl = by(db3, 'Cloud'); const sk = by(db3, 'Sakura'); const nr = by(db3, 'New in RegiBase');
  out.kp = {
    cloudUser: g(cl, 'UserName'), cloudPin: g(cl, 'PIN'), cloudPinProtected: cl.fields.get('PIN') instanceof k.ProtectedValue, cloudOtp: g(cl, 'otp'), cloudHistory: cl.history.length,
    sakuraUser: g(sk, 'UserName'), sakuraPw: g(sk, 'Password'), sakuraOtp: g(sk, 'TimeOtp-Secret-Base32'), sakuraHasOtpField: sk.fields.has('otp'), sakuraGroup: sk.parentGroup.name,
    newRb: nr ? { group: nr.parentGroup.name + '<' + nr.parentGroup.parentGroup.name, pw: g(nr, 'Password'), user: g(nr, 'UserName'), uuid: nr.uuid.id } : null,
    withFileInBin: !!(db3.meta.recycleBinUuid && all(db3).every((e) => g(e, 'Title') !== 'WithFile')),
    mail: g(by(db3, 'Mail'), 'Password'),
  };
  // what KeePass keeps that RegiBase does not: the attachment, the history, other fields
  { const bin3 = db3.getGroup(db3.meta.recycleBinUuid); const wf = bin3 ? bin3.entries.find((e) => g(e, 'Title') === 'WithFile') : null;
    out.kp.binKept = !!(wf && wf.binaries.get('scan.txt')); out.kp.wfHistory = wf ? wf.history.length : -1; out.kp.wfExtra = g(wf, 'Extra note'); }
  out.rb = {
    mail: rec('Mail') && rec('Mail').data.password, newKp: !!rec('New in KeePass'), shopGone: !rec('Shop'), sakuraUser: rec('Sakura').data.username, sakuraPw: rec('Sakura').data.password,
    newRbUuid: rec('New in RegiBase') && rec('New in RegiBase').data[P.UUID_KEY], sakuraTotp: rec('Sakura').data.totp,
  };
  out.kp.uuidMatch = out.kp.newRb && out.kp.newRb.uuid === out.rb.newRbUuid;
  // 3. right after: nothing to do
  const plan3 = P.planSync(fields, records, await P.readKdbx(s2.buf, PW, null), L);
  out.third = brief(plan3);
  // 4. a conflict the user gives to RegiBase
  let db4 = await k.Kdbx.load(s2.buf, new k.Credentials(k.ProtectedValue.fromString(PW)));
  { const e = by(db4, 'Mail'); e.fields.set('UserName', 'kp-name'); e.times.lastModTime = new Date('2026-04-01T00:00:00Z'); }
  const buf4 = await db4.save();
  rec('Mail').data.username = 'rb-name'; rec('Mail').updated_at = stamp();
  const p4 = P.planSync(fields, records, await P.readKdbx(buf4, PW, null), L);
  out.c4 = p4.conflicts.map((x) => x.title + ':' + x.winner);
  const s4 = await sync(buf4, { winners: { [rec('Mail').id]: 'rb' } });
  const db5 = await k.Kdbx.load(s4.buf, new k.Credentials(k.ProtectedValue.fromString(PW)));
  out.c4kp = g(by(db5, 'Mail'), 'UserName'); out.c4rb = rec('Mail').data.username;
  // 5. KeePass 2's file (it says so when read; kdbxweb writes its own name when it saves): a new one-time password goes into TimeOtp-*
  rec('Mail').data.totp = 'otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&digits=8&algorithm=SHA256'; rec('Mail').updated_at = stamp();
  const s5 = await (async () => {
    const file = await P.readKdbx(s4.buf, PW, null); file.db.meta.generator = 'KeePass';
    const plan = P.planSync(fields, records, file, L); const applied = P.syncApply(plan, {});
    const saved = await P.syncSave(file); rbApply(applied, plan); return { buf: saved };
  })();
  const db6 = await k.Kdbx.load(s5.buf, new k.Credentials(k.ProtectedValue.fromString(PW)));
  const m6 = by(db6, 'Mail');
  out.kp2 = { secret: g(m6, 'TimeOtp-Secret-Base32'), len: g(m6, 'TimeOtp-Length'), alg: g(m6, 'TimeOtp-Algorithm'), otp: g(m6, 'otp') };
  out.kp2code = (await P.totpCode(rec('Mail').data.totp, 59000)).code;
  out.kp2back = rec('Mail').data.totp;
  out.fourth = brief(P.planSync(fields, records, await P.readKdbx(s5.buf, PW, null), L));
  return out;
});

// ---- an entry with more custom field names than the import makes fields for (the rest went into the notes)
const r6 = await page.evaluate(async () => {
  const P = window.RBPw; const k = window.kdbxweb; const PW = 'many-1';
  const db = k.Kdbx.create(new k.Credentials(k.ProtectedValue.fromString(PW)), 'Many');
  db.setVersion(4); db.setKdf(k.Consts.KdfId.Argon2id);
  const VT = k.VarDictionary.ValueType; db.header.kdfParameters.set('M', VT.UInt64, new k.Int64(4 * 1024 * 1024)); db.header.kdfParameters.set('I', VT.UInt64, new k.Int64(2));
  const e = db.createEntry(db.getDefaultGroup()); e.fields.set('Title', 'Many'); e.fields.set('Notes', 'my note');
  for (let i = 1; i <= 43; i++) e.fields.set('Field ' + i, 'v' + i);
  e.times.lastModTime = new Date('2026-01-01T00:00:00Z');
  const file = await P.readKdbx(await db.save(), PW, null);
  const L = { title: 'Title', notes: 'Memo', kpid: 'KeePass ID' };
  const col = P.toCollection(file.entries, L, {});
  const records = col.records.map((d, i) => ({ id: i + 1, data: { ...d }, updated_at: '2031-01-01T00:00:00.000Z' }));
  const before = records[0].data.memo;
  const plan = P.planSync(col.fields, records, file, L);
  const applied = P.syncApply(plan, {});
  const back = await P.readKdbx(await P.syncSave(file), PW, null);
  return { moved: col.moved, before, newFields: plan.newFields.length, kpChanged: applied.kpChanged, kpNotes: back.entries[0].notes, rbNotes: applied.update[0] && applied.update[0].data.memo, rbField43: applied.update[0] && Object.values(applied.update[0].data).includes('v43') };
});
ok(r6.moved === 3 && /Field 43: v43/.test(r6.before), 'an entry with 43 custom names: the import put 3 of them into the notes', JSON.stringify(r6));
ok(r6.kpChanged === 0 && r6.kpNotes === 'my note', 'the first sync does not write those lines into KeePass\'s notes', JSON.stringify(r6));
ok(r6.newFields === 3 && r6.rbNotes === 'my note' && r6.rbField43, 'they get fields of their own in RegiBase, and its notes are KeePass\'s again', JSON.stringify(r6));

const none = (p) => !p.toRb.length && !p.toKp.length && !p.conflicts.length && !p.addRb.length && !p.addKp.length && !p.deletedKp.length && !p.deletedRb.length;
ok(none(r.first) && r.first.same === 5 && r.firstKpChanged === 0, 'first sync of an imported collection: all 5 in step, the file unchanged', JSON.stringify(r.first));
ok(r.stateSize === 5, 'and the sync state has the 5 entries (times and IDs only)', String(r.stateSize));
ok(JSON.stringify(r.second.toRb) === '["Mail"]', 'changed in KeePass only → to RegiBase', JSON.stringify(r.second));
ok(JSON.stringify(r.second.toKp) === '["Cloud"]', 'changed in RegiBase only → to KeePass', JSON.stringify(r.second));
ok(JSON.stringify(r.second.conflicts) === '["Sakura:kp"]', 'changed on both sides → a conflict, the newer side (KeePass) chosen', JSON.stringify(r.second));
ok(JSON.stringify(r.second.addRb) === '["New in KeePass"]' && JSON.stringify(r.second.addKp) === '["New in RegiBase"]', 'new on each side → to the other', JSON.stringify(r.second));
ok(JSON.stringify(r.second.deletedKp) === '["Shop"]' && JSON.stringify(r.second.deletedRb) === '["WithFile"]', 'deleted on each side (KeePass: recycle bin) → offered', JSON.stringify(r.second));
ok(r.kp.mail === 'b-2-kp' && r.rb.mail === 'b-2-kp', 'KeePass\'s change is in RegiBase', JSON.stringify([r.kp.mail, r.rb.mail]));
ok(r.kp.cloudUser === 'ktec-rb' && r.kp.cloudHistory === 1, 'RegiBase\'s change is in KeePass, and the old version is in the entry\'s history', JSON.stringify(r.kp));
ok(r.kp.cloudPin === '0042' && r.kp.cloudPinProtected, 'a field made in RegiBase goes to KeePass as a protected custom field', JSON.stringify(r.kp));
ok(/period=60/.test(r.kp.cloudOtp || ''), 'a one-time password kept as "otp" is written back as "otp"', r.kp.cloudOtp);
ok(r.kp.sakuraUser === 'taro-kp' && r.kp.sakuraPw === 'a-1' && r.rb.sakuraUser === 'taro-kp' && r.rb.sakuraPw === 'a-1', 'the conflict: KeePass\'s version on both sides', JSON.stringify([r.kp, r.rb]));
ok(r.kp.sakuraOtp === 'JBSWY3DPEHPK3PXP' && !r.kp.sakuraHasOtpField, 'and KeePass 2\'s TimeOtp-* stays as it was', JSON.stringify(r.kp));
ok(r.kp.newRb && r.kp.newRb.group === 'Cards<Bank' && r.kp.newRb.pw === 'r-1' && r.kp.newRb.user === 'nr', 'a record made in RegiBase is a new entry, in its group (made inside the existing one)', JSON.stringify(r.kp.newRb));
ok(r.kp.uuidMatch, 'and the record now has the new entry\'s KeePass ID', JSON.stringify([r.kp.newRb, r.rb.newRbUuid]));
ok(r.rb.newKp && r.rb.shopGone, 'new in KeePass is a record; deleted in KeePass is deleted in RegiBase (asked)', JSON.stringify(r.rb));
ok(r.kp.withFileInBin && r.kp.binKept && r.kp.wfHistory === 1 && r.kp.wfExtra === 'keep me', 'deleted in RegiBase → to KeePass\'s recycle bin, with its attachment, history and other fields', JSON.stringify(r.kp));
ok(none(r.third), 'a second sync right after: nothing to do', JSON.stringify(r.third));
ok(JSON.stringify(r.c4) === '["Mail:kp"]' && r.c4kp === 'rb-name' && r.c4rb === 'rb-name', 'a conflict given to RegiBase: RegiBase\'s value on both sides', JSON.stringify([r.c4, r.c4kp, r.c4rb]));
ok(r.kp2.secret === 'JBSWY3DPEHPK3PXP' && r.kp2.len === '8' && r.kp2.alg === 'HMAC-SHA-256' && r.kp2.otp == null, 'KeePass 2\'s file: a new one-time password is written as TimeOtp-* (8 digits, HMAC-SHA-256)', JSON.stringify(r.kp2));
ok(r.kp2code.length === 8, 'and its code is 8 digits', r.kp2code);
ok(none(r.fourth), 'and after that, in step again', JSON.stringify(r.fourth));

// ---- KeePassXC's own files: synced (a record changed, one added) and still open
const dir = process.env.KDBX_REAL_DIR || '/root/regibase-build/kdbx-real';
if (existsSync(join(dir, 'Format400.kdbx'))) {
  for (const [name, pw, key] of [['Format300.kdbx', 'a', null], ['Format400.kdbx', 't', null], ['NewDatabase.kdbx', 'a', null], ['KeyFileProtected.kdbx', 'a', 'KeyFileProtected.key']]) {
    const res = await page.evaluate(async ({ b64, pw, kb64 }) => {
      const P = window.RBPw; const k = window.kdbxweb;
      const u8 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0)).buffer;
      const keyFile = kb64 ? u8(kb64) : null;
      const file = await P.readKdbx(u8(b64), pw, keyFile);
      const L = { title: 'Title', kpid: 'KeePass ID' };
      const col = P.toCollection(file.entries, L, {});
      const tk = col.fields.find((x) => x.is_title).key;
      const records = col.records.map((d, i) => ({ id: i + 1, data: d, updated_at: '2030-01-01T00:00:00.000Z' }));
      if (!records.length) return { err: 'empty' };
      records[0].data = { ...records[0].data, username: 'changed-by-rb' };
      records.push({ id: 999, data: { [tk]: 'Added by RegiBase', password: 'x' }, updated_at: '2030-01-01T00:00:00.000Z' });
      const plan = P.planSync(col.fields, records, file, L);
      const applied = P.syncApply(plan, {});
      const buf = await P.syncSave(file);
      const back = await P.readKdbx(buf, pw, keyFile);
      const db = await k.Kdbx.load(buf, new k.Credentials(k.ProtectedValue.fromString(pw), keyFile));
      return { n0: file.entries.length, n1: back.entries.length, version: back.version, added: back.entries.some((e) => e.title === 'Added by RegiBase'),
        changed: back.entries.some((e) => e.username === 'changed-by-rb'), conflicts: plan.conflicts.length, kpChanged: applied.kpChanged, kdf: db.header.kdfParameters ? 'kdbx4' : 'kdbx3' };
    }, { b64: readFileSync(join(dir, name)).toString('base64'), pw, kb64: key ? readFileSync(join(dir, key)).toString('base64') : null });
    ok(!res.err && res.n1 === res.n0 + 1 && res.added && res.changed, 'KeePassXC\'s ' + name + ' (' + res.version + '): synced and opens again with the change and the new entry', JSON.stringify(res));
  }
} else console.log('SKIP  KeePassXC\'s own files (KDBX_REAL_DIR not found)');

ok(errs.length === 0, 'no errors in the page', errs.join(' | '));
await b.close();
console.log(fail ? `\n${fail} FAILED` : '\nALL PASS');
process.exit(fail ? 1 : 0);
