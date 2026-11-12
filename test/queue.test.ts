// Queue mode (queue.ts): the order, similar asks together, notices last, deferring, giving back, the summary.
import { describe, expect, test } from "bun:test";
import { addItem, getItem, updateItem } from "../db";
import { needsKostas, sqlTime } from "../asks";
import { addGoal } from "../goals";
import { waitOn } from "../links";
import { briefOpening, buildQueue, checkSteps, deferItem, GIVE_BACK, giveBack, MAX_GROUP, parseDeferUntil } from "../queue";
import { freshDb } from "./helpers";

type Db = ReturnType<typeof freshDb>;
const BRIEF = "What this is about, in a sentence or two, so it makes sense by itself.";
const ask = (db: Db, title: string, more: Record<string, unknown> = {}) =>
	addItem(db, { title, project: "demo", kind: "decision", owner: "kostas", body: BRIEF, ...more }, "agent");
// Items made in one test share a second: give them distinct ages, oldest first.
const age = (db: Db, id: number, days: number) =>
	db.query("UPDATE items SET created_at = ? WHERE id = ?").run(sqlTime(new Date(Date.now() - days * 86400e3)), id);
const titles = (db: Db, project = "") => buildQueue(db, { project }).items.map((i) => i.title);
const notes = (db: Db, id: number) => getItem(db, id)!.notes.map((n) => n.text);

describe("the order", () => {
	test("P1, then what unblocks most, then the active goal, then deadlines soon, then the oldest", () => {
		const db = freshDb();
		const old = ask(db, "Name the release");
		age(db, old, 9);
		const newer = ask(db, "Word the welcome screen");
		age(db, newer, 2);
		const p1 = ask(db, "Launch blocker", { priority: 1 });
		const blocker = ask(db, "Holds up two tasks");
		for (const t of ["Build A", "Build B"]) waitOn(db, addItem(db, { title: t, project: "demo", kind: "task", owner: "agent" }, "agent"), [blocker], "agent");
		const g = addGoal(db, { project: "demo", title: "First release", active: true });
		const goal = ask(db, "Serves the goal", { goal_id: g.id });
		const soon = ask(db, "Goes ahead tomorrow", { default_answer: "Yes", decide_by: "in 1 day" });
		const later = ask(db, "Choose the icon set", { default_answer: "Yes", decide_by: "in 30 days" });
		age(db, later, 1);
		const p3 = ask(db, "Some day", { priority: 3 });
		age(db, p3, 20);
		expect(titles(db)).toEqual([
			"Launch blocker",
			"Holds up two tasks",
			"Serves the goal",
			"Goes ahead tomorrow",
			"Name the release",
			"Word the welcome screen",
			"Choose the icon set",
			"Some day",
		]);
		expect(buildQueue(db).items.find((i) => i.id === blocker)!.unblocks).toBe(2);
		expect(buildQueue(db).items.find((i) => i.id === goal)!.goal).toMatchObject({ goal: "First release", rank: 1, active: true });
		void [p1, soon];
	});

	test("only what's Kostas's and open; notices after the asks and not counted as asks", () => {
		const db = freshDb();
		addItem(db, { title: "FYI: renamed Export", project: "demo", kind: "notice", body: BRIEF }, "agent");
		ask(db, "Pick a colour");
		addItem(db, { title: "Agent's own task", project: "demo", kind: "task", owner: "agent" }, "agent");
		const done = ask(db, "Already answered");
		updateItem(db, done, { status: "done" });
		const q = buildQueue(db);
		expect(q.items.map((i) => i.title)).toEqual(["Pick a colour", "FYI: renamed Export"]);
		expect([q.asks, q.notices]).toEqual([1, 1]);
		expect(q.items.map((i) => i.notice)).toEqual([false, true]);
	});

	test("a project, or every active one", () => {
		const db = freshDb();
		db.query("INSERT INTO projects (slug, name, path) VALUES ('other', 'Other', '/tmp/other'), ('old', 'Old', '/tmp/old')").run();
		ask(db, "In demo");
		addItem(db, { title: "In other", project: "other", kind: "review", owner: "kostas", body: BRIEF }, "agent");
		addItem(db, { title: "In an archived one", project: "old", kind: "review", owner: "kostas", body: BRIEF }, "agent");
		db.query("UPDATE projects SET archived_at = datetime('now') WHERE slug = 'old'").run();
		expect(titles(db, "demo")).toEqual(["In demo"]);
		expect(titles(db).sort()).toEqual(["In demo", "In other"]);
	});
});

