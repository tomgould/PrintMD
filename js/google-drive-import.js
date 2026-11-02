/**
 * google-drive-import.js
 *
 * Import Google Docs, Google Sheets, PDFs, Word, HTML, CSV and plain-text files
 * from Google Drive. Docs are exported as HTML and converted like an HTML file
 * (headings, lists, links and tables survive); a Sheet's first tab is exported
 * as CSV and becomes a Markdown table. Other file types are refused by name.
 * Two modes:
 *   importFromUrl(url, options, onProgress)     paste a Google Doc/Drive URL
 *   importFromPicker(credentials, onProgress)   browse via Drive Picker UI
 *
 * ── One-time developer setup ──────────────────────────────────────────────────
 * 1. Create a Google Cloud project at https://console.cloud.google.com/
 * 2. Enable: Google Drive API  +  Google Picker API
 * 3. Create an OAuth 2.0 Client ID  (Application type: Web application)
 *    and add every serving origin to "Authorised JavaScript origins"
 * 4. Create an API key and restrict it to Drive API + Picker API
 * 5. Paste both into the constants below
 *
 * End-users just see the Google account picker: no setup on their end.
 *
 * ⚠  Requires HTTP/HTTPS: Google OAuth rejects null (file://) origins.
 *
 * For publicly shared Docs and Sheets, importFromUrl tries without auth first.
 */

import {pdfToMarkdown} from './pdf-import.js';
import {htmlToMarkdown} from './html-import.js';
import {safeGet} from './safe-storage.js';
import {MAX_TABLE_ROWS, buildTurndown, loadScript, loadTurndown, maxOf, tableLimitWarning, warn} from './import-utils.js';

// ── Configure once, works for all users ──────────────────────────────────────
// Leave empty to fall back to a per-user credentials prompt in the UI.
const GOOGLE_CLIENT_ID = '';  // e.g. '123456789-abc.apps.googleusercontent.com'
const GOOGLE_API_KEY = '';  // e.g. 'AIzaSy…'  (needed only for Drive Picker)
// ─────────────────────────────────────────────────────────────────────────────

const GIS_SRC = 'https://accounts.google.com/gsi/client';
const GAPI_SRC = 'https://apis.google.com/js/api.js';
// Pasted URLs can name any file the user can read, so that flow needs
// drive.readonly. The Picker only needs the file the user picks: drive.file.
const SCOPE_READONLY = 'https://www.googleapis.com/auth/drive.readonly';
const SCOPE_PICKER = 'https://www.googleapis.com/auth/drive.file';
const AUTH_TIMEOUT_MS = 60000;

const GDOC_MIME = 'application/vnd.google-apps.document';
const GDOC_SHEET = 'application/vnd.google-apps.spreadsheet';
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/** Drive file types that can be imported, with the name used in messages. */
const SUPPORTED_TYPES = new Map([
    [GDOC_MIME, 'Google Docs'],
    [GDOC_SHEET, 'Google Sheets'],
    ['application/pdf', 'PDF'],
    [DOCX_MIME, 'Word (.docx)'],
    ['text/html', 'HTML'],
    ['text/csv', 'CSV'],
    ['text/plain', 'plain text'],
    ['text/markdown', 'Markdown'],
    ['text/x-markdown', 'Markdown'],
]);

/** Names for common types that cannot be imported, so the refusal can say what the file is. */
const KNOWN_TYPES = {
    'application/vnd.google-apps.presentation': 'Google Slides',
    'application/vnd.google-apps.form': 'Google Forms',
    'application/vnd.google-apps.drawing': 'Google Drawings',
    'application/vnd.google-apps.folder': 'a folder',
    'application/vnd.google-apps.shortcut': 'a shortcut',
};

/** Throws a clear message for a Drive file type the importer cannot convert. */
export function assertSupportedType(mimeType) {
    if (SUPPORTED_TYPES.has(mimeType)) return;
    const what = KNOWN_TYPES[mimeType] || (mimeType ? `"${mimeType}" files` : 'this file type');
    throw new Error(`PrintMD cannot import ${what} from Google Drive. ` +
        'It imports Google Docs, Google Sheets, PDF, Word (.docx), HTML, CSV, Markdown and plain-text files.');
}

// ── URL parsing ───────────────────────────────────────────────────────────────

