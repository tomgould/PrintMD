#!/usr/bin/env node
/**
 * tests/office-convert.mjs: open the Word and PowerPoint fixtures in LibreOffice.
 *
 * tests/docx-export.test.html and tests/pptx-export.test.html build a fixture
 * document with the real exporters and expose it as window.__officeFiles. This
 * script collects both, converts each to PDF with `soffice --headless`, and
 * checks the result with poppler: the Word numbering restarts, links, table
 * cells and container text are in the PDF's text, and the deck has one PDF page
 * per slide with every element's text on it. When python3 has lxml, python-pptx
 * or python-docx, those stricter parsers must also read both files (each check
 * is skipped, with a SKIP line, when its module is missing).
 *
 * Usage: node tests/office-convert.mjs [--keep <dir>]
 *   --keep <dir>  also write the fixtures, PDFs and one PNG per page there, to look at
 * Needs soffice (LibreOffice), pdftotext, pdfinfo and pdftoppm (--keep only) on PATH;
 * tests/run-all.mjs runs it as the `office` suite when soffice is installed.
 * Exit code 0 when every check passes.
 */
import {spawn, spawnSync} from 'node:child_process';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {startStaticServer} from './lib/static-server.mjs';
import {evaluateInPage} from './run-headless.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Whether every command is on PATH. */
export function officeToolsAvailable(cmds = ['soffice', 'pdftotext', 'pdfinfo']) {
    return cmds.every((c) => spawnSync('sh', ['-c', `command -v ${c}`], {stdio: 'ignore'}).status === 0);
}

/**
 * Run LibreOffice with a throwaway profile, in its own process group.
 *
 * `soffice` is a wrapper: it starts oosplash, which starts soffice.bin to do
 * the work. Killing only the wrapper would leave those running, so the whole
 * group is killed (SIGKILL) on timeout, and again after a normal exit to sweep
 * any helper that outlived the wrapper, as tests/lib/chrome.mjs does for Chrome.
 * The profile folder (-env:UserInstallation) is created for this run and deleted
 * afterwards, so a desktop LibreOffice never blocks the conversion and nothing is
 * left in the temp folder.
 * @param {string[]} args  soffice arguments, without -env:UserInstallation
 * @param {{bin?: string, timeoutMs?: number}} [opts]
 * @returns {Promise<{code: number|null, timedOut: boolean, stdout: string, stderr: string, pgid: number, error?: Error}>}
 */
export function runSoffice(args, {bin = 'soffice', timeoutMs = 180000} = {}) {
    const profile = mkdtempSync(join(tmpdir(), 'bd-lo-profile-'));
    return new Promise((resolve) => {
        const child = spawn(bin, [`-env:UserInstallation=${pathToFileURL(profile).href}`, ...args], {
            detached: true, stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d) => { stdout += d; });
        child.stderr.on('data', (d) => { stderr += d; });
        const killGroup = () => {
            try { process.kill(-child.pid, 'SIGKILL'); } catch (_e) { /* group already gone */ }
        };
        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            killGroup();
        }, timeoutMs);
        let done = false;
        // 'exit', not 'close': a helper left holding the pipes must not keep us waiting.
        const finish = (code, error) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            killGroup();
            child.stdout.destroy();
            child.stderr.destroy();
            rmSync(profile, {recursive: true, force: true, maxRetries: 10, retryDelay: 100});
            resolve({code, timedOut, stdout, stderr, pgid: child.pid, ...(error ? {error} : {})});
        };
        child.once('error', (e) => finish(null, e));
        child.once('exit', (code) => finish(code));
    });
}

/** Convert one file to PDF in `outDir` with runSoffice; throws on failure or timeout. */
async function convertToPdf(file, outDir) {
    const r = await runSoffice(['--headless', '--convert-to', 'pdf', '--outdir', outDir, file]);
    if (r.error) throw new Error(`soffice could not start: ${r.error.message}`);
    if (r.timedOut) throw new Error(`soffice timed out converting ${file}`);
    if (r.code !== 0) throw new Error(`soffice failed converting ${file}: ${r.stderr.trim() || r.code}`);
}

