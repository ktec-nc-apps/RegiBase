# noto-emoji.woff2

A subset of **Noto Color Emoji** (the COLRv1 vector build) covering every one of the
1,849 emoji the icon picker offers.

## Why it is here

The picker used to depend entirely on whatever emoji font the viewer's device happens to
ship, and that dependency is not safe:

- **Windows has no flag glyphs at all** — on every Windows version. Segoe UI Emoji draws
  🇯🇵 as a boxed "JP" letter pair and 🏴󠁧󠁢󠁷󠁬󠁳󠁿 as an empty box. This is a deliberate omission,
  not a version gap, so it will not fix itself.
- **Older systems lack newer emoji.** Segoe UI Emoji only gained the Unicode 13 and 14
  additions (🫠 🫰 🫡 …) in Windows 11 22H2; on Windows 10 they are missing boxes.
- Linux and Android images vary in how recent their emoji font is.

Whichever emoji a user picks has to survive being viewed on someone else's device — a
shared collection is seen by other people — so the app carries its own copy.

## How it is wired up

Two `@font-face` rules, in this order:

1. `AppEmoji` — `src: local(...)` only, naming the platform emoji fonts. If the device
   has one, it is used and **nothing is downloaded**.
2. `AppEmojiFallback` — `src: url(noto-emoji.woff2)`. Font fallback reaches it only for
   the specific glyphs face 1 turned out to be missing.

So an up-to-date macOS or Linux machine never fetches the file, a Windows 11 machine
fetches it the first time a flag is drawn, and a Windows 10 machine also gets the newer
emoji from it. The browser caches it afterwards.

The `unicode-range` on both faces covers U+1F000–1FAFF, the tag characters used by
subdivision flags, ZWJ / VS16, and the ten BMP characters that take part in astral ZWJ
sequences (☠ ♀ ♂ ⚕ ⚖ ⚧ ✈ ❄ ❤ ⬛). It deliberately stops short of the older BMP emoji
(© ® ™ ‼ ↔ ☀ ⚽ …) and of the ASCII keycap bases: those have been in every emoji font
since Windows 8.1, and routing them through an emoji font would turn plain text
characters such as © and ™ into coloured pictures.

## Build

    curl -O https://raw.githubusercontent.com/googlefonts/noto-emoji/main/fonts/Noto-COLRv1.ttf
    python3 -m fontTools.subset Noto-COLRv1.ttf \
        --unicodes="<the 1412 code points used by data/emoji/list.json>,U+E0020-E007F" \
        --layout-features='*' --output-file=noto-emoji.ttf
    woff2_compress noto-emoji.ttf

The COLRv1 (vector) build is 1.7 MB where the CBDT (bitmap) build of the same coverage is
4.4 MB. COLRv1 needs Chrome/Edge 98+, Firefox 110+ or Safari 18+; that is safe here
because the file is only ever reached on devices whose own emoji font fell short, which in
practice means Windows, where Chrome and Edge are COLRv1-capable.

Noto Color Emoji is © 2013-2017 Google Inc. and licensed under the SIL Open Font
License 1.1 — see LICENSE-NotoColorEmoji.txt.
