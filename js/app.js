/**
 * app.js
 * Main application entry point for PrintMD.
 */

import {configureMarked} from './markdown.js';
import {applyTemplate, getTemplateById, getTemplates} from './templates.js';
import {pickerGroups} from './template-registry.js';
import {exportPDF} from './pdf-export.js';
import {countWordImages, exportDocx, wordImagesNote} from './docx-export.js';
import {exportPptx} from './pptx-export.js';
import {importFromPicker, importFromUrl, parseGoogleUrl} from './google-drive-import.js';
import {createDocManager} from './docmanager.js';
import * as idbStore from './store.js';
import {safeGet, safeSet, safeRemove, safeGetJSON} from './safe-storage.js';
import {importFile, runImport} from './imports.js';
import {createDiskSync} from './disk-sync.js';
import {createChoiceDialog, createConflictDialog} from './conflict-dialog.js';
import {createPasswordDialog} from './password-dialog.js';
import {createPreflightDialog} from './preflight-dialog.js';
import {openModal} from './dialog-a11y.js';
import {createEditorFormat} from './editor-format.js';
import {appCommands, createCommandPalette} from './palette.js';
import {createSidebar, initSidebarCollapse} from './sidebar.js';
import {copyText} from './copy-text.js';
import {initKeyboardShortcuts, isMacPlatform, newDocShortcutLabel, recentShortcutLabel} from './shortcuts.js';
import {
    CUSTOM_SIZE, LANDSCAPE_ONLY, docExportOpts, frontMatterPageOpts, normalizeExportOpts, pageBoxMm, pageOptsProblem,
    templatePageDefaults, templatePageSizes, validMargin, validPageBackground,
} from './export-options.js';
import {createPageOptionsDialog} from './page-options-dialog.js';
import {extractTitle, parseFrontMatter} from './doc-meta.js';
import {prepareExport} from './export-pipeline.js';
import {previewImageWarnings} from './image-check.js';
import {EDITION, hostedNoticeVisible} from './edition.js';
import {sampleMarkdown} from './sample.js';

// Export choices (format, page size, orientation, and the page options: custom size, layout, fit,
// margin) belong to each document: its record's exportOpts (js/docmanager.js). The open document's
// choices are `exportChoices`, set when a document is loaded and when the user changes one.
// EXPORT_OPTS_KEY holds the last used format, size, orientation and custom size, written on every
// change: a document with no stored choices yet, and the first one of a new profile, start from it.
// Layout, fit and margin are the document's own only, so a new document starts on pages, with fit
// off and the template's margin. They end up in print CSS, so every read and write goes through
// normalizeExportOpts and docExportOpts (allow-lists, defaults for anything else).
const EXPORT_OPTS_KEY = 'printmd-export-opts';
/** The page options a document keeps only when it has chosen them. */
const PAGE_OPTION_KEYS = ['customSize', 'layout', 'fit', 'margin'];
/** What the last used choices carry to a new document. */
const SEED_KEYS = ['format', 'pageSize', 'orientation', 'customSize'];
const seedOf = (choices) => Object.fromEntries(SEED_KEYS.filter((k) => choices && choices[k] !== undefined).map((k) => [k, choices[k]]));
/** The last-used choices as stored (untrusted: always normalised before use). */
function storedExportOpts() {
    const stored = safeGetJSON(EXPORT_OPTS_KEY, null);
    return stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
}
/** Clean choices: format and page size allow-listed, the orientation as chosen, the page options when valid. */
function cleanChoices(opts) {
    const {format, pageSize} = normalizeExportOpts(opts);
    // The orientation as chosen, so leaving a landscape-only size (Slide) gives it back.
    const {orientation} = normalizeExportOpts({orientation: opts && opts.orientation});
    const own = docExportOpts(opts) || {};
    const out = {format, pageSize, orientation};
    for (const key of PAGE_OPTION_KEYS) if (own[key] !== undefined) out[key] = own[key];
    return out;
}
/** The open document's choices; until one is loaded, the last used. */
let exportChoices = cleanChoices(seedOf(storedExportOpts()));
function loadExportOpts() {
    return normalizeExportOpts(exportChoices);
}
/**
 * The user changed a choice: it is the open document's now and, once the document has it
 * stored, the last used, so a failed write and a reload never disagree. A failure is
 * reported by io.onSaveError, like a text save; the choice stays on screen.
 */
function chooseExportOpts(opts) {
    const choices = cleanChoices(opts);
    exportChoices = choices;
    docManager.saveExportOpts(choices).then((record) => {
        if (record) safeSet(EXPORT_OPTS_KEY, JSON.stringify(seedOf(choices)));
    }, () => {});
}
/** A document was loaded: its stored choices (cleaned by js/docmanager.js), else the last used. */
function applyDocExportOpts(stored) {
    exportChoices = cleanChoices({...seedOf(storedExportOpts()), ...(stored || {})});
    syncPageControls();
}
/** The template's own margin, validated (the margin used when the document sets none). */
function templateMargin() {
    const page = currentTemplateEntry && currentTemplateEntry.manifest && currentTemplateEntry.manifest.page;
    return validMargin(page && page.margin) || '20mm';
}
/** The open document's choices for the current template: the page sizes it offers and its margin, validated. */
function exportOptsForTemplate() {
    const manifest = currentTemplateEntry && currentTemplateEntry.manifest;
    return normalizeExportOpts(exportChoices, {margin: templateMargin(), sizes: templatePageSizes(manifest)});
}
/**
 * What prepareExport() gets: the size and format as on screen, and only the page options the
 * document chose, so its front matter (page-size aside: the Size select always has one) and the
 * template's margin still apply to the rest (js/export-pipeline.js).
 */
function exportRequest() {
    const o = exportOptsForTemplate();
    const request = {format: o.format, pageSize: o.pageSize, orientation: o.orientation};
    if (o.customSize) request.customSize = o.customSize;
    for (const key of ['layout', 'fit', 'margin']) if (exportChoices[key] !== undefined) request[key] = exportChoices[key];
    return request;
}

/**
 * The Size, Page and As selects for the open document and the current template: only
 * the sizes the template offers (a size it lacks, such as Slide, is hidden and A4 is
 * used; Custom size is always there), the orientation fixed for a landscape-only size and
 * a custom one, the Page options button's mark, and the preview page to match.
 */
function syncPageControls() {
    const o = exportOptsForTemplate();
    const sizes = templatePageSizes(currentTemplateEntry && currentTemplateEntry.manifest);
    const paperSel = byId('export-paper-size');
    const orientationSel = byId('export-orientation');
    const formatSel = byId('export-format');
    if (formatSel) formatSel.value = o.format;
    if (paperSel) {
        for (const option of Array.from(paperSel.options)) {
            option.disabled = option.value !== CUSTOM_SIZE && !sizes.includes(option.value);
            option.hidden = option.disabled;
        }
        paperSel.value = o.pageSize;
    }
    if (orientationSel) {
        // A custom size prints exactly as given: the locked Page menu shows its shape, not the stored choice.
        const box = pageBoxMm(o);
        orientationSel.value = o.pageSize === CUSTOM_SIZE ? (box.width > box.height ? 'landscape' : 'portrait') : o.orientation;
        orientationSel.disabled = LANDSCAPE_ONLY.includes(o.pageSize) || o.pageSize === CUSTOM_SIZE;
    }
    const optionsBtn = byId('btn-page-options');
    if (optionsBtn) {
        const set = [];
        if (o.pageSize === CUSTOM_SIZE) set.push(`custom size ${o.customSize}`);
        if (o.layout === 'continuous') set.push('one continuous page');
        if (o.fit !== 'off') set.push(o.fit === 'widest' ? 'fit widest' : 'fit width');
        if (exportChoices.margin !== undefined) set.push(`margin ${o.margin}`);
        optionsBtn.classList.toggle('active', set.length > 0);
        optionsBtn.title = set.length ? `Page options: ${set.join(', ')}` : 'Page options: custom size, one continuous page, fit to size, margin';
    }
    applyPreviewPageSize(o);
}

const MM_TO_PX = 96 / 25.4;  // 1mm at 96dpi

// New is Alt+N, or Ctrl+Option+N on macOS (Option+N types accents there).
const IS_MAC = isMacPlatform(typeof navigator !== 'undefined' ? navigator : null);
const NEW_DOC_SHORTCUT = newDocShortcutLabel(IS_MAC);

// The welcome document (js/sample.js), with this platform's New shortcut.
const SAMPLE_MARKDOWN = sampleMarkdown(NEW_DOC_SHORTCUT, recentShortcutLabel(IS_MAC));

// ─── State ───────────────────────────────────────────────────────────────────

let currentSource = '';
let autosaveTimer = null;
let previewDebounceTimer = null;
let currentTemplateEntry = null;
/** The applied template's id; before one is applied, the registry's default (the first). */
const currentTemplateId = () => (currentTemplateEntry || getTemplates()[0]).manifest.id;

