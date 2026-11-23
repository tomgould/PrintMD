/**
 * The inline Markdown extensions in js/markdown.js: ==highlight==, ~sub~,
 * ^sup^ and the fixed :shortcode: list. Alongside each syntax, the
 * Pandoc-style spacing rules are checked on the prose that must stay exactly
 * as typed, and code spans and fenced code must never be rewritten.
 *
 * The vendor bundles index.html loads as <script> globals are evaluated here,
 * so js/markdown.js sees marked and hljs in Node, and the output is the
 * configured marked.parse(): the HTML renderMarkdown() hands to the existing
 * sanitiser (mark, sub and sup are in its allow-list; DOMPurify needs a DOM,
 * so that pass-through is covered by the browser pages, e.g.
 * tests/sanitiser.test.html).
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

import {configureMarked, EMOJI_SHORTCODES} from '../js/markdown.js';

const ROOT = new URL('../', import.meta.url);
const vendor = (path) => vm.runInThisContext(readFileSync(new URL(path, ROOT), 'utf8'), {filename: path});
vendor('vendor/marked/marked.min.js');
vendor('vendor/highlightjs/highlight.min.js');
vendor('vendor/highlightjs/languages.min.js');
configureMarked();

const render = (source) => marked.parse(source);

test('highlight: ==text== renders as <mark>, inline markup inside included', () => {
    assert.equal(render('==highlighted text=='), '<p><mark>highlighted text</mark></p>\n');
    assert.equal(render('see ==this== now'), '<p>see <mark>this</mark> now</p>\n');
    assert.equal(render('==**bold**=='), '<p><mark><strong>bold</strong></mark></p>\n');
    assert.equal(render('a ==b==c'), '<p>a <mark>b</mark>c</p>\n');
    assert.equal(render('==foo== and ==bar=='), '<p><mark>foo</mark> and <mark>bar</mark></p>\n');
});

test('highlight: a spacer before the closer, or =="==" alone, stays as typed', () => {
    assert.equal(render('a == b'), '<p>a == b</p>\n');
    assert.equal(render('==foo =='), '<p>==foo ==</p>\n');
});

test('subscript: ~sub~ renders as <sub>, contents hold no whitespace', () => {
    assert.equal(render('H~2~O'), '<p>H<sub>2</sub>O</p>\n');
    assert.equal(render('~subscript~'), '<p><sub>subscript</sub></p>\n');
    assert.equal(render('~a*b~'), '<p><sub>a*b</sub></p>\n');
    assert.equal(render('~ spaced ~'), '<p>~ spaced ~</p>\n');
    assert.equal(render('~unclosed'), '<p>~unclosed</p>\n');
});

test('superscript: ^sup^ renders as <sup>, contents hold no whitespace', () => {
    assert.equal(render('x^2^'), '<p>x<sup>2</sup></p>\n');
    assert.equal(render('^superscript^'), '<p><sup>superscript</sup></p>\n');
    assert.equal(render('^ spaced ^'), '<p>^ spaced ^</p>\n');
    assert.equal(render('^unclosed'), '<p>^unclosed</p>\n');
});

test('prose with stray delimiters stays exactly as typed', () => {
    assert.equal(render('about ~10 to ~20 minutes'), '<p>about ~10 to ~20 minutes</p>\n');
    assert.equal(render('x^2 and y^3 are'), '<p>x^2 and y^3 are</p>\n');
    assert.equal(render('a == b'), '<p>a == b</p>\n');
});

test('double tilde stays strikethrough and is never read as a subscript', () => {
    assert.equal(render('a ~~struck~~ word'), '<p>a <del>struck</del> word</p>\n');
});

test('every emoji shortcode in the fixed list renders as its character', () => {
    for (const [name, emoji] of Object.entries(EMOJI_SHORTCODES)) {
        assert.equal(render(`:${name}:`), `<p>${emoji}</p>\n`, `:${name}:`);
    }
});

test('emoji: in a sentence, and colons around other words left as typed', () => {
    assert.equal(render('done :tada: now'), '<p>done 🎉 now</p>\n');
    assert.equal(render(':notanemoji:'), '<p>:notanemoji:</p>\n');
    assert.equal(render('10:30:45'), '<p>10:30:45</p>\n');
});

test('a URL containing tildes, carets or colons is left as typed', () => {
    assert.equal(render('https://example.com/~user/a:b'),
        '<p><a href="https://example.com/~user/a:b">https://example.com/~user/a:b</a></p>\n');
});

test('nothing changes inside a code span', () => {
    assert.equal(render('`x ==a== ~b~ ^c^ :tada:`'), '<p><code>x ==a== ~b~ ^c^ :tada:</code></p>\n');
    assert.equal(render('`~b~` and ~c~'), '<p><code>~b~</code> and <sub>c</sub></p>\n');
});

test('a web address stays one link whatever characters it holds (the new syntaxes never cut into it)', () => {
    for (const url of ['https://example.com/~user/a:b', 'https://example.com/a^b^c', 'https://example.com/?q==a&r=1',
        'https://example.com/a:rocket:b', 'http://example.com/~x~', 'www.example.com/~user']) {
        const html = render(`see ${url} now`);
        assert.ok(/<a href="[^"]*">[^<]*<\/a>/.test(html), `${url} is a link: ${html}`);
        assert.ok(!/<(sub|sup|mark|del)>/.test(html), `${url} holds no inline tag: ${html}`);
        assert.ok(!html.includes('🚀'), `${url} holds no emoji: ${html}`);
    }
});

test('a run of three equals signs is left alone', () => {
    assert.equal(render('a === b === c'), '<p>a === b === c</p>\n');
    assert.equal(render('use === for equality and !== for the opposite'), '<p>use === for equality and !== for the opposite</p>\n');
    assert.equal(render('====='), '<p>=====</p>\n');
});

test('adjacent footnote-style markers are left alone', () => {
    assert.equal(render('[^1][^2]'), '<p>[^1][^2]</p>\n');
    assert.equal(render('text[^1], more[^note]'), '<p>text[^1], more[^note]</p>\n');
});

test('nothing changes inside a fenced code block', () => {
    assert.equal(render('```\nx ==a== ~b~ ^c^ :tada:\n```'),
        '<pre><code class="hljs language-plaintext">x ==a== ~b~ ^c^ :tada:</code></pre>');
});
