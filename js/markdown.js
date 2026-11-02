/**
 * markdown.js
 * Markdown rendering via marked + highlight.js syntax highlighting, sanitised with DOMPurify.
 *
 * marked, DOMPurify, and hljs are globals loaded from vendor/ by <script> tags in index.html.
 * The extra highlight.js grammars are ES modules that js/code-languages.js imports.
 */

import {codeBlockHtml, createHighlightBudget, LANG_ID_RE, LANG_LABEL_RE, registerCodeLanguages} from './code-languages.js';

/**
 * Convert a heading's plain text to a URL-friendly slug.
 * Matches the algorithm used when writing the TOC by hand:
 *   "Paragraphs & Line Breaks" → "paragraphs--line-breaks"
 * Rules: NFC-normalise, lowercase, keep letters, digits and combining marks from any script,
 * spaces and hyphens; drop everything else; each space → "-".
 */
export function slugify(text) {
    return String(text == null ? '' : text)
        .normalize('NFC')                       // "e" + combining accent and "é" give one slug
        .toLowerCase()
        .replace(/[^\p{L}\p{M}\p{N}\s-]/gu, '') // keep letters/marks/digits/spaces/hyphens
        .replace(/\s/g, '-');                   // each space → its own hyphen ("& " keeps "--")
}

const NAMED_ENTITIES = {amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' '};

/** For each index, the next index at or after it holding one of chars, or -1. */
function nextIndexOf(s, chars) {
    const next = new Int32Array(s.length + 1).fill(-1);
    for (let i = s.length - 1; i >= 0; i--) next[i] = chars.includes(s[i]) ? i : next[i + 1];
    return next;
}

/**
 * Remove tags: the same result as s.replace(/<(?:[^>"']|"[^"]*"|'[^']*')*>/g, '')
 * in linear time. From a "<", a tag ends at the first ">" outside quotes; a
 * quote that never closes means no tag. That regex re-scans the rest of the
 * text from every "<", which is quadratic on a heading full of them.
 */
function stripTags(s) {
    if (!s.includes('<')) return s;
    const special = nextIndexOf(s, '>"\'');
    const quote = {'"': nextIndexOf(s, '"'), "'": nextIndexOf(s, "'")};
    // Scan position outside quotes -> index of the closing ">", -1 for none, -2 not known yet.
    const memo = new Int32Array(s.length + 2).fill(-2);
    const tagEnd = (from) => {
        const path = [];
        let p = from;
        let result;
        for (;;) {
            if (memo[p] !== -2) { result = memo[p]; break; }
            path.push(p);
            const at = special[p];
            if (at === -1) { result = -1; break; }
            if (s[at] === '>') { result = at; break; }
            const close = quote[s[at]][at + 1];
            if (close === -1) { result = -1; break; }
            p = close + 1;
        }
        for (const q of path) memo[q] = result;
        return result;
    };
    let out = '';
    let i = 0;
    while (i < s.length) {
        const lt = s.indexOf('<', i);
        if (lt === -1) { out += s.slice(i); break; }
        out += s.slice(i, lt);
        const end = tagEnd(lt + 1);
        if (end === -1) { out += '<'; i = lt + 1; } else { i = end + 1; }
    }
    return out;
}

/**
 * The text a reader sees in a heading's rendered HTML: tags removed, entities
 * decoded (unknown named entities are dropped). No DOM, so it also runs in Node.
 * @param {string} html
 * @returns {string}
 */
export function headingPlainText(html) {
    return stripTags(String(html == null ? '' : html))
        .replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (_m, name) => {
            if (name[0] === '#') {
                const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
                return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
            }
            return NAMED_ENTITIES[name.toLowerCase()] || '';
        });
}

/**
 * Ids of the app's own elements (index.html, plus the ones app scripts create).
 * A document id equal to one of these would be a second element with that id in
 * the app page: app CSS (#editor, #sidebar...) would style it, and <label for>,
 * aria-labelledby and getElementById could pick it. Such ids get an "h-" prefix
 * (appSafeId), and so do #links to them. tests/test.js checks this list against
 * index.html and the scripts. Ids and names that would clobber a document or form
 * property get the same prefix (documentSafeId).
 */
