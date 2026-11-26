/**
 * A run while it goes (docs/agents.md, "While it runs"): what the board does with an agent it started before the run
 * ends, beyond showing what it does.
 *
 * - **Permission prompts on the board.** A run's command gets `--permission-prompt-tool mcp__wb__permission`
 *   (dispatch.ts withLive), so a tool call that would need a person's yes goes to the board's MCP server instead of
 *   being refused. The `permission` tool (mcp.ts, listed only to a run the board started) files it here as a
 *   permission waiting on the run, which shows in the run box, at the top of the Inbox and in a notification; the
 *   call waits for Allow, Allow for this run (the same tool, for the rest of the run) or Deny. Nobody answering within
 *   PERMISSION_WAIT is a no, as it would have been without it, and the run's later asks are a no at once, so a run
 *   nobody watches waits once at most. Nothing new is filed as an item.
 * - **Messages to a running agent.** A run whose command reads stream-json on stdin (dispatch.ts, `tell`) gets what
 *   you write at once: it's in the run's events (echoed back by Claude Code) and the item's history. A run that has
 *   ended is continued instead (dispatch.ts continueRun), so the reply box needn't know which.
 *
 * Approving a tool call from a paired phone is the point of it; it never allows a new command on a computer (the
 * computer helper's own list of allowed commands is untouched).
 */
import { addNote, getItem, type Db, type Item } from "./db";
import { continueRun, getRun, places, toolLine, type From, type Run } from "./dispatch";
import { yourName } from "./settings";

/** How long a permission waits for an answer before it's a no. Tests shorten it. */
export const PERMISSION_WAIT = { ms: 600e3 };
const DETAIL_MAX = 4000;

export type PermissionAnswer = "" | "allow" | "deny" | "timeout";
export type Permission = {
	id: number;
	run_id: number;
	/** The tool Claude Code asks about ("Bash", "mcp__x__y"). */
	tool: string;
	/** The call in one line, as the run's events show it ("Bash: npm publish"). */
	what: string;
	/** The call in full, for a look before saying yes: a command as it is, else its input as JSON (capped). */
	detail: string;
	tool_use_id: string;
	asked_at: string;
	/** '' while it waits; allow, deny, or timeout (nobody answered). */
	answer: PermissionAnswer;
	/** "run": allowed for the rest of the run (this tool). */
	scope: string;
	answered_at: string | null;
	/** kostas; "board" when a rule answered it (allowed for this run, or the run's last ask timed out). */
	answered_by: string;
	/** What a no tells the agent. */
	message: string;
	/** Joined from the run and its item. */
	item_id: number;
	ref: string;
	title: string;
	project: string;
};

export function createLiveTables(db: Db) {
	db.run(`CREATE TABLE IF NOT EXISTS run_permissions (
		id INTEGER PRIMARY KEY,
		run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
		tool TEXT NOT NULL,
		what TEXT NOT NULL DEFAULT '',
		detail TEXT NOT NULL DEFAULT '',
		tool_use_id TEXT NOT NULL DEFAULT '',
		asked_at TEXT NOT NULL DEFAULT (datetime('now')),
		answer TEXT NOT NULL DEFAULT '',
		scope TEXT NOT NULL DEFAULT '',
		answered_at TEXT,
		answered_by TEXT NOT NULL DEFAULT '',
		message TEXT NOT NULL DEFAULT ''
	)`);
	db.run("CREATE INDEX IF NOT EXISTS run_permissions_run ON run_permissions(run_id, id)");
	db.run("CREATE INDEX IF NOT EXISTS run_permissions_open ON run_permissions(answer)");
	// Messages that wait for a run to end (tellRun): JSON, '' for none.
	if (!(db.query("PRAGMA table_info(runs)").all() as { name: string }[]).some((c) => c.name === "queued")) db.run("ALTER TABLE runs ADD COLUMN queued TEXT NOT NULL DEFAULT ''");
}

