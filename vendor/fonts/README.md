# Vendored fonts

The templates' brand fonts and the code font, served by the app itself so the preview and the PDF use them with no
network, no third-party font host and no system fallback. `js/fonts.js` lists every file and emits the `@font-face`
rules (`fontFaceCSS()`). `server/test/fonts.test.mjs` checks with `pdffonts` that a PDF holds only these fonts.

| Folder              | Family (CSS name)  | Faces                                             | Source package                     | Licence |
|---------------------|--------------------|---------------------------------------------------|------------------------------------|---------|
| `montserrat/`       | `Montserrat`       | 300, 400, 500, 600, 700, 800, 900; italic 400, 600 | `@fontsource/montserrat` 5.3.0     | OFL-1.1 |
| `inter/`            | `Inter`            | 400, 500, 600, 700; italic 400 (for 100 to 500), 700 (for 600 to 900) | `@fontsource/inter` 5.3.0 | OFL-1.1 |
| `source-serif-pro/` | `Source Serif Pro` | 400, 600, 700; italic 400, 700                    | `@fontsource/source-serif-pro` 5.3.0 | OFL-1.1 |
| `source-code-pro/`  | `Source Code Pro`  | 400, 700; italic 400, 700 (code blocks and inline code) | `source-code-pro` 2.42.0 (Adobe) | OFL-1.1 |
| `noto-sans-symbols-2/` | `Noto Sans Symbols 2` | 400, declared for every weight (symbol fallback) | `@fontsource/noto-sans-symbols-2` 5.3.0 | OFL-1.1 |
| `noto-sans-symbols/` | `Noto Sans Symbols` | 400, declared for every weight (last symbol fallback) | `@fontsource/noto-sans-symbols` 5.3.0 | OFL-1.1 |
| `figtree/`          | `Figtree`          | 400, 500, 600, 700, 800; italic 400 (every weight) | `@fontsource/figtree` 5.3.0        | OFL-1.1 |
| `fraunces/`         | `Fraunces`         | 500, 600, 700; italic 400 (every weight)          | `@fontsource/fraunces` 5.3.0       | OFL-1.1 |
| `schibsted-grotesk/` | `Schibsted Grotesk` | 500, 700, 800; italic 500 (every weight)        | `@fontsource/schibsted-grotesk` 5.3.0 | OFL-1.1 |
| `libre-caslon-text/` | `Libre Caslon Text` | 400, 700; italic 400 (every weight)             | `@fontsource/libre-caslon-text` 5.3.0 | OFL-1.1 |
| `plus-jakarta-sans/` | `Plus Jakarta Sans` | 600, 700, 800                                   | `@fontsource/plus-jakarta-sans` 5.3.0 | OFL-1.1 |
| `ibm-plex-sans/`    | `IBM Plex Sans`    | 400, 500, 600, 700; italic 400 (every weight)     | `@fontsource/ibm-plex-sans` 5.3.0  | OFL-1.1 |
| `lora/`             | `Lora`             | 500, 600, 700; italic 500 (every weight)          | `@fontsource/lora` 5.3.0 (Reserved Font Name "Lora": used unmodified) | OFL-1.1 |
| `dm-sans/`          | `DM Sans`          | 400, 500, 700                                     | `@fontsource/dm-sans` 5.3.0        | OFL-1.1 |

The eight rows from `figtree/` down, and Inter's two italics, are the fonts of the new templates (README, Fonts for
templates; ROADMAP Milestone 10), only the weights those templates use: 1,127,024 bytes (1,101 KB) of woff2 for latin
and latin-ext together, of which the latin files are 647 KB. A browser fetches a family only for a template that
names it, and latin-ext only for text that uses it, so the existing templates load nothing more. Each package was
fetched with `npm pack @fontsource/<family>@5.3.0` and its sha512 checked against the registry's `dist.integrity`
before the files were copied; every `unicode-range` matches the package CSS (the standard latin and latin-ext
ranges in `js/fonts.js`).

- A family whose only italic is one weight declares it for every weight (`font-weight: 100 900`), as the symbol
  fallbacks do, so bold italic text uses it as it is instead of a synthesised bold (a Type 3 font).
