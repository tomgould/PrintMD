/**
 * code-languages.js
 * Fenced code blocks: the one list of languages PrintMD knows (fence
 * words, highlight.js grammar, label, accent colour), the grammars added to
 * the vendored highlight.js bundle, and the HTML for one block.
 *
 * A block written as ```php renders as
 *   <pre data-lang="PHP" data-lang-id="php"><code class="hljs language-php">...</code></pre>
 * Template CSS (templates/_shared/base.js) shows data-lang as a small label in
 * the block's top-right corner, with a dot in the language's colour, so the
 * label adds no DOM text: Word and PowerPoint export read the code only.
 *
 * Every highlight.js 11.9.0 language is available: the page loads
 * vendor/highlightjs/highlight.min.js (the common bundle) and then
 * vendor/highlightjs/languages.min.js (every other official grammar), see
 * vendor/highlightjs/README.md. A fence word for any of them is highlighted
 * even when it is not in CODE_LANGUAGES below.
 *
 * Pure apart from the hljs object passed in, so it runs in Node as well.
 */

import hcl from './hljs-hcl.js';

/** Grammars highlight.js does not ship: HCL (Terraform), js/hljs-hcl.js. */
export const EXTRA_GRAMMARS = Object.freeze({hcl});

/**
 * Every language with a label. id: data-lang-id and the colour key;
 * grammar: the highlight.js language (null: plain text); label: what the
 * reader sees; color: the accent dot (conventional colours, brightened where
 * the usual one disappears on a dark code background); fences: the words
 * written after ``` that select it (matched without case).
 */
