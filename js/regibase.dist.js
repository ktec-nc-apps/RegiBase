/* RegiBase — Nextcloud native SPA (buildless Vue 3, ported from the standalone app).
 * Auth is handled by Nextcloud (per-user data); there is no master password. */
(function () {
  'use strict';
  // vue-private.js moved the runtime off window.Vue (see the note there).
  // Shadow the global for this whole IIFE — the precompiled render function
  // destructures `Vue` too, and window.Vue is intentionally not set.
  const Vue = window.__RegiBaseVue || window.Vue;
  const { createApp } = Vue;

  const BASE = ((window.OC && OC.generateUrl) ? OC.generateUrl('/apps/regibase') : '/apps/regibase') + '/';
  const TOKEN = (window.OC && OC.requestToken) ? OC.requestToken : '';
  let rootProxy = null;

  // i18n: Japanese strings are the source/keys. Nextcloud loads l10n/<ncLang>.js server-side.
  // When the RegiBase 'language' setting is not 'auto', we install a client-side override
  // map (fetched from /api/i18n/<lang>) so the user can pick a language independent of NC.
  // escape:false because Vue's {{ }} / attribute binding already escapes output.
  let i18nOverride = null;
  // Fold to lower case and hiragana → katakana, so emoji search matches however the
  // user types it (CLDR Japanese names use katakana: "ねこ" must find "ネコの顔").
  function kana(s) {
    return String(s).toLowerCase().replace(/[\u3041-\u3096]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60));
  }
  function subst(s, vars) {
    return vars ? String(s).replace(/\{(\w+)\}/g, (m, k) => (vars[k] != null ? vars[k] : m)) : s;
  }
  function T(text, vars) {
    if (i18nOverride) {
      return subst(i18nOverride[text] != null ? i18nOverride[text] : text, vars);
    }
    try {
      if (typeof window.t === 'function') { return window.t('regibase', text, vars, undefined, { escape: false }); }
    } catch (e) { /* fall through to raw key */ }
    return subst(text, vars);
  }
  let encKey = null; // AES key held in memory only (never reactive, never persisted)
  // Per-shared-collection decryption keys (owner's key, unwrapped with the share
  // password). Held in memory only, keyed by collection id. Never reactive/persisted.
  let sharedKeys = {};
  // Collection ids whose share password has been unlocked this session.
  let sharedUnlocked = {};
  // 6-digit keys entered this session to reveal secret collections. Held in
  // memory only (never persisted); cleared on reload or when hiding again.
  let secretPins = new Set();

  async function api(path, opts = {}) {
    const res = await fetch(BASE + 'api/' + path, {
      headers: { 'Content-Type': 'application/json', 'requesttoken': TOKEN },
      credentials: 'same-origin',
      ...opts,
    });
    if (res.status === 401) { try { sessionStorage.removeItem('rb-session'); } catch (e) { /* ignore */ } if (rootProxy) rootProxy.authenticated = false; throw new Error('unauthorized'); }
    const ct = res.headers.get('content-type') || '';
    const body = ct.includes('json') ? await res.json() : await res.text();
    if (!res.ok) throw new Error((body && body.error) || res.statusText);
    return body;
  }

  let _slugSeq = 0;
  function slug(s) {
    // A monotonic counter keeps the fallback unique even when several fields are
    // slugged in the same synchronous pass (non-ASCII labels all fall through here,
    // and Math.floor(performance.now()) would otherwise collide within one frame).
    return (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')
      || 'f_' + Math.floor(performance.now()).toString(36) + '_' + (_slugSeq++).toString(36);
  }

  // input rules (per-field character/length restrictions)
  const RULE_TYPES = ['text', 'textarea', 'password', 'tel', 'email', 'url', 'number'];
  // choice types share the same "one option per line" config; radio/select store a
  // single value, checkbox stores several joined by ", ".
  const CHOICE_TYPES = ['select', 'radio', 'checkbox'];
  const CHARSET_RE = { digits: /^[0-9]*$/, alnum: /^[0-9A-Za-z]*$/, alpha: /^[A-Za-z]*$/, hex: /^[0-9A-Fa-f]*$/, ascii: /^[\x20-\x7E]*$/, phone: /^[0-9+\-() ]*$/ };
  const CHARSET_LABEL = { digits: 'Digits', alnum: 'Alphanumeric', alpha: 'Letters', hex: 'Hexadecimal', ascii: 'ASCII characters', phone: 'Phone number (digits, +-() )', custom: 'Specified format' };

  // ---- password generator (for secret fields; never leaves the browser) ----
  // Symbols deliberately exclude space, quote, backtick and backslash: they are the
  // characters that break shell/CSV round-trips and get mangled when pasted.
  const PWGEN_SETS = {
    upper: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
    lower: 'abcdefghijklmnopqrstuvwxyz',
    digits: '0123456789',
    symbols: '!#$%&()*+,-./:;<=>?@[]^_{|}~',
  };
  const PWGEN_CLASSES = ['upper', 'lower', 'digits', 'symbols'];
  const PWGEN_LOOKALIKE = '0O1lI|';
  const PWGEN_HEX = '0123456789ABCDEF';
  // Uniform in [0,n). `getRandomValues() % n` alone would bias the low values.
  function randBelow(n) {
    const buf = new Uint32Array(1);
    const limit = Math.floor(0x100000000 / n) * n;
    let v;
    do { crypto.getRandomValues(buf); v = buf[0]; } while (v >= limit);
    return v % n;
  }
  function randPick(s) { return s.charAt(randBelow(s.length)); }
  // classes: [{ set, min, cap }] where cap is the max occurrences (Infinity = no cap).
  // Places each class's `min` first, then fills the rest by picking characters
  // uniformly across the classes that still have capacity, and shuffles the lot.
  // The caller guarantees a feasible request (sum(min) <= len <= sum(cap)); if a
  // pathological config slips through, generation stops early rather than looping.
  function makePassword(classes, len) {
    if (!classes.length || len <= 0) return '';
    const cap = classes.map((c) => (c.cap == null ? Infinity : c.cap));
    const used = classes.map(() => 0);
    const out = [];
    for (let i = 0; i < classes.length; i++) {
      for (let j = 0; j < classes[i].min && out.length < len; j++) { out.push(randPick(classes[i].set)); used[i]++; }
    }
    while (out.length < len) {
      // characters still available = union of classes below their cap
      const avail = [];
      let total = 0;
      for (let i = 0; i < classes.length; i++) {
        if (used[i] < cap[i] && classes[i].set.length) { avail.push(i); total += classes[i].set.length; }
      }
      if (!total) break; // every class capped out — cannot reach len
      let r = randBelow(total), ci = avail[0];
      for (const i of avail) { if (r < classes[i].set.length) { ci = i; break; } r -= classes[i].set.length; }
      out.push(randPick(classes[ci].set)); used[ci]++;
    }
    for (let i = out.length - 1; i > 0; i--) { const j = randBelow(i + 1); const t = out[i]; out[i] = out[j]; out[j] = t; }
    return out.join('');
  }

  // ---- client-side encryption of secret fields (E2EE; server never sees the key) ----
  const ENC_PREFIX = 'rbenc1:';
  const rbcrypto = {
    te: new TextEncoder(), td: new TextDecoder(),
    b64(buf) { const b = new Uint8Array(buf); let s = ''; for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return btoa(s); },
    unb64(str) { const s = atob(str); const b = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i); return b; },
    randSaltB64() { return this.b64(crypto.getRandomValues(new Uint8Array(16))); },
    async deriveKey(masterKey, saltB64) {
      const base = await crypto.subtle.importKey('raw', this.te.encode(masterKey), 'PBKDF2', false, ['deriveKey']);
      return crypto.subtle.deriveKey({ name: 'PBKDF2', salt: this.unb64(saltB64), iterations: 250000, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
    },
    async exportKeyB64(key) { return this.b64(await crypto.subtle.exportKey('raw', key)); },
    async importKeyB64(b64) { return crypto.subtle.importKey('raw', this.unb64(b64), { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']); },
    async encrypt(key, plaintext) {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, this.te.encode(String(plaintext)));
      return ENC_PREFIX + this.b64(iv) + ':' + this.b64(ct);
    },
    async decrypt(key, value) {
      if (!value || String(value).indexOf(ENC_PREFIX) !== 0) return value; // plaintext passthrough
      const parts = String(value).slice(ENC_PREFIX.length).split(':');
      const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: this.unb64(parts[0]) }, key, this.unb64(parts[1]));
      return this.td.decode(pt);
    },
    isEnc(v) { return typeof v === 'string' && v.indexOf(ENC_PREFIX) === 0; },
  };

  // Nextcloud URL helper + Notes app API (same session).
  const NC = (p) => (window.OC && OC.generateUrl) ? OC.generateUrl(p) : p;
  async function notesApi(path, opts = {}) {
    const res = await fetch(NC('/apps/notes') + path, {
      headers: { 'Content-Type': 'application/json', 'requesttoken': TOKEN },
      credentials: 'same-origin',
      ...opts,
    });
    const ct = res.headers.get('content-type') || '';
    const body = ct.includes('json') ? await res.json() : await res.text();
    if (!res.ok) throw new Error((body && (body.message || body.error)) || res.statusText);
    return body;
  }

  // Precompiled render function (eval-free). Source template lives in regibase.js;
  // regenerate with regibase-build/build.mjs after editing the template.
  const render = (function () {
const { createElementVNode: _createElementVNode, openBlock: _openBlock, createElementBlock: _createElementBlock, toDisplayString: _toDisplayString, createCommentVNode: _createCommentVNode, vModelText: _vModelText, withDirectives: _withDirectives, vModelCheckbox: _vModelCheckbox, createTextVNode: _createTextVNode, withModifiers: _withModifiers, normalizeClass: _normalizeClass, renderList: _renderList, Fragment: _Fragment, normalizeStyle: _normalizeStyle, vShow: _vShow, vModelSelect: _vModelSelect, vModelRadio: _vModelRadio, vModelDynamic: _vModelDynamic, withKeys: _withKeys, createStaticVNode: _createStaticVNode } = Vue

const _hoisted_1 = {
  key: 0,
  class: "login-wrap"
}
const _hoisted_2 = { class: "login-card" }
const _hoisted_3 = /*#__PURE__*/_createStaticVNode("<div class=\"logo\"><svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"337 403 1329 1010\"><path fill=\"#400099\" d=\"M1040.39,1355.06c-3.65-4.48-4.91-9.8-3.78-15.97l115.97-542.87c1.12-6.16,4.33-11.48,9.66-15.97,5.32-4.48,11.06-6.72,17.23-6.72h262.19c37.53,0,69.33,7.14,95.38,21.43,26.05,14.29,45.51,33.06,58.4,56.3,12.88,23.25,19.33,47.77,19.33,73.53,0,12.33-1.13,22.98-3.36,31.93-5.61,28.02-15.27,50.57-28.99,67.65-13.73,17.1-27.31,30.12-40.76,39.08,25.21,20.73,37.82,47.62,37.82,80.67,0,12.89-1.68,27.46-5.04,43.7-7.85,35.29-19.05,65.42-33.61,90.34-14.57,24.93-37.12,45.1-67.65,60.51-30.54,15.42-71.01,23.11-121.43,23.11h-296.64c-6.17,0-11.07-2.23-14.71-6.72ZM1353.42,1231.52c19.04,0,35.15-6.16,48.32-18.49,13.16-12.32,19.75-27.17,19.75-44.54,0-11.76-4.2-21.28-12.6-28.57-8.4-7.27-19.62-10.92-33.61-10.92h-138.66l-21.85,102.52h138.66ZM1284.51,903.79l-20.17,95.8h130.25c16.81,0,30.53-4.2,41.18-12.6,10.64-8.4,17.36-20.17,20.17-35.29,1.12-6.72,1.68-11.2,1.68-13.45,0-11.2-3.65-19.75-10.92-25.63-7.29-5.88-17.94-8.82-31.93-8.82h-130.25Z\"></path><path fill=\"none\" stroke=\"#fff\" stroke-width=\"100\" d=\"M1040.39,1355.06c-3.65-4.48-4.91-9.8-3.78-15.97l115.97-542.87c1.12-6.16,4.33-11.48,9.66-15.97,5.32-4.48,11.06-6.72,17.23-6.72h262.19c37.53,0,69.33,7.14,95.38,21.43,26.05,14.29,45.51,33.06,58.4,56.3,12.88,23.25,19.33,47.77,19.33,73.53,0,12.33-1.13,22.98-3.36,31.93-5.61,28.02-15.27,50.57-28.99,67.65-13.73,17.1-27.31,30.12-40.76,39.08,25.21,20.73,37.82,47.62,37.82,80.67,0,12.89-1.68,27.46-5.04,43.7-7.85,35.29-19.05,65.42-33.61,90.34-14.57,24.93-37.12,45.1-67.65,60.51-30.54,15.42-71.01,23.11-121.43,23.11h-296.64c-6.17,0-11.07-2.23-14.71-6.72ZM1353.42,1231.52c19.04,0,35.15-6.16,48.32-18.49,13.16-12.32,19.75-27.17,19.75-44.54,0-11.76-4.2-21.28-12.6-28.57-8.4-7.27-19.62-10.92-33.61-10.92h-138.66l-21.85,102.52h138.66ZM1284.51,903.79l-20.17,95.8h130.25c16.81,0,30.53-4.2,41.18-12.6,10.64-8.4,17.36-20.17,20.17-35.29,1.12-6.72,1.68-11.2,1.68-13.45,0-11.2-3.65-19.75-10.92-25.63-7.29-5.88-17.94-8.82-31.93-8.82h-130.25Z\"></path><path fill=\"#2e3192\" d=\"M1040.39,1355.06c-3.65-4.48-4.91-9.8-3.78-15.97l115.97-542.87c1.12-6.16,4.33-11.48,9.66-15.97,5.32-4.48,11.06-6.72,17.23-6.72h262.19c37.53,0,69.33,7.14,95.38,21.43,26.05,14.29,45.51,33.06,58.4,56.3,12.88,23.25,19.33,47.77,19.33,73.53,0,12.33-1.13,22.98-3.36,31.93-5.61,28.02-15.27,50.57-28.99,67.65-13.73,17.1-27.31,30.12-40.76,39.08,25.21,20.73,37.82,47.62,37.82,80.67,0,12.89-1.68,27.46-5.04,43.7-7.85,35.29-19.05,65.42-33.61,90.34-14.57,24.93-37.12,45.1-67.65,60.51-30.54,15.42-71.01,23.11-121.43,23.11h-296.64c-6.17,0-11.07-2.23-14.71-6.72ZM1353.42,1231.52c19.04,0,35.15-6.16,48.32-18.49,13.16-12.32,19.75-27.17,19.75-44.54,0-11.76-4.2-21.28-12.6-28.57-8.4-7.27-19.62-10.92-33.61-10.92h-138.66l-21.85,102.52h138.66ZM1284.51,903.79l-20.17,95.8h130.25c16.81,0,30.53-4.2,41.18-12.6,10.64-8.4,17.36-20.17,20.17-35.29,1.12-6.72,1.68-11.2,1.68-13.45,0-11.2-3.65-19.75-10.92-25.63-7.29-5.88-17.94-8.82-31.93-8.82h-130.25Z\"></path><path fill=\"#e56b00\" d=\"M1151.98,517.88c58.5,42.78,87.77,103.05,87.77,180.8,0,25.06-2.09,46.66-6.27,64.8-12.55,62.22-35.53,112.97-68.97,152.28s-77.72,70.64-132.88,93.95l92.77,308.45c.84,1.73,1.27,3.89,1.27,6.48,0,9.5-3.56,17.92-10.66,25.27-7.11,7.34-14.84,11.02-23.2,11.02h-157.95c-15.05,0-25.7-3.23-31.97-9.72-6.28-6.47-11.08-14.89-14.42-25.27l-81.48-277.36h-127.86l-57.67,277.36c-1.69,9.5-6.48,17.72-14.42,24.62s-16.52,10.36-25.7,10.36h-164.22c-9.2,0-16.52-3.45-21.95-10.36s-7.31-15.12-5.62-24.62l173-837.22c1.66-9.5,6.47-17.72,14.41-24.62s16.52-10.38,25.7-10.38h327.2c90.25,0,164.64,21.39,223.14,64.16ZM861.14,846.42c81.06,0,128.3-31.97,141.67-95.91,1.66-12.09,2.5-19.86,2.5-23.33,0-48.38-35.11-72.56-105.3-72.56h-141.67l-38.86,191.8h141.66Z\"></path><path fill=\"none\" stroke=\"#fff\" stroke-width=\"100\" stroke-linecap=\"round\" stroke-linejoin=\"round\" d=\"M1151.98,517.88c58.5,42.78,87.77,103.05,87.77,180.8,0,25.06-2.09,46.66-6.27,64.8-12.55,62.22-35.53,112.97-68.97,152.28s-77.72,70.64-132.88,93.95l92.77,308.45c.84,1.73,1.27,3.89,1.27,6.48,0,9.5-3.56,17.92-10.66,25.27-7.11,7.34-14.84,11.02-23.2,11.02h-157.95c-15.05,0-25.7-3.23-31.97-9.72-6.28-6.47-11.08-14.89-14.42-25.27l-81.48-277.36h-127.86l-57.67,277.36c-1.69,9.5-6.48,17.72-14.42,24.62s-16.52,10.36-25.7,10.36h-164.22c-9.2,0-16.52-3.45-21.95-10.36s-7.31-15.12-5.62-24.62l173-837.22c1.66-9.5,6.47-17.72,14.41-24.62s16.52-10.38,25.7-10.38h327.2c90.25,0,164.64,21.39,223.14,64.16ZM861.14,846.42c81.06,0,128.3-31.97,141.67-95.91,1.66-12.09,2.5-19.86,2.5-23.33,0-48.38-35.11-72.56-105.3-72.56h-141.67l-38.86,191.8h141.66Z\"></path><path fill=\"#f15a24\" d=\"M1151.98,517.88c58.5,42.78,87.77,103.05,87.77,180.8,0,25.06-2.09,46.66-6.27,64.8-12.55,62.22-35.53,112.97-68.97,152.28s-77.72,70.64-132.88,93.95l92.77,308.45c.84,1.73,1.27,3.89,1.27,6.48,0,9.5-3.56,17.92-10.66,25.27-7.11,7.34-14.84,11.02-23.2,11.02h-157.95c-15.05,0-25.7-3.23-31.97-9.72-6.28-6.47-11.08-14.89-14.42-25.27l-81.48-277.36h-127.86l-57.67,277.36c-1.69,9.5-6.48,17.72-14.42,24.62s-16.52,10.36-25.7,10.36h-164.22c-9.2,0-16.52-3.45-21.95-10.36s-7.31-15.12-5.62-24.62l173-837.22c1.66-9.5,6.47-17.72,14.41-24.62s16.52-10.38,25.7-10.38h327.2c90.25,0,164.64,21.39,223.14,64.16ZM861.14,846.42c81.06,0,128.3-31.97,141.67-95.91,1.66-12.09,2.5-19.86,2.5-23.33,0-48.38-35.11-72.56-105.3-72.56h-141.67l-38.86,191.8h141.66Z\"></path></svg></div>", 1)
const _hoisted_4 = {
  key: 1,
  class: "login-wrap"
}
const _hoisted_5 = /*#__PURE__*/_createElementVNode("div", { class: "logo" }, "🔒", -1 /* HOISTED */)
const _hoisted_6 = { style: {"margin":"6px 0 2px"} }
const _hoisted_7 = { style: {"color":"var(--muted)","font-size":"13px","margin":"0 0 14px"} }
const _hoisted_8 = ["placeholder"]
const _hoisted_9 = { style: {"display":"flex","align-items":"center","gap":"6px","font-size":"13px","color":"var(--muted)","margin-bottom":"8px","justify-content":"center"} }
const _hoisted_10 = {
  key: 0,
  style: {"color":"var(--danger)","font-size":"13px","margin-bottom":"8px"}
}
const _hoisted_11 = ["disabled"]
const _hoisted_12 = {
  key: 2,
  class: "layout"
}
const _hoisted_13 = { class: "brand" }
const _hoisted_14 = /*#__PURE__*/_createStaticVNode("<span class=\"logo\"><svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"337 403 1329 1010\"><path fill=\"#400099\" d=\"M1040.39,1355.06c-3.65-4.48-4.91-9.8-3.78-15.97l115.97-542.87c1.12-6.16,4.33-11.48,9.66-15.97,5.32-4.48,11.06-6.72,17.23-6.72h262.19c37.53,0,69.33,7.14,95.38,21.43,26.05,14.29,45.51,33.06,58.4,56.3,12.88,23.25,19.33,47.77,19.33,73.53,0,12.33-1.13,22.98-3.36,31.93-5.61,28.02-15.27,50.57-28.99,67.65-13.73,17.1-27.31,30.12-40.76,39.08,25.21,20.73,37.82,47.62,37.82,80.67,0,12.89-1.68,27.46-5.04,43.7-7.85,35.29-19.05,65.42-33.61,90.34-14.57,24.93-37.12,45.1-67.65,60.51-30.54,15.42-71.01,23.11-121.43,23.11h-296.64c-6.17,0-11.07-2.23-14.71-6.72ZM1353.42,1231.52c19.04,0,35.15-6.16,48.32-18.49,13.16-12.32,19.75-27.17,19.75-44.54,0-11.76-4.2-21.28-12.6-28.57-8.4-7.27-19.62-10.92-33.61-10.92h-138.66l-21.85,102.52h138.66ZM1284.51,903.79l-20.17,95.8h130.25c16.81,0,30.53-4.2,41.18-12.6,10.64-8.4,17.36-20.17,20.17-35.29,1.12-6.72,1.68-11.2,1.68-13.45,0-11.2-3.65-19.75-10.92-25.63-7.29-5.88-17.94-8.82-31.93-8.82h-130.25Z\"></path><path fill=\"none\" stroke=\"#fff\" stroke-width=\"100\" d=\"M1040.39,1355.06c-3.65-4.48-4.91-9.8-3.78-15.97l115.97-542.87c1.12-6.16,4.33-11.48,9.66-15.97,5.32-4.48,11.06-6.72,17.23-6.72h262.19c37.53,0,69.33,7.14,95.38,21.43,26.05,14.29,45.51,33.06,58.4,56.3,12.88,23.25,19.33,47.77,19.33,73.53,0,12.33-1.13,22.98-3.36,31.93-5.61,28.02-15.27,50.57-28.99,67.65-13.73,17.1-27.31,30.12-40.76,39.08,25.21,20.73,37.82,47.62,37.82,80.67,0,12.89-1.68,27.46-5.04,43.7-7.85,35.29-19.05,65.42-33.61,90.34-14.57,24.93-37.12,45.1-67.65,60.51-30.54,15.42-71.01,23.11-121.43,23.11h-296.64c-6.17,0-11.07-2.23-14.71-6.72ZM1353.42,1231.52c19.04,0,35.15-6.16,48.32-18.49,13.16-12.32,19.75-27.17,19.75-44.54,0-11.76-4.2-21.28-12.6-28.57-8.4-7.27-19.62-10.92-33.61-10.92h-138.66l-21.85,102.52h138.66ZM1284.51,903.79l-20.17,95.8h130.25c16.81,0,30.53-4.2,41.18-12.6,10.64-8.4,17.36-20.17,20.17-35.29,1.12-6.72,1.68-11.2,1.68-13.45,0-11.2-3.65-19.75-10.92-25.63-7.29-5.88-17.94-8.82-31.93-8.82h-130.25Z\"></path><path fill=\"#2e3192\" d=\"M1040.39,1355.06c-3.65-4.48-4.91-9.8-3.78-15.97l115.97-542.87c1.12-6.16,4.33-11.48,9.66-15.97,5.32-4.48,11.06-6.72,17.23-6.72h262.19c37.53,0,69.33,7.14,95.38,21.43,26.05,14.29,45.51,33.06,58.4,56.3,12.88,23.25,19.33,47.77,19.33,73.53,0,12.33-1.13,22.98-3.36,31.93-5.61,28.02-15.27,50.57-28.99,67.65-13.73,17.1-27.31,30.12-40.76,39.08,25.21,20.73,37.82,47.62,37.82,80.67,0,12.89-1.68,27.46-5.04,43.7-7.85,35.29-19.05,65.42-33.61,90.34-14.57,24.93-37.12,45.1-67.65,60.51-30.54,15.42-71.01,23.11-121.43,23.11h-296.64c-6.17,0-11.07-2.23-14.71-6.72ZM1353.42,1231.52c19.04,0,35.15-6.16,48.32-18.49,13.16-12.32,19.75-27.17,19.75-44.54,0-11.76-4.2-21.28-12.6-28.57-8.4-7.27-19.62-10.92-33.61-10.92h-138.66l-21.85,102.52h138.66ZM1284.51,903.79l-20.17,95.8h130.25c16.81,0,30.53-4.2,41.18-12.6,10.64-8.4,17.36-20.17,20.17-35.29,1.12-6.72,1.68-11.2,1.68-13.45,0-11.2-3.65-19.75-10.92-25.63-7.29-5.88-17.94-8.82-31.93-8.82h-130.25Z\"></path><path fill=\"#e56b00\" d=\"M1151.98,517.88c58.5,42.78,87.77,103.05,87.77,180.8,0,25.06-2.09,46.66-6.27,64.8-12.55,62.22-35.53,112.97-68.97,152.28s-77.72,70.64-132.88,93.95l92.77,308.45c.84,1.73,1.27,3.89,1.27,6.48,0,9.5-3.56,17.92-10.66,25.27-7.11,7.34-14.84,11.02-23.2,11.02h-157.95c-15.05,0-25.7-3.23-31.97-9.72-6.28-6.47-11.08-14.89-14.42-25.27l-81.48-277.36h-127.86l-57.67,277.36c-1.69,9.5-6.48,17.72-14.42,24.62s-16.52,10.36-25.7,10.36h-164.22c-9.2,0-16.52-3.45-21.95-10.36s-7.31-15.12-5.62-24.62l173-837.22c1.66-9.5,6.47-17.72,14.41-24.62s16.52-10.38,25.7-10.38h327.2c90.25,0,164.64,21.39,223.14,64.16ZM861.14,846.42c81.06,0,128.3-31.97,141.67-95.91,1.66-12.09,2.5-19.86,2.5-23.33,0-48.38-35.11-72.56-105.3-72.56h-141.67l-38.86,191.8h141.66Z\"></path><path fill=\"none\" stroke=\"#fff\" stroke-width=\"100\" stroke-linecap=\"round\" stroke-linejoin=\"round\" d=\"M1151.98,517.88c58.5,42.78,87.77,103.05,87.77,180.8,0,25.06-2.09,46.66-6.27,64.8-12.55,62.22-35.53,112.97-68.97,152.28s-77.72,70.64-132.88,93.95l92.77,308.45c.84,1.73,1.27,3.89,1.27,6.48,0,9.5-3.56,17.92-10.66,25.27-7.11,7.34-14.84,11.02-23.2,11.02h-157.95c-15.05,0-25.7-3.23-31.97-9.72-6.28-6.47-11.08-14.89-14.42-25.27l-81.48-277.36h-127.86l-57.67,277.36c-1.69,9.5-6.48,17.72-14.42,24.62s-16.52,10.36-25.7,10.36h-164.22c-9.2,0-16.52-3.45-21.95-10.36s-7.31-15.12-5.62-24.62l173-837.22c1.66-9.5,6.47-17.72,14.41-24.62s16.52-10.38,25.7-10.38h327.2c90.25,0,164.64,21.39,223.14,64.16ZM861.14,846.42c81.06,0,128.3-31.97,141.67-95.91,1.66-12.09,2.5-19.86,2.5-23.33,0-48.38-35.11-72.56-105.3-72.56h-141.67l-38.86,191.8h141.66Z\"></path><path fill=\"#f15a24\" d=\"M1151.98,517.88c58.5,42.78,87.77,103.05,87.77,180.8,0,25.06-2.09,46.66-6.27,64.8-12.55,62.22-35.53,112.97-68.97,152.28s-77.72,70.64-132.88,93.95l92.77,308.45c.84,1.73,1.27,3.89,1.27,6.48,0,9.5-3.56,17.92-10.66,25.27-7.11,7.34-14.84,11.02-23.2,11.02h-157.95c-15.05,0-25.7-3.23-31.97-9.72-6.28-6.47-11.08-14.89-14.42-25.27l-81.48-277.36h-127.86l-57.67,277.36c-1.69,9.5-6.48,17.72-14.42,24.62s-16.52,10.36-25.7,10.36h-164.22c-9.2,0-16.52-3.45-21.95-10.36s-7.31-15.12-5.62-24.62l173-837.22c1.66-9.5,6.47-17.72,14.41-24.62s16.52-10.38,25.7-10.38h327.2c90.25,0,164.64,21.39,223.14,64.16ZM861.14,846.42c81.06,0,128.3-31.97,141.67-95.91,1.66-12.09,2.5-19.86,2.5-23.33,0-48.38-35.11-72.56-105.3-72.56h-141.67l-38.86,191.8h141.66Z\"></path></svg></span><span>RegiBase</span>", 2)
const _hoisted_16 = {
  key: 0,
  class: "tag"
}
const _hoisted_17 = { class: "coll-list" }
const _hoisted_18 = ["draggable", "onClick", "onDragstart", "onDragover", "onDragleave", "onDrop", "onMouseenter", "onFocus"]
const _hoisted_19 = ["title"]
const _hoisted_20 = { class: "ic" }
const _hoisted_21 = { class: "nm" }
const _hoisted_22 = ["title"]
const _hoisted_23 = ["title"]
const _hoisted_24 = { class: "ct" }
const _hoisted_25 = {
  key: 0,
  class: "empty",
  style: {"padding":"24px 8px"}
}
const _hoisted_26 = { class: "coll-tip-name" }
const _hoisted_27 = { class: "coll-tip-desc" }
const _hoisted_28 = { class: "sidebar-foot" }
const _hoisted_29 = ["title"]
const _hoisted_30 = ["title"]
const _hoisted_31 = { class: "main" }
const _hoisted_32 = { class: "topbar" }
const _hoisted_33 = {
  key: 0,
  class: "title"
}
const _hoisted_34 = ["title"]
const _hoisted_35 = { class: "ic" }
const _hoisted_36 = { class: "nm" }
const _hoisted_37 = {
  key: 1,
  class: "title"
}
const _hoisted_38 = { class: "nm" }
const _hoisted_39 = /*#__PURE__*/_createElementVNode("div", { class: "spacer" }, null, -1 /* HOISTED */)
const _hoisted_40 = ["title"]
const _hoisted_41 = {
  key: 3,
  class: "topbar-actions"
}
const _hoisted_42 = { class: "viewswitch" }
const _hoisted_43 = ["title", "onClick", "innerHTML"]
const _hoisted_44 = ["title"]
const _hoisted_45 = ["title"]
const _hoisted_46 = /*#__PURE__*/_createElementVNode("div", {
  class: "ta-break",
  "aria-hidden": "true"
}, null, -1 /* HOISTED */)
const _hoisted_47 = {
  key: 0,
  class: "home"
}
const _hoisted_48 = {
  key: 0,
  class: "home-grid"
}
const _hoisted_49 = ["onClick"]
const _hoisted_50 = ["title"]
const _hoisted_51 = { class: "hc-body" }
const _hoisted_52 = { class: "hc-name" }
const _hoisted_53 = { class: "hc-desc" }
const _hoisted_54 = { class: "hc-count" }
const _hoisted_55 = {
  key: 1,
  class: "empty"
}
const _hoisted_56 = /*#__PURE__*/_createElementVNode("div", { class: "big" }, "🗂️", -1 /* HOISTED */)
const _hoisted_57 = /*#__PURE__*/_createElementVNode("br", null, null, -1 /* HOISTED */)
const _hoisted_58 = { class: "listtoolbar" }
const _hoisted_59 = { class: "lt-top" }
const _hoisted_60 = ["title"]
const _hoisted_61 = { class: "lt-collname" }
const _hoisted_62 = ["title"]
const _hoisted_63 = { class: "ic" }
const _hoisted_64 = {
  key: 0,
  class: "lt-count"
}
const _hoisted_65 = { class: "lt-tools" }
const _hoisted_66 = { class: "sr-box" }
const _hoisted_67 = { class: "sr-row" }
const _hoisted_68 = ["placeholder"]
const _hoisted_69 = ["title"]
const _hoisted_70 = ["title", "aria-expanded"]
const _hoisted_71 = ["title"]
const _hoisted_72 = ["placeholder"]
const _hoisted_73 = {
  key: 0,
  class: "replace-info"
}
const _hoisted_74 = ["disabled"]
const _hoisted_75 = {
  key: 0,
  class: "rx-help"
}
const _hoisted_76 = { class: "rx-help-hd" }
const _hoisted_77 = { class: "rx-pager" }
const _hoisted_78 = ["disabled", "title"]
const _hoisted_79 = { class: "rx-pg" }
const _hoisted_80 = ["disabled", "title"]
const _hoisted_81 = { class: "rx-tbl" }
const _hoisted_82 = { class: "rx-p" }
const _hoisted_83 = { class: "rx-d" }
const _hoisted_84 = { class: "rx-e" }
const _hoisted_85 = {
  key: 0,
  class: "rx-notes"
}
const _hoisted_86 = {
  key: 1,
  class: "rx-notes"
}
const _hoisted_87 = { class: "lt-actions" }
const _hoisted_88 = { class: "selcount" }
const _hoisted_89 = ["disabled"]
const _hoisted_90 = ["disabled"]
const _hoisted_91 = /*#__PURE__*/_createElementVNode("span", { class: "selspacer" }, null, -1 /* HOISTED */)
const _hoisted_92 = ["title"]
const _hoisted_93 = { class: "sortgroup-lbl" }
const _hoisted_94 = ["value", "title"]
const _hoisted_95 = { value: "created_asc" }
const _hoisted_96 = { value: "created_desc" }
const _hoisted_97 = { value: "title_asc" }
const _hoisted_98 = { value: "title_desc" }
const _hoisted_99 = ["title"]
const _hoisted_100 = ["disabled", "title"]
const _hoisted_101 = ["disabled"]
const _hoisted_102 = ["disabled"]
const _hoisted_103 = ["disabled"]
const _hoisted_104 = {
  key: 0,
  class: "empty"
}
const _hoisted_105 = { class: "big" }
const _hoisted_106 = { key: 0 }
const _hoisted_107 = {
  key: 0,
  class: "rec-grid"
}
const _hoisted_108 = ["checked", "onChange"]
const _hoisted_109 = ["onClick", "title"]
const _hoisted_110 = ["onClick"]
const _hoisted_111 = { class: "rt" }
const _hoisted_112 = { class: "rl" }
const _hoisted_113 = { class: "rec-list" }
const _hoisted_114 = ["checked", "onChange"]
const _hoisted_115 = ["onClick"]
const _hoisted_116 = { class: "rr-title" }
const _hoisted_117 = { class: "rr-sub" }
const _hoisted_118 = /*#__PURE__*/_createElementVNode("span", { class: "rr-chev" }, "›", -1 /* HOISTED */)
const _hoisted_119 = ["onClick", "title"]
const _hoisted_120 = { class: "rec-table" }
const _hoisted_121 = { class: "rt-fhead" }
const _hoisted_122 = ["checked"]
const _hoisted_123 = { key: 0 }
const _hoisted_124 = /*#__PURE__*/_createElementVNode("th", { class: "rt-actions" }, null, -1 /* HOISTED */)
const _hoisted_125 = { class: "rt-frozen" }
const _hoisted_126 = ["checked", "onChange"]
const _hoisted_127 = ["onClick", "title"]
const _hoisted_128 = ["src"]
const _hoisted_129 = ["src"]
const _hoisted_130 = { key: 1 }
const _hoisted_131 = ["onClick", "title"]
const _hoisted_132 = { class: "note-view" }
const _hoisted_133 = { class: "note-pane note-titles" }
const _hoisted_134 = { class: "note-list" }
const _hoisted_135 = ["onClick"]
const _hoisted_136 = { class: "nt-title" }
const _hoisted_137 = {
  key: 0,
  class: "nt-sub"
}
const _hoisted_138 = { class: "note-chead" }
const _hoisted_139 = { class: "nc-title" }
const _hoisted_140 = { class: "nc-acts" }
const _hoisted_141 = ["title"]
const _hoisted_142 = ["title"]
const _hoisted_143 = { class: "note-cbody" }
const _hoisted_144 = { class: "dk" }
const _hoisted_145 = {
  key: 0,
  class: "dv"
}
const _hoisted_146 = ["src"]
const _hoisted_147 = {
  key: 1,
  class: "dv"
}
const _hoisted_148 = { class: "fa-ic" }
const _hoisted_149 = { class: "val" }
const _hoisted_150 = ["onClick"]
const _hoisted_151 = ["onClick", "title"]
const _hoisted_152 = {
  key: 2,
  class: "dv"
}
const _hoisted_153 = ["href"]
const _hoisted_154 = ["onClick"]
const _hoisted_155 = ["disabled", "title", "onClick"]
const _hoisted_156 = ["title", "onClick"]
const _hoisted_157 = ["onClick", "title"]
const _hoisted_158 = {
  key: 1,
  class: "note-placeholder"
}
const _hoisted_159 = /*#__PURE__*/_createElementVNode("div", { class: "big" }, "📄", -1 /* HOISTED */)
const _hoisted_160 = {
  key: 0,
  class: "scrollnav"
}
const _hoisted_161 = ["title"]
const _hoisted_162 = ["title"]
const _hoisted_163 = { class: "modal wide" }
const _hoisted_164 = { class: "modal-head" }
const _hoisted_165 = { class: "modal-body" }
const _hoisted_166 = ["disabled", "title"]
const _hoisted_167 = ["disabled", "title"]
const _hoisted_168 = { style: {"font-size":"12px","color":"var(--muted)","margin-bottom":"8px"} }
const _hoisted_169 = {
  key: 0,
  class: "empty"
}
const _hoisted_170 = {
  key: 1,
  class: "tpl-grid"
}
const _hoisted_171 = ["disabled", "onClick"]
const _hoisted_172 = { class: "th" }
const _hoisted_173 = { class: "ic" }
const _hoisted_174 = { class: "tpl-name" }
const _hoisted_175 = {
  key: 0,
  class: "tpl-tag"
}
const _hoisted_176 = {
  key: 1,
  class: "tpl-tag edited"
}
const _hoisted_177 = { class: "td" }
const _hoisted_178 = { class: "tpl-actions" }
const _hoisted_179 = ["title", "onClick"]
const _hoisted_180 = ["title", "onClick"]
const _hoisted_181 = ["title", "onClick"]
const _hoisted_182 = { class: "modal-foot" }
const _hoisted_183 = { class: "modal-head" }
const _hoisted_184 = { class: "modal-body" }
const _hoisted_185 = {
  key: 0,
  style: {"font-size":"13px","background":"color-mix(in srgb,var(--danger) 12%,transparent)","color":"var(--danger)","padding":"8px 10px","border-radius":"8px","margin-bottom":"12px"}
}
const _hoisted_186 = {
  key: 0,
  class: "req"
}
const _hoisted_187 = {
  key: 1,
  class: "chip"
}
const _hoisted_188 = ["onUpdate:modelValue", "placeholder", "maxlength"]
const _hoisted_189 = ["onUpdate:modelValue"]
const _hoisted_190 = { value: "" }
const _hoisted_191 = ["value"]
const _hoisted_192 = {
  key: 2,
  class: "choice-field"
}
const _hoisted_193 = ["name", "value", "onUpdate:modelValue"]
const _hoisted_194 = ["onClick"]
const _hoisted_195 = {
  key: 3,
  class: "choice-field"
}
const _hoisted_196 = ["value", "onUpdate:modelValue"]
const _hoisted_197 = {
  key: 4,
  class: "imgfield"
}
const _hoisted_198 = ["onDragenter", "onDragleave", "onDrop"]
const _hoisted_199 = ["src"]
const _hoisted_200 = {
  key: 1,
  class: "dropzone-hint"
}
const _hoisted_201 = /*#__PURE__*/_createElementVNode("span", { class: "dz-ic" }, "🖼", -1 /* HOISTED */)
const _hoisted_202 = /*#__PURE__*/_createElementVNode("br", null, null, -1 /* HOISTED */)
const _hoisted_203 = { class: "imgactions" }
const _hoisted_204 = ["onClick"]
const _hoisted_205 = { class: "btn sm" }
const _hoisted_206 = ["onChange"]
const _hoisted_207 = ["onClick"]
const _hoisted_208 = ["onClick"]
const _hoisted_209 = {
  key: 5,
  class: "filefield"
}
const _hoisted_210 = {
  key: 0,
  class: "fileattach"
}
const _hoisted_211 = { class: "fa-ic" }
const _hoisted_212 = { class: "fa-name" }
const _hoisted_213 = ["onClick"]
const _hoisted_214 = ["onClick", "title"]
const _hoisted_215 = ["onClick"]
const _hoisted_216 = ["onDragenter", "onDragleave", "onDrop"]
const _hoisted_217 = { class: "dropzone-hint" }
const _hoisted_218 = /*#__PURE__*/_createElementVNode("span", { class: "dz-ic" }, "📎", -1 /* HOISTED */)
const _hoisted_219 = /*#__PURE__*/_createElementVNode("br", null, null, -1 /* HOISTED */)
const _hoisted_220 = { class: "imgactions" }
const _hoisted_221 = ["onClick"]
const _hoisted_222 = { class: "btn sm" }
const _hoisted_223 = ["onChange"]
const _hoisted_224 = ["onClick"]
const _hoisted_225 = {
  key: 6,
  class: "control"
}
const _hoisted_226 = ["type", "onUpdate:modelValue", "placeholder", "readonly", "autocomplete", "maxlength"]
const _hoisted_227 = ["onClick", "title"]
const _hoisted_228 = ["onClick"]
const _hoisted_229 = {
  key: 7,
  class: "rule-hint"
}
const _hoisted_230 = { class: "modal-foot" }
const _hoisted_231 = {
  type: "submit",
  class: "btn primary"
}
const _hoisted_232 = { class: "modal" }
const _hoisted_233 = { class: "modal-head" }
const _hoisted_234 = { class: "modal-body" }
const _hoisted_235 = { class: "dk" }
const _hoisted_236 = {
  key: 0,
  class: "dv"
}
const _hoisted_237 = ["src"]
const _hoisted_238 = {
  key: 1,
  class: "dv"
}
const _hoisted_239 = { class: "fa-ic" }
const _hoisted_240 = { class: "val" }
const _hoisted_241 = ["onClick"]
const _hoisted_242 = ["onClick", "title"]
const _hoisted_243 = {
  key: 2,
  class: "dv"
}
const _hoisted_244 = ["href"]
const _hoisted_245 = ["onClick"]
const _hoisted_246 = ["disabled", "title", "onClick"]
const _hoisted_247 = ["title", "onClick"]
const _hoisted_248 = ["onClick", "title"]
const _hoisted_249 = { class: "modal-foot" }
const _hoisted_250 = { class: "modal wide" }
const _hoisted_251 = { class: "modal-head" }
const _hoisted_252 = {
  key: 0,
  class: "tpl-meta"
}
const _hoisted_253 = { class: "field-row" }
const _hoisted_254 = { class: "field" }
const _hoisted_255 = {
  class: "field",
  style: {"max-width":"120px"}
}
const _hoisted_256 = { class: "field-row" }
const _hoisted_257 = {
  class: "field",
  style: {"max-width":"190px"}
}
const _hoisted_258 = { class: "iconpick-head" }
const _hoisted_259 = ["title"]
const _hoisted_260 = ["placeholder"]
const _hoisted_261 = { class: "field" }
const _hoisted_262 = {
  key: 1,
  style: {"color":"var(--muted)","font-size":"13px","margin-top":"0"}
}
const _hoisted_263 = { style: {"color":"var(--muted)","font-size":"13px","margin-top":"0"} }
const _hoisted_264 = {
  key: 2,
  class: "concat-help"
}
const _hoisted_265 = { style: {"font-size":"13px","color":"var(--muted)"} }
const _hoisted_266 = ["onDragover", "onDrop", "onDragleave"]
const _hoisted_267 = ["onDragstart", "title"]
const _hoisted_268 = ["onUpdate:modelValue", "placeholder"]
const _hoisted_269 = ["onUpdate:modelValue"]
const _hoisted_270 = { value: "text" }
const _hoisted_271 = { value: "textarea" }
const _hoisted_272 = { value: "password" }
const _hoisted_273 = { value: "number" }
const _hoisted_274 = { value: "date" }
const _hoisted_275 = { value: "month" }
const _hoisted_276 = { value: "email" }
const _hoisted_277 = /*#__PURE__*/_createElementVNode("option", { value: "url" }, "URL", -1 /* HOISTED */)
const _hoisted_278 = { value: "tel" }
const _hoisted_279 = { value: "address" }
const _hoisted_280 = { value: "select" }
const _hoisted_281 = { value: "radio" }
const _hoisted_282 = { value: "checkbox" }
const _hoisted_283 = { value: "image" }
const _hoisted_284 = { value: "image_crop" }
const _hoisted_285 = { value: "file" }
const _hoisted_286 = { style: {"display":"flex","gap":"4px","justify-content":"flex-end"} }
const _hoisted_287 = ["onClick", "title"]
const _hoisted_288 = ["onUpdate:modelValue", "placeholder"]
const _hoisted_289 = {
  key: 1,
  class: "imgcfg"
}
const _hoisted_290 = { class: "cfg" }
const _hoisted_291 = ["onUpdate:modelValue"]
const _hoisted_292 = {
  key: 0,
  class: "cfg"
}
const _hoisted_293 = ["onUpdate:modelValue"]
const _hoisted_294 = {
  key: 1,
  class: "cfg"
}
const _hoisted_295 = ["onUpdate:modelValue"]
const _hoisted_296 = { value: "jpeg" }
const _hoisted_297 = { value: "png" }
const _hoisted_298 = { value: "webp" }
const _hoisted_299 = {
  key: 2,
  class: "imgcfg"
}
const _hoisted_300 = { class: "cfg" }
const _hoisted_301 = ["onUpdate:modelValue"]
const _hoisted_302 = { value: "1:1" }
const _hoisted_303 = { value: "3:4" }
const _hoisted_304 = { value: "4:3" }
const _hoisted_305 = { value: "16:9" }
const _hoisted_306 = { value: "free" }
const _hoisted_307 = { class: "cfg" }
const _hoisted_308 = ["onUpdate:modelValue"]
const _hoisted_309 = { class: "cfg" }
const _hoisted_310 = ["onUpdate:modelValue"]
const _hoisted_311 = { value: "jpeg" }
const _hoisted_312 = { value: "png" }
const _hoisted_313 = { value: "webp" }
const _hoisted_314 = {
  key: 3,
  class: "imgcfg"
}
const _hoisted_315 = { class: "cfg" }
const _hoisted_316 = ["onUpdate:modelValue"]
const _hoisted_317 = { value: "none" }
const _hoisted_318 = { value: "digits" }
const _hoisted_319 = { value: "alnum" }
const _hoisted_320 = { value: "alpha" }
const _hoisted_321 = { value: "hex" }
const _hoisted_322 = { value: "ascii" }
const _hoisted_323 = { value: "phone" }
const _hoisted_324 = { value: "custom" }
const _hoisted_325 = {
  key: 0,
  class: "cfg"
}
const _hoisted_326 = ["onUpdate:modelValue", "placeholder"]
const _hoisted_327 = { class: "cfg" }
const _hoisted_328 = ["onUpdate:modelValue"]
const _hoisted_329 = { class: "cfg" }
const _hoisted_330 = ["onUpdate:modelValue"]
const _hoisted_331 = { class: "flags" }
const _hoisted_332 = ["checked", "onChange"]
const _hoisted_333 = ["onUpdate:modelValue"]
const _hoisted_334 = ["onUpdate:modelValue"]
const _hoisted_335 = {
  key: 0,
  class: "show-flags"
}
const _hoisted_336 = ["onUpdate:modelValue"]
const _hoisted_337 = ["onUpdate:modelValue"]
const _hoisted_338 = ["onUpdate:modelValue"]
const _hoisted_339 = {
  key: 1,
  class: "concat-base"
}
const _hoisted_340 = ["value", "onChange"]
const _hoisted_341 = { value: 0 }
const _hoisted_342 = ["value"]
const _hoisted_343 = {
  key: 2,
  class: "concat-sep-inline"
}
const _hoisted_344 = ["onUpdate:modelValue"]
const _hoisted_345 = { value: "none" }
const _hoisted_346 = { value: "space" }
const _hoisted_347 = {
  key: 0,
  value: "fullspace"
}
const _hoisted_348 = { value: "custom" }
const _hoisted_349 = { value: "paren" }
const _hoisted_350 = {
  key: 1,
  value: "parenfull"
}
const _hoisted_351 = ["onUpdate:modelValue", "placeholder"]
const _hoisted_352 = ["title"]
const _hoisted_353 = { class: "modal-foot" }
const _hoisted_354 = { class: "modal sm" }
const _hoisted_355 = { class: "modal-head" }
const _hoisted_356 = { class: "modal-body" }
const _hoisted_357 = { class: "field" }
const _hoisted_358 = { class: "dup-check" }
const _hoisted_359 = { style: {"font-size":"12px","color":"var(--muted)","margin-top":"6px"} }
const _hoisted_360 = { class: "modal-foot" }
const _hoisted_361 = ["disabled"]
const _hoisted_362 = { class: "modal wide" }
const _hoisted_363 = { class: "modal-head" }
const _hoisted_364 = { class: "modal-body" }
const _hoisted_365 = { style: {"color":"var(--muted)","font-size":"13px","margin-top":"0"} }
const _hoisted_366 = {
  key: 0,
  class: "reorder-byfield"
}
const _hoisted_367 = { class: "reorder-byfield-head" }
const _hoisted_368 = { class: "reorder-keynum" }
const _hoisted_369 = ["onUpdate:modelValue"]
const _hoisted_370 = { value: "" }
const _hoisted_371 = ["value"]
const _hoisted_372 = ["onUpdate:modelValue"]
const _hoisted_373 = { value: "asc" }
const _hoisted_374 = { value: "desc" }
const _hoisted_375 = ["onClick", "title"]
const _hoisted_376 = { class: "reorder-byfield-actions" }
const _hoisted_377 = ["disabled"]
const _hoisted_378 = { class: "reorder-listhead" }
const _hoisted_379 = { class: "reorder-list" }
const _hoisted_380 = ["onDragover", "onDrop", "onDragleave"]
const _hoisted_381 = ["onDragstart", "title"]
const _hoisted_382 = { class: "reorder-num" }
const _hoisted_383 = { class: "reorder-cell" }
const _hoisted_384 = { class: "reorder-title" }
const _hoisted_385 = {
  key: 0,
  class: "reorder-sub"
}
const _hoisted_386 = { class: "modal-foot" }
const _hoisted_387 = ["disabled"]
const _hoisted_388 = { class: "modal" }
const _hoisted_389 = { class: "modal-head" }
const _hoisted_390 = { class: "modal-body settings-body" }
const _hoisted_391 = {
  key: 0,
  class: "share-note"
}
const _hoisted_392 = { class: "field" }
const _hoisted_393 = { class: "field" }
const _hoisted_394 = ["placeholder"]
const _hoisted_395 = { class: "field-row" }
const _hoisted_396 = { class: "field" }
const _hoisted_397 = { class: "field" }
const _hoisted_398 = { class: "iconpick-head" }
const _hoisted_399 = ["title"]
const _hoisted_400 = ["placeholder"]
const _hoisted_401 = { class: "field" }
const _hoisted_402 = { style: {"display":"flex","gap":"8px","align-items":"center"} }
const _hoisted_403 = ["placeholder"]
const _hoisted_404 = { style: {"font-size":"12px","color":"var(--muted)","margin-top":"4px"} }
const _hoisted_405 = { class: "field" }
const _hoisted_406 = { value: "" }
const _hoisted_407 = { value: "google" }
const _hoisted_408 = { value: "yahoo" }
const _hoisted_409 = { value: "osm" }
const _hoisted_410 = { value: "apple" }
const _hoisted_411 = { value: "bing" }
const _hoisted_412 = {
  key: 2,
  class: "field"
}
const _hoisted_413 = {
  class: "lock-toggle",
  style: {"display":"flex","align-items":"center","gap":"8px","cursor":"pointer"}
}
const _hoisted_414 = { style: {"font-size":"12px","color":"var(--muted)","margin-top":"4px"} }
const _hoisted_415 = {
  key: 3,
  class: "field"
}
const _hoisted_416 = {
  class: "lock-toggle",
  style: {"display":"flex","align-items":"center","gap":"8px","cursor":"pointer"}
}
const _hoisted_417 = { style: {"font-size":"12px","color":"var(--muted)","margin-top":"4px"} }
const _hoisted_418 = {
  key: 0,
  class: "field",
  style: {"margin-top":"8px"}
}
const _hoisted_419 = ["placeholder"]
const _hoisted_420 = {
  class: "lock-toggle",
  style: {"display":"flex","align-items":"center","gap":"8px","cursor":"pointer"}
}
const _hoisted_421 = {
  key: 0,
  class: "share-count"
}
const _hoisted_422 = { style: {"font-size":"12px","color":"var(--muted)","margin-top":"4px"} }
const _hoisted_423 = { class: "share-body" }
const _hoisted_424 = {
  key: 0,
  class: "share-list"
}
const _hoisted_425 = { class: "share-user" }
const _hoisted_426 = ["value", "onChange"]
const _hoisted_427 = { value: "view" }
const _hoisted_428 = { value: "edit" }
const _hoisted_429 = { value: "delete" }
const _hoisted_430 = ["title"]
const _hoisted_431 = ["title"]
const _hoisted_432 = ["onClick", "title"]
const _hoisted_433 = { class: "share-add" }
const _hoisted_434 = { class: "share-top" }
const _hoisted_435 = {
  key: 0,
  class: "share-search"
}
const _hoisted_436 = ["placeholder"]
const _hoisted_437 = {
  key: 0,
  class: "share-results"
}
const _hoisted_438 = ["onClick"]
const _hoisted_439 = { class: "muted" }
const _hoisted_440 = {
  key: 1,
  class: "share-picked"
}
const _hoisted_441 = { class: "share-user" }
const _hoisted_442 = { class: "muted" }
const _hoisted_443 = ["title"]
const _hoisted_444 = { class: "perm-label" }
const _hoisted_445 = /*#__PURE__*/_createElementVNode("span", {
  class: "perm-arrow",
  "aria-hidden": "true"
}, "⌄", -1 /* HOISTED */)
const _hoisted_446 = ["onClick"]
const _hoisted_447 = { class: "share-opts" }
const _hoisted_448 = { class: "so-row" }
const _hoisted_449 = { class: "sub" }
const _hoisted_450 = { class: "control" }
const _hoisted_451 = ["placeholder"]
const _hoisted_452 = ["title"]
const _hoisted_453 = {
  key: 0,
  class: "so-row so-secret"
}
const _hoisted_454 = { class: "sub" }
const _hoisted_455 = ["placeholder"]
const _hoisted_456 = { class: "muted so-hint" }
const _hoisted_457 = {
  key: 0,
  class: "share-err"
}
const _hoisted_458 = ["disabled"]
const _hoisted_459 = {
  key: 5,
  class: "field"
}
const _hoisted_460 = { style: {"display":"flex","gap":"8px","flex-wrap":"wrap"} }
const _hoisted_461 = { style: {"font-size":"12px","color":"var(--muted)","margin-top":"4px"} }
const _hoisted_462 = { class: "field" }
const _hoisted_463 = { style: {"display":"flex","gap":"8px","flex-wrap":"wrap"} }
const _hoisted_464 = ["disabled", "title"]
const _hoisted_465 = { style: {"font-size":"12px","color":"var(--muted)","margin-top":"4px"} }
const _hoisted_466 = { style: {"font-size":"12px","color":"var(--muted)","margin-top":"2px"} }
const _hoisted_467 = { class: "field" }
const _hoisted_468 = { style: {"display":"flex","gap":"8px","flex-wrap":"wrap","align-items":"center"} }
const _hoisted_469 = {
  key: 0,
  style: {"font-size":"12px","color":"var(--muted)"}
}
const _hoisted_470 = { style: {"display":"flex","gap":"8px","align-items":"center","flex-wrap":"wrap","margin-top":"8px"} }
const _hoisted_471 = { style: {"font-size":"13px","color":"var(--muted)"} }
const _hoisted_472 = { style: {"font-size":"13px","color":"var(--muted)"} }
const _hoisted_473 = { style: {"font-size":"12px","color":"var(--muted)","margin-top":"4px"} }
const _hoisted_474 = { class: "field" }
const _hoisted_475 = { style: {"display":"flex","gap":"8px","flex-wrap":"wrap","align-items":"center"} }
const _hoisted_476 = { style: {"font-size":"12px","color":"var(--muted)","margin-top":"4px"} }
const _hoisted_477 = { class: "modal-foot" }
const _hoisted_478 = { class: "modal sm" }
const _hoisted_479 = { class: "modal-head" }
const _hoisted_480 = ["disabled"]
const _hoisted_481 = { class: "modal-body" }
const _hoisted_482 = { style: {"font-size":"15px","margin-top":"0"} }
const _hoisted_483 = { style: {"display":"flex","flex-direction":"column","gap":"4px","padding":"10px 12px","background":"var(--surface-2)","border":"1px solid var(--border)","border-radius":"10px","font-size":"13px","word-break":"break-all"} }
const _hoisted_484 = { style: {"color":"var(--muted)"} }
const _hoisted_485 = /*#__PURE__*/_createElementVNode("div", null, "↓", -1 /* HOISTED */)
const _hoisted_486 = { style: {"font-weight":"700"} }
const _hoisted_487 = { class: "modal-foot" }
const _hoisted_488 = ["disabled"]
const _hoisted_489 = ["disabled"]
const _hoisted_490 = { class: "modal sm secret-modal" }
const _hoisted_491 = { class: "modal-head" }
const _hoisted_492 = { class: "modal-body" }
const _hoisted_493 = { class: "secret-lead" }
const _hoisted_494 = { class: "secret-cells" }
const _hoisted_495 = ["value", "onInput", "onKeydown"]
const _hoisted_496 = {
  key: 0,
  class: "share-err",
  style: {"text-align":"center"}
}
const _hoisted_497 = { class: "modal-foot" }
const _hoisted_498 = ["disabled"]
const _hoisted_499 = { class: "modal sm" }
const _hoisted_500 = { class: "modal-head" }
const _hoisted_501 = { class: "modal-body" }
const _hoisted_502 = { style: {"margin-top":"0","color":"var(--muted)"} }
const _hoisted_503 = { class: "field" }
const _hoisted_504 = {
  key: 0,
  class: "share-err"
}
const _hoisted_505 = { class: "modal-foot" }
const _hoisted_506 = ["disabled"]
const _hoisted_507 = { class: "modal wide" }
const _hoisted_508 = { class: "modal-head" }
const _hoisted_509 = { class: "modal-body" }
const _hoisted_510 = { style: {"margin-top":"0","color":"var(--muted)","font-size":"13px"} }
const _hoisted_511 = /*#__PURE__*/_createElementVNode("br", null, null, -1 /* HOISTED */)
const _hoisted_512 = { class: "filepick" }
const _hoisted_513 = { class: "btn sm" }
const _hoisted_514 = { class: "filepick-name" }
const _hoisted_515 = { style: {"margin":"12px 0 6px","color":"var(--muted)","font-size":"12px"} }
const _hoisted_516 = ["placeholder"]
const _hoisted_517 = { style: {"margin-bottom":"10px"} }
const _hoisted_518 = { class: "chip" }
const _hoisted_519 = { class: "chip" }
const _hoisted_520 = { class: "field" }
const _hoisted_521 = { class: "field" }
const _hoisted_522 = { class: "iconpick-head" }
const _hoisted_523 = ["title"]
const _hoisted_524 = ["placeholder"]
const _hoisted_525 = { style: {"color":"var(--muted)","font-size":"12px","margin":"4px 0 8px"} }
const _hoisted_526 = ["onUpdate:modelValue", "placeholder"]
const _hoisted_527 = ["onUpdate:modelValue"]
const _hoisted_528 = { value: "text" }
const _hoisted_529 = { value: "textarea" }
const _hoisted_530 = { value: "password" }
const _hoisted_531 = /*#__PURE__*/_createElementVNode("option", { value: "url" }, "URL", -1 /* HOISTED */)
const _hoisted_532 = { value: "email" }
const _hoisted_533 = { value: "tel" }
const _hoisted_534 = { value: "address" }
const _hoisted_535 = { value: "date" }
const _hoisted_536 = { value: "number" }
const _hoisted_537 = { value: "image" }
const _hoisted_538 = ["title"]
const _hoisted_539 = { class: "flags" }
const _hoisted_540 = ["checked", "onChange"]
const _hoisted_541 = ["onUpdate:modelValue"]
const _hoisted_542 = { class: "modal-foot" }
const _hoisted_543 = ["disabled"]
const _hoisted_544 = { class: "modal" }
const _hoisted_545 = { class: "modal-head" }
const _hoisted_546 = ["disabled"]
const _hoisted_547 = { class: "modal-body" }
const _hoisted_548 = {
  key: 0,
  class: "empty"
}
const _hoisted_549 = {
  key: 1,
  class: "empty"
}
const _hoisted_550 = { style: {"margin-top":"0","font-size":"13px","color":"var(--muted)"} }
const _hoisted_551 = { class: "field" }
const _hoisted_552 = { value: "all" }
const _hoisted_553 = ["value"]
const _hoisted_554 = { class: "field" }
const _hoisted_555 = ["placeholder"]
const _hoisted_556 = { class: "field" }
const _hoisted_557 = { class: "iconpick-head" }
const _hoisted_558 = ["title"]
const _hoisted_559 = ["placeholder"]
const _hoisted_560 = {
  key: 0,
  style: {"color":"var(--danger)","font-size":"13px"}
}
const _hoisted_561 = { class: "modal-foot" }
const _hoisted_562 = ["disabled"]
const _hoisted_563 = ["disabled"]
const _hoisted_564 = { class: "modal" }
const _hoisted_565 = { class: "modal-head" }
const _hoisted_566 = ["disabled"]
const _hoisted_567 = { class: "modal-body" }
const _hoisted_568 = {
  key: 0,
  class: "empty"
}
const _hoisted_569 = {
  key: 1,
  class: "empty"
}
const _hoisted_570 = {
  key: 2,
  class: "empty"
}
const _hoisted_571 = { style: {"margin-top":"0","font-size":"13px","color":"var(--muted)"} }
const _hoisted_572 = { class: "field" }
const _hoisted_573 = ["value"]
const _hoisted_574 = { class: "field" }
const _hoisted_575 = ["placeholder"]
const _hoisted_576 = { class: "field" }
const _hoisted_577 = { class: "iconpick-head" }
const _hoisted_578 = ["title"]
const _hoisted_579 = ["placeholder"]
const _hoisted_580 = {
  key: 0,
  style: {"color":"var(--danger)","font-size":"13px"}
}
const _hoisted_581 = { class: "modal-foot" }
const _hoisted_582 = ["disabled"]
const _hoisted_583 = ["disabled"]
const _hoisted_584 = { class: "modal wide" }
const _hoisted_585 = { class: "modal-head" }
const _hoisted_586 = { class: "modal-body" }
const _hoisted_587 = { class: "field" }
const _hoisted_588 = { style: {"font-size":"14px","color":"var(--muted)"} }
const _hoisted_589 = { class: "field" }
const _hoisted_590 = { class: "radios" }
const _hoisted_591 = { class: "field" }
const _hoisted_592 = ["value"]
const _hoisted_593 = { value: "" }
const _hoisted_594 = { value: "__newcoll__" }
const _hoisted_595 = ["value"]
const _hoisted_596 = {
  key: 0,
  class: "field"
}
const _hoisted_597 = ["placeholder"]
const _hoisted_598 = { style: {"font-size":"12px","color":"var(--muted)","margin-top":"4px"} }
const _hoisted_599 = { style: {"color":"var(--muted)","font-size":"12px","margin":"6px 0 8px"} }
const _hoisted_600 = ["title"]
const _hoisted_601 = { class: "ms-label" }
const _hoisted_602 = {
  key: 0,
  class: "ms-sample"
}
const _hoisted_603 = {
  key: 1,
  class: "ms-empty"
}
const _hoisted_604 = /*#__PURE__*/_createElementVNode("span", { class: "map-arrow" }, "→", -1 /* HOISTED */)
const _hoisted_605 = ["onUpdate:modelValue"]
const _hoisted_606 = { value: "" }
const _hoisted_607 = ["value"]
const _hoisted_608 = { value: "__new__" }
const _hoisted_609 = {
  class: "field",
  style: {"margin-top":"12px"}
}
const _hoisted_610 = { value: "" }
const _hoisted_611 = ["value"]
const _hoisted_612 = { class: "modal-foot" }
const _hoisted_613 = ["disabled"]
const _hoisted_614 = { class: "modal" }
const _hoisted_615 = { class: "modal-head" }
const _hoisted_616 = { class: "modal-body settings-body" }
const _hoisted_617 = { class: "field" }
const _hoisted_618 = { class: "radios" }
const _hoisted_619 = {
  class: "field",
  style: {"margin-top":"16px"}
}
const _hoisted_620 = { value: "auto" }
const _hoisted_621 = ["value"]
const _hoisted_622 = { style: {"font-size":"12px","color":"var(--muted)","margin-top":"4px"} }
const _hoisted_623 = {
  class: "field",
  style: {"margin-top":"16px"}
}
const _hoisted_624 = { style: {"display":"flex","gap":"8px","align-items":"center"} }
const _hoisted_625 = ["placeholder"]
const _hoisted_626 = { style: {"font-size":"12px","color":"var(--muted)","margin-top":"4px"} }
const _hoisted_627 = {
  class: "field",
  style: {"margin-top":"16px","border-top":"1px solid var(--border)","padding-top":"14px"}
}
const _hoisted_628 = {
  key: 0,
  style: {"font-size":"13px","color":"var(--muted)"}
}
const _hoisted_629 = { style: {"color":"var(--accent)"} }
const _hoisted_630 = { key: 0 }
const _hoisted_631 = { style: {"margin-top":"12px","display":"flex","flex-direction":"column","gap":"10px"} }
const _hoisted_632 = { style: {"display":"flex","align-items":"center","gap":"10px","flex-wrap":"wrap"} }
const _hoisted_633 = { style: {"flex":"1","min-width":"200px","font-size":"12px"} }
const _hoisted_634 = { style: {"display":"flex","align-items":"center","gap":"10px","flex-wrap":"wrap"} }
const _hoisted_635 = { style: {"flex":"1","min-width":"200px","font-size":"12px"} }
const _hoisted_636 = { style: {"display":"flex","align-items":"center","gap":"10px","flex-wrap":"wrap"} }
const _hoisted_637 = { style: {"flex":"1","min-width":"200px","font-size":"12px"} }
const _hoisted_638 = {
  key: 1,
  style: {"font-size":"13px","color":"var(--muted)"}
}
const _hoisted_639 = { style: {"margin-top":"8px"} }
const _hoisted_640 = {
  class: "field",
  style: {"margin-top":"16px","border-top":"1px solid var(--border)","padding-top":"14px"}
}
const _hoisted_641 = { style: {"font-size":"12px","color":"var(--muted)","margin-bottom":"8px"} }
const _hoisted_642 = { style: {"display":"flex","gap":"8px","flex-wrap":"wrap"} }
const _hoisted_643 = { class: "modal-foot" }
const _hoisted_644 = { class: "modal" }
const _hoisted_645 = { class: "modal-head" }
const _hoisted_646 = { class: "modal-body" }
const _hoisted_647 = { style: {"margin-top":"0"} }
const _hoisted_648 = {
  key: 0,
  style: {"font-size":"12px","color":"var(--muted)"}
}
const _hoisted_649 = { class: "modal-foot" }
const _hoisted_650 = ["disabled"]
const _hoisted_651 = ["disabled"]
const _hoisted_652 = ["disabled"]
const _hoisted_653 = { class: "modal" }
const _hoisted_654 = { class: "modal-head" }
const _hoisted_655 = ["disabled"]
const _hoisted_656 = { class: "modal-body" }
const _hoisted_657 = { style: {"margin-top":"0"} }
const _hoisted_658 = {
  key: 0,
  class: "confirm-check",
  style: {"align-items":"flex-start","margin-top":"6px"}
}
const _hoisted_659 = /*#__PURE__*/_createElementVNode("br", null, null, -1 /* HOISTED */)
const _hoisted_660 = { style: {"font-size":"12px","color":"var(--muted)"} }
const _hoisted_661 = {
  key: 1,
  style: {"font-size":"13px","color":"var(--muted)","margin-top":"6px"}
}
const _hoisted_662 = /*#__PURE__*/_createElementVNode("br", null, null, -1 /* HOISTED */)
const _hoisted_663 = {
  key: 1,
  style: {"color":"var(--danger)","font-size":"13px","background":"color-mix(in srgb,var(--danger) 12%,transparent)","padding":"8px 10px","border-radius":"8px","margin-top":"10px"}
}
const _hoisted_664 = { class: "modal-foot" }
const _hoisted_665 = ["disabled"]
const _hoisted_666 = ["disabled"]
const _hoisted_667 = { class: "modal" }
const _hoisted_668 = { class: "modal-head" }
const _hoisted_669 = {
  key: 0,
  style: {"font-weight":"400","font-size":"14px","color":"var(--muted)"}
}
const _hoisted_670 = { class: "modal-body" }
const _hoisted_671 = { style: {"display":"flex","gap":"8px","align-items":"center","margin-bottom":"10px"} }
const _hoisted_672 = ["disabled"]
const _hoisted_673 = /*#__PURE__*/_createElementVNode("span", { style: {"flex":"1"} }, null, -1 /* HOISTED */)
const _hoisted_674 = { style: {"font-size":"12px","color":"var(--muted)","margin-bottom":"8px"} }
const _hoisted_675 = {
  key: 0,
  class: "empty"
}
const _hoisted_676 = {
  key: 1,
  class: "hist-list"
}
const _hoisted_677 = ["title"]
const _hoisted_678 = { class: "hist-icon" }
const _hoisted_679 = { class: "hist-when" }
const _hoisted_680 = { class: "hist-sum" }
const _hoisted_681 = {
  key: 0,
  class: "hist-tag"
}
const _hoisted_682 = ["disabled", "onClick", "title"]
const _hoisted_683 = { class: "modal" }
const _hoisted_684 = { class: "modal-head" }
const _hoisted_685 = ["disabled"]
const _hoisted_686 = { style: {"margin-top":"0","font-size":"13px","color":"var(--muted)"} }
const _hoisted_687 = { class: "field" }
const _hoisted_688 = {
  key: 0,
  style: {"color":"var(--danger)","font-size":"13px"}
}
const _hoisted_689 = {
  key: 1,
  style: {"font-size":"13px","color":"var(--muted)"}
}
const _hoisted_690 = { class: "modal-foot" }
const _hoisted_691 = ["disabled"]
const _hoisted_692 = ["disabled"]
const _hoisted_693 = { class: "modal" }
const _hoisted_694 = { class: "modal-head" }
const _hoisted_695 = ["disabled"]
const _hoisted_696 = { class: "modal-body" }
const _hoisted_697 = { class: "filepick" }
const _hoisted_698 = { class: "btn sm" }
const _hoisted_699 = { class: "filepick-name" }
const _hoisted_700 = {
  class: "field",
  style: {"margin-top":"12px"}
}
const _hoisted_701 = { class: "field" }
const _hoisted_702 = { class: "radios" }
const _hoisted_703 = { style: {"color":"var(--danger)","font-size":"13px","background":"color-mix(in srgb,var(--danger) 12%,transparent)","padding":"8px 10px","border-radius":"8px"} }
const _hoisted_704 = { class: "confirm-check" }
const _hoisted_705 = {
  key: 1,
  style: {"color":"var(--danger)","font-size":"13px","margin-top":"8px"}
}
const _hoisted_706 = {
  key: 2,
  style: {"font-size":"13px","color":"var(--muted)","margin-top":"8px"}
}
const _hoisted_707 = { class: "modal-foot" }
const _hoisted_708 = ["disabled"]
const _hoisted_709 = ["disabled"]
const _hoisted_710 = { class: "modal" }
const _hoisted_711 = { class: "modal-head" }
const _hoisted_712 = ["disabled"]
const _hoisted_713 = { class: "modal-body" }
const _hoisted_714 = { style: {"margin-top":"0","font-size":"13px"} }
const _hoisted_715 = { style: {"color":"var(--danger)","font-size":"13px","background":"color-mix(in srgb,var(--danger) 12%,transparent)","padding":"8px 10px","border-radius":"8px"} }
const _hoisted_716 = { class: "field" }
const _hoisted_717 = { class: "field" }
const _hoisted_718 = { style: {"display":"flex","align-items":"center","gap":"6px","font-size":"13px","color":"var(--muted)"} }
const _hoisted_719 = {
  key: 0,
  style: {"color":"var(--danger)","font-size":"13px","margin-top":"8px"}
}
const _hoisted_720 = {
  key: 1,
  style: {"font-size":"13px","color":"var(--muted)","margin-top":"8px"}
}
const _hoisted_721 = { class: "modal-foot" }
const _hoisted_722 = ["disabled"]
const _hoisted_723 = ["disabled"]
const _hoisted_724 = { class: "modal" }
const _hoisted_725 = { class: "modal-head" }
const _hoisted_726 = ["disabled"]
const _hoisted_727 = { class: "modal-body" }
const _hoisted_728 = { style: {"margin-top":"0","font-size":"13px","color":"var(--muted)"} }
const _hoisted_729 = { class: "field" }
const _hoisted_730 = { class: "field" }
const _hoisted_731 = { class: "field" }
const _hoisted_732 = {
  key: 0,
  style: {"color":"var(--danger)","font-size":"13px"}
}
const _hoisted_733 = {
  key: 1,
  style: {"font-size":"13px","color":"var(--muted)"}
}
const _hoisted_734 = { class: "modal-foot" }
const _hoisted_735 = ["disabled"]
const _hoisted_736 = ["disabled"]
const _hoisted_737 = { class: "modal" }
const _hoisted_738 = { class: "modal-head" }
const _hoisted_739 = ["disabled"]
const _hoisted_740 = { class: "modal-body" }
const _hoisted_741 = { style: {"margin-top":"0","font-size":"13px"} }
const _hoisted_742 = { style: {"color":"var(--danger)","font-size":"13px","background":"color-mix(in srgb,var(--danger) 12%,transparent)","padding":"8px 10px","border-radius":"8px"} }
const _hoisted_743 = { class: "field" }
const _hoisted_744 = {
  key: 0,
  style: {"color":"var(--danger)","font-size":"13px"}
}
const _hoisted_745 = {
  key: 1,
  style: {"font-size":"13px","color":"var(--muted)"}
}
const _hoisted_746 = { class: "modal-foot" }
const _hoisted_747 = ["disabled"]
const _hoisted_748 = ["disabled"]
const _hoisted_749 = { class: "modal" }
const _hoisted_750 = { class: "modal-head" }
const _hoisted_751 = { class: "modal-body" }
const _hoisted_752 = { style: {"font-size":"15px","margin-top":"0"} }
const _hoisted_753 = { style: {"color":"var(--danger)","font-size":"13px"} }
const _hoisted_754 = { class: "confirm-check" }
const _hoisted_755 = { class: "modal-foot" }
const _hoisted_756 = ["disabled"]
const _hoisted_757 = { class: "modal" }
const _hoisted_758 = { class: "modal-head" }
const _hoisted_759 = { class: "modal-body" }
const _hoisted_760 = { style: {"font-size":"14px","margin-top":"0"} }
const _hoisted_761 = { style: {"margin":"8px 0","padding-left":"20px","color":"var(--danger)","font-size":"13px"} }
const _hoisted_762 = { style: {"color":"var(--danger)","font-size":"13px"} }
const _hoisted_763 = {
  key: 0,
  style: {"font-size":"13px","color":"var(--muted)","margin-top":"8px"}
}
const _hoisted_764 = { style: {"margin":"6px 0 0","padding-left":"20px"} }
const _hoisted_765 = { class: "confirm-check" }
const _hoisted_766 = { class: "modal-foot" }
const _hoisted_767 = ["disabled"]
const _hoisted_768 = { class: "modal" }
const _hoisted_769 = { class: "modal-head" }
const _hoisted_770 = {
  class: "modal-body",
  style: {"display":"flex","flex-direction":"column","align-items":"center","gap":"10px"}
}
const _hoisted_771 = { style: {"margin":"0","color":"var(--muted)","font-size":"12px","align-self":"flex-start"} }
const _hoisted_772 = ["src"]
const _hoisted_773 = { class: "modal-foot" }
const _hoisted_774 = ["disabled"]
const _hoisted_775 = { class: "modal" }
const _hoisted_776 = { class: "modal-head" }
const _hoisted_777 = { class: "modal-body" }
const _hoisted_778 = {
  key: 0,
  class: "empty"
}
const _hoisted_779 = {
  key: 1,
  class: "empty"
}
const _hoisted_780 = /*#__PURE__*/_createElementVNode("br", null, null, -1 /* HOISTED */)
const _hoisted_781 = { style: {"margin-top":"0","color":"var(--muted)","font-size":"13px"} }
const _hoisted_782 = {
  key: 0,
  class: "empty"
}
const _hoisted_783 = /*#__PURE__*/_createElementVNode("br", null, null, -1 /* HOISTED */)
const _hoisted_784 = {
  key: 1,
  class: "note-list"
}
const _hoisted_785 = ["onClick"]
const _hoisted_786 = { class: "ni-title" }
const _hoisted_787 = { class: "ni-cat" }
const _hoisted_788 = { style: {"font-size":"12px","color":"var(--muted)","margin-bottom":"6px"} }
const _hoisted_789 = {
  key: 0,
  class: "empty"
}
const _hoisted_790 = {
  key: 1,
  class: "note-list"
}
const _hoisted_791 = ["onClick"]
const _hoisted_792 = { class: "ni-title" }
const _hoisted_793 = { class: "modal-foot" }
const _hoisted_794 = { class: "modal" }
const _hoisted_795 = { class: "modal-head" }
const _hoisted_796 = { class: "modal-body" }
const _hoisted_797 = { class: "fp-path" }
const _hoisted_798 = ["disabled"]
const _hoisted_799 = { class: "fp-cur" }
const _hoisted_800 = {
  key: 0,
  class: "empty"
}
const _hoisted_801 = {
  key: 1,
  class: "empty"
}
const _hoisted_802 = {
  key: 2,
  class: "empty"
}
const _hoisted_803 = {
  key: 3,
  class: "note-list fp-list"
}
const _hoisted_804 = ["onClick", "onDblclick"]
const _hoisted_805 = { class: "ni-title" }
const _hoisted_806 = { class: "ni-cat" }
const _hoisted_807 = { class: "modal-foot" }
const _hoisted_808 = ["disabled"]
const _hoisted_809 = ["placeholder"]
const _hoisted_810 = { class: "emoji-tabs" }
const _hoisted_811 = ["title", "onClick"]
const _hoisted_812 = { class: "emoji-palette" }
const _hoisted_813 = { class: "emoji-cat" }
const _hoisted_814 = {
  key: 0,
  class: "emoji-none"
}
const _hoisted_815 = {
  key: 1,
  class: "emoji-none"
}
const _hoisted_816 = { class: "emoji-grid" }
const _hoisted_817 = ["onClick", "title"]
const _hoisted_818 = { class: "pwgen-head" }
const _hoisted_819 = { class: "pwgen-out" }
const _hoisted_820 = ["title"]
const _hoisted_821 = ["title"]
const _hoisted_822 = { class: "pwgen-meter" }
const _hoisted_823 = { class: "pwgen-strength" }
const _hoisted_824 = { class: "muted" }
const _hoisted_825 = { key: 0 }
const _hoisted_826 = { class: "pwgen-row" }
const _hoisted_827 = { class: "sub" }
const _hoisted_828 = ["min", "max"]
const _hoisted_829 = ["min", "max"]
const _hoisted_830 = {
  key: 0,
  class: "pwgen-opts"
}
const _hoisted_831 = { class: "pwgen-note" }
const _hoisted_832 = { class: "pwgen-classes" }
const _hoisted_833 = { class: "pwgen-hdr" }
const _hoisted_834 = { class: "pwgen-mmhdr" }
const _hoisted_835 = { class: "pwgen-cls-on" }
const _hoisted_836 = ["checked", "disabled", "onChange"]
const _hoisted_837 = {
  key: 0,
  class: "pwgen-mm"
}
const _hoisted_838 = ["max", "value", "onChange", "title"]
const _hoisted_839 = /*#__PURE__*/_createElementVNode("span", { class: "pwgen-mm-sep" }, "/", -1 /* HOISTED */)
const _hoisted_840 = ["max", "value", "placeholder", "onChange", "title"]
const _hoisted_841 = {
  key: 0,
  class: "pwgen-symsel"
}
const _hoisted_842 = { class: "pwgen-symsel-head" }
const _hoisted_843 = { class: "sub" }
const _hoisted_844 = { class: "pwgen-symgrid" }
const _hoisted_845 = ["title", "onClick"]
const _hoisted_846 = { class: "pwgen-opts" }
const _hoisted_847 = ["disabled"]
const _hoisted_848 = ["disabled"]
const _hoisted_849 = {
  key: 2,
  class: "pwgen-note"
}
const _hoisted_850 = {
  key: 3,
  class: "pwgen-err"
}
const _hoisted_851 = { class: "pwgen-foot" }
const _hoisted_852 = ["disabled"]
const _hoisted_853 = {
  key: 30,
  class: "toast"
}

return function render(_ctx, _cache) {
  return (_ctx.authenticated === null)
    ? (_openBlock(), _createElementBlock("div", _hoisted_1, [
        _createElementVNode("div", _hoisted_2, [
          _hoisted_3,
          _createElementVNode("p", null, _toDisplayString(_ctx.t('Loading…')), 1 /* TEXT */)
        ])
      ]))
    : (_ctx.enc.enabled && !_ctx.enc.unlocked)
      ? (_openBlock(), _createElementBlock("div", _hoisted_4, [
          _createElementVNode("form", {
            class: "login-card",
            onSubmit: _cache[2] || (_cache[2] = _withModifiers((...args) => (_ctx.doUnlock && _ctx.doUnlock(...args)), ["prevent"]))
          }, [
            _hoisted_5,
            _createElementVNode("h2", _hoisted_6, _toDisplayString(_ctx.t('Locked')), 1 /* TEXT */),
            _createElementVNode("p", _hoisted_7, _toDisplayString(_ctx.t('Enter your master key to unlock.')), 1 /* TEXT */),
            _withDirectives(_createElementVNode("input", {
              type: "password",
              "onUpdate:modelValue": _cache[0] || (_cache[0] = $event => ((_ctx.unlockKey) = $event)),
              placeholder: _ctx.t('Master key'),
              autofocus: "",
              autocomplete: "off",
              style: {"width":"100%","padding":"11px 12px","border-radius":"10px","border":"1px solid var(--border)","background":"var(--surface-2)","color":"var(--text)","margin-bottom":"8px"}
            }, null, 8 /* PROPS */, _hoisted_8), [
              [_vModelText, _ctx.unlockKey]
            ]),
            _createElementVNode("label", _hoisted_9, [
              _withDirectives(_createElementVNode("input", {
                type: "checkbox",
                "onUpdate:modelValue": _cache[1] || (_cache[1] = $event => ((_ctx.unlockRemember) = $event))
              }, null, 512 /* NEED_PATCH */), [
                [_vModelCheckbox, _ctx.unlockRemember]
              ]),
              _createTextVNode(" " + _toDisplayString(_ctx.t('Remember on this device (no re-entry until logout)')), 1 /* TEXT */)
            ]),
            (_ctx.unlockErr)
              ? (_openBlock(), _createElementBlock("div", _hoisted_10, _toDisplayString(_ctx.unlockErr), 1 /* TEXT */))
              : _createCommentVNode("v-if", true),
            _createElementVNode("button", {
              type: "submit",
              class: "btn primary block",
              disabled: _ctx.encForm.busy
            }, _toDisplayString(_ctx.t('🔓 Unlock')), 9 /* TEXT, PROPS */, _hoisted_11)
          ], 32 /* NEED_HYDRATION */)
        ]))
      : (_openBlock(), _createElementBlock("div", _hoisted_12, [
          _createElementVNode("div", {
            class: _normalizeClass(["backdrop", {show: _ctx.sidebarOpen}]),
            onClick: _cache[3] || (_cache[3] = $event => (_ctx.sidebarOpen=false))
          }, null, 2 /* CLASS */),
          _createElementVNode("aside", {
            class: _normalizeClass(["sidebar", {open: _ctx.sidebarOpen}])
          }, [
            _createElementVNode("div", _hoisted_13, [
              _hoisted_14,
              (_ctx.version)
                ? (_openBlock(), _createElementBlock("span", _hoisted_16, "v" + _toDisplayString(_ctx.version), 1 /* TEXT */))
                : _createCommentVNode("v-if", true)
            ]),
            _createElementVNode("button", {
              class: _normalizeClass(["coll-home", {active: !_ctx.current}]),
              onClick: _cache[4] || (_cache[4] = (...args) => (_ctx.goHome && _ctx.goHome(...args)))
            }, _toDisplayString(_ctx.t('🗂️ All collections')), 3 /* TEXT, CLASS */),
            _createElementVNode("nav", _hoisted_17, [
              (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.collections, (c, ci) => {
                return (_openBlock(), _createElementBlock("button", {
                  key: c.id,
                  class: _normalizeClass(["coll-item", {active: _ctx.current && _ctx.current.id===c.id, dragging: _ctx.collDrag.from===ci, dragover: _ctx.collDrag.over===ci}]),
                  draggable: c.is_owner !== false,
                  onClick: $event => (_ctx.selectCollection(c.id)),
                  onDragstart: $event => (_ctx.cDragStart(ci, $event)),
                  onDragover: _withModifiers($event => (_ctx.cDragOver(ci)), ["prevent"]),
                  onDragleave: $event => (_ctx.cDragLeave(ci)),
                  onDrop: _withModifiers($event => (_ctx.cDrop(ci)), ["prevent"]),
                  onDragend: _cache[5] || (_cache[5] = (...args) => (_ctx.cDragEnd && _ctx.cDragEnd(...args))),
                  onMouseenter: $event => (_ctx.showCollTip(c, $event)),
                  onMouseleave: _cache[6] || (_cache[6] = (...args) => (_ctx.hideCollTip && _ctx.hideCollTip(...args))),
                  onFocus: $event => (_ctx.showCollTip(c, $event)),
                  onBlur: _cache[7] || (_cache[7] = (...args) => (_ctx.hideCollTip && _ctx.hideCollTip(...args)))
                }, [
                  _createElementVNode("span", {
                    class: "ci-bar",
                    style: _normalizeStyle({background: c.color})
                  }, null, 4 /* STYLE */),
                  (_ctx.shareBadge(c))
                    ? (_openBlock(), _createElementBlock("span", {
                        key: 0,
                        class: "share-badge",
                        title: _ctx.shareBadgeTitle(c)
                      }, _toDisplayString(_ctx.shareBadge(c)), 9 /* TEXT, PROPS */, _hoisted_19))
                    : _createCommentVNode("v-if", true),
                  _createElementVNode("span", _hoisted_20, _toDisplayString(c.icon), 1 /* TEXT */),
                  _createElementVNode("span", _hoisted_21, _toDisplayString(c.name), 1 /* TEXT */),
                  (c.secret)
                    ? (_openBlock(), _createElementBlock("span", {
                        key: 1,
                        class: "ci-lock",
                        title: _ctx.t('Secret collection')
                      }, "🕶️", 8 /* PROPS */, _hoisted_22))
                    : _createCommentVNode("v-if", true),
                  (c.locked)
                    ? (_openBlock(), _createElementBlock("span", {
                        key: 2,
                        class: "ci-lock",
                        title: _ctx.t('Edit lock (view only)')
                      }, "🔒", 8 /* PROPS */, _hoisted_23))
                    : _createCommentVNode("v-if", true),
                  _createElementVNode("span", _hoisted_24, _toDisplayString(c.record_count), 1 /* TEXT */)
                ], 42 /* CLASS, PROPS, NEED_HYDRATION */, _hoisted_18))
              }), 128 /* KEYED_FRAGMENT */)),
              (!_ctx.collections.length)
                ? (_openBlock(), _createElementBlock("div", _hoisted_25, [
                    _createElementVNode("div", null, _toDisplayString(_ctx.t('No collections yet')), 1 /* TEXT */)
                  ]))
                : _createCommentVNode("v-if", true)
            ]),
            (_ctx.collTip.show)
              ? (_openBlock(), _createElementBlock("div", {
                  key: 0,
                  class: "coll-tip",
                  style: _normalizeStyle({left: _ctx.collTip.x + 'px', top: _ctx.collTip.y + 'px'})
                }, [
                  _createElementVNode("div", _hoisted_26, _toDisplayString(_ctx.collTip.name), 1 /* TEXT */),
                  _createElementVNode("div", _hoisted_27, _toDisplayString(_ctx.collTip.desc), 1 /* TEXT */)
                ], 4 /* STYLE */))
              : _createCommentVNode("v-if", true),
            _createElementVNode("div", _hoisted_28, [
              _createElementVNode("button", {
                class: "btn primary block",
                onClick: _cache[8] || (_cache[8] = (...args) => (_ctx.openTemplatePicker && _ctx.openTemplatePicker(...args)))
              }, _toDisplayString(_ctx.t('＋ New collection')), 1 /* TEXT */),
              _createElementVNode("button", {
                class: _normalizeClass(["btn sm block secret-toggle", {on: _ctx.secretShown}]),
                onClick: _cache[9] || (_cache[9] = (...args) => (_ctx.openSecretToggle && _ctx.openSecretToggle(...args))),
                title: _ctx.t('Show or hide secret collections')
              }, _toDisplayString(_ctx.secretShown ? _ctx.t('🕶️ Hide secret collections') : _ctx.t('🕶️ Secret toggle')), 11 /* TEXT, CLASS, PROPS */, _hoisted_29),
              _createElementVNode("button", {
                class: "btn sm block",
                onClick: _cache[10] || (_cache[10] = (...args) => (_ctx.openSettings && _ctx.openSettings(...args))),
                title: _ctx.t('Theme, storage location, etc.')
              }, _toDisplayString(_ctx.t('⚙️ Settings')), 9 /* TEXT, PROPS */, _hoisted_30)
            ])
          ], 2 /* CLASS */),
          _createElementVNode("main", _hoisted_31, [
            _createElementVNode("div", _hoisted_32, [
              _createElementVNode("button", {
                class: "btn ghost hamburger",
                onClick: _cache[11] || (_cache[11] = $event => (_ctx.sidebarOpen=true))
              }, "☰"),
              (_ctx.current)
                ? (_openBlock(), _createElementBlock("div", _hoisted_33, [
                    (_ctx.shareBadge(_ctx.current))
                      ? (_openBlock(), _createElementBlock("span", {
                          key: 0,
                          class: "share-badge",
                          title: _ctx.shareBadgeTitle(_ctx.current)
                        }, _toDisplayString(_ctx.shareBadge(_ctx.current)), 9 /* TEXT, PROPS */, _hoisted_34))
                      : _createCommentVNode("v-if", true),
                    _createElementVNode("span", _hoisted_35, _toDisplayString(_ctx.current.icon), 1 /* TEXT */),
                    _createElementVNode("span", _hoisted_36, _toDisplayString(_ctx.current.name), 1 /* TEXT */)
                  ]))
                : (_openBlock(), _createElementBlock("div", _hoisted_37, [
                    _createElementVNode("span", _hoisted_38, _toDisplayString(_ctx.t('All collections')), 1 /* TEXT */)
                  ])),
              _hoisted_39,
              (_ctx.current && _ctx.undoTop)
                ? (_openBlock(), _createElementBlock("button", {
                    key: 2,
                    class: "btn ghost sm rb-undo",
                    onClick: _cache[12] || (_cache[12] = (...args) => (_ctx.doUndo && _ctx.doUndo(...args))),
                    title: _ctx.t('Undo: {what}', {what: _ctx.undoTop})
                  }, "↶ " + _toDisplayString(_ctx.t('Undo')), 9 /* TEXT, PROPS */, _hoisted_40))
                : _createCommentVNode("v-if", true),
              (_ctx.current)
                ? (_openBlock(), _createElementBlock("div", _hoisted_41, [
                    _createElementVNode("div", _hoisted_42, [
                      (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.views, (v) => {
                        return (_openBlock(), _createElementBlock("button", {
                          key: v.key,
                          class: _normalizeClass(["vbtn", {on: _ctx.curView===v.key}]),
                          title: _ctx.t(v.label),
                          onClick: $event => (_ctx.setView(v.key)),
                          innerHTML: v.icon
                        }, null, 10 /* CLASS, PROPS */, _hoisted_43))
                      }), 128 /* KEYED_FRAGMENT */))
                    ]),
                    (_ctx.isOwner && !_ctx.isLocked)
                      ? (_openBlock(), _createElementBlock("button", {
                          key: 0,
                          class: "btn sm",
                          onClick: _cache[13] || (_cache[13] = (...args) => (_ctx.openSchemaEditor && _ctx.openSchemaEditor(...args))),
                          title: _ctx.t('Edit fields (form)')
                        }, _toDisplayString(_ctx.t('🧩 Edit collection')), 9 /* TEXT, PROPS */, _hoisted_44))
                      : _createCommentVNode("v-if", true),
                    _createElementVNode("button", {
                      class: "btn sm",
                      onClick: _cache[14] || (_cache[14] = (...args) => (_ctx.openCollSettings && _ctx.openCollSettings(...args))),
                      title: _ctx.t('Collection name, description, color, etc.')
                    }, _toDisplayString(_ctx.t('⚙️ Collection settings')), 9 /* TEXT, PROPS */, _hoisted_45),
                    (_ctx.canEdit)
                      ? (_openBlock(), _createElementBlock("button", {
                          key: 1,
                          class: "btn accent sm",
                          onClick: _cache[15] || (_cache[15] = (...args) => (_ctx.openNewRecord && _ctx.openNewRecord(...args)))
                        }, _toDisplayString(_ctx.t('＋ New record')), 1 /* TEXT */))
                      : _createCommentVNode("v-if", true),
                    _hoisted_46
                  ]))
                : _createCommentVNode("v-if", true)
            ]),
            _createElementVNode("div", {
              class: _normalizeClass(["content", {'content-table': _ctx.current && _ctx.curView==='table' && _ctx.records.length, 'content-note': _ctx.current && _ctx.curView==='note' && _ctx.records.length}]),
              onScroll: _cache[48] || (_cache[48] = (...args) => (_ctx.onScrollNearBottom && _ctx.onScrollNearBottom(...args)))
            }, [
              (!_ctx.current)
                ? (_openBlock(), _createElementBlock("div", _hoisted_47, [
                    (_ctx.collections.length)
                      ? (_openBlock(), _createElementBlock("div", _hoisted_48, [
                          (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.collections, (c) => {
                            return (_openBlock(), _createElementBlock("button", {
                              key: c.id,
                              class: "home-card",
                              onClick: $event => (_ctx.selectCollection(c.id))
                            }, [
                              _createElementVNode("span", {
                                class: "hc-bar",
                                style: _normalizeStyle({background: c.color})
                              }, null, 4 /* STYLE */),
                              _createElementVNode("div", {
                                class: "hc-icon",
                                style: _normalizeStyle({background: c.color + '22', color: c.color})
                              }, [
                                _createTextVNode(_toDisplayString(c.icon), 1 /* TEXT */),
                                (_ctx.shareBadge(c))
                                  ? (_openBlock(), _createElementBlock("span", {
                                      key: 0,
                                      class: "hc-badge",
                                      title: _ctx.shareBadgeTitle(c)
                                    }, _toDisplayString(_ctx.shareBadge(c)), 9 /* TEXT, PROPS */, _hoisted_50))
                                  : _createCommentVNode("v-if", true)
                              ], 4 /* STYLE */),
                              _createElementVNode("div", _hoisted_51, [
                                _createElementVNode("div", _hoisted_52, _toDisplayString(c.name), 1 /* TEXT */),
                                _createElementVNode("div", _hoisted_53, _toDisplayString(c.description || _ctx.t('(no description)')), 1 /* TEXT */),
                                _createElementVNode("div", _hoisted_54, _toDisplayString(_ctx.t('{n} items', {n: c.record_count})), 1 /* TEXT */)
                              ])
                            ], 8 /* PROPS */, _hoisted_49))
                          }), 128 /* KEYED_FRAGMENT */))
                        ]))
                      : (_openBlock(), _createElementBlock("div", _hoisted_55, [
                          _hoisted_56,
                          _createElementVNode("p", null, [
                            _createTextVNode(_toDisplayString(_ctx.t('No collections yet.')), 1 /* TEXT */),
                            _hoisted_57,
                            _createTextVNode(_toDisplayString(_ctx.t('Create one from “＋ New collection” on the left.')), 1 /* TEXT */)
                          ])
                        ]))
                  ]))
                : (_openBlock(), _createElementBlock(_Fragment, { key: 1 }, [
                    _createElementVNode("div", _hoisted_58, [
                      _createElementVNode("div", _hoisted_59, [
                        _createElementVNode("button", {
                          type: "button",
                          class: _normalizeClass(["lt-toggle", {on: _ctx.selectionMode}]),
                          onClick: _cache[16] || (_cache[16] = (...args) => (_ctx.toggleSelectionMode && _ctx.toggleSelectionMode(...args))),
                          title: _ctx.t('Search, sort & bulk actions')
                        }, "☰", 10 /* CLASS, PROPS */, _hoisted_60),
                        _createElementVNode("span", _hoisted_61, [
                          (_ctx.shareBadge(_ctx.current))
                            ? (_openBlock(), _createElementBlock("span", {
                                key: 0,
                                class: "share-badge",
                                title: _ctx.shareBadgeTitle(_ctx.current)
                              }, _toDisplayString(_ctx.shareBadge(_ctx.current)), 9 /* TEXT, PROPS */, _hoisted_62))
                            : _createCommentVNode("v-if", true),
                          _createElementVNode("span", _hoisted_63, _toDisplayString(_ctx.current.icon), 1 /* TEXT */),
                          _createTextVNode(_toDisplayString(_ctx.current.name), 1 /* TEXT */)
                        ]),
                        (_ctx.records.length)
                          ? (_openBlock(), _createElementBlock("span", _hoisted_64, _toDisplayString(_ctx.t('{shown} / {total} items', {shown: _ctx.visibleRecords.length, total: _ctx.records.length})), 1 /* TEXT */))
                          : _createCommentVNode("v-if", true)
                      ]),
                      _withDirectives(_createElementVNode("div", _hoisted_65, [
                        _createElementVNode("div", _hoisted_66, [
                          _createElementVNode("div", _hoisted_67, [
                            _withDirectives(_createElementVNode("input", {
                              class: "searchinput",
                              "onUpdate:modelValue": _cache[17] || (_cache[17] = $event => ((_ctx.search) = $event)),
                              onInput: _cache[18] || (_cache[18] = (...args) => (_ctx.onSearchInput && _ctx.onSearchInput(...args))),
                              placeholder: _ctx.t('🔍 Search in this collection')
                            }, null, 40 /* PROPS, NEED_HYDRATION */, _hoisted_68), [
                              [_vModelText, _ctx.search]
                            ]),
                            _createElementVNode("label", {
                              class: "search-mode",
                              title: _ctx.t('Treat the search text as a regular expression')
                            }, [
                              _withDirectives(_createElementVNode("input", {
                                type: "checkbox",
                                "onUpdate:modelValue": _cache[19] || (_cache[19] = $event => ((_ctx.searchRegex) = $event)),
                                onChange: _cache[20] || (_cache[20] = (...args) => (_ctx.onSearchInput && _ctx.onSearchInput(...args)))
                              }, null, 544 /* NEED_HYDRATION, NEED_PATCH */), [
                                [_vModelCheckbox, _ctx.searchRegex]
                              ]),
                              _createTextVNode(" " + _toDisplayString(_ctx.t('Regex')), 1 /* TEXT */)
                            ], 8 /* PROPS */, _hoisted_69),
                            (_ctx.searchRegex)
                              ? (_openBlock(), _createElementBlock("button", {
                                  key: 0,
                                  type: "button",
                                  class: _normalizeClass(["rx-help-btn", {on: _ctx.showRegexHelp}]),
                                  onClick: _cache[21] || (_cache[21] = $event => (_ctx.showRegexHelp = !_ctx.showRegexHelp)),
                                  title: _ctx.t('Show usable regular-expression syntax'),
                                  "aria-expanded": _ctx.showRegexHelp ? 'true' : 'false'
                                }, "?", 10 /* CLASS, PROPS */, _hoisted_70))
                              : _createCommentVNode("v-if", true),
                            (_ctx.canEdit && !_ctx.isLocked)
                              ? (_openBlock(), _createElementBlock("label", {
                                  key: 1,
                                  class: "replace-toggle",
                                  title: _ctx.t('Find & replace text across the matched records')
                                }, [
                                  _withDirectives(_createElementVNode("input", {
                                    type: "checkbox",
                                    "onUpdate:modelValue": _cache[22] || (_cache[22] = $event => ((_ctx.replaceOn) = $event))
                                  }, null, 512 /* NEED_PATCH */), [
                                    [_vModelCheckbox, _ctx.replaceOn]
                                  ]),
                                  _createTextVNode(" " + _toDisplayString(_ctx.t('Replace')), 1 /* TEXT */)
                                ], 8 /* PROPS */, _hoisted_71))
                              : _createCommentVNode("v-if", true),
                            (_ctx.canEdit && !_ctx.isLocked && _ctx.replaceOn)
                              ? (_openBlock(), _createElementBlock(_Fragment, { key: 2 }, [
                                  _withDirectives(_createElementVNode("input", {
                                    class: "searchinput replaceinput",
                                    "onUpdate:modelValue": _cache[23] || (_cache[23] = $event => ((_ctx.replaceWith) = $event)),
                                    placeholder: _ctx.t('Replace with…')
                                  }, null, 8 /* PROPS */, _hoisted_72), [
                                    [_vModelText, _ctx.replaceWith]
                                  ]),
                                  (_ctx.search)
                                    ? (_openBlock(), _createElementBlock("span", _hoisted_73, _toDisplayString(_ctx.t('{n} matched', {n: _ctx.records.length})), 1 /* TEXT */))
                                    : _createCommentVNode("v-if", true),
                                  _createElementVNode("button", {
                                    class: "btn sm sr-apply",
                                    disabled: !_ctx.search || _ctx.replaceBusy,
                                    onClick: _cache[24] || (_cache[24] = (...args) => (_ctx.applyReplace && _ctx.applyReplace(...args)))
                                  }, _toDisplayString(_ctx.replaceBusy ? _ctx.t('Replacing…') : _ctx.t('Replace all')), 9 /* TEXT, PROPS */, _hoisted_74)
                                ], 64 /* STABLE_FRAGMENT */))
                              : _createCommentVNode("v-if", true)
                          ]),
                          (_ctx.searchRegex && _ctx.showRegexHelp)
                            ? (_openBlock(), _createElementBlock("div", _hoisted_75, [
                                _createElementVNode("div", _hoisted_76, [
                                  _createElementVNode("span", null, _toDisplayString(_ctx.regexHelpPage === 1 ? _ctx.t('Usable regular expressions') : _ctx.t('Examples')), 1 /* TEXT */),
                                  _createElementVNode("span", _hoisted_77, [
                                    _createElementVNode("button", {
                                      type: "button",
                                      class: "rx-nav",
                                      disabled: _ctx.regexHelpPage === 1,
                                      onClick: _cache[25] || (_cache[25] = $event => (_ctx.regexHelpPage = 1)),
                                      title: _ctx.t('Previous')
                                    }, "‹", 8 /* PROPS */, _hoisted_78),
                                    _createElementVNode("span", _hoisted_79, _toDisplayString(_ctx.regexHelpPage) + " / 2", 1 /* TEXT */),
                                    _createElementVNode("button", {
                                      type: "button",
                                      class: "rx-nav",
                                      disabled: _ctx.regexHelpPage === 2,
                                      onClick: _cache[26] || (_cache[26] = $event => (_ctx.regexHelpPage = 2)),
                                      title: _ctx.t('Next')
                                    }, "›", 8 /* PROPS */, _hoisted_80)
                                  ])
                                ]),
                                _createElementVNode("table", _hoisted_81, [
                                  (_openBlock(true), _createElementBlock(_Fragment, null, _renderList((_ctx.regexHelpPage === 1 ? _ctx.regexHelpRows : _ctx.regexExampleRows), (row) => {
                                    return (_openBlock(), _createElementBlock("tr", {
                                      key: row.p
                                    }, [
                                      _createElementVNode("td", _hoisted_82, [
                                        _createElementVNode("code", null, _toDisplayString(row.p), 1 /* TEXT */)
                                      ]),
                                      _createElementVNode("td", _hoisted_83, _toDisplayString(row.d), 1 /* TEXT */),
                                      _createElementVNode("td", _hoisted_84, [
                                        _createElementVNode("code", null, _toDisplayString(row.e), 1 /* TEXT */)
                                      ])
                                    ]))
                                  }), 128 /* KEYED_FRAGMENT */))
                                ]),
                                (_ctx.regexHelpPage === 1)
                                  ? (_openBlock(), _createElementBlock("ul", _hoisted_85, [
                                      _createElementVNode("li", null, _toDisplayString(_ctx.t('Matching is case-sensitive. Put (?i) at the start of the pattern to ignore case.')), 1 /* TEXT */),
                                      _createElementVNode("li", null, _toDisplayString(_ctx.t('Unicode text such as Japanese is supported.')), 1 /* TEXT */),
                                      _createElementVNode("li", null, _toDisplayString(_ctx.t('In the replacement text, $1 $2 … insert the captured groups.')), 1 /* TEXT */)
                                    ]))
                                  : (_openBlock(), _createElementBlock("ul", _hoisted_86, [
                                      _createElementVNode("li", null, _toDisplayString(_ctx.t('The right column shows text that would match.')), 1 /* TEXT */)
                                    ]))
                              ]))
                            : _createCommentVNode("v-if", true)
                        ]),
                        _createElementVNode("div", _hoisted_87, [
                          _createElementVNode("span", _hoisted_88, _toDisplayString(_ctx.selectedIds.length ? _ctx.t('{n} selected', {n: _ctx.selectedIds.length}) : _ctx.t('Select records')), 1 /* TEXT */),
                          _createElementVNode("button", {
                            class: "btn sm ghost",
                            onClick: _cache[27] || (_cache[27] = (...args) => (_ctx.selectAll && _ctx.selectAll(...args))),
                            disabled: !_ctx.records.length
                          }, _toDisplayString(_ctx.t('Select all')), 9 /* TEXT, PROPS */, _hoisted_89),
                          _createElementVNode("button", {
                            class: "btn sm ghost",
                            disabled: !_ctx.selectedIds.length,
                            onClick: _cache[28] || (_cache[28] = (...args) => (_ctx.clearSelection && _ctx.clearSelection(...args)))
                          }, _toDisplayString(_ctx.t('Clear')), 9 /* TEXT, PROPS */, _hoisted_90),
                          _hoisted_91,
                          _createElementVNode("span", {
                            class: "sortgroup",
                            title: _ctx.t('Display order — only changes how records are shown here')
                          }, [
                            _createElementVNode("span", _hoisted_93, "👁 " + _toDisplayString(_ctx.t('Sort')), 1 /* TEXT */),
                            _createElementVNode("select", {
                              class: "sortselect",
                              value: _ctx.normSort(_ctx.current.record_sort),
                              onChange: _cache[29] || (_cache[29] = $event => (_ctx.setSort($event.target.value))),
                              title: _ctx.t('Display order — only changes how records are shown here')
                            }, [
                              _createElementVNode("option", _hoisted_95, _toDisplayString(_ctx.t('Registration order (oldest first)')), 1 /* TEXT */),
                              _createElementVNode("option", _hoisted_96, _toDisplayString(_ctx.t('Registration order (newest first)')), 1 /* TEXT */),
                              _createElementVNode("option", _hoisted_97, _toDisplayString(_ctx.t('By name (character code, ascending)')), 1 /* TEXT */),
                              _createElementVNode("option", _hoisted_98, _toDisplayString(_ctx.t('By name (character code, descending)')), 1 /* TEXT */)
                            ], 40 /* PROPS, NEED_HYDRATION */, _hoisted_94)
                          ], 8 /* PROPS */, _hoisted_92),
                          (_ctx.canEdit && _ctx.records.length>1)
                            ? (_openBlock(), _createElementBlock("button", {
                                key: 0,
                                class: "btn sm reorder-open",
                                onClick: _cache[30] || (_cache[30] = (...args) => (_ctx.openReorder && _ctx.openReorder(...args))),
                                title: _ctx.t('Edit the saved registration order of the records (drag, or sort by up to 5 fields)')
                              }, "⇅ " + _toDisplayString(_ctx.t('Edit saved order')), 9 /* TEXT, PROPS */, _hoisted_99))
                            : _createCommentVNode("v-if", true),
                          (_ctx.canEdit)
                            ? (_openBlock(), _createElementBlock("button", {
                                key: 1,
                                class: "btn sm",
                                disabled: !_ctx.selectedIds.length,
                                onClick: _cache[31] || (_cache[31] = (...args) => (_ctx.duplicateInPlace && _ctx.duplicateInPlace(...args))),
                                title: _ctx.t('Duplicate within this collection')
                              }, _toDisplayString(_ctx.t('Duplicate')), 9 /* TEXT, PROPS */, _hoisted_100))
                            : _createCommentVNode("v-if", true),
                          (_ctx.isOwner && !_ctx.isLocked)
                            ? (_openBlock(), _createElementBlock("button", {
                                key: 2,
                                class: "btn sm",
                                disabled: !_ctx.selectedIds.length,
                                onClick: _cache[32] || (_cache[32] = $event => (_ctx.openTransferBulk('copy')))
                              }, _toDisplayString(_ctx.t('Copy to collection')), 9 /* TEXT, PROPS */, _hoisted_101))
                            : _createCommentVNode("v-if", true),
                          (_ctx.isOwner && !_ctx.isLocked)
                            ? (_openBlock(), _createElementBlock("button", {
                                key: 3,
                                class: "btn sm",
                                disabled: !_ctx.selectedIds.length,
                                onClick: _cache[33] || (_cache[33] = $event => (_ctx.openTransferBulk('move')))
                              }, _toDisplayString(_ctx.t('Move to collection')), 9 /* TEXT, PROPS */, _hoisted_102))
                            : _createCommentVNode("v-if", true),
                          (_ctx.canDelete)
                            ? (_openBlock(), _createElementBlock("button", {
                                key: 4,
                                class: "btn sm danger",
                                disabled: !_ctx.selectedIds.length,
                                onClick: _cache[34] || (_cache[34] = (...args) => (_ctx.openBulkDelete && _ctx.openBulkDelete(...args)))
                              }, _toDisplayString(_ctx.t('Delete')), 9 /* TEXT, PROPS */, _hoisted_103))
                            : _createCommentVNode("v-if", true)
                        ])
                      ], 512 /* NEED_PATCH */), [
                        [_vShow, _ctx.selectionMode]
                      ])
                    ]),
                    (!_ctx.records.length)
                      ? (_openBlock(), _createElementBlock("div", _hoisted_104, [
                          _createElementVNode("div", _hoisted_105, _toDisplayString(_ctx.current.icon), 1 /* TEXT */),
                          (_ctx.search)
                            ? (_openBlock(), _createElementBlock("p", _hoisted_106, _toDisplayString(_ctx.t('No records match “{q}”', {q: _ctx.search})), 1 /* TEXT */))
                            : (_openBlock(), _createElementBlock(_Fragment, { key: 1 }, [
                                _createElementVNode("p", null, _toDisplayString(_ctx.t('No records yet')), 1 /* TEXT */),
                                _createElementVNode("button", {
                                  class: "btn primary",
                                  onClick: _cache[35] || (_cache[35] = (...args) => (_ctx.openNewRecord && _ctx.openNewRecord(...args)))
                                }, _toDisplayString(_ctx.t('＋ Add the first record')), 1 /* TEXT */)
                              ], 64 /* STABLE_FRAGMENT */))
                        ]))
                      : (_openBlock(), _createElementBlock(_Fragment, { key: 1 }, [
                          _createCommentVNode(" カード型 "),
                          (_ctx.curView==='card')
                            ? (_openBlock(), _createElementBlock("div", _hoisted_107, [
                                (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.visibleRecords, (r) => {
                                  return (_openBlock(), _createElementBlock("div", {
                                    key: r.id,
                                    class: _normalizeClass(["rec-wrap card", {sel: _ctx.isSelected(r.id)}])
                                  }, [
                                    _createElementVNode("input", {
                                      type: "checkbox",
                                      class: "rec-check",
                                      checked: _ctx.isSelected(r.id),
                                      onChange: $event => (_ctx.toggleSelect(r.id))
                                    }, null, 40 /* PROPS, NEED_HYDRATION */, _hoisted_108),
                                    _createElementVNode("button", {
                                      class: "rec-copy",
                                      onClick: _withModifiers($event => (_ctx.copyRecord(r)), ["stop"]),
                                      title: _ctx.t('Copy the whole card')
                                    }, "⧉", 8 /* PROPS */, _hoisted_109),
                                    _createElementVNode("button", {
                                      class: "rec-card",
                                      onClick: $event => (_ctx.openRecord(r))
                                    }, [
                                      _createElementVNode("div", _hoisted_111, _toDisplayString(r.title), 1 /* TEXT */),
                                      _createElementVNode("div", _hoisted_112, [
                                        _createElementVNode("span", null, _toDisplayString(_ctx.summary(r)), 1 /* TEXT */)
                                      ])
                                    ], 8 /* PROPS */, _hoisted_110)
                                  ], 2 /* CLASS */))
                                }), 128 /* KEYED_FRAGMENT */))
                              ]))
                            : (_ctx.curView==='list')
                              ? (_openBlock(), _createElementBlock(_Fragment, { key: 1 }, [
                                  _createCommentVNode(" リスト型（既定・detail/image からのフォールバック先） "),
                                  _createElementVNode("div", _hoisted_113, [
                                    (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.visibleRecords, (r) => {
                                      return (_openBlock(), _createElementBlock("div", {
                                        key: r.id,
                                        class: _normalizeClass(["rec-wrap row", {sel: _ctx.isSelected(r.id)}])
                                      }, [
                                        _createElementVNode("input", {
                                          type: "checkbox",
                                          class: "rec-check inline",
                                          checked: _ctx.isSelected(r.id),
                                          onChange: $event => (_ctx.toggleSelect(r.id))
                                        }, null, 40 /* PROPS, NEED_HYDRATION */, _hoisted_114),
                                        _createElementVNode("button", {
                                          class: "rec-row",
                                          onClick: $event => (_ctx.openRecord(r))
                                        }, [
                                          _createElementVNode("span", _hoisted_116, _toDisplayString(r.title), 1 /* TEXT */),
                                          _createElementVNode("span", _hoisted_117, _toDisplayString(_ctx.summary(r)), 1 /* TEXT */),
                                          _hoisted_118
                                        ], 8 /* PROPS */, _hoisted_115),
                                        _createElementVNode("button", {
                                          class: "rec-copy inline",
                                          onClick: _withModifiers($event => (_ctx.copyRecord(r)), ["stop"]),
                                          title: _ctx.t('Copy the whole card')
                                        }, "⧉", 8 /* PROPS */, _hoisted_119)
                                      ], 2 /* CLASS */))
                                    }), 128 /* KEYED_FRAGMENT */))
                                  ])
                                ], 2112 /* STABLE_FRAGMENT, DEV_ROOT_FRAGMENT */))
                              : (_ctx.curView==='table')
                                ? (_openBlock(), _createElementBlock(_Fragment, { key: 2 }, [
                                    _createCommentVNode(" 表計算型（左端の項目を固定／2列目以降はドラッグで横スクロール） "),
                                    _createElementVNode("div", {
                                      class: _normalizeClass(["rec-table-wrap", {dragging: _ctx.tableDrag.active}]),
                                      onScroll: _cache[39] || (_cache[39] = (...args) => (_ctx.onScrollNearBottom && _ctx.onScrollNearBottom(...args))),
                                      onPointerdown: _cache[40] || (_cache[40] = (...args) => (_ctx.tableDown && _ctx.tableDown(...args))),
                                      onPointermove: _cache[41] || (_cache[41] = (...args) => (_ctx.tableMove && _ctx.tableMove(...args))),
                                      onPointerup: _cache[42] || (_cache[42] = (...args) => (_ctx.tableUp && _ctx.tableUp(...args))),
                                      onPointercancel: _cache[43] || (_cache[43] = (...args) => (_ctx.tableUp && _ctx.tableUp(...args)))
                                    }, [
                                      _createElementVNode("table", _hoisted_120, [
                                        _createElementVNode("thead", null, [
                                          _createElementVNode("tr", null, [
                                            _createElementVNode("th", {
                                              class: _normalizeClass(["rt-frozen", {'rt-keycol': _ctx.tableFrozenCol && _ctx.tableFrozenCol.keycol, 'rt-emptycol': _ctx.tableFrozenCol && _ctx.emptyColumnIds.has(_ctx.tableFrozenCol.id)}])
                                            }, [
                                              _createElementVNode("label", _hoisted_121, [
                                                _createElementVNode("input", {
                                                  type: "checkbox",
                                                  checked: _ctx.allSelected,
                                                  onChange: _cache[36] || (_cache[36] = $event => (_ctx.allSelected ? _ctx.clearSelection() : _ctx.selectAll()))
                                                }, null, 40 /* PROPS, NEED_HYDRATION */, _hoisted_122),
                                                (_ctx.tableFrozenCol)
                                                  ? (_openBlock(), _createElementBlock("span", _hoisted_123, _toDisplayString(_ctx.tableFrozenCol.label), 1 /* TEXT */))
                                                  : _createCommentVNode("v-if", true)
                                              ])
                                            ], 2 /* CLASS */),
                                            (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.tableScrollCols, (col) => {
                                              return (_openBlock(), _createElementBlock("th", {
                                                key: col.id,
                                                class: _normalizeClass({'rt-keycol': col.keycol, 'rt-emptycol': _ctx.emptyColumnIds.has(col.id)})
                                              }, _toDisplayString(col.label), 3 /* TEXT, CLASS */))
                                            }), 128 /* KEYED_FRAGMENT */)),
                                            _hoisted_124
                                          ])
                                        ]),
                                        _createElementVNode("tbody", null, [
                                          (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.visibleRecords, (r) => {
                                            return (_openBlock(), _createElementBlock("tr", {
                                              key: r.id,
                                              class: _normalizeClass({sel: _ctx.isSelected(r.id)})
                                            }, [
                                              _createElementVNode("td", _hoisted_125, [
                                                _createElementVNode("label", {
                                                  class: "rt-fcell",
                                                  onClick: _cache[37] || (_cache[37] = _withModifiers(() => {}, ["stop"]))
                                                }, [
                                                  _createElementVNode("input", {
                                                    type: "checkbox",
                                                    checked: _ctx.isSelected(r.id),
                                                    onChange: $event => (_ctx.toggleSelect(r.id))
                                                  }, null, 40 /* PROPS, NEED_HYDRATION */, _hoisted_126)
                                                ]),
                                                _createElementVNode("span", {
                                                  class: _normalizeClass(["rt-fval", {mono: _ctx.tableFrozenCol && _ctx.tableFrozenCol.secret, 'rt-keycol': _ctx.tableFrozenCol && _ctx.tableFrozenCol.keycol}]),
                                                  onClick: $event => (_ctx.openRecord(r)),
                                                  title: _ctx.t('Edit')
                                                }, [
                                                  (_ctx.colImg(r, _ctx.tableFrozenCol))
                                                    ? (_openBlock(), _createElementBlock("img", {
                                                        key: 0,
                                                        src: _ctx.colImg(r, _ctx.tableFrozenCol),
                                                        class: "rt-thumb",
                                                        loading: "lazy"
                                                      }, null, 8 /* PROPS */, _hoisted_128))
                                                    : (_openBlock(), _createElementBlock(_Fragment, { key: 1 }, [
                                                        _createTextVNode(_toDisplayString(_ctx.colText(r, _ctx.tableFrozenCol)), 1 /* TEXT */)
                                                      ], 64 /* STABLE_FRAGMENT */))
                                                ], 10 /* CLASS, PROPS */, _hoisted_127)
                                              ]),
                                              (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.tableScrollCols, (col) => {
                                                return (_openBlock(), _createElementBlock("td", {
                                                  key: col.id,
                                                  class: _normalizeClass({mono: col.secret, 'rt-keycol': col.keycol})
                                                }, [
                                                  (_ctx.colImg(r, col))
                                                    ? (_openBlock(), _createElementBlock("img", {
                                                        key: 0,
                                                        src: _ctx.colImg(r, col),
                                                        class: "rt-thumb",
                                                        loading: "lazy"
                                                      }, null, 8 /* PROPS */, _hoisted_129))
                                                    : (_openBlock(), _createElementBlock("span", _hoisted_130, _toDisplayString(_ctx.colText(r, col)), 1 /* TEXT */))
                                                ], 2 /* CLASS */))
                                              }), 128 /* KEYED_FRAGMENT */)),
                                              _createElementVNode("td", {
                                                class: "rt-actions",
                                                onClick: _cache[38] || (_cache[38] = _withModifiers(() => {}, ["stop"]))
                                              }, [
                                                _createElementVNode("button", {
                                                  class: "rec-copy inline",
                                                  onClick: $event => (_ctx.copyRecord(r)),
                                                  title: _ctx.t('Copy the whole card')
                                                }, "⧉", 8 /* PROPS */, _hoisted_131)
                                              ])
                                            ], 2 /* CLASS */))
                                          }), 128 /* KEYED_FRAGMENT */))
                                        ])
                                      ])
                                    ], 34 /* CLASS, NEED_HYDRATION */)
                                  ], 2112 /* STABLE_FRAGMENT, DEV_ROOT_FRAGMENT */))
                                : (_ctx.curView==='note')
                                  ? (_openBlock(), _createElementBlock(_Fragment, { key: 3 }, [
                                      _createCommentVNode(" ノート形式（本体は「タイトル一覧｜内容」の2列。コレクション一覧＝左サイドバーが\n               Notes のグループ列に相当し、全体で3ペインになる） "),
                                      _createElementVNode("div", _hoisted_132, [
                                        _createElementVNode("div", _hoisted_133, [
                                          _createElementVNode("div", _hoisted_134, [
                                            (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.visibleRecords, (r) => {
                                              return (_openBlock(), _createElementBlock("button", {
                                                key: r.id,
                                                type: "button",
                                                class: _normalizeClass(["note-titem", {on: _ctx.note.id===r.id}]),
                                                onClick: $event => (_ctx.selNoteRec(r))
                                              }, [
                                                _createElementVNode("span", _hoisted_136, _toDisplayString(r.title), 1 /* TEXT */),
                                                (_ctx.summary(r))
                                                  ? (_openBlock(), _createElementBlock("span", _hoisted_137, _toDisplayString(_ctx.summary(r)), 1 /* TEXT */))
                                                  : _createCommentVNode("v-if", true)
                                              ], 10 /* CLASS, PROPS */, _hoisted_135))
                                            }), 128 /* KEYED_FRAGMENT */))
                                          ])
                                        ]),
                                        _createElementVNode("div", {
                                          class: "note-pane note-content",
                                          style: _normalizeStyle({'--rb-coll-color': _ctx.current.color})
                                        }, [
                                          (_ctx.noteCur)
                                            ? (_openBlock(), _createElementBlock(_Fragment, { key: 0 }, [
                                                _createElementVNode("div", _hoisted_138, [
                                                  _createElementVNode("h3", _hoisted_139, _toDisplayString(_ctx.noteCur.title), 1 /* TEXT */),
                                                  _createElementVNode("div", _hoisted_140, [
                                                    _createElementVNode("button", {
                                                      type: "button",
                                                      class: "btn sm",
                                                      onClick: _cache[44] || (_cache[44] = $event => (_ctx.copyRecord(_ctx.noteCur))),
                                                      title: _ctx.t('⧉ Copy all')
                                                    }, "⧉", 8 /* PROPS */, _hoisted_141),
                                                    (_ctx.isOwner && !_ctx.isLocked)
                                                      ? (_openBlock(), _createElementBlock("button", {
                                                          key: 0,
                                                          type: "button",
                                                          class: "btn sm",
                                                          onClick: _cache[45] || (_cache[45] = $event => (_ctx.openTransfer(_ctx.noteCur))),
                                                          title: _ctx.t('↔ Move / Copy')
                                                        }, "↔", 8 /* PROPS */, _hoisted_142))
                                                      : _createCommentVNode("v-if", true),
                                                    (_ctx.canEdit)
                                                      ? (_openBlock(), _createElementBlock("button", {
                                                          key: 1,
                                                          type: "button",
                                                          class: "btn sm primary",
                                                          onClick: _cache[46] || (_cache[46] = $event => (_ctx.editRecord(_ctx.noteCur)))
                                                        }, _toDisplayString(_ctx.t('Edit')), 1 /* TEXT */))
                                                      : _createCommentVNode("v-if", true),
                                                    (_ctx.canDelete)
                                                      ? (_openBlock(), _createElementBlock("button", {
                                                          key: 2,
                                                          type: "button",
                                                          class: "btn sm danger",
                                                          onClick: _cache[47] || (_cache[47] = $event => (_ctx.deleteRecord(_ctx.noteCur)))
                                                        }, _toDisplayString(_ctx.t('Delete')), 1 /* TEXT */))
                                                      : _createCommentVNode("v-if", true)
                                                  ])
                                                ]),
                                                _createElementVNode("div", _hoisted_143, [
                                                  (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.current.fields, (f) => {
                                                    return _withDirectives((_openBlock(), _createElementBlock("div", {
                                                      key: f.key,
                                                      class: "detail-row"
                                                    }, [
                                                      _createElementVNode("div", _hoisted_144, _toDisplayString(f.label), 1 /* TEXT */),
                                                      (f.type==='image' || f.type==='image_crop')
                                                        ? (_openBlock(), _createElementBlock("div", _hoisted_145, [
                                                            _createElementVNode("img", {
                                                              src: _ctx.imgUrl(_ctx.noteCur.data[f.key]),
                                                              class: "imgpreview lg"
                                                            }, null, 8 /* PROPS */, _hoisted_146)
                                                          ]))
                                                        : (f.type==='file')
                                                          ? (_openBlock(), _createElementBlock("div", _hoisted_147, [
                                                              _createElementVNode("span", _hoisted_148, _toDisplayString(_ctx.fileIcon(_ctx.noteCur.data[f.key])), 1 /* TEXT */),
                                                              _createElementVNode("span", _hoisted_149, _toDisplayString(_ctx.fileName(_ctx.noteCur.data[f.key])), 1 /* TEXT */),
                                                              _createElementVNode("button", {
                                                                type: "button",
                                                                class: "btn sm",
                                                                onClick: $event => (_ctx.openAttachment(_ctx.noteCur.data[f.key]))
                                                              }, _toDisplayString(_ctx.t('Open')), 9 /* TEXT, PROPS */, _hoisted_150),
                                                              _createElementVNode("button", {
                                                                type: "button",
                                                                class: "btn sm",
                                                                onClick: $event => (_ctx.downloadAttachment(_ctx.noteCur.data[f.key])),
                                                                title: _ctx.t('Download')
                                                              }, "⬇", 8 /* PROPS */, _hoisted_151)
                                                            ]))
                                                          : (_openBlock(), _createElementBlock("div", _hoisted_152, [
                                                              (_ctx.linkFor(f, _ctx.noteCur.data[f.key]))
                                                                ? (_openBlock(), _createElementBlock("a", {
                                                                    key: 0,
                                                                    class: "val link",
                                                                    href: _ctx.linkFor(f, _ctx.noteCur.data[f.key]),
                                                                    target: "_blank",
                                                                    rel: "noopener noreferrer"
                                                                  }, _toDisplayString(_ctx.displayVal(_ctx.noteCur, f)), 9 /* TEXT, PROPS */, _hoisted_153))
                                                                : (_openBlock(), _createElementBlock("span", {
                                                                    key: 1,
                                                                    class: _normalizeClass(["val", {mono: f.secret}])
                                                                  }, _toDisplayString(_ctx.displayVal(_ctx.noteCur, f)), 3 /* TEXT, CLASS */)),
                                                              (f.secret && !_ctx.secretsMasked)
                                                                ? (_openBlock(), _createElementBlock("button", {
                                                                    key: 2,
                                                                    type: "button",
                                                                    class: "icon-btn",
                                                                    onClick: $event => (_ctx.toggleReveal(f.key))
                                                                  }, _toDisplayString(_ctx.reveal[f.key]?'🙈':'👁'), 9 /* TEXT, PROPS */, _hoisted_154))
                                                                : _createCommentVNode("v-if", true),
                                                              (f.type==='date' || f.type==='month')
                                                                ? (_openBlock(), _createElementBlock("button", {
                                                                    key: 3,
                                                                    type: "button",
                                                                    class: "icon-btn",
                                                                    disabled: !_ctx.apps.calendar,
                                                                    title: _ctx.apps.calendar ? _ctx.t('Add reminder') : _ctx.t('The Calendar app is not enabled'),
                                                                    onClick: $event => (_ctx.addReminder(_ctx.noteCur, f))
                                                                  }, "📅", 8 /* PROPS */, _hoisted_155))
                                                                : _createCommentVNode("v-if", true),
                                                              (_ctx.fieldHasMap(f) && _ctx.noteCur.data[f.key])
                                                                ? (_openBlock(), _createElementBlock("button", {
                                                                    key: 4,
                                                                    type: "button",
                                                                    class: "icon-btn",
                                                                    title: _ctx.t('Open in map'),
                                                                    onClick: $event => (_ctx.openMap(_ctx.noteCur.data[f.key]))
                                                                  }, "🌐", 8 /* PROPS */, _hoisted_156))
                                                                : _createCommentVNode("v-if", true),
                                                              (!(f.secret && _ctx.secretsMasked))
                                                                ? (_openBlock(), _createElementBlock("button", {
                                                                    key: 5,
                                                                    type: "button",
                                                                    class: "icon-btn",
                                                                    onClick: $event => (_ctx.copyVal(f.secret ? _ctx.openDecrypted[f.key] : _ctx.noteCur.data[f.key])),
                                                                    title: _ctx.t('Copy')
                                                                  }, "⧉", 8 /* PROPS */, _hoisted_157))
                                                                : _createCommentVNode("v-if", true)
                                                            ]))
                                                    ])), [
                                                      [_vShow, _ctx.noteCur.data[f.key] != null && _ctx.noteCur.data[f.key] !== '']
                                                    ])
                                                  }), 128 /* KEYED_FRAGMENT */))
                                                ])
                                              ], 64 /* STABLE_FRAGMENT */))
                                            : (_openBlock(), _createElementBlock("div", _hoisted_158, [
                                                _hoisted_159,
                                                _createElementVNode("p", null, _toDisplayString(_ctx.t('Select a record on the left to see its contents.')), 1 /* TEXT */)
                                              ]))
                                        ], 4 /* STYLE */)
                                      ])
                                    ], 2112 /* STABLE_FRAGMENT, DEV_ROOT_FRAGMENT */))
                                  : _createCommentVNode("v-if", true)
                        ], 64 /* STABLE_FRAGMENT */))
                  ], 64 /* STABLE_FRAGMENT */))
            ], 34 /* CLASS, NEED_HYDRATION */),
            (_ctx.current && _ctx.records.length && _ctx.curView!=='table' && _ctx.curView!=='note')
              ? (_openBlock(), _createElementBlock("div", _hoisted_160, [
                  _createElementVNode("button", {
                    class: "scrollnav-btn",
                    onClick: _cache[49] || (_cache[49] = (...args) => (_ctx.scrollToTop && _ctx.scrollToTop(...args))),
                    title: _ctx.t('To top')
                  }, "▲", 8 /* PROPS */, _hoisted_161),
                  _createElementVNode("button", {
                    class: "scrollnav-btn",
                    onClick: _cache[50] || (_cache[50] = (...args) => (_ctx.scrollToBottom && _ctx.scrollToBottom(...args))),
                    title: _ctx.t('To bottom')
                  }, "▼", 8 /* PROPS */, _hoisted_162)
                ]))
              : _createCommentVNode("v-if", true)
          ]),
          _createCommentVNode(" Template picker "),
          (_ctx.modal && _ctx.modal.type==='template')
            ? (_openBlock(), _createElementBlock("div", {
                key: 0,
                class: "modal-mask",
                onClick: _cache[56] || (_cache[56] = _withModifiers($event => (_ctx.modal=null), ["self"]))
              }, [
                _createElementVNode("div", _hoisted_163, [
                  _createElementVNode("div", _hoisted_164, [
                    _createElementVNode("h3", null, _toDisplayString(_ctx.t('New collection')), 1 /* TEXT */),
                    _createElementVNode("button", {
                      class: "icon-btn",
                      onClick: _cache[51] || (_cache[51] = $event => (_ctx.modal=null))
                    }, "✕")
                  ]),
                  _createElementVNode("div", _hoisted_165, [
                    _createElementVNode("button", {
                      class: "btn block",
                      style: {"margin-bottom":"8px"},
                      onClick: _cache[52] || (_cache[52] = (...args) => (_ctx.openImport && _ctx.openImport(...args)))
                    }, _toDisplayString(_ctx.t('📥 Import from CSV / JSON file (auto-create fields)')), 1 /* TEXT */),
                    _createElementVNode("button", {
                      class: "btn block",
                      style: {"margin-bottom":"8px"},
                      disabled: !_ctx.apps.contacts,
                      title: _ctx.apps.contacts ? '' : _ctx.t('The Contacts app is not enabled'),
                      onClick: _cache[53] || (_cache[53] = (...args) => (_ctx.openContactsImport && _ctx.openContactsImport(...args)))
                    }, _toDisplayString(_ctx.t('📇 Import from Contacts')), 9 /* TEXT, PROPS */, _hoisted_166),
                    _createElementVNode("button", {
                      class: "btn block",
                      style: {"margin-bottom":"14px"},
                      disabled: !_ctx.apps.tables,
                      title: _ctx.apps.tables ? '' : _ctx.t('The Tables app is not enabled'),
                      onClick: _cache[54] || (_cache[54] = (...args) => (_ctx.openTablesImport && _ctx.openTablesImport(...args)))
                    }, _toDisplayString(_ctx.t('📊 Import from Tables')), 9 /* TEXT, PROPS */, _hoisted_167),
                    _createElementVNode("div", _hoisted_168, _toDisplayString(_ctx.t('Or create from a template:')), 1 /* TEXT */),
                    (_ctx.templatesLoading && !_ctx.templates.length)
                      ? (_openBlock(), _createElementBlock("div", _hoisted_169, [
                          _createElementVNode("p", null, _toDisplayString(_ctx.t('Loading…')), 1 /* TEXT */)
                        ]))
                      : (_openBlock(), _createElementBlock("div", _hoisted_170, [
                          (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.templates, (tpl) => {
                            return (_openBlock(), _createElementBlock("div", {
                              key: tpl.key,
                              class: _normalizeClass(["tpl-card", {disabled: _ctx.busy}])
                            }, [
                              _createElementVNode("button", {
                                type: "button",
                                class: "tpl-main",
                                disabled: _ctx.busy,
                                onClick: $event => (_ctx.createFromTemplate(tpl))
                              }, [
                                _createElementVNode("div", _hoisted_172, [
                                  _createElementVNode("span", _hoisted_173, _toDisplayString(tpl.icon), 1 /* TEXT */),
                                  _createElementVNode("span", _hoisted_174, _toDisplayString(tpl.name), 1 /* TEXT */),
                                  (tpl.custom)
                                    ? (_openBlock(), _createElementBlock("span", _hoisted_175, _toDisplayString(_ctx.t('Custom')), 1 /* TEXT */))
                                    : (tpl.overridden)
                                      ? (_openBlock(), _createElementBlock("span", _hoisted_176, _toDisplayString(_ctx.t('Edited')), 1 /* TEXT */))
                                      : _createCommentVNode("v-if", true)
                                ]),
                                _createElementVNode("div", _hoisted_177, _toDisplayString(tpl.description), 1 /* TEXT */)
                              ], 8 /* PROPS */, _hoisted_171),
                              _createElementVNode("div", _hoisted_178, [
                                _createElementVNode("button", {
                                  type: "button",
                                  class: "icon-btn",
                                  title: _ctx.t('Edit template'),
                                  onClick: _withModifiers($event => (_ctx.openTemplateEditor(tpl)), ["stop"])
                                }, "✏️", 8 /* PROPS */, _hoisted_179),
                                (tpl.custom)
                                  ? (_openBlock(), _createElementBlock("button", {
                                      key: 0,
                                      type: "button",
                                      class: "icon-btn",
                                      title: _ctx.t('Delete template'),
                                      onClick: _withModifiers($event => (_ctx.deleteTemplate(tpl)), ["stop"])
                                    }, "🗑", 8 /* PROPS */, _hoisted_180))
                                  : (tpl.overridden)
                                    ? (_openBlock(), _createElementBlock("button", {
                                        key: 1,
                                        type: "button",
                                        class: "icon-btn",
                                        title: _ctx.t('Reset to default'),
                                        onClick: _withModifiers($event => (_ctx.resetTemplate(tpl)), ["stop"])
                                      }, "↺", 8 /* PROPS */, _hoisted_181))
                                    : _createCommentVNode("v-if", true)
                              ])
                            ], 2 /* CLASS */))
                          }), 128 /* KEYED_FRAGMENT */))
                        ]))
                  ]),
                  _createElementVNode("div", _hoisted_182, [
                    _createElementVNode("button", {
                      class: "btn",
                      onClick: _cache[55] || (_cache[55] = $event => (_ctx.modal=null))
                    }, _toDisplayString(_ctx.t('Cancel')), 1 /* TEXT */)
                  ])
                ])
              ]))
            : _createCommentVNode("v-if", true),
          _createCommentVNode(" Record form "),
          (_ctx.modal && _ctx.modal.type==='record')
            ? (_openBlock(), _createElementBlock("div", {
                key: 1,
                class: "modal-mask",
                onClick: _cache[63] || (_cache[63] = _withModifiers($event => (_ctx.modal=null), ["self"]))
              }, [
                _createElementVNode("form", {
                  class: "modal",
                  onSubmit: _cache[62] || (_cache[62] = _withModifiers((...args) => (_ctx.saveRecord && _ctx.saveRecord(...args)), ["prevent"]))
                }, [
                  _createElementVNode("div", _hoisted_183, [
                    _createElementVNode("h3", null, _toDisplayString(_ctx.editingRecordId ? _ctx.t('Edit record') : _ctx.t('New record')), 1 /* TEXT */),
                    _createElementVNode("button", {
                      type: "button",
                      class: "icon-btn",
                      onClick: _cache[57] || (_cache[57] = $event => (_ctx.modal=null))
                    }, "✕")
                  ]),
                  _createElementVNode("div", _hoisted_184, [
                    (_ctx.attachWarn)
                      ? (_openBlock(), _createElementBlock("div", _hoisted_185, "⚠️ " + _toDisplayString(_ctx.t('Please set a save folder for images and files in this collection’s settings.')), 1 /* TEXT */))
                      : _createCommentVNode("v-if", true),
                    (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.current.fields, (f) => {
                      return (_openBlock(), _createElementBlock("div", {
                        key: f.key,
                        class: "field"
                      }, [
                        _createElementVNode("label", null, [
                          _createTextVNode(_toDisplayString(f.label) + " ", 1 /* TEXT */),
                          (f.required)
                            ? (_openBlock(), _createElementBlock("span", _hoisted_186, "*"))
                            : _createCommentVNode("v-if", true),
                          _createTextVNode(),
                          (f.secret)
                            ? (_openBlock(), _createElementBlock("span", _hoisted_187, _toDisplayString(_ctx.t('Secret')), 1 /* TEXT */))
                            : _createCommentVNode("v-if", true)
                        ]),
                        (f.type==='textarea')
                          ? _withDirectives((_openBlock(), _createElementBlock("textarea", {
                              key: 0,
                              "onUpdate:modelValue": $event => ((_ctx.form[f.key]) = $event),
                              placeholder: f.placeholder||'',
                              maxlength: _ctx.ruleMax(f)
                            }, null, 8 /* PROPS */, _hoisted_188)), [
                              [_vModelText, _ctx.form[f.key]]
                            ])
                          : (f.type==='select')
                            ? _withDirectives((_openBlock(), _createElementBlock("select", {
                                key: 1,
                                "onUpdate:modelValue": $event => ((_ctx.form[f.key]) = $event)
                              }, [
                                _createElementVNode("option", _hoisted_190, _toDisplayString(_ctx.t('— Select —')), 1 /* TEXT */),
                                (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(f.options, (o) => {
                                  return (_openBlock(), _createElementBlock("option", {
                                    key: o,
                                    value: o
                                  }, _toDisplayString(o), 9 /* TEXT, PROPS */, _hoisted_191))
                                }), 128 /* KEYED_FRAGMENT */))
                              ], 8 /* PROPS */, _hoisted_189)), [
                                [_vModelSelect, _ctx.form[f.key]]
                              ])
                            : (f.type==='radio')
                              ? (_openBlock(), _createElementBlock("div", _hoisted_192, [
                                  (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(f.options, (o) => {
                                    return (_openBlock(), _createElementBlock("label", {
                                      key: o,
                                      class: "choice-opt"
                                    }, [
                                      _withDirectives(_createElementVNode("input", {
                                        type: "radio",
                                        name: 'r_'+f.key,
                                        value: o,
                                        "onUpdate:modelValue": $event => ((_ctx.form[f.key]) = $event)
                                      }, null, 8 /* PROPS */, _hoisted_193), [
                                        [_vModelRadio, _ctx.form[f.key]]
                                      ]),
                                      _createTextVNode(),
                                      _createElementVNode("span", null, _toDisplayString(o), 1 /* TEXT */)
                                    ]))
                                  }), 128 /* KEYED_FRAGMENT */)),
                                  (_ctx.form[f.key])
                                    ? (_openBlock(), _createElementBlock("button", {
                                        key: 0,
                                        type: "button",
                                        class: "btn sm choice-clear",
                                        onClick: $event => (_ctx.form[f.key]='')
                                      }, _toDisplayString(_ctx.t('Clear')), 9 /* TEXT, PROPS */, _hoisted_194))
                                    : _createCommentVNode("v-if", true)
                                ]))
                              : (f.type==='checkbox')
                                ? (_openBlock(), _createElementBlock("div", _hoisted_195, [
                                    (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(f.options, (o) => {
                                      return (_openBlock(), _createElementBlock("label", {
                                        key: o,
                                        class: "choice-opt"
                                      }, [
                                        _withDirectives(_createElementVNode("input", {
                                          type: "checkbox",
                                          value: o,
                                          "onUpdate:modelValue": $event => ((_ctx.form[f.key]) = $event)
                                        }, null, 8 /* PROPS */, _hoisted_196), [
                                          [_vModelCheckbox, _ctx.form[f.key]]
                                        ]),
                                        _createTextVNode(),
                                        _createElementVNode("span", null, _toDisplayString(o), 1 /* TEXT */)
                                      ]))
                                    }), 128 /* KEYED_FRAGMENT */))
                                  ]))
                                : (f.type==='image' || f.type==='image_crop')
                                  ? (_openBlock(), _createElementBlock("div", _hoisted_197, [
                                      _createElementVNode("div", {
                                        class: _normalizeClass(["dropzone", {over: _ctx.dropKey===f.key}]),
                                        onDragover: _cache[58] || (_cache[58] = _withModifiers(() => {}, ["prevent"])),
                                        onDragenter: _withModifiers($event => (_ctx.dropKey=f.key), ["prevent"]),
                                        onDragleave: _withModifiers($event => (_ctx.onDropLeave(f.key)), ["prevent"]),
                                        onDrop: _withModifiers($event => (_ctx.onImageDrop($event, f)), ["prevent"])
                                      }, [
                                        (_ctx.form[f.key])
                                          ? (_openBlock(), _createElementBlock("img", {
                                              key: 0,
                                              src: _ctx.imgUrl(_ctx.form[f.key]),
                                              class: "imgpreview"
                                            }, null, 8 /* PROPS */, _hoisted_199))
                                          : (_openBlock(), _createElementBlock("div", _hoisted_200, [
                                              _hoisted_201,
                                              _createTextVNode(_toDisplayString(_ctx.t('Drag & drop an image here')), 1 /* TEXT */),
                                              _hoisted_202,
                                              _createTextVNode(_toDisplayString(f.type==='image_crop' ? _ctx.t('or choose with the button below (will be cropped)') : _ctx.t('or choose with the button below')), 1 /* TEXT */)
                                            ]))
                                      ], 42 /* CLASS, PROPS, NEED_HYDRATION */, _hoisted_198),
                                      _createElementVNode("div", _hoisted_203, [
                                        _createElementVNode("button", {
                                          type: "button",
                                          class: "btn sm",
                                          onClick: $event => (_ctx.pickImageFromNc(f))
                                        }, _toDisplayString(_ctx.t('📂 Choose file')), 9 /* TEXT, PROPS */, _hoisted_204),
                                        _createElementVNode("label", _hoisted_205, [
                                          _createTextVNode(_toDisplayString(_ctx.t('⬆ Upload')), 1 /* TEXT */),
                                          _createElementVNode("input", {
                                            type: "file",
                                            accept: "image/*",
                                            style: {"display":"none"},
                                            onChange: $event => (_ctx.onImagePick($event, f))
                                          }, null, 40 /* PROPS, NEED_HYDRATION */, _hoisted_206)
                                        ]),
                                        (_ctx.form[f.key] && f.type==='image_crop')
                                          ? (_openBlock(), _createElementBlock("button", {
                                              key: 0,
                                              type: "button",
                                              class: "btn sm",
                                              onClick: $event => (_ctx.recropCurrent(f))
                                            }, _toDisplayString(_ctx.t('✂ Re-crop')), 9 /* TEXT, PROPS */, _hoisted_207))
                                          : _createCommentVNode("v-if", true),
                                        (_ctx.form[f.key])
                                          ? (_openBlock(), _createElementBlock("button", {
                                              key: 1,
                                              type: "button",
                                              class: "btn sm danger",
                                              onClick: $event => (_ctx.form[f.key]='')
                                            }, _toDisplayString(_ctx.t('Delete')), 9 /* TEXT, PROPS */, _hoisted_208))
                                          : _createCommentVNode("v-if", true)
                                      ])
                                    ]))
                                  : (f.type==='file')
                                    ? (_openBlock(), _createElementBlock("div", _hoisted_209, [
                                        (_ctx.form[f.key])
                                          ? (_openBlock(), _createElementBlock("div", _hoisted_210, [
                                              _createElementVNode("span", _hoisted_211, _toDisplayString(_ctx.fileIcon(_ctx.form[f.key])), 1 /* TEXT */),
                                              _createElementVNode("span", _hoisted_212, _toDisplayString(_ctx.fileName(_ctx.form[f.key])), 1 /* TEXT */),
                                              _createElementVNode("button", {
                                                type: "button",
                                                class: "btn sm",
                                                onClick: $event => (_ctx.openAttachment(_ctx.form[f.key]))
                                              }, _toDisplayString(_ctx.t('Open')), 9 /* TEXT, PROPS */, _hoisted_213),
                                              _createElementVNode("button", {
                                                type: "button",
                                                class: "btn sm",
                                                onClick: $event => (_ctx.downloadAttachment(_ctx.form[f.key])),
                                                title: _ctx.t('Download')
                                              }, "⬇", 8 /* PROPS */, _hoisted_214),
                                              _createElementVNode("button", {
                                                type: "button",
                                                class: "btn sm danger",
                                                onClick: $event => (_ctx.form[f.key]='')
                                              }, _toDisplayString(_ctx.t('Delete')), 9 /* TEXT, PROPS */, _hoisted_215)
                                            ]))
                                          : (_openBlock(), _createElementBlock(_Fragment, { key: 1 }, [
                                              _createElementVNode("div", {
                                                class: _normalizeClass(["dropzone", {over: _ctx.dropKey===f.key}]),
                                                onDragover: _cache[59] || (_cache[59] = _withModifiers(() => {}, ["prevent"])),
                                                onDragenter: _withModifiers($event => (_ctx.dropKey=f.key), ["prevent"]),
                                                onDragleave: _withModifiers($event => (_ctx.onDropLeave(f.key)), ["prevent"]),
                                                onDrop: _withModifiers($event => (_ctx.onDocDrop($event, f)), ["prevent"])
                                              }, [
                                                _createElementVNode("div", _hoisted_217, [
                                                  _hoisted_218,
                                                  _createTextVNode(_toDisplayString(_ctx.t('Drag & drop PDF / Word / Excel / ODF')), 1 /* TEXT */),
                                                  _hoisted_219,
                                                  _createTextVNode(_toDisplayString(_ctx.t('or choose and attach below')), 1 /* TEXT */)
                                                ])
                                              ], 42 /* CLASS, PROPS, NEED_HYDRATION */, _hoisted_216),
                                              _createElementVNode("div", _hoisted_220, [
                                                _createElementVNode("button", {
                                                  type: "button",
                                                  class: "btn sm",
                                                  onClick: $event => (_ctx.pickDocFromNc(f))
                                                }, _toDisplayString(_ctx.t('📂 Choose file')), 9 /* TEXT, PROPS */, _hoisted_221),
                                                _createElementVNode("label", _hoisted_222, [
                                                  _createTextVNode(_toDisplayString(_ctx.t('⬆ Upload')), 1 /* TEXT */),
                                                  _createElementVNode("input", {
                                                    type: "file",
                                                    accept: ".pdf,.odt,.ods,.odp,.docx,.xlsx",
                                                    style: {"display":"none"},
                                                    onChange: $event => (_ctx.onDocPick($event, f))
                                                  }, null, 40 /* PROPS, NEED_HYDRATION */, _hoisted_223)
                                                ]),
                                                _createElementVNode("button", {
                                                  type: "button",
                                                  class: "btn sm",
                                                  onClick: $event => (_ctx.openNotePicker(f))
                                                }, _toDisplayString(_ctx.t('📝 Attach a note')), 9 /* TEXT, PROPS */, _hoisted_224)
                                              ])
                                            ], 64 /* STABLE_FRAGMENT */))
                                      ]))
                                    : (_openBlock(), _createElementBlock("div", _hoisted_225, [
                                        _withDirectives(_createElementVNode("input", {
                                          type: _ctx.inputType(f),
                                          class: _normalizeClass({'secret-mask': f.secret && !_ctx.reveal[f.key]}),
                                          "onUpdate:modelValue": $event => ((_ctx.form[f.key]) = $event),
                                          placeholder: (f.secret && _ctx.secretsMasked) ? _ctx.t('(hidden — not shared)') : (f.placeholder||''),
                                          readonly: f.secret && _ctx.secretsMasked,
                                          autocomplete: f.secret?'off':'',
                                          autocorrect: "off",
                                          autocapitalize: "off",
                                          spellcheck: "false",
                                          "data-1p-ignore": "",
                                          "data-lpignore": "true",
                                          "data-bwignore": "",
                                          "data-form-type": "other",
                                          maxlength: _ctx.ruleMax(f)
                                        }, null, 10 /* CLASS, PROPS */, _hoisted_226), [
                                          [_vModelDynamic, _ctx.form[f.key]]
                                        ]),
                                        (f.secret && !_ctx.secretsMasked)
                                          ? (_openBlock(), _createElementBlock("button", {
                                              key: 0,
                                              type: "button",
                                              class: "icon-btn",
                                              onClick: _withModifiers($event => (_ctx.openPwGen('record', f)), ["stop"]),
                                              title: _ctx.t('Generate a password')
                                            }, "🎲", 8 /* PROPS */, _hoisted_227))
                                          : _createCommentVNode("v-if", true),
                                        (f.secret && !_ctx.secretsMasked)
                                          ? (_openBlock(), _createElementBlock("button", {
                                              key: 1,
                                              type: "button",
                                              class: "icon-btn",
                                              onClick: $event => (_ctx.toggleReveal(f.key))
                                            }, _toDisplayString(_ctx.reveal[f.key]?'🙈':'👁'), 9 /* TEXT, PROPS */, _hoisted_228))
                                          : _createCommentVNode("v-if", true)
                                      ])),
                        (_ctx.ruleHint(f))
                          ? (_openBlock(), _createElementBlock("div", _hoisted_229, "📏 " + _toDisplayString(_ctx.ruleHint(f)), 1 /* TEXT */))
                          : _createCommentVNode("v-if", true)
                      ]))
                    }), 128 /* KEYED_FRAGMENT */))
                  ]),
                  _createElementVNode("div", _hoisted_230, [
                    (_ctx.editingRecordId)
                      ? (_openBlock(), _createElementBlock("button", {
                          key: 0,
                          type: "button",
                          class: "btn danger",
                          onClick: _cache[60] || (_cache[60] = $event => (_ctx.deleteRecord({id:_ctx.editingRecordId})))
                        }, _toDisplayString(_ctx.t('Delete')), 1 /* TEXT */))
                      : _createCommentVNode("v-if", true),
                    _createElementVNode("button", {
                      type: "button",
                      class: "btn",
                      onClick: _cache[61] || (_cache[61] = $event => (_ctx.modal=null))
                    }, _toDisplayString(_ctx.t('Cancel')), 1 /* TEXT */),
                    _createElementVNode("button", _hoisted_231, _toDisplayString(_ctx.t('Save')), 1 /* TEXT */)
                  ])
                ], 32 /* NEED_HYDRATION */)
              ]))
            : _createCommentVNode("v-if", true),
          _createCommentVNode(" Record detail "),
          (_ctx.modal && _ctx.modal.type==='detail')
            ? (_openBlock(), _createElementBlock("div", {
                key: 2,
                class: "modal-mask",
                onClick: _cache[69] || (_cache[69] = _withModifiers($event => (_ctx.modal=null), ["self"]))
              }, [
                _createElementVNode("div", _hoisted_232, [
                  _createElementVNode("div", _hoisted_233, [
                    _createElementVNode("h3", null, _toDisplayString(_ctx.modal.rec.title), 1 /* TEXT */),
                    _createElementVNode("button", {
                      class: "icon-btn",
                      onClick: _cache[64] || (_cache[64] = $event => (_ctx.modal=null))
                    }, "✕")
                  ]),
                  _createElementVNode("div", _hoisted_234, [
                    (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.current.fields, (f) => {
                      return _withDirectives((_openBlock(), _createElementBlock("div", {
                        key: f.key,
                        class: "detail-row"
                      }, [
                        _createElementVNode("div", _hoisted_235, _toDisplayString(f.label), 1 /* TEXT */),
                        (f.type==='image' || f.type==='image_crop')
                          ? (_openBlock(), _createElementBlock("div", _hoisted_236, [
                              _createElementVNode("img", {
                                src: _ctx.imgUrl(_ctx.modal.rec.data[f.key]),
                                class: "imgpreview lg"
                              }, null, 8 /* PROPS */, _hoisted_237)
                            ]))
                          : (f.type==='file')
                            ? (_openBlock(), _createElementBlock("div", _hoisted_238, [
                                _createElementVNode("span", _hoisted_239, _toDisplayString(_ctx.fileIcon(_ctx.modal.rec.data[f.key])), 1 /* TEXT */),
                                _createElementVNode("span", _hoisted_240, _toDisplayString(_ctx.fileName(_ctx.modal.rec.data[f.key])), 1 /* TEXT */),
                                _createElementVNode("button", {
                                  class: "btn sm",
                                  onClick: $event => (_ctx.openAttachment(_ctx.modal.rec.data[f.key]))
                                }, _toDisplayString(_ctx.t('Open')), 9 /* TEXT, PROPS */, _hoisted_241),
                                _createElementVNode("button", {
                                  class: "btn sm",
                                  onClick: $event => (_ctx.downloadAttachment(_ctx.modal.rec.data[f.key])),
                                  title: _ctx.t('Download')
                                }, "⬇", 8 /* PROPS */, _hoisted_242)
                              ]))
                            : (_openBlock(), _createElementBlock("div", _hoisted_243, [
                                (_ctx.linkFor(f, _ctx.modal.rec.data[f.key]))
                                  ? (_openBlock(), _createElementBlock("a", {
                                      key: 0,
                                      class: "val link",
                                      href: _ctx.linkFor(f, _ctx.modal.rec.data[f.key]),
                                      target: "_blank",
                                      rel: "noopener noreferrer"
                                    }, _toDisplayString(_ctx.displayVal(_ctx.modal.rec, f)), 9 /* TEXT, PROPS */, _hoisted_244))
                                  : (_openBlock(), _createElementBlock("span", {
                                      key: 1,
                                      class: _normalizeClass(["val", {mono: f.secret}])
                                    }, _toDisplayString(_ctx.displayVal(_ctx.modal.rec, f)), 3 /* TEXT, CLASS */)),
                                (f.secret && !_ctx.secretsMasked)
                                  ? (_openBlock(), _createElementBlock("button", {
                                      key: 2,
                                      class: "icon-btn",
                                      onClick: $event => (_ctx.toggleReveal(f.key))
                                    }, _toDisplayString(_ctx.reveal[f.key]?'🙈':'👁'), 9 /* TEXT, PROPS */, _hoisted_245))
                                  : _createCommentVNode("v-if", true),
                                (f.type==='date' || f.type==='month')
                                  ? (_openBlock(), _createElementBlock("button", {
                                      key: 3,
                                      type: "button",
                                      class: "icon-btn",
                                      disabled: !_ctx.apps.calendar,
                                      title: _ctx.apps.calendar ? _ctx.t('Add reminder') : _ctx.t('The Calendar app is not enabled'),
                                      onClick: $event => (_ctx.addReminder(_ctx.modal.rec, f))
                                    }, "📅", 8 /* PROPS */, _hoisted_246))
                                  : _createCommentVNode("v-if", true),
                                (_ctx.fieldHasMap(f) && _ctx.modal.rec.data[f.key])
                                  ? (_openBlock(), _createElementBlock("button", {
                                      key: 4,
                                      type: "button",
                                      class: "icon-btn",
                                      title: _ctx.t('Open in map'),
                                      onClick: $event => (_ctx.openMap(_ctx.modal.rec.data[f.key]))
                                    }, "🌐", 8 /* PROPS */, _hoisted_247))
                                  : _createCommentVNode("v-if", true),
                                (!(f.secret && _ctx.secretsMasked))
                                  ? (_openBlock(), _createElementBlock("button", {
                                      key: 5,
                                      class: "icon-btn",
                                      onClick: $event => (_ctx.copyVal(f.secret ? _ctx.openDecrypted[f.key] : _ctx.modal.rec.data[f.key])),
                                      title: _ctx.t('Copy')
                                    }, "⧉", 8 /* PROPS */, _hoisted_248))
                                  : _createCommentVNode("v-if", true)
                              ]))
                      ])), [
                        [_vShow, _ctx.modal.rec.data[f.key] != null && _ctx.modal.rec.data[f.key] !== '']
                      ])
                    }), 128 /* KEYED_FRAGMENT */))
                  ]),
                  _createElementVNode("div", _hoisted_249, [
                    (_ctx.canDelete)
                      ? (_openBlock(), _createElementBlock("button", {
                          key: 0,
                          class: "btn danger",
                          onClick: _cache[65] || (_cache[65] = $event => (_ctx.deleteRecord(_ctx.modal.rec)))
                        }, _toDisplayString(_ctx.t('Delete')), 1 /* TEXT */))
                      : _createCommentVNode("v-if", true),
                    _createElementVNode("button", {
                      class: "btn",
                      onClick: _cache[66] || (_cache[66] = $event => (_ctx.copyRecord(_ctx.modal.rec)))
                    }, _toDisplayString(_ctx.t('⧉ Copy all')), 1 /* TEXT */),
                    (_ctx.isOwner && !_ctx.isLocked)
                      ? (_openBlock(), _createElementBlock("button", {
                          key: 1,
                          class: "btn",
                          onClick: _cache[67] || (_cache[67] = $event => (_ctx.openTransfer(_ctx.modal.rec)))
                        }, _toDisplayString(_ctx.t('↔ Move / Copy')), 1 /* TEXT */))
                      : _createCommentVNode("v-if", true),
                    (_ctx.canEdit)
                      ? (_openBlock(), _createElementBlock("button", {
                          key: 2,
                          class: "btn primary",
                          onClick: _cache[68] || (_cache[68] = $event => (_ctx.editRecord(_ctx.modal.rec)))
                        }, _toDisplayString(_ctx.t('Edit')), 1 /* TEXT */))
                      : _createCommentVNode("v-if", true)
                  ])
                ])
              ]))
            : _createCommentVNode("v-if", true),
          _createCommentVNode(" Schema editor "),
          (_ctx.modal && _ctx.modal.type==='schema')
            ? (_openBlock(), _createElementBlock("div", {
                key: 3,
                class: "modal-mask",
                onClick: _cache[82] || (_cache[82] = _withModifiers($event => (_ctx.modal=null), ["self"]))
              }, [
                _createElementVNode("div", _hoisted_250, [
                  _createElementVNode("div", _hoisted_251, [
                    _createElementVNode("h3", null, _toDisplayString(_ctx.schemaMode==='template' ? (_ctx.tplEdit.row_id || _ctx.tplEdit.builtin_key ? _ctx.t('✏️ Edit template') : _ctx.t('⭐ New template')) : _ctx.t('🧩 Edit collection')), 1 /* TEXT */),
                    _createElementVNode("button", {
                      class: "icon-btn",
                      onClick: _cache[70] || (_cache[70] = (...args) => (_ctx.closeSchemaEditor && _ctx.closeSchemaEditor(...args)))
                    }, "✕")
                  ]),
                  _createElementVNode("div", {
                    class: "modal-body",
                    ref: "schemaBody",
                    onDragover: _cache[78] || (_cache[78] = $event => (_ctx.onSchemaAutoScroll($event)))
                  }, [
                    (_ctx.schemaMode==='template')
                      ? (_openBlock(), _createElementBlock("div", _hoisted_252, [
                          _createElementVNode("div", _hoisted_253, [
                            _createElementVNode("div", _hoisted_254, [
                              _createElementVNode("label", null, "🏷️ " + _toDisplayString(_ctx.t('Template name')), 1 /* TEXT */),
                              _withDirectives(_createElementVNode("input", {
                                "onUpdate:modelValue": _cache[71] || (_cache[71] = $event => ((_ctx.tplEdit.name) = $event))
                              }, null, 512 /* NEED_PATCH */), [
                                [_vModelText, _ctx.tplEdit.name]
                              ])
                            ]),
                            _createElementVNode("div", _hoisted_255, [
                              _createElementVNode("label", null, "🎨 " + _toDisplayString(_ctx.t('Color')), 1 /* TEXT */),
                              _withDirectives(_createElementVNode("input", {
                                type: "color",
                                "onUpdate:modelValue": _cache[72] || (_cache[72] = $event => ((_ctx.tplEdit.color) = $event)),
                                style: {"height":"44px","padding":"4px","width":"100%"}
                              }, null, 512 /* NEED_PATCH */), [
                                [_vModelText, _ctx.tplEdit.color]
                              ])
                            ])
                          ]),
                          _createElementVNode("div", _hoisted_256, [
                            _createElementVNode("div", _hoisted_257, [
                              _createElementVNode("label", null, "😀 " + _toDisplayString(_ctx.t('Icon')), 1 /* TEXT */),
                              _createElementVNode("div", _hoisted_258, [
                                _createElementVNode("button", {
                                  type: "button",
                                  class: _normalizeClass(["iconpick-cur", {open: _ctx.iconPickerOpen && _ctx.iconTarget==='tplEdit'}]),
                                  onClick: _cache[73] || (_cache[73] = _withModifiers($event => (_ctx.openIconPicker('tplEdit')), ["stop"])),
                                  title: _ctx.t('Click to choose an icon')
                                }, _toDisplayString(_ctx.tplEdit.icon || '🗂️'), 11 /* TEXT, CLASS, PROPS */, _hoisted_259),
                                _withDirectives(_createElementVNode("input", {
                                  "onUpdate:modelValue": _cache[74] || (_cache[74] = $event => ((_ctx.tplEdit.icon) = $event)),
                                  maxlength: "16",
                                  placeholder: _ctx.t('Emoji')
                                }, null, 8 /* PROPS */, _hoisted_260), [
                                  [_vModelText, _ctx.tplEdit.icon]
                                ])
                              ])
                            ]),
                            _createElementVNode("div", _hoisted_261, [
                              _createElementVNode("label", null, "📝 " + _toDisplayString(_ctx.t('Description')), 1 /* TEXT */),
                              _withDirectives(_createElementVNode("input", {
                                "onUpdate:modelValue": _cache[75] || (_cache[75] = $event => ((_ctx.tplEdit.description) = $event))
                              }, null, 512 /* NEED_PATCH */), [
                                [_vModelText, _ctx.tplEdit.description]
                              ])
                            ])
                          ])
                        ]))
                      : _createCommentVNode("v-if", true),
                    (_ctx.schemaMode!=='template')
                      ? (_openBlock(), _createElementBlock("p", _hoisted_262, _toDisplayString(_ctx.t('※ Here you edit this collection\'s input form — the fields records are entered into. It does not change the records already saved.')), 1 /* TEXT */))
                      : _createCommentVNode("v-if", true),
                    _createElementVNode("p", _hoisted_263, _toDisplayString(_ctx.t('The fields you create here become the input form. 🏷️ Emphasis marks the field(s) used as the record\'s name — shown as the record title in lists, cards and details, and used for name sorting. Tick more than one to combine them (e.g. first name + last name), joined in field order; the emphasized values are shown in bold.')), 1 /* TEXT */),
                    (_ctx.schemaMode!=='template')
                      ? (_openBlock(), _createElementBlock("div", _hoisted_264, [
                          _createElementVNode("div", _hoisted_265, "🔗 " + _toDisplayString(_ctx.t('Concatenate with: on a field, pick the next field to show combined with it, and the character to put between them — chain them (A→B→C) for a 3-way combine (e.g. Last name → First name → “Yamada Taro”). This only changes how records are shown in lists/table; the stored data is not merged.')), 1 /* TEXT */)
                        ]))
                      : _createCommentVNode("v-if", true),
                    (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.schemaFields, (f, i) => {
                      return (_openBlock(), _createElementBlock("div", {
                        key: f._uid,
                        class: _normalizeClass(["schema-row sortable", {dragover: _ctx.dragOverIndex===i, dragging: _ctx.dragIndex===i}]),
                        onDragover: _withModifiers($event => (_ctx.onFieldDragOver(i)), ["prevent"]),
                        onDrop: _withModifiers($event => (_ctx.onFieldDrop(i)), ["prevent"]),
                        onDragleave: $event => (_ctx.onFieldDragLeave(i))
                      }, [
                        _createElementVNode("span", {
                          class: "drag-handle",
                          draggable: "true",
                          onDragstart: $event => (_ctx.onFieldDragStart(i, $event)),
                          onDragend: _cache[76] || (_cache[76] = (...args) => (_ctx.onFieldDragEnd && _ctx.onFieldDragEnd(...args))),
                          title: _ctx.t('Drag to reorder')
                        }, "⠿", 40 /* PROPS, NEED_HYDRATION */, _hoisted_267),
                        _withDirectives(_createElementVNode("input", {
                          "onUpdate:modelValue": $event => ((f.label) = $event),
                          class: _normalizeClass({'field-required-empty': !(f.label||'').trim()}),
                          placeholder: _ctx.t('Display name (required)')
                        }, null, 10 /* CLASS, PROPS */, _hoisted_268), [
                          [_vModelText, f.label]
                        ]),
                        _withDirectives(_createElementVNode("select", {
                          "onUpdate:modelValue": $event => ((f.type) = $event)
                        }, [
                          _createElementVNode("option", _hoisted_270, _toDisplayString(_ctx.t('Text')), 1 /* TEXT */),
                          _createElementVNode("option", _hoisted_271, _toDisplayString(_ctx.t('Multi-line text')), 1 /* TEXT */),
                          _createElementVNode("option", _hoisted_272, _toDisplayString(_ctx.t('Password')), 1 /* TEXT */),
                          _createElementVNode("option", _hoisted_273, _toDisplayString(_ctx.t('Numeric')), 1 /* TEXT */),
                          _createElementVNode("option", _hoisted_274, _toDisplayString(_ctx.t('Date')), 1 /* TEXT */),
                          _createElementVNode("option", _hoisted_275, _toDisplayString(_ctx.t('Year/Month')), 1 /* TEXT */),
                          _createElementVNode("option", _hoisted_276, _toDisplayString(_ctx.t('Email')), 1 /* TEXT */),
                          _hoisted_277,
                          _createElementVNode("option", _hoisted_278, _toDisplayString(_ctx.t('Phone number')), 1 /* TEXT */),
                          _createElementVNode("option", _hoisted_279, _toDisplayString(_ctx.t('Address (map link)')), 1 /* TEXT */),
                          _createElementVNode("option", _hoisted_280, _toDisplayString(_ctx.t('Choices (dropdown)')), 1 /* TEXT */),
                          _createElementVNode("option", _hoisted_281, _toDisplayString(_ctx.t('Choices (radio, single)')), 1 /* TEXT */),
                          _createElementVNode("option", _hoisted_282, _toDisplayString(_ctx.t('Choices (checkboxes, multiple)')), 1 /* TEXT */),
                          _createElementVNode("option", _hoisted_283, _toDisplayString(_ctx.t('Image (as-is / resize)')), 1 /* TEXT */),
                          _createElementVNode("option", _hoisted_284, _toDisplayString(_ctx.t('Image (crop)')), 1 /* TEXT */),
                          _createElementVNode("option", _hoisted_285, _toDisplayString(_ctx.t('File attachment (PDF/Word/Excel/ODF, notes)')), 1 /* TEXT */)
                        ], 8 /* PROPS */, _hoisted_269), [
                          [_vModelSelect, f.type]
                        ]),
                        _createElementVNode("div", _hoisted_286, [
                          _createElementVNode("button", {
                            class: "icon-btn",
                            onClick: $event => (_ctx.removeSchemaField(i)),
                            title: _ctx.t('Delete')
                          }, "🗑", 8 /* PROPS */, _hoisted_287)
                        ]),
                        (f.type==='select'||f.type==='radio'||f.type==='checkbox')
                          ? _withDirectives((_openBlock(), _createElementBlock("textarea", {
                              key: 0,
                              "onUpdate:modelValue": $event => ((f.options) = $event),
                              placeholder: _ctx.t('Enter choices, one per line'),
                              style: {"grid-column":"1/-1","min-height":"56px"}
                            }, null, 8 /* PROPS */, _hoisted_288)), [
                              [_vModelText, f.options]
                            ])
                          : _createCommentVNode("v-if", true),
                        (f.type==='image')
                          ? (_openBlock(), _createElementBlock("div", _hoisted_289, [
                              _createElementVNode("label", _hoisted_290, [
                                _withDirectives(_createElementVNode("input", {
                                  type: "checkbox",
                                  "onUpdate:modelValue": $event => ((f._orig) = $event)
                                }, null, 8 /* PROPS */, _hoisted_291), [
                                  [_vModelCheckbox, f._orig]
                                ]),
                                _createTextVNode(" " + _toDisplayString(_ctx.t('Save at original size (no processing)')), 1 /* TEXT */)
                              ]),
                              (!f._orig)
                                ? (_openBlock(), _createElementBlock("label", _hoisted_292, [
                                    _createTextVNode(_toDisplayString(_ctx.t('Max size')) + " ", 1 /* TEXT */),
                                    _withDirectives(_createElementVNode("input", {
                                      type: "number",
                                      min: "200",
                                      max: "6000",
                                      step: "100",
                                      "onUpdate:modelValue": $event => ((f._max) = $event)
                                    }, null, 8 /* PROPS */, _hoisted_293), [
                                      [
                                        _vModelText,
                                        f._max,
                                        void 0,
                                        { number: true }
                                      ]
                                    ]),
                                    _createTextVNode(" px")
                                  ]))
                                : _createCommentVNode("v-if", true),
                              (!f._orig)
                                ? (_openBlock(), _createElementBlock("label", _hoisted_294, [
                                    _createTextVNode(_toDisplayString(_ctx.t('Save format')) + " ", 1 /* TEXT */),
                                    _withDirectives(_createElementVNode("select", {
                                      "onUpdate:modelValue": $event => ((f._format) = $event)
                                    }, [
                                      _createElementVNode("option", _hoisted_296, _toDisplayString(_ctx.t('JPEG (lightweight)')), 1 /* TEXT */),
                                      _createElementVNode("option", _hoisted_297, _toDisplayString(_ctx.t('PNG (high quality, transparency)')), 1 /* TEXT */),
                                      _createElementVNode("option", _hoisted_298, _toDisplayString(_ctx.t('WebP (high compression)')), 1 /* TEXT */)
                                    ], 8 /* PROPS */, _hoisted_295), [
                                      [_vModelSelect, f._format]
                                    ])
                                  ]))
                                : _createCommentVNode("v-if", true)
                            ]))
                          : (f.type==='image_crop')
                            ? (_openBlock(), _createElementBlock("div", _hoisted_299, [
                                _createElementVNode("label", _hoisted_300, [
                                  _createTextVNode(_toDisplayString(_ctx.t('Ratio')) + " ", 1 /* TEXT */),
                                  _withDirectives(_createElementVNode("select", {
                                    "onUpdate:modelValue": $event => ((f._ratio) = $event)
                                  }, [
                                    _createElementVNode("option", _hoisted_302, _toDisplayString(_ctx.t('1:1 (square, portrait)')), 1 /* TEXT */),
                                    _createElementVNode("option", _hoisted_303, _toDisplayString(_ctx.t('3:4 (portrait)')), 1 /* TEXT */),
                                    _createElementVNode("option", _hoisted_304, _toDisplayString(_ctx.t('4:3 (landscape)')), 1 /* TEXT */),
                                    _createElementVNode("option", _hoisted_305, _toDisplayString(_ctx.t('16:9 (wide)')), 1 /* TEXT */),
                                    _createElementVNode("option", _hoisted_306, _toDisplayString(_ctx.t('Free')), 1 /* TEXT */)
                                  ], 8 /* PROPS */, _hoisted_301), [
                                    [_vModelSelect, f._ratio]
                                  ])
                                ]),
                                _createElementVNode("label", _hoisted_307, [
                                  _createTextVNode(_toDisplayString(_ctx.t('Output width')) + " ", 1 /* TEXT */),
                                  _withDirectives(_createElementVNode("input", {
                                    type: "number",
                                    min: "100",
                                    max: "4000",
                                    step: "50",
                                    "onUpdate:modelValue": $event => ((f._out) = $event)
                                  }, null, 8 /* PROPS */, _hoisted_308), [
                                    [
                                      _vModelText,
                                      f._out,
                                      void 0,
                                      { number: true }
                                    ]
                                  ]),
                                  _createTextVNode(" px")
                                ]),
                                _createElementVNode("label", _hoisted_309, [
                                  _createTextVNode(_toDisplayString(_ctx.t('Save format')) + " ", 1 /* TEXT */),
                                  _withDirectives(_createElementVNode("select", {
                                    "onUpdate:modelValue": $event => ((f._format) = $event)
                                  }, [
                                    _createElementVNode("option", _hoisted_311, _toDisplayString(_ctx.t('JPEG (lightweight)')), 1 /* TEXT */),
                                    _createElementVNode("option", _hoisted_312, _toDisplayString(_ctx.t('PNG (high quality, transparency)')), 1 /* TEXT */),
                                    _createElementVNode("option", _hoisted_313, _toDisplayString(_ctx.t('WebP (high compression)')), 1 /* TEXT */)
                                  ], 8 /* PROPS */, _hoisted_310), [
                                    [_vModelSelect, f._format]
                                  ])
                                ])
                              ]))
                            : _createCommentVNode("v-if", true),
                        (_ctx.ruleTypes.includes(f.type))
                          ? (_openBlock(), _createElementBlock("div", _hoisted_314, [
                              _createElementVNode("label", _hoisted_315, [
                                _createTextVNode(_toDisplayString(_ctx.t('Character type')) + " ", 1 /* TEXT */),
                                _withDirectives(_createElementVNode("select", {
                                  "onUpdate:modelValue": $event => ((f._charset) = $event)
                                }, [
                                  _createElementVNode("option", _hoisted_317, _toDisplayString(_ctx.t('No restriction')), 1 /* TEXT */),
                                  _createElementVNode("option", _hoisted_318, _toDisplayString(_ctx.t('Digits only (0-9)')), 1 /* TEXT */),
                                  _createElementVNode("option", _hoisted_319, _toDisplayString(_ctx.t('Alphanumeric')), 1 /* TEXT */),
                                  _createElementVNode("option", _hoisted_320, _toDisplayString(_ctx.t('Letters')), 1 /* TEXT */),
                                  _createElementVNode("option", _hoisted_321, _toDisplayString(_ctx.t('Hexadecimal')), 1 /* TEXT */),
                                  _createElementVNode("option", _hoisted_322, _toDisplayString(_ctx.t('ASCII (incl. symbols)')), 1 /* TEXT */),
                                  _createElementVNode("option", _hoisted_323, _toDisplayString(_ctx.t('Phone number (digits, +-() )')), 1 /* TEXT */),
                                  _createElementVNode("option", _hoisted_324, _toDisplayString(_ctx.t('Custom (regex)')), 1 /* TEXT */)
                                ], 8 /* PROPS */, _hoisted_316), [
                                  [_vModelSelect, f._charset]
                                ])
                              ]),
                              (f._charset==='custom')
                                ? (_openBlock(), _createElementBlock("label", _hoisted_325, [
                                    _createTextVNode(_toDisplayString(_ctx.t('Pattern')) + " ", 1 /* TEXT */),
                                    _withDirectives(_createElementVNode("input", {
                                      "onUpdate:modelValue": $event => ((f._pattern) = $event),
                                      placeholder: _ctx.t('e.g. [0-9]{3}-[0-9]{4}'),
                                      style: {"min-width":"150px"}
                                    }, null, 8 /* PROPS */, _hoisted_326), [
                                      [_vModelText, f._pattern]
                                    ])
                                  ]))
                                : _createCommentVNode("v-if", true),
                              _createElementVNode("label", _hoisted_327, [
                                _createTextVNode(_toDisplayString(_ctx.t('Min')) + " ", 1 /* TEXT */),
                                _withDirectives(_createElementVNode("input", {
                                  type: "number",
                                  min: "0",
                                  max: "9999",
                                  "onUpdate:modelValue": $event => ((f._rmin) = $event),
                                  style: {"width":"66px"}
                                }, null, 8 /* PROPS */, _hoisted_328), [
                                  [
                                    _vModelText,
                                    f._rmin,
                                    void 0,
                                    { number: true }
                                  ]
                                ]),
                                _createTextVNode(" " + _toDisplayString(_ctx.t('chars')), 1 /* TEXT */)
                              ]),
                              _createElementVNode("label", _hoisted_329, [
                                _createTextVNode(_toDisplayString(_ctx.t('Max')) + " ", 1 /* TEXT */),
                                _withDirectives(_createElementVNode("input", {
                                  type: "number",
                                  min: "0",
                                  max: "99999",
                                  "onUpdate:modelValue": $event => ((f._rmax) = $event),
                                  style: {"width":"74px"}
                                }, null, 8 /* PROPS */, _hoisted_330), [
                                  [
                                    _vModelText,
                                    f._rmax,
                                    void 0,
                                    { number: true }
                                  ]
                                ]),
                                _createTextVNode(" " + _toDisplayString(_ctx.t('chars')), 1 /* TEXT */)
                              ])
                            ]))
                          : _createCommentVNode("v-if", true),
                        _createElementVNode("div", _hoisted_331, [
                          _createElementVNode("label", null, [
                            _createElementVNode("input", {
                              type: "checkbox",
                              checked: f.is_title,
                              onChange: $event => (_ctx.setTitleField(i))
                            }, null, 40 /* PROPS, NEED_HYDRATION */, _hoisted_332),
                            _createTextVNode(" " + _toDisplayString(_ctx.t('🏷️ Emphasis')), 1 /* TEXT */)
                          ]),
                          _createElementVNode("label", null, [
                            _withDirectives(_createElementVNode("input", {
                              type: "checkbox",
                              "onUpdate:modelValue": $event => ((f.required) = $event)
                            }, null, 8 /* PROPS */, _hoisted_333), [
                              [_vModelCheckbox, f.required]
                            ]),
                            _createTextVNode(" " + _toDisplayString(_ctx.t('Required')), 1 /* TEXT */)
                          ]),
                          _createElementVNode("label", null, [
                            _withDirectives(_createElementVNode("input", {
                              type: "checkbox",
                              "onUpdate:modelValue": $event => ((f.secret) = $event)
                            }, null, 8 /* PROPS */, _hoisted_334), [
                              [_vModelCheckbox, f.secret]
                            ]),
                            _createTextVNode(" " + _toDisplayString(_ctx.t('Secret (masked)')), 1 /* TEXT */)
                          ]),
                          (!f.is_title && !f.secret && f.type!=='image' && f.type!=='image_crop' && f.type!=='file' && !_ctx.concatSourceLabel(f))
                            ? (_openBlock(), _createElementBlock("span", _hoisted_335, [
                                _createTextVNode(_toDisplayString(_ctx.t('Show in')) + ": ", 1 /* TEXT */),
                                _createElementVNode("label", null, [
                                  _withDirectives(_createElementVNode("input", {
                                    type: "checkbox",
                                    "onUpdate:modelValue": $event => ((f.list_show) = $event)
                                  }, null, 8 /* PROPS */, _hoisted_336), [
                                    [_vModelCheckbox, f.list_show]
                                  ]),
                                  _createTextVNode(" " + _toDisplayString(_ctx.t('List')), 1 /* TEXT */)
                                ]),
                                _createElementVNode("label", null, [
                                  _withDirectives(_createElementVNode("input", {
                                    type: "checkbox",
                                    "onUpdate:modelValue": $event => ((f.table_show) = $event)
                                  }, null, 8 /* PROPS */, _hoisted_337), [
                                    [_vModelCheckbox, f.table_show]
                                  ]),
                                  _createTextVNode(" " + _toDisplayString(_ctx.t('Table')), 1 /* TEXT */)
                                ]),
                                _createElementVNode("label", null, [
                                  _withDirectives(_createElementVNode("input", {
                                    type: "checkbox",
                                    "onUpdate:modelValue": $event => ((f.card_show) = $event)
                                  }, null, 8 /* PROPS */, _hoisted_338), [
                                    [_vModelCheckbox, f.card_show]
                                  ]),
                                  _createTextVNode(" " + _toDisplayString(_ctx.t('Cards')), 1 /* TEXT */)
                                ])
                              ]))
                            : _createCommentVNode("v-if", true),
                          (_ctx.concatSourceLabel(f))
                            ? (_openBlock(), _createElementBlock("span", _hoisted_339, "🔗 " + _toDisplayString(_ctx.t('Concatenated from')) + ": " + _toDisplayString(_ctx.concatSourceLabel(f)), 1 /* TEXT */))
                            : _createCommentVNode("v-if", true),
                          _createElementVNode("label", null, [
                            _createTextVNode("🔗 " + _toDisplayString(_ctx.t('Concatenate with')) + " ", 1 /* TEXT */),
                            _createElementVNode("select", {
                              value: f._cnext||0,
                              onChange: $event => (f._cnext = Number($event.target.value))
                            }, [
                              _createElementVNode("option", _hoisted_341, _toDisplayString(_ctx.t('Do not concatenate')), 1 /* TEXT */),
                              (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.concatTargets(f), (g) => {
                                return (_openBlock(), _createElementBlock("option", {
                                  key: g._uid,
                                  value: g._uid
                                }, _toDisplayString(g.label), 9 /* TEXT, PROPS */, _hoisted_342))
                              }), 128 /* KEYED_FRAGMENT */))
                            ], 40 /* PROPS, NEED_HYDRATION */, _hoisted_340)
                          ]),
                          (f._cnext)
                            ? (_openBlock(), _createElementBlock("label", _hoisted_343, [
                                _createTextVNode(_toDisplayString(_ctx.t('Separator')) + " ", 1 /* TEXT */),
                                _withDirectives(_createElementVNode("select", {
                                  "onUpdate:modelValue": $event => ((f._csep) = $event)
                                }, [
                                  _createElementVNode("option", _hoisted_345, _toDisplayString(_ctx.t('None')), 1 /* TEXT */),
                                  _createElementVNode("option", _hoisted_346, _toDisplayString(_ctx.t('Half-width space')), 1 /* TEXT */),
                                  (_ctx.isCjkUi || f._csep==='fullspace')
                                    ? (_openBlock(), _createElementBlock("option", _hoisted_347, _toDisplayString(_ctx.t('Full-width space')), 1 /* TEXT */))
                                    : _createCommentVNode("v-if", true),
                                  _createElementVNode("option", _hoisted_348, _toDisplayString(_ctx.t('Custom symbol')), 1 /* TEXT */),
                                  _createElementVNode("option", _hoisted_349, _toDisplayString(_ctx.t('Half-width parentheses ( )')), 1 /* TEXT */),
                                  (_ctx.isCjkUi || f._csep==='parenfull')
                                    ? (_openBlock(), _createElementBlock("option", _hoisted_350, _toDisplayString(_ctx.t('Full-width parentheses （ ）')), 1 /* TEXT */))
                                    : _createCommentVNode("v-if", true)
                                ], 8 /* PROPS */, _hoisted_344), [
                                  [_vModelSelect, f._csep]
                                ]),
                                (f._csep==='custom')
                                  ? _withDirectives((_openBlock(), _createElementBlock("input", {
                                      key: 0,
                                      "onUpdate:modelValue": $event => ((f._csepChar) = $event),
                                      maxlength: "4",
                                      placeholder: _ctx.t('e.g. / , -'),
                                      style: {"width":"70px","margin-left":"4px"}
                                    }, null, 8 /* PROPS */, _hoisted_351)), [
                                      [_vModelText, f._csepChar]
                                    ])
                                  : _createCommentVNode("v-if", true)
                              ]))
                            : _createCommentVNode("v-if", true),
                          (_ctx.schemaMode !== 'template')
                            ? (_openBlock(), _createElementBlock("span", {
                                key: 3,
                                class: "field-fill",
                                title: _ctx.t('Records with data / total records')
                              }, _toDisplayString(_ctx.fieldFill(f)), 9 /* TEXT, PROPS */, _hoisted_352))
                            : _createCommentVNode("v-if", true)
                        ])
                      ], 42 /* CLASS, PROPS, NEED_HYDRATION */, _hoisted_266))
                    }), 128 /* KEYED_FRAGMENT */)),
                    _createElementVNode("button", {
                      class: "btn block",
                      onClick: _cache[77] || (_cache[77] = (...args) => (_ctx.addSchemaField && _ctx.addSchemaField(...args)))
                    }, _toDisplayString(_ctx.t('＋ Add field')), 1 /* TEXT */)
                  ], 544 /* NEED_HYDRATION, NEED_PATCH */),
                  _createElementVNode("div", _hoisted_353, [
                    _createElementVNode("button", {
                      class: "btn",
                      onClick: _cache[79] || (_cache[79] = (...args) => (_ctx.closeSchemaEditor && _ctx.closeSchemaEditor(...args)))
                    }, _toDisplayString(_ctx.t('Cancel')), 1 /* TEXT */),
                    (_ctx.schemaMode==='template')
                      ? (_openBlock(), _createElementBlock("button", {
                          key: 0,
                          class: "btn primary",
                          onClick: _cache[80] || (_cache[80] = (...args) => (_ctx.saveTemplate && _ctx.saveTemplate(...args)))
                        }, _toDisplayString(_ctx.t('Save template')), 1 /* TEXT */))
                      : (_openBlock(), _createElementBlock("button", {
                          key: 1,
                          class: "btn primary",
                          onClick: _cache[81] || (_cache[81] = (...args) => (_ctx.saveSchema && _ctx.saveSchema(...args)))
                        }, _toDisplayString(_ctx.t('Save fields')), 1 /* TEXT */))
                  ])
                ])
              ]))
            : _createCommentVNode("v-if", true),
          _createCommentVNode(" Duplicate collection "),
          (_ctx.modal && _ctx.modal.type==='duplicate')
            ? (_openBlock(), _createElementBlock("div", {
                key: 4,
                class: "modal-mask",
                onClick: _cache[88] || (_cache[88] = _withModifiers($event => (_ctx.modal=null), ["self"]))
              }, [
                _createElementVNode("div", _hoisted_354, [
                  _createElementVNode("div", _hoisted_355, [
                    _createElementVNode("h3", null, _toDisplayString(_ctx.t('📄 Duplicate collection')), 1 /* TEXT */),
                    _createElementVNode("button", {
                      class: "icon-btn",
                      onClick: _cache[83] || (_cache[83] = $event => (_ctx.modal=null))
                    }, "✕")
                  ]),
                  _createElementVNode("div", _hoisted_356, [
                    _createElementVNode("div", _hoisted_357, [
                      _createElementVNode("label", null, "🏷️ " + _toDisplayString(_ctx.t('New name')), 1 /* TEXT */),
                      _withDirectives(_createElementVNode("input", {
                        "onUpdate:modelValue": _cache[84] || (_cache[84] = $event => ((_ctx.dupForm.name) = $event))
                      }, null, 512 /* NEED_PATCH */), [
                        [_vModelText, _ctx.dupForm.name]
                      ])
                    ]),
                    _createElementVNode("label", _hoisted_358, [
                      _withDirectives(_createElementVNode("input", {
                        type: "checkbox",
                        "onUpdate:modelValue": _cache[85] || (_cache[85] = $event => ((_ctx.dupForm.withRecords) = $event))
                      }, null, 512 /* NEED_PATCH */), [
                        [_vModelCheckbox, _ctx.dupForm.withRecords]
                      ]),
                      _createTextVNode(" " + _toDisplayString(_ctx.t('Also duplicate the records (data)')), 1 /* TEXT */)
                    ]),
                    _createElementVNode("div", _hoisted_359, _toDisplayString(_ctx.t('Unchecked: an empty copy with the same fields. Checked: also copies every record and its attachments.')), 1 /* TEXT */)
                  ]),
                  _createElementVNode("div", _hoisted_360, [
                    _createElementVNode("button", {
                      type: "button",
                      class: "btn",
                      onClick: _cache[86] || (_cache[86] = $event => (_ctx.modal=null))
                    }, _toDisplayString(_ctx.t('Cancel')), 1 /* TEXT */),
                    _createElementVNode("button", {
                      type: "button",
                      class: "btn primary",
                      disabled: _ctx.dupForm.busy || !_ctx.dupForm.name.trim(),
                      onClick: _cache[87] || (_cache[87] = (...args) => (_ctx.commitDuplicate && _ctx.commitDuplicate(...args)))
                    }, _toDisplayString(_ctx.t('Duplicate')), 9 /* TEXT, PROPS */, _hoisted_361)
                  ])
                ])
              ]))
            : _createCommentVNode("v-if", true),
          _createCommentVNode(" Reorder records (registration order) "),
          (_ctx.modal && _ctx.modal.type==='reorder')
            ? (_openBlock(), _createElementBlock("div", {
                key: 5,
                class: "modal-mask",
                onClick: _cache[95] || (_cache[95] = _withModifiers($event => (_ctx.modal=null), ["self"]))
              }, [
                _createElementVNode("div", _hoisted_362, [
                  _createElementVNode("div", _hoisted_363, [
                    _createElementVNode("h3", null, _toDisplayString(_ctx.t('⇅ Edit the saved record order')), 1 /* TEXT */),
                    _createElementVNode("button", {
                      class: "icon-btn",
                      onClick: _cache[89] || (_cache[89] = $event => (_ctx.modal=null))
                    }, "✕")
                  ]),
                  _createElementVNode("div", _hoisted_364, [
                    _createElementVNode("p", _hoisted_365, _toDisplayString(_ctx.t('This rewrites the records’ saved registration order (not just the on-screen view). Sort by up to 5 fields, and/or drag rows by hand. The result is what you’ll see in “Registration order”.')), 1 /* TEXT */),
                    (_ctx.reorderFields.length)
                      ? (_openBlock(), _createElementBlock("div", _hoisted_366, [
                          _createElementVNode("div", _hoisted_367, _toDisplayString(_ctx.t('Sort by fields (top = highest priority)')), 1 /* TEXT */),
                          (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.reorder.keys, (k, ki) => {
                            return (_openBlock(), _createElementBlock("div", {
                              key: ki,
                              class: "reorder-keyrow"
                            }, [
                              _createElementVNode("span", _hoisted_368, _toDisplayString(ki + 1), 1 /* TEXT */),
                              _withDirectives(_createElementVNode("select", {
                                "onUpdate:modelValue": $event => ((k.field) = $event),
                                class: "reorder-keysel"
                              }, [
                                _createElementVNode("option", _hoisted_370, _toDisplayString(_ctx.t('— none —')), 1 /* TEXT */),
                                (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.reorderFields, (f) => {
                                  return (_openBlock(), _createElementBlock("option", {
                                    key: f.key,
                                    value: f.key
                                  }, _toDisplayString(f.label), 9 /* TEXT, PROPS */, _hoisted_371))
                                }), 128 /* KEYED_FRAGMENT */))
                              ], 8 /* PROPS */, _hoisted_369), [
                                [_vModelSelect, k.field]
                              ]),
                              _withDirectives(_createElementVNode("select", {
                                "onUpdate:modelValue": $event => ((k.dir) = $event),
                                class: "reorder-keydir"
                              }, [
                                _createElementVNode("option", _hoisted_373, _toDisplayString(_ctx.t('Ascending')), 1 /* TEXT */),
                                _createElementVNode("option", _hoisted_374, _toDisplayString(_ctx.t('Descending')), 1 /* TEXT */)
                              ], 8 /* PROPS */, _hoisted_372), [
                                [_vModelSelect, k.dir]
                              ]),
                              (_ctx.reorder.keys.length>1)
                                ? (_openBlock(), _createElementBlock("button", {
                                    key: 0,
                                    type: "button",
                                    class: "icon-btn",
                                    onClick: $event => (_ctx.removeReorderKey(ki)),
                                    title: _ctx.t('Remove')
                                  }, "✕", 8 /* PROPS */, _hoisted_375))
                                : _createCommentVNode("v-if", true)
                            ]))
                          }), 128 /* KEYED_FRAGMENT */)),
                          _createElementVNode("div", _hoisted_376, [
                            (_ctx.reorder.keys.length<5)
                              ? (_openBlock(), _createElementBlock("button", {
                                  key: 0,
                                  type: "button",
                                  class: "btn sm ghost",
                                  onClick: _cache[90] || (_cache[90] = (...args) => (_ctx.addReorderKey && _ctx.addReorderKey(...args)))
                                }, "＋ " + _toDisplayString(_ctx.t('Add a sort key')), 1 /* TEXT */))
                              : _createCommentVNode("v-if", true),
                            _createElementVNode("button", {
                              type: "button",
                              class: "btn sm",
                              disabled: !_ctx.reorder.keys.some(k=>k.field),
                              onClick: _cache[91] || (_cache[91] = (...args) => (_ctx.applyReorderSort && _ctx.applyReorderSort(...args)))
                            }, "↕ " + _toDisplayString(_ctx.t('Sort now')), 9 /* TEXT, PROPS */, _hoisted_377)
                          ])
                        ]))
                      : _createCommentVNode("v-if", true),
                    _createElementVNode("div", _hoisted_378, _toDisplayString(_ctx.t('Order preview ({n} records) — drag to fine-tune', {n: _ctx.reorder.list.length})), 1 /* TEXT */),
                    _createElementVNode("div", _hoisted_379, [
                      (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.reorder.list, (r, i) => {
                        return (_openBlock(), _createElementBlock("div", {
                          key: r.id,
                          class: _normalizeClass(["reorder-row", {dragover: _ctx.reorder.over===i, dragging: _ctx.reorder.from===i}]),
                          onDragover: _withModifiers($event => (_ctx.rDragOver(i)), ["prevent"]),
                          onDrop: _withModifiers($event => (_ctx.rDrop(i)), ["prevent"]),
                          onDragleave: $event => (_ctx.rDragLeave(i))
                        }, [
                          _createElementVNode("span", {
                            class: "drag-handle",
                            draggable: "true",
                            onDragstart: $event => (_ctx.rDragStart(i, $event)),
                            onDragend: _cache[92] || (_cache[92] = (...args) => (_ctx.rDragEnd && _ctx.rDragEnd(...args))),
                            title: _ctx.t('Drag to reorder')
                          }, "⠿", 40 /* PROPS, NEED_HYDRATION */, _hoisted_381),
                          _createElementVNode("span", _hoisted_382, _toDisplayString(i + 1), 1 /* TEXT */),
                          _createElementVNode("span", _hoisted_383, [
                            _createElementVNode("span", _hoisted_384, _toDisplayString(_ctx.reorderTitle(r)), 1 /* TEXT */),
                            (_ctx.reorderRowSummary(r))
                              ? (_openBlock(), _createElementBlock("span", _hoisted_385, _toDisplayString(_ctx.reorderRowSummary(r)), 1 /* TEXT */))
                              : _createCommentVNode("v-if", true)
                          ])
                        ], 42 /* CLASS, PROPS, NEED_HYDRATION */, _hoisted_380))
                      }), 128 /* KEYED_FRAGMENT */))
                    ])
                  ]),
                  _createElementVNode("div", _hoisted_386, [
                    _createElementVNode("button", {
                      type: "button",
                      class: "btn",
                      onClick: _cache[93] || (_cache[93] = $event => (_ctx.modal=null))
                    }, _toDisplayString(_ctx.t('Cancel')), 1 /* TEXT */),
                    _createElementVNode("button", {
                      type: "button",
                      class: "btn primary",
                      disabled: _ctx.reorder.busy,
                      onClick: _cache[94] || (_cache[94] = (...args) => (_ctx.saveReorder && _ctx.saveReorder(...args)))
                    }, _toDisplayString(_ctx.t('Save order')), 9 /* TEXT, PROPS */, _hoisted_387)
                  ])
                ])
              ]))
            : _createCommentVNode("v-if", true),
          _createCommentVNode(" Collection settings "),
          (_ctx.modal && _ctx.modal.type==='collSettings')
            ? (_openBlock(), _createElementBlock("div", {
                key: 6,
                class: "modal-mask",
                onClick: _cache[132] || (_cache[132] = _withModifiers($event => (_ctx.modal=null), ["self"]))
              }, [
                _createElementVNode("div", _hoisted_388, [
                  _createElementVNode("div", _hoisted_389, [
                    _createElementVNode("h3", null, _toDisplayString(_ctx.t('⚙️ Collection settings')), 1 /* TEXT */),
                    _createElementVNode("button", {
                      class: "icon-btn",
                      onClick: _cache[96] || (_cache[96] = $event => (_ctx.modal=null))
                    }, "✕")
                  ]),
                  _createElementVNode("div", _hoisted_390, [
                    (!_ctx.isOwner)
                      ? (_openBlock(), _createElementBlock("div", _hoisted_391, _toDisplayString(_ctx.shareAccessNote), 1 /* TEXT */))
                      : _createCommentVNode("v-if", true),
                    (_ctx.canSettings)
                      ? (_openBlock(), _createElementBlock(_Fragment, { key: 1 }, [
                          _createElementVNode("div", _hoisted_392, [
                            _createElementVNode("label", null, "🏷️ " + _toDisplayString(_ctx.t('Name')), 1 /* TEXT */),
                            _withDirectives(_createElementVNode("input", {
                              "onUpdate:modelValue": _cache[97] || (_cache[97] = $event => ((_ctx.collForm.name) = $event))
                            }, null, 512 /* NEED_PATCH */), [
                              [_vModelText, _ctx.collForm.name]
                            ])
                          ]),
                          _createElementVNode("div", _hoisted_393, [
                            _createElementVNode("label", null, "📝 " + _toDisplayString(_ctx.t('Description')), 1 /* TEXT */),
                            _withDirectives(_createElementVNode("textarea", {
                              "onUpdate:modelValue": _cache[98] || (_cache[98] = $event => ((_ctx.collForm.description) = $event)),
                              placeholder: _ctx.t('Description of this collection (shown on the home screen card)')
                            }, null, 8 /* PROPS */, _hoisted_394), [
                              [_vModelText, _ctx.collForm.description]
                            ])
                          ]),
                          _createElementVNode("div", _hoisted_395, [
                            _createElementVNode("div", _hoisted_396, [
                              _createElementVNode("label", null, "🎨 " + _toDisplayString(_ctx.t('Color')), 1 /* TEXT */),
                              _withDirectives(_createElementVNode("input", {
                                type: "color",
                                "onUpdate:modelValue": _cache[99] || (_cache[99] = $event => ((_ctx.collForm.color) = $event)),
                                style: {"height":"44px","padding":"4px","width":"100%"}
                              }, null, 512 /* NEED_PATCH */), [
                                [_vModelText, _ctx.collForm.color]
                              ])
                            ]),
                            _createElementVNode("div", _hoisted_397, [
                              _createElementVNode("label", null, "😀 " + _toDisplayString(_ctx.t('Icon')), 1 /* TEXT */),
                              _createElementVNode("div", _hoisted_398, [
                                _createElementVNode("button", {
                                  type: "button",
                                  class: _normalizeClass(["iconpick-cur", {open: _ctx.iconPickerOpen && _ctx.iconTarget==='collForm'}]),
                                  onClick: _cache[100] || (_cache[100] = _withModifiers($event => (_ctx.openIconPicker('collForm')), ["stop"])),
                                  title: _ctx.t('Click to choose an icon')
                                }, _toDisplayString(_ctx.collForm.icon || '🗂️'), 11 /* TEXT, CLASS, PROPS */, _hoisted_399),
                                _withDirectives(_createElementVNode("input", {
                                  "onUpdate:modelValue": _cache[101] || (_cache[101] = $event => ((_ctx.collForm.icon) = $event)),
                                  maxlength: "16",
                                  placeholder: _ctx.t('Emoji')
                                }, null, 8 /* PROPS */, _hoisted_400), [
                                  [_vModelText, _ctx.collForm.icon]
                                ])
                              ])
                            ])
                          ]),
                          _createElementVNode("div", _hoisted_401, [
                            _createElementVNode("label", null, "📁 " + _toDisplayString(_ctx.t('Attachment folder (this collection)')), 1 /* TEXT */),
                            _createElementVNode("div", _hoisted_402, [
                              _withDirectives(_createElementVNode("input", {
                                "onUpdate:modelValue": _cache[102] || (_cache[102] = $event => ((_ctx.collForm.files_folder) = $event)),
                                placeholder: _ctx.t('e.g. RegiBase/Cards'),
                                spellcheck: "false",
                                autocorrect: "off",
                                autocapitalize: "off",
                                style: {"flex":"1","min-width":"0"}
                              }, null, 8 /* PROPS */, _hoisted_403), [
                                [_vModelText, _ctx.collForm.files_folder]
                              ]),
                              _createElementVNode("button", {
                                type: "button",
                                class: "btn sm",
                                onClick: _cache[103] || (_cache[103] = $event => (_ctx.openFolderPicker()))
                              }, "📁 " + _toDisplayString(_ctx.t('Browse…')), 1 /* TEXT */)
                            ]),
                            _createElementVNode("div", _hoisted_404, _toDisplayString(_ctx.t('Folder (under Files) where this collection’s images and files are saved. Type a path or use Browse. Default: RegiBase/collection name. If left blank, editing a record warns you to set it.')), 1 /* TEXT */)
                          ]),
                          _createElementVNode("div", _hoisted_405, [
                            _createElementVNode("label", null, "🌐 " + _toDisplayString(_ctx.t('Map service (this collection)')), 1 /* TEXT */),
                            _withDirectives(_createElementVNode("select", {
                              "onUpdate:modelValue": _cache[104] || (_cache[104] = $event => ((_ctx.collForm.map_provider) = $event))
                            }, [
                              _createElementVNode("option", _hoisted_406, _toDisplayString(_ctx.t('Default (Google Maps)')), 1 /* TEXT */),
                              _createElementVNode("option", _hoisted_407, _toDisplayString(_ctx.t('Google Maps')), 1 /* TEXT */),
                              _createElementVNode("option", _hoisted_408, _toDisplayString(_ctx.t('Yahoo! Maps (Japan)')), 1 /* TEXT */),
                              _createElementVNode("option", _hoisted_409, _toDisplayString(_ctx.t('OpenStreetMap')), 1 /* TEXT */),
                              _createElementVNode("option", _hoisted_410, _toDisplayString(_ctx.t('Apple Maps')), 1 /* TEXT */),
                              _createElementVNode("option", _hoisted_411, _toDisplayString(_ctx.t('Bing Maps')), 1 /* TEXT */)
                            ], 512 /* NEED_PATCH */), [
                              [_vModelSelect, _ctx.collForm.map_provider]
                            ])
                          ])
                        ], 64 /* STABLE_FRAGMENT */))
                      : _createCommentVNode("v-if", true),
                    (_ctx.isOwner)
                      ? (_openBlock(), _createElementBlock("div", _hoisted_412, [
                          _createElementVNode("label", _hoisted_413, [
                            _withDirectives(_createElementVNode("input", {
                              type: "checkbox",
                              "onUpdate:modelValue": _cache[105] || (_cache[105] = $event => ((_ctx.collForm.locked) = $event)),
                              style: {"width":"18px","height":"18px"}
                            }, null, 512 /* NEED_PATCH */), [
                              [_vModelCheckbox, _ctx.collForm.locked]
                            ]),
                            _createElementVNode("span", null, "🔒 " + _toDisplayString(_ctx.t('Edit lock (view only)')), 1 /* TEXT */)
                          ]),
                          _createElementVNode("div", _hoisted_414, _toDisplayString(_ctx.t('When on, this collection is view-only: records and fields cannot be added, edited or deleted. A 🔒 mark appears in the collection list. Turn it off here to edit again.')), 1 /* TEXT */)
                        ]))
                      : _createCommentVNode("v-if", true),
                    (_ctx.isOwner)
                      ? (_openBlock(), _createElementBlock("div", _hoisted_415, [
                          _createElementVNode("label", _hoisted_416, [
                            _withDirectives(_createElementVNode("input", {
                              type: "checkbox",
                              "onUpdate:modelValue": _cache[106] || (_cache[106] = $event => ((_ctx.collForm.secret) = $event)),
                              style: {"width":"18px","height":"18px"}
                            }, null, 512 /* NEED_PATCH */), [
                              [_vModelCheckbox, _ctx.collForm.secret]
                            ]),
                            _createElementVNode("span", null, "🕶️ " + _toDisplayString(_ctx.t('Make this collection secret')), 1 /* TEXT */)
                          ]),
                          _createElementVNode("div", _hoisted_417, _toDisplayString(_ctx.t('When on, this collection is hidden from the list. Use the “Secret toggle” button under “＋ New collection”, enter its 6-digit key, and it appears again for that session only.')), 1 /* TEXT */),
                          (_ctx.collForm.secret)
                            ? (_openBlock(), _createElementBlock("div", _hoisted_418, [
                                _createElementVNode("label", null, "🔢 " + _toDisplayString(_ctx.t('6-digit secret key')), 1 /* TEXT */),
                                _withDirectives(_createElementVNode("input", {
                                  "onUpdate:modelValue": _cache[107] || (_cache[107] = $event => ((_ctx.collForm.secret_pin) = $event)),
                                  inputmode: "numeric",
                                  autocomplete: "off",
                                  autocorrect: "off",
                                  spellcheck: "false",
                                  "data-1p-ignore": "",
                                  "data-lpignore": "true",
                                  maxlength: "6",
                                  onInput: _cache[108] || (_cache[108] = $event => (_ctx.collForm.secret_pin = (_ctx.collForm.secret_pin || '').replace(/\\D/g, '').slice(0, 6))),
                                  placeholder: _ctx.current.secret ? _ctx.t('Enter a new 6-digit key (leave blank to keep the current one)') : _ctx.t('Set a 6-digit key (numbers only)')
                                }, null, 40 /* PROPS, NEED_HYDRATION */, _hoisted_419), [
                                  [_vModelText, _ctx.collForm.secret_pin]
                                ])
                              ]))
                            : _createCommentVNode("v-if", true)
                        ]))
                      : _createCommentVNode("v-if", true),
                    (_ctx.isOwner)
                      ? (_openBlock(), _createElementBlock("div", {
                          key: 4,
                          class: _normalizeClass(["field share-section", {open: _ctx.shareExpanded}])
                        }, [
                          _createElementVNode("label", _hoisted_420, [
                            _withDirectives(_createElementVNode("input", {
                              type: "checkbox",
                              "onUpdate:modelValue": _cache[109] || (_cache[109] = $event => ((_ctx.shareExpanded) = $event)),
                              style: {"width":"18px","height":"18px"}
                            }, null, 512 /* NEED_PATCH */), [
                              [_vModelCheckbox, _ctx.shareExpanded]
                            ]),
                            _createElementVNode("span", null, "👥 " + _toDisplayString(_ctx.t('Share settings')), 1 /* TEXT */),
                            (_ctx.sharePanel.shares.length)
                              ? (_openBlock(), _createElementBlock("span", _hoisted_421, _toDisplayString(_ctx.sharePanel.shares.length), 1 /* TEXT */))
                              : _createCommentVNode("v-if", true)
                          ]),
                          _createElementVNode("div", _hoisted_422, _toDisplayString(_ctx.t('Turn on to share this collection with other users, or to review and change existing shares.')), 1 /* TEXT */),
                          _withDirectives(_createElementVNode("div", _hoisted_423, [
                            (_ctx.sharePanel.shares.length)
                              ? (_openBlock(), _createElementBlock("div", _hoisted_424, [
                                  (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.sharePanel.shares, (s) => {
                                    return (_openBlock(), _createElementBlock("div", {
                                      key: (s.recipient_type||'user') + ':' + s.recipient_uid,
                                      class: "share-row"
                                    }, [
                                      _createElementVNode("span", _hoisted_425, _toDisplayString(s.recipient_type === 'group' ? '👥' : '👤') + " " + _toDisplayString(s.recipient_name || s.recipient_uid), 1 /* TEXT */),
                                      _createElementVNode("select", {
                                        class: "share-perm",
                                        value: s.perm,
                                        onChange: $event => (_ctx.changeSharePerm(s, $event.target.value))
                                      }, [
                                        _createElementVNode("option", _hoisted_427, _toDisplayString(_ctx.t('View')), 1 /* TEXT */),
                                        _createElementVNode("option", _hoisted_428, _toDisplayString(_ctx.t('Edit')), 1 /* TEXT */),
                                        _createElementVNode("option", _hoisted_429, _toDisplayString(_ctx.t('Delete')), 1 /* TEXT */)
                                      ], 40 /* PROPS, NEED_HYDRATION */, _hoisted_426),
                                      (s.has_password)
                                        ? (_openBlock(), _createElementBlock("span", {
                                            key: 0,
                                            class: "share-flag",
                                            title: _ctx.t('Password protected')
                                          }, "🔑", 8 /* PROPS */, _hoisted_430))
                                        : _createCommentVNode("v-if", true),
                                      (s.shares_secrets)
                                        ? (_openBlock(), _createElementBlock("span", {
                                            key: 1,
                                            class: "share-flag",
                                            title: _ctx.t('Secret fields shared')
                                          }, "🔓", 8 /* PROPS */, _hoisted_431))
                                        : _createCommentVNode("v-if", true),
                                      _createElementVNode("button", {
                                        type: "button",
                                        class: "icon-btn",
                                        onClick: $event => (_ctx.removeShare(s)),
                                        title: _ctx.t('Remove share')
                                      }, "🗑", 8 /* PROPS */, _hoisted_432)
                                    ]))
                                  }), 128 /* KEYED_FRAGMENT */))
                                ]))
                              : _createCommentVNode("v-if", true),
                            _createElementVNode("div", _hoisted_433, [
                              _createElementVNode("div", _hoisted_434, [
                                (!_ctx.sharePanel.recipient)
                                  ? (_openBlock(), _createElementBlock("div", _hoisted_435, [
                                      _withDirectives(_createElementVNode("input", {
                                        "onUpdate:modelValue": _cache[110] || (_cache[110] = $event => ((_ctx.sharePanel.q) = $event)),
                                        onInput: _cache[111] || (_cache[111] = (...args) => (_ctx.searchShareUsers && _ctx.searchShareUsers(...args))),
                                        placeholder: _ctx.t('Search users or groups to share with…'),
                                        autocomplete: "off"
                                      }, null, 40 /* PROPS, NEED_HYDRATION */, _hoisted_436), [
                                        [_vModelText, _ctx.sharePanel.q]
                                      ]),
                                      (_ctx.sharePanel.results.length)
                                        ? (_openBlock(), _createElementBlock("div", _hoisted_437, [
                                            (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.sharePanel.results, (u) => {
                                              return (_openBlock(), _createElementBlock("button", {
                                                type: "button",
                                                key: (u.type||'user') + ':' + u.uid,
                                                class: "share-result",
                                                onClick: $event => (_ctx.pickShareUser(u))
                                              }, [
                                                _createTextVNode(_toDisplayString(u.type === 'group' ? '👥' : '👤') + " " + _toDisplayString(u.name) + " ", 1 /* TEXT */),
                                                _createElementVNode("span", _hoisted_439, "(" + _toDisplayString(u.uid) + ")", 1 /* TEXT */)
                                              ], 8 /* PROPS */, _hoisted_438))
                                            }), 128 /* KEYED_FRAGMENT */))
                                          ]))
                                        : _createCommentVNode("v-if", true)
                                    ]))
                                  : (_openBlock(), _createElementBlock("div", _hoisted_440, [
                                      _createElementVNode("span", _hoisted_441, [
                                        _createTextVNode(_toDisplayString(_ctx.sharePanel.recipientType === 'group' ? '👥' : '👤') + " " + _toDisplayString(_ctx.sharePanel.recipientName) + " ", 1 /* TEXT */),
                                        _createElementVNode("span", _hoisted_442, "(" + _toDisplayString(_ctx.sharePanel.recipient) + ")", 1 /* TEXT */)
                                      ]),
                                      _createElementVNode("button", {
                                        type: "button",
                                        class: "icon-btn",
                                        onClick: _cache[112] || (_cache[112] = (...args) => (_ctx.clearShareRecipient && _ctx.clearShareRecipient(...args)))
                                      }, "✕")
                                    ])),
                                _createElementVNode("div", {
                                  class: _normalizeClass(["perm-wrap", {open: _ctx.permOpen}]),
                                  title: _ctx.t('Permission'),
                                  onClick: _cache[114] || (_cache[114] = _withModifiers($event => (_ctx.permOpen = !_ctx.permOpen), ["stop"]))
                                }, [
                                  _createElementVNode("span", _hoisted_444, _toDisplayString(_ctx.permLabel), 1 /* TEXT */),
                                  _hoisted_445,
                                  (_ctx.permOpen)
                                    ? (_openBlock(), _createElementBlock("div", {
                                        key: 0,
                                        class: "perm-menu",
                                        onClick: _cache[113] || (_cache[113] = _withModifiers(() => {}, ["stop"]))
                                      }, [
                                        (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.permOptions, (o) => {
                                          return (_openBlock(), _createElementBlock("button", {
                                            type: "button",
                                            key: o.v,
                                            class: _normalizeClass(["perm-opt", {sel: _ctx.sharePanel.perm === o.v}]),
                                            onClick: $event => {_ctx.sharePanel.perm = o.v; _ctx.permOpen = false}
                                          }, _toDisplayString(o.label), 11 /* TEXT, CLASS, PROPS */, _hoisted_446))
                                        }), 128 /* KEYED_FRAGMENT */))
                                      ]))
                                    : _createCommentVNode("v-if", true)
                                ], 10 /* CLASS, PROPS */, _hoisted_443),
                                (_ctx.permOpen)
                                  ? (_openBlock(), _createElementBlock("div", {
                                      key: 2,
                                      class: "perm-backdrop",
                                      onClick: _cache[115] || (_cache[115] = $event => (_ctx.permOpen = false))
                                    }))
                                  : _createCommentVNode("v-if", true)
                              ]),
                              _createElementVNode("div", _hoisted_447, [
                                _createElementVNode("div", _hoisted_448, [
                                  _createElementVNode("span", _hoisted_449, _toDisplayString(_ctx.t('Share password (optional)')), 1 /* TEXT */),
                                  _createElementVNode("div", _hoisted_450, [
                                    _withDirectives(_createElementVNode("input", {
                                      "onUpdate:modelValue": _cache[116] || (_cache[116] = $event => ((_ctx.sharePanel.password) = $event)),
                                      type: "text",
                                      placeholder: _ctx.t('Blank = no password'),
                                      autocomplete: "off",
                                      "data-1p-ignore": "",
                                      "data-lpignore": "true"
                                    }, null, 8 /* PROPS */, _hoisted_451), [
                                      [_vModelText, _ctx.sharePanel.password]
                                    ]),
                                    _createElementVNode("button", {
                                      type: "button",
                                      class: "icon-btn",
                                      onClick: _cache[117] || (_cache[117] = _withModifiers($event => (_ctx.openPwGen('share')), ["stop"])),
                                      title: _ctx.t('Generate a password')
                                    }, "🎲", 8 /* PROPS */, _hoisted_452)
                                  ])
                                ]),
                                (_ctx.collectionHasSecret && _ctx.enc.enabled)
                                  ? (_openBlock(), _createElementBlock("div", _hoisted_453, [
                                      _createElementVNode("span", _hoisted_454, _toDisplayString(_ctx.t('Show secret fields to the recipient')), 1 /* TEXT */),
                                      _withDirectives(_createElementVNode("input", {
                                        "onUpdate:modelValue": _cache[118] || (_cache[118] = $event => ((_ctx.sharePanel.master) = $event)),
                                        type: "password",
                                        placeholder: _ctx.t('Your master password (blank = keep secrets hidden)'),
                                        autocomplete: "off",
                                        "data-1p-ignore": "",
                                        "data-lpignore": "true"
                                      }, null, 8 /* PROPS */, _hoisted_455), [
                                        [_vModelText, _ctx.sharePanel.master]
                                      ]),
                                      _createElementVNode("div", _hoisted_456, _toDisplayString(_ctx.t('Requires a share password (used to protect the key). Secrets stay masked without it.')), 1 /* TEXT */)
                                    ]))
                                  : _createCommentVNode("v-if", true)
                              ]),
                              (_ctx.sharePanel.err)
                                ? (_openBlock(), _createElementBlock("div", _hoisted_457, _toDisplayString(_ctx.sharePanel.err), 1 /* TEXT */))
                                : _createCommentVNode("v-if", true),
                              _createElementVNode("button", {
                                type: "button",
                                class: "btn sm primary",
                                disabled: !_ctx.sharePanel.recipient || _ctx.sharePanel.busy,
                                onClick: _cache[119] || (_cache[119] = (...args) => (_ctx.addShare && _ctx.addShare(...args)))
                              }, _toDisplayString(_ctx.t('Share')), 9 /* TEXT, PROPS */, _hoisted_458)
                            ])
                          ], 512 /* NEED_PATCH */), [
                            [_vShow, _ctx.shareExpanded]
                          ])
                        ], 2 /* CLASS */))
                      : _createCommentVNode("v-if", true),
                    (_ctx.isOwner)
                      ? (_openBlock(), _createElementBlock("div", _hoisted_459, [
                          _createElementVNode("label", null, "📄 " + _toDisplayString(_ctx.t('Duplicate / template')), 1 /* TEXT */),
                          _createElementVNode("div", _hoisted_460, [
                            _createElementVNode("button", {
                              type: "button",
                              class: "btn sm",
                              onClick: _cache[120] || (_cache[120] = (...args) => (_ctx.openDuplicate && _ctx.openDuplicate(...args)))
                            }, _toDisplayString(_ctx.t('📄 Duplicate collection')), 1 /* TEXT */),
                            _createElementVNode("button", {
                              type: "button",
                              class: "btn sm",
                              onClick: _cache[121] || (_cache[121] = (...args) => (_ctx.saveAsTemplate && _ctx.saveAsTemplate(...args)))
                            }, _toDisplayString(_ctx.t('⭐ Save as template')), 1 /* TEXT */)
                          ]),
                          _createElementVNode("div", _hoisted_461, _toDisplayString(_ctx.t('Duplicate copies the fields (optionally the records). Save as template adds it to the New collection picker.')), 1 /* TEXT */)
                        ]))
                      : _createCommentVNode("v-if", true),
                    _createElementVNode("div", _hoisted_462, [
                      _createElementVNode("label", null, "📤 " + _toDisplayString(_ctx.t('Export (all records in this collection)')), 1 /* TEXT */),
                      _createElementVNode("div", _hoisted_463, [
                        _createElementVNode("button", {
                          type: "button",
                          class: "btn sm",
                          onClick: _cache[122] || (_cache[122] = $event => (_ctx.exportCollection('csv')))
                        }, _toDisplayString(_ctx.t('⬇ Export as CSV')), 1 /* TEXT */),
                        _createElementVNode("button", {
                          type: "button",
                          class: "btn sm",
                          onClick: _cache[123] || (_cache[123] = $event => (_ctx.exportCollection('json')))
                        }, _toDisplayString(_ctx.t('⬇ Export as JSON')), 1 /* TEXT */),
                        _createElementVNode("button", {
                          type: "button",
                          class: "btn sm",
                          disabled: _ctx.tablesExportBusy || !_ctx.apps.tables,
                          title: _ctx.apps.tables ? '' : _ctx.t('The Tables app is not enabled'),
                          onClick: _cache[124] || (_cache[124] = (...args) => (_ctx.exportToTables && _ctx.exportToTables(...args)))
                        }, _toDisplayString(_ctx.t('📊 Export to Tables')), 9 /* TEXT, PROPS */, _hoisted_464)
                      ]),
                      _createElementVNode("div", _hoisted_465, _toDisplayString(_ctx.t('JSON includes field definitions and can be re-imported into RegiBase directly.')), 1 /* TEXT */),
                      _createElementVNode("div", _hoisted_466, _toDisplayString(_ctx.t('Export to Tables creates a new table. Secret and attachment fields are skipped.')), 1 /* TEXT */)
                    ]),
                    _createElementVNode("div", _hoisted_467, [
                      _createElementVNode("label", null, "🕐 " + _toDisplayString(_ctx.t('Snapshots (change history)')), 1 /* TEXT */),
                      _createElementVNode("div", _hoisted_468, [
                        _createElementVNode("button", {
                          type: "button",
                          class: "btn sm",
                          onClick: _cache[125] || (_cache[125] = (...args) => (_ctx.openHistory && _ctx.openHistory(...args)))
                        }, "↶ " + _toDisplayString(_ctx.t('Open snapshots')), 1 /* TEXT */),
                        (_ctx.history.length)
                          ? (_openBlock(), _createElementBlock("span", _hoisted_469, _toDisplayString(_ctx.t('{n} snapshots', {n: _ctx.history.length})), 1 /* TEXT */))
                          : _createCommentVNode("v-if", true)
                      ]),
                      _createElementVNode("div", _hoisted_470, [
                        _createElementVNode("span", _hoisted_471, _toDisplayString(_ctx.t('Keep up to')), 1 /* TEXT */),
                        _withDirectives(_createElementVNode("input", {
                          type: "number",
                          min: "0",
                          max: "1000",
                          "onUpdate:modelValue": _cache[126] || (_cache[126] = $event => ((_ctx.settingsForm.undo_limit) = $event)),
                          onChange: _cache[127] || (_cache[127] = (...args) => (_ctx.saveSnapLimit && _ctx.saveSnapLimit(...args))),
                          style: {"width":"88px"}
                        }, null, 544 /* NEED_HYDRATION, NEED_PATCH */), [
                          [
                            _vModelText,
                            _ctx.settingsForm.undo_limit,
                            void 0,
                            { number: true }
                          ]
                        ]),
                        _createElementVNode("span", _hoisted_472, _toDisplayString(_ctx.t('changes')), 1 /* TEXT */)
                      ]),
                      _createElementVNode("div", _hoisted_473, _toDisplayString(_ctx.t('Every change to this collection is snapshotted. Open to review, undo the latest, or restore to an earlier point. Set 0 to turn snapshots off. (The keep limit applies to all collections.)')), 1 /* TEXT */)
                    ]),
                    _createElementVNode("div", _hoisted_474, [
                      _createElementVNode("label", null, "🎲 " + _toDisplayString(_ctx.t('Password generator defaults')), 1 /* TEXT */),
                      _createElementVNode("div", _hoisted_475, [
                        _createElementVNode("button", {
                          type: "button",
                          class: "btn sm",
                          onClick: _cache[128] || (_cache[128] = $event => (_ctx.openPwGenDefaults()))
                        }, _toDisplayString(_ctx.t('Set default values')), 1 /* TEXT */)
                      ]),
                      _createElementVNode("div", _hoisted_476, _toDisplayString(_ctx.t('The length, character types and options used when you open the 🎲 generator. Applies to every collection.')), 1 /* TEXT */)
                    ])
                  ]),
                  _createElementVNode("div", _hoisted_477, [
                    (_ctx.isOwner)
                      ? (_openBlock(), _createElementBlock("button", {
                          key: 0,
                          class: "btn danger foot-left",
                          onClick: _cache[129] || (_cache[129] = (...args) => (_ctx.deleteCollection && _ctx.deleteCollection(...args)))
                        }, _toDisplayString(_ctx.t('Delete collection')), 1 /* TEXT */))
                      : _createCommentVNode("v-if", true),
                    _createElementVNode("button", {
                      type: "button",
                      class: "btn",
                      onClick: _cache[130] || (_cache[130] = $event => (_ctx.modal=null))
                    }, _toDisplayString(_ctx.t('Cancel')), 1 /* TEXT */),
                    (_ctx.canSettings)
                      ? (_openBlock(), _createElementBlock("button", {
                          key: 1,
                          class: "btn primary",
                          onClick: _cache[131] || (_cache[131] = (...args) => (_ctx.saveCollSettings && _ctx.saveCollSettings(...args)))
                        }, _toDisplayString(_ctx.t('Save')), 1 /* TEXT */))
                      : _createCommentVNode("v-if", true)
                  ])
                ])
              ]))
            : _createCommentVNode("v-if", true),
          _createCommentVNode(" Dedicated dialog: on title change, ask whether to rename the save folder too.\n       Floats above the collection-settings modal (cropper-mask z-index). "),
          (_ctx.folderAsk.open)
            ? (_openBlock(), _createElementBlock("div", {
                key: 7,
                class: "modal-mask cropper-mask",
                onClick: _cache[136] || (_cache[136] = _withModifiers($event => (!_ctx.folderAsk.busy && _ctx.cancelFolderAsk()), ["self"]))
              }, [
                _createElementVNode("div", _hoisted_478, [
                  _createElementVNode("div", _hoisted_479, [
                    _createElementVNode("h3", null, _toDisplayString(_ctx.t('📁 Rename save folder')), 1 /* TEXT */),
                    _createElementVNode("button", {
                      class: "icon-btn",
                      disabled: _ctx.folderAsk.busy,
                      onClick: _cache[133] || (_cache[133] = (...args) => (_ctx.cancelFolderAsk && _ctx.cancelFolderAsk(...args)))
                    }, "✕", 8 /* PROPS */, _hoisted_480)
                  ]),
                  _createElementVNode("div", _hoisted_481, [
                    _createElementVNode("p", _hoisted_482, _toDisplayString(_ctx.t('Rename the save folder too? Your data is kept.')), 1 /* TEXT */),
                    _createElementVNode("div", _hoisted_483, [
                      _createElementVNode("div", _hoisted_484, _toDisplayString(_ctx.folderAsk.from), 1 /* TEXT */),
                      _hoisted_485,
                      _createElementVNode("div", _hoisted_486, _toDisplayString(_ctx.folderAsk.to), 1 /* TEXT */)
                    ])
                  ]),
                  _createElementVNode("div", _hoisted_487, [
                    _createElementVNode("button", {
                      type: "button",
                      class: "btn",
                      disabled: _ctx.folderAsk.busy,
                      onClick: _cache[134] || (_cache[134] = $event => (_ctx.commitCollSettings(false)))
                    }, _toDisplayString(_ctx.t('Keep the folder name')), 9 /* TEXT, PROPS */, _hoisted_488),
                    _createElementVNode("button", {
                      type: "button",
                      class: "btn primary",
                      disabled: _ctx.folderAsk.busy,
                      onClick: _cache[135] || (_cache[135] = $event => (_ctx.commitCollSettings(true)))
                    }, _toDisplayString(_ctx.t('Rename the folder')), 9 /* TEXT, PROPS */, _hoisted_489)
                  ])
                ])
              ]))
            : _createCommentVNode("v-if", true),
          _createCommentVNode(" Secret collections: 2FA-style 6-digit key prompt "),
          (_ctx.modal && _ctx.modal.type==='secretReveal')
            ? (_openBlock(), _createElementBlock("div", {
                key: 8,
                class: "modal-mask",
                onClick: _cache[142] || (_cache[142] = _withModifiers($event => (_ctx.modal=null), ["self"]))
              }, [
                _createElementVNode("div", _hoisted_490, [
                  _createElementVNode("div", _hoisted_491, [
                    _createElementVNode("h3", null, _toDisplayString(_ctx.t('🕶️ Secret toggle')), 1 /* TEXT */),
                    _createElementVNode("button", {
                      class: "icon-btn",
                      onClick: _cache[137] || (_cache[137] = $event => (_ctx.modal=null))
                    }, "✕")
                  ]),
                  _createElementVNode("div", _hoisted_492, [
                    _createElementVNode("p", _hoisted_493, _toDisplayString(_ctx.t('Enter the 6-digit secret key to show its collections.')), 1 /* TEXT */),
                    _createElementVNode("div", _hoisted_494, [
                      (_openBlock(), _createElementBlock(_Fragment, null, _renderList(6, (n, i) => {
                        return _createElementVNode("input", {
                          key: i,
                          ref_for: true,
                          ref: "cells",
                          class: "secret-cell",
                          type: "password",
                          inputmode: "numeric",
                          autocomplete: "off",
                          autocorrect: "off",
                          spellcheck: "false",
                          "data-1p-ignore": "",
                          "data-lpignore": "true",
                          maxlength: "1",
                          value: _ctx.secretForm.cells[i],
                          onFocus: _cache[138] || (_cache[138] = $event => ($event.target.select())),
                          onInput: $event => (_ctx.onSecretCellInput(i, $event)),
                          onKeydown: $event => (_ctx.onSecretCellKey(i, $event)),
                          onPaste: _cache[139] || (_cache[139] = (...args) => (_ctx.onSecretPaste && _ctx.onSecretPaste(...args)))
                        }, null, 40 /* PROPS, NEED_HYDRATION */, _hoisted_495)
                      }), 64 /* STABLE_FRAGMENT */))
                    ]),
                    (_ctx.secretForm.err)
                      ? (_openBlock(), _createElementBlock("div", _hoisted_496, _toDisplayString(_ctx.secretForm.err), 1 /* TEXT */))
                      : _createCommentVNode("v-if", true)
                  ]),
                  _createElementVNode("div", _hoisted_497, [
                    _createElementVNode("button", {
                      type: "button",
                      class: "btn",
                      onClick: _cache[140] || (_cache[140] = $event => (_ctx.modal=null))
                    }, _toDisplayString(_ctx.t('Cancel')), 1 /* TEXT */),
                    _createElementVNode("button", {
                      class: "btn primary",
                      disabled: _ctx.secretForm.busy || _ctx.secretForm.pin.length !== 6,
                      onClick: _cache[141] || (_cache[141] = (...args) => (_ctx.submitSecretReveal && _ctx.submitSecretReveal(...args)))
                    }, _toDisplayString(_ctx.secretForm.busy ? _ctx.t('Checking…') : _ctx.t('Show')), 9 /* TEXT, PROPS */, _hoisted_498)
                  ])
                ])
              ]))
            : _createCommentVNode("v-if", true),
          _createCommentVNode(" Shared collection unlock (share password) "),
          (_ctx.shareUnlock.open)
            ? (_openBlock(), _createElementBlock("div", {
                key: 9,
                class: "modal-mask",
                onClick: _cache[148] || (_cache[148] = _withModifiers((...args) => (_ctx.cancelShareUnlock && _ctx.cancelShareUnlock(...args)), ["self"]))
              }, [
                _createElementVNode("div", _hoisted_499, [
                  _createElementVNode("div", _hoisted_500, [
                    _createElementVNode("h3", null, _toDisplayString(_ctx.t('🔒 Enter share password')), 1 /* TEXT */),
                    _createElementVNode("button", {
                      class: "icon-btn",
                      onClick: _cache[143] || (_cache[143] = (...args) => (_ctx.cancelShareUnlock && _ctx.cancelShareUnlock(...args)))
                    }, "✕")
                  ]),
                  _createElementVNode("div", _hoisted_501, [
                    _createElementVNode("p", _hoisted_502, _toDisplayString(_ctx.t('“{name}” is password-protected.', {name: _ctx.shareUnlock.name})), 1 /* TEXT */),
                    _createElementVNode("div", _hoisted_503, [
                      _createElementVNode("label", null, _toDisplayString(_ctx.t('Share password')), 1 /* TEXT */),
                      _withDirectives(_createElementVNode("input", {
                        "onUpdate:modelValue": _cache[144] || (_cache[144] = $event => ((_ctx.shareUnlock.password) = $event)),
                        type: "password",
                        onKeyup: _cache[145] || (_cache[145] = _withKeys((...args) => (_ctx.doShareUnlock && _ctx.doShareUnlock(...args)), ["enter"])),
                        autocomplete: "off",
                        "data-1p-ignore": "",
                        "data-lpignore": "true"
                      }, null, 544 /* NEED_HYDRATION, NEED_PATCH */), [
                        [_vModelText, _ctx.shareUnlock.password]
                      ])
                    ]),
                    (_ctx.shareUnlock.err)
                      ? (_openBlock(), _createElementBlock("div", _hoisted_504, _toDisplayString(_ctx.shareUnlock.err), 1 /* TEXT */))
                      : _createCommentVNode("v-if", true)
                  ]),
                  _createElementVNode("div", _hoisted_505, [
                    _createElementVNode("button", {
                      type: "button",
                      class: "btn",
                      onClick: _cache[146] || (_cache[146] = (...args) => (_ctx.cancelShareUnlock && _ctx.cancelShareUnlock(...args)))
                    }, _toDisplayString(_ctx.t('Cancel')), 1 /* TEXT */),
                    _createElementVNode("button", {
                      class: "btn primary",
                      disabled: _ctx.shareUnlock.busy,
                      onClick: _cache[147] || (_cache[147] = (...args) => (_ctx.doShareUnlock && _ctx.doShareUnlock(...args)))
                    }, _toDisplayString(_ctx.t('Unlock')), 9 /* TEXT, PROPS */, _hoisted_506)
                  ])
                ])
              ]))
            : _createCommentVNode("v-if", true),
          _createCommentVNode(" Data Import (CSV / JSON) "),
          (_ctx.modal && _ctx.modal.type==='import')
            ? (_openBlock(), _createElementBlock("div", {
                key: 10,
                class: "modal-mask",
                onClick: _cache[159] || (_cache[159] = _withModifiers($event => (_ctx.modal=null), ["self"]))
              }, [
                _createElementVNode("div", _hoisted_507, [
                  _createElementVNode("div", _hoisted_508, [
                    _createElementVNode("h3", null, _toDisplayString(_ctx.t('📥 Import (CSV / JSON)')), 1 /* TEXT */),
                    _createElementVNode("button", {
                      class: "icon-btn",
                      onClick: _cache[149] || (_cache[149] = $event => (_ctx.modal=null))
                    }, "✕")
                  ]),
                  _createElementVNode("div", _hoisted_509, [
                    (_ctx.importStep===1)
                      ? (_openBlock(), _createElementBlock(_Fragment, { key: 0 }, [
                          _createElementVNode("p", _hoisted_510, [
                            _createTextVNode(_toDisplayString(_ctx.t('Choose a CSV or JSON file, or paste its contents, and fields (the input form) are created automatically and all rows imported.')), 1 /* TEXT */),
                            _hoisted_511,
                            _createTextVNode(_toDisplayString(_ctx.t('e.g. Google Password Manager CSV export / an array of objects in JSON / RegiBase JSON export.')), 1 /* TEXT */)
                          ]),
                          _createElementVNode("label", _hoisted_512, [
                            _createElementVNode("input", {
                              type: "file",
                              accept: ".csv,.json,.txt",
                              onChange: _cache[150] || (_cache[150] = (...args) => (_ctx.onImportFile && _ctx.onImportFile(...args)))
                            }, null, 32 /* NEED_HYDRATION */),
                            _createElementVNode("span", _hoisted_513, _toDisplayString(_ctx.t('📄 Choose file')), 1 /* TEXT */),
                            _createElementVNode("span", _hoisted_514, _toDisplayString(_ctx.importFileName || _ctx.t('No file selected')), 1 /* TEXT */)
                          ]),
                          _createElementVNode("div", _hoisted_515, _toDisplayString(_ctx.t('Or paste the contents (CSV / JSON):')), 1 /* TEXT */),
                          _withDirectives(_createElementVNode("textarea", {
                            "onUpdate:modelValue": _cache[151] || (_cache[151] = $event => ((_ctx.importCsv) = $event)),
                            placeholder: _ctx.importExamplePh,
                            style: {"width":"100%","min-height":"150px","padding":"11px 12px","border-radius":"10px","border":"1px solid var(--border)","background":"var(--surface-2)","color":"var(--text)"}
                          }, null, 8 /* PROPS */, _hoisted_516), [
                            [_vModelText, _ctx.importCsv]
                          ])
                        ], 64 /* STABLE_FRAGMENT */))
                      : (_openBlock(), _createElementBlock(_Fragment, { key: 1 }, [
                          _createElementVNode("div", _hoisted_517, [
                            _createElementVNode("span", _hoisted_518, _toDisplayString(_ctx.t('Detected format:')) + " " + _toDisplayString(_ctx.importAnalysis.formatLabel), 1 /* TEXT */),
                            _createTextVNode(),
                            _createElementVNode("span", _hoisted_519, _toDisplayString(_ctx.t('{n} items', {n: _ctx.importAnalysis.rowCount})), 1 /* TEXT */)
                          ]),
                          _createElementVNode("div", _hoisted_520, [
                            _createElementVNode("label", null, _toDisplayString(_ctx.t('Collection name')), 1 /* TEXT */),
                            _withDirectives(_createElementVNode("input", {
                              "onUpdate:modelValue": _cache[152] || (_cache[152] = $event => ((_ctx.importColl.name) = $event))
                            }, null, 512 /* NEED_PATCH */), [
                              [_vModelText, _ctx.importColl.name]
                            ])
                          ]),
                          _createElementVNode("div", _hoisted_521, [
                            _createElementVNode("label", null, _toDisplayString(_ctx.t('Icon (emoji)')), 1 /* TEXT */),
                            _createElementVNode("div", _hoisted_522, [
                              _createElementVNode("button", {
                                type: "button",
                                class: _normalizeClass(["iconpick-cur", {open: _ctx.iconPickerOpen && _ctx.iconTarget==='importColl'}]),
                                onClick: _cache[153] || (_cache[153] = _withModifiers($event => (_ctx.openIconPicker('importColl')), ["stop"])),
                                title: _ctx.t('Click to choose an icon')
                              }, _toDisplayString(_ctx.importColl.icon || '📥'), 11 /* TEXT, CLASS, PROPS */, _hoisted_523),
                              _withDirectives(_createElementVNode("input", {
                                "onUpdate:modelValue": _cache[154] || (_cache[154] = $event => ((_ctx.importColl.icon) = $event)),
                                maxlength: "16",
                                placeholder: _ctx.t('Emoji')
                              }, null, 8 /* PROPS */, _hoisted_524), [
                                [_vModelText, _ctx.importColl.icon]
                              ])
                            ])
                          ]),
                          _createElementVNode("p", _hoisted_525, _toDisplayString(_ctx.t('Field settings for each column (🏷️ = emphasis / Secret = masked):')), 1 /* TEXT */),
                          (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.importCols, (c, i) => {
                            return (_openBlock(), _createElementBlock("div", {
                              key: i,
                              class: "schema-row"
                            }, [
                              _withDirectives(_createElementVNode("input", {
                                "onUpdate:modelValue": $event => ((c.label) = $event),
                                placeholder: _ctx.t('Display name')
                              }, null, 8 /* PROPS */, _hoisted_526), [
                                [_vModelText, c.label]
                              ]),
                              _withDirectives(_createElementVNode("select", {
                                "onUpdate:modelValue": $event => ((c.type) = $event)
                              }, [
                                _createElementVNode("option", _hoisted_528, _toDisplayString(_ctx.t('Text')), 1 /* TEXT */),
                                _createElementVNode("option", _hoisted_529, _toDisplayString(_ctx.t('Multi-line text')), 1 /* TEXT */),
                                _createElementVNode("option", _hoisted_530, _toDisplayString(_ctx.t('Password')), 1 /* TEXT */),
                                _hoisted_531,
                                _createElementVNode("option", _hoisted_532, _toDisplayString(_ctx.t('Email')), 1 /* TEXT */),
                                _createElementVNode("option", _hoisted_533, _toDisplayString(_ctx.t('Phone number')), 1 /* TEXT */),
                                _createElementVNode("option", _hoisted_534, _toDisplayString(_ctx.t('Address (map link)')), 1 /* TEXT */),
                                _createElementVNode("option", _hoisted_535, _toDisplayString(_ctx.t('Date')), 1 /* TEXT */),
                                _createElementVNode("option", _hoisted_536, _toDisplayString(_ctx.t('Numeric')), 1 /* TEXT */),
                                _createElementVNode("option", _hoisted_537, _toDisplayString(_ctx.t('Image')), 1 /* TEXT */)
                              ], 8 /* PROPS */, _hoisted_527), [
                                [_vModelSelect, c.type]
                              ]),
                              _createElementVNode("span", {
                                class: "chip",
                                title: _ctx.t('CSV column:')+' '+c.header
                              }, _toDisplayString(c.header), 9 /* TEXT, PROPS */, _hoisted_538),
                              _createElementVNode("div", _hoisted_539, [
                                _createElementVNode("label", null, [
                                  _createElementVNode("input", {
                                    type: "radio",
                                    checked: c.is_title,
                                    onChange: $event => (_ctx.setImportTitle(i))
                                  }, null, 40 /* PROPS, NEED_HYDRATION */, _hoisted_540),
                                  _createTextVNode(" " + _toDisplayString(_ctx.t('🏷️ Emphasis')), 1 /* TEXT */)
                                ]),
                                _createElementVNode("label", null, [
                                  _withDirectives(_createElementVNode("input", {
                                    type: "checkbox",
                                    "onUpdate:modelValue": $event => ((c.secret) = $event)
                                  }, null, 8 /* PROPS */, _hoisted_541), [
                                    [_vModelCheckbox, c.secret]
                                  ]),
                                  _createTextVNode(" " + _toDisplayString(_ctx.t('Secret')), 1 /* TEXT */)
                                ])
                              ])
                            ]))
                          }), 128 /* KEYED_FRAGMENT */))
                        ], 64 /* STABLE_FRAGMENT */))
                  ]),
                  _createElementVNode("div", _hoisted_542, [
                    (_ctx.importStep===2)
                      ? (_openBlock(), _createElementBlock("button", {
                          key: 0,
                          type: "button",
                          class: "btn",
                          onClick: _cache[155] || (_cache[155] = $event => (_ctx.importStep=1))
                        }, _toDisplayString(_ctx.t('← Back')), 1 /* TEXT */))
                      : _createCommentVNode("v-if", true),
                    _createElementVNode("button", {
                      type: "button",
                      class: "btn",
                      onClick: _cache[156] || (_cache[156] = $event => (_ctx.modal=null))
                    }, _toDisplayString(_ctx.t('Cancel')), 1 /* TEXT */),
                    (_ctx.importStep===1)
                      ? (_openBlock(), _createElementBlock("button", {
                          key: 1,
                          type: "button",
                          class: "btn primary",
                          onClick: _cache[157] || (_cache[157] = (...args) => (_ctx.analyzeImport && _ctx.analyzeImport(...args)))
                        }, _toDisplayString(_ctx.t('Analyze')), 1 /* TEXT */))
                      : (_openBlock(), _createElementBlock("button", {
                          key: 2,
                          type: "button",
                          class: "btn primary",
                          disabled: _ctx.importBusy,
                          onClick: _cache[158] || (_cache[158] = (...args) => (_ctx.commitImport && _ctx.commitImport(...args)))
                        }, _toDisplayString(_ctx.t('Import {n} items', {n: _ctx.importAnalysis.rowCount})), 9 /* TEXT, PROPS */, _hoisted_543))
                  ])
                ])
              ]))
            : _createCommentVNode("v-if", true),
          _createCommentVNode(" 連絡先（Contacts）からインポート "),
          (_ctx.modal && _ctx.modal.type==='contactsImport')
            ? (_openBlock(), _createElementBlock("div", {
                key: 11,
                class: "modal-mask",
                onClick: _cache[167] || (_cache[167] = _withModifiers($event => (!_ctx.contactsImport.busy && (_ctx.modal=null)), ["self"]))
              }, [
                _createElementVNode("div", _hoisted_544, [
                  _createElementVNode("div", _hoisted_545, [
                    _createElementVNode("h3", null, _toDisplayString(_ctx.t('📇 Import from Contacts')), 1 /* TEXT */),
                    _createElementVNode("button", {
                      class: "icon-btn",
                      disabled: _ctx.contactsImport.busy,
                      onClick: _cache[160] || (_cache[160] = $event => (_ctx.modal=null))
                    }, "✕", 8 /* PROPS */, _hoisted_546)
                  ]),
                  _createElementVNode("div", _hoisted_547, [
                    (_ctx.contactsImport.loading)
                      ? (_openBlock(), _createElementBlock("div", _hoisted_548, [
                          _createElementVNode("p", null, _toDisplayString(_ctx.t('Loading…')), 1 /* TEXT */)
                        ]))
                      : (!_ctx.contactsImport.enabled || !_ctx.contactsImport.books.length)
                        ? (_openBlock(), _createElementBlock("div", _hoisted_549, [
                            _createElementVNode("p", null, _toDisplayString(_ctx.t('No contacts found')), 1 /* TEXT */)
                          ]))
                        : (_openBlock(), _createElementBlock(_Fragment, { key: 2 }, [
                            _createElementVNode("p", _hoisted_550, _toDisplayString(_ctx.t('Import contacts as a new collection. Contacts is not modified.')), 1 /* TEXT */),
                            _createElementVNode("div", _hoisted_551, [
                              _createElementVNode("label", null, _toDisplayString(_ctx.t('Address book')), 1 /* TEXT */),
                              _withDirectives(_createElementVNode("select", {
                                "onUpdate:modelValue": _cache[161] || (_cache[161] = $event => ((_ctx.contactsImport.selected) = $event))
                              }, [
                                _createElementVNode("option", _hoisted_552, _toDisplayString(_ctx.t('All')) + "（" + _toDisplayString(_ctx.t('{n} items', {n: _ctx.contactsTotal})) + "）", 1 /* TEXT */),
                                (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.contactsImport.books, (b) => {
                                  return (_openBlock(), _createElementBlock("option", {
                                    key: b.key,
                                    value: b.key
                                  }, _toDisplayString(b.name) + "（" + _toDisplayString(_ctx.t('{n} items', {n: b.count})) + "）", 9 /* TEXT, PROPS */, _hoisted_553))
                                }), 128 /* KEYED_FRAGMENT */))
                              ], 512 /* NEED_PATCH */), [
                                [_vModelSelect, _ctx.contactsImport.selected]
                              ])
                            ]),
                            _createElementVNode("div", _hoisted_554, [
                              _createElementVNode("label", null, _toDisplayString(_ctx.t('Collection name')), 1 /* TEXT */),
                              _withDirectives(_createElementVNode("input", {
                                "onUpdate:modelValue": _cache[162] || (_cache[162] = $event => ((_ctx.contactsImport.name) = $event)),
                                placeholder: _ctx.t('Contacts')
                              }, null, 8 /* PROPS */, _hoisted_555), [
                                [_vModelText, _ctx.contactsImport.name]
                              ])
                            ]),
                            _createElementVNode("div", _hoisted_556, [
                              _createElementVNode("label", null, _toDisplayString(_ctx.t('Icon (emoji)')), 1 /* TEXT */),
                              _createElementVNode("div", _hoisted_557, [
                                _createElementVNode("button", {
                                  type: "button",
                                  class: _normalizeClass(["iconpick-cur", {open: _ctx.iconPickerOpen && _ctx.iconTarget==='contactsImport'}]),
                                  onClick: _cache[163] || (_cache[163] = _withModifiers($event => (_ctx.openIconPicker('contactsImport')), ["stop"])),
                                  title: _ctx.t('Click to choose an icon')
                                }, _toDisplayString(_ctx.contactsImport.icon || '👤'), 11 /* TEXT, CLASS, PROPS */, _hoisted_558),
                                _withDirectives(_createElementVNode("input", {
                                  "onUpdate:modelValue": _cache[164] || (_cache[164] = $event => ((_ctx.contactsImport.icon) = $event)),
                                  maxlength: "16",
                                  placeholder: _ctx.t('Emoji')
                                }, null, 8 /* PROPS */, _hoisted_559), [
                                  [_vModelText, _ctx.contactsImport.icon]
                                ])
                              ])
                            ]),
                            (_ctx.contactsImport.err)
                              ? (_openBlock(), _createElementBlock("div", _hoisted_560, _toDisplayString(_ctx.contactsImport.err), 1 /* TEXT */))
                              : _createCommentVNode("v-if", true)
                          ], 64 /* STABLE_FRAGMENT */))
                  ]),
                  _createElementVNode("div", _hoisted_561, [
                    _createElementVNode("button", {
                      class: "btn",
                      disabled: _ctx.contactsImport.busy,
                      onClick: _cache[165] || (_cache[165] = $event => (_ctx.modal=null))
                    }, _toDisplayString(_ctx.t('Cancel')), 9 /* TEXT, PROPS */, _hoisted_562),
                    (_ctx.contactsImport.enabled && _ctx.contactsImport.books.length)
                      ? (_openBlock(), _createElementBlock("button", {
                          key: 0,
                          class: "btn primary",
                          disabled: _ctx.contactsImport.busy,
                          onClick: _cache[166] || (_cache[166] = (...args) => (_ctx.commitContactsImport && _ctx.commitContactsImport(...args)))
                        }, _toDisplayString(_ctx.t('Import')), 9 /* TEXT, PROPS */, _hoisted_563))
                      : _createCommentVNode("v-if", true)
                  ])
                ])
              ]))
            : _createCommentVNode("v-if", true),
          _createCommentVNode(" Tables からインポート "),
          (_ctx.modal && _ctx.modal.type==='tablesImport')
            ? (_openBlock(), _createElementBlock("div", {
                key: 12,
                class: "modal-mask",
                onClick: _cache[175] || (_cache[175] = _withModifiers($event => (!_ctx.tablesImport.busy && (_ctx.modal=null)), ["self"]))
              }, [
                _createElementVNode("div", _hoisted_564, [
                  _createElementVNode("div", _hoisted_565, [
                    _createElementVNode("h3", null, _toDisplayString(_ctx.t('📊 Import from Tables')), 1 /* TEXT */),
                    _createElementVNode("button", {
                      class: "icon-btn",
                      disabled: _ctx.tablesImport.busy,
                      onClick: _cache[168] || (_cache[168] = $event => (_ctx.modal=null))
                    }, "✕", 8 /* PROPS */, _hoisted_566)
                  ]),
                  _createElementVNode("div", _hoisted_567, [
                    (_ctx.tablesImport.loading)
                      ? (_openBlock(), _createElementBlock("div", _hoisted_568, [
                          _createElementVNode("p", null, _toDisplayString(_ctx.t('Loading…')), 1 /* TEXT */)
                        ]))
                      : (!_ctx.tablesImport.available)
                        ? (_openBlock(), _createElementBlock("div", _hoisted_569, [
                            _createElementVNode("p", null, _toDisplayString(_ctx.t('The Tables app is not enabled')), 1 /* TEXT */)
                          ]))
                        : (!_ctx.tablesImport.tables.length)
                          ? (_openBlock(), _createElementBlock("div", _hoisted_570, [
                              _createElementVNode("p", null, _toDisplayString(_ctx.t('No tables found')), 1 /* TEXT */)
                            ]))
                          : (_openBlock(), _createElementBlock(_Fragment, { key: 3 }, [
                              _createElementVNode("p", _hoisted_571, _toDisplayString(_ctx.t('Import a table as a new collection. Tables is not modified.')), 1 /* TEXT */),
                              _createElementVNode("div", _hoisted_572, [
                                _createElementVNode("label", null, _toDisplayString(_ctx.t('Source table')), 1 /* TEXT */),
                                _withDirectives(_createElementVNode("select", {
                                  "onUpdate:modelValue": _cache[169] || (_cache[169] = $event => ((_ctx.tablesImport.selected) = $event))
                                }, [
                                  (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.tablesImport.tables, (tb) => {
                                    return (_openBlock(), _createElementBlock("option", {
                                      key: tb.id,
                                      value: tb.id
                                    }, _toDisplayString((tb.emoji ? tb.emoji + ' ' : '') + tb.title) + "（" + _toDisplayString(_ctx.t('{n} columns', {n: tb.columns})) + "）", 9 /* TEXT, PROPS */, _hoisted_573))
                                  }), 128 /* KEYED_FRAGMENT */))
                                ], 512 /* NEED_PATCH */), [
                                  [_vModelSelect, _ctx.tablesImport.selected]
                                ])
                              ]),
                              _createElementVNode("div", _hoisted_574, [
                                _createElementVNode("label", null, _toDisplayString(_ctx.t('Collection name')), 1 /* TEXT */),
                                _withDirectives(_createElementVNode("input", {
                                  "onUpdate:modelValue": _cache[170] || (_cache[170] = $event => ((_ctx.tablesImport.name) = $event)),
                                  placeholder: _ctx.tablesSelectedTitle
                                }, null, 8 /* PROPS */, _hoisted_575), [
                                  [_vModelText, _ctx.tablesImport.name]
                                ])
                              ]),
                              _createElementVNode("div", _hoisted_576, [
                                _createElementVNode("label", null, _toDisplayString(_ctx.t('Icon (emoji)')), 1 /* TEXT */),
                                _createElementVNode("div", _hoisted_577, [
                                  _createElementVNode("button", {
                                    type: "button",
                                    class: _normalizeClass(["iconpick-cur", {open: _ctx.iconPickerOpen && _ctx.iconTarget==='tablesImport'}]),
                                    onClick: _cache[171] || (_cache[171] = _withModifiers($event => (_ctx.openIconPicker('tablesImport')), ["stop"])),
                                    title: _ctx.t('Click to choose an icon')
                                  }, _toDisplayString(_ctx.tablesImport.icon || '📊'), 11 /* TEXT, CLASS, PROPS */, _hoisted_578),
                                  _withDirectives(_createElementVNode("input", {
                                    "onUpdate:modelValue": _cache[172] || (_cache[172] = $event => ((_ctx.tablesImport.icon) = $event)),
                                    maxlength: "16",
                                    placeholder: _ctx.t('Emoji')
                                  }, null, 8 /* PROPS */, _hoisted_579), [
                                    [_vModelText, _ctx.tablesImport.icon]
                                  ])
                                ])
                              ]),
                              (_ctx.tablesImport.err)
                                ? (_openBlock(), _createElementBlock("div", _hoisted_580, _toDisplayString(_ctx.tablesImport.err), 1 /* TEXT */))
                                : _createCommentVNode("v-if", true)
                            ], 64 /* STABLE_FRAGMENT */))
                  ]),
                  _createElementVNode("div", _hoisted_581, [
                    _createElementVNode("button", {
                      class: "btn",
                      disabled: _ctx.tablesImport.busy,
                      onClick: _cache[173] || (_cache[173] = $event => (_ctx.modal=null))
                    }, _toDisplayString(_ctx.t('Cancel')), 9 /* TEXT, PROPS */, _hoisted_582),
                    (_ctx.tablesImport.available && _ctx.tablesImport.tables.length)
                      ? (_openBlock(), _createElementBlock("button", {
                          key: 0,
                          class: "btn primary",
                          disabled: _ctx.tablesImport.busy || !_ctx.tablesImport.selected,
                          onClick: _cache[174] || (_cache[174] = (...args) => (_ctx.commitTablesImport && _ctx.commitTablesImport(...args)))
                        }, _toDisplayString(_ctx.t('Import')), 9 /* TEXT, PROPS */, _hoisted_583))
                      : _createCommentVNode("v-if", true)
                  ])
                ])
              ]))
            : _createCommentVNode("v-if", true),
          _createCommentVNode(" 移動 / 複製 "),
          (_ctx.modal && _ctx.modal.type==='transfer')
            ? (_openBlock(), _createElementBlock("div", {
                key: 13,
                class: "modal-mask",
                onClick: _cache[184] || (_cache[184] = _withModifiers($event => (_ctx.modal=null), ["self"]))
              }, [
                _createElementVNode("div", _hoisted_584, [
                  _createElementVNode("div", _hoisted_585, [
                    _createElementVNode("h3", null, _toDisplayString(_ctx.t('↔ Move / Copy')), 1 /* TEXT */),
                    _createElementVNode("button", {
                      class: "icon-btn",
                      onClick: _cache[176] || (_cache[176] = $event => (_ctx.modal=null))
                    }, "✕")
                  ]),
                  _createElementVNode("div", _hoisted_586, [
                    _createElementVNode("div", _hoisted_587, [
                      _createElementVNode("label", null, _toDisplayString(_ctx.t('Target')), 1 /* TEXT */),
                      _createElementVNode("div", _hoisted_588, _toDisplayString(_ctx.t('{n} records', {n: _ctx.xfer.recordIds.length})), 1 /* TEXT */)
                    ]),
                    _createElementVNode("div", _hoisted_589, [
                      _createElementVNode("label", null, _toDisplayString(_ctx.t('Action')), 1 /* TEXT */),
                      _createElementVNode("div", _hoisted_590, [
                        _createElementVNode("label", null, [
                          _withDirectives(_createElementVNode("input", {
                            type: "radio",
                            value: "copy",
                            "onUpdate:modelValue": _cache[177] || (_cache[177] = $event => ((_ctx.xfer.mode) = $event))
                          }, null, 512 /* NEED_PATCH */), [
                            [_vModelRadio, _ctx.xfer.mode]
                          ]),
                          _createTextVNode(" " + _toDisplayString(_ctx.t('Copy (keep original)')), 1 /* TEXT */)
                        ]),
                        _createElementVNode("label", null, [
                          _withDirectives(_createElementVNode("input", {
                            type: "radio",
                            value: "move",
                            "onUpdate:modelValue": _cache[178] || (_cache[178] = $event => ((_ctx.xfer.mode) = $event))
                          }, null, 512 /* NEED_PATCH */), [
                            [_vModelRadio, _ctx.xfer.mode]
                          ]),
                          _createTextVNode(" " + _toDisplayString(_ctx.t('Move (delete from original)')), 1 /* TEXT */)
                        ])
                      ])
                    ]),
                    _createElementVNode("div", _hoisted_591, [
                      _createElementVNode("label", null, _toDisplayString(_ctx.t('Destination collection')), 1 /* TEXT */),
                      _createElementVNode("select", {
                        value: _ctx.xfer.targetId,
                        onChange: _cache[179] || (_cache[179] = $event => (_ctx.onTransferTarget($event.target.value)))
                      }, [
                        _createElementVNode("option", _hoisted_593, _toDisplayString(_ctx.t('— Select —')), 1 /* TEXT */),
                        _createElementVNode("option", _hoisted_594, _toDisplayString(_ctx.t('＋ Create a new collection…')), 1 /* TEXT */),
                        (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.otherCollections, (c) => {
                          return (_openBlock(), _createElementBlock("option", {
                            key: c.id,
                            value: c.id
                          }, _toDisplayString(c.icon) + " " + _toDisplayString(c.name), 9 /* TEXT, PROPS */, _hoisted_595))
                        }), 128 /* KEYED_FRAGMENT */))
                      ], 40 /* PROPS, NEED_HYDRATION */, _hoisted_592)
                    ]),
                    (_ctx.xfer.targetId==='__newcoll__')
                      ? (_openBlock(), _createElementBlock("div", _hoisted_596, [
                          _createElementVNode("label", null, _toDisplayString(_ctx.t('New collection name')), 1 /* TEXT */),
                          _withDirectives(_createElementVNode("input", {
                            "onUpdate:modelValue": _cache[180] || (_cache[180] = $event => ((_ctx.xfer.newName) = $event)),
                            placeholder: _ctx.t('Collection name')
                          }, null, 8 /* PROPS */, _hoisted_597), [
                            [_vModelText, _ctx.xfer.newName]
                          ]),
                          _createElementVNode("div", _hoisted_598, _toDisplayString(_ctx.newCollDesc()), 1 /* TEXT */)
                        ]))
                      : _createCommentVNode("v-if", true),
                    (_ctx.xfer.target)
                      ? (_openBlock(), _createElementBlock(_Fragment, { key: 1 }, [
                          _createElementVNode("p", _hoisted_599, _toDisplayString(_ctx.t('Field mapping (source → destination). Auto-matched by label. Choose “Add as new field” to create that field in the destination. “Do not import” discards it.')), 1 /* TEXT */),
                          (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.current.fields, (sf) => {
                            return (_openBlock(), _createElementBlock("div", {
                              key: sf.key,
                              class: "map-row"
                            }, [
                              _createElementVNode("span", {
                                class: "map-src",
                                title: sf.label
                              }, [
                                _createElementVNode("span", _hoisted_601, _toDisplayString(sf.label), 1 /* TEXT */),
                                (_ctx.xferSample(sf))
                                  ? (_openBlock(), _createElementBlock("span", _hoisted_602, _toDisplayString(_ctx.xferSample(sf)), 1 /* TEXT */))
                                  : (_openBlock(), _createElementBlock("span", _hoisted_603, _toDisplayString(_ctx.t('(empty)')), 1 /* TEXT */))
                              ], 8 /* PROPS */, _hoisted_600),
                              _hoisted_604,
                              _withDirectives(_createElementVNode("select", {
                                "onUpdate:modelValue": $event => ((_ctx.xfer.mapping[sf.key]) = $event),
                                class: _normalizeClass({isnew: _ctx.xfer.mapping[sf.key]==='__new__'})
                              }, [
                                _createElementVNode("option", _hoisted_606, _toDisplayString(_ctx.t('(do not import)')), 1 /* TEXT */),
                                (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.xfer.target.fields, (tf) => {
                                  return (_openBlock(), _createElementBlock("option", {
                                    key: tf.key,
                                    value: tf.key
                                  }, _toDisplayString(tf.label), 9 /* TEXT, PROPS */, _hoisted_607))
                                }), 128 /* KEYED_FRAGMENT */)),
                                _createElementVNode("option", _hoisted_608, _toDisplayString(_ctx.t('＋ Add as new field ({label})', {label: sf.label})), 1 /* TEXT */)
                              ], 10 /* CLASS, PROPS */, _hoisted_605), [
                                [_vModelSelect, _ctx.xfer.mapping[sf.key]]
                              ])
                            ]))
                          }), 128 /* KEYED_FRAGMENT */)),
                          _createElementVNode("div", _hoisted_609, [
                            _createElementVNode("label", null, _toDisplayString(_ctx.t('Where to keep non-imported fields (prevents data loss, optional)')), 1 /* TEXT */),
                            _withDirectives(_createElementVNode("select", {
                              "onUpdate:modelValue": _cache[181] || (_cache[181] = $event => ((_ctx.xfer.appendTo) = $event))
                            }, [
                              _createElementVNode("option", _hoisted_610, _toDisplayString(_ctx.t('Do not append (discard)')), 1 /* TEXT */),
                              (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.targetTextareas, (tf) => {
                                return (_openBlock(), _createElementBlock("option", {
                                  key: tf.key,
                                  value: tf.key
                                }, _toDisplayString(_ctx.t('Append to “{label}” as “field: value”', {label: tf.label})), 9 /* TEXT, PROPS */, _hoisted_611))
                              }), 128 /* KEYED_FRAGMENT */))
                            ], 512 /* NEED_PATCH */), [
                              [_vModelSelect, _ctx.xfer.appendTo]
                            ])
                          ])
                        ], 64 /* STABLE_FRAGMENT */))
                      : _createCommentVNode("v-if", true)
                  ]),
                  _createElementVNode("div", _hoisted_612, [
                    _createElementVNode("button", {
                      class: "btn",
                      onClick: _cache[182] || (_cache[182] = $event => (_ctx.modal=null))
                    }, _toDisplayString(_ctx.t('Cancel')), 1 /* TEXT */),
                    _createElementVNode("button", {
                      class: "btn primary",
                      disabled: _ctx.xfer.busy || !(_ctx.xfer.target || (_ctx.xfer.targetId==='__newcoll__' && _ctx.xfer.newName && _ctx.xfer.newName.trim())),
                      onClick: _cache[183] || (_cache[183] = (...args) => (_ctx.commitTransfer && _ctx.commitTransfer(...args)))
                    }, _toDisplayString(_ctx.transferLabel()), 9 /* TEXT, PROPS */, _hoisted_613)
                  ])
                ])
              ]))
            : _createCommentVNode("v-if", true),
          _createCommentVNode(" 保存先設定 "),
          (_ctx.modal && _ctx.modal.type==='settings')
            ? (_openBlock(), _createElementBlock("div", {
                key: 14,
                class: "modal-mask",
                onClick: _cache[203] || (_cache[203] = _withModifiers($event => (_ctx.modal=null), ["self"]))
              }, [
                _createElementVNode("div", _hoisted_614, [
                  _createElementVNode("div", _hoisted_615, [
                    _createElementVNode("h3", null, _toDisplayString(_ctx.t('⚙️ Settings')), 1 /* TEXT */),
                    _createElementVNode("button", {
                      class: "icon-btn",
                      onClick: _cache[185] || (_cache[185] = $event => (_ctx.modal=null))
                    }, "✕")
                  ]),
                  _createElementVNode("div", _hoisted_616, [
                    _createElementVNode("div", _hoisted_617, [
                      _createElementVNode("label", null, "🌗 " + _toDisplayString(_ctx.t('Theme')), 1 /* TEXT */),
                      _createElementVNode("div", _hoisted_618, [
                        _createElementVNode("label", null, [
                          _withDirectives(_createElementVNode("input", {
                            type: "radio",
                            value: "auto",
                            "onUpdate:modelValue": _cache[186] || (_cache[186] = $event => ((_ctx.settingsForm.theme) = $event)),
                            onChange: _cache[187] || (_cache[187] = (...args) => (_ctx.previewTheme && _ctx.previewTheme(...args)))
                          }, null, 544 /* NEED_HYDRATION, NEED_PATCH */), [
                            [_vModelRadio, _ctx.settingsForm.theme]
                          ]),
                          _createTextVNode(" " + _toDisplayString(_ctx.t('Default (match Nextcloud)')), 1 /* TEXT */)
                        ]),
                        _createElementVNode("label", null, [
                          _withDirectives(_createElementVNode("input", {
                            type: "radio",
                            value: "light",
                            "onUpdate:modelValue": _cache[188] || (_cache[188] = $event => ((_ctx.settingsForm.theme) = $event)),
                            onChange: _cache[189] || (_cache[189] = (...args) => (_ctx.previewTheme && _ctx.previewTheme(...args)))
                          }, null, 544 /* NEED_HYDRATION, NEED_PATCH */), [
                            [_vModelRadio, _ctx.settingsForm.theme]
                          ]),
                          _createTextVNode(" " + _toDisplayString(_ctx.t('Light')), 1 /* TEXT */)
                        ]),
                        _createElementVNode("label", null, [
                          _withDirectives(_createElementVNode("input", {
                            type: "radio",
                            value: "dark",
                            "onUpdate:modelValue": _cache[190] || (_cache[190] = $event => ((_ctx.settingsForm.theme) = $event)),
                            onChange: _cache[191] || (_cache[191] = (...args) => (_ctx.previewTheme && _ctx.previewTheme(...args)))
                          }, null, 544 /* NEED_HYDRATION, NEED_PATCH */), [
                            [_vModelRadio, _ctx.settingsForm.theme]
                          ]),
                          _createTextVNode(" " + _toDisplayString(_ctx.t('Dark')), 1 /* TEXT */)
                        ])
                      ])
                    ]),
                    _createElementVNode("div", _hoisted_619, [
                      _createElementVNode("label", null, "🌐 " + _toDisplayString(_ctx.t('Language')), 1 /* TEXT */),
                      _withDirectives(_createElementVNode("select", {
                        "onUpdate:modelValue": _cache[192] || (_cache[192] = $event => ((_ctx.settingsForm.language) = $event))
                      }, [
                        _createElementVNode("option", _hoisted_620, _toDisplayString(_ctx.t('System default (match Nextcloud)')), 1 /* TEXT */),
                        (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.languages, (lg) => {
                          return (_openBlock(), _createElementBlock("option", {
                            key: lg.code,
                            value: lg.code
                          }, _toDisplayString(lg.name), 9 /* TEXT, PROPS */, _hoisted_621))
                        }), 128 /* KEYED_FRAGMENT */))
                      ], 512 /* NEED_PATCH */), [
                        [_vModelSelect, _ctx.settingsForm.language]
                      ]),
                      _createElementVNode("div", _hoisted_622, _toDisplayString(_ctx.t('The display language switches when you press “Save”.')), 1 /* TEXT */)
                    ]),
                    _createElementVNode("div", _hoisted_623, [
                      _createElementVNode("label", null, "📁 " + _toDisplayString(_ctx.t('Base folder for attachments')), 1 /* TEXT */),
                      _createElementVNode("div", _hoisted_624, [
                        _withDirectives(_createElementVNode("input", {
                          "onUpdate:modelValue": _cache[193] || (_cache[193] = $event => ((_ctx.settingsForm.files_folder) = $event)),
                          placeholder: _ctx.t('e.g. RegiBase'),
                          spellcheck: "false",
                          autocorrect: "off",
                          autocapitalize: "off",
                          style: {"flex":"1","min-width":"0"}
                        }, null, 8 /* PROPS */, _hoisted_625), [
                          [_vModelText, _ctx.settingsForm.files_folder]
                        ]),
                        _createElementVNode("button", {
                          type: "button",
                          class: "btn sm",
                          onClick: _cache[194] || (_cache[194] = $event => (_ctx.openFolderPicker('settings')))
                        }, "📁 " + _toDisplayString(_ctx.t('Browse…')), 1 /* TEXT */)
                      ]),
                      _createElementVNode("div", _hoisted_626, _toDisplayString(_ctx.t('The default parent folder (under Files) for new collections’ attachments; each new collection saves into “this folder / collection name”. Default: RegiBase.')), 1 /* TEXT */)
                    ]),
                    _createElementVNode("div", _hoisted_627, [
                      _createElementVNode("label", null, _toDisplayString(_ctx.t('🔒 Encryption (secret fields) — optional')), 1 /* TEXT */),
                      (_ctx.enc.enabled)
                        ? (_openBlock(), _createElementBlock("div", _hoisted_628, [
                            _createElementVNode("b", _hoisted_629, _toDisplayString(_ctx.t('Enabled')), 1 /* TEXT */),
                            _createTextVNode(_toDisplayString(_ctx.t(': Secret fields such as passwords are encrypted with the master key you entered on this device.')), 1 /* TEXT */),
                            (_ctx.hasRemembered())
                              ? (_openBlock(), _createElementBlock("span", _hoisted_630, _toDisplayString(_ctx.t('(remembered on this device)')), 1 /* TEXT */))
                              : _createCommentVNode("v-if", true),
                            _createElementVNode("div", _hoisted_631, [
                              _createElementVNode("div", _hoisted_632, [
                                _createElementVNode("button", {
                                  type: "button",
                                  class: "btn sm",
                                  style: {"min-width":"190px"},
                                  onClick: _cache[195] || (_cache[195] = (...args) => (_ctx.openEncChange && _ctx.openEncChange(...args)))
                                }, _toDisplayString(_ctx.t('Set master key')), 1 /* TEXT */),
                                _createElementVNode("span", _hoisted_633, _toDisplayString(_ctx.t('Sets or changes the master key and re-encrypts all secret fields.')), 1 /* TEXT */)
                              ]),
                              _createElementVNode("div", _hoisted_634, [
                                _createElementVNode("button", {
                                  type: "button",
                                  class: "btn sm danger",
                                  style: {"min-width":"190px"},
                                  onClick: _cache[196] || (_cache[196] = (...args) => (_ctx.openEncRemove && _ctx.openEncRemove(...args)))
                                }, _toDisplayString(_ctx.t('Remove master key')), 1 /* TEXT */),
                                _createElementVNode("span", _hoisted_635, _toDisplayString(_ctx.t('Decrypts all secret fields back to plain text and turns off encryption.')), 1 /* TEXT */)
                              ]),
                              _createElementVNode("div", _hoisted_636, [
                                _createElementVNode("button", {
                                  type: "button",
                                  class: "btn sm",
                                  style: {"min-width":"190px"},
                                  onClick: _cache[197] || (_cache[197] = (...args) => (_ctx.lockNow && _ctx.lockNow(...args)))
                                }, _toDisplayString(_ctx.t('Sign out')), 1 /* TEXT */),
                                _createElementVNode("span", _hoisted_637, _toDisplayString(_ctx.t('Forgets the master key on this device (locks secret fields).')), 1 /* TEXT */)
                              ])
                            ])
                          ]))
                        : (_openBlock(), _createElementBlock("div", _hoisted_638, [
                            _createElementVNode("b", null, _toDisplayString(_ctx.t('Disabled (default)')), 1 /* TEXT */),
                            _createTextVNode(_toDisplayString(_ctx.t(': Secret fields are stored in plain text. If you enable it, secret fields are encrypted with your master key and become unreadable even to the server and the administrator.')) + " ", 1 /* TEXT */),
                            _createElementVNode("div", _hoisted_639, [
                              _createElementVNode("button", {
                                type: "button",
                                class: "btn sm primary",
                                onClick: _cache[198] || (_cache[198] = (...args) => (_ctx.openEncSetup && _ctx.openEncSetup(...args)))
                              }, _toDisplayString(_ctx.t('Set master key')), 1 /* TEXT */)
                            ])
                          ]))
                    ]),
                    _createElementVNode("div", _hoisted_640, [
                      _createElementVNode("label", null, "💾 " + _toDisplayString(_ctx.t('Backup / Restore')), 1 /* TEXT */),
                      _createElementVNode("div", _hoisted_641, _toDisplayString(_ctx.t('Save all collections, records, settings and attachments to a ZIP encrypted with your login password.')), 1 /* TEXT */),
                      _createElementVNode("div", _hoisted_642, [
                        _createElementVNode("button", {
                          type: "button",
                          class: "btn sm",
                          onClick: _cache[199] || (_cache[199] = (...args) => (_ctx.openBackup && _ctx.openBackup(...args)))
                        }, _toDisplayString(_ctx.t('🔒 Download all data')), 1 /* TEXT */),
                        _createElementVNode("button", {
                          type: "button",
                          class: "btn sm",
                          onClick: _cache[200] || (_cache[200] = (...args) => (_ctx.openRestore && _ctx.openRestore(...args)))
                        }, _toDisplayString(_ctx.t('♻ Restore from backup')), 1 /* TEXT */)
                      ])
                    ])
                  ]),
                  _createElementVNode("div", _hoisted_643, [
                    _createElementVNode("button", {
                      class: "btn",
                      onClick: _cache[201] || (_cache[201] = $event => (_ctx.modal=null))
                    }, _toDisplayString(_ctx.t('Cancel')), 1 /* TEXT */),
                    _createElementVNode("button", {
                      class: "btn primary",
                      onClick: _cache[202] || (_cache[202] = (...args) => (_ctx.saveSettings && _ctx.saveSettings(...args)))
                    }, _toDisplayString(_ctx.t('Save')), 1 /* TEXT */)
                  ])
                ])
              ]))
            : _createCommentVNode("v-if", true),
          _createCommentVNode(" 作成時：保存フォルダ名が他コレクションと衝突（そのまま使う／連番を付ける） "),
          (_ctx.modal && _ctx.modal.type==='folderConflict')
            ? (_openBlock(), _createElementBlock("div", {
                key: 15,
                class: "modal-mask",
                onClick: _cache[208] || (_cache[208] = _withModifiers($event => (_ctx.cancelFolderConflict()), ["self"]))
              }, [
                _createElementVNode("div", _hoisted_644, [
                  _createElementVNode("div", _hoisted_645, [
                    _createElementVNode("h3", null, "📁 " + _toDisplayString(_ctx.t('Folder name already in use')), 1 /* TEXT */),
                    _createElementVNode("button", {
                      class: "icon-btn",
                      onClick: _cache[204] || (_cache[204] = $event => (_ctx.cancelFolderConflict()))
                    }, "✕")
                  ]),
                  _createElementVNode("div", _hoisted_646, [
                    _createElementVNode("p", _hoisted_647, _toDisplayString(_ctx.t('Another collection already uses a folder with this name. Use the same folder? Choosing No creates it with a number added.')), 1 /* TEXT */),
                    (_ctx.pendingCreate)
                      ? (_openBlock(), _createElementBlock("p", _hoisted_648, "📁 " + _toDisplayString(_ctx.pendingCreate.folder), 1 /* TEXT */))
                      : _createCommentVNode("v-if", true)
                  ]),
                  _createElementVNode("div", _hoisted_649, [
                    _createElementVNode("button", {
                      class: "btn",
                      disabled: _ctx.busy,
                      onClick: _cache[205] || (_cache[205] = $event => (_ctx.cancelFolderConflict()))
                    }, _toDisplayString(_ctx.t('Cancel')), 9 /* TEXT, PROPS */, _hoisted_650),
                    _createElementVNode("button", {
                      class: "btn",
                      disabled: _ctx.busy,
                      onClick: _cache[206] || (_cache[206] = $event => (_ctx.resolveFolderConflict(false)))
                    }, _toDisplayString(_ctx.t('No')), 9 /* TEXT, PROPS */, _hoisted_651),
                    _createElementVNode("button", {
                      class: "btn primary",
                      disabled: _ctx.busy,
                      onClick: _cache[207] || (_cache[207] = $event => (_ctx.resolveFolderConflict(true)))
                    }, _toDisplayString(_ctx.t('Yes')), 9 /* TEXT, PROPS */, _hoisted_652)
                  ])
                ])
              ]))
            : _createCommentVNode("v-if", true),
          _createCommentVNode(" コレクション削除の確認（保存フォルダも消すか尋ねる／既定は消さない） "),
          (_ctx.modal && _ctx.modal.type==='delColl' && _ctx.current)
            ? (_openBlock(), _createElementBlock("div", {
                key: 16,
                class: "modal-mask",
                onClick: _cache[213] || (_cache[213] = _withModifiers($event => (!_ctx.modal.busy && (_ctx.modal=null)), ["self"]))
              }, [
                _createElementVNode("div", _hoisted_653, [
                  _createElementVNode("div", _hoisted_654, [
                    _createElementVNode("h3", null, "🗑 " + _toDisplayString(_ctx.t('Delete collection')), 1 /* TEXT */),
                    _createElementVNode("button", {
                      class: "icon-btn",
                      disabled: _ctx.modal.busy,
                      onClick: _cache[209] || (_cache[209] = $event => (_ctx.modal=null))
                    }, "✕", 8 /* PROPS */, _hoisted_655)
                  ]),
                  _createElementVNode("div", _hoisted_656, [
                    _createElementVNode("p", _hoisted_657, _toDisplayString(_ctx.t('Delete the collection “{name}” and all its records. Are you sure?', { name: _ctx.current.name })), 1 /* TEXT */),
                    (_ctx.current.files_folder)
                      ? (_openBlock(), _createElementBlock(_Fragment, { key: 0 }, [
                          (!_ctx.current.folder_shared)
                            ? (_openBlock(), _createElementBlock("label", _hoisted_658, [
                                _withDirectives(_createElementVNode("input", {
                                  type: "checkbox",
                                  "onUpdate:modelValue": _cache[210] || (_cache[210] = $event => ((_ctx.modal.deleteFolder) = $event))
                                }, null, 512 /* NEED_PATCH */), [
                                  [_vModelCheckbox, _ctx.modal.deleteFolder]
                                ]),
                                _createElementVNode("span", null, [
                                  _createTextVNode(_toDisplayString(_ctx.t('Also delete this collection’s save folder')), 1 /* TEXT */),
                                  _hoisted_659,
                                  _createElementVNode("span", _hoisted_660, "📁 " + _toDisplayString(_ctx.current.files_folder), 1 /* TEXT */)
                                ])
                              ]))
                            : (_openBlock(), _createElementBlock("p", _hoisted_661, [
                                _createTextVNode("📁 " + _toDisplayString(_ctx.current.files_folder), 1 /* TEXT */),
                                _hoisted_662,
                                _createTextVNode(_toDisplayString(_ctx.t('The save folder is used by another collection, so it is not deleted. Delete it manually if you need to.')), 1 /* TEXT */)
                              ]))
                        ], 64 /* STABLE_FRAGMENT */))
                      : _createCommentVNode("v-if", true),
                    (_ctx.modal.deleteFolder && _ctx.modal.folderHasData)
                      ? (_openBlock(), _createElementBlock("p", _hoisted_663, _toDisplayString(_ctx.t('The saved data will be moved to the trash.')), 1 /* TEXT */))
                      : _createCommentVNode("v-if", true)
                  ]),
                  _createElementVNode("div", _hoisted_664, [
                    _createElementVNode("button", {
                      class: "btn",
                      disabled: _ctx.modal.busy,
                      onClick: _cache[211] || (_cache[211] = $event => (_ctx.modal=null))
                    }, _toDisplayString(_ctx.t('Cancel')), 9 /* TEXT, PROPS */, _hoisted_665),
                    _createElementVNode("button", {
                      class: "btn danger",
                      disabled: _ctx.modal.busy,
                      onClick: _cache[212] || (_cache[212] = (...args) => (_ctx.doDeleteCollection && _ctx.doDeleteCollection(...args)))
                    }, _toDisplayString(_ctx.t('Delete')), 9 /* TEXT, PROPS */, _hoisted_666)
                  ])
                ])
              ]))
            : _createCommentVNode("v-if", true),
          _createCommentVNode(" スナップショット（コレクション単位の変更履歴） "),
          (_ctx.modal && _ctx.modal.type==='history')
            ? (_openBlock(), _createElementBlock("div", {
                key: 17,
                class: "modal-mask",
                onClick: _cache[217] || (_cache[217] = _withModifiers($event => (_ctx.modal=null), ["self"]))
              }, [
                _createElementVNode("div", _hoisted_667, [
                  _createElementVNode("div", _hoisted_668, [
                    _createElementVNode("h3", null, [
                      _createTextVNode("🕐 " + _toDisplayString(_ctx.t('Snapshots')), 1 /* TEXT */),
                      (_ctx.current)
                        ? (_openBlock(), _createElementBlock("span", _hoisted_669, " — " + _toDisplayString(_ctx.current.icon) + " " + _toDisplayString(_ctx.current.name), 1 /* TEXT */))
                        : _createCommentVNode("v-if", true)
                    ]),
                    _createElementVNode("button", {
                      class: "icon-btn",
                      onClick: _cache[214] || (_cache[214] = $event => (_ctx.modal=null))
                    }, "✕")
                  ]),
                  _createElementVNode("div", _hoisted_670, [
                    _createElementVNode("div", _hoisted_671, [
                      _createElementVNode("button", {
                        class: "btn sm",
                        disabled: !_ctx.undoTop || _ctx.busy,
                        onClick: _cache[215] || (_cache[215] = (...args) => (_ctx.doUndo && _ctx.doUndo(...args)))
                      }, "↶ " + _toDisplayString(_ctx.t('Undo last change')), 9 /* TEXT, PROPS */, _hoisted_672),
                      _hoisted_673,
                      (_ctx.history.length)
                        ? (_openBlock(), _createElementBlock("button", {
                            key: 0,
                            class: "btn sm danger",
                            onClick: _cache[216] || (_cache[216] = (...args) => (_ctx.clearHistoryConfirm && _ctx.clearHistoryConfirm(...args)))
                          }, _toDisplayString(_ctx.t('Clear snapshots')), 1 /* TEXT */))
                        : _createCommentVNode("v-if", true)
                    ]),
                    _createElementVNode("div", _hoisted_674, _toDisplayString(_ctx.t('Newest first. “Restore to here” undoes that change and every change above it.')), 1 /* TEXT */),
                    (!_ctx.history.length)
                      ? (_openBlock(), _createElementBlock("div", _hoisted_675, [
                          _createElementVNode("p", null, _toDisplayString(_ctx.t('No snapshots recorded yet.')), 1 /* TEXT */)
                        ]))
                      : (_openBlock(), _createElementBlock("div", _hoisted_676, [
                          (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.history, (h) => {
                            return (_openBlock(), _createElementBlock("div", {
                              key: h.id,
                              class: _normalizeClass(["hist-row", {done: h.undone}]),
                              title: _ctx.snapDetail(h)
                            }, [
                              _createElementVNode("span", _hoisted_678, _toDisplayString(_ctx.snapIcon(h.op)), 1 /* TEXT */),
                              _createElementVNode("span", _hoisted_679, _toDisplayString(_ctx.fmtHistTime(h.created_at)), 1 /* TEXT */),
                              _createElementVNode("span", _hoisted_680, _toDisplayString(h.summary), 1 /* TEXT */),
                              (h.undone)
                                ? (_openBlock(), _createElementBlock("span", _hoisted_681, _toDisplayString(_ctx.t('undone')), 1 /* TEXT */))
                                : (_openBlock(), _createElementBlock("button", {
                                    key: 1,
                                    class: "btn xs",
                                    disabled: _ctx.busy,
                                    onClick: $event => (_ctx.restoreTo(h)),
                                    title: _ctx.t('Undo this change and everything newer')
                                  }, "↶ " + _toDisplayString(_ctx.t('Restore to here')), 9 /* TEXT, PROPS */, _hoisted_682))
                            ], 10 /* CLASS, PROPS */, _hoisted_677))
                          }), 128 /* KEYED_FRAGMENT */))
                        ]))
                  ])
                ])
              ]))
            : _createCommentVNode("v-if", true),
          _createCommentVNode(" 全データのバックアップ "),
          (_ctx.modal && _ctx.modal.type==='backup')
            ? (_openBlock(), _createElementBlock("div", {
                key: 18,
                class: "modal-mask",
                onClick: _cache[223] || (_cache[223] = _withModifiers($event => (!_ctx.backupForm.busy && (_ctx.modal=null)), ["self"]))
              }, [
                _createElementVNode("div", _hoisted_683, [
                  _createElementVNode("div", _hoisted_684, [
                    _createElementVNode("h3", null, _toDisplayString(_ctx.t('🔒 Download all data')), 1 /* TEXT */),
                    _createElementVNode("button", {
                      class: "icon-btn",
                      disabled: _ctx.backupForm.busy,
                      onClick: _cache[218] || (_cache[218] = $event => (_ctx.modal=null))
                    }, "✕", 8 /* PROPS */, _hoisted_685)
                  ]),
                  _createElementVNode("form", {
                    class: "modal-body",
                    onSubmit: _cache[220] || (_cache[220] = _withModifiers((...args) => (_ctx.doBackup && _ctx.doBackup(...args)), ["prevent"]))
                  }, [
                    _createElementVNode("p", _hoisted_686, _toDisplayString(_ctx.t('Enter your login password. The archive (ZIP) is encrypted with the same password.')), 1 /* TEXT */),
                    _createElementVNode("div", _hoisted_687, [
                      _createElementVNode("label", null, _toDisplayString(_ctx.t('Login password')), 1 /* TEXT */),
                      _withDirectives(_createElementVNode("input", {
                        type: "password",
                        "onUpdate:modelValue": _cache[219] || (_cache[219] = $event => ((_ctx.backupForm.password) = $event)),
                        autocomplete: "current-password",
                        autofocus: ""
                      }, null, 512 /* NEED_PATCH */), [
                        [_vModelText, _ctx.backupForm.password]
                      ])
                    ]),
                    (_ctx.backupForm.err)
                      ? (_openBlock(), _createElementBlock("div", _hoisted_688, _toDisplayString(_ctx.backupForm.err), 1 /* TEXT */))
                      : _createCommentVNode("v-if", true),
                    (_ctx.backupForm.busy)
                      ? (_openBlock(), _createElementBlock("div", _hoisted_689, _toDisplayString(_ctx.t('Creating…')), 1 /* TEXT */))
                      : _createCommentVNode("v-if", true)
                  ], 32 /* NEED_HYDRATION */),
                  _createElementVNode("div", _hoisted_690, [
                    _createElementVNode("button", {
                      class: "btn",
                      disabled: _ctx.backupForm.busy,
                      onClick: _cache[221] || (_cache[221] = $event => (_ctx.modal=null))
                    }, _toDisplayString(_ctx.t('Cancel')), 9 /* TEXT, PROPS */, _hoisted_691),
                    _createElementVNode("button", {
                      class: "btn primary",
                      disabled: _ctx.backupForm.busy,
                      onClick: _cache[222] || (_cache[222] = (...args) => (_ctx.doBackup && _ctx.doBackup(...args)))
                    }, _toDisplayString(_ctx.t('Download')), 9 /* TEXT, PROPS */, _hoisted_692)
                  ])
                ])
              ]))
            : _createCommentVNode("v-if", true),
          _createCommentVNode(" バックアップから復元 "),
          (_ctx.modal && _ctx.modal.type==='restore')
            ? (_openBlock(), _createElementBlock("div", {
                key: 19,
                class: "modal-mask",
                onClick: _cache[233] || (_cache[233] = _withModifiers($event => (!_ctx.restoreForm.busy && (_ctx.modal=null)), ["self"]))
              }, [
                _createElementVNode("div", _hoisted_693, [
                  _createElementVNode("div", _hoisted_694, [
                    _createElementVNode("h3", null, _toDisplayString(_ctx.t('♻ Restore from backup')), 1 /* TEXT */),
                    _createElementVNode("button", {
                      class: "icon-btn",
                      disabled: _ctx.restoreForm.busy,
                      onClick: _cache[224] || (_cache[224] = $event => (_ctx.modal=null))
                    }, "✕", 8 /* PROPS */, _hoisted_695)
                  ]),
                  _createElementVNode("div", _hoisted_696, [
                    _createElementVNode("label", _hoisted_697, [
                      _createElementVNode("input", {
                        type: "file",
                        accept: ".zip",
                        onChange: _cache[225] || (_cache[225] = (...args) => (_ctx.onRestoreFile && _ctx.onRestoreFile(...args)))
                      }, null, 32 /* NEED_HYDRATION */),
                      _createElementVNode("span", _hoisted_698, _toDisplayString(_ctx.t('📄 Choose file')), 1 /* TEXT */),
                      _createElementVNode("span", _hoisted_699, _toDisplayString(_ctx.restoreForm.fileName || _ctx.t('Backup file (.zip)')), 1 /* TEXT */)
                    ]),
                    _createElementVNode("div", _hoisted_700, [
                      _createElementVNode("label", null, _toDisplayString(_ctx.t('Login password')), 1 /* TEXT */),
                      _withDirectives(_createElementVNode("input", {
                        type: "password",
                        "onUpdate:modelValue": _cache[226] || (_cache[226] = $event => ((_ctx.restoreForm.password) = $event)),
                        autocomplete: "current-password"
                      }, null, 512 /* NEED_PATCH */), [
                        [_vModelText, _ctx.restoreForm.password]
                      ])
                    ]),
                    _createElementVNode("div", _hoisted_701, [
                      _createElementVNode("label", null, _toDisplayString(_ctx.t('Restore method')), 1 /* TEXT */),
                      _createElementVNode("div", _hoisted_702, [
                        _createElementVNode("label", null, [
                          _withDirectives(_createElementVNode("input", {
                            type: "radio",
                            value: "overwrite",
                            "onUpdate:modelValue": _cache[227] || (_cache[227] = $event => ((_ctx.restoreForm.mode) = $event))
                          }, null, 512 /* NEED_PATCH */), [
                            [_vModelRadio, _ctx.restoreForm.mode]
                          ]),
                          _createTextVNode(" " + _toDisplayString(_ctx.t('Overwrite (delete and replace existing data)')), 1 /* TEXT */)
                        ]),
                        _createElementVNode("label", null, [
                          _withDirectives(_createElementVNode("input", {
                            type: "radio",
                            value: "merge",
                            "onUpdate:modelValue": _cache[228] || (_cache[228] = $event => ((_ctx.restoreForm.mode) = $event))
                          }, null, 512 /* NEED_PATCH */), [
                            [_vModelRadio, _ctx.restoreForm.mode]
                          ]),
                          _createTextVNode(" " + _toDisplayString(_ctx.t('Merge (import only non-duplicate records)')), 1 /* TEXT */)
                        ]),
                        _createElementVNode("label", null, [
                          _withDirectives(_createElementVNode("input", {
                            type: "radio",
                            value: "add",
                            "onUpdate:modelValue": _cache[229] || (_cache[229] = $event => ((_ctx.restoreForm.mode) = $event))
                          }, null, 512 /* NEED_PATCH */), [
                            [_vModelRadio, _ctx.restoreForm.mode]
                          ]),
                          _createTextVNode(" " + _toDisplayString(_ctx.t('Add (as new collections)')), 1 /* TEXT */)
                        ])
                      ])
                    ]),
                    (_ctx.restoreForm.mode==='overwrite')
                      ? (_openBlock(), _createElementBlock(_Fragment, { key: 0 }, [
                          _createElementVNode("p", _hoisted_703, _toDisplayString(_ctx.t('⚠️ Overwriting replaces ALL existing data (collections, records, settings).')), 1 /* TEXT */),
                          _createElementVNode("label", _hoisted_704, [
                            _withDirectives(_createElementVNode("input", {
                              type: "checkbox",
                              "onUpdate:modelValue": _cache[230] || (_cache[230] = $event => ((_ctx.restoreForm.confirm) = $event))
                            }, null, 512 /* NEED_PATCH */), [
                              [_vModelCheckbox, _ctx.restoreForm.confirm]
                            ]),
                            _createTextVNode(" " + _toDisplayString(_ctx.t('I understand the above and confirm the restore')), 1 /* TEXT */)
                          ])
                        ], 64 /* STABLE_FRAGMENT */))
                      : _createCommentVNode("v-if", true),
                    (_ctx.restoreForm.err)
                      ? (_openBlock(), _createElementBlock("div", _hoisted_705, _toDisplayString(_ctx.restoreForm.err), 1 /* TEXT */))
                      : _createCommentVNode("v-if", true),
                    (_ctx.restoreForm.busy)
                      ? (_openBlock(), _createElementBlock("div", _hoisted_706, _toDisplayString(_ctx.t('Restoring…')), 1 /* TEXT */))
                      : _createCommentVNode("v-if", true)
                  ]),
                  _createElementVNode("div", _hoisted_707, [
                    _createElementVNode("button", {
                      class: "btn",
                      disabled: _ctx.restoreForm.busy,
                      onClick: _cache[231] || (_cache[231] = $event => (_ctx.modal=null))
                    }, _toDisplayString(_ctx.t('Cancel')), 9 /* TEXT, PROPS */, _hoisted_708),
                    _createElementVNode("button", {
                      class: _normalizeClass(["btn", _ctx.restoreForm.mode==='overwrite' ? 'danger' : 'primary']),
                      disabled: _ctx.restoreForm.busy || (_ctx.restoreForm.mode==='overwrite' && !_ctx.restoreForm.confirm),
                      onClick: _cache[232] || (_cache[232] = (...args) => (_ctx.doRestore && _ctx.doRestore(...args)))
                    }, _toDisplayString(_ctx.t('Restore')), 11 /* TEXT, CLASS, PROPS */, _hoisted_709)
                  ])
                ])
              ]))
            : _createCommentVNode("v-if", true),
          _createCommentVNode(" 暗号化を有効にする "),
          (_ctx.modal && _ctx.modal.type==='encSetup')
            ? (_openBlock(), _createElementBlock("div", {
                key: 20,
                class: "modal-mask",
                onClick: _cache[240] || (_cache[240] = _withModifiers($event => (!_ctx.encForm.busy && (_ctx.modal=null)), ["self"]))
              }, [
                _createElementVNode("div", _hoisted_710, [
                  _createElementVNode("div", _hoisted_711, [
                    _createElementVNode("h3", null, _toDisplayString(_ctx.t('🔒 Enable encryption')), 1 /* TEXT */),
                    _createElementVNode("button", {
                      class: "icon-btn",
                      disabled: _ctx.encForm.busy,
                      onClick: _cache[234] || (_cache[234] = $event => (_ctx.modal=null))
                    }, "✕", 8 /* PROPS */, _hoisted_712)
                  ]),
                  _createElementVNode("div", _hoisted_713, [
                    _createElementVNode("p", _hoisted_714, [
                      _createTextVNode(_toDisplayString(_ctx.t('Secret fields (passwords, PINs, card numbers, etc.) are encrypted with the ')), 1 /* TEXT */),
                      _createElementVNode("b", null, _toDisplayString(_ctx.t('Master key')), 1 /* TEXT */),
                      _createTextVNode(_toDisplayString(_ctx.t(' you enter on this device. The master key is never given to the server or the administrator. Names, URLs, etc. are not encrypted (for search and sorting).')), 1 /* TEXT */)
                    ]),
                    _createElementVNode("p", _hoisted_715, [
                      _createTextVNode("⚠️ " + _toDisplayString(_ctx.t('If you forget the master key, your encrypted secret fields ')), 1 /* TEXT */),
                      _createElementVNode("b", null, _toDisplayString(_ctx.t('can never be recovered')), 1 /* TEXT */),
                      _createTextVNode(_toDisplayString(_ctx.t('. Be sure to keep it somewhere safe.')), 1 /* TEXT */)
                    ]),
                    _createElementVNode("div", _hoisted_716, [
                      _createElementVNode("label", null, _toDisplayString(_ctx.t('Master key (6+ characters)')), 1 /* TEXT */),
                      _withDirectives(_createElementVNode("input", {
                        type: "password",
                        "onUpdate:modelValue": _cache[235] || (_cache[235] = $event => ((_ctx.encForm.next) = $event)),
                        autocomplete: "new-password"
                      }, null, 512 /* NEED_PATCH */), [
                        [_vModelText, _ctx.encForm.next]
                      ])
                    ]),
                    _createElementVNode("div", _hoisted_717, [
                      _createElementVNode("label", null, _toDisplayString(_ctx.t('Enter it again to confirm')), 1 /* TEXT */),
                      _withDirectives(_createElementVNode("input", {
                        type: "password",
                        "onUpdate:modelValue": _cache[236] || (_cache[236] = $event => ((_ctx.encForm.next2) = $event)),
                        autocomplete: "new-password"
                      }, null, 512 /* NEED_PATCH */), [
                        [_vModelText, _ctx.encForm.next2]
                      ])
                    ]),
                    _createElementVNode("label", _hoisted_718, [
                      _withDirectives(_createElementVNode("input", {
                        type: "checkbox",
                        "onUpdate:modelValue": _cache[237] || (_cache[237] = $event => ((_ctx.encForm.remember) = $event))
                      }, null, 512 /* NEED_PATCH */), [
                        [_vModelCheckbox, _ctx.encForm.remember]
                      ]),
                      _createTextVNode(" " + _toDisplayString(_ctx.t('Remember on this device (no re-entry until logout)')), 1 /* TEXT */)
                    ]),
                    (_ctx.encForm.err)
                      ? (_openBlock(), _createElementBlock("div", _hoisted_719, _toDisplayString(_ctx.encForm.err), 1 /* TEXT */))
                      : _createCommentVNode("v-if", true),
                    (_ctx.encForm.busy)
                      ? (_openBlock(), _createElementBlock("div", _hoisted_720, _toDisplayString(_ctx.t('Encrypting…')) + " " + _toDisplayString(_ctx.encForm.progress) + _toDisplayString(_ctx.t('(please do not close the page)')), 1 /* TEXT */))
                      : _createCommentVNode("v-if", true)
                  ]),
                  _createElementVNode("div", _hoisted_721, [
                    _createElementVNode("button", {
                      class: "btn",
                      disabled: _ctx.encForm.busy,
                      onClick: _cache[238] || (_cache[238] = $event => (_ctx.modal=null))
                    }, _toDisplayString(_ctx.t('Cancel')), 9 /* TEXT, PROPS */, _hoisted_722),
                    _createElementVNode("button", {
                      class: "btn primary",
                      disabled: _ctx.encForm.busy,
                      onClick: _cache[239] || (_cache[239] = (...args) => (_ctx.enableEncryption && _ctx.enableEncryption(...args)))
                    }, _toDisplayString(_ctx.t('Enable and encrypt')), 9 /* TEXT, PROPS */, _hoisted_723)
                  ])
                ])
              ]))
            : _createCommentVNode("v-if", true),
          _createCommentVNode(" マスターキー変更 "),
          (_ctx.modal && _ctx.modal.type==='encChange')
            ? (_openBlock(), _createElementBlock("div", {
                key: 21,
                class: "modal-mask",
                onClick: _cache[247] || (_cache[247] = _withModifiers($event => (!_ctx.encForm.busy && (_ctx.modal=null)), ["self"]))
              }, [
                _createElementVNode("div", _hoisted_724, [
                  _createElementVNode("div", _hoisted_725, [
                    _createElementVNode("h3", null, _toDisplayString(_ctx.t('🔑 Change master key')), 1 /* TEXT */),
                    _createElementVNode("button", {
                      class: "icon-btn",
                      disabled: _ctx.encForm.busy,
                      onClick: _cache[241] || (_cache[241] = $event => (_ctx.modal=null))
                    }, "✕", 8 /* PROPS */, _hoisted_726)
                  ]),
                  _createElementVNode("div", _hoisted_727, [
                    _createElementVNode("p", _hoisted_728, _toDisplayString(_ctx.t('All secret fields are re-encrypted with the new master key. Please do not close the page while this runs.')), 1 /* TEXT */),
                    _createElementVNode("div", _hoisted_729, [
                      _createElementVNode("label", null, _toDisplayString(_ctx.t('Current master key')), 1 /* TEXT */),
                      _withDirectives(_createElementVNode("input", {
                        type: "password",
                        "onUpdate:modelValue": _cache[242] || (_cache[242] = $event => ((_ctx.encForm.cur) = $event)),
                        autocomplete: "off"
                      }, null, 512 /* NEED_PATCH */), [
                        [_vModelText, _ctx.encForm.cur]
                      ])
                    ]),
                    _createElementVNode("div", _hoisted_730, [
                      _createElementVNode("label", null, _toDisplayString(_ctx.t('New master key (6+ characters)')), 1 /* TEXT */),
                      _withDirectives(_createElementVNode("input", {
                        type: "password",
                        "onUpdate:modelValue": _cache[243] || (_cache[243] = $event => ((_ctx.encForm.next) = $event)),
                        autocomplete: "new-password"
                      }, null, 512 /* NEED_PATCH */), [
                        [_vModelText, _ctx.encForm.next]
                      ])
                    ]),
                    _createElementVNode("div", _hoisted_731, [
                      _createElementVNode("label", null, _toDisplayString(_ctx.t('Enter it again to confirm')), 1 /* TEXT */),
                      _withDirectives(_createElementVNode("input", {
                        type: "password",
                        "onUpdate:modelValue": _cache[244] || (_cache[244] = $event => ((_ctx.encForm.next2) = $event)),
                        autocomplete: "new-password"
                      }, null, 512 /* NEED_PATCH */), [
                        [_vModelText, _ctx.encForm.next2]
                      ])
                    ]),
                    (_ctx.encForm.err)
                      ? (_openBlock(), _createElementBlock("div", _hoisted_732, _toDisplayString(_ctx.encForm.err), 1 /* TEXT */))
                      : _createCommentVNode("v-if", true),
                    (_ctx.encForm.busy)
                      ? (_openBlock(), _createElementBlock("div", _hoisted_733, _toDisplayString(_ctx.t('Re-encrypting…')) + " " + _toDisplayString(_ctx.encForm.progress), 1 /* TEXT */))
                      : _createCommentVNode("v-if", true)
                  ]),
                  _createElementVNode("div", _hoisted_734, [
                    _createElementVNode("button", {
                      class: "btn",
                      disabled: _ctx.encForm.busy,
                      onClick: _cache[245] || (_cache[245] = $event => (_ctx.modal=null))
                    }, _toDisplayString(_ctx.t('Cancel')), 9 /* TEXT, PROPS */, _hoisted_735),
                    _createElementVNode("button", {
                      class: "btn primary",
                      disabled: _ctx.encForm.busy,
                      onClick: _cache[246] || (_cache[246] = (...args) => (_ctx.changeMasterKey && _ctx.changeMasterKey(...args)))
                    }, _toDisplayString(_ctx.t('Change')), 9 /* TEXT, PROPS */, _hoisted_736)
                  ])
                ])
              ]))
            : _createCommentVNode("v-if", true),
          _createCommentVNode(" マスターパスワード削除（平文化して暗号化を解除） "),
          (_ctx.modal && _ctx.modal.type==='encRemove')
            ? (_openBlock(), _createElementBlock("div", {
                key: 22,
                class: "modal-mask",
                onClick: _cache[252] || (_cache[252] = _withModifiers($event => (!_ctx.encForm.busy && (_ctx.modal=null)), ["self"]))
              }, [
                _createElementVNode("div", _hoisted_737, [
                  _createElementVNode("div", _hoisted_738, [
                    _createElementVNode("h3", null, _toDisplayString(_ctx.t('🗝️ Remove master key')), 1 /* TEXT */),
                    _createElementVNode("button", {
                      class: "icon-btn",
                      disabled: _ctx.encForm.busy,
                      onClick: _cache[248] || (_cache[248] = $event => (_ctx.modal=null))
                    }, "✕", 8 /* PROPS */, _hoisted_739)
                  ]),
                  _createElementVNode("div", _hoisted_740, [
                    _createElementVNode("p", _hoisted_741, _toDisplayString(_ctx.t('All secret fields are decrypted and saved back as plain text, then encryption is turned off. Enter your current master key to continue.')), 1 /* TEXT */),
                    _createElementVNode("p", _hoisted_742, "⚠️ " + _toDisplayString(_ctx.t('After this, secret fields are stored in plain text and become readable by the server and the administrator.')), 1 /* TEXT */),
                    _createElementVNode("div", _hoisted_743, [
                      _createElementVNode("label", null, _toDisplayString(_ctx.t('Current master key')), 1 /* TEXT */),
                      _withDirectives(_createElementVNode("input", {
                        type: "password",
                        "onUpdate:modelValue": _cache[249] || (_cache[249] = $event => ((_ctx.encForm.cur) = $event)),
                        autocomplete: "off"
                      }, null, 512 /* NEED_PATCH */), [
                        [_vModelText, _ctx.encForm.cur]
                      ])
                    ]),
                    (_ctx.encForm.err)
                      ? (_openBlock(), _createElementBlock("div", _hoisted_744, _toDisplayString(_ctx.encForm.err), 1 /* TEXT */))
                      : _createCommentVNode("v-if", true),
                    (_ctx.encForm.busy)
                      ? (_openBlock(), _createElementBlock("div", _hoisted_745, _toDisplayString(_ctx.t('Decrypting…')) + " " + _toDisplayString(_ctx.encForm.progress), 1 /* TEXT */))
                      : _createCommentVNode("v-if", true)
                  ]),
                  _createElementVNode("div", _hoisted_746, [
                    _createElementVNode("button", {
                      class: "btn",
                      disabled: _ctx.encForm.busy,
                      onClick: _cache[250] || (_cache[250] = $event => (_ctx.modal=null))
                    }, _toDisplayString(_ctx.t('Cancel')), 9 /* TEXT, PROPS */, _hoisted_747),
                    _createElementVNode("button", {
                      class: "btn danger",
                      disabled: _ctx.encForm.busy,
                      onClick: _cache[251] || (_cache[251] = (...args) => (_ctx.removeEncryption && _ctx.removeEncryption(...args)))
                    }, _toDisplayString(_ctx.t('Remove and decrypt')), 9 /* TEXT, PROPS */, _hoisted_748)
                  ])
                ])
              ]))
            : _createCommentVNode("v-if", true),
          _createCommentVNode(" 一括削除（厳重確認） "),
          (_ctx.modal && _ctx.modal.type==='bulkDelete')
            ? (_openBlock(), _createElementBlock("div", {
                key: 23,
                class: "modal-mask",
                onClick: _cache[257] || (_cache[257] = _withModifiers($event => (_ctx.modal=null), ["self"]))
              }, [
                _createElementVNode("div", _hoisted_749, [
                  _createElementVNode("div", _hoisted_750, [
                    _createElementVNode("h3", null, _toDisplayString(_ctx.t('⚠️ Delete records')), 1 /* TEXT */),
                    _createElementVNode("button", {
                      class: "icon-btn",
                      onClick: _cache[253] || (_cache[253] = $event => (_ctx.modal=null))
                    }, "✕")
                  ]),
                  _createElementVNode("div", _hoisted_751, [
                    _createElementVNode("p", _hoisted_752, _toDisplayString(_ctx.t('Permanently delete the {n} selected records.', {n: _ctx.selectedIds.length})), 1 /* TEXT */),
                    _createElementVNode("p", _hoisted_753, _toDisplayString(_ctx.t('This action cannot be undone. Deleted data cannot be recovered.')), 1 /* TEXT */),
                    _createElementVNode("label", _hoisted_754, [
                      _withDirectives(_createElementVNode("input", {
                        type: "checkbox",
                        "onUpdate:modelValue": _cache[254] || (_cache[254] = $event => ((_ctx.delConfirm) = $event))
                      }, null, 512 /* NEED_PATCH */), [
                        [_vModelCheckbox, _ctx.delConfirm]
                      ]),
                      _createTextVNode(" " + _toDisplayString(_ctx.t('I understand the above and confirm the deletion')), 1 /* TEXT */)
                    ])
                  ]),
                  _createElementVNode("div", _hoisted_755, [
                    _createElementVNode("button", {
                      class: "btn",
                      onClick: _cache[255] || (_cache[255] = $event => (_ctx.modal=null))
                    }, _toDisplayString(_ctx.t('Cancel')), 1 /* TEXT */),
                    _createElementVNode("button", {
                      class: "btn danger",
                      disabled: !_ctx.delConfirm || _ctx.busy,
                      onClick: _cache[256] || (_cache[256] = (...args) => (_ctx.commitBulkDelete && _ctx.commitBulkDelete(...args)))
                    }, _toDisplayString(_ctx.t('Delete {n} items', {n: _ctx.selectedIds.length})), 9 /* TEXT, PROPS */, _hoisted_756)
                  ])
                ])
              ]))
            : _createCommentVNode("v-if", true),
          _createCommentVNode(" 項目変更でデータ削除が発生する場合の厳重確認 "),
          (_ctx.modal && _ctx.modal.type==='schemaMigrate' && _ctx.schemaPlan)
            ? (_openBlock(), _createElementBlock("div", {
                key: 24,
                class: "modal-mask",
                onClick: _cache[262] || (_cache[262] = _withModifiers((...args) => (_ctx.cancelSchemaMigrate && _ctx.cancelSchemaMigrate(...args)), ["self"]))
              }, [
                _createElementVNode("div", _hoisted_757, [
                  _createElementVNode("div", _hoisted_758, [
                    _createElementVNode("h3", null, _toDisplayString(_ctx.t('⚠️ This change will delete data')), 1 /* TEXT */),
                    _createElementVNode("button", {
                      class: "icon-btn",
                      onClick: _cache[258] || (_cache[258] = (...args) => (_ctx.cancelSchemaMigrate && _ctx.cancelSchemaMigrate(...args)))
                    }, "✕")
                  ]),
                  _createElementVNode("div", _hoisted_759, [
                    _createElementVNode("p", _hoisted_760, _toDisplayString(_ctx.t('Saving these field changes will delete the following existing data:')), 1 /* TEXT */),
                    _createElementVNode("ul", _hoisted_761, [
                      (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.schemaPlan.destructive, (l, i) => {
                        return (_openBlock(), _createElementBlock("li", {
                          key: i,
                          style: {"margin":"3px 0"}
                        }, _toDisplayString(l), 1 /* TEXT */))
                      }), 128 /* KEYED_FRAGMENT */))
                    ]),
                    _createElementVNode("p", _hoisted_762, _toDisplayString(_ctx.t('This action cannot be undone. Deleted data cannot be recovered.')), 1 /* TEXT */),
                    (_ctx.schemaPlan.safe.length)
                      ? (_openBlock(), _createElementBlock("div", _hoisted_763, [
                          _createTextVNode(_toDisplayString(_ctx.t('The following non-destructive changes will also be applied:')) + " ", 1 /* TEXT */),
                          _createElementVNode("ul", _hoisted_764, [
                            (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.schemaPlan.safe, (l, i) => {
                              return (_openBlock(), _createElementBlock("li", {
                                key: 's'+i,
                                style: {"margin":"3px 0"}
                              }, _toDisplayString(l), 1 /* TEXT */))
                            }), 128 /* KEYED_FRAGMENT */))
                          ])
                        ]))
                      : _createCommentVNode("v-if", true),
                    _createElementVNode("label", _hoisted_765, [
                      _withDirectives(_createElementVNode("input", {
                        type: "checkbox",
                        "onUpdate:modelValue": _cache[259] || (_cache[259] = $event => ((_ctx.schemaAck) = $event))
                      }, null, 512 /* NEED_PATCH */), [
                        [_vModelCheckbox, _ctx.schemaAck]
                      ]),
                      _createTextVNode(" " + _toDisplayString(_ctx.t('I understand the above and confirm the deletion')), 1 /* TEXT */)
                    ])
                  ]),
                  _createElementVNode("div", _hoisted_766, [
                    _createElementVNode("button", {
                      class: "btn",
                      onClick: _cache[260] || (_cache[260] = (...args) => (_ctx.cancelSchemaMigrate && _ctx.cancelSchemaMigrate(...args)))
                    }, _toDisplayString(_ctx.t('Cancel')), 1 /* TEXT */),
                    _createElementVNode("button", {
                      class: "btn danger",
                      disabled: !_ctx.schemaAck || _ctx.busy,
                      onClick: _cache[261] || (_cache[261] = (...args) => (_ctx.confirmSchemaMigrate && _ctx.confirmSchemaMigrate(...args)))
                    }, _toDisplayString(_ctx.t('Delete and save')), 9 /* TEXT, PROPS */, _hoisted_767)
                  ])
                ])
              ]))
            : _createCommentVNode("v-if", true),
          _createCommentVNode(" 画像トリミング "),
          (_ctx.cropper.open)
            ? (_openBlock(), _createElementBlock("div", {
                key: 25,
                class: "modal-mask cropper-mask",
                onClick: _cache[271] || (_cache[271] = _withModifiers($event => (_ctx.cropper.open=false), ["self"]))
              }, [
                _createElementVNode("div", _hoisted_768, [
                  _createElementVNode("div", _hoisted_769, [
                    _createElementVNode("h3", null, _toDisplayString(_ctx.t('✂ Crop image')), 1 /* TEXT */),
                    _createElementVNode("button", {
                      class: "icon-btn",
                      onClick: _cache[263] || (_cache[263] = $event => (_ctx.cropper.open=false))
                    }, "✕")
                  ]),
                  _createElementVNode("div", _hoisted_770, [
                    _createElementVNode("p", _hoisted_771, _toDisplayString(_ctx.t('Drag the box to move, drag a corner to resize.')) + _toDisplayString(_ctx.cropper.ratioLabel==='free' ? _ctx.t('Free ratio') : _ctx.t('Ratio {r}', {r: _ctx.cropper.ratioLabel})) + " " + _toDisplayString(_ctx.t('/ Output width {w}px', {w: _ctx.cropper.out})), 1 /* TEXT */),
                    _createElementVNode("div", {
                      class: "crop-stage",
                      style: _normalizeStyle({width: _ctx.cropper.dispW+'px', height: _ctx.cropper.dispH+'px'})
                    }, [
                      _createElementVNode("img", {
                        src: _ctx.cropper.src,
                        class: "crop-img",
                        draggable: "false",
                        style: _normalizeStyle({width: _ctx.cropper.dispW+'px', height: _ctx.cropper.dispH+'px'})
                      }, null, 12 /* STYLE, PROPS */, _hoisted_772),
                      _createElementVNode("div", {
                        class: "crop-box",
                        style: _normalizeStyle({left:_ctx.cropper.box.x+'px', top:_ctx.cropper.box.y+'px', width:_ctx.cropper.box.w+'px', height:_ctx.cropper.box.h+'px'}),
                        onPointerdown: _cache[268] || (_cache[268] = _withModifiers($event => (_ctx.cropDown($event,'move',null)), ["prevent"]))
                      }, [
                        _createElementVNode("span", {
                          class: "crop-h tl",
                          onPointerdown: _cache[264] || (_cache[264] = _withModifiers($event => (_ctx.cropDown($event,'resize','tl')), ["prevent","stop"]))
                        }, null, 32 /* NEED_HYDRATION */),
                        _createElementVNode("span", {
                          class: "crop-h tr",
                          onPointerdown: _cache[265] || (_cache[265] = _withModifiers($event => (_ctx.cropDown($event,'resize','tr')), ["prevent","stop"]))
                        }, null, 32 /* NEED_HYDRATION */),
                        _createElementVNode("span", {
                          class: "crop-h bl",
                          onPointerdown: _cache[266] || (_cache[266] = _withModifiers($event => (_ctx.cropDown($event,'resize','bl')), ["prevent","stop"]))
                        }, null, 32 /* NEED_HYDRATION */),
                        _createElementVNode("span", {
                          class: "crop-h br",
                          onPointerdown: _cache[267] || (_cache[267] = _withModifiers($event => (_ctx.cropDown($event,'resize','br')), ["prevent","stop"]))
                        }, null, 32 /* NEED_HYDRATION */)
                      ], 36 /* STYLE, NEED_HYDRATION */)
                    ], 4 /* STYLE */)
                  ]),
                  _createElementVNode("div", _hoisted_773, [
                    _createElementVNode("button", {
                      class: "btn",
                      onClick: _cache[269] || (_cache[269] = $event => (_ctx.cropper.open=false))
                    }, _toDisplayString(_ctx.t('Cancel')), 1 /* TEXT */),
                    _createElementVNode("button", {
                      class: "btn primary",
                      disabled: _ctx.cropper.busy,
                      onClick: _cache[270] || (_cache[270] = (...args) => (_ctx.confirmCrop && _ctx.confirmCrop(...args)))
                    }, _toDisplayString(_ctx.t('Crop and use')), 9 /* TEXT, PROPS */, _hoisted_774)
                  ])
                ])
              ]))
            : _createCommentVNode("v-if", true),
          _createCommentVNode(" ノート選択（Notesアプリ連携） "),
          (_ctx.notePicker.open)
            ? (_openBlock(), _createElementBlock("div", {
                key: 26,
                class: "modal-mask cropper-mask",
                onClick: _cache[275] || (_cache[275] = _withModifiers($event => (_ctx.notePicker.open=false), ["self"]))
              }, [
                _createElementVNode("div", _hoisted_775, [
                  _createElementVNode("div", _hoisted_776, [
                    _createElementVNode("h3", null, _toDisplayString(_ctx.t('📝 Attach a note')), 1 /* TEXT */),
                    _createElementVNode("button", {
                      class: "icon-btn",
                      onClick: _cache[272] || (_cache[272] = $event => (_ctx.notePicker.open=false))
                    }, "✕")
                  ]),
                  _createElementVNode("div", _hoisted_777, [
                    (_ctx.notePicker.loading)
                      ? (_openBlock(), _createElementBlock("div", _hoisted_778, [
                          _createElementVNode("p", null, _toDisplayString(_ctx.t('Loading…')), 1 /* TEXT */)
                        ]))
                      : (_ctx.notePicker.error)
                        ? (_openBlock(), _createElementBlock("div", _hoisted_779, [
                            _createElementVNode("p", null, [
                              _createTextVNode(_toDisplayString(_ctx.t('Could not load notes.')), 1 /* TEXT */),
                              _hoisted_780,
                              _createTextVNode(_toDisplayString(_ctx.notePicker.error), 1 /* TEXT */)
                            ])
                          ]))
                        : (_ctx.notePicker.step==='cat')
                          ? (_openBlock(), _createElementBlock(_Fragment, { key: 2 }, [
                              _createElementVNode("p", _hoisted_781, _toDisplayString(_ctx.t('Please choose a category.')), 1 /* TEXT */),
                              (!_ctx.notePicker.categories.length)
                                ? (_openBlock(), _createElementBlock("div", _hoisted_782, [
                                    _createElementVNode("p", null, [
                                      _createTextVNode(_toDisplayString(_ctx.t('No notes.')), 1 /* TEXT */),
                                      _hoisted_783,
                                      _createTextVNode(_toDisplayString(_ctx.t('Create them in the Notes app.')), 1 /* TEXT */)
                                    ])
                                  ]))
                                : (_openBlock(), _createElementBlock("div", _hoisted_784, [
                                    (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.notePicker.categories, (c) => {
                                      return (_openBlock(), _createElementBlock("button", {
                                        key: c.name,
                                        type: "button",
                                        class: "note-item",
                                        onClick: $event => (_ctx.selectNoteCategory(c.name))
                                      }, [
                                        _createElementVNode("span", _hoisted_786, "📂 " + _toDisplayString(c.name || _ctx.t('(no category)')), 1 /* TEXT */),
                                        _createElementVNode("span", _hoisted_787, _toDisplayString(c.count), 1 /* TEXT */)
                                      ], 8 /* PROPS */, _hoisted_785))
                                    }), 128 /* KEYED_FRAGMENT */))
                                  ]))
                            ], 64 /* STABLE_FRAGMENT */))
                          : (_openBlock(), _createElementBlock(_Fragment, { key: 3 }, [
                              _createElementVNode("button", {
                                type: "button",
                                class: "btn sm",
                                style: {"margin-bottom":"10px"},
                                onClick: _cache[273] || (_cache[273] = $event => (_ctx.notePicker.step='cat'))
                              }, _toDisplayString(_ctx.t('← Back to categories')), 1 /* TEXT */),
                              _createElementVNode("div", _hoisted_788, "📂 " + _toDisplayString(_ctx.notePicker.category || _ctx.t('(no category)')), 1 /* TEXT */),
                              (!_ctx.notesInCategory().length)
                                ? (_openBlock(), _createElementBlock("div", _hoisted_789, [
                                    _createElementVNode("p", null, _toDisplayString(_ctx.t('No notes in this category.')), 1 /* TEXT */)
                                  ]))
                                : (_openBlock(), _createElementBlock("div", _hoisted_790, [
                                    (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.notesInCategory(), (n) => {
                                      return (_openBlock(), _createElementBlock("button", {
                                        key: n.id,
                                        type: "button",
                                        class: "note-item",
                                        onClick: $event => (_ctx.pickNote(n))
                                      }, [
                                        _createElementVNode("span", _hoisted_792, _toDisplayString(n.title || _ctx.t('(untitled)')), 1 /* TEXT */)
                                      ], 8 /* PROPS */, _hoisted_791))
                                    }), 128 /* KEYED_FRAGMENT */))
                                  ]))
                            ], 64 /* STABLE_FRAGMENT */))
                  ]),
                  _createElementVNode("div", _hoisted_793, [
                    _createElementVNode("button", {
                      class: "btn",
                      onClick: _cache[274] || (_cache[274] = $event => (_ctx.notePicker.open=false))
                    }, _toDisplayString(_ctx.t('Cancel')), 1 /* TEXT */)
                  ])
                ])
              ]))
            : _createCommentVNode("v-if", true),
          _createCommentVNode(" ファイル選択（自前ブラウザ：未選択では「選択」を押せない） "),
          (_ctx.filePicker.open)
            ? (_openBlock(), _createElementBlock("div", {
                key: 27,
                class: "modal-mask cropper-mask",
                onClick: _cache[281] || (_cache[281] = _withModifiers($event => (_ctx.fpCancel()), ["self"]))
              }, [
                _createElementVNode("div", _hoisted_794, [
                  _createElementVNode("div", _hoisted_795, [
                    _createElementVNode("h3", null, "📂 " + _toDisplayString(_ctx.filePicker.mode==='folder' ? _ctx.t('Choose a folder') : (_ctx.filePicker.mode==='image' ? _ctx.t('Choose an image') : _ctx.t('Choose a file'))), 1 /* TEXT */),
                    _createElementVNode("button", {
                      class: "icon-btn",
                      onClick: _cache[276] || (_cache[276] = $event => (_ctx.fpCancel()))
                    }, "✕")
                  ]),
                  _createElementVNode("div", _hoisted_796, [
                    _createElementVNode("div", _hoisted_797, [
                      _createElementVNode("button", {
                        type: "button",
                        class: "btn sm",
                        disabled: _ctx.filePicker.parent===null || _ctx.filePicker.loading,
                        onClick: _cache[277] || (_cache[277] = $event => (_ctx.fpUp()))
                      }, _toDisplayString(_ctx.t('⬆ Up')), 9 /* TEXT, PROPS */, _hoisted_798),
                      _createElementVNode("span", _hoisted_799, "/" + _toDisplayString(_ctx.filePicker.path), 1 /* TEXT */)
                    ]),
                    (_ctx.filePicker.loading)
                      ? (_openBlock(), _createElementBlock("div", _hoisted_800, [
                          _createElementVNode("p", null, _toDisplayString(_ctx.t('Loading…')), 1 /* TEXT */)
                        ]))
                      : (_ctx.filePicker.error)
                        ? (_openBlock(), _createElementBlock("div", _hoisted_801, [
                            _createElementVNode("p", null, _toDisplayString(_ctx.filePicker.error), 1 /* TEXT */)
                          ]))
                        : (!_ctx.fpVisible.length)
                          ? (_openBlock(), _createElementBlock("div", _hoisted_802, [
                              _createElementVNode("p", null, _toDisplayString(_ctx.t('Nothing to show.')), 1 /* TEXT */)
                            ]))
                          : (_openBlock(), _createElementBlock("div", _hoisted_803, [
                              (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.fpVisible, (x) => {
                                return (_openBlock(), _createElementBlock("button", {
                                  key: x.path,
                                  type: "button",
                                  class: _normalizeClass(["note-item fp-item", {sel: _ctx.filePicker.selected && _ctx.filePicker.selected.path===x.path}]),
                                  onClick: $event => (_ctx.fpClick(x)),
                                  onDblclick: $event => (_ctx.fpDbl(x))
                                }, [
                                  _createElementVNode("span", _hoisted_805, _toDisplayString(x.is_dir ? '📁' : _ctx.fpIcon(x)) + " " + _toDisplayString(x.name), 1 /* TEXT */),
                                  _createElementVNode("span", _hoisted_806, _toDisplayString(x.is_dir ? '›' : ''), 1 /* TEXT */)
                                ], 42 /* CLASS, PROPS, NEED_HYDRATION */, _hoisted_804))
                              }), 128 /* KEYED_FRAGMENT */))
                            ]))
                  ]),
                  _createElementVNode("div", _hoisted_807, [
                    _createElementVNode("button", {
                      type: "button",
                      class: "btn",
                      onClick: _cache[278] || (_cache[278] = $event => (_ctx.fpCancel()))
                    }, _toDisplayString(_ctx.t('Cancel')), 1 /* TEXT */),
                    (_ctx.filePicker.mode==='folder')
                      ? (_openBlock(), _createElementBlock("button", {
                          key: 0,
                          type: "button",
                          class: "btn primary",
                          onClick: _cache[279] || (_cache[279] = $event => (_ctx.fpConfirmFolder()))
                        }, _toDisplayString(_ctx.t('Select this folder')), 1 /* TEXT */))
                      : (_openBlock(), _createElementBlock("button", {
                          key: 1,
                          type: "button",
                          class: "btn primary",
                          disabled: !_ctx.filePicker.selected,
                          onClick: _cache[280] || (_cache[280] = $event => (_ctx.fpConfirm()))
                        }, _toDisplayString(_ctx.t('Select')), 9 /* TEXT, PROPS */, _hoisted_808))
                  ])
                ])
              ]))
            : _createCommentVNode("v-if", true),
          _createCommentVNode(" One icon picker shared by every place that sets an icon (collection settings,\n       template editor, CSV/JSON import, Contacts import, Tables import). "),
          (_ctx.iconPickerOpen)
            ? (_openBlock(), _createElementBlock(_Fragment, { key: 28 }, [
                _createElementVNode("div", {
                  class: "emoji-backdrop",
                  onClick: _cache[282] || (_cache[282] = $event => (_ctx.iconPickerOpen = false))
                }),
                _createElementVNode("div", {
                  class: "emoji-popup",
                  onClick: _cache[284] || (_cache[284] = _withModifiers(() => {}, ["stop"]))
                }, [
                  _withDirectives(_createElementVNode("input", {
                    class: "emoji-search",
                    "onUpdate:modelValue": _cache[283] || (_cache[283] = $event => ((_ctx.emojiQuery) = $event)),
                    placeholder: _ctx.t('Search emoji')
                  }, null, 8 /* PROPS */, _hoisted_809), [
                    [_vModelText, _ctx.emojiQuery]
                  ]),
                  _createElementVNode("div", _hoisted_810, [
                    (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.iconGroupsAll, (g) => {
                      return (_openBlock(), _createElementBlock("button", {
                        type: "button",
                        class: _normalizeClass(["emoji-tab", {sel: !_ctx.emojiQuery && _ctx.emojiTab===g.key}]),
                        key: g.key,
                        title: _ctx.t(g.key),
                        onClick: $event => {_ctx.emojiTab = g.key; _ctx.emojiQuery = ''}
                      }, _toDisplayString(g.tab), 11 /* TEXT, CLASS, PROPS */, _hoisted_811))
                    }), 128 /* KEYED_FRAGMENT */))
                  ]),
                  _createElementVNode("div", _hoisted_812, [
                    _createElementVNode("div", _hoisted_813, _toDisplayString(_ctx.emojiQuery ? _ctx.t('{n} items', {n: _ctx.emojiShown.length}) : _ctx.t(_ctx.emojiTab)), 1 /* TEXT */),
                    (_ctx.emojiLoading)
                      ? (_openBlock(), _createElementBlock("div", _hoisted_814, _toDisplayString(_ctx.t('Loading…')), 1 /* TEXT */))
                      : (!_ctx.emojiShown.length)
                        ? (_openBlock(), _createElementBlock("div", _hoisted_815, _toDisplayString(_ctx.t('No matching emoji')), 1 /* TEXT */))
                        : _createCommentVNode("v-if", true),
                    _createElementVNode("div", _hoisted_816, [
                      (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.emojiShown, (em) => {
                        return (_openBlock(), _createElementBlock("button", {
                          type: "button",
                          class: _normalizeClass(["emoji-btn", {sel: _ctx.iconTargetValue===em}]),
                          key: em,
                          onClick: $event => (_ctx.pickIcon(em)),
                          title: _ctx.emojiName(em)
                        }, _toDisplayString(em), 11 /* TEXT, CLASS, PROPS */, _hoisted_817))
                      }), 128 /* KEYED_FRAGMENT */))
                    ])
                  ])
                ])
              ], 64 /* STABLE_FRAGMENT */))
            : _createCommentVNode("v-if", true),
          _createCommentVNode(" One password generator shared by every secret field and by the share password.\n       Lives at root level so it can float above the record dialog. "),
          (_ctx.pwgen.open)
            ? (_openBlock(), _createElementBlock(_Fragment, { key: 29 }, [
                _createElementVNode("div", {
                  class: "emoji-backdrop",
                  onClick: _cache[285] || (_cache[285] = $event => (_ctx.closePwGen()))
                }),
                _createElementVNode("div", {
                  class: "pwgen-popup",
                  onClick: _cache[302] || (_cache[302] = _withModifiers(() => {}, ["stop"]))
                }, [
                  _createElementVNode("div", _hoisted_818, [
                    _createElementVNode("span", null, "🎲 " + _toDisplayString(_ctx.t(_ctx.pwgen.target === 'defaults' ? 'Password generator defaults' : 'Password generator')), 1 /* TEXT */),
                    _createElementVNode("button", {
                      type: "button",
                      class: "icon-btn",
                      onClick: _cache[286] || (_cache[286] = $event => (_ctx.closePwGen()))
                    }, "✕")
                  ]),
                  _createElementVNode("div", _hoisted_819, [
                    _withDirectives(_createElementVNode("input", {
                      class: "pwgen-val",
                      "onUpdate:modelValue": _cache[287] || (_cache[287] = $event => ((_ctx.pwgen.value) = $event)),
                      spellcheck: "false",
                      autocorrect: "off",
                      autocapitalize: "off",
                      autocomplete: "off",
                      "data-1p-ignore": "",
                      "data-lpignore": "true",
                      "data-bwignore": "",
                      "data-form-type": "other"
                    }, null, 512 /* NEED_PATCH */), [
                      [_vModelText, _ctx.pwgen.value]
                    ]),
                    _createElementVNode("button", {
                      type: "button",
                      class: "icon-btn",
                      onClick: _cache[288] || (_cache[288] = $event => (_ctx.pwgenMake())),
                      title: _ctx.t('Regenerate')
                    }, "🔄", 8 /* PROPS */, _hoisted_820),
                    _createElementVNode("button", {
                      type: "button",
                      class: "icon-btn",
                      onClick: _cache[289] || (_cache[289] = $event => (_ctx.copyVal(_ctx.pwgen.value))),
                      title: _ctx.t('Copy')
                    }, "⧉", 8 /* PROPS */, _hoisted_821)
                  ]),
                  _createElementVNode("div", _hoisted_822, [
                    _createElementVNode("div", {
                      class: _normalizeClass(["pwgen-bar", _ctx.pwgenStrength.cls]),
                      style: _normalizeStyle({width: _ctx.pwgenStrength.pct + '%'})
                    }, null, 6 /* CLASS, STYLE */)
                  ]),
                  _createElementVNode("div", _hoisted_823, [
                    _createElementVNode("span", {
                      class: _normalizeClass(_ctx.pwgenStrength.cls)
                    }, _toDisplayString(_ctx.t(_ctx.pwgenStrength.label)), 3 /* TEXT, CLASS */),
                    _createElementVNode("span", _hoisted_824, [
                      _createTextVNode(_toDisplayString(_ctx.t('{bits} bits of entropy', {bits: _ctx.pwgenStrength.bits})), 1 /* TEXT */),
                      (_ctx.pwgenCombos)
                        ? (_openBlock(), _createElementBlock("span", _hoisted_825, _toDisplayString(_ctx.pwgenCombos), 1 /* TEXT */))
                        : _createCommentVNode("v-if", true)
                    ])
                  ]),
                  _createElementVNode("div", _hoisted_826, [
                    _createElementVNode("span", _hoisted_827, _toDisplayString(_ctx.t('Length')), 1 /* TEXT */),
                    _withDirectives(_createElementVNode("input", {
                      type: "range",
                      min: _ctx.pwgenMin,
                      max: _ctx.pwgenMax,
                      "onUpdate:modelValue": _cache[290] || (_cache[290] = $event => ((_ctx.pwgen.len) = $event)),
                      onInput: _cache[291] || (_cache[291] = $event => (_ctx.pwgenSetLen()))
                    }, null, 40 /* PROPS, NEED_HYDRATION */, _hoisted_828), [
                      [
                        _vModelText,
                        _ctx.pwgen.len,
                        void 0,
                        { number: true }
                      ]
                    ]),
                    _withDirectives(_createElementVNode("input", {
                      type: "number",
                      class: "pwgen-num",
                      min: _ctx.pwgenMin,
                      max: _ctx.pwgenMax,
                      "onUpdate:modelValue": _cache[292] || (_cache[292] = $event => ((_ctx.pwgen.len) = $event)),
                      onChange: _cache[293] || (_cache[293] = $event => (_ctx.pwgenSetLen()))
                    }, null, 40 /* PROPS, NEED_HYDRATION */, _hoisted_829), [
                      [
                        _vModelText,
                        _ctx.pwgen.len,
                        void 0,
                        { number: true }
                      ]
                    ])
                  ]),
                  (_ctx.pwgenIsHex)
                    ? (_openBlock(), _createElementBlock("div", _hoisted_830, [
                        _createElementVNode("div", _hoisted_831, _toDisplayString(_ctx.t('Hexadecimal field: fixed 0–9 A–F alphabet.')), 1 /* TEXT */)
                      ]))
                    : (_openBlock(), _createElementBlock(_Fragment, { key: 1 }, [
                        _createElementVNode("div", _hoisted_832, [
                          _createElementVNode("div", _hoisted_833, [
                            _createElementVNode("span", null, _toDisplayString(_ctx.t('Character types')), 1 /* TEXT */),
                            _createElementVNode("span", _hoisted_834, _toDisplayString(_ctx.t('min')) + " / " + _toDisplayString(_ctx.t('max')), 1 /* TEXT */)
                          ]),
                          (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.pwgenClassRows, (c) => {
                            return (_openBlock(), _createElementBlock("div", {
                              class: _normalizeClass(["pwgen-cls", {dis: !c.avail}]),
                              key: c.k
                            }, [
                              _createElementVNode("label", _hoisted_835, [
                                _createElementVNode("input", {
                                  type: "checkbox",
                                  checked: _ctx.pwgen[c.k],
                                  disabled: !c.avail,
                                  onChange: $event => (_ctx.pwgenToggle(c.k, $event))
                                }, null, 40 /* PROPS, NEED_HYDRATION */, _hoisted_836),
                                _createTextVNode(" " + _toDisplayString(_ctx.t(c.label)), 1 /* TEXT */)
                              ]),
                              (c.avail && _ctx.pwgen[c.k] && c.set.length)
                                ? (_openBlock(), _createElementBlock("span", _hoisted_837, [
                                    _createElementVNode("input", {
                                      type: "number",
                                      min: "0",
                                      max: _ctx.pwgenMax,
                                      value: _ctx.pwgen.min[c.k],
                                      onChange: $event => (_ctx.pwgenSetMin(c.k, $event.target.value)),
                                      title: _ctx.t('Minimum count')
                                    }, null, 40 /* PROPS, NEED_HYDRATION */, _hoisted_838),
                                    _hoisted_839,
                                    _createElementVNode("input", {
                                      type: "number",
                                      min: "0",
                                      max: _ctx.pwgenMax,
                                      value: _ctx.pwgen.max[c.k] == null ? '' : _ctx.pwgen.max[c.k],
                                      placeholder: _ctx.t('∞'),
                                      onChange: $event => (_ctx.pwgenSetMax(c.k, $event.target.value)),
                                      title: _ctx.t('Maximum count (blank = no limit)')
                                    }, null, 40 /* PROPS, NEED_HYDRATION */, _hoisted_840)
                                  ]))
                                : _createCommentVNode("v-if", true)
                            ], 2 /* CLASS */))
                          }), 128 /* KEYED_FRAGMENT */))
                        ]),
                        (_ctx.pwgenSymbolsAvail && _ctx.pwgen.symbols)
                          ? (_openBlock(), _createElementBlock("div", _hoisted_841, [
                              _createElementVNode("div", _hoisted_842, [
                                _createElementVNode("span", _hoisted_843, _toDisplayString(_ctx.t('Allowed symbols')), 1 /* TEXT */),
                                _createElementVNode("button", {
                                  type: "button",
                                  class: "pwgen-mini",
                                  onClick: _cache[294] || (_cache[294] = $event => (_ctx.pwgenAllSymbols(true)))
                                }, _toDisplayString(_ctx.t('All')), 1 /* TEXT */),
                                _createElementVNode("button", {
                                  type: "button",
                                  class: "pwgen-mini",
                                  onClick: _cache[295] || (_cache[295] = $event => (_ctx.pwgenAllSymbols(false)))
                                }, _toDisplayString(_ctx.t('None')), 1 /* TEXT */)
                              ]),
                              _createElementVNode("div", _hoisted_844, [
                                (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.pwgenSymbolChips, (s) => {
                                  return (_openBlock(), _createElementBlock("button", {
                                    type: "button",
                                    class: _normalizeClass(["pwgen-sym", {sel: s.on, dis: s.lookalike && _ctx.pwgen.noLookalike}]),
                                    key: s.ch,
                                    title: s.lookalike && _ctx.pwgen.noLookalike ? _ctx.t('Excluded as a look-alike') : '',
                                    onClick: $event => (_ctx.pwgenToggleSymbol(s.ch))
                                  }, _toDisplayString(s.ch), 11 /* TEXT, CLASS, PROPS */, _hoisted_845))
                                }), 128 /* KEYED_FRAGMENT */))
                              ])
                            ]))
                          : _createCommentVNode("v-if", true),
                        _createElementVNode("div", _hoisted_846, [
                          _createElementVNode("label", {
                            class: _normalizeClass({dis: !_ctx.pwgenFirstAlphaUsable})
                          }, [
                            _withDirectives(_createElementVNode("input", {
                              type: "checkbox",
                              "onUpdate:modelValue": _cache[296] || (_cache[296] = $event => ((_ctx.pwgen.firstAlpha) = $event)),
                              disabled: !_ctx.pwgenFirstAlphaUsable,
                              onChange: _cache[297] || (_cache[297] = $event => (_ctx.pwgenMake()))
                            }, null, 40 /* PROPS, NEED_HYDRATION */, _hoisted_847), [
                              [_vModelCheckbox, _ctx.pwgen.firstAlpha]
                            ]),
                            _createTextVNode(" " + _toDisplayString(_ctx.t('Start the first character with a letter (not a digit or symbol)')), 1 /* TEXT */)
                          ], 2 /* CLASS */),
                          _createElementVNode("label", {
                            class: _normalizeClass({dis: !_ctx.pwgenLookalikeUsable})
                          }, [
                            _withDirectives(_createElementVNode("input", {
                              type: "checkbox",
                              "onUpdate:modelValue": _cache[298] || (_cache[298] = $event => ((_ctx.pwgen.noLookalike) = $event)),
                              disabled: !_ctx.pwgenLookalikeUsable,
                              onChange: _cache[299] || (_cache[299] = $event => {_ctx.pwgenReconcile(); _ctx.pwgenMake()})
                            }, null, 40 /* PROPS, NEED_HYDRATION */, _hoisted_848), [
                              [_vModelCheckbox, _ctx.pwgen.noLookalike]
                            ]),
                            _createTextVNode(" " + _toDisplayString(_ctx.t('Exclude look-alike characters (0 O 1 l I |)')), 1 /* TEXT */)
                          ], 2 /* CLASS */)
                        ])
                      ], 64 /* STABLE_FRAGMENT */)),
                  (_ctx.pwgenNote)
                    ? (_openBlock(), _createElementBlock("div", _hoisted_849, "📏 " + _toDisplayString(_ctx.pwgenNote), 1 /* TEXT */))
                    : _createCommentVNode("v-if", true),
                  (_ctx.pwgen.err)
                    ? (_openBlock(), _createElementBlock("div", _hoisted_850, "⚠️ " + _toDisplayString(_ctx.pwgen.err), 1 /* TEXT */))
                    : _createCommentVNode("v-if", true),
                  _createElementVNode("div", _hoisted_851, [
                    _createElementVNode("button", {
                      type: "button",
                      class: "btn sm",
                      onClick: _cache[300] || (_cache[300] = $event => (_ctx.closePwGen()))
                    }, _toDisplayString(_ctx.t('Cancel')), 1 /* TEXT */),
                    _createElementVNode("button", {
                      type: "button",
                      class: "btn sm primary",
                      disabled: !_ctx.pwgen.value,
                      onClick: _cache[301] || (_cache[301] = $event => (_ctx.pwgenApply()))
                    }, _toDisplayString(_ctx.t(_ctx.pwgen.target === 'defaults' ? 'Save as defaults' : 'Use this password')), 9 /* TEXT, PROPS */, _hoisted_852)
                  ])
                ])
              ], 64 /* STABLE_FRAGMENT */))
            : _createCommentVNode("v-if", true),
          (_ctx.toast)
            ? (_openBlock(), _createElementBlock("div", _hoisted_853, _toDisplayString(_ctx.toast), 1 /* TEXT */))
            : _createCommentVNode("v-if", true)
        ]))
}
})();

  createApp({
    data() {
      return {
        authenticated: null,
        collections: [], current: null, records: [], search: '', searchRegex: false, showRegexHelp: false, regexHelpPage: 1, replaceOn: false, replaceWith: '', replaceBusy: false,
        sidebarOpen: false, modal: null, folderAsk: { open: false }, pendingCreate: null,
        form: {}, editingRecordId: null, reveal: {},
        templates: [], templatesLoading: false, schemaFields: [],
        schemaMode: 'collection',
        tplEdit: { row_id: null, key: null, builtin_key: null, name: '', icon: '', color: '', description: '', busy: false },
        dupForm: { name: '', withRecords: false, busy: false },
        collForm: { name: '', icon: '', color: '', description: '', locked: false, key_head: false, key_sep: 'space', key_sep_char: '', files_folder: '', map_provider: '', secret: false, secret_pin: '' },
        // secret collections: whether any are currently revealed this session,
        // and the state of the 6-digit unlock prompt.
        secretShown: false,
        secretForm: { cells: ['', '', '', '', '', ''], pin: '', err: '', busy: false },
        settingsForm: { files_folder: '', theme: 'auto', language: 'auto', map_provider: 'google', undo_limit: 100 },
        undoTop: null, history: [],
        schemaSep: 'space', schemaSepChar: '',
        languages: [],
        locale: 0,
        backupForm: { password: '', busy: false, err: '' },
        restoreForm: { password: '', busy: false, err: '', fileName: '', dataUrl: '', confirm: false, mode: 'overwrite' },
        contactsImport: { books: [], selected: 'all', name: '', icon: '', busy: false, err: '', loading: false, enabled: true },
        tablesImport: { tables: [], selected: 0, name: '', icon: '', busy: false, err: '', loading: false, available: true },
        tablesExportBusy: false,
        apps: { contacts: true, tables: true, calendar: true },
        tableDrag: { active: false, startX: 0, startScroll: 0, el: null, pid: null },
        theme: 'auto',
        enc: { enabled: false, unlocked: false, salt: '', verifier: '' },
        openDecrypted: {},
        // internal sharing (owner-side panel inside collection settings)
        sharePanel: { shares: [], q: '', results: [], searching: false, recipient: null, recipientName: '', recipientType: 'user', perm: 'view', password: '', master: '', shareSecrets: false, err: '', busy: false },
        // recipient-side unlock prompt for a password-protected shared collection
        shareUnlock: { open: false, cid: null, name: '', hasSecrets: false, password: '', err: '', busy: false, next: null },
        // reactive mirror of sharedKeys presence (cid -> true) so the UI reacts to unlock
        secretUnlocked: {},
        editingOrig: null,
        permOpen: false,
        iconPickerOpen: false, iconTarget: 'collForm',
        // password generator; `value` is a live secret, so it is cleared on close
        // `prefLen` is what the user chose; `len` is that clamped to the current
        // field's rule, so a 6–8 digit PIN field does not shrink the preference.
        // `prefLen` is the user's chosen length; `len` is that clamped to the
        // current field's rule and the per-class min/max. `min`/`max` are the
        // guaranteed floor and cap per class (max === null means "no cap").
        // `symbolSet` is exactly which symbols may appear (chosen from PWGEN_SETS.symbols).
        pwgen: {
          open: false, target: null, field: null, value: '', err: '', capWarn: false,
          len: 12, prefLen: 12,
          upper: true, lower: true, digits: true, symbols: false,
          min: { upper: 2, lower: 2, digits: 2, symbols: 2 },
          max: { upper: null, lower: null, digits: null, symbols: null },
          symbolSet: PWGEN_SETS.symbols, noLookalike: true, firstAlpha: true, loaded: false,
        },
        shareExpanded: false,
        unlockKey: '', unlockErr: '', unlockRemember: true,
        encForm: { cur: '', next: '', next2: '', busy: false, progress: '', err: '', remember: true },
        cropper: { open: false, key: '', src: '', imgW: 0, imgH: 0, dispW: 0, dispH: 0, ratio: null, ratioLabel: 'free', out: 600, box: { x: 0, y: 0, w: 0, h: 0 }, drag: null, busy: false },
        fileMetaCache: {},
        notePicker: { open: false, key: '', allNotes: [], categories: [], category: null, step: 'cat', loading: false, error: '' },
        filePicker: { open: false, field: null, mode: 'image', path: '', parent: null, entries: [], selected: null, loading: false, error: '' },
        importStep: 1, importCsv: '', importFileName: '', importAnalysis: null,
        importColl: { name: '', icon: '', color: '' }, importCols: [], importBusy: false,
        views: [
          { key: 'list', label: 'List', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square"><path d="M3 5h18M3 9.5h18M3 14h18M3 18.5h18"/></svg>' },
          { key: 'table', label: 'Table', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-dasharray="3 2.2"><path d="M3 5h18M3 9.5h18M3 14h18M3 18.5h18"/></svg>' },
          { key: 'note', label: 'Notes', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="16" rx="1.5"/><path d="M9 4v16M15 4v16"/></svg>' },
          { key: 'card', label: 'Cards', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3.5" y="3.5" width="7.4" height="7.4"/><rect x="13.1" y="3.5" width="7.4" height="7.4"/><rect x="3.5" y="13.1" width="7.4" height="7.4"/><rect x="13.1" y="13.1" width="7.4" height="7.4"/></svg>' },
        ],
        xfer: { mode: 'copy', recordIds: [], targetId: '', target: null, mapping: {}, appendTo: '', busy: false, newName: '' },
        selectedIds: [], delConfirm: false,
        // ノート形式表示の選択状態。永続化しない（セッション内のみ）。
        // グループ列＝コレクション（＝既存サイドバー）、本体は「タイトル一覧｜内容」の
        // 2列。id は右の内容ペインに表示中のレコード id。
        note: { id: null },
        schemaPlan: null, schemaAck: false,
        reorder: { list: [], keys: [{ field: '', dir: 'asc' }], from: null, over: null, busy: false },
        collTip: { show: false, name: '', desc: '', x: 0, y: 0 },
        collDrag: { from: null, over: null },
        uidCounter: 1, dragIndex: null, dragOverIndex: null, dropKey: null,
        autoScroll: { timer: null, dir: 0, el: null },
        version: '', renderLimit: 200, ruleTypes: RULE_TYPES,
        selectionMode: (function () { try { return localStorage.getItem('rb-selmode') === '1'; } catch (e) { return false; } })(),
        iconChoices: [
          { e: '🗂️', t: 'Card organizer' }, { e: '📁', t: 'Folder' }, { e: '📂', t: 'Folder (open)' }, { e: '🗄️', t: 'Cabinet' }, { e: '📇', t: 'Business card / index' },
          { e: '🔑', t: 'Key' }, { e: '🔐', t: 'Locked (key)' }, { e: '🗝️', t: 'Old key' }, { e: '💳', t: 'Credit card' }, { e: '🏦', t: 'Bank' },
          { e: '💰', t: 'Money (bag)' }, { e: '💴', t: 'Yen' }, { e: '💵', t: 'Banknote' }, { e: '🪙', t: 'Coin' }, { e: '🧾', t: 'Receipt / statement' },
          { e: '🪪', t: 'ID card' }, { e: '🆔', t: 'ID' }, { e: '📛', t: 'Name badge' }, { e: '🏷️', t: 'Tag / label' }, { e: '🔖', t: 'Bookmark' },
          { e: '📌', t: 'Pin' }, { e: '👤', t: 'Person' }, { e: '👥', t: 'Group' }, { e: '✉️', t: 'Envelope / mail' }, { e: '📧', t: 'E-mail' },
          { e: '📱', t: 'Smartphone' }, { e: '☎️', t: 'Phone' }, { e: '🌐', t: 'Web / globe' }, { e: '🔗', t: 'Link' }, { e: '🏠', t: 'Home' },
          { e: '🏢', t: 'Company / building' }, { e: '🏥', t: 'Hospital' }, { e: '🏫', t: 'School' }, { e: '🎓', t: 'Graduation / degree' }, { e: '🎫', t: 'Ticket' },
          { e: '🎟️', t: 'Admission ticket' }, { e: '🎁', t: 'Gift' }, { e: '🛒', t: 'Cart' }, { e: '🛍️', t: 'Shopping' }, { e: '🚗', t: 'Car' },
          { e: '✈️', t: 'Airplane / travel' }, { e: '🍽️', t: 'Dining' }, { e: '🍳', t: 'Cooking' }, { e: '📺', t: 'TV' }, { e: '🎬', t: 'Movie' },
          { e: '🎵', t: 'Music' }, { e: '🎮', t: 'Game' }, { e: '📷', t: 'Camera' }, { e: '🖼️', t: 'Image / photo' }, { e: '📚', t: 'Books' },
          { e: '📖', t: 'Book' }, { e: '📝', t: 'Memo' }, { e: '📅', t: 'Calendar' }, { e: '📊', t: 'Chart (bar)' }, { e: '📈', t: 'Chart (rising)' },
          { e: '✅', t: 'Check / done' }, { e: '⭐', t: 'Star / favorite' }, { e: '❤️', t: 'Heart' }, { e: '🔒', t: 'Lock' }, { e: '🛡️', t: 'Shield / protection' },
          { e: '⚙️', t: 'Settings / gear' }, { e: '🧩', t: 'Puzzle' }, { e: '💡', t: 'Idea / bulb' }, { e: '🔧', t: 'Tools' }, { e: '📦', t: 'Package / box' },
          { e: '🎯', t: 'Goal' }, { e: '🐶', t: 'Dog' }, { e: '🐱', t: 'Cat' }, { e: '🌱', t: 'Plant / sprout' }, { e: '💊', t: 'Medicine' }, { e: '⚡', t: 'Electricity' },
        ],
        // Full Unicode 14.0 emoji set (1,849 emoji in the 9 Unicode groups) plus the
        // CLDR names/keywords for the active language. Fetched from /api/emoji the
        // first time the icon picker is opened, then kept for the session.
        emoji: { groups: [], names: {} },
        emojiTab: 'Recommended', emojiQuery: '', emojiLoading: false,
        toast: '', busy: false,
      };
    },
    computed: {
      // Localised label for the compact permission picker (shown via an overlaid
      // span so centering never depends on native <select> value alignment).
      permOptions() {
        return [{ v: 'view', label: this.t('View') }, { v: 'edit', label: this.t('Edit') }, { v: 'delete', label: this.t('Delete') }];
      },
      permLabel() {
        const o = this.permOptions.find(x => x.v === this.sharePanel.perm);
        return o ? o.label : this.t('View');
      },
      // ---- sharing permissions for the current collection ----
      curPerm() { return this.current ? (this.current.perm || 'owner') : 'owner'; },
      // Effective view. Only card / list / table remain; any older stored value
      // (detailed list, thumbnail cards) falls back to the plain list.
      curView() { const v = this.current ? this.current.view : 'list'; return (v === 'card' || v === 'table' || v === 'note') ? v : 'list'; },
      isOwner() { return this.current ? this.current.is_owner !== false : true; },
      // Edit lock: when a collection is locked it is view-only for everyone
      // (owner included). Only collection settings can still be changed — that's
      // how the lock is turned back off.
      isLocked() { return !!(this.current && this.current.locked); },
      canEdit() { return !this.isLocked && ['owner', 'edit', 'delete'].includes(this.curPerm); },
      canDelete() { return !this.isLocked && ['owner', 'delete'].includes(this.curPerm); },
      // editing collection settings/title is owner-only; share recipients (even
      // at the 'delete' level) cannot change them
      canSettings() { return this.isOwner; },
      collectionHasSecret() { return !!(this.current && this.current.fields && this.current.fields.some((f) => f.secret)); },
      // Warn in the record editor when this collection has image/file fields but no
      // save folder set (the user cleared it). Attachments cannot be saved until set.
      attachWarn() {
        if (!this.current || String(this.current.files_folder || '').trim() !== '') return false;
        return (this.current.fields || []).some((f) => f.type === 'image' || f.type === 'image_crop' || f.type === 'file');
      },
      // recipient viewing a shared collection whose secrets were not shared/unlocked
      secretsMasked() { return !!(this.current && this.current.is_owner === false && !this.secretUnlocked[this.current.id]); },
      shareAccessNote() {
        const map = { view: T('You have view-only access to this shared collection.'),
          edit: T('You can view and edit records in this shared collection.'),
          delete: T('You can view, edit and delete records in this shared collection.') };
        return map[this.curPerm] || '';
      },
      // Current value of the field the shared picker is bound to (for the selected outline).
      iconTargetValue() {
        const form = this[this.iconTarget];
        return form ? form.icon : '';
      },
      iconGroupsAll() {
        // The curated recommended set stays the first tab, followed by the nine Unicode
        // groups in the official emoji-ordering sequence.
        return [{ key: 'Recommended', tab: '⭐', e: this.iconChoices.map((c) => c.e) }, ...this.emoji.groups];
      },
      // Emoji shown in the grid: the active tab, or — while searching — every emoji whose
      // CLDR name or keywords match, in group order (capped so typing stays responsive).
      emojiShown() {
        const q = this.emojiQuery.trim().toLowerCase();
        const groups = this.iconGroupsAll;
        if (!q) {
          const g = groups.find((x) => x.key === this.emojiTab) || groups[0];
          return g ? g.e : [];
        }
        const nq = kana(q);
        const out = [], seen = {}, names = this.emoji.names;
        for (const g of groups) {
          for (const em of g.e) {
            if (seen[em]) continue;
            if (em === q || kana(names[em] || '').includes(nq)) { seen[em] = true; out.push(em); }
            if (out.length >= 400) return out;
          }
        }
        return out;
      },
      listFields() {
        if (!this.current) return [];
        return this.current.fields.filter((f) => !f.is_title && !f.secret && f.type !== 'image' && f.type !== 'image_crop' && f.type !== 'file').slice(0, 4);
      },
      // Fields for the list summary (list_show) and card summary (card_show).
      listGroups() { return this.buildSummaryGroups('list_show'); },
      cardGroups() { return this.buildSummaryGroups('card_show'); },
      // ---- ノート形式表示用 ----
      // 右の内容ペインに表示するレコード（未選択なら null）。タイトル一覧＝visibleRecords。
      noteCur() {
        if (this.note.id == null) return null;
        return this.visibleRecords.find((r) => r.id === this.note.id) || null;
      },
      // Fields that can be used to sort the registration order (values must be
      // readable/comparable: no encrypted secrets, no attachment references).
      reorderFields() {
        if (!this.current) return [];
        return this.current.fields.filter((f) => !f.secret && f.type !== 'image' && f.type !== 'image_crop' && f.type !== 'file');
      },
      tableFields() {
        return this.current ? this.current.fields : [];
      },
      // Key (title) fields, in field order — these form the record title.
      keyFields() {
        return this.current ? this.current.fields.filter((f) => f.is_title) : [];
      },
      // "Show emphasized fields joined at the front" — combine the emphasized
      // (title) field(s) into one leading table column (only meaningful when at
      // least one exists). Internal ids keep the historical key_* naming.
      keyHeadOn() {
        return !!(this.current && this.current.key_head && this.keyFields.length);
      },
      // Actual join string for the chosen separator setting.
      keySepStr() {
        const c = this.current || {};
        switch (c.key_sep) {
          case 'none': return '';
          case 'fullspace': return '　';
          case 'custom': return c.key_sep_char || '';
          default: return ' ';
        }
      },
      // Header label for the combined key column: the key field labels, joined.
      keyHeadLabel() {
        return this.keyFields.map((f) => f.label).join(' / ');
      },
      // Whether the effective UI language is CJK (Japanese / Chinese / Korean).
      // The full-width space (U+3000) separator is only idiomatic in CJK typography,
      // so its radio is offered only for those languages (see isCjkUi usage).
      isCjkUi() {
        void this.locale; // re-evaluate when the in-app language changes
        let lang = (this.settingsForm && this.settingsForm.language) || 'auto';
        if (lang === 'auto') {
          lang = (typeof OC !== 'undefined' && OC.getLanguage && OC.getLanguage())
            || (document.documentElement && document.documentElement.lang) || 'en';
        }
        return /^(ja|zh|ko)/.test(String(lang).toLowerCase());
      },
      // Live separator string for the value being edited in Collection settings.
      collFormSepStr() {
        const f = this.collForm || {};
        switch (f.key_sep) {
          case 'none': return '';
          case 'fullspace': return '　';
          case 'custom': return f.key_sep_char || '';
          default: return ' ';
        }
      },
      // Settings preview: the key field labels joined by the chosen separator.
      keyPreview() {
        return this.keyFields.map((f) => f.label).join(this.collFormSepStr);
      },
      // Ordered table columns. Concatenation groups (fields sharing a `concat`
      // group id) are combined into one column and pulled to the front, ordered by
      // group number; then the remaining ungrouped fields follow in field order.
      tableColumns() {
        const ATT = ['image', 'image_crop', 'file'];
        const all = this.current ? this.current.fields : [];
        const isDisp = (f) => !f.is_title && !f.secret && !ATT.includes(f.type);
        // For a concat group the LEADING member (連結元) governs Table visibility.
        const hiddenGroups = new Set(); const seenGroup = {};
        for (const f of all) { const g = f.concat || 0; if (g && seenGroup[g] === undefined) { seenGroup[g] = true; if (isDisp(f) && f.table_show === false) hiddenGroups.add(g); } }
        // Hide a plain field when its Table flag is off; hide a concat group when its
        // 連結元 is off. Title / secret / attachment (standalone) always show.
        const fields = all.filter((f) => {
          const g = f.concat || 0;
          return g ? !hiddenGroups.has(g) : !(isDisp(f) && f.table_show === false);
        });
        if (!fields.length) return [];
        const used = new Set();
        const cols = [];
        const groups = {};
        fields.forEach((f) => { const g = f.concat || 0; if (g && !used.has(f.key)) (groups[g] = groups[g] || []).push(f); });
        Object.keys(groups).map(Number).sort((a, b) => a - b).forEach((g) => {
          const m = groups[g]; m.forEach((x) => used.add(x.key));
          cols.push({ kind: 'concat', id: '__c' + g, members: m, label: '🔗 ' + m.map((x) => x.label).join(' / '), secret: m.length > 0 && m.every((x) => x.secret), keycol: m.some((x) => x.is_title) });
        });
        const rest = fields.filter((f) => !used.has(f.key));
        if (!Object.keys(groups).length) { const ti = rest.findIndex((f) => f.is_title); if (ti > 0) { const [tf] = rest.splice(ti, 1); rest.unshift(tf); } }
        rest.forEach((f) => cols.push({ kind: 'field', id: f.key, field: f, label: f.label, secret: !!f.secret, keycol: !!f.is_title }));
        return cols;
      },
      tableFrozenCol() { const c = this.tableColumns; return c.length ? c[0] : null; },
      tableScrollCols() { return this.tableColumns.slice(1); },
      // ids of table columns whose cells are all empty across the loaded records —
      // their header is rendered extra-faint (see .rt-emptycol)
      emptyColumnIds() {
        const s = new Set();
        if (!this.records.length) return s;
        for (const col of this.tableColumns) {
          const keys = col.kind === 'concat' ? col.members.map((m) => m.key) : [col.field.key];
          const hasData = this.records.some((r) => { const d = r.data || {}; return keys.some((k) => { const v = d[k]; return v != null && v !== ''; }); });
          if (!hasData) s.add(col.id);
        }
        return s;
      },
      allSelected() {
        return this.records.length > 0 && this.selectedIds.length === this.records.length;
      },
      otherCollections() {
        return this.current ? this.collections.filter((c) => c.id !== this.current.id) : this.collections;
      },
      targetTextareas() {
        return this.xfer.target ? this.xfer.target.fields.filter((f) => f.type === 'textarea') : [];
      },
      visibleRecords() { return this.records.slice(0, this.renderLimit); },
      // Quick-reference of the regex tokens that work in BOTH the server-side
      // search (PCRE, /u) and the client-side replace (JS RegExp).
      regexHelpRows() {
        return [
          { p: '.', d: T('Any single character'), e: 'a.c' },
          { p: '^  $', d: T('Start / end of the text'), e: '^AB' },
          { p: '*', d: T('0 or more of the previous'), e: 'ab*' },
          { p: '+', d: T('1 or more of the previous'), e: 'ab+' },
          { p: '?', d: T('0 or 1 of the previous'), e: 'ab?' },
          { p: '{n,m}', d: T('Between n and m repeats'), e: 'a{2,4}' },
          { p: '[ … ]', d: T('Any one listed character'), e: '[abc]' },
          { p: '[^ … ]', d: T('Any character not listed'), e: '[^0-9]' },
          { p: '[a-z]', d: T('A character range'), e: '[A-Z0-9]' },
          { p: '\\d  \\D', d: T('Digit / non-digit'), e: '\\d{3}' },
          { p: '\\w  \\W', d: T('Word char / non-word'), e: '\\w+' },
          { p: '\\s  \\S', d: T('Whitespace / non-whitespace'), e: 'a\\sb' },
          { p: 'a|b', d: T('Either a or b'), e: 'cat|dog' },
          { p: '( … )', d: T('Group (for |, repeats, $1)'), e: '(ab)+' },
          { p: '\\', d: T('Treat a special char literally'), e: '\\.  \\+  \\*' },
        ];
      },
      // Page 2 of the regex help: practical examples (pattern / meaning / a
      // string it would match). Uses only tokens valid in search and replace.
      regexExampleRows() {
        return [
          { p: '^090', d: T('Starts with “090”'), e: '090-1234-5678' },
          { p: '\\d{3}-\\d{4}', d: T('3 digits – 4 digits'), e: '123-4567' },
          { p: '@gmail\\.com$', d: T('A gmail.com address'), e: 'taro@gmail.com' },
          { p: '(?i)yahoo', d: T('“yahoo” in any case'), e: 'Yahoo / YAHOO' },
          { p: '田中|佐藤', d: T('Either of the two'), e: '田中花子' },
          { p: '.{12,}', d: T('12 characters or more'), e: 'long-passphrase' },
          { p: '\\.(jpg|png)$', d: T('Ends with .jpg or .png'), e: 'photo.png' },
        ];
      },
      fpVisible() {
        return this.filePicker.entries.filter((x) => x.is_dir || this.fpSelectable(x));
      },
      contactsTotal() {
        return (this.contactsImport.books || []).reduce((s, b) => s + (b.count || 0), 0);
      },
      tablesSelectedTitle() {
        const tb = (this.tablesImport.tables || []).find((x) => x.id === this.tablesImport.selected);
        return tb ? tb.title : '';
      },
      importExamplePh() {
        return T('CSV example) name,url,username,password\nGitHub,https://github.com,ktec,...\n\nJSON example) [{"name":"GitHub","url":"https://github.com"}]');
      },
      recordsById() {
        const m = {};
        for (const r of this.records) m[r.id] = r;
        return m;
      },
      // ---- password generator ----
      // The field's input rule (if any) narrows what the generator may produce, so
      // a generated value can never be rejected by the very rule that field carries.
      pwgenRule() { return this.pwgen.field ? this.fieldRule(this.pwgen.field) : null; },
      pwgenCharset() { const o = this.pwgenRule; return (o && o.charset) || ''; },
      pwgenIsHex() { return this.pwgenCharset === 'hex'; }, // fixed 0-9A-F alphabet, no class/symbol controls
      pwgenLookalikeUsable() { return !this.pwgenIsHex; },
      pwgenSymbolsAvail() { return this.pwgenAvail('symbols'); },
      // rows for the class list (with per-class availability and effective set)
      pwgenClassRows() {
        const meta = {
          upper: 'Uppercase (A–Z)', lower: 'Lowercase (a–z)',
          digits: 'Digits (0–9)', symbols: 'Symbols',
        };
        return PWGEN_CLASSES.map((k) => ({ k, label: meta[k], avail: this.pwgenAvail(k), set: this.pwgenClassSet(k) }));
      },
      // classes that will actually contribute characters: on + allowed + non-empty set
      pwgenActive() {
        return this.pwgenClassRows.filter((c) => this.pwgen[c.k] && c.avail && c.set.length);
      },
      // symbol chips (the whole master palette, marked selected / look-alike)
      pwgenSymbolChips() {
        return PWGEN_SETS.symbols.split('').map((ch) => ({
          ch, on: this.pwgen.symbolSet.indexOf(ch) >= 0, lookalike: PWGEN_LOOKALIKE.indexOf(ch) >= 0,
        }));
      },
      // hard bounds on total length, from the field rule (never below sum of the mins)
      pwgenHardMin() { const o = this.pwgenRule; return Math.max(1, (o && o.min) ? o.min : 1); },
      pwgenHardMax() { const o = this.pwgenRule; return Math.max(this.pwgenHardMin, Math.min(30, (o && o.max) ? o.max : 30)); },
      pwgenMinSum() { return this.pwgenActive.reduce((s, c) => s + (Number(this.pwgen.min[c.k]) || 0), 0); },
      pwgenMaxSum() {
        // sum of caps; a class with no cap contributes the whole length budget
        let s = 0;
        for (const c of this.pwgenActive) { const m = this.pwgen.max[c.k]; s += (m == null ? this.pwgenHardMax : m); }
        return s;
      },
      // the length slider's live floor/ceiling after reconciling every constraint
      pwgenMin() { return Math.max(this.pwgenHardMin, this.pwgenMinSum); },
      pwgenMax() { return Math.max(this.pwgenMin, Math.min(this.pwgenHardMax, this.pwgenMaxSum)); },
      pwgenStrength() {
        // entropy of the value actually produced: length x log2(effective alphabet)
        let pool = 0;
        for (const c of this.pwgenActive) pool += c.set.length;
        if (this.pwgenIsHex) pool = 16;
        const len = (this.pwgen.value || '').length;
        const bits = (pool > 1 && len) ? Math.round(len * Math.log2(pool)) : 0;
        let cls = 'w1', label = 'Weak';
        if (bits >= 128) { cls = 'w4'; label = 'Very strong'; }
        else if (bits >= 90) { cls = 'w3'; label = 'Strong'; }
        else if (bits >= 60) { cls = 'w2'; label = 'Fair'; }
        return { bits, cls, label, pct: Math.max(3, Math.min(100, Math.round((bits / 128) * 100))) };
      },
      // Whether "first character is a letter" can apply: at least one letter class is active.
      pwgenFirstAlphaUsable() { return this.pwgenActive.some((c) => c.k === 'upper' || c.k === 'lower'); },
      // Approximate number of possible passwords, shown in parentheses after the entropy.
      // Japanese UI gets myriad units (億/兆/垓…); other locales get a compact ×10ⁿ form.
      pwgenCombos() {
        let pool = 0;
        for (const c of this.pwgenActive) pool += c.set.length;
        if (this.pwgenIsHex) pool = 16;
        const len = (this.pwgen.value || '').length;
        if (pool < 2 || len < 1) return '';
        const combos = Math.pow(pool, len);
        if (!isFinite(combos) || combos < 2) return '';
        void this.locale; // re-evaluate when the in-app language changes
        let lang = (this.settingsForm && this.settingsForm.language) || 'auto';
        if (lang === 'auto') {
          lang = (typeof OC !== 'undefined' && OC.getLanguage && OC.getLanguage())
            || (document.documentElement && document.documentElement.lang) || 'en';
        }
        if (/^ja/.test(String(lang).toLowerCase())) return '（' + this.pwgenJaMyriad(combos) + '）';
        const exp = Math.floor(Math.log10(combos));
        const mant = combos / Math.pow(10, exp);
        const sup = String(exp).split('').map((d) => '⁰¹²³⁴⁵⁶⁷⁸⁹'[+d] || d).join('');
        return '(≈ ' + mant.toFixed(1) + '×10' + sup + ')';
      },
      pwgenNote() { return this.pwgen.field ? this.ruleHint(this.pwgen.field) : ''; },
    },
    watch: {
      // the picker floats above the dialogs, so it must never outlive the one that opened it
      modal() { this.iconPickerOpen = false; this.closePwGen(); },
    },
    async mounted() {
      rootProxy = this;
      const rootEl = document.getElementById('regibase-root');
      this.version = (rootEl && rootEl.getAttribute('data-version')) || '';
      try { history.replaceState({ cid: null }, ''); } catch (e) { /* ignore */ }
      window.addEventListener('popstate', (e) => {
        if (!this.authenticated) return;
        if (this.modal) {
          this.modal = null;
          this.pushNav({ cid: this.current ? this.current.id : null });
          return;
        }
        const cid = e.state && e.state.cid;
        if (cid) this.selectCollection(cid, false);
        else this.goHome(false);
      });
      // Ctrl/Cmd+Z = undo the last change (ignored while typing in a field).
      window.addEventListener('keydown', (e) => {
        if (!this.authenticated) return;
        if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && (e.key === 'z' || e.key === 'Z')) {
          const el = document.activeElement;
          if (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) && !el.readOnly) return;
          if (this.modal && this.modal.type !== 'history') return; // don't fight modal editing
          e.preventDefault();
          this.doUndo();
        }
      });
      await this.boot();
      this.authenticated = true;
      this.refreshUndo();
    },
    methods: {
      // reading this.locale makes every t() call re-evaluate when the language changes
      t(text, vars) { return this.locale, T(text, vars); },
      async applyLanguage(lang) {
        if (!lang || lang === 'auto') {
          i18nOverride = null;
        } else {
          try {
            const r = await api('i18n/' + encodeURIComponent(lang));
            i18nOverride = (r && r.translations) ? r.translations : {};
          } catch (e) { i18nOverride = null; }
        }
        this.locale++;
        // emoji names/keywords are language-specific too — drop them so the picker refetches
        this.emoji = { groups: [], names: {} };
        // built-in templates are translated server-side by the RegiBase language setting;
        // refresh the cached list so the picker matches the newly chosen language.
        if (this.authenticated && this.templates.length) { try { this.templates = await api('templates'); } catch (e) { /* keep previous */ } }
      },
      newCollDesc() {
        const name = this.current ? this.current.name : '';
        return this.xfer.mode === 'move'
          ? T('Create a new collection with the same fields as “{name}” and move the selected records into it.', { name })
          : T('Create a new collection with the same fields as “{name}” and copy the selected records into it.', { name });
      },
      transferLabel() {
        const n = this.xfer.recordIds.length;
        const toNew = this.xfer.targetId === '__newcoll__';
        const move = this.xfer.mode === 'move';
        if (toNew) return move ? T('Move {n} items to new collection', { n }) : T('Copy {n} items to new collection', { n });
        return move ? T('Move {n} items', { n }) : T('Copy {n} items', { n });
      },
      async boot() {
        // Fire the collections request up front so it overlaps with settings /
        // language loading instead of waiting for them (one fewer round-trip on boot).
        const collectionsP = api('collections').catch(() => null);
        try {
          const s = await api('settings'); this.settingsForm = s; this.theme = s.theme || 'auto';
          if (s.apps) this.apps = { contacts: s.apps.contacts !== false, tables: s.apps.tables !== false, calendar: s.apps.calendar !== false };
          this.languages = s.languages || [];
          if (s.language && s.language !== 'auto') await this.applyLanguage(s.language);
          this.enc = { enabled: !!s.enc_enabled, unlocked: false, salt: s.enc_salt || '', verifier: s.enc_verifier || '' };
          if (this.enc.enabled) await this.tryAutoUnlock();
        } catch (e) { /* ignore */ }
        this.applyTheme();
        try {
          if (window.matchMedia) {
            const mq = window.matchMedia('(prefers-color-scheme: dark)');
            const h = () => { if (this.theme === 'auto') this.applyTheme(); };
            mq.addEventListener ? mq.addEventListener('change', h) : mq.addListener(h);
          }
        } catch (e) { /* ignore */ }
        // templates power only the "New collection" picker; fetch them lazily
        // when that picker opens so the home screen appears as soon as collections load.
        const cols = await collectionsP;
        if (cols) { this.collections = cols; this.refreshUndo(); } else { await this.loadCollections(); }
        // Return to the collection that was open before a **reload within the same
        // browsing session**. A new session — the browser was reopened, or the login
        // session was lost and re-established — starts at the home collection list.
        // sessionStorage is per browsing session (cleared when it ends); the 401
        // handler also clears the flag so a lost login session lands on home too.
        // The collection is only restored if it is still in the visible list, so a
        // secret (hidden) or deleted collection never reopens.
        try {
          let sameSession = false;
          try { sameSession = sessionStorage.getItem('rb-session') === '1'; sessionStorage.setItem('rb-session', '1'); } catch (e) { /* ignore */ }
          const saved = Number(localStorage.getItem('rb-open-coll') || 0);
          if (sameSession && saved && this.collections.some((c) => c.id === saved)) {
            await this.selectCollection(saved, false);
          }
        } catch (e) { /* ignore */ }
      },
      // ---- theme (follow Nextcloud, or force dark/light) ----
      parseColor(s) {
        if (!s) return null;
        s = s.trim();
        let m = s.match(/^#([0-9a-f]{3})$/i);
        if (m) { const h = m[1]; return [parseInt(h[0] + h[0], 16), parseInt(h[1] + h[1], 16), parseInt(h[2] + h[2], 16)]; }
        m = s.match(/^#([0-9a-f]{6})$/i);
        if (m) { const h = m[1]; return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]; }
        m = s.match(/rgba?\(([^)]+)\)/i);
        if (m) { const p = m[1].split(',').map((x) => parseFloat(x)); return [p[0], p[1], p[2]]; }
        return null;
      },
      detectNcDark() {
        try {
          const bg = getComputedStyle(document.body).getPropertyValue('--color-main-background');
          const rgb = this.parseColor(bg);
          if (rgb) { const lum = (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255; return lum < 0.5; }
        } catch (e) { /* ignore */ }
        return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
      },
      applyTheme() {
        const dark = this.theme === 'dark' ? true : this.theme === 'light' ? false : this.detectNcDark();
        const el = document.getElementById('regibase-root');
        if (el) el.setAttribute('data-rbtheme', dark ? 'dark' : 'light');
      },
      async loadCollections() {
        const base = await api('collections');
        // Re-merge any secret collections revealed this session (the base list
        // excludes them). Keeps counts fresh and surfaces newly-added ones.
        if (secretPins.size) {
          const seen = new Set(base.map((c) => c.id));
          for (const pin of secretPins) {
            let extra = [];
            try { extra = await api('collections-reveal', { method: 'POST', body: JSON.stringify({ pin }) }); } catch (e) { extra = []; }
            for (const c of (extra || [])) { if (!seen.has(c.id)) { seen.add(c.id); base.push(c); } }
          }
          this.secretShown = base.some((c) => c.secret);
        }
        this.collections = base;
        this.refreshUndo();
      },
      // "Secret toggle" button: if secret collections are shown, hide them again;
      // otherwise open the 6-digit prompt to reveal them for this session.
      openSecretToggle() {
        if (this.secretShown) { this.hideSecretCollections(); return; }
        this.secretForm = { cells: ['', '', '', '', '', ''], pin: '', err: '', busy: false };
        this.modal = { type: 'secretReveal' };
        this.$nextTick(() => { const c = this.$refs.cells; if (c && c[0]) c[0].focus(); });
      },
      // ---- 6-digit secret key: one box per digit (OTP-style) ----
      syncSecretPin() { this.secretForm.pin = this.secretForm.cells.join(''); },
      onSecretCellInput(i, e) {
        const ch = (e.target.value || '').replace(/\D/g, '').slice(-1);
        this.secretForm.cells[i] = ch;
        e.target.value = ch; // reflect (strips any non-digit)
        this.secretForm.err = '';
        this.syncSecretPin();
        const c = this.$refs.cells;
        if (ch && i < 5 && c && c[i + 1]) c[i + 1].focus();
      },
      onSecretCellKey(i, e) {
        const c = this.$refs.cells;
        if (e.key === 'Backspace') {
          if (!this.secretForm.cells[i] && i > 0) {
            e.preventDefault();
            this.secretForm.cells[i - 1] = '';
            this.syncSecretPin();
            if (c && c[i - 1]) c[i - 1].focus();
          } else if (this.secretForm.cells[i]) {
            this.secretForm.cells[i] = '';
            this.syncSecretPin();
          }
        } else if (e.key === 'ArrowLeft' && i > 0 && c && c[i - 1]) { e.preventDefault(); c[i - 1].focus(); }
        else if (e.key === 'ArrowRight' && i < 5 && c && c[i + 1]) { e.preventDefault(); c[i + 1].focus(); }
        else if (e.key === 'Enter') { this.submitSecretReveal(); }
      },
      onSecretPaste(e) {
        const t = ((e.clipboardData && e.clipboardData.getData('text')) || '').replace(/\D/g, '').slice(0, 6);
        if (!t) return;
        e.preventDefault();
        const cells = ['', '', '', '', '', ''];
        for (let j = 0; j < t.length; j++) cells[j] = t[j];
        this.secretForm.cells = cells;
        this.secretForm.err = '';
        this.syncSecretPin();
        const c = this.$refs.cells;
        const fi = Math.min(t.length, 5);
        if (c && c[fi]) c[fi].focus();
      },
      async submitSecretReveal() {
        const pin = String(this.secretForm.pin || '').trim();
        if (!/^\d{6}$/.test(pin)) { this.secretForm.err = T('Enter the 6-digit secret key.'); return; }
        this.secretForm.busy = true; this.secretForm.err = '';
        let matches = [];
        try { matches = await api('collections-reveal', { method: 'POST', body: JSON.stringify({ pin }) }); }
        catch (e) { this.secretForm.busy = false; this.secretForm.err = T('Failed') + ': ' + (e.message || e); return; }
        this.secretForm.busy = false;
        if (!matches || !matches.length) { this.secretForm.err = T('No secret collection matches that key.'); return; }
        secretPins.add(pin); this.secretShown = true;
        await this.loadCollections();
        this.modal = null;
        this.showToast(T('{n} secret collection(s) shown', { n: matches.length }));
      },
      // Hide every revealed secret collection again (forget the entered keys).
      async hideSecretCollections() {
        secretPins.clear(); this.secretShown = false;
        // if the collection currently open is now hidden, return to the home view
        if (this.current && this.current.secret) { this.current = null; this.records = []; }
        await this.loadCollections();
        this.showToast(T('Secret collections hidden'));
      },
      async selectCollection(id, push = true) {
        // a password-protected share must be unlocked (once per session) before opening
        const meta = this.collections.find((c) => c.id === id);
        if (meta && meta.shared_with_me && meta.has_password && !sharedUnlocked[id]) {
          this.promptShareUnlock(id, meta.name, () => this.selectCollection(id, push));
          return;
        }
        this.sidebarOpen = false; this.search = ''; this.selectedIds = [];
        this.note = { id: null };
        this.current = await api('collections/' + id);
        // remember the open collection so a page reload returns to it (see boot())
        try { localStorage.setItem('rb-open-coll', String(id)); } catch (e) { /* ignore */ }
        this.secretUnlocked = { ...this.secretUnlocked, [id]: !!sharedKeys[id] };
        await this.loadRecords();
        if (push) this.pushNav({ cid: id });
      },
      pushNav(state) { try { history.pushState(state, ''); } catch (e) { /* ignore */ } },
      async loadRecords() {
        if (!this.current) return;
        const params = [];
        if (this.search) params.push('q=' + encodeURIComponent(this.search));
        if (this.search && this.searchRegex) params.push('regex=1');
        if (this.current.record_sort) params.push('sort=' + encodeURIComponent(this.normSort(this.current.record_sort)));
        const qs = params.length ? '?' + params.join('&') : '';
        this.records = await api('collections/' + this.current.id + '/records' + qs);
        this.renderLimit = 200;
        this.refreshUndo();
        // encrypt any import-left plaintext secrets in the background (no await)
        this.autoEncryptCurrent();
      },
      toggleSelectionMode() {
        this.selectionMode = !this.selectionMode;
        try { localStorage.setItem('rb-selmode', this.selectionMode ? '1' : '0'); } catch (e) {}
        if (!this.selectionMode) { this.clearSelection(); }
      },
      // Infinite scroll: when the scroll container nears its bottom, reveal 50
      // more rows (no need to press "Show more"). Self-limiting because each
      // batch grows the content well past the trigger threshold.
      onScrollNearBottom(e) {
        const el = e.target;
        if (el.scrollHeight - el.scrollTop - el.clientHeight < 260 && this.renderLimit < this.records.length) {
          this.renderLimit += 50;
        }
      },
      contentEl() { return document.querySelector('#regibase-root .content'); },
      scrollToTop() { const el = this.contentEl(); if (el) el.scrollTo({ top: 0, behavior: 'smooth' }); },
      scrollToBottom() {
        this.renderLimit = Math.max(this.renderLimit, this.records.length);
        this.$nextTick(() => { const el = this.contentEl(); if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' }); });
      },
      async copyRecord(rec) {
        const lines = [];
        for (const f of this.current.fields) {
          let v = rec.data[f.key];
          if (v == null || v === '') continue;
          if (f.type === 'image' || f.type === 'image_crop') { lines.push(f.label + ': ' + T('[image]')); continue; }
          if (f.type === 'file') { lines.push(f.label + ': ' + this.fileName(v)); continue; }
          if (f.secret) v = await this.secretPlain(v);
          lines.push(f.label + ': ' + v);
        }
        const text = lines.join('\n');
        navigator.clipboard.writeText(text).then(() => this.showToast(T('Copied the whole card'))).catch(() => this.showToast(T('Copy failed')));
      },
      // Grab-to-scroll for the spreadsheet view's scrollable area (mouse only;
      // touch keeps native panning). The frozen 1st column stays clickable.
      tableDown(e) {
        if (e.pointerType && e.pointerType !== 'mouse') return;
        if (e.button != null && e.button !== 0) return;
        const t = e.target;
        if (t && (t.closest('.rt-frozen') || t.closest('input, button, a'))) return;
        const wrap = e.currentTarget;
        this.tableDrag = { active: true, startX: e.clientX, startScroll: wrap.scrollLeft, el: wrap, pid: e.pointerId };
        try { wrap.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
        e.preventDefault();
      },
      tableMove(e) {
        if (!this.tableDrag.active || !this.tableDrag.el) return;
        this.tableDrag.el.scrollLeft = this.tableDrag.startScroll - (e.clientX - this.tableDrag.startX);
      },
      tableUp() {
        if (!this.tableDrag.active) return;
        try { this.tableDrag.el.releasePointerCapture(this.tableDrag.pid); } catch (err) { /* ignore */ }
        this.tableDrag = { active: false, startX: 0, startScroll: 0, el: null, pid: null };
      },
      async setView(v) {
        if (!this.current || this.current.view === v) return;
        // recipients without settings rights change the view locally only (not persisted)
        if (!this.canSettings) { this.current.view = v; return; }
        const c = await api('collections/' + this.current.id, { method: 'PATCH', body: JSON.stringify({ view: v }) });
        this.current.view = c.view;
        const inList = this.collections.find((x) => x.id === this.current.id);
        if (inList) inList.view = c.view;
      },
      normSort(s) { return (s === 'kana_title' || s === 'kana_reading') ? 'title_asc' : s; },
      async setSort(v) {
        if (!this.current || this.normSort(this.current.record_sort) === v) return;
        if (!this.canSettings) { this.current.record_sort = v; await this.loadRecords(); return; }
        const c = await api('collections/' + this.current.id, { method: 'PATCH', body: JSON.stringify({ record_sort: v }) });
        this.current.record_sort = c.record_sort;
        const inList = this.collections.find((x) => x.id === this.current.id);
        if (inList) inList.record_sort = c.record_sort;
        await this.loadRecords();
      },
      xferSample(sf) {
        for (const id of this.xfer.recordIds) {
          const rec = this.recordsById[id];
          if (!rec) continue;
          const v = rec.data[sf.key];
          if (v == null || v === '') continue;
          if (sf.secret) return '••••••';
          if (sf.type === 'image' || sf.type === 'image_crop') return T('🖼 Image');
        if (sf.type === 'file') return T('📎 File');
          const s = String(v).replace(/\s+/g, ' ').trim();
          return s.length > 28 ? s.slice(0, 28) + '…' : s;
        }
        return '';
      },
      imgUrl(id) { return id ? BASE + 'api/images/' + id : ''; },
      imageSrc(rec) {
        const f = this.current.fields.find((x) => (x.type === 'image' || x.type === 'image_crop') && rec.data[x.key]);
        return f ? this.imgUrl(rec.data[f.key]) : '';
      },
      cellPreview(rec, f) {
        const v = rec.data[f.key];
        if (v == null || v === '') return '';
        if (f.secret) return '••••••••';
        if (f.type === 'image' || f.type === 'image_crop') return '🖼';
        if (f.type === 'file') return '📎';
        const s = String(v);
        return s.length > 40 ? s.slice(0, 40) + '…' : s;
      },
      // Resolve a saved field's own concat separator (placed after it in a group).
      fieldSep(f) {
        if (!f) return '';
        switch (f.concat_sep) {
          case 'none': return '';
          case 'fullspace': return '　';
          case 'custom': return f.concat_sep_char || '';
          default: return ' ';
        }
      },
      // Combine a group's field values (field order), each pair joined by the
      // earlier field's own separator. Empty values are skipped, but a paren
      // separator ('paren' = half-width, 'parenfull' = full-width) is carried
      // forward even when its own field is empty — so 名 being blank still yields
      // 姓（ふりがなせいふりがなめい）. Open brackets are closed (LIFO) at the end,
      // and a bracket replaces any pending text separator in front of it.
      concatText(rec, members) {
        let out = ''; let started = false;
        let pendingText = '';       // text separator to place before the next value
        const pendingParens = [];   // paren separators to open before the next value
        const closers = [];
        for (const m of members) {
          const v = rec.data ? rec.data[m.key] : '';
          const isParen = (m.concat_sep === 'paren' || m.concat_sep === 'parenfull');
          if (v != null && v !== '') {
            const val = m.secret ? '••••••••' : String(v);
            if (!started) { out = val; started = true; }
            else if (pendingParens.length) {
              for (const t of pendingParens) { out += (t === 'parenfull' ? '（' : '('); closers.push(t === 'parenfull' ? '）' : ')'); }
              out += val;
            } else { out += pendingText + val; }
            pendingParens.length = 0; pendingText = '';
            // this field's own separator becomes the baseline for the next value
            if (isParen) pendingParens.push(m.concat_sep); else pendingText = this.fieldSep(m);
          } else if (isParen) {
            pendingParens.push(m.concat_sep); // empty field: still honour its paren
          }
        }
        while (closers.length) out += closers.pop();
        return out;
      },
      // Text shown for a table column (real field, concat group, or emphasis title).
      colText(rec, col) {
        if (!col) return '';
        if (col.kind === 'title') return rec.title;
        if (col.kind === 'concat') return this.concatText(rec, col.members);
        return this.cellPreview(rec, col.field);
      },
      colImg(rec, col) {
        if (col && col.kind === 'field' && (col.field.type === 'image' || col.field.type === 'image_crop')) {
          const v = rec.data && rec.data[col.field.key]; return v ? this.imgUrl(v) : '';
        }
        return '';
      },
      readFileAsDataURL(file) {
        return new Promise((resolve, reject) => {
          const r = new FileReader();
          r.onload = () => resolve(String(r.result || ''));
          r.onerror = () => reject(new Error(T('Could not load the image')));
          r.readAsDataURL(file);
        });
      },
      postImage(dataUrl, key) {
        return api('images', { method: 'POST', body: JSON.stringify({ dataUrl, collection_id: this.current ? this.current.id : 0 }) })
          .then(({ id }) => { this.form[key] = id; });
      },
      async handleImageFile(file, f) {
        if (!file) return;
        if (file.type && file.type.indexOf('image/') !== 0) { alert(T('Please choose an image file')); return; }
        if (f.type === 'image_crop') {
          try { const dataUrl = await this.readFileAsDataURL(file); this.openCropper(dataUrl, f); }
          catch (e) { alert(T('Could not load the image')); }
          return;
        }
        const o = (f.options && typeof f.options === 'object') ? f.options : {};
        const max = o.max === 0 ? 0 : (o.max > 0 ? o.max : 1600);
        try {
          const dataUrl = max > 0 ? await this.downscaleImage(file, max, 0.85, o.format || 'jpeg') : await this.readFileAsDataURL(file);
          await this.postImage(dataUrl, f.key);
        } catch (err) { alert(T('Failed to import the image') + ': ' + (err.message || err)); }
      },
      onImagePick(e, f) {
        const file = e.target.files && e.target.files[0];
        this.handleImageFile(file, f).finally(() => { e.target.value = ''; });
      },
      onImageDrop(e, f) {
        this.dropKey = null;
        const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
        this.handleImageFile(file, f);
      },
      onDropLeave(key) { if (this.dropKey === key) this.dropKey = null; },
      // ---- cropper ----
      parseRatio(str) {
        if (!str || str === 'free') return null;
        const m = String(str).split(':').map(Number);
        return (m.length === 2 && m[0] > 0 && m[1] > 0) ? m[0] / m[1] : null;
      },
      initCropBox(W, H, ratio) {
        if (!ratio) return { x: Math.round(W * 0.1), y: Math.round(H * 0.1), w: Math.round(W * 0.8), h: Math.round(H * 0.8) };
        let w = W, h = w / ratio;
        if (h > H) { h = H; w = h * ratio; }
        w = Math.round(w * 0.9); h = Math.round(h * 0.9);
        return { x: Math.round((W - w) / 2), y: Math.round((H - h) / 2), w, h };
      },
      openCropper(src, f) {
        const o = (f.options && typeof f.options === 'object') ? f.options : {};
        const ratioLabel = o.ratio || '1:1';
        const ratio = this.parseRatio(ratioLabel);
        const out = o.out > 0 ? o.out : 600;
        const img = new Image();
        img.onload = () => {
          const maxW = 480, maxH = 380;
          const s = Math.min(maxW / img.naturalWidth, maxH / img.naturalHeight, 1);
          const dw = Math.max(1, Math.round(img.naturalWidth * s));
          const dh = Math.max(1, Math.round(img.naturalHeight * s));
          this._cropImg = img;
          this.cropper = { open: true, key: f.key, src, imgW: img.naturalWidth, imgH: img.naturalHeight, dispW: dw, dispH: dh, ratio, ratioLabel, out, format: o.format || 'jpeg', box: this.initCropBox(dw, dh, ratio), drag: null, busy: false };
        };
        img.onerror = () => alert(T('Could not load the image'));
        img.src = src;
      },
      recropCurrent(f) { if (this.form[f.key]) this.openCropper(this.imgUrl(this.form[f.key]), f); },
      cropDown(e, mode, corner) {
        const stage = document.querySelector('#regibase-root .crop-stage');
        this.cropper.drag = { mode, corner, sx: e.clientX, sy: e.clientY, box: { ...this.cropper.box }, stage: stage ? stage.getBoundingClientRect() : { left: 0, top: 0 } };
        const mv = (ev) => this.cropMove(ev);
        const up = () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); if (this.cropper) this.cropper.drag = null; };
        window.addEventListener('pointermove', mv);
        window.addEventListener('pointerup', up);
      },
      cropMove(e) {
        const S = this.cropper; const d = S && S.drag; if (!d) return;
        const W = S.dispW, H = S.dispH, MIN = 24;
        if (d.mode === 'move') {
          const dx = e.clientX - d.sx, dy = e.clientY - d.sy;
          S.box = {
            x: Math.min(Math.max(0, d.box.x + dx), W - d.box.w),
            y: Math.min(Math.max(0, d.box.y + dy), H - d.box.h),
            w: d.box.w, h: d.box.h,
          };
          return;
        }
        const px = Math.min(Math.max(0, e.clientX - d.stage.left), W);
        const py = Math.min(Math.max(0, e.clientY - d.stage.top), H);
        const b = d.box, ratio = S.ratio;
        let ax, ay, dirX, dirY;
        if (d.corner === 'br') { ax = b.x; ay = b.y; dirX = 1; dirY = 1; }
        else if (d.corner === 'tl') { ax = b.x + b.w; ay = b.y + b.h; dirX = -1; dirY = -1; }
        else if (d.corner === 'tr') { ax = b.x; ay = b.y + b.h; dirX = 1; dirY = -1; }
        else { ax = b.x + b.w; ay = b.y; dirX = -1; dirY = 1; }
        let nw = Math.max(MIN, (px - ax) * dirX);
        let nh = ratio ? nw / ratio : Math.max(MIN, (py - ay) * dirY);
        const maxW = dirX > 0 ? W - ax : ax;
        const maxH = dirY > 0 ? H - ay : ay;
        if (nw > maxW) { nw = maxW; if (ratio) nh = nw / ratio; }
        if (nh > maxH) { nh = maxH; if (ratio) nw = nh * ratio; }
        nw = Math.max(MIN, nw); nh = Math.max(MIN, nh);
        S.box = { x: dirX > 0 ? ax : ax - nw, y: dirY > 0 ? ay : ay - nh, w: nw, h: nh };
      },
      async confirmCrop() {
        const S = this.cropper;
        if (!this._cropImg) return;
        this.cropper.busy = true;
        try {
          const scale = S.imgW / S.dispW;
          const sx = S.box.x * scale, sy = S.box.y * scale, sw = S.box.w * scale, sh = S.box.h * scale;
          const outW = S.ratio ? Math.round(S.out) : Math.round(Math.min(S.out, sw));
          const outH = S.ratio ? Math.round(S.out / S.ratio) : Math.max(1, Math.round(outW * (sh / sw)));
          const cv = document.createElement('canvas');
          cv.width = outW; cv.height = Math.max(1, outH);
          cv.getContext('2d').drawImage(this._cropImg, sx, sy, sw, sh, 0, 0, outW, outH);
          const dataUrl = cv.toDataURL(this.formatMime(S.format || 'jpeg'), 0.9);
          await this.postImage(dataUrl, S.key);
          this.cropper.open = false;
        } catch (e) { alert(T('Failed to crop') + ': ' + (e.message || e)); }
        finally { this.cropper.busy = false; }
      },
      // ---- file / notes attachments ----
      setFileMeta(id, meta) { this.fileMetaCache = { ...this.fileMetaCache, [String(id)]: meta }; },
      async loadFileMeta(id) {
        id = String(id);
        if (!id || this.fileMetaCache[id]) return;
        this.setFileMeta(id, { id, name: T('Loading…'), ext: '', is_note: false, _loading: true });
        try { this.setFileMeta(id, await api('files/' + id + '/meta')); }
        catch (e) { this.setFileMeta(id, { id, name: T('(not found)'), ext: '', is_note: false, _missing: true }); }
      },
      preloadFileMetas(fields, data) {
        for (const f of fields) if (f.type === 'file' && data[f.key]) this.loadFileMeta(data[f.key]);
      },
      fileName(id) { const m = this.fileMetaCache[String(id)]; return m ? m.name : T('Attachment'); },
      fileIcon(id) {
        const m = this.fileMetaCache[String(id)];
        const ext = m ? m.ext : '';
        return ({ pdf: '📕', docx: '📘', xlsx: '📗', odt: '📄', ods: '📊', odp: '📙', md: '📝', txt: '📝' })[ext] || (m && m.is_note ? '📝' : '📎');
      },
      async openAttachment(id) {
        id = String(id);
        let m = this.fileMetaCache[id];
        if (!m || m._loading) { await this.loadFileMeta(id); m = this.fileMetaCache[id]; }
        const url = (m && m.is_note) ? NC('/apps/notes/note/' + id) : NC('/f/' + id);
        window.open(url, '_blank', 'noopener');
      },
      downloadAttachment(id) {
        const a = document.createElement('a');
        a.href = BASE + 'api/files/' + id; a.download = ''; a.rel = 'noopener';
        document.body.appendChild(a); a.click(); a.remove();
      },
      async handleDocFile(file, f) {
        if (!file) return;
        const name = file.name || '';
        const ext = (name.split('.').pop() || '').toLowerCase();
        if (!['pdf', 'odt', 'ods', 'odp', 'docx', 'xlsx'].includes(ext)) { alert(T('Supported formats: PDF / Word (docx) / Excel (xlsx) / ODF (odt, ods, odp)')); return; }
        try {
          const dataUrl = await this.readFileAsDataURL(file);
          const res = await api('files', { method: 'POST', body: JSON.stringify({ dataUrl, name, collection_id: this.current ? this.current.id : 0 }) });
          this.form[f.key] = res.id;
          this.setFileMeta(res.id, { id: res.id, name: res.name, ext, is_note: false, kind: ext === 'pdf' ? 'pdf' : 'office' });
          this.showToast(T('File attached'));
        } catch (e) { alert(T('Failed to import the file') + ': ' + (e.message || e)); }
      },
      onDocPick(e, f) { const file = e.target.files && e.target.files[0]; this.handleDocFile(file, f).finally(() => { e.target.value = ''; }); },
      onDocDrop(e, f) { this.dropKey = null; const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]; this.handleDocFile(file, f); },
      // ---- app's own file browser (proper "Select"/"Cancel"; Select disabled until a file is chosen) ----
      pickImageFromNc(f) { this.openFilePicker(f, 'image'); },
      pickDocFromNc(f) { this.openFilePicker(f, 'doc'); },
      openFilePicker(field, mode) {
        this.filePicker = { open: true, field, mode, path: '', parent: null, entries: [], selected: null, loading: true, error: '' };
        this.fpLoad('');
      },
      async fpLoad(path) {
        this.filePicker.loading = true; this.filePicker.error = ''; this.filePicker.selected = null;
        try {
          const r = await api('files/browse?path=' + encodeURIComponent(path));
          this.filePicker.path = r.path || '';
          this.filePicker.parent = (r.parent === undefined ? null : r.parent);
          this.filePicker.entries = Array.isArray(r.entries) ? r.entries : [];
        } catch (e) {
          this.filePicker.error = T('Could not open the folder');
          this.filePicker.entries = [];
        } finally { this.filePicker.loading = false; }
      },
      fpSelectable(x) {
        if (x.is_dir) return false;
        if (this.filePicker.mode === 'folder') return false; // folder mode: pick a location, not a file
        if (this.filePicker.mode === 'image') return !!x.is_image;
        const ext = (x.name.split('.').pop() || '').toLowerCase();
        return ['pdf', 'odt', 'ods', 'odp', 'docx', 'xlsx', 'md', 'txt'].includes(ext);
      },
      fpIcon(x) {
        if (x.is_image) return '🖼';
        const ext = (x.name.split('.').pop() || '').toLowerCase();
        if (ext === 'pdf') return '📕';
        if (['odt', 'docx'].includes(ext)) return '📄';
        if (['ods', 'xlsx'].includes(ext)) return '📊';
        if (['odp'].includes(ext)) return '📑';
        if (['md', 'txt'].includes(ext)) return '📝';
        return '📄';
      },
      fpUp() { if (this.filePicker.parent !== null && !this.filePicker.loading) this.fpLoad(this.filePicker.parent); },
      fpClick(x) { if (x.is_dir) this.fpLoad(x.path); else this.filePicker.selected = x; },
      fpDbl(x) { if (!x.is_dir) { this.filePicker.selected = x; this.fpConfirm(); } },
      fpCancel() { this.filePicker.open = false; this.filePicker.selected = null; },
      // Browse Files to pick an attachment folder. target 'settings' fills the
      // base folder in Settings; anything else fills this collection's folder.
      openFolderPicker(target) {
        this.filePicker = { open: true, field: null, mode: 'folder', target: (target === 'settings' ? 'settings' : 'coll'), path: '', parent: null, entries: [], selected: null, loading: true, error: '' };
        this.fpLoad('');
      },
      fpConfirmFolder() {
        if (this.filePicker.target === 'settings') this.settingsForm.files_folder = this.filePicker.path || '';
        else this.collForm.files_folder = this.filePicker.path || '';
        this.filePicker.open = false;
      },
      async fpConfirm() {
        const x = this.filePicker.selected;
        if (!x || x.is_dir) return;
        const f = this.filePicker.field;
        const mode = this.filePicker.mode;
        this.filePicker.open = false;
        if (mode === 'image') {
          if (!x.is_image) { this.showToast(T('Please choose an image file')); return; }
          if (f.type === 'image_crop') { this.openCropper(this.imgUrl(x.id), f); }
          else { this.form[f.key] = String(x.id); }
          return;
        }
        this.form[f.key] = String(x.id);
        try { this.setFileMeta(x.id, await api('files/' + x.id + '/meta')); }
        catch (e) { this.setFileMeta(x.id, { id: x.id, name: x.name, mime: x.mime, ext: (x.name.split('.').pop() || '').toLowerCase(), is_note: false }); }
      },
      async openNotePicker(f) {
        this.notePicker = { open: true, key: f.key, allNotes: [], categories: [], category: null, step: 'cat', loading: true, error: '' };
        try {
          const resp = await notesApi('/notes');
          const list = Array.isArray(resp) ? resp : (resp && Array.isArray(resp.notesData) ? resp.notesData : []);
          const notes = list.filter((n) => n && !n.error && n.id);
          const map = {};
          for (const n of notes) { const c = n.category || ''; map[c] = (map[c] || 0) + 1; }
          this.notePicker.allNotes = notes;
          this.notePicker.categories = Object.keys(map).sort((a, b) => a.localeCompare(b, 'ja')).map((c) => ({ name: c, count: map[c] }));
        } catch (e) { this.notePicker.error = e.message || String(e); }
        finally { this.notePicker.loading = false; }
      },
      selectNoteCategory(cat) { this.notePicker.category = cat; this.notePicker.step = 'notes'; },
      notesInCategory() {
        const cat = this.notePicker.category || '';
        return this.notePicker.allNotes.filter((n) => (n.category || '') === cat).sort((a, b) => (b.modified || 0) - (a.modified || 0));
      },
      pickNote(n) {
        const key = this.notePicker.key;
        this.form[key] = String(n.id);
        this.setFileMeta(n.id, { id: n.id, name: (n.title || T('Note')) + '.md', ext: 'md', is_note: true, kind: 'note' });
        this.notePicker.open = false;
        this.showToast(T('Note attached'));
      },
      formatMime(format) { return format === 'png' ? 'image/png' : format === 'webp' ? 'image/webp' : 'image/jpeg'; },
      downscaleImage(file, max, quality, format) {
        return new Promise((resolve, reject) => {
          const img = new Image();
          const url = URL.createObjectURL(file);
          img.onload = () => {
            URL.revokeObjectURL(url);
            let w = img.naturalWidth, h = img.naturalHeight;
            if (w > max || h > max) { const s = Math.min(max / w, max / h); w = Math.round(w * s); h = Math.round(h * s); }
            const cv = document.createElement('canvas');
            cv.width = w; cv.height = h;
            cv.getContext('2d').drawImage(img, 0, 0, w, h);
            const mime = this.formatMime(format || (file.type === 'image/png' ? 'png' : 'jpeg'));
            resolve(cv.toDataURL(mime, quality));
          };
          img.onerror = () => { URL.revokeObjectURL(url); reject(new Error(T('Could not load the image'))); };
          img.src = url;
        });
      },
      async openSettings() {
        try { this.settingsForm = await api('settings'); } catch (e) { this.settingsForm = { files_folder: 'RegiBase', theme: this.theme }; }
        this.modal = { type: 'settings' };
      },
      previewTheme() { this.theme = this.settingsForm.theme || 'auto'; this.applyTheme(); },
      // ---- encryption (secret fields, client-side) ----
      // remember the derived key on this device (localStorage) so reloads skip the prompt
      lsKey() {
        let u = 'u';
        try { u = (window.OC && OC.getCurrentUser && OC.getCurrentUser() && OC.getCurrentUser().uid) || (document.querySelector('head') && document.querySelector('head').getAttribute('data-user')) || 'u'; } catch (e) { /* ignore */ }
        return 'regibase.enckey.' + u;
      },
      async rememberKey(key) { try { localStorage.setItem(this.lsKey(), await rbcrypto.exportKeyB64(key)); } catch (e) { /* ignore */ } },
      forgetKey() { try { localStorage.removeItem(this.lsKey()); } catch (e) { /* ignore */ } },
      hasRemembered() { try { return !!localStorage.getItem(this.lsKey()); } catch (e) { return false; } },
      async tryAutoUnlock() {
        let b64 = null;
        try { b64 = localStorage.getItem(this.lsKey()); } catch (e) { /* ignore */ }
        if (!b64) return false;
        try {
          const key = await rbcrypto.importKeyB64(b64);
          if (await rbcrypto.decrypt(key, this.enc.verifier) === 'regibase-ok') { encKey = key; this.enc.unlocked = true; return true; }
        } catch (e) { /* fall through */ }
        this.forgetKey();
        return false;
      },
      lockNow() { this.forgetKey(); encKey = null; sharedKeys = {}; sharedUnlocked = {}; this.secretUnlocked = {}; this.enc.unlocked = false; this.modal = null; this.openDecrypted = {}; },
      async doUnlock() {
        this.unlockErr = '';
        try {
          const key = await rbcrypto.deriveKey(this.unlockKey, this.enc.salt);
          if (await rbcrypto.decrypt(key, this.enc.verifier) !== 'regibase-ok') throw new Error('bad');
          encKey = key; this.enc.unlocked = true; this.unlockKey = '';
          if (this.unlockRemember) await this.rememberKey(key); else this.forgetKey();
          await this.loadCollections();
        } catch (e) { this.unlockErr = T('Incorrect master key'); }
      },
      async encryptData(data) {
        if (!this.current) return data;
        // shared-in collection: encrypt secrets with the OWNER's key (unwrapped at unlock),
        // never the recipient's own key — otherwise the owner could not decrypt them.
        const shared = this.current.is_owner === false;
        const key = shared ? sharedKeys[this.current.id] : encKey;
        if (shared ? !key : (!this.enc.enabled || !key)) return data;
        const out = { ...data };
        for (const f of this.current.fields) {
          if (f.secret && out[f.key] != null && out[f.key] !== '' && !rbcrypto.isEnc(out[f.key])) {
            out[f.key] = await rbcrypto.encrypt(key, String(out[f.key]));
          }
        }
        return out;
      },
      async secretPlain(v) {
        if (v == null || v === '') return '';
        if (!rbcrypto.isEnc(v)) return String(v);
        // shared-in collection: decrypt only with the owner's unwrapped key; otherwise mask
        if (this.current && this.current.is_owner === false) {
          const k = sharedKeys[this.current.id];
          if (!k) return '••••••••'; // secrets not shared / not unlocked
          try { return await rbcrypto.decrypt(k, v); } catch (e) { return T('(decryption failed)'); }
        }
        if (this.enc.enabled && encKey) {
          try { return await rbcrypto.decrypt(encKey, v); } catch (e) { return T('(decryption failed)'); }
        }
        return String(v);
      },
      async decryptSecretsOf(rec) {
        const out = {};
        for (const f of this.current.fields) { if (f.secret) out[f.key] = await this.secretPlain(rec.data[f.key]); }
        this.openDecrypted = out;
      },
      openEncSetup() { this.encForm = { cur: '', next: '', next2: '', busy: false, progress: '', err: '', remember: true }; this.modal = { type: 'encSetup' }; },
      openEncChange() { this.encForm = { cur: '', next: '', next2: '', busy: false, progress: '', err: '', remember: true }; this.modal = { type: 'encChange' }; },
      openEncRemove() { this.encForm = { cur: '', next: '', next2: '', busy: false, progress: '', err: '', remember: false }; this.modal = { type: 'encRemove' }; },
      async removeEncryption() {
        this.encForm.err = '';
        const cur = this.encForm.cur;
        if (!cur) { this.encForm.err = T('Enter your current master key'); return; }
        this.encForm.busy = true;
        try {
          const key = await rbcrypto.deriveKey(cur, this.enc.salt);
          if (await rbcrypto.decrypt(key, this.enc.verifier) !== 'regibase-ok') { this.encForm.err = T('Current master key is incorrect'); this.encForm.busy = false; return; }
          // decrypt every secret field back to plain text
          const plans = await this.collectSecretPlans();
          let done = 0;
          for (const p of plans) {
            const data = { ...p.data }; let changed = false;
            for (const k of p.sk) { const v = data[k]; if (rbcrypto.isEnc(v)) { const pl = await rbcrypto.decrypt(key, v); if (pl != null) { data[k] = pl; changed = true; } } }
            if (changed) await api('records/' + p.id, { method: 'PUT', body: JSON.stringify({ data, _noHistory: true }) });
            done++; this.encForm.progress = done + ' / ' + plans.length;
          }
          // turn encryption off (back to the initial, no-master-password state)
          await api('settings', { method: 'PUT', body: JSON.stringify({ enc_enabled: false, enc_salt: '', enc_verifier: '' }) });
          this.forgetKey(); encKey = null; sharedKeys = {}; sharedUnlocked = {}; this.secretUnlocked = {}; this.openDecrypted = {};
          this.enc = { enabled: false, unlocked: false, salt: '', verifier: '' };
          if (this.current) await this.loadRecords();
          this.modal = null; this.showToast(T('Master key removed (secret fields are now plain text)'));
        } catch (e) { this.encForm.err = T('Failed') + ': ' + (e.message || e); }
        finally { this.encForm.busy = false; }
      },
      async collectSecretPlans() {
        const colls = await api('collections');
        const plans = [];
        for (const c of colls) {
          const full = await api('collections/' + c.id);
          const sk = full.fields.filter((f) => f.secret).map((f) => f.key);
          if (!sk.length) continue;
          const recs = await api('collections/' + c.id + '/records');
          for (const r of recs) plans.push({ id: r.id, data: r.data, sk });
        }
        return plans;
      },
      async enableEncryption() {
        this.encForm.err = '';
        const k = this.encForm.next;
        if (!k || k.length < 6) { this.encForm.err = T('Master key must be at least 6 characters'); return; }
        if (k !== this.encForm.next2) { this.encForm.err = T('Confirmation does not match'); return; }
        this.encForm.busy = true;
        try {
          const salt = rbcrypto.randSaltB64();
          const key = await rbcrypto.deriveKey(k, salt);
          const verifier = await rbcrypto.encrypt(key, 'regibase-ok');
          // enable server-side first so a partial migration stays consistent (mixed plain/cipher is readable)
          await api('settings', { method: 'PUT', body: JSON.stringify({ enc_enabled: true, enc_salt: salt, enc_verifier: verifier }) });
          encKey = key; this.enc = { enabled: true, unlocked: true, salt, verifier };
          const plans = await this.collectSecretPlans();
          let done = 0;
          for (const p of plans) {
            const data = { ...p.data }; let changed = false;
            for (const key2 of p.sk) { const v = data[key2]; if (v != null && v !== '' && !rbcrypto.isEnc(v)) { data[key2] = await rbcrypto.encrypt(key, String(v)); changed = true; } }
            if (changed) await api('records/' + p.id, { method: 'PUT', body: JSON.stringify({ data, _noHistory: true }) });
            done++; this.encForm.progress = done + ' / ' + plans.length;
          }
          if (this.encForm.remember) await this.rememberKey(key); else this.forgetKey();
          this.modal = null; this.showToast(T('Encryption enabled'));
        } catch (e) { this.encForm.err = T('Failed') + ': ' + (e.message || e); }
        finally { this.encForm.busy = false; }
      },
      async changeMasterKey() {
        this.encForm.err = '';
        const nk = this.encForm.next;
        if (!nk || nk.length < 6) { this.encForm.err = T('New master key must be at least 6 characters'); return; }
        if (nk !== this.encForm.next2) { this.encForm.err = T('Confirmation does not match'); return; }
        this.encForm.busy = true;
        try {
          const oldKey = await rbcrypto.deriveKey(this.encForm.cur, this.enc.salt);
          if (await rbcrypto.decrypt(oldKey, this.enc.verifier) !== 'regibase-ok') throw new Error(T('Current master key is incorrect'));
          const newSalt = rbcrypto.randSaltB64();
          const newKey = await rbcrypto.deriveKey(nk, newSalt);
          const newVerifier = await rbcrypto.encrypt(newKey, 'regibase-ok');
          const plans = await this.collectSecretPlans();
          let done = 0;
          for (const p of plans) {
            const data = { ...p.data }; let changed = false;
            for (const key2 of p.sk) { const v = data[key2]; if (rbcrypto.isEnc(v)) { data[key2] = await rbcrypto.encrypt(newKey, await rbcrypto.decrypt(oldKey, v)); changed = true; } }
            if (changed) await api('records/' + p.id, { method: 'PUT', body: JSON.stringify({ data, _noHistory: true }) });
            done++; this.encForm.progress = done + ' / ' + plans.length;
          }
          await api('settings', { method: 'PUT', body: JSON.stringify({ enc_salt: newSalt, enc_verifier: newVerifier }) });
          const wasRemembered = this.hasRemembered();
          encKey = newKey; this.enc.salt = newSalt; this.enc.verifier = newVerifier;
          if (wasRemembered) await this.rememberKey(newKey);
          this.modal = null; this.showToast(T('Master key changed'));
        } catch (e) { this.encForm.err = T('Failed') + ': ' + (e.message || e); }
        finally { this.encForm.busy = false; }
      },
      // Sweep every collection and encrypt any secret-field value still saved as
      // plain text (e.g. imported server-side, or secreted after the fact).
      // Silently encrypt any secret-field value in the current collection that is
      // still stored as plain text (e.g. written by a server-side import: CSV/JSON,
      // Tables, Contacts, occ). Runs on load while encryption is unlocked, so no
      // manual "re-encrypt" action is needed. The checkbox-toggle case (secret
      // turned on/off in the collection editor) is handled in commitSchema.
      async autoEncryptCurrent() {
        if (!this.current || this.current.is_owner === false) return;
        if (!this.enc.enabled || !encKey) return;
        const sk = (this.current.fields || []).filter((f) => f.secret).map((f) => f.key);
        if (!sk.length) return;
        let n = 0;
        for (const r of this.records) {
          if (!r || !r.data) continue;
          const data = { ...r.data }; let changed = false;
          for (const k of sk) { const v = data[k]; if (v != null && v !== '' && !rbcrypto.isEnc(v)) { data[k] = await rbcrypto.encrypt(encKey, String(v)); changed = true; } }
          if (changed) { try { await api('records/' + r.id, { method: 'PUT', body: JSON.stringify({ data, _noHistory: true }) }); r.data = data; n++; } catch (e) { /* leave plaintext; will retry next load */ } }
        }
        if (n) this.showToast(T('Encrypted {n} record(s)', { n }));
      },
      async saveSettings() {
        try {
          const s = await api('settings', { method: 'PUT', body: JSON.stringify({ files_folder: this.settingsForm.files_folder, theme: this.settingsForm.theme, language: this.settingsForm.language, map_provider: this.settingsForm.map_provider, undo_limit: this.settingsForm.undo_limit }) });
          this.settingsForm = s; this.theme = s.theme || 'auto'; this.applyTheme();
          this.languages = s.languages || this.languages;
          await this.applyLanguage(s.language || 'auto');
          this.modal = null; this.showToast(T('Settings saved'));
        } catch (e) { alert(T('Failed to save') + ': ' + e.message); }
      },
      // Save just the snapshot retention limit (edited from Collection settings).
      async saveSnapLimit() {
        try {
          const n = Math.max(0, Math.min(1000, parseInt(this.settingsForm.undo_limit, 10) || 0));
          this.settingsForm.undo_limit = n;
          const s = await api('settings', { method: 'PUT', body: JSON.stringify({ undo_limit: n }) });
          if (s) this.settingsForm = s;
          this.showToast(T('Settings saved'));
          this.refreshUndo();
        } catch (e) { alert(T('Failed to save') + ': ' + (e.message || e)); }
      },
      // ---- snapshots (per-collection change history / undo) ----
      async refreshUndo() {
        try {
          const cid = this.current && this.current.id;
          if (!cid) { this.history = []; this.undoTop = null; return; }
          const h = await api('history?collection=' + cid);
          this.history = h.entries || [];
          const a = this.history.find((e) => !e.undone);
          this.undoTop = a ? a.summary : null;
        } catch (e) { /* snapshots are best-effort */ }
      },
      async doUndo() {
        if (this.busy) return;
        const cid = this.current && this.current.id;
        if (!cid) return;
        this.busy = true;
        try {
          const r = await api('history/undo', { method: 'POST', body: JSON.stringify({ collection: cid }) });
          if (!r || !r.undone) { this.undoTop = null; this.showToast(T('Nothing to undo')); return; }
          this.showToast(T('Undone: {what}', { what: r.summary || '' }));
          await this.afterUndo(cid);
        } catch (e) { alert(T('Failed') + ': ' + (e.message || e)); }
        finally { this.busy = false; }
      },
      async restoreTo(h) {
        if (this.busy) return;
        const cid = this.current && this.current.id;
        if (!cid || !h) return;
        if (!confirm(T('Undo “{what}” and every change newer than it? This cannot be redone.', { what: h.summary || '' }))) return;
        this.busy = true;
        try {
          const r = await api('history/undo', { method: 'POST', body: JSON.stringify({ collection: cid, downTo: h.id }) });
          this.showToast(T('Reverted {n} change(s)', { n: (r && r.undone) || 0 }));
          await this.afterUndo(cid);
        } catch (e) { alert(T('Failed') + ': ' + (e.message || e)); }
        finally { this.busy = false; }
      },
      // Reload the collection (or drop it if the undo removed it) and refresh the list.
      async afterUndo(cid) {
        await this.loadCollections();
        if (this.collections.some((c) => c.id === cid)) {
          try { await this.selectCollection(cid); } catch (e) { /* keep going */ }
        } else if (this.current && this.current.id === cid) {
          this.current = null; this.records = []; if (this.modal && this.modal.type === 'history') this.modal = null;
        }
        await this.refreshUndo();
      },
      async openHistory() { await this.refreshUndo(); this.modal = { type: 'history' }; },
      snapIcon(op) {
        return { 'record.create': '➕', 'record.update': '✏️', 'record.delete': '🗑', 'record.delete_many': '🗑', 'record.reorder': '⇅', 'records.bulk_add': '📥', 'record.transfer': '↔', 'fields.replace': '🧩', 'fields.append': '🧩', 'collection.create': '🗂️', 'collection.update': '⚙️', 'collection.delete': '🗑', 'collection.duplicate': '📄' }[op] || '•';
      },
      snapOpLabel(op) {
        return { 'record.create': T('Add record'), 'record.update': T('Edit record'), 'record.delete': T('Delete record'), 'record.delete_many': T('Delete records'), 'record.reorder': T('Reorder records'), 'records.bulk_add': T('Import records'), 'record.transfer': T('Move / copy records'), 'fields.replace': T('Edit fields'), 'fields.append': T('Add fields'), 'collection.create': T('Create collection'), 'collection.update': T('Collection settings'), 'collection.delete': T('Delete collection'), 'collection.duplicate': T('Duplicate collection') }[op] || op;
      },
      snapDetail(h) {
        let dt = h.created_at;
        try { const d = new Date(h.created_at); if (!isNaN(d)) dt = d.toLocaleString(); } catch (e) { /* keep raw */ }
        return this.snapOpLabel(h.op) + ' — ' + (h.summary || '') + '\n' + dt + (h.undone ? '\n(' + T('undone') + ')' : '');
      },
      fmtHistTime(s) {
        try { const d = new Date(s); if (isNaN(d)) return s; return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); }
        catch (e) { return s; }
      },
      async clearHistoryConfirm() {
        const cid = this.current && this.current.id;
        if (!cid) return;
        if (!confirm(T('Delete all snapshots for this collection? Undo will no longer be possible for past changes.'))) return;
        try { await api('history?collection=' + cid, { method: 'DELETE' }); this.history = []; this.undoTop = null; this.showToast(T('Snapshots cleared')); }
        catch (e) { alert(T('Failed') + ': ' + (e.message || e)); }
      },
      // ---- full backup / restore ----
      openBackup() { this.backupForm = { password: '', busy: false, err: '' }; this.modal = { type: 'backup' }; },
      openRestore() { this.restoreForm = { password: '', busy: false, err: '', fileName: '', dataUrl: '', confirm: false, mode: 'overwrite' }; this.modal = { type: 'restore' }; },
      async doBackup() {
        if (!this.backupForm.password) { this.backupForm.err = T('Please enter your password'); return; }
        this.backupForm.busy = true; this.backupForm.err = '';
        try {
          const res = await fetch(BASE + 'api/backup', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'requesttoken': TOKEN },
            credentials: 'same-origin',
            body: JSON.stringify({ password: this.backupForm.password }),
          });
          if (!res.ok) { let m = ''; try { m = (await res.json()).error; } catch (e) { /* ignore */ } throw new Error(m || res.statusText); }
          const blob = await res.blob();
          const uid = (window.OC && OC.getCurrentUser && OC.getCurrentUser()) ? OC.getCurrentUser().uid : 'user';
          const d = new Date();
          const ymd = '' + d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
          const fname = 'RegiBase-' + uid + '_' + ymd + '_backup.zip';
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a'); a.href = url; a.download = fname;
          document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
          this.modal = null; this.showToast(T('Backup downloaded'));
        } catch (e) { this.backupForm.err = e.message || String(e); }
        finally { this.backupForm.busy = false; }
      },
      onRestoreFile(e) {
        const f = e.target.files && e.target.files[0];
        if (!f) return;
        this.restoreForm.fileName = f.name;
        const r = new FileReader();
        r.onload = () => { this.restoreForm.dataUrl = String(r.result || ''); };
        r.readAsDataURL(f);
      },
      async doRestore() {
        if (!this.restoreForm.dataUrl) { this.restoreForm.err = T('Please choose a file'); return; }
        if (!this.restoreForm.password) { this.restoreForm.err = T('Please enter your password'); return; }
        if (this.restoreForm.mode === 'overwrite' && !this.restoreForm.confirm) { this.restoreForm.err = T('Please check the confirmation box'); return; }
        this.restoreForm.busy = true; this.restoreForm.err = '';
        try {
          const res = await api('restore', { method: 'POST', body: JSON.stringify({ password: this.restoreForm.password, dataUrl: this.restoreForm.dataUrl, mode: this.restoreForm.mode }) });
          this.modal = null;
          this.showToast(T('Restored') + '（' + T('Imported {n} items', { n: res.records }) + '）');
          await this.reloadAfterRestore();
        } catch (e) { this.restoreForm.err = e.message || String(e); }
        finally { this.restoreForm.busy = false; }
      },
      async reloadAfterRestore() {
        encKey = null;
        const s = await api('settings');
        this.settingsForm = s; this.theme = s.theme || 'auto';
        this.languages = s.languages || this.languages;
        await this.applyLanguage(s.language || 'auto');
        this.applyTheme();
        this.enc = { enabled: !!s.enc_enabled, unlocked: false, salt: s.enc_salt || '', verifier: s.enc_verifier || '' };
        this.templates = []; // re-fetched lazily when the New collection picker next opens
        this.current = null; this.records = []; this.clearSelection();
        await this.loadCollections();
      },
      async openTemplatePicker() {
        this.modal = { type: 'template' };
        if (!this.templates.length) {
          this.templatesLoading = true;
          try { this.templates = await api('templates'); }
          catch (e) { /* keep empty; modal shows nothing to pick */ }
          finally { this.templatesLoading = false; }
        }
      },
      async createFromTemplate(tpl) {
        const body = { name: tpl.name, icon: tpl.icon, color: tpl.color, description: tpl.description, fields: tpl.fields };
        await this.createCollectionWithConflictCheck(body);
      },
      // POST a new collection. If its save folder would clash with another
      // collection's, the server replies { folder_conflict } instead of creating;
      // we then ask the user (reuse the folder / add a number). `choice` carries
      // that answer on the retry.
      async createCollectionWithConflictCheck(body, choice) {
        this.busy = true;
        try {
          const payload = choice ? { ...body, folder_choice: choice } : body;
          const c = await api('collections', { method: 'POST', body: JSON.stringify(payload) });
          if (c && c.folder_conflict) {
            this.pendingCreate = { body, folder: c.folder };
            this.modal = { type: 'folderConflict' };
            return;
          }
          this.modal = null; await this.loadCollections(); await this.selectCollection(c.id);
          this.showToast(T('Collection created'));
        } finally { this.busy = false; }
      },
      // Answer the folder-name conflict prompt: reuse=true keeps the same folder,
      // reuse=false creates with a number appended.
      async resolveFolderConflict(reuse) {
        const pc = this.pendingCreate;
        this.pendingCreate = null;
        if (!pc) { this.modal = null; return; }
        await this.createCollectionWithConflictCheck(pc.body, reuse ? 'reuse' : 'suffix');
      },
      cancelFolderConflict() { this.pendingCreate = null; this.modal = null; },
      async refreshTemplates() {
        this.templatesLoading = true;
        try { this.templates = await api('templates'); }
        catch (e) { /* keep previous */ }
        finally { this.templatesLoading = false; }
      },
      // ---- collection duplication ----
      openDuplicate() {
        if (!this.current) return;
        this.dupForm = { name: (this.current.name + ' ' + T('(copy)')).trim(), withRecords: false, busy: false };
        this.modal = { type: 'duplicate' };
      },
      async commitDuplicate() {
        if (!this.current || !this.dupForm.name.trim()) return;
        this.dupForm.busy = true;
        try {
          const c = await api('collections/' + this.current.id + '/duplicate', {
            method: 'POST',
            body: JSON.stringify({ with_records: this.dupForm.withRecords, name: this.dupForm.name.trim() }),
          });
          this.modal = null; await this.loadCollections(); await this.selectCollection(c.id);
          this.showToast(T('Collection duplicated'));
        } catch (e) { this.showToast(e.message || String(e)); }
        finally { this.dupForm.busy = false; }
      },
      // ---- templates: save-as / edit / delete / reset ----
      async saveAsTemplate() {
        if (!this.current) return;
        try {
          await api('templates', { method: 'POST', body: JSON.stringify({ from_collection: this.current.id }) });
          this.templates = [];
          this.showToast(T('Saved as template'));
        } catch (e) { this.showToast(e.message || String(e)); }
      },
      openTemplateEditor(tpl) {
        this.schemaMode = 'template';
        this.tplEdit = {
          row_id: tpl.row_id || null,
          key: tpl.key,
          builtin_key: tpl.builtin ? tpl.key : null,
          name: tpl.name || '', icon: tpl.icon || '📁', color: tpl.color || '#3b82f6',
          description: tpl.description || '', busy: false,
        };
        this.schemaFields = this.fieldsToSchemaRows(tpl.fields || []);
        this.modal = { type: 'schema' };
      },
      closeSchemaEditor() {
        this.stopAutoScroll();
        const wasTemplate = this.schemaMode === 'template';
        this.schemaMode = 'collection';
        this.modal = wasTemplate ? { type: 'template' } : null;
      },
      async saveTemplate() {
        const fields = this.serializeSchemaFields();
        if (!fields.length) { alert(T('Keep at least one field')); return; }
        if (!fields.some((f) => f.is_title)) fields[0].is_title = true;
        const name = (this.tplEdit.name || '').trim();
        if (!name) { alert(T('Enter a template name')); return; }
        const body = { name, icon: this.tplEdit.icon || '📁', color: this.tplEdit.color || '#3b82f6', description: this.tplEdit.description || '', fields };
        try {
          if (this.tplEdit.row_id) {
            await api('templates/' + this.tplEdit.row_id, { method: 'PUT', body: JSON.stringify(body) });
          } else if (this.tplEdit.builtin_key) {
            await api('templates/builtin/' + encodeURIComponent(this.tplEdit.builtin_key), { method: 'POST', body: JSON.stringify(body) });
          } else {
            await api('templates', { method: 'POST', body: JSON.stringify(body) });
          }
          this.schemaMode = 'collection'; this.templates = [];
          this.showToast(T('Template saved'));
          await this.openTemplatePicker();
        } catch (e) { this.showToast(e.message || String(e)); }
      },
      async deleteTemplate(tpl) {
        if (!tpl.row_id) return;
        if (!confirm(T('Delete the template “{name}”?', { name: tpl.name }))) return;
        try {
          await api('templates/' + tpl.row_id, { method: 'DELETE' });
          this.templates = []; await this.openTemplatePicker();
          this.showToast(T('Template deleted'));
        } catch (e) { this.showToast(e.message || String(e)); }
      },
      async resetTemplate(tpl) {
        if (!confirm(T('Reset “{name}” to the built-in default?', { name: tpl.name }))) return;
        try {
          await api('templates/builtin/' + encodeURIComponent(tpl.key), { method: 'DELETE' });
          this.templates = []; await this.openTemplatePicker();
          this.showToast(T('Reset to default'));
        } catch (e) { this.showToast(e.message || String(e)); }
      },
      goHome(push = true) {
        this.current = null; this.records = []; this.search = ''; this.sidebarOpen = false; this.selectedIds = [];
        try { localStorage.removeItem('rb-open-coll'); } catch (e) { /* ignore */ }
        if (this.modal) this.modal = null;
        if (push) this.pushNav({ cid: null });
      },
      openCollSettings() {
        this.collForm = { name: this.current.name, icon: this.current.icon, color: this.current.color, description: this.current.description || '', locked: !!this.current.locked, key_head: !!this.current.key_head, key_sep: this.current.key_sep || 'space', key_sep_char: this.current.key_sep_char || '', files_folder: this.current.files_folder || '', map_provider: this.current.map_provider || '', secret: !!this.current.secret, secret_pin: '' };
        this.sharePanel = { shares: [], q: '', results: [], searching: false, recipient: null, recipientName: '', recipientType: 'user', perm: 'view', password: '', master: '', shareSecrets: false, err: '', busy: false };
        this.modal = { type: 'collSettings' };
        this.permOpen = false;
        this.iconPickerOpen = false;
        this.shareExpanded = false;
        if (this.isOwner) this.loadShares();
        this.refreshUndo(); // load this collection's snapshot count
        api('settings').then((s) => { if (s) this.settingsForm = s; }).catch(() => {}); // for the keep-limit field
      },
      // ---- icon (emoji) picker ----
      // The Unicode set is ~150 KB with its names, so it is loaded on first use only.
      async loadEmoji() {
        if (this.emoji.groups.length || this.emojiLoading) return;
        this.emojiLoading = true;
        try {
          const r = await api('emoji/' + encodeURIComponent((this.settingsForm && this.settingsForm.language) || 'auto'));
          this.emoji = { groups: r.groups || [], names: r.names || {} };
        } catch (e) { /* the recommended tab still works without it */ }
        this.emojiLoading = false;
      },
      openIconPicker(target) {
        this.iconPickerOpen = !(this.iconPickerOpen && this.iconTarget === target);
        this.iconTarget = target;
        if (!this.iconPickerOpen) return;
        this.emojiQuery = '';
        this.loadEmoji();
      },
      pickIcon(em) {
        const form = this[this.iconTarget];
        if (form) form.icon = em;
        this.iconPickerOpen = false;
      },
      // CLDR short name for the tooltip; the stored value is "name|keyword keyword".
      emojiName(em) {
        const n = this.emoji.names[em];
        return n ? n.split('|')[0] : em;
      },
      // ---- internal sharing (owner side) ----
      shareBadge(c) { if (!c) return ''; if (c.shared_by_me) return '🔗'; if (c.shared_with_me) return '👥'; return ''; },
      shareBadgeTitle(c) { if (!c) return ''; if (c.shared_by_me) return T('Shared by you'); if (c.shared_with_me) return T('Shared with you'); return ''; },
      async loadShares() {
        try {
          const r = await api('collections/' + this.current.id + '/shares');
          this.sharePanel.shares = r.shares || [];
          // Already-shared collection: start expanded (checkbox on), like the edit-lock state
          if (this.sharePanel.shares.length) this.shareExpanded = true;
        } catch (e) { /* not owner or none */ }
      },
      async searchShareUsers() {
        const q = this.sharePanel.q.trim();
        if (!q) { this.sharePanel.results = []; return; }
        this.sharePanel.searching = true;
        try {
          const r = await api('users/search?q=' + encodeURIComponent(q));
          const already = new Set(this.sharePanel.shares.map((s) => (s.recipient_type || 'user') + ':' + s.recipient_uid));
          const all = [...(r.users || []), ...(r.groups || [])];
          this.sharePanel.results = all.filter((u) => !already.has((u.type || 'user') + ':' + u.uid));
        } catch (e) { this.sharePanel.results = []; }
        finally { this.sharePanel.searching = false; }
      },
      pickShareUser(u) { this.sharePanel.recipient = u.uid; this.sharePanel.recipientName = u.name; this.sharePanel.recipientType = u.type || 'user'; this.sharePanel.results = []; this.sharePanel.q = ''; },
      clearShareRecipient() { this.sharePanel.recipient = null; this.sharePanel.recipientName = ''; this.sharePanel.recipientType = 'user'; },
      async addShare() {
        const sp = this.sharePanel;
        sp.err = '';
        if (!sp.recipient) return;
        let encKeyWrapped = null, encSalt = null;
        if (sp.master) {
          if (!sp.password) { sp.err = T('Set a share password to share secret fields.'); return; }
          try {
            const ownerKey = await rbcrypto.deriveKey(sp.master, this.enc.salt);
            if (await rbcrypto.decrypt(ownerKey, this.enc.verifier) !== 'regibase-ok') { sp.err = T('Incorrect master password'); return; }
            encSalt = rbcrypto.randSaltB64();
            const wrapKey = await rbcrypto.deriveKey(sp.password, encSalt);
            encKeyWrapped = await rbcrypto.encrypt(wrapKey, await rbcrypto.exportKeyB64(ownerKey));
          } catch (e) { sp.err = T('Could not prepare secret sharing'); return; }
        }
        sp.busy = true;
        try {
          const body = { recipient: sp.recipient, recipient_type: sp.recipientType || 'user', perm: sp.perm, password: sp.password || '' };
          if (encKeyWrapped) { body.enc_key = encKeyWrapped; body.enc_salt = encSalt; }
          const s = await api('collections/' + this.current.id + '/shares', { method: 'POST', body: JSON.stringify(body) });
          this.sharePanel.shares.push(s);
          this.clearShareRecipient();
          sp.perm = 'view'; sp.password = ''; sp.master = '';
          await this.loadCollections();
          this.showToast(T('Shared'));
        } catch (e) { sp.err = e.message || String(e); }
        finally { sp.busy = false; }
      },
      async changeSharePerm(s, perm) {
        const qs = '?recipient_type=' + encodeURIComponent(s.recipient_type || 'user');
        try { const r = await api('collections/' + this.current.id + '/shares/' + encodeURIComponent(s.recipient_uid) + qs, { method: 'PATCH', body: JSON.stringify({ perm }) }); s.perm = r.perm; }
        catch (e) { this.showToast(e.message || String(e)); }
      },
      async removeShare(s) {
        if (!confirm(T('Stop sharing with {name}?', { name: s.recipient_name || s.recipient_uid }))) return;
        const type = s.recipient_type || 'user';
        try {
          await api('collections/' + this.current.id + '/shares/' + encodeURIComponent(s.recipient_uid) + '?recipient_type=' + encodeURIComponent(type), { method: 'DELETE' });
          this.sharePanel.shares = this.sharePanel.shares.filter((x) => !(x.recipient_uid === s.recipient_uid && (x.recipient_type || 'user') === type));
          await this.loadCollections();
        } catch (e) { this.showToast(e.message || String(e)); }
      },
      // ---- recipient unlock (share password) ----
      promptShareUnlock(cid, name, next) {
        this.shareUnlock = { open: true, cid, name: name || '', hasSecrets: false, password: '', err: '', busy: false, next };
      },
      cancelShareUnlock() { this.shareUnlock = { open: false, cid: null, name: '', hasSecrets: false, password: '', err: '', busy: false, next: null }; },
      async doShareUnlock() {
        const su = this.shareUnlock;
        su.err = ''; su.busy = true;
        try {
          const res = await api('collections/' + su.cid + '/unlock', { method: 'POST', body: JSON.stringify({ password: su.password }) });
          sharedUnlocked[su.cid] = true;
          if (res.enc_key && res.enc_salt) {
            try {
              const wrapKey = await rbcrypto.deriveKey(su.password, res.enc_salt);
              const raw = await rbcrypto.decrypt(wrapKey, res.enc_key);
              sharedKeys[su.cid] = await rbcrypto.importKeyB64(raw);
            } catch (e) { /* secrets stay masked if unwrap fails */ }
          }
          const next = su.next;
          this.cancelShareUnlock();
          if (next) await next();
        } catch (e) { su.err = T('Incorrect share password'); su.busy = false; }
      },
      exportCollection(format) {
        if (!this.current) return;
        const url = BASE + 'api/collections/' + this.current.id + '/export?format=' + format;
        const a = document.createElement('a');
        a.href = url; a.download = ''; a.rel = 'noopener';
        document.body.appendChild(a); a.click(); a.remove();
        this.showToast(T('Exported {fmt}', { fmt: format === 'json' ? 'JSON' : 'CSV' }));
      },
      async saveCollSettings() {
        const wasSecret = !!this.current.secret;
        const pin = String(this.collForm.secret_pin || '').trim();
        if (this.collForm.secret) {
          if (pin !== '' && !/^\d{6}$/.test(pin)) { alert(T('The secret key must be exactly 6 digits.')); return; }
          if (!wasSecret && pin === '') { alert(T('Set a 6-digit secret key to make this collection secret.')); return; }
        }
        // When the title changed and the attachment folder is still the auto-derived
        // one (its last path segment matches the old title) and wasn't hand-edited,
        // ask — with a dedicated in-app dialog — whether to rename that folder too.
        // Any other case (custom folder, no title change): save straight away.
        const oldName = String(this.current.name || '');
        const newName = String(this.collForm.name || '').trim();
        const curFolder = String(this.current.files_folder || '');
        const lastSeg = curFolder.includes('/') ? curFolder.slice(curFolder.lastIndexOf('/') + 1) : curFolder;
        const folderUnchanged = String(this.collForm.files_folder || '') === curFolder;
        if (newName && newName !== oldName && folderUnchanged && lastSeg === oldName) {
          const parent = curFolder.includes('/') ? curFolder.slice(0, curFolder.lastIndexOf('/') + 1) : '';
          this.folderAsk = { open: true, busy: false, from: curFolder, to: parent + newName };
          return;
        }
        await this.commitCollSettings(false);
      },
      // Cancel the folder-rename question and return to the settings dialog (nothing saved).
      cancelFolderAsk() { this.folderAsk = { open: false }; },
      // Persist the collection settings. renameFolder tells the backend whether to also
      // rename the attachment folder (only set true from the dedicated dialog's confirm).
      async commitCollSettings(renameFolder) {
        const pin = String(this.collForm.secret_pin || '').trim();
        const body = { ...this.collForm, secret_pin: pin };
        if (renameFolder) body.rename_folder = true;
        if (this.folderAsk.open) this.folderAsk.busy = true;
        let c;
        try {
          c = await api('collections/' + this.current.id, { method: 'PATCH', body: JSON.stringify(body) });
        } catch (e) { this.folderAsk = { open: false }; alert(T('Failed') + ': ' + (e.message || e)); return; }
        this.current = { ...this.current, ...c };
        // Keep a just-made-secret collection visible for this session (so it doesn't
        // vanish from the list the moment you save it), using the key you just set.
        if (this.collForm.secret && pin) { secretPins.add(pin); this.secretShown = true; }
        this.folderAsk = { open: false };
        await this.loadCollections(); this.modal = null; this.showToast(T('Saved'));
      },
      deleteCollection() {
        if (!this.isOwner || !this.current) return;
        // Open a confirm dialog that also asks whether to trash the save folder
        // (default off — the folder is kept unless the user opts in).
        this.modal = { type: 'delColl', deleteFolder: false, busy: false, folderHasData: false };
        this.checkDeleteFolderData();
      },
      // Does this collection's save folder actually hold any files? Used to show
      // the "data will be moved to the trash" note only when there is data.
      async checkDeleteFolderData() {
        const folder = String((this.current && this.current.files_folder) || '').trim();
        if (!folder) return;
        try {
          const r = await api('files/browse?path=' + encodeURIComponent(folder));
          const n = Array.isArray(r.entries) ? r.entries.length : 0;
          if (this.modal && this.modal.type === 'delColl') this.modal.folderHasData = n > 0;
        } catch (e) { /* folder missing / unreadable → treat as empty */ }
      },
      async doDeleteCollection() {
        if (!this.isOwner || !this.current || !this.modal) return;
        const del = !!this.modal.deleteFolder;
        this.modal.busy = true;
        try {
          await api('collections/' + this.current.id + (del ? '?delete_folder=1' : ''), { method: 'DELETE' });
        } catch (e) {
          this.modal.busy = false;
          this.showToast(T('Could not delete the collection'));
          return;
        }
        this.modal = null; this.current = null; this.records = []; await this.loadCollections(); this.showToast(T('Deleted'));
      },
      // "records with data / total" for a field, shown at the bottom-right of its
      // editor row. Unsaved fields (no key yet) count as 0.
      fieldFill(f) {
        const total = this.records.length;
        const k = f.key;
        if (!k) return '0/' + total;
        let n = 0;
        for (const r of this.records) { const v = r.data ? r.data[k] : null; if (v != null && v !== '') n++; }
        return n + '/' + total;
      },
      fieldsToSchemaRows(fields) {
        const rows = (fields || []).map((f) => {
          const o = (f.options && typeof f.options === 'object' && !Array.isArray(f.options)) ? f.options : {};
          return {
            ...f,
            list_show: f.list_show !== false,
            table_show: f.table_show !== false,
            card_show: f.card_show !== false,
            options: (CHOICE_TYPES.includes(f.type) && Array.isArray(f.options)) ? f.options.join('\n') : '',
            _orig: f.type === 'image' ? o.max === 0 : false,
            _max: (f.type === 'image' && o.max > 0) ? o.max : 1600,
            _ratio: f.type === 'image_crop' ? (o.ratio || '1:1') : '1:1',
            _out: (f.type === 'image_crop' && o.out > 0) ? o.out : 600,
            _format: o.format || 'jpeg',
            _charset: (RULE_TYPES.includes(f.type) && o.charset) ? o.charset : 'none',
            _pattern: (RULE_TYPES.includes(f.type) && o.pattern) ? o.pattern : '',
            _rmin: (RULE_TYPES.includes(f.type) && o.min > 0) ? o.min : '',
            _rmax: (RULE_TYPES.includes(f.type) && o.max > 0) ? o.max : '',
            _uid: this.uidCounter++,
            _cnext: 0,                              // _uid of the next field to append (chain)
            _csep: (f.concat_sep || 'space'),       // separator placed after this field
            _csepChar: (f.concat_sep_char || ''),
          };
        });
        // Rebuild the forward chain from stored group numbers: within each group,
        // link every field to the next one in field order (A→B→C).
        const groups = {};
        rows.forEach((r) => { const g = r.concat || 0; if (g) (groups[g] = groups[g] || []).push(r); });
        Object.values(groups).forEach((members) => {
          for (let i = 0; i < members.length - 1; i++) members[i]._cnext = members[i + 1]._uid;
        });
        return rows;
      },
      // Fields row f can concatenate into: the fields AFTER it (a rear column).
      concatTargets(f) {
        const idx = this.schemaFields.indexOf(f);
        return this.schemaFields.filter((g, gi) => gi > idx && (g.label || '').trim());
      },
      // Label of the field that concatenates INTO f (f is someone's next). "連結元".
      concatSourceLabel(f) {
        const src = this.schemaFields.find((g) => g._cnext === f._uid);
        return src ? ((src.label || '').trim() || T('(no name)')) : '';
      },
      // Resolve a field's own separator (used before its _cnext target).
      rowSep(f) {
        switch (f._csep) {
          case 'none': return '';
          case 'fullspace': return '　';
          case 'custom': return f._csepChar || '';
          default: return ' ';
        }
      },
      serializeSchemaFields() {
        const rows = this.schemaFields.filter((f) => (f.label || '').trim());
        // Resolve concat chains (_cnext) into group numbers via union-find, so a
        // field and everything it chains to share one group. Numbered by earliest
        // column so the ids track column order.
        const uf = {}; rows.forEach((r) => { uf[r._uid] = r._uid; });
        const find = (u) => { while (uf[u] !== u) { u = uf[u] = uf[uf[u]]; } return u; };
        rows.forEach((r) => { if (r._cnext && uf[r._cnext] !== undefined) { const a = find(r._uid), b = find(r._cnext); if (a !== b) uf[a] = b; } });
        const byRoot = {}; rows.forEach((r) => { const root = find(r._uid); (byRoot[root] = byRoot[root] || []).push(r); });
        const groupNum = {}; let gn = 0;
        Object.values(byRoot).filter((g) => g.length >= 2)
          .sort((a, b) => Math.min(...a.map((x) => rows.indexOf(x))) - Math.min(...b.map((x) => rows.indexOf(x))))
          .forEach((g) => { gn++; g.forEach((x) => { groupNum[x._uid] = gn; }); });
        // Reserve every existing (non-empty) key up front, then emit it verbatim.
        // Reordering rows or adding a field must NEVER rename or reassign an
        // existing field's key: record data is stored under the field key, so a
        // changed key makes the server-side migration treat the field as removed
        // and prune its data. Only blank keys (brand-new fields) get a freshly
        // generated, collision-free key derived from the label.
        const seen = new Set();
        rows.forEach((f) => { const k = (f.key || '').trim(); if (k) seen.add(k); });
        const freshKey = (base) => {
          let key = base, n = 2;
          while (seen.has(key)) { key = base + '_' + n; n++; }
          seen.add(key);
          return key;
        };
        return rows.map((f) => {
          let options;
          if (CHOICE_TYPES.includes(f.type)) options = (f.options || '').split('\n').map((s) => s.trim()).filter(Boolean);
          else if (f.type === 'image') options = { max: f._orig ? 0 : (Number(f._max) || 1600), format: f._format || 'jpeg' };
          else if (f.type === 'image_crop') options = { ratio: f._ratio || '1:1', out: Number(f._out) || 600, format: f._format || 'jpeg' };
          else if (RULE_TYPES.includes(f.type)) {
            const rule = {};
            if (f._charset && f._charset !== 'none') rule.charset = f._charset;
            if (f._charset === 'custom' && f._pattern) rule.pattern = f._pattern;
            if (Number(f._rmin) > 0) rule.min = Number(f._rmin);
            if (Number(f._rmax) > 0) rule.max = Number(f._rmax);
            options = Object.keys(rule).length ? rule : undefined;
          }
          const existing = (f.key || '').trim();
          return {
            key: existing || freshKey(slug(f.label)),
            label: f.label.trim(), type: f.type, options,
            required: !!f.required, secret: !!f.secret, is_title: !!f.is_title, list_show: f.list_show !== false, table_show: f.table_show !== false, card_show: f.card_show !== false, concat: groupNum[f._uid] || 0,
            concat_sep: f._csep || 'space', concat_sep_char: f._csepChar || undefined, placeholder: f.placeholder || undefined,
          };
        });
      },
      openSchemaEditor() {
        this.schemaMode = 'collection';
        this.schemaFields = this.fieldsToSchemaRows(this.current.fields);
        this.schemaSep = this.current.key_sep || 'space';
        this.schemaSepChar = this.current.key_sep_char || '';
        this.modal = { type: 'schema' };
      },
      addSchemaField() { this.schemaFields.push({ key: '', label: '', type: 'text', options: '', required: false, secret: false, is_title: false, list_show: true, table_show: true, card_show: true, concat: 0, placeholder: '', _orig: false, _max: 1600, _ratio: '1:1', _out: 600, _format: 'jpeg', _charset: 'none', _pattern: '', _rmin: '', _rmax: '', _uid: this.uidCounter++, _cnext: 0, _csep: 'space', _csepChar: '' }); },
      removeSchemaField(i) { this.schemaFields.splice(i, 1); },
      moveField(i, d) { const j = i + d; if (j < 0 || j >= this.schemaFields.length) return; const a = this.schemaFields; [a[i], a[j]] = [a[j], a[i]]; },
      onFieldDragStart(i, e) {
        // Commit and drop focus from any field being edited BEFORE the reorder.
        // Dragging while an input is focused (e.g. right after renaming a field)
        // lets the browser's blur/move reset that input as the DOM node is
        // relocated, silently mangling the row — and on save, the mismatched
        // field is treated as removed and its record data is pruned. Blurring
        // flushes the pending value and detaches focus so the move is clean.
        try { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); } catch (_) { /* ignore */ }
        this.dragIndex = i;
        try {
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', String(i));
          const row = e.target.closest && e.target.closest('.schema-row');
          if (row) e.dataTransfer.setDragImage(row, 12, 12);
        } catch (_) { /* ignore */ }
      },
      onFieldDragOver(i) { if (this.dragIndex !== null) this.dragOverIndex = i; },
      onFieldDragLeave(i) { if (this.dragOverIndex === i) this.dragOverIndex = null; },
      onFieldDrop(i) { this.moveFieldTo(this.dragIndex, i); this.dragIndex = null; this.dragOverIndex = null; this.stopAutoScroll(); },
      onFieldDragEnd() { this.dragIndex = null; this.dragOverIndex = null; this.stopAutoScroll(); },
      // Keep the field list scrolling while a row is dragged near the top/bottom
      // edge of the modal body (native HTML5 drag does not auto-scroll).
      onSchemaAutoScroll(e) {
        if (this.dragIndex === null) return;
        const el = e.currentTarget;
        const r = el.getBoundingClientRect();
        const edge = 56;             // px hot-zone at each edge
        const maxStep = 16;          // px per tick at the very edge
        const y = e.clientY;
        let dir = 0;
        if (y < r.top + edge) {
          dir = -Math.ceil(((r.top + edge - y) / edge) * maxStep);
        } else if (y > r.bottom - edge) {
          dir = Math.ceil(((y - (r.bottom - edge)) / edge) * maxStep);
        }
        this.autoScroll.dir = dir;
        this.autoScroll.el = el;
        if (dir !== 0 && !this.autoScroll.timer) {
          this.autoScroll.timer = setInterval(() => {
            const s = this.autoScroll;
            if (!s.el || !s.dir) return;
            s.el.scrollTop += s.dir;
          }, 16);
        }
      },
      stopAutoScroll() {
        if (this.autoScroll.timer) { clearInterval(this.autoScroll.timer); }
        this.autoScroll.timer = null;
        this.autoScroll.dir = 0;
        this.autoScroll.el = null;
      },
      moveFieldTo(from, to) {
        if (from === null || to === null || from === to) return;
        const a = this.schemaFields;
        const [it] = a.splice(from, 1);
        a.splice(to, 0, it);
        // Concat chains only point forward (to a later field); drop any link that
        // now points to an earlier-or-same position after the move.
        a.forEach((f, i) => { if (f._cnext) { const ti = a.findIndex((g) => g._uid === f._cnext); if (ti <= i) f._cnext = 0; } });
      },
      // ---- sidebar collection hover: description popup ----
      showCollTip(c, e) {
        const desc = ((c && c.description) || '').trim();
        if (!desc) { this.hideCollTip(); return; }
        const el = e && e.currentTarget;
        const r = (el && el.getBoundingClientRect) ? el.getBoundingClientRect() : { right: 0, top: 0 };
        const y = Math.min(Math.round(r.top), (window.innerHeight || 800) - 140);
        this.collTip = { show: true, name: (c.name || ''), desc, x: Math.round(r.right + 8), y: Math.max(8, y) };
      },
      hideCollTip() { this.collTip.show = false; },
      // ---- sidebar collection drag & drop reordering (own collections only) ----
      cDragStart(i, e) {
        const c = this.collections[i];
        if (!c || c.is_owner === false) { if (e) e.preventDefault(); return; }
        this.hideCollTip();
        this.collDrag.from = i;
        try {
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', String(c.id));
        } catch (_) { /* ignore */ }
      },
      cDragOver(i) {
        if (this.collDrag.from === null) return;
        const c = this.collections[i];
        this.collDrag.over = (c && c.is_owner !== false) ? i : null;
      },
      cDragLeave(i) { if (this.collDrag.over === i) this.collDrag.over = null; },
      cDrop(i) {
        const from = this.collDrag.from;
        this.collDrag.from = null; this.collDrag.over = null;
        if (from === null || i === null || from === i) return;
        const target = this.collections[i];
        if (!target || target.is_owner === false) return;
        const a = this.collections;
        const [it] = a.splice(from, 1);
        a.splice(i, 0, it);
        this.saveCollOrder();
      },
      cDragEnd() { this.collDrag.from = null; this.collDrag.over = null; },
      async saveCollOrder() {
        const ids = this.collections.filter((c) => c.is_owner !== false).map((c) => c.id);
        try {
          await api('collection-order', { method: 'PUT', body: JSON.stringify({ ids }) });
        } catch (e) {
          this.showToast(T('Could not save the order'));
          this.loadCollections();
        }
      },
      // ---- record reorder (registration order) ----
      openReorder() {
        if (!this.canEdit || this.records.length < 2) return;
        const fields = this.reorderFields;
        this.reorder = {
          list: this.records.map((r) => ({ id: r.id, title: r.title, data: r.data || {} })),
          keys: [{ field: fields.length ? fields[0].key : '', dir: 'asc' }],
          from: null, over: null, busy: false,
        };
        this.modal = { type: 'reorder' };
      },
      addReorderKey() {
        if (this.reorder.keys.length < 5) this.reorder.keys.push({ field: '', dir: 'asc' });
      },
      removeReorderKey(i) {
        this.reorder.keys.splice(i, 1);
        if (!this.reorder.keys.length) this.reorder.keys.push({ field: '', dir: 'asc' });
      },
      fieldLabel(key) {
        const f = (this.current && this.current.fields || []).find((x) => x.key === key);
        return f ? f.label : key;
      },
      reorderTitle(r) {
        const t = (r.title == null ? '' : String(r.title)).trim();
        if (t !== '' && !t.startsWith('rbenc1:')) return t;
        // fall back to the first readable non-secret field value
        for (const f of this.reorderFields) {
          const v = r.data ? r.data[f.key] : '';
          if (v != null && String(v).trim() !== '') return String(v);
        }
        return T('(untitled)');
      },
      // Secondary line: the values of the selected sort fields, so choosing a
      // column immediately shows that column's content on every row.
      reorderRowSummary(r) {
        const keys = this.reorder.keys.filter((k) => k.field);
        const parts = [];
        for (const k of keys) {
          const v = r.data ? r.data[k.field] : '';
          const sv = (v == null ? '' : String(v)).trim();
          parts.push(this.fieldLabel(k.field) + ': ' + (sv || '—'));
        }
        return parts.join('  ·  ');
      },
      _cmpVals(a, b) {
        a = (a == null ? '' : String(a)).trim();
        b = (b == null ? '' : String(b)).trim();
        if (a === '' && b === '') return 0;
        if (a === '') return 1;   // empties sink to the bottom
        if (b === '') return -1;
        // A real number has at most one decimal point (after stripping thousands
        // separators). Strings like IP addresses "10.0.0.1" must NOT be treated as
        // numbers — parseFloat() would stop at the 2nd dot and read every
        // "10.0.0.x" as 10, collapsing them to equal so they never sort. Those
        // fall through to the numeric-aware locale compare below, which orders
        // each dotted segment correctly (10.0.0.2 before 10.0.0.10).
        const isNum = (s) => { const t = s.replace(/,/g, ''); return /^-?\d+(\.\d+)?$/.test(t) && isFinite(parseFloat(t)); };
        if (isNum(a) && isNum(b)) return parseFloat(a.replace(/,/g, '')) - parseFloat(b.replace(/,/g, ''));
        return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
      },
      applyReorderSort() {
        const keys = this.reorder.keys.filter((k) => k.field);
        if (!keys.length) return;
        this.reorder.list.sort((x, y) => {
          for (const k of keys) {
            const c = this._cmpVals(x.data ? x.data[k.field] : '', y.data ? y.data[k.field] : '');
            if (c !== 0) return k.dir === 'desc' ? -c : c;
          }
          return 0;
        });
      },
      rDragStart(i, e) {
        this.reorder.from = i;
        try {
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', String(i));
          const row = e.target.closest && e.target.closest('.reorder-row');
          if (row) e.dataTransfer.setDragImage(row, 12, 12);
        } catch (_) { /* ignore */ }
      },
      rDragOver(i) { if (this.reorder.from !== null) this.reorder.over = i; },
      rDragLeave(i) { if (this.reorder.over === i) this.reorder.over = null; },
      rDrop(i) {
        const from = this.reorder.from;
        if (from !== null && i !== null && from !== i) {
          const a = this.reorder.list;
          const [it] = a.splice(from, 1);
          a.splice(i, 0, it);
        }
        this.reorder.from = null; this.reorder.over = null;
      },
      rDragEnd() { this.reorder.from = null; this.reorder.over = null; },
      async saveReorder() {
        if (this.reorder.busy) return;
        this.reorder.busy = true;
        try {
          const ids = this.reorder.list.map((r) => r.id);
          await api('collections/' + this.current.id + '/record-order', { method: 'PUT', body: JSON.stringify({ ids }) });
          // Show the result: registration order, oldest (position 1) first.
          if (this.normSort(this.current.record_sort) !== 'created_asc') {
            if (this.canSettings) {
              try {
                const c = await api('collections/' + this.current.id, { method: 'PATCH', body: JSON.stringify({ record_sort: 'created_asc' }) });
                this.current.record_sort = c.record_sort;
                const inList = this.collections.find((x) => x.id === this.current.id);
                if (inList) inList.record_sort = c.record_sort;
              } catch (e) { this.current.record_sort = 'created_asc'; }
            } else {
              this.current.record_sort = 'created_asc';
            }
          }
          this.modal = null;
          await this.loadRecords();
          this.showToast(T('Order updated'));
        } catch (e) {
          alert(T('Could not save the new order'));
        } finally {
          this.reorder.busy = false;
        }
      },
      // Multiple fields may be titles; their values are joined (in field order)
      // to form the record title — e.g. tick "First name" + "Last name".
      setTitleField(i) { this.schemaFields[i].is_title = !this.schemaFields[i].is_title; },
      async saveSchema() {
        // Field names are required — do not silently drop unnamed fields.
        if (this.schemaFields.some((f) => !(f.label || '').trim())) { alert(T('Every field needs a name.')); return; }
        const newFields = this.serializeSchemaFields();
        if (!newFields.length) { alert(T('Keep at least one field')); return; }
        if (!newFields.some((f) => f.is_title)) newFields[0].is_title = true;
        // Guard existing data against incompatible field edits. Records are stored
        // as JSON keyed by field key and are NOT touched by a schema change, so a
        // type/secret change can silently break display, lose data on next edit,
        // orphan attachment files, or expose ciphertext. We diff old vs new fields,
        // migrate every record's data accordingly, and confirm once before saving.
        const ATT = ['image', 'image_crop', 'file'];
        const oldByKey = {}; (this.current.fields || []).forEach((f) => { oldByKey[f.key] = f; });
        const newKeys = new Set(newFields.map((f) => f.key));
        const selOpt = {}; newFields.forEach((f) => { if (CHOICE_TYPES.includes(f.type)) selOpt[f.key] = (f.options || []).slice(); });
        const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v));
        const isMonth = (v) => /^\d{4}-\d{2}$/.test(String(v));
        const isNum = (v) => { const t = String(v).replace(/,/g, ''); return /^-?\d+(\.\d+)?$/.test(t) && isFinite(parseFloat(t)); };
        let records;
        try { records = await api('collections/' + this.current.id + '/records'); }
        catch (e) { alert(T('Failed') + ': ' + (e.message || e)); return; }
        const counts = { decrypt: 0, encrypt: 0, attCleared: 0, toAtt: 0, dateCleared: 0, numCleared: 0, pruned: 0, selectAdded: 0 };
        const selectExtra = {};
        let needUnlock = false;
        const changed = [];
        for (const r of records) {
          const data = { ...r.data }; let dirty = false;
          // 1) data left over from removed fields (attachments are trashed server-side
          //    when we PUT the record below, while the OLD schema is still in effect)
          for (const k of Object.keys(data)) {
            if (!newKeys.has(k)) { if (data[k] != null && data[k] !== '') counts.pruned++; delete data[k]; dirty = true; }
          }
          // 2) per-field changes for keys that already existed
          for (const nf of newFields) {
            const of = oldByKey[nf.key]; if (!of) continue;
            let v = data[nf.key]; if (v == null || v === '') continue;
            // secret turned OFF: decrypt so the value is not shown/saved as ciphertext
            if (of.secret && !nf.secret && rbcrypto.isEnc(v)) {
              if (!encKey) { needUnlock = true; continue; }
              data[nf.key] = await rbcrypto.decrypt(encKey, v); dirty = true; counts.decrypt++; v = data[nf.key];
            } else if (!of.secret && nf.secret && !rbcrypto.isEnc(v) && this.enc.enabled && encKey) {
              // secret turned ON: encrypt the existing plain-text value
              data[nf.key] = await rbcrypto.encrypt(encKey, String(v)); dirty = true; counts.encrypt++; continue;
            }
            // type change: keep compatible values, clean up the rest
            if (of.type !== nf.type) {
              const from = of.type, to = nf.type;
              if (ATT.includes(from) && !ATT.includes(to)) { delete data[nf.key]; dirty = true; counts.attCleared++; }
              else if (!ATT.includes(from) && ATT.includes(to)) { delete data[nf.key]; dirty = true; counts.toAtt++; }
              else if (to === 'date') { if (!isDate(v)) { delete data[nf.key]; dirty = true; counts.dateCleared++; } }
              else if (to === 'month') { if (isMonth(v)) { /* ok */ } else if (isDate(v)) { data[nf.key] = v.slice(0, 7); dirty = true; } else { delete data[nf.key]; dirty = true; counts.dateCleared++; } }
              else if (to === 'number') { if (!isNum(v)) { delete data[nf.key]; dirty = true; counts.numCleared++; } }
              else if (CHOICE_TYPES.includes(to)) { const opts = selOpt[nf.key] || []; const parts = (to === 'checkbox') ? String(v).split(', ').map((s) => s.trim()).filter(Boolean) : [v]; for (const p of parts) { if (!opts.includes(p)) (selectExtra[nf.key] = selectExtra[nf.key] || new Set()).add(p); } }
            }
          }
          if (dirty) changed.push({ id: r.id, data });
        }
        if (needUnlock) { alert(T('Turning off Secret requires unlocking encryption first. Unlock it in Settings and try again.')); return; }
        // keep out-of-range values by adding them to the choices — never silently drop
        for (const nf of newFields) { if (CHOICE_TYPES.includes(nf.type) && selectExtra[nf.key]) { const add = [...selectExtra[nf.key]]; nf.options = [...(nf.options || []), ...add]; counts.selectAdded += add.length; } }
        // Split effects into data-destroying vs. safe. Anything that deletes a file
        // or clears/removes a value is DESTRUCTIVE and must pass a stricter, gated
        // confirmation (a checkbox the user has to tick) rather than a one-click OK.
        const destructive = [], safe = [];
        if (counts.attCleared) destructive.push(T('Delete {n} attached file(s) (field is no longer an attachment type)', { n: counts.attCleared }));
        if (counts.toAtt) destructive.push(T('Clear {n} value(s) that are not compatible with an attachment field', { n: counts.toAtt }));
        if (counts.dateCleared) destructive.push(T('Clear {n} value(s) that are not valid dates', { n: counts.dateCleared }));
        if (counts.numCleared) destructive.push(T('Clear {n} value(s) that are not numbers', { n: counts.numCleared }));
        if (counts.pruned) destructive.push(T('Remove leftover data of {n} value(s) from deleted fields', { n: counts.pruned }));
        if (counts.decrypt) safe.push(T('Decrypt {n} value(s) back to plain text (Secret turned off)', { n: counts.decrypt }));
        if (counts.encrypt) safe.push(T('Encrypt {n} value(s) (Secret turned on)', { n: counts.encrypt }));
        if (counts.selectAdded) safe.push(T('Add {n} existing value(s) to the choices so nothing is lost', { n: counts.selectAdded }));
        if (destructive.length) {
          // deletion involved → open the strict, checkbox-gated confirmation modal
          this.schemaPlan = { destructive, safe, fields: newFields, changed };
          this.schemaAck = false;
          this.modal = { type: 'schemaMigrate' };
          return;
        }
        if (safe.length && !confirm(T('This field change affects existing data:') + '\n\n- ' + safe.join('\n- ') + '\n\n' + T('Continue?'))) return;
        await this.commitSchema(newFields, changed);
      },
      // Apply the staged record migrations, then save the new field schema. Record
      // updates go FIRST, while the OLD schema is still active, so the server trashes
      // attachment files that are being removed or retyped.
      async commitSchema(newFields, changed) {
        // One undo group so the whole schema save (record migrations + field change)
        // reverts as a single Undo step.
        const grp = 'schema-' + this.current.id + '-' + (this.uidCounter++);
        try { for (const cr of changed) await api('records/' + cr.id, { method: 'PUT', body: JSON.stringify({ data: cr.data, _undoGroup: grp }) }); }
        catch (e) { alert(T('Failed') + ': ' + (e.message || e)); return false; }
        const c = await api('collections/' + this.current.id + '/fields', { method: 'PUT', body: JSON.stringify({ fields: newFields, _undoGroup: grp }) });
        this.current = c; this.modal = null; this.schemaPlan = null; this.schemaAck = false;
        await this.loadRecords(); this.showToast(T('Fields updated'));
        return true;
      },
      async confirmSchemaMigrate() {
        if (!this.schemaPlan || !this.schemaAck || this.busy) return;
        this.busy = true;
        try { await this.commitSchema(this.schemaPlan.fields, this.schemaPlan.changed); }
        finally { this.busy = false; }
      },
      // Cancel returns to the field editor (keeping the user's unsaved edits intact).
      cancelSchemaMigrate() { this.schemaPlan = null; this.schemaAck = false; this.modal = { type: 'schema' }; },
      openNewRecord() {
        if (!this.canEdit) return;
        this.form = {}; this.reveal = {}; this.editingRecordId = null; this.editingOrig = null;
        this.current.fields.forEach((f) => (this.form[f.key] = f.type === 'checkbox' ? [] : ''));
        this.modal = { type: 'record' };
      },
      openRecord(rec) { this.reveal = {}; this.openDecrypted = {}; this.preloadFileMetas(this.current.fields, rec.data); this.modal = { type: 'detail', rec }; this.decryptSecretsOf(rec); },
      // ---- ノート形式表示の操作 ----
      // 右の内容ペインにレコードを表示。openRecord と同じく reveal/添付/秘密の復号を
      // 用意する（モーダルは開かない）。
      selNoteRec(rec) {
        this.reveal = {}; this.openDecrypted = {};
        this.note.id = rec.id;
        this.preloadFileMetas(this.current.fields, rec.data);
        this.decryptSecretsOf(rec);
      },
      async editRecord(rec) {
        if (!this.canEdit) return;
        this.form = {}; this.reveal = {}; this.editingRecordId = rec.id; this.editingOrig = rec.data;
        for (const f of this.current.fields) {
          // masked secrets in a shared collection: leave the field blank & read-only,
          // the original ciphertext is preserved on save (see saveRecord)
          if (f.secret && this.secretsMasked) { this.form[f.key] = ''; continue; }
          if (f.type === 'checkbox') { this.form[f.key] = this.cbSplit(rec.data[f.key], f); continue; }
          this.form[f.key] = f.secret ? await this.secretPlain(rec.data[f.key]) : (rec.data[f.key] ?? '');
        }
        this.preloadFileMetas(this.current.fields, rec.data);
        this.modal = { type: 'record' };
      },
      async saveRecord() {
        for (const f of this.current.fields) if (f.required && !String(this.form[f.key] ?? '').trim()) { alert(T('{label} is required', { label: f.label })); return; }
        for (const f of this.current.fields) { const err = this.validateField(f, this.form[f.key]); if (err) { alert(err); return; } }
        let data = {};
        for (const f of this.current.fields) { let v = this.form[f.key]; if (f.type === 'checkbox') v = this.cbJoin(v); if (v !== '' && v != null) data[f.key] = v; }
        // preserve masked secrets untouched (recipient can't see/change them)
        if (this.secretsMasked) {
          for (const f of this.current.fields) {
            if (!f.secret) continue;
            const orig = this.editingOrig ? this.editingOrig[f.key] : undefined;
            if (orig != null && orig !== '') data[f.key] = orig; else delete data[f.key];
          }
        }
        data = await this.encryptData(data);
        if (this.editingRecordId) { await api('records/' + this.editingRecordId, { method: 'PUT', body: JSON.stringify({ data }) }); this.showToast(T('Updated')); }
        else { await api('collections/' + this.current.id + '/records', { method: 'POST', body: JSON.stringify({ data }) }); this.showToast(T('Registered')); }
        this.modal = null; await this.loadRecords(); await this.loadCollections();
      },
      async deleteRecord(rec) {
        if (!confirm(T('Delete this record?'))) return;
        await api('records/' + rec.id, { method: 'DELETE' });
        this.modal = null; await this.loadRecords(); await this.loadCollections(); this.showToast(T('Deleted'));
      },
      // ---- import ----
      openImport() {
        this.importStep = 1; this.importCsv = ''; this.importFileName = '';
        this.importAnalysis = null; this.importCols = []; this.importBusy = false;
        this.modal = { type: 'import' };
      },
      async openContactsImport() {
        this.contactsImport = { books: [], selected: 'all', name: '', icon: '', busy: false, err: '', loading: true, enabled: true };
        this.modal = { type: 'contactsImport' };
        try {
          const r = await api('contacts/addressbooks');
          this.contactsImport.enabled = !!r.enabled;
          this.contactsImport.books = r.books || [];
        } catch (e) { this.contactsImport.err = e.message || String(e); this.contactsImport.enabled = false; }
        finally { this.contactsImport.loading = false; }
      },
      async commitContactsImport() {
        this.contactsImport.busy = true; this.contactsImport.err = '';
        try {
          const res = await api('contacts/import', { method: 'POST', body: JSON.stringify({ addressbook: this.contactsImport.selected, name: this.contactsImport.name || '', icon: this.contactsImport.icon || '' }) });
          this.modal = null;
          await this.loadCollections();
          this.showToast(T('Imported {n} items', { n: res.imported }));
          if (res.collectionId) this.selectCollection(res.collectionId);
        } catch (e) { this.contactsImport.err = e.message || String(e); }
        finally { this.contactsImport.busy = false; }
      },
      async openTablesImport() {
        this.tablesImport = { tables: [], selected: 0, name: '', icon: '', busy: false, err: '', loading: true, available: true };
        this.modal = { type: 'tablesImport' };
        try {
          const r = await api('tables/list');
          this.tablesImport.available = !!r.available;
          this.tablesImport.tables = r.tables || [];
          if (this.tablesImport.tables.length) this.tablesImport.selected = this.tablesImport.tables[0].id;
          if (r.error) this.tablesImport.err = r.error;
        } catch (e) { this.tablesImport.err = e.message || String(e); this.tablesImport.available = false; }
        finally { this.tablesImport.loading = false; }
      },
      async commitTablesImport() {
        if (!this.tablesImport.selected) return;
        this.tablesImport.busy = true; this.tablesImport.err = '';
        try {
          const res = await api('tables/import', { method: 'POST', body: JSON.stringify({ tableId: this.tablesImport.selected, name: this.tablesImport.name || '', icon: this.tablesImport.icon || '' }) });
          this.modal = null;
          await this.loadCollections();
          this.showToast(T('Imported {n} items', { n: res.imported }));
          if (res.collectionId) this.selectCollection(res.collectionId);
        } catch (e) { this.tablesImport.err = e.message || String(e); }
        finally { this.tablesImport.busy = false; }
      },
      async exportToTables() {
        if (!this.current) return;
        this.tablesExportBusy = true;
        try {
          const res = await api('collections/' + this.current.id + '/tables-export', { method: 'POST', body: JSON.stringify({}) });
          let msg = T('Exported {n} rows to Tables', { n: res.exported });
          if (res.skippedFields) msg += ' ' + T('({n} fields skipped)', { n: res.skippedFields });
          this.showToast(msg);
        } catch (e) { alert((this.t ? this.t('Export to Tables failed') : 'Export to Tables failed') + ': ' + (e.message || String(e))); }
        finally { this.tablesExportBusy = false; }
      },
      onImportFile(e) {
        const f = e.target.files && e.target.files[0];
        if (!f) return;
        this.importFileName = f.name;
        const r = new FileReader();
        r.onload = () => { this.importCsv = String(r.result || ''); this.analyzeImport(); };
        r.readAsText(f);
      },
      async analyzeImport() {
        if (!this.importCsv.trim()) { alert(T('Please enter CSV or JSON')); return; }
        try {
          const a = await api('import/analyze', { method: 'POST', body: JSON.stringify({ csv: this.importCsv }) });
          this.importAnalysis = a;
          this.importColl = { name: a.suggestedName, icon: a.suggestedIcon, color: a.suggestedColor };
          this.importCols = a.columns.map((c) => ({ ...c }));
          this.importStep = 2;
        } catch (e) { alert(T('Failed to analyze') + ': ' + e.message); }
      },
      setImportTitle(i) { this.importCols.forEach((c, k) => (c.is_title = k === i)); },
      async commitImport() {
        this.importBusy = true;
        try {
          const res = await api('import/commit', { method: 'POST', body: JSON.stringify({
            csv: this.importCsv, mode: 'new', collection: this.importColl, columns: this.importCols,
          }) });
          this.modal = null;
          await this.loadCollections();
          await this.selectCollection(res.collectionId);
          this.showToast(T('Imported {n} items', { n: res.imported }));
        } catch (e) { alert(T('Import failed') + ': ' + e.message); }
        finally { this.importBusy = false; }
      },
      // ---- selection ----
      isSelected(id) { return this.selectedIds.includes(id); },
      toggleSelect(id) {
        const i = this.selectedIds.indexOf(id);
        if (i >= 0) this.selectedIds.splice(i, 1);
        else this.selectedIds.push(id);
        if (this.selectedIds.length) this.selectionMode = true; // checking opens the menu
      },
      selectAll() { this.selectedIds = this.records.map((r) => r.id); if (this.selectedIds.length) this.selectionMode = true; },
      clearSelection() { this.selectedIds = []; },

      // ---- bulk actions ----
      async duplicateInPlace() {
        if (!this.selectedIds.length) return;
        const mapping = {};
        this.current.fields.forEach((f) => (mapping[f.key] = f.key));
        const res = await api('transfer', { method: 'POST', body: JSON.stringify({
          sourceCollectionId: this.current.id, targetCollectionId: this.current.id,
          recordIds: [...this.selectedIds], mode: 'copy', mapping,
        }) });
        this.clearSelection();
        await this.loadRecords(); await this.loadCollections();
        this.showToast(T('Copied {n} items', { n: res.count }));
      },
      openTransferBulk(mode) {
        this.xfer = { mode, recordIds: [...this.selectedIds], targetId: '', target: null, mapping: {}, appendTo: '', busy: false, newName: '' };
        this.modal = { type: 'transfer' };
      },
      openBulkDelete() { this.delConfirm = false; this.modal = { type: 'bulkDelete' }; },
      async commitBulkDelete() {
        this.busy = true;
        try {
          const ids = [...this.selectedIds];
          await api('records/delete', { method: 'POST', body: JSON.stringify({ ids }) });
          this.modal = null; this.clearSelection();
          await this.loadRecords(); await this.loadCollections();
          this.showToast(T('Deleted {n} items', { n: ids.length }));
        } catch (e) { alert(T('Failed to delete') + ': ' + e.message); }
        finally { this.busy = false; }
      },

      // ---- transfer (move/copy between collections) ----
      openTransfer(rec) {
        this.xfer = { mode: 'copy', recordIds: [rec.id], targetId: '', target: null, mapping: {}, appendTo: '', busy: false, newName: '' };
        this.modal = { type: 'transfer' };
      },
      async onTransferTarget(id) {
        this.xfer.targetId = id;
        this.xfer.target = null;
        if (!id) { return; }
        if (id === '__newcoll__') {
          // Create-a-new-collection destination: same schema as the source.
          if (!this.xfer.newName) this.xfer.newName = T('{name} copy', { name: this.current ? this.current.name : '' });
          return;
        }
        const target = await api('collections/' + id);
        const mapping = {};
        for (const sf of this.current.fields) {
          const t = target.fields.find((tf) => tf.label === sf.label) || target.fields.find((tf) => tf.key === sf.key);
          mapping[sf.key] = t ? t.key : '__new__';
        }
        this.xfer.target = target;
        this.xfer.mapping = mapping;
        const firstTa = target.fields.find((f) => f.type === 'textarea');
        this.xfer.appendTo = firstTa ? firstTa.key : '';
      },
      async commitTransfer() {
        // Destination = a brand-new collection cloned from the source schema.
        if (this.xfer.targetId === '__newcoll__') {
          const name = (this.xfer.newName || '').trim();
          if (!name) { alert(T('Please enter a new collection name')); return; }
          this.xfer.busy = true;
          try {
            const fields = this.current.fields.map((f) => ({
              key: f.key, label: f.label, type: f.type, options: f.options || undefined,
              required: !!f.required, secret: !!f.secret, is_title: !!f.is_title, placeholder: f.placeholder || undefined,
            }));
            const coll = await api('collections', { method: 'POST', body: JSON.stringify({
              name, icon: this.current.icon, color: this.current.color, view: this.current.view, fields,
            }) });
            const mapping = {};
            this.current.fields.forEach((f) => (mapping[f.key] = f.key));
            const res = await api('transfer', { method: 'POST', body: JSON.stringify({
              sourceCollectionId: this.current.id, targetCollectionId: coll.id,
              recordIds: this.xfer.recordIds, mode: this.xfer.mode, mapping,
            }) });
            this.modal = null; this.clearSelection();
            await this.loadRecords(); await this.loadCollections();
            this.showToast(T('{op} {n} items to the new collection “{name}”', { name, n: res.count, op: this.xfer.mode === 'move' ? T('Move') : T('Duplicate') }));
          } catch (e) { alert(T('Operation failed') + ': ' + e.message); }
          finally { this.xfer.busy = false; }
          return;
        }
        if (!this.xfer.target) return;
        this.xfer.busy = true;
        try {
          const used = new Set(this.xfer.target.fields.map((f) => f.key));
          const addFields = [];
          const mapping = {};
          for (const sf of this.current.fields) {
            const v = this.xfer.mapping[sf.key];
            if (v === '__new__') {
              let key = sf.key, n = 2;
              while (used.has(key)) key = sf.key + '_' + n++;
              used.add(key);
              addFields.push({ key, label: sf.label, type: sf.type, secret: sf.secret, options: sf.options || undefined });
              mapping[sf.key] = key;
            } else if (v) {
              mapping[sf.key] = v;
            }
          }
          const res = await api('transfer', { method: 'POST', body: JSON.stringify({
            sourceCollectionId: this.current.id,
            targetCollectionId: Number(this.xfer.targetId),
            recordIds: this.xfer.recordIds,
            mode: this.xfer.mode,
            mapping,
            appendUnmappedTo: this.xfer.appendTo || null,
            addFields,
          }) });
          this.modal = null;
          this.clearSelection();
          await this.loadRecords();
          await this.loadCollections();
          this.showToast(T('{op} {n} items', { n: res.count, op: this.xfer.mode === 'move' ? T('Move') : T('Duplicate') }));
        } catch (e) { alert(T('Operation failed') + ': ' + e.message); }
        finally { this.xfer.busy = false; }
      },
      inputType(f) {
        // Secret fields are plain text masked with CSS (.secret-mask) rather than
        // type="password", so the browser never treats the record form as a login
        // and won't offer to save/autofill credentials. Reveal toggles the mask class.
        if (f.secret) return 'text';
        return { number: 'number', date: 'date', month: 'month', email: 'email', url: 'url', tel: 'tel' }[f.type] || 'text';
      },
      fieldRule(f) {
        if (!RULE_TYPES.includes(f.type)) return null;
        const o = f.options;
        return (o && typeof o === 'object' && !Array.isArray(o) && (o.charset || o.min || o.max || o.pattern)) ? o : null;
      },
      ruleMax(f) { const o = this.fieldRule(f); return o && o.max ? o.max : null; },
      ruleHint(f) {
        const o = this.fieldRule(f); if (!o) return '';
        const parts = [];
        if (o.charset === 'custom') parts.push(T('Format: {p}', { p: o.pattern || '' }));
        else if (o.charset && CHARSET_LABEL[o.charset]) parts.push(T('{charset} only', { charset: T(CHARSET_LABEL[o.charset]) }));
        if (o.min && o.max) parts.push(T('{min}–{max} characters', { min: o.min, max: o.max }));
        else if (o.min) parts.push(T('{min} characters or more', { min: o.min }));
        else if (o.max) parts.push(T('up to {max} characters', { max: o.max }));
        return parts.join(' / ');
      },
      // checkbox stores multiple choices as a ", "-joined string; convert to/from
      // an array for the checkbox inputs (kept in sync with the field's options).
      cbJoin(arr) { return Array.isArray(arr) ? arr.filter((x) => x != null && x !== '').join(', ') : (arr || ''); },
      cbSplit(v, f) {
        if (v == null || v === '') return [];
        const parts = String(v).split(', ').map((s) => s.trim()).filter(Boolean);
        const opts = Array.isArray(f && f.options) ? f.options : null;
        return opts ? parts.filter((p) => opts.includes(p)) : parts;
      },
      validateField(f, v) {
        const o = this.fieldRule(f); if (!o) return null;
        const s = String(v == null ? '' : v);
        if (s === '') return null; // empty handled by "required"
        if (o.min && s.length < o.min) return T('{label} must be at least {min} characters', { label: f.label, min: o.min });
        if (o.max && s.length > o.max) return T('{label} must be at most {max} characters', { label: f.label, max: o.max });
        if (o.charset === 'custom') {
          try { if (o.pattern && !(new RegExp('^(?:' + o.pattern + ')$')).test(s)) return T('{label} has an invalid format', { label: f.label }); } catch (e) { /* invalid pattern -> skip */ }
        } else if (o.charset && CHARSET_RE[o.charset] && !CHARSET_RE[o.charset].test(s)) {
          return T('{label} may contain {charset} only', { label: f.label, charset: T(CHARSET_LABEL[o.charset]) });
        }
        return null;
      },
      // ---- password generator ----
      // the effective character set for one class, after removing look-alikes
      pwgenClassSet(k) {
        let s = k === 'symbols' ? this.pwgen.symbolSet : PWGEN_SETS[k];
        if (this.pwgen.noLookalike) s = s.split('').filter((ch) => PWGEN_LOOKALIKE.indexOf(ch) < 0).join('');
        return s;
      },
      pwgenAvail(c) {
        const cs = this.pwgenCharset;
        if (!cs || cs === 'ascii' || cs === 'custom') return true;
        if (cs === 'digits' || cs === 'phone') return c === 'digits';
        if (cs === 'alnum') return c !== 'symbols';
        if (cs === 'alpha') return c === 'upper' || c === 'lower';
        if (cs === 'hex') return false; // fixed 0-9A-F alphabet
        return true;
      },
      openPwGen(target, field) {
        const p = this.pwgen;
        p.target = target; p.field = field || null; p.err = '';
        if (!p.loaded) { // remembered options, like KeePass keeps its profile
          p.loaded = true;
          try {
            const o = JSON.parse(localStorage.getItem('regibase.pwgen2') || 'null');
            if (o && typeof o === 'object') {
              for (const k of PWGEN_CLASSES.concat('noLookalike', 'firstAlpha')) if (typeof o[k] === 'boolean') p[k] = o[k];
              if (Number(o.len) > 0) p.prefLen = Number(o.len);
              if (o.min && typeof o.min === 'object') for (const k of PWGEN_CLASSES) if (Number.isFinite(Number(o.min[k]))) p.min[k] = Math.max(0, Math.floor(Number(o.min[k])));
              if (o.max && typeof o.max === 'object') for (const k of PWGEN_CLASSES) p.max[k] = (o.max[k] == null ? null : Math.max(0, Math.floor(Number(o.max[k]) || 0)));
              if (typeof o.symbolSet === 'string') { const s = o.symbolSet.split('').filter((ch) => PWGEN_SETS.symbols.indexOf(ch) >= 0).join(''); p.symbolSet = s || PWGEN_SETS.symbols; }
            }
          } catch (e) { /* ignore unreadable prefs */ }
        }
        p.len = p.prefLen;
        // the rule may forbid every class the user had enabled — fall back to what it allows
        if (!this.pwgenActive.length) { for (const k of PWGEN_CLASSES) p[k] = this.pwgenAvail(k); }
        p.open = true;
        this.pwgenReconcile();
        this.pwgenMake();
      },
      pwgenSetLen() { this.pwgen.prefLen = Math.max(1, Math.floor(Number(this.pwgen.len) || 1)); this.pwgenReconcile(); this.pwgenMake(); },
      closePwGen() { const p = this.pwgen; p.open = false; p.value = ''; p.err = ''; p.capWarn = false; p.field = null; p.target = null; },
      pwgenToggle(k, ev) {
        const p = this.pwgen;
        p[k] = ev.target.checked;
        // never leave zero contributing classes. Reverting true→true is a no-op Vue
        // won't repaint, so restore the DOM checkbox straight from the event.
        if (!this.pwgenActive.length) { p[k] = true; ev.target.checked = true; return; }
        this.pwgenReconcile(); this.pwgenMake();
      },
      pwgenSetMin(k, raw) {
        this.pwgen.min[k] = Math.max(0, Math.floor(Number(raw) || 0));
        this.pwgenReconcile(); this.pwgenMake();
      },
      pwgenSetMax(k, raw) {
        const s = String(raw).trim();
        this.pwgen.max[k] = (s === '') ? null : Math.max(0, Math.floor(Number(s) || 0));
        this.pwgenReconcile(); this.pwgenMake();
      },
      pwgenToggleSymbol(ch) {
        const p = this.pwgen;
        const has = p.symbolSet.indexOf(ch) >= 0;
        // keep the master order so the set reads the same however it was toggled
        p.symbolSet = PWGEN_SETS.symbols.split('').filter((c) => (c === ch ? !has : p.symbolSet.indexOf(c) >= 0)).join('');
        this.pwgenReconcile(); this.pwgenMake();
      },
      pwgenAllSymbols(on) { this.pwgen.symbolSet = on ? PWGEN_SETS.symbols : ''; this.pwgenReconcile(); this.pwgenMake(); },
      // ---- 排他処理 (constraint reconciliation) ----
      // Force min/max/length into a mutually consistent, generatable state so the
      // user can never configure an impossible request. Priority: min <= max per
      // class; sum(min) fits the field's ceiling; length lands in [minSum, maxSum].
      pwgenReconcile() {
        const p = this.pwgen;
        const hardMax = this.pwgenHardMax, hardMin = this.pwgenHardMin;
        const active = this.pwgenActive.map((c) => c.k);
        // per-class normalisation
        for (const k of PWGEN_CLASSES) {
          let mn = Math.max(0, Math.floor(Number(p.min[k]) || 0));
          let mx = p.max[k]; if (mx != null) mx = Math.max(0, Math.floor(Number(mx) || 0));
          if (mn > hardMax) mn = hardMax;
          if (mx != null && mx > hardMax) mx = hardMax;
          if (mx != null && mx < mn) mx = mn;      // a cap below the floor makes no sense
          p.min[k] = mn; p.max[k] = mx;
        }
        // sum(min) over active classes must not exceed the field ceiling; trim from the end
        let over = active.reduce((s, k) => s + p.min[k], 0) - hardMax;
        for (let i = active.length - 1; i >= 0 && over > 0; i--) { const cut = Math.min(over, p.min[active[i]]); p.min[active[i]] -= cut; over -= cut; }
        // clamp length into the feasible window
        const lo = Math.max(hardMin, this.pwgenMinSum);
        const hi = Math.max(lo, Math.min(hardMax, this.pwgenMaxSum));
        p.len = Math.max(lo, Math.min(hi, Number(p.len) || lo));
        // caps so low that the length floor cannot be met (extreme misconfig)
        p.capWarn = this.pwgenMaxSum < lo;
      },
      // Reorder so the first character is a letter (upper/lower), preserving every
      // character-class count (it only swaps position 0 with another letter's slot).
      pwgenEnforceFirstAlpha(s) {
        const letters = (this.pwgen.upper ? this.pwgenClassSet('upper') : '') + (this.pwgen.lower ? this.pwgenClassSet('lower') : '');
        if (!letters || !s) return s;
        const isL = (ch) => letters.indexOf(ch) >= 0;
        const arr = s.split('');
        if (isL(arr[0])) return s;
        for (let i = 1; i < arr.length; i++) {
          if (isL(arr[i])) { const t = arr[0]; arr[0] = arr[i]; arr[i] = t; break; }
        }
        return arr.join('');
      },
      // Format a large count into rough Japanese myriad units (約…通り).
      pwgenJaMyriad(n) {
        const units = ['', '万', '億', '兆', '京', '垓', '秭', '穣', '溝', '澗', '正', '載', '極', '恒河沙', '阿僧祇', '那由他', '不可思議', '無量大数'];
        if (n < 10000) return '約' + Math.round(n).toLocaleString() + '通り';
        let i = Math.floor(Math.log10(n) / 4);
        if (i >= units.length) i = units.length - 1;
        const topDiv = Math.pow(10, i * 4);
        const topVal = Math.floor(n / topDiv);
        let s = String(topVal) + units[i];
        if (i >= 1) {
          const secVal = Math.floor((n - topVal * topDiv) / Math.pow(10, (i - 1) * 4));
          if (secVal > 0) s += String(secVal) + units[i - 1];
        }
        return '約' + s + '通り';
      },
      // Open the generator in "set defaults" mode (from Collection settings).
      openPwGenDefaults() { this.openPwGen('defaults'); },
      pwgenMake() {
        const p = this.pwgen;
        if (this.pwgenIsHex) { p.value = makePassword([{ set: PWGEN_HEX, min: 0, cap: null }], p.len); p.err = ''; return; }
        const classes = this.pwgenActive.map((c) => ({ set: c.set, min: Number(p.min[c.k]) || 0, cap: p.max[c.k] == null ? null : Number(p.max[c.k]) }));
        if (!classes.length) { p.value = ''; p.err = T('Select at least one character type'); return; }
        p.value = makePassword(classes, p.len);
        if (p.firstAlpha && this.pwgenFirstAlphaUsable) { p.value = this.pwgenEnforceFirstAlpha(p.value); }
        if (p.capWarn) { p.err = T('The maximum counts are too low for this length.'); return; }
        // a custom regex rule cannot be generated against — warn instead of silently failing on save
        p.err = (p.field && this.validateField(p.field, p.value)) ? T('This field has a format rule the generator cannot match. Please check the value.') : '';
      },
      pwgenApply() {
        const p = this.pwgen;
        if (!p.value) return;
        const defaultsMode = (p.target === 'defaults');
        if (!defaultsMode) {
          if (p.target === 'share') { this.sharePanel.password = p.value; }
          else if (p.field) {
            this.form[p.field.key] = p.value;
            this.reveal = { ...this.reveal, [p.field.key]: true }; // show it once so it can be checked/copied
          }
        }
        try {
          localStorage.setItem('regibase.pwgen2', JSON.stringify({
            len: p.prefLen, upper: p.upper, lower: p.lower, digits: p.digits, symbols: p.symbols,
            noLookalike: p.noLookalike, firstAlpha: p.firstAlpha, min: p.min, max: p.max, symbolSet: p.symbolSet,
          }));
        } catch (e) { /* prefs are a convenience only */ }
        this.closePwGen();
        this.showToast(defaultsMode ? T('Default values saved') : T('Password generated'));
      },
      toggleReveal(key) { this.reveal = { ...this.reveal, [key]: !this.reveal[key] }; },
      async copyVal(v) { try { await navigator.clipboard.writeText(String(v)); this.showToast(T('Copied')); } catch { this.showToast(T('Copy failed')); } },
      // Build a start/end (epoch seconds) all-day range from a date/month field and open
      // the Calendar app's own "new event" editor in a popup, prefilled with that date.
      reminderRange(f, raw) {
        if (raw == null || raw === '') return null;
        let s = String(raw).trim();
        if (f.type === 'month') s = /^\d{4}-\d{2}$/.test(s) ? s + '-01' : s;      // YYYY-MM -> first day
        if (!/^\d{4}-\d{2}-\d{2}/.test(s)) return null;                            // not a date value
        const d = new Date(s.slice(0, 10) + 'T00:00:00');                         // local midnight
        if (isNaN(d.getTime())) return null;
        const start = Math.floor(d.getTime() / 1000);
        return { start, end: start + 86400 };                                     // all-day, next-day exclusive end
      },
      addReminder(rec, f) {
        if (!this.apps.calendar) return;
        const r = this.reminderRange(f, rec.data[f.key]);
        if (!r) { this.showToast(T('Not a valid date')); return; }
        const url = OC.generateUrl('/apps/calendar/new/1/' + r.start + '/' + r.end);
        window.open(url, 'rbcal', 'popup,width=520,height=760,noopener');
      },
      // Address fields carry a map link. (options.map is honoured for backward
      // compatibility with fields created before the dedicated 'address' type.)
      fieldHasMap(f) { return !!(f && !f.secret && (f.type === 'address' || (f.options && f.options.map))); },
      // Build a search URL for the chosen map service from a free-text address.
      mapUrl(address) {
        const q = encodeURIComponent(String(address).trim());
        if (!q) return null;
        // per-collection override wins; empty means the default (Google Maps)
        const provider = (this.current && this.current.map_provider) || 'google';
        switch (provider) {
          case 'yahoo': return 'https://map.yahoo.co.jp/search?q=' + q;
          case 'osm': return 'https://www.openstreetmap.org/search?query=' + q;
          case 'apple': return 'https://maps.apple.com/?q=' + q;
          case 'bing': return 'https://www.bing.com/maps?q=' + q;
          default: return 'https://www.google.com/maps/search/?api=1&query=' + q;
        }
      },
      openMap(address) {
        const url = this.mapUrl(address);
        if (url) window.open(url, '_blank', 'noopener');
      },
      displayVal(rec, f) {
        const v = rec.data[f.key];
        if (v == null || v === '') return '—';
        if (f.secret) { if (!this.reveal[f.key]) return '••••••••'; const p = this.openDecrypted[f.key]; return p != null ? p : T('(decrypting…)'); }
        return v;
      },
      // Make URL / email / tel fields clickable in the detail view.
      linkFor(f, v) {
        if (v == null || v === '' || f.secret) return null;
        const s = String(v).trim();
        if (f.type === 'email') return s.includes('@') ? 'mailto:' + s : null;
        if (f.type === 'tel') { const t = s.replace(/[^\d+]/g, ''); return t ? 'tel:' + t : null; }
        if (f.type === 'url') {
          if (/^(javascript|data|vbscript):/i.test(s)) return null;
          if (/^https?:\/\//i.test(s)) return s;
          if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return s;
          return 'https://' + s;
        }
        return null;
      },
      // One-line summary for the compact views (list / card / image). Composed
      // exactly like the table: concat groups are merged with their paren /
      // separator settings, then the eligible values are joined into one line.
      // (Replaces the old single-raw-field subtitle so concat & parentheses show.)
      summary(rec) {
        const groups = this.curView === 'card' ? this.cardGroups : this.listGroups;
        const parts = [];
        for (const col of groups) {
          const t = this.colText(rec, col);
          if (t !== '' && t != null) parts.push(t);
        }
        return parts.join(' · ');
      },
      // Fields for a summary line, filtered by the given per-view flag, with concat
      // groups merged. Excludes title / secret / attachment (not text-representable).
      buildSummaryGroups(flag) {
        if (!this.current) return [];
        // Don't pre-filter by the flag: for a concat group the LEADING member
        // (連結元 — first in field order) governs the whole group's visibility,
        // not each member individually (otherwise a 連結先 could control it).
        const displayable = this.current.fields.filter((f) => !f.is_title && !f.secret && f.type !== 'image' && f.type !== 'image_crop' && f.type !== 'file');
        const groups = {};
        displayable.forEach((f) => { const g = f.concat || 0; if (g) (groups[g] = groups[g] || []).push(f); });
        const used = new Set();
        const cols = [];
        for (const f of displayable) {
          if (used.has(f.key)) continue;
          const g = f.concat || 0;
          if (g) {
            const m = groups[g]; m.forEach((x) => used.add(x.key));
            if (m[0][flag] !== false) cols.push({ kind: 'concat', id: '__c' + g, members: m, label: m.map((x) => x.label).join(' / ') });
          } else {
            used.add(f.key);
            if (f[flag] !== false) cols.push({ kind: 'field', id: f.key, field: f, label: f.label });
          }
        }
        return cols;
      },
      showToast(m) { this.toast = m; clearTimeout(this._t); this._t = setTimeout(() => (this.toast = ''), 1900); },
      onSearchInput() { this.selectedIds = []; clearTimeout(this._s); this._s = setTimeout(() => this.loadRecords(), 250); },
      // Find & replace across the currently-matched records. Normal mode does a
      // case-insensitive literal replace; regex mode uses the pattern (global).
      // Secret and attachment fields are never touched. All edits share one undo
      // group so a single snapshot revert undoes the whole replace.
      async applyReplace() {
        const cid = this.current && this.current.id;
        if (!cid || !this.search || this.replaceBusy) return;
        let re;
        try {
          re = this.searchRegex
            ? new RegExp(this.search, 'g')
            : new RegExp(this.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
        } catch (e) { alert(T('Invalid regular expression') + ': ' + (e.message || e)); return; }
        const repl = this.replaceWith != null ? String(this.replaceWith) : '';
        const skip = new Set(['image', 'image_crop', 'file']);
        const fields = (this.current.fields || []).filter((f) => !f.secret && !skip.has(f.type));
        const targets = [];
        for (const r of this.records) {
          const d = r.data || {}; const nd = { ...d }; let hit = false;
          for (const f of fields) {
            const v = d[f.key];
            if (typeof v !== 'string' || v === '') continue;
            re.lastIndex = 0;
            if (re.test(v)) { re.lastIndex = 0; nd[f.key] = v.replace(re, repl); hit = true; }
          }
          if (hit) targets.push({ id: r.id, data: nd });
        }
        if (!targets.length) { this.showToast(T('No matches to replace')); return; }
        if (!confirm(T('Replace in {n} record(s)? This can be undone from snapshots.', { n: targets.length }))) return;
        this.replaceBusy = true;
        const grp = 'replace-' + cid + '-' + (this.uidCounter++);
        try {
          // one request for the whole batch — the server updates every record in a
          // single pass, instead of one HTTP round-trip per record.
          const r = await api('collections/' + cid + '/records/bulk', { method: 'POST', body: JSON.stringify({ updates: targets, _undoGroup: grp }) });
          const n = (r && typeof r.updated === 'number') ? r.updated : targets.length;
          this.showToast(T('Replaced in {n} record(s)', { n }));
          await this.loadRecords();
        } catch (e) { alert(T('Failed') + ': ' + (e.message || e)); }
        finally { this.replaceBusy = false; }
      },
    },
    render,
  }).mount('#regibase-root');
})();
