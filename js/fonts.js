/**
 * fonts.js
 * The templates' brand fonts and the code font, served from vendor/fonts/ (see its README).
 *
 * fontFaceCSS() returns the @font-face rules. URLs are absolute and built from
 * this module's own URL, so they resolve under any base path and also inside the
 * print window (an about:blank document). Pure: no DOM.
 *
 * font-display: block keeps text invisible for a moment rather than drawing it
 * in a fallback font, so a PDF printed as soon as the fonts are ready never
 * captures Arial or Helvetica.
 */

const FONT_DIR = new URL('../vendor/fonts/', import.meta.url).href;

// Each family ships two subsets, as Google Fonts serves them: "latin" and
// "latin-ext" (Central European, Romanian, Maori and other Latin letters). The
// unicode-range on each rule, copied from the Fontsource package CSS, lets the
// browser fetch latin-ext only for text that uses those characters.
const LATIN = 'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,'
    + 'U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD';
const LATIN_EXT = 'U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,'
    + 'U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF';
const STANDARD = {latin: LATIN, 'latin-ext': LATIN_EXT};
const UNICODE_RANGES = {
    montserrat: STANDARD,
    inter: STANDARD,
    'source-serif-pro': {
        latin: LATIN.replace('U+2000-206F,', 'U+2000-206F,U+2074,'),
        'latin-ext': 'U+0100-02AF,U+0304,U+0308,U+0329,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20CF,'
            + 'U+2113,U+2C60-2C7F,U+A720-A7FF',
    },
    // The families of the new templates (@fontsource 5.3.0): the standard ranges, checked against each package's CSS.
    figtree: STANDARD,
    fraunces: STANDARD,
    'schibsted-grotesk': STANDARD,
    'libre-caslon-text': STANDARD,
    'plus-jakarta-sans': STANDARD,
    'ibm-plex-sans': STANDARD,
    lora: STANDARD,
    'dm-sans': STANDARD,
};

/** Every weight, for a family's only italic: a bold italic then uses it as it is (a synthesised bold prints as Type 3). */
const ANY_WEIGHT = '100 900';

/** [family as the templates name it, weight, style, folder, weight range declared (default: the weight)] */
const STYLES = [
    ...[300, 400, 500, 600, 700, 800, 900].map((weight) => ['Montserrat', weight, 'normal', 'montserrat']),
    ['Montserrat', 400, 'italic', 'montserrat'],
    ['Montserrat', 600, 'italic', 'montserrat'],
    ...[400, 500, 600, 700].map((weight) => ['Inter', weight, 'normal', 'inter']),
    // True italics (before them an Inter italic was the roman, slanted): 400 serves the light weights, 700 the bold.
    ['Inter', 400, 'italic', 'inter', '100 500'],
    ['Inter', 700, 'italic', 'inter', '600 900'],
    ...[400, 600, 700].map((weight) => ['Source Serif Pro', weight, 'normal', 'source-serif-pro']),
    ['Source Serif Pro', 400, 'italic', 'source-serif-pro'],
    // Bold italic text would otherwise be a synthesised bold, which Chrome prints as a Type 3 font.
    ['Source Serif Pro', 700, 'italic', 'source-serif-pro'],
    // The new templates' families: only the weights they use (README, Fonts).
    ...[400, 500, 600, 700, 800].map((weight) => ['Figtree', weight, 'normal', 'figtree']),
    ['Figtree', 400, 'italic', 'figtree', ANY_WEIGHT],
    ...[500, 600, 700].map((weight) => ['Fraunces', weight, 'normal', 'fraunces']),
    ['Fraunces', 400, 'italic', 'fraunces', ANY_WEIGHT],
    ...[500, 700, 800].map((weight) => ['Schibsted Grotesk', weight, 'normal', 'schibsted-grotesk']),
    ['Schibsted Grotesk', 500, 'italic', 'schibsted-grotesk', ANY_WEIGHT],
    ...[400, 700].map((weight) => ['Libre Caslon Text', weight, 'normal', 'libre-caslon-text']),
    ['Libre Caslon Text', 400, 'italic', 'libre-caslon-text', ANY_WEIGHT],
    ...[600, 700, 800].map((weight) => ['Plus Jakarta Sans', weight, 'normal', 'plus-jakarta-sans']),
    ...[400, 500, 600, 700].map((weight) => ['IBM Plex Sans', weight, 'normal', 'ibm-plex-sans']),
    ['IBM Plex Sans', 400, 'italic', 'ibm-plex-sans', ANY_WEIGHT],
    ...[500, 600, 700].map((weight) => ['Lora', weight, 'normal', 'lora']),
    ['Lora', 500, 'italic', 'lora', ANY_WEIGHT],
    ...[400, 500, 700].map((weight) => ['DM Sans', weight, 'normal', 'dm-sans']),
];

