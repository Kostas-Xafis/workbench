/**
 * Rulings: a project's standing answers, one line each in plain words ("Traditional is the default melisma style"),
 * so agents read what Kostas already decided instead of asking again.
 *
 * - Answering a decision drafts one from its title and answer (draftRuling, called by answerItem), marked drafted
 *   until an agent or Kostas rewrites it as one clear line. Decisions answered before rulings existed, or by an
 *   older board, get theirs the next time the database opens (backfillRulings): additive rows, never twice.
 * - Agents add, rewrite and retire them over MCP and `wb rule`; Kostas on the board. Retired ones stay, out of sight.
 * - A new decision, review or notice is compared with the project's live rulings (similarRulings): above THRESHOLD
 *   it's still saved, and the agent is told which ruling it may repeat.
 *
 * The matching has no dependencies: words with accents and case folded (Greek too), short words and stop words
 * dropped, each cut to its first STEM letters, weighted by how rare they are in the project (TF-IDF), compared by
 * cosine. It was tuned on the real board's decisions (see THRESHOLD).
 */
import type { Db } from "./db";

export type Ruling = {
	id: number;
	project: string;
	/** One line in plain words. */
	text: string;
	/** The item it came from, while it exists (tidying removes old closed items; item_ref stays). */
	item_id: number | null;
	/** That item's ref, without wb-; '' = none. */
	item_ref: string;
	/** That item's title when the ruling was made: what the question was, for matching and for people. */
	question: string;
	/** 'answer' = drafted from a decision's answer (one per item); '' = written by someone. */
	origin: string;
	/** The answer it was drafted from, to tell a new answer from the same one sent again. */
	from_answer: string;
	/** 1 while it's the automatic draft, until someone rewrites it. */
	drafted: number;
	author: string;
	created_at: string;
	updated_at: string;
	/** NULL = live. */
	retired_at: string | null;
};

export function createTables(db: Db) {
	db.run(`CREATE TABLE IF NOT EXISTS rulings (
		id INTEGER PRIMARY KEY,
		project TEXT NOT NULL REFERENCES projects(slug),
		text TEXT NOT NULL,
		item_id INTEGER REFERENCES items(id) ON DELETE SET NULL,
		item_ref TEXT NOT NULL DEFAULT '',
		question TEXT NOT NULL DEFAULT '',
		origin TEXT NOT NULL DEFAULT '',
		from_answer TEXT NOT NULL DEFAULT '',
		drafted INTEGER NOT NULL DEFAULT 0,
		author TEXT NOT NULL DEFAULT '',
		created_at TEXT NOT NULL DEFAULT (datetime('now')),
		updated_at TEXT NOT NULL DEFAULT (datetime('now')),
		retired_at TEXT
	)`);
	db.run("CREATE INDEX IF NOT EXISTS rulings_project ON rulings(project, retired_at)");
	db.run("CREATE INDEX IF NOT EXISTS rulings_item ON rulings(item_id)");
}

/** At most this long: a ruling is one line. */
export const MAX_RULING = 400;

function cleanText(text: unknown): string {
	if (typeof text !== "string") throw new Error("a ruling is text");
	const s = text.trim().replace(/\s+/g, " ");
	if (!s) throw new Error("a ruling can't be empty");
	if (s.length > MAX_RULING) throw new Error(`a ruling is one line: at most ${MAX_RULING} characters`);
	return s;
}

type ItemRow = { id: number; ref: string; project: string; title: string; body: string; answer: string; updated_at: string };
const itemRow = (db: Db, id: number) =>
	db.query("SELECT id, ref, project, title, body, answer, updated_at FROM items WHERE id = ?").get(id) as ItemRow | null;

/* ---------- Reading ---------- */

export type RulingFilter = { project?: string; q?: string; retired?: boolean | "all" };

/** Live rulings (or retired ones, or all), newest first; `q` looks in the text, the question and the ref. */
export function listRulings(db: Db, f: RulingFilter = {}): Ruling[] {
	const where = ["($project = '' OR project = $project)"];
	if (f.retired === true) where.push("retired_at IS NOT NULL");
	else if (f.retired !== "all") where.push("retired_at IS NULL");
	const rows = db
		.query(`SELECT * FROM rulings WHERE ${where.join(" AND ")} ORDER BY COALESCE(retired_at, '') , updated_at DESC, id DESC`)
		.all({ project: f.project ?? "" }) as Ruling[];
	const q = f.q?.trim();
	if (!q) return rows;
	// Accents and case don't matter: «Ακολουθίες» finds "ακολουθιες".
	const want = fold(q).replace(/^wb-/, "");
	return rows.filter((r) => fold(`${r.text} ${r.question} ${r.item_ref} wb-${r.item_ref}`).includes(want));
}

