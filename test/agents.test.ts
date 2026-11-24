// The Agents place (agents.ts) and what it stands on: signs of life (alive.ts), the stalled rule (stale.ts) and Merge
// it (dispatch.ts startLand). Agents run with a fake runner, as in dispatch.test.ts: nothing here runs the real claude.
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { addItem, addNote, addProject, getItem, listItems, resolveItem, updateItem, type Db } from "../src/db";
import { forgetAlive, noteAlive } from "../src/alive";
import { agentGit, agentsView, branchState, firstLine, forgetGit, landItem, type GitRead } from "../src/agents";
import { getRun, landPrompt, latestRun, pollRuns, startRun, stopRun, type From, type Run } from "../src/dispatch";
import { repoState, type RepoState } from "../src/git";
import { waitOn } from "../src/links";
import { mcpHttp } from "../src/mcp";
import { parseWb } from "../src/cliargs";
import { runCli } from "../src/cli";
import { updateSettings } from "../src/settings";
import { freshDb } from "./helpers";

const dir = mkdtempSync(join(process.env.WB_TEST_DIR!, "agents-"));
const folder = join(dir, "repo");
mkdirSync(folder);
const fake = join(dir, "fake-claude");
writeFileSync(
	fake,
	`#!/usr/bin/env bash
sid="\${WB_SESSION:-fake-session}"
[ -n "$FAKE_OUT" ] && printf '%s' "$WB_PROMPT" > "$FAKE_OUT"
echo '{"type":"system","subtype":"init","session_id":"'"$sid"'","model":"fake-model","cwd":"'"$PWD"'"}'
sleep "\${FAKE_SLEEP:-0}"
echo '{"type":"result","subtype":"success","is_error":false,"num_turns":1,"duration_ms":10,"total_cost_usd":0.01,"result":"Landed.","session_id":"'"$sid"'"}'
exit "\${FAKE_EXIT:-0}"
`,
);
chmodSync(fake, 0o755);
const cmd = (env = "") => `${env} ${fake} -p "$WB_PROMPT" --output-format stream-json --verbose --session-id "$WB_SESSION"`.trim();
const here: From = { where: "local", label: "this computer" };

const ago = (db: Db, id: number, col: "alive_at" | "updated_at" | "done_at", spec: string) =>
	db.query(`UPDATE items SET ${col} = datetime('now', ?) WHERE id = ?`).run(spec, id);
const notesAgo = (db: Db, id: number, spec: string) => db.query("UPDATE notes SET at = datetime('now', ?) WHERE item_id = ?").run(spec, id);

async function ended(db: Db, id: number): Promise<Run> {
	for (let n = 0; n < 200; n++) {
		pollRuns(db);
		const r = getRun(db, id)!;
		if (r.ended_at) return r;
		await Bun.sleep(50);
	}
	throw new Error(`run #${id} didn't end`);
}

/** Git as a test says it is, instead of reading a folder. */
const realGit = agentGit.read;
function fakeGit(repos: Partial<RepoState>[], code: GitRead["code"] = {}, limits: string[] = []) {
	agentGit.read = async () => ({
		repos: repos.map((r) => ({ project: "repo", ok: true, branch: "master", base: "master", dirty: [], ahead: 0, behind: 0, unmerged: [], worktrees: [], lastCommit: "", ...r })),
		code,
		limits,
	});
}
afterAll(() => {
	agentGit.read = realGit;
});

