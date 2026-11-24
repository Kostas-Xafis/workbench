// Agents the board starts (dispatch.ts), with a fake runner: a small script that prints Claude Code's stream-json
// lines and exits. Nothing here runs the real claude.
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { addItem, addProject, getItem, listItems, updateItem } from "../src/db";
import { resolveAsk } from "../src/asks";
import { waitOn } from "../src/links";
import {
	AGENT_COMMAND,
	cleanEvents,
	endRun,
	save,
	continueCommand,
	continueRun,
	costs,
	launchCwd,
	resumeCommand,
	runEvents,
	runsText,
	sessionCwd,
	toolLine,
	desktop,
	desktopLink,
	forgetRuns,
	inWorktree,
	openInDesktop,
	getRun,
	itemRefusal,
	latestRun,
	newLive,
	pollRuns,
	readLine,
	refusedText,
	refusedTool,
	runLine,
	runPrompt,
	runsInfo,
	sendUnblocked,
	startRefusal,
	startRun,
	stopRun,
	testCommand,
	type From,
	type Run,
} from "../src/dispatch";
import { createSettingsTable, getSetting, updateSettings } from "../src/settings";
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
[ -n "$FAKE_ARGS" ] && { printf '%s' "$*" | tr '\\n' ' '; echo; } >> "$FAKE_ARGS"
# -w as Claude Code's: a worktree of its own, which it runs in. --resume: that session.
prev=""
for a in "$@"; do
  [ "$prev" = "--resume" ] && sid="$a"
  if [ "$a" = "-w" ]; then mkdir -p ".claude/worktrees/run-$WB_RUN" && cd ".claude/worktrees/run-$WB_RUN"; fi
  prev="$a"
done
[ -n "$FAKE_OUT" ] && printf '%s' "$WB_PROMPT" > "$FAKE_OUT"
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
		const p = Bun.spawn(["bun", join(import.meta.dir, "..", "src", "wb.ts"), "run", "wb-zzzz"], {
			env: { ...process.env, WB_DB: db.filename, WB_RUN: "1" },
			stderr: "pipe",
			stdout: "ignore",
		});
		expect(await p.exited).toBe(1);
		expect(await new Response(p.stderr).text()).toContain("agents don't start agents");
	});
});

