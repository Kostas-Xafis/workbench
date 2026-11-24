/**
 * Answer & send: the board starts a Claude Code agent on an item (docs/agents.md, "Agents the board starts").
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
import { createHash } from "node:crypto";
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, rmSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { addNote, getItem, getProject, updateItem, type Db, type Item } from "./db";
import { blockersOf } from "./links";
import { resolveAsk } from "./asks";
import { staleOf } from "./stale";
import { AGENT_COMMAND, dayStartHour, getSetting, yourName } from "./settings";
import { runShell, shellPath } from "./trackers";
import { sessionsCost } from "./usage";

export { AGENT_COMMAND };
export type RunStatus = "running" | "done" | "failed" | "stopped";
export type RunKind = "run" | "land";
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
	/** The folder it really ran in: the project's, or the git worktree Claude Code made for it (-w), from its first
	 * stream-json line. A continuation runs there. */
	cwd: string;
	/** The run whose session this one continues (POST /api/runs/:id/continue); null for a fresh session. */
	continues: number | null;
	/** "run": work on the item (Run, Answer & send, Continue). "land": merge a done item's branch (Merge it, startLand). */
	kind: RunKind;
	/** `claude://resume?session=…`, which opens the session in Claude Desktop on whatever computer the page is on
	 * (it imports it there); '' while it runs, or with no session. Not a column: getRun and listRuns add it. */
	desktop: string;
	/** $ as the agent reported it at the end; null until then (or never, for another command). */
	cost: number | null;
	/** The last lines of its output, made readable. */
	tail: string;
	/** What the agent said at the end. */
	result: string;
	/** The tool calls its permissions refused, "Edit ×4, Bash ×6"; '' when none were. */
	refused: string;
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
		tag TEXT NOT NULL DEFAULT '',
		refused TEXT NOT NULL DEFAULT '',
		cwd TEXT NOT NULL DEFAULT '',
		continues INTEGER,
		kind TEXT NOT NULL DEFAULT 'run'
	)`);
	const cols = (db.query("PRAGMA table_info(runs)").all() as { name: string }[]).map((c) => c.name);
	if (!cols.includes("refused")) db.run("ALTER TABLE runs ADD COLUMN refused TEXT NOT NULL DEFAULT ''");
	if (!cols.includes("cwd")) db.run("ALTER TABLE runs ADD COLUMN cwd TEXT NOT NULL DEFAULT ''");
	if (!cols.includes("continues")) db.run("ALTER TABLE runs ADD COLUMN continues INTEGER");
	if (!cols.includes("kind")) db.run("ALTER TABLE runs ADD COLUMN kind TEXT NOT NULL DEFAULT 'run'");
	db.run("CREATE INDEX IF NOT EXISTS runs_item ON runs(item_id, id)");
	db.run("CREATE INDEX IF NOT EXISTS runs_started ON runs(started_at)");
	db.run("CREATE INDEX IF NOT EXISTS runs_session ON runs(session)");
	// What the agent said and did, parsed from its stream-json (readLine): the last EVENTS_KEPT of each run, numbered
	// from 1 in the order they came (0 is the message a continuation was sent with). GET /api/runs/:id/events.
	db.run(`CREATE TABLE IF NOT EXISTS run_events (
		run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
		n INTEGER NOT NULL,
		at TEXT NOT NULL,
		kind TEXT NOT NULL,
		tool TEXT NOT NULL DEFAULT '',
		text TEXT NOT NULL DEFAULT '',
		data TEXT NOT NULL DEFAULT '',
		PRIMARY KEY (run_id, n)
	)`);
}

/* ---------- Reading runs ---------- */

const COLS = "r.*, i.ref, i.title";
const FROM = "runs r JOIN items i ON i.id = r.item_id";
/** A row as the API gives it: with its Claude Desktop link once it has ended. */
const withLink = (r: Run): Run => ({ ...r, desktop: r.ended_at ? desktopLink(r.session) : "" });
export const getRun = (db: Db, id: number) => {
	const r = db.query(`SELECT ${COLS} FROM ${FROM} WHERE r.id = ?`).get(id) as Run | null;
	return r ? withLink(r) : undefined;
};
/** The newest first; `item` for one item's. */
export function listRuns(db: Db, { item, limit = 20 }: { item?: number; limit?: number } = {}): Run[] {
	return (
		db.query(`SELECT ${COLS} FROM ${FROM} ${item ? "WHERE r.item_id = $item" : ""} ORDER BY r.id DESC LIMIT $limit`).all({ limit, ...(item ? { item } : {}) }) as Run[]
	).map(withLink);
}
export const latestRun = (db: Db, item: number) => listRuns(db, { item, limit: 1 })[0];
export const liveRuns = (db: Db) => running(db);
const running = (db: Db) => (db.query(`SELECT ${COLS} FROM ${FROM} WHERE r.ended_at IS NULL ORDER BY r.id`).all() as Run[]).map(withLink);

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

export type Limits = {
	on: boolean;
	phone: boolean;
	atOnce: number;
	perDay: number;
	cap: number;
	unblocked: "tell" | "send";
	command: string;
	/** The command that continues a session: Settings' own, or the one made from `command` (resumeCommand). */
	continueCommand: string;
};
export const limits = (db: Db): Limits => {
	const command = getSetting<string>(db, "agents.command");
	return {
		on: getSetting<boolean>(db, "agents.on"),
		phone: getSetting<boolean>(db, "agents.phone"),
		atOnce: getSetting<number>(db, "agents.at-once"),
		perDay: getSetting<number>(db, "agents.per-day"),
		cap: getSetting<number>(db, "agents.day-dollars"),
		unblocked: getSetting<"tell" | "send">(db, "agents.unblocked"),
		command,
		continueCommand: getSetting<string>(db, "agents.continue-command") || resumeCommand(command),
	};
};

/**
 * The command that continues a run's session, made from the one that starts runs, so a command you changed (and one
 * saved before continuing existed) works without a second setting: Settings → Agents' "continue" command, when set,
 * is used instead. The session comes in as $WB_RESUME (and the message as $WB_PROMPT, as always):
 * - `--session-id …` goes (the session exists already) and `--resume "$WB_RESUME"` comes in, before `-p`;
 * - `-w` / `--worktree` (and `--tmux`, which needs it) go: the session has its worktree, and it runs in it again.
 * Everything else stays: the permissions, the output format, the name, a budget. Deterministic, so the computer
 * helper can tell a continue command made from a start command it allowed (worker/src/helper.ts, `base`).
 * It works on whole shell words and never inside quotes: `-w` / `--worktree` take an optional name (the next word,
 * when it doesn't start with "-"; Claude Code's `-w, --worktree [name]`), `--session-id` its value. '' when the
 * command can't be split safely (a pipe, `;`, `&&`, a redirection, a subshell, an open quote): then
 * agents.continue-command has to be set.
 */
export function resumeCommand(command: string): string {
	const words = shellWords(command);
	if (!words?.length) return "";
	const out: Word[] = [];
	for (let n = 0; n < words.length; n++) {
		const w = words[n];
		const next = words[n + 1];
		const valueNext = !!next && !next.text.startsWith("-");
		if (w.plain && (w.text === "-w" || w.text === "--worktree")) {
			if (valueNext) n++;
			continue;
		}
		// --worktree=NAME: the flag itself as written, unquoted (its value may be quoted).
		if (/^(-w|--worktree|--tmux|--session-id)=/.test(w.raw)) continue;
		if (w.plain && w.text === "--tmux") continue;
		if (w.plain && w.text === "--session-id") {
			if (next) n++;
			continue;
		}
		out.push(w);
	}
	if (!out.some((w) => w.plain && /^(-r|--resume)(=|$)/.test(w.text))) {
		const resume: Word[] = [{ raw: "--resume", text: "--resume", plain: true }, { raw: '"$WB_RESUME"', text: "$WB_RESUME", plain: false }];
		const print = out.findIndex((w) => w.plain && (w.text === "-p" || w.text === "--print"));
		// Before -p, else after the program (and any VAR=value before it).
		const at = print >= 0 ? print : out.findIndex((w) => !(w.plain && /^\w+=/.test(w.raw))) + 1;
		if (at <= 0) return "";
		out.splice(at, 0, ...resume);
	}
	return out.map((w) => w.raw).join(" ");
}
/** A shell word: as written (`raw`, quotes and all), what it stands for without its quotes (`text`, variables left as
 * they are), and whether it had no quotes or escapes (`plain`: only such a word can be a flag we drop). */
type Word = { raw: string; text: string; plain: boolean };
/** A command split into words as bash would, for commands made of one simple command: undefined when it has
 * anything else (operators, redirections, subshells, backquotes, $(…), a newline, an open quote). */
export function shellWords(command: string): Word[] | undefined {
	const out: Word[] = [];
	let n = 0;
	const s = command;
	while (n < s.length) {
		while (n < s.length && (s[n] === " " || s[n] === "\t")) n++;
		if (n >= s.length) break;
		let raw = "", text = "", plain = true;
		while (n < s.length && s[n] !== " " && s[n] !== "\t") {
			const c = s[n];
			if (c === "'") {
				const end = s.indexOf("'", n + 1);
				if (end < 0) return undefined;
				raw += s.slice(n, end + 1);
				text += s.slice(n + 1, end);
				plain = false;
				n = end + 1;
			} else if (c === '"') {
				let m = n + 1, inner = "";
				while (m < s.length && s[m] !== '"') {
					if (s[m] === "\\" && m + 1 < s.length) { inner += s[m + 1]; m += 2; continue; }
					if (s[m] === "`" || (s[m] === "$" && s[m + 1] === "(")) return undefined;
					inner += s[m++];
				}
				if (m >= s.length) return undefined;
				raw += s.slice(n, m + 1);
				text += inner;
				plain = false;
				n = m + 1;
			} else if (c === "\\") {
				if (n + 1 >= s.length) return undefined;
				raw += s.slice(n, n + 2);
				text += s[n + 1];
				plain = false;
				n += 2;
			} else if (/[;&|<>()`\n\r]/.test(c) || (c === "$" && s[n + 1] === "(") || (c === "#" && !raw)) return undefined;
			else {
				raw += c;
				text += c;
				n++;
			}
		}
		out.push({ raw, text, plain });
	}
	return out;
}
/** The command a continuation runs with (limits().continueCommand): Settings' own, or one made from the start
 * command; '' when none can be made (resumeCommand). */
export const continueCommand = (db: Db) => getSetting<string>(db, "agents.continue-command") || resumeCommand(getSetting<string>(db, "agents.command"));

/** "#12 done · started 2026-11-12 09:14 UTC from this computer · 14 min · $0.42 · claude --resume <id>", for agents and wb. */
export function runLine(r: Run): string {
	const end = r.ended_at ? fromSql(r.ended_at).getTime() : Date.now();
	return [
		`#${r.id} ${r.status}`,
		r.continues && `continues #${r.continues}`,
		r.kind === "land" && "merging the branch",
		`started ${r.started_at.slice(0, 16)} UTC from ${r.started_from}`,
		`${r.ended_at ? "" : "for "}${minutes(end - fromSql(r.started_at).getTime())}`,
		r.cost != null && apiValue(r.cost),
		r.error,
		r.refused && `refused ${r.refused}`,
		r.session && `claude --resume ${r.session}${r.cwd ? ` in ${r.cwd}` : ""}`,
	]
		.filter(Boolean)
		.join(" · ");
}

