/**
 * tests/lib/static-server.mjs
 *
 * Minimal zero-dependency static file server for the browser tests.
 * Binds 127.0.0.1 on a random free port; never serves outside `root`.
 */
import {createServer} from 'node:http';
import {readFile, stat} from 'node:fs/promises';
import {extname, join, normalize, resolve, sep} from 'node:path';

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.md': 'text/markdown; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.woff2': 'font/woff2',
    '.woff': 'font/woff',
    '.ttf': 'font/ttf',
    '.wasm': 'application/wasm',
    '.pdf': 'application/pdf',
    '.epub': 'application/epub+zip',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

/**
 * @param {string} root absolute directory to serve
 * @returns {Promise<{port: number, origin: string, close: () => Promise<void>}>}
 */
const SLOW_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

export async function startStaticServer(root) {
    const base = resolve(root);

    const server = createServer(async (req, res) => {
        try {
            const url = new URL(req.url, 'http://127.0.0.1');
            // Test helper: /__slow/<ms>.png answers with a 1x1 PNG after <ms> (max 10s).
            const slow = /^\/__slow\/(\d{1,5})\.png$/.exec(url.pathname);
            if (slow) {
                await new Promise((ok) => setTimeout(ok, Math.min(Number(slow[1]), 10000)));
                res.writeHead(200, {'content-type': 'image/png', 'content-length': SLOW_PNG.length, 'cache-control': 'no-store'});
                res.end(req.method === 'HEAD' ? undefined : SLOW_PNG);
                return;
            }
            // Test helper: a path with a __hang__ folder is never answered (a server that hangs);
            // close() ends the connection. Used by tests/template-layers.test.html.
            if (url.pathname.split('/').includes('__hang__')) return;
            let rel = decodeURIComponent(url.pathname);
            if (rel.includes('\0')) throw Object.assign(new Error('bad path'), {status: 400});
            // Test helper: /templates/__fixtures__/<rest> is tests/fixtures/<rest>, so a test can register a
            // test-only template (tests/fixtures/platform-fixture) at a path the template registry accepts.
            if (rel.startsWith('/templates/__fixtures__/')) rel = `/tests/fixtures/${rel.slice('/templates/__fixtures__/'.length)}`;
            if (rel.endsWith('/')) rel += 'index.html';

            const file = normalize(join(base, rel));
            if (file !== base && !file.startsWith(base + sep)) {
                throw Object.assign(new Error('forbidden'), {status: 403});
            }
            const info = await stat(file);
            if (!info.isFile()) throw Object.assign(new Error('not a file'), {status: 404});

            const body = await readFile(file);
            res.writeHead(200, {
                'content-type': MIME[extname(file).toLowerCase()] || 'application/octet-stream',
                'content-length': body.length,
                'cache-control': 'no-store',
            });
            res.end(req.method === 'HEAD' ? undefined : body);
        } catch (e) {
            const status = e.status || (e.code === 'ENOENT' || e.code === 'ENOTDIR' ? 404 : 500);
            res.writeHead(status, {'content-type': 'text/plain; charset=utf-8'});
            res.end(`${status}\n`);
        }
    });

    await new Promise((ok, fail) => {
        server.once('error', fail);
        server.listen(0, '127.0.0.1', ok);
    });
    const {port} = server.address();

    return {
        port,
        origin: `http://127.0.0.1:${port}`,
        close: () => new Promise((ok) => {
            server.close(() => ok());
            server.closeAllConnections?.();
        }),
    };
}
