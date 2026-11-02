/**
 * js/preflight-dialog.js
 *
 * The template's preflight warnings before a PDF export, in the app's choice
 * dialog (js/conflict-dialog.js). It is shown before the print window opens, so
 * the "Export anyway" click is the user gesture that lets the pop-up open. The
 * Word export uses it too, to list the images the Word file leaves out.
 * Cancel is the safe choice: it has focus first and Escape picks it.
 */

import {createChoiceDialog} from './conflict-dialog.js';

/**
 * @param {HTMLElement} root  the #preflight-modal element (see index.html)
 * @returns {(warnings: string[], opts?: {file?: string}) => Promise<'proceed'|'cancel'>}
 *          file: what is exported, for the message (default "PDF"; the Word export passes "Word file")
 */
export function createPreflightDialog(root) {
    const show = createChoiceDialog(root);
    return function showPreflight(warnings, {file = 'PDF'} = {}) {
        return show({
            message: `The ${file} can still be exported, but check this first:`,
            items: Array.from(warnings || [], String),
            buttons: [
                {choice: 'cancel', label: 'Cancel', primary: true},
                {choice: 'proceed', label: 'Export anyway'},
            ],
            safe: 'cancel',
        });
    };
}
