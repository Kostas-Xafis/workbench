// The order of a project's agent work (order.ts): set, kept when filing and closing, and honoured everywhere "next" is picked.
import { describe, expect, test } from "bun:test";
import { addItem, addProject, getItem, listItems, updateItem } from "../src/db";
import { agentOrder, moveInOrder, setOrder } from "../src/order";
import { mcpHttp } from "../src/mcp";
import { parseWb } from "../src/cliargs";
import { runCli } from "../src/cli";
import { freshDb } from "./helpers";

type DB = ReturnType<typeof freshDb>;
const BODY = "Work for an agent, long enough to be a proper brief.";
const add = (db: DB, title: string, extra: Record<string, unknown> = {}) =>
	addItem(db, { title, project: "demo", kind: "task", owner: "agent", body: BODY, ...extra } as any, "agent");
const ref = (db: DB, id: number) => `wb-${getItem(db, id)!.ref}`;
const titles = (db: DB) => listItems(db, { project: "demo", owner: "agent", status: ["todo", "doing", "waiting"] }).map((i) => i.title);

const rpc = async (db: DB, method: string, params: Record<string, unknown>) => {
	const req = new Request("http://localhost:4401/mcp?project=demo", {
		method: "POST",
		headers: { "content-type": "application/json", host: "localhost:4401", "mcp-protocol-version": "2025-06-18" },
		body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
	});
	return ((await (await mcpHttp(req, db, { loopback: true })).json()) as any).result;
};
const wb = async (db: DB, argv: string[]) => {
	const { values: o, positionals: args } = parseWb(argv);
	const lines: string[] = [];
	const code = await runCli({
		db,
		args,
		o: { ...o, project: "demo" },
		cwd: "/tmp/demo",
		author: "agent",
		tty: false,
		base: "",
		port: 0,
		out: (l) => lines.push(l),
		err: (l) => lines.push(l),
		read: async () => {
			throw new Error("no files here");
		},
		write: async () => {},
	});
	return { code, text: lines.join("\n") };
};
const NAMES = ["alpha", "bravo", "charlie", "delta"];
const names = (text: string) => text.split("\n").map((l) => NAMES.find((t) => l.includes(t)));