// ─── DOM refs ────────────────────────────────────────────────────────────────

// Every element with an id in index.html, looked up once while the page holds
// only the app's own markup (this module runs before any Markdown is rendered).
// Rendered documents carry ids too. The sanitiser gives any id equal to an app
// element id an "h-" prefix (`## Editor` -> id="h-editor", APP_ELEMENT_IDS in
// js/markdown.js), and byId() stays as a second guard: always use byId(),
// never document.getElementById.
const DOM = new Map();
for (const el of document.querySelectorAll('[id]')) {
    if (!DOM.has(el.id)) DOM.set(el.id, el);
}

/** The app's own element with this id (cached at startup), or null. */
function byId(id) {
    return DOM.get(id) || null;
}

const editor = byId('editor');
const preview = byId('preview');
const templateSelect = byId('template-select');
const wordCountEl = byId('word-count');
const readTimeEl = byId('read-time');
const autosaveEl = byId('autosave-status');
const main = byId('main');
const editorPane = byId('editor-pane');
const previewPane = byId('preview-pane');
const divider = byId('divider');
const fileInput = byId('file-input');
const imageInput = byId('image-input');
const pdfInput = byId('pdf-input');
const docxInput = byId('docx-input');
const htmlInput = byId('html-input');
const epubInput = byId('epub-input');
const btnTheme = byId('btn-theme');

// ─── Utilities ───────────────────────────────────────────────────────────────

function debounce(fn, ms) {
    let t;
    return (...args) => {
        clearTimeout(t);
        t = setTimeout(() => fn(...args), ms);
    };
}

// Toolbar formatting, Bold / Italic, image snippets and the editor's own keys (js/editor-format.js).
const format = createEditorFormat({
    editor,
    onChange: () => triggerUpdate(),
    pickImage: () => imageInput.click(),
});

/**
 * Prefix for every id the app creates at run time (today: the palette options).
 * Documents may carry raw HTML ids and the preview sits before the app's own
 * overlays in the page, so a guessable id could be copied by a document and win
 * an id lookup (aria-activedescendant). 64 random bits per page load cannot be
 * guessed. crypto.getRandomValues works on plain http too (randomUUID does not).
 */
const RUNTIME_ID_PREFIX = 'bd-' + Array.from(crypto.getRandomValues(new Uint8Array(8)),
    (b) => b.toString(16).padStart(2, '0')).join('') + '-';

// ─── Screen reader announcements ─────────────────────────────────────────────

// The two live regions at the end of index.html, looked up while the page holds
// only the app's markup. A polite status for news, an alert for failures.
const srStatus = document.querySelector('body > .sr-status');
const srAlert = document.querySelector('body > .sr-alert');
const announceTimers = new Map();

/**
 * Tell screen reader users something once. The region is emptied first and
 * filled a moment later, so the same message twice in a row is read twice.
 * @param {string} message
 * @param {{alert?: boolean}} [opts]  alert: a failure, read at once
 */
function announce(message, {alert = false} = {}) {
    const region = alert ? srAlert : srStatus;
    if (!region || !message) return;
    clearTimeout(announceTimers.get(region));
    region.textContent = '';
    announceTimers.set(region, setTimeout(() => { region.textContent = message; }, 50));
}

let toastEl = null;

/**
 * A short message near the bottom of the window. Screen readers hear it once
 * through announce(); the visible toast itself is hidden from them.
 * @param {string} message
 * @param {number} [durationMs]
 * @param {{alert?: boolean}} [opts]  alert: an error, announced as an alert
 */
function showToast(message, durationMs = 1800, {alert = false} = {}) {
    if (toastEl) toastEl.remove();
    const toast = document.createElement('div');
    toastEl = toast;
    toast.id = 'toast';
    toast.setAttribute('aria-hidden', 'true');
    toast.textContent = message;
    announce(message, {alert});
    toast.style.cssText = `
    position: fixed;
    bottom: 48px;
    left: 50%;
    transform: translateX(-50%);
    background: var(--text);
    color: var(--bg);
    padding: 8px 20px;
    border-radius: 20px;
    font-size: 13px;
    z-index: 9999;
    pointer-events: none;
    transition: opacity 0.3s;
  `;
    document.body.appendChild(toast);
    setTimeout(() => {
        toast.style.opacity = '0';
        setTimeout(() => toast.remove(), 320);
    }, durationMs);
}

// ─── Recent files sidebar (js/sidebar.js) ─────────────────────────────────────

const sidebar = createSidebar({
    list: byId('doc-list'),
    filter: byId('doc-filter'),
    more: byId('sidebar').querySelector('.doc-more'),
    editor,
    announce: (message) => announce(message),
    getStore: () => activeStore,
    currentId: () => docManager.currentId,
    openDoc: (id) => openDocument(id),
    removeDoc: (id) => removeDocument(id),
    confirm: (message) => window.confirm(message),
});

function renderSidebar() {
    return sidebar.render();
}

/** Delete a document; the open one is replaced by the most recent (or a blank doc). */
async function removeDocument(id) {
    const wasCurrent = id === docManager.currentId;
    try {
        // removeDoc cancels the pending autosave and, if this was the open
        // doc, loads the most recent one (or a blank doc) in its place.
        await docManager.removeDoc(id);
    } catch (err) {
        showToast('Delete failed: ' + ((err && err.message) || err), 4000, {alert: true});
    }
    if (wasCurrent) diskSync.startWatching();   // watch the doc loaded in its place, if it has a file
}


/** Count words in text */
function wordCount(text) {
    return text.trim().split(/\s+/).filter(Boolean).length;
}

// ─── Preview rendering ────────────────────────────────────────────────────────

// Reflect the chosen page (a named size in its orientation, or a custom size) in the live preview:
// the page-card width, the page's height to width for the cover, and one tall card for the
// continuous layout.
function applyPreviewPageSize(pageOpts) {
    const pane = byId('preview-pane');
    if (!pane) return;
    const {width, height} = pageBoxMm(pageOpts);
    pane.style.setProperty('--preview-page-width', Math.round(width * MM_TO_PX) + 'px');
    pane.style.setProperty('--preview-page-aspect', String(Math.round((height / width) * 10000) / 10000));
    pane.classList.toggle('landscape', width > height);
    pane.classList.toggle('continuous', pageOpts.layout === 'continuous');
}

function updatePreview() {
    const source = editor.value;
    currentSource = source;

    const templateId = currentTemplateId();

    if (!source.trim()) {
        preview.innerHTML = '<div class="preview-empty"><p>Start writing to see a preview</p></div>';
        wordCountEl.textContent = '0 words';
        readTimeEl.textContent = '0 min read';
        return;
    }

    // The same body and cover the PDF export uses (js/export-pipeline.js).
    const {bodyHTML, coverHTML} = prepareExport(source, currentTemplateEntry);

    // A template's canvas colour (its pageBackground, validated) on the body page card, as in the PDF.
    const pageBg = validPageBackground(currentTemplateEntry && currentTemplateEntry.template
        && currentTemplateEntry.template.pageBackground);
    const cardStyle = pageBg ? ` style="background:${pageBg}"` : '';

    // Cover: a page card with no inner padding (the cover handles its layout).
    const coverSection = coverHTML
        ? `<div class="preview-page preview-page-cover"><div class="template-${templateId}" style="max-width:none;width:100%;margin:0;padding:0;">${coverHTML}</div></div>`
        : '';

    // Body: a page card with 60px padding, matching the PDF.
    preview.innerHTML = coverSection + `<div class="preview-page"${cardStyle}><div class="template-${templateId}">${bodyHTML}</div></div>`;

    // Update counts and browser tab title
    const words = wordCount(source);
    wordCountEl.textContent = `${words.toLocaleString()} word${words !== 1 ? 's' : ''}`;
    readTimeEl.textContent = `${Math.max(1, Math.ceil(words / 200))} min read`;
    const docTitle = docManager.currentFileName || extractTitle(source) || 'Untitled';
    document.title = docTitle + ' · PrintMD';
}

const debouncedUpdatePreview = debounce(updatePreview, 100);

function triggerUpdate() {
    // Immediate update for toolbar actions; debounced for typing
    updatePreview();
    scheduleAutosave();
}

// ─── Autosave ─────────────────────────────────────────────────────────────────

function scheduleAutosave() {
    clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(doAutosave, 1000);
}

function refreshActiveTitles() {
    const id = docManager.currentId;
    // Prefer the filename for opened files so the in-place update doesn't
    // clobber the filename label with the derived H1 title.
    const title = docManager.currentFileName || docManager.deriveTitle(editor.value) || 'Untitled';
    sidebar.setActiveTitle(title);
    document.title = title + ' · PrintMD';
}

/** Drop the debounced autosave (docManager calls this before deleting the open doc). */
function cancelPendingSave() {
    clearTimeout(autosaveTimer);
    autosaveTimer = null;
}

const STATE_KEY = 'printmd-state';

