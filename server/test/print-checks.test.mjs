/**
 * The print-quality rules of the API's render (README, Print quality): fonts
 * confirmed before printing, image resolution, PDF metadata and structure,
 * the nearly-empty-last-page tidy and printed link addresses.
 */
import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {cpSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {REPO_ROOT} from '../src/paths.mjs';
import {startTestApi, render, warningsOf, DEFAULT_QUERY, DEFAULT_TEMPLATE} from './helpers.mjs';
import {pngDataUri} from './png.mjs';

/** fn(path) with the PDF written to a temporary file. */
function withPdf(buffer, fn) {
    const dir = mkdtempSync(join(tmpdir(), 'bd-pq-'));
    try {
        const file = join(dir, 'out.pdf');
        writeFileSync(file, buffer);
        return fn(file);
    } finally {
        rmSync(dir, {recursive: true, force: true});
    }
}

let api;

before(async () => {
    api = await startTestApi();
});

after(async () => {
    await api.close();
});

test('fonts: a vendored face that does not load is a warning, and strict refuses', async () => {
    // A copy of the served folders with the body font's regular face missing.
    const root = mkdtempSync(join(tmpdir(), 'bd-fonts-'));
    let broken;
    try {
        for (const dir of ['js', 'templates', 'vendor', 'assets']) cpSync(join(REPO_ROOT, dir), join(root, dir), {recursive: true});
        rmSync(join(root, 'vendor/fonts/montserrat/montserrat-latin-400-normal.woff2'));
        broken = await startTestApi({assetRoot: root});
        const md = '# Fonts\n\nBody text in the regular weight.\n';
        const r = await render(broken.url, md, DEFAULT_QUERY);
        assert.equal(r.status, 200);
        const warnings = warningsOf(r);
        assert.ok(warnings.some((w) => /^Font Montserrat 400 did not load/.test(w)), JSON.stringify(warnings));
        const strict = await render(broken.url, md, DEFAULT_QUERY + '&strict=true');
        assert.equal(strict.status, 422);
        assert.ok(strict.json.error.warnings.some((w) => /Montserrat 400 did not load/.test(w)));
    } finally {
        if (broken) await broken.close();
        rmSync(root, {recursive: true, force: true});
    }
});

test('fonts: with every face in place there is no font warning', async () => {
    const r = await render(api.url, '# Fonts\n\nBody, **bold**, *italic* and `code` ✔ ⚙ →.\n', DEFAULT_QUERY);
    assert.equal(r.status, 200);
    assert.deepEqual(warningsOf(r).filter((w) => /^Font /.test(w)), []);
});

/** pdfimages -list rows: {width, height, xppi} of each image (soft masks left out). */
function pdfImageRows(buffer) {
    return withPdf(buffer, (file) => execFileSync('pdfimages', ['-list', file]).toString().split('\n').slice(2)
        .map((line) => line.trim().split(/\s+/)).filter((c) => c[2] === 'image')
        .map((c) => ({width: Number(c[3]), height: Number(c[4]), xppi: Number(c[12])})));
}

test('images: 100 px stretched to 6 in is a warning; 1200 px at 2 in is not; strict refuses the first', async () => {
    const md = `# Images\n\n<img alt="small" width="576" src="${pngDataUri(100, 60)}">\n\n`
        + `<img alt="sharp" width="192" src="${pngDataUri(1200, 600)}">\n`;
    const r = await render(api.url, md, 'template=unbranded');
    assert.equal(r.status, 200);
    const ppi = warningsOf(r).filter((w) => /^Image \d+ is about/.test(w));
    assert.deepEqual(ppi, ['Image 1 is about 17 ppi at the size it prints; 150 or more prints sharply.']);
    const rows = pdfImageRows(r.body);
    assert.ok(rows.some((row) => row.width === 1200 && row.height === 600 && row.xppi >= 590 && row.xppi <= 610),
        `1200 px image embedded whole at about 600 ppi: ${JSON.stringify(rows)}`);
    const strict = await render(api.url, md, 'template=unbranded&strict=true');
    assert.equal(strict.status, 422);
    assert.ok(strict.json.error.warnings.some((w) => /^Image 1 is about 17 ppi/.test(w)));
});

test('images: a 6000 px photo is embedded at its own size, never resampled', async () => {
    const r = await render(api.url, `# Photo\n\n![wide](${pngDataUri(6000, 300)})\n`, DEFAULT_QUERY);
    assert.equal(r.status, 200);
    const rows = pdfImageRows(r.body).filter((row) => row.height === 300);
    assert.equal(rows.length, 1, JSON.stringify(rows));
    assert.equal(rows[0].width, 6000);
    assert.deepEqual(warningsOf(r).filter((w) => /^Image /.test(w)), [], 'fills the column at about 900 ppi');
});

test('images: SVG is vector and never checked', async () => {
    const svg = 'data:image/svg+xml;base64,' + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="red"/></svg>').toString('base64');
    const r = await render(api.url, `# Vector\n\n<img alt="v" width="576" src="${svg}">\n`, DEFAULT_QUERY);
    assert.equal(r.status, 200);
    assert.deepEqual(warningsOf(r).filter((w) => /^Image /.test(w)), []);
});

/** pdfinfo's fields as an object. */
function pdfInfoFields(buffer) {
    return withPdf(buffer, (file) => Object.fromEntries(execFileSync('pdfinfo', [file]).toString().split('\n')
        .map((line) => /^([^:]+):\s*(.*)$/.exec(line)).filter(Boolean).map((m) => [m[1].trim(), m[2].trim()])));
}

/**
 * The outline (bookmark) titles, sorted: objects with a /Parent and a literal /Title (Chromium
 * writes them uncompressed); a later object with the same number (an incremental update) wins.
 */
function outlineTitles(buffer) {
    const byNum = new Map();
    for (const m of buffer.toString('latin1').matchAll(/(\d+) \d+ obj\s*(<<[^]*?)endobj/g)) {
        const title = /\/Title\s*\(((?:\\.|[^\\)])*)\)/.exec(m[2]);
        if (m[2].includes('/Parent') && title) byNum.set(m[1], title[1]);
    }
    return [...byNum.values()].sort();
}

