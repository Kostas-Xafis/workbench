/**
 * The cloud board: one Durable Object holding the board's SQLite, serving the same route table as the board on a
 * computer (src/routes.ts). What's different here:
 *
 * - Who gets in: a paired device, by its token, as a cookie (browsers, phones, the desktop app's window) or an
 *   `Authorization: Bearer` header (`wb`, the MCP relay, the app). There is no "this computer": a paired device may
 *   do what the board's page on the computer may (settings, the vault, data). The first device comes from the
 *   owner key (the WB_OWNER_KEY secret) through /api/sync/claim; later ones pair with a code, as phones do.
 * - What needs a computer: agents the board starts, tracker commands, git and pull requests, logos, Usage and
 *   project folders are done by a helper on a computer that syncs (helper.ts). What no helper does (backups to
 *   files, sharing through a tunnel, health) NEEDS_COMPUTER answers here, in words (docs/cloud.md).
 * - Moving a board: /api/sync/* (src/sync.ts), for `wb sync on` and `wb sync off`. Bearer tokens only.
 * - Jobs: asks past their deadline go ahead on the next request (at most every 30 s), as `wb` does; tidying runs
 *   once a day from an alarm. Point-in-time recovery (30 days) stands in for the nightly backup file.
 */
import { DurableObject } from "cloudflare:workers";
import type { Server } from "bun";
import pageHtml from "../../ui/index.html";
import usageHtml from "../../ui/usage.html";
import pairHtml from "../../ui/pair.html";
import iconSvg from "../../ui/icon.svg" with { type: "text" };
import icon256 from "../../src-tauri/icons/256x256.png";
import icon512 from "../../src-tauri/icons/icon.png";
import icon192 from "../../ui/icons/icon-192.png";
import maskable192 from "../../ui/icons/maskable-192.png";
import maskable512 from "../../ui/icons/maskable-512.png";
import badge96 from "../../ui/icons/badge-96.png";
import pkg from "../../package.json";
import { createSchema, tidy, type Db } from "../../src/db";
import { applyDue } from "../../src/asks";
import { createHash } from "node:crypto";
import { addDevice, deviceName, Pairing, phoneGate, type OpenCode } from "../../src/devices";
import { boardRoutes, PAIR_OPEN, type BoardFile, type BoardHost } from "../../src/routes";
import { readRows, SYNC_FORMAT, tableInfo, tableNames, wipe, writeRows, type Cell } from "../../src/sync";
import { SqliteDb } from "./sqlite";
import { cloudKeyring, currentKeyring, givenKeyring, resealSources, useKeyring } from "../../src/sources";
import { runCloudCli } from "./cloudcli";
import { compile, dispatch } from "./router";
import { Helpers } from "./helper";
import { Push } from "./push";
import { assetVersions } from "./assets";
import { withEtag } from "../../src/fresh";

export type Env = {
	BOARD: DurableObjectNamespace;
	ASSETS: Fetcher;
	/** `wrangler secret put WB_OWNER_KEY`: what `wb sync on --key` gives to get the first device. */
	WB_OWNER_KEY?: string;
	/** Optional: the secret data sources' headers are sealed under here (src/sources.ts cloudKeyring); else the owner key. */
	WB_SOURCES_KEY?: string;
};

const COOKIE = "wb_device";
// 400 days, the longest a browser keeps a cookie; sent again whenever the page loads, so it lasts while used.
const cookie = (token: string) => `${COOKIE}=${token}; Path=/; Max-Age=${token ? 400 * 86400 : 0}; HttpOnly; Secure; SameSite=Strict`;

