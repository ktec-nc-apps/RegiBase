# Changelog

All notable changes to RegiBase.

## 0.20.3 — 2026-09-29

Three layers of protection against losing data. A move made on 2026-09-27 could not be undone:
snapshots were limited to a small number shared by every collection, one saved form rewrote each
of its records as a snapshot of its own and pushed everything older out, and a move was only kept
in the collection the records went to.
（データを失わないための3重の保護。移動を元に戻せなかった件がきっかけ：スナップショットの件数が
全コレクション共通の少ない上限で、項目の保存1回でレコードの数だけ記録されて古いものが押し出され、
移動は移動先にしか残らなかった。）

### Added

- **Versions by session.** A version of a collection begins when a record is first changed or
  deleted, and holds everything done until the browser is closed or the user signs out. Any
  version can be put back: changed records get their contents back, deleted and moved records come
  back (and leave the collection they were moved to), records added in it go, and changed fields
  are put back. Open them from the collection's settings.
  （セッションごとのバージョン。レコードを最初に変更・削除したときに始まり、ブラウザを閉じるか
  サインアウトするまでの作業が入る。どのバージョンの前にも戻せる。コレクション設定から開く。）

### Changed

- **Snapshots keep every change and deletion in a collection, with no limit.** A move is kept in
  both collections — from the one it left, a moved record is a deleted record — and undoing either
  puts the records back.
  （スナップショットは上限なく、コレクションの変更と削除をすべて残す。移動は移動元と移動先の両方に残る。）
- **Attachments are kept, not trashed.** The attachment of a deleted record, and one an edit
  replaced, goes to a hidden `.snapshot` folder inside the collection's folder, keeps its file id,
  and comes back with the record. It goes to the trash only when nothing can bring it back any more.
  （削除や編集で外れた添付は、ゴミ箱ではなく隠しフォルダー `.snapshot` に保管し、レコードと一緒に戻る。）
- **Putting a version back clears the collection's snapshots**, and the other half of any move in
  them, so nothing left can undo a change that is no longer there.
  （バージョンで戻すと、そのコレクションのスナップショットと、対になった移動の記録も消去する。）
- **Restoring a backup with "overwrite" returns everything to the backed-up state** and clears the
  snapshots, the versions and the held attachments of what was there before. "Merge" and "add" keep
  what is there.
  （バックアップを「上書き」で復元すると、バックアップ時点の状態に戻り、それまでのスナップショット・
  バージョン・保管していた添付を消去する。「マージ」「追加」では今の中身を残す。）
- The per-record versions and the snapshot limit are no longer shown; the versions by session take
  their place.
  （レコードごとのバージョンとスナップショットの件数の設定は、表示しなくなった。）

## 0.20.0 — 2026-09-25

A release of fixes. Every part of RegiBase was reviewed line by line — the page, the server,
encryption, sharing, backup and restore — and everything the review found is fixed here. Several
of the fixes close security gaps, so **updating is recommended for every installation**.
（修正の版。画面・サーバー・暗号化・共有・バックアップと復元のすべてを一行ずつ点検し、
見つかったものをすべて直した。安全に関わる直しを含むので、**すべての環境で更新を勧める**。）

### Security

- **Shared collections are more tightly confined.** Undo, version history, attachments and bulk
  edits now respect the share's permission level, its edit lock and its removal; an editor can
  only write the collection's own fields, and can attach only files they own or may reshare.
  A hidden (secret) collection can no longer be opened by its id without the 6-digit key.
  （共有されたコレクションの扱いを厳しくした。取り消し・版・添付・一括編集が、共有の権限・
  編集ロック・共有の解除に従う。編集者は今ある欄にだけ書け、添付できるのは自分のファイルか
  再共有できるファイルだけ。隠しコレクションは、6 桁のキーなしでは ID を指定しても開けない。）
- **Sharing follows your Nextcloud sharing settings** — sharing off, group sharing off, "only
  with members of your own groups" and excluded groups — when searching for people, when
  sharing, and when restoring a backup. If the administrator tightens those settings later, a
  share they no longer allow is paused (it cannot be listed or opened) until they allow it
  again; the owner sees it marked **⏸ Paused**.
  （共有は Nextcloud の共有設定に従う — 相手の検索・共有・バックアップの復元のいずれでも。
  管理者が後から設定を厳しくすると、合わなくなった共有は、合わない間は使えない（一覧に出ず、
  開けない）。オーナーの画面には **⏸ 停止中** と出る。設定を戻せば元どおり使える。）
