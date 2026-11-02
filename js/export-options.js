/**
 * export-options.js
 * One validator for export options (format, page size, orientation, margin, and the
 * page options: a custom page size, the layout and fit to size).
 *
 * The page options end up in print CSS (`@page { size: ...; margin: ... }`), and they
 * arrive from localStorage, each document's stored record, the toolbar and the Page
 * options dialog, template manifests, front matter and the PDF API. Every entry point
 * runs them through normalizeExportOpts(), which only lets allow-listed values
 * through and falls back to the defaults for anything else, so a stored value such
 * as `A4; } body { display:none` never reaches the CSS. Lengths (a custom size, a
 * margin) are parsed to numbers and a unit from an allow-list and written back by
 * this module (formatCustomSize, validMargin), never passed on as given. A
 * document's record is read and written through docExportOpts(), which keeps its
 * allow-listed keys only.
 */

/** The page sizes the toolbar offers (index.html #export-paper-size). */
export const PAGE_SIZES = Object.freeze(['A4', 'A3', 'A5', 'Letter', 'Legal', 'Slide']);
export const ORIENTATIONS = Object.freeze(['portrait', 'landscape']);

/**
 * Portrait paper sizes in mm, [width, height]: ISO A sizes, US Letter (8.5 x 11 in) and Legal (8.5 x 14 in).
 * Slide is a 16:9 screen page of 10 x 5.625 in (PowerPoint's widescreen slide), always landscape.
 */
export const PAGE_SIZES_MM = Object.freeze({
    A3: Object.freeze([297, 420]),
    A4: Object.freeze([210, 297]),
    A5: Object.freeze([148, 210]),
    Letter: Object.freeze([215.9, 279.4]),
    Legal: Object.freeze([215.9, 355.6]),
    Slide: Object.freeze([142.9, 254]),
});

/** Sizes printed in one orientation only: the orientation option is ignored for them. */
export const LANDSCAPE_ONLY = Object.freeze(['Slide']);

/** The paper sizes a template offers unless its manifest lists its own (manifest.page.sizes). */
export const PAPER_SIZES = Object.freeze(['A4', 'A3', 'A5', 'Letter', 'Legal']);

/**
 * The page sizes a template offers: manifest.page.sizes (known sizes only, in its
 * order), else PAPER_SIZES. A template made for screens lists 'Slide'.
 * @param {object} [manifest]
 * @returns {readonly string[]}
 */
export function templatePageSizes(manifest) {
    const listed = manifest && manifest.page && Array.isArray(manifest.page.sizes)
        ? manifest.page.sizes.filter((s) => typeof s === 'string' && PAGE_SIZES.includes(s))
        : [];
    return Object.freeze(listed.length ? [...new Set(listed)] : [...PAPER_SIZES]);
}

/**
 * The page a template starts on: manifest.page.defaultSize (one of its own sizes) as pageSize and
 * manifest.page.defaultOrientation as orientation, each only when valid; {} for a template that names
 * neither. They are fallbacks for what a request or the editor leaves unchosen (normalizeExportOpts).
 * @param {object} [manifest]
 * @returns {{pageSize?: string, orientation?: string}}
 */
export function templatePageDefaults(manifest) {
    const page = manifest && manifest.page;
    const out = {};
    if (!page) return out;
    if (templatePageSizes(manifest).includes(page.defaultSize)) out.pageSize = page.defaultSize;
    if (ORIENTATIONS.includes(page.defaultOrientation)) out.orientation = page.defaultOrientation;
    return out;
}

/**
 * Width and height in mm of a page size in an orientation (unknown values: A4 portrait).
 * A landscape-only size (Slide) is landscape whatever the orientation.
 * @param {string} pageSize
 * @param {string} orientation
 * @returns {{width: number, height: number}}
 */
export function pageDimensionsMm(pageSize, orientation) {
    const size = pick(pageSize, PAGE_SIZES, 'A4');
    const [w, h] = PAGE_SIZES_MM[size];
    return orientation === 'landscape' || LANDSCAPE_ONLY.includes(size) ? {width: h, height: w} : {width: w, height: h};
}

// ── Page options: custom size, layout, fit, margin override ─────────────────

/** The pageSize of a document printed at a custom size (customSize holds the size). */
export const CUSTOM_SIZE = 'Custom';
/** paged: pages of the chosen size (the default). continuous: the whole document on one page as tall as it is. */
export const LAYOUTS = Object.freeze(['paged', 'continuous']);
/** off (the default); width: blocks wider than the text column are scaled down to it; widest (continuous only):
 *  the page is made as wide as the widest block. */
