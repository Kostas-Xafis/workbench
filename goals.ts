/**
 * Goals: what a project's work is for. A goal has a title, a short description (markdown), an optional target date
 * and a status (open, done, dropped); a project can have several open ones, in an order Kostas sets, and one of them
 * is the active goal (marked, else the first in order). Items point at a goal through `items.goal_id`; a goal's
 * progress, what waits on Kostas and what blocks it are worked out from its items, never stored.
 *
 * What blocks a goal is decided in one place, `blocksGoal`: an open item that waits on Kostas, or an agent's item in
 * `waiting`. (The board's page repeats the rule in ui/goals.js, from the items it already has.)
 */
import type { Db } from "./db";

export const GOAL_STATUSES = ["open", "done", "dropped"] as const;
export type GoalStatus = (typeof GOAL_STATUSES)[number];

export type Goal = {
	id: number;
	project: string;
	title: string;
	/** Short description, markdown. */
	body: string;
	/** Target date, YYYY-MM-DD; '' = none. */
	due: string;
	status: GoalStatus;
	/** Place among the project's goals. */
	sort: number;
	/** 1 = marked as the active goal. Use `activeGoal`: with none marked, the first open one is active. */
	active: number;
	created_at: string;
	updated_at: string;
	done_at: string | null;
};

export type Blocker = {
	ref: string;
	title: string;
	kind: string;
	owner: string;
	status: string;
	priority: number;
	/** kostas: it waits on him. waiting: an agent's item that is stuck. */
	why: "kostas" | "waiting";
};

export type GoalStats = {
	/** Items on the goal, not counting dropped ones. */
	total: number;
	done: number;
	/** todo, doing and waiting. */
	open: number;
	/** Open items that wait on Kostas. */
	mine: number;
	blockers: Blocker[];
};

export type GoalInfo = Goal & { is_active: boolean; stats: GoalStats };

const OPEN_STATUSES = ["todo", "doing", "waiting"];

/** Does an item hold its goal back? An open item that waits on Kostas, or an agent's item in `waiting`. */
export function blocksGoal(i: { owner: string; status: string }): "kostas" | "waiting" | null {
	if (!OPEN_STATUSES.includes(i.status)) return null;
	if (i.owner === "kostas") return "kostas";
	return i.status === "waiting" ? "waiting" : null;
}

export function createGoalTables(db: Db) {
	db.run(`CREATE TABLE IF NOT EXISTS goals (
		id INTEGER PRIMARY KEY,
		project TEXT NOT NULL,
		title TEXT NOT NULL,
		body TEXT NOT NULL DEFAULT '',
		due TEXT NOT NULL DEFAULT '',
		status TEXT NOT NULL DEFAULT 'open',
		sort INTEGER NOT NULL DEFAULT 0,
		active INTEGER NOT NULL DEFAULT 0,
		created_at TEXT NOT NULL DEFAULT (datetime('now')),
		updated_at TEXT NOT NULL DEFAULT (datetime('now')),
		done_at TEXT
	)`);
	db.run("CREATE INDEX IF NOT EXISTS goals_project ON goals(project, status, sort)");
	// Additive: old code ignores the column.
	const cols = (db.query("PRAGMA table_info(items)").all() as { name: string }[]).map((c) => c.name);
	if (!cols.includes("goal_id")) db.run("ALTER TABLE items ADD COLUMN goal_id INTEGER");
	db.run("CREATE INDEX IF NOT EXISTS items_goal ON items(goal_id)");
}

const ORDER = "ORDER BY project, sort, id";

export type GoalFilter = { project?: string; status?: GoalStatus[] };

export function listGoals(db: Db, f: GoalFilter = {}): Goal[] {
	const where: string[] = [];
	const args: Record<string, string> = {};
	if (f.project) {
		where.push("project = $project");
		args.project = f.project;
	}
	if (f.status?.length) {
		where.push(`status IN (${f.status.map((_, i) => `$s${i}`).join(", ")})`);
		f.status.forEach((s, i) => (args[`s${i}`] = s));
	}
	return db.query(`SELECT * FROM goals ${where.length ? "WHERE " + where.join(" AND ") : ""} ${ORDER}`).all(args) as Goal[];
}

