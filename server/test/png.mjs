/**
 * Test images: a greyscale PNG of any size, built with zlib (no dependencies).
 * Rows repeat, so even a 6000 px wide image is a small file.
 */
import {crc32, deflateSync} from 'node:zlib';

function chunk(type, data) {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, 'latin1');
    data.copy(out, 8);
    out.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'latin1'), data])), 8 + data.length);
    return out;
}

/**
 * @param {number} width
 * @param {number} height
 * @returns {Buffer} an 8-bit greyscale PNG with a horizontal gradient
 */
export function makePng(width, height) {
    const header = Buffer.alloc(13);
    header.writeUInt32BE(width, 0);
    header.writeUInt32BE(height, 4);
    header[8] = 8; // bit depth
    header[9] = 0; // greyscale
    const row = Buffer.alloc(width + 1);
    for (let x = 0; x < width; x++) row[x + 1] = 40 + Math.round((x / Math.max(1, width - 1)) * 160);
    const raw = Buffer.concat(Array.from({length: height}, () => row));
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', header),
        chunk('IDAT', deflateSync(raw)),
        chunk('IEND', Buffer.alloc(0)),
    ]);
}

/** The PNG as a data: URI. */
export function pngDataUri(width, height) {
    return `data:image/png;base64,${makePng(width, height).toString('base64')}`;
}
