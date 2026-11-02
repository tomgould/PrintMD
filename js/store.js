/**
 * js/store.js
 *
 * IndexedDB-backed document store.
 * DB: printmd, version 2 or later, object store: docs (keyPath: id), with indexes
 *   updatedAt    keyPath 'updatedAt'                      paging, newest first
 *   recentTitle  keyPath ['updatedAt', 'id', 'titleKey']  title search over keys only
 *
 * Opening: the database is opened at whatever version it has. Only a database
 * below version 2 (version 1 had the store without indexes, or none yet) is
 * reopened at version 2 to add them, keeping the data. A later version opens
 * as it is, so code that comes after this never gives this code a VersionError.
 * A version 2 or later database whose indexes are missing is not repaired.
 *
 * API (createMemoryStore() returns the same methods, plus isMemory: true):
 *   upsertDoc(doc)                  save; fills id, updatedAt and titleKey
 *   getDoc(id)                      one doc or undefined
 *   deleteDoc(id)
 *   listRecent(limit = 25, {before})  docs, newest first; `before` is a cursor
 *                                   (or a doc) and returns only docs after it in that order
 *   listPage({limit = 25, cursor})  {docs, nextCursor}; pass nextCursor back for
 *                                   the next page; it is null on the last page
 *   searchTitles(query, limit = 25) docs whose title contains `query`, ignoring
 *                                   case, newest first; an empty query lists recent docs
 *   indexRepair()                   resolves true once every record is in both indexes
 *                                   (false if the repair failed)
 *   migrateFromLocalStorage()
 * Order is updatedAt descending, then id ascending. A cursor is {updatedAt, id}.
 * titleKey is the title NFC-normalised and lowercased (toLowerCase only).
 *
 * Records saved before version 2 have no titleKey, and one without a numeric
 * updatedAt is in neither index. The first list or search on a connection
 * starts a repair in the background, 50 records per transaction, and does not
 * wait for it: listing reads the updatedAt index at once, and until the repair
 * is done a search reads records and falls back to their title. A repair that
 * fails is tried once more in the same session, then left alone.
 *
 * Every operation resolves when its transaction COMMITS (tx.oncomplete) and
 * rejects on error or abort. Resolving on request.onsuccess would report a write
 * as saved before the browser has durably committed it, and would still say
 * "saved" if the transaction is later rolled back (for example a quota error).
 */
import {safeGet} from './safe-storage.js';
import {extractTitle} from './doc-meta.js';

const DB_NAME = 'printmd';
const DB_VERSION = 2;          // the lowest version that has the indexes
const STORE_NAME = 'docs';
const INDEX_UPDATED = 'updatedAt';
const INDEX_TITLE = 'recentTitle';
const DEFAULT_LIMIT = 25;
/** How long an open waits for another tab that blocks the upgrade before it gives up. */
export const OPEN_BLOCKED_TIMEOUT_MS = 5000;
let openBlockedTimeoutMs = OPEN_BLOCKED_TIMEOUT_MS;

/** The current blocked-open wait in ms (OPEN_BLOCKED_TIMEOUT_MS unless a test changed it). */
export function openBlockedTimeout() {
    return openBlockedTimeoutMs;
}

/**
 * Change the blocked-open wait for this page. For test pages only (a test boots
 * the app itself and calls this first); nothing in the app calls it, and no URL
 * or stored setting reaches it. Anything but a positive finite number restores the default.
 */
export function setOpenBlockedTimeout(ms) {
    openBlockedTimeoutMs = Number.isFinite(ms) && ms > 0 ? ms : OPEN_BLOCKED_TIMEOUT_MS;
}
const REPAIR_CHUNK = 50;       // records per repair transaction
const REPAIR_ATTEMPTS = 2;     // per session: the first try and one retry

let _db = null;          // the open connection, once the open has succeeded
let _dbPromise = null;   // the single shared open (pending or settled)
let _generation = 0;     // bumped by closeDB so a late open result is discarded
let _repair = null;      // {db, done, promise} for the connection being repaired
let _repairFailures = 0; // failed repairs this session

