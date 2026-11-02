/**
 * Page control through the PDF API, beyond the CI gate (page-control.test.mjs): the
 * options in a JSON body, as front matter (and the request winning over it), a custom
 * size in pixels, fit widest on the continuous page, and the guard on the continuous
 * page's total length (413 too_large_to_render).
 */
import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import {startTestApi, render, toResult, warningsOf, pdfInfo, pdfText, DEFAULT_QUERY, DEFAULT_TEMPLATE, SHOWCASE} from './helpers.mjs';
import {parseBbox} from '../qa/pdf-qa.mjs';
import {pngDataUri} from './png.mjs';

const PT_PER_MM = 72 / 25.4;
const near = (a, b, tol = 1) => Math.abs(a - b) <= tol;
const advisoriesOf = (r) => JSON.parse(decodeURIComponent(r.headers.get('x-printmd-advisories') || '%5B%5D'));
const paragraphs = (n) => Array.from({length: n}, (_, i) => `Paragraph ${i + 1}: a line of ordinary text for the page.`).join('\n\n');
const wideTable = (n) => [`| ${Array.from({length: n}, (_, i) => `Heading${i}`).join(' | ')} |`,
    `|${'---|'.repeat(n)}`, `| ${Array.from({length: n}, (_, i) => `Unbreakable${i}word`).join(' | ')} |`].join('\n');

let api;
before(async () => { api = await startTestApi(); });
after(async () => { await api.close(); });

const postJson = async (body) => toResult(await fetch(`${api.url}/api/v1/render`, {
    method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body),
}));

test('JSON: the same options and the same refusals as the query', async () => {
    const r = await postJson({markdown: `# JSON\n\n${paragraphs(3)}`, template: DEFAULT_TEMPLATE, pageSize: '8.5 x 5.5 in', layout: 'paged',
        fit: 'width', margin: '0.5in', cover: false});
    assert.equal(r.status, 200, r.body.toString());
    const info = pdfInfo(r.body);
    assert.ok(near(info.width, 8.5 * 72) && near(info.height, 5.5 * 72), `${info.width} x ${info.height}`);
    for (const [key, value] of [['pageSize', '100x150mm;'], ['layout', 'scroll'], ['fit', 7], ['margin', '1in}'], ['pageSize', {w: 1}]]) {
        const bad = await postJson({markdown: '# x', [key]: value});
        assert.equal(bad.status, 400, `${key}: ${bad.status}`);
        assert.equal(bad.json.error.code, 'invalid_option');
    }
});

