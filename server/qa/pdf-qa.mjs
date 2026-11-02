#!/usr/bin/env node
/**
 * server/qa/pdf-qa.mjs: the print-quality checks for a finished PDF, with
 * poppler-utils (pdffonts, pdfimages, pdfinfo, pdftotext), each run with
 * execFile and an argument array. Importable (checkPdf) and runnable:
 *
 *   node server/qa/pdf-qa.mjs file.pdf [--strict] [--cover] [--size A4|A3|A5|Letter|Legal|Slide|100x150mm]
 *        [--landscape] [--continuous] [--images N] [--forbid word]... [--json]
 *
 *   --strict     warnings fail too (the nearly empty last page)
 *   --cover      page 1 is a full-bleed cover: its text may reach the edge
 *   --size       the page size every page must have (default: any one known size, the same on every page):
 *                a named size, or a custom one as the API takes it (100x150mm, 8.5x11in, 1200x800px)
 *   --landscape  with a named --size: the landscape orientation (Slide, 254 x 142.9 mm, is landscape either way)
 *   --continuous the one continuous page layout: every page has the width of --size (or of page 1) and
 *                any height; the last-page check does not apply
 *   --images     the most raster images the PDF may hold: the document's own (a template's styles
 *                must add none; a blurred shadow, a filter or backdrop-filter prints as images)
 *   --forbid     a string the PDF must not contain (repeatable; replaces the default list)
 *   --json       print the result as JSON
 *   (--size and --forbid need a value: a missing or empty one, or another option in its place, is exit 2)
 *
 * Exit code 0 when every check passes, 1 when one fails, 2 on a usage error or
 * a missing tool.
 *
 * Checks (README, Print quality):
 *   fonts-embedded  every font is embedded
 *   no-type3        no Type 3 font, except unnamed glyph sets when the text holds emoji
 *                   (Chromium prints colour emoji from the system font as Type 3)
 *   vendored-fonts  every font is one of ours (js/fonts.js FONT_FAMILIES), by family-name prefix
 *                   (isVendoredFontName: Fontsource files name some faces oddly, "FigtreeLight-Bold")
 *   image-ppi       every raster image is 150 ppi or more at the size it prints
 *   raster-images   with --images N (maxImages): at most N raster images, so styles added none
 *   tagged          the PDF is tagged
 *   title           the document information has a title
 *   language        the catalog names a language (/Lang)
 *   outline         a document with headings has bookmarks
 *   page-size       every page has the expected size (--continuous: the expected width)
 *   margin          no text within 8 mm of a page edge (a full-bleed cover excepted)
 *   last-page       the last page is not nearly empty (45 words or fewer) [warning]
 *   bottom-space    --continuous only: the last page ends with at most 60 mm of blank below the content
 *                   (its margin plus 40 mm when the margin, read from the text's left edge, is wider)
 *   forbidden       none of the forbidden strings (default: localhost, 127.0.0.1, ddev.site, file://)
 */
import {execFile} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {promisify} from 'node:util';
import {pathToFileURL} from 'node:url';
import {FONT_FAMILIES} from '../../js/fonts.js';
import {PAGE_SIZES, pageDimensionsMm, parseCustomSize} from '../../js/export-options.js';

const run = promisify(execFile);
const TOOLS = ['pdffonts', 'pdfimages', 'pdfinfo', 'pdftotext', 'pdftoppm'];

export const DEFAULT_FORBIDDEN = Object.freeze(['localhost', '127.0.0.1', 'ddev.site', 'file://']);
export const MIN_PPI = 150;
export const MARGIN_BAND_MM = 8;
/** A last page with this many words or fewer is nearly empty (as the API's tidy, server/src/renderer.mjs TIDY). */
export const NEARLY_EMPTY_WORDS = 45;

const PT_PER_MM = 72 / 25.4;
/** Emoji that print as colour pictures (😀 ✅), not the dingbats our symbol fonts cover (★ ⚙ ✔). */
const EMOJI_RE = /\p{Emoji_Presentation}|️/u;

async function tool(name, args) {
    const {stdout} = await run(name, args, {maxBuffer: 256 * 1024 * 1024, encoding: 'utf8'});
    return stdout;
}

