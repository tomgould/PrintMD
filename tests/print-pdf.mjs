#!/usr/bin/env node
/**
 * tests/print-pdf.mjs: print the PDF export's document for every template and
 * check that long lines wrap instead of being cut off at the page edge.
 *
 * tests/lib/print-fixture.html builds the print document (js/print-document.js,
 * the same HTML the editor's PDF export and the PDF API print) for a fixture
 * with a 300-character code line, a long inline code token, a long URL, a long
 * hash in a paragraph and one in a table cell. This script prints it with headless Chrome (DevTools
 * Page.printToPDF) and checks with pdftotext that each line is in the PDF whole:
 * text cut off at the right edge is missing from the PDF.
 *
 * Usage: node tests/print-pdf.mjs [--keep <dir>]
 *   --keep <dir>  also write each template's PDF there
 * Needs Chrome (as tests/run-all.mjs) and pdftotext on PATH; tests/run-all.mjs
 * runs it as the `print` suite when pdftotext is installed.
 * Exit code 0 when every check passes.
 */
import {spawnSync} from 'node:child_process';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {startStaticServer} from './lib/static-server.mjs';
import {withPage} from './run-headless.mjs';
import {getTemplates} from '../js/templates.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** Every template in the registry (templates/manifest.*.json). */
export const PRINT_TEMPLATES = getTemplates().map((t) => t.manifest.id);

/** Whether pdftotext is on PATH. */
export function printToolsAvailable() {
    return spawnSync('sh', ['-c', 'command -v pdftotext'], {stdio: 'ignore'}).status === 0;
}

/** Text with all whitespace removed, so a line that wraps still matches. */
const compact = (s) => String(s).replace(/\s+/g, '');

async function printTemplate(origin, id) {
    return withPage(`${origin}/tests/lib/print-fixture.html?template=${id}`, async (page) => {
        await page.waitFor('!!window.__print');
        const lines = await page.evalExpr('window.__print.lines');
        // Write the print document over this page (same origin, so its fonts and logo load), then print it.
        await page.evalExpr('(() => { const h = window.__print.html; document.open(); document.write(h); document.close(); return true; })()');
        await page.waitFor("document.readyState === 'complete' && document.fonts.status === 'loaded'");
        const words = await page.evalExpr('window.__print.words');
        // Column widths of the last table in print, then with cells that never break inside a word
        // (overflow-wrap: normal, how a table without long tokens lays out): they must match.
        await page.send('Emulation.setEmulatedMedia', {media: 'print'});
        const widths = (extraCss) => page.evalExpr(`(() => {
            const style = document.createElement('style');
            style.textContent = ${JSON.stringify(extraCss)};
            document.head.appendChild(style);
            const tables = document.querySelectorAll('table');
            const cells = Array.from(tables[tables.length - 1].rows[0].cells, (c) => c.getBoundingClientRect().width);
            style.remove();
            return cells;
        })()`);
        const columns = {actual: await widths(''), reference: await widths('td, th { overflow-wrap: normal !important; }')};
        await page.send('Emulation.setEmulatedMedia', {media: ''});
        const {data} = await page.send('Page.printToPDF', {printBackground: true, preferCSSPageSize: true});
        return {lines, words, columns, pdf: Buffer.from(data, 'base64')};
    });
}

/**
 * One continuous page, as the editor's print window makes it (js/pdf-export.js): the print document
 * written into the page, then js/page-layout.js with the print rules switched on while it measures,
 * then printed with the page size it wrote.
 */
async function printContinuous(origin, id, wide) {
    return withPage(`${origin}/tests/lib/print-fixture.html?template=${id}&layout=continuous&wide=${wide ? 1 : 0}`, async (page) => {
        await page.waitFor('!!window.__print');
        const pageOpts = await page.evalExpr('window.__print.pageOpts');
        // A print window is a browser window, wider than an A4 page.
        await page.send('Emulation.setDeviceMetricsOverride', {width: 1400, height: 900, deviceScaleFactor: 1, mobile: false});
        await page.evalExpr('(() => { const h = window.__print.html; document.open(); document.write(h); document.close(); return true; })()');
        await page.waitFor("document.readyState === 'complete' && document.fonts.status === 'loaded'");
        const laid = await page.send('Runtime.evaluate', {returnByValue: true, awaitPromise: true, expression: `import('/js/page-layout.js').then((m) => {
            const flipped = m.simulatePrintMedia(document);
            try { return m.applyPageLayout({...m.pageLayoutInput(${JSON.stringify(pageOpts)}), doc: document}).pages; }
            finally { m.restoreMedia(flipped); }
        })`});
        if (!laid.result || laid.result.value !== 1) throw new Error(`${id}: the layout step did not run (${JSON.stringify(laid.result || laid)})`);
        const {data} = await page.send('Page.printToPDF', {printBackground: true, preferCSSPageSize: true});
        return Buffer.from(data, 'base64');
    });
}