export function getRuling(db: Db, id: number): Ruling | undefined {
	return (db.query("SELECT * FROM rulings WHERE id = ?").get(id) as Ruling | null) ?? undefined;
}

/** The ruling drafted from an item's answer, if there is one (live or retired). */
export function answerRuling(db: Db, itemId: number): Ruling | undefined {
	return (db.query("SELECT * FROM rulings WHERE item_id = ? AND origin = 'answer' ORDER BY id LIMIT 1").get(itemId) as Ruling | null) ?? undefined;
}

/** Every ruling that names the item. */
export function itemRulings(db: Db, itemId: number): Ruling[] {
	return db.query("SELECT * FROM rulings WHERE item_id = ? ORDER BY id").all(itemId) as Ruling[];
}

/* ---------- Writing ---------- */

export type RulingInput = { project: string; text: string; item?: number | null };

export function addRuling(db: Db, r: RulingInput, author = ""): number {
	const text = cleanText(r.text);
	if (!db.query("SELECT 1 FROM projects WHERE slug = ?").get(r.project)) throw new Error(`no project "${r.project}"`);
	const item = r.item ? itemRow(db, r.item) : null;
	if (r.item && !item) throw new Error(`no item #${r.item}`);
	const { id } = db
		.query("INSERT INTO rulings (project, text, item_id, item_ref, question, author) VALUES (?, ?, ?, ?, ?, ?) RETURNING id")
		.get(r.project, text, item?.id ?? null, item?.ref ?? "", item?.title ?? "", author) as { id: number };
	return id;
}

export type RulingPatch = { text?: string; project?: string; item?: number | null; retired?: boolean };

/** Rewriting the text makes a draft a ruling someone stands behind (drafted = 0). */
export function updateRuling(db: Db, id: number, patch: RulingPatch, author = ""): Ruling {
	const before = getRuling(db, id);
	if (!before) throw new Error(`no ruling #${id}`);
	const set: string[] = [];
	const row: Record<string, string | number | null> = { id };
	if (patch.text !== undefined) {
		const text = cleanText(patch.text);
		set.push("text = $text", "drafted = 0", "author = $author");
		row.text = text;
		row.author = author || before.author;
	}
	if (patch.project !== undefined && patch.project !== before.project) {
		if (!db.query("SELECT 1 FROM projects WHERE slug = ?").get(patch.project)) throw new Error(`no project "${patch.project}"`);
		set.push("project = $project");
		row.project = patch.project;
	}
	if (patch.item !== undefined) {
		const item = patch.item ? itemRow(db, patch.item) : null;
		if (patch.item && !item) throw new Error(`no item #${patch.item}`);
		set.push("item_id = $item_id", "item_ref = $item_ref", "question = $question");
		Object.assign(row, { item_id: item?.id ?? null, item_ref: item?.ref ?? "", question: item?.title ?? "" });
	}
	if (patch.retired !== undefined) set.push(patch.retired ? "retired_at = COALESCE(retired_at, datetime('now'))" : "retired_at = NULL");
	if (set.length) db.query(`UPDATE rulings SET ${set.join(", ")}, updated_at = datetime('now') WHERE id = $id`).run(row);
	return getRuling(db, id)!;
}

/** Out of sight and out of the agents' way; it stays in the list of retired ones and can come back. */
export const retireRuling = (db: Db, id: number, author = "") => updateRuling(db, id, { retired: true }, author);

/* ---------- Drafts from answers ---------- */

/**
 * A first, plain-words line from a decision's title and answer, without an LLM: "<question>: <answer>", the
 * question's "Decide …" / "Choose …" lead-in and the answer's "(recommended)" dropped. An agent rewrites it later.
 */
export function draftText(title: string, answer: string): string {
	let q = title.trim().replace(/\s+/g, " ");
	q = q.replace(/^(decide|choose|pick)\s*(:|\s-\s)\s*/i, "").replace(/^(decide|choose|pick)\s+(whether|if|on)\s+/i, "Whether ")
		.replace(/^(decide|choose|pick)\s+/i, "");
	q = q.charAt(0).toUpperCase() + q.slice(1);
	let a = answer.trim().replace(/\s*\((recommended|προτείνεται)\)/gi, "").replace(/\s+/g, " ").trim();
	a = a.replace(/^\(?\d+\)\s*/, "");
	const line = /[?;:]$/.test(q) ? `${q} ${a}` : `${q}: ${a}`;
	return line.length > MAX_RULING ? `${line.slice(0, MAX_RULING - 1).trimEnd()}…` : line;
}

