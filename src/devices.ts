/**
 * Phones paired with the board (docs/board.md, "From the phone"). Under `wb serve --lan` the board answers the network, and
 * every request that doesn't come from this computer needs a device token: a random secret the phone gets once, from a
 * short-lived one-time pairing code made in Settings → Privacy and security on this computer, and then sends as an
 * HttpOnly, SameSite=Strict cookie. The board keeps only the token's hash. Removing a device stops it at once: the gate
 * looks the token up on every request.
 */
import type { Server } from "bun";
import type { Db } from "./db";

export type Device = {
	id: string;
	name: string;
	paired_at: string;
	last_seen_at: string | null;
	last_ip: string;
	user_agent: string;
};

export function createDeviceTables(db: Db) {
	db.run(`CREATE TABLE IF NOT EXISTS devices (
		id TEXT PRIMARY KEY,
		name TEXT NOT NULL,
		token_hash TEXT NOT NULL UNIQUE,
		paired_at TEXT NOT NULL DEFAULT (datetime('now')),
		last_seen_at TEXT,
		last_ip TEXT NOT NULL DEFAULT '',
		user_agent TEXT NOT NULL DEFAULT ''
	)`);
}

const COLS = "id, name, paired_at, last_seen_at, last_ip, user_agent";
const hash = (token: string) => new Bun.CryptoHasher("sha256").update(token).digest("hex");
/** Uniform picks from `alphabet` (no modulo bias). */
function randomChars(alphabet: string, n: number) {
	let out = "";
	const limit = 256 - (256 % alphabet.length);
	while (out.length < n)
		for (const b of crypto.getRandomValues(new Uint8Array(n * 2))) if (b < limit && out.length < n) out += alphabet[b % alphabet.length];
	return out;
}

export const listDevices = (db: Db): Device[] =>
	db.query(`SELECT ${COLS} FROM devices ORDER BY paired_at DESC, rowid DESC`).all() as Device[];

export function removeDevice(db: Db, id: string): boolean {
	return db.query("DELETE FROM devices WHERE id = ?").run(id.trim().toLowerCase()).changes > 0;
}

export function removeAllDevices(db: Db): number {
	return db.query("DELETE FROM devices").run().changes;
}

/** A new device and its token. The token is returned once, here, and never stored. */
export function addDevice(db: Db, { name, ip = "", ua = "" }: { name: string; ip?: string; ua?: string }) {
	const token = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
	let id = "";
	do id = randomChars("23456789abcdefghjkmnpqrstuvwxyz", 4);
	while (db.query("SELECT 1 FROM devices WHERE id = ?").get(id));
	const clean = name.replace(/\s+/g, " ").trim().slice(0, 60) || deviceName(ua);
	db.query("INSERT INTO devices (id, name, token_hash, last_seen_at, last_ip, user_agent) VALUES (?, ?, ?, datetime('now'), ?, ?)").run(
		id,
		clean,
		hash(token),
		ip,
		ua.slice(0, 300),
	);
	return { device: db.query(`SELECT ${COLS} FROM devices WHERE id = ?`).get(id) as Device, token };
}

export function deviceByToken(db: Db, token: string): Device | null {
	if (!token) return null;
	return (db.query(`SELECT ${COLS} FROM devices WHERE token_hash = ?`).get(hash(token)) as Device | null) ?? null;
}

/** A name to start from, out of the browser's user agent: "Safari on iPhone", "Chrome on Android". */
export function deviceName(ua: string): string {
	const os = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android"
		: /Macintosh|Mac OS X/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : /CrOS/.test(ua) ? "Chromebook" : /Linux/.test(ua) ? "Linux" : "";
	const browser = /EdgA?\//.test(ua) ? "Edge" : /SamsungBrowser\//.test(ua) ? "Samsung Internet" : /FxiOS|Firefox\//.test(ua) ? "Firefox"
		: /CriOS|Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "";
	if (os && browser) return `${browser} on ${os}`;
	return os || browser || "Phone";
}

/* ---------- Pairing codes ---------- */

// No 0/O, 1/I/L, 2/Z, 5/S, 8/B: read off a screen and typed on a phone.
const CODE_ALPHABET = "ACDEFGHJKMNPQRTUVWXY34679";
export const CODE_MINUTES = 10;
/** Wrong codes from one address before it has to wait, and in all before the open code stops working. */
export const TRIES_PER_ADDRESS = 5;
export const TRIES_PER_CODE = 10;
const WINDOW_MS = 10 * 60e3;

export const showCode = (code: string) => `${code.slice(0, 4)}-${code.slice(4)}`;
const normalCode = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");

/**
 * The one open pairing code (a new one replaces it), kept in the server's memory only: a restart closes it. `now` is
 * passed in so tests can move the clock.
 */
export class Pairing {
	code: { value: string; expires: number; wrong: number } | null = null;
	private misses = new Map<string, number[]>();

