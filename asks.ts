/**
 * Asks that don't block: what agents leave for Kostas without stopping their work on it.
 *
 * - A notice ("here's what changed; object if you want") is an item of kind notice. It never counts as waiting on
 *   Kostas: he says Got it, or objects in a line and it goes back to the agent.
 * - Decisions, reviews and notices can say what happens if he says nothing (`default_answer`) and by when
 *   (`decide_by`). When the deadline passes, the default goes ahead exactly as if he had clicked it; the board's
 *   timer does it (server.ts), and so does every `wb` command and MCP call (applyDue), so it works with the board off.
 * - A decision with pick "many" is answered with several ticked options; `recommended` marks the agent's pick(s).
 * - Per project, the board takes at most `asks.cap` open asks from agents (capRefusal).
 *
 * Every way an ask ends (an answer, Got it, an objection, its default at the deadline) goes through resolveAsk, so
 * whatever should follow an answer has one place to hook in.
 */
import { addNote, getItem, itemOptions, updateItem, type Db, type Item, type ItemPatch } from "./db";
import { askCap, askDays, yourName } from "./settings";

/** Kinds that can go ahead by themselves: a default answer and a deadline. */
export const DEFAULT_KINDS = ["decision", "review", "notice"];
/** What the cap counts: asks that wait on Kostas. Notices don't wait, and ideas aren't asks. */
export const CAPPED_KINDS = ["decision", "review", "check", "setup"];
const OPEN = ["todo", "doing", "waiting"];

/** An item waits on Kostas: his, open, and not a notice. Every "needs you" count goes by this. */
export const needsKostas = (i: Pick<Item, "owner" | "status" | "kind">) =>
	i.owner === "kostas" && OPEN.includes(i.status) && i.kind !== "notice";
/** The same rule in SQL, for the items table (no alias). */
export const NEEDS_KOSTAS_SQL = "owner = 'kostas' AND kind != 'notice' AND status IN ('todo', 'doing', 'waiting')";

const jsonList = (s: string) => {
	try {
		const v = JSON.parse(s || "[]");
		return Array.isArray(v) ? v.map(String) : [];
	} catch {
		return [];
	}
};
export const itemRecommended = (i: Pick<Item, "recommended">) => jsonList(i.recommended);
export const itemPicks = (i: Pick<Item, "picks">) => jsonList(i.picks);

/** A list argument: a list, a JSON list in a string, or one value ('' = none). */
function listArg(v: unknown): string[] {
	if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
	const s = String(v ?? "").trim();
	if (s.startsWith("[")) {
		const l = jsonList(s);
		if (l.length || s.replace(/\s/g, "") === "[]") return l.map((x) => x.trim()).filter(Boolean);
	}
	return s ? [s] : [];
}
/** "1, 3" → ["1", "3"]; "A; B" → ["A", "B"]; anything else stays one pick. */
const splitPicks = (s: string) =>
	/^[\d\s,]+$/.test(s) ? s.split(/[\s,]+/).filter(Boolean) : s.includes(";") ? s.split(";").map((x) => x.trim()).filter(Boolean) : [s.trim()];

/* ---------- Deadlines ---------- */

export const sqlTime = (d: Date) => d.toISOString().slice(0, 19).replace("T", " ");
const fromSql = (s: string) => new Date(s.replace(" ", "T") + "Z");
/** "Fri 14 Nov", in this computer's time. */
export const dayLabel = (s: string) => fromSql(s).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });

const WHEN = 'a date (2026-11-14), "in 3 days", or "none"';

/**
 * A deadline as given: a date (the end of that day here), a date and time, "in 3 days" / "3d" / "2 weeks" / "12h",
 * or "none" (no deadline: null). Returns the UTC time the board stores. Never in the past.
 */
export function parseDecideBy(v: unknown, now = new Date()): string | null {
	if (v === null) return null;
	const s = String(v).trim().toLowerCase();
	if (!s || ["none", "never", "off", "no"].includes(s)) return null;
	let at: Date | undefined;
	let m = s.match(/^(?:in\s+)?(\d{1,3})\s*(h|hours?|d|days?|w|weeks?)$/);
	if (m) at = new Date(now.getTime() + Number(m[1]) * { h: 3600e3, d: 86400e3, w: 7 * 86400e3 }[m[2][0] as "h" | "d" | "w"]);
	else if (s === "tomorrow") at = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 23, 59, 59);
	else if ((m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/))) at = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 23, 59, 59);
	else if ((m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ t](\d{2}):(\d{2})(?::(\d{2}))?(z)?$/)))
		at = m[7]
			? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] ?? 0)))
			: new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] ?? 0));
	if (!at || Number.isNaN(at.getTime())) throw new Error(`decide_by is ${WHEN}, not "${String(v)}"`);
	if (at <= now) throw new Error(`decide_by ${String(v)} has passed: give a later date, or "in N days"`);
	return sqlTime(at);
}

