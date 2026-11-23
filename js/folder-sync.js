/**
 * js/folder-sync.js
 *
 * Open a whole folder of Markdown files and keep the stored copies in step with
 * it: a file added to the folder is added, a file edited on disk is reloaded, and
 * a file removed from the folder is closed.
 *
 * Rules:
 *  - The folder is read with the File System Access API (showDirectoryPicker).
 *    Files ending in .md or .markdown are read, in the folder and its subfolders
 *    (up to MAX_DEPTH levels and MAX_FILES files); hidden folders and
 *    node_modules are skipped.
 *  - Each file is one stored doc, carrying folderId, folderName, folderPath and
 *    the folder's handle, so the folder comes back after a reload. Nothing else
 *    is stored: the store keeps its schema.
 *  - A poll compares each file's lastModified with the last one seen and reads
 *    the text of changed files only. One poll runs at a time.
 *  - The open doc is left to js/disk-sync.js, which already watches it and asks
 *    when it has unsaved edits. A doc that is not open is updated only when it
 *    has no unsaved edits; otherwise it is left alone and the open-time check asks.
 *  - A removed file closes its doc when it has no unsaved edits; otherwise the
 *    doc is kept and the user is told.
 *  - After a reload the browser asks again for permission to read the folder.
 *    That needs a click, so the folder waits ("needs-permission") until
 *    reconnect() is called from one, instead of failing on every poll.
 *  - Closing one file of a folder hides it (remembered in localStorage), so the
 *    next poll does not bring it back. Opening the folder again shows it again.
 *  - Default folders (js/folder-defaults.js) come back through restore(): one
 *    already listed is left as it is, one the browser still allows is read and
 *    listed, and one that needs access again is listed with no files yet
 *    ("needs-permission") until reconnect() reads it. snapshot() gives the
 *    folders open now, with their handles, to save as the defaults.
 *
 * No direct DOM access: the picker, timers, store and doc manager are injected.
 */
import {safeGet, safeSet, safeRemove} from './safe-storage.js';

export const MAX_DEPTH = 4;
export const MAX_FILES = 500;
const HIDDEN_KEY = 'printmd-folder-hidden';
/** Set once a folder has been opened, so a startup without folders never reads every stored doc. */
export const FOLDERS_KEY = 'printmd-folders';
const SKIP_DIRS = new Set(['node_modules']);

/** True for the file names a folder open reads. */
export function isMarkdownName(name) {
    return /\.(md|markdown)$/i.test(String(name || '')) && !String(name).startsWith('.');
}

/**
 * What changed between the files last seen and the files on disk now.
 * @param {Map<string, number>} known    path -> lastModified last seen
 * @param {Map<string, number>} scanned  path -> lastModified on disk now
 * @returns {{added: string[], changed: string[], removed: string[]}} each sorted
 */
export function diffFolder(known, scanned) {
    const added = [];
    const changed = [];
    const removed = [];
    for (const [path, lm] of scanned) {
        if (!known.has(path)) added.push(path);
        else if (known.get(path) !== lm) changed.push(path);
    }
    for (const path of known.keys()) if (!scanned.has(path)) removed.push(path);
    return {added: added.sort(), changed: changed.sort(), removed: removed.sort()};
}

/** Sort key for paths: files in a folder before its subfolders, then by name, ignoring case. */
export function comparePaths(a, b) {
    const da = a.split('/').length;
    const db = b.split('/').length;
    if (da !== db) return da - db;
    const la = a.toLowerCase();
    const lb = b.toLowerCase();
    return la < lb ? -1 : la > lb ? 1 : 0;
}

/**
 * Every Markdown file in a directory handle, as path -> {handle, lastModified}.
 * Paths use "/" and are relative to the folder. The map's `truncated` is true when
 * the file or depth limit left something out.
 */
export async function scanDirectory(dir, {maxDepth = MAX_DEPTH, maxFiles = MAX_FILES} = {}) {
    const out = new Map();
    out.truncated = false;
    async function walk(handle, prefix, depth) {
        for await (const entry of handle.values()) {
            if (out.size >= maxFiles) { out.truncated = true; return; }
            const name = entry.name;
            if (entry.kind === 'directory') {
                if (name.startsWith('.') || SKIP_DIRS.has(name)) continue;
                if (depth < maxDepth) await walk(entry, prefix + name + '/', depth + 1);
                else out.truncated = true;
            } else if (entry.kind === 'file' && isMarkdownName(name)) {
                const file = await entry.getFile();
                out.set(prefix + name, {handle: entry, lastModified: file.lastModified, file});
            }
        }
    }
    await walk(dir, '', 0);
    return out;
}

