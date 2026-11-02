/**
 * The template platform (README, Template contract): the 16:9 Slide page size,
 * a template's page background, the running head and foot in the page margins
 * (js/page-chrome.js), the subject on the cover, the vendored font set and the
 * picker groups. Pure functions only; the PDFs are checked by
 * server/test/template-platform.test.mjs and the editor by
 * tests/template-platform.test.html, both with the test-only fixture template
 * tests/fixtures/platform-fixture/template.js.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
    PAGE_SIZES, PAPER_SIZES, ORIENTATIONS, pageDimensionsMm, normalizeExportOpts, validPageBackground, templatePageSizes,
    templatePageDefaults,
} from '../js/export-options.js';
import {buildPageCss, buildPrintDocument} from '../js/print-document.js';

// ─── Slide page size ─────────────────────────────────────────────────────────

test('Slide: a 16:9 page of 254 x 142.9 mm, always landscape', () => {
    assert.ok(PAGE_SIZES.includes('Slide'));
    assert.deepEqual(pageDimensionsMm('Slide', 'landscape'), {width: 254, height: 142.9});
    assert.deepEqual(pageDimensionsMm('Slide', 'portrait'), {width: 254, height: 142.9}, 'portrait is not offered');
    assert.equal(normalizeExportOpts({pageSize: 'Slide', orientation: 'portrait'}).orientation, 'landscape');
    assert.equal(normalizeExportOpts({pageSize: 'Slide'}).orientation, 'landscape');
    assert.equal(normalizeExportOpts({pageSize: 'A4', orientation: 'portrait'}).orientation, 'portrait', 'other sizes keep theirs');
    assert.deepEqual([...ORIENTATIONS], ['portrait', 'landscape']);
});

test('Slide: @page takes the size in mm, and the page variables follow it', () => {
    const css = buildPageCss({pageSize: 'Slide', orientation: 'portrait', margin: '14mm'});
    assert.ok(css.includes('@page { size: 254mm 142.9mm; margin: 14mm; }'), css);
    assert.ok(css.includes('--bd-page-width: 254mm; --bd-page-height: 142.9mm;'), css);
    assert.ok(css.includes('--bd-page-content-height: calc(142.9mm - 2 * 14mm)'), css);
});

test('Slide only for a template that lists it in manifest.page.sizes; others fall back to A4', () => {
    assert.deepEqual([...templatePageSizes({page: {margin: '20mm'}})], [...PAPER_SIZES]);
    assert.deepEqual([...templatePageSizes(undefined)], [...PAPER_SIZES]);
    assert.deepEqual([...templatePageSizes({page: {sizes: ['Slide', 'A4', 'Tabloid', 'Slide', 7]}})], ['Slide', 'A4']);
    assert.deepEqual([...templatePageSizes({page: {sizes: ['Tabloid']}})], [...PAPER_SIZES], 'nothing known: the paper sizes');
    assert.ok(!PAPER_SIZES.includes('Slide'));
    const paper = templatePageSizes({page: {}});
    assert.deepEqual(normalizeExportOpts({pageSize: 'Slide', orientation: 'portrait'}, {sizes: paper}),
        {format: 'pdf', pageSize: 'A4', orientation: 'portrait', margin: '20mm', layout: 'paged', fit: 'off'});
    assert.equal(normalizeExportOpts({pageSize: 'Letter'}, {sizes: ['Slide']}).pageSize, 'Slide', 'the first offered when A4 is not');
    assert.equal(normalizeExportOpts({pageSize: 'Slide'}, {sizes: ['Slide', 'A4']}).pageSize, 'Slide');
    assert.equal(normalizeExportOpts({}, {sizes: ['Slide', 'A4']}).pageSize, 'A4', 'A4 stays the default');
});

test('default page: defaultSize (one of the template\'s own sizes) and defaultOrientation, else nothing', () => {
    const deck = {page: {sizes: ['Slide', 'A4', 'Letter'], defaultSize: 'Slide', defaultOrientation: 'landscape'}};
    assert.deepEqual(templatePageDefaults(deck), {pageSize: 'Slide', orientation: 'landscape'});
    assert.deepEqual(templatePageDefaults({page: {margin: '20mm'}}), {}, 'none named: none');
    assert.deepEqual(templatePageDefaults(undefined), {});
    assert.deepEqual(templatePageDefaults({page: {defaultSize: 'Slide'}}), {}, 'Slide is not among the paper sizes');
    assert.deepEqual(templatePageDefaults({page: {sizes: ['A4'], defaultSize: 'Letter', defaultOrientation: 'sideways'}}), {});
    assert.deepEqual(templatePageDefaults({page: {defaultSize: 'A3'}}), {pageSize: 'A3'}, 'the paper sizes when none are listed');
    assert.deepEqual(templatePageDefaults({page: {defaultOrientation: 'landscape'}}), {orientation: 'landscape'});
});

test('default page: used only for what is not chosen; an explicit choice always wins', () => {
    const fb = {sizes: ['Slide', 'A4', 'Letter'], pageSize: 'Slide', orientation: 'landscape', margin: '18mm'};
    const pick = (opts) => {
        const {pageSize, orientation} = normalizeExportOpts(opts, fb);
        return `${pageSize} ${orientation}`;
    };
    assert.equal(pick({}), 'Slide landscape');
    assert.equal(pick({pageSize: 'A4'}), 'A4 landscape', 'the size chosen, the default orientation');
    assert.equal(pick({pageSize: 'A4', orientation: 'portrait'}), 'A4 portrait');
    assert.equal(pick({orientation: 'portrait'}), 'A4 portrait', 'portrait chosen: not the landscape-only default size');
    assert.equal(pick({orientation: 'landscape'}), 'Slide landscape');
    assert.equal(pick({pageSize: 'Legal'}), 'Slide landscape', 'a size not offered falls back to the default');
    // Without defaults nothing changes.
    assert.deepEqual(normalizeExportOpts({}, {sizes: templatePageSizes({page: {}})}),
        {format: 'pdf', pageSize: 'A4', orientation: 'portrait', margin: '20mm', layout: 'paged', fit: 'off'});
});

test('the named sizes print exactly as before (the four existing templates keep their PDFs)', () => {
    assert.equal(buildPageCss(), [
        '@page { size: A4 portrait; margin: 20mm; }',
        ':root { --bd-page-width: 210mm; --bd-page-height: 297mm; --bd-page-content-height: calc(297mm - 2 * 20mm); }',
    ].join('\n'));
    assert.equal(buildPageCss({pageSize: 'Letter', orientation: 'landscape', margin: '22mm'}, {cover: true}), [
        '@page { size: Letter landscape; margin: 22mm; }',
        '@page :first { margin: 0; }',
        ':root { --bd-page-width: 279.4mm; --bd-page-height: 215.9mm; --bd-page-content-height: calc(215.9mm - 2 * 22mm); }',
    ].join('\n'));
});

// ─── Page background ─────────────────────────────────────────────────────────

test('page background: a colour (hex, rgb(a), hsl(a), named) or nothing', () => {
    for (const ok of ['#1d1815', '#EADFD3', '#fff', '#1d1815cc', '#fffa', 'rgb(29, 24, 21)', 'rgba(29,24,21,0.9)', 'rgb(29 24 21 / 90%)',
        'hsl(25, 16%, 10%)', 'hsla(25 16% 10% / .5)', 'hsl(25deg 16% 10%)', 'black', 'Navy', 'transparent', '  #000  ']) {
        assert.equal(validPageBackground(ok), ok.trim().toLowerCase(), ok);
    }
    for (const bad of ['', 'nosuchcolour', '#12345', '#1234567', '#1d1815; } body { display: none', 'url(x)', 'url(data:,x)',
        'var(--x)', 'calc(1px)', 'rgb(0,0,0); x', 'rgb(0,0,var(--x))', 'color-mix(in srgb, red, blue)', 'expression(alert(1))',
        'linear-gradient(red, blue)', 'red blue', 'rgb(1,2)', 'hsl(1, 2, 3)', 'red}', 'x'.repeat(65), null, 42, {}]) {
        assert.equal(validPageBackground(bad), null, String(bad));
    }
});

test('page background: @page fills the body pages, the cover keeps none, the printed body is see-through; without one nothing changes', () => {
    const css = buildPageCss({}, {background: '#1d1815'});
    assert.ok(css.includes('@page { background: #1d1815; }'), css);
    assert.ok(buildPageCss({}, {background: '#1d1815', cover: true}).includes('@page :first { margin: 0; background: none; }'), 'cover unaffected');
    assert.ok(buildPageCss({}, {cover: true}).includes('@page :first { margin: 0; }'), 'without a colour the cover rule is as before');
    assert.equal(buildPageCss({}, {background: 'red; } x {'}), buildPageCss(), 'a bad colour is ignored');
    const dark = buildPrintDocument({bodyHTML: '<p>x</p>', pageBackground: '#1d1815'});
    assert.ok(dark.includes('body { background: transparent; }'), 'printed body lets the page colour through');
    assert.ok(dark.includes('.bd-page:not(.bd-page-cover) { background: #1d1815;'), 'screen page card');
    const plain = buildPrintDocument({bodyHTML: '<p>x</p>'});
    assert.ok(plain.includes('body { background: #fff; }') && !plain.includes('@page { background'), 'default white');
    assert.equal(buildPrintDocument({bodyHTML: '<p>x</p>', pageBackground: 'nope'}), plain, 'a bad colour changes nothing');
});

// ─── Fonts for the new templates ─────────────────────────────────────────────

const fonts = await import('../js/fonts.js');
const {isVendoredFontName} = await import('../server/qa/pdf-qa.mjs');
const {readFileSync, statSync} = await import('node:fs');

const NEW_FAMILIES = ['Figtree', 'Fraunces', 'Schibsted Grotesk', 'Libre Caslon Text', 'Plus Jakarta Sans', 'IBM Plex Sans', 'Lora',
    'DM Sans'];

test('fonts: the new families are vendored, OFL 1.1, and picked up by the font check and pdf-qa from FONT_FAMILIES', () => {
    for (const family of NEW_FAMILIES) assert.ok(fonts.FONT_FAMILIES.includes(family), family);
    const dirs = new Set(fonts.FONT_FACES.filter((f) => NEW_FAMILIES.includes(f.family)).map((f) => f.file.split('/')[0]));
    for (const dir of dirs) {
        assert.match(readFileSync(new URL(`../vendor/fonts/${dir}/OFL.txt`, import.meta.url), 'utf8'), /Version 1\.1 - 26 February 2007/, dir);
    }
});

test('fonts: no synthesised bold italic (a Type 3 font): each family\'s italics are declared for every weight', () => {
    for (const family of fonts.FONT_FAMILIES) {
        const italics = fonts.FONT_FACES.filter((f) => f.family === family && f.style === 'italic' && f.subset !== 'latin-ext');
        if (!italics.length || !NEW_FAMILIES.includes(family)) continue;
        const covered = new Set();
        for (const f of italics) {
            const [lo, hi = lo] = String(f.weightRange || f.weight).split(' ').map(Number);
            for (let w = 100; w <= 900; w += 100) if (w >= lo && w <= hi) covered.add(w);
        }
        assert.equal(covered.size, 9, `${family} italics cover 100 to 900: ${[...covered]}`);
    }
});

test('fonts: the added files stay within budget (about 1.1 MB, each fetched only by a template that names it)', () => {
    const files = new Set(fonts.FONT_FACES.filter((f) => NEW_FAMILIES.includes(f.family) || (f.family === 'Inter' && f.style === 'italic'))
        .map((f) => f.file));
    const bytes = [...files].reduce((n, file) => n + statSync(new URL(`../vendor/fonts/${file}`, import.meta.url)).size, 0);
    assert.ok(bytes < 1200 * 1024, `${Math.round(bytes / 1024)} KB`);
});

test('pdf-qa vendored-fonts: matched by family prefix, so Fontsource names such as FigtreeLight-Bold pass and system fonts fail', () => {
    for (const name of ['FigtreeLight-Bold', 'FigtreeLight-Italic', 'DMSans9pt-Regular', 'Fraunces72pt-SemiBold', 'IBMPlexSans-Italic',
        'PlusJakartaSans-ExtraBold', 'LibreCaslonText-Italic', 'SchibstedGrotesk-Bold', 'Lora-Medium', 'Inter-Italic', 'MontserratThin-Bold',
        'SourceCodePro-It', 'NotoSansSymbols2-Regular']) {
        assert.ok(isVendoredFontName(name), name);
    }
    for (const name of ['DejaVuSans', 'LiberationSans-Bold', 'Helvetica', 'ArialMT', 'NotoColorEmoji', 'Figtre', '']) {
        assert.ok(!isVendoredFontName(name), name);
    }
    assert.ok(!isVendoredFontName('FigtreeLight-Bold', ['Montserrat']), 'only the families given');
});

// ─── Running head and foot (js/page-chrome.js) ───────────────────────────────

const chrome = await import('../js/page-chrome.js');
const {cssString, normalizeRunning, buildRunningCss, runningFontProbe, RUNNING_LIMITS} = chrome;

const TEMPLATE = {
    runningHead: {left: '{author}', right: '{title}'},
    runningFoot: {left: 'example.org', right: 'Page {page} of {pages}'},
    runningStyle: {fontFamily: 'Inter', fontSize: 8, fontWeight: 500, color: '#5B6673'},
};
const VALUES = {title: 'Quarterly plan', author: 'Jo Bloggs', date: '1 November 2026', subject: 'Plans'};
const A4 = {pageSize: 'A4', orientation: 'portrait', margin: '20mm'};
const run = (tpl = TEMPLATE, values = VALUES, layout = {pageOpts: A4, cover: true}) => buildRunningCss(normalizeRunning(tpl), values, layout);
const LINE_SEP = String.fromCharCode(0x2028);
const ELLIPSIS = String.fromCharCode(0x2026);

/** The text a CSS string literal holds, escapes undone. */
function unCss(literal) {
    assert.match(literal, /^"(?:[^"\\\n]|\\[0-9a-f]{1,6} ?|\\[^0-9a-f\n])*"$/i, `one well-formed CSS string: ${literal}`);
    return literal.slice(1, -1).replace(/\\([0-9a-f]{1,6}) ?/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)));
}

