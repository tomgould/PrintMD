/**
 * The template registry (js/template-registry.js): manifests are checked before
 * anything is imported, layers are optional, and the order is layers first, then
 * the core manifest's own templates. Neutral ids only: the real templates are
 * covered by iterating the registry, never by naming them.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createServer} from 'node:http';
import {
    CORE_MANIFEST, DEFAULT_TIMEOUTS, parseTemplateManifest, loadTemplateRegistry, setRegistryTimeouts, TemplateRegistryError,
    GROUP_MAX, DESCRIPTION_MAX, UNGROUPED_LABEL, pickerGroups,
} from '../js/template-registry.js';
import {getTemplates, getTemplateById, getTemplateWarnings} from '../js/templates.js';

const ROOT = new URL('../', import.meta.url);
// The private repository has a company template layer; the public edition has none, so the tests
// that answer the layer manifest in odd ways have nothing to exercise there.
const HAS_LAYER = (JSON.parse(readFileSync(new URL(CORE_MANIFEST, ROOT), 'utf8')).layers || []).length > 0;
const NO_LAYER = HAS_LAYER ? false : 'this edition has no template layer';
const good = (templates, extra = {}) => JSON.stringify({templates, ...extra});
const entry = (id, path = `templates/${id}/template.js`) => ({id, path});

const refuses = (text, re, opts) => assert.throws(() => parseTemplateManifest(text, 'test.json', opts),
    (e) => e instanceof TemplateRegistryError && (!re || re.test(e.message)));

test('a valid manifest parses to its entries and layers', () => {
    const m = parseTemplateManifest(good([entry('example-co'), entry('plain', 'templates/extra/plain/template.js')],
        {layers: ['templates/manifest.extra.json']}), 'core.json', {allowLayers: true});
    assert.deepEqual(m, {
        templates: [{id: 'example-co', path: 'templates/example-co/template.js'}, {id: 'plain', path: 'templates/extra/plain/template.js'}],
        layers: ['templates/manifest.extra.json'],
    });
});

test('ids: lower-case letters, digits and hyphens, 1 to 32 characters', () => {
    for (const id of ['', 'Example', 'a_b', 'a b', 'a.b', '../x', 'x'.repeat(33), 42, null]) {
        refuses(good([{id, path: 'templates/x/template.js'}]), /id/);
    }
    assert.equal(parseTemplateManifest(good([entry('x'.repeat(32))]), 't').templates.length, 1);
});

test('paths: same-origin modules under templates/, ending /template.js, no dot segments', () => {
    for (const path of [
        'templates/template.js', 'js/app.js', '/templates/x/template.js', 'templates/../js/template.js',
        'templates/x/../y/template.js', 'templates/./x/template.js', 'templates//template.js', 'templates/x/template.mjs',
        'templates/x/other.js', 'https://example.com/templates/x/template.js', '//example.com/templates/x/template.js',
        'templates\\x\\template.js', 'templates/x/template.js?v=1', 'templates/x/template.js#a', 'templates/X/template.js',
        'templates/%2e%2e/template.js', 'data:text/javascript,1', 'templates/a/b/c/d/template.js', 42,
    ]) {
        refuses(good([{id: 'x', path}]), /path/);
    }
});

test('duplicates, unknown keys, wrong shapes and bad JSON are refused', () => {
    refuses(good([entry('a'), entry('a')]), /twice/);
    refuses(good([{...entry('a'), extra: 1}]), /unknown/);
    refuses(good([entry('a')], {extra: 1}), /unknown/);
    refuses('{"templates": {}}', /list/);
    refuses('[]', /object/);
    refuses('{nope', /JSON/);
    refuses(good(Array.from({length: 65}, (_, i) => entry(`t${i}`))), /at most/);
    assert.deepEqual(parseTemplateManifest(good([], {description: 'notes'}), 't').templates, []);
});

test('only the core manifest may name layers, and a layer must be a templates/manifest.*.json file', () => {
    refuses(good([], {layers: ['templates/manifest.extra.json']}), /layers/);
    for (const layer of ['templates/extra.json', 'manifest.extra.json', 'templates/manifest.../x.json',
        'templates/manifest.Extra.json', 'templates/sub/manifest.extra.json', 'https://example.com/templates/manifest.x.json']) {
        refuses(good([], {layers: [layer]}), /layer/, {allowLayers: true});
    }
});

/** A registry over an in-memory set of files, with a fake module loader. */
function fakeSources(files, modules) {
    const seen = [];
    return {
        seen,
        read: async (url) => {
            const key = url.href.slice(ROOT.href.length);
            seen.push(key);
            return key in files ? files[key] : null;
        },
        load: async (url) => {
            const key = url.href.slice(ROOT.href.length);
            seen.push(key);
            if (!(key in modules)) throw new Error(`no module ${key}`);
            return modules[key];
        },
    };
}