/** The paths hidden in each folder (closed one at a time), from localStorage. */
function readHidden() {
    try {
        const v = JSON.parse(safeGet(HIDDEN_KEY) || '{}');
        return v && typeof v === 'object' ? v : {};
    } catch (_e) {
        return {};
    }
}

function writeHidden(all) {
    safeSet(HIDDEN_KEY, JSON.stringify(all));
}

/** The sidebar's folder order: by name, then by id (two folders with one name keep a fixed order). */
function byName(a, b) {
    return a.name.localeCompare(b.name) || (a.id < b.id ? -1 : 1);
}

function newFolderId() {
    return 'folder-' + (crypto.randomUUID ? crypto.randomUUID() : Date.now() + '-' + Math.round(Math.random() * 1e9));
}

/**
 * @param {object} opts
 * @param {() => object} opts.getDocManager     the doc manager in use (read at call time)
 * @param {() => object} opts.getStore          the store in use (read at call time)
 * @param {(id: string) => Promise<any>} [opts.openDoc]   open a doc in the editor
 * @param {() => Promise<any>} [opts.checkOpenDoc]        the open doc's own disk check (disk-sync)
 * @param {(message: string, kind?: string) => void} [opts.notify]
 * @param {() => void} [opts.onChanged]         the folder list or a stored doc changed
 * @param {Function|null} [opts.showDirectoryPicker]  defaults to window's, null = unsupported
 * @param {number} [opts.intervalMs]
 * @param {{setInterval: Function, clearInterval: Function}} [opts.timers]
 */
