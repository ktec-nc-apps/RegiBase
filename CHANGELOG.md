# Changelog

All notable changes to RegiBase.

## 0.22.4 — 2026-11-08

### Fixed

- **Sharing tab ([#1](https://github.com/ktec-nc-apps/RegiBase/issues/1))**: when the existing shares could not be loaded, or the search for people failed, the tab showed an empty list and said nothing. It now says so, with the reason. When the search finds no one, it says that the administrator may let people be found only by their full user name ("Allow username autocompletion" off), as in the Files share dialog.
  （**共有のタブ**：既存の共有を読み込めなかったときや、相手の検索に失敗したとき、タブは何も言わずに空の一覧を出していました。理由とあわせて表示するようにしました。検索で誰も見つからないときは、管理者が「ユーザー名の全体を入力したときだけ見つかる」設定（「ユーザー名の自動補完」がオフ）にしている可能性を、Files の共有画面と同じように案内します。）

## 0.22.3 — 2026-11-08

### Fixed

- Polish: messages with a number now use the right word form for 1 and for 2–4 ("1 element", "2 elementy", "5 elementów"), where they used the form for 5 and more in every case.
  （ポーランド語：数を含む表示で、1 のときと 2〜4 のときの語の形を正しく使うようにしました。これまでは、どの数でも 5 以上の形になっていました。）

## 0.22.2 — 2026-11-07

What the AI assistant actually did is now shown under its answer, the assistant follows the administrator's permissions in AI-Hub, and every translation was reviewed.
（AI アシスタントが実際に行った操作を、答えの下に表示するようにしました。AI-Hub で管理者が決めた許可に従うようにしました。すべての言語の訳を見直しました。）

### Added

- **"What was actually done" under each answer** (with AI-Hub 0.1.7 or later). When the assistant adds, changes or deletes something, the list under its answer shows what really happened — for example "Add records — 1: Yamamoto" — made from the records themselves, not from the assistant's words, with a failure shown as one. If the answer and the list ever disagree, the list is right.
  （**答えの下に「実際に行った操作」を表示します**（AI-Hub 0.1.7 以降）。アシスタントが追加・変更・削除をしたとき、実際に起きたことを、アシスタントの言葉とは別に、レコードそのものから作って一覧にします。失敗した操作は失敗として表示します。答えと一覧が食い違うときは、一覧が正しい内容です。）

### Changed

- **The assistant follows the permissions set in AI-Hub** (AI-Hub 0.1.7 or later): each of its tools says whether it reads, adds, changes or deletes, and what the administrator has not allowed there is not offered to it at all; it then tells you how to do it yourself.
  （**AI-Hub で設定した許可に従います**（AI-Hub 0.1.7 以降）。ツールごとに、読む・追加・変更・削除のどれかを申告し、管理者が許可していない操作はアシスタントに渡しません。そのときは、自分で行う手順を案内します。）
- **The assistant answers in the language you write in**, even when the screen and the data are in another language.
  （**質問した言語で答えます。** 画面やデータが別の言語でも同じです。）
- The README now describes what the assistant can do today.
  （README の AI アシスタントの説明を、今の機能に合わせました。）

### Fixed

- **Translations reviewed in every language.** Japanese was gone through in full — wrong meanings, literal phrasing, terms used two ways and the style of the older change notes — and every other language was checked line by line for wrong meanings, literal phrasing and inconsistent terms.
  （**すべての言語の訳を見直しました。** 日本語は、意味の誤り、直訳、用語の揺れ、古い変更履歴の文体を含めて全体を点検しました。ほかの言語も、意味の誤り、直訳、用語の揺れを 1 行ずつ点検して直しました。）
- The check and cross marks in the list of what was done were too faint to read.
  （「実際に行った操作」の ✓ と ✗ が薄くて読みにくかったのを直しました。）

## 0.22.1 — 2026-11-07

The AI assistant can now work in RegiBase itself; categories for the collection list; date-and-time fields; collection settings wider and in tabs, with Share settings opening on their own tab; snapshots that show what each change did; undo that brings back a deleted collection, and the fixes from a review of the whole app.
（AI アシスタントが、RegiBase の中を自分で操作できるようになりました。コレクション一覧にカテゴリを追加しました。日時の項目を追加しました。コレクション設定を広くしてタブに分け、「共有設定」から開くと共有のタブが開くようにしました。スナップショットで変更の中身が見えるようにしました。元に戻すときに、削除したコレクションも復活させるようにしました。アプリ全体の見直しで見つかった問題も修正しました。）

### Added

- **The AI assistant can work in RegiBase itself** (with AI-Hub). It looks through every collection the person can see — not only the open one — finds records, finds duplicates within and across collections or in one category, and, when the administrator allows it, adds, changes and deletes records, makes collections, renames them, files them in a category, changes their fields and deletes them. It acts with the rights of the person asking, so a shared collection only at its shared level, and every change can be taken back with "↶ Undo"; the page shows the change as soon as the answer comes. Secret collections and secret categories are open to it only after the person has entered their 6-digit key in this session, and "Hide secret collections" closes them to it again. The value of a secret field is never read or written by it: it knows only whether one is filled in, so when removing duplicates it keeps the record that holds a password. In the administration settings, "What it may do" now has a third choice, "Make, change and delete records, fields and collections"; reading covers every collection the person can see.

- **Categories for the collection list**, for when there are too many collections to find your way. Make one with "＋ New category" under "＋ New collection", then put collections in it: in Collection settings (General tab, just under the name), with right-click → "Category…", or by dragging a collection onto the category's heading. A category made this way stays while it is empty. Collections in no category are under "Uncategorized", which is always at the top; the other categories are put in order by dragging their headings. One category is open at a time: Uncategorized at first, and opening another closes the one that was open. Right-click a heading also to remove the category (its collections go to Uncategorized; the collections themselves are not changed). A heading has a large open/close mark and its collections sit one step in, so it is not taken for a collection; the button at the top of the list now shows how many categories and collections there are instead of "All collections". The home screen shows the collections under the same headings. A category can have an icon and remarks (shown on the home screen and when pointing at its heading), and can be made secret with a 6-digit key: it and its collections stay out of the list until the key is entered with "Secret toggle" — the same key as a secret collection shows both. Right-click a heading → "Edit category…" to change its name, icon, remarks or secrecy. Categories are each person's own, so someone a collection is shared with can file it where they like.
  （**コレクション一覧にカテゴリを追加しました。** コレクションが増えて探しにくいときに使います。「＋ 新規コレクション」の下の「＋ 新しいカテゴリ」でカテゴリを作り、コレクションを入れます。入れ方は3つあります。コレクション設定の「基本」タブ（名前のすぐ下）で選ぶ、コレクションを右クリックして「カテゴリ…」を選ぶ、コレクションをカテゴリの見出しにドラッグする、のどれでもできます。作ったカテゴリは、コレクションが0件でも残ります。どのカテゴリにも入っていないコレクションは「未分類」に入り、「未分類」は常に一番上に表示します。ほかのカテゴリは、見出しをドラッグして並べ替えられます。開くカテゴリは1つだけで、最初は「未分類」が開いており、別のカテゴリを開くと、開いていたカテゴリは閉じます。見出しを右クリックすると、カテゴリの解除もできます。解除すると、そのコレクションは「未分類」に移り、コレクションそのものは変わりません。見出しには大きな開閉のマークを付け、中のコレクションを一段下げて表示するので、コレクションと見分けられます。一覧の一番上のボタンには、「コレクション一覧」の文字の代わりに、カテゴリ数とコレクション数を表示します。ホーム画面でも、同じ見出しでコレクションを分けて表示します。カテゴリにはアイコンと備考を付けられます（備考はホーム画面と、見出しにマウスを置いたときに表示します）。カテゴリは6桁のキーでシークレットにでき、「シークレット切り替え」でキーを入力するまで、カテゴリとその中のコレクションを一覧に表示しません。シークレットのコレクションと同じキーにすると、両方まとめて表示されます。名前・アイコン・備考・シークレットは、見出しを右クリックして「カテゴリを編集…」で変えられます。カテゴリは人ごとの設定なので、共有された人も自分でカテゴリに分けられます。）
- **Two new field types: "Date and time" (year, month, day, hours and minutes) and "Date and time (with seconds)".** A value is kept as `2026-11-07 14:30` (or `14:30:05`), so lists, titles and exports show it as it is, and it sorts in time order. The 📅 button adds it to the Calendar as a one-hour event at that time. Changing a field between Date, Year/Month and the two new types keeps the values that fit: a date becomes 00:00 of that day, a date and time keeps its date. Exporting to Tables makes a date-and-time column, and importing one from Tables gives this type.
  （**項目の種類に「日時」（年月日時分）と「日時（秒まで）」を追加しました。** 値は `2026-11-07 14:30`（秒までなら `14:30:05`）の形で保存するので、一覧・見出し・書き出しにそのまま表示され、時刻の順に並べ替えられます。📅 ボタンで、その時刻から1時間の予定としてカレンダーに追加できます。「日付」「年月」と新しい2つの種類の間で項目の種類を変えたときは、変換できる値を残します。日付はその日の 00:00 に、日時は日付の部分だけにします。Tables への書き出しでは日時の列になり、Tables から取り込むと日時の項目になります。）

### Changed

- **Collection settings are wider and in tabs**: General, Lock and secret, Sharing and Data. "Share settings" in the list's menu opens them on the Sharing tab ([#1](https://github.com/ktec-nc-apps/RegiBase/issues/1)): the shares used to sit at the bottom of one long dialog, where they could not be seen without scrolling down. The switch that had to be turned on before the shares were shown is gone: the shares and the form to add one are there at once. The last day of a share is no longer cut short in the list. Someone a collection is shared with sees only what they may use, without tabs.
  （**コレクション設定を広くし、「基本」「ロックとシークレット」「共有」「データ」のタブに分けました。** 一覧の右クリックで「共有設定」を選ぶと、共有のタブが開きます（[#1](https://github.com/ktec-nc-apps/RegiBase/issues/1)）。これまでは共有設定が長いダイアログの一番下にあり、下までスクロールしないと見えませんでした。共有を表示する前にオンにする必要があったチェックもなくし、共有の一覧と追加の欄を最初から表示します。共有の一覧で、共有の最終日が途中で切れないようにしました。共有された人には、タブを使わず、使える項目だけを表示します。）
- **The collection editor (Edit collection) is wider too**, and its labels stay on one line. Both dialogs fit a 1366 × 768 screen. On a phone, the name box of a field is no longer squeezed to one letter.
  （**コレクション編集も横幅を広げ、見出しが途中で折り返さないようにしました。** どちらのダイアログも 1366 × 768 の画面に収まります。スマホで、項目名の欄が1文字分まで細くなる問題も直しました。）
- **Snapshots show what each change did.** Each line names the kind of change and the record, and below it what changed: "Name: old → new" for an edit, the records added or deleted, the fields added. A secret field is shown only as "secret field changed", never with its value, and someone a collection is shared with is shown only what they may see.
  （**スナップショットで、それぞれの変更の中身が見えるようにしました。** 各行に変更の種類と対象のレコードを表示し、その下に変更の中身を表示します。編集なら「項目名：変更前 → 変更後」、追加・削除したレコード、追加した項目などです。秘匿項目は「秘匿項目を変更」とだけ表示し、値は表示しません。共有された人には、見てよい内容だけを表示します。）
- **Undo brings back a deleted collection when it needs to.** When the records of a change belonged to a collection that has since been deleted, and that deletion can still be undone, the collection comes back first, with its settings, fields and records, and the change is undone into it. When it can no longer be brought back, you are asked whether to make a new collection for the records. Changes made before the deletion can still be undone in the collection brought back.
  （**元に戻すときに、必要なら削除したコレクションも復活させるようにしました。** 変更したレコードのコレクションがその後で削除されていても、その削除が元に戻せるなら、まずコレクションを設定・項目・レコードごと復活させ、そこへ変更を戻します。復活できない場合は、新しいコレクションを作ってレコードを戻すかどうかを確認します。削除より前の変更も、復活したコレクションで元に戻せます。）
- **When an undo cannot be done, the reason is shown**, instead of "Nothing to undo".
  （**元に戻せなかったときは、その理由を表示します。** これまでは理由にかかわらず「元に戻す変更はありません」と表示していました。）

### Fixed

- **A secret collection could be opened without its 6-digit key** when its owner had shared it with a group the owner belongs to.
  （**シークレットコレクションが、6桁のシークレットキーなしで開ける場合がありました。** オーナーが、自分も入っているグループとそのコレクションを共有していた場合です。）
- **Someone could send another user's held attachments to the trash** by clearing the snapshots of a collection that was not theirs. Only the owner can do this now.
  （**ほかの人のコレクションのスナップショットを消去すると、そのオーナーが保管していた添付ファイルがゴミ箱へ移る問題を修正しました。** 消去できるのはオーナーだけです。）
- **A secret value could reach someone it was shared with without the key**, through the text shown for reading a field.
  （**秘匿項目の値が、鍵を渡していない共有相手に届く場合がありました。** 欄の読み仮名の表示を通じてです。）
- **Someone a collection is shared with could put back secret fields they cannot change** by undoing their own change. Undo now writes only what their own save could write.
  （**共有された人が元に戻すと、変更できないはずの秘匿項目まで古い値に戻る問題を修正しました。** 元に戻す操作では、その人が保存で書き換えられる範囲だけを戻します。）
- **Undoing a move could put the records into a deleted collection**, where they could not be seen.
  （**移動を元に戻すと、レコードが削除済みのコレクションに戻され、見えなくなる問題を修正しました。**）
- **The secret fields of a duplicated collection could not be opened.** The copy now takes the collection's own key with it.
  （**複製したコレクションの秘匿項目が開けない問題を修正しました。** 複製先にも、そのコレクションのキーを引き継ぎます。）
- **Restoring a backup over secret collections that are not open** stopped part way with no reason given. It now says so before anything is written: open them with their 6-digit key first.
  （**開いていないシークレットコレクションがあると、バックアップからの復元が理由も出さずに途中で止まる問題を修正しました。** 書き込む前に、先に6桁のシークレットキーで開くよう案内します。）
- The order of the entries in `appinfo/info.xml` now follows the Nextcloud app schema.
  （`appinfo/info.xml` の項目の並び順を、Nextcloud のアプリのスキーマに合わせました。）

## 0.21.2 — 2026-10-19

Translations corrected after a review. In sixteen languages, sentences that used another word than the rest of RegiBase — for a snapshot, the master key, a secret field, a record, or the form of address — now use the same one; in Japanese this includes "Undo / change history" and the wording around secret fields and keys. Two Brazilian Portuguese texts that were written the European way — "Definições" for Settings, and the line under the theme setting — now read as they do in Brazil. No feature was added or changed.
（翻訳の見直しを受けて訳を直しました。16 の言語で、スナップショット、マスターキー、秘匿項目、レコード、呼びかけ方について、RegiBase のほかの画面と違う語を使っていた文を、同じ語にそろえました。日本語では「元に戻す / 変更履歴」や、秘匿項目とキーまわりの言い方も直しました。ブラジル向けポルトガル語で、ポルトガルの言い方になっていた 2 か所（設定を表す「Definições」と、テーマ設定の説明）も、ブラジルの言い方に直しました。機能の追加や変更はありません。）

## 0.21.1 — 2026-10-11

Only the Japanese text was rewritten — the README, the App Store description and the changelog — to read naturally. No feature was added or changed.
（README・App Store の説明・変更履歴の日本語の文章を、自然な日本語に差し替えただけです。機能の追加や変更はありません。）

## 0.21.0 — 2026-10-08

An AI assistant, through the new AI-Hub app, and the fixes from a review of the whole app.
（新しいアプリ AI-Hub を利用した AI アシスタントを追加し、アプリ全体の見直しで見つかった問題を修正しました。）

### Added

- **An AI assistant, through the AI-Hub app.** A chat beside the open collection that knows RegiBase. It answers in words and writes out what to type; it changes nothing. **It never sees the value of a secret field**: the browser strips them before anything is sent, and the server drops them again as a second line of defence. Administration settings → RegiBase → AI assistant: on or off, who may use it, what it may read. Shown only when AI-Hub is installed.
  （**AI-Hub アプリを利用した AI アシスタントを追加しました。** 開いているコレクションの横に、RegiBase の使い方を理解したチャットが表示されます。質問には文章で答え、入力すべき内容を示しますが、データを変更することはありません。**秘匿項目の値を見ることはありません**（ブラウザーが送信前に取り除き、念のためサーバー側でも再度取り除きます）。管理者設定 → RegiBase → AI アシスタントで、有効・無効、利用できるユーザー、読み取れる範囲を設定できます。AI-Hub がインストールされている場合にのみ表示されます。）

### Fixed

- **Someone a collection is shared with, view-only, no longer receives its secret fields** in records, exports or searches. They were returned as they stood, in plain text when the owner had not set a master key.
  （**閲覧のみの権限で共有された相手には、秘匿項目が渡らないようにしました。** これまでは、レコード、エクスポート、検索の結果で秘匿項目がそのまま返され、オーナーがマスターキーを設定していない場合は平文のままでした。）
- **Putting a session version back no longer brings back plain secrets.** Encrypting, or changing the master key, now covers the versions kept by session as well; they were left as they were, and restoring one wrote the old text back.
  （**セッションごとのバージョンを戻したときに、暗号化前の秘匿項目が戻らないようにしました。** 暗号化やマスターキーの変更を、セッションごとに保存されたバージョンにも適用するようにしました。これまではバージョンが元のまま残っていたため、戻すと古い内容が書き戻されていました。）
- **A hidden collection's PIN is asked on every path to it**, including the owner's own: changing, duplicating or sharing it, and listing its secrets. Only some of them asked before.
  （**シークレットコレクションでは、オーナー自身の操作も含め、すべての操作で 6 桁のキーを求めるようにしました。** 変更、複製、共有、秘匿項目の一覧表示などで、これまでは キーを求めない場合がありました。）
- **Deleting an account clears the versions kept for it**; they were left behind.
  （**アカウントを削除すると、そのアカウントのバージョンも削除されるようにしました。** これまでは削除されずに残っていました。）

## 0.20.3 — 2026-09-29

Three layers of protection against losing data. A move made on 2026-09-27 could not be undone:
snapshots were limited to a small number shared by every collection, one saved form rewrote each
of its records as a snapshot of its own and pushed everything older out, and a move was only kept
in the collection the records went to.
（データを失わないための3重の保護を入れました。2026-09-27 に行った移動を元に戻せなかったことがきっかけです。スナップショットの件数が全コレクション共通の少ない上限で、項目を1回保存するだけでレコードの数だけ記録されて古い記録が押し出され、移動は移動先のコレクションにしか記録されていませんでした。）

### Added

- **Versions by session.** A version of a collection begins when a record is first changed or
  deleted, and holds everything done until the browser is closed or the user signs out. Any
  version can be put back: changed records get their contents back, deleted and moved records come
  back (and leave the collection they were moved to), records added in it go, and changed fields
  are put back. Open them from the collection's settings.
  （セッションごとのバージョンを追加しました。コレクションのバージョンは、レコードを最初に変更または削除したときに始まり、ブラウザーを閉じるかサインアウトするまでの作業がすべて入ります。どのバージョンも戻せます。変更したレコードは元の内容に戻り、削除・移動したレコードは戻り（移動先のコレクションからは消えます）、そのバージョンで追加したレコードは削除され、変更した項目も元に戻ります。コレクション設定から開きます。）

### Changed

- **Snapshots keep every change and deletion in a collection, with no limit.** A move is kept in
  both collections — from the one it left, a moved record is a deleted record — and undoing either
  puts the records back.
  （スナップショットに、コレクションの変更と削除を上限なくすべて残すようにしました。移動は移動元と移動先の両方に残ります。移動元から見ると、移動したレコードは削除したレコードと同じだからです。どちらを元に戻しても、レコードが戻ります。）
- **Attachments are kept, not trashed.** The attachment of a deleted record, and one an edit
  replaced, goes to a hidden `.snapshot` folder inside the collection's folder, keeps its file id,
  and comes back with the record. It goes to the trash only when nothing can bring it back any more.
  （削除や編集で外れた添付ファイルを、ゴミ箱に移さずに保管するようにしました。コレクションのフォルダー内の隠しフォルダー `.snapshot` に、ファイル ID もそのままで移し、レコードと一緒に戻ります。ゴミ箱に移すのは、もう戻す手段がなくなったときだけです。）
- **Putting a version back clears the collection's snapshots**, and the other half of any move in
  them, so nothing left can undo a change that is no longer there.
  （バージョンを戻すと、そのコレクションのスナップショットと、そこに含まれる移動の対になる記録も消去するようにしました。もう存在しない変更を、残った記録で元に戻さないためです。）
- **Restoring a backup with "overwrite" returns everything to the backed-up state** and clears the
  snapshots, the versions and the held attachments of what was there before. "Merge" and "add" keep
  what is there.
  （バックアップを「上書き」で復元すると、すべてがバックアップ時点の状態に戻り、それまでのスナップショット・バージョン・保管していた添付ファイルは消去されます。「マージ」と「追加」では、今のデータを残します。）
- The per-record versions and the snapshot limit are no longer shown; the versions by session take
  their place.
  （レコードごとのバージョンとスナップショットの件数の設定は、表示しないようにしました。代わりにセッションごとのバージョンを使います。）

## 0.20.0 — 2026-09-25

A release of fixes. Every part of RegiBase was reviewed line by line — the page, the server,
encryption, sharing, backup and restore — and everything the review found is fixed here. Several
of the fixes close security gaps, so **updating is recommended for every installation**.
（不具合を修正したリリースです。画面・サーバー・暗号化・共有・バックアップと復元のすべてを1行ずつ点検し、見つかった問題をすべて修正しました。セキュリティに関わる修正を含むため、**すべての環境で更新をおすすめします**。）

### Security

- **Shared collections are more tightly confined.** Undo, version history, attachments and bulk
  edits now respect the share's permission level, its edit lock and its removal; an editor can
  only write the collection's own fields, and can attach only files they own or may reshare.
  A hidden (secret) collection can no longer be opened by its id without the 6-digit key.
  （共有されたコレクションでできることを、厳しく制限しました。元に戻す操作・バージョン履歴・添付ファイル・一括編集は、共有の権限・編集ロック・共有の解除に従います。編集者が書き込めるのはそのコレクションの項目だけで、添付できるのは自分のファイルか、再共有できるファイルだけです。シークレットコレクションは、6 桁のキーがなければ ID を指定しても開けません。）
- **Sharing follows your Nextcloud sharing settings** — sharing off, group sharing off, "only
  with members of your own groups" and excluded groups — when searching for people, when
  sharing, and when restoring a backup. If the administrator tightens those settings later, a
  share they no longer allow is paused (it cannot be listed or opened) until they allow it
  again; the owner sees it marked **⏸ Paused**.
  （共有は、Nextcloud の共有設定（共有の無効化、グループ共有の無効化、「自分のグループのメンバーとだけ共有」、除外するグループ）に従うようにしました。相手の検索、共有、バックアップの復元のいずれでも同じです。管理者が後から設定を厳しくすると、許可されなくなった共有は、再び許可されるまで停止します（一覧に出ず、開けません）。オーナーの画面には **⏸ 停止中** と表示されます。）
- **Repeated wrong passwords are slowed down** — for the backup password, share passwords and
  the secret-collection key.
  （バックアップのパスワード・共有パスワード・シークレットコレクションのキーを何度も間違えると、しばらく待たないと次を試せないようにしました。）
- **An unlocked share is tied to that share and its password**: changing the share password
  or sharing again locks it.
  （共有のロック解除を、その共有とパスワードに結び付けるようにしました。共有パスワードを変更したり、共有し直したりすると、再びロックされます。）
- Deleting a user or group now removes their shares, so a new account with the same name
  does not inherit them. Images are served only in image formats (no SVG). Reading a
  collection no longer creates folders, and "delete the folder too" only ever removes folders
  under RegiBase's own save folder.
  （ユーザーやグループを削除すると、その共有も削除するようにしました。同じ名前で作り直したアカウントが、共有を引き継ぐことはありません。画像は画像形式でだけ返します（SVG は返しません）。コレクションを読み込むだけではフォルダーを作らず、「フォルダーも削除」で消すのは RegiBase の保存先の中のフォルダーだけにしました。）

### Encryption

- **Secret fields shared with others no longer use your own key.** A share carries the
  collection's own key, wrapped with the share password, and the share password itself never
  reaches the server.
  （秘匿項目を共有するときに、自分のキーを使わないようにしました。コレクション専用のキーを共有パスワードで暗号化して渡します。共有パスワードそのものがサーバーに届くことはありません。）
- **Changing or removing the master key now covers everything** — hidden collections, record
  versions and the undo history included — and is all-or-nothing: if anything cannot be
  converted, nothing is changed.
  （マスターキーの変更・削除を、シークレットコレクション・レコードのバージョン・元に戻す履歴まで含めて、すべてに適用するようにしました。1 つでも変換できないものがあれば、何も変更しません。）
- **New or changed master keys must be at least 8 characters** and are strengthened with
  600,000 PBKDF2 rounds (was 250,000). **Your current master key keeps working unchanged.**
  （新しく設定・変更するマスターキーは 8 文字以上とし、PBKDF2 による 60 万回（これまでは 25 万回）の反復処理で強化するようにしました。**今のマスターキーは、そのまま使えます。**）
- The remembered key is kept in the browser in a form that cannot be read out, per device and
  per login; a device where encryption is off no longer keeps an old key.
  （記憶したキーは、取り出せない形でブラウザーの中に、端末ごと・ログインごとに保存するようにしました。暗号化をオフにした端末には、古いキーを残しません。）
- A failed decryption no longer overwrites the secret value when the record is saved.
  （復号に失敗したレコードを保存しても、秘匿項目の値が上書きされないようにしました。）

### Backup and restore

- **A backup can have a password of its own**, instead of your login password. Restoring
  always asks for your login password first (and the archive's own password, if it has one).
  （**バックアップに、専用のパスワードを付けられるようにしました。** 付けない場合は、これまでどおりログインパスワードを使います。復元するときは、必ず先にログインパスワードを確認します（専用のパスワードを付けたアーカイブでは、そのパスワードも入力します）。）
- Backup and restore stream the data instead of loading it all into memory, so large
  attachments no longer fail.
  （バックアップと復元で、データ全体をメモリに読み込まず、ストリーミングで処理するようにしました。大きな添付ファイルでも失敗しなくなりました。）
- A backup now also brings back settings, shares, templates, hidden collections and the date
  each record was created. An overwrite restore checks the archive first and changes nothing
  if it is not whole; if saving an attachment fails, the files already saved are cleaned up.
  （バックアップから、設定・共有・テンプレート・シークレットコレクション・レコードの登録日も復元するようにしました。上書きで復元するときは、先にアーカイブの中身を確かめ、欠けていれば何も変更しません。添付ファイルの保存に失敗したときは、保存済みのファイルを片付けます。）
- Merge and add match fields by name and type (secret fields only with secret fields), refuse
  a backup made with a different master key, and never merge into a locked collection.
  （「マージ」と「追加」では、項目を名前と種類で照合するようにしました（秘匿項目は秘匿項目とだけ照合します）。別のマスターキーで作ったバックアップは受け付けず、ロック中のコレクションにはマージしません。）

### Editing records

- **Two people editing the same record no longer overwrite each other silently**: the later
  save is stopped and you are asked what to do. Replace-all skips records someone else has
  saved since you loaded them, and tells you how many.
  （同じレコードを 2 人が編集したときに、知らないうちに上書きされないようにしました。後から保存した人には、どうするかを確認します。「すべて置換」は、読み込んだ後にほかの人が保存したレコードを飛ばし、その件数を知らせます。）
- Decimal numbers, URLs without `https://` and e-mail addresses with international domains
  can be saved. Phone fields accept `#`, `*` and full-width hyphens. Only the fields you changed
  are checked against the input rules, and the server now checks them too.
  （数値の項目の小数、`https://` のない URL、国際化ドメイン名（日本語ドメインなど）のメールアドレスを保存できるようにしました。電話番号の項目では `#`・`*`・全角のハイフンを使えます。入力規則で確認するのは変更した項目だけで、サーバー側でも確認します。）
- Saving twice quickly no longer creates two records; switching collections quickly no longer
  shows or edits the wrong records; checkbox values are kept; closing an editor with unsaved
  changes asks first; failed saves are reported.
  （保存ボタンを続けて押しても、レコードが 2 件できないようにしました。コレクションをすばやく切り替えても、別のレコードを表示・編集しないようにしました。チェックボックスの値が消えないようにしました。保存していない変更があるまま閉じようとすると確認します。保存に失敗したときは、その旨を表示します。）
- Saving a template, or editing one, keeps its view and join settings. Bulk edits keep record
  versions.
  （テンプレートを保存・編集しても、表示設定と連結設定が消えないようにしました。一括編集でもレコードのバージョンを残します。）

### Search and import

- Normal search looks only in the values; regular-expression search has help that matches what
  it does, and an invalid or too-heavy pattern is reported instead of matching everything.
  （通常の検索では、値だけを探すようにしました。正規表現の検索は、ヘルプを実際の動作に合わせ、正しくないパターンや重すぎるパターンは、全件を一致とせずにその旨を知らせます。）
- CSV import reads Shift_JIS files (Excel's Japanese CSV) and detects `,` `;` or tab
  separators. Columns whose headings would give the same key are no longer overwritten.
  Contacts import keeps second and later phone numbers, e-mails and birthdays without a year
  (in the notes); JSON import keeps large whole numbers exactly.
  （CSV のインポートで、Shift_JIS（Excel の日本語 CSV）のファイルを読み込み、区切り文字（`,`・`;`・タブ）を自動で判別するようにしました。見出しが同じキーになる列も、上書きせずに取り込みます。連絡先からのインポートでは、2 件目以降の電話番号・メールアドレスと、年のない誕生日をメモに残します。JSON のインポートでは、大きな整数を丸めずにそのまま取り込みます。）

### Other

- `occ` commands mask secret fields unless `--reveal` is given (also for accounts without
  encryption), and `regibase:master` no longer leaves data half-converted.
  （`occ` のコマンドは、`--reveal` を付けない限り秘匿項目をマスクするようにしました（暗号化していないアカウントでも同じです）。`regibase:master` が、データを変換の途中のまま残すことはなくなりました。）
- Error responses no longer show internal messages; names, icons and colours are checked
  against what the database and the page can hold.
  （エラーの応答に、内部のメッセージを表示しないようにしました。名前・アイコン・色は、データベースと画面で扱える長さと形式のものだけを受け付けます。）
- **21 languages**: Portuguese now comes as **Brazilian Portuguese** and **European
  Portuguese** (the previous "Português" was Brazilian and stays selected). All languages were
  reviewed by a second translator, and counts use the right singular or plural form in every
  language (for example "1 Eintrag" / "2 Einträge", or the one / few / many forms of Russian, Polish
  and Czech).
  （**21 言語**に対応しました。ポルトガル語は **ブラジル** と **ポルトガル** の 2 つに分けました（これまでの「Português」はブラジル版で、選んでいた場合は、そのまま選ばれています）。すべての言語の訳を別の翻訳者が見直し、件数の単数形・複数形を全言語で正しくしました（ドイツ語の「1 Eintrag／2 Einträge」、ロシア語・ポーランド語・チェコ語の数による形の違いなど）。）
- The unused full build of Vue is no longer shipped.
  （使っていない Vue のフルビルドを同梱しないようにしました。）

## 0.19.2 — 2026-09-17

### Changed

- **Nextcloud 35 is now supported. There are no other changes.** The supported range
  is widened from 30–34 to 30–35. The app itself is unchanged from 0.19.1: it was tested
  on Nextcloud 35 against the changes that release makes for apps, and ran without
  modification.
  （**Nextcloud 35 に対応しました。それ以外の変更はありません。** 対応範囲を 30〜34 から 30〜35 に広げました。アプリ本体は 0.19.1 から変わっていません。Nextcloud 35 でアプリ向けに変わった点に照らして試験し、修正なしで動くことを確認しました。）

## 0.19.1 — 2026-09-08

### Fixed

- **Fixed a bug where clicking outside a dialog while editing made the edit screen
  disappear.** In every editing dialog — the record editor, collection edit, collection
  settings, Settings and the rest — clicking outside no longer closes it and discards what you
  were entering; close it with ✕, Cancel or Save.
  （**編集中にダイアログの外をクリックすると、編集画面が消えてしまう不具合を修正しました。** レコードの編集、コレクション編集、コレクション設定、設定などのすべての編集ダイアログで、外側をクリックしても閉じず、入力中の内容も消えなくなりました。閉じるときは ✕、「キャンセル」、「保存」を使います。）
- **The package now passes Nextcloud's integrity check.** The signature shipped with 0.19.0
  listed two files the package does not contain (`appinfo/CHANGELOG.md` and
  `appinfo/README.md` — duplicates of the ones at the root), so every server running
  RegiBase reported "Some files have not passed the integrity check" in its admin
  overview. The signature is now generated from the packaged files alone. No app code
  has changed.
  （**Nextcloud の整合性チェックを通るようにしました。** 0.19.0 の署名には、パッケージに含まれていない 2 つのファイル（`appinfo/CHANGELOG.md` と `appinfo/README.md`。ルートにあるファイルの複製）が載っていたため、RegiBase を入れたすべてのサーバーで、管理画面の概要に「Some files have not passed the integrity check」と表示されていました。署名は、パッケージに入れたファイルだけから作るようにしました。アプリのコードは変わっていません。）

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
