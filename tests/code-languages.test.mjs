/**
 * tests/code-languages.test.mjs
 *
 * Fenced code blocks (js/code-languages.js) and their template CSS
 * (templates/_shared/base.js): fence words and aliases, validation of the
 * fence word, the label, token classes for every listed language, and the
 * contrast of each syntax palette on each template's code background.
 * Run: node --test tests/code-languages.test.mjs
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {
    CODE_BLOCK_KEEP_LINES, CODE_LANGUAGES, EXTRA_GRAMMARS, FENCE_WORD_RE, HIGHLIGHT_LIMITS, LANG_ID_RE, LANG_LABEL_RE,
    codeBlockHtml, createHighlightBudget, markTypeNames, registerCodeLanguages, resolveCodeLanguage,
} from '../js/code-languages.js';
import {CODE_PALETTES, CODE_TINTS, CODE_TOKEN_ROLES, baseStyles} from '../templates/_shared/base.js';
import {getTemplates} from '../js/templates.js';
import {pptxBlocksFromHtml} from '../js/pptx-export.js';
import {checkLinear} from './lib/growth.js';

const require = createRequire(import.meta.url);
// As in the app: the common bundle, then every other grammar (registers on the global hljs).
const hljs = require('../vendor/highlightjs/highlight.min.js');
const COMMON_COUNT = hljs.listLanguages().length;
globalThis.hljs = hljs;
require('../vendor/highlightjs/languages.min.js');
registerCodeLanguages(hljs);

const render = (code, info) => codeBlockHtml(code, info, hljs);

// ── The list ────────────────────────────────────────────────────────────────

test('code languages: ids, labels, colours and fence words are valid and unique', () => {
    const ids = new Set();
    const fences = new Set();
    for (const l of CODE_LANGUAGES) {
        assert.match(l.id, LANG_ID_RE, `id ${l.id}`);
        assert.ok(!ids.has(l.id), `id ${l.id} once`);
        ids.add(l.id);
        assert.match(l.label, LANG_LABEL_RE, `label ${l.label}`);
        assert.match(l.color, /^#[0-9a-f]{6}$/, `colour of ${l.id}`);
        assert.ok(l.grammar === null || hljs.getLanguage(l.grammar), `grammar ${l.grammar} is registered`);
        for (const f of l.fences) {
            assert.match(f, FENCE_WORD_RE, `fence ${f}`);
            assert.equal(f, f.toLowerCase(), `fence ${f} is lower case`);
            assert.ok(!fences.has(f), `fence ${f} selects one language`);
            fences.add(f);
        }
    }
});

test('code languages: every highlight.js 11.9.0 grammar is loaded (36 common + 156 more + HCL)', () => {
    assert.equal(COMMON_COUNT, 36);
    assert.equal(hljs.listLanguages().length, 36 + 156 + 1);
    for (const name of ['dockerfile', 'nginx', 'twig', 'elixir', 'haskell', 'scala', 'dart', 'clojure', 'hcl']) {
        assert.ok(hljs.getLanguage(name), name);
    }
});

test('code languages: the extra grammars are registered once, and only when missing', () => {
    for (const name of Object.keys(EXTRA_GRAMMARS)) assert.ok(hljs.getLanguage(name), `${name} registered`);
    registerCodeLanguages(hljs);
    registerCodeLanguages(null);
    assert.ok(hljs.getLanguage('dockerfile'));
});

// ── Fence words ─────────────────────────────────────────────────────────────

const ALIASES = [
    // fence, label, data-lang-id, highlight.js language class
    ['php', 'PHP', 'php', 'php'],
    ['PHP', 'PHP', 'php', 'php'],
    ['jsonc', 'JSONC', 'jsonc', 'json'],
    ['json5', 'JSON5', 'json5', 'json'],
    ['sh', 'Bash', 'bash', 'bash'],
    ['zsh', 'Bash', 'bash', 'bash'],
    ['shell', 'Shell', 'shell', 'bash'],
    ['shell-session', 'Console', 'console', 'shell'],
    ['console', 'Console', 'console', 'shell'],
    ['yml', 'YAML', 'yaml', 'yaml'],
    ['ts', 'TypeScript', 'typescript', 'typescript'],
    ['tsx', 'TypeScript', 'typescript', 'typescript'],
    ['jsx', 'JavaScript', 'javascript', 'javascript'],
    ['mjs', 'JavaScript', 'javascript', 'javascript'],
    ['js title="app.js"', 'JavaScript', 'javascript', 'javascript'],
    ['html', 'HTML', 'html', 'xml'],
    ['vue', 'Vue', 'vue', 'xml'],
    ['twig', 'Twig', 'twig', 'twig'],
    ['blade', 'Blade', 'blade', 'xml'],
    ['tf', 'Terraform', 'terraform', 'hcl'],
    ['terraform', 'Terraform', 'terraform', 'hcl'],
    ['hcl', 'HCL', 'hcl', 'hcl'],
    ['docker', 'Dockerfile', 'dockerfile', 'dockerfile'],
    ['nginx', 'nginx', 'nginx', 'nginx'],
    ['ps1', 'PowerShell', 'powershell', 'powershell'],
    ['env', 'env', 'env', 'ini'],
    ['dotenv', 'env', 'env', 'ini'],
    ['toml', 'TOML', 'toml', 'ini'],
    ['properties', 'Properties', 'properties', 'properties'],
    ['c#', 'C#', 'csharp', 'csharp'],
    ['text', 'Text', 'text', 'plaintext'],
];

for (const [fence, label, id, language] of ALIASES) {
    test(`code block fence "${fence}": label ${label}, highlighted as ${language}`, () => {
        const html = render('x = 1', fence);
        assert.ok(html.startsWith(`<pre data-lang="${label}" data-lang-id="${id}">`), html);
        assert.ok(html.includes(`<code class="hljs language-${language}">`), html);
    });
}

test('code block: a word highlight.js knows but the list does not is highlighted, with its highlight.js name', () => {
    const html = render('@interface Foo : NSObject\n@end', 'objectivec');
    assert.ok(html.startsWith('<pre data-lang="Objective-C"><code class="hljs language-objectivec">'), html);
    assert.match(html, /hljs-/);
    assert.ok(render('main = print 1', 'hs').startsWith('<pre data-lang="Haskell"><code class="hljs language-hs">'));
    // A name that does not fit a label ("1C:Enterprise") falls back to the fence word in capitals.
    assert.ok(render('x', '1c').startsWith('<pre data-lang="1C"><code class="hljs language-1c">'));
});

test('type names: unclassified PascalCase names become types; members, constants, strings and comments do not', () => {
    const java = render('private final List<Article> items; // List\nString s = "Foo"; int MAX_SIZE = 2; x.Foo;', 'java');
    assert.ok(java.includes('<span class="hljs-type">List</span>&lt;<span class="hljs-type">Article</span>&gt;'), java);
    assert.ok(java.includes('<span class="hljs-type">String</span>'), java);
    assert.ok(java.includes('<span class="hljs-comment">// List</span>'), 'comment untouched');
    assert.ok(java.includes('&quot;Foo&quot;</span>'), 'string untouched');
    assert.ok(!/hljs-type">MAX_SIZE/.test(java) && java.includes('x.Foo;'), 'constant and member untouched');
    const php = render('function f(Clock $clock) {}', 'php');
    assert.ok(php.includes('<span class="hljs-type">Clock</span>'), 'inside a parameter list: ' + php);
    const cs = render('var n = files.Count(f => f.EndsWith(".md"));', 'csharp');
    assert.ok(cs.includes('<span class="hljs-title function_">Count</span>('), 'C# PascalCase call is a method: ' + cs);
    assert.equal(markTypeNames('Foo <span class="hljs-string">Bar</span>', 'go'), 'Foo <span class="hljs-string">Bar</span>',
        'languages outside the list are left alone');
    assert.equal(markTypeNames('<span class="hljs-params">Foo</span>', 'java'),
        '<span class="hljs-params"><span class="hljs-type">Foo</span></span>');
});

test('type names: members after . ?. -> :: stay plain; a constructor names a type', () => {
    const php = render('$this->Foo = Bar::Baz; $x?->Qux;', 'php');
    assert.ok(!/hljs-type">(Foo|Baz|Qux)</.test(php), 'members untouched: ' + php);
    assert.ok(php.includes('<span class="hljs-type">Bar</span>') || php.includes('class_">Bar<'), 'the class before :: is a type: ' + php);
    const cs = render('var a = new Foo(1); var b = list.Find(x); var c = obj?.Prop;', 'csharp');
    assert.ok(cs.includes('<span class="hljs-type">Foo</span>(') || cs.includes('class_">Foo</span>'), 'new Foo( is a type: ' + cs);
    assert.ok(cs.includes('<span class="hljs-title function_">Find</span>('), 'a PascalCase method call stays a call: ' + cs);
    assert.ok(!/hljs-type">Prop</.test(cs), 'obj?.Prop is a member: ' + cs);
    const ts = render('const m = new Map<string, Foo>(); a?.Bar;', 'typescript');
    assert.ok(!/hljs-type">Bar</.test(ts), 'TypeScript ?. member: ' + ts);
});

// Hostile inputs for every pattern this module adds: each must grow linearly (tests/lib/growth.js
// compares equal batches of work, 4N against 4 x N, so a slow or CPU-limited machine slows both alike).
const HOSTILE_GROWTH = [
    ['type names: a long word ending in $', 'java', (n) => 'X' + 'a'.repeat(n) + '$'],
    ['type names: a long capital run', 'java', (n) => 'A'.repeat(n) + '$'],
    ['type names: long identifier runs', 'csharp', (n) => 'Aa.Bb('.repeat(n / 6) + ' Cc'.repeat(n / 6)],
    ['type names: nested generics', 'typescript', (n) => 'let x: ' + 'Map<Foo, '.repeat(n / 9) + 'Bar' + '>'.repeat(n / 9) + ';'],
    ['type names: a run of members', 'php', (n) => '$a' + '->Foo'.repeat(n / 5)],
    ['HCL: a long dash run', 'hcl', (n) => 'a-'.repeat(n / 2)],
    ['HCL: a long dash run before =', 'hcl', (n) => 'a-'.repeat(n / 2) + ' = 1'],
    ['HCL: an unterminated string', 'hcl', (n) => 'x = "' + 'a${'.repeat(n / 3)],
    ['HCL: an unterminated heredoc', 'hcl', (n) => 'x = <<EOT\n' + 'word\n'.repeat(n / 5)],
    ['HCL: deep braces', 'hcl', (n) => 'a = {'.repeat(n / 5) + '}'.repeat(n / 5)],
];

for (const [name, lang, make] of HOSTILE_GROWTH) {
    test(`${name}: highlighting grows linearly`, async () => {
        const problem = await checkLinear((code) => render(code, lang), make, {n: 20000, capMs: 10000});
        assert.equal(problem, null);
    });
}

// The type pass on its own, with the hostile text as one unclassified run (its worst case), and in short
// lines that the highlighting limits let through.
for (const [name, make] of [
    ['a long word ending in $', (n) => 'X' + 'a'.repeat(n) + '$'],
    ['a long capital run', (n) => 'A'.repeat(n) + '$'],
    ['identifier runs and calls', (n) => 'Aa.Bb('.repeat(n / 6) + ' new Cc('.repeat(n / 9)],
    ['nested generics', (n) => 'Map&lt;Foo, '.repeat(n / 12) + 'Bar' + '&gt;'.repeat(n / 12)],
    ['members after -> and ::', (n) => '$a-&gt;Foo::Bar?.Baz '.repeat(n / 22)],
    ['short lines with $ words', (n) => ('X' + 'a'.repeat(60) + '$\n').repeat(n / 63)],
]) {
    test(`type names: ${name} grows linearly`, async () => {
        for (const grammar of ['java', 'csharp', 'php']) {
            const problem = await checkLinear((html) => markTypeNames(html, grammar), make, {n: 40000, capMs: 10000});
            assert.equal(problem, null, grammar);
        }
    });
}

test('HCL heredoc: ends only at a line holding its own tag; <<- allows an indented one', () => {
    const plain = render('a = <<EOT\nhello\nworld\n  EOT\nEOT\nb = 1', 'hcl');
    assert.match(plain, /<span class="hljs-string">&lt;&lt;EOT\nhello\nworld\n {2}EOT\nEOT<\/span>\n<span class="hljs-attr">b<\/span>/, plain);
    const indented = render('a = <<-EOT\nhello\n  EOT\nb = 1', 'hcl');
    assert.match(indented, /<span class="hljs-string">&lt;&lt;-EOT\nhello\n {2}EOT<\/span>\n<span class="hljs-attr">b<\/span>/, indented);
    const other = render('a = <<EOT\nEND\nEOT\n', 'hcl');
    assert.match(other, /&lt;&lt;EOT\nEND\nEOT<\/span>/, 'another one-word line does not end it: ' + other);
});

test('HCL: a dashed name before = is an attribute; in-place is not the keyword in', () => {
    const html = render('in-place = true\nx = a-b-c', 'hcl');
    assert.ok(html.startsWith('<pre data-lang="HCL" data-lang-id="hcl"><code class="hljs language-hcl"><span class="hljs-attr">in-place</span>'), html);
    assert.ok(!html.includes('<span class="hljs-keyword">in</span>'), html);
});

// ── Highlighting limits ─────────────────────────────────────────────────────

/** The text a reader sees in a code block's HTML. */
const visibleText = (html) => html.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'").replace(/&amp;/g, '&');

