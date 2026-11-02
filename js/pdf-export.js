/**
 * pdf-export.js
 * The print window: opens it, embeds same-origin images and the highlight.js
 * theme, writes the document from js/print-document.js and starts the browser's
 * Save as PDF dialog once everything has loaded.
 *
 * What goes into the document (Markdown, template, cover, page options) comes
 * from prepareExport() in js/export-pipeline.js.
 *
 * Chrome / Edge produce the best results. Firefox is usable.
 */

import {buildPrintDocument} from './print-document.js';
import {checkFonts, FONT_LOAD_TIMEOUT_MS} from './font-check.js';
import {FONT_FAMILIES} from './fonts.js';
import {
    applyPageLayout, estimatePages, needsPageEstimate, needsPageLayout, pageLayoutInput, restoreMedia, simulatePrintMedia,
} from './page-layout.js';
import {PAGE_LIMITS} from './export-options.js';

// ── Resource inlining ─────────────────────────────────────────────────────────

/** Convert a Blob to a base64 data URI. */
function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(/** @type {string} */ (reader.result));
        reader.onerror = reject;
        reader.readAsDataURL(blob);
    });
}

/** How long one image fetch may take while inlining before it is abandoned. */
export const IMAGE_FETCH_TIMEOUT_MS = 8000;

/**
 * Fetch a URL and return a base64 data URI.
 * Returns null on any failure (CORS, network, 4xx/5xx) or after timeoutMs.
 */
