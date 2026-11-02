/**
 * tests/lib/growth.js
 *
 * CPU-independent performance checks for the browser pages and the Node tests.
 * A wall-clock budget ("under 500 ms") fails on a slower or busier machine
 * (the CI container is 1.4x to 2x slower than a dev box) even when the code is linear.
 *
 * Instead, compare equal amounts of work: `factor` runs of an input of size n,
 * timed as one batch, against one run of an input of size factor * n. Linear
 * work takes about as long either way (ratio ~1); quadratic work takes about
 * `factor` times longer on the big input (ratio ~4). The check fails when the
 * ratio reaches `limit` (2 by default) or the big input passes a generous
 * `capMs`, which catches a blow-up too big to time twice.
 *
 * Equal batches are what make this robust: a slower CPU slows both alike, and
 * so does a CPU quota (docker --cpus, a busy CI box), which stalls any run
 * longer than one scheduling slice. Timing one small run against one big run
 * would let the small run finish inside a slice at full speed while the big
 * one is stalled, faking super-linear growth.
 */

const now = () => performance.now();

/** Fastest of `runs` timings of fn() (sync or async), in ms. */
export async function minTime(fn, runs = 3) {
    let best = Infinity;
    for (let i = 0; i < runs; i++) {
        const t0 = now();
        await fn();
        best = Math.min(best, now() - t0);
    }
    return best;
}

/**
 * Time `factor` runs of make(n) as one batch, and one run of make(factor * n):
 * one warm-up first, then the fastest of `runs` timings of each.
 * @returns {Promise<{small: number, big: number, ratio: number}>}  small is the whole batch, in ms
 */
export async function measureGrowth(run, make, {n, factor = 4, runs = 3}) {
    const smallInput = make(n);
    const bigInput = make(n * factor);
    await run(smallInput);   // warm up: compile, inline caches, lazy loads
    const small = await minTime(async () => {
        for (let i = 0; i < factor; i++) await run(smallInput);
    }, runs);
    const big = await minTime(() => run(bigInput), runs);
    return {small, big, ratio: big / Math.max(small, 1)};
}

/**
 * What is wrong with a measurement, or null when it is fine. Below `floorMs`
 * for the big input the ratio is not judged. Under a CPU quota of a quarter
 * CPU a run can wait up to ~75 ms for the next scheduling period, so two runs
 * of ~15 ms of work can measure 13 ms and 100 ms; only once both span several
 * periods (hundreds of ms) does that noise wash out. The quadratic regressions
 * these tests guard against cost 0.7 s to several seconds on the big input
 * even on a fast machine, so the floor hides only noise.
 * @param {{small: number, big: number, ratio: number}} m
 * @param {{limit?: number, capMs: number, floorMs?: number}} opts
 */
export function growthProblem(m, {limit = 2, capMs, floorMs = 400}) {
    const fmt = (x) => `${Math.round(x)} ms`;
    if (m.big > capMs) return `${fmt(m.big)} for the large input, over the ${fmt(capMs)} cap`;
    if (m.big >= floorMs && m.ratio >= limit) {
        return `4x the input took ${m.ratio.toFixed(1)}x as long as 4 runs of the small one (${fmt(m.small)} -> ${fmt(m.big)}): not linear`;
    }
    return null;
}

/** measureGrowth then growthProblem: the problem string, or null. */
export async function checkLinear(run, make, opts) {
    return growthProblem(await measureGrowth(run, make, opts), opts);
}