export function getGoal(db: Db, id: number): Goal | undefined {
	return (db.query("SELECT * FROM goals WHERE id = ?").get(id) as Goal | null) ?? undefined;
}

export const goalTitle = (db: Db, id: number | null | undefined): string =>
	id == null ? "" : ((db.query("SELECT title FROM goals WHERE id = ?").get(id) as { title: string } | null)?.title ?? "");

/**
 * The goal a word names: its number (`3`, `#3`), or its exact title (any case) in `project`. A title that several
 * goals share, or none, is an error that says so; a number that isn't a goal is undefined.
 */
export function resolveGoal(db: Db, ref: string | number | undefined | null, project?: string): number | undefined {
	const t = String(ref ?? "").trim();
	if (!t) return undefined;
	const n = t.replace(/^#/, "");
	if (/^\d+$/.test(n)) return getGoal(db, Number(n))?.id;
	const hits = db
		.query(`SELECT id FROM goals WHERE lower(title) = lower($t) ${project ? "AND project = $project" : ""} ORDER BY status = 'open' DESC, id`)
		.all(project ? { t, project } : { t }) as { id: number }[];
	if (hits.length > 1) throw new Error(`more than one goal is called "${t}": use its number`);
	return hits[0]?.id;
}

/** Looks up what `resolveGoal` can't find as an error with the goals there are. */
export function needGoal(db: Db, ref: string | number, project?: string): number {
	const id = resolveGoal(db, ref, project);
	if (id !== undefined) return id;
	const known = listGoals(db, { project, status: ["open"] }).map((g) => `#${g.id} ${g.title}`);
	throw new Error(`no goal "${ref}"${known.length ? `; open goals: ${known.join(", ")}` : project ? ` in ${project}` : ""}`);
}

/** A target date as stored: YYYY-MM-DD that is a real day, or '' for none. */
export function cleanDue(due: unknown): string {
	const s = String(due ?? "").trim();
	if (!s) return "";
	const d = new Date(`${s}T00:00:00Z`);
	if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s)
		throw new Error(`the target date is YYYY-MM-DD, got "${s}"`);
	return s;
}

function checkTitle(title: unknown) {
	const t = String(title ?? "").trim();
	if (!t) throw new Error("a goal needs a title");
	if (t.length > 200) throw new Error("a goal's title is at most 200 characters");
	return t;
}

export function addGoal(db: Db, g: { project: string; title: string; body?: string; due?: string; active?: boolean }): Goal {
	if (!db.query("SELECT 1 FROM projects WHERE slug = ?").get(g.project)) throw new Error(`no project "${g.project}"`);
	const title = checkTitle(g.title);
	const due = cleanDue(g.due);
	const { id } = db
		.query(
			`INSERT INTO goals (project, title, body, due, sort) VALUES (?, ?, ?, ?, (SELECT COALESCE(MAX(sort), 0) + 1 FROM goals WHERE project = ?)) RETURNING id`,
		)
		.get(g.project, title, String(g.body ?? "").trim(), due, g.project) as { id: number };
	if (g.active) setActive(db, id);
	return getGoal(db, id)!;
}

export type GoalPatch = {
	title?: string;
	body?: string;
	due?: string;
	status?: GoalStatus;
	/** true: make it the project's active goal; false: unmark it. */
	active?: boolean;
	/** Its place among the project's open goals, 1 = first. */
	position?: number;
};

function setActive(db: Db, id: number) {
	const g = getGoal(db, id)!;
	if (g.status !== "open") throw new Error("only an open goal can be the active one");
	db.query("UPDATE goals SET active = 0 WHERE project = ?").run(g.project);
	db.query("UPDATE goals SET active = 1 WHERE id = ?").run(id);
}

