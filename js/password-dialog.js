/**
 * js/password-dialog.js
 *
 * The password prompt for an encrypted PDF import, built like the app's choice
 * dialog (js/conflict-dialog.js): Cancel is the safe choice and what Escape
 * picks, Enter submits, Tab stays inside the dialog, and focus returns where it
 * was on close. The field is cleared every time, and the password is handed to
 * the caller only (never stored or logged).
 */

import {openModal} from './dialog-a11y.js';

const MESSAGES = {
    need: 'This PDF is protected with a password. Enter it to import the document.',
    incorrect: 'That password did not open the PDF. Check it and try again.',
};

/**
 * @param {HTMLElement} root  the #password-modal element (see index.html): [data-role]
 *        message, password and backdrop children, and [data-choice] ok / cancel buttons
 * @returns {(reason?: 'need'|'incorrect') => Promise<string|null>}
 *          resolves with the password entered, or null when cancelled
 */
export function createPasswordDialog(root) {
    const messageEl = root.querySelector('[data-role="message"]');
    const input = root.querySelector('[data-role="password"]');
    const okBtn = root.querySelector('[data-choice="ok"]');
    const cancelBtn = root.querySelector('[data-choice="cancel"]');
    const backdrop = root.querySelector('[data-role="backdrop"]');
    let finish = null;   // resolves the open prompt

    // Tab, Escape, focus restore and inert come from js/dialog-a11y.js; Tab order
    // is document order: the field, then the buttons as laid out.
    input.addEventListener('keydown', (e) => {
        if (!finish || e.key !== 'Enter') return;
        e.preventDefault();
        e.stopPropagation();
        finish(input.value);
    });

    okBtn.addEventListener('click', () => { if (finish) finish(input.value); });
    cancelBtn.addEventListener('click', () => { if (finish) finish(null); });
    if (backdrop) backdrop.addEventListener('click', () => { if (finish) input.focus(); });

    return function askPassword(reason = 'need') {
        if (finish) finish(null);   // never stack two prompts
        messageEl.textContent = MESSAGES[reason] || MESSAGES.need;
        root.dataset.reason = reason === 'incorrect' ? 'incorrect' : 'need';
        input.value = '';

        return new Promise((resolve) => {
            let modal = null;
            finish = (value) => {
                finish = null;
                input.value = '';
                root.hidden = true;
                if (modal) modal.close();
                resolve(value == null ? null : String(value));
            };
            root.hidden = false;
            modal = openModal(root, {initialFocus: input, onEscape: () => { if (finish) finish(null); }});
        });
    };
}
