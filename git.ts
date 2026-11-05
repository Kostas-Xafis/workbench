import type { Project } from "./db";
import { shellPath } from "./trackers";

export type RepoState = {
	project: string;
	ok: boolean;
	error?: string;
	branch: string;
	dirty: string[];
	ahead: number;
	behind: number;
	unmerged: { name: string; date: string }[];
	worktrees: { path: string; branch: string }[];
	lastCommit: string;
};

async function git(cwd: string, ...args: string[]) {
	const p = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
	const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
	if (code !== 0) throw new Error((await new Response(p.stderr).text()).trim() || `git ${args[0]} failed`);
	return out.trimEnd();
}

const lines = (s: string) => s.split("\n").filter(Boolean);

async function defaultBranch(cwd: string) {
	try {
		return (await git(cwd, "symbolic-ref", "--short", "refs/remotes/origin/HEAD")).replace(/^origin\//, "");
	} catch {
		const local = lines(await git(cwd, "branch", "--format=%(refname:short)"));
		return local.includes("main") ? "main" : "master";
	}
}

export async function repoState(p: Project): Promise<RepoState> {
	const empty = {
		project: p.slug,
		branch: "",
		dirty: [],
		ahead: 0,
		behind: 0,
		unmerged: [],
		worktrees: [],
		lastCommit: "",
	};
	if (!p.path) return { ...empty, ok: false, error: "no path" };
	try {
		const cwd = p.path;
		const base = await defaultBranch(cwd);
		const [branch, status, unmerged, worktrees, lastCommit] = await Promise.all([
			git(cwd, "branch", "--show-current"),
			git(cwd, "status", "--porcelain"),
			git(cwd, "branch", "--no-merged", base, "--format=%(refname:short)\t%(committerdate:short)"),
			git(cwd, "worktree", "list", "--porcelain"),
			git(cwd, "log", "-1", "--format=%h %cr · %s"),
		]);
		let ahead = 0;
		let behind = 0;
		try {
			const counts = await git(cwd, "rev-list", "--left-right", "--count", "@{upstream}...HEAD");
			[behind, ahead] = counts.split(/\s+/).map(Number);
		} catch {}
		const trees = worktrees
			.split("\n\n")
			.slice(1)
			.map((block) => ({
				path: block.match(/^worktree (.+)$/m)?.[1] ?? "",
				branch: block.match(/^branch refs\/heads\/(.+)$/m)?.[1] ?? "(detached)",
			}));
		return {
			project: p.slug,
			ok: true,
			branch,
			dirty: lines(status),
			ahead,
			behind,
			unmerged: lines(unmerged).map((l) => {
				const [name, date] = l.split("\t");
				return { name, date };
			}),
			worktrees: trees,
			lastCommit,
		};
	} catch (e) {
		return { ...empty, ok: false, error: (e as Error).message };
	}
}

export type Commit = { hash: string; short: string; date: string; subject: string; url: string };
export type PullRequest = {
	number: number;
	title: string;
	/** OPEN, MERGED or CLOSED. */
	state: string;
	draft: boolean;
	/** APPROVED, CHANGES_REQUESTED, REVIEW_REQUIRED or ''. */
	review: string;
	checks: "passing" | "failing" | "pending" | "";
	url: string;
};
/** Commits and pull requests that mention an item, by its ref (`k3f9` for wb-k3f9). */
export type CodeLinks = Record<string, { commits: Commit[]; prs: PullRequest[] }>;

// The ref alphabet has no 0, 1, i, l or o.
const REF = /\bwb-([2-9a-hjkmnp-z]{4})\b/gi;
const refsIn = (text: string) => new Set(Array.from(text.matchAll(REF), (m) => m[1].toLowerCase()));

/** https://github.com/owner/repo for an origin on GitHub, else ''. */
export function githubWeb(remote: string) {
	const m = remote.trim().match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/);
	return m ? `https://github.com/${m[1]}/${m[2]}` : "";
}

type GhCheck = { conclusion?: string; status?: string; state?: string };
function checkState(rollup: GhCheck[] = []): PullRequest["checks"] {
	if (!rollup.length) return "";
	const states = rollup.map((c) => (c.conclusion || c.state || c.status || "").toUpperCase());
	if (states.some((s) => ["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED"].includes(s))) return "failing";
	if (states.some((s) => ["", "PENDING", "QUEUED", "IN_PROGRESS", "EXPECTED", "WAITING"].includes(s))) return "pending";
	return "passing";
}

async function ghPulls(cwd: string) {
	// gh may be missing or signed out; the board then just shows commits.
	try {
		const p = Bun.spawn(
			[
				"gh",
				"pr",
				"list",
				"--state",
				"all",
				"--limit",
				"200",
				"--json",
				"number,title,body,headRefName,state,isDraft,reviewDecision,statusCheckRollup,url",
			],
			// The terminal's PATH: under systemd the board's own may not reach gh (~/.local/bin, Homebrew, …).
			{ cwd, stdout: "pipe", stderr: "ignore", env: { ...process.env, PATH: await shellPath(), GH_PROMPT_DISABLED: "1" } },
		);
		const timer = setTimeout(() => p.kill(), 12000);
		const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
		clearTimeout(timer);
		return code === 0 ? (JSON.parse(out) as Record<string, unknown>[]) : [];
	} catch {
		return [];
	}
}

export async function codeLinks(p: Project): Promise<CodeLinks> {
	const out: CodeLinks = {};
	if (!p.path) return out;
	const at = (ref: string) => (out[ref] ??= { commits: [], prs: [] });
	let web = "";
	try {
		web = githubWeb(await git(p.path, "remote", "get-url", "origin"));
	} catch {}
	try {
		const log = await git(p.path, "log", "--all", "-i", "--grep=wb-", "-n", "2000", "--format=%H%x1f%h%x1f%cs%x1f%s%x1f%b%x1e");
		for (const rec of log.split("\x1e")) {
			const [hash, short, date, subject, body = ""] = rec.trim().split("\x1f");
			if (!hash) continue;
			for (const ref of refsIn(`${subject}\n${body}`))
				at(ref).commits.push({ hash, short, date, subject, url: web && `${web}/commit/${hash}` });
		}
	} catch {}
	if (web)
		for (const pr of await ghPulls(p.path)) {
			const refs = refsIn(`${pr.title}\n${pr.body ?? ""}\n${String(pr.headRefName ?? "").replaceAll("/", " ")}`);
			for (const ref of refs)
				at(ref).prs.push({
					number: pr.number as number,
					title: pr.title as string,
					state: pr.state as string,
					draft: Boolean(pr.isDraft),
					review: (pr.reviewDecision as string) || "",
					checks: checkState(pr.statusCheckRollup as GhCheck[]),
					url: pr.url as string,
				});
		}
	return out;
}
