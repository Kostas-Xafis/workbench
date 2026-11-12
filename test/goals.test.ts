// Goals: the table and its rules (goals.ts), items on a goal, and the three doors agents and Kostas use: the MCP
// tools, the `wb` command and the board's HTTP API.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { addItem, addProject, exportAll, getItem, listItems, removeProject, search, updateItem } from "../db";
import {
	activeGoal,
	addGoal,
	blocksGoal,
	checkItemGoal,
	cleanDue,
	dueText,
	getGoal,
	goalsWithStats,
	itemGoals,
	listGoals,
	moveGoal,
	needGoal,
	resolveGoal,
	updateGoal,
} from "../goals";
import { mcpHttp } from "../mcp";
import { freshDb } from "./helpers";

describe("goals", () => {
	test("add, read, change and close one", () => {
		const db = freshDb();
		const g = addGoal(db, { project: "demo", title: " First release ", body: "Ships to the store", due: "2026-12-01" });
		expect(g).toMatchObject({ title: "First release", body: "Ships to the store", due: "2026-12-01", status: "open", sort: 1 });
		expect(updateGoal(db, g.id, { title: "1.0", due: "" })).toMatchObject({ title: "1.0", due: "" });
		const done = updateGoal(db, g.id, { status: "done" });
		expect(done.status).toBe("done");
		expect(done.done_at).toBeTruthy();
		expect(updateGoal(db, g.id, { status: "open" }).done_at).toBeNull();
		expect(() => updateGoal(db, 999, { title: "x" })).toThrow("no goal #999");
		expect(() => addGoal(db, { project: "demo", title: "  " })).toThrow("needs a title");
		expect(() => addGoal(db, { project: "nope", title: "x" })).toThrow('no project "nope"');
	});

	test("a target date is a real YYYY-MM-DD day, or empty", () => {
		expect(cleanDue("")).toBe("");
		expect(cleanDue(" 2026-02-28 ")).toBe("2026-02-28");
		expect(() => cleanDue("2026-02-30")).toThrow("YYYY-MM-DD");
		expect(() => cleanDue("next week")).toThrow("YYYY-MM-DD");
		expect(dueText("2026-12-01", "2026-11-12")).toBe("due 2026-12-01 (in 19 days)");
		expect(dueText("2026-11-10", "2026-11-12")).toBe("due 2026-11-10 (2 days overdue)");
		expect(dueText("2026-11-12", "2026-11-12")).toBe("due 2026-11-12 (today)");
		expect(dueText("")).toBe("");
	});

	test("goals are found by number or by exact title, in a project", () => {
		const db = freshDb();
		addProject(db, { slug: "other", name: "Other", path: "/tmp/other" });
		const a = addGoal(db, { project: "demo", title: "Launch" });
		const b = addGoal(db, { project: "other", title: "Launch" });
		expect(resolveGoal(db, a.id)).toBe(a.id);
		expect(resolveGoal(db, `#${a.id}`)).toBe(a.id);
		expect(resolveGoal(db, "launch", "demo")).toBe(a.id);
		expect(resolveGoal(db, "Launch", "other")).toBe(b.id);
		expect(() => resolveGoal(db, "Launch")).toThrow("more than one");
		expect(resolveGoal(db, "Missing", "demo")).toBeUndefined();
		expect(() => needGoal(db, "Missing", "demo")).toThrow(/no goal "Missing"; open goals: #\d+ Launch/);
	});

	test("one goal is the active one: the marked one, else the first open one", () => {
		const db = freshDb();
		const a = addGoal(db, { project: "demo", title: "A" });
		const b = addGoal(db, { project: "demo", title: "B" });
		expect(activeGoal(db, "demo")!.id).toBe(a.id);
		updateGoal(db, b.id, { active: true });
		expect(activeGoal(db, "demo")!.id).toBe(b.id);
		expect(goalsWithStats(db).map((g) => [g.title, g.is_active])).toEqual([["A", false], ["B", true]]);
		// Marking another unmarks the first; closing the active one hands it back to the first open one.
		updateGoal(db, a.id, { active: true });
		expect(getGoal(db, b.id)!.active).toBe(0);
		updateGoal(db, a.id, { status: "done" });
		expect(activeGoal(db, "demo")!.id).toBe(b.id);
		expect(() => updateGoal(db, a.id, { active: true })).toThrow("only an open goal");
		expect(activeGoal(db, "nobody")).toBeUndefined();
	});

	test("goals have an order that can change", () => {
		const db = freshDb();
		const ids = ["A", "B", "C"].map((title) => addGoal(db, { project: "demo", title }).id);
		const order = () => listGoals(db, { project: "demo" }).map((g) => g.title).join("");
		expect(order()).toBe("ABC");
		moveGoal(db, ids[2], -1);
		expect(order()).toBe("ACB");
		moveGoal(db, ids[0], 1);
		expect(order()).toBe("CAB");
		updateGoal(db, ids[1], { position: 1 });
		expect(order()).toBe("BCA");
		updateGoal(db, ids[1], { position: 99 });
		expect(order()).toBe("CAB");
		// A closed goal keeps its place and doesn't count for positions.
		updateGoal(db, ids[2], { status: "dropped" });
		updateGoal(db, ids[1], { position: 1 });
		expect(listGoals(db, { project: "demo", status: ["open"] }).map((g) => g.title).join("")).toBe("BA");
	});
});

describe("items on a goal", () => {
	test("an item takes a goal of its own project, at add and by change, and the history says so", () => {
		const db = freshDb();
		addProject(db, { slug: "other", name: "Other", path: "/tmp/other" });
		const g = addGoal(db, { project: "demo", title: "Release" });
		const id = addItem(db, { title: "Fix it", project: "demo", goal_id: g.id });
		expect(getItem(db, id)!.goal_id).toBe(g.id);
		const loose = addItem(db, { title: "Loose", project: "demo" });
		expect(getItem(db, loose)!.goal_id).toBeNull();
		updateItem(db, loose, { goal_id: g.id }, "agent");
		expect(getItem(db, loose)!.notes.at(-1)!.text).toBe("goal: — → Release");
		updateItem(db, loose, { goal_id: null }, "agent");
		expect(getItem(db, loose)!.goal_id).toBeNull();
		expect(getItem(db, loose)!.notes.at(-1)!.text).toBe("goal: Release → —");
		// Saving the same goal again changes nothing (the board's form sends it every time).
		const notes = getItem(db, id)!.notes.length;
		updateItem(db, id, { goal_id: g.id, title: "Fix it" });
		expect(getItem(db, id)!.notes.length).toBe(notes);
		expect(() => addItem(db, { title: "x", project: "other", goal_id: g.id })).toThrow("belongs to demo");
		expect(() => updateItem(db, id, { goal_id: 999 })).toThrow("no goal #999");
		expect(() => updateItem(db, id, { goal_id: 1.5 })).toThrow("goal_id");
	});

	test("an item can't go on a closed goal, and moving projects takes it off the goal", () => {
		const db = freshDb();
		addProject(db, { slug: "other", name: "Other", path: "/tmp/other" });
		const g = addGoal(db, { project: "demo", title: "Release" });
		const id = addItem(db, { title: "Fix it", project: "demo", goal_id: g.id });
		updateGoal(db, g.id, { status: "done" });
		expect(() => addItem(db, { title: "late", project: "demo", goal_id: g.id })).toThrow("is done");
		// It keeps the goal it already has, though.
		updateItem(db, id, { title: "Fix it well" });
		expect(getItem(db, id)!.goal_id).toBe(g.id);
		updateGoal(db, g.id, { status: "open" });
		updateItem(db, id, { project: "other" });
		expect(getItem(db, id)!.goal_id).toBeNull();
		expect(() => checkItemGoal(db, "other", g.id)).toThrow("belongs to demo");
	});

	test("list by goal, and a project with goals can't be removed from under them", () => {
		const db = freshDb();
		const g = addGoal(db, { project: "demo", title: "Release" });
		const a = addItem(db, { title: "On it", project: "demo", goal_id: g.id });
		const b = addItem(db, { title: "Off it", project: "demo" });
		expect(listItems(db, { goal: g.id }).map((i) => i.id)).toEqual([a]);
		expect(listItems(db, { goal: "none" }).map((i) => i.id)).toEqual([b]);
		addProject(db, { slug: "empty", name: "Empty", path: "" });
		addGoal(db, { project: "empty", title: "Someday" });
		removeProject(db, "empty");
		expect(listGoals(db, { project: "empty" })).toEqual([]);
	});

	test("goals are in search and in the export", () => {
		const db = freshDb();
		const g = addGoal(db, { project: "demo", title: "Quokka launch", body: "Tell the zoo" });
		expect(search(db, "quokka").goals.map((x) => x.id)).toEqual([g.id]);
		expect(search(db, "zoo", "demo").goals.map((x) => x.id)).toEqual([g.id]);
		expect(search(db, "zoo", "nobody").goals).toEqual([]);
		addItem(db, { title: "Item", project: "demo", goal_id: g.id });
		const out = exportAll(db) as unknown as { goals: { title: string }[]; items: { goal_id: number }[] };
		expect(out.goals.map((x) => x.title)).toEqual(["Quokka launch"]);
		expect(out.items[0].goal_id).toBe(g.id);
	});
});

describe("progress and blockers", () => {
	test("counts done of all, what waits on Kostas, and what blocks the goal", () => {
		const db = freshDb();
		const g = addGoal(db, { project: "demo", title: "Release" });
		const on = (title: string, more: Record<string, string> = {}) => addItem(db, { title, project: "demo", goal_id: g.id, ...more });
		on("shipped", { status: "done", owner: "agent" });
		on("dropped one", { status: "dropped", owner: "agent" });
		on("agent todo", { owner: "agent" });
		on("agent doing", { owner: "agent", status: "doing" });
		on("agent stuck", { owner: "agent", status: "waiting" });
		on("pick a store", { kind: "decision", owner: "kostas" });
		on("his check, started", { kind: "check", owner: "kostas", status: "doing" });
		addItem(db, { title: "not on it", project: "demo", owner: "kostas" });
		const s = goalsWithStats(db)[0].stats;
		// The dropped one doesn't count at all; 1 of 6 is done.
		expect(s).toMatchObject({ total: 6, done: 1, open: 5, mine: 2 });
		expect(s.blockers.map((b) => [b.title, b.why]).sort()).toEqual([
			["agent stuck", "waiting"],
			["his check, started", "kostas"],
			["pick a store", "kostas"],
		]);
	});

	test("the rule: open and for Kostas, or an agent's item that waits", () => {
		expect(blocksGoal({ owner: "kostas", status: "todo" })).toBe("kostas");
		expect(blocksGoal({ owner: "kostas", status: "waiting" })).toBe("kostas");
		expect(blocksGoal({ owner: "kostas", status: "done" })).toBeNull();
		expect(blocksGoal({ owner: "agent", status: "waiting" })).toBe("waiting");
		expect(blocksGoal({ owner: "agent", status: "doing" })).toBeNull();
		expect(blocksGoal({ owner: "agent", status: "dropped" })).toBeNull();
	});

	test("a goal with no items has zeros", () => {
		const db = freshDb();
		addGoal(db, { project: "demo", title: "Empty" });
		expect(goalsWithStats(db)[0].stats).toEqual({ total: 0, done: 0, open: 0, mine: 0, blockers: [] });
	});
});

describe("items by goal (for the queue)", () => {
	test("each item on an open goal gets its goal and the goal's rank, the active one first", () => {
		const db = freshDb();
		const a = addGoal(db, { project: "demo", title: "A" });
		const b = addGoal(db, { project: "demo", title: "B" });
		const c = addGoal(db, { project: "demo", title: "C" });
		updateGoal(db, b.id, { active: true });
		updateGoal(db, c.id, { status: "dropped" });
		const refOf = (goal_id: number) => getItem(db, addItem(db, { title: `on ${goal_id}`, project: "demo", goal_id: goal_id === c.id ? undefined : goal_id }))!;
		const ia = refOf(a.id);
		const ib = refOf(b.id);
		const m = itemGoals(db, "demo");
		expect(m.get(ia.ref)).toMatchObject({ goal_id: a.id, goal: "A", rank: 2, active: false });
		expect(m.get(ib.ref)).toMatchObject({ goal_id: b.id, goal: "B", rank: 1, active: true });
		expect(itemGoals(db).size).toBe(2);
		expect(itemGoals(db, "nobody").size).toBe(0);
	});
});

/* ---------- MCP ---------- */

describe("MCP", () => {
	const db = freshDb();
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
	async function prompt(name: string) {
		const req = new Request("http://localhost:4401/mcp?project=demo", {
			method: "POST",
			headers: { "content-type": "application/json", host: "localhost:4401", "mcp-protocol-version": "2025-06-18" },
			body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method: "prompts/get", params: { name, arguments: {} } }),
		});
		return ((await (await mcpHttp(req, db, { loopback: true })).json()) as any).result.messages[0].content.text as string;
	}
	const BODY = "A task for the next agent: do the thing, because the release needs it, and say when it is done.";

	test("add_goal, list_goals, update_goal", async () => {
		const a = await call("add_goal", { title: "First release", description: "Ships", due: "2026-12-01" });
		expect(a.error).toBe(false);
		expect(a.data.goal).toMatchObject({ title: "First release", due: "2026-12-01", status: "open", active: true, items: 0 });
		const id = a.data.goal.id as number;
		await call("add_goal", { title: "Second" });
		const list = await call("list_goals");
		expect(list.data.goals.map((g: any) => g.title)).toEqual(["First release", "Second"]);
		expect(list.text).toContain("First release (active)");
		expect((await call("add_goal", { title: "x", due: "soon" })).error).toBe(true);
		const u = await call("update_goal", { goal: "second", active: true, position: 1 });
		expect(u.data.goal).toMatchObject({ title: "Second", active: true });
		expect((await call("list_goals")).data.goals[0].title).toBe("Second");
		const closed = await call("update_goal", { goal: id, status: "done" });
		expect(closed.data.goal.status).toBe("done");
		expect((await call("list_goals")).data.goals.map((g: any) => g.title)).toEqual(["Second"]);
		expect((await call("list_goals", { status: "all" })).data.goals).toHaveLength(2);
		const bad = await call("update_goal", { goal: "Nope" });
		expect(bad.error).toBe(true);
		expect(bad.text).toContain("no goal");
		await call("update_goal", { goal: id, status: "open" });
	});

	test("add_item, update_item and list_items take a goal by number or title", async () => {
		const goal = listGoals(db, { project: "demo" }).find((g) => g.title === "First release")!;
		const a = await call("add_item", { title: "Build it", body: BODY, kind: "task", owner: "agent", goal: "First release" });
		expect(a.error).toBe(false);
		expect(a.data.item.goal_id).toBe(goal.id);
		expect(a.text).toContain("goal: First release");
		const b = await call("add_item", { title: "Build more", body: BODY, owner: "agent" });
		expect(b.data.item.goal_id).toBeUndefined();
		const moved = await call("update_item", { ref: b.data.item.ref, goal: goal.id });
		expect(moved.data.item.goal_id).toBe(goal.id);
		expect((await call("list_items", { goal: "First release" })).data.total).toBe(2);
		expect((await call("list_items", { goal: "none" })).data.items.map((i: any) => i.goal_id)).not.toContain(goal.id);
		const cleared = await call("update_item", { ref: b.data.item.ref, goal: "none" });
		expect(cleared.data.item.goal_id).toBeUndefined();
		expect((await call("add_item", { title: "Lost", body: BODY, owner: "agent", goal: "No such goal" })).error).toBe(true);
		const got = await call("get_item", { ref: a.data.item.ref });
		expect(got.text).toContain(`goal: #${goal.id} First release`);
	});

	test("project_overview lists goals with progress and blockers, and search finds them", async () => {
		await call("add_item", { title: "Pick the store", kind: "decision", options: ["Apple", "Google"], body: "Which store first? Apple reaches more people here, Google is cheaper to join. I'd say Apple.", goal: "First release" });
		const o = await call("project_overview");
		expect(o.text).toContain("## Goals");
		expect(o.text).toContain("First release");
		expect(o.text).toMatch(/waiting on Kostas/);
		expect(o.text).toContain("blocked by:");
		expect(o.text).toContain("Pick the store");
		expect((await call("search", { q: "First release" })).text).toContain("goals (1)");
	});

	test("/next prefers agent work on the active goal; the instructions say how to use goals", async () => {
		const g = await call("add_goal", { title: "Urgent", active: true });
		await call("add_item", { title: "Plain old task", body: BODY, owner: "agent", priority: 1 });
		await call("add_item", { title: "Serves the urgent goal", body: BODY, owner: "agent", priority: 3, goal: g.data.goal.id });
		const text = await prompt("next");
		expect(text).toContain('The active goal is "Urgent"');
		expect(text.indexOf("Serves the urgent goal")).toBeLessThan(text.indexOf("Plain old task"));
		const init = await (
			await mcpHttp(
				new Request("http://localhost:4401/mcp", {
					method: "POST",
					headers: { "content-type": "application/json", host: "localhost:4401", "mcp-protocol-version": "2025-06-18" },
					body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } }),
				}),
				db,
				{ loopback: true },
			)
		).json();
		const instructions = (init as any).result.instructions as string;
		expect(instructions).toContain("Don't create goals");
		expect(instructions).toContain("list_goals");
	});
});

