/**
 * TEMPLATE CONTRACT
 * =================
 * A template is one ES module, /templates/{id}/template.js.
 *
 *   Named exports:
 *     manifest  = { id, name, description, author, version, accent, fontStack,
 *                   page: { margin, sizes?, defaultSize?, defaultOrientation? } }
 *                 sizes: the page sizes offered (js/export-options.js templatePageSizes; 'Slide' only
 *                 when listed); defaultSize, defaultOrientation: the page the template starts on
 *                 (templatePageDefaults)
 *     styles    = CSS string: ALL visual styles scoped under .template-{id}, including
 *                 @media print rules, usually baseStyles(id) from templates/_shared/base.js
 *                 followed by the template's own rules. No @page rule: js/print-document.js
 *                 builds it (buildPageCss) from the page size, orientation and manifest.page.
 *   Default export object:
 *     {
 *       id:              string
 *       renderCover:     (doc) => htmlString | null   // doc = {title, author, date, subject, brand}
 *       transformHTML:   (html) => html        // optional post-render hook
 *       preflightChecks: (doc) => [string]     // optional warnings before PDF export
 *       pageBackground:  colour string        // optional canvas of the body pages, margins included
 *                                              // (hex, rgb(a), hsl(a) or a named colour)
 *       runningHead:     {left?, centre?, right?}   // optional, text with {title} {author} {date}
 *       runningFoot:     {left?, centre?, right?}   //   {subject} {page} {pages}; js/page-chrome.js
 *       runningStyle:    {fontFamily, fontSize, fontWeight, fontStyle, color}   // optional
 *       runningLogo:     {src, slot, height}   // optional, a small image in one margin slot
 *     }
 *   templates/_shared/base.js also provides escapeHtml (for renderCover) and the
 *   default preflightChecks.
 *
 * To add a new template:
 *   1. Create /templates/{id}/template.js
 *   2. List it in a manifest: templates/manifest.core.json for a core template,
 *      or a layer manifest (templates/manifest.<name>.json) for a private set,
 *      optionally with a picker "group" and a "description"
 *   Done. No other code changes needed. js/template-registry.js reads and checks
 *   the manifests; the order and the default are explained there. README,
 *   Template contract, has the fields in full and a checklist.
 */

import {fontFaceCSS, templateFaces} from './fonts.js';
import {loadTemplateRegistry} from './template-registry.js';

/** What the page says when the core templates cannot be loaded (the editor cannot start). */
export const TEMPLATES_FAILED_MESSAGE = 'PrintMD could not load its templates. Reload the page; if it keeps happening, tell whoever runs this site.';

/**
 * The core manifest failed, so the app will not start: say so in the page, not only in
 * the console. One non-modal banner that is read out once (role="alert", put on the page
 * whole) and takes no focus, and the toolbar's controls switched off rather than left
 * looking usable. The reason goes to the console for whoever runs the site.
 * @param {unknown} err
 */
function showTemplatesFailed(err) {
    console.error(`Templates: ${err && err.message ? err.message : String(err)}`);
    const show = () => {
        if (document.querySelector('.templates-failed')) return;
        const banner = document.createElement('div');
        banner.className = 'app-banner templates-failed';
        banner.setAttribute('role', 'alert');
        banner.textContent = TEMPLATES_FAILED_MESSAGE;
        document.body.appendChild(banner);
        for (const el of document.querySelectorAll('#toolbar-nav :is(button, select, input), #toolbar-format :is(button, select, input)')) {
            el.disabled = true;
        }
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', show, {once: true});
    else show();
}

// Every listed template loads with the app: importers of this module wait for it.
// A broken layer or template is skipped with a warning (only the core manifest is fatal:
// the error goes on to the importer, so the app does not start, and the API exits).
/** @type {{templates: Array<{manifest: object, styles: string, template: object}>, warnings: string[]}} */
let REGISTRY;
try {
    REGISTRY = await loadTemplateRegistry();
} catch (err) {
    if (typeof document !== 'undefined') showTemplatesFailed(err);
    throw err;
}
const TEMPLATES = REGISTRY.templates;
const WARNINGS = Object.freeze([...REGISTRY.warnings]);
// In a page, one console line; under Node the API logs them itself (server/src/runtime.mjs).
if (WARNINGS.length && typeof document !== 'undefined') {
    console.warn(`Templates: ${WARNINGS.length} skipped. ${WARNINGS.join(' ')}`);
}

/** Currently active template entry */
export let activeTemplateEntry = TEMPLATES[0];

/** Style element injected into <head> for live preview */
let styleEl = null;

/**
 * Returns all available template entries.
 * Each entry has shape: { manifest, styles, template }
 */
export function getTemplates() {
    return TEMPLATES;
}

/** What the registry skipped, one sentence each (empty when every manifest loaded). */
export function getTemplateWarnings() {
    return WARNINGS;
}

/**
 * Find a template entry by id.
 * @param {string} id
 * @returns {{ manifest: object, styles: string, template: object } | undefined}
 */
export function getTemplateById(id) {
    return TEMPLATES.find(t => t.manifest.id === id);
}

/**
 * Apply a template to the preview pane.
 * Injects the font faces and the template CSS into <head> (replacing any previous template styles).
 * Wraps the preview element content in the template class.
 *
 * @param {{ manifest: object, styles: string, template: object }} entry
 */
export function applyTemplate(entry) {
    activeTemplateEntry = entry;

    // Inject/replace styles
    if (!styleEl) {
        styleEl = document.createElement('style');
        styleEl.id = 'template-styles';
        document.head.appendChild(styleEl);
    }
    // The brand fonts first: templates name the families, js/fonts.js serves them.
    styleEl.textContent = fontFaceCSS() + '\n' + entry.styles;
    warmTemplateFonts(entry.styles);
}

/**
 * Start fetching the template's fonts now. The browser would only ask for them
 * once the first preview has been laid out, and then lay the whole preview out
 * again when they arrive (font-display: block). Started here, they load while
 * storage opens, and the first preview is laid out once.
 * @param {string} css
 */
function warmTemplateFonts(css) {
    if (typeof document === 'undefined' || !document.fonts || typeof document.fonts.load !== 'function') return;
    for (const f of templateFaces(css)) {
        document.fonts.load(`${f.style} ${f.weight} 1em "${f.family}"`).catch(() => { /* drawn when it arrives */ });
    }
}

/**
 * Returns the CSS string for a template by id.
 * @param {string} id
 * @returns {string}
 */
export function getTemplateCSS(id) {
    const entry = getTemplateById(id);
    return entry ? entry.styles : '';
}
