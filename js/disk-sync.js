/**
 * js/disk-sync.js
 *
 * Keeps a document opened from disk (File System Access API) in step with its
 * file: opening it, watching it for outside changes, and saving back to it.
 *
 * Rules:
 *  - A disk change to a doc with no unsaved edits reloads it. With unsaved edits,
 *    the user chooses (dialog); "Keep mine" remembers that disk version so the same
 *    change does not ask again.
 *  - Only one check or save runs at a time. Each one notes the active doc first and
 *    drops its result if the user switched docs during any await.
 *  - A handle that stops working (file moved, permission revoked) stops the watcher
 *    and says so, instead of failing silently every 1.5 s.
 *  - Saving re-checks the file first, so a save never overwrites an outside change
 *    without asking. The text is read after any permission prompt, so whatever was
 *    typed during the prompt is saved too.
 *
 * No direct DOM access: the editor text, dialog, messages and file pickers are
 * injected, so tests can drive it with fake handles.
 */
import {diskChangeAction} from './docmanager.js';
import {downloadBlob, toFilenameSafe} from './download.js';

export const STOPPED_MESSAGE = 'Stopped watching: file moved or permission lost';

function pick(opts, key, fallback) {
    return Object.prototype.hasOwnProperty.call(opts, key) ? opts[key] : fallback;
}

function defaultDownload(text) {
    const blob = new Blob([text], {type: 'text/markdown;charset=utf-8'});
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    downloadBlob(blob, `printmd-${ts}.md`);
}

function suggestedNameFor(docManager, text) {
    if (docManager.currentFileName) return docManager.currentFileName;
    const title = docManager.deriveTitle ? docManager.deriveTitle(text) : 'Untitled';
    return toFilenameSafe(title, 'Untitled', 80) + '.md';
}

/**
 * @param {object} opts
 * @param {object} opts.docManager
 * @param {() => string} opts.getText                 current editor text
 * @param {(mode: string, fileName?: string) => Promise<string>} opts.showDialog
 * @param {(message: string, kind?: 'info'|'error') => void} [opts.notify]
 * @param {() => void} [opts.onChanged]               after the doc was replaced, opened or saved
 * @param {Function|null} [opts.showOpenFilePicker]   defaults to window's, null = unsupported
 * @param {Function|null} [opts.showSaveFilePicker]   defaults to window's, null = unsupported
 * @param {() => void} [opts.openFallback]            used when there is no open picker (file input)
 * @param {(text: string) => void} [opts.download]    plain download fallback
 * @param {number} [opts.intervalMs]
 * @param {{setInterval: Function, clearInterval: Function}} [opts.timers]
 */
