/**
 * js/slides.js
 *
 * The slide model behind the PowerPoint export: split rendered HTML into
 * sections, turn a section into content blocks, and lay the blocks out on
 * slides, continuing a long section on "Title (cont.)" slides.
 *
 * Pure string processing, no DOM, so all of it runs under Node's unit tests.
 * The HTML is the sanitiser's output (js/markdown.js), which is well formed:
 * every non-void element is closed and attributes are quoted. Text and
 * attribute values lose any character XML 1.0 forbids (js/xml-safe.js), so
 * nothing in the model can corrupt the deck.
 */

import {externalLinkTarget, stripXmlIllegal} from './xml-safe.js';

/** Decoded, XML-safe text. */
const clean = (s) => stripXmlIllegal(decodeEntities(s));

// ─── Entities ────────────────────────────────────────────────────────────────

const NAMED_ENTITIES = {amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' '};

/**
 * Decode HTML character references in one pass, so a decoded "&" never starts
 * a second reference: `&amp;lt;` gives the text `&lt;`, not `<`.
 * Unknown names are left as written.
 * @param {string} text
 * @returns {string}
 */
export function decodeEntities(text) {
    return String(text == null ? '' : text).replace(/&(#[0-9]+|#[xX][0-9a-fA-F]+|[A-Za-z][A-Za-z0-9]*);/g, (ref, body) => {
        if (body[0] !== '#') return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, body) ? NAMED_ENTITIES[body] : ref;
        const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
        if (!Number.isFinite(code) || code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return String.fromCharCode(0xfffd);
        return String.fromCodePoint(code);
    });
}

// ─── Sections ────────────────────────────────────────────────────────────────

/**
 * Split rendered HTML (output of renderMarkdown) into presentation slides.
 * A new slide starts at every <hr> (from a Markdown `---`) and at every <h1> / <h2>.
 * @param {string} html
 * @returns {Array<{title: string, html: string}>}
 */
export function splitIntoSlides(html) {
    if (!html || html.trim() === '') {
        return [];
    }

    // Sentinel unlikely to occur in rendered HTML (NUL-delimited), so a literal
    // word like "SLIDE" in the document text can never trigger a false split.
    const D = '\u0000SLIDE\u0000';
    const working = html
        .replace(/(<h[12][\s>])/gi, D + '$1')
        .replace(/<hr\b[^>]*>/gi, D);

    const pieces = working.split(D);
    const slides = [];

    for (const piece of pieces) {
        const trimmed = piece.trim();
        if (trimmed === '') {
            continue;
        }

        const headingMatch = trimmed.match(/^<h[12][^>]*>([\s\S]*?)<\/h[12]>/i);
        const title = headingMatch
            ? clean(headingMatch[1].replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim()
            : '';

        slides.push({ title, html: trimmed });
    }

    return slides;
}

// ─── A small HTML tree ───────────────────────────────────────────────────────

const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source',
    'track', 'wbr']);