export function createFolderSync(opts) {
    const {getDocManager, getStore} = opts;
    const openDoc = opts.openDoc || (async () => {});
    const checkOpenDoc = opts.checkOpenDoc || (async () => {});
    const notify = opts.notify || (() => {});
    const onChanged = opts.onChanged || (() => {});
    // The window's picker is looked up when it is used, not when this is created.
    const win = typeof window !== 'undefined' ? window : {};
    const pickerOf = () => (Object.prototype.hasOwnProperty.call(opts, 'showDirectoryPicker')
        ? opts.showDirectoryPicker
        : (win.showDirectoryPicker ? win.showDirectoryPicker.bind(win) : null));
    const intervalMs = opts.intervalMs || 2000;
    const timers = opts.timers || {setInterval: (f, ms) => setInterval(f, ms), clearInterval: (t) => clearInterval(t)};

    /** folderId -> {id, name, handle, status, files: Map<path, {id, lastModified, title, fileName, updatedAt}>} */
    const folders = new Map();
    let timer = null;
    let busy = null;

    function exclusive(task) {
        const run = Promise.resolve().then(task);
        busy = run;
        const clear = () => { if (busy === run) busy = null; };
        run.then(clear, clear);
        return run;
    }

    function hiddenPaths(folderId) {
        return new Set(readHidden()[folderId] || []);
    }

    function setHidden(folderId, paths) {
        const all = readHidden();
        if (paths && paths.size) all[folderId] = [...paths]; else delete all[folderId];
        writeHidden(all);
    }

    function fileEntry(doc) {
        return {id: doc.id, lastModified: doc.lastModified, title: doc.title, fileName: doc.fileName,
            updatedAt: doc.updatedAt, lastOpenedAt: doc.lastOpenedAt};
    }

    async function permissionOf(handle, ask) {
        if (!handle) return 'lost';
        try {
            if (ask && handle.requestPermission) return await handle.requestPermission({mode: 'read'});
            if (handle.queryPermission) return await handle.queryPermission({mode: 'read'});
            return 'granted';
        } catch (_e) {
            return 'prompt';
        }
    }

    /** Rebuild the folder list from the store (at startup, or after the store was swapped). */
    async function load() {
        folders.clear();
        if (safeGet(FOLDERS_KEY) !== '1') return 0;
        const docs = await getStore().listRecent(Infinity);
        for (const d of docs) {
            if (!d.folderId || !d.folderPath) continue;
            let f = folders.get(d.folderId);
            if (!f) {
                f = {id: d.folderId, name: d.folderName || 'Folder', handle: d.folderHandle || null, status: 'unknown', files: new Map()};
                folders.set(d.folderId, f);
            }
            if (!f.handle && d.folderHandle) f.handle = d.folderHandle;
            f.files.set(d.folderPath, fileEntry(d));
        }
        for (const f of folders.values()) {
            const p = await permissionOf(f.handle, false);
            f.status = p === 'granted' ? 'ok' : (f.handle ? 'needs-permission' : 'lost');
        }
        if (!folders.size) safeRemove(FOLDERS_KEY);
        onChanged();
        if (folders.size) start();
        return folders.size;
    }

    function stop() {
        if (timer != null) { timers.clearInterval(timer); timer = null; }
    }

    function start() {
        stop();
        if (!folders.size) return;
        timer = timers.setInterval(() => { checkAll(); }, intervalMs);
    }

    /** Store the files a scan found that are not listed yet; returns the new records. */
    async function addFiles(f, paths, scanned) {
        const items = [];
        for (const path of paths) {
            const s = scanned.get(path);
            const text = await (s.file || await s.handle.getFile()).text();
            items.push({
                handle: s.handle, text, lastModified: s.lastModified, fileName: s.handle.name,
                extra: {folderId: f.id, folderName: f.name, folderPath: path, folderHandle: f.handle},
            });
        }
        const docs = await getDocManager().addDiskDocs(items);
        docs.forEach((d, i) => f.files.set(paths[i], fileEntry(d)));
        if (docs.length) safeSet(FOLDERS_KEY, '1');
        return docs;
    }

    /**
     * Bring one folder in step with the disk.
     * @returns {Promise<{added: number, changed: number, removed: number, kept: number}>}
     */
    async function syncFolder(f) {
        const counts = {added: 0, changed: 0, removed: 0, kept: 0};
        let scanned;
        try {
            scanned = await scanDirectory(f.handle);
        } catch (_e) {
            f.status = 'lost';
            notify('Stopped watching the folder ' + f.name + ': it was moved or permission was lost', 'error');
            onChanged();
            return counts;
        }
        if (!folders.has(f.id)) return counts;   // closed while scanning
        const hidden = hiddenPaths(f.id);
        for (const path of hidden) scanned.delete(path);
        const known = new Map([...f.files].map(([p, e]) => [p, e.lastModified]));
        const diff = diffFolder(known, scanned);
        const dm = getDocManager();

        if (diff.added.length) counts.added = (await addFiles(f, diff.added, scanned)).length;

        for (const path of diff.changed) {
            const entry = f.files.get(path);
            const s = scanned.get(path);
            if (entry.id === dm.currentId) {
                entry.lastModified = s.lastModified;
                await checkOpenDoc();
                continue;
            }
            const text = await (s.file || await s.handle.getFile()).text();
            const r = await dm.updateDiskDoc(entry.id, text, s.lastModified);
            entry.lastModified = s.lastModified;
            if (r === 'updated') { counts.changed++; entry.updatedAt = Date.now(); }
            else if (r === 'current') await checkOpenDoc();
            else if (r === 'gone') f.files.delete(path);
        }

        const toClose = [];
        for (const path of diff.removed) {
            const entry = f.files.get(path);
            const doc = await getStore().getDoc(entry.id);
            if (doc && dm.hasUnsavedWork(doc)) {
                counts.kept++;
                notify(path + ' was removed from ' + f.name + '. Your unsaved copy is kept.', 'error');
                f.files.delete(path);   // no longer part of the folder: listed with the other docs
                continue;
            }
            toClose.push(entry.id);
            f.files.delete(path);
        }
        if (toClose.length) {
            await dm.removeDocs(toClose);
            counts.removed = toClose.length;
        }
        if (counts.added || counts.changed || counts.removed || counts.kept) onChanged();
        return counts;
    }

    /** One poll over every folder that can be read. */
    function checkAll() {
        if (busy) return Promise.resolve('busy');
        return exclusive(async () => {
            for (const f of [...folders.values()]) {
                if (f.status !== 'ok') continue;
                await syncFolder(f);
            }
            return 'done';
        });
    }

    /** Find a folder already open for this directory handle. */
    async function findOpen(handle) {
        for (const f of folders.values()) {
            if (!f.handle || !f.handle.isSameEntry) continue;
            try { if (await f.handle.isSameEntry(handle)) return f; } catch (_e) { /* not comparable */ }
        }
        return null;
    }

    /**
     * Pick a folder and open it: every Markdown file in it becomes a doc, the
     * first one opens, and the folder is watched. Opening a folder that is open
     * already shows its hidden files again and brings it up to date.
     * @returns {Promise<string>} 'opened' | 'refreshed' | 'cancelled' | 'unsupported' | 'empty' | 'failed'
     */
    async function openFolder() {
        const showDirectoryPicker = pickerOf();
        if (!showDirectoryPicker) {
            notify('This browser cannot open folders. Use Chrome or Edge.', 'error');
            return 'unsupported';
        }
        let handle;
        try {
            handle = await showDirectoryPicker({mode: 'read'});
        } catch (e) {
            if (e && e.name === 'AbortError') return 'cancelled';
            notify('Open folder failed: ' + ((e && e.message) || e), 'error');
            return 'failed';
        }
        return openHandle(handle);
    }

    /**
     * Open a directory handle the browser allows reading (just picked, or restored
     * with access). With {openFirst: false} the open doc stays as it is, and with
     * {quiet: true} only problems are reported.
     * @returns {Promise<string>} 'opened' | 'refreshed' | 'empty' | 'failed'
     */
    async function openHandle(handle, {openFirst = true, quiet = false} = {}) {
        try {
            const existing = await findOpen(handle);
            if (existing) {
                setHidden(existing.id, null);
                existing.handle = handle;
                existing.status = 'ok';
                await (busy ? busy.catch(() => {}) : null);
                await exclusive(() => syncFolder(existing));
                onChanged();
                start();
                if (!quiet) notify('Folder ' + existing.name + ' is up to date');
                return 'refreshed';
            }
            const scanned = await scanDirectory(handle);
            if (!scanned.size) {
                if (!quiet) notify('No Markdown files in ' + handle.name);
                return 'empty';
            }
            const f = {id: newFolderId(), name: handle.name, handle, status: 'ok', files: new Map()};
            folders.set(f.id, f);
            safeSet(FOLDERS_KEY, '1');
            const paths = [...scanned.keys()].sort(comparePaths);
            const docs = await addFiles(f, paths, scanned);
            if (docs.length && openFirst) await openDoc(docs[0].id);
            onChanged();
            start();
            const n = docs.length;
            if (!quiet) notify('Opened ' + n + (n === 1 ? ' file' : ' files') + ' from ' + f.name + ', watching for changes');
            if (scanned.truncated) {
                notify(`Only the first ${MAX_FILES} Markdown files, up to ${MAX_DEPTH} folders deep, are listed from ${f.name}`, 'error');
            }
            return 'opened';
        } catch (e) {
            const what = quiet ? 'Could not open the default folder ' + (handle && handle.name) : 'Open folder failed';
            notify(what + ': ' + ((e && e.message) || e), 'error');
            return 'failed';
        }
    }

    /** Ask again for permission to read a folder (call from a click), then bring it up to date. */
    async function reconnect(folderId) {
        const f = folders.get(folderId);
        if (!f) return 'gone';
        const p = await permissionOf(f.handle, true);
        if (p !== 'granted') {
            f.status = f.handle ? 'needs-permission' : 'lost';
            onChanged();
            return 'denied';
        }
        f.status = 'ok';
        await (busy ? busy.catch(() => {}) : null);
        await exclusive(() => syncFolder(f));
        onChanged();
        start();
        return 'ok';
    }

    /**
     * Reconnect every folder that needs access again, one after another (call from
     * a click). A browser may need a separate click for each; those left over
     * keep their own Reconnect button.
     * @returns {Promise<{ok: number, denied: number}>}
     */
    async function reconnectAll() {
        const counts = {ok: 0, denied: 0};
        const waiting = [...folders.values()].filter((f) => f.status === 'needs-permission').sort(byName);
        for (const f of waiting) {
            const r = await reconnect(f.id);
            if (r === 'ok') counts.ok++; else if (r === 'denied') counts.denied++;
        }
        return counts;
    }

    /**
     * Bring back saved default folders. Each entry is {name, handle}. A folder
     * listed already is left alone; one the browser still allows is read and
     * listed (closed, without changing the open doc); one that needs access again
     * is listed with no files and a Reconnect button.
     * @param {Array<{name?: string, handle: object}>} entries
     * @returns {Promise<{opened: number, waiting: number, already: number, skipped: number}>}
     */
    async function restore(entries) {
        const counts = {opened: 0, waiting: 0, already: 0, skipped: 0};
        for (const entry of entries || []) {
            const handle = entry && entry.handle;
            if (!handle || handle.kind !== 'directory') { counts.skipped++; continue; }
            if (await findOpen(handle)) { counts.already++; continue; }
            const p = await permissionOf(handle, false);
            if (p === 'granted') {
                await (busy ? busy.catch(() => {}) : null);
                const r = await openHandle(handle, {openFirst: false, quiet: true});
                if (r === 'opened' || r === 'refreshed') counts.opened++; else counts.skipped++;
                continue;
            }
            const f = {id: newFolderId(), name: handle.name || entry.name || 'Folder', handle,
                status: 'needs-permission', files: new Map()};
            folders.set(f.id, f);
            counts.waiting++;
        }
        if (counts.waiting) onChanged();
        if (folders.size) start();
        return counts;
    }

    /** The folders open now, in the order the sidebar lists them, with their handles: the defaults to save. */
    function snapshot() {
        return [...folders.values()].filter((f) => f.handle).sort(byName)
            .map((f) => ({name: f.name, handle: f.handle}));
    }

    /** The ids of every doc in a folder, for Close all in folder. */
    function docIds(folderId) {
        const f = folders.get(folderId);
        return f ? [...f.files.values()].map((e) => e.id) : [];
    }

    /** The folder a doc belongs to and its path there, or null. */
    function folderOf(docId) {
        for (const f of folders.values()) {
            for (const [path, e] of f.files) if (e.id === docId) return {folderId: f.id, path};
        }
        return null;
    }

    /** Stop watching a folder and forget it (its docs are closed by the caller). */
    function closeFolder(folderId) {
        folders.delete(folderId);
        setHidden(folderId, null);
        if (!folders.size) stop();
        onChanged();
    }

    /**
     * Docs were closed or deleted elsewhere: drop them from their folders. With
     * {hide: true} a file closed on its own stays hidden on later polls.
     */
    function forgetDocs(ids, {hide = false} = {}) {
        const gone = new Set(ids);
        for (const f of [...folders.values()]) {
            const hidden = hiddenPaths(f.id);
            let touched = false;
            for (const [path, e] of [...f.files]) {
                if (!gone.has(e.id)) continue;
                f.files.delete(path);
                touched = true;
                if (hide) hidden.add(path);
            }
            if (!touched) continue;   // a folder waiting for access has no files yet: kept
            if (f.files.size) {
                if (hide) setHidden(f.id, hidden);
            } else {
                // Nothing left open in it: the folder is closed, not watched for files to add.
                folders.delete(f.id);
                setHidden(f.id, null);
            }
        }
        if (!folders.size) stop();
        onChanged();
    }

    /** Update a listed doc's title after a save, so the folder section shows it. */
    function noteSaved(doc) {
        if (!doc || !doc.folderId) return;
        const f = folders.get(doc.folderId);
        const e = f && f.files.get(doc.folderPath);
        if (e && e.id === doc.id) Object.assign(e, {title: doc.title, updatedAt: doc.updatedAt, lastModified: doc.lastModified});
    }

    /** The folders for the sidebar: [{id, name, status, docs: [{id, title, fileName, folderPath, ...}]}], by name. */
    function list() {
        return [...folders.values()].sort(byName)
            .map((f) => ({
                id: f.id, name: f.name, status: f.status,
                docs: [...f.files].sort((a, b) => comparePaths(a[0], b[0]))
                    .map(([path, e]) => ({id: e.id, title: e.title, fileName: e.fileName, folderId: f.id,
                        folderPath: path, origin: 'disk', updatedAt: e.updatedAt, lastOpenedAt: e.lastOpenedAt})),
            }));
    }

    return {
        load, openFolder, openHandle, reconnect, reconnectAll, restore, snapshot, checkAll, closeFolder, forgetDocs, docIds, folderOf, noteSaved, list,
        start, stop,
        get supported() { return !!pickerOf(); },
        get watching() { return timer != null; },
    };
}
