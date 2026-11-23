/**
 * One template-registry case, run in tests/lib/registry-frame.html. ?case= picks what
 * a manifest answers (fetch is stubbed before js/templates.js loads); ?app=1 boots the
 * whole app with it. The result goes to the parent with postMessage.
 *
 * The hang cases shorten the registry's waits with setRegistryTimeouts, which the app
 * itself never calls, so a request that never answers costs a moment, not 5 seconds.
 */
import {setRegistryTimeouts} from '../../js/template-registry.js';

const params = new URLSearchParams(location.search);
const which = params.get('case');
const realFetch = window.fetch.bind(window);
const json = (data) => new Response(JSON.stringify(data), {status: 200, headers: {'content-type': 'application/json'}});
let aborted = null;
/** A server that never answers: the promise settles only when the request is aborted, as fetch does. */
const hang = (init) => new Promise((_, reject) => {
    const signal = init && init.signal;
    aborted = false;
    if (signal) signal.addEventListener('abort', () => { aborted = true; reject(new DOMException('aborted', 'AbortError')); }, {once: true});
});

// What a layer manifest answers; everything else, the core manifest included, is the real file.
// (Every other broken layer is covered with the real fetch in tests/template-registry.test.mjs.)
const LAYER = {
    malformed: () => new Response('{"templates": [ oops', {status: 200, headers: {'content-type': 'application/json'}}),
    // The test server never answers a path with a __hang__ folder (tests/lib/static-server.mjs).
    moduleHang: () => json({templates: [{id: 'hang-co', path: 'templates/__hang__/template.js'}]}),
};
// What the core manifest answers, for the fatal cases.
const CORE = {
    coreBroken: () => new Response('{"templates": [ oops', {status: 200, headers: {'content-type': 'application/json'}}),
    coreHang: (init) => hang(init),
};
const WAITS = {coreHang: {manifestMs: 800}, moduleHang: {importMs: 1500}};
if (WAITS[which]) setRegistryTimeouts(WAITS[which]);

window.fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), location.href);
    if (LAYER[which] && /\/templates\/manifest\.(?!core\.)[a-z0-9-]+\.json$/.test(url.pathname)) return LAYER[which](init);
    if (CORE[which] && url.pathname.endsWith('/templates/manifest.core.json')) return CORE[which](init);
    if (LAYER[which] && url.pathname.endsWith('/templates/manifest.core.json')) {
        // An edition whose core manifest names no layer (the public one) gets one here, so the layer cases have something to answer.
        return realFetch(input, init).then(async (response) => {
            const core = await response.json();
            return json(core.layers && core.layers.length ? core : {...core, layers: ['templates/manifest.fixture.json']});
        });
    }
    return realFetch(input, init);
};
const warns = [];
const errors = [];
const realWarn = console.warn.bind(console);
const realError = console.error.bind(console);
console.warn = (...args) => { warns.push(args.map(String).join(' ')); realWarn(...args); };
console.error = (...args) => { errors.push(args.map(String).join(' ')); realError(...args); };
const violations = [];
document.addEventListener('securitypolicyviolation', (e) => violations.push(`${e.violatedDirective} ${e.blockedURI}`));

// Every time an alert is put on the page or its text changes: a screen reader reads it out each time.
let announcements = 0;
const isAlert = (n) => n.nodeType === 1 && n.getAttribute('role') === 'alert';
new MutationObserver((records) => {
    for (const r of records) {
        if (r.type === 'childList') {
            // A hidden alert (the app's storage banner, as the page is built) says nothing.
            announcements += [...r.addedNodes].filter((n) => isAlert(n) && !n.hidden && n.textContent.trim()).length;
            if (isAlert(r.target) && r.addedNodes.length) announcements++;
        } else if (r.type === 'attributes' && isAlert(r.target) && !r.target.hidden && r.target.textContent.trim()) {
            announcements++;
        }
    }
}).observe(document.documentElement, {childList: true, subtree: true, attributes: true, attributeFilter: ['hidden']});

/** What the page shows when the templates could not be loaded. */
function failureState() {
    const controls = [...document.querySelectorAll('#toolbar-nav :is(button, select, input), #toolbar-format :is(button, select, input)')];
    const active = document.activeElement;
    return {
        alerts: [...document.querySelectorAll('[role="alert"]')].filter((el) => el.textContent.trim()).map((el) => ({
            text: el.textContent.trim(), shown: !el.closest('[hidden]') && el.getClientRects().length > 0,
            modal: el.getAttribute('aria-modal'), tabindex: el.getAttribute('tabindex'),
        })),
        focused: active ? (active.id || active.tagName) : null,
        controls: controls.length,
        disabled: controls.filter((c) => c.disabled).length,
        announcements,
    };
}

const send = (result) => parent.postMessage({frame: which, warns, errors, violations, aborted, ...result}, location.origin);

async function loadScripts(srcs) {
    for (const src of srcs) {
        await new Promise((resolve, reject) => {
            const s = document.createElement('script');
            s.src = src;
            s.onload = resolve;
            s.onerror = () => reject(new Error('could not load ' + src));
            document.head.appendChild(s);
        });
    }
}

try {
    if (params.get('app') === '1') {
        const page = new DOMParser().parseFromString(await (await realFetch('../../index.html')).text(), 'text/html');
        for (const el of [...page.body.children]) {
            if (el.tagName !== 'SCRIPT') document.body.appendChild(document.adoptNode(el));
        }
        // Where the user is when the templates fail: the failure must not move them.
        document.getElementById('editor').focus();
        await loadScripts(['../../vendor/marked/marked.min.js', '../../vendor/dompurify/purify.min.js',
            '../../vendor/highlightjs/highlight.min.js']);
        let app;
        try {
            app = await import('../../js/app.js');
        } catch (e) {
            send({error: String(e && e.message || e), ...failureState()});
            throw null;
        }
        await app.init();
        const preview = document.getElementById('preview');
        for (let i = 0; i < 100 && !preview.textContent.trim(); i++) await new Promise((r) => setTimeout(r, 50));
        send({options: [...document.querySelectorAll('#template-select option')].map((o) => o.value),
            previewChars: preview.textContent.trim().length});
    } else {
        const m = await import('../../js/templates.js');
        send({ids: m.getTemplates().map((t) => t.manifest.id), warnings: [...m.getTemplateWarnings()]});
    }
} catch (e) {
    if (e !== null) send({error: String(e && e.message || e), ...failureState()});
}
