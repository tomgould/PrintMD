/**
 * Security and resilience with a real Chromium: the network lockdown (as a
 * whole and each layer alone), image limits, the queue limit, the render
 * timeout, crash recovery, browser recycling and the start-up refusals.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn, execFileSync} from 'node:child_process';
import {request as httpRequest} from 'node:http';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {chromium} from 'playwright';
import {startTestApi, render, toResult, warningsOf, startCanary, pdfInfo, pdfImageCount, PNG_DATA_URI, bigTable, CHROME, DEFAULT_QUERY} from './helpers.mjs';
import {findChrome, LAUNCH_ARGS} from '../src/browser.mjs';
import {withCsp} from '../src/renderer.mjs';
import {SERVER_ROOT} from '../src/paths.mjs';

const HOSTILE = readFileSync(join(SERVER_ROOT, 'test/fixtures/hostile.md'), 'utf8');

test('hostile fixture: zero canary hits, and the warnings name the blocked hosts only', async () => {
    const canary = await startCanary();
    const api = await startTestApi();
    try {
        const md = HOSTILE.replaceAll('CANARY', canary.origin);
        const r = await render(api.url, md, DEFAULT_QUERY);
        assert.equal(r.status, 200);
        const again = await toResult(await fetch(`${api.url}/api/v1/render`, {
            method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({markdown: md, template: 'unbranded'}),
        }));
        assert.equal(again.status, 200);
        await new Promise((ok) => setTimeout(ok, 500));
        assert.deepEqual(canary.hits, [], 'the canary server got no request');

        const warnings = warningsOf(r);
        const host = `127.0.0.1:${canary.port}`;
        for (const expected of [`Blocked a request to ${host}.`, 'Blocked a request to 169.254.169.254.', 'Blocked a request to file:.',
            'Blocked a request to render.invalid.', 'Blocked a request to www.youtube.com.']) {
            assert.ok(warnings.includes(expected), `${expected} in ${JSON.stringify(warnings)}`);
        }
        assert.ok(warnings.some((w) => /^Removed \d+ images not embedded/.test(w)), 'non-data images removed');
        for (const w of warnings) {
            assert.ok(!/\/(?:img|etc|latest|passwd|md-image|meta-data)|\?/.test(w), `no path or query in "${w}"`);
        }
    } finally {
        await api.close();
        await canary.close();
    }
});

test('layer 2 alone: the Chromium flags stop a page with no interception and no CSP', async () => {
    const canary = await startCanary();
    const html = `<img src="${canary.origin}/flag-test.png"><img src="http://localhost:${canary.port}/by-name.png">`;
    const control = await chromium.launch({executablePath: findChrome(CHROME), headless: true});
    const locked = await chromium.launch({executablePath: findChrome(CHROME), headless: true, args: [...LAUNCH_ARGS]});
    try {
        const page = await (await locked.newContext()).newPage();
        await page.setContent(html, {waitUntil: 'load'});
        await new Promise((ok) => setTimeout(ok, 300));
        assert.deepEqual(canary.hits, [], 'flags block it');
        const open = await (await control.newContext()).newPage();
        await open.setContent(html, {waitUntil: 'load'});
        assert.ok(canary.hits.length > 0, 'control: without the flags the canary is reached');
    } finally {
        await control.close();
        await locked.close();
        await canary.close();
    }
});

test('layer 3 alone: the print page CSP stops loads that interception lets through', async () => {
    const canary = await startCanary();
    const body = `<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body>
        <img src="${canary.origin}/csp-img.png"><div style="background:url(${canary.origin}/csp-css.png)">x</div>
        <link rel="stylesheet" href="${canary.origin}/csp.css"><iframe src="${canary.origin}/csp-frame"></iframe>
        <script src="${canary.origin}/csp.js"></script></body></html>`;
    const browser = await chromium.launch({executablePath: findChrome(CHROME), headless: true});
    // Served (by interception) from the canary's own origin, so neither Chromium's
    // mixed-content upgrade nor its local-network-access block, which would also stop
    // these loads from the real https://render.invalid page, is in play: only the CSP is.
    const PRINT_URL = `${canary.origin}/__bd/print.html`;
    try {
        for (const [html, expectHits] of [[withCsp(body), false], [body, true]]) {
            const context = await browser.newContext();
            await context.route('**/*', (route) => (route.request().url() === PRINT_URL
                ? route.fulfill({status: 200, contentType: 'text/html', body: html})
                : route.continue()));
            const page = await context.newPage();
            await page.goto(PRINT_URL, {waitUntil: 'load'});
            await new Promise((ok) => setTimeout(ok, 300));
            await context.close();
            if (expectHits) assert.ok(canary.hits.length > 0, 'control: without the CSP the canary is reached');
            else assert.deepEqual(canary.hits, [], 'the CSP blocks it');
        }
    } finally {
        await browser.close();
        await canary.close();
    }
});