const COMPUTER = "on the cloud board this needs a computer, which the board doesn't have yet (docs/cloud.md)";
/** Routes that only a computer can answer, and what to say instead. */
export const NEEDS_COMPUTER: Record<string, string> = {
	"/api/data/backups": "the cloud board keeps 30 days of every change instead of backup files (Cloudflare's point-in-time recovery)",
	"/api/data/backups/:name": "the cloud board has no backup files",
	"/api/data/backups/:name/restore": "the cloud board has no backup files",
	"/api/data/compact": "the cloud board's database compacts itself",
	"/api/settings/health": `health checks a computer: ${COMPUTER}`,
	"/api/setup": `the setup guide checks a computer: ${COMPUTER}`,
	"/api/share/check": `sharing runs a tunnel: ${COMPUTER}`,
	"/api/shares": `sharing runs a tunnel: ${COMPUTER}`,
	"/api/shares/stop-all": `sharing runs a tunnel: ${COMPUTER}`,
	"/api/reports/:id/share": `sharing runs a tunnel: ${COMPUTER}`,
	"/api/reports/:id/share/extend": `sharing runs a tunnel: ${COMPUTER}`,
	"/api/update/check": "the cloud board is updated by deploying the Worker",
};
/** The routes that answer without a device: the pairing page and what it needs, the ping, claiming and logging in. */
const OPEN = new Set([...PAIR_OPEN, "/api/ping", "/api/sync/claim", "/login"]);
/** How long a login ticket (POST /api/sync/ticket) can be used for, once. */
const TICKET_MS = 60e3;

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { "cache-control": "no-store" } });

const equal = (a: string, b: string) => {
	const x = new TextEncoder().encode(a);
	const y = new TextEncoder().encode(b);
	let d = x.length ^ y.length;
	for (let i = 0; i < Math.max(x.length, y.length); i++) d |= (x[i] ?? 0) ^ (y[i] ?? 0);
	return d === 0;
};

