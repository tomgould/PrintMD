/**
 * pdf-import.js
 *
 * Converts a PDF File to Markdown via PDF.js (an ES module and module worker
 * from vendor/pdfjs/, imported on first use).
 *
 * Strategy:
 *   1. Tagged PDFs (Chrome/Skia-generated) → read the embedded semantic structure
 *      tree (H1-H6, P, L, LI, Code, BlockQuote, Table, Strong, Em …). Near-perfect.
 *   2. Non-tagged PDFs, or a tagged one whose tree yields nothing → heuristic
 *      text-position analysis. A PDF with no text at all (a scan) is refused.
 */

import {codeSpan, escapeBlockStart, escapeTextRun, fencedBlock, maxOf, minOf, safeLinkUrl, warn} from './import-utils.js';

// Resolve vendor paths relative to this module file, not the page URL, so they
// load whether the page is at the root or in a sub-directory (e.g. tests/).
const PDFJS_SRC = new URL('../vendor/pdfjs/pdf.min.mjs', import.meta.url).href;
const WORKER_SRC = new URL('../vendor/pdfjs/pdf.worker.min.mjs', import.meta.url).href;

/** Above this many pages the user is asked before the import goes on. */
export const LARGE_PDF_PAGES = 300;

export const NO_TEXT_MESSAGE = 'No text layer (scanned PDF?). This PDF has no selectable text, so there is nothing to import. Run it through OCR first, then import the result.';

let pdfJsLoad = null;

/** pdf.js as a module (no window global, so no element id can stand in for it). */
function loadPdfJs() {
    if (!pdfJsLoad) {
        pdfJsLoad = import(PDFJS_SRC).then((lib) => {
            if (typeof lib.getDocument !== 'function') throw new Error('the module has no getDocument');
            if (lib.GlobalWorkerOptions && !lib.GlobalWorkerOptions.workerSrc) lib.GlobalWorkerOptions.workerSrc = WORKER_SRC;
            return lib;
        }).catch((err) => {
            pdfJsLoad = null;   // allow a retry
            throw new Error('Could not load PDF.js from vendor/pdfjs/: ' + err.message);
        });
    }
    return pdfJsLoad;
}

/**
 * The getDocument() parameters for imported bytes. isEvalSupported: false
 * keeps pdf.js from compiling font code with new Function (pdf.js 6 has no such
 * path left; the flag stays as a guard). useWasm: false keeps the image
 * decoders in JavaScript, since the CSP does not allow WebAssembly.
 * fontExtraProperties: true keeps each loaded font's real name ("Inter-Bold"),
 * which says whether text is bold, italic or monospaced. disableFontFace: true
 * keeps the PDF's fonts out of the page's document.fonts: the importer reads
 * their names, it never draws with them.
 */
export function documentParams(data) {
    return {data, isEvalSupported: false, useWasm: false, fontExtraProperties: true, disableFontFace: true};
}

/** Stands where a PDF image was: images are not extracted yet, so the reader sees that one was there. */
export const IMAGE_PLACEHOLDER = '*\\[image not imported\\]*';

// ─────────────────────────────────────────────────────────────────────────────
// Tagged PDF path  (Chrome / Skia PDF engine embeds full ARIA structure)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a map of  mcid  →  { texts: string[], y: number, x: number }
 * from a page's marked-content text stream.
 */
async function buildMcidMap(page) {
    const content = await page.getTextContent({includeMarkedContent: true});
    const pageWidth = page.getViewport({scale: 1}).width;
    const map = new Map();
    // Marked content nests: a span with no id (e.g. the ActualText Chrome puts
    // round a ligature) belongs to the id around it, and ending it returns there.
    const stack = [];
    const current = () => stack[stack.length - 1] || null;

    for (const item of content.items) {
        if (item.type === 'beginMarkedContentProps' || item.type === 'beginMarkedContent') {
            const id = item.id || current();
            stack.push(id);
            if (id && !map.has(id)) map.set(id, {texts: [], items: [], y: null, x: null});
        } else if (item.type === 'endMarkedContent') {
            stack.pop();
        } else if (current() && item.str && item.transform) {
            const entry = map.get(current());
            entry.items.push({str: item.str, dir: item.dir, x: item.transform[4], y: item.transform[5], width: item.width || 0});
            if (entry.y === null) {
                entry.y = item.transform[5];
                entry.x = item.transform[4];  // capture x position for code layout
            }
        }
    }
    // Each entry's text, line by line (top to bottom), in reading order with plain
    // letters: the same treatment as the position path, so Arabic and Hebrew stored
    // visually come out logically here too. Wrapped lines join with a space, or
    // without one after a hyphen (joinWrapped).
    for (const entry of map.values()) {
        const lines = new Map();
        for (const it of entry.items) {
            const key = Math.round(it.y / Y_TOL) * Y_TOL;
            if (!lines.has(key)) lines.set(key, []);
            lines.get(key).push(it);
        }
        const keys = [...lines.keys()].sort((a, b) => b - a);
        // Letter-spaced capitals are joined into words (spacedCapsText), never left as "N O R T H".
        const text = (its) => {
            const t = lineText(its, pageWidth).text;
            return isSpacedCaps(t.replace(/\s+/g, ' ').trim()) ? spacedCapsText(orderLineItems(its, pageWidth).items) : t;
        };
        entry.texts = keys.length ? [keys.map(k => text(lines.get(k))).reduce((acc, t) => (acc ? joinWrapped(acc, t) : t), '')] : [];
        delete entry.items;
    }
    return map;
}

/** Collect all leaf content IDs from a struct-tree node, in order. */
function collectLeafIds(node, out = []) {
    if (node.type === 'content') {
        out.push(node.id);
        return out;
    }
    if (node.children) node.children.forEach(c => collectLeafIds(c, out));
    return out;
}

/** Get the plain concatenated text for a node. */
function nodeText(node, mcidMap) {
    return collectLeafIds(node).map(id => {
        const e = mcidMap.get(id);
        return e ? e.texts.join('') : '';
    }).join('').replace(/\s+/g, ' ').trim();
}

/** nodeText escaped for Markdown prose: PDF text such as "<img ...>" stays text. */
function nodeMarkdown(node, mcidMap) {
    return escapeTextRun(nodeText(node, mcidMap));
}

/** Render a code block, reconstructing lines from y-positions. */
function renderCodeNode(node, mcidMap) {
    const entries = [];

    function collect(n) {
        if (n.type === 'content') {
            const e = mcidMap.get(n.id);
            if (e) entries.push({...e, x: e.x || 0});
        }
        if (n.children) n.children.forEach(collect);
    }

    collect(node);
    if (!entries.length) return '';

    // Group by y-coord (tolerance 2pts), then within each group sort by x
    const lineMap = new Map();
    for (const e of entries) {
        const yKey = Math.round((e.y || 0) / 2) * 2;
        if (!lineMap.has(yKey)) lineMap.set(yKey, []);
        lineMap.get(yKey).push(e);
    }

    // Sort lines by descending y (PDF coords: higher y = higher on page)
    const sortedYs = [...lineMap.keys()].sort((a, b) => b - a);
    const codeLines = sortedYs.map(y => {
        const items = lineMap.get(y).sort((a, b) => (a.x || 0) - (b.x || 0));
        return items.map(e => e.texts.join('')).join('').trimEnd();
    });

    const codeText = codeLines.join('\n');
    return fencedBlock(codeText, guessLang(codeText));
}

/**
 * Generate a Markdown heading anchor slug: mirrors what marked.js produces for `# Heading`.
 * Used for both TOC links and GoTo (internal) link annotations.
 */