export function createDiskSync(opts) {
    const {docManager, getText, showDialog} = opts;
    const notify = opts.notify || (() => {});
    const onChanged = opts.onChanged || (() => {});
    const win = typeof window !== 'undefined' ? window : {};
    const showOpenFilePicker = pick(opts, 'showOpenFilePicker',
        win.showOpenFilePicker ? win.showOpenFilePicker.bind(win) : null);
    const showSaveFilePicker = pick(opts, 'showSaveFilePicker',
        win.showSaveFilePicker ? win.showSaveFilePicker.bind(win) : null);
    const openFallback = opts.openFallback || (() => {});
    const download = opts.download || defaultDownload;
    const intervalMs = opts.intervalMs || 1500;
    const timers = opts.timers || {setInterval: (f, ms) => setInterval(f, ms), clearInterval: (t) => clearInterval(t)};

    let watchTimer = null;
    let busy = null;        // the check or save in progress (a promise), or null
    let lostId = null;      // doc whose handle stopped working; resume skips it

    // ── Watching ──────────────────────────────────────────────────────────────
    function stopWatching() {
        if (watchTimer != null) { timers.clearInterval(watchTimer); watchTimer = null; }
    }

    /** Start polling the active doc's file. Clears an earlier "stopped" state. */
    function startWatching() {
        stopWatching();
        lostId = null;
        if (!docManager.currentHandle) return;
        watchTimer = timers.setInterval(() => { checkDiskChange(); }, intervalMs);
    }

    /** Restart after the tab becomes visible again, unless the handle was lost. */
    function resumeWatching() {
        if (lostId != null && lostId === docManager.currentId) return;
        startWatching();
    }

    function lose(id) {
        stopWatching();
        lostId = id;
        notify(STOPPED_MESSAGE, 'error');
    }

    /** Run `task` as the one check/save in progress. */
    function exclusive(task) {
        const run = Promise.resolve().then(task);
        busy = run;
        const clear = () => { if (busy === run) busy = null; };
        run.then(clear, clear);
        return run;
    }

    /**
     * Compare the file on disk with the active doc and act on it.
     * @returns {Promise<string>} 'busy' | 'none' | 'stale' | 'stopped' | 'reloaded' | 'kept' | 'loaded-disk' | 'no-permission'
     */
    function checkDiskChange() {
        if (busy) return Promise.resolve('busy');
        const handle = docManager.currentHandle;
        const id = docManager.currentId;
        if (!handle) return Promise.resolve('none');
        if (lostId != null && lostId === id) return Promise.resolve('stopped');
        return exclusive(async () => {
            let file;
            let text;
            try {
                if (handle.queryPermission) {
                    const p = await handle.queryPermission({mode: 'read'});
                    if (p !== 'granted') return 'no-permission';
                    if (docManager.currentId !== id) return 'stale';
                }
                file = await handle.getFile();
                if (docManager.currentId !== id) return 'stale';
                if (diskChangeAction(docManager.currentLastModified, file.lastModified, docManager.isDirty()) === 'none') return 'none';
                text = await file.text();
            } catch (_e) {
                if (docManager.currentId === id) lose(id);
                return 'stopped';
            }
            if (docManager.currentId !== id) return 'stale';

            // Decide on the state as it is now: the user may have typed during the reads.
            const action = diskChangeAction(docManager.currentLastModified, file.lastModified, docManager.isDirty());
            if (action === 'none') return 'none';
            if (action === 'reload') {
                await docManager.applyDiskText(text, file.lastModified).catch(() => {});
                onChanged();
                notify('Reloaded from disk');
                return 'reloaded';
            }

            const choice = await showDialog('watch', docManager.currentFileName || handle.name);
            if (docManager.currentId !== id) return 'stale';
            if (choice === 'disk') {
                // Read again: the file may have changed while the dialog was open.
                let latest = file;
                let latestText = text;
                try {
                    latest = await handle.getFile();
                    latestText = await latest.text();
                } catch (_e) {
                    if (docManager.currentId === id) lose(id);
                    return 'stopped';
                }
                if (docManager.currentId !== id) return 'stale';
                await docManager.applyDiskText(latestText, latest.lastModified).catch(() => {});
                onChanged();
                notify('Loaded disk version');
                return 'loaded-disk';
            }
            // Keep mine: remember this disk version so it does not ask again; stay dirty.
            docManager.setLastModified(file.lastModified);
            return 'kept';
        });
    }

    // ── Opening ───────────────────────────────────────────────────────────────
    async function openFromDisk() {
        if (!showOpenFilePicker) { openFallback(); return 'fallback'; }
        try {
            const [handle] = await showOpenFilePicker({
                types: [
                    {description: 'Markdown', accept: {'text/markdown': ['.md', '.markdown'], 'text/plain': ['.txt']}},
                ],
                excludeAcceptAllOption: false,
                multiple: false,
            });
            const file = await handle.getFile();
            const text = await file.text();
            await docManager.openDiskDoc(handle, text, file.lastModified, file.name);
            onChanged();
            startWatching();
            notify('Opened ' + file.name + ', watching for changes');
            return 'opened';
        } catch (e) {
            if (e && e.name === 'AbortError') return 'cancelled';
            notify('Open failed: ' + ((e && e.message) || e), 'error');
            return 'failed';
        }
    }

    // ── Saving ────────────────────────────────────────────────────────────────
    async function writeTo(handle, text) {
        const writable = await handle.createWritable();
        try {
            await writable.write(text);
            await writable.close();
        } catch (e) {
            // Discard the half-written temp file; the original stays untouched.
            try { await writable.abort(); } catch (_e) { /* already closed */ }
            throw e;
        }
    }

    async function lastModifiedOf(handle) {
        try { return (await handle.getFile()).lastModified; } catch (_e) { return undefined; }
    }

    async function saveInPlace(handle, id) {
        if (handle.requestPermission) {
            const perm = await handle.requestPermission({mode: 'readwrite'});
            if (perm !== 'granted') throw new Error('write permission denied');
        }
        if (docManager.currentId !== id) return 'stale';

        // Did the file change on disk since we loaded or last saved it?
        const onDisk = await handle.getFile();
        if (docManager.currentId !== id) return 'stale';
        const baseline = docManager.currentLastModified;
        if (baseline != null && onDisk.lastModified !== baseline) {
            const choice = await showDialog('save', docManager.currentFileName || handle.name);
            if (docManager.currentId !== id) return 'stale';
            if (choice === 'cancel' || !choice) return 'cancelled';
            if (choice === 'disk') {
                const latest = await handle.getFile();
                const latestText = await latest.text();
                if (docManager.currentId !== id) return 'stale';
                await docManager.applyDiskText(latestText, latest.lastModified).catch(() => {});
                onChanged();
                notify('Loaded disk version');
                return 'loaded-disk';
            }
        }

        const text = getText();   // read now, after every prompt
        await writeTo(handle, text);
        const lm = await lastModifiedOf(handle);
        // Record the sync for the doc that was WRITTEN, even if the user has
        // switched to another doc since; otherwise it keeps a stale baseline and
        // later shows a false conflict.
        await docManager.recordDiskSync(id, text, lm).catch(() => {});
        notify('Saved to ' + (handle.name || 'file'));
        return 'saved';
    }

    async function saveAsNewFile(id) {
        const handle = await showSaveFilePicker({
            suggestedName: suggestedNameFor(docManager, getText()),
            types: [{description: 'Markdown', accept: {'text/markdown': ['.md']}}],
        });
        if (docManager.currentId !== id) return 'stale';
        const text = getText();   // read now, after the picker
        await writeTo(handle, text);
        const lm = await lastModifiedOf(handle);
        if (docManager.currentId === id) {
            await docManager.attachDiskFile(handle, text, lm, handle.name).catch(() => {});
            onChanged();
            startWatching();
        }
        notify('Saved to ' + (handle.name || 'file'));
        return 'saved';
    }

    function downloadFallback() {
        // A download is a copy, not the doc's file: never mark the doc synced.
        download(getText());
        return 'downloaded';
    }

    /**
     * Save the active doc: in place for a disk doc, via a save picker for a local
     * doc when supported, else as a download.
     * @returns {Promise<string>} 'saved' | 'downloaded' | 'cancelled' | 'loaded-disk' | 'stale'
     */
    async function saveFile() {
        while (busy) { await busy.catch(() => {}); }
        return exclusive(async () => {
            const id = docManager.currentId;
            const handle = docManager.currentHandle;
            if (handle && handle.createWritable) {
                try {
                    const r = await saveInPlace(handle, id);
                    if (r === 'stale') notify('Save cancelled: you switched documents', 'error');
                    return r;
                } catch (e) {
                    if (e && e.name === 'AbortError') return 'cancelled';
                    notify('Save to file failed (' + ((e && e.message) || e) + '), downloading a copy instead', 'error');
                    return downloadFallback();
                }
            }
            if (!handle && showSaveFilePicker) {
                try {
                    const r = await saveAsNewFile(id);
                    if (r === 'stale') notify('Save cancelled: you switched documents', 'error');
                    return r;
                } catch (e) {
                    if (e && e.name === 'AbortError') return 'cancelled';
                    notify('Save to file failed (' + ((e && e.message) || e) + '), downloading a copy instead', 'error');
                    return downloadFallback();
                }
            }
            return downloadFallback();
        });
    }

    return {
        checkDiskChange,
        startWatching,
        stopWatching,
        resumeWatching,
        openFromDisk,
        saveFile,
        get watching() { return watchTimer != null; },
    };
}
