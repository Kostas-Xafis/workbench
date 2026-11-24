import { describe, expect, test } from "bun:test";
import { addItem, addNote, getItem, listItems } from "../src/db";
import { staleLabel, staleOf } from "../src/stale";
import { freshDb } from "./helpers";

const NOW = Date.parse("2026-11-20T12:00:00Z");
const daysAgo = (d: number) => new Date(NOW - d * 86400e3).toISOString().slice(0, 19).replace("T", " ");
const item = (status: string, quiet: number, more: { owner?: string; created?: number } = {}) => ({
	status,
	owner: more.owner ?? "agent",
	updated_at: daysAgo(quiet),
	created_at: daysAgo(more.created ?? quiet),
});

describe("the stale rule", () => {
	test("doing is stalled after a day with no sign of life", () => {
		expect(staleOf(item("doing", 0.9), null, NOW)).toBeNull();
		expect(staleOf(item("doing", 1.5), null, NOW)?.why).toBe("stalled");
		expect(staleOf({ ...item("doing", 3), alive_at: daysAgo(0.5) }, null, NOW)).toBeNull();
		expect(staleOf(item("doing", 3), null, NOW)).toEqual({ why: "stalled", since: daysAgo(3) });
	});
	test("a newer note counts as news", () => {
		expect(staleOf(item("doing", 5), daysAgo(0.5), NOW)).toBeNull();
		expect(staleOf(item("doing", 5), daysAgo(3), NOW)?.since).toBe(daysAgo(3));
	});
	test("waiting for 7 days", () => {
		expect(staleOf(item("waiting", 6), null, NOW)).toBeNull();
		expect(staleOf(item("waiting", 8), null, NOW)?.why).toBe("waiting");
	});
	test("Kostas's items are never stale, however long they've waited; an agent's todo is just queued", () => {
		expect(staleOf(item("todo", 30, { owner: "kostas", created: 30 }), null, NOW)).toBeNull();
		expect(staleOf(item("doing", 30, { owner: "kostas" }), null, NOW)).toBeNull();
		expect(staleOf(item("waiting", 30, { owner: "kostas" }), null, NOW)).toBeNull();
		expect(staleOf(item("todo", 1, { created: 30 }), null, NOW)).toBeNull();
	});
	test("closed items are never stale", () => {
		expect(staleOf(item("done", 40, { owner: "kostas" }), null, NOW)).toBeNull();
		expect(staleOf(item("dropped", 40), null, NOW)).toBeNull();
	});
	test("label", () => {
		expect(staleLabel({ why: "stalled", since: daysAgo(3) }, NOW)).toBe("stalled 3 d");
	});
});

describe("the stale field", () => {
	const db = freshDb();
	const age = (id: number, status: string, days: number) =>
		db.query("UPDATE items SET status = ?, updated_at = datetime('now', ?), created_at = datetime('now', ?) WHERE id = ?").run(status, `-${days} days`, `-${days} days`, id) && db.query("UPDATE notes SET at = datetime('now', ?) WHERE item_id = ?").run(`-${days} days`, id);
	test("listItems and getItem carry it", () => {
		const quiet = addItem(db, { title: "quiet", project: "demo" });
		const fresh = addItem(db, { title: "fresh", project: "demo" });
		age(quiet, "doing", 4);
		const list = listItems(db);
		expect(list.find((i) => i.id === quiet)!.stale?.why).toBe("stalled");
		expect(list.find((i) => i.id === fresh)!.stale).toBeNull();
		expect(getItem(db, quiet)!.stale?.why).toBe("stalled");
		addNote(db, quiet, "still on it", "agent");
		expect(getItem(db, quiet)!.stale).toBeNull();
		expect(listItems(db).find((i) => i.id === quiet)!.stale).toBeNull();
	});
});
