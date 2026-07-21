/* RegiBase — Nextcloud native SPA (buildless Vue 3, ported from the standalone app).
 * Auth is handled by Nextcloud (per-user data); there is no master password. */
(function () {
  'use strict';
  const { createApp } = Vue;

  const BASE = ((window.OC && OC.generateUrl) ? OC.generateUrl('/apps/regibase') : '/apps/regibase') + '/';
  const TOKEN = (window.OC && OC.requestToken) ? OC.requestToken : '';
  let rootProxy = null;

  // i18n: Japanese strings are the source/keys. Nextcloud loads l10n/<ncLang>.js server-side.
  // When the RegiBase 'language' setting is not 'auto', we install a client-side override
  // map (fetched from /api/i18n/<lang>) so the user can pick a language independent of NC.
  // escape:false because Vue's {{ }} / attribute binding already escapes output.
  let i18nOverride = null;
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

  async function api(path, opts = {}) {
    const res = await fetch(BASE + 'api/' + path, {
      headers: { 'Content-Type': 'application/json', 'requesttoken': TOKEN },
      credentials: 'same-origin',
      ...opts,
    });
    if (res.status === 401) { if (rootProxy) rootProxy.authenticated = false; throw new Error('unauthorized'); }
    const ct = res.headers.get('content-type') || '';
    const body = ct.includes('json') ? await res.json() : await res.text();
    if (!res.ok) throw new Error((body && body.error) || res.statusText);
    return body;
  }

  function slug(s) {
    return (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'f_' + Math.floor(performance.now());
  }

  // input rules (per-field character/length restrictions)
  const RULE_TYPES = ['text', 'textarea', 'password', 'tel', 'email', 'url', 'number'];
  const CHARSET_RE = { digits: /^[0-9]*$/, alnum: /^[0-9A-Za-z]*$/, alpha: /^[A-Za-z]*$/, hex: /^[0-9A-Fa-f]*$/, ascii: /^[\x20-\x7E]*$/, phone: /^[0-9+\-() ]*$/ };
  const CHARSET_LABEL = { digits: 'Digits', alnum: 'Alphanumeric', alpha: 'Letters', hex: 'Hexadecimal', ascii: 'ASCII characters', phone: 'Phone number (digits, +-() )', custom: 'Specified format' };

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
const { createElementVNode: _createElementVNode, openBlock: _openBlock, createElementBlock: _createElementBlock, toDisplayString: _toDisplayString, createCommentVNode: _createCommentVNode, vModelText: _vModelText, withDirectives: _withDirectives, vModelCheckbox: _vModelCheckbox, createTextVNode: _createTextVNode, withModifiers: _withModifiers, normalizeClass: _normalizeClass, renderList: _renderList, Fragment: _Fragment, normalizeStyle: _normalizeStyle, vShow: _vShow, vModelSelect: _vModelSelect, vModelDynamic: _vModelDynamic, withKeys: _withKeys, vModelRadio: _vModelRadio } = Vue

const _hoisted_1 = {
  key: 0,
  class: "login-wrap"
}
const _hoisted_2 = { class: "login-card" }
const _hoisted_3 = /*#__PURE__*/_createElementVNode("div", { class: "logo" }, [
  /*#__PURE__*/_createElementVNode("svg", {
    xmlns: "http://www.w3.org/2000/svg",
    viewBox: "0 0 1755 2080",
    fill: "currentColor"
  }, [
    /*#__PURE__*/_createElementVNode("g", {
      transform: "translate(0.000000,2080.000000) scale(0.100000,-0.100000)",
      fill: "currentColor",
      stroke: "none"
    }, [
      /*#__PURE__*/_createElementVNode("path", { d: "M8255 19973 c-2667 -49 -4806 -500 -6235 -1315 -153 -88 -459 -294\n-580 -391 -270 -217 -526 -493 -596 -642 l-24 -50 0 -7253 c0 -6170 2 -7257\n14 -7285 34 -78 339 -330 646 -534 258 -171 469 -290 810 -457 1348 -659 3085\n-1065 5095 -1191 1582 -99 3234 -27 4615 200 1456 239 2747 664 3725 1225 423\n243 954 644 1002 757 11 27 13 1233 13 7285 l0 7253 -24 50 c-116 246 -550\n650 -997 929 -1586 990 -4164 1480 -7464 1419z m1395 -524 c1990 -69 3723\n-395 4998 -938 667 -285 1037 -527 1320 -866 167 -199 258 -376 282 -543 5\n-40 10 -1065 11 -2532 l1 -2465 -26 -100 c-81 -311 -354 -658 -772 -982 l-111\n-86 66 -45 c384 -261 666 -683 784 -1173 53 -217 62 -304 61 -589 0 -240 -3\n-278 -27 -410 -45 -250 -115 -465 -219 -674 -185 -370 -428 -622 -895 -931\n-70 -46 -88 -65 -60 -65 24 0 252 -118 342 -177 395 -260 668 -657 791 -1153\n53 -215 66 -319 71 -597 9 -433 -32 -734 -148 -1086 -236 -718 -770 -1263\n-1576 -1606 -323 -137 -942 -327 -1490 -456 -692 -162 -1551 -299 -2388 -379\n-166 -16 -1325 -79 -1332 -73 -2 2 182 147 409 322 227 175 417 321 421 325 5\n4 -154 135 -354 291 l-362 284 344 22 c941 59 1388 104 1964 194 770 120 1383\n267 1975 471 411 141 487 174 602 260 294 222 486 599 539 1058 16 140 6 393\n-20 536 -98 530 -429 879 -934 985 -81 17 -135 22 -262 21 -182 -1 -211 -6\n-636 -115 -790 -202 -1716 -350 -2679 -427 l-505 -40 -1110 0 c-1146 0 -1240\n3 -1710 45 -1183 107 -2379 350 -3577 727 l-228 71 0 615 c0 525 2 613 14 609\n55 -21 445 -141 656 -202 983 -282 2025 -476 3126 -580 415 -39 1278 -75 1814\n-75 1396 0 2762 150 4045 445 438 100 1043 269 1183 329 359 154 651 467 767\n821 139 427 76 891 -166 1215 -223 299 -541 450 -944 450 -170 0 -275 -17\n-595 -95 -1307 -317 -2608 -466 -4074 -465 l-451 1 -278 414 c-153 228 -275\n420 -272 425 3 6 23 10 43 10 20 0 73 6 117 14 171 30 318 76 670 209 347 131\n351 132 775 152 446 20 1225 88 1725 151 752 93 1477 235 2093 409 412 116\n968 317 1317 473 l110 50 3 1726 2 1727 -62 -35 c-464 -257 -1437 -566 -2348\n-745 -425 -83 -751 -132 -1455 -217 -291 -36 -350 -40 -513 -36 l-137 4 -53\n117 c-98 220 -229 436 -368 610 -75 93 -235 256 -312 316 -28 22 -51 43 -52\n46 -1 16 285 42 435 40 88 -1 207 3 265 9 58 6 246 24 419 40 884 84 1589 200\n2276 375 540 137 927 273 1275 446 316 158 444 258 513 398 29 60 32 74 32\n161 0 85 -3 101 -29 150 -40 77 -162 195 -283 274 -507 332 -1656 660 -2958\n845 -925 132 -1618 168 -3045 158 -627 -4 -677 -6 -1175 -40 -733 -52 -1047\n-82 -1460 -143 -1276 -187 -2303 -491 -2811 -830 -179 -120 -254 -198 -290\n-306 l-15 -47 -52 16 c-93 27 -250 92 -357 146 -219 111 -393 233 -604 424\nl-129 117 111 108 c356 342 891 634 1672 913 1592 568 3844 839 6270 754z\nm-8228 -2390 c606 -480 1469 -828 2783 -1123 926 -208 1965 -340 3215 -411\n580 -32 709 -48 940 -114 249 -72 571 -216 755 -338 481 -319 756 -784 847\n-1433 17 -127 17 -583 -1 -710 -71 -505 -262 -903 -596 -1235 -240 -240 -521\n-411 -861 -524 -348 -115 -642 -155 -1244 -169 l-295 -7 1188 -1745 1188\n-1745 -453 -3 c-516 -4 -1177 13 -1194 32 -6 6 -564 823 -1239 1816 -674 993\n-1232 1810 -1238 1817 -7 7 -86 21 -177 33 -543 69 -1140 171 -1675 286 -199\n43 -659 148 -699 161 -18 5 -18 -46 -11 -2313 5 -1616 4 -2316 -4 -2309 -5 6\n-317 458 -691 1005 l-682 995 6 110 c3 61 6 1891 6 4068 l0 3959 24 -19 c13\n-10 62 -48 108 -84z m2666 -6288 c436 -76 795 -141 796 -142 6 -6 506 -720\n522 -744 14 -22 14 -23 -3 -19 -10 2 -106 20 -213 39 -538 99 -1111 248 -1677\n437 l-273 91 0 244 0 245 28 -6 c15 -4 384 -69 820 -145z m-2115 -3717 l675\n-971 11 -1057 12 -1058 31 -27 c129 -110 352 -239 558 -322 349 -140 1003\n-340 1487 -454 632 -148 1063 -216 1963 -310 289 -31 593 -64 675 -75 169 -22\n319 -25 428 -9 l74 11 7 52 c3 28 6 129 6 224 0 105 4 172 9 170 6 -1 318\n-241 694 -532 l685 -530 -147 -112 c-914 -702 -1227 -941 -1231 -937 -3 3 -7\n94 -10 203 -3 109 -8 201 -11 204 -3 4 -163 15 -355 26 -536 30 -847 58 -1264\n110 -1417 181 -2817 538 -3685 943 -405 188 -683 371 -905 596 -138 140 -229\n261 -296 393 -70 140 -85 207 -90 398 -8 323 -10 4050 -3 4043 4 -4 311 -445\n682 -979z M2667 14873 c-4 -120 -7 -610 -7 -1090 l0 -872 38 -10 c781 -206\n1734 -385 2642 -495 866 -106 1990 -173 2282 -137 272 35 478 127 639 286 347\n343 385 944 84 1335 -58 75 -169 177 -238 218 -182 110 -337 145 -723 167\n-727 40 -1150 80 -1864 174 -963 128 -1453 223 -2133 416 -175 50 -622 191\n-703 222 -7 3 -13 -63 -17 -214z" })
    ])
  ])
], -1 /* HOISTED */)
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
const _hoisted_14 = /*#__PURE__*/_createElementVNode("span", { class: "logo" }, [
  /*#__PURE__*/_createElementVNode("svg", {
    xmlns: "http://www.w3.org/2000/svg",
    viewBox: "0 0 1755 2080",
    fill: "currentColor"
  }, [
    /*#__PURE__*/_createElementVNode("g", {
      transform: "translate(0.000000,2080.000000) scale(0.100000,-0.100000)",
      fill: "currentColor",
      stroke: "none"
    }, [
      /*#__PURE__*/_createElementVNode("path", { d: "M8255 19973 c-2667 -49 -4806 -500 -6235 -1315 -153 -88 -459 -294\n-580 -391 -270 -217 -526 -493 -596 -642 l-24 -50 0 -7253 c0 -6170 2 -7257\n14 -7285 34 -78 339 -330 646 -534 258 -171 469 -290 810 -457 1348 -659 3085\n-1065 5095 -1191 1582 -99 3234 -27 4615 200 1456 239 2747 664 3725 1225 423\n243 954 644 1002 757 11 27 13 1233 13 7285 l0 7253 -24 50 c-116 246 -550\n650 -997 929 -1586 990 -4164 1480 -7464 1419z m1395 -524 c1990 -69 3723\n-395 4998 -938 667 -285 1037 -527 1320 -866 167 -199 258 -376 282 -543 5\n-40 10 -1065 11 -2532 l1 -2465 -26 -100 c-81 -311 -354 -658 -772 -982 l-111\n-86 66 -45 c384 -261 666 -683 784 -1173 53 -217 62 -304 61 -589 0 -240 -3\n-278 -27 -410 -45 -250 -115 -465 -219 -674 -185 -370 -428 -622 -895 -931\n-70 -46 -88 -65 -60 -65 24 0 252 -118 342 -177 395 -260 668 -657 791 -1153\n53 -215 66 -319 71 -597 9 -433 -32 -734 -148 -1086 -236 -718 -770 -1263\n-1576 -1606 -323 -137 -942 -327 -1490 -456 -692 -162 -1551 -299 -2388 -379\n-166 -16 -1325 -79 -1332 -73 -2 2 182 147 409 322 227 175 417 321 421 325 5\n4 -154 135 -354 291 l-362 284 344 22 c941 59 1388 104 1964 194 770 120 1383\n267 1975 471 411 141 487 174 602 260 294 222 486 599 539 1058 16 140 6 393\n-20 536 -98 530 -429 879 -934 985 -81 17 -135 22 -262 21 -182 -1 -211 -6\n-636 -115 -790 -202 -1716 -350 -2679 -427 l-505 -40 -1110 0 c-1146 0 -1240\n3 -1710 45 -1183 107 -2379 350 -3577 727 l-228 71 0 615 c0 525 2 613 14 609\n55 -21 445 -141 656 -202 983 -282 2025 -476 3126 -580 415 -39 1278 -75 1814\n-75 1396 0 2762 150 4045 445 438 100 1043 269 1183 329 359 154 651 467 767\n821 139 427 76 891 -166 1215 -223 299 -541 450 -944 450 -170 0 -275 -17\n-595 -95 -1307 -317 -2608 -466 -4074 -465 l-451 1 -278 414 c-153 228 -275\n420 -272 425 3 6 23 10 43 10 20 0 73 6 117 14 171 30 318 76 670 209 347 131\n351 132 775 152 446 20 1225 88 1725 151 752 93 1477 235 2093 409 412 116\n968 317 1317 473 l110 50 3 1726 2 1727 -62 -35 c-464 -257 -1437 -566 -2348\n-745 -425 -83 -751 -132 -1455 -217 -291 -36 -350 -40 -513 -36 l-137 4 -53\n117 c-98 220 -229 436 -368 610 -75 93 -235 256 -312 316 -28 22 -51 43 -52\n46 -1 16 285 42 435 40 88 -1 207 3 265 9 58 6 246 24 419 40 884 84 1589 200\n2276 375 540 137 927 273 1275 446 316 158 444 258 513 398 29 60 32 74 32\n161 0 85 -3 101 -29 150 -40 77 -162 195 -283 274 -507 332 -1656 660 -2958\n845 -925 132 -1618 168 -3045 158 -627 -4 -677 -6 -1175 -40 -733 -52 -1047\n-82 -1460 -143 -1276 -187 -2303 -491 -2811 -830 -179 -120 -254 -198 -290\n-306 l-15 -47 -52 16 c-93 27 -250 92 -357 146 -219 111 -393 233 -604 424\nl-129 117 111 108 c356 342 891 634 1672 913 1592 568 3844 839 6270 754z\nm-8228 -2390 c606 -480 1469 -828 2783 -1123 926 -208 1965 -340 3215 -411\n580 -32 709 -48 940 -114 249 -72 571 -216 755 -338 481 -319 756 -784 847\n-1433 17 -127 17 -583 -1 -710 -71 -505 -262 -903 -596 -1235 -240 -240 -521\n-411 -861 -524 -348 -115 -642 -155 -1244 -169 l-295 -7 1188 -1745 1188\n-1745 -453 -3 c-516 -4 -1177 13 -1194 32 -6 6 -564 823 -1239 1816 -674 993\n-1232 1810 -1238 1817 -7 7 -86 21 -177 33 -543 69 -1140 171 -1675 286 -199\n43 -659 148 -699 161 -18 5 -18 -46 -11 -2313 5 -1616 4 -2316 -4 -2309 -5 6\n-317 458 -691 1005 l-682 995 6 110 c3 61 6 1891 6 4068 l0 3959 24 -19 c13\n-10 62 -48 108 -84z m2666 -6288 c436 -76 795 -141 796 -142 6 -6 506 -720\n522 -744 14 -22 14 -23 -3 -19 -10 2 -106 20 -213 39 -538 99 -1111 248 -1677\n437 l-273 91 0 244 0 245 28 -6 c15 -4 384 -69 820 -145z m-2115 -3717 l675\n-971 11 -1057 12 -1058 31 -27 c129 -110 352 -239 558 -322 349 -140 1003\n-340 1487 -454 632 -148 1063 -216 1963 -310 289 -31 593 -64 675 -75 169 -22\n319 -25 428 -9 l74 11 7 52 c3 28 6 129 6 224 0 105 4 172 9 170 6 -1 318\n-241 694 -532 l685 -530 -147 -112 c-914 -702 -1227 -941 -1231 -937 -3 3 -7\n94 -10 203 -3 109 -8 201 -11 204 -3 4 -163 15 -355 26 -536 30 -847 58 -1264\n110 -1417 181 -2817 538 -3685 943 -405 188 -683 371 -905 596 -138 140 -229\n261 -296 393 -70 140 -85 207 -90 398 -8 323 -10 4050 -3 4043 4 -4 311 -445\n682 -979z M2667 14873 c-4 -120 -7 -610 -7 -1090 l0 -872 38 -10 c781 -206\n1734 -385 2642 -495 866 -106 1990 -173 2282 -137 272 35 478 127 639 286 347\n343 385 944 84 1335 -58 75 -169 177 -238 218 -182 110 -337 145 -723 167\n-727 40 -1150 80 -1864 174 -963 128 -1453 223 -2133 416 -175 50 -622 191\n-703 222 -7 3 -13 -63 -17 -214z" })
    ])
  ])
], -1 /* HOISTED */)
const _hoisted_15 = /*#__PURE__*/_createElementVNode("span", null, "RegiBase", -1 /* HOISTED */)
const _hoisted_16 = {
  key: 0,
  class: "tag"
}
const _hoisted_17 = { class: "coll-list" }
const _hoisted_18 = ["draggable", "onClick", "onDragstart", "onDragover", "onDragleave", "onDrop", "onMouseenter", "onFocus"]
const _hoisted_19 = ["title"]
const _hoisted_20 = { class: "ic" }
const _hoisted_21 = { class: "nm" }
const _hoisted_22 = { class: "ct" }
const _hoisted_23 = {
  key: 0,
  class: "empty",
  style: {"padding":"24px 8px"}
}
const _hoisted_24 = { class: "coll-tip-name" }
const _hoisted_25 = { class: "coll-tip-desc" }
const _hoisted_26 = { class: "sidebar-foot" }
const _hoisted_27 = ["title"]
const _hoisted_28 = { class: "main" }
const _hoisted_29 = { class: "topbar" }
const _hoisted_30 = {
  key: 0,
  class: "title"
}
const _hoisted_31 = ["title"]
const _hoisted_32 = { class: "ic" }
const _hoisted_33 = { class: "nm" }
const _hoisted_34 = {
  key: 1,
  class: "title"
}
const _hoisted_35 = { class: "nm" }
const _hoisted_36 = /*#__PURE__*/_createElementVNode("div", { class: "spacer" }, null, -1 /* HOISTED */)
const _hoisted_37 = {
  key: 2,
  class: "topbar-actions"
}
const _hoisted_38 = { class: "viewswitch" }
const _hoisted_39 = ["title", "onClick", "innerHTML"]
const _hoisted_40 = ["title"]
const _hoisted_41 = ["title"]
const _hoisted_42 = /*#__PURE__*/_createElementVNode("div", {
  class: "ta-break",
  "aria-hidden": "true"
}, null, -1 /* HOISTED */)
const _hoisted_43 = {
  key: 0,
  class: "home"
}
const _hoisted_44 = {
  key: 0,
  class: "home-grid"
}
const _hoisted_45 = ["onClick"]
const _hoisted_46 = ["title"]
const _hoisted_47 = { class: "hc-body" }
const _hoisted_48 = { class: "hc-name" }
const _hoisted_49 = { class: "hc-desc" }
const _hoisted_50 = { class: "hc-count" }
const _hoisted_51 = {
  key: 1,
  class: "empty"
}
const _hoisted_52 = /*#__PURE__*/_createElementVNode("div", { class: "big" }, "🗂️", -1 /* HOISTED */)
const _hoisted_53 = /*#__PURE__*/_createElementVNode("br", null, null, -1 /* HOISTED */)
const _hoisted_54 = { class: "listtoolbar" }
const _hoisted_55 = { class: "lt-top" }
const _hoisted_56 = ["title"]
const _hoisted_57 = { class: "lt-collname" }
const _hoisted_58 = ["title"]
const _hoisted_59 = { class: "ic" }
const _hoisted_60 = {
  key: 0,
  class: "lt-count"
}
const _hoisted_61 = { class: "lt-tools" }
const _hoisted_62 = { class: "lt-search" }
const _hoisted_63 = ["placeholder"]
const _hoisted_64 = ["title"]
const _hoisted_65 = { class: "sortgroup-lbl" }
const _hoisted_66 = ["value", "title"]
const _hoisted_67 = { value: "created_asc" }
const _hoisted_68 = { value: "created_desc" }
const _hoisted_69 = { value: "title_asc" }
const _hoisted_70 = { value: "title_desc" }
const _hoisted_71 = ["title"]
const _hoisted_72 = { class: "lt-actions" }
const _hoisted_73 = { class: "selcount" }
const _hoisted_74 = ["disabled"]
const _hoisted_75 = ["disabled"]
const _hoisted_76 = /*#__PURE__*/_createElementVNode("span", { class: "selspacer" }, null, -1 /* HOISTED */)
const _hoisted_77 = ["disabled", "title"]
const _hoisted_78 = ["disabled"]
const _hoisted_79 = ["disabled"]
const _hoisted_80 = ["disabled"]
const _hoisted_81 = {
  key: 0,
  class: "empty"
}
const _hoisted_82 = { class: "big" }
const _hoisted_83 = { key: 0 }
const _hoisted_84 = {
  key: 0,
  class: "rec-grid"
}
const _hoisted_85 = ["checked", "onChange"]
const _hoisted_86 = ["onClick", "title"]
const _hoisted_87 = ["onClick"]
const _hoisted_88 = { class: "rt" }
const _hoisted_89 = { class: "rl" }
const _hoisted_90 = { class: "rec-list" }
const _hoisted_91 = ["checked", "onChange"]
const _hoisted_92 = ["onClick"]
const _hoisted_93 = { class: "rr-title" }
const _hoisted_94 = { class: "rr-sub" }
const _hoisted_95 = /*#__PURE__*/_createElementVNode("span", { class: "rr-chev" }, "›", -1 /* HOISTED */)
const _hoisted_96 = ["onClick", "title"]
const _hoisted_97 = { class: "rec-dlist" }
const _hoisted_98 = ["checked", "onChange"]
const _hoisted_99 = ["onClick"]
const _hoisted_100 = { class: "rr-title" }
const _hoisted_101 = { class: "rr-fields" }
const _hoisted_102 = ["onClick", "title"]
const _hoisted_103 = { class: "rec-table" }
const _hoisted_104 = { class: "rt-frozen" }
const _hoisted_105 = { class: "rt-fhead" }
const _hoisted_106 = ["checked"]
const _hoisted_107 = { key: 0 }
const _hoisted_108 = /*#__PURE__*/_createElementVNode("th", { class: "rt-actions" }, null, -1 /* HOISTED */)
const _hoisted_109 = { class: "rt-frozen" }
const _hoisted_110 = ["checked", "onChange"]
const _hoisted_111 = ["onClick", "title"]
const _hoisted_112 = ["src"]
const _hoisted_113 = ["src"]
const _hoisted_114 = { key: 1 }
const _hoisted_115 = ["onClick", "title"]
const _hoisted_116 = { class: "rec-imggrid" }
const _hoisted_117 = ["checked", "onChange"]
const _hoisted_118 = ["onClick", "title"]
const _hoisted_119 = ["onClick"]
const _hoisted_120 = { class: "thumb" }
const _hoisted_121 = ["src"]
const _hoisted_122 = {
  key: 1,
  class: "noimg"
}
const _hoisted_123 = { class: "rr-title" }
const _hoisted_124 = { class: "rr-sub" }
const _hoisted_125 = {
  key: 0,
  class: "scrollnav"
}
const _hoisted_126 = ["title"]
const _hoisted_127 = ["title"]
const _hoisted_128 = { class: "modal wide" }
const _hoisted_129 = { class: "modal-head" }
const _hoisted_130 = { class: "modal-body" }
const _hoisted_131 = ["disabled", "title"]
const _hoisted_132 = ["disabled", "title"]
const _hoisted_133 = { style: {"font-size":"12px","color":"var(--muted)","margin-bottom":"8px"} }
const _hoisted_134 = {
  key: 0,
  class: "empty"
}
const _hoisted_135 = {
  key: 1,
  class: "tpl-grid"
}
const _hoisted_136 = ["disabled", "onClick"]
const _hoisted_137 = { class: "th" }
const _hoisted_138 = { class: "ic" }
const _hoisted_139 = { class: "tpl-name" }
const _hoisted_140 = {
  key: 0,
  class: "tpl-tag"
}
const _hoisted_141 = {
  key: 1,
  class: "tpl-tag edited"
}
const _hoisted_142 = { class: "td" }
const _hoisted_143 = { class: "tpl-actions" }
const _hoisted_144 = ["title", "onClick"]
const _hoisted_145 = ["title", "onClick"]
const _hoisted_146 = ["title", "onClick"]
const _hoisted_147 = { class: "modal-foot" }
const _hoisted_148 = { class: "modal-head" }
const _hoisted_149 = { class: "modal-body" }
const _hoisted_150 = {
  key: 0,
  class: "req"
}
const _hoisted_151 = {
  key: 1,
  class: "chip"
}
const _hoisted_152 = ["onUpdate:modelValue", "placeholder", "maxlength"]
const _hoisted_153 = ["onUpdate:modelValue"]
const _hoisted_154 = { value: "" }
const _hoisted_155 = ["value"]
const _hoisted_156 = {
  key: 2,
  class: "imgfield"
}
const _hoisted_157 = ["onDragenter", "onDragleave", "onDrop"]
const _hoisted_158 = ["src"]
const _hoisted_159 = {
  key: 1,
  class: "dropzone-hint"
}
const _hoisted_160 = /*#__PURE__*/_createElementVNode("span", { class: "dz-ic" }, "🖼", -1 /* HOISTED */)
const _hoisted_161 = /*#__PURE__*/_createElementVNode("br", null, null, -1 /* HOISTED */)
const _hoisted_162 = { class: "imgactions" }
const _hoisted_163 = ["onClick"]
const _hoisted_164 = { class: "btn sm" }
const _hoisted_165 = ["onChange"]
const _hoisted_166 = ["onClick"]
const _hoisted_167 = ["onClick"]
const _hoisted_168 = {
  key: 3,
  class: "filefield"
}
const _hoisted_169 = {
  key: 0,
  class: "fileattach"
}
const _hoisted_170 = { class: "fa-ic" }
const _hoisted_171 = { class: "fa-name" }
const _hoisted_172 = ["onClick"]
const _hoisted_173 = ["onClick", "title"]
const _hoisted_174 = ["onClick"]
const _hoisted_175 = ["onDragenter", "onDragleave", "onDrop"]
const _hoisted_176 = { class: "dropzone-hint" }
const _hoisted_177 = /*#__PURE__*/_createElementVNode("span", { class: "dz-ic" }, "📎", -1 /* HOISTED */)
const _hoisted_178 = /*#__PURE__*/_createElementVNode("br", null, null, -1 /* HOISTED */)
const _hoisted_179 = { class: "imgactions" }
const _hoisted_180 = ["onClick"]
const _hoisted_181 = { class: "btn sm" }
const _hoisted_182 = ["onChange"]
const _hoisted_183 = ["onClick"]
const _hoisted_184 = {
  key: 4,
  class: "control"
}
const _hoisted_185 = ["type", "onUpdate:modelValue", "placeholder", "readonly", "autocomplete", "maxlength"]
const _hoisted_186 = ["onClick"]
const _hoisted_187 = {
  key: 5,
  class: "rule-hint"
}
const _hoisted_188 = { class: "modal-foot" }
const _hoisted_189 = {
  type: "submit",
  class: "btn primary"
}
const _hoisted_190 = { class: "modal" }
const _hoisted_191 = { class: "modal-head" }
const _hoisted_192 = { class: "modal-body" }
const _hoisted_193 = { class: "dk" }
const _hoisted_194 = {
  key: 0,
  class: "dv"
}
const _hoisted_195 = ["src"]
const _hoisted_196 = {
  key: 1,
  class: "dv"
}
const _hoisted_197 = { class: "fa-ic" }
const _hoisted_198 = { class: "val" }
const _hoisted_199 = ["onClick"]
const _hoisted_200 = ["onClick", "title"]
const _hoisted_201 = {
  key: 2,
  class: "dv"
}
const _hoisted_202 = ["href"]
const _hoisted_203 = ["onClick"]
const _hoisted_204 = ["onClick", "title"]
const _hoisted_205 = { class: "modal-foot" }
const _hoisted_206 = { class: "modal wide" }
const _hoisted_207 = { class: "modal-head" }
const _hoisted_208 = { class: "modal-body" }
const _hoisted_209 = {
  key: 0,
  class: "tpl-meta"
}
const _hoisted_210 = { class: "field-row" }
const _hoisted_211 = { class: "field" }
const _hoisted_212 = {
  class: "field",
  style: {"max-width":"120px"}
}
const _hoisted_213 = { class: "field-row" }
const _hoisted_214 = {
  class: "field",
  style: {"max-width":"140px"}
}
const _hoisted_215 = ["placeholder"]
const _hoisted_216 = { class: "field" }
const _hoisted_217 = { style: {"color":"var(--muted)","font-size":"13px","margin-top":"0"} }
const _hoisted_218 = ["onDragover", "onDrop", "onDragleave"]
const _hoisted_219 = ["onDragstart", "title"]
const _hoisted_220 = ["onUpdate:modelValue", "placeholder"]
const _hoisted_221 = ["onUpdate:modelValue"]
const _hoisted_222 = { value: "text" }
const _hoisted_223 = { value: "textarea" }
const _hoisted_224 = { value: "password" }
const _hoisted_225 = { value: "number" }
const _hoisted_226 = { value: "date" }
const _hoisted_227 = { value: "month" }
const _hoisted_228 = { value: "email" }
const _hoisted_229 = /*#__PURE__*/_createElementVNode("option", { value: "url" }, "URL", -1 /* HOISTED */)
const _hoisted_230 = { value: "tel" }
const _hoisted_231 = { value: "select" }
const _hoisted_232 = { value: "image" }
const _hoisted_233 = { value: "image_crop" }
const _hoisted_234 = { value: "file" }
const _hoisted_235 = { style: {"display":"flex","gap":"4px","justify-content":"flex-end"} }
const _hoisted_236 = ["onClick", "title"]
const _hoisted_237 = ["onUpdate:modelValue", "placeholder"]
const _hoisted_238 = {
  key: 1,
  class: "imgcfg"
}
const _hoisted_239 = { class: "cfg" }
const _hoisted_240 = ["onUpdate:modelValue"]
const _hoisted_241 = {
  key: 0,
  class: "cfg"
}
const _hoisted_242 = ["onUpdate:modelValue"]
const _hoisted_243 = {
  key: 1,
  class: "cfg"
}
const _hoisted_244 = ["onUpdate:modelValue"]
const _hoisted_245 = { value: "jpeg" }
const _hoisted_246 = { value: "png" }
const _hoisted_247 = { value: "webp" }
const _hoisted_248 = {
  key: 2,
  class: "imgcfg"
}
const _hoisted_249 = { class: "cfg" }
const _hoisted_250 = ["onUpdate:modelValue"]
const _hoisted_251 = { value: "1:1" }
const _hoisted_252 = { value: "3:4" }
const _hoisted_253 = { value: "4:3" }
const _hoisted_254 = { value: "16:9" }
const _hoisted_255 = { value: "free" }
const _hoisted_256 = { class: "cfg" }
const _hoisted_257 = ["onUpdate:modelValue"]
const _hoisted_258 = { class: "cfg" }
const _hoisted_259 = ["onUpdate:modelValue"]
const _hoisted_260 = { value: "jpeg" }
const _hoisted_261 = { value: "png" }
const _hoisted_262 = { value: "webp" }
const _hoisted_263 = {
  key: 3,
  class: "imgcfg"
}
const _hoisted_264 = { class: "cfg" }
const _hoisted_265 = ["onUpdate:modelValue"]
const _hoisted_266 = { value: "none" }
const _hoisted_267 = { value: "digits" }
const _hoisted_268 = { value: "alnum" }
const _hoisted_269 = { value: "alpha" }
const _hoisted_270 = { value: "hex" }
const _hoisted_271 = { value: "ascii" }
const _hoisted_272 = { value: "phone" }
const _hoisted_273 = { value: "custom" }
const _hoisted_274 = {
  key: 0,
  class: "cfg"
}
const _hoisted_275 = ["onUpdate:modelValue", "placeholder"]
const _hoisted_276 = { class: "cfg" }
const _hoisted_277 = ["onUpdate:modelValue"]
const _hoisted_278 = { class: "cfg" }
const _hoisted_279 = ["onUpdate:modelValue"]
const _hoisted_280 = { class: "flags" }
const _hoisted_281 = ["checked", "onChange"]
const _hoisted_282 = ["onUpdate:modelValue"]
const _hoisted_283 = ["onUpdate:modelValue"]
const _hoisted_284 = { class: "modal-foot" }
const _hoisted_285 = { class: "modal sm" }
const _hoisted_286 = { class: "modal-head" }
const _hoisted_287 = { class: "modal-body" }
const _hoisted_288 = { class: "field" }
const _hoisted_289 = { class: "dup-check" }
const _hoisted_290 = { style: {"font-size":"12px","color":"var(--muted)","margin-top":"6px"} }
const _hoisted_291 = { class: "modal-foot" }
const _hoisted_292 = ["disabled"]
const _hoisted_293 = { class: "modal wide" }
const _hoisted_294 = { class: "modal-head" }
const _hoisted_295 = { class: "modal-body" }
const _hoisted_296 = { style: {"color":"var(--muted)","font-size":"13px","margin-top":"0"} }
const _hoisted_297 = {
  key: 0,
  class: "reorder-byfield"
}
const _hoisted_298 = { class: "reorder-byfield-head" }
const _hoisted_299 = { class: "reorder-keynum" }
const _hoisted_300 = ["onUpdate:modelValue"]
const _hoisted_301 = { value: "" }
const _hoisted_302 = ["value"]
const _hoisted_303 = ["onUpdate:modelValue"]
const _hoisted_304 = { value: "asc" }
const _hoisted_305 = { value: "desc" }
const _hoisted_306 = ["onClick", "title"]
const _hoisted_307 = { class: "reorder-byfield-actions" }
const _hoisted_308 = ["disabled"]
const _hoisted_309 = { class: "reorder-listhead" }
const _hoisted_310 = { class: "reorder-list" }
const _hoisted_311 = ["onDragover", "onDrop", "onDragleave"]
const _hoisted_312 = ["onDragstart", "title"]
const _hoisted_313 = { class: "reorder-num" }
const _hoisted_314 = { class: "reorder-cell" }
const _hoisted_315 = { class: "reorder-title" }
const _hoisted_316 = {
  key: 0,
  class: "reorder-sub"
}
const _hoisted_317 = { class: "modal-foot" }
const _hoisted_318 = ["disabled"]
const _hoisted_319 = { class: "modal" }
const _hoisted_320 = { class: "modal-head" }
const _hoisted_321 = { class: "modal-body settings-body" }
const _hoisted_322 = {
  key: 0,
  class: "share-note"
}
const _hoisted_323 = { class: "field" }
const _hoisted_324 = { class: "field" }
const _hoisted_325 = ["placeholder"]
const _hoisted_326 = { class: "field-row" }
const _hoisted_327 = { class: "field" }
const _hoisted_328 = { class: "field" }
const _hoisted_329 = { class: "iconpick-head" }
const _hoisted_330 = ["title"]
const _hoisted_331 = ["placeholder"]
const _hoisted_332 = { class: "emoji-palette" }
const _hoisted_333 = { class: "emoji-cat" }
const _hoisted_334 = { class: "emoji-grid" }
const _hoisted_335 = ["onClick", "title"]
const _hoisted_336 = ["aria-expanded"]
const _hoisted_337 = { class: "share-toggle-label" }
const _hoisted_338 = { class: "share-hint" }
const _hoisted_339 = { class: "share-caret" }
const _hoisted_340 = {
  key: 0,
  class: "share-hint-text"
}
const _hoisted_341 = {
  key: 0,
  class: "share-count"
}
const _hoisted_342 = { class: "share-body" }
const _hoisted_343 = {
  key: 0,
  class: "share-list"
}
const _hoisted_344 = { class: "share-user" }
const _hoisted_345 = ["value", "onChange"]
const _hoisted_346 = { value: "view" }
const _hoisted_347 = { value: "edit" }
const _hoisted_348 = { value: "delete" }
const _hoisted_349 = ["title"]
const _hoisted_350 = ["title"]
const _hoisted_351 = ["onClick", "title"]
const _hoisted_352 = { class: "share-add" }
const _hoisted_353 = { class: "share-top" }
const _hoisted_354 = {
  key: 0,
  class: "share-search"
}
const _hoisted_355 = ["placeholder"]
const _hoisted_356 = {
  key: 0,
  class: "share-results"
}
const _hoisted_357 = ["onClick"]
const _hoisted_358 = { class: "muted" }
const _hoisted_359 = {
  key: 1,
  class: "share-picked"
}
const _hoisted_360 = { class: "share-user" }
const _hoisted_361 = { class: "muted" }
const _hoisted_362 = ["title"]
const _hoisted_363 = { class: "perm-label" }
const _hoisted_364 = /*#__PURE__*/_createElementVNode("span", {
  class: "perm-arrow",
  "aria-hidden": "true"
}, "⌄", -1 /* HOISTED */)
const _hoisted_365 = ["onClick"]
const _hoisted_366 = { class: "share-opts" }
const _hoisted_367 = { class: "so-row" }
const _hoisted_368 = { class: "sub" }
const _hoisted_369 = ["placeholder"]
const _hoisted_370 = {
  key: 0,
  class: "so-row so-secret"
}
const _hoisted_371 = { class: "sub" }
const _hoisted_372 = ["placeholder"]
const _hoisted_373 = { class: "muted so-hint" }
const _hoisted_374 = {
  key: 0,
  class: "share-err"
}
const _hoisted_375 = ["disabled"]
const _hoisted_376 = {
  key: 3,
  class: "field"
}
const _hoisted_377 = { style: {"display":"flex","gap":"8px","flex-wrap":"wrap"} }
const _hoisted_378 = { style: {"font-size":"12px","color":"var(--muted)","margin-top":"4px"} }
const _hoisted_379 = { class: "field" }
const _hoisted_380 = { style: {"display":"flex","gap":"8px","flex-wrap":"wrap"} }
const _hoisted_381 = ["disabled", "title"]
const _hoisted_382 = { style: {"font-size":"12px","color":"var(--muted)","margin-top":"4px"} }
const _hoisted_383 = { style: {"font-size":"12px","color":"var(--muted)","margin-top":"2px"} }
const _hoisted_384 = { class: "modal-foot" }
const _hoisted_385 = { class: "modal sm" }
const _hoisted_386 = { class: "modal-head" }
const _hoisted_387 = { class: "modal-body" }
const _hoisted_388 = { style: {"margin-top":"0","color":"var(--muted)"} }
const _hoisted_389 = { class: "field" }
const _hoisted_390 = {
  key: 0,
  class: "share-err"
}
const _hoisted_391 = { class: "modal-foot" }
const _hoisted_392 = ["disabled"]
const _hoisted_393 = { class: "modal wide" }
const _hoisted_394 = { class: "modal-head" }
const _hoisted_395 = { class: "modal-body" }
const _hoisted_396 = { style: {"margin-top":"0","color":"var(--muted)","font-size":"13px"} }
const _hoisted_397 = /*#__PURE__*/_createElementVNode("br", null, null, -1 /* HOISTED */)
const _hoisted_398 = { class: "filepick" }
const _hoisted_399 = { class: "btn sm" }
const _hoisted_400 = { class: "filepick-name" }
const _hoisted_401 = { style: {"margin":"12px 0 6px","color":"var(--muted)","font-size":"12px"} }
const _hoisted_402 = ["placeholder"]
const _hoisted_403 = { style: {"margin-bottom":"10px"} }
const _hoisted_404 = { class: "chip" }
const _hoisted_405 = { class: "chip" }
const _hoisted_406 = { class: "field" }
const _hoisted_407 = { class: "field" }
const _hoisted_408 = { style: {"color":"var(--muted)","font-size":"12px","margin":"4px 0 8px"} }
const _hoisted_409 = ["onUpdate:modelValue", "placeholder"]
const _hoisted_410 = ["onUpdate:modelValue"]
const _hoisted_411 = { value: "text" }
const _hoisted_412 = { value: "textarea" }
const _hoisted_413 = { value: "password" }
const _hoisted_414 = /*#__PURE__*/_createElementVNode("option", { value: "url" }, "URL", -1 /* HOISTED */)
const _hoisted_415 = { value: "email" }
const _hoisted_416 = { value: "tel" }
const _hoisted_417 = { value: "date" }
const _hoisted_418 = { value: "number" }
const _hoisted_419 = { value: "image" }
const _hoisted_420 = ["title"]
const _hoisted_421 = { class: "flags" }
const _hoisted_422 = ["checked", "onChange"]
const _hoisted_423 = ["onUpdate:modelValue"]
const _hoisted_424 = { class: "modal-foot" }
const _hoisted_425 = ["disabled"]
const _hoisted_426 = { class: "modal" }
const _hoisted_427 = { class: "modal-head" }
const _hoisted_428 = ["disabled"]
const _hoisted_429 = { class: "modal-body" }
const _hoisted_430 = {
  key: 0,
  class: "empty"
}
const _hoisted_431 = {
  key: 1,
  class: "empty"
}
const _hoisted_432 = { style: {"margin-top":"0","font-size":"13px","color":"var(--muted)"} }
const _hoisted_433 = { class: "field" }
const _hoisted_434 = { value: "all" }
const _hoisted_435 = ["value"]
const _hoisted_436 = { class: "field" }
const _hoisted_437 = ["placeholder"]
const _hoisted_438 = {
  key: 0,
  style: {"color":"var(--danger)","font-size":"13px"}
}
const _hoisted_439 = { class: "modal-foot" }
const _hoisted_440 = ["disabled"]
const _hoisted_441 = ["disabled"]
const _hoisted_442 = { class: "modal" }
const _hoisted_443 = { class: "modal-head" }
const _hoisted_444 = ["disabled"]
const _hoisted_445 = { class: "modal-body" }
const _hoisted_446 = {
  key: 0,
  class: "empty"
}
const _hoisted_447 = {
  key: 1,
  class: "empty"
}
const _hoisted_448 = {
  key: 2,
  class: "empty"
}
const _hoisted_449 = { style: {"margin-top":"0","font-size":"13px","color":"var(--muted)"} }
const _hoisted_450 = { class: "field" }
const _hoisted_451 = ["value"]
const _hoisted_452 = { class: "field" }
const _hoisted_453 = ["placeholder"]
const _hoisted_454 = {
  key: 0,
  style: {"color":"var(--danger)","font-size":"13px"}
}
const _hoisted_455 = { class: "modal-foot" }
const _hoisted_456 = ["disabled"]
const _hoisted_457 = ["disabled"]
const _hoisted_458 = { class: "modal wide" }
const _hoisted_459 = { class: "modal-head" }
const _hoisted_460 = { class: "modal-body" }
const _hoisted_461 = { class: "field" }
const _hoisted_462 = { style: {"font-size":"14px","color":"var(--muted)"} }
const _hoisted_463 = { class: "field" }
const _hoisted_464 = { class: "radios" }
const _hoisted_465 = { class: "field" }
const _hoisted_466 = ["value"]
const _hoisted_467 = { value: "" }
const _hoisted_468 = { value: "__newcoll__" }
const _hoisted_469 = ["value"]
const _hoisted_470 = {
  key: 0,
  class: "field"
}
const _hoisted_471 = ["placeholder"]
const _hoisted_472 = { style: {"font-size":"12px","color":"var(--muted)","margin-top":"4px"} }
const _hoisted_473 = { style: {"color":"var(--muted)","font-size":"12px","margin":"6px 0 8px"} }
const _hoisted_474 = ["title"]
const _hoisted_475 = { class: "ms-label" }
const _hoisted_476 = {
  key: 0,
  class: "ms-sample"
}
const _hoisted_477 = {
  key: 1,
  class: "ms-empty"
}
const _hoisted_478 = /*#__PURE__*/_createElementVNode("span", { class: "map-arrow" }, "→", -1 /* HOISTED */)
const _hoisted_479 = ["onUpdate:modelValue"]
const _hoisted_480 = { value: "" }
const _hoisted_481 = ["value"]
const _hoisted_482 = { value: "__new__" }
const _hoisted_483 = {
  class: "field",
  style: {"margin-top":"12px"}
}
const _hoisted_484 = { value: "" }
const _hoisted_485 = ["value"]
const _hoisted_486 = { class: "modal-foot" }
const _hoisted_487 = ["disabled"]
const _hoisted_488 = { class: "modal" }
const _hoisted_489 = { class: "modal-head" }
const _hoisted_490 = { class: "modal-body settings-body" }
const _hoisted_491 = { class: "field" }
const _hoisted_492 = { class: "radios" }
const _hoisted_493 = {
  class: "field",
  style: {"margin-top":"16px"}
}
const _hoisted_494 = { value: "auto" }
const _hoisted_495 = ["value"]
const _hoisted_496 = { style: {"font-size":"12px","color":"var(--muted)","margin-top":"4px"} }
const _hoisted_497 = {
  class: "field",
  style: {"margin-top":"16px"}
}
const _hoisted_498 = { style: {"font-size":"12px","color":"var(--muted)","margin-top":"4px"} }
const _hoisted_499 = /*#__PURE__*/_createElementVNode("br", null, null, -1 /* HOISTED */)
const _hoisted_500 = {
  class: "field",
  style: {"margin-top":"16px","border-top":"1px solid var(--border)","padding-top":"14px"}
}
const _hoisted_501 = {
  key: 0,
  style: {"font-size":"13px","color":"var(--muted)"}
}
const _hoisted_502 = { style: {"color":"var(--accent)"} }
const _hoisted_503 = { key: 0 }
const _hoisted_504 = { style: {"margin-top":"8px","display":"flex","gap":"8px","flex-wrap":"wrap"} }
const _hoisted_505 = {
  key: 1,
  style: {"font-size":"13px","color":"var(--muted)"}
}
const _hoisted_506 = { style: {"margin-top":"8px"} }
const _hoisted_507 = {
  class: "field",
  style: {"margin-top":"16px","border-top":"1px solid var(--border)","padding-top":"14px"}
}
const _hoisted_508 = { style: {"font-size":"12px","color":"var(--muted)","margin-bottom":"8px"} }
const _hoisted_509 = { style: {"display":"flex","gap":"8px","flex-wrap":"wrap"} }
const _hoisted_510 = { class: "modal-foot" }
const _hoisted_511 = { class: "modal" }
const _hoisted_512 = { class: "modal-head" }
const _hoisted_513 = ["disabled"]
const _hoisted_514 = { style: {"margin-top":"0","font-size":"13px","color":"var(--muted)"} }
const _hoisted_515 = { class: "field" }
const _hoisted_516 = {
  key: 0,
  style: {"color":"var(--danger)","font-size":"13px"}
}
const _hoisted_517 = {
  key: 1,
  style: {"font-size":"13px","color":"var(--muted)"}
}
const _hoisted_518 = { class: "modal-foot" }
const _hoisted_519 = ["disabled"]
const _hoisted_520 = ["disabled"]
const _hoisted_521 = { class: "modal" }
const _hoisted_522 = { class: "modal-head" }
const _hoisted_523 = ["disabled"]
const _hoisted_524 = { class: "modal-body" }
const _hoisted_525 = { class: "filepick" }
const _hoisted_526 = { class: "btn sm" }
const _hoisted_527 = { class: "filepick-name" }
const _hoisted_528 = {
  class: "field",
  style: {"margin-top":"12px"}
}
const _hoisted_529 = { class: "field" }
const _hoisted_530 = { class: "radios" }
const _hoisted_531 = { style: {"color":"var(--danger)","font-size":"13px","background":"color-mix(in srgb,var(--danger) 12%,transparent)","padding":"8px 10px","border-radius":"8px"} }
const _hoisted_532 = { class: "confirm-check" }
const _hoisted_533 = {
  key: 1,
  style: {"color":"var(--danger)","font-size":"13px","margin-top":"8px"}
}
const _hoisted_534 = {
  key: 2,
  style: {"font-size":"13px","color":"var(--muted)","margin-top":"8px"}
}
const _hoisted_535 = { class: "modal-foot" }
const _hoisted_536 = ["disabled"]
const _hoisted_537 = ["disabled"]
const _hoisted_538 = { class: "modal" }
const _hoisted_539 = { class: "modal-head" }
const _hoisted_540 = ["disabled"]
const _hoisted_541 = { class: "modal-body" }
const _hoisted_542 = { style: {"margin-top":"0","font-size":"13px"} }
const _hoisted_543 = { style: {"color":"var(--danger)","font-size":"13px","background":"color-mix(in srgb,var(--danger) 12%,transparent)","padding":"8px 10px","border-radius":"8px"} }
const _hoisted_544 = { class: "field" }
const _hoisted_545 = { class: "field" }
const _hoisted_546 = { style: {"display":"flex","align-items":"center","gap":"6px","font-size":"13px","color":"var(--muted)"} }
const _hoisted_547 = {
  key: 0,
  style: {"color":"var(--danger)","font-size":"13px","margin-top":"8px"}
}
const _hoisted_548 = {
  key: 1,
  style: {"font-size":"13px","color":"var(--muted)","margin-top":"8px"}
}
const _hoisted_549 = { class: "modal-foot" }
const _hoisted_550 = ["disabled"]
const _hoisted_551 = ["disabled"]
const _hoisted_552 = { class: "modal" }
const _hoisted_553 = { class: "modal-head" }
const _hoisted_554 = ["disabled"]
const _hoisted_555 = { class: "modal-body" }
const _hoisted_556 = { style: {"margin-top":"0","font-size":"13px","color":"var(--muted)"} }
const _hoisted_557 = { class: "field" }
const _hoisted_558 = { class: "field" }
const _hoisted_559 = { class: "field" }
const _hoisted_560 = {
  key: 0,
  style: {"color":"var(--danger)","font-size":"13px"}
}
const _hoisted_561 = {
  key: 1,
  style: {"font-size":"13px","color":"var(--muted)"}
}
const _hoisted_562 = { class: "modal-foot" }
const _hoisted_563 = ["disabled"]
const _hoisted_564 = ["disabled"]
const _hoisted_565 = { class: "modal" }
const _hoisted_566 = { class: "modal-head" }
const _hoisted_567 = { class: "modal-body" }
const _hoisted_568 = { style: {"font-size":"15px","margin-top":"0"} }
const _hoisted_569 = { style: {"color":"var(--danger)","font-size":"13px"} }
const _hoisted_570 = { class: "confirm-check" }
const _hoisted_571 = { class: "modal-foot" }
const _hoisted_572 = ["disabled"]
const _hoisted_573 = { class: "modal" }
const _hoisted_574 = { class: "modal-head" }
const _hoisted_575 = {
  class: "modal-body",
  style: {"display":"flex","flex-direction":"column","align-items":"center","gap":"10px"}
}
const _hoisted_576 = { style: {"margin":"0","color":"var(--muted)","font-size":"12px","align-self":"flex-start"} }
const _hoisted_577 = ["src"]
const _hoisted_578 = { class: "modal-foot" }
const _hoisted_579 = ["disabled"]
const _hoisted_580 = { class: "modal" }
const _hoisted_581 = { class: "modal-head" }
const _hoisted_582 = { class: "modal-body" }
const _hoisted_583 = {
  key: 0,
  class: "empty"
}
const _hoisted_584 = {
  key: 1,
  class: "empty"
}
const _hoisted_585 = /*#__PURE__*/_createElementVNode("br", null, null, -1 /* HOISTED */)
const _hoisted_586 = { style: {"margin-top":"0","color":"var(--muted)","font-size":"13px"} }
const _hoisted_587 = {
  key: 0,
  class: "empty"
}
const _hoisted_588 = /*#__PURE__*/_createElementVNode("br", null, null, -1 /* HOISTED */)
const _hoisted_589 = {
  key: 1,
  class: "note-list"
}
const _hoisted_590 = ["onClick"]
const _hoisted_591 = { class: "ni-title" }
const _hoisted_592 = { class: "ni-cat" }
const _hoisted_593 = { style: {"font-size":"12px","color":"var(--muted)","margin-bottom":"6px"} }
const _hoisted_594 = {
  key: 0,
  class: "empty"
}
const _hoisted_595 = {
  key: 1,
  class: "note-list"
}
const _hoisted_596 = ["onClick"]
const _hoisted_597 = { class: "ni-title" }
const _hoisted_598 = { class: "modal-foot" }
const _hoisted_599 = { class: "modal" }
const _hoisted_600 = { class: "modal-head" }
const _hoisted_601 = { class: "modal-body" }
const _hoisted_602 = { class: "fp-path" }
const _hoisted_603 = ["disabled"]
const _hoisted_604 = { class: "fp-cur" }
const _hoisted_605 = {
  key: 0,
  class: "empty"
}
const _hoisted_606 = {
  key: 1,
  class: "empty"
}
const _hoisted_607 = {
  key: 2,
  class: "empty"
}
const _hoisted_608 = {
  key: 3,
  class: "note-list fp-list"
}
const _hoisted_609 = ["onClick", "onDblclick"]
const _hoisted_610 = { class: "ni-title" }
const _hoisted_611 = { class: "ni-cat" }
const _hoisted_612 = { class: "modal-foot" }
const _hoisted_613 = ["disabled"]
const _hoisted_614 = {
  key: 21,
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
              _hoisted_15,
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
                  _createElementVNode("span", _hoisted_22, _toDisplayString(c.record_count), 1 /* TEXT */)
                ], 42 /* CLASS, PROPS, NEED_HYDRATION */, _hoisted_18))
              }), 128 /* KEYED_FRAGMENT */)),
              (!_ctx.collections.length)
                ? (_openBlock(), _createElementBlock("div", _hoisted_23, [
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
                  _createElementVNode("div", _hoisted_24, _toDisplayString(_ctx.collTip.name), 1 /* TEXT */),
                  _createElementVNode("div", _hoisted_25, _toDisplayString(_ctx.collTip.desc), 1 /* TEXT */)
                ], 4 /* STYLE */))
              : _createCommentVNode("v-if", true),
            _createElementVNode("div", _hoisted_26, [
              _createElementVNode("button", {
                class: "btn primary block",
                onClick: _cache[8] || (_cache[8] = (...args) => (_ctx.openTemplatePicker && _ctx.openTemplatePicker(...args)))
              }, _toDisplayString(_ctx.t('＋ New collection')), 1 /* TEXT */),
              _createElementVNode("button", {
                class: "btn sm block",
                onClick: _cache[9] || (_cache[9] = (...args) => (_ctx.openSettings && _ctx.openSettings(...args))),
                title: _ctx.t('Theme, storage location, etc.')
              }, _toDisplayString(_ctx.t('⚙️ Settings')), 9 /* TEXT, PROPS */, _hoisted_27)
            ])
          ], 2 /* CLASS */),
          _createElementVNode("main", _hoisted_28, [
            _createElementVNode("div", _hoisted_29, [
              _createElementVNode("button", {
                class: "btn ghost hamburger",
                onClick: _cache[10] || (_cache[10] = $event => (_ctx.sidebarOpen=true))
              }, "☰"),
              (_ctx.current)
                ? (_openBlock(), _createElementBlock("div", _hoisted_30, [
                    (_ctx.shareBadge(_ctx.current))
                      ? (_openBlock(), _createElementBlock("span", {
                          key: 0,
                          class: "share-badge",
                          title: _ctx.shareBadgeTitle(_ctx.current)
                        }, _toDisplayString(_ctx.shareBadge(_ctx.current)), 9 /* TEXT, PROPS */, _hoisted_31))
                      : _createCommentVNode("v-if", true),
                    _createElementVNode("span", _hoisted_32, _toDisplayString(_ctx.current.icon), 1 /* TEXT */),
                    _createElementVNode("span", _hoisted_33, _toDisplayString(_ctx.current.name), 1 /* TEXT */)
                  ]))
                : (_openBlock(), _createElementBlock("div", _hoisted_34, [
                    _createElementVNode("span", _hoisted_35, _toDisplayString(_ctx.t('All collections')), 1 /* TEXT */)
                  ])),
              _hoisted_36,
              (_ctx.current)
                ? (_openBlock(), _createElementBlock("div", _hoisted_37, [
                    _createElementVNode("div", _hoisted_38, [
                      (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.views, (v) => {
                        return (_openBlock(), _createElementBlock("button", {
                          key: v.key,
                          class: _normalizeClass(["vbtn", {on: _ctx.current.view===v.key}]),
                          title: _ctx.t(v.label),
                          onClick: $event => (_ctx.setView(v.key)),
                          innerHTML: v.icon
                        }, null, 10 /* CLASS, PROPS */, _hoisted_39))
                      }), 128 /* KEYED_FRAGMENT */))
                    ]),
                    (_ctx.isOwner)
                      ? (_openBlock(), _createElementBlock("button", {
                          key: 0,
                          class: "btn sm",
                          onClick: _cache[11] || (_cache[11] = (...args) => (_ctx.openSchemaEditor && _ctx.openSchemaEditor(...args))),
                          title: _ctx.t('Edit fields (form)')
                        }, _toDisplayString(_ctx.t('🧩 Edit collection')), 9 /* TEXT, PROPS */, _hoisted_40))
                      : _createCommentVNode("v-if", true),
                    _createElementVNode("button", {
                      class: "btn sm",
                      onClick: _cache[12] || (_cache[12] = (...args) => (_ctx.openCollSettings && _ctx.openCollSettings(...args))),
                      title: _ctx.t('Collection name, description, color, etc.')
                    }, _toDisplayString(_ctx.t('⚙️ Collection settings')), 9 /* TEXT, PROPS */, _hoisted_41),
                    (_ctx.canEdit)
                      ? (_openBlock(), _createElementBlock("button", {
                          key: 1,
                          class: "btn accent sm",
                          onClick: _cache[13] || (_cache[13] = (...args) => (_ctx.openNewRecord && _ctx.openNewRecord(...args)))
                        }, _toDisplayString(_ctx.t('＋ New record')), 1 /* TEXT */))
                      : _createCommentVNode("v-if", true),
                    _hoisted_42
                  ]))
                : _createCommentVNode("v-if", true)
            ]),
            _createElementVNode("div", {
              class: _normalizeClass(["content", {'content-table': _ctx.current && _ctx.current.view==='table' && _ctx.records.length}]),
              onScroll: _cache[34] || (_cache[34] = (...args) => (_ctx.onScrollNearBottom && _ctx.onScrollNearBottom(...args)))
            }, [
              (!_ctx.current)
                ? (_openBlock(), _createElementBlock("div", _hoisted_43, [
                    (_ctx.collections.length)
                      ? (_openBlock(), _createElementBlock("div", _hoisted_44, [
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
                                    }, _toDisplayString(_ctx.shareBadge(c)), 9 /* TEXT, PROPS */, _hoisted_46))
                                  : _createCommentVNode("v-if", true)
                              ], 4 /* STYLE */),
                              _createElementVNode("div", _hoisted_47, [
                                _createElementVNode("div", _hoisted_48, _toDisplayString(c.name), 1 /* TEXT */),
                                _createElementVNode("div", _hoisted_49, _toDisplayString(c.description || _ctx.t('(no description)')), 1 /* TEXT */),
                                _createElementVNode("div", _hoisted_50, _toDisplayString(_ctx.t('{n} items', {n: c.record_count})), 1 /* TEXT */)
                              ])
                            ], 8 /* PROPS */, _hoisted_45))
                          }), 128 /* KEYED_FRAGMENT */))
                        ]))
                      : (_openBlock(), _createElementBlock("div", _hoisted_51, [
                          _hoisted_52,
                          _createElementVNode("p", null, [
                            _createTextVNode(_toDisplayString(_ctx.t('No collections yet.')), 1 /* TEXT */),
                            _hoisted_53,
                            _createTextVNode(_toDisplayString(_ctx.t('Create one from “＋ New collection” on the left.')), 1 /* TEXT */)
                          ])
                        ]))
                  ]))
                : (_openBlock(), _createElementBlock(_Fragment, { key: 1 }, [
                    _createElementVNode("div", _hoisted_54, [
                      _createElementVNode("div", _hoisted_55, [
                        _createElementVNode("button", {
                          type: "button",
                          class: _normalizeClass(["lt-toggle", {on: _ctx.selectionMode}]),
                          onClick: _cache[14] || (_cache[14] = (...args) => (_ctx.toggleSelectionMode && _ctx.toggleSelectionMode(...args))),
                          title: _ctx.t('Search, sort & bulk actions')
                        }, "☰", 10 /* CLASS, PROPS */, _hoisted_56),
                        _createElementVNode("span", _hoisted_57, [
                          (_ctx.shareBadge(_ctx.current))
                            ? (_openBlock(), _createElementBlock("span", {
                                key: 0,
                                class: "share-badge",
                                title: _ctx.shareBadgeTitle(_ctx.current)
                              }, _toDisplayString(_ctx.shareBadge(_ctx.current)), 9 /* TEXT, PROPS */, _hoisted_58))
                            : _createCommentVNode("v-if", true),
                          _createElementVNode("span", _hoisted_59, _toDisplayString(_ctx.current.icon), 1 /* TEXT */),
                          _createTextVNode(_toDisplayString(_ctx.current.name), 1 /* TEXT */)
                        ]),
                        (_ctx.records.length)
                          ? (_openBlock(), _createElementBlock("span", _hoisted_60, _toDisplayString(_ctx.t('{shown} / {total} items', {shown: _ctx.visibleRecords.length, total: _ctx.records.length})), 1 /* TEXT */))
                          : _createCommentVNode("v-if", true)
                      ]),
                      _withDirectives(_createElementVNode("div", _hoisted_61, [
                        _createElementVNode("div", _hoisted_62, [
                          _withDirectives(_createElementVNode("input", {
                            class: "searchinput",
                            "onUpdate:modelValue": _cache[15] || (_cache[15] = $event => ((_ctx.search) = $event)),
                            onInput: _cache[16] || (_cache[16] = (...args) => (_ctx.onSearchInput && _ctx.onSearchInput(...args))),
                            placeholder: _ctx.t('🔍 Search in this collection')
                          }, null, 40 /* PROPS, NEED_HYDRATION */, _hoisted_63), [
                            [_vModelText, _ctx.search]
                          ]),
                          _createElementVNode("span", {
                            class: "sortgroup",
                            title: _ctx.t('Display order — only changes how records are shown here')
                          }, [
                            _createElementVNode("span", _hoisted_65, "👁 " + _toDisplayString(_ctx.t('View')), 1 /* TEXT */),
                            _createElementVNode("select", {
                              class: "sortselect",
                              value: _ctx.normSort(_ctx.current.record_sort),
                              onChange: _cache[17] || (_cache[17] = $event => (_ctx.setSort($event.target.value))),
                              title: _ctx.t('Display order — only changes how records are shown here')
                            }, [
                              _createElementVNode("option", _hoisted_67, _toDisplayString(_ctx.t('Registration order (oldest first)')), 1 /* TEXT */),
                              _createElementVNode("option", _hoisted_68, _toDisplayString(_ctx.t('Registration order (newest first)')), 1 /* TEXT */),
                              _createElementVNode("option", _hoisted_69, _toDisplayString(_ctx.t('By name (character code, ascending)')), 1 /* TEXT */),
                              _createElementVNode("option", _hoisted_70, _toDisplayString(_ctx.t('By name (character code, descending)')), 1 /* TEXT */)
                            ], 40 /* PROPS, NEED_HYDRATION */, _hoisted_66)
                          ], 8 /* PROPS */, _hoisted_64),
                          (_ctx.canEdit && _ctx.records.length>1)
                            ? (_openBlock(), _createElementBlock("button", {
                                key: 0,
                                class: "btn sm reorder-open",
                                onClick: _cache[18] || (_cache[18] = (...args) => (_ctx.openReorder && _ctx.openReorder(...args))),
                                title: _ctx.t('Edit the saved registration order of the records (drag, or sort by up to 5 fields)')
                              }, "⇅ " + _toDisplayString(_ctx.t('Edit saved order')), 9 /* TEXT, PROPS */, _hoisted_71))
                            : _createCommentVNode("v-if", true)
                        ]),
                        _createElementVNode("div", _hoisted_72, [
                          _createElementVNode("span", _hoisted_73, _toDisplayString(_ctx.selectedIds.length ? _ctx.t('{n} selected', {n: _ctx.selectedIds.length}) : _ctx.t('Select records')), 1 /* TEXT */),
                          _createElementVNode("button", {
                            class: "btn sm ghost",
                            onClick: _cache[19] || (_cache[19] = (...args) => (_ctx.selectAll && _ctx.selectAll(...args))),
                            disabled: !_ctx.records.length
                          }, _toDisplayString(_ctx.t('Select all')), 9 /* TEXT, PROPS */, _hoisted_74),
                          _createElementVNode("button", {
                            class: "btn sm ghost",
                            disabled: !_ctx.selectedIds.length,
                            onClick: _cache[20] || (_cache[20] = (...args) => (_ctx.clearSelection && _ctx.clearSelection(...args)))
                          }, _toDisplayString(_ctx.t('Clear')), 9 /* TEXT, PROPS */, _hoisted_75),
                          _hoisted_76,
                          (_ctx.canEdit)
                            ? (_openBlock(), _createElementBlock("button", {
                                key: 0,
                                class: "btn sm",
                                disabled: !_ctx.selectedIds.length,
                                onClick: _cache[21] || (_cache[21] = (...args) => (_ctx.duplicateInPlace && _ctx.duplicateInPlace(...args))),
                                title: _ctx.t('Duplicate within this collection')
                              }, _toDisplayString(_ctx.t('Duplicate')), 9 /* TEXT, PROPS */, _hoisted_77))
                            : _createCommentVNode("v-if", true),
                          (_ctx.isOwner)
                            ? (_openBlock(), _createElementBlock("button", {
                                key: 1,
                                class: "btn sm",
                                disabled: !_ctx.selectedIds.length,
                                onClick: _cache[22] || (_cache[22] = $event => (_ctx.openTransferBulk('copy')))
                              }, _toDisplayString(_ctx.t('Copy to collection')), 9 /* TEXT, PROPS */, _hoisted_78))
                            : _createCommentVNode("v-if", true),
                          (_ctx.isOwner)
                            ? (_openBlock(), _createElementBlock("button", {
                                key: 2,
                                class: "btn sm",
                                disabled: !_ctx.selectedIds.length,
                                onClick: _cache[23] || (_cache[23] = $event => (_ctx.openTransferBulk('move')))
                              }, _toDisplayString(_ctx.t('Move to collection')), 9 /* TEXT, PROPS */, _hoisted_79))
                            : _createCommentVNode("v-if", true),
                          (_ctx.canDelete)
                            ? (_openBlock(), _createElementBlock("button", {
                                key: 3,
                                class: "btn sm danger",
                                disabled: !_ctx.selectedIds.length,
                                onClick: _cache[24] || (_cache[24] = (...args) => (_ctx.openBulkDelete && _ctx.openBulkDelete(...args)))
                              }, _toDisplayString(_ctx.t('Delete')), 9 /* TEXT, PROPS */, _hoisted_80))
                            : _createCommentVNode("v-if", true)
                        ])
                      ], 512 /* NEED_PATCH */), [
                        [_vShow, _ctx.selectionMode]
                      ])
                    ]),
                    (!_ctx.records.length)
                      ? (_openBlock(), _createElementBlock("div", _hoisted_81, [
                          _createElementVNode("div", _hoisted_82, _toDisplayString(_ctx.current.icon), 1 /* TEXT */),
                          (_ctx.search)
                            ? (_openBlock(), _createElementBlock("p", _hoisted_83, _toDisplayString(_ctx.t('No records match “{q}”', {q: _ctx.search})), 1 /* TEXT */))
                            : (_openBlock(), _createElementBlock(_Fragment, { key: 1 }, [
                                _createElementVNode("p", null, _toDisplayString(_ctx.t('No records yet')), 1 /* TEXT */),
                                _createElementVNode("button", {
                                  class: "btn primary",
                                  onClick: _cache[25] || (_cache[25] = (...args) => (_ctx.openNewRecord && _ctx.openNewRecord(...args)))
                                }, _toDisplayString(_ctx.t('＋ Add the first record')), 1 /* TEXT */)
                              ], 64 /* STABLE_FRAGMENT */))
                        ]))
                      : (_openBlock(), _createElementBlock(_Fragment, { key: 1 }, [
                          _createCommentVNode(" カード型 "),
                          (_ctx.current.view==='card')
                            ? (_openBlock(), _createElementBlock("div", _hoisted_84, [
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
                                    }, null, 40 /* PROPS, NEED_HYDRATION */, _hoisted_85),
                                    _createElementVNode("button", {
                                      class: "rec-copy",
                                      onClick: _withModifiers($event => (_ctx.copyRecord(r)), ["stop"]),
                                      title: _ctx.t('Copy the whole card')
                                    }, "⧉", 8 /* PROPS */, _hoisted_86),
                                    _createElementVNode("button", {
                                      class: "rec-card",
                                      onClick: $event => (_ctx.openRecord(r))
                                    }, [
                                      _createElementVNode("div", _hoisted_88, _toDisplayString(r.title), 1 /* TEXT */),
                                      _createElementVNode("div", _hoisted_89, [
                                        _createElementVNode("span", null, _toDisplayString(_ctx.subtitle(r)), 1 /* TEXT */)
                                      ])
                                    ], 8 /* PROPS */, _hoisted_87)
                                  ], 2 /* CLASS */))
                                }), 128 /* KEYED_FRAGMENT */))
                              ]))
                            : (_ctx.current.view==='list')
                              ? (_openBlock(), _createElementBlock(_Fragment, { key: 1 }, [
                                  _createCommentVNode(" リスト型 "),
                                  _createElementVNode("div", _hoisted_90, [
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
                                        }, null, 40 /* PROPS, NEED_HYDRATION */, _hoisted_91),
                                        _createElementVNode("button", {
                                          class: "rec-row",
                                          onClick: $event => (_ctx.openRecord(r))
                                        }, [
                                          _createElementVNode("span", _hoisted_93, _toDisplayString(r.title), 1 /* TEXT */),
                                          _createElementVNode("span", _hoisted_94, _toDisplayString(_ctx.subtitle(r)), 1 /* TEXT */),
                                          _hoisted_95
                                        ], 8 /* PROPS */, _hoisted_92),
                                        _createElementVNode("button", {
                                          class: "rec-copy inline",
                                          onClick: _withModifiers($event => (_ctx.copyRecord(r)), ["stop"]),
                                          title: _ctx.t('Copy the whole card')
                                        }, "⧉", 8 /* PROPS */, _hoisted_96)
                                      ], 2 /* CLASS */))
                                    }), 128 /* KEYED_FRAGMENT */))
                                  ])
                                ], 2112 /* STABLE_FRAGMENT, DEV_ROOT_FRAGMENT */))
                              : (_ctx.current.view==='detail')
                                ? (_openBlock(), _createElementBlock(_Fragment, { key: 2 }, [
                                    _createCommentVNode(" リスト詳細型 "),
                                    _createElementVNode("div", _hoisted_97, [
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
                                          }, null, 40 /* PROPS, NEED_HYDRATION */, _hoisted_98),
                                          _createElementVNode("button", {
                                            class: "rec-drow",
                                            onClick: $event => (_ctx.openRecord(r))
                                          }, [
                                            _createElementVNode("div", _hoisted_100, _toDisplayString(r.title), 1 /* TEXT */),
                                            _createElementVNode("div", _hoisted_101, [
                                              (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.listFields, (f) => {
                                                return _withDirectives((_openBlock(), _createElementBlock("span", {
                                                  key: f.key,
                                                  class: "rr-field"
                                                }, [
                                                  _createElementVNode("b", null, _toDisplayString(f.label) + ":", 1 /* TEXT */),
                                                  _createTextVNode(" " + _toDisplayString(_ctx.cellPreview(r, f)), 1 /* TEXT */)
                                                ])), [
                                                  [_vShow, r.data[f.key]!=null && r.data[f.key]!=='']
                                                ])
                                              }), 128 /* KEYED_FRAGMENT */))
                                            ])
                                          ], 8 /* PROPS */, _hoisted_99),
                                          _createElementVNode("button", {
                                            class: "rec-copy inline",
                                            onClick: _withModifiers($event => (_ctx.copyRecord(r)), ["stop"]),
                                            title: _ctx.t('Copy the whole card')
                                          }, "⧉", 8 /* PROPS */, _hoisted_102)
                                        ], 2 /* CLASS */))
                                      }), 128 /* KEYED_FRAGMENT */))
                                    ])
                                  ], 2112 /* STABLE_FRAGMENT, DEV_ROOT_FRAGMENT */))
                                : (_ctx.current.view==='table')
                                  ? (_openBlock(), _createElementBlock(_Fragment, { key: 3 }, [
                                      _createCommentVNode(" 表計算型（左端の項目を固定／2列目以降はドラッグで横スクロール） "),
                                      _createElementVNode("div", {
                                        class: _normalizeClass(["rec-table-wrap", {dragging: _ctx.tableDrag.active}]),
                                        onScroll: _cache[29] || (_cache[29] = (...args) => (_ctx.onScrollNearBottom && _ctx.onScrollNearBottom(...args))),
                                        onPointerdown: _cache[30] || (_cache[30] = (...args) => (_ctx.tableDown && _ctx.tableDown(...args))),
                                        onPointermove: _cache[31] || (_cache[31] = (...args) => (_ctx.tableMove && _ctx.tableMove(...args))),
                                        onPointerup: _cache[32] || (_cache[32] = (...args) => (_ctx.tableUp && _ctx.tableUp(...args))),
                                        onPointercancel: _cache[33] || (_cache[33] = (...args) => (_ctx.tableUp && _ctx.tableUp(...args)))
                                      }, [
                                        _createElementVNode("table", _hoisted_103, [
                                          _createElementVNode("thead", null, [
                                            _createElementVNode("tr", null, [
                                              _createElementVNode("th", _hoisted_104, [
                                                _createElementVNode("label", _hoisted_105, [
                                                  _createElementVNode("input", {
                                                    type: "checkbox",
                                                    checked: _ctx.allSelected,
                                                    onChange: _cache[26] || (_cache[26] = $event => (_ctx.allSelected ? _ctx.clearSelection() : _ctx.selectAll()))
                                                  }, null, 40 /* PROPS, NEED_HYDRATION */, _hoisted_106),
                                                  (_ctx.tableFrozen)
                                                    ? (_openBlock(), _createElementBlock("span", _hoisted_107, _toDisplayString(_ctx.tableFrozen.label), 1 /* TEXT */))
                                                    : _createCommentVNode("v-if", true)
                                                ])
                                              ]),
                                              (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.tableScrollFields, (f) => {
                                                return (_openBlock(), _createElementBlock("th", {
                                                  key: f.key
                                                }, _toDisplayString(f.label), 1 /* TEXT */))
                                              }), 128 /* KEYED_FRAGMENT */)),
                                              _hoisted_108
                                            ])
                                          ]),
                                          _createElementVNode("tbody", null, [
                                            (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.visibleRecords, (r) => {
                                              return (_openBlock(), _createElementBlock("tr", {
                                                key: r.id,
                                                class: _normalizeClass({sel: _ctx.isSelected(r.id)})
                                              }, [
                                                _createElementVNode("td", _hoisted_109, [
                                                  _createElementVNode("label", {
                                                    class: "rt-fcell",
                                                    onClick: _cache[27] || (_cache[27] = _withModifiers(() => {}, ["stop"]))
                                                  }, [
                                                    _createElementVNode("input", {
                                                      type: "checkbox",
                                                      checked: _ctx.isSelected(r.id),
                                                      onChange: $event => (_ctx.toggleSelect(r.id))
                                                    }, null, 40 /* PROPS, NEED_HYDRATION */, _hoisted_110)
                                                  ]),
                                                  _createElementVNode("span", {
                                                    class: _normalizeClass(["rt-fval", {mono: _ctx.tableFrozen && _ctx.tableFrozen.secret}]),
                                                    onClick: $event => (_ctx.openRecord(r)),
                                                    title: _ctx.t('Edit')
                                                  }, [
                                                    (_ctx.tableFrozen && (_ctx.tableFrozen.type==='image'||_ctx.tableFrozen.type==='image_crop') && r.data[_ctx.tableFrozen.key])
                                                      ? (_openBlock(), _createElementBlock("img", {
                                                          key: 0,
                                                          src: _ctx.imgUrl(r.data[_ctx.tableFrozen.key]),
                                                          class: "rt-thumb",
                                                          loading: "lazy"
                                                        }, null, 8 /* PROPS */, _hoisted_112))
                                                      : (_openBlock(), _createElementBlock(_Fragment, { key: 1 }, [
                                                          _createTextVNode(_toDisplayString(_ctx.tableFrozen ? _ctx.cellPreview(r, _ctx.tableFrozen) : r.title), 1 /* TEXT */)
                                                        ], 64 /* STABLE_FRAGMENT */))
                                                  ], 10 /* CLASS, PROPS */, _hoisted_111)
                                                ]),
                                                (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.tableScrollFields, (f) => {
                                                  return (_openBlock(), _createElementBlock("td", {
                                                    key: f.key,
                                                    class: _normalizeClass({mono: f.secret})
                                                  }, [
                                                    ((f.type==='image'||f.type==='image_crop') && r.data[f.key])
                                                      ? (_openBlock(), _createElementBlock("img", {
                                                          key: 0,
                                                          src: _ctx.imgUrl(r.data[f.key]),
                                                          class: "rt-thumb",
                                                          loading: "lazy"
                                                        }, null, 8 /* PROPS */, _hoisted_113))
                                                      : (_openBlock(), _createElementBlock("span", _hoisted_114, _toDisplayString(_ctx.cellPreview(r, f)), 1 /* TEXT */))
                                                  ], 2 /* CLASS */))
                                                }), 128 /* KEYED_FRAGMENT */)),
                                                _createElementVNode("td", {
                                                  class: "rt-actions",
                                                  onClick: _cache[28] || (_cache[28] = _withModifiers(() => {}, ["stop"]))
                                                }, [
                                                  _createElementVNode("button", {
                                                    class: "rec-copy inline",
                                                    onClick: $event => (_ctx.copyRecord(r)),
                                                    title: _ctx.t('Copy the whole card')
                                                  }, "⧉", 8 /* PROPS */, _hoisted_115)
                                                ])
                                              ], 2 /* CLASS */))
                                            }), 128 /* KEYED_FRAGMENT */))
                                          ])
                                        ])
                                      ], 34 /* CLASS, NEED_HYDRATION */)
                                    ], 2112 /* STABLE_FRAGMENT, DEV_ROOT_FRAGMENT */))
                                  : (_openBlock(), _createElementBlock(_Fragment, { key: 4 }, [
                                      _createCommentVNode(" 画像リスト型 "),
                                      _createElementVNode("div", _hoisted_116, [
                                        (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.visibleRecords, (r) => {
                                          return (_openBlock(), _createElementBlock("div", {
                                            key: r.id,
                                            class: _normalizeClass(["rec-wrap img", {sel: _ctx.isSelected(r.id)}])
                                          }, [
                                            _createElementVNode("input", {
                                              type: "checkbox",
                                              class: "rec-check",
                                              checked: _ctx.isSelected(r.id),
                                              onChange: $event => (_ctx.toggleSelect(r.id))
                                            }, null, 40 /* PROPS, NEED_HYDRATION */, _hoisted_117),
                                            _createElementVNode("button", {
                                              class: "rec-copy",
                                              onClick: _withModifiers($event => (_ctx.copyRecord(r)), ["stop"]),
                                              title: _ctx.t('Copy the whole card')
                                            }, "⧉", 8 /* PROPS */, _hoisted_118),
                                            _createElementVNode("button", {
                                              class: "rec-imgcard",
                                              onClick: $event => (_ctx.openRecord(r))
                                            }, [
                                              _createElementVNode("div", _hoisted_120, [
                                                (_ctx.imageSrc(r))
                                                  ? (_openBlock(), _createElementBlock("img", {
                                                      key: 0,
                                                      src: _ctx.imageSrc(r),
                                                      loading: "lazy"
                                                    }, null, 8 /* PROPS */, _hoisted_121))
                                                  : (_openBlock(), _createElementBlock("span", _hoisted_122, _toDisplayString(_ctx.current.icon), 1 /* TEXT */))
                                              ]),
                                              _createElementVNode("div", _hoisted_123, _toDisplayString(r.title), 1 /* TEXT */),
                                              _createElementVNode("div", _hoisted_124, _toDisplayString(_ctx.subtitle(r)), 1 /* TEXT */)
                                            ], 8 /* PROPS */, _hoisted_119)
                                          ], 2 /* CLASS */))
                                        }), 128 /* KEYED_FRAGMENT */))
                                      ])
                                    ], 2112 /* STABLE_FRAGMENT, DEV_ROOT_FRAGMENT */))
                        ], 64 /* STABLE_FRAGMENT */))
                  ], 64 /* STABLE_FRAGMENT */))
            ], 34 /* CLASS, NEED_HYDRATION */),
            (_ctx.current && _ctx.records.length && _ctx.current.view!=='table')
              ? (_openBlock(), _createElementBlock("div", _hoisted_125, [
                  _createElementVNode("button", {
                    class: "scrollnav-btn",
                    onClick: _cache[35] || (_cache[35] = (...args) => (_ctx.scrollToTop && _ctx.scrollToTop(...args))),
                    title: _ctx.t('To top')
                  }, "▲", 8 /* PROPS */, _hoisted_126),
                  _createElementVNode("button", {
                    class: "scrollnav-btn",
                    onClick: _cache[36] || (_cache[36] = (...args) => (_ctx.scrollToBottom && _ctx.scrollToBottom(...args))),
                    title: _ctx.t('To bottom')
                  }, "▼", 8 /* PROPS */, _hoisted_127)
                ]))
              : _createCommentVNode("v-if", true)
          ]),
          _createCommentVNode(" Template picker "),
          (_ctx.modal && _ctx.modal.type==='template')
            ? (_openBlock(), _createElementBlock("div", {
                key: 0,
                class: "modal-mask",
                onClick: _cache[42] || (_cache[42] = _withModifiers($event => (_ctx.modal=null), ["self"]))
              }, [
                _createElementVNode("div", _hoisted_128, [
                  _createElementVNode("div", _hoisted_129, [
                    _createElementVNode("h3", null, _toDisplayString(_ctx.t('New collection')), 1 /* TEXT */),
                    _createElementVNode("button", {
                      class: "icon-btn",
                      onClick: _cache[37] || (_cache[37] = $event => (_ctx.modal=null))
                    }, "✕")
                  ]),
                  _createElementVNode("div", _hoisted_130, [
                    _createElementVNode("button", {
                      class: "btn block",
                      style: {"margin-bottom":"8px"},
                      onClick: _cache[38] || (_cache[38] = (...args) => (_ctx.openImport && _ctx.openImport(...args)))
                    }, _toDisplayString(_ctx.t('📥 Import from CSV / JSON file (auto-create fields)')), 1 /* TEXT */),
                    _createElementVNode("button", {
                      class: "btn block",
                      style: {"margin-bottom":"8px"},
                      disabled: !_ctx.apps.contacts,
                      title: _ctx.apps.contacts ? '' : _ctx.t('The Contacts app is not enabled'),
                      onClick: _cache[39] || (_cache[39] = (...args) => (_ctx.openContactsImport && _ctx.openContactsImport(...args)))
                    }, _toDisplayString(_ctx.t('📇 Import from Contacts')), 9 /* TEXT, PROPS */, _hoisted_131),
                    _createElementVNode("button", {
                      class: "btn block",
                      style: {"margin-bottom":"14px"},
                      disabled: !_ctx.apps.tables,
                      title: _ctx.apps.tables ? '' : _ctx.t('The Tables app is not enabled'),
                      onClick: _cache[40] || (_cache[40] = (...args) => (_ctx.openTablesImport && _ctx.openTablesImport(...args)))
                    }, _toDisplayString(_ctx.t('📊 Import from Tables')), 9 /* TEXT, PROPS */, _hoisted_132),
                    _createElementVNode("div", _hoisted_133, _toDisplayString(_ctx.t('Or create from a template:')), 1 /* TEXT */),
                    (_ctx.templatesLoading && !_ctx.templates.length)
                      ? (_openBlock(), _createElementBlock("div", _hoisted_134, [
                          _createElementVNode("p", null, _toDisplayString(_ctx.t('Loading…')), 1 /* TEXT */)
                        ]))
                      : (_openBlock(), _createElementBlock("div", _hoisted_135, [
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
                                _createElementVNode("div", _hoisted_137, [
                                  _createElementVNode("span", _hoisted_138, _toDisplayString(tpl.icon), 1 /* TEXT */),
                                  _createElementVNode("span", _hoisted_139, _toDisplayString(tpl.name), 1 /* TEXT */),
                                  (tpl.custom)
                                    ? (_openBlock(), _createElementBlock("span", _hoisted_140, _toDisplayString(_ctx.t('Custom')), 1 /* TEXT */))
                                    : (tpl.overridden)
                                      ? (_openBlock(), _createElementBlock("span", _hoisted_141, _toDisplayString(_ctx.t('Edited')), 1 /* TEXT */))
                                      : _createCommentVNode("v-if", true)
                                ]),
                                _createElementVNode("div", _hoisted_142, _toDisplayString(tpl.description), 1 /* TEXT */)
                              ], 8 /* PROPS */, _hoisted_136),
                              _createElementVNode("div", _hoisted_143, [
                                _createElementVNode("button", {
                                  type: "button",
                                  class: "icon-btn",
                                  title: _ctx.t('Edit template'),
                                  onClick: _withModifiers($event => (_ctx.openTemplateEditor(tpl)), ["stop"])
                                }, "✏️", 8 /* PROPS */, _hoisted_144),
                                (tpl.custom)
                                  ? (_openBlock(), _createElementBlock("button", {
                                      key: 0,
                                      type: "button",
                                      class: "icon-btn",
                                      title: _ctx.t('Delete template'),
                                      onClick: _withModifiers($event => (_ctx.deleteTemplate(tpl)), ["stop"])
                                    }, "🗑", 8 /* PROPS */, _hoisted_145))
                                  : (tpl.overridden)
                                    ? (_openBlock(), _createElementBlock("button", {
                                        key: 1,
                                        type: "button",
                                        class: "icon-btn",
                                        title: _ctx.t('Reset to default'),
                                        onClick: _withModifiers($event => (_ctx.resetTemplate(tpl)), ["stop"])
                                      }, "↺", 8 /* PROPS */, _hoisted_146))
                                    : _createCommentVNode("v-if", true)
                              ])
                            ], 2 /* CLASS */))
                          }), 128 /* KEYED_FRAGMENT */))
                        ]))
                  ]),
                  _createElementVNode("div", _hoisted_147, [
                    _createElementVNode("button", {
                      class: "btn",
                      onClick: _cache[41] || (_cache[41] = $event => (_ctx.modal=null))
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
                onClick: _cache[49] || (_cache[49] = _withModifiers($event => (_ctx.modal=null), ["self"]))
              }, [
                _createElementVNode("form", {
                  class: "modal",
                  onSubmit: _cache[48] || (_cache[48] = _withModifiers((...args) => (_ctx.saveRecord && _ctx.saveRecord(...args)), ["prevent"]))
                }, [
                  _createElementVNode("div", _hoisted_148, [
                    _createElementVNode("h3", null, _toDisplayString(_ctx.editingRecordId ? _ctx.t('Edit record') : _ctx.t('New record')), 1 /* TEXT */),
                    _createElementVNode("button", {
                      type: "button",
                      class: "icon-btn",
                      onClick: _cache[43] || (_cache[43] = $event => (_ctx.modal=null))
                    }, "✕")
                  ]),
                  _createElementVNode("div", _hoisted_149, [
                    (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.current.fields, (f) => {
                      return (_openBlock(), _createElementBlock("div", {
                        key: f.key,
                        class: "field"
                      }, [
                        _createElementVNode("label", null, [
                          _createTextVNode(_toDisplayString(f.label) + " ", 1 /* TEXT */),
                          (f.required)
                            ? (_openBlock(), _createElementBlock("span", _hoisted_150, "*"))
                            : _createCommentVNode("v-if", true),
                          _createTextVNode(),
                          (f.secret)
                            ? (_openBlock(), _createElementBlock("span", _hoisted_151, _toDisplayString(_ctx.t('Secret')), 1 /* TEXT */))
                            : _createCommentVNode("v-if", true)
                        ]),
                        (f.type==='textarea')
                          ? _withDirectives((_openBlock(), _createElementBlock("textarea", {
                              key: 0,
                              "onUpdate:modelValue": $event => ((_ctx.form[f.key]) = $event),
                              placeholder: f.placeholder||'',
                              maxlength: _ctx.ruleMax(f)
                            }, null, 8 /* PROPS */, _hoisted_152)), [
                              [_vModelText, _ctx.form[f.key]]
                            ])
                          : (f.type==='select')
                            ? _withDirectives((_openBlock(), _createElementBlock("select", {
                                key: 1,
                                "onUpdate:modelValue": $event => ((_ctx.form[f.key]) = $event)
                              }, [
                                _createElementVNode("option", _hoisted_154, _toDisplayString(_ctx.t('— Select —')), 1 /* TEXT */),
                                (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(f.options, (o) => {
                                  return (_openBlock(), _createElementBlock("option", {
                                    key: o,
                                    value: o
                                  }, _toDisplayString(o), 9 /* TEXT, PROPS */, _hoisted_155))
                                }), 128 /* KEYED_FRAGMENT */))
                              ], 8 /* PROPS */, _hoisted_153)), [
                                [_vModelSelect, _ctx.form[f.key]]
                              ])
                            : (f.type==='image' || f.type==='image_crop')
                              ? (_openBlock(), _createElementBlock("div", _hoisted_156, [
                                  _createElementVNode("div", {
                                    class: _normalizeClass(["dropzone", {over: _ctx.dropKey===f.key}]),
                                    onDragover: _cache[44] || (_cache[44] = _withModifiers(() => {}, ["prevent"])),
                                    onDragenter: _withModifiers($event => (_ctx.dropKey=f.key), ["prevent"]),
                                    onDragleave: _withModifiers($event => (_ctx.onDropLeave(f.key)), ["prevent"]),
                                    onDrop: _withModifiers($event => (_ctx.onImageDrop($event, f)), ["prevent"])
                                  }, [
                                    (_ctx.form[f.key])
                                      ? (_openBlock(), _createElementBlock("img", {
                                          key: 0,
                                          src: _ctx.imgUrl(_ctx.form[f.key]),
                                          class: "imgpreview"
                                        }, null, 8 /* PROPS */, _hoisted_158))
                                      : (_openBlock(), _createElementBlock("div", _hoisted_159, [
                                          _hoisted_160,
                                          _createTextVNode(_toDisplayString(_ctx.t('Drag & drop an image here')), 1 /* TEXT */),
                                          _hoisted_161,
                                          _createTextVNode(_toDisplayString(f.type==='image_crop' ? _ctx.t('or choose with the button below (will be cropped)') : _ctx.t('or choose with the button below')), 1 /* TEXT */)
                                        ]))
                                  ], 42 /* CLASS, PROPS, NEED_HYDRATION */, _hoisted_157),
                                  _createElementVNode("div", _hoisted_162, [
                                    _createElementVNode("button", {
                                      type: "button",
                                      class: "btn sm",
                                      onClick: $event => (_ctx.pickImageFromNc(f))
                                    }, _toDisplayString(_ctx.t('📂 Choose file')), 9 /* TEXT, PROPS */, _hoisted_163),
                                    _createElementVNode("label", _hoisted_164, [
                                      _createTextVNode(_toDisplayString(_ctx.t('⬆ Upload')), 1 /* TEXT */),
                                      _createElementVNode("input", {
                                        type: "file",
                                        accept: "image/*",
                                        style: {"display":"none"},
                                        onChange: $event => (_ctx.onImagePick($event, f))
                                      }, null, 40 /* PROPS, NEED_HYDRATION */, _hoisted_165)
                                    ]),
                                    (_ctx.form[f.key] && f.type==='image_crop')
                                      ? (_openBlock(), _createElementBlock("button", {
                                          key: 0,
                                          type: "button",
                                          class: "btn sm",
                                          onClick: $event => (_ctx.recropCurrent(f))
                                        }, _toDisplayString(_ctx.t('✂ Re-crop')), 9 /* TEXT, PROPS */, _hoisted_166))
                                      : _createCommentVNode("v-if", true),
                                    (_ctx.form[f.key])
                                      ? (_openBlock(), _createElementBlock("button", {
                                          key: 1,
                                          type: "button",
                                          class: "btn sm danger",
                                          onClick: $event => (_ctx.form[f.key]='')
                                        }, _toDisplayString(_ctx.t('Delete')), 9 /* TEXT, PROPS */, _hoisted_167))
                                      : _createCommentVNode("v-if", true)
                                  ])
                                ]))
                              : (f.type==='file')
                                ? (_openBlock(), _createElementBlock("div", _hoisted_168, [
                                    (_ctx.form[f.key])
                                      ? (_openBlock(), _createElementBlock("div", _hoisted_169, [
                                          _createElementVNode("span", _hoisted_170, _toDisplayString(_ctx.fileIcon(_ctx.form[f.key])), 1 /* TEXT */),
                                          _createElementVNode("span", _hoisted_171, _toDisplayString(_ctx.fileName(_ctx.form[f.key])), 1 /* TEXT */),
                                          _createElementVNode("button", {
                                            type: "button",
                                            class: "btn sm",
                                            onClick: $event => (_ctx.openAttachment(_ctx.form[f.key]))
                                          }, _toDisplayString(_ctx.t('Open')), 9 /* TEXT, PROPS */, _hoisted_172),
                                          _createElementVNode("button", {
                                            type: "button",
                                            class: "btn sm",
                                            onClick: $event => (_ctx.downloadAttachment(_ctx.form[f.key])),
                                            title: _ctx.t('Download')
                                          }, "⬇", 8 /* PROPS */, _hoisted_173),
                                          _createElementVNode("button", {
                                            type: "button",
                                            class: "btn sm danger",
                                            onClick: $event => (_ctx.form[f.key]='')
                                          }, _toDisplayString(_ctx.t('Delete')), 9 /* TEXT, PROPS */, _hoisted_174)
                                        ]))
                                      : (_openBlock(), _createElementBlock(_Fragment, { key: 1 }, [
                                          _createElementVNode("div", {
                                            class: _normalizeClass(["dropzone", {over: _ctx.dropKey===f.key}]),
                                            onDragover: _cache[45] || (_cache[45] = _withModifiers(() => {}, ["prevent"])),
                                            onDragenter: _withModifiers($event => (_ctx.dropKey=f.key), ["prevent"]),
                                            onDragleave: _withModifiers($event => (_ctx.onDropLeave(f.key)), ["prevent"]),
                                            onDrop: _withModifiers($event => (_ctx.onDocDrop($event, f)), ["prevent"])
                                          }, [
                                            _createElementVNode("div", _hoisted_176, [
                                              _hoisted_177,
                                              _createTextVNode(_toDisplayString(_ctx.t('Drag & drop PDF / Word / Excel / ODF')), 1 /* TEXT */),
                                              _hoisted_178,
                                              _createTextVNode(_toDisplayString(_ctx.t('or choose and attach below')), 1 /* TEXT */)
                                            ])
                                          ], 42 /* CLASS, PROPS, NEED_HYDRATION */, _hoisted_175),
                                          _createElementVNode("div", _hoisted_179, [
                                            _createElementVNode("button", {
                                              type: "button",
                                              class: "btn sm",
                                              onClick: $event => (_ctx.pickDocFromNc(f))
                                            }, _toDisplayString(_ctx.t('📂 Choose file')), 9 /* TEXT, PROPS */, _hoisted_180),
                                            _createElementVNode("label", _hoisted_181, [
                                              _createTextVNode(_toDisplayString(_ctx.t('⬆ Upload')), 1 /* TEXT */),
                                              _createElementVNode("input", {
                                                type: "file",
                                                accept: ".pdf,.odt,.ods,.odp,.docx,.xlsx",
                                                style: {"display":"none"},
                                                onChange: $event => (_ctx.onDocPick($event, f))
                                              }, null, 40 /* PROPS, NEED_HYDRATION */, _hoisted_182)
                                            ]),
                                            _createElementVNode("button", {
                                              type: "button",
                                              class: "btn sm",
                                              onClick: $event => (_ctx.openNotePicker(f))
                                            }, _toDisplayString(_ctx.t('📝 Attach a note')), 9 /* TEXT, PROPS */, _hoisted_183)
                                          ])
                                        ], 64 /* STABLE_FRAGMENT */))
                                  ]))
                                : (_openBlock(), _createElementBlock("div", _hoisted_184, [
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
                                    }, null, 10 /* CLASS, PROPS */, _hoisted_185), [
                                      [_vModelDynamic, _ctx.form[f.key]]
                                    ]),
                                    (f.secret && !_ctx.secretsMasked)
                                      ? (_openBlock(), _createElementBlock("button", {
                                          key: 0,
                                          type: "button",
                                          class: "icon-btn",
                                          onClick: $event => (_ctx.toggleReveal(f.key))
                                        }, _toDisplayString(_ctx.reveal[f.key]?'🙈':'👁'), 9 /* TEXT, PROPS */, _hoisted_186))
                                      : _createCommentVNode("v-if", true)
                                  ])),
                        (_ctx.ruleHint(f))
                          ? (_openBlock(), _createElementBlock("div", _hoisted_187, "📏 " + _toDisplayString(_ctx.ruleHint(f)), 1 /* TEXT */))
                          : _createCommentVNode("v-if", true)
                      ]))
                    }), 128 /* KEYED_FRAGMENT */))
                  ]),
                  _createElementVNode("div", _hoisted_188, [
                    (_ctx.editingRecordId)
                      ? (_openBlock(), _createElementBlock("button", {
                          key: 0,
                          type: "button",
                          class: "btn danger",
                          onClick: _cache[46] || (_cache[46] = $event => (_ctx.deleteRecord({id:_ctx.editingRecordId})))
                        }, _toDisplayString(_ctx.t('Delete')), 1 /* TEXT */))
                      : _createCommentVNode("v-if", true),
                    _createElementVNode("button", {
                      type: "button",
                      class: "btn",
                      onClick: _cache[47] || (_cache[47] = $event => (_ctx.modal=null))
                    }, _toDisplayString(_ctx.t('Cancel')), 1 /* TEXT */),
                    _createElementVNode("button", _hoisted_189, _toDisplayString(_ctx.t('Save')), 1 /* TEXT */)
                  ])
                ], 32 /* NEED_HYDRATION */)
              ]))
            : _createCommentVNode("v-if", true),
          _createCommentVNode(" Record detail "),
          (_ctx.modal && _ctx.modal.type==='detail')
            ? (_openBlock(), _createElementBlock("div", {
                key: 2,
                class: "modal-mask",
                onClick: _cache[55] || (_cache[55] = _withModifiers($event => (_ctx.modal=null), ["self"]))
              }, [
                _createElementVNode("div", _hoisted_190, [
                  _createElementVNode("div", _hoisted_191, [
                    _createElementVNode("h3", null, _toDisplayString(_ctx.modal.rec.title), 1 /* TEXT */),
                    _createElementVNode("button", {
                      class: "icon-btn",
                      onClick: _cache[50] || (_cache[50] = $event => (_ctx.modal=null))
                    }, "✕")
                  ]),
                  _createElementVNode("div", _hoisted_192, [
                    (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.current.fields, (f) => {
                      return _withDirectives((_openBlock(), _createElementBlock("div", {
                        key: f.key,
                        class: "detail-row"
                      }, [
                        _createElementVNode("div", _hoisted_193, _toDisplayString(f.label), 1 /* TEXT */),
                        (f.type==='image' || f.type==='image_crop')
                          ? (_openBlock(), _createElementBlock("div", _hoisted_194, [
                              _createElementVNode("img", {
                                src: _ctx.imgUrl(_ctx.modal.rec.data[f.key]),
                                class: "imgpreview lg"
                              }, null, 8 /* PROPS */, _hoisted_195)
                            ]))
                          : (f.type==='file')
                            ? (_openBlock(), _createElementBlock("div", _hoisted_196, [
                                _createElementVNode("span", _hoisted_197, _toDisplayString(_ctx.fileIcon(_ctx.modal.rec.data[f.key])), 1 /* TEXT */),
                                _createElementVNode("span", _hoisted_198, _toDisplayString(_ctx.fileName(_ctx.modal.rec.data[f.key])), 1 /* TEXT */),
                                _createElementVNode("button", {
                                  class: "btn sm",
                                  onClick: $event => (_ctx.openAttachment(_ctx.modal.rec.data[f.key]))
                                }, _toDisplayString(_ctx.t('Open')), 9 /* TEXT, PROPS */, _hoisted_199),
                                _createElementVNode("button", {
                                  class: "btn sm",
                                  onClick: $event => (_ctx.downloadAttachment(_ctx.modal.rec.data[f.key])),
                                  title: _ctx.t('Download')
                                }, "⬇", 8 /* PROPS */, _hoisted_200)
                              ]))
                            : (_openBlock(), _createElementBlock("div", _hoisted_201, [
                                (_ctx.linkFor(f, _ctx.modal.rec.data[f.key]))
                                  ? (_openBlock(), _createElementBlock("a", {
                                      key: 0,
                                      class: "val link",
                                      href: _ctx.linkFor(f, _ctx.modal.rec.data[f.key]),
                                      target: "_blank",
                                      rel: "noopener noreferrer"
                                    }, _toDisplayString(_ctx.displayVal(_ctx.modal.rec, f)), 9 /* TEXT, PROPS */, _hoisted_202))
                                  : (_openBlock(), _createElementBlock("span", {
                                      key: 1,
                                      class: _normalizeClass(["val", {mono: f.secret}])
                                    }, _toDisplayString(_ctx.displayVal(_ctx.modal.rec, f)), 3 /* TEXT, CLASS */)),
                                (f.secret && !_ctx.secretsMasked)
                                  ? (_openBlock(), _createElementBlock("button", {
                                      key: 2,
                                      class: "icon-btn",
                                      onClick: $event => (_ctx.toggleReveal(f.key))
                                    }, _toDisplayString(_ctx.reveal[f.key]?'🙈':'👁'), 9 /* TEXT, PROPS */, _hoisted_203))
                                  : _createCommentVNode("v-if", true),
                                (!(f.secret && _ctx.secretsMasked))
                                  ? (_openBlock(), _createElementBlock("button", {
                                      key: 3,
                                      class: "icon-btn",
                                      onClick: $event => (_ctx.copyVal(f.secret ? _ctx.openDecrypted[f.key] : _ctx.modal.rec.data[f.key])),
                                      title: _ctx.t('Copy')
                                    }, "⧉", 8 /* PROPS */, _hoisted_204))
                                  : _createCommentVNode("v-if", true)
                              ]))
                      ])), [
                        [_vShow, _ctx.modal.rec.data[f.key] != null && _ctx.modal.rec.data[f.key] !== '']
                      ])
                    }), 128 /* KEYED_FRAGMENT */))
                  ]),
                  _createElementVNode("div", _hoisted_205, [
                    (_ctx.canDelete)
                      ? (_openBlock(), _createElementBlock("button", {
                          key: 0,
                          class: "btn danger",
                          onClick: _cache[51] || (_cache[51] = $event => (_ctx.deleteRecord(_ctx.modal.rec)))
                        }, _toDisplayString(_ctx.t('Delete')), 1 /* TEXT */))
                      : _createCommentVNode("v-if", true),
                    _createElementVNode("button", {
                      class: "btn",
                      onClick: _cache[52] || (_cache[52] = $event => (_ctx.copyRecord(_ctx.modal.rec)))
                    }, _toDisplayString(_ctx.t('⧉ Copy all')), 1 /* TEXT */),
                    (_ctx.isOwner)
                      ? (_openBlock(), _createElementBlock("button", {
                          key: 1,
                          class: "btn",
                          onClick: _cache[53] || (_cache[53] = $event => (_ctx.openTransfer(_ctx.modal.rec)))
                        }, _toDisplayString(_ctx.t('↔ Move / Copy')), 1 /* TEXT */))
                      : _createCommentVNode("v-if", true),
                    (_ctx.canEdit)
                      ? (_openBlock(), _createElementBlock("button", {
                          key: 2,
                          class: "btn primary",
                          onClick: _cache[54] || (_cache[54] = $event => (_ctx.editRecord(_ctx.modal.rec)))
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
                onClick: _cache[66] || (_cache[66] = _withModifiers($event => (_ctx.modal=null), ["self"]))
              }, [
                _createElementVNode("div", _hoisted_206, [
                  _createElementVNode("div", _hoisted_207, [
                    _createElementVNode("h3", null, _toDisplayString(_ctx.schemaMode==='template' ? (_ctx.tplEdit.row_id || _ctx.tplEdit.builtin_key ? _ctx.t('✏️ Edit template') : _ctx.t('⭐ New template')) : _ctx.t('🧩 Design fields (form)')), 1 /* TEXT */),
                    _createElementVNode("button", {
                      class: "icon-btn",
                      onClick: _cache[56] || (_cache[56] = (...args) => (_ctx.closeSchemaEditor && _ctx.closeSchemaEditor(...args)))
                    }, "✕")
                  ]),
                  _createElementVNode("div", _hoisted_208, [
                    (_ctx.schemaMode==='template')
                      ? (_openBlock(), _createElementBlock("div", _hoisted_209, [
                          _createElementVNode("div", _hoisted_210, [
                            _createElementVNode("div", _hoisted_211, [
                              _createElementVNode("label", null, "🏷️ " + _toDisplayString(_ctx.t('Template name')), 1 /* TEXT */),
                              _withDirectives(_createElementVNode("input", {
                                "onUpdate:modelValue": _cache[57] || (_cache[57] = $event => ((_ctx.tplEdit.name) = $event))
                              }, null, 512 /* NEED_PATCH */), [
                                [_vModelText, _ctx.tplEdit.name]
                              ])
                            ]),
                            _createElementVNode("div", _hoisted_212, [
                              _createElementVNode("label", null, "🎨 " + _toDisplayString(_ctx.t('Color')), 1 /* TEXT */),
                              _withDirectives(_createElementVNode("input", {
                                type: "color",
                                "onUpdate:modelValue": _cache[58] || (_cache[58] = $event => ((_ctx.tplEdit.color) = $event)),
                                style: {"height":"44px","padding":"4px","width":"100%"}
                              }, null, 512 /* NEED_PATCH */), [
                                [_vModelText, _ctx.tplEdit.color]
                              ])
                            ])
                          ]),
                          _createElementVNode("div", _hoisted_213, [
                            _createElementVNode("div", _hoisted_214, [
                              _createElementVNode("label", null, "😀 " + _toDisplayString(_ctx.t('Icon')), 1 /* TEXT */),
                              _withDirectives(_createElementVNode("input", {
                                "onUpdate:modelValue": _cache[59] || (_cache[59] = $event => ((_ctx.tplEdit.icon) = $event)),
                                maxlength: "8",
                                placeholder: _ctx.t('Emoji')
                              }, null, 8 /* PROPS */, _hoisted_215), [
                                [_vModelText, _ctx.tplEdit.icon]
                              ])
                            ]),
                            _createElementVNode("div", _hoisted_216, [
                              _createElementVNode("label", null, "📝 " + _toDisplayString(_ctx.t('Description')), 1 /* TEXT */),
                              _withDirectives(_createElementVNode("input", {
                                "onUpdate:modelValue": _cache[60] || (_cache[60] = $event => ((_ctx.tplEdit.description) = $event))
                              }, null, 512 /* NEED_PATCH */), [
                                [_vModelText, _ctx.tplEdit.description]
                              ])
                            ])
                          ])
                        ]))
                      : _createCommentVNode("v-if", true),
                    _createElementVNode("p", _hoisted_217, _toDisplayString(_ctx.t('The fields you create here become the input form. ★ = the field used as the list title.')), 1 /* TEXT */),
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
                          onDragend: _cache[61] || (_cache[61] = (...args) => (_ctx.onFieldDragEnd && _ctx.onFieldDragEnd(...args))),
                          title: _ctx.t('Drag to reorder')
                        }, "⠿", 40 /* PROPS, NEED_HYDRATION */, _hoisted_219),
                        _withDirectives(_createElementVNode("input", {
                          "onUpdate:modelValue": $event => ((f.label) = $event),
                          placeholder: _ctx.t('Display name (e.g. Password)')
                        }, null, 8 /* PROPS */, _hoisted_220), [
                          [_vModelText, f.label]
                        ]),
                        _withDirectives(_createElementVNode("select", {
                          "onUpdate:modelValue": $event => ((f.type) = $event)
                        }, [
                          _createElementVNode("option", _hoisted_222, _toDisplayString(_ctx.t('Text')), 1 /* TEXT */),
                          _createElementVNode("option", _hoisted_223, _toDisplayString(_ctx.t('Multi-line text')), 1 /* TEXT */),
                          _createElementVNode("option", _hoisted_224, _toDisplayString(_ctx.t('Password')), 1 /* TEXT */),
                          _createElementVNode("option", _hoisted_225, _toDisplayString(_ctx.t('Numeric')), 1 /* TEXT */),
                          _createElementVNode("option", _hoisted_226, _toDisplayString(_ctx.t('Date')), 1 /* TEXT */),
                          _createElementVNode("option", _hoisted_227, _toDisplayString(_ctx.t('Year/Month')), 1 /* TEXT */),
                          _createElementVNode("option", _hoisted_228, _toDisplayString(_ctx.t('Email')), 1 /* TEXT */),
                          _hoisted_229,
                          _createElementVNode("option", _hoisted_230, _toDisplayString(_ctx.t('Phone number')), 1 /* TEXT */),
                          _createElementVNode("option", _hoisted_231, _toDisplayString(_ctx.t('Choices')), 1 /* TEXT */),
                          _createElementVNode("option", _hoisted_232, _toDisplayString(_ctx.t('Image (as-is / resize)')), 1 /* TEXT */),
                          _createElementVNode("option", _hoisted_233, _toDisplayString(_ctx.t('Image (crop)')), 1 /* TEXT */),
                          _createElementVNode("option", _hoisted_234, _toDisplayString(_ctx.t('File attachment (PDF/Word/Excel/ODF, notes)')), 1 /* TEXT */)
                        ], 8 /* PROPS */, _hoisted_221), [
                          [_vModelSelect, f.type]
                        ]),
                        _createElementVNode("div", _hoisted_235, [
                          _createElementVNode("button", {
                            class: "icon-btn",
                            onClick: $event => (_ctx.removeSchemaField(i)),
                            title: _ctx.t('Delete')
                          }, "🗑", 8 /* PROPS */, _hoisted_236)
                        ]),
                        (f.type==='select')
                          ? _withDirectives((_openBlock(), _createElementBlock("textarea", {
                              key: 0,
                              "onUpdate:modelValue": $event => ((f.options) = $event),
                              placeholder: _ctx.t('Enter choices, one per line'),
                              style: {"grid-column":"1/-1","min-height":"56px"}
                            }, null, 8 /* PROPS */, _hoisted_237)), [
                              [_vModelText, f.options]
                            ])
                          : _createCommentVNode("v-if", true),
                        (f.type==='image')
                          ? (_openBlock(), _createElementBlock("div", _hoisted_238, [
                              _createElementVNode("label", _hoisted_239, [
                                _withDirectives(_createElementVNode("input", {
                                  type: "checkbox",
                                  "onUpdate:modelValue": $event => ((f._orig) = $event)
                                }, null, 8 /* PROPS */, _hoisted_240), [
                                  [_vModelCheckbox, f._orig]
                                ]),
                                _createTextVNode(" " + _toDisplayString(_ctx.t('Save at original size (no processing)')), 1 /* TEXT */)
                              ]),
                              (!f._orig)
                                ? (_openBlock(), _createElementBlock("label", _hoisted_241, [
                                    _createTextVNode(_toDisplayString(_ctx.t('Max size')) + " ", 1 /* TEXT */),
                                    _withDirectives(_createElementVNode("input", {
                                      type: "number",
                                      min: "200",
                                      max: "6000",
                                      step: "100",
                                      "onUpdate:modelValue": $event => ((f._max) = $event)
                                    }, null, 8 /* PROPS */, _hoisted_242), [
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
                                ? (_openBlock(), _createElementBlock("label", _hoisted_243, [
                                    _createTextVNode(_toDisplayString(_ctx.t('Save format')) + " ", 1 /* TEXT */),
                                    _withDirectives(_createElementVNode("select", {
                                      "onUpdate:modelValue": $event => ((f._format) = $event)
                                    }, [
                                      _createElementVNode("option", _hoisted_245, _toDisplayString(_ctx.t('JPEG (lightweight)')), 1 /* TEXT */),
                                      _createElementVNode("option", _hoisted_246, _toDisplayString(_ctx.t('PNG (high quality, transparency)')), 1 /* TEXT */),
                                      _createElementVNode("option", _hoisted_247, _toDisplayString(_ctx.t('WebP (high compression)')), 1 /* TEXT */)
                                    ], 8 /* PROPS */, _hoisted_244), [
                                      [_vModelSelect, f._format]
                                    ])
                                  ]))
                                : _createCommentVNode("v-if", true)
                            ]))
                          : (f.type==='image_crop')
                            ? (_openBlock(), _createElementBlock("div", _hoisted_248, [
                                _createElementVNode("label", _hoisted_249, [
                                  _createTextVNode(_toDisplayString(_ctx.t('Ratio')) + " ", 1 /* TEXT */),
                                  _withDirectives(_createElementVNode("select", {
                                    "onUpdate:modelValue": $event => ((f._ratio) = $event)
                                  }, [
                                    _createElementVNode("option", _hoisted_251, _toDisplayString(_ctx.t('1:1 (square, portrait)')), 1 /* TEXT */),
                                    _createElementVNode("option", _hoisted_252, _toDisplayString(_ctx.t('3:4 (portrait)')), 1 /* TEXT */),
                                    _createElementVNode("option", _hoisted_253, _toDisplayString(_ctx.t('4:3 (landscape)')), 1 /* TEXT */),
                                    _createElementVNode("option", _hoisted_254, _toDisplayString(_ctx.t('16:9 (wide)')), 1 /* TEXT */),
                                    _createElementVNode("option", _hoisted_255, _toDisplayString(_ctx.t('Free')), 1 /* TEXT */)
                                  ], 8 /* PROPS */, _hoisted_250), [
                                    [_vModelSelect, f._ratio]
                                  ])
                                ]),
                                _createElementVNode("label", _hoisted_256, [
                                  _createTextVNode(_toDisplayString(_ctx.t('Output width')) + " ", 1 /* TEXT */),
                                  _withDirectives(_createElementVNode("input", {
                                    type: "number",
                                    min: "100",
                                    max: "4000",
                                    step: "50",
                                    "onUpdate:modelValue": $event => ((f._out) = $event)
                                  }, null, 8 /* PROPS */, _hoisted_257), [
                                    [
                                      _vModelText,
                                      f._out,
                                      void 0,
                                      { number: true }
                                    ]
                                  ]),
                                  _createTextVNode(" px")
                                ]),
                                _createElementVNode("label", _hoisted_258, [
                                  _createTextVNode(_toDisplayString(_ctx.t('Save format')) + " ", 1 /* TEXT */),
                                  _withDirectives(_createElementVNode("select", {
                                    "onUpdate:modelValue": $event => ((f._format) = $event)
                                  }, [
                                    _createElementVNode("option", _hoisted_260, _toDisplayString(_ctx.t('JPEG (lightweight)')), 1 /* TEXT */),
                                    _createElementVNode("option", _hoisted_261, _toDisplayString(_ctx.t('PNG (high quality, transparency)')), 1 /* TEXT */),
                                    _createElementVNode("option", _hoisted_262, _toDisplayString(_ctx.t('WebP (high compression)')), 1 /* TEXT */)
                                  ], 8 /* PROPS */, _hoisted_259), [
                                    [_vModelSelect, f._format]
                                  ])
                                ])
                              ]))
                            : _createCommentVNode("v-if", true),
                        (_ctx.ruleTypes.includes(f.type))
                          ? (_openBlock(), _createElementBlock("div", _hoisted_263, [
                              _createElementVNode("label", _hoisted_264, [
                                _createTextVNode(_toDisplayString(_ctx.t('Character type')) + " ", 1 /* TEXT */),
                                _withDirectives(_createElementVNode("select", {
                                  "onUpdate:modelValue": $event => ((f._charset) = $event)
                                }, [
                                  _createElementVNode("option", _hoisted_266, _toDisplayString(_ctx.t('No restriction')), 1 /* TEXT */),
                                  _createElementVNode("option", _hoisted_267, _toDisplayString(_ctx.t('Digits only (0-9)')), 1 /* TEXT */),
                                  _createElementVNode("option", _hoisted_268, _toDisplayString(_ctx.t('Alphanumeric')), 1 /* TEXT */),
                                  _createElementVNode("option", _hoisted_269, _toDisplayString(_ctx.t('Letters')), 1 /* TEXT */),
                                  _createElementVNode("option", _hoisted_270, _toDisplayString(_ctx.t('Hexadecimal')), 1 /* TEXT */),
                                  _createElementVNode("option", _hoisted_271, _toDisplayString(_ctx.t('ASCII (incl. symbols)')), 1 /* TEXT */),
                                  _createElementVNode("option", _hoisted_272, _toDisplayString(_ctx.t('Phone number (digits, +-() )')), 1 /* TEXT */),
                                  _createElementVNode("option", _hoisted_273, _toDisplayString(_ctx.t('Custom (regex)')), 1 /* TEXT */)
                                ], 8 /* PROPS */, _hoisted_265), [
                                  [_vModelSelect, f._charset]
                                ])
                              ]),
                              (f._charset==='custom')
                                ? (_openBlock(), _createElementBlock("label", _hoisted_274, [
                                    _createTextVNode(_toDisplayString(_ctx.t('Pattern')) + " ", 1 /* TEXT */),
                                    _withDirectives(_createElementVNode("input", {
                                      "onUpdate:modelValue": $event => ((f._pattern) = $event),
                                      placeholder: _ctx.t('e.g. [0-9]{3}-[0-9]{4}'),
                                      style: {"min-width":"150px"}
                                    }, null, 8 /* PROPS */, _hoisted_275), [
                                      [_vModelText, f._pattern]
                                    ])
                                  ]))
                                : _createCommentVNode("v-if", true),
                              _createElementVNode("label", _hoisted_276, [
                                _createTextVNode(_toDisplayString(_ctx.t('Min')) + " ", 1 /* TEXT */),
                                _withDirectives(_createElementVNode("input", {
                                  type: "number",
                                  min: "0",
                                  max: "9999",
                                  "onUpdate:modelValue": $event => ((f._rmin) = $event),
                                  style: {"width":"66px"}
                                }, null, 8 /* PROPS */, _hoisted_277), [
                                  [
                                    _vModelText,
                                    f._rmin,
                                    void 0,
                                    { number: true }
                                  ]
                                ]),
                                _createTextVNode(" " + _toDisplayString(_ctx.t('chars')), 1 /* TEXT */)
                              ]),
                              _createElementVNode("label", _hoisted_278, [
                                _createTextVNode(_toDisplayString(_ctx.t('Max')) + " ", 1 /* TEXT */),
                                _withDirectives(_createElementVNode("input", {
                                  type: "number",
                                  min: "0",
                                  max: "99999",
                                  "onUpdate:modelValue": $event => ((f._rmax) = $event),
                                  style: {"width":"74px"}
                                }, null, 8 /* PROPS */, _hoisted_279), [
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
                        _createElementVNode("div", _hoisted_280, [
                          _createElementVNode("label", null, [
                            _createElementVNode("input", {
                              type: "checkbox",
                              checked: f.is_title,
                              onChange: $event => (_ctx.setTitleField(i))
                            }, null, 40 /* PROPS, NEED_HYDRATION */, _hoisted_281),
                            _createTextVNode(" " + _toDisplayString(_ctx.t('★ Title')), 1 /* TEXT */)
                          ]),
                          _createElementVNode("label", null, [
                            _withDirectives(_createElementVNode("input", {
                              type: "checkbox",
                              "onUpdate:modelValue": $event => ((f.required) = $event)
                            }, null, 8 /* PROPS */, _hoisted_282), [
                              [_vModelCheckbox, f.required]
                            ]),
                            _createTextVNode(" " + _toDisplayString(_ctx.t('Required')), 1 /* TEXT */)
                          ]),
                          _createElementVNode("label", null, [
                            _withDirectives(_createElementVNode("input", {
                              type: "checkbox",
                              "onUpdate:modelValue": $event => ((f.secret) = $event)
                            }, null, 8 /* PROPS */, _hoisted_283), [
                              [_vModelCheckbox, f.secret]
                            ]),
                            _createTextVNode(" " + _toDisplayString(_ctx.t('Secret (masked)')), 1 /* TEXT */)
                          ])
                        ])
                      ], 42 /* CLASS, PROPS, NEED_HYDRATION */, _hoisted_218))
                    }), 128 /* KEYED_FRAGMENT */)),
                    _createElementVNode("button", {
                      class: "btn block",
                      onClick: _cache[62] || (_cache[62] = (...args) => (_ctx.addSchemaField && _ctx.addSchemaField(...args)))
                    }, _toDisplayString(_ctx.t('＋ Add field')), 1 /* TEXT */)
                  ]),
                  _createElementVNode("div", _hoisted_284, [
                    _createElementVNode("button", {
                      class: "btn",
                      onClick: _cache[63] || (_cache[63] = (...args) => (_ctx.closeSchemaEditor && _ctx.closeSchemaEditor(...args)))
                    }, _toDisplayString(_ctx.t('Cancel')), 1 /* TEXT */),
                    (_ctx.schemaMode==='template')
                      ? (_openBlock(), _createElementBlock("button", {
                          key: 0,
                          class: "btn primary",
                          onClick: _cache[64] || (_cache[64] = (...args) => (_ctx.saveTemplate && _ctx.saveTemplate(...args)))
                        }, _toDisplayString(_ctx.t('Save template')), 1 /* TEXT */))
                      : (_openBlock(), _createElementBlock("button", {
                          key: 1,
                          class: "btn primary",
                          onClick: _cache[65] || (_cache[65] = (...args) => (_ctx.saveSchema && _ctx.saveSchema(...args)))
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
                onClick: _cache[72] || (_cache[72] = _withModifiers($event => (_ctx.modal=null), ["self"]))
              }, [
                _createElementVNode("div", _hoisted_285, [
                  _createElementVNode("div", _hoisted_286, [
                    _createElementVNode("h3", null, _toDisplayString(_ctx.t('📄 Duplicate collection')), 1 /* TEXT */),
                    _createElementVNode("button", {
                      class: "icon-btn",
                      onClick: _cache[67] || (_cache[67] = $event => (_ctx.modal=null))
                    }, "✕")
                  ]),
                  _createElementVNode("div", _hoisted_287, [
                    _createElementVNode("div", _hoisted_288, [
                      _createElementVNode("label", null, "🏷️ " + _toDisplayString(_ctx.t('New name')), 1 /* TEXT */),
                      _withDirectives(_createElementVNode("input", {
                        "onUpdate:modelValue": _cache[68] || (_cache[68] = $event => ((_ctx.dupForm.name) = $event))
                      }, null, 512 /* NEED_PATCH */), [
                        [_vModelText, _ctx.dupForm.name]
                      ])
                    ]),
                    _createElementVNode("label", _hoisted_289, [
                      _withDirectives(_createElementVNode("input", {
                        type: "checkbox",
                        "onUpdate:modelValue": _cache[69] || (_cache[69] = $event => ((_ctx.dupForm.withRecords) = $event))
                      }, null, 512 /* NEED_PATCH */), [
                        [_vModelCheckbox, _ctx.dupForm.withRecords]
                      ]),
                      _createTextVNode(" " + _toDisplayString(_ctx.t('Also duplicate the records (data)')), 1 /* TEXT */)
                    ]),
                    _createElementVNode("div", _hoisted_290, _toDisplayString(_ctx.t('Unchecked: an empty copy with the same fields. Checked: also copies every record and its attachments.')), 1 /* TEXT */)
                  ]),
                  _createElementVNode("div", _hoisted_291, [
                    _createElementVNode("button", {
                      type: "button",
                      class: "btn",
                      onClick: _cache[70] || (_cache[70] = $event => (_ctx.modal=null))
                    }, _toDisplayString(_ctx.t('Cancel')), 1 /* TEXT */),
                    _createElementVNode("button", {
                      type: "button",
                      class: "btn primary",
                      disabled: _ctx.dupForm.busy || !_ctx.dupForm.name.trim(),
                      onClick: _cache[71] || (_cache[71] = (...args) => (_ctx.commitDuplicate && _ctx.commitDuplicate(...args)))
                    }, _toDisplayString(_ctx.t('Duplicate')), 9 /* TEXT, PROPS */, _hoisted_292)
                  ])
                ])
              ]))
            : _createCommentVNode("v-if", true),
          _createCommentVNode(" Reorder records (registration order) "),
          (_ctx.modal && _ctx.modal.type==='reorder')
            ? (_openBlock(), _createElementBlock("div", {
                key: 5,
                class: "modal-mask",
                onClick: _cache[79] || (_cache[79] = _withModifiers($event => (_ctx.modal=null), ["self"]))
              }, [
                _createElementVNode("div", _hoisted_293, [
                  _createElementVNode("div", _hoisted_294, [
                    _createElementVNode("h3", null, _toDisplayString(_ctx.t('⇅ Edit the saved record order')), 1 /* TEXT */),
                    _createElementVNode("button", {
                      class: "icon-btn",
                      onClick: _cache[73] || (_cache[73] = $event => (_ctx.modal=null))
                    }, "✕")
                  ]),
                  _createElementVNode("div", _hoisted_295, [
                    _createElementVNode("p", _hoisted_296, _toDisplayString(_ctx.t('This rewrites the records’ saved registration order (not just the on-screen view). Sort by up to 5 fields, and/or drag rows by hand. The result is what you’ll see in “Registration order”.')), 1 /* TEXT */),
                    (_ctx.reorderFields.length)
                      ? (_openBlock(), _createElementBlock("div", _hoisted_297, [
                          _createElementVNode("div", _hoisted_298, _toDisplayString(_ctx.t('Sort by fields (top = highest priority)')), 1 /* TEXT */),
                          (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.reorder.keys, (k, ki) => {
                            return (_openBlock(), _createElementBlock("div", {
                              key: ki,
                              class: "reorder-keyrow"
                            }, [
                              _createElementVNode("span", _hoisted_299, _toDisplayString(ki + 1), 1 /* TEXT */),
                              _withDirectives(_createElementVNode("select", {
                                "onUpdate:modelValue": $event => ((k.field) = $event),
                                class: "reorder-keysel"
                              }, [
                                _createElementVNode("option", _hoisted_301, _toDisplayString(_ctx.t('— none —')), 1 /* TEXT */),
                                (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.reorderFields, (f) => {
                                  return (_openBlock(), _createElementBlock("option", {
                                    key: f.key,
                                    value: f.key
                                  }, _toDisplayString(f.label), 9 /* TEXT, PROPS */, _hoisted_302))
                                }), 128 /* KEYED_FRAGMENT */))
                              ], 8 /* PROPS */, _hoisted_300), [
                                [_vModelSelect, k.field]
                              ]),
                              _withDirectives(_createElementVNode("select", {
                                "onUpdate:modelValue": $event => ((k.dir) = $event),
                                class: "reorder-keydir"
                              }, [
                                _createElementVNode("option", _hoisted_304, _toDisplayString(_ctx.t('Ascending')), 1 /* TEXT */),
                                _createElementVNode("option", _hoisted_305, _toDisplayString(_ctx.t('Descending')), 1 /* TEXT */)
                              ], 8 /* PROPS */, _hoisted_303), [
                                [_vModelSelect, k.dir]
                              ]),
                              (_ctx.reorder.keys.length>1)
                                ? (_openBlock(), _createElementBlock("button", {
                                    key: 0,
                                    type: "button",
                                    class: "icon-btn",
                                    onClick: $event => (_ctx.removeReorderKey(ki)),
                                    title: _ctx.t('Remove')
                                  }, "✕", 8 /* PROPS */, _hoisted_306))
                                : _createCommentVNode("v-if", true)
                            ]))
                          }), 128 /* KEYED_FRAGMENT */)),
                          _createElementVNode("div", _hoisted_307, [
                            (_ctx.reorder.keys.length<5)
                              ? (_openBlock(), _createElementBlock("button", {
                                  key: 0,
                                  type: "button",
                                  class: "btn sm ghost",
                                  onClick: _cache[74] || (_cache[74] = (...args) => (_ctx.addReorderKey && _ctx.addReorderKey(...args)))
                                }, "＋ " + _toDisplayString(_ctx.t('Add a sort key')), 1 /* TEXT */))
                              : _createCommentVNode("v-if", true),
                            _createElementVNode("button", {
                              type: "button",
                              class: "btn sm",
                              disabled: !_ctx.reorder.keys.some(k=>k.field),
                              onClick: _cache[75] || (_cache[75] = (...args) => (_ctx.applyReorderSort && _ctx.applyReorderSort(...args)))
                            }, "↕ " + _toDisplayString(_ctx.t('Sort now')), 9 /* TEXT, PROPS */, _hoisted_308)
                          ])
                        ]))
                      : _createCommentVNode("v-if", true),
                    _createElementVNode("div", _hoisted_309, _toDisplayString(_ctx.t('Order preview ({n} records) — drag to fine-tune', {n: _ctx.reorder.list.length})), 1 /* TEXT */),
                    _createElementVNode("div", _hoisted_310, [
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
                            onDragend: _cache[76] || (_cache[76] = (...args) => (_ctx.rDragEnd && _ctx.rDragEnd(...args))),
                            title: _ctx.t('Drag to reorder')
                          }, "⠿", 40 /* PROPS, NEED_HYDRATION */, _hoisted_312),
                          _createElementVNode("span", _hoisted_313, _toDisplayString(i + 1), 1 /* TEXT */),
                          _createElementVNode("span", _hoisted_314, [
                            _createElementVNode("span", _hoisted_315, _toDisplayString(_ctx.reorderTitle(r)), 1 /* TEXT */),
                            (_ctx.reorderRowSummary(r))
                              ? (_openBlock(), _createElementBlock("span", _hoisted_316, _toDisplayString(_ctx.reorderRowSummary(r)), 1 /* TEXT */))
                              : _createCommentVNode("v-if", true)
                          ])
                        ], 42 /* CLASS, PROPS, NEED_HYDRATION */, _hoisted_311))
                      }), 128 /* KEYED_FRAGMENT */))
                    ])
                  ]),
                  _createElementVNode("div", _hoisted_317, [
                    _createElementVNode("button", {
                      type: "button",
                      class: "btn",
                      onClick: _cache[77] || (_cache[77] = $event => (_ctx.modal=null))
                    }, _toDisplayString(_ctx.t('Cancel')), 1 /* TEXT */),
                    _createElementVNode("button", {
                      type: "button",
                      class: "btn primary",
                      disabled: _ctx.reorder.busy,
                      onClick: _cache[78] || (_cache[78] = (...args) => (_ctx.saveReorder && _ctx.saveReorder(...args)))
                    }, _toDisplayString(_ctx.t('Save order')), 9 /* TEXT, PROPS */, _hoisted_318)
                  ])
                ])
              ]))
            : _createCommentVNode("v-if", true),
          _createCommentVNode(" Collection settings "),
          (_ctx.modal && _ctx.modal.type==='collSettings')
            ? (_openBlock(), _createElementBlock("div", {
                key: 6,
                class: "modal-mask",
                onClick: _cache[106] || (_cache[106] = _withModifiers($event => (_ctx.modal=null), ["self"]))
              }, [
                _createElementVNode("div", _hoisted_319, [
                  _createElementVNode("div", _hoisted_320, [
                    _createElementVNode("h3", null, _toDisplayString(_ctx.t('⚙️ Collection settings')), 1 /* TEXT */),
                    _createElementVNode("button", {
                      class: "icon-btn",
                      onClick: _cache[80] || (_cache[80] = $event => (_ctx.modal=null))
                    }, "✕")
                  ]),
                  _createElementVNode("div", _hoisted_321, [
                    (!_ctx.isOwner)
                      ? (_openBlock(), _createElementBlock("div", _hoisted_322, _toDisplayString(_ctx.shareAccessNote), 1 /* TEXT */))
                      : _createCommentVNode("v-if", true),
                    (_ctx.canSettings)
                      ? (_openBlock(), _createElementBlock(_Fragment, { key: 1 }, [
                          _createElementVNode("div", _hoisted_323, [
                            _createElementVNode("label", null, "🏷️ " + _toDisplayString(_ctx.t('Name')), 1 /* TEXT */),
                            _withDirectives(_createElementVNode("input", {
                              "onUpdate:modelValue": _cache[81] || (_cache[81] = $event => ((_ctx.collForm.name) = $event))
                            }, null, 512 /* NEED_PATCH */), [
                              [_vModelText, _ctx.collForm.name]
                            ])
                          ]),
                          _createElementVNode("div", _hoisted_324, [
                            _createElementVNode("label", null, "📝 " + _toDisplayString(_ctx.t('Description')), 1 /* TEXT */),
                            _withDirectives(_createElementVNode("textarea", {
                              "onUpdate:modelValue": _cache[82] || (_cache[82] = $event => ((_ctx.collForm.description) = $event)),
                              placeholder: _ctx.t('Description of this collection (shown on the home screen card)')
                            }, null, 8 /* PROPS */, _hoisted_325), [
                              [_vModelText, _ctx.collForm.description]
                            ])
                          ]),
                          _createElementVNode("div", _hoisted_326, [
                            _createElementVNode("div", _hoisted_327, [
                              _createElementVNode("label", null, "🎨 " + _toDisplayString(_ctx.t('Color')), 1 /* TEXT */),
                              _withDirectives(_createElementVNode("input", {
                                type: "color",
                                "onUpdate:modelValue": _cache[83] || (_cache[83] = $event => ((_ctx.collForm.color) = $event)),
                                style: {"height":"44px","padding":"4px","width":"100%"}
                              }, null, 512 /* NEED_PATCH */), [
                                [_vModelText, _ctx.collForm.color]
                              ])
                            ]),
                            _createElementVNode("div", _hoisted_328, [
                              _createElementVNode("label", null, "😀 " + _toDisplayString(_ctx.t('Icon')), 1 /* TEXT */),
                              _createElementVNode("div", _hoisted_329, [
                                _createElementVNode("button", {
                                  type: "button",
                                  class: _normalizeClass(["iconpick-cur", {open: _ctx.iconPickerOpen}]),
                                  onClick: _cache[84] || (_cache[84] = _withModifiers($event => (_ctx.iconPickerOpen = !_ctx.iconPickerOpen), ["stop"])),
                                  title: _ctx.t('Click to choose an icon')
                                }, _toDisplayString(_ctx.collForm.icon || '🗂️'), 11 /* TEXT, CLASS, PROPS */, _hoisted_330),
                                _withDirectives(_createElementVNode("input", {
                                  "onUpdate:modelValue": _cache[85] || (_cache[85] = $event => ((_ctx.collForm.icon) = $event)),
                                  maxlength: "8",
                                  placeholder: _ctx.t('Emoji')
                                }, null, 8 /* PROPS */, _hoisted_331), [
                                  [_vModelText, _ctx.collForm.icon]
                                ]),
                                (_ctx.iconPickerOpen)
                                  ? (_openBlock(), _createElementBlock("div", {
                                      key: 0,
                                      class: "emoji-popup",
                                      onClick: _cache[86] || (_cache[86] = _withModifiers(() => {}, ["stop"]))
                                    }, [
                                      _createElementVNode("div", _hoisted_332, [
                                        (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.iconGroupsAll, (g) => {
                                          return (_openBlock(), _createElementBlock("div", {
                                            class: "emoji-group",
                                            key: g.key
                                          }, [
                                            _createElementVNode("div", _hoisted_333, _toDisplayString(_ctx.t(g.key)), 1 /* TEXT */),
                                            _createElementVNode("div", _hoisted_334, [
                                              (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(g.emojis, (em) => {
                                                return (_openBlock(), _createElementBlock("button", {
                                                  type: "button",
                                                  class: _normalizeClass(["emoji-btn", {sel: _ctx.collForm.icon===em}]),
                                                  key: em,
                                                  onClick: $event => {_ctx.collForm.icon = em; _ctx.iconPickerOpen = false},
                                                  title: em
                                                }, _toDisplayString(em), 11 /* TEXT, CLASS, PROPS */, _hoisted_335))
                                              }), 128 /* KEYED_FRAGMENT */))
                                            ])
                                          ]))
                                        }), 128 /* KEYED_FRAGMENT */))
                                      ])
                                    ]))
                                  : _createCommentVNode("v-if", true)
                              ]),
                              (_ctx.iconPickerOpen)
                                ? (_openBlock(), _createElementBlock("div", {
                                    key: 0,
                                    class: "perm-backdrop",
                                    onClick: _cache[87] || (_cache[87] = $event => (_ctx.iconPickerOpen = false))
                                  }))
                                : _createCommentVNode("v-if", true)
                            ])
                          ])
                        ], 64 /* STABLE_FRAGMENT */))
                      : _createCommentVNode("v-if", true),
                    (_ctx.isOwner)
                      ? (_openBlock(), _createElementBlock("div", {
                          key: 2,
                          class: _normalizeClass(["field share-section", {open: _ctx.shareExpanded}])
                        }, [
                          _createElementVNode("button", {
                            type: "button",
                            class: "share-toggle",
                            "aria-expanded": _ctx.shareExpanded ? 'true' : 'false',
                            onClick: _cache[88] || (_cache[88] = $event => (_ctx.shareExpanded = !_ctx.shareExpanded))
                          }, [
                            _createElementVNode("span", _hoisted_337, "👥 " + _toDisplayString(_ctx.t('Share settings')), 1 /* TEXT */),
                            _createElementVNode("span", _hoisted_338, [
                              _createElementVNode("span", _hoisted_339, _toDisplayString(_ctx.shareExpanded ? '▼' : '▶'), 1 /* TEXT */),
                              (!_ctx.shareExpanded)
                                ? (_openBlock(), _createElementBlock("span", _hoisted_340, _toDisplayString(_ctx.t('Click to expand')), 1 /* TEXT */))
                                : _createCommentVNode("v-if", true)
                            ]),
                            (_ctx.sharePanel.shares.length)
                              ? (_openBlock(), _createElementBlock("span", _hoisted_341, _toDisplayString(_ctx.sharePanel.shares.length), 1 /* TEXT */))
                              : _createCommentVNode("v-if", true)
                          ], 8 /* PROPS */, _hoisted_336),
                          _withDirectives(_createElementVNode("div", _hoisted_342, [
                            (_ctx.sharePanel.shares.length)
                              ? (_openBlock(), _createElementBlock("div", _hoisted_343, [
                                  (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.sharePanel.shares, (s) => {
                                    return (_openBlock(), _createElementBlock("div", {
                                      key: s.recipient_uid,
                                      class: "share-row"
                                    }, [
                                      _createElementVNode("span", _hoisted_344, _toDisplayString(s.recipient_name || s.recipient_uid), 1 /* TEXT */),
                                      _createElementVNode("select", {
                                        class: "share-perm",
                                        value: s.perm,
                                        onChange: $event => (_ctx.changeSharePerm(s, $event.target.value))
                                      }, [
                                        _createElementVNode("option", _hoisted_346, _toDisplayString(_ctx.t('View')), 1 /* TEXT */),
                                        _createElementVNode("option", _hoisted_347, _toDisplayString(_ctx.t('Edit')), 1 /* TEXT */),
                                        _createElementVNode("option", _hoisted_348, _toDisplayString(_ctx.t('Delete')), 1 /* TEXT */)
                                      ], 40 /* PROPS, NEED_HYDRATION */, _hoisted_345),
                                      (s.has_password)
                                        ? (_openBlock(), _createElementBlock("span", {
                                            key: 0,
                                            class: "share-flag",
                                            title: _ctx.t('Password protected')
                                          }, "🔑", 8 /* PROPS */, _hoisted_349))
                                        : _createCommentVNode("v-if", true),
                                      (s.shares_secrets)
                                        ? (_openBlock(), _createElementBlock("span", {
                                            key: 1,
                                            class: "share-flag",
                                            title: _ctx.t('Secret fields shared')
                                          }, "🔓", 8 /* PROPS */, _hoisted_350))
                                        : _createCommentVNode("v-if", true),
                                      _createElementVNode("button", {
                                        type: "button",
                                        class: "icon-btn",
                                        onClick: $event => (_ctx.removeShare(s)),
                                        title: _ctx.t('Remove share')
                                      }, "🗑", 8 /* PROPS */, _hoisted_351)
                                    ]))
                                  }), 128 /* KEYED_FRAGMENT */))
                                ]))
                              : _createCommentVNode("v-if", true),
                            _createElementVNode("div", _hoisted_352, [
                              _createElementVNode("div", _hoisted_353, [
                                (!_ctx.sharePanel.recipient)
                                  ? (_openBlock(), _createElementBlock("div", _hoisted_354, [
                                      _withDirectives(_createElementVNode("input", {
                                        "onUpdate:modelValue": _cache[89] || (_cache[89] = $event => ((_ctx.sharePanel.q) = $event)),
                                        onInput: _cache[90] || (_cache[90] = (...args) => (_ctx.searchShareUsers && _ctx.searchShareUsers(...args))),
                                        placeholder: _ctx.t('Search users to share with…'),
                                        autocomplete: "off"
                                      }, null, 40 /* PROPS, NEED_HYDRATION */, _hoisted_355), [
                                        [_vModelText, _ctx.sharePanel.q]
                                      ]),
                                      (_ctx.sharePanel.results.length)
                                        ? (_openBlock(), _createElementBlock("div", _hoisted_356, [
                                            (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.sharePanel.results, (u) => {
                                              return (_openBlock(), _createElementBlock("button", {
                                                type: "button",
                                                key: u.uid,
                                                class: "share-result",
                                                onClick: $event => (_ctx.pickShareUser(u))
                                              }, [
                                                _createTextVNode(_toDisplayString(u.name) + " ", 1 /* TEXT */),
                                                _createElementVNode("span", _hoisted_358, "(" + _toDisplayString(u.uid) + ")", 1 /* TEXT */)
                                              ], 8 /* PROPS */, _hoisted_357))
                                            }), 128 /* KEYED_FRAGMENT */))
                                          ]))
                                        : _createCommentVNode("v-if", true)
                                    ]))
                                  : (_openBlock(), _createElementBlock("div", _hoisted_359, [
                                      _createElementVNode("span", _hoisted_360, [
                                        _createTextVNode(_toDisplayString(_ctx.sharePanel.recipientName) + " ", 1 /* TEXT */),
                                        _createElementVNode("span", _hoisted_361, "(" + _toDisplayString(_ctx.sharePanel.recipient) + ")", 1 /* TEXT */)
                                      ]),
                                      _createElementVNode("button", {
                                        type: "button",
                                        class: "icon-btn",
                                        onClick: _cache[91] || (_cache[91] = (...args) => (_ctx.clearShareRecipient && _ctx.clearShareRecipient(...args)))
                                      }, "✕")
                                    ])),
                                _createElementVNode("div", {
                                  class: _normalizeClass(["perm-wrap", {open: _ctx.permOpen}]),
                                  title: _ctx.t('Permission'),
                                  onClick: _cache[93] || (_cache[93] = _withModifiers($event => (_ctx.permOpen = !_ctx.permOpen), ["stop"]))
                                }, [
                                  _createElementVNode("span", _hoisted_363, _toDisplayString(_ctx.permLabel), 1 /* TEXT */),
                                  _hoisted_364,
                                  (_ctx.permOpen)
                                    ? (_openBlock(), _createElementBlock("div", {
                                        key: 0,
                                        class: "perm-menu",
                                        onClick: _cache[92] || (_cache[92] = _withModifiers(() => {}, ["stop"]))
                                      }, [
                                        (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.permOptions, (o) => {
                                          return (_openBlock(), _createElementBlock("button", {
                                            type: "button",
                                            key: o.v,
                                            class: _normalizeClass(["perm-opt", {sel: _ctx.sharePanel.perm === o.v}]),
                                            onClick: $event => {_ctx.sharePanel.perm = o.v; _ctx.permOpen = false}
                                          }, _toDisplayString(o.label), 11 /* TEXT, CLASS, PROPS */, _hoisted_365))
                                        }), 128 /* KEYED_FRAGMENT */))
                                      ]))
                                    : _createCommentVNode("v-if", true)
                                ], 10 /* CLASS, PROPS */, _hoisted_362),
                                (_ctx.permOpen)
                                  ? (_openBlock(), _createElementBlock("div", {
                                      key: 2,
                                      class: "perm-backdrop",
                                      onClick: _cache[94] || (_cache[94] = $event => (_ctx.permOpen = false))
                                    }))
                                  : _createCommentVNode("v-if", true)
                              ]),
                              _createElementVNode("div", _hoisted_366, [
                                _createElementVNode("div", _hoisted_367, [
                                  _createElementVNode("span", _hoisted_368, _toDisplayString(_ctx.t('Share password (optional)')), 1 /* TEXT */),
                                  _withDirectives(_createElementVNode("input", {
                                    "onUpdate:modelValue": _cache[95] || (_cache[95] = $event => ((_ctx.sharePanel.password) = $event)),
                                    type: "text",
                                    placeholder: _ctx.t('Blank = no password'),
                                    autocomplete: "off",
                                    "data-1p-ignore": "",
                                    "data-lpignore": "true"
                                  }, null, 8 /* PROPS */, _hoisted_369), [
                                    [_vModelText, _ctx.sharePanel.password]
                                  ])
                                ]),
                                (_ctx.collectionHasSecret && _ctx.enc.enabled)
                                  ? (_openBlock(), _createElementBlock("div", _hoisted_370, [
                                      _createElementVNode("span", _hoisted_371, _toDisplayString(_ctx.t('Show secret fields to the recipient')), 1 /* TEXT */),
                                      _withDirectives(_createElementVNode("input", {
                                        "onUpdate:modelValue": _cache[96] || (_cache[96] = $event => ((_ctx.sharePanel.master) = $event)),
                                        type: "password",
                                        placeholder: _ctx.t('Your master password (blank = keep secrets hidden)'),
                                        autocomplete: "off",
                                        "data-1p-ignore": "",
                                        "data-lpignore": "true"
                                      }, null, 8 /* PROPS */, _hoisted_372), [
                                        [_vModelText, _ctx.sharePanel.master]
                                      ]),
                                      _createElementVNode("div", _hoisted_373, _toDisplayString(_ctx.t('Requires a share password (used to protect the key). Secrets stay masked without it.')), 1 /* TEXT */)
                                    ]))
                                  : _createCommentVNode("v-if", true)
                              ]),
                              (_ctx.sharePanel.err)
                                ? (_openBlock(), _createElementBlock("div", _hoisted_374, _toDisplayString(_ctx.sharePanel.err), 1 /* TEXT */))
                                : _createCommentVNode("v-if", true),
                              _createElementVNode("button", {
                                type: "button",
                                class: "btn sm primary",
                                disabled: !_ctx.sharePanel.recipient || _ctx.sharePanel.busy,
                                onClick: _cache[97] || (_cache[97] = (...args) => (_ctx.addShare && _ctx.addShare(...args)))
                              }, _toDisplayString(_ctx.t('Share')), 9 /* TEXT, PROPS */, _hoisted_375)
                            ])
                          ], 512 /* NEED_PATCH */), [
                            [_vShow, _ctx.shareExpanded]
                          ])
                        ], 2 /* CLASS */))
                      : _createCommentVNode("v-if", true),
                    (_ctx.isOwner)
                      ? (_openBlock(), _createElementBlock("div", _hoisted_376, [
                          _createElementVNode("label", null, "📄 " + _toDisplayString(_ctx.t('Duplicate / template')), 1 /* TEXT */),
                          _createElementVNode("div", _hoisted_377, [
                            _createElementVNode("button", {
                              type: "button",
                              class: "btn sm",
                              onClick: _cache[98] || (_cache[98] = (...args) => (_ctx.openDuplicate && _ctx.openDuplicate(...args)))
                            }, _toDisplayString(_ctx.t('📄 Duplicate collection')), 1 /* TEXT */),
                            _createElementVNode("button", {
                              type: "button",
                              class: "btn sm",
                              onClick: _cache[99] || (_cache[99] = (...args) => (_ctx.saveAsTemplate && _ctx.saveAsTemplate(...args)))
                            }, _toDisplayString(_ctx.t('⭐ Save as template')), 1 /* TEXT */)
                          ]),
                          _createElementVNode("div", _hoisted_378, _toDisplayString(_ctx.t('Duplicate copies the fields (optionally the records). Save as template adds it to the New collection picker.')), 1 /* TEXT */)
                        ]))
                      : _createCommentVNode("v-if", true),
                    _createElementVNode("div", _hoisted_379, [
                      _createElementVNode("label", null, "📤 " + _toDisplayString(_ctx.t('Export (all records in this collection)')), 1 /* TEXT */),
                      _createElementVNode("div", _hoisted_380, [
                        _createElementVNode("button", {
                          type: "button",
                          class: "btn sm",
                          onClick: _cache[100] || (_cache[100] = $event => (_ctx.exportCollection('csv')))
                        }, _toDisplayString(_ctx.t('⬇ Export as CSV')), 1 /* TEXT */),
                        _createElementVNode("button", {
                          type: "button",
                          class: "btn sm",
                          onClick: _cache[101] || (_cache[101] = $event => (_ctx.exportCollection('json')))
                        }, _toDisplayString(_ctx.t('⬇ Export as JSON')), 1 /* TEXT */),
                        _createElementVNode("button", {
                          type: "button",
                          class: "btn sm",
                          disabled: _ctx.tablesExportBusy || !_ctx.apps.tables,
                          title: _ctx.apps.tables ? '' : _ctx.t('The Tables app is not enabled'),
                          onClick: _cache[102] || (_cache[102] = (...args) => (_ctx.exportToTables && _ctx.exportToTables(...args)))
                        }, _toDisplayString(_ctx.t('📊 Export to Tables')), 9 /* TEXT, PROPS */, _hoisted_381)
                      ]),
                      _createElementVNode("div", _hoisted_382, _toDisplayString(_ctx.t('JSON includes field definitions and can be re-imported into RegiBase directly.')), 1 /* TEXT */),
                      _createElementVNode("div", _hoisted_383, _toDisplayString(_ctx.t('Export to Tables creates a new table. Secret and attachment fields are skipped.')), 1 /* TEXT */)
                    ])
                  ]),
                  _createElementVNode("div", _hoisted_384, [
                    (_ctx.isOwner)
                      ? (_openBlock(), _createElementBlock("button", {
                          key: 0,
                          class: "btn danger foot-left",
                          onClick: _cache[103] || (_cache[103] = (...args) => (_ctx.deleteCollection && _ctx.deleteCollection(...args)))
                        }, _toDisplayString(_ctx.t('Delete collection')), 1 /* TEXT */))
                      : _createCommentVNode("v-if", true),
                    _createElementVNode("button", {
                      type: "button",
                      class: "btn",
                      onClick: _cache[104] || (_cache[104] = $event => (_ctx.modal=null))
                    }, _toDisplayString(_ctx.t('Cancel')), 1 /* TEXT */),
                    (_ctx.canSettings)
                      ? (_openBlock(), _createElementBlock("button", {
                          key: 1,
                          class: "btn primary",
                          onClick: _cache[105] || (_cache[105] = (...args) => (_ctx.saveCollSettings && _ctx.saveCollSettings(...args)))
                        }, _toDisplayString(_ctx.t('Save')), 1 /* TEXT */))
                      : _createCommentVNode("v-if", true)
                  ])
                ])
              ]))
            : _createCommentVNode("v-if", true),
          _createCommentVNode(" Shared collection unlock (share password) "),
          (_ctx.shareUnlock.open)
            ? (_openBlock(), _createElementBlock("div", {
                key: 7,
                class: "modal-mask",
                onClick: _cache[112] || (_cache[112] = _withModifiers((...args) => (_ctx.cancelShareUnlock && _ctx.cancelShareUnlock(...args)), ["self"]))
              }, [
                _createElementVNode("div", _hoisted_385, [
                  _createElementVNode("div", _hoisted_386, [
                    _createElementVNode("h3", null, _toDisplayString(_ctx.t('🔒 Enter share password')), 1 /* TEXT */),
                    _createElementVNode("button", {
                      class: "icon-btn",
                      onClick: _cache[107] || (_cache[107] = (...args) => (_ctx.cancelShareUnlock && _ctx.cancelShareUnlock(...args)))
                    }, "✕")
                  ]),
                  _createElementVNode("div", _hoisted_387, [
                    _createElementVNode("p", _hoisted_388, _toDisplayString(_ctx.t('“{name}” is password-protected.', {name: _ctx.shareUnlock.name})), 1 /* TEXT */),
                    _createElementVNode("div", _hoisted_389, [
                      _createElementVNode("label", null, _toDisplayString(_ctx.t('Share password')), 1 /* TEXT */),
                      _withDirectives(_createElementVNode("input", {
                        "onUpdate:modelValue": _cache[108] || (_cache[108] = $event => ((_ctx.shareUnlock.password) = $event)),
                        type: "password",
                        onKeyup: _cache[109] || (_cache[109] = _withKeys((...args) => (_ctx.doShareUnlock && _ctx.doShareUnlock(...args)), ["enter"])),
                        autocomplete: "off",
                        "data-1p-ignore": "",
                        "data-lpignore": "true"
                      }, null, 544 /* NEED_HYDRATION, NEED_PATCH */), [
                        [_vModelText, _ctx.shareUnlock.password]
                      ])
                    ]),
                    (_ctx.shareUnlock.err)
                      ? (_openBlock(), _createElementBlock("div", _hoisted_390, _toDisplayString(_ctx.shareUnlock.err), 1 /* TEXT */))
                      : _createCommentVNode("v-if", true)
                  ]),
                  _createElementVNode("div", _hoisted_391, [
                    _createElementVNode("button", {
                      type: "button",
                      class: "btn",
                      onClick: _cache[110] || (_cache[110] = (...args) => (_ctx.cancelShareUnlock && _ctx.cancelShareUnlock(...args)))
                    }, _toDisplayString(_ctx.t('Cancel')), 1 /* TEXT */),
                    _createElementVNode("button", {
                      class: "btn primary",
                      disabled: _ctx.shareUnlock.busy,
                      onClick: _cache[111] || (_cache[111] = (...args) => (_ctx.doShareUnlock && _ctx.doShareUnlock(...args)))
                    }, _toDisplayString(_ctx.t('Unlock')), 9 /* TEXT, PROPS */, _hoisted_392)
                  ])
                ])
              ]))
            : _createCommentVNode("v-if", true),
          _createCommentVNode(" Data Import (CSV / JSON) "),
          (_ctx.modal && _ctx.modal.type==='import')
            ? (_openBlock(), _createElementBlock("div", {
                key: 8,
                class: "modal-mask",
                onClick: _cache[122] || (_cache[122] = _withModifiers($event => (_ctx.modal=null), ["self"]))
              }, [
                _createElementVNode("div", _hoisted_393, [
                  _createElementVNode("div", _hoisted_394, [
                    _createElementVNode("h3", null, _toDisplayString(_ctx.t('📥 Import (CSV / JSON)')), 1 /* TEXT */),
                    _createElementVNode("button", {
                      class: "icon-btn",
                      onClick: _cache[113] || (_cache[113] = $event => (_ctx.modal=null))
                    }, "✕")
                  ]),
                  _createElementVNode("div", _hoisted_395, [
                    (_ctx.importStep===1)
                      ? (_openBlock(), _createElementBlock(_Fragment, { key: 0 }, [
                          _createElementVNode("p", _hoisted_396, [
                            _createTextVNode(_toDisplayString(_ctx.t('Choose a CSV or JSON file, or paste its contents, and fields (the input form) are created automatically and all rows imported.')), 1 /* TEXT */),
                            _hoisted_397,
                            _createTextVNode(_toDisplayString(_ctx.t('e.g. Google Password Manager CSV export / an array of objects in JSON / RegiBase JSON export.')), 1 /* TEXT */)
                          ]),
                          _createElementVNode("label", _hoisted_398, [
                            _createElementVNode("input", {
                              type: "file",
                              accept: ".csv,.json,.txt",
                              onChange: _cache[114] || (_cache[114] = (...args) => (_ctx.onImportFile && _ctx.onImportFile(...args)))
                            }, null, 32 /* NEED_HYDRATION */),
                            _createElementVNode("span", _hoisted_399, _toDisplayString(_ctx.t('📄 Choose file')), 1 /* TEXT */),
                            _createElementVNode("span", _hoisted_400, _toDisplayString(_ctx.importFileName || _ctx.t('No file selected')), 1 /* TEXT */)
                          ]),
                          _createElementVNode("div", _hoisted_401, _toDisplayString(_ctx.t('Or paste the contents (CSV / JSON):')), 1 /* TEXT */),
                          _withDirectives(_createElementVNode("textarea", {
                            "onUpdate:modelValue": _cache[115] || (_cache[115] = $event => ((_ctx.importCsv) = $event)),
                            placeholder: _ctx.importExamplePh,
                            style: {"width":"100%","min-height":"150px","padding":"11px 12px","border-radius":"10px","border":"1px solid var(--border)","background":"var(--surface-2)","color":"var(--text)"}
                          }, null, 8 /* PROPS */, _hoisted_402), [
                            [_vModelText, _ctx.importCsv]
                          ])
                        ], 64 /* STABLE_FRAGMENT */))
                      : (_openBlock(), _createElementBlock(_Fragment, { key: 1 }, [
                          _createElementVNode("div", _hoisted_403, [
                            _createElementVNode("span", _hoisted_404, _toDisplayString(_ctx.t('Detected format:')) + " " + _toDisplayString(_ctx.importAnalysis.formatLabel), 1 /* TEXT */),
                            _createTextVNode(),
                            _createElementVNode("span", _hoisted_405, _toDisplayString(_ctx.t('{n} items', {n: _ctx.importAnalysis.rowCount})), 1 /* TEXT */)
                          ]),
                          _createElementVNode("div", _hoisted_406, [
                            _createElementVNode("label", null, _toDisplayString(_ctx.t('Collection name')), 1 /* TEXT */),
                            _withDirectives(_createElementVNode("input", {
                              "onUpdate:modelValue": _cache[116] || (_cache[116] = $event => ((_ctx.importColl.name) = $event))
                            }, null, 512 /* NEED_PATCH */), [
                              [_vModelText, _ctx.importColl.name]
                            ])
                          ]),
                          _createElementVNode("div", _hoisted_407, [
                            _createElementVNode("label", null, _toDisplayString(_ctx.t('Icon (emoji)')), 1 /* TEXT */),
                            _withDirectives(_createElementVNode("input", {
                              "onUpdate:modelValue": _cache[117] || (_cache[117] = $event => ((_ctx.importColl.icon) = $event)),
                              maxlength: "4",
                              style: {"width":"90px"}
                            }, null, 512 /* NEED_PATCH */), [
                              [_vModelText, _ctx.importColl.icon]
                            ])
                          ]),
                          _createElementVNode("p", _hoisted_408, _toDisplayString(_ctx.t('Field settings for each column (★ = list title / Secret = masked):')), 1 /* TEXT */),
                          (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.importCols, (c, i) => {
                            return (_openBlock(), _createElementBlock("div", {
                              key: i,
                              class: "schema-row"
                            }, [
                              _withDirectives(_createElementVNode("input", {
                                "onUpdate:modelValue": $event => ((c.label) = $event),
                                placeholder: _ctx.t('Display name')
                              }, null, 8 /* PROPS */, _hoisted_409), [
                                [_vModelText, c.label]
                              ]),
                              _withDirectives(_createElementVNode("select", {
                                "onUpdate:modelValue": $event => ((c.type) = $event)
                              }, [
                                _createElementVNode("option", _hoisted_411, _toDisplayString(_ctx.t('Text')), 1 /* TEXT */),
                                _createElementVNode("option", _hoisted_412, _toDisplayString(_ctx.t('Multi-line text')), 1 /* TEXT */),
                                _createElementVNode("option", _hoisted_413, _toDisplayString(_ctx.t('Password')), 1 /* TEXT */),
                                _hoisted_414,
                                _createElementVNode("option", _hoisted_415, _toDisplayString(_ctx.t('Email')), 1 /* TEXT */),
                                _createElementVNode("option", _hoisted_416, _toDisplayString(_ctx.t('Phone number')), 1 /* TEXT */),
                                _createElementVNode("option", _hoisted_417, _toDisplayString(_ctx.t('Date')), 1 /* TEXT */),
                                _createElementVNode("option", _hoisted_418, _toDisplayString(_ctx.t('Numeric')), 1 /* TEXT */),
                                _createElementVNode("option", _hoisted_419, _toDisplayString(_ctx.t('Image')), 1 /* TEXT */)
                              ], 8 /* PROPS */, _hoisted_410), [
                                [_vModelSelect, c.type]
                              ]),
                              _createElementVNode("span", {
                                class: "chip",
                                title: _ctx.t('CSV column:')+' '+c.header
                              }, _toDisplayString(c.header), 9 /* TEXT, PROPS */, _hoisted_420),
                              _createElementVNode("div", _hoisted_421, [
                                _createElementVNode("label", null, [
                                  _createElementVNode("input", {
                                    type: "radio",
                                    checked: c.is_title,
                                    onChange: $event => (_ctx.setImportTitle(i))
                                  }, null, 40 /* PROPS, NEED_HYDRATION */, _hoisted_422),
                                  _createTextVNode(" " + _toDisplayString(_ctx.t('★ Title')), 1 /* TEXT */)
                                ]),
                                _createElementVNode("label", null, [
                                  _withDirectives(_createElementVNode("input", {
                                    type: "checkbox",
                                    "onUpdate:modelValue": $event => ((c.secret) = $event)
                                  }, null, 8 /* PROPS */, _hoisted_423), [
                                    [_vModelCheckbox, c.secret]
                                  ]),
                                  _createTextVNode(" " + _toDisplayString(_ctx.t('Secret')), 1 /* TEXT */)
                                ])
                              ])
                            ]))
                          }), 128 /* KEYED_FRAGMENT */))
                        ], 64 /* STABLE_FRAGMENT */))
                  ]),
                  _createElementVNode("div", _hoisted_424, [
                    (_ctx.importStep===2)
                      ? (_openBlock(), _createElementBlock("button", {
                          key: 0,
                          type: "button",
                          class: "btn",
                          onClick: _cache[118] || (_cache[118] = $event => (_ctx.importStep=1))
                        }, _toDisplayString(_ctx.t('← Back')), 1 /* TEXT */))
                      : _createCommentVNode("v-if", true),
                    _createElementVNode("button", {
                      type: "button",
                      class: "btn",
                      onClick: _cache[119] || (_cache[119] = $event => (_ctx.modal=null))
                    }, _toDisplayString(_ctx.t('Cancel')), 1 /* TEXT */),
                    (_ctx.importStep===1)
                      ? (_openBlock(), _createElementBlock("button", {
                          key: 1,
                          type: "button",
                          class: "btn primary",
                          onClick: _cache[120] || (_cache[120] = (...args) => (_ctx.analyzeImport && _ctx.analyzeImport(...args)))
                        }, _toDisplayString(_ctx.t('Analyze')), 1 /* TEXT */))
                      : (_openBlock(), _createElementBlock("button", {
                          key: 2,
                          type: "button",
                          class: "btn primary",
                          disabled: _ctx.importBusy,
                          onClick: _cache[121] || (_cache[121] = (...args) => (_ctx.commitImport && _ctx.commitImport(...args)))
                        }, _toDisplayString(_ctx.t('Import {n} items', {n: _ctx.importAnalysis.rowCount})), 9 /* TEXT, PROPS */, _hoisted_425))
                  ])
                ])
              ]))
            : _createCommentVNode("v-if", true),
          _createCommentVNode(" 連絡先（Contacts）からインポート "),
          (_ctx.modal && _ctx.modal.type==='contactsImport')
            ? (_openBlock(), _createElementBlock("div", {
                key: 9,
                class: "modal-mask",
                onClick: _cache[128] || (_cache[128] = _withModifiers($event => (!_ctx.contactsImport.busy && (_ctx.modal=null)), ["self"]))
              }, [
                _createElementVNode("div", _hoisted_426, [
                  _createElementVNode("div", _hoisted_427, [
                    _createElementVNode("h3", null, _toDisplayString(_ctx.t('📇 Import from Contacts')), 1 /* TEXT */),
                    _createElementVNode("button", {
                      class: "icon-btn",
                      disabled: _ctx.contactsImport.busy,
                      onClick: _cache[123] || (_cache[123] = $event => (_ctx.modal=null))
                    }, "✕", 8 /* PROPS */, _hoisted_428)
                  ]),
                  _createElementVNode("div", _hoisted_429, [
                    (_ctx.contactsImport.loading)
                      ? (_openBlock(), _createElementBlock("div", _hoisted_430, [
                          _createElementVNode("p", null, _toDisplayString(_ctx.t('Loading…')), 1 /* TEXT */)
                        ]))
                      : (!_ctx.contactsImport.enabled || !_ctx.contactsImport.books.length)
                        ? (_openBlock(), _createElementBlock("div", _hoisted_431, [
                            _createElementVNode("p", null, _toDisplayString(_ctx.t('No contacts found')), 1 /* TEXT */)
                          ]))
                        : (_openBlock(), _createElementBlock(_Fragment, { key: 2 }, [
                            _createElementVNode("p", _hoisted_432, _toDisplayString(_ctx.t('Import contacts as a new collection. Contacts is not modified.')), 1 /* TEXT */),
                            _createElementVNode("div", _hoisted_433, [
                              _createElementVNode("label", null, _toDisplayString(_ctx.t('Address book')), 1 /* TEXT */),
                              _withDirectives(_createElementVNode("select", {
                                "onUpdate:modelValue": _cache[124] || (_cache[124] = $event => ((_ctx.contactsImport.selected) = $event))
                              }, [
                                _createElementVNode("option", _hoisted_434, _toDisplayString(_ctx.t('All')) + "（" + _toDisplayString(_ctx.t('{n} items', {n: _ctx.contactsTotal})) + "）", 1 /* TEXT */),
                                (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.contactsImport.books, (b) => {
                                  return (_openBlock(), _createElementBlock("option", {
                                    key: b.key,
                                    value: b.key
                                  }, _toDisplayString(b.name) + "（" + _toDisplayString(_ctx.t('{n} items', {n: b.count})) + "）", 9 /* TEXT, PROPS */, _hoisted_435))
                                }), 128 /* KEYED_FRAGMENT */))
                              ], 512 /* NEED_PATCH */), [
                                [_vModelSelect, _ctx.contactsImport.selected]
                              ])
                            ]),
                            _createElementVNode("div", _hoisted_436, [
                              _createElementVNode("label", null, _toDisplayString(_ctx.t('Collection name')), 1 /* TEXT */),
                              _withDirectives(_createElementVNode("input", {
                                "onUpdate:modelValue": _cache[125] || (_cache[125] = $event => ((_ctx.contactsImport.name) = $event)),
                                placeholder: _ctx.t('Contacts')
                              }, null, 8 /* PROPS */, _hoisted_437), [
                                [_vModelText, _ctx.contactsImport.name]
                              ])
                            ]),
                            (_ctx.contactsImport.err)
                              ? (_openBlock(), _createElementBlock("div", _hoisted_438, _toDisplayString(_ctx.contactsImport.err), 1 /* TEXT */))
                              : _createCommentVNode("v-if", true)
                          ], 64 /* STABLE_FRAGMENT */))
                  ]),
                  _createElementVNode("div", _hoisted_439, [
                    _createElementVNode("button", {
                      class: "btn",
                      disabled: _ctx.contactsImport.busy,
                      onClick: _cache[126] || (_cache[126] = $event => (_ctx.modal=null))
                    }, _toDisplayString(_ctx.t('Cancel')), 9 /* TEXT, PROPS */, _hoisted_440),
                    (_ctx.contactsImport.enabled && _ctx.contactsImport.books.length)
                      ? (_openBlock(), _createElementBlock("button", {
                          key: 0,
                          class: "btn primary",
                          disabled: _ctx.contactsImport.busy,
                          onClick: _cache[127] || (_cache[127] = (...args) => (_ctx.commitContactsImport && _ctx.commitContactsImport(...args)))
                        }, _toDisplayString(_ctx.t('Import')), 9 /* TEXT, PROPS */, _hoisted_441))
                      : _createCommentVNode("v-if", true)
                  ])
                ])
              ]))
            : _createCommentVNode("v-if", true),
          _createCommentVNode(" Tables からインポート "),
          (_ctx.modal && _ctx.modal.type==='tablesImport')
            ? (_openBlock(), _createElementBlock("div", {
                key: 10,
                class: "modal-mask",
                onClick: _cache[134] || (_cache[134] = _withModifiers($event => (!_ctx.tablesImport.busy && (_ctx.modal=null)), ["self"]))
              }, [
                _createElementVNode("div", _hoisted_442, [
                  _createElementVNode("div", _hoisted_443, [
                    _createElementVNode("h3", null, _toDisplayString(_ctx.t('📊 Import from Tables')), 1 /* TEXT */),
                    _createElementVNode("button", {
                      class: "icon-btn",
                      disabled: _ctx.tablesImport.busy,
                      onClick: _cache[129] || (_cache[129] = $event => (_ctx.modal=null))
                    }, "✕", 8 /* PROPS */, _hoisted_444)
                  ]),
                  _createElementVNode("div", _hoisted_445, [
                    (_ctx.tablesImport.loading)
                      ? (_openBlock(), _createElementBlock("div", _hoisted_446, [
                          _createElementVNode("p", null, _toDisplayString(_ctx.t('Loading…')), 1 /* TEXT */)
                        ]))
                      : (!_ctx.tablesImport.available)
                        ? (_openBlock(), _createElementBlock("div", _hoisted_447, [
                            _createElementVNode("p", null, _toDisplayString(_ctx.t('The Tables app is not enabled')), 1 /* TEXT */)
                          ]))
                        : (!_ctx.tablesImport.tables.length)
                          ? (_openBlock(), _createElementBlock("div", _hoisted_448, [
                              _createElementVNode("p", null, _toDisplayString(_ctx.t('No tables found')), 1 /* TEXT */)
                            ]))
                          : (_openBlock(), _createElementBlock(_Fragment, { key: 3 }, [
                              _createElementVNode("p", _hoisted_449, _toDisplayString(_ctx.t('Import a table as a new collection. Tables is not modified.')), 1 /* TEXT */),
                              _createElementVNode("div", _hoisted_450, [
                                _createElementVNode("label", null, _toDisplayString(_ctx.t('Source table')), 1 /* TEXT */),
                                _withDirectives(_createElementVNode("select", {
                                  "onUpdate:modelValue": _cache[130] || (_cache[130] = $event => ((_ctx.tablesImport.selected) = $event))
                                }, [
                                  (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.tablesImport.tables, (tb) => {
                                    return (_openBlock(), _createElementBlock("option", {
                                      key: tb.id,
                                      value: tb.id
                                    }, _toDisplayString((tb.emoji ? tb.emoji + ' ' : '') + tb.title) + "（" + _toDisplayString(_ctx.t('{n} columns', {n: tb.columns})) + "）", 9 /* TEXT, PROPS */, _hoisted_451))
                                  }), 128 /* KEYED_FRAGMENT */))
                                ], 512 /* NEED_PATCH */), [
                                  [_vModelSelect, _ctx.tablesImport.selected]
                                ])
                              ]),
                              _createElementVNode("div", _hoisted_452, [
                                _createElementVNode("label", null, _toDisplayString(_ctx.t('Collection name')), 1 /* TEXT */),
                                _withDirectives(_createElementVNode("input", {
                                  "onUpdate:modelValue": _cache[131] || (_cache[131] = $event => ((_ctx.tablesImport.name) = $event)),
                                  placeholder: _ctx.tablesSelectedTitle
                                }, null, 8 /* PROPS */, _hoisted_453), [
                                  [_vModelText, _ctx.tablesImport.name]
                                ])
                              ]),
                              (_ctx.tablesImport.err)
                                ? (_openBlock(), _createElementBlock("div", _hoisted_454, _toDisplayString(_ctx.tablesImport.err), 1 /* TEXT */))
                                : _createCommentVNode("v-if", true)
                            ], 64 /* STABLE_FRAGMENT */))
                  ]),
                  _createElementVNode("div", _hoisted_455, [
                    _createElementVNode("button", {
                      class: "btn",
                      disabled: _ctx.tablesImport.busy,
                      onClick: _cache[132] || (_cache[132] = $event => (_ctx.modal=null))
                    }, _toDisplayString(_ctx.t('Cancel')), 9 /* TEXT, PROPS */, _hoisted_456),
                    (_ctx.tablesImport.available && _ctx.tablesImport.tables.length)
                      ? (_openBlock(), _createElementBlock("button", {
                          key: 0,
                          class: "btn primary",
                          disabled: _ctx.tablesImport.busy || !_ctx.tablesImport.selected,
                          onClick: _cache[133] || (_cache[133] = (...args) => (_ctx.commitTablesImport && _ctx.commitTablesImport(...args)))
                        }, _toDisplayString(_ctx.t('Import')), 9 /* TEXT, PROPS */, _hoisted_457))
                      : _createCommentVNode("v-if", true)
                  ])
                ])
              ]))
            : _createCommentVNode("v-if", true),
          _createCommentVNode(" 移動 / 複製 "),
          (_ctx.modal && _ctx.modal.type==='transfer')
            ? (_openBlock(), _createElementBlock("div", {
                key: 11,
                class: "modal-mask",
                onClick: _cache[143] || (_cache[143] = _withModifiers($event => (_ctx.modal=null), ["self"]))
              }, [
                _createElementVNode("div", _hoisted_458, [
                  _createElementVNode("div", _hoisted_459, [
                    _createElementVNode("h3", null, _toDisplayString(_ctx.t('↔ Move / Copy')), 1 /* TEXT */),
                    _createElementVNode("button", {
                      class: "icon-btn",
                      onClick: _cache[135] || (_cache[135] = $event => (_ctx.modal=null))
                    }, "✕")
                  ]),
                  _createElementVNode("div", _hoisted_460, [
                    _createElementVNode("div", _hoisted_461, [
                      _createElementVNode("label", null, _toDisplayString(_ctx.t('Target')), 1 /* TEXT */),
                      _createElementVNode("div", _hoisted_462, _toDisplayString(_ctx.t('{n} records', {n: _ctx.xfer.recordIds.length})), 1 /* TEXT */)
                    ]),
                    _createElementVNode("div", _hoisted_463, [
                      _createElementVNode("label", null, _toDisplayString(_ctx.t('Action')), 1 /* TEXT */),
                      _createElementVNode("div", _hoisted_464, [
                        _createElementVNode("label", null, [
                          _withDirectives(_createElementVNode("input", {
                            type: "radio",
                            value: "copy",
                            "onUpdate:modelValue": _cache[136] || (_cache[136] = $event => ((_ctx.xfer.mode) = $event))
                          }, null, 512 /* NEED_PATCH */), [
                            [_vModelRadio, _ctx.xfer.mode]
                          ]),
                          _createTextVNode(" " + _toDisplayString(_ctx.t('Copy (keep original)')), 1 /* TEXT */)
                        ]),
                        _createElementVNode("label", null, [
                          _withDirectives(_createElementVNode("input", {
                            type: "radio",
                            value: "move",
                            "onUpdate:modelValue": _cache[137] || (_cache[137] = $event => ((_ctx.xfer.mode) = $event))
                          }, null, 512 /* NEED_PATCH */), [
                            [_vModelRadio, _ctx.xfer.mode]
                          ]),
                          _createTextVNode(" " + _toDisplayString(_ctx.t('Move (delete from original)')), 1 /* TEXT */)
                        ])
                      ])
                    ]),
                    _createElementVNode("div", _hoisted_465, [
                      _createElementVNode("label", null, _toDisplayString(_ctx.t('Destination collection')), 1 /* TEXT */),
                      _createElementVNode("select", {
                        value: _ctx.xfer.targetId,
                        onChange: _cache[138] || (_cache[138] = $event => (_ctx.onTransferTarget($event.target.value)))
                      }, [
                        _createElementVNode("option", _hoisted_467, _toDisplayString(_ctx.t('— Select —')), 1 /* TEXT */),
                        _createElementVNode("option", _hoisted_468, _toDisplayString(_ctx.t('＋ Create a new collection…')), 1 /* TEXT */),
                        (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.otherCollections, (c) => {
                          return (_openBlock(), _createElementBlock("option", {
                            key: c.id,
                            value: c.id
                          }, _toDisplayString(c.icon) + " " + _toDisplayString(c.name), 9 /* TEXT, PROPS */, _hoisted_469))
                        }), 128 /* KEYED_FRAGMENT */))
                      ], 40 /* PROPS, NEED_HYDRATION */, _hoisted_466)
                    ]),
                    (_ctx.xfer.targetId==='__newcoll__')
                      ? (_openBlock(), _createElementBlock("div", _hoisted_470, [
                          _createElementVNode("label", null, _toDisplayString(_ctx.t('New collection name')), 1 /* TEXT */),
                          _withDirectives(_createElementVNode("input", {
                            "onUpdate:modelValue": _cache[139] || (_cache[139] = $event => ((_ctx.xfer.newName) = $event)),
                            placeholder: _ctx.t('Collection name')
                          }, null, 8 /* PROPS */, _hoisted_471), [
                            [_vModelText, _ctx.xfer.newName]
                          ]),
                          _createElementVNode("div", _hoisted_472, _toDisplayString(_ctx.newCollDesc()), 1 /* TEXT */)
                        ]))
                      : _createCommentVNode("v-if", true),
                    (_ctx.xfer.target)
                      ? (_openBlock(), _createElementBlock(_Fragment, { key: 1 }, [
                          _createElementVNode("p", _hoisted_473, _toDisplayString(_ctx.t('Field mapping (source → destination). Auto-matched by label. Choose “Add as new field” to create that field in the destination. “Do not import” discards it.')), 1 /* TEXT */),
                          (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.current.fields, (sf) => {
                            return (_openBlock(), _createElementBlock("div", {
                              key: sf.key,
                              class: "map-row"
                            }, [
                              _createElementVNode("span", {
                                class: "map-src",
                                title: sf.label
                              }, [
                                _createElementVNode("span", _hoisted_475, _toDisplayString(sf.label), 1 /* TEXT */),
                                (_ctx.xferSample(sf))
                                  ? (_openBlock(), _createElementBlock("span", _hoisted_476, _toDisplayString(_ctx.xferSample(sf)), 1 /* TEXT */))
                                  : (_openBlock(), _createElementBlock("span", _hoisted_477, _toDisplayString(_ctx.t('(empty)')), 1 /* TEXT */))
                              ], 8 /* PROPS */, _hoisted_474),
                              _hoisted_478,
                              _withDirectives(_createElementVNode("select", {
                                "onUpdate:modelValue": $event => ((_ctx.xfer.mapping[sf.key]) = $event),
                                class: _normalizeClass({isnew: _ctx.xfer.mapping[sf.key]==='__new__'})
                              }, [
                                _createElementVNode("option", _hoisted_480, _toDisplayString(_ctx.t('(do not import)')), 1 /* TEXT */),
                                (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.xfer.target.fields, (tf) => {
                                  return (_openBlock(), _createElementBlock("option", {
                                    key: tf.key,
                                    value: tf.key
                                  }, _toDisplayString(tf.label), 9 /* TEXT, PROPS */, _hoisted_481))
                                }), 128 /* KEYED_FRAGMENT */)),
                                _createElementVNode("option", _hoisted_482, _toDisplayString(_ctx.t('＋ Add as new field ({label})', {label: sf.label})), 1 /* TEXT */)
                              ], 10 /* CLASS, PROPS */, _hoisted_479), [
                                [_vModelSelect, _ctx.xfer.mapping[sf.key]]
                              ])
                            ]))
                          }), 128 /* KEYED_FRAGMENT */)),
                          _createElementVNode("div", _hoisted_483, [
                            _createElementVNode("label", null, _toDisplayString(_ctx.t('Where to keep non-imported fields (prevents data loss, optional)')), 1 /* TEXT */),
                            _withDirectives(_createElementVNode("select", {
                              "onUpdate:modelValue": _cache[140] || (_cache[140] = $event => ((_ctx.xfer.appendTo) = $event))
                            }, [
                              _createElementVNode("option", _hoisted_484, _toDisplayString(_ctx.t('Do not append (discard)')), 1 /* TEXT */),
                              (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.targetTextareas, (tf) => {
                                return (_openBlock(), _createElementBlock("option", {
                                  key: tf.key,
                                  value: tf.key
                                }, _toDisplayString(_ctx.t('Append to “{label}” as “field: value”', {label: tf.label})), 9 /* TEXT, PROPS */, _hoisted_485))
                              }), 128 /* KEYED_FRAGMENT */))
                            ], 512 /* NEED_PATCH */), [
                              [_vModelSelect, _ctx.xfer.appendTo]
                            ])
                          ])
                        ], 64 /* STABLE_FRAGMENT */))
                      : _createCommentVNode("v-if", true)
                  ]),
                  _createElementVNode("div", _hoisted_486, [
                    _createElementVNode("button", {
                      class: "btn",
                      onClick: _cache[141] || (_cache[141] = $event => (_ctx.modal=null))
                    }, _toDisplayString(_ctx.t('Cancel')), 1 /* TEXT */),
                    _createElementVNode("button", {
                      class: "btn primary",
                      disabled: _ctx.xfer.busy || !(_ctx.xfer.target || (_ctx.xfer.targetId==='__newcoll__' && _ctx.xfer.newName && _ctx.xfer.newName.trim())),
                      onClick: _cache[142] || (_cache[142] = (...args) => (_ctx.commitTransfer && _ctx.commitTransfer(...args)))
                    }, _toDisplayString(_ctx.transferLabel()), 9 /* TEXT, PROPS */, _hoisted_487)
                  ])
                ])
              ]))
            : _createCommentVNode("v-if", true),
          _createCommentVNode(" 保存先設定 "),
          (_ctx.modal && _ctx.modal.type==='settings')
            ? (_openBlock(), _createElementBlock("div", {
                key: 12,
                class: "modal-mask",
                onClick: _cache[160] || (_cache[160] = _withModifiers($event => (_ctx.modal=null), ["self"]))
              }, [
                _createElementVNode("div", _hoisted_488, [
                  _createElementVNode("div", _hoisted_489, [
                    _createElementVNode("h3", null, _toDisplayString(_ctx.t('⚙️ Settings')), 1 /* TEXT */),
                    _createElementVNode("button", {
                      class: "icon-btn",
                      onClick: _cache[144] || (_cache[144] = $event => (_ctx.modal=null))
                    }, "✕")
                  ]),
                  _createElementVNode("div", _hoisted_490, [
                    _createElementVNode("div", _hoisted_491, [
                      _createElementVNode("label", null, "🌗 " + _toDisplayString(_ctx.t('Theme')), 1 /* TEXT */),
                      _createElementVNode("div", _hoisted_492, [
                        _createElementVNode("label", null, [
                          _withDirectives(_createElementVNode("input", {
                            type: "radio",
                            value: "auto",
                            "onUpdate:modelValue": _cache[145] || (_cache[145] = $event => ((_ctx.settingsForm.theme) = $event)),
                            onChange: _cache[146] || (_cache[146] = (...args) => (_ctx.previewTheme && _ctx.previewTheme(...args)))
                          }, null, 544 /* NEED_HYDRATION, NEED_PATCH */), [
                            [_vModelRadio, _ctx.settingsForm.theme]
                          ]),
                          _createTextVNode(" " + _toDisplayString(_ctx.t('Default (match Nextcloud)')), 1 /* TEXT */)
                        ]),
                        _createElementVNode("label", null, [
                          _withDirectives(_createElementVNode("input", {
                            type: "radio",
                            value: "light",
                            "onUpdate:modelValue": _cache[147] || (_cache[147] = $event => ((_ctx.settingsForm.theme) = $event)),
                            onChange: _cache[148] || (_cache[148] = (...args) => (_ctx.previewTheme && _ctx.previewTheme(...args)))
                          }, null, 544 /* NEED_HYDRATION, NEED_PATCH */), [
                            [_vModelRadio, _ctx.settingsForm.theme]
                          ]),
                          _createTextVNode(" " + _toDisplayString(_ctx.t('Light')), 1 /* TEXT */)
                        ]),
                        _createElementVNode("label", null, [
                          _withDirectives(_createElementVNode("input", {
                            type: "radio",
                            value: "dark",
                            "onUpdate:modelValue": _cache[149] || (_cache[149] = $event => ((_ctx.settingsForm.theme) = $event)),
                            onChange: _cache[150] || (_cache[150] = (...args) => (_ctx.previewTheme && _ctx.previewTheme(...args)))
                          }, null, 544 /* NEED_HYDRATION, NEED_PATCH */), [
                            [_vModelRadio, _ctx.settingsForm.theme]
                          ]),
                          _createTextVNode(" " + _toDisplayString(_ctx.t('Dark')), 1 /* TEXT */)
                        ])
                      ])
                    ]),
                    _createElementVNode("div", _hoisted_493, [
                      _createElementVNode("label", null, "🌐 " + _toDisplayString(_ctx.t('Language')), 1 /* TEXT */),
                      _withDirectives(_createElementVNode("select", {
                        "onUpdate:modelValue": _cache[151] || (_cache[151] = $event => ((_ctx.settingsForm.language) = $event))
                      }, [
                        _createElementVNode("option", _hoisted_494, _toDisplayString(_ctx.t('System default (match Nextcloud)')), 1 /* TEXT */),
                        (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.languages, (lg) => {
                          return (_openBlock(), _createElementBlock("option", {
                            key: lg.code,
                            value: lg.code
                          }, _toDisplayString(lg.name), 9 /* TEXT, PROPS */, _hoisted_495))
                        }), 128 /* KEYED_FRAGMENT */))
                      ], 512 /* NEED_PATCH */), [
                        [_vModelSelect, _ctx.settingsForm.language]
                      ]),
                      _createElementVNode("div", _hoisted_496, _toDisplayString(_ctx.t('The display language switches when you press “Save”.')), 1 /* TEXT */)
                    ]),
                    _createElementVNode("div", _hoisted_497, [
                      _createElementVNode("label", null, "📁 " + _toDisplayString(_ctx.t('Folder for images and files (path relative to your Files root)')), 1 /* TEXT */),
                      _withDirectives(_createElementVNode("input", {
                        "onUpdate:modelValue": _cache[152] || (_cache[152] = $event => ((_ctx.settingsForm.files_folder) = $event)),
                        placeholder: "RegiBase"
                      }, null, 512 /* NEED_PATCH */), [
                        [_vModelText, _ctx.settingsForm.files_folder]
                      ]),
                      _createElementVNode("div", _hoisted_498, [
                        _createTextVNode(_toDisplayString(_ctx.t('A subfolder is created per collection and files are stored in plain text. You can also view them in the Files app.')), 1 /* TEXT */),
                        _hoisted_499,
                        _createElementVNode("code", null, _toDisplayString((_ctx.settingsForm.files_folder || 'RegiBase')) + "/…/", 1 /* TEXT */)
                      ])
                    ]),
                    _createElementVNode("div", _hoisted_500, [
                      _createElementVNode("label", null, _toDisplayString(_ctx.t('🔒 Encryption (secret fields) — optional')), 1 /* TEXT */),
                      (_ctx.enc.enabled)
                        ? (_openBlock(), _createElementBlock("div", _hoisted_501, [
                            _createElementVNode("b", _hoisted_502, _toDisplayString(_ctx.t('Enabled')), 1 /* TEXT */),
                            _createTextVNode(_toDisplayString(_ctx.t(': Secret fields such as passwords are encrypted with the master key you entered on this device.')), 1 /* TEXT */),
                            (_ctx.hasRemembered())
                              ? (_openBlock(), _createElementBlock("span", _hoisted_503, _toDisplayString(_ctx.t('(remembered on this device)')), 1 /* TEXT */))
                              : _createCommentVNode("v-if", true),
                            _createElementVNode("div", _hoisted_504, [
                              _createElementVNode("button", {
                                type: "button",
                                class: "btn sm",
                                onClick: _cache[153] || (_cache[153] = (...args) => (_ctx.openEncChange && _ctx.openEncChange(...args)))
                              }, _toDisplayString(_ctx.t('Change master key')), 1 /* TEXT */),
                              _createElementVNode("button", {
                                type: "button",
                                class: "btn sm",
                                onClick: _cache[154] || (_cache[154] = (...args) => (_ctx.lockNow && _ctx.lockNow(...args)))
                              }, _toDisplayString(_ctx.t('🔒 Lock now (forget key)')), 1 /* TEXT */)
                            ])
                          ]))
                        : (_openBlock(), _createElementBlock("div", _hoisted_505, [
                            _createElementVNode("b", null, _toDisplayString(_ctx.t('Disabled (default)')), 1 /* TEXT */),
                            _createTextVNode(_toDisplayString(_ctx.t(': Secret fields are stored in plain text. If you enable it, secret fields are encrypted with your master key and become unreadable even to the server and the administrator.')) + " ", 1 /* TEXT */),
                            _createElementVNode("div", _hoisted_506, [
                              _createElementVNode("button", {
                                type: "button",
                                class: "btn sm primary",
                                onClick: _cache[155] || (_cache[155] = (...args) => (_ctx.openEncSetup && _ctx.openEncSetup(...args)))
                              }, _toDisplayString(_ctx.t('🔒 Enable encryption')), 1 /* TEXT */)
                            ])
                          ]))
                    ]),
                    _createElementVNode("div", _hoisted_507, [
                      _createElementVNode("label", null, "💾 " + _toDisplayString(_ctx.t('Backup / Restore')), 1 /* TEXT */),
                      _createElementVNode("div", _hoisted_508, _toDisplayString(_ctx.t('Save all collections, records, settings and attachments to a ZIP encrypted with your login password.')), 1 /* TEXT */),
                      _createElementVNode("div", _hoisted_509, [
                        _createElementVNode("button", {
                          type: "button",
                          class: "btn sm",
                          onClick: _cache[156] || (_cache[156] = (...args) => (_ctx.openBackup && _ctx.openBackup(...args)))
                        }, _toDisplayString(_ctx.t('🔒 Download all data')), 1 /* TEXT */),
                        _createElementVNode("button", {
                          type: "button",
                          class: "btn sm",
                          onClick: _cache[157] || (_cache[157] = (...args) => (_ctx.openRestore && _ctx.openRestore(...args)))
                        }, _toDisplayString(_ctx.t('♻ Restore from backup')), 1 /* TEXT */)
                      ])
                    ])
                  ]),
                  _createElementVNode("div", _hoisted_510, [
                    _createElementVNode("button", {
                      class: "btn",
                      onClick: _cache[158] || (_cache[158] = $event => (_ctx.modal=null))
                    }, _toDisplayString(_ctx.t('Cancel')), 1 /* TEXT */),
                    _createElementVNode("button", {
                      class: "btn primary",
                      onClick: _cache[159] || (_cache[159] = (...args) => (_ctx.saveSettings && _ctx.saveSettings(...args)))
                    }, _toDisplayString(_ctx.t('Save')), 1 /* TEXT */)
                  ])
                ])
              ]))
            : _createCommentVNode("v-if", true),
          _createCommentVNode(" 全データのバックアップ "),
          (_ctx.modal && _ctx.modal.type==='backup')
            ? (_openBlock(), _createElementBlock("div", {
                key: 13,
                class: "modal-mask",
                onClick: _cache[166] || (_cache[166] = _withModifiers($event => (!_ctx.backupForm.busy && (_ctx.modal=null)), ["self"]))
              }, [
                _createElementVNode("div", _hoisted_511, [
                  _createElementVNode("div", _hoisted_512, [
                    _createElementVNode("h3", null, _toDisplayString(_ctx.t('🔒 Download all data')), 1 /* TEXT */),
                    _createElementVNode("button", {
                      class: "icon-btn",
                      disabled: _ctx.backupForm.busy,
                      onClick: _cache[161] || (_cache[161] = $event => (_ctx.modal=null))
                    }, "✕", 8 /* PROPS */, _hoisted_513)
                  ]),
                  _createElementVNode("form", {
                    class: "modal-body",
                    onSubmit: _cache[163] || (_cache[163] = _withModifiers((...args) => (_ctx.doBackup && _ctx.doBackup(...args)), ["prevent"]))
                  }, [
                    _createElementVNode("p", _hoisted_514, _toDisplayString(_ctx.t('Enter your login password. The archive (ZIP) is encrypted with the same password.')), 1 /* TEXT */),
                    _createElementVNode("div", _hoisted_515, [
                      _createElementVNode("label", null, _toDisplayString(_ctx.t('Login password')), 1 /* TEXT */),
                      _withDirectives(_createElementVNode("input", {
                        type: "password",
                        "onUpdate:modelValue": _cache[162] || (_cache[162] = $event => ((_ctx.backupForm.password) = $event)),
                        autocomplete: "current-password",
                        autofocus: ""
                      }, null, 512 /* NEED_PATCH */), [
                        [_vModelText, _ctx.backupForm.password]
                      ])
                    ]),
                    (_ctx.backupForm.err)
                      ? (_openBlock(), _createElementBlock("div", _hoisted_516, _toDisplayString(_ctx.backupForm.err), 1 /* TEXT */))
                      : _createCommentVNode("v-if", true),
                    (_ctx.backupForm.busy)
                      ? (_openBlock(), _createElementBlock("div", _hoisted_517, _toDisplayString(_ctx.t('Creating…')), 1 /* TEXT */))
                      : _createCommentVNode("v-if", true)
                  ], 32 /* NEED_HYDRATION */),
                  _createElementVNode("div", _hoisted_518, [
                    _createElementVNode("button", {
                      class: "btn",
                      disabled: _ctx.backupForm.busy,
                      onClick: _cache[164] || (_cache[164] = $event => (_ctx.modal=null))
                    }, _toDisplayString(_ctx.t('Cancel')), 9 /* TEXT, PROPS */, _hoisted_519),
                    _createElementVNode("button", {
                      class: "btn primary",
                      disabled: _ctx.backupForm.busy,
                      onClick: _cache[165] || (_cache[165] = (...args) => (_ctx.doBackup && _ctx.doBackup(...args)))
                    }, _toDisplayString(_ctx.t('Download')), 9 /* TEXT, PROPS */, _hoisted_520)
                  ])
                ])
              ]))
            : _createCommentVNode("v-if", true),
          _createCommentVNode(" バックアップから復元 "),
          (_ctx.modal && _ctx.modal.type==='restore')
            ? (_openBlock(), _createElementBlock("div", {
                key: 14,
                class: "modal-mask",
                onClick: _cache[176] || (_cache[176] = _withModifiers($event => (!_ctx.restoreForm.busy && (_ctx.modal=null)), ["self"]))
              }, [
                _createElementVNode("div", _hoisted_521, [
                  _createElementVNode("div", _hoisted_522, [
                    _createElementVNode("h3", null, _toDisplayString(_ctx.t('♻ Restore from backup')), 1 /* TEXT */),
                    _createElementVNode("button", {
                      class: "icon-btn",
                      disabled: _ctx.restoreForm.busy,
                      onClick: _cache[167] || (_cache[167] = $event => (_ctx.modal=null))
                    }, "✕", 8 /* PROPS */, _hoisted_523)
                  ]),
                  _createElementVNode("div", _hoisted_524, [
                    _createElementVNode("label", _hoisted_525, [
                      _createElementVNode("input", {
                        type: "file",
                        accept: ".zip",
                        onChange: _cache[168] || (_cache[168] = (...args) => (_ctx.onRestoreFile && _ctx.onRestoreFile(...args)))
                      }, null, 32 /* NEED_HYDRATION */),
                      _createElementVNode("span", _hoisted_526, _toDisplayString(_ctx.t('📄 Choose file')), 1 /* TEXT */),
                      _createElementVNode("span", _hoisted_527, _toDisplayString(_ctx.restoreForm.fileName || _ctx.t('Backup file (.zip)')), 1 /* TEXT */)
                    ]),
                    _createElementVNode("div", _hoisted_528, [
                      _createElementVNode("label", null, _toDisplayString(_ctx.t('Login password')), 1 /* TEXT */),
                      _withDirectives(_createElementVNode("input", {
                        type: "password",
                        "onUpdate:modelValue": _cache[169] || (_cache[169] = $event => ((_ctx.restoreForm.password) = $event)),
                        autocomplete: "current-password"
                      }, null, 512 /* NEED_PATCH */), [
                        [_vModelText, _ctx.restoreForm.password]
                      ])
                    ]),
                    _createElementVNode("div", _hoisted_529, [
                      _createElementVNode("label", null, _toDisplayString(_ctx.t('Restore method')), 1 /* TEXT */),
                      _createElementVNode("div", _hoisted_530, [
                        _createElementVNode("label", null, [
                          _withDirectives(_createElementVNode("input", {
                            type: "radio",
                            value: "overwrite",
                            "onUpdate:modelValue": _cache[170] || (_cache[170] = $event => ((_ctx.restoreForm.mode) = $event))
                          }, null, 512 /* NEED_PATCH */), [
                            [_vModelRadio, _ctx.restoreForm.mode]
                          ]),
                          _createTextVNode(" " + _toDisplayString(_ctx.t('Overwrite (delete and replace existing data)')), 1 /* TEXT */)
                        ]),
                        _createElementVNode("label", null, [
                          _withDirectives(_createElementVNode("input", {
                            type: "radio",
                            value: "merge",
                            "onUpdate:modelValue": _cache[171] || (_cache[171] = $event => ((_ctx.restoreForm.mode) = $event))
                          }, null, 512 /* NEED_PATCH */), [
                            [_vModelRadio, _ctx.restoreForm.mode]
                          ]),
                          _createTextVNode(" " + _toDisplayString(_ctx.t('Merge (import only non-duplicate records)')), 1 /* TEXT */)
                        ]),
                        _createElementVNode("label", null, [
                          _withDirectives(_createElementVNode("input", {
                            type: "radio",
                            value: "add",
                            "onUpdate:modelValue": _cache[172] || (_cache[172] = $event => ((_ctx.restoreForm.mode) = $event))
                          }, null, 512 /* NEED_PATCH */), [
                            [_vModelRadio, _ctx.restoreForm.mode]
                          ]),
                          _createTextVNode(" " + _toDisplayString(_ctx.t('Add (as new collections)')), 1 /* TEXT */)
                        ])
                      ])
                    ]),
                    (_ctx.restoreForm.mode==='overwrite')
                      ? (_openBlock(), _createElementBlock(_Fragment, { key: 0 }, [
                          _createElementVNode("p", _hoisted_531, _toDisplayString(_ctx.t('⚠️ Overwriting replaces ALL existing data (collections, records, settings).')), 1 /* TEXT */),
                          _createElementVNode("label", _hoisted_532, [
                            _withDirectives(_createElementVNode("input", {
                              type: "checkbox",
                              "onUpdate:modelValue": _cache[173] || (_cache[173] = $event => ((_ctx.restoreForm.confirm) = $event))
                            }, null, 512 /* NEED_PATCH */), [
                              [_vModelCheckbox, _ctx.restoreForm.confirm]
                            ]),
                            _createTextVNode(" " + _toDisplayString(_ctx.t('I understand the above and confirm the restore')), 1 /* TEXT */)
                          ])
                        ], 64 /* STABLE_FRAGMENT */))
                      : _createCommentVNode("v-if", true),
                    (_ctx.restoreForm.err)
                      ? (_openBlock(), _createElementBlock("div", _hoisted_533, _toDisplayString(_ctx.restoreForm.err), 1 /* TEXT */))
                      : _createCommentVNode("v-if", true),
                    (_ctx.restoreForm.busy)
                      ? (_openBlock(), _createElementBlock("div", _hoisted_534, _toDisplayString(_ctx.t('Restoring…')), 1 /* TEXT */))
                      : _createCommentVNode("v-if", true)
                  ]),
                  _createElementVNode("div", _hoisted_535, [
                    _createElementVNode("button", {
                      class: "btn",
                      disabled: _ctx.restoreForm.busy,
                      onClick: _cache[174] || (_cache[174] = $event => (_ctx.modal=null))
                    }, _toDisplayString(_ctx.t('Cancel')), 9 /* TEXT, PROPS */, _hoisted_536),
                    _createElementVNode("button", {
                      class: _normalizeClass(["btn", _ctx.restoreForm.mode==='overwrite' ? 'danger' : 'primary']),
                      disabled: _ctx.restoreForm.busy || (_ctx.restoreForm.mode==='overwrite' && !_ctx.restoreForm.confirm),
                      onClick: _cache[175] || (_cache[175] = (...args) => (_ctx.doRestore && _ctx.doRestore(...args)))
                    }, _toDisplayString(_ctx.t('Restore')), 11 /* TEXT, CLASS, PROPS */, _hoisted_537)
                  ])
                ])
              ]))
            : _createCommentVNode("v-if", true),
          _createCommentVNode(" 暗号化を有効にする "),
          (_ctx.modal && _ctx.modal.type==='encSetup')
            ? (_openBlock(), _createElementBlock("div", {
                key: 15,
                class: "modal-mask",
                onClick: _cache[183] || (_cache[183] = _withModifiers($event => (!_ctx.encForm.busy && (_ctx.modal=null)), ["self"]))
              }, [
                _createElementVNode("div", _hoisted_538, [
                  _createElementVNode("div", _hoisted_539, [
                    _createElementVNode("h3", null, _toDisplayString(_ctx.t('🔒 Enable encryption')), 1 /* TEXT */),
                    _createElementVNode("button", {
                      class: "icon-btn",
                      disabled: _ctx.encForm.busy,
                      onClick: _cache[177] || (_cache[177] = $event => (_ctx.modal=null))
                    }, "✕", 8 /* PROPS */, _hoisted_540)
                  ]),
                  _createElementVNode("div", _hoisted_541, [
                    _createElementVNode("p", _hoisted_542, [
                      _createTextVNode(_toDisplayString(_ctx.t('Secret fields (passwords, PINs, card numbers, etc.) are encrypted with the ')), 1 /* TEXT */),
                      _createElementVNode("b", null, _toDisplayString(_ctx.t('Master key')), 1 /* TEXT */),
                      _createTextVNode(_toDisplayString(_ctx.t(' you enter on this device. The master key is never given to the server or the administrator. Names, URLs, etc. are not encrypted (for search and sorting).')), 1 /* TEXT */)
                    ]),
                    _createElementVNode("p", _hoisted_543, [
                      _createTextVNode("⚠️ " + _toDisplayString(_ctx.t('If you forget the master key, your encrypted secret fields ')), 1 /* TEXT */),
                      _createElementVNode("b", null, _toDisplayString(_ctx.t('can never be recovered')), 1 /* TEXT */),
                      _createTextVNode(_toDisplayString(_ctx.t('. Be sure to keep it somewhere safe.')), 1 /* TEXT */)
                    ]),
                    _createElementVNode("div", _hoisted_544, [
                      _createElementVNode("label", null, _toDisplayString(_ctx.t('Master key (6+ characters)')), 1 /* TEXT */),
                      _withDirectives(_createElementVNode("input", {
                        type: "password",
                        "onUpdate:modelValue": _cache[178] || (_cache[178] = $event => ((_ctx.encForm.next) = $event)),
                        autocomplete: "new-password"
                      }, null, 512 /* NEED_PATCH */), [
                        [_vModelText, _ctx.encForm.next]
                      ])
                    ]),
                    _createElementVNode("div", _hoisted_545, [
                      _createElementVNode("label", null, _toDisplayString(_ctx.t('Enter it again to confirm')), 1 /* TEXT */),
                      _withDirectives(_createElementVNode("input", {
                        type: "password",
                        "onUpdate:modelValue": _cache[179] || (_cache[179] = $event => ((_ctx.encForm.next2) = $event)),
                        autocomplete: "new-password"
                      }, null, 512 /* NEED_PATCH */), [
                        [_vModelText, _ctx.encForm.next2]
                      ])
                    ]),
                    _createElementVNode("label", _hoisted_546, [
                      _withDirectives(_createElementVNode("input", {
                        type: "checkbox",
                        "onUpdate:modelValue": _cache[180] || (_cache[180] = $event => ((_ctx.encForm.remember) = $event))
                      }, null, 512 /* NEED_PATCH */), [
                        [_vModelCheckbox, _ctx.encForm.remember]
                      ]),
                      _createTextVNode(" " + _toDisplayString(_ctx.t('Remember on this device (no re-entry until logout)')), 1 /* TEXT */)
                    ]),
                    (_ctx.encForm.err)
                      ? (_openBlock(), _createElementBlock("div", _hoisted_547, _toDisplayString(_ctx.encForm.err), 1 /* TEXT */))
                      : _createCommentVNode("v-if", true),
                    (_ctx.encForm.busy)
                      ? (_openBlock(), _createElementBlock("div", _hoisted_548, _toDisplayString(_ctx.t('Encrypting…')) + " " + _toDisplayString(_ctx.encForm.progress) + _toDisplayString(_ctx.t('(please do not close the page)')), 1 /* TEXT */))
                      : _createCommentVNode("v-if", true)
                  ]),
                  _createElementVNode("div", _hoisted_549, [
                    _createElementVNode("button", {
                      class: "btn",
                      disabled: _ctx.encForm.busy,
                      onClick: _cache[181] || (_cache[181] = $event => (_ctx.modal=null))
                    }, _toDisplayString(_ctx.t('Cancel')), 9 /* TEXT, PROPS */, _hoisted_550),
                    _createElementVNode("button", {
                      class: "btn primary",
                      disabled: _ctx.encForm.busy,
                      onClick: _cache[182] || (_cache[182] = (...args) => (_ctx.enableEncryption && _ctx.enableEncryption(...args)))
                    }, _toDisplayString(_ctx.t('Enable and encrypt')), 9 /* TEXT, PROPS */, _hoisted_551)
                  ])
                ])
              ]))
            : _createCommentVNode("v-if", true),
          _createCommentVNode(" マスターキー変更 "),
          (_ctx.modal && _ctx.modal.type==='encChange')
            ? (_openBlock(), _createElementBlock("div", {
                key: 16,
                class: "modal-mask",
                onClick: _cache[190] || (_cache[190] = _withModifiers($event => (!_ctx.encForm.busy && (_ctx.modal=null)), ["self"]))
              }, [
                _createElementVNode("div", _hoisted_552, [
                  _createElementVNode("div", _hoisted_553, [
                    _createElementVNode("h3", null, _toDisplayString(_ctx.t('🔑 Change master key')), 1 /* TEXT */),
                    _createElementVNode("button", {
                      class: "icon-btn",
                      disabled: _ctx.encForm.busy,
                      onClick: _cache[184] || (_cache[184] = $event => (_ctx.modal=null))
                    }, "✕", 8 /* PROPS */, _hoisted_554)
                  ]),
                  _createElementVNode("div", _hoisted_555, [
                    _createElementVNode("p", _hoisted_556, _toDisplayString(_ctx.t('All secret fields are re-encrypted with the new master key. Please do not close the page while this runs.')), 1 /* TEXT */),
                    _createElementVNode("div", _hoisted_557, [
                      _createElementVNode("label", null, _toDisplayString(_ctx.t('Current master key')), 1 /* TEXT */),
                      _withDirectives(_createElementVNode("input", {
                        type: "password",
                        "onUpdate:modelValue": _cache[185] || (_cache[185] = $event => ((_ctx.encForm.cur) = $event)),
                        autocomplete: "off"
                      }, null, 512 /* NEED_PATCH */), [
                        [_vModelText, _ctx.encForm.cur]
                      ])
                    ]),
                    _createElementVNode("div", _hoisted_558, [
                      _createElementVNode("label", null, _toDisplayString(_ctx.t('New master key (6+ characters)')), 1 /* TEXT */),
                      _withDirectives(_createElementVNode("input", {
                        type: "password",
                        "onUpdate:modelValue": _cache[186] || (_cache[186] = $event => ((_ctx.encForm.next) = $event)),
                        autocomplete: "new-password"
                      }, null, 512 /* NEED_PATCH */), [
                        [_vModelText, _ctx.encForm.next]
                      ])
                    ]),
                    _createElementVNode("div", _hoisted_559, [
                      _createElementVNode("label", null, _toDisplayString(_ctx.t('Enter it again to confirm')), 1 /* TEXT */),
                      _withDirectives(_createElementVNode("input", {
                        type: "password",
                        "onUpdate:modelValue": _cache[187] || (_cache[187] = $event => ((_ctx.encForm.next2) = $event)),
                        autocomplete: "new-password"
                      }, null, 512 /* NEED_PATCH */), [
                        [_vModelText, _ctx.encForm.next2]
                      ])
                    ]),
                    (_ctx.encForm.err)
                      ? (_openBlock(), _createElementBlock("div", _hoisted_560, _toDisplayString(_ctx.encForm.err), 1 /* TEXT */))
                      : _createCommentVNode("v-if", true),
                    (_ctx.encForm.busy)
                      ? (_openBlock(), _createElementBlock("div", _hoisted_561, _toDisplayString(_ctx.t('Re-encrypting…')) + " " + _toDisplayString(_ctx.encForm.progress), 1 /* TEXT */))
                      : _createCommentVNode("v-if", true)
                  ]),
                  _createElementVNode("div", _hoisted_562, [
                    _createElementVNode("button", {
                      class: "btn",
                      disabled: _ctx.encForm.busy,
                      onClick: _cache[188] || (_cache[188] = $event => (_ctx.modal=null))
                    }, _toDisplayString(_ctx.t('Cancel')), 9 /* TEXT, PROPS */, _hoisted_563),
                    _createElementVNode("button", {
                      class: "btn primary",
                      disabled: _ctx.encForm.busy,
                      onClick: _cache[189] || (_cache[189] = (...args) => (_ctx.changeMasterKey && _ctx.changeMasterKey(...args)))
                    }, _toDisplayString(_ctx.t('Change')), 9 /* TEXT, PROPS */, _hoisted_564)
                  ])
                ])
              ]))
            : _createCommentVNode("v-if", true),
          _createCommentVNode(" 一括削除（厳重確認） "),
          (_ctx.modal && _ctx.modal.type==='bulkDelete')
            ? (_openBlock(), _createElementBlock("div", {
                key: 17,
                class: "modal-mask",
                onClick: _cache[195] || (_cache[195] = _withModifiers($event => (_ctx.modal=null), ["self"]))
              }, [
                _createElementVNode("div", _hoisted_565, [
                  _createElementVNode("div", _hoisted_566, [
                    _createElementVNode("h3", null, _toDisplayString(_ctx.t('⚠️ Delete records')), 1 /* TEXT */),
                    _createElementVNode("button", {
                      class: "icon-btn",
                      onClick: _cache[191] || (_cache[191] = $event => (_ctx.modal=null))
                    }, "✕")
                  ]),
                  _createElementVNode("div", _hoisted_567, [
                    _createElementVNode("p", _hoisted_568, _toDisplayString(_ctx.t('Permanently delete the {n} selected records.', {n: _ctx.selectedIds.length})), 1 /* TEXT */),
                    _createElementVNode("p", _hoisted_569, _toDisplayString(_ctx.t('This action cannot be undone. Deleted data cannot be recovered.')), 1 /* TEXT */),
                    _createElementVNode("label", _hoisted_570, [
                      _withDirectives(_createElementVNode("input", {
                        type: "checkbox",
                        "onUpdate:modelValue": _cache[192] || (_cache[192] = $event => ((_ctx.delConfirm) = $event))
                      }, null, 512 /* NEED_PATCH */), [
                        [_vModelCheckbox, _ctx.delConfirm]
                      ]),
                      _createTextVNode(" " + _toDisplayString(_ctx.t('I understand the above and confirm the deletion')), 1 /* TEXT */)
                    ])
                  ]),
                  _createElementVNode("div", _hoisted_571, [
                    _createElementVNode("button", {
                      class: "btn",
                      onClick: _cache[193] || (_cache[193] = $event => (_ctx.modal=null))
                    }, _toDisplayString(_ctx.t('Cancel')), 1 /* TEXT */),
                    _createElementVNode("button", {
                      class: "btn danger",
                      disabled: !_ctx.delConfirm || _ctx.busy,
                      onClick: _cache[194] || (_cache[194] = (...args) => (_ctx.commitBulkDelete && _ctx.commitBulkDelete(...args)))
                    }, _toDisplayString(_ctx.t('Delete {n} items', {n: _ctx.selectedIds.length})), 9 /* TEXT, PROPS */, _hoisted_572)
                  ])
                ])
              ]))
            : _createCommentVNode("v-if", true),
          _createCommentVNode(" 画像トリミング "),
          (_ctx.cropper.open)
            ? (_openBlock(), _createElementBlock("div", {
                key: 18,
                class: "modal-mask cropper-mask",
                onClick: _cache[204] || (_cache[204] = _withModifiers($event => (_ctx.cropper.open=false), ["self"]))
              }, [
                _createElementVNode("div", _hoisted_573, [
                  _createElementVNode("div", _hoisted_574, [
                    _createElementVNode("h3", null, _toDisplayString(_ctx.t('✂ Crop image')), 1 /* TEXT */),
                    _createElementVNode("button", {
                      class: "icon-btn",
                      onClick: _cache[196] || (_cache[196] = $event => (_ctx.cropper.open=false))
                    }, "✕")
                  ]),
                  _createElementVNode("div", _hoisted_575, [
                    _createElementVNode("p", _hoisted_576, _toDisplayString(_ctx.t('Drag the box to move, drag a corner to resize.')) + _toDisplayString(_ctx.cropper.ratioLabel==='free' ? _ctx.t('Free ratio') : _ctx.t('Ratio {r}', {r: _ctx.cropper.ratioLabel})) + " " + _toDisplayString(_ctx.t('/ Output width {w}px', {w: _ctx.cropper.out})), 1 /* TEXT */),
                    _createElementVNode("div", {
                      class: "crop-stage",
                      style: _normalizeStyle({width: _ctx.cropper.dispW+'px', height: _ctx.cropper.dispH+'px'})
                    }, [
                      _createElementVNode("img", {
                        src: _ctx.cropper.src,
                        class: "crop-img",
                        draggable: "false",
                        style: _normalizeStyle({width: _ctx.cropper.dispW+'px', height: _ctx.cropper.dispH+'px'})
                      }, null, 12 /* STYLE, PROPS */, _hoisted_577),
                      _createElementVNode("div", {
                        class: "crop-box",
                        style: _normalizeStyle({left:_ctx.cropper.box.x+'px', top:_ctx.cropper.box.y+'px', width:_ctx.cropper.box.w+'px', height:_ctx.cropper.box.h+'px'}),
                        onPointerdown: _cache[201] || (_cache[201] = _withModifiers($event => (_ctx.cropDown($event,'move',null)), ["prevent"]))
                      }, [
                        _createElementVNode("span", {
                          class: "crop-h tl",
                          onPointerdown: _cache[197] || (_cache[197] = _withModifiers($event => (_ctx.cropDown($event,'resize','tl')), ["prevent","stop"]))
                        }, null, 32 /* NEED_HYDRATION */),
                        _createElementVNode("span", {
                          class: "crop-h tr",
                          onPointerdown: _cache[198] || (_cache[198] = _withModifiers($event => (_ctx.cropDown($event,'resize','tr')), ["prevent","stop"]))
                        }, null, 32 /* NEED_HYDRATION */),
                        _createElementVNode("span", {
                          class: "crop-h bl",
                          onPointerdown: _cache[199] || (_cache[199] = _withModifiers($event => (_ctx.cropDown($event,'resize','bl')), ["prevent","stop"]))
                        }, null, 32 /* NEED_HYDRATION */),
                        _createElementVNode("span", {
                          class: "crop-h br",
                          onPointerdown: _cache[200] || (_cache[200] = _withModifiers($event => (_ctx.cropDown($event,'resize','br')), ["prevent","stop"]))
                        }, null, 32 /* NEED_HYDRATION */)
                      ], 36 /* STYLE, NEED_HYDRATION */)
                    ], 4 /* STYLE */)
                  ]),
                  _createElementVNode("div", _hoisted_578, [
                    _createElementVNode("button", {
                      class: "btn",
                      onClick: _cache[202] || (_cache[202] = $event => (_ctx.cropper.open=false))
                    }, _toDisplayString(_ctx.t('Cancel')), 1 /* TEXT */),
                    _createElementVNode("button", {
                      class: "btn primary",
                      disabled: _ctx.cropper.busy,
                      onClick: _cache[203] || (_cache[203] = (...args) => (_ctx.confirmCrop && _ctx.confirmCrop(...args)))
                    }, _toDisplayString(_ctx.t('Crop and use')), 9 /* TEXT, PROPS */, _hoisted_579)
                  ])
                ])
              ]))
            : _createCommentVNode("v-if", true),
          _createCommentVNode(" ノート選択（Notesアプリ連携） "),
          (_ctx.notePicker.open)
            ? (_openBlock(), _createElementBlock("div", {
                key: 19,
                class: "modal-mask cropper-mask",
                onClick: _cache[208] || (_cache[208] = _withModifiers($event => (_ctx.notePicker.open=false), ["self"]))
              }, [
                _createElementVNode("div", _hoisted_580, [
                  _createElementVNode("div", _hoisted_581, [
                    _createElementVNode("h3", null, _toDisplayString(_ctx.t('📝 Attach a note')), 1 /* TEXT */),
                    _createElementVNode("button", {
                      class: "icon-btn",
                      onClick: _cache[205] || (_cache[205] = $event => (_ctx.notePicker.open=false))
                    }, "✕")
                  ]),
                  _createElementVNode("div", _hoisted_582, [
                    (_ctx.notePicker.loading)
                      ? (_openBlock(), _createElementBlock("div", _hoisted_583, [
                          _createElementVNode("p", null, _toDisplayString(_ctx.t('Loading…')), 1 /* TEXT */)
                        ]))
                      : (_ctx.notePicker.error)
                        ? (_openBlock(), _createElementBlock("div", _hoisted_584, [
                            _createElementVNode("p", null, [
                              _createTextVNode(_toDisplayString(_ctx.t('Could not load notes.')), 1 /* TEXT */),
                              _hoisted_585,
                              _createTextVNode(_toDisplayString(_ctx.notePicker.error), 1 /* TEXT */)
                            ])
                          ]))
                        : (_ctx.notePicker.step==='cat')
                          ? (_openBlock(), _createElementBlock(_Fragment, { key: 2 }, [
                              _createElementVNode("p", _hoisted_586, _toDisplayString(_ctx.t('Please choose a category.')), 1 /* TEXT */),
                              (!_ctx.notePicker.categories.length)
                                ? (_openBlock(), _createElementBlock("div", _hoisted_587, [
                                    _createElementVNode("p", null, [
                                      _createTextVNode(_toDisplayString(_ctx.t('No notes.')), 1 /* TEXT */),
                                      _hoisted_588,
                                      _createTextVNode(_toDisplayString(_ctx.t('Create them in the Notes app.')), 1 /* TEXT */)
                                    ])
                                  ]))
                                : (_openBlock(), _createElementBlock("div", _hoisted_589, [
                                    (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.notePicker.categories, (c) => {
                                      return (_openBlock(), _createElementBlock("button", {
                                        key: c.name,
                                        type: "button",
                                        class: "note-item",
                                        onClick: $event => (_ctx.selectNoteCategory(c.name))
                                      }, [
                                        _createElementVNode("span", _hoisted_591, "📂 " + _toDisplayString(c.name || _ctx.t('(no category)')), 1 /* TEXT */),
                                        _createElementVNode("span", _hoisted_592, _toDisplayString(c.count), 1 /* TEXT */)
                                      ], 8 /* PROPS */, _hoisted_590))
                                    }), 128 /* KEYED_FRAGMENT */))
                                  ]))
                            ], 64 /* STABLE_FRAGMENT */))
                          : (_openBlock(), _createElementBlock(_Fragment, { key: 3 }, [
                              _createElementVNode("button", {
                                type: "button",
                                class: "btn sm",
                                style: {"margin-bottom":"10px"},
                                onClick: _cache[206] || (_cache[206] = $event => (_ctx.notePicker.step='cat'))
                              }, _toDisplayString(_ctx.t('← Back to categories')), 1 /* TEXT */),
                              _createElementVNode("div", _hoisted_593, "📂 " + _toDisplayString(_ctx.notePicker.category || _ctx.t('(no category)')), 1 /* TEXT */),
                              (!_ctx.notesInCategory().length)
                                ? (_openBlock(), _createElementBlock("div", _hoisted_594, [
                                    _createElementVNode("p", null, _toDisplayString(_ctx.t('No notes in this category.')), 1 /* TEXT */)
                                  ]))
                                : (_openBlock(), _createElementBlock("div", _hoisted_595, [
                                    (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.notesInCategory(), (n) => {
                                      return (_openBlock(), _createElementBlock("button", {
                                        key: n.id,
                                        type: "button",
                                        class: "note-item",
                                        onClick: $event => (_ctx.pickNote(n))
                                      }, [
                                        _createElementVNode("span", _hoisted_597, _toDisplayString(n.title || _ctx.t('(untitled)')), 1 /* TEXT */)
                                      ], 8 /* PROPS */, _hoisted_596))
                                    }), 128 /* KEYED_FRAGMENT */))
                                  ]))
                            ], 64 /* STABLE_FRAGMENT */))
                  ]),
                  _createElementVNode("div", _hoisted_598, [
                    _createElementVNode("button", {
                      class: "btn",
                      onClick: _cache[207] || (_cache[207] = $event => (_ctx.notePicker.open=false))
                    }, _toDisplayString(_ctx.t('Cancel')), 1 /* TEXT */)
                  ])
                ])
              ]))
            : _createCommentVNode("v-if", true),
          _createCommentVNode(" ファイル選択（自前ブラウザ：未選択では「選択」を押せない） "),
          (_ctx.filePicker.open)
            ? (_openBlock(), _createElementBlock("div", {
                key: 20,
                class: "modal-mask cropper-mask",
                onClick: _cache[213] || (_cache[213] = _withModifiers($event => (_ctx.fpCancel()), ["self"]))
              }, [
                _createElementVNode("div", _hoisted_599, [
                  _createElementVNode("div", _hoisted_600, [
                    _createElementVNode("h3", null, "📂 " + _toDisplayString(_ctx.filePicker.mode==='image' ? _ctx.t('Choose an image') : _ctx.t('Choose a file')), 1 /* TEXT */),
                    _createElementVNode("button", {
                      class: "icon-btn",
                      onClick: _cache[209] || (_cache[209] = $event => (_ctx.fpCancel()))
                    }, "✕")
                  ]),
                  _createElementVNode("div", _hoisted_601, [
                    _createElementVNode("div", _hoisted_602, [
                      _createElementVNode("button", {
                        type: "button",
                        class: "btn sm",
                        disabled: _ctx.filePicker.parent===null || _ctx.filePicker.loading,
                        onClick: _cache[210] || (_cache[210] = $event => (_ctx.fpUp()))
                      }, _toDisplayString(_ctx.t('⬆ Up')), 9 /* TEXT, PROPS */, _hoisted_603),
                      _createElementVNode("span", _hoisted_604, "/" + _toDisplayString(_ctx.filePicker.path), 1 /* TEXT */)
                    ]),
                    (_ctx.filePicker.loading)
                      ? (_openBlock(), _createElementBlock("div", _hoisted_605, [
                          _createElementVNode("p", null, _toDisplayString(_ctx.t('Loading…')), 1 /* TEXT */)
                        ]))
                      : (_ctx.filePicker.error)
                        ? (_openBlock(), _createElementBlock("div", _hoisted_606, [
                            _createElementVNode("p", null, _toDisplayString(_ctx.filePicker.error), 1 /* TEXT */)
                          ]))
                        : (!_ctx.fpVisible.length)
                          ? (_openBlock(), _createElementBlock("div", _hoisted_607, [
                              _createElementVNode("p", null, _toDisplayString(_ctx.t('Nothing to show.')), 1 /* TEXT */)
                            ]))
                          : (_openBlock(), _createElementBlock("div", _hoisted_608, [
                              (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.fpVisible, (x) => {
                                return (_openBlock(), _createElementBlock("button", {
                                  key: x.path,
                                  type: "button",
                                  class: _normalizeClass(["note-item fp-item", {sel: _ctx.filePicker.selected && _ctx.filePicker.selected.path===x.path}]),
                                  onClick: $event => (_ctx.fpClick(x)),
                                  onDblclick: $event => (_ctx.fpDbl(x))
                                }, [
                                  _createElementVNode("span", _hoisted_610, _toDisplayString(x.is_dir ? '📁' : _ctx.fpIcon(x)) + " " + _toDisplayString(x.name), 1 /* TEXT */),
                                  _createElementVNode("span", _hoisted_611, _toDisplayString(x.is_dir ? '›' : ''), 1 /* TEXT */)
                                ], 42 /* CLASS, PROPS, NEED_HYDRATION */, _hoisted_609))
                              }), 128 /* KEYED_FRAGMENT */))
                            ]))
                  ]),
                  _createElementVNode("div", _hoisted_612, [
                    _createElementVNode("button", {
                      type: "button",
                      class: "btn",
                      onClick: _cache[211] || (_cache[211] = $event => (_ctx.fpCancel()))
                    }, _toDisplayString(_ctx.t('Cancel')), 1 /* TEXT */),
                    _createElementVNode("button", {
                      type: "button",
                      class: "btn primary",
                      disabled: !_ctx.filePicker.selected,
                      onClick: _cache[212] || (_cache[212] = $event => (_ctx.fpConfirm()))
                    }, _toDisplayString(_ctx.t('Select')), 9 /* TEXT, PROPS */, _hoisted_613)
                  ])
                ])
              ]))
            : _createCommentVNode("v-if", true),
          (_ctx.toast)
            ? (_openBlock(), _createElementBlock("div", _hoisted_614, _toDisplayString(_ctx.toast), 1 /* TEXT */))
            : _createCommentVNode("v-if", true)
        ]))
}
})();

  createApp({
    data() {
      return {
        authenticated: null,
        collections: [], current: null, records: [], search: '',
        sidebarOpen: false, modal: null,
        form: {}, editingRecordId: null, reveal: {},
        templates: [], templatesLoading: false, schemaFields: [],
        schemaMode: 'collection',
        tplEdit: { row_id: null, key: null, builtin_key: null, name: '', icon: '', color: '', description: '', busy: false },
        dupForm: { name: '', withRecords: false, busy: false },
        collForm: { name: '', icon: '', color: '', description: '' },
        settingsForm: { files_folder: '', theme: 'auto', language: 'auto' },
        languages: [],
        locale: 0,
        backupForm: { password: '', busy: false, err: '' },
        restoreForm: { password: '', busy: false, err: '', fileName: '', dataUrl: '', confirm: false, mode: 'overwrite' },
        contactsImport: { books: [], selected: 'all', name: '', busy: false, err: '', loading: false, enabled: true },
        tablesImport: { tables: [], selected: 0, name: '', busy: false, err: '', loading: false, available: true },
        tablesExportBusy: false,
        apps: { contacts: true, tables: true },
        tableDrag: { active: false, startX: 0, startScroll: 0, el: null, pid: null },
        theme: 'auto',
        enc: { enabled: false, unlocked: false, salt: '', verifier: '' },
        openDecrypted: {},
        // internal sharing (owner-side panel inside collection settings)
        sharePanel: { shares: [], q: '', results: [], searching: false, recipient: null, recipientName: '', perm: 'view', password: '', master: '', shareSecrets: false, err: '', busy: false },
        // recipient-side unlock prompt for a password-protected shared collection
        shareUnlock: { open: false, cid: null, name: '', hasSecrets: false, password: '', err: '', busy: false, next: null },
        // reactive mirror of sharedKeys presence (cid -> true) so the UI reacts to unlock
        secretUnlocked: {},
        editingOrig: null,
        permOpen: false,
        iconPickerOpen: false,
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
          { key: 'detail', label: 'Detailed list', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-dasharray="3 2.2"><path d="M3 5h18M3 9.5h18M3 14h18M3 18.5h18"/></svg>' },
          { key: 'table', label: 'Table', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3.5" y="3.5" width="17" height="17"/><path d="M12 3.5v17M3.5 12h17"/></svg>' },
          { key: 'card', label: 'Cards', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3.5" y="3.5" width="7.4" height="7.4"/><rect x="13.1" y="3.5" width="7.4" height="7.4"/><rect x="3.5" y="13.1" width="7.4" height="7.4"/><rect x="13.1" y="13.1" width="7.4" height="7.4"/></svg>' },
          { key: 'image', label: 'Cards with thumbnails', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3.5" y="3.5" width="17" height="17"/><rect x="6" y="6" width="6.4" height="6.4" fill="currentColor" stroke="none"/><path stroke-width="1.6" stroke-linecap="round" d="M14.6 7h3.9M14.6 10h3.9M6 15h12.5M6 18h12.5"/></svg>' },
        ],
        xfer: { mode: 'copy', recordIds: [], targetId: '', target: null, mapping: {}, appendTo: '', busy: false, newName: '' },
        selectedIds: [], delConfirm: false,
        reorder: { list: [], keys: [{ field: '', dir: 'asc' }], from: null, over: null, busy: false },
        collTip: { show: false, name: '', desc: '', x: 0, y: 0 },
        collDrag: { from: null, over: null },
        uidCounter: 1, dragIndex: null, dragOverIndex: null, dropKey: null,
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
        iconGroups: [
          { key: 'Faces & emotion', emojis: '😀 😃 😄 😁 😆 😅 😂 🤣 😊 😇 🙂 🙃 😉 😌 😍 🥰 😘 😗 😙 😚 😋 😛 😝 😜 🤪 🤨 🧐 🤓 😎 🥸 🤩 🥳 😏 😒 😞 😔 😟 😕 🙁 ☹️ 😣 😖 😫 😩 🥺 😢 😭 😤 😠 😡 🤬 🤯 😳 🥵 🥶 😱 😨 😰 😥 😓 🤗 🤔 🫡 🤭 🫢 🤫 😴 😷 🤒 🤕 🤢 🤮 🥴 😵 🤠'.split(' ') },
          { key: 'Hands', emojis: '👍 👎 👌 🤌 🤏 ✌️ 🤞 🫰 🤟 🤘 🤙 👈 👉 👆 👇 ☝️ ✋ 🤚 🖐️ 🖖 👋 🤝 🙏 ✍️ 💪 👏 🙌 👐 🤲 🫶'.split(' ') },
          { key: 'People', emojis: '👶 🧒 👦 👧 🧑 👨 👩 🧓 👴 👵 👮 🕵️ 💂 👷 🤴 👸 👰 🤵 🧕 🎅 🤶 🦸 🦹 🧙 🧚 🧛 🧜 🧝 👤 👥 🚶 🏃'.split(' ') },
          { key: 'Animals & nature', emojis: '🐶 🐱 🐭 🐹 🐰 🦊 🐻 🐼 🐨 🐯 🦁 🐮 🐷 🐸 🐵 🐔 🐧 🐦 🐤 🦆 🦅 🦉 🐺 🐗 🐴 🦄 🐝 🐛 🦋 🐌 🐞 🐜 🐢 🐍 🦖 🐙 🦑 🦀 🐠 🐟 🐬 🐳 🐋 🦈 🌸 🌷 🌹 🌻 🌼 🌵 🌲 🌳 🍀 🍁 🍂 🌾 ⭐ 🌙 ☀️ ⛅ ☁️ 🌈 ⚡ ❄️ 🔥 💧 🌊'.split(' ') },
          { key: 'Food & drink', emojis: '🍎 🍊 🍋 🍌 🍉 🍇 🍓 🫐 🍒 🍑 🥭 🍍 🥝 🍅 🥑 🥦 🌽 🥕 🥔 🍞 🥐 🥯 🧀 🥚 🍳 🥓 🍔 🍟 🍕 🌭 🥪 🌮 🌯 🍜 🍝 🍣 🍱 🍚 🍙 🍘 🍢 🍡 🍧 🍨 🍦 🍰 🎂 🧁 🍩 🍪 🍫 🍬 🍭 ☕ 🍵 🍶 🍺 🍻 🍷 🥂 🍸 🍹 🥤'.split(' ') },
          { key: 'Travel & places', emojis: '🚗 🚕 🚙 🚌 🚑 🚒 🚓 🏎️ 🚄 🚅 🚆 🚇 🚉 ✈️ 🚀 🛸 🚁 ⛵ 🚤 🚢 🏠 🏡 🏢 🏥 🏦 🏨 🏫 🏪 🗼 🗽 ⛩️ 🏰 🎡 🎢 🗻 🏔️ 🌋 🏖️ 🏝️'.split(' ') },
          { key: 'Objects', emojis: '📱 💻 ⌨️ 🖥️ 🖨️ 📷 📸 🎥 📺 ⏰ ⌚ 📚 📖 ✏️ 📝 📌 📎 🔒 🔑 💡 🔦 🔧 🔨 ⚙️ 🎁 🎈 🎉 🎊 🎀 💰 💳 💎 🔔 🎵 🎶 ⚽ 🏀 ⚾ 🎾 🏐 🏈 🎯 🎮 🎲 ♠️ ♥️ ♦️ ♣️'.split(' ') },
          { key: 'Symbols', emojis: '❤️ 🧡 💛 💚 💙 💜 🖤 🤍 🤎 💔 ❣️ 💕 💞 💓 💗 💖 💘 ✅ ❌ ⭕ ❗ ❓ ⚠️ 💯 🔴 🟠 🟡 🟢 🔵 🟣 ⚫ ⚪ ✨ ⭐ 🌟'.split(' ') },
        ],
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
      isOwner() { return this.current ? this.current.is_owner !== false : true; },
      canEdit() { return ['owner', 'edit', 'delete'].includes(this.curPerm); },
      canDelete() { return ['owner', 'delete'].includes(this.curPerm); },
      // editing collection settings/title needs ownership or the 'delete' level
      canSettings() { return ['owner', 'delete'].includes(this.curPerm); },
      collectionHasSecret() { return !!(this.current && this.current.fields && this.current.fields.some((f) => f.secret)); },
      // recipient viewing a shared collection whose secrets were not shared/unlocked
      secretsMasked() { return !!(this.current && this.current.is_owner === false && !this.secretUnlocked[this.current.id]); },
      shareAccessNote() {
        const map = { view: T('You have view-only access to this shared collection.'),
          edit: T('You can view and edit records in this shared collection.'),
          delete: T('You can view, edit and delete records in this shared collection.') };
        return map[this.curPerm] || '';
      },
      iconGroupsAll() {
        // Fold the curated recommended set in as the first palette category so nothing is lost,
        // then the general themed groups — a single unified picker (same shape as FormulaBase).
        return [{ key: 'Recommended', emojis: this.iconChoices.map((c) => c.e) }, ...this.iconGroups];
      },
      listFields() {
        if (!this.current) return [];
        return this.current.fields.filter((f) => !f.is_title && !f.secret && f.type !== 'image' && f.type !== 'image_crop' && f.type !== 'file').slice(0, 4);
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
      tableFrozen() {
        const fs = this.tableFields;
        return fs.length ? (fs.find((f) => f.is_title) || fs[0]) : null;
      },
      tableScrollFields() {
        const fr = this.tableFrozen;
        return this.tableFields.filter((f) => f !== fr);
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
      await this.boot();
      this.authenticated = true;
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
        try {
          const s = await api('settings'); this.settingsForm = s; this.theme = s.theme || 'auto';
          if (s.apps) this.apps = { contacts: s.apps.contacts !== false, tables: s.apps.tables !== false };
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
        await this.loadCollections();
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
      async loadCollections() { this.collections = await api('collections'); },
      async selectCollection(id, push = true) {
        // a password-protected share must be unlocked (once per session) before opening
        const meta = this.collections.find((c) => c.id === id);
        if (meta && meta.shared_with_me && meta.has_password && !sharedUnlocked[id]) {
          this.promptShareUnlock(id, meta.name, () => this.selectCollection(id, push));
          return;
        }
        this.sidebarOpen = false; this.search = ''; this.selectedIds = [];
        this.current = await api('collections/' + id);
        this.secretUnlocked = { ...this.secretUnlocked, [id]: !!sharedKeys[id] };
        await this.loadRecords();
        if (push) this.pushNav({ cid: id });
      },
      pushNav(state) { try { history.pushState(state, ''); } catch (e) { /* ignore */ } },
      async loadRecords() {
        if (!this.current) return;
        const params = [];
        if (this.search) params.push('q=' + encodeURIComponent(this.search));
        if (this.current.record_sort) params.push('sort=' + encodeURIComponent(this.normSort(this.current.record_sort)));
        const qs = params.length ? '?' + params.join('&') : '';
        this.records = await api('collections/' + this.current.id + '/records' + qs);
        this.renderLimit = 200;
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
            if (changed) await api('records/' + p.id, { method: 'PUT', body: JSON.stringify({ data }) });
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
            if (changed) await api('records/' + p.id, { method: 'PUT', body: JSON.stringify({ data }) });
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
      async saveSettings() {
        try {
          const s = await api('settings', { method: 'PUT', body: JSON.stringify({ files_folder: this.settingsForm.files_folder, theme: this.settingsForm.theme, language: this.settingsForm.language }) });
          this.settingsForm = s; this.theme = s.theme || 'auto'; this.applyTheme();
          this.languages = s.languages || this.languages;
          await this.applyLanguage(s.language || 'auto');
          this.modal = null; this.showToast(T('Settings saved'));
        } catch (e) { alert(T('Failed to save') + ': ' + e.message); }
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
        this.busy = true;
        try {
          const body = { name: tpl.name, icon: tpl.icon, color: tpl.color, description: tpl.description, fields: tpl.fields };
          const c = await api('collections', { method: 'POST', body: JSON.stringify(body) });
          this.modal = null; await this.loadCollections(); await this.selectCollection(c.id);
          this.showToast(T('Collection created'));
        } finally { this.busy = false; }
      },
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
        if (this.modal) this.modal = null;
        if (push) this.pushNav({ cid: null });
      },
      openCollSettings() {
        this.collForm = { name: this.current.name, icon: this.current.icon, color: this.current.color, description: this.current.description || '' };
        this.sharePanel = { shares: [], q: '', results: [], searching: false, recipient: null, recipientName: '', perm: 'view', password: '', master: '', shareSecrets: false, err: '', busy: false };
        this.modal = { type: 'collSettings' };
        this.permOpen = false;
        this.iconPickerOpen = false;
        this.shareExpanded = false;
        if (this.isOwner) this.loadShares();
      },
      // ---- internal sharing (owner side) ----
      shareBadge(c) { if (!c) return ''; if (c.shared_by_me) return '🔗'; if (c.shared_with_me) return '👥'; return ''; },
      shareBadgeTitle(c) { if (!c) return ''; if (c.shared_by_me) return T('Shared by you'); if (c.shared_with_me) return T('Shared with you'); return ''; },
      async loadShares() {
        try { const r = await api('collections/' + this.current.id + '/shares'); this.sharePanel.shares = r.shares || []; }
        catch (e) { /* not owner or none */ }
      },
      async searchShareUsers() {
        const q = this.sharePanel.q.trim();
        if (!q) { this.sharePanel.results = []; return; }
        this.sharePanel.searching = true;
        try {
          const r = await api('users/search?q=' + encodeURIComponent(q));
          const already = new Set(this.sharePanel.shares.map((s) => s.recipient_uid));
          this.sharePanel.results = (r.users || []).filter((u) => !already.has(u.uid));
        } catch (e) { this.sharePanel.results = []; }
        finally { this.sharePanel.searching = false; }
      },
      pickShareUser(u) { this.sharePanel.recipient = u.uid; this.sharePanel.recipientName = u.name; this.sharePanel.results = []; this.sharePanel.q = ''; },
      clearShareRecipient() { this.sharePanel.recipient = null; this.sharePanel.recipientName = ''; },
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
          const body = { recipient: sp.recipient, perm: sp.perm, password: sp.password || '' };
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
        try { const r = await api('collections/' + this.current.id + '/shares/' + encodeURIComponent(s.recipient_uid), { method: 'PATCH', body: JSON.stringify({ perm }) }); s.perm = r.perm; }
        catch (e) { this.showToast(e.message || String(e)); }
      },
      async removeShare(s) {
        if (!confirm(T('Stop sharing with {name}?', { name: s.recipient_name || s.recipient_uid }))) return;
        try {
          await api('collections/' + this.current.id + '/shares/' + encodeURIComponent(s.recipient_uid), { method: 'DELETE' });
          this.sharePanel.shares = this.sharePanel.shares.filter((x) => x.recipient_uid !== s.recipient_uid);
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
        const c = await api('collections/' + this.current.id, { method: 'PATCH', body: JSON.stringify(this.collForm) });
        this.current = { ...this.current, ...c }; await this.loadCollections(); this.modal = null; this.showToast(T('Saved'));
      },
      async deleteCollection() {
        if (!this.isOwner) return;
        if (!confirm(T('Delete the collection “{name}” and all its records. Are you sure?', { name: this.current.name }))) return;
        await api('collections/' + this.current.id, { method: 'DELETE' });
        this.modal = null; this.current = null; this.records = []; await this.loadCollections(); this.showToast(T('Deleted'));
      },
      fieldsToSchemaRows(fields) {
        return (fields || []).map((f) => {
          const o = (f.options && typeof f.options === 'object' && !Array.isArray(f.options)) ? f.options : {};
          return {
            ...f,
            options: (f.type === 'select' && Array.isArray(f.options)) ? f.options.join('\n') : '',
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
          };
        });
      },
      serializeSchemaFields() {
        return this.schemaFields.filter((f) => (f.label || '').trim()).map((f) => {
          let options;
          if (f.type === 'select') options = (f.options || '').split('\n').map((s) => s.trim()).filter(Boolean);
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
          return {
            key: (f.key || '').trim() || slug(f.label),
            label: f.label.trim(), type: f.type, options,
            required: !!f.required, secret: !!f.secret, is_title: !!f.is_title, placeholder: f.placeholder || undefined,
          };
        });
      },
      openSchemaEditor() {
        this.schemaMode = 'collection';
        this.schemaFields = this.fieldsToSchemaRows(this.current.fields);
        this.modal = { type: 'schema' };
      },
      addSchemaField() { this.schemaFields.push({ key: '', label: '', type: 'text', options: '', required: false, secret: false, is_title: false, placeholder: '', _orig: false, _max: 1600, _ratio: '1:1', _out: 600, _format: 'jpeg', _charset: 'none', _pattern: '', _rmin: '', _rmax: '', _uid: this.uidCounter++ }); },
      removeSchemaField(i) { this.schemaFields.splice(i, 1); },
      moveField(i, d) { const j = i + d; if (j < 0 || j >= this.schemaFields.length) return; const a = this.schemaFields; [a[i], a[j]] = [a[j], a[i]]; },
      onFieldDragStart(i, e) {
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
      onFieldDrop(i) { this.moveFieldTo(this.dragIndex, i); this.dragIndex = null; this.dragOverIndex = null; },
      onFieldDragEnd() { this.dragIndex = null; this.dragOverIndex = null; },
      moveFieldTo(from, to) {
        if (from === null || to === null || from === to) return;
        const a = this.schemaFields;
        const [it] = a.splice(from, 1);
        a.splice(to, 0, it);
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
        const isNum = (s) => /^-?[\d.,]+$/.test(s) && isFinite(parseFloat(s.replace(/,/g, '')));
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
      setTitleField(i) { this.schemaFields.forEach((f, k) => (f.is_title = k === i)); },
      async saveSchema() {
        const fields = this.serializeSchemaFields();
        if (!fields.length) { alert(T('Keep at least one field')); return; }
        if (!fields.some((f) => f.is_title)) fields[0].is_title = true;
        const c = await api('collections/' + this.current.id + '/fields', { method: 'PUT', body: JSON.stringify({ fields }) });
        this.current = c; this.modal = null; await this.loadRecords(); this.showToast(T('Fields updated'));
      },
      openNewRecord() {
        if (!this.canEdit) return;
        this.form = {}; this.reveal = {}; this.editingRecordId = null; this.editingOrig = null;
        this.current.fields.forEach((f) => (this.form[f.key] = ''));
        this.modal = { type: 'record' };
      },
      openRecord(rec) { this.reveal = {}; this.openDecrypted = {}; this.preloadFileMetas(this.current.fields, rec.data); this.modal = { type: 'detail', rec }; this.decryptSecretsOf(rec); },
      async editRecord(rec) {
        if (!this.canEdit) return;
        this.form = {}; this.reveal = {}; this.editingRecordId = rec.id; this.editingOrig = rec.data;
        for (const f of this.current.fields) {
          // masked secrets in a shared collection: leave the field blank & read-only,
          // the original ciphertext is preserved on save (see saveRecord)
          if (f.secret && this.secretsMasked) { this.form[f.key] = ''; continue; }
          this.form[f.key] = f.secret ? await this.secretPlain(rec.data[f.key]) : (rec.data[f.key] ?? '');
        }
        this.preloadFileMetas(this.current.fields, rec.data);
        this.modal = { type: 'record' };
      },
      async saveRecord() {
        for (const f of this.current.fields) if (f.required && !String(this.form[f.key] ?? '').trim()) { alert(T('{label} is required', { label: f.label })); return; }
        for (const f of this.current.fields) { const err = this.validateField(f, this.form[f.key]); if (err) { alert(err); return; } }
        let data = {};
        for (const f of this.current.fields) { const v = this.form[f.key]; if (v !== '' && v != null) data[f.key] = v; }
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
        this.contactsImport = { books: [], selected: 'all', name: '', busy: false, err: '', loading: true, enabled: true };
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
          const res = await api('contacts/import', { method: 'POST', body: JSON.stringify({ addressbook: this.contactsImport.selected, name: this.contactsImport.name || '' }) });
          this.modal = null;
          await this.loadCollections();
          this.showToast(T('Imported {n} items', { n: res.imported }));
          if (res.collectionId) this.selectCollection(res.collectionId);
        } catch (e) { this.contactsImport.err = e.message || String(e); }
        finally { this.contactsImport.busy = false; }
      },
      async openTablesImport() {
        this.tablesImport = { tables: [], selected: 0, name: '', busy: false, err: '', loading: true, available: true };
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
          const res = await api('tables/import', { method: 'POST', body: JSON.stringify({ tableId: this.tablesImport.selected, name: this.tablesImport.name || '' }) });
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
      toggleReveal(key) { this.reveal = { ...this.reveal, [key]: !this.reveal[key] }; },
      async copyVal(v) { try { await navigator.clipboard.writeText(String(v)); this.showToast(T('Copied')); } catch { this.showToast(T('Copy failed')); } },
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
      subtitle(rec) { const f = this.current.fields.find((x) => !x.is_title && !x.secret && x.type !== 'image' && x.type !== 'image_crop' && x.type !== 'file' && rec.data[x.key]); return f ? String(rec.data[f.key]) : ''; },
      showToast(m) { this.toast = m; clearTimeout(this._t); this._t = setTimeout(() => (this.toast = ''), 1900); },
      onSearchInput() { this.selectedIds = []; clearTimeout(this._s); this._s = setTimeout(() => this.loadRecords(), 250); },
    },
    render,
  }).mount('#regibase-root');
})();
