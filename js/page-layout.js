/**
 * page-layout.js
 * The page options that need the laid-out document (README, Export: Page options):
 * fit to size, the one continuous page's height, and the widest-block page width.
 *
 * The print document (js/print-document.js) has no scripts, so this runs from
 * outside on the loaded page, after fonts and images: the editor's print window
 * (js/pdf-export.js, with the print rules switched on while it measures:
 * simulatePrintMedia) and the PDF API's print page (server/src/renderer.mjs, in
 * emulated print). Both lay the document out as print at an explicit width: the
 * text column on pages, the whole page in the continuous layout (whose margin is
 * the body block's padding).
 *
 *   fit width   a block wider than the text column (a wide table, a wide image or
 *               a block of HTML) is scaled down to it with CSS zoom; one that needs
 *               less than the lower bound (PAGE_LIMITS.fitMinScale) is left as it is
 *               and warned about.
 *   fit widest  (continuous) the page is widened to hold the widest block, up to the
 *               page limit; what is still too wide is then scaled as for fit width.
 *   continuous  the document's height is measured and written as the page height.
 *               Past the longest page a PDF may have, it is split into the fewest
 *               tall pages that hold it, and a note says so.
 *
 * applyPageLayout() is self-contained (no imports, no module state), so the API can
 * pass it to Playwright's page.evaluate(), as js/image-check.js checkImages is.
 */

import {marginMm, PAGE_LIMITS, pageBoxMm} from './export-options.js';

/** Whether the page options need the laid-out document: the continuous layout or fit to size. */
export function needsPageLayout(pageOpts) {
    return Boolean(pageOpts) && (pageOpts.layout === 'continuous' || (pageOpts.fit && pageOpts.fit !== 'off'));
}

/**
 * Whether the page count is estimated before printing: a custom size on pages, the only way to very small
 * pages (a 2 MB document on 30 x 30 mm pages would be over 100,000 of them).
 */
export function needsPageEstimate(pageOpts) {
    return Boolean(pageOpts) && pageOpts.pageSize === 'Custom' && pageOpts.layout !== 'continuous';
}

/**
 * The pages the body would print, roughly: its laid-out height at the text column's width over the column's
 * height (a little under the real count, which page breaks add to). Self-contained, like applyPageLayout.
 * @param {{doc?: Document, widthMm: number, heightMm: number, marginMm: number}} opts  pageLayoutInput
 * @returns {number}
 */
export function estimatePages(opts) {
    const doc = opts.doc || document;
    const MM_PX = 96 / 25.4;
    const root = doc.documentElement;
    const margin = Number(opts.marginMm) || 0;
    const widthBefore = root.style.getPropertyValue('width');
    const priorityBefore = root.style.getPropertyPriority('width');
    root.style.setProperty('width', `${Math.max(1, (Number(opts.widthMm) - 2 * margin) * MM_PX)}px`, 'important');
    try {
        const body = doc.querySelector('.bd-page:not(.bd-page-cover)');
        const height = body ? body.getBoundingClientRect().height : root.scrollHeight;
        return Math.ceil(height / Math.max(1, (Number(opts.heightMm) - 2 * margin) * MM_PX));
    } finally {
        if (widthBefore) root.style.setProperty('width', widthBefore, priorityBefore);
        else root.style.removeProperty('width');
    }
}

/**
 * applyPageLayout's input from normalised page options (js/export-options.js): every value a number
 * or an allow-listed word, the limits from PAGE_LIMITS.
 * @param {object} pageOpts
 */
export function pageLayoutInput(pageOpts) {
    const {width, height} = pageBoxMm(pageOpts);
    return {
        layout: pageOpts.layout === 'continuous' ? 'continuous' : 'paged',
        fit: ['width', 'widest'].includes(pageOpts.fit) ? pageOpts.fit : 'off',
        widthMm: width,
        heightMm: height,
        marginMm: marginMm(pageOpts.margin),
        maxSideMm: PAGE_LIMITS.maxSideMm,
        maxAreaMm2: PAGE_LIMITS.maxAreaMm2,
        minScale: PAGE_LIMITS.fitMinScale,
        maxTotalMm: PAGE_LIMITS.maxContinuousMm,
    };
}

