// Agents the board starts (dispatch.ts), with a fake runner: a small script that prints Claude Code's stream-json
// lines and exits. Nothing here runs the real claude.
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { addItem, addProject, getItem, updateItem } from "../db";
import { resolveAsk } from "../asks";
import { waitOn } from "../links";
import {
	costs,
	forgetRuns,
	getRun,
	itemRefusal,
	latestRun,
	newLive,
	pollRuns,
	readLine,
	runLine,
	runsInfo,
	sendUnblocked,
	startRefusal,
	startRun,
	stopRun,
	testCommand,
	type From,
	type Run,
} from "../dispatch";
import { updateSettings } from "../settings";
import { freshDb } from "./helpers";

const dir = mkdtempSync(join(process.env.WB_TEST_DIR!, "dispatch-"));
const folder = join(dir, "repo");
mkdirSync(folder);
const fake = join(dir, "fake-claude");
writeFileSync(
	fake,
	`#!/usr/bin/env bash
case "$1" in
  --version) echo "9.9.9 (Fake Code)"; exit 0;;
  --help) printf '%s\\n' "Usage: fake [options] [prompt]" "  -p, --print" "  --output-format <format>" "  --verbose" "  --permission-mode <mode>" "  --allowedTools, --allowed-tools <tools...>" "  --session-id <uuid>" "  -n, --name <name>"; exit 0;;
esac
sid="\${WB_SESSION:-fake-session}"
[ -n "$FAKE_OUT" ] && printf '%s' "$2" > "$FAKE_OUT"
echo '{"type":"system","subtype":"init","session_id":"'"$sid"'","model":"fake-model","cwd":"'"$PWD"'"}'
echo '{"type":"assistant","message":{"content":[{"type":"text","text":"Reading '"$WB_ITEM"'"},{"type":"tool_use","name":"Bash","input":{"command":"git status"}}]},"session_id":"'"$sid"'"}'
echo '{"type":"user","message":{"content":[{"type":"tool_result","is_error":true,"content":"Permission to use Edit was denied"}]}}'
echo "a plain line on stderr" >&2
sleep "\${FAKE_SLEEP:-0}"
echo '{"type":"result","subtype":"success","is_error":false,"num_turns":3,"duration_ms":4000,"total_cost_usd":0.42,"result":"All done.","session_id":"'"$sid"'"}'
exit "\${FAKE_EXIT:-0}"
`,
);
chmodSync(fake, 0o755);
const cmd = (env = "") => `${env} ${fake} -p "$WB_PROMPT" --output-format stream-json --verbose --session-id "$WB_SESSION"`.trim();

const db = freshDb();
addProject(db, { slug: "repo", name: "Repo", path: folder });
const here: From = { where: "local", label: "this computer" };
const phone: From = { where: "phone", label: "phone (Pixel)" };
const task = (title = "Build it", more: Record<string, unknown> = {}) => addItem(db, { title, project: "repo", owner: "agent", ...more });
const set = (patch: Record<string, unknown>) => updateSettings(db, patch);

/** Polls until the run has ended (or 10 s pass). */
async function ended(id: number): Promise<Run> {
	for (let n = 0; n < 200; n++) {
		pollRuns(db);
		const r = getRun(db, id)!;
		if (r.ended_at) return r;
		await Bun.sleep(50);
	}
	throw new Error(`run #${id} didn't end`);
}
/** Ends every run still going, so the next test starts with none. */
async function clear() {
	for (const r of pollRuns(db)) await stopRun(db, r.id);
	db.run("DELETE FROM runs");
}

afterAll(clear);