function doAutosave() {
    autosaveTimer = null;
    // printmd-state is read at startup (last template) and by the one-time
    // migration in store.js (source, templateId). Skip it on the in-memory
    // fallback, so a degraded session cannot overwrite an older saved copy.
    if (!usingMemoryStore) {
        safeSet(STATE_KEY, JSON.stringify({
            source: editor.value,
            templateId: currentTemplateId(),
        }));
    }
    // "Autosaved" feedback comes from io.onSaved / io.onSaveError, i.e. only once
    // the write has actually committed (or failed).
    docManager.saveCurrent().then(() => refreshActiveTitles()).catch(() => {});
}

// \u2500\u2500 Save status in the footer \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

// A kind of write (text, settings) fails from a failed write until its next good one. A good
// settings write says nothing about unsaved text, and the other way round.
const saveFailures = {text: false, settings: false};
const saveFailing = () => saveFailures.text || saveFailures.settings;
let statusTimer = null;

/** The footer text to return to after a transient message. */
function idleStatusText() {
    if (saveFailing()) return 'Not saved';
    return usingMemoryStore ? 'Kept in memory only' : 'Autosaved';
}

function setStatus(text, {flash = false, timeoutMs = 0} = {}) {
    clearTimeout(statusTimer);
    statusTimer = null;
    autosaveEl.textContent = text;
    autosaveEl.classList.toggle('autosave-error', saveFailing() && text === 'Not saved');
    autosaveEl.classList.toggle('autosave-flash', flash);
    if (timeoutMs) {
        statusTimer = setTimeout(() => {
            autosaveEl.classList.remove('autosave-flash');
            setStatus(idleStatusText());
        }, timeoutMs);
    }
}

/**
 * The footer after a save. The text is not a live region: every save would be
 * read out while typing. Screen readers hear state changes only (onSaved after a
 * failure, onSaveError once per failure streak, the memory-only banner).
 */
function flashAutosave() {
    // In memory there is nothing on disk to confirm: keep saying so.
    if (usingMemoryStore) setStatus(idleStatusText());
    else setStatus('Autosaved \u2713', {flash: true, timeoutMs: 2000});
}

/** @param {'text'|'settings'} [kind]  the write that committed (js/docmanager.js io.onSaved) */
function onSaved(kind = 'text') {
    const wasFailing = saveFailing();
    saveFailures[kind] = false;
    switchBlockedShown = false;
    if (saveFailing()) {
        setStatus('Not saved');   // the other kind of write is still failing
        return;
    }
    flashAutosave();
    if (wasFailing) announce('Saved');
}

function onSaveError(err, kind = 'text') {
    const first = !saveFailing();
    saveFailures[kind] = true;
    setStatus('Not saved');
    // One toast (and one alert) per failure streak, not one per keystroke.
    if (first) showToast('Changes not saved: ' + ((err && err.message) || 'storage error'), 4000, {alert: true});
}

// ─── Template loading ─────────────────────────────────────────────────────────

function initTemplates(savedTemplateId) {
    const templates = getTemplates();

    // Populate <select>: under their group headings when the manifests give groups
    // (js/template-registry.js pickerGroups), else a flat list.
    templateSelect.innerHTML = '';
    for (const group of pickerGroups(templates)) {
        let parent = templateSelect;
        if (group.label) {
            parent = document.createElement('optgroup');
            parent.label = group.label;
            templateSelect.appendChild(parent);
        }
        for (const entry of group.entries) {
            const option = document.createElement('option');
            option.value = entry.manifest.id;
            option.textContent = entry.manifest.name;
            parent.appendChild(option);
        }
    }

    // Apply saved or first template
    const targetId = savedTemplateId || templates[0].manifest.id;
    const entry = getTemplateById(targetId) || templates[0];
    currentTemplateEntry = entry;
    templateSelect.value = entry.manifest.id;
    applyTemplate(entry);
    syncPageControls();
}

/**
 * Apply a template. `picked`: the user chose it in the picker (or the palette), so it is the
 * open document's choice. Picking a template with a default page (deck: Slide, landscape) sets
 * Size and Page to it; a choice made afterwards stands, and a template without one leaves the
 * choices as they are. Loading a document (io.setTemplateId) never applies the defaults: the
 * document's own choices stand.
 */
function switchTemplate(id, {picked = false} = {}) {
    const entry = getTemplateById(id);
    if (!entry) return;
    if (picked) {
        const defaults = id !== currentTemplateId() ? templatePageDefaults(entry.manifest) : {};
        chooseExportOpts({...exportChoices, ...defaults});
    }
    currentTemplateEntry = entry;
    applyTemplate(entry);
    syncPageControls();
    updatePreview();
    scheduleAutosave();
}

// ─── Doc manager ──────────────────────────────────────────────────────────────

function flashEditor() {
    editor.style.opacity = '0';
    requestAnimationFrame(() => {
        editor.style.transition = 'opacity 180ms ease';
        editor.style.opacity = '1';
        setTimeout(() => { editor.style.transition = ''; }, 200);
    });
}

const io = {
    getValue: () => editor.value,
    setValue: t => { editor.value = t; flashEditor(); },
    getTemplateId: currentTemplateId,
    setTemplateId: id => { switchTemplate(id); templateSelect.value = id; },
    // A new document takes the size and format on screen, not the open one's layout, fit or margin.
    getExportOpts: () => seedOf(exportChoices),
    setExportOpts: (stored) => applyDocExportOpts(stored),
    onChange: () => { updatePreview(); },
    onSaved: (_doc, info) => onSaved(info && info.kind === 'settings' ? 'settings' : 'text'),
    onSaveError: (err, info) => onSaveError(err, info && info.kind === 'settings' ? 'settings' : 'text'),
    cancelPendingSave: () => cancelPendingSave(),
    onRestored: () => { renderSidebar(); showToast('Restored unsaved changes from your last session', 3000); },
};

// The IndexedDB store, swapped for an in-memory one at startup if IndexedDB fails
// (see startStorage). Both are reassigned together; always read them at call time.
let activeStore = idbStore;
let usingMemoryStore = false;
let docManager = createDocManager(io, activeStore);

// ─── File operations ──────────────────────────────────────────────────────────

/** After the open doc was replaced (new, open, import, reload): refresh the UI. */
function afterDocChanged() {
    updatePreview();
    refreshActiveTitles();
    renderSidebar();
}

let switchBlockedShown = false;   // one toast per failure streak (reset by onSaved)

/** Leaving the doc failed because it could not be saved: we stay on it and say so. */
function reportBlockedSwitch() {
    if (switchBlockedShown) return;
    switchBlockedShown = true;
    showToast('Couldn\'t save this document, so I stayed on it. Copy your text before switching.', 5000, {alert: true});
}

async function newDocument() {
    try {
        await docManager.newDoc('');
    } catch (_err) {
        reportBlockedSwitch();
        return;
    }
    diskSync.startWatching();     // stops the watcher: a new doc has no file
    afterDocChanged();
    editor.focus();
}

/** Switch the editor to a stored document. */
async function openDocument(id) {
    try {
        await docManager.switchTo(id);
    } catch (_err) {
        reportBlockedSwitch();
        renderSidebar();
        return;
    }
    const h = docManager.currentHandle;
    if (h && h.requestPermission) {
        try { await h.requestPermission({ mode: 'read' }); } catch (_) {}
    }
    afterDocChanged();
    diskSync.startWatching();
}

function openFile() {
    fileInput.click();
}

/** Open a plain-text Markdown file (file input or drop) as a new local doc. */
async function openTextFileAsNewDoc(file) {
    try {
        const text = await file.text();
        await docManager.newDoc(text);
        await docManager.setFileNameForCurrent(file.name);
        diskSync.startWatching();
        afterDocChanged();
    } catch (err) {
        showToast('Open failed: ' + ((err && err.message) || err), 4000, {alert: true});
    }
}

const conflictModal = byId('conflict-modal');
const showConflictDialog = conflictModal
    ? createConflictDialog(conflictModal)
    : async (mode) => (mode === 'save' ? 'cancel' : 'mine');

const diskSync = createDiskSync({
    // A getter-backed proxy: docManager is replaced if storage falls back to memory.
    docManager: new Proxy({}, {get: (_t, key) => {
        const v = docManager[key];
        return typeof v === 'function' ? v.bind(docManager) : v;
    }}),
    getText: () => editor.value,
    showDialog: (mode, fileName) => showConflictDialog(mode, fileName),
    notify: (message, kind) => {
        showToast(message, kind === 'error' ? 4000 : 1800, {alert: kind === 'error'});
        if (kind === 'error') setStatus(message, {timeoutMs: 6000});
    },
    onChanged: () => afterDocChanged(),
    openFallback: () => openFile(),
});

function openFromDisk() { return diskSync.openFromDisk(); }
function saveFile() { return diskSync.saveFile(); }

