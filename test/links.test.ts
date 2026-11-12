// Waiting on another item (links.ts): links, cycles, resuming when the blocker is dealt with, the unblocks count and
// order, and the MCP tools that say it.
import { describe, expect, test } from "bun:test";
import { addItem, answerItem, getItem, listItems, updateItem } from "../db";
import { addLinks, blockersOf, removeLinks, resumeWaiting, topUnblockers, unblocks, waitOn, waitersOf } from "../links";
import { mcpHttp } from "../mcp";
import { freshDb } from "./helpers";

const db = freshDb();
const add = (title: string, more: Record<string, unknown> = {}) => addItem(db, { title, project: "demo", ...more });
const decision = (title = "Which way?") => add(title, { kind: "decision", owner: "kostas", options: ["A", "B"] });
const status = (id: number) => getItem(db, id)!.status;
const notes = (id: number) => getItem(db, id)!.notes.map((n) => n.text);

/** An agent task that is blocked on `on`. */
const blockedOn = (on: number[], title = "Build it") => {
	const id = add(title);
	updateItem(db, id, { status: "doing" });
	waitOn(db, id, on, "agent");
	return id;
};

describe("links", () => {
	test("waiting on items: add, list from both ends, remove", () => {
		const d1 = decision("one");
		const d2 = decision("two");
		const t = blockedOn([d1, d2]);
		expect(status(t)).toBe("waiting");
		expect(blockersOf(db, t).map((b) => b.id).sort()).toEqual([d1, d2].sort());
		expect(waitersOf(db, d1).map((w) => w.id)).toEqual([t]);
		expect(getItem(db, t)!.waits_on).toHaveLength(2);
		expect(getItem(db, d1)!.blocks.map((b) => b.id)).toEqual([t]);
		expect(getItem(db, t)!.waiting_on).toBe(2);
		removeLinks(db, t, [d2]);
		expect(blockersOf(db, t).map((b) => b.id)).toEqual([d1]);
		expect(unblocks(db, d2)).toBe(0);
		expect(notes(t).some((n) => n.startsWith("Waits on wb-"))).toBe(true);
	});
	test("an item can't wait on itself, on something dealt with, or in a circle", () => {
		const a = add("a");
		const b = add("b");
		const c = add("c");
		expect(() => waitOn(db, a, [a])).toThrow(/itself/);
		waitOn(db, a, [b]);
		expect(() => waitOn(db, b, [a])).toThrow(/each other/);
		waitOn(db, b, [c]);
		// Through a chain: c would wait on a, which waits on b, which waits on c.
		expect(() => addLinks(db, c, [a])).toThrow(/each other/);
		expect(status(c)).toBe("todo");
		const done = add("finished", { status: "done" });
		expect(() => waitOn(db, c, [done])).toThrow(/already done/);
		const answered = decision();
		answerItem(db, answered, "A");
		expect(() => waitOn(db, c, [answered])).toThrow(/already answered/);
		// Nothing was changed by the refused ones.
		expect(status(c)).toBe("todo");
		expect(blockersOf(db, c)).toEqual([]);
	});
	test("a refused link changes nothing, even when another target is fine", () => {
		const ok = decision();
		const closed = add("closed", { status: "dropped" });
		const t = add("t");
		expect(() => waitOn(db, t, [ok, closed])).toThrow();
		expect(status(t)).toBe("todo");
		expect(blockersOf(db, t)).toEqual([]);
	});
	test("an item that stops waiting waits on nothing", () => {
		const d = decision();
		const t = blockedOn([d]);
		updateItem(db, t, { status: "doing" });
		expect(blockersOf(db, t)).toEqual([]);
		expect(waitersOf(db, d)).toEqual([]);
		expect(unblocks(db, d)).toBe(0);
	});
});

