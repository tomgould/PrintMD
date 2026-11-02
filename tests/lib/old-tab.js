/**
 * tests/lib/old-tab.js
 *
 * For the blocked-upgrade pages. The old tab is played by the test page: it
 * holds a version 1 database open and, like code from before the upgrade, never
 * lets go when asked (no versionchange handler). The app in the frame needs
 * version 2, so its upgrade is blocked until the test closes that connection.
 */
import {resetStorage} from './harness.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export async function waitFor(fn, what, ms = 8000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        try { if (fn()) return; } catch (_e) { /* not ready */ }
        await sleep(25);
    }
    throw new Error('timed out waiting for ' + what);
}

/** A version 1 database with one document, held open by this page. */
async function oldTab() {
    await resetStorage();
    return new Promise((resolve, reject) => {
        const req = indexedDB.open('printmd', 1);
        req.onupgradeneeded = () => {
            const docs = req.result.createObjectStore('docs', {keyPath: 'id'});
            docs.put({id: 'old-1', title: 'Example Co old doc', snapshot: '# Example Co old doc\n\nkept', updatedAt: Date.now()});
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

/**
 * Tab B: another tab on the new code whose upgrade to version 2 waits behind
 * the old tab. A tab opened after it (tab C) queues its own open behind B's and
 * never gets a "blocked" event. Resolves when B's upgrade has run (it creates
 * the store's indexes, as js/store.js does) and B has closed its connection.
 */
function upgradeWaitingBehind() {
    return new Promise((resolve) => {
        const req = indexedDB.open('printmd', 2);
        req.onupgradeneeded = () => {
            const docs = req.transaction.objectStore('docs');
            docs.createIndex('updatedAt', 'updatedAt');
            docs.createIndex('recentTitle', ['updatedAt', 'id', 'titleKey']);
        };
        req.onsuccess = () => { req.result.close(); resolve(); };
        req.onerror = () => resolve();
    });
}

/**
 * Open the old tab's connection, then load the app in `frame`.
 * @param {HTMLIFrameElement} frame
 * @param {{behindTabB?: boolean}} [opts]  behindTabB: tab B's upgrade is already waiting, so the app is tab C
 * @returns {Promise<{old: IDBDatabase, win: Window, doc: Document, tabB: Promise<void>|null}>}
 */
export async function bootBehindOldTab(frame, {behindTabB = false} = {}) {
    const old = await oldTab();
    const tabB = behindTabB ? upgradeWaitingBehind() : null;
    frame.src = '../index.html';
    await new Promise(res => frame.addEventListener('load', res, {once: true}));
    return {old, win: frame.contentWindow, doc: frame.contentDocument, tabB};
}

/** Load classic scripts one after another, like the <script> tags in index.html. */
async function loadScripts(srcs) {
    for (const src of srcs) {
        await new Promise((resolve, reject) => {
            const s = document.createElement('script');
            s.src = src;
            s.onload = resolve;
            s.onerror = () => reject(new Error('could not load ' + src));
            document.head.appendChild(s);
        });
    }
}

/**
 * Boot the app in THIS page, behind the old tab, so the test can shorten the
 * store's blocked-open wait first (setOpenBlockedTimeout is reached only by code
 * in the page). The page gets index.html's body markup (without its scripts) and
 * the vendor scripts the editor needs at startup; the export libraries and the
 * extra highlight.js grammars are left out, which keeps the boot light.
 * @param {number} blockedTimeoutMs
 * @returns {Promise<{old: IDBDatabase, win: Window, doc: Document, booted: Promise<void>}>}
 */
export async function bootHereBehindOldTab(blockedTimeoutMs, {behindTabB = false} = {}) {
    const old = await oldTab();
    const tabB = behindTabB ? upgradeWaitingBehind() : null;
    return {old, tabB, ...await bootHere(blockedTimeoutMs)};
}

/** A version 1 database with the old tab's document, closed again (nobody holds it). */
export async function v1Database() {
    (await oldTab()).close();
}

/**
 * Boot the app in this page (see bootHereBehindOldTab), with the store's
 * blocked-open wait set to `blockedTimeoutMs`.
 * @returns {Promise<{win: Window, doc: Document, booted: Promise<void>}>}
 */
export async function bootHere(blockedTimeoutMs) {
    const page = new DOMParser().parseFromString(await (await fetch('../index.html')).text(), 'text/html');
    for (const el of [...page.body.children]) {
        if (el.tagName !== 'SCRIPT') document.body.appendChild(document.adoptNode(el));
    }
    await loadScripts(['../vendor/marked/marked.min.js', '../vendor/dompurify/purify.min.js', '../vendor/highlightjs/highlight.min.js']);
    const store = await import('../../js/store.js');
    store.setOpenBlockedTimeout(blockedTimeoutMs);
    const app = await import('../../js/app.js');
    return {win: window, doc: document, booted: app.init()};
}

/** The app's waiting note, and whether it is on screen. */
export const waitNote = (doc) => doc.querySelector('body > .upgrade-wait');
export const shown = (el) => !!el && !el.hidden && el.getClientRects().length > 0;
