/**
 * Helping an agent wire a project into the workbench, in one place: the rules block that goes into a project's
 * AGENTS.md or CLAUDE.md, the guide `wb integrate` (and the MCP tool integration_guide) prints, the short prompt
 * the board offers to copy, and the check behind Settings → Projects saying which projects are set up.
 *
 * The block sits between markers that carry its version, so running the guide again replaces it rather than
 * adding a second one, and bumping RULES_VERSION shows every project as out of date until it's run there.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { projectForPath, projects, type Db } from "./db";
import { yourName } from "./settings";

/** Bump when RULES changes in a way projects should pick up. */
export const RULES_VERSION = 2;
const START = (v: number) => `<!-- workbench rules v${v}: kept by \`wb integrate\`; run it again to update. Project notes go outside these markers. -->`;
const END = "<!-- /workbench rules -->";
const MARKER = /<!-- workbench rules v(\d+)\b[^>]*-->/;
/** Files an agent reads at the start of a session, in the order the block prefers them. */
export const AGENT_FILES = ["AGENTS.md", "CLAUDE.md"];

/** The rules, as they go into a project's agent file. {{name}} and {{slug}} are filled in. */
const RULES = `## Open work lives on the workbench

{{name}} tracks every project on one local board, the workbench (\`wb open\` → http://localhost:4321). This project is \`{{slug}}\` there. Open work goes on the board, never in a markdown list: tasks, bugs, ideas, and everything that waits on {{name}}. Use the \`wb\` command, or the workbench MCP server's tools when you have them (named in brackets).

- **A prompt that names an item** (\`wb-\` and four letters or digits) means reading it first: \`wb show <ref>\` (get_item). Its body, notes and pictures are the brief. When {{name}} answers a decision or reports a result, record it on the item word for word (\`wb note\`, add_note) before acting on it.
- **Your work, while you do it:** \`wb start <ref> --branch <branch>\` when you begin (start_item), or \`wb add "…"\` first when there's no item yet (add_item). \`wb done <ref> "<branch or commit>: what changed"\` when it lands (finish_item), \`wb wait <ref> "why"\` when you're blocked (wait_item).
- **Everything you leave for {{name}} is its own item** with the right kind: \`decision\` (the options, what each changes, your recommendation), \`check\` (where to go, numbered steps, what right and wrong look like), \`review\` (the exact words or a picture), \`setup\` (each click, what to copy back). {{name}} reads the board on a phone without opening the repo, so an item makes sense by itself: the content in the body, plain words, no pointers like "see docs/x.md" and no internal codes. Read \`wb guide\` before filing your first one.
- **Anything on screen gets a screenshot** on its item: \`wb image add <ref> shot.png "what to look at"\` (attach_image). Keep the file out of the repo.
- **Item refs** go in commit messages and PR titles (the ref in brackets at the end of the title), which links them to the item on the board. They never go into code or committed docs (this block names none), and an item is never \`#12\` (that's a pull request).
- **No \`wb\` and no MCP server** (a cloud session, CI)? End your report with a "For the workbench" list of what to add, start, finish or ask, and {{name}} files it.`;

export function rulesBlock(db: Db, slug: string) {
	return `${START(RULES_VERSION)}\n${RULES.replaceAll("{{name}}", yourName(db)).replaceAll("{{slug}}", slug)}\n${END}`;
}

export type AgentFiles = {
	/** current: the block at today's version · outdated: an older one · manual: rules written by hand, no block · none */
	state: "current" | "outdated" | "manual" | "none";
	/** The file holding the block (or the hand-written rules); else where the block should go. */
	file: string;
	version: number | null;
	files: string[];
};

const read = (path: string) => {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return null;
	}
};

/** Where a project's agent rules stand: the block and its version, hand-written workbench rules, or nothing. */
export function agentFiles(folder: string): AgentFiles {
	const found = AGENT_FILES.map((f) => ({ f, text: folder ? read(join(folder, f)) : null })).filter((x) => x.text !== null) as { f: string; text: string }[];
	const files = found.map((x) => x.f);
	// Both files can hold a block (one copied into the other); the oldest decides.
	const blocks = found.filter((x) => MARKER.test(x.text)).map((x) => ({ f: x.f, v: Number(MARKER.exec(x.text)![1]) })).sort((a, b) => a.v - b.v);
	if (blocks.length) return { state: blocks[0].v >= RULES_VERSION ? "current" : "outdated", file: blocks[0].f, version: blocks[0].v, files };
	const manual = found.find((x) => /\bwb (show|start|done|add|ls)\b|\bworkbench\b/i.test(x.text));
	if (manual) return { state: "manual", file: manual.f, version: null, files };
	return { state: "none", file: preferredFile(found), version: null, files };
}

