/**
 * import-utils.js
 * Shared helpers for the importers (Word, HTML, EPUB, PDF) that keep imported
 * content from turning into live Markdown/HTML.
 *
 * Imported files are untrusted. Text such as "<img src=x onerror=...>" must stay
 * text in the generated Markdown, code must not be able to close its fence, and
 * link URLs must not be able to close the link. The preview sanitises the
 * rendered HTML as well; these helpers make the Markdown itself safe to keep.
 */

const SAFE_AUTOLINK = /^<(?:https?|mailto|tel):[^\s<>\u0000-\u001f]*>/i;

/**
 * Text Turndown must not Markdown-escape: an http(s)/mailto/tel autolink, or a bare
 * URL up to the first character that could start Markdown or HTML syntax
 * (whitespace, `<`, `>`, `[`, `]`, backslash, backtick).
 */
const URL_SPAN = /<(?:https?|mailto|tel):[^\s<>\u0000-\u001f]*>|(?:https?:\/\/|www\.)[^\s<>[\]\\`]+/gi;

/**
 * Replace each `<` that could start HTML in Markdown: one before a letter, `/`,
 * `!` or `?`, or at the end of the text (a later text run may continue it).
 * Other `<` (as in `1 < 2` or a URL's `a=1<2`) and http(s)/mailto/tel autolinks
 * such as `<https://example.com>` are left as they are.
 */
function escapeHtmlStarts(text, replacement) {
    return String(text == null ? '' : text).replace(/<(?=[A-Za-z/!?]|$)/g,
        (lt, offset, str) => (SAFE_AUTOLINK.test(str.slice(offset)) ? lt : replacement));
}

/** Escape `<` where it could open HTML, as `&lt;` (renders as `<`). */
export function escapeHtmlText(text) {
    return escapeHtmlStarts(text, '&lt;');
}

/** A backtick fence one longer than the longest backtick run in `code` (min 3). */
export function codeFence(code) {
    const runs = String(code).match(/`+/g) || [];
    const longest = runs.reduce((n, r) => Math.max(n, r.length), 0);
    return '`'.repeat(Math.max(3, longest + 1));
}

/** A fenced code block that `code` cannot break out of. */
export function fencedBlock(code, lang = '') {
    const fence = codeFence(code);
    return `${fence}${lang}\n${code}\n${fence}`;
}

/** An inline code span that `code` cannot break out of. */
export function codeSpan(code) {
    const runs = String(code).match(/`+/g) || [];
    const ticks = '`'.repeat(runs.reduce((n, r) => Math.max(n, r.length), 0) + 1);
    const pad = /^`|`$/.test(code) ? ' ' : '';
    return `${ticks}${pad}${code}${pad}${ticks}`;
}

/** The language named by a `language-x` / `lang-x` class, if it is a plain name; else ''. */
export function codeLanguage(className) {
    const m = /(?:^|\s)lang(?:uage)?-(\S+)/.exec(className || '');
    return m && /^[\w+-]+$/.test(m[1]) ? m[1] : '';
}

/**
 * A link URL that is safe to emit: http(s), mailto or tel only, trimmed, with the
 * characters that could end a `<url>` destination percent-encoded. Else null.
 */
export function safeLinkUrl(url) {
    if (typeof url !== 'string') return null;
    const trimmed = url.trim();
    let parsed;
    try {
        parsed = new URL(trimmed);
    } catch {
        return null;   // relative or malformed
    }
    if (!['http:', 'https:', 'mailto:', 'tel:'].includes(parsed.protocol)) return null;
    return trimmed.replace(/[<>\\\s]/g, c => encodeURIComponent(c));
}

/**
 * True for an imported link target that may stay a link: http(s), mailto, tel, or a
 * relative URL / #anchor (no scheme). Whitespace and control characters are
 * ignored when looking for a scheme, as browsers do ("java\tscript:").
 */
export function isAllowedImportHref(href) {
    if (typeof href !== 'string') return false;
    const compact = href.replace(/[\u0000-\u0020\u007f]/g, '');
    const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(compact);
    return !scheme || ['http', 'https', 'mailto', 'tel'].includes(scheme[1].toLowerCase());
}

/**
 * A run of plain text (from a PDF) for Markdown prose: `[`, `]`, backslash,
 * backtick and `|` are backslash-escaped, so the text cannot open an image,
 * link, code span or table cell; `<` that could start HTML becomes `&lt;`, and
 * an `&` that would start an entity is escaped. Parentheses, `*` and `_` are
 * left alone, so "(like this)", "2 * 3" and "my_file.pdf" read as written.
 * The result renders exactly as the input.
 */
export function escapeTextRun(text) {
    return escapeHtmlText(String(text == null ? '' : text)
        .replace(/[\\`[\]|]/g, '\\$&')
        .replace(/&(?=#?[A-Za-z0-9]+;)/g, '\\&'));
}

/**
 * Escape what would make the start of a paragraph or list item into block
 * syntax: a heading `#`, a quote `>`, a bullet `-` `+` `*`, a numbered item
 * `1.` or `1)`, a thematic break `---`, a fence `~~~`, or `=` (a setext line).
 */
export function escapeBlockStart(line) {
    const s = String(line == null ? '' : line);
    if (/^\d{1,9}[.)](?:\s|$)/.test(s)) return s.replace(/^(\d{1,9})([.)])/, '$1\\$2');
    if (/^(?:#{1,6}(?:\s|$)|>|[-+*](?:\s|$)|(?:[-*_]\s*){3,}$|~{3}|=)/.test(s)) return '\\' + s;
    return s;
}

/**
 * Document metadata (an HTML <title>, an EPUB title or author) as one line of
 * plain Markdown text: whitespace collapsed, every character that could start
 * emphasis, a link, an image, a table cell or block syntax backslash-escaped,
 * `<` as `&lt;`, an `&` that would start an entity escaped, and URLs broken
 * (`https\://`, `www\.`) so they cannot autolink. It renders exactly as the
 * original text.
 */
export function escapeMetadataText(text) {
    return String(text == null ? '' : text).replace(/\s+/g, ' ').trim()
        .replace(/[\\`*_[\]#+\-!|~>:]/g, '\\$&')
        .replace(/&(?=#?[A-Za-z0-9]+;)/g, '\\&')
        .replace(/\bwww\./gi, (m) => m.slice(0, 3) + '\\.')
        .replace(/</g, '&lt;');
}

/** Link text that cannot close the link or open an HTML tag. */
export function escapeLinkText(text) {
    return escapeHtmlText(String(text).replace(/([\\[\]])/g, '\\$1'));
}

/** `[text](<url>)` for a safe URL, or just the text when the URL is not allowed. */
export function markdownLink(text, url) {
    const safe = safeLinkUrl(url);
    if (!safe) return String(text);
    return `[${escapeLinkText(text)}](<${safe}>)`;
}

// ── Array helpers ────────────────────────────────────────────────────────────

/**
 * Largest / smallest `fn(item)` over an array, in a loop. Math.max(...arr)
 * passes every item as an argument and overflows the stack on large data.
 */
export function maxOf(arr, fn = (x) => x) {
    let m = -Infinity;
    for (const item of arr) {
        const v = fn(item);
        if (v > m) m = v;
    }
    return m;
}

export function minOf(arr, fn = (x) => x) {
    let m = Infinity;
    for (const item of arr) {
        const v = fn(item);
        if (v < m) m = v;
    }
    return m;
}

// ── Warnings ─────────────────────────────────────────────────────────────────

/**
 * Every converter takes `(input, onProgress, opts)`. `opts.onWarning(message)`
 * receives plain-text warnings (skipped chapters, dropped images, converter
 * messages); js/imports.js collects them and the app shows them in one toast.
 */
export function warn(opts, message) {
    if (opts && typeof opts.onWarning === 'function') opts.onWarning(String(message));
}

// ── Script loading ───────────────────────────────────────────────────────────

const scriptLoads = new Map();

/**
 * Load a classic script once and resolve when `isReady()` is true.
 * The global is checked by shape, never by presence alone: an element in a
 * rendered document with id="TurndownService" or id="google" is reachable as
 * window.TurndownService / window.google until the real script assigns it.
 * A failed load removes its <script> tag and its cache entry, so a retry
 * requests the file again.
 * @param {string} src
 * @param {() => boolean} isReady  true once the library's global is usable
 */
export function loadScript(src, isReady) {
    if (isReady()) return Promise.resolve();
    if (!scriptLoads.has(src)) {
        scriptLoads.set(src, new Promise((resolve, reject) => {
            const s = document.createElement('script');
            s.src = src;
            const fail = (err) => {
                s.remove();
                reject(err);
            };
            s.onload = () => (isReady() ? resolve()
                : fail(new Error(`Loaded ${src} but its library is not available`)));
            s.onerror = () => fail(new Error(`Failed to load script: ${src}`));
            document.head.appendChild(s);
        }).catch((err) => {
            scriptLoads.delete(src);   // allow a retry
            throw err;
        }));
    }
    return scriptLoads.get(src);
}

const vendorUrl = (path) => new URL(`../vendor/${path}`, import.meta.url).href;

/** Turndown (window.TurndownService) from vendor/. */
export async function loadTurndown() {
    await loadScript(vendorUrl('turndown/turndown.js'), () => typeof window.TurndownService === 'function');
    return window.TurndownService;
}

/** JSZip (window.JSZip) from vendor/. */
export async function loadJSZip() {
    await loadScript(vendorUrl('jszip/jszip.min.js'), () => typeof window.JSZip?.loadAsync === 'function');
    return window.JSZip;
}

const appUrl = (path) => new URL(`./${path}`, import.meta.url).href;
const NATIVE_BUILTINS = Symbol.for('printmd.native-builtins');
let pptxGenLoad = null;

/**
 * PptxGenJS (window.PptxGenJS) and the JSZip it writes with, loaded on the
 * first PowerPoint export instead of at startup (together about half a megabyte
 * of script). The bundle's core-js replaces trim and parseInt with quadratic
 * versions, so it loads between js/builtins-save.js and js/builtins-restore.js,
 * in that order, exactly as index.html used to load them.
 */
export function loadPptxGen() {
    // Ready only once the browser's own built-ins are back: a load whose restore
    // step failed leaves PptxGenJS defined and core-js's trim in place.
    const ready = typeof window.PptxGenJS === 'function' && typeof window.JSZip?.loadAsync === 'function'
        && !(NATIVE_BUILTINS in window);
    if (ready) return Promise.resolve(window.PptxGenJS);
    if (!pptxGenLoad) {
        pptxGenLoad = (async () => {
            await loadJSZip();
            if (typeof window.PptxGenJS !== 'function') {
                await loadScript(appUrl('builtins-save.js'), () => Array.isArray(window[NATIVE_BUILTINS]));
                await loadScript(vendorUrl('pptxgenjs/pptxgen.bundle.js'), () => typeof window.PptxGenJS === 'function');
            }
            await loadScript(appUrl('builtins-restore.js'), () => !(NATIVE_BUILTINS in window));
            return window.PptxGenJS;
        })().catch((err) => {
            pptxGenLoad = null;   // allow a retry
            throw err;
        });
    }
    return pptxGenLoad;
}

/** mammoth.js (window.mammoth) from vendor/. */
export async function loadMammoth() {
    await loadScript(vendorUrl('mammoth/mammoth.browser.min.js'), () => typeof window.mammoth?.convertToHtml === 'function');
    return window.mammoth;
}

// ── Zip size guard ───────────────────────────────────────────────────────────

/** Imports refuse a .docx or .epub whose files would expand past this. */
export const MAX_ZIP_UNCOMPRESSED_BYTES = 200 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 20000;

/**
 * Entry count and total uncompressed size declared by a zip's central
 * directory, read without inflating anything (ZIP64 sizes included).
 * Throws when the bytes are not a zip archive.
 * @param {ArrayBuffer|Uint8Array} buffer
 * @returns {{entries: number, total: number}}
 */
export function zipDeclaredSize(buffer) {
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const len = bytes.length;
    const notZip = () => new Error('not a zip archive');

    // End of central directory record: 22 bytes plus a comment of up to 64 KB.
    let eocd = -1;
    for (let i = len - 22; i >= 0 && i >= len - 22 - 0xffff; i--) {
        if (view.getUint32(i, true) === 0x06054b50) {
            eocd = i;
            break;
        }
    }
    if (eocd < 0) throw notZip();
    let declaredEntries = view.getUint16(eocd + 10, true);
    let cdOffset = view.getUint32(eocd + 16, true);
    if (view.getUint32(eocd + 12, true) === 0xffffffff || cdOffset === 0xffffffff || declaredEntries === 0xffff) {
        const locator = eocd - 20;
        if (locator < 0 || view.getUint32(locator, true) !== 0x07064b50) throw notZip();
        const z64 = Number(view.getBigUint64(locator + 8, true));
        if (z64 + 56 > len || view.getUint32(z64, true) !== 0x06064b50) throw notZip();
        declaredEntries = Number(view.getBigUint64(z64 + 32, true));
        cdOffset = Number(view.getBigUint64(z64 + 48, true));
    }

    // Walk every central-directory record by its signature. The directory's size
    // field is not trusted: a zip can understate it to hide entries from a reader
    // that stops there, while JSZip reads them all.
    let p = cdOffset;
    let entries = 0;
    let total = 0;
    while (p + 46 <= len && view.getUint32(p, true) === 0x02014b50) {
        let size = view.getUint32(p + 24, true);
        const nameLen = view.getUint16(p + 28, true);
        const extraLen = view.getUint16(p + 30, true);
        const commentLen = view.getUint16(p + 32, true);
        if (size === 0xffffffff) {
            // The real size is in the ZIP64 extra field (id 0x0001); unreadable counts as too big.
            size = Infinity;
            let e = p + 46 + nameLen;
            const extraEnd = Math.min(len, e + extraLen);
            while (e + 4 <= extraEnd) {
                const id = view.getUint16(e, true);
                const fieldLen = view.getUint16(e + 2, true);
                if (id === 1 && fieldLen >= 8 && e + 12 <= extraEnd) {
                    size = Number(view.getBigUint64(e + 4, true));
                    break;
                }
                e += 4 + fieldLen;
            }
        }
        total += size;
        entries++;
        p += 46 + nameLen + extraLen + commentLen;
    }
    if (!entries || entries !== declaredEntries) throw notZip();
    return {entries, total};
}

/**
 * Refuse a zip-based file (.docx, .epub) before inflating it: not a zip, too
 * many entries, or more than `maxBytes` once expanded (a zip bomb). Sizes come
 * from the central directory, so this costs nothing for a normal file.
 * @param {ArrayBuffer|Uint8Array} buffer
 * @param {{kind: string, maxBytes?: number}} opts  kind names the format in messages ("Word", "EPUB")
 */
export function assertZipWithinLimit(buffer, {kind, maxBytes = MAX_ZIP_UNCOMPRESSED_BYTES}) {
    let info;
    try {
        info = zipDeclaredSize(buffer);
    } catch {
        throw new Error(`This is not a valid ${kind} file: it is not a zip archive.`);
    }
    const mb = (n) => (n / 1048576).toFixed(n < 10485760 ? 1 : 0);
    if (info.entries > MAX_ZIP_ENTRIES) {
        throw new Error(`This ${kind} file has ${info.entries} parts, more than the ${MAX_ZIP_ENTRIES} the importer accepts.`);
    }
    if (info.total > maxBytes) {
        const size = Number.isFinite(info.total) ? `${mb(info.total)} MB` : 'more than 4 GB';
        throw new Error(`This ${kind} file would expand to ${size}, over the ${mb(maxBytes)} MB import limit.`);
    }
    return info;
}

/**
 * Inflate every entry of a loaded JSZip archive, counting the bytes actually
 * produced and throwing as soon as the running total passes `maxBytes`. The
 * sizes in a zip's directory are only claims; this is the check that holds.
 * Output is discarded chunk by chunk, so memory stays small however big the
 * archive claims or turns out to be. Run it before anything parses the
 * archive (mammoth opens the zip itself). Nested archives are never opened.
 * @param {object} zip  a JSZip instance from JSZip.loadAsync
 * @param {{kind: string, maxBytes?: number}} opts
 * @returns {Promise<number>}  total inflated bytes
 */
export async function assertInflatedWithinLimit(zip, {kind, maxBytes = MAX_ZIP_UNCOMPRESSED_BYTES}) {
    const entries = Object.values(zip.files).filter(f => !f.dir);
    if (entries.length > MAX_ZIP_ENTRIES) {
        throw new Error(`This ${kind} file has ${entries.length} parts, more than the ${MAX_ZIP_ENTRIES} the importer accepts.`);
    }
    let total = 0;
    for (const entry of entries) {
        await new Promise((resolve, reject) => {
            const stream = entry.internalStream('uint8array');
            let stopped = false;
            stream.on('data', (chunk) => {
                if (stopped) return;
                total += chunk.length;
                if (total > maxBytes) {
                    stopped = true;
                    stream.pause();
                    const err = new Error(`This ${kind} file expands to more than ${(maxBytes / 1048576).toFixed(0)} MB, ` +
                        'over the import limit (its zip directory lists smaller sizes).');
                    err.inflatedBytes = total;
                    reject(err);
                }
            }).on('error', (e) => {
                if (!stopped) reject(e);
            }).on('end', () => {
                if (!stopped) resolve();
            }).resume();
        });
    }
    return total;
}

// ── Turndown ─────────────────────────────────────────────────────────────────

const SAFE_DATA_IMAGE = /^data:image\/(?:png|jpeg|gif|webp|bmp|svg\+xml);base64,[A-Za-z0-9+/]+=*$/;

/**
 * An image source that may stay in imported Markdown: a base64 data URI of a
 * browser image type, an http(s) URL or a relative path. Characters that could
 * end the destination are percent-encoded. Anything else gives null.
 */
export function safeImageSrc(src) {
    const s = String(src || '').trim();
    if (!s) return null;
    if (/^data:/i.test(s)) return SAFE_DATA_IMAGE.test(s) ? s : null;
    const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(s.replace(/[\u0000- \u007f]/g, ''));
    if (scheme && !['http', 'https'].includes(scheme[1].toLowerCase())) return null;
    return s.replace(/[\s()<>\\]/g, c => encodeURIComponent(c));
}

/** Imported tables keep at most this many rows (header included), so a huge sheet cannot freeze the tab. */
export const MAX_TABLE_ROWS = 5000;

const count = (n) => n.toLocaleString('en-GB');

/** The warning for tables cut to MAX_TABLE_ROWS. `sizes` are the original row counts. */
export function tableLimitWarning(sizes) {
    const largest = maxOf(sizes);
    return sizes.length === 1
        ? `A table with ${count(largest)} rows was cut to its first ${count(MAX_TABLE_ROWS)} rows.`
        : `${sizes.length} tables were cut to their first ${count(MAX_TABLE_ROWS)} rows (the largest had ${count(largest)} rows).`;
}

/**
 * Cut every table under `root` to MAX_TABLE_ROWS rows, in place, and warn once.
 * Done before Turndown walks the tree, so conversion time follows the rows kept.
 */
function limitTableRows(root, opts) {
    const sizes = [];
    for (const table of root.querySelectorAll('table')) {
        const rows = tableRows(table);
        if (rows.length <= MAX_TABLE_ROWS) continue;
        sizes.push(rows.length);
        for (let i = rows.length - 1; i >= MAX_TABLE_ROWS; i--) rows[i].remove();
    }
    if (sizes.length) warn(opts, tableLimitWarning(sizes));
}

/** A table's rows in order (thead, tbody, tfoot), not counting nested tables. */
function tableRows(table) {
    if (table.rows) return Array.from(table.rows);
    const rows = [];
    for (const child of table.children) {
        if (child.nodeName.toUpperCase() === 'TR') rows.push(child);
        else if (/^(THEAD|TBODY|TFOOT)$/i.test(child.nodeName)) {
            for (const tr of child.children) if (tr.nodeName.toUpperCase() === 'TR') rows.push(tr);
        }
    }
    return rows;
}

/**
 * The importers' shared Turndown setup (needs window.TurndownService loaded).
 * Text is escaped so `<` cannot become raw HTML, <pre> becomes a fenced block
 * with a fence the code cannot close and a plain language name, tables become
 * GFM tables (at most MAX_TABLE_ROWS rows each, with a warning through
 * opts.onWarning when one is cut), and only safe link and image targets are kept.
 * @param {{onWarning?: Function}} [opts]
 */
export function buildTurndown(opts = {}) {
    const TurndownService = window.TurndownService;
    const td = new TurndownService({
        headingStyle: 'atx',
        codeBlockStyle: 'fenced',
        bulletListMarker: '-',
        emDelimiter: '*',
        strongDelimiter: '**',
        hr: '---',
    });

    // `&lt;`, not `\<`: right after a bare URL, GFM autolinking swallows the
    // backslash into the link and the `<` would open a live tag.
    const escape = TurndownService.prototype.escape;
    const escapeText = (text) => escapeHtmlText(escape.call(td, text));
    // URLs are copied as written: an autolink (`<https://...>`) or a bare URL is
    // read without Markdown escapes, so `\_` would end up in the href as `%5C_`.
    td.escape = (text) => {
        let out = '';
        let last = 0;
        for (const m of text.matchAll(URL_SPAN)) {
            out += escapeText(text.slice(last, m.index)) + m[0];
            last = m.index + m[0].length;
        }
        return out + escapeText(text.slice(last));
    };

    // Links with any other scheme (javascript:, data:, file:...) keep only their text.
    td.addRule('unsafeLink', {
        filter: (node) => node.nodeName === 'A' && node.hasAttribute('href') && !isAllowedImportHref(node.getAttribute('href')),
        replacement: (content) => content,
    });

    td.addRule('fencedCode', {
        filter: ['pre'],
        replacement(_content, node) {
            const code = node.querySelector('code');
            const lang = codeLanguage((code || node).getAttribute('class'));
            const text = (code || node).textContent.trim();
            return '\n\n' + fencedBlock(text, lang) + '\n\n';
        },
    });

    // Images keep only safe sources; the alt text cannot close the image syntax.
    td.addRule('safeImage', {
        filter: 'img',
        replacement(_content, node) {
            const alt = (node.getAttribute('alt') || '').replace(/\s+/g, ' ').trim();
            const src = safeImageSrc(node.getAttribute('src'));
            if (!src) return alt ? escapeLinkText(alt) : '';
            return `![${escapeLinkText(alt)}](${src})`;
        },
    });

    // GFM table. Each cell is converted with the same rules (bold, italic, code,
    // links survive), then flattened to one line with its pipes escaped. The
    // first row is the header; short rows are padded to the widest row.
    const convert = td.turndown.bind(td);
    const cellMarkdown = (cell) => convert(cell).replace(/\s+/g, ' ').trim().replace(/\|/g, '\\|');
    td.addRule('table', {
        filter: 'table',
        replacement(_content, node) {
            const rows = tableRows(node)
                .map(tr => Array.from(tr.children).filter(c => /^T[HD]$/i.test(c.nodeName)).map(cellMarkdown));
            const width = Math.max(0, maxOf(rows, r => r.length));
            if (!width) return '';
            const line = (r) => '| ' + r.concat(Array(width - r.length).fill('')).join(' | ') + ' |';
            const out = [line(rows[0]), line(Array(width).fill('---'))];
            for (let i = 1; i < rows.length; i++) out.push(line(rows[i]));
            return '\n\n' + out.join('\n') + '\n\n';
        },
    });

    // Tables are cut to MAX_TABLE_ROWS before Turndown walks them (it converts
    // every node it is given, so a cut afterwards would come too late).
    td.turndown = (input) => {
        let root = input;
        if (typeof input === 'string') {
            root = new DOMParser().parseFromString(input, 'text/html').body;
        }
        if (root && typeof root.querySelectorAll === 'function') limitTableRows(root, opts);
        return convert(root);
    };

    return td;
}
