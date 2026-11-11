#!/usr/bin/env bun
// Cut a release: bump every version field to <version>, commit, and tag v<version>.
//
//   bun run release 0.2.0            # bump, commit "Release 0.2.0", tag v0.2.0 (nothing pushed)
//   bun run release 0.2.0 --push     # … and push the branch and the tag (starts the release build)
//   bun run release 0.2.0 --dry-run  # show what would change, touch nothing
//
// The fields: package.json "version" (the server's /api/ping and, through tauri.conf.json, the app),
// src-tauri/Cargo.toml [package] version, and the workbench-app entry in src-tauri/Cargo.lock.
import { $ } from "bun";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const args = process.argv.slice(2);
const push = args.includes("--push");
const dry = args.includes("--dry-run");
const allowBranch = args.includes("--any-branch");
const version = args.find((a) => !a.startsWith("--"))?.replace(/^v/, "");

function fail(msg: string): never {
	console.error(`release: ${msg}`);
	process.exit(1);
}

if (!version) fail("usage: bun run release <version> [--push] [--dry-run] [--any-branch]   e.g. bun run release 0.2.0");
// SemVer: X.Y.Z with an optional pre-release (0.2.0-rc.1). A pre-release is published as a GitHub pre-release,
// which /releases/latest (and so the app's update check) skips.
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) fail(`"${version}" isn't a version like 0.2.0 or 0.2.0-rc.1`);
const tag = `v${version}`;

$.cwd(root);
const status = (await $`git status --porcelain`.text()).trim();
if (status && !dry) fail(`the working tree has changes; commit or stash them first:\n${status}`);
const branch = (await $`git rev-parse --abbrev-ref HEAD`.text()).trim();
if (branch !== "master" && !allowBranch && !dry) fail(`on branch ${branch}, not master (pass --any-branch to tag here anyway)`);
if ((await $`git tag --list ${tag}`.text()).trim()) fail(`tag ${tag} already exists`);

type Edit = { file: string; from: RegExp; to: string };
const edits: Edit[] = [
	{ file: "package.json", from: /^(\t"version": ")[^"]+(")/m, to: `$1${version}$2` },
	{ file: "src-tauri/Cargo.toml", from: /^(\[package\][^[]*?\nversion = ")[^"]+(")/m, to: `$1${version}$2` },
	{ file: "src-tauri/Cargo.lock", from: /^(name = "workbench-app"\nversion = ")[^"]+(")/m, to: `$1${version}$2` },
];

for (const e of edits) {
	const path = join(root, e.file);
	const before = await Bun.file(path).text();
	const m = before.match(e.from);
	if (!m) fail(`couldn't find the version in ${e.file}`);
	const old = m[0].match(/"([^"]+)"$/)?.[1];
	const after = before.replace(e.from, e.to);
	console.log(`${e.file}: ${old} → ${version}`);
	if (!dry) await Bun.write(path, after);
}

if (dry) {
	console.log(`would commit "Release ${version}" on ${branch} and tag ${tag}${push ? ", then push both" : ""}`);
	process.exit(0);
}

await $`git add package.json src-tauri/Cargo.toml src-tauri/Cargo.lock`;
await $`git commit -q -m ${`Release ${version}`}`;
await $`git tag -a ${tag} -m ${`Workbench ${version}`}`;
console.log(`committed "Release ${version}" on ${branch} and tagged ${tag}`);

if (push) {
	await $`git push --atomic origin ${branch} ${tag}`;
	console.log(`pushed ${branch} and ${tag}: the release build runs at https://github.com/Kostas-Xafis/workbench/actions`);
} else {
	console.log(`nothing pushed. To publish: git push --atomic origin ${branch} ${tag}`);
}
