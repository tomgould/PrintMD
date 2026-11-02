/**
 * Page control through the PDF API (README, Export: Page options), the part CI runs
 * (tests/lib/server-tests.mjs): the options refused with 400 invalid_option, a custom
 * page size, the one continuous page (and the split past the longest PDF page), fit
 * width and its lower bound, and the margin override with the running head and foot.
 * Each PDF is read with pdfinfo, pdftotext and pdffonts and passed through
 * server/qa/pdf-qa.mjs where its checks apply. More (JSON, front matter, widest, a
 * pixel size) is in page-options-api.test.mjs.
 */
import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {checkPdf, formatResult, parseBbox} from '../qa/pdf-qa.mjs';
import {normalizeRunning} from '../../js/page-chrome.js';
import {templatePageDefaults} from '../../js/export-options.js';
import {templateEntry} from '../src/templates-info.mjs';
import {startTestApi, render, warningsOf, pdfInfo, pdfText, pdfFontTable, DEFAULT_QUERY, SHOWCASE, TEMPLATE_IDS} from './helpers.mjs';

const PT_PER_MM = 72 / 25.4;
const near = (a, b, tol = 1) => Math.abs(a - b) <= tol;
const advisoriesOf = (r) => JSON.parse(decodeURIComponent(r.headers.get('x-printmd-advisories') || '%5B%5D'));

let api;
let dir;

before(async () => {
    api = await startTestApi();
    dir = mkdtempSync(join(tmpdir(), 'bd-pagecontrol-'));
});

after(async () => {
    await api.close();
    rmSync(dir, {recursive: true, force: true});
});

/** pdf-qa on a rendered PDF. */
async function qa(buffer, opts) {
    const file = join(dir, `qa-${Math.random().toString(36).slice(2)}.pdf`);
    writeFileSync(file, buffer);
    return checkPdf(file, opts);
}

/** pdftotext -bbox pages. */
const bbox = (buffer) => parseBbox(pdfText(buffer, ['-bbox']));

const paragraphs = (n) => Array.from({length: n}, (_, i) => `Paragraph ${i + 1}: editors plan the week, check each story against the `
    + 'style guide and send the final pages to print on time.').join('\n\n');
/** A Markdown table of n columns, each cell one long word. */
const wideTable = (n) => [`| ${Array.from({length: n}, (_, i) => `Heading${i}`).join(' | ')} |`,
    `|${'---|'.repeat(n)}`, `| ${Array.from({length: n}, (_, i) => `Unbreakable${i}word`).join(' | ')} |`].join('\n');

test('page options: every value outside the allow-lists is 400 invalid_option, naming what is allowed', async () => {
    const md = '# Hi\n\nText.';
    const bad = {
        pageSize: ['100x150mm;', '100x150mm}body{', 'url(x)', 'calc(100mm)x150mm', 'var(--w)x150mm', 'expression(1)', '1e3x150mm',
            '10x150mm', '6000x200mm', '5000x5000mm', '100x150', '100x150furlongs', 'Tabloid'],
        layout: ['Continuous;', 'pages', 'url(x)', ''],
        fit: ['height', 'auto', 'width;', ''],
        margin: ['101mm', '-1mm', '10%', 'calc(1mm)', '20mm;}', 'var(--m)', '20px', ''],
    };
    for (const [key, values] of Object.entries(bad)) {
        for (const value of values) {
            const r = await render(api.url, md, `${DEFAULT_QUERY}&${key}=${encodeURIComponent(value)}`);
            assert.equal(r.status, 400, `${key}=${value}: ${r.status}`);
            assert.equal(r.json.error.code, 'invalid_option');
            assert.ok(r.json.error.message.startsWith(key), r.json.error.message);
            if (/[;{}()]/.test(value)) assert.ok(!r.json.error.message.includes(value), `the value is not quoted back: ${r.json.error.message}`);
        }
    }
    const widest = await render(api.url, md, `${DEFAULT_QUERY}&fit=widest`);
    assert.equal(widest.status, 400);
    assert.match(widest.json.error.message, /widest needs layout=continuous/);
    const tooBig = await render(api.url, md, `${DEFAULT_QUERY}&pageSize=50x60mm&margin=20mm`);
    assert.equal(tooBig.status, 400);
    assert.match(tooBig.json.error.message, /^margin leaves less than 20 mm/);
    assert.match(tooBig.json.error.message, /about 100 mm|use a smaller margin/);
    const marginRule = await render(api.url, md, `${DEFAULT_QUERY}&margin=101mm`);
    assert.match(marginRule.json.error.message, /about 100 mm/, 'not "at most": 4in and 288pt are 101.6 mm');
    // The template's own starting page counts: a margin too large for its Slide is refused, not reduced.
    const slide = TEMPLATE_IDS.find((t) => templatePageDefaults(templateEntry(t).manifest).pageSize === 'Slide');
    if (slide) {
        const r = await render(api.url, md, `template=${slide}&margin=62mm`);
        assert.equal(r.status, 400, `the starting page: ${r.status}`);
        assert.match(r.json.error.message, /^margin leaves less than 20 mm/);
    }
});

