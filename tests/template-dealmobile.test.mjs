/**
 * tests/template-dealmobile.test.mjs
 *
 * The dealmobile template (templates/dealmobile/template.js): the article-opener
 * cover (last title word in red italic, meta column, subject panel), how it
 * copes with a missing author, date or subject, the running head and foot, the
 * fonts it names, the print rules a template must keep (no blurred shadows, no
 * filters), the contrast of its colours and its manifest entry. The PDFs
 * themselves are checked with server/qa/pdf-qa.mjs (README, Checklist for a
 * new template).
 *
 * Company layer, like the template (deploy/public-edition.json).
 * Run: node --test tests/template-dealmobile.test.mjs
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {FONT_FAMILIES} from '../js/fonts.js';
import {RUNNING_TOKENS, RUNNING_LIMITS} from '../js/page-chrome.js';
import {baseStyles} from '../templates/_shared/base.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ID = 'dealmobile';
const mod = await import(`../templates/${ID}/template.js`);

const DOC = {title: 'Quarterly results explained', author: 'Jo Example', date: '1 November 2026', subject: 'What changed and why', brand: ''};

function luminance(hex) {
    const [r, g, b] = hex.slice(1).match(/../g).map((x) => parseInt(x, 16) / 255)
        .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrast = (a, b) => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
};
/** The hex value of a custom property in the styles. */
const token = (name) => {
    const m = mod.styles.match(new RegExp(`${name}:\\s*(#[0-9a-f]{6})`, 'i'));
    assert.ok(m, `${name} is defined`);
    return m[1].toLowerCase();
};

test('dealmobile: module shape, id and page settings', () => {
    const {manifest, styles, default: tpl} = mod;
    assert.equal(manifest.id, ID);
    assert.equal(tpl.id, ID);
    assert.equal(typeof styles, 'string');
    assert.equal(typeof tpl.renderCover, 'function');
    assert.equal(typeof tpl.transformHTML, 'function');
    assert.equal(typeof tpl.preflightChecks, 'function');
    assert.match(manifest.accent, /^#[0-9a-f]{6}$/i);
    const mm = parseFloat(manifest.page.margin);
    assert.match(manifest.page.margin, /^\d+(\.\d+)?mm$/);
    assert.ok(mm >= RUNNING_LIMITS.minMarginMm, 'the margin leaves room for the running head and foot');
    assert.equal(tpl.transformHTML('<p>x</p>'), '<p>x</p>', 'the body is left as it is');
});

test('dealmobile: cover has the title with its last word in red italic, the meta column and the subject panel', () => {
    const html = mod.default.renderCover(DOC);
    assert.match(html, /^<div class="cover-page[ "]/);
    assert.match(html, /Quarterly results <em class="ed-last">explained<\/em>/);
    assert.ok(html.includes('Jo Example') && html.includes('1 November 2026'));
    assert.match(html, /class="ed-panel"[\s\S]*What changed and why/);
    assert.ok(!/undefined|null/.test(html));
});

test('dealmobile: a one-word title is all red italic; long titles step the size down', () => {
    assert.match(mod.default.renderCover({...DOC, title: 'Manifesto'}), /<em class="ed-last">Manifesto<\/em>/);
    const size = (title) => mod.default.renderCover({...DOC, title}).match(/ed-title ed-size-(\w+)/)[1];
    assert.equal(size('Short title'), 'l');
    assert.notEqual(size('A considerably longer headline that runs over several lines of the cover page'), 'l');
    assert.equal(size('word '.repeat(40).trim()), 's');
});

test('dealmobile: cover text is escaped', () => {
    const html = mod.default.renderCover({...DOC, title: '<script>x</script> & "y"', author: '<b>a</b>', subject: '<i>s</i>'});
    assert.ok(!html.includes('<script>') && !html.includes('<b>a') && !html.includes('<i>s'));
    assert.ok(html.includes('&lt;script&gt;') && html.includes('&amp;'));
});

