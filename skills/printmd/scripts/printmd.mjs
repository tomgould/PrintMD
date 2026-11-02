#!/usr/bin/env node
/**
 * printmd.mjs: a small client for the local PrintMD PDF API, used by the Claude Code skill next to it
 * (../SKILL.md). Node 22, no dependencies.
 *
 *   node printmd.mjs check
 *   node printmd.mjs templates
 *   node printmd.mjs render FILE.md [--template ID] [--page-size A4|100x150mm] [--orientation portrait|landscape]
 *                     [--layout paged|continuous] [--fit off|width|widest] [--margin 12mm] [--print-links]
 *                     [--no-tidy] [--strict] [-o OUT.pdf] [--force] [--json]
 *
 * The API reads no files and fetches nothing, so render embeds the document's local images as data: URIs first.
 * Title, author, date, subject and language come from the document's front matter, never from an option, so
 * text from a document never reaches a command line.
 *
 * PRINTMD_URL changes the address (default http://127.0.0.1:8787). Only a local address is accepted.
 *
 * Exit codes: 0 done, 2 bad option or address, 3 the API is not running, 5 the API refused the request or
 * something else answered, 6 a local file problem.
 */
import {existsSync, readFileSync, realpathSync, statSync, writeFileSync} from 'node:fs';
import {basename, dirname, extname, isAbsolute, join, relative, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const DEFAULT_URL = 'http://127.0.0.1:8787';
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const IMAGE_TYPES = Object.freeze({
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
    '.webp': 'image/webp', '.svg': 'image/svg+xml',
});
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

const VALUE_OPTIONS = Object.freeze({
    '--template': 'template', '--page-size': 'pageSize', '--orientation': 'orientation', '--layout': 'layout',
    '--fit': 'fit', '--margin': 'margin', '-o': 'output', '--output': 'output',
});
const FLAG_OPTIONS = Object.freeze({
    '--print-links': 'printLinks', '--no-tidy': 'noTidy', '--strict': 'strict', '--force': 'force', '--json': 'json',
});

/** An expected failure: the message is for the user, the code is the exit code. */
class Failure extends Error {
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}

/** The API's address: PRINTMD_URL or the default, and only ever a local one (the service runs on your machine). */
export function baseUrl(env = process.env) {
    const raw = env.PRINTMD_URL || DEFAULT_URL;
    let url;
    try {
        url = new URL(raw);
    } catch {
        throw new Failure(2, `PRINTMD_URL is not an address: ${raw}`);
    }
    const plain = url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname) && !url.username && !url.password
        && url.pathname === '/' && !url.search && !url.hash;
    if (!plain) {
        throw new Failure(2, 'PRINTMD_URL must be http://127.0.0.1:<port> (or localhost, or [::1]). The PDF service only runs on your own computer.');
    }
    return url.origin;
}

function startHelp(base) {
    return [
        `The PrintMD API is not running at ${base}. Start it from the PrintMD folder:`,
        '  npm --prefix server run start:local',
        'or, if you installed it as a user service:',
        '  systemctl --user start printmd-api',
        'It listens only on 127.0.0.1. Then ask again.',
    ].join('\n');
}

async function call(base, path, init = {}) {
    const {timeout = 60000, ...rest} = init;
    try {
        return await fetch(base + path, {...rest, signal: AbortSignal.timeout(timeout)});
    } catch (err) {
        if (err?.name === 'TimeoutError') throw new Failure(5, `The API at ${base} took too long to answer.`);
        throw new Failure(3, startHelp(base));
    }
}

async function check(base) {
    const res = await call(base, '/api/v1/health', {timeout: 5000});
    const body = await res.json().catch(() => null);
    if (!res.ok || !body || body.status !== 'ok') {
        throw new Failure(5, `Something other than the PrintMD API answered at ${base}.`);
    }
    return {base, version: body.version, mode: body.mode};
}

async function listTemplates(base) {
    const res = await call(base, '/api/v1/templates', {timeout: 10000});
    const body = await res.json().catch(() => null);
    if (!res.ok || !body || !Array.isArray(body.templates)) {
        throw new Failure(5, `Something other than the PrintMD API answered at ${base}.`);
    }
    return body;
}

function templateLines(list) {
    return list.templates.map((t) => [
        t.id + (t.id === list.default ? ' (default)' : ''),
        t.name,
        t.description,
        `sizes: ${t.pageSizes.join(', ')}; ${t.orientations.join(' or ')}`,
    ].join(' | '));
}

