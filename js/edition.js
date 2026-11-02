/**
 * The edition switch for the editor. The public edition's build changes hostedNotice to
 * true. Keep this file tiny (the build edits that one value) and keep the logic in
 * hostedNoticeVisible(), so the tests cover both values of the flag.
 */

/** The edition switch. The hosted copy notice stays off until a build turns it on. */
export const EDITION = Object.freeze({hostedNotice: true});

/**
 * Whether the "run it locally" notice shows. True only when the edition switched
 * the notice on, it has not been dismissed, the page is served over http or
 * https, and the host is not local (localhost, 127.0.0.1, [::1], ::1 or
 * anything ending in .localhost). Anything unexpected (undefined, empty) is no.
 */
export function hostedNoticeVisible({hostedNotice, hostname, protocol, dismissed} = {}) {
    if (hostedNotice !== true) return false;
    if (dismissed !== false) return false;
    if (protocol !== 'http:' && protocol !== 'https:') return false;
    if (typeof hostname !== 'string' || !hostname) return false;
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1') return false;
    return !hostname.endsWith('.localhost');
}