/**
 * The code font: Adobe's Source Code Pro (npm source-code-pro 2.42.0), the
 * complete font in one file per style ("all": no unicode-range), so box
 * drawing, arrows and check marks in code blocks print in it too.
 */
const MONO_STYLES = [[400, 'normal'], [700, 'normal'], [400, 'italic'], [700, 'italic']];

/**
 * Symbols the brand fonts' latin subsets lack, so prose never falls back to a
 * system font. Each template's font stacks list these two after the brand font:
 * - "Source Code Pro Symbols": the Source Code Pro files again, limited to
 *   arrows, maths operators, box drawing, blocks, geometric shapes, ☐ ☑ and ✓,
 *   so other text (Cyrillic, Greek) never turns monospace;
 * - "Noto Sans Symbols 2" (@fontsource/noto-sans-symbols-2 5.3.0, its "symbols"
 *   file and that file's unicode-range): ✔ ✗ ✘ ❖ ★ ⚠ ✏ and other dingbats;
 * - "Noto Sans Symbols" (@fontsource/noto-sans-symbols 5.3.0, its "symbols" file,
 *   whose unicode-range is the same): ⚙ ☺ ♪ ⚑ ⛳ and the other symbols the first
 *   lacks. A character in the range but missing from a file goes on to the next.
 * Each Noto file is fetched only by a document that uses one of its characters.
 */
const CODE_SYMBOLS_RANGE = 'U+2190-21FF,U+2200-22FF,U+2500-25FF,U+2610-2611,U+2713';
const NOTO_SYMBOLS_RANGE = 'U+0001-000C,U+000E-001F,U+007F-009F,U+20DD-20E0,U+20E2-20E4,U+2150-218F,U+2190,U+2192,'
    + 'U+2194-2199,U+21AF,U+21E6-21F0,U+21F3,U+2218-2219,U+2299,U+22C4-22C6,U+2300-243F,U+2440-244A,U+2460-24FF,'
    + 'U+25A0-27BF,U+2800-28FF,U+2921-2922,U+2981,U+29BF,U+29EB,U+2B00-2BFF,U+4DC0-4DFF,U+FFF9-FFFB,U+10140-1018E,'
    + 'U+10190-1019C,U+101A0,U+101D0-101FD,U+102E0-102FB,U+10E60-10E7E,U+1D2C0-1D2D3,U+1D2E0-1D37F,U+1F000-1F0FF,'
    + 'U+1F100-1F1AD,U+1F1E6-1F1FF,U+1F30D-1F30F,U+1F315,U+1F31C,U+1F31E,U+1F320-1F32C,U+1F336,U+1F378,U+1F37D,'
    + 'U+1F382,U+1F393-1F39F,U+1F3A7-1F3A8,U+1F3AC-1F3AF,U+1F3C2,U+1F3C4-1F3C6,U+1F3CA-1F3CE,U+1F3D4-1F3E0,U+1F3ED,'
    + 'U+1F3F1-1F3F3,U+1F3F5-1F3F7,U+1F408,U+1F415,U+1F41F,U+1F426,U+1F43F,U+1F441-1F442,U+1F444,U+1F446-1F449,'
    + 'U+1F44C-1F44E,U+1F453,U+1F46A,U+1F47D,U+1F4A3,U+1F4B0,U+1F4B3,U+1F4B9,U+1F4BB,U+1F4BF,U+1F4C8-1F4CB,U+1F4D6,'
    + 'U+1F4DA,U+1F4DF,U+1F4E3-1F4E6,U+1F4EA-1F4ED,U+1F4F7,U+1F4F9-1F4FB,U+1F4FD-1F4FE,U+1F503,U+1F507-1F50B,U+1F50D,'
    + 'U+1F512-1F513,U+1F53E-1F54A,U+1F54F-1F5FA,U+1F610,U+1F650-1F67F,U+1F687,U+1F68D,U+1F691,U+1F694,U+1F698,'
    + 'U+1F6AD,U+1F6B2,U+1F6B9-1F6BA,U+1F6BC,U+1F6C6-1F6CF,U+1F6D3-1F6D7,U+1F6E0-1F6EA,U+1F6F0-1F6F3,U+1F6F7-1F6FC,'
    + 'U+1F700-1F7FF,U+1F800-1F80B,U+1F810-1F847,U+1F850-1F859,U+1F860-1F887,U+1F890-1F8AD,U+1F8B0-1F8BB,'
    + 'U+1F8C0-1F8C1,U+1F900-1F90B,U+1F93B,U+1F946,U+1F984,U+1F996,U+1F9E9,U+1FA00-1FA6F,U+1FA70-1FA7C,'
    + 'U+1FA80-1FA89,U+1FA8F-1FAC6,U+1FACE-1FADC,U+1FADF-1FAE9,U+1FAF0-1FAF8,U+1FB00-1FBFF';