describe("similar asks together", () => {
	test("same area, or titles alike, come right after the first; the group says so", () => {
		const db = freshDb();
		const ids = [
			ask(db, "Choose the fasting rule for Wednesdays", { area: "fasting" }),
			ask(db, "Decide which tab extras to build"),
			ask(db, "Pick the export file name"),
			ask(db, "Decide which menu extras to build"),
			ask(db, "Confirm the fish days", { area: "fasting" }),
		];
		ids.forEach((id, i) => age(db, id, 10 - i));
		const q = buildQueue(db).items;
		expect(q.map((i) => i.title)).toEqual([
			"Choose the fasting rule for Wednesdays",
			"Confirm the fish days",
			"Decide which tab extras to build",
			"Decide which menu extras to build",
			"Pick the export file name",
		]);
		expect(q[0].group).toMatchObject({ size: 2, at: 1, why: "fasting" });
		expect(q[1].group).toMatchObject({ size: 2, at: 2, why: "fasting" });
		expect(q[2].group).toMatchObject({ size: 2, at: 1, why: "similar titles" });
		expect(q[0].group!.id).not.toBe(q[2].group!.id);
		expect(q[4].group).toBeNull();
	});

	test("P1 groups only with P1, and a group holds at most MAX_GROUP", () => {
		const db = freshDb();
		const first = ask(db, "Urgent sync question", { area: "sync", priority: 1 });
		age(db, first, 30);
		for (let i = 0; i < MAX_GROUP + 2; i++) age(db, ask(db, `Sync question ${i}`, { area: "sync" }), 20 - i);
		const q = buildQueue(db).items;
		expect(q[0].title).toBe("Urgent sync question");
		expect(q[0].group).toBeNull();
		expect(q[1].group).toMatchObject({ size: MAX_GROUP, at: 1 });
		expect(q[MAX_GROUP].group).toMatchObject({ size: MAX_GROUP, at: MAX_GROUP });
		expect(q[MAX_GROUP + 1].group).toMatchObject({ size: 2, at: 1 });
	});
});

describe("deferring", () => {
	test("a deferred item leaves the queue until its day, still waits on Kostas, and says so in its history", () => {
		const db = freshDb();
		const a = ask(db, "Later please");
		ask(db, "Now");
		const i = deferItem(db, a, "tomorrow");
		expect(i.deferred_until).toBeTruthy();
		expect(needsKostas(i)).toBe(true);
		const q = buildQueue(db);
		expect(q.items.map((x) => x.title)).toEqual(["Now"]);
		expect(q.deferred).toMatchObject([{ id: a, title: "Later please", until: i.deferred_until }]);
		expect(notes(db, a).at(-1)).toMatch(/^Deferred until \w{3} \d{1,2} \w{3}$/);
		// Its day comes: back in the queue by itself.
		db.query("UPDATE items SET deferred_until = ? WHERE id = ?").run(sqlTime(new Date(Date.now() - 60e3)), a);
		expect(titles(db).sort()).toEqual(["Later please", "Now"]);
	});

	test('"none" brings it back now; only open items of Kostas\'s', () => {
		const db = freshDb();
		const a = ask(db, "Later please");
		deferItem(db, a, "in 3 days");
		expect(deferItem(db, a, "none").deferred_until).toBeNull();
		expect(notes(db, a).at(-1)).toBe("Back in the queue");
		expect(titles(db)).toEqual(["Later please"]);
		const t = addItem(db, { title: "Agent work", project: "demo", kind: "task", owner: "agent" }, "agent");
		expect(() => deferItem(db, t, "tomorrow")).toThrow(/with the agent/);
		updateItem(db, a, { status: "done" });
		expect(() => deferItem(db, a, "tomorrow")).toThrow(/done/);
	});

	test("defer takes tomorrow, next week, in N days, a date; the start of that day, never the past", () => {
		const now = new Date(2026, 10, 12, 15, 30); // a Thursday
		expect(parseDeferUntil("tomorrow", now)).toBe(sqlTime(new Date(2026, 10, 13)));
		expect(parseDeferUntil("next week", now)).toBe(sqlTime(new Date(2026, 10, 16)));
		expect(parseDeferUntil("in 3 days", now)).toBe(sqlTime(new Date(2026, 10, 15)));
		expect(parseDeferUntil("2026-11-20", now)).toBe(sqlTime(new Date(2026, 10, 20)));
		expect(parseDeferUntil("none", now)).toBeNull();
		expect(() => parseDeferUntil("2026-11-12", now)).toThrow(/passed/);
		expect(() => parseDeferUntil("whenever", now)).toThrow(/tomorrow/);
	});
});