/** A continuous page may end with this much blank (more when its margin is wider than 20 mm). */
export const BOTTOM_SPACE_MM = 60;
const RASTER_DPI = 20;

/**
 * The blank height in mm at the foot of a page: the page drawn in grey at 20 dpi (pdftoppm), then the
 * rows from the bottom up that match the bottom row's colour (the page's background, whatever it is).
 * @returns {Promise<number|null>}  null when the page cannot be drawn
 */
export async function bottomBlankMm(file, page) {
    let pgm;
    try {
        ({stdout: pgm} = await run('pdftoppm', ['-gray', '-r', String(RASTER_DPI), '-f', String(page), '-l', String(page), file],
            {maxBuffer: 256 * 1024 * 1024, encoding: 'buffer'}));
    } catch {
        return null;
    }
    const head = /^P5\s+(\d+)\s+(\d+)\s+(\d+)\s/.exec(pgm.subarray(0, 64).toString('latin1'));
    if (!head) return null;
    const [width, height] = [Number(head[1]), Number(head[2])];
    const data = pgm.subarray(head[0].length);
    const row = (y) => data.subarray(y * width, (y + 1) * width);
    const sorted = [...row(height - 1)].sort((a, b) => a - b);
    const background = sorted[Math.floor(sorted.length / 2)];
    let y = height - 1;
    while (y >= 0 && row(y).every((v) => Math.abs(v - background) <= 24)) y--;
    return Math.round(((height - 1 - y) / RASTER_DPI) * 25.4);
}

/** Whether every poppler tool the checks need is on PATH. */
export async function qaToolsAvailable() {
    try {
        await Promise.all(TOOLS.map((t) => run(t, ['-v'])));
        return true;
    } catch {
        return false;
    }
}

/** pdffonts rows {name, type, embedded}: columns cut at the dashed header's widths (a type can hold spaces). */
export function parsePdfFonts(out) {
    const [, dashes = '', ...rows] = out.split('\n');
    const cols = [...dashes.matchAll(/-+/g)].map((m) => [m.index, m.index + m[0].length]);
    return rows.filter((r) => r.trim()).map((row) => {
        const [name, type, , emb] = cols.map(([a, b]) => row.slice(a, b).trim());
        return {name: name.replace(/^[A-Z]{6}\+/, ''), type, embedded: emb === 'yes'};
    });
}

/** pdfimages -list rows of type "image" (soft masks left out): {page, width, height, xppi, yppi}. */
export function parsePdfImages(out) {
    return out.split('\n').slice(2).map((l) => l.trim().split(/\s+/)).filter((c) => c[2] === 'image')
        .map((c) => ({page: Number(c[0]), width: Number(c[3]), height: Number(c[4]), xppi: Number(c[12]), yppi: Number(c[13])}));
}

/** pdftotext -bbox pages: [{width, height, words: [{xMin, yMin, xMax, yMax, text}]}]. */
export function parseBbox(html) {
    const pages = [];
    for (const page of html.split('<page ').slice(1)) {
        const size = /width="([\d.]+)" height="([\d.]+)"/.exec(page);
        const words = [...page.matchAll(/<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([^<]*)<\/word>/g)]
            .map((m) => ({xMin: Number(m[1]), yMin: Number(m[2]), xMax: Number(m[3]), yMax: Number(m[4]), text: m[5]}));
        pages.push({width: Number(size[1]), height: Number(size[2]), words});
    }
    return pages;
}

const familyKey = (name) => name.replace(/\s+/g, '');

/**
 * Whether a PDF font name (subset prefix already removed) is one of the vendored
 * families. A PDF names a font by its PostScript name, which starts with the family
 * name without spaces but may go on in its own way: "Inter-Italic", "SourceCodePro-It",
 * "MontserratThin-Bold", and for Fontsource builds whose every weight carries one
 * internal name, "FigtreeLight-Bold" (a bold Figtree), "DMSans9pt-Regular" (DM Sans's
 * optical size) or "Fraunces72pt-SemiBold". So the match is by family prefix, letters
 * compared without spaces or case.
 * @param {string} name  e.g. "FigtreeLight-Bold"
 * @param {readonly string[]} [families]  CSS family names (js/fonts.js FONT_FAMILIES)
 */
