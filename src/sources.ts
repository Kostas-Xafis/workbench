/**
 * Data sources: named HTTP APIs a report page can call through the board, so a secret (a bearer token, an API
 * key) is sent by the server and never reaches the page, the report's HTML, a share link or the CLI's output.
 *
 * `wb source add` keeps the base URL in `workbench.db` and the headers sealed with AES-256-GCM under a key in
 * `~/.config/workbench/sources.key` (0600), outside the database, so the database and its backups hold no
 * usable secret. The board reads the key when a page calls `wb.fetch`.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { getReport, type Db } from "./db";

export const KEY_PATH =
	process.env.WB_SOURCES_KEY ??
	join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "workbench", "sources.key");

export const FETCH_TIMEOUT_MS = 20_000;
export const RESPONSE_MAX = 5 * 1024 * 1024;
export const REQUEST_MAX = 1024 * 1024;
const READ = ["GET", "HEAD"];
const WRITE = ["POST", "PUT", "PATCH", "DELETE"];

export type Source = {
	project: string;
	name: string;
	base_url: string;
	write: boolean;
	/** Names only, e.g. "Authorization"; the values stay sealed. */
	header_names: string[];
	created_at: string;
	updated_at: string;
};

/* ---------- The key and sealing ---------- */

function readKey(create: boolean): Buffer {
	if (!existsSync(KEY_PATH)) {
		if (!create) throw new Error(`no key at ${KEY_PATH}; add the source again with wb source add`);
		mkdirSync(dirname(KEY_PATH), { recursive: true, mode: 0o700 });
		writeFileSync(KEY_PATH, randomBytes(32).toString("base64") + "\n", { mode: 0o600, flag: "wx" });
	}
	if (statSync(KEY_PATH).mode & 0o077) throw new Error(`${KEY_PATH} is readable by others; chmod 600 it`);
	const key = Buffer.from(readFileSync(KEY_PATH, "utf8").trim(), "base64");
	if (key.length !== 32) throw new Error(`${KEY_PATH} is not a 32-byte key`);
	return key;
}

// Bound to project + name, so sealed headers can't be moved to another source in the database.
const aad = (project: string, name: string) => Buffer.from(`wb-source:${project}/${name}`);

function seal(key: Buffer, project: string, name: string, headers: Record<string, string>) {
	const iv = randomBytes(12);
	const c = createCipheriv("aes-256-gcm", key, iv).setAAD(aad(project, name));
	const ct = Buffer.concat([c.update(JSON.stringify(headers), "utf8"), c.final(), c.getAuthTag()]);
	return `v1.${iv.toString("base64")}.${ct.toString("base64")}`;
}

function unseal(key: Buffer, project: string, name: string, sealed: string): Record<string, string> {
	const [v, iv, ct] = sealed.split(".");
	if (v !== "v1" || !iv || !ct) throw new Error("bad sealed headers");
	const data = Buffer.from(ct, "base64");
	const d = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64")).setAAD(aad(project, name));
	d.setAuthTag(data.subarray(data.length - 16));
	try {
		return JSON.parse(Buffer.concat([d.update(data.subarray(0, data.length - 16)), d.final()]).toString("utf8"));
	} catch {
		throw new Error(`can't open the headers of source "${name}" (was ${KEY_PATH} replaced?); add it again`);
	}
}

/* ---------- Storage ---------- */

