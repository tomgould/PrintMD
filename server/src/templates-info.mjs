/**
 * The templates the API offers, from the app's own registry (js/templates.js,
 * which reads the manifests in templates/ through js/template-registry.js), so
 * the API and the editor always list the same ones. The render page in
 * Chromium reads the same manifests (src/assets.mjs serves them).
 */
import {getTemplates, getTemplateById, getTemplateWarnings} from '../../js/templates.js';
import {
    FITS, LAYOUTS, MARGIN_UNITS, ORIENTATIONS, PAGE_LIMITS, PAGE_UNITS, templatePageDefaults, templatePageSizes,
} from '../../js/export-options.js';
import {RUNNING_LIMITS} from '../../js/page-chrome.js';

/**
 * The page options every template takes (README, PDF API options), with their limits: a custom
 * pageSize ("100x150mm"), layout, fit and a margin override.
 */
export const PAGE_OPTIONS = Object.freeze({
    customSize: {example: '100x150mm', units: [...PAGE_UNITS], minSideMm: PAGE_LIMITS.minSideMm,
        maxSideMm: PAGE_LIMITS.maxSideMm, maxAreaMm2: PAGE_LIMITS.maxAreaMm2},
    layouts: [...LAYOUTS],
    fits: [...FITS],
    fitMinScale: PAGE_LIMITS.fitMinScale,
    margin: {units: [...MARGIN_UNITS], maxMm: 100, minContentMm: PAGE_LIMITS.minContentMm,
        runningHeadMinMm: RUNNING_LIMITS.minMarginMm},
    continuous: {maxPageMm: PAGE_LIMITS.maxSideMm, maxTotalMm: PAGE_LIMITS.maxContinuousMm},
    maxPages: PAGE_LIMITS.maxPages,
});

/** The editor's default: the first entry in the registry. */
export const DEFAULT_TEMPLATE = getTemplates()[0].manifest.id;

export const TEMPLATE_IDS = Object.freeze(getTemplates().map((t) => t.manifest.id));

export function templateEntry(id) {
    return getTemplateById(id);
}

/** What the registry skipped (a broken layer or template), as fixed sentences; usually empty. */
export const TEMPLATE_WARNINGS = getTemplateWarnings();

/**
 * GET /api/v1/templates. "warnings" is there only when something was skipped, and "group" only for
 * a template whose manifest entry names one, so the usual answer is unchanged. A manifest entry's
 * "description" (js/template-registry.js) wins over the module's own. "defaultSize" and
 * "defaultOrientation" only for a template whose manifest.page names them (templatePageDefaults).
 * "pageSizes" are the named sizes a template offers; "pageOptions" (PAGE_OPTIONS) are the custom size,
 * layout, fit and margin limits, the same for every template.
 */
export function listTemplates() {
    return {
        ...(TEMPLATE_WARNINGS.length ? {warnings: [...TEMPLATE_WARNINGS]} : {}),
        default: DEFAULT_TEMPLATE,
        pageOptions: PAGE_OPTIONS,
        templates: getTemplates().map(({manifest, group, description}) => {
            const {pageSize, orientation} = templatePageDefaults(manifest);
            return {
                id: manifest.id,
                name: manifest.name,
                description: description || manifest.description,
                ...(group ? {group} : {}),
                version: manifest.version,
                margin: manifest.page && manifest.page.margin,
                pageSizes: [...templatePageSizes(manifest)],
                orientations: [...ORIENTATIONS],
                ...(pageSize ? {defaultSize: pageSize} : {}),
                ...(orientation ? {defaultOrientation: orientation} : {}),
            };
        }),
    };
}
