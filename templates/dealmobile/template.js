/**
 * Dealmobile template: a magazine article page. Heavy Schibsted Grotesk
 * headlines over a Libre Caslon Text body, warm ink, one red accent, a
 * running head and foot, generous margins and a typographic cover with no
 * logo. Code blocks use the light palette on warm paper.
 */

import {baseStyles, escapeHtml, preflightChecks} from '../_shared/base.js';
import {SYMBOL_FALLBACK_FAMILIES} from '../../js/fonts.js';

const ID = 'dealmobile';
const SYM = SYMBOL_FALLBACK_FAMILIES;

export const manifest = {
    id: ID,
    name: 'Dealmobile',
    description: 'Magazine article: grotesque headlines over a Caslon text face, one red accent, running head and foot',
    author: 'PrintMD',
    version: '1.0.0',
    accent: '#b82f0e',
    fontStack: `'Libre Caslon Text', ${SYM}, Georgia, serif`,
    page: {margin: '24mm', sizes: ['A4', 'A3', 'A5', 'Letter', 'Legal']},
};

const s = `.template-${ID}`;

export const styles = baseStyles(ID, {codeTheme: 'light'}) + `
${s} {
  --ed-ink:   #13110d;
  --ed-body:  #2d2820;
  --ed-muted: #6a6152;
  --ed-red:   #b82f0e;
  --ed-paper: #faf7ef;
  --ed-rule:  #dfd7c7;
  --ed-mark:  #f6e1d8;
  --ed-serif: 'Libre Caslon Text', ${SYM}, serif;
  --ed-sans:  'Schibsted Grotesk', ${SYM}, sans-serif;
  --ed-mono:  'Source Code Pro', ${SYM}, monospace;

  background: #ffffff;
  color: var(--ed-body);
  font-family: var(--ed-serif);
  font-size: 14px;
  line-height: 1.65;
  font-synthesis: none;
}

/* Headings: grotesque 800, then 500 italic, then small red capitals. */
${s} h1,
${s} h2,
${s} h3,
${s} h4,
${s} h5 {
  font-family: var(--ed-sans);
  color: var(--ed-ink);
}
${s} h1 {
  font-size: 2.1em;
  font-weight: 800;
  line-height: 1.08;
  letter-spacing: -0.03em;
  margin: 1.5em 0 0.5em;
}
${s} > h1:first-child,
${s} .cover-page + h1 { margin-top: 0; }
${s} h2 {
  font-size: 1.45em;
  font-weight: 500;
  font-style: italic;
  line-height: 1.2;
  letter-spacing: -0.01em;
  margin: 1.6em 0 0.45em;
}
${s} h3 {
  font-size: 0.74em;
  font-weight: 700;
  line-height: 1.3;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--ed-red);
  margin: 1.8em 0 0.6em;
}
${s} h4 {
  font-size: 1em;
  font-weight: 700;
  margin: 1.4em 0 0.35em;
}
${s} h5 {
  font-size: 0.78em;
  font-weight: 500;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--ed-muted);
  margin: 1.4em 0 0.4em;
}
${s} h6 {
  font-family: var(--ed-serif);
  font-size: 1em;
  font-weight: 400;
  font-style: italic;
  color: var(--ed-muted);
  margin: 1.3em 0 0.3em;
}

/* Text */
${s} p { margin: 0 0 0.9em; }
${s} strong { color: var(--ed-ink); }
${s} del { color: var(--ed-muted); }
${s} a {
  color: var(--ed-red);
  text-decoration: underline;
  text-decoration-thickness: 1px;
  text-decoration-color: #e2b4a6;
  text-underline-offset: 0.18em;
}
${s} mark {
  background: var(--ed-mark);
  color: var(--ed-ink);
  padding: 0 0.15em;
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}
${s} kbd {
  font-size: 0.8em;
  color: var(--ed-ink);
  background: #ffffff;
  border: 1px solid var(--ed-rule);
  border-bottom-width: 2px;
  border-radius: 3px;
  padding: 0 0.35em;
}

/* Lists: an en dash in red, numbers in the grotesque. */
${s} ul,
${s} ol {
  padding-left: 1.5em;
  margin: 0.4em 0 1em;
}
${s} ul { list-style-type: '\\2013\\00a0\\00a0'; }
${s} li { margin: 0.25em 0; }
${s} li > ul,
${s} li > ol { margin: 0.2em 0 0.3em; }
${s} ul > li::marker { color: var(--ed-red); }
${s} ol > li::marker {
  font-family: var(--ed-sans);
  font-weight: 700;
  font-size: 0.85em;
  color: var(--ed-red);
}
${s} li:has(> input[type="checkbox"]) { list-style: none; }
${s} li > input[type="checkbox"] {
  margin: 0 0.5em 0 -1.4em;
  vertical-align: -0.1em;
}

/* Quote: Caslon italic on a 2 px red rule. */
${s} blockquote {
  margin: 1.4em 0;
  padding: 0.1em 0 0.1em 1.1em;
  border-left: 2px solid var(--ed-red);
  font-size: 1.07em;
  font-style: italic;
  color: var(--ed-body);
}
${s} blockquote p { margin: 0.45em 0; }
${s} blockquote > :first-child { margin-top: 0; }
${s} blockquote > :last-child { margin-bottom: 0; }
${s} blockquote blockquote {
  font-size: 1em;
  margin: 0.7em 0;
  border-left: 1px solid var(--ed-rule);
}
${s} blockquote code { font-style: normal; }

/* Tables: no fills, an ink rule under the header, warm hairlines. */
${s} table {
  margin: 1.3em 0 1.6em;
  font-family: var(--ed-sans);
  font-size: 12px;
  line-height: 1.45;
}
${s} table th {
  font-weight: 700;
  color: var(--ed-ink);
  background: none;
  border-bottom: 1.5px solid var(--ed-ink);
  padding: 6px 12px 6px 0;
  vertical-align: bottom;
}
${s} table td {
  color: var(--ed-body);
  border-bottom: 1px solid var(--ed-rule);
  padding: 7px 12px 7px 0;
}
${s} table th:last-child,
${s} table td:last-child { padding-right: 0; }

/* Code */
${s} code {
  font-family: var(--ed-mono);
  font-size: 0.84em;
  color: var(--ed-body);
  background: var(--ed-paper);
  border: 1px solid var(--ed-rule);
  border-radius: 2px;
  padding: 0.05em 0.35em;
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}
${s} pre {
  background: #faf7ef;
  color: #2d2820;
  border: 1px solid #dfd7c7;
  border-radius: 3px;
  margin: 1.2em 0 1.4em;
  font-family: var(--ed-mono);
  font-size: 12px;
}
${s} pre code {
  font-size: 1em;
  border: none;
  background: none;
  padding: 0;
}

/* Rule: a short red bar, as between sections of an article. */
${s} hr {
  width: 3em;
  height: 0;
  border-top: 2px solid var(--ed-red);
  margin: 2.2em auto;
}
${s} img { margin: 0.4em 0; }

/* ── Cover: an article opener, no full bleed ─────────────────────────────── */
${s} .cover-page {
  --ed-pw: var(--bd-page-width, 210mm);
  --ed-ph: var(--bd-page-height, 297mm);
  padding: 16mm 24mm 18mm;
  color: var(--ed-ink);
  font-family: var(--ed-sans);
}
${s} .ed-cover-head {
  display: flex;
  justify-content: space-between;
  gap: 8mm;
  padding-bottom: 2.4mm;
  border-bottom: 1px solid var(--ed-rule);
  font-size: 8.5pt;
  font-weight: 500;
  color: var(--ed-muted);
  min-height: 1.3em;
}
${s} .ed-cover-head strong {
  font-weight: 700;
  color: var(--ed-ink);
}
${s} .ed-title {
  /* Sized to the page: the smaller of a share of its width and of its height. */
  --ed-size: min(calc(var(--ed-pw) * 0.105), calc(var(--ed-ph) * 0.074));
  font-size: var(--ed-size);
  font-weight: 800;
  line-height: 1.02;
  letter-spacing: -0.035em;
  color: var(--ed-ink);
  margin: calc(var(--ed-ph) * 0.07) 0 0;
  overflow-wrap: anywhere;
}
${s} .ed-title.ed-size-m { font-size: calc(var(--ed-size) * 0.74); line-height: 1.05; }
${s} .ed-title.ed-size-s { font-size: calc(var(--ed-size) * 0.5); line-height: 1.1; letter-spacing: -0.02em; }
${s} .ed-last {
  font-family: var(--ed-serif);
  font-weight: 400;
  font-style: italic;
  letter-spacing: -0.02em;
  color: var(--ed-red);
}
${s} .ed-cover-foot {
  margin-top: auto;
  padding-top: 5mm;
  border-top: 2px solid var(--ed-ink);
  display: flex;
  flex-wrap: wrap;
  gap: 6mm 8mm;
  align-items: flex-start;
}
${s} .ed-meta {
  flex: 1 1 40mm;
  max-width: 62mm;
  margin: 0;
}
${s} .ed-meta div {
  padding: 2mm 0 2.4mm;
  border-bottom: 1px solid var(--ed-rule);
}
${s} .ed-meta dt {
  font-size: 7pt;
  font-weight: 500;
  letter-spacing: 0.04em;
  color: var(--ed-muted);
  margin: 0 0 0.6mm;
}
${s} .ed-meta dd {
  font-size: 9.5pt;
  font-weight: 500;
  color: var(--ed-ink);
  margin: 0;
}
${s} .ed-panel {
  flex: 3 1 90mm;
  min-height: calc(var(--ed-ph) * 0.17);
  box-sizing: border-box;
  padding: 6mm 7mm 7mm;
  background: var(--ed-paper);
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}
${s} .ed-panel-label {
  font-size: 7pt;
  font-weight: 700;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--ed-red);
  margin: 0 0 3mm;
}
${s} .ed-panel-label::after {
  content: '';
  display: block;
  width: 10mm;
  margin-top: 3mm;
  border-top: 1px solid var(--ed-ink);
}
${s} .ed-panel-text {
  font-family: var(--ed-serif);
  font-style: italic;
  font-size: 15pt;
  line-height: 1.3;
  color: var(--ed-body);
  margin: 0;
  overflow-wrap: anywhere;
}
`;

