/**
 * Push notifications from the cloud board (docs/cloud.md, "Using it"): what the board's page pops up while it polls
 * (ui/notify.js), sent by the board itself to the devices that turned them on, so they arrive with the board closed.
 *
 * - **What sends one** is the same as on the page: something new needs Kostas, an agent finished, got stuck or can
 *   carry on, a new or updated report, a tracker that warns, turns bad or stops reading. After every write the board
 *   compares items, reports and trackers with what it saw last (Watch), so a change made any way (the page, MCP, an
 *   ask going ahead by itself) counts. Never to the device that made the change.
 * - **Each device's choices** come with its subscription: Settings → Notifications' kinds and quiet hours, with the
 *   device's time zone. During quiet hours events wait (`held`), and when they end one notification sums them up.
 * - **One subscription per device**, gone with the device (a trigger on `devices`), or when the push service says
 *   the browser dropped it (404, 410).
 * - **The keys** (VAPID) are the board's own, made on first use and kept here. Neither they nor the subscriptions
 *   move with `wb sync` (NOT_MOVED): a subscription belongs to a device, and devices belong to one board.
 */
import type { Db } from "../../src/db";
import { listTrackers, meterText } from "../../src/trackers";
import { makeVapid, sendPush, unb64u, type Vapid } from "./webpush";

/** Settings → Notifications' kinds (ui/notify.js NOTIFY_KINDS). */
export const KINDS = ["needs", "done", "stuck", "resumed", "reports", "trackers"] as const;
export type Kind = (typeof KINDS)[number];
/** What tapping a notification opens, as the page's openTarget takes it. */
export type Target = { item?: number; report?: number; tracker?: number; today?: 1 } | null;
export type PushEvent = { kind: Kind; title: string; body: string; tag: string; target: Target };
export type Prefs = { kinds: Partial<Record<Kind, boolean>>; quiet: boolean; from: string; to: string; weekend: boolean };

/** More events than this for one device at once come as one notification that sums them up. */
const AT_ONCE = 3;
/** While events wait for quiet hours to end, the board looks this often. */
const HELD_CHECK_MS = 5 * 60e3;
/**
 * A push service may say a subscription is gone (404, 410) for a moment after it was made: FCM did, for a second or
 * two, to a new Chrome profile. So a subscription younger than this is tried again before it's dropped.
 */
const NEW_SUB_MS = 2 * 60e3;
const RETRY_MS = [3000, 6000];

export function createPushTables(db: Db) {
	db.run(`CREATE TABLE IF NOT EXISTS push_keys (
		id INTEGER PRIMARY KEY CHECK (id = 1),
		public_key TEXT NOT NULL,
		private_jwk TEXT NOT NULL,
		made_at TEXT NOT NULL DEFAULT (datetime('now'))
	)`);
	db.run(`CREATE TABLE IF NOT EXISTS push_subscriptions (
		device_id TEXT PRIMARY KEY,
		endpoint TEXT NOT NULL UNIQUE,
		p256dh TEXT NOT NULL,
		auth TEXT NOT NULL,
		prefs TEXT NOT NULL DEFAULT '{}',
		tz TEXT NOT NULL DEFAULT 'UTC',
		held TEXT NOT NULL DEFAULT '[]',
		created_at TEXT NOT NULL DEFAULT (datetime('now')),
		sent_at TEXT,
		error TEXT NOT NULL DEFAULT ''
	)`);
	// Removing a device (Settings → Data, or `wb sync off`) stops its notifications at once.
	db.run("CREATE TRIGGER IF NOT EXISTS push_device_gone AFTER DELETE ON devices BEGIN DELETE FROM push_subscriptions WHERE device_id = OLD.id; END");
}

type Sub = { device_id: string; endpoint: string; p256dh: string; auth: string; prefs: string; tz: string; held: string; created_at: string };

/* ---------- What changed ---------- */

type ItemRow = { id: number; ref: string; project: string; title: string; kind: string; owner: string; status: string; updated_at: string; waiting_on: number };
const OPEN = ["todo", "doing", "waiting"];
// ui/core.js needsYou: yours, open, and not a notice.
const needsYou = (i: ItemRow | undefined) => !!i && i.owner === "kostas" && OPEN.includes(i.status) && i.kind !== "notice";
const RANK: Record<string, number> = { "": 0, ok: 1, warn: 2, bad: 3 };