export const FITS = Object.freeze(['off', 'width', 'widest']);
/** The units a custom page size is written in; px is the CSS pixel (1/96 in). */
export const PAGE_UNITS = Object.freeze(['mm', 'cm', 'in', 'px']);
/** The units a margin is written in. */
export const MARGIN_UNITS = Object.freeze(['mm', 'cm', 'in', 'pt']);
/** mm in one of each unit. */
export const MM_PER_UNIT = Object.freeze({mm: 1, cm: 10, in: 25.4, pt: 25.4 / 72, px: 25.4 / 96});

export const PAGE_LIMITS = Object.freeze({
    /** The shortest side of a page. */
    minSideMm: 30,
    /** The longest side of a page: Chromium's (and the PDF format's usual) 200 in. */
    maxSideMm: 5080,
    /** The largest page area, 4 square metres (A0 is one): one request cannot ask for an enormous page. */
    maxAreaMm2: 4000000,
    /** The narrowest (and, paged, the shortest) text column a margin may leave. */
    minContentMm: 20,
    /** The smallest scale fit to size uses; a block that needs less is left at full size and warned about. */
    fitMinScale: 0.4,
    /** The longest a continuous document may be in all, split into tall pages (ten pages of 5080 mm). */
    maxContinuousMm: 50800,
    /** The most pages a custom size may print, estimated before printing: 6,525 tiny pages took 10 s and about
     *  0.25 GB over the browser's own memory, and an ordinary 2 MB document on A4 is about 1,000. */
    maxPages: 5000,
});

// A number: up to five digits, up to three decimals. No exponent, sign, or anything else.
const LENGTH_NUM = '(\\d{1,5}(?:\\.\\d{1,3})?|\\.\\d{1,3})';
const CUSTOM_SIZE_RE = new RegExp(`^ *${LENGTH_NUM} *[x×] *${LENGTH_NUM} *(mm|cm|in|px) *$`, 'i');

/** A number as written into CSS: at most three decimals, no trailing zeros, never an exponent. */
export function formatNumber(n) {
    const r = Math.round(n * 1000) / 1000;
    return Number.isFinite(r) ? String(r) : '0';
}

/** mm from a number and an allow-listed unit (0 for anything else). */
const toMm = (value, unit) => (Number.isFinite(value) && Object.prototype.hasOwnProperty.call(MM_PER_UNIT, unit)
    ? value * MM_PER_UNIT[unit] : 0);

/**
 * A custom page size as numbers: "100x150mm", "8.5 x 11 in", "1200x800px" (any case, x or the times
 * sign, spaces allowed), each side from PAGE_LIMITS.minSideMm to maxSideMm and the area up to
 * maxAreaMm2; else null. The width and height are exactly as typed: no orientation turns them.
 * @param {*} value
 * @returns {{width: number, height: number, unit: string, widthMm: number, heightMm: number}|null}
 */
export function parseCustomSize(value) {
    if (typeof value !== 'string' || value.length > 40) return null;
    const m = CUSTOM_SIZE_RE.exec(value);
    if (!m) return null;
    const unit = m[3].toLowerCase();
    return checkedSize(Number(m[1]), Number(m[2]), unit);
}

function checkedSize(width, height, unit) {
    if (!PAGE_UNITS.includes(unit) || !Number.isFinite(width) || !Number.isFinite(height)) return null;
    const widthMm = Math.round(toMm(width, unit) * 1000) / 1000;
    const heightMm = Math.round(toMm(height, unit) * 1000) / 1000;
    const {minSideMm, maxSideMm, maxAreaMm2} = PAGE_LIMITS;
    if (widthMm < minSideMm || heightMm < minSideMm || widthMm > maxSideMm || heightMm > maxSideMm) return null;
    if (widthMm * heightMm > maxAreaMm2) return null;
    return {width, height, unit, widthMm, heightMm};
}

/**
 * The canonical text of a custom size ("100x150mm"), from numbers and an allow-listed unit,
 * within the limits; else null.
 * @param {{width: number, height: number, unit: string}} size
 * @returns {string|null}
 */