async function fetchAsDataUrl(url, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const resp = await fetch(url, {mode: 'cors', signal: controller.signal});
        if (!resp.ok) return null;
        return await blobToDataUrl(await resp.blob());
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Replace every same-origin <img src="…"> in an HTML string with a base64 data URI.
 * Skips images that are already data URIs, remote, or whose fetch fails or times out.
 */
async function inlineImages(html, timeoutMs = IMAGE_FETCH_TIMEOUT_MS) {
    // Quick exit: no img tags
    if (!html.includes('<img')) return html;

    const parser = new DOMParser();
    const doc = parser.parseFromString(`<!DOCTYPE html><html><body>${html}</body></html>`, 'text/html');
    const imgs = [...doc.querySelectorAll('img[src]')];

    await Promise.all(imgs.map(async img => {
        const src = img.getAttribute('src') || '';
        if (!src || src.startsWith('data:')) return; // already embedded

        // Resolve relative URLs against the current page origin
        let absUrl;
        try {
            absUrl = new URL(src, location.href).href;
        } catch {
            return; // unparseable: leave as-is
        }

        // Only same-origin images are fetched: the CSP connect-src does not allow
        // arbitrary hosts. Remote images keep their URL; img-src allows https:,
        // so the print window still loads them before printing.
        if (new URL(absUrl).origin !== location.origin) return;

        const dataUrl = await fetchAsDataUrl(absUrl, timeoutMs);
        if (dataUrl) img.setAttribute('src', dataUrl);
    }));

    return doc.body.innerHTML;
}

/**
 * The running head's logo (js/page-chrome.js) as a data: URI: margin boxes print an
 * image only from a data: URI, so a same-origin logo is fetched and embedded, and one
 * that cannot be is left out (the text still prints).
 * @param {object|null|undefined} running  prepareExport's print.running
 * @param {number} timeoutMs
 */
async function embedRunningLogo(running, timeoutMs) {
    if (!running || !running.logo || running.logo.src.startsWith('data:')) return running;
    let url = null;
    try {
        url = new URL(running.logo.src, location.href);
    } catch {
        url = null;
    }
    const dataUrl = url && url.origin === location.origin ? await fetchAsDataUrl(url.href, timeoutMs) : null;
    return {...running, logo: dataUrl ? {...running.logo, src: dataUrl} : null};
}

/**
 * Load the vendored highlight.js theme CSS as an inline string.
 * Falls back to an empty string if the file can't be fetched
 * (e.g. opened from file:// with restrictive settings).
 */
async function loadHljsCss() {
    try {
        const resp = await fetch('./vendor/highlightjs/atom-one-dark.min.css');
        if (resp.ok) return await resp.text();
    } catch { /* ignore */
    }
    return '';
}

// ── Export ────────────────────────────────────────────────────────────────────

/**
 * Open the print window and print the prepared export.
 * The window opens before the first await, so the click that started the export
 * (Export, or "Export anyway" in the preflight dialog) still counts as the user
 * gesture pop-up blockers look for. If anything fails after that, the window is
 * closed and the error passed on for the caller to report.
 * @param {{doc: {title: string}, bodyHTML: string, coverHTML: string, pageOpts: object}} prepared
 *        the result of prepareExport()
 * @param {{manifest: {id: string}, styles: string}} templateEntry
 * A vendored font that did not load is not printed silently in a fallback: the
 * print window asks first (confirmPrint), and Cancel closes it.
 * @param {{openWindow?: () => Window|null, imageTimeoutMs?: number, fontCSS?: string,
 *          fontTimeoutMs?: number, confirmPrint?: (win: Window, message: string) => boolean}} [opts]
 *        injectable for tests
 * The page options that need the laid-out document (the continuous page's height, fit to size,
 * js/page-layout.js) are applied in the print window once its fonts and images have loaded, with
 * the print rules switched on while it measures. A block left too wide is asked about with the
 * font warnings; what was scaled, widened or split comes back as notes.
 * @returns {Promise<{printed: boolean, warnings: string[], notes: string[]}>}
 */
export async function exportPDF(prepared, templateEntry, {
    openWindow = () => window.open('', '_blank'),
    imageTimeoutMs = IMAGE_FETCH_TIMEOUT_MS,
    fontCSS = undefined,
    fontTimeoutMs = FONT_LOAD_TIMEOUT_MS,
    confirmPrint = (w, message) => w.confirm(message),
    maxPages = PAGE_LIMITS.maxPages,
} = {}) {
    const win = openWindow();
    if (!win) throw new Error('Could not open the print window. Allow pop-ups for this page and try again.');

    try {
        // Inline all images before handing off to the print window
        const print = prepared.print || {};
        const [bodyHTML, coverHTML, hljsCSS, running] = await Promise.all([
            inlineImages(prepared.bodyHTML, imageTimeoutMs),
            prepared.coverHTML ? inlineImages(prepared.coverHTML, imageTimeoutMs) : Promise.resolve(''),
            loadHljsCss(),
            embedRunningLogo(print.running, imageTimeoutMs),
        ]);

        const html = buildPrintDocument({
            title: prepared.doc.title,
            templateId: templateEntry.manifest.id,
            templateCSS: templateEntry.styles,
            hljsCSS,
            bodyHTML,
            coverHTML,
            pageOpts: prepared.pageOpts,
            ...print,
            ...(print.running ? {running} : {}),
            ...(fontCSS === undefined ? {} : {fontCSS}),
        });

        win.document.write(html);
        win.document.close();
        // Lazy images below the fold would never load in an unscrolled window.
        for (const img of Array.from(win.document.images || [])) img.loading = 'eager';

        // The print window inherits the app's Content-Security-Policy, which blocks
        // inline scripts, so printing is driven from here rather than from a
        // <script> inside the written document.
        await whenLoaded(win);
        if (win.closed) return {printed: false, warnings: [], notes: []};
        const fonts = await checkFonts({doc: win.document, families: FONT_FAMILIES, timeoutMs: fontTimeoutMs});
        if (win.closed) return {printed: false, warnings: fonts.warnings, notes: []};
        let notes = [];
        let layoutWarnings = [];
        if (needsPageLayout(prepared.pageOpts) || needsPageEstimate(prepared.pageOpts)) {
            const flipped = simulatePrintMedia(win.document);
            try {
                const input = {...pageLayoutInput(prepared.pageOpts), doc: win.document};
                // Very small custom pages: asked about before the print dialog, as the API refuses them.
                const estimate = needsPageEstimate(prepared.pageOpts) ? estimatePages(input) : 0;
                if (estimate > maxPages) {
                    const n = (value) => value.toLocaleString('en-GB');
                    layoutWarnings.push(`This document would print about ${n(estimate)} pages at this page size, more than the `
                        + `${n(maxPages)} a print should hold; the browser may stall. Use a larger page.`);
                }
                if (needsPageLayout(prepared.pageOpts)) {
                    const layout = applyPageLayout(input);
                    notes = layout.advisories;
                    layoutWarnings.push(...layout.warnings);
                }
            } finally {
                restoreMedia(flipped);
            }
        }
        const warnings = [...fonts.warnings, ...layoutWarnings];
        if (warnings.length && !confirmPrint(win, `${warnings.join('\n')}\n\nPrint anyway?`)) {
            win.close();
            return {printed: false, warnings, notes};
        }
        win.addEventListener('afterprint', () => win.close());
        win.focus();
        win.print();
        return {printed: true, warnings, notes};
    } catch (err) {
        try {
            win.close();
        } catch { /* already gone */
        }
        throw err;
    }
}

/**
 * Resolve once the print window has loaded: its load event, then every image
 * (remote images are not inlined, so they load here) and the web fonts.
 * readyState is no help: it can read 'complete' straight after
 * document.close() while images are still loading. A timeout caps the wait so
 * a stuck image cannot block the print dialog for ever.
 */
function whenLoaded(win, timeoutMs = 15000) {
    const loaded = new Promise((resolve) => win.addEventListener('load', () => resolve(), {once: true}));
    const imagesReady = () => Promise.all(Array.from(win.document.images || [], (img) => (
        img.complete ? null : new Promise((resolve) => {
            img.addEventListener('load', resolve, {once: true});
            img.addEventListener('error', resolve, {once: true});
        })
    )));
    let timer;
    const timeout = new Promise((resolve) => { timer = setTimeout(resolve, timeoutMs); });
    const ready = (async () => {
        await loaded;
        await imagesReady();
        try {
            await win.document.fonts.ready;
        } catch { /* fonts API unavailable: print anyway */
        }
    })();
    return Promise.race([ready, timeout]).finally(() => clearTimeout(timer));
}
