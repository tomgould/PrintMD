#!/usr/bin/env node
/**
 * tests/run-all.mjs: run every automated test with one exit code.
 *
 *   1. node --test tests/test.js tests/runner.test.mjs tests/code-languages.test.mjs tests/server-tests.test.mjs
 *                  tests/page-options.test.mjs (page control: custom size, layout, fit, margin)
 *                  tests/template-*.test.mjs (the registry, the platform, one file per template)
 *                  tests/public-edition.test.mjs (when present)
 *                                       (pure-function unit tests, the page runner's timeouts, code blocks,
 *                                       the server test selection, the template manifests, the template
 *                                       platform (page sizes, running head and foot, fonts), the core/company line)
 *   2. every tests/*.test.html          (browser tests, headless Chrome over http)
 *   2b. tests/a11y-keys.mjs            (keyboard walkthrough with real key events, accessibility tree),
 *                                       one suite per group: a11y-keys-dialogs, -page, -sidebar, -palette
 *   3. tests/print-pdf.mjs             (long lines wrap in the printed PDF, all templates),
 *      only when pdftotext is on PATH; otherwise "print: skipped"
 *   4. tests/office-convert.mjs        (the Word and PowerPoint fixtures opened in LibreOffice),
 *      only when soffice, pdftotext and pdfinfo are on PATH; otherwise "office: skipped"
 *   5. node --test server/test/*.test.mjs   (the PDF API and the print-quality QA), only when
 *      server/ can load its dependencies (server/node_modules, or the CI image's /node_modules)
 *      and poppler-utils is on PATH; otherwise a "server: skipped" line says what is missing
 *
 * The CI image (deploy/ci/Dockerfile) has Chromium, poppler-utils and the server's
 * dependencies, so there only the office suite (LibreOffice) is skipped, and the server
 * suite runs its print-quality gate only (tests/lib/server-tests.mjs; SERVER_TESTS=all runs
 * every file, one at a time).
 *
 * Usage: node tests/run-all.mjs [filter...]
 *   With filter words, only suites whose name contains one of them run
 *   (e.g. `store`, `unit`, `index`, `server`). No filter runs everything.
 *   The `index` check fails when a tests/*.test.html page is not linked from tests/index.html.
 *
 * Needs Node 22 and `google-chrome` on PATH (override with CHROME_BIN).
 * No dependencies. Random ports and temporary profiles, so runs never collide.
 */
import {spawn, spawnSync} from 'node:child_process';
import {existsSync, readFileSync, readdirSync} from 'node:fs';
import {createRequire} from 'node:module';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {startStaticServer} from './lib/static-server.mjs';
import {runHeadless} from './run-headless.mjs';
import {officeToolsAvailable, runOfficeConvert} from './office-convert.mjs';
import {printToolsAvailable, runPrintPdf} from './print-pdf.mjs';
import {A11Y_KEY_GROUPS, closeA11yKeysBrowser, runA11yKeys} from './a11y-keys.mjs';
import {serverTestFiles} from './lib/server-tests.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const filters = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const wanted = (name) => filters.length === 0 || filters.some((f) => name.includes(f));
const pageTimeout = Number(process.env.TEST_PAGE_TIMEOUT_MS || 30000);

const results = [];

/** Whether the poppler tools the server suite reads PDFs with are on PATH. */
function popplerAvailable() {
    return ['pdfinfo', 'pdftotext', 'pdffonts', 'pdfimages']
        .every((tool) => spawnSync('sh', ['-c', `command -v ${tool}`], {stdio: 'ignore'}).status === 0);
}