export function isVendoredFontName(name, families = FONT_FAMILIES) {
    const key = familyKey(String(name || '')).toLowerCase();
    return families.some((fam) => key.startsWith(familyKey(fam).toLowerCase()));
}

/**
 * @param {string} file  path of the PDF
 * @param {{strict?: boolean, cover?: boolean, pageSize?: string, orientation?: string, continuous?: boolean,
 *          forbidden?: string[], families?: readonly string[], maxImages?: number}} [opts]
 *        pageSize: a named size or a custom one ("100x150mm"); continuous: the one continuous page layout
 *        (the width is checked, not the height; no last-page check);
 *        maxImages: the document's own raster images; more means the styles made some (blur, filters)
 * @returns {Promise<{ok: boolean, file: string, pages: number,
 *          checks: {id: string, ok: boolean, level: 'error'|'warning', detail: string}[]}>}
 */
export async function checkPdf(file, opts = {}) {
    const {strict = false, cover = false, pageSize, orientation = 'portrait', continuous = false, forbidden = DEFAULT_FORBIDDEN,
        families = FONT_FAMILIES, maxImages} = opts;
    const checks = [];
    const add = (id, ok, detail, level = 'error') => checks.push({id, ok, level, detail});

    const raw = (await readFile(file)).toString('latin1');
    const info = await tool('pdfinfo', [file]);
    const pages = Number((/^Pages:\s+(\d+)/m.exec(info) || [])[1] || 0);
    const [fontsOut, imagesOut, boxOut, structOut, text, bbox] = await Promise.all([
        tool('pdffonts', [file]),
        tool('pdfimages', ['-list', file]),
        tool('pdfinfo', ['-box', '-f', '1', '-l', String(Math.max(1, pages)), file]),
        tool('pdfinfo', ['-struct', file]).catch(() => ''),
        tool('pdftotext', ['-enc', 'UTF-8', file, '-']),
        tool('pdftotext', ['-bbox', '-enc', 'UTF-8', file, '-']),
    ]);

    // Fonts.
    const fonts = parsePdfFonts(fontsOut);
    const unembedded = fonts.filter((f) => !f.embedded);
    add('fonts-embedded', unembedded.length === 0,
        unembedded.length ? `not embedded: ${[...new Set(unembedded.map((f) => f.name))].join(', ')}` : `${fonts.length} fonts, all embedded`);
    const type3 = fonts.filter((f) => f.type === 'Type 3');
    const emoji = EMOJI_RE.test(text);
    const badType3 = type3.filter((f) => !(emoji && f.name === '[none]'));
    add('no-type3', badType3.length === 0, badType3.length
        ? `Type 3 fonts: ${badType3.map((f) => f.name).join(', ')}${emoji ? '' : ' (the text has no emoji)'}`
        : (type3.length ? `${type3.length} Type 3 glyph sets, for emoji only` : 'none'));
    const foreign = fonts.filter((f) => f.type !== 'Type 3' && !isVendoredFontName(f.name, families));
    add('vendored-fonts', foreign.length === 0,
        foreign.length ? `not ours: ${[...new Set(foreign.map((f) => f.name))].join(', ')}` : 'only vendored families');

    // Images.
    const images = parsePdfImages(imagesOut);
    const soft = images.filter((img) => Math.min(img.xppi, img.yppi) < MIN_PPI);
    add('image-ppi', soft.length === 0, soft.length
        ? soft.map((img) => `page ${img.page}: ${img.width}x${img.height} at ${Math.min(img.xppi, img.yppi)} ppi`).join('; ')
        : `${images.length} raster images, all ${MIN_PPI} ppi or more`);
    if (Number.isInteger(maxImages) && maxImages >= 0) {
        const pagesWith = [...new Set(images.map((img) => img.page))];
        add('raster-images', images.length <= maxImages, images.length <= maxImages
            ? `${images.length} raster images, at most ${maxImages} expected`
            : `${images.length} raster images where the document has ${maxImages} (pages ${pagesWith.join(', ')}): a blurred `
              + 'shadow, a filter or backdrop-filter prints as images');
    }

    // Document.
    add('tagged', /^Tagged:\s+yes/m.test(info), /^Tagged:\s+(\S+)/m.exec(info)?.[1] || 'not reported');
    // Chromium names a page without a <title> after its address (about:blank, a URL); "Untitled" is our own stand-in.
    const title = ((/^Title:\s+(.*)$/m.exec(info) || [])[1] || '').trim();
    const placeholder = !title || /^(?:about:blank|untitled)$/i.test(title) || /^[a-z][a-z0-9+.-]*:\/\//i.test(title);
    add('title', !placeholder, title ? `"${title}"${placeholder ? ' (an address or stand-in, not a title)' : ''}` : 'no title');
    const lang = /\/Lang\s*\(([^)]*)\)/.exec(raw);
    add('language', Boolean(lang && lang[1]), lang ? lang[1] : 'no /Lang in the catalog');
    const headings = /^\s*H[1-6]? \(block\)/m.test(structOut);
    const outline = /\/Outlines\s+\d+\s+\d+\s+R/.test(raw);
    add('outline', !headings || outline, headings ? (outline ? 'bookmarks from the headings' : 'headings but no bookmarks') : 'no headings');

    // Page size.
    const boxes = [...boxOut.matchAll(/^Page\s+(\d+)\s+MediaBox:\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)/gm)]
        .map((m) => ({page: Number(m[1]), width: Number(m[4]) - Number(m[2]), height: Number(m[5]) - Number(m[3])}));
    const near = (a, b) => Math.abs(a - b) <= 1.5;
    let expected;
    const custom = pageSize ? parseCustomSize(pageSize) : null;
    if (custom) {
        expected = {width: custom.widthMm * PT_PER_MM, height: custom.heightMm * PT_PER_MM, label: pageSize};
    } else if (pageSize) {
        const d = pageDimensionsMm(pageSize, orientation);
        expected = {width: d.width * PT_PER_MM, height: d.height * PT_PER_MM, label: `${pageSize} ${orientation}`};
    } else if (continuous && boxes.length) {
        expected = {width: boxes[0].width, label: 'the first page'};
    } else if (boxes.length) {
        const known = PAGE_SIZES.flatMap((s) => ['portrait', 'landscape'].map((o) => {
            const d = pageDimensionsMm(s, o);
            return {width: d.width * PT_PER_MM, height: d.height * PT_PER_MM, label: `${s} ${o}`};
        }));
        expected = known.find((k) => near(k.width, boxes[0].width) && near(k.height, boxes[0].height));
    }
    // The continuous layout: every page the expected width, any height.
    const offSize = boxes.filter((b) => !expected || !near(b.width, expected.width) || (!continuous && !near(b.height, expected.height)));
    const widthMm = expected ? Math.round((expected.width / PT_PER_MM) * 10) / 10 : 0;
    add('page-size', boxes.length === pages && pages > 0 && offSize.length === 0, offSize.length || !expected
        ? `pages off size: ${offSize.map((b) => `${b.page} (${b.width.toFixed(1)}x${b.height.toFixed(1)} pt)`).join(', ') || 'no known size'}`
        : (continuous ? `${pages} continuous ${pages === 1 ? 'page' : 'pages'}, ${widthMm} mm wide` : `${pages} pages, ${expected.label}`));

    // Margin band: no text within MARGIN_BAND_MM of an edge, the cover excepted.
    const band = MARGIN_BAND_MM * PT_PER_MM;
    const inBand = [];
    parseBbox(bbox).forEach((p, i) => {
        if (cover && i === 0) return;
        for (const w of p.words) {
            if (w.xMin < band || w.yMin < band || w.xMax > p.width - band || w.yMax > p.height - band) inBand.push(`page ${i + 1}: "${w.text}"`);
        }
    });
    add('margin', inBand.length === 0, inBand.length ? `text within ${MARGIN_BAND_MM} mm of the edge: ${inBand.slice(0, 5).join('; ')}`
        + (inBand.length > 5 ? ` and ${inBand.length - 5} more` : '') : `nothing within ${MARGIN_BAND_MM} mm of an edge`);

    // Last page.
    const bodyPages = pages - (cover ? 1 : 0);
    const lastText = pages ? await tool('pdftotext', ['-f', String(pages), '-l', String(pages), '-enc', 'UTF-8', file, '-']) : '';
    const lastWords = lastText.split(/\s+/).filter(Boolean).length;
    add('last-page', continuous || bodyPages <= 1 || lastWords > NEARLY_EMPTY_WORDS, continuous
        ? 'continuous: no last page to check'
        : `${lastWords} words on page ${pages}${bodyPages > 1 && lastWords <= NEARLY_EMPTY_WORDS ? ' (nearly empty)' : ''}`, 'warning');

    // Continuous: the page ends with its margin, not a blank strip (a height measured too tall).
    if (continuous && pages) {
        const blank = await bottomBlankMm(file, pages);
        const words = parseBbox(bbox)[pages - 1]?.words || [];
        // The margin, read from the text's left edge, and room for the last block's spacing.
        const inset = words.length ? Math.min(...words.map((w) => w.xMin)) / PT_PER_MM : 0;
        const limit = Math.round(Math.max(BOTTOM_SPACE_MM, inset + BOTTOM_SPACE_MM - 20));
        add('bottom-space', blank !== null && blank <= limit, blank === null
            ? 'the last page could not be read'
            : `${blank} mm blank below the content (at most ${limit} mm: the margin and the last block's spacing)`);
    }

    // Forbidden strings, in the text and in the file (link addresses).
    const lowerText = text.toLowerCase();
    const lowerRaw = raw.toLowerCase();
    const found = forbidden.filter((s) => s && (lowerText.includes(s.toLowerCase()) || lowerRaw.includes(s.toLowerCase())));
    add('forbidden', found.length === 0, found.length ? `found: ${found.join(', ')}` : `none of ${forbidden.length}`);

    const failed = checks.filter((c) => !c.ok && (c.level === 'error' || strict));
    return {ok: failed.length === 0, file, pages, checks};
}