/** What the board looked like at the last write, to tell what a write changed: the page's notifyCheck, on the server. */
export class Watch {
	private items: Map<number, ItemRow> | null = null;
	private reports = new Map<number, number>();
	private trackers = new Map<number, { level: string; error: string }>();
	private mark = "";

	constructor(private readonly db: Db) {}

	/** Starts over from the board as it is, with no events: after a whole board was moved in (`wb sync on`). */
	reset() {
		this.items = null;
		this.events();
	}

	/** What changed since the last call. The first call only takes note of the board. */
	events(): PushEvent[] {
		const db = this.db;
		const first = this.items === null;
		const items = (this.items ??= new Map());
		if (first) this.mark = "";
		// Every change to an item moves its updated_at (the page relies on that too). Same-second changes are
		// caught by comparing the fields, not the time.
		const rows = db
			.query(
				`SELECT id, ref, project, title, kind, owner, status, updated_at, (SELECT COUNT(*) FROM item_links l WHERE l.item_id = items.id) AS waiting_on
				FROM items WHERE updated_at >= ?`,
			)
			.all(this.mark) as ItemRow[];
		const names = new Map((db.query("SELECT slug, name FROM projects").all() as { slug: string; name: string }[]).map((p) => [p.slug, p.name]));
		const where = (slug: string) => names.get(slug) || slug || "every project";
		const out: PushEvent[] = [];
		const ev = (kind: Kind, title: string, body: string, tag: string, target: Target) => out.push({ kind, title, body, tag, target });
		for (const i of rows) {
			const was = items.get(i.id);
			items.set(i.id, i);
			if (i.updated_at > this.mark) this.mark = i.updated_at;
			if (first || (was && was.status === i.status && was.owner === i.owner && was.kind === i.kind)) continue;
			const at = where(i.project);
			const target = { item: i.id };
			if (needsYou(i) && !needsYou(was)) ev("needs", `Needs you · ${at}`, `${i.kind}: ${i.title}`, `wb-${i.ref}`, target);
			else if (i.owner === "agent" && i.status === "done" && was && was.status !== "done") ev("done", `Done · ${at}`, i.title, `wb-${i.ref}`, target);
			else if (i.owner === "agent" && i.status === "todo" && was?.status === "waiting" && was.waiting_on > 0) ev("resumed", `Can carry on · ${at}`, i.title, `wb-${i.ref}`, target);
			else if (i.owner === "agent" && i.status === "waiting" && was && was.status !== "waiting") ev("stuck", `Agent waiting · ${at}`, i.title, `wb-${i.ref}`, target);
		}
		const reports = db
			.query("SELECT r.id, r.project, r.name, r.title, (SELECT MAX(n) FROM report_versions v WHERE v.report_id = r.id) AS version FROM reports r")
			.all() as { id: number; project: string; name: string; title: string; version: number | null }[];
		for (const r of reports) {
			const was = this.reports.get(r.id);
			const version = r.version ?? 0;
			this.reports.set(r.id, version);
			// Day pages are made by the board itself, so they don't ping.
			if (first || r.name.startsWith("day-")) continue;
			if (was === undefined) ev("reports", `New report · ${where(r.project)}`, r.title, `report-${r.id}`, { report: r.id });
			else if (version > was) ev("reports", `Report updated · ${where(r.project)}`, `${r.title} (v${version})`, `report-${r.id}`, { report: r.id });
		}
		for (const t of listTrackers(db)) {
			const was = this.trackers.get(t.id);
			this.trackers.set(t.id, { level: t.level, error: t.error });
			if (first || !was) continue;
			const at = t.project ? where(t.project) : "every project";
			const worst = t.reading?.meters.filter((m) => m.level === t.level).map(meterText).join(" · ") ?? "";
			if (RANK[t.level] > RANK[was.level] && RANK[t.level] >= 2)
				ev("trackers", `${t.level === "bad" ? "Tracker bad" : "Tracker warning"} · ${at}`, `${t.title}: ${worst}`, `trk-${t.id}`, { tracker: t.id });
			else if (t.error && !was.error) ev("trackers", `Tracker failing · ${at}`, `${t.title}: ${t.error}`, `trk-${t.id}`, { tracker: t.id });
		}
		return out;
	}
}