/**
 * The ruling an answer makes: drafted from the item's title and answer. Called once per answer (answerItem). The
 * same answer sent again changes nothing (an agent's rewrite stays); a new answer replaces the line with a new
 * draft, and brings a retired one back. No answer, no ruling.
 */
export function draftRuling(db: Db, itemId: number, author = ""): Ruling | undefined {
	const item = itemRow(db, itemId);
	if (!item?.answer.trim()) return undefined;
	const had = answerRuling(db, itemId);
	if (had && had.from_answer === item.answer) return had;
	const text = draftText(item.title, item.answer);
	if (had) {
		db.query(
			`UPDATE rulings SET text = ?, question = ?, from_answer = ?, drafted = 1, retired_at = NULL, author = ?, updated_at = datetime('now') WHERE id = ?`,
		).run(text, item.title, item.answer, author, had.id);
		return getRuling(db, had.id);
	}
	const { id } = db
		.query(
			`INSERT INTO rulings (project, text, item_id, item_ref, question, origin, from_answer, drafted, author)
			VALUES (?, ?, ?, ?, ?, 'answer', ?, 1, ?) RETURNING id`,
		)
		.get(item.project, text, item.id, item.ref, item.title, item.answer, author) as { id: number };
	return getRuling(db, id);
}

/**
 * Drafts the ruling of every answered item that never had one: the answers given before rulings existed, or on a
 * board without them. Dated when the answer was given. Runs when the database opens; an item gets one at most once
 * (a retired draft counts), so running it again adds nothing. Returns how many it added.
 */
export function backfillRulings(db: Db): number {
	const todo = db
		.query(
			`SELECT id FROM items i WHERE answer <> '' AND NOT EXISTS (SELECT 1 FROM rulings r WHERE r.item_id = i.id AND r.origin = 'answer')`,
		)
		.all() as { id: number }[];
	if (!todo.length) return 0;
	db.transaction(() => {
		for (const { id } of todo) {
			const r = draftRuling(db, id, "board");
			// When it was answered: the history line that set the answer, else the item's last change.
			const at = db
				.query("SELECT at FROM notes WHERE item_id = ? AND (text LIKE 'answer: %' OR text LIKE '% · answer: %') ORDER BY at DESC, id DESC LIMIT 1")
				.get(id) as { at: string } | null;
			const when = at?.at ?? itemRow(db, id)!.updated_at;
			if (r) db.query("UPDATE rulings SET created_at = ?, updated_at = ? WHERE id = ?").run(when, when, r.id);
		}
	})();
	return todo.length;
}

/* ---------- Matching ---------- */

/** Lower case, accents and other marks off, final sigma as sigma: «Ἀκολουθίες» and "ακολουθιες" are one word. */
export function fold(s: string): string {
	return s.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "").replace(/ς/g, "σ").normalize("NFC");
}

/** Words cut to this many letters, so plurals and endings meet: "rulings" and "ruling", «ἁγίων» and «ἅγιος». */
const STEM = 6;
// Words every decision uses, which say nothing about what it's about. Folded (no accents).
const STOP = new Set(
	(
		"the and for with that this from what when which whether should would could will can not but are was were has have " +
		"had its it's into onto than then them they their there here how why who all any each one two out off our your you " +
		"yes now new also only just more most less very too use used using get got like make made keep set add see " +
		"decide decision choose choice pick option options answer agent agents kostas item items recommended recommend " +
		"does doing done about after before over under again same other way want need needs review check confirm " +
		"και του της των την τον στο στη στην στον στα στις στους για απο απ με να θα δεν μη μην το τα οι η ο ενα μια ενασ " +
		"που πωσ οτι ειναι οπωσ σαν αλλα ομωσ ηδη εδω εκει αυτο αυτη αυτα αυτοσ ολα ολοι κατα μετα πριν οταν αν ή"
	)
		.split(/\s+/)
		.filter(Boolean),
);

/** The words of a text that carry meaning, folded and cut to their stems. */
export function words(s: string): string[] {
	return fold(s)
		.split(/[^\p{L}\p{N}]+/u)
		.filter((w) => w.length >= 3 && !STOP.has(w) && !/^\d+$/.test(w))
		.map((w) => w.slice(0, STEM));
}

type Vec = Map<string, number>;
const counts = (ws: string[], into: Vec = new Map(), weight = 1) => {
	for (const w of ws) into.set(w, (into.get(w) ?? 0) + weight);
	return into;
};