/** The result as lines of text, one per check. */
export function formatResult(result) {
    const lines = result.checks.map((c) => `${c.ok ? 'PASS' : (c.level === 'warning' ? 'WARN' : 'FAIL')}  ${c.id.padEnd(15)} ${c.detail}`);
    return [`${result.ok ? 'PASS' : 'FAIL'}  ${result.file} (${result.pages} pages)`, ...lines].join('\n');
}

function parseArgs(argv) {
    const opts = {forbidden: null};
    const files = [];
    // An option's value is the next argument, which must exist, be non-empty and not be another option.
    const value = (i, name) => {
        const v = argv[i];
        if (v === undefined || v === '' || v.startsWith('--')) throw new Error(`${name} needs a value`);
        return v;
    };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--strict') opts.strict = true;
        else if (a === '--cover') opts.cover = true;
        else if (a === '--landscape') opts.orientation = 'landscape';
        else if (a === '--continuous') opts.continuous = true;
        else if (a === '--json') opts.json = true;
        else if (a === '--size') opts.pageSize = value(++i, '--size');
        else if (a === '--images') {
            const n = value(++i, '--images');
            if (!/^\d{1,4}$/.test(n)) throw new Error('--images needs a whole number');
            opts.maxImages = Number(n);
        }
        else if (a === '--forbid') (opts.forbidden ||= []).push(value(++i, '--forbid'));
        else if (a.startsWith('--')) throw new Error(`unknown option ${a}`);
        else files.push(a);
    }
    if (files.length !== 1) throw new Error('give one PDF file');
    if (opts.pageSize && !PAGE_SIZES.includes(opts.pageSize) && !parseCustomSize(opts.pageSize)) {
        throw new Error(`--size must be one of ${PAGE_SIZES.join(', ')} or a custom size such as 100x150mm`);
    }
    if (opts.forbidden === null) delete opts.forbidden;
    return {file: files[0], opts};
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    let args;
    try {
        args = parseArgs(process.argv.slice(2));
    } catch (e) {
        console.error(`pdf-qa: ${e.message}\nUsage: node server/qa/pdf-qa.mjs file.pdf [--strict] [--cover] [--size A4|Slide|100x150mm|...] [--landscape] [--continuous] [--images N] [--forbid word]... [--json]`);
        process.exit(2);
    }
    if (!(await qaToolsAvailable())) {
        console.error(`pdf-qa: needs ${TOOLS.join(', ')} (poppler-utils) on PATH`);
        process.exit(2);
    }
    const result = await checkPdf(args.file, args.opts);
    console.log(args.opts.json ? JSON.stringify(result, null, 2) : formatResult(result));
    process.exit(result.ok ? 0 : 1);
}
