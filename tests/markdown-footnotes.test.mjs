/**
 * tests/markdown-footnotes.test.mjs
 *
 * Footnotes in js/markdown.js (Pandoc / Markdown Extra style):
 *
 *     A sentence with a note.[^1]
 *
 *     [^1]: The note's text, which may continue on lines
 *         indented by four spaces or a tab, and holds inline Markdown.
 *
 * A reference becomes a numbered superscript link, in the order of first reference; the notes are one ordered list
 * after the last block. Alongside each syntax, the text that must stay as typed is checked: a reference with no
 * definition, a definition nobody uses, and brackets in code. The vendor bundles index.html loads as <script>
 * globals are evaluated here, as in tests/markdown-deflist.test.mjs, and the output is the configured marked.parse().
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
const ref = (n, uses = 1) => `<sup class="footnote-ref"><a href="#fn-${n}" id="fnref-${n}${uses > 1 ? `-${uses}` : ''}">${n}</a></sup>`;
const back = (n) => `<a href="#fnref-${n}" class="footnote-back" aria-label="Back to the text">↑</a>`;
const notes = (...items) => `<section class="footnotes"><hr><ol>${items.map(([n, html]) => `<li id="fn-${n}">${html} ${back(n)}</li>`).join('')}</ol></section>\n`;

test('one reference and its definition: a numbered link, and the note after the last block', () => {
    assert.equal(render('A note.[^1]\n\n[^1]: The note.'),
        `<p>A note.${ref(1)}</p>\n${notes([1, 'The note.'])}`);
});

test('notes are numbered in the order of first reference, whatever the labels and the order of the definitions', () => {
    assert.equal(render('First[^b] then second[^a].\n\n[^a]: Note A.\n[^b]: Note B.'),
        `<p>First${ref(1)} then second${ref(2)}.</p>\n${notes([1, 'Note B.'], [2, 'Note A.'])}`);
});

test('a note referenced twice keeps its number; the second reference has its own id', () => {
    assert.equal(render('One[^x] and again[^x].\n\n[^x]: The note.'),
        `<p>One${ref(1)} and again${ref(1, 2)}.</p>\n${notes([1, 'The note.'])}`);
});

test('labels with underscores and hyphens work, and the label never reaches an id or a link', () => {
    const html = render('Text[^my_note-1].\n\n[^my_note-1]: Body.');
    assert.equal(html, `<p>Text${ref(1)}.</p>\n${notes([1, 'Body.'])}`);
    assert.ok(!html.includes('my_note'), 'no label in the output');
});

test('inline Markdown works in a note, and a note continues on lines indented by four spaces or a tab', () => {
    assert.equal(render('Text[^1] and[^2].\n\n[^1]: A **bold** word, `code` and [a link](https://example.com).\n[^2]: First line\n    second line\n\tthird line'),
        `<p>Text${ref(1)} and${ref(2)}.</p>\n${notes(
            [1, 'A <strong>bold</strong> word, <code>code</code> and <a href="https://example.com">a link</a>.'],
            [2, 'First line\nsecond line\nthird line'])}`);
});

test('a definition directly under a paragraph line, with no blank line between, still ends that paragraph', () => {
    assert.equal(render('A note.[^1]\n[^1]: The note.'),
        `<p>A note.${ref(1)}</p>\n${notes([1, 'The note.'])}`);
});

test('a definition before its reference works too', () => {
    assert.equal(render('[^1]: The note.\n\nText[^1].'),
        `<p>Text${ref(1)}.</p>\n${notes([1, 'The note.'])}`);
});

test('a reference with no definition stays as typed, and no notes list appears', () => {
    assert.equal(render('Text[^nope] here.'), '<p>Text[^nope] here.</p>\n');
});

test('a definition nobody refers to prints nothing: the output is what the rest of the document gives', () => {
    assert.equal(render('Just text.\n\n[^unused]: Nobody points here.'), render('Just text.'));
});

test('when a label is defined twice the first definition wins', () => {
    assert.equal(render('Text[^1].\n\n[^1]: First.\n\n[^1]: Second.'),
        `<p>Text${ref(1)}.</p>\n${notes([1, 'First.'])}`);
});

test('a document with no footnote renders exactly as before: no section, nothing added', () => {
    assert.equal(render('Plain text.\n\nA [link](https://example.com).'),
        '<p>Plain text.</p>\n<p>A <a href="https://example.com">link</a>.</p>\n');
});

test('state is per document: a second parse starts at note 1 and a document without notes gets none', () => {
    render('A[^z] and B[^y].\n\n[^z]: Z.\n[^y]: Y.');
    assert.equal(render('Later[^q].\n\n[^q]: Q.'), `<p>Later${ref(1)}.</p>\n${notes([1, 'Q.'])}`);
    assert.equal(render('Nothing here.'), '<p>Nothing here.</p>\n');
});

test('brackets in code are never a reference or a definition', () => {
    const span = render('Use `[^1]` for a note.\n\n[^1]: Defined.');
    assert.equal(span, '<p>Use <code>[^1]</code> for a note.</p>\n');
    const fenced = render('```\n[^1]: not a definition\n```\n\nText[^1].');
    assert.ok(fenced.includes('[^1]: not a definition'), 'the fenced line is code, as typed');
    assert.ok(fenced.includes('Text[^1].'), 'and so no definition exists for the reference');
    assert.ok(!fenced.includes('footnotes'), 'no notes list');
});

test('links and reference links keep working beside footnotes', () => {
    assert.equal(render('[a](https://example.com) and [b][r] and note[^1].\n\n[r]: https://example.org\n[^1]: N.'),
        `<p><a href="https://example.com">a</a> and <a href="https://example.org">b</a> and note${ref(1)}.</p>\n${notes([1, 'N.'])}`);
});

test('a reference inside a note is left as typed: a note has no notes', () => {
    assert.equal(render('Text[^1].\n\n[^1]: See also[^2].\n[^2]: Other.'),
        `<p>Text${ref(1)}.</p>\n${notes([1, 'See also[^2].'])}`);
});

test('the sanitiser keeps the section, the list, the ids and the superscript links', () => {
    // The sanitiser (DOMPurify) needs a DOM, so the pass-through is covered by the browser pages; here the forbid-list is
    // read: nothing that footnotes use may be on it.
    const src = readFileSync(new URL('../js/markdown.js', import.meta.url), 'utf8');
    const forbid = /const FORBID_TAGS = \[([^\]]*)\]/.exec(src);
    assert.ok(forbid, 'FORBID_TAGS literal found in js/markdown.js');
    for (const tag of ['section', 'hr', 'ol', 'li', 'sup', 'a']) {
        assert.ok(!forbid[1].includes(`'${tag}'`), `FORBID_TAGS must not contain ${tag}`);
    }
});

test('a long document is read in linear time: marked hands each extension the whole rest of the document', () => {
    // 350 KB of paragraphs with bracketed text that is not a note, colon lines, and a few real footnotes.
    const unit = 'Some ordinary text in a paragraph with [brackets] and [^missing] here.\n\n'
        + 'A line: with a colon.\n:smile: is an emoji line\n\n'
        + 'A real note.[^n]\n\n[^n]: The note.\n\n';
    const doc = unit.repeat(2800);
    const started = performance.now();
    const html = render(doc);
    const ms = performance.now() - started;
    assert.ok(html.includes('class="footnotes"'), 'the notes list is there');
    assert.equal(html.split('class="footnote-ref"').length - 1, 2800, 'every reference is found');
    assert.equal(html.split('<li id="fn-').length - 1, 1, 'and they share one note, numbered once');
    assert.ok(ms < 3000, `${Math.round(ms)} ms for ${doc.length} characters`);
});
