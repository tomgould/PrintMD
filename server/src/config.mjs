/**
 * Configuration from the environment and the command line.
 *
 *   --local                        local mode with the API switched on (npm run start:local)
 *   PRINTMD_AUTH=local|token|access   the auth provider (src/auth.mjs). Default: local
 *                                  with --local, access otherwise
 *     local                        no authentication, loopback only
 *     token                        a shared secret for self-hosting: PRINTMD_API_TOKEN, at
 *                                  least MIN_TOKEN_LENGTH printable characters with
 *                                  MIN_TOKEN_DISTINCT different ones (openssl rand -hex 32),
 *                                  sent as Authorization: Bearer <token>
 *     access                       a login proxy's signed JWT (src/auth-access.mjs)
 *   PRINTMD_MODE=local|access   the older name for PRINTMD_AUTH, still accepted
 *   PRINTMD_API_ENABLED=1       switch the API on (default off: 503 api_disabled)
 *   PRINTMD_HOST, PRINTMD_PORT   bind address (default 127.0.0.1:8787)
 *   PRINTMD_CHROME              Chrome or Chromium binary (default: Playwright's Chromium)
 *   PRINTMD_BROWSER_IDLE_S      close the browser after this many seconds without a render (default 0: keep it open);
 *                                  the next render starts it again, so a desktop service holds no browser while idle
 *   PRINTMD_ACCESS_TEAM_DOMAIN  access mode: the login's team domain, e.g. team.example.com
 *   PRINTMD_ACCESS_AUD          access mode: the application's audience (AUD) tag
 *   PRINTMD_ALLOWED_EMAIL_DOMAINS   access mode: optional comma list, a second check after the login
 *   PRINTMD_ALLOWED_HOSTS       optional comma list of host names the Host header may carry (deployed mode)
 *   PRINTMD_MAX_EXPANDED_BYTES  ceiling for a document's expanded size, every image reference counted (default 40 MB)
 *   PRINTMD_VERSION             version reported in X-PrintMD-Version (default: git short sha)
 *
 * Test only, refused unless NODE_ENV=test:
 *   PRINTMD_TEST_AUTH_BYPASS=1  skip authentication (integration tests)
 *   PRINTMD_ACCESS_CERTS_URL    fetch the login's keys from a local JWKS server
 *
 * Authentication is off in local mode and with the test bypass; then the
 * process refuses to start on anything but a loopback address. Host names,
 * team domains and audience tags come only from here: nothing in src/ names one.
 *
 * A caller may pass an edition with allowHostedApi: false, which refuses every
 * hosted setting (token, access, deployed host rules) and runs on a loopback
 * address only. main.mjs passes src/edition.mjs's EDITION, the one place a build
 * pins that. With no edition given every mode is allowed, so tests and tools see
 * the full set.
 *
 * The API token is never kept: the configuration holds its SHA-256 digest, as a
 * property that JSON, spreads and Object.keys do not show, and no message here
 * ever quotes it.
 */
import {createHash} from 'node:crypto';
import {isIP} from 'node:net';

export class ConfigError extends Error {
    constructor(message) {
        super(message);
        this.name = 'ConfigError';
    }
}

const TRUE = new Set(['1', 'true', 'yes', 'on']);
const HOSTNAME_RE = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;

/** True for 127.0.0.0/8, ::1 and "localhost". */
export function isLoopbackHost(host) {
    const h = String(host || '').replace(/^\[|\]$/g, '').toLowerCase();
    if (h === 'localhost' || h === '::1') return true;
    return isIP(h) === 4 && h.startsWith('127.');
}

export const AUTH_MODES = Object.freeze(['local', 'token', 'access']);
/** The shortest PRINTMD_API_TOKEN accepted, and the fewest different characters in it (a cheap entropy floor). */
export const MIN_TOKEN_LENGTH = 24;
export const MIN_TOKEN_DISTINCT = 12;
const TOKEN_RE = /^[\x21-\x7e]+$/;

