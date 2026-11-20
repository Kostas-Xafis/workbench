import { describe, expect, test } from "bun:test";
import {
	addItem, addNote, addProject, answerItem, getItem, getProject, itemOptions, listItems, listReports, getReport,
	projects, publishReport, reportHtml, resolveItem, search, updateItem, updateProject,
} from "../src/db";
import { getSetting, getSettings, updateSettings } from "../src/settings";
import { freshDb } from "./helpers";

const db = freshDb();
const add = (title: string, more: Record<string, unknown> = {}) => addItem(db, { title, project: "demo", ...more });
const notes = (id: number) => getItem(db, id)!.notes.map((n) => n.text);

describe("projects", () => {
	test("add, list, update and archive", () => {
		const p = addProject(db, { slug: "second", name: "Second", path: "/tmp/second/" });
		expect(p.path).toBe("/tmp/second");
		expect(projects(db).map((x) => x.slug)).toEqual(["demo", "second"]);
		expect(updateProject(db, "second", { name: "Two" }).name).toBe("Two");
		expect(updateProject(db, "second", { archived: true }).archived_at).toBeTruthy();
		expect(projects(db).find((x) => x.slug === "second")!.archived_at).toBeTruthy();
		updateProject(db, "second", { archived: false });
		expect(getProject(db, "second")!.archived_at).toBeNull();
	});
	test("a bad or taken slug is refused", () => {
		expect(() => addProject(db, { slug: "Bad Slug", name: "x", path: "" })).toThrow();
		expect(() => addProject(db, { slug: "demo", name: "x", path: "" })).toThrow(/already/);
	});
	test("new work brings an archived project back", () => {
		addProject(db, { slug: "old", name: "Old", path: "" });
		updateProject(db, "old", { archived: true });
		addItem(db, { title: "again", project: "old" });
		expect(getProject(db, "old")!.archived_at).toBeNull();
	});
});

describe("items", () => {
	test("add gives a ref that resolves as wb-xxxx, bare and by number", () => {
		const id = add("First");
		const item = getItem(db, id)!;
		expect(item.ref).toMatch(/^[a-z0-9]{4}$/);
		expect(resolveItem(db, `wb-${item.ref}`)).toBe(id);
		expect(resolveItem(db, item.ref!)).toBe(id);
		expect(resolveItem(db, ` WB-${item.ref!.toUpperCase()} `)).toBe(id);
		expect(resolveItem(db, `#${id}`)).toBe(id);
		expect(resolveItem(db, "wb-zzzz")).toBeUndefined();
		expect(resolveItem(db, "")).toBeUndefined();
		expect(notes(id)).toEqual(["created"]);
	});
	test("start, wait, finish and drop move status and keep history", () => {
		const id = add("Flow");
		updateItem(db, id, { status: "doing", branch: "feat/x" }, "agent");
		expect(getItem(db, id)).toMatchObject({ status: "doing", branch: "feat/x", done_at: null });
		updateItem(db, id, { status: "waiting" });
		addNote(db, id, "on a review", "agent");
		updateItem(db, id, { status: "done" });
		expect(getItem(db, id)!.done_at).toBeTruthy();
		updateItem(db, id, { status: "todo" });
		expect(getItem(db, id)!.done_at).toBeNull();
		updateItem(db, id, { status: "dropped" });
		expect(getItem(db, id)!.done_at).toBeTruthy();
		const history = notes(id);
		expect(history).toContain("status: todo → doing · branch: — → feat/x");
		expect(history).toContain("on a review");
		expect(history).toContain("status: todo → dropped");
		expect(getItem(db, id)!.notes.find((n) => n.text === "on a review")!.author).toBe("agent");
	});
	test("a change that changes nothing adds no note", () => {
		const id = add("Same");
		updateItem(db, id, { title: "Same", priority: 2 });
		expect(notes(id)).toEqual(["created"]);
	});
	test("owner defaults by kind come from settings", () => {
		for (const k of ["decision", "setup", "check", "review"]) expect(getItem(db, add(k, { kind: k }))!.owner).toBe("kostas");
		for (const k of ["task", "bug", "idea"]) expect(getItem(db, add(k, { kind: k }))!.owner).toBe("agent");
		expect(getItem(db, add("no kind"))!.owner).toBe("agent");
		updateSettings(db, { "owner.bug": "kostas" });
		expect(getItem(db, add("now mine", { kind: "bug" }))!.owner).toBe("kostas");
		expect(getItem(db, add("said so", { kind: "bug", owner: "agent" }))!.owner).toBe("agent");
		updateSettings(db, { "owner.bug": "agent" });
	});
	test("bad values are refused", () => {
		expect(() => add("x", { kind: "chore" })).toThrow(/kind/);
		expect(() => add("x", { status: "nope" })).toThrow(/status/);
		expect(() => add("x", { priority: 9 })).toThrow(/priority/);
		expect(() => add("  ")).toThrow(/title/);
		expect(() => updateItem(db, 99999, { title: "x" })).toThrow(/no item/);
	});
	test("list filters by owner, kind, status and text", () => {
		const d = freshDb();
		const a = addItem(d, { title: "Alpha thing", project: "demo", kind: "bug" });
		addItem(d, { title: "Beta", project: "demo", kind: "decision", body: "needle inside" });
		const c = addItem(d, { title: "Gamma", project: "demo", status: "done" });
		expect(listItems(d, { owner: "kostas" }).map((i) => i.title)).toEqual(["Beta"]);
		expect(listItems(d, { kind: "bug" }).map((i) => i.id)).toEqual([a]);
		expect(listItems(d, { status: ["done"] }).map((i) => i.id)).toEqual([c]);
		expect(listItems(d, { q: "needle" }).map((i) => i.title)).toEqual(["Beta"]);
		expect(listItems(d, { q: `wb-${getItem(d, a)!.ref}` }).map((i) => i.id)).toEqual([a]);
	});
});

