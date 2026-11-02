import * as defaultStore from './store.js';
import {safeGet, safeSet, safeRemove} from './safe-storage.js';
import {extractTitle} from './doc-meta.js';
import {docExportOpts} from './export-options.js';

/** localStorage key for the synchronous "last words" buffer written when the page is hidden. */
export const CRASH_KEY = 'printmd-crash';

/** The stored title of a doc: its first `# ` heading (see js/doc-meta.js). */
export function deriveTitle(markdown) {
    return extractTitle(markdown);
}

/**
 * Fast non-cryptographic hash (cyrb53) of the document text, plus its length.
 * Used to remember "the text as it was when it last matched the file on disk".
 */
export function hashText(text) {
    const s = String(text == null ? '' : text);
    let h1 = 0xdeadbeef;
    let h2 = 0x41c6ce57;
    for (let i = 0; i < s.length; i++) {
        const ch = s.charCodeAt(i);
        h1 = Math.imul(h1 ^ ch, 2654435761);
        h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36) + '-' + s.length.toString(36);
}

export function diskChangeAction(baselineLastModified, fileLastModified, isDirty) {
    if (baselineLastModified == null || fileLastModified === baselineLastModified) return 'none';
    return isDirty ? 'conflict' : 'reload';
}

/**
 * io contract:
 *   getValue():string, setValue(text), getTemplateId():string, setTemplateId(id)
 * optional:
 *   onChange()              after a doc is loaded into the editor
 *   onSaved(doc, info)      after a write has COMMITTED; info is {kind: 'settings'} for a
 *                           saveExportOpts write, undefined for a text save
 *   onSaveError(error, info)  when a write failed (never call onSaved for it); info as above
 *   cancelPendingSave()     drop the app's debounced autosave timer
 *   onRestored(doc)         a crash buffer was restored at startup
 *   getExportOpts()         the export choices a new doc (newDoc, openDiskDoc) starts with and
 *                           stores as its own: the app gives format, pageSize, orientation and
 *                           customSize, never the open doc's layout, fit or margin
 *   setExportOpts(opts)     a doc was loaded: its stored choices, cleaned by docExportOpts
 *                           (js/export-options.js), or null when it has none stored (the
 *                           app then uses its last-used choices). Called before setTemplateId.
 *
 * Each record keeps its export choices in `exportOpts` (keys: DOC_EXPORT_KEYS: format, pageSize,
 * orientation, and the page options customSize, layout, fit and margin). Only
 * saveExportOpts() and the creation of a doc write it; a text save keeps it as stored.
 *
 * `store` defaults to the IndexedDB store; pass createMemoryStore() as the fallback
 * when IndexedDB is unavailable.
 */