/** What happens if Kostas says nothing, in words; '' = nothing happens by itself. */
export function defaultText(i: Pick<Item, "default_answer" | "pick">): string {
	if (!i.default_answer) return "";
	if (i.pick === "many" && i.default_answer.startsWith("[")) {
		const l = jsonList(i.default_answer);
		return l.length ? l.join("; ") : "none of them";
	}
	return i.default_answer;
}

/** Whether an item goes ahead by itself at its deadline (it may not have one yet). */
export const goesAhead = (i: Pick<Item, "kind" | "default_answer">) =>
	DEFAULT_KINDS.includes(i.kind) && (!!i.default_answer || i.kind === "notice");

/** "Goes ahead with X on Fri 14 Nov" ("Closes as seen …" for a notice without a default); '' without a deadline. */
export function deadlineText(i: Pick<Item, "kind" | "default_answer" | "pick" | "decide_by">): string {
	if (!i.decide_by || !goesAhead(i)) return "";
	const what = defaultText(i);
	return what ? `goes ahead with ${what} on ${dayLabel(i.decide_by)}` : `closes as seen on ${dayLabel(i.decide_by)}`;
}

/* ---------- Checking what an agent or Kostas gives ---------- */

/**
 * Cleans the ask fields of a new item or a change to `before`: pick, recommended (options), the default (an option
 * of a decision that has them; a list for pick many) and the deadline. A new default (or a new notice) for Kostas
 * without a deadline gets one: Settings → You and your day, "A default goes ahead after", 3 days unless changed.
 */
export function cleanAsk(db: Db, patch: ItemPatch, before?: Item): ItemPatch {
	const out: ItemPatch = { ...patch };
	const kind = out.kind ?? before?.kind ?? "task";
	const options = itemOptions({ options: String(out.options ?? before?.options ?? "") });
	if (out.pick !== undefined) {
		const p = String(out.pick).trim().toLowerCase() || "one";
		if (p !== "one" && p !== "many") throw new Error('pick is "one" (one option) or "many" (several ticked)');
		out.pick = p;
	}
	const pick = out.pick ?? before?.pick ?? "one";
	const asOption = (s: string, what: string) => {
		const t = s.trim();
		if (/^\d+$/.test(t) && !options.includes(t) && options[Number(t) - 1]) return options[Number(t) - 1];
		if (!options.includes(t)) throw new Error(`${what} "${t}" isn't one of the options: ${options.join(" | ")}`);
		return t;
	};
	if (out.recommended !== undefined) {
		const given = listArg(out.recommended);
		if (given.length && !options.length) throw new Error("recommended names options: give the decision its options");
		const clean = [...new Set(given.flatMap(splitPicks).map((r) => asOption(r, "recommended")))];
		if (pick === "one" && clean.length > 1) throw new Error('recommend one option, or set pick "many" to let several be ticked');
		out.recommended = clean.length ? JSON.stringify(clean) : "";
	}
	if (out.default_answer !== undefined) {
		const raw = out.default_answer;
		const none = typeof raw === "string" && /^none( of them)?$/i.test(raw.trim());
		if (kind === "decision" && options.length && pick === "many") {
			// [] (or "none of them") is a default: nothing gets picked. '' is no default at all.
			const given = none ? [] : listArg(raw).flatMap(splitPicks);
			const empty = !none && !given.length && !(Array.isArray(raw) || String(raw).trim().startsWith("["));
			out.default_answer = empty ? "" : JSON.stringify([...new Set(given.map((d) => asOption(d, "default")))]);
		} else if (kind === "decision" && options.length) {
			const given = listArg(raw);
			if (given.length > 1) throw new Error('a default is one option, unless pick is "many"');
			out.default_answer = given.length ? asOption(given[0], "default") : "";
		} else out.default_answer = (Array.isArray(raw) ? raw.join("; ") : String(raw)).trim();
		if (out.default_answer && !DEFAULT_KINDS.includes(kind))
			throw new Error(`only decisions, reviews and notices take a default; a ${kind} waits until it's done`);
	}
	if (out.decide_by !== undefined && out.decide_by !== before?.decide_by) out.decide_by = parseDecideBy(out.decide_by);
	if (out.decide_by && !DEFAULT_KINDS.includes(kind)) throw new Error(`only decisions, reviews and notices take a deadline; a ${kind} waits until it's done`);
	// A deadline by itself, when the agent gives none.
	const after = { kind, default_answer: out.default_answer ?? before?.default_answer ?? "" } as Item;
	const gained = !before || (!before.default_answer && !!after.default_answer) || (kind === "notice" && before.kind !== "notice");
	const owner = out.owner ?? before?.owner;
	if (gained && goesAhead(after) && owner === "kostas" && out.decide_by === undefined && !before?.decide_by) {
		const days = askDays(db);
		if (days) out.decide_by = sqlTime(new Date(Date.now() + days * 86400e3));
	}
	return out;
}

