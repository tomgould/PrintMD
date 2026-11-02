/**
 * Every regular expression and text scan on the request path, run on hostile
 * inputs and judged by growth (tests/lib/growth.js): four runs on 64K
 * characters, timed as one batch, against one run on 256K (warm-up, fastest of
 * 3). Linear scans take about as long either way; the big run must take less
 * than twice the batch (quadratic is ~4x), and stay under a generous cap. A wall-clock budget would fail on
 * a slower CPU; growth does not. A super-linear pattern on the main thread
 * would freeze the whole service (health checks included) before any limit or
 * timeout applies, so each function runs in a worker that is killed if a case
 * runs away.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Worker} from 'node:worker_threads';
import {spawn} from 'node:child_process';
import {CHROME} from './helpers.mjs';
import {SERVER_ROOT} from '../src/paths.mjs';
import {growthProblem} from '../../tests/lib/growth.js';

const MB = 1024 * 1024;
const SIZE = 64 * 1024;
const CAP_MS = 3000;
/** A worker case that has not answered after this long is runaway: killed and failed. */
const WATCHDOG_MS = 8 * CAP_MS;

const SRC = (rel) => new URL(rel, import.meta.url).href;
const MODULES = {
    options: SRC('../src/options.mjs'),
    filename: SRC('../src/filename.mjs'),
    pdf: SRC('../src/pdf.mjs'),
    assets: SRC('../src/assets.mjs'),
    config: SRC('../src/config.mjs'),
    renderer: SRC('../src/renderer.mjs'),
    untrusted: SRC('../src/untrusted.mjs'),
    docMeta: SRC('../../js/doc-meta.js'),
    download: SRC('../../js/download.js'),
    markdown: SRC('../../js/markdown.js'),
};

/** A hostile input spec: a unit repeated to any size, after a prefix and before a suffix. */
const fill = (unit, prefix = '', suffix = '') => [unit, prefix, suffix];

/** The spec built to `n` characters (plus the suffix). The worker has its own copy. */
const fillTo = ([unit, prefix, suffix], n) =>
    prefix + unit.repeat(Math.ceil((n - prefix.length) / unit.length)).slice(0, n - prefix.length) + suffix;

const HOSTILE = {
    'data:image/ then letters': fill('a', 'data:image/'),
    'data:image/png; params': fill(';a', 'data:image/png'),
    'many data:image/ heads': fill('data:image/x '),
    'data:image/png;base64, then stars': fill('*_', 'data:image/png;base64,'),
    'url( then spaces': fill(' ', 'url('),
    'url(\' then spaces': fill(' ', "url('"),
    'many url(': fill('url('),
    'many @import \'': fill("@import '"),
    'many image-set("': fill('image-set("'),
    'many url =': fill('url = '),
    'dots between letters': fill('.', 'a', 'a'),
    'dot space runs': fill('. ', 'a', 'a'),
    'spaces between letters': fill(' ', 'a', 'a'),
    'many <': fill('<'),
    'many <\'a': fill("<'a"),
    '< then quotes': fill('"', '<'),
    'many <"" pairs': fill('<""'),
    'H1 then spaces': fill(' ', '# ', '\n'),
    'many #\\n': fill('#\n'),
    'H1 then space-newline': fill(' \n', '#'),
    'front matter long key': fill('a', '---\n', '\n---\n'),
    'front matter spaces after colon': fill(' ', '---\na:', 'x\n---\n'),
    'front matter title of dots': fill('.', '---\ntitle: ', '\n---\n'),
    'many \'http:': fill("'http:"),
    'many /Type': fill('/Type '),
    'bidi overrides': fill('‮'),
    'comma runs': fill(',', 'a'),
    'semicolons': fill(';'),
};

/** [module, export, how to call it] for every scan on the request path. */
const CALLS = [
    ['options', 'markdownSize', 'fn(input)'],
    ['options', 'parseRenderRequest', "fn({contentType: 'text/markdown; ' + input.slice(0, 8000), query: new URLSearchParams(), body: Buffer.from('# x')})"],
    ['filename', 'safeFilename', 'fn(input)'],
    ['download', 'toFilenameSafe', 'fn(input)'],
    ['pdf', 'countPdfPages', "fn(Buffer.from('%PDF-' + input))"],
    ['assets', 'blockedLabel', 'fn(input)'],
    ['assets', 'resolveAssetPath', "fn('https://render.invalid/js/' + input)"],
    ['config', 'isLoopbackHost', 'fn(input)'],
    ['renderer', 'withCsp', "fn('<head>' + input)"],
    ['renderer', 'consoleBlockedLabel', "fn('Content Security Policy ' + input)"],
    ['untrusted', 'dataImageSpans', 'fn(input)'],
    ['untrusted', 'uncountedSpans', 'fn(input)'],
    ['untrusted', 'cssUrls', 'fn(input)'],
    ['untrusted', 'srcsetUrls', 'fn(input)'],
    ['untrusted', 'metaRefreshUrl', 'fn(input)'],
    ['docMeta', 'parseFrontMatter', 'fn(input)'],
    ['docMeta', 'extractTitle', 'fn(input)'],
    ['docMeta', 'buildDocMeta', 'fn(input)'],
    ['docMeta', 'cleanMetaValue', 'fn(input)'],
    ['docMeta', 'coverDate', 'fn(input)'],
    ['markdown', 'headingPlainText', 'fn(input)'],
    ['markdown', 'slugify', 'fn(input)'],
];