const fakeModule = (id, extra = {}) => ({manifest: {id, name: id}, styles: `.template-${id}{}`, default: {id}, ...extra});

test('layers come first in their own order, then the core templates; the first is the default', async () => {
    const src = fakeSources({
        [CORE_MANIFEST]: good([entry('plain')], {layers: ['templates/manifest.one.json', 'templates/manifest.two.json']}),
        'templates/manifest.one.json': good([entry('example-co'), entry('other-co')]),
        'templates/manifest.two.json': good([entry('third-co')]),
    }, {
        'templates/plain/template.js': fakeModule('plain'),
        'templates/example-co/template.js': fakeModule('example-co'),
        'templates/other-co/template.js': fakeModule('other-co'),
        'templates/third-co/template.js': fakeModule('third-co'),
    });
    const {templates: list, warnings} = await loadTemplateRegistry({base: ROOT, read: src.read, load: src.load});
    assert.deepEqual(list.map((t) => t.manifest.id), ['example-co', 'other-co', 'third-co', 'plain']);
    assert.deepEqual(Object.keys(list[0]).sort(), ['manifest', 'styles', 'template']);
    assert.equal(list[0].template.id, 'example-co');
    assert.deepEqual(warnings, []);
});

test('an entry may carry a picker group and a description: plain text on one line, kept only when given', () => {
    const m = parseTemplateManifest(good([
        {...entry('a'), group: '  New  ', description: 'A modern look.'}, entry('b'), {...entry('c'), group: 'Current'},
    ]), 't');
    assert.deepEqual(m.templates, [
        {id: 'a', path: 'templates/a/template.js', group: 'New', description: 'A modern look.'},
        {id: 'b', path: 'templates/b/template.js'},
        {id: 'c', path: 'templates/c/template.js', group: 'Current'},
    ]);
    for (const bad of ['', '   ', 'x'.repeat(GROUP_MAX + 1), 'a\nb', 'a\u0000', 42, null, ['New'], {}]) {
        refuses(good([{...entry('a'), group: bad}]), /group/);
    }
    for (const bad of ['', 'x'.repeat(DESCRIPTION_MAX + 1), 'two\nlines', 7]) refuses(good([{...entry('a'), description: bad}]), /description/);
    assert.equal(parseTemplateManifest(good([{...entry('a'), group: 'x'.repeat(GROUP_MAX)}]), 't').templates[0].group.length, GROUP_MAX);
});

test('the loaded entry carries the group and description from its manifest entry, and nothing when there are none', async () => {
    const src = fakeSources({
        [CORE_MANIFEST]: good([entry('plain')], {layers: ['templates/manifest.one.json']}),
        'templates/manifest.one.json': good([{...entry('example-co'), group: 'New', description: 'Listed text'}]),
    }, {'templates/plain/template.js': fakeModule('plain'), 'templates/example-co/template.js': fakeModule('example-co')});
    const {templates: list} = await loadTemplateRegistry({base: ROOT, read: src.read, load: src.load});
    assert.equal(list[0].group, 'New');
    assert.equal(list[0].description, 'Listed text');
    assert.deepEqual(Object.keys(list[1]).sort(), ['manifest', 'styles', 'template'], 'no group or description keys when not given');
});

