import type { Project } from "./db";

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
