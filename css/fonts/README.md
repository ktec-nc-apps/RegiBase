# emoji-flags.woff2

A subset of **Noto Color Emoji** containing only the flag emoji — the 26 regional
indicator symbols and the flag sequences they form, the subdivision flags built from
U+1F3F4 plus tag characters, and 🏁 🚩 🏳️ 🏳️‍🌈 🏳️‍⚧️.

It exists because Windows ships no flag glyphs at all: Segoe UI Emoji draws 🇯🇵 as a
boxed "JP" letter pair and 🏴󠁧󠁢󠁷󠁬󠁳󠁿 as an empty box, so the flags in the icon picker were
unusable there. The `@font-face` rule declares a `unicode-range` limited to those code
points, so the file is downloaded only when a flag is actually rendered, and then cached
by the browser. Every other emoji keeps using the system font.

Built with:

    python3 -m fontTools.subset /usr/share/fonts/truetype/noto/NotoColorEmoji.ttf \
        --unicodes="<flag code points>,U+E0020-E007F" --layout-features='*' \
        --output-file=flags.ttf
    woff2_compress flags.ttf

Noto Color Emoji is © 2013-2017 Google Inc. and licensed under the SIL Open Font
License 1.1 — see LICENSE-NotoColorEmoji.txt.
