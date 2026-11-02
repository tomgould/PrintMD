/**
 * Slow clients cannot lock the service out: sockets that trickle headers are
 * dropped after a short header timeout; bodies that trickle below a minimum
 * rate, or take longer than a hard deadline, are dropped and their slot freed;
 * aborted uploads free theirs at once; one slot stays free for the owner's
 * small renders; and a real 15 MB upload still works.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {connect} from 'node:net';
import {startTestApi, render, until, PNG_DATA_URI} from './helpers.mjs';
import * as app from '../src/app.mjs';

const FAST = {headersTimeoutMs: 1500, bodyDeadlineMs: 4000, bodyRateGraceMs: 1000, maxConnections: 8};

/** A socket that sends a request start, then one byte a second. */
function trickle(port, head) {
    const s = connect(port, '127.0.0.1');
    s.on('error', () => {});
    s.closedAt = null;
    s.on('close', () => { s.closedAt = Date.now(); });
    s.write(head);
    s.timer = setInterval(() => { if (!s.destroyed) s.write('a'); }, 1000);
    return s;
}

const stop = (socks) => socks.forEach((s) => { clearInterval(s.timer); s.destroy(); });
const bodyHead = (port, length = 1000000) => `POST /api/v1/render HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Type: text/markdown\r\n`
    + `Content-Length: ${length}\r\n\r\n# slow`;

test('defaults: 10 s for headers, 30 s for a body, at least 1 KB/s', () => {
    assert.equal(app.HEADERS_TIMEOUT_MS, 10_000);
    assert.equal(app.BODY_DEADLINE_MS, 30_000);
    assert.equal(app.BODY_MIN_RATE, 1024);
});

test('sockets trickling headers are dropped after the header timeout, then renders work', async () => {
    const api = await startTestApi({limits: FAST});
    const socks = [];
    try {
        for (let i = 0; i < FAST.maxConnections; i++) socks.push(trickle(api.port, `GET /api/v1/health HTTP/1.1\r\nHost: 127.0.0.1:${api.port}\r\n`));
        await new Promise((r) => setTimeout(r, 300));
        const t0 = Date.now();
        let status = 0;
        while (status !== 200 && Date.now() - t0 < 8000) {
            status = (await render(api.url, '# ok').catch(() => ({status: 0}))).status;
            if (status !== 200) await new Promise((r) => setTimeout(r, 250));
        }
        assert.equal(status, 200, 'a render got through');
        assert.ok(Date.now() - t0 < FAST.headersTimeoutMs + 2500, `after ${Date.now() - t0} ms`);
        assert.ok(await until(() => socks.every((s) => s.closedAt), FAST.headersTimeoutMs + 2500),
            `the server closed every trickling socket (${socks.filter((s) => s.closedAt).length}/${socks.length})`);
        assert.ok(Math.max(...socks.map((s) => s.closedAt)) - t0 < FAST.headersTimeoutMs + 2500);
    } finally {
        stop(socks);
        await api.close();
    }
});

test('four trickled uploads: the owner\'s small render still goes through, and the trickles are dropped', async () => {
    const api = await startTestApi({limits: FAST});
    const socks = [];
    try {
        for (let i = 0; i < 4; i++) socks.push(trickle(api.port, bodyHead(api.port)));
        await new Promise((r) => setTimeout(r, 300));
        const t0 = Date.now();
        const small = await render(api.url, '# Owner\n\nstill works');
        assert.equal(small.status, 200, 'the reserved slot serves a small render at once');
        assert.ok(Date.now() - t0 < 3000);
        // Below 1 KB/s after the grace period: dropped, slots freed.
        await new Promise((r) => setTimeout(r, FAST.bodyRateGraceMs + 1500));
        assert.ok(socks.every((s) => s.closedAt), 'trickling bodies were dropped');
        const big = await render(api.url, `# Big\n\n![i](data:image/png;base64,${'A'.repeat(200000)})`);
        assert.equal(big.status, 200, 'all body slots are free again');
    } finally {
        stop(socks);
        await api.close();
    }
});

test('a body faster than the minimum rate but slower than the deadline is dropped at the deadline', async () => {
    const api = await startTestApi({limits: FAST});
    const s = connect(api.port, '127.0.0.1');
    s.on('error', () => {});
    let reply = '';
    s.on('data', (d) => { reply += d; });
    try {
        s.write(bodyHead(api.port, 10_000_000));
        const timer = setInterval(() => { if (!s.destroyed) s.write('a'.repeat(4096)); }, 500); // 8 KB/s
        const t0 = Date.now();
        await new Promise((r) => s.on('close', r));
        clearInterval(timer);
        const ms = Date.now() - t0;
        assert.ok(ms >= FAST.bodyDeadlineMs - 500 && ms < FAST.bodyDeadlineMs + 2000, `closed after ${ms} ms`);
        assert.match(reply, /^HTTP\/1\.1 408 /);
        assert.match(reply, /"body_timeout"/);
        assert.equal((await render(api.url, '# After\n\nfine')).status, 200);
    } finally {
        s.destroy();
        await api.close();
    }
});

test('aborted uploads free their slots at once', async () => {
    const api = await startTestApi({limits: FAST});
    try {
        for (let round = 0; round < 3; round++) {
            const socks = Array.from({length: 4}, () => trickle(api.port, bodyHead(api.port)));
            await new Promise((r) => setTimeout(r, 200));
            stop(socks);
            await new Promise((r) => setTimeout(r, 200));
        }
        const results = await Promise.all(Array.from({length: 4}, () =>
            render(api.url, `# Again\n\n![i](data:image/png;base64,${'A'.repeat(100000)})`)));
        assert.deepEqual(results.map((r) => r.status), [200, 200, 200, 200], 'no slot was left behind');
    } finally {
        await api.close();
    }
});

test('a real 15 MB upload over loopback still succeeds', async () => {
    const api = await startTestApi();
    try {
        const png = PNG_DATA_URI.split(',')[1];
        const head = '# Fifteen\n\n![i](data:image/png;base64,';
        const md = `${head}${png}${'A'.repeat(15 * 1024 * 1024 - head.length - png.length - 200)})\n`;
        assert.ok(Buffer.byteLength(md) > 14.9 * 1024 * 1024 && Buffer.byteLength(md) <= 15 * 1024 * 1024);
        const r = await render(api.url, md);
        assert.equal(r.status, 200, r.body.toString().slice(0, 200));
    } finally {
        await api.close();
    }
});