const GOOGLE_HOSTS = new Set(['docs.google.com', 'drive.google.com']);
const ID_RE = /^[A-Za-z0-9_-]{10,}$/;

/**
 * Extract a file/document ID and type hint from a Google Drive or Docs URL.
 * Only https URLs on docs.google.com / drive.google.com are accepted, and only
 * ids made of [A-Za-z0-9_-] (10+ chars). Account paths (/document/u/1/d/…,
 * /u/0/open?id=…) are accepted. Returns { id, kind } with kind
 * 'doc' | 'sheet' | 'file', or null.
 */
export function parseGoogleUrl(url) {
    let u;
    try {
        u = new URL(String(url).trim());
    } catch {
        return null;   // not a URL
    }
    if (u.protocol !== 'https:' || u.username || u.password || u.port || !GOOGLE_HOSTS.has(u.hostname)) return null;

    const segment = '([A-Za-z0-9_-]+)(?:[/?#]|$)';
    const account = '(?:/u/\\d{1,3})?';   // signed-in account index, e.g. /u/1
    const match = (prefix) => {
        const m = u.pathname.match(new RegExp(`^/${prefix}${account}/d/${segment}`));
        return m && ID_RE.test(m[1]) ? m[1] : null;
    };

    let id;
    // https://docs.google.com/document/d/{ID}/...  (or /document/u/1/d/{ID}/...)
    if (u.hostname === 'docs.google.com' && (id = match('document'))) return {id, kind: 'doc'};
    // https://docs.google.com/spreadsheets/d/{ID}/...
    if (u.hostname === 'docs.google.com' && (id = match('spreadsheets'))) return {id, kind: 'sheet'};
    // https://drive.google.com/file/d/{ID}/...
    if ((id = match('file'))) return {id, kind: 'file'};
    // https://drive.google.com/open?id={ID}  (or /u/0/open?id={ID})
    if (/^(?:\/u\/\d{1,3})?\/open$/.test(u.pathname)) {
        const openId = u.searchParams.get('id');
        if (openId && ID_RE.test(openId)) return {id: openId, kind: 'file'};
    }
    return null;
}

// ── Script loading ────────────────────────────────────────────────────────────

// Library globals are checked by shape: a rendered heading "## Google" has
// id="google", which makes window.google that element until GIS loads.
const gisReady = () => typeof window.google?.accounts?.oauth2?.initTokenClient === 'function';
const gapiReady = () => typeof window.gapi?.load === 'function';

function gapiLoad(lib) {
    return new Promise((resolve, reject) =>
        gapi.load(lib, {callback: resolve, onerror: () => reject(new Error(`gapi.load('${lib}') failed`))})
    );
}

// ── OAuth (Google Identity Services token flow) ───────────────────────────────

/**
 * Resolve which client ID to use: hardcoded constant wins, then passed value,
 * then localStorage fallback (for when developers haven't set the constant yet).
 */
function resolveClientId(override) {
    return GOOGLE_CLIENT_ID || override || safeGet('gd-client-id') || '';
}

function resolveApiKey(override) {
    return GOOGLE_API_KEY || override || safeGet('gd-api-key') || '';
}

/**
 * Ask Google for an access token. Rejects (never hangs) when the sign-in popup
 * is closed or blocked, or nothing happens within `timeoutMs`.
 */
async function getAccessToken({clientId, scope = SCOPE_READONLY, timeoutMs = AUTH_TIMEOUT_MS} = {}) {
    const id = resolveClientId(clientId);
    if (!id) throw new Error('No Google Client ID configured. Add one in the Credentials tab.');
    await loadScript(GIS_SRC, gisReady);
    return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (fn, value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            fn(value);
        };
        const timer = setTimeout(() => finish(reject, new Error(
            'Google sign-in timed out. Allow pop-ups for this page and try again.')), timeoutMs);
        const client = google.accounts.oauth2.initTokenClient({
            client_id: id,
            scope,
            callback: resp => {
                // Too late (timed out or failed): nobody will use this token, so drop it.
                if (settled) {
                    revokeToken(resp && resp.access_token);
                    return;
                }
                if (resp.error) finish(reject, new Error(`OAuth error: ${resp.error}`));
                else finish(resolve, resp.access_token);
            },
            // Popup closed, blocked or failed to open.
            error_callback: err => {
                const type = err && err.type;
                const msg = type === 'popup_closed' ? 'Google sign-in was closed before it finished.'
                    : type === 'popup_failed_to_open' ? 'Google sign-in could not open. Allow pop-ups for this page and try again.'
                        : 'Google sign-in failed.';
                finish(reject, new Error(msg));
            },
        });
        // prompt: '' shows the account picker only if needed, skipping it when already authorised
        client.requestAccessToken({prompt: ''});
    });
}

