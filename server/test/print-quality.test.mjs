/**
 * The print-quality standard end to end: a sample document (headings, tables,
 * code in six languages, images, symbols, links) rendered through the API for
 * every template, with and without a cover, in A4 portrait, A4 landscape and
 * Letter, must pass every check of server/qa/pdf-qa.mjs. Then each check is
 * shown to catch its fault, on PDFs made bad on purpose.
 */
import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chromium} from 'playwright';
import {findChrome} from '../src/browser.mjs';
import {REPO_ROOT} from '../src/paths.mjs';
import {checkPdf, formatResult} from '../qa/pdf-qa.mjs';
import {startTestApi, render, CHROME, TEMPLATE_IDS} from './helpers.mjs';
import {pngDataUri} from './png.mjs';

const CODE = {
    js: 'export function total(items) {\n  return items.reduce((sum, i) => sum + i.price, 0);\n}',
    python: 'def total(items):\n    """Sum the prices."""\n    return sum(i.price for i in items)',
    php: '<?php\nfunction total(array $items): float {\n    return array_sum(array_column($items, "price"));\n}',
    sql: 'SELECT section, COUNT(*) AS stories\nFROM articles\nWHERE published_at > NOW() - INTERVAL 7 DAY\nGROUP BY section;',
    bash: '#!/usr/bin/env bash\nset -euo pipefail\nfor f in *.md; do echo "Rendering $f"; done',
    yaml: 'site:\n  name: Example Co\n  sections: [news, sport, culture]\n  publish: true',
};

/** The sample: enough for three or four pages, every kind of block the templates style. */
function sampleDocument() {
    const para = 'Editors plan the week in the newsroom, check each story against the style guide and send the final '
        + 'pages to print on time, with every image, table and quotation in its place.';
    const rows = Array.from({length: 14}, (_, i) => `| Section ${i + 1} | ${10 + i} stories | ${i % 2 ? 'Daily' : 'Weekly'} |`).join('\n');
    const code = Object.entries(CODE).map(([lang, src]) => `### ${lang}\n\n\`\`\`${lang}\n${src}\n\`\`\``).join('\n\n');
    return [
        '---', 'title: Print quality sample', 'author: PrintMD tests', 'subject: Every block a template styles', '---',
        '# Print quality sample', '', para, '',
        '## Symbols and links', '',
        'Checks ✔ ✓ ☑, stars ★, a gear ⚙, arrows → ⇒ ←, box drawing ┌──┐ and maths ≤ ≥ ± ×.', '',
        'Read [the house guide](https://example.org/guide) or <https://example.com/standards>.', '',
        'Press <kbd>Ctrl</kbd> + <kbd>S</kbd> to save; the output reads <samp>Saved</samp>.', '',
        '## Tables', '', '| Section | Volume | Schedule |', '|---|---|---|', rows, '',
        '## Images', '', para, '',
        `![A wide gradient](${pngDataUri(2400, 700)})`, '',
        '## Code', '', code, '',
        '## Lists', '', '- First point, short.', '- Second point, a little longer than the first one.',
        '  - A nested point under it.', '- Third point.', '', '1. Step one', '2. Step two', '3. Step three', '',
        '> A quotation that sits apart from the text around it, set as a block quote.', '',
        '## Close', '', para, '', para, '',
    ].join('\n');
}

/** Two page layouts per template, with and without a cover, taken in turn by the registry's templates. */
const LAYOUTS = [
    [{pageSize: 'A4', orientation: 'portrait', cover: true}, {pageSize: 'Letter', orientation: 'portrait', cover: false}],
    [{pageSize: 'A4', orientation: 'landscape', cover: true}, {pageSize: 'A4', orientation: 'portrait', cover: false}],
    [{pageSize: 'Letter', orientation: 'portrait', cover: true}, {pageSize: 'A4', orientation: 'landscape', cover: false}],
    [{pageSize: 'A4', orientation: 'portrait', cover: true}, {pageSize: 'Letter', orientation: 'landscape', cover: false}],
];
const PER_TEMPLATE = TEMPLATE_IDS.map((template, i) => LAYOUTS[i % LAYOUTS.length].map((l) => ({template, ...l})));
const ALL_SAMPLES = PER_TEMPLATE.flat();

