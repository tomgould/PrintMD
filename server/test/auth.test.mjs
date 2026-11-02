/**
 * The auth providers (src/auth.mjs) and how the mode is chosen (src/config.mjs):
 * local, the shared token for self-hosting, and the access login, which is
 * loaded only when chosen and fails closed when it cannot be loaded. The access
 * provider's own checks are in auth-access.test.mjs (company layer).
 */
import {test, mock} from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {spawn, spawnSync} from 'node:child_process';
import {existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL, fileURLToPath} from 'node:url';
import {createAuthenticator, TOKEN_FAILURE_DELAY_MS} from '../src/auth.mjs';
import {loadConfig, ConfigError, MIN_TOKEN_LENGTH, MIN_TOKEN_DISTINCT} from '../src/config.mjs';

const SECRET = 'example-co-token-0123456789abcdef';
const tokenConfig = (env = {}) => loadConfig({env: {PRINTMD_AUTH: 'token', PRINTMD_API_TOKEN: SECRET, ...env}, argv: []});
const bearer = (value) => ({authorization: value});

async function refused(auth, headers, rawHeaders) {
    await assert.rejects(auth.authenticate(headers, rawHeaders), (e) => {
        assert.equal(e.status, 401);
        assert.equal(e.code, 'unauthorized', 'one code for every failure: no detail');
        assert.equal(e.headers['WWW-Authenticate'], 'Bearer');
        assert.ok(!e.message.includes(SECRET));
        return true;
    });
}

test('local mode and the test bypass skip the token', async () => {
    assert.deepEqual(await (await createAuthenticator(loadConfig({env: {}, argv: ['--local']}))).authenticate({}),
        {email: 'local@localhost', mode: 'local'});
    assert.deepEqual(await (await createAuthenticator(loadConfig({env: {PRINTMD_AUTH: 'local'}, argv: []}))).authenticate({}),
        {email: 'local@localhost', mode: 'local'});
    assert.deepEqual(await (await createAuthenticator(loadConfig({env: {NODE_ENV: 'test', PRINTMD_TEST_AUTH_BYPASS: '1'}, argv: []}))).authenticate({}),
        {email: 'test@localhost', mode: 'test'});
});

test('mode: PRINTMD_AUTH picks it; the defaults are unchanged (local with --local, access otherwise)', () => {
    assert.equal(loadConfig({env: {}, argv: ['--local']}).mode, 'local');
    assert.equal(loadConfig({env: {PRINTMD_MODE: 'local'}, argv: []}).mode, 'local');
    assert.equal(loadConfig({env: {}, argv: []}).mode, 'access');
    assert.equal(loadConfig({env: {PRINTMD_MODE: 'access'}, argv: []}).mode, 'access');
    assert.equal(loadConfig({env: {PRINTMD_AUTH: 'access'}, argv: []}).mode, 'access');
    assert.equal(tokenConfig().mode, 'token');
    for (const env of [{PRINTMD_AUTH: 'none'}, {PRINTMD_AUTH: 'Token'}, {PRINTMD_MODE: 'token'}]) {
        assert.throws(() => loadConfig({env, argv: []}), ConfigError, JSON.stringify(env));
    }
    assert.throws(() => loadConfig({env: {PRINTMD_AUTH: 'token', PRINTMD_API_TOKEN: SECRET}, argv: ['--local']}), /disagree/);
    assert.throws(() => loadConfig({env: {PRINTMD_AUTH: 'access', PRINTMD_MODE: 'local'}, argv: []}), /disagree/);
    assert.throws(() => loadConfig({env: {PRINTMD_AUTH: 'local', PRINTMD_MODE: 'access'}, argv: []}), /disagree/);
});

test('token mode: a short, missing, unprintable or low-entropy token refuses to start, without echoing it', () => {
    assert.equal(MIN_TOKEN_LENGTH, 24);
    assert.equal(MIN_TOKEN_DISTINCT, 12);
    const short = 'abcdefghijklmnopqrstuvw';   // 23 characters, all distinct
    for (const value of [undefined, '', short, `${'0123456789abcdef'.repeat(2)} z`, `${'é'.repeat(30)}`,
        'x'.repeat(64), 'ab'.repeat(20), 'abcdefghijk'.repeat(4)]) {
        assert.throws(() => tokenConfig({PRINTMD_API_TOKEN: value}), (e) => {
            assert.ok(e instanceof ConfigError);
            assert.match(e.message, /PRINTMD_API_TOKEN/);
            assert.match(e.message, /openssl rand -hex 32/, 'says how to make a good one');
            if (value) assert.ok(!e.message.includes(value), 'the message never holds the token');
            return true;
        }, String(value).slice(0, 12));
    }
    assert.equal(tokenConfig({PRINTMD_API_TOKEN: 'abcdefghijkl'.repeat(2)}).mode, 'token', '24 characters, 12 distinct');
    assert.equal(tokenConfig({PRINTMD_API_TOKEN: crypto.randomBytes(32).toString('hex')}).mode, 'token', 'openssl rand -hex 32');
});

