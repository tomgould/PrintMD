/**
 * Page control (README, Export: Page options): custom page sizes, the one continuous
 * page layout, fit to size and the margin override, as plain data. Every value is
 * parsed to numbers and a unit from an allow-list and written back by the code, so
 * nothing a person, a stored record, an API request or front matter sends reaches the
 * print CSS as text. The laid-out PDFs are checked by server/test/page-control.test.mjs,
 * the measuring step by tests/page-layout.test.html and the editor by
 * tests/page-options-app.test.html.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
    CUSTOM_SIZE, DOC_EXPORT_KEYS, DOC_EXPORT_MAX_JSON, FITS, LAYOUTS, PAGE_LIMITS, PAGE_UNITS, docExportOpts,
    formatCustomSize, frontMatterPageOpts, marginMm, normalizeExportOpts, pageBoxMm, pageOptsProblem, parseCustomSize,
    validMargin,
} from '../js/export-options.js';
import {buildPageCss, buildPrintDocument} from '../js/print-document.js';
import {buildRunningCss, normalizeRunning} from '../js/page-chrome.js';
import {layoutViewportPx, printContentWidthPx} from '../js/image-check.js';
import {parseFrontMatter} from '../js/doc-meta.js';

/** Values that must never get through anywhere: CSS breakouts, functions, odd numbers. */
const HOSTILE = [
    '100x150mm;', '100x150mm }', '100x150mm; } body { display:none', '100x150mm\n}', 'url(x)', 'calc(100mm)x150mm',
    '100x150mm calc(1px)', 'var(--w)x150mm', 'expression(alert(1))', '100x150mm/*', '1e3x150mm', '0x1000mm', '-100x150mm',
    '100x-150mm', '100x150', '100x150 furlongs', 'x150mm', '100xmm', 'NaNxNaNmm', 'Infinityx100mm', '100x150mm!important',
    '１００x150mm', '100x150mmm', '100.1234x150mm', '123456x150mm', '100x150 mm', '<style>', '', ' ', null, 42, {}, [],
    '__proto__', 'toString', 'Custom',
];

test('custom size: width x height in mm, cm, in or px, written back in its canonical form', () => {
    assert.deepEqual([...PAGE_UNITS], ['mm', 'cm', 'in', 'px']);
    assert.deepEqual(parseCustomSize('100x150mm'), {width: 100, height: 150, unit: 'mm', widthMm: 100, heightMm: 150});
    assert.deepEqual(parseCustomSize('8.5x11in'), {width: 8.5, height: 11, unit: 'in', widthMm: 215.9, heightMm: 279.4});
    const px = parseCustomSize('1200x800px');
    assert.equal(px.widthMm, 317.5);
    assert.ok(Math.abs(px.heightMm - 211.667) < 0.001, String(px.heightMm));
    assert.deepEqual(parseCustomSize('10 x 15 cm'), {width: 10, height: 15, unit: 'cm', widthMm: 100, heightMm: 150}, 'spaces are allowed');
    assert.deepEqual(parseCustomSize('100X150MM'), parseCustomSize('100x150mm'), 'any case');
    assert.deepEqual(parseCustomSize('100×150mm'), parseCustomSize('100x150mm'), 'the times sign');
    assert.equal(formatCustomSize(parseCustomSize(' 100.50 X 150.000 MM ')), '100.5x150mm');
    assert.equal(formatCustomSize(parseCustomSize('1200x800px')), '1200x800px');
    assert.equal(formatCustomSize({width: 100, height: 150, unit: 'mm; }'}), null, 'only allow-listed units are written');
    assert.equal(formatCustomSize({width: '100', height: 150, unit: 'mm'}), null, 'numbers only');
});

test('custom size: each side between the limits, and the area capped', () => {
    assert.equal(PAGE_LIMITS.minSideMm, 30);
    assert.equal(PAGE_LIMITS.maxSideMm, 5080);
    assert.ok(parseCustomSize('30x30mm'), 'the smallest page');
    assert.equal(parseCustomSize('29.9x100mm'), null);
    assert.equal(parseCustomSize('100x29.9mm'), null);
    assert.ok(parseCustomSize('200x1000in') === null, 'over 5080 mm a side');
    assert.ok(parseCustomSize('5080x210mm'), 'one long side');
    assert.ok(parseCustomSize('19200x700px'), '200 in of px');
    assert.equal(parseCustomSize('19201x700px'), null);
    assert.equal(parseCustomSize('5080x5080mm'), null, 'the area cap');
    assert.ok(PAGE_LIMITS.maxAreaMm2 >= 1189 * 1682, 'A0 twice over fits');
    for (const v of HOSTILE) assert.equal(parseCustomSize(v), null, `rejected: ${JSON.stringify(v)}`);
});

