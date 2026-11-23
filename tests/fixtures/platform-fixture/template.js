/**
 * A test-only template: never listed in a manifest the app or the API reads.
 * It uses every part of the template platform (README, Template contract):
 * a running head and foot with every token and a logo in the foot, the subject
 * on the cover, the Slide page size (manifest.page.sizes), a dark page canvas
 * (pageBackground), Inter's true italics, and a face of each font family added
 * for the new templates. Shadows have no blur, so the PDF holds no raster image.
 *
 * Tests register it through a layer manifest at
 * templates/__fixtures__/platform-fixture/template.js: the browser tests' static
 * server maps that path here (tests/lib/static-server.mjs), and
 * server/test/template-platform.test.mjs copies it there in a copy of the repo.
 * The relative imports resolve to the real templates/ and js/ from both places,
 * which are the same depth below the root.
 */

import {baseStyles, escapeHtml, preflightChecks} from '../../../templates/_shared/base.js';
import {SYMBOL_FALLBACK_FAMILIES} from '../../../js/fonts.js';

const ID = 'platform-fixture';
const LOGO_URL = new URL('./logo.svg', import.meta.url).href;
const SYM = SYMBOL_FALLBACK_FAMILIES;

export const manifest = {
    id: ID,
    name: 'Platform fixture',
    description: 'Test-only template that uses every part of the template platform',
    author: 'Example Co',
    version: '1.0.0',
    accent: '#2f5bd2',
    fontStack: `Figtree, ${SYM}, sans-serif`,
    page: {margin: '20mm', sizes: ['A4', 'Letter', 'Slide']},
};

const s = `.template-${ID}`;
export const styles = baseStyles(ID, {codeTheme: 'dark'}) + `
${s} {
  --pf-font: Figtree, ${SYM}, sans-serif;
  --pf-mono: 'Source Code Pro', 'Noto Sans Symbols 2', 'Noto Sans Symbols', monospace;
  font-family: var(--pf-font);
  color: #e6dfd7;
  font-size: 15px;
  line-height: 1.6;
}
${s} h1 { font-family: Fraunces, ${SYM}, serif; font-weight: 600; font-size: 2em; color: #f4efe9; }
${s} h2 { font-family: 'Schibsted Grotesk', ${SYM}, sans-serif; font-weight: 700; font-size: 1.4em; }
${s} h3 { font-family: 'Plus Jakarta Sans', ${SYM}, sans-serif; font-weight: 800; font-size: 1.15em; }
${s} h4 { font-family: 'IBM Plex Sans', ${SYM}, sans-serif; font-weight: 600; }
${s} h5 { font-family: 'DM Sans', ${SYM}, sans-serif; font-weight: 700; }
${s} h6 { font-family: Inter, ${SYM}, sans-serif; font-weight: 700; font-style: italic; }
${s} blockquote { font-family: Lora, ${SYM}, serif; font-style: italic; margin: 1em 0; padding: 0.6em 1em;
  border-left: 3px solid #3ecf9a; background: rgba(255, 255, 255, 0.06); box-shadow: 0 2px 0 rgba(0, 0, 0, 0.35); }
${s} table { font-family: 'Libre Caslon Text', ${SYM}, serif; }
${s} th { background: rgba(255, 255, 255, 0.08); }
${s} td, ${s} th { border-bottom: 1px solid rgba(255, 255, 255, 0.14); }
${s} code { font-family: var(--pf-mono); background: rgba(255, 255, 255, 0.1); }
${s} pre { background: #12100e; color: #e6e6e6; border-radius: 6px; }
${s} pre code { background: none; }
${s} a { color: #7cc4fa; }
${s} .cover-page {
  background: #13294b;
  color: #ffffff;
  padding: 16mm 20mm;
  justify-content: center;
  gap: 4mm;
}
${s} .pf-logo { height: 9mm; width: auto; align-self: flex-start; }
${s} .pf-title { font-family: Fraunces, ${SYM}, serif; font-weight: 700; font-size: 30px; line-height: 1.15; margin: 0; color: #ffffff; }
${s} .pf-subject { font-family: 'Schibsted Grotesk', ${SYM}, sans-serif; font-style: italic; font-weight: 500; font-size: 16px; margin: 0; color: #d9e2ec; }
${s} .pf-meta { font-family: 'DM Sans', ${SYM}, sans-serif; font-size: 12px; margin: 0; color: #d9e2ec; }
`;

export default {
    id: ID,
    renderCover(doc) {
        return `<div class="cover-page">
  <img class="pf-logo" src="${LOGO_URL}" alt="Example Co">
  <h1 class="pf-title">${escapeHtml(doc.title)}</h1>${doc.subject ? `
  <p class="pf-subject">${escapeHtml(doc.subject)}</p>` : ''}
  <p class="pf-meta">${doc.author ? `${escapeHtml(doc.author)}, ` : ''}${escapeHtml(doc.date)}</p>
</div>`;
    },
    transformHTML: (html) => html,
    preflightChecks,
    pageBackground: '#1d1815',
    runningHead: {left: '{author}', centre: '{subject}', right: '{title}'},
    runningFoot: {left: '{date}', right: 'Page {page} of {pages}'},
    runningStyle: {fontFamily: 'DM Sans', fontSize: 8, fontWeight: 500, color: '#cdc2b6'},
    runningLogo: {src: LOGO_URL, slot: 'foot-centre', height: 5},
};