/** "$0.42 at API prices": what a run's tokens come to at Claude API list prices, as Claude Code reports it and the
 * Usage page counts. On a subscription (Pro, Max) nobody pays that: the run uses the plan's limits instead. */
export const apiValue = (dollars: number) => `$${dollars.toFixed(2)} at API prices`;

/** `wb runs`: each run's item and line, and for one that ended with a session, how to carry on and its Desktop link. */
export function runsText(list: Pick<Run, keyof Run>[]): string {
	if (!list.length) return "no agent runs yet (wb run <ref>, or Run on the board)";
	return list
		.map((r) => {
			const more = r.ended_at && UUID.test(r.session) ? `\n  carry on: wb continue ${r.id} "…"${r.desktop ? ` · open in Claude Desktop: ${r.desktop}` : ""}` : "";
			return `wb-${r.ref}  ${r.title}\n  ${runLine(r)}${more}`;
		})
		.join("\n");
}

/* ---------- Whether a run may start ---------- */

const ASK_KINDS = ["decision", "review", "notice"];
/** Whether a project's folder is there to run an agent in. The cloud board asks its computers instead (worker/src/helper.ts). */
export const places = {
	has: (path: string) => existsSync(path),
	/** Why the computer that would run a continuation of `session` (in `folder`) can't, or ''. On this computer it's
	 * this code, so ''; the cloud board asks which helper would run it, and refuses one too old (worker/src/helper.ts). */
	continueWhy: (_session: string, _folder: string): string => "",
};
const folderOf = (db: Db, slug: string) => {
	const p = getProject(db, slug);
	return p?.path && places.has(p.path) ? p.path : "";
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
		// Restart: an item whose last run failed or was stopped, or that sat "doing" for days, can get a fresh agent
		// (the live-run check below still holds). Else it's work in progress, or it waits on something.
		if ((i.status === "doing" || i.status === "waiting") && !restartable(db, i))
			return i.status === "doing" ? `wb-${i.ref} is being worked on already (doing)` : `wb-${i.ref} waits on something (waiting)`;
	}
	if (!folderOf(db, i.project)) return `the project ${i.project} has no folder on this computer (Settings → Projects)`;
	const busy = db.query("SELECT id FROM runs WHERE item_id = ? AND ended_at IS NULL").get(i.id) as { id: number } | null;
	if (busy) return `an agent is on wb-${i.ref} already (run #${busy.id})`;
}

