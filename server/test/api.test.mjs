/**
 * The HTTP API end to end with a real Chromium: routes, error JSON and
 * statuses, headers, the off switch, health, deployed-mode sign-in, logs.
 */
import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import {request as httpRequest} from 'node:http';
import {connect as netConnect} from 'node:net';
import {startTestApi, render, toResult, warningsOf, pdfInfo, DEFAULT_QUERY, DEFAULT_TEMPLATE, TEMPLATE_IDS} from './helpers.mjs';
import {listTemplates} from '../src/templates-info.mjs';
import {loadConfig} from '../src/config.mjs';
import {startApi} from '../src/runtime.mjs';
import {LIMITS} from '../src/options.mjs';

let api;

before(async () => {
    api = await startTestApi();
});

after(async () => {
    await api.close();
});

const get = async (path, init) => toResult(await fetch(`${api.url}${path}`, init));

function assertError(result, status, code) {
    assert.equal(result.status, status, `${code}: ${result.status} ${result.body.toString().slice(0, 200)}`);
    assert.match(result.headers.get('content-type'), /^application\/json/);
    assert.equal(typeof result.json.error.message, 'string');
    assert.equal(result.json.error.code, code);
}

test('render: 200 PDF with the documented headers', async () => {
    const r = await render(api.url, '# Quarterly "Plan" / v2\n\nHello **world**', `${DEFAULT_QUERY}&pageSize=A4`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'application/pdf');
    assert.equal(r.headers.get('content-disposition'), 'attachment; filename="Quarterly Plan v2.pdf"');
    assert.match(r.headers.get('x-printmd-version'), /^([0-9a-f]{7,}|dev)$/);
    assert.match(r.headers.get('x-request-id'), /^[0-9a-f-]{36}$/);
    assert.deepEqual(warningsOf(r), []);
    assert.equal(r.body.subarray(0, 5).toString(), '%PDF-');
    assert.equal(Number(r.headers.get('x-printmd-pages')), pdfInfo(r.body).pages);
});

test('render: a JSON body works the same', async () => {
    const res = await fetch(`${api.url}/api/v1/render`, {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({markdown: '# JSON doc\n\ntext', template: 'unbranded', pageSize: 'Letter', orientation: 'landscape', meta: {author: 'Jo'}}),
    });
    const r = await toResult(res);
    assert.equal(r.status, 200);
    const info = pdfInfo(r.body);
    assert.equal(Math.round(info.width), 792);
    assert.equal(Math.round(info.height), 612);
});

test('templates: from the real manifests', async () => {
    const r = await get('/api/v1/templates');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, listTemplates(), 'the registry, as listed');
    assert.deepEqual(Object.keys(r.json), ['default', 'pageOptions', 'templates'], 'no "warnings" key when every manifest loaded');
    assert.equal(r.json.default, DEFAULT_TEMPLATE);
    assert.deepEqual(r.json.templates.map((t) => t.id), TEMPLATE_IDS);
    assert.ok(r.json.templates.every((t) => t.pageSizes.includes('Letter') && t.orientations.includes('landscape')));
});

test('whoami: the test identity', async () => {
    const r = await get('/api/v1/whoami');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, {email: 'test@localhost', mode: 'test'});
});

test('health: loopback only, browser and queue state, no secrets', async () => {
    const r = await get('/api/v1/health');
    assert.equal(r.status, 200);
    assert.equal(r.json.status, 'ok');
    assert.ok(['up', 'idle', 'starting'].includes(r.json.browser.state));
    assert.deepEqual(Object.keys(r.json.queue).sort(), ['active', 'maxActive', 'maxQueue', 'waiting']);
    assert.ok(!/\/home\/|chrome-linux|ms-playwright|PRINTMD_/i.test(r.body.toString()), 'no paths or settings');
    const proxied = await get('/api/v1/health', {headers: {'x-forwarded-for': '203.0.113.9'}});
    assertError(proxied, 404, 'not_found');
});

test('health: any proxy header makes the caller non-local', async () => {
    const host = `127.0.0.1:${api.port}`;
    for (const [name, value] of [['x-forwarded-for', '203.0.113.9'], ['x-forwarded-host', 'pdf.example'], ['x-forwarded-proto', 'https'],
        ['forwarded', 'for=203.0.113.9'], ['x-real-ip', '203.0.113.9'], ['true-client-ip', '203.0.113.9'], ['x-client-ip', '203.0.113.9'],
        ['cf-connecting-ip', '203.0.113.9'], ['via', '1.1 proxy'], ['X-Forwarded-Proto', '']]) {
        const r = await raw(api.port, {path: '/api/v1/health', headers: {host, [name]: value}});
        assert.equal(r.status, 404, name);
    }
    assert.equal((await raw(api.port, {path: '/api/v1/health', headers: {host}})).status, 200);
});

