/**
 * docx-import.js
 *
 * Convert a .docx File to Markdown using mammoth.js → turndown.
 * Libraries are loaded lazily from vendor/ on first use (script tag injection).
 */

import {assertInflatedWithinLimit, assertZipWithinLimit, buildTurndown, loadJSZip, loadMammoth, loadTurndown, warn} from './import-utils.js';

/** Images up to this size (decoded) are kept inline as data URIs. */
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

/** Image types a browser can show; others (EMF, WMF, TIFF) become placeholders. */
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp', 'image/svg+xml']);

const STYLE_MAP = [
    "p[style-name='Code']      => pre > code",
    "p[style-name='Preformatted Text'] => pre > code",
    "p[style-name='Code Block'] => pre > code",
    "p[style-name='Source Code'] => pre > code",
];

/** "820 KB", "2.4 MB". */
function formatSize(bytes) {
    return bytes < 1048576 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1048576).toFixed(1)} MB`;
}

/** "a, b, c and 2 more" from distinct messages. */
function summarise(messages, max = 3) {
    const unique = [...new Set(messages)];
    const shown = unique.slice(0, max).join('; ');
    return unique.length > max ? `${shown}; and ${unique.length - max} more` : shown;
}

/**
 * Convert a .docx File to a Markdown string.
 *
 * @param {File}     file
 * @param {Function} [onProgress]  callback(0–100)
 * @param {{onWarning?: Function, maxImageBytes?: number, maxUncompressedBytes?: number}} [opts]
 * @returns {Promise<string>}
 */
export async function docxToMarkdown(file, onProgress, opts = {}) {
    if (onProgress) onProgress(5);
    const [mammoth, JSZip] = await Promise.all([loadMammoth(), loadJSZip(), loadTurndown()]);
    if (onProgress) onProgress(20);

    const arrayBuffer = await file.arrayBuffer();
    try {
        assertZipWithinLimit(arrayBuffer, {kind: 'Word', maxBytes: opts.maxUncompressedBytes});
    } catch (err) {
        if (/\.doc$/i.test(file.name || '') && /not a zip/.test(err.message)) {
            throw new Error('Old .doc files cannot be imported. Save the document as .docx in Word, then import that.');
        }
        throw err;
    }
    // The directory's sizes can lie, and mammoth unzips on its own: count what
    // inflating really produces before handing it the file.
    await assertInflatedWithinLimit(await JSZip.loadAsync(arrayBuffer), {kind: 'Word', maxBytes: opts.maxUncompressedBytes});
    if (onProgress) onProgress(35);

    const maxImageBytes = opts.maxImageBytes || MAX_IMAGE_BYTES;
    const dropped = [];
    const convertImage = mammoth.images.imgElement(async (image) => {
        const type = String(image.contentType || '').toLowerCase();
        if (!IMAGE_TYPES.has(type)) {
            dropped.push(`an image in an unsupported format (${type || 'unknown'})`);
            return {src: '', alt: '[Image not imported: unsupported format]'};
        }
        const base64 = await image.read('base64');
        const bytes = Math.floor(base64.length * 3 / 4);
        if (bytes > maxImageBytes) {
            dropped.push(`an image of ${formatSize(bytes)}`);
            return {src: '', alt: '[Image not imported: too large]'};
        }
        return {src: `data:${type};base64,${base64}`};
    });

    const result = await mammoth.convertToHtml({arrayBuffer}, {styleMap: STYLE_MAP, convertImage});
    if (onProgress) onProgress(65);

    if (dropped.length) {
        warn(opts, `${dropped.length} image${dropped.length === 1 ? ' was' : 's were'} replaced with a placeholder ` +
            `(${summarise(dropped)}). Images up to ${formatSize(maxImageBytes)} in PNG, JPEG, GIF, WebP, BMP or SVG are kept.`);
    }
    const notes = (result.messages || []).filter(m => m && m.message).map(m => m.message);
    if (notes.length) warn(opts, `Word conversion notes: ${summarise(notes)}`);

    const td = buildTurndown(opts);
    let md = td.turndown(result.value);

    // Cleanup: normalise whitespace, guarantee H1
    md = md.replace(/\n{3,}/g, '\n\n').trim();
    if (!/^# /m.test(md)) {
        md = md.replace(/^## ([^\n]+)/m, '# $1');
    }

    if (onProgress) onProgress(100);
    return md;
}