describe("dispatch", () => {
	test("off by default: nothing starts, and an ask isn't answered on the way", async () => {
		const t = task();
		expect(startRun(db, t, here)).rejects.toThrow("doesn't start agents");
		const d = addItem(db, { title: "Which?", project: "repo", kind: "decision", owner: "kostas", options: ["A", "B"] });
		expect(startRun(db, d, here, { answer: "A" })).rejects.toThrow("Settings → Agents");
		expect(getItem(db, d)!.answer).toBe("");
		expect(latestRun(db, t)).toBeUndefined();
	});

	test("a run: in the project's folder, its output read, session and cost from the stream", async () => {
		set({ "agents.on": true, "agents.command": cmd(`FAKE_OUT=${join(dir, "prompt.txt")}`), "agents.per-day": 50 });
		const t = task("Make the thing");
		const run = await startRun(db, t, here);
		expect(run.status).toBe("running");
		expect(run.started_from).toBe("this computer");
		const r = await ended(run.id);
		expect(r.status).toBe("done");
		expect(r.exit_code).toBe(0);
		expect(r.cost).toBe(0.42);
		expect(r.session).toBe(run.session);
		expect(r.session).toMatch(/^[0-9a-f-]{36}$/);
		expect(r.result).toBe("All done.");
		const ref = getItem(db, t)!.ref;
		expect(r.tail).toContain(`Started with fake-model in ${folder}`);
		expect(r.tail).toContain(`Reading wb-${ref}`);
		expect(r.tail).toContain("→ Bash: git status");
		expect(r.tail).toContain("✗ Permission to use Edit was denied");
		expect(r.tail).toContain("a plain line on stderr");
		expect(r.tail).toContain("— finished: 3 turns, under a minute, $0.42");
		// The prompt names the item and how to work it.
		const prompt = readFileSync(join(dir, "prompt.txt"), "utf8");
		expect(prompt).toContain(`Work on wb-${ref} (Make the thing)`);
		expect(prompt).toContain("get_item");
		expect(prompt).toContain("finish_item");
		const notes = getItem(db, t)!.notes.map((n) => n.text);
		expect(notes).toContain(`Agent started (run #${run.id}, from this computer)`);
		expect(notes.some((n) => n.startsWith(`Agent run #${run.id} finished after under a minute · $0.42`))).toBe(true);
		expect(runLine(r)).toContain(`claude --resume ${r.session}`);
		// Its files are gone once it's over.
		expect(existsSync(join(process.env.XDG_RUNTIME_DIR!, "workbench-runs", `${r.tag}.log`))).toBe(false);
	});

	test("a failing command ends as failed, with its exit code", async () => {
		set({ "agents.command": cmd("FAKE_EXIT=3") });
		const r = await ended((await startRun(db, task(), here)).id);
		expect(r.status).toBe("failed");
		expect(r.exit_code).toBe(3);
		expect(r.error).toStartWith("exit 3");
	});

	test("the item has to be an agent's to-do, with a folder, and no run on it", () => {
		const mine = addItem(db, { title: "Look", project: "repo", kind: "review", owner: "kostas" });
		expect(itemRefusal(db, getItem(db, mine)!)).toContain("answer it first");
		expect(itemRefusal(db, getItem(db, mine)!, true)).toBeUndefined();
		const idea = task("Maybe", { kind: "idea" });
		expect(itemRefusal(db, getItem(db, idea)!)).toContain("idea");
		const done = task("Old", { status: "done" });
		expect(itemRefusal(db, getItem(db, done)!)).toContain("done");
		const nowhere = addItem(db, { title: "Elsewhere", project: "demo", owner: "agent" });
		addProject(db, { slug: "gone", name: "Gone", path: join(dir, "not-there") });
		const gone = addItem(db, { title: "Gone", project: "gone", owner: "agent" });
		expect(itemRefusal(db, getItem(db, nowhere)!)).toContain("no folder");
		expect(itemRefusal(db, getItem(db, gone)!)).toContain("no folder");
	});

	test("at most so many at once", async () => {
		await clear();
		set({ "agents.command": cmd("FAKE_SLEEP=20"), "agents.at-once": 1 });
		const a = await startRun(db, task(), here);
		expect(startRun(db, task(), here)).rejects.toThrow("the most at once");
		// The same item can't get a second one either way.
		expect(itemRefusal(db, getItem(db, a.item_id)!)).toBeDefined();
		set({ "agents.at-once": 2 });
		const b = await startRun(db, task(), here);
		expect(pollRuns(db).map((r) => r.id)).toEqual([a.id, b.id]);
		await clear();
		// Two at the same moment (a double click, Run while unblocked work is sent): only one gets through.
		set({ "agents.at-once": 1 });
		const same = task();
		const both = await Promise.allSettled([startRun(db, same, here), startRun(db, same, here)]);
		expect(both.map((x) => x.status).sort()).toEqual(["fulfilled", "rejected"]);
		const two = await Promise.allSettled([startRun(db, task(), here), startRun(db, task(), here)]);
		expect(two.filter((x) => x.status === "fulfilled")).toHaveLength(0); // one runs already
		await clear();
		const pair = await Promise.allSettled([startRun(db, task(), here), startRun(db, task(), here)]);
		expect(pair.map((x) => x.status).sort()).toEqual(["fulfilled", "rejected"]);
		await clear();
		set({ "agents.at-once": null });
	});

	test("at most so many a day", async () => {
		await clear();
		set({ "agents.per-day": 2, "agents.command": cmd() });
		await ended((await startRun(db, task(), here)).id);
		await ended((await startRun(db, task(), here)).id);
		const no = await startRefusal(db, here);
		expect(no?.limit).toBe(true);
		expect(no?.why).toContain("2 agents started today, the most per day");
		// Runs from yesterday don't count.
		db.run("UPDATE runs SET started_at = datetime('now', '-2 days')");
		expect(await startRefusal(db, here)).toBeUndefined();
		set({ "agents.per-day": 50 });
	});

	test("a daily cost cap, from the Usage numbers for the runs' sessions", async () => {
		await clear();
		const r = await ended((await startRun(db, task(), here)).id);
		const real = costs.of;
		costs.of = async (sessions) => new Map(sessions.map((s) => [s, s === r.session ? 3.5 : 0]));
		try {
			set({ "agents.day-dollars": 3 });
			expect((await startRefusal(db, here))?.why).toContain("Today's agents cost $3.50, the cap is $3");
			set({ "agents.day-dollars": 4 });
			expect(await startRefusal(db, here)).toBeUndefined();
			// Usage hasn't seen it yet: what the agent reported counts.
			costs.of = async () => new Map();
			set({ "agents.day-dollars": 1 });
			expect(await startRefusal(db, here)).toBeUndefined(); // $0.42
			db.run("UPDATE runs SET cost = 1.25");
			expect((await startRefusal(db, here))?.why).toContain("$1.25");
		} finally {
			costs.of = real;
			set({ "agents.day-dollars": null });
		}
	});

	test("a phone starts nothing unless allowed; it can still answer", async () => {
		await clear();
		expect((await startRefusal(db, phone))?.why).toContain("only from this computer");
		const d = addItem(db, { title: "Pick", project: "repo", kind: "decision", owner: "kostas", options: ["A", "B"] });
		expect(startRun(db, d, phone, { answer: "B" })).rejects.toThrow("only from this computer");
		expect(getItem(db, d)!.answer).toBe("");
		resolveAsk(db, d, { answer: "B" }); // answering alone is fine
		expect(getItem(db, d)!.answer).toBe("B");
		const info = await runsInfo(db, phone);
		expect(info.allowed).toBe(false);
		set({ "agents.phone": true });
		expect(await startRefusal(db, phone)).toBeUndefined();
		expect((await runsInfo(db, phone)).allowed).toBe(true);
		const r = await startRun(db, d, phone);
		expect(r.started_from).toBe("phone (Pixel)");
		await ended(r.id);
		set({ "agents.phone": null });
	});

	test("Answer & send: answers the decision, then starts the agent on it", async () => {
		await clear();
		const d = addItem(db, { title: "Which way?", project: "repo", kind: "decision", owner: "kostas", options: ["Left", "Right"] });
		const r = await startRun(db, d, here, { answer: "2" });
		const i = getItem(db, d)!;
		expect(i.answer).toBe("Right");
		expect(i.owner).toBe("agent");
		expect(r.item_id).toBe(d);
		await ended(r.id);
		// An objection to a review goes back to the agent, and starts it.
		const rv = addItem(db, { title: "Read this", project: "repo", kind: "review", owner: "kostas" });
		const r2 = await startRun(db, rv, here, { object: "Shorter, please" });
		expect(getItem(db, rv)!.notes.map((n) => n.text)).toContain("Objection: Shorter, please");
		await ended(r2.id);
	});

	test("Stop ends the whole process group", async () => {
		await clear();
		set({ "agents.command": cmd("FAKE_SLEEP=30") });
		const r = await startRun(db, task(), here);
		await Bun.sleep(300);
		const pid = getRun(db, r.id)!.pid;
		expect(pid).toBeGreaterThan(0);
		const s = await stopRun(db, r.id);
		expect(s.status).toBe("stopped");
		expect(s.ended_at).not.toBeNull();
		const gone = () => { try { process.kill(pid, 0); return false; } catch { return true; } };
		for (let n = 0; n < 40 && !gone(); n++) await Bun.sleep(50); // reaped a moment later
		expect(gone()).toBe(true);
		expect(s.tail).toContain("→ Bash: git status");
		expect(getItem(db, r.item_id)!.notes.at(-1)!.text).toStartWith(`Agent run #${r.id} was stopped after`);
		// Stopping again is fine.
		expect((await stopRun(db, r.id)).status).toBe("stopped");
	});

	test("a board restart: a run still going is picked up, one that died meanwhile is closed", async () => {
		await clear();
		set({ "agents.command": cmd("FAKE_SLEEP=1") });
		const r = await startRun(db, task(), here);
		await Bun.sleep(300);
		pollRuns(db);
		forgetRuns(); // the board restarts: it knows nothing of what it had read
		expect(pollRuns(db).map((x) => x.id)).toEqual([r.id]);
		const done = await ended(r.id);
		expect(done.status).toBe("done");
		// Its whole output, read again from the start, once each.
		expect(done.tail.split("\n").filter((l) => l.includes("→ Bash: git status"))).toHaveLength(1);
		// A run whose process is gone without an exit code (the computer restarted, or it was killed).
		const t = task();
		const { id } = db
			.query("INSERT INTO runs (item_id, project, pid, tag, started_at) VALUES (?, 'repo', 999999, 'wb-run-x-gone', datetime('now', '-1 hour')) RETURNING id")
			.get(t) as { id: number };
		expect(pollRuns(db)).toEqual([]);
		const gone = getRun(db, id)!;
		expect(gone.status).toBe("failed");
		expect(gone.error).toContain("without an exit code");
	});

	test("unblocked work: told by default, sent when Settings says so, within the limits", async () => {
		await clear();
		set({ "agents.command": cmd() });
		const d1 = addItem(db, { title: "First?", project: "repo", kind: "decision", owner: "kostas", options: ["A", "B"] });
		const t1 = task("Carry on 1");
		updateItem(db, t1, { status: "doing" });
		waitOn(db, t1, [d1]);
		resolveAsk(db, d1, { answer: "A" });
		expect(getItem(db, t1)!.status).toBe("todo");
		expect(await sendUnblocked(db)).toEqual([]); // "tell me"
		await Bun.sleep(1100); // settings keep the second they changed; what was unblocked before doesn't go
		set({ "agents.unblocked": "send" });
		expect(await sendUnblocked(db)).toEqual([]);
		const d2 = addItem(db, { title: "Second?", project: "repo", kind: "decision", owner: "kostas", options: ["A", "B"] });
		const t2 = task("Carry on 2");
		updateItem(db, t2, { status: "doing" });
		waitOn(db, t2, [d2]);
		resolveAsk(db, d2, { answer: "B" });
		const sent = await sendUnblocked(db);
		expect(sent.map((r) => r.item_id)).toEqual([t2]);
		expect(sent[0].started_from).toBe("unblocked");
		expect(sent[0].started_by).toBe("board");
		// Once sent, not again.
		await ended(sent[0].id);
		expect(await sendUnblocked(db)).toEqual([]);
		// Held back by a limit, it goes once the limit allows.
		set({ "agents.per-day": 1 });
		const d3 = addItem(db, { title: "Third?", project: "repo", kind: "decision", owner: "kostas", options: ["A", "B"] });
		const t3 = task("Carry on 3");
		updateItem(db, t3, { status: "doing" });
		waitOn(db, t3, [d3]);
		resolveAsk(db, d3, { answer: "A" });
		expect(await sendUnblocked(db)).toEqual([]);
		set({ "agents.per-day": 50 });
		const later = await sendUnblocked(db);
		expect(later.map((r) => r.item_id)).toEqual([t3]);
		await ended(later[0].id);
		set({ "agents.unblocked": null });
	});

	test("stream-json made readable; other output as it is", () => {
		const l = newLive();
		readLine(l, '{"type":"system","subtype":"init","session_id":"s-1","model":"m"}');
		readLine(l, '{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"hm"},{"type":"tool_use","name":"Read","input":{"file_path":"/a/b.ts"}}]}}');
		readLine(l, '{"type":"stream_event","event":{}}');
		readLine(l, "not json {");
		readLine(l, '{"type":"result","subtype":"error_max_turns","is_error":true,"total_cost_usd":1.5,"session_id":"s-1"}');
		expect(l.lines).toEqual(["Started with m", "→ Read: /a/b.ts", "not json {", "— ended with an error (error_max_turns): $1.50"]);
		expect(l.session).toBe("s-1");
		expect(l.cost).toBe(1.5);
		expect(l.isError).toBe(true);
		for (let n = 0; n < 250; n++) readLine(l, `line ${n}`);
		expect(l.lines).toHaveLength(200);
		expect(l.lines.at(-1)).toBe("line 249");
	});

	test("Test the command: the program, its version, flags it doesn't know; nothing starts", async () => {
		const ok = await testCommand(cmd("FAKE_SLEEP=1"));
		expect(ok).toMatchObject({ ok: true, bin: fake, path: fake, version: "9.9.9 (Fake Code)", unknown: [] });
		const bad = await testCommand(`${fake} -p "$WB_PROMPT" --dangerously-fly`);
		expect(bad.ok).toBe(false);
		expect(bad.unknown).toEqual(["--dangerously-fly"]);
		const none = await testCommand("no-such-program-here --version");
		expect(none.problem).toContain("isn't on your shell's PATH");
	});

	test("agents don't start agents: wb run refuses inside a run", async () => {
		const p = Bun.spawn(["bun", join(import.meta.dir, "..", "wb.ts"), "run", "wb-zzzz"], {
			env: { ...process.env, WB_DB: db.filename, WB_RUN: "1" },
			stderr: "pipe",
			stdout: "ignore",
		});
		expect(await p.exited).toBe(1);
		expect(await new Response(p.stderr).text()).toContain("agents don't start agents");
	});
});
