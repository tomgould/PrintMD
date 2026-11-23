/**
 * The render origin and the asset allow-list.
 *
 * Inside Chromium the shared app modules load from https://render.invalid/,
 * an origin that cannot exist (".invalid" is reserved). Every request the
 * browser makes is intercepted; only files under js/, templates/, vendor/ and
 * assets/ of the repository are answered, after the checks below. Everything
 * else is aborted.
 */
import {realpath, stat} from 'node:fs/promises';
import {extname, join, sep} from 'node:path';
import {REPO_ROOT} from './paths.mjs';

export const RENDER_HOST = 'render.invalid';
export const RENDER_ORIGIN = `https://${RENDER_HOST}`;

/** Top-level repository folders the browser may read. */
export const ASSET_DIRS = Object.freeze(['js', 'templates', 'vendor', 'assets']);

/** File types served, and their content types. Anything else is refused. */
export const ASSET_TYPES = Object.freeze({
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.woff2': 'font/woff2',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.json': 'application/json; charset=utf-8',
});

/** The only JSON files served: the template manifests (js/template-registry.js). */
const JSON_PATH_RE = /^\/templates\/manifest\.[a-z0-9-]{1,32}\.json$/;

// Encoded dots, slashes and backslashes, NUL, and backslashes: never needed by
// the app's own URLs, so any of them means the URL is refused outright.
const SUSPICIOUS_RE = /%2e|%2f|%5c|%00|\\|\0/i;

function inside(parent, child) {
    return child.startsWith(parent + sep);
}

/**
 * The file on disk for an intercepted URL, or null when it is not allowed.
 * @param {string} rawUrl  the URL exactly as the browser requested it
 * @param {string} [root]  repository root (tests pass a temporary folder)
 * @returns {Promise<string|null>}
 */
export async function resolveAssetPath(rawUrl, root = REPO_ROOT) {
    const raw = String(rawUrl);
    if (!raw.startsWith(`${RENDER_ORIGIN}/`) || SUSPICIOUS_RE.test(raw)) return null;
    // The raw path must not hold "." or ".." segments: URL parsing would quietly
    // resolve them, and a request that needs them is not one the app makes.
    const rawPath = raw.slice(RENDER_ORIGIN.length).split(/[?#]/)[0];
    if (rawPath.split('/').some((seg) => seg === '.' || seg === '..')) return null;

    let url;
    try {
        url = new URL(raw);
    } catch {
        return null;
    }
    if (url.origin !== RENDER_ORIGIN || url.username || url.password || url.port) return null;

    let path;
    try {
        path = decodeURIComponent(url.pathname);
    } catch {
        return null;
    }
    const segments = path.split('/').slice(1);
    if (segments.length < 2 || !ASSET_DIRS.includes(segments[0])) return null;
    if (segments.some((seg) => !seg || seg === '.' || seg === '..' || seg.startsWith('.'))) return null;
    if (!ASSET_TYPES[extname(path).toLowerCase()]) return null;
    if (extname(path).toLowerCase() === '.json' && !JSON_PATH_RE.test(path)) return null;

    const dir = join(root, segments[0]);
    const file = join(root, ...segments);
    if (!inside(dir, file)) return null;
    try {
        // Symlinks are followed and the real path must still be inside the real folder.
        const [realDir, realFile] = await Promise.all([realpath(dir), realpath(file)]);
        if (!inside(realDir, realFile)) return null;
        if (!(await stat(realFile)).isFile()) return null;
    } catch {
        return null;
    }
    return file;
}

export function assetContentType(file) {
    return ASSET_TYPES[extname(file).toLowerCase()];
}

/**
 * The host part of a blocked URL for a warning: host only, never the path or
 * query. Non-network schemes are named by scheme ("file:").
 */
export function blockedLabel(rawUrl) {
    try {
        const u = new URL(rawUrl);
        if (u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'ws:' || u.protocol === 'wss:' || u.protocol === 'ftp:') {
            return u.host || u.protocol;
        }
        return u.protocol;
    } catch {
        return 'an unreadable address';
    }
}
