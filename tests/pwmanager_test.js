/*
 * Passwords in and out (js/pwmanager.js): the CSV and JSON formats of other password managers,
 * and the way entries become a RegiBase collection and back. No browser, no KeePass library needed.
 * The .kdbx part runs in a browser: tests/pwmanager_kdbx_browser_test.mjs.
 *
 * Run: node tests/pwmanager_test.js
 */
const assert = require('assert');
const P = require('../js/pwmanager.js');
let fail = 0;
const t = (name, fn) => { try { fn(); console.log('PASS  ' + name); } catch (e) { fail++; console.log('FAIL  ' + name + '\n      ' + (e.message || e).split('\n')[0]); } };

// ---- CSV reading
t('CSV: quotes, doubled quotes, a line break and a comma inside a field, CRLF, a BOM', () => {
  const rows = P.parseCsv('﻿a,b,c\r\n"x, y","say ""hi""","line1\nline2"\r\n1,2,3\r\n');
  assert.deepStrictEqual(rows, [['a', 'b', 'c'], ['x, y', 'say "hi"', 'line1\nline2'], ['1', '2', '3']]);
});
t('CSV: an empty last field, an empty line in between, no final newline', () => {
  assert.deepStrictEqual(P.parseCsv('a,b,c\n1,,\n\n2,x,'), [['a', 'b', 'c'], ['1', '', ''], ['2', 'x', '']]);
});
t('CSV: semicolons and tabs are told from commas by the header line', () => {
  assert.deepStrictEqual(P.parseCsv('a;b;c\n1;2;3'), [['a', 'b', 'c'], ['1', '2', '3']]);
  assert.deepStrictEqual(P.parseCsv('a\tb\n1\t2'), [['a', 'b'], ['1', '2']]);
});
t('CSV: writing and reading it back keeps what is awkward', () => {
  const rows = [['a', 'b'], ['x,y', 'He said "no"'], ['two\nlines', ' padded ']];
  assert.deepStrictEqual(P.parseCsv(P.toCsv(rows)), rows);
});

