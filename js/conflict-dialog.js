/**
 * js/conflict-dialog.js
 *
 * The app's choice dialog (createChoiceDialog), and the "File changed on disk"
 * modal built on it. The conflict modal replaces window.confirm, whose OK/Cancel
 * wording made it easy to discard edits by accident. In every dialog the safe
 * choice (nothing is destroyed) has focus first and is what Escape picks; Tab
 * stays inside the dialog and focus returns where it was on close.
 *
 * Conflict modes:
 *   'watch'  the file changed while you have unsaved edits
 *            -> 'mine' (Keep mine, default) | 'disk' (Load disk version)
 *   'save'   the file changed since you opened it and you are about to save
 *            -> 'cancel' (Cancel, default) | 'disk' (Load disk version) | 'overwrite'
 */

import {openModal} from './dialog-a11y.js';

const MODES = {
    watch: {
        message: (name) => `${name} changed on disk, and you have edits here that are not saved to it.`,
        buttons: [
            {choice: 'mine', label: 'Keep mine', primary: true},
            {choice: 'disk', label: 'Load disk version'},
        ],
        safe: 'mine',
    },
    save: {
        message: (name) => `${name} changed on disk since you opened it. Saving now would replace those changes.`,
        buttons: [
            {choice: 'cancel', label: 'Cancel', primary: true},
            {choice: 'disk', label: 'Load disk version'},
            {choice: 'overwrite', label: 'Overwrite disk with mine', danger: true},
        ],
        safe: 'cancel',
    },
};

/**
 * A modal with a message, an optional list and a row of choice buttons.
 * @param {HTMLElement} root  an .app-modal element with [data-role] message,
 *        actions, optional list and backdrop children (see index.html)
 * @returns {(spec: {message: string, items?: string[], buttons: Array<{choice: string, label: string,
 *          primary?: boolean, danger?: boolean}>, safe: string}) => Promise<string>}
 *          resolves with the chosen button's choice; the first button gets focus
 */
export function createChoiceDialog(root) {
    const messageEl = root.querySelector('[data-role="message"]');
    const listEl = root.querySelector('[data-role="list"]');
    const actionsEl = root.querySelector('[data-role="actions"]');
    const backdrop = root.querySelector('[data-role="backdrop"]');
    let finish = null;   // resolves the open dialog

    function buttons() { return Array.from(actionsEl.querySelectorAll('button')); }

    // Focus, Tab, Escape and inert come from js/dialog-a11y.js: its listener is on
    // the document (capture phase), so Escape and Tab still work after a click on
    // the dialog's text moved focus to <body>.
    if (backdrop) backdrop.addEventListener('click', () => { if (finish) buttons()[0].focus(); });

    return function show({message, items = [], buttons: specButtons, safe}) {
        if (finish) finish(root.dataset.safe);   // never stack two dialogs
        messageEl.textContent = message;
        if (listEl) {
            listEl.textContent = '';
            for (const item of items) {
                const li = document.createElement('li');
                li.textContent = item;
                listEl.appendChild(li);
            }
            listEl.hidden = items.length === 0;
        }
        actionsEl.textContent = '';
        root.dataset.safe = safe;

        return new Promise((resolve) => {
            let modal = null;
            finish = (choice) => {
                finish = null;
                root.hidden = true;
                if (modal) modal.close();
                resolve(choice);
            };
            for (const b of specButtons) {
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.textContent = b.label;
                btn.dataset.choice = b.choice;
                btn.className = b.primary ? 'btn-primary' : (b.danger ? 'btn-secondary btn-danger' : 'btn-secondary');
                btn.addEventListener('click', () => { if (finish) finish(b.choice); });
                actionsEl.appendChild(btn);
            }
            root.hidden = false;
            modal = openModal(root, {
                initialFocus: buttons()[0],
                onEscape: () => { if (finish) finish(root.dataset.safe); },
            });
        });
    };
}

/**
 * @param {HTMLElement} root  the #conflict-modal element (see index.html)
 * @returns {(mode: 'watch'|'save', fileName?: string) => Promise<string>}
 */
export function createConflictDialog(root) {
    const show = createChoiceDialog(root);
    return function showConflict(mode, fileName) {
        const spec = MODES[mode] || MODES.watch;
        const done = show({
            message: spec.message(fileName ? `"${fileName}"` : 'This file'),
            buttons: spec.buttons,
            safe: spec.safe,
        });
        root.dataset.mode = mode;
        return done;
    };
}
