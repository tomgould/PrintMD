/**
 * epub-import.js
 *
 * Convert an .epub File to Markdown.
 * Strategy: unzip with JSZip → parse OPF spine → extract XHTML chapters
 * in order → clean → convert via turndown → stitch together.
 * JSZip and turndown are loaded from vendor/ (script tag injection).
 */

import {assertInflatedWithinLimit, assertZipWithinLimit, buildTurndown, escapeMetadataText, loadJSZip, loadTurndown, warn} from './import-utils.js';

/** Parse an XML/HTML string in the browser. */
function parseXml(str, mime = 'application/xhtml+xml') {
    return new DOMParser().parseFromString(str, mime);
}

/** True when DOMParser could not parse the XML (it returns a <parsererror> document). */
function isParseError(doc) {
    return !doc.documentElement || doc.getElementsByTagName('parsererror').length > 0;
}

const ZIP_ROOT = 'https://epub.invalid/';

/**
 * The zip path a manifest href points to. Hrefs are URLs relative to the OPF
 * file's folder, so they are resolved against it and percent-decoded
 * ("Chapter%20Two.xhtml" is the entry "Chapter Two.xhtml"). A fragment or
 * query is dropped. Returns null for an href that leaves the archive.
 * @param {string} opfDir  folder of the OPF file inside the zip ('' at the root)
 * @param {string} href
 */
export function resolveHref(opfDir, href) {
    let url;
    try {
        url = new URL(href, ZIP_ROOT + (opfDir ? opfDir.replace(/\/?$/, '/') : ''));
    } catch {
        return null;
    }
    if (url.origin !== new URL(ZIP_ROOT).origin) return null;
    const path = url.pathname.slice(1);
    try {
        return decodeURIComponent(path);
    } catch {
        return path;   // malformed escape: use it as written
    }
}

/** Extract metadata (title, author) from OPF document. */
function parseOpfMeta(opfDoc) {
    const get = (sel) => opfDoc.querySelector(sel)?.textContent?.trim() || '';
    return {
        title: get('metadata > title, metadata > dc\\:title, dc\\:title'),
        author: get('metadata > creator, metadata > dc\\:creator, dc\\:creator'),
    };
}

/** Get ordered spine paths (inside the zip) from the OPF document. */
function parseSpine(opfDoc, opfDir) {
    const manifest = {};
    for (const item of opfDoc.querySelectorAll('manifest > item')) {
        manifest[item.getAttribute('id')] = item.getAttribute('href');
    }
    const paths = [];
    for (const itemref of opfDoc.querySelectorAll('spine > itemref')) {
        const href = manifest[itemref.getAttribute('idref')];
        const path = href && resolveHref(opfDir, href);
        if (path) paths.push(path);
    }
    return paths;
}

const REMOVE_EPUB = 'nav, [epub\\:type="toc"], [epub\\:type="nav"], script, style';

/**
 * Convert an .epub File to a Markdown string.
 *
 * @param {File}     file
 * @param {Function} [onProgress]  callback(0–100)
 * @param {{onWarning?: Function, maxUncompressedBytes?: number}} [opts]
 * @returns {Promise<string>}
 */
export async function epubToMarkdown(file, onProgress, opts = {}) {
    if (onProgress) onProgress(5);
    const [JSZip] = await Promise.all([loadJSZip(), loadTurndown()]);
    if (onProgress) onProgress(15);

    const buffer = await file.arrayBuffer();
    assertZipWithinLimit(buffer, {kind: 'EPUB', maxBytes: opts.maxUncompressedBytes});
    const zip = await JSZip.loadAsync(buffer);
    // The directory's sizes can lie: count what inflating really produces first.
    await assertInflatedWithinLimit(zip, {kind: 'EPUB', maxBytes: opts.maxUncompressedBytes});
    if (onProgress) onProgress(25);

    // Find container.xml → OPF path
    const containerXml = await zip.file('META-INF/container.xml')?.async('string');
    if (!containerXml) throw new Error('Not a valid EPUB: META-INF/container.xml not found');

    const containerDoc = parseXml(containerXml, 'text/xml');
    const opfPath = !isParseError(containerDoc) && containerDoc.querySelector('rootfile')?.getAttribute('full-path');
    if (!opfPath) throw new Error('EPUB container.xml has no rootfile');

    const opfXml = await zip.file(opfPath)?.async('string');
    if (!opfXml) throw new Error(`EPUB OPF not found at: ${opfPath}`);

    const opfDoc = parseXml(opfXml, 'text/xml');
    if (isParseError(opfDoc)) throw new Error('Not a valid EPUB: its package file (OPF) is not well-formed XML');
    const opfDir = opfPath.includes('/') ? opfPath.split('/').slice(0, -1).join('/') : '';
    const meta = parseOpfMeta(opfDoc);
    const spine = parseSpine(opfDoc, opfDir);

    if (onProgress) onProgress(35);

    const td = buildTurndown(opts);
    const chapterMds = [];
    const missing = [];
    const broken = [];

    for (let i = 0; i < spine.length; i++) {
        const path = spine[i];
        const chapterXml = await zip.file(path)?.async('string');
        if (chapterXml == null) {
            missing.push(path);
            continue;
        }

        const doc = parseXml(chapterXml, 'application/xhtml+xml');
        if (isParseError(doc)) {
            broken.push(path);
            continue;
        }
        doc.querySelectorAll(REMOVE_EPUB).forEach(el => el.remove());

        const body = doc.querySelector('body') || doc.documentElement;
        const md = td.turndown(body.innerHTML || '').replace(/\n{3,}/g, '\n\n').trim();
        if (md) chapterMds.push(md);

        if (onProgress) onProgress(35 + Math.round((i / spine.length) * 55));
    }

    if (broken.length) {
        warn(opts, `Skipped ${broken.length} chapter${broken.length === 1 ? '' : 's'} that ${broken.length === 1 ? 'is' : 'are'} not well-formed XHTML: ${broken.join(', ')}`);
    }
    if (missing.length) {
        warn(opts, `${missing.length} chapter${missing.length === 1 ? ' is' : 's are'} listed in the EPUB but missing from it: ${missing.join(', ')}`);
    }

    // Prepend front matter from metadata
    let result = chapterMds.join('\n\n---\n\n');

    if (meta.title && !/^# /m.test(result)) {
        result = `# ${escapeMetadataText(meta.title)}\n\n${result}`;
    }
    if (meta.author) {
        // A callback, so "$&" or "$1" in an author name is not a replacement pattern.
        const authorLine = `*by ${escapeMetadataText(meta.author)}*`;
        result = result.replace(/^(# [^\n]+)/, (heading) => `${heading}\n\n${authorLine}`);
    }

    result = result.replace(/\n{3,}/g, '\n\n').trim();
    if (onProgress) onProgress(100);
    return result;
}
