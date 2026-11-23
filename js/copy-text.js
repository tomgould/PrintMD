/**
 * js/copy-text.js
 *
 * Copy text to the clipboard. The Clipboard API (navigator.clipboard) exists
 * only in a secure context: https and localhost. On plain http from any other
 * host it is undefined, so the copy falls back to a hidden textarea and
 * document.execCommand('copy'), which is also tried when the API refuses.
 */

/**
 * @param {string} text
 * @param {{clipboard?: {writeText: Function}|null, doc?: Document}} [env]  defaults: navigator.clipboard, document
 * @returns {Promise<boolean>} true when the text reached the clipboard
 */
export async function copyText(text, {clipboard = globalThis.navigator && globalThis.navigator.clipboard, doc = document} = {}) {
    if (clipboard && typeof clipboard.writeText === 'function') {
        try {
            await clipboard.writeText(text);
            return true;
        } catch (_e) {
            // Refused (no permission, the page lost focus): try the older way.
        }
    }
    return copyWithTextarea(text, doc);
}

/** The pre-Clipboard-API copy: select a hidden textarea and run the copy command. */
function copyWithTextarea(text, doc) {
    const ta = doc.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.setAttribute('aria-hidden', 'true');
    ta.tabIndex = -1;
    ta.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;pointer-events:none;';
    const restore = doc.activeElement;
    doc.body.appendChild(ta);
    let ok = false;
    try {
        ta.select();
        ok = doc.execCommand('copy') === true;
    } catch (_e) {
        ok = false;
    } finally {
        ta.remove();
        // select() moved focus into the textarea: put it back.
        if (restore && restore !== doc.body && typeof restore.focus === 'function') restore.focus({preventScroll: true});
    }
    return ok;
}
