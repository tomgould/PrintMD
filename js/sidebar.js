/**
 * js/sidebar.js
 *
 * The Recent files sidebar: the list of documents a page at a time (Show more),
 * the title search box, deleting a document, the keyboard behaviour and the
 * collapse toggle.
 *
 * Documents from an opened folder are listed in one collapsible section per
 * folder (getFolders), each with a Close all button, as a file browser: each
 * subfolder is a row that opens and closes, folders before files, by name. A
 * folder's section and its subfolders start closed on every page load and when
 * the folder is first listed; what is opened stays open until the page is
 * reloaded. The other documents follow under their own heading. While
 * searching, the list is flat.
 *
 * The list is one Tab stop: only the "roving" row's buttons (open and delete,
 * or a subfolder's toggle) are in the Tab order, Up/Down/Home/End move between
 * the rows on show, and Right/Left open and close a subfolder (or move into it
 * and back to its parent).
 *
 * Paging reads the store's listPage({limit, cursor}); the search reads its
 * searchTitles(query, limit), which covers every stored document. A search can
 * read every record on a database whose title index is still being repaired,
 * so typing waits for a pause, only one read runs at a time, and a result for
 * text that has since changed is dropped instead of shown.
 */
import {safeGet, safeSet, safeRemove} from './safe-storage.js';

const SIDEBAR_KEY = 'printmd-sidebar-collapsed';
// Where older versions remembered opened folders across reloads: cleared, as folders now load closed.
const OLD_FOLDER_KEYS = ['printmd-folder-collapsed', 'printmd-folder-expanded'];
const PAGE_SIZE = 50;
const SEARCH_DELAY_MS = 200;
const SEARCHING_DELAY_MS = 150;   // a search slower than this shows "Searching..."

/** What a document is called in the list: its file name, else its title. */
function labelOf(d) {
    return d.fileName || d.title || 'Untitled';
}

/** The key the store's title search compares (js/store.js titleKey). */
function searchKey(text) {
    return String(text == null ? '' : text).normalize('NFC').toLowerCase().trim();
}

/** What the list keeps of a document: enough for its row and the search, never its text. */
const LIST_FIELDS = ['id', 'title', 'fileName', 'updatedAt', 'lastOpenedAt', 'origin', 'folderId', 'folderPath'];

export function listEntry(doc) {
    const entry = {};
    for (const key of LIST_FIELDS) if (doc[key] !== undefined) entry[key] = doc[key];
    return entry;
}

/**
 * Split the listed documents into folder sections and the rest.
 * @param {Array<{id: string, name: string, status?: string, docs: object[]}>} folders
 * @param {object[]} docs  the recent documents listed
 * @returns {{folders: object[], others: object[]}} `others` keeps the order of `docs`
 *   and leaves out every document a folder section lists
 */
export function groupDocs(folders, docs) {
    const inFolders = new Set();
    for (const f of folders || []) for (const d of f.docs || []) inFolders.add(d.id);
    return {folders: folders || [], others: (docs || []).filter((d) => !inFolders.has(d.id))};
}

/** The name order of the folder tree: case-insensitive, numbers by value (2 before 10). */
function compareNames(a, b) {
    return a.localeCompare(b, undefined, {numeric: true, sensitivity: 'base'}) || (a < b ? -1 : a > b ? 1 : 0);
}

/** A folder file's own name (the last part of its path). */
export function baseName(d) {
    const path = String(d.folderPath || '');
    return path ? path.slice(path.lastIndexOf('/') + 1) : labelOf(d);
}

/**
 * A folder's documents as a tree of its subfolders, built from their paths
 * (folderPath, "chapters/one.md"): a subfolder with no documents left is not listed.
 * @param {object[]} docs
 * @returns {{name: string, path: string, count: number, dirs: object[], files: object[]}}
 *   each level's dirs before its files, both by name; count is every file under it
 */