/* ---------- The wb command ---------- */

describe("wb", () => {
	const dir = mkdtempSync(join(process.env.WB_TEST_DIR!, "cli-"));
	const env = { ...process.env, WB_DB: join(dir, "workbench.db"), WB_BACKUPS: join(dir, "backups"), WB_AUTHOR: "kostas", XDG_RUNTIME_DIR: join(dir, "run") };
	const wb = async (...args: string[]) => {
		const p = Bun.spawn(["bun", join(import.meta.dir, "..", "wb.ts"), ...args], { cwd: dir, env, stdout: "pipe", stderr: "pipe" });
		const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
		return { out: out.trim(), err: err.trim(), code };
	};

	test("goals can be added, listed, given to items and closed", async () => {
		expect((await wb("project", "demo", dir, "Demo")).code).toBe(0);
		const added = await wb("goal", "add", "First", "release", "--due", "2026-12-01", "--project", "demo");
		expect(added.out).toContain("#1 First release (active)");
		expect(added.out).toContain("due 2026-12-01");
		expect((await wb("goal", "add", "Later", "--project", "demo")).out).toContain("#2 Later");
		const item = await wb("add", "Build it", "--project", "demo", "--goal", "1", "--owner", "agent");
		expect(item.code).toBe(0);
		const ref = item.out;
		expect((await wb("show", ref)).out).toContain("goal: #1 First release");
		const stuck = await wb("add", "Pick one", "--project", "demo", "--goal", "First release", "--owner", "kostas", "--kind", "decision");
		expect(stuck.code).toBe(0);
		const goals = await wb("goals", "--project", "demo");
		expect(goals.out).toContain("#1 First release (active)");
		expect(goals.out).toContain("0 of 2 done");
		expect(goals.out).toContain("1 waiting on Kostas");
		expect(goals.out).toContain("blocked by");
		expect((await wb("ls", "--project", "demo", "--goal", "1")).out.split("\n")).toHaveLength(2);
		expect((await wb("edit", ref, "--goal", "none")).out).not.toContain("goal: #");
		expect((await wb("ls", "--project", "demo", "--goal", "1")).out.split("\n")).toHaveLength(1);
		const bad = await wb("add", "Nope", "--project", "demo", "--goal", "Missing");
		expect(bad.code).toBe(1);
		expect(bad.err).toContain('no goal "Missing"');
		expect((await wb("goal", "2", "--active", "--project", "demo")).out).toContain("#2 Later (active)");
		expect((await wb("goal", "1", "--done", "--project", "demo")).out).toContain("[done]");
		expect((await wb("goals", "--project", "demo")).out).not.toContain("First release");
		expect((await wb("goals", "--project", "demo", "--all")).out).toContain("First release");
		expect((await wb("goal", "1", "--done", "--drop", "--project", "demo")).code).toBe(1);
	});
});