test('404 for unknown routes and unknown templates, 405 for the wrong method', async () => {
    assertError(await get('/api/v1/nope'), 404, 'not_found');
    assertError(await get('/'), 404, 'not_found');
    assertError(await render(api.url, '# x', 'template=nope'), 404, 'unknown_template');
    const wrong = await get('/api/v1/render');
    assertError(wrong, 405, 'method_not_allowed');
    assert.equal(wrong.headers.get('allow'), 'POST');
});

test('400 and 415 paths over HTTP', async () => {
    assertError(await render(api.url, '# x', 'pageSize=B5'), 400, 'invalid_option');
    assertError(await render(api.url, '# x', 'colour=red'), 400, 'unknown_option');
    assertError(await render(api.url, '  '), 400, 'empty_markdown');
    assertError(await render(api.url, '# x', '', {headers: {'content-type': 'text/html'}}), 415, 'unsupported_media_type');
    assertError(await render(api.url, '{', '', {headers: {'content-type': 'application/json'}}), 400, 'invalid_json');
});

test('413 for a body over 15 MB and for Markdown over 2 MB', async () => {
    assertError(await render(api.url, 'a'.repeat(LIMITS.bodyBytes + 10)), 413, 'body_too_large');
    assertError(await render(api.url, 'a'.repeat(LIMITS.markdownBytes + 10)), 413, 'markdown_too_large');
});

test('strict: warnings give 422 with the warnings instead of a PDF', async () => {
    const r = await render(api.url, 'no title here\n\n![x](https://example.com/x.png)', 'strict=true');
    assertError(r, 422, 'strict_warnings');
    assert.ok(r.json.error.warnings.some((w) => /title/i.test(w)), JSON.stringify(r.json));
    assert.ok(r.json.error.warnings.includes('Blocked a request to example.com.'), JSON.stringify(r.json));
    const ok = await render(api.url, '# Clean\n\ntext', 'strict=true');
    assert.equal(ok.status, 200);
});

test('option precedence: request > front matter > template default', async () => {
    const fm = `---\ntitle: FM Title\nauthor: FM Author\ntemplate: ${TEMPLATE_IDS.at(-1)}\n---\n# Body heading\n\ntext`;
    const fromFm = await render(api.url, fm);
    assert.equal(fromFm.status, 200);
    assert.equal(fromFm.headers.get('content-disposition'), 'attachment; filename="FM Title.pdf"');
    const fromReq = await render(api.url, fm, `title=Request%20Title&template=${TEMPLATE_IDS.at(-2) ?? DEFAULT_TEMPLATE}`);
    assert.equal(fromReq.headers.get('content-disposition'), 'attachment; filename="Request Title.pdf"');
});

test('logs: one JSON line per request with sizes and status, never content', async () => {
    const canary = 'CANARYqz81';
    const before = api.logs.length;
    const r = await render(api.url, `---\nauthor: ${canary}-author\n---\n# ${canary} heading\n\n${canary} body`,
        `title=${canary}-title&date=${canary}-date`);
    assert.equal(r.status, 200);
    assertError(await render(api.url, `# ${canary}`, `pageSize=${canary}`), 400, 'invalid_option');
    assertError(await render(api.url, `# ${canary}`, `${canary}=1`), 400, 'unknown_option');
    await get(`/api/v1/${canary}`);
    const lines = api.logs.slice(before).map((l) => JSON.parse(l));
    assert.equal(lines.length, 4);
    const ok = lines[0];
    assert.equal(ok.status, 200);
    assert.equal(ok.route, 'render');
    assert.equal(ok.email, 'test@localhost');
    assert.equal(ok.template, DEFAULT_TEMPLATE);
    assert.ok(ok.bytesIn > 0 && ok.bytesOut > 0 && ok.pages >= 2 && ok.ms >= 0 && ok.id);
    assert.ok(!api.logText().includes(canary), 'the canary never reaches the log');
    assert.ok(!api.logText().includes('Request Title') && !api.logText().includes('FM Title'), 'titles never logged');
});

test('error bodies never echo the request', async () => {
    const canary = 'CANARYzz42';
    for (const r of [
        await render(api.url, `# ${canary}`, `orientation=${canary}`),
        await render(api.url, `# ${canary}`, `template=${canary}`),
        await render(api.url, JSON.stringify({markdown: canary, [canary]: 1}), '', {headers: {'content-type': 'application/json'}}),
    ]) {
        assert.ok(r.status >= 400);
        assert.ok(!r.body.toString().includes(canary), r.body.toString());
    }
});