const pageText = (buffer, page) => withPdf(buffer, (file) => execFileSync('pdftotext', ['-f', String(page), '-l', String(page), file, '-']).toString());

test('document: title, author, subject, creator, language, tags and an outline in the PDF', async () => {
    const md = '---\ntitle: Quarterly plan\nauthor: Jo Bloggs\nsubject: Plans for the quarter\nlang: en-GB\n---\n'
        + '# Overview\n\nText.\n\n## Budget\n\nMore text.\n\n## Risks\n\nLast.\n';
    const r = await render(api.url, md, 'template=unbranded');
    assert.equal(r.status, 200);
    const info = pdfInfoFields(r.body);
    assert.equal(info.Title, 'Quarterly plan');
    assert.equal(info.Author, 'Jo Bloggs');
    assert.equal(info.Subject, 'Plans for the quarter');
    assert.equal(info.Creator, 'PrintMD');
    assert.equal(info.Producer, 'PrintMD');
    assert.equal(info.Tagged, 'yes');
    assert.match(r.body.toString('latin1'), /\/Lang \(en-GB\)/);
    assert.ok(!/HeadlessChrome|Skia\/PDF/.test(r.body.toString('latin1')), 'no browser name or version left in the file');
    // Behind a cover, Chromium names the first heading's bookmark twice ("OverviewOverview"): repaired.
    assert.deepEqual(outlineTitles(r.body), ['Budget', 'Overview', 'Risks']);
    const noCover = await render(api.url, md, 'template=unbranded&cover=false');
    assert.deepEqual(outlineTitles(noCover.body), ['Budget', 'Overview', 'Risks']);
});

test('document: a first heading with $ sequences keeps its bookmark title exactly (no replacement patterns)', async () => {
    for (const heading of ["Costs in $'000", 'Prices $& more', 'Cost $` before', 'Group $1 and $$']) {
        const r = await render(api.url, `# ${heading}\n\nText.\n\n## Second\n\nMore.\n`, 'template=unbranded');
        assert.equal(r.status, 200);
        assert.deepEqual(outlineTitles(r.body), [heading, 'Second'].sort(), heading);
    }
});

