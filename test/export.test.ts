import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	addItem,
	addLink,
	addNote,
	DAY_PAGE_MARK,
	open,
	publishReport,
	reportHtml,
	PART_CHARS,
	type Db,
} from "../src/db";
import { addImage } from "../src/images";
import { waitOn } from "../src/links";
import { addTracker, recordReading } from "../src/trackers";
import { addRuling } from "../src/rulings";
import { addGoal } from "../src/goals";
import { getSettings, updateSettings } from "../src/settings";
import { tableNames } from "../src/sync";
import { runCli } from "../src/cli";
import {
	exportFileLines,
	exportKind,
	exportLines,
	exportOrder,
	exportStream,
	importExport,
	linesOf,
	localTarget,
	tableRows,
	v1Lines,
} from "../src/export";
import { freshDb } from "./helpers";

const png = Buffer.from(
	"89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000001e221bc330000000049454e44ae426082",
	"hex",
);

/** A new, empty board on this computer's SQLite: where an import goes (it always runs on a computer). */
function emptyBoard(): Db {
	const dir = mkdtempSync(join(process.env.WB_TEST_DIR!, "import-"));
	return open(join(dir, "workbench.db"));
}

/** A board with some of everything: notes, pictures, links with an icon, waiting, a long page in parts, trackers, goals, rulings, settings, the vault. */
function fullBoard(): Db {
	const db = freshDb();
	db.query("INSERT INTO projects (slug, name, path) VALUES ('two', 'Two', '/tmp/two')").run();
	const a = addItem(db, { project: "demo", title: "First", body: "Ελληνικά ✓" });
	const b = addItem(db, { project: "demo", title: "Second", kind: "decision", options: "Red\nBlue" } as never);
	addItem(db, { project: "two", title: "Elsewhere" });
	addNote(db, a, "a note", "kostas");
	addImage(db, a, { type: "image/png", data: new Uint8Array(png), width: 1, height: 1 } as never, "one pixel", "agent");
	waitOn(db, a, [b]);
	const link = addLink(db, { label: "Docs", url: "https://example.com", project: "demo" });
	db.query("UPDATE links SET icon = ?, icon_type = 'image/png' WHERE id = ?").run(new Uint8Array(png), link);
	publishReport(db, { project: "demo", name: "plan", html: "<h1>v1</h1>" });
	publishReport(db, { project: "demo", name: "plan", html: "<h1>v2</h1>" });
	// Longer than one row holds: the rest is in report_parts.
	publishReport(db, { project: "demo", name: "long", html: `<p>${"x".repeat(PART_CHARS + 10)}</p>` });
	const t = addTracker(db, { project: "demo", name: "builds", title: "Builds" });
	recordReading(db, t.id, "3/5");
	recordReading(db, t.id, "4/5");
	addGoal(db, { project: "demo", title: "Ship it" });
	addRuling(db, { project: "demo", text: "Always ask once" });
	updateSettings(db, { "keep.tracker-history": 500 });
	db.query("INSERT INTO vault (id, salt, iterations, auth_hash) VALUES (1, 'salt', 1000, 'hash')").run();
	db.query("INSERT INTO secrets (project, meta, value) VALUES ('demo', 'iv.meta', 'iv.cipher')").run();
	return db;
}

/** Every row of every table the board moves, in rowid order. */
const contents = (db: Db) =>
	Object.fromEntries(tableNames(db).map((t) => [t, db.query(`SELECT * FROM "${t}" ORDER BY rowid`).values()]));

const exported = (db: Db, o = {}) => [...exportLines(db, o)].join("");
const lines = (text: string) => text.split("\n").filter(Boolean);


