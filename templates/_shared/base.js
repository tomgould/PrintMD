/**
 * templates/_shared/base.js
 * What every template shares: HTML escaping for cover pages, the default
 * preflight check, and the structural CSS a template's own styles extend.
 *
 * A template builds on it:
 *   import {baseStyles, escapeHtml, preflightChecks} from '../_shared/base.js';
 *   export const styles = baseStyles('acme') + `.template-acme h1 { color: red; }`;
 *   export default {id: 'acme', renderCover(doc) {...}, preflightChecks};
 */

import {CODE_LANGUAGES, DEFAULT_LANG_COLOR} from '../../js/code-languages.js';
import {SYMBOL_FALLBACK_FAMILIES} from '../../js/fonts.js';

/**
 * IDE-style syntax colours for code blocks, modelled on One Dark Pro (dark
 * code backgrounds) and One Light (light ones), with the same hue for the same
 * role in both. Every colour, and the label, has at least 4.5:1 contrast with
 * the code background of each template that uses the palette
 * (tests/code-languages.test.mjs checks it). They replace the vendored
 * atom-one-dark colours, whose comment grey is below 3:1 on these backgrounds.
 */
export const CODE_PALETTES = Object.freeze({
    dark: Object.freeze({
        label: '#b4bcc8', punctuation: '#b9c0ca', comment: '#9ea6b3', keyword: '#d7a4f2', type: '#ecc681',
        function: '#73bdf6', builtin: '#5fcbd6', operator: '#5fcbd6', variable: '#f2959b', tag: '#f2959b',
        constant: '#f0b07a', string: '#a8d98a', meta: '#f2a2c8', addition: '#a8d98a', deletion: '#f2959b',
    }),
    light: Object.freeze({
        label: '#5f6872', punctuation: '#4b5563', comment: '#6b7280', keyword: '#a626a4', type: '#866300',
        function: '#2f5bd2', builtin: '#0b6f8a', operator: '#0b6f8a', variable: '#c22f3a', tag: '#c22f3a',
        constant: '#b04e0f', string: '#3b7a26', meta: '#b32d6e', addition: '#3b7a26', deletion: '#c22f3a',
    }),
});

/** Background tints for diff lines, laid over the code background. */
export const CODE_TINTS = Object.freeze({
    dark: Object.freeze({addition: 'rgba(152, 195, 121, 0.14)', deletion: 'rgba(224, 108, 117, 0.13)'}),
    light: Object.freeze({addition: 'rgba(46, 160, 67, 0.08)', deletion: 'rgba(207, 34, 46, 0.08)'}),
});

/**
 * Which highlight.js 11.9 scopes take which palette colour. Scopes with a
 * sub-scope are emitted as two classes ("title.class_" is
 * class="hljs-title class_"), so the more specific selector wins over the
 * plain one whatever the order. tests/code-languages.test.mjs checks that
 * every scope the grammars emit for the sample files has a colour here.
 */
export const CODE_TOKEN_ROLES = Object.freeze([
    ['punctuation', ['.hljs-punctuation', '.hljs-tag']],
    ['keyword', ['.hljs-keyword', '.hljs-template-tag', '.hljs-meta .hljs-keyword']],
    ['keyword', ['.hljs-doctag', '.hljs-emphasis'], 'font-style: italic;'],
    ['type', ['.hljs-type', '.hljs-title.class_', '.hljs-class .hljs-title', '.hljs-title.class_.inherited__']],
    ['function', ['.hljs-title', '.hljs-title.function_', '.hljs-function .hljs-title', '.hljs-selector-id']],
    ['function', ['.hljs-link'], 'text-decoration: underline;'],
    ['builtin', ['.hljs-built_in', '.hljs-selector-pseudo']],
    ['operator', ['.hljs-operator', '.hljs-regexp', '.hljs-char.escape_']],
    ['variable', ['.hljs-variable', '.hljs-template-variable', '.hljs-property', '.hljs-attr', '.hljs-attribute', '.hljs-subst']],
    ['variable', ['.hljs-variable.language_'], 'font-style: italic;'],
    // A parameter list is a container: grammars put types, names and defaults in
    // it, and colour only some of them. Plain text keeps those inner colours readable.
    ['inherit', ['.hljs-params']],
    ['constant', ['.hljs-number', '.hljs-literal', '.hljs-variable.constant_', '.hljs-symbol', '.hljs-bullet',
        '.hljs-selector-class', '.hljs-selector-attr', '.hljs-tag .hljs-attr']],
    ['constant', ['.hljs-strong'], 'font-weight: 700;'],
    ['string', ['.hljs-string', '.hljs-meta .hljs-string', '.hljs-char', '.hljs-code', '.hljs-formula']],
    ['comment', ['.hljs-comment', '.hljs-quote'], 'font-style: italic;'],
    ['keyword', ['.hljs-comment .hljs-doctag'], 'font-style: italic;'],
    ['meta', ['.hljs-meta', '.hljs-meta.prompt_']],
    ['tag', ['.hljs-name', '.hljs-selector-tag']],
    ['tag', ['.hljs-section'], 'font-weight: 700;'],
    // C# marks class, interface and namespace names as a bare title, and functions
    // as a title inside a function scope.
    ['type', ['.language-csharp .hljs-title']],
    ['function', ['.language-csharp .hljs-function .hljs-title']],
    ['addition', ['.hljs-addition'], 'background: var(--bd-code-add);'],
    ['deletion', ['.hljs-deletion'], 'background: var(--bd-code-del);'],
]);

