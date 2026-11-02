/**
 * tests/test.js
 *
 * Zero-framework unit tests using Node's built-in test runner.
 * Run: node --test tests/test.js   (requires Node 18+)
 *
 * Covers all pure/importable functions. Browser-only behaviour is covered by the
 * tests/*.test.html pages (run them with `node tests/run-all.mjs`) and by the
 * manual checks in docs/MANUAL-TESTS.md.
 */

import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as growth from './lib/growth.js';

// ── Import pure modules: no browser globals needed at module init time ───────
import {slugify} from '../js/markdown.js';
import {diskChangeAction} from '../js/docmanager.js';
import {buildPageCss, buildPrintDocument} from '../js/print-document.js';
import * as docxExport from '../js/docx-export.js';
import {buildDocxHtml} from '../js/docx-export.js';
import {pptxBlocksFromHtml, hexColor} from '../js/pptx-export.js';
import * as slides from '../js/slides.js';
import {splitIntoSlides} from '../js/slides.js';
import unbranded, {manifest as ubManifest} from '../templates/unbranded/template.js';
import {getTemplates} from '../js/templates.js';

// ─────────────────────────────────────────────────────────────────────────────
// slugify
// ─────────────────────────────────────────────────────────────────────────────

test('slugify: basic lowercase + word-to-hyphen', () => {
    assert.equal(slugify('Hello World'), 'hello-world');
});

test('slugify: already lowercase, no change', () => {
    assert.equal(slugify('inline-code'), 'inline-code');
});

test('slugify: numbers are preserved', () => {
    assert.equal(slugify('H2O Heading'), 'h2o-heading');
});

test('slugify: ampersand stripped → double hyphen (space + stripped & + space)', () => {
    // "Paragraphs & Line Breaks" → strip & → "Paragraphs  Line Breaks" → each space → "-"
    assert.equal(slugify('Paragraphs & Line Breaks'), 'paragraphs--line-breaks');
});

test('slugify: TOC anchor for Strikethrough & Highlight section', () => {
    assert.equal(slugify('Strikethrough & Highlight'), 'strikethrough--highlight');
});

test('slugify: strips punctuation characters', () => {
    assert.equal(slugify('Code: Examples!'), 'code-examples');
});

test('slugify: empty string returns empty string', () => {
    assert.equal(slugify(''), '');
});

test('slugify: leading/trailing spaces handled', () => {
    assert.equal(slugify('  trim me  '), '--trim-me--');
});

test('slugify: letters, digits and marks from any script are kept', () => {
    assert.equal(slugify('Café Überblick'), 'café-überblick');
    assert.equal(slugify('Привет мир 2'), 'привет-мир-2');
    assert.equal(slugify('日本語の見出し'), '日本語の見出し');
    assert.equal(slugify('हिन्दी पाठ'), 'हिन्दी-पाठ', 'combining vowel signs stay');
});

test('slugify: NFD and NFC spellings give the same slug', () => {
    assert.equal(slugify('Cafe\u0301 au lait'), 'café-au-lait');
    assert.equal(slugify('Café au lait'), 'café-au-lait');
    assert.equal(slugify('Cafe\u0301'), slugify('Caf\u00e9'));
});

test('slugify: only punctuation gives an empty slug', () => {
    assert.equal(slugify('!!!?'), '');
    assert.equal(slugify(null), '');
});

// ─────────────────────────────────────────────────────────────────────────────
// Heading ids: plain text, fallbacks, duplicates, app-id collisions
// ─────────────────────────────────────────────────────────────────────────────

const md = await import('../js/markdown.js');

test('headingPlainText: tags stripped and entities decoded', () => {
    assert.equal(md.headingPlainText('Use &lt;img&gt; <code>tags</code> &amp; more'), 'Use <img> tags & more');
    assert.equal(md.headingPlainText('<a href="https://x.example/?a=1&amp;b=2" title="a>b">Link</a> here'), 'Link here');
    assert.equal(md.headingPlainText('&#169; &#x41;&quot;&#39;&nbsp;x &copy;'), '© A"\'\u00a0x ', 'unknown named entities are dropped');
});

