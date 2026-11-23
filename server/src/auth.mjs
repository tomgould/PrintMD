/**
 * Who is calling: one provider per auth mode (PRINTMD_AUTH, src/config.mjs).
 * Every provider is {authenticate(headers, rawHeaders) => Promise<{email, mode}>}
 * (src/app.mjs passes req.headers and req.rawHeaders; the token provider counts
 * Authorization headers in rawHeaders, the others may ignore it), and any
 * failure is an ApiError 401.
 *
 *   local   nobody is asked (the server only binds loopback). Caller local@localhost.
 *   token   a shared secret for self-hosting, sent as Authorization: Bearer <token>.
 *           The presented token's SHA-256 is compared with the configured digest by
 *           crypto.timingSafeEqual (two 32-byte buffers, so the length never leaks),
 *           on every request, even one without the header. Every failure (a second
 *           Authorization header included) waits TOKEN_FAILURE_DELAY_MS, then is the
 *           same 401 with no detail. The token is never logged or echoed. Caller
 *           token@localhost.
 *   access  a login proxy's signed JWT, checked by src/auth-access.mjs. That file
 *           and its jose dependency are imported only in this mode, so a build
 *           without them works in the other modes; in this mode, if either cannot
 *           be loaded, the server refuses to start (ConfigError).
 *
 * Test bypass (NODE_ENV=test only): test@localhost.
 */
import crypto from 'node:crypto';
import {ApiError} from './errors.mjs';
import {ConfigError, tokenDigest} from './config.mjs';

const LOCAL = Object.freeze({email: 'local@localhost', mode: 'local'});
const TEST = Object.freeze({email: 'test@localhost', mode: 'test'});
const TOKEN = Object.freeze({email: 'token@localhost', mode: 'token'});

/** "Bearer" (any case), one or more spaces, a token of visible ASCII, optional trailing spaces. */
const BEARER_RE = /^Bearer +([\x21-\x7e]+) *$/i;
/** Every failed token check waits this long before its 401, so guessing is slow without a lockout. */
export const TOKEN_FAILURE_DELAY_MS = 250;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** How many Authorization headers the request carried (Node keeps only the first in `headers`). */
function authorizationCount(headers, rawHeaders) {
    if (Array.isArray(rawHeaders)) return rawHeaders.filter((h, i) => i % 2 === 0 && String(h).toLowerCase() === 'authorization').length;
    const v = headers.authorization;
    return v === undefined ? 0 : (Array.isArray(v) ? v.length : 1);
}

function tokenProvider(config, {delay = sleep} = {}) {
    const expected = config.token && config.token.digest;
    if (!Buffer.isBuffer(expected) || expected.length !== 32) {
        throw new ConfigError('PRINTMD_AUTH=token needs PRINTMD_API_TOKEN.');
    }
    const refuse = () => new ApiError(401, 'unauthorized', 'Send a valid API token as Authorization: Bearer <token>.',
        {headers: {'WWW-Authenticate': 'Bearer'}});
    return {
        async authenticate(headers, rawHeaders) {
            const raw = headers.authorization;
            const value = Array.isArray(raw) ? raw[0] : raw;
            // More than one Authorization header is refused, as app.mjs refuses repeated Host and Origin.
            const single = authorizationCount(headers, rawHeaders) <= 1;
            const match = single && typeof value === 'string' ? BEARER_RE.exec(value) : null;
            // Hash whatever came (or nothing), so every request takes the same path.
            const same = crypto.timingSafeEqual(tokenDigest(match ? match[1] : ''), expected);
            if (!match || !same) {
                await delay(TOKEN_FAILURE_DELAY_MS);
                throw refuse();
            }
            return {...TOKEN};
        },
    };
}

async function accessProvider(config, loadAccess, opts) {
    let mod;
    try {
        mod = await loadAccess();
    } catch (err) {
        throw new ConfigError('Refusing to start: PRINTMD_AUTH=access needs src/auth-access.mjs and the jose package, '
            + `and this build cannot load them (${(err && err.code) || 'load failed'}). Run npm ci in server/, `
            + 'or choose PRINTMD_AUTH=token or local.');
    }
    return mod.createAccessAuthenticator(config, opts);
}

/**
 * @param {object} config  from loadConfig()
 * @param {{loadAccess?: () => Promise<object>, delay?: (ms: number) => Promise<void>, cooldownMs?: number, cacheMaxAgeMs?: number}} [opts]
 *        loadAccess: how the access provider is imported, delay: the token provider's wait
 *        after a failure (tests replace both); the rest goes to the provider
 * @returns {Promise<{authenticate: (headers: Record<string, string|string[]|undefined>, rawHeaders?: string[])
 *          => Promise<{email: string, mode: string}>}>}
 *          rejects with ConfigError when the configured provider cannot run
 */
export async function createAuthenticator(config, {loadAccess = () => import('./auth-access.mjs'), ...opts} = {}) {
    if (config.testAuthBypass) return {authenticate: async () => ({...TEST})};
    if (config.mode === 'local') return {authenticate: async () => ({...LOCAL})};
    if (config.mode === 'token') return tokenProvider(config, opts);
    if (config.mode === 'access') return accessProvider(config, loadAccess, opts);
    throw new ConfigError('Unknown auth mode.');
}