test('highlighting limits: a block past a limit keeps its label and its text, unhighlighted', () => {
    const cases = [
        ['markdown', '[a'.repeat(HIGHLIGHT_LIMITS.markdownBlock / 2 + 1), 'Markdown'],
        ['md', ('[a '.repeat(100) + '\n').repeat(70), 'Markdown'],   // 21,070 characters of short lines
        ['java', 'X' + 'a'.repeat(HIGHLIGHT_LIMITS.line) + '$', 'Java'],
        ['python', 'x = 1\n'.repeat(HIGHLIGHT_LIMITS.block / 6 + 1), 'Python'],
    ];
    for (const [fence, code, label] of cases) {
        const html = render(code, fence);
        assert.ok(html.startsWith(`<pre`) && html.includes(`data-lang="${label}"`), `${fence}: label kept`);
        assert.ok(html.includes('<code class="hljs language-plaintext">'), `${fence}: not highlighted`);
        assert.ok(!/<span class="hljs-/.test(html), `${fence}: no token spans`);
        assert.equal(visibleText(html), code.replace(/\n$/, ''), `${fence}: text unchanged`);
    }
    const ok = render('x = 1\n'.repeat(1000), 'python');
    assert.match(ok, /hljs-number/, 'a block within the limits is highlighted');
});

test('highlighting limits: a document stops highlighting after its budget; later blocks stay plain', () => {
    const budget = createHighlightBudget();
    const block = 'x = 1\n'.repeat(15000);   // 90,000 characters
    const out = Array.from({length: 7}, () => codeBlockHtml(block, 'python', hljs, budget));
    const highlighted = out.map((html) => /hljs-number/.test(html));
    assert.deepEqual(highlighted, [true, true, true, true, true, false, false], '5 x 90,000 fits in 500,000');
    for (const html of out) assert.equal(visibleText(html), block.replace(/\n$/, ''), 'text unchanged');
    assert.ok(codeBlockHtml('x = 1', 'python', hljs, createHighlightBudget()).includes('hljs-number'), 'a new document starts afresh');
});

test('highlighting limits: the reviewer inputs render quickly and keep their text', () => {
    for (const [fence, code] of [
        ['java', 'X' + 'a'.repeat(100000) + '$'],
        ['hcl', 'a-'.repeat(50000)],
        ['markdown', '[a'.repeat(50000)],
        ['text', 'x'.repeat(2 * 1024 * 1024)],
    ]) {
        const html = render(code, fence);
        assert.equal(visibleText(html), code, `${fence}: text unchanged`);
    }
});

test('code block: an unknown language is plain text with the word in capitals and the default dot', () => {
    const html = render('graph TD; A-->B', 'mermaid');
    assert.equal(html, '<pre data-lang="MERMAID"><code class="hljs language-plaintext">graph TD; A--&gt;B</code></pre>');
});

const HOSTILE = [
    'js" onload="x',
    "js' onclick='x",
    'js"><img src=x onerror=alert(1)>',
    '<script>',
    'x'.repeat(25),
    '{.python}',
    'jäva',
    'js`',
    'js;rm',
];

for (const fence of HOSTILE) {
    test(`code block: hostile fence ${JSON.stringify(fence)} is plain text with no label`, () => {
        assert.equal(resolveCodeLanguage(fence, hljs), null);
        const html = render('<b>x</b>', fence);
        assert.equal(html, '<pre><code class="hljs language-plaintext">&lt;b&gt;x&lt;/b&gt;</code></pre>');
    });
}

test('code block: 24 characters is the longest fence word', () => {
    assert.equal(resolveCodeLanguage('y'.repeat(24)).label, 'Y'.repeat(24));
    assert.equal(resolveCodeLanguage('y'.repeat(25)), null);
});

test('code block: no fence word means no label and no guessing (never auto-detected)', () => {
    for (const info of ['', '   ', undefined, null]) {
        const html = render('const x = 1; // looks like JavaScript', info);
        assert.equal(html, '<pre><code class="hljs language-plaintext">const x = 1; // looks like JavaScript</code></pre>');
    }
});

test('code block: code is escaped in every path', () => {
    for (const info of ['', 'text', 'mermaid', 'html', 'php']) {
        const html = render('<script>alert(1)</script>', info);
        assert.ok(!html.includes('<script>'), `${info}: ${html}`);
    }
});

test('code block: one trailing newline is dropped, the rest kept', () => {
    assert.ok(render('a\n', 'text').endsWith('>a</code></pre>'));
    assert.ok(render('a\n\n', 'text').endsWith('>a\n</code></pre>'));
});

test(`code block: up to ${CODE_BLOCK_KEEP_LINES} lines stay whole, longer blocks get bd-code-long`, () => {
    const lines = (n) => Array.from({length: n}, (_, i) => `line ${i}`).join('\n');
    assert.ok(!render(lines(CODE_BLOCK_KEEP_LINES), 'text').includes('bd-code-long'));
    assert.ok(render(lines(CODE_BLOCK_KEEP_LINES + 1), 'text').startsWith('<pre class="bd-code-long" data-lang="Text"'));
    assert.ok(render(lines(CODE_BLOCK_KEEP_LINES + 1), '').startsWith('<pre class="bd-code-long"><code'));
});

// ── Token classes: one fixture per listed language ──────────────────────────

const SAMPLES = {
    php: '<?php\nfunction add(int $a): int { return $a + 1; } // sum',
    javascript: 'const x = await fetch("/a"); // get',
    typescript: 'interface A { id: number }\nconst a: A = {id: 1};',
    json: '{"a": 1, "b": [true, null]}',
    jsonc: '{\n  // flags\n  "a": 1\n}',
    json5: '{"a": 1, /* note */ "b": "x"}',
    yaml: 'name: docs\nretries: 3\nenabled: true',
    html: '<div class="x"><a href="/">Home</a></div>',
    xml: '<?xml version="1.0"?>\n<note id="1">Hi</note>',
    vue: '<template><p :title="t">{{ msg }}</p></template>',
    svelte: '<script>let n = 0;</script>\n<button on:click={() => n++}>{n}</button>',
    twig: '{% for item in items %}{{ item.title|upper }}{% endfor %}',
    blade: '<div class="card">@if($user) {{ $user->name }} @endif</div>',
    css: '.card { color: #333; padding: 4px; }',
    scss: '$gap: 4px;\n.card { margin: $gap; &:hover { color: red; } }',
    less: '@gap: 4px;\n.card { margin: @gap; }',
    sql: 'SELECT id, COUNT(*) FROM users WHERE id > 10 GROUP BY id;',
    bash: 'for f in *.md; do echo "$f"; done',
    shell: 'export PATH="$HOME/bin:$PATH"\nnpm ci',
    console: '$ npm test\nok 1 - passes',
    powershell: 'Get-ChildItem -Path C:\\ | Where-Object { $_.Length -gt 1 }',
    python: 'def add(a, b):\n    return a + b  # sum',
    pycon: '>>> 1 + 1\n2',
    dockerfile: 'FROM node:22\nRUN npm ci\nEXPOSE 8080',
    nginx: 'server {\n  listen 80;\n  location / { proxy_pass http://app; }\n}',
    apache: '<VirtualHost *:80>\n  ServerName example.com\n</VirtualHost>',
    terraform: 'resource "aws_s3_bucket" "b" {\n  bucket = "docs-${var.env}" # c\n}',
    hcl: 'job "web" {\n  count = 2\n}',
    diff: '--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new',
    markdown: '# Title\n\n- item with **bold**',
    ini: '[server]\nport = 8080 ; comment',
    toml: '[package]\nname = "docs"\nversion = "1.0.0"',
    env: '# local\nAPP_ENV=dev\nPORT=8080',
    properties: '# app\nserver.port=8080\napp.name = Docs',
    http: 'GET /api/v1/render HTTP/1.1\nHost: example.com\nAccept: application/pdf',
    graphql: 'query { article(id: 1) { title } }',
    go: 'package main\nfunc main() { fmt.Println("hi") }',
    rust: 'fn main() { let x: i32 = 1; println!("{}", x); }',
    java: 'public class A { public static void main(String[] a) { int x = 1; } }',
    kotlin: 'fun main() { val x = 1; println(x) }',
    csharp: 'public class A { public int Id { get; set; } }',
    c: '#include <stdio.h>\nint main(void) { return 0; }',
    cpp: '#include <vector>\nint main() { std::vector<int> v; return 0; }',
    ruby: 'def add(a, b)\n  a + b # sum\nend',
    swift: 'func add(a: Int) -> Int { return a + 1 }',
    lua: 'local function add(a) return a + 1 end',
    perl: 'my $x = 1; print "$x\\n";',
    makefile: 'build:\n\tnode tests/run-all.mjs',
};

test('code block samples: one fixture per listed language', () => {
    const missing = CODE_LANGUAGES.filter((l) => l.grammar && !SAMPLES[l.id]).map((l) => l.id);
    assert.deepEqual(missing, []);
});

for (const lang of CODE_LANGUAGES.filter((l) => l.grammar)) {
    test(`code block ${lang.id}: token classes from the ${lang.grammar} grammar`, () => {
        const html = render(SAMPLES[lang.id] || '', lang.fences[0]);
        assert.ok(html.includes(`language-${lang.grammar}"`), html);
        assert.match(html, /<span class="hljs-[a-z]/, `token spans for ${lang.id}: ${html}`);
    });
}

// ── Template CSS ────────────────────────────────────────────────────────────

// Every template in the registry; its syntax palette is read from its own CSS.
const TEMPLATE_STYLES = Object.fromEntries(getTemplates().map((t) => [t.manifest.id, t.styles]));
const THEME = Object.fromEntries(Object.entries(TEMPLATE_STYLES)
    .map(([id, css]) => [id, css.includes(`color: ${CODE_PALETTES.light.keyword}`) ? 'light' : 'dark']));

/** The value of a property in the template's own `.template-{id} pre {` rule, with var(--x) resolved. */
function preProperty(css, id, prop) {
    const rules = [...css.matchAll(new RegExp(`\\.template-${id} pre \\{([^}]*)\\}`, 'g'))].map((m) => m[1]);
    let value = null;
    for (const body of rules) {
        const m = body.match(new RegExp(`(?:^|[;\\s])${prop}:\\s*([^;]+);`));
        if (m) value = m[1].trim();
    }
    const v = value && value.match(/^var\((--[\w-]+)\)$/);
    if (v) value = css.match(new RegExp(`${v[1]}:\\s*(#[0-9a-fA-F]{6})`))[1];
    return value;
}

function luminance(hex) {
    const [r, g, b] = hex.slice(1).match(/../g).map((x) => parseInt(x, 16) / 255)
        .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** An rgba(r, g, b, a) colour over an opaque hex background, as hex. */
function blend(rgba, bgHex) {
    const [r, g, b, a] = rgba.match(/[\d.]+/g).map(Number);
    const bg = bgHex.slice(1).match(/../g).map((x) => parseInt(x, 16));
    return '#' + [r, g, b].map((c, i) => Math.round(c * a + bg[i] * (1 - a)).toString(16).padStart(2, '0')).join('');
}

function contrast(a, b) {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
}

for (const [id, css] of Object.entries(TEMPLATE_STYLES)) {
    test(`code palette on ${id}: every token colour, the label and the text have 4.5:1 contrast`, () => {
        const bg = preProperty(css, id, 'background');
        const fg = preProperty(css, id, 'color');
        assert.match(bg, /^#[0-9a-f]{6}$/i, `${id} code background`);
        assert.match(fg, /^#[0-9a-f]{6}$/i, `${id} code text colour`);
        assert.ok(contrast(fg, bg) >= 4.5, `${id} text ${fg} on ${bg}: ${contrast(fg, bg).toFixed(2)}`);
        for (const [token, colour] of Object.entries(CODE_PALETTES[THEME[id]])) {
            const ratio = contrast(colour, bg);
            assert.ok(ratio >= 4.5, `${id} ${token} ${colour} on ${bg}: ${ratio.toFixed(2)}`);
            assert.ok(css.includes(`color: ${colour}`), `${id} uses ${token} ${colour}`);
        }
        // Diff lines: their text colour on the tint laid over the code background.
        for (const kind of ['addition', 'deletion']) {
            const tinted = blend(CODE_TINTS[THEME[id]][kind], bg);
            const ratio = contrast(CODE_PALETTES[THEME[id]][kind], tinted);
            assert.ok(ratio >= 4.5, `${id} ${kind} on its tint ${tinted}: ${ratio.toFixed(2)}`);
        }
    });

    test(`code blocks in ${id}: label from data-lang, a dot colour per language, page-break rules`, () => {
        assert.match(css, new RegExp(`\\.template-${id} pre\\[data-lang\\]::before \\{[^}]*content: attr\\(data-lang\\);`));
        for (const l of CODE_LANGUAGES) {
            assert.ok(css.includes(`.template-${id} pre[data-lang-id="${l.id}"] { --bd-lang: ${l.color}; }`), l.id);
        }
        const print = css.slice(css.indexOf('@media print'));
        assert.match(print, new RegExp(`\\.template-${id} pre:not\\(\\.bd-code-long\\) \\{[^}]*break-inside: avoid;`));
        assert.match(print, new RegExp(`\\.template-${id} pre\\.bd-code-long \\{[^}]*orphans: 3;`));
        assert.match(css, new RegExp(`\\.template-${id} pre \\{[^}]*tab-size: 4;`));
    });
}

test('code palette: an unknown theme falls back to dark', () => {
    assert.equal(baseStyles('x', {codeTheme: 'nope'}), baseStyles('x'));
    assert.notEqual(baseStyles('x', {codeTheme: 'light'}), baseStyles('x'));
});

// ── Every scope the grammars emit has a colour ──────────────────────────────

/** The fenced blocks of tests/fixtures/code-showcase.md: [fence word, code]. */
const SHOWCASE = [...readFileSync(new URL('./fixtures/code-showcase.md', import.meta.url), 'utf8')
    .matchAll(/^```(\S+)\n([\s\S]*?)^```$/gm)].map((m) => [m[1], m[2]]);

/** Wrapper scopes that only group other tokens (their text keeps the block colour, like an IDE). */
const WRAPPERS = new Set(['hljs-function', 'hljs-class']);

test('code showcase fixture: a 12 to 20 line sample for each language asked for', () => {
    const want = ['css', 'html', 'php', 'javascript', 'typescript', 'python', 'rust', 'go', 'java', 'csharp', 'sql',
        'bash', 'yaml', 'json', 'dockerfile', 'nginx', 'terraform', 'diff', 'markdown'];
    assert.deepEqual(SHOWCASE.map(([fence]) => fence), want);
    for (const [fence, code] of SHOWCASE) {
        const lines = code.replace(/\n$/, '').split('\n').length;
        assert.ok(lines >= 12 && lines <= 20, `${fence}: ${lines} lines`);
    }
});

test('code palette: every highlight.js scope in the samples and the showcase has a colour rule', () => {
    // The last compound of each role selector, as a set of classes ('.hljs-title.class_' -> hljs-title, class_).
    const coloured = CODE_TOKEN_ROLES.flatMap(([, selectors]) => selectors)
        .map((sel) => sel.trim().split(/\s+/).pop().split('.').filter(Boolean));
    const blocks = [...SHOWCASE, ...Object.entries(SAMPLES).map(([id, code]) => [CODE_LANGUAGES.find((l) => l.id === id).fences[0], code])];
    const missing = new Set();
    let spans = 0;
    for (const [fence, code] of blocks) {
        for (const [, cls] of render(code, fence).matchAll(/<span class="([^"]+)">/g)) {
            const classes = cls.split(' ');
            if (!classes[0].startsWith('hljs-') || WRAPPERS.has(classes[0])) continue;   // sub-language spans, wrappers
            spans++;
            if (!coloured.some((need) => need.every((c) => classes.includes(c)))) missing.add(`${cls} (${fence})`);
        }
    }
    assert.ok(spans > 800, `${spans} token spans checked`);
    assert.deepEqual([...missing], []);
});

test('code showcase: each program sample shows at least five token colours, each data format three', () => {
    const DATA = new Set(['yaml', 'json', 'diff', 'markdown', 'nginx', 'dockerfile']);
    const roleOf = (classes) => {
        let best = null;
        for (const [role, selectors] of CODE_TOKEN_ROLES) {
            for (const sel of selectors.filter((x) => !/\s/.test(x.trim()))) {   // context-free selectors only
                const need = sel.trim().split('.').filter(Boolean);
                if (need.every((c) => classes.includes(c)) && (!best || need.length >= best.n)) best = {role, n: need.length};
            }
        }
        return best && best.role;
    };
    for (const [fence, code] of SHOWCASE) {
        const roles = new Set([...render(code, fence).matchAll(/<span class="(hljs-[^"]+)">/g)]
            .map((m) => roleOf(m[1].split(' '))).filter((r) => r && r !== 'inherit' && r !== 'punctuation'));
        assert.ok(roles.size >= (DATA.has(fence) ? 3 : 5), `${fence}: ${[...roles].join(', ')}`);
    }
});

// ── Office export reads the code, never the label ───────────────────────────

test('PowerPoint blocks: a labelled code block gives the same block as an unlabelled one', () => {
    const plain = pptxBlocksFromHtml('<pre><code class="hljs language-php">echo 1;\n$x = 2;</code></pre>');
    const labelled = pptxBlocksFromHtml(render('echo 1;\n$x = 2;', 'php'));
    assert.deepEqual(labelled, plain);
    assert.deepEqual(labelled[0].lines, ['echo 1;', '$x = 2;']);
});