describe("decisions", () => {
	test("options are kept as a list, trimmed", () => {
		const id = add("Pick", { kind: "decision", options: [" A ", "", "B"] });
		expect(itemOptions(getItem(db, id)!)).toEqual(["A", "B"]);
		updateItem(db, id, { options: ["C"] });
		expect(itemOptions(getItem(db, id)!)).toEqual(["C"]);
		expect(itemOptions(getItem(db, add("none"))!)).toEqual([]);
	});
	test("an answer by text or by number goes back to the agent", () => {
		const id = add("Pick", { kind: "decision", options: ["Red", "Blue"] });
		answerItem(db, id, "2");
		expect(getItem(db, id)).toMatchObject({ answer: "Blue", owner: "agent", status: "todo" });
		const other = add("Pick 2", { kind: "decision", options: ["Red", "Blue"], status: "doing" });
		answerItem(db, other, "my own words", "agent");
		expect(getItem(db, other)).toMatchObject({ answer: "my own words", owner: "agent", status: "doing" });
		expect(() => answerItem(db, id, "  ")).toThrow(/empty/);
		expect(() => answerItem(db, 99999, "x")).toThrow(/no item/);
	});
});

describe("search", () => {
	test("finds items by title, body and notes, and reports by text", () => {
		const d = freshDb();
		const id = addItem(d, { title: "Fix the zebra", project: "demo" });
		addNote(d, id, "found a quokka", "agent");
		publishReport(d, { project: "demo", name: "r1", html: "<title>Notes</title><p>an ocelot walks</p>" });
		expect(search(d, "zebra").items.map((i) => i.id)).toEqual([id]);
		expect(search(d, "quokka").items.map((i) => i.id)).toEqual([id]);
		const r = search(d, "ocelot");
		expect(r.reports.map((x) => x.name)).toEqual(["r1"]);
		expect(r.reports[0].snippet).toContain("ocelot");
		expect(search(d, "nothing-like-this")).toEqual({ items: [], reports: [], links: [], rulings: [], goals: [] });
	});
});

describe("reports", () => {
	test("publish makes versions, an identical page makes none", () => {
		const d = freshDb();
		const a = publishReport(d, { project: "demo", name: "Status", html: "<h1>One</h1>", icon: "📈" }, "agent");
		expect(a).toMatchObject({ n: 1, changed: true });
		expect(publishReport(d, { project: "demo", name: "status", html: "<h1>One</h1>" })).toMatchObject({ id: a.id, n: 1, changed: false });
		expect(publishReport(d, { project: "demo", name: "status", html: "<h1>Two</h1>" })).toMatchObject({ id: a.id, n: 2, changed: true });
		const r = getReport(d, a.id)!;
		expect(r).toMatchObject({ name: "status", title: "Two", icon: "📈" });
		expect(r.versions.map((v) => v.n).sort()).toEqual([1, 2]);
		expect(reportHtml(d, a.id)!.html).toBe("<h1>Two</h1>");
		expect(reportHtml(d, a.id, 1)!.html).toBe("<h1>One</h1>");
		expect(listReports(d, "demo")).toHaveLength(1);
	});
	test("an empty page, a blank name or an unknown project is refused", () => {
		const d = freshDb();
		expect(() => publishReport(d, { project: "demo", name: "x", html: " " })).toThrow(/empty/);
		expect(() => publishReport(d, { project: "demo", name: " ", html: "<p>x</p>" })).toThrow(/name/);
		expect(() => publishReport(d, { project: "nope", name: "x", html: "<p>x</p>" })).toThrow(/no project/);
	});
});

describe("settings", () => {
	test("defaults, writes and checks", () => {
		const d = freshDb();
		expect(getSetting(d, "name")).toBe("Kostas");
		expect(getSetting(d, "backups.keep")).toBe(14);
		updateSettings(d, { name: "Sam", "day.start": 6 });
		expect(getSettings(d)).toMatchObject({ name: "Sam", "day.start": 6 });
		expect(() => updateSettings(d, { "day.start": 99 })).toThrow();
		expect(() => updateSettings(d, { name: "" })).toThrow();
		expect(() => updateSettings(d, { "no.such": 1 })).toThrow();
		expect(getSetting(d, "day.start")).toBe(6);
	});
});