export function formatCustomSize(size) {
    if (!size || typeof size.width !== 'number' || typeof size.height !== 'number' || typeof size.unit !== 'string') return null;
    const width = Math.round(size.width * 1000) / 1000;
    const height = Math.round(size.height * 1000) / 1000;
    return checkedSize(width, height, size.unit) ? `${formatNumber(width)}x${formatNumber(height)}${size.unit}` : null;
}

/** A custom size string in its canonical form, else null. */
const canonicalSize = (value) => formatCustomSize(parseCustomSize(value));

/**
 * Width and height in mm of normalised page options: the custom size, else the named size in its
 * orientation (pageDimensionsMm).
 * @param {{pageSize?: string, orientation?: string, customSize?: string}} pageOpts
 * @returns {{width: number, height: number}}
 */
export function pageBoxMm(pageOpts = {}) {
    const o = pageOpts || {};
    const custom = o.pageSize === CUSTOM_SIZE ? parseCustomSize(o.customSize) : null;
    return custom ? {width: custom.widthMm, height: custom.heightMm} : pageDimensionsMm(o.pageSize, o.orientation);
}

/** A margin (validMargin's form, 20mm, 2cm, 0.75in, 54pt) in mm; 0 for anything else. */
export function marginMm(margin) {
    const m = typeof margin === 'string' ? MARGIN_RE.exec(margin) : null;
    return m ? toMm(Number(m[1]), m[2]) : 0;
}

/**
 * What is wrong with page options that pass the allow-lists but cannot print: a margin that leaves a
 * text column narrower (paged: or shorter) than PAGE_LIMITS.minContentMm. A sentence, or null.
 * @param {object} pageOpts  normalised (normalizeExportOpts)
 * @returns {string|null}
 */
export function pageOptsProblem(pageOpts) {
    const {width, height} = pageBoxMm(pageOpts);
    const m = marginMm(pageOpts && pageOpts.margin);
    const min = PAGE_LIMITS.minContentMm;
    const continuous = pageOpts && pageOpts.layout === 'continuous';
    if (width - 2 * m < min || (!continuous && height - 2 * m < min)) {
        return `The margin leaves less than ${min} mm of page for the text: use a smaller margin or a larger page.`;
    }
    return null;
}

/**
 * The page options a document's front matter sets (`page-size`, `layout`, `fit`, `margin`), each
 * checked as the API checks it: a named size in any case or a custom size, then the allow-lists. A
 * value that is not valid is left out with a warning that names the key and what is allowed, never
 * the value itself.
 * @param {object} meta  parseFrontMatter's meta
 * @returns {{opts: {pageSize?: string, layout?: string, fit?: string, margin?: string}, warnings: string[]}}
 */
export function frontMatterPageOpts(meta) {
    const m = meta && typeof meta === 'object' ? meta : {};
    const opts = {};
    const warnings = [];
    const value = (key) => (Object.prototype.hasOwnProperty.call(m, key) && typeof m[key] === 'string' ? m[key] : undefined);
    const size = value('page-size');
    if (size !== undefined) {
        const named = PAGE_SIZES.find((s) => s.toLowerCase() === size.toLowerCase());
        const custom = named ? null : canonicalSize(size);
        if (named || custom) opts.pageSize = named || custom;
        else warnings.push(`The front matter's page-size is not ${PAGE_SIZES.join(', ')} or a size such as 100x150mm, so it was ignored.`);
    }
    const layout = value('layout');
    if (layout !== undefined) {
        if (LAYOUTS.includes(layout.toLowerCase())) opts.layout = layout.toLowerCase();
        else warnings.push(`The front matter's layout is not ${LAYOUTS.join(' or ')}, so it was ignored.`);
    }
    const fit = value('fit');
    if (fit !== undefined) {
        if (FITS.includes(fit.toLowerCase())) opts.fit = fit.toLowerCase();
        else warnings.push(`The front matter's fit is not ${FITS.join(', ')}, so it was ignored.`);
    }
    const margin = value('margin');
    if (margin !== undefined) {
        const valid = validMargin(margin);
        if (valid) opts.margin = valid;
        else warnings.push('The front matter\'s margin is not a length such as 12mm, 1.5cm, 0.5in or 0, so it was ignored.');
    }
    return {opts, warnings};
}