test('margin: mm, cm, in or pt up to about 100 mm, 0 allowed, written back by the code', () => {
    for (const [given, out] of [['0', '0mm'], ['0mm', '0mm'], ['12mm', '12mm'], ['12.50mm', '12.5mm'], ['1.5cm', '1.5cm'],
        ['0.75in', '0.75in'], ['36pt', '36pt'], ['100mm', '100mm'], ['4in', '4in']]) {
        assert.equal(validMargin(given), out, given);
    }
    for (const bad of ['101mm', '-1mm', '10%', 'auto', '20 mm', '20px', '20', '0 ', '1e1mm', '20mm;', '20mm } body {',
        'calc(20mm)', 'var(--m)', 'expression(1)', 'url(x)', '', null, 7, {}]) {
        assert.equal(validMargin(bad), null, `rejected: ${JSON.stringify(bad)}`);
    }
    assert.equal(marginMm('2cm'), 20);
    assert.equal(marginMm('0.5in'), 12.7);
    assert.equal(marginMm('72pt'), 25.4);
    assert.equal(marginMm('nonsense'), 0);
});

test('normalizeExportOpts: the defaults are unchanged, with layout paged and fit off', () => {
    assert.deepEqual([...LAYOUTS], ['paged', 'continuous']);
    assert.deepEqual([...FITS], ['off', 'width', 'widest']);
    assert.deepEqual(normalizeExportOpts({}), {format: 'pdf', pageSize: 'A4', orientation: 'portrait', margin: '20mm', layout: 'paged', fit: 'off'});
    assert.deepEqual(normalizeExportOpts(undefined), normalizeExportOpts({}));
    for (const v of HOSTILE) {
        const o = normalizeExportOpts({pageSize: v, customSize: v, layout: v, fit: v, margin: v});
        assert.deepEqual(o, normalizeExportOpts({}), `hostile: ${JSON.stringify(v)}`);
    }
});

test('normalizeExportOpts: a custom size from pageSize (API, front matter) or from Custom plus customSize (the editor)', () => {
    const a = normalizeExportOpts({pageSize: '100x150mm', orientation: 'landscape'});
    assert.equal(a.pageSize, CUSTOM_SIZE);
    assert.equal(a.customSize, '100x150mm');
    assert.deepEqual(pageBoxMm(a), {width: 100, height: 150}, 'the orientation does not turn a custom size');
    const b = normalizeExportOpts({pageSize: 'Custom', customSize: '8.5x11in'});
    assert.equal(b.customSize, '8.5x11in');
    assert.deepEqual(pageBoxMm(b), {width: 215.9, height: 279.4});
    assert.equal(normalizeExportOpts({pageSize: 'Custom'}).pageSize, 'A4', 'Custom without a size falls back');
    assert.equal(normalizeExportOpts({pageSize: 'Custom', customSize: 'bad'}).pageSize, 'A4');
    assert.equal(normalizeExportOpts({pageSize: 'A3', customSize: '100x150mm'}).customSize, undefined, 'a named size has no custom size');
    // Custom sizes are allowed with every template: the template's sizes only limit the named ones.
    assert.equal(normalizeExportOpts({pageSize: '100x150mm'}, {sizes: ['Slide']}).pageSize, CUSTOM_SIZE);
    assert.deepEqual(pageBoxMm(normalizeExportOpts({pageSize: 'A4', orientation: 'landscape'})), {width: 297, height: 210});
});

test('normalizeExportOpts: layout, fit and margin; widest needs the continuous layout', () => {
    const o = normalizeExportOpts({layout: 'continuous', fit: 'widest', margin: '0'});
    assert.equal(o.layout, 'continuous');
    assert.equal(o.fit, 'widest');
    assert.equal(o.margin, '0mm');
    assert.equal(normalizeExportOpts({fit: 'widest'}).fit, 'width', 'paged: widest means fit width');
    assert.equal(normalizeExportOpts({fit: 'width'}).fit, 'width');
    assert.equal(normalizeExportOpts({margin: '12mm'}, {margin: '20mm'}).margin, '12mm', 'the override wins over the template');
    assert.equal(normalizeExportOpts({}, {margin: '24mm'}).margin, '24mm', 'no override: the template margin');
    assert.equal(normalizeExportOpts({layout: 'CONTINUOUS'}).layout, 'paged', 'exact values only');
});