/** Whether a doing or waiting item may get a fresh agent anyway: its last run ended failed or stopped (a waiting one
 * only when it waits on no item), or it's doing and stalled (stale.ts). Never while a run is on it: itemRefusal. */
export function restartable(db: Db, i: Item): boolean {
	const last = latestRun(db, i.id);
	const broke = !!last?.ended_at && (last.status === "failed" || last.status === "stopped");
	if (i.status === "doing") return broke || (i.stale === undefined ? staleOf(i) : i.stale)?.why === "stalled";
	if (i.status === "waiting") return broke && !blockersOf(db, i.id).length;
	return true;
}

export type Refusal = { why: string; limit?: boolean };
/** Why `from` may not start agents now at all (off, a phone, a limit), or undefined. */
export async function startRefusal(db: Db, from: From, now = new Date()): Promise<Refusal | undefined> {
	const no = countRefusal(db, from, now);
	if (no) return no;
	const l = limits(db);
	if (l.cap) {
		const spent = await spentToday(db, now);
		if (spent >= l.cap) return { why: `Today's agents used ${apiValue(spent)}, the cap is $${l.cap} (Settings → Agents).`, limit: true };
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
export function runPrompt(db: Db, i: Pick<Item, "ref" | "title">, command = limits(db).command): string {
	const name = yourName(db);
	const own = inWorktree(command)
		? `\nYou work in a git worktree of your own, on a new branch: commit your work there, and name the branch in finish_item. Merge it only if this project's rules say you do.`
		: "";
	return `Work on wb-${i.ref} (${i.title}) from the workbench. ${name} sent it to you from the board; nobody watches this session, so don't ask questions here.
1. Read it with the wb MCP server's get_item: its body, answer and notes are the brief. Then start_item it.
2. Do it, by this project's own rules (its CLAUDE.md or AGENTS.md).
3. Done: finish_item with a note on what changed and where (commit, branch). Need ${name} for anything (a decision, a check on a device, a review, a setup step, a permission you don't have): file it as its own item and wait on it (add_item with blocks: wb-${i.ref}), so the board brings this item back when it's dealt with. Don't leave it waiting on nothing: nobody would bring it back.${own}
Without the MCP server, the wb command does the same: wb show, wb start, wb done, wb wait.`;
}
/** Whether a run's command gives the agent a git worktree of its own (Claude Code's -w / --worktree). */
export const inWorktree = (command: string) => /(^|\s)(-w|--worktree)(?=\s|=|$)/.test(command);

const WINDOWS = process.platform === "win32";
// Runtime files (gone at reboot, like the runs themselves), named by the run's tag: its database and number. Read
// when used: db.ts imports this file while it loads.
const runDir = () =>
	process.env.WB_RUNS_DIR ??
	join(process.env.XDG_RUNTIME_DIR || join(tmpdir(), `workbench-${WINDOWS ? userInfo().username : userInfo().uid}`), "workbench-runs");
// node:crypto rather than Bun.hash: the cloud board (a Worker, no Bun) tags the runs its computer helper starts.
const tagOf = (db: Db, id: number) => `wb-run-${createHash("sha1").update(db.filename).digest("hex").slice(0, 10)}-${id}`;
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
/** The variables a run's command gets from its Launch spec; any other name in it is dropped (launchRun). */
export const RUN_VARS = ["WB_PROMPT", "WB_ITEM", "WB_TITLE", "WB_PROJECT", "WB_SESSION", "WB_RESUME", "WB_RUN"];

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
	const folder = folderOf(db, i.project);
	const command = limits(db).command;
	const session = crypto.randomUUID();
	// A restart: the last run on it broke (itemRefusal let it through for that), and this one starts a fresh session.
	const last = latestRun(db, i.id);
	const again = last?.ended_at && (last.status === "failed" || last.status === "stopped") ? last : undefined;
	const id = await launchNew(db, i, from, {
		// The session is known now only when the command passes it on; else it comes from the output, if at all.
		session: command.includes("WB_SESSION") ? session : "",
		command,
		cwd: folder,
		vars: { WB_PROMPT: runPrompt(db, i, command), WB_SESSION: session },
	});
	addNote(db, i.id, again ? `Agent restarted (run #${id}, from ${from.label}): run #${again.id} had ${again.status === "failed" ? "failed" : "been stopped"}` : `Agent started (run #${id}, from ${from.label})`, "workbench");
	return getRun(db, id)!;
}

/** Inserts a run and starts its process (launcher), or marks it failed and throws. Returns its id. Nothing awaited
 * before the insert, so the checks the caller just made still hold. */
async function launchNew(
	db: Db,
	i: Item,
	from: From,
	o: { session: string; command: string; cwd: string; vars: Record<string, string>; continues?: number; folder?: string; base?: string; resume?: string; kind?: RunKind },
): Promise<number> {
	const { id } = db
		.query("INSERT INTO runs (item_id, project, session, started_by, started_from, command, cwd, continues, kind) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id")
		.get(i.id, i.project, o.session, from.by ?? (from.where === "auto" ? "board" : "kostas"), from.label, o.command, o.cwd, o.continues ?? null, o.kind ?? "run") as { id: number };
	const tag = tagOf(db, id);
	db.query("UPDATE runs SET tag = ? WHERE id = ?").run(tag, id);
	const spec: Launch = {
		id,
		tag,
		command: o.command,
		cwd: o.cwd,
		vars: { WB_ITEM: `wb-${i.ref}`, WB_TITLE: i.title, WB_PROJECT: i.project, WB_RUN: String(id), ...o.vars },
		...(o.folder ? { folder: o.folder } : {}),
		...(o.base ? { base: o.base } : {}),
		...(o.resume ? { resume: o.resume } : {}),
	};
	try {
		const { pid, unit, cwd } = await launcher.launch(spec, (e) => {
			db.query("UPDATE runs SET error = ? WHERE id = ?").run(`couldn't start: ${e}`, id);
		});
		db.query("UPDATE runs SET pid = ?, unit = ?, cwd = CASE WHEN ? != '' THEN ? ELSE cwd END WHERE id = ?").run(pid, unit, cwd ?? "", cwd ?? "", id);
	} catch (e) {
		db.query("UPDATE runs SET status = 'failed', ended_at = datetime('now'), error = ? WHERE id = ?").run(`couldn't start: ${(e as Error).message}`, id);
		throw new Error(`the agent couldn't start: ${(e as Error).message}`);
	}
	return id;
}

/* ---------- Merge it: a run that lands a done item's branch ---------- */

/** Why this item's branch can't get a merge run now (its state, its folder, a run on it), or undefined. Whether the
 * branch is merged yet is for the caller to say (agents.ts knows the git state, here or from a computer). */
export function landRefusal(db: Db, i: Item): string | undefined {
	if (i.status !== "done") return `wb-${i.ref} isn't done (${i.status}): Merge it is for finished work`;
	if (i.owner === "kostas") return `wb-${i.ref} is ${yourName(db)}'s, not an agent's`;
	if (!i.branch.trim()) return `wb-${i.ref} names no branch to merge`;
	if (!folderOf(db, i.project)) return `the project ${i.project} has no folder on this computer (Settings → Projects)`;
	const busy = db.query("SELECT id FROM runs WHERE item_id = ? AND ended_at IS NULL").get(i.id) as { id: number } | null;
	if (busy) return `an agent is on wb-${i.ref} already (run #${busy.id})`;
}

/** What a merge run is told: land the branch by the project's own rules, check it, say where it went. */
export function landPrompt(db: Db, i: Pick<Item, "ref" | "title" | "branch" | "project">, base = "", command = limits(db).command): string {
	const name = yourName(db);
	const main = base || "the project's main branch";
	const folder = getProject(db, i.project)?.path ?? "";
	const own = inWorktree(command)
		? `\nYou start in a git worktree of your own: merge where this project's rules say (a local merge goes into the project's own checkout${folder ? `, ${folder}` : ""}, and only when that checkout has no uncommitted changes).`
		: "";
	return `Land wb-${i.ref} (${i.title}) from the workbench: its work is done on the branch ${i.branch}, which isn't merged into ${main} yet. ${name} sent this from the board; nobody watches this session, so don't ask questions here.
1. Read it with the wb MCP server's get_item: what was done, where, and its notes.
2. Merge ${i.branch} into ${main} the way this project's own rules say (its CLAUDE.md or AGENTS.md): some projects merge locally, some open a pull request. Bring the branch up to date first if it needs it, and settle conflicts with care.
3. Run the project's checks (its tests, typecheck, build: what its rules name) on the merged result, and fix what the merge broke.
4. Never force-push, and never rewrite ${main}'s history.
5. Landed: add_note to wb-${i.ref} saying what landed where (the merge commit or the pull request, and the branch). Leave its status as it is: it's done.
6. Can't land it (conflicts you can't settle, checks that fail, a permission you don't have): file what you need from ${name} as its own item (add_item), add_note to wb-${i.ref} saying why and naming that item, and stop there.${own}
Without the MCP server, the wb command does the same: wb show, wb note, wb add.`;
}

/**
 * Merge it: a run of kind "land" on a done agent item, whose job is to merge its branch (landPrompt). The same limits,
 * command and launcher as Run (so the cloud board's computer helper starts it). `branch` says whether the branch is
 * still unmerged, and into what: `why` refuses it. Returns the run.
 */
export async function startLand(db: Db, itemId: number, from: From, branch: (i: Item) => Promise<{ why?: string; base?: string }>): Promise<Run> {
	const first = getItem(db, itemId);
	if (!first) throw new Error(`no item #${itemId}`);
	const early = landRefusal(db, first);
	if (early) throw new Error(early);
	const no = await startRefusal(db, from);
	if (no) throw new Error(no.why);
	const git = await branch(first);
	if (git.why) throw new Error(git.why);
	// Checked again with nothing awaited from here to the insert, as in startRun.
	const i = getItem(db, itemId)!;
	const now = countRefusal(db, from)?.why ?? landRefusal(db, i);
	if (now) throw new Error(now);
	const command = limits(db).command;
	const session = crypto.randomUUID();
	const id = await launchNew(db, i, from, {
		session: command.includes("WB_SESSION") ? session : "",
		command,
		cwd: folderOf(db, i.project),
		kind: "land",
		vars: { WB_PROMPT: landPrompt(db, i, git.base, command), WB_SESSION: session },
	});
	addNote(db, i.id, `Agent merging ${i.branch}${git.base ? ` into ${git.base}` : ""} (run #${id}, from ${from.label})`, "workbench");
	return getRun(db, id)!;
}

/** What a continuation is told: the message, and that nobody watches (as runPrompt says for a fresh one). */
export function continuePrompt(db: Db, i: Pick<Item, "ref">, message: string): string {
	const name = yourName(db);
	return `${message}

(${name} sent this from the workbench board, on wb-${i.ref}. Nobody watches this session: put any question on the board, and finish_item or wait on what you need as before.)`;
}

/**
 * Continue: a new run that resumes run `runId`'s Claude Code session with `message` as the prompt, in the folder that
 * session ran in (its worktree), with the continue command (limits().continueCommand). Any item status will do (a
 * follow-up on a done one too); the limits apply as for Run. Refused while that session, or any run on the item, is
 * still going. The item's history gets the message (as `from.by`, Kostas by default) and "Agent continued (run #n)".
 */
export async function continueRun(db: Db, runId: number, message: string, from: From): Promise<Run> {
	const text = String(message ?? "").trim();
	if (!text) throw new Error("write the message to send the agent");
	if (text.length > 20000) throw new Error("the message is too long (20,000 characters at most)");
	const r = getRun(db, runId);
	if (!r) throw new Error(`no run #${runId}`);
	const no = await startRefusal(db, from);
	if (no) throw new Error(no.why);
	// Checked again with nothing awaited from here to the insert, as in startRun.
	const why = countRefusal(db, from)?.why ?? continueRefusal(db, getRun(db, runId)!);
	if (why) throw new Error(why);
	const i = getItem(db, r.item_id)!;
	const folder = folderOf(db, i.project);
	const l = limits(db);
	const command = l.continueCommand;
	if (!command) throw new Error("set the continue command in Settings → Agents");
	const derived = !getSetting<string>(db, "agents.continue-command");
	const id = await launchNew(db, i, from, {
		session: r.session,
		command,
		cwd: r.cwd || folder,
		folder,
		resume: r.session,
		continues: r.id,
		// A continue command made from the start command: the computer helper allows it as that one (helper.ts).
		...(derived ? { base: l.command } : {}),
		vars: { WB_PROMPT: continuePrompt(db, i, text), WB_RESUME: r.session, WB_SESSION: r.session },
	});
	db.query("INSERT OR REPLACE INTO run_events (run_id, n, at, kind, text, data) VALUES (?, 0, datetime('now'), 'message', ?, ?)").run(
		id,
		text.slice(0, EVENT_TEXT),
		JSON.stringify({ by: from.by ?? "kostas" }),
	);
	addNote(db, i.id, text, from.by ?? "kostas");
	addNote(db, i.id, `Agent continued (run #${id}, from ${from.label}): the session of run #${r.id}, with the message above`, "workbench");
	return getRun(db, id)!;
}

/** Why run `r`'s session can't be continued now, or undefined. */
export function continueRefusal(db: Db, r: Run): string | undefined {
	if (!UUID.test(r.session)) return `run #${r.id} has no Claude Code session to continue`;
	const same = db.query("SELECT id FROM runs WHERE session = ? AND ended_at IS NULL ORDER BY id LIMIT 1").get(r.session) as { id: number } | null;
	if (same) return `that session is still running (run #${same.id}): send the message once it ends, or stop it`;
	const i = getItem(db, r.item_id);
	if (!i) return `run #${r.id}'s item is gone`;
	if (!folderOf(db, i.project)) return `the project ${i.project} has no folder on this computer (Settings → Projects)`;
	const busy = db.query("SELECT id FROM runs WHERE item_id = ? AND ended_at IS NULL").get(i.id) as { id: number } | null;
	if (busy) return `an agent is on wb-${i.ref} already (run #${busy.id})`;
	if (!continueCommand(db))
		return "The board can't make a continue command from the command in Settings → Agents (it has more than one plain command in it): set the continue command there (agents.continue-command).";
	return places.continueWhy(r.session, folderOf(db, i.project)) || undefined;
}

/** The first version of the app whose computer helper can continue a session (resume, folder, base, the run's cwd). */
export const CONTINUE_VERSION = "0.5.0";
/** Whether a computer helper that says it's `version` (and has `caps`) can continue a session: one that says it can
 * ("continue" in caps, sent from 0.5.0 on, nightlies too), or a version of 0.5.0 or later. */
export function helperContinues(version: string, caps: string[] = []): boolean {
	if (caps.includes("continue")) return true;
	const v = (s: string) => (s.match(/^(\d+)\.(\d+)\.(\d+)/)?.slice(1).map(Number) ?? null);
	const have = v(version), need = v(CONTINUE_VERSION)!;
	if (!have) return false;
	for (let n = 0; n < 3; n++) if (have[n] !== need[n]) return have[n] > need[n];
	return !/-/.test(version.replace(/\+.*$/, "")); // 0.5.0-rc.1 is before 0.5.0
}

/** What starting a run's process takes: everything but the database, so a computer helper can do it for the cloud board.
 * A continuation also has `resume` (the session), `folder` (the project's, for when the session's folder is gone) and,
 * when its command was made from the start command, `base` (that command). */
export type Launch = { id: number; tag: string; command: string; cwd: string; vars: Record<string, string>; folder?: string; base?: string; resume?: string };
/** `cwd`: the folder it started in (a continuation's may differ from the spec's: launchCwd). */
export type Launched = { pid: number; unit: string; cwd?: string };

/**
 * Where a run's process starts. A fresh run: its folder. A continuation: where Claude Code keeps that session, which is
 * the folder it ran in (it finds a session by its folder): from the session's transcript when it's on this computer,
 * else the folder the run recorded, else the project's (its worktree was removed; Claude Code may not find it there,
 * and then the run fails saying so). '' when none is here.
 */
export function launchCwd(l: Pick<Launch, "cwd" | "folder" | "resume">): string {
	if (l.resume) {
		const there = sessionCwd(l.resume);
		if (there && existsSync(there)) return there;
	}
	if (l.cwd && existsSync(l.cwd)) return l.cwd;
	if (l.folder && existsSync(l.folder)) return l.folder;
	return "";
}

/** The folder a Claude Code session ran in, from its transcript (~/.claude/projects/<folder>/<session>.jsonl), or ''. */
export function sessionCwd(session: string): string {
	if (!UUID.test(session)) return "";
	const root = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "projects");
	let dirs: string[];
	try {
		dirs = readdirSync(root);
	} catch {
		return "";
	}
	for (const d of dirs) {
		const file = join(root, d, `${session}.jsonl`);
		if (!existsSync(file)) continue;
		let fd: number | undefined;
		try {
			fd = openSync(file, "r");
			const buf = Buffer.alloc(256 * 1024);
			const n = readSync(fd, buf, 0, buf.length, 0);
			for (const line of buf.subarray(0, n).toString("utf8").split("\n")) {
				if (!line.includes('"cwd"')) continue;
				try {
					const cwd = JSON.parse(line).cwd;
					if (typeof cwd === "string" && cwd) return cwd;
				} catch {}
			}
		} catch {
		} finally {
			if (fd !== undefined) closeSync(fd);
		}
	}
	return "";
}