export function folderTree(docs) {
    const root = {name: '', path: '', dirs: new Map(), files: []};
    for (const d of docs || []) {
        const parts = String(d.folderPath || '').split('/').filter(Boolean);
        let node = root;
        for (const part of parts.slice(0, -1)) {
            if (!node.dirs.has(part)) node.dirs.set(part, {name: part, path: node.path ? node.path + '/' + part : part, dirs: new Map(), files: []});
            node = node.dirs.get(part);
        }
        node.files.push(d);
    }
    const finish = (n) => {
        const dirs = [...n.dirs.values()].sort((a, b) => compareNames(a.name, b.name)).map(finish);
        const files = n.files.sort((a, b) => compareNames(baseName(a), baseName(b)));
        return {name: n.name, path: n.path, count: files.length + dirs.reduce((t, x) => t + x.count, 0), dirs, files};
    };
    return finish(root);
}

/** The store's order: newest first, then ascending id. */
function compareRecent(a, b) {
    return (b.updatedAt - a.updatedAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** What a search result count sounds like to a screen reader. */
function matchMessage(n, more) {
    if (n === 0) return 'No documents match';
    if (more) return `${n} documents shown, more match`;
    return n === 1 ? '1 document matches' : `${n} documents match`;
}

/** "just now", "5m ago", "3d ago", then a short date. */
export function formatRelTime(ts, now = Date.now()) {
    if (!ts) return '';
    const s = Math.floor((now - ts) / 1000);
    if (s < 5) return 'just now';
    if (s < 60) return s + 's ago';
    const m = Math.floor(s / 60); if (m < 60) return m + 'm ago';
    const h = Math.floor(m / 60); if (h < 24) return h + 'h ago';
    const d = Math.floor(h / 24); if (d < 7) return d + 'd ago';
    return new Date(ts).toLocaleDateString(undefined, {month: 'short', day: 'numeric'});
}

/**
 * @param {{
 *   list: HTMLUListElement, filter: HTMLInputElement|null, more: HTMLButtonElement|null,
 *   editor: HTMLElement, getStore: () => object, currentId: () => (string|null),
 *   openDoc: (id: string) => Promise<any>, removeDoc: (id: string) => Promise<any>,
 *   confirm: (message: string) => boolean, announce?: (message: string) => void,
 *   searchDelayMs?: number, getFolders?: () => object[], closeDoc?: (id: string) => Promise<any>,
 *   closeFolder?: (folderId: string) => Promise<any>, reconnectFolder?: (folderId: string) => Promise<any>,
 * }} deps
 *   getFolders       the open folders and their documents (js/folder-sync.js list())
 *   closeDoc         close one document of a folder (its row's button); it asks if it must
 *   closeFolder      Close all in folder
 *   reconnectFolder  ask again for permission to read a folder (after a reload)
 *   more       the Show more button after the list
 *   getStore   the store in use, read at call time (it is swapped if IndexedDB fails)
 *   removeDoc  delete a document; it reports its own failures
 *   announce   tell screen reader users about a state change (a new page, a search result count)
 * @returns {{render: () => Promise<void>, showMore: () => Promise<void>, setActiveTitle: Function, attach: Function, listed: Function}}
 */
export function createSidebar({list, filter, more = null, editor, getStore, currentId, openDoc, removeDoc, confirm,
    announce = () => {}, searchDelayMs = SEARCH_DELAY_MS, getFolders = () => [], closeDoc = null,
    closeFolder = null, reconnectFolder = null}) {
    // The rows the arrow keys move between: documents and subfolders, not those in a closed folder.
    const ROWS = '.doc-item, .dir-item';
    const items = () => Array.from(list.querySelectorAll(ROWS)).filter((li) => !li.closest('.folder-docs[hidden]'));
    // Opened during this page load only: every folder and subfolder starts closed.
    const openFolders = new Set();     // folder ids
    const expandedDirs = new Set();    // "<folder id>|<path>"
    for (const k of OLD_FOLDER_KEYS) safeRemove(k);
    const dirKey = (folderId, path) => folderId + '|' + path;

    let browseDocs = [];          // list entries (listEntry) shown while the search box is empty
    let browseCursor = null;      // where the next page starts, null on the last page
    let appendCursor = null;      // set by Show more: the next read is one page from here
    let shownDocs = [];           // the entries on screen now (recent documents or matches)
    let searchLimit = PAGE_SIZE;  // matches to list: grows with each Show more
    let lastAnnounced = null;     // the search and count last announced
    let searchTimer = null;
    let inFlight = null;          // the read running now
    let queued = null;            // one more read, after it, for whatever is asked meanwhile

    const queryOf = () => (filter && filter.value || '').trim();

    /** A row's buttons: a document's open and delete buttons, or a subfolder's toggle. */
    const buttonsOf = (li) => li.classList.contains('dir-item')
        ? [li.querySelector(':scope > .dir-toggle')]
        : [li.querySelector('.doc-open'), li.querySelector('.doc-del')];

    /** Make `li` the sidebar's Tab stop (its buttons); the rest get tabIndex -1. */
    function setTabStop(li) {
        for (const item of list.querySelectorAll(ROWS)) {
            for (const b of buttonsOf(item)) if (b) b.tabIndex = item === li ? 0 : -1;
        }
    }

    function focusItem(li) {
        setTabStop(li);
        buttonsOf(li)[0].focus();
    }

    /** Open or close a subfolder row (until the page is reloaded); focus inside a closed one moves to its toggle. */
    function setDirExpanded(li, expanded) {
        const toggle = li.querySelector(':scope > .dir-toggle');
        const sub = li.querySelector(':scope > .folder-docs');
        sub.hidden = !expanded;
        toggle.setAttribute('aria-expanded', String(expanded));
        const key = dirKey(li.dataset.folderId, li.dataset.path);
        if (expanded) expandedDirs.add(key); else expandedDirs.delete(key);
        if (!expanded && sub.contains(document.activeElement)) focusItem(li);
        else if (!list.contains(document.activeElement)) {
            const all = items();
            setTabStop(all.find((x) => x.classList.contains('active')) || all[0] || null);
        }
    }

    /** Right and Left on a row: open a subfolder or step into it; close it or step out to its parent. */
    function onSideKey(e, li) {
        const isDir = li.classList.contains('dir-item');
        const open = isDir && li.querySelector(':scope > .dir-toggle').getAttribute('aria-expanded') === 'true';
        if (e.key === 'ArrowRight') {
            if (!isDir) return false;
            if (!open) setDirExpanded(li, true);
            else {
                const first = li.querySelector(':scope > .folder-docs > li');
                if (first) focusItem(first);
            }
            return true;
        }
        if (open) { setDirExpanded(li, false); return true; }
        const parent = li.parentElement.closest('.dir-item');
        if (parent) { focusItem(parent); return true; }
        const head = li.closest('.folder-group') && li.closest('.folder-group').querySelector('.folder-toggle');
        if (head) { head.focus(); return true; }
        return false;
    }

    /** Up/Down/Home/End between rows, Up from the first back to the filter, Delete asks to delete. */
    function onKeydown(e) {
        // Keys on the delete button are the button's own (Enter and Space delete):
        // they never open or move between documents.
        if (e.target.closest('.doc-del')) return;
        const li = e.target.closest(ROWS);
        if (!li || e.ctrlKey || e.metaKey || e.altKey) return;
        const all = items();
        const i = all.indexOf(li);
        let next = null;
        switch (e.key) {
            case 'ArrowRight':
            case 'ArrowLeft':
                if (onSideKey(e, li)) e.preventDefault();
                return;
            case 'ArrowDown': next = all[i + 1]; break;
            case 'ArrowUp':
                if (i === 0) {
                    e.preventDefault();
                    if (filter) filter.focus();
                    return;
                }
                next = all[i - 1];
                break;
            case 'Home': next = all[0]; break;
            case 'End': next = all[all.length - 1]; break;
            case 'Delete':
                if (li.classList.contains('dir-item')) return;
                e.preventDefault();
                li.querySelector('.doc-del').click();
                return;
            default: return;
        }
        e.preventDefault();
        if (!next) return;
        focusItem(next);
    }

    async function deleteItem(id, label, li) {
        if (!confirm('Delete "' + label + '"? This cannot be undone.')) return;
        const index = items().indexOf(li);
        const hadFocus = list.contains(document.activeElement);
        await removeDoc(id);
        // A refresh re-reads only the first page: drop the entry here too, wherever it is listed.
        browseDocs = browseDocs.filter((d) => d.id !== id);
        await render();
        if (!hadFocus) return;
        // Keep keyboard focus in the list: the item now in the deleted one's place, else the filter.
        const all = items();
        const next = all[Math.min(index, all.length - 1)];
        if (next) focusItem(next);
        else if (filter) filter.focus();
    }

    async function closeItem(id, li) {
        const index = items().indexOf(li);
        const hadFocus = list.contains(document.activeElement);
        await closeDoc(id);
        browseDocs = browseDocs.filter((d) => d.id !== id);
        await render();
        if (!hadFocus) return;
        const all = items();
        const next = all[Math.min(index, all.length - 1)];
        if (next) focusItem(next);
        else if (filter) filter.focus();
    }

    /** A document's row; `name` is what it is listed as (in the folder tree, its file name). */
    function buildItem(d, name = null) {
        const label = labelOf(d);
        const inFolder = !!(d.folderId && closeDoc);
        const current = d.id === currentId();
        const li = document.createElement('li');
        li.className = 'doc-item' + (current ? ' active' : '');
        li.dataset.id = d.id;
        li.dataset.origin = d.origin || 'local';
        const open = document.createElement('button');
        open.type = 'button';
        open.className = 'doc-open';
        if (current) open.setAttribute('aria-current', 'true');
        const title = document.createElement('span'); title.className = 'doc-title';
        title.textContent = name || (d.folderPath && d.folderPath.includes('/') ? d.folderPath : label);
        const sep = document.createElement('span'); sep.className = 'visually-hidden'; sep.textContent = ', ';
        const time = document.createElement('span'); time.className = 'doc-time'; time.textContent = formatRelTime(d.lastOpenedAt || d.updatedAt);
        open.append(title, sep, time);
        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'doc-del';
        del.title = inFolder ? 'Close' : 'Delete';
        del.setAttribute('aria-label', (inFolder ? 'Close ' : 'Delete ') + label);
        // A drawn cross: there is no room for a word in the row, and an SVG keeps the button's name its aria-label.
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('aria-hidden', 'true');
        svg.setAttribute('focusable', 'false');
        svg.setAttribute('width', '10');
        svg.setAttribute('height', '10');
        svg.setAttribute('viewBox', '0 0 10 10');
        const cross = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        cross.setAttribute('d', 'M1.5 1.5l7 7M8.5 1.5l-7 7');
        cross.setAttribute('fill', 'none');
        cross.setAttribute('stroke', 'currentColor');
        cross.setAttribute('stroke-width', '1.6');
        cross.setAttribute('stroke-linecap', 'round');
        svg.append(cross);
        del.append(svg);
        del.addEventListener('click', (e) => {
            e.stopPropagation();
            if (inFolder) closeItem(d.id, li); else deleteItem(d.id, label, li);
        });
        li.append(open, del);
        // A click anywhere on the row opens it; Enter and Space reach here as a click on the open button.
        li.addEventListener('click', async () => { await openDoc(d.id); });
        return li;
    }

    /**
     * The recent documents. Show more reads one page after the cursor and adds it.
     * A refresh reads the first page only, however many pages are listed: the
     * pages after it keep their entries (anything newer is in the first page,
     * and saving a document moves it there), so a long list costs no more to
     * refresh than a short one.
     */
    async function readRecent() {
        const store = getStore();
        if (appendCursor) {
            const cursor = appendCursor;
            appendCursor = null;
            const page = await store.listPage({limit: PAGE_SIZE, cursor});
            const seen = new Set(browseDocs.map((d) => d.id));
            return {docs: browseDocs.concat(page.docs.filter((d) => !seen.has(d.id)).map(listEntry)), next: page.nextCursor};
        }
        const page = await store.listPage({limit: PAGE_SIZE});
        const head = page.docs.map(listEntry);
        if (page.nextCursor == null || browseDocs.length <= PAGE_SIZE) return {docs: head, next: page.nextCursor};
        const ids = new Set(head.map((d) => d.id));
        const last = head[head.length - 1];
        const rest = browseDocs.filter((d) => !ids.has(d.id) && compareRecent(last, d) < 0);
        return {docs: head.concat(rest), next: browseCursor};
    }

    /**
     * Folder files are listed in their sections, not with the other documents, and a
     * folder just opened makes them the newest. Read on until a page of other
     * documents is listed (or none are left), so a big folder cannot leave the
     * "Other documents" empty and Show more seemingly doing nothing.
     */
    async function topUp(result, othersBefore) {
        const inFolders = new Set();
        for (const f of getFolders() || []) for (const d of f.docs || []) inFolders.add(d.id);
        if (!inFolders.size) return result;
        let {docs, next} = result;
        const others = () => docs.filter((d) => !inFolders.has(d.id)).length;
        for (let i = 0; i < 40 && next != null && others() < othersBefore + PAGE_SIZE; i++) {
            const page = await getStore().listPage({limit: PAGE_SIZE, cursor: next});
            const seen = new Set(docs.map((d) => d.id));
            docs = docs.concat(page.docs.filter((d) => !seen.has(d.id)).map(listEntry));
            next = page.nextCursor;
        }
        return {docs, next};
    }

    /** How many listed documents are not in a folder section. */
    function othersListed() {
        const inFolders = new Set();
        for (const f of getFolders() || []) for (const d of f.docs || []) inFolders.add(d.id);
        return browseDocs.filter((d) => !inFolders.has(d.id)).length;
    }

    /**
     * Documents whose title contains `q` (every stored document), plus listed
     * documents whose file name does: the list shows a file's name, not its title.
     */
    async function readMatches(q) {
        const found = await getStore().searchTitles(q, searchLimit + 1);
        const key = searchKey(q);
        const ids = new Set(found.map((d) => d.id));
        const byName = browseDocs.filter((d) => !ids.has(d.id) && d.fileName && searchKey(d.fileName).includes(key));
        const docs = found.map(listEntry).concat(byName).sort(compareRecent);
        return {docs: docs.slice(0, searchLimit), more: docs.length > searchLimit};
    }

    /** One read and repaint. The list is left as it is when the read fails or the text has changed since. */
    async function refresh() {
        clearTimeout(searchTimer);    // this read uses the text as it is now
        searchTimer = null;
        const q = queryOf();
        let docs, hasMore;
        // A slow search (a database whose title index is still being repaired reads
        // every record) says so, instead of leaving the last query's results up.
        const searching = q ? setTimeout(() => { if (queryOf() === q) showSearching(); }, SEARCHING_DELAY_MS) : null;
        try {
            if (q) {
                try {
                    ({docs, more: hasMore} = await readMatches(q));
                } finally {
                    clearTimeout(searching);
                }
            } else {
                const appending = !!appendCursor;
                const recent = await topUp(await readRecent(), appending ? othersListed() : 0);
                docs = recent.docs;
                hasMore = recent.next != null;
                browseDocs = docs;
                browseCursor = recent.next;
            }
        } catch (_e) {
            return;
        }
        if (queryOf() !== q) return;  // stale: the read for the new text comes next
        shownDocs = docs;
        draw(docs, q);
        if (more) more.hidden = !hasMore;
        if (q) {
            const message = matchMessage(docs.length, hasMore);
            const said = searchKey(q) + '\n' + message;
            if (said !== lastAnnounced) announce(message);
            lastAnnounced = said;
        }
    }

    /** The list while a search runs: one "Searching..." line, read out once. */
    function showSearching() {
        if (list.contains(document.activeElement) && filter) filter.focus();
        list.innerHTML = '';
        const li = document.createElement('li');
        li.className = 'doc-searching';
        li.style.cssText = 'color: var(--text-muted); padding: 10px; font-size: 12px;';
        li.textContent = 'Searching...';
        list.appendChild(li);
        shownDocs = [];
        if (more) more.hidden = true;
        announce('Searching...');
        lastAnnounced = null;   // the count that follows is news again
    }

    /**
     * Read the store and rebuild the list, keeping keyboard focus where it was.
     * One read runs at a time; calls made meanwhile share one more read after it.
     */
    function render() {
        if (!inFlight) {
            inFlight = refresh().finally(() => { inFlight = null; });
            return inFlight;
        }
        if (!queued) {
            const next = () => { queued = null; return render(); };
            queued = inFlight.then(next, next);
        }
        return queued;
    }

    /** Show more: the next page of recent documents, or more matches. Focus goes to the first new item. */
    async function showMore() {
        const before = items().length;
        const searching = !!queryOf();
        if (searching) searchLimit += PAGE_SIZE;
        else if (browseCursor) appendCursor = browseCursor;
        else return;
        await render();
        const all = items();
        if (all.length > before) focusItem(all[before]);
        if (!searching) announce(more && more.hidden ? `Showing all ${all.length} documents` : `Showing ${all.length} documents`);
    }

    function setFolderOpen(folderId, open) {
        if (open) openFolders.add(folderId); else openFolders.delete(folderId);
    }

    /** A level of a folder's tree into `ul`: its subfolders, then its files. */
    function buildTree(node, ul, folderId, depth) {
        for (const dir of node.dirs) ul.appendChild(buildDir(dir, folderId, depth));
        for (const d of node.files) {
            const li = buildItem(d, baseName(d));
            li.style.setProperty('--depth', String(depth));
            ul.appendChild(li);
        }
    }

    /** A subfolder row: a toggle (closed at first) and its own files and subfolders under it. */
    function buildDir(dir, folderId, depth) {
        const expanded = expandedDirs.has(dirKey(folderId, dir.path));
        const li = document.createElement('li');
        li.className = 'dir-item';
        li.dataset.folderId = folderId;
        li.dataset.path = dir.path;
        li.style.setProperty('--depth', String(depth));
        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'dir-toggle';
        toggle.setAttribute('aria-expanded', String(expanded));
        toggle.title = dir.path;
        const icon = document.createElement('span'); icon.className = 'dir-icon'; icon.setAttribute('aria-hidden', 'true');
        const name = document.createElement('span'); name.className = 'dir-name'; name.textContent = dir.name;
        const count = document.createElement('span'); count.className = 'folder-count';
        count.textContent = String(dir.count);
        count.setAttribute('aria-label', dir.count === 1 ? '1 file' : dir.count + ' files');
        toggle.append(icon, name, count);
        toggle.addEventListener('click', (e) => {
            e.stopPropagation();
            setDirExpanded(li, toggle.getAttribute('aria-expanded') !== 'true');
        });
        const sub = document.createElement('ul');
        sub.className = 'folder-docs';
        sub.setAttribute('aria-label', dir.name);
        sub.hidden = !expanded;
        buildTree(dir, sub, folderId, depth + 1);
        li.append(toggle, sub);
        return li;
    }

    /** One section: a heading row (for a folder: collapse, Reconnect, Close all) and its documents. */
    function buildGroup(f) {
        const isFolder = !!f.id;
        const group = document.createElement('li');
        group.className = 'folder-group' + (isFolder ? '' : ' folder-group-other');
        if (isFolder) group.dataset.folderId = f.id;
        const head = document.createElement('div');
        head.className = 'folder-head';
        const docsList = document.createElement('ul');
        docsList.className = 'folder-docs';
        docsList.setAttribute('aria-label', f.name);
        if (isFolder) buildTree(folderTree(f.docs), docsList, f.id, 0);
        else for (const d of f.docs) docsList.appendChild(buildItem(d));
        if (isFolder) {
            const collapsed = !openFolders.has(f.id);
            docsList.hidden = collapsed;
            const toggle = document.createElement('button');
            toggle.type = 'button';
            toggle.className = 'folder-toggle';
            toggle.setAttribute('aria-expanded', String(!collapsed));
            toggle.title = 'Show or hide the files in this folder';
            const name = document.createElement('span'); name.className = 'folder-name'; name.textContent = f.name;
            const count = document.createElement('span'); count.className = 'folder-count';
            count.textContent = String(f.docs.length);
            count.setAttribute('aria-label', f.docs.length === 1 ? '1 file' : f.docs.length + ' files');
            // A default folder waiting for access has not been read yet: no count.
            count.hidden = !f.docs.length && f.status === 'needs-permission';
            toggle.append(name, count);
            const setOpen = (open) => {
                docsList.hidden = !open;
                toggle.setAttribute('aria-expanded', String(open));
                setFolderOpen(f.id, open);
                if (!open && docsList.contains(document.activeElement)) toggle.focus();
                const all = items();
                setTabStop(all.find((li) => li.classList.contains('active')) || all[0] || null);
            };
            toggle.addEventListener('click', () => setOpen(docsList.hidden));
            // Right opens the folder (or steps to its first row), Left closes it.
            toggle.addEventListener('keydown', (e) => {
                if (e.ctrlKey || e.metaKey || e.altKey) return;
                if (e.key === 'ArrowRight') {
                    e.preventDefault();
                    if (docsList.hidden) setOpen(true);
                    else if (docsList.firstElementChild) focusItem(docsList.firstElementChild);
                } else if (e.key === 'ArrowLeft' && !docsList.hidden) {
                    e.preventDefault();
                    setOpen(false);
                }
            });
            head.appendChild(toggle);
            if (f.status === 'needs-permission' && reconnectFolder) {
                const again = document.createElement('button');
                again.type = 'button';
                again.className = 'btn-mini folder-reconnect';
                again.textContent = 'Reconnect';
                again.title = 'Allow PrintMD to read this folder again, to keep it up to date';
                again.setAttribute('aria-label', 'Reconnect ' + f.name);
                again.addEventListener('click', async () => { await reconnectFolder(f.id); await render(); });
                head.appendChild(again);
            } else if (f.status === 'lost') {
                const lost = document.createElement('span');
                lost.className = 'folder-status';
                lost.textContent = 'not watched';
                lost.title = 'The folder was moved or permission was lost';
                head.appendChild(lost);
            }
            if (closeFolder) {
                const close = document.createElement('button');
                close.type = 'button';
                close.className = 'btn-mini folder-close';
                close.textContent = 'Close all';
                close.title = 'Close every file in this folder and stop watching it';
                close.setAttribute('aria-label', 'Close all in ' + f.name);
                close.addEventListener('click', async () => {
                    const hadFocus = list.contains(document.activeElement);
                    await closeFolder(f.id);
                    await render();
                    if (hadFocus) {
                        const first = items()[0];
                        if (first) focusItem(first); else if (filter) filter.focus();
                    }
                });
                head.appendChild(close);
            }
        } else {
            const name = document.createElement('span'); name.className = 'folder-name'; name.textContent = f.name;
            head.appendChild(name);
        }
        group.append(head, docsList);
        return group;
    }

    function draw(docs, q) {
        // Rebuilding the list would drop keyboard focus: note where it was.
        const focused = list.contains(document.activeElement) ? document.activeElement : null;
        const focusedId = focused && focused.closest('.doc-item') ? focused.closest('.doc-item').dataset.id : null;
        const focusedDel = !!(focused && focused.classList.contains('doc-del'));
        const dirRow = focused && !focusedId && focused.classList.contains('dir-toggle') ? focused.closest('.dir-item') : null;
        const focusedDir = dirRow ? {folderId: dirRow.dataset.folderId, path: dirRow.dataset.path} : null;
        const focusedFolder = focused && !focusedId && !focusedDir && focused.closest('.folder-group')
            ? {id: focused.closest('.folder-group').dataset.folderId, cls: focused.className.split(' ').find((c) => c.startsWith('folder-'))}
            : null;
        list.innerHTML = '';
        const folders = q ? [] : (getFolders() || []);
        if (folders.length) {
            const grouped = groupDocs(folders, docs);
            for (const f of grouped.folders) list.appendChild(buildGroup(f));
            if (grouped.others.length) list.appendChild(buildGroup({name: 'Other documents', docs: grouped.others}));
        } else {
            for (const d of docs) list.appendChild(buildItem(d));
        }
        if (docs.length === 0 && q) {
            const empty = document.createElement('li');
            empty.style.cssText = 'color: var(--text-muted); padding: 10px; font-size: 12px;';
            empty.textContent = 'No files match';
            list.appendChild(empty);
        }
        const all = items();
        const keep = (focusedId && all.find((li) => li.dataset.id === focusedId))
            || (focusedDir && all.find((li) => li.classList.contains('dir-item') && li.dataset.folderId === focusedDir.folderId && li.dataset.path === focusedDir.path));
        const stop = keep || all.find((li) => li.classList.contains('active')) || all[0] || null;
        setTabStop(stop);
        const keepHead = focusedFolder && focusedFolder.id && focusedFolder.cls
            ? list.querySelector(`.folder-group[data-folder-id="${CSS.escape(focusedFolder.id)}"] .${focusedFolder.cls}`)
            : null;
        if (keep) buttonsOf(keep)[focusedDel ? 1 : 0].focus();
        else if (keepHead) keepHead.focus();
        else if (focused && stop) buttonsOf(stop)[0].focus();
        // Scroll the active item into view without disrupting list scroll position
        const activeEl = all.find((li) => li.classList.contains('active'));
        if (activeEl) activeEl.scrollIntoView({block: 'nearest'});
    }

    /** The open document's title changed (a save): update its row in place. */
    function setActiveTitle(title) {
        const el = list.querySelector('.doc-item.active .doc-title');
        if (el) el.textContent = title;
    }

    /** Attach the list's and the filter's listeners. */
    function attach() {
        if (filter) {
            // A new search starts from one page. Typing waits for a pause; clearing shows the list at once.
            filter.addEventListener('input', () => {
                clearTimeout(searchTimer);
                searchLimit = PAGE_SIZE;
                if (!queryOf()) {
                    lastAnnounced = null;
                    render();
                    return;
                }
                searchTimer = setTimeout(() => { searchTimer = null; render(); }, searchDelayMs);
            });
            filter.addEventListener('keydown', (e) => {
                if (e.key === 'Escape') {
                    filter.value = '';
                    clearTimeout(searchTimer);
                    searchLimit = PAGE_SIZE;
                    lastAnnounced = null;
                    render();
                    editor.focus();
                }
                if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    const first = items()[0];
                    if (first) focusItem(first);
                }
            });
        }
        if (more) more.addEventListener('click', () => { showMore(); });
        list.addEventListener('keydown', onKeydown);
        // Focus that lands on an item another way (a click, a script) moves the Tab stop there too.
        list.addEventListener('focusin', (e) => {
            const li = e.target.closest(ROWS);
            if (li && e.target.tabIndex < 0 && !e.target.classList.contains('folder-toggle')) setTabStop(li);
        });
    }

    /**
     * Copies of the entries the sidebar holds: the recent documents it has listed,
     * or with {shown: true} what is on screen now (the matches during a search).
     */
    function listed({shown = false} = {}) {
        return (shown ? shownDocs : browseDocs).map((d) => ({...d}));
    }

    return {render, showMore, setActiveTitle, attach, listed};
}

/** The sidebar's collapse toggle, remembered in localStorage. */
export function initSidebarCollapse({sidebar, toggle}) {
    const setCollapsed = (c) => {
        sidebar.classList.toggle('collapsed', c);
        toggle.setAttribute('aria-expanded', String(!c));
    };
    setCollapsed(safeGet(SIDEBAR_KEY) === '1');
    toggle.addEventListener('click', () => {
        const c = !sidebar.classList.contains('collapsed');
        setCollapsed(c);
        safeSet(SIDEBAR_KEY, c ? '1' : '0');
    });
}
