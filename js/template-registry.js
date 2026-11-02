/**
 * The template registry: which templates exist comes from JSON manifests, not
 * from imports by name, so a private or company template set is one extra
 * folder plus one extra manifest file.
 *
 *   templates/manifest.core.json   always present. Its own templates, and the
 *                                  optional layer manifests it may extend with:
 *       {"templates": [{"id": "plain", "path": "templates/plain/template.js"}],
 *        "layers": ["templates/manifest.extra.json"]}
 *   templates/manifest.<name>.json a layer: {"templates": [...]} only. A layer
 *                                  that is not there (404, or no file on disk)
 *                                  adds nothing, and nothing is logged.
 *
 * Order: each layer's templates in layer order, then the core manifest's own.
 * The first one is the default. An optional "description" string is allowed at
 * the top level of any manifest; any other unknown key is an error.
 *
 * An entry may also carry a "group" (the heading it is listed under in the
 * editor's template picker, such as "Current" or "New"; at most GROUP_MAX
 * characters) and a "description" (shown instead of the module's own in the
 * picker's information and GET /api/v1/templates; at most DESCRIPTION_MAX).
 * Both are plain text and optional; the loaded entry has them only when given.
 * pickerGroups() puts the templates under their headings.
 *
 * Every manifest is checked before a module is imported: ids match
 * ID_RE, paths match PATH_RE (same-origin, under templates/, ending
 * /template.js, plain lower-case folder names, so no dot segments, no scheme,
 * no query). Each module must export manifest, styles and a default object
 * whose ids equal the entry's id (the contract in js/templates.js).
 *
 * A broken layer or template is skipped with a warning; only the core manifest
 * is fatal (loadTemplateRegistry says exactly what). Nothing is waited on for
 * ever: a manifest read and each template import get DEFAULT_TIMEOUTS, so a
 * company server that never answers costs the page five seconds, not its boot.
 *
 * In a browser the files are fetched relative to the app root; under Node
 * (the API, the unit tests) they are read from disk.
 */

export const CORE_MANIFEST = 'templates/manifest.core.json';
export const ID_RE = /^[a-z0-9-]{1,32}$/;
export const PATH_RE = /^templates\/(?:[a-z0-9_-]{1,64}\/){1,3}template\.js$/;
export const LAYER_RE = /^templates\/manifest\.[a-z0-9-]{1,32}\.json$/;
export const MAX_TEMPLATES = 64;
/** The longest entry "group" and "description". */
export const GROUP_MAX = 40;
export const DESCRIPTION_MAX = 200;
/** The picker heading for templates without a group, when others have one. */
export const UNGROUPED_LABEL = 'Other';
// Control characters, the line and paragraph separators: never in a group or description.
const CONTROL_RE = new RegExp(`[\\x00-\\x1f\\x7f-\\x9f${String.fromCharCode(0x2028, 0x2029)}]`);
/** How long one manifest read, and one template import, may take before it counts as failed. */
export const DEFAULT_TIMEOUTS = Object.freeze({manifestMs: 5000, importMs: 5000});
let timeouts = DEFAULT_TIMEOUTS;

/**
 * Shorter waits, for test pages only (a request that never answers then fails in
 * moments). The app never calls this, and nothing reads a wait from the URL or
 * from storage. With no argument, the defaults again.
 * @param {{manifestMs?: number, importMs?: number}} [next]
 */
export function setRegistryTimeouts(next = {}) {
    const merged = {...DEFAULT_TIMEOUTS, ...next};
    for (const [key, ms] of Object.entries(merged)) {
        if (!Number.isFinite(ms) || ms <= 0) throw new RangeError(`${key} must be a positive number of milliseconds`);
    }
    timeouts = Object.freeze(merged);
}

export class TemplateRegistryError extends Error {
    constructor(message) {
        super(message);
        this.name = 'TemplateRegistryError';
    }
}

const fail = (source, message) => { throw new TemplateRegistryError(`${source}: ${message}`); };
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Parse and check one manifest.
 * @param {string} text  the file's contents
 * @param {string} source  its path, for error messages
 * @param {{allowLayers?: boolean}} [opts]  true for the core manifest only
 * @returns {{templates: Array<{id: string, path: string, group?: string, description?: string}>, layers: string[]}}
 */
