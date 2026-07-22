# Changelog

All notable changes to RegiBase.

## 0.12.9 — 2026-07-22

### The icon picker now holds every Unicode emoji

- The collection icon picker used to offer a hand-picked 425 emoji. It now contains the
  **complete Unicode 14.0 set — 1,849 emoji**, in the nine official Unicode groups
  (Smileys & Emotion, People & Body, Animals & Nature, Food & Drink, Travel & Places,
  Activities, Objects, Symbols, Flags), in the official emoji-ordering sequence.
  Flags, arrows, numbers, professions, hair variants, family and couple sequences — all
  of them are now selectable. (Skin-tone variants are not listed separately, matching
  the Unicode emoji-ordering chart itself.) The curated **Recommended** set stays as
  the first tab.
- **Search box**: type to filter across all 1,849 by name or keyword, in your own
  language (CLDR names for all 12 UI languages). Japanese search is kana-insensitive,
  so "ねこ" finds ネコの顔.
- **Group tabs** replace one long scroll, and hovering an emoji shows its name.
- The emoji set is fetched only when the picker is first opened, so the app starts
  just as fast as before.
- The icon input accepts longer sequences (16 units instead of 8, and 16 instead of 4 in
  the CSV/JSON import step), so multi-codepoint emoji such as 🏴󠁧󠁢󠁷󠁬󠁳󠁿 or 👩‍❤️‍💋‍👩 can be typed
  or pasted without being cut off.

### Translations

- The emoji category names and the picker tooltip were only translated into Japanese and
  English; they are now translated into **all 12 languages**.
- Fixed: `Click to choose an icon` was stored outside the `translations` block of
  `l10n/ja.json` and `l10n/en.json`, so it stayed English whenever the in-app language
  selector was used.

### The picker is now available everywhere an icon is set

- The icon picker used to exist only in collection settings. It is now offered in the
  **CSV / JSON import**, the **Contacts import**, the **Tables import** and the
  **template editor** as well — the same picker, shared, so it always shows the same
  1,849 emoji. Contacts and Tables imports previously had no icon field at all and
  always produced 👤 / the table's own emoji; you can now choose one up front.

### Fixed: the Nextcloud user-status menu was broken on RegiBase pages

- RegiBase loads the "global" build of the Vue 3 runtime, which publishes `window.Vue`.
  A third-party library bundled into Nextcloud core (vue-resize) auto-installs into that
  global with the Vue 2 API — `window.Vue.use(...)` — which throws on a Vue 3 namespace
  and aborted the script that renders the user-status menu. RegiBase now keeps its Vue
  copy private and leaves `window.Vue` untouched.

## 0.12.7 — 2026-07-21

- The collection list in the left sidebar can now be **reordered by drag & drop**. Drop
  targets are highlighted while dragging, and the new order is saved immediately (no
  save button). Collections shared with you by other users are not draggable.

## 0.12.6 — 2026-07-21

- Added a Japanese summary/description to the Nextcloud App Store listing, which
  previously had English text only.
- Reorganized the README into a consistent English-then-Japanese layout and added the
  screenshots that were previously missing from it.
- Minor cleanup: unified the author name to “KTEC”.

## 0.12.5 — 2026-07-19

- Collection names in the collection list (sidebar and the home card grid) now wrap to
  **up to three lines** (previously two), with an ellipsis (…) at the end of the last line.
- Hovering a collection in the left sidebar now shows a **popup with its description**.
- In collection settings, the **Delete collection** button is now left-aligned, separated
  from Cancel / Save on the right.

## 0.12.3 — 2026-07-19

- Collection names in the collection list (sidebar and the home card grid) now wrap to
  **up to two lines**, with an ellipsis (…) at the end of the second line when longer —
  instead of being cut off on a single line.

## 0.12.2 — 2026-07-19

### Reorder UX improvements

- **Clearer toolbar**: the view sort is now labelled **👁 View** (display order only),
  visually separated from the outlined **⇅ Edit saved order** button (which rewrites the
  stored registration order). The view options are renamed to “Registration order”.
- **Sort by up to 5 fields**: the reorder dialog now takes multiple sort keys with a
  priority order (add / remove keys), each ascending or descending.
- **Readable preview rows**: each row in the reorder list now shows the record title in
  bold plus the value of every selected sort field, so choosing a field immediately shows
  that field’s content on every row (fixes rows appearing blank).

## 0.12.1 — 2026-07-19

### Reorder records (registration order)

- New **⇅ Reorder** button in the record toolbar (edit permission). It changes the
  **stored registration order** of the records — not just the current view sort.
  - **Drag** rows to arrange records by hand, or
  - **Sort by a field** (ascending / descending) to reorder them by any non-secret,
    non-attachment field's value (numeric-aware).
- Saving writes a per-record `sort` position and switches the view to registration
  order so the result is immediately visible. A new `sort` column is added to the
  records table (existing records keep their current order).

## 0.12.0 — 2026-07-17

### Command-line access (occ)

- New **occ commands** to read RegiBase from the server console / scripts:
  - `occ regibase:collections [--user=UID]` — list collections (with record counts)
  - `occ regibase:records <collection> [--user=UID]` — list a collection's records
  - `occ regibase:get <collection> <record> [--field=KEY] [-o json]` — show one record;
    `--field` prints a single value raw (handy for scripts)
  - `occ regibase:export <collection> [--format=json|csv]` — export a collection
  - `occ regibase:find <collection> <query>` — search records by field value
