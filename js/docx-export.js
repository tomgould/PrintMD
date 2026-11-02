/**
 * docx-export.js
 * Writes a Word .docx (OOXML, written by hand) from rendered HTML.
 * Uses JSZip (global) for the package and DOMParser for the HTML, so the
 * exporter itself is browser-only; the helpers above "Public API" are pure.
 *
 * Supported: headings (with bookmarks for #anchor links), paragraphs, text in
 * any container element, bold/italic/strike/underline/code/sub/sup, links
 * (http, https and mailto become hyperlinks), line breaks, numbered and bullet
 * lists (each list numbered on its own, `start` honoured, nested levels), task
 * lists (☐ / ☑), block quotes, code blocks, tables (header rows, colspan,
 * rowspan, nested tables), rules, and title/author/date in the core
 * properties and the cover block. Images are not embedded.
 */

import {downloadBlob, toFilenameSafe} from './download.js';
import {escXml, externalLinkTarget, stripXmlIllegal} from './xml-safe.js';
import {loadJSZip} from './import-utils.js';

export {escXml, externalLinkTarget, stripXmlIllegal};
export {MAX_LINK_LENGTH} from './xml-safe.js';

const esc = escXml;

// ── Numbering ────────────────────────────────────────────────────────────────

/** Deepest list level Word supports (levels 0 to 8). */
export const MAX_LIST_LEVEL = 8;
/** Most columns a Word table may have. */
export const MAX_TABLE_COLUMNS = 63;
const BULLET_ABSTRACT = 0;
const DECIMAL_ABSTRACT = 1;

/**
 * One w:num per HTML list, so no two lists share a counter. A numbered list
 * restarts at its `start` value through a startOverride on its own level.
 * @param {Array<{ordered: boolean, level: number, start?: number}>} lists  in document order
 * @returns {Array<{numId: number, abstractNumId: number, ilvl: number, start: number|null}>}
 */
export function listNumberingPlan(lists) {
    return Array.from(lists || [], (list, i) => {
        const ilvl = Math.max(0, Math.min(MAX_LIST_LEVEL, Math.floor(Number(list.level) || 0)));
        // startOverride: 0 to 32767, the range Word's numbering accepts.
        const start = Number.isFinite(Number(list.start)) ? Math.max(0, Math.min(32767, Math.floor(Number(list.start)))) : 1;
        return {
            numId: i + 1,
            abstractNumId: list.ordered ? DECIMAL_ABSTRACT : BULLET_ABSTRACT,
            ilvl,
            start: list.ordered ? start : null,
        };
    });
}

const BULLETS = ['•', '◦', '▪'];

