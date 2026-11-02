/**
 * js/imports.js
 *
 * Every import (PDF, Word, HTML, EPUB, Google Drive) ends the same way: the
 * converted Markdown opens as a NEW document. It never replaces whatever doc is
 * active when the conversion finishes, because conversion is slow and the user
 * may have switched documents (or typed) in the meantime.
 *
 * No DOM access here: progress, success and error reporting are injected by the
 * caller as `ui` callbacks, so the dispatcher can be tested on its own.
 */

/**
 * The file importers. Converters load lazily, the first time they are used.
 * `extensions` are lower-case and include the dot.
 */
export const IMPORTERS = [
    {id: 'pdf', label: 'PDF', extensions: ['.pdf'],
        load: () => import('./pdf-import.js').then((m) => m.pdfToMarkdown)},
    {id: 'docx', label: 'Word', extensions: ['.docx', '.doc'],
        load: () => import('./docx-import.js').then((m) => m.docxToMarkdown)},
    {id: 'html', label: 'HTML', extensions: ['.html', '.htm'],
        load: () => import('./html-import.js').then((m) => m.htmlToMarkdown)},
    {id: 'epub', label: 'EPUB', extensions: ['.epub'],
        load: () => import('./epub-import.js').then((m) => m.epubToMarkdown)},
];

function extensionOf(name) {
    const m = /\.[^./\\]+$/.exec(String(name || ''));
    return m ? m[0].toLowerCase() : '';
}

/**
 * Pick the importer for a file name. The extension wins; `fallbackId` (the import
 * menu item the user chose) is used only when the extension matches nothing.
 * @returns {object|null}
 */
export function findImporter(fileName, fallbackId = null, importers = IMPORTERS) {
    const ext = extensionOf(fileName);
    const byExt = ext && importers.find((imp) => imp.extensions.includes(ext));
    if (byExt) return byExt;
    if (fallbackId) return importers.find((imp) => imp.id === fallbackId) || null;
    return null;
}

/** "report.pdf" -> "report.md": the new doc is Markdown, named after its source. */
export function markdownFileName(fileName) {
    const base = String(fileName || '').replace(/\.[^./\\]+$/, '');
    return base ? base + '.md' : null;
}

/**
 * Every converter is called as convert(input, onProgress, opts), where opts holds:
 *   onWarning(message)   a non-fatal problem worth telling the user about
 *   onPassword(reason)   resolves with a password, or null to cancel ('need' | 'incorrect')
 *   onConfirm(message)   resolves true to go on, false to cancel (e.g. a very large PDF)
 * A converter returns Markdown, or null when the user cancelled.
 *
 * @param {{newDoc: (text: string) => Promise<any>}} docManager
 * @param {(input: any, onProgress?: Function, opts?: object) => Promise<string|null>} convert
 * @param {any} input       the File, URL or HTML string handed to `convert`
 * @param {Function} [onProgress]
 * @param {object} [opts]   passed to `convert` as its third argument
 * @returns {Promise<any>} the new doc record, or null when the conversion was cancelled
 */
export async function importAsNewDoc(docManager, convert, input, onProgress, opts = {}) {
    const markdown = await convert(input, onProgress, opts);
    if (markdown == null) return null;
    return docManager.newDoc(markdown);
}

/**
 * Run one import end to end and report through `ui`. Never throws: a failure is
 * passed to ui.onError and no doc is created.
 *
 * ui (all optional): onStart(), onProgress(pct), onDone(doc, warnings), onCancel(), onError(err),
 *   onPassword(reason), onConfirm(message). Warnings the converter reported are
 *   collected and passed to onDone as an array of strings (empty when none).
 *
 * @param {object} docManager
 * @param {{convert: Function, input: any, fileName?: string|null, ui?: object}} job
 * @returns {Promise<any>} the new doc, or null (cancelled or failed)
 */
export async function runImport(docManager, {convert, input, fileName = null, ui = {}}) {
    if (ui.onStart) ui.onStart();
    const warnings = [];
    const opts = {
        onWarning: (message) => warnings.push(String(message)),
        onPassword: ui.onPassword,
        onConfirm: ui.onConfirm,
    };
    try {
        const doc = await importAsNewDoc(docManager, convert, input, ui.onProgress, opts);
        if (doc == null) {
            if (ui.onCancel) ui.onCancel();
            return null;
        }
        if (fileName && docManager.currentId === doc.id) await docManager.setFileNameForCurrent(fileName);
        if (ui.onDone) await ui.onDone(doc, warnings);
        return doc;
    } catch (err) {
        if (ui.onError) ui.onError(err);
        return null;
    }
}

/**
 * Import a File picked or dropped by the user: choose the importer, load its
 * converter, and open the result as a new doc named after the file.
 *
 * @param {object} docManager
 * @param {File} file
 * @param {{fallbackId?: string, ui?: (importer: object|null) => object, importers?: object[]}} [opts]
 *        `ui` is called with the chosen importer (null if none) and returns the callbacks.
 * @returns {Promise<any>} the new doc, or null
 */
export async function importFile(docManager, file, {fallbackId = null, ui = () => ({}), importers = IMPORTERS} = {}) {
    const importer = findImporter(file && file.name, fallbackId, importers);
    const callbacks = ui(importer) || {};
    if (!importer) {
        if (callbacks.onError) callbacks.onError(new Error('Unsupported file type'));
        return null;
    }
    return runImport(docManager, {
        convert: async (input, onProgress, opts) => (await importer.load())(input, onProgress, opts),
        input: file,
        fileName: markdownFileName(file.name),
        ui: callbacks,
    });
}
