/**
 * Sync: the board on Cloudflare instead of this computer (worker/, docs/cloud.md). Off by default. When it's on,
 * everything goes over the network to the cloud board: the page, the API, the MCP server (`wb mcp` relays to it),
 * phones and the desktop app. Nothing reads or writes this computer's database; it stays as it was, untouched.
 *
 * This file is both halves of moving a board: the wire format the cloud board's /api/sync/* speaks (also imported
 * by worker/src/board.ts, so nothing here runs on import), and the client side that `wb sync on` and `wb sync off`
 * use to move the rows up and back down. What's moved is every table but `devices` (a device is paired with one
 * board), row by row with its ids, so refs, links and history stay what they were.
 *
 * Whether this computer is synced, and with which board, is `<database>.sync.json` next to the database (mode 0600,
 * it holds this computer's device token): `workbench.db.sync.json`, already outside git like the database.
 */
import { chmodSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { DB_PATH, open, PART_CHARS, splitPage, type Db } from "./db";

/** The /api/sync/* format. A computer and a cloud board with different numbers refuse to move rows. */
export const SYNC_FORMAT = 1;

/** Kept by each board for itself: devices (their tokens belong to the board they paired with) and the cloud board's open pairing code. */
export const NOT_MOVED = new Set(["devices", "pairing_code", "login_tickets"]);
// Push notifications (worker/src/push.ts): the cloud board's own keys, and subscriptions that belong to its devices.
for (const t of ["push_keys", "push_subscriptions"]) NOT_MOVED.add(t);

/** A batch of rows to or from the cloud board stays under this much JSON: well inside a Worker's 100 MB request. */
export const BATCH_BYTES = 8 * 1024 * 1024;

/** One cell on the wire: BLOBs (images, link icons) as base64. */
export type Cell = string | number | null | { b64: string };
export const toCell = (v: unknown): Cell =>
	v instanceof Uint8Array ? { b64: Buffer.from(v).toString("base64") } : v === undefined ? null : (v as Cell);
export const fromCell = (c: Cell): string | number | null | Uint8Array =>
	c !== null && typeof c === "object" ? new Uint8Array(Buffer.from(c.b64, "base64")) : c;
export const cellBytes = (c: Cell) => (c === null ? 4 : typeof c === "object" ? c.b64.length + 10 : typeof c === "string" ? c.length * 2 + 2 : 12);

export type TableInfo = { name: string; columns: string[]; rows: number };

/** The board's tables that move: not SQLite's own, nor a Durable Object's (_cf_…), nor NOT_MOVED. */
export const tableNames = (db: Db) =>
	(db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' ORDER BY name").all() as { name: string }[])
		.map((t) => t.name)
		.filter((t) => !NOT_MOVED.has(t));

/**
 * The tables that move, parents before children (by their foreign keys), so rows can go in in this order. On this
 * computer only: a Durable Object doesn't allow PRAGMA foreign_key_list, so the computer tells the cloud board.
 */
export function tableOrder(db: Db): string[] {
	const names = tableNames(db);
	const parents = new Map(
		names.map((t) => [
			t,
			(db.query(`PRAGMA foreign_key_list("${t}")`).all() as { table: string }[]).map((f) => f.table).filter((p) => p !== t && names.includes(p)),
		]),
	);
	const out: string[] = [];
	const visit = (t: string, path: string[]) => {
		if (out.includes(t)) return;
		if (path.includes(t)) throw new Error(`the tables' foreign keys go round in a circle: ${[...path, t].join(" → ")}`);
		for (const p of parents.get(t) ?? []) visit(p, [...path, t]);
		out.push(t);
	};
	for (const t of names) visit(t, []);
	return out;
}

export const columnsOf = (db: Db, table: string) => (db.query(`PRAGMA table_info("${table}")`).all() as { name: string }[]).map((c) => c.name);

export function tableInfo(db: Db, order = tableNames(db)): TableInfo[] {
	return order.map((name) => ({ name, columns: columnsOf(db, name), rows: (db.query(`SELECT COUNT(*) AS n FROM "${name}"`).get() as { n: number }).n }));
}

/** The rows of `table` after rowid `after`, in rowid order, until about BATCH_BYTES. `next` is where to go on from, or null at the end. */
export function readRows(db: Db, table: string, columns: string[], after: number, limit = 500) {
	const list = columns.map((c) => `"${c}"`).join(", ");
	const raw = db.query(`SELECT rowid AS "__rowid", ${list} FROM "${table}" WHERE rowid > ? ORDER BY rowid LIMIT ?`).values(after, limit) as unknown[][];
	const rows: Cell[][] = [];
	let bytes = 0;
	let last = after;
	for (const r of raw) {
		const cells = r.slice(1).map(toCell);
		const size = cells.reduce((n: number, c) => n + cellBytes(c), 0);
		if (rows.length && bytes + size > BATCH_BYTES) break;
		rows.push(cells);
		bytes += size;
		last = Number(r[0]);
	}
	return { rows, next: rows.length === raw.length && raw.length < limit ? null : last };
}

/** Puts rows in as they came, ids and all, in one transaction. Columns must be the table's own. */
export function writeRows(db: Db, table: string, columns: string[], rows: Cell[][]) {
	const have = new Set(columnsOf(db, table));
	if (!have.size) throw new Error(`no table ${table}`);
	const unknown = columns.filter((c) => !have.has(c));
	if (unknown.length) throw new Error(`${table} has no column ${unknown.join(", ")}`);
	const ins = db.query(`INSERT INTO "${table}" (${columns.map((c) => `"${c}"`).join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`);
	db.transaction(() => {
		for (const r of rows) {
			if (r.length !== columns.length) throw new Error(`a row of ${table} has ${r.length} values for ${columns.length} columns`);
			ins.run(...r.map(fromCell));
		}
	})();
	return rows.length;
}

/** Empties every table in `order` (parents before children, as tableOrder gives them), children first. Devices stay. */
export function wipe(db: Db, order: string[]) {
	const known = new Set(tableNames(db));
	db.transaction(() => {
		for (const t of [...order].reverse()) {
			if (!known.has(t)) throw new Error(`no table ${t}`);
			db.run(`DELETE FROM "${t}"`);
		}
	})();
}

/* ---------- This computer's side ---------- */

export type SyncConfig = { url: string; token: string; device: string; since: string };

export const syncFile = (dbPath = DB_PATH) => `${dbPath}.sync.json`;

/** This computer's sync, or null when the board is here (the default). */
export function readSync(dbPath = DB_PATH): SyncConfig | null {
	try {
		const c = JSON.parse(readFileSync(syncFile(dbPath), "utf8"));
		return typeof c?.url === "string" && typeof c?.token === "string" ? c : null;
	} catch {
		return null;
	}
}

function writeSync(cfg: SyncConfig, dbPath = DB_PATH) {
	const file = syncFile(dbPath);
	writeFileSync(file, `${JSON.stringify(cfg, null, 1)}\n`, { mode: 0o600 });
	chmodSync(file, 0o600);
}

/** https only, except a board on this computer (wrangler dev). No path: the board is at the root. */
export function cleanUrl(input: string) {
	let u: URL;
	try {
		u = new URL(/^[a-z]+:\/\//i.test(input.trim()) ? input.trim() : `https://${input.trim()}`);
	} catch {
		throw new Error(`${input} isn't an address`);
	}
	const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname);
	if (u.protocol !== "https:" && !(local && u.protocol === "http:")) throw new Error("the cloud board's address has to start with https://");
	return u.origin;
}

/** A call to the cloud board as this computer's device. Throws its error, in its words, when it says no. */
export async function cloudFetch(cfg: Pick<SyncConfig, "url" | "token">, path: string, init: RequestInit = {}): Promise<Response> {
	const headers = new Headers(init.headers);
	headers.set("authorization", `Bearer ${cfg.token}`);
	if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
	let res: Response;
	try {
		res = await fetch(new URL(path, cfg.url), { ...init, headers });
	} catch (e) {
		throw new Error(`can't reach the cloud board at ${cfg.url}: ${(e as Error).message}`);
	}
	if (!res.ok) {
		const text = await res.text();
		let msg = text;
		try {
			msg = JSON.parse(text).error ?? text;
		} catch {}
		throw new Error(`the cloud board says ${res.status}: ${msg.slice(0, 300) || res.statusText}`);
	}
	return res;
}

const cloudJson = async <T>(cfg: Pick<SyncConfig, "url" | "token">, path: string, init?: RequestInit) => (await cloudFetch(cfg, path, init)).json() as Promise<T>;

/** What the cloud board says about itself, checked to be one this version can sync with. */
export async function cloudPing(url: string) {
	let ping: { app?: string; cloud?: boolean; version?: string; sync?: number; claimed?: boolean };
	try {
		ping = await (await fetch(`${url}/api/ping`)).json();
	} catch (e) {
		throw new Error(`${url} doesn't answer like a cloud board (${(e as Error).message}). Is the Worker deployed? (docs/cloud.md)`);
	}
	if (ping.app !== "workbench" || !ping.cloud) throw new Error(`${url} isn't a cloud board`);
	if (ping.sync !== SYNC_FORMAT) throw new Error(`the cloud board speaks sync format ${ping.sync}, this computer ${SYNC_FORMAT}: deploy the Worker from this version`);
	return ping;
}

type Log = (line: string) => void;

/** Sends this computer's board up, replacing everything on the cloud board but its devices. */
async function upload(db: Db, cfg: SyncConfig, log: Log) {
	const order = tableOrder(db);
	const cloud = new Map((await cloudJson<TableInfo[]>(cfg, "/api/sync/tables")).map((t) => [t.name, t]));
	const missing = order.filter((t) => !cloud.has(t));
	if (missing.length) throw new Error(`the cloud board has no ${missing.join(", ")}: deploy the Worker from this version first`);
	await cloudFetch(cfg, "/api/sync/wipe", { method: "POST", body: JSON.stringify({ tables: order }) });
	// Pages longer than a cloud row holds are cut into report_parts on the way (a board from before parts existed).
	const extraParts: Cell[][] = [];
	for (const table of order) {
		const cloudCols = new Set(cloud.get(table)!.columns);
		const columns = columnsOf(db, table).filter((c) => cloudCols.has(c));
		let sent = 0;
		const send = async (rows: Cell[][]) => {
			if (!rows.length) return;
			await cloudFetch(cfg, "/api/sync/rows", { method: "POST", body: JSON.stringify({ table, columns, rows }) });
			sent += rows.length;
		};
		if (table === "report_parts") {
			const iVersion = columns.indexOf("version_id");
			const iPart = columns.indexOf("i");
			const iHtml = columns.indexOf("html");
			for (let k = 0; k < extraParts.length; ) {
				let bytes = 0;
				const batch: Cell[][] = [];
				while (k < extraParts.length && (!batch.length || bytes + cellBytes(extraParts[k][2]) < BATCH_BYTES)) {
					const [version, i, html] = extraParts[k++];
					const row: Cell[] = columns.map(() => null);
					row[iVersion] = version;
					row[iPart] = i;
					row[iHtml] = html;
					batch.push(row);
					bytes += cellBytes(html);
				}
				await send(batch);
			}
		}
		for (let after: number | null = 0; after !== null; ) {
			const page = readRows(db, table, columns, after);
			if (table === "report_versions") {
				const iId = columns.indexOf("id");
				const iHtml = columns.indexOf("html");
				const iText = columns.indexOf("text");
				for (const row of page.rows) {
					const html = String(row[iHtml] ?? "");
					if (html.length <= PART_CHARS) continue;
					const [first, ...rest] = splitPage(html);
					row[iHtml] = first;
					if (iText >= 0) row[iText] = String(row[iText] ?? "").slice(0, PART_CHARS);
					rest.forEach((part, n) => extraParts.push([row[iId], n + 1, part]));
				}
			}
			// A page of rows can be bigger once the long pages are counted: send it in pieces under BATCH_BYTES.
			let batch: Cell[][] = [];
			let bytes = 0;
			for (const row of page.rows) {
				const size = row.reduce((n: number, c) => n + cellBytes(c), 0);
				if (batch.length && bytes + size > BATCH_BYTES) {
					await send(batch);
					batch = [];
					bytes = 0;
				}
				batch.push(row);
				bytes += size;
			}
			await send(batch);
			after = page.next;
		}
		if (sent) log(`  ${table}: ${sent}`);
	}
	// Every table holds what was sent (report_parts more, when long pages were cut on the way).
	const after = new Map((await cloudJson<TableInfo[]>(cfg, "/api/sync/tables")).map((t) => [t.name, t.rows]));
	for (const t of tableInfo(db, order)) {
		const want = t.name === "report_parts" ? t.rows + extraParts.length : t.rows;
		if (after.get(t.name) !== want) throw new Error(`${t.name}: the cloud board has ${after.get(t.name)} rows, this computer sent ${want}`);
	}
}

/** Fills `db` (made empty first) with the cloud board's rows. */
async function download(db: Db, cfg: SyncConfig, log: Log) {
	const order = tableOrder(db);
	const cloud = new Map((await cloudJson<TableInfo[]>(cfg, "/api/sync/tables")).map((t) => [t.name, t]));
	wipe(db, order);
	for (const table of order) {
		const info = cloud.get(table);
		if (!info) continue;
		const mine = new Set(columnsOf(db, table));
		const columns = info.columns.filter((c) => mine.has(c));
		let got = 0;
		for (let after: number | null = 0; after !== null; ) {
			const page: { rows: Cell[][]; next: number | null } = await cloudJson(
				cfg,
				`/api/sync/rows?table=${encodeURIComponent(table)}&after=${after}&columns=${encodeURIComponent(columns.join(","))}`,
			);
			got += writeRows(db, table, columns, page.rows);
			after = page.next;
		}
		if (got !== info.rows) throw new Error(`${table}: got ${got} rows of the cloud board's ${info.rows}`);
		if (got) log(`  ${table}: ${got}`);
	}
}

const stamp = () => new Date().toISOString().slice(0, 19).replace("T", "-").replaceAll(":", "");

export type SyncOnOptions = { key?: string; code?: string; name?: string; replace?: boolean; log?: Log };

/**
 * Turns sync on: this computer gets a device on the cloud board at `url` (with the owner key set on the Worker, or a
 * pairing code from a device already on it), and, when that board is empty (or with `replace`), this computer's
 * board goes up to it. A board that already has items is used as it is: this computer's own stays here, untouched.
 */
export async function syncOn(input: string, o: SyncOnOptions): Promise<{ cfg: SyncConfig; uploaded: boolean }> {
	const log = o.log ?? (() => {});
	const now = readSync();
	if (now) throw new Error(`this computer already syncs with ${now.url} (wb sync off first)`);
	if (!o.key === !o.code) throw new Error("give the owner key (--key) or a pairing code from a device on the cloud board (--code)");
	const url = cleanUrl(input);
	await cloudPing(url);
	const name = (o.name ?? hostname()).trim() || "Computer";
	let token = "";
	let device = "";
	if (o.key) {
		const res = await fetch(`${url}/api/sync/claim`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: o.key, name }) });
		const body = (await res.json().catch(() => ({}))) as { token?: string; device?: { id: string }; error?: string };
		if (!res.ok || !body.token) throw new Error(body.error ?? `the cloud board said ${res.status}`);
		token = body.token;
		device = body.device!.id;
	} else {
		const res = await fetch(`${url}/api/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: o.code, name }) });
		const body = (await res.json().catch(() => ({}))) as { device?: { id: string }; error?: string };
		token = /wb_device=([^;]+)/.exec(res.headers.get("set-cookie") ?? "")?.[1] ?? "";
		if (!res.ok || !token) throw new Error(body.error ?? `the cloud board said ${res.status}`);
		device = body.device!.id;
	}
	const cfg: SyncConfig = { url, token, device, since: new Date().toISOString() };
	let uploaded = false;
	try {
		const cloud = await cloudJson<TableInfo[]>(cfg, "/api/sync/tables");
		const hasItems = cloud.some((t) => (t.name === "items" || t.name === "projects") && t.rows > 0);
		if (!hasItems || o.replace) {
			log(hasItems ? `Replacing the cloud board with this computer's (${DB_PATH}):` : `Sending this computer's board up (${DB_PATH}):`);
			const db = open();
			try {
				await upload(db, cfg, log);
			} finally {
				db.close();
			}
			uploaded = true;
		} else log("The cloud board already has a board on it: this computer now uses that one. Its own stays here, untouched.");
	} catch (e) {
		// Sync stays off, so the device this computer just got goes too (the next try gets a new one).
		await cloudFetch(cfg, `/api/devices/${encodeURIComponent(device)}`, { method: "DELETE", body: "{}" }).catch(() => {});
		throw e;
	}
	writeSync(cfg);
	return { cfg, uploaded };
}

export type SyncOffOptions = { keepLocal?: boolean; log?: Log };

/**
 * Turns sync off. By default the cloud board's rows come back down into a new database that takes the place of
 * this computer's (which is kept next to it, renamed), so nothing done in the cloud is lost. `keepLocal` goes
 * back to this computer's board as it was when sync went on. The cloud board itself stays as it is, and this
 * computer's device on it is removed.
 */
export async function syncOff(o: SyncOffOptions = {}): Promise<{ kept?: string }> {
	const log = o.log ?? (() => {});
	const cfg = readSync();
	if (!cfg) throw new Error("this computer doesn't sync: the board is here");
	let kept: string | undefined;
	if (!o.keepLocal) {
		const fresh = `${DB_PATH}.from-cloud-${stamp()}`;
		log(`Bringing the cloud board down (${cfg.url}):`);
		const db = open(fresh);
		try {
			await download(db, cfg, log);
		} catch (e) {
			db.close();
			for (const f of [fresh, `${fresh}-wal`, `${fresh}-shm`]) rmSync(f, { force: true });
			throw e;
		}
		db.run("PRAGMA wal_checkpoint(TRUNCATE)");
		db.close();
		kept = DB_PATH.replace(/(\.db)?$/, `-before-sync-off-${stamp()}.db`);
		if (existsSync(DB_PATH)) renameSync(DB_PATH, kept);
		for (const s of ["-wal", "-shm"]) if (existsSync(DB_PATH + s)) renameSync(DB_PATH + s, kept + s);
		renameSync(fresh, DB_PATH);
		for (const s of ["-wal", "-shm"]) rmSync(fresh + s, { force: true });
	}
	try {
		await cloudFetch(cfg, `/api/devices/${encodeURIComponent(cfg.device)}`, { method: "DELETE", body: "{}" });
	} catch (e) {
		log(`(couldn't remove this computer's device from the cloud board: ${(e as Error).message})`);
	}
	rmSync(syncFile(), { force: true });
	return { kept };
}

/** A one-minute, one-time address that signs a browser in to the cloud board (the cloud board's /login). */
export async function cloudLogin(cfg: SyncConfig, name = "") {
	const t = await cloudJson<{ url: string }>(cfg, "/api/sync/ticket", { method: "POST", body: JSON.stringify({ name }) });
	return t.url;
}

/** A one-time code for pairing a phone or a browser with the cloud board, and the address that takes it. */
export async function cloudPairing(cfg: SyncConfig) {
	const info = await cloudJson<{ pairing: { code: string; expires: number; minutes: number } | null }>(cfg, "/api/devices/pairing", { method: "POST", body: "{}" });
	if (!info.pairing) throw new Error("the cloud board made no code");
	return { ...info.pairing, url: `${cfg.url}/pair?code=${encodeURIComponent(info.pairing.code)}` };
}