- **Repeated wrong passwords are slowed down** — for the backup password, share passwords and
  the secret-collection key.
  （バックアップのパスワード・共有パスワード・隠しコレクションのキーを何度も間違えると、
  間隔を空けないと試せない。）
- **An unlocked share is tied to that share and its password**: changing the share password
  or sharing again locks it.
  （共有の解錠は、その共有とパスワードに結びつく。共有パスワードの変更や再共有で解錠は解ける。）
- Deleting a user or group now removes their shares, so a new account with the same name
  does not inherit them. Images are served only in image formats (no SVG). Reading a
  collection no longer creates folders, and "delete the folder too" only ever removes folders
  under RegiBase's own save folder.
  （ユーザーやグループを削除すると、その共有も消える。同じ名前で作り直したアカウントが
  共有を引き継がない。画像は画像形式だけで返す（SVG は返さない）。コレクションを読むだけでは
  フォルダを作らず、「フォルダも削除」は RegiBase の保存先の中のフォルダだけを対象にする。）

### Encryption

- **Secret fields shared with others no longer use your own key.** A share carries the
  collection's own key, wrapped with the share password, and the share password itself never
  reaches the server.
  （秘密項目を共有するとき、自分の鍵そのものではなく、コレクション専用の鍵を共有パスワードで
  包んで渡す。共有パスワードそのものはサーバーに届かない。）
- **Changing or removing the master key now covers everything** — hidden collections, record
  versions and the undo history included — and is all-or-nothing: if anything cannot be
  converted, nothing is changed.
  （マスターキーの変更・解除が、隠しコレクション・レコードの版・取り消しの履歴まで含めて
  すべてに及ぶ。一つでも変換できなければ、何も変えない。）
- **New or changed master keys must be at least 8 characters** and are strengthened with
  600,000 PBKDF2 rounds (was 250,000). **Your current master key keeps working unchanged.**
  （新しく設定・変更するマスターキーは 8 文字以上。PBKDF2 は 60 万回（これまでは 25 万回）。
  **今のマスターキーはそのまま使える。**）
- The remembered key is kept in the browser in a form that cannot be read out, per device and
  per login; a device where encryption is off no longer keeps an old key.
  （記憶した鍵は、ブラウザの中で取り出せない形で、端末ごと・ログインごとに持つ。暗号化を
  切った端末には古い鍵を残さない。）
- A failed decryption no longer overwrites the secret value when the record is saved.
  （復号に失敗したレコードを保存しても、秘密の値を上書きしない。）

### Backup and restore

