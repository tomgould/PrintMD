/**
 * tests/markdown-deflist.test.mjs
 *
 * The definition-list block extension in js/markdown.js (PHP Markdown Extra /
 * Pandoc style):
 *
 *     Term
 *     :   The definition of the term.
 *
 * A term is one line of text; each definition line starts with a colon and at
 * least one space or tab, and may continue on lines indented by 4 spaces or a
 * tab. Inline Markdown works inside terms and definitions. One or more terms
 * with their definitions form one dl with dt and dd children. Alongside each
 * syntax, the prose that must stay as typed is checked: an emoji line, a
 * colon line after a blank line, and colons inside fenced code and code spans
 * are never read as a definition list.
 *
 * The vendor bundles index.html loads as <script> globals are evaluated here,
 * so js/markdown.js sees marked in Node, and the output is the configured
 * marked.parse(): the HTML renderMarkdown() hands to the existing sanitiser
 * (dl, dt and dd are in its allow-list; DOMPurify needs a DOM, so that
 * pass-through is covered by the browser pages, e.g. tests/sanitiser.test.html).
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

import {configureMarked} from '../js/markdown.js';

const ROOT = new URL('../', import.meta.url);
const vendor = (path) => vm.runInThisContext(readFileSync(new URL(path, ROOT), 'utf8'), {filename: path});
vendor('vendor/marked/marked.min.js');
vendor('vendor/highlightjs/highlight.min.js');
vendor('vendor/highlightjs/languages.min.js');
configureMarked();

const render = (source) => marked.parse(source);

test('one term with one definition renders as a dl with one dt and one dd', () => {
    assert.equal(render('Term\n:   The definition of the term.'),
        '<dl><dt>Term</dt><dd>The definition of the term.</dd></dl>\n');
});

test('one term with two definitions: one dt, two dd', () => {
    assert.equal(render('Term\n:   First definition.\n:   A second definition for the same term.'),
        '<dl><dt>Term</dt><dd>First definition.</dd><dd>A second definition for the same term.</dd></dl>\n');
});

test('two terms with a blank line between stay in one dl', () => {
    assert.equal(render('Term\n:   The definition of the term.\n\nTerm Two\n:   First definition.\n:   A second definition for the same term.'),
        '<dl><dt>Term</dt><dd>The definition of the term.</dd><dt>Term Two</dt>'
        + '<dd>First definition.</dd><dd>A second definition for the same term.</dd></dl>\n');
});

test('inline Markdown works in a term and in a definition', () => {
    assert.equal(render('**Bold** term\n:   A `code` definition with a [link](https://example.com).'),
        '<dl><dt><strong>Bold</strong> term</dt>'
        + '<dd>A <code>code</code> definition with a <a href="https://example.com">link</a>.</dd></dl>\n');
});

test('a definition continued on a line indented by 4 spaces stays in the same dd', () => {
    assert.equal(render('Term\n:   First line of the definition.\n    Still the same definition.'),
        '<dl><dt>Term</dt><dd>First line of the definition.\nStill the same definition.</dd></dl>\n');
});

test('a definition list between paragraphs leaves both paragraphs alone', () => {
    assert.equal(render('Some text\n\nTerm\n:   def\n\nAfter text'),
        '<p>Some text</p>\n<dl><dt>Term</dt><dd>def</dd></dl>\n<p>After text</p>\n');
});

test('a line of text followed directly by ":smile: is an emoji" stays an ordinary paragraph', () => {
    assert.equal(render('Some text\n:smile: is an emoji'), '<p>Some text\n😄 is an emoji</p>\n');
});

test('a line of text, a blank line, then a colon line is not a definition list', () => {
    assert.equal(render('Some text\n\n:   this is not a definition list'),
        '<p>Some text</p>\n<p>:   this is not a definition list</p>\n');
});

test('colon lines without a term stay an ordinary paragraph', () => {
    assert.equal(render(':   first\n:   second'), '<p>:   first\n:   second</p>\n');
});

test('a colon line inside a fenced code block is never read as a definition list', () => {
    assert.equal(render('```\n:   not a definition\n```'),
        '<pre><code class="hljs language-plaintext">:   not a definition</code></pre>');
});

test('a colon line inside a code span is never read as a definition list', () => {
    assert.equal(render('`code span\n:   with a colon`'), '<p><code>code span :   with a colon</code></p>\n');
});

test('a bare URL in a term still links', () => {
    assert.equal(render('https://example.com\n:   The definition.'),
        '<dl><dt><a href="https://example.com">https://example.com</a></dt><dd>The definition.</dd></dl>\n');
});

test('the sanitiser keeps dl, dt and dd: its forbid-list leaves them alone, no narrower allow-list', () => {
    // DOMPurify needs a DOM, so the pass itself is covered by the browser pages
    // (tests/sanitiser.test.html). This pins the allow-list side js/markdown.js
    // owns: it sanitises with DOMPurify's defaults, which allow dl, dt and dd
    // (plain elements, no attributes), so the file's forbid-list must leave
    // them alone and nothing may swap in a narrower ALLOWED_TAGS that would
    // drop them.
    const src = readFileSync(new URL('../js/markdown.js', import.meta.url), 'utf8');
    const forbid = /const FORBID_TAGS = \[([^\]]*)\]/.exec(src);
    assert.ok(forbid, 'FORBID_TAGS literal found in js/markdown.js');
    for (const tag of ['dl', 'dt', 'dd']) {
        assert.ok(!forbid[1].includes(`'${tag}'`), `FORBID_TAGS must not contain ${tag}`);
    }
    assert.ok(!src.includes('ALLOWED_TAGS'), 'no narrower allow-list that could drop dl, dt, dd');
});

test('a long document is read in linear time: marked hands the extension the whole rest of the document for every block', () => {
    // 350 KB of ordinary paragraphs, lines that look nearly like definitions, and a few real definition lists.
    // Cutting the whole rest of the document into lines for every block took minutes at 2 MB.
    const unit = 'Some ordinary text in a paragraph.\n\nA line: with a colon.\n:smile: is an emoji line\n\n- a list item\n\n: a colon line after a blank line\n\n'
        + 'Term\n:   A real definition.\n\n';
    const doc = unit.repeat(2800);
    const started = performance.now();
    const html = render(doc);
    const ms = performance.now() - started;
    assert.equal(html.split('<dl>').length - 1, 2800, 'every real definition list is found');
    assert.ok(ms < 3000, `${Math.round(ms)} ms for ${doc.length} characters`);
});
