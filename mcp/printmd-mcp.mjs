#!/usr/bin/env node
/**
 * printmd-mcp.mjs: an MCP server (Model Context Protocol, stdio transport) for the local PrintMD PDF API, so an
 * AI agent running on this machine can make PDFs from Markdown. Node 22, no dependencies: newline-delimited
 * JSON-RPC 2.0 on stdin and stdout, log lines on stderr.
 *
 *   node mcp/printmd-mcp.mjs
 *
 * Tools:
 *   check_service   is the PDF service running, and how to start it when it is not
 *   list_templates  the templates, the page sizes and orientations each offers, and the page options
 *   render_pdf      Markdown (a file or text) to a PDF file, returning its path, page count and warnings
 *
 * It talks only to the PDF service on this machine. PRINTMD_URL changes the address (default
 * http://127.0.0.1:5787) and must be a local one (127.0.0.1, localhost or [::1]); redirects are refused.
 * Every tool first checks that the health answer names the service as "printmd", so a document never goes to
 * some other program that happens to use the port.
 * It never starts the service itself: when the service is down, the tools say how to start it.
 *
 * Files: it reads only .md and .markdown files and writes only .pdf files, and only inside one folder,
 * PRINTMD_MCP_ROOT, or the folder the MCP client starts it in. Symbolic links are followed before the check, so a
 * link cannot lead out of that folder. An existing PDF is replaced only when the call says overwrite: true.
 * Local images are embedded from inside the document's folder by the agent skill's own code
 * (skills/printmd/scripts/printmd.mjs), with the same rules.
 */
import {existsSync, lstatSync, readFileSync, realpathSync, statSync, writeFileSync} from 'node:fs';
import {basename, dirname, extname, isAbsolute, join, relative, resolve} from 'node:path';
import {createInterface} from 'node:readline';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {baseUrl, embedImages, isPrintmdHealth, notPrintmdMessage} from '../skills/printmd/scripts/printmd.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER_INFO = Object.freeze({name: 'printmd', version: '1.0.0'});
/** Newest first. A client asking for one of these gets it back; any other gets the newest. */
export const PROTOCOL_VERSIONS = Object.freeze(['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']);
const MARKDOWN_TYPES = new Set(['.md', '.markdown']);
const OUTPUT_TYPES = new Set(['.pdf']);

/** A failure the agent should read: it becomes a tool result with isError set. */
class ToolError extends Error {}

const PAGE_PROPERTIES = Object.freeze({
    template: {type: 'string', description: 'A template id from list_templates. Default: the front matter\'s template, else the service\'s default.'},
    pageSize: {type: 'string', description: 'A4, A3, A5, Letter, Legal, or a custom size such as 100x150mm, 8.5x11in or 1200x800px.'},
    orientation: {type: 'string', enum: ['portrait', 'landscape']},
    layout: {type: 'string', enum: ['paged', 'continuous'], description: 'continuous: one page as tall as the document.'},
    fit: {type: 'string', enum: ['off', 'width', 'widest'], description: 'Scale blocks that are too wide. widest needs layout continuous.'},
    margin: {type: 'string', description: 'Replaces the template\'s margin, such as 12mm, 0.5in or 0.'},
    title: {type: 'string', description: 'Cover title and PDF title. Front matter can set it instead.'},
    author: {type: 'string'},
    date: {type: 'string'},
    subject: {type: 'string'},
    lang: {type: 'string', description: 'Language tag such as en-GB.'},
    cover: {type: 'boolean', description: 'false leaves out the cover. Default true.'},
    printLinks: {type: 'boolean', description: 'Print each link\'s address after its text.'},
    tidy: {type: 'boolean', description: 'false turns off the scale-down that pulls back a nearly empty last page.'},
    strict: {type: 'boolean', description: 'Refuse to make a PDF when the render found a problem.'},
});

