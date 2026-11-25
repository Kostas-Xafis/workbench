/**
 * The Agents place (docs/agents.md, "The Agents place"): what every project's agents are doing now, what finished but
 * isn't merged, what's stuck and what finished, in one answer (GET /api/agents), and Merge it (POST
 * /api/items/:id/land, `wb land`), which starts a run that lands a done item's branch (dispatch.ts startLand).
 *
 * - **Running**: the runs the board started that are still going, and the agent items in doing that are alive (alive.ts).
 * - **Ready to land**: agent items done in the last READY_DAYS whose branch isn't merged into the project's main
 *   branch, from the git state the board already reads (git.ts repoState and codeLinks; a merged pull request that
 *   names the item counts as merged).
 * - **Stuck**: open agent items whose last run failed or was stopped, that wait on Kostas, that have waited long, or
 *   that have had no sign of life for a day while doing (stale.ts); and done ones whose merge run failed.
 * - **Finished**: agent items done since `since` (24 hours unless asked).
 *
 * Git comes through `agentGit.read`: on a computer it's read here (at most every 30 s for the state, 90 s for commits
 * and pull requests, which ask `gh`); the cloud board hands it to its computer helper's cache (worker/src/helper.ts),
 * and says in `limits` what it couldn't know.
 */
import { getItem, listItems, projects, type Db, type Item, type Note, type Project } from "./db";
import { codeLinks, repoState, type CodeLinks, type PullRequest, type RepoState } from "./git";
import { blockersOf } from "./links";
import { getRun, itemRefusal, landRefusal, liveRuns, startLand, startRefusal, type From, type Run } from "./dispatch";

/** How far back "ready to land" looks. */
export const READY_DAYS = 14;
const OPEN = ["todo", "doing", "waiting"];

/* ---------- Git, here or from a computer ---------- */

export type GitRead = { repos: RepoState[]; code: CodeLinks; limits: string[] };

const repoCache = new Map<string, { at: number; value: Promise<RepoState> }>();
const codeCache = new Map<string, { at: number; value: Promise<CodeLinks> }>();
function memo<T>(cache: Map<string, { at: number; value: Promise<T> }>, key: string, maxAge: number, read: () => Promise<T>) {
	const hit = cache.get(key);
	if (hit && Date.now() - hit.at < maxAge) return hit.value;
	const value = read();
	cache.set(key, { at: Date.now(), value });
	return value;
}

/** Reads the git state of `list` (`only`: the one slug asked for, or null for every project). The cloud board
 * replaces it (worker/src/helper.ts). */
export const agentGit = {
	read: async (list: Project[], _only: string | null): Promise<GitRead> => {
		const [repos, code] = await Promise.all([
			Promise.all(list.map((p) => memo(repoCache, `${p.slug}:${p.path}`, 30e3, () => repoState(p)))),
			Promise.all(list.map((p) => memo(codeCache, `${p.slug}:${p.path}`, 90e3, () => codeLinks(p)))),
		]);
		return { repos, code: Object.assign({}, ...code), limits: [] };
	},
};
/** Forgets what was read (tests). */
export const forgetGit = () => (repoCache.clear(), codeCache.clear());

/**
 * Where an item's branch stands: merged into the main branch or not, or unknown (`known: false`, with why). `missing`:
 * neither the local branches nor origin's remote-tracking ones have it ("branch not found on this computer"), so it may
 * be merged and deleted, or pushed from elsewhere and never fetched: not known, never taken as merged.
 *
 * `own`: the branches agent items name as their own (open or recently done). The branch the project's checkout is on
 * counts as an integration branch (what's merged there has landed) only when it isn't one of them: a feature branch
 * checked out in the main folder doesn't make everything landed.
 */
export type BranchState = { known: boolean; merged: boolean; base: string; ahead: number | null; worktree: string; why?: string; into?: string; missing?: boolean };

export const NOT_FOUND = "branch not found on this computer";

