/**
 * export-pipeline.js
 * Everything an export needs from a Markdown source and a template, before any
 * window, file or network step: metadata, preflight warnings, validated page
 * options, the sanitised body and the cover.
 *
 * Pure: no document, window or app state. Rendering needs the marked, DOMPurify
 * and highlight.js globals (vendor/ scripts) and configureMarked() to have run,
 * so a headless page that loads those scripts can call it exactly like the app.
 */

import {applyTemplateTransform, renderMarkdown} from './markdown.js';
import {buildDocMeta, buildPrintMeta, parseFrontMatter} from './doc-meta.js';
import {
    EXPORT_DEFAULTS, frontMatterPageOpts, marginMm, normalizeExportOpts, pageBoxMm, pageOptsProblem, PAGE_LIMITS,
    templatePageDefaults, templatePageSizes, validMargin, validPageBackground,
} from './export-options.js';
import {normalizeRunning, RUNNING_LIMITS} from './page-chrome.js';

/** The page options a caller may give, which win over the front matter's. */
const PAGE_KEYS = ['format', 'pageSize', 'orientation', 'customSize', 'layout', 'fit', 'margin'];

/**
 * @param {string} source  Markdown, optionally starting with front matter
 *        (js/doc-meta.js parseFrontMatter), which is stripped from the body and
 *        feeds the cover title, author, date and subject
 * @param {{manifest?: object, template?: object}|null} templateEntry  an entry from js/templates.js
 * @param {{pageSize?: string, orientation?: string, customSize?: string, layout?: string, fit?: string, margin?: string,
 *          date?: Date, allowIframes?: boolean, meta?: {title?: string, author?: string, date?: string, subject?: string},
 *          lang?: string, printLinks?: boolean}} [opts]
 *        page options (untrusted, validated here; what is left unset comes from the front matter's
 *        page-size, layout, fit and margin, and then the template: margin is an override of the
 *        template's), the fallback cover date (default today), whether allow-listed iframes are kept,
 *        explicit metadata that wins over the front matter (empty values fall through),
 *        and the print options that win over front matter `lang` and `print-links`
 * @returns {{
 *   doc: {title: string, author: string, date: string, brand: string, subject: string},
 *   warnings: string[],
 *   advisories: string[],
 *   bodyHTML: string,
 *   coverHTML: string,
 *   pageOpts: {format: string, pageSize: string, orientation: string, margin: string, layout: string, fit: string,
 *              customSize?: string},
 *   print: {lang: string, author: string, subject: string, printLinks: boolean,
 *           pageBackground?: string, running?: object, date?: string},
 * }}
 *   doc: what renderCover and preflightChecks receive (subject: front matter `subject` or meta.subject, else '')
 *   warnings: defects (a template's checks, a front matter value that is not valid)
 *   advisories: notes on the page options that are not defects: a running head and foot left out because the
 *   margin chosen is under what they need, a margin reduced to leave room for the text
 *   print: what buildPrintDocument() writes into the print document beyond the body; pageBackground
 *   (the template's pageBackground, the body pages' canvas colour) and running (the running head and foot, js/page-chrome.js) with the
 *   date it may show are there only when the template has them
 */
export function prepareExport(source, templateEntry, opts = {}) {
    const options = opts && typeof opts === 'object' ? opts : {};
    const template = (templateEntry && templateEntry.template) || null;
    const manifest = (templateEntry && templateEntry.manifest) || {};
    const sanitiseOpts = {allowIframes: options.allowIframes !== false};

    const given = options.meta && typeof options.meta === 'object' ? options.meta : {};
    const printMeta = buildPrintMeta(source, {lang: options.lang, subject: given.subject, printLinks: options.printLinks});
    const doc = {
        ...buildDocMeta(source, {
            title: given.title, author: given.author, date: given.date,
            today: options.date instanceof Date ? options.date : new Date(),
        }),
        subject: printMeta.subject,
    };
    const {meta, body} = parseFrontMatter(source);
    const warnings = template && typeof template.preflightChecks === 'function'
        ? Array.from(template.preflightChecks(doc) || [], String)
        : [];
    warnings.push(...printMeta.warnings);
    // The page options: the caller's, else the front matter's, else the template's.
    const fromMeta = frontMatterPageOpts(meta);
    warnings.push(...fromMeta.warnings);
    const chosen = {...fromMeta.opts};
    for (const key of PAGE_KEYS) if (options[key] !== undefined && options[key] !== null) chosen[key] = options[key];
    const templateMargin = validMargin(manifest.page && manifest.page.margin) || EXPORT_DEFAULTS.margin;
    let pageOpts = normalizeExportOpts(chosen, {
        margin: templateMargin, sizes: templatePageSizes(manifest), ...templatePageDefaults(manifest),
    });
    if (chosen.fit === 'widest' && options.fit == null && pageOpts.layout !== 'continuous') {
        warnings.push('The front matter\'s fit: widest needs layout: continuous, so fit width was used.');
    }
    const advisories = [];
    if (pageOptsProblem(pageOpts)) {
        // A margin too large for the page (a small custom size, another template's margin): reduced to leave the text room.
        const {width, height} = pageBoxMm(pageOpts);
        const side = pageOpts.layout === 'continuous' ? width : Math.min(width, height);
        const fitted = `${Math.max(0, Math.floor((side - PAGE_LIMITS.minContentMm) / 2))}mm`;
        advisories.push(`The margin is reduced to ${fitted}, so the page keeps ${PAGE_LIMITS.minContentMm} mm for the text.`);
        pageOpts = {...pageOpts, margin: fitted};
    }
    // transformHTML output is sanitised again inside applyTemplateTransform.
    const bodyHTML = applyTemplateTransform(renderMarkdown(body, sanitiseOpts), template, sanitiseOpts);
    const coverHTML = template && typeof template.renderCover === 'function'
        ? String(template.renderCover(doc) || '')
        : '';

    const print = {lang: printMeta.lang, author: doc.author, subject: printMeta.subject, printLinks: printMeta.printLinks};
    const pageBackground = validPageBackground(template && template.pageBackground);
    if (pageBackground) print.pageBackground = pageBackground;
    const running = normalizeRunning(template);
    if (running) Object.assign(print, {running, date: doc.date});
    // A margin chosen under what the running head and foot need leaves them out (js/page-chrome.js): say so.
    // The template's own margin, and the continuous page (which has none), print as the template intends.
    if (running && pageOpts.layout === 'paged' && pageOpts.margin !== templateMargin
        && marginMm(pageOpts.margin) < RUNNING_LIMITS.minMarginMm) {
        advisories.push(`The running head and foot are left out: the margin (${pageOpts.margin}) is under the `
            + `${RUNNING_LIMITS.minMarginMm} mm they need.`);
    }
    return {doc, warnings, advisories, bodyHTML, coverHTML, pageOpts, print};
}
