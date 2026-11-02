/**
 * Wiring: configuration in, a running server out. Used by main.mjs and the tests.
 */
import {execFileSync} from 'node:child_process';
import {startServer} from './app.mjs';
import {createAuthenticator} from './auth.mjs';
import {BrowserPool, findChrome} from './browser.mjs';
import {Limiter} from './limiter.mjs';
import {createRenderer, RENDER_TIMEOUT_MS} from './renderer.mjs';
import {REPO_ROOT} from './paths.mjs';
import {TEMPLATE_WARNINGS} from './templates-info.mjs';

/** X-PrintMD-Version: PRINTMD_VERSION, else the git short sha, else "dev". */
export function detectVersion(configured = '') {
    if (configured) return configured;
    try {
        return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000})
            .toString().trim() || 'dev';
    } catch {
        return 'dev';
    }
}

/** One JSON line per entry on a stream. */
export function jsonLineLogger(stream = process.stdout) {
    return (entry) => stream.write(`${JSON.stringify({ts: new Date().toISOString(), ...entry})}\n`);
}

/**
 * @param {object} config  from loadConfig()
 * @param {{log?: Function, limits?: {timeoutMs?: number, maxActive?: number, maxQueue?: number, maxRenders?: number,
 *          maxBodies?: number, maxConnections?: number, headersTimeoutMs?: number, bodyDeadlineMs?: number,
 *          bodyRateGraceMs?: number},
 *          authOptions?: object, assetRoot?: string}} [opts]
 *        assetRoot: the folder js/, templates/, vendor/ and assets/ are served from (tests use a copy)
 */
export async function startApi(config, {log = jsonLineLogger(), limits = {}, authOptions, assetRoot} = {}) {
    // First, so an auth provider that cannot run stops the start before a browser is set up.
    const auth = await createAuthenticator(config, authOptions);
    const pool = new BrowserPool({executablePath: findChrome(config.chrome), maxRenders: limits.maxRenders ?? 200,
        idleCloseMs: config.browserIdleMs ?? 0});
    const renderer = createRenderer({pool, timeoutMs: limits.timeoutMs ?? RENDER_TIMEOUT_MS, maxExpandedBytes: config.maxExpandedBytes,
        ...(assetRoot ? {assetRoot} : {})});
    const limiter = new Limiter({maxActive: limits.maxActive ?? 2, maxQueue: limits.maxQueue ?? 6});
    const version = detectVersion(config.version);
    // A broken template layer was skipped (js/template-registry.js): say so once, then serve the rest.
    if (TEMPLATE_WARNINGS.length) log({event: 'template_warnings', level: 'warning', warnings: [...TEMPLATE_WARNINGS]});
    const running = await startServer({config, auth, renderer, limiter, pool, log, version,
        maxBodies: limits.maxBodies, maxConnections: limits.maxConnections, headersTimeoutMs: limits.headersTimeoutMs,
        bodyDeadlineMs: limits.bodyDeadlineMs, bodyRateGraceMs: limits.bodyRateGraceMs});
    return {
        ...running,
        pool,
        limiter,
        version,
        close: async () => {
            await running.close();
            await pool.close();
        },
    };
}