/** AGENTS.md when there is one (CLAUDE.md often just points at it), else CLAUDE.md, which Claude Code reads. */
const preferredFile = (found: { f: string }[]) => (found.some((x) => x.f === "AGENTS.md") ? "AGENTS.md" : "CLAUDE.md");

/** What Claude Code on this computer knows of the workbench: its MCP server, and whether wb runs without asking. */
export function harness(folder: string) {
	const home = homedir();
	let mcp = "";
	try {
		const cfg = JSON.parse(readFileSync(join(home, ".claude.json"), "utf8"));
		const s = cfg?.mcpServers?.wb ?? cfg?.projects?.[folder]?.mcpServers?.wb;
		if (s) mcp = s.type === "http" || s.url ? `HTTP · ${s.url}` : `stdio · ${[s.command, ...(s.args ?? [])].join(" ")}`;
	} catch {}
	if (!mcp) {
		try {
			if (JSON.parse(readFileSync(join(folder, ".mcp.json"), "utf8"))?.mcpServers?.wb) mcp = "in this project's .mcp.json";
		} catch {}
	}
	const allow: string[] = [];
	for (const f of [join(home, ".claude/settings.json"), join(folder, ".claude/settings.json"), join(folder, ".claude/settings.local.json")]) {
		try {
			allow.push(...(JSON.parse(readFileSync(f, "utf8"))?.permissions?.allow ?? []));
		} catch {}
	}
	return {
		mcp,
		wbAllowed: allow.some((r) => /^Bash\(wb[ :]/.test(r)),
		mcpAllowed: allow.some((r) => r === "mcp__wb" || r.startsWith("mcp__wb__")),
	};
}

/** The repository a folder is in (the folder itself when it's in none). */
export function repoRoot(dir: string) {
	for (let d = dir; d !== dirname(d); d = dirname(d)) if (existsSync(join(d, ".git"))) return d;
	return dir;
}

const slugOf = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "project";

/** The short prompt the board offers to copy. With a folder, it names it, for a session started elsewhere. */
export function integratePrompt(folder?: string) {
	return `${folder ? `Set up ${folder}` : "Set this project up"} to work with my Workbench: run \`wb integrate${folder ? ` ${folder}` : ""}\` and follow what it says. Ask me before you add the project to the board, change my Claude Code settings or move any to-do lists.`;
}

/** The guide `wb integrate` prints for a folder: what's there now, the steps that are left, and the block. */
export function integrationGuide(db: Db, dir: string) {
	const name = yourName(db);
	const project = projectForPath(db, dir);
	const root = project?.path || repoRoot(dir);
	const files = agentFiles(root);
	const h = harness(root);
	const slug = project?.slug ?? suggestSlug(db, root);
	const out: string[] = [];
	const step = (title: string, body: string) => out.push(`## ${out.length}. ${title}\n\n${body}`);

	out.push(`# Wiring ${project?.name ?? basename(root)} into the workbench

The workbench is ${name}'s local board of open work across projects (http://localhost:4321). This guide sets one project up so every agent session in it uses the board: the project on the board, the board's rules in the project's agent file, and Claude Code able to reach it. Run it again any time: it says what's already done.

Where things stand now:
- Folder: ${root}
- On the board: ${project ? `yes, as \`${project.slug}\` ("${project.name}")` : "no"}
- Agent rules: ${{
		current: `${files.file} has the workbench rules (v${files.version}, the latest)`,
		outdated: `${files.file} has the workbench rules v${files.version}; the latest is v${RULES_VERSION}`,
		manual: `${files.file} has workbench rules written by hand, without the standard block`,
		none: files.files.length ? `${files.files.join(" and ")} without any workbench rules` : "no AGENTS.md or CLAUDE.md yet",
	}[files.state]}
- Claude Code: ${h.mcp ? `has the workbench MCP server (${h.mcp})` : "doesn't have the workbench MCP server"}; ${h.wbAllowed ? "runs `wb` without asking" : "asks before each `wb` command"}

Do the steps below that aren't done yet, in order. Ask ${name} where a step says so, and don't commit anything unless ${name} asks.`);

	if (!project)
		step(
			"Put the project on the board (ask first)",
			`Ask ${name} whether to add this folder to the board, and under which name. Suggested:

\`\`\`bash
wb project ${slug} ${root} "${basename(root)}"
\`\`\`

The slug can't change later (items, reports and links point at it), so settle it before you run this. Items added from inside this folder then belong to the project.`,
		);
	else step("The project is on the board", `Nothing to do: it's \`${project.slug}\`. \`wb ls\` lists its open items.`);

	const block = rulesBlock(db, slug);
	if (files.state === "current") step("Agent rules", `Nothing to do: ${files.file} has the latest block.`);
	else
		step(
			files.state === "outdated" ? "Update the agent rules" : "Add the agent rules",
			{
				outdated: `Replace everything from \`<!-- workbench rules v${files.version}\` to \`<!-- /workbench rules -->\` in ${files.file} with the block at the end of this guide, markers included. Leave the rest of the file alone.`,
				manual: `${files.file} already has workbench rules written by hand. Put the block at the end of this guide in their place, markers included. Keep only what is specific to this project (its own docs, roles or workflow) and put it just after the block, outside the markers, so a later update can't overwrite it. Drop the lines the block already covers.`,
				none: `${files.files.includes(files.file) ? `Add the block at the end of this guide to ${files.file}` : `Create ${files.file} with the block at the end of this guide`}, markers included. Put it near the top, after any short description of the project, so agents read it early.${files.file === "AGENTS.md" && !files.files.includes("CLAUDE.md") ? " Claude Code reads CLAUDE.md, so also make a CLAUDE.md that says `@AGENTS.md`." : ""}${files.file === "AGENTS.md" && files.files.includes("CLAUDE.md") ? " Check that CLAUDE.md pulls AGENTS.md in (a line `@AGENTS.md`); if it doesn't, add that line." : ""}`,
			}[files.state as "outdated" | "manual" | "none"] +
				`\n\nThe file is committed with the project, so every session and every agent sees it. Mention the change in your report; ${name} decides when to commit it.`,
		);

	const setup: string[] = [];
	if (!h.mcp)
		setup.push(`- The workbench MCP server, so agents have the board as tools (it works without the board running):\n\n  \`\`\`bash\n  claude mcp add -s user wb -- wb mcp\n  \`\`\``);
	if (!h.wbAllowed || !h.mcpAllowed)
		setup.push(`- Let \`wb\`${h.mcp || !h.mcpAllowed ? " and the MCP tools" : ""} run without a permission prompt each time: add ${[!h.wbAllowed && '`"Bash(wb:*)"`', !h.mcpAllowed && '`"mcp__wb"`'].filter(Boolean).join(" and ")} to \`permissions.allow\` in \`~/.claude/settings.json\` (create the list if it isn't there; keep everything else).`);
	if (setup.length)
		step("Claude Code on this computer (ask first)", `These are once per computer, not per project. Ask ${name} before changing either:\n\n${setup.join("\n")}\n\nA new session picks them up.`);
	else step("Claude Code on this computer", "Nothing to do: it has the MCP server and runs `wb` without asking.");

	step(
		"Move open work onto the board (ask first)",
		`Look for open work kept in files: TODO.md or similar, unchecked \`- [ ]\` lists in docs, "next steps" or "open questions" sections, a PLAN with a queue. Don't count the history of done work, or specs. If you find any, show ${name} the list (file and what's in it) and ask whether to move it. For each piece moved, \`wb add\` one item that makes sense by itself (\`wb guide\`), then remove it from the file, or leave a line saying the open work is on the board; keep the old text in the project's history or archive folder if it has one. Then change any rule in the project's docs that tells agents to write such work into a file, so new work goes on the board too. Nothing found: say so in one line.`,
	);
	step(
		"Check",
		`Run the project's own checks (tests, lint, any check on its docs) once you've changed files. If one rejects something in the block, tell ${name} rather than changing the block or the check.`,
	);
	step(
		"Report",
		`Tell ${name} in a few lines what you changed (files, settings, items added) and what you left for them. Settings → Projects on the board now shows this project's agent rules as up to date.`,
	);
	out.push(`## The block\n\nCopy it exactly, markers included:\n\n${block}`);
	return out.join("\n\n");
}

function suggestSlug(db: Db, root: string) {
	const taken = new Set(projects(db).map((p) => p.slug));
	let s = slugOf(basename(root));
	for (let n = 2; taken.has(s); n++) s = `${slugOf(basename(root))}-${n}`;
	return s;
}

/** For Settings → Health: the prompt to copy, and how many projects on the board have the rules at each state. */
export function integrateSummary(db: Db) {
	const counts = { current: 0, outdated: 0, manual: 0, none: 0 };
	const behind: string[] = [];
	for (const p of projects(db)) {
		if (p.archived_at || !p.path) continue;
		const s = agentFiles(p.path).state;
		counts[s]++;
		if (s !== "current") behind.push(p.name);
	}
	return { prompt: integratePrompt(), version: RULES_VERSION, counts, behind };
}
