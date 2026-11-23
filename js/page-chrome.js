/**
 * page-chrome.js
 * The running head and foot: text (and an optional small logo) printed in the
 * page margins of every body page through CSS @page margin boxes, with the page
 * number as "n of N" from counter(page) and counter(pages). Never on a cover.
 *
 * A template opts in with optional fields on its default export (README,
 * Template contract):
 *   runningHead:  {left?, centre?, right?}   text with tokens {title} {author}
 *   runningFoot:  {left?, centre?, right?}   {date} {subject} {page} {pages}
 *   runningStyle: {fontFamily, fontSize, fontWeight, fontStyle, color}
 *   runningLogo:  {src, slot, height}        slot: head-left ... foot-right
 * ("center" is read as "centre" too, in the rows and the logo slots.)
 *
 * Geometry. The page margin is the same on every side (manifest.page.margin).
 * Head text sits on the bottom of its margin box and foot text on the top, a
 * gap of at most 6 mm from the text column, so the text is never closer than
 * RUNNING_LIMITS.edgeMm (11 mm) to the paper edge: the print-quality check
 * (server/qa/pdf-qa.mjs) refuses text within 8 mm. Below a margin of
 * RUNNING_LIMITS.minMarginMm (18 mm) there is no room, and nothing is printed
 * in the margins. Text never wraps (a second line would climb towards the
 * edge), and Chromium does not clip a margin box, so each slot is cut to the
 * characters its width holds.
 *
 * Pure: plain data in, a CSS string out. Values written into CSS are escaped
 * as CSS strings (cssString) or allow-listed; title and author are user text.
 */

import {FONT_FAMILIES, SYMBOL_FALLBACK_FAMILIES} from './fonts.js';
import {marginMm, normalizeExportOpts, pageBoxMm} from './export-options.js';

export const RUNNING_TOKENS = Object.freeze(['title', 'author', 'date', 'subject', 'page', 'pages']);
export const RUNNING_SLOTS = Object.freeze(['left', 'centre', 'right']);
export const RUNNING_LOGO_SLOTS = Object.freeze(['head-left', 'head-centre', 'head-right', 'foot-left', 'foot-centre', 'foot-right']);

export const RUNNING_LIMITS = Object.freeze({
    /** Characters of a slot's text as the template writes it. */
    textMax: 120,
    /** Characters of one value ({title}, {author}, {date}, {subject}) before the slot's own cut. */
    valueMax: 80,
    /** The smallest page margin with a running head and foot. */
    minMarginMm: 18,
    /** The closest margin text (and logo) comes to the paper edge. */
    edgeMm: 11,
    /** The widest gap between margin text and the text column. */
    gapMaxMm: 6,
    fontSizeMinPt: 6,
    fontSizeMaxPt: 10,
    logoMinMm: 3,
    logoMaxMm: 8,
    /** Characters of a logo data: URI (about 190 KB of image). */
    logoUriMax: 256 * 1024,
});

export const RUNNING_DEFAULTS = Object.freeze({fontFamily: 'Inter', fontSize: 8, fontWeight: 400, fontStyle: 'normal', color: '#5b6673'});