/** A request with exactly these headers (fetch cannot set Host). */
function raw(port, {method = 'GET', path = '/api/v1/whoami', headers = {}, body} = {}) {
    return new Promise((resolve, reject) => {
        const req = httpRequest({host: '127.0.0.1', port, method, path, headers, setHost: false}, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                const text = Buffer.concat(chunks).toString();
                let json;
                try { json = JSON.parse(text); } catch { /* not JSON */ }
                resolve({status: res.statusCode, json});
            });
        });
        req.on('error', reject);
        req.end(body);
    });
}

test('local mode: only a loopback Host with the right port is answered, on every route', async () => {
    const port = api.port;
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `LOCALHOST:${port}`, `[::1]:${port}`]) {
        const r = await raw(port, {headers: {host}});
        assert.equal(r.status, 200, host);
    }
    // No Host header at all: Node's HTTP parser answers 400 before the handler runs.
    assert.equal((await raw(port, {headers: {}})).status, 400);
    for (const host of [`attacker.example:${port}`, `127.0.0.1.nip.io:${port}`, '127.0.0.1', `127.0.0.1:${port + 1}`, `localhost.:${port}`,
        `user@127.0.0.1:${port}`, `127.0.0.1:${port}, attacker.example`]) {
        for (const path of ['/api/v1/whoami', '/api/v1/health', '/api/v1/templates', '/api/v1/nope']) {
            const r = await raw(port, {path, headers: {host}});
            assert.equal(r.status, 403, `${host} ${path}`);
            assert.equal(r.json.error.code, 'forbidden_host');
        }
    }
    const post = await raw(port, {method: 'POST', path: '/api/v1/render',
        headers: {host: `attacker.example:${port}`, 'content-type': 'text/markdown'}, body: '# x'});
    assert.equal(post.status, 403);
});

/** The status line of a request written byte for byte on a socket. */
function rawSocket(port, lines) {
    return new Promise((resolve) => {
        const s = netConnect(port, '127.0.0.1', () => s.write(`${lines.join('\r\n')}\r\nConnection: close\r\n\r\n`));
        let buf = '';
        s.on('data', (d) => { buf += d; });
        s.on('end', () => resolve(buf.split('\r\n')[0]));
        s.on('error', () => resolve('socket error'));
    });
}

test('more than one Host or Origin header is refused, whatever the order', async () => {
    const port = api.port;
    const good = `Host: 127.0.0.1:${port}`;
    for (const lines of [
        ['GET /api/v1/whoami HTTP/1.1', good, 'Host: evil.example'],
        ['GET /api/v1/whoami HTTP/1.1', 'Host: evil.example', good],
        ['GET /api/v1/whoami HTTP/1.1', good, good],
        ['GET /api/v1/whoami HTTP/1.1', good, `Origin: http://127.0.0.1:${port}`, 'Origin: http://evil.example'],
    ]) {
        assert.match(await rawSocket(port, lines), /^HTTP\/1\.1 (403|400) /, lines.join(' | '));
    }
    assert.match(await rawSocket(port, ['GET /api/v1/whoami HTTP/1.1', good]), /^HTTP\/1\.1 200 /, 'one Host is fine');
});

test('local mode: a request with a foreign or null Origin is refused; the same origin is fine', async () => {
    const port = api.port;
    const host = `127.0.0.1:${port}`;
    for (const origin of ['http://attacker.example', `http://attacker.example:${port}`, 'null', `http://localhost:${port + 1}`,
        `https://127.0.0.1:${port}`, 'http://127.0.0.1']) {
        const r = await raw(port, {headers: {host, origin}});
        assert.equal(r.status, 403, origin);
        assert.equal(r.json.error.code, 'forbidden_origin');
        const post = await raw(port, {method: 'POST', path: '/api/v1/render', headers: {host, origin, 'content-type': 'text/markdown'}, body: '# x'});
        assert.equal(post.status, 403, `POST ${origin}`);
    }
    for (const origin of [`http://127.0.0.1:${port}`, `http://localhost:${port}`, `http://[::1]:${port}`]) {
        assert.equal((await raw(port, {headers: {host, origin}})).status, 200, origin);
    }
});