/* ---------- The board's HTTP API ---------- */

describe("HTTP", () => {
	const PORT = Number(process.env.WB_PORT);
	const BASE = `http://127.0.0.1:${PORT}`;
	const dir = mkdtempSync(join(process.env.WB_TEST_DIR!, "goals-server-"));
	let proc: ReturnType<typeof Bun.spawn>;
	const json = (path: string, method: string, body?: unknown) =>
		fetch(BASE + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

	beforeAll(async () => {
		mkdirSync(join(dir, "home"));
		mkdirSync(join(dir, "run"));
		proc = Bun.spawn(["bun", join(import.meta.dir, "..", "server.ts")], {
			cwd: dir,
			env: { ...process.env, WB_DB: join(dir, "workbench.db"), WB_BACKUPS: join(dir, "backups"), WB_PORT: String(PORT), HOME: join(dir, "home"), XDG_RUNTIME_DIR: join(dir, "run"), XDG_CONFIG_HOME: join(dir, "config") },
			stdout: "ignore",
			stderr: "ignore",
		});
		for (let i = 0; i < 100; i++) {
			try {
				// Not an earlier test file's server that is still shutting down: it has to be this one's database.
				const ping = (await (await fetch(`${BASE}/api/ping`)).json()) as { db: string };
				if (ping.db === join(dir, "workbench.db")) break;
			} catch {}
			await Bun.sleep(100);
		}
		// A project to put goals in (the API's own project route is for the app only).
		const p = Bun.spawn(["bun", join(import.meta.dir, "..", "wb.ts"), "project", "demo", dir, "Demo"], { env: { ...process.env, WB_DB: join(dir, "workbench.db"), XDG_RUNTIME_DIR: join(dir, "run") }, stdout: "ignore", stderr: "ignore" });
		await p.exited;
	});
	afterAll(() => proc?.kill());

	test("goals: add, change, move and close them; items take goal_id; the queue endpoint says each item's goal", async () => {
		const made = await json("/api/goals", "POST", { project: "demo", title: "Release", body: "Ship it", due: "2026-12-01" });
		expect(made.status).toBe(201);
		await json("/api/goals", "POST", { project: "demo", title: "After" });
		let goals = (await (await fetch(`${BASE}/api/goals?project=demo`)).json()) as any[];
		expect(goals.map((g) => [g.title, g.is_active])).toEqual([["Release", true], ["After", false]]);
		const [release, after] = goals;

		const item = (await (await json("/api/items", "POST", { title: "Do it", project: "demo", owner: "agent", goal_id: release.id })).json()) as { id: number };
		const got = (await (await fetch(`${BASE}/api/items/${item.id}`)).json()) as any;
		expect(got.goal_id).toBe(release.id);
		const byGoal = (await (await fetch(`${BASE}/api/items?project=demo&goal=${release.id}`)).json()) as any[];
		expect(byGoal.map((i) => i.id)).toEqual([item.id]);
		expect(((await (await fetch(`${BASE}/api/items?project=demo&goal=none`)).json()) as any[]).length).toBe(0);
		goals = (await (await fetch(`${BASE}/api/goals`)).json()) as any[];
		expect(goals[0].stats).toMatchObject({ total: 1, done: 0, open: 1 });

		const queue = (await (await fetch(`${BASE}/api/goals/items?project=demo`)).json()) as Record<string, any>;
		expect(queue[got.ref]).toMatchObject({ goal_id: release.id, goal: "Release", rank: 1, active: true });

		// Saving the item from the board's dialog sends goal_id with the rest; none = null.
		const cleared = await json(`/api/items/${item.id}`, "PATCH", { title: "Do it", goal_id: null });
		expect(((await cleared.json()) as any).goal_id).toBeNull();
		const wrong = await json(`/api/items/${item.id}`, "PATCH", { goal_id: 9999 });
		expect(wrong.status).toBe(400);

		const moved = (await (await json(`/api/goals/${after.id}`, "PATCH", { move: -1 })).json()) as any[];
		expect(moved.map((g) => g.title)).toEqual(["After", "Release"]);
		const closed = (await (await json(`/api/goals/${release.id}`, "PATCH", { status: "done" })).json()) as any[];
		expect(closed.find((g) => g.id === release.id).status).toBe("done");
		expect((await json(`/api/goals/${release.id}`, "PATCH", { due: "tomorrow" })).status).toBe(400);
		// Writes are JSON only, like every other write.
		expect((await fetch(`${BASE}/api/goals`, { method: "POST", body: "{}" })).status).toBe(415);
		const found = (await (await fetch(`${BASE}/api/search?q=Release`)).json()) as any;
		expect(found.goals.map((g: any) => g.title)).toEqual(["Release"]);
	});
});
