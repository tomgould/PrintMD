/**
 * Scans of untrusted text, shared by the Node side and the render harness
 * (which loads this file at https://render.invalid/__bd/untrusted.mjs, so it
 * has no imports).
 *
 * Every function here is linear in the length of its input: a regular
 * expression only ever matches a fixed head, and anything of unbounded length
 * is walked with indexOf or a character loop. A super-linear pattern on the
 * request path would freeze the service before any limit or timeout applies
 * (server/test/redos.test.mjs checks this on 1 MB hostile inputs).
 */

/** "data:image/<type>(;<param>)*;base64," : the head of a base64 image data URI, at most 256 characters. */
const DATA_IMAGE_HEAD_RE = /^data:image\/[a-z0-9.+-]+(?:;[a-z0-9=.+-]+)*;base64,/i;
const HEAD_MAX = 256;
const PAYLOAD_CHARS = new Set('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=');
const PAYLOAD_END = new Set([' ', '\t', '\n', '\r', '\f', '\v', ')', '"', "'", '>']);

/**
 * The base64 image data URIs in a text: each one's start, where its payload
 * starts, and its end. A URI counts only when its head is well formed and ends
 * in ";base64,", its payload is base64 characters only, and it ends at
 * whitespace, a bracket, a quote, ">" or the end of the text.
 * @param {string} text
 * @returns {{start: number, payloadStart: number, end: number}[]}
 */
export function dataImageSpans(text) {
    const s = String(text);
    const spans = [];
    let from = 0;
    for (let at = s.indexOf('data:image/', from); at !== -1; at = s.indexOf('data:image/', from)) {
        const head = DATA_IMAGE_HEAD_RE.exec(s.slice(at, at + HEAD_MAX));
        if (!head) {
            from = at + 1;
            continue;
        }
        const payloadStart = at + head[0].length;
        let end = payloadStart;
        while (end < s.length && PAYLOAD_CHARS.has(s[end])) end++;
        if (end === s.length || PAYLOAD_END.has(s[end])) spans.push({start: at, payloadStart, end});
        from = Math.max(end, at + 1);
    }
    return spans;
}

/** Shortest payload the harness takes out of the Markdown before parsing it. */
export const UNCOUNTED_MIN_PAYLOAD = 1024;

/**
 * The one definition of "image payload that does not count toward the 2 MB
 * Markdown limit": base64 image data URIs (dataImageSpans) with a payload of
 * at least UNCOUNTED_MIN_PAYLOAD characters. The size check leaves exactly
 * these payloads out, and the harness swaps exactly these URIs for
 * placeholders before the Markdown parser sees them, so nothing left out of the
 * count ever reaches the parser.
 * @param {string} text
 * @returns {{start: number, payloadStart: number, end: number}[]}
 */
export function uncountedSpans(text) {
    return dataImageSpans(text).filter((span) => span.end - span.payloadStart >= UNCOUNTED_MIN_PAYLOAD);
}

function unquote(value) {
    const v = value.trim();
    if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v[v.length - 1] === v[0]) return v.slice(1, -1).trim();
    return v;
}

/** The closing quote's index for a quote at i, or -1. */
function closingQuote(s, i) {
    return s.indexOf(s[i], i + 1);
}

function skipSpace(s, i) {
    let j = i;
    while (j < s.length && /\s/.test(s[j])) j++;
    return j;
}

/**
 * URLs in CSS text: url(...), @import "..." and image-set("...").
 * @param {string} css
 * @returns {string[]}
 */
export function cssUrls(css) {
    const s = String(css);
    const lower = s.replace(/[A-Z]+/g, (m) => m.toLowerCase());
    const out = [];
    for (let at = lower.indexOf('url('); at !== -1;) {
        const close = s.indexOf(')', at + 4);
        if (close === -1) break; // no later url( can close either
        out.push(unquote(s.slice(at + 4, close)));
        at = lower.indexOf('url(', close + 1);
    }
    for (const word of ['@import', 'image-set(']) {
        const unclosed = new Set(); // quote characters with no later occurrence (positions only grow)
        for (let at = lower.indexOf(word); at !== -1; at = lower.indexOf(word, at + word.length)) {
            const q = skipSpace(s, at + word.length);
            if ((s[q] !== '"' && s[q] !== "'") || unclosed.has(s[q])) continue;
            const close = closingQuote(s, q);
            if (close === -1) {
                unclosed.add(s[q]);
                continue;
            }
            out.push(s.slice(q + 1, close));
        }
    }
    return out;
}

/** The URLs of a srcset value. */
export function srcsetUrls(value) {
    return String(value).split(',').map((part) => part.trim().split(/\s+/)[0]).filter(Boolean);
}

/** The URL in a <meta http-equiv="refresh"> content value ("0; url=..."), or null. */
export function metaRefreshUrl(value) {
    const s = String(value);
    const lower = s.replace(/[A-Z]+/g, (m) => m.toLowerCase());
    for (let at = lower.indexOf('url'); at !== -1; at = lower.indexOf('url', at + 3)) {
        let i = skipSpace(s, at + 3);
        if (s[i] !== '=') continue;
        i = skipSpace(s, i + 1);
        if (s[i] === '"' || s[i] === "'") i++;
        let end = i;
        while (end < s.length && !/['";\s]/.test(s[end])) end++;
        if (end > i) return s.slice(i, end);
    }
    return null;
}