describe("what a run couldn't do, and where it shows", () => {
	test("tools its permissions refused: counted by tool, on the run, its line and the item's history", async () => {
		set({ "agents.on": true, "agents.command": cmd(), "agents.per-day": 50 });
		const t = task("Refused");
		const r = await ended((await startRun(db, t, here)).id);
		expect(r.status).toBe("done");
		expect(r.refused).toBe("Edit");
		expect(runLine(r)).toContain("refused Edit");
		expect(getItem(db, t)!.notes.some((n) => n.text.includes("Its permissions refused Edit (Settings → Agents → The command)"))).toBe(true);
	});

	test("which tool a refusal names; other failures aren't refusals", () => {
		expect(refusedTool("Permission to use Bash has been denied because Claude Code is running in don't ask mode. IMPORTANT: …")).toBe("Bash");
		expect(refusedTool("Permission to use Bash with git push has been denied.")).toBe("Bash");
		expect(refusedTool("This action was blocked by auto mode: it deletes files outside the project.", "Bash")).toBe("Bash");
		expect(refusedTool("File does not exist.", "Read")).toBeUndefined();
		const l = newLive();
		readLine(l, '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1","name":"Write","input":{"file_path":"/a"}}]}}');
		readLine(l, '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","is_error":true,"content":"Denied by auto mode."}]}}');
		for (let n = 0; n < 3; n++)
			readLine(l, '{"type":"user","message":{"content":[{"type":"tool_result","is_error":true,"content":"Permission to use Edit has been denied."}]}}');
		expect(l.refused).toEqual({ Write: 1, Edit: 3 });
		expect(refusedText(l.refused)).toBe("Edit ×3, Write");
	});

	test("an item a run leaves doing, or waiting on nothing, is back in to-do; one waiting on an item stays", async () => {
		set({ "agents.command": cmd("FAKE_SLEEP=0.5") });
		const a = task("Left doing");
		const ra = await startRun(db, a, here);
		updateItem(db, a, { status: "doing" }, "agent");
		await ended(ra.id);
		expect(getItem(db, a)!.status).toBe("todo");
		expect(getItem(db, a)!.notes.at(-1)!.text).toBe(`Run #${ra.id} left it doing, and nothing would bring it back: it's in to-do again.`);

		const b = task("Left waiting");
		const rb = await startRun(db, b, here);
		updateItem(db, b, { status: "waiting" }, "agent");
		await ended(rb.id);
		expect(getItem(db, b)!.status).toBe("todo");

		const c = task("Waits on an ask");
		const rc = await startRun(db, c, here);
		const ask = addItem(db, { title: "Try it on the tablet", project: "repo", kind: "check", owner: "kostas" });
		waitOn(db, c, [ask], "agent");
		await ended(rc.id);
		expect(getItem(db, c)!.status).toBe("waiting");
	});

	test("Open in Claude Desktop: the resume link, once the run has ended, on this computer only", async () => {
		const opened: string[] = [];
		const open = desktop.open;
		desktop.open = (url) => void opened.push(url);
		try {
			set({ "agents.command": cmd("FAKE_SLEEP=1") });
			const run = await startRun(db, task("Desktop"), here);
			expect(() => openInDesktop(db, run.id)).toThrow("still going");
			const r = await ended(run.id);
			openInDesktop(db, r.id);
			expect(opened).toEqual([`claude://resume?session=${r.session}`]);
			expect((await runsInfo(db, here)).desktop).toBe(true);
			expect((await runsInfo(db, phone)).desktop).toBe(false);
			desktop.here = false;
			expect(() => openInDesktop(db, r.id)).toThrow("cloud board");
			expect((await runsInfo(db, here)).desktop).toBe(false);
		} finally {
			desktop.open = open;
			desktop.here = true;
		}
		expect(desktopLink("not-a-session; rm -rf ~")).toBe("");
	});
});

describe("the command", () => {
	test("the default lets the agent work, in a worktree of its own; the prompt says so", () => {
		expect(AGENT_COMMAND).toContain("--permission-mode auto");
		expect(inWorktree(AGENT_COMMAND)).toBe(true);
		expect(inWorktree(cmd())).toBe(false);
		expect(inWorktree("claude -p x --worktree=fix")).toBe(true);
		const i = { ref: "abcd", title: "T" };
		expect(runPrompt(db, i, AGENT_COMMAND)).toContain("git worktree of your own");
		expect(runPrompt(db, i, cmd())).not.toContain("worktree");
		expect(runPrompt(db, i, cmd())).toContain("Don't leave it waiting on nothing");
	});

	test("a board with the former default saved gets today's; a command of your own stays", () => {
		const d = freshDb();
		const former =
			'claude -p "$WB_PROMPT" --output-format stream-json --verbose --permission-mode dontAsk --allowedTools mcp__wb --session-id "$WB_SESSION" --name "$WB_TITLE"';
		d.query("INSERT INTO settings (key, value) VALUES ('agents.command', ?)").run(JSON.stringify(former));
		createSettingsTable(d);
		expect(getSetting(d, "agents.command")).toBe(AGENT_COMMAND);
		updateSettings(d, { "agents.command": `${former} --max-budget-usd 5` });
		createSettingsTable(d);
		expect(getSetting(d, "agents.command")).toBe(`${former} --max-budget-usd 5`);
	});
});

