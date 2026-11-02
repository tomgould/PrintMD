/**
 * Rendering with a real Chromium, checked with poppler: page sizes, cover and
 * heading text, embedded brand fonts, page count, front matter on the cover,
 * and how closely the API's PDF matches the editor's own export.
 */
import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import {launchChrome, sleep} from '../../tests/lib/chrome.mjs';
import {startStaticServer} from '../../tests/lib/static-server.mjs';
import {findChrome} from '../src/browser.mjs';
import {REPO_ROOT} from '../src/paths.mjs';
import {startTestApi, render, warningsOf, pdfInfo, pdfText, pdfFonts, SHOWCASE, CHROME,
    TEMPLATE_IDS, DEFAULT_TEMPLATE, DEFAULT_QUERY, bodyFontPrefix} from './helpers.mjs';

const TEMPLATES = TEMPLATE_IDS;
const BRAND_FONT = Object.fromEntries(TEMPLATES.map((id) => [id, new RegExp(`^${bodyFontPrefix(id)}`)]));
const HEADINGS = [...SHOWCASE.matchAll(/^## (.+)$/gm)].map((m) => m[1].trim());
/** Text for matching: templates letter-space and upper-case some lines, so case and spacing are ignored. */
const squash = (text) => text.toLowerCase().replace(/[\s`*]/g, '');
const has = (text, needle) => squash(text).includes(squash(needle));

let api;

before(async () => {
    api = await startTestApi();
});

after(async () => {
    await api.close();
});

for (const template of TEMPLATES) {
    test(`showcase with ${template}: A4, cover title, headings, brand fonts, page count`, async () => {
        const r = await render(api.url, SHOWCASE, `template=${template}`);
        assert.equal(r.status, 200);
        const info = pdfInfo(r.body);
        assert.equal(Math.round(info.width), 595);
        assert.equal(Math.round(info.height), 842);
        assert.equal(info.pages, Number(r.headers.get('x-printmd-pages')), 'X-PrintMD-Pages matches pdfinfo');
        const firstPage = pdfText(r.body, ['-f', '1', '-l', '1']);
        assert.ok(has(firstPage, 'Markdown Showcase'), 'cover title on page 1');
        const text = pdfText(r.body);
        assert.ok(HEADINGS.length > 10);
        for (const heading of HEADINGS) assert.ok(has(text, heading), `heading "${heading}" in the text`);
        const fonts = pdfFonts(r.body);
        assert.ok(fonts.some((f) => BRAND_FONT[template].test(f.name) && f.embedded), `brand font embedded: ${fonts.map((f) => f.name).join(', ')}`);
        assert.ok(fonts.every((f) => f.embedded), 'every font embedded');
        assert.deepEqual(warningsOf(r), [
            'Removed 3 images not embedded as a data: URI. Embed images as data:image/png;base64,... (png, jpeg, gif, webp or svg).',
            'Blocked a request to picsum.photos.',
        ]);
    });
}

test('landscape swaps the sides; Letter is 612 x 792', async () => {
    const landscape = pdfInfo((await render(api.url, '# L\n\ntext', 'orientation=landscape')).body);
    assert.deepEqual([Math.round(landscape.width), Math.round(landscape.height)], [842, 595]);
    const letter = pdfInfo((await render(api.url, '# L\n\ntext', 'pageSize=Letter')).body);
    assert.deepEqual([Math.round(letter.width), Math.round(letter.height)], [612, 792]);
    const letterLandscape = pdfInfo((await render(api.url, '# L\n\ntext', 'pageSize=Letter&orientation=landscape')).body);
    assert.deepEqual([Math.round(letterLandscape.width), Math.round(letterLandscape.height)], [792, 612]);
});

test('front matter: on the cover, never in the body; request options win (every template)', async () => {
    const src = '---\ntitle: Front Matter Title\nauthor: Jo Bloggs\ndate: 2026-03-01\n---\n# Body Heading\n\nBody text.';
    for (const id of TEMPLATES) {
        const r = await render(api.url, src, `template=${id}`);
        assert.equal(r.status, 200);
        const cover = pdfText(r.body, ['-f', '1', '-l', '1']);
        assert.ok(has(cover, 'Front Matter Title'), `${id}: ${cover}`);
        assert.ok(has(cover, 'Jo Bloggs'), `${id}: ${cover}`);
        assert.ok(has(cover, '1 March 2026'), `${id}: ${cover}`);
        const all = pdfText(r.body);
        assert.ok(!/author:|title:|date:/.test(all), `${id}: the block is not printed`);
        assert.ok(has(all, 'Body Heading'));

        const over = await render(api.url, src, `template=${id}&author=Sam%20Smith&date=Q3%202026`);
        const overCover = pdfText(over.body, ['-f', '1', '-l', '1']);
        assert.ok(has(overCover, 'Sam Smith') && !has(overCover, 'Jo Bloggs'), `${id}: ${overCover}`);
        assert.ok(has(overCover, 'Q3 2026'), `${id}: ${overCover}`);
        assert.ok(has(overCover, 'Front Matter Title'), `${id}: ${overCover}`);
    }
});

test('long data URIs in code and plain text come out as written, with no placeholder left', async () => {
    const uri = (tag) => `data:image/png;base64,${tag}${'A'.repeat(2000)}`;
    const src = `# Data URIs as text\n\n\`\`\`text\n${uri('CODEBLOCK')}\n\`\`\`\n\n\`\`\`css\n.x { background: url(${uri('CSSCODE')}); }\n\`\`\`\n\n`
        + `Inline: ${uri('INLINETEXT')} and \`${uri('INLINECODE')}\` end.\n`;
    const r = await render(api.url, src, 'template=unbranded');
    assert.equal(r.status, 200);
    const text = pdfText(r.body).replace(/\s+/g, '');
    for (const tag of ['CODEBLOCK', 'CSSCODE', 'INLINETEXT', 'INLINECODE']) {
        assert.ok(text.includes(`data:image/png;base64,${tag}AAAA`), `${tag} restored`);
    }
    assert.ok(!/render\.invalid|__bd|bdimg/i.test(text), 'no placeholder in the PDF');

    const titled = await render(api.url, `# ${uri('TITLE')}\n\ntext`, DEFAULT_QUERY);
    const cover = pdfText(titled.body, ['-f', '1', '-l', '1']).replace(/\s+/g, '');
    assert.ok(cover.includes('data:image/png;base64,TITLEAAAA') && !/bdimg/.test(cover), 'a heading title is restored on the cover');
});

// ── Editor comparison ──

/** Minimal CDP client on a tests/lib/chrome.mjs browser, as tests/shoot.mjs does. */
async function cdpPage(port) {
    let wsUrl;
    for (let i = 0; i < 80 && !wsUrl; i++) {
        try {
            const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
            const p = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
            if (p) wsUrl = p.webSocketDebuggerUrl;
        } catch { /* not up yet */ }
        if (!wsUrl) await sleep(250);
    }
    if (!wsUrl) throw new Error('no devtools target');
    const ws = new WebSocket(wsUrl);
    let id = 1;
    const pending = new Map();
    ws.addEventListener('message', (ev) => {
        const m = JSON.parse(ev.data);
        if (m.id && pending.has(m.id)) {
            pending.get(m.id)(m);
            pending.delete(m.id);
        }
    });
    await new Promise((ok, fail) => { ws.addEventListener('open', ok); ws.addEventListener('error', fail); });
    const send = (method, params = {}) => new Promise((ok, fail) => {
        const msgId = id++;
        pending.set(msgId, (m) => (m.error ? fail(new Error(m.error.message)) : ok(m.result)));
        ws.send(JSON.stringify({id: msgId, method, params}));
    });
    const evaluate = async (expression) => (await send('Runtime.evaluate', {expression, awaitPromise: true, returnByValue: true})).result.value;
    return {send, evaluate, close: () => ws.close()};
}

/** The showcase without its remote images, so both sides lay out the same content. */
const COMPARE_DOC = SHOWCASE.split('\n').filter((l) => !/picsum\.photos/.test(l)).join('\n');

function words(text) {
    return text.replace(/\f/g, ' ').split(/\s+/).filter(Boolean);
}

/** Similarity of two word lists: 2 x LCS / (a + b). */
function similarity(a, b) {
    let prev = new Uint16Array(b.length + 1);
    let cur = new Uint16Array(b.length + 1);
    for (let i = 1; i <= a.length; i++) {
        for (let j = 1; j <= b.length; j++) {
            cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
        }
        [prev, cur] = [cur, prev];
    }
    return (2 * prev[b.length]) / (a.length + b.length);
}

test('the API PDF matches the editor export of the same document', async () => {
    const server = await startStaticServer(REPO_ROOT);
    const chrome = await launchChrome(`${server.origin}/server/test/fixtures/editor-print.html`, {
        bin: findChrome(CHROME),
        extraArgs: ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'],
    });
    try {
        const page = await cdpPage(chrome.port);
        for (let i = 0; i < 80 && !(await page.evaluate('window.__ready === true')); i++) await sleep(100);
        // Started, not awaited: the export rewrites this document, so poll for its print() call.
        await page.evaluate(`void window.__editorPrint(${JSON.stringify(COMPARE_DOC)}, ${JSON.stringify(DEFAULT_TEMPLATE)}, {pageSize: 'A4', orientation: 'portrait'}), true`);
        for (let i = 0; i < 200 && !(await page.evaluate('window.__printed === true')); i++) await sleep(100);
        assert.equal(await page.evaluate('window.__printed'), true, 'the editor export reached print()');
        const {data} = await page.send('Page.printToPDF', {preferCSSPageSize: true, printBackground: true});
        page.close();
        const editorPdf = Buffer.from(data, 'base64');

        const r = await render(api.url, COMPARE_DOC, `${DEFAULT_QUERY}&pageSize=A4&orientation=portrait`);
        assert.equal(r.status, 200);
        assert.deepEqual(warningsOf(r), []);

        const editorInfo = pdfInfo(editorPdf);
        const apiInfo = pdfInfo(r.body);
        const editorWords = words(pdfText(editorPdf));
        const apiWords = words(pdfText(r.body));
        const score = similarity(editorWords, apiWords);
        const exact = editorWords.join(' ') === apiWords.join(' ');
        console.log(`# editor vs API (${DEFAULT_TEMPLATE}, A4): pages ${editorInfo.pages} vs ${apiInfo.pages}, `
            + `words ${editorWords.length} vs ${apiWords.length}, similarity ${(score * 100).toFixed(2)}%, identical text: ${exact}`);
        assert.deepEqual([Math.round(apiInfo.width), Math.round(apiInfo.height)], [Math.round(editorInfo.width), Math.round(editorInfo.height)]);
        assert.equal(apiInfo.pages, editorInfo.pages, 'same page count');
        assert.ok(score >= 0.99, `text similarity ${score}`);
        const editorFonts = new Set(pdfFonts(editorPdf).map((f) => f.name));
        const apiFonts = new Set(pdfFonts(r.body).map((f) => f.name));
        assert.deepEqual([...apiFonts].sort(), [...editorFonts].sort(), 'same fonts');
    } finally {
        await chrome.stop();
        await server.close();
    }
});
