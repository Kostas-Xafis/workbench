/**
 * The board's export: everything on it in one file, written and read a row at a time, so a board of any size fits
 * (a board's report history and pictures are hundreds of MB, more than one JavaScript string holds). It's what keeps
 * a copy of the cloud board, which has no backup files of its own.
 *
 * The file is JSON Lines (format 2), one JSON value per line:
 *
 *   {"workbench":"export","format":2,"app":"0.6.0","exported_at":"…","tables":[{"name":"projects","columns":[…]},…]}
 *   {"t":"projects","r":["demo","Demo",…]}            one line per row: its table and its cells, in the header's columns
 *   {"t":"images","r":[…,{"b64":"iVBOR…"},…]}          a BLOB (a picture, a link icon) as base64
 *   {"end":{"rows":{"projects":3,"items":1200,…}}}      last: how many rows of each table, so a cut-off file is told apart
 *
 * The tables are the board's own, every one that `wb sync on` moves (sync.ts: all but devices and the cloud board's
 * own keys), parents before children, rows in rowid order with their ids. So refs, links, history, every report
 * version (a long page as its report_parts), pictures, trackers, goals, rulings, settings, runs and the vault (still
 * encrypted: only your password opens it) come back exactly. Data sources' headers stay sealed with the key of the
 * board that exported them.
 *
 * Import (importExport) reads it the same way, line by line, into an empty board, and still reads the old export
 * (format 1, one JSON object: v1Lines), for files small enough to be one string.
 */
import pkg from "../package.json";
import { htmlText, PART_CHARS, splitPage, type Db } from "./db";
import { SETTINGS } from "./settings";
import { BATCH_BYTES, cellBytes, columnsOf, tableInfo, tableNames, toCell, wipe, writeRows, type Cell, type TableInfo } from "./sync";

export const EXPORT_FORMAT = 2;

/** What the first line of every export (format 2) starts with: how a file is known for one by its first bytes. */
export const EXPORT_MARK = '{"workbench":"export"';

export type ExportHeader = {
	workbench: "export";
	format: number;
	app?: string;
	exported_at: string;
	tables: { name: string; columns: string[] }[];
};

/** `names` with each one's parents (tables it points at) before it. */
function parentsFirst(names: string[], parentsOf: (t: string) => string[]): string[] {
	const out: string[] = [];
	const visit = (t: string, path: string[]) => {
		if (out.includes(t)) return;
		if (path.includes(t)) throw new Error(`the tables' foreign keys go round in a circle: ${[...path, t].join(" → ")}`);
		for (const p of parentsOf(t)) if (p !== t && names.includes(p)) visit(p, [...path, t]);
		out.push(t);
	};
	for (const t of names) visit(t, []);
	return out;
}

/**
 * The tables an export holds, parents before children. Read from each table's CREATE statement (its REFERENCES),
 * since a Durable Object doesn't allow PRAGMA foreign_key_list: the cloud board writes its export in this order too.
 */
