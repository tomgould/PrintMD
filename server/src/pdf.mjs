/**
 * Page count of a PDF produced by Chromium: its page objects (/Type /Page,
 * not the /Pages tree nodes). Chromium writes page dictionaries uncompressed,
 * and the integration tests check this count against pdfinfo.
 */
export function countPdfPages(buffer) {
    const text = Buffer.from(buffer).toString('latin1');
    if (!text.startsWith('%PDF-')) return 0;
    return (text.match(/\/Type\s*\/Page(?![A-Za-z])/g) || []).length;
}
