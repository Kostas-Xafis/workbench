// The morning plan's "Start next" (plan.ts): the first startable item of each project's Next up.
import { describe, expect, test } from "bun:test";
import { addItem, addProject, getItem, updateItem } from "../src/db";
import { setOrder } from "../src/order";
import { waitOn } from "../src/links";
import { nextUp } from "../src/plan";
import { freshDb } from "./helpers";

type Db = ReturnType<typeof freshDb>;
const task = (db: Db, title: string, more: Record<string, unknown> = {}) =>
	addItem(db, { title, project: "demo", kind: "task", owner: "agent", ...more }, "agent");
const titles = (db: Db, project = "") => nextUp(db, { project }).map((i) => i.title);

describe("start next", () => {
	test("one per project, in Next up's order, in the board's project order", () => {
		const db = freshDb();
		addProject(db, { slug: "other", name: "Other", path: "/tmp/other" });
		const a = task(db, "Demo: A");
		const b = task(db, "Demo: B");
		task(db, "Other: first", { project: "other" });
		task(db, "Other: second", { project: "other" });
		expect(titles(db)).toEqual(["Demo: A", "Other: first"]);
		// Kostas puts B first.
		setOrder(db, "demo", [`wb-${getItem(db, b)!.ref}`, `wb-${getItem(db, a)!.ref}`]);
		expect(titles(db)).toEqual(["Demo: B", "Other: first"]);
		expect(titles(db, "other")).toEqual(["Other: first"]);
		expect(nextUp(db)[0]).toMatchObject({ id: b, project: "demo", owner: "agent", status: "todo", kind: "task" });
	});

	test("passes over ideas, Kostas's asks, work in progress, items a run is on and ones that wait on something", () => {
		const db = freshDb();
		addItem(db, { title: "An idea", project: "demo", kind: "idea", owner: "agent" }, "agent");
		addItem(db, { title: "Your decision", project: "demo", kind: "decision", owner: "kostas" }, "agent");
		const doing = task(db, "Doing it");
		updateItem(db, doing, { status: "doing" });
		const busy = task(db, "A run is on it");
		db.query("INSERT INTO runs (item_id, project, pid, tag) VALUES (?, 'demo', 1, 'wb-run-plan')").run(busy);
		const blocked = task(db, "Waits on an ask");
		const ask = addItem(db, { title: "Unblocks it", project: "demo", kind: "decision", owner: "kostas" }, "agent");
		waitOn(db, blocked, [ask]);
		// A to-do that still has an open item it waits on (a link added as it was filed): not startable either.
		const linked = task(db, "Linked to-do");
		db.query("INSERT INTO item_links (item_id, blocker_id) VALUES (?, ?)").run(linked, ask);
		task(db, "This one");
		expect(titles(db)).toEqual(["This one"]);
		// The run ends: that item comes first again.
		db.query("UPDATE runs SET ended_at = datetime('now'), status = 'done' WHERE item_id = ?").run(busy);
		expect(titles(db)).toEqual(["A run is on it"]);
	});

	test("leaves out archived projects, and a project whose autopilot is on", () => {
		const db = freshDb();
		addProject(db, { slug: "old", name: "Old", path: "/tmp/old" });
		task(db, "Old work", { project: "old" });
		task(db, "Demo work");
		db.query("UPDATE projects SET archived_at = datetime('now') WHERE slug = 'old'").run();
		expect(titles(db)).toEqual(["Demo work"]);
		expect(titles(db, "old")).toEqual([]);
		// Autopilot, when the board has it (a column another part adds): that project starts its own work.
		try {
			db.run("ALTER TABLE projects ADD COLUMN autopilot INTEGER NOT NULL DEFAULT 0");
		} catch {}
		db.query("UPDATE projects SET autopilot = 1 WHERE slug = 'demo'").run();
		expect(titles(db)).toEqual([]);
	});
});
