/**
 * print-document.js
 * Builds the complete HTML document that is printed to PDF: template CSS,
 * highlight.js theme, page rules, cover page and body.
 *
 * Pure: it takes plain data and returns a string. No DOM, no window, no fetch,
 * so the app's print window and a headless renderer produce the same document.
 * The document never contains a script: the app's CSP blocks inline scripts, and
 * printing is driven from outside (js/pdf-export.js, or a headless browser).
 */

import {formatNumber, normalizeExportOpts, pageBoxMm, PAGE_LIMITS, validPageBackground} from './export-options.js';
import {fontFaceCSS} from './fonts.js';
import {buildRunningCss, runningFontProbe} from './page-chrome.js';
import {DEFAULT_LANG, LANG_RE} from './doc-meta.js';

/**
 * Print page CSS from export options: the @page size and margin, a zero margin
 * on the first page when it is a full-bleed cover, and the page size as CSS
 * variables (--bd-page-width, --bd-page-height) so a template's cover can fill
 * exactly one page in any size and orientation, plus the text column's height
 * (--bd-page-content-height), the most an image may take.
 * A size CSS has no name for (Slide, a custom size) is given in mm, written from
 * numbers. A page canvas colour (a template's pageBackground) fills every body
 * page, margins included; a cover page keeps none, so a full-bleed cover prints
 * as it would without it.
 *
 * The continuous layout (README, Export: Page options) is one page of the chosen
 * width with no page margin: the margin is the body block's padding, so the
 * cover runs edge to edge at the top and takes its own height, not a page's. The
 * height here is a start; js/page-layout.js measures the laid-out document and
 * writes the real one. Page breaks (a template's, a manual one in the Markdown)
 * are switched off, and the canvas colour fills the body block.
 * @param {{ pageSize?: string, orientation?: string, margin?: string, customSize?: string, layout?: string }} [opts]
 * @param {{cover?: boolean, background?: string}} [layout]  cover: the document starts with a cover page;
 *        background: the page colour (validPageBackground), else none
 * @returns {string}
 */
export function buildPageCss(opts = {}, {cover = false, background} = {}) {
    // Values go into CSS verbatim, so only allow-listed ones are used, and lengths are written from numbers.
    const o = normalizeExportOpts(opts);
    const {pageSize, orientation, margin} = o;
    const {width, height} = pageBoxMm(o);
    const colour = validPageBackground(background);
    if (o.layout === 'continuous') return continuousPageCss(width, height, margin, colour);
    const size = CSS_PAGE_SIZES.includes(pageSize) ? `${pageSize} ${orientation}` : `${formatNumber(width)}mm ${formatNumber(height)}mm`;
    return [
        `@page { size: ${size}; margin: ${margin}; }`,
        colour ? `@page { background: ${colour}; }` : '',
        cover ? `@page :first { margin: 0;${colour ? ' background: none;' : ''} }` : '',
        `:root { --bd-page-width: ${width}mm; --bd-page-height: ${height}mm; --bd-page-content-height: calc(${height}mm - 2 * ${margin}); }`,
    ].filter(Boolean).join('\n');
}

/** The page sizes CSS names itself (`size: A4 landscape`); any other is written in mm. */
const CSS_PAGE_SIZES = Object.freeze(['A3', 'A4', 'A5', 'Letter', 'Legal']);

/**
 * The continuous layout's print CSS (buildPageCss): one page, no page margin, the margin as the body
 * block's padding (repeated on every piece when a document too long for one page is split), no page
 * breaks anywhere, a cover as tall as its content and images limited by the longest page only.
 * @param {number} width  page width in mm
 * @param {number} height  the starting page height in mm
 * @param {string} margin  a validMargin value
 * @param {string|null} colour  a validPageBackground value
 */
function continuousPageCss(width, height, margin, colour) {
    const w = `${formatNumber(width)}mm`;
    return [
        `@page { size: ${w} ${formatNumber(height)}mm; margin: 0; }`,
        `:root { --bd-page-width: ${w}; --bd-page-height: auto; --bd-page-content-height: ${PAGE_LIMITS.maxSideMm}mm; }`,
        `.bd-page { display: flow-root; }`,
        `.bd-page:not(.bd-page-cover) { padding: ${margin}; box-decoration-break: clone; -webkit-box-decoration-break: clone;`
            + `${colour ? ` background: ${colour};` : ''} }`,
        `.bd-page-cover .cover-page { min-height: 0 !important; }`,
        `*, *::before, *::after { break-before: auto !important; break-after: auto !important; `
            + `page-break-before: auto !important; page-break-after: auto !important; }`,
        // A document split into tall pages still keeps each heading with what follows it.
        'h1, h2, h3, h4, h5, h6 { break-after: avoid !important; page-break-after: avoid !important; }',
    ].join('\n');
}

function escapeHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Longest run of characters inside a table cell that is printed without a break opportunity. */
export const CELL_TOKEN_MAX = 30;
const CELL_TOKEN_CHUNK = 15;
const TAG_RE = /<!--[\s\S]*?-->|<(\/?)([A-Za-z][\w:-]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*\/?>|[^<]+|</g;

/** One token with a <wbr> after every CELL_TOKEN_CHUNK visible characters (an entity counts as one). */
function breakToken(token) {
    const chars = token.match(/&(?:#\d+|#x[0-9a-f]+|[a-z][a-z0-9]*);|[\s\S]/gi) || [];
    if (chars.length <= CELL_TOKEN_MAX) return token;
    let out = '';
    chars.forEach((c, i) => {
        out += (i > 0 && i % CELL_TOKEN_CHUNK === 0 ? '<wbr>' : '') + c;
    });
    return out;
}

/**
 * Break opportunities (<wbr>) inside text tokens longer than CELL_TOKEN_MAX
 * characters in table cells, so a hash or URL in a cell wraps instead of
 * widening the table past the page. Cells keep overflow-wrap: break-word,
 * which, unlike "anywhere", never lets the browser squeeze a column below its
 * longest ordinary word. Words up to CELL_TOKEN_MAX characters, text outside
 * cells, <pre> blocks, tags and attributes are left as they are.
 * @param {string} html  sanitised HTML
 * @returns {string}
 */
export function breakLongCellTokens(html) {
    const src = String(html == null ? '' : html);
    let out = '';
    let cells = 0;
    let pre = 0;
    let m;
    TAG_RE.lastIndex = 0;
    while ((m = TAG_RE.exec(src)) !== null) {
        const [token, close, tagName] = m;
        if (tagName) {
            const tag = tagName.toLowerCase();
            const step = close ? -1 : 1;
            if (tag === 'td' || tag === 'th') cells = Math.max(0, cells + step);
            if (tag === 'pre') pre = Math.max(0, pre + step);
            out += token;
        } else if (cells > 0 && pre === 0 && token !== '<' && !token.startsWith('<!--')) {
            out += token.replace(/[^\s]+/g, breakToken);
        } else {
            out += token;
        }
    }
    return out;
}

const HREF_RE = /\shref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/i;
const ENTITY_RE = /&(?:amp|lt|gt|quot|#39|#x27);/g;
const ENTITIES = {'&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&#x27;': "'"};
/** An address as it reads: no scheme, no "www.", no trailing slash, lower case. */
const readable = (s) => s.replace(ENTITY_RE, (e) => ENTITIES[e]).trim().toLowerCase()
    .replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/+$/, '');

/**
 * Mark the external links whose address should print after their text
 * (`printLinks`): every <a href="http(s)://..."> gets data-bd-href, except one
 * whose text already is the address. Anchors (#...), mailto: and other schemes
 * are left alone. The print CSS adds the address with a::after.
 * @param {string} html  sanitised HTML
 * @returns {string}
 */
export function markPrintLinks(html) {
    const src = String(html == null ? '' : html);
    let out = '';
    let link = null;
    let m;
    TAG_RE.lastIndex = 0;
    while ((m = TAG_RE.exec(src)) !== null) {
        const [token, close, tagName] = m;
        const tag = tagName ? tagName.toLowerCase() : '';
        if (tag === 'a' && !close) {
            if (link) out += link.open + link.inner;
            const hm = HREF_RE.exec(m[3] || '');
            const href = hm ? (hm[1] ?? hm[2] ?? hm[3]) : '';
            link = /^https?:\/\//i.test(href.trim()) ? {open: token, inner: '', text: '', href} : null;
            if (!link) out += token;
        } else if (link && tag === 'a' && close) {
            const same = readable(link.text) === readable(link.href);
            out += (same ? link.open : link.open.replace(/^<a\b/i, '<a data-bd-href=""')) + link.inner + token;
            link = null;
        } else if (link) {
            link.inner += token;
            if (!tagName && !token.startsWith('<!--')) link.text += token;
        } else {
            out += token;
        }
    }
    return link ? out + link.open + link.inner : out;
}

/** The printed addresses of marked links (markPrintLinks): smaller, wrapped anywhere, never into the margin. */
const PRINT_LINKS_CSS = `
      a[data-bd-href]::after {
        content: " (" attr(href) ")";
        font-size: 0.8em;
        font-weight: 400;
        font-style: normal;
        overflow-wrap: anywhere;
        word-break: break-all;
      }`;

/** A template id as a class name: letters, digits, "-" and "_" only. */
function classSafe(id) {
    return String(id || '').replace(/[^a-z0-9_-]/gi, '');
}

/**
 * The full print document.
 * @param {object} p
 * @param {string} [p.title]        document title (escaped here)
 * @param {string} [p.templateId]   scopes the content: class "template-{id}"
 * @param {string} [p.templateCSS]  the template's styles
 * @param {string} [p.hljsCSS]      highlight.js theme, embedded so the PDF needs no fetch
 * @param {string} [p.fontCSS]      @font-face rules (default: the vendored brand fonts)
 * @param {string} [p.bodyHTML]     sanitised body HTML; long tokens in table cells get
 *                                  break opportunities (breakLongCellTokens)
 * @param {string} [p.coverHTML]    cover HTML, or '' for no cover page
 * @param {object} [p.pageOpts]     {pageSize, orientation, margin}, validated here again
 * @param {string} [p.lang]         document language for <html lang> (a BCP 47 tag, else "en"),
 *                                  which Chromium writes into the PDF
 * @param {string} [p.author]       <meta name="author"> (escaped here)
 * @param {string} [p.subject]      <meta name="description"> (escaped here)
 * @param {boolean} [p.printLinks]  print external link addresses after the link text
 * @param {string} [p.pageBackground]  the template's canvas colour for the body pages (validPageBackground)
 * @param {object|null} [p.running] the template's running head and foot (js/page-chrome.js normalizeRunning)
 * @param {string} [p.date]         the cover date, for the running head's {date}
 * @returns {string}
 */
export function buildPrintDocument({
    title = '',
    templateId = '',
    templateCSS = '',
    hljsCSS = '',
    fontCSS = fontFaceCSS(),
    bodyHTML = '',
    coverHTML = '',
    pageOpts = {},
    lang = DEFAULT_LANG,
    author = '',
    subject = '',
    printLinks = false,
    pageBackground = '',
    running = null,
    date = '',
} = {}) {
    const id = classSafe(templateId);
    const coverSection = coverHTML
        ? `<div class="template-${id}" style="max-width:none;width:100%;margin:0;padding:0;">${coverHTML}</div>`
        : '';
    const langTag = typeof lang === 'string' && LANG_RE.test(lang) ? lang : DEFAULT_LANG;
    const body = printLinks ? markPrintLinks(bodyHTML) : bodyHTML;
    const colour = validPageBackground(pageBackground);
    // The running head and foot (README, Template contract), and its font kept loaded.
    const values = {title, author, subject, date};
    const runningCss = buildRunningCss(running, values, {pageOpts, cover: Boolean(coverHTML)});
    const probe = runningCss ? runningFontProbe(running, values) : null;

    return `<!DOCTYPE html>
<html lang="${langTag}">
<head>
  <meta charset="UTF-8">
  <title>${escapeHtml(title)}</title>${author ? `
  <meta name="author" content="${escapeHtml(author)}">` : ''}${subject ? `
  <meta name="description" content="${escapeHtml(subject)}">` : ''}
  <style>
/* Brand fonts, served from vendor/fonts/ (js/fonts.js) */
${fontCSS}

/* highlight.js theme, embedded inline for offline / future-proof export */
${hljsCSS}

${templateCSS}

    /* ── Resets ── */
    *, *::before, *::after {
      box-sizing: border-box;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }
    html, body { margin: 0; padding: 0; }

    /* ── Screen: A4 page-card preview, matches .preview-page in app.css ── */
    @media screen {
      body {
        background: #b0b4b8;
        padding: 24px;
      }
      .bd-page {
        background: #fff;
        width: 794px;
        margin: 0 auto 20px;
        box-shadow: 0 2px 10px rgba(0,0,0,0.22);
        padding: 60px;
      }
      .bd-page-cover {
        padding: 0;
        overflow: hidden;
      }${colour ? `
      .bd-page:not(.bd-page-cover) { background: ${colour}; }` : ''}
    }

    /* ── Print ── */
    @media print {
      body { background: ${colour ? 'transparent' : '#fff'}; }
      .bd-page { box-shadow: none; padding: 0; width: auto; }

      ${buildPageCss(pageOpts, {cover: Boolean(coverHTML), background: colour})}${printLinks ? PRINT_LINKS_CSS : ''}${runningCss ? `
${runningCss}` : ''}
    }${probe ? `
    ${probe.css}` : ''}
  </style>
</head>
<body>
${coverSection ? `<div class="bd-page bd-page-cover">${coverSection}</div>` : ''}
<div class="bd-page">
  <div class="template-${id}">
${breakLongCellTokens(body)}
  </div>
</div>${probe ? `
<div class="bd-running-probe" aria-hidden="true">${escapeHtml(probe.text)}</div>` : ''}
</body>
</html>`;
}
