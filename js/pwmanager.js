/*
 * RegiBase — passwords in and out: KeePass (.kdbx, read and write) and the exports of other
 * password managers (read).
 *
 * Everything here runs in the browser (and in Node, for the tests). Nothing is sent anywhere:
 * the master password of a KeePass file, a key file, and the passwords inside are used here
 * and nowhere else. What comes out is a plain list of entries (the "entry model" below); the
 * page encrypts the secret ones with the user's RegiBase key before anything reaches the server.
 *
 * The entry model — one object per login:
 *   { title, group, url, username, password, totp, notes, tags: [], custom: [{name, value, secret}],
 *     created?, modified? }
 *   group is a path with "/" between the levels ("Bank/Cards"), "" for none.
 *
 * Needs kdbxweb and hash-wasm's Argon2 for .kdbx (js/vendor/). The CSV and JSON formats need nothing.
 * kdbxweb (MIT) — https://github.com/keeweb/kdbxweb ; hash-wasm (MIT) — https://github.com/Daninet/hash-wasm
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(root);
  else root.RBPw = factory(root);
}(typeof self !== 'undefined' ? self : this, function (root) {
  'use strict';

  const CUSTOM_MAX = 40;          // custom fields a collection gets; the rest go into the notes
  const GROUP_SEP = '/';

  // ------------------------------------------------------------------ the entry model
  function entry(o) {
    return {
      title: str(o.title), group: str(o.group), url: str(o.url), username: str(o.username), password: str(o.password),
      totp: str(o.totp), notes: str(o.notes), tags: Array.isArray(o.tags) ? o.tags.map(str).filter(Boolean) : [],
      custom: Array.isArray(o.custom) ? o.custom.filter((c) => c && str(c.name) !== '' && str(c.value) !== '').map((c) => ({ name: str(c.name), value: str(c.value), secret: !!c.secret })) : [],
      created: o.created || null, modified: o.modified || null,
    };
  }
  function str(v) { return v == null ? '' : String(v); }

  // ------------------------------------------------------------------ CSV
  /** RFC 4180: quotes, doubled quotes, line breaks inside a quoted field, CRLF or LF, a BOM. */
  function parseCsv(text, delim) {
    text = String(text).replace(/^﻿/, '');
    delim = delim || detectDelimiter(text);
    const rows = []; let row = []; let cur = ''; let q = false; let any = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) {
        if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c;
      } else if (c === '"' && cur === '') { q = true; any = true; }
      else if (c === delim) { row.push(cur); cur = ''; any = true; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        if (any || cur !== '' || row.length) { row.push(cur); rows.push(row); }
        row = []; cur = ''; any = false;
      } else { cur += c; any = true; }
    }
    if (any || cur !== '' || row.length) { row.push(cur); rows.push(row); }
    return rows;
  }
  function detectDelimiter(text) {
    const first = text.replace(/^﻿/, '').split(/\r?\n/, 1)[0] || '';
    const n = (ch) => (first.match(new RegExp(ch === '\t' ? '\\t' : '\\' + ch, 'g')) || []).length;
    const c = { ',': n(','), ';': n(';'), '\t': n('\t') };
    return c[';'] > c[','] && c[';'] >= c['\t'] ? ';' : (c['\t'] > c[','] ? '\t' : ',');
  }
  function toCsv(rows) {
    return rows.map((r) => r.map((v) => { v = str(v); return /[",\r\n]/.test(v) || /^\s|\s$/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }).join(',')).join('\r\n') + '\r\n';
  }
  /** Rows as objects keyed by the lower-cased header. */
  function table(rows) {
    if (!rows.length) return { headers: [], records: [] };
    const headers = rows[0].map((h) => str(h).trim().toLowerCase());
    const records = rows.slice(1).filter((r) => r.some((v) => str(v).trim() !== '')).map((r) => {
      const o = {}; headers.forEach((h, i) => { if (h !== '' && !(h in o)) o[h] = str(r[i]); }); return o;
    });
    return { headers, records };
  }
  const hasAll = (headers, ...names) => names.every((n) => headers.includes(n));
  const pick = (o, ...names) => { for (const n of names) if (o[n] != null && o[n] !== '') return o[n]; return ''; };

  // ------------------------------------------------------------------ the CSV formats
  // Each: id, label, match(headers) → bool, entry(record) → entry model. Most specific first.
  const CSV_FORMATS = [
    { id: 'keepassxc-csv', label: 'KeePassXC (CSV)',
      match: (h) => hasAll(h, 'group', 'title', 'username', 'password', 'url', 'notes') && (h.includes('totp') || h.includes('last modified') || h.includes('icon')),
      entry: (r) => ({ title: r.title, group: r.group, url: r.url, username: r.username, password: r.password, totp: r.totp, notes: r.notes, modified: r['last modified'], created: r.created }) },
    { id: 'keepass-csv', label: 'KeePass (CSV)',
      match: (h) => hasAll(h, 'group', 'title', 'username', 'password', 'url', 'notes'),
      entry: (r) => ({ title: r.title, group: r.group, url: r.url, username: r.username, password: r.password, notes: r.notes }) },
    { id: 'keepass1-csv', label: 'KeePass 1.x (CSV)',
      match: (h) => hasAll(h, 'account', 'login name', 'password', 'web site'),
      entry: (r) => ({ title: r.account, url: r['web site'], username: r['login name'], password: r.password, notes: r.comments }) },
    { id: 'bitwarden-csv', label: 'Bitwarden (CSV)',
      match: (h) => hasAll(h, 'folder', 'name', 'login_uri', 'login_username', 'login_password'),
      entry: (r) => ({ title: r.name, group: r.folder, url: firstLine(r.login_uri), username: r.login_username, password: r.login_password, totp: r.login_totp, notes: r.notes,
        custom: bitwardenFieldsText(r.fields).concat(r.type && r.type !== 'login' ? [{ name: 'type', value: r.type }] : []) }) },
    { id: 'lastpass-csv', label: 'LastPass (CSV)',
      match: (h) => hasAll(h, 'url', 'username', 'password', 'name', 'grouping') && (h.includes('extra') || h.includes('fav')),
      entry: (r) => ({ title: r.name, group: String(r.grouping || '').replace(/\\/g, GROUP_SEP), url: r.url === 'http://sn' ? '' : r.url, username: r.username, password: r.password, totp: r.totp, notes: r.extra }) },
    { id: '1password-csv', label: '1Password (CSV)',
      match: (h) => hasAll(h, 'title', 'password') && (h.includes('otpauth') || h.includes('archived') || (h.includes('url') && h.includes('favorite'))),
      entry: (r) => ({ title: r.title, url: pick(r, 'url', 'website'), username: r.username, password: r.password, totp: r.otpauth, notes: r.notes, tags: splitTags(r.tags) }) },
    { id: 'proton-csv', label: 'Proton Pass (CSV)',
      match: (h) => hasAll(h, 'type', 'name', 'url', 'username', 'password', 'note', 'totp', 'vault'),
      entry: (r) => ({ title: r.name, group: r.vault, url: r.url, username: r.username || r.email, password: r.password, totp: r.totp, notes: r.note,
        custom: r.username && r.email ? [{ name: 'email', value: r.email }] : [] }) },
    { id: 'dashlane-csv', label: 'Dashlane (CSV)',
      match: (h) => hasAll(h, 'title', 'password', 'note', 'url', 'category'),
      entry: (r) => ({ title: r.title, group: r.category, url: r.url, username: r.username || r.username2 || r.username3, password: r.password, totp: r.otpsecret, notes: r.note,
        custom: ['username2', 'username3'].filter((k) => r[k] && r[k] !== (r.username || '') && r[k] !== (r.username || r.username2)).map((k) => ({ name: k, value: r[k] })) }) },
    { id: 'firefox-csv', label: 'Firefox (CSV)',
      match: (h) => hasAll(h, 'url', 'username', 'password', 'httprealm'),
      entry: (r) => ({ title: hostOf(r.url), url: r.url, username: r.username, password: r.password,
        created: r.timecreated ? Number(r.timecreated) : null, modified: r.timepasswordchanged ? Number(r.timepasswordchanged) : null }) },
    { id: 'passwords-csv', label: 'Passwords (Nextcloud) (CSV)',
      match: (h) => hasAll(h, 'label', 'username', 'password') && (h.includes('folder') || h.includes('tags') || h.includes('custom fields')),
      entry: (r) => ({ title: r.label, group: r.folder, url: pick(r, 'url', 'website'), username: r.username, password: r.password, notes: r.notes, tags: splitTags(r.tags) }) },
    { id: 'browser-csv', label: 'Chrome / Edge / Brave / Safari (CSV)',
      match: (h) => hasAll(h, 'url', 'username', 'password') && (h.includes('name') || h.includes('title')),
      entry: (r) => ({ title: pick(r, 'name', 'title') || hostOf(r.url), url: r.url, username: r.username, password: r.password, notes: pick(r, 'note', 'notes') }) },
  ];
  function firstLine(s) { return str(s).split(/\r?\n/)[0]; }
  function splitTags(s) { return str(s).split(/[,;]\s*/).map((t) => t.trim()).filter(Boolean); }
  function hostOf(u) { try { return new URL(u).hostname || str(u); } catch (e) { return str(u); } }
  /** Bitwarden's CSV puts custom fields in one cell, one "name: value" per line. */
  function bitwardenFieldsText(s) {
    return str(s).split(/\r?\n/).map((l) => { const i = l.indexOf(': '); return i > 0 ? { name: l.slice(0, i), value: l.slice(i + 2) } : null; }).filter(Boolean);
  }

  function fromCsv(text) {
    const { headers, records } = table(parseCsv(text));
    const fmt = CSV_FORMATS.find((f) => f.match(headers));
    if (!fmt) return null;
    const entries = records.map((r) => entry(fmt.entry(r))).filter((e) => e.title || e.url || e.username || e.password || e.notes);
    return { format: fmt.id, label: fmt.label, entries, warnings: [], skipped: { attachments: 0, history: 0 } };
  }

  // ------------------------------------------------------------------ Bitwarden JSON
  function fromBitwardenJson(data) {
    if (data && data.encrypted === true) throw fail('encrypted', 'This Bitwarden export is encrypted. Export it again as an unencrypted ".json" file.');
    const folders = {}; (data.folders || []).forEach((f) => { folders[f.id] = f.name; });
    const warnings = []; let notLogin = 0;
    const entries = (data.items || []).map((it) => {
      const login = it.login || {};
      const custom = (it.fields || []).map((f) => ({ name: f.name, value: f.type === 2 ? (f.value === 'true' ? '✓' : '') : f.value, secret: f.type === 1 }));
      const uris = (login.uris || []).map((u) => u && u.uri).filter(Boolean);
      uris.slice(1).forEach((u, i) => custom.push({ name: 'URL ' + (i + 2), value: u }));
      if (it.type === 3 && it.card) { // card
        const c = it.card; custom.push({ name: 'Cardholder', value: c.cardholderName }, { name: 'Brand', value: c.brand }, { name: 'Number', value: c.number, secret: true },
          { name: 'Expiry', value: [c.expMonth, c.expYear].filter(Boolean).join('/') }, { name: 'Security code', value: c.code, secret: true }); notLogin++;
      } else if (it.type === 4 && it.identity) { // identity
        Object.keys(it.identity).forEach((k) => { if (it.identity[k]) custom.push({ name: k, value: it.identity[k], secret: /ssn|passport|license/i.test(k) }); }); notLogin++;
      } else if (it.type === 2) notLogin++;
      return entry({ title: it.name, group: folders[it.folderId] || '', url: uris[0] || '', username: login.username, password: login.password, totp: login.totp, notes: it.notes,
        custom, modified: it.revisionDate || null, created: it.creationDate || null });
    });
    if (notLogin) warnings.push({ code: 'notLogin', n: notLogin });
    return { format: 'bitwarden-json', label: 'Bitwarden (JSON)', entries, warnings, skipped: { attachments: 0, history: 0 } };
  }

  // ------------------------------------------------------------------ what format is this?
  /** @param {string} name file name  @param {string} text its text (CSV / JSON) */
  function fromText(name, text) {
    const t = String(text).replace(/^﻿/, '');
    if (/^\s*[\[{]/.test(t)) {
      let data; try { data = JSON.parse(t); } catch (e) { return null; }
      if (data && (Array.isArray(data.items) || data.encrypted === true) && ('folders' in data || 'encrypted' in data)) return fromBitwardenJson(data);
      return null;
    }
    return fromCsv(t);
  }
  const FORMAT_LIST = ['KeePass (.kdbx)'].concat(CSV_FORMATS.map((f) => f.label)).concat(['Bitwarden (JSON)']);

  function fail(code, message) { const e = new Error(message); e.code = code; return e; }

  // ------------------------------------------------------------------ KeePass (.kdbx)
  function kdbxLib() {
    const k = root.kdbxweb || (typeof require === 'function' ? require('kdbxweb') : null);
    if (!k) throw fail('nolib', 'The KeePass library is not loaded.');
    return k;
  }
  function argon2Lib() {
    return root.hashwasm || (typeof require === 'function' ? require('hash-wasm') : null);
  }
  let argonSet = false;
  function ready() {
    // KeePass files need the browser's own cryptography, which a page has only over https (or on localhost).
    if (!(root.crypto && root.crypto.subtle)) throw fail('insecure', 'This page is not on a secure connection (https), so the browser does not allow the cryptography KeePass files need.');
    const k = kdbxLib();
    if (!argonSet) {
      const hw = argon2Lib();
      if (!hw) throw fail('nolib', 'The Argon2 library is not loaded.');
      // kdbxweb calls this for Argon2 databases: type 0 = Argon2d, 2 = Argon2id; memory in KiB.
      k.CryptoEngine.setArgon2Impl(async (password, salt, memory, iterations, length, parallelism, type) => {
        const run = type === 0 ? hw.argon2d : hw.argon2id;
        const out = await run({ password: new Uint8Array(password), salt: new Uint8Array(salt), parallelism, iterations, memorySize: memory, hashLength: length, outputType: 'binary' });
        return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
      });
      argonSet = true;
    }
    return k;
  }
  function plain(v, k) { return v == null ? '' : (v instanceof k.ProtectedValue ? v.getText() : String(v)); }
  const STD = ['Title', 'UserName', 'Password', 'URL', 'Notes'];
  const TOTP_NAMES = ['otp', 'TOTP Seed', 'TimeOtp-Secret-Base32', 'TimeOtp-Secret'];
  const TOTP_SKIP = ['TOTP Settings', 'TimeOtp-Length', 'TimeOtp-Period', 'TimeOtp-Algorithm'];

  /**
   * @param {ArrayBuffer} data the .kdbx  @param {string} password  @param {ArrayBuffer|null} keyFile
   * @returns {{format, label, name, version, entries, warnings, skipped}}
   */
  async function readKdbx(data, password, keyFile) {
    const k = ready();
    const cred = new k.Credentials(password ? k.ProtectedValue.fromString(password) : null, keyFile || null);
    let db;
    try { db = await k.Kdbx.load(data, cred); } catch (e) {
      if (e && e.code === 'InvalidKey') throw fail('badkey', 'The master password (or key file) is not right, or the file is damaged.');
      if (e && (e.code === 'BadSignature' || e.code === 'InvalidVersion')) throw fail('notkdbx', 'This is not a KeePass 2 (.kdbx) file.');
      if (e && e.code === 'FileCorrupt') throw fail('corrupt', 'The file is damaged.');
      if (e && /argon2 (secret key|assoc data)/.test(str(e.message))) throw fail('unsupported', 'This file uses an Argon2 option that is not supported.');
      throw e;
    }
    const recycle = db.meta && db.meta.recycleBinUuid ? db.meta.recycleBinUuid.id : null;
    const out = []; const skipped = { attachments: 0, history: 0, recycle: 0 };
    (function walk(g, path, isRoot) {
      if (recycle && g.uuid && g.uuid.id === recycle) { skipped.recycle += countEntries(g); return; }
      const here = isRoot ? '' : (path ? path + GROUP_SEP : '') + g.name;
      for (const e of g.entries) {
        const f = e.fields; const custom = []; let totp = '';
        for (const [name, v] of f.entries()) {
          if (STD.includes(name) || TOTP_SKIP.includes(name)) continue;
          const val = plain(v, k);
          if (TOTP_NAMES.includes(name)) { if (!totp && val) totp = val; continue; }
          if (val !== '') custom.push({ name, value: val, secret: v instanceof k.ProtectedValue });
        }
        skipped.attachments += e.binaries ? e.binaries.size : 0;
        skipped.history += e.history ? e.history.length : 0;
        out.push(entry({
          title: plain(f.get('Title'), k), group: here, url: plain(f.get('URL'), k), username: plain(f.get('UserName'), k), password: plain(f.get('Password'), k),
          totp, notes: plain(f.get('Notes'), k), tags: e.tags || [], custom,
          created: e.times && e.times.creationTime ? e.times.creationTime.getTime() : null, modified: e.times && e.times.lastModTime ? e.times.lastModTime.getTime() : null,
        }));
      }
      for (const c of g.groups) walk(c, here, false);
    })(db.getDefaultGroup(), '', true);
    return { format: 'kdbx', label: 'KeePass (.kdbx)', name: db.meta && db.meta.name ? db.meta.name : '', version: db.header.versionMajor + '.' + db.header.versionMinor,
      entries: out, warnings: [], skipped };
  }
  function countEntries(g) { let n = g.entries.length; g.groups.forEach((c) => { n += countEntries(c); }); return n; }

  const KDF_LEVELS = { standard: { memoryMiB: 64, iterations: 8, parallelism: 2 }, strong: { memoryMiB: 256, iterations: 16, parallelism: 4 } };

  /**
   * Write entries as a KDBX 4 file (AES-256, Argon2d). Opens in KeePass 2.35 or later and in KeePassXC.
   * @param {object[]} entries entry model  @param {{password:string, keyFile?:ArrayBuffer, name?:string, kdf?:'argon2d'|'argon2id', level?:'standard'|'strong'}} o
   * @returns {Promise<ArrayBuffer>}
   */
  async function writeKdbx(entries, o) {
    const k = ready();
    if (!o || !o.password) throw fail('nopassword', 'A master password is needed.');
    const cred = new k.Credentials(k.ProtectedValue.fromString(o.password), o.keyFile || null);
    const db = k.Kdbx.create(cred, o.name || 'RegiBase');
    db.setVersion(4);
    const id = o.kdf === 'argon2id' ? k.Consts.KdfId.Argon2id : k.Consts.KdfId.Argon2d;
    db.setKdf(id);
    const lv = KDF_LEVELS[o.level] || KDF_LEVELS.standard; const VT = k.VarDictionary.ValueType;
    db.header.kdfParameters.set('M', VT.UInt64, new k.Int64(lv.memoryMiB * 1024 * 1024));
    db.header.kdfParameters.set('I', VT.UInt64, new k.Int64(lv.iterations));
    db.header.kdfParameters.set('P', VT.UInt32, lv.parallelism);
    const root_ = db.getDefaultGroup(); const cache = {};
    const groupFor = (path) => {
      if (!path) return root_;
      let g = root_; let acc = '';
      for (const part of path.split(GROUP_SEP).map((s) => s.trim()).filter(Boolean)) {
        acc += GROUP_SEP + part;
        if (!cache[acc]) cache[acc] = db.createGroup(g, part);
        g = cache[acc];
      }
      return g;
    };
    const prot = (s) => k.ProtectedValue.fromString(s);
    for (const e of entries) {
      const en = db.createEntry(groupFor(e.group));
      en.fields.set('Title', e.title); en.fields.set('UserName', e.username); en.fields.set('Password', prot(e.password));
      en.fields.set('URL', e.url); en.fields.set('Notes', e.notes);
      if (e.totp) en.fields.set('otp', prot(e.totp));       // KeePassXC reads "otp"; KeePass keeps it as a protected string
      const used = new Set(STD.concat(['otp']));
      for (const c of e.custom) {
        let name = c.name; while (used.has(name)) name += ' ';
        used.add(name); en.fields.set(name, c.secret ? prot(c.value) : c.value);
      }
      en.tags = e.tags.slice();
      if (e.created) en.times.creationTime = new Date(e.created);
      if (e.modified) en.times.lastModTime = new Date(e.modified);
    }
    return db.save();
  }

  // ------------------------------------------------------------------ entries <-> a RegiBase collection
  const FIELD_KEYS = { title: 'title', group: 'group', url: 'url', username: 'username', password: 'password', totp: 'totp', memo: 'memo', tags: 'tags' };

  /**
   * The collection that holds the entries, and one record per entry.
   * @param {object[]} entries @param {Record<string,string>} L labels: title, group, url, username, password, totp, notes, tags
   * @returns {{fields: object[], records: object[], moved: number}}
   */
  function toCollection(entries, L) {
    const used = (fn) => entries.some(fn);
    const fields = [{ key: FIELD_KEYS.title, label: L.title, type: 'text', is_title: true, required: false }];
    if (used((e) => e.group)) fields.push({ key: FIELD_KEYS.group, label: L.group, type: 'text' });
    if (used((e) => e.url)) fields.push({ key: FIELD_KEYS.url, label: L.url, type: 'url' });
    if (used((e) => e.username)) fields.push({ key: FIELD_KEYS.username, label: L.username, type: 'text' });
    if (used((e) => e.password)) fields.push({ key: FIELD_KEYS.password, label: L.password, type: 'password', secret: true });
    if (used((e) => e.totp)) fields.push({ key: FIELD_KEYS.totp, label: L.totp, type: 'password', secret: true });
    if (used((e) => e.notes)) fields.push({ key: FIELD_KEYS.memo, label: L.notes, type: 'textarea' });
    if (used((e) => e.tags.length)) fields.push({ key: FIELD_KEYS.tags, label: L.tags, type: 'text' });
    // custom fields: one per distinct name, as many as fit
    const names = []; const secret = {};
    for (const e of entries) for (const c of e.custom) { if (!names.includes(c.name)) names.push(c.name); if (c.secret) secret[c.name] = true; }
    const kept = names.slice(0, CUSTOM_MAX); const keyOf = {};
    kept.forEach((n, i) => { keyOf[n] = 'c' + (i + 1); fields.push({ key: keyOf[n], label: n, type: secret[n] ? 'password' : 'text', secret: !!secret[n] }); });
    let moved = 0;
    const records = entries.map((e) => {
      const d = {};
      const set = (key, v) => { if (v !== '' && v != null) d[key] = v; };
      set(FIELD_KEYS.title, e.title || e.url || e.username || '(no title)'); set(FIELD_KEYS.group, e.group); set(FIELD_KEYS.url, e.url); set(FIELD_KEYS.username, e.username);
      set(FIELD_KEYS.password, e.password); set(FIELD_KEYS.totp, e.totp); set(FIELD_KEYS.tags, e.tags.join(', '));
      let notes = e.notes;
      for (const c of e.custom) { if (keyOf[c.name]) set(keyOf[c.name], c.value); else { notes += (notes ? '\n' : '') + c.name + ': ' + c.value; moved++; } }
      set(FIELD_KEYS.memo, notes);
      return d;
    });
    if (moved && !fields.some((f) => f.key === FIELD_KEYS.memo)) fields.push({ key: FIELD_KEYS.memo, label: L.notes, type: 'textarea' });
    return { fields, records, moved };
  }

  const ROLE_KEYS = {
    title: ['title', 'name', 'service', 'service_name', 'site', 'card_name', 'bank_name'],
    group: ['group', 'category', 'folder'],
    url: ['url', 'website', 'web_site', 'link', 'login_url'],
    username: ['username', 'user', 'login_id', 'login', 'id', 'user_id', 'userid', 'account'],
    password: ['password', 'login_password', 'pass', 'passwd'],
    totp: ['totp', 'otp', 'two_factor', 'otpauth'],
    notes: ['memo', 'notes', 'note', 'remarks', 'comment', 'comments', 'description'],
    tags: ['tags', 'tag'],
  };
  /**
   * The entries of a collection. Roles are found by the field's key (the fields this module makes
   * are recognised exactly; the templates mostly are) and then by what the field is; every other
   * field goes along as a custom field, protected when it is secret.
   * @param {object[]} fields @param {object[]} records [{data: {key: plainValue}}]
   */
  function fromCollection(fields, records) {
    const byKey = {}; fields.forEach((f) => { byKey[f.key] = f; });
    const role = {}; const taken = new Set();
    const claim = (r, key) => { if (key && !taken.has(key)) { role[r] = key; taken.add(key); } };
    const find = (r, test) => { if (role[r]) return; const f = fields.find((x) => !taken.has(x.key) && test(x)); if (f) claim(r, f.key); };
    for (const r of Object.keys(ROLE_KEYS)) for (const k of ROLE_KEYS[r]) { if (!role[r] && byKey[k] && !taken.has(k)) claim(r, k); }
    find('title', (f) => f.is_title);
    find('url', (f) => f.type === 'url');
    find('password', (f) => f.secret && f.type === 'password');
    find('notes', (f) => f.type === 'textarea' && !f.secret);
    find('username', (f) => f.type === 'email');
    return records.map((rec) => {
      const d = rec.data || rec; const get = (r) => (role[r] ? str(d[role[r]]) : '');
      const custom = [];
      for (const f of fields) {
        if (taken.has(f.key)) continue;
        const v = str(d[f.key]); if (v === '') continue;
        custom.push({ name: f.label || f.key, value: v, secret: !!f.secret });
      }
      return entry({ title: get('title'), group: get('group'), url: get('url'), username: get('username'), password: get('password'), totp: get('totp'), notes: get('notes'),
        tags: splitTags(get('tags')), custom });
    });
  }

  return { parseCsv, toCsv, fromCsv, fromText, fromBitwardenJson, readKdbx, writeKdbx, toCollection, fromCollection, entry, CSV_FORMATS, FORMAT_LIST, KDF_LEVELS };
}));