test('quiet changes are said: front matter fit widest on pages, and an orientation with a custom size', async () => {
    const widest = await render(api.url, '---\nfit: widest\n---\n# Pages\n\ntext', `${DEFAULT_QUERY}&cover=false`);
    assert.equal(widest.status, 200);
    assert.ok(warningsOf(widest).some((w) => /front matter's fit: widest needs layout: continuous, so fit width was used/.test(w)),
        JSON.stringify(warningsOf(widest)));
    const fine = await render(api.url, '---\nfit: widest\nlayout: continuous\n---\n# One page\n\ntext', `${DEFAULT_QUERY}&cover=false`);
    assert.ok(!warningsOf(fine).some((w) => /widest/.test(w)), 'no warning with the continuous layout');
    const turned = await render(api.url, '# Custom\n\ntext', `${DEFAULT_QUERY}&cover=false&pageSize=100x150mm&orientation=landscape`);
    assert.equal(turned.status, 200);
    assert.ok(advisoriesOf(turned).some((n) => /orientation is ignored with a custom page size/.test(n)), JSON.stringify(advisoriesOf(turned)));
    const info = pdfInfo(turned.body);
    assert.ok(near(info.width, 100 * PT_PER_MM) && near(info.height, 150 * PT_PER_MM), 'printed as given');
});

test('a custom size in pixels: 1200 x 800 px is 317.5 x 211.7 mm', async () => {
    const r = await render(api.url, `# Pixels\n\n${paragraphs(3)}`, `${DEFAULT_QUERY}&pageSize=1200x800px&cover=false`);
    assert.equal(r.status, 200, r.body.toString());
    const info = pdfInfo(r.body);
    assert.ok(near(info.width, 900) && near(info.height, 600), `${info.width} x ${info.height} pt`);
});

test('front matter: page-size, layout, fit and margin apply; the request wins; a bad value is a warning', async () => {
    const fm = `---\ntitle: Front matter\npage-size: 150x100mm\nlayout: continuous\nmargin: 10mm\n---\n# Front matter\n\n${paragraphs(20)}`;
    const r = await render(api.url, fm, `${DEFAULT_QUERY}&cover=false`);
    assert.equal(r.status, 200, r.body.toString());
    let info = pdfInfo(r.body);
    assert.equal(info.pages, 1, 'continuous from the front matter');
    assert.ok(near(info.width, 150 * PT_PER_MM), `150 mm wide: ${info.width}`);
    const over = await render(api.url, fm, `${DEFAULT_QUERY}&cover=false&layout=paged&pageSize=A5`);
    info = pdfInfo(over.body);
    assert.ok(info.pages > 1 && near(info.width, 148 * PT_PER_MM), 'the request wins: A5 pages');
    const bad = await render(api.url, '---\nlayout: sideways\nmargin: 20mm;}\n---\n# Bad', `${DEFAULT_QUERY}&cover=false`);
    assert.equal(bad.status, 200);
    const w = warningsOf(bad);
    assert.ok(w.some((x) => /front matter's layout is not paged or continuous/.test(x)), JSON.stringify(w));
    assert.ok(w.some((x) => /front matter's margin is not a length/.test(x)), JSON.stringify(w));
    // A margin too large for the front matter's page is reduced, with a note, not refused.
    const big = await render(api.url, '---\npage-size: 40x60mm\nmargin: 20mm\n---\n# Small', `${DEFAULT_QUERY}&cover=false`);
    assert.equal(big.status, 200, big.body.toString());
    assert.ok(advisoriesOf(big).some((n) => /^The margin is reduced to 10mm/.test(n)), JSON.stringify(advisoriesOf(big)));
});

test('fit widest: the continuous page widens to the widest block, nothing scaled', async () => {
    const r = await render(api.url, `# Widest\n\nIntro.\n\n${wideTable(8)}`, `${DEFAULT_QUERY}&layout=continuous&fit=widest&cover=false`);
    assert.equal(r.status, 200, r.body.toString());
    const info = pdfInfo(r.body);
    const note = advisoriesOf(r).map((n) => /^The page is ([\d.]+) mm wide to fit Table 1\.$/.exec(n)).find(Boolean);
    assert.ok(note, JSON.stringify(advisoriesOf(r)));
    assert.ok(Number(note[1]) > 210 && near(info.width, Number(note[1]) * PT_PER_MM, 2), `${info.width} pt for ${note[1]} mm`);
    assert.ok(!advisoriesOf(r).some((n) => /scaled/.test(n)), 'nothing scaled');
    assert.ok(pdfText(r.body).includes('Unbreakable7word'));
});

test('continuous with fit off: a block wider than the page (Chromium shrinks the print) leaves no blank strip', async () => {
    // Nine columns of hyphenated words: wider than the A4 column, within the third Chromium shrinks by.
    const cells = (r) => `| ${Array.from({length: 9}, (_, i) => `Value${r}x${i}-stories`).join(' | ')} |`;
    const table = [`| ${Array.from({length: 9}, (_, i) => `Region ${i + 1}`).join(' | ')} |`, `|${'---|'.repeat(9)}`,
        ...Array.from({length: 8}, (_, r) => cells(r))].join('\n');
    const r = await render(api.url, `# Wide\n\nIntro.\n\n${table}\n\nThe last line.`, `${DEFAULT_QUERY}&layout=continuous&cover=false&margin=20mm`);
    assert.equal(r.status, 200, r.body.toString());
    const info = pdfInfo(r.body);
    assert.equal(info.pages, 1);
    const words = parseBbox(pdfText(r.body, ['-bbox']))[0].words;
    const bottom = Math.max(...words.map((w) => w.yMax));
    assert.ok(Math.max(...words.map((w) => w.xMax)) > 190 * PT_PER_MM, 'the table reaches past the column, so the print shrinks');
    // Below the last line: the margin and the paragraph's spacing (about 26 mm unshrunk), not a blank strip.
    assert.ok(info.height - bottom < 27 * PT_PER_MM, `blank below the text: ${((info.height - bottom) / PT_PER_MM).toFixed(1)} mm`);
});

test('continuous split: no piece ends with a heading, and the note gives the real page count', async () => {
    const md = ['# Split', ...Array.from({length: 150}, (_, i) => `## Section ${i + 1}\n\n${paragraphs(3)}`)].join('\n\n');
    const r = await render(api.url, md, `${DEFAULT_QUERY}&layout=continuous&cover=false`);
    assert.equal(r.status, 200, r.body.toString());
    const info = pdfInfo(r.body);
    assert.ok(info.pages >= 2, `split: ${info.pages}`);
    const note = advisoriesOf(r).map((n) => /split into (\d+) pages/.exec(n)).find(Boolean);
    assert.ok(note && Number(note[1]) === info.pages, `the note says ${note && note[1]}, the PDF has ${info.pages}`);
    for (let p = 1; p < info.pages; p++) {
        const lines = pdfText(r.body, ['-f', String(p), '-l', String(p)]).split('\n').map((l) => l.trim()).filter(Boolean);
        assert.ok(!/^Section \d+$/.test(lines.at(-1)), `piece ${p} ends with a heading: ${lines.at(-1)}`);
    }
});

test('continuous split on a very wide page: the note always names the pages the PDF has', async () => {
    // An image as wide as a 5080 mm column is taller than any page: it cannot fit one piece.
    const image = `![A test card](${pngDataUri(400, 300)})`;
    for (const md of [SHOWCASE, `# Tables\n\n${Array.from({length: 40}, () => wideTable(3)).join('\n\n')}`,
        `# Picture\n\n${paragraphs(200)}\n\n${image}\n\n${paragraphs(200)}`]) {
        const r = await render(api.url, md, `${DEFAULT_QUERY}&layout=continuous&cover=false&pageSize=5080x100mm&margin=0`);
        assert.equal(r.status, 200, r.body.toString().slice(0, 200));
        const info = pdfInfo(r.body);
        const note = advisoriesOf(r).map((n) => /(?:split into|printed on) (\d+) pages/.exec(n)).find(Boolean);
        if (info.pages > 1) assert.ok(note && Number(note[1]) === info.pages, `note ${note && note[1]}, PDF ${info.pages}: ${advisoriesOf(r)}`);
    }
});

test('tiny pages: a document that would print more than 5,000 is refused before printing (413 too_many_pages)', async () => {
    const big = `# Big\n\n${paragraphs(2400)}`;
    const t0 = Date.now();
    const r = await render(api.url, big, `${DEFAULT_QUERY}&cover=false&pageSize=30x30mm&margin=5mm`);
    assert.equal(r.status, 413, r.body.toString().slice(0, 200));
    assert.equal(r.json.error.code, 'too_many_pages');
    assert.match(r.json.error.message, /about [\d,]+ pages at this page size, more than the 5,000 a render prints/);
    assert.ok(Date.now() - t0 < 10_000, 'refused before printing');
    // Ordinary tiny pages still print.
    const small = await render(api.url, `# Label\n\n${paragraphs(3)}`, `${DEFAULT_QUERY}&cover=false&pageSize=30x30mm&margin=5mm`);
    assert.equal(small.status, 200);
    assert.ok(pdfInfo(small.body).pages > 1);
});

test('the continuous page has a total limit: past it, 413 too_large_to_render', async () => {
    const r = await render(api.url, '# Tall\n\n<div style="height: 60000mm">Tall block</div>\n', `${DEFAULT_QUERY}&layout=continuous&cover=false`);
    assert.equal(r.status, 413, r.body.toString().slice(0, 300));
    assert.equal(r.json.error.code, 'too_large_to_render');
    assert.match(r.json.error.message, /layout=paged/);
});