	open(now = Date.now()) {
		this.code = { value: randomChars(CODE_ALPHABET, 8), expires: now + CODE_MINUTES * 60e3, wrong: 0 };
		return { code: showCode(this.code.value), expires: this.code.expires };
	}
	close() {
		this.code = null;
	}
	/** The open code as Settings shows it, or null once it's used, closed or expired. */
	current(now = Date.now()) {
		if (this.code && this.code.expires <= now) this.code = null;
		return this.code ? { code: showCode(this.code.value), expires: this.code.expires } : null;
	}
	/** Wrong tries from this address within the window. */
	private recent(ip: string, now: number) {
		const list = (this.misses.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
		if (list.length) this.misses.set(ip, list);
		else this.misses.delete(ip);
		return list;
	}
	/**
	 * Checks a code typed or scanned on a phone. Right: the code is used up (single use) and true comes back. Wrong:
	 * an Error that says why. Too many wrong ones from one address make it wait; too many in all close the code.
	 */
	redeem(input: string, ip: string, now = Date.now()): true {
		const misses = this.recent(ip, now);
		if (misses.length >= TRIES_PER_ADDRESS)
			throw Object.assign(new Error("Too many wrong codes from this phone. Wait 10 minutes, then try again."), { status: 429 });
		const fail = (msg: string) => {
			misses.push(now);
			this.misses.set(ip, misses);
			return Object.assign(new Error(msg), { status: 400 });
		};
		const open = this.current(now);
		if (!open || !this.code) throw fail("No pairing code is open. On the computer, open Settings → Privacy and security and click Pair a phone.");
		const given = normalCode(input);
		const want = this.code.value;
		if (given.length !== want.length || !timingSafe(given, want)) {
			if (++this.code.wrong >= TRIES_PER_CODE) {
				this.code = null;
				throw fail("That code is wrong, and it has now stopped working after too many tries. Make a new one on the computer.");
			}
			throw fail("That code is wrong, or it has expired. Check it on the computer.");
		}
		this.code = null;
		this.misses.delete(ip);
		return true;
	}
}

function timingSafe(a: string, b: string) {
	let d = 0;
	for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return d === 0;
}

/* ---------- The gate ---------- */

/** The cookie that carries a phone's token. Per port, since a cookie isn't: two boards on one computer keep theirs. */
export const cookieName = (port: number) => `wb_phone_${port}`;
// 400 days, the longest a browser keeps a cookie. Sent again when the phone opens the board, so it lasts while used.
const COOKIE_MAX_AGE = 400 * 86400;
export const deviceCookie = (port: number, token: string) =>
	`${cookieName(port)}=${token}; Path=/; Max-Age=${token ? COOKIE_MAX_AGE : 0}; HttpOnly; SameSite=Strict`;

export function cookieValue(req: Request, name: string) {
	for (const part of (req.headers.get("cookie") ?? "").split(";")) {
		const i = part.indexOf("=");
		if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
	}
	return "";
}

type AnyHandler = (req: Request, srv: Server<unknown>) => Response | Promise<Response>;

/**
 * Wraps every route so that a request from another address gets through only with a paired device's token.
 * `loopback` says whether a request comes from this computer (those never need one). `open` lists the routes that
 * answer without one: the pairing page and what it needs.
 */
export function phoneGate(db: Db, { port, loopback, open }: { port: number; loopback: (req: Request, srv: Server<unknown>) => boolean; open: string[] }) {
	const seen = new Map<string, number>();
	const name = cookieName(port);

	/** The device a request carries, or null. Notes when and from where it was last seen, at most once a minute. */
	const device = (req: Request, srv: Server<unknown>) => {
		const d = deviceByToken(db, cookieValue(req, name));
		if (!d) return null;
		const ip = srv.requestIP(req)?.address ?? "";
		const now = Date.now();
		if (now - (seen.get(d.id) ?? 0) > 60e3 || d.last_ip !== ip) {
			seen.set(d.id, now);
			try {
				db.query("UPDATE devices SET last_seen_at = datetime('now'), last_ip = ? WHERE id = ?").run(ip, d.id);
			} catch {}
		}
		return d;
	};

	/** null: let it through. Else the answer for a phone that isn't paired (or was removed). */
	const check = (req: Request, srv: Server<unknown>): Response | null => {
		if (loopback(req, srv) || device(req, srv)) return null;
		const u = new URL(req.url);
		const dest = req.headers.get("sec-fetch-dest");
		const page = req.method === "GET" && (dest ? dest === "document" : (req.headers.get("accept") ?? "").includes("text/html"));
		if (page) {
			// The address (and the #… part, which a browser keeps across a redirect) comes back after pairing.
			const next = u.pathname === "/" && !u.search ? "" : `?next=${encodeURIComponent(u.pathname + u.search)}`;
			return new Response(null, { status: 302, headers: { location: `/pair${next}`, "cache-control": "no-store" } });
		}
		return Response.json(
			{ error: "This phone isn't paired with the board. On the computer, open Settings → Privacy and security and click Pair a phone." },
			{ status: 401, headers: { "x-wb-pair": "1", "cache-control": "no-store" } },
		);
	};

	const wrap = (h: AnyHandler): AnyHandler => (req, srv) => check(req, srv) ?? h(req, srv);

	/** Every route of the server, wrapped. A route value the gate can't wrap stops the server from starting. */
	function routes<R extends string>(all: Bun.Serve.Routes<unknown, R>): Bun.Serve.Routes<unknown, R> {
		const out: Record<string, unknown> = {};
		for (const [path, value] of Object.entries(all) as [string, unknown][]) {
			if (open.includes(path)) out[path] = value;
			else if (typeof value === "function") out[path] = wrap(value as AnyHandler);
			else if (value instanceof Response) out[path] = wrap(() => value.clone());
			else if (value && typeof value === "object" && !("dir" in value) && !(value instanceof Blob))
				out[path] = Object.fromEntries(
					Object.entries(value).map(([m, h]) => [m, h instanceof Response ? wrap(() => h.clone()) : wrap(h as AnyHandler)]),
				);
			else throw new Error(`phone gate: can't guard the route ${path}`);
		}
		return out as Bun.Serve.Routes<unknown, R>;
	}

	return { check, device, routes, wrap, token: (req: Request) => cookieValue(req, name) };
}