describe("resuming", () => {
	test("answering a decision puts the waiting task back to todo, with the answer in its history", () => {
		const d = decision();
		const t = blockedOn([d]);
		answerItem(db, d, "B", "kostas");
		expect(status(t)).toBe("todo");
		expect(notes(t)).toContain("Unblocked: wb-" + getItem(db, d)!.ref + " was answered: B");
		expect(blockersOf(db, t)).toEqual([]);
	});
	test("answering by number uses the option's text", () => {
		const d = decision();
		const t = blockedOn([d]);
		answerItem(db, d, "2");
		expect(notes(t).at(-1)).toMatch(/was answered: B$/);
		expect(status(t)).toBe("todo");
	});
	test("finishing the blocker resumes it, with the blocker's last note when short", () => {
		const blocker = add("Deploy the thing");
		const t = blockedOn([blocker]);
		updateItem(db, blocker, { status: "done" }, "agent", "deployed in a1b2c3d");
		expect(status(t)).toBe("todo");
		expect(notes(t)).toContain(`Unblocked: wb-${getItem(db, blocker)!.ref} was finished: deployed in a1b2c3d`);
	});
	test("a long note stays out of it; dropping says dropped", () => {
		const blocker = add("Review the page", { kind: "review", owner: "kostas" });
		const t = blockedOn([blocker]);
		updateItem(db, blocker, { status: "dropped" }, "kostas", "x".repeat(400));
		expect(status(t)).toBe("todo");
		expect(notes(t).at(-1)).toBe(`Unblocked: wb-${getItem(db, blocker)!.ref} was dropped`);
	});
	test("it waits for every blocker before it resumes", () => {
		const d1 = decision("one");
		const d2 = decision("two");
		const t = blockedOn([d1, d2]);
		answerItem(db, d1, "A");
		expect(status(t)).toBe("waiting");
		expect(blockersOf(db, t).map((b) => b.id)).toEqual([d2]);
		expect(notes(t).at(-1)).toMatch(/was answered: A\. Still waiting on wb-/);
		updateItem(db, d2, { status: "done" });
		expect(status(t)).toBe("todo");
	});
	test("an item that was moved on already isn't touched", () => {
		const d = decision();
		const t = blockedOn([d]);
		updateItem(db, t, { status: "doing" });
		const before = notes(t).length;
		answerItem(db, d, "A");
		expect(status(t)).toBe("doing");
		expect(notes(t)).toHaveLength(before);
	});
	test("resumeWaiting is safe to repeat and returns what it resumed", () => {
		const d = decision();
		const t = blockedOn([d]);
		expect(resumeWaiting(db, d)).toEqual([]); // not answered yet
		updateItem(db, d, { answer: "A", owner: "agent", status: "todo" });
		expect(status(t)).toBe("todo");
		expect(resumeWaiting(db, d, "answered")).toEqual([]);
		expect(notes(t).filter((n) => n.startsWith("Unblocked:"))).toHaveLength(1);
		// Called by something that sets the answer itself: it may say how before recording it.
		const d2 = decision();
		const t2 = blockedOn([d2]);
		const resumed = resumeWaiting(db, d2, "answered");
		expect(resumed.map((r) => r.id)).toEqual([t2]);
		expect(resumed[0]).toMatchObject({ ref: getItem(db, t2)!.ref, owner: "agent", project: "demo" });
	});
	test("one answer resumes everything that waited on it", () => {
		const d = decision();
		const a = blockedOn([d], "a");
		const b = blockedOn([d], "b");
		expect(unblocks(db, d)).toBe(2);
		answerItem(db, d, "A");
		expect([status(a), status(b)]).toEqual(["todo", "todo"]);
	});
});

describe("unblocks", () => {
	test("counts the waiting items, in lists and per item, and only while it's open", () => {
		const d = decision();
		blockedOn([d], "x");
		blockedOn([d], "y");
		expect(listItems(db).find((i) => i.id === d)!.unblocks).toBe(2);
		expect(getItem(db, d)!.unblocks).toBe(2);
		expect(listItems(db).find((i) => i.title === "x")!.unblocks).toBe(0);
		updateItem(db, d, { status: "done" });
		expect(getItem(db, d)!.unblocks).toBe(0);
	});
	test("what Kostas has that unblocks the most comes first within a priority", () => {
		const plain = decision("plain");
		const one = decision("holds one");
		const two = decision("holds two");
		blockedOn([one]);
		blockedOn([two]);
		blockedOn([two]);
		const order = listItems(db, { status: ["todo"], owner: "kostas" })
			.filter((i) => [plain, one, two].includes(i.id))
			.map((i) => i.title);
		expect(order).toEqual(["holds two", "holds one", "plain"]);
		// Priority still comes first.
		const urgent = add("urgent", { kind: "decision", owner: "kostas", priority: 1 });
		const first = listItems(db, { status: ["todo"], owner: "kostas" }).filter((i) => [plain, one, two, urgent].includes(i.id));
		expect(first[0].id).toBe(urgent);
	});
	test("topUnblockers lists them with what waits", () => {
		const d = decision("top one");
		const t = blockedOn([d], "waiting task");
		const top = topUnblockers(db, "demo").find((x) => x.item.id === d)!;
		expect(top.waiters.map((w) => w.id)).toEqual([t]);
	});
});