- All commands are **read-only**. `<collection>` accepts an id or a name.
- **Secret fields** stay encrypted by default (shown masked). Add `--reveal` to
  decrypt them; the master password comes from the `REGIBASE_PASSWORD` environment
  variable or an interactive hidden prompt (or `--password`, discouraged). The
  server-side decrypt mirrors the browser's PBKDF2/AES-GCM exactly and verifies the
  password before revealing anything.

## 0.11.5 — 2026-07-16

- Fix: the collection-settings **icon picker** was clipped by the scrolling modal,
  hiding the lower icons. It now opens as a centered, fully scrollable panel.

## 0.11.4 — 2026-07-16

- App Store **screenshots refreshed** to 0.11.3 — new app icon, colour bands,
  collection sharing, Tables integration, duplication and custom/editable templates.
- Full **Japanese** strings for the icon-picker tooltip and the import example.
- Minor code cleanup (removed an unused import).

## 0.11.3 — 2026-07-16

- Updated the App Store description to cover collection sharing, custom/editable
  templates, collection duplication and Nextcloud Tables integration.

## 0.11.2 — 2026-07-16

- App-menu icon now loads from a versioned filename so icon updates are picked up
  immediately (no browser cache clearing needed).

## 0.11.1 — 2026-07-15

- New **app icon** (database "RB" mark) — monochrome, themable in the app menu and
  as the in-app / sidebar logo (light & dark).
- Packaging: the app-store signature now covers only shipped files.

## 0.11.0 — 2026-07-15

### Duplicate a collection
- **Duplicate** a collection from its settings. A dialog lets you rename the copy
  and, with a checkbox, **also duplicate every record** (data) — attachment files
  are copied too, so the duplicate is fully independent. Left unchecked, you get an
  empty copy with the same fields.

### Custom templates & editable built-in templates
- **Save as template**: turn any collection's field design into a reusable template
  that appears in the New-collection picker.
- **Edit templates**: every template in the picker (built-in or custom) has an edit
  button that opens the field designer plus name / icon / colour / description.
- **Editable built-in templates**: editing a shipped template stores a *personal
  override* — the shipped default is never lost, and **↺ Reset to default** restores it.
- Custom templates can be deleted; each picker card is tagged **Custom** or **Edited**.

## 0.10.13 — 2026-07-15

### Collection sharing (0.10.0)
- Share a collection with other Nextcloud users at three levels: **view / edit / delete**.
  Edit-only cannot rename the collection or delete records; delete adds record deletion;
  field definitions, collection deletion, transfer and re-sharing stay owner-only.
- Optional **access password** for a share (hashed, enforced per session with an unlock prompt).
- Optional **secret-field sharing**: the owner enters their master password once in the share
  panel; the encryption key is wrapped with the share password and stored, so recipients can
  decrypt secret fields — while the server never sees the key or plaintext. Without a master
  password, recipients see secrets masked and cannot reveal or copy them.
- **Share badges** before the title icon on home cards and the sidebar (shared by you /
  shared with you).
- Collection-settings **share panel is collapsible** (▶ / ▼, "click to expand") with a badge
  showing the number of existing shares.

### Nextcloud Tables integration (0.10.3)
- **Import from Tables**: turn a Tables table into a new collection — column types are mapped
  to RegiBase field types (text / number / date / selection …) and rows imported as records.
  Tables is not modified.
- **Export to Tables**: write a collection into a new Tables table. Secret and attachment
  fields are skipped (their stored values are ciphertext / file ids).
- In-process bridge to the Tables app services; the feature is hidden when Tables is absent.

### Imports
- **JSON import** surfaced in the file button ("Import from CSV / JSON file") — already
  supported by the importer, now discoverable.
- **Contacts / Tables** import & export buttons **grey out** when the required app is not installed.

### UI / UX
- Collection **colour band** down the left edge of home cards and before the sidebar icon,
  so the colour is meaningful for identification.
- "Color" renamed to **カラー**; **Color and Icon laid out side by side** (50 / 50).
- **Icon picker is a popup** opened by pressing the icon mark (was an always-open palette).
- **Custom permission dropdown** replacing the native `<select>` for reliable centred rendering
  across browsers.
- **Icons on every section title** in Settings and Collection settings; section bodies
  **indented** so titles stand out.
- **Export section icon**, **Cancel button** on the collection-settings modal, and the New
  collection window title matches the button.
- **Lazy template loading** for a faster home screen.

## 0.9.6

- Internationalization now uses **English as the source language** (the Nextcloud /
  Transifex convention). Japanese and the 10 other languages are translations, so
  community translators can contribute. No user-facing change; all 12 languages work
  as before.

## 0.9.5 — initial public release

Personal database app for Nextcloud with:

- Custom form templates and per-field input rules
- Views: list, detailed list, spreadsheet-style table (frozen first column,
  grab-to-scroll), cards, image gallery
- Optional client-side encryption (AES-GCM) for secret fields
- Password-protected full backup & restore (AES-256 ZIP; overwrite / merge / add)
- Import from CSV / JSON (e.g. Google Password Manager) and from Nextcloud
  Contacts (including photos)
- Attach images and files from Nextcloud Files or Notes
- Move / copy / merge records between collections
- 12-language UI with an in-app language selector

Supports Nextcloud 30–32.
