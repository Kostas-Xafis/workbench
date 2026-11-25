// The Today brief: what agents finished (with the finishing note), reports updated, and the brief as text.
import { describe, expect, test } from "bun:test";
import { addItem, addNote, addProject, publishReport, updateItem } from "../src/db";
import { briefText, firstLine, sinceTime, todayData } from "../src/today";
import { freshDb } from "./helpers";

const ago = (h: number) => new Date(Date.now() - h * 3600e3).toISOString();

describe("sinceTime", () => {
	test("takes ISO and database times, else a day ago", () => {
		expect(sinceTime("2026-11-12T08:30:00.000Z")).toBe("2026-11-12 08:30:00");
		expect(sinceTime("2026-11-12 08:30:00")).toBe("2026-11-12 08:30:00");
		const now = new Date("2026-11-12T10:00:00Z");
		expect(sinceTime(undefined, now)).toBe("2026-11-11 10:00:00");
		expect(sinceTime("garbage", now)).toBe("2026-11-11 10:00:00");
	});
});

describe("firstLine", () => {
	test("skips created and field changes, takes the first line of the newest real note", () => {
		expect(firstLine(["status: doing → done", "abc123 on main: fixed it\nmore detail", "created"])).toBe("abc123 on main: fixed it");
		expect(firstLine(["status: doing → done", "created"])).toBe("");
		expect(firstLine(["x".repeat(300)]).length).toBe(200);
	});
});

describe("todayData", () => {
	test("done by agents since, with the note; not Kostas's items, not older ones, not other projects", () => {
		const db = freshDb();
		addProject(db, { slug: "other", name: "Other", path: "/tmp/other" });
		const a = addItem(db, { project: "demo", title: "Fix the thing", kind: "task", owner: "agent" }, "agent");
		updateItem(db, a, { status: "done" }, "agent");
		addNote(db, a, "deadbee on main: fixed\nlong story", "agent");
		const mine = addItem(db, { project: "demo", title: "Answered", kind: "decision", owner: "kostas" });
		updateItem(db, mine, { status: "done" }, "web");
		const old = addItem(db, { project: "demo", title: "Old work", kind: "task", owner: "agent" });
		updateItem(db, old, { status: "done" });
		db.query("UPDATE items SET done_at = datetime('now', '-3 days') WHERE id = ?").run(old);
		const o = addItem(db, { project: "other", title: "Elsewhere", kind: "task", owner: "agent" });
		updateItem(db, o, { status: "done" });
		const dropped = addItem(db, { project: "demo", title: "Dropped", kind: "task", owner: "agent" });
		updateItem(db, dropped, { status: "dropped" });

		const all = todayData(db, "", ago(24));
		expect(all.done.map((d) => d.title).sort()).toEqual(["Elsewhere", "Fix the thing"]);
		const fix = all.done.find((d) => d.title === "Fix the thing")!;
		expect(fix.note).toBe("deadbee on main: fixed");
		expect(fix.project).toBe("demo");
		expect(todayData(db, "demo", ago(24)).done.map((d) => d.title)).toEqual(["Fix the thing"]);
		expect(todayData(db, "demo", ago(24 * 5)).done.map((d) => d.title).sort()).toEqual(["Fix the thing", "Old work"]);
	});

	test("archived projects stay out of All", () => {
		const db = freshDb();
		const i = addItem(db, { project: "demo", title: "Shipped", kind: "task", owner: "agent" });
		updateItem(db, i, { status: "done" });
		db.query("UPDATE projects SET archived_at = datetime('now') WHERE slug = 'demo'").run();
		expect(todayData(db, "", ago(24)).done).toEqual([]);
		expect(todayData(db, "demo", ago(24)).done.length).toBe(1);
	});

	test("reports updated since, day pages left out", () => {
		const db = freshDb();
		publishReport(db, { project: "demo", name: "plan", html: "<p>x</p>", title: "The plan", grp: "Plans" }, "agent");
		publishReport(db, { project: "demo", name: "day-2026-11-12", html: "<p>x</p>", title: "Day", grp: "Days" }, "agent");
		const t = todayData(db, "", ago(1));
		expect(t.reports.map((r) => r.title)).toEqual(["The plan"]);
		expect(t.reports[0].version).toBe(1);
		expect(todayData(db, "", new Date(Date.now() + 3600e3).toISOString()).reports).toEqual([]);
	});
});

describe("briefText", () => {
	test("says nothing happened in one line", () => {
		const db = freshDb();
		expect(briefText(db, "", ago(1))).toContain("Nothing new, and nothing waits on you.");
	});

	test("needs you: counts, new, oldest; stuck; done with note", () => {
		const db = freshDb();
		const d1 = addItem(db, { project: "demo", title: "Pick a database", kind: "decision", owner: "kostas", priority: 1 });
		db.query("UPDATE items SET created_at = datetime('now', '-9 days') WHERE id = ?").run(d1);
		addItem(db, { project: "demo", title: "Check the phone layout", kind: "check", owner: "kostas" });
		const w = addItem(db, { project: "demo", title: "Needs a key", kind: "task", owner: "agent" });
		updateItem(db, w, { status: "waiting" });
		const f = addItem(db, { project: "demo", title: "Ship it", kind: "task", owner: "agent" });
		updateItem(db, f, { status: "done" });
		addNote(db, f, "abc123: shipped", "agent");
		const text = briefText(db, "demo", ago(2));
		expect(text).toContain("Waiting on you: 2, 1 new since then.");
		expect(text).toContain("Pick a database (P1) (waiting 9 days)");
		expect(text).toContain("Check the phone layout (new)");
		expect(text).toContain("Done by agents: 1.");
		expect(text).toContain("Ship it — abc123: shipped");
		expect(text).toContain("Stuck:");
		expect(text).toContain("Needs a key (waiting)");
	});
});

import { firstLine as plainFirstLine } from "../src/today";
test("a finishing note's first line drops markdown marks", () => {
	expect(plainFirstLine(["Merged. Then **Run** on a `to-do`."])).toBe("Merged. Then Run on a to-do.");
	expect(plainFirstLine(["- **Notices:** a new kind\n- more"])).toBe("Notices: a new kind");
});