export const APP_ELEMENT_IDS = Object.freeze([
    'app-logo', 'autosave-status', 'bd-page-layout', 'btn-bold', 'btn-copy-html', 'btn-export', 'btn-import-docx', 'btn-import-drive',
    'btn-import-epub', 'btn-import-html', 'btn-import-pdf', 'btn-italic', 'btn-new', 'btn-open', 'btn-page-options', 'btn-reset', 'btn-save',
    'btn-template-info', 'btn-theme', 'cmdk', 'cmdk-input', 'cmdk-list', 'conflict-modal', 'conflict-modal-message',
    'conflict-modal-title', 'divider', 'doc-filter', 'doc-list', 'docx-input', 'drive-btn-cancel', 'drive-btn-cancel-picker',
    'drive-btn-cancel-settings', 'drive-btn-clear-creds', 'drive-btn-import-url', 'drive-btn-open-picker',
    'drive-btn-save-creds', 'drive-input-api-key', 'drive-input-client-id', 'drive-modal', 'drive-modal-backdrop',
    'drive-modal-close', 'drive-modal-panel', 'drive-modal-title', 'drive-tab-bar', 'drive-tab-picker', 'drive-tab-settings',
    'drive-tab-url', 'drive-url-input', 'editor', 'editor-pane', 'epub-input', 'export-format', 'export-orientation',
    'export-paper-size', 'file-input', 'footer', 'html-input', 'image-input', 'import-confirm-modal',
    'import-confirm-modal-message', 'import-confirm-modal-title', 'main', 'menu-import-list',
    'menu-import-trigger', 'menu-more-list', 'menu-more-trigger', 'menu-view-list', 'menu-view-trigger',
    'page-options-modal', 'page-options-modal-title', 'password-modal', 'password-modal-input', 'password-modal-message', 'password-modal-title', 'pdf-input',
    'po-custom', 'po-error', 'po-fit', 'po-height', 'po-layout-continuous', 'po-layout-paged', 'po-margin', 'po-margin-unit',
    'po-note', 'po-unit', 'po-width', 'preflight-modal', 'preflight-modal-list', 'preflight-modal-message', 'preflight-modal-title', 'preview', 'preview-pane', 'read-time', 'sidebar', 'sidebar-new', 'sidebar-open', 'sidebar-toggle', 'storage-banner',
    'storage-banner-close', 'template-info-body', 'template-info-close', 'template-info-popover', 'template-select',
    'template-styles', 'toast', 'toolbar-format', 'toolbar-nav', 'word-count',
]);
const APP_ID_SET = new Set(APP_ELEMENT_IDS);

/**
 * An id without its de-duplication suffixes ("editor-1-2" -> "editor"). Reserved
 * ids are tested on this base, so "editor-1" (the second "Editor" heading, or a
 * hand-written #editor-1 link) gets the prefix exactly like "editor".
 */
function baseId(id) {
    return String(id).replace(/(?:-\d+)+$/, '') || String(id);
}

/** The id a document element may use: an app element id (or its -N form) gets the "h-" prefix. */
export function appSafeId(id) {
    return APP_ID_SET.has(baseId(id)) ? `h-${id}` : id;
}

// A detached, empty document and form, made once. Checking names against them
// rather than the live page gives the same answer wherever the Markdown is
// rendered (app preview, print window, a headless renderer) and whatever the page
// already contains.
let pristine = null;

/**
 * True when an id or name would shadow a built-in property of a document or a
 * form ("links", "images", "title", "cookie", "getElementById"...), the DOM
 * clobbering DOMPurify's SANITIZE_DOM guards against. Browser only.
 */
function shadowsDomProperty(id) {
    if (typeof document === 'undefined') return false;
    if (!pristine) {
        const doc = document.implementation.createHTMLDocument('');
        pristine = {doc, form: doc.createElement('form')};
    }
    return id in pristine.doc || id in pristine.form;
}

/** The id a rendered document uses: app ids and DOM property names, and their -N forms, get "h-". */
function documentSafeId(id) {
    const base = baseId(id);
    return APP_ID_SET.has(base) || shadowsDomProperty(base) ? `h-${id}` : id;
}

/**
 * A heading id generator for one rendered document: plain-text slug, "h-" for
 * reserved ids, "section-N" when nothing is left, and "-1", "-2"... for repeats.
 * @param {{safeId?: (id: string) => string}} [opts]  the reserved-id rule
 *        (default appSafeId; the renderer also avoids ids DOMPurify would drop)
 * @returns {(headingHtml: string) => string}
 */
export function createHeadingIds({safeId = appSafeId} = {}) {
    const used = new Set();
    let untitled = 0;
    return function next(headingHtml) {
        const slug = slugify(headingPlainText(headingHtml).trim());
        const base = /[\p{L}\p{N}]/u.test(slug) ? safeId(slug) : `section-${++untitled}`;
        let id = base;
        for (let n = 1; used.has(id); n++) id = `${base}-${n}`;
        used.add(id);
        return id;
    };
}

