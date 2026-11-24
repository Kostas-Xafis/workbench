/**
 * The `wb` commands that read and change the board's data, as functions of their inputs: the parsed command line,
 * the database, the folder `wb` runs in and where the output goes. `wb` on a computer (wb.ts) and the cloud board
 * (worker/src/board.ts, for `wb` while a computer syncs, cloudcli.ts) both run them, so a command prints the same
 * wherever the board is. Nothing here exits the process or prints on its own, and no file is read or written
 * except through `ctx`.
 */
import {
	addItem,
	addLink,
	addNote,
	answerItem,
	itemOptions,
	listLinks,
	listReports,
	publishReport,
	removeLink,
	removeReport,
	setReportIcon,
	reportLeftWithoutIcon,
	resetVault,
	listSecrets,
	setProjectIcon,
	vaultInfo,
	updateLink,
	getItem,
	listItems,
	resolveItem,
	projectForPath,
	projects,
	updateProject,
	updateItem,
	upsertProject,
	type Item,
	type ItemPatch,
	type Status,
} from "./db";
import { exportAll, type Db } from "./db";
import {
	addGoal,
	goalLine,
	goalsWithStats,
	goalTitle,
	needGoal,
	updateGoal,
	type GoalInfo,
	type GoalStatus,
} from "./goals";
import { addSource, currentKeyring, listSources, removeSource } from "./sources";
import { PRESETS } from "./presets";
import { checkBrief, WRITING_GUIDE } from "./brief";
import { runText } from "./checkruns";
import {
	addRuling,
	getRuling,
	itemRulings,
	listRulings,
	repeatWarning,
	retireRuling,
	rulingSource,
	updateRuling,
	type Ruling,
} from "./rulings";
import { latestRun, runLine } from "./dispatch";
import { deadlineText, defaultText, itemRecommended, resolveAsk } from "./asks";
import { staleLabel } from "./stale";
import { removeLinks, waitOn } from "./links";
import { addImage, imageData, imageInfo, imageSummary, prepareImage, removeImage } from "./images";
import { askCap, askDays, dayStartHour, ownerDefaultsText, yourName } from "./settings";
import {
	addTracker,
	cleanReading,
	describeSource,
	listTrackers,
	meterText,
	parseEvery,
	parseReading,
	recordReading,
	refreshTracker,
	removeTracker,
	resolveTracker,
	trackerHistory,
	trackerText,
	updateTracker,
	type Tracker,
	type TrackerPatch,
} from "./trackers";
import type { Opts } from "./cliargs";
import { changeText, checkChange, fileItem, Refusal, type Filed } from "./filing";

const ATTACH_CLI = 'wb image add <ref> <file> "what to look at"';

/** How long a new default waits, as Settings → You and your day says now. */
const askDaysText = (db: Db) =>
	askDays(db) ? `${askDays(db)} day${askDays(db) > 1 ? "s" : ""} for one with a default` : "none";