describe("the order of agent work", () => {
	test("without an order, the usual order: priority, then oldest first", () => {
		const db = freshDb();
		add(db, "a");
		add(db, "b", { priority: 1 });
		add(db, "c");
		expect(titles(db)).toEqual(["b", "a", "c"]);
		expect(listItems(db, { project: "demo" }).every((i) => i.rank == null)).toBe(true);
	});

	test("setOrder puts the listed items first, as ranks 1..n, and unranked ones follow in their usual order", () => {
		const db = freshDb();
		const [a, b, c, d] = ["a", "b", "c", "d"].map((t) => add(db, t));
		expect(setOrder(db, "demo", [ref(db, c), ref(db, a)])).toEqual([ref(db, c), ref(db, a), ref(db, b), ref(db, d)]);
		expect(getItem(db, c)!.rank).toBe(1);
		expect(getItem(db, a)!.rank).toBe(2);
		expect(getItem(db, b)!.rank).toBeNull();
		expect(titles(db)).toEqual(["c", "a", "b", "d"]);
		// the bare ref works, a repeat is ignored, and the same list again changes nothing
		setOrder(db, "demo", [getItem(db, c)!.ref, ref(db, a), ref(db, c)]);
		expect(titles(db)).toEqual(["c", "a", "b", "d"]);
		expect(getItem(db, a)!.rank).toBe(2);
	});

	test("items left out of a new list keep their relative order after it", () => {
		const db = freshDb();
		const [a, b, c] = ["a", "b", "c"].map((t) => add(db, t));
		setOrder(db, "demo", [ref(db, b)]);
		// c isn't ordered yet, so the list goes first
		setOrder(db, "demo", [ref(db, c)]);
		expect(titles(db)).toEqual(["c", "b", "a"]);
		expect([c, b, a].map((x) => getItem(db, x)!.rank)).toEqual([1, 2, null]);
	});

	test("a list of ordered items only (a goal's to-dos) is reordered in place, among the places it holds", () => {
		const db = freshDb();
		const [a, b, c, d, e] = ["a", "b", "c", "d", "e"].map((t) => add(db, t));
		setOrder(db, "demo", [a, b, c, d, e].map((x) => ref(db, x)));
		// b and d belong to the goal: swapped in their own places, a, c and e don't move
		setOrder(db, "demo", [ref(db, d), ref(db, b)]);
		expect(titles(db)).toEqual(["a", "d", "c", "b", "e"]);
		// one item alone: nothing moves
		setOrder(db, "demo", [ref(db, e)]);
		expect(titles(db)).toEqual(["a", "d", "c", "b", "e"]);
		// the full list keeps its meaning
		setOrder(db, "demo", [e, d, c, b, a].map((x) => ref(db, x)));
		expect(titles(db)).toEqual(["e", "d", "c", "b", "a"]);
		expect([e, d, c, b, a].map((x) => getItem(db, x)!.rank)).toEqual([1, 2, 3, 4, 5]);
	});

	test("a priority-1 item goes ahead of the ordered work that isn't priority 1, after the priority-1 work", () => {
		const db = freshDb();
		const p1 = add(db, "old p1", { priority: 1 });
		const [b, c] = ["b p3", "c p2"].map((t, n) => add(db, t, { priority: n ? 2 : 3 }));
		setOrder(db, "demo", [p1, b, c].map((x) => ref(db, x)));
		add(db, "new bug", { priority: 1, kind: "bug" });
		expect(titles(db)).toEqual(["old p1", "new bug", "b p3", "c p2"]);
		// P2 and P3 still go to the end
		add(db, "later p3", { priority: 3 });
		expect(titles(db).at(-1)).toBe("later p3");
		// made priority 1 later: the same place
		const later = listItems(db, { project: "demo", q: "later p3" })[0].id;
		updateItem(db, later, { priority: 1 }, "agent");
		expect(titles(db)).toEqual(["old p1", "new bug", "later p3", "b p3", "c p2"]);
		// a full-order setOrder with no priority-1 items ahead: it goes first
		const db2 = freshDb();
		const [x, y] = ["x", "y"].map((t) => add(db2, t));
		setOrder(db2, "demo", [ref(db2, x), ref(db2, y)]);
		add(db2, "z urgent", { priority: 1 });
		expect(titles(db2)).toEqual(["z urgent", "x", "y"]);
	});

	test("doing stays above todo; Kostas's items have no place in it", () => {
		const db = freshDb();
		const a = add(db, "a");
		const b = add(db, "b");
		const c = add(db, "c", { status: "doing" });
		setOrder(db, "demo", [ref(db, b), ref(db, a), ref(db, c)]);
		expect(titles(db)).toEqual(["c", "b", "a"]);
		const k = addItem(db, { title: "Ask", project: "demo", kind: "setup", owner: "kostas", body: BODY } as any, "agent");
		expect(() => setOrder(db, "demo", [ref(db, k)])).toThrow(/not open agent work/);
	});

	test("refused: another project's item, a closed item, an unknown ref, not a list; nothing changes", () => {
		const db = freshDb();
		addProject(db, { slug: "other", name: "Other", path: "/tmp/other" });
		const a = add(db, "a");
		const o = addItem(db, { title: "o", project: "other", kind: "task", owner: "agent", body: BODY } as any, "agent");
		const done = add(db, "done one");
		updateItem(db, done, { status: "done" }, "agent");
		expect(() => setOrder(db, "demo", [ref(db, a), ref(db, o)])).toThrow(/other, not demo/);
		expect(() => setOrder(db, "demo", [ref(db, done)])).toThrow(/not open agent work/);
		expect(() => setOrder(db, "demo", ["wb-nope"])).toThrow(/no item/);
		expect(() => setOrder(db, "demo", "wb-x" as any)).toThrow(/list/);
		expect(getItem(db, a)!.rank).toBeNull();
	});

	test("a newly filed agent item goes to the end, behind ranked and unranked alike", () => {
		const db = freshDb();
		const a = add(db, "a");
		const b = add(db, "b");
		add(db, "c");
		setOrder(db, "demo", [ref(db, b)]);
		add(db, "newer");
		expect(titles(db)).toEqual(["b", "a", "c", "newer"]);
		add(db, "urgent new", { priority: 1 });
		expect(titles(db)).toEqual(["urgent new", "b", "a", "c", "newer"]);
		expect(getItem(db, a)!.rank).not.toBeNull();
	});

	test("with no order yet, filing leaves the usual order alone", () => {
		const db = freshDb();
		add(db, "a");
		const n = add(db, "urgent", { priority: 1 });
		expect(getItem(db, n)!.rank).toBeNull();
		expect(titles(db)).toEqual(["urgent", "a"]);
	});

	test("closing, or giving the item to Kostas, takes it out of the order", () => {
		const db = freshDb();
		const [a, b, c] = ["a", "b", "c"].map((t) => add(db, t));
		setOrder(db, "demo", [ref(db, a), ref(db, b), ref(db, c)]);
		updateItem(db, a, { status: "done" }, "agent");
		updateItem(db, b, { owner: "kostas" }, "agent");
		expect(getItem(db, a)!.rank).toBeNull();
		expect(getItem(db, b)!.rank).toBeNull();
		expect(agentOrder(db, "demo").map((i) => i.title)).toEqual(["c"]);
	});

	test("moveInOrder: top, bottom, before, after", () => {
		const db = freshDb();
		const [a, b, c, d] = ["a", "b", "c", "d"].map((t) => add(db, t));
		moveInOrder(db, d, { top: true });
		expect(titles(db)).toEqual(["d", "a", "b", "c"]);
		moveInOrder(db, d, { bottom: true });
		expect(titles(db)).toEqual(["a", "b", "c", "d"]);
		moveInOrder(db, c, { before: a });
		expect(titles(db)).toEqual(["c", "a", "b", "d"]);
		moveInOrder(db, c, { after: b });
		expect(titles(db)).toEqual(["a", "b", "c", "d"]);
		expect(() => moveInOrder(db, a, { before: a })).toThrow(/itself/);
	});
});