function newId() {
    return crypto.randomUUID
        ? crypto.randomUUID()
        : 'doc-' + Date.now() + '-' + Math.round(Math.random() * 1e9);
}

/** The search key for a title: NFC-normalised and lowercased. */
function titleKeyOf(title) {
    return String(title == null ? '' : title).normalize('NFC').toLowerCase();
}

/** The key a record is searched by: its titleKey, or its title when it has none yet. */
function searchKeyOf(doc) {
    return typeof doc.titleKey === 'string' ? doc.titleKey : titleKeyOf(doc.title);
}

/** A usable updatedAt: a finite number (a Date or a numeric string becomes one), else undefined. */
function validTime(value) {
    let n = value;
    if (value instanceof Date) n = value.getTime();
    else if (typeof value === 'string' && value.trim() !== '') n = Number(value);
    return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
}

/** The record a save writes: id, updatedAt and titleKey always present. */
function toRecord(doc) {
    const given = validTime(doc.updatedAt);
    return {
        ...doc,
        id: doc.id || newId(),
        updatedAt: given !== undefined ? given : Date.now(),
        titleKey: titleKeyOf(doc.title),
    };
}

/** Key order as IndexedDB has it for the ids the app uses: numbers before strings. */
function compareKeys(a, b) {
    if (typeof a !== typeof b) return typeof a === 'number' ? -1 : 1;
    return a < b ? -1 : a > b ? 1 : 0;
}

/** Newest first; equal times in ascending id (the order the version 1 store listed them in). */
function compareRecent(a, b) {
    return (b.updatedAt - a.updatedAt) || compareKeys(a.id, b.id);
}

function cursorOf(doc) {
    return {updatedAt: doc.updatedAt, id: doc.id};
}

function checkCursor(before) {
    if (before == null) return null;
    if (typeof before !== 'object' || validTime(before.updatedAt) === undefined || before.id == null) {
        throw new TypeError('A page cursor is {updatedAt, id}');
    }
    return {updatedAt: validTime(before.updatedAt), id: before.id};
}

/** True when `doc` comes after the cursor in compareRecent order. */
function isAfter(doc, cursor) {
    return doc.updatedAt < cursor.updatedAt ||
        (doc.updatedAt === cursor.updatedAt && compareKeys(doc.id, cursor.id) > 0);
}

function checkLimit(limit) {
    if (limit === undefined) return DEFAULT_LIMIT;
    if (limit === Infinity) return Infinity;
    const n = Math.floor(Number(limit));
    return Number.isFinite(n) && n >= 0 ? n : DEFAULT_LIMIT;
}

function pageFrom(docs, limit) {
    const page = docs.slice(0, limit);
    return {docs: page, nextCursor: docs.length > limit && page.length ? cursorOf(page[page.length - 1]) : null};
}

/**
 * Entries read backwards from an index come newest first with equal times in
 * DESCENDING id. Reverse each run of equal times so they are in ascending id.
 */
function ascendTies(entries, timeOf) {
    const out = [];
    let run = [];
    for (const e of entries) {
        if (run.length && timeOf(run[0]) !== timeOf(e)) {
            out.push(...run.reverse());
            run = [];
        }
        run.push(e);
    }
    out.push(...run.reverse());
    return out;
}

function forget(db) {
    if (_db === db) {
        _db = null;
        _dbPromise = null;
    }
}

/** Create whatever part of the schema is missing (in an upgrade transaction). */
function ensureSchema(db, tx) {
    const docs = db.objectStoreNames.contains(STORE_NAME)
        ? tx.objectStore(STORE_NAME)
        : db.createObjectStore(STORE_NAME, {keyPath: 'id'});
    if (!docs.indexNames.contains(INDEX_UPDATED)) docs.createIndex(INDEX_UPDATED, 'updatedAt');
    if (!docs.indexNames.contains(INDEX_TITLE)) docs.createIndex(INDEX_TITLE, ['updatedAt', 'id', 'titleKey']);
}