test('images: a data: image over 5 MB is removed with a warning; smaller ones stay', async () => {
    const api = await startTestApi();
    try {
        const big = `data:image/png;base64,${Buffer.alloc(6 * 1024 * 1024, 7).toString('base64')}`;
        // A real PNG followed by 3 MB of padding (decoders ignore bytes after IEND).
        const png = Buffer.from(PNG_DATA_URI.split(',')[1], 'base64');
        const medium = `data:image/png;base64,${Buffer.concat([png, Buffer.alloc(3 * 1024 * 1024)]).toString('base64')}`;
        const r = await render(api.url, `# Images\n\n![small](${PNG_DATA_URI})\n\n![medium](${medium})\n\n![big](${big})\n\n`
            + `<img src="data:text/html;base64,PHA+">\n\n[a link](data:image/png;base64,${'A'.repeat(2048)})`);
        assert.equal(r.status, 200, r.body.toString().slice(0, 200));
        // The two 1 px images print at 96 ppi: their resolution warnings are tested in print-checks.test.mjs.
        const warnings = warningsOf(r).filter((w) => !/^Image \d+ is about \d+ ppi/.test(w));
        assert.deepEqual(warnings, [
            'Removed 1 image of a type other than png, jpeg, gif, webp or svg.',
            'Removed 1 image larger than 5 MB.',
        ]);
        const baseline = pdfImageCount((await render(api.url, '# Images')).body);
        assert.equal(pdfImageCount(r.body) - baseline, 2, 'the small and the medium image are in the PDF (beyond the cover logo)');
        const strict = await render(api.url, `# Images\n\n![big](${big})`, 'strict=1');
        assert.equal(strict.status, 422);
    } finally {
        await api.close();
    }
});

test('queue: 2 render, 6 wait, the 7th waiting request gets 429 with Retry-After', async () => {
    const api = await startTestApi();
    try {
        const doc = bigTable(1500);
        const results = await Promise.all(Array.from({length: 9}, () => render(api.url, doc)));
        const statuses = results.map((r) => r.status);
        assert.deepEqual(statuses.filter((s) => s === 200).length, 8, JSON.stringify(statuses));
        const refused = results.find((r) => r.status === 429);
        assert.ok(refused, JSON.stringify(statuses));
        assert.equal(refused.json.error.code, 'busy');
        assert.equal(refused.headers.get('retry-after'), '5');
    } finally {
        await api.close();
    }
});

/** Start a POST whose body arrives slowly; resolves the response once the server answers. */
function slowUpload(port, totalBytes) {
    const req = httpRequest({host: '127.0.0.1', port, method: 'POST', path: '/api/v1/render',
        headers: {'content-type': 'text/markdown', 'content-length': totalBytes}});
    const done = new Promise((resolve) => {
        req.on('response', (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve({status: res.statusCode, retryAfter: res.headers['retry-after'], body: Buffer.concat(chunks).toString()}));
        });
        req.on('error', (e) => resolve({status: 0, error: e.code}));
    });
    // Padding is an oversize base64 image: it does not count toward the Markdown limit and is removed.
    const head = '# Slow upload\n\n![i](data:image/png;base64,';
    req.write(head);
    return {
        done,
        finish: () => req.end(`${'A'.repeat(totalBytes - head.length - 1)})`),
    };
}

test('request bodies: at most 4 are read at once, the next gets 429 before its body is read', async () => {
    const api = await startTestApi();
    try {
        assert.ok(api.server.maxConnections > 0 && api.server.maxConnections <= 256, `maxConnections ${api.server.maxConnections}`);
        assert.ok(api.server.headersTimeout > 0 && api.server.requestTimeout > 0);
        const size = 8 * 1024 * 1024;
        const uploads = Array.from({length: 6}, () => slowUpload(api.port, size));
        const early = await Promise.race([
            Promise.all(uploads.slice(4).map((u) => u.done)),
            new Promise((r) => setTimeout(() => r(null), 3000)),
        ]);
        assert.ok(early, 'the 5th and 6th uploads were answered while the first 4 were still sending');
        for (const r of early) {
            assert.equal(r.status, 429, JSON.stringify(r));
            assert.equal(r.retryAfter, '5');
            assert.equal(JSON.parse(r.body).error.code, 'busy');
        }
        for (const u of uploads.slice(0, 4)) u.finish();
        const first = await Promise.all(uploads.slice(0, 4).map((u) => u.done));
        assert.deepEqual(first.map((r) => r.status), [200, 200, 200, 200]);
        assert.equal((await render(api.url, '# After\n\nfine')).status, 200, 'slots are free again');
    } finally {
        await api.close();
    }
});

