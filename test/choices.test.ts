// What a run starts with (model, effort, mode: dispatch.ts Choices), and Move to Claude Desktop. Runs go through a
// fake runner, a small script that prints Claude Code's stream-json lines; nothing here runs the real claude.
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { addItem, addProject, getItem, updateItem } from "../src/db";
import {
	AGENT_COMMAND,
	choiceLabel,
	commandChoices,
	commandWith,
	continueRun,
	getRun,
	itemRefusal,
	madeFrom,
	markMoved,
	moveRefusal,
	moveRun,
	pollRuns,
	restartable,
	resumeCommand,
	runChoices,
	runLine,
	SAFE_MODES,
	setItemChoice,
	startRun,
	stopRun,
	withChoices,
	type From,
	type Run,
} from "../src/dispatch";
import { updateSettings } from "../src/settings";
import { freshDb } from "./helpers";

const dir = mkdtempSync(join(process.env.WB_TEST_DIR!, "choices-"));
const folder = join(dir, "repo");
mkdirSync(folder);
const fake = join(dir, "fake-claude");
writeFileSync(
	fake,
	`#!/usr/bin/env bash
sid="\${WB_RESUME:-\${WB_SESSION:-fake-session}}"
[ -n "$FAKE_ARGS" ] && { printf '%s' "$*" | tr '\\n' ' '; echo; } >> "$FAKE_ARGS"
echo '{"type":"system","subtype":"init","session_id":"'"$sid"'","model":"fake-model","cwd":"'"$PWD"'"}'
echo '{"type":"assistant","message":{"content":[{"type":"text","text":"Reading '"$WB_ITEM"'"},{"type":"tool_use","name":"Bash","input":{"command":"git status"}}]},"session_id":"'"$sid"'"}'
sleep "\${FAKE_SLEEP:-0}"
echo '{"type":"result","subtype":"success","is_error":false,"num_turns":1,"total_cost_usd":0.1,"result":"All done.","session_id":"'"$sid"'"}'
`,
);
chmodSync(fake, 0o755);
const cmd = (env = "") => `${env} ${fake} -p "$WB_PROMPT" --output-format stream-json --verbose --session-id "$WB_SESSION"`.trim();

const db = freshDb();
addProject(db, { slug: "repo", name: "Repo", path: folder });
const here: From = { where: "local", label: "this computer" };
const task = (title: string) => addItem(db, { title, project: "repo", owner: "agent" });
const set = (patch: Record<string, unknown>) => updateSettings(db, patch);
// The flags a run gets so the board reaches it while it runs (test/live.test.ts) are left out here.
set({ "agents.ask": false, "agents.tell": false });
set({ "agents.on": true, "agents.per-day": 100, "agents.at-once": 5 });

async function ended(id: number): Promise<Run> {
	for (let n = 0; n < 200; n++) {
		pollRuns(db);
		const r = getRun(db, id)!;
		if (r.ended_at) return r;
		await Bun.sleep(50);
	}
	throw new Error(`run #${id} didn't end`);
}
async function clear() {
	for (const r of pollRuns(db)) await stopRun(db, r.id);
}
afterAll(clear);

describe("the command a run starts with", () => {
	test("put in as whole words: replaced where it has the flag, added after the program where it hasn't", () => {
		expect(withChoices(AGENT_COMMAND, {})).toBe(AGENT_COMMAND);
		expect(withChoices(AGENT_COMMAND, { model: "opus", effort: "high", mode: "plan" })).toBe(
			'claude --model opus --effort high -p "$WB_PROMPT" --output-format stream-json --verbose --permission-mode plan --allowedTools mcp__wb -w --session-id "$WB_SESSION" --name "$WB_TITLE"',
		);
		// The mode the command has already: the same command.
		expect(withChoices(AGENT_COMMAND, { mode: "auto" })).toBe(AGENT_COMMAND);
		expect(withChoices('FOO=1 claude --model=sonnet -p "$WB_PROMPT"', { model: "haiku" })).toBe('FOO=1 claude --model=haiku -p "$WB_PROMPT"');
		expect(withChoices('FOO=1 claude -p "$WB_PROMPT"', { effort: "max" })).toBe('FOO=1 claude --effort max -p "$WB_PROMPT"');
		// '' takes the flag out: Claude Code's own default.
		expect(withChoices('claude --model "opus" --effort low -p x', { model: "", effort: "" })).toBe("claude -p x");
		// Never inside quotes.
		expect(withChoices('claude -p "use --model opus and --permission-mode auto" --permission-mode dontAsk', { model: "sonnet", mode: "acceptEdits" })).toBe(
			'claude --model sonnet -p "use --model opus and --permission-mode auto" --permission-mode acceptEdits',
		);
	});

	test("a command that can't be split takes none, and the run is refused saying where to set them", () => {
		for (const c of ['claude -p "$WB_PROMPT" | tee log', "cd x && claude -p y", 'claude -p "$(cat f)"', "claude -p y > out"]) {
			expect(withChoices(c, { model: "opus" })).toBeUndefined();
			// Nothing to put in: it runs as it is.
			expect(withChoices(c, {})).toBe(c);
			expect(() => commandWith(c, { mode: "plan" })).toThrow("Settings → Agents");
		}
	});

	test("only Claude Code's own values get in: no Manual, nothing made up", () => {
		expect(() => withChoices(AGENT_COMMAND, { model: "opus; rm -rf ~" })).toThrow("the model is one of");
		expect(() => withChoices(AGENT_COMMAND, { mode: "manual" })).toThrow("the mode is one of");
		expect(() => withChoices(AGENT_COMMAND, { mode: "" })).toThrow("the mode is one of");
		expect(() => updateSettings(freshDb(), { "agents.mode": "manual" })).toThrow();
		expect(commandChoices(withChoices(AGENT_COMMAND, { model: "opus", effort: "xhigh" })!)).toEqual({ model: "opus", effort: "xhigh", mode: "auto" });
		expect(commandChoices("claude --model=haiku -p x")).toEqual({ model: "haiku" });
		expect(choiceLabel({ model: "opus", effort: "xhigh", mode: "bypassPermissions" })).toBe("Opus · extra high · Bypass permissions");
	});
});

