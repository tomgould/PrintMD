/**
 * download.js
 * One way to hand the user a file: a safe file name and a Blob download.
 *
 * toFilenameSafe is pure. downloadBlob needs a document, but only when called.
 */

// Characters Windows, macOS or Linux reject in a file name.
const RESERVED_RE = /[\\/:*?"<>|]/g;
// C0 and C1 control characters (whitespace controls are turned into spaces first).
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/g;
// Windows device names, which cannot be used as a base name with any extension.
const DEVICE_RE = /^(con|prn|aux|nul|com\d|lpt\d)$/i;

/**
 * A file name base (no extension) that every desktop OS accepts.
 * Reserved characters become spaces, control characters are removed, runs of
 * whitespace collapse, leading and trailing dots and spaces are trimmed, and the
 * result is cut to maxLength characters (code points, so an emoji is never split).
 * @param {*} name
 * @param {string} [fallback]   used when nothing usable is left
 * @param {number} [maxLength]
 * @returns {string}
 */
// Trims leading and trailing dots and whitespace with a loop: the regex form
// /[\s.]+$/ is quadratic on a long run of dots followed by a letter.
function trimDotsAndSpaces(s) {
    const trimmable = (c) => c === '.' || /\s/.test(c);
    let start = 0;
    let end = s.length;
    while (start < end && trimmable(s[start])) start++;
    while (end > start && trimmable(s[end - 1])) end--;
    return s.slice(start, end);
}

export function toFilenameSafe(name, fallback = 'document', maxLength = 100) {
    const trim = trimDotsAndSpaces;
    let base = String(name == null ? '' : name)
        .replace(RESERVED_RE, ' ')
        .replace(/\s+/g, ' ')
        .replace(CONTROL_RE, '');
    base = trim(base);
    base = trim(Array.from(base).slice(0, maxLength).join(''));
    if (!base) return fallback;
    return DEVICE_RE.test(base) ? base + '_' : base;
}

/**
 * Download a Blob as a file. The object URL is revoked after a delay: revoking it
 * straight after click() can cancel the download in some browsers.
 * @param {Blob} blob
 * @param {string} filename  already safe (see toFilenameSafe), with its extension
 * @param {{revokeAfterMs?: number}} [opts]
 */
export function downloadBlob(blob, filename, {revokeAfterMs = 30000} = {}) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), revokeAfterMs);
}
