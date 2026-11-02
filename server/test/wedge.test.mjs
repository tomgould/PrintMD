/**
 * A wedged Chromium must not hold render slots: a browser that never hands
 * out a context, never opens a page, or never closes one is killed and
 * replaced, the slot is freed, and /health says "degraded" until a render
 * succeeds again.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRenderer} from '../src/renderer.mjs';
import {BrowserPool, findChrome} from '../src/browser.mjs';
import {Limiter} from '../src/limiter.mjs';
import {CHROME, startTestApi, render, toResult, DEFAULT_TEMPLATE} from './helpers.mjs';

const never = () => new Promise(() => {});

/** A pool whose browser misbehaves as told; records what the renderer did to it. */
function stubPool({acquire, newContext}) {
    const calls = {forceRestart: 0, kill: 0, release: 0, succeeded: 0};
    const browser = {newContext};
    return {
        calls,
        acquire: acquire || (async () => ({
            browser,
            release: () => { calls.release++; },
            kill: () => { calls.kill++; },
        })),
        forceRestart: () => { calls.forceRestart++; },
        renderSucceeded: () => { calls.succeeded++; },
    };
}

async function settlesWithin(promise, ms) {
    const t0 = Date.now();
    const outcome = await Promise.race([
        promise.then(() => ({ok: true}), (error) => ({error})),
        new Promise((r) => setTimeout(() => r({hung: true}), ms)),
    ]);
    return {...outcome, ms: Date.now() - t0};
}

test('acquire that never resolves: 504 within its own timeout, and the browser is force-restarted', async () => {
    const pool = stubPool({acquire: never});
    const renderer = createRenderer({pool, timeoutMs: 400, acquireTimeoutMs: 300, closeTimeoutMs: 200});
    const r = await settlesWithin(renderer.render({markdown: '# x', templateId: DEFAULT_TEMPLATE}), 3000);
    assert.ok(!r.hung, 'render settled');
    assert.equal(r.error && r.error.status, 504);
    assert.equal(pool.calls.forceRestart, 1);
});

test('newContext that never resolves: 504, the browser is killed and the lease released', async () => {
    const pool = stubPool({newContext: never});
    const renderer = createRenderer({pool, timeoutMs: 300, acquireTimeoutMs: 300, closeTimeoutMs: 200});
    const r = await settlesWithin(renderer.render({markdown: '# x', templateId: DEFAULT_TEMPLATE}), 3000);
    assert.ok(!r.hung, 'render settled');
    assert.equal(r.error && r.error.status, 504);
    assert.equal(pool.calls.kill, 1);
    assert.equal(pool.calls.release, 1);
});

test('a page that never opens and a context that never closes: 504, then killed and released', async () => {
    const context = {route: async () => {}, newPage: never, close: never};
    const pool = stubPool({newContext: async () => context});
    const renderer = createRenderer({pool, timeoutMs: 300, acquireTimeoutMs: 300, closeTimeoutMs: 200});
    const r = await settlesWithin(renderer.render({markdown: '# x', templateId: DEFAULT_TEMPLATE}), 3000);
    assert.ok(!r.hung, `render settled (${r.ms} ms)`);
    assert.equal(r.error && r.error.status, 504);
    assert.equal(pool.calls.kill, 1);
    assert.equal(pool.calls.release, 1);
});

/** A context whose pages answer every step, and whose print fails with `printError`. */
function printingContext(printError) {
    const prepared = {html: '<html><head></head><body><p>x</p></body></html>', title: 'x', warnings: [],
        pageOpts: {pageSize: 'A4', orientation: 'portrait', margin: '20mm'}, print: {}, cover: false};
    const page = {
        goto: async () => {}, waitForFunction: async () => {}, close: async () => {}, on: () => {},
        setViewportSize: async () => {}, emulateMedia: async () => {},
        // prepare, the readiness wait, checkFonts and checkImages: one answer fits all four.
        evaluate: async () => prepared,
        pdf: async () => { throw printError; },
    };
    return {route: async () => {}, newPage: async () => page, close: async () => {}};
}

test('Chromium answering "Printing failed" (one table of ~30,000 rows): 413 too_large_to_render, not 500', async () => {
    const error = new Error('page.pdf: Protocol error (Page.printToPDF): Printing failed');
    const pool = stubPool({newContext: async () => printingContext(error)});
    const renderer = createRenderer({pool, timeoutMs: 2000, acquireTimeoutMs: 1000, closeTimeoutMs: 500});
    const r = await settlesWithin(renderer.render({markdown: '# x', templateId: DEFAULT_TEMPLATE, tidy: false}), 3000);
    assert.ok(!r.hung, 'render settled');
    assert.equal(r.error && r.error.status, 413);
    assert.equal(r.error.code, 'too_large_to_render');
    assert.doesNotMatch(r.error.message, /Protocol error|printToPDF/, 'no Chromium text in the answer');
    assert.equal(pool.calls.kill, 0, 'the browser is fine: not killed');
    assert.equal(pool.calls.release, 1);
});

