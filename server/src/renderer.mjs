/**
 * Markdown to PDF in Chromium, with the network locked down in three layers:
 *
 *  1. Request interception (context.route): the only answers are the two
 *     internal pages (harness, print document) and repository files under
 *     js/, templates/, vendor/ and assets/ (src/assets.mjs). Everything else is
 *     aborted and noted as a warning by host.
 *  2. Chromium flags (src/browser.mjs): no name resolution and a dead proxy.
 *  3. A Content-Security-Policy on the print page: no scripts, frames or
 *     connections; images only as data: URIs; fonts and styles only from the
 *     render origin.
 *
 * The harness page (server/harness.html) runs the editor's export steps and
 * returns the print document; a second page loads it under the CSP and prints.
 */
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {ApiError} from './errors.mjs';
import {RENDER_ORIGIN, resolveAssetPath, assetContentType, blockedLabel} from './assets.mjs';
import {countPdfPages} from './pdf.mjs';
import {setPdfInfo} from './pdf-info.mjs';
import {tidyLastPage, TIDY} from './tidy.mjs';
import {LIMITS} from './options.mjs';
import {REPO_ROOT, SERVER_ROOT} from './paths.mjs';
import {MAX_EXPANDED_BYTES} from './config.mjs';
import {checkFonts, FONT_LOAD_TIMEOUT_MS} from '../../js/font-check.js';
import {FONT_FAMILIES} from '../../js/fonts.js';
import {checkImages, layoutViewportPx, MIN_PPI} from '../../js/image-check.js';
import {applyPageLayout, estimatePages, needsPageEstimate, needsPageLayout, pageLayoutInput} from '../../js/page-layout.js';
import {PAGE_LIMITS} from '../../js/export-options.js';

export const HARNESS_URL = `${RENDER_ORIGIN}/__bd/harness.html`;
export const PRINT_URL = `${RENDER_ORIGIN}/__bd/print.html`;
/** The scans shared by the harness and the Node side (src/untrusted.mjs, which has no imports). */
export const UNTRUSTED_URL = `${RENDER_ORIGIN}/__bd/untrusted.mjs`;

export const PRINT_CSP = [
    "default-src 'none'",
    `img-src data: ${RENDER_ORIGIN}`,
    `font-src ${RENDER_ORIGIN}`,
    `style-src 'unsafe-inline' ${RENDER_ORIGIN}`,
    "script-src 'none'",
    "frame-src 'none'",
    "connect-src 'none'",
].join('; ');

export const RENDER_TIMEOUT_MS = 20_000;
/** How long getting a browser (launching one, if need be) may take. */
export const ACQUIRE_TIMEOUT_MS = 30_000;
/** How long closing a render's context may take before the browser is killed. */
export const CLOSE_TIMEOUT_MS = 5_000;
/** How long the print page may wait for fonts and images before printing anyway. */
export const READY_CAP_MS = 5_000;

export {TIDY};

const TIMED_OUT = Symbol('timed out');

/** The promise's outcome, or a rejection with TIMED_OUT after ms. */
function withTimeout(promise, ms) {
    let timer;
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(TIMED_OUT), ms); });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * The error for a failed page.pdf(). Chromium answers "Printing failed" (its
 * renderer could not produce the PDF; the browser stays up) for a document it
 * laid out but cannot print in one go: seen for a single table of about 30,000
 * rows, while the same rows in tables of 2,000 print. A retry fails the same way,
 * so it is 413, not 500. Only that exact answer to Page.printToPDF (Playwright may add a
 * call log on the next lines); any other error (a crash, a near miss) is passed on.
 */
export function printFailure(err) {
    if (/^(?:page\.pdf: )?Protocol error \(Page\.printToPDF\): Printing failed$/m.test(String((err && err.message) || ''))) {
        return new ApiError(413, 'too_large_to_render', 'The PDF could not be printed: the document is too large or '
            + 'too complex for one PDF (one table of tens of thousands of rows can do this). Split it.');
    }
    return err;
}

/** The print document with the CSP as its first <head> element. */
export function withCsp(html) {
    const meta = `<meta http-equiv="Content-Security-Policy" content="${PRINT_CSP}">`;
    return html.replace(/<head>/i, `<head>\n  ${meta}`);
}

/** The URL in a Chromium CSP or mixed-content console message, as a host label. */
export function consoleBlockedLabel(text) {
    if (!/Content Security Policy|Mixed Content/i.test(text)) return null;
    const m = /'((?:https?|wss?|ftp|file):[^']*)'/i.exec(text);
    if (!m || m[1].startsWith(`${RENDER_ORIGIN}/__bd/`)) return null;
    return blockedLabel(m[1]);
}