/**
 * @param {{keep?: string|null, log?: (line: string) => void}} [opts]
 * @returns {Promise<boolean>}  true when every check passes
 */
export async function runPrintPdf({keep = null, log = console.log} = {}) {
    const work = mkdtempSync(join(tmpdir(), 'bd-print-'));
    const server = await startStaticServer(root);
    let ok = true;
    try {
        for (const id of PRINT_TEMPLATES) {
            const {lines, words, columns, pdf} = await printTemplate(server.origin, id);
            const file = join(work, `${id}.pdf`);
            writeFileSync(file, pdf);
            // -raw: text in content order, with no dehyphenation (the default drops a hyphen that ends a
            // line, so a code line that wraps after "example-" would read "exampleco" and look cut).
            const r = spawnSync('pdftotext', ['-raw', file, '-'], {encoding: 'utf8'});
            if (r.status !== 0) throw new Error(`pdftotext failed for ${id}: ${r.stderr}`);
            const check = (pass, label) => {
                if (!pass) ok = false;
                log(`${pass ? 'PASS' : 'FAIL'}  ${id}: ${label}`);
            };
            const text = compact(r.stdout);
            for (const [name, line] of Object.entries(lines)) {
                const pass = text.includes(compact(line));
                const tail = compact(line).slice(-24);
                check(pass, `the whole ${name} line is in the PDF${pass ? '' : ` (missing its end "${tail}")`}`);
            }
            // Case-insensitive: some templates set header cells in capitals (text-transform).
            const broken = words.filter((w) => !new RegExp(`(^|\\s)${w}(\\s|$)`, 'i').test(r.stdout));
            check(broken.length === 0, `table words print unbroken${broken.length ? ` (broken: ${broken.join(', ')})` : ''}`);
            const off = columns.actual.map((w, i) => Math.abs(w - columns.reference[i]) / columns.reference[i]);
            const fmt = (a) => a.map((w) => Math.round(w)).join('/');
            check(off.every((d) => d <= 0.03),
                `table columns keep their widths (${fmt(columns.actual)} px, reference ${fmt(columns.reference)} px)`);
            if (keep) {
                mkdirSync(resolve(keep), {recursive: true});
                writeFileSync(join(resolve(keep), `${id}.pdf`), pdf);
            }
            // One continuous page as the editor prints it, with and without a block wider than the page: a single
            // page that ends with its margin.
            for (const wide of [false, true]) {
                const name = `${id}-continuous${wide ? '-wide' : ''}`;
                const long = await printContinuous(server.origin, id, wide);
                const longFile = join(work, `${name}.pdf`);
                writeFileSync(longFile, long);
                const box = spawnSync('pdftotext', ['-bbox', longFile, '-'], {encoding: 'utf8'});
                if (box.status !== 0) throw new Error(`pdftotext -bbox failed for ${id}: ${box.stderr}`);
                const pageCount = (box.stdout.match(/<page /g) || []).length;
                const height = Number((/<page width="[\d.]+" height="([\d.]+)"/.exec(box.stdout) || [])[1]);
                const bottom = Math.max(...[...box.stdout.matchAll(/yMax="([\d.]+)"/g)].map((m) => Number(m[1])));
                const blankMm = Math.round((height - bottom) / (72 / 25.4));
                check(pageCount === 1 && box.stdout.includes('END-OF-DOCUMENT') && blankMm <= 60,
                    `one continuous page from the print window${wide ? ' with a wide block' : ''}, ${blankMm} mm below the last line `
                    + `(${pageCount} page${pageCount === 1 ? '' : 's'})`);
                if (keep) writeFileSync(join(resolve(keep), `${name}.pdf`), long);
            }
        }
        return ok;
    } catch (e) {
        log(`FAIL  ${e.message}`);
        return false;
    } finally {
        await server.close();
        rmSync(work, {recursive: true, force: true});
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    if (!printToolsAvailable()) {
        console.error('print-pdf: needs pdftotext on PATH');
        process.exit(2);
    }
    const k = process.argv.indexOf('--keep');
    process.exit(await runPrintPdf({keep: k > -1 ? process.argv[k + 1] : null}) ? 0 : 1);
}
