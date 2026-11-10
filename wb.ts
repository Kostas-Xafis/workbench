#!/usr/bin/env bun
import { parseArgs } from "node:util";
import {
	addItem,
	addLink,
	addNote,
	answerItem,
	backup,
	BACKUP_DIR,
	itemOptions,
	listBackups,
	pruneBackups,
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
	open,
	projectForPath,
	projects,
	updateProject,
	updateItem,
	upsertProject,
	type Item,
	type ItemPatch,
	type Status,
} from "./db";
import { backupsKeep, exportAll } from "./db";
import { currentDay, dayData, dayPage, publishDay } from "./day";
import { PORT } from "./server";
import { addSource, KEY_PATH, listSources, removeSource } from "./sources";
import { PRESETS } from "./presets";
import { checkBrief, WRITING_GUIDE } from "./brief";
import { addImage, imageBytes, imageData, imageInfo, imageSummary, prepareImage, removeImage } from "./images";
import { dayStartHour, ownerDefaultsText, ownerFor, yourName } from "./settings";
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

/** Says the board's name for the owner "kostas", day start and owner defaults as they are set now. */
const help = (name = yourName(db), start = `${String(dayStartHour(db)).padStart(2, "0")}:00`) => `wb — the workbench. Tasks for agents, checks and decisions for ${name}, across projects.
Items are named wb-xxxx (e.g. wb-k3f9); commands take that, the bare k3f9, or an old number.

  wb ls [--mine | --agents] [--all] [--project P] [--kind K] [-q text]
                                   open items (--all includes done); --mine = ${name}'s
  wb show <ref>                     an item with its history
  wb add "title" [options]         new item, prints its id
  wb start <ref> [--session S] [--branch B]   an agent picks it up (session defaults to the
                                   desktop app session it runs in, so the board links to it)
  wb wait <ref> "why"               blocked on something
  wb done <ref> ["note"]            finished (the note says what changed / where)
  wb drop <ref> ["why"]             won't do
  wb note <ref> "text"              add to the history
  wb answer <ref> "choice"          answer a decision (or the option's number); it goes back to the agent
  wb edit <ref> [options]           change fields
  wb guide                          how to write an item ${name} can follow: read it before filing one
  wb image add <ref> <file> "caption"   put a screenshot on an item, or --image <file> --caption "…" on wb add
  wb image save <id> <file>         write one to a file, to look at it (wb show lists them)
  wb image rm <id>                  take one off
  wb import <file.json> [--project P]   bulk add (array of items)
  wb links                         bookmarks shown on the board
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
  wb serve [--lan]                 run the board on http://localhost:${PORT}
  wb open                          start the board if needed and open it

Options for add/edit:
  --kind task|check|review|decision|setup|bug|idea   (default task)
  --owner kostas|agent       who has to act (kostas = ${name}). Without it, by kind:
                             ${ownerDefaultsText(db)}
  --project P                default: the project whose path contains the current folder
  --area A  --p 1|2|3  --body "markdown"  --branch B  --session S  --source "file:line"
  --option "choice"          repeat for each choice of a decision; ${name} answers with one click
                             (--option alone makes the item a decision)
  --status todo|doing|waiting|done|dropped

Kinds: task = code work · check = try it on a device · review = read wording/design ·
decision = a question only ${name} can answer · setup = accounts, consoles, stores · bug · idea = later/maybe.`;