const COLS = "p.*, r.item_id, i.ref, i.title, i.project";
const FROM = "run_permissions p JOIN runs r ON r.id = p.run_id JOIN items i ON i.id = r.item_id";
export const getPermission = (db: Db, id: number) => (db.query(`SELECT ${COLS} FROM ${FROM} WHERE p.id = ?`).get(id) as Permission | null) ?? undefined;

const minutes = (ms: number) => Math.max(1, Math.round(ms / 60e3));
const timedOutText = (db: Db) =>
	`Nobody answered on the board within ${minutes(PERMISSION_WAIT.ms)} min, so it isn't allowed. Go on without it, or file what you need from ${yourName(db)} as its own item (add_item with blocks: your item) and wait on it.`;

/** Waiting ones that can't be answered any more get their no: past PERMISSION_WAIT, or their run has ended. */
function expire(db: Db) {
	const cutoff = new Date(Date.now() - PERMISSION_WAIT.ms).toISOString().slice(0, 19).replace("T", " ");
	db.query("UPDATE run_permissions SET answer = 'timeout', answered_at = datetime('now'), answered_by = 'board', message = ? WHERE answer = '' AND asked_at <= ?").run(
		timedOutText(db),
		cutoff,
	);
	db.query(
		"UPDATE run_permissions SET answer = 'deny', answered_at = datetime('now'), answered_by = 'board', message = 'The run has ended.' WHERE answer = '' AND run_id IN (SELECT id FROM runs WHERE ended_at IS NOT NULL)",
	).run();
}

/** What a tool call needs a yes for, in full: a command as it is, a file's path, else its input as JSON. */
function detailOf(tool: string, input: unknown): string {
	const o = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
	if ((tool === "Bash" || tool === "PowerShell") && typeof o.command === "string") return o.command.slice(0, DETAIL_MAX);
	let s = "";
	try {
		s = JSON.stringify(input ?? {}, null, 1);
	} catch {}
	return s.length > DETAIL_MAX ? `${s.slice(0, DETAIL_MAX - 1)}…` : s;
}

/**
 * Claude Code asks for a permission for run `runId` (the permission tool's arguments): filed as waiting, or answered
 * at once when a rule says (allowed for this run; the run's last ask timed out; the run has ended). Returns it.
 */
export function askPermission(db: Db, runId: number, a: { tool_name?: unknown; input?: unknown; tool_use_id?: unknown }): Permission {
	const r = getRun(db, runId);
	if (!r) throw new Error(`no run #${runId}`);
	const tool = String(a.tool_name ?? "").trim().slice(0, 200);
	if (!tool) throw new Error("tool_name is required");
	expire(db);
	const insert = (answer: PermissionAnswer, by = "", message = "") =>
		(
			db
				.query(
					`INSERT INTO run_permissions (run_id, tool, what, detail, tool_use_id, answer, answered_at, answered_by, message) VALUES (?, ?, ?, ?, ?, ?, ${answer ? "datetime('now')" : "NULL"}, ?, ?) RETURNING id`,
				)
				.get(r.id, tool, toolLine(tool, a.input, r.cwd), detailOf(tool, a.input), String(a.tool_use_id ?? "").slice(0, 200), answer, by, message) as { id: number }
		).id;
	const rule = (answer: string, scope = "") =>
		!!db.query(`SELECT 1 FROM run_permissions WHERE run_id = ? AND answer = ? ${scope ? "AND scope = ? AND tool = ?" : ""} LIMIT 1`).get(...(scope ? [r.id, answer, scope, tool] : [r.id, answer]));
	let id: number;
	if (r.ended_at) id = insert("deny", "board", "The run has ended.");
	else if (rule("allow", "run")) id = insert("allow", "board", "allowed for this run");
	else if (rule("timeout"))
		id = insert(
			"deny",
			"board",
			`Nobody answered the last permission this run asked for on the board, so this one isn't allowed either. Go on without it, or file what you need from ${yourName(db)} as its own item and wait on it.`,
		);
	else id = insert("");
	return getPermission(db, id)!;
}

