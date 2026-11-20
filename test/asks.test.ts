// Asks that don't block (asks.ts): notices, defaults with a deadline, several picks, the cap on open asks.
import { describe, expect, test } from "bun:test";
import { addItem, answerItem, getItem, open, projectsWithCounts, updateItem } from "../src/db";
import { applyDue, capRefusal, deadlineText, needsKostas, parseDecideBy, resolveAsk, sqlTime } from "../src/asks";
import { mcpHttp } from "../src/mcp";
import { updateSettings } from "../src/settings";
import { freshDb } from "./helpers";

const BRIEF = "This is what changed on the board, and why: say if you'd rather it stayed as it was before.";
const past = (db: ReturnType<typeof freshDb>, id: number, hours = 1) =>
	db.query("UPDATE items SET decide_by = ? WHERE id = ?").run(sqlTime(new Date(Date.now() - hours * 3600e3)), id);
const notes = (db: ReturnType<typeof freshDb>, id: number) => getItem(db, id)!.notes.map((n) => n.text);

describe("notices", () => {
	test("a notice is Kostas's by default but doesn't count as waiting on them", () => {
		const db = freshDb();
		const n = addItem(db, { title: "Renamed Export to Download", project: "demo", kind: "notice", body: BRIEF }, "agent");
		addItem(db, { title: "Pick a colour", project: "demo", kind: "decision", body: BRIEF }, "agent");
		const i = getItem(db, n)!;
		expect(i.owner).toBe("kostas");
		expect(needsKostas(i)).toBe(false);
		const p = projectsWithCounts(db).find((p) => p.slug === "demo")!;
		expect(p.mine).toBe(1);
		expect(p.notices).toBe(1);
	});
	test("Got it closes it; an objection hands it back to the agent with the words", () => {
		const db = freshDb();
		const a = addItem(db, { title: "Seen this", project: "demo", kind: "notice", body: BRIEF }, "agent");
		resolveAsk(db, a, { ack: true }, "kostas");
		expect(getItem(db, a)!.status).toBe("done");
		expect(notes(db, a)).toContain("Got it");
		const b = addItem(db, { title: "Object to this", project: "demo", kind: "notice", body: BRIEF }, "agent");
		resolveAsk(db, b, { object: "Keep the old name, people know it" }, "kostas");
		const i = getItem(db, b)!;
		expect(i.owner).toBe("agent");
		expect(i.status).toBe("todo");
		expect(i.decide_by).toBeNull();
		expect(notes(db, b)).toContain("Objection: Keep the old name, people know it");
		expect(() => resolveAsk(db, b, { object: "  " })).toThrow();
	});
	test("a new notice gets the board's deadline and closes as seen when it passes", () => {
		const db = freshDb();
		const id = addItem(db, { title: "FYI", project: "demo", kind: "notice", body: BRIEF }, "agent");
		const by = getItem(db, id)!.decide_by!;
		const days = (Date.parse(by.replace(" ", "T") + "Z") - Date.now()) / 86400e3;
		expect(days).toBeGreaterThan(2.9);
		expect(days).toBeLessThan(3.1);
		past(db, id);
		applyDue(db);
		expect(getItem(db, id)!.status).toBe("done");
		expect(notes(db, id).some((t) => /^No answer by .+: closed as seen$/.test(t))).toBe(true);
	});
});