/** Puts goal `id` at open-position `position` (1 = first) among its project's goals, and renumbers them. */
function place(db: Db, id: number, position: number) {
	const g = getGoal(db, id)!;
	const all = listGoals(db, { project: g.project }).filter((x) => x.id !== id);
	const opens = all.filter((x) => x.status === "open");
	const at = Math.max(1, Math.min(Math.round(position), opens.length + 1));
	const before = opens[at - 1];
	const ordered = [...all];
	ordered.splice(before ? ordered.indexOf(before) : ordered.length, 0, g);
	const set = db.query("UPDATE goals SET sort = ? WHERE id = ?");
	db.transaction(() => ordered.forEach((x, i) => set.run(i + 1, x.id)))();
}

export function updateGoal(db: Db, id: number, patch: GoalPatch): Goal {
	const before = getGoal(db, id);
	if (!before) throw new Error(`no goal #${id}`);
	if (patch.status !== undefined && !GOAL_STATUSES.includes(patch.status)) throw new Error(`status must be one of ${GOAL_STATUSES.join(", ")}`);
	const next = {
		title: patch.title === undefined ? before.title : checkTitle(patch.title),
		body: patch.body === undefined ? before.body : String(patch.body).trim(),
		due: patch.due === undefined ? before.due : cleanDue(patch.due),
		status: patch.status ?? before.status,
	};
	if (patch.active && next.status !== "open") throw new Error("only an open goal can be the active one");
	db.transaction(() => {
		const closing = next.status !== "open";
		db.query(
			`UPDATE goals SET title = $title, body = $body, due = $due, status = $status, updated_at = datetime('now'),
				done_at = CASE WHEN $status = 'open' THEN NULL WHEN $status != $before THEN datetime('now') ELSE done_at END
				${closing ? ", active = 0" : ""} WHERE id = $id`,
		).run({ ...next, before: before.status, id });
		if (patch.active === true) setActive(db, id);
		if (patch.active === false) db.query("UPDATE goals SET active = 0 WHERE id = ?").run(id);
		if (patch.position !== undefined) place(db, id, patch.position);
	})();
	return getGoal(db, id)!;
}

/** One place earlier (-1) or later (+1) among the project's open goals. */
export function moveGoal(db: Db, id: number, by: number) {
	const g = getGoal(db, id);
	if (!g) throw new Error(`no goal #${id}`);
	const opens = listGoals(db, { project: g.project, status: ["open"] });
	const at = opens.findIndex((x) => x.id === id);
	if (at < 0) throw new Error("only an open goal can be moved");
	place(db, id, at + 1 + (by < 0 ? -1 : 1));
	return getGoal(db, id)!;
}

/** The project's active goal: the open one marked active, else the first open one. */
export function activeGoal(db: Db, project: string): Goal | undefined {
	const open = listGoals(db, { project, status: ["open"] });
	return open.find((g) => g.active) ?? open[0];
}

/** A goal's items, counted: progress, what waits on Kostas, what blocks it. */
export function goalStats(db: Db, ids?: number[]): Map<number, GoalStats> {
	const rows = db
		.query(
			`SELECT ref, title, kind, owner, status, priority, goal_id FROM items WHERE goal_id IS NOT NULL
			ORDER BY priority, CASE status WHEN 'doing' THEN 0 WHEN 'todo' THEN 1 ELSE 2 END, id`,
		)
		.all() as (Blocker & { goal_id: number })[];
	const out = new Map<number, GoalStats>();
	for (const r of rows) {
		if (ids && !ids.includes(r.goal_id)) continue;
		const s = out.get(r.goal_id) ?? { total: 0, done: 0, open: 0, mine: 0, blockers: [] };
		out.set(r.goal_id, s);
		if (r.status === "dropped") continue;
		s.total++;
		if (r.status === "done") s.done++;
		if (OPEN_STATUSES.includes(r.status)) {
			s.open++;
			if (r.owner === "kostas") s.mine++;
		}
		const why = blocksGoal(r);
		if (why) s.blockers.push({ ref: r.ref, title: r.title, kind: r.kind, owner: r.owner, status: r.status, priority: r.priority, why });
	}
	return out;
}

const EMPTY: GoalStats = { total: 0, done: 0, open: 0, mine: 0, blockers: [] };

