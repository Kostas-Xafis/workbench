/**
 * Answer & send: the board starts a Claude Code agent on an item (README → "Agents the board starts").
 *
 * A run is one agent started headless (`claude -p`, Settings → Agents has the command) in the project's folder, on
 * one item: Run on an agent's to-do, Answer & send on a decision (or an objection to a review or notice), `wb run`,
 * or by itself when waiting work is unblocked and Settings says "send it". It's off until turned on, only this
 * computer starts one unless a paired phone is allowed, and there are limits: how many at once, how many a day, and
 * an optional daily cost, counted from Claude Code's transcripts as the Usage page does (usage.ts).
 *
 * A run outlives the board. Like a report share's cloudflared (share.ts), the process runs in its own session (and
 * its own systemd scope, so restarting the board's service doesn't stop it), writing its output to a log file and,
 * when it ends, its exit code to a file next to it. Whoever looks next (the board every 2 s, `wb runs`) reads the
 * new output into the run's tail, and finishes a run whose process is gone: from its exit code, or as failed when
 * there is none (the computer restarted, or it was killed). So a restart never leaves a run "running" for ever.
 */
import { spawn } from "node:child_process";
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, rmSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { addNote, getItem, getProject, type Db, type Item } from "./db";
import { resolveAsk } from "./asks";
import { AGENT_COMMAND, dayStartHour, getSetting, yourName } from "./settings";
import { runShell, shellPath } from "./trackers";
import { sessionsCost } from "./usage";

export { AGENT_COMMAND };
export type RunStatus = "running" | "done" | "failed" | "stopped";
export type Run = {
	id: number;
	item_id: number;
	ref: string;
	title: string;
	project: string;
	started_at: string;
	/** NULL while it runs (a stopped run has its status before its end). */
	ended_at: string | null;
	status: RunStatus;
	exit_code: number | null;
	/** The Claude Code session, to continue it with `claude --resume`; '' until known. */
	session: string;
	/** $ as the agent reported it at the end; null until then (or never, for another command). */
	cost: number | null;
	/** The last lines of its output, made readable. */
	tail: string;
	/** What the agent said at the end. */
	result: string;
	error: string;
	/** kostas, or board when it started by itself (unblocked work). */
	started_by: string;
	/** "this computer", "phone (Pixel 8)", "wb run", "unblocked". */
	started_from: string;
	command: string;
	pid: number;
	unit: string;
	tag: string;
};
/** Who asks for a run, and from where. */
export type From = { where: "local" | "phone" | "cli" | "auto"; label: string; by?: string };

const TAIL_LINES = 200;
const LINE_MAX = 500;

export function createRunTables(db: Db) {
	db.run(`CREATE TABLE IF NOT EXISTS runs (
		id INTEGER PRIMARY KEY,
		item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
		project TEXT NOT NULL,
		started_at TEXT NOT NULL DEFAULT (datetime('now')),
		ended_at TEXT,
		status TEXT NOT NULL DEFAULT 'running',
		exit_code INTEGER,
		session TEXT NOT NULL DEFAULT '',
		cost REAL,
		tail TEXT NOT NULL DEFAULT '',
		result TEXT NOT NULL DEFAULT '',
		error TEXT NOT NULL DEFAULT '',
		started_by TEXT NOT NULL DEFAULT 'kostas',
		started_from TEXT NOT NULL DEFAULT '',
		command TEXT NOT NULL DEFAULT '',
		pid INTEGER NOT NULL DEFAULT 0,
		unit TEXT NOT NULL DEFAULT '',
		tag TEXT NOT NULL DEFAULT ''
	)`);
	db.run("CREATE INDEX IF NOT EXISTS runs_item ON runs(item_id, id)");
	db.run("CREATE INDEX IF NOT EXISTS runs_started ON runs(started_at)");
}

/* ---------- Reading runs ---------- */

