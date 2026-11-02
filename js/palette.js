/**
 * js/palette.js
 *
 * The command palette (Ctrl+K): an ARIA combobox over a listbox of commands,
 * filtered as you type, plus the recent documents as "Open: ..." commands.
 * Focus stays in the input; aria-activedescendant names the highlighted option;
 * the match count is announced politely once typing pauses. It is a modal
 * dialog through js/dialog-a11y.js (focus in, Tab trap, Escape, focus restore).
 */
import {openModal} from './dialog-a11y.js';

/** True when every character of `query` appears in `label`, in order (case-insensitive). */
export function fuzzyMatch(query, label) {
    let qi = 0;
    const ql = query.length;
    const ll = label.length;
    for (let i = 0; i < ll && qi < ql; i++) {
        if (label[i].toLowerCase() === query[qi].toLowerCase()) qi++;
    }
    return qi === ql;
}

/**
 * The app's commands. Each runs by clicking the control a user would, so the
 * palette never has its own copy of an action.
 * @param {{byId: (id: string) => HTMLElement|null, newDocShortcut: string}} deps
 */
export function appCommands({byId, newDocShortcut}) {
    const click = (id) => { const el = byId(id); if (el) el.click(); };
    const exportAs = (format) => () => {
        const f = byId('export-format');
        f.value = format;
        f.dispatchEvent(new Event('change', {bubbles: true}));
        click('btn-export');
    };
    const view = (mode) => () => byId('menu-view-list').querySelector(`[data-view="${mode}"]`).click();
    const cmds = [
        {cat: 'File', label: `New document  (${newDocShortcut})`, run: () => click('btn-new')},
        {cat: 'File', label: 'Open file…', run: () => click('btn-open')},
        {cat: 'File', label: 'Save', run: () => click('btn-save')},
        {cat: 'Export', label: 'Export as PDF', run: exportAs('pdf')},
        {cat: 'Export', label: 'Export as Word', run: exportAs('docx')},
        {cat: 'Export', label: 'Export as PowerPoint', run: exportAs('pptx')},
        {cat: 'View', label: 'View: Split', run: view('split')},
        {cat: 'View', label: 'View: Editor only', run: view('editor')},
        {cat: 'View', label: 'View: Preview only', run: view('preview')},
        {cat: 'View', label: 'Toggle light / dark theme', run: () => click('btn-theme')},
        {cat: 'Edit', label: 'Copy rendered HTML', run: () => click('btn-copy-html')},
        {cat: 'Import', label: 'Import PDF', run: () => click('btn-import-pdf')},
        {cat: 'Import', label: 'Import Word', run: () => click('btn-import-docx')},
        {cat: 'Import', label: 'Import HTML', run: () => click('btn-import-html')},
        {cat: 'Import', label: 'Import EPUB', run: () => click('btn-import-epub')},
        {cat: 'Import', label: 'Import from Google Drive', run: () => click('btn-import-drive')},
    ];
    const sel = byId('template-select');
    if (sel) {
        // In picker order; a template under a group heading (an <optgroup>) names its group.
        Array.from(sel.options).forEach(o => cmds.push({cat: 'Template', label: 'Template: ' + o.textContent
            + (o.parentElement && o.parentElement.tagName === 'OPTGROUP' ? ` (${o.parentElement.label})` : ''), run: () => {
            sel.value = o.value;
            sel.dispatchEvent(new Event('change', {bubbles: true}));
        }}));
    }
    return cmds;
}

/**
 * @param {{
 *   root: HTMLElement, input: HTMLInputElement, list: HTMLElement,
 *   commands: () => Array<{cat: string, label: string, run: Function}>,
 *   listRecent: (limit: number) => Promise<Array<{id: string, title?: string, fileName?: string}>>,
 *   openDoc: (id: string) => any,
 *   idPrefix: string,
 * }} deps
 *   idPrefix  random per page load: the preview comes earlier in the page and a
 *             document may carry any raw HTML id, so a fixed option id could be
 *             copied by a document and win the aria-activedescendant lookup
 * @returns {{open: () => Promise<void>, close: () => void}}
 */