// ── Is another tab upgrading? ─────────────────────────────────────────────────
// A tab whose open is queued behind another tab's upgrade gets no event at all,
// whether that upgrade is running (another tab on this code, on a big database)
// or itself blocked by a tab on old code. The tab running an upgrade answers
// "upgrading" on this channel, so a waiting tab can tell the two apart.
// BroadcastChannel works on plain http too (Web Locks need a secure context).
export const UPGRADE_CHANNEL = 'printmd-store';
let upgradingHere = 0;         // upgrade transactions running in this page
let channel;                   // undefined: not made yet; null: unavailable

function upgradeChannel() {
    if (channel !== undefined) return channel;
    try {
        channel = new BroadcastChannel(UPGRADE_CHANNEL);
        channel.addEventListener('message', (e) => {
            if (e.data && e.data.type === 'ask' && upgradingHere > 0) channel.postMessage({type: 'upgrading'});
        });
    } catch (_e) {
        channel = null;
    }
    return channel;
}

/**
 * True when another tab answers that it is running a database upgrade right
 * now, within `waitMs`; false when none answers (or the channel is unavailable).
 * @param {number} [waitMs]
 * @returns {Promise<boolean>}
 */
export function upgradeRunningElsewhere(waitMs = 250) {
    const ch = upgradeChannel();
    if (!ch) return Promise.resolve(false);
    return new Promise((resolve) => {
        let timer = null;
        const onMessage = (e) => { if (e.data && e.data.type === 'upgrading') done(true); };
        const done = (answer) => {
            clearTimeout(timer);
            ch.removeEventListener('message', onMessage);
            resolve(answer);
        };
        ch.addEventListener('message', onMessage);
        timer = setTimeout(() => done(false), waitMs);
        ch.postMessage({type: 'ask'});
    });
}

/**
 * One indexedDB.open request: at the database's own version when `version` is
 * undefined, else at `version` (upgrading it). Gives up with a clear error when
 * another tab blocks an upgrade for openBlockedTimeout() ms. `onBlocked` is
 * called once, when the wait starts; `onUpgrading` when this request's own
 * upgrade starts (nothing is waiting on another tab any more).
 */
function requestOpen(version, {onBlocked, onUpgrading} = {}) {
    return new Promise((resolve, reject) => {
        let settled = false;
        let blockedTimer = null;
        const fail = (error) => {
            if (settled) return;
            settled = true;
            clearTimeout(blockedTimer);
            reject(error);
        };

        let req;
        try {
            req = version === undefined ? indexedDB.open(DB_NAME) : indexedDB.open(DB_NAME, version);
        } catch (e) {
            fail(e);
            return;
        }

        // A new database, or one below version 2. Existing records stay as they
        // are; the background repair adds their titleKey.
        req.onupgradeneeded = () => {
            upgradingHere++;
            upgradeChannel();         // answer other tabs that ask (upgradeRunningElsewhere)
            if (onUpgrading) {
                try { onUpgrading(); } catch (_e) { /* the caller's note must not stop the upgrade */ }
            }
            ensureSchema(req.result, req.transaction);
            const tx = req.transaction;
            const finished = () => { upgradingHere = Math.max(0, upgradingHere - 1); };
            tx.addEventListener('complete', finished);
            tx.addEventListener('abort', finished);
        };

        // Another tab holds an older connection open and will not let go. Wait a
        // while (it usually does), then give up with a clear error.
        req.onblocked = () => {
            if (blockedTimer == null) {
                if (onBlocked) {
                    try { onBlocked(); } catch (_e) { /* the caller's note must not stop the open */ }
                }
                blockedTimer = setTimeout(
                    () => fail(new Error('IndexedDB is blocked by another open tab')),
                    openBlockedTimeoutMs);
            }
        };

        req.onsuccess = () => {
            const db = req.result;
            if (settled) { db.close(); return; }   // gave up while it was blocked
            settled = true;
            clearTimeout(blockedTimer);
            resolve(db);
        };

        req.onerror = () => fail(req.error || new Error('IndexedDB open failed'));
    });
}

