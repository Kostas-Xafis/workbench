// Autopilot (autopilot.ts): a project's Next up starts by itself when a slot is free. A fake launcher stands in for
// the process: a run stays "running" until the test ends it, and nothing real starts.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { addItem, addProject, getItem, getProject, open } from "../src/db";
import { waitOn } from "../src/links";
import { setOrder } from "../src/order";
import { costs, endRun, getRun, launcher, newLive, setItemChoice, startRun, type Launch, type Run } from "../src/dispatch";
import { addTracker, recordReading } from "../src/trackers";
import { updateSettings } from "../src/settings";
import { autopilotAny, autopilotPick, autopilotStates, inHours, runAutopilot, setAutopilot, trackerHold } from "../src/autopilot";
import { exportLines, importExport, localTarget } from "../src/export";
import { freshDb } from "./helpers";

const dir = mkdtempSync(join(process.env.WB_TEST_DIR!, "autopilot-"));
const folder = (name: string) => {
	const f = join(dir, name);
	mkdirSync(f, { recursive: true });
	return f;
};
const launched: Launch[] = [];
const realLaunch = launcher.launch;
const realCost = costs.of;
launcher.launch = async (spec) => {
	launched.push(spec);
	return { pid: 0, unit: "" };
};
afterAll(() => {
	launcher.launch = realLaunch;
	costs.of = realCost;
});

const db = freshDb();
addProject(db, { slug: "alpha", name: "Alpha", path: folder("alpha") });
addProject(db, { slug: "beta", name: "Beta", path: folder("beta") });
const set = (patch: Record<string, unknown>) => updateSettings(db, patch);
const task = (title: string, project = "alpha", more: Record<string, unknown> = {}) => addItem(db, { title, project, owner: "agent", ...more });
const end = (r: Pick<Run, "id" | "item_id">, code = 0) => endRun(db, { ...r, status: "running", error: "" }, code, newLive());
/** Ends every run still going and clears the board's items, so each test starts from nothing. */
function reset() {
	for (const r of db.query("SELECT id, item_id FROM runs WHERE ended_at IS NULL").all() as Run[]) end(r);
	db.run("DELETE FROM runs");
	db.run("DELETE FROM notes");
	db.run("DELETE FROM item_links");
	db.run("DELETE FROM items");
	db.run("DELETE FROM trackers");
	db.run("UPDATE projects SET autopilot = 0");
	set({ "agents.on": true, "agents.command": 'fake -p "$WB_PROMPT"', "agents.at-once": 5, "agents.per-day": 50, "agents.day-dollars": 0, "agents.autopilot-hours": null, "agents.autopilot-zone": null, "agents.autopilot-trackers": null });
	launched.length = 0;
	costs.of = async () => new Map();
}
beforeEach(reset);

