#!/usr/bin/env node
/**
 * tests/fixtures/build-pdfs.mjs
 *
 * Rebuilds the PDF fixtures used by tests/importers-pdf.test.html with headless
 * Chrome (Page.printToPDF). The PDFs are committed, so the tests never run this;
 * run it only to change a fixture, then update tests/fixtures/expected/*.md.
 *
 *   node tests/fixtures/build-pdfs.mjs [file.pdf ...]   (no names: all of them)
 *
 * code-listing.pdf  untagged, 4 pages: running header, "Page N of 4" footer,
 *                   one long monospace listing that continues across pages
 * tagged.pdf        tagged (generateTaggedPDF): divs, nested lists, a table, a link
 * rtl.pdf           untagged: Arabic and Hebrew paragraphs between English lines
 * rtl-tagged.pdf    the same page, tagged
 * inject-tagged.pdf, inject-untagged.pdf
 *                   Markdown image and link syntax as PDF text (paragraph, table
 *                   cell, list item), next to ordinary prose that must read the same
 *
 * Real-world layouts, all with invented text (Example Co, lorem ipsum):
 * article-sidebar.pdf  untagged, 2 pages: a serif article with a narrow metadata
 *                   sidebar, a running header and footer, an image, bold, italic,
 *                   inline code, curly quotes, links, a ruled table and a list
 *                   whose item breaks across the page
 * layout-tall.pdf   untagged, one tall 750 x 1087.5 pt page: a banner title, numbered
 *                   steps beside an image and its caption, and two columns of prose
 * slides.pdf        untagged, 720 x 405 pt slides: a title slide of large centred
 *                   text, then slides of "●" bullets
 * code-article.pdf  untagged, 2 pages: serif prose around a shell command and an
 *                   indented PHP block in a monospaced font, a wrapped sentence with
 *                   a link and a short last line, and a running footer with page numbers
 * tagged-figures.pdf  tagged: a decorative image (alt="", so not tagged) and one
 *                   with alt text, a list that breaks across the page, and a
 *                   hyphenated word at a line end
 */
import {readFileSync, writeFileSync} from 'node:fs';
import {deflateSync, crc32} from 'node:zlib';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {launchChrome, sleep} from '../lib/chrome.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');