test('page options: GET /api/v1/templates documents the limits', async () => {
    const list = await (await fetch(`${api.url}/api/v1/templates`)).json();
    const p = list.pageOptions;
    assert.ok(p, 'pageOptions');
    assert.deepEqual(p.layouts, ['paged', 'continuous']);
    assert.deepEqual(p.fits, ['off', 'width', 'widest']);
    assert.deepEqual(p.customSize.units, ['mm', 'cm', 'in', 'px']);
    assert.equal(p.customSize.minSideMm, 30);
    assert.equal(p.customSize.maxSideMm, 5080);
    assert.equal(p.customSize.maxAreaMm2, 4000000);
    assert.deepEqual(p.margin.units, ['mm', 'cm', 'in', 'pt']);
    assert.equal(p.margin.runningHeadMinMm, 18);
    assert.equal(p.fitMinScale, 0.4);
    assert.equal(p.continuous.maxPageMm, 5080);
});

test('custom size: 100 x 150 mm with any template, every page that size, and the print-quality checks pass', async () => {
    const r = await render(api.url, `# Postcard\n\n${paragraphs(6)}`, `${DEFAULT_QUERY}&pageSize=100x150mm&orientation=landscape`);
    assert.equal(r.status, 200, r.body.toString());
    const info = pdfInfo(r.body);
    assert.ok(near(info.width, 100 * PT_PER_MM) && near(info.height, 150 * PT_PER_MM), `${info.width} x ${info.height} pt`);
    assert.ok(info.pages >= 2, 'cover and body');
    const result = await qa(r.body, {cover: true, pageSize: '100x150mm'});
    assert.ok(result.ok, formatResult(result));
    // Slide is still only for the templates that list it: a custom size is not a way round that.
    const slideless = TEMPLATE_IDS.find((id) => !templateEntry(id).manifest.page?.sizes?.includes('Slide'));
    const slide = await render(api.url, '# x', `template=${slideless}&pageSize=Slide`);
    assert.equal(slide.status, 400);
});