describe("defaults and deadlines", () => {
	test("decide_by takes a date, in N days, or none, and never the past", () => {
		const now = new Date(2026, 10, 12, 10, 0, 0);
		expect(parseDecideBy("in 3 days", now)).toBe(sqlTime(new Date(now.getTime() + 3 * 86400e3)));
		expect(parseDecideBy("2026-11-14", now)).toBe(sqlTime(new Date(2026, 10, 14, 23, 59, 59)));
		expect(parseDecideBy("none", now)).toBeNull();
		expect(() => parseDecideBy("2026-11-01", now)).toThrow(/passed/);
		expect(() => parseDecideBy("soonish", now)).toThrow();
	});
	test("a decision's default has to be one of its options", () => {
		const db = freshDb();
		expect(() => addItem(db, { title: "Pick", project: "demo", kind: "decision", options: ["Red", "Blue"], default_answer: "Green" })).toThrow(/options/);
		const id = addItem(db, { title: "Pick", project: "demo", kind: "decision", options: ["Red", "Blue"], default_answer: "2" });
		expect(getItem(db, id)!.default_answer).toBe("Blue");
		expect(() => addItem(db, { title: "Fix it", project: "demo", kind: "bug", default_answer: "ok" })).toThrow(/default/);
	});
	test("past its deadline the default is the answer, back with the agent; the history says so", () => {
		const db = freshDb();
		const id = addItem(db, { title: "Pick", project: "demo", kind: "decision", options: ["Red", "Blue"], default_answer: "Blue", body: BRIEF }, "agent");
		expect(deadlineText(getItem(db, id)!)).toMatch(/^goes ahead with Blue on \w{3} \d+ \w{3}$/);
		expect(applyDue(db)).toEqual([]);
		past(db, id);
		expect(applyDue(db)).toEqual([getItem(db, id)!.ref]);
		const i = getItem(db, id)!;
		expect(i.answer).toBe("Blue");
		expect(i.owner).toBe("agent");
		expect(i.decide_by).toBeNull();
		expect(notes(db, id).some((t) => /^No answer by .+: went ahead with Blue$/.test(t))).toBe(true);
		// Once answered it never goes ahead again.
		expect(applyDue(db)).toEqual([]);
	});
	test("a review's default closes it; one without a default never goes ahead", () => {
		const db = freshDb();
		const r = addItem(db, { title: "Wording", project: "demo", kind: "review", default_answer: "ships as written", body: BRIEF }, "agent");
		const plain = addItem(db, { title: "Wording 2", project: "demo", kind: "review", body: BRIEF }, "agent");
		expect(getItem(db, plain)!.decide_by).toBeNull();
		past(db, r);
		past(db, plain);
		applyDue(db);
		expect(getItem(db, r)!.status).toBe("done");
		expect(notes(db, r).some((t) => t.endsWith("went ahead with ships as written"))).toBe(true);
		expect(getItem(db, plain)!.status).toBe("todo");
	});
	test("answering before the deadline ends it; a deadline can be changed or removed", () => {
		const db = freshDb();
		const id = addItem(db, { title: "Pick", project: "demo", kind: "decision", options: ["Red", "Blue"], default_answer: "Blue" });
		updateItem(db, id, { decide_by: "none" }, "kostas");
		expect(getItem(db, id)!.decide_by).toBeNull();
		expect(notes(db, id).at(-1)).toBe("deadline: none");
		updateItem(db, id, { decide_by: "in 2 days" }, "kostas");
		expect(getItem(db, id)!.decide_by).not.toBeNull();
		answerItem(db, id, "Red");
		expect(getItem(db, id)!.decide_by).toBeNull();
		expect(getItem(db, id)!.answer).toBe("Red");
	});
	test("the lazy path: wb applies the default when it opens the board, with no server running", async () => {
		const db = freshDb();
		const id = addItem(db, { title: "Pick", project: "demo", kind: "decision", options: ["Red", "Blue"], default_answer: "Red", body: BRIEF }, "agent");
		past(db, id);
		const file = (db.query("PRAGMA database_list").get() as { file: string }).file;
		const run = Bun.spawnSync(["bun", `${import.meta.dir}/../src/wb.ts`, "show", `wb-${getItem(db, id)!.ref}`], {
			env: { ...process.env, WB_DB: file, CLAUDECODE: "" },
		});
		expect(run.exitCode).toBe(0);
		expect(run.stdout.toString()).toContain("answer: Red");
		expect(getItem(open(file), id)!.answer).toBe("Red");
	});
});