test('headingPlainText: tag removal matches the reference regex, in linear time', async () => {
    const reference = (s) => s.replace(/<(?:[^>"']|"[^"]*"|'[^']*')*>/g, '');
    let seed = 12345;
    const rand = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
    const alphabet = '<>"\'ab';
    for (let i = 0; i < 20000; i++) {
        let s = '';
        for (let len = rand(14); len > 0; len--) s += alphabet[rand(alphabet.length)];
        assert.equal(md.headingPlainText(s), reference(s), JSON.stringify(s));
    }
    // Linear time, judged by growth (16K vs 64K characters), not a wall-clock budget a slower CPU would fail.
    // Small enough that a quadratic regression fails in seconds instead of hanging the run.
    for (const [label, make] of [['"<" repeated', (n) => '<'.repeat(n)], ['<"" repeated', (n) => '<""'.repeat(Math.floor(n / 3))]]) {
        const problem = await growth.checkLinear((s) => md.headingPlainText(s), make, {n: 1 << 14, capMs: 5000});
        assert.equal(problem, null, `${label}: ${problem}`);
    }
});

test('createHeadingIds: entity-bearing heading HTML gives a readable id', () => {
    const next = md.createHeadingIds();
    assert.equal(next('&lt;img&gt; tag'), 'img-tag', 'not "ltimggt-tag"');
    assert.equal(next('Salt &amp; Pepper'), 'salt--pepper');
});

test('createHeadingIds: duplicates get -1, -2 and a taken suffix is skipped', () => {
    const next = md.createHeadingIds();
    assert.equal(next('Intro'), 'intro');
    assert.equal(next('Intro'), 'intro-1');
    assert.equal(next('Intro-2'), 'intro-2');
    assert.equal(next('Intro'), 'intro-3', 'intro-2 is taken by a real heading');
});

test('createHeadingIds: headings with no letters or digits get section-N', () => {
    const next = md.createHeadingIds();
    assert.equal(next(''), 'section-1');
    assert.equal(next('!!!'), 'section-2');
    assert.equal(next('<img src="x.png" alt="">'), 'section-3');
});

test('createHeadingIds: a slug equal to an app element id gets the h- prefix', () => {
    const next = md.createHeadingIds();
    assert.equal(next('Editor'), 'h-editor');
    assert.equal(next('Editor'), 'h-editor-1');
    assert.equal(next('Editor pane'), 'h-editor-pane');
    assert.equal(next('Editors'), 'editors');
    assert.equal(md.appSafeId('toast'), 'h-toast');
    assert.equal(md.appSafeId('toasts'), 'toasts');
});

test('appSafeId: the -N forms of a reserved id are reserved too, so ids and #links agree', () => {
    assert.equal(md.appSafeId('editor-1'), 'h-editor-1');
    assert.equal(md.appSafeId('editor-12-3'), 'h-editor-12-3');
    assert.equal(md.appSafeId('editor-x'), 'editor-x');
    assert.equal(md.appSafeId('editorial-1'), 'editorial-1');
    const next = md.createHeadingIds();
    assert.equal(next('Editor'), 'h-editor');
    assert.equal(next('Editor'), 'h-editor-1');
    assert.equal(next('Editor 1'), 'h-editor-1-1', 'a heading named "Editor 1" does not take the second Editor\'s id');
});

test('APP_ELEMENT_IDS lists every id index.html and the app scripts give an element', () => {
    const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
    const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
    for (const file of readdirSync(new URL('../js/', import.meta.url))) {
        if (!file.endsWith('.js')) continue;
        const src = readFileSync(new URL(`../js/${file}`, import.meta.url), 'utf8');
        for (const m of src.matchAll(/\.id\s*=\s*'([^']+)'/g)) ids.add(m[1]);
    }
    assert.ok(ids.size > 50, 'found the app ids');
    const reserved = new Set(md.APP_ELEMENT_IDS);
    const missing = [...ids].filter((id) => !reserved.has(id));
    assert.deepEqual(missing, [], 'ids missing from APP_ELEMENT_IDS in js/markdown.js');
});

// ─────────────────────────────────────────────────────────────────────────────
// buildPageCss: centralized @page print rules (size/orientation/margin)
// ─────────────────────────────────────────────────────────────────────────────

test('buildPageCss: defaults to A4 portrait 20mm', () => {
    const css = buildPageCss();
    assert.ok(css.includes('size: A4 portrait;'), 'default size A4 portrait');
    assert.ok(css.includes('margin: 20mm;'), 'default margin 20mm');
});

test('buildPageCss: the first page loses its margin only when there is a cover', () => {
    assert.ok(!buildPageCss().includes(':first'), 'no cover: page 1 keeps the normal margin');
    assert.ok(buildPageCss({}, {cover: true}).includes('@page :first { margin: 0; }'), 'cover page has zero margin');
});

test('buildPageCss: page width and height variables follow size and orientation', () => {
    const vars = (opts) => /--bd-page-width: ([^;]+); --bd-page-height: ([^;]+);/.exec(buildPageCss(opts)).slice(1).join(' x ');
    assert.equal(vars({}), '210mm x 297mm');
    assert.equal(vars({orientation: 'landscape'}), '297mm x 210mm');
    assert.equal(vars({pageSize: 'Letter', orientation: 'landscape'}), '279.4mm x 215.9mm');
    assert.equal(vars({pageSize: 'Legal'}), '215.9mm x 355.6mm');
    assert.equal(vars({pageSize: 'A3', orientation: 'landscape'}), '420mm x 297mm');
    assert.equal(vars({pageSize: 'A5'}), '148mm x 210mm');
    assert.equal(vars({pageSize: 'Tabloid'}), '210mm x 297mm', 'unknown size falls back to A4');
});

test('buildPrintDocument: @page :first only with a cover', () => {
    assert.ok(buildPrintDocument({coverHTML: '<div class="cover-page">C</div>'}).includes('@page :first { margin: 0; }'));
    assert.ok(!buildPrintDocument({coverHTML: ''}).includes('@page :first'));
});


test('buildPageCss: landscape orientation is emitted', () => {
    assert.ok(buildPageCss({orientation: 'landscape'}).includes('size: A4 landscape;'));
});

test('buildPageCss: custom page size and margin honored', () => {
    const css = buildPageCss({pageSize: 'Letter', orientation: 'landscape', margin: '15mm'});
    assert.ok(css.includes('size: Letter landscape;'));
    assert.ok(css.includes('margin: 15mm;'));
});

test('buildPageCss: per-template margin (unbranded 22mm) flows through', () => {
    assert.ok(buildPageCss({margin: '22mm'}).includes('margin: 22mm;'));
});

// ─────────────────────────────────────────────────────────────────────────────
// buildPrintDocument: the HTML printed to PDF, from plain data
// ─────────────────────────────────────────────────────────────────────────────

test('buildPrintDocument: title escaped, template scope, body and cover placed', () => {
    const html = buildPrintDocument({
        title: 'Q1 <Plan> & "notes"', templateId: 'example-co', templateCSS: '.template-example-co{color:red}',
        hljsCSS: '.hljs{}', bodyHTML: '<p>Body</p>', coverHTML: '<div class="cover-page">Cover</div>', pageOpts: {},
    });
    assert.ok(html.startsWith('<!DOCTYPE html>'));
    assert.ok(html.includes('<title>Q1 &lt;Plan&gt; &amp; &quot;notes&quot;</title>'));
    assert.ok(html.includes('.template-example-co{color:red}') && html.includes('.hljs{}'));
    assert.ok(html.includes('<div class="bd-page bd-page-cover"><div class="template-example-co"'), 'cover page card');
    assert.ok(html.indexOf('Cover') < html.indexOf('<p>Body</p>'), 'cover before body');
    assert.match(html, /<div class="bd-page">\s*<div class="template-example-co">\s*<p>Body<\/p>/);
});

test('buildPrintDocument: no cover HTML means no cover page card', () => {
    const html = buildPrintDocument({templateId: 'unbranded', bodyHTML: '<p>x</p>'});
    assert.ok(!html.includes('bd-page-cover"'), 'no cover card');
});

test('buildPrintDocument: never contains a script, and a template id cannot break out of its class', () => {
    const html = buildPrintDocument({templateId: 'x" onload="alert(1)', bodyHTML: '<p>x</p>'});
    assert.ok(!/<script/i.test(html), 'no script');
    assert.ok(html.includes('class="template-xonloadalert1"'), 'id reduced to class-safe characters');
});

test('buildPrintDocument: page options are validated', () => {
    const html = buildPrintDocument({pageOpts: {pageSize: 'A4; } body { display:none', orientation: 'landscape', margin: '15mm'}});
    assert.ok(html.includes('size: A4 landscape;'), 'bad size falls back to A4');
    assert.ok(!html.includes('display:none'));
});

test('export modules are pure: no document or window use, importable in Node', async () => {
    for (const file of ['doc-meta.js', 'print-document.js', 'export-pipeline.js', 'export-options.js', 'fonts.js', 'page-chrome.js']) {
        const src = readFileSync(new URL(`../js/${file}`, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
        assert.doesNotMatch(src, /\b(document|window|location|navigator|localStorage)\b/, `js/${file} touches a browser global`);
        await import(`../js/${file}`);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// Template manifests declare page margin (M1-T1)
// ─────────────────────────────────────────────────────────────────────────────

// Every template in the registry (templates/manifest.*.json), never by name.
const ENTRIES = getTemplates();
const ALL_TEMPLATES = ENTRIES.map((e) => [e.manifest.id, e.template]);
const STYLE_OF = Object.fromEntries(ENTRIES.map((e) => [e.manifest.id, e.styles]));

test('template styles no longer hardcode @page (centralized in print-document)', () => {
    for (const e of ENTRIES) assert.ok(!e.styles.includes('@page'), `${e.manifest.id} styles must not contain @page`);
});

test('manifests declare page margin (unbranded keeps 22mm)', () => {
    for (const e of ENTRIES) assert.match(e.manifest.page.margin, /^\d+(\.\d+)?mm$/, `${e.manifest.id} margin`);
    assert.equal(ubManifest.page.margin, '22mm');
});

// ─────────────────────────────────────────────────────────────────────────────
// Template IDs and contract shape
// ─────────────────────────────────────────────────────────────────────────────

test('template IDs match their manifests', () => {
    assert.ok(ENTRIES.length >= 1);
    for (const e of ENTRIES) assert.equal(e.template.id, e.manifest.id);
    assert.equal(unbranded.id, 'unbranded');
});

test('all templates expose the contract methods, and no header or footer hooks', () => {
    for (const [name, tpl] of ALL_TEMPLATES) {
        assert.equal(typeof tpl.renderCover, 'function', `${name}.renderCover`);
        assert.equal(typeof tpl.transformHTML, 'function', `${name}.transformHTML`);
        assert.equal(typeof tpl.preflightChecks, 'function', `${name}.preflightChecks`);
        assert.equal(tpl.renderHeader, undefined, `${name}.renderHeader is not part of the contract`);
        assert.equal(tpl.renderFooter, undefined, `${name}.renderFooter is not part of the contract`);
    }
});

test('templates build on templates/_shared/base.js', async () => {
    const base = await import('../templates/_shared/base.js');
    // A template with a light code background takes the light syntax palette, the rest the dark one.
    for (const [name, tpl] of ALL_TEMPLATES) {
        assert.ok(['dark', 'light'].some((codeTheme) => STYLE_OF[name].startsWith(base.baseStyles(name, {codeTheme}))),
            `${name} styles start with the shared base`);
        assert.equal(tpl.preflightChecks, base.preflightChecks, `${name} uses the shared preflight check`);
    }
    assert.ok(base.baseStyles('x').includes('.template-x .cover-page'), 'base rules are scoped to the template');
    assert.ok(!base.baseStyles('x').includes('@page'), 'no @page rule in the base either');
    // A PDF cannot scroll: in print, code wraps and long tokens break (tests/print-pdf.mjs checks the PDFs).
    const print = base.baseStyles('x').slice(base.baseStyles('x').indexOf('@media print'));
    assert.match(print, /\.template-x pre \{[^}]*white-space: pre-wrap;/, 'pre wraps in print');
    assert.match(print, /\.template-x pre code \{[^}]*white-space: pre-wrap;/, 'pre code wraps in print');
    assert.match(print, /\.template-x pre,\s*\.template-x pre code \{ overflow-wrap: anywhere; \}/, 'code blocks break anywhere in print');
    assert.match(print, /\.template-x \{ overflow-wrap: break-word; \}/, 'text breaks long words in print');
    assert.ok(!/(td|th)[^{}]*\{[^}]*overflow-wrap: anywhere/.test(print), 'table cells are never squeezed below their longest word');
    assert.ok(!/white-space: pre-wrap/.test(base.baseStyles('x').slice(0, base.baseStyles('x').indexOf('@media print'))),
        'the on-screen preview keeps scrolling code');
    assert.equal(base.escapeHtml(`<a href="x" title='y'>&</a>`), '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;');
    assert.equal(base.escapeHtml(null), '');
    assert.deepEqual(base.preflightChecks({title: 'Untitled'}), ['No document title found (add a # H1 heading)']);
    assert.deepEqual(base.preflightChecks({title: 'Plan'}), []);
});

test('transformHTML is a passthrough (returns html unchanged)', () => {
    const html = '<p>Hello <strong>world</strong></p>';
    for (const [name, tpl] of ALL_TEMPLATES) assert.equal(tpl.transformHTML(html), html, name);
});

// ─────────────────────────────────────────────────────────────────────────────
// preflightChecks
// ─────────────────────────────────────────────────────────────────────────────

test('preflightChecks: warns when title is "Untitled"', () => {
    for (const [name, tpl] of ALL_TEMPLATES) {
        const w = tpl.preflightChecks({title: 'Untitled', author: '', date: ''});
        assert.ok(w.length > 0, `${name} should warn on Untitled`);
    }
});

test('preflightChecks: warns when title is empty', () => {
    for (const [name, tpl] of ALL_TEMPLATES) {
        const w = tpl.preflightChecks({title: '', author: '', date: ''});
        assert.ok(w.length > 0, `${name} should warn on empty title`);
    }
});

test('preflightChecks: no warnings with a real title', () => {
    for (const [name, tpl] of ALL_TEMPLATES) {
        const w = tpl.preflightChecks({title: 'Q1 Report', author: 'Alice', date: '1 Jan 2025'});
        assert.equal(w.length, 0, `${name} should have no warnings with a valid title`);
    }
});

test('preflightChecks: returns an array', () => {
    for (const [, tpl] of ALL_TEMPLATES) {
        assert.ok(Array.isArray(tpl.preflightChecks({title: 'Test', author: '', date: ''})));
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// XSS escaping in cover output
// ─────────────────────────────────────────────────────────────────────────────

const XSS_TITLE = '<script>alert("xss")</script>';
// The dangerous part of XSS is unescaped < and ": check those are gone.
// The string "onerror=" can safely appear as escaped text content.
const XSS_AUTHOR = '"><img src=x onerror=alert(1)>';

test('renderCover: the title is HTML-escaped (no raw < tag), in every template', () => {
    for (const [name, tpl] of ALL_TEMPLATES) {
        const html = tpl.renderCover({title: XSS_TITLE, author: '', date: '1 Jan 2025'});
        assert.ok(!html.includes('<script>'), `${name}: raw <script> must not appear`);
        assert.ok(html.includes('&lt;script&gt;'), `${name}: must be escaped as &lt;script&gt;`);
    }
});

test('renderCover: the author is HTML-escaped (no raw injected <img tag), in every template', () => {
    for (const [name, tpl] of ALL_TEMPLATES) {
        const html = tpl.renderCover({title: 'Safe', author: XSS_AUTHOR, date: '1 Jan 2025'});
        // A cover may have a logo <img>, which is fine: check the *injected* tag is escaped
        assert.ok(!html.includes('<img src=x'), `${name}: injected <img src=x must not appear unescaped`);
        assert.ok(html.includes('&lt;img src=x'), `${name}: injected img must be escaped as &lt;img`);
    }
});

test('renderCover: an author line only when there is an author', () => {
    for (const [name, tpl] of ALL_TEMPLATES) {
        const without = tpl.renderCover({title: 'Report', author: '', date: '1 Jan 2025'});
        assert.ok(!/Prepared by|cover-author/.test(without), `${name}: empty author renders no author line`);
        assert.ok(tpl.renderCover({title: 'Report', author: 'Alice Zebra', date: '1 Jan 2025'}).includes('Alice Zebra'), name);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// Cover HTML structure
// ─────────────────────────────────────────────────────────────────────────────

test('renderCover: returns a non-empty string', () => {
    const doc = {title: 'My Doc', author: 'Bob', date: '16 April 2026'};
    for (const [name, tpl] of ALL_TEMPLATES) {
        const html = tpl.renderCover(doc);
        assert.ok(typeof html === 'string' && html.length > 0, name);
    }
});

test('renderCover: contains title text', () => {
    // The text people read, not the markup: a template may style one word of the title in its own tag.
    const textOf = (html) => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
    const doc = {title: 'Unique Title XYZ', author: '', date: ''};
    for (const [name, tpl] of ALL_TEMPLATES) {
        assert.ok(textOf(tpl.renderCover(doc)).includes('Unique Title XYZ'), name);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// splitIntoSlides
// ─────────────────────────────────────────────────────────────────────────────

test('splitIntoSlides: empty string returns []', () => {
    assert.deepEqual(splitIntoSlides(''), []);
});

test('splitIntoSlides: null/undefined returns []', () => {
    assert.deepEqual(splitIntoSlides(null), []);
    assert.deepEqual(splitIntoSlides(undefined), []);
});

test('splitIntoSlides: single paragraph, no headings/hr -> one slide, title empty', () => {
    const slides = splitIntoSlides('<p>Hello world</p>');
    assert.equal(slides.length, 1);
    assert.equal(slides[0].title, '');
    assert.equal(slides[0].html, '<p>Hello world</p>');
});

test('splitIntoSlides: h1 introduces slide and title', () => {
    const slides = splitIntoSlides('<h1>Intro</h1><p>a</p>');
    assert.equal(slides.length, 1);
    assert.equal(slides[0].title, 'Intro');
    assert.equal(slides[0].html, '<h1>Intro</h1><p>a</p>');
});

test('splitIntoSlides: h1 and h2 each start a new slide', () => {
    const slides = splitIntoSlides('<h1>A</h1><p>x</p><h2>B</h2><p>y</p>');
    assert.equal(slides.length, 2);
    assert.equal(slides[0].title, 'A');
    assert.equal(slides[1].title, 'B');
});

test('splitIntoSlides: <hr> splits into separate slides', () => {
    const slides = splitIntoSlides('<p>one</p><hr><p>two</p>');
    assert.equal(slides.length, 2);
    assert.equal(slides[0].title, '');
    assert.equal(slides[0].html, '<p>one</p>');
    assert.equal(slides[1].title, '');
    assert.equal(slides[1].html, '<p>two</p>');
});

test('splitIntoSlides: heading title decodes basic entities', () => {
    const slides = splitIntoSlides('<h2>Salt &amp; Pepper</h2>');
    assert.equal(slides.length, 1);
    assert.equal(slides[0].title, 'Salt & Pepper');
    assert.equal(slides[0].html, '<h2>Salt &amp; Pepper</h2>');
});

test('splitIntoSlides: standalone h1', () => {
    const slides = splitIntoSlides('<h1>Only</h1>');
    assert.equal(slides.length, 1);
    assert.equal(slides[0].title, 'Only');
    assert.equal(slides[0].html, '<h1>Only</h1>');
});

// ─────────────────────────────────────────────────────────────────────────────
// buildDocxHtml: legacy compat passthrough (M1-T4)
// ─────────────────────────────────────────────────────────────────────────────

test('buildDocxHtml: returns the renderedHTML unchanged', () => {
    const input = '<p>hello</p>';
    const html = buildDocxHtml({title: 'Q1 Report', author: '', date: ''}, getTemplates()[0], input);
    assert.equal(html, input);
});

// ─────────────────────────────────────────────────────────────────────────────
// office-convert: LibreOffice runs in its own process group with a throwaway profile
// ─────────────────────────────────────────────────────────────────────────────

/** A stub soffice: records its arguments, starts a child that lingers (like oosplash/soffice.bin), then hangs or exits. */
async function sofficeStub(mode) {
    const {mkdtempSync, writeFileSync} = await import('node:fs');
    const {tmpdir} = await import('node:os');
    const {join} = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'bd-stub-'));
    const bin = join(dir, 'soffice');
    const tail = mode === 'hang' ? 'wait' : 'exit 0';
    writeFileSync(bin, `#!/bin/sh\necho "$@" > "${dir}/args"\nsleep 300 &\n${tail}\n`, {mode: 0o755});
    return {dir, bin};
}

/**
 * Whether any live process is left in a process group. A zombie (state Z in
 * /proc/<pid>/stat) counts as gone: it has been killed and only waits to be
 * reaped, which never happens in a container whose PID 1 is node rather than
 * an init. Without /proc, signal 0 to the group decides (zombies count there).
 */
function groupAlive(pgid) {
    let pids = null;
    try {
        pids = readdirSync('/proc').filter((n) => /^\d+$/.test(n));
    } catch (_e) { /* no /proc */ }
    if (pids && pids.length) {
        for (const pid of pids) {
            let stat;
            try {
                stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
            } catch (_e) {
                continue; // exited meanwhile
            }
            // Fields after the parenthesised command name: state, ppid, pgrp, ...
            const [state, , pgrp] = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
            if (Number(pgrp) === pgid && state !== 'Z') return true;
        }
        return false;
    }
    try {
        process.kill(-pgid, 0);
        return true;
    } catch (e) {
        return e.code !== 'ESRCH';
    }
}

for (const mode of ['hang', 'exit']) {
    test(`runSoffice: ${mode === 'hang' ? 'a hung conversion is killed' : 'after a normal exit, helpers are swept'} with its whole process group, and its profile is deleted`, async () => {
        const {readFileSync, readdirSync, rmSync} = await import('node:fs');
        const {tmpdir} = await import('node:os');
        const {runSoffice} = await import('./office-convert.mjs');
        const {dir, bin} = await sofficeStub(mode);
        const profiles = () => readdirSync(tmpdir()).filter((n) => n.startsWith('bd-lo-profile-'));
        const before = new Set(profiles());
        try {
            const r = await runSoffice(['--headless', '--convert-to', 'pdf'], {bin, timeoutMs: mode === 'hang' ? 500 : 10000});
            assert.equal(r.timedOut, mode === 'hang', 'timed out only when hung');
            const args = readFileSync(`${dir}/args`, 'utf8');
            assert.match(args, /-env:UserInstallation=file:\/\/\S*bd-lo-profile-/, 'a throwaway profile is passed: ' + args);
            const start = Date.now();
            while (groupAlive(r.pgid) && Date.now() - start < 3000) await new Promise((ok) => setTimeout(ok, 50));
            assert.equal(groupAlive(r.pgid), false, 'no process of the conversion is left');
            assert.deepEqual(profiles().filter((n) => !before.has(n)), [], 'the profile folder is deleted');
        } finally {
            rmSync(dir, {recursive: true, force: true});
        }
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// print-document: break opportunities for long tokens in table cells
// ─────────────────────────────────────────────────────────────────────────────

test('breakLongCellTokens: a long token in a cell gets <wbr> break opportunities', async () => {
    const {breakLongCellTokens} = await import('../js/print-document.js');
    const hash = '0123456789abcdef'.repeat(4);
    const out = breakLongCellTokens(`<table><tr><td>id ${hash}</td></tr></table>`);
    assert.match(out, /<td>id 0123456789.*<wbr>/);
    assert.equal(out.replace(/<wbr>/g, ''), `<table><tr><td>id ${hash}</td></tr></table>`, 'only <wbr> added');
    for (const piece of out.slice(out.indexOf(' ') + 1).split(/<wbr>|<\/td>/)) {
        assert.ok(piece.length <= 30, 'no run over 30 characters: ' + piece);
    }
});

test('breakLongCellTokens: leaves normal words, text outside cells, pre, attributes and entities alone', async () => {
    const {breakLongCellTokens} = await import('../js/print-document.js');
    const long = 'x'.repeat(40);
    const same = [
        '<table><tr><th>Component</th><td>Internationalisation and Responsibility</td></tr></table>',
        `<p>${long}</p>`,
        `<table><tr><td><pre><code>${long}</code></pre></td></tr></table>`,
        `<table><tr><td><a href="https://example.com/${long}" title="${long}">link</a></td></tr></table>`,
    ];
    for (const html of same) assert.equal(breakLongCellTokens(html), html);
    const ent = breakLongCellTokens(`<table><tr><td>${'a&amp;'.repeat(20)}</td></tr></table>`);
    assert.ok(!/&[a-z]*<wbr>|&<wbr>/.test(ent), 'no break inside an entity: ' + ent);
    assert.ok(ent.includes('<wbr>'), 'entities count as one character each');
    const code = breakLongCellTokens(`<table><tr><td><code>${long}</code></td></tr></table>`);
    assert.ok(code.includes('<wbr>'), 'inline code in a cell breaks too');
    assert.equal(breakLongCellTokens(''), '');
});

test('buildPrintDocument: long tokens in table cells get break opportunities', () => {
    const html = buildPrintDocument({templateId: 'x', bodyHTML: `<table><tr><td>${'y'.repeat(40)}</td></tr></table>`});
    assert.ok(html.includes('<wbr>'));
});

// ─────────────────────────────────────────────────────────────────────────────
// docx-export pure helpers
// ─────────────────────────────────────────────────────────────────────────────

test('stripXmlIllegal: removes the characters XML 1.0 forbids, keeps tab, newline and CR', () => {
    const bad = '\u0000\u0001\u0008\u000B\u000C\u000E\u001F\u{FFFE}\u{FFFF}';
    assert.equal(docxExport.stripXmlIllegal(`a${bad}b\t\n\rc`), 'ab\t\n\rc');
    assert.equal(docxExport.stripXmlIllegal('x\uD800y\uDC00z'), 'xyz', 'unpaired surrogates go');
    assert.equal(docxExport.stripXmlIllegal('emoji 😀'), 'emoji 😀', 'a surrogate pair stays');
    assert.equal(docxExport.stripXmlIllegal(null), '');
});

test('escXml: escapes markup after stripping control characters', () => {
    assert.equal(docxExport.escXml('<a href="x">&\u0001</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;');
});

test('listNumberingPlan: one num per list, ordered lists restart at their start', () => {
    const plan = docxExport.listNumberingPlan([
        {ordered: true, level: 0, start: 1},
        {ordered: true, level: 0, start: 1},
        {ordered: false, level: 0},
        {ordered: true, level: 1, start: 5},
        {ordered: true, level: 12, start: -3},
        {ordered: true, level: 0, start: 99999999999},
    ]);
    assert.deepEqual(plan.map(p => p.numId), [1, 2, 3, 4, 5, 6]);
    assert.deepEqual(plan.map(p => p.start), [1, 1, null, 5, 0, 32767], 'bullets have no start; starts clamp to 0..32767');
    assert.deepEqual(plan.map(p => p.ilvl), [0, 0, 0, 1, docxExport.MAX_LIST_LEVEL, 0], 'levels clamp to Word\'s 9');
    assert.equal(plan[0].abstractNumId, plan[1].abstractNumId, 'numbered lists share the decimal format');
    assert.notEqual(plan[0].abstractNumId, plan[2].abstractNumId, 'bullets use the bullet format');
});

test('buildNumbering: a w:num with a startOverride on its level for each ordered list', () => {
    const xml = docxExport.buildNumbering(docxExport.listNumberingPlan([
        {ordered: true, level: 0, start: 1}, {ordered: false, level: 0}, {ordered: true, level: 1, start: 5},
    ]));
    assert.match(xml, /<w:num w:numId="1"><w:abstractNumId w:val="1"\/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="1"\/>/);
    assert.match(xml, /<w:num w:numId="2"><w:abstractNumId w:val="0"\/><\/w:num>/);
    assert.match(xml, /<w:num w:numId="3"><w:abstractNumId w:val="1"\/><w:lvlOverride w:ilvl="1"><w:startOverride w:val="5"\/>/);
    assert.equal((xml.match(/<w:lvl /g) || []).length, 18, 'nine levels in each abstract format');
});

test('externalLinkTarget: normalised http, https and mailto URLs; anything else is empty', () => {
    const t = docxExport.externalLinkTarget;
    assert.equal(t(' https://Example.com/a b?x=<2>&y="q" '), 'https://example.com/a%20b?x=%3C2%3E&y=%22q%22');
    assert.equal(t('mailto:a@b.c'), 'mailto:a@b.c');
    for (const bad of ['javascript:alert(1)', 'data:text/html,x', './rel', '#anchor', 'https://a.com/%ZZ', 'https://',
        'https://example.com/' + 'a'.repeat(docxExport.MAX_LINK_LENGTH), '', null]) {
        assert.equal(t(bad), '', String(bad).slice(0, 40));
    }
});

test('isoDay: cover dates and ISO dates become YYYY-MM-DD, anything else is empty', () => {
    assert.equal(docxExport.isoDay('1 March 2026'), '2026-03-01');
    assert.equal(docxExport.isoDay('15 january 2026'), '2026-01-15');
    assert.equal(docxExport.isoDay('2026-03-01'), '2026-03-01');
    assert.equal(docxExport.isoDay('31 February 2026'), '', 'not a real day');
    assert.equal(docxExport.isoDay('Q3 2026'), '');
    assert.equal(docxExport.isoDay(''), '');
});

// ─────────────────────────────────────────────────────────────────────────────
// pptxBlocksFromHtml: pure HTML-to-block converter (M1-T5)
// ─────────────────────────────────────────────────────────────────────────────

test('pptxBlocksFromHtml: empty string returns []', () => {
    assert.deepEqual(pptxBlocksFromHtml(''), []);
});

test('pptxBlocksFromHtml: null/undefined returns []', () => {
    assert.deepEqual(pptxBlocksFromHtml(null), []);
    assert.deepEqual(pptxBlocksFromHtml(undefined), []);
});

const kindText = (blocks) => blocks.map(b => ({kind: b.kind, text: b.text}));

test('pptxBlocksFromHtml: <li> items become bullet blocks', () => {
    const blocks = pptxBlocksFromHtml('<ul><li>one</li><li>two</li></ul>');
    assert.deepEqual(kindText(blocks), [{kind: 'bullet', text: 'one'}, {kind: 'bullet', text: 'two'}]);
    assert.equal(blocks[0].level, 0);
    assert.equal(blocks[0].ordered, false);
});

test('pptxBlocksFromHtml: <p> becomes para block', () => {
    assert.deepEqual(kindText(pptxBlocksFromHtml('<p>Hi</p>')), [{kind: 'para', text: 'Hi'}]);
});

test('pptxBlocksFromHtml: h1 and h2 are ignored', () => {
    assert.deepEqual(kindText(pptxBlocksFromHtml('<h1>T</h1><p>body</p>')), [{kind: 'para', text: 'body'}]);
});

test('pptxBlocksFromHtml: entity decode inside <li>', () => {
    const blocks = pptxBlocksFromHtml('<li>Salt &amp; Pepper &lt;3</li>');
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].text, 'Salt & Pepper <3');
});

test('pptxBlocksFromHtml: mixed order preserved', () => {
    assert.deepEqual(kindText(pptxBlocksFromHtml('<p>a</p><ul><li>b</li></ul>')),
        [{kind: 'para', text: 'a'}, {kind: 'bullet', text: 'b'}]);
});

test('pptxBlocksFromHtml: two paragraphs are two blocks; br is a soft break inside one', () => {
    const blocks = pptxBlocksFromHtml('<p>One<br>two</p>\n<p>Three</p>');
    assert.deepEqual(kindText(blocks), [{kind: 'para', text: 'One\ntwo'}, {kind: 'para', text: 'Three'}]);
    assert.ok(blocks[0].runs.some(r => r.br), 'br run');
});

test('pptxBlocksFromHtml: nested lists carry their level; ol keeps start', () => {
    const blocks = pptxBlocksFromHtml('<ul><li>Outer<ol start="5"><li>Inner</li></ol></li></ul>');
    assert.deepEqual(blocks.map(b => [b.text, b.level, b.ordered, b.start]), [['Outer', 0, false, 1], ['Inner', 1, true, 5]]);
});

test('pptxBlocksFromHtml: start="0" and negative starts are kept', () => {
    assert.deepEqual(pptxBlocksFromHtml('<ol start="0"><li>a</li><li>b</li></ol>').map(b => [b.start, b.number]), [[0, 0], [0, 1]]);
    assert.deepEqual(pptxBlocksFromHtml('<ol start="-3"><li>a</li></ol>').map(b => b.number), [-3]);
    assert.deepEqual(pptxBlocksFromHtml('<ol start="x"><li>a</li></ol>').map(b => b.number), [1]);
});

test('pptxBlocksFromHtml: list items carry their own number and a list id', () => {
    const blocks = pptxBlocksFromHtml('<ol start="3"><li>a</li><li>b</li></ol><ol><li>c</li></ol>');
    assert.deepEqual(blocks.map(b => b.number), [3, 4, 1]);
    assert.equal(blocks[0].list, blocks[1].list);
    assert.notEqual(blocks[1].list, blocks[2].list);
});

test('pptxBlocksFromHtml: task items, code, tables, images and inline formatting', () => {
    const blocks = pptxBlocksFromHtml(
        '<ul><li><input checked="" disabled="" type="checkbox"> Done</li></ul>'
        + '<pre><code>a &lt; b\n  c\n</code></pre>'
        + '<table><thead><tr><th>H1</th><th align="right">H2</th></tr></thead><tbody><tr><td colspan="2">wide</td></tr></tbody></table>'
        + '<p><img src="data:image/png;base64,AA==" alt="pic"> <strong>bold</strong> <a href="https://x.test/">link</a></p>');
    assert.deepEqual(blocks.map(b => b.kind), ['bullet', 'code', 'table', 'para', 'image']);
    assert.equal(blocks[0].checkbox, true);
    assert.equal(blocks[0].text, 'Done');
    assert.deepEqual(blocks[1].lines, ['a < b', '  c']);
    assert.deepEqual(blocks[2].rows[0].map(c => [c.text, c.header, c.align]), [['H1', true, ''], ['H2', true, 'right']]);
    assert.equal(blocks[2].rows[1][0].colspan, 2);
    assert.ok(blocks[3].runs.find(r => r.text === 'bold').bold);
    assert.equal(blocks[3].runs.find(r => r.text === 'link').href, 'https://x.test/');
    assert.deepEqual([blocks[4].src, blocks[4].alt], ['data:image/png;base64,AA==', 'pic']);
});

test('singleParagraphProps: one a:pPr per paragraph, first; other paragraphs untouched', async () => {
    const {singleParagraphProps} = await import('../js/pptx-export.js');
    const first = '<a:pPr indent="0" marL="0"><a:spcAft><a:spcPts val="600"/></a:spcAft><a:buNone/></a:pPr>';
    const extra = '<a:pPr indent="0" marL="0"><a:buNone/></a:pPr>';
    const run = (t) => `<a:r><a:rPr lang="en-US"/><a:t>${t}</a:t></a:r>`;
    const xml = `<p:txBody><a:p>${first}${run('a ')}${extra}${run('b')}<a:pPr/>${run('c')}<a:endParaRPr/></a:p>`
        + `<a:p>${first}${run('ok')}</a:p><a:p>${run('no props')}</a:p><a:p>${run('late')}${extra}</a:p></p:txBody>`;
    assert.equal(singleParagraphProps(xml),
        `<p:txBody><a:p>${first}${run('a ')}${run('b')}${run('c')}<a:endParaRPr/></a:p>`
        + `<a:p>${first}${run('ok')}</a:p><a:p>${run('no props')}</a:p><a:p>${extra}${run('late')}</a:p></p:txBody>`);
});

// ─────────────────────────────────────────────────────────────────────────────
// slides.js: entities, the HTML tree and slide layout
// ─────────────────────────────────────────────────────────────────────────────

test('decodeEntities: one pass, so &amp;lt; stays &lt;', () => {
    assert.equal(slides.decodeEntities('&amp;lt;'), '&lt;');
    assert.equal(slides.decodeEntities('&amp;amp;'), '&amp;');
    assert.equal(slides.decodeEntities('&lt;b&gt; &quot;q&quot; &#39;s&#39; &#x263A; &nbsp;'), '<b> "q" \'s\' ☺  ');
    assert.equal(slides.decodeEntities('&unknown; & alone'), '&unknown; & alone');
    const replacement = String.fromCharCode(0xfffd);
    assert.equal(slides.decodeEntities('&#0; &#xD800;'), `${replacement} ${replacement}`, 'invalid code points become U+FFFD');
});

test('splitIntoSlides: titles decode entities once', () => {
    assert.equal(splitIntoSlides('<h2>A &amp;lt; B</h2>')[0].title, 'A &lt; B');
});

test('parseHtml: nesting, void elements, attributes and stray closing tags', () => {
    const root = slides.parseHtml('<p class="x" data-a=\'1\'>a<br>b <img src="s.png" alt="&quot;q&quot;"></p></span><p>c</p>');
    assert.equal(root.children.length, 2);
    const p = root.children[0];
    assert.deepEqual([p.tag, p.attrs.class, p.attrs['data-a']], ['p', 'x', '1']);
    assert.deepEqual(p.children.map(c => c.tag || c.text), ['a', 'br', 'b ', 'img']);
    assert.equal(p.children[3].attrs.alt, '"q"');
    assert.equal(slides.textContent(root), 'ab c');
    assert.equal(Object.getPrototypeOf(p.attrs), null, 'attrs have no prototype');
});

test('slideLineBudget: 18 single lines in landscape, 25 in portrait', () => {
    assert.equal(slides.slideLineBudget('landscape'), 18);
    assert.equal(slides.slideLineBudget('portrait'), 25);
});

test('paginateSection: a 30-line section continues on "(cont.)" slides within the budget', () => {
    const blocks = Array.from({length: 30}, (_, i) => ({kind: 'bullet', text: `Line ${i + 1}`, runs: [], level: 0}));
    for (const [orientation, sizes] of [['landscape', [18, 12]], ['portrait', [25, 5]]]) {
        const pages = slides.paginateSection({title: 'Long', blocks}, orientation);
        assert.deepEqual(pages.map(p => p.blocks.length), sizes, orientation);
        assert.deepEqual(pages.map(p => p.title), ['Long', 'Long (cont.)']);
        assert.deepEqual(pages.map(p => p.cont), [false, true]);
    }
    assert.deepEqual(slides.paginateSection({title: '', blocks}, 'landscape').map(p => p.title), ['', ''],
        'an untitled section stays untitled');
});

test('paginateSection: a short section is one slide; an empty one is one empty slide', () => {
    const one = slides.paginateSection({title: 'T', blocks: [{kind: 'para', text: 'x', runs: []}]}, 'portrait');
    assert.equal(one.length, 1);
    assert.deepEqual(slides.paginateSection({title: 'T', blocks: []}, 'portrait').map(p => p.blocks.length), [0]);
});

test('paginateSection: oversized paragraphs, bullets, code, rows and words never pass the bottom of a slide', () => {
    const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
    const codeLines = Array.from({length: 400}, (_, i) => `line ${i} ` + 'x'.repeat(i % 7 === 0 ? 300 : 20));
    const cases = {
        longpara: `<p>${'word '.repeat(3000)}</p>`,
        longbullet: `<ul><li>${'item '.repeat(3000)}</li><li>next</li></ul>`,
        longcode: `<pre><code>${esc(codeLines.join('\n'))}</code></pre>`,
        longrow: `<table><tr><th>a</th></tr><tr><td>${'cell '.repeat(3000)}</td></tr></table>`,
        hugeword: `<p>${'y'.repeat(20000)}</p>`,
        hugecodeline: `<pre><code>${'z'.repeat(20000)}</code></pre>`,
    };
    for (const orientation of ['portrait', 'landscape']) {
        const frame = slides.slideFrame(orientation);
        const limit = frame.ch - 0.1;
        for (const [name, html] of Object.entries(cases)) {
            const warnings = [];
            const pages = slides.paginateSection({title: 'T', blocks: slides.slideBlocks(html)}, orientation,
                {onWarning: (w) => warnings.push(w)});
            for (const [i, p] of pages.entries()) {
                const h = p.blocks.reduce((n, b) => n + slides.blockHeight(b, frame), 0);
                assert.ok(h <= limit + 1e-6, `${orientation} ${name} slide ${i + 1}: ${h.toFixed(2)} in > ${limit.toFixed(2)} in`);
            }
            const blocks = pages.flatMap(p => p.blocks);
            const text = blocks.map(b => b.kind === 'code' ? b.lines.join('\n') : b.text).join(' ');
            if (name === 'longpara') assert.equal(text.split(/\s+/).filter(w => w === 'word').length, 3000, 'every word kept');
            if (name === 'longbullet') {
                assert.equal(text.split(/\s+/).filter(w => w === 'item').length, 3000, 'every word kept');
                assert.ok(blocks.slice(1).filter(b => b.text !== 'next').every(b => b.cont), 'later parts continue the item');
            }
            if (name === 'longcode') assert.equal(blocks.flatMap(b => b.lines).join('\n'), codeLines.join('\n'), 'every line kept');
            if (name === 'hugeword') assert.equal(text.replace(/\s/g, '').length, 20000, 'every character kept');
            if (name === 'longrow' || name === 'hugecodeline') {
                assert.ok(warnings.length >= 1, `${name}: a warning says the text was cut`);
                assert.ok(text.includes('…'), `${name}: the cut is marked with an ellipsis`);
            } else {
                assert.deepEqual(warnings, [], `${name}: nothing cut`);
            }
        }
    }
});

test('slide model: 150,000 rows, cells or images do not overflow the call stack (no argument spreads)', () => {
    // V8 throws "Maximum call stack size exceeded" for an argument spread from about 125,000 items.
    const N = 150000;
    const cell = {text: 'x', header: false, colspan: 1, rowspan: 1, align: ''};
    const rows = Array.from({length: N}, () => [cell]);
    assert.equal(slides.tableColumns(rows), 1, 'columns over 150,000 rows');
    const frame = slides.slideFrame('landscape');
    assert.ok(slides.blockHeight({kind: 'table', rows: [Array.from({length: N}, () => cell)]}, frame) > 0, 'a 150,000-cell row');
    const blocks = slides.slideBlocks('<p>' + '<img src="data:image/png;base64,AA==" alt="">'.repeat(N) + '</p>');
    assert.equal(blocks.filter(b => b.kind === 'image').length, N, '150,000 images in one paragraph');
});

test('paginateSection: code taller than a slide splits by lines; a long table repeats its header', () => {
    const lines = Array.from({length: 80}, (_, i) => `line ${i}`);
    const code = slides.paginateSection({title: 'C', blocks: [{kind: 'code', lines, text: lines.join('\n')}]}, 'landscape');
    assert.ok(code.length > 1, 'split');
    assert.deepEqual(code.flatMap(p => p.blocks.flatMap(b => b.lines)), lines, 'every line once, in order');
    const cell = (text, header = false) => ({text, header, colspan: 1, rowspan: 1, align: ''});
    const rows = [[cell('H', true)], ...Array.from({length: 60}, (_, i) => [cell(`r${i}`)])];
    const table = slides.paginateSection({title: 'T', blocks: [{kind: 'table', rows, text: ''}]}, 'landscape');
    assert.ok(table.length > 1, 'split');
    for (const p of table) assert.equal(p.blocks[0].rows[0][0].text, 'H', 'header on every slide');
    assert.equal(table.reduce((n, p) => n + p.blocks[0].rows.length - 1, 0), 60, 'every body row once');
});

// ─────────────────────────────────────────────────────────────────────────────
// hexColor
// ─────────────────────────────────────────────────────────────────────────────

test('hexColor: strips # and uppercases', () => {
    assert.equal(hexColor('#1e3a5f'), '1E3A5F');
});

test('hexColor: falsy/empty falls back to 1E3A5F', () => {
    assert.equal(hexColor(''), '1E3A5F');
    assert.equal(hexColor(null), '1E3A5F');
    assert.equal(hexColor(undefined), '1E3A5F');
});

// ─────────────────────────────────────────────────────────────────────────────
// diskChangeAction
// ─────────────────────────────────────────────────────────────────────────────

test('diskChangeAction: no baseline → none', () => {
    assert.equal(diskChangeAction(null, 123, false), 'none');
});

test('diskChangeAction: unchanged → none', () => {
    assert.equal(diskChangeAction(100, 100, false), 'none');
});

test('diskChangeAction: changed and clean → reload', () => {
    assert.equal(diskChangeAction(100, 200, false), 'reload');
});

test('diskChangeAction: changed and dirty → conflict', () => {
    assert.equal(diskChangeAction(100, 200, true), 'conflict');
});

// ─────────────────────────────────────────────────────────────────────────────
// New-document shortcut (Alt+N, or Ctrl+Option+N on macOS)
// ─────────────────────────────────────────────────────────────────────────────

const shortcuts = await import('../js/shortcuts.js');
const key = (o) => ({key: 'n', code: 'KeyN', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...o});

test('isMacPlatform: userAgentData first, then navigator.platform', () => {
    assert.equal(shortcuts.isMacPlatform({userAgentData: {platform: 'macOS'}}), true);
    assert.equal(shortcuts.isMacPlatform({platform: 'MacIntel'}), true);
    assert.equal(shortcuts.isMacPlatform({userAgentData: {platform: 'Windows'}, platform: 'Win32'}), false);
    assert.equal(shortcuts.isMacPlatform({platform: 'Linux x86_64'}), false);
    assert.equal(shortcuts.isMacPlatform(undefined), false);
});

test('isNewDocShortcut: Alt+N off macOS', () => {
    assert.equal(shortcuts.isNewDocShortcut(key({altKey: true}), false), true);
    assert.equal(shortcuts.isNewDocShortcut(key({altKey: true, shiftKey: true}), false), false);
    assert.equal(shortcuts.isNewDocShortcut(key({ctrlKey: true}), false), false);
});

test('isNewDocShortcut: macOS leaves Option+N alone (dead key for ñ) and uses Ctrl+Option+N', () => {
    assert.equal(shortcuts.isNewDocShortcut(key({altKey: true, key: 'Dead'}), true), false);
    assert.equal(shortcuts.isNewDocShortcut(key({altKey: true}), true), false);
    assert.equal(shortcuts.isNewDocShortcut(key({ctrlKey: true, altKey: true, key: 'Dead'}), true), true);
    assert.equal(shortcuts.isNewDocShortcut(key({ctrlKey: true, altKey: true, metaKey: true}), true), false);
});

test('newDocShortcutLabel: platform-appropriate text', () => {
    assert.equal(shortcuts.newDocShortcutLabel(false), 'Alt+N');
    assert.equal(shortcuts.newDocShortcutLabel(true), 'Ctrl+Option+N');
});

test('shortcutFor: each binding names its command; other keys are left to the browser', () => {
    const k = (o) => key({key: '', code: '', ...o});
    const ctx = {isMac: false, editorFocused: true};
    assert.equal(shortcuts.shortcutFor(k({key: 'n', code: 'KeyN', altKey: true}), ctx), 'new');
    assert.equal(shortcuts.shortcutFor(k({key: 'o', ctrlKey: true}), ctx), 'open');
    assert.equal(shortcuts.shortcutFor(k({key: 's', metaKey: true}), ctx), 'save');
    assert.equal(shortcuts.shortcutFor(k({key: 'P', ctrlKey: true}), ctx), 'pdf');
    assert.equal(shortcuts.shortcutFor(k({key: 'k', ctrlKey: true}), ctx), 'palette');
    assert.equal(shortcuts.shortcutFor(k({key: 'b', ctrlKey: true}), ctx), 'bold');
    assert.equal(shortcuts.shortcutFor(k({key: 'i', ctrlKey: true}), ctx), 'italic');
    assert.equal(shortcuts.shortcutFor(k({key: '3', altKey: true}), ctx), 'recent-3');
    // Shift or Alt with Ctrl, a bare letter and Alt+0 are not the app's.
    assert.equal(shortcuts.shortcutFor(k({key: 's', ctrlKey: true, shiftKey: true}), ctx), null);
    assert.equal(shortcuts.shortcutFor(k({key: 'k', ctrlKey: true, altKey: true}), ctx), null);
    assert.equal(shortcuts.shortcutFor(k({key: 'k', ctrlKey: true, shiftKey: true}), ctx), null);
    assert.equal(shortcuts.shortcutFor(k({key: 's'}), ctx), null);
    assert.equal(shortcuts.shortcutFor(k({key: '0', altKey: true}), ctx), null);
    assert.equal(shortcuts.shortcutFor(k({key: '3', altKey: true, shiftKey: true}), ctx), null);
    assert.equal(shortcuts.shortcutFor(k({key: '3', altKey: true, ctrlKey: true}), ctx), null);
});

test('shortcutFor: off macOS, Alt+1 to Alt+9 match the physical digit key', () => {
    const k = (o) => key({key: '', code: '', ...o});
    const ctx = {isMac: false, editorFocused: true};
    assert.equal(shortcuts.shortcutFor(k({key: '3', code: 'Digit3', altKey: true}), ctx), 'recent-3');
    assert.equal(shortcuts.shortcutFor(k({key: '7', code: 'Numpad7', altKey: true}), ctx), 'recent-7');
    // AZERTY: the digit-row key without Shift types "\"", and Alt plus that key is still recent-3.
    assert.equal(shortcuts.shortcutFor(k({key: '"', code: 'Digit3', altKey: true}), ctx), 'recent-3');
    // The physical key wins over the typed character, and the modifier rules stay.
    assert.equal(shortcuts.shortcutFor(k({key: '3', code: 'KeyQ', altKey: true}), ctx), null);
    assert.equal(shortcuts.shortcutFor(k({key: '0', code: 'Digit0', altKey: true}), ctx), null);
    assert.equal(shortcuts.shortcutFor(k({key: '3', code: 'Digit3', altKey: true, shiftKey: true}), ctx), null, 'Alt+Shift is not used');
    assert.equal(shortcuts.shortcutFor(k({key: '3', code: 'Digit3', altKey: true, ctrlKey: true}), ctx), null, 'Ctrl+Alt is AltGr off macOS');
    assert.equal(shortcuts.shortcutFor(k({key: '3', code: 'Digit3', altKey: true, metaKey: true}), ctx), null);
    assert.equal(shortcuts.shortcutFor(k({key: '1', code: 'Digit1'}), ctx), null);
});

test('shortcutFor: on macOS, Option+digit types its character and Ctrl+Option+digit switches', () => {
    const k = (o) => key({key: '', code: '', ...o});
    const ctx = {isMac: true, editorFocused: true};
    // UK Mac: Option+3 types "#", Option+2 "€"; German Mac: Option+5 "[". These are typed, not shortcuts.
    assert.equal(shortcuts.shortcutFor(k({key: '#', code: 'Digit3', altKey: true}), ctx), null);
    assert.equal(shortcuts.shortcutFor(k({key: '€', code: 'Digit2', altKey: true}), ctx), null);
    assert.equal(shortcuts.shortcutFor(k({key: '[', code: 'Digit5', altKey: true}), ctx), null);
    assert.equal(shortcuts.shortcutFor(k({key: '3', altKey: true}), ctx), null, 'no code: still Option alone');
    // Ctrl+Option+digit, by the physical key.
    assert.equal(shortcuts.shortcutFor(k({key: '3', code: 'Digit3', altKey: true, ctrlKey: true}), ctx), 'recent-3');
    assert.equal(shortcuts.shortcutFor(k({key: '9', code: 'Numpad9', altKey: true, ctrlKey: true}), ctx), 'recent-9');
    assert.equal(shortcuts.shortcutFor(k({key: '‹', code: 'Digit3', altKey: true, ctrlKey: true, shiftKey: true}), ctx), null, 'Alt+Shift is not used');
    assert.equal(shortcuts.shortcutFor(k({key: '3', code: 'Digit3', altKey: true, ctrlKey: true, metaKey: true}), ctx), null);
    assert.equal(shortcuts.shortcutFor(k({key: '3', code: 'Digit3', ctrlKey: true}), ctx), null, 'Ctrl alone');
    assert.equal(shortcuts.recentShortcutLabel(true), 'Ctrl+Option+1…9');
    assert.equal(shortcuts.recentShortcutLabel(false), 'Alt+1…9');
});

test('initKeyboardShortcuts: macOS Option+3 keeps its default (types "#"); Ctrl+Option+3 switches once', () => {
    let listener = null;
    const ran = [];
    shortcuts.initKeyboardShortcuts({addEventListener: (_t, fn) => { listener = fn; }}, {
        isMac: true, isEditorFocused: () => true, resolve: (command) => () => ran.push(command),
    });
    const fire = (o) => {
        const e = {key: '#', code: 'Digit3', ctrlKey: false, metaKey: false, altKey: true, shiftKey: false, repeat: false, ...o,
            prevented: false, preventDefault() { this.prevented = true; }};
        listener(e);
        return e.prevented;
    };
    assert.equal(fire({}), false, 'Option+3 is typed');
    assert.deepEqual(ran, [], 'and switches nothing');
    assert.equal(fire({key: '3', ctrlKey: true}), true);
    assert.equal(fire({key: '3', ctrlKey: true, repeat: true}), true, 'a held key runs once');
    assert.deepEqual(ran, ['recent-3']);
});

test('sample: the welcome document names buttons and commands by the labels the UI shows', async () => {
    const {readFileSync} = await import('node:fs');
    const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
    const palette = readFileSync(new URL('../js/palette.js', import.meta.url), 'utf8');
    const {sampleMarkdown} = await import('../js/sample.js');
    const md = sampleMarkdown('Alt+N', 'Alt+1…9');
    const start = md.slice(md.indexOf('## Getting started'), md.indexOf('## Formatting toolbar'));
    const bold = [...start.matchAll(/\*\*([^*]+)\*\*/g)].map((m) => m[1]);
    assert.ok(bold.length > 0, 'Getting started names a control');
    for (const label of bold) assert.ok(html.includes(`>${label}<`), `"${label}" is a label in index.html`);
    // Every formatting button the toolbar table names, as the button shows it (its text, then
    // optionally its accessible name, as "``` Code block" or "HR (horizontal rule)").
    // Attributes as quoted values: a title such as "Blockquote  (> …)" holds a ">".
    const buttons = [...html.matchAll(/<button aria-label="([^"]+)"((?:\s+[\w-]+="[^"]*")*)>([\s\S]*?)<\/button>/g)]
        .filter((m) => /\sdata-fmt="/.test(m[2]))
        .map((m) => ({name: m[1], text: m[3].replace(/<[^>]+>/g, '').trim()}));
    assert.equal(buttons.length, 17, 'every formatting button read from index.html');
    const plain = (s) => s.replace(/^`` (.+) ``$/, '$1').replace(/\*\*|~~/g, '').replace(/^_(.+)_$/, '$1');
    const rows = md.slice(md.indexOf('| Group |'), md.indexOf('## Keyboard shortcuts')).split('\n').slice(2).filter(Boolean);
    assert.equal(rows.length, 5, 'Headings, Inline, Blocks, Lists, Insert');
    const named = new Set();
    for (const row of rows) {
        for (const item of /^\| [^|]+ \| (.+) \|$/.exec(row)[1].split(' · ')) {
            const p = plain(item);
            const b = buttons.find((x) => p === x.text || p === `${x.text} ${x.name}` || p === `${x.text} (${x.name.toLowerCase()})`);
            assert.ok(b, `"${item}" names a formatting button as the toolbar shows it`);
            named.add(b.name);
        }
    }
    assert.equal(named.size, buttons.length, 'the table names every formatting button once');
    const ctrlP = /^\| Ctrl\+P \/ Cmd\+P \| (.+) \|$/m.exec(md)[1];
    assert.ok(palette.includes(`label: '${ctrlP}'`), `"${ctrlP}" is the palette command Ctrl+P runs`);
    // The shortcut rows follow the platform.
    const mac = sampleMarkdown('Ctrl+Option+N', 'Ctrl+Option+1…9');
    assert.ok(/^\| Ctrl\+Option\+1…9 \| Switch to recent file \|$/m.test(mac), 'macOS: Ctrl+Option+1…9');
    assert.ok(/^\| Alt\+1…9 \| Switch to recent file \|$/m.test(md), 'elsewhere: Alt+1…9');
});

test('shortcutFor: Bold and Italic only while the editor has focus', () => {
    const k = (o) => key({key: '', code: '', ...o});
    assert.equal(shortcuts.shortcutFor(k({key: 'b', ctrlKey: true}), {editorFocused: false}), null);
    assert.equal(shortcuts.shortcutFor(k({key: 'i', ctrlKey: true}), {editorFocused: false}), null);
    assert.equal(shortcuts.shortcutFor(k({key: 'p', ctrlKey: true}), {editorFocused: false}), 'pdf');
});

test('initKeyboardShortcuts: prevents the default only for keys it acts on, and runs a held key once', () => {
    let listener = null;
    const target = {addEventListener: (type, fn) => { assert.equal(type, 'keydown'); listener = fn; }};
    const ran = [];
    shortcuts.initKeyboardShortcuts(target, {
        isMac: false,
        isEditorFocused: () => false,
        resolve: (command) => (command === 'recent-5' ? null : () => ran.push(command)),
    });
    const fire = (o) => {
        const e = {key: '', code: '', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, repeat: false, ...o,
            prevented: false, preventDefault() { this.prevented = true; }};
        listener(e);
        return e.prevented;
    };
    assert.equal(fire({key: 's', ctrlKey: true}), true);
    assert.equal(fire({key: 's', ctrlKey: true, repeat: true}), true);
    assert.equal(fire({key: '5', altKey: true}), false, 'nothing to open: the key keeps its default');
    assert.equal(fire({key: 'x', ctrlKey: true}), false);
    assert.deepEqual(ran, ['save']);
});

// ─────────────────────────────────────────────────────────────────────────────
// doc-meta.js: the one H1 title rule and the cover metadata
// ─────────────────────────────────────────────────────────────────────────────

import {readFileSync, readdirSync} from 'node:fs';

const docMeta = await import('../js/doc-meta.js');
const docmanagerModule = await import('../js/docmanager.js');

test('extractTitle: first "# " heading, trimmed', () => {
    assert.equal(docMeta.extractTitle('intro\n\n#   Quarterly Report  \n\n# Second'), 'Quarterly Report');
});

test('extractTitle: no H1 gives "Untitled"', () => {
    for (const src of ['', '## Only H2', '#NoSpace', 'plain text', null, undefined]) {
        assert.equal(docMeta.extractTitle(src), 'Untitled', JSON.stringify(src));
    }
});

test('deriveTitle (docmanager) is the doc-meta rule', () => {
    for (const src of ['# A', 'x\n# B c\n', '## no', '']) {
        assert.equal(docmanagerModule.deriveTitle(src), docMeta.extractTitle(src));
    }
});

test('buildDocMeta: title, en-AU long date, empty author, brand', () => {
    const meta = docMeta.buildDocMeta('# Plan\n\nbody', {date: new Date(2026, 0, 15)});
    assert.deepEqual(meta, {title: 'Plan', author: '', date: '15 January 2026', brand: ''});
});

test('buildDocMeta: defaults to today', () => {
    const today = new Date().toLocaleDateString('en-AU', {year: 'numeric', month: 'long', day: 'numeric'});
    assert.equal(docMeta.buildDocMeta('').date, today);
});

// ── Front matter ──

test('parseFrontMatter: key: value lines become meta and the block is stripped', () => {
    const r = docMeta.parseFrontMatter('---\ntitle: Plan\nauthor: Jo Bloggs\ndate: 2026-03-01\ntemplate: example-co\n---\n# Body\n\ntext');
    assert.deepEqual({...r.meta}, {title: 'Plan', author: 'Jo Bloggs', date: '2026-03-01', template: 'example-co'});
    assert.equal(r.body, '# Body\n\ntext');
});

test('parseFrontMatter: no block, or a block that does not start the file, leaves the source alone', () => {
    for (const src of ['# Plain', '', 'intro\n---\ntitle: X\n---\n', ' ---\ntitle: X\n---\n']) {
        const r = docMeta.parseFrontMatter(src);
        assert.deepEqual({...r.meta}, {}, JSON.stringify(src));
        assert.equal(r.body, src);
    }
    assert.equal(docMeta.parseFrontMatter(null).body, '');
});

test('parseFrontMatter: a missing closing line means no front matter', () => {
    const src = '---\ntitle: Plan\n\n# Heading';
    const r = docMeta.parseFrontMatter(src);
    assert.deepEqual({...r.meta}, {});
    assert.equal(r.body, src);
});

test('parseFrontMatter: CRLF line endings and a "..." closing line', () => {
    const r = docMeta.parseFrontMatter('---\r\ntitle: Plan\r\nauthor: Jo\r\n...\r\nbody\r\n');
    assert.deepEqual({...r.meta}, {title: 'Plan', author: 'Jo'});
    assert.equal(r.body, 'body\r\n');
});

test('parseFrontMatter: a leading BOM is skipped', () => {
    const r = docMeta.parseFrontMatter('﻿---\ntitle: Plan\n---\nbody');
    assert.equal(r.meta.title, 'Plan');
    assert.equal(r.body, 'body');
});

test('parseFrontMatter: colons in values, quotes, case-insensitive keys, comments', () => {
    const r = docMeta.parseFrontMatter('---\n# a comment\nTitle: "Q3: the plan"\nauthor: \'Jo: Ops\'\ndate: 10:30 on Monday\n---\n');
    assert.deepEqual({...r.meta}, {title: 'Q3: the plan', author: 'Jo: Ops', date: '10:30 on Monday'});
    assert.equal(r.body, '');
});

test('parseFrontMatter: duplicate keys, the last one wins; unknown keys are ignored', () => {
    const r = docMeta.parseFrontMatter('---\ntitle: First\ntitle: Second\nsubtitle: nope\ntags:\n  - a\n---\nx');
    assert.deepEqual({...r.meta}, {title: 'Second'});
    assert.equal(r.body, 'x');
});

test('parseFrontMatter: hostile values stay inert text, capped and without control characters', () => {
    const long = 'x'.repeat(5000);
    const r = docMeta.parseFrontMatter(`---\ntitle: <img src=x onerror=alert(1)>\nauthor: a\u0000b\u001bc‮d\ndate: ${long}\n__proto__: polluted\nconstructor: bad\n---\n`);
    assert.equal(r.meta.title, '<img src=x onerror=alert(1)>', 'kept as text: templates escape it');
    assert.equal(r.meta.author, 'abcd');
    assert.equal(r.meta.date.length, docMeta.META_MAX_LENGTH);
    assert.equal(Object.getPrototypeOf(r.meta), null, 'meta has no prototype');
    assert.deepEqual(Object.keys(r.meta).sort(), ['author', 'date', 'title']);
    assert.equal(({}).polluted, undefined);
});

test('parseFrontMatter: a block of plain text between rules is Markdown, not front matter', () => {
    for (const src of ['---\nJust a paragraph\n---\nmore', '---\n---\nbody', '---\n\n---\n']) {
        const r = docMeta.parseFrontMatter(src);
        assert.deepEqual({...r.meta}, {}, JSON.stringify(src));
        assert.equal(r.body, src);
    }
});

test('parseFrontMatter: empty values count as absent', () => {
    const r = docMeta.parseFrontMatter('---\ntitle:\nauthor: ""\ndate: Spring\n---\n');
    assert.deepEqual({...r.meta}, {date: 'Spring'});
});

test('extractTitle: an H1 title gets the same cleaning as front matter (no bidi or control characters, capped)', () => {
    assert.equal(docMeta.extractTitle('# Invoice ‮fdp.exe'), 'Invoice fdp.exe');
    assert.equal(docMeta.extractTitle('# a⁦b⁩c\u0007d'), 'abcd');
    assert.equal(docMeta.extractTitle(`# ${'x'.repeat(5000)}`).length, docMeta.META_MAX_LENGTH);
    assert.equal(docMeta.extractTitle('# ‮‭'), 'Untitled', 'nothing left: the default title');
    assert.equal(docMeta.buildDocMeta('# Invoice ‮fdp.exe').title, 'Invoice fdp.exe');
});

test('extractTitle: a front matter title wins over the first H1', () => {
    assert.equal(docMeta.extractTitle('---\ntitle: From Meta\n---\n# From Heading'), 'From Meta');
    assert.equal(docMeta.extractTitle('---\nauthor: Jo\n---\n# From Heading'), 'From Heading');
});

test('buildDocMeta: front matter title, author and date reach the cover metadata', () => {
    const meta = docMeta.buildDocMeta('---\ntitle: Plan\nauthor: Jo\ndate: 2026-03-01\n---\n# Heading', {today: new Date(2026, 0, 15)});
    assert.deepEqual(meta, {title: 'Plan', author: 'Jo', date: '1 March 2026', brand: ''});
    assert.equal(docMeta.buildDocMeta('---\ndate: Spring 2026\n---\n').date, 'Spring 2026', 'free-text dates are kept');
    assert.equal(docMeta.buildDocMeta('---\ndate: 2026-13-45\n---\n').date, '2026-13-45', 'an impossible ISO date is kept as written');
});

test('buildDocMeta: explicit options win over front matter', () => {
    const src = '---\ntitle: Meta\nauthor: Meta Author\ndate: 2026-03-01\n---\n# H';
    const meta = docMeta.buildDocMeta(src, {title: 'Option', author: 'Opt', date: '2026-02-02'});
    assert.deepEqual(meta, {title: 'Option', author: 'Opt', date: '2 February 2026', brand: ''});
    assert.equal(docMeta.buildDocMeta(src, {title: '', author: ''}).title, 'Meta', 'empty options fall through');
    assert.equal(docMeta.buildDocMeta(src, {date: new Date(2026, 4, 9)}).date, '9 May 2026', 'an explicit Date wins too');
    assert.equal(docMeta.buildDocMeta('# H', {today: new Date(2026, 4, 9)}).date, '9 May 2026', 'today is the fallback');
});

test('the H1 title regex lives only in js/doc-meta.js', () => {
    assert.ok(docMeta.H1_TITLE_RE instanceof RegExp, 'H1_TITLE_RE exported');
    const needle = String.raw`/^#\s+(.+)$/m`;
    for (const file of readdirSync(new URL('../js/', import.meta.url))) {
        if (!file.endsWith('.js') || file === 'doc-meta.js') continue;
        const src = readFileSync(new URL(`../js/${file}`, import.meta.url), 'utf8');
        assert.ok(!src.includes(needle), `js/${file} has its own copy of the title regex`);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// download.js: toFilenameSafe
// ─────────────────────────────────────────────────────────────────────────────

const download = await import('../js/download.js');

test('toFilenameSafe: reserved characters become spaces, whitespace collapses', () => {
    assert.equal(download.toFilenameSafe('Q1/Q2: "Plan" <draft> a\\b|c*d?'), 'Q1 Q2 Plan draft a b c d');
    assert.equal(download.toFilenameSafe('a   b\tc'), 'a b c');
});

test('toFilenameSafe: control characters are removed', () => {
    assert.equal(download.toFilenameSafe('a\u0000b\u001fc\u007fd\u009f'), 'abcd');
    assert.equal(download.toFilenameSafe('line one\nline two'), 'line one line two', 'line breaks count as spaces');
});

test('toFilenameSafe: leading and trailing dots and spaces are trimmed', () => {
    assert.equal(download.toFilenameSafe('  ..Report.. '), 'Report');
    assert.equal(download.toFilenameSafe('v1.2 notes'), 'v1.2 notes');
});

test('toFilenameSafe: nothing usable falls back to the default', () => {
    for (const bad of ['', '   ', '...', '???', '\u0000', null, undefined]) {
        assert.equal(download.toFilenameSafe(bad), 'document', JSON.stringify(bad));
    }
    assert.equal(download.toFilenameSafe('', 'presentation'), 'presentation');
});

test('toFilenameSafe: Windows device names get a suffix', () => {
    assert.equal(download.toFilenameSafe('CON'), 'CON_');
    assert.equal(download.toFilenameSafe('lpt1'), 'lpt1_');
    assert.equal(download.toFilenameSafe('Console'), 'Console');
});

test('toFilenameSafe: length is capped without splitting a character', () => {
    assert.equal(download.toFilenameSafe('x'.repeat(300)).length, 100);
    assert.equal(download.toFilenameSafe('x'.repeat(300), 'document', 20), 'x'.repeat(20));
    const emoji = download.toFilenameSafe('\u{1F600}'.repeat(150));
    assert.equal(Array.from(emoji).length, 100);
    assert.ok(Array.from(emoji).every((c) => c === '\u{1F600}'), 'no broken surrogate pair');
    assert.equal(download.toFilenameSafe('a'.repeat(99) + ' b', 'document', 100), 'a'.repeat(99), 'trailing space trimmed after the cut');
});

test('toFilenameSafe: Unicode text is kept', () => {
    const emDash = String.fromCharCode(0x2014);   // built here so the source has no em-dash (house style)
    assert.equal(download.toFilenameSafe(`Café résumé ${emDash} 2026`), `Café résumé ${emDash} 2026`);   // an em-dash is kept
});

test('Word, PowerPoint and Save use the shared download helpers', () => {
    for (const file of ['docx-export.js', 'pptx-export.js', 'disk-sync.js']) {
        const src = readFileSync(new URL(`../js/${file}`, import.meta.url), 'utf8');
        assert.ok(!src.includes('createObjectURL'), `js/${file} builds its own object URL`);
        assert.ok(!/function toFilenameSafe/.test(src), `js/${file} has its own toFilenameSafe`);
        assert.match(src, /from '\.\/download\.js'/, `js/${file} imports js/download.js`);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// fonts.js: vendored brand fonts
// ─────────────────────────────────────────────────────────────────────────────

const fonts = await import('../js/fonts.js');
const TEMPLATE_STYLES = STYLE_OF;

test('fontFaceCSS: one block-display @font-face per face, URLs under the given base', () => {
    const css = fonts.fontFaceCSS('https://cdn.example/app/vendor/fonts/');
    const rules = css.match(/@font-face\s*\{[^}]*\}/g) || [];
    assert.equal(rules.length, fonts.FONT_FACES.length);
    for (const rule of rules) {
        assert.match(rule, /font-display: block;/);
        assert.match(rule, /src: url\("https:\/\/cdn\.example\/app\/vendor\/fonts\/[a-z0-9-]+\/[a-z0-9-]+\.woff2"\) format\("woff2"\);/);
    }
});

test('fontFaceCSS: default base is vendor/fonts/ next to js/, from import.meta.url', () => {
    const css = fonts.fontFaceCSS();
    const base = new URL('../vendor/fonts/', import.meta.url).href;
    assert.ok(css.includes(`url("${base}montserrat/montserrat-latin-700-normal.woff2")`), 'absolute URL from the module location');
});

test('every face the templates use is vendored, and every file exists', () => {
    const want = [
        ...[300, 400, 500, 600, 700, 800, 900].map((w) => `Montserrat ${w} normal`),
        'Montserrat 400 italic', 'Montserrat 600 italic',
        ...[400, 500, 600, 700].map((w) => `Inter ${w} normal`), 'Inter 400 italic', 'Inter 700 italic',
        ...[400, 600, 700].map((w) => `Source Serif Pro ${w} normal`), 'Source Serif Pro 400 italic', 'Source Serif Pro 700 italic',
        // The new templates' families (tests/template-platform.test.mjs checks their weight ranges).
        ...[400, 500, 600, 700, 800].map((w) => `Figtree ${w} normal`), 'Figtree 400 italic',
        ...[500, 600, 700].map((w) => `Fraunces ${w} normal`), 'Fraunces 400 italic',
        ...[500, 700, 800].map((w) => `Schibsted Grotesk ${w} normal`), 'Schibsted Grotesk 500 italic',
        ...[400, 700].map((w) => `Libre Caslon Text ${w} normal`), 'Libre Caslon Text 400 italic',
        ...[600, 700, 800].map((w) => `Plus Jakarta Sans ${w} normal`),
        ...[400, 500, 600, 700].map((w) => `IBM Plex Sans ${w} normal`), 'IBM Plex Sans 400 italic',
        ...[500, 600, 700].map((w) => `Lora ${w} normal`), 'Lora 500 italic',
        ...[400, 500, 700].map((w) => `DM Sans ${w} normal`),
    ];
    for (const subset of ['latin', 'latin-ext']) {
        const have = fonts.FONT_FACES.filter((f) => f.subset === subset).map((f) => `${f.family} ${f.weight} ${f.style}`);
        assert.deepEqual([...have].sort(), [...want].sort(), `${subset} faces`);
    }
    // The code font is the complete font, one file per style.
    const mono = fonts.FONT_FACES.filter((f) => f.subset === 'all').map((f) => `${f.family} ${f.weight} ${f.style}`);
    assert.deepEqual(mono, ['Source Code Pro 400 normal', 'Source Code Pro 700 normal', 'Source Code Pro 400 italic', 'Source Code Pro 700 italic']);
    // The symbol fallbacks: Source Code Pro limited to symbol ranges, and Noto Sans Symbols 2.
    const symbols = fonts.FONT_FACES.filter((f) => f.subset === 'symbols').map((f) => `${f.family} ${f.weight} ${f.style}`);
    assert.deepEqual(symbols, ['Source Code Pro Symbols 400 normal', 'Source Code Pro Symbols 700 normal',
        'Noto Sans Symbols 2 400 normal', 'Noto Sans Symbols 400 normal']);
    assert.equal(fonts.FONT_FACES.length, want.length * 2 + 4 + 4, 'latin and latin-ext, the code font and the symbol fallbacks');
    for (const f of fonts.FONT_FACES) {
        const buf = readFileSync(new URL(`../vendor/fonts/${f.file}`, import.meta.url));
        assert.equal(buf.subarray(0, 4).toString('latin1'), 'wOF2', `${f.file} is a woff2 file`);
    }
    for (const dir of ['montserrat', 'inter', 'source-serif-pro', 'source-code-pro', 'noto-sans-symbols-2', 'noto-sans-symbols',
        'figtree', 'fraunces', 'schibsted-grotesk', 'libre-caslon-text', 'plus-jakarta-sans', 'ibm-plex-sans', 'lora', 'dm-sans']) {
        assert.match(readFileSync(new URL(`../vendor/fonts/${dir}/OFL.txt`, import.meta.url), 'utf8'), /SIL Open Font License/);
    }
});

/** True when a unicode-range string (U+0100-02BA,U+0304,...) covers the code point. */
function rangeCovers(range, cp) {
    return range.split(',').some((part) => {
        const [lo, hi] = part.trim().replace(/^U\+/i, '').split('-').map((h) => parseInt(h, 16));
        return cp >= lo && cp <= (hi === undefined ? lo : hi);
    });
}

test('fontFaceCSS: every subset rule has its unicode-range; latin-ext covers Central European and Maori letters', () => {
    const css = fonts.fontFaceCSS('https://x.example/');
    for (const rule of css.match(/@font-face\s*\{[^}]*\}/g)) {
        if (rule.includes("'Source Code Pro'")) assert.doesNotMatch(rule, /unicode-range/, 'the complete code font has no range');
        else assert.match(rule, /unicode-range: U\+[0-9A-F]+/i, 'unicode-range set: ' + rule);
    }
    const sample = 'Dvořák in Łódź, Māori, Ștefan';
    for (const family of ['Montserrat', 'Inter', 'Source Serif Pro']) {
        const faces = fonts.FONT_FACES.filter((f) => f.family === family && f.weight === 400 && f.style === 'normal');
        const latin = faces.find((f) => f.subset === 'latin');
        const ext = faces.find((f) => f.subset === 'latin-ext');
        assert.ok(latin && ext, `${family} has both subsets`);
        for (const ch of sample) {
            const cp = ch.codePointAt(0);
            assert.ok(rangeCovers(latin.unicodeRange, cp) || rangeCovers(ext.unicodeRange, cp), `${family} covers ${ch}`);
        }
        assert.ok(!rangeCovers(ext.unicodeRange, 'a'.codePointAt(0)), `${family}: ASCII is not in latin-ext, so it is fetched only when needed`);
        for (const blocked of [0x0416, 0x03A9]) {   // Cyrillic, Greek: not vendored
            assert.ok(!rangeCovers(latin.unicodeRange, blocked) && !rangeCovers(ext.unicodeRange, blocked), `${family} has no Cyrillic/Greek`);
        }
    }
});

test('templates load no remote fonts and name families that are vendored', () => {
    const families = new Set(fonts.FONT_FACES.map((f) => f.family));
    for (const [id, css] of Object.entries(TEMPLATE_STYLES)) {
        assert.ok(!/@import|fonts\.googleapis|fonts\.gstatic/.test(css), `${id} still loads remote fonts`);
        const first = /--[a-z]+-(?:font|serif|sans):\s*'?([^',;]+)/.exec(css);
        assert.ok(first && families.has(first[1].trim()), `${id} brand font ${first && first[1]} is vendored`);
        const mono = /--[a-z]+-mono:\s*'?([^',;]+)/.exec(css);
        assert.ok(mono && mono[1].trim() === 'Source Code Pro', `${id} code font ${mono && mono[1]} is the vendored Source Code Pro`);
        // Every text stack falls back to the vendored symbol faces before any system font.
        for (const [, name, stack] of css.matchAll(/(--[a-z]+-(?:font|serif|sans|mono)):\s*([^;]+);/g)) {
            const families = stack.split(',').map((s) => s.trim().replace(/^'|'$/g, ''));
            const firstSystem = families.findIndex((f) => !fonts.FONT_FACES.some((face) => face.family === f));
            assert.ok(firstSystem > 0 && families.slice(0, firstSystem).includes('Noto Sans Symbols 2')
                && families.slice(0, firstSystem).includes('Noto Sans Symbols'),
                `${id} ${name}: vendored symbol faces before ${families[firstSystem]}`);
            if (!name.endsWith('-mono')) assert.ok(stack.includes(fonts.SYMBOL_FALLBACK_FAMILIES), `${id} ${name} lists both symbol faces`);
        }
    }
});

test('template covers fill the printed page through --bd-page-height', () => {
    for (const [id, css] of Object.entries(TEMPLATE_STYLES)) {
        assert.ok(!/min-height:\s*297mm/.test(css), `${id} still hard-codes min-height: 297mm`);
        assert.match(css, /@media print\s*\{\s*\.template-[a-z0-9-]+ \.cover-page\s*\{\s*min-height: var\(--bd-page-height, 297mm\);/,
            `${id} print cover uses --bd-page-height`);
    }
});

test('preview: the cover card is full bleed like the PDF cover, so no padding and no page margin around it', () => {
    const css = readFileSync(new URL('../css/app.css', import.meta.url), 'utf8');
    // The page card rule is `#preview-pane .preview-page` (an id), so a bare `.preview-page-cover` rule loses to it
    // and leaves the cover inside 60 px of white. The cover rule needs the same weight.
    assert.match(css, /#preview-pane \.preview-page-cover\s*\{[^}]*padding:\s*0\b/, 'the cover card rule is as specific as the page card rule');
});

test('preview: a cover is as tall as its page in both orientations, so a full-page cover design lays out as in the PDF', () => {
    const css = readFileSync(new URL('../css/app.css', import.meta.url), 'utf8');
    // A height, not a min-height: a cover that sizes its grid or container against the page (percent heights, a size
    // container) collapses to its content on screen when only a min-height is set. cqw is the card's own width, so the
    // height follows the card when the pane is narrower than the page.
    assert.match(css, /#preview-pane \.preview-page-cover \.cover-page\s*\{[^}]*height:\s*calc\(100cqw \* var\(--preview-page-aspect/,
        'every cover gets the page height from the card width and the page aspect');
    assert.match(css, /#preview-pane \.preview-page-cover\s*\{[^}]*container-type:\s*inline-size/, 'the card is the container for cqw');
});

test('the print document includes the font faces', () => {
    const html = buildPrintDocument({bodyHTML: '<p>x</p>'});
    assert.ok(html.includes(fonts.fontFaceCSS()), 'default font CSS embedded');
    assert.ok(!buildPrintDocument({fontCSS: ''}).includes('@font-face'), 'fontCSS: "" leaves them out');
});

// ─────────────────────────────────────────────────────────────────────────────
// Content Security Policy (index.html)
// ─────────────────────────────────────────────────────────────────────────────

import * as markdownModule from '../js/markdown.js';

const INDEX_HTML = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

function cspFromIndex() {
    const metas = [...INDEX_HTML.matchAll(/<meta\s[^>]*http-equiv=["']Content-Security-Policy["'][^>]*>/gi)];
    assert.equal(metas.length, 1, 'exactly one CSP meta');
    const content = /content=(["'])([\s\S]*?)\1/i.exec(metas[0][0]);
    assert.ok(content, 'CSP meta has content');
    const directives = {};
    for (const part of content[2].split(';')) {
        const [name, ...values] = part.trim().split(/\s+/);
        if (name) directives[name.toLowerCase()] = values;
    }
    return {raw: content[2], directives, tag: metas[0][0]};
}

test('CSP: meta is the first element after <meta charset>', () => {
    const {tag} = cspFromIndex();
    const head = INDEX_HTML.slice(INDEX_HTML.indexOf('<head>') + 6);
    const tags = [...head.matchAll(/<(?!!--)[a-z][^>]*>/gi)].map(m => m[0]);
    assert.match(tags[0], /<meta\s+charset=/i, 'charset meta first');
    assert.equal(tags[1], tag, 'CSP meta second');
});

test('CSP: strict base directives', () => {
    const {directives: d} = cspFromIndex();
    assert.deepEqual(d['default-src'], ["'self'"]);
    assert.deepEqual(d['form-action'], ["'none'"]);
    assert.deepEqual(d['base-uri'], ["'none'"]);
    assert.deepEqual(d['object-src'], ["'none'"]);
});

test('CSP: fonts come only from the app itself', () => {
    const {raw, directives: d} = cspFromIndex();
    assert.deepEqual(d['font-src'], ["'self'"]);
    assert.ok(!/fonts\.googleapis\.com|fonts\.gstatic\.com/.test(raw), 'no Google Fonts hosts in the policy');
});

test('CSP: scripts are never inline, eval-based, or from arbitrary hosts', () => {
    const {raw, directives: d} = cspFromIndex();
    assert.ok(!raw.includes("'unsafe-eval'"), "no 'unsafe-eval' anywhere");
    const scriptSrc = d['script-src'] || d['default-src'];
    for (const bad of ["'unsafe-inline'", '*', 'https:', 'http:', 'data:', 'blob:']) {
        assert.ok(!scriptSrc.includes(bad), `script-src must not allow ${bad}`);
    }
    assert.ok(scriptSrc.includes("'self'"), "script-src includes 'self'");
});

test('CSP: frames allow exactly the sanitiser iframe hosts plus Google sign-in and picker', () => {
    const {directives: d} = cspFromIndex();
    const frameSrc = d['frame-src'] || [];
    assert.ok(markdownModule.IFRAME_HOSTS, 'markdown.js exports IFRAME_HOSTS');
    for (const host of markdownModule.IFRAME_HOSTS) {
        assert.ok(frameSrc.includes(`https://${host}`), `frame-src includes https://${host}`);
    }
    assert.ok(!frameSrc.includes('*') && !frameSrc.includes('https:'), 'no wildcard frames');
});

test('CSP: index.html has no inline scripts or inline event handlers', () => {
    for (const m of INDEX_HTML.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
        assert.match(m[1], /\ssrc=/i, 'every script has a src');
        assert.equal(m[2].trim(), '', 'no inline script body');
    }
    assert.doesNotMatch(INDEX_HTML, /<[a-z][^>]*\son[a-z]+\s*=/i, 'no on* attributes');
});

// ─────────────────────────────────────────────────────────────────────────────
// Boot: what index.html loads before the app is usable
// ─────────────────────────────────────────────────────────────────────────────

test('boot: index.html loads no export library (JSZip, PptxGenJS and its built-in guards load on first export)', () => {
    const scripts = [...INDEX_HTML.matchAll(/<script\b[^>]*\ssrc="([^"]+)"/gi)].map((m) => m[1]);
    for (const late of ['jszip', 'pptxgen', 'builtins-save', 'builtins-restore']) {
        assert.ok(!scripts.some((s) => s.includes(late)), `${late} is loaded at startup: ${scripts.join(', ')}`);
    }
});

test('boot: the app module graph stays shallow (each level is a round trip before the app can start)', () => {
    const root = new URL('../', import.meta.url);
    const depthOf = new Map();
    const importsOf = (file) => [...readFileSync(file, 'utf8').matchAll(/^\s*import\s+(?:[^'"]*?from\s+)?['"](\.[^'"]+)['"]/gm)]
        .map((m) => new URL(m[1], file));
    const depth = (url) => {
        const key = url.href;
        if (depthOf.has(key)) return depthOf.get(key);
        depthOf.set(key, 1);
        const d = 1 + Math.max(0, ...importsOf(url).map(depth));
        depthOf.set(key, d);
        return d;
    };
    const d = depth(new URL('js/app.js', root));
    assert.ok(d <= 6, `the static import chain from js/app.js is ${d} modules deep`);
    assert.ok(depthOf.size <= 45, `js/app.js pulls in ${depthOf.size} modules at startup`);
});

test('templateFaces: the faces a template names, latin subset or the whole code font, no symbol fallbacks', () => {
    const faces = fonts.templateFaces(getTemplates()[0].styles);
    assert.ok(faces.length > 0, 'the default template names vendored fonts');
    assert.ok(faces.every((f) => f.subset === 'latin' || f.subset === 'all'), 'no latin-ext or symbols subset');
    assert.ok(faces.some((f) => f.family === 'Source Code Pro'), 'the code font');
    assert.ok(!faces.some((f) => /Symbols/.test(f.family)), 'symbol fallbacks load only when used');
    assert.deepEqual(fonts.templateFaces('body { font-family: Georgia; }'), [], 'nothing for a template with no vendored font');
});