test('timeout: a pathological layout gets 504 and the next request still renders', async () => {
    const api = await startTestApi({limits: {timeoutMs: 2500}});
    try {
        const t0 = Date.now();
        const slow = await render(api.url, bigTable(40000));
        assert.equal(slow.status, 504, slow.body.toString().slice(0, 200));
        assert.equal(slow.json.error.code, 'render_timeout');
        assert.ok(Date.now() - t0 < 10000, 'answered soon after the timeout');
        const next = await render(api.url, '# After the timeout\n\nfine');
        assert.equal(next.status, 200);
        assert.equal(pdfInfo(next.body).pages, Number(next.headers.get('x-printmd-pages')));
    } finally {
        await api.close();
    }
});

/** Chromium main processes started by this test process (Playwright spawns them as children). */
function chromeChildren() {
    let pids = [];
    try {
        pids = execFileSync('pgrep', ['-P', String(process.pid)]).toString().split('\n').filter(Boolean).map(Number);
    } catch {
        return [];
    }
    return pids.filter((pid) => {
        try {
            return /chrom/i.test(readFileSync(`/proc/${pid}/cmdline`, 'utf8'));
        } catch {
            return false;
        }
    });
}

test('crash: killing Chromium mid-request fails that request, and the next one works', async () => {
    const api = await startTestApi();
    try {
        assert.equal((await render(api.url, '# Warm up')).status, 200);
        const before = chromeChildren();
        assert.equal(before.length, 1, `one Chromium: ${before}`);
        const pending = render(api.url, bigTable(15000));
        await new Promise((ok) => setTimeout(ok, 800));
        process.kill(before[0], 'SIGKILL');
        const failed = await pending;
        assert.equal(failed.status, 500, failed.body.toString().slice(0, 200));
        assert.deepEqual(failed.json, {error: {code: 'render_failed', message: 'The PDF could not be rendered. Try again.'}});
        const next = await render(api.url, '# After the crash\n\nfine');
        assert.equal(next.status, 200);
        const health = await toResult(await fetch(`${api.url}/api/v1/health`));
        assert.equal(health.json.browser.crashes, 1);
        assert.equal(health.json.browser.launches, 2);
    } finally {
        await api.close();
    }
});

test('recycling: the browser is replaced after maxRenders renders', async () => {
    const api = await startTestApi({limits: {maxRenders: 2}});
    try {
        for (let i = 0; i < 5; i++) assert.equal((await render(api.url, `# Render ${i}`)).status, 200);
        const health = await toResult(await fetch(`${api.url}/api/v1/health`));
        assert.equal(health.json.browser.launches, 3);
        assert.equal(health.json.browser.crashes, 0);
        await new Promise((ok) => setTimeout(ok, 500));
        assert.equal(chromeChildren().length, 1, 'retired browsers are closed');
    } finally {
        await api.close();
    }
});

/** Run src/main.mjs with an environment and collect its exit code and stderr. */
function runMain(env, args = []) {
    return new Promise((resolve) => {
        const child = spawn(process.execPath, ['src/main.mjs', ...args], {
            cwd: SERVER_ROOT,
            env: {PATH: process.env.PATH, HOME: process.env.HOME, PRINTMD_PORT: '0', ...env},
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stderr = '';
        let stdout = '';
        child.stderr.on('data', (d) => { stderr += d; });
        child.stdout.on('data', (d) => { stdout += d; });
        const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
        child.on('exit', (code) => {
            clearTimeout(timer);
            resolve({code, stderr, stdout});
        });
    });
}

test('start-up: local mode refuses 0.0.0.0 and other non-loopback addresses', async () => {
    for (const host of ['0.0.0.0', '::', '192.0.2.10']) {
        const r = await runMain({PRINTMD_HOST: host}, ['--local']);
        assert.equal(r.code, 2, `${host}: ${r.stderr}`);
        assert.match(r.stderr, /Refusing to start: authentication is off/);
        assert.ok(!r.stdout.includes('listening'));
    }
    const env = await runMain({PRINTMD_HOST: '0.0.0.0', PRINTMD_MODE: 'local'});
    assert.equal(env.code, 2);
});

test('start-up: the test bypass is refused without NODE_ENV=test', async () => {
    const r = await runMain({PRINTMD_TEST_AUTH_BYPASS: '1'}, ['--local']);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /needs NODE_ENV=test/);
});

test('start-up: a missing browser names both fixes', async () => {
    const r = await runMain({PRINTMD_CHROME: '/nonexistent/chrome'}, ['--local']);
    assert.equal(r.code, 3);
    assert.match(r.stderr, /PRINTMD_CHROME/);
    assert.match(r.stderr, /npx --prefix server playwright install chromium/);
});