/* ---------- Each device's choices ---------- */

const HHMM = /^(\d{1,2}):(\d{2})$/;
const minutes = (hhmm: string, def: string) => {
	const m = HHMM.exec(hhmm) ?? HHMM.exec(def)!;
	return Number(m[1]) * 60 + Number(m[2]);
};

export function cleanPrefs(raw: unknown): Prefs {
	const p = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
	const k = (p.kinds && typeof p.kinds === "object" ? p.kinds : {}) as Record<string, unknown>;
	const time = (v: unknown, def: string) => (typeof v === "string" && HHMM.test(v) ? v : def);
	return {
		kinds: Object.fromEntries(KINDS.map((kind) => [kind, k[kind] !== false])),
		quiet: p.quiet === true,
		from: time(p.from, "22:00"),
		to: time(p.to, "08:00"),
		weekend: p.weekend === true,
	};
}

export function cleanZone(tz: unknown) {
	try {
		if (typeof tz === "string" && tz) return new Intl.DateTimeFormat("en-US", { timeZone: tz }).resolvedOptions().timeZone;
	} catch {}
	return "UTC";
}

/** Quiet hours as ui/notify.js quietAt has them, at the device's own clock. */
export function quietAt(p: Prefs, tz: string, now = new Date()) {
	if (!p.quiet) return false;
	const parts = Object.fromEntries(
		new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", weekday: "short", hour: "2-digit", minute: "2-digit" }).formatToParts(now).map((x) => [x.type, x.value]),
	);
	if (p.weekend && (parts.weekday === "Sat" || parts.weekday === "Sun")) return true;
	const from = minutes(p.from, "22:00");
	const to = minutes(p.to, "08:00");
	const at = (Number(parts.hour) % 24) * 60 + Number(parts.minute);
	if (from === to) return false;
	return from < to ? at >= from && at < to : at >= from || at < to;
}

/** One notification for several events: ui/notify.js summarise. */
export function summary(events: PushEvent[], title: string): PushEvent {
	const n = (k: Kind) => events.filter((e) => e.kind === k).length;
	const s = (c: number) => (c === 1 ? "" : "s");
	const parts = [
		n("needs") && (n("needs") === 1 ? "1 thing needs you" : `${n("needs")} things need you`),
		n("done") && (n("done") === 1 ? "1 finished by an agent" : `${n("done")} finished by agents`),
		n("stuck") && (n("stuck") === 1 ? "1 agent is waiting" : `${n("stuck")} agents are waiting`),
		n("resumed") && (n("resumed") === 1 ? "1 agent can carry on" : `${n("resumed")} agents can carry on`),
		n("reports") && `${n("reports")} report${s(n("reports"))} added or updated`,
		n("trackers") && `${n("trackers")} tracker${s(n("trackers"))} to look at`,
	].filter(Boolean);
	const first = events.find((e) => e.kind === "needs");
	return { kind: first ? "needs" : events[0].kind, title, body: parts.join(" · ") + (first ? `\n${first.body}` : ""), tag: "wb-away", target: { today: 1 } };
}

/* ---------- Sending ---------- */

const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { "cache-control": "no-store" } });

/** A push service's address: https, or this computer's own for `wrangler dev` and the tests. */
export function pushEndpoint(raw: unknown) {
	const u = new URL(String(raw ?? ""));
	const local = u.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname);
	if (u.protocol !== "https:" && !local) throw new Error("a push subscription's endpoint is an https address");
	return u.href;
}

export class Push {
	readonly watch: Watch;
	private vapid: Vapid | null = null;
	/** Who the board says it is to push services (VAPID's `sub`): its own address when that's https. */
	subject = "https://workbench.invalid";

	constructor(private readonly db: Db) {
		createPushTables(db);
		this.watch = new Watch(db);
		// The board as it is now, so the first write after a restart is compared with something.
		this.watch.events();
	}

	private async keys(): Promise<Vapid> {
		if (this.vapid) return this.vapid;
		const read = () => this.db.query("SELECT public_key, private_jwk FROM push_keys WHERE id = 1").get() as { public_key: string; private_jwk: string } | null;
		if (!read()) {
			const made = await makeVapid();
			this.db.query("INSERT OR IGNORE INTO push_keys (id, public_key, private_jwk) VALUES (1, ?, ?)").run(made.publicKey, JSON.stringify(made.privateJwk));
		}
		const row = read()!;
		return (this.vapid = { publicKey: row.public_key, privateJwk: JSON.parse(row.private_jwk) });
	}