function run(cmd, args, opts = {}) {
    const r = spawnSync(cmd, args, {encoding: 'utf8', timeout: 180000, ...opts});
    if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed: ${r.stderr || r.error || r.status}`);
    return r.stdout;
}

const DOCX_CHECKS = [
    ['cover title', /Fixture Report/],
    ['cover author', /Prepared by Jo Bloggs/],
    ['first list numbered 1, 2', /1\.\s+Alpha one\s+2\.\s+Alpha two/],
    ['second list restarts at 1', /1\.\s+Beta one\s+2\.\s+Beta two/],
    ['start="5" list starts at 5', /5\.\s+Gamma five\s+6\.\s+Gamma six/],
    ['nested list numbered inside the bullet', /Outer bullet\s+1\.\s+Inner one\s+2\.\s+Inner two\s+•\s+Outer second/],
    ['task checkboxes', /☐\s*Todo item\s+☑\s*Done item/],
    ['link texts', /See the site and the heading and a script\./],
    ['br is a line break', /Line one\s*\n\s*Line two/],
    ['control characters gone, text kept', /Badchar andvertical tab\./],
    ['colspan header cell', /Both columns/],
    ['table cells', /Cell A\s+Cell B/],
    ['rowspan cell and its rows', /Tall cell\s+Row one\s+Row two/],
    ['nested table cell', /Outer cell\s+Inner cell/],
    ['text inside div and span', /Loose div text span text\s+Para in div\s+tail text/],
    ['details and summary', /Summary text\s+Details body text/],
    ['code block keeps its indent', /const answer = 42;\s*\n\s+indented\(\);/],
    ['no front matter in the body', (t) => !/author:|title:/.test(t)],
];

const PPTX_CHECKS = [
    ['cover', /Deck Fixture\s+Prepared by Sam Presenter\s+1 March 2026/],
    ['two paragraphs stay apart', /First paragraph of the slide\.\s*\n\s*Second paragraph/],
    ['&amp;lt; shows as &lt;', /with &lt; shown literally and bold text\./],
    ['code block lines', /const answer = 42;\s*\n\s*console\.log\(answer\);/],
    ['table cells', /Name[\s\S]*Value[\s\S]*Alpha[\s\S]*1[\s\S]*Beta[\s\S]*2/],
    ['continuation slide', /Long section \(cont\.\)/],
    ['numbering counts on across the continuation', /Long section \(cont\.\)\s+19\.\s+Long line 19/],
    ['first and last long lines', (t) => t.includes('Long line 1\n') && t.includes('Long line 30')],
    ['nested list', /Outer item[\s\S]*Inner item[\s\S]*First numbered[\s\S]*Second numbered/],
    ['no front matter on slides', (t) => !/author:|title:/.test(t)],
];

// Strict parsers: lxml reads every XML part, python-pptx and python-docx open the files.
// Prints one line per check: "OK <label>", "BAD <label>: <reason>" or "SKIP <label>: <reason>".
const PY_CHECK = `
import sys, zipfile
docx_path, pptx_path = sys.argv[1], sys.argv[2]
try:
    from lxml import etree
except Exception as e:
    print('SKIP lxml parses every XML part: lxml not importable (%s)' % e)
    etree = None
if etree is not None:
    for path in (docx_path, pptx_path):
        bad = []
        with zipfile.ZipFile(path) as z:
            for name in z.namelist():
                if name.endswith('.xml') or name.endswith('.rels'):
                    try:
                        etree.fromstring(z.read(name))
                    except Exception as e:
                        bad.append('%s: %s' % (name, e))
        label = 'lxml parses every XML part of %s' % path.rsplit('/', 1)[-1]
        print(('BAD %s: %s' % (label, '; '.join(bad[:3]))) if bad else 'OK ' + label)
for mod, cls, path in (('pptx', 'Presentation', pptx_path), ('docx', 'Document', docx_path)):
    label = 'python-%s opens %s' % (mod, path.rsplit('/', 1)[-1])
    try:
        m = __import__(mod)
    except Exception as e:
        print('SKIP %s: python-%s not importable' % (label, mod))
        continue
    try:
        getattr(m, cls)(path)
        print('OK ' + label)
    except Exception as e:
        print('BAD %s: %s' % (label, e))
`;

/** Collect the fixtures the two test pages build. */
async function collectFixtures() {
    const server = await startStaticServer(root);
    try {
        const ready = '/PASS|FAIL/.test(document.title)';
        const docx = await evaluateInPage(`${server.origin}/tests/docx-export.test.html`, ready,
            'JSON.stringify({title: document.title, files: window.__officeFiles})');
        const pptx = await evaluateInPage(`${server.origin}/tests/pptx-export.test.html`, ready,
            'JSON.stringify({title: document.title, files: window.__officeFiles, expect: window.__officeExpect})');
        return {docx: JSON.parse(docx), pptx: JSON.parse(pptx)};
    } finally {
        await server.close();
    }
}

/**
 * Convert both fixtures and check them.
 * @param {{keep?: string|null, log?: (line: string) => void}} [opts]
 * @returns {Promise<boolean>}  true when every check passes
 */
export async function runOfficeConvert({keep = null, log = console.log} = {}) {
    const work = mkdtempSync(join(tmpdir(), 'bd-office-'));
    let ok = true;
    const check = (label, cond) => {
        log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
        if (!cond) ok = false;
    };
    try {
        const {docx, pptx} = await collectFixtures();
        check('docx-export.test.html passed and built fixture.docx', /PASS/.test(docx.title) && !!docx.files['fixture.docx']);
        check('pptx-export.test.html passed and built fixture.pptx', /PASS/.test(pptx.title) && !!pptx.files['fixture.pptx']);
        if (!ok) return false;

        /** Write a fixture into its own folder and convert it there (runSoffice); returns the PDF path. */
        const toPdf = async (name, base64) => {
            const dir = join(work, name.replace('.', '-'));
            mkdirSync(dir);
            writeFileSync(join(dir, name), Buffer.from(base64, 'base64'));
            await convertToPdf(join(dir, name), dir);
            return join(dir, name.replace(/\.[a-z]+$/, '.pdf'));
        };
        const wordPdf = await toPdf('fixture.docx', docx.files['fixture.docx']);
        const deckPdf = await toPdf('fixture.pptx', pptx.files['fixture.pptx']);
        const wordText = run('pdftotext', ['-layout', wordPdf, '-']);

        log('\n── strict XML parsers (python3) ──');
        // Run from the private temp folder (only our files), so `-c`'s current-directory path entry
        // cannot pick up a stray module; -E ignores PYTHON* variables. User site-packages stay
        // visible, where python-pptx and python-docx are often installed.
        const py = spawnSync('python3', ['-E', '-c', PY_CHECK, join(dirname(wordPdf), 'fixture.docx'),
            join(dirname(deckPdf), 'fixture.pptx')], {encoding: 'utf8', timeout: 120000, cwd: work});
        if (py.error || py.status !== 0) {
            log(`SKIP  python3 checks: ${py.error ? 'python3 not available' : (py.stderr || '').trim().split('\n').pop()}`);
        } else {
            for (const line of py.stdout.trim().split('\n')) {
                const [, status, rest] = /^(OK|BAD|SKIP) (.*)$/.exec(line) || [null, 'BAD', line];
                if (status === 'SKIP') log(`SKIP  ${rest}`);
                else check(rest, status === 'OK');
            }
        }

        log('\n── fixture.docx in LibreOffice ──');
        for (const [label, test] of DOCX_CHECKS) {
            check(label, typeof test === 'function' ? test(wordText) : test.test(wordText));
        }

        log('\n── fixture.pptx in LibreOffice ──');
        const pages = Number((/Pages:\s+(\d+)/.exec(run('pdfinfo', [deckPdf])) || [])[1]);
        const slides = pptx.expect['fixture.pptx'].slides;
        check(`one PDF page per slide (${pages} pages, ${slides} slides)`, pages === slides && slides > 0);
        const deckText = run('pdftotext', [deckPdf, '-']);
        for (const [label, test] of PPTX_CHECKS) {
            check(label, typeof test === 'function' ? test(deckText) : test.test(deckText));
        }

        log('\n── overflow.pptx (oversized content) in LibreOffice ──');
        if (pptx.files['overflow.pptx']) {
            const overflowPdf = await toPdf('overflow.pptx', pptx.files['overflow.pptx']);
            const pagesO = Number((/Pages:\s+(\d+)/.exec(run('pdfinfo', [overflowPdf])) || [])[1]);
            const slidesO = pptx.expect['overflow.pptx'].slides;
            check(`one PDF page per slide (${pagesO} pages, ${slidesO} slides)`, pagesO === slidesO && slidesO > 0);
        } else {
            check('pptx-export.test.html built overflow.pptx', false);
        }

        if (keep) {
            const out = resolve(keep);
            mkdirSync(out, {recursive: true});
            for (const [src, dest] of [[join(dirname(wordPdf), 'fixture.docx'), 'fixture.docx'],
                [join(dirname(deckPdf), 'fixture.pptx'), 'fixture.pptx'], [wordPdf, 'fixture-docx.pdf'], [deckPdf, 'fixture-pptx.pdf']]) {
                run('cp', [src, join(out, dest)]);
            }
            run('pdftoppm', ['-r', '60', '-png', wordPdf, join(out, 'docx-page')]);
            run('pdftoppm', ['-r', '60', '-png', deckPdf, join(out, 'pptx-slide')]);
            log(`\nkept fixtures, PDFs and page images in ${out}`);
        }
        return ok;
    } catch (e) {
        log(`FAIL  ${e.message}`);
        return false;
    } finally {
        rmSync(work, {recursive: true, force: true});
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    if (!officeToolsAvailable()) {
        console.error('office-convert: needs soffice, pdftotext and pdfinfo on PATH');
        process.exit(2);
    }
    const k = process.argv.indexOf('--keep');
    const ok = await runOfficeConvert({keep: k > -1 ? process.argv[k + 1] : null});
    process.exit(ok ? 0 : 1);
}