/** The history's words for changed ask fields (updateItem). */
export function askChanges(before: Item, patch: Partial<Item>, fields: readonly string[]): string[] {
	const after = { ...before, ...patch };
	const out: string[] = [];
	if (fields.includes("pick")) out.push(after.pick === "many" ? "pick: several" : "pick: one");
	if (fields.includes("recommended")) out.push(`recommended: ${itemRecommended(after).join(" | ") || "—"}`);
	if (fields.includes("default_answer")) out.push(`default: ${defaultText(after) || "—"}`);
	if (fields.includes("decide_by")) out.push(`deadline: ${after.decide_by ? dayLabel(after.decide_by) : "none"}`);
	return out;
}

/* ---------- Ending an ask ---------- */

export type How =
	/** Kostas's answer: an option (or its number), his own words, or for pick many a list ("1, 3", [] = none of them). */
	| { answer: string | string[] }
	/** Got it (a notice) or No objections (a review): closes it. */
	| { ack: true }
	/** His objection, in his words: back to the agent as a to-do. */
	| { object: string }
	/** The deadline passed with no answer: the default goes ahead. Only if it's still due at `now`. */
	| { lapsed: true; now?: Date };

/** What an answer stores: `answer` stays readable text; a pick-many answer also keeps the list in `picks`. */
function readAnswer(i: Item, given: string | string[]): { answer: string; picks?: string } {
	const options = itemOptions(i);
	const option = (s: string) => {
		const t = s.trim();
		if (/^\d+$/.test(t) && !options.includes(t) && options[Number(t) - 1]) return options[Number(t) - 1];
		return options.includes(t) ? t : undefined;
	};
	if (i.pick === "many" && options.length) {
		const none = !Array.isArray(given) && /^none( of them)?$/i.test(given.trim());
		const raw = none ? [] : Array.isArray(given) ? given.map(String) : splitPicks(given);
		const mapped = raw.filter((s) => s.trim()).map(option);
		if (mapped.every(Boolean)) {
			if (!mapped.length && !none && !Array.isArray(given)) throw new Error("empty answer");
			const picks = [...new Set(mapped as string[])];
			return { answer: picks.length ? picks.join("; ") : "None of them", picks: JSON.stringify(picks) };
		}
		// Words of his own, rather than a set of options.
		const text = (Array.isArray(given) ? given.join("; ") : given).trim();
		if (Array.isArray(given) && given.length > 1) throw new Error(`"${raw[mapped.indexOf(undefined)]}" isn't one of the options: ${options.join(" | ")}`);
		return { answer: text, picks: "" };
	}
	const text = (Array.isArray(given) ? given.join("; ") : given).trim();
	if (!text) throw new Error("empty answer");
	return { answer: option(text) ?? text };
}

const isDue = (i: Item, now: Date) =>
	i.owner === "kostas" && OPEN.includes(i.status) && !!i.decide_by && i.decide_by <= sqlTime(now) && goesAhead(i);

/**
 * Ends an ask, the one way every path does: the board's buttons, `wb answer`, answer_decision, and the default at
 * its deadline. A decision's answer goes back to the agent to act on; Got it closes a notice (No objections, a
 * review); an objection goes back to the agent as a to-do with his words in the history. The deadline is cleared.
 * Returns the item as it is now, or undefined when `lapsed` found it no longer due (answered meanwhile).
 */