/** Kostas answers a waiting permission: allow, allow for the rest of the run (this tool), or deny. Returns it. */
export function answerPermission(db: Db, id: number, answer: unknown, by = "kostas"): Permission {
	expire(db);
	const p = getPermission(db, id);
	if (!p) throw new Error(`no permission #${id}`);
	if (!["allow", "run", "deny"].includes(String(answer))) throw new Error("answer is allow, run (allow for the rest of the run) or deny");
	if (p.answer) throw new Error(p.answer === "timeout" ? "Too late: nobody answered in time, so it wasn't allowed." : p.answer === "deny" && p.message === "The run has ended." ? "The run has ended." : "It's answered already.");
	const yes = answer !== "deny";
	const changed = db
		.query("UPDATE run_permissions SET answer = ?, scope = ?, answered_at = datetime('now'), answered_by = ?, message = ? WHERE id = ? AND answer = ''")
		.run(yes ? "allow" : "deny", answer === "run" ? "run" : "", by, yes ? "" : `${yourName(db)} said no on the board.`, id).changes;
	if (!changed) throw new Error("It's answered already.");
	const how = answer === "run" ? `Allowed ${p.tool} for the rest of run #${p.run_id} (first: ${p.what})` : `${yes ? "Allowed" : "Said no to"} ${p.what} (run #${p.run_id})`;
	addNote(db, p.item_id, how, by);
	return getPermission(db, id)!;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Waits up to `ms` for permission `id` to be answered (or to time out). Returns it, answered or not yet. */
export async function waitPermission(db: Db, id: number, ms = PERMISSION_WAIT.ms + 1000): Promise<Permission> {
	const until = Date.now() + ms;
	for (;;) {
		expire(db);
		const p = getPermission(db, id);
		if (!p) throw new Error(`no permission #${id}`);
		if (p.answer || Date.now() >= until) return p;
		await sleep(Math.min(400, Math.max(10, until - Date.now())));
	}
}

/** What the permission tool answers Claude Code (its --permission-prompt-tool contract): allow with the call's input
 * as it was, or deny with what the agent is told. Undefined while it waits. */
export function permissionResult(p: Pick<Permission, "answer" | "message">, input: unknown): { behavior: "allow"; updatedInput: Record<string, unknown> } | { behavior: "deny"; message: string } | undefined {
	if (p.answer === "allow") return { behavior: "allow", updatedInput: input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {} };
	if (p.answer === "deny" || p.answer === "timeout") return { behavior: "deny", message: p.message || "It isn't allowed." };
}

/** The permissions waiting for an answer, oldest first: the Inbox and the run box show them. */
export function pendingPermissions(db: Db): Permission[] {
	expire(db);
	return db.query(`SELECT ${COLS} FROM ${FROM} WHERE p.answer = '' ORDER BY p.id`).all() as Permission[];
}
/** One run's permissions, the newest last (the last 20). */
export function runPermissions(db: Db, runId: number): Permission[] {
	expire(db);
	return (db.query(`SELECT ${COLS} FROM ${FROM} WHERE p.run_id = ? ORDER BY p.id DESC LIMIT 20`).all(runId) as Permission[]).reverse();
}

/* ---------- Messages to a running agent ---------- */

/** A message that waits for its run to end (tellRun): `runs.queued` holds them as JSON. */
type Queued = { text: string; by: string; where: From["where"]; label: string; at: string };
export const queuedOf = (r: Pick<Run, "queued">): Queued[] => {
	try {
		const q = JSON.parse(r.queued || "[]");
		return Array.isArray(q) ? q : [];
	} catch {
		return [];
	}
};
const newestRun = (db: Db, itemId: number) => getRun(db, (db.query("SELECT MAX(id) AS id FROM runs WHERE item_id = ?").get(itemId) as { id: number }).id)!;

/**
 * "Tell the agent…": `message` goes to run `runId` while it runs (its stdin). When it can't take it now (its stdin
 * closed after its turn's result while a background task keeps it going; it never read stdin; its computer can't be
 * reached), the message waits on the run (`queued`) and goes when it ends (deliverQueued): never refused while the
 * run is alive. A run that had ended is continued at once (continueRun). The history gets the message as `from.by`'s.
 */
export async function tellRun(db: Db, runId: number, message: string, from: From): Promise<{ run: Run; item: Item; continued: boolean; queued?: boolean }> {
	const text = String(message ?? "").trim();
	if (!text) throw new Error("write the message to send the agent");
	if (text.length > 20000) throw new Error("the message is too long (20,000 characters at most)");
	const r = getRun(db, runId);
	if (!r) throw new Error(`no run #${runId}`);
	if (r.ended_at) {
		const run = await continueRun(db, r.id, text, from);
		return { run, item: getItem(db, run.item_id)!, continued: true };
	}
	const by = from.by ?? "kostas";
	// Messages already waiting go first: this one waits behind them.
	const live = r.live.split(",").includes("tell") && !queuedOf(r).length;
	const sent = live ? await places.tell(r, text).catch(() => "gone" as const) : "gone";
	if (sent === "sent") {
		addNote(db, r.item_id, text, by);
		addNote(db, r.item_id, `Sent to the agent while it runs (run #${r.id}, from ${from.label}): the message above`, "workbench");
		return { run: getRun(db, r.id)!, item: getItem(db, r.item_id)!, continued: false };
	}
	const now = getRun(db, r.id)!;
	const q = [...queuedOf(now), { text, by, where: from.where, label: from.label, at: new Date().toISOString().slice(0, 19).replace("T", " ") }];
	db.query("UPDATE runs SET queued = ? WHERE id = ?").run(JSON.stringify(q), r.id);
	addNote(db, r.item_id, text, by);
	addNote(db, r.item_id, `Queued for the agent (run #${r.id}, from ${from.label}): the message above goes to it when this run ends`, "workbench");
	// It may have ended just now, after its end looked for messages: they go now.
	places.settle(db);
	if (getRun(db, r.id)!.ended_at) await deliverQueued(db, r.id);
	const next = newestRun(db, r.item_id);
	return { run: next, item: getItem(db, r.item_id)!, continued: next.id !== r.id, queued: next.id === r.id };
}

/**
 * Run `runId` has ended with messages waiting for it (dispatch.ts endRun, wherever a run is finished): a run that
 * finished is continued with them, joined, as from whoever sent the first, once. One that failed, was stopped or
 * moved to Claude Desktop isn't: the history keeps them, saying they didn't reach the agent. So does a continuation
 * the board can't start (agents off, a limit).
 */
export async function deliverQueued(db: Db, runId: number): Promise<void> {
	const r = getRun(db, runId);
	if (!r?.ended_at || !r.queued) return;
	// Taken once: whoever clears it delivers it.
	if (!db.query("UPDATE runs SET queued = '' WHERE id = ? AND queued = ?").run(r.id, r.queued).changes) return;
	const q = queuedOf(r);
	if (!q.length) return;
	const text = q.map((m) => m.text).join("\n\n");
	const lost = (why: string) =>
		addNote(
			db,
			r.item_id,
			`${q.length === 1 ? "The message" : `${q.length} messages`} queued for run #${r.id} didn't reach the agent: ${why}. Send ${q.length === 1 ? "it" : "them"} again with Tell the agent…\n\n${text}`,
			"workbench",
		);
	if (r.moved) return lost("the run moved to Claude Desktop, so carry on there");
	if (r.status !== "done") return lost(`the run ${r.status === "stopped" ? "was stopped" : "failed"}`);
	try {
		await continueRun(db, r.id, text, { where: q[0].where, label: q[0].label, by: q[0].by }, { noted: true });
	} catch (e) {
		lost(`the board couldn't continue its session (${(e as Error).message})`);
	}
}
