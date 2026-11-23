/**
 * The PDF's document information (pdfinfo's Title, Author, Subject, Creator,
 * Producer), written as an incremental update: a new Info dictionary, an xref
 * section for it and a trailer that points at it, appended after Chromium's
 * own %%EOF. Chromium writes the title (from <title>) and the language (from
 * <html lang>, the catalog's /Lang) itself, but no author or subject, and it
 * names itself as Creator and Producer with a version number. The old Info
 * dictionary is blanked in place (same length, so every offset stays right),
 * keeping only its dates.
 *
 * A PDF this code does not recognise (no classic xref table and trailer) is
 * returned unchanged.
 */

export const CREATOR = 'PrintMD';

/** A PDF text string: a literal for printable ASCII, else UTF-16BE hex with a byte order mark. */
export function pdfString(value) {
    const text = String(value);
    if (/^[\x20-\x7e]*$/.test(text)) return `(${text.replace(/[\\()]/g, (c) => `\\${c}`)})`;
    let hex = 'FEFF';
    for (let i = 0; i < text.length; i++) hex += text.charCodeAt(i).toString(16).padStart(4, '0').toUpperCase();
    return `<${hex}>`;
}

/** A PDF string token, literal or hex, as text (UTF-16BE with a byte order mark, else Latin-1). */
export function decodePdfString(token) {
    if (token.startsWith('<')) {
        const hex = token.slice(1, -1).replace(/\s+/g, '');
        const bytes = Buffer.from(hex.length % 2 ? `${hex}0` : hex, 'hex');
        if (bytes[0] === 0xfe && bytes[1] === 0xff) {
            let out = '';
            for (let i = 2; i + 1 < bytes.length; i += 2) out += String.fromCharCode(bytes.readUInt16BE(i));
            return out;
        }
        return bytes.toString('latin1');
    }
    return token.slice(1, -1).replace(/\\([\\()])/g, '$1');
}

const squash = (s) => s.replace(/\s+/g, ' ').trim().toLowerCase();
const OUTLINE_ITEM_RE = /(\d+) (\d+) obj\s*(<<\/Title\s*(\((?:\\.|[^\\)])*\)|<[0-9A-Fa-f\s]*>)[^]*?)\s*endobj/g;

/**
 * Outline items whose title is the first heading twice over ("OverviewOverview"):
 * Chromium writes the first heading after a cover page that way. Each comes
 * back as {num, gen, dict} with the title written once.
 */
function doubledOutlineItems(text, firstHeading) {
    const want = squash(firstHeading || '');
    if (!want) return [];
    const out = [];
    for (const m of text.matchAll(OUTLINE_ITEM_RE)) {
        if (!m[3].includes('/Parent')) continue;
        const title = decodePdfString(m[4]);
        const half = title.slice(0, title.length / 2);
        if (title.length % 2 === 0 && half + half === title && squash(half) === want) {
            // A replacer function: a string would expand $' $& $` $1 found in the heading.
            const title1 = pdfString(half);
            out.push({num: Number(m[1]), gen: Number(m[2]), dict: m[3].replace(m[4], () => title1)});
        }
    }
    return out;
}

/** Byte offset of object `num` from the classic xref table at `xrefAt`, or -1. */
function objectOffset(text, xrefAt, num) {
    if (text.slice(xrefAt, xrefAt + 4) !== 'xref') return -1;
    const re = /(\d+)[ ]+(\d+)[ \t]*\r?\n/y;
    let pos = text.indexOf('\n', xrefAt) + 1;
    for (;;) {
        re.lastIndex = pos;
        const m = re.exec(text);
        if (!m) return -1;
        const first = Number(m[1]);
        const count = Number(m[2]);
        pos = re.lastIndex;
        if (num >= first && num < first + count) {
            const entry = text.slice(pos + (num - first) * 20, pos + (num - first) * 20 + 18);
            const em = /^(\d{10}) (\d{5}) n/.exec(entry);
            return em ? Number(em[1]) : -1;
        }
        pos += count * 20;
    }
}