export const TOOLS = Object.freeze([
    {
        name: 'check_service',
        title: 'Check the PrintMD PDF service',
        description: 'Says whether the PrintMD PDF service is running on this machine, with its version, or how to start it when it is not.',
        inputSchema: {type: 'object', properties: {}, additionalProperties: false},
        annotations: {readOnlyHint: true, openWorldHint: false},
    },
    {
        name: 'list_templates',
        title: 'List PrintMD templates',
        description: 'Lists the PDF templates: id, name, description, the page sizes and orientations each offers, and the default. Use an id from here for render_pdf.',
        inputSchema: {type: 'object', properties: {}, additionalProperties: false},
        annotations: {readOnlyHint: true, openWorldHint: false},
    },
    {
        name: 'render_pdf',
        title: 'Render Markdown to PDF',
        description: 'Makes a print-quality PDF from Markdown with the local PrintMD service and writes it to a file. Give a Markdown file (path) or Markdown text (markdown) with an output path. Local images are embedded from the document\'s folder. Returns the PDF\'s path, template, page count, warnings and advisories. Paths must be inside the allowed folder.',
        inputSchema: {
            type: 'object',
            properties: {
                path: {type: 'string', description: 'A .md or .markdown file. Relative paths are inside the allowed folder.'},
                markdown: {type: 'string', description: 'Markdown text, instead of path. Needs output.'},
                imageDir: {type: 'string', description: 'With markdown: the folder its relative image links are read from. Default: the allowed folder.'},
                output: {type: 'string', description: 'The .pdf file to write. Default with path: next to the Markdown, same name.'},
                overwrite: {type: 'boolean', description: 'Replace an existing PDF. Default false.'},
                ...PAGE_PROPERTIES,
            },
            additionalProperties: false,
        },
        annotations: {readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false},
    },
]);

/** The folder files are read from and written to: PRINTMD_MCP_ROOT or the working folder, symbolic links resolved. */
export function allowedRoot(env = process.env, cwd = process.cwd()) {
    const raw = env.PRINTMD_MCP_ROOT ? resolve(cwd, env.PRINTMD_MCP_ROOT) : cwd;
    try {
        return realpathSync(raw);
    } catch {
        throw new ToolError(`The allowed folder ${raw} (PRINTMD_MCP_ROOT) does not exist.`);
    }
}