/** Each margin box of an @page block: {box, decls}. */
function boxesOf(css) {
    return [...css.matchAll(/(@(?:top|bottom)-(?:left|center|right)) \{ (.*?) \}$/gm)].map((m) => ({box: m[1], decls: m[2]}));
}

test('cssString: quotes, backslashes, < > & and controls can never leave the string or the style element', () => {
    const hostile = `A"; } body { display: none } @top-left { content: "x\\" </style><script>alert(1)</script> \u0000\u001f${LINE_SEP}&'`;
    const lit = cssString(hostile);
    assert.ok(!/[<>&']/.test(lit) && !/[\u0000-\u001f]/.test(lit) && !lit.includes(LINE_SEP), lit);
    assert.equal((lit.match(/"/g) || []).length, 2, 'only the delimiting quotes');
    assert.equal(unCss(lit), hostile.replace(/[\u0000-\u001f]/g, ' ').split(LINE_SEP).join(' '));
    assert.equal(cssString('café Łódź'), '"café Łódź"', 'letters stay as they are');
    assert.equal(cssString(null), '""');
});

test('normalizeRunning: nothing without a head, foot or logo; only known slots, short text, checked style', () => {
    assert.equal(normalizeRunning(null), null);
    assert.equal(normalizeRunning({id: 'x'}), null);
    assert.equal(normalizeRunning({runningHead: {middle: 'x', left: '   '}}), null, 'unknown and empty slots dropped');
    const r = normalizeRunning({
        runningHead: {left: 'L'.repeat(500), right: 'a\nb\tc'},
        runningStyle: {fontFamily: 'Comic Sans MS', fontSize: 30, fontWeight: 450, color: 'red; x', fontStyle: 'oblique'},
        runningLogo: {src: 'data:image/png;base64,AAAA', slot: 'nowhere', height: 99},
    });
    assert.equal(Array.from(r.head.left).length, RUNNING_LIMITS.textMax);
    assert.equal(r.head.right, 'a b c');
    assert.deepEqual(r.style, {fontFamily: 'Inter', fontSize: 8, fontWeight: 400, fontStyle: 'normal', color: '#5b6673'}, 'defaults replace bad values');
    assert.deepEqual(r.logo, {src: 'data:image/png;base64,AAAA', slot: 'foot-right', height: 5});
    assert.equal(normalizeRunning({runningStyle: {}, runningFoot: {center: 'x'}}).style.fontFamily, 'Inter');
    assert.equal(normalizeRunning({runningFoot: {center: 'x'}, runningStyle: {fontFamily: 'Montserrat', fontSize: '9pt'}}).style.fontSize, 9);
});

test('buildRunningCss: tokens become escaped strings and the page counters', () => {
    const css = run();
    const boxes = boxesOf(css);
    const body = boxes.filter((b) => !b.decls.startsWith('content: none'));
    assert.deepEqual(body.map((b) => b.box), ['@top-left', '@top-right', '@bottom-left', '@bottom-right']);
    const content = (box) => /content: (.*?); width/.exec(body.find((b) => b.box === box).decls)[1];
    assert.equal(unCss(content('@top-left')), 'Jo Bloggs');
    assert.equal(unCss(content('@top-right')), 'Quarterly plan');
    assert.equal(content('@bottom-right'), '"Page " counter(page) " of " counter(pages)');
    assert.match(css, /font-family: 'Inter', 'Source Code Pro Symbols', 'Noto Sans Symbols 2', 'Noto Sans Symbols', sans-serif;/);
    assert.match(css, /color: #5b6673;/);
    for (const b of body) assert.match(b.decls, /width: 50%;/, 'two slots share the row');
    const hostile = run({runningHead: {center: '{title} by {author}'}}, {title: '"; } @page { margin: 0 } </style>', author: 'x\\'});
    const lit = /content: ("(?:[^"\\]|\\[0-9a-f]+ ?)*")/.exec(hostile)[1];
    assert.ok(!/<|>/.test(hostile) && !/margin: 0 \}/.test(hostile.replace(/\\[0-9a-f]+ /g, '')), hostile);
    assert.ok(unCss(lit).startsWith('"; } @page'), 'the title is printed as text');
});

test('buildRunningCss: hidden on the cover page, shown on page 1 when there is no cover', () => {
    const withCover = run();
    const first = withCover.slice(withCover.indexOf('@page :first'));
    assert.equal(boxesOf(first).length, 4);
    assert.ok(boxesOf(first).every((b) => b.decls === 'content: none; background: none;'));
    assert.ok(!run(TEMPLATE, VALUES, {pageOpts: A4, cover: false}).includes(':first'));
});

test('buildRunningCss: margin text is at least 11 mm from the paper edge (pdf-qa refuses 8 mm), in every size and font size', () => {
    for (const pageSize of ['A4', 'A3', 'A5', 'Letter', 'Legal', 'Slide']) {
        for (const margin of ['18mm', '20mm', '25mm', '0.75in', '2cm', '60pt']) {
            for (const fontSize of [6, 8, 10]) {
                const css = run({...TEMPLATE, runningStyle: {fontSize}}, VALUES, {pageOpts: {pageSize, margin}, cover: false});
                const marginMm = {mm: 1, cm: 10, in: 25.4, pt: 25.4 / 72}[/[a-z]+$/.exec(margin)[0]] * parseFloat(margin);
                const line = fontSize * 1.2 * 25.4 / 72;
                for (const b of boxesOf(css)) {
                    const gap = Number(/padding-(?:top|bottom): ([\d.]+)mm/.exec(b.decls)[1]);
                    assert.ok(gap > 0 && gap <= 6, `${pageSize} ${margin} ${fontSize}pt gap ${gap}`);
                    assert.ok(marginMm - gap - line >= RUNNING_LIMITS.edgeMm - 0.01, `${pageSize} ${margin} ${fontSize}pt: ${marginMm - gap - line} mm from the edge`);
                    assert.match(b.decls, b.box.startsWith('@top') ? /vertical-align: bottom; padding-bottom/ : /vertical-align: top; padding-top/);
                    assert.match(b.decls, /white-space: nowrap;/);
                }
            }
        }
    }
});

test('buildRunningCss: below an 18 mm margin there is no running head or foot', () => {
    assert.equal(run(TEMPLATE, VALUES, {pageOpts: {margin: '17.9mm'}}), '');
    assert.equal(run(TEMPLATE, VALUES, {pageOpts: {margin: '0.5in'}}), '');
    assert.notEqual(run(TEMPLATE, VALUES, {pageOpts: {margin: '18mm'}}), '');
});

test('buildRunningCss: long values are cut to what the slot holds, the page number kept', () => {
    const long = 'Annual review of the regional newsroom structure and the digital subscriptions strategy for next year';
    for (const pageSize of ['A5', 'A4', 'Slide']) {
        const css = run({runningHead: {left: '{author}', right: '{title}'}, runningFoot: {center: '{title}: page {page} of {pages}'}},
            {...VALUES, title: long, author: long}, {pageOpts: {pageSize, margin: '20mm'}});
        const contentMm = (pageSize === 'A5' ? 148 : pageSize === 'A4' ? 210 : 254) - 40;
        for (const b of boxesOf(css).filter((x) => !x.decls.startsWith('content: none'))) {
            const share = Number(/width: ([\d.]+)%/.exec(b.decls)[1]) / 100;
            const visible = [...b.decls.matchAll(/"((?:[^"\\]|\\[0-9a-f]+ ?)*)"|counter\(pages?\)/g)]
                .reduce((n, m) => n + (m[1] === undefined ? 3 : Array.from(unCss(`"${m[1]}"`)).length), 0);
            const fits = Math.floor((contentMm * share) / (8 * (25.4 / 72) * 0.6));
            assert.ok(visible <= fits, `${pageSize} ${b.box}: ${visible} characters, room for ${fits}`);
            if (b.box === '@bottom-center') assert.match(b.decls, /counter\(page\) " of " counter\(pages\)/, 'the page number survives the cut');
        }
        assert.ok(css.includes(ELLIPSIS), 'an ellipsis marks the cut');
    }
    const huge = run({runningFoot: {left: '{title}'}}, {title: 'x'.repeat(10000)});
    assert.ok(huge.length < 2000, 'values are capped');
});

test('buildRunningCss: a slot whose only value is empty is left out; nothing at all gives ""', () => {
    const css = run({runningHead: {left: '{author}', right: '{title}'}}, {...VALUES, author: ''});
    assert.deepEqual(boxesOf(css).filter((b) => !b.decls.startsWith('content: none')).map((b) => b.box), ['@top-right']);
    assert.match(css, /width: 50%/, 'the slots keep their places');
    assert.equal(run({runningHead: {left: '{author}'}}, {...VALUES, author: ''}), '');
    assert.equal(buildRunningCss(null, VALUES, {pageOpts: A4}), '');
});

test('buildRunningCss: a centre slot takes a third, centred; "center" is read as "centre"', () => {
    const css = run({runningFoot: {left: 'a', centre: 'b', right: 'c'}});
    assert.match(css, /@bottom-center \{ content: "b";.*text-align: center;/);
    assert.equal(run({runningFoot: {left: 'a', center: 'b', right: 'c'}}), css, 'the US spelling works too');
    assert.equal(normalizeRunning({runningLogo: {src: 'data:image/png;base64,AAAA', slot: 'head-center'}}).logo.slot, 'head-centre');
    assert.equal((css.match(/width: 33.33%/g) || []).length, 3);
});

test('buildRunningCss: a logo prints only as a data: image, sized and placed towards the body', () => {
    const svg = `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64')}`;
    const css = run({...TEMPLATE, runningLogo: {src: svg, slot: 'foot-right', height: 6}});
    const logo = boxesOf(css).find((b) => b.box === '@bottom-right' && b.decls.startsWith('content: ""'));
    assert.ok(logo, css);
    assert.match(logo.decls, /background-image: url\("data:image\/svg\+xml;base64,[A-Za-z0-9+/=]+"\);/);
    assert.match(logo.decls, /background-size: auto 6mm; background-position: right top ([\d.]+)mm;/);
    const gap = Number(/right top ([\d.]+)mm/.exec(logo.decls)[1]);
    assert.ok(20 - gap - 6 >= RUNNING_LIMITS.edgeMm - 0.01, 'the logo keeps 11 mm from the edge');
    assert.ok(!boxesOf(css).some((b) => b.box === '@bottom-right' && b.decls.includes('Page')), 'the logo takes its slot');
    for (const src of ['https://example.org/logo.svg', '/assets/logos/x.svg', 'data:text/html;base64,PGI+', 'data:image/svg+xml,<svg onload=alert(1)>',
        'javascript:alert(1)', `${svg}") } body { x: url("`]) {
        const c = run({runningFoot: {left: 'a'}, runningLogo: {src, slot: 'foot-right'}});
        assert.ok(!c.includes('background-image'), `not printed: ${src}`);
    }
});

test('runningFontProbe: the running font and its text, for the font check', () => {
    const probe = runningFontProbe(normalizeRunning(TEMPLATE), VALUES);
    assert.match(probe.css, /^\.bd-running-probe \{ position: absolute;.*visibility: hidden;.*font-family: 'Inter'.*font-weight: 500;/);
    assert.ok(probe.text.includes('Jo Bloggs') && probe.text.includes('Quarterly plan') && probe.text.includes('0123456789'), probe.text);
    assert.equal(runningFontProbe(null, VALUES), null);
});

test('buildPrintDocument: the running CSS in print, the probe in the body; nothing without one', () => {
    const html = buildPrintDocument({title: 'T <x>', author: 'A', bodyHTML: '<p>x</p>', coverHTML: '<div class="cover-page">C</div>',
        pageOpts: A4, running: normalizeRunning(TEMPLATE), date: '1 November 2026'});
    const print = html.slice(html.indexOf('@media print'));
    assert.ok(print.indexOf('@top-left') > 0 && print.indexOf('@top-left') < print.indexOf('</style>'));
    assert.match(html, /<div class="bd-running-probe" aria-hidden="true">[^<]*T &lt;x&gt;[^<]*<\/div>/);
    assert.ok(!/<script/i.test(html));
    const plain = buildPrintDocument({bodyHTML: '<p>x</p>', pageOpts: A4});
    assert.ok(!plain.includes('@top-') && !plain.includes('bd-running-probe'));
    const narrow = buildPrintDocument({bodyHTML: '<p>x</p>', pageOpts: {...A4, margin: '15mm'}, running: normalizeRunning(TEMPLATE)});
    assert.ok(!narrow.includes('@top-') && !narrow.includes('bd-running-probe'), 'a 15 mm margin has no room');
});
