/**
 * The MCP server (mcp/printmd-mcp.mjs) over stdio against a stub of the PDF API, so no browser is needed:
 * the handshake, the tool list, each tool, the options passed through to the API, and the refusals (paths
 * outside the allowed folder, links that lead out, wrong file types, an existing PDF, a non-local address,
 * a redirect, a stopped service).
 */
import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {createServer as createNetServer} from 'node:net';
import {mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const SERVER = fileURLToPath(new URL('../mcp/printmd-mcp.mjs', import.meta.url));
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const FAKE_PDF = Buffer.from('%PDF-1.7\n% stub\n%%EOF\n');
const TEMPLATES = {
    default: 'unbranded',
    templates: [
        {id: 'unbranded', name: 'Unbranded', description: 'Plain', pageSizes: ['A4', 'Letter'], orientations: ['portrait', 'landscape']},
        {id: 'dealmobile', name: 'Dealmobile', description: 'Branded', pageSizes: ['A4', 'A5'], orientations: ['portrait', 'landscape']},
    ],
    pageOptions: {layouts: ['paged', 'continuous']},
};

let stub;
let stubUrl;
let renders = [];
let work;
let root;

function freePort() {
    return new Promise((ok, fail) => {
        const s = createNetServer();
        s.once('error', fail);
        s.listen(0, '127.0.0.1', () => {
            const {port} = s.address();
            s.close(() => ok(port));
        });
    });
}

/** Starts the MCP server and talks JSON-RPC to it, one line per message. */
function startMcp(env = {}) {
    const child = spawn(process.execPath, [SERVER], {
        cwd: root, env: {...process.env, PRINTMD_URL: stubUrl, PRINTMD_MCP_ROOT: '', ...env}, stdio: ['pipe', 'pipe', 'pipe'],
    });
    const waiting = new Map();
    const stray = [];
    let buffer = '';
    let stderr = '';
    let nextId = 1;
    child.stderr.on('data', (d) => { stderr += d; });
    child.stdout.on('data', (d) => {
        buffer += d;
        let nl;
        while ((nl = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, nl);
            buffer = buffer.slice(nl + 1);
            const msg = JSON.parse(line);
            if (waiting.has(msg.id)) {
                waiting.get(msg.id)(msg);
                waiting.delete(msg.id);
            } else {
                stray.push(msg);
            }
        }
    });
    const request = (method, params) => new Promise((ok) => {
        const id = nextId++;
        waiting.set(id, ok);
        child.stdin.write(JSON.stringify({jsonrpc: '2.0', id, method, ...(params ? {params} : {})}) + '\n');
    });
    return {
        child, stray, request,
        stderr: () => stderr,
        notify: (method, params) => child.stdin.write(JSON.stringify({jsonrpc: '2.0', method, ...(params ? {params} : {})}) + '\n'),
        raw: (line) => child.stdin.write(line + '\n'),
        call: async (name, args = {}) => (await request('tools/call', {name, arguments: args})).result,
        close: () => new Promise((ok) => {
            child.once('exit', (code) => ok(code));
            child.stdin.end();
        }),
    };
}

async function initialised(env) {
    const mcp = startMcp(env);
    const init = await mcp.request('initialize', {protocolVersion: '2025-06-18', capabilities: {}, clientInfo: {name: 'test', version: '0'}});
    assert.equal(init.result.protocolVersion, '2025-06-18');
    mcp.notify('notifications/initialized');
    return mcp;
}

before(async () => {
    work = realpathSync(mkdtempSync(join(tmpdir(), 'printmd-mcp-')));
    root = join(work, 'root');
    mkdirSync(join(root, 'doc/img'), {recursive: true});
    writeFileSync(join(root, 'doc/img/dot.png'), PNG);
    writeFileSync(join(root, 'doc/notes.md'), '---\ntitle: Notes\ntemplate: dealmobile\n---\n\n# Notes\n\n![dot](img/dot.png)\n\n![web](https://example.com/a.png)\n');
    writeFileSync(join(root, 'doc/notes.txt'), 'not markdown');
    writeFileSync(join(work, 'secret.md'), '# Outside\n');
    symlinkSync(join(work, 'secret.md'), join(root, 'doc/link.md'));
    symlinkSync(work, join(root, 'out-link'));

    stub = createServer((req, res) => {
        const url = new URL(req.url, 'http://x');
        if (url.pathname === '/api/v1/health') {
            res.writeHead(200, {'content-type': 'application/json'});
            return res.end(JSON.stringify({service: 'printmd', status: 'ok', version: '9.9.9', mode: 'local'}));
        }
        if (url.pathname === '/api/v1/templates') {
            res.writeHead(200, {'content-type': 'application/json'});
            return res.end(JSON.stringify(TEMPLATES));
        }
        if (url.pathname === '/api/v1/render' && req.method === 'POST') {
            const chunks = [];
            req.on('data', (c) => chunks.push(c));
            req.on('end', () => {
                const body = Buffer.concat(chunks).toString('utf8');
                renders.push({query: Object.fromEntries(url.searchParams), body, type: req.headers['content-type']});
                if (url.searchParams.get('pageSize') === 'Z9') {
                    res.writeHead(400, {'content-type': 'application/json'});
                    return res.end(JSON.stringify({error: {code: 'invalid_option', message: 'pageSize must be one of A4.'}}));
                }
                res.writeHead(200, {
                    'content-type': 'application/pdf',
                    'x-printmd-pages': '3',
                    'x-printmd-warnings': encodeURIComponent(JSON.stringify(['An image prints under 150 ppi.'])),
                    'x-printmd-advisories': encodeURIComponent(JSON.stringify(['The last page holds only 12 words.'])),
                    'x-printmd-tidy': '100',
                });
                res.end(FAKE_PDF);
            });
            return undefined;
        }
        res.writeHead(404);
        return res.end();
    });
    await new Promise((ok) => stub.listen(0, '127.0.0.1', ok));
    stubUrl = `http://127.0.0.1:${stub.address().port}`;
});

after(async () => {
    await new Promise((ok) => stub.close(ok));
    rmSync(work, {recursive: true, force: true});
});

test('initialize, tools/list, ping, unknown method, notifications get no answer, exit on end of input', async () => {
    const mcp = startMcp();
    const init = await mcp.request('initialize', {protocolVersion: '1999-01-01', capabilities: {}, clientInfo: {name: 't', version: '0'}});
    assert.equal(init.result.serverInfo.name, 'printmd');
    assert.match(init.result.protocolVersion, /^\d{4}-\d{2}-\d{2}$/, 'an unknown version gets the newest');
    assert.ok(init.result.capabilities.tools);
    mcp.notify('notifications/initialized');
    const list = await mcp.request('tools/list');
    assert.deepEqual(list.result.tools.map((t) => t.name).sort(), ['check_service', 'list_templates', 'render_pdf']);
    for (const tool of list.result.tools) assert.equal(tool.inputSchema.type, 'object');
    assert.deepEqual((await mcp.request('ping')).result, {});
    assert.equal((await mcp.request('resources/list')).error.code, -32601);
    assert.equal((await mcp.request('tools/call', {name: 'nope', arguments: {}})).error.code, -32602);
    mcp.raw('{not json');
    await mcp.request('ping');
    assert.deepEqual(mcp.stray.map((m) => m.error?.code), [-32700], 'only the parse error, nothing for the notification');
    assert.equal(await mcp.close(), 0);
});

test('check_service and list_templates against the stub', async () => {
    const mcp = await initialised();
    const check = await mcp.call('check_service');
    assert.equal(check.isError, false);
    assert.match(check.content[0].text, /running at http:\/\/127\.0\.0\.1:\d+ \(version 9\.9\.9, local mode\)/);
    assert.equal(check.structuredContent.running, true);
    const list = await mcp.call('list_templates');
    assert.equal(list.isError, false);
    assert.deepEqual(list.structuredContent, TEMPLATES);
    const lines = list.content[0].text.split('\n');
    assert.equal(lines.length, 2);
    assert.match(lines[0], /^unbranded \(default\) \| Unbranded/);
    await mcp.close();
});

test('render_pdf: a file, the front matter template, images embedded, warnings and page count returned', async () => {
    renders = [];
    const mcp = await initialised();
    const r = await mcp.call('render_pdf', {path: 'doc/notes.md'});
    assert.equal(r.isError, false, r.content[0].text);
    const out = join(root, 'doc/notes.pdf');
    assert.equal(r.structuredContent.path, out);
    assert.equal(r.structuredContent.template, 'dealmobile');
    assert.equal(r.structuredContent.pages, 3);
    assert.deepEqual(r.structuredContent.warnings, ['An image prints under 150 ppi.']);
    assert.deepEqual(r.structuredContent.advisories, ['The last page holds only 12 words.']);
    assert.deepEqual(r.structuredContent.remoteImages, ['https://example.com/a.png']);
    assert.deepEqual(readFileSync(out), FAKE_PDF);
    assert.equal(renders.length, 1);
    assert.match(renders[0].type, /^text\/markdown/);
    assert.match(renders[0].body, /!\[dot\]\(data:image\/png;base64,/);
    assert.deepEqual(renders[0].query, {}, 'no options given, none sent');

    const again = await mcp.call('render_pdf', {path: join(root, 'doc/notes.md')});
    assert.equal(again.isError, true);
    assert.match(again.content[0].text, /already exists.*overwrite: true/);
    const forced = await mcp.call('render_pdf', {path: 'doc/notes.md', overwrite: true});
    assert.equal(forced.isError, false, forced.content[0].text);
    await mcp.close();
});

test('render_pdf: Markdown text with every option passed through to the API', async () => {
    renders = [];
    const mcp = await initialised();
    const r = await mcp.call('render_pdf', {
        markdown: '# Hi\n\n![dot](img/dot.png)\n', imageDir: 'doc', output: 'doc/hi.PDF',
        template: 'unbranded', pageSize: '100x150mm', orientation: 'landscape', layout: 'continuous', fit: 'widest',
        margin: '12mm', title: 'Hi & bye', author: 'Jo', date: '2026-11-22', subject: 'Test', lang: 'en-GB',
        cover: false, printLinks: true, tidy: false, strict: true,
    });
    assert.equal(r.isError, false, r.content[0].text);
    assert.equal(r.structuredContent.path, join(root, 'doc/hi.PDF'));
    assert.deepEqual(renders[0].query, {
        template: 'unbranded', pageSize: '100x150mm', orientation: 'landscape', layout: 'continuous', fit: 'widest',
        margin: '12mm', title: 'Hi & bye', author: 'Jo', date: '2026-11-22', subject: 'Test', lang: 'en-GB',
        cover: 'false', printLinks: 'true', tidy: 'false', strict: 'true',
    });
    assert.match(renders[0].body, /data:image\/png;base64,/);

    const refused = await mcp.call('render_pdf', {markdown: '# x', output: 'doc/bad.pdf', pageSize: 'Z9'});
    assert.equal(refused.isError, true);
    assert.match(refused.content[0].text, /refused the request \(400 invalid_option\): pageSize must be one of A4\./);

    const unknown = await mcp.call('render_pdf', {markdown: '# x', output: 'doc/u.pdf', template: 'nope'});
    assert.match(unknown.content[0].text, /Unknown template "nope"\. Available: unbranded, dealmobile\./);
    await mcp.close();
});

test('render_pdf: paths outside the folder, links that lead out and the wrong file types are refused', async () => {
    renders = [];
    const mcp = await initialised();
    const cases = [
        [{path: join(work, 'secret.md')}, /outside the folder this server may use/],
        [{path: '../secret.md'}, /outside the folder this server may use/],
        [{path: 'doc/link.md', output: 'doc/link.pdf'}, /outside the folder this server may use/],
        [{path: 'doc/notes.txt'}, /Only \.md and \.markdown files are read/],
        [{path: 'doc/missing.md'}, /There is no file/],
        [{path: 'doc/notes.md', output: 'doc/notes.html'}, /Only \.pdf files are written/],
        [{path: 'doc/notes.md', output: join(work, 'x.pdf')}, /outside the folder this server may use/],
        [{path: 'doc/notes.md', output: 'out-link/x.pdf'}, /outside the folder this server may use/],
        [{path: 'doc/notes.md', output: 'no-such/x.pdf'}, /There is no folder/],
        [{markdown: '# x', output: 'doc/y.pdf', imageDir: '..'}, /outside the folder this server may use/],
        [{markdown: '# x'}, /give output/],
        [{markdown: '# x', path: 'doc/notes.md', output: 'doc/z.pdf'}, /either path .* or markdown/],
    ];
    for (const [args, expected] of cases) {
        const r = await mcp.call('render_pdf', args);
        assert.equal(r.isError, true, JSON.stringify(args));
        assert.match(r.content[0].text, expected, JSON.stringify(args));
    }
    assert.equal(renders.length, 0, 'nothing reached the API');
    await mcp.close();
});

test('PRINTMD_MCP_ROOT sets the allowed folder', async () => {
    const mcp = await initialised({PRINTMD_MCP_ROOT: join(root, 'doc')});
    const outside = await mcp.call('render_pdf', {path: join(work, 'secret.md')});
    assert.match(outside.content[0].text, new RegExp(`outside the folder this server may use \\(${join(root, 'doc').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\)`));
    const ok = await mcp.call('render_pdf', {path: 'notes.md', output: 'root-env.pdf'});
    assert.equal(ok.isError, false, ok.content[0].text);
    assert.equal(ok.structuredContent.path, join(root, 'doc/root-env.pdf'));
    await mcp.close();
});

test('a stopped service gives the start command; a non-local address and a redirect are refused', async () => {
    const port = await freePort();
    const down = await initialised({PRINTMD_URL: `http://127.0.0.1:${port}`});
    for (const name of ['check_service', 'list_templates']) {
        const r = await down.call(name);
        assert.equal(r.isError, true);
        assert.match(r.content[0].text, /not running at http:\/\/127\.0\.0\.1:\d+/);
        assert.match(r.content[0].text, /npm --prefix ".*server" run start:local/);
        assert.match(r.content[0].text, /systemctl --user start printmd-api/);
    }
    const render = await down.call('render_pdf', {markdown: '# x', output: 'doc/down.pdf'});
    assert.match(render.content[0].text, /run start:local/);
    await down.close();

    for (const url of ['http://example.com', 'https://127.0.0.1:5787', 'http://127.0.0.1:5787/api']) {
        const remote = await initialised({PRINTMD_URL: url});
        const r = await remote.call('check_service');
        assert.equal(r.isError, true, url);
        assert.match(r.content[0].text, /PRINTMD_URL must be http:\/\/127\.0\.0\.1/, url);
        await remote.close();
    }

    const redirector = createServer((req, res) => {
        res.writeHead(302, {location: `${stubUrl}${req.url}`});
        res.end();
    });
    await new Promise((ok) => redirector.listen(0, '127.0.0.1', ok));
    const moved = await initialised({PRINTMD_URL: `http://127.0.0.1:${redirector.address().port}`});
    const r = await moved.call('check_service');
    assert.equal(r.isError, true, 'a redirect is not followed');
    await moved.close();
    await new Promise((ok) => redirector.close(ok));
});

test('another service on the port is refused: nothing listed, no document sent', async () => {
    for (const health of [{status: 'ok', version: '1', mode: 'local'}, {service: 'other', status: 'ok'}]) {
        const posts = [];
        const other = createServer((req, res) => {
            const url = new URL(req.url, 'http://x');
            if (req.method === 'POST') posts.push(url.pathname);
            res.writeHead(200, {'content-type': 'application/json'});
            if (url.pathname === '/api/v1/health') return res.end(JSON.stringify(health));
            if (url.pathname === '/api/v1/templates') return res.end(JSON.stringify(TEMPLATES));
            return res.end('{}');
        });
        await new Promise((ok) => other.listen(0, '127.0.0.1', ok));
        const mcp = await initialised({PRINTMD_URL: `http://127.0.0.1:${other.address().port}`});
        try {
            for (const [name, args] of [['check_service', {}], ['list_templates', {}],
                ['render_pdf', {markdown: '# Private', output: 'doc/other.pdf'}], ['render_pdf', {path: 'doc/notes.md', overwrite: true}]]) {
                const r = await mcp.call(name, args);
                assert.equal(r.isError, true, `${name} with ${JSON.stringify(health)}`);
                assert.match(r.content[0].text, /Something other than the PrintMD PDF service answered/);
                assert.match(r.content[0].text, /PRINTMD_URL/);
            }
        } finally {
            await mcp.close();
            await new Promise((ok) => other.close(ok));
        }
        assert.deepEqual(posts, [], 'no document reached the other service');
    }
});
