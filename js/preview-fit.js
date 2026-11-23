/**
 * js/preview-fit.js
 *
 * The live preview's page cards grow to fill the preview pane: the laid-out page (at its
 * paper width, so its line breaks match the PDF) is scaled as a picture, never reflowed.
 */

/** The largest scale the preview grows a page to; wider than that, the page is centred. */
export const PREVIEW_MAX_SCALE = 2;

/**
 * How the page cards fit a pane.
 * @param {number} available  the pane's inner width (inside its padding), in px
 * @param {number} pageWidth  the page card's width at 100%, in px
 * @param {number} [max]      the largest scale
 * @returns {{scale: number, offset: number}} scale 1 when the pane is no wider than the page
 *          (the cards then narrow to the pane as before); offset is the left margin that
 *          centres the scaled page, 0 unless the largest scale is reached
 */
export function previewFit(available, pageWidth, max = PREVIEW_MAX_SCALE) {
    if (!(available > 0) || !(pageWidth > 0) || available <= pageWidth) return {scale: 1, offset: 0};
    const scale = Math.min(max, available / pageWidth);
    return {scale, offset: Math.max(0, (available - pageWidth * scale) / 2)};
}

/**
 * Scale the preview to its pane. #preview is laid out at the page's width and drawn scaled
 * with a transform (no reflow); a bottom margin gives the pane the scaled height to scroll.
 * Measurements of the preview's own layout (offsetWidth, clientWidth) stay unscaled.
 * @param {HTMLElement} pane     #preview-pane
 * @param {HTMLElement} preview  #preview
 * @returns {number} the scale applied
 */
export function fitPreviewToPane(pane, preview) {
    const view = pane.ownerDocument.defaultView;
    const style = view.getComputedStyle(pane);
    const available = pane.clientWidth - parseFloat(style.paddingLeft || '0') - parseFloat(style.paddingRight || '0');
    const pageWidth = parseFloat(style.getPropertyValue('--preview-page-width')) || 794;
    const hasPages = !!preview.querySelector('.preview-page');
    const {scale, offset} = hasPages && pane.getClientRects().length ? previewFit(available, pageWidth) : {scale: 1, offset: 0};
    const s = preview.style;
    if (scale === 1) {
        for (const p of ['width', 'transform', 'transform-origin', 'margin-left', 'margin-bottom', 'min-height']) s.removeProperty(p);
        delete preview.dataset.scale;
        return 1;
    }
    s.width = pageWidth + 'px';
    s.transformOrigin = '0 0';
    s.transform = `scale(${scale})`;
    s.marginLeft = offset + 'px';
    s.minHeight = '0';
    s.marginBottom = (preview.offsetHeight * (scale - 1)) + 'px';
    preview.dataset.scale = String(Math.round(scale * 1000) / 1000);
    return scale;
}

/**
 * Keep the preview fitted: when the pane changes size (window, sidebar, editor shown or
 * hidden, divider, full width preview) and when the preview's content changes height.
 * @returns {() => number} fit now (after a page size change or a new render)
 */
export function watchPreviewFit(pane, preview) {
    const fit = () => fitPreviewToPane(pane, preview);
    const View = pane.ownerDocument.defaultView;
    if (typeof View.ResizeObserver === 'function') {
        let frame = 0;
        const ro = new View.ResizeObserver(() => {
            if (frame) return;
            frame = View.requestAnimationFrame(() => { frame = 0; fit(); });
        });
        ro.observe(pane);
        ro.observe(preview);
    }
    return fit;
}