describe("pick several", () => {
	const many = (db: ReturnType<typeof freshDb>, more = {}) =>
		addItem(db, { title: "Which extras to build", project: "demo", kind: "decision", pick: "many", options: ["Change password", "Signed-out message", "Dark mode"], ...more });
	test("the answer stays readable text, with the picks kept as a list", () => {
		const db = freshDb();
		const id = many(db, { recommended: ["Change password", "Signed-out message"] });
		expect(JSON.parse(getItem(db, id)!.recommended)).toEqual(["Change password", "Signed-out message"]);
		answerItem(db, id, ["Change password", "3"]);
		const i = getItem(db, id)!;
		expect(i.answer).toBe("Change password; Dark mode");
		expect(JSON.parse(i.picks)).toEqual(["Change password", "Dark mode"]);
		expect(i.owner).toBe("agent");
	});
	test('"1, 3" and none work too; a pick that isn\'t an option is refused', () => {
		const db = freshDb();
		const a = many(db);
		answerItem(db, a, "1, 3");
		expect(getItem(db, a)!.answer).toBe("Change password; Dark mode");
		const b = many(db);
		answerItem(db, b, []);
		expect(getItem(db, b)!.answer).toBe("None of them");
		expect(getItem(db, b)!.picks).toBe("[]");
		expect(() => answerItem(db, many(db), ["Change password", "Rockets"])).toThrow(/options/);
	});
	test("a pick-many default goes ahead as its list, [] meaning none of them", () => {
		const db = freshDb();
		const id = many(db, { default_answer: [], body: BRIEF });
		expect(deadlineText(getItem(db, id)!)).toContain("none of them");
		past(db, id);
		applyDue(db);
		expect(getItem(db, id)!.answer).toBe("None of them");
		expect(() => addItem(db, { title: "One", project: "demo", kind: "decision", options: ["A", "B"], recommended: ["A", "B"] })).toThrow(/many/);
	});
});

describe("the cap on open asks", () => {
	test("past the cap an agent's ask is refused; notices, priority 1 and Kostas's own get through", () => {
		const db = freshDb();
		updateSettings(db, { "asks.cap": 2 });
		const ask = { project: "demo", kind: "decision", owner: "kostas" };
		addItem(db, { title: "One", project: "demo", kind: "decision" }, "agent");
		expect(capRefusal(db, ask)).toBeUndefined();
		addItem(db, { title: "Two", project: "demo", kind: "review" }, "agent");
		// Kostas's own items don't count.
		addItem(db, { title: "Mine", project: "demo", kind: "check" }, "kostas");
		expect(capRefusal(db, ask)).toMatch(/at most 2.*pick "many".*notice/s);
		expect(capRefusal(db, { ...ask, kind: "notice" })).toBeUndefined();
		expect(capRefusal(db, { ...ask, priority: 1 })).toBeUndefined();
		updateSettings(db, { "asks.cap": 0 });
		expect(capRefusal(db, ask)).toBeUndefined();
	});
	test("add_item refuses past the cap and teaches what to do instead", async () => {
		const db = freshDb();
		updateSettings(db, { "asks.cap": 1 });
		const call = async (name: string, args: Record<string, unknown>) => {
			const req = new Request("http://localhost:4401/mcp?project=demo", {
				method: "POST",
				headers: { "content-type": "application/json", host: "localhost:4401", "mcp-protocol-version": "2025-06-18" },
				body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
			});
			const r = ((await (await mcpHttp(req, db, { loopback: true })).json()) as any).result;
			return { text: r.content[0].text as string, data: r.structuredContent, error: r.isError as boolean };
		};
		const first = await call("add_item", { title: "Pick a name", kind: "decision", options: ["A", "B"], default: "A", decide_by: "in 2 days", body: BRIEF });
		expect(first.error).toBe(false);
		expect(first.data.item.default).toBe("A");
		expect(first.data.item.waits_on_kostas).toBe(true);
		const second = await call("add_item", { title: "Pick a colour", kind: "decision", options: ["Red", "Blue"], body: BRIEF });
		expect(second.error).toBe(true);
		expect(second.text).toContain("Nothing was filed");
		const notice = await call("add_item", { title: "Renamed a button", kind: "notice", body: BRIEF });
		expect(notice.error).toBe(false);
		expect(notice.data.item.waits_on_kostas).toBe(false);
		const listed = await call("list_projects", {});
		const p = listed.data.projects.find((p: any) => p.slug === "demo");
		expect(p.open_for_kostas).toBe(1);
		expect(p.notices_for_kostas).toBe(1);
		// The tool descriptions agents read stay under Claude Code's 2048-character cut.
		const req = new Request("http://localhost:4401/mcp", {
			method: "POST",
			headers: { "content-type": "application/json", host: "localhost:4401", "mcp-protocol-version": "2025-06-18" },
			body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
		});
		const tools = ((await (await mcpHttp(req, db, { loopback: true })).json()) as any).result.tools;
		for (const t of tools) expect(t.description.length).toBeLessThanOrEqual(2048);
	});
});