/** numbering.xml for a listNumberingPlan(). */
export function buildNumbering(plan) {
    const levels = (ordered) => Array.from({length: MAX_LIST_LEVEL + 1}, (_, i) => {
        const fmt = ordered ? 'decimal' : 'bullet';
        const text = ordered ? `%${i + 1}.` : BULLETS[i % BULLETS.length];
        return `<w:lvl w:ilvl="${i}"><w:start w:val="1"/><w:numFmt w:val="${fmt}"/><w:lvlText w:val="${text}"/>`
            + `<w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${720 * (i + 1)}" w:hanging="360"/></w:pPr></w:lvl>`;
    }).join('');
    const nums = (plan || []).map((n) => {
        const override = n.start == null ? ''
            : `<w:lvlOverride w:ilvl="${n.ilvl}"><w:startOverride w:val="${n.start}"/></w:lvlOverride>`;
        return `<w:num w:numId="${n.numId}"><w:abstractNumId w:val="${n.abstractNumId}"/>${override}</w:num>`;
    }).join('\n  ');
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:abstractNum w:abstractNumId="${BULLET_ABSTRACT}"><w:multiLevelType w:val="hybridMultilevel"/>${levels(false)}</w:abstractNum>
  <w:abstractNum w:abstractNumId="${DECIMAL_ABSTRACT}"><w:multiLevelType w:val="hybridMultilevel"/>${levels(true)}</w:abstractNum>
  ${nums}
</w:numbering>`;
}

// ── OOXML building blocks ─────────────────────────────────────────────────────
// Property children are written in the order ECMA-376 gives them (CT_RPr,
// CT_PPrBase, CT_TcPr): Word rejects a file that breaks it, LibreOffice does not.

function wText(text) {
    return `<w:t xml:space="preserve">${esc(text)}</w:t>`;
}

function runProps(fmt) {
    let x = '';
    if (fmt.link) x += '<w:rStyle w:val="Hyperlink"/>';
    if (fmt.mono) x += '<w:rFonts w:ascii="Courier New" w:hAnsi="Courier New" w:cs="Courier New"/>';
    else if (fmt.symbol) x += '<w:rFonts w:ascii="Segoe UI Symbol" w:hAnsi="Segoe UI Symbol" w:cs="Segoe UI Symbol"/>';
    if (fmt.bold) x += '<w:b/><w:bCs/>';
    if (fmt.italic) x += '<w:i/><w:iCs/>';
    if (fmt.strike) x += '<w:strike/>';
    if (fmt.color) x += `<w:color w:val="${esc(fmt.color)}"/>`;
    if (fmt.mono) x += '<w:sz w:val="18"/><w:szCs w:val="18"/>';
    if (fmt.mark) x += '<w:highlight w:val="yellow"/>';
    if (fmt.underline) x += '<w:u w:val="single"/>';
    if (fmt.vertAlign) x += `<w:vertAlign w:val="${fmt.vertAlign}"/>`;
    return x ? `<w:rPr>${x}</w:rPr>` : '';
}

function wRun(text, fmt = {}) {
    const s = stripXmlIllegal(text);
    if (!s) return '';
    return `<w:r>${runProps(fmt)}${wText(s)}</w:r>`;
}

/**
 * @param {string} content  runs, hyperlinks and bookmarks
 * @param {{style?: string, numId?: number, ilvl?: number, border?: boolean, shd?: string,
 *          spacing?: {before?: number, after?: number}, indent?: {left: number, hanging?: number},
 *          jc?: string, keepNext?: boolean}} [pf]
 */
function wPara(content, pf = {}) {
    let x = '';
    if (pf.style) x += `<w:pStyle w:val="${esc(pf.style)}"/>`;
    if (pf.keepNext) x += '<w:keepNext/>';
    if (pf.numId != null) x += `<w:numPr><w:ilvl w:val="${pf.ilvl || 0}"/><w:numId w:val="${pf.numId}"/></w:numPr>`;
    if (pf.border) x += '<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="AAAAAA"/></w:pBdr>';
    if (pf.shd) x += `<w:shd w:val="clear" w:color="auto" w:fill="${esc(pf.shd)}"/>`;
    if (pf.spacing) x += `<w:spacing w:before="${pf.spacing.before || 0}" w:after="${pf.spacing.after || 0}"/>`;
    if (pf.indent) x += `<w:ind w:left="${pf.indent.left}"${pf.indent.hanging ? ` w:hanging="${pf.indent.hanging}"` : ''}/>`;
    if (pf.jc) x += `<w:jc w:val="${pf.jc}"/>`;
    return `<w:p>${x ? `<w:pPr>${x}</w:pPr>` : ''}${content}</w:p>`;
}

const BORDER = (side) => `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="AAAAAA"/>`;
const TABLE_BORDERS = `<w:tblBorders>${['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(BORDER).join('')}</w:tblBorders>`;

// ── HTML walker ───────────────────────────────────────────────────────────────

/** Elements laid out inline: their text joins the paragraph around them. */
const INLINE_TAGS = new Set(['a', 'abbr', 'b', 'bdi', 'bdo', 'br', 'cite', 'code', 'data', 'del', 'dfn', 'em',
    'font', 'i', 'img', 'input', 'ins', 'kbd', 'label', 'mark', 'q', 's', 'samp', 'small', 'span', 'strike',
    'strong', 'sub', 'sup', 'time', 'tt', 'u', 'var', 'wbr']);
/** Elements with nothing Word can show. */
const SKIP_TAGS = new Set(['audio', 'button', 'canvas', 'embed', 'iframe', 'math', 'object', 'picture',
    'script', 'select', 'style', 'svg', 'template', 'textarea', 'video']);
const HEADING_LEVEL = {h1: 1, h2: 2, h3: 3, h4: 4, h5: 5, h6: 6};
const LIST_INDENT = 720;
const HANGING = 360;

/**
 * Append every item of `items` to `out`. A loop, not out.push(...items): an
 * argument spread throws "Maximum call stack size exceeded" from roughly
 * 100,000 items, and body items grow with the document.
 */
function pushAll(out, items) {
    for (const item of items) out.push(item);
    return out;
}

const tagOf = (node) => (node.nodeType === 1 ? node.localName.toLowerCase() : '');
const isInline = (node) => node.nodeType === 3 || (node.nodeType === 1 && INLINE_TAGS.has(tagOf(node)));

/** Cell or paragraph alignment from an align attribute or text-align style. */
function alignOf(el) {
    const v = ((el.getAttribute && el.getAttribute('align')) || (el.style && el.style.textAlign) || '').toLowerCase();
    if (v === 'center' || v === 'right' || v === 'left') return v;
    if (v === 'justify') return 'both';
    return '';
}

/** A Word bookmark name: starts with "_" (hidden), letters, digits and "_" only, at most 40 characters. */
function bookmarkName(id, n) {
    return `_bd${n}_${id.replace(/[^A-Za-z0-9_]/g, '_')}`.slice(0, 40);
}

/**
 * The conversion state for one document: the lists met so far (for
 * numbering.xml), hyperlink relationships, and the heading bookmarks.
 */
function createConverter(root, {textWidth, warn}) {
    const lists = [];
    const links = [];
    // element id -> {name, el}: only the first heading with an id gets its bookmark, so names
    // stay unique when raw HTML repeats an id, and a #link goes where a browser would.
    const bookmarks = new Map();
    let bookmarkSeq = 0;
    for (const el of root.querySelectorAll('h1[id],h2[id],h3[id],h4[id],h5[id],h6[id]')) {
        const id = el.getAttribute('id');
        if (id && !bookmarks.has(id)) bookmarks.set(id, {name: bookmarkName(id, bookmarks.size), el});
    }

    const cx = {
        lists, links, textWidth, warn,
        // Collapsing whitespace across runs, as a browser does: a space after a space is dropped.
        lastSpace: true,
        addList(list) {
            lists.push(list);
            return lists.length; // numId (listNumberingPlan numbers from 1)
        },
        linkId(href) {
            links.push(href);
            return `rIdLink${links.length}`;
        },
        anchorFor(href) {
            let id = href.slice(1);
            try {
                id = decodeURIComponent(id);
            } catch (_e) { /* keep as written */ }
            const entry = bookmarks.get(id);
            return entry ? entry.name : '';
        },
        bookmark(el) {
            const entry = el.getAttribute && el.getAttribute('id') ? bookmarks.get(el.getAttribute('id')) : null;
            if (!entry || entry.el !== el) return null;
            const n = bookmarkSeq++;
            return {start: `<w:bookmarkStart w:id="${n}" w:name="${esc(entry.name)}"/>`, end: `<w:bookmarkEnd w:id="${n}"/>`};
        },
    };
    return cx;
}

function inlineXml(node, fmt, cx) {
    if (node.nodeType === 3) {
        let text = fmt.pre ? node.textContent : node.textContent.replace(/[ \t\r\n\f]+/g, ' ');
        if (!fmt.pre && cx.lastSpace) text = text.replace(/^ /, '');
        if (!text) return '';
        cx.lastSpace = text.endsWith(' ');
        return wRun(text, fmt);
    }
    if (node.nodeType !== 1) return '';
    const tag = tagOf(node);
    if (SKIP_TAGS.has(tag) || tag === 'img' || tag === 'wbr') return '';
    if (tag === 'br') {
        cx.lastSpace = true;
        return '<w:r><w:br/></w:r>';
    }
    if (tag === 'input') {
        if ((node.getAttribute('type') || '').toLowerCase() !== 'checkbox') return '';
        cx.lastSpace = false;
        return wRun(node.hasAttribute('checked') ? '☑' : '☐', {...fmt, symbol: true});
    }
    const f = {...fmt};
    if (tag === 'strong' || tag === 'b') f.bold = true;
    if (tag === 'em' || tag === 'i' || tag === 'cite' || tag === 'dfn' || tag === 'var') f.italic = true;
    if (tag === 's' || tag === 'del' || tag === 'strike') f.strike = true;
    if (tag === 'u' || tag === 'ins') f.underline = true;
    if (tag === 'code' || tag === 'kbd' || tag === 'samp' || tag === 'tt') f.mono = true;
    if (tag === 'mark') f.mark = true;
    if (tag === 'sub') f.vertAlign = 'subscript';
    if (tag === 'sup') f.vertAlign = 'superscript';

    const children = (runFmt) => Array.from(node.childNodes, (c) => inlineXml(c, runFmt, cx)).join('');
    if (tag === 'a' && !fmt.link) {
        // Any other scheme (javascript:, relative paths, unknown #ids) stays plain text.
        const href = (node.getAttribute('href') || '').trim();
        const anchor = href.startsWith('#') ? cx.anchorFor(href) : '';
        const target = externalLinkTarget(href);
        if (target) {
            return `<w:hyperlink r:id="${cx.linkId(target)}" w:history="1">${children({...f, link: true})}</w:hyperlink>`;
        }
        if (anchor) {
            return `<w:hyperlink w:anchor="${esc(anchor)}" w:history="1">${children({...f, link: true})}</w:hyperlink>`;
        }
    }
    return children(f);
}

/** Whether a list item starts with a task-list checkbox (also inside its first paragraph). */
function startsWithCheckbox(li) {
    let node = li.firstChild;
    while (node) {
        if (node.nodeType === 3 && !node.textContent.trim()) {
            node = node.nextSibling;
        } else if (tagOf(node) === 'p') {
            node = node.firstChild;
        } else {
            return tagOf(node) === 'input' && (node.getAttribute('type') || '').toLowerCase() === 'checkbox';
        }
    }
    return false;
}

/**
 * Paragraph properties for the next paragraph in this context. Inside a list
 * item the first paragraph carries the number; the rest line up under its text.
 */
function paraProps(ctx) {
    const pf = {style: ctx.style || '', jc: ctx.jc || ''};
    if (ctx.compact) pf.spacing = {before: 0, after: 0};
    const slot = ctx.slot;
    if (slot) {
        const left = (ctx.indent || 0) + LIST_INDENT * (slot.ilvl + 1);
        pf.style = pf.style || 'ListParagraph';
        if (!slot.used && slot.numId != null) {
            pf.numId = slot.numId;
            pf.ilvl = slot.ilvl;
            pf.indent = {left, hanging: HANGING};
        } else if (!slot.used) {
            // A task item: its checkbox stands where the bullet would.
            pf.indent = {left, hanging: HANGING};
        } else {
            pf.indent = {left};
        }
        slot.used = true;
    } else if (ctx.indent) {
        pf.indent = {left: ctx.indent};
    }
    return pf;
}

/** Body items for a node's children: inline runs gather into paragraphs, blocks convert on their own. */
function flowXml(parent, cx, ctx) {
    const out = [];
    let pending = [];
    const flush = () => {
        if (!pending.length) return;
        cx.lastSpace = true;
        const runs = pending.map((n) => inlineXml(n, ctx.fmt || {}, cx)).join('');
        pending = [];
        if (runs) out.push(wPara(runs, paraProps(ctx)));
    };
    for (const child of parent.childNodes) {
        if (isInline(child)) {
            pending.push(child);
        } else if (child.nodeType === 1) {
            flush();
            pushAll(out, blockXml(child, cx, ctx));
        }
    }
    flush();
    return out;
}

function inlineParagraph(el, cx, ctx, pf) {
    cx.lastSpace = true;
    const runs = Array.from(el.childNodes, (c) => inlineXml(c, ctx.fmt || {}, cx)).join('');
    return wPara(runs, pf);
}

function blockXml(el, cx, ctx) {
    const tag = tagOf(el);
    if (SKIP_TAGS.has(tag)) return [];

    if (HEADING_LEVEL[tag]) {
        const mark = cx.bookmark(el);
        cx.lastSpace = true;
        const runs = Array.from(el.childNodes, (c) => inlineXml(c, ctx.fmt || {}, cx)).join('');
        const pf = {style: `Heading${HEADING_LEVEL[tag]}`, keepNext: true};
        if (ctx.slot && !ctx.slot.used) {
            // A list item that starts with a heading: the heading carries the item's bullet.
            const {numId, ilvl, indent} = paraProps(ctx);
            Object.assign(pf, {numId, ilvl, indent});
        }
        return [wPara(mark ? mark.start + runs + mark.end : runs, pf)];
    }
    if (tag === 'p') {
        if (!el.textContent.trim() && !el.querySelector('br,input')) return [];
        return [inlineParagraph(el, cx, ctx, paraProps({...ctx, jc: alignOf(el) || ctx.jc}))];
    }
    if (tag === 'blockquote') return flowXml(el, cx, {...ctx, indent: (ctx.indent || 0) + LIST_INDENT});
    if (tag === 'ul' || tag === 'ol') return listXml(el, cx, ctx);
    if (tag === 'pre') return [preXml(el, cx, ctx)];
    if (tag === 'table') return tableXml(el, cx, ctx);
    if (tag === 'hr') return [wPara('', {border: true})];
    if (tag === 'summary' || tag === 'dt' || tag === 'th') return flowXml(el, cx, {...ctx, fmt: {...ctx.fmt, bold: true}});
    if (tag === 'dd') return flowXml(el, cx, {...ctx, indent: (ctx.indent || 0) + LIST_INDENT});
    if (tag === 'figcaption') return flowXml(el, cx, {...ctx, fmt: {...ctx.fmt, italic: true}});
    // div, section, details, figure, li outside a list and any other container.
    return flowXml(el, cx, {...ctx, jc: alignOf(el) || ctx.jc});
}

function listXml(list, cx, ctx) {
    const ordered = tagOf(list) === 'ol';
    const level = Math.min(ctx.listLevel || 0, MAX_LIST_LEVEL);
    const startAttr = parseInt(list.getAttribute('start'), 10);
    const numId = cx.addList({ordered, level, start: Number.isFinite(startAttr) ? startAttr : 1});
    const out = [];
    for (const li of list.children) {
        if (tagOf(li) !== 'li') {
            pushAll(out, blockXml(li, cx, ctx));
            continue;
        }
        // A task item shows its checkbox instead of a bullet.
        const slot = {numId: startsWithCheckbox(li) ? null : numId, ilvl: level, used: false};
        const itemCtx = {...ctx, slot, listLevel: level + 1, style: '', compact: false};
        const items = flowXml(li, cx, itemCtx);
        // An empty item still shows its bullet. An item that starts with a table has none:
        // a table cannot carry it, and an empty bullet paragraph above the table looks wrong.
        if (!slot.used && !items.length) items.push(wPara('', paraProps(itemCtx)));
        pushAll(out, items);
    }
    return out;
}

function preXml(pre, cx, ctx) {
    const lines = pre.textContent.replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n');
    const runs = lines.map((line, i) => (i ? '<w:r><w:br/></w:r>' : '') + wRun(line.replace(/\t/g, '    '), {mono: true}))
        .join('');
    // A list item that starts with code: the code paragraph carries the item's bullet.
    const pf = paraProps(ctx);
    pf.shd = 'F5F5F5';
    if (pf.numId == null) pf.indent = {left: (pf.indent ? pf.indent.left : 0) + HANGING};
    pf.spacing = {before: 60, after: 120};
    return wPara(runs, pf);
}

/**
 * The cell grid of a table: rows of slots, each slot the cell that covers it,
 * with colspan and rowspan applied (HTML's table model, simplified).
 */
function tableGrid(table) {
    const rows = Array.from(table.rows || []);
    const grid = rows.map(() => []);
    let truncated = false;
    rows.forEach((tr, r) => {
        let c = 0;
        for (const cell of tr.cells) {
            while (grid[r][c]) c++;
            // Word allows at most MAX_TABLE_COLUMNS columns: the rest of the row is left out.
            if (c >= MAX_TABLE_COLUMNS) {
                truncated = true;
                break;
            }
            const wanted = Math.max(1, cell.colSpan || 1);
            const cs = Math.min(wanted, MAX_TABLE_COLUMNS - c);
            if (cs < wanted) truncated = true;
            const rawRs = cell.rowSpan === 0 ? rows.length - r : (cell.rowSpan || 1);
            const rs = Math.max(1, Math.min(rows.length - r, rawRs));
            for (let dr = 0; dr < rs; dr++) {
                for (let dc = 0; dc < cs; dc++) {
                    grid[r + dr][c + dc] = {cell, top: dr === 0, left: dc === 0, cs, rs};
                }
            }
            c += cs;
        }
    });
    const cols = grid.reduce((n, row) => Math.max(n, row.length), 0);
    return {rows, grid, cols, truncated};
}

/** Body items for a table: none for a table without cells (Word rejects a w:tbl with no rows). */
function tableXml(table, cx, ctx) {
    const {rows, grid, cols, truncated} = tableGrid(table);
    if (cols === 0) return [];
    if (truncated) {
        cx.warn(`A table has more than ${MAX_TABLE_COLUMNS} columns, the most Word allows: `
            + 'the Word file leaves out the columns after that.');
    }
    // Columns share the text width; even 63 columns stay inside the page (at least 100 twips each).
    const colW = Math.max(100, Math.floor((ctx.width || cx.textWidth) / cols));
    let xml = `<w:tbl><w:tblPr><w:tblW w:w="${colW * cols}" w:type="dxa"/>${TABLE_BORDERS}<w:tblLayout w:type="fixed"/></w:tblPr>`;
    xml += `<w:tblGrid>${`<w:gridCol w:w="${colW}"/>`.repeat(cols)}</w:tblGrid>`;
    rows.forEach((tr, r) => {
        const inHead = tagOf(tr.parentNode) === 'thead';
        xml += `<w:tr>${inHead ? '<w:trPr><w:tblHeader/></w:trPr>' : ''}`;
        for (let c = 0; c < cols; c++) {
            const slot = grid[r][c];
            if (slot && !slot.left) continue;
            const cs = slot ? slot.cs : 1;
            const isHeader = slot && (tagOf(slot.cell) === 'th' || inHead);
            let tcPr = `<w:tcW w:w="${colW * cs}" w:type="dxa"/>`;
            if (cs > 1) tcPr += `<w:gridSpan w:val="${cs}"/>`;
            if (slot && slot.rs > 1) tcPr += slot.top ? '<w:vMerge w:val="restart"/>' : '<w:vMerge/>';
            if (isHeader) tcPr += '<w:shd w:val="clear" w:color="auto" w:fill="E8E8E8"/>';
            let body = [];
            if (slot && slot.top) {
                body = flowXml(slot.cell, cx, {
                    fmt: isHeader ? {bold: true} : {}, compact: true, jc: alignOf(slot.cell),
                    width: colW * cs - 216, listLevel: 0,
                });
            }
            // A cell must end with a paragraph, also after a nested table.
            if (!body.length || body[body.length - 1].startsWith('<w:tbl>')) body.push('<w:p/>');
            xml += `<w:tc><w:tcPr>${tcPr}</w:tcPr>${body.join('')}</w:tc>`;
        }
        xml += '</w:tr>';
    });
    return [xml + '</w:tbl>'];
}

// ── OOXML document assembly ───────────────────────────────────────────────────

function buildStyles(accent = '1e3a5f') {
    const a = accent.replace('#', '');
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal">
    <w:name w:val="Normal"/>
    <w:pPr><w:spacing w:after="120"/></w:pPr>
    <w:rPr><w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Title">
    <w:name w:val="Title"/>
    <w:basedOn w:val="Normal"/>
    <w:pPr><w:spacing w:after="240"/></w:pPr>
    <w:rPr><w:b/><w:bCs/><w:color w:val="${a}"/><w:sz w:val="56"/><w:szCs w:val="56"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading1">
    <w:name w:val="heading 1"/>
    <w:pPr><w:spacing w:before="240" w:after="120"/></w:pPr>
    <w:rPr><w:b/><w:bCs/><w:color w:val="${a}"/><w:sz w:val="40"/><w:szCs w:val="40"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading2">
    <w:name w:val="heading 2"/>
    <w:pPr><w:spacing w:before="200" w:after="100"/></w:pPr>
    <w:rPr><w:b/><w:bCs/><w:color w:val="${a}"/><w:sz w:val="32"/><w:szCs w:val="32"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading3">
    <w:name w:val="heading 3"/>
    <w:pPr><w:spacing w:before="160" w:after="80"/></w:pPr>
    <w:rPr><w:b/><w:bCs/><w:color w:val="${a}"/><w:sz w:val="28"/><w:szCs w:val="28"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading4">
    <w:name w:val="heading 4"/>
    <w:pPr><w:spacing w:before="120" w:after="60"/></w:pPr>
    <w:rPr><w:b/><w:bCs/><w:color w:val="${a}"/><w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading5">
    <w:name w:val="heading 5"/>
    <w:rPr><w:b/><w:bCs/><w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading6">
    <w:name w:val="heading 6"/>
    <w:rPr><w:b/><w:bCs/><w:i/><w:iCs/><w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="ListParagraph">
    <w:name w:val="List Paragraph"/>
    <w:basedOn w:val="Normal"/>
    <w:pPr><w:spacing w:after="60"/><w:ind w:left="720"/></w:pPr>
  </w:style>
  <w:style w:type="character" w:styleId="Hyperlink">
    <w:name w:val="Hyperlink"/>
    <w:rPr><w:color w:val="0563C1"/><w:u w:val="single"/></w:rPr>
  </w:style>
</w:styles>`;
}

function buildContentTypes() {
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
  <Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>
  <Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
</Types>`;
}

function buildRels() {
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
</Relationships>`;
}

function buildWordRels(links) {
    const linkRels = links.map((href, i) => `  <Relationship Id="rIdLink${i + 1}" `
        + `Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${esc(href)}" TargetMode="External"/>`)
        .join('\n');
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/>
${linkRels}
</Relationships>`;
}

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september',
    'october', 'november', 'december'];

/**
 * The ISO day (YYYY-MM-DD) a cover date names: "15 January 2026" (how
 * js/doc-meta.js formats dates) or an ISO date. Any other text gives ''.
 * @param {string} text
 * @returns {string}
 */
export function isoDay(text) {
    const s = String(text == null ? '' : text).trim();
    let y;
    let m;
    let d;
    const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    const long = /^(\d{1,2}) ([A-Za-z]+) (\d{4})$/.exec(s);
    if (iso) {
        [y, m, d] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
    } else if (long && MONTHS.includes(long[2].toLowerCase())) {
        [y, m, d] = [Number(long[3]), MONTHS.indexOf(long[2].toLowerCase()) + 1, Number(long[1])];
    } else {
        return '';
    }
    const date = new Date(Date.UTC(y, m - 1, d));
    if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return '';
    return date.toISOString().slice(0, 10);
}

/** docProps/core.xml: title, author, and the document date as the created date. */
function buildCoreProps(doc, now) {
    const stamp = now.toISOString().replace(/\.\d{3}Z$/, 'Z');
    const day = isoDay(doc.date);
    const created = day ? `${day}T00:00:00Z` : stamp;
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:title>${esc(doc.title || '')}</dc:title>
  <dc:creator>${esc(doc.author || '')}</dc:creator>
  <dcterms:created xsi:type="dcterms:W3CDTF">${created}</dcterms:created>
  <dcterms:modified xsi:type="dcterms:W3CDTF">${stamp}</dcterms:modified>
</cp:coreProperties>`;
}

function buildSettings() {
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat>
</w:settings>`;
}

// Page sizes in twentieths of a point (twips): 1 inch = 1440 twips, 1mm = 56.7 twips
const PAPER = {
    A4:     { w: 11906, h: 16838 },
    A3:     { w: 16838, h: 23811 },
    A5:     { w:  8391, h: 11906 },
    Letter: { w: 12240, h: 15840 },
    Legal:  { w: 12240, h: 20160 },
    // 10 x 5.625 in (js/export-options.js); export options make it landscape.
    Slide:  { w:  8100, h: 14400 },
};

/** Page width, height and margin in twips for the export options. */
function pageGeometry(opts) {
    const isLandscape = opts.orientation === 'landscape';
    const size = PAPER[opts.pageSize] || PAPER.A4;
    const mmMatch = String(opts.margin || '20mm').match(/^(\d+(?:\.\d+)?)\s*mm$/i);
    const margin = Math.round((mmMatch ? parseFloat(mmMatch[1]) : 20) * 56.7);
    return {
        isLandscape,
        pw: isLandscape ? size.h : size.w,
        ph: isLandscape ? size.w : size.h,
        margin,
    };
}

function buildDocument(bodyXml, page) {
    const {pw, ph, margin, isLandscape} = page;
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
            xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <w:body>
${bodyXml}
    <w:sectPr>
      <w:pgSz w:w="${pw}" w:h="${ph}"${isLandscape ? ' w:orient="landscape"' : ''}/>
      <w:pgMar w:top="${margin}" w:right="${margin}" w:bottom="${margin}" w:left="${margin}" w:header="720" w:footer="720" w:gutter="0"/>
    </w:sectPr>
  </w:body>
</w:document>`;
}

// ── Public API ────────────────────────────────────────────────────────────────

/** A detached element holding the HTML, in an inert document: nothing in it loads. */
function inertRoot(html) {
    const htmlDoc = new DOMParser().parseFromString('<!DOCTYPE html><body></body>', 'text/html');
    const root = htmlDoc.createElement('div');
    root.innerHTML = String(html || '');
    return root;
}

/**
 * How many images the Word file leaves out: every <img> with a source, a data:
 * URI or a web address alike, since none is embedded (roadmap M8-T15).
 * @param {string|Element} html  rendered body HTML, or an element already holding it
 */
export function countWordImages(html) {
    const root = typeof html === 'string' || html == null ? inertRoot(html) : html;
    return Array.from(root.querySelectorAll('img')).filter((img) => (img.getAttribute('src') || '').trim()).length;
}

/** The message for n left-out images: after the export, or `before` it (the preflight list). '' for none. */
export function wordImagesNote(n, {before = false} = {}) {
    if (!(n > 0)) return '';
    const one = n === 1;
    const verb = before ? 'will be' : (one ? 'was' : 'were');
    return `${n} ${one ? 'image' : 'images'} ${verb} left out of the Word file; the PDF keeps ${one ? 'it' : 'them'}.`;
}

/**
 * Convert rendered HTML and the document metadata to a .docx Blob.
 * @param {{title: string, author: string, date: string}} doc  from js/doc-meta.js buildDocMeta
 *        (prepareExport's `doc`): the cover block and the core properties
 * @param {{manifest?: object}|null} templateEntry  manifest.accent colours the title and headings
 * @param {string} renderedHTML  sanitised body HTML, front matter already removed
 * @param {{orientation?: string, pageSize?: string, margin?: string, now?: Date,
 *          onWarning?: (message: string) => void}} [opts]
 *        page options (prepareExport's pageOpts); `now` is the modified date (default: now);
 *        onWarning hears, once each, about content Word cannot hold (default: console.warn)
 * @returns {Promise<Blob>}
 */
export function docxBlob(doc, templateEntry, renderedHTML, opts = {}) {
    if (typeof JSZip === 'undefined') throw new Error('JSZip not loaded');

    const manifest = (templateEntry && templateEntry.manifest) || {};
    const accent = (manifest.accent || '#1e3a5f').replace('#', '');
    const page = pageGeometry(opts);
    const report = typeof opts.onWarning === 'function' ? opts.onWarning : (m) => console.warn(m);
    const reported = new Set();
    const warn = (m) => {
        if (!reported.has(m)) {
            reported.add(m);
            report(m);
        }
    };

    const root = inertRoot(renderedHTML);
    const cx = createConverter(root, {textWidth: page.pw - 2 * page.margin, warn});

    // Cover block: title, author, date.
    const body = [wPara(wRun(doc.title || ''), {style: 'Title'})];
    if (doc.author) body.push(wPara(wRun('Prepared by ' + doc.author)));
    if (doc.date) body.push(wPara(wRun(doc.date)));
    pushAll(body, flowXml(root, cx, {}));
    const imagesNote = wordImagesNote(countWordImages(root));
    if (imagesNote) warn(imagesNote);

    const zip = new JSZip();
    zip.file('[Content_Types].xml', buildContentTypes());
    zip.file('_rels/.rels', buildRels());
    zip.file('docProps/core.xml', buildCoreProps(doc, opts.now instanceof Date ? opts.now : new Date()));
    zip.file('word/document.xml', buildDocument(body.join('\n'), page));
    zip.file('word/styles.xml', buildStyles(accent));
    zip.file('word/numbering.xml', buildNumbering(listNumberingPlan(cx.lists)));
    zip.file('word/settings.xml', buildSettings());
    zip.file('word/_rels/document.xml.rels', buildWordRels(cx.links));

    return zip.generateAsync({ type: 'blob', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
}

/**
 * Browser-only: trigger a .docx download.
 */
export async function exportDocx(doc, templateEntry, renderedHTML, opts = {}) {
    await loadJSZip();   // loaded on the first export, not at startup
    const blob = await docxBlob(doc, templateEntry, renderedHTML, opts);
    downloadBlob(blob, `${toFilenameSafe(doc.title, 'document')}.docx`);
}

// Legacy compat: buildDocxHtml is no longer used, but kept so imports of it do not break
export function buildDocxHtml(doc, templateEntry, renderedHTML) {
    return renderedHTML;
}