describe("signs of life", () => {
	test("an item gets alive_at from a call about it, at most once a minute; alive while it's under five minutes old", () => {
		const db = freshDb();
		const id = addItem(db, { title: "Work", project: "demo", owner: "agent" });
		expect(getItem(db, id)!.alive).toBe(false);
		expect(getItem(db, id)!.alive_at).toBeNull();
		noteAlive(db, { ids: [id] });
		const first = getItem(db, id)!.alive_at;
		expect(first).toBeTruthy();
		expect(getItem(db, id)!.alive).toBe(true);
		expect(listItems(db).find((i) => i.id === id)!.alive).toBe(true);
		// Six minutes on: no longer alive. Another call within the same minute (by this process's clock) writes nothing.
		ago(db, id, "alive_at", "-6 minutes");
		const old = getItem(db, id)!.alive_at;
		noteAlive(db, { ids: [id] });
		expect(getItem(db, id)!.alive_at).toBe(old);
		expect(getItem(db, id)!.alive).toBe(false);
		// A minute later it's written again.
		noteAlive(db, { ids: [id] }, Date.now() + 61_000);
		expect(getItem(db, id)!.alive).toBe(true);
		// Another process (forgetAlive) can't write it twice in a minute either: the database says so.
		forgetAlive(db);
		db.query("UPDATE items SET alive_at = datetime('now', '-30 seconds') WHERE id = ?").run(id);
		const recent = getItem(db, id)!.alive_at;
		noteAlive(db, { ids: [id] });
		expect(getItem(db, id)!.alive_at).toBe(recent);
	});

	test("a call from the session an open item records counts for it; a done one's doesn't", () => {
		const db = freshDb();
		const a = addItem(db, { title: "A", project: "demo", owner: "agent", status: "doing", session: "local_0d6e5b8a-1111-4222-8333-444455556666" });
		const b = addItem(db, { title: "B", project: "demo", owner: "agent", status: "done", session: "local_0d6e5b8a-1111-4222-8333-444455556666" });
		noteAlive(db, { session: "local_0d6e5b8a-1111-4222-8333-444455556666" });
		expect(getItem(db, a)!.alive).toBe(true);
		expect(getItem(db, b)!.alive).toBe(false);
		noteAlive(db, { session: "bad session; DROP TABLE items" });
		expect(getItem(db, a)).toBeDefined();
	});

	test("MCP tool calls naming the item, and from the relay's session header, are signs of life", async () => {
		const db = freshDb();
		const named = addItem(db, { title: "Named", project: "demo", owner: "agent" });
		const bySession = addItem(db, { title: "By session", project: "demo", owner: "agent", status: "doing", session: "abc-session-1" });
		const call = async (name: string, args: Record<string, unknown>, headers: Record<string, string> = {}) => {
			const req = new Request("http://localhost:4401/mcp?project=demo", {
				method: "POST",
				headers: { "content-type": "application/json", host: "localhost:4401", "mcp-protocol-version": "2025-06-18", ...headers },
				body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
			});
			return ((await (await mcpHttp(req, db, { loopback: true })).json()) as any).result;
		};
		await call("get_item", { ref: `wb-${getItem(db, named)!.ref}` });
		expect(getItem(db, named)!.alive).toBe(true);
		expect(getItem(db, bySession)!.alive).toBe(false);
		await call("list_items", {}, { "x-wb-session": "abc-session-1" });
		expect(getItem(db, bySession)!.alive).toBe(true);
		// start_item over HTTP links the relay's session, as a stdio server links its own.
		const fresh = addItem(db, { title: "Fresh", project: "demo", owner: "agent" });
		await call("start_item", { ref: getItem(db, fresh)!.ref }, { "x-wb-session": "relay-session-2" });
		expect(getItem(db, fresh)!.session).toBe("relay-session-2");
		expect(getItem(db, fresh)!.alive).toBe(true);
	});

	test("an agent's wb command about an item is one; Kostas's isn't", async () => {
		const db = freshDb();
		const id = addItem(db, { title: "Via wb", project: "demo", owner: "agent" });
		const ref = getItem(db, id)!.ref;
		const wb = async (argv: string[], author: string) => {
			const { values: o, positionals: args } = parseWb(argv);
			return runCli({ db, args, o: { ...o, project: "demo" }, cwd: "/tmp/demo", author, tty: false, base: "", port: 0, out: () => {}, err: () => {}, read: async () => { throw new Error("no files"); }, write: async () => {} });
		};
		expect(await wb(["show", ref], "kostas")).toBe(0);
		expect(getItem(db, id)!.alive).toBe(false);
		expect(await wb(["note", ref, "on it"], "agent")).toBe(0);
		expect(getItem(db, id)!.alive).toBe(true);
	});

	test("a live run makes an item alive, and it isn't stalled meanwhile", async () => {
		const db = freshDb();
		addProject(db, { slug: "repo", name: "Repo", path: folder });
		updateSettings(db, { "agents.on": true, "agents.command": cmd("FAKE_SLEEP=20"), "agents.per-day": 50 });
		const id = addItem(db, { title: "Run me", project: "repo", owner: "agent" });
		const run = await startRun(db, id, here);
		updateItem(db, id, { status: "doing" }, "agent");
		ago(db, id, "updated_at", "-3 days");
		notesAgo(db, id, "-3 days");
		expect(getItem(db, id)!.alive).toBe(true);
		expect(getItem(db, id)!.stale).toBeNull();
		// The same quiet without the run: stalled.
		db.query("UPDATE runs SET ended_at = datetime('now') WHERE id = ?").run(run.id);
		expect(getItem(db, id)!.alive).toBe(false);
		expect(getItem(db, id)!.stale?.why).toBe("stalled");
		db.query("UPDATE runs SET ended_at = NULL WHERE id = ?").run(run.id);
		await stopRun(db, run.id);
	});
});

