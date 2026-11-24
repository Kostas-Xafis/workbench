// Rulings: drafted from answers, backfilled once, retired, and the warning when a new ask repeats one.
import { describe, expect, test } from "bun:test";
import { addItem, addProject, answerItem, getItem, open } from "../src/db";
import { mcpHttp } from "../src/mcp";
import {
	addRuling,
	backfillRulings,
	draftText,
	fold,
	listRulings,
	retireRuling,
	similarRulings,
	THRESHOLD,
	updateRuling,
	words,
} from "../src/rulings";
import { freshDb } from "./helpers";

const decide = (db: ReturnType<typeof freshDb>, title: string, body = "", project = "demo") =>
	addItem(db, { project, title, body, kind: "decision", options: ["Traditional", "Modern"] }, "agent");

describe("drafting on answer", () => {
	test("an answer drafts a ruling from the title and answer, marked drafted", () => {
		const db = freshDb();
		const id = decide(db, "Decide the default melisma style");
		answerItem(db, id, "1");
		const [r] = listRulings(db, { project: "demo" });
		expect(r.text).toBe("The default melisma style: Traditional");
		expect(r.drafted).toBe(1);
		expect(r.item_ref).toBe(getItem(db, id)!.ref);
		expect(r.origin).toBe("answer");
	});
	test("the same answer again keeps a rewrite; a new answer drafts again", () => {
		const db = freshDb();
		const id = decide(db, "Should the reader show the scale?");
		answerItem(db, id, "Yes (recommended)");
		const r = listRulings(db)[0];
		expect(r.text).toBe("Should the reader show the scale? Yes");
		updateRuling(db, r.id, { text: "The reader shows which scale is on" }, "agent");
		answerItem(db, id, "Yes (recommended)");
		expect(listRulings(db)).toHaveLength(1);
		expect(listRulings(db)[0]).toMatchObject({ text: "The reader shows which scale is on", drafted: 0 });
		answerItem(db, id, "No");
		expect(listRulings(db)).toHaveLength(1);
		expect(listRulings(db)[0]).toMatchObject({ text: "Should the reader show the scale? No", drafted: 1 });
	});
	test("draftText drops the lead-in and keeps one line", () => {
		expect(draftText("Decide: at a part change, what happens to a drone", "(1) Keep as built")).toBe("At a part change, what happens to a drone: Keep as built");
		expect(draftText("Decide whether to force light hinting", "Force it")).toBe("Whether to force light hinting: Force it");
		expect(draftText("Choose the sound", "a\n\nb".repeat(300)).length).toBeLessThanOrEqual(400);
	});
});

describe("backfill", () => {
	test("answered items get one drafted ruling each, dated when answered, never twice", () => {
		const db = freshDb();
		const a = decide(db, "Pick the sync model");
		const b = decide(db, "Pick the font");
		decide(db, "Unanswered one");
		// Answers set the way an older board does it: no ruling drafted.
		db.query("UPDATE items SET answer = 'CRDT' WHERE id = ?").run(a);
		db.query("UPDATE items SET answer = 'Serif' WHERE id = ?").run(b);
		db.query("INSERT INTO notes (item_id, at, author, text) VALUES (?, '2026-10-25 09:00:00', 'kostas', 'answer: — → CRDT')").run(a);
		expect(backfillRulings(db)).toBe(2);
		expect(backfillRulings(db)).toBe(0);
		const list = listRulings(db, { project: "demo" });
		expect(list).toHaveLength(2);
		expect(list.every((r) => r.drafted === 1)).toBe(true);
		expect(list.find((r) => r.item_id === a)!.created_at).toBe("2026-10-25 09:00:00");
		// Retired drafts count as had: they don't come back.
		retireRuling(db, list[0].id);
		expect(backfillRulings(db)).toBe(0);
		expect(listRulings(db, { retired: "all" })).toHaveLength(2);
	});
	test("opening the database backfills", () => {
		const db = freshDb();
		const id = decide(db, "Pick the colour");
		db.query("UPDATE items SET answer = 'Blue' WHERE id = ?").run(id);
		const again = open(db.filename);
		expect(listRulings(again).map((r) => r.text)).toEqual(["The colour: Blue"]);
		open(db.filename);
		expect(listRulings(again)).toHaveLength(1);
	});
});

describe("retire", () => {
	test("retired rulings leave the live list and can come back", () => {
		const db = freshDb();
		const id = addRuling(db, { project: "demo", text: "  Prices   in euros " }, "kostas");
		expect(listRulings(db)[0].text).toBe("Prices in euros");
		retireRuling(db, id);
		expect(listRulings(db)).toHaveLength(0);
		expect(listRulings(db, { retired: true }).map((r) => r.id)).toEqual([id]);
		updateRuling(db, id, { retired: false });
		expect(listRulings(db)).toHaveLength(1);
		expect(() => addRuling(db, { project: "demo", text: " " })).toThrow();
		expect(() => addRuling(db, { project: "nope", text: "x" })).toThrow();
	});
	test("a retired ruling no longer warns", () => {
		const db = freshDb();
		const id = addRuling(db, { project: "demo", text: "The oscillator sound is Classic" });
		expect(similarRulings(db, "demo", "Choose the oscillator sound").length).toBe(1);
		retireRuling(db, id);
		expect(similarRulings(db, "demo", "Choose the oscillator sound")).toEqual([]);
	});
});