/** More > Copy HTML: the preview's HTML (js/copy-text.js falls back where the Clipboard API is missing). */
async function copyHTML() {
    if (await copyText(preview.innerHTML)) {
        showToast('HTML copied to clipboard');
    } else {
        showToast('Could not copy the HTML: this browser blocks the clipboard here. Use https or localhost, '
            + 'or select the preview and press Ctrl+C.', 6000, {alert: true});
    }
}

const preflightModal = byId('preflight-modal');
const showPreflightDialog = preflightModal
    ? createPreflightDialog(preflightModal)
    : async () => 'proceed';

const pageOptionsModal = byId('page-options-modal');
const askPageOptions = pageOptionsModal ? createPageOptionsDialog(pageOptionsModal) : null;

/**
 * The Page options dialog for the open document: its custom size, layout, fit and margin. What it
 * has not chosen shows what its front matter sets, and the dialog says so. Save stores the choice
 * with the document (chooseExportOpts); Cancel and Escape change nothing.
 * @param {{custom?: boolean}} [opts]  custom: opened from the Size select's Custom size
 */
async function openPageOptions({custom = false} = {}) {
    if (!askPageOptions) return;
    const manifest = currentTemplateEntry && currentTemplateEntry.manifest;
    const sizes = templatePageSizes(manifest);
    const o = exportOptsForTemplate();
    const c = exportChoices;
    const fromMeta = frontMatterPageOpts(parseFrontMatter(editor.value).meta).opts;
    const state = {useCustom: custom || o.pageSize === CUSTOM_SIZE, customSize: c.customSize, layout: c.layout, fit: c.fit,
        margin: c.margin, templateMargin: templateMargin(), frontMatterKeys: []};
    for (const key of ['layout', 'fit', 'margin']) {
        if (c[key] === undefined && fromMeta[key] !== undefined) {
            state[key] = fromMeta[key];
            state.frontMatterKeys.push(key);
        }
    }
    // The named size to go back to when the custom size is unticked.
    const named = o.pageSize !== CUSTOM_SIZE ? o.pageSize : (templatePageDefaults(manifest).pageSize || 'A4');
    state.check = (r) => pageOptsProblem(normalizeExportOpts({pageSize: r.useCustom ? CUSTOM_SIZE : named, customSize: r.customSize,
        orientation: o.orientation, layout: r.layout, margin: r.margin}, {margin: templateMargin(), sizes}));
    const result = await askPageOptions(state);
    if (result) {
        const next = {...exportChoices, pageSize: result.useCustom ? CUSTOM_SIZE : named};
        if (result.customSize) next.customSize = result.customSize;
        // Only what the person set is stored: a layout, fit or margin the document had no value of its own for,
        // left as the front matter (or the default) gives it, stays unstored, so later front matter edits apply.
        const unchanged = {layout: fromMeta.layout ?? 'paged', fit: fromMeta.fit ?? 'off', margin: fromMeta.margin};
        for (const key of ['layout', 'fit', 'margin']) {
            if (result[key] === undefined || (c[key] === undefined && result[key] === unchanged[key])) delete next[key];
            else next[key] = result[key];
        }
        chooseExportOpts(next);
    }
    syncPageControls();
}

let pdfExportRunning = false;   // a second click or Ctrl+P while one export runs is ignored

async function doExportPDF() {
    if (pdfExportRunning) return;
    pdfExportRunning = true;
    try {
        const prepared = prepareExport(editor.value, currentTemplateEntry, exportRequest());
        prepared.warnings.push(...previewImageWarnings(preview, prepared.pageOpts));
        // Warnings, and the notes on the page options (a running head left out by the margin), are shown
        // before the print window opens: "Export anyway" is then the click that lets the pop-up through.
        const listed = [...prepared.warnings, ...(prepared.advisories || [])];
        if (listed.length > 0 && await showPreflightDialog(listed) !== 'proceed') return;
        const result = await exportPDF(prepared, currentTemplateEntry);
        // What the layout step did (a table scaled, a continuous page split): told once printing has started.
        if (result && result.printed && result.notes && result.notes.length) showToast(result.notes.join(' '), 6000);
    } finally {
        pdfExportRunning = false;
    }
}

/**
 * PDF export for Ctrl+P and the Export button: a failure (pop-up blocked, a step
 * that throws after the print window opened) shows a toast, never an unhandled rejection.
 */
async function exportPdfSafely() {
    try {
        await doExportPDF();
    } catch (e) {
        showToast('PDF export failed: ' + ((e && e.message) || e), 4000, {alert: true});
    }
}

async function doExport(format) {
    if (format && format !== exportChoices.format) chooseExportOpts({...exportChoices, format});
    const fmt = loadExportOpts().format;
    if (fmt === 'pdf') {
        await exportPdfSafely();
    } else if (fmt === 'docx') {
        try {
            // Same pipeline as the PDF: front matter stripped, metadata on the cover.
            const {doc, bodyHTML, pageOpts} = prepareExport(editor.value, currentTemplateEntry, exportRequest());
            // Images are not embedded in Word (roadmap M8-T15): say so before, and in the toast after.
            const leftOut = wordImagesNote(countWordImages(bodyHTML), {before: true});
            if (leftOut && await showPreflightDialog([leftOut], {file: 'Word file'}) !== 'proceed') return;
            const warnings = [];
            await exportDocx(doc, currentTemplateEntry, bodyHTML, {...pageOpts, onWarning: (w) => warnings.push(w)});
            showToast(warnings.length ? `Word document exported. ${warnings.join(' ')}` : 'Word document exported',
                warnings.length ? 5000 : 1800);
        } catch (e) { showToast('Word export failed: ' + e.message, 1800, {alert: true}); }
    } else if (fmt === 'pptx') {
        try {
            const {doc, bodyHTML, pageOpts} = prepareExport(editor.value, currentTemplateEntry, exportRequest());
            const warnings = [];
            await exportPptx(doc, currentTemplateEntry, bodyHTML, {...pageOpts, onWarning: (w) => warnings.push(w)});
            showToast(warnings.length ? `PowerPoint exported. ${warnings.join(' ')}` : 'PowerPoint exported',
                warnings.length ? 5000 : 1800);
        } catch (e) { showToast('PowerPoint export failed: ' + e.message, 1800, {alert: true}); }
    }
}

// ─── Theme ───────────────────────────────────────────────────────────────────

const THEME_KEY = 'printmd-theme';

/** The saved theme if valid, else the OS preference. */
function initialTheme() {
    const saved = safeGet(THEME_KEY);
    if (saved === 'dark' || saved === 'light') return saved;
    try {
        return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    } catch (_e) {
        return 'light';
    }
}

/** `persist` is false at startup, so following the OS preference is not frozen into storage. */
function setTheme(theme, persist = true) {
    document.documentElement.setAttribute('data-theme', theme);
    btnTheme.textContent = theme === 'dark' ? '\u2600\ufe0f' : '\uD83C\uDF19';
    // A toggle with a fixed name ("Dark theme"): its state is aria-pressed.
    btnTheme.setAttribute('aria-pressed', String(theme === 'dark'));
    if (persist) safeSet(THEME_KEY, theme);
}

function toggleTheme() {
    const current = document.documentElement.getAttribute('data-theme') || 'light';
    setTheme(current === 'dark' ? 'light' : 'dark');
}

// ─── Divider drag resize ──────────────────────────────────────────────────────

// The editor's share of the split, in percent, remembered in SPLIT_KEY for every document.
// Within SPLIT_MIN and SPLIT_MAX both panes keep at least a fifth of the window at any width
// (below 768 px the panes stack and the split is not used).
const SPLIT_KEY = 'printmd-split';
const SPLIT_MIN = 20;
const SPLIT_MAX = 80;
const SPLIT_STEP = 2;          // arrow keys
const SPLIT_BIG_STEP = 10;     // Shift + arrow keys

/** The remembered split: a plain decimal number clamped to the limits, else null (the 50/50 default). */
function storedSplit() {
    const raw = safeGet(SPLIT_KEY);
    if (typeof raw !== 'string' || !/^\d{1,3}(\.\d{1,2})?$/.test(raw)) return null;
    return Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, Number(raw)));
}

/** Remember the split the user chose, to one decimal place. */
function saveSplit(pct) {
    safeSet(SPLIT_KEY, String(Math.round(pct * 10) / 10));
}

/** Set the editor/preview split and the divider's aria-valuenow. */
function setSplit(pct) {
    editorPane.style.width = pct + '%';
    previewPane.style.width = (100 - pct) + '%';
    // Remove flex-basis so width takes over
    editorPane.style.flex = 'none';
    previewPane.style.flex = 'none';
    const rounded = Math.round(pct);
    divider.setAttribute('aria-valuenow', String(rounded));
    divider.setAttribute('aria-valuetext', `Editor ${rounded}%`);
}