function codeListing() {
    const lines = ['// INVENTORY SERVICE: GENERATED LISTING', 'const MAX_ITEMS = 500;', ''];
    for (let i = 0; i < 22; i++) {
        lines.push(`function readItem${i}(store) {`,
            `    const value = store.get('item-${i}');`,
            '    if (!value) {',
            '        return null;',
            '    }',
            `    return value * ${i + 2};`,
            '}',
            '');
    }
    lines.push('export {MAX_ITEMS};');
    const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Code Listing</title>
<style>
body { font-family: 'DejaVu Sans', sans-serif; font-size: 11pt; margin: 0; }
h1 { font-size: 24pt; margin: 0 0 12pt; }
pre { font-family: 'DejaVu Sans Mono', monospace; font-size: 10pt; line-height: 1.35; margin: 0; }
</style></head><body>
<h1>Inventory Service</h1>
<p>This listing shows the generated reader functions.</p>
<p>Copyright Example Ltd. All rights reserved.</p>
<pre>${lines.map(esc).join('\n')}</pre>
<p>End of listing.</p>
</body></html>`;
}

const TAGGED = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Tagged Structure</title>
<style>body { font-family: 'DejaVu Sans', sans-serif; font-size: 12pt; } table { border-collapse: collapse; } td, th { border: 1px solid #999; padding: 4px; }</style>
</head><body>
<h1>Tagged Structure</h1>
<div>Intro text inside a div with <b>bold words</b> and <a href="https://example.com/docs">a link</a>.</div>
<div><div>Nested div paragraph.</div></div>
<h2>Lists</h2>
<ul><li>First bullet</li><li>Second bullet with <strong>bold</strong><ul><li>Nested bullet</li></ul></li></ul>
<ol><li>Step one</li><li>Step two</li></ol>
<h2>Table</h2>
<table><thead><tr><th>Name</th><th>Value</th></tr></thead>
<tbody><tr><td>Alpha</td><td>1</td></tr><tr><td>Beta | pipe</td><td><b>2</b></td></tr></tbody></table>
<p>Closing paragraph.</p>
</body></html>`;

const RTL = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>RTL Sample</title>
<style>body { font-family: 'DejaVu Sans', sans-serif; font-size: 12pt; }
[lang=ar] { font-family: 'Noto Sans Arabic'; } [lang=he] { font-family: 'Noto Sans Hebrew'; }</style>
</head><body>
<h1>RTL Sample</h1>
<p>English line before.</p>
<p dir="rtl" lang="ar">مرحبا بالعالم. هذا نص عربي.</p>
<p dir="rtl" lang="he">שלום עולם. זהו טקסט בעברית.</p>
<p>English line after.</p>
</body></html>`;

const INJECT = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Injection</title>
<style>body { font-family: 'DejaVu Sans', sans-serif; font-size: 12pt; } table { border-collapse: collapse; } td, th { border: 1px solid #999; padding: 4px; }</style>
</head><body>
<h1>Report</h1>
<p>Para one ![p](https://canary.example/pdf-para-beacon.png) and [click](https://evil.example/pdf-link) text.</p>
<p>A real parenthesis (like this), maths 2 * 3 = 6, and the file my_report_v2.pdf.</p>
<p># not a heading</p>
<table><tr><th>Head</th><th>Two</th></tr>
<tr><td>![c](https://canary.example/pdf-cell-beacon.png)</td><td>&lt;img src=https://canary.example/lt.png&gt;</td></tr></table>
<ul><li>Item ![l](https://canary.example/pdf-li-beacon.png)</li></ul>
<p>Back\\slash and \`tick\` text.</p>
</body></html>`;

// ── Real-world layouts ──────────────────────────────────────────────────────

/** A small RGB PNG (a two-tone gradient) as a data URL, so the page has a real image XObject. */
function pngDataUrl(width, height) {
    const chunk = (type, data) => {
        const len = Buffer.alloc(4);
        len.writeUInt32BE(data.length);
        const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
        const crc = Buffer.alloc(4);
        crc.writeUInt32BE(crc32(body));
        return Buffer.concat([len, body, crc]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr.set([8, 2, 0, 0, 0], 8);   // 8-bit RGB
    const rows = [];
    for (let y = 0; y < height; y++) {
        const row = Buffer.alloc(1 + width * 3);
        for (let x = 0; x < width; x++) row.set([40 + (x * 180) / width, 90 + (y * 120) / height, 160], 1 + x * 3);
        rows.push(row);
    }
    const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr),
        chunk('IDAT', deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
    return 'data:image/png;base64,' + png.toString('base64');
}

/** The vendored Source Serif Pro and Inter as embedded @font-face rules (a data: page cannot load files). */
function fontFaces() {
    const face = (family, file, weight, style = 'normal') => {
        const data = readFileSync(join(root, 'vendor/fonts', file)).toString('base64');
        return `@font-face { font-family: '${family}'; src: url(data:font/woff2;base64,${data}) format('woff2'); font-weight: ${weight}; font-style: ${style}; }`;
    };
    return [
        face('Fixture Serif', 'source-serif-pro/source-serif-pro-latin-400-normal.woff2', 400),
        face('Fixture Serif', 'source-serif-pro/source-serif-pro-latin-400-italic.woff2', 400, 'italic'),
        face('Fixture Serif', 'source-serif-pro/source-serif-pro-latin-700-normal.woff2', 700),
        face('Fixture Sans', 'inter/inter-latin-400-normal.woff2', 400),
        face('Fixture Sans', 'inter/inter-latin-700-normal.woff2', 700),
    ].join('\n');
}

const LOREM = [
    'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.',
    'Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum.',
    'Sed ut perspiciatis unde omnis iste natus error sit voluptatem accusantium doloremque laudantium, totam rem aperiam, eaque ipsa quae ab illo inventore veritatis et quasi architecto beatae vitae dicta sunt explicabo.',
    'Nemo enim ipsam voluptatem quia voluptas sit aspernatur aut odit aut fugit, sed quia consequuntur magni dolores eos qui ratione voluptatem sequi nesciunt. Neque porro quisquam est, qui dolorem ipsum quia dolor sit amet.',
];

/** A list item long enough (about eight lines) that a page break lands inside it. */
const LONG_ITEM = 'Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat, '
    + 'duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur, excepteur sint '
    + 'occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum, sed ut perspiciatis unde '
    + 'omnis iste natus error sit voluptatem accusantium doloremque laudantium, totam rem aperiam, eaque ipsa quae ab illo '
    + 'inventore veritatis et quasi architecto beatae vitae dicta sunt explicabo, nemo enim ipsam voluptatem quia voluptas sit '
    + 'aspernatur aut odit aut fugit, sed quia consequuntur magni dolores eos qui ratione voluptatem sequi nesciunt and ends here.';

function articleSidebar() {
    const rows = [['S1', 'Small enough to hold in one hand'], ['S2', 'Fits on an ordinary kitchen shelf'],
        ['S3', 'Needs two people to lift it'], ['S4', 'Arrives on a pallet with a forklift']];
    // A long sidebar, so it runs on to page 2 beside the list that crosses the page break.
    const side = [['Updated', '4 June 2026'], ['Length', '3 pages'], ['Topics', 'Storage, Widgets']];
    for (let k = 1; k <= 17; k++) side.push([`Shelf ${k}`, `Row ${k * 3} of the north store`]);
    return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Widget Storage</title>
<style>
${fontFaces()}
body { font-family: 'Fixture Serif'; font-size: 11pt; line-height: 1.5; margin: 0; color: #222; }
h1 { font-family: 'Fixture Sans'; font-weight: 700; font-size: 26pt; margin: 0 0 8pt; }
h2 { font-family: 'Fixture Sans'; font-style: italic; font-weight: 400; font-size: 14pt; margin: 16pt 0 6pt; }
.lead { font-size: 12pt; margin: 0 0 12pt; }
.hero { width: 100%; height: 66pt; display: block; margin: 0 0 14pt; }
.grid { display: grid; grid-template-columns: 82pt 1fr; column-gap: 26pt; }
aside { font-family: 'Fixture Sans'; font-size: 7.5pt; line-height: 1.3; color: #555; }
aside .v { color: #111; font-size: 8.5pt; margin: 0 0 9pt; }
main p { margin: 0 0 9pt; }
code { font-family: 'DejaVu Sans Mono', monospace; font-size: 9pt; background: #f2f2f2; padding: 1pt 2pt; }
a { color: #b23a12; text-decoration: none; }
table { font-family: 'Fixture Sans'; font-size: 9pt; border-collapse: collapse; width: 100%; margin: 4pt 0 12pt; }
th, td { text-align: left; padding: 5pt 12pt 5pt 0; border-bottom: 0.5pt solid #ccc; }
ul { margin: 0 0 9pt; padding-left: 16pt; }
li { margin: 0 0 4pt; }
</style></head><body>
<h1>Notes on widget storage</h1>
<p class="lead">Example Co Widgets keeps every widget it sells in one small store. These notes set out how the store is laid out and why it has barely changed.</p>
<img class="hero" alt="" src="${pngDataUrl(120, 40)}">
<div class="grid">
<aside>${side.map(([k, v]) => `<div>${k}</div><div class="v">${v}</div>`).join('')}</aside>
<main>
<p>Each widget has a name, a colour and a size, and the store keeps all three together on a single card. Cards are never rubbed out: a change gets a fresh card with a later date, so anyone can trace a widget back to the day it arrived.</p>
<p>Sorting causes the most arguments. A shelf that puts <strong>blue widgets first</strong> looks tidy in a photo, but the store sorts by <code>widget.sort_key</code> and then by <em>arrival order</em>, which is what the pickers expect. The word “card” always means the paper record. The <a href="https://example.com/widgets/sorting">sorting notes</a> cover the odd cases.</p>
<h2>Widget sizes</h2>
<table><thead><tr><th>Code</th><th>Size</th></tr></thead>
<tbody>${rows.map(([n, r]) => `<tr><td>${n}</td><td>${r}</td></tr>`).join('')}</tbody></table>
<p>Send questions about sizes to <a href="mailto:widget-desk@example.com">the widget desk</a>, which replies within the week.</p>
${LOREM.slice(0, 3).map((t) => `<p>${t}</p>`).join('\n')}
<ul>
<li>Lorem ipsum dolor sit amet, consectetur adipiscing elit.</li>
<li>${LONG_ITEM}</li>
<li>Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur, excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum et dolorum fuga.</li>
<li>Nam libero tempore, cum soluta nobis est eligendi optio cumque nihil impedit quo minus id quod maxime placeat facere possimus.</li>
<li>Temporibus autem quibusdam et aut officiis debitis aut rerum necessitatibus saepe eveniet.</li>
</ul>
<p>${LOREM[3]}</p>
<p>${LOREM[1]}</p>
</main></div>
</body></html>`;
}

function layoutTall() {
    const img = pngDataUrl(90, 60);
    return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Catalogue Setup</title>
<style>
${fontFaces()}
@page { size: 750pt 1087.5pt; margin: 0; }
body { font-family: 'Fixture Sans'; font-size: 10pt; line-height: 1.5; margin: 0; color: #222; }
.banner { background: #0f2340; color: #fff; padding: 26pt 36pt 22pt; }
.banner .label { font-size: 9pt; font-weight: 700; letter-spacing: 1pt; }
.banner h1 { font-size: 24pt; font-weight: 700; margin: 6pt 0 8pt; }
.banner p { margin: 0; font-size: 10.5pt; }
section { padding: 22pt 36pt 0; }
h2 { font-size: 15pt; font-weight: 700; margin: 0 0 10pt; }
h2 span { font-size: 9pt; font-weight: 400; color: #666; margin-left: 8pt; }
.pair { display: grid; grid-template-columns: 1fr 1fr; column-gap: 30pt; }
.k { font-size: 8.5pt; font-weight: 700; color: #1d4f91; letter-spacing: 1pt; margin: 0 0 6pt; }
ol { margin: 0; padding-left: 16pt; }
li { margin: 0 0 4pt; }
.shot { width: 100%; height: 120pt; display: block; }
.cap { font-size: 9pt; color: #555; margin: 6pt 0 0; }
.cols { column-count: 2; column-gap: 30pt; font-family: 'Fixture Serif'; font-size: 10.5pt; }
.cols p { margin: 0 0 8pt; }
.note { font-size: 9pt; color: #777; padding: 18pt 36pt; }
</style></head><body>
<div class="banner"><div class="label">EXAMPLE CO</div><h1>Widget Catalogue Setup</h1>
<p>A short guide for shop staff: add a widget to the catalogue, choose its colours, then check the preview before it goes on sale.</p></div>
<section>
<h2>Garden Widget <span>for outdoor shelves</span></h2>
<div class="pair">
<div><div class="k">BACK OFFICE</div>
<ol><li>Catalogue screen → choose <b>New Widget</b> and type “Garden”</li>
<li>Colours screen → pick a <b>Main Colour</b>, then add up to three spare colours for the window display</li>
<li>Preview → press <b>Check</b> and read the warnings</li></ol></div>
<div><div class="k">SHOP FRONT</div><img class="shot" alt="" src="${img}">
<p class="cap">A green widget with a “Garden” label sits on the top shelf of the shop window.</p></div>
</div>
</section>
<section>
<h2>Background</h2>
<div class="cols">
<p>Alpha column text begins here. ${LOREM[0]}</p>
<p>${LOREM[1]} Alpha column text ends here.</p>
<p>Beta column text begins here. ${LOREM[2]}</p>
<p>${LOREM[3]} Beta column text ends here.</p>
</div>
</section>
<div class="note">Kept by the stock room. Ask a supervisor before changing a colour that is already on sale.</div>
</body></html>`;
}

function slides() {
    const slide = (inner, cls = '') => `<div class="slide ${cls}">${inner}</div>`;
    const bullets = (items) => `<div class="items">${items.map((t) => `<div class="b"><span class="dot">●</span>${t}</div>`).join('')}</div>`;
    return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Slides</title>
<style>
${fontFaces()}
@page { size: 720pt 405pt; margin: 0; }
body { margin: 0; font-family: 'Fixture Sans'; color: #444; }
.slide { width: 720pt; height: 405pt; box-sizing: border-box; padding: 28pt 36pt; page-break-after: always; overflow: hidden; position: relative; }
.title { background: #4a90e2; color: #fff; text-align: center; padding-top: 100pt; }
.title h1 { font-family: 'Fixture Serif'; font-weight: 400; font-size: 46pt; line-height: 1.15; margin: 0 auto; width: 520pt; }
.title p { font-size: 24pt; margin: 14pt 0 0; }
h2 { font-family: 'Fixture Serif'; font-weight: 400; color: #2a7de1; font-size: 26pt; margin: 0 0 10pt; padding-bottom: 8pt; border-bottom: 1pt solid #999; }
.b { font-size: 16pt; line-height: 1.45; }
.dot { display: inline-block; width: 26pt; padding-left: 8pt; font-size: 11pt; vertical-align: 2pt; }
</style></head><body>
${slide('<h1>Example Co Widgets spring review for every shop</h1><p>9th April 2026</p>', 'title')}
${slide('<h2>Spring results</h2>' + bullets(['Sold four hundred garden widgets', 'Opened a second warehouse by the coast', 'Three new colours for the kitchen range', 'Fewer returns after the new boxes. Thanks to the packers', 'Every driver passed the safety course']))}
${slide('<h2>Summer goals</h2>' + bullets(['Launch the folding widget', 'Move the catalogue to the new shelves', 'Train two more drivers', 'Plan the autumn fair']))}
</body></html>`;
}

function taggedFigures() {
    const img = pngDataUrl(80, 40);
    return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Tagged Figures</title>
<style>body { font-family: 'DejaVu Sans', sans-serif; font-size: 11pt; line-height: 1.45; } img { width: 160pt; height: 80pt; display: block; margin: 8pt 0; }
.narrow { width: 70pt; }</style>
</head><body>
<h1>Tagged Figures</h1>
<img alt="" src="${img}">
<p class="narrow">Every non-English page is skipped.</p>
<img alt="Example chart" src="${img}">
${LOREM.map((t) => `<p>${t}</p>`).join('\n')}
<p>${LOREM[2]}</p>
<p>${LOREM[3]}</p>
<ul>
<li>Lorem ipsum dolor sit amet, consectetur adipiscing elit.</li>
<li>${LONG_ITEM}</li>
<li>Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur, excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum et dolorum fuga.</li>
<li>Nam libero tempore, cum soluta nobis est eligendi optio cumque nihil impedit quo minus id quod maxime placeat facere possimus.</li>
<li>Temporibus autem quibusdam et aut officiis debitis aut rerum necessitatibus saepe eveniet.</li>
</ul>
<p>Closing paragraph.</p>
</body></html>`;
}

function codeArticle() {
    const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
    const php = [
        'use ExampleCo\\Widgets\\Shelf\\ShelfOpener;',
        'use ExampleCo\\Widgets\\Model\\Widget;',
        '',
        '$driver = new PaperDriver();',
        '$shelf = ShelfOpener::open(',
        "    room: 'north-wing',",
        "    rack: 'rack-07',",
        '    driver: $driver',
        ');',
        '',
        "$widget = Widget::make('garden-01')",
        "    ->paint(new Colour('green'))",
        "    ->label(new Label('Garden'));",
    ].join('\n');
    return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Widget Kit</title>
<style>
${fontFaces()}
body { font-family: 'Fixture Serif'; font-size: 11pt; line-height: 1.5; margin: 0; color: #222; }
main { width: 330pt; }
h1 { font-family: 'Fixture Sans'; font-size: 24pt; margin: 0 0 10pt; }
h2 { font-family: 'Fixture Sans'; font-size: 14pt; margin: 14pt 0 6pt; }
p { margin: 0 0 9pt; }
pre { font-family: 'DejaVu Sans Mono', monospace; font-size: 8.5pt; line-height: 1.4; background: #f4f4f4; padding: 8pt; margin: 0 0 10pt; }
a { color: #b23a12; text-decoration: none; }
</style></head><body><main>
<h1>Widget Kit</h1>
${LOREM.slice(0, 3).map((t) => `<p>${t}</p>`).join('\n')}
<h2>Getting started</h2>
<p>Add the kit to a project with npm, next to a paper driver for the stock cards:</p>
<pre>npm install @example-co/widget-kit paper-driver</pre>
<p>Next, open a shelf, make a widget and give it a colour:</p>
<pre>${esc(php)}</pre>
<p>Each shop keeps its own shelves and its own driver settings. The <a href="https://example.com/widget-kit/handbook">HANDBOOK</a> lists every shelf option, colour rule and label size.</p>
${LOREM.map((t) => `<p>${t}</p>`).join('\n')}
<p>${LOREM[0]}</p>
</main></body></html>`;
}

const A4 = {paperWidth: 8.27, paperHeight: 11.69, marginLeft: 0.8, marginRight: 0.8};

const FIXTURES = [
    {file: 'code-listing.pdf', html: codeListing(), opts: {
        ...A4, marginTop: 0.9, marginBottom: 0.9, generateTaggedPDF: false, displayHeaderFooter: true,
        headerTemplate: '<div style="font-size:9px;width:100%;text-align:center;font-family:sans-serif">Inventory Service Code Listing</div>',
        footerTemplate: '<div style="font-size:9px;width:100%;text-align:center;font-family:sans-serif">Page <span class="pageNumber"></span> of <span class="totalPages"></span></div>',
    }},
    {file: 'tagged.pdf', html: TAGGED, opts: {...A4, marginTop: 0.8, marginBottom: 0.8, generateTaggedPDF: true}},
    {file: 'rtl.pdf', html: RTL, opts: {...A4, marginTop: 0.8, marginBottom: 0.8, generateTaggedPDF: false}},
    {file: 'rtl-tagged.pdf', html: RTL, opts: {...A4, marginTop: 0.8, marginBottom: 0.8, generateTaggedPDF: true}},
    {file: 'inject-tagged.pdf', html: INJECT, opts: {...A4, marginTop: 0.8, marginBottom: 0.8, generateTaggedPDF: true}},
    {file: 'inject-untagged.pdf', html: INJECT, opts: {...A4, marginTop: 0.8, marginBottom: 0.8, generateTaggedPDF: false}},
    {file: 'article-sidebar.pdf', html: articleSidebar(), opts: {
        ...A4, marginLeft: 0.5, marginRight: 0.5, marginTop: 0.7, marginBottom: 0.7, generateTaggedPDF: false, displayHeaderFooter: true,
        headerTemplate: '<div style="font-size:8px;width:100%;margin:0 36px;display:flex;justify-content:space-between;font-family:sans-serif"><b>Example Co.</b><span>Notes on widget storage</span></div>',
        footerTemplate: '<div style="font-size:7px;width:100%;margin:0 36px;display:flex;justify-content:space-between;font-family:sans-serif"><span>example.com/widgets/storage</span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>',
    }},
    {file: 'layout-tall.pdf', html: layoutTall(), opts: {preferCSSPageSize: true, generateTaggedPDF: false}},
    {file: 'slides.pdf', html: slides(), opts: {preferCSSPageSize: true, generateTaggedPDF: false}},
    {file: 'code-article.pdf', html: codeArticle(), opts: {
        ...A4, marginTop: 0.7, marginBottom: 0.7, generateTaggedPDF: false, displayHeaderFooter: true,
        headerTemplate: '<div></div>',
        footerTemplate: '<div style="font-size:7px;width:100%;margin:0 36px;display:flex;justify-content:space-between;font-family:sans-serif"><span>example.com/kits/widget-kit</span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>',
    }},
    {file: 'tagged-figures.pdf', html: taggedFigures(), opts: {...A4, marginTop: 0.8, marginBottom: 0.8, generateTaggedPDF: true}},
];

async function connect(port) {
    let wsUrl;
    for (let i = 0; i < 80 && !wsUrl; i++) {
        try {
            const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
            wsUrl = (list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl) || {}).webSocketDebuggerUrl;
        } catch (_e) { /* not up yet */ }
        if (!wsUrl) await sleep(250);
    }
    if (!wsUrl) throw new Error('no DevTools page target');
    const ws = new WebSocket(wsUrl);
    let id = 1;
    const pending = new Map();
    const events = [];
    ws.addEventListener('message', (ev) => {
        const m = JSON.parse(ev.data);
        if (m.id && pending.has(m.id)) {
            const {res, rej} = pending.get(m.id);
            pending.delete(m.id);
            if (m.error) rej(new Error(m.error.message)); else res(m.result);
        } else if (m.method) {
            events.push(m.method);
        }
    });
    await new Promise((res, rej) => {
        ws.addEventListener('open', res, {once: true});
        ws.addEventListener('error', () => rej(new Error('DevTools socket error')), {once: true});
    });
    const send = (method, params = {}) => new Promise((res, rej) => {
        const n = id++;
        pending.set(n, {res, rej});
        ws.send(JSON.stringify({id: n, method, params}));
    });
    return {send, events, close: () => ws.close()};
}

const browser = await launchChrome('about:blank');
try {
    const cdp = await connect(browser.port);
    await cdp.send('Page.enable');
    const only = process.argv.slice(2);   // e.g. `node build-pdfs.mjs rtl.pdf` rebuilds just that one
    for (const f of FIXTURES.filter((x) => !only.length || only.includes(x.file))) {
        cdp.events.length = 0;
        await cdp.send('Page.navigate', {url: 'data:text/html;charset=utf-8,' + encodeURIComponent(f.html)});
        for (let i = 0; i < 40 && !cdp.events.includes('Page.loadEventFired'); i++) await sleep(100);
        await sleep(300);   // web fonts
        const {data} = await cdp.send('Page.printToPDF', {printBackground: true, ...f.opts});
        const buf = Buffer.from(data, 'base64');
        writeFileSync(join(here, f.file), buf);
        console.log(`wrote ${f.file} (${buf.length} bytes)`);
    }
    cdp.close();
} finally {
    await browser.stop();
}
