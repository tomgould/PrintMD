/**
 * html-import.js
 *
 * Convert an HTML File (or HTML string) to Markdown using turndown.
 * Picks the main content, drops navigation, scripts, ads and form controls,
 * then converts. turndown is loaded lazily from vendor/ on first use.
 */

import {buildTurndown, escapeMetadataText, loadTurndown} from './import-utils.js';

/** Never content, wherever they are. */
const REMOVE_ALWAYS = [
    'script', 'style', 'noscript', 'iframe', 'object', 'embed', 'template',
    'nav', 'footer', '[role="navigation"]', '[role="contentinfo"]',
    '.nav', '.navbar', '.footer', '.menu',
    '.cookie-banner', '.ad', '.ads', '.advertisement',
    'button', 'input', 'select', 'textarea',
].join(', ');

/**
 * Page chrome when it sits outside the main content. Inside an <article> a
 * <header> usually holds the title and an <aside> a pull quote, so they stay.
 */
const REMOVE_OUTSIDE_MAIN = [
    'header', 'aside', '[role="banner"]', '[role="complementary"]', '.header', '.sidebar',
].join(', ');

/** Main content candidates, best first. Several top-level <article>s are taken together. */
const MAIN_SELECTORS = ['main', '[role="main"]', 'article', '.content', '.post', '.entry', '#content', '#main'];

/**
 * The elements that hold the page's content: the first match of the best
 * selector, every top-level <article> when there are several, or [body].
 */
function findMain(doc) {
    for (const sel of MAIN_SELECTORS) {
        const found = [...doc.querySelectorAll(sel)];
        if (!found.length) continue;
        if (sel === 'article') return found.filter(a => !a.parentElement.closest('article'));
        return [found[0]];
    }
    return [doc.body || doc.documentElement];
}

/** Replace each element with its children (ASP.NET wraps the whole page in one <form>). */
function unwrap(doc, selector) {
    for (const el of [...doc.querySelectorAll(selector)]) el.replaceWith(...el.childNodes);
}

/**
 * Strip boilerplate and return the content root: a <div> holding the main
 * element(s) in document order.
 */
function cleanDocument(doc) {
    unwrap(doc, 'form');
    const mains = findMain(doc);
    const isBody = (m) => m === doc.body || m === doc.documentElement;
    // With no main element (the body is used), page headers and sidebars are all chrome.
    const insideMain = (el) => mains.some(m => !isBody(m) && (m.contains(el) || el.contains(m)));
    doc.querySelectorAll(REMOVE_OUTSIDE_MAIN).forEach(el => {
        if (!insideMain(el)) el.remove();
    });
    doc.querySelectorAll(REMOVE_ALWAYS).forEach(el => el.remove());
    const root = doc.createElement('div');
    for (const m of mains) {
        if (isBody(m)) root.append(...m.childNodes);
        else root.appendChild(m);
    }
    return root;
}

/**
 * Extract a title from the document.
 */
function extractTitle(doc) {
    const h1 = doc.querySelector('h1');
    if (h1?.textContent?.trim()) return h1.textContent.trim();
    const title = doc.querySelector('title');
    if (title?.textContent?.trim()) return title.textContent.trim();
    return null;
}

/** The charset an HTML file declares in a <meta> within its first 1024 bytes, or null. */
function declaredCharset(bytes) {
    const head = new TextDecoder('windows-1252').decode(bytes.subarray(0, 1024));
    const meta = /<meta\s[^>]*?charset\s*=\s*["']?\s*([A-Za-z0-9._:-]+)/i.exec(head);
    return meta ? meta[1] : null;
}

/**
 * Decode an HTML file's bytes: a byte order mark wins, then the charset named
 * by <meta charset> or <meta http-equiv="Content-Type">, then UTF-8. An
 * unknown label falls back to UTF-8.
 * @param {ArrayBuffer|Uint8Array} buffer
 * @returns {string}
 */
export function decodeHtmlBytes(buffer) {
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    let label = 'utf-8';
    if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) label = 'utf-8';
    else if (bytes[0] === 0xff && bytes[1] === 0xfe) label = 'utf-16le';
    else if (bytes[0] === 0xfe && bytes[1] === 0xff) label = 'utf-16be';
    else label = declaredCharset(bytes) || 'utf-8';
    let decoder;
    try {
        decoder = new TextDecoder(label);
    } catch {
        decoder = new TextDecoder('utf-8');
    }
    // The meta was found by reading the bytes as ASCII, so a UTF-16 label there
    // (utf-16, unicode, ucs-2, csunicode, unicodefffe, ...) without a BOM is
    // wrong: the HTML spec reads such a page as UTF-8, and x-user-defined as
    // windows-1252. Judged by the encoding the label resolves to, not its spelling.
    const hasUtf16Bom = (bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff);
    if (/^utf-16/.test(decoder.encoding) && !hasUtf16Bom) decoder = new TextDecoder('utf-8');
    else if (decoder.encoding === 'x-user-defined') decoder = new TextDecoder('windows-1252');
    return decoder.decode(bytes);   // TextDecoder drops a matching BOM
}

/**
 * Convert an HTML string or File to Markdown.
 *
 * @param {File|Blob|string} input  HTML file or raw HTML string
 * @param {Function} [onProgress]   callback(0–100)
 * @returns {Promise<string>}
 */
export async function htmlToMarkdown(input, onProgress, opts = {}) {
    if (onProgress) onProgress(5);
    await loadTurndown();

    const htmlString = input instanceof Blob ? decodeHtmlBytes(await input.arrayBuffer()) : String(input);
    if (onProgress) onProgress(30);

    const parser = new DOMParser();
    const doc = parser.parseFromString(htmlString, 'text/html');
    const title = extractTitle(doc);
    const root = cleanDocument(doc);
    if (onProgress) onProgress(55);

    const td = buildTurndown(opts);
    let md = td.turndown(root);

    // Guarantee H1 from page title if none in content. The title is plain text
    // (a page or Google Doc name), so it cannot add an image, link or HTML.
    if (!/^# /m.test(md) && title) {
        md = `# ${escapeMetadataText(title)}\n\n${md}`;
    } else if (!/^# /m.test(md)) {
        md = md.replace(/^## ([^\n]+)/m, '# $1');
    }

    md = md.replace(/\n{3,}/g, '\n\n').trim();
    if (onProgress) onProgress(100);
    return md;
}
