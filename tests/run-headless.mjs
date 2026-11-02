/**
 * tests/run-headless.mjs
 *
 * Tiny zero-dependency headless test runner for browser-only smoke tests
 * (IndexedDB, File System Access, OOXML blob generation) that cannot run under
 * Node's test runner. Drives a real headless Chrome via the DevTools Protocol.
 *
 * A test page is "settled" when either:
 *   - document.title contains PASS or FAIL (e.g. STORE_PASS, DOCMGR_FAIL), or
 *   - #summary reads "N passed · M failed · T total" (the table-style pages).
 *
 * Library use (tests/run-all.mjs):
 *   import {runHeadless} from './run-headless.mjs';
 *   const r = await runHeadless('http://127.0.0.1:1234/tests/store.test.html');
 *
 * CLI use (serve the project over http first; IndexedDB needs a real origin,
 * e.g. `python3 -m http.server 8080`):
 *   node tests/run-headless.mjs <url> [timeoutMs] [--check "<jsExpr>"]
 *   Default: exit 0 if the page settles as a pass, 1 otherwise.
 *   With --check: poll <jsExpr> and exit 0 when it evaluates strictly true.
 *
 * Requires Node 22 (global WebSocket + fetch) and `google-chrome` on PATH
 * (override with CHROME_BIN).
 */
import {pathToFileURL} from 'node:url';
import {launchChrome, sleep} from './lib/chrome.mjs';

async function findPageSocket(port) {
    for (let i = 0; i < 80; i++) {
        try {
            const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
            const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
            if (page) return page.webSocketDebuggerUrl;
        } catch (_e) { /* devtools not up yet */ }
        await sleep(250);
    }
    throw new Error('no DevTools page target');
}

/** A DevTools call that got no answer in time (code 'CDP_TIMEOUT'): the page is busy or hung. */
function cdpTimeout(method, ms) {
    const e = new Error(`DevTools ${method} got no answer within ${ms} ms (the page is busy or hung)`);
    e.code = 'CDP_TIMEOUT';
    return e;
}

/**
 * Open a CDP session on a page socket. Every call has a deadline
 * (callTimeoutMs, or the timeoutMs passed to send): a page whose renderer is
 * busy never answers Runtime.evaluate, and an await without a deadline would
 * hang the whole run. Closing the session rejects any call still waiting.
 */
async function connect(wsUrl, {callTimeoutMs = 5000} = {}) {
    const ws = new WebSocket(wsUrl);
    let id = 1;
    const pending = new Map();
    const settle = (_id, fn, value) => {
        const p = pending.get(_id);
        if (!p) return;
        pending.delete(_id);
        clearTimeout(p.timer);
        p[fn](value);
    };
    ws.addEventListener('message', (ev) => {
        const m = JSON.parse(ev.data);
        if (m.id && pending.has(m.id)) {
            if (m.error) settle(m.id, 'rej', new Error(`${m.error.message}`));
            else settle(m.id, 'res', m.result);
        }
    });
    ws.addEventListener('close', () => {
        for (const _id of [...pending.keys()]) settle(_id, 'rej', new Error('DevTools socket closed'));
    });
    await new Promise((res, rej) => {
        const timer = setTimeout(() => rej(cdpTimeout('connect', callTimeoutMs)), callTimeoutMs);
        ws.addEventListener('open', () => { clearTimeout(timer); res(); }, {once: true});
        ws.addEventListener('error', () => { clearTimeout(timer); rej(new Error('DevTools socket error')); }, {once: true});
    });
    const send = (method, params = {}, {timeoutMs = callTimeoutMs} = {}) => new Promise((res, rej) => {
        const _id = id++;
        const timer = setTimeout(() => settle(_id, 'rej', cdpTimeout(method, timeoutMs)), timeoutMs);
        pending.set(_id, {res, rej, timer});
        try {
            ws.send(JSON.stringify({id: _id, method, params}));
        } catch (e) {
            settle(_id, 'rej', e);
        }
    });
    const evalExpr = async (expr, opts) => {
        const r = await send('Runtime.evaluate', {expression: expr, returnByValue: true, awaitPromise: false}, opts);
        return r && r.result ? r.result.value : undefined;
    };
    // Runtime.evaluate works without it; a busy page may not answer it, so wait at most a second.
    await send('Runtime.enable', {}, {timeoutMs: Math.min(callTimeoutMs, 1000)})
        .catch((e) => { if (e.code !== 'CDP_TIMEOUT') throw e; });
    return {evalExpr, send, close: () => { try { ws.close(); } catch (_e) { /* closed */ } }};
}

const SUMMARY_RE = /(\d+)\s+passed\s*·\s*(\d+)\s+failed/;

/**
 * Run one test page to completion.
 *
 * A page that never settles fails as timed out after timeoutMs, also when its
 * renderer is so busy it answers no DevTools call: each call has a deadline
 * (callTimeoutMs), an unanswered poll counts as "not settled yet", and a hard
 * deadline (timeoutMs plus three call deadlines) ends the run whatever happens.
 * Chrome is always stopped, so one slow page fails that page and the next runs.
 * @param {string} url
 * @param {{timeoutMs?: number, checkExpr?: string|null, callTimeoutMs?: number}} [opts]
 * @returns {Promise<{ok: boolean, title: string, result: string, summary: string, failures: string[], detail: string, value?: any, timedOut: boolean}>}
 */
