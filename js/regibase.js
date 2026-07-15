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

  const TEMPLATE = `
<div v-if="authenticated === null" class="login-wrap"><div class="login-card"><div class="logo"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1755 2080" fill="currentColor"><g transform="translate(0.000000,2080.000000) scale(0.100000,-0.100000)"
fill="currentColor" stroke="none">
<path d="M8255 19973 c-2667 -49 -4806 -500 -6235 -1315 -153 -88 -459 -294
-580 -391 -270 -217 -526 -493 -596 -642 l-24 -50 0 -7253 c0 -6170 2 -7257
14 -7285 34 -78 339 -330 646 -534 258 -171 469 -290 810 -457 1348 -659 3085
-1065 5095 -1191 1582 -99 3234 -27 4615 200 1456 239 2747 664 3725 1225 423
243 954 644 1002 757 11 27 13 1233 13 7285 l0 7253 -24 50 c-116 246 -550
650 -997 929 -1586 990 -4164 1480 -7464 1419z m1395 -524 c1990 -69 3723
-395 4998 -938 667 -285 1037 -527 1320 -866 167 -199 258 -376 282 -543 5
-40 10 -1065 11 -2532 l1 -2465 -26 -100 c-81 -311 -354 -658 -772 -982 l-111
-86 66 -45 c384 -261 666 -683 784 -1173 53 -217 62 -304 61 -589 0 -240 -3
-278 -27 -410 -45 -250 -115 -465 -219 -674 -185 -370 -428 -622 -895 -931
-70 -46 -88 -65 -60 -65 24 0 252 -118 342 -177 395 -260 668 -657 791 -1153
53 -215 66 -319 71 -597 9 -433 -32 -734 -148 -1086 -236 -718 -770 -1263
-1576 -1606 -323 -137 -942 -327 -1490 -456 -692 -162 -1551 -299 -2388 -379
-166 -16 -1325 -79 -1332 -73 -2 2 182 147 409 322 227 175 417 321 421 325 5
4 -154 135 -354 291 l-362 284 344 22 c941 59 1388 104 1964 194 770 120 1383
267 1975 471 411 141 487 174 602 260 294 222 486 599 539 1058 16 140 6 393
-20 536 -98 530 -429 879 -934 985 -81 17 -135 22 -262 21 -182 -1 -211 -6
-636 -115 -790 -202 -1716 -350 -2679 -427 l-505 -40 -1110 0 c-1146 0 -1240
3 -1710 45 -1183 107 -2379 350 -3577 727 l-228 71 0 615 c0 525 2 613 14 609
55 -21 445 -141 656 -202 983 -282 2025 -476 3126 -580 415 -39 1278 -75 1814
-75 1396 0 2762 150 4045 445 438 100 1043 269 1183 329 359 154 651 467 767
821 139 427 76 891 -166 1215 -223 299 -541 450 -944 450 -170 0 -275 -17
-595 -95 -1307 -317 -2608 -466 -4074 -465 l-451 1 -278 414 c-153 228 -275
420 -272 425 3 6 23 10 43 10 20 0 73 6 117 14 171 30 318 76 670 209 347 131
351 132 775 152 446 20 1225 88 1725 151 752 93 1477 235 2093 409 412 116
968 317 1317 473 l110 50 3 1726 2 1727 -62 -35 c-464 -257 -1437 -566 -2348
-745 -425 -83 -751 -132 -1455 -217 -291 -36 -350 -40 -513 -36 l-137 4 -53
117 c-98 220 -229 436 -368 610 -75 93 -235 256 -312 316 -28 22 -51 43 -52
46 -1 16 285 42 435 40 88 -1 207 3 265 9 58 6 246 24 419 40 884 84 1589 200
2276 375 540 137 927 273 1275 446 316 158 444 258 513 398 29 60 32 74 32
161 0 85 -3 101 -29 150 -40 77 -162 195 -283 274 -507 332 -1656 660 -2958
845 -925 132 -1618 168 -3045 158 -627 -4 -677 -6 -1175 -40 -733 -52 -1047
-82 -1460 -143 -1276 -187 -2303 -491 -2811 -830 -179 -120 -254 -198 -290
-306 l-15 -47 -52 16 c-93 27 -250 92 -357 146 -219 111 -393 233 -604 424
l-129 117 111 108 c356 342 891 634 1672 913 1592 568 3844 839 6270 754z
m-8228 -2390 c606 -480 1469 -828 2783 -1123 926 -208 1965 -340 3215 -411
580 -32 709 -48 940 -114 249 -72 571 -216 755 -338 481 -319 756 -784 847
-1433 17 -127 17 -583 -1 -710 -71 -505 -262 -903 -596 -1235 -240 -240 -521
-411 -861 -524 -348 -115 -642 -155 -1244 -169 l-295 -7 1188 -1745 1188
-1745 -453 -3 c-516 -4 -1177 13 -1194 32 -6 6 -564 823 -1239 1816 -674 993
-1232 1810 -1238 1817 -7 7 -86 21 -177 33 -543 69 -1140 171 -1675 286 -199
43 -659 148 -699 161 -18 5 -18 -46 -11 -2313 5 -1616 4 -2316 -4 -2309 -5 6
-317 458 -691 1005 l-682 995 6 110 c3 61 6 1891 6 4068 l0 3959 24 -19 c13
-10 62 -48 108 -84z m2666 -6288 c436 -76 795 -141 796 -142 6 -6 506 -720
522 -744 14 -22 14 -23 -3 -19 -10 2 -106 20 -213 39 -538 99 -1111 248 -1677
437 l-273 91 0 244 0 245 28 -6 c15 -4 384 -69 820 -145z m-2115 -3717 l675
-971 11 -1057 12 -1058 31 -27 c129 -110 352 -239 558 -322 349 -140 1003
-340 1487 -454 632 -148 1063 -216 1963 -310 289 -31 593 -64 675 -75 169 -22
319 -25 428 -9 l74 11 7 52 c3 28 6 129 6 224 0 105 4 172 9 170 6 -1 318
-241 694 -532 l685 -530 -147 -112 c-914 -702 -1227 -941 -1231 -937 -3 3 -7
94 -10 203 -3 109 -8 201 -11 204 -3 4 -163 15 -355 26 -536 30 -847 58 -1264
110 -1417 181 -2817 538 -3685 943 -405 188 -683 371 -905 596 -138 140 -229
261 -296 393 -70 140 -85 207 -90 398 -8 323 -10 4050 -3 4043 4 -4 311 -445
682 -979z M2667 14873 c-4 -120 -7 -610 -7 -1090 l0 -872 38 -10 c781 -206
1734 -385 2642 -495 866 -106 1990 -173 2282 -137 272 35 478 127 639 286 347
343 385 944 84 1335 -58 75 -169 177 -238 218 -182 110 -337 145 -723 167
-727 40 -1150 80 -1864 174 -963 128 -1453 223 -2133 416 -175 50 -622 191
-703 222 -7 3 -13 -63 -17 -214z"/>
</g></svg></div><p>{{ t('Loading…') }}</p></div></div>

<div v-else-if="enc.enabled && !enc.unlocked" class="login-wrap">
  <form class="login-card" @submit.prevent="doUnlock">
    <div class="logo">🔒</div>
    <h2 style="margin:6px 0 2px">{{ t('Locked') }}</h2>
    <p style="color:var(--muted);font-size:13px;margin:0 0 14px">{{ t('Enter your master key to unlock.') }}</p>
    <input type="password" v-model="unlockKey" :placeholder="t('Master key')" autofocus autocomplete="off" style="width:100%;padding:11px 12px;border-radius:10px;border:1px solid var(--border);background:var(--surface-2);color:var(--text);margin-bottom:8px" />
    <label style="display:flex;align-items:center;gap:6px;font-size:13px;color:var(--muted);margin-bottom:8px;justify-content:center"><input type="checkbox" v-model="unlockRemember" /> {{ t('Remember on this device (no re-entry until logout)') }}</label>
    <div v-if="unlockErr" style="color:var(--danger);font-size:13px;margin-bottom:8px">{{ unlockErr }}</div>
    <button type="submit" class="btn primary block" :disabled="encForm.busy">{{ t('🔓 Unlock') }}</button>
  </form>
</div>

<div v-else class="layout">
  <div class="backdrop" :class="{show: sidebarOpen}" @click="sidebarOpen=false"></div>
  <aside class="sidebar" :class="{open: sidebarOpen}">
    <div class="brand"><span class="logo"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1755 2080" fill="currentColor"><g transform="translate(0.000000,2080.000000) scale(0.100000,-0.100000)"
fill="currentColor" stroke="none">
<path d="M8255 19973 c-2667 -49 -4806 -500 -6235 -1315 -153 -88 -459 -294
-580 -391 -270 -217 -526 -493 -596 -642 l-24 -50 0 -7253 c0 -6170 2 -7257
14 -7285 34 -78 339 -330 646 -534 258 -171 469 -290 810 -457 1348 -659 3085
-1065 5095 -1191 1582 -99 3234 -27 4615 200 1456 239 2747 664 3725 1225 423
243 954 644 1002 757 11 27 13 1233 13 7285 l0 7253 -24 50 c-116 246 -550
650 -997 929 -1586 990 -4164 1480 -7464 1419z m1395 -524 c1990 -69 3723
-395 4998 -938 667 -285 1037 -527 1320 -866 167 -199 258 -376 282 -543 5
-40 10 -1065 11 -2532 l1 -2465 -26 -100 c-81 -311 -354 -658 -772 -982 l-111
-86 66 -45 c384 -261 666 -683 784 -1173 53 -217 62 -304 61 -589 0 -240 -3
-278 -27 -410 -45 -250 -115 -465 -219 -674 -185 -370 -428 -622 -895 -931
-70 -46 -88 -65 -60 -65 24 0 252 -118 342 -177 395 -260 668 -657 791 -1153
53 -215 66 -319 71 -597 9 -433 -32 -734 -148 -1086 -236 -718 -770 -1263
-1576 -1606 -323 -137 -942 -327 -1490 -456 -692 -162 -1551 -299 -2388 -379
-166 -16 -1325 -79 -1332 -73 -2 2 182 147 409 322 227 175 417 321 421 325 5
4 -154 135 -354 291 l-362 284 344 22 c941 59 1388 104 1964 194 770 120 1383
267 1975 471 411 141 487 174 602 260 294 222 486 599 539 1058 16 140 6 393
-20 536 -98 530 -429 879 -934 985 -81 17 -135 22 -262 21 -182 -1 -211 -6
-636 -115 -790 -202 -1716 -350 -2679 -427 l-505 -40 -1110 0 c-1146 0 -1240
3 -1710 45 -1183 107 -2379 350 -3577 727 l-228 71 0 615 c0 525 2 613 14 609
55 -21 445 -141 656 -202 983 -282 2025 -476 3126 -580 415 -39 1278 -75 1814
-75 1396 0 2762 150 4045 445 438 100 1043 269 1183 329 359 154 651 467 767
821 139 427 76 891 -166 1215 -223 299 -541 450 -944 450 -170 0 -275 -17
-595 -95 -1307 -317 -2608 -466 -4074 -465 l-451 1 -278 414 c-153 228 -275
420 -272 425 3 6 23 10 43 10 20 0 73 6 117 14 171 30 318 76 670 209 347 131
351 132 775 152 446 20 1225 88 1725 151 752 93 1477 235 2093 409 412 116
968 317 1317 473 l110 50 3 1726 2 1727 -62 -35 c-464 -257 -1437 -566 -2348
-745 -425 -83 -751 -132 -1455 -217 -291 -36 -350 -40 -513 -36 l-137 4 -53
117 c-98 220 -229 436 -368 610 -75 93 -235 256 -312 316 -28 22 -51 43 -52
46 -1 16 285 42 435 40 88 -1 207 3 265 9 58 6 246 24 419 40 884 84 1589 200
2276 375 540 137 927 273 1275 446 316 158 444 258 513 398 29 60 32 74 32
161 0 85 -3 101 -29 150 -40 77 -162 195 -283 274 -507 332 -1656 660 -2958
845 -925 132 -1618 168 -3045 158 -627 -4 -677 -6 -1175 -40 -733 -52 -1047
-82 -1460 -143 -1276 -187 -2303 -491 -2811 -830 -179 -120 -254 -198 -290
-306 l-15 -47 -52 16 c-93 27 -250 92 -357 146 -219 111 -393 233 -604 424
l-129 117 111 108 c356 342 891 634 1672 913 1592 568 3844 839 6270 754z
m-8228 -2390 c606 -480 1469 -828 2783 -1123 926 -208 1965 -340 3215 -411
580 -32 709 -48 940 -114 249 -72 571 -216 755 -338 481 -319 756 -784 847
-1433 17 -127 17 -583 -1 -710 -71 -505 -262 -903 -596 -1235 -240 -240 -521
-411 -861 -524 -348 -115 -642 -155 -1244 -169 l-295 -7 1188 -1745 1188
-1745 -453 -3 c-516 -4 -1177 13 -1194 32 -6 6 -564 823 -1239 1816 -674 993
-1232 1810 -1238 1817 -7 7 -86 21 -177 33 -543 69 -1140 171 -1675 286 -199
43 -659 148 -699 161 -18 5 -18 -46 -11 -2313 5 -1616 4 -2316 -4 -2309 -5 6
-317 458 -691 1005 l-682 995 6 110 c3 61 6 1891 6 4068 l0 3959 24 -19 c13
-10 62 -48 108 -84z m2666 -6288 c436 -76 795 -141 796 -142 6 -6 506 -720
522 -744 14 -22 14 -23 -3 -19 -10 2 -106 20 -213 39 -538 99 -1111 248 -1677
437 l-273 91 0 244 0 245 28 -6 c15 -4 384 -69 820 -145z m-2115 -3717 l675
-971 11 -1057 12 -1058 31 -27 c129 -110 352 -239 558 -322 349 -140 1003
-340 1487 -454 632 -148 1063 -216 1963 -310 289 -31 593 -64 675 -75 169 -22
319 -25 428 -9 l74 11 7 52 c3 28 6 129 6 224 0 105 4 172 9 170 6 -1 318
-241 694 -532 l685 -530 -147 -112 c-914 -702 -1227 -941 -1231 -937 -3 3 -7
94 -10 203 -3 109 -8 201 -11 204 -3 4 -163 15 -355 26 -536 30 -847 58 -1264
110 -1417 181 -2817 538 -3685 943 -405 188 -683 371 -905 596 -138 140 -229
261 -296 393 -70 140 -85 207 -90 398 -8 323 -10 4050 -3 4043 4 -4 311 -445
682 -979z M2667 14873 c-4 -120 -7 -610 -7 -1090 l0 -872 38 -10 c781 -206
1734 -385 2642 -495 866 -106 1990 -173 2282 -137 272 35 478 127 639 286 347
343 385 944 84 1335 -58 75 -169 177 -238 218 -182 110 -337 145 -723 167
-727 40 -1150 80 -1864 174 -963 128 -1453 223 -2133 416 -175 50 -622 191
-703 222 -7 3 -13 -63 -17 -214z"/>
</g></svg></span><span>RegiBase</span><span class="tag" v-if="version">v{{ version }}</span></div>
    <button class="coll-home" :class="{active: !current}" @click="goHome">{{ t('🗂️ All collections') }}</button>
    <nav class="coll-list">
      <button v-for="c in collections" :key="c.id" class="coll-item" :class="{active: current && current.id===c.id}" @click="selectCollection(c.id)">
        <span class="ci-bar" :style="{background: c.color}"></span><span v-if="shareBadge(c)" class="share-badge" :title="shareBadgeTitle(c)">{{ shareBadge(c) }}</span><span class="ic">{{ c.icon }}</span><span class="nm">{{ c.name }}</span><span class="ct">{{ c.record_count }}</span>
      </button>
      <div v-if="!collections.length" class="empty" style="padding:24px 8px">
        <div>{{ t('No collections yet') }}</div>
      </div>
    </nav>
    <div class="sidebar-foot">
      <button class="btn primary block" @click="openTemplatePicker">{{ t('＋ New collection') }}</button>
      <button class="btn sm block" @click="openSettings" :title="t('Theme, storage location, etc.')">{{ t('⚙️ Settings') }}</button>
    </div>
  </aside>

  <main class="main">
    <div class="topbar">
      <button class="btn ghost hamburger" @click="sidebarOpen=true">☰</button>
      <div class="title" v-if="current"><span v-if="shareBadge(current)" class="share-badge" :title="shareBadgeTitle(current)">{{ shareBadge(current) }}</span><span class="ic">{{ current.icon }}</span><span class="nm">{{ current.name }}</span></div>
      <div class="title" v-else><span class="nm">{{ t('All collections') }}</span></div>
      <div class="spacer"></div>
      <template v-if="current">
        <div class="topbar-actions">
          <div class="viewswitch">
            <button v-for="v in views" :key="v.key" class="vbtn" :class="{on: current.view===v.key}" :title="t(v.label)" @click="setView(v.key)" v-html="v.icon"></button>
          </div>
          <button v-if="isOwner" class="btn sm" @click="openSchemaEditor" :title="t('Edit fields (form)')">{{ t('🧩 Edit collection') }}</button>
          <button class="btn sm" @click="openCollSettings" :title="t('Collection name, description, color, etc.')">{{ t('⚙️ Collection settings') }}</button>
          <button v-if="canEdit" class="btn accent sm" @click="openNewRecord">{{ t('＋ New record') }}</button>
          <div class="ta-break" aria-hidden="true"></div>
        </div>
      </template>
    </div>

    <div class="content" :class="{'content-table': current && current.view==='table' && records.length}" @scroll="onScrollNearBottom">
      <div v-if="!current" class="home">
        <div v-if="collections.length" class="home-grid">
          <button v-for="c in collections" :key="c.id" class="home-card" @click="selectCollection(c.id)">
            <span class="hc-bar" :style="{background: c.color}"></span>
            <div class="hc-icon" :style="{background: c.color + '22', color: c.color}">{{ c.icon }}<span v-if="shareBadge(c)" class="hc-badge" :title="shareBadgeTitle(c)">{{ shareBadge(c) }}</span></div>
            <div class="hc-body">
              <div class="hc-name">{{ c.name }}</div>
              <div class="hc-desc">{{ c.description || t('(no description)') }}</div>
              <div class="hc-count">{{ t('{n} items', {n: c.record_count}) }}</div>
            </div>
          </button>
        </div>
        <div v-else class="empty">
          <div class="big">🗂️</div>
          <p>{{ t('No collections yet.') }}<br>{{ t('Create one from “＋ New collection” on the left.') }}</p>
        </div>
      </div>

      <template v-else>
        <div class="listtoolbar">
          <div class="lt-top">
            <button type="button" class="lt-toggle" :class="{on: selectionMode}" @click="toggleSelectionMode" :title="t('Search, sort & bulk actions')">☰</button>
            <span class="lt-collname"><span v-if="shareBadge(current)" class="share-badge" :title="shareBadgeTitle(current)">{{ shareBadge(current) }}</span><span class="ic">{{ current.icon }}</span>{{ current.name }}</span>
            <span class="lt-count" v-if="records.length">{{ t('{shown} / {total} items', {shown: visibleRecords.length, total: records.length}) }}</span>
          </div>
          <div class="lt-tools" v-show="selectionMode">
          <div class="lt-search">
            <input class="searchinput" v-model="search" @input="onSearchInput" :placeholder="t('🔍 Search in this collection')" />
            <select class="sortselect" :value="normSort(current.record_sort)" @change="setSort($event.target.value)" :title="t('Sort')">
              <option value="created_asc">{{ t('Date added (oldest first)') }}</option>
              <option value="created_desc">{{ t('Date added (newest first)') }}</option>
              <option value="title_asc">{{ t('By name (character code, ascending)') }}</option>
              <option value="title_desc">{{ t('By name (character code, descending)') }}</option>
            </select>
          </div>
          <div class="lt-actions">
            <span class="selcount">{{ selectedIds.length ? t('{n} selected', {n: selectedIds.length}) : t('Select records') }}</span>
            <button class="btn sm ghost" @click="selectAll" :disabled="!records.length">{{ t('Select all') }}</button>
            <button class="btn sm ghost" :disabled="!selectedIds.length" @click="clearSelection">{{ t('Clear') }}</button>
            <span class="selspacer"></span>
            <button v-if="canEdit" class="btn sm" :disabled="!selectedIds.length" @click="duplicateInPlace" :title="t('Duplicate within this collection')">{{ t('Duplicate') }}</button>
            <button v-if="isOwner" class="btn sm" :disabled="!selectedIds.length" @click="openTransferBulk('copy')">{{ t('Copy to collection') }}</button>
            <button v-if="isOwner" class="btn sm" :disabled="!selectedIds.length" @click="openTransferBulk('move')">{{ t('Move to collection') }}</button>
            <button v-if="canDelete" class="btn sm danger" :disabled="!selectedIds.length" @click="openBulkDelete">{{ t('Delete') }}</button>
          </div>
          </div>
        </div>
        <div v-if="!records.length" class="empty">
          <div class="big">{{ current.icon }}</div>
          <p v-if="search">{{ t('No records match “{q}”', {q: search}) }}</p>
          <template v-else><p>{{ t('No records yet') }}</p><button class="btn primary" @click="openNewRecord">{{ t('＋ Add the first record') }}</button></template>
        </div>
        <template v-else>
          <!-- カード型 -->
          <div v-if="current.view==='card'" class="rec-grid">
            <div v-for="r in visibleRecords" :key="r.id" class="rec-wrap card" :class="{sel: isSelected(r.id)}">
              <input type="checkbox" class="rec-check" :checked="isSelected(r.id)" @change="toggleSelect(r.id)" />
              <button class="rec-copy" @click.stop="copyRecord(r)" :title="t('Copy the whole card')">⧉</button>
              <button class="rec-card" @click="openRecord(r)">
                <div class="rt">{{ r.title }}</div>
                <div class="rl"><span>{{ subtitle(r) }}</span></div>
              </button>
            </div>
          </div>
          <!-- リスト型 -->
          <div v-else-if="current.view==='list'" class="rec-list">
            <div v-for="r in visibleRecords" :key="r.id" class="rec-wrap row" :class="{sel: isSelected(r.id)}">
              <input type="checkbox" class="rec-check inline" :checked="isSelected(r.id)" @change="toggleSelect(r.id)" />
              <button class="rec-row" @click="openRecord(r)">
                <span class="rr-title">{{ r.title }}</span>
                <span class="rr-sub">{{ subtitle(r) }}</span>
                <span class="rr-chev">›</span>
              </button>
              <button class="rec-copy inline" @click.stop="copyRecord(r)" :title="t('Copy the whole card')">⧉</button>
            </div>
          </div>
          <!-- リスト詳細型 -->
          <div v-else-if="current.view==='detail'" class="rec-dlist">
            <div v-for="r in visibleRecords" :key="r.id" class="rec-wrap row" :class="{sel: isSelected(r.id)}">
              <input type="checkbox" class="rec-check inline" :checked="isSelected(r.id)" @change="toggleSelect(r.id)" />
              <button class="rec-drow" @click="openRecord(r)">
                <div class="rr-title">{{ r.title }}</div>
                <div class="rr-fields">
                  <span v-for="f in listFields" :key="f.key" v-show="r.data[f.key]!=null && r.data[f.key]!==''" class="rr-field">
                    <b>{{ f.label }}:</b> {{ cellPreview(r, f) }}
                  </span>
                </div>
              </button>
              <button class="rec-copy inline" @click.stop="copyRecord(r)" :title="t('Copy the whole card')">⧉</button>
            </div>
          </div>
          <!-- 表計算型（左端の項目を固定／2列目以降はドラッグで横スクロール） -->
          <div v-else-if="current.view==='table'" class="rec-table-wrap" :class="{dragging: tableDrag.active}"
               @scroll="onScrollNearBottom"
               @pointerdown="tableDown" @pointermove="tableMove" @pointerup="tableUp" @pointercancel="tableUp">
            <table class="rec-table">
              <thead>
                <tr>
                  <th class="rt-frozen"><label class="rt-fhead"><input type="checkbox" :checked="allSelected" @change="allSelected ? clearSelection() : selectAll()" /><span v-if="tableFrozen">{{ tableFrozen.label }}</span></label></th>
                  <th v-for="f in tableScrollFields" :key="f.key">{{ f.label }}</th>
                  <th class="rt-actions"></th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="r in visibleRecords" :key="r.id" :class="{sel: isSelected(r.id)}">
                  <td class="rt-frozen">
                    <label class="rt-fcell" @click.stop><input type="checkbox" :checked="isSelected(r.id)" @change="toggleSelect(r.id)" /></label>
                    <span class="rt-fval" :class="{mono: tableFrozen && tableFrozen.secret}" @click="openRecord(r)" :title="t('Edit')">
                      <img v-if="tableFrozen && (tableFrozen.type==='image'||tableFrozen.type==='image_crop') && r.data[tableFrozen.key]" :src="imgUrl(r.data[tableFrozen.key])" class="rt-thumb" loading="lazy" />
                      <template v-else>{{ tableFrozen ? cellPreview(r, tableFrozen) : r.title }}</template>
                    </span>
                  </td>
                  <td v-for="f in tableScrollFields" :key="f.key" :class="{mono: f.secret}">
                    <img v-if="(f.type==='image'||f.type==='image_crop') && r.data[f.key]" :src="imgUrl(r.data[f.key])" class="rt-thumb" loading="lazy" />
                    <span v-else>{{ cellPreview(r, f) }}</span>
                  </td>
                  <td class="rt-actions" @click.stop><button class="rec-copy inline" @click="copyRecord(r)" :title="t('Copy the whole card')">⧉</button></td>
                </tr>
              </tbody>
            </table>
          </div>
          <!-- 画像リスト型 -->
          <div v-else class="rec-imggrid">
            <div v-for="r in visibleRecords" :key="r.id" class="rec-wrap img" :class="{sel: isSelected(r.id)}">
              <input type="checkbox" class="rec-check" :checked="isSelected(r.id)" @change="toggleSelect(r.id)" />
              <button class="rec-copy" @click.stop="copyRecord(r)" :title="t('Copy the whole card')">⧉</button>
              <button class="rec-imgcard" @click="openRecord(r)">
                <div class="thumb"><img v-if="imageSrc(r)" :src="imageSrc(r)" loading="lazy" /><span v-else class="noimg">{{ current.icon }}</span></div>
                <div class="rr-title">{{ r.title }}</div>
                <div class="rr-sub">{{ subtitle(r) }}</div>
              </button>
            </div>
          </div>
        </template>
      </template>
    </div>
    <div v-if="current && records.length && current.view!=='table'" class="scrollnav">
      <button class="scrollnav-btn" @click="scrollToTop" :title="t('To top')">▲</button>
      <button class="scrollnav-btn" @click="scrollToBottom" :title="t('To bottom')">▼</button>
    </div>
  </main>

  <!-- Template picker -->
  <div v-if="modal && modal.type==='template'" class="modal-mask" @click.self="modal=null">
    <div class="modal wide">
      <div class="modal-head"><h3>{{ t('New collection') }}</h3><button class="icon-btn" @click="modal=null">✕</button></div>
      <div class="modal-body">
        <button class="btn block" style="margin-bottom:8px" @click="openImport">{{ t('📥 Import from CSV / JSON file (auto-create fields)') }}</button>
        <button class="btn block" style="margin-bottom:8px" :disabled="!apps.contacts" :title="apps.contacts ? '' : t('The Contacts app is not enabled')" @click="openContactsImport">{{ t('📇 Import from Contacts') }}</button>
        <button class="btn block" style="margin-bottom:14px" :disabled="!apps.tables" :title="apps.tables ? '' : t('The Tables app is not enabled')" @click="openTablesImport">{{ t('📊 Import from Tables') }}</button>
        <div style="font-size:12px;color:var(--muted);margin-bottom:8px">{{ t('Or create from a template:') }}</div>
        <div v-if="templatesLoading && !templates.length" class="empty"><p>{{ t('Loading…') }}</p></div>
        <div v-else class="tpl-grid">
          <div v-for="tpl in templates" :key="tpl.key" class="tpl-card" :class="{disabled: busy}">
            <button type="button" class="tpl-main" :disabled="busy" @click="createFromTemplate(tpl)">
              <div class="th"><span class="ic">{{ tpl.icon }}</span><span class="tpl-name">{{ tpl.name }}</span><span v-if="tpl.custom" class="tpl-tag">{{ t('Custom') }}</span><span v-else-if="tpl.overridden" class="tpl-tag edited">{{ t('Edited') }}</span></div>
              <div class="td">{{ tpl.description }}</div>
            </button>
            <div class="tpl-actions">
              <button type="button" class="icon-btn" :title="t('Edit template')" @click.stop="openTemplateEditor(tpl)">✏️</button>
              <button v-if="tpl.custom" type="button" class="icon-btn" :title="t('Delete template')" @click.stop="deleteTemplate(tpl)">🗑</button>
              <button v-else-if="tpl.overridden" type="button" class="icon-btn" :title="t('Reset to default')" @click.stop="resetTemplate(tpl)">↺</button>
            </div>
          </div>
        </div>
      </div>
      <div class="modal-foot"><button class="btn" @click="modal=null">{{ t('Cancel') }}</button></div>
    </div>
  </div>

  <!-- Record form -->
  <div v-if="modal && modal.type==='record'" class="modal-mask" @click.self="modal=null">
    <form class="modal" @submit.prevent="saveRecord">
      <div class="modal-head"><h3>{{ editingRecordId ? t('Edit record') : t('New record') }}</h3><button type="button" class="icon-btn" @click="modal=null">✕</button></div>
      <div class="modal-body">
        <div v-for="f in current.fields" :key="f.key" class="field">
          <label>{{ f.label }} <span v-if="f.required" class="req">*</span> <span v-if="f.secret" class="chip">{{ t('Secret') }}</span></label>
          <textarea v-if="f.type==='textarea'" v-model="form[f.key]" :placeholder="f.placeholder||''" :maxlength="ruleMax(f)"></textarea>
          <select v-else-if="f.type==='select'" v-model="form[f.key]">
            <option value="">{{ t('— Select —') }}</option>
            <option v-for="o in f.options" :key="o" :value="o">{{ o }}</option>
          </select>
          <div v-else-if="f.type==='image' || f.type==='image_crop'" class="imgfield">
            <div class="dropzone" :class="{over: dropKey===f.key}"
                 @dragover.prevent @dragenter.prevent="dropKey=f.key" @dragleave.prevent="onDropLeave(f.key)" @drop.prevent="onImageDrop($event, f)">
              <img v-if="form[f.key]" :src="imgUrl(form[f.key])" class="imgpreview" />
              <div v-else class="dropzone-hint"><span class="dz-ic">🖼</span>{{ t('Drag & drop an image here') }}<br>{{ f.type==='image_crop' ? t('or choose with the button below (will be cropped)') : t('or choose with the button below') }}</div>
            </div>
            <div class="imgactions">
              <button type="button" class="btn sm" @click="pickImageFromNc(f)">{{ t('📂 Choose file') }}</button>
              <label class="btn sm">{{ t('⬆ Upload') }}<input type="file" accept="image/*" style="display:none" @change="onImagePick($event, f)" /></label>
              <button v-if="form[f.key] && f.type==='image_crop'" type="button" class="btn sm" @click="recropCurrent(f)">{{ t('✂ Re-crop') }}</button>
              <button v-if="form[f.key]" type="button" class="btn sm danger" @click="form[f.key]=''">{{ t('Delete') }}</button>
            </div>
          </div>
          <div v-else-if="f.type==='file'" class="filefield">
            <div v-if="form[f.key]" class="fileattach">
              <span class="fa-ic">{{ fileIcon(form[f.key]) }}</span>
              <span class="fa-name">{{ fileName(form[f.key]) }}</span>
              <button type="button" class="btn sm" @click="openAttachment(form[f.key])">{{ t('Open') }}</button>
              <button type="button" class="btn sm" @click="downloadAttachment(form[f.key])" :title="t('Download')">⬇</button>
              <button type="button" class="btn sm danger" @click="form[f.key]=''">{{ t('Delete') }}</button>
            </div>
            <template v-else>
              <div class="dropzone" :class="{over: dropKey===f.key}"
                   @dragover.prevent @dragenter.prevent="dropKey=f.key" @dragleave.prevent="onDropLeave(f.key)" @drop.prevent="onDocDrop($event, f)">
                <div class="dropzone-hint"><span class="dz-ic">📎</span>{{ t('Drag & drop PDF / Word / Excel / ODF') }}<br>{{ t('or choose and attach below') }}</div>
              </div>
              <div class="imgactions">
                <button type="button" class="btn sm" @click="pickDocFromNc(f)">{{ t('📂 Choose file') }}</button>
                <label class="btn sm">{{ t('⬆ Upload') }}<input type="file" accept=".pdf,.odt,.ods,.odp,.docx,.xlsx" style="display:none" @change="onDocPick($event, f)" /></label>
                <button type="button" class="btn sm" @click="openNotePicker(f)">{{ t('📝 Attach a note') }}</button>
              </div>
            </template>
          </div>
          <div v-else class="control">
            <input :type="inputType(f)" :class="{'secret-mask': f.secret && !reveal[f.key]}" v-model="form[f.key]" :placeholder="(f.secret && secretsMasked) ? t('(hidden — not shared)') : (f.placeholder||'')" :readonly="f.secret && secretsMasked" :autocomplete="f.secret?'off':''" autocorrect="off" autocapitalize="off" spellcheck="false" data-1p-ignore data-lpignore="true" data-bwignore data-form-type="other" :maxlength="ruleMax(f)" />
            <button v-if="f.secret && !secretsMasked" type="button" class="icon-btn" @click="toggleReveal(f.key)">{{ reveal[f.key]?'🙈':'👁' }}</button>
          </div>
          <div v-if="ruleHint(f)" class="rule-hint">📏 {{ ruleHint(f) }}</div>
        </div>
      </div>
      <div class="modal-foot">
        <button v-if="editingRecordId" type="button" class="btn danger" @click="deleteRecord({id:editingRecordId})">{{ t('Delete') }}</button>
        <button type="button" class="btn" @click="modal=null">{{ t('Cancel') }}</button>
        <button type="submit" class="btn primary">{{ t('Save') }}</button>
      </div>
    </form>
  </div>

  <!-- Record detail -->
  <div v-if="modal && modal.type==='detail'" class="modal-mask" @click.self="modal=null">
    <div class="modal">
      <div class="modal-head"><h3>{{ modal.rec.title }}</h3><button class="icon-btn" @click="modal=null">✕</button></div>
      <div class="modal-body">
        <div v-for="f in current.fields" :key="f.key" class="detail-row" v-show="modal.rec.data[f.key] != null && modal.rec.data[f.key] !== ''">
          <div class="dk">{{ f.label }}</div>
          <div class="dv" v-if="f.type==='image' || f.type==='image_crop'"><img :src="imgUrl(modal.rec.data[f.key])" class="imgpreview lg" /></div>
          <div class="dv" v-else-if="f.type==='file'">
            <span class="fa-ic">{{ fileIcon(modal.rec.data[f.key]) }}</span>
            <span class="val">{{ fileName(modal.rec.data[f.key]) }}</span>
            <button class="btn sm" @click="openAttachment(modal.rec.data[f.key])">{{ t('Open') }}</button>
            <button class="btn sm" @click="downloadAttachment(modal.rec.data[f.key])" :title="t('Download')">⬇</button>
          </div>
          <div class="dv" v-else>
            <a v-if="linkFor(f, modal.rec.data[f.key])" class="val link" :href="linkFor(f, modal.rec.data[f.key])" target="_blank" rel="noopener noreferrer">{{ displayVal(modal.rec, f) }}</a>
            <span v-else class="val" :class="{mono: f.secret}">{{ displayVal(modal.rec, f) }}</span>
            <button v-if="f.secret && !secretsMasked" class="icon-btn" @click="toggleReveal(f.key)">{{ reveal[f.key]?'🙈':'👁' }}</button>
            <button v-if="!(f.secret && secretsMasked)" class="icon-btn" @click="copyVal(f.secret ? openDecrypted[f.key] : modal.rec.data[f.key])" :title="t('Copy')">⧉</button>
          </div>
        </div>
      </div>
      <div class="modal-foot">
        <button v-if="canDelete" class="btn danger" @click="deleteRecord(modal.rec)">{{ t('Delete') }}</button>
        <button class="btn" @click="copyRecord(modal.rec)">{{ t('⧉ Copy all') }}</button>
        <button v-if="isOwner" class="btn" @click="openTransfer(modal.rec)">{{ t('↔ Move / Copy') }}</button>
        <button v-if="canEdit" class="btn primary" @click="editRecord(modal.rec)">{{ t('Edit') }}</button>
      </div>
    </div>
  </div>

  <!-- Schema editor -->
  <div v-if="modal && modal.type==='schema'" class="modal-mask" @click.self="modal=null">
    <div class="modal wide">
      <div class="modal-head"><h3>{{ schemaMode==='template' ? (tplEdit.row_id || tplEdit.builtin_key ? t('✏️ Edit template') : t('⭐ New template')) : t('🧩 Design fields (form)') }}</h3><button class="icon-btn" @click="closeSchemaEditor">✕</button></div>
      <div class="modal-body">
        <div v-if="schemaMode==='template'" class="tpl-meta">
          <div class="field-row">
            <div class="field"><label>🏷️ {{ t('Template name') }}</label><input v-model="tplEdit.name" /></div>
            <div class="field" style="max-width:120px"><label>🎨 {{ t('Color') }}</label><input type="color" v-model="tplEdit.color" style="height:44px;padding:4px;width:100%" /></div>
          </div>
          <div class="field-row">
            <div class="field" style="max-width:140px"><label>😀 {{ t('Icon') }}</label><input v-model="tplEdit.icon" maxlength="8" :placeholder="t('Emoji')" /></div>
            <div class="field"><label>📝 {{ t('Description') }}</label><input v-model="tplEdit.description" /></div>
          </div>
        </div>
        <p style="color:var(--muted);font-size:13px;margin-top:0">{{ t('The fields you create here become the input form. ★ = the field used as the list title.') }}</p>
        <div v-for="(f,i) in schemaFields" :key="f._uid" class="schema-row sortable" :class="{dragover: dragOverIndex===i, dragging: dragIndex===i}" @dragover.prevent="onFieldDragOver(i)" @drop.prevent="onFieldDrop(i)" @dragleave="onFieldDragLeave(i)">
          <span class="drag-handle" draggable="true" @dragstart="onFieldDragStart(i, $event)" @dragend="onFieldDragEnd" :title="t('Drag to reorder')">⠿</span>
          <input v-model="f.label" :placeholder="t('Display name (e.g. Password)')" />
          <select v-model="f.type">
            <option value="text">{{ t('Text') }}</option>
            <option value="textarea">{{ t('Multi-line text') }}</option>
            <option value="password">{{ t('Password') }}</option>
            <option value="number">{{ t('Numeric') }}</option>
            <option value="date">{{ t('Date') }}</option>
            <option value="month">{{ t('Year/Month') }}</option>
            <option value="email">{{ t('Email') }}</option>
            <option value="url">URL</option>
            <option value="tel">{{ t('Phone number') }}</option>
            <option value="select">{{ t('Choices') }}</option>
            <option value="image">{{ t('Image (as-is / resize)') }}</option>
            <option value="image_crop">{{ t('Image (crop)') }}</option>
            <option value="file">{{ t('File attachment (PDF/Word/Excel/ODF, notes)') }}</option>
          </select>
          <div style="display:flex;gap:4px;justify-content:flex-end">
            <button class="icon-btn" @click="removeSchemaField(i)" :title="t('Delete')">🗑</button>
          </div>
          <textarea v-if="f.type==='select'" v-model="f.options" :placeholder="t('Enter choices, one per line')" style="grid-column:1/-1;min-height:56px"></textarea>
          <div v-if="f.type==='image'" class="imgcfg">
            <label class="cfg"><input type="checkbox" v-model="f._orig" /> {{ t('Save at original size (no processing)') }}</label>
            <label class="cfg" v-if="!f._orig">{{ t('Max size') }} <input type="number" min="200" max="6000" step="100" v-model.number="f._max" /> px</label>
            <label class="cfg" v-if="!f._orig">{{ t('Save format') }}
              <select v-model="f._format">
                <option value="jpeg">{{ t('JPEG (lightweight)') }}</option>
                <option value="png">{{ t('PNG (high quality, transparency)') }}</option>
                <option value="webp">{{ t('WebP (high compression)') }}</option>
              </select>
            </label>
          </div>
          <div v-else-if="f.type==='image_crop'" class="imgcfg">
            <label class="cfg">{{ t('Ratio') }}
              <select v-model="f._ratio">
                <option value="1:1">{{ t('1:1 (square, portrait)') }}</option>
                <option value="3:4">{{ t('3:4 (portrait)') }}</option>
                <option value="4:3">{{ t('4:3 (landscape)') }}</option>
                <option value="16:9">{{ t('16:9 (wide)') }}</option>
                <option value="free">{{ t('Free') }}</option>
              </select>
            </label>
            <label class="cfg">{{ t('Output width') }} <input type="number" min="100" max="4000" step="50" v-model.number="f._out" /> px</label>
            <label class="cfg">{{ t('Save format') }}
              <select v-model="f._format">
                <option value="jpeg">{{ t('JPEG (lightweight)') }}</option>
                <option value="png">{{ t('PNG (high quality, transparency)') }}</option>
                <option value="webp">{{ t('WebP (high compression)') }}</option>
              </select>
            </label>
          </div>
          <div v-if="ruleTypes.includes(f.type)" class="imgcfg">
            <label class="cfg">{{ t('Character type') }}
              <select v-model="f._charset">
                <option value="none">{{ t('No restriction') }}</option>
                <option value="digits">{{ t('Digits only (0-9)') }}</option>
                <option value="alnum">{{ t('Alphanumeric') }}</option>
                <option value="alpha">{{ t('Letters') }}</option>
                <option value="hex">{{ t('Hexadecimal') }}</option>
                <option value="ascii">{{ t('ASCII (incl. symbols)') }}</option>
                <option value="phone">{{ t('Phone number (digits, +-() )') }}</option>
                <option value="custom">{{ t('Custom (regex)') }}</option>
              </select>
            </label>
            <label class="cfg" v-if="f._charset==='custom'">{{ t('Pattern') }} <input v-model="f._pattern" :placeholder="t('e.g. [0-9]{3}-[0-9]{4}')" style="min-width:150px" /></label>
            <label class="cfg">{{ t('Min') }} <input type="number" min="0" max="9999" v-model.number="f._rmin" style="width:66px" /> {{ t('chars') }}</label>
            <label class="cfg">{{ t('Max') }} <input type="number" min="0" max="99999" v-model.number="f._rmax" style="width:74px" /> {{ t('chars') }}</label>
          </div>
          <div class="flags">
            <label><input type="checkbox" :checked="f.is_title" @change="setTitleField(i)" /> {{ t('★ Title') }}</label>
            <label><input type="checkbox" v-model="f.required" /> {{ t('Required') }}</label>
            <label><input type="checkbox" v-model="f.secret" /> {{ t('Secret (masked)') }}</label>
          </div>
        </div>
        <button class="btn block" @click="addSchemaField">{{ t('＋ Add field') }}</button>
      </div>
      <div class="modal-foot">
        <button class="btn" @click="closeSchemaEditor">{{ t('Cancel') }}</button>
        <button v-if="schemaMode==='template'" class="btn primary" @click="saveTemplate">{{ t('Save template') }}</button>
        <button v-else class="btn primary" @click="saveSchema">{{ t('Save fields') }}</button>
      </div>
    </div>
  </div>

  <!-- Duplicate collection -->
  <div v-if="modal && modal.type==='duplicate'" class="modal-mask" @click.self="modal=null">
    <div class="modal sm">
      <div class="modal-head"><h3>{{ t('📄 Duplicate collection') }}</h3><button class="icon-btn" @click="modal=null">✕</button></div>
      <div class="modal-body">
        <div class="field"><label>🏷️ {{ t('New name') }}</label><input v-model="dupForm.name" /></div>
        <label class="dup-check"><input type="checkbox" v-model="dupForm.withRecords" /> {{ t('Also duplicate the records (data)') }}</label>
        <div style="font-size:12px;color:var(--muted);margin-top:6px">{{ t('Unchecked: an empty copy with the same fields. Checked: also copies every record and its attachments.') }}</div>
      </div>
      <div class="modal-foot">
        <button type="button" class="btn" @click="modal=null">{{ t('Cancel') }}</button>
        <button type="button" class="btn primary" :disabled="dupForm.busy || !dupForm.name.trim()" @click="commitDuplicate">{{ t('Duplicate') }}</button>
      </div>
    </div>
  </div>

  <!-- Collection settings -->
  <div v-if="modal && modal.type==='collSettings'" class="modal-mask" @click.self="modal=null">
    <div class="modal">
      <div class="modal-head"><h3>{{ t('⚙️ Collection settings') }}</h3><button class="icon-btn" @click="modal=null">✕</button></div>
      <div class="modal-body settings-body">
        <div v-if="!isOwner" class="share-note">{{ shareAccessNote }}</div>

        <template v-if="canSettings">
        <div class="field"><label>🏷️ {{ t('Name') }}</label><input v-model="collForm.name" /></div>
        <div class="field"><label>📝 {{ t('Description') }}</label><textarea v-model="collForm.description" :placeholder="t('Description of this collection (shown on the home screen card)')"></textarea></div>
        <div class="field-row">
        <div class="field"><label>🎨 {{ t('Color') }}</label><input type="color" v-model="collForm.color" style="height:44px;padding:4px;width:100%" /></div>
        <div class="field">
          <label>😀 {{ t('Icon') }}</label>
          <div class="iconpick-head">
            <button type="button" class="iconpick-cur" :class="{open: iconPickerOpen}" @click.stop="iconPickerOpen = !iconPickerOpen" :title="t('Click to choose an icon')">{{ collForm.icon || '🗂️' }}</button>
            <input v-model="collForm.icon" maxlength="8" :placeholder="t('Emoji')" />
            <div v-if="iconPickerOpen" class="emoji-popup" @click.stop>
              <div class="emoji-palette">
                <div class="emoji-group" v-for="g in iconGroupsAll" :key="g.key">
                  <div class="emoji-cat">{{ t(g.key) }}</div>
                  <div class="emoji-grid">
                    <button type="button" class="emoji-btn" v-for="em in g.emojis" :key="em"
                            :class="{sel: collForm.icon===em}" @click="collForm.icon = em; iconPickerOpen = false" :title="em">{{ em }}</button>
                  </div>
                </div>
              </div>
            </div>
          </div>
          <div v-if="iconPickerOpen" class="perm-backdrop" @click="iconPickerOpen = false"></div>
        </div>
        </div>
        </template>

        <div v-if="isOwner" class="field share-section" :class="{open: shareExpanded}">
          <button type="button" class="share-toggle" :aria-expanded="shareExpanded ? 'true' : 'false'" @click="shareExpanded = !shareExpanded">
            <span class="share-toggle-label">👥 {{ t('Share settings') }}</span>
            <span class="share-hint"><span class="share-caret">{{ shareExpanded ? '▼' : '▶' }}</span><span v-if="!shareExpanded" class="share-hint-text">{{ t('Click to expand') }}</span></span>
            <span v-if="sharePanel.shares.length" class="share-count">{{ sharePanel.shares.length }}</span>
          </button>
          <div v-show="shareExpanded" class="share-body">
          <div v-if="sharePanel.shares.length" class="share-list">
            <div v-for="s in sharePanel.shares" :key="s.recipient_uid" class="share-row">
              <span class="share-user">{{ s.recipient_name || s.recipient_uid }}</span>
              <select class="share-perm" :value="s.perm" @change="changeSharePerm(s, $event.target.value)">
                <option value="view">{{ t('View') }}</option>
                <option value="edit">{{ t('Edit') }}</option>
                <option value="delete">{{ t('Delete') }}</option>
              </select>
              <span v-if="s.has_password" class="share-flag" :title="t('Password protected')">🔑</span>
              <span v-if="s.shares_secrets" class="share-flag" :title="t('Secret fields shared')">🔓</span>
              <button type="button" class="icon-btn" @click="removeShare(s)" :title="t('Remove share')">🗑</button>
            </div>
          </div>
          <div class="share-add">
            <div class="share-top">
              <div v-if="!sharePanel.recipient" class="share-search">
                <input v-model="sharePanel.q" @input="searchShareUsers" :placeholder="t('Search users to share with…')" autocomplete="off" />
                <div v-if="sharePanel.results.length" class="share-results">
                  <button type="button" v-for="u in sharePanel.results" :key="u.uid" class="share-result" @click="pickShareUser(u)">{{ u.name }} <span class="muted">({{ u.uid }})</span></button>
                </div>
              </div>
              <div v-else class="share-picked">
                <span class="share-user">{{ sharePanel.recipientName }} <span class="muted">({{ sharePanel.recipient }})</span></span>
                <button type="button" class="icon-btn" @click="clearShareRecipient">✕</button>
              </div>
              <div class="perm-wrap" :class="{open: permOpen}" :title="t('Permission')" @click.stop="permOpen = !permOpen">
                <span class="perm-label">{{ permLabel }}</span>
                <span class="perm-arrow" aria-hidden="true">⌄</span>
                <div v-if="permOpen" class="perm-menu" @click.stop>
                  <button type="button" v-for="o in permOptions" :key="o.v" class="perm-opt" :class="{sel: sharePanel.perm === o.v}" @click="sharePanel.perm = o.v; permOpen = false">{{ o.label }}</button>
                </div>
              </div>
              <div v-if="permOpen" class="perm-backdrop" @click="permOpen = false"></div>
            </div>
            <div class="share-opts">
              <div class="so-row">
                <span class="sub">{{ t('Share password (optional)') }}</span>
                <input v-model="sharePanel.password" type="text" :placeholder="t('Blank = no password')" autocomplete="off" data-1p-ignore data-lpignore="true" />
              </div>
              <div v-if="collectionHasSecret && enc.enabled" class="so-row so-secret">
                <span class="sub">{{ t('Show secret fields to the recipient') }}</span>
                <input v-model="sharePanel.master" type="password" :placeholder="t('Your master password (blank = keep secrets hidden)')" autocomplete="off" data-1p-ignore data-lpignore="true" />
                <div class="muted so-hint">{{ t('Requires a share password (used to protect the key). Secrets stay masked without it.') }}</div>
              </div>
            </div>
            <div v-if="sharePanel.err" class="share-err">{{ sharePanel.err }}</div>
            <button type="button" class="btn sm primary" :disabled="!sharePanel.recipient || sharePanel.busy" @click="addShare">{{ t('Share') }}</button>
          </div>
          </div>
        </div>

        <div v-if="isOwner" class="field">
          <label>📄 {{ t('Duplicate / template') }}</label>
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            <button type="button" class="btn sm" @click="openDuplicate">{{ t('📄 Duplicate collection') }}</button>
            <button type="button" class="btn sm" @click="saveAsTemplate">{{ t('⭐ Save as template') }}</button>
          </div>
          <div style="font-size:12px;color:var(--muted);margin-top:4px">{{ t('Duplicate copies the fields (optionally the records). Save as template adds it to the New collection picker.') }}</div>
        </div>

        <div class="field">
          <label>📤 {{ t('Export (all records in this collection)') }}</label>
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            <button type="button" class="btn sm" @click="exportCollection('csv')">{{ t('⬇ Export as CSV') }}</button>
            <button type="button" class="btn sm" @click="exportCollection('json')">{{ t('⬇ Export as JSON') }}</button>
            <button type="button" class="btn sm" :disabled="tablesExportBusy || !apps.tables" :title="apps.tables ? '' : t('The Tables app is not enabled')" @click="exportToTables">{{ t('📊 Export to Tables') }}</button>
          </div>
          <div style="font-size:12px;color:var(--muted);margin-top:4px">{{ t('JSON includes field definitions and can be re-imported into RegiBase directly.') }}</div>
          <div style="font-size:12px;color:var(--muted);margin-top:2px">{{ t('Export to Tables creates a new table. Secret and attachment fields are skipped.') }}</div>
        </div>
      </div>
      <div class="modal-foot">
        <button v-if="isOwner" class="btn danger" @click="deleteCollection">{{ t('Delete collection') }}</button>
        <button type="button" class="btn" @click="modal=null">{{ t('Cancel') }}</button>
        <button v-if="canSettings" class="btn primary" @click="saveCollSettings">{{ t('Save') }}</button>
      </div>
    </div>
  </div>

  <!-- Shared collection unlock (share password) -->
  <div v-if="shareUnlock.open" class="modal-mask" @click.self="cancelShareUnlock">
    <div class="modal sm">
      <div class="modal-head"><h3>{{ t('🔒 Enter share password') }}</h3><button class="icon-btn" @click="cancelShareUnlock">✕</button></div>
      <div class="modal-body">
        <p style="margin-top:0;color:var(--muted)">{{ t('“{name}” is password-protected.', {name: shareUnlock.name}) }}</p>
        <div class="field"><label>{{ t('Share password') }}</label>
          <input v-model="shareUnlock.password" type="password" @keyup.enter="doShareUnlock" autocomplete="off" data-1p-ignore data-lpignore="true" />
        </div>
        <div v-if="shareUnlock.err" class="share-err">{{ shareUnlock.err }}</div>
      </div>
      <div class="modal-foot">
        <button type="button" class="btn" @click="cancelShareUnlock">{{ t('Cancel') }}</button>
        <button class="btn primary" :disabled="shareUnlock.busy" @click="doShareUnlock">{{ t('Unlock') }}</button>
      </div>
    </div>
  </div>

  <!-- Data Import (CSV / JSON) -->
  <div v-if="modal && modal.type==='import'" class="modal-mask" @click.self="modal=null">
    <div class="modal wide">
      <div class="modal-head"><h3>{{ t('📥 Import (CSV / JSON)') }}</h3><button class="icon-btn" @click="modal=null">✕</button></div>
      <div class="modal-body">
        <template v-if="importStep===1">
          <p style="margin-top:0;color:var(--muted);font-size:13px">{{ t('Choose a CSV or JSON file, or paste its contents, and fields (the input form) are created automatically and all rows imported.') }}<br>{{ t('e.g. Google Password Manager CSV export / an array of objects in JSON / RegiBase JSON export.') }}</p>
          <label class="filepick">
            <input type="file" accept=".csv,.json,.txt" @change="onImportFile" />
            <span class="btn sm">{{ t('📄 Choose file') }}</span>
            <span class="filepick-name">{{ importFileName || t('No file selected') }}</span>
          </label>
          <div style="margin:12px 0 6px;color:var(--muted);font-size:12px">{{ t('Or paste the contents (CSV / JSON):') }}</div>
          <textarea v-model="importCsv" :placeholder="importExamplePh" style="width:100%;min-height:150px;padding:11px 12px;border-radius:10px;border:1px solid var(--border);background:var(--surface-2);color:var(--text)"></textarea>
        </template>
        <template v-else>
          <div style="margin-bottom:10px"><span class="chip">{{ t('Detected format:') }} {{ importAnalysis.formatLabel }}</span> <span class="chip">{{ t('{n} items', {n: importAnalysis.rowCount}) }}</span></div>
          <div class="field"><label>{{ t('Collection name') }}</label><input v-model="importColl.name" /></div>
          <div class="field"><label>{{ t('Icon (emoji)') }}</label><input v-model="importColl.icon" maxlength="4" style="width:90px" /></div>
          <p style="color:var(--muted);font-size:12px;margin:4px 0 8px">{{ t('Field settings for each column (★ = list title / Secret = masked):') }}</p>
          <div v-for="(c,i) in importCols" :key="i" class="schema-row">
            <input v-model="c.label" :placeholder="t('Display name')" />
            <select v-model="c.type">
              <option value="text">{{ t('Text') }}</option>
              <option value="textarea">{{ t('Multi-line text') }}</option>
              <option value="password">{{ t('Password') }}</option>
              <option value="url">URL</option>
              <option value="email">{{ t('Email') }}</option>
              <option value="tel">{{ t('Phone number') }}</option>
              <option value="date">{{ t('Date') }}</option>
              <option value="number">{{ t('Numeric') }}</option>
              <option value="image">{{ t('Image') }}</option>
            </select>
            <span class="chip" :title="t('CSV column:')+' '+c.header">{{ c.header }}</span>
            <div class="flags">
              <label><input type="radio" :checked="c.is_title" @change="setImportTitle(i)" /> {{ t('★ Title') }}</label>
              <label><input type="checkbox" v-model="c.secret" /> {{ t('Secret') }}</label>
            </div>
          </div>
        </template>
      </div>
      <div class="modal-foot">
        <button v-if="importStep===2" type="button" class="btn" @click="importStep=1">{{ t('← Back') }}</button>
        <button type="button" class="btn" @click="modal=null">{{ t('Cancel') }}</button>
        <button v-if="importStep===1" type="button" class="btn primary" @click="analyzeImport">{{ t('Analyze') }}</button>
        <button v-else type="button" class="btn primary" :disabled="importBusy" @click="commitImport">{{ t('Import {n} items', {n: importAnalysis.rowCount}) }}</button>
      </div>
    </div>
  </div>

  <!-- 連絡先（Contacts）からインポート -->
  <div v-if="modal && modal.type==='contactsImport'" class="modal-mask" @click.self="!contactsImport.busy && (modal=null)">
    <div class="modal">
      <div class="modal-head"><h3>{{ t('📇 Import from Contacts') }}</h3><button class="icon-btn" :disabled="contactsImport.busy" @click="modal=null">✕</button></div>
      <div class="modal-body">
        <div v-if="contactsImport.loading" class="empty"><p>{{ t('Loading…') }}</p></div>
        <div v-else-if="!contactsImport.enabled || !contactsImport.books.length" class="empty"><p>{{ t('No contacts found') }}</p></div>
        <template v-else>
          <p style="margin-top:0;font-size:13px;color:var(--muted)">{{ t('Import contacts as a new collection. Contacts is not modified.') }}</p>
          <div class="field">
            <label>{{ t('Address book') }}</label>
            <select v-model="contactsImport.selected">
              <option value="all">{{ t('All') }}（{{ t('{n} items', {n: contactsTotal}) }}）</option>
              <option v-for="b in contactsImport.books" :key="b.key" :value="b.key">{{ b.name }}（{{ t('{n} items', {n: b.count}) }}）</option>
            </select>
          </div>
          <div class="field"><label>{{ t('Collection name') }}</label><input v-model="contactsImport.name" :placeholder="t('Contacts')" /></div>
          <div v-if="contactsImport.err" style="color:var(--danger);font-size:13px">{{ contactsImport.err }}</div>
        </template>
      </div>
      <div class="modal-foot">
        <button class="btn" :disabled="contactsImport.busy" @click="modal=null">{{ t('Cancel') }}</button>
        <button v-if="contactsImport.enabled && contactsImport.books.length" class="btn primary" :disabled="contactsImport.busy" @click="commitContactsImport">{{ t('Import') }}</button>
      </div>
    </div>
  </div>

  <!-- Tables からインポート -->
  <div v-if="modal && modal.type==='tablesImport'" class="modal-mask" @click.self="!tablesImport.busy && (modal=null)">
    <div class="modal">
      <div class="modal-head"><h3>{{ t('📊 Import from Tables') }}</h3><button class="icon-btn" :disabled="tablesImport.busy" @click="modal=null">✕</button></div>
      <div class="modal-body">
        <div v-if="tablesImport.loading" class="empty"><p>{{ t('Loading…') }}</p></div>
        <div v-else-if="!tablesImport.available" class="empty"><p>{{ t('The Tables app is not enabled') }}</p></div>
        <div v-else-if="!tablesImport.tables.length" class="empty"><p>{{ t('No tables found') }}</p></div>
        <template v-else>
          <p style="margin-top:0;font-size:13px;color:var(--muted)">{{ t('Import a table as a new collection. Tables is not modified.') }}</p>
          <div class="field">
            <label>{{ t('Source table') }}</label>
            <select v-model="tablesImport.selected">
              <option v-for="tb in tablesImport.tables" :key="tb.id" :value="tb.id">{{ (tb.emoji ? tb.emoji + ' ' : '') + tb.title }}（{{ t('{n} columns', {n: tb.columns}) }}）</option>
            </select>
          </div>
          <div class="field"><label>{{ t('Collection name') }}</label><input v-model="tablesImport.name" :placeholder="tablesSelectedTitle" /></div>
          <div v-if="tablesImport.err" style="color:var(--danger);font-size:13px">{{ tablesImport.err }}</div>
        </template>
      </div>
      <div class="modal-foot">
        <button class="btn" :disabled="tablesImport.busy" @click="modal=null">{{ t('Cancel') }}</button>
        <button v-if="tablesImport.available && tablesImport.tables.length" class="btn primary" :disabled="tablesImport.busy || !tablesImport.selected" @click="commitTablesImport">{{ t('Import') }}</button>
      </div>
    </div>
  </div>

  <!-- 移動 / 複製 -->
  <div v-if="modal && modal.type==='transfer'" class="modal-mask" @click.self="modal=null">
    <div class="modal wide">
      <div class="modal-head"><h3>{{ t('↔ Move / Copy') }}</h3><button class="icon-btn" @click="modal=null">✕</button></div>
      <div class="modal-body">
        <div class="field">
          <label>{{ t('Target') }}</label>
          <div style="font-size:14px;color:var(--muted)">{{ t('{n} records', {n: xfer.recordIds.length}) }}</div>
        </div>
        <div class="field">
          <label>{{ t('Action') }}</label>
          <div class="radios">
            <label><input type="radio" value="copy" v-model="xfer.mode" /> {{ t('Copy (keep original)') }}</label>
            <label><input type="radio" value="move" v-model="xfer.mode" /> {{ t('Move (delete from original)') }}</label>
          </div>
        </div>
        <div class="field">
          <label>{{ t('Destination collection') }}</label>
          <select :value="xfer.targetId" @change="onTransferTarget($event.target.value)">
            <option value="">{{ t('— Select —') }}</option>
            <option value="__newcoll__">{{ t('＋ Create a new collection…') }}</option>
            <option v-for="c in otherCollections" :key="c.id" :value="c.id">{{ c.icon }} {{ c.name }}</option>
          </select>
        </div>
        <div v-if="xfer.targetId==='__newcoll__'" class="field">
          <label>{{ t('New collection name') }}</label>
          <input v-model="xfer.newName" :placeholder="t('Collection name')" />
          <div style="font-size:12px;color:var(--muted);margin-top:4px">{{ newCollDesc() }}</div>
        </div>
        <template v-if="xfer.target">
          <p style="color:var(--muted);font-size:12px;margin:6px 0 8px">{{ t('Field mapping (source → destination). Auto-matched by label. Choose “Add as new field” to create that field in the destination. “Do not import” discards it.') }}</p>
          <div v-for="sf in current.fields" :key="sf.key" class="map-row">
            <span class="map-src" :title="sf.label">
              <span class="ms-label">{{ sf.label }}</span>
              <span class="ms-sample" v-if="xferSample(sf)">{{ xferSample(sf) }}</span>
              <span class="ms-empty" v-else>{{ t('(empty)') }}</span>
            </span>
            <span class="map-arrow">→</span>
            <select v-model="xfer.mapping[sf.key]" :class="{isnew: xfer.mapping[sf.key]==='__new__'}">
              <option value="">{{ t('(do not import)') }}</option>
              <option v-for="tf in xfer.target.fields" :key="tf.key" :value="tf.key">{{ tf.label }}</option>
              <option value="__new__">{{ t('＋ Add as new field ({label})', {label: sf.label}) }}</option>
            </select>
          </div>
          <div class="field" style="margin-top:12px">
            <label>{{ t('Where to keep non-imported fields (prevents data loss, optional)') }}</label>
            <select v-model="xfer.appendTo">
              <option value="">{{ t('Do not append (discard)') }}</option>
              <option v-for="tf in targetTextareas" :key="tf.key" :value="tf.key">{{ t('Append to “{label}” as “field: value”', {label: tf.label}) }}</option>
            </select>
          </div>
        </template>
      </div>
      <div class="modal-foot">
        <button class="btn" @click="modal=null">{{ t('Cancel') }}</button>
        <button class="btn primary" :disabled="xfer.busy || !(xfer.target || (xfer.targetId==='__newcoll__' && xfer.newName && xfer.newName.trim()))" @click="commitTransfer">
          {{ transferLabel() }}
        </button>
      </div>
    </div>
  </div>

  <!-- 保存先設定 -->
  <div v-if="modal && modal.type==='settings'" class="modal-mask" @click.self="modal=null">
    <div class="modal">
      <div class="modal-head"><h3>{{ t('⚙️ Settings') }}</h3><button class="icon-btn" @click="modal=null">✕</button></div>
      <div class="modal-body settings-body">
        <div class="field">
          <label>🌗 {{ t('Theme') }}</label>
          <div class="radios">
            <label><input type="radio" value="auto" v-model="settingsForm.theme" @change="previewTheme" /> {{ t('Default (match Nextcloud)') }}</label>
            <label><input type="radio" value="light" v-model="settingsForm.theme" @change="previewTheme" /> {{ t('Light') }}</label>
            <label><input type="radio" value="dark" v-model="settingsForm.theme" @change="previewTheme" /> {{ t('Dark') }}</label>
          </div>
        </div>
        <div class="field" style="margin-top:16px">
          <label>🌐 {{ t('Language') }}</label>
          <select v-model="settingsForm.language">
            <option value="auto">{{ t('System default (match Nextcloud)') }}</option>
            <option v-for="lg in languages" :key="lg.code" :value="lg.code">{{ lg.name }}</option>
          </select>
          <div style="font-size:12px;color:var(--muted);margin-top:4px">{{ t('The display language switches when you press “Save”.') }}</div>
        </div>
        <div class="field" style="margin-top:16px">
          <label>📁 {{ t('Folder for images and files (path relative to your Files root)') }}</label>
          <input v-model="settingsForm.files_folder" placeholder="RegiBase" />
          <div style="font-size:12px;color:var(--muted);margin-top:4px">{{ t('A subfolder is created per collection and files are stored in plain text. You can also view them in the Files app.') }}<br><code>{{ (settingsForm.files_folder || 'RegiBase') }}/…/</code></div>
        </div>
        <div class="field" style="margin-top:16px;border-top:1px solid var(--border);padding-top:14px">
          <label>{{ t('🔒 Encryption (secret fields) — optional') }}</label>
          <div v-if="enc.enabled" style="font-size:13px;color:var(--muted)">
            <b style="color:var(--accent)">{{ t('Enabled') }}</b>{{ t(': Secret fields such as passwords are encrypted with the master key you entered on this device.') }}<span v-if="hasRemembered()">{{ t('(remembered on this device)') }}</span>
            <div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap">
              <button type="button" class="btn sm" @click="openEncChange">{{ t('Change master key') }}</button>
              <button type="button" class="btn sm" @click="lockNow">{{ t('🔒 Lock now (forget key)') }}</button>
            </div>
          </div>
          <div v-else style="font-size:13px;color:var(--muted)">
            <b>{{ t('Disabled (default)') }}</b>{{ t(': Secret fields are stored in plain text. If you enable it, secret fields are encrypted with your master key and become unreadable even to the server and the administrator.') }}
            <div style="margin-top:8px"><button type="button" class="btn sm primary" @click="openEncSetup">{{ t('🔒 Enable encryption') }}</button></div>
          </div>
        </div>
        <div class="field" style="margin-top:16px;border-top:1px solid var(--border);padding-top:14px">
          <label>💾 {{ t('Backup / Restore') }}</label>
          <div style="font-size:12px;color:var(--muted);margin-bottom:8px">{{ t('Save all collections, records, settings and attachments to a ZIP encrypted with your login password.') }}</div>
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            <button type="button" class="btn sm" @click="openBackup">{{ t('🔒 Download all data') }}</button>
            <button type="button" class="btn sm" @click="openRestore">{{ t('♻ Restore from backup') }}</button>
          </div>
        </div>
      </div>
      <div class="modal-foot">
        <button class="btn" @click="modal=null">{{ t('Cancel') }}</button>
        <button class="btn primary" @click="saveSettings">{{ t('Save') }}</button>
      </div>
    </div>
  </div>

  <!-- 全データのバックアップ -->
  <div v-if="modal && modal.type==='backup'" class="modal-mask" @click.self="!backupForm.busy && (modal=null)">
    <div class="modal">
      <div class="modal-head"><h3>{{ t('🔒 Download all data') }}</h3><button class="icon-btn" :disabled="backupForm.busy" @click="modal=null">✕</button></div>
      <form class="modal-body" @submit.prevent="doBackup">
        <p style="margin-top:0;font-size:13px;color:var(--muted)">{{ t('Enter your login password. The archive (ZIP) is encrypted with the same password.') }}</p>
        <div class="field"><label>{{ t('Login password') }}</label><input type="password" v-model="backupForm.password" autocomplete="current-password" autofocus /></div>
        <div v-if="backupForm.err" style="color:var(--danger);font-size:13px">{{ backupForm.err }}</div>
        <div v-if="backupForm.busy" style="font-size:13px;color:var(--muted)">{{ t('Creating…') }}</div>
      </form>
      <div class="modal-foot">
        <button class="btn" :disabled="backupForm.busy" @click="modal=null">{{ t('Cancel') }}</button>
        <button class="btn primary" :disabled="backupForm.busy" @click="doBackup">{{ t('Download') }}</button>
      </div>
    </div>
  </div>

  <!-- バックアップから復元 -->
  <div v-if="modal && modal.type==='restore'" class="modal-mask" @click.self="!restoreForm.busy && (modal=null)">
    <div class="modal">
      <div class="modal-head"><h3>{{ t('♻ Restore from backup') }}</h3><button class="icon-btn" :disabled="restoreForm.busy" @click="modal=null">✕</button></div>
      <div class="modal-body">
        <label class="filepick">
          <input type="file" accept=".zip" @change="onRestoreFile" />
          <span class="btn sm">{{ t('📄 Choose file') }}</span>
          <span class="filepick-name">{{ restoreForm.fileName || t('Backup file (.zip)') }}</span>
        </label>
        <div class="field" style="margin-top:12px"><label>{{ t('Login password') }}</label><input type="password" v-model="restoreForm.password" autocomplete="current-password" /></div>
        <div class="field">
          <label>{{ t('Restore method') }}</label>
          <div class="radios">
            <label><input type="radio" value="overwrite" v-model="restoreForm.mode" /> {{ t('Overwrite (delete and replace existing data)') }}</label>
            <label><input type="radio" value="merge" v-model="restoreForm.mode" /> {{ t('Merge (import only non-duplicate records)') }}</label>
            <label><input type="radio" value="add" v-model="restoreForm.mode" /> {{ t('Add (as new collections)') }}</label>
          </div>
        </div>
        <template v-if="restoreForm.mode==='overwrite'">
          <p style="color:var(--danger);font-size:13px;background:color-mix(in srgb,var(--danger) 12%,transparent);padding:8px 10px;border-radius:8px">{{ t('⚠️ Overwriting replaces ALL existing data (collections, records, settings).') }}</p>
          <label class="confirm-check"><input type="checkbox" v-model="restoreForm.confirm" /> {{ t('I understand the above and confirm the restore') }}</label>
        </template>
        <div v-if="restoreForm.err" style="color:var(--danger);font-size:13px;margin-top:8px">{{ restoreForm.err }}</div>
        <div v-if="restoreForm.busy" style="font-size:13px;color:var(--muted);margin-top:8px">{{ t('Restoring…') }}</div>
      </div>
      <div class="modal-foot">
        <button class="btn" :disabled="restoreForm.busy" @click="modal=null">{{ t('Cancel') }}</button>
        <button class="btn" :class="restoreForm.mode==='overwrite' ? 'danger' : 'primary'" :disabled="restoreForm.busy || (restoreForm.mode==='overwrite' && !restoreForm.confirm)" @click="doRestore">{{ t('Restore') }}</button>
      </div>
    </div>
  </div>

  <!-- 暗号化を有効にする -->
  <div v-if="modal && modal.type==='encSetup'" class="modal-mask" @click.self="!encForm.busy && (modal=null)">
    <div class="modal">
      <div class="modal-head"><h3>{{ t('🔒 Enable encryption') }}</h3><button class="icon-btn" :disabled="encForm.busy" @click="modal=null">✕</button></div>
      <div class="modal-body">
        <p style="margin-top:0;font-size:13px">{{ t('Secret fields (passwords, PINs, card numbers, etc.) are encrypted with the ') }}<b>{{ t('Master key') }}</b>{{ t(' you enter on this device. The master key is never given to the server or the administrator. Names, URLs, etc. are not encrypted (for search and sorting).') }}</p>
        <p style="color:var(--danger);font-size:13px;background:color-mix(in srgb,var(--danger) 12%,transparent);padding:8px 10px;border-radius:8px">⚠️ {{ t('If you forget the master key, your encrypted secret fields ') }}<b>{{ t('can never be recovered') }}</b>{{ t('. Be sure to keep it somewhere safe.') }}</p>
        <div class="field"><label>{{ t('Master key (6+ characters)') }}</label><input type="password" v-model="encForm.next" autocomplete="new-password" /></div>
        <div class="field"><label>{{ t('Enter it again to confirm') }}</label><input type="password" v-model="encForm.next2" autocomplete="new-password" /></div>
        <label style="display:flex;align-items:center;gap:6px;font-size:13px;color:var(--muted)"><input type="checkbox" v-model="encForm.remember" /> {{ t('Remember on this device (no re-entry until logout)') }}</label>
        <div v-if="encForm.err" style="color:var(--danger);font-size:13px;margin-top:8px">{{ encForm.err }}</div>
        <div v-if="encForm.busy" style="font-size:13px;color:var(--muted);margin-top:8px">{{ t('Encrypting…') }} {{ encForm.progress }}{{ t('(please do not close the page)') }}</div>
      </div>
      <div class="modal-foot">
        <button class="btn" :disabled="encForm.busy" @click="modal=null">{{ t('Cancel') }}</button>
        <button class="btn primary" :disabled="encForm.busy" @click="enableEncryption">{{ t('Enable and encrypt') }}</button>
      </div>
    </div>
  </div>

  <!-- マスターキー変更 -->
  <div v-if="modal && modal.type==='encChange'" class="modal-mask" @click.self="!encForm.busy && (modal=null)">
    <div class="modal">
      <div class="modal-head"><h3>{{ t('🔑 Change master key') }}</h3><button class="icon-btn" :disabled="encForm.busy" @click="modal=null">✕</button></div>
      <div class="modal-body">
        <p style="margin-top:0;font-size:13px;color:var(--muted)">{{ t('All secret fields are re-encrypted with the new master key. Please do not close the page while this runs.') }}</p>
        <div class="field"><label>{{ t('Current master key') }}</label><input type="password" v-model="encForm.cur" autocomplete="off" /></div>
        <div class="field"><label>{{ t('New master key (6+ characters)') }}</label><input type="password" v-model="encForm.next" autocomplete="new-password" /></div>
        <div class="field"><label>{{ t('Enter it again to confirm') }}</label><input type="password" v-model="encForm.next2" autocomplete="new-password" /></div>
        <div v-if="encForm.err" style="color:var(--danger);font-size:13px">{{ encForm.err }}</div>
        <div v-if="encForm.busy" style="font-size:13px;color:var(--muted)">{{ t('Re-encrypting…') }} {{ encForm.progress }}</div>
      </div>
      <div class="modal-foot">
        <button class="btn" :disabled="encForm.busy" @click="modal=null">{{ t('Cancel') }}</button>
        <button class="btn primary" :disabled="encForm.busy" @click="changeMasterKey">{{ t('Change') }}</button>
      </div>
    </div>
  </div>

  <!-- 一括削除（厳重確認） -->
  <div v-if="modal && modal.type==='bulkDelete'" class="modal-mask" @click.self="modal=null">
    <div class="modal">
      <div class="modal-head"><h3>{{ t('⚠️ Delete records') }}</h3><button class="icon-btn" @click="modal=null">✕</button></div>
      <div class="modal-body">
        <p style="font-size:15px;margin-top:0">{{ t('Permanently delete the {n} selected records.', {n: selectedIds.length}) }}</p>
        <p style="color:var(--danger);font-size:13px">{{ t('This action cannot be undone. Deleted data cannot be recovered.') }}</p>
        <label class="confirm-check"><input type="checkbox" v-model="delConfirm" /> {{ t('I understand the above and confirm the deletion') }}</label>
      </div>
      <div class="modal-foot">
        <button class="btn" @click="modal=null">{{ t('Cancel') }}</button>
        <button class="btn danger" :disabled="!delConfirm || busy" @click="commitBulkDelete">{{ t('Delete {n} items', {n: selectedIds.length}) }}</button>
      </div>
    </div>
  </div>

  <!-- 画像トリミング -->
  <div v-if="cropper.open" class="modal-mask cropper-mask" @click.self="cropper.open=false">
    <div class="modal">
      <div class="modal-head"><h3>{{ t('✂ Crop image') }}</h3><button class="icon-btn" @click="cropper.open=false">✕</button></div>
      <div class="modal-body" style="display:flex;flex-direction:column;align-items:center;gap:10px">
        <p style="margin:0;color:var(--muted);font-size:12px;align-self:flex-start">{{ t('Drag the box to move, drag a corner to resize.') }}{{ cropper.ratioLabel==='free' ? t('Free ratio') : t('Ratio {r}', {r: cropper.ratioLabel}) }} {{ t('/ Output width {w}px', {w: cropper.out}) }}</p>
        <div class="crop-stage" :style="{width: cropper.dispW+'px', height: cropper.dispH+'px'}">
          <img :src="cropper.src" class="crop-img" draggable="false" :style="{width: cropper.dispW+'px', height: cropper.dispH+'px'}" />
          <div class="crop-box" :style="{left:cropper.box.x+'px', top:cropper.box.y+'px', width:cropper.box.w+'px', height:cropper.box.h+'px'}" @pointerdown.prevent="cropDown($event,'move',null)">
            <span class="crop-h tl" @pointerdown.prevent.stop="cropDown($event,'resize','tl')"></span>
            <span class="crop-h tr" @pointerdown.prevent.stop="cropDown($event,'resize','tr')"></span>
            <span class="crop-h bl" @pointerdown.prevent.stop="cropDown($event,'resize','bl')"></span>
            <span class="crop-h br" @pointerdown.prevent.stop="cropDown($event,'resize','br')"></span>
          </div>
        </div>
      </div>
      <div class="modal-foot">
        <button class="btn" @click="cropper.open=false">{{ t('Cancel') }}</button>
        <button class="btn primary" :disabled="cropper.busy" @click="confirmCrop">{{ t('Crop and use') }}</button>
      </div>
    </div>
  </div>

  <!-- ノート選択（Notesアプリ連携） -->
  <div v-if="notePicker.open" class="modal-mask cropper-mask" @click.self="notePicker.open=false">
    <div class="modal">
      <div class="modal-head"><h3>{{ t('📝 Attach a note') }}</h3><button class="icon-btn" @click="notePicker.open=false">✕</button></div>
      <div class="modal-body">
        <div v-if="notePicker.loading" class="empty"><p>{{ t('Loading…') }}</p></div>
        <div v-else-if="notePicker.error" class="empty"><p>{{ t('Could not load notes.') }}<br>{{ notePicker.error }}</p></div>
        <template v-else-if="notePicker.step==='cat'">
          <p style="margin-top:0;color:var(--muted);font-size:13px">{{ t('Please choose a category.') }}</p>
          <div v-if="!notePicker.categories.length" class="empty"><p>{{ t('No notes.') }}<br>{{ t('Create them in the Notes app.') }}</p></div>
          <div v-else class="note-list">
            <button v-for="c in notePicker.categories" :key="c.name" type="button" class="note-item" @click="selectNoteCategory(c.name)">
              <span class="ni-title">📂 {{ c.name || t('(no category)') }}</span>
              <span class="ni-cat">{{ c.count }}</span>
            </button>
          </div>
        </template>
        <template v-else>
          <button type="button" class="btn sm" style="margin-bottom:10px" @click="notePicker.step='cat'">{{ t('← Back to categories') }}</button>
          <div style="font-size:12px;color:var(--muted);margin-bottom:6px">📂 {{ notePicker.category || t('(no category)') }}</div>
          <div v-if="!notesInCategory().length" class="empty"><p>{{ t('No notes in this category.') }}</p></div>
          <div v-else class="note-list">
            <button v-for="n in notesInCategory()" :key="n.id" type="button" class="note-item" @click="pickNote(n)">
              <span class="ni-title">{{ n.title || t('(untitled)') }}</span>
            </button>
          </div>
        </template>
      </div>
      <div class="modal-foot"><button class="btn" @click="notePicker.open=false">{{ t('Cancel') }}</button></div>
    </div>
  </div>

  <!-- ファイル選択（自前ブラウザ：未選択では「選択」を押せない） -->
  <div v-if="filePicker.open" class="modal-mask cropper-mask" @click.self="fpCancel()">
    <div class="modal">
      <div class="modal-head"><h3>📂 {{ filePicker.mode==='image' ? t('Choose an image') : t('Choose a file') }}</h3><button class="icon-btn" @click="fpCancel()">✕</button></div>
      <div class="modal-body">
        <div class="fp-path">
          <button type="button" class="btn sm" :disabled="filePicker.parent===null || filePicker.loading" @click="fpUp()">{{ t('⬆ Up') }}</button>
          <span class="fp-cur">/{{ filePicker.path }}</span>
        </div>
        <div v-if="filePicker.loading" class="empty"><p>{{ t('Loading…') }}</p></div>
        <div v-else-if="filePicker.error" class="empty"><p>{{ filePicker.error }}</p></div>
        <div v-else-if="!fpVisible.length" class="empty"><p>{{ t('Nothing to show.') }}</p></div>
        <div v-else class="note-list fp-list">
          <button v-for="x in fpVisible" :key="x.path" type="button" class="note-item fp-item"
                  :class="{sel: filePicker.selected && filePicker.selected.path===x.path}"
                  @click="fpClick(x)" @dblclick="fpDbl(x)">
            <span class="ni-title">{{ x.is_dir ? '📁' : fpIcon(x) }} {{ x.name }}</span>
            <span class="ni-cat">{{ x.is_dir ? '›' : '' }}</span>
          </button>
        </div>
      </div>
      <div class="modal-foot">
        <button type="button" class="btn" @click="fpCancel()">{{ t('Cancel') }}</button>
        <button type="button" class="btn primary" :disabled="!filePicker.selected" @click="fpConfirm()">{{ t('Select') }}</button>
      </div>
    </div>
  </div>

  <div v-if="toast" class="toast">{{ toast }}</div>
</div>
`;

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
    template: TEMPLATE,
  }).mount('#regibase-root');
})();