test('pickerGroups: alphabetical by name; a flat list without groups; otherwise headings A to Z, the ungrouped under "Other" last', () => {
    const e = (id, group, name) => ({id, ...(group ? {group} : {}), manifest: {id, name: name || id}});
    const flat = [e('b'), e('a'), e('C')];
    assert.deepEqual(pickerGroups(flat).map((g) => [g.label, g.entries.map((x) => x.id)]), [[null, ['a', 'b', 'C']]],
        'a flat list is sorted, case does not matter');
    assert.deepEqual(flat.map((x) => x.id), ['b', 'a', 'C'], 'the caller\'s list is not reordered');
    const list = [e('f', 'New'), e('d'), e('c', 'Current'), e('b', 'New'), e('a', 'Current')];
    assert.deepEqual(pickerGroups(list).map((g) => [g.label, g.entries.map((x) => x.id)]),
        [['Current', ['a', 'c']], ['New', ['b', 'f']], [UNGROUPED_LABEL, ['d']]]);
    assert.deepEqual(pickerGroups([e('x', 'New'), e('y', 'Current')]).map((g) => g.label), ['Current', 'New'],
        'headings are alphabetical whatever the manifest order');
    // The visible name decides, not the id; digits count as numbers; the id breaks a tie.
    const named = [e('z', null, 'Alpha'), e('a', null, 'Zulu'), e('t10', null, 'Deck 10'), e('t2', null, 'Deck 2'),
        e('m2', null, 'Same'), e('m1', null, 'Same')];
    assert.deepEqual(pickerGroups(named)[0].entries.map((x) => x.id), ['z', 't2', 't10', 'm1', 'm2', 'a']);
    assert.equal(UNGROUPED_LABEL, 'Other');
});

test('a missing layer means no templates from it, no warning, and nothing else is read', async () => {
    const src = fakeSources({[CORE_MANIFEST]: good([entry('plain')], {layers: ['templates/manifest.gone.json']})},
        {'templates/plain/template.js': fakeModule('plain')});
    const {templates, warnings} = await loadTemplateRegistry({base: ROOT, read: src.read, load: src.load});
    assert.deepEqual(templates.map((t) => t.manifest.id), ['plain']);
    assert.deepEqual(warnings, []);
    assert.deepEqual(src.seen.sort(), [CORE_MANIFEST, 'templates/manifest.gone.json', 'templates/plain/template.js'].sort());
});

/** A registry with a good core template and one layer, for the failure cases. */
function withLayer(layerText, modules = {}, {read} = {}) {
    const files = {[CORE_MANIFEST]: good([entry('plain')], {layers: ['templates/manifest.x.json']})};
    if (layerText !== undefined) files['templates/manifest.x.json'] = layerText;
    const src = fakeSources(files, {'templates/plain/template.js': fakeModule('plain'), ...modules});
    return loadTemplateRegistry({base: ROOT, read: read || src.read, load: src.load});
}
const ids = (r) => r.templates.map((t) => t.manifest.id);

test('a bad layer is skipped with one warning; the core templates still load', async () => {
    const answered500 = async (url) => {
        if (url.pathname.endsWith('manifest.x.json')) throw new TemplateRegistryError('templates/manifest.x.json: answered 500');
        return good([entry('plain')], {layers: ['templates/manifest.x.json']});
    };
    for (const [what, run] of [
        ['malformed JSON', () => withLayer('{"templates": [ oops')],
        ['an HTML fallback page', () => withLayer('<!DOCTYPE html><html><body>app</body></html>')],
        ['a wrong shape', () => withLayer('{"templates": 1}')],
        ['a bad path', () => withLayer(good([{id: 'x', path: 'templates/../js/app.js'}]))],
        ['a server error', () => withLayer(undefined, {}, {read: answered500})],
    ]) {
        const r = await run();
        assert.deepEqual(ids(r), ['plain'], what);
        assert.equal(r.warnings.length, 1, `${what}: one warning`);
        assert.match(r.warnings[0], /templates\/manifest\.x\.json/, what);
        assert.ok(!/oops|DOCTYPE/.test(r.warnings[0]), `${what}: the file's content is not echoed`);
    }
});

test('a bad layer entry is skipped with a warning; the rest of the layer and the core load', async () => {
    const throwing = {get manifest() { throw new Error('boom'); }};
    const layer = good([entry('ghost'), entry('broken'), entry('wrong-id'), entry('example-co')]);
    const r = await withLayer(layer, {
        'templates/broken/template.js': throwing,
        'templates/wrong-id/template.js': fakeModule('other'),
        'templates/example-co/template.js': fakeModule('example-co'),
    });
    assert.deepEqual(ids(r), ['example-co', 'plain']);
    assert.equal(r.warnings.length, 3);
    for (const [w, id] of r.warnings.map((w, i) => [w, ['ghost', 'broken', 'wrong-id'][i]])) assert.match(w, new RegExp(`"${id}"`));
    assert.ok(!r.warnings.some((w) => /boom|no module/.test(w)), 'import errors are not echoed');
});

