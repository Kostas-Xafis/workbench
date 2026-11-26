/**
 * The computer helper, on the cloud board's side (docs/cloud.md, "The computer helper"). The cloud board has no
 * computer: what needs one (agents, tracker commands, git and pull requests, logos, Usage, project folders) is done by
 * a helper on a computer that syncs with it (src/helper.ts), which the board's own code reaches through the hooks it
 * already has (dispatch.ts `launcher`, `places` and `costs`, trackers.ts `reader`).
 *
 * - **Getting through.** A helper holds a WebSocket to this Durable Object (hibernatable: an idle one costs nothing,
 *   and its pings are answered without waking the board), authenticated by its device token like `wb`. One that
 *   can't keep a WebSocket polls instead (/api/helper/poll). Both speak the same messages.
 * - **Jobs.** `ask()` puts a job in `helper_jobs` for one helper (the one online with the folder it needs) and waits
 *   for its answer. Each job goes to exactly one helper, so several computers can sync. With none online, the page
 *   says so in words: no computer is online to do it.
 * - **Runs.** startRun runs here, checks and all; only the process starts on the computer. The helper sends each
 *   run's output as it comes and how it ended; dispatch.ts writes them (save, endRun). Stop asks that computer.
 * - **Idle costs nothing.** The helper's pings are answered without waking the board, and it ticks (trackers that
 *   are due, unblocked work) only when the board says something will be due.
 * - **What the page polls** (git state, commits and pull requests, logos, Usage) is kept in `helper_cache` and
 *   asked again in the background when it's old, so the page never waits on a computer twice.
 */
import { getItem, logVaultAccess, projects, resolveItem, type Db, type VaultAccess } from "../../src/db";
import {
	checkChoices,
	cleanEvents,
	continueRun,
	costs,
	desktop,
	endRun,
	getRun,
	helperContinues,
	ASK_WAIT_MS,
	launcher,
	markMoved,
	places,
	runsInfo,
	save,
	sendUnblocked,
	startRun,
	type From,
	type Launch,
	type Launched,
	type ReadLog,
} from "../../src/dispatch";
import { reader, RUN_TIMEOUT_MS, runDue, type Reading } from "../../src/trackers";
import { agentGit, agentsView, landItem, type GitRead } from "../../src/agents";
import type { CodeLinks, RepoState } from "../../src/git";
import { landingGit, landingNightly, type Ask, type DiffStat, type FactsRead, type LandingFacts } from "../../src/landing";
import { getSetting } from "../../src/settings";

export const NO_COMPUTER =
	"No computer is online to do it. Open the Workbench app, or run wb serve, on a computer that syncs with this board.";
const NO_COMPUTER_AGENTS = "No computer is online to start agents on. Open the Workbench app, or run wb serve, on a computer that syncs with this board.";

/** A helper is online while its WebSocket pings (every 30 s) or it polls (every 25 s) within this long. */
const ONLINE_MS = 90e3;
/** The longest a poll waits for a job. */
const POLL_MS = 25e3;

/** What a helper sends. */
type Hello = { t: "hello"; name?: unknown; version?: unknown; folders?: unknown; caps?: unknown };
type Wire = ReadLog;
type FromHelper =
	| Hello
	| { t: "done"; id: number; ok?: unknown; error?: string }
	| { t: "run"; id: number; live: Wire }
	| { t: "ended"; id: number; code: number | null; live: Wire }
	| { t: "tick" }
	| { t: "adopt"; id: number };
/** What it gets back. */
type ToHelper =
	| { t: "welcome"; device: string; name: string; runs: RunRef[]; orphans: RunRef[] }
	| { t: "job"; id: number; kind: string; payload: unknown }
	| { t: "stop"; id: number }
	| { t: "ack"; id: number }
	/** When to tick next: when the next tracker is due (a minute at most while unblocked work is sent by itself). */
	| { t: "next"; ms: number };

type RunRef = { id: number; tag: string; pid: number; unit: string; status: string; started_at: string };
/** `caps`: what its helper says it can do beyond what its version says ("continue"); none from one before 0.5.0. */
export type Computer = { device: string; name: string; version: string; folders: string[]; caps?: string[]; via: "ws" | "poll"; ws?: WebSocket };
type Attachment = { device: string; at: number; hello?: Omit<Computer, "device" | "via" | "ws"> };

export class NoComputer extends Error {}

const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { "cache-control": "no-store" } });

export class Helpers {
	private readonly waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
	private readonly pollers = new Map<string, Set<() => void>>();
	/** Cache refreshes on their way, by cache key, so a page that polls doesn't ask twice. */
	private readonly refreshing = new Map<string, Promise<unknown>>();
	private costMemo: { key: string; at: number; value: Map<string, number> } | null = null;
	private ticking = false;
	/** After a helper's message changed the board (a job's answer, a run that ended, a tick): push.ts tells the devices. */
	changed: () => void = () => {};

