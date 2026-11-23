/**
 * js/safe-storage.js
 *
 * localStorage that cannot throw. Reading or even touching `localStorage` raises
 * SecurityError when site data is blocked (some privacy modes, sandboxed frames,
 * a full quota on write). Every caller gets a plain "nothing there / not saved"
 * answer instead of an exception that would abort startup.
 */

export function safeGet(key) {
    try { return localStorage.getItem(key); } catch (_e) { return null; }
}

/** @returns {boolean} true if the value was stored */
export function safeSet(key, value) {
    try { localStorage.setItem(key, value); return true; } catch (_e) { return false; }
}

export function safeRemove(key) {
    try { localStorage.removeItem(key); return true; } catch (_e) { return false; }
}

/** Parse a JSON value from storage; `fallback` if missing, unreadable or invalid. */
export function safeGetJSON(key, fallback = null) {
    const raw = safeGet(key);
    if (raw == null) return fallback;
    try { return JSON.parse(raw); } catch (_e) { return fallback; }
}

/** True if localStorage can be read and written (used to warn the user once). */
export function storageAvailable() {
    const probe = '__printmd-probe__';
    try {
        localStorage.setItem(probe, '1');
        localStorage.removeItem(probe);
        return true;
    } catch (_e) {
        return false;
    }
}