export function parseTemplateManifest(text, source, {allowLayers = false} = {}) {
    let data;
    try {
        data = JSON.parse(text);
    } catch {
        fail(source, 'is not valid JSON');
    }
    if (!isObject(data)) fail(source, 'must be a JSON object');
    for (const key of Object.keys(data)) {
        if (!['templates', 'layers', 'description'].includes(key)) fail(source, `unknown key "${key}"`);
    }
    if ('description' in data && typeof data.description !== 'string') fail(source, '"description" must be a string');
    if (!Array.isArray(data.templates)) fail(source, '"templates" must be a list');
    if (data.templates.length > MAX_TEMPLATES) fail(source, `lists at most ${MAX_TEMPLATES} templates`);

    const seen = new Set();
    const templates = data.templates.map((t, i) => {
        if (!isObject(t)) fail(source, `template ${i + 1} must be an object`);
        for (const key of Object.keys(t)) {
            if (!['id', 'path', 'group', 'description'].includes(key)) fail(source, `template ${i + 1}: unknown key "${key}"`);
        }
        if (typeof t.id !== 'string' || !ID_RE.test(t.id)) fail(source, `template ${i + 1}: id must match ${ID_RE}`);
        if (typeof t.path !== 'string' || !PATH_RE.test(t.path)) fail(source, `template "${t.id}": path must match ${PATH_RE}`);
        if (seen.has(t.id)) fail(source, `template "${t.id}" is listed twice`);
        seen.add(t.id);
        const out = {id: t.id, path: t.path};
        for (const [key, max] of [['group', GROUP_MAX], ['description', DESCRIPTION_MAX]]) {
            if (!(key in t)) continue;
            const text = typeof t[key] === 'string' ? t[key].trim() : '';
            if (!text || Array.from(text).length > max || CONTROL_RE.test(text)) {
                fail(source, `template "${t.id}": ${key} must be text of 1 to ${max} characters on one line`);
            }
            out[key] = text;
        }
        return out;
    });

    let layers = [];
    if ('layers' in data) {
        if (!allowLayers) fail(source, 'only the core manifest may name "layers"');
        if (!Array.isArray(data.layers)) fail(source, '"layers" must be a list');
        layers = data.layers.map((l) => {
            if (typeof l !== 'string' || !LAYER_RE.test(l)) fail(source, `layer must match ${LAYER_RE}`);
            return l;
        });
        if (new Set(layers).size !== layers.length) fail(source, 'a layer is listed twice');
    }
    return {templates, layers};
}

/**
 * The file's text, or null when it does not exist. The API and the unit tests
 * read from disk; only a page fetches.
 * @param {URL} url
 * @param {{signal?: AbortSignal}} [opts]  aborts the read (the fetch, body included)
 * @returns {Promise<string|null>}
 */
async function readSource(url, {signal} = {}) {
    if (url.protocol === 'file:') {
        const {readFile} = await import('node:fs/promises');
        try {
            return await readFile(url, {encoding: 'utf8', signal});
        } catch (e) {
            if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) return null;
            throw e;
        }
    }
    const res = await fetch(url, {credentials: 'same-origin', signal});
    if (res.status === 404) return null;
    if (!res.ok) throw new TemplateRegistryError(`${url.pathname}: answered ${res.status}`);
    return res.text();
}

const importModule = (url) => import(url.href);

/**
 * work(signal), or a TemplateRegistryError "<source>: no answer within <ms> ms"
 * once ms have passed. The signal then aborts, which cancels a fetch. An import
 * cannot be cancelled: it is left to finish, and what it brings is ignored.
 * @template T
 * @param {number} ms
 * @param {string} source  the manifest or module path, for the message
 * @param {(signal: AbortSignal) => Promise<T>} work
 * @returns {Promise<T>}
 */
function within(ms, source, work) {
    const controller = new AbortController();
    let timer;
    const expired = new Promise((_, reject) => {
        timer = setTimeout(() => {
            // Rejected first, so the race reports the wait and not the abort it causes.
            reject(new TemplateRegistryError(`${source}: no answer within ${ms} ms`));
            controller.abort();
        }, ms);
    });
    return Promise.race([Promise.resolve().then(() => work(controller.signal)), expired]).finally(() => clearTimeout(timer));
}

/** The URL of a checked relative path, refused if it leaves the base. */
function resolveInside(base, path) {
    const url = new URL(path, base);
    if (url.origin !== base.origin || !url.href.startsWith(base.href)) fail(path, 'resolves outside the app');
    return url;
}

function checkModule(id, path, mod) {
    if (!mod || !isObject(mod.manifest) || mod.manifest.id !== id) fail(path, `must export a manifest whose id is "${id}"`);
    if (typeof mod.styles !== 'string') fail(path, 'must export styles as a string');
    if (!mod.default || typeof mod.default !== 'object' || mod.default.id !== id) {
        fail(path, `must have a default export whose id is "${id}"`);
    }
    return {manifest: mod.manifest, styles: mod.styles, template: mod.default};
}

/** A layer's templates, or a warning when the layer cannot be used. Never throws. */
async function readLayer(base, layer, read, ms) {
    try {
        const text = await within(ms, layer, (signal) => read(resolveInside(base, layer), {signal}));
        return {entries: text === null ? [] : parseTemplateManifest(text, layer).templates};
    } catch (e) {
        // Our own messages name the file and the rule; anything else (a network error) is not echoed.
        const why = e instanceof TemplateRegistryError ? e.message : `${layer}: could not be read`;
        return {entries: [], warning: `${why}; its templates are skipped`};
    }
}