test('document: the language defaults to en, the lang option wins, and a bad tag is refused or warned about', async () => {
    const plain = await render(api.url, '# Plain\n\nText.\n', DEFAULT_QUERY);
    assert.match(plain.body.toString('latin1'), /\/Lang \(en\)/);
    const option = await render(api.url, '---\nlang: de\n---\n# Option\n', DEFAULT_QUERY + '&lang=fr-CA');
    assert.match(option.body.toString('latin1'), /\/Lang \(fr-CA\)/);
    const bad = await render(api.url, '# Bad\n', DEFAULT_QUERY + '&lang=not%20a%20tag');
    assert.equal(bad.status, 400);
    const badFront = await render(api.url, '---\nlang: "x;y"\n---\n# Front\n', DEFAULT_QUERY);
    assert.equal(badFront.status, 200);
    assert.ok(warningsOf(badFront).some((w) => /language is not a tag/.test(w)));
    assert.match(badFront.body.toString('latin1'), /\/Lang \(en\)/);
});

test('document: non-ASCII metadata is written as UTF-16', async () => {
    const r = await render(api.url, '# Café résumé ✓\n\nText.\n', DEFAULT_QUERY + '&author=Zoë%20Ångström');
    const info = pdfInfoFields(r.body);
    assert.equal(info.Title, 'Café résumé ✓');
    assert.equal(info.Author, 'Zoë Ångström');
});

/** Paragraphs "Line N: ..." of one printed line each. */
const lines = (n) => Array.from({length: n}, (_, i) => `Line ${i + 1}: alpha beta gamma delta.`).join('\n\n');

test('tidy: a body that overflows by two lines is scaled down until it fits, and the header says how far', async () => {
    // How many of these lines fit on one page, without a cover, untidied.
    const probe = await render(api.url, `${lines(120)}\n`, 'template=unbranded&cover=false&tidy=false');
    assert.equal(probe.headers.get('x-printmd-tidy'), 'off');
    const fit = [...pageText(probe.body, 1).matchAll(/Line (\d+):/g)].length;
    assert.ok(fit > 10, `lines on page 1: ${fit}`);
    const md = `${lines(fit + 2)}\n`;
    const untidy = await render(api.url, md, 'template=unbranded&cover=false&tidy=false');
    assert.equal(Number(untidy.headers.get('x-printmd-pages')), 2, 'two lines over');
    const r = await render(api.url, md, 'template=unbranded&cover=false');
    assert.equal(r.status, 200);
    const scale = Number(r.headers.get('x-printmd-tidy'));
    assert.ok(scale >= 90 && scale < 100, `scaled to ${scale} %`);
    assert.equal(Number(r.headers.get('x-printmd-pages')), 1, 'the two lines moved back');
    assert.ok(pageText(r.body, 1).includes(`Line ${fit + 2}:`));
});

test('tidy: a last page that needs a full page of room keeps the first print, and says the page is nearly empty', async () => {
    // Text, then an image as tall as the text column: a smaller scale gains nothing, so the first step ends it.
    const md = `# Floor\n\n${lines(10)}\n\n![tall](${pngDataUri(400, 2000)})\n`;
    const r = await render(api.url, md, 'template=unbranded&cover=false');
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('x-printmd-tidy'), '100');
    assert.equal(Number(r.headers.get('x-printmd-pages')), 2);
    assert.deepEqual(warningsOf(r).filter((w) => /last page/.test(w)), ['The last page holds only 0 words.']);
    const advisories = JSON.parse(decodeURIComponent(r.headers.get('x-printmd-advisories')));
    assert.deepEqual(advisories, ['The last page holds only 0 words.']);
    const strict = await render(api.url, md, 'template=unbranded&cover=false&strict=true');
    assert.equal(strict.status, 200, 'an advisory never makes strict refuse');
});

