/**
 * js/sidebar.js
 *
 * The Recent files sidebar: the list of documents a page at a time (Show more),
 * the title search box, deleting a document, the keyboard behaviour and the
 * collapse toggle.
 *
 * The list is one Tab stop: only the "roving" item's two buttons (open and
 * delete) are in the Tab order, and Up/Down/Home/End move between items.
 *
 * Paging reads the store's listPage({limit, cursor}); the search reads its
 * searchTitles(query, limit), which covers every stored document. A search can
 * read every record on a database whose title index is still being repaired,
 * so typing waits for a pause, only one read runs at a time, and a result for
 * text that has since changed is dropped instead of shown.
 */
import {safeGet, safeSet} from './safe-storage.js';

const SIDEBAR_KEY = 'printmd-sidebar-collapsed';
const PAGE_SIZE = 50;
const SEARCH_DELAY_MS = 200;
const SEARCHING_DELAY_MS = 150;   // a search slower than this shows "Searching…"

/** What a document is called in the list: its file name, else its title. */
function labelOf(d) {
    return d.fileName || d.title || 'Untitled';
}

/** The key the store's title search compares (js/store.js titleKey). */
function searchKey(text) {
    return String(text == null ? '' : text).normalize('NFC').toLowerCase().trim();
}

/** What the list keeps of a document: enough for its row and the search, never its text. */
const LIST_FIELDS = ['id', 'title', 'fileName', 'updatedAt', 'lastOpenedAt', 'origin'];

export function listEntry(doc) {
    const entry = {};
    for (const key of LIST_FIELDS) if (doc[key] !== undefined) entry[key] = doc[key];
    return entry;
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
 *   searchDelayMs?: number,
 * }} deps
 *   more       the Show more button after the list
 *   getStore   the store in use, read at call time (it is swapped if IndexedDB fails)
 *   removeDoc  delete a document; it reports its own failures
 *   announce   tell screen reader users about a state change (a new page, a search result count)
 * @returns {{render: () => Promise<void>, showMore: () => Promise<void>, setActiveTitle: Function, attach: Function, listed: Function}}
 */
export function createSidebar({list, filter, more = null, editor, getStore, currentId, openDoc, removeDoc, confirm,
    announce = () => {}, searchDelayMs = SEARCH_DELAY_MS}) {
    const items = () => Array.from(list.querySelectorAll('.doc-item'));

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

    /** Make `li` the sidebar's Tab stop (its open and delete buttons); the rest get tabIndex -1. */
    function setTabStop(li) {
        for (const item of items()) {
            const on = item === li;
            item.querySelector('.doc-open').tabIndex = on ? 0 : -1;
            item.querySelector('.doc-del').tabIndex = on ? 0 : -1;
        }
    }

    function focusItem(li) {
        setTabStop(li);
        li.querySelector('.doc-open').focus();
    }

    /** Up/Down/Home/End between items, Up from the first back to the filter, Delete asks to delete. */
    function onKeydown(e) {
        // Keys on the delete button are the button's own (Enter and Space delete):
        // they never open or move between documents.
        if (e.target.closest('.doc-del')) return;
        const li = e.target.closest('.doc-item');
        if (!li || e.ctrlKey || e.metaKey || e.altKey) return;
        const all = items();
        const i = all.indexOf(li);
        let next = null;
        switch (e.key) {
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

    function buildItem(d) {
        const label = labelOf(d);
        const current = d.id === currentId();
        const li = document.createElement('li');
        li.className = 'doc-item' + (current ? ' active' : '');
        li.dataset.id = d.id;
        li.dataset.origin = d.origin || 'local';
        const open = document.createElement('button');
        open.type = 'button';
        open.className = 'doc-open';
        if (current) open.setAttribute('aria-current', 'true');
        const title = document.createElement('span'); title.className = 'doc-title'; title.textContent = label;
        const sep = document.createElement('span'); sep.className = 'visually-hidden'; sep.textContent = ', ';
        const time = document.createElement('span'); time.className = 'doc-time'; time.textContent = formatRelTime(d.lastOpenedAt || d.updatedAt);
        open.append(title, sep, time);
        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'doc-del';
        del.title = 'Delete';
        del.setAttribute('aria-label', 'Delete ' + label);
        del.textContent = '×';
        del.addEventListener('click', (e) => {
            e.stopPropagation();
            deleteItem(d.id, label, li);
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
                const recent = await readRecent();
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

    /** The list while a search runs: one "Searching…" line, read out once. */
    function showSearching() {
        if (list.contains(document.activeElement) && filter) filter.focus();
        list.innerHTML = '';
        const li = document.createElement('li');
        li.className = 'doc-searching';
        li.style.cssText = 'color: var(--text-muted); padding: 10px; font-size: 12px;';
        li.textContent = 'Searching…';
        list.appendChild(li);
        shownDocs = [];
        if (more) more.hidden = true;
        announce('Searching…');
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

    function draw(docs, q) {
        // Rebuilding the list would drop keyboard focus: note where it was.
        const focused = list.contains(document.activeElement) ? document.activeElement : null;
        const focusedId = focused && focused.closest('.doc-item') ? focused.closest('.doc-item').dataset.id : null;
        const focusedDel = !!(focused && focused.classList.contains('doc-del'));
        list.innerHTML = '';
        for (const d of docs) list.appendChild(buildItem(d));
        if (docs.length === 0 && q) {
            const empty = document.createElement('li');
            empty.style.cssText = 'color: var(--text-muted); padding: 10px; font-size: 12px;';
            empty.textContent = 'No files match';
            list.appendChild(empty);
        }
        const all = items();
        const keep = focusedId && all.find((li) => li.dataset.id === focusedId);
        const stop = keep || list.querySelector('.doc-item.active') || all[0] || null;
        setTabStop(stop);
        if (keep) keep.querySelector(focusedDel ? '.doc-del' : '.doc-open').focus();
        else if (focused && stop) stop.querySelector('.doc-open').focus();
        // Scroll the active item into view without disrupting list scroll position
        const activeEl = list.querySelector('.doc-item.active');
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
                    const first = list.querySelector('.doc-item');
                    if (first) focusItem(first);
                }
            });
        }
        if (more) more.addEventListener('click', () => { showMore(); });
        list.addEventListener('keydown', onKeydown);
        // Focus that lands on an item another way (a click, a script) moves the Tab stop there too.
        list.addEventListener('focusin', (e) => {
            const li = e.target.closest('.doc-item');
            if (li && e.target.tabIndex < 0) setTabStop(li);
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
