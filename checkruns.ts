/**
 * Running a check on a device, one step at a time (wb-28cb). A check's brief is cut into steps (the numbered list);
 * each step gets Pass or Fail, a few words and photos, saved on the server as it goes, so a run started on the phone
 * can be finished at the desk. Finishing closes the check (everything passed) or files a bug per failed step and
 * makes the check wait on them (links.ts), so it comes back to Kostas's to-do once they are done.
 *
 * Tables (additive): `check_runs` (one row per step of a run), `check_run_log` (one row per run: when it started
 * and finished, the outcome). The newest run of an item is its current one; a finished run stays as history until
 * the item is back to todo and someone starts again (or "Start over" on a finished run).
 */
import { addItem, addNote, getItem, updateItem, type Db, type Item } from "./db";
import { addImage, imageData, imageInfo, removeImage, setImageCaption } from "./images";
import { waitOn } from "./links";
import { yourName } from "./settings";

export function createCheckRunTables(db: Db) {
	db.run(`CREATE TABLE IF NOT EXISTS check_run_log (
		item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
		run INTEGER NOT NULL,
		started_at TEXT NOT NULL DEFAULT (datetime('now')),
		finished_at TEXT,
		outcome TEXT NOT NULL DEFAULT '',
		bugs TEXT NOT NULL DEFAULT '[]',
		PRIMARY KEY (item_id, run)
	)`);
	db.run(`CREATE TABLE IF NOT EXISTS check_runs (
		item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
		run INTEGER NOT NULL,
		step INTEGER NOT NULL,
		result TEXT NOT NULL DEFAULT '',
		words TEXT NOT NULL DEFAULT '',
		images TEXT NOT NULL DEFAULT '[]',
		step_text TEXT NOT NULL DEFAULT '',
		device TEXT NOT NULL DEFAULT '',
		at TEXT NOT NULL DEFAULT (datetime('now')),
		PRIMARY KEY (item_id, run, step)
	)`);
}

/* ---------- Cutting a brief into steps ---------- */

export type Step = {
	/** 1-based. */
	n: number;
	/** The step's first line, markdown, without its number. */
	title: string;
	/** The rest of it (nested bullets and so on), markdown, dedented. */
	detail: string;
	/** The heading above its list, when the brief has more than one numbered list ("Setup", "What to check"). */
	group?: string;
};
export type ParsedCheck = { steps: Step[]; right: string; wrong: string; numbered: boolean };

const NUMBERED = /^(\s{0,3})(\d+)[.)]\s+(.*)$/;
const HEADING = /^\s{0,3}#{1,6}\s/;
const FENCE = /^\s*```/;
const MARKER = /^(?:what\s+)?(right|wrong)(?:\s+(?:looks?\s+)?like)?\s*(?::\s*(.*))?$/i;
const indentOf = (s: string) => s.replace(/\t/g, "    ").match(/^ */)![0].length;

/** A line as a plain label: no #, no bold, no trailing colon. */
const plain = (s: string) => s.trim().replace(/^#{1,6}\s+/, "").replace(/\*\*|__/g, "").replace(/[:：]\s*$/, "").trim();
/** `**Wrong looks like:** text` → ["wrong", "text"]; only at the top level of the brief. */
function marker(line: string): { which: "right" | "wrong"; rest: string } | undefined {
	if (indentOf(line) > 1 || /^\s*([-*+]|\d+[.)])\s/.test(line)) return undefined;
	const t = line.trim().replace(/^#{1,6}\s+/, "").replace(/\*\*|__/g, "");
	const m = t.match(MARKER);
	return m ? { which: m[1].toLowerCase() as "right" | "wrong", rest: (m[2] ?? "").trim() } : undefined;
}
const dedent = (lines: string[]) => {
	const min = Math.min(...lines.filter((l) => l.trim()).map(indentOf));
	return (Number.isFinite(min) ? lines.map((l) => l.replace(/\t/g, "    ").slice(Math.min(min, indentOf(l)))) : lines).join("\n").trim();
};

/** A step's first few words, as plain text (for captions and notes). */
export function firstWords(s: string, n = 6): string {
	const t = s
		.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/[`*_]/g, "")
		.replace(/\s+/g, " ")
		.trim();
	const w = t.split(" ");
	return w.length > n ? `${w.slice(0, n).join(" ")}…` : t;
}

