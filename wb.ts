#!/usr/bin/env bun
import { parseArgs } from "node:util";
import {
	addItem,
	addLink,
	addNote,
	listLinks,
	removeLink,
	updateLink,
	getItem,
	listItems,
	open,
	projectForPath,
	projects,
	updateItem,
	upsertProject,
	type Item,
	type ItemPatch,
	type Status,
} from "./db";
import { PORT } from "./server";

const HELP = `wb — the workbench. Tasks for agents, checks and decisions for Kostas, across projects.

  wb ls [--mine | --agents] [--all] [--project P] [--kind K] [-q text]
                                   open items (--all includes done); --mine = Kostas's
  wb show <id>                     an item with its history
  wb add "title" [options]         new item, prints its id
  wb start <id> [--session S] [--branch B]   an agent picks it up (session defaults to the
                                   desktop app session it runs in, so the board links to it)
  wb wait <id> "why"               blocked on something
  wb done <id> ["note"]            finished (the note says what changed / where)
  wb drop <id> ["why"]             won't do
  wb note <id> "text"              add to the history
  wb edit <id> [options]           change fields
  wb import <file.json> [--project P]   bulk add (array of items)
  wb links                         bookmarks shown on the board
  wb link "Label" <url> [--project P | --all] [--group G] [--icon <icon url>]
                                   add one (--all: shown with every project)
  wb relink <id> [--group G] [--icon <url>] [--title "Label"]   change one
  wb unlink <id>                   remove one
  wb projects                      list projects
  wb project <slug> <path> "Name"  add or update a project
  wb serve [--lan]                 run the board on http://localhost:${PORT}
  wb open                          start the board if needed and open it

Options for add/edit:
  --kind task|check|review|decision|setup|bug|idea   (default task)
  --owner kostas|agent       who has to act (default agent; check/review/decision/setup default kostas)
  --project P                default: the project whose path contains the current folder
  --area A  --p 1|2|3  --body "markdown"  --branch B  --session S  --source "file:line"
  --status todo|doing|waiting|done|dropped

Kinds: task = code work · check = try it on a device · review = read wording/design ·
decision = a question only Kostas can answer · setup = accounts, consoles, stores · bug · idea = later/maybe.`;

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
		help: { type: "boolean", short: "h" },
	},
});

const db = open();
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
	const id = Number(args[1]);
	if (!Number.isInteger(id) || !getItem(db, id)) die(`no item "${args[1] ?? ""}"`);
	return id;
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
	const who = i.owner === "kostas" ? "K" : "A";
	const session = i.session.startsWith("local_") ? i.session.slice(0, 14) : i.session;
	const where = [i.branch && `⎇ ${i.branch}`, session && `@ ${session}`].filter(Boolean).join("  ");
	return [
		`#${String(i.id).padEnd(4)}`,
		`P${i.priority}`,
		who,
		KIND_MARK[i.kind].padEnd(6),
		showProject ? i.project.padEnd(12) : "",
		`${status}${i.title}`,
		where ? ` ${where}` : "",
	]
		.filter(Boolean)
		.join(" ");
}

function show(id: number) {
	const i = getItem(db, id)!;
	console.log(`#${i.id} ${i.title}`);
	console.log(
		`${i.project} · ${i.kind} · owner ${i.owner} · ${i.status} · P${i.priority}${i.area ? ` · ${i.area}` : ""}`,
	);
	if (i.branch || i.session)
		console.log([i.branch && `branch ${i.branch}`, i.session && `session ${i.session}`].filter(Boolean).join(" · "));
	if (i.sources) console.log(`sources: ${i.sources}`);
	if (i.body) console.log(`\n${i.body}`);
	console.log("\nhistory:");
	for (const n of i.notes) console.log(`  ${n.at}  ${n.author ? n.author + ": " : ""}${n.text}`);
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
	console.log(HELP);
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
			const kind = patch.kind ?? "task";
			const id = addItem(
				db,
				{
					...patch,
					title,
					kind,
					owner: patch.owner ?? (["check", "review", "decision", "setup"].includes(kind) ? "kostas" : "agent"),
					project: currentProject()!,
				},
				author,
			);
			console.log(`#${id}`);
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
			if (cmd === "wait" && !note) die('usage: wb wait <id> "what it waits on"');
			updateItem(db, id, { ...patchFromOptions(), status }, author);
			if (note) addNote(db, id, note, author);
			console.log(row(getItem(db, id)!, true));
			break;
		}
		case "note": {
			const id = idArg();
			const text = args.slice(2).join(" ");
			if (!text) die('usage: wb note <id> "text"');
			addNote(db, id, text, author);
			break;
		}
		case "edit": {
			const id = idArg();
			updateItem(db, id, patchFromOptions(), author);
			show(id);
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
		case "projects":
			for (const p of projects(db)) console.log(`${p.slug.padEnd(14)} ${p.name.padEnd(18)} ${p.path}`);
			break;
		case "project": {
			const [, slug, path, name] = args;
			if (!slug || !path) die('usage: wb project <slug> <path> "Name"');
			upsertProject(db, { slug, path: path.replace(/\/$/, ""), name: name ?? slug });
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
