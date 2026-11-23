/**
 * The last-page tidy never turns a good render into a timeout, on whatever
 * machine runs it. The document is calibrated here, not fixed: blocks of a
 * fixed height, four to a page, then one more holding a single word, so the
 * last page is nearly empty and printing smaller (five to a page) pulls it
 * back, which is the case where the tidy prints again and again. The number of
 * blocks is scaled until a render without the tidy takes about 4 seconds here
 * (at most TIDY.maxPages pages, so the tidy runs). Then an API whose limit is
 * 2.5 times that render answers 200 with the tidy on: the tidy keeps to its
 * budget (60% of the limit), while one that ignored it would print four more
 * times and run out of time.
 *
 * Under heavy load the measurement means nothing, so the test is skipped with
 * a message (never failed) when the render without the tidy does not finish.
 * Heavy, so it stays out of the CI selection (tests/run-all.mjs); the guard
 * itself is unit-tested in tidy.test.mjs, which CI runs.
 */
import {test, after} from 'node:test';
import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {startTestApi, render} from './helpers.mjs';
import {TIDY} from '../src/tidy.mjs';

const apis = [];
after(async () => {
    await Promise.all(apis.map((api) => api.close()));
});
async function api(limits) {
    const started = await startTestApi({limits});
    apis.push(started);
    return started;
}

const PER_PAGE = 4;
const TARGET_MS = 4000;
const WORDS = 'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor '.repeat(8);
// 54 mm: four fit on the page at full size, five at the tidy's 90% floor. The columns make each print cost
// layout time (each tidy print lays the page out again), so a tidy print costs most of a whole render.
const block = (text) => `<div style="height:54mm;overflow:hidden;break-inside:avoid"><p style="columns:8">${text}</p></div>\n`;
// The limit, as a multiple of the render without the tidy: room for the tidy's budget, not for four more prints.
const LIMIT_FACTOR = 2.5;
const doc = (blocks) => `${block(WORDS).repeat(blocks)}${block('End.')}`;
const QUERY = 'template=unbranded&cover=false';

/** One render and how long it took (the client's view, for the calibration only). */
async function timed(url, blocks, query) {
    const t0 = performance.now();
    const r = await render(url, doc(blocks), query);
    return {r, ms: performance.now() - t0};
}

test('tidy: a render that takes 40% of the time limit still answers 200 with the tidy on', async (t) => {
    const calib = await api({});
    const off = `${QUERY}&tidy=false`;

    // Calibrate: scale the block count so the render without the tidy takes about TARGET_MS here.
    let blocks = 200;
    let good = await timed(calib.url, blocks, off);
    for (let i = 0; i < 2 && good.r.status === 200; i++) {
        const most = (TIDY.maxPages - 1) * PER_PAGE;
        const next = Math.max(PER_PAGE, Math.min(most, Math.round((blocks * TARGET_MS) / good.ms / PER_PAGE) * PER_PAGE));
        if (next === blocks) break;
        blocks = next;
        good = await timed(calib.url, blocks, off);
    }
    if (good.r.status !== 200) {
        t.skip(`the machine is too busy: even without the tidy the calibration render answered ${good.r.status}`);
        return;
    }
    const pages = Number(good.r.headers.get('x-printmd-pages'));
    assert.equal(pages, blocks / PER_PAGE + 1, 'four blocks a page, and the last page holds one word');
    assert.ok(pages <= TIDY.maxPages, `${pages} pages: few enough that the tidy runs`);
    const timeoutMs = Math.min(20_000, Math.round(LIMIT_FACTOR * good.ms));
    t.diagnostic(`${blocks} blocks, ${pages} pages, ${Math.round(good.ms)} ms without the tidy; limit ${timeoutMs} ms`);

    const limited = await api({timeoutMs});
    const on = await render(limited.url, doc(blocks), QUERY);
    if (on.status !== 200) {
        // Fair only if the render without the tidy still fits that limit now: otherwise the load changed, not the tidy.
        const again = await render(limited.url, doc(blocks), off);
        if (again.status !== 200) {
            t.skip(`the machine got busier: without the tidy the render now answers ${again.status} too`);
            return;
        }
    }
    assert.equal(on.status, 200, `the tidy turned a good render into a ${on.status} (limit ${timeoutMs} ms)`);
    assert.ok(Number(on.headers.get('x-printmd-pages')) <= pages, 'never more pages than without the tidy');
});