/**
 * On CI (half a CPU, every render several seconds) one sample per template: the first half
 * of the templates with a cover, the rest without, so with four templates the samples still
 * span A4 and Letter, portrait and landscape, with and without a cover. All of them elsewhere.
 */
const CI_SAMPLES = PER_TEMPLATE.map((pair, i) => pair[Math.floor((i * 2) / PER_TEMPLATE.length)]);
const SAMPLES = process.env.CI ? CI_SAMPLES : ALL_SAMPLES;

let api;
let dir;

before(async () => {
    api = await startTestApi();
    dir = mkdtempSync(join(tmpdir(), 'bd-qa-'));
});

after(async () => {
    await api.close();
    rmSync(dir, {recursive: true, force: true});
});

const MD = sampleDocument();
/** The raster images the sample itself holds (the wide gradient PNG). */
const SAMPLE_IMAGES = (MD.match(/data:image\/png;base64,/g) || []).length;

for (const s of SAMPLES) {
    const name = `${s.template} ${s.pageSize} ${s.orientation} ${s.cover ? 'with' : 'without'} a cover`;
    test(`QA: ${name} passes every print-quality check`, async () => {
        const query = `template=${s.template}&pageSize=${s.pageSize}&orientation=${s.orientation}&cover=${s.cover}`;
        const r = await render(api.url, MD, query);
        assert.equal(r.status, 200);
        const file = join(dir, `${s.template}-${s.pageSize}-${s.orientation}-${s.cover ? 'cover' : 'nocover'}.pdf`);
        writeFileSync(file, r.body);
        // The sample holds one raster image; a template's styles must add none (README, Template contract).
        const result = await checkPdf(file, {cover: s.cover, pageSize: s.pageSize, orientation: s.orientation, maxImages: SAMPLE_IMAGES});
        assert.ok(result.ok, formatResult(result));
        assert.ok(result.checks.some((c) => c.id === 'raster-images'), 'the raster image count was checked');
        assert.ok(result.pages >= 3, `a real sample: ${result.pages} pages`);
    });
}

/** Mutants: small HTML pages printed straight from Chromium, each with one fault. */
let browser;
async function mutant(html, pdfOptions = {}) {
    browser ||= await chromium.launch({executablePath: findChrome(CHROME)});
    const page = await browser.newPage();
    try {
        await page.setContent(html);
        const file = join(dir, `mutant-${Math.random().toString(36).slice(2)}.pdf`);
        writeFileSync(file, await page.pdf({tagged: true, outline: true, preferCSSPageSize: true, ...pdfOptions}));
        return file;
    } finally {
        await page.close();
    }
}

after(async () => {
    if (browser) await browser.close();
});

const doc = ({title = 'Mutant', lang = ' lang="en"', css = '', body = '<h1>Heading</h1><p>Text.</p>'} = {}) =>
    `<!DOCTYPE html><html${lang}><head><meta charset="utf-8">${title === null ? '' : `<title>${title}</title>`}`
    + `<style>@page { size: A4; margin: 20mm; } ${css}</style></head><body>${body}</body></html>`;

const failing = (result) => result.checks.filter((c) => !c.ok).map((c) => c.id);

test('QA catches a system font', async () => {
    const result = await checkPdf(await mutant(doc({css: "body { font-family: 'DejaVu Sans', 'Liberation Sans', Arial, sans-serif; }"})));
    assert.ok(failing(result).includes('vendored-fonts'), formatResult(result));
    assert.equal(result.ok, false);
});