describe("autopilot", () => {
	test("off by default: a project's Next up waits, and nothing is said about it", async () => {
		task("One");
		expect(getProject(db, "alpha")!.autopilot).toBe(0);
		expect(autopilotAny(db)).toBe(false);
		expect(await runAutopilot(db)).toEqual([]);
		expect(await autopilotStates(db)).toEqual([]);
		expect(launched).toHaveLength(0);
	});

	test("on: the first item of Next up an agent can run, with the item's own choices, said in its history", async () => {
		const idea = task("An idea", "alpha", { kind: "idea" });
		const mine = addItem(db, { title: "Yours", project: "alpha", kind: "decision", owner: "kostas" });
		const blocked = task("Blocked");
		waitOn(db, blocked, [mine]);
		const a = task("A");
		const b = task("B");
		setItemChoice(db, b, { model: "opus" });
		setOrder(db, "alpha", [`wb-${getItem(db, b)!.ref}`, `wb-${getItem(db, a)!.ref}`]);
		expect(autopilotPick(db, "alpha").item?.id).toBe(b);
		setAutopilot(db, "alpha", true);
		expect(autopilotAny(db)).toBe(true);
		const [r, ...more] = await runAutopilot(db);
		expect(more).toEqual([]);
		expect(r.item_id).toBe(b);
		expect(r).toMatchObject({ started_from: "autopilot", started_by: "board" });
		expect(launched[0].command).toContain("--model opus");
		const notes = getItem(db, b)!.notes.map((n) => n.text);
		expect(notes).toContain(`Agent started by autopilot (run #${r.id}, with Opus)`);
		for (const id of [idea, mine, blocked, a]) expect(getRun(db, r.id)!.item_id).not.toBe(id);
		expect(await autopilotStates(db)).toEqual([{ slug: "alpha", on: true, why: "", run: { id: r.id, ref: getItem(db, b)!.ref } }]);
	});

	test("one at a time per project; the next goes when it ends; each project gets its turn", async () => {
		const a1 = task("A1"), a2 = task("A2"), b1 = task("B1", "beta");
		setAutopilot(db, "alpha", true);
		setAutopilot(db, "beta", true);
		const first = await runAutopilot(db);
		expect(first.map((r) => r.item_id).sort()).toEqual([a1, b1].sort());
		expect(await runAutopilot(db)).toEqual([]);
		// A run Kostas started counts as the project's one too.
		end(first.find((r) => r.item_id === a1)!);
		db.query("UPDATE items SET status = 'done' WHERE id = ?").run(a1);
		const manual = await startRun(db, a2, { where: "local", label: "this computer" });
		expect(await runAutopilot(db)).toEqual([]);
		end(manual);
		db.query("UPDATE items SET status = 'done' WHERE id = ?").run(a2);
		// With one slot, the project autopilot started least lately goes first: alpha (a1's run is older than b1's).
		for (const r of db.query("SELECT id, item_id FROM runs WHERE ended_at IS NULL").all() as Run[]) end(r);
		db.query("UPDATE items SET status = 'done' WHERE id = ?").run(b1);
		const a3 = task("A3"), b2 = task("B2", "beta");
		set({ "agents.at-once": 1 });
		const [next] = await runAutopilot(db);
		expect(next.item_id).toBe(a3);
		expect(await runAutopilot(db)).toEqual([]);
		expect((await autopilotStates(db)).find((s) => s.slug === "beta")!.why).toContain("the most at once");
		end(next);
		db.query("UPDATE items SET status = 'done' WHERE id = ?").run(a3);
		expect((await runAutopilot(db)).map((r) => r.item_id)).toEqual([b2]);
	});

	test("within every limit: at once, per day, a day's usage", async () => {
		task("A"), task("B"), task("C", "beta");
		setAutopilot(db, "alpha", true);
		setAutopilot(db, "beta", true);
		set({ "agents.at-once": 1 });
		expect(await runAutopilot(db)).toHaveLength(1);
		for (const r of db.query("SELECT id, item_id FROM runs WHERE ended_at IS NULL").all() as Run[]) end(r);
		set({ "agents.at-once": 5, "agents.per-day": 1 });
		expect(await runAutopilot(db)).toEqual([]);
		expect((await autopilotStates(db))[0].why).toContain("the most per day");
		set({ "agents.per-day": 50, "agents.day-dollars": 3 });
		costs.of = async (sessions) => new Map(sessions.map((s) => [s, 5]));
		expect(await runAutopilot(db)).toEqual([]);
		expect((await autopilotStates(db))[0].why).toContain("the cap is $3");
		// Agents off: paused, said so.
		set({ "agents.day-dollars": 0, "agents.on": false });
		expect(await runAutopilot(db)).toEqual([]);
		expect((await autopilotStates(db))[0].why).toBe("Paused: the board doesn't start agents (Settings → Agents)");
	});

	test("its hours: outside them it waits, and says for what", async () => {
		const a = task("A");
		setAutopilot(db, "alpha", true);
		set({ "agents.autopilot-hours": "22:00 – 08:00", "agents.autopilot-zone": "UTC" });
		const noon = new Date("2026-11-26T12:00:00Z"), night = new Date("2026-11-26T23:30:00Z"), early = new Date("2026-11-27T07:59:00Z");
		expect([inHours(db, noon), inHours(db, night), inHours(db, early)]).toEqual([false, true, true]);
		expect(await runAutopilot(db, noon)).toEqual([]);
		expect((await autopilotStates(db, noon))[0].why).toBe("Waits for its hours: 22:00–08:00");
		// Another zone moves them: 13:00 UTC is 22:00 in Tokyo.
		set({ "agents.autopilot-zone": "Asia/Tokyo" });
		expect(inHours(db, new Date("2026-11-26T13:00:00Z"))).toBe(true);
		expect(() => set({ "agents.autopilot-zone": "Mars/Base" })).toThrow("no time zone");
		expect(() => set({ "agents.autopilot-hours": "late" })).toThrow("22:00-08:00");
		set({ "agents.autopilot-zone": "UTC" });
		expect((await runAutopilot(db, night)).map((r) => r.item_id)).toEqual([a]);
	});

	test("a tracker at bad pauses it (warn when Settings says); one that couldn't read doesn't", async () => {
		const a = task("A");
		setAutopilot(db, "alpha", true);
		const plan = addTracker(db, { project: "", name: "plan", title: "Plan usage" });
		recordReading(db, plan.id, "92/100");
		expect(trackerHold(db, "alpha")).toBe("Plan usage at 92%");
		expect(await runAutopilot(db)).toEqual([]);
		expect((await autopilotStates(db))[0].why).toBe("Paused: Plan usage at 92%");
		// Another project's tracker doesn't hold this one.
		recordReading(db, plan.id, "80/100");
		const other = addTracker(db, { project: "beta", name: "builds", title: "Builds" });
		recordReading(db, other.id, "10/10");
		expect(trackerHold(db, "alpha")).toBe("");
		set({ "agents.autopilot-trackers": "warn" });
		expect(trackerHold(db, "alpha")).toBe("Plan usage at 80%");
		db.query("UPDATE trackers SET error = 'timed out' WHERE id = ?").run(plan.id);
		expect(trackerHold(db, "alpha")).toBe("");
		db.query("UPDATE trackers SET error = '' WHERE id = ?").run(plan.id);
		set({ "agents.autopilot-trackers": "off" });
		expect((await runAutopilot(db)).map((r) => r.item_id)).toEqual([a]);
	});

	test("a run that fails doesn't loop: that item waits for Kostas, the next one goes", async () => {
		const a = task("A"), b = task("B");
		setAutopilot(db, "alpha", true);
		const [r] = await runAutopilot(db);
		expect(r.item_id).toBe(a);
		end(r, 1);
		expect(getRun(db, r.id)!.status).toBe("failed");
		expect(getItem(db, a)!.status).toBe("todo");
		const [next] = await runAutopilot(db);
		expect(next.item_id).toBe(b);
		end(next, 1);
		expect(await runAutopilot(db)).toEqual([]);
		expect((await autopilotStates(db))[0].why).toBe("Nothing in Next up an agent can run");
		// Kostas runs it again himself: it's his now, and once that ends well autopilot may pick it again.
		const again = await startRun(db, a, { where: "local", label: "this computer" });
		end(again);
		expect((await runAutopilot(db)).map((x) => x.item_id)).toEqual([a]);
	});

	test("a start that can't happen is refused, and leaves nothing behind", async () => {
		task("A", "alpha");
		setAutopilot(db, "alpha", true);
		db.query("UPDATE projects SET path = ? WHERE slug = 'alpha'").run(join(dir, "gone"));
		expect(await runAutopilot(db)).toEqual([]);
		expect((await autopilotStates(db))[0].why).toContain("has no folder on this computer");
		db.query("UPDATE projects SET path = ? WHERE slug = 'alpha'").run(folder("alpha"));
		// An archived project's autopilot is off.
		db.run("UPDATE projects SET archived_at = datetime('now') WHERE slug = 'alpha'");
		expect(await autopilotStates(db)).toEqual([]);
		expect(await runAutopilot(db)).toEqual([]);
		db.run("UPDATE projects SET archived_at = NULL WHERE slug = 'alpha'");
		expect(() => setAutopilot(db, "nope", true)).toThrow('no project "nope"');
		expect(() => setAutopilot(db, "alpha", "yes")).toThrow("true or false");
	});

	test("the switch goes through an export and back; an older export's projects come in with it off", async () => {
		setAutopilot(db, "alpha", true);
		const text = [...exportLines(db)].join("").split("\n").filter(Boolean);
		const into = open(join(mkdtempSync(join(dir, "into-")), "workbench.db"));
		await importExport(text, localTarget(into), { schema: into });
		expect(getProject(into, "alpha")!.autopilot).toBe(1);
		expect(getProject(into, "beta")!.autopilot).toBe(0);
		const header = JSON.parse(text[0]);
		const cols = header.tables.find((t: { name: string }) => t.name === "projects").columns as string[];
		const at = cols.indexOf("autopilot");
		cols.splice(at, 1);
		const older = [JSON.stringify(header), ...text.slice(1).map((l) => {
			const o = JSON.parse(l);
			if (o.t === "projects") o.r.splice(at, 1);
			return JSON.stringify(o);
		})];
		const old = open(join(mkdtempSync(join(dir, "old-")), "workbench.db"));
		const back = await importExport(older, localTarget(old), { schema: old });
		expect(back.left).toEqual([]);
		expect(getProject(old, "alpha")!.autopilot).toBe(0);
	});
});