/**
 * The first numbered list is the steps (nested bullets and paragraphs stay with their step). A brief with more than
 * one numbered list (a "Setup" list and a "What to check" list) is all of them, each step carrying the heading
 * above its list. No numbered list: one step, the whole brief. "What right looks like" and "What wrong looks like"
 * (as a heading, a bold line or "Wrong: …") are kept apart, to show with the steps.
 */
export function parseCheck(body: string, title = ""): ParsedCheck {
	const lines = String(body ?? "").replace(/\r/g, "").split("\n");
	const steps: Step[] = [];
	const sections = { right: "", wrong: "" };
	let group = "";
	let label = "";
	let listNo = 0;
	const listOf: number[] = [];
	let inList = false;
	let fence = false;
	let i = 0;
	const nextNonBlank = (from: number) => {
		let j = from;
		while (j < lines.length && !lines[j].trim()) j++;
		return j;
	};
	while (i < lines.length) {
		const line = lines[i];
		if (FENCE.test(line)) fence = !fence;
		if (fence) { i++; continue; }
		const mk = marker(line);
		if (mk) {
			// The section runs to a heading, another marker, a numbered item, or a blank line and then plain text.
			const body: string[] = mk.rest ? [mk.rest] : [];
			let j = i + 1;
			for (; j < lines.length; j++) {
				const l = lines[j];
				if (HEADING.test(l) || marker(l) || NUMBERED.test(l)) break;
				if (!l.trim()) {
					const k = nextNonBlank(j);
					if (k >= lines.length || (body.length && indentOf(lines[k]) === 0 && !/^\s*[-*+]\s/.test(lines[k]))) break;
					if (!body.length) continue;
				}
				body.push(l);
			}
			const text = dedent(body);
			sections[mk.which] = sections[mk.which] ? `${sections[mk.which]}\n\n${text}` : text;
			i = j;
			inList = false;
			continue;
		}
		const m = line.match(NUMBERED);
		if (m) {
			if (!inList) {
				listNo++;
				group = label;
			}
			inList = true;
			const base = indentOf(line);
			const rest: string[] = [];
			let j = i + 1;
			let f = false;
			for (; j < lines.length; j++) {
				const l = lines[j];
				if (FENCE.test(l)) f = !f;
				if (f || FENCE.test(l)) { rest.push(l); continue; }
				if (!l.trim()) {
					const k = nextNonBlank(j);
					if (k < lines.length && (indentOf(lines[k]) > base || (NUMBERED.test(lines[k]) && indentOf(lines[k]) === base))) { rest.push(l); continue; }
					break;
				}
				if (indentOf(l) > base) { rest.push(l); continue; }
				if (NUMBERED.test(l) || HEADING.test(l) || marker(l) || /^\s*>/.test(l) || /^\s*[-*+]\s/.test(l)) break;
				if (lines[j - 1]?.trim()) { rest.push(l); continue; }
				break;
			}
			steps.push({ n: steps.length + 1, title: m[3].trim(), detail: dedent(rest), group: group || undefined });
			listOf.push(listNo);
			i = j;
			continue;
		}
		if (line.trim()) {
			// What sits above a list names it: a heading, or a line that is only bold.
			const t = line.trim();
			if (HEADING.test(line) || /^\*\*[^*]+\*\*:?$/.test(t) || /^__[^_]+__:?$/.test(t)) label = plain(line);
			inList = false;
		} else if (inList && lines[nextNonBlank(i)] && !NUMBERED.test(lines[nextNonBlank(i)] ?? "")) inList = false;
		i++;
	}
	if (new Set(listOf).size < 2) for (const s of steps) delete s.group;
	if (!steps.length) {
		return {
			steps: [{ n: 1, title: title.trim() || "The check", detail: String(body ?? "").trim() }],
			right: sections.right,
			wrong: sections.wrong,
			numbered: false,
		};
	}
	return { steps, right: sections.right, wrong: sections.wrong, numbered: true };
}

