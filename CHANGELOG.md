# Changelog

All notable changes to RegiBase.

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