// ── Inline extensions ────────────────────────────────────────────────────────
//
// ==highlight==, ~sub~, ^sup^ and a fixed :shortcode: list, as marked inline
// extensions. Marked offers every inline position to an extension's tokenizer
// before plain text takes it, and start() tells marked's text tokenizer where
// to stop, so the delimiters are never read as ordinary characters. The
// spacing rules are Pandoc's, so ordinary prose stays untouched: an opening
// delimiter must be followed by a non-space, a closing one preceded by a
// non-space, and a sub/superscript content may hold no whitespace at all
// ("about ~10 to ~20 minutes", "x^2 and y^3 are"). Nothing rewrites code: the
// code-span and fenced-code tokenizers consume their text whole and marked
// never lexes inside it. `~~strike~~` is marked's own del rule; it can never
// open a subscript, whose tilde may not be followed by another tilde.

/**
 * The emoji shortcodes this renderer knows; a colon pair around anything else
 * (":notanemoji:", "10:30:45", a URL's "a:b") is left exactly as typed.
 * Values are the Unicode characters themselves.
 */
export const EMOJI_SHORTCODES = Object.freeze({
    smile: '😄',
    rocket: '🚀',
    check: '✅',
    warning: '⚠️',
    books: '📚',
    computer: '💻',
    tada: '🎉',
    bulb: '💡',
    memo: '📝',
    star: '⭐',
    heart: '❤️',
    thumbsup: '👍',
    x: '❌',
    eyes: '👀',
    fire: '🔥',
    zap: '⚡',
    lock: '🔒',
    link: '🔗',
    pushpin: '📌',
    sparkles: '✨',
});
const EMOJI_NAMES = Object.keys(EMOJI_SHORTCODES).join('|');
const EMOJI_RULE = new RegExp(`^:(${EMOJI_NAMES}):`);
const EMOJI_FIND = new RegExp(`:(?:${EMOJI_NAMES}):`, 'g');

// A bare web address is one token of marked's own autolink rule. An inline extension must never ask marked to
// cut the text inside one (at the ":" of "https:", a "~" in a path), or the address would stop being a link.
const URL_BEFORE = /(?:https?:\/\/|ftp:\/\/|www\.)\S*$/;

/**
 * Where an extension's start() should point: the index of the first match of the global regex `re` in `src` that
 * is not inside a bare web address, else undefined. start() names only places a real token can begin, so marked
 * never splits ordinary text (or an address) for nothing.
 */
function firstOutsideUrl(src, re) {
    re.lastIndex = 0;
    for (let match = re.exec(src); match; match = re.exec(src)) {
        if (!URL_BEFORE.test(src.slice(0, match.index))) return match.index;
        if (match[0].length === 0) re.lastIndex++;
    }
    return undefined;
}

/** &, < and > escaped: sub- and superscript contents are literal text (Pandoc). */
function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** `==highlighted text==` → <mark>, with inline markup parsed inside. */
const highlightExtension = {
    name: 'highlight',
    level: 'inline',
    start(src) {
        return firstOutsideUrl(src, /==(?=[^\s=])[\s\S]*?[^\s=]==(?!=)/g);
    },
    tokenizer(src) {
        // The opener is followed by a non-space that is not another "=", the content is closed by the first
        // `==` preceded by a non-space that is not "=" and not followed by "=": a run of three or more
        // equals signs ("a === b") is never a highlight.
        const match = /^==(?=[^\s=])([\s\S]*?[^\s=])==(?!=)/.exec(src);
        if (!match) return;
        return {
            type: 'highlight',
            raw: match[0],
            text: match[1],
            tokens: this.lexer.inlineTokens(match[1]),
        };
    },
    renderer(token) {
        return `<mark>${this.parser.parseInline(token.tokens)}</mark>`;
    },
};

/**
 * One subscript (`~sub~`) or superscript (`^sup^`) extension: one delimiter
 * on each side, the content with no whitespace and no delimiter character,
 * the opener not followed by the delimiter again (so `~~strike~~` never
 * reads as a subscript), and literal escaped content (Pandoc's sub/sup).
 * `delim` is the character itself (for inside character classes), `escaped`
 * its literal form outside one: "~" and "\\^".
 */
const subOrSupExtension = (name, tag, delim, escaped) => {
    // The content holds no whitespace, no delimiter and no square bracket, so "[^1][^2]" is never a superscript.
    const content = `[^\\s${delim}\\[\\]]`;
    const find = new RegExp(`${escaped}${content}+${escaped}`, 'g');
    const whole = new RegExp(`^${escaped}(${content}+)${escaped}`);
    return {
        name,
        level: 'inline',
        start(src) {
            return firstOutsideUrl(src, find);
        },
        tokenizer(src) {
            const match = whole.exec(src);
            if (!match) return;
            return {type: name, raw: match[0], text: match[1]};
        },
        renderer(token) {
            return `<${tag}>${escapeHtml(token.text)}</${tag}>`;
        },
    };
};
const subscriptExtension = subOrSupExtension('subscript', 'sub', '~', '~');
const superscriptExtension = subOrSupExtension('superscript', 'sup', '^', '\\^');