// A colour and nothing else: hex, rgb()/rgba(), hsl()/hsla() with plain numbers, or a CSS named colour.
// No url(), var(), calc(), color-mix() or any other function, no ; or } that could end the rule.
const NUM = '(?:\\d{1,3}(?:\\.\\d+)?|\\.\\d+)';
const ALPHA = `${NUM}%?`;
const HEX_RE = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/;
const RGB_RE = new RegExp(`^rgba?\\(\\s*(?:${NUM}%?\\s*,\\s*${NUM}%?\\s*,\\s*${NUM}%?(?:\\s*,\\s*${ALPHA})?`
    + `|${NUM}%?\\s+${NUM}%?\\s+${NUM}%?(?:\\s*\\/\\s*${ALPHA})?)\\s*\\)$`);
const HSL_RE = new RegExp(`^hsla?\\(\\s*(?:${NUM}(?:deg)?\\s*,\\s*${NUM}%\\s*,\\s*${NUM}%(?:\\s*,\\s*${ALPHA})?`
    + `|${NUM}(?:deg)?\\s+${NUM}%\\s+${NUM}%(?:\\s*\\/\\s*${ALPHA})?)\\s*\\)$`);
/** The CSS named colours (CSS Color 4), and transparent. */
export const NAMED_COLOURS = Object.freeze(new Set((
    'aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood '
    + 'cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray '
    + 'darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen '
    + 'darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue '
    + 'firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew '
    + 'hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan '
    + 'lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray '
    + 'lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue '
    + 'mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred '
    + 'midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid '
    + 'palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple '
    + 'rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue '
    + 'slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white '
    + 'whitesmoke yellow yellowgreen transparent').split(' ')));

/**
 * A template's page canvas colour (its pageBackground): hex (#rgb, #rgba, #rrggbb, #rrggbbaa),
 * rgb()/rgba() or hsl()/hsla() with plain numbers, or a named colour; trimmed and lower case, else
 * null. It is written into print CSS, so nothing else gets through.
 * @param {*} value
 * @returns {string|null}
 */
export function validPageBackground(value) {
    if (typeof value !== 'string' || value.length > 64) return null;
    const v = value.trim().toLowerCase();
    return HEX_RE.test(v) || RGB_RE.test(v) || HSL_RE.test(v) || NAMED_COLOURS.has(v) ? v : null;
}
export const FORMATS = Object.freeze(['pdf', 'docx', 'pptx']);

export const EXPORT_DEFAULTS = Object.freeze({
    format: 'pdf',
    pageSize: 'A4',
    orientation: 'portrait',
    margin: '20mm',
});

const MARGIN_RE = /^(\d{1,3}(?:\.\d+)?)(mm|cm|in|pt)$/;
// Largest sane margin per unit (about 100mm each).
const MARGIN_MAX = {mm: 100, cm: 10, in: 4, pt: 288};

function pick(value, allowed, fallback) {
    return typeof value === 'string' && allowed.includes(value) ? value : fallback;
}

/**
 * A margin such as '20mm', '0.75in' or '0' within bounds, written back from its number and unit
 * ('0' is '0mm', '12.50mm' is '12.5mm'), else null.
 */
export function validMargin(value) {
    if (typeof value !== 'string') return null;
    const m = MARGIN_RE.exec(value === '0' ? '0mm' : value);
    if (!m) return null;
    const n = Number(m[1]);
    return Number.isFinite(n) && n <= MARGIN_MAX[m[2]] ? `${formatNumber(n)}${m[2]}` : null;
}

/**
 * Return a clean copy of export options: allow-listed values kept, anything
 * else replaced by its default.
 *
 * A custom size comes as pageSize "100x150mm" (the API, front matter) or as pageSize "Custom" with
 * customSize "100x150mm" (the editor, which remembers the size while a named one is chosen); either
 * way the result is pageSize "Custom" and customSize in its canonical form. Custom sizes are allowed
 * with every template: the template's sizes only limit the named ones. Fit "widest" needs the
 * continuous layout; on pages it is "width".
 * @param {*} opts  untrusted options object
 * @param {{margin?: string, sizes?: readonly string[], pageSize?: string, orientation?: string}} [fallback]  defaults
 *        to use instead of EXPORT_DEFAULTS; sizes: the page sizes the template offers (templatePageSizes), default
 *        every size. A size outside them falls back to A4, or to the first one offered when A4 is not. pageSize and
 *        orientation: the template's default page (templatePageDefaults). margin: the template's own, which a
 *        valid opts.margin overrides.
 * @returns {{format: string, pageSize: string, orientation: string, margin: string, layout: string, fit: string,
 *          customSize?: string}}
 */
