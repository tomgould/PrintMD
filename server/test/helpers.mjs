/**
 * Shared helpers for the integration tests: a real API on a random port with
 * the test auth bypass, captured log lines, and poppler wrappers.
 */
import {execFileSync} from 'node:child_process';
import {mkdtempSync, writeFileSync, rmSync, readFileSync, readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {loadConfig} from '../src/config.mjs';
import {startApi} from '../src/runtime.mjs';
import {REPO_ROOT} from '../src/paths.mjs';
import {DEFAULT_TEMPLATE, TEMPLATE_IDS, templateEntry} from '../src/templates-info.mjs';
import {CODE_PALETTES} from '../../templates/_shared/base.js';

export const SHOWCASE = readFileSync(join(REPO_ROOT, 'markdown-showcase.md'), 'utf8');

/**
 * The templates under test come from the registry (templates/manifest.*.json),
 * never by name, so every template is covered and core tests name none.
 */
export {DEFAULT_TEMPLATE, TEMPLATE_IDS};
/** `template=<the default>`, for a query string. */
export const DEFAULT_QUERY = `template=${DEFAULT_TEMPLATE}`;
/** Up to n distinct template ids, the default first (fewer when the registry has fewer). */
export const someTemplates = (n) => TEMPLATE_IDS.slice(0, n);
/** The syntax palette a template's styles use ("dark" or "light"), read from its CSS. */
export function codeThemeOf(id) {
    const css = templateEntry(id).styles;
    return css.includes(`color: ${CODE_PALETTES.light.keyword}`) ? 'light' : 'dark';
}
/** The PostScript name prefix of a template's body font: "Source Serif Pro" gives "SourceSerif". */
export function bodyFontPrefix(id) {
    const family = templateEntry(id).manifest.fontStack.split(',')[0].trim().replace(/^['"]|['"]$/g, '');
    return family.split(/\s+/).slice(0, 2).join('');
}

/** PRINTMD_CHROME for the tests: as set, else Playwright's Chromium (findChrome decides). */
export const CHROME = process.env.PRINTMD_CHROME || '';

/**
 * Start the API with authentication bypassed (NODE_ENV=test only).
 * @param {{env?: object, limits?: object, authOptions?: object}} [opts]
 * @returns {Promise<{url: string, logs: object[], logText: () => string, close: () => Promise<void>, pool: object}>}
 */
export async function startTestApi({env = {}, limits = {}, authOptions, assetRoot} = {}) {
    const config = loadConfig({
        env: {NODE_ENV: 'test', PRINTMD_TEST_AUTH_BYPASS: '1', PRINTMD_API_ENABLED: '1', PRINTMD_PORT: '0',
            PRINTMD_CHROME: CHROME, ...env},
        argv: [],
    });
    const lines = [];
    const api = await startApi(config, {log: (entry) => lines.push(JSON.stringify({ts: new Date().toISOString(), ...entry})), limits, authOptions,
        assetRoot});
    return {
        ...api,
        logs: lines,
        logText: () => lines.join('\n'),
    };
}

/** POST Markdown to /render; resolves to {status, headers, body: Buffer, json?}. */
export async function render(url, markdown, query = '', {headers = {}} = {}) {
    const res = await fetch(`${url}/api/v1/render${query ? `?${query}` : ''}`, {
        method: 'POST',
        headers: {'content-type': 'text/markdown; charset=utf-8', ...headers},
        body: markdown,
    });
    return toResult(res);
}

export async function toResult(res) {
    const body = Buffer.from(await res.arrayBuffer());
    let json;
    if ((res.headers.get('content-type') || '').startsWith('application/json')) json = JSON.parse(body.toString('utf8'));
    return {status: res.status, headers: res.headers, body, json};
}

export function warningsOf(result) {
    return JSON.parse(decodeURIComponent(result.headers.get('x-printmd-warnings') || '%5B%5D'));
}

function withPdfFile(buffer, fn) {
    const dir = mkdtempSync(join(tmpdir(), 'bd-pdf-'));
    try {
        const file = join(dir, 'out.pdf');
        writeFileSync(file, buffer);
        return fn(file);
    } finally {
        rmSync(dir, {recursive: true, force: true});
    }
}

/** pdfinfo: {pages, width, height} in points. */
export function pdfInfo(buffer) {
    return withPdfFile(buffer, (file) => {
        const out = execFileSync('pdfinfo', [file]).toString();
        const size = /Page size:\s+([\d.]+) x ([\d.]+) pts/.exec(out);
        return {pages: Number(/Pages:\s+(\d+)/.exec(out)[1]), width: Number(size[1]), height: Number(size[2])};
    });
}

export function pdfText(buffer, args = []) {
    return withPdfFile(buffer, (file) => execFileSync('pdftotext', [...args, file, '-']).toString());
}

/** Number of raster images in the PDF (pdfimages -list rows of type "image"; soft masks are not counted). */
export function pdfImageCount(buffer) {
    return withPdfFile(buffer, (file) => execFileSync('pdfimages', ['-list', file]).toString().split('\n').slice(2)
        .filter((line) => line.trim().split(/\s+/)[2] === 'image').length);
}

/**
 * pdffonts as rows {name, type, embedded}: the name without its subset prefix, the type as printed
 * ("CID TrueType", "Type 3"...). Columns are cut at the widths of the dashed header line, since a type
 * can hold spaces. args: extra pdffonts options, such as ['-f', '2'] for page 2 onwards.
 */
export function pdfFontTable(buffer, args = []) {
    return withPdfFile(buffer, (file) => {
        const [, dashes, ...rows] = execFileSync('pdffonts', [...args, file]).toString().split('\n');
        const cols = [];
        for (const m of dashes.matchAll(/-+/g)) cols.push([m.index, m.index + m[0].length]);
        return rows.filter(Boolean).map((row) => {
            const [name, type, , emb] = cols.map(([a, b]) => row.slice(a, b).trim());
            return {name: name.replace(/^[A-Z]{6}\+/, ''), type, embedded: emb === 'yes'};
        });
    });
}

/** Font names from pdffonts, with the subset prefix removed, and whether each is embedded. */
export function pdfFonts(buffer) {
    return withPdfFile(buffer, (file) => execFileSync('pdffonts', [file]).toString()
        .split('\n').slice(2).filter(Boolean)
        .map((line) => {
            const parts = line.trim().split(/\s+/);
            const embIndex = parts.length - 5;
            return {name: parts[0].replace(/^[A-Z]{6}\+/, ''), embedded: parts[embIndex] === 'yes'};
        }));
}

/**
 * A canary HTTP server on 127.0.0.1 that counts every request it gets.
 * @returns {Promise<{port: number, origin: string, hits: string[], close: () => Promise<void>}>}
 */
export async function startCanary() {
    const hits = [];
    const server = createServer((req, res) => {
        hits.push(req.url);
        res.writeHead(200, {'content-type': 'image/png'});
        res.end();
    });
    await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
    const {port} = server.address();
    return {
        port,
        origin: `http://127.0.0.1:${port}`,
        hits,
        close: () => new Promise((ok) => {
            server.close(() => ok());
            server.closeAllConnections?.();
        }),
    };
}

/**
 * Chromium processes descended from a process (default: this one), by walking
 * /proc: the browser and its zygote, GPU, utility and renderer children.
 * @returns {number[]} pids
 */
export function chromiumDescendants(root = process.pid) {
    const children = new Map();
    for (const name of readdirSync('/proc')) {
        if (!/^\d+$/.test(name)) continue;
        try {
            const stat = readFileSync(`/proc/${name}/stat`, 'utf8');
            const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
            if (!children.has(ppid)) children.set(ppid, []);
            children.get(ppid).push(Number(name));
        } catch { /* gone */ }
    }
    const out = [];
    const queue = [...(children.get(root) || [])];
    while (queue.length) {
        const pid = queue.shift();
        queue.push(...(children.get(pid) || []));
        try {
            if (/chrom/i.test(readFileSync(`/proc/${pid}/cmdline`, 'utf8'))) out.push(pid);
        } catch { /* gone */ }
    }
    return out;
}

/** Wait until fn() is true, up to ms. */
export async function until(fn, ms = 5000) {
    const t0 = Date.now();
    while (!(await fn())) {
        if (Date.now() - t0 > ms) return false;
        await new Promise((r) => setTimeout(r, 50));
    }
    return true;
}

/** A tiny valid PNG (1x1) as a data: URI. */
export const PNG_DATA_URI = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/** A Markdown table with this many rows: slow to lay out and print. */
export function bigTable(rows) {
    return '# Big table\n\n| a | b | c |\n|---|---|---|\n' + Array.from({length: rows}, (_, i) => `| ${i} | x${i} | y |`).join('\n');
}