/** `:rocket:` → 🚀, only for the fixed list in EMOJI_SHORTCODES. */
const emojiExtension = {
    name: 'emoji',
    level: 'inline',
    start(src) {
        return firstOutsideUrl(src, EMOJI_FIND);
    },
    tokenizer(src) {
        const match = EMOJI_RULE.exec(src);
        if (!match) return;
        return {type: 'emoji', raw: match[0], name: match[1], emoji: EMOJI_SHORTCODES[match[1]]};
    },
    renderer(token) {
        return token.emoji;
    },
};

// ── Definition lists ─────────────────────────────────────────────────────────
//
// Term
// :   The definition of the term.
//
// Term Two
// :   First definition.
// :   A second definition for the same term.
//
// as a marked block extension, PHP Markdown Extra / Pandoc style. A term is
// one line of plain text; a definition line starts with a colon followed by at
// least one space or tab, and a definition may continue on lines indented by
// at least 4 spaces or a tab. Inline markup is parsed inside terms and
// definitions. A run of term groups (blank lines between them stay inside the
// run) is one <dl>, with one <dt> per term and one <dd> per definition line.
// Ordinary prose is untouched: a ": " line only reads as a definition right
// after a term line, so "text\n:smile: is an emoji" stays a paragraph, as does
// text, a blank line, then a colon line. Nothing rewrites code: a term line
// that opens a code span it does not close is not a term, and fenced blocks
// never reach this extension.

/** A definition line: a colon at the line start, then at least one space or tab. */
const DEF_LINE = /^:[ \t]/;
/** A line a definition may continue on: indented by at least 4 spaces or a tab. */
const CONT_LINE = /^[ \t]{4}|^\t/;
/**
 * A line that opens a block of its own and so cannot be a term: a fence, an
 * ATX heading, a block quote, a list item, a horizontal rule or HTML. (A line
 * indented like code is excluded by the indent check in isTermLine().)
 */
const NOT_TERM = /^(?:```|~~~|#{1,6}(?:[ \t]|$)|>|[-+*](?:[ \t]|$)|\d{1,9}[.)](?:[ \t]|$)|(?:[-*_][ \t]*){3,}$|<)/;

/**
 * True when the line opens a code span it does not close: the following
 * ": " line is then inside the span, not a definition. A run of backticks
 * closes the nearest earlier run of the same length (code spans do not nest).
 */
function unclosedCodeSpan(line) {
    const open = [];
    for (const run of String(line).match(/`+/g) || []) {
        const at = open.indexOf(run.length);
        if (at === -1) open.push(run.length); else open.length = at;
    }
    return open.length > 0;
}

/** Whether a line may be a definition-list term: one line of plain text. */
function isTermLine(line) {
    if (!line.trim() || /^[ \t]{4}|^\t/.test(line)) return false;
    const body = line.replace(/^ {1,3}/, '');
    return !DEF_LINE.test(body) && !NOT_TERM.test(body) && !unclosedCodeSpan(body);
}

/**
 * Where a definition list could next begin: the start of a term line directly
 * followed by a definition line, else undefined. marked calls start() with its
 * paragraph source minus the first character and cuts the paragraph at the
 * returned index plus 1 characters, so the returned index is a line start,
 * never a position inside a longer match. The first line is never reported:
 * its stripped first character can turn a line that is not a term (a "`", ":",
 * ">", "#" or list opener) into one, and a real group at the very start needs
 * no cut because the tokenizer matches it whole.
 */
function firstDefListStart(src) {
    // Only the paragraph in front: a term and its definition are on consecutive lines, so a blank line ends the
    // search. (marked hands start() the whole rest of the document for every paragraph; reading all of it each time
    // is quadratic: minutes for a 2 MB document.)
    const blank = src.search(/\n[ \t]*\n/);
    const lines = (blank === -1 ? src : src.slice(0, blank)).split('\n');
    let at = 0;
    for (let i = 0; i + 1 < lines.length; i++) {
        if (i > 0 && isTermLine(lines[i]) && DEF_LINE.test(lines[i + 1])) return at;
        at += lines[i].length + 1;
    }
    return undefined;
}

/**
 * The lines of src, cut out one at a time as they are asked for (at(i) is undefined past the end), so that reading
 * the first few lines of a long document costs those lines and not the document. taken() is what has been cut so far.
 */