test('QA catches a Type 3 font that is not emoji (a synthesised bold)', async () => {
    // One weight of a vendored face, printed bold: Chromium draws the bold itself, as Type 3.
    const woff2 = readFileSync(join(REPO_ROOT, 'vendor/fonts/montserrat/montserrat-latin-400-normal.woff2')).toString('base64');
    const css = `@font-face { font-family: 'Montserrat'; font-weight: 400; src: url(data:font/woff2;base64,${woff2}) format('woff2'); }`
        + " body { font-family: 'Montserrat'; } strong { font-weight: 800; }";
    const result = await checkPdf(await mutant(doc({css, body: '<h1>Bold</h1><p><strong>Synthesised bold</strong> text.</p>'})));
    assert.ok(failing(result).includes('no-type3'), formatResult(result));
});

test('QA catches an image under 150 ppi', async () => {
    const result = await checkPdf(await mutant(doc({body: `<h1>Image</h1><img alt="" style="width: 6in" src="${pngDataUri(100, 60)}">`})));
    assert.ok(failing(result).includes('image-ppi'), formatResult(result));
});

test('QA catches styles that print as images (a blurred shadow, a filter); an unblurred shadow stays vector', async () => {
    const card = '<div class="card" style="margin:20mm;padding:10mm;background:rgba(0,0,0,0.05)">Card</div>';
    for (const css of ['.card { box-shadow: 0 8px 24px rgba(0,0,0,0.4); }', '.card { filter: blur(2px); }']) {
        const result = await checkPdf(await mutant(doc({css, body: `<h1>Card</h1>${card}`})), {maxImages: 0});
        assert.ok(failing(result).includes('raster-images'), `${css}\n${formatResult(result)}`);
    }
    const crisp = await checkPdf(await mutant(doc({css: '.card { box-shadow: 0 2px 0 rgba(0,0,0,0.4); }', body: `<h1>Card</h1>${card}`})),
        {maxImages: 0});
    assert.ok(crisp.checks.find((c) => c.id === 'raster-images').ok, formatResult(crisp));
    assert.ok(!(await checkPdf(await mutant(doc()))).checks.some((c) => c.id === 'raster-images'), 'only checked when asked');
});

test('QA catches an untagged PDF', async () => {
    const result = await checkPdf(await mutant(doc(), {tagged: false}));
    assert.ok(failing(result).includes('tagged'), formatResult(result));
});

test('QA catches a missing title (Chromium then writes the address, about:blank)', async () => {
    const result = await checkPdf(await mutant(doc({title: null})));
    assert.ok(failing(result).includes('title'), formatResult(result));
});

test('QA catches a missing language', async () => {
    // Chromium writes /Lang (the page's, else the browser locale) only into a tagged PDF.
    const result = await checkPdf(await mutant(doc({lang: ''}), {tagged: false}));
    assert.ok(failing(result).includes('language'), formatResult(result));
});

test('QA catches missing bookmarks', async () => {
    const result = await checkPdf(await mutant(doc(), {outline: false}));
    assert.ok(failing(result).includes('outline'), formatResult(result));
});

test('QA catches text in the margin band and a wrong page size', async () => {
    const file = await mutant(doc({css: '@page { size: A4; margin: 2mm; }'}));
    const result = await checkPdf(file, {pageSize: 'Letter'});
    assert.ok(failing(result).includes('margin'), formatResult(result));
    assert.ok(failing(result).includes('page-size'), formatResult(result));
});

