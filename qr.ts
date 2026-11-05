/**
 * A small QR code encoder: byte mode, error correction level M, versions 1–10 (up to 213 bytes), drawn as SVG.
 * Enough for a link. Follows ISO/IEC 18004 the way Project Nayuki's QR generator lays it out.
 */

const MAX_VERSION = 10;
// Level M, by version (index 0 unused): error correction codewords per block, and the number of blocks.
const ECC_PER_BLOCK = [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26];
const BLOCKS = [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5];
const ECL_M = 0b00;

/** Modules left for data and error correction once the function patterns are drawn. */
function rawModules(ver: number) {
	let n = (16 * ver + 128) * ver + 64;
	if (ver >= 2) {
		const align = Math.floor(ver / 7) + 2;
		n -= (25 * align - 10) * align - 55;
		if (ver >= 7) n -= 36;
	}
	return n;
}
const dataCodewords = (ver: number) => Math.floor(rawModules(ver) / 8) - ECC_PER_BLOCK[ver] * BLOCKS[ver];

function alignmentPositions(ver: number, size: number) {
	if (ver === 1) return [];
	const count = Math.floor(ver / 7) + 2;
	const step = Math.ceil((ver * 4 + 4) / (count * 2 - 2)) * 2;
	const out = [6];
	for (let pos = size - 7; out.length < count; pos -= step) out.splice(1, 0, pos);
	return out;
}

// Reed–Solomon over GF(2^8) with the polynomial 0x11D.
function gfMul(x: number, y: number) {
	let z = 0;
	for (let i = 7; i >= 0; i--) {
		z = (z << 1) ^ ((z >>> 7) * 0x11d);
		z ^= ((y >>> i) & 1) * x;
	}
	return z;
}
function rsDivisor(degree: number) {
	const out = new Array(degree).fill(0);
	out[degree - 1] = 1;
	let root = 1;
	for (let i = 0; i < degree; i++) {
		for (let j = 0; j < degree; j++) {
			out[j] = gfMul(out[j], root);
			if (j + 1 < degree) out[j] ^= out[j + 1];
		}
		root = gfMul(root, 0x02);
	}
	return out;
}
export function rsRemainder(data: number[], degree: number) {
	const divisor = rsDivisor(degree);
	const out = new Array(degree).fill(0);
	for (const b of data) {
		const factor = b ^ out.shift()!;
		out.push(0);
		divisor.forEach((c, i) => (out[i] ^= gfMul(c, factor)));
	}
	return out;
}

/** The 15 format bits for level M and a mask, BCH-coded and XOR-masked. */
export function formatBits(mask: number) {
	const data = (ECL_M << 3) | mask;
	let rem = data;
	for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
	return ((data << 10) | rem) ^ 0x5412;
}

