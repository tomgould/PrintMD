/**
 * js/shortcuts.js
 *
 * The app's keyboard shortcuts: which keydown means which command
 * (shortcutFor, no DOM) and the one document listener that runs them.
 *
 * The New document shortcut. Chrome does not let a tab intercept Ctrl+N, so New
 * is Alt+N. On macOS, Option+N is the dead key that types accents (n after it
 * gives ñ), so there New is Ctrl+Option+N instead and Option+N is left alone.
 * Recent files follow the same split: Alt+1..9, or Ctrl+Option+1..9 on macOS.
 */

/** @param {Navigator|object} [nav] */
export function isMacPlatform(nav) {
    if (!nav) return false;
    const platform = (nav.userAgentData && nav.userAgentData.platform) || nav.platform || '';
    return /mac/i.test(platform);
}

/** True when the keydown is the New document shortcut for this platform. */
export function isNewDocShortcut(e, isMac) {
    // Match the physical key: with Option held, macOS reports a dead key, not "n".
    const isN = e.code === 'KeyN' || (e.key || '').toLowerCase() === 'n';
    if (!isN || !e.altKey || e.shiftKey || e.metaKey) return false;
    return isMac ? e.ctrlKey : !e.ctrlKey;
}

export function newDocShortcutLabel(isMac) {
    return isMac ? 'Ctrl+Option+N' : 'Alt+N';
}

/**
 * The digit 1 to 9 when the keydown is a Recent files shortcut, else null. Alt+digit,
 * or Ctrl+Option+digit on macOS, where Option+digit types characters people need
 * ("#" and "€" on a UK Mac, "[" and "{" on German and French ones): the same split as
 * New. The physical key (e.code, digit row or number pad), so the typed character
 * does not matter; e.key only when an event has no code. Shift and Meta are not used.
 */
export function recentShortcutDigit(e, isMac) {
    if (!e.altKey || e.shiftKey || e.metaKey || (isMac ? !e.ctrlKey : e.ctrlKey)) return null;
    const m = e.code ? /^(?:Digit|Numpad)([1-9])$/.exec(e.code) : /^([1-9])$/.exec(e.key || '');
    return m ? m[1] : null;
}

export function recentShortcutLabel(isMac) {
    return isMac ? 'Ctrl+Option+1…9' : 'Alt+1…9';
}

/**
 * The command a keydown asks for, or null when the app does not handle it (the
 * browser then keeps its own shortcut). Shift and Alt only match bindings that
 * use them. Commands: new, open, save, pdf, palette, bold and italic (only while
 * the editor has focus), and recent-1 to recent-9 (Alt+1 to Alt+9, Ctrl+Option+1 to 9 on macOS).
 * @param {KeyboardEvent|object} e
 * @param {{isMac?: boolean, editorFocused?: boolean}} [ctx]
 * @returns {string|null}
 */
export function shortcutFor(e, {isMac = false, editorFocused = false} = {}) {
    if (isNewDocShortcut(e, isMac)) return 'new';
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key || '';
    // Alt+1..9 (Ctrl+Option+1..9 on macOS): the Nth file in the Recent files list.
    const digit = recentShortcutDigit(e, isMac);
    if (digit) return 'recent-' + digit;
    if (!mod || e.shiftKey || e.altKey) return null;
    switch (key.toLowerCase()) {
        case 'o': return 'open';
        case 's': return 'save';
        case 'p': return 'pdf';
        case 'k': return 'palette';
        case 'b': return editorFocused ? 'bold' : null;
        case 'i': return editorFocused ? 'italic' : null;
        default: return null;
    }
}

/**
 * Run shortcuts from one keydown listener on `target` (the document).
 * `resolve(command)` returns the function to run, or null when there is nothing
 * to do (Alt+3 with two recent files): the key then keeps its default action.
 * A key the app acts on has its default prevented; a held key runs once.
 * @param {EventTarget} target
 * @param {{isMac: boolean, isEditorFocused: () => boolean, resolve: (command: string) => (Function|null)}} deps
 */
export function initKeyboardShortcuts(target, {isMac, isEditorFocused, resolve}) {
    target.addEventListener('keydown', (e) => {
        const command = shortcutFor(e, {isMac, editorFocused: isEditorFocused()});
        const action = command && resolve(command);
        if (!action) return;
        e.preventDefault();          // only for keys the app acts on
        if (e.repeat) return;        // a held key runs the action once
        action();
    });
}