function makeAnchor(text) {
    return text
        .toLowerCase()
        .replace(/[`[\]()]/g, '')
        .replace(/&/g, '')
        .replace(/[^\w\s-]/g, '')
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-')
        .trim();
}

/**
 * Lookup the annotation for a Link struct node by matching against page annotations.
 * Returns { url, internal } where internal=true means a GoTo (same-doc) link,
 * or null if not found.
 */
function findLinkUrl(node, mcidMap, annotations) {
    if (!annotations?.length) return null;
    const ids = collectLeafIds(node);
    for (const id of ids) {
        const e = mcidMap.get(id);
        if (e && e.y !== null) {
            const x = e.x || 0;
            const y = e.y; // PDF coords: bottom-up
            for (const ann of annotations) {
                const [x1, y1, x2, y2] = ann.rect;
                if (x >= x1 - 5 && x <= x2 + 5 && y >= y1 - 5 && y <= y2 + 5) {
                    return {url: ann.url, internal: ann.internal};
                }
            }
        }
    }
    return null;
}

/**
 * Render a paragraph from a node's children (or from a list of sibling nodes),
 * preserving inline Strong / Em / Code / Link.
 */
function renderParagraphNode(node, mcidMap, annotations = []) {
    let foundInlineLink = false;

    // Spaces at span boundaries carry real spacing, so they stay outside the markup:
    // "with" + " bold" -> "with **bold**", not "with** bold**".
    const wrap = (inner, fn) => {
        const {lead, core, trail} = splitOuterSpace(inner);
        return lead + fn(core) + trail;
    };

    // Text is escaped except inside code spans, where `<` is already literal.
    function inline(n, inCode = false) {
        if (n.type === 'content') {
            const e = mcidMap.get(n.id);
            const text = e ? e.texts.join('') : '';
            return inCode ? text : escapeTextRun(text);
        }
        const role = n.role;
        const inner = (n.children || []).map(c => inline(c, inCode || role === 'Code')).join('');
        if (!inner.trim()) return inner.replace(/\S/g, '');
        if (role === 'Strong') return wrap(inner, t => `**${t}**`);
        if (role === 'Em') return wrap(inner, t => `*${t}*`);
        if (role === 'Code') return inCode ? inner : wrap(inner, codeSpan);
        if (role === 'Link') {
            const ann = findLinkUrl(n, mcidMap, annotations);
            if (!ann || (!ann.internal && !ann.url)) return inner;
            foundInlineLink = true;
            // `inner` is already escaped text, so it goes into the link as it is.
            return wrap(inner, text => (ann.internal ? `[${text}](#${makeAnchor(text)})` : linkTo(text, ann.url)));
        }
        return inner;
    }

    const kids = Array.isArray(node) ? node : (node.children || []);
    let result = tightenAfterCode(repairSpacing(kids.map(c => inline(c)).join('')));

    // Fallback: many PDFs do not tag TOC entries (or other hyperlinked text) with a
    // Link struct role: the GoTo/URI annotation sits on the page but isn't wired into
    // the accessibility tree.  If we found no inline Link node above, check whether
    // this whole paragraph overlaps a link annotation and wrap it accordingly.
    if (result && !foundInlineLink && annotations.length) {
        const ann = findLinkUrl(Array.isArray(node) ? {children: node} : node, mcidMap, annotations);
        if (ann) {
            // Strip trailing page number artefacts before generating the anchor
            // (e.g. "Introduction 3" → anchor "introduction", matching the heading).
            const cleanText = stripPageNumber(result) || result;
            if (ann.internal) {
                return `[${cleanText}](#${makeAnchor(cleanText)})`;
            } else if (ann.url) {
                return linkTo(result, ann.url);
            }
        }
    }

    return escapeBlockStart(result);
}

/**
 * Common hyphenated compounds: a line ending in the first word and a hyphen,
 * followed by the second word, keeps its hyphen. A word split by the
 * typesetter ("in-" + "formation", "read-" + "ers") loses it.
 */
const KNOWN_COMPOUNDS = new Set(['self-contained', 'self-hosted', 'self-service', 'self-help', 'self-employed', 'self-made',
    'non-profit', 'non-zero', 'non-empty', 'non-null', 'non-blocking', 'non-trivial', 'well-known', 'well-being',
    'well-defined', 'e-mail', 'e-book', 'co-author', 'co-founder', 'co-operate', 'anti-virus', 'read-only', 'write-only',
    'built-in', 'opt-in', 'opt-out', 'sign-in', 'sign-up', 'log-in', 'follow-up', 'set-up', 'one-off', 'long-term',
    'short-term', 'real-time', 'full-time', 'part-time', 'high-level', 'low-level', 'open-source', 'end-user', 'x-ray']);

/** A soft hyphen: a break the typesetter may use, never part of the word. */
const SOFT_HYPHEN = String.fromCharCode(0xad);

/**
 * How two wrapped lines join. A line that ends in a soft hyphen joins the next
 * line directly. One that ends in a word and a hyphen joins the next word
 * without a space: the hyphen stays before a capital or a digit, after digits,
 * in a known compound or a longer token ("non-English", "2020-2021",
 * "self-contained", "state-of-the-art", "pdf-cell-beacon.png"), and goes when
 * a word was split ("inter-" + "national"). Anything else joins with a space.
 * Looks at most 40 characters back, so it is linear.
 * @returns {{dropHyphen: boolean, space: boolean}}
 */
function wrapJoin(prev, next) {
    if (prev.endsWith(SOFT_HYPHEN)) return {dropHyphen: true, space: false};
    const tail = prev.slice(-40);
    const m = /([\p{L}\p{N}]+)-$/u.exec(tail);
    if (!m || !/^[\p{L}\p{N}]/u.test(next)) return {dropHyphen: false, space: true};
    const word = m[1];
    // The whole last token, opening brackets and quotes aside: "pdf-cell-", "example.com/a-".
    const token = /\S*$/u.exec(tail)[0].replace(/^[(["'‘“«]+/u, '');
    const nextWord = /^[\p{L}]*/u.exec(next)[0].toLowerCase();
    const keep = /^[\p{Lu}\p{N}]/u.test(next) || /\p{N}$/u.test(word) || KNOWN_COMPOUNDS.has(`${word.toLowerCase()}-${nextWord}`)
        || token.length > word.length + 1;
    return {dropHyphen: !keep, space: false};
}

/** Two wrapped lines of text as one (see wrapJoin). */
export function joinWrapped(prev, next) {
    const a = String(prev).trimEnd();
    const b = String(next).trimStart();
    if (!a || !b) return a || b;
    const j = wrapJoin(a, b);
    return (j.dropHyphen ? a.slice(0, -1) : a) + (j.space ? ' ' : '') + b;
}

/** Leading whitespace, the rest, and trailing whitespace of a string (no regex, so linear). */
export function splitOuterSpace(s) {
    const start = s.length - s.trimStart().length;
    const core = s.trim();
    return {lead: s.slice(0, start), core, trail: s.slice(start + core.length)};
}

/**
 * Collapse whitespace and repair spacing lost between PDF text items: a space
 * after . ! ? before a capital, and after , or ; before a letter or digit (not
 * after the ";" of an entity such as "&lt;"). Colons are left alone, as they
 * appear in URLs and emoji shortcodes. Every pattern here is linear.
 */
export function repairSpacing(text) {
    return text
        .replace(/\s+/g, ' ')
        .replace(/([.!?])([A-Z])/g, '$1 $2')
        .replace(/(&#?[A-Za-z0-9]+;)|([,;])([A-Za-z0-9])/g, (m, entity, punct, next) => entity || `${punct} ${next}`)
        .trim();
}

/**
 * A code span's padding reads as a space before the punctuation after it: "`a.ts` ," is "`a.ts`,".
 * Only punctuation that ends a word ("`x` .env" keeps its space). Used by the tagged and the
 * untagged paths. Linear: one character, then a run of backticks, then fixed-width parts.
 */
export function tightenAfterCode(text) {
    return text.replace(/([^\\`]`+) ([,.;:!?)])(?=[\s,.;:!?)]|$)/g, '$1$2');
}

const isLeader = (c) => c === '.' || c === '·' || c.trim() === '';

/**
 * A TOC entry without its leader and page number: "Introduction ..... 3" ->
 * "Introduction". Text that does not end in leader-then-digits is returned
 * trimmed. A loop from the end, so long runs of dots or spaces stay cheap.
 */
export function stripPageNumber(text) {
    const s = String(text).trimEnd();
    let i = s.length;
    while (i > 0 && s[i - 1] >= '0' && s[i - 1] <= '9') i--;
    if (i === s.length) return s.trim();
    const digitsStart = i;
    while (i > 0 && isLeader(s[i - 1])) i--;
    if (i === digitsStart) return s.trim();
    return s.slice(0, i).trim();
}

/**
 * A link around already-escaped text. `url` has passed safeLinkUrl; a `|` is
 * encoded too, so the link can sit in a table cell.
 */
function linkTo(escapedText, url) {
    return `[${escapedText}](<${url.replace(/\|/g, '%7C')}>)`;
}

/**
 * The Markdown marker for a list label: "- " for a bullet (•, ◦, -, an empty
 * label drawn as a shape...), "N. " for a numbered label ("3.", "(3)"), and
 * "N. " by position for letters or roman numerals, which Markdown cannot number.
 */
function listMarker(label, position) {
    const t = label.replace(/\s+/g, '');
    const num = /^\(?(\d{1,9})[.)]?$/.exec(t);
    if (num) return `${Number(num[1])}. `;
    if (/^\(?([a-z]|[ivxlcdm]+)[.)]$/i.test(t)) return `${position}. `;
    return '- ';
}

/** Render a list node (L) → Markdown list items. */
function renderListNode(node, mcidMap, depth = 0, annotations = [], checkboxes = []) {
    const lines = [];
    const indent = '  '.repeat(depth);
    let position = 0;

    for (const child of (node.children || [])) {
        if (child.role !== 'LI') continue;
        position++;

        // LBody is the item's content wrapper: its children count as the item's own.
        const parts = (child.children || []).flatMap(c => (c.role === 'LBody' ? (c.children || []) : [c]));
        const lbl = parts.find(c => c.role === 'Lbl');
        const hasForm = parts.some(c => c.role === 'Form');

        // Inline runs (text, Strong, Link...) merge into the item line; P and
        // other blocks are separate runs; nested lists follow the item line.
        const textParts = [];
        const subLists = [];
        let run = [];
        const flush = () => {
            if (run.length) textParts.push(renderParagraphNode(run, mcidMap, annotations));
            run = [];
        };
        for (const c of parts) {
            if (c.role === 'Lbl' || c.role === 'Form') continue;
            if (c.role === 'L') {
                flush();
                subLists.push(renderListNode(c, mcidMap, depth + 1, annotations, checkboxes));
            } else if (c.role === 'P') {
                flush();
                textParts.push(renderParagraphNode(c, mcidMap, annotations));
            } else {
                run.push(c);
            }
        }
        flush();
        const body = textParts.join(' ').replace(/\s+/g, ' ').trim();
        // An item with no text here (a page break puts its text on another
        // page) would be an empty bullet, so it is left out.
        if (!body && !hasForm && !subLists.some(Boolean)) continue;

        if (hasForm) {
            const checked = isCheckedCheckbox(child, mcidMap, checkboxes);
            lines.push(`${indent}- [${checked ? 'x' : ' '}] ${body}`);
        } else {
            const marker = lbl ? listMarker(nodeText(lbl, mcidMap), position) : '- ';
            lines.push(`${indent}${marker}${body}`);
        }
        // Append nested sub-lists after the item line
        for (const sub of subLists) if (sub) lines.push(sub);
    }
    return lines.join('\n');
}

/** Render a table node (Table > TR > TH/TD), keeping inline formatting and links in cells. */
function renderTableNode(node, mcidMap, annotations = []) {
    const rows = [];

    function collectRows(n) {
        if (n.role === 'TR') {
            const cells = (n.children || [])
                .filter(c => c.role === 'TH' || c.role === 'TD')
                // Cell text arrives with its pipes escaped (escapeTextRun) and link URLs encode theirs.
                .map(c => renderParagraphNode(c, mcidMap, annotations) || nodeMarkdown(c, mcidMap));
            rows.push(cells);
            return;   // a nested table's rows stay inside its cell's text
        }
        if (n.children) n.children.forEach(collectRows);
    }

    collectRows(node);
    if (!rows.length) return '';
    const cols = maxOf(rows, r => r.length);
    for (const r of rows) while (r.length < cols) r.push('');

    const widths = rows[0].map((_, ci) => Math.max(maxOf(rows, r => (r[ci] || '').length), 3));
    const pad = (s, w) => s.padEnd(w);
    const sep = widths.map(w => '-'.repeat(w));

    return [
        '| ' + rows[0].map((c, i) => pad(c, widths[i])).join(' | ') + ' |',
        '| ' + sep.map((s, i) => pad(s, widths[i])).join(' | ') + ' |',
        ...rows.slice(1).map(r =>
            '| ' + r.map((c, i) => pad(c || '', widths[i])).join(' | ') + ' |'
        ),
    ].join('\n');
}

/** Render a blockquote node. */
function renderBlockquoteNode(node, mcidMap, annotations = [], checkboxes = []) {
    const inner = renderStructNodes(node.children || [], mcidMap, 'BlockQuote', annotations, checkboxes);
    return inner.trim().split('\n').map(l => '> ' + l).join('\n');
}

/**
 * Grouping roles with no meaning of their own: the tree is walked through them.
 * Chrome tags every <div> as NonStruct, other producers use Div, Part or Sect.
 */
const CONTAINER_ROLES = new Set(['Root', 'Document', 'Part', 'Art', 'Sect', 'Section', 'Div', 'NonStruct', 'Artifact']);

/** Roles that sit inside a line of text. Consecutive inline nodes form one paragraph. */
const INLINE_ROLES = new Set(['Span', 'Strong', 'Em', 'Link', 'Quote', 'Reference', 'Annot']);

/** A text leaf, an empty marker (e.g. a link's annotation reference) or an inline role. */
const isInlineNode = (n) => n.type === 'content' || (!n.role && !n.children?.length) || INLINE_ROLES.has(n.role);

/** Number of distinct text lines a node's content sits on. */
function lineCount(node, mcidMap) {
    const ys = collectLeafIds(node).map(id => mcidMap.get(id)?.y).filter(y => y != null);
    return new Set(ys.map(y => Math.round(y))).size;
}

/**
 * A container whose subtree holds only inline content, e.g. a <div> of text:
 * it renders as one paragraph. A one-line Code counts as inline (a code span)
 * when there is text beside it; a container of code alone is a code block.
 */
function isInlineContainer(n, mcidMap) {
    if (!CONTAINER_ROLES.has(n.role) || !n.children?.length) return false;
    let hasText = false;
    const inlineOnly = (c) => {
        if (c.role === 'Code') return lineCount(c, mcidMap) <= 1;
        if (isInlineNode(c)) {
            hasText = true;
            return true;
        }
        return CONTAINER_ROLES.has(c.role) && (c.children || []).every(inlineOnly);
    };
    return n.children.every(inlineOnly) && hasText;
}

/** Returns true if a page's struct tree holds nothing but containers and figures (e.g. a cover). */
function isCoverPage(tree) {
    function allCover(n) {
        if (n.role && !CONTAINER_ROLES.has(n.role) && n.role !== 'Figure' && n.role !== 'Span') return false;
        return (n.children || []).every(allCover);
    }

    return allCover(tree);
}

/** Render an array of struct-tree nodes, returning Markdown. */
function renderStructNodes(nodes, mcidMap, parentRole = null, annotations = [], checkboxes = []) {
    const parts = [];
    let run = [];   // consecutive inline siblings, rendered as one paragraph
    const flush = () => {
        if (!run.length) return;
        const text = renderParagraphNode(run, mcidMap, annotations);
        if (text) parts.push(text);
        run = [];
    };

    for (const node of nodes) {
        const role = node.role;

        // Text runs, spans, bold, links... outside a P: gather them into one paragraph.
        if (isInlineNode(node)) {
            run.push(node);
            continue;
        }
        flush();

        // A <div> holding only text and inline markup is a paragraph.
        if (isInlineContainer(node, mcidMap)) {
            const text = renderParagraphNode(node, mcidMap, annotations);
            if (text) parts.push(text);
            continue;
        }

        // Headings
        if (/^H[1-6]$/.test(role)) {
            const level = parseInt(role[1]);
            const text = nodeMarkdown(node, mcidMap);
            if (text) parts.push('#'.repeat(level) + ' ' + text);
            continue;
        }

        switch (role) {
            case 'P': {
                const text = renderParagraphNode(node, mcidMap, annotations);
                if (text) parts.push(text);
                break;
            }
            case 'L': {
                const list = renderListNode(node, mcidMap, 0, annotations, checkboxes);
                if (list) parts.push(list);
                break;
            }
            case 'Code': {
                // Inline code (inside P) handled in renderParagraphNode;
                // here we only see block Code elements
                if (parentRole === 'P') break;
                const code = renderCodeNode(node, mcidMap);
                if (code) parts.push(code);
                break;
            }
            case 'BlockQuote': {
                const bq = renderBlockquoteNode(node, mcidMap, annotations, checkboxes);
                if (bq) parts.push(bq);
                break;
            }
            case 'Table': {
                const tbl = renderTableNode(node, mcidMap, annotations);
                if (tbl) parts.push(tbl);
                break;
            }
            // Table of contents: render as a list with generated heading anchor links
            case 'TOC': {
                const tocItems = [];

                function collectToci(n) {
                    if (n.role === 'TOCI') {
                        // Strip trailing page number (e.g. "Introduction 3" → "Introduction")
                        const raw = stripPageNumber(nodeText(n, mcidMap));
                        if (!raw) return;
                        tocItems.push(`- [${escapeTextRun(raw)}](#${makeAnchor(raw)})`);
                    }
                    if (n.children) n.children.forEach(collectToci);
                }

                collectToci(node);
                if (tocItems.length) parts.push(tocItems.join('\n'));
                break;
            }
            case 'TOCI':
                break; // handled inside TOC case above
            // Caption: italic
            case 'Caption': {
                const text = nodeMarkdown(node, mcidMap);
                if (text) parts.push(`*${text}*`);
                break;
            }
            // Figure: images are not extracted, so a placeholder stands in, with
            // the figure's text or alt text when it has some.
            case 'Figure': {
                if (!collectLeafIds(node).length) break;   // its content is on another page
                const alt = (nodeText(node, mcidMap) || String(node.alt || '')).replace(/\s+/g, ' ').trim();
                parts.push(alt ? `*\\[image: ${escapeTextRun(alt).replace(/[*_]/g, '\\$&')}\\]*` : IMAGE_PLACEHOLDER);
                break;
            }
            // Aside / Note: blockquote
            case 'Aside':
            case 'Note': {
                const inner = renderStructNodes(node.children || [], mcidMap, role, annotations, checkboxes);
                if (inner) parts.push(inner.split('\n').map(l => '> ' + l).join('\n'));
                break;
            }
            default:
                // Containers (Div, Part, Sect, NonStruct...) and unknown roles: recurse
                if (node.children?.length) {
                    const inner = renderStructNodes(node.children, mcidMap, role, annotations, checkboxes);
                    if (inner) parts.push(inner);
                }
                break;
        }
    }
    flush();
    return parts.join('\n\n');
}

/** Check whether the PDF has meaningful structure tags (more than containers and spans). */
async function isTaggedPdf(pdf) {
    try {
        function hasSemanticRole(n) {
            if (n.role && !CONTAINER_ROLES.has(n.role) && !INLINE_ROLES.has(n.role)) return true;
            return (n.children || []).some(hasSemanticRole);
        }

        // Page 1 is often a cover with only Figure/NonStruct: check first 3 pages
        for (let p = 1; p <= Math.min(3, pdf.numPages); p++) {
            const page = await pdf.getPage(p);
            const tree = await page.getStructTree();
            page.cleanup();
            if (tree?.children?.length && hasSemanticRole(tree)) return true;
        }
        return false;
    } catch {
        return false;
    }
}

/** Build a list of link annotations for a page: [{ url, internal, rect }] */
async function buildAnnotations(page) {
    try {
        const anns = await page.getAnnotations();
        return anns
            .filter(a => a.subtype === 'Link' && (a.url || a.unsafeUrl || a.dest))
            .map(a => ({
                // http(s)/mailto/tel only; javascript:, data:, file: etc. are dropped
                url: safeLinkUrl(a.url || a.unsafeUrl || ''),
                internal: !!(a.dest && !(a.url || a.unsafeUrl)),
                rect: a.rect,
            }))
            .filter(a => a.internal || a.url);
    } catch {
        return [];
    }
}

/** Build a map of checkbox widget annotations keyed by approximate y-position. */
async function buildCheckboxes(page) {
    try {
        const anns = await page.getAnnotations();
        return anns
            .filter(a => a.subtype === 'Widget' && (a.fieldType === 'Btn' || a.checkBox))
            .map(a => ({
                checked: a.fieldValue === 'On' || a.fieldValue === true,
                rect: a.rect,
            }));
    } catch {
        return [];
    }
}

/** Return true if a list-item node's y-position overlaps a checked checkbox annotation. */
function isCheckedCheckbox(liNode, mcidMap, checkboxes) {
    if (!checkboxes?.length) return false;
    const ids = collectLeafIds(liNode);
    for (const id of ids) {
        const e = mcidMap.get(id);
        if (e && e.y !== null) {
            const y = e.y;
            for (const cb of checkboxes) {
                const [, y1, , y2] = cb.rect;
                if (y >= y1 - 8 && y <= y2 + 8) return cb.checked;
            }
        }
    }
    return false;
}

/**
 * Number of Figure nodes with content on this page in a struct tree (each one an
 * image or drawing that is not imported). pdf.js also lists the empty siblings of
 * an element that is on the page, which belong to other pages.
 */
function countFigures(node) {
    let n = node.role === 'Figure' && collectLeafIds(node).length ? 1 : 0;
    for (const c of node.children || []) n += countFigures(c);
    return n;
}

const LIST_ITEM_LINE = /^\s*(?:[-*+]|\d{1,9}[.)])\s+\S/;

/**
 * Join a page's Markdown to the previous page's when the page break fell inside
 * a list item or a paragraph: the previous page ends in a list item or plain
 * paragraph without a sentence end, and this page starts with a lower-case
 * continuation (as an item or a paragraph). Otherwise null.
 */
export function joinAcrossPage(prev, next) {
    const lastNl = prev.lastIndexOf('\n');
    const last = prev.slice(lastNl + 1);
    if (!last.trim() || endsSentence(last.trimEnd()) || /^(?:#|\||>|```|~~~|\s{4})/.test(last)) return null;
    const firstNl = next.indexOf('\n');
    const first = firstNl < 0 ? next : next.slice(0, firstNl);
    const rest = firstNl < 0 ? '' : next.slice(firstNl);
    const item = /^\s*(?:[-*+]|\d{1,9}[.)])\s+(\p{Ll}.*)$/u.exec(first);
    if (item && LIST_ITEM_LINE.test(last)) return prev.slice(0, lastNl + 1) + joinWrapped(last, item[1]) + rest;
    if (!item && /^\p{Ll}/u.test(first) && !LIST_ITEM_LINE.test(last)) {
        return prev.slice(0, lastNl + 1) + joinWrapped(last, first) + rest;
    }
    return null;
}

/**
 * Full tagged-PDF conversion. Adds each page's images to stats.images: the
 * images its operator list paints (a decorative image has no Figure in the
 * tree) or its Figure nodes (a drawn figure paints no image), whichever is more.
 */
async function convertTaggedPdf(pdf, onProgress, stats = {images: 0}, OPS = null) {
    const pageMds = [];

    for (let p = 1; p <= pdf.numPages; p++) {
        const page = await pdf.getPage(p);
        const tree = await page.getStructTree();
        if (!tree) continue;
        const graphics = await readGraphics(page, OPS);
        stats.images += Math.max(graphics ? graphics.images.length : 0, countFigures(tree));

        // Skip pages that contain only cover/decorative content (e.g. cover page)
        if (isCoverPage(tree)) continue;

        const mcidMap = await buildMcidMap(page);
        const annotations = await buildAnnotations(page);
        const checkboxes = await buildCheckboxes(page);

        const md = renderStructNodes(tree.children || [], mcidMap, null, annotations, checkboxes).trim();
        const joined = md && pageMds.length ? joinAcrossPage(pageMds[pageMds.length - 1], md) : null;
        if (joined !== null) pageMds[pageMds.length - 1] = joined;
        else if (md) pageMds.push(md);
        page.cleanup();

        if (onProgress) onProgress(Math.round(10 + (p / pdf.numPages) * 80));
    }

    // Note: cross-page code-fence merging has been removed.
    // Merging same-language fences is too aggressive: it incorrectly joins separate
    // code examples that share a language label. Separate code blocks render fine
    // in Markdown as consecutive fenced blocks.
    return postProcess(pageMds.join('\n\n'));
}

// ─────────────────────────────────────────────────────────────────────────────
// Heuristic fallback  (non-tagged / scanned PDFs)
// ─────────────────────────────────────────────────────────────────────────────

const Y_TOL = 3;

/** Real font names say how text looks: monospaced, bold, italic. */
const BOLD_NAME = /bold|black|heavy/i;

/** Fixed-pitch families known by a whole word of their name ("Courier New", "Hack-Regular", "DejaVu Sans Mono"). */
const MONO_WORDS = new Set(['mono', 'monospace', 'monospaced', 'courier', 'consolas', 'menlo', 'monaco', 'inconsolata', 'hack',
    'cousine', 'cascadia', 'fixedsys']);
/** Fixed-pitch families whose name is several words, matched at the start of the name with words run together. */
const MONO_FAMILIES = ['firacode', 'jetbrainsmono', 'sourcecodepro', 'anonymouspro', 'ibmplexmono', 'robotomono', 'ubuntumono',
    'notosansmono', 'sfmono', 'lucidaconsole', 'andalemono', 'dejavusansmono', 'liberationmono', 'ptmono', 'overpassmono'];

/**
 * A font name's words: split at anything that is not a letter, at a lower-case
 * letter followed by a capital ("SansMono") and before the last capital of a run
 * followed by lower case ("IBMPlex"). "MonotypeCorsiva" gives "monotype",
 * "corsiva", so it is not taken for "mono".
 */
function fontWords(name) {
    const words = [];
    let cur = '';
    for (let i = 0; i < name.length; i++) {
        const c = name[i];
        if (!/\p{L}/u.test(c)) {
            if (cur) words.push(cur);
            cur = '';
            continue;
        }
        const prev = name[i - 1] || '';
        const next = name[i + 1] || '';
        const upper = c !== c.toLowerCase();
        const split = cur && upper && (prev === prev.toLowerCase() && /\p{L}/u.test(prev)
            || (prev !== prev.toLowerCase() && next && next !== next.toUpperCase()));
        if (split) {
            words.push(cur);
            cur = '';
        }
        cur += c;
    }
    if (cur) words.push(cur);
    return words.map(w => w.toLowerCase());
}

/** A fixed-pitch font, by its name's words or its family's full name. */
function isMonoName(name) {
    const words = fontWords(name);
    if (words.some(w => MONO_WORDS.has(w))) return true;
    const joined = words.join('');
    return MONO_FAMILIES.some(f => joined.startsWith(f));
}
const ITALIC_NAME = /italic|oblique|(?:^|[-_,\s])(?:bold|semibold|light|medium|black)?it$/i;

/**
 * Style flags for a font from its real name (e.g. "ABCDEF+Inter-Bold"; the
 * subset prefix is ignored) and the generic family pdf.js gives it, which is
 * "monospace" when the font says it is fixed-pitch. `named` is false when no
 * name was found, so the width test may still decide whether it is monospaced.
 * @param {string} name
 * @param {string} [family]
 * @returns {{named: boolean, mono: boolean, bold: boolean, italic: boolean}}
 */
export function fontFlags(name, family = '') {
    const n = String(name || '').replace(/^[A-Z]{6}\+/, '');
    return {named: n !== '', mono: family === 'monospace' || isMonoName(n), bold: BOLD_NAME.test(n), italic: ITALIC_NAME.test(n)};
}

/** Operators that paint a raster image. */
const IMAGE_OPS = ['paintImageXObject', 'paintInlineImageXObject', 'paintImageXObjectRepeat', 'paintJpegXObject'];
/** An image smaller than this (in points) on a side is a spacer or an icon, not a picture. */
const MIN_IMAGE_PT = 8;
/** A filled shape this small (in points) and about as wide as tall is a list marker (a disc or square). */
const MARK_MIN_PT = 1.5;
const MARK_MAX_PT = 9;

const multiply = (m, n) => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];

/** The page-space bounding box of a local rectangle drawn under matrix m (PDF space: y up). */
function boxUnder(m, x0, y0, x1, y1) {
    const xs = [m[0] * x0 + m[2] * y0 + m[4], m[0] * x1 + m[2] * y0 + m[4], m[0] * x0 + m[2] * y1 + m[4], m[0] * x1 + m[2] * y1 + m[4]];
    const ys = [m[1] * x0 + m[3] * y0 + m[5], m[1] * x1 + m[3] * y0 + m[5], m[1] * x0 + m[3] * y1 + m[5], m[1] * x1 + m[3] * y1 + m[5]];
    return {x1: Math.min(...xs), x2: Math.max(...xs), y1: Math.min(...ys), y2: Math.max(...ys)};
}

/**
 * Images, and small filled shapes that may be list markers, from a page's
 * operator list, as boxes in PDF space. One pass, tracking the transform
 * through save/restore and form XObjects.
 * @returns {{images: Array<{x1: number, x2: number, y1: number, y2: number}>, marks: Array<{x1: number, x2: number, y1: number, y2: number}>}}
 */
export function scanOperators(fnArray, argsArray, OPS) {
    const images = [];
    const marks = [];
    const imageOps = new Set(IMAGE_OPS.map(n => OPS[n]).filter(v => v !== undefined));
    const fills = new Set(['fill', 'eoFill', 'fillStroke', 'eoFillStroke'].map(n => OPS[n]).filter(v => v !== undefined));
    let ctm = [1, 0, 0, 1, 0, 0];
    const stack = [];
    for (let i = 0; i < fnArray.length; i++) {
        const fn = fnArray[i];
        const args = argsArray[i];
        if (fn === OPS.save) stack.push(ctm);
        else if (fn === OPS.restore || fn === OPS.paintFormXObjectEnd) ctm = stack.length ? stack.pop() : ctm;
        else if (fn === OPS.transform && args && args.length === 6) ctm = multiply(ctm, args);
        else if (fn === OPS.paintFormXObjectBegin) {
            stack.push(ctm);
            const m = args && args[0];
            if (m && m.length === 6) ctm = multiply(ctm, m);
        } else if (imageOps.has(fn)) {
            const b = boxUnder(ctm, 0, 0, 1, 1);
            if (b.x2 - b.x1 >= MIN_IMAGE_PT && b.y2 - b.y1 >= MIN_IMAGE_PT) images.push(b);
        } else if (fn === OPS.constructPath && args && fills.has(args[0]) && args[2] && args[2].length === 4) {
            const b = boxUnder(ctm, args[2][0], args[2][1], args[2][2], args[2][3]);
            const w = b.x2 - b.x1;
            const h = b.y2 - b.y1;
            if (w >= MARK_MIN_PT && w <= MARK_MAX_PT && h >= MARK_MIN_PT && h <= MARK_MAX_PT && w < h * 1.7 && h < w * 1.7) marks.push(b);
        }
    }
    return {images, marks};
}

/** The page's images and marker shapes, or null when there is no operator list to read. */
async function readGraphics(page, OPS) {
    if (!OPS || typeof page.getOperatorList !== 'function') return null;
    try {
        const list = await page.getOperatorList();
        return scanOperators(list.fnArray, list.argsArray, OPS);
    } catch {
        return null;
    }
}

/**
 * fontFlags for each font of a page's text, by pdf.js font id. The names come
 * from the loaded fonts, which the operator list has just loaded; a font not
 * loaded within a second counts as unnamed.
 */
async function fontTable(page, styles, loaded) {
    const ids = Object.keys(styles || {});
    const objs = page.commonObjs;
    const nameOf = (id) => new Promise((resolve) => {
        const done = (font) => resolve(font && typeof font.name === 'string' ? font.name : '');
        try {
            if (objs.has(id)) done(objs.get(id));
            else if (loaded) objs.get(id, done);
            else done(null);
        } catch {
            done(null);
        }
    });
    let timer;
    const deadline = new Promise((resolve) => { timer = setTimeout(() => resolve(null), 1000); });
    const names = (objs && typeof objs.get === 'function')
        ? await Promise.race([Promise.all(ids.map(nameOf)), deadline]).finally(() => clearTimeout(timer))
        : null;
    return new Map(ids.map((id, k) => [id, fontFlags(names ? names[k] : '', styles[id] && styles[id].fontFamily)]));
}

/** At most this many link annotations per page are matched to text. */
const MAX_PAGE_LINKS = 500;

/** A page's http(s) and mailto link annotations as boxes measured from the top of the page. */
async function linkBoxes(page, height) {
    const anns = await buildAnnotations(page);
    return anns.filter(a => !a.internal && /^(?:https?:|mailto:)/i.test(a.url) && a.rect && a.rect.length === 4)
        .slice(0, MAX_PAGE_LINKS)
        .map(a => ({url: a.url, x1: Math.min(a.rect[0], a.rect[2]), x2: Math.max(a.rect[0], a.rect[2]),
            top: height - Math.max(a.rect[1], a.rect[3]), bottom: height - Math.min(a.rect[1], a.rect[3])}));
}

const NO_FONT = fontFlags('', '');

/**
 * Every page's text items (with font flags), images, marker shapes and links.
 * Positions are measured from the top of the page; `y` adds 10000 per page so
 * one number orders the whole document.
 */
async function extractRawItems(pdf, onProgress, OPS) {
    const pages = [];
    for (let p = 1; p <= pdf.numPages; p++) {
        const page = await pdf.getPage(p);
        const vp = page.getViewport({scale: 1});
        const H = vp.height;
        const ct = await page.getTextContent({includeMarkedContent: false});
        const graphics = await readGraphics(page, OPS);
        const fonts = await fontTable(page, ct.styles, !!graphics);
        const links = await linkBoxes(page, H);
        const items = [];
        for (const item of ct.items) {
            if (!item.str) continue;
            const f = fonts.get(item.fontName) || NO_FONT;
            items.push({
                str: item.str,
                fontName: item.fontName || '',
                x: item.transform[4],
                y: (H - item.transform[5]) + (p - 1) * 10000,
                pageY: H - item.transform[5],   // from the top of its page
                pageHeight: H,
                pageWidth: vp.width,
                dir: item.dir,
                scaleX: Math.abs(item.transform[0]) || 1,
                fontSize: Math.abs(item.transform[3]) || 12,
                width: item.width || 0,
                pageNum: p,
                mono: f.mono, bold: f.bold, italic: f.italic, named: f.named,
            });
        }
        const top = (b) => ({x1: b.x1, x2: b.x2, top: H - b.y2, bottom: H - b.y1});
        pages.push({num: p, width: vp.width, height: H, items, links,
            images: graphics ? graphics.images.map(top) : [], marks: graphics ? graphics.marks.map(top) : []});
        page.cleanup();
        if (onProgress) onProgress(Math.round(5 + (p / pdf.numPages) * 25));
    }
    return pages;
}

/**
 * Fonts whose text is monospaced: those whose name or flags say so. A font
 * with no name to go by is judged by its widths instead: its average character
 * width hardly varies between strings.
 */
export function identifyMonoFonts(pages) {
    const mono = new Set();
    // One sample per distinct string (digits ignored): a running header repeated
    // on every page, or "Page 2 of 4", "Page 3 of 4", would otherwise look monospaced.
    const groups = new Map();
    const seen = new Set();
    for (const page of pages) {
        for (const item of page.items) {
            if (item.mono && item.fontName) mono.add(item.fontName);
            if (item.mono || item.named) continue;
            if (!item.fontName || item.str.trim().length < 2 || !item.width) continue;
            const sample = item.fontName + '\u0000' + item.str.replace(/\d/g, '0');
            if (seen.has(sample)) continue;
            seen.add(sample);
            const ncw = item.width / item.str.length / item.scaleX;
            if (!groups.has(item.fontName)) groups.set(item.fontName, []);
            groups.get(item.fontName).push(ncw);
        }
    }
    for (const [font, ws] of groups) {
        if (ws.length < 5) continue;
        const mean = ws.reduce((a, b) => a + b, 0) / ws.length;
        if (!mean) continue;
        const cv = Math.sqrt(ws.reduce((a, b) => a + (b - mean) ** 2, 0) / ws.length) / mean;
        if (cv < 0.08) mono.add(font);
    }
    return mono;
}

const hasStrongText = (i) => /\S/.test(i.str);

/**
 * Items of one line, in reading order. `items` are in visual order (left to
 * right). A right-to-left line reads right to left, except that left-to-right
 * runs inside it (Latin words, numbers) keep their own order. A left-to-right
 * line keeps its order, except that right-to-left runs inside it (an Arabic
 * phrase stored one glyph per item) are reversed.
 * @param {Array<{str: string, dir?: string}>} items
 * @param {'ltr'|'rtl'} dir
 */
export function logicalOrder(items, dir) {
    const base = dir === 'rtl' ? [...items].reverse() : items;
    const embedded = dir === 'rtl' ? 'ltr' : 'rtl';
    const isEmbedded = (i) => i && i.dir === embedded && hasStrongText(i);
    const out = [];
    for (let k = 0; k < base.length;) {
        if (!isEmbedded(base[k])) {
            out.push(base[k++]);
            continue;
        }
        let j = k;
        while (isEmbedded(base[j + 1]) || (base[j + 1] && !hasStrongText(base[j + 1]) && isEmbedded(base[j + 2]))) j++;
        for (let n = j; n >= k; n--) out.push(base[n]);   // the embedded run in its own reading order
        k = j + 1;
    }
    return out;
}

/**
 * The base direction of a line from its items in visual (left-to-right) order.
 * Only one direction of strong text: that one. Mixed: the first strong
 * character of the logical text decides (Unicode bidi rule P2), which rules out
 * one reading when the leftmost strong item is RTL (so not LTR) or the
 * rightmost is LTR (so not RTL). Still open ("ARABIC: مرحبا" reads either
 * way): the side the line hugs, when the page width is known and the line is
 * clearly nearer one margin; else the direction most of its characters have.
 */
function lineDirection(visual, pageWidth = 0) {
    let rtl = 0;
    let ltr = 0;
    let leftmost = null;
    let rightmost = null;
    for (const i of visual) {
        if (!/\p{L}/u.test(i.str)) continue;   // letters are strong; ".", digits and spaces are not
        const n = i.str.length;
        if (i.dir === 'rtl') rtl += n; else ltr += n;
        if (!leftmost) leftmost = i.dir;
        rightmost = i.dir;
    }
    if (!rtl) return 'ltr';
    if (!ltr) return 'rtl';
    if (leftmost === 'rtl') return 'rtl';
    if (rightmost === 'ltr') return 'ltr';
    if (pageWidth > 0 && visual.length) {
        const first = visual[0];
        const last = visual[visual.length - 1];
        const leftGap = first.x;
        const rightGap = pageWidth - (last.x + (last.width || 0));
        if (Math.abs(leftGap - rightGap) > 36) return leftGap < rightGap ? 'ltr' : 'rtl';
    }
    return rtl > ltr ? 'rtl' : 'ltr';
}

/**
 * One line's text items in reading order, shared by the tagged and position
 * paths: sorted left to right, given a base direction (lineDirection), then
 * right-to-left runs reversed (logicalOrder).
 * @param {Array<{str: string, dir?: string, x: number, width?: number}>} items
 * @param {number} [pageWidth]
 * @returns {{dir: 'ltr'|'rtl', items: object[]}}
 */
export function orderLineItems(items, pageWidth = 0) {
    const visual = [...items].sort((a, b) => a.x - b.x);
    const dir = lineDirection(visual, pageWidth);
    return {dir, items: logicalOrder(visual, dir)};
}

/** Arabic and Hebrew presentation forms (one glyph per letter shape) back to plain letters. */
export function isPresentationForm(ch) {
    const n = ch.charCodeAt(0);
    return (n >= 0xfb1d && n <= 0xfdff) || (n >= 0xfe70 && n <= 0xfefc);
}
const plainLetters = (s) => Array.from(s, c => (isPresentationForm(c) ? c.normalize('NFKC') : c)).join('');

/** A line's text in reading order with plain letters (both paths). */
function lineText(items, pageWidth) {
    const {dir, items: ordered} = orderLineItems(items, pageWidth);
    return {dir, text: plainLetters(ordered.map(i => i.str).join(''))};
}

// ── Rows, pieces and columns ─────────────────────────────────────────────────

/** Baselines this close (a share of the larger font size, at least Y_TOL) share a row, so a raised bullet or a superscript stays on its line. */
const ROW_TOL = 0.4;
/** A gap of more than this many ems between two pieces of text on a row splits it: table cells, columns, a sidebar. */
const SPLIT_EM = 1;
/** Bullet glyphs that start a list item. */
const BULLET_START = /^[•●○◦▪▫■□‣⁃∙·►▸➢✓✔–]\s+/;
/** A bullet glyph, "3." or "(b)" on its own: it belongs to the text after it. */
const LABEL_RE = /^(?:[•●○◦▪▫■□‣⁃∙·►▸➢✓✔–]|\(?(?:[1-9]\d?|[A-Za-z]|[ivxlcdm]{1,6})[.)])$/;
/** A list label at the start of a line: a bullet glyph or "3." / "3)". List numbers run from 1 to 99, so "2026." is not one. */
const LEADING_LABEL = /^(?:[•●○◦▪▫■□‣⁃∙·►▸➢✓✔–]|[1-9]\d?[.)])\s+/;
/** A numbered list item's start: "3. " or "3) ", 1 to 99. */
const NUMBERED_START = /^[1-9]\d?[.)]\s+/;

const isBlankStr = (s) => !/\S/.test(s);

/** Append src to dst with a loop: push(...src) passes every element as an argument and overflows the stack on a huge row. */
function pushAll(dst, src) {
    for (let i = 0; i < src.length; i++) dst.push(src[i]);
    return dst;
}

/** A page's items in rows, top to bottom. A row's `y` is the baseline of its largest text, `pageY` its highest baseline. */
function groupRows(items) {
    const sorted = [...items].sort((a, b) => a.pageY - b.pageY || a.x - b.x);
    const rows = [];
    let row = null;
    for (const it of sorted) {
        const blank = isBlankStr(it.str);
        if (row && it.pageY - row.pageY <= Math.max(Y_TOL, ROW_TOL * Math.max(row.size, it.fontSize))) {
            row.items.push(it);
            if (!blank && it.fontSize > row.size) {
                row.size = it.fontSize;
                row.y = it.y;
            }
        } else {
            row = {pageY: it.pageY, y: it.y, size: blank ? 0 : it.fontSize, items: [it]};
            rows.push(row);
        }
    }
    return rows;
}

/** A piece's items in reading order, its text and its direction. */
function finishPiece(seg, pageWidth) {
    const {dir, items} = orderLineItems(seg.items, pageWidth);
    seg.dir = dir;
    seg.ordered = items;
    seg.text = plainLetters(items.map(i => i.str).join('')).replace(/\s+/g, ' ').trim();
    seg.raw = seg.text;
    seg.spaced = isSpacedCaps(seg.text);
    if (seg.spaced) seg.text = spacedCapsText(items);
    return seg;
}

/**
 * Letter-spaced capitals as pdf.js reads them, a space after every letter ("N O R T H",
 * "I N T H E E D I TO R" with a kerned pair): three or more letters, nearly all alone.
 * Linear (one split).
 */
export function isSpacedCaps(text) {
    if (text.length > 400 || !/^[A-Z][A-Z ]*$/.test(text)) return false;
    const words = text.split(' ').filter(Boolean);
    return words.length >= 3 && words.every(w => w.length <= 2) && words.filter(w => w.length === 1).length >= words.length * 0.7;
}

/**
 * Letter-spaced capitals joined into words. pdf.js puts letters drawn with
 * tracking into one item with a space after each, and starts a new item (or a
 * space item) at a word gap, so the letters of each item join up and a space
 * item, or a gap clearly wider than the others between items, is a word break.
 * When nothing marks the breaks, the run is one word ("EXAMPLECO"): kept, not lost.
 * @param {Array<{str: string, x: number, width: number}>} items  in reading order
 */
export function spacedCapsText(items) {
    const parts = [];
    for (const it of items) {
        if (isBlankStr(it.str)) {
            if (parts.length) parts[parts.length - 1].space = true;
            continue;
        }
        parts.push({text: it.str.replace(/\s+/g, ''), x: it.x, end: it.x + (it.width || 0), space: false});
    }
    const gaps = [];
    for (let k = 1; k < parts.length; k++) gaps.push(parts[k].x - parts[k - 1].end);
    const usual = gaps.length > 1 ? median(gaps) : 0;
    const advance = (p) => (p.end - p.x) / Math.max(1, p.text.length);
    const wide = (k) => (gaps.length > 1 ? gaps[k - 1] > 1.8 * usual + 1 : gaps[k - 1] > 0.6 * advance(parts[k - 1]));
    let out = '';
    parts.forEach((p, k) => {
        if (k && (parts[k - 1].space || wide(k))) out += ' ';
        out += p.text;
    });
    return out;
}

/**
 * A row's items split into pieces wherever the gap between two pieces of text
 * is more than an em, left to right. Spaces never split (a space item can fill
 * a whole gap). A lone list label ("●", "3.") joins the text after it.
 */
function splitPieces(rowItems, pageWidth) {
    const items = [...rowItems].sort((a, b) => a.x - b.x);
    const segs = [];
    let cur = null;
    for (const it of items) {
        const blank = isBlankStr(it.str);
        if (cur && !blank && it.x - cur.x2 > SPLIT_EM * Math.max(6, cur.size, it.fontSize)) cur = null;
        if (!cur) {
            if (blank) continue;
            cur = {items: [], x1: it.x, x2: it.x, size: 0};
            segs.push(cur);
        }
        cur.items.push(it);
        if (!blank) {
            cur.x2 = Math.max(cur.x2, it.x + it.width);
            cur.size = Math.max(cur.size, it.fontSize);
        }
    }
    const out = [];
    for (const s of segs) {
        finishPiece(s, pageWidth);
        const prev = out[out.length - 1];
        if (prev && LABEL_RE.test(prev.text) && s.x1 - prev.x2 < 4 * Math.max(s.size, 1)) {
            pushAll(prev.items, s.items);
            prev.x2 = s.x2;
            prev.size = Math.max(prev.size, s.size);
            finishPiece(prev, pageWidth);
        } else {
            out.push(s);
        }
    }
    return out;
}

/** Rows with a gap at the same place, at least this many, make a channel between columns. */
const MIN_CHANNEL_ROWS = 3;
const CHANNEL_BINS = 256;

/** At most this many candidate channels are tried on one set of rows. */
const MAX_CHANNELS = 4;

/**
 * Candidate vertical channels between pieces, clearest first, each {x, sized}.
 * Two kinds: where at least MIN_CHANNEL_ROWS rows have a gap of about an em or
 * more (columns on one baseline grid, table cells), and where few pieces cross
 * at all while text lies on both sides (a sidebar whose lines never share a
 * baseline with the body). The second kind is `sized`: it only counts as
 * columns when the two sides are set in different sizes, as a sidebar is.
 * Linear in the pieces (histograms over CHANNEL_BINS).
 * @returns {Array<{x: number, sized: boolean}>}
 */
function findChannels(rows) {
    let x0 = Infinity;
    let x1 = -Infinity;
    for (const r of rows) {
        for (const s of r.segs) {
            if (s.x1 < x0) x0 = s.x1;
            if (s.x2 > x1) x1 = s.x2;
        }
    }
    if (!(x1 - x0 > 1)) return [];
    const B = CHANNEL_BINS;
    const bw = (x1 - x0) / B;
    const bin = (x) => Math.min(B - 1, Math.max(0, Math.floor((x - x0) / bw)));
    const gapDiff = new Int32Array(B + 1);   // rows with a wide gap over each bin
    const covDiff = new Int32Array(B + 1);   // pieces over each bin
    const ends = new Int32Array(B);          // pieces ending in each bin
    const begins = new Int32Array(B);        // pieces starting in each bin
    let pieces = 0;
    for (const r of rows) {
        for (let k = 1; k < r.segs.length; k++) {
            const a = r.segs[k - 1];
            const b = r.segs[k];
            if (a.image || b.image || b.x1 - a.x2 < Math.max(8, 0.9 * Math.max(a.size, b.size))) continue;
            const i0 = Math.max(0, Math.ceil((a.x2 - x0) / bw));
            const i1 = Math.min(B - 1, Math.floor((b.x1 - x0) / bw) - 1);
            if (i1 < i0) continue;
            gapDiff[i0]++;
            gapDiff[i1 + 1]--;
        }
        for (const s of r.segs) {
            if (s.image) continue;
            const a = bin(s.x1);
            const b = bin(s.x2);
            covDiff[a]++;
            covDiff[b + 1]--;
            ends[b]++;
            begins[a]++;
            pieces++;
        }
    }
    const found = [];
    // Gap channels: each stretch of bins with MIN_CHANNEL_ROWS or more gaps gives the middle of its highest part.
    let count = 0;
    let peak = null;
    for (let i = 0; i <= B; i++) {
        count = i < B ? count + gapDiff[i] : 0;
        if (count >= MIN_CHANNEL_ROWS) {
            if (!peak) peak = {best: count, start: i, end: i};
            else if (count > peak.best) Object.assign(peak, {best: count, start: i, end: i});
            else if (count === peak.best && peak.end === i - 1) peak.end = i;
        } else if (peak) {
            found.push({x: x0 + ((peak.start + peak.end + 1) / 2) * bw, score: peak.best, sized: false});
            peak = null;
        }
    }
    // Clear channels: a stretch at least 8pt wide that at most a quarter of the pieces
    // cross, with two or more pieces wholly on each side.
    const maxCover = Math.max(1, Math.floor(pieces / 4));
    const minBins = Math.max(1, Math.ceil(8 / bw));
    const left = new Int32Array(B + 1);   // pieces ending before bin i
    for (let i = 0; i < B; i++) left[i + 1] = left[i] + ends[i];
    const right = new Int32Array(B + 1);  // pieces starting after bin i
    for (let i = B - 1; i >= 0; i--) right[i] = right[i + 1] + (i + 1 < B ? begins[i + 1] : 0);
    let cover = 0;
    let stretch = null;
    for (let i = 0; i <= B; i++) {
        cover = i < B ? cover + covDiff[i] : Infinity;
        const ok = i < B && cover <= maxCover && left[i] >= 2 && right[i] >= 2;
        if (ok) {
            if (!stretch) stretch = {start: i, end: i, low: cover, lowStart: i, lowEnd: i};
            stretch.end = i;
            if (cover < stretch.low) Object.assign(stretch, {low: cover, lowStart: i, lowEnd: i});
            else if (cover === stretch.low && stretch.lowEnd === i - 1) stretch.lowEnd = i;
        } else if (stretch) {
            if (stretch.end - stretch.start + 1 >= minBins) {
                const mid = (stretch.lowStart + stretch.lowEnd) >> 1;
                found.push({x: x0 + ((stretch.lowStart + stretch.lowEnd + 1) / 2) * bw, score: Math.min(left[mid], right[mid]), sized: true});
            }
            stretch = null;
        }
    }
    // Clearest first; a channel within 8pt of a better one of its kind is the same channel.
    found.sort((a, b) => b.score - a.score);
    const out = [];
    for (const c of found) {
        if (out.length >= MAX_CHANNELS) break;
        if (!out.some(o => o.sized === c.sized && Math.abs(o.x - c.x) < 8)) out.push(c);
    }
    return out;
}

/** The share of pieces' characters set in a monospaced font (by the font's name or flags). */
function monoShare(segs) {
    let mono = 0;
    let all = 0;
    for (const s of segs) {
        for (const i of s.items || []) {
            const n = i.str.replace(/\s+/g, '').length;
            all += n;
            if (i.mono) mono += n;
        }
    }
    return all ? mono / all : 0;
}

/**
 * Rows split by a channel are a table, not columns, when most rows have text
 * on both sides and one side is short (labels, numbers, values). A side that is
 * all monospaced beside one that is not is code next to prose: columns.
 */
function isTableRun(left, right, both) {
    const segsOf = (rows) => {
        const out = [];
        for (const r of rows) pushAll(out, r.segs);
        return out;
    };
    const ml = monoShare(segsOf(left));
    const mr = monoShare(segsOf(right));
    if ((ml >= 0.8 && mr < 0.5) || (mr >= 0.8 && ml < 0.5)) return false;
    const avg = (rows) => {
        let n = 0;
        let chars = 0;
        for (const r of rows) {
            for (const s of r.segs) {
                if (s.image) continue;
                n++;
                chars += s.text.length;
            }
        }
        return n ? chars / n : 0;
    };
    const textRows = (rows) => rows.filter(r => r.segs.some(s => !s.image)).length;
    return both >= 2 && both >= 0.6 * Math.max(textRows(left), textRows(right)) && Math.min(avg(left), avg(right)) < 25;
}

/**
 * Rows in reading order. Where a channel runs between columns (two columns of
 * prose, a sidebar beside the body), each stretch of rows that nothing crosses
 * is read column by column, left first; a row that crosses the channel (a
 * title, a wide picture) is read in place. Tables keep their rows whole. The
 * clearest channel that separates columns somewhere is used; one that only
 * runs between table cells is passed over for the next.
 */
function orderRows(rows, depth = 0) {
    if (depth > 2 || rows.length < MIN_CHANNEL_ROWS) return rows;
    for (const channel of findChannels(rows)) {
        const split = splitAtChannel(rows, channel, depth);
        if (split) return split;
    }
    return rows;
}

/** The middle font size of some rows' pieces. */
function typicalSize(rows) {
    const sizes = [];
    for (const r of rows) for (const s of r.segs) if (!s.image) sizes.push(s.size);
    return median(sizes);
}

/**
 * Rows read with columns either side of the channel, or null when nothing
 * splits into columns there. A `sized` channel splits only text of different
 * sizes either side (a sidebar), so labels beside a code block stay in place.
 */
function splitAtChannel(rows, {x: c, sized}, depth) {
    const out = [];
    let run = [];
    let columns = false;
    const flush = () => {
        if (!run.length) return;
        const left = [];
        const right = [];
        let both = 0;
        for (const row of run) {
            const l = row.segs.filter(s => s.x2 <= c);
            const r = row.segs.filter(s => s.x1 >= c);
            if (l.length) left.push({...row, segs: l});
            if (r.length) right.push({...row, segs: r});
            if (l.some(s => !s.image) && r.some(s => !s.image)) both++;
        }
        const sameSize = () => {
            const a = typicalSize(left);
            const b = typicalSize(right);
            return Math.abs(a - b) < 0.1 * Math.max(a, b);
        };
        if (!left.length || !right.length || isTableRun(left, right, both) || (sized && sameSize())) {
            pushAll(out, run);
        } else {
            // A sidebar is read before the body, except where the stretch starts the page:
            // there the body carries on from the page before, so it comes first.
            const span = (rows) => maxOf(rows, r => maxOf(r.segs, s => s.x2)) - minOf(rows, r => minOf(r.segs, s => s.x1));
            const bodyFirst = sized && run.some(r => r.firstOnPage) && span(left) < span(right);
            const [a, b] = bodyFirst ? [right, left] : [left, right];
            pushAll(out, orderRows(a, depth + 1));
            pushAll(out, orderRows(b, depth + 1));
            if (Math.min(left.length, right.length) >= 2) columns = true;
        }
        run = [];
    };
    for (const row of rows) {
        const last = run[run.length - 1];
        if (row.segs.some(s => s.x1 < c && s.x2 > c)) {
            flush();
            out.push(row);
        } else {
            // A wide vertical gap (a new section) ends a stretch of columns too.
            if (last && row.pageY - last.pageY > 3 * Math.max(row.size, last.size, 6)) flush();
            run.push(row);
        }
    }
    flush();
    return columns ? out : null;
}

/** Where the text of a piece starts once a leading list label ("●", "2.") is skipped. */
function textStart(seg) {
    const m = LEADING_LABEL.exec(seg.text);
    if (!m) return seg.x1;
    const first = seg.ordered.find(i => !isBlankStr(i.str));
    if (!first) return seg.x1;
    const label = m[0].trim();
    const own = first.str.trimStart();
    if (own.length > label.length && own.startsWith(label)) {
        const lead = first.str.length - own.length;
        const at = lead + m[0].length;
        return first.x + (first.width * Math.min(at, first.str.length)) / first.str.length;
    }
    const next = seg.ordered.find(i => i !== first && !isBlankStr(i.str) && i.x > first.x);
    return next ? next.x : seg.x1;
}

/** Characters that make a piece of non-monospaced text prose rather than a stray symbol in code. */
const PROSE_CHAR = /[\p{L}\p{N}.,;:!?'"()]/u;

/** One output line from a row: its text, size, position, whether it is code, and its pieces (cells). */
function rowLine(row, page, monoFonts) {
    const segs = row.segs;
    const base = {y: row.y, pageNum: page.num, pageY: row.pageY, pageHeight: page.height, x: segs[0].x1, links: page.links};
    if (segs[0].image) return {...base, isImage: true, text: 'image', dir: 'ltr', fontSize: 0, isMono: false, charWidth: 0, textX: base.x};
    // Letter-spaced words split at their word gaps: a short word ("T O") joins up like the long ones.
    if (segs.length > 1 && isSpacedCaps(segs.map(s => s.raw || s.text).join(' '))) {
        for (const s of segs) {
            if (!s.spaced && /^[A-Z](?: [A-Z])*$/.test(s.text)) {
                s.text = s.text.replace(/ /g, '');
                s.spaced = true;
            }
        }
    }
    let monoChars = 0;
    let prose = 0;
    let known = true;
    let fontSize = 0;
    const widths = [];
    for (const s of segs) {
        for (const i of s.items) {
            if (i.fontSize > fontSize && !isBlankStr(i.str)) fontSize = i.fontSize;
            if (!i.named) known = false;
            if (monoFonts.has(i.fontName)) {
                monoChars += i.str.replace(/\s+/g, '').length;
                if (i.str.length && i.width) widths.push(i.width / i.str.length);
            } else if (PROSE_CHAR.test(i.str)) {
                prose++;
            }
        }
    }
    return {
        ...base,
        text: segs.map(s => s.text).filter(Boolean).join(' '),
        dir: segs[0].dir,
        fontSize: fontSize || row.size || 12,
        textX: textStart(segs[0]),
        // Code is text all in a monospaced font; a monospaced word inside prose is inline code.
        isMono: monoChars > 0 && prose === 0,
        fontsKnown: known,
        charWidth: widths.length ? median(widths) : 0,
        // Letter-spaced words split at their wide word gaps are one line of capitals, not cells.
        spaced: segs.every(s => s.spaced),
        cells: segs.length > 1 && !segs.every(s => s.spaced) ? segs : null,
        segs,
    };
}

/** Set `marker` on lines that have a small filled shape (a list bullet drawn as a disc or square) just to their left. */
function markListMarkers(lines, marks) {
    if (!marks.length) return;
    const ms = marks.map(b => ({cy: (b.top + b.bottom) / 2, x2: b.x2})).sort((a, b) => a.cy - b.cy);
    for (const l of lines) {
        if (l.isImage) continue;
        const fs = l.fontSize;
        let lo = 0;
        let hi = ms.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (ms[mid].cy < l.pageY - fs) lo = mid + 1; else hi = mid;
        }
        for (let k = lo, seen = 0; k < ms.length && seen < 20 && ms[k].cy <= l.pageY + 0.3 * fs; k++, seen++) {
            if (ms[k].x2 <= l.x + 1 && l.x - ms[k].x2 < 3 * fs) {
                l.marker = true;
                break;
            }
        }
    }
}

/** A page's lines in reading order, with a line for each image where it sits. */
function pageLines(page, monoFonts) {
    const rows = [];
    for (const r of groupRows(page.items)) {
        const segs = splitPieces(r.items, page.width);
        if (segs.length) rows.push({y: r.y, pageY: r.pageY, size: r.size, segs});
    }
    // An image is read where it ends, so text beside it (a logo by the last bullet) is not split by it.
    for (const b of page.images) {
        rows.push({y: (page.num - 1) * 10000 + b.bottom, pageY: b.bottom, size: 0, segs: [{image: true, x1: b.x1, x2: b.x2, size: 0, text: '', items: []}]});
    }
    rows.sort((a, b) => a.pageY - b.pageY);
    const firstBody = rows.find(r => !(page.height > 0 && r.pageY < page.height * BAND));
    if (firstBody) firstBody.firstOnPage = true;
    const ordered = [];
    for (const r of orderRows(rows)) {
        // Pieces far apart in the header or footer band ("Example Co." left, a title
        // right) are separate items, each repeated on every page.
        const inBand = page.height > 0 && (r.pageY < page.height * BAND || r.pageY > page.height * (1 - BAND));
        const spread = r.segs.some((s, k) => k > 0 && s.x1 - r.segs[k - 1].x2 > 0.15 * page.width);
        if (inBand && spread) for (const s of r.segs) ordered.push({...r, segs: [s]});
        else ordered.push(r);
    }
    const lines = ordered.map(r => rowLine(r, page, monoFonts));
    markListMarkers(lines, page.marks);
    return lines;
}

/** Header and footer lines sit in the top or bottom tenth of the page. */
const BAND = 0.1;

const inHeaderFooterBand = (l) => l.pageHeight > 0 && (l.pageY < l.pageHeight * BAND || l.pageY > l.pageHeight * (1 - BAND));

/** Page furniture that is dropped when it sits in the header/footer band. */
const BOILERPLATE = [
    /private\s*[&a]\s*confidential/i,
    /all rights reserved/i,
    /^\s*page\s+\d+(\s*(of|\/)\s*\d+)?\s*$/i,
    /^\s*\d+\s*(of|\/)\s*\d+\s*$/i,
    /^\s*(?:\p{Pd}\s*)?\d{1,4}\s*(?:\p{Pd}\s*)?$/u,   // "3", "- 3 -", with any dash (no two adjacent \s*)
];

/**
 * Drop running headers and footers: lines in the top or bottom band of the
 * page that repeat on most pages (digits ignored, so "Page 3 of 9" matches
 * "Page 4 of 9"), or that are page furniture (page numbers, "All rights
 * reserved"). Code-like lines are never dropped: a "}" on every page is code.
 * @param {Array<{text: string, pageNum: number, pageY: number, pageHeight: number, isMono?: boolean}>} lines
 * @param {number} totalPages
 */
export function removeRunningElements(lines, totalPages) {
    const candidate = (l) => inHeaderFooterBand(l) && !l.isMono && codeScore(l.text) <= 0.45;
    const key = (l) => l.text.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();
    const freq = new Map();
    const smallest = new Map();
    for (const l of lines) {
        if (!candidate(l)) continue;
        const k = key(l);
        if (!freq.has(k)) freq.set(k, new Set());
        freq.get(k).add(l.pageNum);
        if (!(smallest.get(k) <= l.fontSize)) smallest.set(k, l.fontSize);
    }
    const threshold = Math.max(2, totalPages * 0.6);
    const running = new Set(totalPages < 2 ? []
        : [...freq.entries()].filter(([, s]) => s.size >= threshold).map(([k]) => k));
    // A title that matches the running header (26pt under the same words at 7pt) is the title: it stays.
    const isRunning = (l) => running.has(key(l)) && !(l.fontSize > 1.3 * smallest.get(key(l)));
    return lines.filter(l => !(candidate(l) && (isRunning(l) || BOILERPLATE.some(r => r.test(l.text)))));
}

/**
 * Drop a cover page: a first page of at most six lines of text. A first page
 * with large text on it (a title page, a deck's title slide) is kept, as its
 * title is the document's.
 */
function removeCoverPage(lines, medFontSize = 0) {
    const p2 = lines.findIndex(l => l.pageNum === 2);
    if (!(p2 > 0)) return lines;
    const cover = lines.slice(0, p2).filter(l => !l.isImage);
    if (cover.length > 6) return lines;
    if (medFontSize > 0 && cover.some(l => l.fontSize >= 1.45 * medFontSize)) {
        // The title is the largest text; the rest (a date, a subtitle) is text under it.
        const top = maxOf(cover, l => l.fontSize);
        for (const l of cover) if (l.fontSize < top - 0.5) l.subtitle = true;
        return lines;
    }
    return lines.slice(p2);
}

/**
 * The body text size: the size most of the characters are set in (a median
 * weighted by line length), so many short lines (a sidebar, captions) do not
 * make the body look large and turn it into headings.
 */
function bodyFontSize(lines) {
    const sized = lines.filter(l => !l.isImage && l.fontSize > 0).map(l => [l.fontSize, Math.max(1, l.text.length)]).sort((a, b) => a[0] - b[0]);
    let total = 0;
    for (const [, n] of sized) total += n;
    let seen = 0;
    for (const [size, n] of sized) {
        seen += n;
        if (seen * 2 >= total) return size;
    }
    return 0;
}

function median(arr) {
    const s = [...arr].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)] || 0;
}

/** Only the start of a long text is looked at when guessing whether it is code, and which language. */
const SNIFF_CHARS = 2000;

/** 0 to 1: how much a line looks like code. Reads at most SNIFF_CHARS characters. */
export function codeScore(text) {
    const t = text.length > SNIFF_CHARS ? text.slice(0, SNIFF_CHARS) : text;
    if (!t) return 0;
    const cc = (t.match(/[{}[\]()=><;,"/\\`|]/g) || []).length;
    let s = (cc / t.length) * 2;
    if (/"[^"]+"\s*:/.test(t)) s += 0.35;
    if (/^\s*[\[{]/.test(t)) s += 0.25;
    if (/\b(function|const|let|var|return|import|export|class|async|SELECT|FROM|WHERE)\b/.test(t)) s += 0.4;
    if (/^\s*[$%#]\s/.test(t)) s += 0.4;  // shell prompt
    if (/^(import|from|require|using|include)\s/.test(t)) s += 0.3;
    if (/\bindent\b|\bdef \w+\(/.test(t) || t.trimEnd().endsWith(':')) s += 0.2;  // Python
    return Math.min(s, 1);
}

/**
 * The kind of a line: a heading by size ('h1' to 'h3'), 'code', 'caps' (an
 * all-capitals label), 'bullet', 'numbered', 'image', 'blank' or 'para'.
 * `bodyX` is kept for callers; indentation alone no longer makes a bullet (a
 * caption or a step can be indented): a bullet glyph or a drawn marker does.
 */
export function classifyLine(line, medFontSize, bodyX) {   // eslint-disable-line no-unused-vars
    const {text, fontSize, isMono} = line;
    if (line.isImage) return 'image';
    if (!text) return 'blank';
    if (line.subtitle) return 'para';
    const r = fontSize / medFontSize;
    if (r >= 1.9) return 'h1';
    if (r >= 1.45) return 'h2';
    // Letter-spaced capitals (joined into words where the PDF shows the breaks) stay as written, in capitals.
    if (line.spaced || isSpacedCaps(text)) return r >= 1.15 ? 'h3' : 'para';
    // A long line only a little larger than the body is a lead paragraph, not a heading.
    if (r >= 1.15) return text.length > 75 ? 'para' : 'h3';
    // Code first: "// TODO: FIX THIS" or "SELECT ID FROM T" in a listing is code, not a heading.
    // With real font names, only monospaced text is code; without them, code-like text is.
    if (isMono || (line.fontsKnown !== true && codeScore(text) > 0.45)) return 'code';
    if (BULLET_START.test(text) || line.marker) return 'bullet';
    if (NUMBERED_START.test(text)) return 'numbered';
    // An all-capitals label: at least four letters, no digits ("Q1 2026", "NO." are not headings), not a table row.
    const letters = text.replace(/[^A-Za-z]/g, '');
    if (!line.cells && !/\d/.test(text) && letters.length >= 4 && text.length < 80
        && (letters.match(/[A-Z]/g) || []).length / letters.length >= 0.85) return 'caps';
    return 'para';
}

/** . ! ? : ; plus the Arabic question mark (U+061F) and the Urdu full stop (U+06D4). */
const SENTENCE_END = new Set(['.', '!', '?', ':', ';', String.fromCharCode(0x061f), String.fromCharCode(0x06d4)]);
const endsSentence = (text) => SENTENCE_END.has(text.slice(-1));

/** Every character of the line is in a bold font. */
const allBold = (l) => !!l.segs && l.segs.every(s => s.items.every(i => i.bold || isBlankStr(i.str)));

/** The first line of its page that follows the last line of the page before (a page break inside a block). */
const nextPage = (prev, next) => next.pageNum === prev.pageNum + 1;

/** Two heading lines of the same size, one under the other: one heading that wrapped. */
const sameHeading = (a, b) => a.pageNum === b.pageNum && Math.abs(a.fontSize - b.fontSize) < 0.6 && b.y > a.y && b.y - a.y <= 1.8 * a.fontSize;

/**
 * Whether `next` continues the list item that `first` started (`prev` is the
 * item's last line so far): a plain line aligned with the item's text, close
 * below it, or at the top of the next page when the item has not ended.
 */
function continuesItem(first, prev, next, medGap) {
    if (next._type !== 'para' || next.cells) return false;
    if (Math.abs(next.x - first.textX) > Math.max(4, 0.5 * next.fontSize)) return false;
    if (next.pageNum === prev.pageNum) return next.y > prev.y && next.y - prev.y <= medGap * 1.5;
    return nextPage(prev, next) && (!endsSentence(prev.text) || /^\p{Ll}/u.test(next.text));
}

/** Within this distance (points) a cell's start counts as aligned with a column. */
const COL_TOL = 6;

/**
 * A table starting at lines[i]: consecutive rows of two or more cells on one
 * page whose cells fall into the same columns (a wrapped cell's next line joins
 * its cell). Returns {block, next} or null. Running text with a wide gap here and
 * there leaves no clear column, so it is not a table; nor is a column of code.
 */
function takeTable(lines, i, medGap) {
    const rows = [];
    let j = i;
    let wrapped = 0;
    const rowGaps = [];   // from the last line of each row to the first line of the next
    while (j < lines.length) {
        const l = lines[j];
        const prev = rows.length ? rows[rows.length - 1].last : null;
        if (prev && (l.pageNum !== prev.pageNum || l.y <= prev.y || l.y - prev.y > 3 * medGap)) break;
        if (l.cells && l._type !== 'code') {
            const gap = prev ? l.y - prev.y : 0;
            if (prev && rowGaps.length && gap < 0.8 * median(rowGaps.slice(-9))) {
                // Closer than rows usually are: the cells of the row above wrapped onto this line.
                pushAll(rows[rows.length - 1].wrap, l.cells);
                rows[rows.length - 1].last = l;
                wrapped++;
            } else {
                if (prev) rowGaps.push(gap);
                rows.push({cells: [...l.cells], wrap: [], extra: [], first: l, last: l});
            }
            j++;
            continue;
        }
        // One line under a row, aligned with a column: a cell's wrapped text. Under the
        // first column it must sit a line's height below (a paragraph after the table is further).
        if (prev && l._type === 'para' && !l.cells && l.y - prev.y <= medGap * 1.4) {
            const col = rows[rows.length - 1].cells.findIndex(c => Math.abs(c.x1 - l.x) <= COL_TOL);
            if (col > 0 || (col === 0 && l.y - prev.y <= 1.3 * prev.fontSize)) {
                rows[rows.length - 1].extra.push(l.segs[0]);
                rows[rows.length - 1].last = l;
                wrapped++;
                j++;
                continue;
            }
        }
        break;
    }
    if (rows.length < 2) return null;
    // Columns are the stretches of x the body cells cover, merged where they overlap, so a
    // ragged or right-aligned cell still lands in its column (a header may be centred).
    const body = rows.slice(1);
    const spans = [];
    for (const r of body) for (const c of [...r.cells, ...r.wrap, ...r.extra]) spans.push([c.x1, c.x2]);
    spans.sort((a, b) => a[0] - b[0]);
    const bands = [];
    for (const [a, b] of spans) {
        const last = bands[bands.length - 1];
        if (last && a < last[1] + 2) last[1] = Math.max(last[1], b);
        else bands.push([a, b]);
    }
    // Running text with a wide gap here and there covers the gaps of other lines: one band.
    if (bands.length < 2) return null;
    const column = (x) => {
        let k = 0;
        while (k + 1 < bands.length && x >= bands[k + 1][0] - COL_TOL) k++;
        return k;
    };
    // Most body rows fill two or more columns (every one, when there is only one).
    const full = body.filter(r => new Set(r.cells.map(c => column(c.x1))).size >= 2).length;
    if (full < body.length * (body.length < 2 ? 1 : 0.7)) return null;
    // The header's cells go by their middles and must land in different columns.
    const headCols = rows[0].cells.map(c => column((c.x1 + c.x2) / 2));
    if (new Set(headCols).size !== headCols.length) return null;
    const grid = rows.map((r, ri) => {
        const cells = bands.map(() => []);
        r.cells.forEach((c, k) => cells[ri === 0 ? headCols[k] : column(c.x1)].push(c));
        for (const c of [...r.wrap, ...r.extra]) cells[column(c.x1)].push(c);
        return cells;
    });
    // A column of monospaced lines beside text is code, not table cells.
    for (let k = 0; k < bands.length; k++) {
        const segs = [];
        for (let ri = 1; ri < grid.length; ri++) pushAll(segs, grid[ri][k]);
        if (segs.length >= 2 && monoShare(segs) >= 0.8) return null;
    }
    return {block: {type: 'table', grid, wrapped}, next: j};
}

function buildHeuristicBlocks(lines, medGap) {
    const blocks = [];
    let i = 0;
    while (i < lines.length) {
        const l = lines[i];
        if (l.cells && l._type !== 'code') {
            const table = takeTable(lines, i, medGap);
            if (table) {
                blocks.push(table.block);
                i = table.next;
                continue;
            }
        }
        if (/^h[1-3]$/.test(l._type)) {
            const group = [l];
            let j = i + 1;
            while (j < lines.length && lines[j]._type === l._type && sameHeading(lines[j - 1], lines[j])) group.push(lines[j++]);
            blocks.push({type: l._type, lines: group});
            i = j;
            continue;
        }
        if (l._type === 'bullet' || l._type === 'numbered') {
            const group = [l];
            let j = i + 1;
            while (j < lines.length && continuesItem(l, group[group.length - 1], lines[j], medGap)) group.push(lines[j++]);
            blocks.push({type: l._type, lines: group});
            i = j;
            continue;
        }
        if (l._type === 'para') {
            const group = [l];
            let j = i + 1;
            while (j < lines.length && lines[j]._type === 'para') {
                const prev = lines[j - 1];
                const next = lines[j];
                if (next.cells && lines[j + 1] && lines[j + 1].cells) break;   // a table may start here
                if (next.pageNum === prev.pageNum) {
                    const gap = next.y - prev.y;
                    if (gap <= 0 || gap > medGap * 1.8) break;
                } else if (!nextPage(prev, next) || endsSentence(prev.text) || Math.abs(next.x - prev.x) > 4 || !/^\p{Ll}/u.test(next.text)) {
                    break;   // only a sentence cut by the page break carries on at the top of the next page
                }
                if (next.dir !== prev.dir) break;   // an Arabic line does not continue an English one
                if (Math.abs(next.fontSize - prev.fontSize) > 0.15 * Math.max(next.fontSize, prev.fontSize)) break;   // a label or caption size
                if (allBold(prev) && !allBold(next)) break;   // a bold line over plain text is a run-in heading
                if (prev.spaced || next.spaced) break;   // letter-spaced capitals are a label or tagline of their own
                // A sentence end followed by a capital starts a new paragraph; scripts
                // without capitals (Arabic, Hebrew) break on the sentence end alone.
                if (endsSentence(prev.text) && (/^[A-Z"«]/.test(next.text) || next.dir === 'rtl')) break;
                group.push(next);
                j++;
            }
            blocks.push({type: 'para', lines: group});
            i = j;
            continue;
        }
        if (l._type === 'code') {
            const group = [l];
            let j = i + 1;
            while (j < lines.length && lines[j]._type === 'code' && lines[j].y - lines[j - 1].y < 10000) {
                group.push(lines[j]);
                j++;
            }
            blocks.push({type: 'code', lines: group});
            i = j;
            continue;
        }
        blocks.push({type: l._type, lines: [l]});
        i++;
    }
    return blocks;
}

/**
 * A code block's lines with their indentation rebuilt from x positions (PDFs
 * draw indentation as an offset, not as spaces), and a blank line wherever the
 * gap to the previous line on the same page is clearly more than one line.
 */
function codeBlockText(lines) {
    const baseX = minOf(lines, l => l.x);
    const charWidth = median(lines.map(l => l.charWidth).filter(w => w > 0));
    const sameColumnGaps = [];
    for (let i = 1; i < lines.length; i++) {
        if (lines[i].pageNum === lines[i - 1].pageNum) sameColumnGaps.push(lines[i].y - lines[i - 1].y);
    }
    const step = minOf(sameColumnGaps, g => (g > 0 ? g : Infinity));
    const out = [];
    lines.forEach((l, i) => {
        const prev = lines[i - 1];
        if (prev && prev.pageNum === l.pageNum && Number.isFinite(step) && l.y - prev.y > step * 1.6) out.push('');
        const indent = charWidth ? Math.max(0, Math.round((l.x - baseX) / charWidth)) : 0;
        out.push(' '.repeat(indent) + l.text);
    });
    return out.join('\n');
}

/** Wrap bare http(s) URLs in <…> unless they already follow `(`, a backtick, `[` or `<`. */
export function autolinkUrls(s) {
    return s.replace(/(^|[^(`[<])(https?:\/\/[^\s)>\]"']+)/g, (_, before, u) => `${before}<${u}>`);
}

// ── Inline runs: bold, italic, code and links inside prose ───────────────────

const isWordChar = (c) => c !== undefined && /[\p{L}\p{N}]/u.test(c);

/** Move a cut at k inside a word to the nearer edge of that word. */
function snapToWord(str, k) {
    if (!(k > 0 && k < str.length) || !isWordChar(str[k - 1]) || !isWordChar(str[k])) return k;
    let left = k;
    let right = k;
    while (left > 0 && isWordChar(str[left - 1])) left--;
    while (right < str.length && isWordChar(str[right])) right++;
    return k - left <= right - k ? left : right;
}

/** A rough width for a character, in ems: narrow i and punctuation, wide m and capitals. */
function glyphWeight(c) {
    if (/[\sil.,:;'!|]/.test(c)) return 0.28;
    if (/[fjrt()[\]"]/.test(c)) return 0.36;
    if (/[mwMW@]/.test(c)) return 0.88;
    if (/[A-Z]/.test(c)) return 0.68;
    return 0.53;
}

/** The character index nearest to x within an item, from the rough glyph widths scaled to the item's real width. */
function charAt(item, edges, x) {
    const t = ((x - item.x) / item.width) * edges[edges.length - 1];
    let lo = 0;   // the last edge at or before t (binary search)
    let hi = edges.length - 1;
    while (lo < hi) {
        const m = (lo + hi + 1) >> 1;
        if (edges[m] <= t) lo = m; else hi = m - 1;
    }
    return lo + 1 < edges.length && t - edges[lo] > edges[lo + 1] - t ? lo + 1 : lo;
}

/**
 * The characters of a text item that sit inside link boxes, as sorted
 * [s, e) ranges with their URL, or null. Character positions are estimated
 * from rough glyph widths scaled to the item's width, then snapped to whole words.
 */
export function linkRanges(item, links) {
    if (!links || !links.length || item.dir === 'rtl' || !item.width || isBlankStr(item.str)) return null;
    const n = item.str.length;
    const mid = item.pageY - 0.35 * item.fontSize;   // the middle of the glyphs, from the top of the page
    const x2 = item.x + item.width;
    let edges = null;   // edges[k]: where character k starts, in rough ems
    let out = null;
    for (const a of links) {
        if (mid < a.top - 2 || mid > a.bottom + 2 || a.x2 < item.x || a.x1 > x2) continue;
        if (!edges) {
            edges = [0];
            for (let k = 0; k < n; k++) edges.push(edges[k] + glyphWeight(item.str[k]));
        }
        let s = snapToWord(item.str, Math.max(0, charAt(item, edges, a.x1)));
        let e = snapToWord(item.str, Math.min(n, charAt(item, edges, a.x2)));
        // Spaces and the punctuation around a link ("guide,", "(see") stay outside it.
        while (s < e && /[\s)\]]/.test(item.str[s])) s++;
        while (e > s && /[\s,;:.!?([]/.test(item.str[e - 1])) e--;
        if (e > s) (out || (out = [])).push({s, e, url: a.url});
    }
    return out && out.sort((p, q) => p.s - q.s);
}

const SPACE_RUN = {text: ' ', mono: false, bold: false, italic: false, url: ''};

/** A piece's text as styled runs: {text, mono, bold, italic, url}, in reading order. */
function pieceRuns(seg, monoFonts, links) {
    const runs = [];
    if (seg.spaced) {
        // Letter-spaced capitals: their joined text, plain (spacing is decoration, not emphasis).
        runs.push({...SPACE_RUN, text: seg.text});
        return runs;
    }
    for (const it of seg.ordered) {
        const style = {mono: monoFonts.has(it.fontName), bold: !!it.bold, italic: !!it.italic, url: ''};
        const ranges = linkRanges(it, links);
        if (!ranges) {
            runs.push({...style, text: plainLetters(it.str)});
            continue;
        }
        let pos = 0;
        for (const r of ranges) {
            if (r.s < pos) continue;
            if (r.s > pos) runs.push({...style, text: plainLetters(it.str.slice(pos, r.s))});
            runs.push({...style, url: r.url, text: plainLetters(it.str.slice(r.s, r.e))});
            pos = r.e;
        }
        if (pos < it.str.length) runs.push({...style, text: plainLetters(it.str.slice(pos))});
    }
    return runs;
}

/** A line's runs: its pieces' runs with a space between pieces. */
function lineRuns(line) {
    const out = [];
    (line.segs || []).forEach((s, k) => {
        if (k) out.push(SPACE_RUN);
        pushAll(out, s.runs || []);
    });
    return out;
}

/** The runs of wrapped lines as one run list, joined as joinWrapped joins text. */
function joinLineRuns(lines) {
    const out = [];
    for (const l of lines) {
        const runs = lineRuns(l).map(r => ({...r}));
        const first = runs.findIndex(r => !isBlankStr(r.text));
        if (first < 0) continue;
        while (out.length && isBlankStr(out[out.length - 1].text)) out.pop();
        if (out.length) {
            const last = out[out.length - 1];
            const prevText = last.text.trimEnd();
            const j = wrapJoin(prevText, runs[first].text.trimStart());
            last.text = j.dropHyphen ? prevText.slice(0, -1) : prevText;
            if (j.space) out.push(SPACE_RUN);
            else runs[first].text = runs[first].text.trimStart();
        }
        for (let k = first; k < runs.length; k++) out.push(runs[k]);
    }
    return out;
}

const runKey = (r) => `${r.mono ? 1 : 0}${r.bold ? 1 : 0}${r.italic ? 1 : 0}${r.url}`;

/** Runs with whitespace collapsed and neighbours of the same style (and link) merged; a space between two alike runs joins them. */
function mergeRuns(runs) {
    const out = [];
    for (const r of runs) {
        const text = r.text.replace(/\s+/g, ' ');
        if (!text) continue;
        const last = out[out.length - 1];
        if (text === ' ') {
            if (last && !last.text.endsWith(' ')) last.text += ' ';
            continue;
        }
        const key = runKey(r);
        if (last && last.key === key) last.text += text;
        else out.push({...r, text, key});
    }
    return out;
}

/** "word" in plain PDF text, as in a code listing's prose: an identifier in quotes reads as code. */
const quotedIdentifiers = (s) => s.replace(/"([A-Za-z_$][A-Za-z0-9_./-]*?)"/g, '`$1`');

/** One run as Markdown: escaped text, with code, emphasis and spaces kept outside the markup. */
function emitRun(r, inTable) {
    const {lead, core, trail} = splitOuterSpace(r.text);
    if (!core) return r.text ? ' ' : '';
    let s;
    if (r.mono) {
        s = codeSpan(core);
        if (inTable) s = s.replace(/\|/g, '\\|');
    } else if ((r.bold || r.italic) && /[\p{L}\p{N}]/u.test(core)) {
        const mark = r.bold && r.italic ? '***' : (r.bold ? '**' : '*');
        s = mark + escapeTextRun(core).replace(/[*_]/g, '\\$&') + mark;
    } else {
        // PDF text is plain text: Markdown and HTML syntax in it stays text (escapeTextRun).
        s = autolinkUrls(quotedIdentifiers(escapeTextRun(core.replace(/\s+-\s+/g, '-'))));
    }
    return lead + s + trail;
}

/** Styled runs as Markdown: links around their (styled) text, then each run. */
function renderRuns(runs, {inTable = false} = {}) {
    const merged = mergeRuns(runs);
    let out = '';
    for (let k = 0; k < merged.length;) {
        const url = merged[k].url;
        if (!url) {
            out += emitRun(merged[k], inTable);
            k++;
            continue;
        }
        let inner = '';
        while (k < merged.length && merged[k].url === url) inner += emitRun(merged[k++], inTable);
        const {lead, core, trail} = splitOuterSpace(inner);
        out += lead + (core ? linkTo(core, url) : '') + trail;
    }
    return tightenAfterCode(out.replace(/ {2,}/g, ' ')).trim();
}

/** Runs without a leading list label ("●", "•", "3.") and the spaces after it. */
function stripLabel(runs) {
    const k = runs.findIndex(r => !isBlankStr(r.text));
    if (k < 0) return runs;
    const own = runs[k].text.trimStart();
    if (LABEL_RE.test(own.trim())) {
        let j = k + 1;
        while (j < runs.length && isBlankStr(runs[j].text)) j++;
        return runs.slice(j);
    }
    const m = LEADING_LABEL.exec(own);
    if (!m) return runs;
    return [...runs.slice(0, k), {...runs[k], text: own.slice(m[0].length)}, ...runs.slice(k + 1)];
}

/** A table block as a GFM table: the first row is the header (without bold, which a header has anyway). */
function renderTableBlock(b) {
    const rows = b.grid.map((cells, ri) => cells.map((segs) => {
        const runs = joinLineRuns(segs.map(s => ({segs: [s]})));   // a wrapped cell joins like wrapped lines
        return renderRuns(ri === 0 ? runs.map(r => ({...r, bold: false})) : runs, {inTable: true});
    }));
    const widths = rows[0].map((_, ci) => Math.max(maxOf(rows, r => r[ci].length), 3));
    const line = (r) => '| ' + r.map((c, i) => c.padEnd(widths[i])).join(' | ') + ' |';
    return [line(rows[0]), line(widths.map(w => '-'.repeat(w))), ...rows.slice(1).map(line)].join('\n');
}

const LIST_BLOCKS = new Set(['bullet', 'numbered']);

function renderHeuristicBlocks(blocks) {
    const out = [];
    let prevType = null;
    for (const b of blocks) {
        const t = b.type;
        // Prose is escaped so PDF text such as "<img ...>" stays text; code is not.
        const txt = (raw) => escapeTextRun(raw.replace(/\s+-\s+/g, '-').replace(/  +/g, ' ').trim());
        // A heading keeps its links and code, not bold or italic (its size already says it is a heading).
        const heading = () => renderRuns(joinLineRuns(b.lines).map(r => ({...r, bold: false, italic: false})));
        let md = null;
        if (t === 'h1') md = `# ${heading()}`;
        else if (t === 'h2') md = `## ${heading()}`;
        else if (t === 'h3') md = `### ${heading()}`;
        else if (t === 'caps') {
            const tc = b.lines[0].text.replace(/\b(\w)(\w*)/g, (_, f, r) => f + r.toLowerCase());
            md = `## ${txt(tc)}`;
        } else if (t === 'bullet' || t === 'numbered') {
            const body = renderRuns(stripLabel(joinLineRuns(b.lines)));
            if (body) md = `${t === 'bullet' ? '-' : '1.'} ${escapeBlockStart(body)}`;
        } else if (t === 'code') {
            const code = codeBlockText(b.lines);
            md = fencedBlock(code, guessLang(code));
        } else if (t === 'table') {
            md = renderTableBlock(b);
        } else if (t === 'image') {
            md = IMAGE_PLACEHOLDER;
        } else if (t === 'para') {
            md = escapeBlockStart(renderRuns(joinLineRuns(b.lines)));
        }
        if (!md) continue;
        // Items of one list sit on consecutive lines; everything else is a block of its own.
        if (out.length) out.push(LIST_BLOCKS.has(t) && t === prevType ? '\n' : '\n\n');
        out.push(md);
        prevType = t;
    }
    return out.join('');
}

/** Adds the PDF's images to stats.images. OPS is pdf.js's operator table, for reading images and list markers. */
async function convertHeuristicPdf(pdf, onProgress, stats = {images: 0}, OPS = null) {
    const pages = await extractRawItems(pdf, onProgress, OPS);
    for (const p of pages) stats.images += p.images.length;
    const md = pagesToMarkdown(pages, pdf.numPages);
    if (onProgress) onProgress(85);
    return md;
}

/**
 * Markdown from the pages extractRawItems reads: {num, width, height, items,
 * links, images, marks} each. No pdf.js here, so tests can feed it built pages.
 */
export function pagesToMarkdown(pages, numPages = pages.length) {
    const monoFonts = identifyMonoFonts(pages);
    let lines = [];
    for (const p of pages) {
        for (const l of pageLines(p, monoFonts)) {
            for (const s of l.segs || []) s.runs = pieceRuns(s, monoFonts, l.links);
            lines.push(l);
        }
    }
    lines = removeRunningElements(lines, numPages);
    lines = removeCoverPage(lines, bodyFontSize(lines));
    if (!lines.some(l => !l.isImage)) return '';

    const textLines = lines.filter(l => !l.isImage);
    const xs = textLines.map(l => l.x);
    const ys = textLines.map(l => l.y);
    const medFS = bodyFontSize(textLines);
    const bodyX = median(xs);
    const gaps = [];
    for (let i = 1; i < ys.length; i++) {
        const g = ys[i] - ys[i - 1];
        if (g > 0 && g < 100) gaps.push(g);
    }
    const medGap = median(gaps) || 14;

    for (const l of lines) l._type = classifyLine(l, medFS, bodyX);
    for (let i = 1; i < lines.length; i++) {
        const prev = lines[i - 1];
        const l = lines[i];
        const below = l.pageNum === prev.pageNum && l.y > prev.y;
        // A lead paragraph set a little larger than the body: its short last line is not a heading.
        if (l._type === 'h3' && prev._type === 'para' && prev.fontSize >= 1.15 * medFS && Math.abs(prev.fontSize - l.fontSize) < 0.5
            && below && l.y - prev.y <= 1.8 * l.fontSize) l._type = 'para';
        // "12. The ..." right under a sentence that has not ended, at the same indent, carries that sentence on.
        if (l._type === 'numbered' && prev._type === 'para' && below && l.y - prev.y <= 1.5 * medGap
            && Math.abs(l.x - prev.x) <= 4 && !endsSentence(prev.text)) l._type = 'para';
    }
    return postProcess(renderHeuristicBlocks(buildHeuristicBlocks(lines, medGap)));
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared utilities
// ─────────────────────────────────────────────────────────────────────────────

/** True when `first` matches and `then` matches somewhere after it (no `.*`, so linear). */
function matchesInOrder(text, first, then) {
    const m = first.exec(text);
    return !!m && then.test(text.slice(m.index + m[0].length));
}

/**
 * The language of a code block, from its first SNIFF_CHARS characters. Every
 * pattern is linear in that text (no `.*` between two words, no adjacent
 * `\s*`), so hostile PDF text cannot stall the import.
 */
export function guessLang(code) {
    const text = code.length > SNIFF_CHARS ? code.slice(0, SNIFF_CHARS) : code;
    // PHP before JSON and JS: `<?php function f() {}` has JS keywords, `$this->x` has "->";
    // a `use A\B;` import, a `Class::method(` call or a `$variable =` assignment is PHP too.
    if (/^\s*<\?php/m.test(text) || /\$\w+\s*->\s*\w+/.test(text) || /^\s*use\s+\\?\w+(?:\\\w+)+[^\n;]*;/m.test(text)
        || (/^\s*\$\w+\s*=[^=]/m.test(text) && /\w::\w+\(|->\w+\(/.test(text))) return 'php';
    // A shell command on the first line: a package manager, git, curl, docker... (an optional "$ " prompt first).
    if (/^\s*(?:\$\s+)?(?:composer|npm|npx|yarn|pnpm|pip3?|git|curl|wget|docker|brew|apt(?:-get)?|sudo|make|cd)\s+\S/.test(text)) return 'bash';
    if (/^\s*[\[{]/.test(text) || /"[^"]+"\s*:/.test(text)) return 'json';
    if (matchesInOrder(text, /\bSELECT\b/i, /\bFROM\b/i)) return 'sql';
    if (/^#!/.test(text) || /\bdef \w+\(/.test(text)) return 'python';
    // Rust before JS: `let mut` would match the JS `\blet\b` pattern. `impl … {` is
    // only looked for at the start of a line, so a line of "impl impl impl" is read once.
    if (/\bfn\s+\w+\s*(?:<[^>\n]*>\s*)?\(|\blet\s+mut\b|\buse\s+\w+::/.test(text) ||
        /^[^\S\n]*(?:pub[^\S\n]+)?(?:unsafe[^\S\n]+)?impl\b[^\n{]*\{/m.test(text)) return 'rust';
    if (/\bfunction\b|\bconst\b|\blet\b|\bvar\b|\basync\b/.test(text)) return 'js';
    if (/interface \w+ \{|: string[\s;,]|: number[\s;,]/.test(text)) return 'ts';
    if (/:root\s*\{|^\.[a-z-]+\s*\{/m.test(text)) return 'css';
    if (/echo |fi\b|done\b|then\b/.test(text)) return 'bash';
    if (/\bfunc \w+\(|:= |package main/.test(text)) return 'go';
    if (/\bpublic (class|static|void)\b/.test(text)) return 'java';
    if (text.split('\n').some(line => matchesInOrder(line, /\bend\b/, /\bdo\b/) || matchesInOrder(line, /\bdef \w+/, /\bdo\b/))) return 'ruby';
    return '';
}

/**
 * Final clean-up shared by both paths. Page furniture (page numbers, "All
 * rights reserved") is not removed here: removeRunningElements drops it only
 * where it sits in a header or footer, so body text that says it stays.
 */
export function postProcess(md) {
    // Fix ligatures and Unicode artifacts. Only the zero-width space and the BOM
    // go: ZWNJ and ZWJ change how Arabic, Persian and Indic text is written.
    // Typographic quotes are the author's, so they stay as they are.
    md = md
        .replace(/ﬁ/g, 'fi').replace(/ﬂ/g, 'fl').replace(/ﬀ/g, 'ff')
        .replace(/ﬃ/g, 'ffi').replace(/ﬄ/g, 'ffl').replace(/ﬅ/g, 'st')
        .replace(/\u00AD/g, '')
        .replace(/[\u200B\uFEFF]/g, '');

    // A line of letter-spaced capitals still spelled out ("P U B L I S H I N G") is joined
    // up, never dropped: it can be a real title or tagline. Spaces and tabs only, so linear.
    md = md.replace(/^(?:[A-Z] ){2,}[A-Z][ \t]*$/gm, (line) => line.replace(/[ \t]/g, ''));

    let result = md.replace(/\n{3,}/g, '\n\n').trim();

    // Guarantee H1: promote first H2 if no H1 exists
    if (!/^# [^\n]+/m.test(result)) {
        const promoted = result.replace(/^## ([^\n]+)/m, '# $1');
        if (promoted !== result) {
            result = promoted;
        }
    }

    // Still no H1? Find ALL-CAPS line ≥ 3 words and title-case it
    if (!/^# [^\n]+/m.test(result)) {
        // Spaces and tabs only: with \s the run could cross lines and backtrack over the whole text.
        result = result.replace(/^([A-Z][A-Z \t]{10,})$/m, (_, caps) => {
            const titleCased = caps.replace(/\b(\w)(\w*)/g, (__, f, r) => f + r.toLowerCase()).trim();
            return `# ${titleCased}`;
        });
    }

    return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Open the PDF, asking for a password through opts.onPassword when it is
 * encrypted (again, with reason 'incorrect', after a wrong one). Resolves with
 * the document, or null when the user cancels the password prompt.
 */
async function openDocument(pdfjsLib, task, opts) {
    let cancelled = false;
    const INCORRECT = pdfjsLib.PasswordResponses?.INCORRECT_PASSWORD ?? 2;
    task.onPassword = (updatePassword, reason) => {
        if (typeof opts.onPassword !== 'function') {
            updatePassword(new Error('password required'));
            return;
        }
        Promise.resolve(opts.onPassword(reason === INCORRECT ? 'incorrect' : 'need')).then((password) => {
            if (password == null) {
                cancelled = true;
                updatePassword(new Error('cancelled'));
            } else {
                updatePassword(String(password));
            }
        }, (err) => updatePassword(err instanceof Error ? err : new Error(String(err))));
    };
    try {
        return await task.promise;
    } catch (err) {
        if (cancelled) return null;
        if (err && err.name === 'PasswordException') throw new Error('This PDF is password-protected. Open it again and enter its password.');
        throw err;
    }
}

/**
 * Convert a PDF File to a Markdown string.
 *
 * @param {File}     file          the PDF file
 * @param {Function} [onProgress]  callback(0–100)
 * @param {{onPassword?: (reason: 'need'|'incorrect') => Promise<string|null>,
 *          onConfirm?: (message: string) => Promise<boolean>, pdfjsLib?: object}} [opts]
 *        onConfirm is asked before a PDF of more than LARGE_PDF_PAGES pages is read.
 * @returns {Promise<string|null>}  Markdown, or null when the user cancelled
 */
export async function pdfToMarkdown(file, onProgress, opts = {}) {
    if (onProgress) onProgress(2);
    const pdfjsLib = opts.pdfjsLib || await loadPdfJs();
    if (onProgress) onProgress(5);

    const buf = await file.arrayBuffer();
    const task = pdfjsLib.getDocument(documentParams(new Uint8Array(buf)));
    // Destroying the loading task destroys the document and frees its worker.
    const destroy = () => Promise.resolve(typeof task.destroy === 'function' ? task.destroy() : null).catch(() => {});
    try {
        const pdf = await openDocument(pdfjsLib, task, opts);
        if (!pdf) return null;
        if (onProgress) onProgress(8);

        if (pdf.numPages > LARGE_PDF_PAGES && typeof opts.onConfirm === 'function') {
            const go = await opts.onConfirm(`This PDF has ${pdf.numPages} pages. Importing it can take a while and use a lot of memory. Import it anyway?`);
            if (!go) return null;
        }

        let stats = {images: 0};
        let md = (await isTaggedPdf(pdf)) ? await convertTaggedPdf(pdf, onProgress, stats, pdfjsLib.OPS) : '';
        // A tagged PDF whose tree gives no text (only containers, or text outside the tree) is read by position.
        if (!md.trim()) {
            stats = {images: 0};
            md = await convertHeuristicPdf(pdf, onProgress, stats, pdfjsLib.OPS);
        }
        if (!md.trim()) throw new Error(NO_TEXT_MESSAGE);
        if (stats.images) {
            warn(opts, `${stats.images} image${stats.images === 1 ? '' : 's'} not imported: images in a PDF are not extracted yet.`);
        }
        return md;
    } finally {
        await destroy();
    }
}