const WORKER = `
const {parentPort, workerData} = require('node:worker_threads');
const fillTo = ([unit, prefix, suffix], n) =>
    prefix + unit.repeat(Math.ceil((n - prefix.length) / unit.length)).slice(0, n - prefix.length) + suffix;
(async () => {
    const mod = await import(workerData.module);
    const fn = mod[workerData.name];
    if (typeof fn !== 'function') { parentPort.postMessage({missing: true}); return; }
    const once = async (input) => {
        const t0 = performance.now();
        try { await eval(workerData.call); } catch { /* only time matters */ }
        return performance.now() - t0;
    };
    const fastest = async (input) => Math.min(await once(input), await once(input), await once(input));
    // Four small runs as one batch: the same work as one big run if the scan is linear.
    const batch = async (input) => (await once(input)) + (await once(input)) + (await once(input)) + (await once(input));
    const fastestBatch = async (input) => Math.min(await batch(input), await batch(input), await batch(input));
    for (const [label, spec] of workerData.inputs) {
        const small = fillTo(spec, workerData.size);
        const big = fillTo(spec, workerData.size * 4);
        await once(small);   // warm up
        const t = {small: await fastestBatch(small), big: await fastest(big)};
        parentPort.postMessage({partial: [label, t]});
    }
    parentPort.postMessage({done: true});
})();
`;

/** Time every hostile input through one function in a worker; a runaway case kills the worker. */
function timeAll(module, name, call) {
    return new Promise((resolve) => {
        const times = {};
        const worker = new Worker(WORKER, {eval: true, workerData: {module, name, call, size: SIZE, inputs: Object.entries(HOSTILE)}});
        let timer;
        const arm = () => {
            clearTimeout(timer);
            timer = setTimeout(() => {
                const pending = Object.keys(HOSTILE).find((k) => !(k in times));
                times[pending] = {small: Infinity, big: Infinity};
                worker.terminate();
                resolve({times});
            }, WATCHDOG_MS);
        };
        arm();
        worker.on('message', (m) => {
            if (m.missing) { clearTimeout(timer); worker.terminate(); resolve({missing: true}); }
            if (m.partial) { times[m.partial[0]] = m.partial[1]; arm(); }
            if (m.done) { clearTimeout(timer); worker.terminate(); resolve({times}); }
        });
        worker.on('error', () => { clearTimeout(timer); resolve({times, error: true}); });
    });
}

for (const [mod, name, call] of CALLS) {
    test(`linear on hostile inputs (64K vs 256K characters): ${mod}.${name}`, {timeout: 600000}, async () => {
        const {times, missing, error} = await timeAll(MODULES[mod], name, call);
        assert.ok(!error, `${mod} loads`);
        assert.ok(!missing, `${mod}.${name} is exported`);
        const problems = Object.entries(times).map(([label, t]) => {
            if (!Number.isFinite(t.big)) return `${label}: no answer within ${WATCHDOG_MS} ms, killed`;
            const problem = growthProblem({...t, ratio: t.big / Math.max(t.small, 1)}, {capMs: CAP_MS});
            return problem && `${label}: ${problem}`;
        }).filter(Boolean);
        assert.deepEqual(problems, [], 'super-linear time');
    });
}

/** The real server in its own process, so a frozen event loop there cannot stall this test's clock. */
async function startServerProcess() {
    const child = spawn(process.execPath, ['src/main.mjs', '--local'], {
        cwd: SERVER_ROOT,
        env: {PATH: process.env.PATH, HOME: process.env.HOME, PRINTMD_PORT: '0', PRINTMD_CHROME: CHROME},
        stdio: ['ignore', 'pipe', 'ignore'],
    });
    const url = await new Promise((resolve, reject) => {
        let out = '';
        child.stdout.on('data', (d) => {
            out += d;
            const m = /"url":"(http:\/\/127\.0\.0\.1:\d+)"/.exec(out);
            if (m) resolve(m[1]);
        });
        child.once('exit', () => reject(new Error('server exited')));
    });
    return {url, stop: () => child.kill('SIGKILL')};
}

test('a hostile body does not stall the event loop: /health answers while it is checked', async () => {
    const server = await startServerProcess();
    try {
        for (const body of [fillTo(fill('a', '# x\n\ndata:image/'), MB), fillTo(fill(' ', '# x\n\n<style>url(', ')</style>'), MB)]) {
            const post = fetch(`${server.url}/api/v1/render`, {method: 'POST', headers: {'content-type': 'text/markdown'}, body,
                signal: AbortSignal.timeout(30000)}).then((r) => r.arrayBuffer()).catch(() => null);
            await new Promise((r) => setTimeout(r, 300));
            const t0 = Date.now();
            const health = await fetch(`${server.url}/api/v1/health`, {signal: AbortSignal.timeout(3000)}).catch((e) => e);
            const ms = Date.now() - t0;
            assert.equal(health.status, 200, `health answered (${health.name || health.status})`);
            assert.ok(ms < 1000, `health took ${ms} ms`);
            await post;
        }
    } finally {
        server.stop();
    }
});