// ---- the formats (headers as the programs write them)
const one = (csv) => P.fromCsv(csv);
t('KeePass 2 CSV', () => {
  const r = one('"Group","Title","Username","Password","URL","Notes"\n"Bank/Cards","三井住友","taro","P@ss","https://a.test","合言葉: さくら"\n');
  assert.strictEqual(r.format, 'keepass-csv'); const e = r.entries[0];
  assert.deepStrictEqual([e.group, e.title, e.username, e.password, e.url, e.notes], ['Bank/Cards', '三井住友', 'taro', 'P@ss', 'https://a.test', '合言葉: さくら']);
});
t('KeePassXC CSV (with TOTP, Icon, dates)', () => {
  const r = one('"Group","Title","Username","Password","URL","Notes","TOTP","Icon","Last Modified","Created"\n"Root","x","u","p","","n","otpauth://totp/x?secret=ABC","0","2026-01-01T00:00:00Z","2026-01-01T00:00:00Z"\n');
  assert.strictEqual(r.format, 'keepassxc-csv'); assert.strictEqual(r.entries[0].totp, 'otpauth://totp/x?secret=ABC');
});
t('KeePass 1.x CSV', () => {
  const r = one('"Account","Login Name","Password","Web Site","Comments"\n"Mail","me","pw","https://m.test","c"\n');
  assert.strictEqual(r.format, 'keepass1-csv'); assert.deepStrictEqual([r.entries[0].title, r.entries[0].username, r.entries[0].url], ['Mail', 'me', 'https://m.test']);
});
t('Bitwarden CSV (custom fields in one cell, the folder as the group)', () => {
  const r = one('folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp\nWork,1,login,GitHub,"n1","pin: 1234\nteam: red",0,https://github.com,me,pw,JBSWY3DP\n');
  assert.strictEqual(r.format, 'bitwarden-csv'); const e = r.entries[0];
  assert.deepStrictEqual([e.group, e.title, e.url, e.username, e.password, e.totp], ['Work', 'GitHub', 'https://github.com', 'me', 'pw', 'JBSWY3DP']);
  assert.deepStrictEqual(e.custom.map((c) => c.name + '=' + c.value), ['pin=1234', 'team=red']);
});
t('LastPass CSV (the grouping, "extra" as the notes, the secure-note marker URL dropped)', () => {
  const r = one('url,username,password,totp,extra,name,grouping,fav\nhttp://sn,,,,"a note",Wi-Fi,Home\\Net,0\nhttps://x.test,u,p,,e,X,Shopping,1\n');
  assert.strictEqual(r.format, 'lastpass-csv');
  assert.strictEqual(r.entries[0].url, ''); assert.strictEqual(r.entries[0].group, 'Home/Net'); assert.strictEqual(r.entries[0].notes, 'a note');
  assert.strictEqual(r.entries[1].title, 'X');
});
t('1Password CSV (the tags)', () => {
  const r = one('Title,Url,Username,Password,OTPAuth,Favorite,Archived,Tags,Notes\nAmazon,https://amazon.co.jp,me,pw,otpauth://totp/a?secret=A,false,false,"shop, jp",hello\n');
  assert.strictEqual(r.format, '1password-csv'); assert.deepStrictEqual(r.entries[0].tags, ['shop', 'jp']); assert.strictEqual(r.entries[0].totp, 'otpauth://totp/a?secret=A');
});
t('Chrome / Edge CSV (name,url,username,password,note), also the old one without note', () => {
  let r = one('name,url,username,password,note\nexample.com,https://example.com/login,me,pw,remember\n');
  assert.strictEqual(r.format, 'browser-csv'); assert.strictEqual(r.entries[0].notes, 'remember');
  r = one('name,url,username,password\nexample.com,https://example.com/login,me,pw\n'); assert.strictEqual(r.entries.length, 1);
});
t('Firefox CSV (no title: the host name is used)', () => {
  const r = one('"url","username","password","httpRealm","formActionOrigin","guid","timeCreated","timeLastUsed","timePasswordChanged"\n"https://www.example.com","me","pw","","https://www.example.com","{abc}","1700000000000","1700000000000","1700000000000"\n');
  assert.strictEqual(r.format, 'firefox-csv'); assert.strictEqual(r.entries[0].title, 'www.example.com');
});
t('Dashlane CSV', () => {
  const r = one('username,username2,username3,title,password,note,url,category,otpSecret\nme,alt,,Shop,pw,n,https://s.test,Shopping,SEED\n');
  assert.strictEqual(r.format, 'dashlane-csv'); const e = r.entries[0];
  assert.deepStrictEqual([e.title, e.group, e.username, e.totp], ['Shop', 'Shopping', 'me', 'SEED']); assert.deepStrictEqual(e.custom, [{ name: 'username2', value: 'alt', secret: false }]);
});
t('Proton Pass CSV (the vault as the group; e-mail kept when there is also a user name)', () => {
  const r = one('type,name,url,email,username,password,note,totp,createTime,modifyTime,vault\nlogin,Mail,https://m.test,me@m.test,me,pw,n,,1,2,Personal\n');
  assert.strictEqual(r.format, 'proton-csv'); const e = r.entries[0];
  assert.deepStrictEqual([e.group, e.username], ['Personal', 'me']); assert.deepStrictEqual(e.custom, [{ name: 'email', value: 'me@m.test', secret: false }]);
});
t('Passwords (Nextcloud) CSV', () => {
  const r = one('Label,Username,Password,Notes,URL,Custom Fields,Folder,Tags,Favorite,Edited,Id\nNAS,admin,pw,n,https://nas.local,,Home,"a, b",0,1700000000,xyz\n');
  assert.strictEqual(r.format, 'passwords-csv'); assert.deepStrictEqual([r.entries[0].group, r.entries[0].tags], ['Home', ['a', 'b']]);
});
t('a CSV it does not know is declined (not guessed)', () => { assert.strictEqual(P.fromCsv('a,b,c\n1,2,3\n'), null); });
t('rows with nothing in them are dropped', () => { assert.strictEqual(one('name,url,username,password\n,,,\nx,,u,p\n').entries.length, 1); });

t('Bitwarden JSON: folders, URIs beyond the first, hidden fields, a card, a note', () => {
  const data = { encrypted: false, folders: [{ id: 'f1', name: 'Work' }], items: [
    { id: '1', folderId: 'f1', type: 1, name: 'GitHub', notes: 'n', login: { uris: [{ uri: 'https://github.com' }, { uri: 'https://gist.github.com' }], username: 'me', password: 'pw', totp: 'SEED' }, fields: [{ name: 'pin', value: '1', type: 1 }, { name: 'team', value: 'red', type: 0 }] },
    { id: '2', folderId: null, type: 3, name: 'Visa', card: { cardholderName: 'T', brand: 'Visa', number: '4111111111111111', expMonth: '01', expYear: '2030', code: '123' } },
    { id: '3', folderId: null, type: 2, name: 'memo', notes: 'text' } ] };
  const r = P.fromText('x.json', JSON.stringify(data)); assert.strictEqual(r.format, 'bitwarden-json'); assert.strictEqual(r.entries.length, 3);
  const g = r.entries[0]; assert.deepStrictEqual([g.group, g.url, g.totp], ['Work', 'https://github.com', 'SEED']);
  assert.ok(g.custom.some((c) => c.name === 'URL 2' && c.value === 'https://gist.github.com'));
  assert.ok(g.custom.some((c) => c.name === 'pin' && c.secret === true)); assert.ok(g.custom.some((c) => c.name === 'team' && c.secret === false));
  assert.ok(r.entries[1].custom.some((c) => c.name === 'Number' && c.secret === true && c.value === '4111111111111111'));
  assert.deepStrictEqual(r.warnings, [{ code: 'notLogin', n: 2 }]);
});
t('Bitwarden JSON that is encrypted is refused with a clear code', () => {
  assert.throws(() => P.fromText('x.json', JSON.stringify({ encrypted: true, data: 'xx' })), (e) => e.code === 'encrypted');
});
t('JSON that is not a known export is declined', () => { assert.strictEqual(P.fromText('x.json', '{"a":1}'), null); assert.strictEqual(P.fromText('x.json', '{broken'), null); });

