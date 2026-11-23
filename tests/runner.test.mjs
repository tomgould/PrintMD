/**
 * tests/runner.test.mjs: the headless page runner never hangs the suite.
 *
 * A page whose renderer is busy answers no DevTools call, so a runner that
 * awaits Runtime.evaluate without a deadline waits forever and the per-page
 * timeout never fires. runHeadless must report such a page as timed out
 * within its timeout plus a few seconds, and the next page must still run.
 *
 * Run: node --test tests/runner.test.mjs (tests/run-all.mjs runs it with the unit tests).
 * Needs Chrome, like the browser pages.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {startStaticServer} from './lib/static-server.mjs';
import {runHeadless} from './run-headless.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('runHeadless: a page that busy-loops for 60 s fails as timed out within its timeout, and the next page runs',
    {timeout: 45000}, async () => {
        const server = await startStaticServer(root);
        try {
            const timeoutMs = 3000;
            const started = Date.now();
            const busy = await runHeadless(`${server.origin}/tests/lib/busy-page.html`, {timeoutMs});
            const elapsed = Date.now() - started;
            assert.equal(busy.ok, false, 'the busy page fails');
            assert.equal(busy.timedOut, true, 'reported as timed out: ' + JSON.stringify(busy).slice(0, 300));
            assert.ok(elapsed < timeoutMs + 12000, `returned after ${elapsed} ms, timeout ${timeoutMs} ms`);

            const next = await runHeadless(`${server.origin}/tests/lib/pass-page.html`, {timeoutMs});
            assert.equal(next.ok, true, 'the next page still runs and passes: ' + JSON.stringify(next).slice(0, 300));
        } finally {
            await server.close();
        }
    });
