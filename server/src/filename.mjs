/**
 * The download name in Content-Disposition: the editor's file-name rule
 * (js/download.js toFilenameSafe), then reduced to plain ASCII so the header
 * needs no encoding and cannot carry quotes, CR/LF or path characters.
 */
import {toFilenameSafe} from '../../js/download.js';

const MAX_BASE = 80;

/**
 * @param {string} title
 * @returns {string}  e.g. "Quarterly Report.pdf"
 */
export function safeFilename(title) {
    const ascii = String(title == null ? '' : title)
        .normalize('NFKD')
        .replace(/\p{M}/gu, '')
        .replace(/[^A-Za-z0-9 ._()-]+/g, ' ');
    const base = toFilenameSafe(ascii, 'document', MAX_BASE);
    return `${base}.pdf`;
}
