/**
 * The HTTP API (/api/v1), on plain node:http.
 *
 *   POST /api/v1/render     Markdown in, PDF out
 *   GET  /api/v1/templates  the templates and the page options they take
 *   GET  /api/v1/whoami     the caller
 *   GET  /api/v1/health     loopback callers only: browser and queue state
 *
 * Every response carries X-Request-Id and X-PrintMD-Version. Errors are
 * JSON {error: {code, message}}. One JSON log line per request, with sizes,
 * timings and status, never the Markdown, titles, option values or Chromium
 * error text.
 */
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {ApiError, errorBody, errorStatus} from './errors.mjs';
import {parseRenderRequest, resolveTemplate, checkPageOptions, checkPageSize, LIMITS} from './options.mjs';
import {parseFrontMatter} from '../../js/doc-meta.js';
import {parseCustomSize} from '../../js/export-options.js';
import {listTemplates} from './templates-info.mjs';
import {safeFilename} from './filename.mjs';
import {warningsHeader} from './warnings.mjs';
import {isLoopbackHost} from './config.mjs';
import {RETRY_AFTER_SECONDS} from './limiter.mjs';

const ROUTES = {
    '/api/v1/render': {name: 'render', methods: ['POST']},
    '/api/v1/templates': {name: 'templates', methods: ['GET']},
    '/api/v1/whoami': {name: 'whoami', methods: ['GET']},
    '/api/v1/health': {name: 'health', methods: ['GET']},
};

/** Bodies read at once; beyond that a render request gets 429 before its body is read. */
export const MAX_BODIES_IN_FLIGHT = 4;
/**
 * Local mode keeps one more body slot for a small request (declared size up to
 * SMALL_BODY_BYTES) from a loopback peer, so uploads trickling into the other
 * slots cannot stop the owner's everyday renders.
 */
export const SMALL_BODY_BYTES = 64 * 1024;
/** Open connections the server accepts at once. */
export const MAX_CONNECTIONS = 64;
/** How long a client may take to send its request headers. */
export const HEADERS_TIMEOUT_MS = 10_000;
/** How long a client may take to send its whole body. */
export const BODY_DEADLINE_MS = 30_000;
/** After BODY_RATE_GRACE_MS, a body that has arrived slower than this (bytes a second) on average is dropped. */
export const BODY_MIN_RATE = 1024;
export const BODY_RATE_GRACE_MS = 5_000;

/**
 * Read and drop the rest of a body the server will not use (nothing is kept),
 * so the client gets the error answer instead of a reset connection; past
 * 2 x limit the socket is closed.
 */
function discardBody(req, limit) {
    let dropped = 0;
    req.on('data', (chunk) => {
        dropped += chunk.length;
        if (dropped > limit * 2) req.destroy();
    });
    req.resume();
}

/**
 * Read the body up to limit bytes; more is 413. A body that is not complete
 * within deadlineMs, or that arrives slower than minRate bytes a second on
 * average once graceMs have passed, is dropped with 408 and its connection
 * closed (req.bdDropConnection), so a trickling client frees its slot.
 */