const TOKEN_RE = /<!--[\s\S]*?-->|<\/([A-Za-z][\w:-]*)\s*>|<([A-Za-z][\w:-]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*\/?>|<[!?][^>]*>|[^<]+|</g;
const ATTR_RE = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

/**
 * Parse an HTML fragment into {tag, attrs, children} elements and {text} nodes.
 * @param {string} html
 * @returns {{tag: string, attrs: Object<string, string>, children: Array}}  the root ('#root');
 *          attrs objects have no prototype
 */
export function parseHtml(html) {
    const root = {tag: '#root', attrs: {}, children: []};
    const stack = [root];
    const src = String(html == null ? '' : html);
    let m;
    TOKEN_RE.lastIndex = 0;
    while ((m = TOKEN_RE.exec(src)) !== null) {
        const top = stack[stack.length - 1];
        const token = m[0];
        if (m[1]) {
            const tag = m[1].toLowerCase();
            const at = stack.map((n) => n.tag).lastIndexOf(tag);
            if (at > 0) stack.length = at;
        } else if (m[2]) {
            const tag = m[2].toLowerCase();
            const attrs = Object.create(null);
            let a;
            ATTR_RE.lastIndex = 0;
            while ((a = ATTR_RE.exec(m[3] || '')) !== null) {
                attrs[a[1].toLowerCase()] = clean(a[2] ?? a[3] ?? a[4] ?? '');
            }
            const el = {tag, attrs, children: []};
            top.children.push(el);
            if (!VOID_TAGS.has(tag) && !token.endsWith('/>')) stack.push(el);
        } else if (token.startsWith('<!--') || /^<[!?]/.test(token)) {
            // comment or doctype: nothing to show
        } else {
            top.children.push({text: clean(token)});
        }
    }
    return root;
}

/** The text content of a tree node. */
export function textContent(node) {
    if (node.text != null) return node.text;
    return (node.children || []).map(textContent).join('');
}

// ─── Blocks ──────────────────────────────────────────────────────────────────

const INLINE_TAGS = new Set(['a', 'abbr', 'b', 'bdi', 'bdo', 'br', 'cite', 'code', 'data', 'del', 'dfn', 'em',
    'font', 'i', 'img', 'input', 'ins', 'kbd', 'label', 'mark', 'q', 's', 'samp', 'small', 'span', 'strike',
    'strong', 'sub', 'sup', 'time', 'tt', 'u', 'var', 'wbr']);
const SKIP_TAGS = new Set(['audio', 'button', 'canvas', 'embed', 'iframe', 'math', 'object', 'picture', 'script',
    'select', 'style', 'svg', 'template', 'textarea', 'video']);

const isInline = (n) => n.text != null || INLINE_TAGS.has(n.tag);

/**
 * Append every item of `items` to `out`. A loop, not out.push(...items): an
 * argument spread throws "Maximum call stack size exceeded" from roughly
 * 100,000 items, and blocks and slides grow with the document.
 */
export function pushAll(out, items) {
    for (const item of items) out.push(item);
    return out;
}

/**
 * Inline runs of a node list: {text, bold?, italic?, code?, strike?, underline?, href?}
 * and {br: true} for a line break. Whitespace collapses as a browser would.
 * Images met on the way go to `images`.
 */
function inlineRuns(nodes, fmt, out, images) {
    for (const n of nodes) {
        if (n.text != null) {
            const text = n.text.replace(/\s+/g, ' ');
            if (text) out.push({...fmt, text});
            continue;
        }
        const tag = n.tag;
        if (SKIP_TAGS.has(tag)) continue;
        if (tag === 'br') {
            out.push({br: true});
        } else if (tag === 'img') {
            if (images) images.push({kind: 'image', src: n.attrs.src || '', alt: n.attrs.alt || ''});
        } else if (tag === 'input') {
            if ((n.attrs.type || '').toLowerCase() === 'checkbox') out.push({...fmt, text: 'checked' in n.attrs ? '☑ ' : '☐ '});
        } else {
            const f = {...fmt};
            if (tag === 'strong' || tag === 'b') f.bold = true;
            if (tag === 'em' || tag === 'i' || tag === 'cite') f.italic = true;
            if (tag === 'code' || tag === 'kbd' || tag === 'samp' || tag === 'tt') f.code = true;
            if (tag === 's' || tag === 'del' || tag === 'strike') f.strike = true;
            if (tag === 'u' || tag === 'ins') f.underline = true;
            // Only a valid http, https or mailto target becomes a hyperlink; otherwise the text stays plain.
            if (tag === 'a' && externalLinkTarget(n.attrs.href)) f.href = externalLinkTarget(n.attrs.href);
            inlineRuns(n.children, f, out, images);
        }
    }
    return out;
}

/** Collapse spaces across runs, trim the ends, drop empty runs. */
function tidyRuns(runs) {
    const out = [];
    let lastSpace = true;
    for (const r of runs) {
        if (r.br) {
            while (out.length && out[out.length - 1].text === ' ') out.pop();
            out.push(r);
            lastSpace = true;
            continue;
        }
        let text = lastSpace ? r.text.replace(/^ /, '') : r.text;
        if (!text) continue;
        lastSpace = text.endsWith(' ');
        out.push({...r, text});
    }
    const last = out[out.length - 1];
    if (last && !last.br) {
        last.text = last.text.replace(/ $/, '');
        if (!last.text) out.pop();
    }
    while (out.length && out[out.length - 1].br) out.pop();
    while (out.length && out[0].br) out.shift();
    return out;
}

const runsText = (runs) => runs.map((r) => (r.br ? '\n' : r.text)).join('');

function textBlock(kind, runs, extra = {}) {
    const tidy = tidyRuns(runs);
    if (!tidy.length) return null;
    return {kind, text: runsText(tidy), runs: tidy, ...extra};
}

function tableBlock(table) {
    const rows = [];
    const visit = (node, inHead) => {
        for (const c of node.children || []) {
            if (c.tag === 'thead') visit(c, true);
            else if (c.tag === 'tbody' || c.tag === 'tfoot') visit(c, false);
            else if (c.tag === 'tr') {
                const cells = c.children.filter((x) => x.tag === 'td' || x.tag === 'th').map((cell) => ({
                    text: textContent(cell).replace(/\s+/g, ' ').trim(),
                    header: inHead || cell.tag === 'th',
                    colspan: Math.max(1, parseInt(cell.attrs.colspan, 10) || 1),
                    rowspan: Math.max(1, parseInt(cell.attrs.rowspan, 10) || 1),
                    align: ['left', 'center', 'right'].includes(cell.attrs.align) ? cell.attrs.align : '',
                }));
                if (cells.length) rows.push(cells);
            }
        }
    };
    visit(table, false);
    return rows.length ? {kind: 'table', rows, text: rows.map((r) => r.map((c) => c.text).join(' | ')).join('\n')} : null;
}

/**
 * Content blocks of one slide's HTML, in order. h1/h2 are the slide title and
 * are left out.
 *   {kind: 'para'|'quote'|'heading', text, runs, level?}
 *   {kind: 'bullet', text, runs, level, ordered, start, number, list, checkbox?}
 *     (number: the item's own number; list: an id shared by the items of one list)
 *   {kind: 'code', text, lines}
 *   {kind: 'table', text, rows: [[{text, header, colspan, rowspan, align}]]}
 *   {kind: 'image', src, alt}
 * @param {string} html
 * @returns {Array<object>}
 */
export function slideBlocks(html) {
    const out = [];
    flow(parseHtml(html).children, {state: {lists: 0}}, out);
    return out;
}

function flow(nodes, ctx, out) {
    let pending = [];
    const flush = () => {
        if (!pending.length) return;
        const images = [];
        const b = textBlock(ctx.quote ? 'quote' : 'para', inlineRuns(pending, {}, [], images));
        if (b) out.push(b);
        pushAll(out, images);
        pending = [];
    };
    for (const n of nodes) {
        if (isInline(n)) pending.push(n);
        else {
            flush();
            block(n, ctx, out);
        }
    }
    flush();
}

function block(n, ctx, out) {
    const tag = n.tag;
    if (SKIP_TAGS.has(tag) || tag === 'h1' || tag === 'h2' || tag === 'hr') return;
    if (/^h[3-6]$/.test(tag)) {
        const b = textBlock('heading', inlineRuns(n.children, {}, []), {level: Number(tag[1])});
        if (b) out.push(b);
    } else if (tag === 'p') {
        flow(n.children, ctx, out);
    } else if (tag === 'blockquote') {
        flow(n.children, {...ctx, quote: true}, out);
    } else if (tag === 'ul' || tag === 'ol') {
        list(n, ctx.level || 0, out, ctx.state);
    } else if (tag === 'pre') {
        const lines = textContent(n).replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n').map((l) => l.replace(/\t/g, '    '));
        out.push({kind: 'code', lines, text: lines.join('\n')});
    } else if (tag === 'table') {
        const t = tableBlock(n);
        if (t) out.push(t);
    } else {
        flow(n.children, ctx, out);
    }
}

function list(n, level, out, state) {
    const ordered = n.tag === 'ol';
    const startAttr = parseInt(n.attrs.start, 10);
    const start = ordered && Number.isFinite(startAttr) ? startAttr : 1;
    const listId = ++state.lists;
    let index = 0;
    for (const li of n.children) {
        if (li.tag !== 'li') continue;
        const number = start + index++;
        let runs = [];
        const images = [];
        let emitted = false;
        const emit = () => {
            if (emitted) return;
            emitted = true;
            const tidy = tidyRuns(runs);
            if (!tidy.length) return;
            const item = {kind: 'bullet', text: runsText(tidy), runs: tidy, level, ordered, start, number, list: listId};
            // A task item: the checkbox replaces the bullet.
            const box = /^([☐☑]) /.exec(item.text);
            if (box) {
                item.checkbox = box[1] === '☑';
                item.runs = tidyRuns([{...tidy[0], text: tidy[0].text.slice(2)}, ...tidy.slice(1)]);
                item.text = runsText(item.runs);
            }
            out.push(item);
            pushAll(out, images.splice(0));
        };
        for (const c of li.children) {
            if (isInline(c)) {
                inlineRuns([c], {}, runs, images);
            } else if (c.tag === 'p' && !emitted) {
                if (runs.length) runs.push({br: true});
                inlineRuns(c.children, {}, runs, images);
            } else if (c.tag === 'ul' || c.tag === 'ol') {
                emit();
                list(c, level + 1, out, state);
            } else {
                emit();
                block(c, {level: level + 1, state}, out);
            }
        }
        emit();
    }
}

// ─── Layout ──────────────────────────────────────────────────────────────────

/** Slide sizes in inches: 4:3, landscape by default in PowerPoint, portrait as a custom layout. */
export const SLIDE_SIZES = Object.freeze({
    landscape: Object.freeze({w: 10, h: 7.5}),
    portrait: Object.freeze({w: 7.5, h: 10}),
});

// Type sizes in points and the measures the layout estimates with.
export const BODY_PT = 14;
export const CODE_PT = 11;
export const TABLE_PT = 12;
const PT = 1 / 72;
const BODY_LINE = BODY_PT * 1.2 * PT;
const PARA_GAP = 6 * PT;
// Average character widths. 0.58 em covers Montserrat and the wider fonts a
// viewer substitutes when it is not installed (measured in LibreOffice: 54
// characters of running text per 6.3 in line at 14 pt); monospace is 0.6 em.
const BODY_CHAR = BODY_PT * 0.58 * PT;
const CODE_LINE = CODE_PT * 1.2 * PT;
const CODE_CHAR = CODE_PT * 0.6 * PT;
const TABLE_LINE = TABLE_PT * 1.2 * PT;
const TABLE_CHAR = TABLE_PT * 0.58 * PT;
const BULLET_INDENT = 0.3;
const BOX_PAD = 0.1;   // a text box's top and bottom insets together
const BOX_INSETS = 0.2; // a text box's left and right insets together
const BLOCK_GAP = 0.15; // space after a code box, table or image

/**
 * Where content goes on a slide, in inches: x, y, width and height of the
 * content area below the title and above the footer.
 * @param {string} orientation  'landscape' or 'portrait'
 */
export function slideFrame(orientation) {
    const {w, h} = orientation === 'landscape' ? SLIDE_SIZES.landscape : SLIDE_SIZES.portrait;
    return {w, h, x: 0.5, y: 1.1, cw: w - 1, ch: h - 1.7};
}

/**
 * How many single-line paragraphs or bullets fit on one slide: 18 in
 * landscape, 25 in portrait. Longer sections continue on "(cont.)" slides.
 * @param {string} orientation
 */
export function slideLineBudget(orientation) {
    return Math.floor((slideFrame(orientation).ch - BOX_PAD) / (BODY_LINE + PARA_GAP) + 1e-9);
}

/**
 * Lines a text takes when wrapped at spaces into lines of `widthIn` inches,
 * as a text box does: words are packed greedily, a word that does not fit
 * starts the next line, and a word longer than a line is broken across lines.
 */
function wrappedLines(text, widthIn, charIn) {
    const perLine = Math.max(8, Math.floor(widthIn / charIn));
    let total = 0;
    for (const line of String(text).split('\n')) {
        let lines = 1;
        let used = 0;
        for (const word of line.split(' ')) {
            const w = word.length;
            if (used > 0 && used + 1 + w <= perLine) {
                used += 1 + w;
                continue;
            }
            if (used > 0) lines++;
            lines += w > 0 ? Math.floor((w - 1) / perLine) : 0;
            used = w > 0 ? ((w - 1) % perLine) + 1 : 0;
        }
        total += lines;
    }
    return total;
}

/** Column widths for a table block: equal shares of the content width. */
export function tableColumns(rows) {
    return rows.reduce((max, r) => Math.max(max, r.reduce((n, c) => n + c.colspan, 0)), 1);
}

function rowHeight(row, colW) {
    const lines = row.reduce((max, c) => Math.max(max, wrappedLines(c.text, colW * c.colspan - 0.2, TABLE_CHAR)), 1);
    return lines * TABLE_LINE + 0.12;
}

/**
 * The estimated height of a block on a slide, in inches. Text blocks include
 * their paragraph spacing; code, tables and images the gap after them.
 * @param {object} b  a slideBlocks() block (images carry h once measured)
 * @param {{cw: number, ch: number}} frame
 */
export function blockHeight(b, frame) {
    switch (b.kind) {
        case 'code':
            return wrappedLines(b.lines.join('\n'), frame.cw - 0.2, CODE_CHAR) * CODE_LINE + BOX_PAD + 0.1 + BLOCK_GAP;
        case 'table': {
            const colW = frame.cw / tableColumns(b.rows);
            return b.rows.reduce((n, r) => n + rowHeight(r, colW), 0) + BLOCK_GAP;
        }
        case 'image':
            return (b.h || frame.ch * 0.6) + BLOCK_GAP;
        case 'heading':
            return wrappedLines(b.text, frame.cw - BOX_INSETS, BODY_CHAR * 16 / BODY_PT) * 16 * 1.2 * PT + PARA_GAP;
        default: {
            const indent = b.kind === 'bullet' ? BULLET_INDENT * (b.level + 1) : 0;
            const lines = wrappedLines(b.text, frame.cw - BOX_INSETS - indent, BODY_CHAR);
            return lines * BODY_LINE + PARA_GAP;
        }
    }
}

const TEXT_KINDS = new Set(['para', 'quote', 'heading', 'bullet']);
export const isTextBlock = (b) => TEXT_KINDS.has(b.kind);

/** Rows of a table that may start a new slide: not inside a rowspan from above. */
function rowBreaks(rows) {
    const open = new Array(rows.length).fill(0);
    rows.forEach((row, r) => {
        for (const c of row) for (let k = 1; k < c.rowspan && r + k < rows.length; k++) open[r + k] = 1;
    });
    return open.map((o) => !o);
}

const ELLIPSIS = '…';

/** Runs split at a character offset of runsText(runs) (a line break counts as one character). */
function splitRuns(runs, offset) {
    const left = [];
    const right = [];
    let pos = 0;
    for (const r of runs) {
        const len = r.br ? 1 : r.text.length;
        if (pos + len <= offset) left.push(r);
        else if (pos >= offset || r.br) right.push(r);
        else {
            left.push({...r, text: r.text.slice(0, offset - pos)});
            right.push({...r, text: r.text.slice(offset - pos)});
        }
        pos += len;
    }
    return [tidyRuns(left), tidyRuns(right)];
}

/**
 * A paragraph, quote, heading or bullet too tall for one slide, cut into parts
 * that each fit: at the end of a sentence when there is one near the cut, else
 * at a space, else (one enormous word) anywhere. Parts after the first carry
 * cont: true, so a bullet is not drawn again.
 */
function splitText(b, frame, limit) {
    const parts = [];
    let rest = b;
    while (blockHeight(rest, frame) > limit) {
        const text = rest.text;
        const fits = (k) => blockHeight({...rest, text: text.slice(0, k)}, frame) <= limit;
        let lo = 1;
        let hi = text.length;
        while (lo < hi) {
            const mid = Math.ceil((lo + hi) / 2);
            if (fits(mid)) lo = mid;
            else hi = mid - 1;
        }
        let cut = lo;
        const floor = Math.floor(lo * 0.6);
        const sentence = Math.max(text.lastIndexOf('. ', lo - 1), text.lastIndexOf('! ', lo - 1), text.lastIndexOf('? ', lo - 1));
        const space = text.lastIndexOf(' ', lo);
        if (sentence >= floor) cut = sentence + 1;
        else if (space >= floor) cut = space;
        const [head, tail] = splitRuns(rest.runs, cut);
        if (!head.length || !tail.length) break;
        parts.push({...rest, runs: head, text: runsText(head)});
        rest = {...rest, runs: tail, text: runsText(tail), cont: true};
    }
    parts.push(rest);
    return parts;
}

/** Code split by wrapped height; a single line taller than a slide is cut with an ellipsis. */
function splitCode(b, frame, limit, warn) {
    const budget = limit - BOX_PAD - 0.1 - BLOCK_GAP;
    const width = frame.cw - 0.2;
    const perLine = Math.max(8, Math.floor(width / CODE_CHAR));
    const maxChars = Math.max(1, Math.floor(budget / CODE_LINE)) * perLine - 1;
    const parts = [];
    let cur = [];
    let h = 0;
    let cutShort = false;
    for (let line of b.lines) {
        if (wrappedLines(line, width, CODE_CHAR) * CODE_LINE > budget) {
            line = line.slice(0, maxChars) + ELLIPSIS;
            cutShort = true;
        }
        const lh = wrappedLines(line, width, CODE_CHAR) * CODE_LINE;
        if (cur.length && h + lh > budget + 1e-9) {
            parts.push(cur);
            cur = [];
            h = 0;
        }
        cur.push(line);
        h += lh;
    }
    if (cur.length) parts.push(cur);
    if (cutShort) warn('A code line is too long for one slide and is cut short in PowerPoint.');
    return parts.map((lines) => ({...b, lines, text: lines.join('\n')}));
}

/** A row whose cells are cut (with an ellipsis) to fit `available` inches. */
function fitRow(row, colW, available) {
    const maxLines = Math.max(1, Math.floor((available - 0.12) / TABLE_LINE));
    return row.map((c) => {
        const width = colW * c.colspan - 0.2;
        const fits = (s) => wrappedLines(s, width, TABLE_CHAR) <= maxLines;
        if (fits(c.text)) return c;
        // The longest start of the text that still fits with the ellipsis after it.
        let lo = 0;
        let hi = c.text.length;
        while (lo < hi) {
            const mid = Math.ceil((lo + hi) / 2);
            if (fits(c.text.slice(0, mid).trimEnd() + ELLIPSIS)) lo = mid;
            else hi = mid - 1;
        }
        return {...c, text: c.text.slice(0, lo).trimEnd() + ELLIPSIS};
    });
}

/** A table split by rows, the header row repeated; a row taller than a slide is cut short. */
function splitTable(b, frame, limit, warn) {
    const colW = frame.cw / tableColumns(b.rows);
    let headCount = 0;
    while (headCount < b.rows.length - 1 && b.rows[headCount].every((c) => c.header)) headCount++;
    const head = b.rows.slice(0, headCount);
    const headH = head.reduce((n, r) => n + rowHeight(r, colW), 0);
    const available = limit - BLOCK_GAP - headH;
    const breaks = rowBreaks(b.rows);
    const parts = [];
    let cur = [];
    let h = headH + BLOCK_GAP;
    let cutShort = false;
    for (let r = headCount; r < b.rows.length; r++) {
        let row = b.rows[r];
        if (rowHeight(row, colW) > available) {
            row = fitRow(row, colW, available);
            cutShort = true;
        }
        const rh = rowHeight(row, colW);
        if (cur.length && breaks[r] && h + rh > limit + 1e-9) {
            parts.push(cur);
            cur = [];
            h = headH + BLOCK_GAP;
        }
        cur.push(row);
        h += rh;
    }
    if (cur.length) parts.push(cur);
    if (cutShort) warn('A table row is too tall for one slide and its text is cut short in PowerPoint.');
    return parts.map((rows) => {
        const all = [...head, ...rows];
        return {...b, rows: all, text: all.map((r) => r.map((c) => c.text).join(' | ')).join('\n')};
    });
}

/** Pieces of a block too tall for one slide, each fitting one. */
function splitBlock(b, frame, limit, warn) {
    if (b.kind === 'code') return splitCode(b, frame, limit, warn);
    if (b.kind === 'table') return splitTable(b, frame, limit, warn);
    if (b.kind === 'image') return [{...b, h: Math.max(0.5, limit - BLOCK_GAP)}];
    if (isTextBlock(b)) return splitText(b, frame, limit);
    return [b];
}

/**
 * Lay a section's blocks out on slides. Blocks go on in order until the next
 * would pass the bottom of the content area; then a new slide starts, titled
 * "<title> (cont.)". A block taller than a whole slide is split first:
 * paragraphs and list items at sentence or word boundaries, code by wrapped
 * lines, tables by rows with the header repeated. What cannot be split (one
 * table row, one code line taller than a slide) is cut with an ellipsis and
 * reported through onWarning, so no slide holds more than fits.
 * @param {{title: string, blocks: Array<object>}} section
 * @param {string} orientation
 * @param {{onWarning?: (message: string) => void}} [opts]
 * @returns {Array<{title: string, blocks: Array<object>, cont: boolean}>}
 */
export function paginateSection(section, orientation, {onWarning} = {}) {
    const frame = slideFrame(orientation);
    const limit = frame.ch - BOX_PAD;
    const warn = typeof onWarning === 'function' ? onWarning : () => {};
    const pages = [[]];
    let used = 0;
    const place = (b) => {
        const h = blockHeight(b, frame);
        if (used + h > limit + 1e-9 && pages[pages.length - 1].length) {
            pages.push([]);
            used = 0;
        }
        pages[pages.length - 1].push(b);
        used += h;
    };
    for (const b of section.blocks || []) {
        if (blockHeight(b, frame) > limit) splitBlock(b, frame, limit, warn).forEach(place);
        else place(b);
    }
    const title = section.title || '';
    return pages.map((blocks, i) => ({
        title: i > 0 && title ? `${title} (cont.)` : title,
        blocks,
        cont: i > 0,
    }));
}