describe("giving back", () => {
	test("back to the agent as a to-do with Kostas's line; its deadline and deferral go", () => {
		const db = freshDb();
		const a = ask(db, "Which icon?", { options: ["Round", "Square"], default_answer: "Round", decide_by: "in 2 days" });
		deferItem(db, a, "tomorrow");
		const i = giveBack(db, a, "  Your call, keep it consistent  ");
		expect([i.owner, i.status, i.decide_by, i.deferred_until]).toEqual(["agent", "todo", null, null]);
		expect(notes(db, a).at(-1)).toBe("Given back to the agent: Your call, keep it consistent");
		expect(titles(db)).toEqual([]);
		const b = ask(db, "Which font?");
		giveBack(db, b);
		expect(notes(db, b).at(-1)).toBe(`Given back to the agent: ${GIVE_BACK}`);
		expect(() => giveBack(db, b)).toThrow(/already/);
	});
});

describe("the summary", () => {
	test("the first paragraph, headings and pictures skipped; more when the brief goes on", () => {
		expect(briefOpening("")).toEqual({ summary: "", more: false });
		expect(briefOpening("Short and whole.")).toEqual({ summary: "Short and whole.", more: false });
		expect(briefOpening("## Why\n\n![shot](/x.png)\n\nThe opening.\n\nThe rest.")).toEqual({ summary: "The opening.", more: true });
		expect(briefOpening("## Why\nThe opening under its heading.")).toEqual({ summary: "The opening under its heading.", more: false });
	});
	test("a long paragraph is cut at a sentence, or at a word with an ellipsis", () => {
		const long = `${"One sentence that says a fair amount about the thing. ".repeat(4)}And then a very long one ${"that keeps going ".repeat(20)}.`;
		const s = briefOpening(long).summary;
		expect(s.length).toBeLessThanOrEqual(300);
		expect(s.endsWith("thing.")).toBe(true);
		const words = briefOpening("word ".repeat(200)).summary;
		expect(words.endsWith("…")).toBe(true);
		expect(words.length).toBeLessThanOrEqual(300);
	});
	test("a check's steps are its first list", () => {
		expect(checkSteps("Try it on the phone.\n\n1. Open the app\n2. Tap **Sync**\n   - it spins\n3. See the list\n\nIf it fails, say how.\n\n- not a step")).toEqual([
			"Open the app",
			"Tap **Sync**",
			"See the list",
		]);
		const db = freshDb();
		addItem(db, { title: "Try sync", project: "demo", kind: "check", owner: "kostas", body: "Steps:\n\n- Open it\n- Sync" }, "agent");
		expect(buildQueue(db).items[0].steps).toEqual(["Open it", "Sync"]);
	});
});