describe("where the order is honoured", () => {
	test("MCP list_items, the next prompt and project_overview", async () => {
		const db = freshDb();
		const [, b, c] = NAMES.slice(0, 3).map((t) => add(db, t));
		add(db, "delta", { status: "doing" });
		setOrder(db, "demo", [ref(db, c), ref(db, b)]);
		const list = await rpc(db, "tools/call", { name: "list_items", arguments: { owner: "agent" } });
		expect(list.structuredContent.items.map((i: any) => i.title)).toEqual(["delta", "charlie", "bravo", "alpha"]);
		expect(list.structuredContent.items.find((i: any) => i.title === "charlie").rank).toBe(1);
		const next = await rpc(db, "prompts/get", { name: "next", arguments: {} });
		const text: string = next.messages[0].content.text;
		const at = (s: string) => text.indexOf(s);
		expect(at("delta")).toBeLessThan(at("charlie"));
		expect(at("charlie")).toBeLessThan(at("bravo"));
		expect(at("bravo")).toBeLessThan(at("alpha"));
		const ov: string = (await rpc(db, "tools/call", { name: "project_overview", arguments: {} })).content[0].text;
		expect(ov.indexOf("charlie")).toBeLessThan(ov.indexOf("bravo"));
		expect(ov.indexOf("bravo")).toBeLessThan(ov.indexOf("alpha"));
	});

	test("wb ls and wb order", async () => {
		const db = freshDb();
		const [a, b, c] = NAMES.slice(0, 3).map((t) => add(db, t));
		const ls = async () => names((await wb(db, ["ls", "--agents"])).text);
		expect(await ls()).toEqual(["alpha", "bravo", "charlie"]);
		expect((await wb(db, ["order", ref(db, c), "--top"])).code).toBe(0);
		expect(await ls()).toEqual(["charlie", "alpha", "bravo"]);
		await wb(db, ["order", ref(db, c), "--after", ref(db, a)]);
		expect(await ls()).toEqual(["alpha", "charlie", "bravo"]);
		await wb(db, ["order", ref(db, a), "--bottom"]);
		expect(await ls()).toEqual(["charlie", "bravo", "alpha"]);
		await wb(db, ["order", ref(db, a), "--before", ref(db, b)]);
		expect(await ls()).toEqual(["charlie", "alpha", "bravo"]);
		// no option: prints the order
		expect(names((await wb(db, ["order", ref(db, b)])).text)).toEqual(["charlie", "alpha", "bravo"]);
		expect((await wb(db, ["order", ref(db, b), "--top", "--bottom"])).code).toBe(1);
		expect((await wb(db, ["order", ref(db, b), "--before", "wb-nope"])).code).toBe(1);
	});
});
