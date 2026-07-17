# RegiBase 🗄️

**A lightweight personal database for Nextcloud** — keep the information you care
about in collections whose fields **you design yourself**.
**Nextcloud 用の軽量パーソナルデータベース** — 大切な情報を、**自分で設計した項目**の
コレクションにまとめて管理できます。

> Personal project · self-hosted · your data stays in your own Nextcloud.
> 個人プロジェクト · セルフホスト · データはあなた自身の Nextcloud の中だけに保存されます。

`日本語` ↓ · [English ↓](#english)

---

<a id="japanese"></a>

## 日本語

クレジットカード・銀行口座・オンラインアカウント・会員情報・ライセンス・連絡先など、
「覚えておきたい情報」を、**自分で項目を設計したコレクション**として整理・保管できる
Nextcloud ネイティブアプリです。

### 特長

- **フォームテンプレート** — クレジットカード / 銀行口座 / オンラインアカウント /
  会員 / ライセンス / 連絡先… などのテンプレートから始めても、ゼロから項目を設計しても OK。
  **自分のテンプレートを保存**したり、**初期テンプレートを編集**（自分用に上書き・既定に戻す）もできます。
- **項目ごとの入力規則** — 文字種・最小/最大長・パターン（正規表現）を指定できます。
- **複数の表示形式** — リスト / リスト詳細 / **表計算風テーブル**（先頭列を固定して
  掴んで横スクロール）/ カード / サムネイル付きカード。
- **クライアント側暗号化（任意）** — パスワードや暗証番号、カード番号などの秘密項目は、
  ブラウザ内で **AES-GCM** により暗号化されます。サーバーはマスターキーも平文も一切見ません。
  *マスターキーを忘れるとデータは復元できません。*
- **パスワード付きバックアップ／復元** — 全データ（コレクション・レコード・設定・添付）を
  **AES-256 暗号化 ZIP** でダウンロードし、あとから復元（上書き／マージ／追加）できます。
- **インポート** — **CSV / JSON**（例：Google パスワードマネージャーのエクスポート）や、
  **Nextcloud 連絡先**（写真含む）から取り込めます。一方向で、連絡先側は変更しません。
- **添付** — **Nextcloud Files** や **Notes** から画像・ファイルを添付できます。
- **整理** — レコードをコレクション間で移動・コピー・マージできます。
- **コレクションの複製** — 項目だけ、または**レコードごと**丸ごと複製できます。
- **コレクション共有** — 他の Nextcloud ユーザーと **閲覧 / 編集 / 削除** の3段階で共有。
  任意のアクセスパスワードや、秘密項目の共有にも対応します。
- **Nextcloud Tables 連携** — Tables のテーブルを新規コレクションとして**取り込み**、
  またはコレクションを Tables へ**書き出し**できます。
- **12 言語対応** — 日本語 · English · 简体中文 · Español · Français · Deutsch ·
  Русский · Português · العربية · हिन्दी · 한국어 · Italiano。
  Nextcloud 本体の言語とは独立に、アプリ内で言語を選べます。

### 動作環境

- Nextcloud **30 – 32**
- PHP 8.1 以上
- Nextcloud 対応データベース（MySQL/MariaDB, PostgreSQL, SQLite）

### インストール

**Nextcloud App Store** で公開しています。管理者の「アプリ」→「整理」または「ツール」で
**RegiBase** を検索してインストールできます（[apps.nextcloud.com/apps/regibase](https://apps.nextcloud.com/apps/regibase)）。

または、ソースから手動で導入する場合:

```bash
cd /path/to/nextcloud/apps
git clone https://github.com/ktec-nc-apps/RegiBase.git regibase
sudo -u www-data php ../occ app:enable regibase
```

その後、Nextcloud のアプリメニューから **RegiBase** を開きます。

### コマンドライン（occ）

RegiBase はサーバーのコンソールから読み取れます。スクリプトやバックアップに便利です:

```bash
occ regibase:collections [--user=UID]              # コレクション一覧
occ regibase:records <collection> [--user=UID]     # コレクションのレコード一覧
occ regibase:get <collection> <record> [--field=KEY] [-o json]
occ regibase:export <collection> [--format=json|csv]
occ regibase:find <collection> <query>             # 値で検索
```

`<collection>` は id か名前で指定します。すべて**読み取り専用**です。秘密フィールドは
既定でマスクされ、`--reveal` を付けたときだけ復号します。その際のマスターパスワードは
環境変数 `REGIBASE_PASSWORD` または対話式の隠し入力から読み取ります（サーバー側の復号は
ブラウザと同じ PBKDF2 / AES-GCM を再現し、事前にパスワードを検証します）。例 —
スクリプトから秘密の値を 1 つ取り出す:

```bash
REGIBASE_PASSWORD='…' occ regibase:get Passwords 3708 --reveal --field=Token
```

---

<a id="english"></a>

## English

A Nextcloud-native app to organise and keep the information you care about —
credit cards, bank accounts, online accounts, memberships, licenses, contacts and
anything else — in collections whose fields **you design yourself**.

### Features

- **Form templates** — start from a template (credit card, bank account, online
  account, membership, license, contact, …) or design fields from scratch.
  **Save your own templates**, and **edit the built-in ones** (a per-user override
  you can reset to the shipped default).
- **Per-field input rules** — character set, min/max length, patterns.
- **Multiple views** — list, detailed list, **spreadsheet-style table** (with a
  frozen first column and grab-to-scroll), cards, and thumbnail cards.
- **Client-side encryption (optional)** — secret fields (passwords, PINs, card
  numbers…) are encrypted in the browser with **AES-GCM**. The server never sees
  your master key or the plaintext. *Forgetting the master key means the data
  cannot be recovered.*
- **Password-protected backup & restore** — download all data (collections,
  records, settings, attachments) as an **AES-256 encrypted ZIP**, and restore it
  later (overwrite / merge / add).
- **Import** — from **CSV / JSON** (e.g. a Google Password Manager export) or from
  your **Nextcloud Contacts** (including photos). One-way; Contacts is never modified.
- **Attachments** — attach images and files from **Nextcloud Files** or **Notes**.
- **Organise** — move, copy or merge records between collections.
- **Duplicate a collection** — copy just the fields, or the whole thing **including
  its records**.
- **Collection sharing** — share with other Nextcloud users at three levels
  (**view / edit / delete**), with an optional access password and optional
  secret-field sharing.
- **Nextcloud Tables integration** — **import** a Tables table into a new collection,
  or **export** a collection to a new Tables table.
- **12 languages** — 日本語 · English · 简体中文 · Español · Français · Deutsch ·
  Русский · Português · العربية · हिन्दी · 한국어 · Italiano. Pick a language in the
  app independently of your Nextcloud language.

### Requirements

- Nextcloud **30 – 32**
- PHP 8.1+
- A Nextcloud-supported database (MySQL/MariaDB, PostgreSQL or SQLite)

### Installation

RegiBase is on the **Nextcloud App Store** — search for **RegiBase** under
Apps → Organization or Tools ([apps.nextcloud.com/apps/regibase](https://apps.nextcloud.com/apps/regibase)).

Or install manually from source:

```bash
cd /path/to/nextcloud/apps
git clone https://github.com/ktec-nc-apps/RegiBase.git regibase
sudo -u www-data php ../occ app:enable regibase
```

Then open **RegiBase** from the Nextcloud app menu.

### Command line (occ)

RegiBase can be read from the server console — useful for scripts and backups:

```bash
occ regibase:collections [--user=UID]              # list collections
occ regibase:records <collection> [--user=UID]     # list a collection's records
occ regibase:get <collection> <record> [--field=KEY] [-o json]
occ regibase:export <collection> [--format=json|csv]
occ regibase:find <collection> <query>             # search by field value
```

`<collection>` is an id or a name. All commands are **read-only**. Secret fields
are masked unless you pass `--reveal`, in which case the master password is read
from the `REGIBASE_PASSWORD` environment variable or an interactive hidden prompt
(the server-side decrypt mirrors the browser's PBKDF2 / AES-GCM and verifies the
password first). Example — fetch one secret value for a script:

```bash
REGIBASE_PASSWORD='…' occ regibase:get Passwords 3708 --reveal --field=Token
```

---

## Screenshots

<!-- Add screenshots here, e.g. -->
<!-- ![Table view](screenshots/table.png) -->

## Architecture

The frontend is a single **Vue 3** application. The source
(`js/regibase.js`) is authored as a template and **pre-compiled** into an
eval-free production build (`js/regibase.dist.js`) that ships with the
**runtime-only** Vue build — so RegiBase runs **without `unsafe-eval`** in its
Content-Security-Policy. The backend is a standard Nextcloud app (controllers,
QBMapper entities, services).

フロントエンドは単一の **Vue 3** アプリです。ソース（`js/regibase.js`）はテンプレートとして
記述し、**事前コンパイル**して eval 不要の本番ビルド（`js/regibase.dist.js`）を生成、
**ランタイム専用** Vue と組み合わせて配布します。これにより CSP で `unsafe-eval` を
**使わずに**動作します。バックエンドは標準的な Nextcloud アプリ構成です。

## Third-party

- [Vue.js](https://vuejs.org/) 3 (MIT).

## License

[GNU AGPL v3](LICENSE) © ktec-jp (Japan 🇯🇵)
