/**
 * Parsing and validating a render request: content type, body, options.
 * Error messages name the option and the allowed values, never the value sent.
 */
import {ApiError} from './errors.mjs';
import {
    FITS, LAYOUTS, MARGIN_UNITS, PAGE_LIMITS, PAGE_SIZES, PAGE_UNITS, ORIENTATIONS, formatCustomSize,
    frontMatterPageOpts, normalizeExportOpts, pageOptsProblem, parseCustomSize, templatePageDefaults, templatePageSizes,
    validMargin,
} from '../../js/export-options.js';
import {LANG_RE, META_MAX_LENGTH} from '../../js/doc-meta.js';
import {DEFAULT_TEMPLATE, TEMPLATE_IDS, templateEntry} from './templates-info.mjs';
import {uncountedSpans} from './untrusted.mjs';

const MB = 1024 * 1024;

export const LIMITS = Object.freeze({
    /** Markdown text, not counting the payload of embedded data:image URIs. */
    markdownBytes: 2 * MB,
    /** The whole request body. */
    bodyBytes: 15 * MB,
    /** One embedded image (decoded). */
    imageBytes: 5 * MB,
});

const QUERY_KEYS = new Set(['template', 'pageSize', 'orientation', 'title', 'author', 'date', 'subject', 'lang', 'strict',
    'tidy', 'printLinks', 'cover', 'layout', 'fit', 'margin']);
const JSON_KEYS = new Set(['markdown', 'template', 'pageSize', 'orientation', 'meta', 'lang', 'strict', 'tidy', 'printLinks',
    'cover', 'layout', 'fit', 'margin']);
const META_FIELDS = ['title', 'author', 'date', 'subject'];
/** Options that are true or false, and their defaults (printLinks: none, so front matter `print-links` decides). */
const FLAGS = Object.freeze({strict: false, tidy: true, printLinks: undefined, cover: true});
const TEMPLATE_ID_RE = /^[a-z0-9_-]{1,40}$/i;

const invalid = (message) => new ApiError(400, 'invalid_option', message);

/**
 * Bytes of Markdown that count toward the 2 MB limit: the payloads the harness
 * takes out before parsing (src/untrusted.mjs uncountedSpans) are left out,
 * everything else counts. Linear time.
 */
export function markdownSize(markdown) {
    let size = Buffer.byteLength(markdown, 'utf8');
    for (const span of uncountedSpans(markdown)) size -= span.end - span.payloadStart; // base64 is ASCII
    return size;
}

