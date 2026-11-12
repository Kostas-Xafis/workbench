/**
 * The Today brief: what a person needs when they sit down, in one short read. The board's Today view (ui/today.js)
 * gets what the board can't see by itself from here: what agents finished since a time, with the finishing note, and
 * the reports updated since (day pages left out, they're the full log). What waits on the person comes from the
 * items the page already has. `briefText` is the same brief as plain text, for the MCP prompt `today`.
 */
import { type Db, type Item, listItems } from "./db";

const OPEN = ["todo", "doing", "waiting"] as const;
const DAY = 86400e3;

const sqlTime = (d: Date) => d.toISOString().slice(0, 19).replace("T", " ");
const parse = (s: string) => new Date(/^\d{4}-\d\d-\d\d \d/.test(s) ? `${s.replace(" ", "T")}Z` : s);

/** `since` as the database writes times (UTC, "YYYY-MM-DD HH:MM:SS"): any ISO time or SQL time; a day ago when missing or unreadable. */
export function sinceTime(since?: string | null, now = new Date()) {
	const d = since ? parse(since.trim()) : undefined;
	return sqlTime(d && !Number.isNaN(d.getTime()) ? d : new Date(now.getTime() - DAY));
}

// What `updateItem` writes as a note when fields change ("status: doing → done"); not a finishing note.
const AUTO_NOTE = /^[a-z_]+: .+ → .+$/;

/** The first line of a finishing note: the newest note that a person or agent wrote (not "created", not a field change). */
export function firstLine(notes: string[]) {
	for (const text of notes) {
		const line = text.split("\n").map((l) => l.trim()).find(Boolean);
		if (!line || line === "created" || (AUTO_NOTE.test(line) && !text.includes("\n"))) continue;
		return line.length > 200 ? `${line.slice(0, 199)}…` : line;
	}
	return "";
}

export type TodayDone = { ref: string; project: string; title: string; kind: string; done_at: string; note: string };
export type TodayReport = { id: number; project: string; title: string; grp: string; updated_at: string; version: number };
export type Today = { since: string; project: string; done: TodayDone[]; reports: TodayReport[] };

/** What agents finished and which reports changed since `since`, for one project or (empty) all active ones. */
export function todayData(db: Db, project = "", since?: string | null): Today {
	const from = sinceTime(since);
	const live = (col: string) => `${col} IN (SELECT slug FROM projects WHERE archived_at IS NULL)`;
	const args: Record<string, string> = { $since: from };
	if (project) args.$project = project;
	const scope = (col: string) => (project ? `AND ${col} = $project` : `AND ${live(col)}`);
	const rows = db
		.query(
			`SELECT id, ref, project, title, kind, done_at FROM items
			 WHERE status = 'done' AND owner != 'kostas' AND done_at >= $since ${scope("project")} ORDER BY done_at DESC, id DESC`,
		)
		.all(args) as { id: number; ref: string; project: string; title: string; kind: string; done_at: string }[];
	const notes = db.query("SELECT text FROM notes WHERE item_id = ? ORDER BY id DESC");
	const done = rows.map(({ id, ...r }) => ({ ...r, note: firstLine((notes.all(id) as { text: string }[]).map((n) => n.text)) }));
	const reports = db
		.query(
			`SELECT r.id, r.project, r.title, r.grp, r.updated_at, (SELECT MAX(n) FROM report_versions v WHERE v.report_id = r.id) AS version
			 FROM reports r WHERE r.updated_at >= $since AND r.name NOT LIKE 'day-%' ${scope("r.project")}
			 ORDER BY r.updated_at DESC`,
		)
		.all(args) as TodayReport[];
	return { since: from, project, done, reports };
}

type Loose = Item & { unblocks?: number; stale?: unknown; decide_by?: string };
const days = (from: string, to = new Date()) => Math.max(0, Math.floor((to.getTime() - parse(from).getTime()) / DAY));
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The brief as text: what waits on the person (new, oldest, unblocking), what agents finished, stuck work, deadlines, reports. */
export function briefText(db: Db, project = "", since?: string | null, now = new Date()) {
	const t = todayData(db, project, since);
	const live = new Set((db.query("SELECT slug FROM projects WHERE archived_at IS NULL").all() as { slug: string }[]).map((p) => p.slug));
	const items = (listItems(db, project ? { project } : {}) as Loose[]).filter((i) => project || live.has(i.project));
	const open = items.filter((i) => (OPEN as readonly string[]).includes(i.status));
	const mine = open.filter((i) => i.owner === "kostas").sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id - b.id);
	const where = (i: Item) => (project ? "" : ` [${i.project}]`);
	const line = (i: Loose, extra = "") =>
		`- wb-${i.ref} ${i.kind}: ${i.title}${where(i)}${i.priority === 1 ? " (P1)" : ""}${i.unblocks ? ` (unblocks ${i.unblocks})` : ""}${i.stale ? " (stale)" : ""}${extra}`;
	const out: string[] = [`Today${project ? ` in ${project}` : ""}, since ${t.since} UTC.`];
	const fresh = mine.filter((i) => i.created_at >= t.since);
	if (mine.length) {
		const shown = new Set<number>();
		const pick = (list: Loose[], n: number) => list.filter((i) => !shown.has(i.id)).slice(0, n).map((i) => (shown.add(i.id), i));
		const unblock = pick(mine.filter((i) => (i.unblocks ?? 0) > 0).sort((a, b) => b.unblocks! - a.unblocks!), 3);
		const news = pick([...fresh].reverse(), 4);
		const oldest = pick(mine, 3);
		out.push("", `Needs you: ${mine.length} waiting${fresh.length ? `, ${fresh.length} new since then` : ""}.`);
		for (const i of unblock) out.push(line(i));
		for (const i of news) out.push(line(i, " (new)"));
		for (const i of oldest) out.push(line(i, ` (waiting ${plural(days(i.created_at, now), "day")})`));
	}
	if (t.done.length) {
		out.push("", `Done by agents: ${t.done.length}.`);
		for (const d of t.done.slice(0, 12)) out.push(`- wb-${d.ref}: ${d.title}${project ? "" : ` [${d.project}]`}${d.note ? ` — ${d.note}` : ""}`);
		if (t.done.length > 12) out.push(`- and ${t.done.length - 12} more`);
	}
	const stuck = open.filter((i) => i.owner !== "kostas" && (i.status === "waiting" || i.stale));
	if (stuck.length) {
		out.push("", "Stuck:");
		for (const i of stuck.slice(0, 8)) out.push(line(i, i.status === "waiting" ? " (waiting)" : ""));
	}
	const soon = open.filter((i) => i.decide_by && parse(String(i.decide_by)).getTime() < now.getTime() + 3 * DAY);
	if (soon.length) {
		out.push("", "Coming up:");
		for (const i of soon) out.push(line(i, ` (decide by ${i.decide_by})`));
	}
	if (t.reports.length) {
		out.push("", "Reports updated:");
		for (const r of t.reports.slice(0, 8)) out.push(`- ${r.title}${project ? "" : ` [${r.project}]`}`);
	}
	if (out.length === 1) out.push("", "Nothing new, and nothing waits on you.");
	return out.join("\n");
}
