/**
 * Queue mode: what waits on Kostas, one item at a time (the board's #queue, ui/queue.js).
 *
 * - The order (queueOrder): priority 1 first; then what unblocks the most waiting work; then the items of the
 *   project's active goal (goal rank); then deadlines coming soon (decide_by within SOON_DAYS); then P2 before P3;
 *   then the oldest.
 * - Similar asks come one after another (groupSimilar): same project and the same area, or titles alike
 *   (titleMatcher in rulings.ts, above ALIKE). A group lands where its first item would and holds at most
 *   MAX_GROUP; priority 1 items only group with each other.
 * - Notices come after the asks, as a quick "seen / object" pass. They don't wait on Kostas (needsKostas).
 * - Deferred items (`deferred_until`, set by deferItem) stay out of the queue until then. They still wait on him
 *   and count in "Needs you"; the queue says how many are deferred.
 * - Giving an item back (giveBack) hands it to the agent with his line in the history.
 *
 * Deferring and giving back are history lines, so agents need nothing new to read them.
 */
import { addNote, getItem, listItems, updateItem, type Db, type Item } from "./db";
import { needsKostas, sqlTime } from "./asks";
import { itemGoals, type ItemGoal } from "./goals";
import { titleMatcher } from "./rulings";

/** Deadlines this close count as coming soon. */
export const SOON_DAYS = 3;
/** Titles at least this alike group together. Tuned on the real board (Nov 2026): "Decide which tab extras to build"
 * and "Decide which menu extras to build" score 0.67, "Get the German wording proofread" and "… Spanish …" 0.60;
 * related but different asks ("Review how version history keeps …" and "… what cloud sync did to old versions") 0.42. */
export const ALIKE = 0.45;
/** At most this many in a group: a long run of one area doesn't push everything else back. */
export const MAX_GROUP = 8;
/** What the summary shows of a brief before "Read all". */
export const SUMMARY_MAX = 300;
/** Kostas's line when he gives an item back without one of his own. */
export const GIVE_BACK = "You decide, with your recommendation.";

const OPEN = ["todo", "doing", "waiting"];
const DAY = 86400e3;
const fromSql = (s: string) => new Date(s.replace(" ", "T") + "Z");
/** "Fri 14 Nov", in this computer's time. */
const dayLabel = (s: string) => fromSql(s).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });

/* ---------- The summary ---------- */

/**
 * The opening of a brief, for the queue's summary: its first paragraph of text (headings and pictures skipped), cut
 * at a sentence when it runs past `max`. `more` says whether the brief goes on.
 */
export function briefOpening(body: string, max = SUMMARY_MAX): { summary: string; more: boolean } {
	const text = String(body ?? "").replace(/\r\n?/g, "\n").trim();
	if (!text) return { summary: "", more: false };
	const blocks = text.split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
	// A heading on top of a paragraph ("## Why\nBecause …") isn't the opening, and neither is a picture or code.
	const prose = (b: string) => b.replace(/^(#{1,6}\s.*(\n|$))+/, "").trim();
	const at = blocks.findIndex((b) => !!prose(b) && !/^!\[[^\]]*\]\([^)]*\)$/.test(prose(b)) && !/^```/.test(b));
	if (at < 0) return { summary: "", more: true };
	const first = prose(blocks[at]);
	let more = at < blocks.length - 1;
	if (first.length <= max) return { summary: first, more };
	more = true;
	// A list: as many whole lines as fit.
	if (/^\s*(?:[-*]|\d+[.)])\s/.test(first)) {
		const lines = first.split("\n");
		let out = lines[0];
		for (const l of lines.slice(1)) {
			if (out.length + 1 + l.length > max) break;
			out += `\n${l}`;
		}
		return { summary: out.length <= max ? out : cut(out, max), more };
	}
	return { summary: cut(first, max), more };
}
/** Cut at the last sentence end before `max`; with none worth keeping, at a word, with an ellipsis. */
function cut(s: string, max: number) {
	const head = s.slice(0, max + 1);
	let end = -1;
	for (const m of head.matchAll(/[.!?…](?:["'”’)\]]*)(?=\s|$)/g)) if (m.index! + m[0].length <= max) end = m.index! + m[0].length;
	if (end >= max * 0.35) return s.slice(0, end).trim();
	const sp = head.lastIndexOf(" ", max - 1);
	return `${s.slice(0, sp > max * 0.5 ? sp : max - 1).trimEnd().replace(/[,;:–—-]$/, "")}…`;
}

/** A check's steps: the items of the first list in its brief (numbered or not). */
export function checkSteps(body: string): string[] {
	const lines = String(body ?? "").replace(/\r\n?/g, "\n").split("\n");
	const out: string[] = [];
	let fence = false;
	for (const line of lines) {
		if (/^\s*```/.test(line)) fence = !fence;
		if (fence) continue;
		const m = line.match(/^(\s*)(?:[-*]|\d+[.)])\s+(.*)$/);
		if (m && !m[1].length) out.push(m[2].replace(/^\[[ xX]\]\s+/, "").trim());
		else if (m) continue; // a step's own sub-points stay in the full brief
		else if (out.length && line.trim() && !/^\s/.test(line)) break;
	}
	return out;
}

