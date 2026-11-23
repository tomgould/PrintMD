/**
 * The edition switch (server/src/edition.mjs). loadConfig with no edition keeps every
 * mode, so the other server tests are untouched. An edition with allowHostedApi: false
 * (the public build changes the value in src/edition.mjs) refuses any hosted
 * configuration and runs only in local mode on a loopback address. main.mjs is what
 * hands the real edition to loadConfig, so one test checks that, and in a public build
 * another starts the server and watches it refuse.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {loadConfig, ConfigError} from '../server/src/config.mjs';
import {EDITION} from '../server/src/edition.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));

// 31 printable characters with 26 different ones, as any valid value must be.
const value = 'example-co-0123456789abcdefghij';
const PUBLIC = {allowHostedApi: false};
const LOCAL_ONLY = "This edition's PDF API runs only on your own computer (local mode on 127.0.0.1). Hosting it is not supported.";

function refused(env, argv, edition) {
    try {
        loadConfig({env, argv, edition});
        assert.fail('loadConfig should have refused');
    } catch (e) {
        assert.ok(e instanceof ConfigError, `ConfigError, got ${e}`);
        return e;
    }
}

test('no edition given: token mode with a valid token and local mode both work', () => {
    const token = loadConfig({env: {PRINTMD_AUTH: 'token', PRINTMD_API_TOKEN: value}, argv: []});
    assert.equal(token.mode, 'token');
    const local = loadConfig({env: {}, argv: ['--local']});
    assert.equal(local.mode, 'local');
    assert.equal(local.host, '127.0.0.1');
});

test('public edition: local mode works, with --local, PRINTMD_AUTH=local, PRINTMD_MODE=local and with nothing set', () => {
    for (const [env, argv] of [
        [{}, ['--local']],
        [{PRINTMD_AUTH: 'local'}, []],
        [{PRINTMD_MODE: 'local'}, []],
        [{}, []],
    ]) {
        const c = loadConfig({env, argv, edition: PUBLIC});
        assert.equal(c.mode, 'local', JSON.stringify({env, argv}));
        assert.equal(c.host, '127.0.0.1', 'the default host is loopback');
        assert.equal(c.apiEnabled, true, 'a local-only edition has the API on, whichever way it is started');
    }
});

test('public edition: 127.0.0.1 and ::1 are accepted hosts', () => {
    assert.equal(loadConfig({env: {PRINTMD_HOST: '127.0.0.1'}, argv: ['--local'], edition: PUBLIC}).host, '127.0.0.1');
    assert.equal(loadConfig({env: {PRINTMD_HOST: '::1'}, argv: ['--local'], edition: PUBLIC}).host, '::1');
});

test('public edition: hosted authentication is refused with the edition message', () => {
    for (const env of [
        {PRINTMD_AUTH: 'token', PRINTMD_API_TOKEN: value},
        {PRINTMD_AUTH: 'token'},
        {PRINTMD_AUTH: 'access'},
        {PRINTMD_MODE: 'access'},
        {PRINTMD_AUTH: 'local', PRINTMD_MODE: 'access'},
    ]) {
        assert.equal(refused(env, [], PUBLIC).message, LOCAL_ONLY, JSON.stringify(env));
    }
});

test('public edition: a hosted setting is refused even beside local mode, with and without --local', () => {
    for (const [name, setting] of [
        ['PRINTMD_API_TOKEN', value],
        ['PRINTMD_ACCESS_TEAM_DOMAIN', 'team.example.com'],
        ['PRINTMD_ACCESS_AUD', 'aud123'],
        ['PRINTMD_ALLOWED_HOSTS', 'docs.example.com'],
    ]) {
        for (const argv of [[], ['--local']]) {
            assert.equal(refused({PRINTMD_AUTH: 'local', [name]: setting}, argv, PUBLIC).message, LOCAL_ONLY,
                `${name} with ${JSON.stringify(argv)}`);
        }
    }
});

test('public edition: a non-loopback host is refused even with --local', () => {
    const e = refused({PRINTMD_HOST: '0.0.0.0'}, ['--local'], PUBLIC);
    assert.match(e.message, /loopback/, 'the existing local-mode refusal');
    for (const host of ['::', '192.168.1.10', 'example.com']) {
        refused({PRINTMD_HOST: host}, ['--local'], PUBLIC);
    }
});

test('the PDF API switch allows hosting in the private repository and forbids it in the public build', () => {
    assert.equal(EDITION.allowHostedApi, existsSync(`${root}deploy/public-edition.json`));
});

test('main.mjs hands the edition to loadConfig', () => {
    const main = readFileSync(`${root}server/src/main.mjs`, 'utf8');
    assert.match(main, /import \{EDITION\} from '\.\/edition\.mjs';/);
    assert.match(main, /loadConfig\(\{edition: EDITION\}\)/);
});

// Only meaningful in a public build, where src/edition.mjs says allowHostedApi: false, and only where the
// server's packages are installed (main.mjs imports the browser package before it reads the configuration).
const serverInstalled = existsSync(`${root}server/node_modules/playwright`);
test('a public build starts the real server and it refuses hosted settings',
    {skip: EDITION.allowHostedApi || !serverInstalled}, () => {
    const run = spawnSync(process.execPath, ['server/src/main.mjs'], {
        cwd: root, encoding: 'utf8', timeout: 30_000,
        env: {PATH: process.env.PATH, PRINTMD_AUTH: 'token', PRINTMD_API_TOKEN: value},
    });
    assert.equal(run.status, 2, run.stderr);
    assert.match(run.stderr, /runs only on your own computer/);
    assert.ok(!run.stderr.includes(value), 'the refusal never quotes the token');
});