/**
 * Read the manifests and import every listed template.
 *
 * Only the core manifest is fatal: when it is missing or invalid, or when no
 * template is left, this rejects with TemplateRegistryError. Everything else
 * is skipped with one warning each, so a broken private layer never takes the
 * core templates down with it: a layer that cannot be read or parsed (bad JSON,
 * an HTML fallback page, a server error, a rule broken, no answer in time), a
 * layer entry whose id is already taken (core and earlier layers win), and any
 * module that does not load in time or breaks the contract. Warnings name the
 * manifest, id and rule only, never a file's content or an import error's text.
 * A core manifest that does not answer in time is fatal like a broken one.
 *
 * @param {{base?: URL, read?: (url: URL, opts: {signal: AbortSignal}) => Promise<string|null>, load?: (url: URL) => Promise<object>,
 *          timeouts?: {manifestMs: number, importMs: number}}} [opts]
 *        base: the app root (default: the folder above js/); read, load and timeouts are for tests
 *        (timeouts default to DEFAULT_TIMEOUTS, or what setRegistryTimeouts set)
 * @returns {Promise<{templates: Array<{manifest: object, styles: string, template: object, group?: string, description?: string}>,
 *          warnings: string[]}>}
 */
export async function loadTemplateRegistry({base = new URL('../', import.meta.url), read = readSource, load = importModule,
    timeouts: waits = timeouts} = {}) {
    const coreText = await within(waits.manifestMs, CORE_MANIFEST, (signal) => read(resolveInside(base, CORE_MANIFEST), {signal}));
    if (coreText === null) throw new TemplateRegistryError(`${CORE_MANIFEST}: the core manifest is missing`);
    const core = parseTemplateManifest(coreText, CORE_MANIFEST, {allowLayers: true});

    const warnings = [];
    const layers = await Promise.all(core.layers.map((l) => readLayer(base, l, read, waits.manifestMs)));
    // Core ids are taken first, so a layer can never replace a core template.
    const taken = new Set(core.templates.map((t) => t.id));
    const entries = [];
    layers.forEach(({entries: list, warning}, i) => {
        if (warning) warnings.push(warning);
        for (const t of list) {
            if (taken.has(t.id)) {
                warnings.push(`${core.layers[i]}: template "${t.id}" is already listed; this one is skipped`);
                continue;
            }
            taken.add(t.id);
            entries.push(t);
        }
    });
    entries.push(...core.templates);

    const loaded = await Promise.allSettled(entries.map(({id, path}) =>
        within(waits.importMs, path, () => load(resolveInside(base, path))).then((mod) => checkModule(id, path, mod))));
    const templates = [];
    loaded.forEach((r, i) => {
        // The entry's picker heading and description, only when the manifest gives them.
        const {group, description} = entries[i];
        if (r.status === 'fulfilled') templates.push({...r.value, ...(group ? {group} : {}), ...(description ? {description} : {})});
        else warnings.push(`${entries[i].path}: template "${entries[i].id}" could not be loaded`
            + `${r.reason instanceof TemplateRegistryError ? ` (${r.reason.message.slice(entries[i].path.length + 2)})` : ''}; it is skipped`);
    });
    if (!templates.length) fail('templates', 'no templates could be loaded');
    return {templates, warnings};
}

/**
 * The editor's template picker, in alphabetical order: the templates under their
 * group headings, the headings A to Z with UNGROUPED_LABEL last, and the templates
 * in a group A to Z by the name people see (case and accents ignored, digits as
 * numbers, the id breaking a tie). With no group anywhere, one unlabelled group
 * (a flat list, as before groups existed), also A to Z; a template without a
 * group, when others have one, is listed under UNGROUPED_LABEL. The registry's
 * own order (the default template is its first) is not changed.
 * @template {{group?: string, id?: string, manifest?: {id?: string, name?: string}}} T
 * @param {T[]} entries  registry entries
 * @returns {Array<{label: string|null, entries: T[]}>}
 */
export function pickerGroups(entries) {
    const idOf = (e) => (e.manifest && e.manifest.id) || e.id || '';
    const nameOf = (e) => (e.manifest && e.manifest.name) || idOf(e);
    const collator = new Intl.Collator('en', {sensitivity: 'base', numeric: true});
    const byName = (a, b) => collator.compare(nameOf(a), nameOf(b)) || collator.compare(idOf(a), idOf(b));
    if (!entries.some((e) => e.group)) return [{label: null, entries: [...entries].sort(byName)}];
    const groups = new Map();
    for (const e of entries) {
        const label = e.group || UNGROUPED_LABEL;
        if (!groups.has(label)) groups.set(label, []);
        groups.get(label).push(e);
    }
    const rank = ([label]) => (label === UNGROUPED_LABEL ? 1 : 0);
    return [...groups]
        .sort((a, b) => rank(a) - rank(b) || collator.compare(a[0], b[0]))
        .map(([label, list]) => ({label, entries: list.sort(byName)}));
}