	private subs(except: string | null) {
		return this.db
			.query("SELECT s.* FROM push_subscriptions s JOIN devices d ON d.id = s.device_id WHERE s.device_id != ?")
			.all(except ?? "") as Sub[];
	}

	/** After a write: what changed goes to every device that wants it, but the one that made the change. */
	async after(from: string | null) {
		const events = this.watch.events();
		if (!events.length) return;
		const now = new Date();
		const sends: Promise<unknown>[] = [];
		for (const sub of this.subs(from)) {
			const prefs = cleanPrefs(JSON.parse(sub.prefs || "{}"));
			const wanted = events.filter((e) => prefs.kinds[e.kind] !== false);
			if (!wanted.length) continue;
			if (quietAt(prefs, sub.tz, now)) {
				this.hold(sub, wanted);
				continue;
			}
			sends.push(this.flushOne(sub, prefs).then(() => this.deliver(sub, wanted.length > AT_ONCE ? [summary(wanted, "Workbench")] : wanted)));
		}
		await Promise.allSettled(sends);
	}

	private hold(sub: Sub, events: PushEvent[]) {
		const held = (JSON.parse(sub.held || "[]") as PushEvent[]).filter((h) => !events.some((e) => e.tag === h.tag));
		this.db.query("UPDATE push_subscriptions SET held = ? WHERE device_id = ?").run(JSON.stringify([...held, ...events].slice(-50)), sub.device_id);
	}

	/** Quiet hours over: what waited comes as one notification (or as itself, when it's just one). */
	private async flushOne(sub: Sub, prefs = cleanPrefs(JSON.parse(sub.prefs || "{}"))) {
		const held = (JSON.parse(sub.held || "[]") as PushEvent[]).filter((e) => prefs.kinds[e.kind] !== false);
		if (sub.held === "[]" || quietAt(prefs, sub.tz)) return;
		this.db.query("UPDATE push_subscriptions SET held = '[]' WHERE device_id = ?").run(sub.device_id);
		sub.held = "[]";
		if (held.length) await this.deliver(sub, [held.length === 1 ? held[0] : summary(held, "While you were away")]);
	}

	/** Sends what waited through quiet hours that have now ended, on every device. */
	async flush() {
		const subs = this.db.query("SELECT s.* FROM push_subscriptions s JOIN devices d ON d.id = s.device_id WHERE s.held != '[]'").all() as Sub[];
		await Promise.allSettled(subs.map((s) => this.flushOne(s)));
	}

	/** When the board should next look for quiet hours that ended, or null when nothing waits. */
	nextCheck(now = Date.now()) {
		return this.db.query("SELECT 1 FROM push_subscriptions WHERE held != '[]' LIMIT 1").get() ? now + HELD_CHECK_MS : null;
	}

	private async deliver(sub: Sub, events: (PushEvent & { always?: boolean })[]) {
		const vapid = await this.keys();
		let status = 0;
		for (const e of events) {
			const payload = JSON.stringify({ title: e.title.slice(0, 120), body: e.body.slice(0, 400), tag: e.tag, target: e.target, ...(e.always ? { always: true } : {}) });
			let error = "";
			const young = Date.now() - Date.parse(`${sub.created_at.replace(" ", "T")}Z`) < NEW_SUB_MS;
			for (let attempt = 0; ; attempt++) {
				error = "";
				try {
					const res = await sendPush(sub, payload, vapid, { subject: this.subject, topic: e.tag, urgency: e.kind === "needs" || e.kind === "stuck" ? "high" : "normal" });
					status = res.status;
					if (!res.ok) error = `${res.status} ${(await res.text().catch(() => "")).slice(0, 200)}`.trim();
				} catch (err) {
					status = 0;
					error = (err as Error).message;
				}
				if (!(status === 404 || status === 410) || !young || attempt >= RETRY_MS.length) break;
				await new Promise((r) => setTimeout(r, RETRY_MS[attempt]));
			}
			if (status === 404 || status === 410) {
				// The browser dropped it (unsubscribed, or the app was uninstalled): nothing more goes there.
				console.log(`push: ${sub.device_id}'s subscription is gone (${status})`);
				this.db.query("DELETE FROM push_subscriptions WHERE device_id = ?").run(sub.device_id);
				return status;
			}
			if (error) console.error(`push to ${sub.device_id}: ${error}`);
			this.db.query("UPDATE push_subscriptions SET sent_at = CASE WHEN ? = '' THEN datetime('now') ELSE sent_at END, error = ? WHERE device_id = ?").run(error, error, sub.device_id);
		}
		return status;
	}