export function exportOrder(db: Db): string[] {
	const sql = new Map(
		(db.query("SELECT name, sql FROM sqlite_master WHERE type = 'table'").all() as { name: string; sql: string | null }[]).map((r) => [r.name, r.sql ?? ""]),
	);
	return parentsFirst(tableNames(db), (t) => [...(sql.get(t) ?? "").matchAll(/\bREFERENCES\s+["`[]?(\w+)/gi)].map((m) => m[1]));
}

/** How much of a table one page reads at most (the cells' own bytes): one page in memory at a time. One row always fits. */
const PAGE_BYTES = 2 * 1024 * 1024;
const MIN_ROWID = -Number.MAX_SAFE_INTEGER;

/**
 * A table's rows in rowid order, read a page at a time: the rowids and sizes of the next thousand rows first, then as
 * many rows as PAGE_BYTES holds, until those thousand are used up. Each row's size is read once (length() reads a
 * long page through), so a table of big rows isn't read over and over.
 */
export function* tableRows(db: Db, table: string, columns: string[], pageBytes = PAGE_BYTES): Generator<unknown[]> {
	const size = columns.map((c) => `COALESCE(length("${c}"), 0)`).join(" + ") || "0";
	const sizes = db.query(`SELECT rowid AS r, ${size} AS s FROM "${table}" WHERE rowid > ? ORDER BY rowid LIMIT 1000`);
	const rows = db.query(`SELECT ${columns.map((c) => `"${c}"`).join(", ")} FROM "${table}" WHERE rowid > ? AND rowid <= ? ORDER BY rowid`);
	let sized: { r: number; s: number }[] = [];
	for (let after = MIN_ROWID, at = 0; ; ) {
		if (at === sized.length) {
			sized = sizes.all(after) as { r: number; s: number }[];
			at = 0;
			if (!sized.length) return;
		}
		let k = at;
		for (let bytes = sized[k].s; k + 1 < sized.length && bytes + sized[k + 1].s <= pageBytes; ) bytes += sized[++k].s;
		const last = sized[k].r;
		yield* rows.values(after, last) as unknown[][];
		after = last;
		at = k + 1;
	}
}

export type ExportOptions = { app?: string; now?: Date; pageBytes?: number };

/** The export, a line at a time (each ends in "\n"). Reads one page of rows at a time, whatever the board's size. */
export function* exportLines(db: Db, o: ExportOptions = {}): Generator<string> {
	const tables = exportOrder(db).map((name) => ({ name, columns: columnsOf(db, name) }));
	const header: ExportHeader = { workbench: "export", format: EXPORT_FORMAT, app: o.app ?? pkg.version, exported_at: (o.now ?? new Date()).toISOString(), tables };
	yield `${JSON.stringify(header)}\n`;
	const rows: Record<string, number> = {};
	for (const t of tables) {
		let n = 0;
		for (const r of tableRows(db, t.name, t.columns, o.pageBytes)) {
			yield `${JSON.stringify({ t: t.name, r: r.map(toCell) })}\n`;
			n++;
		}
		rows[t.name] = n;
	}
	yield `${JSON.stringify({ end: { rows } })}\n`;
}

/**
 * The export as an HTTP body that reads the board only as it's sent: about a megabyte per pull, so the server (or the
 * cloud board's Durable Object) holds one page of rows at a time. `done` runs once it has ended, either way.
 */
export function exportStream(db: Db, o: ExportOptions & { done?: () => void } = {}): ReadableStream<Uint8Array> {
	const lines = exportLines(db, o);
	const enc = new TextEncoder();
	let finished = false;
	const finish = () => {
		if (finished) return;
		finished = true;
		o.done?.();
	};
	return new ReadableStream<Uint8Array>(
		{
			pull(c) {
				try {
					let chunk = "";
					while (chunk.length < 1 << 20) {
						const next = lines.next();
						if (next.done) {
							if (chunk) c.enqueue(enc.encode(chunk));
							c.close();
							finish();
							return;
						}
						chunk += next.value;
					}
					c.enqueue(enc.encode(chunk));
				} catch (e) {
					finish();
					c.error(e);
				}
			},
			cancel() {
				lines.return(undefined);
				finish();
			},
		},
		{ highWaterMark: 0 },
	);
}

/** The lines of a byte stream (a file, an HTTP body), without their "\n". A long line is joined once, not rescanned. */
export async function* linesOf(stream: AsyncIterable<Uint8Array>): AsyncGenerator<string> {
	const dec = new TextDecoder();
	let parts: string[] = [];
	const take = function* (text: string) {
		const pieces = text.split("\n");
		if (pieces.length === 1) {
			if (text) parts.push(text);
			return;
		}
		parts.push(pieces[0]);
		yield parts.join("");
		for (let i = 1; i < pieces.length - 1; i++) yield pieces[i];
		parts = pieces[pieces.length - 1] ? [pieces[pieces.length - 1]] : [];
	};
	for await (const chunk of stream) yield* take(dec.decode(chunk, { stream: true }));
	yield* take(dec.decode());
	if (parts.length) yield parts.join("");
}

/** What a file is, by its first bytes: an export (format 2), an old one-JSON export (format 1), or anything else (`wb import`'s list of items). */
export function exportKind(start: string): "lines" | "json" | "other" {
	const s = start.trimStart();
	if (s.startsWith(EXPORT_MARK)) return "lines";
	// `wb import`'s own files are a list of items; the old export is one object.
	if (s.startsWith("{")) return "json";
	return "other";
}

/* ---------- Import ---------- */

/** Where an import writes: this computer's database (localTarget), or the cloud board through /api/sync/* (cloudcli.ts). */
export type ImportTarget = {
	tables(): Promise<TableInfo[]> | TableInfo[];
	/** Empties these tables (parents before children, as given), children first. */
	wipe(order: string[]): Promise<unknown> | unknown;
	write(table: string, columns: string[], rows: Cell[][]): Promise<number> | number;
	/** All in one transaction, when the target can: a failed import then leaves the board as it was. */
	begin?(): void;
	commit?(): void;
	rollback?(): void;
};

export function localTarget(db: Db): ImportTarget {
	return {
		tables: () => tableInfo(db),
		wipe: (order) => wipe(db, order),
		write: (table, columns, rows) => writeRows(db, table, columns, rows),
		begin: () => db.run("BEGIN IMMEDIATE"),
		commit: () => db.run("COMMIT"),
		rollback: () => db.run("ROLLBACK"),
	};
}

export type ImportResult = {
	format: number;
	app?: string;
	exported_at: string;
	/** Rows put in, by table. */
	rows: Record<string, number>;
	/** What didn't go in, and why: a table or columns this board doesn't have, rows whose parent the export lacks. */
	left: string[];
};

type ForeignKey = { from: string; table: string; to: string; nulls: boolean };

/** Each table's foreign keys, from a board with this version's schema (`schema`: never the cloud board, which can't say). */
function foreignKeys(schema: Db, tables: string[]) {
	const out = new Map<string, ForeignKey[]>();
	for (const t of tables)
		out.set(
			t,
			(schema.query(`PRAGMA foreign_key_list("${t}")`).all() as { table: string; from: string; to: string | null; on_delete: string }[])
				.filter((f) => f.table !== t)
				.map((f) => ({ from: f.from, table: f.table, to: f.to ?? "rowid", nulls: f.on_delete === "SET NULL" })),
		);
	return out;
}

/**
 * Puts an export (its lines, header first) into `target` in place of what it has: every table the board moves is
 * emptied, then filled row by row with the export's ids. Refuses a board that has items or reports, unless `replace`.
 * Rows whose parent isn't in the export (a cloud board written to while it exported) are left out and said so; a
 * file that stops before its last line is refused. `schema` is a board with this version's schema, for its foreign keys.
 */
export async function importExport(
	lines: AsyncIterable<string> | Iterable<string>,
	target: ImportTarget,
	o: { schema: Db; replace?: boolean; log?: (line: string) => void },
): Promise<ImportResult> {
	const log = o.log ?? (() => {});
	const it = (Symbol.asyncIterator in lines ? lines[Symbol.asyncIterator]() : (lines as Iterable<string>)[Symbol.iterator]()) as AsyncIterator<string> | Iterator<string>;
	const first = await it.next();
	let header: ExportHeader | null = null;
	try {
		header = first.done ? null : JSON.parse(first.value);
	} catch {}
	if (!header || header.workbench !== "export" || !Array.isArray(header.tables)) throw new Error("that isn't a board export (its first line should say workbench: export)");
	if (header.format > EXPORT_FORMAT) throw new Error(`the export is format ${header.format}, newer than this wb reads (${EXPORT_FORMAT}): update wb first`);

	const have = new Map((await target.tables()).map((t) => [t.name, t]));
	const busy = ["items", "reports"].map((t) => [t, have.get(t)?.rows ?? 0] as const).filter(([, n]) => n > 0);
	if (busy.length && !o.replace)
		throw new Error(`the board already has ${busy.map(([t, n]) => `${n} ${t}`).join(" and ")}: wb import --replace puts the export in its place (everything on it goes)`);

	const order = parentsFirst([...have.keys()], (t) => (o.schema.query(`PRAGMA foreign_key_list("${t}")`).all() as { table: string }[]).map((f) => f.table));
	const fks = foreignKeys(o.schema, order);
	const left: string[] = [];
	const exported = new Map(header.tables.map((t) => [t.name, t.columns]));
	// What each table's rows become here: the columns this board has, and where they are in the export's row.
	const plans = new Map<string, { columns: string[]; at: number[]; checks: { at: number; key: string; nulls: boolean }[]; keeps: { at: number; key: string }[] } | null>();
	// The keys of parent rows put in so far, for the foreign keys that point at them ("items.id").
	const keys = new Map<string, Set<unknown>>();
	for (const list of fks.values()) for (const f of list) if (exported.has(f.table)) keys.set(`${f.table}.${f.to}`, new Set());
	for (const { name, columns } of header.tables) {
		const mine = have.get(name);
		if (!mine) {
			plans.set(name, null);
			continue;
		}
		const cols = columns.filter((c) => mine.columns.includes(c));
		const dropped = columns.filter((c) => !mine.columns.includes(c));
		if (dropped.length) left.push(`${name}: column${dropped.length > 1 ? "s" : ""} ${dropped.join(", ")}, which this board doesn't have`);
		const at = cols.map((c) => columns.indexOf(c));
		const checks = (fks.get(name) ?? []).filter((f) => keys.has(`${f.table}.${f.to}`) && cols.includes(f.from)).map((f) => ({ at: cols.indexOf(f.from), key: `${f.table}.${f.to}`, nulls: f.nulls }));
		const keeps = [...keys.keys()].filter((k) => k.startsWith(`${name}.`)).map((k) => ({ at: cols.indexOf(k.slice(name.length + 1)), key: k })).filter((k) => k.at >= 0);
		plans.set(name, { columns: cols, at, checks, keeps });
	}

	const rows: Record<string, number> = {};
	const seen: Record<string, number> = {};
	const orphans: Record<string, number> = {};
	const unknown: Record<string, number> = {};
	let batch: Cell[][] = [];
	let batchTable = "";
	let bytes = 0;
	const flush = async () => {
		if (!batch.length) return;
		const plan = plans.get(batchTable)!;
		rows[batchTable] = (rows[batchTable] ?? 0) + (await target.write(batchTable, plan.columns, batch));
		batch = [];
		bytes = 0;
	};

	target.begin?.();
	try {
		await target.wipe(order);
		let end: { rows: Record<string, number> } | null = null;
		for (let next = await it.next(); !next.done; next = await it.next()) {
			const line = next.value;
			if (!line.trim()) continue;
			if (end) throw new Error("the export goes on after its last line");
			let rec: { t?: string; r?: Cell[]; end?: { rows: Record<string, number> } };
			try {
				rec = JSON.parse(line);
			} catch {
				throw new Error(`a line of the export isn't JSON (after ${Object.values(seen).reduce((a, b) => a + b, 0)} rows)`);
			}
			if (rec.end) {
				end = rec.end;
				continue;
			}
			const table = String(rec.t);
			if (!exported.has(table) || !Array.isArray(rec.r)) throw new Error(`a row of the export names a table its header doesn't (${table})`);
			seen[table] = (seen[table] ?? 0) + 1;
			const plan = plans.get(table);
			if (!plan) {
				unknown[table] = (unknown[table] ?? 0) + 1;
				continue;
			}
			const row = plan.at.map((i) => rec.r![i] ?? null);
			let orphan = false;
			for (const c of plan.checks) {
				const v = row[c.at];
				if (v === null || keys.get(c.key)!.has(v)) continue;
				if (c.nulls) row[c.at] = null;
				else orphan = true;
			}
			if (orphan) {
				orphans[table] = (orphans[table] ?? 0) + 1;
				continue;
			}
			for (const k of plan.keeps) keys.get(k.key)!.add(row[k.at]);
			const size = row.reduce((n: number, c) => n + cellBytes(c), 0);
			if (table !== batchTable || (batch.length && bytes + size > BATCH_BYTES)) {
				await flush();
				batchTable = table;
			}
			batch.push(row);
			bytes += size;
		}
		await flush();
		if (!end) throw new Error("the export stops before its last line: the file isn't whole (was it cut off while it was written?)");
		for (const [t, n] of Object.entries(end.rows))
			if ((seen[t] ?? 0) !== n) throw new Error(`the export says ${t} has ${n} rows, and the file has ${seen[t] ?? 0}`);
		target.commit?.();
	} catch (e) {
		target.rollback?.();
		throw e;
	}
	for (const [t, n] of Object.entries(unknown)) left.push(`${t}: ${n} rows, a table this board doesn't have`);
	for (const [t, n] of Object.entries(orphans)) left.push(`${t}: ${n} row${n > 1 ? "s" : ""} whose parent isn't in the export (changed while it was written)`);
	for (const [t, n] of Object.entries(rows)) if (n) log(`  ${t}: ${n}`);
	return { format: header.format, app: header.app, exported_at: header.exported_at, rows, left };
}

/* ---------- The old export (format 1) ---------- */

type Obj = Record<string, unknown>;

/** A JSON value as the column held it: the old export parsed some columns' JSON text. */
const asJsonText = (v: unknown) => (v === null || v === undefined ? null : typeof v === "string" ? v : JSON.stringify(v));

/**
 * The old export (format 1: one JSON object, items with their notes, pictures and what they wait on, reports with
 * their versions, trackers with their history) as the lines of a format 2 export, for importExport. It had no vault,
 * no data sources' headers, no link icons and no runs: those stay empty. `schema`: a board with this version's
 * schema, for the order of its tables.
 */
export function* v1Lines(old: Obj, schema: Db): Generator<string> {
	if (old.format !== 1 || !Array.isArray(old.items)) throw new Error("that isn't a board export (format 1 has format: 1 and items)");
	const tables = new Map<string, Obj[]>();
	const add = (t: string, row: Obj) => {
		if (!tables.has(t)) tables.set(t, []);
		tables.get(t)!.push(row);
	};
	const list = (k: string) => (Array.isArray(old[k]) ? (old[k] as Obj[]) : []);
	for (const p of list("projects")) add("projects", p);
	const byRef = new Map<string, unknown>();
	for (const i of list("items")) byRef.set(`wb-${i.ref}`, i.id);
	for (const { notes, images, waits_on, ...item } of list("items") as (Obj & { notes?: Obj[]; images?: Obj[]; waits_on?: string[] })[]) {
		add("items", item);
		for (const n of notes ?? []) add("notes", { item_id: item.id, ...n });
		for (const m of images ?? []) {
			const data = new Uint8Array(Buffer.from(String(m.data ?? ""), "base64"));
			add("images", { item_id: item.id, ...m, data, size: data.length });
		}
		for (const ref of waits_on ?? []) if (byRef.has(ref)) add("item_links", { item_id: item.id, blocker_id: byRef.get(ref) });
	}
	for (const l of list("links")) add("links", l);
	for (const g of list("goals")) add("goals", g);
	let versionId = 0;
	for (const { versions, ...r } of list("reports") as (Obj & { versions?: Obj[] })[]) {
		add("reports", r);
		for (const v of versions ?? []) {
			const html = String(v.html ?? "");
			const [first, ...rest] = splitPage(html);
			const id = ++versionId;
			add("report_versions", { id, report_id: r.id, n: v.n, at: v.at, author: v.author, html: first, text: htmlText(html).slice(0, PART_CHARS) });
			rest.forEach((part, k) => add("report_parts", { version_id: id, i: k + 1, html: part }));
		}
	}
	for (const { state, ...s } of list("report_state")) add("report_state", { ...s, json: JSON.stringify(state ?? null) });
	for (const { history, options, reading, ...t } of list("trackers") as (Obj & { history?: Obj[] })[]) {
		add("trackers", { ...t, options: asJsonText(options), reading: asJsonText(reading) });
		for (const h of history ?? []) add("tracker_history", { tracker_id: t.id, ...h, reading: asJsonText(h.reading) });
	}
	// Every setting was written out, defaults too: only what differs from today's default is kept.
	for (const [key, value] of Object.entries((old.settings as Obj) ?? {}))
		if (SETTINGS[key] && JSON.stringify(value) !== JSON.stringify(SETTINGS[key].default)) add("settings", { key, value: JSON.stringify(value) });
	for (const r of list("rulings")) add("rulings", r);
	// Data sources came without their headers, which a source can't work without: add them again (wb source add).

	const order = parentsFirst(
		[...tables.keys()],
		(t) => (schema.query(`PRAGMA foreign_key_list("${t}")`).all() as { table: string }[]).map((f) => f.table),
	);
	const header: ExportHeader = {
		workbench: "export",
		format: 1,
		exported_at: String(old.exported_at ?? ""),
		tables: order.map((name) => ({ name, columns: [...new Set(tables.get(name)!.flatMap((r) => Object.keys(r)))] })),
	};
	yield JSON.stringify(header);
	const rows: Record<string, number> = {};
	for (const { name, columns } of header.tables) {
		for (const r of tables.get(name)!) yield JSON.stringify({ t: name, r: columns.map((c) => toCell(r[c] === undefined ? null : r[c])) });
		rows[name] = tables.get(name)!.length;
	}
	yield JSON.stringify({ end: { rows } });
}

/** A file's lines as an export: format 2 read as it goes, format 1 read whole (it's one JSON value) and turned into lines. */
export async function exportFileLines(file: Blob, schema: Db): Promise<AsyncIterable<string> | Iterable<string>> {
	const kind = exportKind(await file.slice(0, 4096).text());
	if (kind === "lines") return linesOf(file.stream() as unknown as AsyncIterable<Uint8Array>);
	if (kind !== "json") throw new Error("that isn't a board export");
	let old: Obj;
	try {
		old = JSON.parse(await file.text());
	} catch (e) {
		if (/string length|out of memory/i.test((e as Error).message))
			throw new Error("this old export (one JSON value, format 1) is too big to read in one piece: export the board again with this version");
		throw new Error(`the old export isn't JSON: ${(e as Error).message}`);
	}
	return v1Lines(old, schema);
}

/* ---------- wb export and wb import on a computer (wb.ts, cloudcli.ts) ---------- */

/** Writes the chunks to stdout as they come, waiting whenever it's full: nothing is held but the chunk in hand. */
export async function toStdout(chunks: AsyncIterable<string | Uint8Array> | Iterable<string | Uint8Array>) {
	const out = process.stdout;
	let failed: Error | null = null;
	const onError = (e: Error) => (failed = e);
	out.on("error", onError);
	try {
		for await (const c of chunks) {
			if (failed) throw failed;
			if (!out.write(c)) await new Promise<void>((r) => out.once("drain", () => r()));
		}
		await new Promise<void>((r, j) => out.write("", (e) => (e ? j(e) : r())));
		if (failed) throw failed;
	} finally {
		out.off("error", onError);
	}
}

/** What `wb import` says when an export went in. */
export function importSummary(r: ImportResult): string[] {
	const n = (t: string) => r.rows[t] ?? 0;
	const total = Object.values(r.rows).reduce((a, b) => a + b, 0);
	const when = r.exported_at ? ` of ${r.exported_at.slice(0, 16).replace("T", " ")}` : "";
	return [
		`imported the export${when} (format ${r.format}${r.app ? `, wb ${r.app}` : ""}): ${n("projects")} projects, ${n("items")} items, ${n("notes")} notes, ${n("images")} pictures, ${n("reports")} reports with ${n("report_versions")} versions; ${total} rows in all`,
		...r.left.map((l) => `left out: ${l}`),
	];
}