/** Starts a run's process on this computer, in its own session (and systemd scope), its output to its log file. */
export async function launchRun(l: Launch, onError: (message: string) => void = () => {}): Promise<Launched> {
	const run = { id: l.id, tag: l.tag };
	const cwd = launchCwd(l);
	if (!cwd) throw new Error(`there's no folder ${l.cwd || l.folder} here`);
	mkdirSync(runDir(), { recursive: true, mode: 0o700 });
	rmSync(exitPath(run), { force: true });
	const fd = openSync(logPath(run), "w", 0o600);
	// The exit code goes to a file, so whoever looks later knows how it ended. $0 is the tag, so the process can be
	// told from another one that got the same pid.
	const argv = ["bash", "-c", `${l.command}\nprintf '%s' "$?" > "$WB_RUN_EXIT"`, l.tag];
	const scoped = await canScope();
	const full = scoped ? ["systemd-run", "--user", "--scope", "--quiet", `--unit=${l.tag}`, ...argv] : argv;
	const env: Record<string, string> = {};
	for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !NESTED.includes(k)) env[k] = v;
	Object.assign(env, { PATH: await shellPath(), NO_COLOR: "1" });
	// The run's own variables, set last so nothing inherited shadows them, and only those: a spec comes from the cloud
	// board too, and PATH, BASH_ENV or LD_PRELOAD from it would change what the command the helper allowed runs.
	for (const [k, v] of Object.entries(l.vars)) if (RUN_VARS.includes(k) && typeof v === "string") env[k] = v;
	env.WB_RUN_EXIT = exitPath(run);
	const child = spawn(full[0], full.slice(1), { cwd, env, detached: true, windowsHide: true, stdio: ["ignore", fd, fd] });
	closeSync(fd);
	child.on("error", (e) => onError(e.message));
	child.unref();
	return { pid: child.pid ?? 0, unit: scoped ? l.tag : "", cwd };
}