/**
 * Code-block CSS for one template: the language label and its colour dot
 * (from data-lang / data-lang-id, js/code-languages.js), tab size, line
 * height and the token palette.
 * @param {string} s  the template's scope selector
 * @param {'dark'|'light'} theme  which palette suits the template's code background
 * @returns {string}
 */
function codeBlockStyles(s, theme) {
    const key = CODE_PALETTES[theme] ? theme : 'dark';
    const p = CODE_PALETTES[key];
    const tokens = CODE_TOKEN_ROLES.map(([role, selectors, extra = '']) =>
        `${selectors.map((sel) => `${s} ${sel}`).join(',\n')} { color: ${role === 'inherit' ? 'inherit' : p[role]};${extra ? ` ${extra}` : ''} }`).join('\n');
    const accents = CODE_LANGUAGES.map((l) => `${s} pre[data-lang-id="${l.id}"] { --bd-lang: ${l.color}; }`).join('\n');
    return `
${s} pre {
  position: relative;
  line-height: 1.5;
  tab-size: 4;
  -moz-tab-size: 4;
}
${s} pre code.hljs {
  display: block;
  padding: 0;
  color: inherit;
  background: none;
  --bd-code-add: ${CODE_TINTS[key].addition};
  --bd-code-del: ${CODE_TINTS[key].deletion};
}
/* The language label: small, quiet, top right, inside the block. Generated
   content, so Word and PowerPoint export (which read the code text) never see it. */
${s} pre[data-lang] {
  --bd-lang: ${DEFAULT_LANG_COLOR};
  padding-top: 30px;
}
${s} pre[data-lang]::before {
  content: attr(data-lang);
  position: absolute;
  top: 9px;
  right: 14px;
  padding-left: 12px;
  font-family: 'Inter', 'Montserrat', 'Helvetica Neue', Arial, sans-serif;
  font-size: 10px;
  font-style: normal;
  font-weight: 600;
  line-height: 1;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  white-space: nowrap;
  color: ${p.label};
  background: radial-gradient(circle at 4px 50%, var(--bd-lang) 3.2px, transparent 3.8px) no-repeat;
}
${accents}
${tokens}
`;
}

/**
 * Text safe inside HTML elements and quoted attributes.
 * @param {*} str
 * @returns {string}
 */
export function escapeHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * The default preflight check: warn when the document has no title.
 * @param {{title: string}} doc
 * @returns {string[]}
 */
export function preflightChecks(doc) {
    const warnings = [];
    if (!doc.title || doc.title === 'Untitled') warnings.push('No document title found (add a # H1 heading)');
    return warnings;
}

/**
 * The layout rules every template has, scoped under .template-{id}: box model,
 * heading rhythm, table, code and image basics, the cover page frame, the
 * print page-break rules and, in print, wrapping for long code lines and
 * unbroken tokens (a PDF cannot scroll). They come first, so a template's own rules for the
 * same selectors add to them and override them.
 * @param {string} id  the template id (manifest.id)
 * @param {{codeTheme?: 'dark'|'light'}} [opts]  codeTheme: the syntax palette for the
 *        template's code-block background (default dark)
 * @returns {string} CSS
 */
