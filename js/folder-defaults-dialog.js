/**
 * js/folder-defaults-dialog.js
 *
 * The "Load default folders" dialog: after a defaults file is read, the user
 * chooses each folder again, one row per folder with a Choose button labelled
 * with the folder's expected name. A browser opens its folder picker only from
 * a click, and gives a page no paths, so each folder needs its own click.
 *
 * A chosen folder whose name differs from the expected one is kept, with a
 * warning on its row. Open folders resolves with the chosen ones, in the file's
 * order; Cancel and Escape resolve with null.
 */
import {openModal} from './dialog-a11y.js';
import {compareFolderName} from './folder-defaults.js';

/**
 * @param {HTMLElement} root  the #defaults-modal element (see index.html), with
 *        [data-role] message, list, open and cancel children
 * @param {{pick: () => Promise<object|null>}} deps
 *        pick: show the folder picker; resolves with a directory handle, or null when cancelled
 * @returns {(expected: Array<{name: string}>) => Promise<Array<{name: string, handle: object}>|null>}
 */
export function createDefaultsDialog(root, {pick}) {
    const messageEl = root.querySelector('[data-role="message"]');
    const listEl = root.querySelector('[data-role="list"]');
    const openBtn = root.querySelector('[data-role="open"]');
    const cancelBtn = root.querySelector('[data-role="cancel"]');
    let finish = null;

    openBtn.addEventListener('click', () => { if (finish) finish('open'); });
    cancelBtn.addEventListener('click', () => { if (finish) finish(null); });

    return function show(expected) {
        if (finish) finish(null);
        const chosen = new Array(expected.length).fill(null);
        messageEl.textContent = expected.length === 1
            ? 'Choose the folder again. The browser needs you to pick it before PrintMD can read it.'
            : `Choose each of these ${expected.length} folders again. The browser needs you to pick them before PrintMD can read them.`;
        listEl.textContent = '';
        const update = () => {
            const n = chosen.filter(Boolean).length;
            openBtn.disabled = n === 0;
            openBtn.textContent = n === 1 ? 'Open 1 folder' : `Open ${n} folders`;
        };
        expected.forEach((want, i) => {
            const li = document.createElement('li');
            li.className = 'defaults-row';
            const name = document.createElement('span');
            name.className = 'defaults-name';
            name.textContent = want.name;
            const status = document.createElement('span');
            status.className = 'defaults-status';
            status.textContent = 'Not chosen';
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'btn-secondary defaults-choose';
            btn.textContent = 'Choose...';
            btn.setAttribute('aria-label', 'Choose folder ' + want.name);
            btn.addEventListener('click', async () => {
                let handle = null;
                try { handle = await pick(); } catch (_e) { handle = null; }
                if (!finish || !handle) return;
                chosen[i] = handle;
                const match = compareFolderName(want.name, handle.name);
                li.classList.toggle('defaults-mismatch', match === 'different');
                status.textContent = match === 'different'
                    ? `Chosen "${handle.name}", not "${want.name}"`
                    : 'Chosen';
                btn.textContent = 'Change...';
                update();
            });
            li.append(name, status, btn);
            listEl.appendChild(li);
        });
        update();

        return new Promise((resolve) => {
            let modal = null;
            finish = (choice) => {
                finish = null;
                root.hidden = true;
                if (modal) modal.close();
                if (choice !== 'open') { resolve(null); return; }
                const out = [];
                chosen.forEach((handle, i) => { if (handle) out.push({name: expected[i].name, handle}); });
                resolve(out);
            };
            root.hidden = false;
            modal = openModal(root, {
                initialFocus: listEl.querySelector('.defaults-choose'),
                onEscape: () => { if (finish) finish(null); },
            });
        });
    };
}