test('a layer id that is already taken (by core or an earlier layer) is skipped; core wins', async () => {
    const r = await withLayer(good([entry('plain', 'templates/other/template.js'), entry('example-co')]), {
        'templates/other/template.js': fakeModule('plain'),
        'templates/example-co/template.js': fakeModule('example-co'),
    });
    assert.deepEqual(ids(r), ['example-co', 'plain']);
    assert.equal(r.templates[1].styles, '.template-plain{}', 'the core module, not the layer one');
    assert.equal(r.warnings.length, 1);
    assert.match(r.warnings[0], /"plain".*already/);
});

test('only the core manifest is fatal: missing, invalid, or leaving no template at all', async () => {
    const run = (files, modules = {'templates/plain/template.js': fakeModule('plain')}) => {
        const src = fakeSources(files, modules);
        return loadTemplateRegistry({base: ROOT, read: src.read, load: src.load});
    };
    await assert.rejects(run({}), (e) => e instanceof TemplateRegistryError && /core manifest/.test(e.message));
    await assert.rejects(run({[CORE_MANIFEST]: '{nope'}), (e) => e instanceof TemplateRegistryError && /JSON/.test(e.message));
    await assert.rejects(run({[CORE_MANIFEST]: good([])}), /no templates/);
    await assert.rejects(run({[CORE_MANIFEST]: good([entry('plain')])}, {}), /no templates/);
});

test('a module whose own id differs from its entry, or that breaks the contract, is skipped', async () => {
    const run = (mod) => {
        const src = fakeSources({[CORE_MANIFEST]: good([entry('plain'), entry('spare')])},
            {'templates/plain/template.js': mod, 'templates/spare/template.js': fakeModule('spare')});
        return loadTemplateRegistry({base: ROOT, read: src.read, load: src.load});
    };
    for (const mod of [fakeModule('other'), {...fakeModule('plain'), default: {id: 'other'}},
        {...fakeModule('plain'), styles: 1}, {manifest: {id: 'plain'}, styles: ''}]) {
        const r = await run(mod);
        assert.deepEqual(ids(r), ['spare']);
        assert.equal(r.warnings.length, 1);
        assert.match(r.warnings[0], /"plain"/);
    }
});

/** A request that never answers, like a hung server; it rejects only when its signal aborts, as fetch does. */
const neverAnswers = (signal) => new Promise((_, reject) => {
    if (signal) signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), {once: true});
});
const QUICK = {manifestMs: 30, importMs: 30};

test('the waits: 5 seconds for a manifest and for each template import, unless a test shortens them', async () => {
    assert.deepEqual({...DEFAULT_TIMEOUTS}, {manifestMs: 5000, importMs: 5000});
    assert.throws(() => setRegistryTimeouts({manifestMs: 0}), RangeError);
    assert.throws(() => setRegistryTimeouts({importMs: Number.NaN}), RangeError);
    // The setter is what a test page uses; the core manifest that never answers fails within it.
    setRegistryTimeouts({manifestMs: 30});
    try {
        await assert.rejects(loadTemplateRegistry({base: ROOT, read: (url, {signal}) => neverAnswers(signal)}), /no answer within 30 ms/);
    } finally {
        setRegistryTimeouts();
    }
});

test('a layer manifest that never answers is skipped with one warning, and its request is cancelled', async () => {
    let signal;
    const read = async (url, opts) => {
        if (url.pathname.endsWith('manifest.x.json')) {
            signal = opts.signal;
            return neverAnswers(opts.signal);
        }
        return good([entry('plain')], {layers: ['templates/manifest.x.json']});
    };
    const r = await loadTemplateRegistry({base: ROOT, read, load: async () => fakeModule('plain'), timeouts: QUICK});
    assert.deepEqual(ids(r), ['plain']);
    assert.deepEqual(r.warnings, ['templates/manifest.x.json: no answer within 30 ms; its templates are skipped']);
    assert.ok(signal && signal.aborted, 'the request is aborted, not left open');
});