function initDividerDrag() {
    let dragging = false;
    let dragged = null;   // the last split this drag set
    const saved = storedSplit();
    if (saved != null) setSplit(saved);

    divider.addEventListener('mousedown', e => {
        dragging = true;
        e.preventDefault();
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
    });

    document.addEventListener('mousemove', e => {
        if (!dragging) return;
        const rect = main.getBoundingClientRect();
        const pct = ((e.clientX - rect.left) / rect.width) * 100;
        if (pct > SPLIT_MIN && pct < SPLIT_MAX) {
            setSplit(pct);
            dragged = pct;
        }
    });

    // Keyboard: Left/Right by 2%, Shift for 10%, Home/End to the limits.
    divider.addEventListener('keydown', (e) => {
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        const now = Number(divider.getAttribute('aria-valuenow')) || 50;
        const step = e.shiftKey ? SPLIT_BIG_STEP : SPLIT_STEP;
        let next;
        switch (e.key) {
            case 'ArrowLeft': next = now - step; break;
            case 'ArrowRight': next = now + step; break;
            case 'Home': next = SPLIT_MIN; break;
            case 'End': next = SPLIT_MAX; break;
            default: return;
        }
        e.preventDefault();
        const pct = Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, next));
        setSplit(pct);
        saveSplit(pct);
    });

    document.addEventListener('mouseup', () => {
        if (dragging) {
            dragging = false;
            // Saved once, when the drag ends, not on every mouse move.
            if (dragged != null) saveSplit(dragged);
            dragged = null;
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
        }
    });
}

// ─── Keyboard shortcuts (js/shortcuts.js) ─────────────────────────────────────

/** The function a shortcut command runs, or null when there is nothing to do. */
function shortcutAction(command, palette) {
    switch (command) {
        case 'new': return () => newDocument();
        case 'open': return () => openFromDisk();
        case 'save': return () => saveFile();
        case 'pdf': return () => exportPdfSafely();
        case 'palette': return palette ? () => palette.open() : null;
        case 'bold': return () => format.wrapSelection('**', '**');
        case 'italic': return () => format.wrapSelection('_', '_');
    }
    if (command.startsWith('recent-')) {
        const items = byId('doc-list').querySelectorAll('.doc-item');
        const target = items[Number(command.slice(7)) - 1];
        return target ? () => target.click() : null;
    }
    return null;
}

/** Editor and preview scroll together in the split view. */
function initScrollSync() {
    let syncing = false;

    function syncScroll(source, target) {
        const sourceHeight = source.scrollHeight - source.clientHeight;
        if (sourceHeight <= 0) return;
        const targetHeight = target.scrollHeight - target.clientHeight;
        if (targetHeight <= 0) return;
        const ratio = source.scrollTop / sourceHeight;
        target.scrollTop = ratio * targetHeight;
    }

    editor.addEventListener('scroll', () => {
        if (syncing) return;
        if (main.classList.contains('view-editor') || main.classList.contains('view-preview')) return;
        syncing = true;
        syncScroll(editor, previewPane);
        requestAnimationFrame(() => { syncing = false; });
    });

    previewPane.addEventListener('scroll', () => {
        if (syncing) return;
        if (main.classList.contains('view-editor') || main.classList.contains('view-preview')) return;
        syncing = true;
        syncScroll(previewPane, editor);
        requestAnimationFrame(() => { syncing = false; });
    });
}

// ─── Template info button ─────────────────────────────────────────────────────

function showTemplateInfo() {
    if (!currentTemplateEntry) return;
    const m = currentTemplateEntry.manifest;
    const pop = byId('template-info-popover');
    const body = byId('template-info-body');
    body.innerHTML = '';
    const h = document.createElement('h3'); h.textContent = m.name; body.appendChild(h);
    const meta = document.createElement('div'); meta.className = 'ti-meta'; meta.textContent = 'v' + m.version + ' · ' + m.author; body.appendChild(meta);
    const desc = document.createElement('div'); desc.className = 'ti-desc'; desc.textContent = currentTemplateEntry.description || m.description || ''; body.appendChild(desc);
    const accentRow = document.createElement('div'); accentRow.className = 'ti-row';
    const sw = document.createElement('span'); sw.className = 'ti-swatch'; sw.style.background = m.accent;
    const at = document.createElement('span'); at.textContent = 'Accent ' + m.accent;
    accentRow.append(sw, at); body.appendChild(accentRow);
    const fontRow = document.createElement('div'); fontRow.className = 'ti-row'; fontRow.textContent = 'Font: ' + m.fontStack; body.appendChild(fontRow);
    // position under the info button
    const btn = byId('btn-template-info');
    const r = btn.getBoundingClientRect();
    pop.style.top = (r.bottom + 6) + 'px';
    pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 340)) + 'px';
    pop.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
    byId('template-info-close').focus();
}

/** Hide the template popover; focus goes back to its button when it was inside the popover. */
function closeTemplateInfo() {
    const pop = byId('template-info-popover');
    if (pop.hidden) return;
    const hadFocus = pop.contains(document.activeElement);
    pop.hidden = true;
    const btn = byId('btn-template-info');
    btn.setAttribute('aria-expanded', 'false');
    if (hadFocus) btn.focus();
}

function applyViewMode(mode) {
    const main = byId('main');
    const focused = document.activeElement;
    main.classList.remove('view-split', 'view-editor', 'view-preview');
    main.classList.add('view-' + mode);
    byId('menu-view-list').querySelectorAll('button').forEach(b => b.classList.toggle('active-view', b.dataset.view === mode));
    safeSet('printmd-view', mode);
    // The view just hid the focused pane (the editor in Preview only, the preview or
    // divider in Editor only): move focus to the pane that is left, not to <body>.
    if (focused && main.contains(focused) && !focused.getClientRects().length) {
        (mode === 'preview' ? previewPane : editor).focus();
    }
}
function initViewMode() {
    byId('menu-view-list').querySelectorAll('button').forEach(b => b.addEventListener('click', () => applyViewMode(b.dataset.view)));
    const saved = safeGet('printmd-view');
    applyViewMode(['split', 'editor', 'preview'].includes(saved) ? saved : 'split');
}

/**
 * Menu buttons (Import, More, View). Opening a menu moves focus to its first
 * item; Up/Down (wrapping), Home and End move between items; Escape closes it
 * and returns focus to the button; Tab closes it and moves on. ArrowDown or
 * ArrowUp on a closed menu's button opens it on the first or last item.
 */
function initMenus() {
    const menus = Array.from(byId('toolbar-nav').querySelectorAll('.menu'));
    const itemsOf = (list) => Array.from(list.querySelectorAll('[role="menuitem"]'));
    function closeAll(except) {
        menus.forEach(m => { if (m !== except) { const l = m.querySelector('.menu-list'); const t = m.querySelector('.menu-trigger'); if (l) l.hidden = true; if (t) t.setAttribute('aria-expanded', 'false'); } });
    }
    menus.forEach(menu => {
        const trigger = menu.querySelector('.menu-trigger');
        const list = menu.querySelector('.menu-list');
        if (!trigger || !list) return;
        // Items are reached with the arrow keys, not Tab.
        itemsOf(list).forEach((item) => { item.tabIndex = -1; });
        const openAt = (which) => {
            closeAll(menu);
            list.hidden = false;
            trigger.setAttribute('aria-expanded', 'true');
            const items = itemsOf(list);
            const target = which === 'last' ? items[items.length - 1] : items[0];
            if (target) target.focus();
        };
        const close = ({focusTrigger = false} = {}) => {
            list.hidden = true;
            trigger.setAttribute('aria-expanded', 'false');
            if (focusTrigger) trigger.focus();
        };
        trigger.addEventListener('click', (e) => {
            e.stopPropagation();
            if (list.hidden) openAt('first');
            else close();
        });
        trigger.addEventListener('keydown', (e) => {
            if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
            e.preventDefault();
            openAt(e.key === 'ArrowUp' ? 'last' : 'first');
        });
        list.addEventListener('keydown', (e) => {
            const items = itemsOf(list);
            const i = items.indexOf(document.activeElement);
            let next = null;
            switch (e.key) {
                case 'ArrowDown': next = items[(i + 1) % items.length]; break;
                case 'ArrowUp': next = items[(i - 1 + items.length) % items.length]; break;
                case 'Home': next = items[0]; break;
                case 'End': next = items[items.length - 1]; break;
                case 'Escape':
                    e.preventDefault();
                    e.stopPropagation();
                    close({focusTrigger: true});
                    return;
                case 'Tab':
                    close();
                    return;
                default: return;
            }
            e.preventDefault();
            if (next) next.focus();
        });
        // A chosen item: the menu closes and focus goes back to its button, unless
        // the command moved focus on (a dialog it opened, the editor).
        list.addEventListener('click', () => {
            const hadFocus = list.contains(document.activeElement);
            close();
            if (hadFocus) {
                setTimeout(() => {
                    const el = document.activeElement;
                    if (!el || el === document.body || list.contains(el)) trigger.focus();
                }, 0);
            }
        });
    });
    document.addEventListener('click', () => closeAll(null));
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeAll(null); });
}