// ---- entries -> a RegiBase collection
const L = { title: 'Title', group: 'Group', url: 'URL', username: 'Username', password: 'Password', totp: 'One-time password', notes: 'Notes', tags: 'Tags' };
t('collection: only the fields in use, the right types, secrets marked', () => {
  const entries = [P.entry({ title: 'A', url: 'https://a', username: 'u', password: 'p', notes: 'n' }), P.entry({ title: 'B', password: 'q', custom: [{ name: '暗証番号', value: '4321', secret: true }, { name: 'Question', value: 'dog' }] })];
  const c = P.toCollection(entries, L);
  assert.deepStrictEqual(c.fields.map((f) => f.key), ['title', 'url', 'username', 'password', 'memo', 'c1', 'c2']);
  const f = Object.fromEntries(c.fields.map((x) => [x.key, x]));
  assert.ok(f.title.is_title); assert.strictEqual(f.url.type, 'url'); assert.ok(f.password.secret && f.password.type === 'password');
  assert.ok(f.c1.secret && f.c1.label === '暗証番号'); assert.ok(!f.c2.secret);
  assert.deepStrictEqual(c.records[1], { title: 'B', password: 'q', c1: '4321', c2: 'dog' });
});
t('collection: an entry without a title gets one; empty values are left out', () => {
  const c = P.toCollection([P.entry({ url: 'https://x.test', username: 'u' })], L); assert.strictEqual(c.records[0].title, 'https://x.test'); assert.ok(!('group' in c.records[0]));
});
t('collection: more custom fields than fit go into the notes', () => {
  const custom = []; for (let i = 1; i <= 45; i++) custom.push({ name: 'f' + i, value: 'v' + i });
  const c = P.toCollection([P.entry({ title: 'many', custom })], L);
  assert.strictEqual(c.fields.filter((f) => /^c\d+$/.test(f.key)).length, 40); assert.strictEqual(c.moved, 5);
  assert.ok(c.records[0].memo.includes('f45: v45')); assert.ok(c.fields.some((f) => f.key === 'memo'));
});

// ---- a collection -> entries
t('back out: the collection this module makes comes back as the same entries', () => {
  const entries = [P.entry({ title: 'A', group: 'G/H', url: 'https://a', username: 'u', password: 'p', totp: 'T', notes: 'n', tags: ['x', 'y'], custom: [{ name: '暗証番号', value: '4321', secret: true }] })];
  const c = P.toCollection(entries, L); const back = P.fromCollection(c.fields, c.records.map((d) => ({ data: d })));
  assert.deepStrictEqual(back[0], entries[0]);
});
t('back out: the "Online accounts" template (service, url, username, email, password, otp, category, memo)', () => {
  const fields = [{ key: 'service', label: 'Service name', type: 'text', is_title: true }, { key: 'url', label: 'URL', type: 'url' }, { key: 'username', label: 'Username / ID', type: 'text' },
    { key: 'email', label: 'Email address', type: 'email' }, { key: 'password', label: 'Password', type: 'password', secret: true }, { key: 'otp', label: '2FA / recovery codes', type: 'textarea', secret: true },
    { key: 'category', label: 'Category', type: 'text' }, { key: 'memo', label: 'Memo', type: 'textarea' }];
  const e = P.fromCollection(fields, [{ data: { service: 'GitHub', url: 'https://github.com', username: 'me', email: 'me@x.test', password: 'pw', otp: 'codes', category: 'Dev', memo: 'm' } }])[0];
  assert.deepStrictEqual([e.title, e.group, e.url, e.username, e.password, e.totp, e.notes], ['GitHub', 'Dev', 'https://github.com', 'me', 'pw', 'codes', 'm']);
  assert.deepStrictEqual(e.custom, [{ name: 'Email address', value: 'me@x.test', secret: false }]);
});
t('back out: a credit-card collection (nothing like a login) loses nothing: every field goes along', () => {
  const fields = [{ key: 'card_name', label: 'Card name', type: 'text', is_title: true }, { key: 'number', label: 'Card number', type: 'text', secret: true }, { key: 'expiry', label: 'Expiry', type: 'month' }, { key: 'pin', label: 'PIN', type: 'password', secret: true }];
  const e = P.fromCollection(fields, [{ data: { card_name: 'Rakuten', number: '4111', expiry: '2030-01', pin: '1234' } }])[0];
  assert.strictEqual(e.title, 'Rakuten'); assert.strictEqual(e.password, '1234');
  assert.deepStrictEqual(e.custom, [{ name: 'Card number', value: '4111', secret: true }, { name: 'Expiry', value: '2030-01', secret: false }]);
});

console.log(fail ? '\n' + fail + ' FAILED' : '\nALL PASS'); process.exit(fail ? 1 : 0);