export class Board extends DurableObject<Env> {
	private readonly db: Db;
	private readonly host: BoardHost;
	private readonly match: ReturnType<typeof compile>;
	private origin = "";
	private dueAt = 0;
	private claimMisses: number[] = [];
	private readonly helpers: Helpers;
	/** Push notifications (push.ts): who gets what after each write. */
	private readonly push: Push;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.db = new SqliteDb(ctx.storage) as unknown as Db;
		// Data sources' headers are sealed with a key from the Worker's secrets: this board has no key file.
		useKeyring(cloudKeyring(env.WB_SOURCES_KEY || env.WB_OWNER_KEY));
		createSchema(this.db);
		const db = this.db;
		// Day pages keep their last few versions from each day page's own write on (day.ts). The cloud board doesn't prune
		// its older history in one go as it starts: it has no backup of its own, and `wb export` can't yet write a board
		// this size, so nothing would keep what goes. pruneDayVersions(db) here once an export can hold it.
		// The open pairing code, kept in the database: this object may be restarted while a phone types it.
		db.run("CREATE TABLE IF NOT EXISTS pairing_code (id INTEGER PRIMARY KEY CHECK (id = 1), value TEXT NOT NULL, expires INTEGER NOT NULL, wrong INTEGER NOT NULL)");
		// One-time login tickets (login()), by hash: a ticket is as good as a pairing code for its minute.
		db.run("CREATE TABLE IF NOT EXISTS login_tickets (hash TEXT PRIMARY KEY, name TEXT NOT NULL, expires INTEGER NOT NULL)");
		const pairing = new Pairing({
			load: () => (db.query("SELECT value, expires, wrong FROM pairing_code WHERE id = 1").get() as OpenCode | null) ?? null,
			save: (c) => {
				db.run("DELETE FROM pairing_code");
				if (c) db.query("INSERT INTO pairing_code (id, value, expires, wrong) VALUES (1, ?, ?, ?)").run(c.value, c.expires, c.wrong);
			},
		});
		const gate = phoneGate(db, {
			port: 443,
			loopback: () => false,
			open: [...OPEN],
			cookie: COOKIE,
			bearer: true,
			unpaired: "This device isn't paired with the cloud board. On one that is, open Settings → Data and click Pair a phone, or run wb sync pair on a computer that syncs with it.",
		});
		// Owner checks: any paired device, from the board's own page or a tool (no other site's page).
		const sameSite = (req: Request) => {
			const site = req.headers.get("sec-fetch-site");
			const origin = req.headers.get("origin");
			return (!site || site === "same-origin" || site === "none") && (!origin || origin === new URL(req.url).origin);
		};
		const files: Record<BoardFile, BodyInit> = {
			// The page tells its scripts it's the cloud board (ui/core.js, CLOUD).
			page: (pageHtml as unknown as string).replace(/<html\b/, '<html data-cloud="1"'),
			usage: usageHtml as unknown as string,
			pair: pairHtml as unknown as string,
			icon: iconSvg,
			"icon-256.png": icon256 as unknown as ArrayBuffer,
			"icon-512.png": icon512 as unknown as ArrayBuffer,
			"icon-192.png": icon192 as unknown as ArrayBuffer,
			"maskable-192.png": maskable192 as unknown as ArrayBuffer,
			"maskable-512.png": maskable512 as unknown as ArrayBuffer,
			"badge-96.png": badge96 as unknown as ArrayBuffer,
		};
		let versions: Promise<Record<string, string>> | null = null;
		this.host = {
			db,
			cloud: true,
			port: 443,
			lan: true,
			compiled: true,
			loopback: () => false,
			localRead: (req, srv) => !!gate.device(req, srv) && sameSite(req),
			boardOnly: (req, srv) => !!gate.device(req, srv) && sameSite(req) && (req.headers.get("content-type") ?? "").startsWith("application/json"),
			gate,
			pairing,
			pairUrls: () => (this.origin ? [this.origin] : []),
			cookie,
			sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
			file: (name) => files[name] ?? null,
			uiFile: async (name) => {
				if (!/^[\w.-]+\.(js|css)$/.test(name)) return new Response("not found", { status: 404 });
				const res = await env.ASSETS.fetch(new Request(`https://assets.local/${name}`));
				if (!res.ok) return new Response("not found", { status: 404 });
				const out = new Response(res.body, res);
				out.headers.set("cache-control", "no-cache");
				return out;
			},
			uiVersions: () => (versions ??= assetVersions(env.ASSETS, files.page as string)),
			ping: () => ({ app: "workbench", version: pkg.version, cloud: true, sync: SYNC_FORMAT, claimed: this.claimed() }),
		};
		this.match = compile(boardRoutes(this.host) as Record<string, unknown>);
		this.helpers = new Helpers(ctx, db);
		this.push = new Push(db);
		// What a computer's helper changes (tracker readings, agents that ended, unblocked work sent) is news too.
		this.helpers.changed = () => this.pushAfter(null);
	}

	/** Whether a device exists yet: until one does, only the owner key gets in. */
	private claimed() {
		return !!this.db.query("SELECT 1 FROM devices LIMIT 1").get();
	}

	async fetch(req: Request): Promise<Response> {
		const url = new URL(req.url);
		this.origin = url.origin;
		const ip = req.headers.get("cf-connecting-ip") ?? "";
		const srv = { requestIP: () => ({ address: ip, family: ip.includes(":") ? "IPv6" : "IPv4", port: 0 }) } as unknown as Server<unknown>;
		this.due();
		await this.tidyDaily();
		const path = url.pathname;
		// ---------- Push notifications (push.ts) ----------
		// The service worker says nothing about the board, and a browser may fetch it without the cookie.
		if (path === "/sw.js") return this.serviceWorker();
		if (url.protocol === "https:") this.push.subject = url.origin;
		// ---------- end: push ----------
		if (path === "/api/sync/claim") return this.claim(req, ip);
		if (path === "/login") return this.login(req, url, srv, ip);
		const m = this.match(path);
		const open = m ? OPEN.has(m.pattern) : false;
		if (!open) {
			const no = this.host.gate.check(req, srv);
			if (no) return no;
		}
		// ---------- Push notifications (push.ts) ----------
		if (path === "/api/push" || path.startsWith("/api/push/")) {
			const device = this.host.gate.device(req, srv);
			if (!device) return json({ error: "push notifications are for a paired device" }, 403);
			return this.push.route(req, path, device.id, this.host.boardOnly(req, srv));
		}
		if (path.startsWith("/api/sync/")) {
			const res = await this.sync(req, url);
			// A `wb` command (cloudcli.ts) is a write like any other. A board moved in or out isn't news: compare the
			// next write with it, not with the board before.
			if (path === "/api/sync/cli") this.pushAfter(this.host.gate.device(req, srv)?.id ?? null);
			else this.push.watch.reset();
			return res;
		}
		// ---------- end: push ----------
		// ---- The computer helper (helper.ts): what needs a computer, done by one that syncs with this board. ----
		if (path.startsWith("/api/helper/") || path === "/api/helper") return this.helpers.fetch(req, url, this.host.gate.device(req, srv));
		if (!m) return new Response("not found", { status: 404 });
		try {
			const device = this.host.gate.device(req, srv);
			const done = await this.helpers.route(m.pattern, req, url, { device, boardOnly: this.host.boardOnly(req, srv), localRead: this.host.localRead(req, srv) });
			if (done) {
				// Run, Stop, Refresh: what they changed goes to the other devices (push.ts), as any write's does.
				if (req.method !== "GET" && req.method !== "HEAD") this.pushAfter(device?.id ?? null);
				return await withEtag(req, done);
			}
			if (m.pattern === "/api/settings/projects") return await this.helpers.projectsTab(await dispatch(m, req, srv));
		} catch (e) {
			console.error(`${req.method} ${path}: ${(e as Error).stack ?? e}`);
			return json({ error: (e as Error).message }, 500);
		}
		// ---- end of the computer helper ----
		const why = NEEDS_COMPUTER[m.pattern];
		if (why) return json({ error: why, cloud: true }, 501);
		try {
			const res = await dispatch(m, req, srv);
			// Push notifications: what this write changed goes to the other devices (push.ts).
			if (req.method !== "GET" && req.method !== "HEAD") this.pushAfter(this.host.gate.device(req, srv)?.id ?? null);
			return res;
		} catch (e) {
			// Something only a computer has (Bun, a file, a command): an answer rather than an uncaught error, which
			// would restart this object.
			console.error(`${req.method} ${path}: ${(e as Error).stack ?? e}`);
			return json({ error: (e as Error).message }, 500);
		}
	}

	/** Asks past their deadline go ahead with their default, before anything is read (asks.ts). */
	private due() {
		const now = Date.now();
		if (now - this.dueAt < 30e3) return;
		this.dueAt = now;
		try {
			const went = applyDue(this.db);
			for (const ref of went) console.log(`ask: wb-${ref} went ahead with its default`);
			if (went.length) this.pushAfter(null);
		} catch (e) {
			console.error(`asks: ${(e as Error).message}`);
		}
	}

	// ---- The computer helper's WebSockets (helper.ts): hibernatable, so an idle one costs nothing. ----
	webSocketMessage(ws: WebSocket, data: string | ArrayBuffer) {
		return this.helpers.message(ws, data);
	}
	webSocketClose(ws: WebSocket) {
		this.helpers.closed(ws);
	}
	webSocketError(ws: WebSocket) {
		this.helpers.closed(ws);
	}
	// ---- end of the computer helper ----

	/** Makes sure tomorrow's tidy is scheduled. */
	private async tidyDaily() {
		if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + 24 * 3600e3);
	}

	/** Once a day: what Settings → Data says not to keep goes (old report versions, tracker readings, closed items). */
	async alarm() {
		// ---------- Push notifications: the alarm also ends quiet hours (push.ts), so tidying keeps its own time. ----------
		try {
			await this.push.flush();
		} catch (e) {
			console.error(`push: ${(e as Error).message}`);
		}
		const tidyAt = (await this.ctx.storage.get<number>("tidy_at")) ?? 0;
		if (Date.now() < tidyAt) return this.pushAlarm(tidyAt);
		await this.ctx.storage.put("tidy_at", Date.now() + 24 * 3600e3);
		// ---------- end: push ----------
		try {
			const gone = tidy(this.db);
			if (Object.values(gone).some(Boolean)) console.log(`tidy: ${JSON.stringify(gone)}`);
		} finally {
			await this.pushAlarm(Date.now() + 24 * 3600e3);
		}
	}

	/* ---------- Push notifications (push.ts) ---------- */

	/** ui/sw.js at the root, so it can show notifications for the whole board. Never cached, so updates show at once. */
	private async serviceWorker() {
		const res = await this.env.ASSETS.fetch(new Request("https://assets.local/sw.js"));
		if (!res.ok) return new Response("not found", { status: 404 });
		return new Response(res.body, { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache", "service-worker-allowed": "/" } });
	}

	/** Sends what a write changed, after the answer has gone (the diff itself is taken now, before anything else runs). */
	private pushAfter(from: string | null) {
		const sending = this.push
			.after(from)
			.then(() => this.pushAlarm())
			.catch((e) => console.error(`push: ${(e as Error).message}`));
		this.ctx.waitUntil?.(sending);
	}

	/**
	 * The one alarm a Durable Object has, at whichever comes first: the daily tidy (kept as `tidy_at`) or the next
	 * look at whether quiet hours ended for a device with notifications waiting.
	 */
	private async pushAlarm(tidyAt?: number) {
		const storage = this.ctx.storage;
		const current = await storage.getAlarm();
		tidyAt ??= (await storage.get<number>("tidy_at")) ?? current ?? Date.now() + 24 * 3600e3;
		await storage.put("tidy_at", tidyAt);
		const at = Math.min(tidyAt, this.push.nextCheck() ?? Infinity);
		if (current !== at) await storage.setAlarm(at);
	}
	/* ---------- end: push ---------- */

	/**
	 * GET /login?ticket=…&next=/: a browser (the desktop app's window, `wb open`) gets a device cookie with a one-time
	 * ticket that a device made with its token (POST /api/sync/ticket), instead of typing a pairing code. One that
	 * already has its cookie goes straight on; the ticket is used up either way.
	 */
	private login(req: Request, url: URL, srv: Server<unknown>, ip: string) {
		const nextRaw = url.searchParams.get("next") ?? "/";
		const next = /^\/(?![/\\])/.test(nextRaw) ? nextRaw : "/";
		// A page that moves on by itself rather than a redirect: the cookie is SameSite=Strict, and a redirect still
		// counts as the cross-site navigation that brought the browser here (the app's own page, a terminal's link).
		const go = (headers: Record<string, string> = {}) =>
			new Response(`<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0; url=${next.replace(/[&"<>]/g, (c) => `&#${c.charCodeAt(0)};`)}"><title>Workbench</title>`, {
				headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer", ...headers },
			});
		const ticket = url.searchParams.get("ticket") ?? "";
		const row = ticket
			? (this.db.query("DELETE FROM login_tickets WHERE hash = ? AND expires >= ? RETURNING name").get(sha256(ticket), Date.now()) as { name: string } | null)
			: null;
		if (this.host.gate.device(req, srv)) return go();
		if (!row) return new Response(null, { status: 302, headers: { location: `/pair?next=${encodeURIComponent(next)}`, "cache-control": "no-store" } });
		const ua = req.headers.get("user-agent") ?? "";
		const { device, token } = addDevice(this.db, { name: row.name || deviceName(ua), ip, ua });
		console.log(`logged in: ${device.name} (${device.id})`);
		return go({ "set-cookie": cookie(token) });
	}

	/** POST /api/sync/claim {key, name}: a device for whoever has the owner key. Slow and limited, against guessing. */
	private async claim(req: Request, ip: string) {
		if (req.method !== "POST") return json({ error: "POST the owner key" }, 405);
		const now = Date.now();
		this.claimMisses = this.claimMisses.filter((t) => now - t < 10 * 60e3);
		if (this.claimMisses.length >= 10) return json({ error: "too many wrong keys: wait 10 minutes" }, 429);
		const key = this.env.WB_OWNER_KEY ?? "";
		if (!key) return json({ error: "the Worker has no owner key yet: set one with `bunx wrangler secret put WB_OWNER_KEY` in worker/" }, 503);
		const body = (await req.json().catch(() => ({}))) as { key?: unknown; name?: unknown };
		if (typeof body.key !== "string" || !equal(body.key, key)) {
			this.claimMisses.push(now);
			await new Promise((r) => setTimeout(r, 800));
			return json({ error: "that isn't the owner key" }, 403);
		}
		const { device, token } = addDevice(this.db, { name: String(body.name ?? "Computer"), ip, ua: req.headers.get("user-agent") ?? "" });
		console.log(`device claimed: ${device.name} (${device.id})`);
		return json({ device: { id: device.id, name: device.name }, token }, 201);
	}

	/** Moving a board up and down (src/sync.ts). Only a tool with its token in a header, never a page. */
	private async sync(req: Request, url: URL) {
		if (!/^Bearer\s/i.test(req.headers.get("authorization") ?? "") || req.headers.get("origin"))
			return json({ error: "sync takes a device token in an Authorization header" }, 403);
		const db = this.db;
		try {
			const what = url.pathname.slice("/api/sync/".length);
			if (what === "tables" && req.method === "GET") return json(tableInfo(db));
			if (what === "ticket" && req.method === "POST") {
				const { name } = (await req.json().catch(() => ({}))) as { name?: unknown };
				const ticket = Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("base64url");
				db.query("DELETE FROM login_tickets WHERE expires < ?").run(Date.now());
				db.query("INSERT INTO login_tickets (hash, name, expires) VALUES (?, ?, ?)").run(sha256(ticket), String(name ?? "").slice(0, 60), Date.now() + TICKET_MS);
				return json({ ticket, url: `${url.origin}/login?ticket=${ticket}`, seconds: TICKET_MS / 1000 }, 201);
			}
			if (what === "wipe" && req.method === "POST") {
				const { tables } = (await req.json()) as { tables: string[] };
				wipe(db, tables);
				return json({ ok: true });
			}
			if (what === "rows" && req.method === "POST") {
				const { table, columns, rows } = (await req.json()) as { table: string; columns: string[]; rows: Cell[][] };
				if (!tableNames(db).includes(table)) throw new Error(`no table ${table}`);
				return json({ rows: writeRows(db, table, columns, rows) });
			}
			if (what === "rows" && req.method === "GET") {
				const table = url.searchParams.get("table") ?? "";
				if (!tableNames(db).includes(table)) throw new Error(`no table ${table}`);
				const mine = new Set(tableInfo(db, [table])[0].columns);
				const columns = (url.searchParams.get("columns") ?? "").split(",").filter((c) => mine.has(c));
				return json(readRows(db, table, columns.length ? columns : [...mine], Number(url.searchParams.get("after")) || 0));
			}
			// Data sources between a computer's key file and this board's key (wb sync on/off, wb sync sources).
			if (what === "sources/reseal" && req.method === "POST") {
				const { key } = (await req.json()) as { key: string };
				const { resealed, failed } = resealSources(db, givenKeyring(key), currentKeyring());
				return json({ resealed: resealed.map(({ project, name }) => ({ project, name })), failed });
			}
			if (what === "sources/export" && req.method === "POST") {
				const { key } = (await req.json()) as { key: string };
				return json(resealSources(db, currentKeyring(), givenKeyring(key), false));
			}
			// `wb` over the network: the board's own command code runs here (cloudcli.ts).
			if (what === "cli" && req.method === "POST") return await runCloudCli(db, req, url.origin);
			return json({ error: "no such sync call" }, 404);
		} catch (e) {
			return json({ error: (e as Error).message }, 400);
		}
	}
}
