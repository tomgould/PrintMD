/**
 * The template platform end to end, with the test-only fixture template
 * (tests/fixtures/platform-fixture/template.js), which no manifest of the app
 * lists: the real server, started from a copy of the repo whose core manifest
 * names one more layer holding the fixture, renders it through the API in A4
 * portrait, A4 landscape and Slide, and server/qa/pdf-qa.mjs passes each PDF
 * with --cover. On top: the running head and foot print on every body page and
 * never on the cover, nothing prints within 8 mm of an edge (margin text keeps
 * 10 mm), the cover shows the subject, the logo prints in the foot, the page
 * canvas fills the margin strips of every body page and leaves the cover as it is
 * (against a copy of the fixture without it), the PDF holds no raster image,
 * every new font family and Inter's true italic are embedded and no system font
 * appears, and the listing carries the entry's group and description.
 */
import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync, spawn} from 'node:child_process';
import {cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {REPO_ROOT, SERVER_ROOT} from '../src/paths.mjs';
import {checkPdf, formatResult, parseBbox} from '../qa/pdf-qa.mjs';
import {CHROME, pdfFontTable} from './helpers.mjs';

const ID = 'platform-fixture';
const FIXTURE_DIR = 'templates/__fixtures__/platform-fixture';
const LAYER = 'templates/manifest.platform-fixture.json';
const PLAIN = 'platform-plain';
const PLAIN_DIR = 'templates/__fixtures__/platform-plain';
const CANVAS = [0x1d, 0x18, 0x15];
const MM = 72 / 25.4;
const DOC = [
    '---', 'title: Platform fixture report', 'author: Example Co', 'date: 2026-11-01',
    'subject: Every part of the template platform', '---',
    '# Platform fixture report', '',
    'Body text in Figtree with *italic*, **bold** and ***bold italic*** words, a [link](https://example.org) and `code`.', '',
    '## A Schibsted Grotesk heading', '', '### A Plus Jakarta Sans heading', '', '#### An IBM Plex Sans heading', '',
    '##### A DM Sans heading', '', '###### An Inter Full italic heading', '',
    '> A Lora italic quotation, set apart from the text around it.', '',
    '| Libre Caslon Text | Value |', '|---|---|', ...Array.from({length: 12}, (_, i) => `| Row ${i + 1} *note* | ${i * 7} |`), '',
    '```js', 'export const total = (items) => items.reduce((sum, i) => sum + i.price, 0);', '```', '',
    ...Array.from({length: 14}, (_, i) => `Paragraph ${i + 1}: editors plan the week, check each story against the style guide and `
        + 'send the final pages to print on time, with every table and quotation in its place.\n'),
].join('\n');
/** PDF font names start with the family without spaces (pdf-qa isVendoredFontName). */
const NEW_FAMILY_PREFIXES = ['Figtree', 'Fraunces', 'SchibstedGrotesk', 'PlusJakartaSans', 'IBMPlexSans', 'DMSans', 'Lora',
    'LibreCaslonText', 'Inter-'];

let dir;
let server;
let out;

/** A copy of what the server loads, plus the fixture registered through one more layer. */
function copyRepo() {
    const d = mkdtempSync(join(tmpdir(), 'bd-platform-'));
    for (const part of ['js', 'templates', 'server/src', 'server/harness.html']) cpSync(join(REPO_ROOT, part), join(d, part), {recursive: true});
    // Fonts and logos as they are (the renderer follows symlinks inside each served folder).
    for (const part of ['vendor', 'assets']) symlinkSync(join(REPO_ROOT, part), join(d, part));
    if (existsSync(join(SERVER_ROOT, 'node_modules'))) symlinkSync(join(SERVER_ROOT, 'node_modules'), join(d, 'server/node_modules'));
    mkdirSync(join(d, FIXTURE_DIR), {recursive: true});
    for (const f of ['template.js', 'logo.svg']) cpSync(join(REPO_ROOT, 'tests/fixtures/platform-fixture', f), join(d, FIXTURE_DIR, f));
    // The same fixture without its page canvas, to show the cover is the same either way.
    const source = readFileSync(join(REPO_ROOT, 'tests/fixtures/platform-fixture/template.js'), 'utf8');
    const plain = source.replace(`const ID = '${ID}';`, `const ID = '${PLAIN}';`).replace(/^ {4}pageBackground: .*\n/m, '');
    assert.ok(plain !== source && !plain.includes('pageBackground:'), 'the plain copy has no pageBackground');
    mkdirSync(join(d, PLAIN_DIR), {recursive: true});
    writeFileSync(join(d, PLAIN_DIR, 'template.js'), plain);
    cpSync(join(REPO_ROOT, 'tests/fixtures/platform-fixture/logo.svg'), join(d, PLAIN_DIR, 'logo.svg'));
    const core = JSON.parse(readFileSync(join(REPO_ROOT, 'templates/manifest.core.json'), 'utf8'));
    writeFileSync(join(d, 'templates/manifest.core.json'), JSON.stringify({...core, layers: [...(core.layers || []), LAYER]}));
    writeFileSync(join(d, LAYER), JSON.stringify({templates: [
        {id: ID, path: `${FIXTURE_DIR}/template.js`, group: 'Test', description: 'The fixture, as its manifest entry describes it'},
        {id: PLAIN, path: `${PLAIN_DIR}/template.js`, group: 'Test'},
    ]}));
    return d;
}

/** The copy's server in local mode; resolves at "listening" or at exit. */
function start(d) {
    const child = spawn(process.execPath, [join(d, 'server/src/main.mjs'), '--local'], {
        env: {PATH: process.env.PATH, HOME: process.env.HOME || '/tmp', PRINTMD_PORT: '0', PRINTMD_CHROME: CHROME, CI: process.env.CI || ''},
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    return new Promise((ok) => {
        child.stdout.on('data', (b) => {
            stdout += b;
            const line = stdout.split('\n').find((l) => l.includes('"event":"listening"'));
            if (line) ok({child, url: JSON.parse(line).url});
        });
        child.stderr.on('data', (b) => { stderr += b; });
        child.once('exit', (code) => ok({child, code, stderr}));
    });
}

before(async () => {
    dir = copyRepo();
    out = mkdtempSync(join(tmpdir(), 'bd-platform-pdf-'));
    server = await start(dir);
    assert.ok(server.url, `the server started: ${server.stderr || ''}`);
});

after(async () => {
    if (server && server.code === undefined) {
        server.child.kill('SIGTERM');
        await new Promise((ok) => server.child.once('exit', ok));
    }
    if (dir) rmSync(dir, {recursive: true, force: true});
    if (out) rmSync(out, {recursive: true, force: true});
});

async function renderFixture(query, template = ID) {
    const res = await fetch(`${server.url}/api/v1/render?${new URLSearchParams({template, ...query})}`, {
        method: 'POST', headers: {'content-type': 'text/markdown; charset=utf-8'}, body: DOC,
    });
    const body = Buffer.from(await res.arrayBuffer());
    assert.equal(res.status, 200, body.toString('utf8').slice(0, 300));
    return {body, warnings: JSON.parse(decodeURIComponent(res.headers.get('x-printmd-warnings') || '%5B%5D'))};
}

/** Page i (1-based) as RGB pixels at 60 dpi: {width, height, ppm, at(xMm, yMm)}. */
function pagePixels(file, page) {
    const ppm = execFileSync('pdftoppm', ['-r', '60', '-f', String(page), '-l', String(page), file]);
    const header = /^P6\s+(\d+)\s+(\d+)\s+255\s/.exec(ppm.toString('latin1', 0, 40));
    const [width, height] = [Number(header[1]), Number(header[2])];
    const offset = header[0].length;
    const perMm = 60 / 25.4;
    return {
        width, height, ppm,
        at(xMm, yMm) {
            const x = Math.min(width - 1, Math.round(xMm * perMm));
            const y = Math.min(height - 1, Math.round(yMm * perMm));
            const i = offset + (y * width + x) * 3;
            return [ppm[i], ppm[i + 1], ppm[i + 2]];
        },
    };
}

const LAYOUTS = [
    {pageSize: 'A4', orientation: 'portrait', mm: [210, 297]},
    {pageSize: 'A4', orientation: 'landscape', mm: [297, 210]},
    {pageSize: 'Slide', orientation: 'landscape', mm: [254, 142.9]},
];

for (const layout of LAYOUTS) {
    test(`fixture in ${layout.pageSize} ${layout.orientation}: pdf-qa passes with --cover; running head and foot, subject, logo, background, fonts`, async () => {
        const {body, warnings} = await renderFixture({pageSize: layout.pageSize, orientation: layout.orientation});
        assert.deepEqual(warnings, [], 'no warnings (fonts loaded, nothing blocked)');
        const file = join(out, `${layout.pageSize}-${layout.orientation}.pdf`);
        writeFileSync(file, body);

        // No raster image: the document has none, and the fixture's shadows have no blur.
        const qa = await checkPdf(file, {cover: true, pageSize: layout.pageSize, orientation: layout.orientation, maxImages: 0});
        assert.ok(qa.ok, formatResult(qa));
        assert.ok(qa.pages >= 3, `a cover and at least two body pages: ${qa.pages}`);

        // Running head and foot: on every body page, never on the cover; page numbers count the cover.
        const text = (p) => execFileSync('pdftotext', ['-f', String(p), '-l', String(p), '-layout', '-enc', 'UTF-8', file, '-']).toString('utf8');
        const cover = text(1);
        assert.ok(cover.includes('Every part of the template platform'), 'the cover shows the subject');
        assert.ok(!/Page \d+ of \d+/.test(cover), 'no running foot on the cover');
        for (let p = 2; p <= qa.pages; p++) {
            const t = text(p);
            assert.ok(t.includes(`Page ${p} of ${qa.pages}`), `page ${p}: "Page ${p} of ${qa.pages}"`);
            assert.ok(t.includes('Example Co') && t.includes('1 November 2026'), `page ${p}: author and date`);
        }

        // Margin text keeps 10 mm from every edge (pdf-qa's band is 8 mm; js/page-chrome.js aims for 11).
        const pages = parseBbox(execFileSync('pdftotext', ['-bbox', '-enc', 'UTF-8', file, '-']).toString('utf8'));
        for (const [i, p] of pages.entries()) {
            if (i === 0) continue;
            for (const w of p.words) {
                const edge = Math.min(w.xMin, w.yMin, p.width - w.xMax, p.height - w.yMax) / MM;
                assert.ok(edge >= 10, `page ${i + 1}: "${w.text}" is ${edge.toFixed(1)} mm from the edge`);
            }
            const head = p.words.filter((w) => w.yMax < 20 * MM);
            assert.ok(head.length > 0, `page ${i + 1}: a running head in the top margin`);
        }

        // The page canvas fills the margin strips of every body page (sampled 4 mm in from each edge, at 60 dpi).
        const [w, h] = layout.mm;
        const near = (a, b, tol = 12) => a.every((v, k) => Math.abs(v - b[k]) <= tol);
        for (let p = 2; p <= qa.pages; p++) {
            const page = pagePixels(file, p);
            for (let t = 0; t <= 1; t += 0.05) {
                for (const [x, y] of [[4 + t * (w - 8), 4], [4 + t * (w - 8), h - 4], [4, 4 + t * (h - 8)], [w - 4, 4 + t * (h - 8)]]) {
                    assert.ok(near(page.at(x, y), CANVAS, 2), `page ${p}: the margin at ${x.toFixed(0)}, ${y.toFixed(0)} mm is ${page.at(x, y)}`);
                }
            }
        }
        // The logo in the foot's centre slot.
        const px = pagePixels(file, 2);
        let logo = false;
        for (let x = w / 2 - 12; x <= w / 2 + 12 && !logo; x += 0.5) {
            for (let y = h - 16; y <= h - 9 && !logo; y += 0.5) logo = near(px.at(x, y), [0x2f, 0x5b, 0xd2], 40);
        }
        assert.ok(logo, 'the logo prints in the foot, centred');

        // Every new family embedded; only vendored fonts (pdf-qa vendored-fonts), no Type 3 (no-type3).
        const fonts = pdfFontTable(body).map((f) => f.name);
        for (const prefix of NEW_FAMILY_PREFIXES) assert.ok(fonts.some((n) => n.startsWith(prefix)), `${prefix} in ${fonts.join(', ')}`);
        assert.ok(fonts.some((n) => /^Inter-(?:Bold)?Italic$/.test(n)), `a true Inter italic: ${fonts.join(', ')}`);
    });
}

test('the page canvas leaves the cover as it is: the cover page is the same pixel for pixel without it', async () => {
    const files = {};
    for (const template of [ID, PLAIN]) {
        files[template] = join(out, `cover-${template}.pdf`);
        writeFileSync(files[template], (await renderFixture({pageSize: 'A4', orientation: 'portrait'}, template)).body);
    }
    const [a, b] = [pagePixels(files[ID], 1), pagePixels(files[PLAIN], 1)];
    assert.ok(a.ppm.equals(b.ppm), 'page 1 (the cover) is identical');
    const near = (x, y) => x.every((v, k) => Math.abs(v - y[k]) <= 2);
    assert.ok(near(pagePixels(files[ID], 2).at(4, 4), CANVAS), 'with it, the body margins take the canvas');
    assert.ok(near(pagePixels(files[PLAIN], 2).at(4, 4), [255, 255, 255]), 'without it, they stay white');
});

test('the listing carries the fixture entry\'s group and description, Slide among its sizes; the others carry their own group', async () => {
    const list = await (await fetch(`${server.url}/api/v1/templates`)).json();
    const fixture = list.templates.find((t) => t.id === ID);
    assert.equal(fixture.group, 'Test');
    assert.equal(fixture.description, 'The fixture, as its manifest entry describes it');
    assert.deepEqual(fixture.pageSizes, ['A4', 'Letter', 'Slide']);
    assert.deepEqual(Object.keys(fixture), ['id', 'name', 'description', 'group', 'version', 'margin', 'pageSizes', 'orientations']);
    // The private manifests give every template a group ("Current" for the first four); the public edition's have none.
    for (const t of list.templates.filter((x) => x.id !== ID && x.id !== PLAIN)) {
        // defaultSize and defaultOrientation only for a template whose manifest names them; group likewise.
        const defaults = ['defaultSize', 'defaultOrientation'].filter((k) => k in t);
        const group = 'group' in t ? ['group'] : [];
        assert.deepEqual(Object.keys(t), ['id', 'name', 'description', ...group, 'version', 'margin', 'pageSizes', 'orientations', ...defaults], t.id);
        assert.ok(!('group' in t) || (typeof t.group === 'string' && t.group.length > 0), `${t.id}: a group, when it has one, is text`);
    }
    // The first template of the real manifests (the fixtures' layers may come first in an edition with no layer of its own).
    const firstReal = list.templates.find((x) => x.id !== ID && x.id !== PLAIN);
    if ('group' in firstReal) assert.equal(firstReal.group, 'Current', 'the default template');
    assert.ok(!list.warnings, `no layer skipped: ${list.warnings}`);
});

test('a template\'s default page applies when the request names no size or orientation; an explicit one wins', async (t) => {
    const list = await (await fetch(`${server.url}/api/v1/templates`)).json();
    // A company template (deck) names Slide and landscape; an edition without one skips this.
    const slideFirst = list.templates.find((x) => x.defaultSize === 'Slide' && x.defaultOrientation === 'landscape');
    if (!slideFirst) return t.skip('no template defaults to Slide');
    for (const x of list.templates) {
        if (x.defaultSize) assert.ok(x.pageSizes.includes(x.defaultSize), `${x.id} offers its default size`);
    }
    /** The first page's size in mm, rounded, for a render with these query options. */
    const pageMm = async (query, id = slideFirst.id) => {
        const res = await fetch(`${server.url}/api/v1/render?template=${id}${query}`, {
            method: 'POST', headers: {'content-type': 'text/markdown'}, body: '# Update\n\nOne line.\n',
        });
        assert.equal(res.status, 200, query);
        const file = join(out, `default-${id}${query.replace(/[^a-z0-9]+/gi, '-')}.pdf`);
        writeFileSync(file, Buffer.from(await res.arrayBuffer()));
        const [, w, h] = /Page size:\s+([\d.]+) x ([\d.]+) pts/.exec(execFileSync('pdfinfo', [file], {encoding: 'utf8'}));
        return `${Math.round(w / MM)}x${Math.round(h / MM)}`;
    };
    assert.equal(await pageMm(''), '254x143', 'Slide by default');
    assert.equal(await pageMm('&pageSize=A4'), '297x210', 'A4 chosen, landscape by default');
    assert.equal(await pageMm('&orientation=portrait'), '210x297', 'portrait chosen: A4, not the landscape-only Slide');
    assert.equal(await pageMm('&pageSize=Letter&orientation=portrait'), '216x279');
    const plain = list.templates.find((x) => !x.defaultSize && !x.defaultOrientation);
    assert.equal(await pageMm('', plain.id), '210x297', 'a template without a default page: A4 portrait as before');
});

test('a page size the template does not offer is a 400 that names the sizes it does', async () => {
    const list = await (await fetch(`${server.url}/api/v1/templates`)).json();
    const other = list.templates.find((t) => !t.pageSizes.includes('Slide'));
    const res = await fetch(`${server.url}/api/v1/render?template=${other.id}&pageSize=Slide`, {
        method: 'POST', headers: {'content-type': 'text/markdown'}, body: '# x',
    });
    assert.equal(res.status, 400);
    const json = await res.json();
    assert.equal(json.error.code, 'invalid_option');
    assert.match(json.error.message, /offers pageSize A4, A3, A5, Letter, Legal/);
    const legal = await fetch(`${server.url}/api/v1/render?template=${ID}&pageSize=Legal`, {
        method: 'POST', headers: {'content-type': 'text/markdown'}, body: '# x',
    });
    assert.equal(legal.status, 400, 'the fixture lists A4, Letter and Slide only');
});
