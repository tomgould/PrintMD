/**
 * js/dialog-a11y.js
 *
 * Shared keyboard and screen reader behaviour for the app's modal dialogs
 * (choice dialogs, password prompt, Google Drive, command palette):
 *
 *   - focus moves into the dialog when it opens (to the control given, else
 *     the first one);
 *   - Tab and Shift+Tab cycle through the dialog's visible controls only;
 *   - Escape runs the dialog's onEscape (the caller picks the safe action);
 *   - while a modal is open, Escape and shortcut keys (Ctrl, Cmd or Alt) do not
 *     reach the rest of the app, and everything outside the dialog is `inert`
 *     (no focus, no clicks, out of the accessibility tree), except live regions
 *     without controls, so announcements still reach screen readers;
 *   - on close, focus returns to the element that had it when the dialog opened
 *     (or to a fallback when that element is gone or hidden).
 *
 * Modals stack: opening one over another makes the lower one inert until the
 * upper one closes. The caller shows and hides the dialog element itself:
 * show it, then call openModal(); hide it, then call close().
 */

const FOCUSABLE = [
    'a[href]', 'button:not([disabled])', 'input:not([disabled]):not([type="hidden"])',
    'select:not([disabled])', 'textarea:not([disabled])', '[tabindex]:not([tabindex="-1"])',
].join(', ');

const LIVE = '[aria-live], [role="status"], [role="alert"], [role="log"]';

/** @type {Array<{root: HTMLElement, onEscape: Function|null, restoreTo: Element|null, fallbackFocus: any}>} */
const stack = [];
const madeInert = new Set();

function isShown(el) {
    if (!el || !el.isConnected) return false;
    if (el.closest('[inert]')) return false;
    const view = el.ownerDocument.defaultView;
    if (!el.getClientRects().length) return false;
    return view.getComputedStyle(el).visibility !== 'hidden';
}

/** The dialog's controls that a Tab can reach, in document order. */
export function focusableIn(root) {
    return Array.from(root.querySelectorAll(FOCUSABLE)).filter((el) => el.tabIndex >= 0 && isShown(el));
}

/** Mark everything outside `root` inert (siblings of root and of each ancestor up to <body>). */
function applyInert() {
    for (const el of madeInert) el.inert = false;
    madeInert.clear();
    const top = stack[stack.length - 1];
    if (!top) return;
    const body = top.root.ownerDocument.body;
    for (let node = top.root; node && node !== body && node.parentElement; node = node.parentElement) {
        for (const sib of node.parentElement.children) {
            if (sib === node || sib.inert || /^(SCRIPT|STYLE|LINK|TEMPLATE)$/.test(sib.tagName)) continue;
            // Announcement regions stay live so messages still reach screen readers.
            // One with a control of its own (the storage banner's Dismiss) is inert
            // like the rest: it was announced when it appeared, and its button must
            // not be reachable behind the dialog.
            if (sib.matches(LIVE) && !sib.querySelector(FOCUSABLE)) continue;
            sib.inert = true;
            madeInert.add(sib);
        }
    }
}

function resolve(target) {
    return typeof target === 'function' ? target() : target;
}

function onKeydown(e) {
    const top = stack[stack.length - 1];
    if (!top) return;
    if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        if (top.onEscape) top.onEscape(e);
        return;
    }
    if (e.key === 'Tab' && !e.ctrlKey && !e.altKey && !e.metaKey) {
        e.preventDefault();
        e.stopPropagation();
        const list = focusableIn(top.root);
        if (!list.length) return;
        const i = list.indexOf(top.root.ownerDocument.activeElement);
        const next = e.shiftKey
            ? (i <= 0 ? list.length - 1 : i - 1)
            : (i === -1 || i === list.length - 1 ? 0 : i + 1);
        list[next].focus();
        return;
    }
    // App shortcuts (Ctrl+K, Ctrl+S, Alt+1...) stay off while a modal is open.
    // Only propagation stops: the browser's own behaviour (copy, paste) still works.
    if (e.ctrlKey || e.metaKey || e.altKey) e.stopPropagation();
}

let listening = null;

/**
 * Make `root` behave as a modal. Call after showing it.
 * @param {HTMLElement} root  the dialog element (role dialog or alertdialog, aria-modal)
 * @param {{initialFocus?: Element|(() => Element|null)|null,
 *          onEscape?: ((e: KeyboardEvent) => void)|null,
 *          restoreTo?: Element|null,
 *          fallbackFocus?: Element|(() => Element|null)|null}} [opts]
 *        restoreTo defaults to the element focused before the call
 * @returns {{close: (opts?: {restoreFocus?: boolean}) => void}}  call after hiding it
 */
export function openModal(root, {initialFocus = null, onEscape = null, restoreTo, fallbackFocus = null} = {}) {
    const doc = root.ownerDocument;
    const existing = stack.findIndex((m) => m.root === root);
    if (existing > -1) stack.splice(existing, 1);
    const entry = {
        root,
        onEscape,
        restoreTo: restoreTo === undefined ? doc.activeElement : restoreTo,
        fallbackFocus,
    };
    stack.push(entry);
    if (listening !== doc) {
        if (listening) listening.removeEventListener('keydown', onKeydown, true);
        doc.addEventListener('keydown', onKeydown, true);
        listening = doc;
    }
    root.inert = false;
    applyInert();
    const first = resolve(initialFocus);
    const target = first && isShown(first) ? first : (focusableIn(root)[0] || null);
    if (target) {
        target.focus();
    } else {
        if (!root.hasAttribute('tabindex')) root.setAttribute('tabindex', '-1');
        root.focus();
    }

    let closed = false;
    return {
        close({restoreFocus = true} = {}) {
            if (closed) return;
            closed = true;
            const i = stack.indexOf(entry);
            const wasTop = i === stack.length - 1;
            if (i > -1) stack.splice(i, 1);
            applyInert();
            if (!stack.length && listening) {
                listening.removeEventListener('keydown', onKeydown, true);
                listening = null;
            }
            if (!restoreFocus || !wasTop) return;
            const below = stack[stack.length - 1];
            const candidates = [entry.restoreTo, resolve(entry.fallbackFocus)];
            for (const el of candidates) {
                if (el && typeof el.focus === 'function' && isShown(el) && (!below || below.root.contains(el))) {
                    el.focus();
                    return;
                }
            }
            if (below) {
                const inBelow = focusableIn(below.root)[0];
                if (inBelow) inBelow.focus();
            }
        },
    };
}

/** True while any modal opened with openModal is open. */
export function isModalOpen() {
    return stack.length > 0;
}