- **A backup can have a password of its own**, instead of your login password. Restoring
  always asks for your login password first (and the archive's own password, if it has one).
  （**バックアップに専用のパスワードを付けられる**。付けない場合はこれまでどおりログイン
  パスワード。復元では、まずログインパスワードで本人確認をする（専用のパスワードがあれば、それも）。）
- Backup and restore stream the data instead of loading it all into memory, so large
  attachments no longer fail.
  （バックアップと復元は、全部をメモリに載せずに流して処理する。大きな添付でも失敗しない。）
- A backup now also brings back settings, shares, templates, hidden collections and the date
  each record was created. An overwrite restore checks the archive first and changes nothing
  if it is not whole; if saving an attachment fails, the files already saved are cleaned up.
  （設定・共有・テンプレート・隠しコレクション・レコードの登録日も戻る。上書きの復元は、
  先に中身を確かめ、欠けていれば何も変えない。添付の保存に失敗したら、保存した分を片付ける。）
- Merge and add match fields by name and type (secret fields only with secret fields), refuse
  a backup made with a different master key, and never merge into a locked collection.
  （統合・追加は、欄を名前と型で合わせる（秘密の欄は秘密の欄とだけ）。別のマスターキーの
  バックアップは断り、ロック中のコレクションには統合しない。）

### Editing records

- **Two people editing the same record no longer overwrite each other silently**: the later
  save is stopped and you are asked what to do. Replace-all skips records someone else has
  saved since you loaded them, and tells you how many.
  （同じレコードを 2 人が編集しても、黙って上書きしない。後から保存した側には確認を出す。
  一括置換は、読み込んだ後にほかの人が保存したレコードを飛ばし、その件数を知らせる。）
- Decimal numbers, URLs without `https://` and e-mail addresses with international domains
  can be saved. Phone fields accept `#`, `*` and full-width hyphens. Only the fields you changed
  are checked against the input rules, and the server now checks them too.
  （数値欄の小数、`https://` のない URL、日本語ドメインのメールを保存できる。電話欄は
  `#`・`*`・全角のハイフンを受け付ける。入力規則で確かめるのは変えた欄だけで、サーバーでも確かめる。）
- Saving twice quickly no longer creates two records; switching collections quickly no longer
  shows or edits the wrong records; checkbox values are kept; closing an editor with unsaved
  changes asks first; failed saves are reported.
  （保存の連打で 2 件できない。コレクションをすばやく切り替えても、別のレコードを表示・
  編集しない。チェックボックスの値が消えない。未保存のまま閉じると確認する。保存の失敗を知らせる。）
- Saving a template, or editing one, keeps its view and join settings. Bulk edits keep record
  versions.
  （テンプレートの保存・編集で、表示設定と連結設定が消えない。一括編集でも版を残す。）

### Search and import

- Normal search looks only in the values; regular-expression search has help that matches what
  it does, and an invalid or too-heavy pattern is reported instead of matching everything.
  （通常の検索は値だけを探す。正規表現の検索は、ヘルプを実際の動きに合わせ、誤ったパターンや
  重すぎるパターンは、全件を返さずに知らせる。）
- CSV import reads Shift_JIS files (Excel's Japanese CSV) and detects `,` `;` or tab
  separators. Columns whose headings would give the same key are no longer overwritten.
  Contacts import keeps second and later phone numbers, e-mails and birthdays without a year
  (in the notes); JSON import keeps large whole numbers exactly.
  （CSV の取り込みは Shift_JIS（Excel の日本語 CSV）を読み、区切り（`,` `;` タブ）を判断する。
  見出しから同じキーになる列を上書きしない。連絡先の 2 件目以降の電話・メールと、年のない
  誕生日はメモに残す。JSON の大きな整数を丸めない。）

### Other

- `occ` commands mask secret fields unless `--reveal` is given (also for accounts without
  encryption), and `regibase:master` no longer leaves data half-converted.
  （`occ` は `--reveal` がなければ秘密項目を伏せる（暗号化していないアカウントでも）。
  `regibase:master` がデータを変換途中で残さない。）
- Error responses no longer show internal messages; names, icons and colours are checked
  against what the database and the page can hold.
  （エラーの応答に内部のメッセージを出さない。名前・アイコン・色は、データベースと画面に
  合う長さと形だけを受け付ける。）
- **21 languages**: Portuguese now comes as **Brazilian Portuguese** and **European
  Portuguese** (the previous "Português" was Brazilian and stays selected). All languages were
  reviewed by a second translator, and counts use the right singular or plural form in every
  language (for example "1 Eintrag" / "2 Einträge", or the one / few / many forms of Russian, Polish
  and Czech).
  （**21 言語**。ポルトガル語は **ブラジル** と **ポルトガル** の 2 つになった（これまでの
  「Português」はブラジル版で、選んでいた人はそのまま）。全言語の訳を見直し、件数の単数・複数を全言語で正した（ドイツ語の「1 Eintrag／2 Einträge」、
  ロシア語・ポーランド語・チェコ語の数による形の違いなど）。）
- The unused full build of Vue is no longer shipped.
  （使っていない Vue のフルビルドを同梱しない。）

## 0.19.2 — 2026-09-17

### Changed

- **Nextcloud 35 is now supported. There are no other changes.** The supported range
  is widened from 30–34 to 30–35. The app itself is unchanged from 0.19.1: it was tested
  on Nextcloud 35 against the changes that release makes for apps, and ran without
  modification.
  （**Nextcloud 35 に対応した。それ以外の変更はない。** 対応範囲を 30〜34 から 30〜35 に
  広げた。アプリ本体は 0.19.1 から変わっていない。Nextcloud 35 でアプリ向けに変わった点に
  照らして試験し、修正なしで動くことを確かめた。）

## 0.19.1 — 2026-09-08

### Fixed

- **Fixed a bug where clicking outside a dialog while editing made the edit screen
  disappear.** In every editing dialog — the record editor, collection edit, collection
  settings, Settings and the rest — clicking outside no longer closes it and discards what you
  were entering; close it with ✕, Cancel or Save.
  （各ダイアログで編集中に編集画面外をクリックした際、編集画面が消えてしまうバグを修正した。）
- **The package now passes Nextcloud's integrity check.** The signature shipped with 0.19.0
  listed two files the package does not contain (`appinfo/CHANGELOG.md` and
  `appinfo/README.md` — duplicates of the ones at the root), so every server running
  RegiBase reported "Some files have not passed the integrity check" in its admin
  overview. The signature is now generated from the packaged files alone. No app code
  has changed.

## 0.19.0 — 2026-09-01

### New — record version history

- **Each record can keep its last few versions**, the way EditBase keeps numbered versions
  beside a document. Before an edit overwrites a record, its previous state is saved as a
  numbered version (**#01** is the newest; older ones shift down and the oldest falls off once
  past the limit). Open them from a record's **🕐 Versions** button and **put any one back** —
  restoring is itself reversible, because the current state is kept as a version first.
- In **Settings**, set **how many versions to keep** per record (0–99; nought turns it off) and
  **when one is taken** — only when you ask, or every time a record is edited.
- This is **separate from the snapshot / undo history**: a version stays even after its undo
  entry has aged out of the account-wide log, so it is a longer-lived safety net for one
  record's contents.
- Added translations for the new text in all 20 languages.

### Fix

- **Fixed the ☰ button appearing on the desktop layout next to the collection title, where
  pressing it did nothing.** It is a small-screen control that opens the collections sidebar
  (already always visible on wider screens); a style rule was letting it show on the desktop
  layout too.

## 0.18.35 — 2026-08-27

### Fix — the attachment save folder is now created

- **Fixed a bug where the data save folder was not being created.** Added a **Base folder**
  setting in **Settings**, and fixed collection creation so that it now creates — under the base
  folder, named after the collection — the folder that should have been created all along.
- The **Base folder** (default `RegiBase`) can now be set in **Settings**. It is the parent
  folder, under Files, where each new collection stores its images and files
  (as *base folder / collection name*).
- Existing collections that never got a folder are repaired automatically: opening RegiBase now
  creates the save folder for every one of your collections that is still missing it.
- **Folder-name clashes are handled on creation.** If a new collection would reuse another
  collection's save folder, RegiBase asks whether to share that folder or to create a new one
  with a number added (e.g. *Credit card (2)*).
- **Deleting a collection never removes a shared folder.** If the save folder is also used by
  another collection, the delete dialog says so and keeps the folder (delete it manually if you
  really mean to) — so one collection's deletion can no longer take another's attachments.
- When you **delete a collection** you can now also **move its save folder to the trash**
  (off by default). If the folder still holds files, RegiBase tells you that the saved data
  will be moved to the trash (from where it can still be restored).
- **Fixed a bug where editing a collection's save-folder path directly had no visible effect.**
  Saving a hand-edited folder path now also **moves (renames) the folder in Files**, carrying
  any files inside it along — previously only the database pointer changed, so the folder in
  Files was left untouched and the change did not appear to take effect.
- Added translations for the new text in all 20 languages.

## 0.18.13 — 2026-08-21

### Rename the save folder together with the collection

- When you **rename a collection's title**, RegiBase now asks — in a dedicated dialog — whether to
  **rename that collection's save folder to match**. Your images and files stay exactly where they
  are; only the folder name changes. Pick **“Rename the folder”** or **“Keep the folder name”**.
- The prompt only appears while the save folder is still the auto-derived one (named after the
  collection). If you have pointed the collection at a **custom folder**, it is left untouched.

## 0.18.12 — 2026-08-17

### New logo

- RegiBase has a **new logo**. The refreshed two-color mark now appears throughout the app — the
  sidebar header, the loading screen and the sign-in card — and the app icon in the Nextcloud
  navigation bar has been updated to match.

## 0.18.11 — 2026-08-12

### Fixes

- **Secret toggle window**: titled **“Secret toggle”** to match the button it opens, and the
  small stray horizontal scrollbar in that window is gone.
- **Note view**: the title list no longer shows a spurious horizontal scrollbar.
- **Session handling**: reloading the page keeps you on the collection you had open, but when the
  login session has ended — the browser was reopened, or the session was lost — RegiBase now
  returns to the **collection list (home)** instead of reopening the last collection. A hidden
  (secret) collection is never reopened automatically.

## 0.18.10 — 2026-08-11

### Note view — a 3-pane, notes-app style layout

- A new **Note view** joins the existing List / Table / Cards views. The view switcher now reads
  **List · Table · Note · Cards**.
- It turns the main area into a **title list** and a read-only **content** pane. Together with the
  collection list in the left sidebar — which acts as the “group” column — it reads like a
  three-pane notes app: pick a collection on the left, scan its records in the middle, click one
  to read it on the right.
- The content pane is laid out like a notes app: **each field is shown as a heading with its value
  in a soft, rounded box** and a one-tap copy button. Multi-line values keep their line breaks.
- Selecting a record shows it read-only; **Edit / Duplicate / Move / Delete** are available inline
  without leaving the view. Long record lists scroll smoothly, and the open record stays selected.

### Reopen where you left off

- When a collection is open, **reloading the page now returns to that collection** instead of the
  home screen. Going back to “All collections” clears it, so a reload then stays on the home screen.
  (Secret collections are excluded — see below — so a reload never re-opens them without the key.)

### Secret collections — hide a collection from the list

- A collection can now be marked **secret** in its settings and protected with a **6-digit numeric
  key**. Secret collections are **hidden from the collection list and the home screen**.
- A permanent **“Secret toggle”** button under “＋ New collection” opens a passcode-style prompt.
  Enter the 6-digit key and the matching collections appear **for the current session only** — a
  reload, or pressing the button again, hides them once more. Nothing is unlocked on the server.
- **This is a visibility lock, not encryption — and it is completely separate from the encryption
  master key.** The 6-digit secret key only decides whether a collection is *shown in the list*.
  It does **not** encrypt any records, and it is **not** the master key used by encrypted “secret
  fields”. Making a collection secret does not encrypt its data; for confidentiality, use secret
  fields together with the master key, which are unchanged by this release. The 6-digit key itself
  is stored only as a bcrypt hash and is never sent to the browser.

## 0.17.6 — 2026-08-06

### Compatibility

- Declared support for **Nextcloud 34** (verified on Nextcloud 34.0.2 with PHP 8.5 — install,
  migrations, records, sharing, search and the occ commands all pass). No code changes.

## 0.17.5 — 2026-07-30

### Sharing

- Collections can now be shared with **groups**, not only individual users (the picker searches both;
  users and groups are shown with distinct icons).
- Share recipients can no longer edit a collection's **fields or settings** (owner only). Their
  record-level rights (view / edit / delete) are unchanged.

### Per-collection settings

- **Attachment folder per collection** — choose, by typing a path or browsing Files, where each
  collection's images and files are saved. Default: `RegiBase/<collection name>`. The record editor
  warns you if it is left blank.
- **Map service per collection** — override the default per collection. Added **Yahoo! Maps (Japan)**
  and **Bing Maps**. The old global folder and map settings were removed (now per collection; the map
  default is Google Maps).

### Views & fields

- Per-field **Show in: List / Table / Cards** toggles — pick which fields appear in each view. For a
  concatenated group, its leading field governs the whole group.
- Removed the "detailed list" and "thumbnail cards" views; the list and card summaries now follow the
  per-field toggles and show a concatenation/parentheses-aware one-line summary.

### Password generator

- New defaults: 12 characters, no symbols, at least 2 of each selected character type, maximum length 30.
- New option "start the first character with a letter" (on by default); the approximate number of
  possible passwords is shown after the entropy.
- The generator defaults can be set from Collection settings.

### Performance

- **Find & replace** now applies every change in a single request instead of one request per record —
  dramatically faster on large collections.
- The bundled emoji font is no longer downloaded on devices that already have a colour-emoji font,
  for a faster first load.

## 0.17.0 — 2026-07-30

### Encryption (master key)

- Reworked master-key management: set/change, remove (back to plain text), and sign-out are now
  clearly separated; terminology unified to "master key".
- Secret fields are now encrypted automatically when a collection's secret flag changes (background
  sweep) — the manual re-encrypt option was removed.
- New occ command `regibase:master` (status | set | change | remove).

### Search & replace

- In-collection search can now use regular expressions (server-side PCRE: case-sensitive, `(?i)`
  supported, Unicode-aware).
- New Replace: bulk-replace text across matched records (`$1` group references, undoable from
  Snapshots).
- Regex help ("?" chip): a two-page reference — token list plus worked examples.
- New occ option `regibase:find --regex`.

### Snapshots (formerly Undo)

- "Undo" renamed to "Snapshots"; scope changed from a single global timeline to per-collection.
  Opened from ⚙️ Collection settings; roll back to any point. Richer summaries with icons and hover
  detail.

### Display & editor

- Columns with no data are shown with a faint header in the list view.
- Each field shows a "filled / total" record count in the collection editor.
- Concatenation can wrap the target in parentheses (half- or full-width); fixed parentheses
  disappearing when a field was empty.

### Layout & fixes

- The sort control ("Sort") moved next to Duplicate; search/replace box relaid out (aligned left
  edges, wraps on narrow widths).
- Fixed dark-mode select text being invisible and an oversized hover box.

## 0.16.0 — 2026-07-30

### Concatenation (display combining) — reworked

- In the collection editor, each field can pick a **Concatenate with** target — the next field to
  show it combined with — and its own **separator** (none / half-width space / full-width space /
  custom symbol) placed between them. Chain fields (A→B→C) for a 3-/4-way combine, e.g. last name →
  first name → “Yamada Taro”, or furigana last → first as a second group.
- The field being combined into shows a “Concatenated from …” note; combined columns are marked with
  🔗 and pulled to the front in the table view, and appear as one item in the detailed list.
- This only changes how records are **displayed** — the stored data is never merged. (Field names
  are now required.)

### Fixes

- Deleting a whole collection can now be undone — the ↶ Undo button appears after a collection
  delete.
- Switching the view or sort order no longer fills up the change history.

## 0.15.1 — 2026-07-30

### Undo & change history

- Every change — records, fields, collections, imports and moves — is now recorded and can be
  reverted with **Ctrl+Z** or the **↶ Undo** button in the toolbar. A whole schema save (field
  changes together with any record-data migration) is undone in a single step.
- Settings has a **change-history** view and a configurable retention limit (default 100 changes;
  set 0 to turn history off). Changes beyond the limit are discarded oldest-first.

### New field types

- **Choices (radio)** — pick one option from a set of radio buttons.
- **Choices (checkboxes)** — pick several options; the selected values are stored together.
- The previous **Choices** type is now labelled **Choices (dropdown)**.

### Concatenation groups

- In the collection editor each field can be given a **Concatenate** group number. Fields sharing a
  group are shown combined — joined in field order — as one column (table view) or one line
  (detailed list), e.g. last name + first name, and furigana last + first as a second group.
  This is independent of the Emphasis (title) setting; combined columns are pulled to the front.

### Also included since the last release (0.14.x)

- **Emphasis (record name):** the list-title marker is now **🏷️ Emphasis** (previously “★ Title”),
  and more than one field can be a key — their values combine in field order to form the record's
  name (e.g. first + last name), shown in bold, and optionally as one leading column in the table
  view with a chosen separator.
- New collections open in the **table** view by default.
- The collection editor is titled **Edit collection**; its field list auto-scrolls while you drag
  to reorder.
- Supports **Nextcloud 33**.
- **Fix:** reordering fields right after renaming one could prune that field's record data on save.

## 0.14.13 — 2026-07-29

### Emphasis (record name) fields

- The list-title marker was renamed to **🏷️ Emphasis**, and a field list can now have more
  than one. When several fields are emphasized, their values are combined in field order to form
  the record's name (for example first name + last name), skipping any empty parts. Emphasized
  values are shown in bold. (The marker was previously “★ Title”.)
- Collection settings can combine the emphasized field(s) into a single leading column in the
  table view, with a chosen **separator** — none, a half-width space, a full-width space (offered
  for CJK languages), or a custom symbol.

### Editing

- New collections now open in the **table (spreadsheet)** view by default.
- The collection editor is titled **Edit collection**, with a short note on what it changes.
- While reordering fields by drag in the collection editor, the list now auto-scrolls when the
  pointer nears the top or bottom edge.

### Compatibility

- Supports **Nextcloud 33**.

### Fixes

- Reordering fields by drag in the collection editor right after renaming one could, on save,
  leave a field's data mismatched and prune it. Field keys are now kept pinned to their field
  regardless of order, and the edited field is committed before a drag begins.

## 0.14.1 — 2026-07-28

### Edit lock (view-only collections)

- A collection's settings now include an **Edit lock**. While it is on, the collection is
  view-only: records and fields cannot be added, edited or deleted, and a 🔒 mark is shown next
  to it in the collection list. It is enforced on the server, not only in the interface.

### Field editing

- Changing a field's type or its Secret setting, or removing a field, now migrates the existing
  record data instead of leaving it inconsistent: values are decrypted when Secret is turned off
  and encrypted when it is turned on; values that no longer fit the new type are cleared; a Select
  field keeps existing out-of-range values by adding them to its choices; and data and attachments
  left by removed fields are cleaned up.
- The effects are listed in a single confirmation first. Any change that deletes data now needs a
  checkbox confirmation rather than a single click.

### Encryption

- Settings has a **Re-encrypt secret fields** action for secret values still stored as plain text
  (for example when encryption was enabled later). Turning a field into a secret field also offers
  to encrypt its existing values.
- The encryption section of Settings was rearranged so each action has a short description.

### Fixes

- Sorting a field of dotted values such as IP addresses treated them all as the same number and
  left them unsorted; they now sort in natural order.

## 0.13.1 — 2026-07-25

### Address field type

- The map link is now a dedicated **Address** field type instead of a per-field checkbox.
  Pick the *Address* type and its value gets a 🌐 button that opens it in your chosen map
  service (Google Maps / OpenStreetMap / Apple Maps). The built-in templates and the Contacts
  import now use this type for address fields.
- The map button uses a clearer 🌐 (globe) icon and sits before the copy button.

## 0.13.0 — 2026-07-25

### Reminders in your Calendar, and map links for addresses

- **Add a reminder from a date.** Date and year/month fields now show a 📅 button in the
  record detail. It opens Nextcloud Calendar's own new-event editor (in a popup) prefilled
  with that date as an all-day event, where you set the title, reminders and repeat and save.
  The button is shown but disabled when the Calendar app is not enabled.
- **Map links for addresses.** A new per-field option, **🗺 Map link**, can be turned on for
  text fields (for example an address). Such fields show a 🗺 button in the record detail that
  opens the value in a map. Choose the map service — **Google Maps, OpenStreetMap or Apple
  Maps** — in Settings.

## 0.12.15 — 2026-07-25

### Fix: fields could share one value

Adding several fields at once — most often when their labels were non-Latin (Japanese,
Chinese, and so on) — could give them the same internal key. Fields that share a key also
share a single value, so editing one (for example a date) filled the others with the same
entry. Field keys are now guaranteed unique at three levels: the client's key generator no
longer collides within a single pass, the schema editor de-duplicates keys on save, and — the
decisive guard — the server enforces uniqueness at the one place every field is written, so no
import, restore, or future client regression can reintroduce a collision. Existing collections
already affected are repaired by giving their duplicated fields distinct keys.

## 0.12.14 — 2026-07-24

### Password generator: choose the symbols and set per-class min/max

The generator now gives the same fine control KeePass does, with the constraints kept
mutually consistent so you can never configure a request it cannot fulfil.

- **Choose which symbols are allowed.** The full symbol palette is shown as a grid; tap to
  include or exclude each one, with All / None shortcuts. Only the symbols you keep can appear.
  (A symbol that is also a look-alike, such as `|`, is struck through while "exclude look-alike
  characters" is on.)
- **Minimum and maximum occurrences per character type.** Each of uppercase, lowercase, digits
  and symbols has its own min and max. "min 2 / max 4 digits", "at least one symbol", "no more
  than one uppercase" — all expressible. A blank max means no limit.
- **Exclusive (mutually-consistent) handling.** Every change is reconciled so the request stays
  generatable: a max is never below its own min, the total of the minimums never exceeds the
  field's ceiling, and the length is clamped into the window the minimums and maximums allow.
  The length slider's own floor and ceiling move with the constraints, so an impossible
  combination simply cannot be entered.
- Guarantees hold exactly: with 5000 sample draws, every minimum is always met, no maximum is
  ever exceeded, and min == max produces exactly that count.
- Your choices (symbol set, per-class min/max, length) are remembered between uses, and a
  field's own input rule still wins — a digits-only or hexadecimal field ignores the controls
  that do not apply to it.

## 0.12.13 — 2026-07-24

### Password generator for secret fields

Every secret field in the record editor now has a 🎲 button next to the reveal eye, and the
share password in the collection settings has one too. The master key deliberately does not —
it is the one password you have to be able to remember and re-type.

- Length 4–128 with a slider, and the four character classes (A–Z, a–z, 0–9, symbols) as
  independent toggles. At least one character from every selected class is guaranteed.
- Characters are drawn from `crypto.getRandomValues` with rejection sampling, so every
  character is uniformly distributed — `% n` on a raw 32-bit draw would quietly favour the
  low end of the alphabet — and the result is shuffled with the same source.
- Optional "exclude look-alike characters" (`0 O 1 l I |`), for passwords that have to be
  read aloud or typed from a printout.
- Strength is shown as real entropy — length × log₂(alphabet) — not as a guess at what a
  password "looks" strong.
- A field's own input rule is respected: a digits-only or hexadecimal field can only produce
  what it accepts, and the length range is clamped to the field's minimum and maximum, so a
  generated value can never be rejected by the rule of the field it was generated for.
- The generated value never leaves the browser. It is encrypted client-side like any other
  secret when the collection has encryption enabled, and it is cleared from memory when the
  dialog closes.
- Symbols exclude space, quote, backtick and backslash — the characters that get mangled in
  shells, CSV round-trips and copy-paste.

## 0.12.12 — 2026-07-23

### Emoji are drawn by the app, not by the viewer's device

0.12.11 bundled the full emoji set but kept it as a *fallback* behind the device's own font.
That does not fix flags, and the reason is worth writing down: **Segoe UI Emoji has glyphs
for the regional indicator letters**. It reports 🇯 and 🇵 as covered and simply draws them as
two boxed letters instead of forming 🇯🇵 — so nothing is "missing", the browser never falls
through, and the bundled font was never even downloaded. Taking only the flag code points
away from the device font does not work either: U+200D has to travel with them or
🏳️‍🌈 🏳️‍⚧️ 🏴‍☠️ split into a bare flag, and once U+200D belongs to a different font than the
base character, **every** ZWJ emoji comes apart — families, couples, professions, hair
colours.

- All 1,849 emoji are now rendered from the bundled Noto Color Emoji subset (SIL OFL 1.1),
  on every platform. A device's own emoji font is kept behind it only as a safety net for a
  failed download.
- Verified on three simulated devices — a complete emoji font, a Windows-like one (has the
  regional indicator glyphs but cannot form flags), and none at all: all 1,849 render
  identically in each, flags and ZWJ sequences included.
- The font applies only to the elements that display an icon, so the app's own UI keeps the
  platform look and body text is untouched — characters such as © ® ™ ↔ stay plain text.
- Cost: one cached 1.7 MB download. Collections are shared, so consistent rendering is the
  point — everyone now sees the icon the person who picked it saw.

## 0.12.11 — 2026-07-22

### Emoji no longer depend on the viewer's device

0.12.10 shipped a flag-only font, which treated the symptom. The cause is that the app was
letting whatever emoji font a device happens to ship decide whether an icon is readable —
and flags are simply where that shows up first, because **Windows has no flag glyphs on any
version** (Segoe UI Emoji draws 🇯🇵 as a boxed "JP" and 🏴󠁧󠁢󠁷󠁬󠁳󠁿 as an empty box, a deliberate
omission that updates will not fix). The same gap hits anything newer than the device's
font: Segoe UI Emoji only gained the Unicode 13/14 additions (🫠 🫰 🫡 …) in Windows 11 22H2.
Collections get shared, so an icon has to survive being viewed on someone else's screen.

- RegiBase now carries **all 1,849 emoji** it offers, as a subset of Noto Color Emoji
  (SIL OFL 1.1) — the vector COLRv1 build, 1.7 MB where the bitmap build of the same
  coverage would be 4.4 MB.
- It is a **fallback, not a replacement**: the first `@font-face` is `local()` only and
  names the platform emoji fonts, so a device with a complete font uses its own and
  downloads nothing. Font fallback reaches the bundled file only for the glyphs the
  platform font turned out to be missing, and the browser caches it from then on.
- Measured on three simulated devices — complete emoji font: **never fetched**; Windows-like
  (emoji font present, no flags): fetched the first time a flag is drawn, **not** on app
  start; no emoji font at all: fetched on load, and every one of the 1,849 renders.
- The font pair applies only to the elements that display an icon, never to body text, so
  characters such as © ® ™ ↔ stay plain text everywhere else.

## 0.12.10 — 2026-07-22

### Flags now render on Windows

- Windows ships no flag glyphs: Segoe UI Emoji draws 🇯🇵 as a boxed "JP" letter pair and
  🏴󠁧󠁢󠁷󠁬󠁳󠁿 as an empty box, so the 269 flags in the icon picker were unusable there. RegiBase
  now carries a **flag-only subset of Noto Color Emoji** (SIL OFL 1.1) and declares it
  with a `unicode-range` limited to the flag code points: the browser fetches the file
  the first time a flag is actually drawn — not on app start — and then caches it. Every
  other emoji still comes from the system font, so nothing else changes.

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