	constructor(
		private readonly ctx: DurableObjectState,
		private readonly db: Db,
	) {
		db.run(`CREATE TABLE IF NOT EXISTS helper_jobs (
			id INTEGER PRIMARY KEY, kind TEXT NOT NULL, payload TEXT NOT NULL, device TEXT NOT NULL,
			cache TEXT NOT NULL DEFAULT '', created INTEGER NOT NULL, expires INTEGER NOT NULL, taken_at INTEGER)`);
		db.run("CREATE TABLE IF NOT EXISTS helper_seen (device TEXT PRIMARY KEY, name TEXT NOT NULL, version TEXT NOT NULL, folders TEXT NOT NULL, seen INTEGER NOT NULL)");
		if (!(db.query("PRAGMA table_info(helper_seen)").all() as { name: string }[]).some((c) => c.name === "caps"))
			db.run("ALTER TABLE helper_seen ADD COLUMN caps TEXT NOT NULL DEFAULT '[]'");
		db.run("CREATE TABLE IF NOT EXISTS helper_runs (run_id INTEGER PRIMARY KEY, device TEXT NOT NULL)");
		// Which computer each run ran on, kept after it ends (helper_runs is only the live ones): a continuation goes
		// to the computer that has the session.
		db.run("CREATE TABLE IF NOT EXISTS helper_ran (run_id INTEGER PRIMARY KEY, device TEXT NOT NULL)");
		db.run("CREATE TABLE IF NOT EXISTS helper_cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, at INTEGER NOT NULL)");
		// A helper's keep-alive, answered without waking the board.
		ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));

		// The board's own code, with what needs a computer handed to one.
		launcher.launch = (spec) => this.launch(spec);
		places.has = (path) => this.online().some((h) => h.folders.includes(path));
		places.continueWhy = (session, folder) => {
			try {
				const h = this.continuer(session, folder);
				return helperContinues(h.version, h.caps) ? "" : `Update the Workbench app on ${h.name} to continue sessions from the board.`;
			} catch (e) {
				return (e as Error).message;
			}
		};
		costs.of = (sessions, since = 0) => this.costs(sessions, since);
		agentGit.read = (list) => this.gitForAgents(list);
		landingGit.facts = (asks, maxAge, fresh) => this.landingFor(asks, maxAge, fresh);
		landingGit.diff = (p, branch) => this.diffFor(p, branch);
		desktop.here = false;
		reader.read = (t, folder) =>
			this.ask<Reading>("tracker", { tracker: { id: t.id, kind: t.kind, command: t.command, options: t.options, name: t.name, project: t.project }, folder }, { prefer: folder, timeout: RUN_TIMEOUT_MS + 15e3 });
	}

	/* ---------- Who is online ---------- */

	online(): Computer[] {
		const out = new Map<string, Computer>();
		const now = Date.now();
		for (const ws of this.ctx.getWebSockets()) {
			const a = ws.deserializeAttachment() as Attachment | null;
			if (!a?.hello) continue;
			const pinged = this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime() ?? 0;
			if (now - Math.max(a.at, pinged) > ONLINE_MS) continue;
			if (!out.has(a.device)) out.set(a.device, { device: a.device, ...a.hello, via: "ws", ws });
		}
		const seen = this.db.query("SELECT device, name, version, folders, caps FROM helper_seen WHERE seen > ?").all(now - ONLINE_MS) as {
			device: string;
			name: string;
			version: string;
			folders: string;
			caps: string;
		}[];
		for (const s of seen) if (!out.has(s.device)) out.set(s.device, { ...s, folders: JSON.parse(s.folders), caps: JSON.parse(s.caps || "[]"), via: "poll" });
		// A removed device is no helper, even before its socket closes.
		return [...out.values()].filter((h) => this.deviceOk(h.device));
	}

	private deviceOk(device: string) {
		return !!this.db.query("SELECT 1 FROM devices WHERE id = ?").get(device);
	}

	/** The helper for a job: one with `need` (a folder) when given, else preferably one with `prefer`, a WebSocket first. */
	private pick(o: { need?: string; prefer?: string; device?: string } = {}): Computer {
		const all = this.online();
		if (o.device) {
			const h = all.find((x) => x.device === o.device);
			if (!h) throw new NoComputer("The computer that runs it isn't online.");
			return h;
		}
		if (!all.length) throw new NoComputer(NO_COMPUTER);
		const fit = o.need ? all.filter((h) => h.folders.includes(o.need!)) : all;
		if (!fit.length) throw new NoComputer(`No computer that's online has ${o.need}. Open the Workbench app, or run wb serve, on the one that has it.`);
		const score = (h: Computer) => (o.prefer && h.folders.includes(o.prefer) ? 2 : 0) + (h.via === "ws" ? 1 : 0);
		return fit.sort((a, b) => score(b) - score(a) || b.folders.length - a.folders.length)[0];
	}

	/* ---------- Jobs ---------- */

	/** A job for one helper, and its answer (thrown when it fails, or when none answers in `timeout`). */
	ask<T>(kind: string, payload: unknown, o: { need?: string; prefer?: string; device?: string; timeout?: number; cache?: string } = {}): Promise<T> {
		let h: Computer;
		try {
			h = this.pick(o);
		} catch (e) {
			return Promise.reject(e);
		}
		const timeout = o.timeout ?? 20e3;
		const now = Date.now();
		const { id } = this.db
			.query("INSERT INTO helper_jobs (kind, payload, device, cache, created, expires) VALUES (?, ?, ?, ?, ?, ?) RETURNING id")
			.get(kind, JSON.stringify(payload), h.device, o.cache ?? "", now, now + timeout) as { id: number };
		const answer = new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.waiting.delete(id);
				this.db.query("DELETE FROM helper_jobs WHERE id = ?").run(id);
				reject(new Error(`${h.name} didn't answer within ${Math.round(timeout / 1000)} s.`));
			}, timeout);
			this.waiting.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
		});
		this.deliver(h.device);
		return answer;
	}

	/** Hands a device its waiting jobs: over its WebSocket, or to its poll. */
	private deliver(device: string) {
		const ws = this.socketOf(device);
		if (ws) {
			for (const job of this.take(device))
				try {
					ws.send(JSON.stringify(job));
				} catch {
					this.db.query("UPDATE helper_jobs SET taken_at = NULL WHERE id = ?").run(job.id);
				}
		} else for (const wake of this.pollers.get(device) ?? []) wake();
	}

	private socketOf(device: string) {
		return this.online().find((h) => h.device === device && h.ws)?.ws;
	}

	/** The device's jobs that nobody took yet, now taken. */
	private take(device: string): Extract<ToHelper, { t: "job" }>[] {
		const now = Date.now();
		this.db.query("DELETE FROM helper_jobs WHERE expires < ?").run(now);
		const rows = this.db
			.query("UPDATE helper_jobs SET taken_at = ? WHERE id IN (SELECT id FROM helper_jobs WHERE device = ? AND taken_at IS NULL ORDER BY id LIMIT 20) RETURNING id, kind, payload")
			.all(now, device) as { id: number; kind: string; payload: string }[];
		return rows.sort((a, b) => a.id - b.id).map((r) => ({ t: "job", id: r.id, kind: r.kind, payload: JSON.parse(r.payload) }));
	}

	private done(device: string, m: Extract<FromHelper, { t: "done" }>) {
		const job = this.db.query("DELETE FROM helper_jobs WHERE id = ? AND device = ? RETURNING cache").get(Number(m.id), device) as { cache: string } | null;
		if (job?.cache && m.error === undefined)
			this.db.query("INSERT OR REPLACE INTO helper_cache (key, value, at) VALUES (?, ?, ?)").run(job.cache, JSON.stringify(m.ok ?? null), Date.now());
		const w = this.waiting.get(Number(m.id));
		if (!w) return;
		clearTimeout(w.timer);
		this.waiting.delete(Number(m.id));
		if (m.error !== undefined) w.reject(new Error(String(m.error)));
		else w.resolve(m.ok);
	}

	/* ---------- The board's hooks ---------- */

	/** dispatch.ts's launcher: the run's process starts on a computer that has its folder. */
	/** The computer a continuation of `session` goes to: the one it ran on, when it's online with the folder; else one with the folder. */
	private continuer(session: string, folder: string): Computer {
		const before = (this.db.query("SELECT h.device FROM helper_ran h JOIN runs r ON r.id = h.run_id WHERE r.session = ? ORDER BY h.run_id DESC LIMIT 1").get(session) as { device: string } | null)?.device;
		return before && this.online().some((x) => x.device === before && x.folders.includes(folder)) ? this.pick({ device: before }) : this.pick({ need: folder });
	}

	private async launch(spec: Launch): Promise<Launched> {
		const folder = spec.folder || spec.cwd;
		const h = spec.resume ? this.continuer(spec.resume, folder) : this.pick({ need: folder });
		// An older helper would run a continuation as a fresh run (it knows no resume, folder or base).
		if (spec.resume && !helperContinues(h.version, h.caps)) throw new Error(`Update the Workbench app on ${h.name} to continue sessions from the board.`);
		this.db.query("INSERT OR REPLACE INTO helper_runs (run_id, device) VALUES (?, ?)").run(spec.id, h.device);
		this.db.query("INSERT OR REPLACE INTO helper_ran (run_id, device) VALUES (?, ?)").run(spec.id, h.device);
		// Long enough for the computer's window asking whether a new command may run (ASK_WAIT_MS): a yes starts it.
		const out = await this.ask<Launched>("run", spec, { device: h.device, timeout: ASK_WAIT_MS + 30e3 });
		return { pid: Number(out?.pid) || 0, unit: String(out?.unit ?? ""), cwd: typeof out?.cwd === "string" ? out.cwd.slice(0, 1000) : "" };
	}

	/** What sessions cost, from Claude Code's transcripts on a computer: asked at most once a minute. */
	private async costs(sessions: string[], since: number): Promise<Map<string, number>> {
		const ids = sessions.filter(Boolean);
		if (!ids.length || !this.online().length) return new Map();
		const key = `${since}:${ids.join(",")}`;
		if (this.costMemo?.key === key && Date.now() - this.costMemo.at < 60e3) return this.costMemo.value;
		try {
			const got = await this.ask<Record<string, number>>("costs", { sessions: ids, since }, { timeout: 8e3 });
			const value = new Map(Object.entries(got ?? {}).map(([k, v]) => [k, Number(v) || 0]));
			this.costMemo = { key, at: Date.now(), value };
			return value;
		} catch {
			return this.costMemo?.value ?? new Map();
		}
	}

	/**
	 * What a computer knows, kept in helper_cache: fresh for `maxAge`; older, it's answered at once and asked again
	 * behind it. Only the first time does a request wait (up to `wait`) for the computer.
	 */
	private async cached<T>(key: string, maxAge: number, kind: string, payload: unknown, fallback: T, wait = 8e3, device?: string): Promise<T> {
		const row = this.db.query("SELECT value, at FROM helper_cache WHERE key = ?").get(key) as { value: string; at: number } | null;
		if (row && Date.now() - row.at < maxAge) return JSON.parse(row.value) as T;
		if (!this.online().length) return row ? (JSON.parse(row.value) as T) : fallback;
		let p = this.refreshing.get(key) as Promise<T> | undefined;
		if (!p) {
			p = this.ask<T>(kind, payload, { cache: key, timeout: 60e3, ...(device ? { device } : {}) });
			this.refreshing.set(key, p);
			p.catch(() => {}).finally(() => this.refreshing.delete(key));
		}
		if (row) return JSON.parse(row.value) as T;
		return Promise.race([p, new Promise<T>((r) => setTimeout(() => r(fallback), wait))]).catch(() => fallback);
	}

	/**
	 * The Agents place's git (agents.ts), for the projects it names (those with finished work on a branch): what the
	 * page's own git and code polls keep, when that covers them (the board-wide answer, key "", or the one project's),
	 * else these projects alone, asked under a key of their own. With what isn't known said in words.
	 */
	private async gitForAgents(wanted: { slug: string; path: string }[]): Promise<GitRead> {
		const list = wanted.map((p) => ({ slug: p.slug, path: p.path }));
		const slugs = list.map((p) => p.slug).sort();
		const live = new Set(
			projects(this.db)
				.filter((p) => !p.archived_at)
				.map((p) => p.slug),
		);
		const read = async <T>(kind: "git" | "code", maxAge: number, fallback: T): Promise<{ value: T; at: number | null }> => {
			const own = slugs.length === 1 ? `${kind}:${slugs[0]}` : `${kind}:agents:${slugs.join(",")}`;
			const keys = slugs.every((s) => live.has(s)) ? [own, `${kind}:`] : [own];
			const rows = keys
				.map((k) => this.db.query("SELECT value, at FROM helper_cache WHERE key = ?").get(k) as { value: string; at: number } | null)
				.filter((r): r is { value: string; at: number } => !!r)
				.sort((a, b) => b.at - a.at);
			const newest = rows[0];
			if (newest && Date.now() - newest.at < maxAge) return { value: JSON.parse(newest.value) as T, at: newest.at };
			// Old: shown meanwhile, and these projects asked again behind it (only ever under their own key).
			if (newest) {
				void this.cached<T>(own, maxAge, kind, { projects: list }, fallback).catch(() => {});
				return { value: JSON.parse(newest.value) as T, at: newest.at };
			}
			const value = await this.cached<T>(own, maxAge, kind, { projects: list }, fallback);
			const at = (this.db.query("SELECT at FROM helper_cache WHERE key = ?").get(own) as { at: number } | null)?.at ?? null;
			return { value, at };
		};
		const [g, c] = await Promise.all([read<RepoState[]>("git", 30e3, []), read<CodeLinks>("code", 90e3, {})]);
		const repos = (g.value ?? []).filter((r) => slugs.includes(r.project));
		const code = c.value;
		const limits: string[] = [];
		const row = g.at === null ? null : { at: g.at };
		const online = this.online();
		if (!online.length)
			limits.push(
				row
					? `No computer is online: git state is as a computer last sent it, ${Math.max(1, Math.round((Date.now() - row.at) / 60e3))} min ago.`
					: "No computer is online, and none has sent git state yet: the board can't tell which branches are merged.",
			);
		else if (!row) limits.push(`${online[0].name} is reading git state for the first time: ready to land fills in on the next look.`);
		if ((repos ?? []).some((r) => r.ok && r.base === undefined))
			limits.push("The computer that sends git state has an older Workbench app: no commit counts per branch, and the main branch is taken to be main or master. Update the app there.");
		if (!(repos ?? []).length && list.length && row) limits.push("No computer has these projects' folders, so their git state isn't known.");
		return { repos: repos ?? [], code: code ?? {}, limits };
	}

	/* ---------- The landing desk (src/landing.ts) ---------- */

	/** A helper that runs the landing desk's jobs (an app from before them doesn't), one with `folder` first. */
	private lander(folder = ""): Computer | null {
		const fit = this.online().filter((h) => h.caps?.includes("landing") && (!folder || h.folders.includes(folder)));
		return fit.sort((a, b) => (b.via === "ws" ? 1 : 0) - (a.via === "ws" ? 1 : 0) || b.folders.length - a.folders.length)[0] ?? null;
	}

	/** The landing pass for the Agents place, kept in helper_cache like git state; `fresh` (the daily pass) waits for it. */
	private async landingFor(asks: Ask[], maxAge: number, fresh = false): Promise<FactsRead> {
		const key = `landing:${asks.map((a) => a.project.slug).sort().join(",")}`;
		const payload = { projects: asks.map((a) => ({ slug: a.project.slug, path: a.project.path, want: a.want, own: a.own })) };
		const online = this.online();
		const h = this.lander();
		const limits: string[] = [];
		if (online.length && !h) limits.push(`Update the Workbench app on ${online[0].name} so the board can tell which finished work landed, which is lost, and which merges cleanly.`);
		if (!h) {
			const row = this.db.query("SELECT value FROM helper_cache WHERE key = ?").get(key) as { value: string } | null;
			return { facts: row ? (JSON.parse(row.value) as LandingFacts[]) : [], limits };
		}
		if (fresh) return { facts: (await this.ask<LandingFacts[]>("landing", payload, { device: h.device, cache: key, timeout: 60e3 })) ?? [], limits };
		return { facts: (await this.cached<LandingFacts[]>(key, maxAge, "landing", payload, [], 8e3, h.device)) ?? [], limits };
	}

	/** What one branch changes (the reader's file list), from a computer that has the project's folder. */
	private async diffFor(p: { slug: string; path: string }, branch: string): Promise<DiffStat> {
		const h = this.lander(p.path);
		if (!h) {
			const any = this.online().find((x) => x.folders.includes(p.path));
			throw new NoComputer(any ? `Update the Workbench app on ${any.name} to see what a branch changes.` : `No computer that's online has ${p.path}.`);
		}
		return this.ask<DiffStat>("diffstat", { project: p, branch }, { device: h.device, timeout: 20e3 });
	}

	/** When the daily landing pass last ran here (helper_cache, so a board that slept doesn't run it again). */
	private readonly night = {
		get: () => Number((this.db.query("SELECT value FROM helper_cache WHERE key = 'landing:night'").get() as { value: string } | null)?.value ?? 0) || 0,
		set: (ms: number) => void this.db.query("INSERT OR REPLACE INTO helper_cache (key, value, at) VALUES ('landing:night', ?, ?)").run(String(ms), ms),
	};

	/* ---------- Routes the board hands over ---------- */

	/**
	 * The routes a computer answers on the cloud board (board.ts sends them here before its own table). null: the
	 * board's own route answers it (the hooks above do the computer's part).
	 */
	async route(pattern: string, req: Request, url: URL, c: { device: { id: string; name: string } | null; boardOnly: boolean; localRead: boolean }): Promise<Response | null> {
		const db = this.db;
		const list = (only: string | null) =>
			projects(db)
				.filter((p) => (only ? p.slug === only : !p.archived_at))
				.map((p) => ({ slug: p.slug, path: p.path }));
		const post = req.method === "POST";
		const refuse = (error: string, status = 403) => json({ error }, status);
		switch (pattern) {
			case "/api/runs": {
				if (req.method === "GET" && !url.searchParams.get("item")) return json(await this.runsPanel(c.device?.name ?? ""));
				if (!post) return null;
				if (!c.boardOnly) return refuse("agents start only from the board's own page or a tool with this board's token");
				if (!this.online().length) return refuse(NO_COMPUTER_AGENTS, 503);
				try {
					const { item, answer, object, from, choices } = (await req.json()) as { item?: unknown; answer?: unknown; object?: unknown; from?: unknown; choices?: unknown };
					const id = resolveItem(db, String(item));
					if (id === undefined) throw new Error(`no item ${item}`);
					const how = answer !== undefined ? { answer: Array.isArray(answer) ? answer.map(String) : String(answer) } : object !== undefined ? { object: String(object) } : {};
					const name = c.device?.name || "the cloud board";
					const who: From = from === "cli" ? { where: "cli", label: `wb run on ${name}` } : { where: "local", label: name };
					// A model, effort or mode for this run only (wb run --model …); the computer still checks the command.
					const run = await startRun(db, id, who, { ...how, choices: checkChoices(choices) });
					return json({ run, item: getItem(db, run.item_id) }, 201);
				} catch (e) {
					return json({ error: (e as Error).message }, 400);
				}
			}
			case "/api/runs/:id/continue": {
				if (!post) return null;
				if (!c.boardOnly) return refuse("agents start only from the board's own page or a tool with this board's token");
				if (!this.online().length) return refuse(NO_COMPUTER_AGENTS, 503);
				try {
					const { message, from } = (await req.json()) as { message?: unknown; from?: unknown };
					const name = c.device?.name || "the cloud board";
					const who: From = from === "cli" ? { where: "cli", label: `wb continue on ${name}` } : { where: "local", label: name };
					const run = await continueRun(db, Number(url.pathname.split("/")[3]), String(message ?? ""), who);
					return json({ run, item: getItem(db, run.item_id) }, 201);
				} catch (e) {
					return json({ error: (e as Error).message }, 400);
				}
			}
			case "/api/agents": {
				const name = c.device?.name || "the cloud board";
				try {
					const view = await agentsView(db, { project: url.searchParams.get("project") || "*", since: url.searchParams.get("since") || undefined }, c.boardOnly ? { where: "local", label: name } : null);
					if (!this.online().length) view.start = { allowed: false, why: view.start.why || NO_COMPUTER_AGENTS };
					return json(view);
				} catch (e) {
					return json({ error: (e as Error).message }, 400);
				}
			}
			case "/api/items/:id/land": {
				if (!post) return null;
				if (!c.boardOnly) return refuse("agents start only from the board's own page or a tool with this board's token");
				if (!this.online().length) return refuse(NO_COMPUTER_AGENTS, 503);
				try {
					const ref = decodeURIComponent(url.pathname.split("/")[3] ?? "");
					const id = resolveItem(db, ref);
					if (id === undefined) throw new Error(`no item ${ref}`);
					const { from } = (await req.json().catch(() => ({}))) as { from?: unknown };
					const name = c.device?.name || "the cloud board";
					const who: From = from === "cli" ? { where: "cli", label: `wb land on ${name}` } : { where: "local", label: name };
					const run = await landItem(db, id, who);
					return json({ run, item: getItem(db, run.item_id) }, 201);
				} catch (e) {
					return json({ error: (e as Error).message }, 400);
				}
			}
			case "/api/runs/:id/stop": {
				if (!post) return null;
				if (!c.boardOnly) return refuse("runs stop only from the board's own page or a tool with this board's token");
				return this.stop(Number(url.pathname.split("/")[3]));
			}
			// Move to Claude Desktop: marked moved here, then stopped on its computer as Stop does. The page opens the
			// session's link on the device it's on.
			case "/api/runs/:id/move": {
				if (!post) return null;
				if (!c.boardOnly) return refuse("runs stop only from the board's own page or a tool with this board's token");
				try {
					markMoved(db, Number(url.pathname.split("/")[3]));
				} catch (e) {
					return json({ error: (e as Error).message }, 400);
				}
				return this.stop(Number(url.pathname.split("/")[3]));
			}
			case "/api/runs/test": {
				if (!post) return null;
				if (!c.boardOnly) return refuse("Settings → Agents tests the command from the board's own page");
				const { command } = (await req.json().catch(() => ({}))) as { command?: unknown };
				try {
					return json(await this.ask("test", { command: String(command || getSetting<string>(db, "agents.command")) }, { timeout: 45e3 }));
				} catch (e) {
					return refuse((e as Error).message, e instanceof NoComputer ? 503 : 504);
				}
			}
			case "/api/trackers/:id/refresh":
				return post && !this.online().length ? refuse(NO_COMPUTER, 503) : null;
			case "/api/git": {
				const only = url.searchParams.get("project");
				return json(await this.cached(`git:${only ?? ""}`, 30e3, "git", { projects: list(only) }, [] as unknown[]));
			}
			case "/api/code": {
				const only = url.searchParams.get("project");
				return json(await this.cached(`code:${only ?? ""}`, 90e3, "code", { projects: list(only) }, {}));
			}
			case "/api/projects/:slug/logo": {
				const p = projects(db).find((x) => x.slug === decodeURIComponent(url.pathname.split("/")[3] ?? ""));
				const logo = p
					? await this.cached<{ type: string; b64: string } | null>(`logo:${p.slug}:${p.path}:${p.icon ?? ""}`, 86400e3, "logo", { project: { slug: p.slug, path: p.path, icon: p.icon } }, null, 5e3)
					: null;
				if (!logo) return new Response("no logo", { status: 404, headers: { "cache-control": "max-age=300" } });
				return new Response(Buffer.from(logo.b64, "base64"), {
					headers: { "content-type": logo.type, "cache-control": "max-age=3600", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'" },
				});
			}
			case "/api/usage": {
				if (!c.localRead) return refuse("usage opens on the board's own page");
				if (!this.online().length) {
					const row = db.query("SELECT value FROM helper_cache WHERE key = 'usage'").get() as { value: string } | null;
					return row ? json(JSON.parse(row.value)) : refuse(NO_COMPUTER, 503);
				}
				try {
					if (url.searchParams.has("fresh")) return json(await this.ask("usage", { projects: projects(db), fresh: true }, { cache: "usage", timeout: 120e3 }));
					return json(await this.cached("usage", 60e3, "usage", { projects: projects(db) }, null, 60e3) ?? { error: "the computer is still reading Claude Code's files: try again in a moment" });
				} catch (e) {
					return refuse((e as Error).message, 504);
				}
			}
			case "/api/settings/folders":
				try {
					return json(await this.ask("folders", { projects: list(null) }, { timeout: 10e3 }));
				} catch (e) {
					return refuse((e as Error).message, e instanceof NoComputer ? 503 : 504);
				}
		}
		return null;
	}

	/** Settings → Agents and the item dialog's panel: as on a computer, with whether a computer is there to run them. */
	private async runsPanel(device: string) {
		const info = await runsInfo(this.db, { where: "local", label: device });
		const computers = this.online().map((h) => h.name);
		if (computers.length) return { ...info, computers };
		return { ...info, allowed: false, why: info.on ? NO_COMPUTER_AGENTS : info.why, computers };
	}

	/** Settings → Projects: the folders and their agent files as the computer sees them. */
	async projectsTab(res: Response): Promise<Response> {
		if (!res.ok || !this.online().length) return res;
		const list = (await res.json()) as { path: string; folder?: unknown; agents?: unknown }[];
		const paths = [...new Set(list.map((p) => p.path).filter(Boolean))];
		try {
			const seen = await this.ask<Record<string, { folder: unknown; agents: unknown }>>("projects", { paths }, { timeout: 10e3 });
			for (const p of list) if (seen?.[p.path]) Object.assign(p, seen[p.path]);
		} catch {}
		return json(list);
	}

	/** Stop: the run is marked stopped here, and the computer that runs it ends it (and says how it ended). */
	private async stop(id: number): Promise<Response> {
		const db = this.db;
		const r = getRun(db, id);
		if (!r) return json({ error: "no such run" }, 400);
		if (r.ended_at) return json(r);
		db.query("UPDATE runs SET status = 'stopped' WHERE id = ? AND ended_at IS NULL").run(id);
		const at = (db.query("SELECT device FROM helper_runs WHERE run_id = ?").get(id) as { device: string } | null)?.device;
		const there = !!at && this.online().some((h) => h.device === at);
		if (there) await this.ask("stop", { id: r.id, pid: r.pid, tag: r.tag, unit: r.unit }, { device: at, timeout: 10e3 }).catch(() => {});
		const now = getRun(db, id)!;
		// Its computer is gone: what's known is how it ended. (If it comes back, its helper is told to stop it.)
		if (!now.ended_at && !there)
			endRun(db, { ...now, status: "stopped" }, null, { offset: 1, lines: now.tail ? now.tail.split("\n") : [], session: now.session, cost: now.cost, result: "", isError: false, refused: {}, cwd: now.cwd });
		return json(getRun(db, id));
	}

	/* ---------- What helpers send ---------- */

	/** One message from a helper; what it gets back. */
	async handle(device: string, m: FromHelper, ws?: WebSocket): Promise<ToHelper[]> {
		const db = this.db;
		switch (m?.t) {
			case "hello":
				return this.hello(device, m, ws);
			case "done":
				this.done(device, m);
				this.changed();
				return [];
			case "run": {
				const r = getRun(db, Number(m.id));
				// Ended here (stopped from the board, or it failed to start in time): its process goes too.
				if (!r || r.ended_at || r.status === "stopped") return [{ t: "stop", id: Number(m.id) }];
				save(db, r, wire(m.live));
				return [];
			}
			case "ended": {
				const r = getRun(db, Number(m.id));
				if (r && !r.ended_at) endRun(db, r, m.code === null ? null : Number(m.code), wire(m.live));
				db.query("DELETE FROM helper_runs WHERE run_id = ?").run(Number(m.id));
				this.changed();
				return [{ t: "ack", id: Number(m.id) }];
			}
			case "adopt":
				// A run that was going before this board was in the cloud (or whose helper's row went): its process is on that computer.
				db.query("INSERT OR IGNORE INTO helper_runs (run_id, device) SELECT id, ? FROM runs WHERE id = ? AND ended_at IS NULL").run(device, Number(m.id));
				return [];
			case "tick":
				await this.tick();
				this.changed();
				return [{ t: "next", ms: this.nextTick() }];
		}
		return [];
	}

	private hello(device: string, m: Hello, ws?: WebSocket): ToHelper[] {
		const db = this.db;
		// Named as its device is (Settings → Data lists it), not as it names itself.
		const named = (db.query("SELECT name FROM devices WHERE id = ?").get(device) as { name: string } | null)?.name;
		const hello = {
			name: String(named || m.name || "a computer").slice(0, 80),
			version: String(m.version ?? "").slice(0, 40),
			folders: (Array.isArray(m.folders) ? m.folders : []).filter((f): f is string => typeof f === "string").slice(0, 1000),
			caps: (Array.isArray(m.caps) ? m.caps : []).filter((c): c is string => typeof c === "string").slice(0, 20).map((c) => c.slice(0, 40)),
		};
		if (ws) ws.serializeAttachment({ device, at: Date.now(), hello } satisfies Attachment);
		else
			db.query("INSERT OR REPLACE INTO helper_seen (device, name, version, folders, caps, seen) VALUES (?, ?, ?, ?, ?, ?)").run(
				device,
				hello.name,
				hello.version,
				JSON.stringify(hello.folders),
				JSON.stringify(hello.caps),
				Date.now(),
			);
		// Trackers that couldn't read while no computer was online read again now.
		db.query("UPDATE trackers SET checked_at = NULL WHERE error LIKE 'No computer%'").run();
		db.query("DELETE FROM helper_runs WHERE run_id NOT IN (SELECT id FROM runs WHERE ended_at IS NULL)").run();
		const runs = db
			.query("SELECT r.id, r.tag, r.pid, r.unit, r.status, r.started_at FROM runs r JOIN helper_runs h ON h.run_id = r.id WHERE h.device = ? AND r.ended_at IS NULL")
			.all(device) as RunRef[];
		const orphans = db
			.query("SELECT id, tag, pid, unit, status, started_at FROM runs WHERE ended_at IS NULL AND pid > 0 AND id NOT IN (SELECT run_id FROM helper_runs)")
			.all() as RunRef[];
		// Jobs that waited for it (a reconnect) go once it has its welcome.
		if (ws) setTimeout(() => this.deliver(device), 0);
		return [{ t: "welcome", device, name: hello.name, runs, orphans }];
	}

	/** Every 15 s from a helper: the trackers that are due, and unblocked work Settings says to send. */
	private async tick() {
		if (this.ticking) return;
		this.ticking = true;
		try {
			for (const t of await runDue(this.db)) if (t.error) console.log(`tracker ${t.ref}: ${t.error}`);
			for (const r of await sendUnblocked(this.db)) console.log(`agents: run #${r.id} on wb-${r.ref} started by itself`);
			// The landing desk's daily pass, with a computer that can do it; not waited for (it asks the computer).
			if (this.lander())
				void landingNightly(this.db, this.night)
					.then((n) => n && this.changed())
					.catch((e) => console.error(`landing: ${(e as Error).message}`));
		} catch (e) {
			console.error(`helper tick: ${(e as Error).message}`);
		} finally {
			this.ticking = false;
		}
	}

	/** How long until a tick has something to do, so an idle board isn't woken for nothing (15 s to 10 min). */
	private nextTick() {
		const row = this.db
			.query(
				`SELECT MIN(CASE WHEN checked_at IS NULL THEN 0 ELSE CAST(strftime('%s', checked_at) AS INTEGER) + every - CAST(strftime('%s', 'now') AS INTEGER) END) AS s
				FROM trackers WHERE kind != 'manual' AND every > 0 AND project NOT IN (SELECT slug FROM projects WHERE archived_at IS NOT NULL)`,
			)
			.get() as { s: number | null } | null;
		let ms = row?.s == null ? 600e3 : row.s * 1000;
		if (getSetting<boolean>(this.db, "agents.on") && getSetting<string>(this.db, "agents.unblocked") === "send") ms = Math.min(ms, 60e3);
		return Math.max(15e3, Math.min(600e3, ms));
	}

	/* ---------- The way in ---------- */

	/** /api/helper/*: only a tool with a device token in a header (a helper, `wb`), never a page. */
	async fetch(req: Request, url: URL, device: { id: string; name: string } | null): Promise<Response> {
		if (!device || !/^Bearer\s/i.test(req.headers.get("authorization") ?? "") || req.headers.get("origin"))
			return json({ error: "the helper's calls take a device token in an Authorization header" }, 403);
		const what = url.pathname.slice("/api/helper/".length);
		if (what === "ws") {
			if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") return json({ error: "this is a WebSocket" }, 426);
			const pair = new WebSocketPair();
			const [client, server] = [pair[0], pair[1]];
			this.ctx.acceptWebSocket(server, [device.id]);
			server.serializeAttachment({ device: device.id, at: Date.now() } satisfies Attachment);
			return new Response(null, { status: 101, webSocket: client } as ResponseInit);
		}
		if (what === "" && req.method === "GET")
			return json({ computers: this.online().map(({ ws: _, folders, ...h }) => ({ ...h, folders: folders.length })) });
		if (req.method !== "POST") return json({ error: "POST" }, 405);
		const body = (await req.json().catch(() => ({}))) as { msgs?: FromHelper[]; hello?: Hello; wait?: number; entry?: Omit<VaultAccess, "id" | "at"> };
		if (what === "call") {
			const out: ToHelper[] = [];
			for (const m of (body.msgs ?? []).slice(0, 100)) out.push(...(await this.handle(device.id, m)));
			return json({ msgs: out });
		}
		if (what === "poll") {
			const out = body.hello ? this.hello(device.id, { ...body.hello, t: "hello" }) : [];
			let jobs = this.take(device.id);
			if (!jobs.length) {
				const wait = Math.min(POLL_MS, Math.max(0, Number(body.wait) || 0) * 1000);
				await new Promise<void>((resolve) => {
					const set = this.pollers.get(device.id) ?? new Set();
					const done = () => {
						clearTimeout(timer);
						set.delete(done);
						resolve();
					};
					const timer = setTimeout(done, wait);
					set.add(done);
					this.pollers.set(device.id, set);
				});
				jobs = this.take(device.id);
			}
			return json({ msgs: [...out, ...jobs] });
		}
		if (what === "vault-log") {
			// The relay's vault_get and vault_list (relay.ts) open the window on that computer; the log is kept here.
			const e = body.entry;
			const outcomes = ["given", "denied", "no-answer", "wrong-password", "off", "failed"];
			if (!e || !["names", "values"].includes(e.what) || !outcomes.includes(e.outcome)) return json({ error: "not a vault request" }, 400);
			logVaultAccess(this.db, {
				project: String(e.project ?? "").slice(0, 80),
				session: String(e.session ?? "").slice(0, 120),
				what: e.what,
				asked: Number(e.asked) || 0,
				secrets: (Array.isArray(e.secrets) ? e.secrets : []).map(Number).filter(Number.isInteger).slice(0, 50),
				delivery: e.delivery === "text" ? "text" : e.delivery === "file" ? "file" : "",
				outcome: e.outcome,
			});
			return json({ ok: true });
		}
		return json({ error: "no such helper call" }, 404);
	}

	async message(ws: WebSocket, data: string | ArrayBuffer) {
		const a = ws.deserializeAttachment() as Attachment | null;
		if (!a || !this.deviceOk(a.device)) {
			try {
				ws.close(4001, "this computer's device was removed from the cloud board");
			} catch {}
			return;
		}
		let m: FromHelper;
		try {
			m = JSON.parse(typeof data === "string" ? data : new TextDecoder().decode(data));
		} catch {
			return;
		}
		if (m?.t !== "hello" && a.hello) ws.serializeAttachment({ ...a, at: Date.now() } satisfies Attachment);
		for (const out of await this.handle(a.device, m, ws))
			try {
				ws.send(JSON.stringify(out));
			} catch {}
	}

	/** A helper's socket closed: what it had taken and not answered goes to its next connection. */
	closed(ws: WebSocket) {
		const a = ws.deserializeAttachment() as Attachment | null;
		try {
			ws.close(1000, "closed");
		} catch {}
		if (!a) return;
		const others = this.ctx.getWebSockets(a.device).filter((s) => s !== ws);
		if (!others.length) this.db.query("UPDATE helper_jobs SET taken_at = NULL WHERE device = ?").run(a.device);
	}
}

/** A run's output as a helper sent it, checked. */
function wire(l: Partial<Wire> | undefined): Wire {
	return {
		offset: Number(l?.offset) || 1,
		lines: (Array.isArray(l?.lines) ? l.lines : []).map(String).slice(-200),
		session: String(l?.session ?? ""),
		cost: typeof l?.cost === "number" ? l.cost : null,
		result: String(l?.result ?? ""),
		isError: !!l?.isError,
		// Tool names and counts only (an older helper sends none).
		refused: Object.fromEntries(
			Object.entries(l?.refused && typeof l.refused === "object" ? l.refused : {})
				.filter(([k, n]) => typeof n === "number" && n > 0 && k.length <= 100)
				.slice(0, 50)
				.map(([k, n]) => [k, Math.floor(n as number)]),
		),
		// The folder it runs in, and what it said and did (an older helper sends neither).
		cwd: typeof l?.cwd === "string" ? l.cwd.slice(0, 1000) : "",
		events: cleanEvents(l?.events),
	};
}