export const CODE_LANGUAGES = Object.freeze([
    {id: 'php', grammar: 'php', label: 'PHP', color: '#777bb4', fences: ['php', 'php7', 'php8', 'phtml']},
    {id: 'javascript', grammar: 'javascript', label: 'JavaScript', color: '#f1e05a', fences: ['javascript', 'js', 'jsx', 'mjs', 'cjs', 'node']},
    {id: 'typescript', grammar: 'typescript', label: 'TypeScript', color: '#3178c6', fences: ['typescript', 'ts', 'tsx', 'mts', 'cts']},
    {id: 'json', grammar: 'json', label: 'JSON', color: '#cbcb41', fences: ['json', 'geojson', 'webmanifest']},
    {id: 'jsonc', grammar: 'json', label: 'JSONC', color: '#cbcb41', fences: ['jsonc']},
    {id: 'json5', grammar: 'json', label: 'JSON5', color: '#cbcb41', fences: ['json5']},
    {id: 'yaml', grammar: 'yaml', label: 'YAML', color: '#cb171e', fences: ['yaml', 'yml']},
    {id: 'html', grammar: 'xml', label: 'HTML', color: '#e34c26', fences: ['html', 'htm', 'xhtml']},
    {id: 'xml', grammar: 'xml', label: 'XML', color: '#3f8fd2', fences: ['xml', 'svg', 'xsd', 'xsl', 'xslt', 'plist', 'rss', 'atom']},
    {id: 'vue', grammar: 'xml', label: 'Vue', color: '#41b883', fences: ['vue']},
    {id: 'svelte', grammar: 'xml', label: 'Svelte', color: '#ff3e00', fences: ['svelte']},
    {id: 'twig', grammar: 'twig', label: 'Twig', color: '#bacf29', fences: ['twig', 'craftcms']},
    {id: 'blade', grammar: 'xml', label: 'Blade', color: '#f7523f', fences: ['blade']},
    {id: 'css', grammar: 'css', label: 'CSS', color: '#8a5cd0', fences: ['css']},
    {id: 'scss', grammar: 'scss', label: 'SCSS', color: '#c6538c', fences: ['scss', 'sass']},
    {id: 'less', grammar: 'less', label: 'Less', color: '#4d7ab8', fences: ['less']},
    {id: 'sql', grammar: 'sql', label: 'SQL', color: '#e38c00', fences: ['sql', 'mysql', 'mariadb', 'psql', 'pgsql', 'postgres', 'postgresql', 'sqlite', 'tsql', 'plsql']},
    {id: 'bash', grammar: 'bash', label: 'Bash', color: '#89e051', fences: ['bash', 'sh', 'zsh', 'ksh']},
    {id: 'shell', grammar: 'bash', label: 'Shell', color: '#89e051', fences: ['shell']},
    {id: 'console', grammar: 'shell', label: 'Console', color: '#89e051', fences: ['console', 'shell-session', 'shellsession', 'terminal']},
    {id: 'powershell', grammar: 'powershell', label: 'PowerShell', color: '#5391fe', fences: ['powershell', 'ps', 'ps1', 'pwsh']},
    {id: 'python', grammar: 'python', label: 'Python', color: '#3572a5', fences: ['python', 'py', 'python3', 'py3', 'gyp']},
    {id: 'pycon', grammar: 'python-repl', label: 'Python', color: '#3572a5', fences: ['pycon', 'python-repl']},
    {id: 'dockerfile', grammar: 'dockerfile', label: 'Dockerfile', color: '#2496ed', fences: ['dockerfile', 'docker', 'containerfile']},
    {id: 'nginx', grammar: 'nginx', label: 'nginx', color: '#009639', fences: ['nginx', 'nginxconf']},
    {id: 'apache', grammar: 'apache', label: 'Apache', color: '#d22128', fences: ['apache', 'apacheconf', 'htaccess']},
    {id: 'terraform', grammar: 'hcl', label: 'Terraform', color: '#7b42bc', fences: ['terraform', 'tf', 'tfvars', 'opentofu']},
    {id: 'hcl', grammar: 'hcl', label: 'HCL', color: '#7b42bc', fences: ['hcl']},
    {id: 'diff', grammar: 'diff', label: 'Diff', color: '#8a94a6', fences: ['diff', 'patch']},
    {id: 'markdown', grammar: 'markdown', label: 'Markdown', color: '#519aba', fences: ['markdown', 'md', 'mkd', 'mkdown']},
    {id: 'ini', grammar: 'ini', label: 'INI', color: '#a0aab4', fences: ['ini', 'cfg', 'conf', 'cnf']},
    {id: 'toml', grammar: 'ini', label: 'TOML', color: '#c0713e', fences: ['toml']},
    {id: 'env', grammar: 'ini', label: 'env', color: '#ecd53f', fences: ['env', 'dotenv']},
    {id: 'properties', grammar: 'properties', label: 'Properties', color: '#2a6ebb', fences: ['properties', 'java-properties']},
    {id: 'http', grammar: 'http', label: 'HTTP', color: '#3b8eea', fences: ['http', 'https']},
    {id: 'graphql', grammar: 'graphql', label: 'GraphQL', color: '#e10098', fences: ['graphql', 'gql']},
    {id: 'go', grammar: 'go', label: 'Go', color: '#00add8', fences: ['go', 'golang']},
    {id: 'rust', grammar: 'rust', label: 'Rust', color: '#dea584', fences: ['rust', 'rs']},
    {id: 'java', grammar: 'java', label: 'Java', color: '#b07219', fences: ['java']},
    {id: 'kotlin', grammar: 'kotlin', label: 'Kotlin', color: '#a97bff', fences: ['kotlin', 'kt', 'kts']},
    {id: 'csharp', grammar: 'csharp', label: 'C#', color: '#4caf50', fences: ['csharp', 'cs', 'c#']},
    {id: 'c', grammar: 'c', label: 'C', color: '#8a8f98', fences: ['c', 'h']},
    {id: 'cpp', grammar: 'cpp', label: 'C++', color: '#f34b7d', fences: ['cpp', 'c++', 'cc', 'cxx', 'hpp']},
    {id: 'ruby', grammar: 'ruby', label: 'Ruby', color: '#cc342d', fences: ['ruby', 'rb', 'gemfile']},
    {id: 'swift', grammar: 'swift', label: 'Swift', color: '#f05138', fences: ['swift']},
    {id: 'lua', grammar: 'lua', label: 'Lua', color: '#5a6fd6', fences: ['lua']},
    {id: 'perl', grammar: 'perl', label: 'Perl', color: '#39a7c9', fences: ['perl', 'pl', 'pm']},
    {id: 'makefile', grammar: 'makefile', label: 'Makefile', color: '#427819', fences: ['makefile', 'make', 'mk']},
    {id: 'text', grammar: null, label: 'Text', color: '#9aa0a6', fences: ['text', 'txt', 'plaintext', 'plain']},
]);

/** Accent colour of a block whose fence word is not in CODE_LANGUAGES. */
export const DEFAULT_LANG_COLOR = '#9aa0a6';