test('tidy: off with tidy=false and in JSON, and the cover is never counted as a body page', async () => {
    const res = await fetch(`${api.url}/api/v1/render`, {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({markdown: '# Short\n\nOne page.\n', template: DEFAULT_TEMPLATE, tidy: false}),
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-printmd-tidy'), 'off');
    const withCover = await render(api.url, '# Short\n\nOne page.\n', DEFAULT_QUERY);
    assert.equal(withCover.headers.get('x-printmd-pages'), '2');
    assert.equal(withCover.headers.get('x-printmd-tidy'), '100', 'a one-page body behind a cover is left alone');
});

test('layout: a heading never ends a page, a table repeats its header, an image is never taller than the column', async () => {
    const probe = await render(api.url, `${lines(120)}\n`, 'template=unbranded&cover=false&tidy=false');
    const fit = [...pageText(probe.body, 1).matchAll(/Line (\d+):/g)].length;
    // One line short of a full page, then a heading: it moves to page 2 with its paragraph.
    const heading = await render(api.url, `${lines(fit - 1)}\n\n## Lonely heading\n\nIts paragraph.\n`, 'template=unbranded&cover=false&tidy=false');
    assert.ok(!pageText(heading.body, 1).includes('Lonely heading'), 'not at the foot of page 1');
    assert.ok(pageText(heading.body, 2).includes('Lonely heading'));

    const rows = Array.from({length: 80}, (_, i) => `| Row ${i + 1} | value ${i + 1} |`).join('\n');
    const table = await render(api.url, `# Table\n\n| Column head | Second head |\n|---|---|\n${rows}\n`, 'template=unbranded&cover=false&tidy=false');
    assert.ok(Number(table.headers.get('x-printmd-pages')) >= 2);
    assert.match(pageText(table.body, 2), /Column head/i, 'header row repeated on page 2');

    const tall = await render(api.url, `![tall](${pngDataUri(300, 6000)})\n`, 'template=unbranded&cover=false&tidy=false');
    assert.equal(tall.headers.get('x-printmd-pages'), '1', 'a very tall image is scaled to fit one page');
});

const LINKS_MD = '# Links\n\nRead [the guide](https://example.com/guide/start) first.\n\n'
    + 'Bare: <https://example.com/same>. Jump to [the top](#links). Mail [us](mailto:a@example.com).\n';

test('printLinks: external addresses print after the link text, never twice, never for anchors; off by default', async () => {
    const on = pageText((await render(api.url, LINKS_MD, DEFAULT_QUERY + '&cover=false&printLinks=true')).body, 1);
    assert.match(on.replace(/\s+/g, ' '), /the guide \(https:\/\/example\.com\/guide\/start\)/);
    assert.ok(!on.includes('(https://example.com/same)'), 'a link that reads as its address is not repeated');
    assert.ok(!on.includes('(#links)') && !on.includes('(mailto:'), 'anchors and mail links are not printed');
    const off = pageText((await render(api.url, LINKS_MD, DEFAULT_QUERY + '&cover=false')).body, 1);
    assert.ok(!off.includes('(https://example.com/guide/start)'), 'off by default');
    const front = pageText((await render(api.url, `---\nprint-links: true\n---\n${LINKS_MD}`, DEFAULT_QUERY + '&cover=false')).body, 1);
    assert.ok(front.includes('(https://example.com/guide/start)'), 'front matter print-links: true');
});

test('printLinks: a long address wraps inside the text column', async () => {
    const long = `https://example.com/${'segment-'.repeat(30)}end`;
    const r = await render(api.url, `# Long\n\nSee [this page](${long}).\n`, DEFAULT_QUERY + '&cover=false&printLinks=true');
    const words = withPdf(r.body, (file) => execFileSync('pdftotext', ['-bbox', file, '-']).toString());
    const page = /<page width="([\d.]+)"/.exec(words);
    const maxX = Math.max(...[...words.matchAll(/xMax="([\d.]+)"/g)].map((m) => Number(m[1])));
    assert.ok(maxX < Number(page[1]) - 50, `rightmost text at ${maxX} of ${page[1]} pt`);
    assert.ok(pageText(r.body, 1).replace(/\s+/g, '').includes(long), 'the whole address is printed');
});
