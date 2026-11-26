/**
 * The landing desk (docs/agents.md, "Ready to land"): finished agent work whose branch isn't merged settles by itself.
 *
 * A pass on the computer (landingFacts: here on a computer, a helper job "landing" for the cloud board) looks at each
 * ready item's branch in its project's repo, cheaply: one `git log --grep` on the main branch for every item ref at
 * once, one `git for-each-ref`, and a few git calls per branch that still exists. For each item it says:
 *
 * - **landed**: in the main branch, by its branch (merged) or by a commit naming the item (wb-xxxx) when the branch is
 *   gone, or still there with nothing that isn't in main already (`git cherry`). The board records "Landed: found in
 *   <main> as <sha> <subject>" on the item once (settleLanding), and it stops being ready to land.
 * - **gone**, and not landed: lost. The Agents place shows it apart, with Ask the agent and Drop.
 * - still there and not merged: ready, with what it changes (commits ahead, files, lines, the last commit's subject)
 *   and whether it merges into main without conflicts (`git merge-tree`): "Land N clean" starts a merge run for those.
 *
 * It runs when the Agents place loads (kept LANDING_MAX_AGE) and once a day by itself (landingNightly). Git here only
 * reads: merge-tree's trial merge writes its objects to a temporary folder, never to the repo.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { addNote, getItem, projects, type Db, type Item, type Note, type Project } from "./db";
import { defaultBranch, refsIn } from "./git";

/** How long what a pass found is used again by the Agents place. */
export const LANDING_MAX_AGE = 120e3;
/** At most this many unmerged branches per project get what they change (a few git calls each, a trial merge). */
const MAX_BRANCHES = 60;
/** The pass that runs by itself: once a day. */
export const NIGHT_MS = 24 * 3600e3;

/** Where an item's work was found: `into` the main branch (or the integration branch the checkout is on), `by` its
 * branch being merged there, or a commit naming the item. */
export type Landed = { short: string; subject: string; by: "branch" | "ref"; into: string };
/** What the pass found for one item's branch. The numbers are there for a branch that exists and isn't landed. */
export type BranchFacts = {
	ref: string;
	branch: string;
	/** The branch here (local), only on origin (remote, as fetched), or on neither. */
	where: "local" | "remote" | "gone";
	landed: Landed | null;
	/** Commits the main branch hasn't. */
	ahead?: number;
	files?: number;
	added?: number;
	removed?: number;
	/** The last commit's subject. */
	last?: string;
	/** Merges into the main branch without conflicts (true), with conflicts (false), or not known (null: an older git). */
	clean?: boolean | null;
};
export type LandingFacts = { project: string; ok: boolean; error?: string; base: string; items: BranchFacts[] };
/** What a pass is asked about: an item's ref (without wb-) and its branch. */
export type Want = { ref: string; branch: string };

/* ---------- On the computer ---------- */

