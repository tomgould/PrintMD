/**
 * The editor with the test-only fixture template (tests/fixtures/platform-fixture),
 * run in tests/lib/platform-frame.html by tests/template-platform.test.html. fetch is
 * stubbed before js/templates.js loads: the core manifest gets one more layer, which
 * lists the fixture at templates/__fixtures__/ (the test server maps that folder to
 * tests/fixtures/). What the running editor shows goes to the parent with postMessage.
 */
import {resetStorage} from './harness.js';

const ID = 'platform-fixture';
const LAYER = 'templates/manifest.platform-fixture.json';
const NEW_FAMILIES = ['Figtree', 'Fraunces', 'Schibsted Grotesk', 'Plus Jakarta Sans', 'IBM Plex Sans', 'DM Sans', 'Lora',
    'Libre Caslon Text'];
const DOC = '---\ntitle: Fixture report\nauthor: Example Co\nsubject: The subject line on the cover\n---\n'
    + '# Fixture report\n\nBody text with *italic* and **bold**.\n\n## Second heading\n\n> A quotation.\n';

const realFetch = window.fetch.bind(window);
const json = (data) => new Response(JSON.stringify(data), {status: 200, headers: {'content-type': 'application/json'}});
window.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), location.href);
    if (url.pathname.endsWith('/templates/manifest.core.json')) {
        const core = await (await realFetch(input, init)).json();
        return json({...core, layers: [...(core.layers || []), LAYER]});
    }
    if (url.pathname.endsWith(`/${LAYER}`)) {
        return json({templates: [{id: ID, path: `templates/__fixtures__/${ID}/template.js`, group: 'Test',
            description: 'The fixture, as its manifest entry describes it'}]});
    }
    return realFetch(input, init);
};

const errors = [];
const realError = console.error.bind(console);
console.error = (...args) => { errors.push(args.map(String).join(' ')); realError(...args); };
const violations = [];
document.addEventListener('securitypolicyviolation', (e) => violations.push(`${e.violatedDirective} ${e.blockedURI}`));

const send = (result) => parent.postMessage({frame: 'platform', errors, violations, ...result}, location.origin);
const until = async (fn, tries = 100) => {
    for (let i = 0; i < tries; i++) {
        const v = fn();
        if (v) return v;
        await new Promise((r) => setTimeout(r, 50));
    }
    return fn();
};
/** The new families with a face that has started loading or loaded. */
const fetchedFamilies = () => [...new Set([...document.fonts].filter((f) => f.status !== 'unloaded')
    .map((f) => f.family.replace(/^["']|["']$/g, '')).filter((f) => NEW_FAMILIES.includes(f)))];

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
    // A fresh store, so the saved template is never the fixture from an earlier run.
    await resetStorage();
    // Boot on a registry template, as an editor with a saved choice does. An edition with no layer of its own
    // would otherwise start on the fixture, whose layer then comes first.
    const coreIds = (await (await realFetch('../../templates/manifest.core.json')).json()).templates.map((t) => t.id);
    localStorage.setItem('printmd-state', JSON.stringify({templateId: coreIds[0]}));
    const page =new DOMParser().parseFromString(await (await realFetch('../../index.html')).text(), 'text/html');
    for (const el of [...page.body.children]) if (el.tagName !== 'SCRIPT') document.body.appendChild(document.adoptNode(el));
    await loadScripts(['../../vendor/marked/marked.min.js', '../../vendor/dompurify/purify.min.js', '../../vendor/highlightjs/highlight.min.js']);
    const app = await import('../../js/app.js');
    await app.init();
    const $ = (id) => document.getElementById(id);
    const sel = $('template-select');
    const paper = $('export-paper-size');
    const orientation = $('export-orientation');
    const change = (el, value) => { el.value = value; el.dispatchEvent(new Event('change', {bubbles: true})); };
    await until(() => $('preview').textContent.trim());

    const r = {};
    r.groups = [...sel.querySelectorAll('optgroup')].map((g) => ({label: g.label, ids: [...g.querySelectorAll('option')].map((o) => o.value)}));
    r.looseOptions = [...sel.children].filter((el) => el.tagName === 'OPTION').length;
    r.startTemplate = sel.value;
    // Booted on another template: none of the new families has been fetched.
    await document.fonts.ready;
    r.fetchedAtBoot = fetchedFamilies();
    r.slideHiddenAtBoot = paper.querySelector('option[value="Slide"]').hidden;

    change(sel, ID);
    const editor = $('editor');
    editor.value = DOC;
    editor.dispatchEvent(new Event('input', {bubbles: true}));
    const subject = await until(() => document.querySelector(`#preview .template-${ID} .pf-subject`));
    r.subject = subject ? subject.textContent : null;
    const card = document.querySelector('#preview .preview-page:not(.preview-page-cover)');
    r.cardBackground = card ? getComputedStyle(card).backgroundColor : null;
    r.offered = [...paper.options].filter((o) => !o.hidden && !o.disabled).map((o) => o.value);

    change(paper, 'Slide');
    r.slide = {paper: paper.value, orientation: orientation.value, orientationDisabled: orientation.disabled,
        aspect: $('preview-pane').style.getPropertyValue('--preview-page-aspect'), landscape: $('preview-pane').classList.contains('landscape')};

    // The fixture's fonts load once it is applied.
    await until(() => NEW_FAMILIES.every((f) => document.fonts.check(`16px "${f}"`, 'Aa')) || null, 160);
    r.fontsReady = NEW_FAMILIES.filter((f) => document.fonts.check(`16px "${f}"`, 'Aa'));
    r.fetchedAfter = fetchedFamilies();

    const {appCommands} = await import('../../js/palette.js');
    r.paletteLabels = appCommands({byId: $, newDocShortcut: 'Alt+N'}).filter((c) => c.cat === 'Template').map((c) => c.label);

    $('btn-template-info').click();
    r.infoDescription = document.querySelector('#template-info-body .ti-desc').textContent;
    $('template-info-close').click();

    // Back on a template without Slide: A4 again, the orientation chosen before (portrait) back and unlocked.
    change(sel, r.startTemplate);
    r.back = {paper: paper.value, orientation: orientation.value, orientationDisabled: orientation.disabled,
        slideHidden: paper.querySelector('option[value="Slide"]').hidden};

    // A template with a default page (manifest.page.defaultSize, defaultOrientation) sets it when chosen; a choice
    // made after it stands, and a template without one keeps that choice. Skipped in an edition without one.
    const {getTemplates} = await import('../../js/templates.js');
    const withDefault = getTemplates().find((t) => t.manifest.page && t.manifest.page.defaultSize === 'Slide');
    if (withDefault) {
        change(sel, withDefault.manifest.id);
        r.chosen = {paper: paper.value, orientation: orientation.value};
        change(paper, 'A4');
        r.chosenA4 = {paper: paper.value, orientation: orientation.value};
        change(sel, r.startTemplate);
        r.afterwards = {paper: paper.value, orientation: orientation.value};
    }
    send(r);
} catch (e) {
    send({error: String((e && e.message) || e)});
}
