/**
 * The print-quality guards CI runs (tests/lib/server-tests.mjs), in as few
 * renders as possible: at half a CPU each render costs several seconds. Each
 * rule has a fuller test in print-checks.test.mjs, which runs everywhere but CI.
 *
 * Guarded here: a font that does not load is a warning; the ppi warning and
 * strict's 422, while a short last page is an advisory strict lets through; title, author, subject, Creator, tags, /Lang (given and the en
 * default); printed link addresses; the bookmark repair with $ sequences in the
 * first heading; the tidy pulling two overflowing lines back.
 */
import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {cpSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {REPO_ROOT} from '../src/paths.mjs';
import {startTestApi, render, warningsOf, DEFAULT_QUERY, DEFAULT_TEMPLATE} from './helpers.mjs';
import {templateEntry} from '../src/templates-info.mjs';
import {FONT_FACES} from '../../js/fonts.js';
import {pngDataUri} from './png.mjs';

let api;

before(async () => {
    api = await startTestApi();
});

after(async () => {
    await api.close();
});

function withPdf(buffer, fn) {
    const dir = mkdtempSync(join(tmpdir(), 'bd-gate-'));
    try {
        const file = join(dir, 'out.pdf');
        writeFileSync(file, buffer);
        return fn(file);
    } finally {
        rmSync(dir, {recursive: true, force: true});
    }
}

const pdfInfoFields = (buffer) => withPdf(buffer, (file) => Object.fromEntries(execFileSync('pdfinfo', [file]).toString()
    .split('\n').map((line) => /^([^:]+):\s*(.*)$/.exec(line)).filter(Boolean).map((m) => [m[1].trim(), m[2].trim()])));
const pageText = (buffer, page) => withPdf(buffer, (file) => execFileSync('pdftotext', ['-f', String(page), '-l', String(page), file, '-']).toString());

/** Outline titles, sorted; a later object with the same number (an incremental update) wins. */
function outlineTitles(buffer) {
    const byNum = new Map();
    for (const m of buffer.toString('latin1').matchAll(/(\d+) \d+ obj\s*(<<[^]*?)endobj/g)) {
        const title = /\/Title\s*\(((?:\\.|[^\\)])*)\)/.exec(m[2]);
        if (m[2].includes('/Parent') && title) byNum.set(m[1], title[1]);
    }
    return [...byNum.values()].sort();
}

const HEADING = "Costs in $'000 and $& more";
const GATE_MD = ['---', 'title: Gate document', 'author: Jo Bloggs', 'subject: The gate', 'lang: en-GB', 'print-links: true', '---',
    `# ${HEADING}`, '', 'Read [the guide](https://example.com/guide/start) first.', '',
    `<img alt="small" width="576" src="${pngDataUri(100, 60)}">`, '', '## Second', '', 'More.', ''].join('\n');

test('gate: metadata, language, printed links, the ppi warning and an exact bookmark behind a cover, in one render', async () => {
    const r = await render(api.url, GATE_MD, 'template=unbranded');
    assert.equal(r.status, 200);
    const info = pdfInfoFields(r.body);
    assert.equal(info.Title, 'Gate document');
    assert.equal(info.Author, 'Jo Bloggs');
    assert.equal(info.Subject, 'The gate');
    assert.equal(info.Creator, 'PrintMD');
    assert.equal(info.Tagged, 'yes');
    assert.match(r.body.toString('latin1'), /\/Lang \(en-GB\)/);
    assert.match(pageText(r.body, 2).replace(/\s+/g, ' '), /the guide \(https:\/\/example\.com\/guide\/start\)/);
    assert.ok(warningsOf(r).includes('Image 1 is about 17 ppi at the size it prints; 150 or more prints sharply.'),
        JSON.stringify(warningsOf(r)));
    assert.deepEqual(outlineTitles(r.body), [HEADING, 'Second'].sort());
});

test('gate: strict refuses a blocking warning (low ppi) but not an advisory (a short last page)', async () => {
    const r = await render(api.url, GATE_MD, 'template=unbranded&strict=true');
    assert.equal(r.status, 422);
    assert.ok(r.json.error.warnings.some((w) => /^Image 1 is about 17 ppi/.test(w)));
    // Ten lines, then a sharp image as tall as the text column: even at 90 % the image needs page 2, which holds no words.
    const short = await render(api.url, `# Short\n\n${lines(10)}\n\n![tall](${pngDataUri(1600, 8000)})\n`,
        'template=unbranded&cover=false&strict=true');
    assert.equal(short.status, 200, JSON.stringify(short.json || {}));
    const advisories = JSON.parse(decodeURIComponent(short.headers.get('x-printmd-advisories')));
    assert.deepEqual(advisories, ['The last page holds only 0 words.']);
    assert.ok(warningsOf(short).includes('The last page holds only 0 words.'), 'also in the warnings header');
});

test('gate: a vendored face that does not load is a warning', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bd-gate-fonts-'));
    let broken;
    try {
        for (const dir of ['js', 'templates', 'vendor', 'assets']) cpSync(join(REPO_ROOT, dir), join(root, dir), {recursive: true});
        // The default template's own regular face (Montserrat in one edition, Source Serif Pro in another).
        const family = templateEntry(DEFAULT_TEMPLATE).manifest.fontStack.split(',')[0].trim().replace(/^['"]|['"]$/g, '');
        const face = FONT_FACES.find((f) => f.family === family && f.weight === 400 && f.style === 'normal' && f.subset === 'latin');
        assert.ok(face, `a vendored ${family} 400 normal face`);
        rmSync(join(root, 'vendor/fonts', face.file));
        broken = await startTestApi({assetRoot: root});
        const r = await render(broken.url, '# Fonts\n\nBody text in the regular weight.\n', DEFAULT_QUERY + '&cover=false');
        assert.equal(r.status, 200);
        assert.ok(warningsOf(r).some((w) => w.startsWith(`Font ${family} 400 did not load`)), JSON.stringify(warningsOf(r)));
    } finally {
        if (broken) await broken.close();
        rmSync(root, {recursive: true, force: true});
    }
});

const lines = (n) => Array.from({length: n}, (_, i) => `Line ${i + 1}: alpha beta gamma delta.`).join('\n\n');

test('gate: the tidy pulls two overflowing lines back; the language defaults to en', async () => {
    const probe = await render(api.url, `${lines(120)}\n`, 'template=unbranded&cover=false&tidy=false');
    assert.equal(probe.headers.get('x-printmd-tidy'), 'off');
    assert.match(probe.body.toString('latin1'), /\/Lang \(en\)/);
    const fit = [...pageText(probe.body, 1).matchAll(/Line (\d+):/g)].length;
    const r = await render(api.url, `${lines(fit + 2)}\n`, 'template=unbranded&cover=false');
    const scale = Number(r.headers.get('x-printmd-tidy'));
    assert.ok(scale >= 90 && scale < 100, `scaled to ${scale} %`);
    assert.equal(r.headers.get('x-printmd-pages'), '1');
});