// ─── Command Palette ──────────────────────────────────────────────────────────

/** The command palette (js/palette.js), or null when its markup is missing. */
function initCommandPalette() {
    const root = byId('cmdk');
    const input = byId('cmdk-input');
    const list = byId('cmdk-list');
    if (!root || !input || !list) return null;
    return createCommandPalette({
        root, input, list,
        commands: () => appCommands({byId, newDocShortcut: NEW_DOC_SHORTCUT}),
        listRecent: (limit) => activeStore.listRecent(limit),
        openDoc: (id) => openDocument(id),
        idPrefix: RUNTIME_ID_PREFIX,
    });
}

// ─── Init ─────────────────────────────────────────────────────────────────────

/** The template used last, from printmd-state (only templateId is read here). */
function savedTemplateId() {
    const state = safeGetJSON(STATE_KEY, null);
    return state && typeof state === 'object' && typeof state.templateId === 'string' ? state.templateId : null;
}

/** @param {string|null} [message]  replaces the banner's default "Storage unavailable" text */
function showStorageBanner(message = null) {
    const banner = byId('storage-banner');
    if (!banner) return;
    if (message) banner.querySelector('span').textContent = message;
    banner.hidden = false;
}

// ─── Hosted copy notice (js/edition.js) ──────────────────────────────────────

const HOSTED_NOTICE_KEY = 'printmd-hosted-notice-dismissed';

/**
 * Show the "run it locally" notice for a hosted copy (js/edition.js switches it
 * on; here it is off) until it is dismissed. The notice carries no id (like the
 * other body-level notices it is found by class), so it adds nothing to the
 * reserved ids in js/markdown.js APP_ELEMENT_IDS. Storage is never a problem:
 * safeGet and safeSet answer plainly when it is blocked, and the notice then
 * just stays hidden for a dismissed session or shows again after a reload.
 */
function initHostedNotice() {
    const notice = document.querySelector('body > .hosted-notice');
    if (!notice) return;
    const close = notice.querySelector('.hosted-notice-close');
    if (close) close.addEventListener('click', () => {
        safeSet(HOSTED_NOTICE_KEY, '1');
        notice.hidden = true;
    });
    if (hostedNoticeVisible({
        hostedNotice: EDITION.hostedNotice,
        hostname: window.location.hostname,
        protocol: window.location.protocol,
        dismissed: safeGet(HOSTED_NOTICE_KEY) === '1',
    })) notice.hidden = false;
}

// The note shown while another tab (on older code) holds the database open and
// the upgrade waits for it. Looked up at startup, like the live regions.
const upgradeWaitEl = document.querySelector('body > .upgrade-wait');
const UPGRADE_WAIT_MESSAGE = 'Waiting for another PrintMD tab to close…';
const UPGRADE_BLOCKED_MESSAGE = 'Another PrintMD tab is still open on an older version, so your documents could not '
    + 'be opened. Changes here are kept in memory only: close the other tab, then reload this one.';

const UPGRADE_PEER_MESSAGE = 'Another PrintMD tab is updating your documents…';
const UPGRADE_PEER_DETAIL = ' This takes a moment on a large library.';

// An open still pending after this long is waiting on another tab. Either a tab
// on older code holds the database (our upgrade gets a "blocked" event, or our
// open waits in line behind another tab's blocked upgrade and gets no event), or
// another tab on this code is running the upgrade itself, which can take seconds
// on a big database. The store's upgradeRunningElsewhere() tells the two apart.
const OPEN_SLOW_MS = 300;
const PEER_POLL_MS = 1000;

/**
 * The waiting note and the app's own give-up timer, in one of two modes:
 * - old: a tab on older code holds the database. The note counts down, and
 *   `expired` rejects when the wait (js/store.js openBlockedTimeout()) runs
 *   out, unless by then another tab is found to be upgrading.
 * - peer: another tab is upgrading. No countdown and no giving up while it
 *   still is; if it stops answering and we are still waiting, the old mode starts.
 * hide() ends both.
 */
function createUpgradeWait() {
    let ticker = null;
    let giveUp = null;
    let poll = null;
    let mode = null;
    let ended = false;
    let fail;
    const expired = new Promise((_resolve, reject) => { fail = reject; });
    expired.catch(() => { /* raced in startStorage */ });
    const count = upgradeWaitEl && upgradeWaitEl.querySelector('.upgrade-wait-count');
    const text = upgradeWaitEl && upgradeWaitEl.querySelector('span:not(.upgrade-wait-count)');
    const oldText = text ? text.textContent : '';

    function stopTimers() {
        clearInterval(ticker);
        clearTimeout(giveUp);
        clearInterval(poll);
    }

    /** A tab on older code holds the database: count down, then give up. */
    function showOld() {
        if (ended || mode === 'old') return;
        mode = 'old';
        stopTimers();
        const waitMs = idbStore.openBlockedTimeout();
        giveUp = setTimeout(async () => {
            // Last check: a tab on this code may have started upgrading meanwhile.
            const peer = await idbStore.upgradeRunningElsewhere();
            if (ended) return;
            if (peer) showPeer();
            else fail(new Error('Waited too long for another PrintMD tab'));
        }, waitMs);
        if (!upgradeWaitEl) return;
        if (text) text.textContent = oldText;
        const end = Date.now() + waitMs;
        const tick = () => {
            if (count) count.textContent = Math.max(1, Math.ceil((end - Date.now()) / 1000)) + ' s';
        };
        tick();
        ticker = setInterval(tick, 250);
        upgradeWaitEl.hidden = false;
        announce(UPGRADE_WAIT_MESSAGE);
    }

    /** Another tab is upgrading: say so, and wait for as long as it keeps answering. */
    function showPeer() {
        if (ended || mode === 'peer') return;
        mode = 'peer';
        stopTimers();
        let silent = 0;
        poll = setInterval(async () => {
            const peer = await idbStore.upgradeRunningElsewhere();
            if (ended || mode !== 'peer') return;
            // Two silent answers in a row: it finished (our open follows at once) or it went away.
            silent = peer ? 0 : silent + 1;
            if (silent >= 2) showOld();
        }, PEER_POLL_MS);
        if (!upgradeWaitEl) return;
        if (text) text.textContent = UPGRADE_PEER_MESSAGE + UPGRADE_PEER_DETAIL;
        if (count) count.textContent = '';
        upgradeWaitEl.hidden = false;
        announce(UPGRADE_PEER_MESSAGE);
    }

    return {
        expired,
        get shown() { return mode !== null; },
        /** Our upgrade was blocked: only a tab on older code does that. */
        blocked: showOld,
        /** The open is slow and nothing says why yet: ask, then show the right note. */
        async slow() {
            const peer = await idbStore.upgradeRunningElsewhere();
            if (ended || mode !== null) return;
            if (peer) showPeer(); else showOld();
        },
        hide() {
            ended = true;
            stopTimers();
            if (upgradeWaitEl) upgradeWaitEl.hidden = true;
        },
    };
}

/**
 * Open IndexedDB and load the docs. If IndexedDB is unavailable (blocked, private
 * mode, broken), carry on with an in-memory store and say so: the app stays
 * usable, but changes last only until the tab closes.
 */
async function startStorage() {
    let storedCount;
    const wait = createUpgradeWait();
    const slow = setTimeout(() => wait.slow(), OPEN_SLOW_MS);
    try {
        await Promise.race([idbStore.openDB({
            onBlocked: () => wait.blocked(),
            // Our own upgrade is running (it can take a while on a big database):
            // no other tab holds us up, so no note and no give-up timer.
            onUpgrading: () => { clearTimeout(slow); wait.hide(); },
        }), wait.expired]);
    } catch (_err) {
        // IndexedDB cannot be opened, or another tab kept us waiting too long.
        clearTimeout(slow);
        wait.hide();
        // An open that never settled may still succeed later: closeDB makes the
        // store close that late connection instead of keeping it (it would block
        // the next upgrade) while this session runs on the memory store.
        idbStore.closeDB();
        return fallBackToMemoryStore(wait.shown ? UPGRADE_BLOCKED_MESSAGE : null);
    }
    clearTimeout(slow);
    wait.hide();
    if (wait.shown) announce('Documents loaded');
    try {
        storedCount = (await idbStore.listRecent(1)).length;
    } catch (_err) {
        return fallBackToMemoryStore();   // IndexedDB opened but cannot be read
    }
    try {
        await docManager.init(SAMPLE_MARKDOWN);
    } catch (err) {
        // A write failed during startup (quota, for example). With stored docs,
        // stay on IndexedDB so they stay visible; the save status reports the
        // failure. With none, there is nothing to hide and no doc to edit, so
        // use the in-memory store to keep the app usable.
        if (storedCount === 0 && docManager.currentId == null) return fallBackToMemoryStore();
        showToast('Could not finish loading your documents: ' + ((err && err.message) || err), 5000, {alert: true});
    }
}

