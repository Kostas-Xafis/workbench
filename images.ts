/**
 * Screenshots on items: what agents attach to show a problem instead of describing it. They live in the database,
 * like link icons, so backups and restores keep them; large ones are shrunk first, because every backup holds them.
 */
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { addNote, type Db } from "./db";

/** The most we take in, before shrinking. */
export const MAX_IMAGE = 20 * 1024 * 1024;
/** Above this size a picture is re-encoded; below it, it's kept exactly as it came. */
const KEEP_UNDER = 500 * 1024;
/** Still sharp enough to read a phone screenshot's small print, at a fraction of the size. */
const LONG_SIDE = 2000;

export type ImageInfo = { id: number; item_id: number; caption: string; type: string; size: number; width: number; height: number; author: string; at: string };
const INFO = "id, item_id, caption, type, size, width, height, author, at";

export function createTables(db: Db) {
	// AUTOINCREMENT: the board caches an image by its id, so a removed image's id must not come back.
	db.run(`CREATE TABLE IF NOT EXISTS images (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
		caption TEXT NOT NULL DEFAULT '',
		type TEXT NOT NULL,
		size INTEGER NOT NULL,
		width INTEGER NOT NULL DEFAULT 0,
		height INTEGER NOT NULL DEFAULT 0,
		data BLOB NOT NULL,
		author TEXT NOT NULL DEFAULT '',
		at TEXT NOT NULL DEFAULT (datetime('now'))
	)`);
	db.run("CREATE INDEX IF NOT EXISTS images_item ON images(item_id)");
}

/** By the file's first bytes, never its name: this is what stops anything but a picture getting in. No SVG, it can run scripts. */
function sniff(b: Uint8Array): string | undefined {
	const at = (offset: number, ...bytes: number[]) => bytes.every((x, i) => b[offset + i] === x);
	if (at(0, 0x89, 0x50, 0x4e, 0x47)) return "image/png";
	if (at(0, 0xff, 0xd8, 0xff)) return "image/jpeg";
	if (at(0, 0x47, 0x49, 0x46, 0x38)) return "image/gif";
	if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return "image/webp";
	return undefined;
}

export type Prepared = { data: Uint8Array; type: string; width: number; height: number };

/** Checks a picture and shrinks it if it's large. Refuses what isn't a PNG, JPEG, WebP or GIF. */
export async function prepareImage(bytes: Uint8Array, label = "that file"): Promise<Prepared> {
	const type = sniff(bytes);
	if (!type) throw new Error(`${label} isn't a PNG, JPEG, WebP or GIF image`);
	if (bytes.length > MAX_IMAGE) throw new Error(`${label} is over ${MAX_IMAGE / 1024 / 1024} MB`);
	let width = 0;
	let height = 0;
	try {
		({ width, height } = await new Bun.Image(bytes).metadata());
		// A GIF may be an animation, which re-encoding would flatten.
		if (bytes.length > KEEP_UNDER && type !== "image/gif") {
			const scale = Math.min(1, LONG_SIDE / Math.max(width, height));
			const w = Math.round(width * scale);
			const h = Math.round(height * scale);
			const small = await new Bun.Image(bytes).resize(w, h).webp({ quality: 85 }).bytes();
			if (small.length < bytes.length) return { data: small, type: "image/webp", width: w, height: h };
		}
	} catch {
		// A picture the decoder can't read may still show in a browser: keep it as it came.
	}
	return { data: bytes, type, width, height };
}

/** The bytes of a file on this computer, or of base64 (with or without a data: prefix). */
export function imageBytes(src: { path?: string; data?: string }): { bytes: Uint8Array; label: string } {
	if (src.path?.trim()) {
		const path = resolve(src.path.trim().replace(/^~(?=\/|$)/, homedir()));
		let size: number;
		try {
			const s = statSync(path);
			if (!s.isFile()) throw new Error();
			size = s.size;
		} catch {
			throw new Error(`no file at ${path}`);
		}
		if (size > MAX_IMAGE) throw new Error(`${path} is over ${MAX_IMAGE / 1024 / 1024} MB`);
		return { bytes: readFileSync(path), label: path };
	}
	if (src.data?.trim()) return { bytes: Buffer.from(src.data.trim().replace(/^data:[^,]*,/, ""), "base64"), label: "that data" };
	throw new Error("give an image: path (a file on this computer) or data (base64)");
}

export function addImage(db: Db, itemId: number, image: Prepared, caption: string, author = ""): number {
	const { id } = db
		.query("INSERT INTO images (item_id, caption, type, size, width, height, data, author) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id")
		.get(itemId, caption.trim(), image.type, image.data.length, image.width, image.height, image.data, author) as { id: number };
	addNote(db, itemId, `image added: ${caption.trim() || "no caption"}`, author);
	return id;
}

export const itemImages = (db: Db, itemId: number) =>
	db.query(`SELECT ${INFO} FROM images WHERE item_id = ? ORDER BY id`).all(itemId) as ImageInfo[];

export const imageInfo = (db: Db, id: number) => db.query(`SELECT ${INFO} FROM images WHERE id = ?`).get(id) as ImageInfo | null;

export const imageData = (db: Db, id: number) =>
	db.query("SELECT type, data FROM images WHERE id = ?").get(id) as { type: string; data: Uint8Array } | null;

/** Rewords an image's caption and returns the item it's on. */
export function setImageCaption(db: Db, id: number, caption: string, author = ""): number {
	const info = imageInfo(db, id);
	if (!info) throw new Error(`no image ${id}`);
	if (info.caption === caption.trim()) return info.item_id;
	db.query("UPDATE images SET caption = ? WHERE id = ?").run(caption.trim(), id);
	addNote(db, info.item_id, `image caption: ${caption.trim() || "no caption"}`, author);
	return info.item_id;
}

/** Removes an image and returns the item it was on; its history keeps the line saying so. */
export function removeImage(db: Db, id: number, author = ""): number {
	const info = imageInfo(db, id);
	if (!info) throw new Error(`no image ${id}`);
	db.query("DELETE FROM images WHERE id = ?").run(id);
	addNote(db, info.item_id, `image removed: ${info.caption || "no caption"}`, author);
	return info.item_id;
}

export const imageSummary = (i: ImageInfo) =>
	`image ${i.id}: ${i.caption || "no caption"} (${i.width && i.height ? `${i.width}×${i.height}, ` : ""}${Math.max(1, Math.round(i.size / 1024))} KB)`;