	/**
	 * /api/push (GET: the board's key and whether this device has a subscription), /api/push/subscribe (POST with
	 * the browser's subscription, the device's choices and time zone; DELETE), /api/push/test (POST: a real one to
	 * this device). `write` says the board's gate let a write through (the board's own page, JSON).
	 */
	async route(req: Request, path: string, device: string, write: boolean): Promise<Response> {
		const db = this.db;
		const row = () => db.query("SELECT endpoint, error, sent_at FROM push_subscriptions WHERE device_id = ?").get(device) as { endpoint: string; error: string; sent_at: string | null } | null;
		if (path === "/api/push" && req.method === "GET") {
			const r = row();
			return json({ key: (await this.keys()).publicKey, subscribed: !!r, endpoint: r?.endpoint ?? null, error: r?.error ?? "" });
		}
		if (req.method !== "GET" && !write) return json({ error: "push subscriptions change from the board's own page" }, 403);
		if (path === "/api/push/subscribe" && req.method === "POST") {
			try {
				const body = (await req.json()) as { subscription?: { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } }; prefs?: unknown; tz?: unknown };
				const endpoint = pushEndpoint(body.subscription?.endpoint);
				const p256dh = String(body.subscription?.keys?.p256dh ?? "");
				const auth = String(body.subscription?.keys?.auth ?? "");
				const key = unb64u(p256dh);
				if (key.length !== 65 || key[0] !== 4 || unb64u(auth).length !== 16) throw new Error("that isn't a browser's push subscription");
				const prefs = JSON.stringify(cleanPrefs(body.prefs));
				const tz = cleanZone(body.tz);
				db.transaction(() => {
					// One per device, and one device per subscription (a browser paired again under a new device).
					db.query("DELETE FROM push_subscriptions WHERE endpoint = ? AND device_id != ?").run(endpoint, device);
					db.query(
						`INSERT INTO push_subscriptions (device_id, endpoint, p256dh, auth, prefs, tz) VALUES (?, ?, ?, ?, ?, ?)
						ON CONFLICT (device_id) DO UPDATE SET endpoint = excluded.endpoint, p256dh = excluded.p256dh, auth = excluded.auth,
							prefs = excluded.prefs, tz = excluded.tz, error = CASE WHEN endpoint = excluded.endpoint THEN error ELSE '' END,
							created_at = CASE WHEN endpoint = excluded.endpoint THEN created_at ELSE datetime('now') END`,
					).run(device, endpoint, p256dh, auth, prefs, tz);
				})();
				// Choices changed (quiet hours off, say): what waited may go now.
				const sub = db.query("SELECT * FROM push_subscriptions WHERE device_id = ?").get(device) as Sub;
				await this.flushOne(sub);
				return json({ subscribed: true }, 201);
			} catch (e) {
				return json({ error: (e as Error).message }, 400);
			}
		}
		if (path === "/api/push/subscribe" && req.method === "DELETE") {
			db.query("DELETE FROM push_subscriptions WHERE device_id = ?").run(device);
			return json({ subscribed: false });
		}
		if (path === "/api/push/test" && req.method === "POST") {
			const sub = db.query("SELECT * FROM push_subscriptions WHERE device_id = ?").get(device) as Sub | null;
			if (!sub) return json({ error: "this device has no push subscription: turn notifications on first" }, 409);
			const status = await this.deliver(sub, [
				{ kind: "needs", title: "Workbench", body: "Notifications work. They look like this, and tapping one opens what it's about.", tag: "wb-test", target: null, always: true },
			]);
			const r = row();
			if (!r) return json({ error: "the push service says this subscription is gone: turn notifications off and on again" }, 410);
			return r.error ? json({ error: `the push service didn't take it: ${r.error}` }, 502) : json({ sent: true, status });
		}
		return json({ error: "no such push call" }, 404);
	}
}