function lineReader(src) {
    const lines = [];
    let pos = 0;
    return {
        at(i) {
            while (lines.length <= i && pos <= src.length) {
                const nl = src.indexOf('\n', pos);
                lines.push(nl === -1 ? src.slice(pos) : src.slice(pos, nl));
                pos = nl === -1 ? src.length + 1 : nl + 1;
            }
            return lines[i];
        },
        taken: () => lines,
    };
}

/** The definition-list block extension: one <dl> per run of term groups. */
const defListExtension = {
    name: 'deflist',
    level: 'block',
    start(src) {
        return firstDefListStart(src);
    },
    tokenizer(src) {
        // marked passes the whole rest of the document: lines are cut out only as they are asked for.
        const lines = lineReader(src);
        const items = [];
        let line = 0;
        for (;;) {
            // One group: a term line, then definitions, each definition with
            // its indented continuation lines; nothing blank between them.
            const term = lines.at(line);
            const first = lines.at(line + 1);
            if (term === undefined || first === undefined) break;
            if (!isTermLine(term) || !DEF_LINE.test(first)) break;
            items.push({type: 'dt', text: term.replace(/^ {1,3}/, '')});
            line++;
            while (lines.at(line) !== undefined && DEF_LINE.test(lines.at(line))) {
                const text = [lines.at(line).replace(/^:[ \t]+/, '')];
                line++;
                while (lines.at(line) !== undefined && CONT_LINE.test(lines.at(line))) {
                    text.push(lines.at(line).replace(/^[ \t]+/, ''));
                    line++;
                }
                items.push({type: 'dd', text: text.join('\n')});
            }
            // Blank lines keep the next term group in this dl; without one the
            // run ends here and the rest is lexed on its own.
            const stop = line;
            while (lines.at(line) !== undefined && !lines.at(line).trim()) line++;
            const next = lines.at(line);
            const after = lines.at(line + 1);
            if (next === undefined || after === undefined || !isTermLine(next) || !DEF_LINE.test(after)) {
                line = stop;
                break;
            }
        }
        if (!items.length) return undefined;
        return {
            type: 'deflist',
            raw: lines.taken().slice(0, line).join('\n'),
            items: items.map((item) => ({
                ...item,
                tokens: this.lexer.inlineTokens(item.text),
            })),
        };
    },
    renderer(token) {
        let html = '<dl>';
        for (const item of token.items) {
            const inner = this.parser.parseInline(item.tokens);
            html += item.type === 'dt' ? `<dt>${inner}</dt>` : `<dd>${inner}</dd>`;
        }
        return `${html}</dl>\n`;
    },
};

// ── Footnotes ────────────────────────────────────────────────────────────────
//
//     A sentence with a note.[^1]
//
//     [^1]: The note's text, which may continue on lines
//         indented by four spaces or a tab, and holds inline Markdown.
//
// A reference becomes a superscript link to its note, numbered in the order of first reference. The notes are one
// ordered list after the last block (the postprocess hook in configureMarked), so a document with no footnote renders
// exactly as before. A reference with no definition stays as typed, a definition nobody refers to prints nothing,
// and the first of two definitions with the same label wins. Numbers, never the writer's labels, go into ids and links.
// marked lexes every block before any inline text, so a definition is known by the time a reference is read.
// The way back is an up arrow: the vendored fonts hold it, while the usual return arrow (U+21A9) is in none of them
// and would print in a system font, which the print-quality rule forbids.

const FOOTNOTE_LABEL = '[A-Za-z0-9_-]{1,32}';
const FOOTNOTE_DEF = new RegExp(`^\\[\\^(${FOOTNOTE_LABEL})\\]:[ \\t]+`);
const FOOTNOTE_REF = new RegExp(`^\\[\\^(${FOOTNOTE_LABEL})\\]`);
const FOOTNOTE_DEF_LINE = new RegExp(`\\n\\[\\^${FOOTNOTE_LABEL}\\]:[ \\t]`);

/** Per document, reset with the heading ids at the start of every parse. */
function createFootnotes() {
    // defs: label -> {html} (html is set when the definition is rendered); numbers: label -> number;
    // uses: label -> references so far; order: the labels in the order of first reference.
    return {defs: new Map(), numbers: new Map(), uses: new Map(), order: [], lexingNote: false};
}
let footnotes = createFootnotes();