/**
 * @param {{pool: import('./browser.mjs').BrowserPool, timeoutMs?: number, acquireTimeoutMs?: number,
 *          closeTimeoutMs?: number, readyCapMs?: number, assetRoot?: string, fontTimeoutMs?: number}} opts
 */
export function createRenderer({pool, timeoutMs = RENDER_TIMEOUT_MS, acquireTimeoutMs = ACQUIRE_TIMEOUT_MS,
    closeTimeoutMs = CLOSE_TIMEOUT_MS, readyCapMs = READY_CAP_MS, assetRoot = REPO_ROOT,
    maxExpandedBytes = MAX_EXPANDED_BYTES, fontTimeoutMs = FONT_LOAD_TIMEOUT_MS}) {
    const fileCache = new Map();
    let harnessHtml = null;

    async function cachedFile(file) {
        if (!fileCache.has(file)) fileCache.set(file, await readFile(file));
        return fileCache.get(file);
    }

    async function harness() {
        if (harnessHtml === null) harnessHtml = await readFile(join(SERVER_ROOT, 'harness.html'), 'utf8');
        return harnessHtml;
    }

    async function lockDown(context, blocked, getPrintHtml) {
        await context.route('**/*', async (route) => {
            const request = route.request();
            const url = request.url();
            try {
                if (url === HARNESS_URL) {
                    return await route.fulfill({status: 200, contentType: 'text/html; charset=utf-8', body: await harness()});
                }
                if (url === UNTRUSTED_URL) {
                    return await route.fulfill({status: 200, contentType: 'text/javascript; charset=utf-8',
                        body: await cachedFile(join(SERVER_ROOT, 'src/untrusted.mjs'))});
                }
                if (url === PRINT_URL) {
                    return await route.fulfill({
                        status: 200,
                        headers: {'content-type': 'text/html; charset=utf-8', 'content-security-policy': PRINT_CSP},
                        body: getPrintHtml(),
                    });
                }
                if (url === `${RENDER_ORIGIN}/favicon.ico`) return await route.fulfill({status: 404, body: ''});
                const file = request.method() === 'GET' ? await resolveAssetPath(url, assetRoot) : null;
                if (file) {
                    return await route.fulfill({status: 200, contentType: assetContentType(file), body: await cachedFile(file)});
                }
                blocked.add(blockedLabel(url));
                return await route.abort('blockedbyclient');
            } catch {
                // The context closed under us (timeout, crash): nothing to answer.
                return undefined;
            }
        });
    }

    async function run(context, input, blocked, {startedAt, deadline}) {
        let printHtml = '';
        await lockDown(context, blocked, () => printHtml);

        const harnessPage = await context.newPage();
        await harnessPage.goto(HARNESS_URL, {waitUntil: 'load'});
        await harnessPage.waitForFunction(() => window.__bdReady === true);
        const prepared = await harnessPage.evaluate((arg) => window.__bd.prepare(arg), {
            markdown: input.markdown,
            templateId: input.templateId,
            pageSize: input.pageSize,
            orientation: input.orientation,
            layout: input.layout,
            fit: input.fit,
            margin: input.margin,
            meta: input.meta || {},
            today: (input.today || new Date()).toISOString(),
            maxImageBytes: LIMITS.imageBytes,
            maxExpandedBytes,
            lang: input.lang,
            printLinks: input.printLinks,
            cover: input.cover,
        });
        // The harness page stays open when tidying: it reads the PDF's last page with pdf.js.
        // The continuous layout has no last page to tidy.
        const continuous = Boolean(prepared.pageOpts && prepared.pageOpts.layout === 'continuous');
        const tidyOn = input.tidy !== false && !continuous;
        if (!tidyOn) await harnessPage.close();
        if (prepared.tooLarge) {
            throw new ApiError(413, 'too_large', `The document would expand to more than ${Math.round(maxExpandedBytes / 1048576)} MB `
                + '(an embedded image counts once for every place it is used).');
        }
        printHtml = withCsp(prepared.html);

        const page = await context.newPage();
        page.on('console', (msg) => {
            const label = consoleBlockedLabel(msg.text());
            if (label) blocked.add(label);
        });
        await page.goto(PRINT_URL, {waitUntil: 'load'});
        await page.evaluate(async (cap) => {
            void document.body.offsetHeight; // lay out, so the fonts the text needs start loading
            const images = Array.from(document.images, (img) => img.decode().catch(() => {}));
            await Promise.race([
                Promise.all([document.fonts.ready, ...images]),
                new Promise((resolve) => setTimeout(resolve, cap)),
            ]);
        }, readyCapMs);
        // Every vendored face the text uses, loaded and confirmed (js/font-check.js);
        // evaluate() runs it although the page's CSP allows no scripts of its own.
        const fonts = await page.evaluate(checkFonts, {families: FONT_FAMILIES, timeoutMs: fontTimeoutMs});
        // Lay the page out as print, one text column wide (on pages) or one page wide (the
        // continuous layout, whose margin is the body's padding): js/image-check.js layoutViewportPx.
        await page.setViewportSize({width: Math.round(layoutViewportPx(prepared.pageOpts)), height: 1000});
        await page.emulateMedia({media: 'print'});
        // Very small custom pages: the page count is estimated, and past the limit refused before printing,
        // so one request cannot hold the memory and the time of tens of thousands of pages.
        if (needsPageEstimate(prepared.pageOpts)) {
            const estimate = await page.evaluate(estimatePages, pageLayoutInput(prepared.pageOpts));
            if (estimate > PAGE_LIMITS.maxPages) {
                const n = (value) => value.toLocaleString('en-GB');
                throw new ApiError(413, 'too_many_pages', `The document would print about ${n(estimate)} pages at this page size, `
                    + `more than the ${n(PAGE_LIMITS.maxPages)} a render prints. Use a larger pageSize or split the document.`);
            }
        }
        // The page options that need the layout (js/page-layout.js): fit to size, the widest block's
        // page width and the continuous page's height, written into the page before it prints.
        const layout = needsPageLayout(prepared.pageOpts)
            ? await page.evaluate(applyPageLayout, pageLayoutInput(prepared.pageOpts))
            : null;
        if (layout && layout.tooLong) {
            throw new ApiError(413, 'too_large_to_render', `The document is longer than ${PAGE_LIMITS.maxContinuousMm} mm, `
                + 'more than the continuous layout prints. Use layout=paged.');
        }
        if (layout && layout.pageWidthMm !== pageLayoutInput(prepared.pageOpts).widthMm) {
            // Widened for the widest block: the images are measured at the new width.
            await page.setViewportSize({width: Math.round((layout.pageWidthMm * 96) / 25.4), height: 1000});
        }
        // Image resolution at the printed size (js/image-check.js).
        const images = await page.evaluate(checkImages, {minPpi: MIN_PPI});
        // Two classes: warnings name real defects (strict refuses them); advisories are only reported.
        const warnings = [...prepared.warnings, ...fonts.warnings, ...images.warnings, ...(layout ? layout.warnings : [])];
        const advisories = [...(prepared.advisories || []), ...(layout ? layout.advisories : [])];
        // Tagged (structure tree, reading order) with an outline (bookmarks) from the headings.
        const pdfOptions = {preferCSSPageSize: true, printBackground: true, tagged: true, outline: true};
        const printStarted = Date.now();
        let pdf = await page.pdf(pdfOptions).catch((err) => { throw printFailure(err); });
        let pageHeightMm = layout ? layout.pageHeightMm : null;
        if (layout && layout.pages && countPdfPages(pdf) > layout.pages) {
            // The print laid a line or two past the measured height: once more, with room to spare (never past
            // the longest page, or the largest area, a page may have).
            const longest = Math.min(PAGE_LIMITS.maxSideMm, Math.floor(PAGE_LIMITS.maxAreaMm2 / layout.pageWidthMm));
            pageHeightMm = Math.min(longest, Math.ceil(layout.pageHeightMm * 1.01 + 5));
            await page.evaluate(({widthMm, heightMm}) => {
                const style = document.getElementById('bd-page-layout');
                if (style) style.textContent = style.textContent.replace(/size: [\d.]+mm [\d.]+mm/, `size: ${widthMm}mm ${heightMm}mm`);
            }, {widthMm: layout.pageWidthMm, heightMm: pageHeightMm});
            pdf = await page.pdf(pdfOptions).catch((err) => { throw printFailure(err); });
        }
        if (layout && layout.pages) {
            // The note names the pages the PDF has: a block that cannot break (a tall image, a table row) can add one.
            const printed = countPdfPages(pdf);
            const at = advisories.findIndex((n) => / so it is split into \d+ pages of [\d.]+ mm\.$/.test(n));
            if (at > -1 && printed !== layout.pages) {
                advisories[at] = advisories[at].replace(/split into \d+ pages of [\d.]+ mm\.$/, `split into ${printed} pages of ${pageHeightMm} mm.`);
            } else if (at === -1 && printed > 1) {
                advisories.push(`The document is ${layout.contentHeightMm} mm long and printed on ${printed} pages of ${pageHeightMm} mm: `
                    + 'a block that cannot break moved onto another page.');
            }
        }
        const firstMs = Date.now() - printStarted;
        let tidy = null;
        if (tidyOn) {
            // Opportunistic (src/tidy.mjs): on an error or out of time, the first print stands.
            const result = await tidyLastPage({
                first: pdf, pages: countPdfPages(pdf), firstMs, cover: prepared.cover, startedAt, timeoutMs, deadline,
                printAt: async (scale) => {
                    await page.evaluate(({zoom}) => {
                        let style = document.getElementById('bd-tidy');
                        if (!style) {
                            style = document.createElement('style');
                            style.id = 'bd-tidy';
                            document.head.appendChild(style);
                        }
                        style.textContent = `.bd-page:not(.bd-page-cover) > [class^="template-"] { zoom: ${zoom}; }`;
                    }, {zoom: scale / 100});
                    return page.pdf(pdfOptions);
                },
                count: (buffer) => harnessPage.evaluate((b64) => window.__bd.pageWords(b64), buffer.toString('base64')),
            });
            ({pdf, tidy} = result);
            // Advisory: a short last page is reported, never a reason for strict to refuse.
            if (result.warning) advisories.push(result.warning);
        }
        pdf = setPdfInfo(pdf, {title: prepared.title, author: prepared.print.author, subject: prepared.print.subject,
            firstHeading: prepared.firstHeading});
        return {pdf, title: prepared.title, warnings, advisories, tidy};
    }

    /**
     * @param {{markdown: string, templateId: string, pageSize?: string, orientation?: string,
     *          meta?: object, today?: Date, lang?: string, printLinks?: boolean, cover?: boolean,
     *          tidy?: boolean}} input
     * @returns {Promise<{pdf: Buffer, pages: number, title: string, warnings: string[], advisories: string[],
     *          tidy: number|null}>}
     *          warnings: defects strict refuses (fonts, images, blocked requests, template checks);
     *          advisories: reported only (a nearly empty last page);
     *          tidy: the body scale in % after the last-page tidy, null when it was off
     */
    async function render(input) {
        const timeoutError = () => new ApiError(504, 'render_timeout',
            `The render took longer than ${Math.round(timeoutMs / 1000)} seconds.`);

        // 1. A browser, within its own time limit. A launch or hand-out that never
        //    finishes means a wedged browser: kill it and give the slot back.
        let abandoned = false;
        const acquiring = pool.acquire().then((l) => {
            if (abandoned) {
                l.release();
                return null;
            }
            return l;
        });
        const lease = await withTimeout(acquiring, acquireTimeoutMs).catch((err) => {
            abandoned = true;
            if (err === TIMED_OUT) {
                pool.forceRestart();
                throw timeoutError();
            }
            throw new ApiError(500, 'render_failed', 'The PDF could not be rendered. Try again.');
        });

        // 2. The render, context creation included, within the render time limit.
        let context = null;
        let finished = false;
        const blocked = new Set();
        const startedAt = Date.now();
        const deadline = startedAt + timeoutMs - TIDY.marginMs;
        try {
            const work = (async () => {
                const created = await lease.browser.newContext({
                    acceptDownloads: false,
                    serviceWorkers: 'block',
                    bypassCSP: false,
                    javaScriptEnabled: true,
                });
                if (finished) {
                    created.close().catch(() => {});
                    throw new Error('late context');
                }
                context = created;
                return run(created, input, blocked, {startedAt, deadline});
            })();
            work.catch(() => {});
            const result = await withTimeout(work, timeoutMs).catch((err) => {
                throw err === TIMED_OUT ? timeoutError() : err;
            });
            const extra = [...blocked].sort().map((host) => `Blocked a request to ${host}.`);
            const warnings = [...new Set([...result.warnings, ...extra])];
            if (typeof pool.renderSucceeded === 'function') pool.renderSucceeded();
            return {pdf: result.pdf, pages: countPdfPages(result.pdf), title: result.title, warnings,
                advisories: result.advisories, tidy: result.tidy};
        } catch (err) {
            if (err instanceof ApiError) throw err;
            // Never pass Chromium's error text on: it can quote the document.
            throw new ApiError(500, 'render_failed', 'The PDF could not be rendered. Try again.');
        } finally {
            finished = true;
            // 3. Closing the context, within its own time limit. A context that was
            //    never handed out, or one that does not close, means a wedged
            //    browser: kill it (a crashed one, no longer connected, is left be).
            let closed = false;
            if (context) closed = await withTimeout(context.close(), closeTimeoutMs).then(() => true, () => false);
            const connected = typeof lease.browser.isConnected === 'function' ? lease.browser.isConnected() : true;
            if (!closed && connected && typeof lease.kill === 'function') lease.kill();
            lease.release();
        }
    }

    return {render};
}