/* ---------- A run, saved as it goes ---------- */

export type StepResult = {
	step: number;
	n: number;
	title: string;
	group?: string;
	result: "" | "pass" | "fail";
	words: string;
	images: { id: number; caption: string; width: number; height: number }[];
	device: string;
	at: string;
};
export type RunBug = { id: number; ref: string; title: string; step: number };
export type RunState = {
	item: { id: number; ref: string; title: string; kind: string; status: string; project: string };
	steps: Step[];
	right: string;
	wrong: string;
	/** The run in view: its number, results per step, and whether it ended. */
	run: number;
	started: boolean;
	finished: boolean;
	outcome: "" | "passed" | "failed";
	finished_at: string | null;
	results: StepResult[];
	bugs: RunBug[];
	summary: string;
};

type LogRow = { run: number; started_at: string; finished_at: string | null; outcome: string; bugs: string };
type Row = { step: number; result: string; words: string; images: string; step_text: string; device: string; at: string };

const checkItem = (db: Db, id: number): Item => {
	const i = db.query("SELECT * FROM items WHERE id = ?").get(id) as Item | null;
	if (!i) throw new Error(`no item #${id}`);
	if (i.kind !== "check") throw new Error(`wb-${i.ref} isn't a check`);
	return i;
};
const latestLog = (db: Db, id: number) => db.query("SELECT * FROM check_run_log WHERE item_id = ? ORDER BY run DESC LIMIT 1").get(id) as LogRow | null;

/**
 * The run that results go into. After a finished run, a check that is open again (its bugs are fixed and it
 * came back to todo) starts a new one; a finished check that stays closed or waiting shows its last run.
 */
function currentRun(db: Db, item: Item, create = false): LogRow | null {
	let log = latestLog(db, item.id);
	if (log?.finished_at && item.status === "todo") log = null;
	return !log && create ? newRun(db, item.id) : log;
}
function newRun(db: Db, id: number): LogRow {
	const next = ((db.query("SELECT MAX(run) AS n FROM check_run_log WHERE item_id = ?").get(id) as { n: number | null }).n ?? 0) + 1;
	db.query("INSERT INTO check_run_log (item_id, run) VALUES (?, ?)").run(id, next);
	return latestLog(db, id)!;
}

const rowsOf = (db: Db, id: number, run: number) =>
	db.query("SELECT step, result, words, images, step_text, device, at FROM check_runs WHERE item_id = ? AND run = ? ORDER BY step").all(id, run) as Row[];
const idList = (s: string): number[] => {
	try {
		const l = JSON.parse(s);
		return Array.isArray(l) ? l.map(Number).filter(Number.isFinite) : [];
	} catch {
		return [];
	}
};

