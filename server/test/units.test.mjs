/**
 * Unit tests for the API's pure parts: request parsing and validation, option
 * precedence, the asset allow-list, file names, error JSON, the warnings
 * header, the queue, PDF page counting and the configuration rules.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {ApiError, errorBody} from '../src/errors.mjs';
import {parseRenderRequest, resolveTemplate, checkPageSize, markdownSize, LIMITS} from '../src/options.mjs';
import {templatePageSizes} from '../../js/export-options.js';
import {resolveAssetPath, RENDER_ORIGIN} from '../src/assets.mjs';
import {safeFilename} from '../src/filename.mjs';
import {warningsHeader} from '../src/warnings.mjs';
import {Limiter} from '../src/limiter.mjs';
import {countPdfPages} from '../src/pdf.mjs';
import {pdfString, setPdfInfo} from '../src/pdf-info.mjs';
import {loadConfig, isLoopbackHost, ConfigError} from '../src/config.mjs';
import {listTemplates, DEFAULT_TEMPLATE, TEMPLATE_IDS} from '../src/templates-info.mjs';
import {getTemplates} from '../../js/templates.js';
import {REPO_ROOT} from '../src/paths.mjs';
import {cssUrls, metaRefreshUrl, srcsetUrls, dataImageSpans, uncountedSpans, UNCOUNTED_MIN_PAYLOAD} from '../src/untrusted.mjs';

const md = (text, query = '') => ({contentType: 'text/markdown; charset=utf-8', query: new URLSearchParams(query), body: Buffer.from(text)});
const json = (obj, contentType = 'application/json') => ({contentType, query: new URLSearchParams(), body: Buffer.from(JSON.stringify(obj))});

function rejects(fn, status, code) {
    assert.throws(fn, (e) => {
        assert.ok(e instanceof ApiError, `ApiError, got ${e}`);
        assert.equal(e.status, status, `status for ${code}: ${e.status} ${e.code}`);
        assert.equal(e.code, code);
        return true;
    });
}

// ── Request parsing ──

test('text/markdown with options in the query string', () => {
    const r = parseRenderRequest(md('# Hi', 'template=example-co&pageSize=letter&orientation=Landscape&title=T&author=A&date=2026-01-02&strict=true'));
    assert.deepEqual(r, {markdown: '# Hi', template: 'example-co', pageSize: 'Letter', orientation: 'landscape',
        meta: {title: 'T', author: 'A', date: '2026-01-02'}, strict: true, tidy: true, cover: true});
});

test('application/json body with meta', () => {
    const r = parseRenderRequest(json({markdown: '# Hi', template: 'other-co', pageSize: 'A5', orientation: 'portrait', meta: {title: 'T'}, strict: false}));
    assert.deepEqual(r, {markdown: '# Hi', template: 'other-co', pageSize: 'A5', orientation: 'portrait', meta: {title: 'T'},
        strict: false, tidy: true, cover: true});
});

test('defaults: no options means nothing set, strict off, tidy and cover on, printLinks left to the front matter', () => {
    const defaults = {markdown: 'x', meta: {}, strict: false, tidy: true, cover: true};
    assert.deepEqual(parseRenderRequest(md('x')), defaults);
    assert.deepEqual(parseRenderRequest({...md('x'), contentType: 'TEXT/Markdown'}), defaults);
});

test('PDF information: strings escaped or UTF-16, anything not a classic PDF left as it is', () => {
    assert.equal(pdfString('a (b) \\ c'), '(a \\(b\\) \\\\ c)');
    assert.equal(pdfString('é'), '<FEFF00E9>');
    const notPdf = Buffer.from('hello');
    assert.equal(setPdfInfo(notPdf, {title: 'x'}).toString(), 'hello');
    const noTrailer = Buffer.from('%PDF-1.7\n1 0 obj\n<</Type /XRef>>\nendobj\n');
    assert.equal(setPdfInfo(noTrailer, {title: 'x'}).toString(), noTrailer.toString(), 'an xref-stream PDF is not touched');
});

test('print options: lang, subject, tidy, printLinks and cover, in the query and in JSON', () => {
    const q = parseRenderRequest(md('x', 'lang=en-GB&subject=S&tidy=false&printLinks=true&cover=0'));
    assert.deepEqual(q, {markdown: 'x', lang: 'en-GB', meta: {subject: 'S'}, strict: false, tidy: false, printLinks: true, cover: false});
    const j = parseRenderRequest(json({markdown: 'x', lang: 'fr', meta: {subject: 'S'}, tidy: false, printLinks: false, cover: true}));
    assert.deepEqual(j, {markdown: 'x', lang: 'fr', meta: {subject: 'S'}, strict: false, tidy: false, printLinks: false, cover: true});
    rejects(() => parseRenderRequest(md('x', 'lang=english%20please')), 400, 'invalid_option');
    rejects(() => parseRenderRequest(md('x', 'tidy=maybe')), 400, 'invalid_option');
    rejects(() => parseRenderRequest(json({markdown: 'x', printLinks: 'yes'})), 400, 'invalid_option');
});

test('415 for a missing or unsupported content type (form-postable ones included), or a non-UTF-8 charset', () => {
    for (const contentType of ['', 'text/html', 'text/plain', 'text/plain; charset=utf-8', 'text/x-markdown', 'multipart/form-data; boundary=x',
        'application/x-www-form-urlencoded', 'text/markdown; charset=latin1']) {
        rejects(() => parseRenderRequest({...md('x'), contentType}), 415, 'unsupported_media_type');
    }
});

test('400 for invalid UTF-8, empty Markdown and bad JSON', () => {
    rejects(() => parseRenderRequest({...md(''), body: Buffer.from([0x23, 0x20, 0xff, 0xfe])}), 400, 'invalid_encoding');
    rejects(() => parseRenderRequest(md('   \n ')), 400, 'empty_markdown');
    rejects(() => parseRenderRequest({...json({}), body: Buffer.from('{nope')}), 400, 'invalid_json');
    rejects(() => parseRenderRequest(json([1, 2])), 400, 'invalid_json');
    rejects(() => parseRenderRequest(json({template: 'example-co'})), 400, 'invalid_option');
    rejects(() => parseRenderRequest(json({markdown: 42})), 400, 'invalid_option');
});

test('400 for unknown, repeated or invalid options', () => {
    rejects(() => parseRenderRequest(md('x', 'pagesize=A4')), 400, 'unknown_option');
    rejects(() => parseRenderRequest(md('x', 'template=example-co&template=other-co')), 400, 'invalid_option');
    rejects(() => parseRenderRequest(md('x', 'pageSize=B5')), 400, 'invalid_option');
    rejects(() => parseRenderRequest(md('x', 'pageSize=A4;%20}%20body{display:none')), 400, 'invalid_option');
    rejects(() => parseRenderRequest(md('x', 'orientation=sideways')), 400, 'invalid_option');
    rejects(() => parseRenderRequest(md('x', 'strict=maybe')), 400, 'invalid_option');
    rejects(() => parseRenderRequest(md('x', 'template=../example-co')), 400, 'invalid_option');
    rejects(() => parseRenderRequest(md('x', `title=${'t'.repeat(201)}`)), 400, 'invalid_option');
    rejects(() => parseRenderRequest(json({markdown: 'x', extra: 1})), 400, 'unknown_option');
    rejects(() => parseRenderRequest(json({markdown: 'x', meta: {title: 'x', subtitle: 'y'}})), 400, 'unknown_option');
    rejects(() => parseRenderRequest(json({markdown: 'x', meta: 'title'})), 400, 'invalid_option');
    rejects(() => parseRenderRequest(json({markdown: 'x', meta: {title: 5}})), 400, 'invalid_option');
    rejects(() => parseRenderRequest(json({markdown: 'x', strict: 'yes'})), 400, 'invalid_option');
});

test('error messages never echo the value that was sent', () => {
    const canary = 'CANARY-7f3a';
    for (const req of [md('x', `pageSize=${canary}`), md('x', `${canary}=1`), json({markdown: 'x', [canary]: 1}), md('x', `template=${canary}`)]) {
        try {
            resolveTemplate(parseRenderRequest(req), {});
            assert.fail('should throw');
        } catch (e) {
            assert.ok(!JSON.stringify(errorBody(e)).includes(canary), JSON.stringify(errorBody(e)));
        }
    }
});

test('413 for Markdown over 2 MB; data: URI payloads do not count toward it', () => {
    rejects(() => parseRenderRequest(md('a'.repeat(LIMITS.markdownBytes + 1))), 413, 'markdown_too_large');
    const image = `![x](data:image/png;base64,${'A'.repeat(3 * 1024 * 1024)})`;
    assert.equal(parseRenderRequest(md(`# Big image\n\n${image}`)).markdown.length > LIMITS.markdownBytes, true);
    assert.ok(markdownSize(`# T\n\n${image}`) < 100);
});

// ── Linear scans (src/untrusted.mjs) ──

test('cssUrls: url(), @import and image-set(), quoted or not, any case', () => {
    const css = `a{background:URL( "http://a/1" )} b{background:url(http://a/2)} @import 'http://a/3'; @IMPORT "http://a/4";
        c{background:image-set("http://a/5" 1x)} d{x:url()} e{x:url(unclosed`;
    assert.deepEqual(cssUrls(css), ['http://a/1', 'http://a/2', '', 'http://a/3', 'http://a/4', 'http://a/5']);
    assert.deepEqual(cssUrls('@import "never closed'), []);
});

test('metaRefreshUrl and srcsetUrls', () => {
    assert.equal(metaRefreshUrl('0; url=http://a/x'), 'http://a/x');
    assert.equal(metaRefreshUrl("5;URL = 'http://a/y'"), 'http://a/y');
    assert.equal(metaRefreshUrl('5'), null);
    assert.deepEqual(srcsetUrls('http://a/1 1x, http://a/2 2x,'), ['http://a/1', 'http://a/2']);
});

test('dataImageSpans: well-formed base64 image data URIs only', () => {
    const text = '![a](data:image/png;base64,AAAA) data:image/ data:image/svg+xml,%3Csvg%3E" data:text/plain,abc '
        + 'data:image/png,ab*c data:image/gif;base64,R0lG*x data:image/webp;foo=1;base64,UklG';
    const spans = dataImageSpans(text).map((s) => text.slice(s.start, s.end));
    assert.deepEqual(spans, ['data:image/png;base64,AAAA', 'data:image/webp;foo=1;base64,UklG']);
});

test('uncounted payloads: one definition for the size check and the harness stash', () => {
    const big = `data:image/png;base64,${'A'.repeat(UNCOUNTED_MIN_PAYLOAD)}`;
    const small = `data:image/png;base64,${'A'.repeat(UNCOUNTED_MIN_PAYLOAD - 1)}`;
    const text = `${big} ${small} data:image/png,${'a'.repeat(5000)}`;
    assert.deepEqual(uncountedSpans(text).map((s) => text.slice(s.start, s.end)), [big]);
    assert.equal(markdownSize(text), text.length - UNCOUNTED_MIN_PAYLOAD);
});

test('413: the 2 MB limit cannot be dodged with data:image text that is not a stashed base64 payload', () => {
    const MB2 = LIMITS.markdownBytes;
    // A payload that is not base64, then text that only looks like one.
    rejects(() => parseRenderRequest(md(`# x\n\ndata:image/png,${'a'.repeat(MB2 + 10)}`)), 413, 'markdown_too_large');
    rejects(() => parseRenderRequest(md(`# x\n\ndata:image/png,${'*_'.repeat(MB2)}`)), 413, 'markdown_too_large');
    // Many small URIs, each under the stash size, add up.
    const smalls = Array.from({length: Math.ceil(MB2 / 1000) + 10}, () => `data:image/png;base64,${'A'.repeat(1000)}`).join(' ');
    rejects(() => parseRenderRequest(md(`# x\n\n${smalls}`)), 413, 'markdown_too_large');
    // A real large embedded image still passes.
    assert.ok(parseRenderRequest(md(`# x\n\n![i](data:image/png;base64,${'A'.repeat(3 * MB2)})`)).markdown);
    // The message says exactly what is left out.
    assert.throws(() => parseRenderRequest(md('a'.repeat(MB2 + 1))),
        (e) => /base64 image data URIs of 1 KB or more/.test(e.message));
});

// ── Template and option precedence ──

test('template: request option > front matter > default', () => {
    // The registry's last two templates: with three or more, neither is the default (the first).
    const [fromRequest, fromFront] = [TEMPLATE_IDS.at(-1), TEMPLATE_IDS.at(-2) ?? TEMPLATE_IDS[0]];
    assert.deepEqual(resolveTemplate({template: fromRequest}, {template: fromFront}), {templateId: fromRequest, warnings: []});
    assert.deepEqual(resolveTemplate({}, {template: fromRequest}), {templateId: fromRequest, warnings: []});
    assert.deepEqual(resolveTemplate({}, {}), {templateId: DEFAULT_TEMPLATE, warnings: []});
});

test('template: an unknown request template is 404; an unknown front matter template is a warning', () => {
    rejects(() => resolveTemplate({template: 'nope'}, {}), 404, 'unknown_template');
    const r = resolveTemplate({}, {template: 'nope'});
    assert.equal(r.templateId, DEFAULT_TEMPLATE);
    assert.equal(r.warnings.length, 1);
    assert.ok(!r.warnings[0].includes('nope'), 'front matter value not echoed');
});

test('the template list comes from the real manifests', () => {
    const list = listTemplates();
    assert.deepEqual(list.templates.map((t) => t.id), getTemplates().map((t) => t.manifest.id), 'every registry template, in order');
    assert.equal(list.default, DEFAULT_TEMPLATE);
    assert.equal(DEFAULT_TEMPLATE, getTemplates()[0].manifest.id, 'the default is the first');
    assert.deepEqual(Object.keys(list), ['default', 'pageOptions', 'templates'], 'no "warnings" key when nothing was skipped');
    for (const t of list.templates) {
        assert.ok(t.name && t.description, t.id);
        // The paper sizes, unless the template lists its own (manifest.page.sizes, such as Slide).
        const page = getTemplates().find((e) => e.manifest.id === t.id).manifest.page;
        assert.deepEqual(t.pageSizes, page.sizes ? [...templatePageSizes({page})] : ['A4', 'A3', 'A5', 'Letter', 'Legal']);
        assert.deepEqual(t.orientations, ['portrait', 'landscape']);
    }
});

test('checkPageSize: Slide only for a template that offers it, named in the message without the value sent', () => {
    for (const id of TEMPLATE_IDS) {
        const sizes = templatePageSizes(getTemplates().find((e) => e.manifest.id === id).manifest);
        for (const pageSize of sizes) checkPageSize({pageSize}, id);
        checkPageSize({}, id);
        if (!sizes.includes('Slide')) {
            rejects(() => checkPageSize({pageSize: 'Slide'}, id), 400, 'invalid_option');
            assert.throws(() => checkPageSize({pageSize: 'Slide'}, id),
                (e) => e.message === `This template offers pageSize ${sizes.join(', ')}, or a custom size (see GET /api/v1/templates).`);
        }
        // A custom size is allowed with every template.
        checkPageSize({pageSize: '100x150mm'}, id);
    }
});

// ── Asset allow-list ──

test('assets: only files under js, templates, vendor and assets are served', async () => {
    assert.equal(await resolveAssetPath(`${RENDER_ORIGIN}/js/markdown.js`), join(REPO_ROOT, 'js/markdown.js'));
    assert.equal(await resolveAssetPath(`${RENDER_ORIGIN}/vendor/fonts/inter/inter-latin-400-normal.woff2`),
        join(REPO_ROOT, 'vendor/fonts/inter/inter-latin-400-normal.woff2'));
    assert.equal(await resolveAssetPath(`${RENDER_ORIGIN}/assets/favicon.svg`), join(REPO_ROOT, 'assets/favicon.svg'));
    assert.equal(await resolveAssetPath(`${RENDER_ORIGIN}/templates/manifest.core.json`), join(REPO_ROOT, 'templates/manifest.core.json'),
        'the template manifests are the only JSON served');
    for (const url of [
        `${RENDER_ORIGIN}/index.html`,
        `${RENDER_ORIGIN}/server/src/main.mjs`,
        `${RENDER_ORIGIN}/tests/test.js`,
        `${RENDER_ORIGIN}/js/`,
        `${RENDER_ORIGIN}/js/missing.js`,
        `${RENDER_ORIGIN}/js/../../etc/passwd`,
        `${RENDER_ORIGIN}/../../etc/passwd`,
        `${RENDER_ORIGIN}/js/%2e%2e/%2e%2e/etc/passwd`,
        `${RENDER_ORIGIN}/js/%2E%2E/index.html`,
        `${RENDER_ORIGIN}/js/..%2f..%2fetc/passwd`,
        `${RENDER_ORIGIN}/js\\..\\index.html`,
        `${RENDER_ORIGIN}/js/%5c..%5cindex.html`,
        `${RENDER_ORIGIN}/js/markdown.js%00.png`,
        `${RENDER_ORIGIN}/.git/config`,
        `${RENDER_ORIGIN}/vendor/fonts/README.md`,
        `${RENDER_ORIGIN}/templates/manifest.missing.json`,
        `${RENDER_ORIGIN}/js/manifest.core.json`,
        `${RENDER_ORIGIN}/vendor/manifest.core.json`,
        `${RENDER_ORIGIN}/templates/unbranded/manifest.core.json`,
        `${RENDER_ORIGIN}/templates/manifest.Core.json`,
        'https://render.invalid.evil.com/js/markdown.js',
        'https://evil.com/js/markdown.js',
        'http://render.invalid/js/markdown.js',
        'https://user@render.invalid/js/markdown.js',
        'https://render.invalid:444/js/markdown.js',
        'file:///etc/passwd',
        'not a url',
    ]) {
        assert.equal(await resolveAssetPath(url), null, url);
    }
});

test('assets: a symlink that leaves its folder is refused', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bd-assets-'));
    try {
        mkdirSync(join(root, 'js'));
        mkdirSync(join(root, 'outside'));
        writeFileSync(join(root, 'outside/secret.js'), 'secret');
        writeFileSync(join(root, 'js/ok.js'), 'ok');
        symlinkSync(join(root, 'outside/secret.js'), join(root, 'js/link.js'));
        symlinkSync('/etc/hostname', join(root, 'js/etc.js'));
        assert.equal(await resolveAssetPath(`${RENDER_ORIGIN}/js/ok.js`, root), join(root, 'js/ok.js'));
        assert.equal(await resolveAssetPath(`${RENDER_ORIGIN}/js/link.js`, root), null);
        assert.equal(await resolveAssetPath(`${RENDER_ORIGIN}/js/etc.js`, root), null);
    } finally {
        rmSync(root, {recursive: true, force: true});
    }
});

// ── File names ──

test('safeFilename: ASCII, no quotes or path characters, a .pdf extension and a fallback', () => {
    assert.equal(safeFilename('Quarterly Report'), 'Quarterly Report.pdf');
    assert.equal(safeFilename('Dvořák: "Plan" / v2'), 'Dvorak Plan v2.pdf');
    assert.equal(safeFilename('../../etc/passwd'), 'etc passwd.pdf');
    assert.equal(safeFilename('a\r\nContent-Type: text/html'), 'a Content-Type text html.pdf');
    assert.equal(safeFilename('日本語'), 'document.pdf');
    assert.equal(safeFilename(''), 'document.pdf');
    assert.equal(safeFilename('CON'), 'CON_.pdf');
    assert.ok(safeFilename('x'.repeat(500)).length <= 84);
    assert.match(safeFilename('<script>alert(1)</script>'), /^[A-Za-z0-9 ._()-]+\.pdf$/);
});

// ── Errors and warnings ──

test('error JSON shape: {error: {code, message}}; unknown errors hide their text', () => {
    assert.deepEqual(errorBody(new ApiError(400, 'invalid_option', 'pageSize must be one of A4')), {error: {code: 'invalid_option', message: 'pageSize must be one of A4'}});
    assert.deepEqual(errorBody(new ApiError(422, 'strict_warnings', 'Warnings', {details: {warnings: ['w']}})),
        {error: {code: 'strict_warnings', message: 'Warnings', warnings: ['w']}});
    assert.deepEqual(errorBody(new Error('net::ERR_FAILED at /home/secret')), {error: {code: 'internal_error', message: 'Internal error'}});
});

test('warningsHeader: URL-encoded JSON, capped near 4 KB with a truncated marker', () => {
    assert.deepEqual(JSON.parse(decodeURIComponent(warningsHeader(['a', 'b é']))), ['a', 'b é']);
    assert.equal(warningsHeader([]), '%5B%5D');
    const many = Array.from({length: 400}, (_, i) => `Warning number ${i} with some words`);
    const header = warningsHeader(many);
    assert.ok(header.length <= 4096, `length ${header.length}`);
    assert.ok(/^[\x21-\x7e]+$/.test(header), 'header-safe characters only');
    const list = JSON.parse(decodeURIComponent(header));
    assert.match(list[list.length - 1], /^truncated: \d+ more$/);
    assert.equal(list.length - 1 + Number(/\d+/.exec(list[list.length - 1])[0]), many.length);
});

// ── Queue ──

test('Limiter: 2 run at once, 6 wait, the next one is refused with 429 and Retry-After', async () => {
    const limiter = new Limiter({maxActive: 2, maxQueue: 6});
    const gates = [];
    let running = 0, peak = 0;
    const job = () => new Promise((ok) => gates.push(() => ok())).finally(() => { running--; });
    const runs = Array.from({length: 8}, () => limiter.run(() => { running++; peak = Math.max(peak, running); return job(); }));
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(limiter.stats(), {active: 2, waiting: 6, maxActive: 2, maxQueue: 6});
    await assert.rejects(limiter.run(async () => 1), (e) => e.status === 429 && e.code === 'busy' && Number(e.headers['Retry-After']) > 0);
    while (gates.length || limiter.stats().active) {
        const g = gates.shift();
        if (g) g();
        await new Promise((r) => setImmediate(r));
    }
    await Promise.all(runs);
    assert.equal(peak, 2);
    assert.deepEqual(limiter.stats(), {active: 0, waiting: 0, maxActive: 2, maxQueue: 6});
});

test('Limiter: a cancelled waiter leaves the queue and a failing job frees its slot', async () => {
    const limiter = new Limiter({maxActive: 1, maxQueue: 2});
    let release;
    const first = limiter.run(() => new Promise((ok) => { release = ok; }));
    const ac = new AbortController();
    const cancelled = limiter.run(async () => 'never', {signal: ac.signal});
    ac.abort();
    await assert.rejects(cancelled, (e) => e.code === 'cancelled');
    assert.equal(limiter.stats().waiting, 0);
    release();
    await first;
    await assert.rejects(limiter.run(async () => { throw new Error('boom'); }), /boom/);
    assert.equal(await limiter.run(async () => 'ok'), 'ok');
});

// ── PDF ──

test('countPdfPages counts page objects, not the page tree', () => {
    const fake = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Pages /Kids [2 0 R 3 0 R] /Count 2 >>\n2 0 obj << /Type /Page >>\n3 0 obj <</Type/Page/Parent 1 0 R>>\n');
    assert.equal(countPdfPages(fake), 2);
    assert.equal(countPdfPages(Buffer.from('not a pdf')), 0);
});

// ── Configuration ──

test('isLoopbackHost', () => {
    for (const h of ['127.0.0.1', '127.1.2.3', '::1', 'localhost', '[::1]']) assert.ok(isLoopbackHost(h), h);
    for (const h of ['0.0.0.0', '::', '192.168.1.10', '10.0.0.1', 'example.com', '', '127.0.0.1.nip.io']) assert.ok(!isLoopbackHost(h), h);
});

test('config: defaults are deployed mode, API off, 127.0.0.1:8787', () => {
    const c = loadConfig({env: {}, argv: []});
    assert.equal(c.mode, 'access');
    assert.equal(c.apiEnabled, false);
    assert.equal(c.host, '127.0.0.1');
    assert.equal(c.port, 8787);
    assert.equal(c.testAuthBypass, false);
});

test('config: --local turns local mode and the API on; PRINTMD_MODE=local alone leaves the API off', () => {
    const c = loadConfig({env: {}, argv: ['--local']});
    assert.equal(c.mode, 'local');
    assert.equal(c.apiEnabled, true);
    const e = loadConfig({env: {PRINTMD_MODE: 'local'}, argv: []});
    assert.equal(e.mode, 'local');
    assert.equal(e.apiEnabled, false);
    assert.equal(loadConfig({env: {PRINTMD_MODE: 'local', PRINTMD_API_ENABLED: '1'}, argv: []}).apiEnabled, true);
    assert.equal(loadConfig({env: {PRINTMD_PORT: '9000'}, argv: []}).port, 9000);
});

test('config: auth off on a non-loopback address is refused', () => {
    for (const host of ['0.0.0.0', '::', '192.168.1.10', 'example.com']) {
        assert.throws(() => loadConfig({env: {PRINTMD_HOST: host}, argv: ['--local']}), ConfigError, host);
        assert.throws(() => loadConfig({env: {PRINTMD_HOST: host, NODE_ENV: 'test', PRINTMD_TEST_AUTH_BYPASS: '1'}, argv: []}), ConfigError, host);
    }
    assert.equal(loadConfig({env: {PRINTMD_HOST: '0.0.0.0'}, argv: []}).host, '0.0.0.0', 'deployed mode keeps auth on');
});

test('config: the test auth bypass needs NODE_ENV=test', () => {
    assert.throws(() => loadConfig({env: {PRINTMD_TEST_AUTH_BYPASS: '1'}, argv: []}), ConfigError);
    assert.throws(() => loadConfig({env: {PRINTMD_TEST_AUTH_BYPASS: '1', NODE_ENV: 'production'}, argv: []}), ConfigError);
    assert.equal(loadConfig({env: {PRINTMD_TEST_AUTH_BYPASS: '1', NODE_ENV: 'test'}, argv: []}).testAuthBypass, true);
});

test('config: invalid port and access settings are refused; certs URL override is test-only', () => {
    for (const p of ['abc', '-1', '70000', '80.5']) assert.throws(() => loadConfig({env: {PRINTMD_PORT: p}, argv: []}), ConfigError, p);
    assert.throws(() => loadConfig({env: {PRINTMD_ACCESS_TEAM_DOMAIN: 'https://team.example.com/'}, argv: []}), ConfigError);
    const c = loadConfig({env: {PRINTMD_ACCESS_TEAM_DOMAIN: 'Team.Example.com', PRINTMD_ACCESS_AUD: 'aud123',
        PRINTMD_ALLOWED_EMAIL_DOMAINS: 'Example.com, example.org'}, argv: []});
    assert.deepEqual(c.access, {teamDomain: 'team.example.com', aud: 'aud123', certsUrl: '',
        allowedEmailDomains: ['example.com', 'example.org']}, 'the access provider derives the keys URL from the team domain');
    assert.throws(() => loadConfig({env: {PRINTMD_ACCESS_CERTS_URL: 'http://127.0.0.1:1/certs'}, argv: []}), ConfigError);
    assert.equal(loadConfig({env: {NODE_ENV: 'test', PRINTMD_ACCESS_CERTS_URL: 'http://127.0.0.1:1/certs'}, argv: []}).access.certsUrl, 'http://127.0.0.1:1/certs');
});