test('token mode: every failure waits the same fixed delay before the 401; a success does not wait', async () => {
    assert.equal(TOKEN_FAILURE_DELAY_MS, 250);
    const delay = mock.fn(async () => {});
    const auth = await createAuthenticator(tokenConfig(), {delay});
    await auth.authenticate(bearer(`Bearer ${SECRET}`));
    assert.equal(delay.mock.callCount(), 0, 'no wait on success');
    for (const headers of [{}, bearer('Bearer wrong'), bearer('Basic x'), bearer([`Bearer ${SECRET}`, `Bearer ${SECRET}`])]) {
        await refused(auth, headers);
    }
    assert.equal(delay.mock.callCount(), 4);
    assert.deepEqual(delay.mock.calls.map((c) => c.arguments[0]), [250, 250, 250, 250]);
});

test('token mode: more than one Authorization header is refused like any other failure', async () => {
    const auth = await createAuthenticator(tokenConfig(), {delay: async () => {}});
    await refused(auth, bearer([`Bearer ${SECRET}`, 'Bearer other']));
    await refused(auth, bearer([`Bearer ${SECRET}`, `Bearer ${SECRET}`]));
    // Node keeps only the first repeated Authorization in req.headers, so the raw headers are counted too.
    await refused(auth, bearer(`Bearer ${SECRET}`), ['Authorization', `Bearer ${SECRET}`, 'authorization', 'Bearer other']);
    assert.deepEqual(await auth.authenticate(bearer(`Bearer ${SECRET}`), ['Host', 'x', 'Authorization', `Bearer ${SECRET}`]),
        {email: 'token@localhost', mode: 'token'});
});

test('token mode: deployed, so it may bind any address; the token stays out of the config\'s visible fields', () => {
    const c = tokenConfig({PRINTMD_HOST: '0.0.0.0'});
    assert.equal(c.host, '0.0.0.0');
    assert.ok(!JSON.stringify(c).includes(SECRET));
    assert.ok(!Object.values(c).some((v) => typeof v === 'string' && v.includes(SECRET)));
    assert.ok(!('token' in {...c}), 'not copied by a spread or listed by Object.keys');
    // Only token mode reads the token.
    assert.equal(loadConfig({env: {PRINTMD_API_TOKEN: 'short'}, argv: ['--local']}).mode, 'local');
});

test('token mode: the right token passes; wrong, missing or malformed ones are the same 401', async () => {
    const auth = await createAuthenticator(tokenConfig(), {delay: async () => {}});
    assert.deepEqual(await auth.authenticate(bearer(`Bearer ${SECRET}`)), {email: 'token@localhost', mode: 'token'});
    assert.deepEqual(await auth.authenticate(bearer(`bearer ${SECRET}`)), {email: 'token@localhost', mode: 'token'}, 'the scheme ignores case');
    assert.deepEqual(await auth.authenticate(bearer(`Bearer   ${SECRET}  `)), {email: 'token@localhost', mode: 'token'}, 'extra spaces');
    assert.deepEqual(await auth.authenticate(bearer([`Bearer ${SECRET}`])), {email: 'token@localhost', mode: 'token'}, 'one, as a list');
    for (const value of [undefined, '', 'Bearer', 'Bearer ', SECRET, `Basic ${SECRET}`, `Token ${SECRET}`, `Bearer ${SECRET}x`,
        `Bearer ${SECRET.slice(0, -1)}`, `Bearer ${SECRET} ${SECRET}`, `Bearer ${SECRET.toUpperCase()}`, `Bearer\t${SECRET}`,
        `Bearer ${'a'.repeat(5000)}`, ['Bearer wrong', `Bearer ${SECRET}`]]) {
        await refused(auth, bearer(value));
    }
    await refused(auth, {});
    await refused(auth, {'x-api-token': SECRET});
});

test('token mode: the comparison is crypto.timingSafeEqual over two equal-length digests, on every path', async () => {
    const spy = mock.method(crypto, 'timingSafeEqual');
    try {
        const auth = await createAuthenticator(tokenConfig(), {delay: async () => {}});
        await auth.authenticate(bearer(`Bearer ${SECRET}`));
        await refused(auth, bearer('Bearer wrong'));
        await refused(auth, bearer(`Bearer ${'a'.repeat(5000)}`));
        await refused(auth, {});
        assert.equal(spy.mock.callCount(), 4, 'missing and malformed headers take the same path');
        for (const call of spy.mock.calls) {
            const [a, b] = call.arguments;
            assert.equal(a.length, 32);
            assert.equal(b.length, 32);
        }
    } finally {
        spy.mock.restore();
    }
});

test('token mode: without a digest in the config the provider refuses to start', async () => {
    const c = loadConfig({env: {}, argv: []});
    await assert.rejects(createAuthenticator({...c, mode: 'token'}), ConfigError);
});

test('local and token modes never load the access provider', async () => {
    const loadAccess = mock.fn(async () => ({createAccessAuthenticator: () => ({authenticate: async () => ({})})}));
    await createAuthenticator(loadConfig({env: {}, argv: ['--local']}), {loadAccess});
    await createAuthenticator(tokenConfig(), {loadAccess});
    assert.equal(loadAccess.mock.callCount(), 0);
    await createAuthenticator(loadConfig({env: {}, argv: []}), {loadAccess});
    assert.equal(loadAccess.mock.callCount(), 1, 'access mode loads it');
});

