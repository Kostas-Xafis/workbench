// Running a check on a device (checkruns.ts): cutting a brief into steps, saving and resuming a run, finishing
// with everything passed, and finishing with failures (bugs with the photos, the check waiting on them).
import { describe, expect, test } from "bun:test";
import { addItem, getItem, updateItem } from "../db";
import { addStepPhoto, finishRun, parseCheck, removeStepPhoto, runState, runText, saveStep, startOver } from "../checkruns";
import { itemImages } from "../images";
import { mcpHttp } from "../mcp";
import { freshDb } from "./helpers";

const db = freshDb();
// A one-pixel PNG.
const PNG = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64"));
const photo = { data: PNG, type: "image/png", width: 1, height: 1 };
const BRIEF = `Try the date picker on the phone.

1. Open the day page and tap the date.
   - Right: the system dialog opens.
2. Pick another date.
3. Try a date before 1924.
   - Right: you can't pick it.
   - Try 1900 too.

**Right looks like:** the page shows the date you picked.

**Wrong looks like:** the page doesn't change, or crashes.`;
const check = (body = BRIEF, title = "Check the date picker") => addItem(db, { title, project: "demo", kind: "check", body });

describe("steps", () => {
	test("numbered list: nested bullets stay with their step, right/wrong sections are kept apart", () => {
		const p = parseCheck(BRIEF, "t");
		expect(p.numbered).toBe(true);
		expect(p.steps.map((s) => s.title)).toEqual(["Open the day page and tap the date.", "Pick another date.", "Try a date before 1924."]);
		expect(p.steps[0].detail).toBe("- Right: the system dialog opens.");
		expect(p.steps[2].detail).toContain("Try 1900 too.");
		expect(p.right).toBe("the page shows the date you picked.");
		expect(p.wrong).toBe("the page doesn't change, or crashes.");
		expect(p.steps.every((s) => s.group === undefined)).toBe(true);
	});
	test("no numbered list: one step, the whole brief", () => {
		const p = parseCheck("Look at the update badge in the Preview app. It should be red.", "See the update badge");
		expect(p.numbered).toBe(false);
		expect(p.steps).toHaveLength(1);
		expect(p.steps[0].title).toBe("See the update badge");
		expect(p.steps[0].detail).toContain("update badge in the Preview app");
		expect(parseCheck("", "Empty").steps).toHaveLength(1);
	});
	test("headings and a plain 'Wrong:' line are sections; a heading ends one", () => {
		const p = parseCheck("1. Do a thing\n2. Do another\n\n## What right looks like\n- it works\n- no cut-off text\n\n## Other\n\nnotes", "t");
		expect(p.steps).toHaveLength(2);
		expect(p.right).toBe("- it works\n- no cut-off text");
		expect(parseCheck("1. a\n\nWrong: the page crashes.", "t").wrong).toBe("the page crashes.");
	});
	test("a loose list (blank lines between) and ')' numbers are one list; several lists carry their headings", () => {
		expect(parseCheck("1) one\n\n2) two\n\n3) three", "t").steps.map((s) => s.title)).toEqual(["one", "two", "three"]);
		const p = parseCheck("**Setup**\n1. Install it.\n2. Open it.\n\n**What to check**\n1. Tap the button.\n2. Look at the colour.", "t");
		expect(p.steps.map((s) => [s.n, s.group, s.title])).toEqual([
			[1, "Setup", "Install it."], [2, "Setup", "Open it."], [3, "What to check", "Tap the button."], [4, "What to check", "Look at the colour."],
		]);
	});
	test("a numbered line inside a code fence is not a step", () => {
		const p = parseCheck("1. Run this:\n```\n2. not a step\n```\n2. Look.", "t");
		expect(p.steps.map((s) => s.title)).toEqual(["Run this:", "Look."]);
		expect(p.steps[0].detail).toContain("2. not a step");
	});
});