/**
 * Open (or create) the IndexedDB. Concurrent callers share one connection.
 * A failed open is not cached, so the next call retries.
 * @param {{onBlocked?: Function, onUpgrading?: Function}} [opts]
 *   onBlocked: another tab holds the old version open, so the upgrade waits (up
 *   to openBlockedTimeout() ms). onUpgrading: this open's own upgrade has
 *   started, which can take a while on a big database but waits on no one.
 *   Only the call that starts the open can pass them.
 */
export function openDB({onBlocked, onUpgrading} = {}) {
    if (_dbPromise) return _dbPromise;

    const generation = _generation;
    const hooks = {onBlocked, onUpgrading};
    const attempt = (async () => {
        let db = await requestOpen(undefined, hooks);
        if (db.version < DB_VERSION) {
            db.close();
            db = await requestOpen(DB_VERSION, hooks);
        }
        // Closed (closeDB) while this open was in flight: do not keep a
        // connection nobody holds a reference to.
        if (generation !== _generation) {
            db.close();
            throw new Error('IndexedDB connection was closed while opening');
        }
        // Step aside when another tab/context needs to upgrade or delete the DB,
        // closing OUR connection (not whichever one is cached).
        db.onversionchange = () => { db.close(); forget(db); };
        // The browser closed the connection (storage cleared, disk error).
        db.onclose = () => forget(db);
        _db = db;
        return db;
    })();

    _dbPromise = attempt;
    attempt.catch(() => { if (_dbPromise === attempt) _dbPromise = null; });
    return attempt;
}

/** Close and clear the cached connection (test hygiene / explicit teardown). */
export function closeDB() {
    _generation++;
    if (_db) { try { _db.close(); } catch (_e) { /* already closed */ } }
    _db = null;
    _dbPromise = null;
}

/**
 * Run `work(objectStore)` in one transaction and resolve with whatever `work`
 * returns once the transaction has COMMITTED. `work` may return a function that
 * is called after commit to produce the value (used by reads).
 */
function runTx(mode, work, retried = false) {
    return openDB().then((db) => new Promise((resolve, reject) => {
        let tx;
        let result;
        try {
            tx = db.transaction(STORE_NAME, mode);
            result = work(tx.objectStore(STORE_NAME));
        } catch (e) {
            reject(e);
            return;
        }
        tx.oncomplete = () => resolve(typeof result === 'function' ? result() : result);
        tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed'));
        tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
    })).catch((e) => {
        // The connection was closing (versionchange/close) between open and use.
        if (!retried && e && e.name === 'InvalidStateError') {
            closeDB();
            return runTx(mode, work, true);
        }
        throw e;
    });
}

/**
 * The index repair for the open connection: started on first use, run in the
 * background, shared by every caller. Resolves true when every record is in
 * both indexes, false when the repair failed (or has failed too often).
 */
function startRepair() {
    return openDB().then((db) => {
        if (_repair && _repair.db === db) return _repair;
        if (_repairFailures >= REPAIR_ATTEMPTS) {
            _repair = {db, done: false, promise: Promise.resolve(false)};
            return _repair;
        }
        const state = {db, done: false};
        state.promise = repairIndexes().then(
            () => { state.done = true; return true; },
            () => {
                _repairFailures++;
                // Let the next read try again, unless that was the last attempt.
                if (_repair === state && _repairFailures < REPAIR_ATTEMPTS) _repair = null;
                return false;
            });
        _repair = state;
        return state;
    });
}

/** Resolves true once every record is in both indexes, false if the repair failed. */
export function indexRepair() {
    return startRepair().then((state) => state.promise, () => false);
}

/** Start the repair without waiting for it (reads must not wait for it). */
function repairInBackground() {
    startRepair().catch(() => { /* the read reports open errors itself */ });
}

/** True when the open connection's records are known to be fully indexed. */
function isRepaired() {
    return Boolean(_repair && _repair.done && _repair.db === _db);
}

