/**
 * Print fonts: the API's PDF uses only the vendored fonts (js/fonts.js), so it
 * looks the same whatever machine renders it. No system fallback such as
 * DejaVu or Liberation, and no Type 3 (bitmap-like) fonts. Symbols the brand
 * fonts lack (box drawing, arrows, check marks, dingbats such as the unbranded
 * cover's ❖) come from the vendored symbol faces.
 */
import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {FONT_FACES} from '../../js/fonts.js';
import {startTestApi, render, pdfFontTable, TEMPLATE_IDS} from './helpers.mjs';

const SHOWCASE = readFileSync(new URL('../../tests/fixtures/code-showcase.md', import.meta.url), 'utf8');
const SYMBOLS = '┌──┬──┐ ╔══╗ ← ↑ → ↓ ↔ ⇒ ✓ ✔ ✗ ✘ ☐ ☑ ❖ ★ ⚙ ✏ ⚠ ☺ ♪ █ ▓ ░ • ≠ ≤ ≥ ± × ÷ … \u{2014} € © ™';   // \u{2014}: the em-dash, escaped so the source has none
/** Emoji: printed from the system's colour emoji font, as Type 3 (README, Known limitations). */
const EMOJI = '😀 🚀 ✅ ❌';
/**
 * The symbols in a heading (the cover title too), in prose (regular, bold, italic, bold italic), in inline
 * code and in a code block. A synthesised bold (a weight the fonts do not have) would print as Type 3.
 */
const SYMBOLS_DOC = `# Symbols ${SYMBOLS}\n\n${SYMBOLS}\n\n**${SYMBOLS}**\n\n*${SYMBOLS}*\n\n***Bold italic ${SYMBOLS}***\n\n`
    + `\`${SYMBOLS}\`\n\n\`\`\`text\n${SYMBOLS}\n│ab│cd│ ║  ║\n\`\`\`\n`;
/** PDF font names start with the family name without spaces ("SourceCodePro-It", "MontserratThin-Bold"). */
const OURS = [...new Set(FONT_FACES.map((f) => f.family.replace(/\s+/g, '')))];

let api;

before(async () => {
    api = await startTestApi();
});

after(async () => {
    await api.close();
});

function assertOurFonts(fonts, what) {
    assert.ok(fonts.length > 0, `${what}: fonts listed`);
    for (const f of fonts) {
        assert.ok(OURS.some((family) => f.name.startsWith(family)), `${what}: ${f.name} is not a vendored font (${OURS.join(', ')})`);
        assert.notEqual(f.type, 'Type 3', `${what}: ${f.name} is a Type 3 font`);
        assert.ok(f.embedded, `${what}: ${f.name} is embedded`);
    }
}

for (const template of TEMPLATE_IDS) {
    test(`code showcase with ${template}: every font in the PDF, cover included, is vendored, embedded and not Type 3`, async () => {
        const r = await render(api.url, SHOWCASE, `template=${template}`);
        assert.equal(r.status, 200);
        const fonts = pdfFontTable(r.body);
        assertOurFonts(fonts, template);
        assert.ok(fonts.some((f) => f.name.startsWith('SourceCodePro')), 'code printed in Source Code Pro');
    });

    test(`symbols in ${template} headings, prose and code print in vendored fonts`, async () => {
        const r = await render(api.url, SYMBOLS_DOC, `template=${template}`);
        assert.equal(r.status, 200);
        const fonts = pdfFontTable(r.body);
        assertOurFonts(fonts, `${template} symbols`);
        assert.ok(fonts.some((f) => f.name.startsWith('NotoSansSymbols2')), 'dingbats from Noto Sans Symbols 2');
        assert.ok(fonts.some((f) => f.name.startsWith('SourceCodePro')), 'box drawing and arrows from Source Code Pro');
        assert.ok(fonts.some((f) => f.name === 'NotoSansSymbols-Regular'), '⚙ ☺ ♪ from Noto Sans Symbols');
    });

    test(`emoji in ${template}: the only exception, a Type 3 font; every named font is still ours`, async () => {
        const r = await render(api.url, `# Emoji\n\n${SYMBOLS} ${EMOJI}\n\n\`\`\`text\n${SYMBOLS} ${EMOJI}\n\`\`\`\n`, `template=${template}`);
        assert.equal(r.status, 200);
        const fonts = pdfFontTable(r.body);
        assertOurFonts(fonts.filter((f) => f.type !== 'Type 3'), `${template} emoji`);
        // The Type 3 entries are the emoji: the same text without them has none (the symbols test above).
        for (const f of fonts.filter((x) => x.type === 'Type 3')) assert.equal(f.name, '[none]', `${template}: an emoji glyph set, not a named font`);
    });
}