function inside(root, real) {
    const rel = relative(root, real);
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function outsideMessage(path, root) {
    return `${path} is outside the folder this server may use (${root}). Set PRINTMD_MCP_ROOT to change it.`;
}

/** A Markdown file inside the root, symbolic links followed. */
export function markdownPath(root, given) {
    const path = resolve(root, given);
    if (!MARKDOWN_TYPES.has(extname(path).toLowerCase())) throw new ToolError(`Only .md and .markdown files are read: ${path}`);
    let real;
    try {
        real = realpathSync(path);
    } catch {
        throw new ToolError(`There is no file ${path}.`);
    }
    if (!inside(root, real)) throw new ToolError(outsideMessage(path, root));
    if (!MARKDOWN_TYPES.has(extname(real).toLowerCase())) throw new ToolError(`Only .md and .markdown files are read: ${path}`);
    if (!statSync(real).isFile()) throw new ToolError(`${path} is not a file.`);
    return real;
}

/** An output file inside the root: its folder must exist, and an existing file must be a PDF inside the root. */
export function outputPath(root, given, overwrite) {
    const path = resolve(root, given);
    if (!OUTPUT_TYPES.has(extname(path).toLowerCase())) throw new ToolError(`Only .pdf files are written: ${path}`);
    let folder;
    try {
        folder = realpathSync(dirname(path));
    } catch {
        throw new ToolError(`There is no folder ${dirname(path)} to write the PDF in.`);
    }
    if (!inside(root, folder)) throw new ToolError(outsideMessage(path, root));
    const target = join(folder, basename(path));
    if (lstatSync(target, {throwIfNoEntry: false})) {
        let real;
        try {
            real = realpathSync(target);
        } catch {
            throw new ToolError(`${path} is a broken link; it is not written through.`);
        }
        if (!inside(root, real)) throw new ToolError(outsideMessage(path, root));
        if (!OUTPUT_TYPES.has(extname(real).toLowerCase()) || !statSync(real).isFile()) throw new ToolError(`${path} is not a PDF file.`);
        if (!overwrite) throw new ToolError(`${path} already exists. Call again with overwrite: true to replace it, or pick another output.`);
        return real;
    }
    return target;
}

function startHelp(base) {
    const setup = existsSync(join(REPO, 'server/node_modules'))
        ? ''
        : `\nFirst time: npm --prefix "${join(REPO, 'server')}" ci, then npx --prefix "${join(REPO, 'server')}" playwright install chromium (or set PRINTMD_CHROME to your Chrome).`;
    return [
        `The PrintMD PDF service is not running at ${base}. Start it with:`,
        `  npm --prefix "${join(REPO, 'server')}" run start:local`,
        'or, if it is installed as a user service:',
        '  systemctl --user start printmd-api',
        `It listens only on 127.0.0.1. Then try again.${setup}`,
    ].join('\n');
}

async function call(base, path, init = {}) {
    const {timeout = 120000, ...rest} = init;
    try {
        return await fetch(base + path, {...rest, redirect: 'error', signal: AbortSignal.timeout(timeout)});
    } catch (err) {
        if (err?.name === 'TimeoutError') throw new ToolError(`The PDF service at ${base} took too long to answer.`);
        if (err?.cause?.code === 'ECONNREFUSED' || err?.cause?.code === 'ECONNRESET' || err?.cause?.code === 'EADDRNOTAVAIL') {
            throw new ToolError(startHelp(base));
        }
        throw new ToolError(`Could not reach the PDF service at ${base}: ${err?.cause?.message || err?.message}\n\n${startHelp(base)}`);
    }
}

function service() {
    try {
        return baseUrl(process.env);
    } catch (err) {
        throw new ToolError(err.message);
    }
}

const notPrintmd = (base) => new ToolError(notPrintmdMessage(base, 'the PrintMD PDF service'));

/** The health answer, refused unless it names the service as PrintMD. */
async function identify(base) {
    const res = await call(base, '/api/v1/health', {timeout: 5000});
    const body = await res.json().catch(() => null);
    if (!res.ok || !isPrintmdHealth(body)) throw notPrintmd(base);
    return body;
}

async function checkService() {
    const base = service();
    const body = await identify(base);
    const state = body.status === 'ok' ? '' : ` Its state is ${body.status}: the next render starts a fresh browser.`;
    return {
        text: `The PrintMD PDF service is running at ${base} (version ${body.version}, ${body.mode} mode).${state}`,
        data: {running: true, url: base, version: body.version, mode: body.mode, status: body.status},
    };
}

async function fetchTemplates(base) {
    await identify(base);
    const res = await call(base, '/api/v1/templates', {timeout: 10000});
    const body = await res.json().catch(() => null);
    if (!res.ok || !body || !Array.isArray(body.templates)) throw notPrintmd(base);
    return body;
}

async function listTemplates() {
    const list = await fetchTemplates(service());
    const lines = list.templates.map((t) => [
        t.id + (t.id === list.default ? ' (default)' : ''),
        t.name,
        t.description,
        `sizes: ${(t.pageSizes || []).join(', ')}; ${(t.orientations || []).join(' or ')}`,
    ].join(' | '));
    return {text: lines.join('\n'), data: list};
}

function header(res, name) {
    try {
        return JSON.parse(decodeURIComponent(res.headers.get(name) || '[]'));
    } catch {
        return [];
    }
}

function frontMatterTemplate(text) {
    const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
    const line = block && /^template:\s*(.+?)\s*$/m.exec(block[1]);
    return line ? line[1].replace(/^["']|["']$/g, '') : null;
}

function readUtf8(path) {
    try {
        return new TextDecoder('utf-8', {fatal: true}).decode(readFileSync(path));
    } catch {
        throw new ToolError(`${path} is not UTF-8 text.`);
    }
}

async function renderPdf(args) {
    const root = allowedRoot();
    const hasPath = typeof args.path === 'string' && args.path !== '';
    const hasText = typeof args.markdown === 'string';
    if (hasPath === hasText) throw new ToolError('Give either path (a Markdown file) or markdown (the text), not both.');
    if (hasText && !args.output) throw new ToolError('With markdown, give output: the .pdf file to write.');

    let text;
    let docDir;
    let defaultOut;
    if (hasPath) {
        const src = markdownPath(root, args.path);
        text = readUtf8(src);
        docDir = dirname(src);
        defaultOut = join(docDir, basename(src, extname(src)) + '.pdf');
    } else {
        text = args.markdown;
        docDir = root;
        if (args.imageDir) {
            try {
                docDir = realpathSync(resolve(root, args.imageDir));
            } catch {
                throw new ToolError(`There is no folder ${resolve(root, args.imageDir)}.`);
            }
            if (!inside(root, docDir)) throw new ToolError(outsideMessage(docDir, root));
        }
    }
    const out = outputPath(root, args.output || defaultOut, args.overwrite === true);

    // Listing first means a stopped service or an unknown template fails before anything is read or written.
    const base = service();
    const list = await fetchTemplates(base);
    const template = args.template || frontMatterTemplate(text) || list.default;
    if (!list.templates.some((t) => t.id === template)) {
        throw new ToolError(`Unknown template "${template}". Available: ${list.templates.map((t) => t.id).join(', ')}.`);
    }

    const embedded = embedImages(text, docDir);
    const query = new URLSearchParams();
    for (const key of ['template', 'pageSize', 'orientation', 'layout', 'fit', 'margin', 'title', 'author', 'date', 'subject', 'lang']) {
        if (typeof args[key] === 'string' && args[key] !== '') query.set(key, args[key]);
    }
    for (const key of ['cover', 'printLinks', 'tidy', 'strict']) {
        if (typeof args[key] === 'boolean') query.set(key, String(args[key]));
    }

    const res = await call(base, `/api/v1/render?${query}`, {
        method: 'POST',
        headers: {'Content-Type': 'text/markdown; charset=utf-8'},
        body: embedded.markdown,
    });
    if (!res.ok) {
        const body = await res.json().catch(() => null);
        const detail = body?.error?.message || `status ${res.status}`;
        throw new ToolError(`The PDF service refused the request (${res.status}${body?.error?.code ? ` ${body.error.code}` : ''}): ${detail}`);
    }
    if (!String(res.headers.get('content-type') || '').startsWith('application/pdf')) {
        throw notPrintmd(base);
    }
    writeFileSync(out, Buffer.from(await res.arrayBuffer()));
    const data = {
        path: out,
        template,
        pages: Number(res.headers.get('x-printmd-pages')),
        warnings: [...embedded.warnings, ...header(res, 'x-printmd-warnings')],
        advisories: header(res, 'x-printmd-advisories'),
        tidy: Number(res.headers.get('x-printmd-tidy')),
        remoteImages: embedded.remote,
    };
    const lines = [`PDF: ${data.path}`, `Template: ${data.template}`, `Pages: ${data.pages}`];
    if (data.warnings.length) lines.push('Warnings:', ...data.warnings.map((w) => `  - ${w}`));
    if (data.advisories.length) lines.push('Notes:', ...data.advisories.map((a) => `  - ${a}`));
    if (data.remoteImages.length) {
        lines.push('Web images are not fetched, so they were left out:', ...data.remoteImages.map((u) => `  - ${u}`));
    }
    return {text: lines.join('\n'), data};
}

const HANDLERS = Object.freeze({check_service: checkService, list_templates: listTemplates, render_pdf: renderPdf});

async function callTool(params) {
    const handler = Object.hasOwn(HANDLERS, params?.name) ? HANDLERS[params.name] : null;
    if (!handler) return {error: {code: -32602, message: `Unknown tool: ${params?.name}`}};
    const args = params.arguments && typeof params.arguments === 'object' ? params.arguments : {};
    try {
        const {text, data} = await handler(args);
        return {result: {content: [{type: 'text', text}], structuredContent: data, isError: false}};
    } catch (err) {
        const message = err instanceof ToolError ? err.message : `Unexpected error: ${err?.message || err}`;
        if (!(err instanceof ToolError)) console.error(err?.stack || String(err));
        return {result: {content: [{type: 'text', text: message}], isError: true}};
    }
}

/** One JSON-RPC message in, the reply out (null for a notification or a reply to us). */
export async function handle(message) {
    if (!message || typeof message !== 'object' || Array.isArray(message) || message.jsonrpc !== '2.0') {
        return {jsonrpc: '2.0', id: null, error: {code: -32600, message: 'Invalid request'}};
    }
    const {id, method, params} = message;
    const isRequest = id !== undefined && id !== null;
    if (typeof method !== 'string') return null; // a response to a request we never send, or junk without an id
    if (!isRequest) return null; // notifications: initialized, cancelled and the rest need no answer

    let outcome;
    if (method === 'initialize') {
        const asked = params?.protocolVersion;
        outcome = {result: {
            protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
            capabilities: {tools: {listChanged: false}},
            serverInfo: SERVER_INFO,
            instructions: 'Makes PDFs from Markdown with the PrintMD service on this machine. Call check_service first, '
                + 'list_templates to choose a template, then render_pdf.',
        }};
    } else if (method === 'ping') {
        outcome = {result: {}};
    } else if (method === 'tools/list') {
        outcome = {result: {tools: TOOLS}};
    } else if (method === 'tools/call') {
        outcome = await callTool(params);
    } else {
        outcome = {error: {code: -32601, message: `Method not found: ${method}`}};
    }
    return {jsonrpc: '2.0', id, ...outcome};
}

function send(reply) {
    if (reply) process.stdout.write(JSON.stringify(reply) + '\n');
}

function serve() {
    const lines = createInterface({input: process.stdin, crlfDelay: Infinity});
    const pending = new Set();
    lines.on('line', (line) => {
        if (!line.trim()) return;
        let message;
        try {
            message = JSON.parse(line);
        } catch {
            send({jsonrpc: '2.0', id: null, error: {code: -32700, message: 'Parse error'}});
            return;
        }
        const job = handle(message).then(send, (err) => {
            console.error(err?.stack || String(err));
            if (message?.id !== undefined && message?.id !== null) {
                send({jsonrpc: '2.0', id: message.id, error: {code: -32603, message: 'Internal error'}});
            }
        });
        pending.add(job);
        job.finally(() => pending.delete(job));
    });
    lines.on('close', async () => {
        await Promise.allSettled([...pending]);
        process.exit(0);
    });
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) serve();