/** A fence word that may reach an attribute or class: anything else renders as plain text with no label. */
export const FENCE_WORD_RE = /^[A-Za-z0-9_+#.-]{1,24}$/;

/** What data-lang (the label) and data-lang-id may hold, also for raw HTML (checked in js/markdown.js). */
export const LANG_LABEL_RE = /^[A-Za-z0-9_+#. -]{1,24}$/;
export const LANG_ID_RE = /^[a-z0-9_+#.-]{1,24}$/;

/** Blocks longer than this many lines may break across pages (class bd-code-long); shorter ones stay whole. */
export const CODE_BLOCK_KEEP_LINES = 25;

const BY_FENCE = new Map();
for (const lang of CODE_LANGUAGES) {
    for (const fence of lang.fences) BY_FENCE.set(fence, lang);
}

const registered = new WeakSet();

/**
 * Add EXTRA_GRAMMARS to an hljs instance (once per instance).
 * @param {object} hljs
 */
export function registerCodeLanguages(hljs) {
    if (!hljs || registered.has(hljs)) return;
    for (const [name, grammar] of Object.entries(EXTRA_GRAMMARS)) {
        if (!hljs.getLanguage(name)) hljs.registerLanguage(name, grammar);
    }
    registered.add(hljs);
}

/**
 * What a fence info string selects. Only its first word counts ("js title=x" -> "js").
 * @param {string} info  the text after ``` (user input)
 * @param {object} [hljs]  to accept fence words highlight.js knows that the list does not
 * @returns {{id: string, label: string, grammar: string|null}|null}  null: no label, plain text
 */
export function resolveCodeLanguage(info, hljs) {
    const word = String(info == null ? '' : info).trim().split(/\s+/)[0] || '';
    if (!FENCE_WORD_RE.test(word)) return null;
    const known = BY_FENCE.get(word.toLowerCase());
    if (known) return {id: known.id, label: known.label, grammar: known.grammar};
    const def = hljs ? hljs.getLanguage(word) : null;
    if (!def) return {id: '', label: word.toUpperCase(), grammar: null};
    // highlight.js's own name when it fits a label ("Haskell" for hs), else the fence word.
    const name = typeof def.name === 'string' ? def.name : '';
    return {id: '', label: LANG_LABEL_RE.test(name) ? name : word.toUpperCase(), grammar: word.toLowerCase()};
}

/**
 * Languages whose naming convention makes a PascalCase name a type or class.
 * highlight.js colours a class where it is declared, not where it is used
 * (List<Article>, Clock $clock, new Map()), which an IDE does colour.
 */
const TYPE_NAME_GRAMMARS = new Set(['java', 'kotlin', 'scala', 'swift', 'dart', 'typescript', 'javascript',
    'csharp', 'rust', 'php', 'python']);
/** Scopes that only wrap other tokens; text directly inside them is still unclassified code. */
const CONTAINER_SCOPES = new Set(['hljs-params', 'hljs-function', 'hljs-class']);
// A name starting with a capital, the character before it, and whether a "(" follows.
// One unbounded run only, so no input can make it backtrack; the callback checks for a
// lower-case letter (ALL_CAPS is a constant).
const PASCAL_RE = /(^|[^A-Za-z0-9_$\\])([A-Z][A-Za-z0-9_]*)(?![A-Za-z0-9_$])([ \t]*\()?/g;
const HAS_LOWER = /[a-z]/;
// What comes right before a member name (escaped, as in highlight.js output): . ?. -> ::
const MEMBER_BEFORE = /(?:\.|-&gt;|::)$/;
const NEW_BEFORE = /(?:^|[^A-Za-z0-9_$])new\s+$/;
const TAIL = 24;

/**
 * Mark unclassified PascalCase names in highlight.js output as types
 * (hljs-type). A name after ".", "?.", "->" or "::" is a member and stays as
 * it is. In C#, where methods are PascalCase too, a name before "(" is a call
 * (hljs-title function_), unless "new" comes first: a constructor names a type.
 * Strings, comments and every other token are left alone. Linear in the input
 * (tests/code-languages.test.mjs checks growth on hostile inputs).
 * @param {string} html  highlight.js output (only <span class="..."> and </span> tags)
 * @param {string} grammar
 * @returns {string}
 */
export function markTypeNames(html, grammar) {
    if (!TYPE_NAME_GRAMMARS.has(grammar)) return html;
    const stack = [];
    let tail = '';   // the last TAIL characters of text so far, inside spans too, for what precedes a name
    return html.split(/(<span class="[^"]*">|<\/span>)/).map((part) => {
        if (part.startsWith('<span ')) {
            stack.push(part.slice(13, -2));
            return part;
        }
        if (part === '</span>') {
            stack.pop();
            return part;
        }
        const head = tail;
        tail = (tail + part).slice(-TAIL);
        if (!stack.every((cls) => CONTAINER_SCOPES.has(cls))) return part;
        return part.replace(PASCAL_RE, (m, before, name, call = '', offset) => {
            if (!HAS_LOWER.test(name)) return m;
            const start = offset + before.length;
            const context = (head + part.slice(Math.max(0, start - TAIL), start)).slice(-TAIL);
            const isNew = NEW_BEFORE.test(context);
            if (call && grammar === 'csharp' && !isNew) return `${before}<span class="hljs-title function_">${name}</span>${call}`;
            if (MEMBER_BEFORE.test(context)) return m;
            return `${before}<span class="hljs-type">${name}</span>${call}`;
        });
    }).join('');
}

function escapeText(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Limits on syntax highlighting, in characters. Some highlight.js grammars
 * take time that grows with the square of a line's length (markdown on
 * "[a[a[a...", java on one very long word), so a block that passes a limit is
 * printed as plain monospace text, label kept. That bounds the work for any
 * document the editor or the PDF API renders.
 */
export const HIGHLIGHT_LIMITS = Object.freeze({
    block: 100000,          // one code block
    markdownBlock: 20000,   // one block in the markdown grammar, quadratic even on short lines
    line: 1000,             // the longest line of a block
    document: 500000,       // all highlighted code in one document; later blocks stay plain
});

/**
 * A highlighting budget for one document (HIGHLIGHT_LIMITS.document characters).
 * js/markdown.js makes one per marked.parse().
 * @returns {{remaining: number}}
 */
export function createHighlightBudget() {
    return {remaining: HIGHLIGHT_LIMITS.document};
}

/** Whether a block may be highlighted with this grammar; spends the budget when it may. */
function mayHighlight(text, grammar, hljs, budget) {
    const def = hljs.getLanguage(grammar);
    const max = def && def.name === 'Markdown' ? HIGHLIGHT_LIMITS.markdownBlock : HIGHLIGHT_LIMITS.block;
    if (text.length > max || (budget && text.length > budget.remaining)) return false;
    let start = 0;
    for (;;) {
        const nl = text.indexOf('\n', start);
        const end = nl === -1 ? text.length : nl;
        if (end - start > HIGHLIGHT_LIMITS.line) return false;
        if (nl === -1) break;
        start = nl + 1;
    }
    if (budget) budget.remaining -= text.length;
    return true;
}

/**
 * The HTML of one fenced code block. Unlabelled fences are plain text with no
 * label (never auto-detected). One trailing newline is dropped. A block past
 * HIGHLIGHT_LIMITS keeps its label and is printed as plain text.
 * @param {string} code
 * @param {string} info  the fence info string
 * @param {object} hljs
 * @param {{remaining: number}} [budget]  the document's budget (createHighlightBudget)
 * @returns {string}
 */
export function codeBlockHtml(code, info, hljs, budget) {
    const text = String(code == null ? '' : code).replace(/\n$/, '');
    const lang = resolveCodeLanguage(info, hljs);
    let body = null;
    let language = 'plaintext';
    if (lang && lang.grammar && hljs) registerCodeLanguages(hljs);
    if (lang && lang.grammar && hljs && mayHighlight(text, lang.grammar, hljs, budget)) {
        try {
            body = markTypeNames(hljs.highlight(text, {language: lang.grammar, ignoreIllegals: true}).value, lang.grammar);
            language = lang.grammar;
        } catch {
            body = null;
        }
    }
    if (body === null) body = escapeText(text);
    const attrs = [];
    if (text.split('\n').length > CODE_BLOCK_KEEP_LINES) attrs.push('class="bd-code-long"');
    if (lang) {
        attrs.push(`data-lang="${escapeText(lang.label)}"`);
        if (lang.id) attrs.push(`data-lang-id="${lang.id}"`);
    }
    const open = attrs.length ? `<pre ${attrs.join(' ')}>` : '<pre>';
    return `${open}<code class="hljs language-${language}">${body}</code></pre>`;
}