/** @param {string|null} [bannerMessage]  why, when it is not simply "storage unavailable" */
async function fallBackToMemoryStore(bannerMessage = null) {
    // Cut the old manager off first: a navigation already queued on it must not
    // write into the editor after the new manager has loaded its doc.
    docManager.dispose();
    activeStore = idbStore.createMemoryStore();
    usingMemoryStore = true;
    docManager = createDocManager(io, activeStore);
    showStorageBanner(bannerMessage);   // role="alert": read out once when shown
    setStatus(idleStatusText());  // "Kept in memory only", never "Autosaved"
    try { await docManager.init(SAMPLE_MARKDOWN); } catch (_e) { /* the memory store does not fail */ }
}

const passwordModal = byId('password-modal');
const askImportPassword = passwordModal ? createPasswordDialog(passwordModal) : async () => null;

const importConfirmModal = byId('import-confirm-modal');
const showImportChoice = importConfirmModal ? createChoiceDialog(importConfirmModal) : null;

/** Ask before a slow import (e.g. a PDF of hundreds of pages). Cancel is the safe choice. */
async function confirmImport(message) {
    if (!showImportChoice) return true;
    const choice = await showImportChoice({
        message,
        buttons: [
            {choice: 'cancel', label: 'Cancel', primary: true},
            {choice: 'go', label: 'Import anyway'},
        ],
        safe: 'cancel',
    });
    return choice === 'go';
}

/** Footer status + toast callbacks for one import, matching the existing wording. */
function importStatusUI(label, {progressText, doneText, toastMs = 1800} = {}) {
    const progress = progressText || `Importing ${label}…`;
    return {
        onStart: () => setStatus(`${progress} 0%`),
        onProgress: (pct) => setStatus(`${progress} ${pct}%`),
        onPassword: (reason) => askImportPassword(reason),
        onConfirm: (message) => confirmImport(message),
        onDone: (_doc, warnings = []) => {
            diskSync.startWatching();     // the new doc is local: stop watching the old file
            afterDocChanged();
            setStatus(doneText || `${label} imported`, {timeoutMs: 3000});
            // Progress percentages are not announced; the outcome is, once.
            if (warnings.length) showToast(`${label} imported, with notes: ${warnings.join(' ')}`, 7000);
            else announce(doneText || `${label} imported`);
        },
        onCancel: () => setStatus(idleStatusText()),
        onError: (err) => {
            setStatus('Import failed', {timeoutMs: Math.max(3000, toastMs)});
            showToast(`${label} import failed: ${(err && err.message) || err}`, toastMs, {alert: true});
        },
    };
}

/** Import a PDF/Word/HTML/EPUB file as a new doc. `fallbackId` is the menu item used. */
function importUserFile(file, fallbackId = null) {
    return importFile(docManager, file, {
        fallbackId,
        ui: (importer) => importStatusUI(importer ? importer.label : 'File'),
    });
}