describe("stalled means no sign of life for a day", () => {
	test("doing with no note and no call for a day is stalled; a call is news", () => {
		const db = freshDb();
		const id = addItem(db, { title: "Quiet", project: "demo", owner: "agent", status: "doing" });
		ago(db, id, "updated_at", "-25 hours");
		notesAgo(db, id, "-25 hours");
		expect(getItem(db, id)!.stale?.why).toBe("stalled");
		noteAlive(db, { ids: [id] });
		expect(getItem(db, id)!.stale).toBeNull();
		ago(db, id, "alive_at", "-23 hours");
		expect(getItem(db, id)!.stale).toBeNull();
		ago(db, id, "alive_at", "-30 hours");
		expect(getItem(db, id)!.stale?.why).toBe("stalled");
		// A newer note is news too; a bare updated_at (an edit with no note) isn't.
		ago(db, id, "updated_at", "-1 minutes");
		expect(getItem(db, id)!.stale?.why).toBe("stalled");
		addNote(db, id, "still here", "agent");
		expect(getItem(db, id)!.stale).toBeNull();
	});
	test("waiting stays as it was: a week", () => {
		const db = freshDb();
		const id = addItem(db, { title: "Waits", project: "demo", owner: "agent", status: "waiting" });
		ago(db, id, "updated_at", "-3 days");
		notesAgo(db, id, "-3 days");
		expect(getItem(db, id)!.stale).toBeNull();
		ago(db, id, "updated_at", "-8 days");
		notesAgo(db, id, "-8 days");
		expect(getItem(db, id)!.stale?.why).toBe("waiting");
	});
});

describe("git: the main branch and how far each branch is ahead", () => {
	test("repoState says the base and counts each unmerged branch's commits", async () => {
		const repo = join(dir, "git-repo");
		mkdirSync(repo);
		const git = (...args: string[]) => {
			const p = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "init.defaultBranch=master", "-c", "commit.gpgsign=false", ...args], { cwd: repo });
			if (p.exitCode !== 0) throw new Error(p.stderr.toString());
		};
		git("init", "-q");
		writeFileSync(join(repo, "a"), "1");
		git("add", "a");
		git("commit", "-qm", "one");
		git("checkout", "-qb", "feature");
		for (const n of [2, 3]) {
			writeFileSync(join(repo, "a"), String(n));
			git("commit", "-qam", `wb-k3f9 step ${n}`);
		}
		git("checkout", "-qb", "done-branch", "master");
		git("checkout", "-q", "master");
		const s = await repoState({ slug: "g", name: "G", path: repo, icon: "", sort: 0, archived_at: null, report_order: "[]" });
		expect(s.ok).toBe(true);
		expect(s.base).toBe("master");
		expect(s.unmerged).toEqual([expect.objectContaining({ name: "feature", ahead: 2 })]);
		expect(branchState({ ref: "k3f9", branch: "feature", project: "g" }, s, {})).toMatchObject({ known: true, merged: false, ahead: 2, base: "master" });
		expect(branchState({ ref: "k3f9", branch: "done-branch", project: "g" }, s, {})).toMatchObject({ known: true, merged: true });
		// A merged pull request that names the item counts as merged, whatever the local branches say.
		const merged = { "k3f9": { commits: [], prs: [{ number: 4, title: "x", state: "MERGED", draft: false, review: "", checks: "" as const, url: "" }] } };
		expect(branchState({ ref: "k3f9", branch: "feature", project: "g" }, s, merged).merged).toBe(true);
		expect(branchState({ ref: "k3f9", branch: "feature", project: "g" }, { ...s, ok: false, error: "no such folder" }, {})).toMatchObject({ known: false, why: "no such folder" });
	});
});