const { values: o, positionals: args } = parseArgs({
	args: Bun.argv.slice(2),
	allowPositionals: true,
	options: {
		kind: { type: "string" },
		owner: { type: "string" },
		project: { type: "string" },
		area: { type: "string" },
		p: { type: "string" },
		body: { type: "string" },
		branch: { type: "string" },
		session: { type: "string" },
		source: { type: "string" },
		status: { type: "string" },
		title: { type: "string" },
		mine: { type: "boolean" },
		agents: { type: "boolean" },
		all: { type: "boolean" },
		lan: { type: "boolean" },
		q: { type: "string", short: "q" },
		group: { type: "string" },
		icon: { type: "string" },
		name: { type: "string" },
		out: { type: "string" },
		yes: { type: "boolean" },
		archive: { type: "boolean" },
		unarchive: { type: "boolean" },
		write: { type: "boolean" },
		header: { type: "string", multiple: true },
		command: { type: "string" },
		preset: { type: "string" },
		param: { type: "string", multiple: true },
		every: { type: "string" },
		max: { type: "string" },
		unit: { type: "string" },
		warn: { type: "string" },
		bad: { type: "string" },
		url: { type: "string" },
		note: { type: "string" },
		resets: { type: "string" },
		global: { type: "boolean" },
		json: { type: "boolean" },
		option: { type: "string", multiple: true },
		image: { type: "string", multiple: true },
		caption: { type: "string", multiple: true },
		help: { type: "boolean", short: "h" },
	},
});

const db = open();
/** A report icon as given on the command line: an .svg file's contents, or the emoji itself. */
async function iconArg(icon: string) {
	if (!/\.svg$/i.test(icon)) return icon;
	const file = Bun.file(icon);
	if (!(await file.exists())) die(`no file ${icon}`);
	return file.text();
}

const author = process.env.WB_AUTHOR ?? (process.env.CLAUDECODE ? "agent" : "kostas");

function die(msg: string): never {
	console.error(`wb: ${msg}`);
	process.exit(1);
}

function currentProject(required = true) {
	if (o.project) {
		if (!projects(db).some((p) => p.slug === o.project)) die(`unknown project "${o.project}" (wb projects)`);
		return o.project;
	}
	const p = projectForPath(db, process.cwd());
	if (!p && required) die("not inside a known project; pass --project (wb projects)");
	return p?.slug;
}

function idArg() {
	const id = resolveItem(db, args[1]);
	if (id === undefined) die(`no item "${args[1] ?? ""}"`);
	return id;
}

/** Only agents get told how to write: an item {{name}} files for themselves can be as short as they like. */
const briefOf = (d: Parameters<typeof checkBrief>[0], images: number): ReturnType<typeof checkBrief> =>
	author === "agent" ? checkBrief(d, { name: yourName(db), images, attach: 'wb image add <ref> <file> "what to look at"' }) : { warnings: [] };

function warnAbout(warnings: string[]) {
	if (warnings.length) console.error(`wb: saved, but ${yourName(db)} may not follow it yet. Fix with wb edit (wb guide has how):\n${warnings.map((w) => `  - ${w}`).join("\n")}`);
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
	return patch;
}

const KIND_MARK: Record<string, string> = {
	task: "task",
	check: "CHECK",
	review: "REVIEW",
	decision: "DECIDE",
	setup: "SETUP",
	bug: "BUG",
	idea: "idea",
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
		`${status}${i.title}${i.answer ? `  → ${i.answer}` : ""}`,
		where ? ` ${where}` : "",
	]
		.filter(Boolean)
		.join(" ");
}

function show(id: number) {
	const i = getItem(db, id)!;
	console.log(`wb-${i.ref}  ${i.title}`);
	console.log(
		`${i.project} · ${i.kind} · for ${i.owner === "kostas" ? yourName(db) : "an agent"} · ${i.status} · P${i.priority}${i.area ? ` · ${i.area}` : ""}`,
	);
	if (i.branch || i.session)
		console.log([i.branch && `branch ${i.branch}`, i.session && `session ${i.session}`].filter(Boolean).join(" · "));
	if (i.sources) console.log(`sources: ${i.sources}`);
	if (i.body) console.log(`\n${i.body}`);
	if (i.images.length) console.log(`\nimages (wb image save <id> <file> to see one):\n${i.images.map((m) => `  ${imageSummary(m)}`).join("\n")}`);
	const options = itemOptions(i);
	if (options.length) console.log(`\noptions:\n${options.map((x, n) => `  ${n + 1}. ${x}`).join("\n")}`);
	if (i.answer) console.log(`\nanswer: ${i.answer}`);
	console.log("\nhistory:");
	for (const n of i.notes) console.log(`  ${n.at}  ${n.author ? n.author + ": " : ""}${n.text}`);
}

