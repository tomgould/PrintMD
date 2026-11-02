/**
 * The last-page tidy's decisions (src/tidy.mjs) with a fake printer and clock:
 * which scales it tries, how many extra prints it makes, when it gives up, and
 * that it always hands back a PDF.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {tidyLastPage, TIDY} from '../src/tidy.mjs';

const FIRST = Buffer.from('first');

/**
 * A fake render: printAt(scale) gives a PDF named after the scale, and count()
 * answers from stats(scale). The clock moves by renderMs for each print.
 */
function fake({stats, firstStats = {pages: 3, lastWords: 20}, renderMs = 100, clock = {t: 1000}}) {
    const scales = [];
    return {
        scales,
        clock,
        now: () => clock.t,
        printAt: async (scale) => {
            scales.push(scale);
            clock.t += renderMs;
            return Buffer.from(`s${scale}`);
        },
        count: async (pdf) => (pdf === FIRST ? firstStats : stats(Number(pdf.toString().slice(1)))),
    };
}

const base = (f, extra = {}) => ({first: FIRST, pages: 3, firstMs: 100, cover: false, printAt: f.printAt, count: f.count,
    now: f.now, startedAt: f.clock.t - 200, timeoutMs: 20_000, deadline: f.clock.t + 18_000, ...extra});

test('tidy: when the floor gains nothing it ends there: one extra print, the first PDF, a warning', async () => {
    const f = fake({stats: () => ({pages: 3, lastWords: 20})});
    const r = await tidyLastPage(base(f));
    assert.deepEqual(f.scales, [90]);
    assert.equal(r.pdf, FIRST);
    assert.equal(r.tidy, 100);
    assert.equal(r.warning, 'The last page holds only 20 words.');
});

test('tidy: never below the floor, even when a smaller scale would fit', async () => {
    // Each step pulls words back, but only 86 % would empty the last page.
    const f = fake({stats: (s) => (s <= 86 ? {pages: 2, lastWords: 300} : {pages: 3, lastWords: 20 - (100 - s)})});
    const r = await tidyLastPage(base(f));
    assert.deepEqual(f.scales, [90]);
    assert.ok(Math.min(...f.scales) >= 90, 'the floor is 90 %');
    assert.equal(TIDY.floor, 90);
    assert.equal(r.tidy, 100, 'no gain at the floor: the first print stands');
    assert.equal(r.pdf, FIRST);
    assert.match(r.warning, /^The last page holds only \d+ words\.$/);
});

test('tidy: the largest scale that fills the last page wins, with no warning', async () => {
    const f = fake({stats: (s) => (s <= 94 ? {pages: 3, lastWords: 80} : {pages: 3, lastWords: 20 - (100 - s)})});
    const r = await tidyLastPage(base(f));
    assert.deepEqual(f.scales, [90, 96, 94], 'the floor, then a bisection');
    assert.equal(r.tidy, 94);
    assert.equal(r.pdf.toString(), 's94');
    assert.equal(r.warning, undefined);
});

test('tidy: a page gone counts as a gain, but a last page still nearly empty is reported', async () => {
    const f = fake({stats: () => ({pages: 2, lastWords: 44})});
    const r = await tidyLastPage(base(f));
    assert.equal(r.tidy, 98);
    assert.deepEqual(f.scales, [90, 96, 98]);
    assert.equal(r.warning, 'The last page holds only 44 words.');
});

test('tidy: at most maxSteps prints in all', async () => {
    const f = fake({stats: (s) => (s <= 92 ? {pages: 2, lastWords: 300} : {pages: 3, lastWords: 10})});
    const r = await tidyLastPage(base(f));
    assert.equal(r.tidy, 92);
    assert.ok(f.scales.length <= TIDY.maxSteps, `${f.scales.length} prints`);
});