/** How rare each stem is among the project's items and rulings: rarer words say more. */
function idfOf(db: Db, project: string) {
	const docs = (db.query("SELECT title || ' ' || body AS t FROM items WHERE project = ?").all(project) as { t: string }[]).map((d) => d.t);
	for (const r of db.query("SELECT text FROM rulings WHERE project = ?").all(project) as { text: string }[]) docs.push(r.text);
	const df = new Map<string, number>();
	for (const d of docs) for (const w of new Set(words(d))) df.set(w, (df.get(w) ?? 0) + 1);
	const n = docs.length;
	return (w: string) => Math.log((n + 1) / ((df.get(w) ?? 0) + 1)) + 1;
}

function weigh(tf: Vec, idf: (w: string) => number): Vec {
	const v: Vec = new Map();
	let norm = 0;
	for (const [w, n] of tf) {
		const x = (1 + Math.log(n)) * idf(w);
		v.set(w, x);
		norm += x * x;
	}
	norm = Math.sqrt(norm) || 1;
	for (const [w, x] of v) v.set(w, x / norm);
	return v;
}

const cosine = (a: Vec, b: Vec) => {
	let s = 0;
	for (const [w, x] of a.size < b.size ? a : b) s += x * ((a.size < b.size ? b : a).get(w) ?? 0);
	return s;
};

/**
 * Above this, add_item warns that a new ask may repeat a ruling. Tuned on the real board (Nov 2026: 24 answered
 * decisions against 164 decisions and reviews in three projects): the four a person would call a repeat scored
 * 0.34 to 0.57; one related but different ask reached it (0.51); the closest unrelated pair scored 0.32, the rest
 * 0.29 and below. So it fires on 5 asks in 164, 4 of them real.
 */
export const THRESHOLD = 0.33;
/** Below this, a ruling isn't worth showing an agent as relevant to its item (work-on). */
export const RELEVANT = 0.15;

export type Match = { ruling: Ruling; score: number };

/**
 * The project's live rulings closest to a title and body, best first, scored 0..1. The title counts twice: it's
 * what the ask is about. Each ruling is matched on its line, its question, and the question's details while the
 * item exists; whichever is closest counts. `except` leaves out the rulings of that item (the item itself).
 */
export function similarRulings(
	db: Db,
	project: string,
	title: string,
	body = "",
	{ min = THRESHOLD, limit = 3, except }: { min?: number; limit?: number; except?: number } = {},
): Match[] {
	const live = listRulings(db, { project }).filter((r) => except === undefined || r.item_id !== except);
	if (!live.length) return [];
	const idf = idfOf(db, project);
	const head = weigh(counts(words(title)), idf);
	const whole = weigh(counts(words(body), counts(words(title), new Map(), 2)), idf);
	if (!whole.size) return [];
	const out: Match[] = [];
	for (const r of live) {
		const line = weigh(counts(words(`${r.text} ${r.question}`)), idf);
		const src = r.item_id ? itemRow(db, r.item_id) : null;
		const asked = src ? weigh(counts(words(src.body), counts(words(src.title), new Map(), 2)), idf) : line;
		// Mostly the title against the ruling and its question; the details against the question's details less,
		// since a project's asks share their vocabulary (every fasting question says "fish" and "Wednesday").
		const score = 0.6 * cosine(head, line) + 0.4 * cosine(whole, asked);
		if (score >= min) out.push({ ruling: r, score: Math.round(score * 1000) / 1000 });
	}
	return out.sort((a, b) => b.score - a.score).slice(0, limit);
}

/** The kinds that ask Kostas something: the ones checked against rulings when filed. */
export const ASKING_KINDS = ["decision", "review", "notice"];

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "25 Oct" (and the year when it isn't this one). */
export function shortDate(sql: string, now = new Date()): string {
	const d = new Date(sql.replace(" ", "T") + "Z");
	if (Number.isNaN(d.getTime())) return sql;
	return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}${d.getUTCFullYear() === now.getUTCFullYear() ? "" : ` ${d.getUTCFullYear()}`}`;
}

/** Where a ruling came from, for a sentence: "wb-xxxx, 25 Oct" or just the date. */
export const rulingSource = (r: Ruling) => [r.item_ref && `wb-${r.item_ref}`, shortDate(r.created_at)].filter(Boolean).join(", ");

/** The warning add_item gives when a new ask looks like one already ruled on; '' when nothing matches. */
export function repeatWarning(matches: Match[], name: string, drop = "drop_item"): string {
	if (!matches.length) return "";
	const lines = matches.map((m) => `“${m.ruling.text}” (${rulingSource(m.ruling)})`);
	return `${name} already ruled: ${lines.join("; ")}. If this is answered by that, drop the item (${drop}); if it asks something new, say in its body how it differs.`;
}
