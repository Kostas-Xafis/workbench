/**
 * Waiting on another item: an item that's blocked says which items it waits on (`item_links`), so answering a
 * decision, or finishing or dropping an item, lets the work that waited on it carry on by itself.
 *
 * A row means "item_id waits on blocker_id". Rows exist only while the waiting item is `waiting`: when it leaves that
 * status (an agent picks it up, Kostas moves it, it resumes) its rows go, and the history says what happened. A row is
 * also dropped once its blocker is dealt with, so what `blockersOf` lists is what still holds the item up.
 *
 * Every way an item gets answered, finished or dropped ends in `updateItem` (db.ts), which calls `resumeWaiting`.
 * Something that sets an answer or a status another way, or wants the resumed items back to act on them, calls
 * `resumeWaiting(db, blockerId, how)` itself: it is cheap and safe to call twice.
 */
import { addNote, updateItem, type Db, type Item } from "./db";

/** What the board shows about an item on the other end of a link. */
export type LinkRef = {
	id: number;
	ref: string;
	title: string;
	kind: string;
	owner: string;
	status: string;
	project: string;
	answer: string;
};
/** An item `resumeWaiting` put back to todo. */
export type Resumed = { id: number; ref: string; title: string; project: string; owner: string };
export type How = "answered" | "done" | "dropped";

export function createLinkTable(db: Db) {
	db.run(`CREATE TABLE IF NOT EXISTS item_links (
		item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
		blocker_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
		created_at TEXT NOT NULL DEFAULT (datetime('now')),
		PRIMARY KEY (item_id, blocker_id)
	)`);
	db.run("CREATE INDEX IF NOT EXISTS item_links_blocker ON item_links(blocker_id)");
}

/** Dealt with: finished, dropped, or (a decision) answered. */
export const resolved = (i: { status: string; answer: string }) =>
	i.status === "done" || i.status === "dropped" || !!i.answer?.trim();

/** SQL for the two counts listItems and getItem carry: how many items wait on this one, and how many it waits on. */
export const LINK_COUNTS = `
	CASE WHEN items.status IN ('done', 'dropped') OR items.answer != '' THEN 0
		ELSE (SELECT COUNT(*) FROM item_links l JOIN items w ON w.id = l.item_id WHERE l.blocker_id = items.id AND w.status = 'waiting')
	END AS unblocks,
	(SELECT COUNT(*) FROM item_links l WHERE l.item_id = items.id) AS waiting_on`;

const REF_COLS = "i.id, i.ref, i.title, i.kind, i.owner, i.status, i.project, i.answer";

/** What the item waits on. */
export function blockersOf(db: Db, id: number): LinkRef[] {
	return db
		.query(`SELECT ${REF_COLS} FROM item_links l JOIN items i ON i.id = l.blocker_id WHERE l.item_id = ? ORDER BY l.created_at, i.id`)
		.all(id) as LinkRef[];
}

/** What waits on the item, and hasn't carried on yet. */
export function waitersOf(db: Db, id: number): LinkRef[] {
	return db
		.query(
			`SELECT ${REF_COLS} FROM item_links l JOIN items i ON i.id = l.item_id WHERE l.blocker_id = ? AND i.status = 'waiting' ORDER BY l.created_at, i.id`,
		)
		.all(id) as LinkRef[];
}

/** How many waiting items an open item holds up. */
export function unblocks(db: Db, id: number): number {
	const i = db.query("SELECT status, answer FROM items WHERE id = ?").get(id) as Pick<Item, "status" | "answer"> | null;
	if (!i || resolved(i)) return 0;
	return (
		db
			.query("SELECT COUNT(*) AS n FROM item_links l JOIN items w ON w.id = l.item_id WHERE l.blocker_id = ? AND w.status = 'waiting'")
			.get(id) as { n: number }
	).n;
}

/** Whether `from` already waits on `target`, through any number of links. */
function reaches(db: Db, from: number, target: number): boolean {
	return !!db
		.query(
			`WITH RECURSIVE chain(id) AS (
				SELECT blocker_id FROM item_links WHERE item_id = $from
				UNION SELECT l.blocker_id FROM item_links l JOIN chain c ON l.item_id = c.id
			) SELECT 1 FROM chain WHERE id = $target`,
		)
		.get({ from, target });
}

const label = (i: { ref: string }) => `wb-${i.ref}`;
/** "wb-k3f9 (Should sync be CRDT?)" for a note. */
const describe = (l: Pick<LinkRef, "ref" | "title">) => `${label(l)} (${l.title})`;
const row = (db: Db, id: number) => db.query("SELECT * FROM items WHERE id = ?").get(id) as Item | null;

/** Why `id` can't wait on `target`, or nothing. */
function refuse(db: Db, id: number, target: number): string | undefined {
	const t = row(db, target);
	if (!t) return `no item #${target}`;
	if (target === id) return `${label(t)} can't wait on itself`;
	if (resolved(t)) return `${label(t)} is already ${t.status === "dropped" ? "dropped" : t.status === "done" ? "done" : "answered"}: there's nothing to wait on`;
	if (reaches(db, target, id)) return `${label(t)} already waits on ${label(row(db, id)!)}, so they would wait on each other`;
}

