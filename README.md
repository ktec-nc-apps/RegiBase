# RegiBase

A lightweight **personal database** app for Nextcloud. Keep the information you
care about — credit cards, bank accounts, online accounts, memberships, licenses,
contacts and anything else — in collections whose fields **you design yourself**.

> Personal project · self-hosted · your data stays in your Nextcloud.

## Features

- **Custom form templates** — start from a template (credit card, bank account,
  online account, membership, license, contact, …) or design fields from scratch.
- **Per-field input rules** — character set, min/max length, patterns.
- **Multiple views** — list, detailed list, **spreadsheet-style table** (with a
  frozen first column and grab-to-scroll), cards, and an image gallery.
- **Client-side encryption (optional)** — secret fields (passwords, PINs, card
  numbers…) are encrypted in the browser with AES-GCM. The server never sees your
  master key or the plaintext. *Forgetting the master key means the data cannot be
  recovered.*
- **Password-protected backup & restore** — download all data (collections,
  records, settings, attachments) as an **AES-256 encrypted ZIP**, and restore it
  later (overwrite / merge / add).
- **Import** — from **CSV / JSON** (e.g. a Google Password Manager export) or from
  your **Nextcloud Contacts** (including photos). One-way; Contacts is never modified.
- **Attachments** — attach images and files from **Nextcloud Files** or **Notes**.
- **Organise** — move, copy or merge records between collections.
- **12 languages** — 日本語 · English · 简体中文 · Español · Français · Deutsch ·
  Русский · Português · العربية · हिन्दी · 한국어 · Italiano. Pick a language in the
  app independently of your Nextcloud language.

## Screenshots

<!-- Add screenshots here, e.g. -->
<!-- ![Table view](screenshots/table.png) -->

## Requirements

- Nextcloud **30 – 32**
- PHP 8.1+
- A Nextcloud-supported database (MySQL/MariaDB, PostgreSQL or SQLite)

## Installation (manual)

RegiBase is not on the Nextcloud App Store yet. Install from source:

```bash
cd /path/to/nextcloud/apps
git clone https://github.com/ktec-nc-apps/regibase.git
sudo -u www-data php ../occ app:enable regibase
```

Then open **RegiBase** from the Nextcloud app menu.

## Architecture

RegiBase is intentionally **buildless**: the frontend is a single Vue 3
application (`js/regibase.js`) using the vendored Vue global build, and the
backend is a standard Nextcloud app (controllers, QBMapper entities, services).
Because it uses Vue's runtime template compiler, the page enables
`allowEvalScript` in its Content-Security-Policy. A pre-compiled (eval-free)
build would be required for an official App Store submission.

## Third-party

- [Vue.js](https://vuejs.org/) 3 (MIT) — bundled as `js/vue.global.prod.js`.

## License

[GNU AGPL v3](LICENSE) © ktec-jp