function runUnit() {
    return new Promise((ok) => {
        // One file at a time: on a CPU-limited CI container, files running side by side
        // slow each other's timing checks (the linear-time headingPlainText test).
        const child = spawn(process.execPath, ['--test', '--test-concurrency=1', '--test-reporter=spec',
            'tests/test.js', 'tests/runner.test.mjs', 'tests/code-languages.test.mjs', 'tests/server-tests.test.mjs',
            'tests/markdown-inline.test.mjs', 'tests/markdown-deflist.test.mjs', 'tests/markdown-footnotes.test.mjs',
            // The edition switches: the hosted-copy notice and the PDF API's local-only mode.
            'tests/edition.test.mjs', 'tests/edition-server.test.mjs',
            // Page control: custom sizes, layout, fit and the margin override as plain data.
            'tests/page-options.test.mjs',
            // The registry, the platform, and one file per template (tests/template-{id}.test.mjs).
            ...readdirSync(resolve(root, 'tests')).filter((f) => /^template-[a-z0-9-]+\.test\.mjs$/.test(f)).sort().map((f) => `tests/${f}`),
            // The core/company line (docs/PUBLIC-EDITION.md): company layer, so a public build has no copy.
            ...(existsSync(resolve(root, 'tests/public-edition.test.mjs')) ? ['tests/public-edition.test.mjs'] : []),
            ...(existsSync(resolve(root, 'tests/make-public.test.mjs')) ? ['tests/make-public.test.mjs'] : [])], {
            cwd: root, stdio: 'inherit',
        });
        child.once('error', () => ok(false));
        child.once('exit', (code) => ok(code === 0));
    });
}

if (wanted('unit')) {
    console.log('\n── unit: node --test tests/test.js ──');
    results.push({name: 'unit', ok: await runUnit()});
}

const allPages = readdirSync(resolve(root, 'tests'))
    .filter((f) => f.endsWith('.test.html'))
    .sort();