const MASKS: ((x: number, y: number) => boolean)[] = [
	(x, y) => (x + y) % 2 === 0,
	(x, y) => y % 2 === 0,
	(x) => x % 3 === 0,
	(x, y) => (x + y) % 3 === 0,
	(x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
	(x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
	(x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
	(x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

/** The module matrix (true = dark), indexed [row][column]. */
export function qrMatrix(text: string): boolean[][] {
	const bytes = [...new TextEncoder().encode(text)];
	let ver = 1;
	const countBits = (v: number) => (v <= 9 ? 8 : 16);
	while (4 + countBits(ver) + bytes.length * 8 > dataCodewords(ver) * 8) {
		if (++ver > MAX_VERSION) throw new Error("too long for a QR code here");
	}

	// Data codewords: mode, length, bytes, terminator, then pad bytes.
	const capacity = dataCodewords(ver) * 8;
	const bits: number[] = [];
	const put = (val: number, len: number) => {
		for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1);
	};
	put(0b0100, 4);
	put(bytes.length, countBits(ver));
	for (const b of bytes) put(b, 8);
	put(0, Math.min(4, capacity - bits.length));
	put(0, (8 - (bits.length % 8)) % 8);
	for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) put(pad, 8);
	const data: number[] = [];
	for (let i = 0; i < bits.length; i += 8) data.push(parseInt(bits.slice(i, i + 8).join(""), 2));

	// Blocks (the last ones one codeword longer), each with its error correction, then interleaved.
	const nBlocks = BLOCKS[ver];
	const ecc = ECC_PER_BLOCK[ver];
	const raw = Math.floor(rawModules(ver) / 8);
	const shortLen = Math.floor(raw / nBlocks) - ecc;
	const nShort = nBlocks - (raw % nBlocks);
	const blocks: number[][] = [];
	for (let i = 0, k = 0; i < nBlocks; i++) {
		const len = shortLen + (i < nShort ? 0 : 1);
		blocks.push(data.slice(k, k + len));
		k += len;
	}
	const codewords: number[] = [];
	for (let i = 0; i <= shortLen; i++) for (const b of blocks) if (i < b.length) codewords.push(b[i]);
	const eccs = blocks.map((b) => rsRemainder(b, ecc));
	for (let i = 0; i < ecc; i++) for (const e of eccs) codewords.push(e[i]);

	// Function patterns.
	const size = ver * 4 + 17;
	const m: boolean[][] = Array.from({ length: size }, () => new Array(size).fill(false));
	const fn: boolean[][] = Array.from({ length: size }, () => new Array(size).fill(false));
	const set = (x: number, y: number, dark: boolean) => {
		m[y][x] = dark;
		fn[y][x] = true;
	};
	for (let i = 0; i < size; i++) {
		set(6, i, i % 2 === 0);
		set(i, 6, i % 2 === 0);
	}
	for (const [cx, cy] of [
		[3, 3],
		[size - 4, 3],
		[3, size - 4],
	]) {
		for (let dy = -4; dy <= 4; dy++)
			for (let dx = -4; dx <= 4; dx++) {
				const x = cx + dx,
					y = cy + dy;
				const d = Math.max(Math.abs(dx), Math.abs(dy));
				if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, d !== 2 && d !== 4);
			}
	}
	const align = alignmentPositions(ver, size);
	const last = align.length - 1;
	align.forEach((ax, i) =>
		align.forEach((ay, j) => {
			if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
			for (let dy = -2; dy <= 2; dy++)
				for (let dx = -2; dx <= 2; dx++) set(ax + dx, ay + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
		}),
	);
	const drawFormat = (mask: number) => {
		const f = formatBits(mask);
		const bit = (i: number) => ((f >>> i) & 1) === 1;
		for (let i = 0; i <= 5; i++) set(8, i, bit(i));
		set(8, 7, bit(6));
		set(8, 8, bit(7));
		set(7, 8, bit(8));
		for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
		for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
		for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
		set(8, size - 8, true); // the dark module
	};
	drawFormat(0); // reserves the area; drawn again with the chosen mask
	if (ver >= 7) {
		let rem = ver;
		for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
		const v = (ver << 12) | rem;
		for (let i = 0; i < 18; i++) {
			const dark = ((v >>> i) & 1) === 1;
			const a = size - 11 + (i % 3),
				b = Math.floor(i / 3);
			set(a, b, dark);
			set(b, a, dark);
		}
	}

	// Data, in the zigzag: two columns at a time from the right, alternating up and down, skipping column 6.
	let i = 0;
	for (let right = size - 1; right >= 1; right -= 2) {
		if (right === 6) right = 5;
		for (let vert = 0; vert < size; vert++)
			for (let j = 0; j < 2; j++) {
				const x = right - j;
				const y = ((right + 1) & 2) === 0 ? size - 1 - vert : vert;
				if (!fn[y][x] && i < codewords.length * 8) {
					m[y][x] = ((codewords[i >>> 3] >>> (7 - (i & 7))) & 1) === 1;
					i++;
				}
			}
	}

	// The mask with the lowest penalty.
	const applyMask = (k: number) => {
		for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!fn[y][x] && MASKS[k](x, y)) m[y][x] = !m[y][x];
	};
	let best = 0,
		bestScore = Infinity;
	for (let k = 0; k < 8; k++) {
		applyMask(k);
		drawFormat(k);
		const score = penalty(m);
		if (score < bestScore) [best, bestScore] = [k, score];
		applyMask(k); // undo
	}
	applyMask(best);
	drawFormat(best);
	return m;
}

function penalty(m: boolean[][]) {
	const size = m.length;
	let score = 0;
	const lines = [...m.map((row) => row), ...m.map((_, x) => m.map((row) => row[x]))];
	for (const line of lines) {
		// Runs of five or more alike.
		let run = 1;
		for (let i = 1; i <= size; i++) {
			if (i < size && line[i] === line[i - 1]) run++;
			else {
				if (run >= 5) score += run - 2;
				run = 1;
			}
		}
		// Finder-like patterns, with four light modules on either side (the quiet zone counts as light).
		const s = "0000" + line.map((d) => (d ? "1" : "0")).join("") + "0000";
		for (const pat of ["00001011101", "10111010000"])
			for (let at = s.indexOf(pat); at >= 0; at = s.indexOf(pat, at + 1)) score += 40;
	}
	// 2×2 blocks alike.
	for (let y = 0; y < size - 1; y++)
		for (let x = 0; x < size - 1; x++) {
			const c = m[y][x];
			if (c === m[y][x + 1] && c === m[y + 1][x] && c === m[y + 1][x + 1]) score += 3;
		}
	// Balance of dark and light.
	const dark = m.flat().filter(Boolean).length;
	const total = size * size;
	score += Math.floor(Math.abs(dark * 20 - total * 10) / total) * 10;
	return score;
}

/** An SVG of the code, black on white with the 4-module quiet zone, scaled by its container. */
export function qrSvg(text: string) {
	const m = qrMatrix(text);
	const n = m.length + 8;
	let path = "";
	m.forEach((row, y) => row.forEach((dark, x) => dark && (path += `M${x + 4} ${y + 4}h1v1h-1z`)));
	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" shape-rendering="crispEdges" role="img" aria-label="QR code"><rect width="${n}" height="${n}" fill="#fff"/><path d="${path}" fill="#000"/></svg>`;
}
