// The attention round's pieces working together: an answer (clicked or gone ahead by default) resumes the work that
// waits on it and drafts a ruling; notices never count as waiting on Kostas, in goals or stale flags.
import { describe, expect, test } from "bun:test";
import { addItem, answerItem, getItem, updateItem } from "../db";
import { applyDue, resolveAsk, sqlTime } from "../asks";
import { waitOn } from "../links";
import { listRulings } from "../rulings";
import { addGoal, goalStats } from "../goals";
import { staleOf } from "../stale";
import { freshDb } from "./helpers";

const BRIEF = "Which way should the export go? Each option is described here, with what it changes for you.";

describe("attention round, together", () => {
	test("a clicked answer resumes the waiting task and drafts a ruling", () => {
		const db = freshDb();
		const d = addItem(db, { title: "Choose the export format", project: "demo", kind: "decision", owner: "kostas", options: ["PDF", "PNG"], body: BRIEF }, "agent");
		const t = addItem(db, { title: "Build the export", project: "demo" }, "agent");
		updateItem(db, t, { status: "doing" }, "agent");
		waitOn(db, t, [d], "agent");
		expect(getItem(db, t)!.status).toBe("waiting");
		answerItem(db, d, "1");
		expect(getItem(db, t)!.status).toBe("todo");
		expect(listRulings(db, { project: "demo" }).some((r) => r.text.includes("PDF"))).toBe(true);
	});

	test("a default that goes ahead at its deadline does the same", () => {
		const db = freshDb();
		const d = addItem(db, { title: "Choose the export format", project: "demo", kind: "decision", owner: "kostas", options: ["PDF", "PNG"], default_answer: "2", body: BRIEF }, "agent");
		const t = addItem(db, { title: "Build the export", project: "demo" }, "agent");
		updateItem(db, t, { status: "doing" }, "agent");
		waitOn(db, t, [d], "agent");
		db.query("UPDATE items SET decide_by = ? WHERE id = ?").run(sqlTime(new Date(Date.now() - 3600e3)), d);
		applyDue(db);
		expect(getItem(db, d)!.answer).toBe("PNG");
		expect(getItem(db, t)!.status).toBe("todo");
		expect(listRulings(db, { project: "demo" }).some((r) => r.text.includes("PNG"))).toBe(true);
	});

	test("Got it on a notice resumes what waits on it, and drafts no ruling", () => {
		const db = freshDb();
		const n = addItem(db, { title: "Renamed Export to Download", project: "demo", kind: "notice", body: BRIEF }, "agent");
		const t = addItem(db, { title: "Update the docs", project: "demo" }, "agent");
		updateItem(db, t, { status: "doing" }, "agent");
		waitOn(db, t, [n], "agent");
		resolveAsk(db, n, { ack: true });
		expect(getItem(db, n)!.status).toBe("done");
		expect(getItem(db, t)!.status).toBe("todo");
		expect(listRulings(db, { project: "demo" })).toHaveLength(0);
	});

	test("a notice doesn't block a goal, count as on Kostas, or sit stale", () => {
		const db = freshDb();
		const g = addGoal(db, { project: "demo", title: "First release" }).id;
		addItem(db, { title: "Renamed Export to Download", project: "demo", kind: "notice", body: BRIEF, goal_id: g }, "agent");
		addItem(db, { title: "Choose the export format", project: "demo", kind: "decision", owner: "kostas", body: BRIEF, goal_id: g }, "agent");
		const s = goalStats(db).get(g)!;
		expect(s.mine).toBe(1);
		expect(s.blockers.map((b) => b.kind)).toEqual(["decision"]);
		const old = "2020-01-01 00:00:00";
		expect(staleOf({ kind: "notice", owner: "kostas", status: "todo", created_at: old, updated_at: old })).toBeNull();
		expect(staleOf({ kind: "decision", owner: "kostas", status: "todo", created_at: old, updated_at: old })?.why).toBe("sitting");
	});
});
