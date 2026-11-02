/**
 * font-check.js
 * Before a PDF prints: load every vendored face the document uses and confirm
 * each one applied, so a font that failed to load is reported instead of the PDF
 * quietly printing a system fallback.
 *
 * checkFonts() is self-contained (no imports, no module state): the PDF API
 * passes it to Playwright's page.evaluate() for a print page whose CSP runs no
 * scripts of its own, and the editor's print window (js/pdf-export.js) calls it
 * with the window's document.
 */

/** How long loading the document's faces may take before printing goes ahead with a warning. */
export const FONT_LOAD_TIMEOUT_MS = 4000;

/**
 * @param {{doc?: Document, families?: string[], timeoutMs?: number}} [opts]
 *        doc: the document to check (default: this one); families: the vendored
 *        family names (js/fonts.js FONT_FAMILIES), the only ones checked
 * @returns {Promise<{warnings: string[], faces: number, timedOut: boolean}>}
 *          faces: how many family, weight and style combinations the text uses
 */
export async function checkFonts(opts = {}) {
    const doc = opts.doc || document;
    const ours = new Set(opts.families || []);
    const timeoutMs = opts.timeoutMs || 4000;
    const fonts = doc && doc.fonts;
    if (!doc || !doc.body || !fonts || typeof fonts.load !== 'function' || typeof fonts.check !== 'function') {
        return {warnings: [], faces: 0, timedOut: false};
    }
    const view = doc.defaultView || window;
    const unquote = (name) => name.trim().replace(/^(["'])(.*)\1$/, '$2').trim();
    const SAMPLE_MAX = 400;

    // 1. The faces the text uses: every vendored family in an element's stack
    //    (the brand font and the symbol fallbacks after it), with its weight,
    //    style and a sample of the text, so load() fetches the subsets it needs.
    const uses = new Map();
    const note = (style, text) => {
        if (!text || !text.trim()) return;
        for (const name of style.fontFamily.split(',').map(unquote)) {
            if (!ours.has(name)) continue;
            const key = `${style.fontStyle}|${style.fontWeight}|${name}`;
            const use = uses.get(key) || {style: style.fontStyle, weight: style.fontWeight, family: name, text: ''};
            if (use.text.length < SAMPLE_MAX) use.text += text.slice(0, SAMPLE_MAX - use.text.length);
            uses.set(key, use);
        }
    };
    // At most TEXT_NODES_MAX text nodes are read: every face a document uses
    // shows up long before that, and a huge table stays quick.
    const TEXT_NODES_MAX = 50000;
    const walker = doc.createTreeWalker(doc.body, 4 /* NodeFilter.SHOW_TEXT */);
    let seen = 0;
    for (let node = walker.nextNode(); node && seen < TEXT_NODES_MAX; node = walker.nextNode()) {
        if (!node.parentElement || !node.data.trim()) continue;
        seen++;
        note(view.getComputedStyle(node.parentElement), node.data);
    }
    // Generated text: the code-block language label and printed link addresses.
    for (const el of Array.from(doc.querySelectorAll('pre[data-lang], a[data-bd-href]'))) {
        for (const pseudo of ['::before', '::after']) {
            const style = view.getComputedStyle(el, pseudo);
            const content = style.content;
            if (content && content !== 'none' && content !== 'normal') note(style, el.getAttribute('data-lang') || el.getAttribute('href') || 'Aa');
        }
    }

    // 2. Load them all, within the time limit.
    const fontSpec = (u) => `${u.style} ${u.weight} 16px "${u.family}"`;
    let timer;
    const timedOut = await Promise.race([
        Promise.all(Array.from(uses.values(), (u) => fonts.load(fontSpec(u), u.text).catch(() => null))).then(() => false),
        new Promise((resolve) => { timer = setTimeout(() => resolve(true), timeoutMs); }),
    ]);
    clearTimeout(timer);

    // 3. Confirm. A face that failed or is still loading is named; a family the
    //    document uses but no @font-face defines would print in a system font.
    const failed = new Set();
    const defined = new Set();
    for (const face of fonts) {
        const family = unquote(face.family);
        if (!ours.has(family)) continue;
        defined.add(family);
        if (face.status === 'error' || face.status === 'loading') {
            failed.add(`${family} ${face.weight}${face.style === 'italic' ? ' italic' : ''}`);
        }
    }
    const warnings = [];
    for (const name of [...failed].sort()) warnings.push(`Font ${name} did not load, so the PDF would print it in a fallback font.`);
    for (const u of uses.values()) {
        if (!defined.has(u.family)) {
            warnings.push(`Font ${u.family} is not defined, so the PDF would print it in a fallback font.`);
            defined.add(u.family);
        } else if (!failed.size && !fonts.check(fontSpec(u), u.text)) {
            warnings.push(`Font ${u.family} ${u.weight}${u.style === 'italic' ? ' italic' : ''} did not load in time, so the PDF would print it in a fallback font.`);
        }
    }
    return {warnings: [...new Set(warnings)], faces: uses.size, timedOut};
}