export function normalizeExportOpts(opts, fallback = {}) {
    const src = opts && typeof opts === 'object' && !Array.isArray(opts) ? opts : {};
    const fb = fallback && typeof fallback === 'object' ? fallback : {};
    // The fallbacks are validated too, so a bad template manifest cannot slip through.
    const choose = (key, allowed) => pick(src[key], allowed, pick(fb[key], allowed, EXPORT_DEFAULTS[key]));
    const offered = Array.isArray(fb.sizes) ? fb.sizes.filter((s) => PAGE_SIZES.includes(s)) : [];
    const sizes = offered.length ? offered : PAGE_SIZES;
    const custom = src.pageSize === CUSTOM_SIZE ? canonicalSize(src.customSize) : canonicalSize(src.pageSize);
    // A chosen portrait wins over a landscape-only default size (Slide): the size then falls back as usual.
    const fbSize = LANDSCAPE_ONLY.includes(fb.pageSize) && src.orientation === 'portrait' ? undefined : fb.pageSize;
    const pageSize = custom ? CUSTOM_SIZE : pick(src.pageSize, sizes, pick(fbSize, sizes,
        sizes.includes(EXPORT_DEFAULTS.pageSize) ? EXPORT_DEFAULTS.pageSize : sizes[0]));
    const layout = pick(src.layout, LAYOUTS, 'paged');
    const fit = pick(src.fit, FITS, 'off');
    return {
        format: choose('format', FORMATS),
        pageSize,
        orientation: LANDSCAPE_ONLY.includes(pageSize) ? 'landscape' : choose('orientation', ORIENTATIONS),
        margin: validMargin(src.margin) || validMargin(fb.margin) || EXPORT_DEFAULTS.margin,
        layout,
        fit: fit === 'widest' && layout !== 'continuous' ? 'width' : fit,
        ...(custom ? {customSize: custom} : {}),
    };
}

/**
 * The choices each stored document keeps in its record's exportOpts (js/docmanager.js), and the
 * validators that admit them. The margin here is the document's override; without one the template's
 * margin is used. customSize is kept while a named size is chosen, so choosing Custom size again gives
 * it back. A later page option is added here with its validator; records without it fall back as for
 * any missing key, so the stored shape needs no migration. Lengths are stored in their canonical form.
 */
const DOC_EXPORT_VALID = Object.freeze({
    format: (v) => (FORMATS.includes(v) ? v : null),
    pageSize: (v) => (PAGE_SIZES.includes(v) || v === CUSTOM_SIZE ? v : null),
    orientation: (v) => (ORIENTATIONS.includes(v) ? v : null),
    customSize: (v) => canonicalSize(v),
    layout: (v) => (LAYOUTS.includes(v) ? v : null),
    fit: (v) => (FITS.includes(v) ? v : null),
    margin: (v) => validMargin(v),
});
export const DOC_EXPORT_KEYS = Object.freeze(Object.keys(DOC_EXPORT_VALID));
/** The most a clean exportOpts may take as JSON; anything larger is dropped whole. The widest valid record
 *  (every key, the longest custom size and margin) takes under 180, so the cap is never reached by one. */
export const DOC_EXPORT_MAX_JSON = 256;

/**
 * A stored record's exportOpts, cleaned on the way in and out of storage. Only the record's own
 * DOC_EXPORT_KEYS are read, each kept only when it is an allow-listed string (lengths in their
 * canonical form); every other key is dropped. The orientation is kept as chosen (portrait with Slide
 * stays portrait), so leaving a landscape-only size gives it back. Missing keys are left out for the
 * caller to fill in.
 * @param {*} value  untrusted (from IndexedDB or the editor)
 * @returns {{format?: string, pageSize?: string, orientation?: string, customSize?: string, layout?: string,
 *          fit?: string, margin?: string}|null}  null when `value` is not a plain object (no settings
 *          stored); {} when it held nothing usable
 */
export function docExportOpts(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const out = {};
    for (const key of DOC_EXPORT_KEYS) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
        const v = value[key];
        const clean = typeof v === 'string' && v.length <= 64 ? DOC_EXPORT_VALID[key](v) : null;
        if (clean) out[key] = clean;
    }
    return JSON.stringify(out).length <= DOC_EXPORT_MAX_JSON ? out : {};
}