/** Says the board's name for the owner "kostas", day start and owner defaults as they are set now. */
export const help = (
	db: Db,
	port: number,
	name = yourName(db),
	start = `${String(dayStartHour(db)).padStart(2, "0")}:00`,
) => `wb — the workbench. Tasks for agents, checks and decisions for ${name}, across projects.
Items are named wb-xxxx (e.g. wb-k3f9); commands take that, the bare k3f9, or an old number.

  wb ls [--mine | --agents] [--all] [--project P] [--kind K] [-q text]
                                   open items (--all includes done); --mine = what waits on ${name}
                                   (notices, which don't wait, are counted after it: --kind notice lists them)
                                   ⚠ marks stale agent work (doing 2+ days quiet, waiting 7+)
  wb show <ref>                     an item with its history
  wb goals [--project P] [--all]    a project's goals: target date, progress, what waits on ${name}, what blocks them
  wb goal add "Title" [--due YYYY-MM-DD] [--body "markdown"] [--active]   a goal items can serve
  wb goal <id> [--done | --drop | --reopen] [--title T] [--due YYYY-MM-DD | --due none] [--body "…"]
               [--active] [--position N]   change one: close it, retitle it, mark it the active goal, move it
  wb add "title" [options]         new item, prints its id
  wb start <ref> [--session S] [--branch B]   an agent picks it up (session defaults to the
                                   desktop app session it runs in, so the board links to it)
  wb wait <ref> "why" [--on wb-xxxx ...]   blocked on something; --on names the item it waits on (repeat for
                                   more): the board puts this one back to todo when that one is answered,
                                   finished or dropped. When it's ${name}'s to answer, file it first:
                                   wb add "..." --kind decision --blocks <this item> does both in one go
  wb done <ref> ["note"]            finished (the note says what changed / where)
  wb drop <ref> ["why"]             won't do
  wb note <ref> "text"              add to the history
  wb answer <ref> "choice"          answer a decision (or the option's number); it goes back to the agent.
                                   A pick-many decision takes several: wb answer <ref> 1 3, or "A" "B", or none
  wb seen <ref>                     a notice: got it (a review: no objections); closes it
  wb object <ref> "why"             object to a notice or review: it goes back to the agent with your words
  wb edit <ref> [options]           change fields
  wb guide                          how to write an item ${name} can follow: read it before filing one
  wb integrate [folder] [--project P]   for an agent: wire this project into the workbench (the board, the rules
                                   in AGENTS.md or CLAUDE.md, Claude Code's MCP server); says what's done and what's left
  wb image add <ref> <file> "caption"   put a screenshot on an item, or --image <file> --caption "…" on wb add
  wb image save <id> <file>         write one to a file, to look at it (wb show lists them)
  wb image rm <id>                  take one off
  wb import <file.json> [--project P]   bulk add (array of items)
  wb rulings [--project P | --all] [-q text] [--retired]
                                   ${name}'s standing answers in this project: read them before asking anything
  wb rule "text" [--item <ref>] [--project P]   write one down, one line (--item: where it was decided);
                                   wb rule <id> "text" rewrites one (a drafted one stops being a draft)
  wb unrule <id>                   retire one: it no longer holds
  wb links                        bookmarks shown on the board
  wb link "Label" <url> [--project P | --all] [--group G] [--icon <icon url>]
                                   add one (--all: shown with every project)
  wb relink <id> [--group G] [--icon <url>] [--title "Label"]   change one
  wb unlink <id>                   remove one
  wb report <page.html> [--title T] [--group G] [--icon <emoji | file.svg>] [--name N] [--project P]
                                   publish a report page (again under the same name = new version);
                                   every report has its own icon: agents give --icon the first time
  wb reports [--project P]         reports and their versions
  wb report-icon <id> <emoji | file.svg | none>
                                   change a report's icon in the sidebar
  wb day [YYYY-MM-DD] [--project P] [--out file.html]
                                   publish each project's page of everything that moved that work day
                                   (${start} to ${start} next morning; default: the current one), in its
                                   group Days. The board does this by itself; --out writes one page of every project
  wb unreport <id>                 delete a report with all its versions
  wb source add <name> <baseUrl> [--project P] [--write] --header "Name: value" ...
                                   a data source report pages call with wb.fetch(name, path); the board adds
                                   the headers. Values: {env:VAR} or {stdin} (asked hidden, or read from a pipe,
                                   one line each), e.g. --header "Authorization: Bearer {env:TOKEN}". Never printed.
                                   --write allows POST/PUT/PATCH/DELETE (GET only otherwise). Again = replace
  wb sources [--project P]         data sources (names, base URLs, header names)
  wb unsource <name> [--project P] remove one
  wb trackers [--project P] [--json]   status trackers of this project and the global ones, with readings
  wb tracker <ref> [--json]        one tracker, how it reads, and its recent history (ref: name or project/name)
  wb tracker add <name> ["Title"] [--project P | --global] [how] [display]
                                   how: --command "shell command" (its output is the reading; runs in the project
                                   folder) or --preset ${Object.keys(PRESETS).join("|")} [--param key=value ...];
                                   neither = manual. --every 15m|1h|1d|off how often the board reads it (default 1h)
                                   display: --max N --unit U --warn 75% --bad 90% (or <20% when low is bad) --url U
  wb tracker edit <ref> [same options] [--title T] [--name N]
  wb tracker refresh [<ref>]       read it (or every self-reading one here) now
  wb track <ref> <reading> ...     record a manual tracker's reading: 12/15 · "Android 12/15" "iOS 3/15" (a meter
                                   each) · "In review" · JSON. [--note "…"] [--resets YYYY-MM-DD]
  wb untrack <ref>                 delete a tracker and its history
  wb mcp                           MCP server on stdio, for agents (Claude Code: claude mcp add -s user wb -- wb mcp)
  wb backup                        copy the database now (also done nightly by the board); keeps the newest 14,
                                   or as many as Settings → Data says
  wb backups                       list them
  wb export > file.json            everything on the board as JSON (not the vault, nor data sources' header values)
  wb vault                         whether the vault is set up, and how many secrets it holds
  wb vault reset --yes             forgot the password: delete the vault and every secret in it
  wb projects                      list projects
  wb project <slug> <path> "Name"  add or update a project
  wb project <slug> --icon <file>  use this logo (path in the repo); --icon "" = find one again
  wb project <slug> --archive      take a finished project off the board (--unarchive brings it back)
  wb serve [--lan]                 run the board on http://localhost:${port}; --lan also on your network, for
                                   phones paired in Settings → Privacy and security (plain http: a trusted network only)
  wb run <ref>                     start a Claude Code agent on an agent's to-do, in its project's folder, as the
                                   board's Run does (Settings → Agents: off until turned on there, with its limits)
  wb runs [--all]                  agents the board started: running ones and the latest (--all: the last 100),
                                   with where each ran, how to carry on, and its Claude Desktop link
  wb continue <run> "message"      send that run's agent a message: a new run resumes its session (same folder,
                                   what it knows), as Continue on the board; a done item's too. Limits apply
  wb stop <run>                    stop one (its number from wb runs)
  wb devices                       phones paired with the board, and when each was last seen
  wb unpair <id|all>               remove a phone (or every one): it stops reaching the board at once
  wb open                          open the desktop app; without it, start the board and open the browser
  wb sync ...                      the board on Cloudflare instead of this computer (docs/cloud.md): wb sync help

Options for add/edit:
  --kind task|check|review|decision|setup|bug|idea|notice   (default task)
  --owner kostas|agent       who has to act (kostas = ${name}). Without it, by kind:
                             ${ownerDefaultsText(db)}
  --project P                default: the project whose path contains the current folder
  --area A  --p 1|2|3  --body "markdown"  --branch B  --session S  --source "file:line"
  --goal G                   the goal it serves: its number (wb goals) or exact title; --goal none takes it off
  --option "choice"          repeat for each choice of a decision; ${name} answers with one click
                             (--option alone makes the item a decision)
  --pick one|many            a decision: one option, or several ticked at once (bundle related choices)
  --recommend "choice"       your pick among the options (repeat for pick many); marked on the button
  --default "answer"         what happens if ${name} says nothing (decisions, reviews, notices): an option,
                             repeat for pick many (--default none: none of them). It goes ahead by itself
  --decide-by DATE           when: 2026-11-14, "in 3 days" or none (default: ${askDaysText(db)})
  --status todo|doing|waiting|done|dropped
  --on wb-xxxx               the item waits on this one (repeat for more; it becomes waiting). On edit too
  --blocks wb-xxxx           add only: that item waits on the new one (it becomes waiting)
  --not-on wb-xxxx           edit only: it no longer waits on this one

Kinds: task = code work · check = try it on a device · review = something only ${name} can judge ·
decision = a question only ${name} can answer · setup = accounts, consoles, stores · bug · idea = later/maybe ·
notice = what changed, for ${name} to see (doesn't wait on them; they say got it or object).
Agents: decide what you can and keep moving; ask only about money, accounts, stores, what can't be undone
or what the product should be. Related questions → one --pick many decision, with --recommend (it goes
ahead by itself). Changed something → a notice, not a review. At most ${askCap(db) || "any number of"} open asks from agents.`;

