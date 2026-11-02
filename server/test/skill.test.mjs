/**
 * The Claude Code skill's script (skills/printmd/scripts/printmd.mjs) against the real API: check, templates,
 * a render with local images embedded, the refusals (overwrite, unknown template, non-local address) and the
 * message when the API is not running. The image rules are also checked without the API.
 */
import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {createServer} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {REPO_ROOT} from '../src/paths.mjs';
import {startTestApi, pdfInfo, pdfImageCount, PNG_DATA_URI, TEMPLATE_IDS} from './helpers.mjs';
import {baseUrl, embedImages} from '../../skills/printmd/scripts/printmd.mjs';

const SCRIPT = join(REPO_ROOT, 'skills/printmd/scripts/printmd.mjs');
const PNG = Buffer.from(PNG_DATA_URI.split(',')[1], 'base64');

let api;
let work;
let docDir;

/** Runs the script as a child process (async: the API under test runs in this process). */
function run(args, env = {}) {
    return new Promise((resolve) => {
        execFile(process.execPath, [SCRIPT, ...args], {env: {...process.env, ...env}, timeout: 90000}, (err, stdout, stderr) => {
            resolve({code: err ? err.code : 0, stdout, stderr});
        });
    });
}

function freePort() {
    return new Promise((resolve, reject) => {
        const server = createServer();
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const {port} = server.address();
            server.close(() => resolve(port));
        });
    });
}

before(async () => {
    api = await startTestApi();
    work = mkdtempSync(join(tmpdir(), 'printmd-skill-'));
    docDir = join(work, 'doc');
    mkdirSync(join(docDir, 'img'), {recursive: true});
    writeFileSync(join(docDir, 'img/dot.png'), PNG);
    writeFileSync(join(work, 'outside.png'), PNG);
    symlinkSync(join(work, 'outside.png'), join(docDir, 'img/link.png'));
    writeFileSync(join(docDir, 'doc.md'), [
        '---', 'title: Skill test', '---', '',
        '# Skill test', '',
        '![inside](img/dot.png)', '',
        '![outside](../outside.png)', '',
        '![a link that leads out](img/link.png)', '',
        '![web](https://example.com/a.png)', '',
        '```', '![in code](img/dot.png)', '```', '',
    ].join('\n'));
});

after(async () => {
    await api.close();
    rmSync(work, {recursive: true, force: true});
});

const env = () => ({PRINTMD_URL: api.url});

test('check: reports the running API', async () => {
    const r = await run(['check'], env());
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /The PrintMD API is running at http:\/\/127\.0\.0\.1:\d+/);
});

test('templates: one line per template the API lists, the default marked', async () => {
    const list = await (await fetch(`${api.url}/api/v1/templates`)).json();
    const r = await run(['templates'], env());
    assert.equal(r.code, 0, r.stderr);
    const lines = r.stdout.trim().split('\n');
    assert.equal(lines.length, TEMPLATE_IDS.length);
    for (const id of TEMPLATE_IDS) assert.ok(lines.some((l) => l.startsWith(id)), `${id} is listed`);
    assert.ok(lines.find((l) => l.startsWith(list.default)).includes('(default)'), 'the default is marked');
});