- `Inter` has true italics: 400 italic for weights up to 500 and 700 italic for the bolder ones. Before them an Inter
  italic printed as the roman, slanted. In the existing templates this changes only italic text set in Inter (the
  unbranded template's headings and tables): `markdown-showcase.md` prints the same pages, with `Inter-Italic` and
  `Inter-BoldItalic` on three of them.
- Fontsource packaging gives some faces odd internal names, which a PDF shows: every Figtree weight is named
  "Figtree Light" (a PDF lists `FigtreeLight-Bold` for bold; the outlines are the right weight), DM Sans is the
  "DM Sans 9pt" optical size (`DMSans9pt-Regular`). The print-quality check (`server/qa/pdf-qa.mjs`
  `isVendoredFontName`) and `server/test/fonts.test.mjs` match a PDF font by family-name prefix, so these pass and a
  system font such as `DejaVuSans` does not.
- Coverage: Latin and Latin Extended, digits, quotes, dashes, currency; ↑ ↓ in most. None of them has ← → or ✓: those
  print from the symbol fallbacks every template lists after its brand font.

Source Code Pro is the complete font, not a Google Fonts subset, so box drawing (┌─┐), arrows (← →), ✓ ☐ ☑, block
shades and maths signs in code print in it: `source-code-pro-all-<weight>-<style>.woff2` are the package's
`WOFF2/TTF/SourceCodePro-{Regular,Bold,It,BoldIt}.ttf.woff2`, renamed and otherwise unchanged (267 KB in all), with no
`unicode-range`. Its `OFL.txt` is the package's `LICENSE.md`. It has no ligatures, and lacks ✔ ✗ ✘ ❖ ★ (and Greek and
Cyrillic in the italics).

Symbols the brand fonts lack (box drawing, ← → ⇒, ✓ ☐ ☑, █ ▓ ░, ≠ ≤ ≥ and dingbats such as ✔ ✗ ❖ ★) come from three
fallbacks every template lists right after its brand font (`SYMBOL_FALLBACK_FAMILIES` in `js/fonts.js`), so no
system font reaches a PDF:

- `Source Code Pro Symbols`: the Source Code Pro files again, under a `unicode-range` limited to arrows, maths
  operators, box drawing, blocks, geometric shapes, ☐ ☑ and ✓, so other text (Cyrillic, Greek) never turns monospace.
- `Noto Sans Symbols 2`: the package's `files/noto-sans-symbols-2-symbols-400-normal.woff2` (373 KB) with the
  `unicode-range` from its `400.css`, fetched only by a document that uses one of those characters; `OFL.txt` is the
  package's `LICENSE`. It has one weight, declared as `font-weight: 100 900`: a synthesised bold would print as a
  Type 3 font. For the same reason Source Serif Pro has its 700 italic.
- `Noto Sans Symbols`: the package's `files/noto-sans-symbols-symbols-400-normal.woff2` (56 KB), declared the same way
  and with the same `unicode-range` (both packages give their `symbols` file that range in `400.css`). It comes last
  and holds ⚙ ☺ ♪ ⚑ ⛳ and other symbols Noto Sans Symbols 2 lacks: a character inside a face's range but missing from
  its file goes on to the next family. `OFL.txt` is the package's `LICENSE`.

None of these files is subset: each is the package file, unchanged. Emoji are not covered on purpose (a colour emoji
font is large and prints as Type 3 anyway); they print from the system emoji font.

- Files are the packages' `files/<family>-<subset>-<weight>-<style>.woff2`, copied unchanged, for two subsets:
  `latin` and `latin-ext` (Central European, Romanian, Maori and other Latin letters such as ř, Ł, ā, Ș). Each
  `@font-face` rule carries that subset's `unicode-range` from the package CSS, so the browser fetches `latin-ext` only
  for text that uses it. Cyrillic, Greek and Vietnamese are not vendored; those characters use the next font in the
  template's font stack. Symbols such as the unbranded cover's ❖ come from the symbol fallbacks above.
- Each folder's `OFL.txt` is the `LICENSE` file shipped in that package (SIL Open Font License 1.1).
- Font versions, from each package's `metadata.json`: Montserrat v31, Inter v20, Source Serif Pro v15, Figtree v9,
  Fraunces v38, Schibsted Grotesk v7, Libre Caslon Text v5, Plus Jakarta Sans v12, IBM Plex Sans v23, Lora v37,
  DM Sans v17 (Google Fonts releases, via [Fontsource](https://fontsource.org)).

To update: `npm install @fontsource/<family>` in a scratch folder, copy the same file names over these, check the
`unicode-range` values in `js/fonts.js` against the package's `<weight>.css`, update the versions above, and run
`node tests/run-all.mjs` (tests/test.js checks every listed face exists).