/** What a command runs on. */
export type CliCtx = {
	db: Db;
	args: string[];
	o: Opts;
	/** The folder `wb` runs in, to find the project it belongs to. */
	cwd: string;
	author: string;
	/** The session `wb start` links the item to when --session isn't given. */
	session?: string;
	/** Whether the output goes to a terminal. */
	tty: boolean;
	/** Where the board is served, for the links `wb report` prints. */
	base: string;
	port: number;
	out: (line: string) => void;
	err: (line: string) => void;
	/** A file named on the command line: its bytes and what to call it, or throws what's wrong with it. */
	read: (path: string, as: "file" | "image") => Promise<{ bytes: Uint8Array; label: string }>;
	/** A file the command writes (`wb image save`). */
	write: (path: string, bytes: Uint8Array) => Promise<void>;
};

/** The helpers every command shares (wb.ts uses them for the commands that stay on a computer). */
export function cliHelpers(ctx: CliCtx): {
	die: (msg: string) => never;
	currentProject: (required?: boolean) => string | undefined;
	refIds: (refs: string[] | undefined) => number[];
	idArg: () => number;
} {
	const { db, args, o } = ctx;
	/** A refusal: the command stops and prints "wb: <msg>", with exit code 1. */
	function die(msg: string): never {
		throw new Error(msg);
	}
	function currentProject(required = true) {
		if (o.project) {
			if (!projects(db).some((p) => p.slug === o.project)) die(`unknown project "${o.project}" (wb projects)`);
			return o.project;
		}
		const p = projectForPath(db, ctx.cwd);
		if (!p && required) die("not inside a known project; pass --project (wb projects)");
		return p?.slug;
	}

	/** The ids of items named on the command line (--on, --not-on, --blocks). */
	function refIds(refs: string[] | undefined) {
		return (refs ?? []).map((r) => resolveItem(db, r) ?? die(`no item "${r}"`));
	}

	function idArg() {
		const id = resolveItem(db, args[1]);
		if (id === undefined) die(`no item "${args[1] ?? ""}"`);
		return id;
	}
	return { die, currentProject, refIds, idArg };
}