/**
 * Replaces the document's local images with data: URIs. Only files inside the document's own folder are read
 * (symbolic links are followed first, so a link cannot lead out of it), and only png, jpeg, gif, webp and svg up
 * to 5 MB. Code blocks are left alone. Web images are not fetched: the API cannot load them, so they are listed.
 * @returns {{markdown: string, warnings: string[], remote: string[]}}
 */
export function embedImages(markdown, docDir) {
    const root = realpathSync(docDir);
    const warnings = [];
    const remote = new Set();

    function dataUri(target) {
        const bare = target.split(/[?#]/)[0];
        let rel;
        try {
            rel = decodeURIComponent(bare);
        } catch {
            rel = bare;
        }
        let real;
        try {
            real = realpathSync(resolve(root, rel));
        } catch {
            warnings.push(`Image not found: ${target}`);
            return null;
        }
        const inside = relative(root, real);
        if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) {
            warnings.push(`Image is outside the document's folder, so it was left out: ${target}`);
            return null;
        }
        const type = IMAGE_TYPES[extname(real).toLowerCase()];
        if (!type) {
            warnings.push(`Not a png, jpeg, gif, webp or svg image: ${target}`);
            return null;
        }
        if (statSync(real).size > MAX_IMAGE_BYTES) {
            warnings.push(`Image is over 5 MB, so it was left out: ${target}`);
            return null;
        }
        return `data:${type};base64,${readFileSync(real).toString('base64')}`;
    }

    function swap(raw) {
        const wrapped = raw.length > 1 && raw.startsWith('<') && raw.endsWith('>');
        const target = wrapped ? raw.slice(1, -1) : raw;
        if (/^data:/i.test(target)) return raw;
        if (/^[a-z][a-z0-9+.-]+:/i.test(target) || target.startsWith('//')) {
            remote.add(target);
            return raw;
        }
        return dataUri(target) ?? raw;
    }

    const isImageFile = (target) => /\.(png|jpe?g|gif|webp|svg)$/i.test(target.replace(/^<|>$/g, '').split(/[?#]/)[0]);

    let fence = null;
    const lines = markdown.split('\n').map((line) => {
        const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line);
        if (fence) {
            if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = null;
            return line;
        }
        if (marker) {
            fence = marker[1];
            return line;
        }
        return line
            .replace(/(!\[[^\]]*\]\(\s*)(<[^>\n]+>|[^)\s]+)/g, (_, head, target) => head + swap(target))
            .replace(/(<img\b[^>]*?\bsrc\s*=\s*)(["'])([^"']+)\2/gi, (_, head, quote, target) => head + quote + swap(target) + quote)
            .replace(/^( {0,3}\[[^\]]+\]:\s*)(<[^>\n]+>|\S+)/, (all, head, target) => (isImageFile(target) ? head + swap(target) : all));
    });
    return {markdown: lines.join('\n'), warnings, remote: [...remote]};
}

function frontMatterTemplate(text) {
    const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
    const line = block && /^template:\s*(.+?)\s*$/m.exec(block[1]);
    return line ? line[1].replace(/^["']|["']$/g, '') : null;
}

function readDocument(file) {
    const path = resolve(file);
    let bytes;
    try {
        if (!statSync(path).isFile()) throw new Error('not a file');
        bytes = readFileSync(path);
    } catch {
        throw new Failure(6, `Cannot read ${path}.`);
    }
    try {
        return {path, text: new TextDecoder('utf-8', {fatal: true}).decode(bytes)};
    } catch {
        throw new Failure(6, `${path} is not UTF-8 text.`);
    }
}

async function render(base, file, opts) {
    const doc = readDocument(file);
    const out = opts.output ? resolve(opts.output) : join(dirname(doc.path), basename(doc.path, extname(doc.path)) + '.pdf');
    if (!existsSync(dirname(out))) throw new Failure(6, `There is no folder ${dirname(out)} to write the PDF in.`);
    if (existsSync(out) && !opts.force) {
        throw new Failure(6, `${out} already exists. Use --force to replace it, or -o to pick another name.`);
    }

    // Listing first means a stopped API or an unknown template fails before anything else is done.
    const list = await listTemplates(base);
    const template = opts.template || frontMatterTemplate(doc.text) || list.default;
    if (!list.templates.some((t) => t.id === template)) {
        throw new Failure(2, `Unknown template "${template}". Available: ${list.templates.map((t) => t.id).join(', ')}.`);
    }

    const embedded = embedImages(doc.text, dirname(doc.path));
    const query = new URLSearchParams();
    if (opts.template) query.set('template', opts.template);
    if (opts.pageSize) query.set('pageSize', opts.pageSize);
    if (opts.orientation) query.set('orientation', opts.orientation);
    if (opts.layout) query.set('layout', opts.layout);
    if (opts.fit) query.set('fit', opts.fit);
    if (opts.margin) query.set('margin', opts.margin);
    if (opts.printLinks) query.set('printLinks', 'true');
    if (opts.noTidy) query.set('tidy', 'false');
    if (opts.strict) query.set('strict', 'true');

    const res = await call(base, `/api/v1/render?${query}`, {
        method: 'POST',
        headers: {'Content-Type': 'text/markdown; charset=utf-8'},
        body: embedded.markdown,
    });
    if (!res.ok) {
        const body = await res.json().catch(() => null);
        const detail = body?.error?.message || `status ${res.status}`;
        throw new Failure(5, `The API refused the request (${res.status}${body?.error?.code ? ` ${body.error.code}` : ''}): ${detail}`);
    }
    if (!String(res.headers.get('content-type') || '').startsWith('application/pdf')) {
        throw new Failure(5, `Something other than the PrintMD API answered at ${base}.`);
    }
    const header = (name) => {
        try {
            return JSON.parse(decodeURIComponent(res.headers.get(name) || '[]'));
        } catch {
            return [];
        }
    };
    writeFileSync(out, Buffer.from(await res.arrayBuffer()));
    return {
        path: out,
        template,
        pages: Number(res.headers.get('x-printmd-pages')),
        warnings: header('x-printmd-warnings'),
        advisories: header('x-printmd-advisories'),
        tidy: Number(res.headers.get('x-printmd-tidy')),
        localWarnings: embedded.warnings,
        remoteImages: embedded.remote,
    };
}

function parse(argv) {
    const opts = {};
    const rest = [];
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (Object.hasOwn(VALUE_OPTIONS, arg)) {
            if (i + 1 >= argv.length) throw new Failure(2, `${arg} needs a value.`);
            opts[VALUE_OPTIONS[arg]] = argv[++i];
        } else if (Object.hasOwn(FLAG_OPTIONS, arg)) {
            opts[FLAG_OPTIONS[arg]] = true;
        } else if (arg.startsWith('-')) {
            throw new Failure(2, `Unknown option ${arg}.`);
        } else {
            rest.push(arg);
        }
    }
    return {opts, rest};
}

const USAGE = 'Usage: printmd.mjs check | templates | render FILE.md [options] (see the header of this file)';

async function main(argv) {
    const [command, ...args] = argv;
    const {opts, rest} = parse(args);
    const base = baseUrl();
    if (command === 'check') {
        const info = await check(base);
        console.log(`The PrintMD API is running at ${info.base} (version ${info.version}, ${info.mode} mode).`);
    } else if (command === 'templates') {
        console.log(templateLines(await listTemplates(base)).join('\n'));
    } else if (command === 'render') {
        if (rest.length !== 1) throw new Failure(2, 'render takes one Markdown file.');
        const result = await render(base, rest[0], opts);
        if (opts.json) {
            console.log(JSON.stringify(result, null, 2));
            return;
        }
        console.log(`PDF: ${result.path}\nTemplate: ${result.template}\nPages: ${result.pages}`);
        const problems = [...result.localWarnings, ...result.warnings];
        if (problems.length) console.log(`Warnings:\n${problems.map((w) => `  - ${w}`).join('\n')}`);
        if (result.advisories.length) console.log(`Notes:\n${result.advisories.map((a) => `  - ${a}`).join('\n')}`);
        if (result.remoteImages.length) {
            console.log(`Web images the API cannot fetch (download them next to the document to include them):\n${result.remoteImages.map((u) => `  - ${u}`).join('\n')}`);
        }
    } else {
        throw new Failure(2, USAGE);
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main(process.argv.slice(2)).catch((err) => {
        if (err instanceof Failure) {
            console.error(err.message);
            process.exit(err.code);
        }
        console.error(err?.stack || String(err));
        process.exit(1);
    });
}