test('QA catches text in the margin band at each edge on its own', async () => {
    // Wide margins everywhere except the edge under test, and one word pushed against that edge.
    const cases = {
        // 20 mm top margin, a 5 mm heading, then 262 mm: the word ends about 2 to 3 mm above the bottom edge.
        bottom: {margin: '20mm 20mm 2mm 20mm', body: '<div style="height: 262mm"></div><p style="margin:0;font-size:12px;line-height:1">Bottomword</p>'},
        top: {margin: '2mm 20mm 20mm 20mm', body: '<p style="margin:0">Topword</p>'},
        left: {margin: '20mm 20mm 20mm 2mm', body: '<p style="margin:0">Leftword</p>'},
        right: {margin: '20mm 2mm 20mm 20mm', body: '<p style="margin:0;text-align:right">Rightword</p>'},
    };
    for (const [edge, c] of Object.entries(cases)) {
        const css = `@page { size: A4; margin: ${c.margin}; } body { margin: 0; }`;
        const h1 = edge === 'bottom' ? 'margin:0 40mm;font-size:19px;line-height:1' : 'margin:40mm';
        const heading = `<h1 style="${h1}">Heading</h1>`;
        const result = await checkPdf(await mutant(doc({css, body: edge === 'top' ? c.body + heading : heading + c.body})));
        assert.equal(result.pages, 1, `${edge}: one page`);
        const margin = result.checks.find((x) => x.id === 'margin');
        assert.equal(margin.ok, false, `${edge}: ${margin.detail}`);
        assert.match(margin.detail, new RegExp(`${edge[0].toUpperCase()}${edge.slice(1)}word`), edge);
        assert.ok(!/Heading/.test(margin.detail), `${edge}: only the word at the edge`);
    }
});

test('QA catches forbidden strings in the text and in link addresses', async () => {
    const text = await checkPdf(await mutant(doc({body: '<h1>Dev</h1><p>Served from localhost during testing.</p>'})));
    assert.ok(failing(text).includes('forbidden'), formatResult(text));
    const link = await checkPdf(await mutant(doc({body: '<h1>Dev</h1><p><a href="https://site.ddev.site/page">the page</a></p>'})));
    assert.ok(failing(link).includes('forbidden'), formatResult(link));
    const custom = await checkPdf(await mutant(doc({body: '<h1>Draft</h1><p>DRAFT copy.</p>'})), {forbidden: ['draft copy']});
    assert.ok(failing(custom).includes('forbidden'), formatResult(custom));
});

test('QA warns about a nearly empty last page, and strict fails on it', async () => {
    const body = `<h1>Long</h1>${'<p>Line of text that fills the page.</p>'.repeat(60)}<p>Last words.</p>`;
    const file = await mutant(doc({body: body.replace('<p>Last words.</p>', '<p style="break-before: page">Last words.</p>')}));
    const relaxed = await checkPdf(file);
    const last = relaxed.checks.find((c) => c.id === 'last-page');
    assert.equal(last.ok, false);
    assert.equal(last.level, 'warning');
    const strict = await checkPdf(file, {strict: true});
    assert.equal(strict.ok, false, formatResult(strict));
});

test('QA runs from the command line with an exit code', async () => {
    const {execFile} = await import('node:child_process');
    const run = (args) => new Promise((resolve) => {
        execFile(process.execPath, [new URL('../qa/pdf-qa.mjs', import.meta.url).pathname, ...args], (err, stdout) => {
            resolve({code: err ? err.code : 0, stdout});
        });
    });
    const bad = await mutant(doc({title: null}));
    const r = await run([bad]);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /FAIL\s+title/);
    const usage = await run([]);
    assert.equal(usage.code, 2);
    // An option that needs a value never takes the next flag, or nothing, as one.
    for (const args of [[bad, '--forbid'], ['--forbid', '--strict', bad], [bad, '--size'], ['--size', '--cover', bad], [bad, '--forbid', ''],
        [bad, '--images'], [bad, '--images', 'two'], [bad, '--images', '-1']]) {
        const r2 = await run(args);
        assert.equal(r2.code, 2, `${JSON.stringify(args)}: exit ${r2.code}`);
    }
    const strictAfterForbid = await run(['--forbid', 'nothing-like-this', '--strict', await mutant(doc({body: `<h1>Long</h1>${'<p>Line of text.</p>'.repeat(60)}<p style="break-before: page">Last.</p>`}))]);
    assert.equal(strictAfterForbid.code, 1, '--strict after --forbid word still applies');
});