const COLS = "r.*, i.ref, i.title";
const FROM = "runs r JOIN items i ON i.id = r.item_id";
export const getRun = (db: Db, id: number) => (db.query(`SELECT ${COLS} FROM ${FROM} WHERE r.id = ?`).get(id) as Run | null) ?? undefined;
/** The newest first; `item` for one item's. */
export function listRuns(db: Db, { item, limit = 20 }: { item?: number; limit?: number } = {}): Run[] {
	return db
		.query(`SELECT ${COLS} FROM ${FROM} ${item ? "WHERE r.item_id = $item" : ""} ORDER BY r.id DESC LIMIT $limit`)
		.all({ limit, ...(item ? { item } : {}) }) as Run[];
}
export const latestRun = (db: Db, item: number) => listRuns(db, { item, limit: 1 })[0];
const running = (db: Db) => db.query(`SELECT ${COLS} FROM ${FROM} WHERE r.ended_at IS NULL ORDER BY r.id`).all() as Run[];

const sqlTime = (d: Date) => d.toISOString().slice(0, 19).replace("T", " ");
const fromSql = (s: string) => new Date(s.replace(" ", "T") + "Z");
/** When today began, as the board counts days (Settings → You and your day: a work day starts at …). */
export function dayStart(db: Db, now = new Date()) {
	const h = dayStartHour(db);
	const d = new Date(now.getTime() - h * 3600e3);
	return new Date(d.getFullYear(), d.getMonth(), d.getDate(), h);
}
const startedToday = (db: Db, now = new Date()) =>
	db.query("SELECT * FROM runs WHERE started_at >= ? ORDER BY id").all(sqlTime(dayStart(db, now))) as Run[];

/** Where the cost of sessions comes from; tests put their own here instead of Claude Code's transcripts. */
export const costs = { of: sessionsCost };
/** What today's runs cost: per run, the Usage page's count for its session, or what the agent reported if more. */
export async function spentToday(db: Db, now = new Date()): Promise<number> {
	const today = startedToday(db, now);
	if (!today.length) return 0;
	const measured = await costs.of(today.map((r) => r.session), dayStart(db, now).getTime()).catch(() => new Map<string, number>());
	return today.reduce((sum, r) => sum + Math.max(r.cost ?? 0, measured.get(r.session) ?? 0), 0);
}

export type Limits = { on: boolean; phone: boolean; atOnce: number; perDay: number; cap: number; unblocked: "tell" | "send"; command: string };
export const limits = (db: Db): Limits => ({
	on: getSetting<boolean>(db, "agents.on"),
	phone: getSetting<boolean>(db, "agents.phone"),
	atOnce: getSetting<number>(db, "agents.at-once"),
	perDay: getSetting<number>(db, "agents.per-day"),
	cap: getSetting<number>(db, "agents.day-dollars"),
	unblocked: getSetting<"tell" | "send">(db, "agents.unblocked"),
	command: getSetting<string>(db, "agents.command"),
});

/** "#12 done · started 2026-11-12 09:14 UTC from this computer · 14 min · $0.42 · claude --resume <id>", for agents and wb. */
export function runLine(r: Run): string {
	const end = r.ended_at ? fromSql(r.ended_at).getTime() : Date.now();
	return [
		`#${r.id} ${r.status}`,
		`started ${r.started_at.slice(0, 16)} UTC from ${r.started_from}`,
		`${r.ended_at ? "" : "for "}${minutes(end - fromSql(r.started_at).getTime())}`,
		r.cost != null && `$${r.cost.toFixed(2)}`,
		r.error,
		r.session && `claude --resume ${r.session}`,
	]
		.filter(Boolean)
		.join(" · ");
}

/* ---------- Whether a run may start ---------- */

const ASK_KINDS = ["decision", "review", "notice"];
const folderOf = (db: Db, slug: string) => {
	const p = getProject(db, slug);
	return p?.path && existsSync(p.path) ? p.path : "";
};

/** Why this item can't get an agent (its state, its folder, a run on it), or undefined. `answering`: it's an ask
 * of Kostas's that the same call answers first, so it is checked as it will be once handed back. */
