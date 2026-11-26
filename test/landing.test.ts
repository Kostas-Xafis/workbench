// The landing desk (landing.ts): finished agent work settles by itself against a real git repo in a temp folder: a
// branch merged, one merged under another name (a commit naming the item), one lost, one clean, one that conflicts.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { addItem, addProject, getItem, updateItem, type Db } from "../src/db";
import { agentsView, forgetGit } from "../src/agents";
import { diffstat, forgetLanding, itemDiff, landingFacts, landingGit, landingNightly, NIGHT_MS, settleLanding } from "../src/landing";
import type { From } from "../src/dispatch";
import { updateSettings } from "../src/settings";
import { freshDb } from "./helpers";

const dir = mkdtempSync(join(process.env.WB_TEST_DIR!, "landing-"));
const repo = join(dir, "repo");
mkdirSync(repo);
const git = (...args: string[]) => {
	const p = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "init.defaultBranch=master", "-c", "commit.gpgsign=false", ...args], { cwd: repo });
	if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr.toString()}`);
	return p.stdout.toString().trim();
};
const commit = (file: string, text: string, msg: string) => {
	writeFileSync(join(repo, file), text);
	git("add", file);
	git("commit", "-q", "-m", msg);
};
/** Every object file git keeps loose, so a test can see the pass wrote none. */
const looseObjects = () =>
	readdirSync(join(repo, ".git", "objects"))
		.filter((d) => /^[0-9a-f]{2}$/.test(d))
		.flatMap((d) => readdirSync(join(repo, ".git", "objects", d)))
		.sort();

const here: From = { where: "local", label: "this computer" };
let db: Db;
const ids: Record<string, number> = {};
const ref = (k: string) => getItem(db, ids[k])!.ref;

beforeAll(() => {
	db = freshDb();
	addProject(db, { slug: "repo", name: "Repo", path: repo });
	updateSettings(db, { "agents.on": true, "agents.per-day": 50 });
	const done = (k: string, branch: string) => {
		ids[k] = addItem(db, { title: `Work ${k}`, project: "repo", owner: "agent", branch });
		updateItem(db, ids[k], { status: "done" }, "agent", `done on ${branch}`);
	};
	done("merged", "feat-merged");
	done("renamed", "feat-old-name");
	done("lost", "feat-lost");
	done("clean", "feat-clean");
	done("conflict", "feat-conflict");
	done("shared", "feat-clean");

	git("init", "-q");
	commit("a.txt", "one\ntwo\nthree\n", "start");
	// Merged with its branch kept.
	git("checkout", "-q", "-b", "feat-merged");
	commit("m.txt", "m\n", `merged work (wb-${ref("merged")})`);
	git("checkout", "-q", "master");
	git("merge", "-q", "--no-ff", "-m", "Merge feat-merged", "feat-merged");
	// Landed under another name: the branch the item names is gone, a commit on master names the item.
	git("checkout", "-q", "-b", "feat-new-name");
	commit("r.txt", "r\n", `renamed work (wb-${ref("renamed")})`);
	git("checkout", "-q", "master");
	git("merge", "-q", "--no-ff", "-m", `Merge: renamed work (wb-${ref("renamed")})`, "feat-new-name");
	git("branch", "-q", "-D", "feat-new-name");
	// A body that mentions the lost item doesn't land it.
	commit("x.txt", "x\n", `unrelated\n\nfollows up wb-${ref("lost")}`);
	// Clean: a new file. Conflicting: the line master changes too.
	git("checkout", "-q", "-b", "feat-clean");
	commit("c.txt", "c1\nc2\n", `clean work (wb-${ref("clean")})`);
	git("checkout", "-q", "master");
	git("checkout", "-q", "-b", "feat-conflict");
	commit("a.txt", "one\nTWO on the branch\nthree\n", `conflicting work (wb-${ref("conflict")})`);
	git("checkout", "-q", "master");
	commit("a.txt", "one\nTWO on master\nthree\n", "master moves on");
});
afterAll(() => {
	forgetLanding();
	forgetGit();
});

describe("the pass on the computer", () => {
	test("merged, landed by its ref, lost, clean and conflicting; nothing written to the repo", async () => {
		const before = looseObjects();
		const want = ["merged", "renamed", "lost", "clean", "conflict"].map((k) => ({ ref: ref(k), branch: getItem(db, ids[k])!.branch }));
		const f = await landingFacts({ slug: "repo", path: repo }, want);
		expect(f.ok).toBe(true);
		expect(f.base).toBe("master");
		const by = Object.fromEntries(f.items.map((x) => [x.ref, x]));
		expect(by[ref("merged")]).toMatchObject({ where: "local", landed: { by: "branch", into: "master" } });
		expect(by[ref("merged")].landed?.subject).toBe(`merged work (wb-${ref("merged")})`);
		expect(by[ref("renamed")]).toMatchObject({ where: "gone", landed: { by: "ref", into: "master", subject: `Merge: renamed work (wb-${ref("renamed")})` } });
		expect(by[ref("lost")]).toMatchObject({ where: "gone", landed: null });
		expect(by[ref("clean")]).toMatchObject({ where: "local", landed: null, ahead: 1, files: 1, added: 2, removed: 0, last: `clean work (wb-${ref("clean")})`, clean: true });
		expect(by[ref("conflict")]).toMatchObject({ where: "local", landed: null, ahead: 1, files: 1, added: 1, removed: 1, clean: false });
		// merge-tree's trial merges went to a folder of their own.
		expect(looseObjects()).toEqual(before);
	});

	test("a branch name that would be an option is never handed to git", async () => {
		const f = await landingFacts({ slug: "repo", path: repo }, [{ ref: "zzzz", branch: "--output=/tmp/x" }]);
		expect(f.items[0]).toMatchObject({ where: "gone", landed: null });
		expect(diffstat({ slug: "repo", path: repo }, "--output=/tmp/x")).rejects.toThrow("isn't on this computer");
	});

	test("what a branch changes: its commits and every file", async () => {
		const d = await diffstat({ slug: "repo", path: repo }, "feat-clean");
		expect(d).toMatchObject({ branch: "feat-clean", base: "master", added: 2, removed: 0 });
		expect(d.files).toEqual([{ path: "c.txt", added: 2, removed: 0 }]);
		expect(d.commits.map((c) => c.subject)).toEqual([`clean work (wb-${ref("clean")})`]);
		const viaItem = await itemDiff(db, ids.clean);
		expect(viaItem.files).toHaveLength(1);
		expect(itemDiff(db, ids.lost)).rejects.toThrow("isn't on this computer");
	});
});

describe("on the board", () => {
	test("the Agents place: landed leaves (with its note once), lost apart, ready with what it changes", async () => {
		forgetLanding();
		forgetGit();
		const v = await agentsView(db, { project: "repo" }, here);
		const at = (list: { item: { id: number } }[]) => list.map((x) => x.item.id).sort();
		expect(at(v.ready)).toEqual([ids.clean, ids.conflict, ids.shared].sort());
		expect(at(v.lost)).toEqual([ids.lost]);
		expect(v.lost[0].unknown).toContain("branch gone");
		expect(v.counts).toMatchObject({ ready: 3, lost: 1 });
		const clean = v.ready.find((x) => x.item.id === ids.clean)!;
		expect(clean.diff).toMatchObject({ ahead: 1, files: 1, added: 2, removed: 0, clean: true });
		expect(v.ready.find((x) => x.item.id === ids.conflict)!.diff?.clean).toBe(false);
		// The one found by its ref gets its note; the merged one needs none (git says so while the branch is there).
		const notes = (k: string) => getItem(db, ids[k])!.notes.filter((n) => n.text.startsWith("Landed: "));
		expect(notes("renamed").map((n) => n.text)).toEqual([`Landed: found in master as ${git("log", "-1", "--format=%h", `--grep=Merge: renamed`)} Merge: renamed work (wb-${ref("renamed")})`]);
		expect(notes("renamed")[0].author).toBe("workbench");
		expect(notes("merged")).toEqual([]);
		// Finished says merged for both.
		const fin = Object.fromEntries(v.finished.map((f) => [f.item.id, f.merged]));
		expect(fin[ids.renamed]).toBe(true);
		expect(fin[ids.merged]).toBe(true);
		// Once: a second look (and a fresh pass) writes nothing more.
		forgetLanding();
		await agentsView(db, { project: "repo" }, here);
		expect(notes("renamed")).toHaveLength(1);
	});

	test("an item with its Landed note stays landed when git can't say any more", async () => {
		const real = landingGit.facts;
		landingGit.facts = async () => ({ facts: [], limits: ["the computer is away"] });
		try {
			const v = await agentsView(db, { project: "repo" }, here);
			expect(v.ready.map((x) => x.item.id)).not.toContain(ids.renamed);
			expect(v.limits).toContain("the computer is away");
		} finally {
			landingGit.facts = real;
		}
	});

	test("asked about once per item and project in one pass; kept for a while", async () => {
		forgetLanding();
		const real = landingGit.facts;
		const asked: { slug: string; refs: string[]; own: string[] }[] = [];
		landingGit.facts = async (asks, maxAge, fresh) => {
			for (const a of asks) asked.push({ slug: a.project.slug, refs: a.want.map((w) => w.ref), own: a.own });
			return real(asks, maxAge, fresh);
		};
		try {
			const items = [ids.clean, ids.lost, ids.renamed].map((id) => getItem(db, id)!);
			const p = { slug: "repo", name: "Repo", path: repo, icon: "", sort: 0, archived_at: null, report_order: "[]" };
			const out = await settleLanding(db, [p], items);
			// The one with its note isn't asked about again.
			expect(asked).toHaveLength(1);
			expect(asked[0].refs.sort()).toEqual([ref("clean"), ref("lost")].sort());
			expect(asked[0].own).toContain("feat-clean");
			expect(out.by.get(ids.lost)?.where).toBe("gone");
		} finally {
			landingGit.facts = real;
		}
	});

	test("the daily pass: once a day, over every project's finished work with a branch", async () => {
		const id = addItem(db, { title: "Later", project: "repo", owner: "agent", branch: "feat-later" });
		updateItem(db, id, { status: "done" }, "agent", "done");
		git("checkout", "-q", "-b", "feat-later-renamed");
		commit("l.txt", "l\n", `later (wb-${getItem(db, id)!.ref})`);
		git("checkout", "-q", "master");
		git("merge", "-q", "--no-ff", "-m", `Merge: later (wb-${getItem(db, id)!.ref})`, "feat-later-renamed");
		let last = 0;
		const keep = { get: () => last, set: (ms: number) => (last = ms) };
		const now = Date.now();
		expect(await landingNightly(db, keep, now)).toBe(1);
		expect(last).toBe(now);
		expect(getItem(db, id)!.notes.at(-1)!.text).toStartWith("Landed: found in master as ");
		// Not again within the day.
		expect(await landingNightly(db, keep, now + NIGHT_MS - 1)).toBeNull();
		expect(await landingNightly(db, keep, now + NIGHT_MS)).toBe(0);
	});
});
