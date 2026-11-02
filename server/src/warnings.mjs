/**
 * X-PrintMD-Warnings: the warnings as a URL-encoded JSON array, kept under
 * a size cap. When they do not all fit, the last entry is "truncated: N more".
 */

export const WARNINGS_HEADER_MAX = 4096;

const encode = (list) => encodeURIComponent(JSON.stringify(list));

/**
 * @param {string[]} warnings
 * @param {number} [max]  longest header value, in characters
 * @returns {string}
 */
export function warningsHeader(warnings, max = WARNINGS_HEADER_MAX) {
    const list = warnings.map(String);
    if (encode(list).length <= max) return encode(list);
    let keep = list.length;
    while (keep > 0 && encode([...list.slice(0, keep), `truncated: ${list.length - keep} more`]).length > max) keep--;
    return encode([...list.slice(0, keep), `truncated: ${list.length - keep} more`]);
}