describe("the export (JSON Lines)", () => {
	test("a header first, a line per row with its table, the counts last; a BLOB as base64", () => {
		const db = fullBoard();
		const out = lines(exported(db));
		const header = JSON.parse(out[0]);
		expect(out[0].startsWith('{"workbench":"export"')).toBe(true);
		expect(header).toMatchObject({ workbench: "export", format: 2 });
		expect(header.tables.map((t: { name: string }) => t.name).sort()).toEqual(tableNames(db).sort());
		const end = JSON.parse(out.at(-1)!);
		const rows = out.slice(1, -1).map((l) => JSON.parse(l));
		expect(end.end.rows.items).toBe(3);
		expect(rows.filter((r) => r.t === "items")).toHaveLength(3);
		expect(Object.values(end.end.rows).reduce((a: number, b) => a + (b as number), 0)).toBe(rows.length);
		const cols = header.tables.find((t: { name: string }) => t.name === "images").columns as string[];
		const image = rows.find((r) => r.t === "images").r;
		expect(Buffer.from(image[cols.indexOf("data")].b64, "base64")).toEqual(png);
		// The vault goes too, as it's kept: encrypted.
		expect(rows.find((r) => r.t === "secrets").r).toContain("iv.cipher");
		// Devices stay with their board.
		expect(header.tables.map((t: { name: string }) => t.name)).not.toContain("devices");
	});

	test("parents before children, read from the tables' own CREATE statements (as on the cloud board)", () => {
		const db = fullBoard();
		const order = exportOrder(db);
		for (const t of order)
			for (const f of db.query(`PRAGMA foreign_key_list("${t}")`).all() as { table: string }[])
				if (f.table !== t && order.includes(f.table)) expect(order.indexOf(f.table)).toBeLessThan(order.indexOf(t));
	});

	test("rows are read a page at a time, by size; a row bigger than a page is a page of its own", () => {
		const db = fullBoard();
		for (let i = 0; i < 30; i++) addNote(db, 1, `note ${i} ${"y".repeat(100)}`);
		const all = db.query("SELECT id, text FROM notes ORDER BY rowid").values();
		expect([...tableRows(db, "notes", ["id", "text"], 300)]).toEqual(all);
		expect([...tableRows(db, "notes", ["id", "text"], 1)]).toEqual(all);
		// The same file, whatever the page size.
		const now = new Date("2026-11-25T00:00:00Z");
		expect(exported(db, { now, pageBytes: 200 })).toBe(exported(db, { now }));
	});

	test("as a stream, a megabyte at a time, ending in the counts", async () => {
		const db = fullBoard();
		const text = await new Response(exportStream(db)).text();
		expect(lines(text).at(-1)).toMatch(/^\{"end":/);
		expect(text.length).toBeGreaterThan(PART_CHARS);
		let done = 0;
		const s = exportStream(db, { done: () => done++ });
		const reader = s.getReader();
		await reader.read();
		await reader.cancel();
		expect(done).toBe(1);
	});
});

describe("import", () => {
	test("a round trip: every table, row for row, ids and all, through a file read line by line", async () => {
		const db = fullBoard();
		const dir = mkdtempSync(join(process.env.WB_TEST_DIR!, "export-"));
		const file = join(dir, "board.jsonl");
		writeFileSync(file, exported(db));
		const into = emptyBoard();
		const r = await importExport(await exportFileLines(Bun.file(file), into), localTarget(into), { schema: into });
		expect(r.left).toEqual([]);
		expect(r.rows.items).toBe(3);
		expect(contents(into)).toEqual(contents(db));
		const long = (db.query("SELECT id FROM reports WHERE name = 'long'").get() as { id: number }).id;
		expect(reportHtml(into, long)!.html).toBe(reportHtml(db, long)!.html);
		expect(getSettings(into)["keep.tracker-history"]).toBe(500);
	});

	test("refuses a board that has items, unless --replace; then the export takes its place", async () => {
		const db = fullBoard();
		const into = emptyBoard();
		into.query("INSERT INTO projects (slug, name) VALUES ('mine', 'Mine')").run();
		addItem(into, { project: "mine", title: "Mine" });
		await expect(importExport(lines(exported(db)), localTarget(into), { schema: into })).rejects.toThrow("the board already has 1 items");
		expect(into.query("SELECT title FROM items").values()).toEqual([["Mine"]]);
		await importExport(lines(exported(db)), localTarget(into), { schema: into, replace: true });
		expect(contents(into)).toEqual(contents(db));
	});

	test("a file cut off before its last line is refused, and the board stays as it was", async () => {
		const db = fullBoard();
		const into = emptyBoard();
		into.query("INSERT INTO projects (slug, name) VALUES ('mine', 'Mine')").run();
		const cut = lines(exported(db)).slice(0, -3);
		await expect(importExport(cut, localTarget(into), { schema: into })).rejects.toThrow("stops before its last line");
		expect(into.query("SELECT slug FROM projects").values()).toEqual([["mine"]]);
		// A line missing from the middle: the counts say so.
		const all = lines(exported(db));
		const holed = all.filter((l, i) => !(i > 0 && l.startsWith('{"t":"notes"') && i === all.findIndex((x) => x.startsWith('{"t":"notes"'))));
		await expect(importExport(holed, localTarget(into), { schema: into })).rejects.toThrow("the export says notes has");
		await expect(importExport(["{}"], localTarget(into), { schema: into })).rejects.toThrow("isn't a board export");
	});

	test("rows whose parent isn't in the export (the cloud board changed while it exported) are left out and said so", async () => {
		const db = fullBoard();
		const all = lines(exported(db));
		const header = JSON.parse(all[0]);
		const cols = header.tables.find((t: { name: string }) => t.name === "notes").columns as string[];
		const note = JSON.parse(all.find((l) => l.startsWith('{"t":"notes"'))!);
		note.r[cols.indexOf("item_id")] = 999;
		note.r[cols.indexOf("id")] = 999;
		const end = JSON.parse(all.at(-1)!);
		end.end.rows.notes++;
		// After the other notes, as the file would have it.
		const withOrphan = [...all.slice(0, -1), JSON.stringify(end)];
		withOrphan.splice(all.map((l) => l.startsWith('{"t":"notes"')).lastIndexOf(true) + 1, 0, JSON.stringify(note));
		const into = emptyBoard();
		const r = await importExport(withOrphan, localTarget(into), { schema: into });
		expect(r.left).toEqual(["notes: 1 row whose parent isn't in the export (changed while it was written)"]);
		expect(contents(into)).toEqual(contents(db));
	});

	test("an export from a board with a column or a table this one doesn't have: the rest goes in, and it says what didn't", async () => {
		const db = fullBoard();
		db.run("ALTER TABLE items ADD COLUMN later TEXT");
		db.run("CREATE TABLE later_things (id INTEGER PRIMARY KEY, x TEXT)");
		db.run("INSERT INTO later_things (x) VALUES ('a')");
		const into = emptyBoard();
		const r = await importExport(lines(exported(db)), localTarget(into), { schema: into });
		expect(r.left).toEqual(["items: column later, which this board doesn't have", "later_things: 1 rows, a table this board doesn't have"]);
		expect(into.query("SELECT COUNT(*) FROM items").values()).toEqual([[3]]);
	});

	test("lines are read across chunks, a long one joined once", async () => {
		const enc = new TextEncoder();
		const chunks = ["ab", "c\nd", "", "e\n\nf", "x".repeat(10), "\n", "last"].map((s) => enc.encode(s));
		async function* gen() {
			yield* chunks;
		}
		const got: string[] = [];
		for await (const l of linesOf(gen())) got.push(l);
		expect(got).toEqual(["abc", "de", "", `f${"x".repeat(10)}`, "last"]);
		// A character cut between two chunks.
		const bytes = enc.encode("αβ\n");
		async function* split() {
			yield bytes.slice(0, 1);
			yield bytes.slice(1);
		}
		const out: string[] = [];
		for await (const l of linesOf(split())) out.push(l);
		expect(out).toEqual(["αβ"]);
	});

	test("what a file is, by its first bytes", () => {
		expect(exportKind('{"workbench":"export","format":2}')).toBe("lines");
		expect(exportKind('{\n "format": 1,')).toBe("json");
		expect(exportKind('[{"title":"x"}]')).toBe("other");
	});
});

describe("the old export (format 1, one JSON)", () => {
	test("still goes in: items with notes, pictures and what they wait on, reports with every version, trackers, settings", async () => {
		const db = fullBoard();
		const old = exportV1(db);
		const dir = mkdtempSync(join(process.env.WB_TEST_DIR!, "v1-"));
		const file = join(dir, "old.json");
		writeFileSync(file, JSON.stringify(old, null, 1));
		const into = emptyBoard();
		const r = await importExport(await exportFileLines(Bun.file(file), into), localTarget(into), { schema: into });
		expect(r.format).toBe(1);
		const same = (sql: string) => expect(into.query(sql).values()).toEqual(db.query(sql).values());
		same("SELECT * FROM projects ORDER BY slug");
		same("SELECT * FROM items ORDER BY id");
		same("SELECT item_id, at, author, text FROM notes ORDER BY item_id, id");
		same("SELECT item_id, caption, type, size, data FROM images ORDER BY id");
		same("SELECT item_id, blocker_id FROM item_links ORDER BY item_id");
		same("SELECT * FROM reports ORDER BY id");
		same("SELECT report_id, n, author, at, text FROM report_versions ORDER BY report_id, n");
		same("SELECT * FROM goals ORDER BY id");
		same("SELECT * FROM rulings ORDER BY id");
		same("SELECT id, project, name, title, kind, options, reading FROM trackers ORDER BY id");
		same("SELECT tracker_id, at, reading, author FROM tracker_history ORDER BY id");
		same("SELECT key, value FROM settings ORDER BY key");
		for (const { id } of db.query("SELECT id FROM reports").all() as { id: number }[]) expect(reportHtml(into, id)!.html).toBe(reportHtml(db, id)!.html);
		// It never had the vault.
		expect(into.query("SELECT COUNT(*) FROM secrets").values()).toEqual([[0]]);
	});

	test("v1Lines refuses what isn't one", () => {
		expect(() => [...v1Lines({ format: 3 }, emptyBoard())]).toThrow("isn't a board export");
	});
});

describe("wb tidy --day-pages", () => {
	test("removes day pages' older versions, keeps the newest of each, and says how many", async () => {
		const db = freshDb();
		const page = (i: number) => `<html><head>${DAY_PAGE_MARK}open:x:${i}"></head><body>${i}</body></html>`;
		for (const name of ["day-2026-11-10", "day-2026-11-11"]) for (let i = 1; i <= 5; i++) publishReport(db, { project: "demo", name, html: page(i), grp: "Days" });
		for (let i = 1; i <= 5; i++) publishReport(db, { project: "demo", name: "plan", html: page(i) });
		const run = async (args: string[], o: Record<string, unknown> = {}) => {
			const out: string[] = [];
			const err: string[] = [];
			const code = await runCli({ db, args, o: o as never, cwd: "/tmp/demo", author: "kostas", tty: false, base: "", port: 0, out: (l) => out.push(l), err: (l) => err.push(l), read: async () => { throw new Error("no files"); }, write: async () => {} });
			return { code, out, err };
		};
		expect((await run(["tidy"])).err).toEqual(["wb: usage: wb tidy --day-pages"]);
		const first = await run(["tidy"], { "day-pages": true });
		expect(first.out[0]).toBe("day pages: removed 4 older versions, kept 6 (the newest 3 of each of 2 day pages)");
		expect((await run(["tidy"], { "day-pages": true })).out).toEqual(["day pages: removed 0 older versions, kept 6 (the newest 3 of each of 2 day pages)"]);
		expect(db.query("SELECT COUNT(*) FROM report_versions v JOIN reports r ON r.id = v.report_id WHERE r.name = 'plan'").values()).toEqual([[5]]);
	});
});

/* ---------- Format 1, as 0.6.0 wrote it (db.ts exportAll then), to test that old files still go in ---------- */

function exportV1(db: Db) {
	const all = (sql: string) => db.query(sql).all() as Record<string, unknown>[];
	const parse = (s: unknown) => {
		try {
			return typeof s === "string" ? JSON.parse(s) : s;
		} catch {
			return s;
		}
	};
	const byParent = (rows: Record<string, unknown>[], key: string) => {
		const m = new Map<unknown, Record<string, unknown>[]>();
		for (const { [key]: parent, ...rest } of rows) m.set(parent, [...(m.get(parent) ?? []), rest]);
		return m;
	};
	const notes = byParent(all("SELECT item_id, at, author, text FROM notes ORDER BY at, id"), "item_id");
	const images = byParent(
		all("SELECT item_id, caption, type, author, at, data FROM images ORDER BY id").map((m) => ({ ...m, data: Buffer.from(m.data as Uint8Array).toString("base64") })),
		"item_id",
	);
	// Which items each waits on (wb-refs), see links.ts.
	const waits = new Map<unknown, string[]>();
	for (const l of all("SELECT l.item_id, b.ref FROM item_links l JOIN items b ON b.id = l.blocker_id ORDER BY l.created_at"))
		waits.set(l.item_id, [...(waits.get(l.item_id) ?? []), `wb-${l.ref}`]);
	const versions = byParent(
		all("SELECT id, report_id, n, at, author, html FROM report_versions ORDER BY report_id, n").map(({ id, ...v }) => ({
			...v,
			html: String(v.html) + (db.query("SELECT html FROM report_parts WHERE version_id = ? ORDER BY i").all(id as number) as { html: string }[]).map((p) => p.html).join(""),
		})),
		"report_id",
	);
	const history = byParent(
		all("SELECT tracker_id, at, reading, author FROM tracker_history ORDER BY tracker_id, id").map((h) => ({ ...h, reading: parse(h.reading) })),
		"tracker_id",
	);
	return {
		format: 1,
		exported_at: new Date().toISOString(),
		projects: all("SELECT * FROM projects ORDER BY sort, name"),
		items: all("SELECT * FROM items ORDER BY id").map((i) => ({ ...i, notes: notes.get(i.id) ?? [], images: images.get(i.id) ?? [], waits_on: waits.get(i.id) ?? [] })),
		links: all("SELECT id, project, grp, label, url, icon_url, sort FROM links ORDER BY project, grp, sort, id"),
		goals: all("SELECT * FROM goals ORDER BY project, sort, id"),
		reports: all("SELECT * FROM reports ORDER BY project, name").map((r) => ({ ...r, versions: versions.get(r.id) ?? [] })),
		report_state: all("SELECT project, name, json, updated_at FROM report_state ORDER BY project, name").map(({ json, ...r }) => ({
			...r,
			state: parse(json),
		})),
		trackers: all("SELECT * FROM trackers ORDER BY project, sort, name").map(({ running_since: _, rev: __, ...t }) => ({
			...t,
			options: parse(t.options),
			reading: parse(t.reading),
			history: history.get(t.id) ?? [],
		})),
		settings: getSettings(db),
		rulings: all("SELECT * FROM rulings ORDER BY project, id"),
		sources: all("SELECT project, name, base_url, write, header_names, created_at, updated_at FROM sources ORDER BY project, name").map(
			(s) => ({ ...s, write: !!s.write, header_names: String(s.header_names || "").split("\n").filter(Boolean) }),
		),
	};
}