// Every test page must be linked from tests/index.html, so the index cannot drift.
if (wanted('index')) {
    const indexHtml = readFileSync(resolve(root, 'tests/index.html'), 'utf8');
    const linked = new Set([...indexHtml.matchAll(/href=["']([^"'#?]+)/g)].map((m) => m[1].replace(/^\.\//, '')));
    const missing = allPages.filter((p) => !linked.has(p));
    const ok = missing.length === 0;
    console.log(`\n── index: tests/index.html links ──`);
    console.log(ok ? `PASS  index: all ${allPages.length} pages linked`
        : `FAIL  index: ${missing.length} of ${allPages.length} pages not linked from tests/index.html`);
    for (const p of missing) console.log(`      ✗ ${p}`);
    results.push({name: 'index', ok});
}

const pages = allPages.filter(wanted);

if (pages.length) {
    const server = await startStaticServer(root);
    try {
        for (const page of pages) {
            const started = Date.now();
            // TEST_SCALE=1 asks pages for their full-size runs (office-scale.test.html: 200,000 blocks).
            const query = process.env.TEST_SCALE === '1' ? '?scale=full' : '';
            const r = await runHeadless(`${server.origin}/tests/${page}${query}`, {timeoutMs: pageTimeout});
            const secs = ((Date.now() - started) / 1000).toFixed(1);
            const note = r.timedOut ? 'timed out' : (r.summary || r.result || r.title);
            console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${page}  (${secs}s)  ${note}`);
            if (!r.ok) {
                for (const f of r.failures) console.log(`      ✗ ${f}`);
                if (r.detail) console.log(`      detail: ${r.detail.slice(0, 600)}`);
            }
            results.push({name: page, ok: r.ok});
        }
    } finally {
        await server.close();
    }
}

// The keyboard-only walkthrough with real key events and the accessibility tree
// (DevTools), one suite per group, each in its own browser context and timed alone.
// The groups share one Chrome (the first one started pays for its start-up).
try {
    for (const group of A11Y_KEY_GROUPS) {
        const name = `a11y-keys-${group}`;
        if (!wanted(name)) continue;
        console.log(`\n── ${name}: keyboard walkthrough and accessibility tree (tests/a11y-keys.mjs ${group}) ──`);
        const started = Date.now();
        let ok = false;
        try {
            ok = await runA11yKeys({groups: [group], keepBrowser: true, log: (line) => console.log(`  ${line}`)});
        } catch (e) {
            console.log(`  ${(e && e.message) || e}`);
        }
        console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  (${((Date.now() - started) / 1000).toFixed(1)}s)`);
        results.push({name, ok});
    }
} finally {
    await closeA11yKeysBrowser();
}

// The PDF export's document printed for every template: long lines must wrap. Needs pdftotext.
if (wanted('print')) {
    console.log('\n── print: long lines wrap in the printed PDF (tests/print-pdf.mjs) ──');
    if (!printToolsAvailable()) {
        console.log('print: skipped (needs pdftotext on PATH)');
        results.push({name: 'print (skipped)', ok: true});
    } else {
        const ok = await runPrintPdf({log: (line) => console.log(`  ${line}`)});
        console.log(`${ok ? 'PASS' : 'FAIL'}  print`);
        results.push({name: 'print', ok});
    }
}

// The Word and PowerPoint fixtures opened in LibreOffice: only where LibreOffice and poppler are installed.
if (wanted('office')) {
    console.log('\n── office: LibreOffice opens the Word and PowerPoint fixtures (tests/office-convert.mjs) ──');
    if (!officeToolsAvailable()) {
        console.log('office: skipped (needs soffice, pdftotext and pdfinfo on PATH)');
        results.push({name: 'office (skipped)', ok: true});
    } else {
        const ok = await runOfficeConvert({log: (line) => console.log(`  ${line}`)});
        console.log(`${ok ? 'PASS' : 'FAIL'}  office`);
        results.push({name: 'office', ok});
    }
}

/**
 * Whether server/ can load its dependencies: server/node_modules, or any
 * node_modules Node finds above it (the CI image installs them at /node_modules).
 */
function serverDepsInstalled() {
    if (existsSync(resolve(root, 'server/node_modules'))) return true;
    try {
        createRequire(resolve(root, 'server/package.json')).resolve('playwright');
        return true;
    } catch {
        return false;
    }
}

// The PDF API has its own dependencies (server/package.json); its tests run only once they are installed.
// Its integration tests read PDFs with poppler-utils (the same tools the print suite needs).
if (wanted('server')) {
    console.log('\n── server: node --test server/test/*.test.mjs ──');
    if (!serverDepsInstalled()) {
        console.log('server: skipped (run npm ci in server/)');
        results.push({name: 'server (skipped)', ok: true});
    } else if (!popplerAvailable()) {
        console.log('server: skipped (needs pdfinfo, pdftotext, pdffonts and pdfimages on PATH: poppler-utils)');
        results.push({name: 'server (skipped)', ok: true});
    } else {
        const all = readdirSync(resolve(root, 'server/test')).filter((f) => f.endsWith('.test.mjs')).sort();
        // On CI only the print-quality gate runs (tests/lib/server-tests.mjs says why).
        const {files: chosen, pick} = serverTestFiles(all);
        if (chosen.length < all.length) {
            console.log(`server: running ${chosen.join(', ')} (SERVER_TESTS=${pick}); ${all.length - chosen.length} more files `
                + 'run with SERVER_TESTS=all or outside CI');
        }
        const files = chosen.map((f) => `test/${f}`);
        // Each test file starts its own API and Chromium. On CI (a CPU-limited container) they
        // run one at a time, so they do not starve each other into render timeouts.
        const concurrency = process.env.SERVER_TEST_CONCURRENCY || (process.env.CI ? '1' : '');
        const ok = files.length > 0 && await new Promise((done) => {
            const child = spawn(process.execPath, ['--test', '--test-reporter=spec',
                ...(concurrency ? [`--test-concurrency=${concurrency}`] : []), ...files], {
                cwd: resolve(root, 'server'), stdio: 'inherit',
            });
            child.once('error', () => done(false));
            child.once('exit', (code) => done(code === 0));
        });
        const name = chosen.length < all.length ? `server (${chosen.length} of ${all.length} files)` : 'server';
        console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
        results.push({name, ok});
    }
}

if (results.length === 0) {
    console.error(`No suites matched: ${filters.join(' ')}`);
    process.exit(2);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} suites passed`);
if (failed.length) {
    console.log(`Failed: ${failed.map((r) => r.name).join(', ')}`);
    process.exit(1);
}