test('render: embeds the local image, refuses the ones outside the folder, leaves code alone', async () => {
    const list = await (await fetch(`${api.url}/api/v1/templates`)).json();
    const r = await run(['render', join(docDir, 'doc.md'), '--json'], env());
    assert.equal(r.code, 0, r.stderr);
    const result = JSON.parse(r.stdout);
    assert.equal(result.path, join(docDir, 'doc.pdf'));
    assert.equal(result.template, list.default);
    const pdf = readFileSync(result.path);
    assert.equal(result.pages, pdfInfo(pdf).pages, 'pages match pdfinfo');
    assert.equal(pdfImageCount(pdf), 1, 'only the image inside the folder is in the PDF');
    const outside = result.localWarnings.filter((w) => /outside the document's folder/.test(w));
    assert.equal(outside.length, 2, `the file outside and the link that leads out: ${result.localWarnings}`);
    assert.deepEqual(result.remoteImages, ['https://example.com/a.png']);
});

test('render: will not replace a PDF without --force, and does with it', async () => {
    const target = join(docDir, 'doc.pdf');
    const before = readFileSync(target);
    const refused = await run(['render', join(docDir, 'doc.md')], env());
    assert.equal(refused.code, 6);
    assert.match(refused.stderr, /already exists/);
    assert.deepEqual(readFileSync(target), before, 'the PDF is untouched');
    const forced = await run(['render', join(docDir, 'doc.md'), '--force'], env());
    assert.equal(forced.code, 0, forced.stderr);
    assert.match(forced.stdout, /^PDF: /);
});

test('render: an unknown template is refused and the choices are named', async () => {
    const r = await run(['render', join(docDir, 'doc.md'), '--template', 'nope', '-o', join(work, 'x.pdf')], env());
    assert.equal(r.code, 2);
    for (const id of TEMPLATE_IDS) assert.ok(r.stderr.includes(id), `${id} is named`);
});

test('a stopped API gives the start commands and exit 3', async () => {
    const port = await freePort();
    const r = await run(['check'], {PRINTMD_URL: `http://127.0.0.1:${port}`});
    assert.equal(r.code, 3);
    assert.match(r.stderr, /npm --prefix server run start:local/);
    assert.match(r.stderr, /systemctl --user start printmd-api/);
});

test('only a local address is accepted', async () => {
    for (const url of ['http://example.com', 'https://127.0.0.1:8787', 'http://user:pw@127.0.0.1:8787',
        'http://127.0.0.1:8787/api', 'http://127.0.0.1.evil.test']) {
        assert.throws(() => baseUrl({PRINTMD_URL: url}), (e) => e.code === 2, url);
    }
    assert.equal(baseUrl({PRINTMD_URL: 'http://localhost:9000/'}), 'http://localhost:9000');
    assert.equal(baseUrl({}), 'http://127.0.0.1:8787');
    const r = await run(['check'], {PRINTMD_URL: 'http://example.com'});
    assert.equal(r.code, 2);
});

test('embedImages: folder rules, types, code blocks, HTML images and reference definitions', () => {
    writeFileSync(join(docDir, 'img/notes.txt'), 'not an image');
    writeFileSync(join(docDir, 'img/with space.png'), PNG);
    const md = [
        '![a](img/dot.png "a title")',
        '![b](<img/with space.png>)',
        '<img alt="c" src="img/dot.png" width="10">',
        '[ref]: img/dot.png',
        '[page]: img/notes.txt',
        '![d](img/notes.txt)',
        '![e](img/missing.png)',
        '![f](data:image/png;base64,AAAA)',
        '~~~',
        '![g](img/dot.png)',
        '~~~',
        '',
    ].join('\n');
    const out = embedImages(md, docDir);
    const lines = out.markdown.split('\n');
    assert.match(lines[0], /^!\[a\]\(data:image\/png;base64,[A-Za-z0-9+/=]+ "a title"\)$/);
    assert.match(lines[1], /^!\[b\]\(data:image\/png;base64,/);
    assert.match(lines[2], /^<img alt="c" src="data:image\/png;base64,[A-Za-z0-9+/=]+" width="10">$/);
    assert.match(lines[3], /^\[ref\]: data:image\/png;base64,/);
    assert.equal(lines[4], '[page]: img/notes.txt', 'a link to a text file is left as written');
    assert.equal(lines[5], '![d](img/notes.txt)');
    assert.equal(lines[7], '![f](data:image/png;base64,AAAA)');
    assert.equal(lines[9], '![g](img/dot.png)', 'inside a code block');
    assert.deepEqual(out.warnings, [
        'Not a png, jpeg, gif, webp or svg image: img/notes.txt',
        'Image not found: img/missing.png',
    ]);
    assert.deepEqual(out.remote, []);
});