/** SHA-256 of a token, the form the token provider compares (src/auth.mjs). */
export function tokenDigest(value) {
    return createHash('sha256').update(String(value), 'utf8').digest();
}

function authMode(env, argv) {
    const local = argv.includes('--local') || env.PRINTMD_MODE === 'local';
    if (env.PRINTMD_MODE && !['local', 'access'].includes(env.PRINTMD_MODE)) {
        throw new ConfigError('PRINTMD_MODE must be "local" or "access" (PRINTMD_AUTH also offers "token").');
    }
    const chosen = env.PRINTMD_AUTH || '';
    if (chosen && !AUTH_MODES.includes(chosen)) throw new ConfigError('PRINTMD_AUTH must be "local", "token" or "access".');
    if (!chosen) return local ? 'local' : 'access';
    if ((local && chosen !== 'local') || (env.PRINTMD_MODE === 'access' && chosen !== 'access')) {
        throw new ConfigError(`PRINTMD_AUTH=${chosen} and ${argv.includes('--local') ? '--local' : `PRINTMD_MODE=${env.PRINTMD_MODE}`} disagree: use one.`);
    }
    return chosen;
}

function apiToken(value) {
    const make = 'Make one with: openssl rand -hex 32';
    if (typeof value !== 'string' || value.length < MIN_TOKEN_LENGTH) {
        throw new ConfigError(`Refusing to start: PRINTMD_AUTH=token needs PRINTMD_API_TOKEN of at least ${MIN_TOKEN_LENGTH} characters. ${make}`);
    }
    if (!TOKEN_RE.test(value)) {
        throw new ConfigError('Refusing to start: PRINTMD_API_TOKEN must be printable ASCII with no spaces, as it travels in an HTTP header. '
            + make);
    }
    if (new Set(value).size < MIN_TOKEN_DISTINCT) {
        throw new ConfigError(`Refusing to start: PRINTMD_API_TOKEN repeats too few characters to be hard to guess `
            + `(it needs at least ${MIN_TOKEN_DISTINCT} different ones). ${make}`);
    }
    return Object.freeze({digest: tokenDigest(value)});
}

/** Default ceiling for a document's expanded size (every data URI reference counted in full). */
export const MAX_EXPANDED_BYTES = 40 * 1024 * 1024;

function expandedBytes(value) {
    if (value === undefined || value === '') return MAX_EXPANDED_BYTES;
    if (!/^\d{1,12}$/.test(value) || Number(value) < 1) {
        throw new ConfigError('PRINTMD_MAX_EXPANDED_BYTES must be a number of bytes, such as 41943040.');
    }
    return Number(value);
}

/** Seconds without a render before the browser closes, as milliseconds; 0 (the default) keeps it open. */
function browserIdleMs(value) {
    if (value === undefined || value === '') return 0;
    if (!/^\d{1,5}$/.test(value) || Number(value) > 86_400) {
        throw new ConfigError('PRINTMD_BROWSER_IDLE_S must be a whole number of seconds from 0 to 86400, such as 60.');
    }
    return Number(value) * 1000;
}

function port(value) {
    if (value === undefined || value === '') return 8787;
    if (!/^\d{1,5}$/.test(value) || Number(value) > 65535) throw new ConfigError('PRINTMD_PORT must be a port number (0 to 65535).');
    return Number(value);
}

/** Variables that configure a hosted (network) deployment. */
const HOSTED_ENV_VARS = ['PRINTMD_API_TOKEN', 'PRINTMD_ACCESS_TEAM_DOMAIN', 'PRINTMD_ACCESS_AUD', 'PRINTMD_ALLOWED_HOSTS'];
const LOCAL_ONLY_MESSAGE = "This edition's PDF API runs only on your own computer (local mode on 127.0.0.1). Hosting it is not supported.";