export function createCommandPalette({root, input, list, commands, listRecent, openDoc, idPrefix}) {
    let cmdkItems = [], cmdkSel = 0, cmdkAll = [];

    const countEl = root.querySelector('.cmdk-status');
    let countTimer = null;
    const optionId = (idx) => idPrefix + 'cmdk-option-' + idx;

    function renderPalette(filter) {
        const q = filter.trim();
        cmdkItems = [];
        for (const c of cmdkAll) {
            if (!q) {
                cmdkItems.push(c);
            } else if (c.label.toLowerCase().includes(q.toLowerCase()) || fuzzyMatch(q, c.label)) {
                cmdkItems.push(c);
            }
        }
        list.innerHTML = '';
        // The count, once typing pauses, so each keystroke does not interrupt.
        clearTimeout(countTimer);
        const n = cmdkItems.length;
        countTimer = setTimeout(() => {
            if (countEl) countEl.textContent = n === 0 ? 'No matching commands' : `${n} command${n === 1 ? '' : 's'}`;
        }, 150);
        if (n === 0) {
            const li = document.createElement('li');
            li.className = 'cmdk-empty';
            li.setAttribute('role', 'presentation');
            li.textContent = 'No matching commands';
            list.appendChild(li);
            input.removeAttribute('aria-activedescendant');
            return;
        }
        cmdkItems.forEach((item, idx) => {
            const li = document.createElement('li');
            li.id = optionId(idx);
            li.className = 'cmdk-item' + (idx === cmdkSel ? ' sel' : '');
            li.setAttribute('role', 'option');
            li.setAttribute('aria-selected', String(idx === cmdkSel));
            const spanLabel = document.createElement('span');
            spanLabel.textContent = item.label;
            const spanCat = document.createElement('span');
            spanCat.className = 'cmdk-cat';
            spanCat.textContent = item.cat;
            li.append(spanLabel, spanCat);
            li.addEventListener('click', () => runItem(item));
            list.appendChild(li);
        });
        const selected = list.querySelector('.cmdk-item.sel');
        if (selected) {
            input.setAttribute('aria-activedescendant', selected.id);
            selected.scrollIntoView({block: 'nearest'});
        }
    }

    let modal = null;

    async function openPalette() {
        if (modal) return;
        const restoreTo = document.activeElement;
        cmdkAll = commands();
        try {
            const recent = await listRecent(20);
            for (const d of recent) {
                cmdkAll.push({cat: 'Go to', label: 'Open: ' + (d.fileName || d.title || 'Untitled'), run: () => openDoc(d.id)});
            }
        } catch (_e) { /* no recent documents to offer */ }
        if (modal) return;
        cmdkSel = 0;
        root.hidden = false;
        input.value = '';
        input.setAttribute('aria-expanded', 'true');
        modal = openModal(root, {initialFocus: input, onEscape: closePalette, restoreTo});
        renderPalette('');
    }

    function closePalette() {
        if (!modal) return;
        root.hidden = true;
        input.setAttribute('aria-expanded', 'false');
        input.removeAttribute('aria-activedescendant');
        clearTimeout(countTimer);
        if (countEl) countEl.textContent = '';
        const m = modal;
        modal = null;
        m.close();
    }

    /** Close first (focus goes back where it was), then run: a command may open a dialog of its own. */
    function runItem(item) {
        closePalette();
        item.run();
    }

    /** Move the highlight in place (no rebuild, so a screen reader reads just the new option). */
    function highlight() {
        list.querySelectorAll('.cmdk-item').forEach((li, idx) => {
            const on = idx === cmdkSel;
            li.classList.toggle('sel', on);
            li.setAttribute('aria-selected', String(on));
            if (on) {
                input.setAttribute('aria-activedescendant', li.id);
                li.scrollIntoView({block: 'nearest'});
            }
        });
    }

    input.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            cmdkSel = Math.min(cmdkSel + 1, Math.max(0, cmdkItems.length - 1));
            highlight();
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            cmdkSel = Math.max(cmdkSel - 1, 0);
            highlight();
        } else if (e.key === 'Enter') {
            e.preventDefault();
            const item = cmdkItems[cmdkSel];
            if (item) runItem(item);
        }
    });

    input.addEventListener('input', () => {
        cmdkSel = 0;
        renderPalette(input.value);
    });

    root.querySelector('.cmdk-backdrop').addEventListener('click', closePalette);

    return {open: openPalette, close: closePalette};
}