export function resolveAsk(db: Db, id: number, how: How, author = "kostas") {
	return db
		.transaction(() => {
			const i = getItem(db, id);
			if (!i) throw new Error(`no item #${id}`);
			const back = { owner: "agent" as const, status: i.status === "doing" ? ("doing" as const) : ("todo" as const) };
			if ("answer" in how) {
				updateItem(db, id, { ...readAnswer(i, how.answer), ...back }, author);
			} else if ("ack" in how) {
				if (i.kind !== "notice" && i.kind !== "review") throw new Error(`${i.kind === "decision" ? "answer a decision" : `mark the ${i.kind} done`} instead`);
				addNote(db, id, i.kind === "review" ? "No objections" : "Got it", author);
				updateItem(db, id, { status: "done" }, author);
			} else if ("object" in how) {
				const text = how.object.trim();
				if (!text) throw new Error("say what you object to");
				addNote(db, id, `Objection: ${text}`, author);
				updateItem(db, id, { ...back, status: "todo" }, author);
			} else {
				if (!isDue(i, how.now ?? new Date())) return undefined;
				const when = dayLabel(i.decide_by!);
				const what = defaultText(i);
				addNote(db, id, what ? `No answer by ${when}: went ahead with ${what}` : `No answer by ${when}: closed as seen`, author);
				if (i.kind === "decision") {
					let a: { answer: string; picks?: string };
					try {
						a = readAnswer(i, i.pick === "many" && i.default_answer.startsWith("[") ? jsonList(i.default_answer) : i.default_answer);
					} catch {
						// The options changed since the default was set: it still goes ahead, in its own words.
						a = { answer: what };
					}
					updateItem(db, id, { ...a, ...back }, author);
				} else updateItem(db, id, { status: "done" }, author);
			}
			db.query("UPDATE items SET decide_by = NULL WHERE id = ?").run(id);
			return getItem(db, id)!;
		})
		.immediate();
}

/**
 * Lets every default whose deadline has passed go ahead. The board runs it every minute; `wb` and the MCP server
 * run it before they read or change items, so it happens even with the board off. Returns the refs it resolved.
 */
export function applyDue(db: Db, now = new Date()): string[] {
	const done: string[] = [];
	let due: { id: number; ref: string }[];
	try {
		due = db
			.query(
				`SELECT id, ref FROM items WHERE owner = 'kostas' AND status IN ('todo', 'doing', 'waiting') AND decide_by IS NOT NULL
				AND decide_by <= ? AND kind IN ('decision', 'review', 'notice') AND (default_answer != '' OR kind = 'notice')`,
			)
			.all(sqlTime(now)) as { id: number; ref: string }[];
	} catch {
		return done;
	}
	for (const { id, ref } of due)
		try {
			if (resolveAsk(db, id, { lapsed: true, now }, "board")) done.push(ref);
		} catch (e) {
			console.error(`wb-${ref}: its default didn't go ahead: ${(e as Error).message}`);
		}
	return done;
}

/* ---------- The cap ---------- */

/** Open asks for Kostas in a project that agents filed (who filed it: the item's first history line). */
export function openAsksFromAgents(db: Db, project: string): number {
	return (
		db
			.query(
				`SELECT COUNT(*) AS n FROM items i WHERE i.project = ? AND i.owner = 'kostas' AND i.status IN ('todo', 'doing', 'waiting')
				AND i.kind IN (${CAPPED_KINDS.map((k) => `'${k}'`).join(", ")})
				AND (SELECT author FROM notes n WHERE n.item_id = i.id ORDER BY n.id LIMIT 1) = 'agent'`,
			)
			.get(project) as { n: number }
	).n;
}

/**
 * Why an agent may not file this ask now, or undefined when it may: the project already has `asks.cap` open asks
 * from agents (Settings → You and your day, 20 unless changed; 0 = no cap). Notices, agents' own work and priority 1
 * always get through, and Kostas's own items are never counted or capped (callers only ask for agents).
 */
export function capRefusal(db: Db, a: { project: string; kind: string; owner: string; priority?: number }): string | undefined {
	const cap = askCap(db);
	if (!cap || a.owner !== "kostas" || !CAPPED_KINDS.includes(a.kind) || Number(a.priority) === 1) return undefined;
	const n = openAsksFromAgents(db, a.project);
	if (n < cap) return undefined;
	const name = yourName(db);
	return `${a.project} already has ${n} open asks from agents waiting on ${name}, and the board takes at most ${cap} (Settings → You and your day). Nothing was filed. Instead:
- Bundle related questions into one decision with pick "many": ${name} ticks the ones they want, in one go.
- If nothing needs ${name}'s decision, file a notice (kind notice): what changed and what stays if they say nothing. It doesn't wait on them.
- Decide it yourself with a safe default, and say what you chose in a notice, so ${name} can still object.
- Or drop one of the open asks that no longer matters (list them with owner kostas).
Priority 1 (a launch blocker) still gets through.`;
}