test('tidy: another print starts only when 1.5 times the last one fits in 60 % of the timeout', async () => {
    // Started at 0, timeout 20 s: the budget ends at 12 s. Each print takes 4 s.
    const clock = {t: 4000};
    const f = fake({stats: (s) => (s <= 90 ? {pages: 2, lastWords: 300} : {pages: 3, lastWords: 10}), renderMs: 4000, clock});
    const r = await tidyLastPage(base(f, {startedAt: 0, firstMs: 4000, deadline: 18_500}));
    assert.deepEqual(f.scales, [90], 'at 8 s, 8 + 6 > 12: no second print');
    assert.equal(r.tidy, 90, 'the finished tidied print is kept');
    const late = fake({stats: () => ({pages: 2, lastWords: 300}), renderMs: 4000, clock: {t: 7000}});
    const r2 = await tidyLastPage(base(late, {startedAt: 0, firstMs: 4000, deadline: 18_500}));
    assert.deepEqual(late.scales, [], 'at 7 s, 7 + 6 > 12: no print at all');
    assert.equal(r2.pdf, FIRST);
    assert.match(r2.warning, /holds only \d+ words/);
    const capped = fake({stats: () => ({pages: 2, lastWords: 300}), renderMs: 10, clock: {t: 1000}});
    await tidyLastPage(base(capped, {startedAt: 0, firstMs: 10, timeoutMs: 20_000, deadline: 1005}));
    assert.deepEqual(capped.scales, [], 'nor past the render deadline');
});

test('tidy: skipped for a slow first print or a long document', async () => {
    const slow = fake({stats: () => ({pages: 2, lastWords: 300})});
    assert.equal((await tidyLastPage(base(slow, {firstMs: TIDY.maxFirstMs + 1}))).tidy, 100);
    const long = fake({stats: () => ({pages: 2, lastWords: 300})});
    assert.equal((await tidyLastPage(base(long, {pages: TIDY.maxPages + 1}))).tidy, 100);
    assert.deepEqual([...slow.scales, ...long.scales], [], 'no extra print');
});

test('tidy: a one-page body, or a full last page, is left alone', async () => {
    const cover = fake({stats: () => ({pages: 1, lastWords: 300}), firstStats: {pages: 2, lastWords: 5}});
    assert.equal((await tidyLastPage(base(cover, {pages: 2, cover: true}))).tidy, 100);
    const full = fake({stats: () => ({pages: 1, lastWords: 300}), firstStats: {pages: 3, lastWords: 46}});
    const r = await tidyLastPage(base(full));
    assert.equal(r.tidy, 100);
    assert.equal(r.warning, undefined);
    assert.deepEqual([...cover.scales, ...full.scales], []);
});

test('tidy: a print still running when the budget ends is abandoned, and the first PDF comes back', async () => {
    let abandoned = false;
    const t0 = Date.now();
    const r = await tidyLastPage({
        first: FIRST, pages: 3, firstMs: 10, cover: false, startedAt: t0, timeoutMs: 500, deadline: t0 + 450,
        count: async (pdf) => (pdf === FIRST ? {pages: 3, lastWords: 10} : {pages: 3, lastWords: 10}),
        printAt: () => new Promise((resolve) => setTimeout(() => { abandoned = true; resolve(Buffer.from('late')); }, 5000).unref()),
    });
    const ms = Date.now() - t0;
    assert.equal(r.pdf, FIRST);
    assert.equal(r.tidy, 100);
    assert.ok(ms < 1500, `returned after ${ms} ms`);
    assert.equal(abandoned, false);
    assert.match(r.warning, /holds only 10 words/);
});

test('tidy: an error inside a step keeps the first PDF', async () => {
    const r = await tidyLastPage({first: FIRST, pages: 3, firstMs: 10, cover: false, startedAt: Date.now(), timeoutMs: 20_000,
        deadline: Date.now() + 18_000, count: async () => ({pages: 3, lastWords: 10}),
        printAt: async () => { throw new Error('closed'); }});
    assert.equal(r.pdf, FIRST);
    assert.equal(r.tidy, 100);
});