/** Makes `id` wait on each of `targets` (more links on top of what it has); nothing is changed when one is refused. */
export function addLinks(db: Db, id: number, targets: number[]) {
	const list = [...new Set(targets)];
	for (const t of list) {
		const why = refuse(db, id, t);
		if (why) throw new Error(why);
	}
	const ins = db.query("INSERT OR IGNORE INTO item_links (item_id, blocker_id) VALUES (?, ?)");
	db.transaction(() => list.forEach((t) => ins.run(id, t)))();
}

export function removeLinks(db: Db, id: number, targets: number[]) {
	const del = db.query("DELETE FROM item_links WHERE item_id = ? AND blocker_id = ?");
	db.transaction(() => targets.forEach((t) => del.run(id, t)))();
}

/** Called when an item leaves `waiting`: it waits on nothing any more. */
export function clearLinks(db: Db, id: number) {
	db.query("DELETE FROM item_links WHERE item_id = ?").run(id);
}

/**
 * `id` is blocked on `targets`: it becomes waiting and holds a link to each. Everything is checked first, so a
 * refused link leaves the item as it was. Returns the items it now waits on.
 */
export function waitOn(db: Db, id: number, targets: number[], author = "agent"): LinkRef[] {
	const list = [...new Set(targets)];
	for (const t of list) {
		const why = refuse(db, id, t);
		if (why) throw new Error(why);
	}
	const me = row(db, id);
	if (!me) throw new Error(`no item #${id}`);
	if (me.status === "done" || me.status === "dropped") throw new Error(`${label(me)} is ${me.status}: it can't wait on anything`);
	updateItem(db, id, { status: "waiting" }, author);
	addLinks(db, id, list);
	const now = blockersOf(db, id);
	addNote(db, id, `Waits on ${now.map(describe).join(", ")}`, author);
	return now;
}

const short = (s: string, n = 300) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

/** The last thing someone wrote on an item, if it is one line and short: not the notes the board writes about changes. */
function lastWords(db: Db, id: number): string {
	const notes = db.query("SELECT text FROM notes WHERE item_id = ? ORDER BY at DESC, id DESC").all(id) as { text: string }[];
	for (const { text } of notes) {
		const t = text.trim();
		if (t === "created" || /^(\w+: .* → .*|body edited|options: .*|image .*)( · .*)?$/.test(t) || t.startsWith("Unblocked:")) continue;
		return t.length <= 200 && !t.includes("\n") ? t : "";
	}
	return "";
}

/**
 * `blockerId` was answered, finished or dropped: whatever waited only on it goes back to todo, with a note saying
 * why; whatever waits on more than this stays waiting and gets a note. `how` says which (it is worked out from the
 * item when left out); given, it is trusted, so a caller may use it just before it records the answer.
 * Safe to call more than once: a link is dropped once it's dealt with. Returns the items put back to todo, for
 * whoever wants to act on them (the board's notifications compare states; "Answer & send" may start an agent).
 */
export function resumeWaiting(db: Db, blockerId: number, how?: How): Resumed[] {
	const b = row(db, blockerId);
	if (!b) return [];
	if (!how && !resolved(b)) return [];
	how ??= b.status === "done" ? "done" : b.status === "dropped" ? "dropped" : "answered";
	const waiters = db.query("SELECT item_id AS id FROM item_links WHERE blocker_id = ?").all(blockerId) as { id: number }[];
	if (!waiters.length) return [];
	const words = how === "answered" ? "" : lastWords(db, blockerId);
	const what =
		how === "answered"
			? `${label(b)} was answered${b.answer ? `: ${short(b.answer)}` : ""}`
			: `${label(b)} was ${how === "done" ? "finished" : "dropped"}${words ? `: ${words}` : ""}`;
	const out: Resumed[] = [];
	for (const { id } of waiters) {
		const w = row(db, id);
		db.query("DELETE FROM item_links WHERE item_id = ? AND blocker_id = ?").run(id, blockerId);
		if (!w || w.status !== "waiting") continue;
		// Still held up by another item that isn't dealt with.
		const open = blockersOf(db, id).filter((x) => !resolved(x));
		if (open.length) {
			addNote(db, id, `${what}. Still waiting on ${open.map(label).join(", ")}.`, "workbench");
			continue;
		}
		updateItem(db, id, { status: "todo" }, "workbench");
		addNote(db, id, `Unblocked: ${what}`, "workbench");
		out.push({ id, ref: w.ref, title: w.title, project: w.project, owner: w.owner });
	}
	return out;
}

/** Open items held up by their waiters the most, for what the board and agents call "unblocks". */
export function topUnblockers(db: Db, project?: string, limit = 5, owner = "kostas") {
	const rows = db
		.query(
			`SELECT items.id, ${LINK_COUNTS} FROM items WHERE items.status IN ('todo', 'doing', 'waiting') AND items.owner = $owner
				${project ? "AND items.project = $project" : ""} ORDER BY unblocks DESC, items.priority, items.id`,
		)
		.all({ owner, ...(project ? { project } : {}) }) as { id: number; unblocks: number }[];
	return rows
		.filter((r) => r.unblocks > 0)
		.slice(0, limit)
		.map((r) => ({ item: row(db, r.id)!, waiters: waitersOf(db, r.id) }));
}