describe("similarity", () => {
	test("accents, case and final sigma fold away", () => {
		expect(fold("Ἀκολουθίες")).toBe(fold("ακολουθιεσ"));
		expect(words("Οι Ἀκολουθίες")).toEqual(words("ακολουθιες"));
	});
	test("a repeat ask scores above the threshold, an unrelated one below", () => {
		const db = freshDb();
		for (const t of ["Fix the login page", "Add dark mode", "Translate the settings", "Ship the Android build", "Write the release notes"])
			addItem(db, { project: "demo", title: t, body: "Some ordinary task text about the app." });
		const id = decide(db, "Choose whether the hidden saints show on the day page", "The day page hides some saints. Show them, or keep them hidden?");
		answerItem(db, id, "Keep them all hidden");
		const repeat = similarRulings(db, "demo", "Show the hidden saints on the day page?", "Should the day page show the saints it hides now?");
		expect(repeat.length).toBe(1);
		expect(repeat[0].score).toBeGreaterThanOrEqual(THRESHOLD);
		expect(similarRulings(db, "demo", "Choose the colour of the login button", "Blue or green?")).toEqual([]);
	});
	test("Greek with and without accents matches", () => {
		const db = freshDb();
		for (const t of ["Διόρθωση της σελίδας εισόδου", "Νέο θέμα", "Μετάφραση ρυθμίσεων", "Έκδοση Android"])
			addItem(db, { project: "demo", title: t });
		const id = decide(db, "Πόσα στιχηρά στους Αἴνους την Κυριακή του Τελώνου;");
		answerItem(db, id, "5 + 3, όπως τα Δίπτυχα");
		const m = similarRulings(db, "demo", "ΠΟΣΑ ΣΤΙΧΗΡΑ ΣΤΟΥΣ ΑΙΝΟΥΣ ΤΗΣ ΚΥΡΙΑΚΗΣ ΤΟΥ ΤΕΛΩΝΟΥ");
		expect(m.length).toBe(1);
		expect(m[0].ruling.item_id).toBe(id);
	});
});

describe("over MCP", () => {
	const db = freshDb();
	addProject(db, { slug: "other", name: "Other", path: "/tmp/other" });
	let n = 1;
	async function call(name: string, args: Record<string, unknown> = {}) {
		const req = new Request("http://localhost:4401/mcp?project=demo", {
			method: "POST",
			headers: { "content-type": "application/json", host: "localhost:4401", "mcp-protocol-version": "2025-06-18" },
			body: JSON.stringify({ jsonrpc: "2.0", id: n++, method: "tools/call", params: { name, arguments: args } }),
		});
		const r = ((await (await mcpHttp(req, db, { loopback: true })).json()) as any).result;
		return { text: r.content[0].text as string, data: r.structuredContent as any, error: r.isError as boolean };
	}
	const BODY = "Which sound the oscillator makes by default. Options: Classic, Harmonium. My recommendation: Classic, it's what people know.";

	test("answer_decision drafts, update_ruling rewrites, list_rulings and project_overview show it", async () => {
		const added = await call("add_item", { title: "Choose the oscillator's sound", kind: "decision", options: ["Classic", "Harmonium"], recommended: "Classic", body: BODY });
		const ref = added.data.item.ref;
		const answered = await call("answer_decision", { ref, answer: "Classic" });
		expect(answered.text).toContain("update_ruling");
		const listed = await call("list_rulings");
		expect(listed.data.rulings).toHaveLength(1);
		expect(listed.data.rulings[0]).toMatchObject({ drafted: true, item: ref });
		const id = listed.data.rulings[0].id;
		const upd = await call("update_ruling", { id, text: "The oscillator sounds Classic by default" });
		expect(upd.data.ruling).toMatchObject({ drafted: false, text: "The oscillator sounds Classic by default" });
		expect((await call("project_overview")).text).toContain("The oscillator sounds Classic by default");
		expect((await call("list_rulings", { project: "other" })).data.rulings).toHaveLength(0);
	});
	test("add_item for a repeat ask saves it and warns with the ruling and its source", async () => {
		const again = await call("add_item", { title: "Decide the oscillator sound", kind: "decision", options: ["Classic", "Voices"], recommended: "Classic", body: BODY });
		expect(again.error).toBe(false);
		expect(again.data.item.ref).toMatch(/^wb-/);
		expect(again.text).toContain("already ruled");
		expect(again.text).toContain("The oscillator sounds Classic by default");
		expect(again.text).toMatch(/\(wb-[a-z0-9]{4}, \d{1,2} [A-Z][a-z]{2}\)/);
		expect(again.data.already_ruled[0].text).toBe("The oscillator sounds Classic by default");
		// A task isn't an ask: no warning.
		const task = await call("add_item", { title: "Make the oscillator sound Classic", body: "Set the default sound to Classic, as decided, and remove the other options." });
		expect(task.text).not.toContain("already ruled");
	});
	test("add_ruling and retire_ruling", async () => {
		const add = await call("add_ruling", { text: "Prices show in euros" });
		expect(add.data.ruling).toMatchObject({ project: "demo", drafted: false });
		const ret = await call("retire_ruling", { id: add.data.ruling.id });
		expect(ret.data.ruling.retired_at).toBeTruthy();
		expect((await call("list_rulings", { q: "euros" })).data.rulings).toHaveLength(0);
		expect((await call("list_rulings", { q: "euros", retired: true })).data.rulings).toHaveLength(1);
		expect((await call("retire_ruling", { id: 9999 })).error).toBe(true);
	});
});