/** Who starts a run's process: this computer, or (on the cloud board) a computer helper that syncs with it. */
export const launcher = { launch: launchRun };

/* ---------- Following them ---------- */

/** What this process has read of a run's log so far. */
export type Live = {
	offset: number;
	partial: string;
	lines: string[];
	session: string;
	cost: number | null;
	result: string;
	isError: boolean;
	/** The tool calls its permissions refused, by tool: { Edit: 4, Bash: 6 }. */
	refused: Record<string, number>;
	/** The folder it runs in, from its first stream-json line (`system`/`init`); '' until then. */
	cwd: string;
	/** What it said and did (RunEvent), the last EVENTS_KEPT; `seq` is how many there were in all (the last one's n). */
	events: RunEvent[];
	seq: number;
};

/**
 * One thing the agent said or did, as the board shows it (GET /api/runs/:id/events):
 * - `message`: what a continuation was sent with (n 0, `by` who sent it);
 * - `start`: it started (`text` says with which model, in which folder);
 * - `text`: what it said;
 * - `tool`: a tool call, in one line ("Edit src/app.ts", "Bash: bun test", "mcp__wb__finish_item wb-k3f9"), `tool` its name;
 * - `error`: a tool call that failed, `refused` when its permissions refused it;
 * - `result`: the end, with what it said last, `cost`, `duration_ms`, `turns` and `is_error`;
 * - `output`: a line that isn't stream-json (Claude Code's own errors, a command of your own).
 */