/**
 * --header "Name: value" for `wb source add`. A secret shouldn't be typed into a command line (shell history,
 * ps), so the value can say {env:VAR} or {stdin}; stdin is asked without echo on a terminal, else read a line each.
 */
async function sourceHeaders(specs: string[]) {
	const headers: Record<string, string> = {};
	let piped: string[] | undefined;
	const fromStdin = async (name: string) => {
		if (process.stdin.isTTY) {
			Bun.spawnSync(["stty", "-echo"], { stdin: "inherit" });
			try {
				return prompt(`${name} (typing is hidden):`) ?? "";
			} finally {
				Bun.spawnSync(["stty", "echo"], { stdin: "inherit" });
				process.stdout.write("\n");
			}
		}
		piped ??= (await Bun.stdin.text()).split(/\r?\n/);
		const line = piped.shift();
		if (line === undefined || line === "") die(`stdin ran out of lines for ${name}`);
		return line;
	};
	for (const spec of specs) {
		const at = spec.indexOf(":");
		if (at < 1) die(`--header "Name: value", got "${spec}"`);
		const name = spec.slice(0, at).trim();
		let value = spec.slice(at + 1).trim();
		for (const m of value.match(/\{env:[A-Za-z_][A-Za-z0-9_]*\}/g) ?? []) {
			const v = process.env[m.slice(5, -1)];
			if (!v) die(`${m.slice(5, -1)} is not set (for ${name})`);
			value = value.replace(m, () => v);
		}
		if (value.includes("{stdin}")) {
			const v = await fromStdin(name);
			value = value.replace("{stdin}", () => v);
		}
		headers[name] = value;
	}
	return headers;
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
	const age = t.kind === "manual" ? sqlAge(t.read_at) : t.error ? `failed ${sqlAge(t.checked_at)}` : sqlAge(t.read_at);
	return `${t.ref.padEnd(refW)}  ${t.title.padEnd(titleW)}  ${trackerText(t)}  (${age})`;
}

function showTracker(t: Tracker) {
	console.log(`${t.ref} · ${t.title}${t.project ? "" : " (global: shown with every project)"}`);
	if (t.reading) {
		const w = Math.max(...t.reading.meters.map((m) => m.label.length));
		for (const m of t.reading.meters) console.log(`  ${w ? `${m.label.padEnd(w)}  ` : ""}${meterText({ ...m, label: "" })}`);
		const resets = t.reading.resets_at
			? `resets ${t.reading.resets_at.slice(0, 10)} (in ${Math.max(0, Math.ceil((Date.parse(t.reading.resets_at) - Date.now()) / 86400e3))} days)`
			: "";
		const extra = [t.reading.note, resets].filter(Boolean).join(" · ");
		if (extra) console.log(`  ${extra}`);
		if (t.reading.url) console.log(`  ${t.reading.url}`);
	} else console.log("  no reading yet");
	if (t.error) console.log(`  error (${sqlAge(t.checked_at)}): ${t.error}`);
	console.log(`source: ${describeSource(t)}`);
	console.log(
		`read ${sqlAge(t.read_at)}${t.stale ? " (stale)" : ""}${t.running ? " · reading now" : ""}` +
			(t.due_at ? ` · next ${new Date(t.due_at.replace(" ", "T") + "Z").toLocaleString()}` : "") +
			[t.max !== null ? ` · max ${t.max}` : "", t.unit ? ` · unit ${t.unit}` : "", t.warn ? ` · warn ${t.warn}` : "", t.bad ? ` · bad ${t.bad}` : ""].join(""),
	);
	const history = trackerHistory(db, t.id, 10);
	if (history.length > 1) {
		console.log("history:");
		for (const h of history)
			console.log(`  ${h.at.slice(0, 16)}  ${h.reading.meters.map((m) => meterText({ ...m, level: "" })).join(" · ")}${h.author ? `  (${h.author})` : ""}`);
	}
}