export function branchState(i: Pick<Item, "ref" | "branch" | "project">, repo: RepoState | undefined, code: CodeLinks, own: ReadonlySet<string> = new Set()): BranchState {
	const base = repo?.base ?? "";
	const worktree = repo?.worktrees.find((w) => w.branch === i.branch)?.path ?? "";
	const none = { known: false, merged: false, base, ahead: null, worktree };
	if (!i.branch) return { ...none, why: "no branch" };
	if (code[i.ref]?.prs.some((p) => p.state === "MERGED")) return { known: true, merged: true, base, ahead: 0, worktree };
	if (!repo?.ok) return { ...none, why: repo?.error || "no git state" };
	if (i.branch === base || (!base && ["main", "master"].includes(i.branch))) return { known: true, merged: true, base, ahead: 0, worktree };
	const open = repo.unmerged.find((b) => b.name === i.branch);
	// Merged into the branch the project's checkout is on (an integration branch, when that isn't the main one and no
	// agent item calls it its own): landed.
	const integration = !!repo.branch && repo.branch !== base && !own.has(repo.branch);
	if (open && integration && repo.unmergedHead && !repo.unmergedHead.includes(i.branch))
		return { known: true, merged: true, base, ahead: 0, worktree, into: repo.branch };
	if (open) return { known: true, merged: false, base, ahead: open.ahead ?? null, worktree };
	// Pushed to origin and not merged there, though not (or no longer) a branch here.
	const pushed = repo.remoteUnmerged?.find((b) => b.name === i.branch);
	if (pushed) return { known: true, merged: false, base, ahead: pushed.ahead ?? null, worktree };
	// An older helper doesn't list the branches: a branch not among the unmerged ones can't be told from a missing one.
	if (!repo.branches) return { ...none, why: "the computer that sends git state has an older Workbench app" };
	// A branch git has, not among the unmerged ones: merged.
	if (repo.branches.includes(i.branch) || repo.remoteBranches?.includes(i.branch)) return { known: true, merged: true, base, ahead: 0, worktree };
	return { ...none, why: NOT_FOUND, missing: true };
}

/** The branches agent items name as their own: open ones, and those done in the last READY_DAYS (branchState's `own`). */
export function itemBranches(db: Db, project: string, now = Date.now()): Set<string> {
	const rows = db
		.query(
			"SELECT DISTINCT branch FROM items WHERE project = ? AND owner = 'agent' AND branch != '' AND (status IN ('todo', 'doing', 'waiting') OR (status = 'done' AND done_at >= ?))",
		)
		.all(project, sqlTime(now - READY_DAYS * 86400e3)) as { branch: string }[];
	return new Set(rows.map((r) => r.branch));
}

/** The pull request to show for an item: an open one first, else the newest. */
const prOf = (prs: PullRequest[] = []) => prs.find((p) => p.state === "OPEN") ?? prs[0] ?? null;

/* ---------- The view ---------- */

/** An item as the Agents place shows it. */
const brief = (i: Item) => ({
	id: i.id,
	ref: i.ref,
	project: i.project,
	title: i.title,
	kind: i.kind,
	owner: i.owner,
	status: i.status,
	priority: i.priority,
	branch: i.branch,
	session: i.session,
	desktop: i.desktop ?? "",
	alive: !!i.alive,
	alive_at: i.alive_at ?? null,
	stale: i.stale ?? null,
	updated_at: i.updated_at,
	done_at: i.done_at,
});
export type AgentItem = ReturnType<typeof brief>;
/** A run as the Agents place shows it: without its tail and command. */
const runBrief = (r: Run | undefined | null) => {
	if (!r) return null;
	const { tail: _, command: __, ...rest } = r;
	return rest;
};
export type AgentRun = NonNullable<ReturnType<typeof runBrief>>;