/**
 * Give every record a titleKey and a numeric updatedAt, REPAIR_CHUNK records
 * per transaction with a pause between them, so saves and reads run in between.
 * Comparing counts first is cheap; only when they differ are records read.
 */
async function repairIndexes() {
    const [total, byTime, byTitle] = await runTx('readonly', (store) => {
        const counts = [store.count(), store.index(INDEX_UPDATED).count(), store.index(INDEX_TITLE).count()];
        return () => counts.map((r) => r.result);
    });
    if (byTime === total && byTitle === total) return;
    let after;   // primary key of the last record looked at
    for (;;) {
        const step = await runTx('readwrite', (store) => {
            const out = {last: undefined, done: false};
            const range = after === undefined ? null : IDBKeyRange.lowerBound(after, true);
            const request = store.openCursor(range);
            let seen = 0;
            request.onsuccess = () => {
                const cursor = request.result;
                if (!cursor) { out.done = true; return; }
                out.last = cursor.primaryKey;
                const doc = cursor.value;
                const updatedAt = validTime(doc.updatedAt);
                const titleKey = titleKeyOf(doc.title);
                if (doc.updatedAt !== updatedAt || doc.titleKey !== titleKey) {
                    // Without a usable time, sort it as the oldest (as the old in-memory sort did).
                    cursor.update({...doc, updatedAt: updatedAt !== undefined ? updatedAt : 0, titleKey});
                }
                if (++seen < REPAIR_CHUNK) cursor.continue();
            };
            return () => out;
        });
        if (step.done || step.last === undefined) return;
        after = step.last;
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
}

/** Upsert a doc. Generates id if missing, stamps updatedAt if not provided, sets titleKey. */
export function upsertDoc(doc) {
    const record = toRecord(doc);
    return runTx('readwrite', (store) => {
        store.put(record);
        return record;
    });
}

/** Fetch a single doc by id, or undefined if not found. */
export function getDoc(id) {
    return runTx('readonly', (store) => {
        const request = store.get(id);
        return () => request.result;
    });
}

/**
 * Walk the updatedAt index backwards from `cursor` (or the newest) and collect
 * up to `count` values that `keep` accepts, in compareRecent order. Reading goes
 * on to the end of a run of equal times, so the run can be put in ascending id.
 */
function readNewest(count, cursor, keep) {
    return runTx('readonly', (store) => {
        const found = [];   // {time, value}
        const range = cursor ? IDBKeyRange.upperBound(cursor.updatedAt) : null;
        const request = store.index(INDEX_UPDATED).openCursor(range, 'prev');
        request.onsuccess = () => {
            const c = request.result;
            if (!c) return;
            // Same time as the cursor: the ids at or below it were on the previous page.
            if (cursor && c.key === cursor.updatedAt && compareKeys(c.primaryKey, cursor.id) <= 0) {
                c.continue();
                return;
            }
            if (found.length >= count && c.key !== found[found.length - 1].time) return;
            if (keep(c.value)) found.push({time: c.key, value: c.value});
            c.continue();
        };
        return () => ascendTies(found, (e) => e.time).slice(0, count).map((e) => e.value);
    });
}

async function readRecent(count, cursor) {
    if (count === 0) return [];
    repairInBackground();
    return readNewest(count, cursor, () => true);
}

/** Docs newest first, at most `limit`; with `before`, only those after that cursor or doc. */
export async function listRecent(limit = DEFAULT_LIMIT, {before} = {}) {
    return readRecent(checkLimit(limit), checkCursor(before));
}

/** One page of docs, newest first: {docs, nextCursor}. nextCursor is null on the last page. */
export async function listPage({limit = DEFAULT_LIMIT, cursor = null} = {}) {
    const n = checkLimit(limit);
    if (n === 0) return {docs: [], nextCursor: null};
    return pageFrom(await readRecent(n + 1, checkCursor(cursor)), n);
}

/**
 * Docs whose title contains `query` (NFC, case-insensitive), newest first, at
 * most `limit`. Once the repair is done it walks the recentTitle index keys,
 * which hold the titleKey, so only the matching records are loaded. Before
 * that it reads records and matches their title when they have no titleKey.
 */
export async function searchTitles(query, limit = DEFAULT_LIMIT) {
    const needle = titleKeyOf(query).trim();
    const n = checkLimit(limit);
    if (!needle) return listRecent(n);
    if (n === 0) return [];
    await openDB();
    repairInBackground();
    if (!isRepaired()) return readNewest(n, null, (doc) => searchKeyOf(doc).includes(needle));
    return runTx('readonly', (store) => {
        const matches = [];   // {time, id}
        const results = [];
        const fetch = () => {
            const ids = ascendTies(matches, (m) => m.time).slice(0, n);
            ids.forEach((m, slot) => {
                const get = store.get(m.id);
                get.onsuccess = () => { results[slot] = get.result; };
            });
        };
        const request = store.index(INDEX_TITLE).openKeyCursor(null, 'prev');
        request.onsuccess = () => {
            const c = request.result;
            if (!c) { fetch(); return; }
            const time = c.key[0];
            if (matches.length >= n && time !== matches[matches.length - 1].time) { fetch(); return; }
            if (String(c.key[2]).includes(needle)) matches.push({time, id: c.primaryKey});
            c.continue();
        };
        return () => results.filter(Boolean);
    });
}

/** Delete a doc by id. */
export function deleteDoc(id) {
    return runTx('readwrite', (store) => {
        store.delete(id);
    });
}

/**
 * One-time migration from localStorage key 'printmd-state'.
 * Safe to call multiple times (no-op if docs already exist).
 * Returns the created doc, or null. Anything that is not the expected shape
 * ({source: string, templateId?: string}) is ignored rather than trusted.
 */
export async function migrateFromLocalStorage() {
    const raw = safeGet('printmd-state');
    if (!raw) return null;

    const existing = await listRecent(1);
    if (existing.length > 0) return null;

    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return null;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || typeof parsed.source !== 'string') {
        return null;
    }

    const source = parsed.source;

    return upsertDoc({
        title: extractTitle(source),
        snapshot: source,
        templateId: typeof parsed.templateId === 'string' ? parsed.templateId : undefined,
        origin: 'local',
        updatedAt: Date.now(),
    });
}