export type RunEvent = {
	n: number;
	/** When it was read, UTC "YYYY-MM-DD HH:MM:SS". */
	at: string;
	kind: "message" | "start" | "text" | "tool" | "error" | "result" | "output";
	text: string;
	tool?: string;
	refused?: boolean;
	cost?: number;
	duration_ms?: number;
	turns?: number;
	is_error?: boolean;
	by?: string;
};
/** How many of a run's events are kept (in the table, and in what a helper holds), and how long each one's text is at most. */
export const EVENTS_KEPT = 500;
const EVENT_TEXT = 4000;
const EVENT_KINDS = ["message", "start", "text", "tool", "error", "result", "output"];
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
	if (!d || typeof d !== "object") {
		event(l, { kind: "output", text: oneLine(t, 500) });
		return push(l, t);
	}
	if (typeof d.session_id === "string" && d.session_id) l.session = d.session_id;
	if (d.type === "system" && d.subtype === "init") {
		if (typeof d.cwd === "string" && d.cwd) l.cwd = d.cwd;
		const text = `Started${d.model ? ` with ${d.model}` : ""}${d.cwd ? ` in ${d.cwd}` : ""}`;
		event(l, { kind: "start", text });
		push(l, text);
	} else if (d.type === "assistant")
		for (const c of d.message?.content ?? []) {
			if (c?.type === "text" && typeof c.text === "string") {
				if (c.text.trim()) event(l, { kind: "text", text: c.text.trim().slice(0, EVENT_TEXT) });
				push(l, c.text);
			} else if (c?.type === "tool_use") {
				push(l, `→ ${c.name}${toolWhat(c.input)}`);
				event(l, { kind: "tool", tool: String(c.name), text: toolLine(String(c.name), c.input, l.cwd) });
				if (typeof c.id === "string") toolsOf(l).set(c.id, String(c.name));
			}
		}
	else if (d.type === "user")
		for (const c of d.message?.content ?? []) {
			if (c?.type !== "tool_result" || !c.is_error) continue;
			const text = typeof c.content === "string" ? c.content : Array.isArray(c.content) ? c.content.map((x: any) => x?.text ?? "").join(" ") : "";
			push(l, `  ✗ ${oneLine(text) || "refused"}`);
			const called = toolsOf(l).get(c.tool_use_id);
			const tool = refusedTool(text, called);
			if (tool) l.refused[tool] = (l.refused[tool] ?? 0) + 1;
			event(l, { kind: "error", text: oneLine(text, 500) || "refused", ...(called || tool ? { tool: called || tool } : {}), ...(tool ? { refused: true } : {}) });
		}
	else if (d.type === "result") {
		if (typeof d.total_cost_usd === "number") l.cost = d.total_cost_usd;
		if (typeof d.result === "string") l.result = d.result;
		l.isError = !!d.is_error || (typeof d.subtype === "string" && d.subtype !== "success");
		event(l, {
			kind: "result",
			text: (typeof d.result === "string" ? d.result : "").slice(0, EVENT_TEXT),
			is_error: l.isError,
			...(typeof d.total_cost_usd === "number" ? { cost: d.total_cost_usd } : {}),
			...(typeof d.duration_ms === "number" ? { duration_ms: d.duration_ms } : {}),
			...(typeof d.num_turns === "number" ? { turns: d.num_turns } : {}),
		});
		const facts = [
			typeof d.num_turns === "number" && `${d.num_turns} turn${d.num_turns === 1 ? "" : "s"}`,
			typeof d.duration_ms === "number" && minutes(d.duration_ms),
			typeof d.total_cost_usd === "number" && apiValue(d.total_cost_usd),
		].filter(Boolean);
		push(l, `— ${l.isError ? `ended with an error${d.subtype && d.subtype !== "success" ? ` (${d.subtype})` : ""}` : "finished"}${facts.length ? `: ${facts.join(", ")}` : ""}`);
	}
	// Other stream events (partial messages, hooks, …) aren't worth a line.
}
export const newLive = (): Live => ({ offset: 0, partial: "", lines: [], session: "", cost: null, result: "", isError: false, refused: {}, cwd: "", events: [], seq: 0 });

function event(l: Live, e: Omit<RunEvent, "n" | "at">) {
	l.events.push({ n: ++l.seq, at: sqlTime(new Date()), ...e });
	if (l.events.length > EVENTS_KEPT) l.events.splice(0, l.events.length - EVENTS_KEPT);
}

/** A tool call in one line: "Edit src/app.ts" (a path inside the run's folder as relative), "Bash: bun test",
 * "mcp__wb__finish_item wb-k3f9", "Grep TODO in src", "Agent: look for the bug". */
