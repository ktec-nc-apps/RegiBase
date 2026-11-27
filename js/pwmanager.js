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
 *     uuid?, created?, modified? }
 *   group is a path with "/" between the levels ("Bank/Cards"), "" for none.
 *   uuid is the KeePass entry's own ID (base64), "" for the other formats. A collection made from
 *   a .kdbx keeps it in the field "kp_uuid", so a later "refresh from the KeePass file" finds
 *   the same entry again even after it was renamed or moved to another group.
 *   totp is an otpauth:// URI, or the bare Base32 secret.
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
      uuid: str(o.uuid), created: o.created || null, modified: o.modified || null,
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
  const TOTP_NAMES = ['otp', 'TOTP Seed', 'TimeOtp-Secret-Base32', 'TimeOtp-Secret', 'TimeOtp-Secret-Hex', 'TimeOtp-Secret-Base64'];
  const TOTP_SKIP = ['TOTP Settings', 'TimeOtp-Length', 'TimeOtp-Period', 'TimeOtp-Algorithm'];

  /**
   * The one-time password of an entry, however it is kept: KeePassXC's "otp" (an otpauth:// URI),
   * KeePassXC's older "TOTP Seed" + "TOTP Settings" ("30;6", "30;S" for Steam), or KeePass 2's own
   * "TimeOtp-Secret-*" + "TimeOtp-Length/-Period/-Algorithm". Returned as one otpauth:// URI (or the
   * bare Base32 secret when nothing is set but the secret), so the period, the digits and the
   * algorithm are not lost.
   */
  function kdbxTotp(get) {
    const otp = get('otp').trim();
    if (otp) return otp;
    const seed = get('TOTP Seed').trim();
    if (seed) {
      const st = get('TOTP Settings').trim();
      if (!st) return seed;
      const [period, digits] = st.split(';');
      const p = { secret: b32clean(seed) };
      if (Number(period) > 0 && Number(period) !== 30) p.period = String(Number(period));
      if (digits === 'S') p.encoder = 'steam'; else if (Number(digits) > 0 && Number(digits) !== 6) p.digits = String(Number(digits));
      return otpUri(p);
    }
    let secret = get('TimeOtp-Secret-Base32').trim();
    if (!secret) { const hex = get('TimeOtp-Secret-Hex').replace(/\s+/g, ''); if (/^([0-9a-f]{2})+$/i.test(hex)) secret = b32encode(hex.match(/../g).map((h) => parseInt(h, 16))); }
    if (!secret) { const b64 = get('TimeOtp-Secret-Base64').trim(); if (b64) { try { secret = b32encode(Array.from(atobAny(b64))); } catch (e) { /* not Base64 */ } } }
    if (!secret) { const raw = get('TimeOtp-Secret'); if (raw) secret = b32encode(Array.from(utf8(raw))); }
    if (!secret) return '';
    const p = { secret: b32clean(secret) };
    const len = Number(get('TimeOtp-Length')); const per = Number(get('TimeOtp-Period'));
    const alg = get('TimeOtp-Algorithm').toUpperCase().replace(/^HMAC-/, '').replace('-', '');
    if (len > 0 && len !== 6) p.digits = String(len);
    if (per > 0 && per !== 30) p.period = String(per);
    if (alg === 'SHA256' || alg === 'SHA512') p.algorithm = alg;
    return (p.digits || p.period || p.algorithm) ? otpUri(p) : p.secret;
  }
  function otpUri(p) { return 'otpauth://totp/?' + Object.keys(p).map((k) => k + '=' + encodeURIComponent(p[k])).join('&'); }
  function utf8(s) { return new TextEncoder().encode(s); }
  function atobAny(b64) {
    const bin = typeof atob === 'function' ? atob(b64) : Buffer.from(b64, 'base64').toString('binary');
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  }

  // ------------------------------------------------------------------ one-time passwords (TOTP, RFC 6238)
  const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  function b32clean(s) { return str(s).toUpperCase().replace(/[\s=-]+/g, ''); }
  function b32decode(s) {
    s = b32clean(s); const out = []; let bits = 0; let val = 0;
    for (const c of s) {
      const i = B32.indexOf(c); if (i < 0) throw fail('badtotp', 'This is not a Base32 secret.');
      val = (val << 5) | i; bits += 5;
      if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; }
    }
    return new Uint8Array(out);
  }
  function b32encode(bytes) {
    let out = ''; let bits = 0; let val = 0;
    for (const b of bytes) { val = (val << 8) | b; bits += 8; while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; } }
    if (bits > 0) out += B32[(val << (5 - bits)) & 31];
    return out;
  }
  /** What a TOTP value says: {secret, digits, period, algorithm, steam}. Throws 'badtotp' when it is not one. */
  function parseTotp(spec) {
    spec = str(spec).trim();
    const o = { secret: '', digits: 6, period: 30, algorithm: 'SHA-1', steam: false };
    if (/^otpauth:\/\//i.test(spec)) {
      let u; try { u = new URL(spec); } catch (e) { throw fail('badtotp', 'This is not an otpauth:// address.'); }
      if (!/^totp$/i.test(u.host || u.pathname.replace(/^\/\//, '').split('/')[0])) throw fail('badtotp', 'Only time-based one-time passwords (TOTP) are supported.');
      const q = u.searchParams; o.secret = q.get('secret') || '';
      if (Number(q.get('digits')) > 0) o.digits = Number(q.get('digits'));
      if (Number(q.get('period')) > 0) o.period = Number(q.get('period'));
      const a = (q.get('algorithm') || '').toUpperCase().replace('-', '');
      if (a === 'SHA256') o.algorithm = 'SHA-256'; else if (a === 'SHA512') o.algorithm = 'SHA-512';
      if ((q.get('encoder') || '').toLowerCase() === 'steam') o.steam = true;
    } else o.secret = spec;
    const key = b32decode(o.secret);
    if (!key.length) throw fail('badtotp', 'The secret is empty.');
    if (o.digits < 4 || o.digits > 10) o.digits = 6;
    return { ...o, key };
  }
  /**
   * The code for now: {code, period, remaining (seconds)}. Uses the browser's HMAC.
   * @param {string} spec otpauth:// URI or Base32 secret  @param {number} [nowMs]
   */
  async function totpCode(spec, nowMs) {
    const p = parseTotp(spec);
    const cr = root.crypto || (typeof globalThis !== 'undefined' ? globalThis.crypto : null);
    const subtle = cr && cr.subtle;
    if (!subtle) throw fail('insecure', 'This page is not on a secure connection (https).');
    const now = Math.floor((nowMs == null ? Date.now() : nowMs) / 1000);
    const counter = Math.floor(now / p.period);
    const msg = new Uint8Array(8); let c = counter;
    for (let i = 7; i >= 0; i--) { msg[i] = c & 255; c = Math.floor(c / 256); }
    const key = await subtle.importKey('raw', p.key, { name: 'HMAC', hash: p.algorithm }, false, ['sign']);
    const h = new Uint8Array(await subtle.sign('HMAC', key, msg));
    const off = h[h.length - 1] & 15;
    let bin = ((h[off] & 127) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
    let code;
    if (p.steam) { const A = '23456789BCDFGHJKMNPQRTVWXY'; code = ''; for (let i = 0; i < 5; i++) { code += A[bin % A.length]; bin = Math.floor(bin / A.length); } }
    else code = String(bin % (10 ** p.digits)).padStart(p.digits, '0');
    return { code, period: p.period, remaining: p.period - (now % p.period) };
  }

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
    const skipped = { attachments: 0, history: 0, recycle: 0 };
    const out = walkKdbx(db, k, skipped).map((x) => x.entry);
    const res = { format: 'kdbx', label: 'KeePass (.kdbx)', name: db.meta && db.meta.name ? db.meta.name : '', version: db.header.versionMajor + '.' + db.header.versionMinor,
      entries: out, warnings: [], skipped };
    // the opened database itself, for writing the changes back (syncSave); not enumerable, so the result can still be copied as data
    Object.defineProperty(res, 'db', { value: db, enumerable: false });
    return res;
  }
  function countEntries(g) { let n = g.entries.length; g.groups.forEach((c) => { n += countEntries(c); }); return n; }
  function recycleId(db) { return db.meta && db.meta.recycleBinUuid ? db.meta.recycleBinUuid.id : null; }
  /** Every entry outside the recycle bin: [{e (the KdbxEntry), entry (the entry model)}]. */
  function walkKdbx(db, k, skipped) {
    const recycle = recycleId(db); const out = [];
    (function walk(g, path, isRoot) {
      if (recycle && g.uuid && g.uuid.id === recycle) { if (skipped) skipped.recycle += countEntries(g); return; }
      const here = isRoot ? '' : (path ? path + GROUP_SEP : '') + g.name;
      for (const e of g.entries) {
        if (skipped) { skipped.attachments += e.binaries ? e.binaries.size : 0; skipped.history += e.history ? e.history.length : 0; }
        out.push({ e, entry: entryOf(e, here, k) });
      }
      for (const c of g.groups) walk(c, here, false);
    })(db.getDefaultGroup(), '', true);
    return out;
  }
  function entryOf(e, group, k) {
    const f = e.fields; const custom = [];
    const totp = kdbxTotp((name) => plain(f.get(name), k));
    for (const [name, v] of f.entries()) {
      if (STD.includes(name) || TOTP_SKIP.includes(name) || TOTP_NAMES.includes(name)) continue;
      const val = plain(v, k);
      if (val !== '') custom.push({ name, value: val, secret: v instanceof k.ProtectedValue });
    }
    return entry({
      title: plain(f.get('Title'), k), group, url: plain(f.get('URL'), k), username: plain(f.get('UserName'), k), password: plain(f.get('Password'), k),
      totp, notes: plain(f.get('Notes'), k), tags: e.tags || [], custom, uuid: e.uuid && e.uuid.id ? e.uuid.id : '',
      created: e.times && e.times.creationTime ? e.times.creationTime.getTime() : null, modified: e.times && e.times.lastModTime ? e.times.lastModTime.getTime() : null,
    });
  }
  function groupPath(db, g) {
    const names = []; const top = db.getDefaultGroup();
    while (g && g !== top) { names.unshift(g.name); g = g.parentGroup; }
    return names.join(GROUP_SEP);
  }

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
    const usedIds = new Set();
    for (const e of entries) {
      const en = db.createEntry(groupFor(e.group));
      // the KeePass ID it came with (kp_uuid) is kept, so the file still matches the collection
      if (/^[A-Za-z0-9+/]{22}==$/.test(e.uuid || '') && !usedIds.has(e.uuid)) { en.uuid = new k.KdbxUuid(e.uuid); usedIds.add(e.uuid); }
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
  const UUID_KEY = 'kp_uuid';
  /** The field that keeps each entry's KeePass ID. Not shown in the list, the table or the cards. */
  function uuidField(label, source) {
    const f = { key: UUID_KEY, label: label || 'KeePass ID', type: 'text', list_show: false, table_show: false, card_show: false };
    if (source && source.path) f.options = { kdbx: { path: String(source.path) } };
    return f;
  }

  /**
   * The collection that holds the entries, and one record per entry.
   * @param {object[]} entries @param {Record<string,string>} L labels: title, group, url, username, password, totp, notes, tags, kpid
   * @param {{path?: string}} [source] the .kdbx in the user's Files it came from, remembered for "refresh"
   * @returns {{fields: object[], records: object[], moved: number}}
   */
  function toCollection(entries, L, source) {
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
    const withUuid = used((e) => e.uuid);
    if (withUuid) fields.push(uuidField(L.kpid, source));
    let moved = 0;
    const records = entries.map((e) => {
      const d = {};
      if (withUuid && e.uuid) d[UUID_KEY] = e.uuid;
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
  function roles(fields) {
    const byKey = {}; fields.forEach((f) => { byKey[f.key] = f; });
    const role = {}; const taken = new Set([UUID_KEY]);
    const claim = (r, key) => { if (key && !taken.has(key)) { role[r] = key; taken.add(key); } };
    const find = (r, test) => { if (role[r]) return; const f = fields.find((x) => !taken.has(x.key) && test(x)); if (f) claim(r, f.key); };
    for (const r of Object.keys(ROLE_KEYS)) for (const k of ROLE_KEYS[r]) { if (!role[r] && byKey[k] && !taken.has(k)) claim(r, k); }
    find('title', (f) => f.is_title);
    find('url', (f) => f.type === 'url');
    find('password', (f) => f.secret && f.type === 'password');
    find('notes', (f) => f.type === 'textarea' && !f.secret);
    find('username', (f) => f.type === 'email');
    return { role, taken };
  }
  function fromCollection(fields, records) {
    const { role, taken } = roles(fields);
    return records.map((rec) => {
      const d = rec.data || rec; const get = (r) => (role[r] ? str(d[role[r]]) : '');
      const custom = [];
      for (const f of fields) {
        if (taken.has(f.key)) continue;
        const v = str(d[f.key]); if (v === '') continue;
        custom.push({ name: f.label || f.key, value: v, secret: !!f.secret });
      }
      return entry({ title: get('title'), group: get('group'), url: get('url'), username: get('username'), password: get('password'), totp: get('totp'), notes: get('notes'),
        tags: splitTags(get('tags')), custom, uuid: str(d[UUID_KEY]) });
    });
  }

  // ------------------------------------------------------------------ refresh a collection from the file
  const norm = (s) => str(s).trim().toLowerCase();
  const FILE_TYPES = ['image', 'image_crop', 'file'];   // fields that hold a file of Nextcloud: never written to KeePass

  /**
   * What the collection and the file have in common: the fields each role of an entry goes to
   * (fields are added when the file has something the collection has no field for), the custom
   * fields by label, and the fields the file "owns". Shared by the refresh and the sync.
   * With sync, every field of the collection is owned (a field added in RegiBase goes to KeePass
   * as a custom field), except the KeePass ID and the file fields.
   */
  function prep(fields, entries, o, sync) {
    const out = fields.map((f) => ({ ...f }));
    const { role, taken } = roles(out);
    const newFields = [];
    const addField = (f) => { out.push(f); newFields.push(f.label); return f.key; };
    const freeKey = (base) => { let i = 1; while (out.some((f) => f.key === base + i)) i++; return base + i; };
    // the roles the file needs that the collection has no field for
    const ROLE_NEW = {
      group: () => ({ key: role.group || FIELD_KEYS.group, label: o.group || 'Group', type: 'text' }),
      url: () => ({ key: FIELD_KEYS.url, label: 'URL', type: 'url' }),
      username: () => ({ key: FIELD_KEYS.username, label: o.username || 'Username', type: 'text' }),
      password: () => ({ key: FIELD_KEYS.password, label: o.password || 'Password', type: 'password', secret: true }),
      totp: () => ({ key: FIELD_KEYS.totp, label: o.totp || 'TOTP', type: 'password', secret: true }),
      notes: () => ({ key: FIELD_KEYS.memo, label: o.notes || 'Notes', type: 'textarea' }),
      tags: () => ({ key: FIELD_KEYS.tags, label: o.tags || 'Tags', type: 'text' }),
    };
    const want = { group: (e) => e.group, url: (e) => e.url, username: (e) => e.username, password: (e) => e.password, totp: (e) => e.totp, notes: (e) => e.notes, tags: (e) => e.tags.length };
    for (const r of Object.keys(want)) {
      if (role[r] || !entries.some(want[r])) continue;
      const f = ROLE_NEW[r]();
      if (out.some((x) => x.key === f.key)) f.key = freeKey(f.key + '_');
      role[r] = addField(f); taken.add(f.key);
    }
    if (!role.title) { const t = out.find((f) => f.is_title) || out[0]; if (t) role.title = t.key; }
    // custom fields: matched by label; a new name gets a new field
    const customKey = {};
    for (const f of out) if (!taken.has(f.key) && f.label && !(f.label in customKey)) customKey[f.label] = f.key;
    const fileKeys = new Set(Object.values(role)); // the fields the file "owns": the roles, and the custom names it has
    for (const e of entries) for (const c of e.custom) {
      if (!customKey[c.name]) customKey[c.name] = addField({ key: freeKey('c'), label: c.name, type: c.secret ? 'password' : 'text', secret: !!c.secret });
      fileKeys.add(customKey[c.name]);
    }
    if (sync) for (const f of out) if (f.key !== UUID_KEY && !FILE_TYPES.includes(f.type) && f.label && customKey[f.label] === f.key && !STD.includes(f.label) && !TOTP_NAMES.includes(f.label) && !TOTP_SKIP.includes(f.label)) fileKeys.add(f.key);
    for (const k of Object.values(role)) if (k) { const f = out.find((x) => x.key === k); if (f && FILE_TYPES.includes(f.type)) fileKeys.delete(k); }
    if (!out.some((f) => f.key === UUID_KEY)) addField(uuidField(o.kpid, o.source));
    else if (o.source && o.source.path) {
      const u = out.find((f) => f.key === UUID_KEY);
      const was = u.options && u.options.kdbx ? u.options.kdbx.path : '';
      if (was !== o.source.path) u.options = { ...(u.options && typeof u.options === 'object' && !Array.isArray(u.options) ? u.options : {}), kdbx: { ...(u.options && u.options.kdbx ? u.options.kdbx : {}), path: String(o.source.path) } };
    }
    fileKeys.delete(UUID_KEY);
    const labelOf = (k) => { const f = out.find((x) => x.key === k); return f ? f.label : k; };
    /** The values an entry gives the owned fields ('' for the ones it does not have). */
    const dataOf = (e) => {
      const d = {};
      const put = (r, v) => { if (role[r]) d[role[r]] = str(v); };
      put('title', e.title || e.url || e.username || '(no title)'); put('group', e.group); put('url', e.url); put('username', e.username);
      put('password', e.password); put('totp', e.totp); put('notes', e.notes); put('tags', e.tags.join(', '));
      for (const k of fileKeys) if (!(k in d)) d[k] = '';
      for (const c of e.custom) d[customKey[c.name]] = c.value;
      if (e.uuid) d[UUID_KEY] = e.uuid;
      return d;
    };
    const titleOf = (d) => str(role.title ? d[role.title] : '') || '(no title)';
    const fieldsChanged = newFields.length > 0 || out.some((f, i) => fields[i] && f.options !== fields[i].options);
    return { out, role, customKey, fileKeys, newFields, labelOf, dataOf, titleOf, fieldsChanged };
  }

  /**
   * Which record each entry is: by KeePass ID; a record that has none yet (a collection imported
   * before IDs were kept, or a record made in RegiBase) once by group + title + user name, when
   * that is unique on both sides.
   * @returns {{pairs: {e, r: object|null, byName: boolean}[], left: object[]}} pairs in the order of the
   *   entries; left = the records no entry went to
   */
  function matchEntries(records, entries, role) {
    const byUuid = {}; const nameKey = (g, t, u) => norm(g) + '\u0001' + norm(t) + '\u0001' + norm(u);
    const recName = {}; const recNameCount = {};
    for (const r of records) {
      const d = r.data || {};
      if (d[UUID_KEY]) byUuid[d[UUID_KEY]] = r;
      else { const k = nameKey(role.group ? d[role.group] : '', role.title ? d[role.title] : '', role.username ? d[role.username] : ''); recName[k] = r; recNameCount[k] = (recNameCount[k] || 0) + 1; }
    }
    const entNameCount = {}; for (const e of entries) { const k = nameKey(e.group, e.title, e.username); entNameCount[k] = (entNameCount[k] || 0) + 1; }
    const seen = new Set(); const pairs = [];
    for (const e of entries) {
      let r = e.uuid ? byUuid[e.uuid] : null; let byName = false;
      if (r && seen.has(r.id)) r = null;
      if (!r) {
        const k = nameKey(e.group, e.title, e.username);
        if (recNameCount[k] === 1 && entNameCount[k] === 1 && !seen.has(recName[k].id)) { r = recName[k]; byName = true; }
      }
      if (r) seen.add(r.id);
      pairs.push({ e, r: r || null, byName });
    }
    return { pairs, left: records.filter((r) => !seen.has(r.id)) };
  }

  /**
   * What "refresh from the KeePass file" would change in a collection. KeePass is the master:
   * nothing is ever written to the file. Entries are matched by their KeePass ID; a record that
   * has none yet (a collection imported before IDs were kept) is matched once by group + title +
   * user name, when that is unique on both sides, and gets the ID from then on. Records made in
   * RegiBase (no ID, no match) are left alone. Fields the file does not know (added in RegiBase)
   * are left alone too.
   *
   * @param {object[]} fields the collection's fields
   * @param {{id, data}[]} records with the secret values already decrypted
   * @param {object[]} entries from the file
   * @param {{kpid?: string, notes?: string, source?: {path?: string}}} [o]
   * @returns {{add: object[], update: {id, title, data, changed: string[]}[], gone: {id, title}[], same: number,
   *           fields: object[]|null, newFields: string[], byName: number}}
   *   add/update data are the plain values of the fields the file sets (update: merged onto the record);
   *   fields is the new field list when fields had to be added (null when unchanged).
   */
  function planRefresh(fields, records, entries, o) {
    o = o || {};
    const P = prep(fields, entries, o, false);
    const plan = { add: [], update: [], gone: [], same: 0, fields: P.fieldsChanged ? P.out : null, newFields: P.newFields, byName: 0 };
    const M = matchEntries(records, entries, P.role);
    for (const { e, r, byName } of M.pairs) {
      const d = P.dataOf(e);
      if (!r) { const a = {}; for (const k of Object.keys(d)) if (d[k] !== '') a[k] = d[k]; plan.add.push(a); continue; }
      if (byName) plan.byName++;
      const old = r.data || {}; const changed = [];
      for (const k of Object.keys(d)) if (str(old[k]) !== d[k]) changed.push(P.labelOf(k));
      if (!changed.length) { plan.same++; continue; }
      const merged = { ...old };
      for (const k of Object.keys(d)) { if (d[k] === '') delete merged[k]; else merged[k] = d[k]; }
      plan.update.push({ id: r.id, title: P.titleOf(merged), data: merged, changed: changed.filter((l, i) => changed.indexOf(l) === i) });
    }
    for (const r of M.left) if (r.data && r.data[UUID_KEY]) plan.gone.push({ id: r.id, title: P.titleOf(r.data) });
    return plan;
  }

  // ------------------------------------------------------------------ sync both ways (writes the file)
  /**
   * The sync state a collection keeps (in the options of its KeePass ID field): for each entry
   * that was in step at the last sync, [the entry's last change in KeePass (ms), the record's
   * updated_at]. Only times and IDs, never a value or a hash of one.
   */
  function syncState(fields) {
    const u = (fields || []).find((f) => f.key === UUID_KEY);
    const s = u && u.options && u.options.kdbx && u.options.kdbx.sync;
    return s && typeof s === 'object' && !Array.isArray(s) ? s : {};
  }
  const msOf = (t) => { const n = Date.parse(t || ''); return Number.isFinite(n) ? n : 0; };

  /**
   * What "sync with the KeePass file" would do, both ways, the way KeePass's own Synchronize
   * works: a change made on one side only goes to the other; when both sides changed the same
   * entry since the last sync, the newer change wins field by field (a value one side does not
   * have is kept from the other), and the user may choose the other side. KeePass keeps the old
   * version of every entry it changes in the entry's history; RegiBase keeps it in the record's
   * versions.
   *   - an entry new in KeePass becomes a record; a record new in RegiBase becomes an entry;
   *   - an entry deleted in KeePass (or moved to its recycle bin) and a record deleted in RegiBase
   *     are deleted on the other side only when the user ticks that (deletedRb / deletedKp).
   * Nothing is changed here: syncApply does it.
   *
   * @param {object[]} fields @param {{id, data, updated_at}[]} records (secrets decrypted)
   * @param {{entries, db}} file the result of readKdbx  @param {object} [o] labels, as for planRefresh
   */
  function planSync(fields, records, file, o) {
    o = o || {};
    const entries = file.entries;
    const P = prep(fields, entries, o, true);
    const state = syncState(fields);
    const M = matchEntries(records, entries, P.role);
    const plan = { toRb: [], toKp: [], conflicts: [], addRb: [], addKp: [], deletedKp: [], deletedRb: [], same: 0, byName: 0,
      newFields: P.newFields, fields: P.fieldsChanged ? P.out : null };
    const keys = [...P.fileKeys];
    const diff = (a, b) => keys.filter((k) => str(a[k]) !== str(b[k]));
    const labels = (ks) => ks.map(P.labelOf).filter((l, i, a) => a.indexOf(l) === i);
    // The import puts the custom fields it had no room for (more than CUSTOM_MAX names) into the
    // notes as "name: value" lines. Those notes are the entry's notes, not a change made in RegiBase:
    // the custom fields now get fields of their own, and the notes go back to what KeePass has.
    const hadLabel = new Set(fields.map((f) => f.label));
    const importNotes = (e) => { let n = e.notes; for (const c of e.custom) if (!hadLabel.has(c.name)) n += (n ? '\n' : '') + c.name + ': ' + c.value; return n; };
    for (const { e, r, byName } of M.pairs) {
      const E = P.dataOf(e);
      if (r && P.role.notes && r.data) {
        const nk = P.role.notes; const rn = str(r.data[nk]);
        if (rn !== E[nk] && rn === importNotes(e)) r.data = { ...r.data, [nk]: E[nk] };   // on the record given, so syncApply sees the same
      }
      if (!r) {
        if (e.uuid && state[e.uuid]) { plan.deletedRb.push({ uuid: e.uuid, title: P.titleOf(E) }); continue; }   // was in step, so it was deleted in RegiBase
        const a = {}; for (const k of Object.keys(E)) if (E[k] !== '') a[k] = E[k];
        plan.addRb.push({ uuid: e.uuid, title: P.titleOf(E), data: a }); continue;
      }
      if (byName) plan.byName++;
      const R = r.data || {};
      const ch = diff(E, R);
      const item = { id: r.id, uuid: e.uuid, title: P.titleOf(R), changed: labels(ch), keys: ch, byName,
        kpTime: e.modified || 0, rbTime: msOf(r.updated_at) };
      if (!ch.length) { plan.same++; if (byName || str(R[UUID_KEY]) !== e.uuid) plan.toRb.push({ ...item, idOnly: true }); continue; }
      const base = state[e.uuid];
      const kpChanged = !base || item.kpTime > Number(base[0]);
      const rbChanged = !base || String(r.updated_at || '') !== String(base[1]);
      if (base && kpChanged && !rbChanged) plan.toRb.push(item);
      else if (base && rbChanged && !kpChanged) plan.toKp.push(item);
      else plan.conflicts.push({ ...item, winner: item.kpTime >= item.rbTime ? 'kp' : 'rb', first: !base });
    }
    for (const r of M.left) {
      const d = r.data || {};
      if (d[UUID_KEY]) plan.deletedKp.push({ id: r.id, uuid: d[UUID_KEY], title: P.titleOf(d) });   // its entry is gone from KeePass
      else plan.addKp.push({ id: r.id, title: P.titleOf(d) });                                     // made in RegiBase
    }
    Object.defineProperty(plan, 'ctx', { value: { P, M, file, records, state, o }, enumerable: false });
    return plan;
  }

  const KP2_ALG = { 'SHA-1': 'HMAC-SHA-1', 'SHA-256': 'HMAC-SHA-256', 'SHA-512': 'HMAC-SHA-512' };
  /**
   * Put a one-time password back the way the entry keeps it: KeePass 2's TimeOtp-*, KeePassXC's
   * older TOTP Seed/Settings, or "otp" (an otpauth:// URI: KeePassXC, KeePassDX, Keepass2Android,
   * Strongbox). An entry that had none gets TimeOtp-* in a file KeePass 2 wrote, "otp" otherwise.
   */
  function writeTotp(en, value, k, kp2, title) {
    const f = en.fields; const has = (n) => f.has(n);
    const hadKp2 = ['TimeOtp-Secret-Base32', 'TimeOtp-Secret', 'TimeOtp-Secret-Hex', 'TimeOtp-Secret-Base64'].some(has);
    const hadSeed = has('TOTP Seed'); const hadOtp = has('otp');
    const clear = () => { for (const n of TOTP_NAMES.concat(TOTP_SKIP)) f.delete(n); };
    value = str(value).trim();
    if (!value) { clear(); return; }
    let p = null; try { p = parseTotp(value); } catch (e) { p = null; }
    const prot = (s) => k.ProtectedValue.fromString(s);
    const asUri = () => {
      if (/^otpauth:\/\//i.test(value)) return value;
      const q = { secret: b32clean(p.secret) };
      if (p.period !== 30) q.period = String(p.period); if (p.digits !== 6) q.digits = String(p.digits);
      if (p.algorithm !== 'SHA-1') q.algorithm = p.algorithm.replace('-', '');
      if (p.steam) q.encoder = 'steam';
      return 'otpauth://totp/' + encodeURIComponent(title || 'RegiBase') + '?' + Object.keys(q).map((x) => x + '=' + encodeURIComponent(q[x])).join('&');
    };
    if (!p) { clear(); f.set('otp', prot(value)); return; }                       // not one we can read: kept as it is
    if (!hadOtp && !hadSeed && (hadKp2 || kp2) && !p.steam) {
      clear();
      f.set('TimeOtp-Secret-Base32', prot(b32clean(p.secret)));
      if (p.digits !== 6) f.set('TimeOtp-Length', String(p.digits));
      if (p.period !== 30) f.set('TimeOtp-Period', String(p.period));
      if (p.algorithm !== 'SHA-1') f.set('TimeOtp-Algorithm', KP2_ALG[p.algorithm]);
      return;
    }
    if (hadSeed && !hadOtp) {
      clear();
      f.set('TOTP Seed', prot(b32clean(p.secret)));
      if (p.steam || p.period !== 30 || p.digits !== 6) f.set('TOTP Settings', p.period + ';' + (p.steam ? 'S' : p.digits));
      return;
    }
    clear(); f.set('otp', prot(asUri()));
  }

  function groupAt(db, path, cache) {
    let g = db.getDefaultGroup(); if (!path) return g;
    const recycle = recycleId(db); let acc = '';
    for (const part of path.split(GROUP_SEP).map((s) => s.trim()).filter(Boolean)) {
      acc += GROUP_SEP + part;
      if (!cache[acc]) cache[acc] = g.groups.find((c) => c.name === part && !(recycle && c.uuid && c.uuid.id === recycle)) || db.createGroup(g, part);
      g = cache[acc];
    }
    return g;
  }

  /**
   * Carry out a sync plan on the opened database (the plan's file) and say what RegiBase has to
   * change. The database is changed in memory only; the caller saves it (syncSave), writes the file
   * (refusing when another device changed it since it was read) and only then changes the records.
   * @param {object} plan from planSync
   * @param {{winners?: Record<string,'kp'|'rb'>, deleteKp?: boolean, deleteRb?: boolean}} choice
   *   winners: record id -> the side that wins a conflict (default: the newer one);
   *   deleteKp: delete the records whose entry was deleted in KeePass; deleteRb: delete the entries whose record was deleted in RegiBase
   * @returns {{kpChanged: number, kpAdded: number, kpDeleted: number, update: {id, data}[], add: {uuid, data}[], del: number[],
   *            pairs: {uuid, id: number|null, addIndex?: number, kpTime: number}[], keepState: Record<string, any[]>}}
   *   update/add data: the plain values (merged onto the record for update); pairs: what is in step after it
   */
  function syncApply(plan, choice) {
    choice = choice || {};
    const { P, M, file, state } = plan.ctx;
    const k = ready(); const db = file.db; const cache = {};
    const keys = [...P.fileKeys];
    const recById = {}; for (const r of plan.ctx.records) recById[r.id] = r;
    const entByUuid = {}; let nKp2 = 0; let nOtp = 0;
    for (const x of walkKdbx(db, k)) { entByUuid[x.entry.uuid] = x.e; if (x.e.fields.has('TimeOtp-Secret-Base32') || x.e.fields.has('TimeOtp-Secret')) nKp2++; if (x.e.fields.has('otp')) nOtp++; }
    // a file of KeePass 2 itself: it says so (until something else saved it), or its one-time passwords are all kept KeePass 2's way
    const kp2 = !!(db.meta && /^KeePass$/i.test(str(db.meta.generator))) || (nKp2 > 0 && nOtp === 0);
    const fieldOf = (key) => P.out.find((f) => f.key === key);
    const out = { kpChanged: 0, kpAdded: 0, kpDeleted: 0, update: [], add: [], del: [], pairs: [], keepState: {} };
    const now = new Date();
    // record values -> the entry
    const writeEntry = (en, d) => {
      const f = en.fields; const role = P.role; const get = (r) => (role[r] ? str(d[role[r]]) : null);
      const setStd = (name, v, protect) => { if (v == null) return; const cur = plain(f.get(name), k); if (cur === v && (f.get(name) != null || v === '')) return; f.set(name, protect ? k.ProtectedValue.fromString(v) : v); };
      setStd('Title', get('title'), f.get('Title') instanceof k.ProtectedValue);
      setStd('UserName', get('username'), f.get('UserName') instanceof k.ProtectedValue);
      setStd('Password', get('password'), true);
      setStd('URL', get('url'), f.get('URL') instanceof k.ProtectedValue);
      setStd('Notes', get('notes'), f.get('Notes') instanceof k.ProtectedValue);
      if (role.tags) { const t = splitTags(d[role.tags]); if (t.join('\u0001') !== (en.tags || []).join('\u0001')) en.tags = t; }
      if (role.totp) { const cur = kdbxTotp((name) => plain(f.get(name), k)); const v = str(d[role.totp]); if (v !== cur) writeTotp(en, v, k, kp2, get('title')); }
      for (const key of keys) {
        if (Object.values(role).includes(key)) continue;
        const fd = fieldOf(key); if (!fd || !fd.label) continue;
        const name = fd.label; const v = str(d[key]); const old = f.get(name);
        if (v === '') { if (old != null) f.delete(name); continue; }
        if (old != null && plain(old, k) === v) continue;
        f.set(name, (fd.secret || old instanceof k.ProtectedValue) ? k.ProtectedValue.fromString(v) : v);
      }
      if (role.group) {
        const want = str(d[role.group]).split(GROUP_SEP).map((s) => s.trim()).filter(Boolean).join(GROUP_SEP);
        if (want !== groupPath(db, en.parentGroup)) db.move(en, groupAt(db, want, cache));
      }
    };
    const viewOf = (en) => P.dataOf(entryOf(en, groupPath(db, en.parentGroup), k));
    const touch = (en) => { en.times.update(); };
    // the changes on both sides, entry by entry
    const winners = choice.winners || {};
    const work = [];
    for (const it of plan.toRb) work.push({ it, side: 'kp' });
    for (const it of plan.toKp) work.push({ it, side: 'rb' });
    for (const it of plan.conflicts) work.push({ it, side: winners[it.id] || it.winner, merge: true });
    const handled = new Set();
    for (const { it, side, merge } of work) {
      const en = entByUuid[it.uuid]; const r = recById[it.id]; if (!en || !r) continue;
      handled.add(it.uuid);
      const R = r.data || {}; const E = viewOf(en);
      let want;   // the values both sides should have
      if (it.idOnly || side === 'kp' && !merge) want = E;
      else if (side === 'rb' && !merge) want = R;
      else {
        want = {};
        for (const key of keys) {
          const a = str(E[key]); const b = str(R[key]);
          want[key] = a === b ? a : a === '' ? b : b === '' ? a : (side === 'kp' ? a : b);
        }
      }
      const toKp = keys.filter((key) => str(want[key]) !== str(E[key]));
      if (toKp.length) { en.pushHistory(); writeEntry(en, want); touch(en); out.kpChanged++; }
      const E2 = toKp.length ? viewOf(en) : E;
      const merged = { ...R };
      for (const key of keys) { if (str(E2[key]) === '') delete merged[key]; else merged[key] = E2[key]; }
      merged[UUID_KEY] = it.uuid;
      if (keys.some((key) => str(merged[key]) !== str(R[key])) || str(R[UUID_KEY]) !== it.uuid) out.update.push({ id: r.id, data: merged });
      out.pairs.push({ uuid: it.uuid, id: r.id, en });
    }
    // in step already
    for (const { e, r } of M.pairs) if (r && !handled.has(e.uuid) && entByUuid[e.uuid]) out.pairs.push({ uuid: e.uuid, id: r.id, en: entByUuid[e.uuid] });
    // new in KeePass -> records
    for (const a of plan.addRb) {
      const en = entByUuid[a.uuid];
      out.add.push({ uuid: a.uuid, data: a.data });
      if (en) out.pairs.push({ uuid: a.uuid, id: null, addIndex: out.add.length - 1, en });
    }
    // new in RegiBase -> entries
    for (const x of plan.addKp) {
      const r = recById[x.id]; if (!r) continue;
      const R = r.data || {};
      const en = db.createEntry(groupAt(db, P.role.group ? str(R[P.role.group]) : '', cache));
      en.times.creationTime = now;
      writeEntry(en, R); touch(en); out.kpAdded++;
      const E2 = viewOf(en);
      const merged = { ...R }; for (const key of keys) { if (str(E2[key]) === '') delete merged[key]; else merged[key] = E2[key]; }
      merged[UUID_KEY] = en.uuid.id;
      out.update.push({ id: r.id, data: merged });
      out.pairs.push({ uuid: en.uuid.id, id: r.id, en });
    }
    // deleted on one side
    if (choice.deleteRb) for (const x of plan.deletedRb) { const en = entByUuid[x.uuid]; if (en) { db.remove(en); out.kpDeleted++; } }
    else for (const x of plan.deletedRb) if (state[x.uuid]) out.keepState[x.uuid] = state[x.uuid];   // still offered next time
    if (choice.deleteKp) out.del = plan.deletedKp.map((x) => x.id);
    else for (const x of plan.deletedKp) if (state[x.uuid]) out.keepState[x.uuid] = state[x.uuid];
    if (out.kpChanged || out.kpAdded || out.kpDeleted) {
      // the history limits the file sets (KeePass applies them when it saves, too)
      try { db.cleanup({ historyRules: true, customIcons: false, binaries: false }); } catch (e) { /* older library */ }
    }
    for (const p of out.pairs) { p.kpTime = p.en.times && p.en.times.lastModTime ? p.en.times.lastModTime.getTime() : 0; delete p.en; }
    return out;
  }
  /** The file, after syncApply. */
  async function syncSave(file) { ready(); return file.db.save(); }
  /**
   * The sync state to keep after the records were written.
   * @param {object} applied syncApply's result  @param {Record<number,string>} updatedAt record id -> updated_at (after the writes)
   * @param {number[]} addedIds the ids the new records got, in the order of applied.add
   */
  function syncStateAfter(applied, updatedAt, addedIds) {
    const s = { ...applied.keepState };
    for (const p of applied.pairs) {
      const id = p.id != null ? p.id : addedIds[p.addIndex];
      if (id == null || updatedAt[id] == null) continue;
      s[p.uuid] = [p.kpTime, String(updatedAt[id])];
    }
    return s;
  }

  return { parseCsv, toCsv, fromCsv, fromText, fromBitwardenJson, readKdbx, writeKdbx, toCollection, fromCollection, planRefresh, planSync, syncApply, syncSave, syncStateAfter, syncState,
    totpCode, parseTotp, kdbxTotp, entry, CSV_FORMATS, FORMAT_LIST, KDF_LEVELS, UUID_KEY };
}));
