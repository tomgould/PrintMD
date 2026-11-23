/**
 * xml-safe.js
 * Text and link targets that can go into the XML parts of an Office file.
 * Shared by the Word (js/docx-export.js) and PowerPoint (js/slides.js,
 * js/pptx-export.js) exports. Pure: no DOM.
 */

/** Longest hyperlink target written to an Office file, in characters. */
export const MAX_LINK_LENGTH = 2000;
const EXTERNAL_LINK_RE = /^(?:https?:|mailto:)/i;

/**
 * The hyperlink target for an href: the URL parser's normalised form (with
 * whatever needs it percent-encoded) for an http, https or mailto link, or ''
 * when the href is not one, does not parse, keeps a character a URI may not
 * hold or a broken %-escape, or is longer than MAX_LINK_LENGTH. A link with no
 * target is written as plain text.
 * @param {string} href
 * @returns {string}
 */
export function externalLinkTarget(href) {
    const raw = String(href == null ? '' : href).trim();
    if (!EXTERNAL_LINK_RE.test(raw) || raw.length > MAX_LINK_LENGTH) return '';
    let url;
    try {
        url = new URL(raw);
    } catch (_e) {
        return '';
    }
    if (!['http:', 'https:', 'mailto:'].includes(url.protocol)) return '';
    const target = url.href;
    if (target.length > MAX_LINK_LENGTH || /[\s<>"{}|\\^`]|%(?![0-9A-Fa-f]{2})/.test(target)) return '';
    return target;
}

// Characters XML 1.0 does not allow, and unpaired surrogates (with the u flag a
// valid surrogate pair is one code point, so only a lone half matches). One of
// them in a part makes Word, PowerPoint and XML parsers refuse the whole file.
const XML_ILLEGAL_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\u{FFFE}\u{FFFF}\u{D800}-\u{DFFF}]/gu;

/** Text with every character XML 1.0 forbids removed. */
export function stripXmlIllegal(str) {
    return String(str == null ? '' : str).replace(XML_ILLEGAL_RE, '');
}

/** Text safe for an XML element or a double-quoted attribute. */
export function escXml(str) {
    return stripXmlIllegal(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}