describe("watching a run: what the agent said and did", () => {
	test("events from the stream-json: its words, each tool call in a line, errors flagged, the end", async () => {
		await clear();
		set({ "agents.on": true, "agents.command": cmd(), "agents.per-day": 50, "agents.at-once": null });
		const t = task("Watch me");
		const r = await ended((await startRun(db, t, here)).id);
		const ev = runEvents(db, r.id);
		const ref = getItem(db, t)!.ref;
		expect(ev.map((e) => e.n)).toEqual([1, 2, 3, 4, 5, 6]);
		expect(ev.map((e) => [e.kind, e.text])).toEqual([
			["start", `Started with fake-model in ${folder}`],
			["text", `Reading wb-${ref}`],
			["tool", "Bash: git status"],
			["error", "Permission to use Edit was denied"],
			["output", "a plain line on stderr"],
			["result", "All done."],
		]);
		expect(ev[2].tool).toBe("Bash");
		expect(ev[3]).toMatchObject({ refused: true, tool: "Edit" });
		expect(ev[5]).toMatchObject({ cost: 0.42, duration_ms: 4000, turns: 3, is_error: false });
		expect(ev[0].at).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
		// After a number: only what came since.
		expect(runEvents(db, r.id, 4).map((e) => e.kind)).toEqual(["output", "result"]);
		// The tail is still there for what reads it.
		expect(r.tail).toContain("→ Bash: git status");
		expect(r.cwd).toBe(folder);
	});

	test("live while it runs, and read once each across a board restart", async () => {
		await clear();
		set({ "agents.command": cmd("FAKE_SLEEP=1") });
		const r = await startRun(db, task("Slow"), here);
		let seen: string[] = [];
		for (let n = 0; n < 40 && !seen.includes("tool"); n++) {
			await Bun.sleep(50);
			pollRuns(db);
			seen = runEvents(db, r.id).map((e) => e.kind);
		}
		expect(seen).toContain("tool");
		expect(seen).not.toContain("result");
		forgetRuns();
		const done = await ended(r.id);
		const kinds = runEvents(db, done.id).map((e) => e.kind);
		expect(kinds.filter((k) => k === "tool")).toHaveLength(1);
		expect(kinds.at(-1)).toBe("result");
	});

	test("a tool call in one line", () => {
		expect(toolLine("Edit", { file_path: "/w/src/app.ts", old_string: "a" }, "/w")).toBe("Edit src/app.ts");
		expect(toolLine("Read", { file_path: "/elsewhere/x.md" }, "/w")).toBe("Read /elsewhere/x.md");
		expect(toolLine("Bash", { command: "bun test\n  --bail" })).toBe("Bash: bun test --bail");
		expect(toolLine("mcp__wb__finish_item", { ref: "k3f9", note: "done" })).toBe("mcp__wb__finish_item wb-k3f9");
		expect(toolLine("mcp__wb__add_item", { title: "Check it", blocks: "wb-k3f9" })).toBe('mcp__wb__add_item "Check it"');
		expect(toolLine("Grep", { pattern: "TODO", path: "/w/src" }, "/w")).toBe("Grep TODO in src");
		expect(toolLine("Agent", { description: "find the bug", prompt: "…" })).toBe("Agent: find the bug");
		expect(toolLine("TodoWrite", { todos: [{}, {}] })).toBe("TodoWrite (2 to-dos)");
		expect(toolLine("mcp__other__thing", { url: "https://x" })).toBe("mcp__other__thing https://x");
		expect(toolLine("Weird", 3)).toBe("Weird");
	});

	test("from a computer helper (the cloud board): only new ones while it runs, the gaps filled at the end", () => {
		const t = task("Elsewhere");
		const { id } = db.query("INSERT INTO runs (item_id, project, pid, tag) VALUES (?, 'repo', 1, 'wb-run-x-cloud') RETURNING id").get(t) as { id: number };
		const l = newLive();
		for (let n = 0; n < 5; n++) readLine(l, `{"type":"assistant","message":{"content":[{"type":"text","text":"step ${n}"}]}}`);
		const sent = (after: number) => cleanEvents(JSON.parse(JSON.stringify(l.events.filter((e) => e.n > after)))); // over the wire
		save(db, { id }, { ...l, offset: 1, events: sent(0).slice(0, 2) });
		save(db, { id }, { ...l, offset: 2, events: sent(3) }); // the message with 3 got lost
		expect(runEvents(db, id).map((e) => e.n)).toEqual([1, 2, 4, 5]);
		endRun(db, { id, item_id: t, status: "running", error: "" }, 0, { ...l, offset: 3, events: sent(0) });
		expect(runEvents(db, id).map((e) => e.text)).toEqual(["step 0", "step 1", "step 2", "step 3", "step 4"]);
		expect(cleanEvents([{ n: 1, kind: "nope", text: "x" }, { n: -1, kind: "text" }, { n: 2, kind: "text", text: "y".repeat(5000), at: "bad", cost: "1" }]).map((e) => [e.n, e.text.length, e.cost])).toEqual([[2, 4000, undefined]]);
		expect(getRun(db, id)!.desktop).toBe("");
	});

	test("the last 500 are kept, each one's text capped", () => {
		const l = newLive();
		for (let n = 0; n < 620; n++) readLine(l, `{"type":"assistant","message":{"content":[{"type":"text","text":"${n === 619 ? "x".repeat(9000) : `step ${n}`}"}]}}`);
		expect(l.events).toHaveLength(500);
		expect(l.seq).toBe(620);
		expect(l.events[0].n).toBe(121);
		expect(l.events.at(-1)!.text.length).toBe(4000);
	});
});