/**
 * Switch the document's print rules on and its screen rules off, so a screen window lays the
 * document out as print: every @media rule naming print (and not screen) is made "all", every one
 * naming screen (and not print) "not all". Gives back what it changed, for restoreMedia.
 * @param {Document} doc
 * @returns {{rule: CSSMediaRule, text: string}[]}
 */
export function simulatePrintMedia(doc) {
    const changed = [];
    const walk = (rules) => {
        for (const rule of Array.from(rules || [])) {
            if (rule.media && typeof rule.media.mediaText === 'string' && rule.cssRules) {
                const text = rule.media.mediaText;
                const t = text.toLowerCase();
                const print = /\bprint\b/.test(t);
                const screen = /\bscreen\b/.test(t);
                if (!/\bnot\b/.test(t) && print !== screen) {
                    changed.push({rule, text});
                    rule.media.mediaText = print ? t.replace(/\bprint\b/g, 'all') : 'not all';
                }
            }
            if (rule.cssRules) walk(rule.cssRules);
        }
    };
    for (const sheet of Array.from(doc.styleSheets)) {
        try {
            walk(sheet.cssRules);
        } catch { /* a sheet whose rules cannot be read */ }
    }
    return changed;
}

/** Put back the media rules simulatePrintMedia changed. */
export function restoreMedia(changed) {
    for (const {rule, text} of changed || []) rule.media.mediaText = text;
}

/**
 * Measure the print document and apply the page options that need its layout.
 * @param {{doc?: Document, layout: string, fit: string, widthMm: number, heightMm: number, marginMm: number,
 *          maxSideMm: number, maxAreaMm2: number, minScale: number, maxTotalMm: number}} opts
 *        (pageLayoutInput, plus the document in the editor)
 * @returns {{pageWidthMm: number, pageHeightMm: number|null, pages: number|null, contentHeightMm: number|null,
 *          scaled: {label: string, percent: number}[], advisories: string[], warnings: string[], tooLong: boolean}}
 *          pageHeightMm, pages and contentHeightMm: continuous only (null on pages); advisories: what was scaled,
 *          widened or split; warnings: a block left too wide (a defect strict refuses); tooLong: the document is
 *          longer than maxTotalMm (the API refuses it)
 */
