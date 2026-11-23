/**
 * js/text-insert.js
 *
 * Replace a range of a textarea's text. Prefers execCommand('insertText') so the
 * edit joins the browser's native undo stack. That command returns false (or does
 * nothing) when the textarea cannot take focus, for example when it is hidden in
 * Preview-only view, or when the browser does not support it. In that case the
 * value is set directly and an `input` event is dispatched, so the edit is never
 * silently lost and listeners (preview, autosave) still run.
 */

/**
 * @param {HTMLTextAreaElement} el
 * @param {number} start
 * @param {number} end
 * @param {string} text
 * @param {Document} [doc]  injectable for tests
 * @returns {boolean} true if the native command did the edit, false if the fallback did
 */
export function replaceRange(el, start, end, text, doc = document) {
    const before = el.value;
    const expected = before.slice(0, start) + text + before.slice(end);
    try { el.focus(); } catch (_e) { /* not focusable */ }
    try { el.setSelectionRange(start, end); } catch (_e) { /* detached */ }
    let ok = false;
    // Only use the command when the textarea really has focus: otherwise it would
    // type into whatever element does (the sidebar filter, a dialog input).
    if (doc.activeElement === el) {
        try { ok = doc.execCommand('insertText', false, text); } catch (_e) { ok = false; }
    }
    if (ok && el.value === expected) return true;
    // The command failed, or changed nothing (hidden textarea). Make the edit directly.
    el.value = expected;
    const caret = start + text.length;
    try { el.setSelectionRange(caret, caret); } catch (_e) { /* detached */ }
    el.dispatchEvent(new Event('input', {bubbles: true}));
    return false;
}