test('continuous: the showcase on one page of the chosen width, as tall as its content, links and bookmarks kept', async () => {
    const r = await render(api.url, SHOWCASE, `${DEFAULT_QUERY}&layout=continuous`);
    assert.equal(r.status, 200, r.body.toString());
    const info = pdfInfo(r.body);
    assert.equal(info.pages, 1, 'one page');
    assert.ok(near(info.width, 210 * PT_PER_MM), `A4 wide: ${info.width}`);
    const paged = await render(api.url, SHOWCASE, DEFAULT_QUERY);
    const pagedInfo = pdfInfo(paged.body);
    // The same content on one page: about as tall as the paged body's text columns put together.
    assert.ok(info.height > 297 * PT_PER_MM * 3, `taller than three pages: ${info.height}`);
    assert.ok(info.height < 297 * PT_PER_MM * pagedInfo.pages, `shorter than all the pages: ${info.height} for ${pagedInfo.pages}`);
    const text = pdfText(r.body).replace(/\s+/g, ' ');
    const pagedText = pdfText(paged.body).replace(/\s+/g, ' ');
    // Every second-level heading prints, as on pages.
    for (const [, heading] of SHOWCASE.matchAll(/^## (.+)$/gm)) {
        const probe = heading.replace(/[*_`&]/g, '').split(' ')[0];
        assert.equal(text.includes(probe), pagedText.includes(probe), probe);
        assert.ok(text.includes(probe), probe);
    }
    assert.equal(r.headers.get('x-printmd-tidy'), 'off', 'no last page to tidy');
    assert.match(r.body.toString('latin1'), /\/Outlines\s+\d+\s+\d+\s+R/, 'bookmarks');
    assert.match(r.body.toString('latin1'), /\/URI\s*\(https?:/, 'links');
    assert.ok(pdfFontTable(r.body).every((f) => f.embedded), 'fonts embedded');
    // The showcase names localhost in its text, so that one forbidden word is left out.
    const result = await qa(r.body, {cover: true, continuous: true, pageSize: 'A4', forbidden: ['127.0.0.1', 'ddev.site', 'file://']});
    assert.ok(result.ok, formatResult(result));
    // No running head or foot on the continuous page: no page number text.
    assert.ok(!/\b1 of 1\b/.test(text), 'no page numbers');
});

test('continuous: past the longest PDF page the document is split into the fewest tall pages, with a note', async () => {
    const md = `# Long\n\n${paragraphs(400)}`;
    const r = await render(api.url, md, `${DEFAULT_QUERY}&layout=continuous&cover=false`);
    assert.equal(r.status, 200, r.body.toString());
    const info = pdfInfo(r.body);
    const notes = advisoriesOf(r);
    const note = notes.map((n) => /^The document is ([\d.]+) mm long, more than one PDF page can be \(5080 mm\), so it is split into (\d+) pages of ([\d.]+) mm\.$/.exec(n))
        .find(Boolean);
    assert.ok(note, JSON.stringify(notes));
    const [, longMm, pages, pageMm] = note.map(Number);
    assert.ok(longMm > 5080, `longer than one page: ${longMm}`);
    assert.equal(pages, Math.ceil(longMm / (5080 * 0.95)), 'the fewest pages that hold it, with room for the breaks');
    assert.equal(info.pages, pages, `the PDF has them: ${info.pages}`);
    assert.ok(near(info.height, pageMm * PT_PER_MM) && pageMm <= 5080, `each within the limit: ${info.height} pt`);
    assert.ok(near(info.width, 210 * PT_PER_MM));
    assert.ok(warningsOf(r).some((w) => /split into/.test(w)), 'in X-PrintMD-Warnings too');
    assert.ok(pdfText(r.body).includes('Paragraph 400:'), 'nothing lost');
    const strict = await render(api.url, md, `${DEFAULT_QUERY}&layout=continuous&cover=false&strict=true`);
    assert.equal(strict.status, 200, 'a note, not a defect: strict lets it through');
});

test('fit width: a table wider than the column is scaled into it; under 40% it is left and strict refuses', async () => {
    const md = `# Wide\n\nBefore the table.\n\n${wideTable(8)}\n\nAfter the table.`;
    const MARGIN_PT = 20 * PT_PER_MM;
    const beyond = (buffer) => bbox(buffer).slice(1).flatMap((p) => p.words.filter((w) => w.xMax > p.width - MARGIN_PT + 2));
    const plain = await render(api.url, md, `${DEFAULT_QUERY}&margin=20mm`);
    assert.ok(beyond(plain.body).length > 0, 'without fit the table runs past the margin');
    const r = await render(api.url, md, `${DEFAULT_QUERY}&margin=20mm&fit=width`);
    assert.equal(r.status, 200, r.body.toString());
    assert.deepEqual(beyond(r.body).map((w) => w.text), [], 'with fit it stays inside');
    const notes = advisoriesOf(r);
    assert.ok(notes.some((n) => /^Table 1 is scaled to \d+% to fit the page width\.$/.test(n)), JSON.stringify(notes));
    assert.ok(pdfText(r.body).includes('Unbreakable7word'), 'every cell printed');
    const result = await qa(r.body, {cover: true});
    assert.ok(result.ok, formatResult(result));
    const tooWide = await render(api.url, `# Wide\n\n${wideTable(40)}`, `${DEFAULT_QUERY}&fit=width&strict=true`);
    assert.equal(tooWide.status, 422);
    assert.ok(tooWide.json.error.warnings.some((w) => /^Table 1 needs \d+% to fit the page width; under the 40% limit/.test(w)),
        JSON.stringify(tooWide.json.error.warnings));
});

test('margin: 0 puts the text at the paper edge, 30 mm moves it in; under 18 mm the running head and foot go, with a note', async () => {
    const md = `# Margins\n\n${paragraphs(4)}`;
    const leftmost = (buffer) => Math.min(...bbox(buffer)[1].words.map((w) => w.xMin));
    const zero = await render(api.url, md, `${DEFAULT_QUERY}&margin=0`);
    assert.equal(zero.status, 200, zero.body.toString());
    assert.ok(leftmost(zero.body) < 3 * PT_PER_MM, `at the edge: ${leftmost(zero.body)} pt`);
    const thirty = await render(api.url, md, `${DEFAULT_QUERY}&margin=30mm`);
    assert.ok(near(leftmost(thirty.body), 30 * PT_PER_MM, 3 * PT_PER_MM), `30 mm in: ${leftmost(thirty.body)} pt`);
    const result = await qa(thirty.body, {cover: true});
    assert.ok(result.ok, formatResult(result));
    // A template with a running head and foot, from the registry (none in an edition without one).
    const id = TEMPLATE_IDS.find((t) => normalizeRunning(templateEntry(t).template)
        && !(templateEntry(t).manifest.page?.sizes || []).every((s) => s === 'Slide'));
    if (!id) return;
    const doc = `---\ntitle: Running head check\n---\n# Running head check\n\n${paragraphs(40)}`;
    const withHead = await render(api.url, doc, `template=${id}&pageSize=A4`);
    const without = await render(api.url, doc, `template=${id}&pageSize=A4&margin=12mm`);
    assert.equal(without.status, 200);
    const notes = advisoriesOf(without);
    assert.ok(notes.includes('The running head and foot are left out: the margin (12mm) is under the 18 mm they need.'), JSON.stringify(notes));
    assert.ok(!advisoriesOf(withHead).some((n) => /running head/.test(n)), 'the template margin: no note');
    // Margin text comes to 11 mm from the paper edge (js/page-chrome.js); with a 12 mm margin and no head or
    // foot, nothing on a body page is nearer the top or bottom edge than the text column's 12 mm. From page 3:
    // page 2 opens with the title heading, whose large type reaches above its line.
    const edge = 11.5 * PT_PER_MM;
    const band = (buffer, from) => bbox(buffer).slice(2).flatMap((p) => p.words.filter((w) => w.yMin < from || w.yMax > p.height - from));
    // With the template's own margin the head and foot sit inside it, and the text column starts at the margin: look
    // for words in the margin itself (a template's margin may be wider than 12 mm).
    const margin = String(templateEntry(id).manifest.page.margin);
    const marginMm = parseFloat(margin) * (/cm$/.test(margin) ? 10 : /in$/.test(margin) ? 25.4 : /pt$/.test(margin) ? 25.4 / 72 : 1);
    assert.ok(band(withHead.body, Math.max(edge, (marginMm - 1) * PT_PER_MM)).length > 0, 'the running head prints with the template margin');
    assert.deepEqual(band(without.body, edge).map((w) => w.text), [], 'and not with the 12 mm margin');
});

test('continuous: blocks far wider than the page (Chromium shrinks the print by up to half) leave no blank strip', async () => {
    const cases = {
        'a 40-column table on A4': [`# Wide\n\n${paragraphs(40)}\n\n${wideTable(40)}\n\nThe end.`, ''],
        'the same with fit width (under the 40% floor)': [`# Wide\n\n${paragraphs(40)}\n\n${wideTable(40)}\n\nThe end.`, '&fit=width'],
        'a block 3000 px wide': [`# Wide\n\n<div style="width: 3000px">A block of HTML wider than any page.</div>\n\n${paragraphs(8)}`, ''],
        'the showcase at 100 x 150 mm': [SHOWCASE, '&pageSize=100x150mm'],
    };
    for (const [label, [md, extra]] of Object.entries(cases)) {
        const r = await render(api.url, md, `${DEFAULT_QUERY}&layout=continuous&cover=false${extra}`);
        assert.equal(r.status, 200, `${label}: ${r.body.toString().slice(0, 200)}`);
        const result = await qa(r.body, {continuous: true, forbidden: ['ddev.site', 'file://']});
        const bottom = result.checks.find((c) => c.id === 'bottom-space');
        assert.ok(bottom && bottom.ok, `${label}: ${bottom ? bottom.detail : 'no bottom-space check'}`);
    }
});

test('pdf-qa --continuous: a blank strip under the content fails bottom-space', async () => {
    const r = await render(api.url, `# Blank\n\n${paragraphs(4)}\n\n<div style="height: 400mm"></div>`, `${DEFAULT_QUERY}&layout=continuous&cover=false`);
    assert.equal(r.status, 200);
    const result = await qa(r.body, {continuous: true});
    const bottom = result.checks.find((c) => c.id === 'bottom-space');
    assert.equal(bottom.ok, false, bottom.detail);
    assert.match(bottom.detail, /^\d+ mm blank below the content/);
    assert.equal(result.ok, false);
    const paged = await qa(r.body, {});
    assert.ok(!paged.checks.some((c) => c.id === 'bottom-space'), 'only with --continuous');
});

test('pdf-qa: --size takes a custom size and --continuous any page height of that width', async () => {
    const r = await render(api.url, `# Tall\n\n${paragraphs(30)}`, `${DEFAULT_QUERY}&layout=continuous&pageSize=150x100mm&cover=false`);
    const ok = await qa(r.body, {continuous: true, pageSize: '150x100mm'});
    assert.ok(ok.ok, formatResult(ok));
    assert.match(ok.checks.find((c) => c.id === 'page-size').detail, /150 mm wide/);
    const wrongWidth = await qa(r.body, {continuous: true, pageSize: '160x100mm'});
    assert.equal(wrongWidth.checks.find((c) => c.id === 'page-size').ok, false);
    const paged = await qa(r.body, {pageSize: '150x100mm'});
    assert.equal(paged.checks.find((c) => c.id === 'page-size').ok, false, 'paged: the height must match too');
    const {execFile} = await import('node:child_process');
    const run = (args) => new Promise((resolve) => {
        execFile(process.execPath, [new URL('../qa/pdf-qa.mjs', import.meta.url).pathname, ...args], (err, stdout) => resolve({code: err ? err.code : 0, stdout}));
    });
    const file = join(dir, 'tall.pdf');
    writeFileSync(file, r.body);
    assert.equal((await run([file, '--continuous', '--size', '150x100mm'])).code, 0);
    for (const bad of ['150x100mm;', 'url(x)', '1e3x100mm', '10x10mm']) {
        assert.equal((await run([file, '--size', bad])).code, 2, `--size ${bad}`);
    }
});
