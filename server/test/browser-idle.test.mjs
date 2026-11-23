/**
 * The browser closes itself when nothing has rendered for a while (PRINTMD_BROWSER_IDLE_S), so a
 * service on a desktop costs no browser memory or CPU between PDFs; the next render starts it again.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {loadConfig, ConfigError} from '../src/config.mjs';
import {BrowserPool, findChrome} from '../src/browser.mjs';
import {startTestApi, render, CHROME, chromiumDescendants, until, DEFAULT_QUERY} from './helpers.mjs';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const alive = (pid) => {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
};
/** Is any process of the browser's process group left (its helpers, GPU and renderer processes included)? */
const groupAlive = (pid) => {
    try {
        process.kill(-pid, 0);
        return true;
    } catch {
        return false;
    }
};

test('config: PRINTMD_BROWSER_IDLE_S is seconds, off by default, and refuses nonsense', () => {
    assert.equal(loadConfig({env: {}, argv: ['--local']}).browserIdleMs, 0);
    assert.equal(loadConfig({env: {PRINTMD_BROWSER_IDLE_S: '60'}, argv: ['--local']}).browserIdleMs, 60_000);
    assert.equal(loadConfig({env: {PRINTMD_BROWSER_IDLE_S: '0'}, argv: ['--local']}).browserIdleMs, 0);
    for (const bad of ['abc', '-1', '1.5', '86401', '60s']) {
        assert.throws(() => loadConfig({env: {PRINTMD_BROWSER_IDLE_S: bad}, argv: ['--local']}), ConfigError, bad);
    }
});

test('pool: the browser closes after the idle time, and the next acquire starts a fresh one', async () => {
    const pool = new BrowserPool({executablePath: findChrome(CHROME), idleCloseMs: 500});
    try {
        const first = await pool.acquire();
        const pid = pool.browserPid();
        assert.ok(pid > 0 && alive(pid), 'a browser is running for the render');
        await wait(800);
        assert.equal(pool.status().state, 'up', 'a render in progress keeps it open, however long it takes');
        first.release();
        await wait(250);
        assert.equal(pool.status().state, 'up', 'still open just after the last render');
        await wait(700);
        assert.equal(pool.status().state, 'idle', 'closed after the idle time');
        assert.equal(pool.browserPid(), 0);
        await wait(200);
        assert.ok(!alive(pid), 'the browser process is gone, not just forgotten');
        assert.ok(!groupAlive(pid), 'and so is every helper process of its group');
        const second = await pool.acquire();
        assert.equal(pool.status().state, 'up', 'started again on demand');
        assert.notEqual(pool.browserPid(), pid);
        second.release();
    } finally {
        await pool.close();
    }
});

test('pool: a render that starts during the idle wait cancels the close', async () => {
    const pool = new BrowserPool({executablePath: findChrome(CHROME), idleCloseMs: 500});
    try {
        (await pool.acquire()).release();
        const pid = pool.browserPid();
        await wait(300);
        const again = await pool.acquire();
        await wait(600);
        assert.equal(pool.browserPid(), pid, 'the same browser, still open, past the first deadline');
        again.release();
    } finally {
        await pool.close();
    }
});

test('the whole API: a render leaves no tab or context open, the browser closes when idle, the next render starts it again', async () => {
    const api = await startTestApi({env: {PRINTMD_BROWSER_IDLE_S: '1'}});
    try {
        assert.deepEqual(chromiumDescendants(), [], 'no browser before the first render');
        const first = await render(api.url, '# One\n\nHello', DEFAULT_QUERY);
        assert.equal(first.status, 200);
        const lease = api.pool.current;
        assert.ok(lease, 'the browser is up right after a render');
        assert.equal(lease.browser.contexts().length, 0, 'the render closed its context, and with it every tab');
        assert.ok(await until(() => api.pool.status().state === 'idle', 4000), 'the browser closes about a second after the last render');
        assert.ok(await until(() => chromiumDescendants().length === 0, 4000), `no Chromium process is left: ${chromiumDescendants()}`);
        const second = await render(api.url, '# Two\n\nAgain', DEFAULT_QUERY);
        assert.equal(second.status, 200, 'a render after the browser closed starts it again');
        assert.ok(await until(() => chromiumDescendants().length === 0, 5000), 'and it closes again');
    } finally {
        await api.close();
    }
});

test('pool: without an idle time the browser stays open', async () => {
    const pool = new BrowserPool({executablePath: findChrome(CHROME)});
    try {
        (await pool.acquire()).release();
        const pid = pool.browserPid();
        await wait(900);
        assert.equal(pool.browserPid(), pid);
        assert.equal(pool.status().state, 'up');
    } finally {
        await pool.close();
    }
});