function resultsOf(db: Db, steps: Step[], rows: Row[]): StepResult[] {
	return steps.map((s) => {
		const r = rows.find((x) => x.step === s.n - 1);
		const images = idList(r?.images ?? "[]").flatMap((id) => {
			const m = imageInfo(db, id);
			return m ? [{ id: m.id, caption: m.caption, width: m.width, height: m.height }] : [];
		});
		return { step: s.n - 1, n: s.n, title: s.title, group: s.group, result: (r?.result ?? "") as StepResult["result"], words: r?.words ?? "", images, device: r?.device ?? "", at: r?.at ?? "" };
	});
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const devicesOf = (rows: Row[]) => [...new Set(rows.map((r) => r.device).filter(Boolean))];

/** "All 6 steps passed on Safari on iPhone". */
function passedSummary(steps: number, rows: Row[]) {
	const d = devicesOf(rows);
	return `All ${plural(steps, "step")} passed on ${d.length ? d.join(" and ") : "the phone"}`;
}

export function runState(db: Db, id: number): RunState {
	const item = checkItem(db, id);
	const parsed = parseCheck(item.body, item.title);
	const log = currentRun(db, item);
	const rows = log ? rowsOf(db, id, log.run) : [];
	const results = resultsOf(db, parsed.steps, rows);
	const finished = !!log?.finished_at;
	const bugs = finished ? (JSON.parse(log!.bugs || "[]") as RunBug[]) : [];
	const failed = results.filter((r) => r.result === "fail").length;
	return {
		item: { id: item.id, ref: item.ref, title: item.title, kind: item.kind, status: item.status, project: item.project },
		steps: parsed.steps,
		right: parsed.right,
		wrong: parsed.wrong,
		run: log?.run ?? 0,
		started: results.some((r) => r.result || r.images.length || r.words),
		finished,
		outcome: finished ? (log!.outcome as "passed" | "failed") : "",
		finished_at: log?.finished_at ?? null,
		results,
		bugs,
		summary: finished ? (log!.outcome === "passed" ? passedSummary(parsed.steps.length, rows) : `${plural(failed, "step")} failed`) : "",
	};
}

function stepOf(db: Db, item: Item, step: number) {
	const parsed = parseCheck(item.body, item.title);
	const s = parsed.steps[step];
	if (!s) throw new Error(`wb-${item.ref} has no step ${step + 1}`);
	return { parsed, s };
}

const caption = (s: Step, result: string, words: string) =>
	`Step ${s.n}: ${firstWords(s.title)}${result === "fail" ? ` — failed${words ? `: ${words.replace(/\s+/g, " ").trim().slice(0, 160)}` : ""}` : ""}`;

function saveRow(db: Db, item: Item, run: number, s: Step, patch: Partial<Row>, device: string) {
	const old = db.query("SELECT * FROM check_runs WHERE item_id = ? AND run = ? AND step = ?").get(item.id, run, s.n - 1) as Row | null;
	const row = { result: "", words: "", images: "[]", ...old, ...patch };
	db.query(
		`INSERT INTO check_runs (item_id, run, step, result, words, images, step_text, device, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
		 ON CONFLICT(item_id, run, step) DO UPDATE SET result = excluded.result, words = excluded.words, images = excluded.images,
		 step_text = excluded.step_text, device = excluded.device, at = excluded.at`,
	).run(item.id, run, s.n - 1, row.result, row.words, row.images, firstWords(s.title, 12), device || old?.device || "");
}

/** Records pass or fail (or "" to clear) with a few words. A fail needs the words or a photo: a bug needs something to go on. */
export function saveStep(db: Db, id: number, step: number, input: { result: string; words?: string }, device = ""): RunState {
	const item = checkItem(db, id);
	if (item.status === "done" || item.status === "dropped") throw new Error(`wb-${item.ref} is ${item.status}`);
	const { s } = stepOf(db, item, step);
	if (!["pass", "fail", ""].includes(input.result)) throw new Error("result is pass or fail");
	const words = String(input.words ?? "").trim().slice(0, 2000);
	const log = currentRun(db, item, true)!;
	if (log.finished_at) throw new Error("this run is finished: start over to run it again");
	const old = db.query("SELECT images FROM check_runs WHERE item_id = ? AND run = ? AND step = ?").get(id, log.run, step) as { images: string } | null;
	const imgs = idList(old?.images ?? "[]");
	if (input.result === "fail" && !words && !imgs.length) throw new Error("Say what went wrong, or add a photo");
	saveRow(db, item, log.run, s, { result: input.result, words }, device);
	// The photos say how the step went.
	for (const m of imgs) {
		if (imageInfo(db, m)) setImageCaption(db, m, caption(s, input.result, words), "kostas");
	}
	return runState(db, id);
}

/** A photo for a step: shrunk like any picture on an item, captioned with the step, kept in the run. */
export function addStepPhoto(db: Db, id: number, step: number, image: Parameters<typeof addImage>[2], device = ""): RunState {
	const item = checkItem(db, id);
	if (item.status === "done" || item.status === "dropped") throw new Error(`wb-${item.ref} is ${item.status}`);
	const { s } = stepOf(db, item, step);
	const log = currentRun(db, item, true)!;
	if (log.finished_at) throw new Error("this run is finished: start over to run it again");
	const row = db.query("SELECT result, words, images FROM check_runs WHERE item_id = ? AND run = ? AND step = ?").get(id, log.run, step) as Pick<Row, "result" | "words" | "images"> | null;
	const imgId = addImage(db, id, image, caption(s, row?.result ?? "", row?.words ?? ""), "kostas");
	saveRow(db, item, log.run, s, { images: JSON.stringify([...idList(row?.images ?? "[]"), imgId]) }, device);
	return runState(db, id);
}

export function removeStepPhoto(db: Db, id: number, step: number, imageId: number): RunState {
	const item = checkItem(db, id);
	const log = currentRun(db, item);
	const row = log && (db.query("SELECT images FROM check_runs WHERE item_id = ? AND run = ? AND step = ?").get(id, log.run, step) as { images: string } | null);
	if (!log || log.finished_at || !row || !idList(row.images).includes(imageId)) throw new Error("that photo isn't on this step");
	const { s } = stepOf(db, item, step);
	saveRow(db, item, log.run, s, { images: JSON.stringify(idList(row.images).filter((x) => x !== imageId)) }, "");
	removeImage(db, imageId, "kostas");
	return runState(db, id);
}

/** Start over: clears an unfinished run (and its photos); after a finished one, begins a new run. */
export function startOver(db: Db, id: number): RunState {
	checkItem(db, id);
	const log = latestLog(db, id);
	if (log && !log.finished_at) {
		for (const r of rowsOf(db, id, log.run)) for (const m of idList(r.images)) if (imageInfo(db, m)) removeImage(db, m, "kostas");
		db.query("DELETE FROM check_runs WHERE item_id = ? AND run = ?").run(id, log.run);
		db.query("UPDATE check_run_log SET started_at = datetime('now') WHERE item_id = ? AND run = ?").run(id, log.run);
		addNote(db, id, "Check run: started over", "kostas");
	} else if (log) newRun(db, id);
	return runState(db, id);
}

const quote = (s: string) => s.split("\n").map((l) => `> ${l}`).join("\n");

/** What goes in a bug: the step, what should happen, and the words. */
function bugBody(db: Db, item: Item, s: Step, total: number, words: string, right: string, device: string): string {
	const stepMd = [`**Step ${s.n} of ${total}:** ${s.title}`, s.detail].filter(Boolean).join("\n");
	return [
		`Found by running the check wb-${item.ref} (${item.title}) on ${device || "a device"}.`,
		stepMd,
		right ? `**What should happen**\n${right}` : "**What should happen**\nAs the step above says.",
		`**What ${yourName(db) || "Kostas"} saw**\n${words ? quote(words) : "No words: see the photo."}`,
	].join("\n\n");
}

/**
 * Ends the run. All steps passed: the check is done, with a note. Any failed: a bug per failed step (same project,
 * for an agent, with the words and the photos copied on) and the check waits on them, so it comes back to todo by
 * itself when they are finished.
 */
export function finishRun(db: Db, id: number, device = ""): RunState {
	const item = checkItem(db, id);
	const log = currentRun(db, item);
	if (!log || log.finished_at) throw new Error("there's no run in progress");
	const parsed = parseCheck(item.body, item.title);
	const rows = rowsOf(db, id, log.run);
	const open = parsed.steps.filter((s) => !rows.find((r) => r.step === s.n - 1 && r.result));
	if (open.length) throw new Error(`${plural(open.length, "step")} not done yet: ${open.map((s) => s.n).join(", ")}`);
	const failed = parsed.steps.filter((s) => rows.find((r) => r.step === s.n - 1)!.result === "fail");
	if (!failed.length) {
		db.transaction(() => {
			db.query("UPDATE check_run_log SET finished_at = datetime('now'), outcome = 'passed' WHERE item_id = ? AND run = ?").run(id, log.run);
			updateItem(db, id, { status: "done" }, "kostas", passedSummary(parsed.steps.length, rows));
		})();
		return runState(db, id);
	}
	const bugs: RunBug[] = [];
	db.transaction(() => {
		for (const s of failed) {
			const r = rows.find((x) => x.step === s.n - 1)!;
			const bugId = addItem(
				db,
				{
					title: `${item.title}: step ${s.n} fails`,
					kind: "bug",
					owner: "agent",
					project: item.project,
					priority: item.priority,
					area: item.area,
					body: bugBody(db, item, s, parsed.steps.length, r.words, parsed.right, r.device || device),
				},
				"kostas",
			);
			for (const m of idList(r.images)) {
				const img = imageInfo(db, m);
				const data = img && imageData(db, m);
				if (img && data) addImage(db, bugId, { data: new Uint8Array(data.data), type: data.type, width: img.width, height: img.height }, img.caption, "kostas");
			}
			const bug = db.query("SELECT ref, title FROM items WHERE id = ?").get(bugId) as { ref: string; title: string };
			bugs.push({ id: bugId, ref: bug.ref, title: bug.title, step: s.n });
			addNote(db, id, `Step ${s.n} failed: wb-${bug.ref} filed`, "kostas");
		}
		db.query("UPDATE check_run_log SET finished_at = datetime('now'), outcome = 'failed', bugs = ? WHERE item_id = ? AND run = ?").run(JSON.stringify(bugs), id, log.run);
		waitOn(db, id, bugs.map((b) => b.id), "kostas");
	})();
	return runState(db, id);
}

/** The latest run's results with a note on what stands, for agents (get_item). "" when the check was never run. */
export function runText(db: Db, id: number): string {
	const item = db.query("SELECT * FROM items WHERE id = ?").get(id) as Item | null;
	if (!item || item.kind !== "check") return "";
	const log = db.query("SELECT * FROM check_run_log WHERE item_id = ? AND run = (SELECT MAX(run) FROM check_runs WHERE item_id = ?)").get(id, id) as LogRow | null;
	if (!log) return "";
	const rows = rowsOf(db, id, log.run);
	if (!rows.length) return "";
	const parsed = parseCheck(item.body, item.title);
	const total = parsed.steps.length;
	const state = log.finished_at ? (log.outcome === "passed" ? "finished, all passed" : "finished, with failures") : "in progress";
	const lines = [`latest run (${state}):`];
	for (const s of parsed.steps) {
		const r = rows.find((x) => x.step === s.n - 1);
		const imgs = idList(r?.images ?? "[]").length;
		lines.push(`  ${s.n}. ${firstWords(s.title, 10)}: ${r?.result || "not done"}${r?.words ? ` — ${r.words.replace(/\s+/g, " ")}` : ""}${imgs ? ` (${plural(imgs, "photo")})` : ""}`);
	}
	if (total > rows.length && !log.finished_at) lines.push(`  ${total - rows.filter((r) => r.result).length} step${total - rows.filter((r) => r.result).length === 1 ? "" : "s"} still to run`);
	const bugs = JSON.parse(log.bugs || "[]") as RunBug[];
	if (bugs.length) lines.push(`  bugs filed: ${bugs.map((b) => `wb-${b.ref} (step ${b.step})`).join(", ")}`);
	return lines.join("\n");
}

/** The latest run's results as data (get_item), or undefined. */
export function runData(db: Db, id: number) {
	const i = db.query("SELECT kind FROM items WHERE id = ?").get(id) as { kind: string } | null;
	if (i?.kind !== "check") return undefined;
	const log = db.query("SELECT * FROM check_run_log WHERE item_id = ? AND run = (SELECT MAX(run) FROM check_runs WHERE item_id = ?)").get(id, id) as LogRow | null;
	if (!log) return undefined;
	const s = runState(db, id);
	if (s.run !== log.run) {
		// A fresh run was opened after the finished one: report the finished one.
		const item = getItem(db, id)!;
		const parsed = parseCheck(item.body, item.title);
		const results = resultsOf(db, parsed.steps, rowsOf(db, id, log.run));
		return { run: log.run, finished: !!log.finished_at, outcome: log.outcome || undefined, steps: results.map((r) => ({ step: r.n, title: firstWords(r.title, 12), result: r.result || "not done", words: r.words || undefined, photos: r.images.length || undefined })) };
	}
	return { run: s.run, finished: s.finished, outcome: s.outcome || undefined, steps: s.results.map((r) => ({ step: r.n, title: firstWords(r.title, 12), result: r.result || "not done", words: r.words || undefined, photos: r.images.length || undefined })), bugs: s.bugs.length ? s.bugs.map((b) => `wb-${b.ref}`) : undefined };
}
