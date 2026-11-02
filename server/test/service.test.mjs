/**
 * server/service/install-service.sh: the systemd user service for the local PDF API. Everything here runs the
 * script with --dry-run or --unit-dir, so nothing is installed and systemd is never called.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const REPO = new URL('../..', import.meta.url).pathname.replace(/\/$/, '');
const SCRIPT = join(REPO, 'server/service/install-service.sh');
const NODE = process.execPath;

function run(args, {env = {}} = {}) {
    const r = spawnSync('bash', [SCRIPT, ...args], {encoding: 'utf8', env: {...process.env, ...env}});
    return {code: r.status, out: r.stdout, err: r.stderr};
}
const dry = (...args) => run(['--dry-run', '--node', NODE, '--chrome', 'playwright', ...args]);

test('the unit: this checkout, the chosen port, loopback only, a browser that closes when idle, restart on failure', () => {
    const r = dry('--port', '18999');
    assert.equal(r.code, 0, r.err);
    assert.ok(r.out.includes(`ExecStart=${NODE} src/main.mjs --local`), 'runs the local mode');
    assert.ok(r.out.includes(`WorkingDirectory=${REPO}/server`));
    assert.match(r.out, /^Environment=PRINTMD_PORT=18999$/m);
    assert.match(r.out, /^Environment=PRINTMD_HOST=127\.0\.0\.1$/m);
    assert.match(r.out, /^Environment=PRINTMD_BROWSER_IDLE_S=60$/m, 'the browser closes after a quiet minute by default');
    assert.match(r.out, /^Restart=on-failure$/m);
    assert.match(r.out, /^KillMode=control-group$/m, 'stopping the service stops every browser process');
    assert.match(r.out, /^WantedBy=default\.target$/m, 'starts at login');
    assert.ok(!/0\.0\.0\.0|::/.test(r.out), 'never listens beyond this machine');
    assert.ok(!/docker|podman|container/i.test(r.out), 'no container');
    assert.ok(!/@[A-Z_]+@/.test(r.out), `no marker left unfilled: ${r.out.match(/@[A-Z_]+@/)}`);
    assert.ok(!/PRINTMD_CHROME/.test(r.out), 'with the Playwright browser nothing names a browser');
});

test('the idle time is an option, and 0 keeps the browser open', () => {
    assert.match(dry('--idle', '300').out, /^Environment=PRINTMD_BROWSER_IDLE_S=300$/m);
    assert.match(dry('--idle', '0').out, /^Environment=PRINTMD_BROWSER_IDLE_S=0$/m);
    for (const bad of ['abc', '-1', '86401']) assert.notEqual(dry('--idle', bad).code, 0, bad);
});

test('the browser: a path, or auto finds one on the PATH, or the Playwright browser', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bd-svc-'));
    try {
        const fake = join(dir, 'google-chrome');
        writeFileSync(fake, '#!/bin/sh\nexit 0\n');
        chmodSync(fake, 0o755);
        const named = run(['--dry-run', '--node', NODE, '--chrome', fake]);
        assert.match(named.out, new RegExp(`^Environment=PRINTMD_CHROME=${fake}$`, 'm'), named.err);
        const auto = run(['--dry-run', '--node', NODE, '--chrome', 'auto'], {env: {PATH: `${dir}:${process.env.PATH}`}});
        assert.match(auto.out, new RegExp(`^Environment=PRINTMD_CHROME=${fake}$`, 'm'), 'auto uses the browser on the PATH');
        const none = run(['--dry-run', '--node', NODE, '--chrome', 'auto'], {env: {PATH: '/usr/bin:/bin'.replace(/^/, '')}});
        if (!existsSync('/usr/bin/google-chrome') && !existsSync('/usr/bin/chromium') && !existsSync('/bin/google-chrome')) {
            assert.ok(!/PRINTMD_CHROME/.test(none.out), 'no browser on the PATH: the Playwright one');
        }
        const missing = run(['--dry-run', '--node', NODE, '--chrome', join(dir, 'nope')]);
        assert.notEqual(missing.code, 0);
        assert.match(missing.err, /not an executable/);
    } finally {
        rmSync(dir, {recursive: true, force: true});
    }
});

test('it refuses what would break: a bad port, an old Node, a path systemd would misread, a folder that is not a checkout', () => {
    assert.notEqual(dry('--port', '0').code, 0);
    assert.notEqual(dry('--port', '70000').code, 0);
    assert.notEqual(dry('--port', 'http').code, 0);
    const dir = mkdtempSync(join(tmpdir(), 'bd-svc-'));
    try {
        const old = join(dir, 'node');
        writeFileSync(old, '#!/bin/sh\necho 20\n');
        chmodSync(old, 0o755);
        const oldNode = run(['--dry-run', '--node', old, '--chrome', 'playwright']);
        assert.notEqual(oldNode.code, 0);
        assert.match(oldNode.err, /Node 22 or newer/);
        const spaced = join(dir, 'a b');
        mkdirSync(join(spaced, 'server/src'), {recursive: true});
        writeFileSync(join(spaced, 'server/src/main.mjs'), '');
        const spaces = dry('--repo', spaced);
        assert.notEqual(spaces.code, 0);
        assert.match(spaces.err, /must not contain spaces/);
        const empty = dry('--repo', dir);
        assert.notEqual(empty.code, 0);
        assert.match(empty.err, /no server\/src\/main\.mjs/);
        assert.notEqual(run(['--no-such-option']).code, 0);
    } finally {
        rmSync(dir, {recursive: true, force: true});
    }
});

test('--unit-dir writes the unit (readable by all, not executable) without calling systemctl, and --uninstall removes it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bd-svc-'));
    try {
        const file = join(dir, 'printmd-api.service');
        const wrote = run(['--unit-dir', dir, '--node', NODE, '--chrome', 'playwright', '--port', '18998']);
        assert.equal(wrote.code, 0, wrote.err);
        assert.ok(existsSync(file));
        assert.equal(statSync(file).mode & 0o777, 0o644);
        assert.match(readFileSync(file, 'utf8'), /^Environment=PRINTMD_PORT=18998$/m);
        const again = run(['--unit-dir', dir, '--node', NODE, '--chrome', 'playwright', '--port', '18997']);
        assert.equal(again.code, 0, again.err);
        assert.match(readFileSync(file, 'utf8'), /^Environment=PRINTMD_PORT=18997$/m, 'running it again replaces the unit');
        const gone = run(['--unit-dir', dir, '--uninstall']);
        assert.equal(gone.code, 0, gone.err);
        assert.ok(!existsSync(file));
    } finally {
        rmSync(dir, {recursive: true, force: true});
    }
});

test('--dry-run changes nothing on disk', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bd-svc-'));
    try {
        const r = run(['--dry-run', '--unit-dir', join(dir, 'units'), '--node', NODE, '--chrome', 'playwright']);
        assert.equal(r.code, 0, r.err);
        assert.ok(!existsSync(join(dir, 'units')), 'no folder, no file');
    } finally {
        rmSync(dir, {recursive: true, force: true});
    }
});

test('systemd accepts the unit it generates', {skip: spawnSync('sh', ['-c', 'command -v systemd-analyze'], {stdio: 'ignore'}).status !== 0}, () => {
    const dir = mkdtempSync(join(tmpdir(), 'bd-svc-'));
    try {
        const wrote = run(['--unit-dir', dir, '--node', NODE, '--chrome', 'playwright']);
        assert.equal(wrote.code, 0, wrote.err);
        const r = spawnSync('systemd-analyze', ['--user', 'verify', join(dir, 'printmd-api.service')], {encoding: 'utf8'});
        const problems = `${r.stdout}${r.stderr}`.split('\n').filter((l) => /printmd-api\.service/.test(l)
            && !/default\.target|network\.target/.test(l));
        assert.deepEqual(problems, [], problems.join('\n'));
    } finally {
        rmSync(dir, {recursive: true, force: true});
    }
});