/** Drop the token once the import is done; it is not needed again. */
function revokeToken(token) {
    if (!token) return;
    try {
        google.accounts.oauth2.revoke(token, () => {});
    } catch { /* best effort */
    }
}

// ── File fetching ─────────────────────────────────────────────────────────────

/** Export links that work without signing in when a Doc or Sheet is shared "Anyone with the link". */
const PUBLIC_EXPORT = {
    doc: (id) => `https://docs.google.com/document/d/${encodeURIComponent(id)}/export?format=html`,
    sheet: (id) => `https://docs.google.com/spreadsheets/d/${encodeURIComponent(id)}/export?format=csv`,
};

/**
 * The Drive API URL for a file's content: a Google Doc exports as HTML, a
 * Sheet as CSV (its first sheet), anything else downloads as it is.
 */
function apiContentUrl(id, mimeType) {
    const base = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}`;
    if (mimeType === GDOC_MIME) return `${base}/export?mimeType=text%2Fhtml`;
    if (mimeType === GDOC_SHEET) return `${base}/export?mimeType=text%2Fcsv`;
    return `${base}?alt=media`;
}

/** Hosts a public export is served from, after Google's redirect. */
const EXPORT_HOST = /^(?:docs\.google\.com|[a-z0-9-]+\.googleusercontent\.com)$/;

/**
 * Try a Doc or Sheet's public export without signing in. Resolves with the
 * Response, or null when the file needs sign-in: a 401/403 or other error, a
 * redirect to a page that is not the export (the sign-in page), or a fetch that
 * fails outright (a private file redirects to accounts.google.com, which the
 * browser blocks as a CORS error).
 */
async function tryPublicExport(url) {
    let resp;
    try {
        resp = await fetch(url, {credentials: 'omit'});
    } catch {
        return null;
    }
    if (!resp.ok || resp.type === 'opaqueredirect') return null;
    let host = '';
    try {
        host = new URL(resp.url || url).hostname;
    } catch { /* no usable URL: judged by the redirect flag alone */ }
    if (resp.redirected && !EXPORT_HOST.test(host)) return null;
    return resp;
}

/**
 * Fetch a file, optionally with an access token.
 * Returns a Response or throws.
 */
async function fetchFile(url, accessToken) {
    const headers = accessToken ? {Authorization: `Bearer ${accessToken}`} : {};
    const resp = await fetch(url, {headers});
    if (!resp.ok) {
        const msg = await resp.text().catch(() => resp.statusText);
        const err = new Error(`HTTP ${resp.status}: ${msg}`);
        err.status = resp.status;
        throw err;
    }
    return resp;
}

/**
 * Get the MIME type of a Drive file using the metadata endpoint.
 * Requires an access token.
 */
async function getFileMimeType(id, accessToken) {
    const resp = await fetchFile(
        `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?fields=mimeType`,
        accessToken
    );
    const data = await resp.json();
    return data.mimeType || '';
}

// ── Conversion ────────────────────────────────────────────────────────────────

/**
 * RFC 4180 CSV rows: quoted fields may hold commas, doubled quotes ("") and
 * line breaks. A leading BOM is ignored.
 * @returns {string[][]}
 */
export function parseCsv(text) {
    let s = String(text);
    if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);   // byte order mark
    const rows = [];
    let row = [];
    let field = '';
    let quoted = false;
    for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (quoted) {
            if (c !== '"') field += c;
            else if (s[i + 1] === '"') {
                field += '"';
                i++;
            } else quoted = false;
        } else if (c === '"' && field === '') {
            quoted = true;
        } else if (c === ',') {
            row.push(field);
            field = '';
        } else if (c === '\n' || c === '\r') {
            if (c === '\r' && s[i + 1] === '\n') i++;
            row.push(field);
            rows.push(row);
            row = [];
            field = '';
        } else {
            field += c;
        }
    }
    if (field !== '' || row.length) {
        row.push(field);
        rows.push(row);
    }
    return rows;
}

/**
 * A Sheet's CSV export as a GFM table, first row as the header. Empty rows,
 * and empty columns at the right, are dropped. Cell text is escaped like any
 * imported text, through the shared Turndown table rule. At most
 * MAX_TABLE_ROWS rows are kept (header included); a longer sheet is cut, with
 * a warning through opts.onWarning.
 */
export async function csvToMarkdown(csv, opts = {}) {
    await loadTurndown();
    let rows = parseCsv(csv).filter(r => r.some(c => c.trim()));
    if (!rows.length) return '';
    if (rows.length > MAX_TABLE_ROWS) {
        warn(opts, tableLimitWarning([rows.length]));
        rows = rows.slice(0, MAX_TABLE_ROWS);
    }
    let width = maxOf(rows, r => r.length);
    while (width > 1 && rows.every(r => !(r[width - 1] || '').trim())) width--;
    const wrapper = document.createElement('div');
    const table = wrapper.appendChild(document.createElement('table'));
    for (const r of rows) {
        const tr = table.appendChild(document.createElement('tr'));
        for (let i = 0; i < width; i++) tr.appendChild(document.createElement('td')).textContent = r[i] || '';
    }
    return buildTurndown(opts).turndown(wrapper).trim();
}

/**
 * Google Docs exports wrap every link as https://www.google.com/url?q=<target>&...;
 * put the real target back so the link survives as written.
 */
export function unwrapGoogleRedirects(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    for (const a of doc.querySelectorAll('a[href]')) {
        let u;
        try {
            u = new URL(a.getAttribute('href'));
        } catch {
            continue;
        }
        const q = u.searchParams.get('q');
        if (u.protocol === 'https:' && u.hostname === 'www.google.com' && u.pathname === '/url' && q) a.setAttribute('href', q);
    }
    return '<!DOCTYPE html>' + doc.documentElement.outerHTML;
}

/**
 * Convert downloaded Drive content to Markdown by type. Resolves with null when
 * the user cancels (a PDF password prompt).
 */
async function responseToMarkdown(resp, mimeType, onProgress, opts = {}) {
    assertSupportedType(mimeType);
    const sub = (pct) => {
        if (onProgress) onProgress(70 + Math.round(pct * 0.25));
    };
    if (mimeType === 'application/pdf') {
        const blob = await resp.blob();
        return pdfToMarkdown(new File([blob], 'drive-import.pdf', {type: mimeType}), sub, opts);
    }
    if (mimeType === DOCX_MIME) {
        const blob = await resp.blob();
        const {docxToMarkdown} = await import('./docx-import.js');
        return docxToMarkdown(new File([blob], 'drive-import.docx', {type: mimeType}), sub, opts);
    }
    if (mimeType === GDOC_MIME || mimeType === 'text/html') {
        return htmlToMarkdown(unwrapGoogleRedirects(await resp.text()), sub, opts);
    }
    if (mimeType === GDOC_SHEET || mimeType === 'text/csv') {
        return csvToMarkdown(await resp.text(), opts);
    }
    // Plain text and Markdown stay as written.
    return resp.text();
}

// ── URL-based import (public-first, OAuth fallback) ───────────────────────────

/**
 * Import a document from a Google Docs / Drive URL.
 *
 * Docs and Sheets shared "Anyone with the link" need no credentials. Anything
 * else, or a public attempt that fails (private file, CORS, sign-in redirect),
 * signs in with OAuth using opts.clientId, the GOOGLE_CLIENT_ID constant or the
 * Client ID saved in the Credentials tab.
 *
 * @param {string}   url  Google Docs or Drive share URL
 * @param {{clientId?: string, authTimeoutMs?: number, onWarning?: Function,
 *          onPassword?: Function, onConfirm?: Function}} [opts]
 *        authTimeoutMs: sign-in timeout (default 60s); the callbacks are passed
 *        to the PDF and Word converters (see js/imports.js)
 * @param {Function} [onProgress]  callback(0–100)
 * @returns {Promise<string|null>}  Markdown text, or null if cancelled
 */
export async function importFromUrl(url, opts = {}, onProgress) {
    const parsed = parseGoogleUrl(url);
    if (!parsed) throw new Error('Unrecognised Google URL format');

    const {id, kind} = parsed;
    if (onProgress) onProgress(5);

    if (PUBLIC_EXPORT[kind]) {
        const resp = await tryPublicExport(PUBLIC_EXPORT[kind](id));
        if (resp) {
            if (onProgress) onProgress(70);
            const md = await responseToMarkdown(resp, kind === 'doc' ? GDOC_MIME : GDOC_SHEET, onProgress, opts);
            if (onProgress) onProgress(100);
            return md;
        }
        if (!resolveClientId(opts.clientId)) {
            throw new Error('This document could not be read without signing in, so it is probably private. ' +
                'Share it as "Anyone with the link", or add a Client ID in the Credentials tab (or set GOOGLE_CLIENT_ID in google-drive-import.js).');
        }
    }

    if (onProgress) onProgress(10);
    const token = await getAccessToken({clientId: opts.clientId, scope: SCOPE_READONLY, timeoutMs: opts.authTimeoutMs});
    try {
        if (onProgress) onProgress(25);

        // A Drive file link says nothing about the type: ask the metadata endpoint.
        const mimeType = kind === 'doc' ? GDOC_MIME : kind === 'sheet' ? GDOC_SHEET : await getFileMimeType(id, token);
        assertSupportedType(mimeType);
        if (onProgress) onProgress(35);

        const resp = await fetchFile(apiContentUrl(id, mimeType), token);
        if (onProgress) onProgress(70);

        const md = await responseToMarkdown(resp, mimeType, onProgress, opts);
        if (onProgress && md != null) onProgress(100);
        return md;
    } finally {
        revokeToken(token);
    }
}

// ── Drive Picker import ───────────────────────────────────────────────────────

/**
 * Open the Google Drive Picker, let the user select a file, and return
 * its content as a Markdown string.
 *
 * Requires both an API key and an OAuth Client ID.
 *
 * @param {{ apiKey?: string, clientId?: string, authTimeoutMs?: number }} credentials
 *        (plus the converter callbacks that importFromUrl takes)
 * @param {Function} onProgress  Optional callback(0–100)
 * @returns {Promise<string|null>}  Markdown text, or null if user cancelled
 */
export async function importFromPicker(credentials = {}, onProgress) {
    const {apiKey, clientId, authTimeoutMs} = credentials;
    const key = resolveApiKey(apiKey);
    const id = resolveClientId(clientId);
    if (!key || !id) throw new Error('Both API key and Client ID are required for the Drive Picker. Add them in the Credentials tab or set the constants in google-drive-import.js.');

    if (onProgress) onProgress(5);
    await Promise.all([loadScript(GAPI_SRC, gapiReady), loadScript(GIS_SRC, gisReady)]);
    await gapiLoad('picker');
    if (typeof window.google?.picker?.PickerBuilder !== 'function') throw new Error('Google Picker failed to load');
    if (onProgress) onProgress(15);

    const token = await getAccessToken({clientId: id, scope: SCOPE_PICKER, timeoutMs: authTimeoutMs});
    try {
        return await pickAndImport(token, key, onProgress, credentials);
    } finally {
        revokeToken(token);
    }
}

async function pickAndImport(token, key, onProgress, opts) {
    if (onProgress) onProgress(25);

    const picked = await new Promise((resolve) => {
        const view = new google.picker.DocsView()
            .setIncludeFolders(false)
            .setMimeTypes([...SUPPORTED_TYPES.keys()].join(','));

        new google.picker.PickerBuilder()
            .addView(view)
            .setOAuthToken(token)
            .setDeveloperKey(key)
            .setTitle('Select a document to import')
            .setCallback(data => {
                if (data.action === google.picker.Action.PICKED) resolve(data.docs[0]);
                if (data.action === google.picker.Action.CANCEL) resolve(null);
            })
            .build()
            .setVisible(true);
    });

    if (!picked) return null; // user cancelled
    assertSupportedType(picked.mimeType);
    if (onProgress) onProgress(35);

    const resp = await fetchFile(apiContentUrl(picked.id, picked.mimeType), token);
    if (onProgress) onProgress(70);

    const md = await responseToMarkdown(resp, picked.mimeType, onProgress, opts);
    if (onProgress && md != null) onProgress(100);
    return md;
}