describe("continuing a session", () => {
	const wtCmd = (env = "") => `${env} ${fake} -p "$WB_PROMPT" --output-format stream-json --verbose -w --session-id "$WB_SESSION" --name "$WB_TITLE"`.trim();

	test("the continue command is made from the start command, or is Settings' own", () => {
		expect(resumeCommand(AGENT_COMMAND)).toBe(
			'claude --resume "$WB_RESUME" -p "$WB_PROMPT" --output-format stream-json --verbose --permission-mode auto --allowedTools mcp__wb --name "$WB_TITLE"',
		);
		expect(resumeCommand('FOO=1 claude --session-id="$WB_SESSION" --worktree=fix --tmux "$WB_PROMPT"')).toBe('FOO=1 claude --resume "$WB_RESUME" "$WB_PROMPT"');
		expect(resumeCommand('claude -p "$WB_PROMPT" --resume "$WB_RESUME"')).toBe('claude -p "$WB_PROMPT" --resume "$WB_RESUME"');
		expect(resumeCommand('my-agent --max-budget-usd 5 --print "$WB_PROMPT"')).toBe('my-agent --max-budget-usd 5 --resume "$WB_RESUME" --print "$WB_PROMPT"');
		const d = freshDb();
		expect(continueCommand(d)).toBe(resumeCommand(AGENT_COMMAND));
		updateSettings(d, { "agents.command": 'claude -p "$WB_PROMPT" --session-id "$WB_SESSION" --max-budget-usd 5' });
		expect(continueCommand(d)).toBe('claude --resume "$WB_RESUME" -p "$WB_PROMPT" --max-budget-usd 5');
		updateSettings(d, { "agents.continue-command": 'claude -r "$WB_RESUME" -p "$WB_PROMPT"' });
		expect(continueCommand(d)).toBe('claude -r "$WB_RESUME" -p "$WB_PROMPT"');
	});

	test("Continue: a new run resumes the session, in the worktree it ran in, with the message", async () => {
		await clear();
		const args = join(dir, "args.txt");
		const out = join(dir, "continue-prompt.txt");
		set({ "agents.command": wtCmd(`FAKE_ARGS=${args} FAKE_OUT=${out}`), "agents.at-once": null });
		const t = task("Carry on");
		const first = await ended((await startRun(db, t, here)).id);
		const wt = join(folder, ".claude", "worktrees", `run-${first.id}`);
		expect(first.cwd).toBe(wt);
		expect(first.desktop).toBe(`claude://resume?session=${first.session}`);
		updateItem(db, t, { status: "done" }, "agent"); // a follow-up on a done item
		const next = await continueRun(db, first.id, "Also add a test for it.", here);
		expect(next.continues).toBe(first.id);
		expect(next.session).toBe(first.session);
		expect(next.desktop).toBe(""); // not while it runs
		const done = await ended(next.id);
		expect(done.status).toBe("done");
		expect(done.cwd).toBe(wt); // it ran in the worktree, not in a new one
		const lines = readFileSync(args, "utf8").trim().split("\n");
		expect(lines.at(-1)).toStartWith(`--resume ${first.session} -p `);
		expect(lines.at(-1)).not.toContain(" -w ");
		expect(lines.at(-1)).not.toContain("--session-id");
		expect(readFileSync(out, "utf8")).toStartWith("Also add a test for it.\n");
		expect(readFileSync(out, "utf8")).toContain("Nobody watches this session");
		// Its events start with the message it was sent.
		const ev = runEvents(db, done.id);
		expect(ev[0]).toMatchObject({ n: 0, kind: "message", text: "Also add a test for it.", by: "kostas" });
		expect(ev[1]).toMatchObject({ kind: "start", text: `Started with fake-model in ${wt}` });
		expect(runEvents(db, done.id, 0)[0].kind).toBe("start");
		const notes = getItem(db, t)!.notes;
		const i = notes.findIndex((n) => n.text === "Also add a test for it.");
		expect(notes[i].author).toBe("kostas");
		expect(notes[i + 1].text).toBe(`Agent continued (run #${next.id}, from this computer): the session of run #${first.id}, with the message above`);
		expect(getItem(db, t)!.status).toBe("done");
		expect(runLine(done)).toContain(`continues #${first.id}`);
		expect(runLine(done)).toContain(`claude --resume ${first.session} in ${wt}`);
		expect(runsText([done])).toContain(`wb continue ${done.id} "…" · open in Claude Desktop: claude://resume?session=${first.session}`);
	});

	test("refused while that session runs, with no message, off, or at a limit", async () => {
		await clear();
		set({ "agents.command": wtCmd("FAKE_SLEEP=20"), "agents.at-once": 2 });
		const t = task("Busy");
		const r = await startRun(db, t, here);
		await Bun.sleep(200);
		expect(continueRun(db, r.id, "more", here)).rejects.toThrow("that session is still running");
		await stopRun(db, r.id);
		expect(continueRun(db, r.id, "   ", here)).rejects.toThrow("write the message");
		set({ "agents.on": false });
		expect(continueRun(db, r.id, "more", here)).rejects.toThrow("doesn't start agents");
		set({ "agents.on": true });
		expect(continueRun(db, r.id, "more", phone)).rejects.toThrow("only from this computer");
		set({ "agents.per-day": 1 });
		expect(continueRun(db, r.id, "more", here)).rejects.toThrow("the most per day");
		set({ "agents.per-day": 50 });
		const { id } = db.query("INSERT INTO runs (item_id, project, status, ended_at) VALUES (?, 'repo', 'done', datetime('now')) RETURNING id").get(t) as { id: number };
		expect(continueRun(db, id, "more", here)).rejects.toThrow("no Claude Code session");
		// Nothing was noted for what didn't start.
		expect(getItem(db, t)!.notes.some((n) => n.text === "more")).toBe(false);
		set({ "agents.at-once": null });
	});

	test("Settings' own continue command is the one that runs", async () => {
		await clear();
		const args = join(dir, "own-args.txt");
		set({ "agents.command": wtCmd(), "agents.continue-command": `FAKE_ARGS=${args} ${fake} -p "$WB_PROMPT" --resume "$WB_RESUME" --output-format stream-json --verbose --own` });
		const first = await ended((await startRun(db, task("Own"), here)).id);
		const next = await ended((await continueRun(db, first.id, "go on", here)).id);
		expect(next.command).toContain("--own");
		expect(readFileSync(args, "utf8")).toContain(`--resume ${first.session}`);
		set({ "agents.continue-command": null });
	});

	test("where a continuation runs: the session's folder from its transcript, else the run's, else the project's", () => {
		const conf = join(dir, "claude-config");
		const wt = join(dir, "a-worktree");
		const session = crypto.randomUUID();
		mkdirSync(join(conf, "projects", "-a-worktree"), { recursive: true });
		mkdirSync(wt, { recursive: true });
		writeFileSync(join(conf, "projects", "-a-worktree", `${session}.jsonl`), `{"type":"summary"}\n{"type":"user","cwd":"${wt}","sessionId":"${session}"}\n`);
		const before = process.env.CLAUDE_CONFIG_DIR;
		process.env.CLAUDE_CONFIG_DIR = conf;
		try {
			expect(sessionCwd(session)).toBe(wt);
			expect(sessionCwd(crypto.randomUUID())).toBe("");
			expect(launchCwd({ cwd: folder, folder, resume: session })).toBe(wt);
			expect(launchCwd({ cwd: join(dir, "removed"), folder, resume: crypto.randomUUID() })).toBe(folder);
			expect(launchCwd({ cwd: join(dir, "removed"), folder: join(dir, "also-gone") })).toBe("");
		} finally {
			if (before === undefined) delete process.env.CLAUDE_CONFIG_DIR;
			else process.env.CLAUDE_CONFIG_DIR = before;
		}
	});
});