/* ---------- The order ---------- */

export type QueueGroup = {
	/** Items with the same id belong together. */
	id: number;
	/** How many, and where this one is among them (1 = the first). */
	size: number;
	at: number;
	/** Why they're together: the area, or "similar titles". */
	why: string;
};
/** An item without its brief (GET /api/items/:id has it, with the notes and pictures): the summary instead. */
export type QueueEntry = Omit<Item, "body"> & {
	summary: string;
	more: boolean;
	/** A check's steps; [] otherwise. */
	steps: string[];
	goal: ItemGoal | null;
	notice: boolean;
	group: QueueGroup | null;
};
export type Queue = {
	project: string;
	/** In order: the asks, then the notices. */
	items: QueueEntry[];
	/** How many asks (waiting on Kostas) and notices are in `items`. */
	asks: number;
	notices: number;
	/** Out of the queue for now, soonest back first. */
	deferred: { id: number; ref: string; title: string; kind: string; until: string }[];
};

type Ordered = Item & { goal: ItemGoal | null };

/** The queue's order (see the top of this file). */
export function queueCompare(now = new Date()) {
	const soon = sqlTime(new Date(now.getTime() + SOON_DAYS * DAY));
	const due = (i: Item) => (i.decide_by && i.decide_by <= soon ? i.decide_by : "~");
	// Plain code-point order: a locale's collation puts "~" before the digits.
	const cmp = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);
	return (a: Ordered, b: Ordered) =>
		Number(a.priority !== 1) - Number(b.priority !== 1) ||
		(b.unblocks ?? 0) - (a.unblocks ?? 0) ||
		(a.goal?.rank ?? 99) - (b.goal?.rank ?? 99) ||
		cmp(due(a), due(b)) ||
		a.priority - b.priority ||
		cmp(a.created_at, b.created_at) ||
		a.id - b.id;
}

/**
 * Puts similar items right after the first of them, in `ordered`'s order: same project and area, or titles at least
 * ALIKE (per project, words weighed by how rare they are there). At most MAX_GROUP each; P1 only with P1.
 */
export function groupSimilar<T extends Item>(db: Db, ordered: T[]): (T & { group: QueueGroup | null })[] {
	const matchers = new Map<string, (a: string, b: string) => number>();
	const alike = (a: T, b: T) => {
		if (a.project !== b.project || (a.priority === 1) !== (b.priority === 1)) return "";
		if (a.area && a.area === b.area) return a.area;
		let m = matchers.get(a.project);
		if (!m) matchers.set(a.project, (m = titleMatcher(db, a.project)));
		return m(a.title, b.title) >= ALIKE ? "similar titles" : "";
	};
	const placed = new Set<number>();
	const out: (T & { group: QueueGroup | null })[] = [];
	let groups = 0;
	for (const a of ordered) {
		if (placed.has(a.id)) continue;
		placed.add(a.id);
		const mates: T[] = [];
		const whys = new Set<string>();
		for (const b of ordered) {
			if (mates.length >= MAX_GROUP - 1) break;
			if (placed.has(b.id)) continue;
			const why = alike(a, b);
			if (!why) continue;
			mates.push(b);
			whys.add(why);
			placed.add(b.id);
		}
		if (!mates.length) {
			out.push({ ...a, group: null });
			continue;
		}
		const id = ++groups;
		const why = whys.size === 1 ? [...whys][0] : a.area && whys.has(a.area) ? a.area : "similar titles";
		[a, ...mates].forEach((x, i) => out.push({ ...x, group: { id, size: mates.length + 1, at: i + 1, why } }));
	}
	return out;
}