/** The symbol fallbacks, as a CSS font-family list the templates insert after their brand font. */
export const SYMBOL_FALLBACK_FAMILIES = "'Source Code Pro Symbols', 'Noto Sans Symbols 2', 'Noto Sans Symbols'";

/** Every vendored face: family as the templates name it, weight, style, subset, unicode-range (null: all), file. */
export const FONT_FACES = Object.freeze([
    ...STYLES.flatMap(([family, weight, style, dir, weightRange]) => (
        ['latin', 'latin-ext'].map((subset) => Object.freeze({
            family, weight, style, subset,
            ...(weightRange ? {weightRange} : {}),
            unicodeRange: UNICODE_RANGES[dir][subset],
            file: `${dir}/${dir}-${subset}-${weight}-${style}.woff2`,
        }))
    )),
    ...MONO_STYLES.map(([weight, style]) => Object.freeze({
        family: 'Source Code Pro', weight, style, subset: 'all', unicodeRange: null,
        file: `source-code-pro/source-code-pro-all-${weight}-${style}.woff2`,
    })),
    ...[400, 700].map((weight) => Object.freeze({
        family: 'Source Code Pro Symbols', weight, style: 'normal', subset: 'symbols', unicodeRange: CODE_SYMBOLS_RANGE,
        file: `source-code-pro/source-code-pro-all-${weight}-normal.woff2`,
    })),
    // One weight only, declared for every weight (weightRange): a bold heading then uses it as it is,
    // because a synthesised bold prints as a Type 3 font.
    Object.freeze({
        family: 'Noto Sans Symbols 2', weight: 400, weightRange: '100 900', style: 'normal', subset: 'symbols',
        unicodeRange: NOTO_SYMBOLS_RANGE, file: 'noto-sans-symbols-2/noto-sans-symbols-2-symbols-400-normal.woff2',
    }),
    Object.freeze({
        family: 'Noto Sans Symbols', weight: 400, weightRange: '100 900', style: 'normal', subset: 'symbols',
        unicodeRange: NOTO_SYMBOLS_RANGE, file: 'noto-sans-symbols/noto-sans-symbols-symbols-400-normal.woff2',
    }),
]);

/** The vendored family names, once each: the only families a PDF may print in (js/font-check.js, server/qa/pdf-qa.mjs). */
export const FONT_FAMILIES = Object.freeze([...new Set(FONT_FACES.map((f) => f.family))]);

/**
 * The @font-face rules for every vendored face.
 * @param {string} [baseUrl]  folder holding the font directories (default: vendor/fonts/ of this app)
 * @returns {string}
 */
/**
 * The faces a template's CSS names, in the subset every document needs (latin,
 * or the whole font for the code font). The symbol fallbacks and latin-ext load
 * only for text that uses them.
 * @param {string} css
 */
export function templateFaces(css) {
    return FONT_FACES.filter((f) => (f.subset === 'latin' || f.subset === 'all') && css.includes(f.family));
}

export function fontFaceCSS(baseUrl = FONT_DIR) {
    const base = String(baseUrl).endsWith('/') ? String(baseUrl) : `${baseUrl}/`;
    return FONT_FACES.map((f) => `@font-face {
  font-family: '${f.family}';
  font-style: ${f.style};
  font-weight: ${f.weightRange || f.weight};
  font-display: block;
  src: url("${base}${f.file}") format("woff2");${f.unicodeRange ? `
  unicode-range: ${f.unicodeRange};` : ''}
}`).join('\n');
}