export function itemRefusal(db: Db, i: Item, answering = false): string | undefined {
	const name = yourName(db);
	if (i.status === "done" || i.status === "dropped") return `wb-${i.ref} is ${i.status}`;
	if (answering) {
		if (i.owner !== "kostas" || !ASK_KINDS.includes(i.kind)) return `wb-${i.ref} isn't a decision, review or notice waiting on ${name}`;
	} else {
		if (i.owner === "kostas") return `wb-${i.ref} waits on ${name}: answer it first (Answer & send does both)`;
		if (i.kind === "idea") return `wb-${i.ref} is an idea: make it a task first`;
		if (i.status === "doing") return `wb-${i.ref} is being worked on already (doing)`;
		if (i.status === "waiting") return `wb-${i.ref} waits on something (waiting)`;
	}
	if (!folderOf(db, i.project)) return `the project ${i.project} has no folder on this computer (Settings → Projects)`;
	const busy = db.query("SELECT id FROM runs WHERE item_id = ? AND ended_at IS NULL").get(i.id) as { id: number } | null;
	if (busy) return `an agent is on wb-${i.ref} already (run #${busy.id})`;
}

export type Refusal = { why: string; limit?: boolean };
/** Why `from` may not start agents now at all (off, a phone, a limit), or undefined. */
export async function startRefusal(db: Db, from: From, now = new Date()): Promise<Refusal | undefined> {
	const no = countRefusal(db, from, now);
	if (no) return no;
	const l = limits(db);
	if (l.cap) {
		const spent = await spentToday(db, now);
		if (spent >= l.cap) return { why: `Today's agents cost $${spent.toFixed(2)}, the cap is $${l.cap} (Settings → Agents).`, limit: true };
	}
}
/** startRefusal without the cost, which takes a look at the transcripts: what can be checked at once. */
function countRefusal(db: Db, from: From, now = new Date()): Refusal | undefined {
	const l = limits(db);
	if (!l.on) return { why: "The board doesn't start agents: turn it on in Settings → Agents." };
	if (from.where === "phone" && !l.phone) return { why: "Agents start only from this computer. Settings → Agents can allow a paired phone." };
	const n = running(db).length;
	if (n >= l.atOnce) return { why: `${n} agent${n === 1 ? " runs" : "s run"} already, the most at once (Settings → Agents).`, limit: true };
	const today = startedToday(db, now).length;
	if (today >= l.perDay) return { why: `${today} agent${today === 1 ? "" : "s"} started today, the most per day (Settings → Agents).`, limit: true };
}

/* ---------- Starting one ---------- */

/** What the agent is told. Its brief is the item: it reads it with get_item. */
export function runPrompt(db: Db, i: Pick<Item, "ref" | "title">): string {
	const name = yourName(db);
	return `Work on wb-${i.ref} (${i.title}) from the workbench. ${name} sent it to you from the board; nobody watches this session, so don't ask questions here.
1. Read it with the wb MCP server's get_item: its body, answer and notes are the brief. Then start_item it.
2. Do it, by this project's own rules (its CLAUDE.md or AGENTS.md).
3. Done: finish_item with a note on what changed and where (commit, branch). Need ${name} for a decision, a check or a review: file it as its own item and wait on it (add_item with blocks: wb-${i.ref}). Blocked otherwise: wait_item, saying on what.
Without the MCP server, the wb command does the same: wb show, wb start, wb done, wb wait.`;
}

const WINDOWS = process.platform === "win32";
// Runtime files (gone at reboot, like the runs themselves), named by the run's tag: its database and number. Read
// when used: db.ts imports this file while it loads.
const runDir = () =>
	process.env.WB_RUNS_DIR ??
	join(process.env.XDG_RUNTIME_DIR || join(tmpdir(), `workbench-${WINDOWS ? userInfo().username : userInfo().uid}`), "workbench-runs");
const tagOf = (db: Db, id: number) => `wb-run-${Bun.hash(db.filename).toString(36)}-${id}`;
const logPath = (r: Pick<Run, "tag">) => join(runDir(), `${r.tag}.log`);
const exitPath = (r: Pick<Run, "tag">) => join(runDir(), `${r.tag}.exit`);

