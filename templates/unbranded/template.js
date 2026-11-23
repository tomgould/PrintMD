/**
 * Unbranded Template
 * An elegant, classic document template with no company branding.
 * Source of truth for the app: manifest data and styles are embedded here
 * so the app works on file:// without a server (fetch() is blocked on file://)
 */

import {baseStyles, escapeHtml, preflightChecks} from '../_shared/base.js';

export const manifest = {
    id: 'unbranded',
    name: 'Unbranded',
    description: 'Elegant, classic document template with no company branding',
    author: 'PrintMD',
    version: '1.0.0',
    accent: '#2a2a2a',
    fontStack: "'Source Serif Pro', Georgia, 'Times New Roman', serif",
    page: { margin: '22mm' }
};

export const styles = baseStyles('unbranded', {codeTheme: 'light'}) + `
.template-unbranded {
  /* ── Neutral tokens ── */
  --ub-ink:     #1c1c1c;
  --ub-soft:    #3a3a3a;
  --ub-bg:      #ffffff;
  --ub-surface: #fafaf7;
  --ub-border:  #d8d4cc;
  --ub-rule:    #2a2a2a;
  --ub-muted:   #7a7670;
  --ub-serif:   'Source Serif Pro', 'Source Code Pro Symbols', 'Noto Sans Symbols 2', 'Noto Sans Symbols',Georgia, 'Times New Roman', serif;
  --ub-sans:    'Inter', 'Source Code Pro Symbols', 'Noto Sans Symbols 2', 'Noto Sans Symbols','Helvetica Neue', Arial, sans-serif;
  --ub-mono:    'Source Code Pro', 'Noto Sans Symbols 2', 'Noto Sans Symbols','Cascadia Code', 'Fira Code', Consolas, monospace;

  background: var(--ub-bg);
  color: var(--ub-ink);
  font-family: var(--ub-serif);
  font-size: 16.5px;
  line-height: 1.7;
  text-rendering: optimizeLegibility;
  -webkit-font-smoothing: antialiased;
}

/* ── Headings ── */
.template-unbranded h1 {
  font-family: var(--ub-sans);
  font-size: 2.4em;
  font-weight: 700;
  color: var(--ub-ink);
  margin: 0 0 0.7em;
  padding-bottom: 0.45em;
  border-bottom: 2px solid var(--ub-rule);
}

.template-unbranded h2 {
  font-family: var(--ub-sans);
  font-size: 1.55em;
  font-weight: 600;
  color: var(--ub-ink);
  letter-spacing: -0.01em;
  margin: 2em 0 0.55em;
  padding-bottom: 0.25em;
  border-bottom: 1px solid var(--ub-border);
}

.template-unbranded h3 {
  font-family: var(--ub-sans);
  font-size: 1.2em;
  font-weight: 600;
  color: var(--ub-ink);
  margin: 1.7em 0 0.45em;
}

.template-unbranded h4,
.template-unbranded h5,
.template-unbranded h6 {
  font-family: var(--ub-sans);
  color: var(--ub-soft);
  text-transform: uppercase;
  letter-spacing: 0.08em;
  margin: 1.5em 0 0.4em;
}

/* ── Body ── */
.template-unbranded p {
  margin: 0 0 1.1em;
  hyphens: auto;
}
.template-unbranded p + p {
  text-indent: 0;
}
.template-unbranded strong { color: var(--ub-ink); }

/* ── Lists ── */
.template-unbranded ul,
.template-unbranded ol {
  padding-left: 1.5em;
  margin: 0.8em 0 1.2em;
}
.template-unbranded li {
  margin: 0.35em 0;
  padding-left: 0.3em;
}
.template-unbranded ul > li::marker {
  color: var(--ub-muted);
}
.template-unbranded ol > li::marker {
  color: var(--ub-muted);
  font-weight: 600;
}

/* ── Blockquote ── */
.template-unbranded blockquote {
  font-family: var(--ub-serif);
  font-style: italic;
  font-size: 1.08em;
  color: var(--ub-soft);
  border-left: 3px solid var(--ub-rule);
  padding: 0.3em 1.4em;
  margin: 1.6em 0.5em;
  line-height: 1.65;
}
.template-unbranded blockquote p { margin: 0.5em 0; }
.template-unbranded blockquote p:first-child::before {
  content: '\\201C';
  font-size: 1.6em;
  line-height: 0;
  vertical-align: -0.35em;
  margin-right: 0.1em;
  color: var(--ub-muted);
}

/* ── Table ── */
.template-unbranded table {
  margin: 1.6em 0;
  font-family: var(--ub-sans);
  font-size: 14.5px;
}
.template-unbranded table th {
  background: transparent;
  color: var(--ub-ink);
  font-weight: 600;
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  border-top: 2px solid var(--ub-rule);
  border-bottom: 1px solid var(--ub-rule);
}
.template-unbranded table td {
  border-bottom: 1px solid var(--ub-border);
}
.template-unbranded table tr:last-child td {
  border-bottom: 2px solid var(--ub-rule);
}

/* ── Code ── */
.template-unbranded code {
  background: var(--ub-surface);
  color: var(--ub-ink);
  font-family: var(--ub-mono);
  font-size: 0.86em;
  border: 1px solid var(--ub-border);
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}
.template-unbranded pre {
  background: var(--ub-surface);
  color: var(--ub-ink);
  border-radius: 4px;
  border: 1px solid var(--ub-border);
  border-left: 3px solid var(--ub-rule);
  margin: 1.5em 0;
  font-size: 14px;
  line-height: 1.55;
}
.template-unbranded pre code {
  border: none;
  font-size: 1em;
}

/* ── Links ── */
.template-unbranded a {
  color: var(--ub-ink);
  border-bottom: 1px solid var(--ub-muted);
  padding-bottom: 1px;
}
.template-unbranded a:hover {
  border-bottom-color: var(--ub-ink);
}

/* ── HR ── */
.template-unbranded hr {
  text-align: center;
  margin: 2.4em 0;
  line-height: 1;
  height: 1em;
}
.template-unbranded hr::before {
  content: '\\2756\\00a0\\00a0\\2756\\00a0\\00a0\\2756';
  color: var(--ub-muted);
  font-size: 0.9em;
  letter-spacing: 0.3em;
}

/* ── Images ── */
.template-unbranded img {
  display: block;
  margin: 1.5em auto;
}

/* ══════════════════════════════════════════════════════════════════════════════
   COVER PAGE: classic, centred, typographic
   ══════════════════════════════════════════════════════════════════════════════ */

.template-unbranded .cover-page {
  padding: 72px 80px;
  position: relative;
}

.template-unbranded .cover-page::before,
.template-unbranded .cover-page::after {
  content: '';
  position: absolute;
  left: 80px;
  right: 80px;
  height: 1px;
  background: var(--ub-rule);
}
.template-unbranded .cover-page::before { top: 72px; }
.template-unbranded .cover-page::after  { bottom: 72px; }

.template-unbranded .cover-page .cover-top {
  flex: 1;
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  text-align: center;
  padding: 2em 0;
}

.template-unbranded .cover-page .cover-label {
  font-family: var(--ub-sans);
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.32em;
  color: var(--ub-muted);
  margin-bottom: 2.2em;
}

.template-unbranded .cover-page .cover-title {
  font-family: var(--ub-serif);
  font-size: 3em;
  font-weight: 700;
  color: var(--ub-ink);
  line-height: 1.15;
  letter-spacing: -0.02em;
  margin: 0;
  max-width: 90%;
}

.template-unbranded .cover-page .cover-rule {
  width: 48px;
  height: 2px;
  background: var(--ub-rule);
  margin: 2em auto;
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}

.template-unbranded .cover-page .cover-meta {
  font-family: var(--ub-sans);
  font-size: 13px;
  font-weight: 400;
  color: var(--ub-soft);
  line-height: 2;
  letter-spacing: 0.02em;
}
.template-unbranded .cover-page .cover-meta .cover-author {
  font-weight: 500;
  color: var(--ub-ink);
}

.template-unbranded .cover-page .cover-bottom {
  font-family: var(--ub-sans);
  font-size: 10.5px;
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.28em;
  color: var(--ub-muted);
  text-align: center;
}

/* ── Print body rules ── */
@media print {
  .template-unbranded blockquote { page-break-inside: avoid; }
}
`;

export default {
    id: 'unbranded',

    renderCover(doc) {
        return `<div class="cover-page">
      <div class="cover-top">
        <div class="cover-label">Document</div>
        <div class="cover-title">${escapeHtml(doc.title)}</div>
        <div class="cover-rule"></div>
        <div class="cover-meta">
          ${doc.author ? `<div class="cover-author">${escapeHtml(doc.author)}</div>` : ''}
          <div>${escapeHtml(doc.date)}</div>
        </div>
      </div>
      <div class="cover-bottom">\u2756 \u2756 \u2756</div>
    </div>`;
    },

    transformHTML(html) {
        return html;
    },

    preflightChecks,
};