export function baseStyles(id, {codeTheme = 'dark'} = {}) {
    const s = `.template-${id}`;
    return `
${s} {
  font-weight: 400;
  max-width: none;
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}
${s} h1 {
  letter-spacing: -0.02em;
  line-height: 1.15;
}
${s} h4,
${s} h5,
${s} h6 {
  font-size: 1em;
  font-weight: 600;
}
${s} strong { font-weight: 700; }
${s} em { font-style: italic; }
${s} table {
  border-collapse: collapse;
  width: 100%;
}
${s} table th {
  padding: 10px 14px;
  text-align: left;
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}
${s} table td {
  padding: 10px 14px;
  vertical-align: top;
}
${s} code {
  padding: 2px 6px;
  border-radius: 3px;
}
${s} pre {
  padding: 1.1em 1.4em;
  overflow-x: auto;
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}
${s} pre code {
  background: none;
  padding: 0;
}
/* The browser's own style gives these "monospace", a system font: print them in the vendored code font. */
${s} kbd,
${s} samp,
${s} tt {
  font-family: 'Source Code Pro', ${SYMBOL_FALLBACK_FAMILIES}, monospace;
}
${codeBlockStyles(s, codeTheme)}
${s} a { text-decoration: none; }
${s} hr { border: none; }
${s} img {
  max-width: 100%;
  height: auto;
}
${s} .cover-page {
  min-height: 257mm;
  display: flex;
  flex-direction: column;
  background: #ffffff;
  box-sizing: border-box;
  page-break-after: always;
  break-after: page;
}
@media print {
  ${s} .cover-page {
    min-height: var(--bd-page-height, 297mm);
    page-break-after: always;
    break-after: page;
  }
  /* Print quality (README, Print quality). A heading never ends a page; a
     paragraph or list item never leaves fewer than three lines on either side
     of a break; table rows, figures and images stay whole, and a table that
     runs on repeats its header row; an image is never taller than the text
     column (--bd-page-content-height, js/print-document.js) and keeps its
     shape; a long address in running text wraps instead of reaching the margin. */
  ${s} h1,
  ${s} h2,
  ${s} h3,
  ${s} h4,
  ${s} h5,
  ${s} h6 {
    page-break-after: avoid;
    break-after: avoid;
    page-break-inside: avoid;
    break-inside: avoid;
  }
  ${s} p,
  ${s} li,
  ${s} dd,
  ${s} dt,
  ${s} blockquote {
    orphans: 3;
    widows: 3;
  }
  ${s} tr,
  ${s} figure,
  ${s} img,
  ${s} svg {
    page-break-inside: avoid;
    break-inside: avoid;
  }
  /* Definition lists from Markdown (a Term line, then ": definition" lines): the term in bold and kept with its
     first definition, the definitions indented. Only a dl with no class, which is what Markdown produces: the
     templates' own cover lists (a dl with a class) keep their styles. */
  ${s} dl:not([class]) > dt {
    font-weight: 700;
    margin: 0.7em 0 0.15em;
    page-break-after: avoid;
    break-after: avoid;
  }
  ${s} dl:not([class]) > dd {
    margin: 0 0 0.4em 1.5em;
    page-break-inside: avoid;
    break-inside: avoid;
  }
  /* Footnotes (js/markdown.js): the notes are a smaller numbered list after a rule; the numbers in the text and the
     way back are links with no underline. */
  ${s} sup.footnote-ref a,
  ${s} a.footnote-back { text-decoration: none; }
  ${s} section.footnotes {
    margin-top: 2em;
    font-size: 0.85em;
  }
  ${s} section.footnotes hr { margin: 0 0 0.6em; }
  ${s} section.footnotes ol {
    margin: 0;
    padding-left: 1.6em;
  }
  ${s} section.footnotes li { margin: 0 0 0.3em; }
  ${s} thead { display: table-header-group; }
  ${s} tfoot { display: table-footer-group; }
  ${s} img,
  ${s} svg,
  ${s} video,
  ${s} canvas {
    max-width: 100%;
    max-height: calc(var(--bd-page-content-height, 257mm) - 12mm);
    object-fit: contain;
  }
  ${s} a { overflow-wrap: anywhere; }
  ${s} td a,
  ${s} th a { overflow-wrap: break-word; }
  ${s} table { page-break-inside: avoid; }
  /* A block of up to 25 lines stays on one page; a longer one (class
     bd-code-long, js/code-languages.js) may break, but never leaves its label
     and first lines alone at the foot of a page. */
  ${s} pre:not(.bd-code-long) {
    page-break-inside: avoid;
    break-inside: avoid;
  }
  ${s} pre.bd-code-long {
    orphans: 3;
    widows: 3;
  }

  /* A PDF cannot scroll: long code lines, URLs and hashes wrap instead of being
     cut off at the page edge. The on-screen preview keeps its horizontal scroll.
     break-word (inherited by text, inline code and table cells) never narrows a
     table column below its longest word; long tokens in cells get <wbr> break
     opportunities from js/print-document.js. "anywhere" only where a block is
     already full width and cannot be squeezed: code blocks. */
  ${s} { overflow-wrap: break-word; }
  ${s} pre {
    overflow: visible;
    white-space: pre-wrap;
  }
  ${s} pre code {
    white-space: pre-wrap;
  }
  ${s} pre,
  ${s} pre code { overflow-wrap: anywhere; }
}
`;
}
