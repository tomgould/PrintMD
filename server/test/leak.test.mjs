/**
 * No Chromium process outlives its use: every way a browser leaves the pool
 * (its connection drops, it crashes, it is force-restarted, recycled, or the
 * pool shuts down) kills the browser process and all its children. Counted
 * from /proc: Chromium processes descended from this test process.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {BrowserPool, findChrome} from '../src/browser.mjs';
import {CHROME, chromiumDescendants, until} from './helpers.mjs';

const newPool = (opts = {}) => new BrowserPool({executablePath: findChrome(CHROME), ...opts});
const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms));

test('baseline: no Chromium before a pool starts one', () => {
    assert.deepEqual(chromiumDescendants(), []);
});

test('a dropped connection: the browser process and its children are killed, then replaced', async () => {
    const pool = newPool();
    try {
        const lease = await pool.acquire();
        const before = chromiumDescendants();
        assert.ok(before.length > 0, 'Chromium is running');
        // Playwright's connection goes away while Chromium itself keeps running.
        await lease.browser.close();
        lease.release();
        assert.ok(await until(() => chromiumDescendants().length === 0), `left running: ${chromiumDescendants()}`);
        const next = await pool.acquire();
        assert.ok(next.browser.isConnected());
        next.release();
    } finally {
        await pool.close();
    }
    assert.ok(await until(() => chromiumDescendants().length === 0), 'shutdown leaves nothing');
});

test('a crash (main process killed): its children go too', async () => {
    const pool = newPool();
    try {
        const lease = await pool.acquire();
        process.kill(pool.browserPid(), 'SIGKILL');
        lease.release();
        assert.ok(await until(() => chromiumDescendants().length === 0), `left running: ${chromiumDescendants()}`);
    } finally {
        await pool.close();
    }
});

test('forceRestart, recycling and shutdown leave no Chromium behind', async () => {
    const pool = newPool({maxRenders: 1});
    try {
        (await pool.acquire()).release();
        await settle();
        pool.forceRestart();
        assert.ok(await until(() => chromiumDescendants().length === 0), `after forceRestart: ${chromiumDescendants()}`);
        for (let i = 0; i < 3; i++) (await pool.acquire()).release(); // each one retired after 1 render
        await settle(1000);
        const oneBrowser = chromiumDescendants().length;
        (await pool.acquire()).release();
        await settle(1000);
        assert.ok(chromiumDescendants().length <= oneBrowser, 'retired browsers do not pile up');
    } finally {
        await pool.close();
    }
    assert.ok(await until(() => chromiumDescendants().length === 0), `after close: ${chromiumDescendants()}`);
});