/** Every UI event handler. Attached before any storage await, so a storage failure cannot leave a dead UI. */
function wireUI() {
    byId('btn-new').title = `New document  (${NEW_DOC_SHORTCUT})`;
    byId('sidebar-new').addEventListener('click', newDocument);
    byId('sidebar-open').addEventListener('click', openFromDisk);
    sidebar.attach();

    // Skip link: straight to the editor (no hash change on the app's URL).
    const skip = document.querySelector('body > a.skip-link');
    if (skip) skip.addEventListener('click', (e) => { e.preventDefault(); editor.focus(); });

    initSidebarCollapse({sidebar: byId('sidebar'), toggle: byId('sidebar-toggle')});

    // Storage-unavailable banner: shown by startStorage, stays until dismissed.
    const bannerClose = byId('storage-banner-close');
    if (bannerClose) bannerClose.addEventListener('click', () => { byId('storage-banner').hidden = true; });

    // Init drag resize
    initDividerDrag();

    // Editor keys (Tab indent, smart lists) and scroll sync
    format.attachEditorKeys();
    initScrollSync();

    // ── Disk watching and flush on leave ────────────────────────────────────
    window.addEventListener('focus', () => { diskSync.checkDiskChange(); });
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') {
            // The tab may never come back (closed, discarded on mobile): write now.
            docManager.flushOnLeave();
            diskSync.stopWatching();
        } else {
            diskSync.resumeWatching();
        }
    });
    window.addEventListener('pagehide', () => { docManager.flushOnLeave(); });

    // ── Drop a file anywhere: open it as a new doc instead of navigating away ─
    let dragDepth = 0;
    const hasFiles = (e) => !!(e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files'));
    const endDrag = () => { dragDepth = 0; document.body.classList.remove('drag-files'); };
    document.addEventListener('dragenter', (e) => {
        if (!hasFiles(e)) return;
        dragDepth++;
        document.body.classList.add('drag-files');
    });
    document.addEventListener('dragleave', (e) => {
        if (!hasFiles(e)) return;
        dragDepth = Math.max(0, dragDepth - 1);
        if (dragDepth === 0) document.body.classList.remove('drag-files');
    });
    document.addEventListener('dragover', (e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
    });
    document.addEventListener('drop', (e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        endDrag();
        const file = e.dataTransfer.files && e.dataTransfer.files[0];
        if (!file) return;
        if (/\.(md|markdown|txt)$/i.test(file.name)) openTextFileAsNewDoc(file);
        else importUserFile(file);
    });

    // ── Anchor link interception: scroll within the preview pane ────────────
    // Clicks on #fragment links inside the preview would otherwise navigate
    // the top-level page; instead we find the target heading and scroll to it.
    previewPane.addEventListener('click', e => {
        const a = e.target.closest('a[href^="#"]');
        if (!a) return;
        // Never let a preview link move the app page itself (it could jump to an
        // app element with that id); only scroll within the preview.
        e.preventDefault();
        // Hrefs are percent-encoded (#caf%C3%A9-cr%C3%A8me); ids are not.
        let id;
        try {
            id = decodeURIComponent(a.getAttribute('href').slice(1));
        } catch {
            return;   // malformed escape: no heading can match
        }
        if (!id) return;
        const target = previewPane.querySelector(`#${CSS.escape(id)}`);
        const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        if (target) target.scrollIntoView({behavior: reduce ? 'auto' : 'smooth', block: 'start'});
    });

    // ── Event listeners ──────────────────────────────────────────────────────

    editor.addEventListener('input', () => {
        debouncedUpdatePreview();
        scheduleAutosave();
    });

    templateSelect.addEventListener('change', () => {
        switchTemplate(templateSelect.value, {picked: true});
    });

    byId('btn-new').addEventListener('click', newDocument);
    byId('btn-reset').addEventListener('click', () => {
        if (window.confirm('Replace the current document with the sample? This cannot be undone.')) {
            format.setContent(SAMPLE_MARKDOWN);
            triggerUpdate();
        }
    });
    byId('btn-open').addEventListener('click', openFromDisk);
    byId('btn-import-pdf').addEventListener('click', () => pdfInput.click());
    byId('btn-import-drive').addEventListener('click', openDriveModal);
    byId('btn-import-docx').addEventListener('click', () => docxInput.click());
    byId('btn-import-html').addEventListener('click', () => htmlInput.click());
    byId('btn-import-epub').addEventListener('click', () => epubInput.click());
    byId('btn-save').addEventListener('click', saveFile);
    byId('btn-copy-html').addEventListener('click', copyHTML);
    initMenus();
    initViewMode();
    const orientationSel = byId('export-orientation');
    const formatSel = byId('export-format');
    const paperSel = byId('export-paper-size');
    // Size, Page and As show the open document's choices (each load syncs them again).
    syncPageControls();
    // Each change is validated, saved to the open document and kept as the last used;
    // the selects and the preview use the clean values.
    const updateExportOpt = (key, value) => {
        chooseExportOpts({...exportChoices, [key]: value});
        syncPageControls();
    };
    // Custom size opens the Page options dialog with the custom size ticked; Cancel puts the size back.
    if (paperSel) {
        paperSel.addEventListener('change', () => {
            if (paperSel.value === CUSTOM_SIZE) openPageOptions({custom: true});
            else updateExportOpt('pageSize', paperSel.value);
        });
    }
    const pageOptionsBtn = byId('btn-page-options');
    if (pageOptionsBtn) pageOptionsBtn.addEventListener('click', () => openPageOptions());
    if (orientationSel) orientationSel.addEventListener('change', () => updateExportOpt('orientation', orientationSel.value));
    if (formatSel) formatSel.addEventListener('change', () => updateExportOpt('format', formatSel.value));
    byId('btn-export').addEventListener('click', () => doExport(formatSel ? formatSel.value : 'pdf'));
    byId('btn-template-info').addEventListener('click', showTemplateInfo);
    btnTheme.addEventListener('click', toggleTheme);

    // Template info popover close / dismiss
    byId('template-info-close').addEventListener('click', closeTemplateInfo);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeTemplateInfo(); });
    document.addEventListener('click', (e) => { const pop = byId('template-info-popover'); if (!pop.hidden && !pop.contains(e.target) && !byId('btn-template-info').contains(e.target)) closeTemplateInfo(); });

    // ── Formatting toolbar: one delegated listener on #toolbar-format ──────
    byId('toolbar-format').addEventListener('click', e => {
        const btn = e.target.closest('[data-fmt]');
        if (!btn) return;
        format.dispatchFormat(btn.dataset.fmt);
    });

    // ── Markdown file open (file input fallback when there is no open picker) ─
    fileInput.addEventListener('change', e => {
        const file = e.target.files[0];
        fileInput.value = '';
        if (file) openTextFileAsNewDoc(file);
    });

    // ── Image file → base64 data URL ───────────────────────────────────────
    imageInput.addEventListener('change', e => {
        const file = e.target.files[0];
        if (!file) return;
        // Warn if the image is large (data URIs bloat the markdown source)
        if (file.size > 2 * 1024 * 1024) {
            showToast('Large image: consider linking to a hosted URL instead');
        }
        const reader = new FileReader();
        reader.onload = ev => format.insertImageSnippet(ev.target.result, file.name);
        reader.readAsDataURL(file);
        imageInput.value = '';
    });

    // ── Google Drive import ─────────────────────────────────────────────────

    const driveModal = byId('drive-modal');
    const driveUrlInput = byId('drive-url-input');

    let driveA11y = null;   // the open modal (js/dialog-a11y.js)

    function openDriveModal() {
        if (driveA11y) return;
        // Pre-fill stored credentials
        byId('drive-input-client-id').value = safeGet('gd-client-id') || '';
        byId('drive-input-api-key').value = safeGet('gd-api-key') || '';
        driveUrlInput.value = '';
        // Opened from a menu item: focus goes back to that menu's button on close.
        const opener = document.activeElement;
        const menu = opener && opener.closest && opener.closest('.menu');
        const restoreTo = menu ? menu.querySelector('.menu-trigger') : opener;
        driveModal.style.display = 'block';
        const activeTab = driveModal.querySelector('.drive-tab.active');
        driveA11y = openModal(driveModal, {
            initialFocus: () => (activeTab && activeTab.dataset.tab === 'url' ? driveUrlInput : activeTab),
            onEscape: closeDriveModal,
            restoreTo,
        });
    }

    function closeDriveModal() {
        driveModal.style.display = 'none';
        if (driveA11y) {
            const m = driveA11y;
            driveA11y = null;
            m.close();
        }
    }

    // Tabs: a tablist; Left/Right (wrapping), Home and End select and focus a tab.
    const driveTabs = Array.from(driveModal.querySelectorAll('.drive-tab'));
    function selectDriveTab(tab) {
        driveTabs.forEach(t => {
            const on = t === tab;
            t.classList.toggle('active', on);
            t.setAttribute('aria-selected', String(on));
            t.tabIndex = on ? 0 : -1;
        });
        driveModal.querySelectorAll('.drive-tab-content').forEach(c => {
            c.style.display = 'none';
        });
        byId(`drive-tab-${tab.dataset.tab}`).style.display = 'block';
    }
    driveTabs.forEach(tab => {
        tab.addEventListener('click', () => selectDriveTab(tab));
        tab.addEventListener('keydown', (e) => {
            const i = driveTabs.indexOf(tab);
            let next = null;
            if (e.key === 'ArrowRight') next = driveTabs[(i + 1) % driveTabs.length];
            else if (e.key === 'ArrowLeft') next = driveTabs[(i - 1 + driveTabs.length) % driveTabs.length];
            else if (e.key === 'Home') next = driveTabs[0];
            else if (e.key === 'End') next = driveTabs[driveTabs.length - 1];
            if (!next) return;
            e.preventDefault();
            selectDriveTab(next);
            next.focus();
        });
    });

    // Close on backdrop click
    byId('drive-modal-backdrop').addEventListener('click', closeDriveModal);
    byId('drive-modal-close').addEventListener('click', closeDriveModal);

    // Cancel buttons
    ['drive-btn-cancel', 'drive-btn-cancel-picker', 'drive-btn-cancel-settings'].forEach(id => {
        byId(id).addEventListener('click', closeDriveModal);
    });

    // Save credentials
    byId('drive-btn-save-creds').addEventListener('click', () => {
        const clientId = byId('drive-input-client-id').value.trim();
        const apiKey = byId('drive-input-api-key').value.trim();
        const ok = (!clientId || safeSet('gd-client-id', clientId)) && (!apiKey || safeSet('gd-api-key', apiKey));
        showToast(ok ? 'Credentials saved' : 'Could not save credentials: browser storage is unavailable', ok ? 1800 : 4000, {alert: !ok});
        closeDriveModal();
    });

    // Clear credentials: removes them from this browser (never shown or logged).
    byId('drive-btn-clear-creds').addEventListener('click', () => {
        const ok = safeRemove('gd-client-id') && safeRemove('gd-api-key');
        byId('drive-input-client-id').value = '';
        byId('drive-input-api-key').value = '';
        showToast(ok ? 'Saved Google credentials cleared' : 'Could not clear credentials: browser storage is unavailable', ok ? 1800 : 4000, {alert: !ok});
    });

    function runDriveImport(importFn) {
        closeDriveModal();
        return runImport(docManager, {
            convert: (_input, onProgress, opts) => importFn(onProgress, opts),   // null = user cancelled
            input: null,
            ui: importStatusUI('Drive', {
                progressText: 'Importing from Drive…',
                doneText: 'Drive import complete',
                toastMs: 4000,
            }),
        });
    }

    // Import from pasted URL
    byId('drive-btn-import-url').addEventListener('click', () => {
        const url = driveUrlInput.value.trim();
        if (!url) {
            driveUrlInput.focus();
            return;
        }
        if (!parseGoogleUrl(url)) {
            showToast('That doesn\'t look like a Google Drive or Docs URL');
            driveUrlInput.focus();
            return;
        }
        runDriveImport((onProgress, opts) => importFromUrl(url, opts, onProgress));
    });

    // Escape is handled by js/dialog-a11y.js (closeDriveModal).
    driveUrlInput.addEventListener('keydown', e => {
        if (e.key === 'Enter') byId('drive-btn-import-url').click();
    });

    // Import via Drive Picker (credentials resolved inside the module)
    byId('drive-btn-open-picker').addEventListener('click', () => {
        runDriveImport((onProgress, opts) => importFromPicker(opts, onProgress));
    });

    // ── PDF / Word / HTML / EPUB import → Markdown, opened as a new doc ────
    for (const [input, id] of [[pdfInput, 'pdf'], [docxInput, 'docx'], [htmlInput, 'html'], [epubInput, 'epub']]) {
        input.addEventListener('change', e => {
            const file = e.target.files[0];
            input.value = '';
            if (file) importUserFile(file, id);
        });
    }
}

/** The hooks the test pages and tests/audit.mjs drive the app through. */
function exposeTestHooks() {
    window.__bd = {
        get docManager() { return docManager; },
        get usingMemoryStore() { return usingMemoryStore; },
        diskSync,
        renderSidebar,
        openDocument,
        openFromDisk,
        startWatching: () => diskSync.startWatching(),
        stopWatching: () => diskSync.stopWatching(),
        checkDiskChange: () => diskSync.checkDiskChange(),
    };
}

/** Rendering, theme, templates and every handler: no storage yet. */
function wireApp() {
    configureMarked();
    setTheme(initialTheme(), false);          // the saved choice, else the OS preference
    initTemplates(savedTemplateId());         // also applies the template's CSS
    wireUI();
    initHostedNotice();
    const palette = initCommandPalette();
    initKeyboardShortcuts(document, {
        isMac: IS_MAC,
        isEditorFocused: () => document.activeElement === editor,
        resolve: (command) => shortcutAction(command, palette),
    });
    exposeTestHooks();
}

/**
 * Open storage and show the first document. If IndexedDB fails, startStorage
 * falls back to memory. index.html starts the editor read-only: text typed
 * before the first doc has loaded would be overwritten by it.
 */
async function loadDocuments() {
    try {
        await startStorage();
    } finally {
        editor.readOnly = false;
    }
    updatePreview();
    await renderSidebar();
    if (docManager.currentHandle) diskSync.startWatching();
}

/**
 * Every handler first, storage last: nothing can leave the page without a working UI.
 * It runs once: later calls return the same promise. index.html boots it when this
 * module has run and the document is parsed; a test page that hosts the app's
 * markup itself imports this module and calls it.
 */
let booted = null;
export function init() {
    if (!booted) {
        booted = (async () => {
            wireApp();
            await loadDocuments();
        })();
    }
    return booted;
}

// js/templates.js loads the template registry with a top-level await, so this
// module can finish after DOMContentLoaded has fired: boot on whichever comes last.
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