describe("where the choice comes from", () => {
	test("the item's own, else Settings', else the command; one run's own over all of them", () => {
		const d = freshDb();
		const id = addItem(d, { title: "Pick", project: "demo", owner: "agent" });
		const i = () => getItem(d, id)!;
		expect(runChoices(d, i())).toEqual({});
		updateSettings(d, { "agents.model": "sonnet", "agents.mode": "dontAsk" });
		expect(runChoices(d, i())).toEqual({ model: "sonnet", mode: "dontAsk" });
		setItemChoice(d, id, { model: "opus", effort: "high" });
		expect(runChoices(d, i())).toEqual({ model: "opus", effort: "high", mode: "dontAsk" });
		// '' on the item: Claude Code's default, whatever Settings say.
		setItemChoice(d, id, { model: "" });
		expect(runChoices(d, i())).toEqual({ model: "", effort: "high", mode: "dontAsk" });
		expect(runChoices(d, i(), { model: "haiku", mode: "plan" })).toEqual({ model: "haiku", effort: "high", mode: "plan" });
		// null: back to the board's.
		setItemChoice(d, id, { model: null, effort: null, mode: "acceptEdits" });
		expect(i()).toMatchObject({ agent_model: null, agent_effort: null, agent_mode: "acceptEdits" });
		expect(runChoices(d, i())).toEqual({ model: "sonnet", mode: "acceptEdits" });
		expect(() => setItemChoice(d, id, { mode: "manual" })).toThrow("the mode is one of");
		expect(() => setItemChoice(d, id, { effort: "huge" })).toThrow("the effort is one of");
	});

	test("a run starts with it, records what it ran with, and says so in the item's history; Continue too", async () => {
		await clear();
		const args = join(dir, "args.txt");
		set({ "agents.command": cmd(`FAKE_ARGS=${args}`), "agents.model": "sonnet" });
		const t = task("With a model");
		setItemChoice(db, t, { effort: "high", mode: "plan" });
		const run = await startRun(db, t, here);
		const r = await ended(run.id);
		expect(r.status).toBe("done");
		expect(r.command).toContain(`${fake} --model sonnet --effort high --permission-mode plan -p`);
		expect(readFileSync(args, "utf8")).toContain("--model sonnet --effort high --permission-mode plan -p");
		expect(JSON.parse(r.choices)).toEqual({ model: "sonnet", effort: "high", mode: "plan" });
		expect(r.uses).toBe("Sonnet · high · Plan only");
		expect(runLine(r)).toContain("Sonnet · high · Plan only");
		expect(getItem(db, t)!.notes.map((n) => n.text)).toContain(`Agent started (run #${run.id}, from this computer, with Sonnet · high · Plan only)`);
		// Continue: the same choice, in the continue command.
		const c = await ended((await continueRun(db, r.id, "one more", here)).id);
		expect(c.command).toStartWith(`FAKE_ARGS=${args} ${fake} --model sonnet --effort high --permission-mode plan --resume "$WB_RESUME" -p`);
		expect(c.uses).toBe("Sonnet · high · Plan only");
		// One run's own choice, over the item's.
		expect((await ended((await startRun(db, task("Once"), here, { choices: { model: "haiku" } })).id)).uses).toBe("Haiku");
		// An untouched board runs its command as it is.
		set({ "agents.model": null });
		const plain = await ended((await startRun(db, task("Plain"), here)).id);
		expect(plain.command).toBe(cmd(`FAKE_ARGS=${args}`));
		expect(plain.choices).toBe("");
	});

	test("a command the board can't put them in: refused, and an ask isn't answered on the way", async () => {
		await clear();
		set({ "agents.command": `${cmd()} | cat`, "agents.effort": "low" });
		expect(startRun(db, task("Piped"), here)).rejects.toThrow("can't take a model, effort or mode");
		const d = addItem(db, { title: "Which?", project: "repo", kind: "decision", owner: "kostas", options: ["A", "B"] });
		expect(startRun(db, d, here, { answer: "A" })).rejects.toThrow("can't take a model");
		expect(getItem(db, d)!.answer).toBe("");
		set({ "agents.effort": null });
		expect((await ended((await startRun(db, task("Piped, as it is"), here)).id)).status).toBe("done");
	});
});