/** A change line the board writes ("status: todo → doing", "branch: — → x · owner: …") or "created": not news. */
const isChange = (t: string) => t === "created" || /^[a-z_]+: [^\n]*→[^\n]*$/.test(t);
/** The first line of a note, plain, for a list. */
export function firstLine(text: string, max = 200) {
	const line = (text.split("\n").find((l) => l.trim()) ?? "").trim().replace(/^(#+|[-*]|\d+\.)\s+/, "");
	return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
/** The newest note that says something (not one of the board's own lines, nor a change line). */
const lastWords = (notes: Note[]) => [...notes].reverse().find((n) => n.author !== "workbench" && !isChange(n.text));
/** What the agent said when it finished: the first note that says something from its done time on, else the last before. */
function doneWords(notes: Note[], doneAt: string | null) {
	const all = notes.filter((n) => n.author !== "workbench" && !isChange(n.text));
	// The agent's words first: a note of yours after it finished isn't what it did.
	const agents = all.filter((n) => n.author === "agent");
	const said = agents.length ? agents : all;
	return (doneAt ? said.find((n) => n.at >= doneAt) : undefined) ?? said.at(-1);
}
const sqlTime = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");
const msOf = (t: string) => Date.parse(t.replace(" ", "T") + "Z");
const days = (n: number) => `${n} day${n === 1 ? "" : "s"}`;
const ageDays = (t: string, now: number) => Math.max(1, Math.floor((now - msOf(t)) / 86400e3));

/** `event`: the newest thing its run said or did (a run_events row, its text in one line), null without a live run. */
export type Running = { item: AgentItem; run: AgentRun | null; note: string; branch: string; started_at: string; alive_at: string | null; event: { kind: string; tool: string; text: string; at: string } | null };
export type Ready = {
	item: AgentItem;
	branch: string;
	base: string;
	/** Commits on the branch that the main branch hasn't; null when the git state doesn't say. */
	ahead: number | null;
	/** Commits that name the item (wb-xxxx), on any branch. */
	commits: number;
	pr: PullRequest | null;
	worktree: string;
	note: string;
	land: { allowed: boolean; why: string };
	last_land: AgentRun | null;
	/** false: known not to be merged. null: not known, with why in `unknown` ("branch not found on this computer"). */
	merged: false | null;
	unknown: string;
};
export type Stuck = {
	item: AgentItem;
	why: string;
	reason: "failed" | "stopped" | "waits-on-you" | "waiting" | "no-sign-of-life" | "land-failed" | "land-stopped";
	since: string;
	run: AgentRun | null;
	/** Run again (dispatch.ts's restart rule), or Merge it again for a merge run that broke. */
	again: { kind: "run" | "land"; allowed: boolean; why: string };
};
export type Finished = { item: AgentItem; note: string; branch: string; commits: number; ahead: number | null; merged: boolean | null; done_at: string };
export type AgentsView = {
	project: string;
	since: string;
	running: Running[];
	ready: Ready[];
	stuck: Stuck[];
	finished: Finished[];
	counts: { running: number; ready: number; stuck: number; finished: number };
	/** Whether this client may start agents now (on, limits), and why not: Run again and Merge it need it too. */
	start: { allowed: boolean; why: string };
	/** What the board couldn't know (git state on the cloud board, a folder git can't read), in words. */
	limits: string[];
};

/** The projects asked for: one slug, or `*` (every one that isn't archived). Throws for an unknown slug. */
function projectsOf(db: Db, project: string) {
	const all = projects(db);
	if (!project || project === "*") return all.filter((p) => !p.archived_at);
	const p = all.find((x) => x.slug === project);
	if (!p) throw new Error(`no project "${project}"`);
	return [p];
}

/** GET /api/agents: the Agents place in one answer. `from`: who asks (whether they may start agents). */
export async function agentsView(db: Db, q: { project?: string; since?: string } = {}, from: From | null = null, now = Date.now()): Promise<AgentsView> {
	const project = q.project || "*";
	const list = projectsOf(db, project);
	const slugs = new Set(list.map((p) => p.slug));
	let sinceMs = now - 86400e3;
	if (q.since) {
		sinceMs = Date.parse(q.since);
		if (!Number.isFinite(sinceMs)) throw new Error(`since must be a date and time (ISO 8601), not "${q.since}"`);
	}
	const since = sqlTime(sinceMs);
	const readyFrom = sqlTime(now - READY_DAYS * 86400e3);
	const limits: string[] = [];

	// What's open, what finished lately, and the runs on them.
	const open = listItems(db, { owner: "agent", status: OPEN as Item["status"][] }).filter((i) => slugs.has(i.project));
	const doneIds = (
		db.query("SELECT id FROM items WHERE owner = 'agent' AND status = 'done' AND done_at >= ? ORDER BY done_at DESC, id DESC").all([readyFrom, since].sort()[0]) as { id: number }[]
	).map((r) => r.id);
	const done = doneIds.map((id) => getItem(db, id)!).filter((i) => i && slugs.has(i.project));
	const latest = new Map(
		(db.query("SELECT item_id, MAX(id) AS id FROM runs GROUP BY item_id").all() as { item_id: number; id: number }[]).map((r) => [r.item_id, r.id]),
	);
	const latestRun = (id: number) => (latest.has(id) ? getRun(db, latest.get(id)!) : undefined);
	const notesOf = (() => {
		const ids = open.map((i) => i.id);
		const by = new Map<number, Note[]>();
		for (let n = 0; n < ids.length; n += 500) {
			const chunk = ids.slice(n, n + 500);
			for (const note of db.query(`SELECT * FROM notes WHERE item_id IN (${chunk.map(() => "?").join(", ")}) ORDER BY at, id`).all(...chunk) as Note[])
				(by.get(note.item_id) ?? by.set(note.item_id, []).get(note.item_id)!).push(note);
		}
		for (const i of done) by.set(i.id, i.notes);
		return (id: number) => by.get(id) ?? getItem(db, id)?.notes ?? [];
	})();

	// Git, for the projects whose finished work has a branch.
	const withBranch = new Set(done.filter((i) => i.branch).map((i) => i.project));
	let git: GitRead = { repos: [], code: {}, limits: [] };
	const gitProjects = list.filter((p) => withBranch.has(p.slug));
	if (gitProjects.length) {
		try {
			git = await agentGit.read(project === "*" ? list : gitProjects, project === "*" ? null : project);
		} catch (e) {
			limits.push(`The board couldn't read git: ${(e as Error).message}`);
		}
	}
	limits.push(...git.limits);
	const repoOf = new Map(git.repos.map((r) => [r.project, r]));
	const own = new Map<string, Set<string>>();
	for (const i of [...open, ...done])
		if (i.branch && (i.status !== "done" || (i.done_at ?? "") >= readyFrom)) (own.get(i.project) ?? own.set(i.project, new Set()).get(i.project)!).add(i.branch);
	const stateOf = (i: Item) => branchState(i, repoOf.get(i.project), git.code, own.get(i.project));
	const unknown = new Map<string, { n: number; why: string }>();

	const start = from ? await startRefusal(db, from) : { why: "Agents start only from the board on this computer, or a phone paired with it." };
	const startOk = { allowed: !start, why: start?.why ?? "" };
	const landWhy = (i: Item, s: BranchState) =>
		landRefusal(db, i) ?? (s.known && s.merged ? `${i.branch} is merged into ${s.base || "the main branch"} already` : "");

	// ---- Running: live runs, then alive items without one ----
	const running: Running[] = [];
	const taken = new Set<number>();
	for (const r of liveRuns(db)) {
		if (!slugs.has(r.project) || taken.has(r.item_id)) continue;
		const i = getItem(db, r.item_id);
		if (!i) continue;
		taken.add(i.id);
		const ev = db.query("SELECT kind, tool, text, at FROM run_events WHERE run_id = ? AND kind != 'message' ORDER BY n DESC LIMIT 1").get(r.id) as Running["event"];
		running.push({
			item: brief(i),
			run: runBrief(r),
			note: firstLine(lastWords(i.notes)?.text ?? ""),
			branch: i.branch,
			started_at: r.started_at,
			alive_at: i.alive_at ?? null,
			event: ev ? { ...ev, tool: ev.tool ?? "", text: firstLine(ev.text) } : null,
		});
	}
	// Alive and in doing: a waiting or to-do item an agent touched isn't running (it may still be stuck below).
	for (const i of open) {
		if (taken.has(i.id) || !i.alive || i.status !== "doing") continue;
		taken.add(i.id);
		const notes = notesOf(i.id);
		const began = [...notes].reverse().find((n) => /(^|· )status: \w+ → doing/.test(n.text))?.at;
		running.push({ item: brief(i), run: runBrief(latestRun(i.id)), note: firstLine(lastWords(notes)?.text ?? ""), branch: i.branch, started_at: began ?? i.alive_at ?? i.updated_at, alive_at: i.alive_at ?? null, event: null });
	}

	// ---- Stuck ----
	const stuck: Stuck[] = [];
	for (const i of open) {
		if (taken.has(i.id)) continue;
		const last = latestRun(i.id);
		const again = () => {
			const why = itemRefusal(db, i) ?? start?.why ?? "";
			return { kind: "run" as const, allowed: !why, why };
		};
		const add = (why: string, reason: Stuck["reason"], at: string) => stuck.push({ item: brief(i), why, reason, since: at, run: runBrief(last), again: again() });
		if (last?.ended_at && (last.status === "failed" || last.status === "stopped")) {
			const what = last.kind === "land" ? "its merge run" : "its run";
			if (last.status === "failed") add(`${what} failed${last.error ? `: ${last.error}` : ""}`, "failed", last.ended_at);
			else add(`${what} was stopped`, "stopped", last.ended_at);
			continue;
		}
		if (i.status === "waiting") {
			const ask = blockersOf(db, i.id).find((b) => b.owner === "kostas" && OPEN.includes(b.status));
			if (ask) {
				add(`waits on you: ${ask.title}`, "waits-on-you", i.stale?.since ?? i.updated_at);
				continue;
			}
			if (i.stale?.why === "waiting") add(`waiting ${days(ageDays(i.stale.since, now))}`, "waiting", i.stale.since);
			continue;
		}
		if (i.status === "doing" && i.stale?.why === "stalled") add(`no sign of life for ${days(ageDays(i.stale.since, now))}`, "no-sign-of-life", i.stale.since);
	}

	// ---- Ready to land, and merge runs that broke ----
	const ready: Ready[] = [];
	for (const i of done) {
		if (taken.has(i.id) || !i.branch || (i.done_at ?? "") < readyFrom) continue;
		const s = stateOf(i);
		// A branch git has nowhere here is shown, as not known: it may be on a computer that hasn't fetched it.
		if (!s.known && !s.missing) {
			const u = unknown.get(i.project) ?? { n: 0, why: s.why ?? "" };
			u.n++;
			unknown.set(i.project, u);
			continue;
		}
		if (s.merged) continue;
		const last = latestRun(i.id);
		const why = landWhy(i, s) || start?.why || "";
		if (last?.kind === "land" && last.ended_at && (last.status === "failed" || last.status === "stopped")) {
			stuck.push({
				item: brief(i),
				why: last.status === "failed" ? `its merge run failed${last.error ? `: ${last.error}` : ""}` : "its merge run was stopped",
				reason: last.status === "failed" ? "land-failed" : "land-stopped",
				since: last.ended_at,
				run: runBrief(last),
				again: { kind: "land", allowed: !why, why },
			});
			continue;
		}
		ready.push({
			item: brief(i),
			branch: i.branch,
			base: s.base,
			ahead: s.ahead,
			commits: git.code[i.ref]?.commits.length ?? 0,
			pr: prOf(git.code[i.ref]?.prs),
			worktree: s.worktree,
			note: firstLine(doneWords(i.notes, i.done_at)?.text ?? ""),
			land: { allowed: !why, why },
			last_land: runBrief(last?.kind === "land" ? last : undefined),
			merged: s.known ? false : null,
			unknown: s.known ? "" : (s.why ?? ""),
		});
	}
	for (const [slug, u] of unknown)
		limits.push(`${slug}: the board can't tell which branches are merged (${u.why}), so ${u.n} finished item${u.n === 1 ? "" : "s"} with a branch ${u.n === 1 ? "isn't" : "aren't"} under ready to land.`);

	// ---- Finished ----
	const finished: Finished[] = done
		.filter((i) => (i.done_at ?? "") >= since)
		.map((i) => {
			const s = i.branch ? stateOf(i) : null;
			return {
				item: brief(i),
				note: firstLine(doneWords(i.notes, i.done_at)?.text ?? ""),
				branch: i.branch,
				commits: git.code[i.ref]?.commits.length ?? 0,
				ahead: s?.known && !s.merged ? s.ahead : s?.known ? 0 : null,
				merged: s?.known ? s.merged : null,
				done_at: i.done_at!,
			};
		});

	return {
		project,
		since,
		running,
		ready,
		stuck,
		finished,
		counts: { running: running.length, ready: ready.length, stuck: stuck.length, finished: finished.length },
		start: startOk,
		limits,
	};
}

/* ---------- Merge it ---------- */

/** Whether an item's branch is still to land, from the git state the board has: refused only when it's known to be
 * merged (an unknown state goes ahead: the agent finds out). */
async function branchCheck(db: Db, i: Item): Promise<{ why?: string; base?: string }> {
	const p = projects(db).find((x) => x.slug === i.project);
	if (!p) return {};
	let git: GitRead;
	try {
		git = await agentGit.read([p], p.slug);
	} catch {
		return {};
	}
	const s = branchState(i, git.repos.find((r) => r.project === p.slug), git.code, itemBranches(db, p.slug));
	if (s.known && s.merged) return { why: `${i.branch} is merged into ${s.base || "the main branch"} already` };
	return { base: s.base };
}

/** POST /api/items/:id/land, `wb land`: a run that lands this done item's branch (dispatch.ts startLand). */
export const landItem = (db: Db, itemId: number, from: From) => startLand(db, itemId, from, (i) => branchCheck(db, i));
