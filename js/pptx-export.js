/**
 * js/pptx-export.js
 * PowerPoint (.pptx) export using the vendored PptxGenJS browser bundle.
 *
 * Each `---`, H1 and H2 starts a slide (js/slides.js). On a slide: paragraphs,
 * block quotes, H3 to H6, bullet, numbered, nested and task lists (with bold,
 * italic, code and link runs), code blocks in a monospace box, tables as real
 * PowerPoint tables, and images pasted into the document (data: URLs). Other
 * images are skipped with a warning. A section longer than one slide continues
 * on "Title (cont.)" slides.
 *
 * pptxBlocksFromHtml and hexColor are pure; pptxBlob and exportPptx are
 * browser-only (PptxGenJS global, image measuring).
 */

import {
    BODY_PT, CODE_PT, TABLE_PT, blockHeight, isTextBlock, paginateSection, pushAll, slideBlocks, slideFrame,
    SLIDE_SIZES, splitIntoSlides, tableColumns,
} from './slides.js';

/**
 * Most content slides a deck gets. A longer document is cut there with a
 * warning: a deck of thousands of slides is no use to anyone and takes long
 * to build; PDF and Word export keep the whole document.
 */
export const MAX_CONTENT_SLIDES = 500;
import {downloadBlob, toFilenameSafe} from './download.js';
import {stripXmlIllegal} from './xml-safe.js';
import {loadPptxGen} from './import-utils.js';

export {slideFrame, slideLineBudget} from './slides.js';

// ─── Pure helpers (Node-testable) ───────────────────────────────────────────

/**
 * One slide's HTML as content blocks (see slideBlocks in js/slides.js).
 * @param {string} html
 * @returns {Array<object>}
 */
export function pptxBlocksFromHtml(html) {
    if (!html || html.trim() === '') {
        return [];
    }
    return slideBlocks(html);
}

const PPR_RE = /<a:pPr\b[^>]*\/>|<a:pPr\b[^>]*>[\s\S]*?<\/a:pPr>/g;

/**
 * Slide XML with at most one a:pPr per paragraph, as its first child, as the
 * schema requires. PptxGenJS writes one a:pPr before every run of a paragraph
 * with mixed formatting, which PowerPoint may answer with a repair prompt.
 * The first a:pPr (the one with the paragraph's spacing and bullet) is kept.
 * @param {string} xml  a slide part
 * @returns {string}
 */
export function singleParagraphProps(xml) {
    return String(xml).replace(/<a:p>([\s\S]*?)<\/a:p>/g, (whole, inner) => {
        const props = inner.match(PPR_RE);
        if (!props || (props.length === 1 && inner.startsWith(props[0]))) return whole;
        return `<a:p>${props[0]}${inner.replace(PPR_RE, '')}</a:p>`;
    });
}

/**
 * Strip a leading '#' from a colour string, uppercase, fallback for falsy/invalid.
 * @param {string} c
 * @returns {string}
 */