/**
 * In-memory store with the same interface. The app falls back to this when
 * IndexedDB cannot be opened, so it stays usable (changes last until the tab closes).
 */
export function createMemoryStore() {
    const docs = new Map();
    const recent = (count, cursor) => [...docs.values()]
        .filter((d) => !cursor || isAfter(d, cursor))
        .sort(compareRecent)
        .slice(0, count)
        .map((d) => ({...d}));
    return {
        // Starts empty every session: docmanager must not treat "doc not found
        // here" as "doc deleted" (e.g. when deciding to drop the crash buffer).
        isMemory: true,
        async upsertDoc(doc) {
            const record = toRecord(doc);
            docs.set(record.id, {...record});
            return record;
        },
        async getDoc(id) {
            const doc = docs.get(id);
            return doc ? {...doc} : undefined;
        },
        async listRecent(limit = DEFAULT_LIMIT, {before} = {}) {
            return recent(checkLimit(limit), checkCursor(before));
        },
        async listPage({limit = DEFAULT_LIMIT, cursor = null} = {}) {
            const n = checkLimit(limit);
            if (n === 0) return {docs: [], nextCursor: null};
            return pageFrom(recent(n + 1, checkCursor(cursor)), n);
        },
        async searchTitles(query, limit = DEFAULT_LIMIT) {
            const needle = titleKeyOf(query).trim();
            const n = checkLimit(limit);
            return [...docs.values()]
                .filter((d) => searchKeyOf(d).includes(needle))
                .sort(compareRecent)
                .slice(0, n)
                .map((d) => ({...d}));
        },
        async indexRepair() {
            return true;
        },
        async deleteDoc(id) {
            docs.delete(id);
        },
        async migrateFromLocalStorage() {
            return null;
        },
    };
}
