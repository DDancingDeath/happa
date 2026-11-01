// Small QR code encoder for the bill QR on printed receipts (#107): byte mode,
// error correction level M, versions 1–5 (up to 84 bytes). Pure, no DOM.

const MAX_VERSION = 5;
// Level M, versions 1–5: EC codewords per block and number of blocks.
const ECC_PER_BLOCK = [0, 10, 16, 26, 18, 24];
const NUM_BLOCKS = [0, 1, 1, 1, 2, 2];
const ALIGN_AT = [[], [], [6, 18], [6, 22], [6, 26], [6, 30]];
const FORMAT_LEVEL_M = 0;

const rawDataModules = (ver) => {
    let n = (16 * ver + 128) * ver + 64;
    if (ver >= 2) {
        const align = Math.floor(ver / 7) + 2;
        n -= (25 * align - 10) * align - 55;
    }
    return n;
};
const totalCodewords = (ver) => Math.floor(rawDataModules(ver) / 8);
const dataCodewords = (ver) => totalCodewords(ver) - ECC_PER_BLOCK[ver] * NUM_BLOCKS[ver];

function utf8(text) {
    const out = [];
    for (const ch of text) {
        const c = ch.codePointAt(0);
        if (c < 0x80) out.push(c);
        else if (c < 0x800) out.push(0xC0 | (c >> 6), 0x80 | (c & 63));
        else if (c < 0x10000) out.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
        else out.push(0xF0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return out;
}

/** Most bytes one QR (level M, version ≤ 5) can hold. */
export const QR_MAX_BYTES = dataCodewords(MAX_VERSION) - 2;

function gfMultiply(x, y) {
    let z = 0;
    for (let i = 7; i >= 0; i--) {
        z = (z << 1) ^ ((z >>> 7) * 0x11D);
        z ^= ((y >>> i) & 1) * x;
    }
    return z & 0xFF;
}

function rsDivisor(degree) {
    const result = new Array(degree).fill(0);
    result[degree - 1] = 1;
    let root = 1;
    for (let i = 0; i < degree; i++) {
        for (let j = 0; j < degree; j++) {
            result[j] = gfMultiply(result[j], root);
            if (j + 1 < degree) result[j] ^= result[j + 1];
        }
        root = gfMultiply(root, 0x02);
    }
    return result;
}

function rsRemainder(data, divisor) {
    const result = new Array(divisor.length).fill(0);
    for (const b of data) {
        const factor = b ^ result.shift();
        result.push(0);
        divisor.forEach((coef, i) => { result[i] ^= gfMultiply(coef, factor); });
    }
    return result;
}

function dataWithEcc(bytes, ver) {
    const capacity = dataCodewords(ver);
    const bits = [];
    const put = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
    put(0b0100, 4);
    put(bytes.length, 8);
    bytes.forEach(b => put(b, 8));
    put(0, Math.min(4, capacity * 8 - bits.length));
    put(0, (8 - (bits.length % 8)) % 8);
    const data = [];
    for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
    for (let pad = 0xEC; data.length < capacity; pad ^= 0xEC ^ 0x11) data.push(pad);

    const numBlocks = NUM_BLOCKS[ver];
    const eccLen = ECC_PER_BLOCK[ver];
    const raw = totalCodewords(ver);
    const numShort = numBlocks - (raw % numBlocks);
    const shortLen = Math.floor(raw / numBlocks);
    const divisor = rsDivisor(eccLen);
    const blocks = [];
    for (let i = 0, k = 0; i < numBlocks; i++) {
        const dat = data.slice(k, k + shortLen - eccLen + (i < numShort ? 0 : 1));
        k += dat.length;
        const ecc = rsRemainder(dat, divisor);
        if (i < numShort) dat.push(0);
        blocks.push(dat.concat(ecc));
    }
    const out = [];
    for (let i = 0; i < blocks[0].length; i++) {
        blocks.forEach((block, j) => {
            if (i !== shortLen - eccLen || j >= numShort) out.push(block[i]);
        });
    }
    return out;
}

const MASKS = [
    (x, y) => (x + y) % 2 === 0,
    (x, y) => y % 2 === 0,
    (x) => x % 3 === 0,
    (x, y) => (x + y) % 3 === 0,
    (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
    (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
    (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
    (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0
];

function buildBase(ver) {
    const size = ver * 4 + 17;
    const modules = Array.from({ length: size }, () => new Array(size).fill(false));
    const fn = Array.from({ length: size }, () => new Array(size).fill(false));
    const set = (x, y, dark) => { modules[y][x] = dark; fn[y][x] = true; };

    for (let i = 0; i < size; i++) {
        set(6, i, i % 2 === 0);
        set(i, 6, i % 2 === 0);
    }
    const finder = (cx, cy) => {
        for (let dy = -4; dy <= 4; dy++) {
            for (let dx = -4; dx <= 4; dx++) {
                const x = cx + dx;
                const y = cy + dy;
                if (x < 0 || y < 0 || x >= size || y >= size) continue;
                const d = Math.max(Math.abs(dx), Math.abs(dy));
                set(x, y, d !== 2 && d !== 4);
            }
        }
    };
    finder(3, 3);
    finder(size - 4, 3);
    finder(3, size - 4);
    const align = ALIGN_AT[ver];
    align.forEach((ay, i) => align.forEach((ax, j) => {
        const last = align.length - 1;
        if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
        for (let dy = -2; dy <= 2; dy++) {
            for (let dx = -2; dx <= 2; dx++) set(ax + dx, ay + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
    }));
    // Format areas are reserved here and written after the mask is chosen.
    drawFormat(modules, fn, 0);
    return { size, modules, fn };
}

function drawFormat(modules, fn, mask) {
    const size = modules.length;
    const data = (FORMAT_LEVEL_M << 3) | mask;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412;
    const bit = (i) => ((bits >>> i) & 1) !== 0;
    const set = (x, y, dark) => { modules[y][x] = dark; fn[y][x] = true; };
    for (let i = 0; i <= 5; i++) set(8, i, bit(i));
    set(8, 7, bit(6));
    set(8, 8, bit(7));
    set(7, 8, bit(8));
    for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
    set(8, size - 8, true);
}

function placeCodewords(modules, fn, codewords) {
    const size = modules.length;
    let i = 0;
    for (let right = size - 1; right >= 1; right -= 2) {
        if (right === 6) right = 5;
        for (let vert = 0; vert < size; vert++) {
            for (let j = 0; j < 2; j++) {
                const x = right - j;
                const upward = ((right + 1) & 2) === 0;
                const y = upward ? size - 1 - vert : vert;
                if (!fn[y][x] && i < codewords.length * 8) {
                    modules[y][x] = ((codewords[i >>> 3] >>> (7 - (i & 7))) & 1) !== 0;
                    i++;
                }
            }
        }
    }
}

function applyMask(modules, fn, mask) {
    const size = modules.length;
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            if (!fn[y][x] && MASKS[mask](x, y)) modules[y][x] = !modules[y][x];
        }
    }
}

/** ISO 18004 penalty (runs, 2×2 blocks, finder-like patterns, dark balance); lower is better. */
function penalty(modules) {
    const size = modules.length;
    let score = 0;
    const lines = [];
    for (let y = 0; y < size; y++) lines.push(modules[y]);
    for (let x = 0; x < size; x++) lines.push(modules.map(row => row[x]));
    const finderLike = [true, false, true, true, true, false, true];
    for (const line of lines) {
        let run = 1;
        for (let i = 1; i <= size; i++) {
            if (i < size && line[i] === line[i - 1]) {
                run++;
            } else {
                if (run >= 5) score += run - 2;
                run = 1;
            }
        }
        for (let i = 0; i + 7 <= size; i++) {
            if (!finderLike.every((v, k) => line[i + k] === v)) continue;
            const lightBefore = i >= 4 && [1, 2, 3, 4].every(k => !line[i - k]);
            const lightAfter = i + 11 <= size && [7, 8, 9, 10].every(k => !line[i + k]);
            if (lightBefore || lightAfter) score += 40;
        }
    }
    let dark = 0;
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            if (modules[y][x]) dark++;
            if (x + 1 < size && y + 1 < size) {
                const c = modules[y][x];
                if (c === modules[y][x + 1] && c === modules[y + 1][x] && c === modules[y + 1][x + 1]) score += 3;
            }
        }
    }
    const total = size * size;
    score += Math.max(0, Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
    return score;
}

/**
 * QR modules for `text` (UTF-8), or null when it doesn't fit.
 * @param {string} text
 * @param {{mask?: number, version?: number}} [options] fixed mask / minimum version (tests)
 * @returns {{version: number, mask: number, size: number, modules: boolean[][]}|null} modules[y][x], true = dark
 */
export function encodeQr(text, { mask: fixedMask, version: minVersion = 1 } = {}) {
    const bytes = utf8(String(text));
    let ver = Math.max(1, minVersion);
    while (ver <= MAX_VERSION && bytes.length > dataCodewords(ver) - 2) ver++;
    if (ver > MAX_VERSION) return null;
    const codewords = dataWithEcc(bytes, ver);
    let best = null;
    const masks = fixedMask === undefined ? [0, 1, 2, 3, 4, 5, 6, 7] : [fixedMask];
    for (const mask of masks) {
        const { size, modules, fn } = buildBase(ver);
        placeCodewords(modules, fn, codewords);
        applyMask(modules, fn, mask);
        drawFormat(modules, fn, mask);
        const score = masks.length > 1 ? penalty(modules) : 0;
        if (!best || score < best.score) best = { version: ver, mask, size, modules, score };
    }
    const qr = { version: best.version, mask: best.mask, size: best.size, modules: best.modules };
    return qr;
}