test('access mode fails closed when the provider or jose cannot be loaded', async () => {
    const missingJose = async () => {
        throw Object.assign(new Error("Cannot find package 'jose'"), {code: 'ERR_MODULE_NOT_FOUND'});
    };
    for (const loadAccess of [missingJose, () => import('./no-such-provider.mjs')]) {
        await assert.rejects(createAuthenticator(loadConfig({env: {}, argv: []}), {loadAccess}), (e) => {
            assert.ok(e instanceof ConfigError);
            assert.match(e.message, /PRINTMD_AUTH=access/);
            assert.match(e.message, /jose/);
            return true;
        });
    }
});

test('access mode without jose: the server refuses to start, with a clear message', async () => {
    // A resolve hook that makes the jose package unfindable, as in a build without it.
    const dir = mkdtempSync(join(tmpdir(), 'bd-nojose-'));
    try {
        writeFileSync(join(dir, 'hooks.mjs'), `export async function resolve(specifier, context, next) {
    if (specifier === 'jose') throw Object.assign(new Error("Cannot find package 'jose'"), {code: 'ERR_MODULE_NOT_FOUND'});
    return next(specifier, context);
}\n`);
        writeFileSync(join(dir, 'register.mjs'), `import {register} from 'node:module';\nregister(${JSON.stringify(pathToFileURL(join(dir, 'hooks.mjs')).href)});\n`);
        const main = fileURLToPath(new URL('../src/main.mjs', import.meta.url));
        const child = spawn(process.execPath, ['--import', pathToFileURL(join(dir, 'register.mjs')).href, main], {
            env: {PATH: process.env.PATH, PRINTMD_AUTH: 'access', PRINTMD_PORT: '0', PRINTMD_CHROME: process.env.PRINTMD_CHROME || ''},
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let out = '', err = '';
        child.stdout.on('data', (d) => {
            out += d;
            // Started after all: stop it, so the test fails instead of waiting on a running server.
            if (out.includes('listening')) child.kill('SIGKILL');
        });
        child.stderr.on('data', (d) => { err += d; });
        const code = await new Promise((ok) => child.once('exit', ok));
        assert.equal(code, 2, `exit code (stderr: ${err})`);
        assert.match(err, /PRINTMD_AUTH=access/);
        assert.match(err, /jose/);
        assert.ok(!out.includes('listening'), 'never listened');
    } finally {
        rmSync(dir, {recursive: true, force: true});
    }
});

test('token mode: the token is gone from the environment before the browser starts, so Chromium never has it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bd-token-env-'));
    let child;
    try {
        const seen = join(dir, 'seen');
        const browser = join(dir, 'browser');
        // A stand-in browser: it writes down whether it was given the token's variable (never its value), then fails to start.
        writeFileSync(browser, `#!/bin/sh\nif [ -n "\${PRINTMD_API_TOKEN+set}" ]; then echo present; else echo absent; fi > '${seen}'\nexit 1\n`,
            {mode: 0o755});
        spawnSync(browser, [], {env: {PRINTMD_API_TOKEN: SECRET}});
        assert.equal(readFileSync(seen, 'utf8').trim(), 'present', 'the stand-in sees the variable when it is there');
        rmSync(seen);

        const main = fileURLToPath(new URL('../src/main.mjs', import.meta.url));
        child = spawn(process.execPath, [main], {
            env: {PATH: process.env.PATH, HOME: process.env.HOME || '/tmp', PRINTMD_AUTH: 'token', PRINTMD_API_TOKEN: SECRET,
                PRINTMD_API_ENABLED: '1', PRINTMD_PORT: '0', PRINTMD_CHROME: browser},
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let out = '';
        const url = await new Promise((ok, fail) => {
            child.stdout.on('data', (d) => {
                out += d;
                const line = out.split('\n').find((l) => l.includes('"event":"listening"'));
                if (line) ok(JSON.parse(line).url);
            });
            child.once('exit', (code) => fail(new Error(`the server exited (${code})`)));
        });
        // The first render starts the browser; the stand-in fails it, which is all this needs.
        const res = await fetch(`${url}/api/v1/render`, {method: 'POST', body: '# Hello',
            headers: {authorization: `Bearer ${SECRET}`, 'content-type': 'text/markdown'}});
        await res.arrayBuffer();
        assert.notEqual(res.status, 401, 'the token was accepted, so the render reached the browser');
        assert.ok(existsSync(seen), 'the server started the stand-in browser');
        assert.equal(readFileSync(seen, 'utf8').trim(), 'absent', 'the browser process was not given PRINTMD_API_TOKEN');
    } finally {
        if (child && child.exitCode === null) {
            child.kill('SIGKILL');
            await new Promise((ok) => child.once('exit', ok));
        }
        rmSync(dir, {recursive: true, force: true});
    }
});