/**
 * @param {Buffer|Uint8Array} pdf
 * @param {{title?: string, author?: string, subject?: string, firstHeading?: string}} info
 *        empty values are left out; firstHeading: the text of the body's first heading, whose
 *        outline item is repaired when Chromium wrote it twice
 * @returns {Buffer}
 */
export function setPdfInfo(pdf, {title = '', author = '', subject = '', firstHeading = ''} = {}) {
    const buffer = Buffer.from(pdf);
    const text = buffer.toString('latin1');
    if (!text.startsWith('%PDF-')) return buffer;
    const trailerAt = text.lastIndexOf('trailer');
    const startxrefAt = text.lastIndexOf('startxref');
    if (trailerAt < 0 || startxrefAt < trailerAt) return buffer;
    const trailer = text.slice(trailerAt, startxrefAt);
    const size = /\/Size\s+(\d+)/.exec(trailer);
    const root = /\/Root\s+(\d+\s+\d+\s+R)/.exec(trailer);
    const prev = /startxref\s+(\d+)/.exec(text.slice(startxrefAt));
    if (!size || !root || !prev) return buffer;
    const id = /\/ID\s*(\[[^\]]*\])/.exec(trailer);

    // The old dictionary: keep its dates, blank the rest in place.
    const dates = [];
    const old = /\/Info\s+(\d+)\s+(\d+)\s+R/.exec(trailer);
    if (old) {
        const at = objectOffset(text, Number(prev[1]), Number(old[1]));
        const head = at >= 0 ? new RegExp(`^${old[1]}\\s+${old[2]}\\s+obj\\s*`).exec(text.slice(at, at + 40)) : null;
        const end = head ? text.indexOf('endobj', at) : -1;
        if (head && end > 0) {
            const start = at + head[0].length;
            const dict = text.slice(start, end);
            for (const key of ['CreationDate', 'ModDate']) {
                const m = new RegExp(`/${key}\\s*(\\([^)]*\\))`).exec(dict);
                if (m) dates.push(`/${key} ${m[1]}`);
            }
            const blank = '<<>>'.padEnd(end - start, ' ');
            if (dict.trimEnd().startsWith('<<') && blank.length === end - start) buffer.write(blank.slice(0, -1) + '\n', start, 'latin1');
        }
    }

    const entries = [
        title ? `/Title ${pdfString(title)}` : '',
        author ? `/Author ${pdfString(author)}` : '',
        subject ? `/Subject ${pdfString(subject)}` : '',
        `/Creator ${pdfString(CREATOR)}`,
        `/Producer ${pdfString(CREATOR)}`,
        ...dates,
    ].filter(Boolean).join('\n');
    const num = Number(size[1]);
    const lead = text.endsWith('\n') ? '' : '\n';
    // The objects of the update: repaired outline items (same numbers, so they replace
    // the old ones), then the new Info dictionary.
    const objects = [
        ...doubledOutlineItems(text, firstHeading).map((o) => ({num: o.num, gen: o.gen, body: o.dict})),
        {num, gen: 0, body: `<<${entries}>>`},
    ];
    let at = buffer.length + lead.length;
    let body = '';
    for (const o of objects) {
        o.at = at;
        const s = `${o.num} ${o.gen} obj\n${o.body}\nendobj\n`;
        body += s;
        at += Buffer.byteLength(s, 'latin1');
    }
    const xref = objects.map((o) => `${o.num} 1\n${String(o.at).padStart(10, '0')} ${String(o.gen).padStart(5, '0')} n \n`).join('');
    const tail = `xref\n${xref}`
        + `trailer\n<</Size ${num + 1} /Root ${root[1]} /Info ${num} 0 R${id ? ` /ID ${id[1]}` : ''} /Prev ${prev[1]}>>\n`
        + `startxref\n${at}\n%%EOF\n`;
    return Buffer.concat([buffer, Buffer.from(lead + body + tail, 'latin1')]);
}