describe("the computer helper", () => {
	test("allows a command made from one it allowed with safe choices; Bypass permissions and anything else need their own OK", () => {
		const choices = { model: "opus", effort: "max", mode: "dontAsk" };
		expect(madeFrom(AGENT_COMMAND, withChoices(AGENT_COMMAND, choices)!, choices)).toBe(true);
		for (const mode of SAFE_MODES) expect(madeFrom(AGENT_COMMAND, withChoices(AGENT_COMMAND, { mode })!, { mode })).toBe(true);
		// The continue command made from it, without choices (as before) and with them.
		expect(madeFrom(AGENT_COMMAND, resumeCommand(AGENT_COMMAND), undefined)).toBe(true);
		expect(madeFrom(AGENT_COMMAND, withChoices(resumeCommand(AGENT_COMMAND), choices)!, choices)).toBe(true);
		// Bypass permissions: its own command text.
		const bypass = { mode: "bypassPermissions" };
		expect(madeFrom(AGENT_COMMAND, withChoices(AGENT_COMMAND, bypass)!, bypass)).toBe(false);
		expect(madeFrom(AGENT_COMMAND, AGENT_COMMAND.replace("auto", "bypassPermissions"), {})).toBe(false);
		// Anything but exactly that: no.
		expect(madeFrom(AGENT_COMMAND, `${withChoices(AGENT_COMMAND, choices)} --dangerously-skip-permissions`, choices)).toBe(false);
		expect(madeFrom(AGENT_COMMAND, withChoices(AGENT_COMMAND, { model: "haiku" })!, choices)).toBe(false);
		expect(madeFrom(AGENT_COMMAND, AGENT_COMMAND, { model: "opus; rm -rf ~" })).toBe(false);
		expect(madeFrom(AGENT_COMMAND, "rm -rf ~", {})).toBe(false);
	});
});

describe("Move to Claude Desktop", () => {
	test("a run that's going stops as moved: not failed, nothing to restart, the item left as it is, its link there", async () => {
		await clear();
		set({ "agents.command": cmd("FAKE_SLEEP=30") });
		const t = task("Move me");
		const run = await startRun(db, t, here);
		await Bun.sleep(400);
		updateItem(db, t, { status: "doing" }, "agent");
		expect(getRun(db, run.id)!.desktop).toBe("");
		const m = await moveRun(db, run.id);
		expect(m).toMatchObject({ status: "stopped", moved: 1, error: "" });
		expect(m.ended_at).not.toBeNull();
		expect(m.desktop).toBe(`claude://resume?session=${run.session}`);
		expect(m.tail).toContain("→ Bash: git status");
		expect(runLine(m)).toContain("moved to Claude Desktop");
		const i = getItem(db, t)!;
		expect(i.notes.at(-1)!.text).toMatch(new RegExp(`^Agent run #${run.id} moved to Claude Desktop after .*: it carries on there$`));
		// It carries on in Desktop: still doing, and no Run again.
		expect(i.status).toBe("doing");
		expect(restartable(db, i)).toBe(false);
		expect(itemRefusal(db, i)).toContain("being worked on already");
		// Once it's over, there's nothing to move.
		await expect(moveRun(db, run.id)).rejects.toThrow("has ended");
	});

	test("only while it runs with a known session", async () => {
		await clear();
		set({ "agents.command": cmd("FAKE_SLEEP=30") });
		const r = await startRun(db, task("No session yet"), here);
		db.query("UPDATE runs SET session = '' WHERE id = ?").run(r.id);
		expect(moveRefusal(getRun(db, r.id))).toContain("no Claude Code session yet");
		expect(() => markMoved(db, r.id)).toThrow("no Claude Code session yet");
		expect(getRun(db, r.id)!.moved).toBe(0);
		await stopRun(db, r.id);
		expect(moveRefusal(undefined)).toBe("no such run");
	});
});