test('only Chromium\'s exact "Printing failed" answer is 413; near misses and crashes stay 500', async () => {
    const statusFor = async (message) => {
        const pool = stubPool({newContext: async () => printingContext(new Error(message))});
        const renderer = createRenderer({pool, timeoutMs: 2000, acquireTimeoutMs: 1000, closeTimeoutMs: 500});
        const r = await settlesWithin(renderer.render({markdown: '# x', templateId: DEFAULT_TEMPLATE, tidy: false}), 3000);
        return r.error && `${r.error.status} ${r.error.code}`;
    };
    // Playwright appends a call log on the next lines; the answer is still Chromium's.
    assert.equal(await statusFor('page.pdf: Protocol error (Page.printToPDF): Printing failed\nCall log:\n  - x'),
        '413 too_large_to_render');
    for (const message of [
        'page.pdf: Target crashed',
        'page.pdf: Target page, context or browser has been closed',
        'page.pdf: Navigation failed',
        'page.pdf: Protocol error (Page.printToPDF): printing failed',
        'page.pdf: Protocol error (Page.printToPDF): Reprinting failed',
        'page.pdf: Protocol error (Page.printToPDF): Printing failed twice',
        'page.pdf: Protocol error (Page.navigate): Printing failed',
        'Printing failed',
        'page.pdf: Timeout 30000ms exceeded.',
    ]) {
        assert.equal(await statusFor(message), '500 render_failed', JSON.stringify(message));
    }
});

test('a print that outlasts the render limit is 504 render_timeout, not 413', async () => {
    const context = printingContext(null);
    const page = await context.newPage();
    page.pdf = never;
    const pool = stubPool({newContext: async () => context});
    const renderer = createRenderer({pool, timeoutMs: 300, acquireTimeoutMs: 300, closeTimeoutMs: 200});
    const r = await settlesWithin(renderer.render({markdown: '# x', templateId: DEFAULT_TEMPLATE, tidy: false}), 3000);
    assert.ok(!r.hung, 'render settled');
    assert.equal(r.error && `${r.error.status} ${r.error.code}`, '504 render_timeout');
});

test('wedged renders free their limiter slots', async () => {
    const pool = stubPool({newContext: never});
    const renderer = createRenderer({pool, timeoutMs: 200, acquireTimeoutMs: 200, closeTimeoutMs: 100});
    const limiter = new Limiter({maxActive: 2, maxQueue: 6});
    const runs = Array.from({length: 4}, () => limiter.run(() => renderer.render({markdown: '# x', templateId: DEFAULT_TEMPLATE})).catch((e) => e.status));
    const r = await settlesWithin(Promise.all(runs), 4000);
    assert.ok(!r.hung, 'all four settled');
    assert.deepEqual(limiter.stats(), {active: 0, waiting: 0, maxActive: 2, maxQueue: 6});
});

test('real pool: forceRestart kills the Chromium process; health says degraded until a render succeeds', async () => {
    const api = await startTestApi();
    try {
        assert.equal((await render(api.url, '# Warm up')).status, 200);
        const pid = api.pool.browserPid();
        assert.ok(pid > 0, 'browser pid known');
        api.pool.forceRestart();
        await new Promise((r) => setTimeout(r, 500));
        assert.throws(() => process.kill(pid, 0), /ESRCH/, 'the old Chromium is gone');
        const degraded = await toResult(await fetch(`${api.url}/api/v1/health`));
        assert.equal(degraded.json.status, 'degraded');
        assert.equal(degraded.json.browser.state, 'degraded');
        assert.equal((await render(api.url, '# After\n\nfine')).status, 200);
        const healthy = await toResult(await fetch(`${api.url}/api/v1/health`));
        assert.equal(healthy.json.status, 'ok');
        assert.equal(healthy.json.browser.state, 'up');
        assert.notEqual(api.pool.browserPid(), pid);
    } finally {
        await api.close();
    }
});

test('real pool: a forced restart during launch kills the late browser too', async () => {
    const pool = new BrowserPool({executablePath: findChrome(CHROME)});
    try {
        const pending = pool.acquire();
        pool.forceRestart();
        const lease = await pending.catch(() => null);
        if (lease) lease.release();
        const next = await pool.acquire();
        assert.ok(next.browser.isConnected(), 'a fresh browser is handed out');
        next.release();
    } finally {
        await pool.close();
    }
});