describe("GET /api/agents", () => {
	const db = freshDb();
	addProject(db, { slug: "repo", name: "Repo", path: folder });
	updateSettings(db, { "agents.on": true, "agents.command": cmd(), "agents.per-day": 50 });
	const task = (title: string, more: Record<string, unknown> = {}) => addItem(db, { title, project: "repo", owner: "agent", ...more });

	test("running, ready to land, stuck and finished, with counts", async () => {
		forgetGit();
		// Running: alive now.
		const live = task("Live one", { status: "doing", branch: "live-b" });
		addNote(db, live, "Halfway: the parser works\nmore detail", "agent");
		noteAlive(db, { ids: [live] });
		// Stuck: doing, quiet for 3 days.
		const quiet = task("Quiet one", { status: "doing" });
		ago(db, quiet, "updated_at", "-3 days");
		notesAgo(db, quiet, "-3 days");
		// Stuck: waiting on Kostas.
		const waits = task("Waits one");
		const ask = addItem(db, { title: "Pick a name", project: "repo", kind: "decision", owner: "kostas", options: ["A", "B"] });
		waitOn(db, waits, [ask], "agent");
		// Stuck: waiting 8 days on nothing.
		const long = task("Long wait", { status: "waiting" });
		ago(db, long, "updated_at", "-8 days");
		notesAgo(db, long, "-8 days");
		// Stuck: its run failed.
		updateSettings(db, { "agents.command": cmd("FAKE_EXIT=2") });
		const broke = task("Broke one");
		await ended(db, (await startRun(db, broke, here)).id);
		updateSettings(db, { "agents.command": cmd() });
		// Done, unmerged: ready. Done, merged: finished only. Done 20 days ago: neither.
		const ready = task("Ready one", { branch: "feature-r" });
		updateItem(db, ready, { status: "done" }, "agent", "a1b2c3d on feature-r: the thing\nand more");
		const merged = task("Merged one", { branch: "feature-m" });
		updateItem(db, merged, { status: "done" }, "agent", "merged into master");
		const old = task("Old one", { branch: "feature-o" });
		updateItem(db, old, { status: "done" }, "agent", "old");
		ago(db, old, "done_at", "-20 days");
		const readyRef = getItem(db, ready)!.ref;
		fakeGit([{ unmerged: [{ name: "feature-r", date: "", ahead: 3 }, { name: "feature-o", date: "", ahead: 1 }], worktrees: [{ path: "/w/r", branch: "feature-r" }] }], {
			[readyRef]: { commits: [{ hash: "a", short: "a", date: "", subject: "", url: "" }], prs: [{ number: 7, title: "PR", state: "OPEN", draft: false, review: "", checks: "passing", url: "u" }] },
		});

		const v = await agentsView(db, { project: "repo" }, here);
		const refs = (list: { item: { id: number } }[]) => list.map((x) => x.item.id);
		expect(refs(v.running)).toEqual([live]);
		expect(v.running[0]).toMatchObject({ note: "Halfway: the parser works", branch: "live-b", run: null });
		expect(v.running[0].alive_at).toBeTruthy();
		const why = Object.fromEntries(v.stuck.map((s) => [s.item.id, s]));
		expect(why[quiet]).toMatchObject({ why: "no sign of life for 3 days", reason: "no-sign-of-life", again: { kind: "run", allowed: true } });
		expect(why[waits]).toMatchObject({ why: "waits on you: Pick a name", reason: "waits-on-you", again: { allowed: false } });
		expect(why[long]).toMatchObject({ why: "waiting 8 days", reason: "waiting" });
		expect(why[broke].why).toStartWith("its run failed: exit 2");
		expect(why[broke].again).toMatchObject({ kind: "run", allowed: true });
		expect(v.ready).toHaveLength(1);
		expect(v.ready[0]).toMatchObject({
			branch: "feature-r",
			base: "master",
			ahead: 3,
			commits: 1,
			worktree: "/w/r",
			note: "a1b2c3d on feature-r: the thing",
			land: { allowed: true, why: "" },
		});
		expect(v.ready[0].pr?.number).toBe(7);
		const fin = Object.fromEntries(v.finished.map((f) => [f.item.id, f]));
		expect(Object.keys(fin).map(Number).sort()).toEqual([ready, merged].sort());
		expect(fin[merged]).toMatchObject({ merged: true, note: "merged into master", branch: "feature-m" });
		expect(fin[ready]).toMatchObject({ merged: false, ahead: 3, commits: 1 });
		expect(v.counts).toEqual({ running: 1, ready: 1, stuck: 4, finished: 2 });
		expect(v.start).toEqual({ allowed: true, why: "" });
		expect(v.limits).toEqual([]);

		// since: further back brings the old one into finished; a bad date is refused; so is an unknown project.
		const all = await agentsView(db, { project: "*", since: new Date(Date.now() - 30 * 86400e3).toISOString() }, here);
		expect(all.finished.map((f) => f.item.id)).toContain(old);
		expect(all.ready.map((r) => r.item.id)).not.toContain(old);
		expect(agentsView(db, { since: "yesterday-ish" })).rejects.toThrow("since must be");
		expect(agentsView(db, { project: "nope" })).rejects.toThrow('no project "nope"');
		// Without someone who may start agents, nothing can be started from it.
		expect((await agentsView(db, { project: "repo" }, null)).start.allowed).toBe(false);
	});

	test("unknown git: what isn't known is said, not guessed", async () => {
		fakeGit([{ ok: false, error: "not a git repository" }], {}, ["No computer is online: git state is as a computer last sent it, 5 min ago."]);
		const v = await agentsView(db, { project: "repo" }, here);
		expect(v.ready).toEqual([]);
		expect(v.limits[0]).toContain("No computer is online");
		expect(v.limits.some((l) => l.includes("can't tell which branches are merged (not a git repository)"))).toBe(true);
		expect(v.finished.every((f) => f.merged === null || !f.branch)).toBe(true);
	});
});