function readBody(req, limit, {deadlineMs = BODY_DEADLINE_MS, minRate = BODY_MIN_RATE, graceMs = BODY_RATE_GRACE_MS} = {}) {
    const discard = () => discardBody(req, limit);
    return new Promise((resolve, reject) => {
        const declared = Number(req.headers['content-length']);
        if (Number.isFinite(declared) && declared > limit) {
            discard();
            reject(new ApiError(413, 'body_too_large', 'The request body is larger than 15 MB.'));
            return;
        }
        const chunks = [];
        let size = 0;
        let done = false;
        const started = Date.now();
        const drop = (code, message) => {
            if (done) return;
            done = true;
            chunks.length = 0;
            clearInterval(watch);
            req.bdDropConnection = true;
            req.pause();
            reject(new ApiError(408, code, message));
        };
        const watch = setInterval(() => {
            const elapsed = Date.now() - started;
            if (elapsed >= deadlineMs) drop('body_timeout', `The request body took longer than ${Math.round(deadlineMs / 1000)} seconds.`);
            else if (elapsed >= graceMs && size / (elapsed / 1000) < minRate) drop('body_too_slow', 'The request body arrived too slowly.');
        }, Math.min(250, deadlineMs, graceMs));
        const settle = () => clearInterval(watch);
        req.on('close', () => {
            settle();
            if (!done) {
                done = true;
                reject(new ApiError(400, 'bad_request', 'The request body could not be read.'));
            }
        });
        req.on('data', (chunk) => {
            size += chunk.length;
            if (done) {
                if (size > limit * 3) req.destroy();
                return;
            }
            if (size > limit) {
                done = true;
                settle();
                chunks.length = 0;
                reject(new ApiError(413, 'body_too_large', 'The request body is larger than 15 MB.'));
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => {
            settle();
            if (!done) {
                done = true;
                resolve(Buffer.concat(chunks));
            }
        });
        req.on('error', () => {
            settle();
            if (!done) {
                done = true;
                reject(new ApiError(400, 'bad_request', 'The request body could not be read.'));
            }
        });
    });
}

/** Headers a proxy adds. Any one of them, even empty, means the caller may be elsewhere. */
const PROXY_HEADERS = ['x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'forwarded', 'x-real-ip',
    'true-client-ip', 'x-client-ip', 'cf-connecting-ip', 'via'];

/** Health is for the machine itself: a loopback peer, not forwarded by a proxy (the Host rule applies too). */
function isLocalCaller(req) {
    const peer = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
    return isLoopbackHost(peer) && !PROXY_HEADERS.some((name) => req.headers[name] !== undefined);
}

const LOOPBACK_NAMES = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** "name:port" or "[v6]:port" from a Host header, lower-cased; port '' when absent. */
function splitHost(value) {
    const v = String(value || '').trim().toLowerCase();
    const m = /^(\[[0-9a-f:.]+\]|[^:[\]]+)(?::(\d{1,5}))?$/.exec(v);
    return m ? {name: m[1], port: m[2] || ''} : null;
}

/**
 * Who may address the server.
 *
 * With authentication off (local mode, test bypass) any web page the user opens
 * could otherwise reach it: by DNS rebinding (a foreign name that resolves to
 * 127.0.0.1) or by a cross-site request. So every route answers only when the
 * Host header is 127.0.0.1, localhost or [::1] with the server's own port, and
 * a request that carries an Origin header (browsers add it) must come from that
 * same loopback origin; "Origin: null" is refused too. Curl and scripts send no
 * Origin and are unaffected.
 *
 * In deployed mode the Access token is the control; PRINTMD_ALLOWED_HOSTS,
 * when set, also limits the Host header to the names listed.
 */
function checkHostAndOrigin(req, config) {
    // Node keeps the first of repeated Host headers (and joins repeated Origins),
    // so count them in the raw headers: more than one of either is refused.
    const count = (name) => req.rawHeaders.filter((h, i) => i % 2 === 0 && h.toLowerCase() === name).length;
    if (count('host') > 1) throw new ApiError(403, 'forbidden_host', 'Send one Host header.');
    if (count('origin') > 1) throw new ApiError(403, 'forbidden_origin', 'Send at most one Origin header.');
    const port = String(req.socket.localPort);
    const host = splitHost(req.headers.host);
    if (config.mode === 'local' || config.testAuthBypass) {
        if (!host || !LOOPBACK_NAMES.has(host.name) || host.port !== port) {
            throw new ApiError(403, 'forbidden_host', 'This server only answers requests to 127.0.0.1, localhost or [::1] on its own port.');
        }
        const origin = req.headers.origin;
        if (origin !== undefined) {
            let ok = false;
            try {
                const u = new URL(origin);
                ok = u.protocol === 'http:' && LOOPBACK_NAMES.has(u.hostname) && u.port === port && u.origin === origin.toLowerCase();
            } catch { /* "null" and anything unparseable */ }
            if (!ok) throw new ApiError(403, 'forbidden_origin', 'Requests from other web pages are not accepted.');
        }
        return;
    }
    if (config.allowedHosts && config.allowedHosts.length && (!host || !config.allowedHosts.includes(host.name))) {
        throw new ApiError(403, 'forbidden_host', 'This host name is not served here.');
    }
}

/**
 * @param {object} deps
 * @param {object} deps.config        from loadConfig()
 * @param {{authenticate: Function}} deps.auth
 * @param {{render: Function}} deps.renderer
 * @param {import('./limiter.mjs').Limiter} deps.limiter
 * @param {{status: Function}} [deps.pool]
 * @param {(entry: object) => void} deps.log
 * @param {string} deps.version
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void}
 */
export function createHandler({config, auth, renderer, limiter, pool, log, version, maxBodies,
    bodyDeadlineMs = BODY_DEADLINE_MS, bodyRateGraceMs = BODY_RATE_GRACE_MS, bodyMinRate = BODY_MIN_RATE}) {
    maxBodies = maxBodies ?? MAX_BODIES_IN_FLIGHT;
    const started = Date.now();
    let bodiesInFlight = 0;
    let reservedInFlight = 0;
    const authOff = config.mode === 'local' || config.testAuthBypass;

    /** May this request use the reserved slot? Local mode, a loopback peer, a small declared body. */
    function smallLocalRequest(req) {
        const declared = Number(req.headers['content-length']);
        const peer = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
        return authOff && isLoopbackHost(peer) && Number.isFinite(declared) && declared <= SMALL_BODY_BYTES;
    }

    async function handle(req, res, entry) {
        const url = new URL(req.url, 'http://api.invalid');
        const route = ROUTES[url.pathname];
        entry.route = route ? route.name : 'unknown';
        checkHostAndOrigin(req, config);

        if (route && route.name === 'health') {
            if (!isLocalCaller(req)) throw new ApiError(404, 'not_found', 'Not found.');
            if (!route.methods.includes(req.method)) throw methodNotAllowed(route);
            const browser = pool ? pool.status() : null;
            return sendJson(res, 200, {
                // "degraded": a wedged browser was killed and no render has succeeded since.
                status: browser && browser.state === 'degraded' ? 'degraded' : 'ok',
                version,
                mode: config.testAuthBypass ? 'test' : config.mode,
                apiEnabled: config.apiEnabled,
                uptimeSeconds: Math.round((Date.now() - started) / 1000),
                browser,
                queue: limiter.stats(),
            });
        }
        if (url.pathname.startsWith('/api/v1/') && !config.apiEnabled) {
            throw new ApiError(503, 'api_disabled', 'The PDF API is switched off on this server.');
        }
        if (!route) throw new ApiError(404, 'not_found', 'Not found.');
        if (!route.methods.includes(req.method)) throw methodNotAllowed(route);

        const caller = await auth.authenticate(req.headers, req.rawHeaders);
        entry.email = caller.mode === 'local' ? 'local' : caller.email;

        if (route.name === 'whoami') {
            return sendJson(res, 200, caller.mode === 'access' ? {email: caller.email} : {email: caller.email, mode: caller.mode});
        }
        if (route.name === 'templates') return sendJson(res, 200, listTemplates());
        return renderRoute(req, res, url, entry);
    }

    async function renderRoute(req, res, url, entry) {
        // Bodies are held in memory, decoded and parsed before the render queue,
        // so only maxBodies are read at once; the next request is refused unread.
        let reserved = false;
        if (bodiesInFlight >= maxBodies) {
            if (reservedInFlight === 0 && smallLocalRequest(req)) {
                reserved = true;
            } else {
                discardBody(req, LIMITS.bodyBytes);
                throw new ApiError(429, 'busy', 'The renderer is busy. Try again shortly.', {
                    headers: {'Retry-After': String(RETRY_AFTER_SECONDS), Connection: 'close'},
                });
            }
        }
        if (reserved) reservedInFlight++;
        else bodiesInFlight++;
        let options, templateId, templateWarnings;
        try {
            const body = await readBody(req, LIMITS.bodyBytes, {deadlineMs: bodyDeadlineMs, minRate: bodyMinRate, graceMs: bodyRateGraceMs});
            entry.bytesIn = body.length;
            options = parseRenderRequest({contentType: req.headers['content-type'], query: url.searchParams, body});
            const {meta: frontMatter} = parseFrontMatter(options.markdown);
            ({templateId, warnings: templateWarnings} = resolveTemplate(options, frontMatter));
            entry.template = templateId;
            checkPageSize(options, templateId);
            checkPageOptions(options, templateId, frontMatter);
        } finally {
            // The slot is free as soon as the body is read, refused or dropped.
            if (reserved) reservedInFlight--;
            else bodiesInFlight--;
        }

        const gone = new AbortController();
        res.on('close', () => { if (!res.writableFinished) gone.abort(); });
        const result = await limiter.run(() => {
            if (gone.signal.aborted) throw new ApiError(499, 'cancelled', 'The request was cancelled.');
            return renderer.render({
                markdown: options.markdown,
                templateId,
                pageSize: options.pageSize,
                orientation: options.orientation,
                layout: options.layout,
                fit: options.fit,
                margin: options.margin,
                meta: options.meta,
                lang: options.lang,
                printLinks: options.printLinks,
                cover: options.cover,
                tidy: options.tidy,
            });
        }, {signal: gone.signal});

        // Blocking warnings are defects strict refuses; advisories (a nearly empty last page) are only reported.
        const warnings = [...templateWarnings, ...result.warnings];
        // A custom size prints exactly as given: an orientation sent with one is said to be ignored.
        const ignored = options.orientation !== undefined && parseCustomSize(options.pageSize)
            ? ['The orientation is ignored with a custom page size, which prints exactly as given.'] : [];
        const advisories = [...ignored, ...(result.advisories || [])];
        entry.pages = result.pages;
        entry.warnings = warnings.length + advisories.length;
        if (options.strict && warnings.length) {
            throw new ApiError(422, 'strict_warnings', 'The render produced warnings and strict is on.', {details: {warnings}});
        }
        res.writeHead(200, {
            'Content-Type': 'application/pdf',
            'Content-Length': result.pdf.length,
            'Content-Disposition': `attachment; filename="${safeFilename(result.title)}"`,
            'X-PrintMD-Pages': String(result.pages),
            // Every warning, blocking first; X-PrintMD-Advisories repeats the advisory ones on their own.
            'X-PrintMD-Warnings': warningsHeader([...warnings, ...advisories]),
            'X-PrintMD-Advisories': warningsHeader(advisories),
            // The body scale in % after the nearly-empty-last-page tidy (100: unchanged), or "off".
            'X-PrintMD-Tidy': result.tidy == null ? 'off' : String(result.tidy),
        });
        res.end(result.pdf);
        entry.bytesOut = result.pdf.length;
    }

    return (req, res) => {
        const entry = {id: randomUUID(), method: req.method, route: 'unknown', email: null, template: null,
            bytesIn: 0, bytesOut: 0, pages: null, warnings: 0, status: 0, ms: 0};
        const t0 = process.hrtime.bigint();
        res.setHeader('X-Request-Id', entry.id);
        res.setHeader('X-PrintMD-Version', version);
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('X-Content-Type-Options', 'nosniff');

        handle(req, res, entry)
            .catch((err) => {
                const status = errorStatus(err);
                entry.error = err instanceof ApiError ? err.code : 'internal_error';
                if (res.headersSent) {
                    res.destroy();
                    return;
                }
                if (err instanceof ApiError) for (const [k, v] of Object.entries(err.headers)) res.setHeader(k, v);
                if (status === 413) res.setHeader('Connection', 'close');
                if (status === 405 && err.details && err.details.allow) res.setHeader('Allow', err.details.allow.join(', '));
                const body = errorBody(err);
                if (body.error.allow) delete body.error.allow;
                if (req.bdDropConnection) {
                    // A dropped slow body: answer, then close the socket so the client cannot keep trickling.
                    res.setHeader('Connection', 'close');
                    res.on('finish', () => req.socket.destroy());
                }
                sendJson(res, status === 499 ? 400 : status, body);
            })
            .finally(() => {
                entry.status = res.statusCode;
                entry.ms = Number((process.hrtime.bigint() - t0) / 1_000_000n);
                try {
                    log(entry);
                } catch { /* a broken log stream must not break the API */ }
            });
    };
}

function methodNotAllowed(route) {
    return new ApiError(405, 'method_not_allowed', `Use ${route.methods.join(' or ')}.`, {details: {allow: route.methods}});
}

function sendJson(res, status, body) {
    const text = JSON.stringify(body);
    res.writeHead(status, {'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(text)});
    res.end(text);
}

/**
 * Start listening. Resolves once the port is bound.
 * @returns {Promise<{server: import('node:http').Server, url: string, port: number, close: () => Promise<void>}>}
 */
export async function startServer({config, ...deps}) {
    const server = createServer({
        // Header and request timeouts are enforced on this interval (Node's default, 30 s, lets
        // slow-header sockets hold connections far past the timeout).
        connectionsCheckingInterval: 1_000,
        headersTimeout: deps.headersTimeoutMs ?? HEADERS_TIMEOUT_MS,
        requestTimeout: 60_000, // the whole request; the body has its own, shorter deadline (readBody)
        keepAliveTimeout: 5_000,
    }, createHandler({config, ...deps}));
    server.maxConnections = deps.maxConnections ?? MAX_CONNECTIONS;
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(config.port, config.host, resolve);
    });
    const {port} = server.address();
    const host = config.host.includes(':') ? `[${config.host}]` : config.host;
    return {
        server,
        port,
        url: `http://${host}:${port}`,
        close: () => new Promise((resolve) => {
            server.close(() => resolve());
            server.closeAllConnections?.();
        }),
    };
}