test('render accepts only text/markdown and application/json (no form-postable types)', async () => {
    for (const type of ['text/plain', 'text/plain; charset=utf-8', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', 'text/x-markdown']) {
        const r = await raw(api.port, {method: 'POST', path: '/api/v1/render', headers: {host: `127.0.0.1:${api.port}`, 'content-type': type}, body: '# x'});
        assert.equal(r.status, 415, type);
        assert.equal(r.json.error.code, 'unsupported_media_type');
    }
});

test('deployed mode: PRINTMD_ALLOWED_HOSTS, when set, limits the Host header', async () => {
    // Token mode: deployed, like access mode, without needing the access provider.
    const deployedEnv = {NODE_ENV: 'test', PRINTMD_API_ENABLED: '1', PRINTMD_PORT: '0', PRINTMD_CHROME: process.env.PRINTMD_CHROME || '',
        PRINTMD_AUTH: 'token', PRINTMD_API_TOKEN: 'example-co-api-token-0123456789'};
    const config = loadConfig({env: {...deployedEnv, PRINTMD_ALLOWED_HOSTS: 'docs.example.com, Other.Example'}, argv: []});
    const deployed = await startApi(config, {log: () => {}});
    try {
        assert.equal((await raw(deployed.port, {headers: {host: 'docs.example.com'}})).status, 401, 'allowed host reaches auth');
        assert.equal((await raw(deployed.port, {headers: {host: 'other.example:443'}})).status, 401);
        const bad = await raw(deployed.port, {headers: {host: 'attacker.example'}});
        assert.equal(bad.status, 403);
        assert.equal(bad.json.error.code, 'forbidden_host');
    } finally {
        await deployed.close();
    }
    const open = await startApi(loadConfig({env: deployedEnv, argv: []}), {log: () => {}});
    try {
        assert.equal((await raw(open.port, {headers: {host: 'anything.example'}})).status, 401, 'unset: no Host rule, the token is the control');
    } finally {
        await open.close();
    }
});

test('off switch: with PRINTMD_API_ENABLED unset every route but health is 503', async () => {
    const off = await startTestApi({env: {PRINTMD_API_ENABLED: ''}});
    try {
        for (const [method, path] of [['GET', '/api/v1/templates'], ['GET', '/api/v1/whoami'], ['POST', '/api/v1/render'], ['GET', '/api/v1/other']]) {
            const r = await toResult(await fetch(`${off.url}${path}`, {method, headers: {'content-type': 'text/markdown'}, body: method === 'POST' ? '# x' : undefined}));
            assertError(r, 503, 'api_disabled');
        }
        const health = await toResult(await fetch(`${off.url}/api/v1/health`));
        assert.equal(health.status, 200);
        assert.equal(health.json.apiEnabled, false);
    } finally {
        await off.close();
    }
});

test('token mode: no token or a wrong one is the same 401; the right one passes; the token is never logged', async () => {
    const secret = 'example-co-api-token-0123456789';
    const config = loadConfig({env: {NODE_ENV: 'test', PRINTMD_API_ENABLED: '1', PRINTMD_PORT: '0',
        PRINTMD_CHROME: process.env.PRINTMD_CHROME || '', PRINTMD_AUTH: 'token', PRINTMD_API_TOKEN: secret}, argv: []});
    const logs = [];
    const deployed = await startApi(config, {log: (e) => logs.push(JSON.stringify(e))});
    const bodies = [];
    const call = async (path, headers = {}, init = {}) => {
        const r = await toResult(await fetch(`${deployed.url}${path}`, {headers, ...init}));
        bodies.push(r.body.toString('latin1'), JSON.stringify([...r.headers]));
        return r;
    };
    try {
        const none = await call('/api/v1/whoami');
        assertError(none, 401, 'unauthorized');
        assert.equal(none.headers.get('www-authenticate'), 'Bearer');
        const wrong = await call('/api/v1/whoami', {authorization: `Bearer ${secret}x`});
        assertError(wrong, 401, 'unauthorized');
        assert.deepEqual(wrong.json, none.json, 'no detail: a wrong token reads like a missing one');
        const render = await call('/api/v1/render', {authorization: 'Bearer nope', 'content-type': 'text/markdown'}, {method: 'POST', body: '# x'});
        assertError(render, 401, 'unauthorized');
        const me = await call('/api/v1/whoami', {authorization: `Bearer ${secret}`});
        assert.equal(me.status, 200);
        assert.deepEqual(me.json, {email: 'token@localhost', mode: 'token'});
        const list = await call('/api/v1/templates', {authorization: `Bearer ${secret}`});
        assert.equal(list.status, 200);
        // Two Authorization headers, the good one first (Node would keep only that one): refused.
        const host = `Host: 127.0.0.1:${deployed.port}`;
        assert.equal(await rawSocket(deployed.port, ['GET /api/v1/whoami HTTP/1.1', host,
            `Authorization: Bearer ${secret}`, 'Authorization: Bearer other']), 'HTTP/1.1 401 Unauthorized');
        assert.equal(await rawSocket(deployed.port, ['GET /api/v1/whoami HTTP/1.1', host, `Authorization: Bearer ${secret}`]),
            'HTTP/1.1 200 OK', 'one header passes');
        assert.equal(logs.length >= 5, true, 'one log line per request');
        for (const text of [...logs, ...bodies]) assert.ok(!text.includes(secret), `the token leaked: ${text.slice(0, 200)}`);
    } finally {
        await deployed.close();
    }
});