// Under systemd, a restart of the board's service stops every process in it; a scope of its own keeps a run out of
// that (as share.ts does for cloudflared). Asked once.
let scopeOk: Promise<boolean> | null = null;
function canScope() {
	scopeOk ??= (async () => {
		if (process.env.WB_RUNS_SCOPE === "0" || process.platform !== "linux" || !Bun.which("systemd-run")) return false;
		// With the environment the run gets (process.env as it is now; Bun.spawn's default is the one at start).
		const p = Bun.spawn(["systemd-run", "--user", "--scope", "--quiet", "true"], { env: { ...process.env }, stdout: "ignore", stderr: "ignore" });
		return (await p.exited) === 0;
	})();
	return scopeOk;
}

// What a run's process mustn't inherit from a board started inside a Claude Code session: the agent would think
// it's nested in that one.
const NESTED = ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SSE_PORT"];

/**
 * Starts an agent on an item, after every check (startRefusal, itemRefusal); throws the reason otherwise. With
 * `answer` or `object`, first answers the ask (resolveAsk) — only once the run may start, so a refusal leaves it
 * unanswered. Returns the run.
 */
export async function startRun(
	db: Db,
	itemId: number,
	from: From,
	how: { answer?: string | string[]; object?: string } = {},
): Promise<Run> {
	let i = getItem(db, itemId);
	if (!i) throw new Error(`no item #${itemId}`);
	const answering = how.answer !== undefined || how.object !== undefined;
	const no = await startRefusal(db, from);
	if (no) throw new Error(no.why);
	// Checked again with nothing awaited from here to the insert, so two clicks at once can't both get through.
	i = getItem(db, itemId)!;
	const now = countRefusal(db, from)?.why ?? itemRefusal(db, i, answering);
	if (now) throw new Error(now);
	if (how.answer !== undefined) i = resolveAsk(db, itemId, { answer: how.answer }, from.by ?? "kostas")!;
	else if (how.object !== undefined) {
		if (i.kind === "decision") throw new Error("answer a decision instead");
		i = resolveAsk(db, itemId, { object: how.object }, from.by ?? "kostas")!;
	}
	const cwd = folderOf(db, i.project);
	const command = limits(db).command;
	const session = crypto.randomUUID();
	const { id } = db
		.query("INSERT INTO runs (item_id, project, session, started_by, started_from, command) VALUES (?, ?, ?, ?, ?, ?) RETURNING id")
		// The session is known now only when the command passes it on; else it comes from the output, if at all.
		.get(i.id, i.project, command.includes("WB_SESSION") ? session : "", from.by ?? (from.where === "auto" ? "board" : "kostas"), from.label, command) as { id: number };
	const tag = tagOf(db, id);
	db.query("UPDATE runs SET tag = ? WHERE id = ?").run(tag, id);
	const run = { id, tag } as Run;
	try {
		mkdirSync(runDir(), { recursive: true, mode: 0o700 });
		rmSync(exitPath(run), { force: true });
		const fd = openSync(logPath(run), "w", 0o600);
		// The exit code goes to a file, so whoever looks later knows how it ended. $0 is the tag, so the process can be
		// told from another one that got the same pid.
		const argv = ["bash", "-c", `${command}\nprintf '%s' "$?" > "$WB_RUN_EXIT"`, tag];
		const scoped = await canScope();
		const full = scoped ? ["systemd-run", "--user", "--scope", "--quiet", `--unit=${tag}`, ...argv] : argv;
		const env: Record<string, string> = {};
		for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !NESTED.includes(k)) env[k] = v;
		Object.assign(env, {
			PATH: await shellPath(),
			NO_COLOR: "1",
			WB_PROMPT: runPrompt(db, i),
			WB_ITEM: `wb-${i.ref}`,
			WB_TITLE: i.title,
			WB_PROJECT: i.project,
			WB_SESSION: session,
			WB_RUN: String(id),
			WB_RUN_EXIT: exitPath(run),
		});
		const child = spawn(full[0], full.slice(1), { cwd, env, detached: true, windowsHide: true, stdio: ["ignore", fd, fd] });
		closeSync(fd);
		child.on("error", (e) => {
			db.query("UPDATE runs SET error = ? WHERE id = ?").run(`couldn't start: ${e.message}`, id);
		});
		child.unref();
		db.query("UPDATE runs SET pid = ?, unit = ? WHERE id = ?").run(child.pid ?? 0, scoped ? tag : "", id);
	} catch (e) {
		db.query("UPDATE runs SET status = 'failed', ended_at = datetime('now'), error = ? WHERE id = ?").run(`couldn't start: ${(e as Error).message}`, id);
		throw new Error(`the agent couldn't start: ${(e as Error).message}`);
	}
	addNote(db, i.id, `Agent started (run #${id}, from ${from.label})`, "workbench");
	return getRun(db, id)!;
}