export function hexColor(c) {
    if (!c || typeof c !== 'string') {
        return '1E3A5F';
    }
    const cleaned = c.replace(/^#/, '').trim().toUpperCase();
    if (!cleaned || !/^[0-9A-F]{3,8}$/.test(cleaned)) {
        return '1E3A5F';
    }
    return cleaned;
}

// ─── Browser-only generation + download ─────────────────────────────────────

const MONO_FONT = 'Courier New';
const TEXT_COLOR = '333333';
/** Image types PowerPoint shows everywhere; anything else is skipped with a warning. */
const EMBEDDABLE_IMAGE_RE = /^data:image\/(?:png|jpe?g|gif);base64,/i;
const PX_PER_INCH = 96;

function measureImage(src) {
    const img = new Image();
    img.src = src;
    return img.decode().then(() => ({w: img.naturalWidth, h: img.naturalHeight}));
}

/**
 * Size each image block to fit the content area (never enlarged), and drop
 * the ones PowerPoint cannot embed, reporting each through `warn`.
 */
async function sizeImages(blocks, frame, warn) {
    const out = [];
    for (const b of blocks) {
        if (b.kind !== 'image') {
            out.push(b);
            continue;
        }
        const label = b.src.startsWith('data:') ? `"${b.alt || 'image'}"` : b.src;
        if (!EMBEDDABLE_IMAGE_RE.test(b.src)) {
            warn(`Skipped image ${label}: PowerPoint export embeds PNG, JPEG and GIF images pasted into the document only.`);
            continue;
        }
        try {
            const {w, h} = await measureImage(b.src);
            const wIn = w / PX_PER_INCH;
            const hIn = h / PX_PER_INCH;
            const scale = Math.min(1, frame.cw / wIn, (frame.ch - 0.3) / hIn);
            out.push({...b, w: wIn * scale, h: hIn * scale});
        } catch (_e) {
            warn(`Skipped image ${label}: it could not be read.`);
        }
    }
    return out;
}

/** Deepest paragraph level a slide allows (lvl 0 to 8). */
const MAX_LEVEL = 8;
/** Largest startAt a PowerPoint auto-numbered paragraph allows. */
const MAX_START_AT = 32767;

/** Whether a numbered item can use PowerPoint's own numbering (its list starts at 1 or more, within range). */
function autoNumberable(b) {
    return b.start >= 1 && b.number >= 1 && b.number <= MAX_START_AT;
}

/**
 * PptxGenJS text objects for one text block: one paragraph, ending in breakLine.
 * `startAt` is the number a numbered item's run of paragraphs starts from.
 */
function textObjects(b, theme, startAt) {
    // Run properties go on every run; paragraph properties (spacing, bullet, level) only on the
    // first, because PptxGenJS writes an a:pPr for each run that carries any.
    const para = {fontFace: theme.fontFace, fontSize: BODY_PT, color: TEXT_COLOR};
    if (b.kind === 'heading') Object.assign(para, {fontSize: 16, bold: true, color: theme.accent});
    if (b.kind === 'quote') Object.assign(para, {italic: true, color: '555555'});
    const first = {paraSpaceAfter: 6};
    let prefix = '';
    if (b.kind === 'bullet') {
        first.indentLevel = Math.min(Math.max(0, b.level), MAX_LEVEL);
        // The rest of an item split across slides: same indent, no second bullet or number.
        if (b.cont) first.bullet = {code: '00A0'};
        else if (b.checkbox != null) first.bullet = {code: b.checkbox ? '2611' : '2610'};
        else if (b.ordered && autoNumberable(b)) first.bullet = {type: 'number', numberStartAt: startAt || b.start};
        else if (b.ordered) {
            // PowerPoint numbers from 1 to 32767 only: other numbers are written out.
            first.bullet = {code: '00A0'};
            prefix = `${b.number}. `;
        } else first.bullet = true;
    }
    const objs = [];
    if (prefix) objs.push({text: prefix, options: {...para, ...first}});
    let softBreak = false;
    for (const r of b.runs) {
        if (r.br) {
            softBreak = true;
            continue;
        }
        const options = {...para, ...(objs.length ? {} : first)};
        if (r.bold) options.bold = true;
        if (r.italic) options.italic = true;
        if (r.code) options.fontFace = MONO_FONT;
        if (r.strike) options.strike = 'sngStrike';
        if (r.underline) options.underline = {style: 'sng'};
        if (r.href) options.hyperlink = {url: r.href};
        if (softBreak) options.softBreakBefore = true;
        softBreak = false;
        objs.push({text: r.text, options});
    }
    // Without breakLine the next block's text would join this paragraph.
    if (objs.length) objs[objs.length - 1].options.breakLine = true;
    return objs;
}

function tableRows(b, theme) {
    return b.rows.map((row, ri) => row.map((c) => ({
        text: c.text,
        options: {
            bold: c.header,
            color: c.header ? 'FFFFFF' : TEXT_COLOR,
            fill: {color: c.header ? theme.accent : (ri % 2 ? 'F5F7FA' : 'FFFFFF')},
            ...(c.colspan > 1 ? {colspan: c.colspan} : {}),
            ...(c.rowspan > 1 ? {rowspan: c.rowspan} : {}),
            ...(c.align ? {align: c.align} : {}),
        },
    })));
}

/** Put one paginated slide's blocks on `slide`, top to bottom. */
function renderBlocks(slide, blocks, frame, theme) {
    let y = frame.y;
    let group = [];
    const flushText = () => {
        if (!group.length) return;
        const h = group.reduce((n, b) => n + blockHeight(b, frame), 0) + 0.1;
        // A numbered list continued from the previous slide counts on from its first item here.
        const firstNumber = new Map();
        const objs = group.flatMap((b) => {
            if (b.kind === 'bullet' && b.ordered && !b.cont && autoNumberable(b) && !firstNumber.has(b.list)) {
                firstNumber.set(b.list, b.number);
            }
            return textObjects(b, theme, firstNumber.get(b.list));
        });
        slide.addText(objs, {x: frame.x, y, w: frame.cw, h, valign: 'top'});
        y += h;
        group = [];
    };
    for (const b of blocks) {
        if (isTextBlock(b)) {
            group.push(b);
            continue;
        }
        flushText();
        const h = blockHeight(b, frame);
        if (b.kind === 'code') {
            const lines = b.lines.map((line, i) => ({text: line || ' ', options: {breakLine: i < b.lines.length - 1}}));
            slide.addText(lines, {
                x: frame.x, y, w: frame.cw, h: h - 0.15, valign: 'top',
                fontFace: MONO_FONT, fontSize: CODE_PT, color: '1F2937', fill: {color: 'F3F4F6'},
            });
        } else if (b.kind === 'table') {
            const cols = tableColumns(b.rows);
            slide.addTable(tableRows(b, theme), {
                x: frame.x, y, w: frame.cw, colW: Array(cols).fill(frame.cw / cols),
                fontFace: theme.fontFace, fontSize: TABLE_PT, border: {type: 'solid', pt: 0.75, color: 'CCCCCC'},
                autoPage: false,
            });
        } else if (b.kind === 'image') {
            slide.addImage({data: b.src, x: frame.x + (frame.cw - b.w) / 2, y, w: b.w, h: b.h, altText: b.alt});
        }
        y += h;
    }
    flushText();
}

/**
 * Build a Blob for PowerPoint (.pptx) export via PptxGenJS.
 * Pure generation: no download side-effect.
 * @param {{ title: string, author: string, date: string, brand: string }} doc
 *        prepareExport's `doc`: the cover slide and the core properties
 * @param {{ manifest: object, styles: string, template: object }} templateEntry
 * @param {string} renderedHTML  sanitised body HTML, front matter already removed
 * @param {{ orientation?: string, pageSize?: string, onWarning?: (message: string) => void }} [opts]
 *        onWarning hears about each image left out (default: console.warn)
 * @returns {Promise<Blob>}
 */
export async function pptxBlob(doc, templateEntry, renderedHTML, opts = {}) {
    if (typeof PptxGenJS === 'undefined') {
        throw new Error('PptxGenJS not loaded');
    }
    if (typeof JSZip === 'undefined') {
        throw new Error('JSZip not loaded');
    }
    const report = typeof opts.onWarning === 'function' ? opts.onWarning : (m) => console.warn(m);
    const reported = new Set();
    const warn = (m) => {
        if (!reported.has(m)) {
            reported.add(m);
            report(m);
        }
    };
    // Metadata reaches the cover, the footers and docProps/core.xml: XML-safe first.
    doc = {...doc, title: stripXmlIllegal(doc.title), author: stripXmlIllegal(doc.author), date: stripXmlIllegal(doc.date)};

    const pptx = new PptxGenJS();
    pptx.title = doc.title || '';
    pptx.author = doc.author || '';
    pptx.subject = doc.title || '';

    pptx.defineLayout({name: 'PORTRAIT', width: SLIDE_SIZES.portrait.w, height: SLIDE_SIZES.portrait.h});
    pptx.defineLayout({name: 'LANDSCAPE', width: SLIDE_SIZES.landscape.w, height: SLIDE_SIZES.landscape.h});
    const orientation = opts.orientation === 'landscape' ? 'landscape' : 'portrait';
    pptx.layout = orientation === 'landscape' ? 'LANDSCAPE' : 'PORTRAIT';
    const frame = slideFrame(orientation);

    const layoutHeight = frame.h;
    const slideW = frame.w;

    const manifest = (templateEntry && templateEntry.manifest) || {};
    const accent = hexColor(manifest.accent);
    const fontFace = (manifest.fontStack || 'Arial')
        .split(',')[0]
        .replace(/['"]/g, '')
        .trim();

    // ── Cover slide ─────────────────────────────────────────────────────────
    const cover = pptx.addSlide();
    cover.background = {color: 'FFFFFF'};

    cover.addShape(pptx.ShapeType.rect, {
        x: 0,
        y: 0,
        w: slideW,
        h: 0.4,
        fill: {color: accent}
    });

    cover.addText(doc.title || 'Untitled', {
        x: 0.5,
        y: 1.5,
        w: slideW - 1,
        h: 1.2,
        fontSize: 32,
        bold: true,
        color: accent,
        fontFace,
        align: 'left'
    });

    let nextY = 2.8;
    if (doc.author) {
        cover.addText(`Prepared by ${doc.author}`, {
            x: 0.5,
            y: nextY,
            w: slideW - 1,
            h: 0.4,
            fontSize: 14,
            color: '333333',
            fontFace
        });
        nextY += 0.5;
    }

    if (doc.date) {
        cover.addText(doc.date, {
            x: 0.5,
            y: nextY,
            w: slideW - 1,
            h: 0.4,
            fontSize: 14,
            color: '333333',
            fontFace
        });
        nextY += 0.5;
    }

    if (manifest.name) {
        cover.addText(manifest.name, {
            x: 0.5,
            y: layoutHeight - 1,
            w: slideW - 1,
            h: 0.4,
            fontSize: 12,
            color: '666666',
            fontFace
        });
    }

    // ── Content slides ──────────────────────────────────────────────────────
    const theme = {accent, fontFace};
    let pages = [];
    for (const section of splitIntoSlides(renderedHTML)) {
        const blocks = await sizeImages(pptxBlocksFromHtml(section.html), frame, warn);
        pushAll(pages, paginateSection({title: section.title, blocks}, orientation, {onWarning: warn}));
    }
    if (pages.length > MAX_CONTENT_SLIDES) {
        warn(`The document needs ${pages.length} slides; PowerPoint export stops at ${MAX_CONTENT_SLIDES} slides, `
            + 'so the rest is left out. Export it as PDF or Word for the whole document.');
        pages = pages.slice(0, MAX_CONTENT_SLIDES);
    }
    const totalSlides = pages.length;

    pages.forEach((page, idx) => {
        const slide = pptx.addSlide();
        slide.background = {color: 'FFFFFF'};

        slide.addShape(pptx.ShapeType.rect, {
            x: 0,
            y: 0,
            w: slideW,
            h: 0.15,
            fill: {color: accent}
        });

        const titleText = page.title || (`Slide ${idx + 1}`);
        slide.addText(titleText, {
            x: 0.5,
            y: 0.3,
            w: slideW - 1,
            h: 0.6,
            fontSize: 20,
            bold: true,
            color: accent,
            fontFace,
            align: 'left'
        });

        renderBlocks(slide, page.blocks, frame, theme);

        slide.addText(doc.title || '', {
            x: 0.5,
            y: layoutHeight - 0.5,
            w: slideW / 2 - 0.5,
            h: 0.3,
            fontSize: 10,
            color: '999999',
            fontFace
        });

        slide.addText(`${idx + 1} / ${totalSlides}`, {
            x: slideW / 2,
            y: layoutHeight - 0.5,
            w: slideW / 2 - 0.5,
            h: 0.3,
            fontSize: 10,
            color: '999999',
            fontFace,
            align: 'right'
        });
    });

    // One a:pPr per paragraph (see singleParagraphProps), in every slide part.
    const zip = await JSZip.loadAsync(await pptx.write({outputType: 'arraybuffer'}));
    for (const name of Object.keys(zip.files)) {
        if (/^ppt\/(slides|notesSlides)\/[^/]+\.xml$/.test(name)) {
            zip.file(name, singleParagraphProps(await zip.file(name).async('string')));
        }
    }
    return zip.generateAsync({
        type: 'blob',
        compression: 'DEFLATE',
        mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    });
}

/**
 * Export rendered markdown as a .pptx presentation (triggers browser download).
 * @param {{ title: string, author: string, date: string, brand: string }} doc
 * @param {{ manifest: object, styles: string, template: object }} templateEntry
 * @param {string} renderedHTML
 * @param {{ orientation?: string, pageSize?: string }} [opts]
 */
export async function exportPptx(doc, templateEntry, renderedHTML, opts = {}) {
    await loadPptxGen();   // PptxGenJS and JSZip: loaded on the first export, not at startup
    const blob = await pptxBlob(doc, templateEntry, renderedHTML, opts);
    downloadBlob(blob, `${toFilenameSafe(doc.title, 'presentation')}.pptx`);
}
