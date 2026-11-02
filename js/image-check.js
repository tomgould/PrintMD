/**
 * image-check.js
 * Effective resolution of the raster images in a document at the size they
 * print: ppi = natural width in pixels / printed width in inches (CSS px / 96).
 * Under MIN_PPI an image prints soft, so it gets a warning. SVG is vector and
 * never checked. Images are never resampled by PrintMD: the editor embeds
 * the original file and the PDF holds it at its own pixel size.
 *
 * checkImages() is self-contained (no imports, no module state), so the PDF
 * API can pass it to Playwright's page.evaluate() on the script-free print page.
 */

import {marginMm, pageBoxMm} from './export-options.js';

/** Effective resolution below which an image is reported. */
export const MIN_PPI = 150;

/**
 * Width of the printed text column in CSS px: the page width (a custom size's too) less both margins.
 * @param {{pageSize?: string, orientation?: string, margin?: string, customSize?: string}} pageOpts  normalised options
 * @returns {number}
 */
export function printContentWidthPx(pageOpts = {}) {
    const {width} = pageBoxMm(pageOpts);
    const margin = marginMm(String((pageOpts && pageOpts.margin) || '20mm'));
    return Math.max(1, (width - 2 * margin) * 96 / 25.4);
}

/**
 * The width in CSS px to lay the print document out at as print (the PDF API's viewport): the text
 * column on pages, whose margin is the page's; the whole page in the continuous layout, whose margin
 * is the body block's padding (js/print-document.js).
 * @param {object} pageOpts  normalised options
 * @returns {number}
 */
export function layoutViewportPx(pageOpts = {}) {
    return pageOpts && pageOpts.layout === 'continuous' ? pageBoxMm(pageOpts).width * 96 / 25.4 : printContentWidthPx(pageOpts);
}

/**
 * @param {{doc?: Document, root?: string, minPpi?: number, scale?: number, columnPx?: number,
 *          maxWidthPx?: number}} [opts]
 *        root: selector of the containers whose images count (default: the body pages, not the cover);
 *        scale: printed width / measured width (the editor's preview is not the printed column);
 *        columnPx: the measured column, so only images that fill it are scaled;
 *        maxWidthPx: the printed column width, the widest an image can print
 * @returns {{warnings: string[], images: {index: number, naturalWidth: number, printedPx: number, ppi: number}[]}}
 */
export function checkImages(opts = {}) {
    const doc = opts.doc || document;
    const minPpi = opts.minPpi || 150;
    const scale = opts.scale || 1;
    const maxWidthPx = opts.maxWidthPx || Infinity;
    const roots = Array.from(doc.querySelectorAll(opts.root || '.bd-page:not(.bd-page-cover)'));
    const isVector = (src) => /^data:image\/svg\+xml/i.test(src) || /\.svg(?:[?#]|$)/i.test(src);
    const images = [];
    const warnings = [];
    let index = 0;
    for (const root of roots) {
        for (const img of Array.from(root.querySelectorAll('img'))) {
            const src = img.currentSrc || img.getAttribute('src') || '';
            if (isVector(src)) continue;
            index++;
            const shown = img.getBoundingClientRect().width;
            if (!img.naturalWidth || !shown) continue;
            // An image narrower than the measured column keeps its size in print;
            // one that fills it (max-width: 100%) follows the column's width.
            const fills = !opts.columnPx || shown >= opts.columnPx * 0.98;
            const printedPx = Math.min(fills ? shown * scale : shown, maxWidthPx);
            const ppi = Math.round(img.naturalWidth / (printedPx / 96));
            images.push({index, naturalWidth: img.naturalWidth, printedPx: Math.round(printedPx), ppi});
            if (ppi < minPpi) {
                warnings.push(`Image ${index} is about ${ppi} ppi at the size it prints; ${minPpi} or more prints sharply.`);
            }
        }
    }
    return {warnings, images};
}

/**
 * The editor's check before a PDF export: the images in the live preview,
 * scaled from the preview's column to the printed one.
 * @param {HTMLElement|null} preview  the preview container (#preview)
 * @param {{pageSize?: string, orientation?: string, margin?: string}} pageOpts
 * @returns {string[]}
 */
export function previewImageWarnings(preview, pageOpts) {
    if (!preview || !preview.ownerDocument || typeof preview.getBoundingClientRect !== 'function') return [];
    const view = preview.ownerDocument.defaultView;
    const style = view.getComputedStyle(preview);
    const column = preview.clientWidth - parseFloat(style.paddingLeft || '0') - parseFloat(style.paddingRight || '0');
    if (!(column > 0)) return [];
    const printed = printContentWidthPx(pageOpts);
    const id = preview.id ? `#${preview.id}` : null;
    if (!id) return [];
    return checkImages({doc: preview.ownerDocument, root: id, scale: printed / column, columnPx: column, maxWidthPx: printed}).warnings;
}