/** A definition line, [^label]: text, with its indented continuation lines. It prints nothing where it stands. */
const footnoteDefExtension = {
    name: 'footnoteDef',
    level: 'block',
    start(src) {
        // A definition line directly under a paragraph line ends that paragraph. Only the paragraph in front is
        // searched: marked hands start() the whole rest of the document for every block.
        const blank = src.search(/\n[ \t]*\n/);
        const at = (blank === -1 ? src : src.slice(0, blank)).search(FOOTNOTE_DEF_LINE);
        return at === -1 ? undefined : at + 1;
    },
    tokenizer(src) {
        const match = FOOTNOTE_DEF.exec(src);
        if (!match) return undefined;
        const lines = lineReader(src);
        const text = [lines.at(0).slice(match[0].length)];
        let line = 1;
        while (lines.at(line) !== undefined && CONT_LINE.test(lines.at(line))) {
            text.push(lines.at(line).replace(/^[ \t]+/, ''));
            line++;
        }
        const label = match[1];
        const first = !footnotes.defs.has(label);
        // The note's own text is lexed here, with references inside it left as typed (a note has no notes).
        footnotes.lexingNote = true;
        const tokens = this.lexer.inlineTokens(text.join('\n'));
        footnotes.lexingNote = false;
        if (first) footnotes.defs.set(label, {html: ''});
        return {type: 'footnoteDef', raw: lines.taken().slice(0, line).join('\n'), label, first, tokens};
    },
    renderer(token) {
        if (token.first) footnotes.defs.get(token.label).html = this.parser.parseInline(token.tokens);
        return '';
    },
};

/** [^label] where the label has a definition: a numbered superscript link. Anything else stays as typed. */
const footnoteRefExtension = {
    name: 'footnoteRef',
    level: 'inline',
    start(src) {
        const at = src.indexOf('[^');
        return at === -1 ? undefined : at;
    },
    tokenizer(src) {
        const match = FOOTNOTE_REF.exec(src);
        if (!match || footnotes.lexingNote) return undefined;
        const label = match[1];
        if (!footnotes.defs.has(label)) return undefined;
        let n = footnotes.numbers.get(label);
        if (n === undefined) {
            n = footnotes.order.length + 1;
            footnotes.numbers.set(label, n);
            footnotes.order.push(label);
        }
        const uses = (footnotes.uses.get(label) || 0) + 1;
        footnotes.uses.set(label, uses);
        return {type: 'footnoteRef', raw: match[0], n, uses};
    },
    renderer(token) {
        const id = token.uses > 1 ? `fnref-${token.n}-${token.uses}` : `fnref-${token.n}`;
        return `<sup class="footnote-ref"><a href="#fn-${token.n}" id="${id}">${token.n}</a></sup>`;
    },
};

/** The notes list for the references this document made, or '' when it made none. */
function footnotesSection() {
    if (!footnotes.order.length) return '';
    const items = footnotes.order.map((label, i) => {
        const n = i + 1;
        const body = footnotes.defs.get(label).html.trim();
        return `<li id="fn-${n}">${body} <a href="#fnref-${n}" class="footnote-back" aria-label="Back to the text">↑</a></li>`;
    });
    return `<section class="footnotes"><hr><ol>${items.join('')}</ol></section>\n`;
}

// Reset by the preprocess hook at the start of every marked.parse().
let nextHeadingId = createHeadingIds({safeId: documentSafeId});
// How much more code this document may highlight (js/code-languages.js); reset with nextHeadingId.
let highlightBudget = createHighlightBudget();

/**
 * Configure marked with GFM options and highlight.js code renderer.
 * Call once at app startup before any renderMarkdown() calls.
 */
export function configureMarked() {
    registerCodeLanguages(hljs);
    const renderer = new marked.Renderer();

    // Heading renderer: adds an id attribute so anchor links and PDF internal links work.
    // marked v9+ removed automatic headerIds; we restore it with our own slugger.
    renderer.heading = function (tokenOrText, levelOrNothing) {
        let text, level;
        if (tokenOrText && typeof tokenOrText === 'object') {
            // Render the inline tokens like marked's own renderer, so escapes
            // (`\<`, `\*`) and inline Markdown work; token.text is the raw source.
            text = tokenOrText.tokens && this.parser
                ? this.parser.parseInline(tokenOrText.tokens)
                : (tokenOrText.text || '');
            level = tokenOrText.depth || 1;
        } else {
            text = tokenOrText || '';
            level = levelOrNothing || 1;
        }
        // The id comes from the rendered text, so links, code spans and entities
        // give the words a reader sees ("&lt;img&gt;" -> "img", not "ltimggt").
        return `<h${level} id="${nextHeadingId(text)}">${text}</h${level}>\n`;
    };

    // Override code block rendering to use highlight.js.
    // marked v9+ passes a token object { text, lang, ... }; older versions pass (code, lang).
    // We handle both signatures defensively.
    renderer.code = function (tokenOrCode, langOrNothing) {
        let text, lang;
        if (tokenOrCode && typeof tokenOrCode === 'object') {
            // v9+ token object
            text = tokenOrCode.text || '';
            lang = tokenOrCode.lang || '';
        } else {
            // v4–v8 positional args
            text = tokenOrCode || '';
            lang = langOrNothing || '';
        }
        // Language, label and highlighting: js/code-languages.js, within this document's budget.
        return codeBlockHtml(text, lang, hljs, highlightBudget);
    };

    marked.use({
        renderer,
        extensions: [highlightExtension, subscriptExtension, superscriptExtension, emojiExtension, defListExtension,
            footnoteDefExtension, footnoteRefExtension],
        async: false,
        gfm: true,
        breaks: false,
        // Heading ids are unique per document, so each parse starts a fresh set.
        hooks: {
            preprocess(markdown) {
                nextHeadingId = createHeadingIds({safeId: documentSafeId});
                highlightBudget = createHighlightBudget();
                footnotes = createFootnotes();
                return markdown;
            },
            // The notes list goes after the last block; a document that made no reference gets nothing added.
            postprocess(html) {
                return html + footnotesSection();
            },
        },
    });
}