test('pageOptsProblem: a margin that leaves less than the smallest text column is named', () => {
    assert.equal(pageOptsProblem(normalizeExportOpts({})), null);
    assert.equal(PAGE_LIMITS.minContentMm, 20);
    assert.match(pageOptsProblem(normalizeExportOpts({pageSize: '50x100mm', margin: '20mm'})), /margin/);
    assert.equal(pageOptsProblem(normalizeExportOpts({pageSize: '60x60mm', margin: '20mm'})), null, '20 mm left each way');
    assert.match(pageOptsProblem(normalizeExportOpts({pageSize: '100x50mm', margin: '20mm'})), /margin/, 'paged: the height counts');
    assert.equal(pageOptsProblem(normalizeExportOpts({pageSize: '100x50mm', margin: '20mm', layout: 'continuous'})), null,
        'continuous: only the width counts');
});

test('docExportOpts: each document keeps its custom size, layout, fit and margin, cleaned', () => {
    assert.deepEqual([...DOC_EXPORT_KEYS], ['format', 'pageSize', 'orientation', 'customSize', 'layout', 'fit', 'margin']);
    const kept = {format: 'pdf', pageSize: 'Custom', orientation: 'portrait', customSize: '100x150mm', layout: 'continuous', fit: 'widest', margin: '0mm'};
    assert.deepEqual(docExportOpts(kept), kept);
    assert.deepEqual(docExportOpts({customSize: '100.50x150mm', margin: '0'}), {customSize: '100.5x150mm', margin: '0mm'},
        'stored in the canonical form');
    for (const v of HOSTILE) {
        assert.deepEqual(docExportOpts({customSize: v, layout: v, fit: v, margin: v}), {}, `hostile: ${JSON.stringify(v)}`);
    }
    const widest = {format: 'docx', pageSize: 'Custom', orientation: 'landscape', customSize: '19199.999x2083.333px',
        layout: 'continuous', fit: 'widest', margin: '99.999mm'};
    assert.equal(DOC_EXPORT_MAX_JSON, 256, 'the cap is unchanged');
    assert.ok(JSON.stringify(docExportOpts(widest)).length <= DOC_EXPORT_MAX_JSON, JSON.stringify(docExportOpts(widest)));
    assert.equal(Object.keys(docExportOpts(widest)).length, 7, 'the widest valid record keeps every key');
});

test('front matter: page-size, layout, fit and margin, each checked; a bad one is a warning and ignored', () => {
    const src = '---\npage-size: 100 x 150 mm\nlayout: continuous\nfit: widest\nmargin: 12mm\n---\n# Hi\n';
    const {opts, warnings} = frontMatterPageOpts(parseFrontMatter(src).meta);
    assert.deepEqual(opts, {pageSize: '100x150mm', layout: 'continuous', fit: 'widest', margin: '12mm'});
    assert.deepEqual(warnings, []);
    assert.deepEqual(frontMatterPageOpts(parseFrontMatter('---\npage-size: a3\n---\nx').meta).opts, {pageSize: 'A3'}, 'a named size, any case');
    const bad = frontMatterPageOpts(parseFrontMatter('---\npage-size: 100x150mm; }\nlayout: sideways\nfit: url(x)\nmargin: 20mm;}\n---\nx').meta);
    assert.deepEqual(bad.opts, {});
    assert.equal(bad.warnings.length, 4, bad.warnings.join(' | '));
    for (const w of bad.warnings) assert.ok(!/[;{}]|url/.test(w), `the warning never quotes the value: ${w}`);
    assert.deepEqual(frontMatterPageOpts(parseFrontMatter('# none').meta), {opts: {}, warnings: []});
});