/** An edition built with allowHostedApi: false refuses any hosted configuration. */
function refuseHosted(env) {
    const asks = [env.PRINTMD_AUTH, env.PRINTMD_MODE].filter((v) => v !== undefined && v !== '');
    const hostedVars = HOSTED_ENV_VARS.some((name) => env[name] !== undefined && env[name] !== '');
    if (asks.some((v) => ['token', 'access'].includes(v)) || hostedVars) {
        throw new ConfigError(LOCAL_ONLY_MESSAGE);
    }
}

/**
 * @param {{env?: Record<string, string|undefined>, argv?: string[], edition?: {allowHostedApi?: boolean}}} [input]
 * @returns {object} the configuration; throws ConfigError when it is unsafe or invalid
 */
export function loadConfig({env = process.env, argv = process.argv.slice(2), edition = {allowHostedApi: true}} = {}) {
    if (!edition.allowHostedApi) refuseHosted(env);
    let mode = authMode(env, argv);
    if (!edition.allowHostedApi && !env.PRINTMD_AUTH && !env.PRINTMD_MODE) mode = 'local';
    const local = mode === 'local';
    const isTest = env.NODE_ENV === 'test';
    const testAuthBypass = env.PRINTMD_TEST_AUTH_BYPASS !== undefined && env.PRINTMD_TEST_AUTH_BYPASS !== '';
    if (testAuthBypass && (!isTest || env.PRINTMD_TEST_AUTH_BYPASS !== '1')) {
        throw new ConfigError('PRINTMD_TEST_AUTH_BYPASS is for the test suite only and needs NODE_ENV=test.');
    }

    const host = env.PRINTMD_HOST || '127.0.0.1';
    if ((local || testAuthBypass) && !isLoopbackHost(host)) {
        throw new ConfigError(`Refusing to start: authentication is off (${local ? 'local mode' : 'test bypass'}), `
            + 'so the server only binds a loopback address such as 127.0.0.1.');
    }
    const token = mode === 'token' ? apiToken(env.PRINTMD_API_TOKEN) : null;

    const teamDomain = (env.PRINTMD_ACCESS_TEAM_DOMAIN || '').trim().toLowerCase();
    if (teamDomain && !HOSTNAME_RE.test(teamDomain)) {
        throw new ConfigError('PRINTMD_ACCESS_TEAM_DOMAIN must be a host name such as team.example.com (no https://, no path).');
    }
    if (env.PRINTMD_ACCESS_CERTS_URL && !isTest) {
        throw new ConfigError('PRINTMD_ACCESS_CERTS_URL is for the test suite only and needs NODE_ENV=test.');
    }
    // Empty: the access provider derives the keys URL from the team domain.
    const certsUrl = env.PRINTMD_ACCESS_CERTS_URL || '';

    const config = {
        mode,
        apiEnabled: argv.includes('--local') || !edition.allowHostedApi || TRUE.has(String(env.PRINTMD_API_ENABLED || '').toLowerCase()),
        host,
        port: port(env.PRINTMD_PORT),
        testAuthBypass,
        chrome: env.PRINTMD_CHROME || '',
        browserIdleMs: browserIdleMs(env.PRINTMD_BROWSER_IDLE_S),
        maxExpandedBytes: expandedBytes(env.PRINTMD_MAX_EXPANDED_BYTES),
        /** Deployed mode: host names the Host header may carry (empty: no rule). Local mode always allows loopback only. */
        allowedHosts: String(env.PRINTMD_ALLOWED_HOSTS || '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean),
        version: env.PRINTMD_VERSION || '',
        access: {
            teamDomain,
            aud: (env.PRINTMD_ACCESS_AUD || '').trim(),
            certsUrl,
            allowedEmailDomains: String(env.PRINTMD_ALLOWED_EMAIL_DOMAINS || '')
                .split(',').map((d) => d.trim().toLowerCase()).filter(Boolean),
        },
    };
    // Not enumerable: JSON, spreads and Object.keys leave it out, so a logged config never carries it.
    if (token) Object.defineProperty(config, 'token', {value: token, enumerable: false});
    return config;
}
