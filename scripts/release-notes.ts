#!/usr/bin/env bun
// Release notes for a tag, from the commits since the tag before it (all commits for the first release).
//
//   bun scripts/release-notes.ts v0.2.0 > notes.md
//
// Merge commits are left out, and so are the board's item references at the end of a subject ("(wb-xxxx)"):
// they mean nothing outside the board.
import { $ } from "bun";
import { join } from "node:path";

const tag = process.argv[2];
if (!tag) {
	console.error("usage: bun scripts/release-notes.ts <tag>");
	process.exit(1);
}
$.cwd(join(import.meta.dir, ".."));

const repo = process.env.GITHUB_REPOSITORY || "Kostas-Xafis/workbench";
const prev = (await $`git describe --tags --abbrev=0 --match ${"v*"} ${`${tag}^`}`.nothrow().quiet().text()).trim();
const range = prev ? `${prev}..${tag}` : tag;
const subjects = (await $`git log --no-merges --format=%s ${range}`.text())
	.split("\n")
	.map((s) => s.replace(/\s*\((wb-[a-z0-9]{4}(,\s*)?)+\)\s*$/i, "").trim())
	.filter(Boolean);

const version = tag.replace(/^v/, "");
const lines = [
	prev ? `## Changes since ${prev}` : "## Changes (first release)",
	"",
	...subjects.map((s) => `- ${s}`),
	"",
	"## Downloads",
	"",
	`- \`Workbench_${version}_amd64.deb\`: the desktop app for Debian and Ubuntu (\`sudo apt install ./Workbench_${version}_amd64.deb\`).`,
	`- \`Workbench_${version}_amd64.AppImage\`: the desktop app for any Linux; make it executable and run it.`,
	`- \`workbench-server_${version}_linux_x86_64\`: the board's server alone, one file, for running it without the app (e.g. as a systemd service).`,
	"- `SHA256SUMS`: checksums of every file (`sha256sum -c SHA256SUMS --ignore-missing`).",
	"- `*.sig` and `latest.json`: for the app's own update check.",
];
if (prev) lines.push("", `Full diff: https://github.com/${repo}/compare/${prev}...${tag}`);
console.log(lines.join("\n"));