describe("Merge it: a run that lands a done item's branch", () => {
	const db = freshDb();
	addProject(db, { slug: "repo", name: "Repo", path: folder });
	updateSettings(db, { "agents.on": true, "agents.command": cmd(`FAKE_OUT=${join(dir, "land-prompt.txt")}`), "agents.per-day": 50 });
	const doneTask = (branch = "feature-x") => {
		const id = addItem(db, { title: "Landable", project: "repo", owner: "agent", branch });
		updateItem(db, id, { status: "done" }, "agent", "done on " + branch);
		return id;
	};

	test("refused unless it's a done agent item with a branch that isn't merged", async () => {
		fakeGit([{ unmerged: [{ name: "feature-x", date: "", ahead: 2 }] }]);
		const open = addItem(db, { title: "Open", project: "repo", owner: "agent", branch: "feature-x" });
		expect(landItem(db, open, here)).rejects.toThrow("isn't done");
		const nob = doneTask("");
		expect(landItem(db, nob, here)).rejects.toThrow("names no branch");
		const merged = doneTask("feature-merged");
		expect(landItem(db, merged, here)).rejects.toThrow("is merged into master already");
		expect(latestRun(db, merged)).toBeUndefined();
		updateSettings(db, { "agents.on": false });
		expect(landItem(db, doneTask(), here)).rejects.toThrow("doesn't start agents");
		updateSettings(db, { "agents.on": true });
	});

	test("a run of kind land, told how to land it; recorded on the item; its failure is stuck with Merge it again", async () => {
		fakeGit([{ unmerged: [{ name: "feature-x", date: "", ahead: 2 }] }]);
		const id = doneTask();
		const ref = getItem(db, id)!.ref;
		const run = await landItem(db, id, here);
		expect(run.kind).toBe("land");
		expect(getItem(db, id)!.notes.at(-1)!.text).toBe(`Agent merging feature-x into master (run #${run.id}, from this computer)`);
		// While it runs, a second one (or a Run) is refused, and the Agents place shows it running.
		expect(landItem(db, id, here)).rejects.toThrow("already");
		const during = await agentsView(db, { project: "repo" }, here);
		expect(during.running.find((r) => r.item.id === id)?.run?.kind).toBe("land");
		const r = await ended(db, run.id);
		expect(r.status).toBe("done");
		expect(getItem(db, id)!.status).toBe("done"); // a done item stays done
		const prompt = readFileSync(join(dir, "land-prompt.txt"), "utf8");
		expect(prompt).toContain(`Land wb-${ref} (Landable)`);
		expect(prompt).toContain("Merge feature-x into master the way this project's own rules say");
		expect(prompt).toContain("Never force-push");
		expect(prompt).toContain(`add_note to wb-${ref} saying what landed where`);
		expect(prompt).toContain("file what you need from");
		expect(prompt).not.toContain("start_item");

		// It failed: stuck, with Merge it again (not in ready meanwhile).
		updateSettings(db, { "agents.command": cmd("FAKE_EXIT=1") });
		const failed = await ended(db, (await landItem(db, id, here)).id);
		expect(failed.status).toBe("failed");
		const v = await agentsView(db, { project: "repo" }, here);
		const s = v.stuck.find((x) => x.item.id === id)!;
		expect(s.why).toStartWith("its merge run failed: exit 1");
		expect(s.again).toEqual({ kind: "land", allowed: true, why: "" });
		expect(v.ready.find((x) => x.item.id === id)).toBeUndefined();
		updateSettings(db, { "agents.command": cmd() });
	});

	test("the prompt names the project's folder for a worktree run", () => {
		const p = landPrompt(db, { ref: "k3f9", title: "T", branch: "b", project: "repo" }, "main", "claude -p x -w");
		expect(p).toContain(`project's own checkout, ${folder}`);
		expect(p).toContain("Merge b into main");
	});

	test("the route and wb land", async () => {
		fakeGit([{ unmerged: [{ name: "feature-x", date: "", ahead: 2 }] }]);
		const { boardRoutes } = await import("../src/routes");
		const routes = boardRoutes({
			db,
			cloud: false,
			port: 0,
			lan: false,
			compiled: false,
			loopback: () => true,
			localRead: () => true,
			boardOnly: () => true,
			gate: { check: () => null, device: () => null, token: () => "" } as any,
			pairing: { current: () => null } as any,
			pairUrls: () => [],
			cookie: () => "",
			sleep: async () => {},
			file: () => null,
			uiFile: () => new Response(""),
			uiVersions: async () => ({}),
			ping: () => ({}),
		}) as any;
		const id = doneTask();
		const ref = getItem(db, id)!.ref;
		const post = new Request(`http://localhost/api/items/${ref}/land`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
		const res = await routes["/api/items/:id/land"].POST(Object.assign(post, { params: { id: ref } }), {});
		expect(res.status).toBe(201);
		const body = (await res.json()) as { run: Run };
		expect(body.run.kind).toBe("land");
		await ended(db, body.run.id);
		const get = new Request("http://localhost/api/agents?project=repo", { headers: { "content-type": "application/json" } });
		const view = await (await routes["/api/agents"](get, {})).json();
		expect(view.counts).toBeDefined();
		expect(view.ready.some((r: { item: { id: number } }) => r.item.id === id)).toBe(true);
		expect(resolveItem(db, ref)).toBe(id);
	});
});

describe("firstLine", () => {
	test("the first line that says something, without its markdown", () => {
		expect(firstLine("\n- a1b2c3d on main: it\nmore")).toBe("a1b2c3d on main: it");
		expect(firstLine("## Done\nx")).toBe("Done");
		expect(firstLine("x".repeat(300)).length).toBe(200);
	});
});
