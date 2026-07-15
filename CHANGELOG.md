# Changelog

All notable changes to RegiBase.

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