async function serverUp() {
	try {
		await fetch(`http://127.0.0.1:${PORT}/api/projects`, { signal: AbortSignal.timeout(500) });
		return true;
	} catch {
		return false;
	}
}

const cmd = args[0];
if (!cmd || o.help || cmd === "help") {
	console.log(help());
	process.exit(0);
}

try {
	switch (cmd) {
		case "ls": {
			const project = o.project ?? currentProject(false);
			const status: Status[] = o.all ? [] : ["doing", "todo", "waiting"];
			const items = listItems(db, {
				project,
				owner: o.mine ? "kostas" : o.agents ? "agent" : undefined,
				kind: o.kind as Item["kind"],
				status,
				q: o.q,
			});
			if (!items.length) console.log("nothing open");
			for (const i of items) console.log(row(i, !project));
			break;
		}
		case "show":
			show(idArg());
			break;
		case "add": {
			const title = args.slice(1).join(" ") || o.title;
			if (!title) die('usage: wb add "title" [options]');
			const patch = patchFromOptions();
			const kind = patch.kind ?? (patch.options ? "decision" : "task");
			if ((o.image?.length ?? 0) !== (o.caption?.length ?? 0)) die('each --image needs its --caption: what it shows and what to look at');
			const brief = briefOf({ title, body: patch.body ?? "", kind, owner: patch.owner ?? ownerFor(db, kind) }, o.image?.length ?? 0);
			if (brief.refuse) die(brief.refuse);
			const images = await Promise.all(
				(o.image ?? []).map(async (path, n) => {
					const { bytes, label } = imageBytes({ path });
					return { image: await prepareImage(bytes, label), caption: o.caption![n] };
				}),
			);
			const id = addItem(
				db,
				{
					...patch,
					title,
					kind,
					project: currentProject()!,
				},
				author,
			);
			for (const m of images) addImage(db, id, m.image, m.caption, author);
			console.log(`wb-${getItem(db, id)!.ref}`);
			warnAbout(brief.warnings);
			break;
		}
		case "guide":
			console.log(WRITING_GUIDE.replaceAll("{{name}}", yourName(db)));
			break;
		case "image": {
			const sub = args[1];
			if (sub === "add") {
				const id = resolveItem(db, args[2]);
				if (id === undefined) die(`no item "${args[2] ?? ""}"`);
				const caption = args.slice(4).join(" ") || o.caption?.[0] || "";
				if (!args[3] || !caption.trim()) die('usage: wb image add <ref> <file> "what it shows and what to look at"');
				const { bytes, label } = imageBytes({ path: args[3] });
				const image = await prepareImage(bytes, label);
				const n = addImage(db, id, image, caption, author);
				console.log(`image ${n} on wb-${getItem(db, id)!.ref} (${Math.round(image.data.length / 1024)} KB)`);
			} else if (sub === "save") {
				const row = imageData(db, Number(args[2]));
				if (!row || !args[3]) die(row ? "usage: wb image save <id> <file>" : `no image ${args[2] ?? ""}`);
				await Bun.write(args[3], row.data);
				console.log(`${args[3]} (${row.type})`);
			} else if (sub === "rm") {
				if (!imageInfo(db, Number(args[2]))) die(`no image ${args[2] ?? ""}`);
				console.log(`removed from wb-${getItem(db, removeImage(db, Number(args[2]), author))!.ref}`);
			} else die('usage: wb image add <ref> <file> "caption" | wb image save <id> <file> | wb image rm <id>');
			break;
		}
		case "start": {
			const id = idArg();
			const session = o.session ?? process.env.CLAUDE_CODE_HOST_SESSION_ID;
			updateItem(db, id, { ...patchFromOptions(), status: "doing", ...(session ? { session } : {}) }, author);
			console.log(row(getItem(db, id)!, true));
			break;
		}
		case "wait":
		case "done":
		case "drop": {
			const id = idArg();
			const status = ({ wait: "waiting", done: "done", drop: "dropped" } as const)[cmd];
			const note = args.slice(2).join(" ");
			if (cmd === "wait" && !note) die('usage: wb wait <ref> "what it waits on"');
			updateItem(db, id, { ...patchFromOptions(), status }, author);
			if (note) addNote(db, id, note, author);
			console.log(row(getItem(db, id)!, true));
			break;
		}
		case "answer": {
			const id = idArg();
			const answer = args.slice(2).join(" ");
			if (!answer) die('usage: wb answer <ref> "choice" (or the option\'s number)');
			answerItem(db, id, answer, author);
			console.log(row(getItem(db, id)!, true));
			break;
		}
		case "backup": {
			console.log(backup(db));
			const pruned = pruneBackups(backupsKeep(db));
			if (pruned) console.log(`removed ${pruned} older backup${pruned > 1 ? "s" : ""} (keeping the newest ${backupsKeep(db)})`);
			break;
		}
		case "backups": {
			const list = listBackups();
			if (!list.length) console.log(`no backups yet in ${BACKUP_DIR}`);
			for (const b of list)
				console.log(`${b.at.toISOString().slice(0, 16).replace("T", " ")}  ${(b.bytes / 1024).toFixed(0).padStart(6)} KB  ${b.file}`);
			if (list.length) console.log(`${list.length} of at most ${backupsKeep(db)} kept (Settings → Data)`);
			break;
		}
		case "export": {
			if (process.stdout.isTTY) die("wb export writes JSON: send it to a file, e.g. wb export > workbench-export.json");
			process.stdout.write(`${JSON.stringify(exportAll(db), null, 1)}\n`);
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
			const patch = patchFromOptions();
			updateItem(db, id, patch, author);
			show(id);
			if (patch.title !== undefined || patch.body !== undefined) {
				const i = getItem(db, id)!;
				const brief = briefOf(i, i.images.length);
				warnAbout(brief.refuse ? [brief.refuse.replace(" Nothing was filed.", "")] : brief.warnings);
			}
			break;
		}
		case "import": {
			const file = args[1] ?? die("usage: wb import <file.json>");
			const items = (await Bun.file(file).json()) as (ItemPatch & {
				title: string;
				sources?: string | string[];
				since?: string;
			})[];
			const project = currentProject()!;
			let n = 0;
			db.transaction(() => {
				for (const it of items) {
					const { since, sources, ...rest } = it;
					const id = addItem(
						db,
						{ project, ...rest, sources: Array.isArray(sources) ? sources.join(", ") : (sources ?? "") },
						"import",
					);
					if (since) db.query("UPDATE items SET created_at = ? WHERE id = ?").run(`${since} 12:00:00`, id);
					n++;
				}
			})();
			console.log(`imported ${n} items into ${project}`);
			break;
		}
		case "links":
			for (const l of listLinks(db))
				console.log(
					`#${String(l.id).padEnd(4)} ${(l.project || "(all)").padEnd(14)} ${(l.grp || "-").padEnd(16)} ${l.label.padEnd(24)} ${l.url}`,
				);
			break;
		case "link": {
			const [, label, url] = args;
			if (!label || !url) die('usage: wb link "Label" <url> [--project P | --all]');
			const project = o.all ? "" : currentProject()!;
			console.log(`#${addLink(db, { label, url, project, grp: o.group, icon_url: o.icon })}`);
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
			const page = Bun.file(file);
			if (!(await page.exists())) die(`no file ${file}`);
			const name = o.name ?? file.split("/").pop()!.replace(/\.html?$/i, "");
			const project = currentProject()!;
			const icon = o.icon === undefined ? undefined : await iconArg(o.icon);
			if (author === "agent" && reportLeftWithoutIcon(db, project, name, icon))
				die("every report needs its own icon in the sidebar: add --icon <emoji | file.svg>. Nothing was published.");
			const r = publishReport(db, { project, name, html: await page.text(), title: o.title, grp: o.group, icon }, author);
			console.log(`report #${r.id} v${r.n}${r.changed ? "" : " (unchanged)"}  http://localhost:${PORT}/#report/${r.id}`);
			break;
		}
		case "report-icon": {
			const id = Number(args[1]);
			if (!Number.isInteger(id) || !args[2]) die("usage: wb report-icon <id> <emoji | file.svg | none>");
			setReportIcon(db, id, args[2] === "none" ? "" : await iconArg(args[2]));
			console.log(args[2] === "none" ? `report #${id}: no icon` : `report #${id}: icon set`);
			break;
		}
		case "day": {
			const day = args[1] ?? currentDay(db);
			if (o.out) {
				await Bun.write(o.out, dayPage(await dayData(db, day, o.project)));
				console.log(o.out);
				break;
			}
			// One page per project, in its own "Days" (the board also does this by itself every 30 min).
			let any = false;
			for (const slug of o.project ? [o.project] : projects(db).map((p) => p.slug)) {
				const r = await publishDay(db, day, slug, author, true);
				if (!r) continue;
				any = true;
				console.log(
					`${slug.padEnd(14)} report #${r.id} v${r.n}${r.changed ? "" : " (unchanged)"}  ${r.items} items, ${r.commits} commits  http://localhost:${PORT}/#report/${r.id}`,
				);
			}
			if (!any) console.log(`nothing new for ${day}`);
			break;
		}
		case "reports": {
			const reports = listReports(db, o.project ?? currentProject(false));
			if (!reports.length) console.log("no reports");
			for (const r of reports)
				console.log(
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
		case "source": {
			const [, sub, name, base] = args;
			if (sub !== "add" || !name || !base)
				die('usage: wb source add <name> <baseUrl> [--project P] [--write] --header "Authorization: Bearer {env:TOKEN}"');
			const project = currentProject()!;
			const headers = await sourceHeaders(o.header ?? []);
			const { replaced } = addSource(db, { project, name, base_url: base, write: !!o.write, headers });
			const names = Object.keys(headers);
			console.log(
				`source ${name} ${replaced ? "replaced" : "added"} in ${project}: ${o.write ? "read and write" : "GET only"}` +
					`${names.length ? `, headers ${names.join(", ")} (sealed, key ${KEY_PATH})` : ", no headers"}`,
			);
			console.log(`in a report of ${project}: await wb.fetch("${name}", "/path")`);
			break;
		}
		case "sources": {
			const list = listSources(db, o.project ?? currentProject(false));
			if (!list.length) console.log("no data sources (wb source add)");
			for (const s of list)
				console.log(
					`${s.project.padEnd(14)} ${s.name.padEnd(16)} ${(s.write ? "write" : "read").padEnd(6)} ${s.base_url}${s.header_names.length ? `  [${s.header_names.join(", ")}]` : ""}`,
				);
			break;
		}
		case "unsource": {
			const name = args[1] ?? die("usage: wb unsource <name> [--project P]");
			const project = currentProject()!;
			removeSource(db, project, name);
			console.log(`source ${name} removed from ${project}`);
			break;
		}
		case "trackers": {
			const list = listTrackers(db, o.project ?? currentProject(false));
			if (o.json) {
				console.log(JSON.stringify(list, null, 2));
				break;
			}
			if (!list.length) console.log('no trackers (wb tracker add <name> "Title" ...)');
			const refW = Math.max(...list.map((t) => t.ref.length), 0);
			const titleW = Math.max(...list.map((t) => t.title.length), 0);
			for (const t of list) console.log(trackerRow(t, refW, titleW));
			break;
		}
		case "tracker": {
			const sub = args[1];
			if (!sub) die("usage: wb tracker <ref> | add | edit | refresh (wb help)");
			if (sub === "add") {
				const name = args[2] ?? die('usage: wb tracker add <name> ["Title"] [--command "…" | --preset P] [--every 1h]');
				const opts = trackerOptions();
				const t = addTracker(db, {
					...opts,
					name,
					title: args.slice(3).join(" ") || o.title,
					project: o.global ? "" : currentProject(),
				});
				console.log(`tracker ${t.ref} added: ${describeSource(t)}`);
				if (t.kind !== "manual") {
					console.log("reading it now…");
					const r = await refreshTracker(db, t.id, author);
					console.log(r.error ? `error: ${r.error}` : trackerText(r));
				} else console.log(`record a reading: wb track ${t.ref} 12/15`);
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
				if (!list.length) console.log("nothing reads itself here (manual trackers take wb track)");
				const queue = [...list];
				await Promise.all(
					Array.from({ length: 3 }, async () => {
						for (let t = queue.shift(); t; t = queue.shift()) {
							try {
								const r = await refreshTracker(db, t.id, author);
								console.log(`${r.ref.padEnd(26)} ${r.error ? `error: ${r.error}` : trackerText(r)}`);
							} catch (e) {
								console.log(`${t.ref.padEnd(26)} ${(e as Error).message}`);
							}
						}
					}),
				);
				break;
			}
			const t = trackerArg(sub);
			if (o.json) console.log(JSON.stringify({ ...t, history: trackerHistory(db, t.id, 50) }, null, 2));
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
			console.log(`${after.ref.padEnd(26)} ${trackerText(after)}`);
			break;
		}
		case "untrack": {
			const t = trackerArg();
			removeTracker(db, t.id);
			console.log(`tracker ${t.ref} removed`);
			break;
		}
		case "mcp": {
			const { serveStdio } = await import("./mcp");
			await serveStdio();
			break;
		}
		case "vault": {
			// Secrets are encrypted in the browser; the CLI can't read them, only start over.
			if (args[1] === "reset") {
				if (!o.yes) die("this deletes every secret for good; run `wb vault reset --yes` to do it");
				console.log(`vault reset: ${resetVault(db)} secrets deleted`);
				break;
			}
			const v = vaultInfo(db);
			console.log(
				v
					? `vault set up · ${listSecrets(db).length} secrets · password changed ${v.changed_at} · open it on the board`
					: "no vault yet: open the board and click Vault",
			);
			break;
		}
		case "projects":
			for (const p of projects(db))
				console.log(`${p.slug.padEnd(14)} ${p.name.padEnd(18)} ${p.path}${p.archived_at ? "  (archived)" : ""}`);
			break;
		case "project": {
			const [, slug, path, name] = args;
			if (slug && !path && (o.archive || o.unarchive)) {
				updateProject(db, slug, { archived: !!o.archive });
				console.log(o.archive ? `project ${slug} archived: off the board, its trackers paused` : `project ${slug} is back on the board`);
				break;
			}
			if (slug && !path && o.icon !== undefined) {
				setProjectIcon(db, slug, o.icon);
				console.log(o.icon ? `project ${slug} logo → ${o.icon}` : `project ${slug} logo: found in the repo`);
				break;
			}
			if (!slug || !path) die('usage: wb project <slug> <path> "Name" [--icon <file>]');
			upsertProject(db, { slug, path: path.replace(/\/$/, ""), name: name ?? slug });
			if (o.icon !== undefined) setProjectIcon(db, slug, o.icon);
			console.log(`project ${slug} → ${path}`);
			break;
		}
		case "serve": {
			const { serve } = await import("./server");
			const s = serve({ lan: o.lan });
			console.log(`workbench on http://${s.hostname}:${s.port}`);
			break;
		}
		case "open": {
			if (!(await serverUp())) {
				Bun.spawn(["bun", new URL("./server.ts", import.meta.url).pathname], {
					stdio: ["ignore", "ignore", "ignore"],
				}).unref();
				for (let i = 0; i < 20 && !(await serverUp()); i++) await Bun.sleep(100);
			}
			Bun.spawn(["xdg-open", `http://localhost:${PORT}`], { stdio: ["ignore", "ignore", "ignore"] }).unref();
			break;
		}
		default:
			die(`unknown command "${cmd}" (wb help)`);
	}
} catch (e) {
	die((e as Error).message);
}
