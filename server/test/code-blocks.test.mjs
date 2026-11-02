/**
 * Code blocks in the API's PDF: the language label is printed (pdftotext),
 * only on labelled blocks, a long line wraps whole, and the syntax colours
 * for the template's code background reach the page (pdftoppm raster).
 */
import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CODE_PALETTES} from '../../templates/_shared/base.js';
import {startTestApi, render, pdfText, TEMPLATE_IDS, codeThemeOf} from './helpers.mjs';

const FIXTURE = readFileSync(new URL('./fixtures/code-blocks.md', import.meta.url), 'utf8');
const LABELS = ['PHP', 'JSONC', 'BASH', 'TERRAFORM', 'TEXT', 'JAVASCRIPT'];
const THEME = Object.fromEntries(TEMPLATE_IDS.map((id) => [id, codeThemeOf(id)]));
const LONG_LINE = FIXTURE.match(/^const url = .*$/m)[0];
const squash = (s) => s.replace(/\s+/g, '');

let api;

before(async () => {
    api = await startTestApi();
});

after(async () => {
    await api.close();
});

/** Page `page` of a PDF as RGB pixels at 100 dpi (pdftoppm, binary PPM). */
function rasterise(pdf, page) {
    const dir = mkdtempSync(join(tmpdir(), 'bd-code-'));
    try {
        writeFileSync(join(dir, 'in.pdf'), pdf);
        execFileSync('pdftoppm', ['-r', '100', '-f', String(page), '-l', String(page), '-singlefile', join(dir, 'in.pdf'), join(dir, 'out')]);
        const ppm = readFileSync(join(dir, 'out.ppm'));
        // Header: "P6\n<width> <height>\n255\n", then RGB bytes.
        const header = ppm.toString('latin1', 0, 64).match(/^P6\s+(\d+)\s+(\d+)\s+255\s/);
        return {width: Number(header[1]), height: Number(header[2]), data: ppm.subarray(header[0].length)};
    } finally {
        rmSync(dir, {recursive: true, force: true});
    }
}

/** How many pixels are within `tolerance` of a colour on every channel. */
function pixelsNear({data}, hex, tolerance = 14) {
    const [r, g, b] = hex.slice(1).match(/../g).map((x) => parseInt(x, 16));
    let n = 0;
    for (let i = 0; i + 2 < data.length; i += 3) {
        if (Math.abs(data[i] - r) <= tolerance && Math.abs(data[i + 1] - g) <= tolerance && Math.abs(data[i + 2] - b) <= tolerance) n++;
    }
    return n;
}

for (const template of Object.keys(THEME)) {
    test(`code blocks with ${template}: labels printed on labelled blocks only, long line whole, syntax colours`, async () => {
        const r = await render(api.url, FIXTURE, `template=${template}`);
        assert.equal(r.status, 200);
        const text = pdfText(r.body, ['-f', '2']);   // the body, without the cover's capitals
        const lines = text.split('\n').map((l) => l.trim());
        for (const label of LABELS) {
            assert.equal(lines.filter((l) => l === label).length, 1, `one "${label}" label line`);
        }
        assert.equal(lines.filter((l) => /^[A-Z]{2,}$/.test(l)).length, LABELS.length, 'the unlabelled block has no label');
        assert.ok(text.includes('an unlabelled block'), 'unlabelled block printed');
        assert.ok(squash(text).includes(squash(LONG_LINE)), 'the long line is in the PDF whole (wrapped, not cut off)');

        // Page 2 holds the PHP, JSONC, Bash and Terraform blocks (page 1 is the cover).
        const page = rasterise(r.body, 2);
        const palette = CODE_PALETTES[THEME[template]];
        for (const token of ['keyword', 'string', 'comment']) {
            const n = pixelsNear(page, palette[token]);
            assert.ok(n > 40, `${token} colour ${palette[token]} on page 2: ${n} pixels`);
        }
    });
}
