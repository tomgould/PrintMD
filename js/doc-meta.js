/**
 * doc-meta.js
 * The document title rule, front matter, and the metadata object cover
 * templates receive.
 *
 * Pure: no DOM, no app state, so the app, the store migration, a headless
 * export harness and the PDF API all derive the same title from the same Markdown.
 */

/** The first ATX level-1 heading (`# Title`) anywhere in the source. */
export const H1_TITLE_RE = /^#\s+(.+)$/m;

export const DEFAULT_TITLE = 'Untitled';

/**
 * The front matter keys PrintMD reads. Any other key is ignored. The page options (page-size,
 * layout, fit, margin) are checked by js/export-options.js frontMatterPageOpts.
 */
export const META_KEYS = Object.freeze(['title', 'author', 'date', 'template', 'subject', 'lang', 'print-links',
    'page-size', 'layout', 'fit', 'margin']);

/** The document language when none is given (front matter `lang`, the API's `lang`). */
export const DEFAULT_LANG = 'en';

/** A BCP 47 language tag in its common shapes: en, en-GB, zh-Hant-TW, sr-Latn. */
export const LANG_RE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{1,8}){0,3}$/;

/** Longest front matter value kept, in characters (code points). */
export const META_MAX_LENGTH = 200;

const META_KEY_SET = new Set(META_KEYS);
const OPEN_RE = /^---[ \t]*$/;
const CLOSE_RE = /^(?:---|\.\.\.)[ \t]*$/;
const KEY_VALUE_RE = /^([A-Za-z_][A-Za-z0-9_-]*)[ \t]*:(?:[ \t]+(.*)|[ \t]*)$/;
// C0 and C1 controls, plus the bidi embedding, override and isolate characters,
// which could make a cover title read differently from what it is.
const UNSAFE_CHARS_RE = /[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/g;

/**
 * A metadata value as text: control and bidi characters removed, whitespace
 * collapsed, cut to META_MAX_LENGTH. HTML is not touched: templates escape it.
 * @param {*} value
 * @returns {string}
 */
export function cleanMetaValue(value) {
    const text = String(value == null ? '' : value)
        .replace(/[\t\r\n]+/g, ' ')
        .replace(UNSAFE_CHARS_RE, '')
        .replace(/\s+/g, ' ')
        .trim();
    return Array.from(text).slice(0, META_MAX_LENGTH).join('').trim();
}

function unquote(value) {
    const v = value.trim();
    if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v[v.length - 1] === v[0]) return v.slice(1, -1);
    return v;
}

/**
 * Split an optional front matter block off the start of a Markdown source.
 *
 * The block opens with a `---` line as the very first line (a byte order mark
 * before it is skipped) and closes with a `---` or `...` line. Inside, simple
 * `key: value` lines; only the META_KEYS are kept, the last of a repeated key
 * wins, quotes around a value are optional, and empty values count as absent.
 * Blank lines, `#` comments and indented or `- ` continuation lines are allowed
 * and ignored. Anything else inside (a plain paragraph between two rules, say)
 * means the block is ordinary Markdown, so the source is returned unchanged, as
 * it is when the closing line is missing.
 *
 * @param {string} source  Markdown
 * @returns {{meta: {title?: string, author?: string, date?: string, template?: string, subject?: string,
 *            lang?: string, 'print-links'?: string, 'page-size'?: string, layout?: string, fit?: string,
 *            margin?: string}, body: string}}
 *          meta has no prototype; body is the Markdown after the block
 */