describe("restarting an item", () => {
	test("doing or waiting on nothing, after a failed or stopped run: a fresh session; never while one runs", async () => {
		await clear();
		set({ "agents.command": cmd("FAKE_EXIT=1"), "agents.at-once": null });
		const t = task("Broke");
		const failed = await ended((await startRun(db, t, here)).id);
		expect(failed.status).toBe("failed");
		updateItem(db, t, { status: "doing" }, "agent");
		expect(itemRefusal(db, getItem(db, t)!)).toBeUndefined();
		set({ "agents.command": cmd("FAKE_SLEEP=20") });
		const again = await startRun(db, t, here);
		expect(again.session).not.toBe(failed.session);
		expect(getItem(db, t)!.notes.at(-1)!.text).toBe(`Agent restarted (run #${again.id}, from this computer): run #${failed.id} had failed`);
		updateItem(db, t, { status: "doing" }, "agent");
		expect(itemRefusal(db, getItem(db, t)!)).toContain("already");
		updateItem(db, t, { status: "todo" }, "agent");
		expect(itemRefusal(db, getItem(db, t)!)).toContain(`already (run #${again.id})`);
		const stopped = await stopRun(db, again.id);
		expect(stopped.status).toBe("stopped");
		updateItem(db, t, { status: "waiting" }, "agent");
		expect(itemRefusal(db, getItem(db, t)!)).toBeUndefined();
		// Waiting on an item: it stays waiting for that.
		const ask = addItem(db, { title: "Look at it", project: "repo", kind: "check", owner: "kostas" });
		waitOn(db, t, [ask], "agent");
		expect(itemRefusal(db, getItem(db, t)!)).toContain("waits on something");
	});

	test("doing after a run that finished, or by hand: refused, unless it has stalled", async () => {
		await clear();
		set({ "agents.command": cmd() });
		const t = task("Fine");
		await ended((await startRun(db, t, here)).id);
		updateItem(db, t, { status: "doing" }, "agent");
		expect(itemRefusal(db, getItem(db, t)!)).toContain("being worked on already");
		const hand = task("By hand", { status: "doing" });
		expect(itemRefusal(db, getItem(db, hand)!)).toContain("being worked on already");
		db.query("UPDATE items SET updated_at = datetime('now', '-3 days') WHERE id = ?").run(hand);
		db.query("UPDATE notes SET at = datetime('now', '-3 days') WHERE item_id = ?").run(hand);
		expect(getItem(db, hand)!.stale?.why).toBe("stalled");
		expect(itemRefusal(db, getItem(db, hand)!)).toBeUndefined();
		const r = await ended((await startRun(db, hand, here)).id);
		expect(r.status).toBe("done");
	});
});

describe("Open in Claude Desktop from anywhere", () => {
	test("items with an agent session carry the link; anything else doesn't", () => {
		const uuid = crypto.randomUUID();
		const a = task("CLI session", { session: uuid });
		const b = task("Desktop session", { session: `local_${uuid}` });
		const c = task("Something else", { session: "abc; rm -rf ~" });
		expect(getItem(db, a)!.desktop).toBe(`claude://resume?session=${uuid}`);
		expect(getItem(db, b)!.desktop).toBe(`claude://claude.ai/epitaxy/local_${uuid}`);
		expect(getItem(db, c)!.desktop).toBeUndefined();
		expect(getItem(db, task("None"))!.desktop).toBeUndefined();
		const listed = listItems(db, { project: "repo" });
		expect(listed.find((i) => i.id === b)!.desktop).toBe(`claude://claude.ai/epitaxy/local_${uuid}`);
		expect(listed.find((i) => i.id === c)!.desktop).toBeUndefined();
	});
});