async function run(cwd: string, args: string[], env?: Record<string, string>) {
	const p = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", env: env ? { ...process.env, ...env } : undefined });
	const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
	return { out: out.trimEnd(), err: err.trim(), code };
}
async function git(cwd: string, ...args: string[]) {
	const r = await run(cwd, args);
	if (r.code !== 0) throw new Error(r.err || `git ${args[0]} failed`);
	return r.out;
}
const lines = (s: string) => s.split("\n").filter(Boolean);
/** A branch name the board may hand to git: never an option, nothing git would refuse as a branch. */
const okBranch = (b: string) => !!b && b.length < 250 && !/^-|\.\.|[\s~^:?*[\\]|@\{|\.lock$|\/$|^\/|\/\//.test(b);

/** The refs a repo has for its branches: refs/heads/x and refs/remotes/origin/x, by branch name. */
async function branchRefs(cwd: string) {
	const local = new Set<string>(), remote = new Set<string>();
	for (const r of lines(await git(cwd, "for-each-ref", "--format=%(refname)", "refs/heads", "refs/remotes/origin"))) {
		if (r.startsWith("refs/heads/")) local.add(r.slice(11));
		else if (r.startsWith("refs/remotes/origin/") && r !== "refs/remotes/origin/HEAD") remote.add(r.slice(20));
	}
	return { local, remote };
}
const refOf = (b: string, where: "local" | "remote") => (where === "local" ? `refs/heads/${b}` : `refs/remotes/origin/${b}`);

/** A few at a time. */
async function each<T>(list: T[], n: number, f: (x: T) => Promise<void>) {
	for (let i = 0; i < list.length; i += n) await Promise.all(list.slice(i, i + n).map(f));
}

/**
 * The pass for one project (helper job "landing"): what became of each item's branch. Only reads the repo.
 *
 * Landed means in the main branch, or in the branch the project's checkout is on when that's an integration branch
 * (not the main one, and not a branch an item names as its own: `own`), as agents.ts branchState counts it.
 */
export async function landingFacts(p: Pick<Project, "slug" | "path">, want: Want[], own: string[] = []): Promise<LandingFacts> {
	const none = { project: p.slug, base: "", items: [] as BranchFacts[] };
	if (!p.path) return { ...none, ok: false, error: "no path" };
	const cwd = p.path;
	let scratch = "";
	let env: Promise<Record<string, string>> | null = null;
	try {
		const base = await defaultBranch(cwd);
		const head = await git(cwd, "branch", "--show-current").catch(() => "");
		const into = [base, ...(head && head !== base && !own.includes(head) ? [head] : [])];
		const refs = [...new Set(want.map((w) => w.ref.toLowerCase()).filter((r) => /^[2-9a-hjkmnp-z]{4}$/.test(r)))];
		// Every commit that names one of these items in its subject (where agents put it: "… (wb-xxxx)"; a body that
		// mentions another item doesn't count), newest first: one git log for all of them, per branch it may be in.
		const found = new Map<string, Landed>();
		for (const target of into)
			for (let i = 0; i < refs.length; i += 200) {
				const chunk = refs.slice(i, i + 200);
				const log = await git(cwd, "log", target, "-i", "-E", `--grep=wb-(${chunk.join("|")})([^0-9a-z]|$)`, "--format=%h%x1f%s");
				for (const rec of lines(log)) {
					const [short, subject = ""] = rec.split("\x1f");
					for (const ref of refsIn(subject)) if (chunk.includes(ref) && !found.has(ref)) found.set(ref, { short, subject, by: "ref", into: target });
				}
			}
		const { local, remote } = await branchRefs(cwd);
		// merge-tree's trial merges write objects: into a folder of their own, the repo's read through it.
		const merge = async (ref: string): Promise<boolean | null> => {
			env ??= (async () => {
				const common = resolve(cwd, await git(cwd, "rev-parse", "--git-common-dir"));
				scratch = mkdtempSync(join(tmpdir(), "wb-landing-"));
				return { GIT_OBJECT_DIRECTORY: scratch, GIT_ALTERNATE_OBJECT_DIRECTORIES: join(common, "objects") };
			})();
			const r = await run(cwd, ["merge-tree", "--write-tree", "--name-only", "--no-messages", base, ref], await env);
			return r.code === 0 ? true : r.code === 1 ? false : null;
		};
		// What a branch that exists says, once per branch (several items may name one).
		const seen = new Map<string, Promise<{ merged: Landed | null; covered: (into: string) => Promise<boolean>; stats: () => Promise<Partial<BranchFacts>> }>>();
		const look = (ref: string) => {
			let hit = seen.get(ref);
			if (!hit) {
				hit = (async () => {
					let merged: Landed | null = null;
					for (const target of into)
						if ((await run(cwd, ["merge-base", "--is-ancestor", ref, target])).code === 0) {
							const [short, subject = ""] = (await git(cwd, "log", "-1", "--format=%h%x1f%s", ref)).split("\x1f");
							merged = { short, subject, by: "branch", into: target };
							break;
						}
					// Nothing on it that isn't in `target` already (merged under another name, rebased, cherry-picked).
					const covered = async (target: string) => !lines(await git(cwd, "cherry", target, ref)).some((l) => l.startsWith("+"));
					let had: Promise<Partial<BranchFacts>> | null = null;
					const stats = () => (had ??= (async () => {
						const [ahead, stat, last, clean] = await Promise.all([
							git(cwd, "rev-list", "--count", `${base}..${ref}`),
							git(cwd, "diff", "--shortstat", `${base}...${ref}`),
							git(cwd, "log", "-1", "--format=%s", ref),
							merge(ref).catch(() => null),
						]);
						return {
							ahead: Number(ahead) || 0,
							files: Number(stat.match(/(\d+) files? changed/)?.[1] ?? 0),
							added: Number(stat.match(/(\d+) insertions?/)?.[1] ?? 0),
							removed: Number(stat.match(/(\d+) deletions?/)?.[1] ?? 0),
							last,
							clean,
						};
					})());
					return { merged, covered, stats };
				})();
				seen.set(ref, hit);
			}
			return hit;
		};
		const items: BranchFacts[] = [];
		const close: { f: BranchFacts; ref: string }[] = [];
		for (const w of want) {
			const ref = w.ref.toLowerCase();
			const where = !okBranch(w.branch) ? "gone" : local.has(w.branch) ? "local" : remote.has(w.branch) ? "remote" : "gone";
			const f: BranchFacts = { ref, branch: w.branch, where, landed: null };
			items.push(f);
			if (where === "gone") f.landed = found.get(ref) ?? null;
			else close.push({ f, ref: refOf(w.branch, where) });
		}
		const statted = new Set<string>();
		await each(close, 6, async ({ f, ref }) => {
			const b = await look(ref);
			const named = found.get(f.ref);
			// Merged: by its branch (git says so while the branch is there, so it needs no note), shown as the commit that
			// names the item when there is one.
			if (b.merged) {
				f.landed = named ? { ...named, by: "branch" } : b.merged;
				return;
			}
			// Still here and not merged, but a commit names the item: landed when nothing on the branch is missing there.
			if (named && (await b.covered(named.into))) {
				f.landed = named;
				return;
			}
			if (!statted.has(ref) && statted.size >= MAX_BRANCHES) return;
			statted.add(ref);
			Object.assign(f, await b.stats());
		});
		return { project: p.slug, ok: true, base, items };
	} catch (e) {
		return { ...none, ok: false, error: (e as Error).message };
	} finally {
		if (scratch) rmSync(scratch, { recursive: true, force: true });
	}
}

export type DiffStat = {
	branch: string;
	base: string;
	commits: { short: string; subject: string }[];
	/** null lines: a binary file. */
	files: { path: string; added: number | null; removed: number | null }[];
	added: number;
	removed: number;
};

/** What a branch changes against the main branch (helper job "diffstat"): its commits and every file. Only reads. */
export async function diffstat(p: Pick<Project, "slug" | "path">, branch: string): Promise<DiffStat> {
	if (!p.path) throw new Error(`the project ${p.slug} has no folder on this computer`);
	const cwd = p.path;
	const base = await defaultBranch(cwd);
	const { local, remote } = await branchRefs(cwd);
	if (!okBranch(branch) || !(local.has(branch) || remote.has(branch))) throw new Error(`${branch} isn't on this computer`);
	const ref = refOf(branch, local.has(branch) ? "local" : "remote");
	const [log, num] = await Promise.all([git(cwd, "log", "-n", "100", "--format=%h%x1f%s", `${base}..${ref}`), git(cwd, "diff", "--numstat", `${base}...${ref}`)]);
	const files = lines(num)
		.slice(0, 500)
		.map((l) => {
			const [a, r, ...path] = l.split("\t");
			return { path: path.join("\t"), added: a === "-" ? null : Number(a), removed: r === "-" ? null : Number(r) };
		});
	return {
		branch,
		base,
		commits: lines(log).map((l) => {
			const [short, subject = ""] = l.split("\x1f");
			return { short, subject };
		}),
		files,
		added: files.reduce((n, f) => n + (f.added ?? 0), 0),
		removed: files.reduce((n, f) => n + (f.removed ?? 0), 0),
	};
}

/* ---------- On the board ---------- */

export type FactsRead = { facts: LandingFacts[]; limits: string[] };
/** One project's part of a pass: the items to look at, and the branches items name as their own (`own`). */
export type Ask = { project: Pick<Project, "slug" | "path">; want: Want[]; own: string[] };

const memo = new Map<string, { at: number; value: Promise<LandingFacts> }>();
/**
 * The pass, here or from a computer. On a computer it's read here, kept `maxAge` per project and what it's asked
 * about; the cloud board hands it to its computer helper (worker/src/helper.ts), and says in `limits` what it couldn't.
 * `fresh`: wait for a new answer (the daily pass) rather than take what's kept.
 */
export const landingGit = {
	facts: async (asks: Ask[], maxAge: number, _fresh = false): Promise<FactsRead> => {
		const facts = await Promise.all(
			asks.map(({ project: p, want, own }) => {
				const key = `${p.slug}:${p.path}:${want.map((w) => `${w.ref}=${w.branch}`).sort().join(",")}`;
				const hit = memo.get(key);
				if (hit && Date.now() - hit.at < maxAge) return hit.value;
				const value = landingFacts(p, want, own);
				memo.set(key, { at: Date.now(), value });
				return value;
			}),
		);
		return { facts, limits: [] };
	},
	diff: (p: Pick<Project, "slug" | "path">, branch: string): Promise<DiffStat> => diffstat(p, branch),
};
/** Forgets what was read (tests). */
export const forgetLanding = () => memo.clear();

/** How far back "ready to land" looks (agents.ts), and the daily pass with it. */
export const READY_DAYS = 14;
const sqlTime = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");

/** The branches agent items name as their own: open ones, and those done in the last READY_DAYS. The branch the
 * project's checkout is on counts as an integration branch only when it isn't one of them (agents.ts branchState). */
export function itemBranches(db: Db, project: string, now = Date.now()): Set<string> {
	const rows = db
		.query(
			"SELECT DISTINCT branch FROM items WHERE project = ? AND owner = 'agent' AND branch != '' AND (status IN ('todo', 'doing', 'waiting') OR (status = 'done' AND done_at >= ?))",
		)
		.all(project, sqlTime(now - READY_DAYS * 86400e3)) as { branch: string }[];
	return new Set(rows.map((r) => r.branch));
}

/** The note the board writes on an item whose work it found in the main branch. */
const LANDED = "Landed: found in ";
export const landedNote = (notes: Note[]) => notes.find((n) => n.author === "workbench" && n.text.startsWith(LANDED));

/** What the pass says about one item, with the main branch it measured against. */
export type ItemFacts = BranchFacts & { base: string };

/**
 * The pass over `items` (done agent items with a branch), for their projects among `list`: what it found per item id,
 * and "Landed: …" recorded on each one found by a commit naming it (once: an item that has the note isn't asked about
 * again). One whose branch is merged needs no note: git says so as long as the branch is there.
 */
export async function settleLanding(db: Db, list: Project[], items: (Item & { notes: Note[] })[], maxAge = LANDING_MAX_AGE, fresh = false): Promise<{ by: Map<number, ItemFacts>; limits: string[] }> {
	const by = new Map<number, ItemFacts>();
	const todo = items.filter((i) => i.branch && !landedNote(i.notes));
	const asks = list
		.map((p) => ({ project: { slug: p.slug, path: p.path }, want: todo.filter((i) => i.project === p.slug).map((i) => ({ ref: i.ref, branch: i.branch })), own: [] as string[] }))
		.filter((a) => a.want.length && a.project.path);
	for (const a of asks) a.own = [...itemBranches(db, a.project.slug)].sort();
	if (!asks.length) return { by, limits: [] };
	const read = await landingGit.facts(asks, maxAge, fresh);
	const of = new Map(read.facts.filter((f) => f?.ok).map((f) => [f.project, f]));
	for (const i of todo) {
		const f = of.get(i.project);
		const it = f?.items.find((x) => x.ref === i.ref.toLowerCase() && x.branch === i.branch);
		if (!f || !it) continue;
		by.set(i.id, { ...it, base: f.base });
		if (it.landed?.by === "ref") {
			// Read again: another pass (the page's poll, the daily one) may have just written it.
			const now = getItem(db, i.id);
			if (now && now.status === "done" && !landedNote(now.notes))
				addNote(db, i.id, `${LANDED}${it.landed.into || f.base} as ${it.landed.short} ${it.landed.subject}`.trim(), "workbench");
		}
	}
	return { by, limits: read.limits };
}

/**
 * The pass that runs by itself, once a day (NIGHT_MS), over every project's finished agent work with a branch: from
 * the board's hourly look on a computer (server.ts), and the helper's tick on the cloud board. `last` keeps when it
 * last ran. Returns how many items it found landed, or null when it wasn't due.
 */
export async function landingNightly(db: Db, last: { get(): number; set(ms: number): void }, now = Date.now()): Promise<number | null> {
	if (now - last.get() < NIGHT_MS) return null;
	last.set(now);
	const from = sqlTime(now - READY_DAYS * 86400e3);
	const ids = db.query("SELECT id FROM items WHERE owner = 'agent' AND status = 'done' AND branch != '' AND done_at >= ?").all(from) as { id: number }[];
	const items = ids.map((r) => getItem(db, r.id)!).filter(Boolean);
	const list = projects(db).filter((p) => !p.archived_at && items.some((i) => i.project === p.slug));
	const before = items.filter((i) => landedNote(i.notes)).length;
	await settleLanding(db, list, items, 0, true);
	return ids.map((r) => getItem(db, r.id)!).filter((i) => i && landedNote(i.notes)).length - before;
}

/** GET /api/items/:id/diff: what a done item's branch changes, for the reader (here, or the helper's "diffstat" job). */
export async function itemDiff(db: Db, id: number): Promise<DiffStat> {
	const i = getItem(db, id);
	if (!i) throw new Error(`no item #${id}`);
	if (!i.branch) throw new Error(`wb-${i.ref} names no branch`);
	const p = projects(db).find((x) => x.slug === i.project);
	if (!p?.path) throw new Error(`the project ${i.project} has no folder (Settings → Projects)`);
	return landingGit.diff({ slug: p.slug, path: p.path }, i.branch);
}
