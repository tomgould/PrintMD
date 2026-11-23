/**
 * js/folder-defaults.js
 *
 * Default folders: the folders a user saved so PrintMD opens the same ones next
 * time, through a restart of the browser and through a clear of its site data.
 *
 * Rules:
 *  - The defaults live in their own small IndexedDB database (DB_NAME), apart from
 *    the documents' database, so its schema never changes for them. A value is
 *    {version, savedAt, folders: [{name, handle}], openFile: {folder, path}|null};
 *    the handles are File System Access directory handles, which IndexedDB can
 *    store and the browser hands back after a restart (asking again for access).
 *  - Clearing site data wipes that database too. For that case the defaults can
 *    be written to a small JSON file and read back. A browser gives a page no
 *    folder paths, so the file holds the folder names, in order, and which file
 *    was open; reading it back asks the user to choose each folder again.
 *  - A defaults file is untrusted input: parseDefaultsFile checks its shape and
 *    keeps at most MAX_DEFAULT_FOLDERS usable names. Saving keeps to the same
 *    rules (fileFolders), so a file PrintMD writes always reads back.
 *
 * The pure functions run in Node. createDefaultsStore needs IndexedDB, injected
 * or the window's.
 */

export const DB_NAME = 'printmd-defaults';
const STORE = 'defaults';
const KEY = 'folders';
export const FILE_KIND = 'printmd-folder-defaults';
export const FILE_VERSION = 1;
export const FILE_NAME = 'printmd-folders.json';
export const MAX_DEFAULT_FOLDERS = 20;
const MAX_NAME = 255;
const MAX_PATH = 1024;
const MAX_FILE_BYTES = 64 * 1024;

/** A folder name as a browser gives it: not blank, no "/" or control character, at most MAX_NAME long. */
function cleanName(v) {
    if (typeof v !== 'string' || !v.trim() || v.length > MAX_NAME || /[\/\u0000-\u001f]/.test(v)) return null;
    return v;
}

/**
 * The folders a defaults file can hold: those with a usable name, at most
 * MAX_DEFAULT_FOLDERS. `skipped` counts the rest.
 * @param {Array<{name: string}>} folders
 * @returns {{folders: Array<{name: string}>, skipped: number}}
 */
export function fileFolders(folders) {
    const usable = (folders || []).filter((f) => f && cleanName(f.name)).map((f) => ({name: f.name}));
    const kept = usable.slice(0, MAX_DEFAULT_FOLDERS);
    return {folders: kept, skipped: (folders || []).length - kept.length};
}

/** A path inside a folder: "a/b.md", no "..", no leading slash. */
function cleanPath(v) {
    if (typeof v !== 'string' || !v || v.length > MAX_PATH) return null;
    if (v.startsWith('/') || /[\u0000-\u001f]/.test(v)) return null;
    if (v.split('/').some((part) => !part || part === '.' || part === '..')) return null;
    return v;
}

/**
 * The text of a defaults file.
 * @param {{folders: Array<{name: string}>, openFile?: {folder: string, path: string}|null}} defaults
 * @param {number} [now]
 * @returns {string}
 */
export function buildDefaultsFile({folders, openFile = null}, now = Date.now()) {
    const out = {
        kind: FILE_KIND,
        version: FILE_VERSION,
        savedAt: new Date(now).toISOString(),
        folders: fileFolders(folders).folders,
    };
    if (openFile && openFile.folder && openFile.path) out.openFile = {folder: openFile.folder, path: openFile.path};
    return JSON.stringify(out, null, 2) + '\n';
}

/**
 * Read a defaults file. Throws an Error with a short message the user can read
 * when the text is not one.
 * @param {string} text
 * @returns {{folders: Array<{name: string}>, openFile: {folder: string, path: string}|null, skipped: number}}
 *   `skipped` counts folders left out (no usable name, or past MAX_DEFAULT_FOLDERS)
 */
export function parseDefaultsFile(text) {
    const bad = (why) => new Error('Not a PrintMD default folders file: ' + why);
    if (typeof text !== 'string') throw bad('no text');
    if (text.length > MAX_FILE_BYTES) throw bad('too big');
    let data;
    try { data = JSON.parse(text); } catch (_e) { throw bad('not JSON'); }
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw bad('not an object');
    if (data.kind !== FILE_KIND) throw bad('wrong kind');
    if (data.version !== FILE_VERSION) throw bad('version ' + String(data.version).slice(0, 10) + ' is not known');
    if (!Array.isArray(data.folders) || !data.folders.length) throw bad('no folders');
    if (data.folders.length > 1000) throw bad('too many folders');
    const {folders, skipped} = fileFolders(data.folders);
    if (!folders.length) throw bad('no folder has a usable name');
    let openFile = null;
    if (data.openFile && typeof data.openFile === 'object') {
        const folder = cleanName(data.openFile.folder);
        const path = cleanPath(data.openFile.path);
        if (folder && path && folders.some((f) => f.name === folder)) openFile = {folder, path};
    }
    return {folders, openFile, skipped};
}

/**
 * Whether a chosen folder's name is the one expected: 'same', 'case' (only the
 * letter case differs) or 'different'.
 */
export function compareFolderName(expected, chosen) {
    const a = String(expected == null ? '' : expected);
    const b = String(chosen == null ? '' : chosen);
    if (a === b) return 'same';
    if (a.toLowerCase() === b.toLowerCase()) return 'case';
    return 'different';
}

/** True when a stored value is usable defaults: at least one folder with a handle. */
export function hasFolders(value) {
    return !!(value && Array.isArray(value.folders) && value.folders.some((f) => f && f.handle));
}

/**
 * The defaults database.
 * @param {{indexedDB?: IDBFactory}} [opts]
 * @returns {{get: () => Promise<object|null>, set: (value: object) => Promise<void>, clear: () => Promise<void>, close: () => void}}
 */
export function createDefaultsStore({indexedDB: idb} = {}) {
    const factory = idb || (typeof indexedDB !== 'undefined' ? indexedDB : null);
    let dbPromise = null;

    function open() {
        if (!factory) return Promise.reject(new Error('IndexedDB is not available'));
        if (!dbPromise) {
            dbPromise = new Promise((resolve, reject) => {
                let req;
                try { req = factory.open(DB_NAME, 1); } catch (e) { reject(e); return; }
                req.onupgradeneeded = () => {
                    if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
                };
                req.onsuccess = () => {
                    const db = req.result;
                    // Another tab deleting or upgrading it (a site data clear): let go.
                    db.onversionchange = () => { db.close(); dbPromise = null; };
                    resolve(db);
                };
                req.onerror = () => reject(req.error);
                req.onblocked = () => reject(new Error('the defaults database is blocked'));
            });
            dbPromise.catch(() => { dbPromise = null; });
        }
        return dbPromise;
    }

    async function run(mode, fn) {
        const db = await open();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE, mode);
            const req = fn(tx.objectStore(STORE));
            tx.oncomplete = () => resolve(req ? req.result : undefined);
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error || new Error('aborted'));
        });
    }

    return {
        async get() {
            const v = await run('readonly', (s) => s.get(KEY));
            return v && typeof v === 'object' ? v : null;
        },
        async set(value) {
            await run('readwrite', (s) => s.put(value, KEY));
        },
        async clear() {
            await run('readwrite', (s) => s.delete(KEY));
        },
        close() {
            if (dbPromise) dbPromise.then((db) => db.close(), () => {});
            dbPromise = null;
        },
    };
}