describe("the tools agents use", () => {
	let nextId = 1;
	async function call(name: string, args: Record<string, unknown> = {}) {
		const req = new Request("http://localhost:4401/mcp?project=demo", {
			method: "POST",
			headers: { "content-type": "application/json", host: "localhost:4401", "mcp-protocol-version": "2025-06-18" },
			body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method: "tools/call", params: { name, arguments: args } }),
		});
		const r = ((await (await mcpHttp(req, db, { loopback: true })).json()) as any).result;
		return { text: r.content[0].text as string, data: r.structuredContent as any, error: r.isError as boolean };
	}
	const BODY = "Pick one of the two ways to do it, because the agent waits on the answer. A is cheaper, B is faster to ship.";

	test("add_item with blocks files the question and makes the task wait on it, in one call", async () => {
		const task = add("Agent task");
		updateItem(db, task, { status: "doing" });
		const ref = `wb-${getItem(db, task)!.ref}`;
		const r = await call("add_item", { title: "Which way should it go?", kind: "decision", options: ["A", "B"], body: BODY, blocks: ref });
		expect(r.error).toBe(false);
		expect(status(task)).toBe("waiting");
		const dref = r.data.item.ref as string;
		const got = await call("get_item", { ref });
		expect(got.data.item.waits_on.map((l: any) => l.ref)).toEqual([dref]);
		expect(got.text).toContain("waits on:");
		const d = await call("get_item", { ref: dref });
		expect(d.data.item.blocks.map((l: any) => l.ref)).toEqual([ref]);
		expect(d.data.item.unblocks).toBe(1);
		// Kostas answers: the task is back.
		expect((await call("answer_decision", { ref: dref, answer: "A" })).error).toBe(false);
		expect(status(task)).toBe("todo");
		expect(notes(task).at(-1)).toBe(`Unblocked: ${dref} was answered: A`);
	});
	test("wait_item with on, and list_items says what unblocks", async () => {
		const d = decision("Pick");
		const t = add("Task");
		const dref = `wb-${getItem(db, d)!.ref}`;
		const r = await call("wait_item", { ref: `wb-${getItem(db, t)!.ref}`, reason: "needs a pick", on: [dref] });
		expect(r.error).toBe(false);
		expect(status(t)).toBe("waiting");
		const list = await call("list_items", { owner: "kostas", q: "Pick" });
		expect(list.text).toContain("unblocks 1");
		expect(list.data.items.find((i: any) => i.ref === dref).unblocks).toBe(1);
		// finish_item with a note carries the note to the waiting item.
		const r2 = await call("finish_item", { ref: dref, note: "decided in the call: go with A" });
		expect(r2.error).toBe(false);
		expect(notes(t).at(-1)).toBe(`Unblocked: ${dref} was finished: decided in the call: go with A`);
	});
	test("wait_item refuses a cycle, and update_item adds and removes links", async () => {
		const a = add("A");
		const b = add("B");
		const ra = `wb-${getItem(db, a)!.ref}`;
		const rb = `wb-${getItem(db, b)!.ref}`;
		expect((await call("wait_item", { ref: ra, reason: "x", on: [rb] })).error).toBe(false);
		const bad = await call("wait_item", { ref: rb, reason: "y", on: [ra] });
		expect(bad.error).toBe(true);
		expect(bad.text).toMatch(/each other/);
		const c = add("C");
		const rc = `wb-${getItem(db, c)!.ref}`;
		expect((await call("update_item", { ref: ra, waits_on: [rc] })).error).toBe(false);
		expect(blockersOf(db, a)).toHaveLength(2);
		expect((await call("update_item", { ref: ra, not_waiting_on: [rb, rc] })).error).toBe(false);
		expect(blockersOf(db, a)).toHaveLength(0);
	});
	test("project_overview names what Kostas can unblock", async () => {
		const d = decision("The big question");
		blockedOn([d], "Stuck agent task");
		const r = await call("project_overview", {});
		expect(r.text).toContain("can unblock");
		expect(r.text).toMatch(/The big question.*unblocks wb-\w+ \(Stuck agent task\)/);
	});
	test("instructions teach waiting on an ask", async () => {
		const req = new Request("http://localhost:4401/mcp", {
			method: "POST",
			headers: { "content-type": "application/json", host: "localhost:4401", "mcp-protocol-version": "2025-06-18" },
			body: JSON.stringify({ jsonrpc: "2.0", id: 999, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } }),
		});
		const body = (await (await mcpHttp(req, db, { loopback: true })).json()) as any;
		expect(body.result.instructions).toContain("blocks");
	});
});