export function applyPageLayout(opts) {
    const doc = opts.doc || document;
    const view = doc.defaultView || window;
    const MM_PX = 96 / 25.4;
    // Lengths in the notes to a tenth of a mm; in CSS to a thousandth (a custom size as given).
    const fmt = (n) => String(Math.round(n * 10) / 10);
    const css = (n) => String(Math.round(n * 1000) / 1000);
    const continuous = opts.layout === 'continuous';
    const fit = continuous ? opts.fit : (opts.fit === 'widest' ? 'width' : opts.fit);
    const margin = Number(opts.marginMm) || 0;
    const maxSide = Number(opts.maxSideMm) || 5080;
    const maxArea = Number(opts.maxAreaMm2) || Infinity;
    const minScale = Number(opts.minScale) || 0.4;
    const root = doc.documentElement;
    const out = {pageWidthMm: Number(opts.widthMm), pageHeightMm: null, pages: null, contentHeightMm: null,
        scaled: [], advisories: [], warnings: [], tooLong: false};

    const widthBefore = root.style.getPropertyValue('width');
    const priorityBefore = root.style.getPropertyPriority('width');
    // Laid out at the width print uses: the text column on pages, the page in the continuous layout.
    const layOut = (pageMm) => root.style.setProperty('width', `${(continuous ? pageMm : pageMm - 2 * margin) * MM_PX}px`, 'important');
    const column = () => doc.querySelector('.bd-page:not(.bd-page-cover) > [class^="template-"]');

    /** A block's name in the notes: Table 2, Image 1, Code block 3, else Block n (its place in the column). */
    function label(el, col) {
        const tag = el.localName;
        const kinds = {table: 'Table', pre: 'Code block', img: 'Image', svg: 'Image', figure: 'Figure', video: 'Video', iframe: 'Frame'};
        if (kinds[tag]) return `${kinds[tag]} ${Array.from(col.querySelectorAll(tag)).indexOf(el) + 1}`;
        let top = el;
        while (top.parentElement && top.parentElement !== col) top = top.parentElement;
        return `Block ${Array.from(col.children).indexOf(top) + 1}`;
    }

    const REPLACED = new Set(['img', 'svg', 'video', 'iframe', 'canvas', 'object', 'embed']);
    /** The outermost blocks that reach past the column: [{el, needPx (width from the column's left edge)}]. */
    function overflowing(col) {
        const box = col.getBoundingClientRect();
        const right = box.left + col.clientWidth;
        const found = [];
        const visit = (parent) => {
            for (const el of Array.from(parent.children)) {
                const cs = view.getComputedStyle(el);
                if (cs.display === 'none') continue;
                const inline = cs.display === 'inline' && !REPLACED.has(el.localName);
                const r = el.getBoundingClientRect();
                const scrolls = cs.overflowX !== 'visible' && el.scrollWidth > el.clientWidth + 1;
                const width = Math.max(r.width, scrolls ? el.scrollWidth + (r.width - el.clientWidth) : 0);
                if (!inline && r.width > 0 && (r.left + width > right + 0.5)) found.push({el, needPx: r.left - box.left + width});
                else visit(el);
            }
        };
        visit(col);
        return found;
    }

    try {
        layOut(out.pageWidthMm);
        let col = column();
        if (col && fit === 'widest') {
            const over = overflowing(col);
            if (over.length) {
                const widest = over.reduce((a, b) => (b.needPx > a.needPx ? b : a));
                const wantMm = Math.ceil((widest.needPx / MM_PX + 2 * margin) * 10) / 10;
                const pageMm = Math.min(maxSide, wantMm);
                if (pageMm > out.pageWidthMm) {
                    out.pageWidthMm = pageMm;
                    layOut(pageMm);
                    out.advisories.push(`The page is ${fmt(pageMm)} mm wide to fit ${label(widest.el, col)}.`);
                }
            }
        }
        if (col && fit !== 'off') {
            for (const {el} of overflowing(col)) {
                const name = label(el, col);
                const box = col.getBoundingClientRect();
                const available = box.left + col.clientWidth - el.getBoundingClientRect().left;
                let scale = 1;
                // Scaled, measured again and corrected: a zoomed table does not always shrink exactly in step.
                for (let i = 0; i < 4; i++) {
                    const r = el.getBoundingClientRect();
                    const cs = view.getComputedStyle(el);
                    const scrolls = cs.overflowX !== 'visible' && el.scrollWidth > el.clientWidth + 1;
                    const width = Math.max(r.width, scrolls ? el.scrollWidth * scale : 0);
                    if (width <= available + 0.5) break;
                    scale = Math.floor(scale * (available / width) * 1000) / 1000;
                    if (scale < minScale) break;
                    el.style.setProperty('zoom', String(scale));
                }
                if (scale < minScale) {
                    el.style.removeProperty('zoom');
                    const need = Math.max(1, Math.floor(scale * 100));
                    out.warnings.push(`${name} needs ${need}% to fit the page width; under the ${Math.round(minScale * 100)}% limit it is `
                        + `left at full size and runs past the margin. Use a wider page${continuous ? ' or fit widest' : ' or landscape'}.`);
                } else if (scale < 1) {
                    const percent = Math.floor(scale * 100);
                    out.scaled.push({label: name, percent});
                    out.advisories.push(`${name} is scaled to ${percent}% to fit the page width.`);
                }
            }
        }
        const rules = [];
        if (continuous) {
            // A cover takes its own height. One laid out against the page (a size container, absolutely placed
            // parts) has none of its own and would vanish or be cut: it gets the chosen page's height.
            for (const cover of Array.from(doc.querySelectorAll('.bd-page-cover .cover-page'))) {
                const cs = view.getComputedStyle(cover);
                const inner = cover.clientHeight - (parseFloat(cs.paddingTop) || 0) - (parseFloat(cs.paddingBottom) || 0);
                if (inner < 1 || cover.scrollHeight > cover.clientHeight + 1) {
                    cover.style.setProperty('--bd-page-height', `${css(Number(opts.heightMm))}mm`);
                    cover.style.setProperty('height', `${css(Number(opts.heightMm))}mm`, 'important');
                }
            }
            // Chromium prints a document wider than its page (a block fit left too wide, or fit off) laid
            // out up to half as wide again and scaled down to the page (its print shrink limit is 1.5): the
            // height is measured that way too. Past that the overflow is cut off at the page edge.
            // The content's own width (the body's), never the window's: a print window is wider than its page.
            const layoutPx = out.pageWidthMm * MM_PX;
            const shrink = Math.min(Math.max(1, (doc.body ? doc.body.scrollWidth : layoutPx) / layoutPx), 1.5);
            if (shrink > 1.001) root.style.setProperty('width', `${layoutPx * shrink}px`, 'important');
            const top = root.getBoundingClientRect().top;
            let bottom = 0;
            for (const page of Array.from(doc.querySelectorAll('.bd-page'))) bottom = Math.max(bottom, page.getBoundingClientRect().bottom - top);
            const contentMm = bottom / (shrink > 1.001 ? shrink : 1) / MM_PX;
            out.contentHeightMm = Math.round(contentMm * 10) / 10;
            // The longest page: the limit, and no more area than the largest page.
            const maxPage = Math.max(1, Math.min(maxSide, Math.floor(maxArea / out.pageWidthMm)));
            if (contentMm > Number(opts.maxTotalMm || Infinity)) out.tooLong = true;
            // A little room below the content (rounding), so it never spills onto a second page.
            const one = Math.ceil((contentMm + 0.5) * 10) / 10;
            if (one <= maxPage) {
                out.pages = 1;
                out.pageHeightMm = one;
            } else {
                // A page break can only fall between lines and rows, so each piece is given some room.
                const pages = Math.ceil(contentMm / (maxPage * 0.95));
                out.pages = pages;
                out.pageHeightMm = Math.min(maxPage, Math.ceil(((contentMm / pages) * 1.05 + 10) * 10) / 10);
                out.advisories.push(`The document is ${fmt(contentMm)} mm long, more than one PDF page can be (${fmt(maxPage)} mm), `
                    + `so it is split into ${pages} pages of ${fmt(out.pageHeightMm)} mm.`);
            }
            rules.push(`@page { size: ${css(out.pageWidthMm)}mm ${css(out.pageHeightMm)}mm; margin: 0; }`);
        }
        if (out.pageWidthMm !== Number(opts.widthMm)) rules.push(`:root { --bd-page-width: ${css(out.pageWidthMm)}mm; }`);
        if (rules.length) {
            // The id is reserved (js/markdown.js APP_ELEMENT_IDS), so no document element can answer to it; a style only.
            let style = doc.getElementById('bd-page-layout');
            if (!style || style.localName !== 'style') {
                style = doc.createElement('style');
                style.id = 'bd-page-layout';
                doc.head.appendChild(style);
            }
            style.textContent = rules.join('\n');
        }
        return out;
    } finally {
        if (widthBefore) root.style.setProperty('width', widthBefore, priorityBefore);
        else root.style.removeProperty('width');
    }
}