export function parseFrontMatter(source) {
    const text = String(source == null ? '' : source);
    const meta = Object.create(null);
    const none = {meta, body: text};
    const start = text.charCodeAt(0) === 0xfeff ? 1 : 0;

    const lines = [];
    let pos = start;
    let close = -1;
    while (pos <= text.length) {
        const nl = text.indexOf('\n', pos);
        const end = nl === -1 ? text.length : nl;
        const line = text.slice(pos, end).replace(/\r$/, '');
        const next = nl === -1 ? text.length : nl + 1;
        if (lines.length === 0) {
            if (!OPEN_RE.test(line)) return none;
        } else if (CLOSE_RE.test(line)) {
            close = next;
            break;
        }
        lines.push(line);
        if (nl === -1) break;
        pos = next;
    }
    if (close === -1) return none;

    let keyLines = 0;
    for (const line of lines.slice(1)) {
        if (!line.trim() || /^\s*#/.test(line) || /^[ \t]/.test(line) || /^-(?:[ \t]|$)/.test(line)) continue;
        const m = KEY_VALUE_RE.exec(line);
        if (!m) return none;
        keyLines++;
        const key = m[1].toLowerCase();
        if (!META_KEY_SET.has(key)) continue;
        const value = cleanMetaValue(unquote(m[2] || ''));
        if (value) meta[key] = value;
        else delete meta[key];
    }
    if (keyLines === 0) return none;
    return {meta, body: text.slice(close)};
}

/**
 * Title from front matter (`title:`), else the first `# ` heading, else "Untitled".
 * Both get cleanMetaValue: no control or bidi characters, at most META_MAX_LENGTH.
 * @param {string} source  Markdown
 * @returns {string}
 */
export function extractTitle(source) {
    const {meta, body} = parseFrontMatter(source);
    if (meta.title) return meta.title;
    const match = body.match(H1_TITLE_RE);
    return (match && cleanMetaValue(match[1])) || DEFAULT_TITLE;
}

/**
 * The date as cover pages show it, e.g. "15 January 2026".
 * @param {Date} [date]
 * @returns {string}
 */
export function formatDocDate(date = new Date()) {
    return date.toLocaleDateString('en-AU', {year: 'numeric', month: 'long', day: 'numeric'});
}

/**
 * A cover date from a Date or a string: an ISO `YYYY-MM-DD` string that names a
 * real day is formatted like formatDocDate, any other text is kept as written.
 * @param {Date|string} value
 * @returns {string}
 */
export function coverDate(value) {
    if (value instanceof Date) return formatDocDate(value);
    const text = cleanMetaValue(value);
    const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
    if (iso) {
        const [y, m, d] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
        const date = new Date(y, m - 1, d);
        if (date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === d) return formatDocDate(date);
    }
    return text;
}

const TRUE_WORDS = new Set(['true', 'yes', 'on', '1']);

/**
 * What the printed PDF carries beyond the cover: its language (written as
 * <html lang>, which Chromium puts in the PDF's catalog), the subject for the
 * document information, and whether link addresses are printed after the link
 * text. Explicit options win over the front matter (`lang`, `subject`,
 * `print-links: true`).
 * @param {string} source  Markdown, with or without front matter
 * @param {{lang?: string, subject?: string, printLinks?: boolean}} [opts]
 * @returns {{lang: string, subject: string, printLinks: boolean, warnings: string[]}}
 */
export function buildPrintMeta(source, {lang, subject, printLinks} = {}) {
    const {meta} = parseFrontMatter(source);
    const warnings = [];
    let tag = (typeof lang === 'string' && cleanMetaValue(lang)) || meta.lang || DEFAULT_LANG;
    if (!LANG_RE.test(tag)) {
        warnings.push(`The language is not a tag such as en or en-GB, so ${DEFAULT_LANG} was used.`);
        tag = DEFAULT_LANG;
    }
    const links = typeof printLinks === 'boolean' ? printLinks : TRUE_WORDS.has(String(meta['print-links'] || '').toLowerCase());
    return {
        lang: tag,
        subject: (typeof subject === 'string' && cleanMetaValue(subject)) || meta.subject || '',
        printLinks: links,
        warnings,
    };
}

/**
 * The metadata object templates receive (renderCover, preflightChecks).
 * Each field comes from the explicit option when it is a non-empty value, then
 * the front matter, then the default: the H1 title, no author, `today`.
 * @param {string} source  Markdown, with or without front matter
 * @param {{title?: string, author?: string, date?: Date|string, today?: Date, brand?: string}} [opts]
 *        title, author, date: explicit values; today: the fallback date (default now)
 * @returns {{title: string, author: string, date: string, brand: string}}
 */
export function buildDocMeta(source, {title, author, date, today, brand = ''} = {}) {
    const {meta} = parseFrontMatter(source);
    const given = (v) => (typeof v === 'string' ? cleanMetaValue(v) : '');
    const fallback = today instanceof Date ? today : new Date();
    const pickDate = date instanceof Date ? date : (given(date) || meta.date || fallback);
    return {
        title: given(title) || extractTitle(source),
        author: given(author) || meta.author || '',
        date: coverDate(pickDate),
        brand,
    };
}