/** Kostas's queue for a project ('' = every active one): the asks in order, then the notices, deferred ones apart. */
export function buildQueue(db: Db, { project = "", now = new Date() }: { project?: string; now?: Date } = {}): Queue {
	const live = new Set((db.query("SELECT slug FROM projects WHERE archived_at IS NULL").all() as { slug: string }[]).map((p) => p.slug));
	const open = listItems(db, { ...(project ? { project } : {}), owner: "kostas", status: OPEN as Item["status"][] }).filter(
		(i) => project || live.has(i.project),
	);
	const goals = itemGoals(db, project || undefined);
	const at = sqlTime(now);
	const later = (i: Item) => !!i.deferred_until && i.deferred_until > at;
	const order = queueCompare(now);
	const ready = open.filter((i) => !later(i)).map((i) => ({ ...i, goal: goals.get(i.ref) ?? null }));
	const asks = groupSimilar(db, ready.filter(needsKostas).sort(order));
	const notices = groupSimilar(db, ready.filter((i) => i.kind === "notice").sort(order));
	const entry = ({ body, ...i }: Ordered & { group: QueueGroup | null }): QueueEntry => ({
		...i,
		...briefOpening(body),
		steps: i.kind === "check" ? checkSteps(body) : [],
		notice: i.kind === "notice",
	});
	const deferred = open
		.filter(later)
		.sort((a, b) => a.deferred_until!.localeCompare(b.deferred_until!) || a.id - b.id)
		.map((i) => ({ id: i.id, ref: i.ref, title: i.title, kind: i.kind, until: i.deferred_until! }));
	return { project, items: [...asks, ...notices].map(entry), asks: asks.length, notices: notices.length, deferred };
}

/* ---------- Deferring ---------- */

const WHEN = 'a date (2026-11-14), "tomorrow", "in 3 days", "next week", or "none"';

/**
 * When a deferred item comes back, as given: "tomorrow", "in 3 days" / "3d", "next week" (Monday), a date — each the
 * start of that day here — or a date and time; "none" (null) brings it back now. Returns UTC as the board stores it.
 */
export function parseDeferUntil(v: unknown, now = new Date()): string | null {
	if (v === null || v === undefined) return null;
	const s = String(v).trim().toLowerCase();
	if (!s || ["none", "now", "never", "off", "no"].includes(s)) return null;
	const day = (d: number) => new Date(now.getFullYear(), now.getMonth(), now.getDate() + d);
	let at: Date | undefined;
	let m: RegExpMatchArray | null;
	if (s === "tomorrow") at = day(1);
	else if (s === "next week") at = day(((8 - now.getDay()) % 7) || 7);
	else if ((m = s.match(/^(?:in\s+)?(\d{1,3})\s*(d|days?|w|weeks?)$/))) at = day(Number(m[1]) * (m[2][0] === "w" ? 7 : 1));
	else if ((m = s.match(/^(?:in\s+)?(\d{1,3})\s*(h|hours?)$/))) at = new Date(now.getTime() + Number(m[1]) * 3600e3);
	else if ((m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/))) at = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
	else if ((m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ t](\d{2}):(\d{2})(?::\d{2})?$/)))
		at = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
	if (!at || Number.isNaN(at.getTime())) throw new Error(`defer until ${WHEN}, not "${String(v)}"`);
	if (at <= now) throw new Error(`${String(v)} has passed: give a later day`);
	return sqlTime(at);
}

const openOf = (db: Db, id: number) => {
	const i = getItem(db, id);
	if (!i) throw new Error(`no item #${id}`);
	if (!OPEN.includes(i.status)) throw new Error(`wb-${i.ref} is ${i.status}`);
	return i;
};

/**
 * Keeps an open item of Kostas's out of the queue until `until` (parseDeferUntil; null = back now), with a line in
 * its history. It still waits on him: the board's counts and its deadline don't change.
 */
export function deferItem(db: Db, id: number, until: unknown, author = "kostas") {
	const i = openOf(db, id);
	if (i.owner !== "kostas") throw new Error(`wb-${i.ref} is with the agent: only what waits on you can be deferred`);
	const at = parseDeferUntil(until);
	if (at === (i.deferred_until ?? null)) return getItem(db, id)!;
	db.transaction(() => {
		db.query("UPDATE items SET deferred_until = ? WHERE id = ?").run(at, id);
		addNote(db, id, at ? `Deferred until ${dayLabel(at)}` : "Back in the queue", author);
	})();
	return getItem(db, id)!;
}

/**
 * Hands an item back to the agent with Kostas's line ("You decide, with your recommendation" when he gives none):
 * owner agent, to do, his words in the history. A deadline or a deferral it had is cleared, so nothing goes ahead
 * by itself while the agent has it.
 */
export function giveBack(db: Db, id: number, text = "", author = "kostas") {
	const i = openOf(db, id);
	if (i.owner !== "kostas") throw new Error(`wb-${i.ref} is with the agent already`);
	const line = String(text ?? "").trim().replace(/\s+/g, " ") || GIVE_BACK;
	db.transaction(() => {
		db.query("UPDATE items SET decide_by = NULL, deferred_until = NULL WHERE id = ?").run(id);
		updateItem(db, id, { owner: "agent", status: "todo" }, author, `Given back to the agent: ${line}`);
	})();
	return getItem(db, id)!;
}