// ── Sanitiser ────────────────────────────────────────────────────────────────
//
// Markdown, imported documents and Drive files are untrusted. Everything that
// reaches the preview or the print window goes through sanitizeHTML(), so the
// configuration lives here once. DOMPurify already strips scripts, event
// handlers and javascript:/vbscript:/data: (non-image) URLs; on top of that we
// forbid elements that can restyle or phish inside the app, and we only allow
// embeds from a short list of video/document hosts.

/** Elements that can restyle the app (style) or collect input (forms). */
const FORBID_TAGS = ['style', 'form', 'button', 'select', 'textarea', 'option'];

/**
 * Hosts an iframe may load from: https only, exact host match. The CSP
 * frame-src in index.html lists the same hosts (tests/test.js checks this).
 */
export const IFRAME_HOSTS = Object.freeze([
    'youtube.com',
    'www.youtube.com',
    'www.youtube-nocookie.com',
    'player.vimeo.com',
    'docs.google.com',
]);
const IFRAME_HOST_SET = new Set(IFRAME_HOSTS);

/**
 * The minimum sandbox that lets YouTube, Vimeo and Google Docs embeds play:
 * allow-scripts      the players are JavaScript apps;
 * allow-same-origin  the players read their own cookies/storage and refuse to
 *                    start without them (YouTube shows an error). Safe here
 *                    because every allowed host is cross-origin to the app, so
 *                    the frame still cannot reach the app's DOM or storage;
 * allow-presentation casting (Presentation API);
 * allow-popups       "Watch on YouTube"/"Open in Docs" open a new tab.
 * Not granted: allow-top-navigation, allow-forms, allow-modals, downloads.
 */
const IFRAME_SANDBOX = 'allow-scripts allow-same-origin allow-presentation allow-popups';
const IFRAME_ATTRS = new Set(['src', 'width', 'height', 'title', 'allowfullscreen']);

/** Attributes a task-list checkbox (marked's `- [x]` output) may keep. */
const CHECKBOX_ATTRS = new Set(['type', 'checked', 'disabled']);