const NAME = /^[a-z0-9][a-z0-9_-]{0,39}$/i;
const HEADER = /^[!#$%&'*+.^_`|~0-9a-z-]+$/i;
// Set by the board from the request, or meaningless to fix per source.
const RESERVED = new Set(["host", "content-length", "content-type", "connection", "transfer-encoding", "cookie"]);
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

function checkBase(raw: string): string {
	let u: URL;
	try {
		u = new URL(raw);
	} catch {
		throw new Error(`not a URL: ${raw}`);
	}
	if (u.protocol !== "https:" && !(u.protocol === "http:" && LOOPBACK.has(u.hostname)))
		throw new Error("the base URL must be https (plain http only for localhost)");
	if (u.username || u.password) throw new Error("put credentials in --header, not in the URL");
	if (u.search || u.hash) throw new Error("the base URL can't have a ?query or #fragment");
	return u.href.replace(/\/+$/, "");
}

type Row = Omit<Source, "write" | "header_names"> & { write: number; header_names: string; headers: string };
const toSource = ({ headers: _, ...r }: Row): Source => ({
	...r,
	write: !!r.write,
	header_names: r.header_names ? r.header_names.split("\n") : [],
});

export function listSources(db: Db, project?: string): Source[] {
	const rows = db
		.query(`SELECT * FROM sources ${project ? "WHERE project = ?" : ""} ORDER BY project, name`)
		.all(...(project ? [project] : [])) as Row[];
	return rows.map(toSource);
}

/** Adds a source, or replaces the one with that name in the project (a new token, say). */
export function addSource(
	db: Db,
	s: { project: string; name: string; base_url: string; write: boolean; headers: Record<string, string> },
): { replaced: boolean } {
	if (!NAME.test(s.name)) throw new Error("a source name is letters, digits, - and _ (up to 40)");
	if (!db.query("SELECT 1 FROM projects WHERE slug = ?").get(s.project)) throw new Error(`no project "${s.project}"`);
	const base = checkBase(s.base_url);
	for (const [k, v] of Object.entries(s.headers)) {
		if (!HEADER.test(k)) throw new Error(`not a header name: ${k}`);
		if (RESERVED.has(k.toLowerCase())) throw new Error(`the board sets ${k} itself`);
		if (/[\r\n\0]/.test(v)) throw new Error(`the value of ${k} has a line break`);
	}
	const key = readKey(true);
	const replaced = !!db.query("SELECT 1 FROM sources WHERE project = ? AND name = ?").get(s.project, s.name);
	db.query(
		`INSERT INTO sources (project, name, base_url, write, header_names, headers) VALUES ($project, $name, $base, $write, $names, $headers)
		ON CONFLICT (project, name) DO UPDATE SET base_url = $base, write = $write, header_names = $names, headers = $headers,
			updated_at = datetime('now')`,
	).run({
		project: s.project,
		name: s.name,
		base,
		write: s.write ? 1 : 0,
		names: Object.keys(s.headers).join("\n"),
		headers: seal(key, s.project, s.name, s.headers),
	});
	return { replaced };
}

export function removeSource(db: Db, project: string, name: string) {
	if (!db.query("DELETE FROM sources WHERE project = ? AND name = ?").run(project, name).changes)
		throw new Error(`no source "${name}" in ${project}`);
}

/* ---------- The proxy ---------- */

export type FetchOptions = {
	method?: string;
	/** An object or array is sent as JSON; a string as text/plain. */
	body?: unknown;
	/** Added to the URL's query (arrays repeat the key). */
	query?: Record<string, unknown>;
};
export type FetchResult = {
	ok: boolean;
	status: number;
	/** The response's content type, and its Location on a redirect (redirects aren't followed). */
	type?: string;
	location?: string;
	json?: unknown;
	text?: string;
	/** Set when no response came back: a refused call, a bad path, a timeout, a network error. */
	error?: string;
};

/** The URL `path` names under `base`. Never another origin, never above the base path. */
export function sourceUrl(base: string, path: string, query?: Record<string, unknown>): URL {
	if (typeof path !== "string") throw new Error("the path must be a string");
	if (/^[a-z][a-z0-9+.-]*:/i.test(path) || path.startsWith("//")) throw new Error("give a path, not a URL");
	if (/[\0-\x20\x7f\\#]/.test(path)) throw new Error("the path has a space, control character, \\ or #");
	const q = path.indexOf("?");
	const p = q < 0 ? path : path.slice(0, q);
	if (/%2f|%5c/i.test(p)) throw new Error("the path can't contain an encoded / or \\");
	if (/(^|\/)\.\.?(\/|$)/.test(p.replace(/%2e/gi, "."))) throw new Error("the path can't contain . or .. segments");
	const b = new URL(base);
	const basePath = b.pathname.endsWith("/") ? b.pathname : b.pathname + "/";
	// "" names the base itself; "/" the base with a trailing slash.
	const rest = p.replace(/^\/+/, "");
	const u = new URL((rest || p ? basePath : b.pathname) + rest + (q < 0 ? "" : path.slice(q)), b.origin);
	if (u.origin !== b.origin || !(u.pathname.startsWith(basePath) || u.pathname + "/" === basePath))
		throw new Error("the path leaves the source's base URL");
	if (query != null) {
		if (typeof query !== "object" || Array.isArray(query)) throw new Error("query must be an object");
		for (const [k, v] of Object.entries(query))
			for (const x of ([] as unknown[]).concat(v)) if (x != null) u.searchParams.append(k, String(x));
	}
	return u;
}

async function readCapped(res: Response): Promise<Uint8Array> {
	if (Number(res.headers.get("content-length")) > RESPONSE_MAX) throw new Error("the response is over 5 MB");
	if (!res.body) return new Uint8Array();
	const parts: Uint8Array[] = [];
	let n = 0;
	const reader = res.body.getReader();
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		n += value.length;
		if (n > RESPONSE_MAX) {
			reader.cancel().catch(() => {});
			throw new Error("the response is over 5 MB");
		}
		parts.push(value);
	}
	return Buffer.concat(parts);
}

/**
 * What a report's `wb.fetch(name, path, opts)` gets: a call to its own project's source `name`, with that
 * source's headers added here. Every failure comes back as `{ ok: false, status: 0, error }`.
 */
export async function sourceFetch(db: Db, reportId: number, name: unknown, path: unknown, opts: FetchOptions = {}): Promise<FetchResult> {
	const failed = (error: string): FetchResult => ({ ok: false, status: 0, error });
	try {
		const report = getReport(db, reportId);
		if (!report) return failed("no such report");
		const row = db.query("SELECT * FROM sources WHERE project = ? AND name = ?").get(report.project, String(name)) as Row | null;
		if (!row) return failed(`no data source "${name}" in project ${report.project} (wb sources)`);
		const method = String(opts?.method ?? "GET").toUpperCase();
		if (!READ.includes(method) && !WRITE.includes(method)) return failed(`method ${method} isn't allowed`);
		if (WRITE.includes(method) && !row.write)
			return failed(`source "${row.name}" is read-only (GET); add it with --write to allow ${method}`);
		const url = sourceUrl(row.base_url, String(path ?? ""), opts?.query);
		const headers = new Headers(unseal(readKey(false), row.project, row.name, row.headers));
		let body: string | undefined;
		if (opts?.body != null) {
			if (READ.includes(method)) return failed(`${method} takes no body`);
			if (typeof opts.body === "string") {
				body = opts.body;
				headers.set("content-type", "text/plain; charset=utf-8");
			} else {
				body = JSON.stringify(opts.body);
				headers.set("content-type", "application/json");
			}
			if (Buffer.byteLength(body) > REQUEST_MAX) return failed("the body is over 1 MB");
		}
		if (!headers.has("accept")) headers.set("accept", "application/json, text/*;q=0.9, */*;q=0.5");
		const res = await fetch(url, {
			method,
			headers,
			body,
			// A redirect could carry the headers somewhere else: hand it back instead.
			redirect: "manual",
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
		});
		const type = res.headers.get("content-type") ?? "";
		const out: FetchResult = { ok: res.ok, status: res.status, type };
		const location = res.headers.get("location");
		if (location) out.location = location;
		const text = new TextDecoder().decode(await readCapped(res));
		if (/[/+]json\b/i.test(type) && text) {
			try {
				out.json = JSON.parse(text);
				return out;
			} catch {}
		}
		out.text = text;
		return out;
	} catch (e) {
		const err = e as Error;
		if (err.name === "TimeoutError") return failed(`no answer within ${FETCH_TIMEOUT_MS / 1000} s`);
		return failed(err.message);
	}
}