/** Goals with their numbers, in the board's order (by project, then their order). */
export function goalsWithStats(db: Db, f: GoalFilter = {}): GoalInfo[] {
	const goals = listGoals(db, f);
	const stats = goalStats(db);
	const active = new Map<string, number | undefined>();
	return goals.map((g) => {
		if (!active.has(g.project)) active.set(g.project, activeGoal(db, g.project)?.id);
		return { ...g, is_active: g.status === "open" && active.get(g.project) === g.id, stats: stats.get(g.id) ?? EMPTY };
	});
}

/**
 * For ordering work by goal (the queue of what waits on Kostas): every item on an open goal, with the goal and
 * where it stands among its project's open goals: `rank` 1 is the active goal, then the others in their order.
 * Items with no goal, or on a done or dropped one, aren't in it: they come after those that are.
 */
export type ItemGoal = { goal_id: number; goal: string; rank: number; active: boolean; due: string };
export function itemGoals(db: Db, project?: string): Map<string, ItemGoal> {
	const byProject = new Map<string, Map<number, ItemGoal>>();
	for (const g of goalsWithStats(db, { status: ["open"], ...(project ? { project } : {}) })) {
		const list = byProject.get(g.project) ?? new Map();
		byProject.set(g.project, list);
		list.set(g.id, { goal_id: g.id, goal: g.title, rank: 0, active: g.is_active, due: g.due });
	}
	for (const list of byProject.values()) {
		const ordered = [...list.values()].sort((a, b) => Number(b.active) - Number(a.active));
		ordered.forEach((x, i) => (x.rank = i + 1));
	}
	const out = new Map<string, ItemGoal>();
	const rows = db.query(`SELECT ref, goal_id FROM items WHERE goal_id IS NOT NULL ${project ? "AND project = $project" : ""}`).all(project ? { project } : {}) as {
		ref: string;
		goal_id: number;
	}[];
	for (const r of rows) {
		const g = [...byProject.values()].map((l) => l.get(r.goal_id)).find(Boolean);
		if (g) out.set(r.ref, g);
	}
	return out;
}

/** An item can only go on an open goal of its own project. */
export function checkItemGoal(db: Db, project: string, goalId: number) {
	const g = getGoal(db, goalId);
	if (!g) throw new Error(`no goal #${goalId}`);
	if (g.project !== project) throw new Error(`goal #${goalId} (${g.title}) belongs to ${g.project}, not ${project}`);
	if (g.status !== "open") throw new Error(`goal #${goalId} (${g.title}) is ${g.status}; reopen it first`);
}

export function searchGoals(db: Db, q: string, project?: string): Goal[] {
	return db
		.query(
			`SELECT * FROM goals WHERE ($project = '' OR project = $project) AND (title LIKE $q OR body LIKE $q)
			ORDER BY status = 'open' DESC, project, sort, id LIMIT 10`,
		)
		.all({ project: project ?? "", q: `%${q}%` }) as Goal[];
}

/* ---------- Words ---------- */

const today = () => {
	const d = new Date();
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/** "due 2026-12-01 (in 19 days)", "due 2026-11-01 (3 days overdue)"; '' with no date. */
export function dueText(due: string, now = today()): string {
	if (!due) return "";
	const days = Math.round((Date.parse(`${due}T00:00:00Z`) - Date.parse(`${now}T00:00:00Z`)) / 86400e3);
	const when = days === 0 ? "today" : days > 0 ? `in ${days} day${days === 1 ? "" : "s"}` : `${-days} day${days === -1 ? "" : "s"} overdue`;
	return `due ${due} (${when})`;
}

/** One goal as a line: "#3 Title (active) · due … · 4 of 9 done · 3 waiting on Kostas". */
export function goalLine(g: GoalInfo, name = "Kostas"): string {
	const s = g.stats;
	return [
		`#${g.id} ${g.title}${g.is_active ? " (active)" : ""}${g.status !== "open" ? ` [${g.status}]` : ""}`,
		dueText(g.due),
		s.total ? `${s.done} of ${s.total} done` : "no items yet",
		s.mine ? `${s.mine} waiting on ${name}` : "",
	]
		.filter(Boolean)
		.join(" · ");
}