describe("a run", () => {
	test("results are saved as you go, and resume; a fail needs words or a photo", () => {
		const id = check();
		expect(runState(db, id).started).toBe(false);
		saveStep(db, id, 0, { result: "pass" }, "Safari on iPhone");
		saveStep(db, id, 1, { result: "pass", words: "fine" }, "Safari on iPhone");
		expect(() => saveStep(db, id, 2, { result: "fail" })).toThrow(/Say what went wrong/);
		expect(() => saveStep(db, id, 9, { result: "pass" })).toThrow(/no step 10/);
		const s = runState(db, id);
		expect(s.started).toBe(true);
		expect(s.results.map((r) => r.result)).toEqual(["pass", "pass", ""]);
		expect(s.results[1].words).toBe("fine");
		expect(s.results[0].device).toBe("Safari on iPhone");
		// Changing an answer, and clearing one.
		saveStep(db, id, 1, { result: "fail", words: "wrong date" });
		expect(runState(db, id).results[1].result).toBe("fail");
		saveStep(db, id, 1, { result: "" });
		expect(runState(db, id).results[1].result).toBe("");
		expect(() => finishRun(db, id)).toThrow(/not done yet: 2, 3/);
	});
	test("a photo is captioned with its step, then with how it went; it can be removed", () => {
		const id = check();
		let s = addStepPhoto(db, id, 2, photo);
		expect(s.results[2].images).toHaveLength(1);
		expect(itemImages(db, id)[0].caption).toBe("Step 3: Try a date before 1924.");
		// A photo alone is enough for a fail.
		s = saveStep(db, id, 2, { result: "fail", words: "" });
		saveStep(db, id, 2, { result: "fail", words: "shows 1900" });
		expect(itemImages(db, id)[0].caption).toBe("Step 3: Try a date before 1924. — failed: shows 1900");
		s = removeStepPhoto(db, id, 2, s.results[2].images[0].id);
		expect(s.results[2].images).toHaveLength(0);
		expect(itemImages(db, id)).toHaveLength(0);
	});
	test("start over clears the answers and their photos", () => {
		const id = check();
		saveStep(db, id, 0, { result: "pass" });
		addStepPhoto(db, id, 1, photo);
		const s = startOver(db, id);
		expect(s.started).toBe(false);
		expect(itemImages(db, id)).toHaveLength(0);
		expect(getItem(db, id)!.notes.some((n) => n.text.includes("started over"))).toBe(true);
	});
	test("only checks can be run", () => {
		const t = addItem(db, { title: "A task", project: "demo" });
		expect(() => runState(db, t)).toThrow(/isn't a check/);
	});
});

describe("finishing", () => {
	test("all passed: the check is done, with a note saying where", () => {
		const id = check();
		for (const n of [0, 1, 2]) saveStep(db, id, n, { result: "pass" }, "Chrome on Android");
		const s = finishRun(db, id, "Chrome on Android");
		expect(s.finished).toBe(true);
		expect(s.outcome).toBe("passed");
		expect(s.summary).toBe("All 3 steps passed on Chrome on Android");
		const it = getItem(db, id)!;
		expect(it.status).toBe("done");
		expect(it.notes.some((n) => n.text === "All 3 steps passed on Chrome on Android")).toBe(true);
		expect(() => saveStep(db, id, 0, { result: "fail", words: "x" })).toThrow(/done/);
	});
	test("failed steps become bugs with the words and photos, and the check waits on them; resuming starts a new run", () => {
		const id = check();
		saveStep(db, id, 0, { result: "pass" }, "Safari on iPhone");
		addStepPhoto(db, id, 1, photo, "Safari on iPhone");
		saveStep(db, id, 1, { result: "fail", words: "stays on the old date" }, "Safari on iPhone");
		saveStep(db, id, 2, { result: "fail", words: "lets me pick 1900" }, "Safari on iPhone");
		const s = finishRun(db, id);
		expect(s.outcome).toBe("failed");
		expect(s.bugs).toHaveLength(2);
		const [b1, b2] = s.bugs.map((b) => getItem(db, b.id)!);
		expect(b1.title).toBe("Check the date picker: step 2 fails");
		expect([b1.kind, b1.owner, b1.project, b1.status]).toEqual(["bug", "agent", "demo", "todo"]);
		expect(b1.body).toContain("**Step 2 of 3:** Pick another date.");
		expect(b1.body).toContain("the page shows the date you picked.");
		expect(b1.body).toContain("> stays on the old date");
		expect(b1.body).toContain("Safari on iPhone");
		expect(b1.images).toHaveLength(1);
		expect(b1.images[0].caption).toBe("Step 2: Pick another date. — failed: stays on the old date");
		expect(b2.images).toHaveLength(0);
		expect(b2.body).toContain("Try 1900 too.");
		// The photo is a copy: it is on the check too.
		expect(getItem(db, id)!.images).toHaveLength(1);
		// The check waits on both.
		const c = getItem(db, id)!;
		expect(c.status).toBe("waiting");
		expect(c.waits_on.map((w) => w.id).sort()).toEqual(s.bugs.map((b) => b.id).sort());
		// The run stays as it ended, and can't be changed.
		expect(runState(db, id).finished).toBe(true);
		expect(() => saveStep(db, id, 0, { result: "pass" })).toThrow(/finished/);
		// One bug done: still waiting. Both: back to todo, and a fresh run.
		updateItem(db, s.bugs[0].id, { status: "done" }, "agent");
		expect(getItem(db, id)!.status).toBe("waiting");
		updateItem(db, s.bugs[1].id, { status: "done" }, "agent");
		expect(getItem(db, id)!.status).toBe("todo");
		const again = runState(db, id);
		expect(again.finished).toBe(false);
		expect(again.started).toBe(false);
		saveStep(db, id, 0, { result: "pass" });
		expect(runState(db, id).run).toBe(2);
		// Agents still see what the last run found, until the new one has results.
		expect(runText(db, id)).toContain("latest run");
	});
	test("agents see the latest run in get_item, and the check brief rules tell them to number steps", async () => {
		const id = check();
		saveStep(db, id, 0, { result: "pass" });
		saveStep(db, id, 1, { result: "fail", words: "wrong date" });
		const text = runText(db, id);
		expect(text).toContain("latest run (in progress):");
		expect(text).toContain("1. Open the day page and tap the date.: pass");
		expect(text).toContain("2. Pick another date.: fail — wrong date");
		expect(text).toContain("1 step still to run");
		expect(runText(db, addItem(db, { title: "x", project: "demo" }))).toBe("");
		const req = new Request("http://localhost:4401/mcp?project=demo", {
			method: "POST",
			headers: { "content-type": "application/json", host: "localhost:4401", "mcp-protocol-version": "2025-06-18" },
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_item", arguments: { ref: `wb-${getItem(db, id)!.ref}` } } }),
		});
		const res = await mcpHttp(req, db, { loopback: true });
		const out = JSON.stringify(await res.json());
		expect(out).toContain("latest run");
		expect(out).toContain("check_run");
	});
});