export function createDocManager(io, store = defaultStore) {
    let currentId = null;
    let currentOrigin = 'local';
    let currentHandle = null;
    let currentLastModified = null;
    let currentFileName = null;
    let currentSyncedHash = null;   // hash of the text last known to match the file on disk
    const deletedIds = new Set();   // ids removed this session: no late save may bring them back
    let disposed = false;           // set by dispose(): this manager must never touch io or the store again

    // ── Ordering ──────────────────────────────────────────────────────────────
    // writeChain: every store write runs one at a time, in call order, so a late
    //   save can never overtake a delete and two saves never interleave.
    // navChain: open/switch/new/remove/import-open run one at a time, so two
    //   concurrent navigations cannot interleave their leave/load steps.
    let writeChain = Promise.resolve();
    let navChain = Promise.resolve();

    function enqueueWrite(task) {
        const run = writeChain.then(task);
        writeChain = run.catch(() => {});
        return run;
    }

    function serial(fn) {
        return (...args) => {
            const run = navChain.then(() => (disposed ? null : fn(...args)));
            navChain = run.catch(() => {});
            return run;
        };
    }

    /** Drop all trace of a doc in this session. Does not touch the store. */
    function forget(id) {
        deletedIds.add(id);
        const buf = readCrashBuffer();
        if (buf && buf.docId === id) safeRemove(CRASH_KEY);
        if (id === currentId) {
            currentId = null;
            currentOrigin = 'local';
            currentHandle = null;
            currentLastModified = null;
            currentFileName = null;
            currentSyncedHash = null;
        }
    }

    // ── Crash buffer ──────────────────────────────────────────────────────────
    function readCrashBuffer() {
        const raw = safeGet(CRASH_KEY);
        if (!raw) return null;
        try {
            const buf = JSON.parse(raw);
            if (buf && typeof buf.docId === 'string' && typeof buf.source === 'string' && typeof buf.savedAt === 'number') return buf;
        } catch (_e) { /* fall through */ }
        return null;
    }

    async function restoreCrashBuffer() {
        // The in-memory fallback starts empty, so "doc not found" says nothing about
        // whether the doc was deleted. Leave the buffer for a session with real storage.
        if (store.isMemory) return;
        const buf = readCrashBuffer();
        if (!buf) { safeRemove(CRASH_KEY); return; }
        const doc = await store.getDoc(buf.docId);
        if (!doc || buf.savedAt <= (doc.updatedAt || 0) || buf.source === doc.snapshot) {
            safeRemove(CRASH_KEY);   // doc deleted, or the database already has this or newer
            return;
        }
        if (currentId !== doc.id) {
            // Only called from init: the open doc was loaded a moment ago and is
            // unchanged, so switch without saving it (a failing write must not
            // stop the restore).
            await load(doc);
        }
        if (disposed) return;
        io.setValue(buf.source);
        if (io.onChange) io.onChange();
        let saved = null;
        try {
            saved = await saveCurrent();   // doSave clears the buffer once it is committed
        } catch (_e) {
            // The write failed (io.onSaveError has reported it). Keep the restored
            // text in the editor and the buffer in place; startup carries on.
        }
        if (io.onRestored && !disposed) io.onRestored(saved || doc);
    }

    /**
     * Called when the page is hidden or closing. Writes the current text to
     * localStorage SYNCHRONOUSLY (an async IndexedDB write may not finish), then
     * starts the normal save. The buffer is restored at next startup if newer.
     * On the memory store the buffer is left alone: it may hold the only copy of
     * unsaved text for a doc in IndexedDB, and a memory doc never comes back anyway.
     */
    function flushOnLeave() {
        if (disposed || currentId == null) return;
        if (!store.isMemory) safeSet(CRASH_KEY, JSON.stringify({docId: currentId, source: io.getValue(), savedAt: Date.now()}));
        saveCurrent().catch(() => { /* buffer stays for the next start */ });
    }

    // ── Loading and saving ────────────────────────────────────────────────────
    async function load(doc) {
        if (disposed) return;
        currentId = doc.id;
        currentOrigin = doc.origin || 'local';
        currentHandle = doc.handleRef || null;
        currentLastModified = doc.lastModified || null;
        currentFileName = doc.fileName || null;
        currentSyncedHash = doc.diskSyncedHash || null;
        io.setValue(doc.snapshot || '');
        if (io.setExportOpts) io.setExportOpts(docExportOpts(doc.exportOpts));
        if (doc.templateId) io.setTemplateId(doc.templateId);
        if (io.onChange) io.onChange();
        // Record "last opened" inside the write queue and re-read the record there,
        // so it can never overwrite a newer save with the stale copy we loaded.
        const id = doc.id;
        try {
            await enqueueWrite(async () => {
                if (deletedIds.has(id)) return;
                const latest = await store.getDoc(id);
                if (latest) await store.upsertDoc({...latest, lastOpenedAt: Date.now()});
            });
        } catch (_e) { /* last-opened is cosmetic */ }
    }

    /** Snapshot everything a save needs NOW, before any await. */
    function capture() {
        if (disposed || currentId == null) return null;
        return {
            id: currentId,
            snapshot: io.getValue(),
            templateId: io.getTemplateId(),
            origin: currentOrigin,
            handle: currentHandle,
            lastModified: currentLastModified,
            fileName: currentFileName,
            syncedHash: currentSyncedHash,
        };
    }

    async function doSave(c) {
        if (deletedIds.has(c.id)) return null;
        const existing = (await store.getDoc(c.id)) || {};
        if (deletedIds.has(c.id)) return null;
        // Only bump updatedAt when content actually changed, so mere doc
        // switching does not reorder the sidebar.
        const contentChanged = c.snapshot !== existing.snapshot;
        const record = await store.upsertDoc({
            ...existing,
            id: c.id,
            title: deriveTitle(c.snapshot),
            snapshot: c.snapshot,
            templateId: c.templateId,
            origin: c.origin,
            updatedAt: contentChanged ? Date.now() : (existing.updatedAt || Date.now()),
            handleRef: c.handle,
            lastModified: c.lastModified,
            fileName: c.fileName != null ? c.fileName : existing.fileName,
            diskSyncedHash: c.syncedHash,
        });
        // Only a durable save clears the buffer (see flushOnLeave).
        const buf = store.isMemory ? null : readCrashBuffer();
        if (buf && buf.docId === c.id && buf.source === c.snapshot) safeRemove(CRASH_KEY);
        return record;
    }

    /**
     * Save the open doc. Everything it writes is captured at call time, and writes
     * run one at a time. Resolves with the stored record once COMMITTED; rejects
     * (and calls io.onSaveError, never io.onSaved) if the write failed.
     */
    function saveCurrent() {
        const c = capture();
        if (!c) return Promise.resolve(null);
        return enqueueWrite(() => doSave(c)).then(
            (record) => {
                if (record && io.onSaved) io.onSaved(record);
                return record;
            },
            (error) => {
                if (io.onSaveError) io.onSaveError(error);
                throw error;
            });
    }

    /**
     * Store the open doc's export choices in its record, cleaned by docExportOpts. Runs in
     * the write queue like a text save and re-reads the record there, so it never overwrites
     * a newer save. It changes nothing else: not the text, not updatedAt (the recent order
     * stays), not the disk baseline (isDirty is about the text). Resolves with the record once
     * COMMITTED (and calls io.onSaved(record, {kind: 'settings'})), or null when no doc is open,
     * the doc was deleted or this manager is retired; rejects and calls
     * io.onSaveError(error, {kind: 'settings'}) (never io.onSaved) when the write failed.
     * Text saves call the same hooks without a kind.
     */
    function saveExportOpts(opts) {
        if (disposed || currentId == null) return Promise.resolve(null);
        const id = currentId;
        const exportOpts = docExportOpts(opts) || {};
        const kind = {kind: 'settings'};
        return enqueueWrite(async () => {
            if (deletedIds.has(id)) return null;
            const d = await store.getDoc(id);
            if (!d || deletedIds.has(id)) return null;
            return store.upsertDoc({...d, exportOpts});
        }).then(
            (record) => {
                if (record && io.onSaved && !disposed) io.onSaved(record, kind);
                return record;
            },
            (error) => {
                if (io.onSaveError) io.onSaveError(error, kind);
                throw error;
            });
    }

    /** The choices on screen as a new record's own exportOpts, when the app gives them. */
    function exportOptsForNewDoc() {
        const opts = io.getExportOpts ? docExportOpts(io.getExportOpts()) : null;
        return opts ? {exportOpts: opts} : {};
    }

    // ── Dirty tracking ────────────────────────────────────────────────────────
    /**
     * True when the open doc is backed by a disk file and the editor text differs
     * from the text last synced with that file. Per doc, so it survives switches.
     * A disk doc with no recorded baseline counts as dirty: a disk change then
     * asks the user instead of silently overwriting their edits.
     */
    function isDirty() {
        if (disposed || currentId == null || currentOrigin !== 'disk') return false;
        if (currentSyncedHash == null) return true;
        return hashText(io.getValue()) !== currentSyncedHash;
    }

    /** `text` now matches the file on disk (after a save to disk or a reload from it). */
    function markSynced(text, lastModified) {
        currentSyncedHash = hashText(text);
        if (lastModified !== undefined) currentLastModified = lastModified;
    }

    /** Replace the open doc's text with the text read from disk and mark it clean. */
    async function applyDiskText(text, lastModified) {
        if (disposed || currentId == null) return null;
        io.setValue(text);
        markSynced(text, lastModified);
        if (io.onChange) io.onChange();
        return saveCurrent();
    }

    /** Link the open (local) doc to a file the user just saved to disk. */
    async function attachDiskFile(handle, text, lastModified, fileName) {
        if (disposed || currentId == null) return null;
        currentOrigin = 'disk';
        currentHandle = handle;
        currentFileName = fileName || (handle && handle.name) || currentFileName;
        markSynced(text, lastModified);
        return saveCurrent();
    }

    /**
     * `text` was just written to the file of doc `id`. For the open doc this is
     * markSynced + save. For another doc (the user switched while the write was in
     * flight) it updates the stored baseline through the write queue, so that doc
     * does not later show a false conflict or a false "dirty".
     */
    function recordDiskSync(id, text, lastModified) {
        if (disposed || id == null) return Promise.resolve(null);
        if (id === currentId) {
            markSynced(text, lastModified);
            return saveCurrent();
        }
        return enqueueWrite(async () => {
            if (deletedIds.has(id)) return null;
            const d = await store.getDoc(id);
            if (!d) return null;
            return store.upsertDoc({
                ...d,
                diskSyncedHash: hashText(text),
                lastModified: lastModified !== undefined ? lastModified : d.lastModified,
            });
        });
    }

    // ── Navigation (each exported one runs through navChain) ─────────────────
    async function leaveCurrent() {
        if (disposed || currentId == null) return;
        if (io.getValue().trim() === '') {
            const gone = currentId;
            forget(gone);
            try { await enqueueWrite(() => store.deleteDoc(gone)); } catch (_e) { /* best effort */ }
            return;
        }
        await saveCurrent();
    }

    async function newDocInner(initialText = '') {
        await leaveCurrent();
        if (disposed) return null;
        const doc = await enqueueWrite(() => store.upsertDoc({
            title: deriveTitle(initialText), snapshot: initialText,
            templateId: io.getTemplateId(), origin: 'local', ...exportOptsForNewDoc(),
        }));
        await load(doc);
        return doc;
    }

    async function switchToInner(id) {
        if (id === currentId) return null;
        await leaveCurrent();
        const doc = await store.getDoc(id);
        if (doc && !deletedIds.has(id)) await load(doc);
        return doc;
    }

    async function removeDocInner(id) {
        const wasCurrent = id === currentId;
        // Stop the app's debounced autosave and clear currentId BEFORE anything
        // else, so nothing can save the doc we are deleting back into the store.
        if (wasCurrent && io.cancelPendingSave) io.cancelPendingSave();
        forget(id);
        await enqueueWrite(() => store.deleteDoc(id));
        if (wasCurrent) {
            const recent = await store.listRecent(1);
            if (recent.length) await load(recent[0]); else await newDocInner('');
        }
    }

    async function openDiskDocInner(handle, text, lastModified, fileName) {
        await leaveCurrent();
        if (disposed) return null;
        const doc = await enqueueWrite(() => store.upsertDoc({
            title: deriveTitle(text), snapshot: text,
            templateId: io.getTemplateId(), origin: 'disk', handleRef: handle, lastModified,
            fileName: fileName || (handle && handle.name) || null,
            diskSyncedHash: hashText(text), ...exportOptsForNewDoc(),
        }));
        await load(doc);
        return doc;
    }

    async function setFileNameForCurrent(name) {
        if (disposed || currentId == null) return;
        const id = currentId;
        currentFileName = name;
        await enqueueWrite(async () => {
            if (deletedIds.has(id)) return;
            const d = await store.getDoc(id);
            if (!d) return;
            d.fileName = name;
            await store.upsertDoc(d);
        });
    }

    function setLastModified(ts) {
        currentLastModified = ts;
    }

    async function initInner(fallbackText = '') {
        await store.migrateFromLocalStorage();
        const recent = await store.listRecent(1);
        if (recent.length) await load(recent[0]); else await newDocInner(fallbackText);
        await restoreCrashBuffer();
    }

    /**
     * Retire this manager (the app replaced it, e.g. after falling back to the
     * in-memory store). Queued and in-flight navigations stop before touching the
     * editor; saves, flushes and disk updates become no-ops.
     */
    function dispose() {
        disposed = true;
    }

    return {
        init: serial(initInner),
        dispose,
        recordDiskSync,
        saveCurrent,
        saveExportOpts,
        newDoc: serial(newDocInner),
        switchTo: serial(switchToInner),
        removeDoc: serial(removeDocInner),
        openDiskDoc: serial(openDiskDocInner),
        setLastModified,
        setFileNameForCurrent,
        deriveTitle,
        isDirty,
        markSynced,
        applyDiskText,
        attachDiskFile,
        flushOnLeave,
        get currentId() { return currentId; },
        get currentOrigin() { return currentOrigin; },
        get currentHandle() { return currentHandle; },
        get currentLastModified() { return currentLastModified; },
        get currentFileName() { return currentFileName; },
        get disposed() { return disposed; },
    };
}