test('a template import that never finishes is skipped with one warning; the rest load and the late module is ignored', async () => {
    let finish;
    const late = new Promise((ok) => { finish = ok; });
    const src = fakeSources({
        [CORE_MANIFEST]: good([entry('plain')], {layers: ['templates/manifest.x.json']}),
        'templates/manifest.x.json': good([entry('slow-co'), entry('example-co')]),
    }, {
        'templates/plain/template.js': fakeModule('plain'),
        'templates/example-co/template.js': fakeModule('example-co'),
    });
    // An import cannot be cancelled: this one never settles until the test lets it.
    const load = (url) => (url.pathname.endsWith('slow-co/template.js') ? late : src.load(url));
    const r = await loadTemplateRegistry({base: ROOT, read: src.read, load, timeouts: QUICK});
    assert.deepEqual(ids(r), ['example-co', 'plain']);
    assert.deepEqual(r.warnings, ['templates/slow-co/template.js: template "slow-co" could not be loaded (no answer within 30 ms); it is skipped']);
    finish(fakeModule('slow-co'));
    await new Promise((ok) => setTimeout(ok, 10));
    assert.deepEqual(ids(r), ['example-co', 'plain'], 'the late module changes nothing');
});

test('a core manifest that never answers is fatal, like a broken one', async () => {
    let signal;
    const read = (url, opts) => {
        signal = opts.signal;
        return neverAnswers(opts.signal);
    };
    await assert.rejects(loadTemplateRegistry({base: ROOT, read, load: async () => fakeModule('plain'), timeouts: QUICK}),
        (e) => e instanceof TemplateRegistryError && e.message === `${CORE_MANIFEST}: no answer within 30 ms`);
    assert.ok(signal.aborted, 'the request is aborted');
});

/**
 * The registry as a page uses it: the real fetch, against an HTTP server that answers the
 * layer manifest one way per case (or never, or drops the connection). Modules are imported
 * from disk (Node cannot import over http); tests/template-layers.test.html covers a module
 * import that never finishes in the browser.
 */
async function overHttp(layerAnswer, {coreAnswer} = {}) {
    const core = JSON.parse(readFileSync(new URL(CORE_MANIFEST, ROOT), 'utf8'));
    const layer = (core.layers || [])[0];
    const seen = {layerClosed: false};
    const server = createServer((req, res) => {
        const path = new URL(req.url, 'http://x').pathname.slice(1);
        if (path === CORE_MANIFEST && coreAnswer) return coreAnswer(req, res, seen);
        if (path === layer) return layerAnswer(req, res, seen);
        try {
            const body = readFileSync(new URL(path, ROOT));
            res.writeHead(200, {'content-type': 'application/json'}).end(body);
        } catch {
            res.writeHead(404).end('not found');
        }
    });
    await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
    const base = new URL(`http://127.0.0.1:${server.address().port}/`);
    try {
        const r = await loadTemplateRegistry({base, load: (url) => import(new URL(url.pathname.slice(1), ROOT).href), timeouts: QUICK_HTTP})
            .then((v) => ({...v, layer}), (error) => ({error, layer}));
        // A cancelled request reaches the server a moment after the registry gives up on it.
        for (let i = 0; i < 50 && !seen.layerClosed && seen.layerOpen; i++) await new Promise((ok) => setTimeout(ok, 10));
        return {...r, seen};
    } finally {
        server.closeAllConnections();
        await new Promise((ok) => server.close(ok));
    }
}
// Room for a cold first fetch on a slow CI container, still far below the 5 s default.
const QUICK_HTTP = {manifestMs: 1000, importMs: 3000};
const hangs = (req, res, seen) => {
    seen.layerOpen = true;
    res.on('close', () => { seen.layerClosed = true; });
};
const answer = (status, body, type = 'application/json') => (req, res) => res.writeHead(status, {'content-type': type}).end(body);

test('over HTTP: a missing layer (404) adds nothing and warns nothing', {skip: NO_LAYER}, async () => {
    const r = await overHttp(answer(404, 'not found', 'text/plain'));
    assert.deepEqual(r.warnings, []);
    assert.ok(r.templates.length >= 1);
});