/* ---------- Following them ---------- */

/** What this process has read of a run's log so far. */
type Live = { offset: number; partial: string; lines: string[]; session: string; cost: number | null; result: string; isError: boolean };
const live = new Map<number, Live>();
/** For tests: forget what was read, as a board that just started knows nothing. */
export const forgetRuns = () => live.clear();

const oneLine = (s: string, n = 160) => {
	const t = s.replace(/\s+/g, " ").trim();
	return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
function push(l: Live, text: string, prefix = "") {
	for (const raw of text.split("\n")) {
		const t = raw.trimEnd();
		if (!t.trim()) continue;
		l.lines.push((prefix + t).slice(0, LINE_MAX));
	}
	if (l.lines.length > TAIL_LINES) l.lines.splice(0, l.lines.length - TAIL_LINES);
}
/** What a tool call was about, in a few words: its command, file, pattern or address. */
function toolWhat(input: unknown): string {
	if (!input || typeof input !== "object") return "";
	const o = input as Record<string, unknown>;
	for (const k of ["command", "file_path", "path", "pattern", "url", "query", "ref", "description", "prompt"])
		if (typeof o[k] === "string" && o[k]) return `: ${oneLine(o[k] as string)}`;
	return "";
}
const minutes = (ms: number) => {
	const m = Math.round(ms / 60e3);
	return m < 1 ? "under a minute" : m < 90 ? `${m} min` : `${(m / 60).toFixed(1)} h`;
};
/** One line of output: Claude Code's stream-json made readable; anything else as it is. */
export function readLine(l: Live, line: string) {
	const t = line.trim();
	if (!t) return;
	let d: Record<string, any> | undefined;
	if (t.startsWith("{"))
		try {
			d = JSON.parse(t);
		} catch {}
	if (!d || typeof d !== "object") return push(l, t);
	if (typeof d.session_id === "string" && d.session_id) l.session = d.session_id;
	if (d.type === "system" && d.subtype === "init") push(l, `Started${d.model ? ` with ${d.model}` : ""}${d.cwd ? ` in ${d.cwd}` : ""}`);
	else if (d.type === "assistant")
		for (const c of d.message?.content ?? []) {
			if (c?.type === "text" && typeof c.text === "string") push(l, c.text);
			else if (c?.type === "tool_use") push(l, `→ ${c.name}${toolWhat(c.input)}`);
		}
	else if (d.type === "user")
		for (const c of d.message?.content ?? []) {
			if (c?.type !== "tool_result" || !c.is_error) continue;
			const text = typeof c.content === "string" ? c.content : Array.isArray(c.content) ? c.content.map((x: any) => x?.text ?? "").join(" ") : "";
			push(l, `  ✗ ${oneLine(text) || "refused"}`);
		}
	else if (d.type === "result") {
		if (typeof d.total_cost_usd === "number") l.cost = d.total_cost_usd;
		if (typeof d.result === "string") l.result = d.result;
		l.isError = !!d.is_error || (typeof d.subtype === "string" && d.subtype !== "success");
		const facts = [
			typeof d.num_turns === "number" && `${d.num_turns} turn${d.num_turns === 1 ? "" : "s"}`,
			typeof d.duration_ms === "number" && minutes(d.duration_ms),
			typeof d.total_cost_usd === "number" && `$${d.total_cost_usd.toFixed(2)}`,
		].filter(Boolean);
		push(l, `— ${l.isError ? `ended with an error${d.subtype && d.subtype !== "success" ? ` (${d.subtype})` : ""}` : "finished"}${facts.length ? `: ${facts.join(", ")}` : ""}`);
	}
	// Other stream events (partial messages, hooks, …) aren't worth a line.
}
export const newLive = (): Live => ({ offset: 0, partial: "", lines: [], session: "", cost: null, result: "", isError: false });

/** Reads what the log got since the last look. */
function readLog(r: Run): Live {
	let l = live.get(r.id);
	if (!l) live.set(r.id, (l = newLive()));
	let fd: number;
	try {
		fd = openSync(logPath(r), "r");
	} catch {
		return l;
	}
	try {
		const size = fstatSync(fd).size;
		if (size < l.offset) Object.assign(l, newLive());
		while (l.offset < size) {
			const buf = Buffer.alloc(Math.min(1 << 20, size - l.offset));
			const n = readSync(fd, buf, 0, buf.length, l.offset);
			if (!n) break;
			l.offset += n;
			const text = l.partial + buf.subarray(0, n).toString("utf8");
			const lines = text.split("\n");
			l.partial = lines.pop() ?? "";
			for (const line of lines) readLine(l, line);
		}
	} finally {
		closeSync(fd);
	}
	return l;
}

/** Whether that pid is still this run's process (not gone, not a zombie, not another program that got the pid). */
function alive(r: Pick<Run, "pid" | "tag">) {
	if (!r.pid || !r.tag) return false;
	try {
		process.kill(r.pid, 0);
	} catch {
		return false;
	}
	if (process.platform === "linux") {
		try {
			return readFileSync(`/proc/${r.pid}/cmdline`, "utf8").includes(r.tag);
		} catch {
			return false;
		}
	}
	return Bun.spawnSync(["ps", "-ww", "-o", "args=", "-p", String(r.pid)]).stdout.toString().includes(r.tag);
}
const exitCode = (r: Run): number | null => {
	try {
		const s = readFileSync(exitPath(r), "utf8").trim();
		return /^\d+$/.test(s) ? Number(s) : null;
	} catch {
		return null;
	}
};

/** Writes what was read to the run. Nothing when this process read nothing (the log may be gone: another one
 * finished the run meanwhile, and its tail stays). */
function save(db: Db, r: Run, l: Live) {
	if (!l.offset) return;
	db.query("UPDATE runs SET tail = ?, session = CASE WHEN ? != '' THEN ? ELSE session END, cost = COALESCE(?, cost) WHERE id = ?").run(
		l.lines.join("\n"),
		l.session,
		l.session,
		l.cost,
		r.id,
	);
}

/** Ends a run whose process is gone: its status from how it ended, a line in the item's history, its files away. */
function finish(db: Db, r: Run, code: number | null) {
	if (getRun(db, r.id)?.ended_at) return;
	const l = readLog(r);
	if (l.partial) {
		readLine(l, l.partial);
		l.partial = "";
	}
	const status: RunStatus = r.status === "stopped" ? "stopped" : code === 0 && !l.isError ? "done" : "failed";
	const error =
		status === "stopped" ? "" : code === null
			? r.error || "It ended without an exit code: the computer restarted, or it was killed."
			: code !== 0 ? `exit ${code}${l.lines.length ? `: ${oneLine(l.lines.at(-1)!, 200)}` : ""}` : l.isError ? "The agent ended with an error." : "";
	save(db, r, l);
	const changed = db
		.query("UPDATE runs SET status = ?, exit_code = ?, ended_at = datetime('now'), result = ?, error = ? WHERE id = ? AND ended_at IS NULL")
		.run(status, code, l.result.slice(0, 4000), error, r.id).changes;
	live.delete(r.id);
	rmSync(logPath(r), { force: true });
	rmSync(exitPath(r), { force: true });
	if (!changed) return;
	const done = getRun(db, r.id)!;
	const took = minutes(fromSql(done.ended_at!).getTime() - fromSql(done.started_at).getTime());
	const word = { done: "finished", failed: "failed", stopped: "was stopped", running: "" }[status];
	addNote(
		db,
		r.item_id,
		`Agent run #${r.id} ${word} after ${took}${done.cost != null ? ` · $${done.cost.toFixed(2)}` : ""}${error ? ` · ${error}` : ""}`,
		"workbench",
	);
}

/**
 * Looks at every run that hasn't ended: reads its new output, and finishes the ones whose process is gone. The board
 * does it every 2 s and at start (so runs that ended while it was off are closed); `wb runs` too. Returns them as
 * they are now.
 */
export function pollRuns(db: Db): Run[] {
	for (const r of running(db)) {
		// Just inserted by another process, which hasn't written the pid yet.
		if (!r.pid && Date.now() - fromSql(r.started_at).getTime() < 30e3) continue;
		const l = readLog(r);
		save(db, r, l);
		let code = exitCode(r);
		if (code === null && alive(r)) continue;
		code ??= exitCode(r); // it may have just written it
		finish(db, r, code);
	}
	return running(db);
}

/** Stops a run: its whole process group (and scope), politely, then for sure after 3 s. */
export async function stopRun(db: Db, id: number, by = "kostas"): Promise<Run> {
	const r = getRun(db, id);
	if (!r) throw new Error(`no run #${id}`);
	if (r.ended_at) return r;
	db.query("UPDATE runs SET status = 'stopped' WHERE id = ? AND ended_at IS NULL").run(id);
	const kill = (sig: NodeJS.Signals) => {
		if (r.unit) Bun.spawnSync(["systemctl", "--user", "kill", `--signal=${sig}`, `${r.unit}.scope`], { stdout: "ignore", stderr: "ignore" });
		if (!alive(r)) return;
		try {
			process.kill(-r.pid, sig);
		} catch {
			try {
				process.kill(r.pid, sig);
			} catch {}
		}
	};
	kill("SIGTERM");
	for (let n = 0; n < 30 && alive(r); n++) await Bun.sleep(100);
	if (alive(r)) kill("SIGKILL");
	for (let n = 0; n < 10 && alive(r); n++) await Bun.sleep(100);
	finish(db, { ...r, status: "stopped" }, exitCode(r));
	if (by !== "kostas") addNote(db, r.item_id, `Stopped by ${by}`, "workbench");
	return getRun(db, id)!;
}

/* ---------- Unblocked work ---------- */

const warned = new Set<string>();
/**
 * With Settings → Agents "When an agent's work is unblocked: send it", starts an agent on each agent to-do that was
 * unblocked (links.ts writes "Unblocked: …" when it resumes one) since that was set, in the last day, and has had no
 * run since. Whatever process resumed it (the board, `wb`, an agent's MCP server), the board sees it here. Limits
 * apply: what they hold back is sent when they allow, the same day.
 */
export async function sendUnblocked(db: Db, now = new Date()): Promise<Run[]> {
	const l = limits(db);
	if (!l.on || l.unblocked !== "send") return [];
	const set = db.query("SELECT MAX(updated_at) AS at FROM settings WHERE key IN ('agents.on', 'agents.unblocked')").get() as { at: string | null };
	const since = [set.at ?? "", sqlTime(new Date(now.getTime() - 86400e3))].sort().at(-1)!;
	const rows = db
		.query(
			`SELECT n.item_id AS id, MAX(n.at) AS at FROM notes n JOIN items i ON i.id = n.item_id
			WHERE n.author = 'workbench' AND n.text LIKE 'Unblocked:%' AND n.at >= ? AND i.owner = 'agent' AND i.status = 'todo'
			AND NOT EXISTS (SELECT 1 FROM runs r WHERE r.item_id = n.item_id AND r.started_at >= n.at)
			GROUP BY n.item_id ORDER BY MIN(n.id)`,
		)
		.all(since) as { id: number; at: string }[];
	const out: Run[] = [];
	for (const { id, at } of rows) {
		const from: From = { where: "auto", label: "unblocked", by: "board" };
		const no = await startRefusal(db, from, now);
		if (no) {
			if (!warned.has(`limit:${id}`)) console.log(`agents: unblocked work waits: ${no.why}`);
			warned.add(`limit:${id}`);
			break;
		}
		const i = getItem(db, id)!;
		const why = itemRefusal(db, i);
		if (why) {
			if (!warned.has(`${id}:${at}`)) console.log(`agents: not sending wb-${i.ref}: ${why}`);
			warned.add(`${id}:${at}`);
			continue;
		}
		try {
			out.push(await startRun(db, id, from));
			console.log(`agents: wb-${i.ref} was unblocked; started run #${out.at(-1)!.id}`);
		} catch (e) {
			console.error(`agents: wb-${i.ref}: ${(e as Error).message}`);
		}
	}
	return out;
}

/* ---------- What the board shows ---------- */

/** Settings → Agents and the board: the limits, what's used of them, whether `from` may start one, recent runs. */
export async function runsInfo(db: Db, from: From | null) {
	const l = limits(db);
	const active = running(db);
	const today = startedToday(db).length;
	const spent = await spentToday(db);
	const no = from || !l.on ? await startRefusal(db, from ?? { where: "local", label: "" }) : { why: "Agents start only from the board on this computer." };
	const folders = (db.query("SELECT slug, path FROM projects").all() as { slug: string; path: string }[])
		.filter((p) => p.path && existsSync(p.path))
		.map((p) => p.slug);
	const strip = ({ tail: _, command: __, ...r }: Run) => r;
	return {
		...l,
		// Whether this client may start one at all (on, and this computer or an allowed phone), and why not.
		allowed: !!l.on && !(from?.where === "phone" && !l.phone) && !!from,
		why: no?.why ?? "",
		limited: !!no?.limit,
		running: active.length,
		today,
		spent: Math.round(spent * 100) / 100,
		folders,
		// What an agent is told, for an item wb-xxxx titled "…" (Settings → Agents shows it).
		prompt: runPrompt(db, { ref: "xxxx", title: "the item's title" }),
		active: active.map(strip),
		runs: listRuns(db, { limit: 30 }).map(strip),
	};
}

/** Settings → Agents → Test the command: is the program there, which version, and does it know the flags given?
 * Runs only `<program> --version` and `--help`: nothing that starts an agent. */
export async function testCommand(command: string) {
	const words = command.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
	const bin = words.find((w) => !/^\w+=/.test(w))?.replace(/^["']|["']$/g, "") ?? "";
	if (!bin) return { ok: false, bin: "", path: "", version: "", unknown: [] as string[], problem: "The command is empty." };
	const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
	let path = "";
	try {
		path = (await runShell(`command -v ${q(bin)}`, { cwd: process.env.HOME || "/", timeout: 10e3 })).trim();
	} catch {
		return { ok: false, bin, path: "", version: "", unknown: [], problem: `${bin} isn't on your shell's PATH.` };
	}
	let version = "";
	try {
		version = (await runShell(`${q(bin)} --version`, { cwd: process.env.HOME || "/", timeout: 20e3 })).trim().split("\n")[0];
	} catch (e) {
		return { ok: false, bin, path, version: "", unknown: [], problem: `${bin} --version failed: ${(e as Error).message}` };
	}
	let help = "";
	try {
		help = await runShell(`${q(bin)} --help`, { cwd: process.env.HOME || "/", timeout: 20e3 });
	} catch {}
	const flags = [...new Set(words.filter((w) => /^--[a-zA-Z][\w-]*/.test(w)).map((w) => w.split("=")[0]))];
	const unknown = help ? flags.filter((f) => !new RegExp(`(^|[\\s,])${f.replace(/[-]/g, "\\-")}(?![\\w-])`).test(help)) : [];
	return {
		ok: !unknown.length,
		bin,
		path,
		version,
		unknown,
		problem: unknown.length ? `${bin} --help doesn't list ${unknown.join(", ")}.` : "",
	};
}
