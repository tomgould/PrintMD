/**
 * The nearly-empty-last-page tidy, strictly opportunistic: it may improve a
 * render, never fail or delay one past its budget.
 *
 * A last page with maxWords words or fewer (more than one body page) is
 * printed again with the body scaled down, on scales step % apart from
 * 100 - step to floor % (at most maxSteps of them), to find the largest scale
 * at which the last page holds more or a page goes. The floor is printed
 * first: when even it gains nothing, no other scale can, and the tidy ends
 * after one extra print. Otherwise a bisection over the other scales finds the
 * largest that works (two or three more prints). It is skipped when the first
 * print took over maxFirstMs or the document has over maxPages pages. A print
 * starts only when headroom times the last full step (print and count) still
 * fits before budgetShare of the render timeout (and the render deadline); one
 * still running then is abandoned, and the best finished result is kept (the
 * first print when no tidied one works). Whenever it hands back a last page
 * that is still nearly empty, it says so in a warning. On any error the first
 * PDF stands.
 */

export const TIDY = Object.freeze({
    maxWords: 45,
    step: 2,
    floor: 90,
    maxSteps: 5,
    maxPages: 200,
    maxFirstMs: 5000,
    budgetShare: 0.6,
    headroom: 1.5,
    /** Kept free before the render timeout (src/renderer.mjs). */
    marginMs: 1500,
});

const TIMED_OUT = Symbol('timed out');

const lastPageWarning = (stats) => `The last page holds only ${stats.lastWords} words.`;

/**
 * @param {{first: Buffer, pages: number, firstMs: number, cover: boolean,
 *          printAt: (scale: number) => Promise<Buffer>,
 *          count: (pdf: Buffer) => Promise<{pages: number, lastWords: number}>,
 *          startedAt: number, timeoutMs: number, deadline: number, now?: () => number}} opts
 *        first: the first print; pages: its page count; firstMs: how long it took;
 *        printAt: print again at a body scale in %; count: pages and last-page words of a PDF;
 *        startedAt, timeoutMs, deadline: the render's start, time limit and last useful moment
 * @returns {Promise<{pdf: Buffer, tidy: number, warning?: string}>}  tidy: the scale used, 100 when unchanged
 */
export async function tidyLastPage(opts) {
    try {
        return await tidy(opts);
    } catch {
        return {pdf: opts.first, tidy: 100};
    }
}

async function tidy({first, pages, firstMs, cover, printAt, count, startedAt, timeoutMs, deadline, now = Date.now}) {
    const keep = {pdf: first, tidy: 100};
    const bodyPages = (n) => n - (cover ? 1 : 0);
    if (bodyPages(pages) <= 1 || pages > TIDY.maxPages || firstMs > TIDY.maxFirstMs) return keep;

    const budgetEnd = Math.min(startedAt + TIDY.budgetShare * timeoutMs, deadline);
    let t0 = now();
    const firstStats = await count(first);
    if (bodyPages(firstStats.pages) <= 1 || firstStats.lastWords > TIDY.maxWords) return keep;
    const unchanged = {...keep, warning: lastPageWarning(firstStats)};
    let lastMs = firstMs + (now() - t0);

    /** One print and count at a scale, or null when it does not fit the budget (or did not finish in it). */
    async function attempt(scale) {
        if (now() + TIDY.headroom * lastMs > budgetEnd) return null;
        const started = now();
        const step = (async () => {
            const pdf = await printAt(scale);
            return {scale, pdf, stats: await count(pdf)};
        })();
        step.catch(() => {});
        let timer;
        const result = await Promise.race([
            step,
            new Promise((resolve) => { timer = setTimeout(() => resolve(TIMED_OUT), Math.max(0, budgetEnd - now())); }),
        ]).finally(() => clearTimeout(timer));
        if (result === TIMED_OUT) return null;
        lastMs = now() - started;
        return result;
    }
    const works = (r) => r.stats.pages < firstStats.pages || r.stats.lastWords > TIDY.maxWords;
    const done = (r) => {
        const stillEmpty = bodyPages(r.stats.pages) > 1 && r.stats.lastWords <= TIDY.maxWords;
        return {pdf: r.pdf, tidy: r.scale, ...(stillEmpty ? {warning: lastPageWarning(r.stats)} : {})};
    };

    // The scales above 100 - maxSteps * step down to the floor, largest first: 98, 96, 94, 92, 90.
    const scales = [];
    for (let s = 100 - TIDY.step; s >= TIDY.floor && scales.length < TIDY.maxSteps; s -= TIDY.step) scales.push(s);
    if (!scales.length) return unchanged;

    // 1. The floor first: if even the smallest scale gains nothing, no other will, and it ends after one print.
    const atFloor = await attempt(scales[scales.length - 1]);
    if (!atFloor || !works(atFloor)) return unchanged;

    // 2. The largest scale that still works, by bisection over the rest (two or three more prints).
    //    Out of budget, the best finished print so far is kept.
    let best = atFloor;
    let lo = 0;
    let hi = scales.length - 2;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const r = await attempt(scales[mid]);
        if (!r) break;
        if (works(r)) {
            best = r;
            hi = mid - 1;
        } else {
            lo = mid + 1;
        }
    }
    return done(best);
}