export function toolLine(name: string, input: unknown, cwd = ""): string {
	const o = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
	const s = (k: string) => (typeof o[k] === "string" ? (o[k] as string) : "");
	const rel = (p: string) => (cwd && p.startsWith(`${cwd}/`) ? p.slice(cwd.length + 1) : p);
	const cut = (t: string, n = 200) => oneLine(t, n);
	switch (name) {
		case "Bash":
		case "PowerShell":
			return `${name}: ${cut(s("command"))}`;
		case "Read":
		case "Edit":
		case "Write":
		case "MultiEdit":
		case "NotebookEdit":
			return `${name} ${cut(rel(s("file_path") || s("notebook_path") || s("path")))}`.trim();
		case "Grep":
			return `Grep ${cut(s("pattern"), 120)}${s("path") ? ` in ${cut(rel(s("path")), 120)}` : ""}`;
		case "Glob":
			return `Glob ${cut(s("pattern"), 120)}${s("path") ? ` in ${cut(rel(s("path")), 120)}` : ""}`;
		case "WebFetch":
			return `WebFetch ${cut(s("url"))}`;
		case "WebSearch":
			return `WebSearch ${cut(s("query"))}`;
		case "Task":
		case "Agent":
			return `${name}: ${cut(s("description") || s("prompt"))}`;
		case "TodoWrite":
			return Array.isArray(o.todos) ? `TodoWrite (${o.todos.length} to-do${o.todos.length === 1 ? "" : "s"})` : "TodoWrite";
	}
	if (name.startsWith("mcp__wb__")) {
		const ref = s("ref") || s("item") || s("on");
		const extra = s("title") || s("q") || s("name");
		return [name, ref && (/^wb-/i.test(ref) ? ref : `wb-${ref}`), extra && `"${cut(extra, 100)}"`].filter(Boolean).join(" ");
	}
	const what = toolWhat(input);
	return `${name}${what ? ` ${what.slice(2)}` : ""}`.slice(0, 300);
}

/** Events as they came from somewhere else (a computer helper): checked, bounded, each text capped. */
export function cleanEvents(list: unknown): RunEvent[] {
	if (!Array.isArray(list)) return [];
	const out: RunEvent[] = [];
	for (const x of list.slice(-EVENTS_KEPT)) {
		if (!x || typeof x !== "object") continue;
		const e = x as Record<string, unknown>;
		const n = Number(e.n);
		if (!Number.isInteger(n) || n < 1 || !EVENT_KINDS.includes(String(e.kind))) continue;
		const num = (k: string) => (typeof e[k] === "number" && Number.isFinite(e[k]) ? { [k]: e[k] as number } : {});
		out.push({
			n,
			at: /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(String(e.at)) ? String(e.at) : sqlTime(new Date()),
			kind: String(e.kind) as RunEvent["kind"],
			text: String(e.text ?? "").slice(0, EVENT_TEXT),
			...(typeof e.tool === "string" && e.tool ? { tool: e.tool.slice(0, 200) } : {}),
			...(e.refused === true ? { refused: true } : {}),
			...(typeof e.is_error === "boolean" ? { is_error: e.is_error } : {}),
			...num("cost"),
			...num("duration_ms"),
			...num("turns"),
		});
	}
	return out;
}

/** Writes a run's new events (those after the last one stored; `fill`: every one given, for gaps) and keeps the last EVENTS_KEPT. */
function saveEvents(db: Db, id: number, events: RunEvent[] | undefined, fill = false) {
	if (!events?.length) return;
	const max = (db.query("SELECT MAX(n) AS n FROM run_events WHERE run_id = ?").get(id) as { n: number | null } | null)?.n ?? 0;
	const fresh = fill ? events : events.filter((e) => e.n > max);
	if (!fresh.length) return;
	const ins = db.query("INSERT OR IGNORE INTO run_events (run_id, n, at, kind, tool, text, data) VALUES (?, ?, ?, ?, ?, ?, ?)");
	db.transaction(() => {
		for (const { n, at, kind, tool, text, ...data } of fresh) ins.run(id, n, at, kind, tool ?? "", text, Object.keys(data).length ? JSON.stringify(data) : "");
	})();
	const top = Math.max(max, fresh.at(-1)!.n);
	if (top > EVENTS_KEPT) db.query("DELETE FROM run_events WHERE run_id = ? AND n > 0 AND n <= ?").run(id, top - EVENTS_KEPT);
}

/** A run's events after number `after` (0: from the start; a continuation's message is 0, so -1 gets it too), in order. */
export function runEvents(db: Db, id: number, after = -1, limit = EVENTS_KEPT): RunEvent[] {
	type Row = { n: number; at: string; kind: RunEvent["kind"]; tool: string; text: string; data: string };
	const cap = Math.max(1, Math.min(EVENTS_KEPT, limit));
	const COLS = "SELECT n, at, kind, tool, text, data FROM run_events WHERE run_id = ?";
	// From the start: the newest `cap` (what it's doing now), with a continuation's message (n 0) before them.
	const rows: Row[] =
		after < 0
			? [
					...(db.query(`${COLS} AND n = 0`).all(id) as Row[]),
					...(db.query(`${COLS} AND n > 0 ORDER BY n DESC LIMIT ?`).all(id, cap) as Row[]).reverse(),
				]
			: (db.query(`${COLS} AND n > ? ORDER BY n LIMIT ?`).all(id, after, cap) as Row[]);
	return rows.map(({ tool, data, ...e }) => {
		let more: Record<string, unknown> = {};
		try {
			more = data ? JSON.parse(data) : {};
		} catch {}
		return { ...e, ...(tool ? { tool } : {}), ...more } as RunEvent;
	});
}

// Which tool each call was, to name the one a refusal answers. Not part of Live: it doesn't go to the cloud board.
const callTools = new WeakMap<Live, Map<string, string>>();
function toolsOf(l: Live) {
	let m = callTools.get(l);
	if (!m) callTools.set(l, (m = new Map()));
	return m;
}
/** The tool a failed call's result says its permissions refused ("Permission to use Edit has been denied…", or Claude
 * Code's auto mode blocking it), or undefined when it failed for another reason. */
export function refusedTool(text: string, called?: string): string | undefined {
	const named = /Permission to use (\S+?)(?: with .*?)? (?:has been|was) denied/.exec(text)?.[1];
	if (named) return named;
	if (/\bauto mode\b/i.test(text) && /\b(denied|blocked|refused|not allowed)\b/i.test(text)) return called || "a tool";
}
/** "Edit ×4, Bash ×6": the most refused first. */
export const refusedText = (refused: Record<string, number> = {}) =>
	Object.entries(refused)
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.map(([tool, n]) => (n > 1 ? `${tool} ×${n}` : tool))
		.join(", ");