/** Runs one board command and returns its exit code. Output goes through ctx; a refusal prints "wb: …" and returns 1. */
export async function runCli(ctx: CliCtx): Promise<number> {
	const { db, args, o, author, out, err } = ctx;
	const { currentProject, refIds, idArg } = cliHelpers(ctx);
	const die: (msg: string) => never = cliHelpers(ctx).die;
	const cmd = args[0];
	if (!cmd || o.help || cmd === "help") {
		out(help(db, ctx.port));
		return 0;
	}
	/** A report icon as given on the command line: an .svg file's contents, or the emoji itself. */
	const iconArg = async (icon: string) =>
		/\.svg$/i.test(icon) ? new TextDecoder().decode((await ctx.read(icon, "file")).bytes) : icon;

	/** Only agents get told how to write: an item {{name}} files for themselves can be as short as they like. */
	const briefOf = (d: Parameters<typeof checkBrief>[0], images: number): ReturnType<typeof checkBrief> =>
		author === "agent" ? checkBrief(d, { name: yourName(db), images, attach: ATTACH_CLI }) : { warnings: [] };

	function warnAbout(warnings: string[]) {
		if (warnings.length)
			err(
				`wb: saved, but ${yourName(db)} may not follow it yet. Fix with wb edit (wb guide has how):\n${warnings.map((w) => `  - ${w}`).join("\n")}`,
			);
	}

	function patchFromOptions(): ItemPatch {
		const patch: ItemPatch = {};
		if (o.title) patch.title = o.title;
		if (o.kind) patch.kind = o.kind as Item["kind"];
		if (o.owner) patch.owner = o.owner as Item["owner"];
		if (o.project) patch.project = o.project;
		if (o.area) patch.area = o.area;
		if (o.p) patch.priority = Number(o.p);
		if (o.body !== undefined) patch.body = o.body.replaceAll("\\n", "\n");
		if (o.branch !== undefined) patch.branch = o.branch;
		if (o.session !== undefined) patch.session = o.session;
		if (o.source !== undefined) patch.sources = o.source;
		if (o.status) patch.status = o.status as Status;
		if (o.option) patch.options = o.option;
		if (o.pick !== undefined) patch.pick = o.pick as Item["pick"];
		if (o.recommend) patch.recommended = o.recommend;
		// One --default is an answer as given ("1, 3" works for pick many); several are the picks.
		if (o.default) patch.default_answer = o.default.length > 1 ? o.default : o.default[0];
		if (o["decide-by"] !== undefined) patch.decide_by = o["decide-by"];
		return patch;
	}

	/** --goal as an item's goal_id: its number or exact title in `project`; none (or empty) = no goal. */
	function goalOption(project: string): number | null | undefined {
		if (o.goal === undefined) return undefined;
		if (["", "none", "no"].includes(o.goal.trim().toLowerCase())) return null;
		return needGoal(db, o.goal, project);
	}

	const KIND_MARK: Record<string, string> = {
		task: "task",
		check: "CHECK",
		review: "REVIEW",
		decision: "DECIDE",
		setup: "SETUP",
		bug: "BUG",
		idea: "idea",
		notice: "NOTICE",
	};

	function row(i: Item, showProject: boolean) {
		const status = i.status === "todo" ? "" : `[${i.status}] `;
		// The initial of the board's name, unless it reads as A (agent).
		const initial = yourName(db)[0].toUpperCase();
		const who = i.owner === "kostas" ? (initial === "A" ? "Y" : initial) : "A";
		const session = i.session.startsWith("local_") ? i.session.slice(0, 14) : i.session;
		const where = [i.branch && `⎇ ${i.branch}`, session && `@ ${session}`].filter(Boolean).join("  ");
		return [
			`wb-${i.ref}`,
			`P${i.priority}`,
			who,
			KIND_MARK[i.kind].padEnd(6),
			showProject ? i.project.padEnd(12) : "",
			`${status}${i.title}${i.answer ? `  → ${i.answer}` : ""}${i.owner === "kostas" && deadlineText(i) && ["todo", "doing", "waiting"].includes(i.status) ? `  (${deadlineText(i)})` : ""}${i.unblocks ? `  (unblocks ${i.unblocks})` : ""}`,
			where ? ` ${where}` : "",
			i.stale ? ` ⚠ ${staleLabel(i.stale)}` : "",
		]
			.filter(Boolean)
			.join(" ");
	}

	/** "#12  Traditional is the default melisma style  (wb-k3f9, 25 Oct · drafted)". */
	function rulingRow(r: Ruling, showProject: boolean) {
		const notes = [
			rulingSource(r),
			r.drafted ? "drafted" : "",
			r.retired_at ? `retired ${r.retired_at.slice(0, 10)}` : "",
		]
			.filter(Boolean)
			.join(" · ");
		return `#${String(r.id).padEnd(4)} ${showProject ? `${r.project.padEnd(12)} ` : ""}${r.text}  (${notes})`;
	}

	function show(id: number) {
		const i = getItem(db, id)!;
		out(`wb-${i.ref}  ${i.title}`);
		out(
			`${i.project} · ${i.kind} · for ${i.owner === "kostas" ? yourName(db) : "an agent"} · ${i.status} · P${i.priority}${i.area ? ` · ${i.area}` : ""}`,
		);
		if (i.stale) out(`stale: ${staleLabel(i.stale)} (since ${i.stale.since})`);
		if (i.branch || i.session)
			out([i.branch && `branch ${i.branch}`, i.session && `session ${i.session}`].filter(Boolean).join(" · "));
		if (i.goal_id != null) out(`goal: #${i.goal_id} ${goalTitle(db, i.goal_id)}`);
		if (i.sources) out(`sources: ${i.sources}`);
		if (i.body) out(`\n${i.body}`);
		if (i.images.length)
			out(
				`\nimages (wb image save <id> <file> to see one):\n${i.images.map((m) => `  ${imageSummary(m)}`).join("\n")}`,
			);
		const options = itemOptions(i);
		const rec = itemRecommended(i);
		if (options.length)
			out(
				`\n${i.pick === "many" ? "options (several can be picked: wb answer <ref> 1 3)" : "options"}:\n${options.map((x, n) => `  ${n + 1}. ${x}${rec.includes(x) ? "  (recommended)" : ""}`).join("\n")}`,
			);
		if (i.default_answer) out(`\nif ${yourName(db)} says nothing: ${defaultText(i)}`);
		if (deadlineText(i) && ["todo", "doing", "waiting"].includes(i.status)) out(`deadline: ${deadlineText(i)}`);
		if (i.answer) out(`\nanswer: ${i.answer}`);
		const checkRun = runText(db, i.id);
		if (checkRun) out(`\n${checkRun}`);
		const linkLine = (l: { ref: string; title: string; status: string; answer: string }) =>
			`  wb-${l.ref} ${l.answer ? "answered" : l.status}: ${l.title}`;
		if (i.waits_on.length) out(`\nwaits on:\n${i.waits_on.map(linkLine).join("\n")}`);
		if (i.blocks.length) out(`\nblocks (waiting on this):\n${i.blocks.map(linkLine).join("\n")}`);
		const rulings = itemRulings(db, i.id);
		if (rulings.length) out(`\nrulings from it:\n${rulings.map((r) => `  ${rulingRow(r, false)}`).join("\n")}`);
		const run = latestRun(db, i.id);
		if (run) out(`\nlatest agent run (wb runs): ${runLine(run)}`);
		out("\nhistory:");
		for (const n of i.notes) out(`  ${n.at}  ${n.author ? n.author + ": " : ""}${n.text}`);
	}

	/* ---------- Trackers ---------- */

	const sqlAge = (s: string | null) => {
		if (!s) return "never";
		const d = (Date.now() - new Date(s.replace(" ", "T") + "Z").getTime()) / 1000;
		if (d < 60) return "just now";
		if (d < 3600) return `${Math.floor(d / 60)} min ago`;
		if (d < 86400) return `${Math.floor(d / 3600)} h ago`;
		return `${Math.floor(d / 86400)} d ago`;
	};

	/** The tracker a command names: as given (project/name, name, id), the current project's first. */
	function trackerArg(ref = args[1]) {
		if (!ref) die("which tracker? (wb trackers)");
		return resolveTracker(db, ref, o.global ? undefined : (o.project ?? currentProject(false)));
	}

	/** --command/--preset/--param/--every/... as a tracker patch. */
	function trackerOptions(): TrackerPatch {
		const t: TrackerPatch = {};
		if (o.command !== undefined && o.preset !== undefined) die("give --command or --preset, not both");
		if (o.command !== undefined) {
			t.kind = "command";
			t.command = o.command;
		}
		if (o.preset !== undefined) {
			if (o.preset !== "manual" && !PRESETS[o.preset])
				die(`no preset "${o.preset}"; there are ${Object.keys(PRESETS).join(", ")} (or manual)`);
			t.kind = o.preset;
		}
		if (o.param) {
			t.options = {};
			for (const p of o.param) {
				const at = p.indexOf("=");
				if (at < 1) die(`--param key=value, got "${p}"`);
				t.options[p.slice(0, at).trim()] = p.slice(at + 1).trim();
			}
		}
		if (o.every !== undefined) t.every = parseEvery(o.every);
		if (o.max !== undefined) {
			const max = o.max.trim() === "" || o.max === "none" ? null : Number(o.max.replace(/,/g, ""));
			if (max !== null && !Number.isFinite(max)) die(`--max is a number, got "${o.max}"`);
			t.max = max;
		}
		for (const k of ["unit", "warn", "bad", "url"] as const) if (o[k] !== undefined) t[k] = o[k];
		if (o.global) t.project = "";
		else if (o.project !== undefined) t.project = o.project;
		return t;
	}

	function trackerRow(t: Tracker, refW = 26, titleW = 20) {
		const age =
			t.kind === "manual" ? sqlAge(t.read_at) : t.error ? `failed ${sqlAge(t.checked_at)}` : sqlAge(t.read_at);
		return `${t.ref.padEnd(refW)}  ${t.title.padEnd(titleW)}  ${trackerText(t)}  (${age})`;
	}

	function showTracker(t: Tracker) {
		out(`${t.ref} · ${t.title}${t.project ? "" : " (global: shown with every project)"}`);
		if (t.reading) {
			const w = Math.max(...t.reading.meters.map((m) => m.label.length));
			for (const m of t.reading.meters) out(`  ${w ? `${m.label.padEnd(w)}  ` : ""}${meterText({ ...m, label: "" })}`);
			const resets = t.reading.resets_at
				? `resets ${t.reading.resets_at.slice(0, 10)} (in ${Math.max(0, Math.ceil((Date.parse(t.reading.resets_at) - Date.now()) / 86400e3))} days)`
				: "";
			const extra = [t.reading.note, resets].filter(Boolean).join(" · ");
			if (extra) out(`  ${extra}`);
			if (t.reading.url) out(`  ${t.reading.url}`);
		} else out("  no reading yet");
		if (t.error) out(`  error (${sqlAge(t.checked_at)}): ${t.error}`);
		out(`source: ${describeSource(t)}`);
		out(
			`read ${sqlAge(t.read_at)}${t.stale ? " (stale)" : ""}${t.running ? " · reading now" : ""}` +
				(t.due_at ? ` · next ${new Date(t.due_at.replace(" ", "T") + "Z").toLocaleString()}` : "") +
				[
					t.max !== null ? ` · max ${t.max}` : "",
					t.unit ? ` · unit ${t.unit}` : "",
					t.warn ? ` · warn ${t.warn}` : "",
					t.bad ? ` · bad ${t.bad}` : "",
				].join(""),
		);
		const history = trackerHistory(db, t.id, 10);
		if (history.length > 1) {
			out("history:");
			for (const h of history)
				out(
					`  ${h.at.slice(0, 16)}  ${h.reading.meters.map((m) => meterText({ ...m, level: "" })).join(" · ")}${h.author ? `  (${h.author})` : ""}`,
				);
		}
	}

	try {
		switch (cmd) {
			case "ls": {
				const project = o.project ?? currentProject(false);
				const status: Status[] = o.all ? [] : ["doing", "todo", "waiting"];
				const goal =
					o.goal === undefined
						? undefined
						: ["none", "no"].includes(o.goal.trim().toLowerCase())
							? ("none" as const)
							: needGoal(db, o.goal, project);
				let items = listItems(db, {
					project,
					owner: o.mine ? "kostas" : o.agents ? "agent" : undefined,
					kind: o.kind as Item["kind"],
					status,
					q: o.q,
					goal,
				});
				// What waits on Kostas leaves out notices: they don't wait. They're counted after it.
				const notices = o.mine && !o.kind ? items.filter((i) => i.kind === "notice") : [];
				if (notices.length) items = items.filter((i) => i.kind !== "notice");
				if (!items.length) out("nothing open");
				for (const i of items) out(row(i, !project));
				if (notices.length)
					out(`and ${notices.length} notice${notices.length > 1 ? "s" : ""} to see (wb ls --mine --kind notice)`);
				break;
			}
			case "show":
				show(idArg());
				break;
			case "add": {
				const title = args.slice(1).join(" ") || o.title;
				if (!title) die('usage: wb add "title" [options]');
				const patch = patchFromOptions();
				if ((o.image?.length ?? 0) !== (o.caption?.length ?? 0))
					die("each --image needs its --caption: what it shows and what to look at");
				let filed: Filed;
				try {
					// The same rules as add_item (filing.ts): only agents are checked, capped and given a default.
					filed = await fileItem(db, {
						item: { ...patch, title, project: currentProject()!, goal_id: goalOption(currentProject()!) },
						author,
						byAgent: author === "agent",
						attach: ATTACH_CLI,
						images: {
							count: o.image?.length ?? 0,
							read: () =>
								Promise.all(
									(o.image ?? []).map(async (path, n) => {
										const { bytes, label } = await ctx.read(path, "image");
										return { image: await prepareImage(bytes, label), caption: o.caption![n] };
									}),
								),
						},
						waitsOn: refIds(o.on),
						blocks: o.blocks ? refIds([o.blocks])[0] : undefined,
					});
				} catch (e) {
					if (e instanceof Refusal) die(e.message);
					throw e;
				}
				const added = getItem(db, filed.id)!;
				out(`wb-${added.ref}`);
				warnAbout(filed.warnings);
				if (filed.goesAhead) err(`wb: ${filed.goesAhead}`);
				// An agent's ask that looks like one already answered (rulings.ts): saved, with the ruling it may repeat.
				const said = repeatWarning(filed.repeats, yourName(db), `wb drop wb-${added.ref}`);
				if (said) err(`wb: ${said}`);
				break;
			}
			case "goals": {
				const project = o.project ?? currentProject(false);
				const list = goalsWithStats(db, { project, status: o.all ? undefined : ["open"] });
				if (!list.length)
					out(project ? `no goals in ${project} (wb goal add "Title")` : 'no goals (wb goal add "Title")');
				for (const g of list) {
					out(`${project ? "" : `${g.project.padEnd(14)} `}${goalLine(g, yourName(db))}`);
					for (const b of g.stats.blockers.slice(0, 6))
						out(
							`    blocked by wb-${b.ref} ${b.kind} ${b.why === "kostas" ? `for ${yourName(db)}` : "(agent, waiting)"}: ${b.title}`,
						);
					if (g.stats.blockers.length > 6) out(`    …and ${g.stats.blockers.length - 6} more`);
				}
				break;
			}
			case "goal": {
				const status = [o.done && "done", o.drop && "dropped", o.reopen && "open"].filter(Boolean) as GoalStatus[];
				if (status.length > 1) die("give one of --done, --drop and --reopen");
				const showGoal = (id: number) => {
					const g = goalsWithStats(db).find((x) => x.id === id) as GoalInfo;
					out(goalLine(g, yourName(db)));
				};
				const body = o.body?.replaceAll("\\n", "\n");
				if (args[1] === "add") {
					const title = args.slice(2).join(" ") || o.title;
					if (!title) die('usage: wb goal add "Title" [--due YYYY-MM-DD] [--body "…"] [--active]');
					showGoal(
						addGoal(db, {
							project: currentProject()!,
							title,
							body,
							due: o.due === "none" ? "" : o.due,
							active: o.active,
						}).id,
					);
					break;
				}
				const id = needGoal(
					db,
					args[1] ??
						die(
							'usage: wb goal <id> [--done | --drop | --reopen] [--title T] [--due D] [--active] | wb goal add "Title"',
						),
					o.project ?? currentProject(false),
				);
				updateGoal(db, id, {
					title: o.title,
					body,
					due: o.due === undefined ? undefined : o.due === "none" ? "" : o.due,
					status: status[0],
					active: o.active ? true : undefined,
					position: o.position === undefined ? undefined : Number(o.position),
				});
				showGoal(id);
				break;
			}
			case "guide":
				out(WRITING_GUIDE.replaceAll("{{name}}", yourName(db)));
				break;
			case "image": {
				const sub = args[1];
				if (sub === "add") {
					const id = resolveItem(db, args[2]);
					if (id === undefined) die(`no item "${args[2] ?? ""}"`);
					const caption = args.slice(4).join(" ") || o.caption?.[0] || "";
					if (!args[3] || !caption.trim()) die('usage: wb image add <ref> <file> "what it shows and what to look at"');
					const { bytes, label } = await ctx.read(args[3], "image");
					const image = await prepareImage(bytes, label);
					const n = addImage(db, id, image, caption, author);
					out(`image ${n} on wb-${getItem(db, id)!.ref} (${Math.round(image.data.length / 1024)} KB)`);
				} else if (sub === "save") {
					const row = imageData(db, Number(args[2]));
					if (!row || !args[3]) die(row ? "usage: wb image save <id> <file>" : `no image ${args[2] ?? ""}`);
					await ctx.write(args[3], row.data);
					out(`${args[3]} (${row.type})`);
				} else if (sub === "rm") {
					if (!imageInfo(db, Number(args[2]))) die(`no image ${args[2] ?? ""}`);
					out(`removed from wb-${getItem(db, removeImage(db, Number(args[2]), author))!.ref}`);
				} else die('usage: wb image add <ref> <file> "caption" | wb image save <id> <file> | wb image rm <id>');
				break;
			}
			case "start": {
				const id = idArg();
				const session = o.session ?? ctx.session;
				updateItem(db, id, { ...patchFromOptions(), status: "doing", ...(session ? { session } : {}) }, author);
				out(row(getItem(db, id)!, true));
				break;
			}
			case "wait":
			case "done":
			case "drop": {
				const id = idArg();
				const status = ({ wait: "waiting", done: "done", drop: "dropped" } as const)[cmd];
				const note = args.slice(2).join(" ");
				if (cmd === "wait" && !note) die('usage: wb wait <ref> "what it waits on" [--on wb-xxxx]');
				const on = cmd === "wait" ? refIds(o.on) : [];
				if (on.length) {
					// Checked before anything changes, so a refused link leaves the item as it was.
					const { status: _, ...rest } = patchFromOptions();
					if (Object.keys(rest).length) updateItem(db, id, rest, author);
					waitOn(db, id, on, author);
					addNote(db, id, note, author);
				} else if (cmd === "wait") {
					updateItem(db, id, { ...patchFromOptions(), status }, author);
					addNote(db, id, note, author);
				} else updateItem(db, id, { ...patchFromOptions(), status }, author, note);
				out(row(getItem(db, id)!, true));
				break;
			}
			case "answer": {
				const id = idArg();
				const words = args.slice(2);
				if (!words.length) die('usage: wb answer <ref> "choice" (or the option\'s number)');
				// A pick-many decision takes each word as a pick ("1 3", "A" "B"); one quoted answer may say "1, 3".
				const many = getItem(db, id)!.pick === "many" && itemOptions(getItem(db, id)!).length;
				answerItem(db, id, many && words.length > 1 ? words : words.join(" "), author);
				out(row(getItem(db, id)!, true));
				break;
			}
			case "seen":
			case "object": {
				const id = idArg();
				const why = args.slice(2).join(" ");
				if (cmd === "object" && !why) die('usage: wb object <ref> "what you object to"');
				resolveAsk(db, id, cmd === "seen" ? { ack: true } : { object: why }, author);
				out(row(getItem(db, id)!, true));
				break;
			}
			case "export": {
				if (ctx.tty) die("wb export writes JSON: send it to a file, e.g. wb export > workbench-export.json");
				out(JSON.stringify(exportAll(db), null, 1));
				break;
			}
			case "note": {
				const id = idArg();
				const text = args.slice(2).join(" ");
				if (!text) die('usage: wb note <ref> "text"');
				addNote(db, id, text, author);
				break;
			}
			case "edit": {
				const id = idArg();
				let patch = patchFromOptions();
				const goal = goalOption(o.project ?? getItem(db, id)!.project);
				if (goal !== undefined) patch.goal_id = goal;
				// Handing it to Kostas, or making it an ask, is filing one: add's rules (filing.ts).
				let gave = false;
				try {
					({ patch, gave } = checkChange(db, getItem(db, id)!, patch, author === "agent"));
				} catch (e) {
					if (e instanceof Refusal) die(e.message);
					throw e;
				}
				const on = refIds(o.on);
				if (on.length) waitOn(db, id, on, author);
				removeLinks(db, id, refIds(o["not-on"]));
				updateItem(db, id, patch, author);
				show(id);
				const said = changeText(db, id, gave);
				if (said) err(`wb: ${said}`);
				if (patch.title !== undefined || patch.body !== undefined) {
					const i = getItem(db, id)!;
					const brief = briefOf(i, i.images.length);
					warnAbout(brief.refuse ? [brief.refuse.replace(" Nothing was filed.", "")] : brief.warnings);
				}
				break;
			}
			case "import": {
				const file = args[1] ?? die("usage: wb import <file.json>");
				const items = JSON.parse(new TextDecoder().decode((await ctx.read(file, "file")).bytes)) as (ItemPatch & {
					title: string;
					sources?: string | string[];
					since?: string;
				})[];
				const project = currentProject()!;
				let n = 0;
				db.transaction(() => {
					for (const it of items) {
						// `default` is the ask's default answer, as add_item and wb add --default call it.
						const { since, sources, default: def, ...rest } = it as typeof it & { default?: string | string[] };
						if (def !== undefined && rest.default_answer === undefined) rest.default_answer = def;
						const id = addItem(
							db,
							{ project, ...rest, sources: Array.isArray(sources) ? sources.join(", ") : (sources ?? "") },
							"import",
						);
						if (since) db.query("UPDATE items SET created_at = ? WHERE id = ?").run(`${since} 12:00:00`, id);
						n++;
					}
				})();
				out(`imported ${n} items into ${project}`);
				break;
			}
			case "rulings": {
				const project = o.all ? undefined : (o.project ?? currentProject(false));
				const list = listRulings(db, { project, q: o.q, retired: !!o.retired });
				if (!list.length) out(o.retired ? "no retired rulings" : "no rulings yet");
				for (const r of list) out(rulingRow(r, !project));
				break;
			}
			case "rule": {
				// wb rule <id> "text" rewrites; wb rule "text" adds.
				if (/^#?\d+$/.test(args[1] ?? "") && args.length > 2) {
					const r = updateRuling(db, Number(args[1].replace("#", "")), { text: args.slice(2).join(" ") }, author);
					out(rulingRow(r, true));
					break;
				}
				const text = args.slice(1).join(" ");
				if (!text) die('usage: wb rule "text" [--item <ref>] [--project P]');
				const item = o.item ? (resolveItem(db, o.item) ?? die(`no item "${o.item}"`)) : undefined;
				const project = o.project ? currentProject()! : item ? getItem(db, item)!.project : currentProject()!;
				out(`#${addRuling(db, { project, text, item }, author)}`);
				break;
			}
			case "unrule": {
				const id = Number((args[1] ?? "").replace("#", ""));
				if (!Number.isInteger(id) || !getRuling(db, id)) die("usage: wb unrule <id> (wb rulings has them)");
				out(rulingRow(retireRuling(db, id, author), true));
				break;
			}
			case "links":
				for (const l of listLinks(db))
					out(
						`#${String(l.id).padEnd(4)} ${(l.project || "(all)").padEnd(14)} ${(l.grp || "-").padEnd(16)} ${l.label.padEnd(24)} ${l.url}`,
					);
				break;
			case "link": {
				const [, label, url] = args;
				if (!label || !url) die('usage: wb link "Label" <url> [--project P | --all]');
				const project = o.all ? "" : currentProject()!;
				out(`#${addLink(db, { label, url, project, grp: o.group, icon_url: o.icon })}`);
				break;
			}
			case "relink": {
				const id = Number(args[1]);
				if (!Number.isInteger(id)) die("usage: wb relink <id> [--group G] [--icon <url>] [--title Label]");
				updateLink(db, id, { grp: o.group, icon_url: o.icon, label: o.title });
				break;
			}
			case "unlink": {
				const id = Number(args[1]);
				if (!Number.isInteger(id)) die("usage: wb unlink <id>");
				removeLink(db, id);
				break;
			}
			case "report": {
				const file = args[1] ?? die("usage: wb report <page.html> [--title T] [--group G] [--name N]");
				const html = new TextDecoder().decode((await ctx.read(file, "file")).bytes);
				const name =
					o.name ??
					file
						.split("/")
						.pop()!
						.replace(/\.html?$/i, "");
				const project = currentProject()!;
				const icon = o.icon === undefined ? undefined : await iconArg(o.icon);
				if (author === "agent" && reportLeftWithoutIcon(db, project, name, icon))
					die("every report needs its own icon in the sidebar: add --icon <emoji | file.svg>. Nothing was published.");
				const r = publishReport(db, { project, name, html, title: o.title, grp: o.group, icon }, author);
				out(`report #${r.id} v${r.n}${r.changed ? "" : " (unchanged)"}  ${ctx.base}/#report/${r.id}`);
				break;
			}
			case "report-icon": {
				const id = Number(args[1]);
				if (!Number.isInteger(id) || !args[2]) die("usage: wb report-icon <id> <emoji | file.svg | none>");
				setReportIcon(db, id, args[2] === "none" ? "" : await iconArg(args[2]));
				out(args[2] === "none" ? `report #${id}: no icon` : `report #${id}: icon set`);
				break;
			}
			case "reports": {
				const reports = listReports(db, o.project ?? currentProject(false));
				if (!reports.length) out("no reports");
				for (const r of reports)
					out(
						`#${String(r.id).padEnd(4)} ${r.project.padEnd(14)} ${(r.grp || "-").padEnd(12)} v${String(r.version).padEnd(3)} ${r.updated_at.slice(0, 16)}  ${r.name}  ${r.title}`,
					);
				break;
			}
			case "unreport": {
				const id = Number(args[1]);
				if (!Number.isInteger(id)) die("usage: wb unreport <id>");
				removeReport(db, id);
				break;
			}
			// wb.ts (and cloudcli.ts, for the cloud board) fill in the headers' {env:…} and {stdin} before this runs.
			case "source": {
				const [, sub, name, base] = args;
				if (sub !== "add" || !name || !base)
					die('usage: wb source add <name> <baseUrl> [--project P] [--write] --header "Authorization: Bearer {env:TOKEN}"');
				const project = currentProject()!;
				const headers: Record<string, string> = {};
				for (const spec of o.header ?? []) {
					const at = spec.indexOf(":");
					if (at < 1) die(`--header "Name: value", got "${spec}"`);
					const value = spec.slice(at + 1).trim();
					if (/\{env:|\{stdin\}/.test(value)) die("{env:…} and {stdin} are filled in by wb on the computer: update wb");
					headers[spec.slice(0, at).trim()] = value;
				}
				const { replaced } = addSource(db, { project, name, base_url: base, write: !!o.write, headers });
				const names = Object.keys(headers);
				out(
					`source ${name} ${replaced ? "replaced" : "added"} in ${project}: ${o.write ? "read and write" : "GET only"}` +
						`${names.length ? `, headers ${names.join(", ")} (sealed, key: ${currentKeyring().where})` : ", no headers"}`,
				);
				out(`in a report of ${project}: await wb.fetch("${name}", "/path")`);
				break;
			}
			case "sources": {
				const list = listSources(db, o.project ?? currentProject(false));
				if (!list.length) out("no data sources (wb source add)");
				for (const s of list)
					out(
						`${s.project.padEnd(14)} ${s.name.padEnd(16)} ${(s.write ? "write" : "read").padEnd(6)} ${s.base_url}${s.header_names.length ? `  [${s.header_names.join(", ")}]` : ""}`,
					);
				break;
			}
			case "unsource": {
				const name = args[1] ?? die("usage: wb unsource <name> [--project P]");
				const project = currentProject()!;
				removeSource(db, project, name);
				out(`source ${name} removed from ${project}`);
				break;
			}
			case "trackers": {
				const list = listTrackers(db, o.project ?? currentProject(false));
				if (o.json) {
					out(JSON.stringify(list, null, 2));
					break;
				}
				if (!list.length) out('no trackers (wb tracker add <name> "Title" ...)');
				const refW = Math.max(...list.map((t) => t.ref.length), 0);
				const titleW = Math.max(...list.map((t) => t.title.length), 0);
				for (const t of list) out(trackerRow(t, refW, titleW));
				break;
			}
			case "tracker": {
				const sub = args[1];
				if (!sub) die("usage: wb tracker <ref> | add | edit | refresh (wb help)");
				if (sub === "add") {
					const name =
						args[2] ?? die('usage: wb tracker add <name> ["Title"] [--command "…" | --preset P] [--every 1h]');
					const opts = trackerOptions();
					const t = addTracker(db, {
						...opts,
						name,
						title: args.slice(3).join(" ") || o.title,
						project: o.global ? "" : currentProject(),
					});
					out(`tracker ${t.ref} added: ${describeSource(t)}`);
					if (t.kind !== "manual") {
						out("reading it now…");
						const r = await refreshTracker(db, t.id, author);
						out(r.error ? `error: ${r.error}` : trackerText(r));
					} else out(`record a reading: wb track ${t.ref} 12/15`);
					break;
				}
				if (sub === "edit") {
					const t = trackerArg(args[2]);
					const patch = trackerOptions();
					if (o.title) patch.title = o.title;
					if (o.name) patch.name = o.name;
					// --global or --project on edit move it; without them it stays where it is.
					if (!o.global && o.project === undefined) delete patch.project;
					const after = updateTracker(db, t.id, patch);
					showTracker(after);
					break;
				}
				if (sub === "refresh") {
					const list = args[2]
						? [trackerArg(args[2])]
						: listTrackers(db, o.project ?? currentProject(false)).filter((t) => t.kind !== "manual");
					if (!list.length) out("nothing reads itself here (manual trackers take wb track)");
					const queue = [...list];
					await Promise.all(
						Array.from({ length: 3 }, async () => {
							for (let t = queue.shift(); t; t = queue.shift()) {
								try {
									const r = await refreshTracker(db, t.id, author);
									out(`${r.ref.padEnd(26)} ${r.error ? `error: ${r.error}` : trackerText(r)}`);
								} catch (e) {
									out(`${t.ref.padEnd(26)} ${(e as Error).message}`);
								}
							}
						}),
					);
					break;
				}
				const t = trackerArg(sub);
				if (o.json) out(JSON.stringify({ ...t, history: trackerHistory(db, t.id, 50) }, null, 2));
				else showTracker(t);
				break;
			}
			case "track": {
				const t = trackerArg();
				const lines = args.slice(2);
				if (!lines.length) die('usage: wb track <ref> 12/15 | "Android 12/15" "iOS 3/15" | "In review" [--note …]');
				const reading = parseReading(lines.join("\n"));
				if (o.note !== undefined) reading.note = o.note;
				if (o.resets !== undefined) reading.resets_at = o.resets;
				const after = recordReading(db, t.id, cleanReading(reading), author);
				out(`${after.ref.padEnd(26)} ${trackerText(after)}`);
				break;
			}
			case "untrack": {
				const t = trackerArg();
				removeTracker(db, t.id);
				out(`tracker ${t.ref} removed`);
				break;
			}
			case "vault": {
				// Secrets are encrypted in the browser; the CLI can't read them, only start over.
				if (args[1] === "reset") {
					if (!o.yes) die("this deletes every secret for good; run `wb vault reset --yes` to do it");
					out(`vault reset: ${resetVault(db)} secrets deleted`);
					break;
				}
				const v = vaultInfo(db);
				out(
					v
						? `vault set up · ${listSecrets(db).length} secrets · password changed ${v.changed_at} · open it on the board`
						: "no vault yet: open the board and click Vault",
				);
				break;
			}
			case "projects":
				for (const p of projects(db))
					out(`${p.slug.padEnd(14)} ${p.name.padEnd(18)} ${p.path}${p.archived_at ? "  (archived)" : ""}`);
				break;
			case "project": {
				const [, slug, path, name] = args;
				if (slug && !path && (o.archive || o.unarchive)) {
					updateProject(db, slug, { archived: !!o.archive });
					out(
						o.archive
							? `project ${slug} archived: off the board, its trackers paused`
							: `project ${slug} is back on the board`,
					);
					break;
				}
				if (slug && !path && o.icon !== undefined) {
					setProjectIcon(db, slug, o.icon);
					out(o.icon ? `project ${slug} logo → ${o.icon}` : `project ${slug} logo: found in the repo`);
					break;
				}
				if (!slug || !path) die('usage: wb project <slug> <path> "Name" [--icon <file>]');
				upsertProject(db, { slug, path: path.replace(/\/$/, ""), name: name ?? slug });
				if (o.icon !== undefined) setProjectIcon(db, slug, o.icon);
				out(`project ${slug} → ${path}`);
				break;
			}
			case "devices": {
				const { listDevices } = await import("./devices");
				const list = listDevices(db);
				if (!list.length)
					out("no phones paired: pair one in Settings → Privacy and security, with the board under --lan");
				for (const d of list)
					out(
						`${d.id}  ${d.name.padEnd(24)} paired ${d.paired_at}  last seen ${d.last_seen_at ?? "never"}${d.last_ip ? ` from ${d.last_ip}` : ""}`,
					);
				break;
			}
			case "unpair": {
				const { removeAllDevices, removeDevice } = await import("./devices");
				const id = args[1];
				if (!id) die("usage: wb unpair <id|all> (wb devices lists them)");
				if (id === "all") out(`${removeAllDevices(db)} phones removed`);
				else if (removeDevice(db, id)) out(`phone ${id} removed`);
				else die(`no phone ${id} (wb devices lists them)`);
				break;
			}
			default:
				die(`unknown command "${cmd}" (wb help)`);
		}
	} catch (e) {
		err(`wb: ${(e as Error).message}`);
		return 1;
	}
	return 0;
}
