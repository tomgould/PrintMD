/**
 * tests/lib/harness.js
 *
 * Tiny per-test harness for the browser test pages. Unlike a throw-on-first-failure
 * script, every test runs and is reported by name, so tests/run-all.mjs can say
 * exactly which scenario failed. Renders the same "N passed · M failed" summary
 * and tr.pass/tr.fail rows as the other table-style pages.
 */

// A hang guard, not a speed check: generous so a slow CI CPU cannot trip it
// (the runner's 30 s page limit still bounds every page).
const TEST_TIMEOUT_MS = 20000;

export function assert(cond, message) {
    if (!cond) throw new Error(message || 'Assertion failed');
}

/** Delete the app database and the localStorage keys the app uses. */
export async function resetStorage(store) {
    if (store && store.closeDB) store.closeDB();
    await new Promise((resolve) => {
        const req = indexedDB.deleteDatabase('printmd');
        req.onsuccess = () => resolve();
        req.onerror = () => resolve();
        req.onblocked = () => setTimeout(resolve, 200);
    });
    for (const key of ['printmd-state', 'printmd-crash']) {
        try { localStorage.removeItem(key); } catch (_e) { /* storage unavailable */ }
    }
}

/**
 * @param {string} prefix  title prefix, e.g. 'DOCMGR' gives DOCMGR_PASS / DOCMGR_FAIL
 * @param {{timeoutMs?: number}} [opts]  per-test timeout (default 8 s)
 */
export function createHarness(prefix, {timeoutMs = TEST_TIMEOUT_MS} = {}) {
    const tests = [];

    function withTimeout(promise) {
        let timer;
        const timeout = new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
        });
        return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
    }

    function render(results) {
        const tbody = document.getElementById('results');
        let pass = 0;
        let fail = 0;
        for (const r of results) {
            const tr = document.createElement('tr');
            tr.className = r.pass ? 'pass' : 'fail';
            for (const text of [r.name, r.pass ? 'pass' : 'FAIL', r.detail]) {
                const td = document.createElement('td');
                td.textContent = text;
                tr.appendChild(td);
            }
            tbody.appendChild(tr);
            r.pass ? pass++ : fail++;
        }
        const summary = document.getElementById('summary');
        summary.textContent = `${pass} passed · ${fail} failed · ${results.length} total`;
        summary.style.color = fail > 0 ? '#cc2222' : '#22a663';
        window.__detail = {results};
        document.title = `${prefix}_${fail === 0 ? 'PASS' : 'FAIL'}`;
    }

    return {
        test(name, fn) { tests.push({name, fn}); },
        async run() {
            const results = [];
            for (const t of tests) {
                const t0 = performance.now();
                // ms (in window.__detail) shows which test makes a page slow; no test is judged by it.
                const ms = () => Math.round(performance.now() - t0);
                try {
                    await withTimeout(Promise.resolve().then(t.fn));
                    results.push({name: t.name, pass: true, detail: '', ms: ms()});
                } catch (e) {
                    results.push({name: t.name, pass: false, detail: (e && e.message) || String(e), ms: ms()});
                }
            }
            render(results);
            return results;
        },
    };
}