function mediaType(contentType) {
    const [type, ...params] = String(contentType || '').split(';');
    const charset = params.map((p) => p.trim().toLowerCase()).find((p) => p.startsWith('charset='));
    return {type: type.trim().toLowerCase(), charset: charset ? charset.slice(8).replace(/"/g, '') : null};
}

function decodeUtf8(buffer) {
    try {
        return new TextDecoder('utf-8', {fatal: true}).decode(buffer);
    } catch {
        throw new ApiError(400, 'invalid_encoding', 'The body must be valid UTF-8.');
    }
}

const MAX_AREA_M2 = PAGE_LIMITS.maxAreaMm2 / 1e6;

/** A named size (any case) or a custom size, written back in its canonical form ("100x150mm"). */
function pageSizeOption(value) {
    const match = typeof value === 'string' && PAGE_SIZES.find((s) => s.toLowerCase() === value.toLowerCase());
    if (match) return match;
    const custom = formatCustomSize(parseCustomSize(value));
    if (!custom) {
        throw invalid(`pageSize must be one of ${PAGE_SIZES.join(', ')}, or a custom size such as 100x150mm `
            + `(${PAGE_UNITS.join(', ')}; each side ${PAGE_LIMITS.minSideMm} to ${PAGE_LIMITS.maxSideMm} mm, at most ${MAX_AREA_M2} square metres).`);
    }
    return custom;
}

function orientationOption(value) {
    const v = typeof value === 'string' ? value.toLowerCase() : '';
    if (!ORIENTATIONS.includes(v)) throw invalid(`orientation must be one of ${ORIENTATIONS.join(', ')}.`);
    return v;
}

function layoutOption(value) {
    const v = typeof value === 'string' ? value.toLowerCase() : '';
    if (!LAYOUTS.includes(v)) throw invalid(`layout must be ${LAYOUTS.join(' or ')}.`);
    return v;
}

function fitOption(value) {
    const v = typeof value === 'string' ? value.toLowerCase() : '';
    if (!FITS.includes(v)) throw invalid(`fit must be one of ${FITS.join(', ')}.`);
    return v;
}

function marginOption(value) {
    const v = typeof value === 'string' ? validMargin(value) : null;
    if (!v) throw invalid(`margin must be a length in ${MARGIN_UNITS.join(', ')} such as 12mm, 1.5cm, 0.5in or 0, up to about 100 mm.`);
    return v;
}

function templateOption(value) {
    if (typeof value !== 'string' || !TEMPLATE_ID_RE.test(value)) throw invalid('template must be a template id (see GET /api/v1/templates).');
    return value.toLowerCase();
}

function flagOption(name, value) {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string' && ['true', '1'].includes(value.toLowerCase())) return true;
    if (typeof value === 'string' && ['false', '0'].includes(value.toLowerCase())) return false;
    throw invalid(`${name} must be true or false.`);
}

/** strict, tidy, printLinks and cover: the value given, else the default. */
function flags(get) {
    const out = {};
    for (const [name, fallback] of Object.entries(FLAGS)) {
        const value = get(name) !== undefined ? flagOption(name, get(name)) : fallback;
        if (value !== undefined) out[name] = value;
    }
    return out;
}

function langOption(value) {
    if (typeof value !== 'string' || !LANG_RE.test(value)) throw invalid('lang must be a language tag such as en or en-GB.');
    return value;
}

function metaOption(name, value) {
    if (typeof value !== 'string') throw invalid(`${name} must be a string.`);
    if (Array.from(value).length > META_MAX_LENGTH) throw invalid(`${name} must be at most ${META_MAX_LENGTH} characters.`);
    return value;
}

/** Copy the page and template options that are present, validated. */
function commonOptions(get) {
    const out = {};
    if (get('template') !== undefined) out.template = templateOption(get('template'));
    if (get('pageSize') !== undefined) out.pageSize = pageSizeOption(get('pageSize'));
    if (get('orientation') !== undefined) out.orientation = orientationOption(get('orientation'));
    if (get('layout') !== undefined) out.layout = layoutOption(get('layout'));
    if (get('fit') !== undefined) out.fit = fitOption(get('fit'));
    if (get('margin') !== undefined) out.margin = marginOption(get('margin'));
    if (get('lang') !== undefined && get('lang') !== '') out.lang = langOption(get('lang'));
    return {...out, ...flags(get)};
}

function checkMarkdown(markdown) {
    if (typeof markdown !== 'string') throw invalid('markdown must be a string.');
    if (!markdown.trim()) throw new ApiError(400, 'empty_markdown', 'The Markdown is empty.');
    if (markdownSize(markdown) > LIMITS.markdownBytes) {
        throw new ApiError(413, 'markdown_too_large', 'The Markdown is larger than 2 MB (base64 image data URIs of 1 KB or more do not count).');
    }
    return markdown;
}

function fromQuery(markdown, query) {
    for (const key of new Set(query.keys())) {
        if (!QUERY_KEYS.has(key)) throw new ApiError(400, 'unknown_option', `Unknown query option. Allowed: ${[...QUERY_KEYS].join(', ')}.`);
        if (query.getAll(key).length > 1) throw invalid(`${key} is given more than once.`);
    }
    const get = (k) => (query.has(k) ? query.get(k) : undefined);
    const meta = {};
    for (const field of META_FIELDS) {
        if (get(field) !== undefined && get(field) !== '') meta[field] = metaOption(field, get(field));
    }
    return {
        markdown: checkMarkdown(markdown),
        ...commonOptions(get),
        meta,
    };
}

function fromJson(text) {
    let body;
    try {
        body = JSON.parse(text);
    } catch {
        throw new ApiError(400, 'invalid_json', 'The body is not valid JSON.');
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ApiError(400, 'invalid_json', 'The body must be a JSON object.');
    for (const key of Object.keys(body)) {
        if (!JSON_KEYS.has(key)) throw new ApiError(400, 'unknown_option', `Unknown field. Allowed: ${[...JSON_KEYS].join(', ')}.`);
    }
    if (body.markdown === undefined) throw invalid('markdown is required.');
    const get = (k) => (body[k] === null ? undefined : body[k]);
    const meta = {};
    if (get('meta') !== undefined) {
        if (typeof body.meta !== 'object' || Array.isArray(body.meta)) throw invalid('meta must be an object with title, author, date and subject.');
        for (const key of Object.keys(body.meta)) {
            if (!META_FIELDS.includes(key)) throw new ApiError(400, 'unknown_option', `Unknown meta field. Allowed: ${META_FIELDS.join(', ')}.`);
            const value = body.meta[key];
            if (value === null || value === '') continue;
            meta[key] = metaOption(`meta.${key}`, value);
        }
    }
    return {
        markdown: checkMarkdown(body.markdown),
        ...commonOptions(get),
        meta,
    };
}

/**
 * @param {{contentType: string, query: URLSearchParams, body: Buffer}} req
 * @returns {{markdown: string, template?: string, pageSize?: string, orientation?: string, lang?: string,
 *            meta: {title?: string, author?: string, date?: string, subject?: string},
 *            strict: boolean, tidy: boolean, printLinks: boolean, cover: boolean,
 *            layout?: string, fit?: string, margin?: string}}
 *          pageSize: a named size or a custom size in its canonical form ("100x150mm"); margin: in its canonical form
 */
export function parseRenderRequest({contentType, query, body}) {
    const {type, charset} = mediaType(contentType);
    if (charset && charset !== 'utf-8' && charset !== 'utf8') {
        throw new ApiError(415, 'unsupported_media_type', 'Only UTF-8 is accepted.');
    }
    // Only types a web page cannot send with a plain form post (text/plain,
    // urlencoded and multipart are refused), so a cross-site form cannot render.
    if (type === 'text/markdown') {
        return fromQuery(decodeUtf8(body), query);
    }
    if (type === 'application/json') {
        if ([...query.keys()].length) throw new ApiError(400, 'unknown_option', 'With a JSON body, put the options in the JSON, not the query string.');
        return fromJson(decodeUtf8(body));
    }
    throw new ApiError(415, 'unsupported_media_type', 'Send text/markdown (options in the query string) or application/json.');
}

/**
 * The template to use: the request option, else the front matter's, else the default.
 * An unknown template in the request is an error (404); an unknown one in the
 * front matter is a warning and the default is used.
 * @returns {{templateId: string, warnings: string[]}}
 */
export function resolveTemplate(options, frontMatter) {
    if (options.template !== undefined) {
        if (!TEMPLATE_IDS.includes(options.template)) throw new ApiError(404, 'unknown_template', 'Unknown template (see GET /api/v1/templates).');
        return {templateId: options.template, warnings: []};
    }
    const fm = typeof frontMatter.template === 'string' ? frontMatter.template.toLowerCase() : '';
    if (fm && TEMPLATE_IDS.includes(fm)) return {templateId: fm, warnings: []};
    if (fm) return {templateId: DEFAULT_TEMPLATE, warnings: [`The front matter names an unknown template, so ${DEFAULT_TEMPLATE} was used.`]};
    return {templateId: DEFAULT_TEMPLATE, warnings: []};
}

/**
 * A page size the template does not offer (manifest.page.sizes, js/export-options.js
 * templatePageSizes; the Slide size only for templates that list it) is a 400. A custom
 * size is allowed with every template.
 * @param {{pageSize?: string}} options
 * @param {string} templateId  a known template
 */
export function checkPageSize(options, templateId) {
    if (options.pageSize === undefined || parseCustomSize(options.pageSize)) return;
    const entry = templateEntry(templateId);
    const sizes = templatePageSizes(entry && entry.manifest);
    if (!sizes.includes(options.pageSize)) {
        throw invalid(`This template offers pageSize ${sizes.join(', ')}, or a custom size (see GET /api/v1/templates).`);
    }
}

/**
 * Page options that are each valid but do not go together are a 400: fit=widest without the
 * continuous layout, and a margin that leaves the text less than PAGE_LIMITS.minContentMm. What the
 * request leaves out comes from the front matter, then the template, as the render takes it
 * (js/export-pipeline.js); a combination made only by the front matter is not refused here (the
 * render reduces the margin and says so).
 * @param {{pageSize?: string, orientation?: string, layout?: string, fit?: string, margin?: string}} options
 * @param {string} templateId  a known template
 * @param {object} frontMatter  parseFrontMatter's meta
 */
export function checkPageOptions(options, templateId, frontMatter) {
    const fm = frontMatterPageOpts(frontMatter).opts;
    const layout = options.layout ?? fm.layout ?? 'paged';
    if (options.fit === 'widest' && layout !== 'continuous') throw invalid('fit=widest needs layout=continuous.');
    if (options.pageSize === undefined && options.margin === undefined && options.layout === undefined) return;
    const entry = templateEntry(templateId);
    const page = (entry && entry.manifest && entry.manifest.page) || {};
    const opts = normalizeExportOpts({
        pageSize: options.pageSize ?? fm.pageSize, orientation: options.orientation, layout, margin: options.margin ?? fm.margin,
    }, {margin: page.margin, sizes: templatePageSizes(entry && entry.manifest), ...templatePageDefaults(entry && entry.manifest)});
    if (pageOptsProblem(opts)) {
        throw invalid(`margin leaves less than ${PAGE_LIMITS.minContentMm} mm of page for the text: use a smaller margin or a larger pageSize.`);
    }
}