test('@page: a custom size in mm, written from numbers; the named sizes exactly as before', () => {
    assert.ok(buildPageCss(normalizeExportOpts({pageSize: '1200x800px'})).startsWith('@page { size: 317.5mm 211.667mm; margin: 20mm; }'));
    assert.ok(buildPageCss({pageSize: 'Custom', customSize: '4x6in', margin: '0.25in'}).startsWith('@page { size: 101.6mm 152.4mm; margin: 0.25in; }'));
    assert.ok(buildPageCss({}).startsWith('@page { size: A4 portrait; margin: 20mm; }'));
    for (const v of HOSTILE) {
        const css = buildPageCss({pageSize: v, customSize: v, layout: v, fit: v, margin: v});
        assert.ok(css.startsWith('@page { size: A4 portrait; margin: 20mm; }'), css);
        assert.ok(!/display|url|calc\(1|var\(--w|expression|furlong|!important/.test(css), css);
    }
});

test('@page: the continuous layout is one page with no margin; the margin becomes the body page\'s padding', () => {
    const css = buildPageCss(normalizeExportOpts({layout: 'continuous', margin: '12mm'}), {cover: true, background: '#123456'});
    assert.match(css, /@page \{ size: 210mm 297mm; margin: 0; \}/, 'a starting height the layout step replaces');
    assert.ok(!css.includes('@page :first'), 'no cover page of its own');
    assert.match(css, /\.bd-page:not\(\.bd-page-cover\) \{[^}]*padding: 12mm;/);
    assert.match(css, /\.bd-page:not\(\.bd-page-cover\) \{[^}]*background: #123456;/, 'the canvas colour on the body block');
    assert.ok(!/@page \{ background/.test(css), 'not on the page, or the cover would get it');
    assert.match(css, /break-before: auto !important/, 'manual page breaks are ignored');
    assert.match(css, /break-after: auto !important/);
    // A heading still keeps with what follows when a long document is split.
    const keep = css.indexOf('h1, h2, h3, h4, h5, h6 { break-after: avoid !important; page-break-after: avoid !important; }');
    assert.ok(keep > css.indexOf('break-after: auto !important'), 'after the reset: ' + css);
});

test('print document: a manual page break and the running head are gone in the continuous layout', () => {
    const running = normalizeRunning({runningHead: {left: '{title}'}, runningFoot: {right: '{page} of {pages}'}});
    const html = buildPrintDocument({title: 'T', templateId: 'x', bodyHTML: '<p>a</p><div style="page-break-after: always"></div><p>b</p>',
        pageOpts: {layout: 'continuous'}, running});
    assert.ok(!html.includes('@top-left') && !html.includes('@bottom-right'), 'no margin boxes');
    assert.ok(html.includes('page-break-after: auto !important'));
    const paged = buildPrintDocument({title: 'T', templateId: 'x', bodyHTML: '<p>a</p>', pageOpts: {}, running});
    assert.ok(paged.includes('@top-left'), 'paged keeps them');
});

test('running head and foot: they follow a custom page width and stay off when the margin is under 18 mm', () => {
    const running = normalizeRunning({runningHead: {left: '{title}'}});
    assert.equal(buildRunningCss(running, {title: 'T'}, {pageOpts: {margin: '12mm'}}), '');
    assert.notEqual(buildRunningCss(running, {title: 'T'}, {pageOpts: {margin: '18mm'}}), '');
    assert.equal(buildRunningCss(running, {title: 'T'}, {pageOpts: {layout: 'continuous'}}), '');
    // The slot is cut to the characters its width holds: a narrow custom page holds fewer.
    const long = {title: 'A long title that goes on and on for a good many words'};
    const narrow = buildRunningCss(running, long, {pageOpts: {pageSize: '80x120mm', margin: '18mm'}});
    const wide = buildRunningCss(running, long, {pageOpts: {margin: '18mm'}});
    assert.ok(narrow.length < wide.length, 'the narrow page cuts more');
});

test('the text column and the layout width follow the custom size, the margin and the layout', () => {
    const px = (mm) => (mm * 96) / 25.4;
    assert.ok(Math.abs(printContentWidthPx(normalizeExportOpts({pageSize: '100x150mm', margin: '10mm'})) - px(80)) < 0.01);
    assert.ok(Math.abs(layoutViewportPx(normalizeExportOpts({pageSize: '100x150mm', margin: '10mm'})) - px(80)) < 0.01, 'paged: the column');
    assert.ok(Math.abs(layoutViewportPx(normalizeExportOpts({pageSize: '100x150mm', margin: '10mm', layout: 'continuous'})) - px(100)) < 0.01,
        'continuous: the page, whose padding is the margin');
});