/** Reads what the log got since the last look. */
export function readLog(r: Pick<Run, "id" | "tag">): Live {
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
export function alive(r: Pick<Run, "pid" | "tag">) {
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
export const exitCode = (r: Pick<Run, "tag">): number | null => {
	try {
		const s = readFileSync(exitPath(r), "utf8").trim();
		return /^\d+$/.test(s) ? Number(s) : null;
	} catch {
		return null;
	}
};

/** Writes what was read to the run. Nothing when this process read nothing (the log may be gone: another one
 * finished the run meanwhile, and its tail stays). */
export function save(
	db: Db,
	r: Pick<Run, "id">,
	l: Pick<Live, "offset" | "lines" | "session" | "cost"> & Partial<Pick<Live, "refused" | "cwd" | "events">>,
	fill = false,
) {
	if (!l.offset) return;
	const refused = refusedText(l.refused);
	const cwd = l.cwd ?? "";
	db.query(
		"UPDATE runs SET tail = ?, session = CASE WHEN ? != '' THEN ? ELSE session END, cost = COALESCE(?, cost), refused = CASE WHEN ? != '' THEN ? ELSE refused END, cwd = CASE WHEN ? != '' THEN ? ELSE cwd END WHERE id = ?",
	).run(l.lines.join("\n"), l.session, l.session, l.cost, refused, refused, cwd, cwd, r.id);
	saveEvents(db, r.id, l.events, fill);
}
/** What was read of a run's whole log, as endRun takes it (a helper that's older sends no cwd or events). */
export type ReadLog = Omit<Live, "partial" | "cwd" | "events" | "seq"> & Partial<Pick<Live, "cwd" | "events" | "seq">>;

/** Ends a run whose process is gone: its status from how it ended, a line in the item's history, its files away. */
function finish(db: Db, r: Run, code: number | null) {
	if (getRun(db, r.id)?.ended_at) return;
	const l = readLog(r);
	flushLog(l);
	endRun(db, r, code, l);
	forgetLog(r);
}

/** Reads the log's last line, which has no newline yet, as a line: the process is gone. */
export function flushLog(l: Live) {
	if (l.partial) {
		readLine(l, l.partial);
		l.partial = "";
	}
}
/** Lets go of a finished run's files, and of what was read of them. */
export function forgetLog(r: Pick<Run, "id" | "tag">) {
	live.delete(r.id);
	rmSync(logPath(r), { force: true });
	rmSync(exitPath(r), { force: true });
}

/** Writes how a run ended (`l`: its whole log as read) and the line in its item's history. The cloud board calls
 * this with what its computer helper read. */
export function endRun(db: Db, r: Pick<Run, "id" | "item_id" | "status" | "error">, code: number | null, l: ReadLog) {
	if (getRun(db, r.id)?.ended_at) return;
	const status: RunStatus = r.status === "stopped" ? "stopped" : code === 0 && !l.isError ? "done" : "failed";
	const error =
		status === "stopped" ? "" : code === null
			? r.error || "It ended without an exit code: the computer restarted, or it was killed."
			: code !== 0 ? `exit ${code}${l.lines.length ? `: ${oneLine(l.lines.at(-1)!, 200)}` : ""}` : l.isError ? "The agent ended with an error." : "";
	save(db, r, l, true);
	const changed = db
		.query("UPDATE runs SET status = ?, exit_code = ?, ended_at = datetime('now'), result = ?, error = ? WHERE id = ? AND ended_at IS NULL")
		.run(status, code, l.result.slice(0, 4000), error, r.id).changes;
	if (!changed) return;
	const done = getRun(db, r.id)!;
	const took = minutes(fromSql(done.ended_at!).getTime() - fromSql(done.started_at).getTime());
	const word = { done: "finished", failed: "failed", stopped: "was stopped", running: "" }[status];
	addNote(
		db,
		r.item_id,
		`Agent run #${r.id} ${word} after ${took}${done.cost != null ? ` · ${apiValue(done.cost)}` : ""}${error ? ` · ${error}` : ""}${
			done.refused ? ` · Its permissions refused ${done.refused} (Settings → Agents → The command)` : ""
		}`,
		"workbench",
	);
	unpark(db, r.item_id, r.id);
}

/** After a run: an item it left doing, or waiting on nothing, would sit there with nobody to bring it back (nobody
 * watched the run). It goes back to to-do, where Run is, with why in its history. */
function unpark(db: Db, itemId: number, runId: number) {
	const i = getItem(db, itemId);
	if (!i) return;
	const how = i.status === "doing" ? "doing" : i.status === "waiting" && !blockersOf(db, i.id).length ? "waiting on nothing" : "";
	if (!how) return;
	updateItem(db, i.id, { status: "todo" }, "workbench", `Run #${runId} left it ${how}, and nothing would bring it back: it's in to-do again.`);
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
	await terminate(r);
	finish(db, { ...r, status: "stopped" }, exitCode(r));
	if (by !== "kostas") addNote(db, r.item_id, `Stopped by ${by}`, "workbench");
	return getRun(db, id)!;
}

/** Ends a run's process: its whole process group (and scope), politely, then for sure after 3 s. */
export async function terminate(r: Pick<Run, "pid" | "tag" | "unit">) {
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
}

/* ---------- In Claude Desktop ---------- */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DESKTOP_SESSION = /^local_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The link that opens a session in Claude Desktop, for the page to open on whatever computer it's on: a Claude Code
 * session (a run's, a UUID) is brought into Desktop's sidebar (it imports it) by `claude://resume?session=<id>`; a
 * Desktop session of its own (`local_<uuid>`, what start_item records from the desktop app) by its app link. '' for
 * anything else. Runs get it as `desktop` once they've ended, items whose `session` is one of these as `desktop`. */
export const desktopLink = (session: string) =>
	UUID.test(session) ? `claude://resume?session=${session}` : DESKTOP_SESSION.test(session) ? `claude://claude.ai/epitaxy/${session}` : "";
/** Opening a link with the desktop's handler for it. Here: the board runs on the computer the runs run on. The
 * cloud board has no desktop of its own (worker/src/helper.ts turns it off); tests put their own `open` here. */
export const desktop = {
	here: true,
	open(url: string) {
		const argv = process.platform === "darwin" ? ["open", url] : WINDOWS ? ["cmd", "/c", "start", "", url] : ["xdg-open", url];
		const child = spawn(argv[0], argv.slice(1), { detached: true, stdio: "ignore", windowsHide: true });
		child.on("error", () => {});
		child.unref();
	},
};
/** Opens a run's session in Claude Desktop, once the run has ended (a session that's still going is the run's). */
export function openInDesktop(db: Db, id: number): Run {
	const r = getRun(db, id);
	if (!r) throw new Error(`no run #${id}`);
	if (!desktop.here) throw new Error("the cloud board can't open Claude Desktop: use claude --resume on the computer it ran on");
	if (!r.ended_at) throw new Error(`run #${id} is still going: open it in Claude Desktop once it ends`);
	const link = desktopLink(r.session);
	if (!link) throw new Error(`run #${id} has no Claude Code session to open`);
	desktop.open(link);
	return r;
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
		.filter((p) => p.path && places.has(p.path))
		.map((p) => p.slug);
	const strip = ({ tail: _, command: __, ...r }: Run) => r;
	return {
		...l,
		// Whether this client may start one at all (on, and this computer or an allowed phone), and why not.
		allowed: !!l.on && !(from?.where === "phone" && !l.phone) && !!from,
		why: no?.why ?? "",
		limited: !!no?.limit,
		// Whether this client can have a run opened in Claude Desktop: the board's own page, on this computer.
		desktop: desktop.here && from?.where === "local",
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