const MM_PER_PT = 25.4 / 72;
const LINE_HEIGHT = 1.2;
/** A generous average glyph width, in em, for cutting a slot to its width. */
const CHAR_EM = 0.6;
/** What one page number counts as when a slot is cut (up to 999). */
const COUNTER_CHARS = 3;
const COLOR_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
const LOGO_RE = /^data:image\/(?:svg\+xml|png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/;
const TOKEN_RE = /\{(title|author|date|subject|page|pages)\}/g;
// Controls, the line and paragraph separators, and lone surrogates.
const UNPRINTABLE_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;
const BOXES = {
    head: {left: '@top-left', centre: '@top-center', right: '@top-right'},
    foot: {left: '@bottom-left', centre: '@bottom-center', right: '@bottom-right'},
};
/** A slot as CSS spells it (text-align, background-position). */
const cssSide = (slot) => (slot === 'centre' ? 'center' : slot);

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const round2 = (n) => Math.round(n * 100) / 100;

/** Text on one line: no controls, single spaces, at most max characters (an ellipsis marks a cut). */
export function cleanRunningText(value, max) {
    const chars = Array.from(String(value == null ? '' : value).replace(UNPRINTABLE_RE, ' ').replace(/\s+/g, ' ').trim());
    if (chars.length <= max) return chars.join('');
    return max < 2 ? '' : `${chars.slice(0, max - 1).join('').trimEnd()}\u2026`;
}

/**
 * A CSS string literal holding the text and nothing else: quotes, backslashes and
 * < > & (so no </style> can close the style element) as hex escapes, controls as
 * spaces.
 * @param {*} value
 * @returns {string}
 */
export function cssString(value) {
    let out = '"';
    for (const ch of String(value == null ? '' : value).replace(UNPRINTABLE_RE, ' ')) {
        out += /["'\\<>&]/.test(ch) ? `\\${ch.codePointAt(0).toString(16)} ` : ch;
    }
    return `${out}"`;
}

function normalizeRow(row) {
    if (!isObject(row)) return null;
    const out = {};
    for (const slot of RUNNING_SLOTS) {
        const given = slot === 'centre' && row.centre === undefined ? row.center : row[slot];
        const text = typeof given === 'string' ? cleanRunningText(given, RUNNING_LIMITS.textMax) : '';
        if (text) out[slot] = text;
    }
    return Object.keys(out).length ? out : null;
}

function normalizeStyle(style) {
    const s = isObject(style) ? style : {};
    const size = typeof s.fontSize === 'number' ? s.fontSize : Number((/^(\d+(?:\.\d+)?)pt$/.exec(String(s.fontSize || '')) || [])[1]);
    const weight = Number(s.fontWeight);
    return {
        // A vendored family only: anything else would print in a system font.
        fontFamily: FONT_FAMILIES.includes(s.fontFamily) ? s.fontFamily : RUNNING_DEFAULTS.fontFamily,
        fontSize: Number.isFinite(size) && size >= RUNNING_LIMITS.fontSizeMinPt && size <= RUNNING_LIMITS.fontSizeMaxPt
            ? size : RUNNING_DEFAULTS.fontSize,
        fontWeight: Number.isInteger(weight) && weight >= 100 && weight <= 900 && weight % 100 === 0 ? weight : RUNNING_DEFAULTS.fontWeight,
        fontStyle: s.fontStyle === 'italic' ? 'italic' : 'normal',
        color: typeof s.color === 'string' && COLOR_RE.test(s.color) ? s.color.toLowerCase() : RUNNING_DEFAULTS.color,
    };
}

function normalizeLogo(logo) {
    if (!isObject(logo) || typeof logo.src !== 'string' || !logo.src || logo.src.length > RUNNING_LIMITS.logoUriMax) return null;
    const height = typeof logo.height === 'number' ? logo.height : Number((/^(\d+(?:\.\d+)?)mm$/.exec(String(logo.height || '')) || [])[1]);
    const slot = typeof logo.slot === 'string' ? logo.slot.replace(/-center$/, '-centre') : '';
    return {
        src: logo.src,
        slot: RUNNING_LOGO_SLOTS.includes(slot) ? slot : 'foot-right',
        height: Number.isFinite(height) && height >= RUNNING_LIMITS.logoMinMm && height <= RUNNING_LIMITS.logoMaxMm ? height : 5,
    };
}

/**
 * A template's running head and foot as checked plain data, or null when it has none.
 * The logo's src is kept as given: the export steps embed it as a data: URI
 * (server/harness.html, js/pdf-export.js), and only a data: image URI prints.
 * @param {object|null} template  a template's default export
 * @returns {{head: object|null, foot: object|null, style: object, logo: {src: string, slot: string, height: number}|null}|null}
 */
export function normalizeRunning(template) {
    if (!isObject(template)) return null;
    const head = normalizeRow(template.runningHead);
    const foot = normalizeRow(template.runningFoot);
    const logo = normalizeLogo(template.runningLogo);
    if (!head && !foot && !logo) return null;
    return {head, foot, style: normalizeStyle(template.runningStyle), logo};
}

/**
 * One slot's content as a list of parts: text (tokens filled in, values cut to
 * share what is left) and the two page counters, cut as a whole to maxChars.
 */
function slotParts(text, values, maxChars) {
    const parts = [];
    let last = 0;
    for (const m of text.matchAll(TOKEN_RE)) {
        if (m.index > last) parts.push({text: text.slice(last, m.index)});
        if (m[1] === 'page' || m[1] === 'pages') parts.push({counter: m[1]});
        else parts.push({value: cleanRunningText(values[m[1]], RUNNING_LIMITS.valueMax)});
        last = m.index + m[0].length;
    }
    if (last < text.length) parts.push({text: text.slice(last)});
    const length = (p) => (p.counter ? COUNTER_CHARS : Array.from(p.text ?? p.value).length);
    const fixed = parts.filter((p) => p.value === undefined).reduce((n, p) => n + length(p), 0);
    const valued = parts.filter((p) => p.value !== undefined && p.value);
    const wanted = valued.reduce((n, p) => n + length(p), 0);
    if (wanted > maxChars - fixed) {
        const share = Math.max(0, Math.floor((maxChars - fixed) / valued.length));
        for (const p of valued) p.value = cleanRunningText(p.value, share);
    }
    // Still too long (a long literal): cut at the end.
    const out = [];
    let used = 0;
    for (const p of parts) {
        const n = length(p);
        if (used + n <= maxChars) {
            out.push(p);
            used += n;
            continue;
        }
        if (!p.counter) {
            const rest = cleanRunningText(p.text ?? p.value, maxChars - used);
            if (rest) out.push({text: rest});
        }
        break;
    }
    return out.map((p) => (p.counter ? {counter: p.counter} : {text: p.text ?? p.value})).filter((p) => p.counter || p.text);
}

function contentValue(parts) {
    return parts.map((p) => (p.counter ? `counter(${p.counter})` : cssString(p.text))).join(' ');
}

/** True when the parts print something other than spaces. */
const printable = (parts) => parts.some((p) => p.counter || p.text.trim());

/**
 * The @page margin-box rules for a running head and foot, or '' when there is
 * none, the margin is under RUNNING_LIMITS.minMarginMm, the layout is the one
 * continuous page (which has no page margin), or every slot is empty (a
 * {author} slot with no author). With a cover the first page has none.
 * @param {ReturnType<typeof normalizeRunning>} running
 * @param {{title?: string, author?: string, date?: string, subject?: string}} values  the token values
 * @param {{pageOpts?: object, cover?: boolean}} [layout]
 * @returns {string}
 */
export function buildRunningCss(running, values = {}, {pageOpts = {}, cover = false} = {}) {
    if (!running) return '';
    const opts = normalizeExportOpts(pageOpts);
    if (opts.layout === 'continuous') return '';
    const m = marginMm(opts.margin);
    if (m < RUNNING_LIMITS.minMarginMm) return '';
    const contentMm = pageBoxMm(opts).width - 2 * m;
    const st = running.style || normalizeStyle(null);
    const lineMm = st.fontSize * LINE_HEIGHT * MM_PER_PT;
    const textGap = round2(Math.min(RUNNING_LIMITS.gapMaxMm, m - RUNNING_LIMITS.edgeMm - lineMm));
    const logo = running.logo && LOGO_RE.test(running.logo.src) ? running.logo : null;
    const logoGap = logo ? round2(Math.min(RUNNING_LIMITS.gapMaxMm, m - RUNNING_LIMITS.edgeMm - logo.height)) : 0;
    const font = `font-family: '${st.fontFamily}', ${SYMBOL_FALLBACK_FAMILIES}, sans-serif; font-size: ${st.fontSize}pt; `
        + `font-weight: ${st.fontWeight}; font-style: ${st.fontStyle}; color: ${st.color}; line-height: ${LINE_HEIGHT};`;
    const rules = [];
    const boxes = [];
    for (const row of ['head', 'foot']) {
        const texts = running[row] || {};
        const logoSlot = logo && logo.slot.startsWith(`${row}-`) ? logo.slot.slice(row.length + 1) : null;
        const used = RUNNING_SLOTS.filter((s) => s === logoSlot || texts[s]);
        if (!used.length) continue;
        // A centre slot takes a third and stays centred; otherwise the slots share the row.
        const share = used.includes('centre') ? 1 / 3 : 1 / used.length;
        const width = `${round2(share * 100)}%`;
        const maxChars = Math.max(1, Math.floor((contentMm * share) / (st.fontSize * MM_PER_PT * CHAR_EM)));
        const toBody = row === 'head' ? 'bottom' : 'top';
        for (const slot of used) {
            const box = BOXES[row][slot];
            if (slot === logoSlot) {
                rules.push(`  ${box} { content: ""; width: ${width}; background-image: url(${cssString(logo.src)}); `
                    + `background-repeat: no-repeat; background-size: auto ${logo.height}mm; `
                    + `background-position: ${cssSide(slot)} ${toBody} ${logoGap}mm; }`);
                boxes.push(box);
                continue;
            }
            const parts = slotParts(texts[slot], values, maxChars);
            if (!printable(parts)) continue;
            rules.push(`  ${box} { content: ${contentValue(parts)}; width: ${width}; ${font} text-align: ${cssSide(slot)}; `
                + `vertical-align: ${toBody}; padding-${toBody}: ${textGap}mm; white-space: nowrap; }`);
            boxes.push(box);
        }
    }
    if (!rules.length) return '';
    const first = cover ? `\n@page :first {\n${boxes.map((b) => `  ${b} { content: none; background: none; }`).join('\n')}\n}` : '';
    return `@page {\n${rules.join('\n')}\n}${first}`;
}

/**
 * Text in the running font for the print document's body, out of sight, so the
 * font loads and js/font-check.js confirms it like any other (margin boxes are
 * laid out only when printing). Every slot's text, values filled in, and the digits.
 * @param {ReturnType<typeof normalizeRunning>} running
 * @param {object} values
 * @returns {{css: string, text: string}|null}
 */
export function runningFontProbe(running, values = {}) {
    if (!running) return null;
    const st = running.style || normalizeStyle(null);
    const texts = [running.head, running.foot].filter(Boolean).flatMap((row) => RUNNING_SLOTS.map((s) => row[s]).filter(Boolean));
    const text = cleanRunningText(texts.map((t) => slotParts(t, values, 400).map((p) => p.text || '').join('')).join(' ')
        + ' 0123456789', 1200);
    const css = `.bd-running-probe { position: absolute; left: 0; top: 0; width: 1px; height: 1px; overflow: hidden; `
        + `visibility: hidden; white-space: nowrap; font-family: '${st.fontFamily}', ${SYMBOL_FALLBACK_FAMILIES}, sans-serif; `
        + `font-weight: ${st.fontWeight}; font-style: ${st.fontStyle}; }`;
    return {css, text};
}