test('dealmobile: no empty labels and no "undefined" when author, date or subject is missing', () => {
    const bare = mod.default.renderCover({title: 'Only a title', author: '', date: '', subject: '', brand: ''});
    assert.ok(!/undefined|null/.test(bare));
    assert.ok(!bare.includes('Prepared by'), 'no author label');
    assert.ok(!bare.includes('Published'), 'no date label');
    assert.ok(!bare.includes('ed-panel'), 'no subject panel');
    const noSubject = mod.default.renderCover({...DOC, subject: ''});
    assert.ok(!noSubject.includes('ed-panel') && noSubject.includes('Prepared by'));
    const undef = mod.default.renderCover({title: 'T'});
    assert.ok(!/undefined|null/.test(undef));
});

test('dealmobile: running head and foot use known tokens, a vendored font and page numbers', () => {
    const {runningHead, runningFoot, runningStyle, runningLogo} = mod.default;
    assert.equal(runningLogo, undefined, 'no logo');
    const slots = [...Object.values(runningHead), ...Object.values(runningFoot)];
    for (const text of slots) {
        for (const [, name] of text.matchAll(/\{(\w+)\}/g)) assert.ok(RUNNING_TOKENS.includes(name), name);
    }
    assert.ok(slots.some((t) => t.includes('{page}')) && slots.some((t) => t.includes('{pages}')));
    assert.ok(FONT_FAMILIES.includes(runningStyle.fontFamily), runningStyle.fontFamily);
    assert.ok(contrast(runningStyle.color, '#ffffff') >= 4.5, 'running text contrast');
});

test('dealmobile: every font family it names is vendored, and the brand faces are the two in the brief', () => {
    // The template's own rules: the shared base (code label font stack) is checked elsewhere.
    const own = mod.styles.slice(baseStyles(ID, {codeTheme: 'light'}).length);
    const named = new Set();
    for (const [, list] of own.matchAll(/(?:font-family|--ed-(?:serif|sans|mono)):\s*([^;]+);/g)) {
        for (const raw of list.split(',')) named.add(raw.trim().replace(/^['"]|['"]$/g, ''));
    }
    const generic = new Set(['serif', 'sans-serif', 'monospace', 'inherit']);
    for (const name of named) {
        if (generic.has(name) || name.startsWith('var(')) continue;
        assert.ok(FONT_FAMILIES.includes(name), `${name} is vendored`);
    }
    assert.ok(named.has('Schibsted Grotesk') && named.has('Libre Caslon Text') && named.has('Source Code Pro'));
});

test('dealmobile: nothing that rasterises in print (blurred shadows, filters)', () => {
    assert.ok(!/filter\s*:/.test(mod.styles), 'no filter');
    for (const [, v] of mod.styles.matchAll(/box-shadow:\s*([^;]+);/g)) {
        assert.ok(v.trim() === 'none' || !/\d+px\s+\d+px\s+[1-9]/.test(v), `box-shadow without blur: ${v}`);
    }
});

test('dealmobile: colours meet contrast on white and on the code paper', () => {
    const white = '#ffffff';
    for (const name of ['--ed-ink', '--ed-body', '--ed-muted', '--ed-red']) {
        assert.ok(contrast(token(name), white) >= 4.5, `${name} on white`);
    }
    assert.ok(contrast(token('--ed-body'), token('--ed-paper')) >= 4.5, 'body on paper');
    assert.ok(contrast(token('--ed-muted'), token('--ed-paper')) >= 4.5, 'muted on paper');
    assert.ok(contrast(token('--ed-red'), token('--ed-paper')) >= 4.5, 'red on paper');
});

test('dealmobile: listed in a manifest with a description and its page sizes (under "New" in the company one)', () => {
    // The private repository lists it in the company manifest; a build that moves it into the core set lists it there.
    const companyFile = join(ROOT, 'templates/manifest.company.json');
    const file = existsSync(companyFile) ? companyFile : join(ROOT, 'templates/manifest.core.json');
    const entry = JSON.parse(readFileSync(file, 'utf8')).templates.find((t) => t.id === ID);
    assert.ok(entry, 'listed');
    assert.equal(entry.path, `templates/${ID}/template.js`);
    if (file === companyFile) assert.equal(entry.group, 'New');
    assert.ok(entry.description && entry.description.length <= 200);
    assert.deepEqual(mod.manifest.page.sizes, ['A4', 'A3', 'A5', 'Letter', 'Legal']);
});