test('over HTTP: a layer that is broken, an error, dropped or never answered is skipped with one warning; the core templates load', {skip: NO_LAYER}, async () => {
    const coreIds = parseTemplateManifest(readFileSync(new URL(CORE_MANIFEST, ROOT), 'utf8'), CORE_MANIFEST, {allowLayers: true}).templates.map((t) => t.id);
    const indexHtml = readFileSync(new URL('index.html', ROOT), 'utf8');
    for (const [what, layerAnswer, rule] of [
        ['malformed JSON', answer(200, '{"templates": [ oops'), /: is not valid JSON; its templates are skipped$/],
        ['an HTML fallback page', answer(200, indexHtml, 'text/html'), /: is not valid JSON; its templates are skipped$/],
        ['a server error', answer(500, 'error', 'text/plain'), /: answered 500; its templates are skipped$/],
        ['a dropped connection', (req) => req.socket.destroy(), /: could not be read; its templates are skipped$/],
        ['a missing module', answer(200, JSON.stringify({templates: [{id: 'ghost-co', path: 'templates/ghost-co/template.js'}]})),
            /"ghost-co" could not be loaded; it is skipped$/],
        ['a taken id', answer(200, JSON.stringify({templates: [{id: coreIds[0], path: `templates/${coreIds[0]}/template.js`}]})),
            /is already listed; this one is skipped$/],
        ['no answer at all', hangs, /: no answer within 1000 ms; its templates are skipped$/],
    ]) {
        const r = await overHttp(layerAnswer);
        assert.ok(!r.error, `${what}: the registry did not fail (${r.error})`);
        assert.deepEqual(r.templates.map((t) => t.manifest.id), coreIds, `${what}: the core templates`);
        assert.equal(r.warnings.length, 1, `${what}: one warning (${r.warnings})`);
        assert.match(r.warnings[0], rule, what);
        assert.ok(r.warnings[0].includes(r.layer) || /ghost-co/.test(r.warnings[0]), `${what}: names the file`);
        assert.ok(!/oops|DOCTYPE/.test(r.warnings[0]), `${what}: the file is not echoed`);
        if (layerAnswer === hangs) assert.ok(r.seen.layerClosed, 'the request that never answered is cancelled, not left open');
    }
});

test('over HTTP: a core manifest that never answers is fatal after the wait, and its request is cancelled', async () => {
    const seen = {};
    const r = await overHttp(answer(404, ''), {coreAnswer: (req, res) => { seen.open = true; res.on('close', () => { seen.closed = true; }); }});
    assert.ok(r.error instanceof TemplateRegistryError && r.error.message === `${CORE_MANIFEST}: no answer within 1000 ms`, String(r.error));
    for (let i = 0; i < 50 && !seen.closed; i++) await new Promise((ok) => setTimeout(ok, 10));
    assert.ok(seen.open && seen.closed, 'the request is cancelled');
});

test('the real registry: every manifest entry loads, in manifest order, with matching ids', () => {
    const core = parseTemplateManifest(readFileSync(new URL(CORE_MANIFEST, ROOT), 'utf8'), CORE_MANIFEST, {allowLayers: true});
    const expected = [];
    for (const layer of core.layers) {
        let text = null;
        try { text = readFileSync(new URL(layer, ROOT), 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
        if (text !== null) expected.push(...parseTemplateManifest(text, layer).templates.map((t) => t.id));
    }
    expected.push(...core.templates.map((t) => t.id));
    const list = getTemplates();
    assert.deepEqual(list.map((t) => t.manifest.id), expected);
    assert.deepEqual(getTemplateWarnings(), [], 'the real manifests load without a warning');
    for (const t of list) {
        assert.equal(t.template.id, t.manifest.id);
        assert.equal(typeof t.styles, 'string');
        assert.equal(getTemplateById(t.manifest.id), t);
    }
});

test('the real registry: the templates are all grouped or none is, so none is listed under "Other"; when grouped the default is "Current"', () => {
    const list = getTemplates();
    const ungrouped = list.filter((t) => !t.group).map((t) => t.manifest.id);
    // No group anywhere is a flat picker (the public edition); a group on some and not on others puts the rest under "Other".
    if (ungrouped.length === list.length) return;
    assert.deepEqual(ungrouped, [], 'templates without a group');
    assert.equal(list[0].group, 'Current', 'the default template');
    const groups = pickerGroups(list.map((t) => ({id: t.manifest.id, group: t.group})));
    assert.ok(!groups.some((g) => g.label === UNGROUPED_LABEL), 'no "Other" heading');
    assert.equal(groups[0].label, 'Current', 'the current templates head the picker');
});
