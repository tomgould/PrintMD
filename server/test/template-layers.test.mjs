/**
 * A broken template layer never takes the API down: the real server, started
 * from a copy of the repo whose layer manifest or layer template is broken,
 * serves the core templates, lists the warnings in GET /api/v1/templates and
 * logs them once. A broken core manifest stops it with one clear line.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {cpSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {REPO_ROOT, SERVER_ROOT} from '../src/paths.mjs';
import {CHROME} from './helpers.mjs';

const CORE = JSON.parse(readFileSync(join(REPO_ROOT, 'templates/manifest.core.json'), 'utf8'));
const CORE_IDS = CORE.templates.map((t) => t.id);
const LAYER = CORE.layers[0] || 'templates/manifest.extra.json';

/** A copy of what the server loads, with some files replaced: {relative path: text}. */
function copyRepo(replace) {
    const dir = mkdtempSync(join(tmpdir(), 'bd-layers-'));
    for (const part of ['js', 'templates', 'server/src', 'server/harness.html']) {
        cpSync(join(REPO_ROOT, part), join(dir, part), {recursive: true});
    }
    // The dependencies: this checkout's, or (on CI) the image's /node_modules, found by walking up.
    if (existsSync(join(SERVER_ROOT, 'node_modules'))) symlinkSync(join(SERVER_ROOT, 'node_modules'), join(dir, 'server/node_modules'));
    const core = {...CORE, layers: [LAYER]};
    writeFileSync(join(dir, 'templates/manifest.core.json'), JSON.stringify(core));
    for (const [path, text] of Object.entries(replace)) writeFileSync(join(dir, path), text);
    return dir;
}

/** Start the copy's server in local mode; resolves at "listening" or at exit, whichever comes first. */
function start(dir) {
    const child = spawn(process.execPath, [join(dir, 'server/src/main.mjs'), '--local'], {
        env: {PATH: process.env.PATH, HOME: process.env.HOME || '/tmp', PRINTMD_PORT: '0', PRINTMD_CHROME: CHROME, CI: process.env.CI || ''},
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '', err = '';
    return new Promise((ok) => {
        child.stdout.on('data', (d) => {
            out += d;
            const line = out.split('\n').find((l) => l.includes('"event":"listening"'));
            if (line) ok({child, url: JSON.parse(line).url, lines: () => out.split('\n').filter(Boolean).map((l) => JSON.parse(l))});
        });
        child.stderr.on('data', (d) => { err += d; });
        child.once('exit', (code) => ok({child, code, stderr: () => err}));
    });
}

async function withServer(replace, fn) {
    const dir = copyRepo(replace);
    const s = await start(dir);
    try {
        await fn(s);
    } finally {
        if (s.code === undefined) {
            s.child.kill('SIGTERM');
            await new Promise((ok) => s.child.once('exit', ok));
        }
        rmSync(dir, {recursive: true, force: true});
    }
}

test('a malformed layer manifest: the API starts with the core templates, one log line and the warning listed', async () => {
    await withServer({[LAYER]: '{"templates": [ oops'}, async (s) => {
        assert.ok(s.url, `the server started (stderr: ${s.stderr ? s.stderr() : ''})`);
        const list = await (await fetch(`${s.url}/api/v1/templates`)).json();
        assert.deepEqual(list.templates.map((t) => t.id), CORE_IDS);
        assert.equal(list.default, CORE_IDS[0]);
        assert.equal(list.warnings.length, 1);
        assert.match(list.warnings[0], /is not valid JSON/);
        assert.ok(!list.warnings[0].includes('oops'), 'the file is not echoed');
        const logged = s.lines().filter((l) => l.event === 'template_warnings');
        assert.equal(logged.length, 1, 'logged once');
        assert.deepEqual(logged[0].warnings, list.warnings);
        const bad = await fetch(`${s.url}/api/v1/render?template=nope`, {method: 'POST', headers: {'content-type': 'text/markdown'}, body: '# x'});
        assert.equal(bad.status, 404, 'template= checks follow the registry that loaded');
    });
});

test('a layer whose template is missing: the rest of the layer and the core still load', async () => {
    const layer = JSON.stringify({templates: [{id: 'ghost-co', path: 'templates/ghost-co/template.js'},
        {id: 'example-co', path: 'templates/example-co/template.js'}]});
    // A layer template that is the core template under another id: valid, so it loads.
    const example = readFileSync(join(REPO_ROOT, `templates/${CORE_IDS[0]}/template.js`), 'utf8')
        .replaceAll(`'${CORE_IDS[0]}'`, "'example-co'");
    const dir = 'templates/example-co';
    const copy = copyRepo({[LAYER]: layer});
    try {
        cpSync(join(copy, `templates/${CORE_IDS[0]}`), join(copy, dir), {recursive: true});
        writeFileSync(join(copy, dir, 'template.js'), example);
        const s = await start(copy);
        try {
            assert.ok(s.url, `the server started (stderr: ${s.stderr ? s.stderr() : ''})`);
            const list = await (await fetch(`${s.url}/api/v1/templates`)).json();
            assert.deepEqual(list.templates.map((t) => t.id), ['example-co', ...CORE_IDS]);
            assert.equal(list.warnings.length, 1);
            assert.match(list.warnings[0], /"ghost-co" could not be loaded/);
        } finally {
            s.child.kill('SIGTERM');
            await new Promise((ok) => s.child.once('exit', ok));
        }
    } finally {
        rmSync(copy, {recursive: true, force: true});
    }
});

test('a broken core manifest is the one fatal case: exit 2 with one clear line, no stack', async () => {
    await withServer({'templates/manifest.core.json': '{nope'}, async (s) => {
        assert.equal(s.code, 2, 'exit code');
        const err = s.stderr();
        assert.match(err, /^printmd-pdf-api: the templates cannot be loaded: templates\/manifest\.core\.json: is not valid JSON\n$/);
    });
});