export async function runHeadless(url, {timeoutMs = 25000, checkExpr = null, callTimeoutMs = 5000} = {}) {
    const out = {ok: false, title: '', result: '', summary: '', failures: [], detail: '', timedOut: false};
    const browser = await launchChrome(url);
    let session;
    let unresponsive = false;
    // A poll the page does not answer in time: noted, and treated as "not settled yet".
    const poll = async (expr) => {
        try {
            return await session.evalExpr(expr);
        } catch (e) {
            if (e.code !== 'CDP_TIMEOUT') throw e;
            unresponsive = true;
            return undefined;
        }
    };

    const work = async () => {
        session = await connect(await findPageSocket(browser.port), {callTimeoutMs});
        const start = Date.now();

        if (checkExpr) {
            // Readiness-expression mode: poll until the expression is strictly true.
            let val;
            while (Date.now() - start < timeoutMs) {
                val = await poll(`(() => { try { return !!(${checkExpr}); } catch (e) { return 'ERR:' + e.message; } })()`);
                if (val === true) break;
                await sleep(400);
            }
            out.value = val;
            out.ok = val === true;
            out.timedOut = !out.ok;
        } else {
            let settled = false;
            while (Date.now() - start < timeoutMs) {
                unresponsive = false;
                out.title = (await poll('document.title')) || '';
                // An unanswered poll ends this round, so a busy page costs one deadline per round, not three.
                if (unresponsive) continue;
                out.result = (await poll("(document.getElementById('result')||{}).textContent||''")) || '';
                out.summary = (await poll("(document.getElementById('summary')||{}).textContent||''")) || '';
                const m = SUMMARY_RE.exec(out.summary);
                if (/PASS|FAIL/.test(out.title)) {
                    settled = true;
                    out.ok = /PASS/.test(out.title) && !/FAIL/.test(out.title);
                    break;
                }
                if (m) {
                    settled = true;
                    out.ok = Number(m[2]) === 0 && Number(m[1]) > 0;
                    break;
                }
                await sleep(400);
            }
            out.timedOut = !settled;
        }

        if (out.timedOut && unresponsive) {
            out.detail = `timed out: the page answered no DevTools call within ${callTimeoutMs} ms (busy or hung)`;
            return;
        }
        out.title = (await poll('document.title')) || out.title;
        out.detail = (await poll('window.__detail !== undefined ? JSON.stringify(window.__detail) : ""')) || '';
        if (!out.ok) {
            const rows = await poll("JSON.stringify([...document.querySelectorAll('tr.fail')].map(tr => tr.textContent.replace(/\\s+/g, ' ').trim()))");
            try { out.failures = JSON.parse(rows || '[]'); } catch (_e) { /* none */ }
        }
    };

    let timer;
    const hardDeadline = new Promise((resolve) => {
        timer = setTimeout(() => resolve('deadline'), timeoutMs + 3 * callTimeoutMs);
    });
    try {
        // work() keeps running after a deadline until the socket closes; its late failure is not reported.
        const running = work().then(() => 'done', (e) => e);
        const first = await Promise.race([running, hardDeadline]);
        if (first === 'deadline') {
            out.ok = false;
            out.timedOut = true;
            out.detail = `timed out: no result within ${timeoutMs} ms`;
        } else if (first instanceof Error) {
            out.ok = false;
            out.detail = `runner error: ${first.message}`;
        }
        return out;
    } finally {
        clearTimeout(timer);
        if (session) session.close();
        await browser.stop();
    }
}

/**
 * Open a page, wait until `readyExpr` is strictly true, and return the value
 * of `valueExpr` (JSON-serialisable; promises are awaited).
 * @param {string} url
 * @param {string} readyExpr
 * @param {string} valueExpr
 * @param {{timeoutMs?: number}} [opts]
 * @returns {Promise<any>}
 */
export async function evaluateInPage(url, readyExpr, valueExpr, {timeoutMs = 30000} = {}) {
    return withPage(url, async (session) => {
        await session.waitFor(readyExpr, timeoutMs);
        return session.evalExpr(valueExpr);
    });
}

/**
 * Open a page in a throwaway headless Chrome and run `fn` with its DevTools
 * session: evalExpr(expr), send(method, params) for any CDP command, and
 * waitFor(expr, timeoutMs) which polls until `expr` is strictly true.
 * @template T
 * @param {string} url
 * @param {(session: {evalExpr: Function, send: Function, waitFor: Function}) => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withPage(url, fn) {
    const browser = await launchChrome(url);
    let session;
    try {
        // Tool sessions print PDFs and read large values: a longer deadline per call, still not none.
        session = await connect(await findPageSocket(browser.port), {callTimeoutMs: 60000});
        const s = session;
        s.waitFor = async (expr, timeoutMs = 30000) => {
            const start = Date.now();
            while (await s.evalExpr(`(() => { try { return (${expr}) === true; } catch (e) { return false; } })()`) !== true) {
                if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${expr}`);
                await sleep(300);
            }
        };
        return await fn(s);
    } finally {
        if (session) session.close();
        await browser.stop();
    }
}

// ── CLI ──────────────────────────────────────────────────────────────────────
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const url = process.argv[2];
    const checkIdx = process.argv.indexOf('--check');
    const checkExpr = checkIdx > -1 ? process.argv[checkIdx + 1] : null;
    const timeoutMs = process.argv[3] && !process.argv[3].startsWith('--') ? Number(process.argv[3]) : 25000;
    if (!url) {
        console.error('usage: node tests/run-headless.mjs <url> [timeoutMs] [--check "<jsExpr>"]');
        process.exit(2);
    }
    const r = await runHeadless(url, {timeoutMs, checkExpr});
    if (checkExpr) {
        console.log('CHECK :', checkExpr);
        console.log('VALUE :', r.value);
    }
    console.log('TITLE :', r.title);
    if (!checkExpr) {
        console.log('RESULT:', r.result || r.summary);
        for (const f of r.failures) console.log('FAILED:', f);
    }
    console.log('DETAIL:', r.detail);
    process.exit(r.ok ? 0 : 1);
}