/** The cover title, its last word in red Caslon italic; escaped. */
function coverTitle(title) {
    const text = String(title || '').trim();
    const cut = text.search(/\S+$/);
    const head = cut > 0 ? text.slice(0, cut) : '';
    const last = cut >= 0 ? text.slice(cut) : '';
    return `${escapeHtml(head)}${last ? `<em class="ed-last">${escapeHtml(last)}</em>` : ''}`;
}

/** A size step for the cover title from its length: long titles print smaller so the cover stays one page. */
function titleSize(title) {
    const n = Array.from(String(title || '').trim()).length;
    if (n <= 28) return 'l';
    if (n <= 64) return 'm';
    return 's';
}

export default {
    id: ID,

    renderCover(doc) {
        const title = doc.title || '';
        const author = doc.author || '';
        const date = doc.date || '';
        const subject = doc.subject || '';
        const meta = [
            date ? `<div><dt>Published</dt><dd>${escapeHtml(date)}</dd></div>` : '',
            author ? `<div><dt>Prepared by</dt><dd>${escapeHtml(author)}</dd></div>` : '',
        ].join('');
        return `<div class="cover-page">
  <div class="ed-cover-head"><span>${author ? `<strong>${escapeHtml(author)}</strong>` : ''}</span><span>${escapeHtml(date)}</span></div>
  <div class="ed-title ed-size-${titleSize(title)}">${coverTitle(title)}</div>
  <div class="ed-cover-foot">${meta ? `
    <dl class="ed-meta">${meta}</dl>` : ''}${subject ? `
    <div class="ed-panel">
      <p class="ed-panel-label">About this document</p>
      <p class="ed-panel-text">${escapeHtml(subject)}</p>
    </div>` : ''}
  </div>
</div>`;
    },

    transformHTML(html) {
        return html;
    },

    preflightChecks,

    runningHead: {left: '{author}', right: '{title}'},
    runningFoot: {left: '{date}', right: '{page} / {pages}'},
    runningStyle: {fontFamily: 'Schibsted Grotesk', fontSize: 7.5, fontWeight: 500, color: '#6a6152'},
};