function isAllowedIframeSrc(src) {
    if (!/^https:\/\//i.test(src || '')) return false;
    let u;
    try {
        u = new URL(src);
    } catch {
        return false;
    }
    return u.protocol === 'https:' && !u.username && !u.password && !u.port && IFRAME_HOST_SET.has(u.hostname);
}

function removeAttributesExcept(node, keep) {
    for (const name of Array.from(node.attributes, a => a.name)) {
        if (!keep.has(name.toLowerCase())) node.removeAttribute(name);
    }
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const XLINK_NS = 'http://www.w3.org/1999/xlink';
let hooksInstalled = false;

/** The id a "#..." link points at: percent-decoded (when valid) and NFC-normalised, as ids are. */
function fragmentId(href) {
    let id = href.slice(1);
    try {
        id = decodeURIComponent(id);
    } catch { /* malformed escape: keep it as written */
    }
    return id.normalize('NFC');
}

/** Runs on every element after DOMPurify has filtered its attributes. */
function afterSanitizeAttributes(node) {
    // The code-block label (data-lang, shown by template CSS) and its colour key:
    // raw HTML may set them too, so a value outside the renderer's own character set goes.
    if (node.nodeType !== 1) return;
    for (const [name, re] of [['data-lang', LANG_LABEL_RE], ['data-lang-id', LANG_ID_RE]]) {
        if (node.hasAttribute(name) && !re.test(node.getAttribute(name))) node.removeAttribute(name);
    }
    if (node.namespaceURI === SVG_NS) {
        // SVG <a> (nodeName 'a') supports neither rel nor the preview's #anchor
        // handling, so a click would navigate the app tab: drop its link target.
        if (node.localName === 'a') {
            node.removeAttribute('href');
            node.removeAttributeNS(XLINK_NS, 'href');
        }
        return;
    }
    const tag = node.nodeName;
    if (tag === 'IFRAME') {
        if (!isAllowedIframeSrc(node.getAttribute('src'))) {
            node.remove();
            return;
        }
        removeAttributesExcept(node, IFRAME_ATTRS);
        node.setAttribute('sandbox', IFRAME_SANDBOX);
        node.setAttribute('referrerpolicy', 'no-referrer');
        node.setAttribute('loading', 'lazy');
    } else if (tag === 'INPUT') {
        // Only the read-only checkboxes GFM task lists produce; any other input
        // (password, text, file...) could be used to phish inside the app.
        if ((node.getAttribute('type') || '').toLowerCase() !== 'checkbox') {
            node.remove();
            return;
        }
        removeAttributesExcept(node, CHECKBOX_ATTRS);
        node.setAttribute('disabled', '');
    } else if (tag === 'A' || tag === 'AREA') {
        const href = node.getAttribute('href');
        if (href && !href.startsWith('#')) {
            // Leave the app in place: links open a new tab without a window.opener.
            node.setAttribute('target', '_blank');
            node.setAttribute('rel', 'noopener noreferrer');
        } else {
            // #anchor links scroll inside the preview (see the click handler in app.js),
            // and follow the h- prefix a heading or element with an app id gets.
            node.removeAttribute('target');
            if (href) node.setAttribute('href', '#' + encodeURIComponent(documentSafeId(fragmentId(href))));
        }
    }
}



/**
 * Runs before DOMPurify checks each attribute. Raw HTML ids and names follow the
 * heading rule: NFC-normalised, as heading slugs and "#..." links are, so a link
 * matches whichever Unicode form either side was typed in; and an app id or a DOM
 * property name gets "h-", so it is neither a
 * second app element nor able to clobber a document property. This replaces
 * DOMPurify's SANITIZE_DOM check (off in purifyConfig), which tests the live page
 * and so dropped an id or not depending on what the preview already held.
 */
function uponSanitizeAttribute(_node, data) {
    if ((data.attrName === 'id' || data.attrName === 'name') && data.attrValue) {
        data.attrValue = documentSafeId(data.attrValue.normalize('NFC'));
    }
}

function installHooks() {
    if (hooksInstalled) return;
    DOMPurify.addHook('uponSanitizeAttribute', uponSanitizeAttribute);
    DOMPurify.addHook('afterSanitizeAttributes', afterSanitizeAttributes);
    hooksInstalled = true;
}

function purifyConfig({allowIframes = true} = {}) {
    return {
        ADD_TAGS: allowIframes ? ['iframe'] : [],
        ADD_ATTR: ['allowfullscreen'],
        // Clobbering protection is uponSanitizeAttribute's job: it checks a
        // detached document, so the output does not depend on the live page.
        SANITIZE_DOM: false,
        FORBID_TAGS: allowIframes ? FORBID_TAGS : [...FORBID_TAGS, 'iframe'],
    };
}

/**
 * Sanitise an HTML string with the app's one configuration.
 * @param {string} html
 * @param {{allowIframes?: boolean}} [opts]  allowIframes=false drops every iframe
 * @returns {string}
 */
export function sanitizeHTML(html, opts = {}) {
    installHooks();
    return DOMPurify.sanitize(String(html == null ? '' : html), purifyConfig(opts));
}

/**
 * Run a template's optional transformHTML hook, then sanitise its output again:
 * a template must not be able to put back what the sanitiser removed.
 * @param {string} html            sanitised HTML from renderMarkdown()
 * @param {object|null} templateObj
 * @param {{allowIframes?: boolean}} [opts]
 * @returns {string}
 */
export function applyTemplateTransform(html, templateObj, opts = {}) {
    if (!templateObj || typeof templateObj.transformHTML !== 'function') return html;
    return sanitizeHTML(templateObj.transformHTML(html), opts);
}

/**
 * Render a markdown string to sanitized HTML.
 * @param {string} source - Raw markdown text
 * @param {{allowIframes?: boolean}} [opts]
 * @returns {string} Sanitized HTML string
 */
export function renderMarkdown(source, {allowIframes = true} = {}) {
    if (!source || !source.trim()) return '';
    return sanitizeHTML(marked.parse(source), {allowIframes});
}
