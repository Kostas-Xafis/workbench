/**
 * The workbench as an MCP server: the same items, trackers, reports and links agents reach with `wb`, as tools,
 * resources, prompts and completions. One dispatcher, two transports:
 *
 * - stdio: `wb mcp` (Claude Code: `claude mcp add -s user wb -- wb mcp`). Its default project is the one whose
 *   folder the client started it in, like `wb` itself.
 * - Streamable HTTP: POST http://localhost:4321/mcp on the board (`?project=slug` sets the default project).
 *   This computer only: loopback peers, a localhost Host, no foreign Origin.
 *
 * Dual-era (spec 2026-07-28, basic/versioning): a request whose `_meta` names a protocol version is served
 * statelessly, as that revision; `initialize` picks a legacy revision (2025-11-25 back to 2024-11-05) for the
 * rest of a stdio process, and over HTTP the MCP-Protocol-Version header says which one each request speaks.
 * Results are shaped for the revision they answer: `resultType`, caching hints and serverInfo in `_meta` for
 * 2026-07-28; titles, structured content and resource links only where that revision has them.
 *
 * The vault is reached only through Kostas: vault_list and vault_get open a password window on this computer for
 * every request (vaultask.ts). Data source secrets and deletions of items or reports are not here. An image
 * can be removed: it's an agent's way to replace a picture it got wrong, and the item's history keeps the line.
 */
// `text`, not `file`: the cloud board (worker/) bundles this with esbuild, which takes no file imports.
import iconSvg from "../ui/icon.svg" with { type: "text" };
import {
	addLink,
	addNote,
	answerItem,
	getItem,
	getReport,
	htmlText,
	itemOptions,
	KINDS,
	listItems,
	listLinks,
	listReports,
	open,
	OWNERS,
	projectForPath,
	projects,
	publishReport,
	reportHtml,
	resolveItem,
	search,
	reportLeftWithoutIcon,
	setReportIcon,
	STATUSES,
	updateItem,
	type Db,
	type Item,
	type ItemPatch,
	type Note,
	type Status,
} from "./db";
import { applyDue, deadlineText, defaultText, itemPicks, itemRecommended, needsKostas } from "./asks";
import { BRIEF_RULES, checkBrief } from "./brief";
import { changeText, checkChange, fileItem, type Filed } from "./filing";
import { activeGoal, addGoal, dueText, GOAL_STATUSES, goalLine, goalsWithStats, goalTitle, needGoal, updateGoal, type GoalInfo } from "./goals";
import { runData, runText } from "./checkruns";
import { integrationGuide } from "./integrate";
import { removeLinks, topUnblockers, waitOn } from "./links";
import { repoState } from "./git";
import { addImage, imageBytes, imageData, imageInfo, imageSummary, prepareImage, removeImage, type Prepared } from "./images";
import { PRESETS } from "./presets";
import {
	addRuling,
	getRuling,
	itemRulings,
	listRulings,
	RELEVANT,
	repeatWarning,
	retireRuling,
	rulingSource,
	similarRulings,
	updateRuling,
	type Ruling,
} from "./rulings";
import { ownerDefaultsText, yourName } from "./settings";
import { noteMcpContact } from "./setup";
import { noteAlive } from "./alive";
import { listSources } from "./sources";
import { STALLED_DAYS, WAITING_DAYS, staleLabel } from "./stale";
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
	stopRuns,
	TRACKER_KINDS,
	trackerHistory,
	trackerText,
	updateTracker,
	type Meter,
	type Reading,
	type Tracker,
	type TrackerPatch,
} from "./trackers";
import { briefText } from "./today";
import { latestRun, runLine } from "./dispatch";
import { FILE_MINUTES, getForAgent, getReply, listForAgent, listReply, type Delivery } from "./vaultask";

const BOARD = `http://localhost:${Number(process.env.WB_PORT ?? 4321)}`;
const MODERN = "2026-07-28";
const LEGACY = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const SUPPORTED = [MODERN, ...LEGACY];
const M = "io.modelcontextprotocol/";
const VERSION = "1.0.0";
const OPEN: Status[] = ["todo", "doing", "waiting"];

const ICON = `data:image/svg+xml;base64,${Buffer.from(iconSvg).toString("base64")}`;
const SERVER_INFO = {
	name: "workbench",
	title: "Workbench",
	version: VERSION,
	description: "{{name}}'s board of open work across projects: items, status trackers, reports and links.",
	icons: [{ src: ICON, mimeType: "image/svg+xml", sizes: ["any"] }],
	websiteUrl: BOARD,
};
const CAPABILITIES = { tools: {}, resources: {}, prompts: {}, completions: {} };

// {{name}} and {{owner-defaults}} in what agents read are filled in per request (personal), from the board's settings.
const INSTRUCTIONS = `The workbench is {{name}}'s local board of open work across their projects. Open work lives here, never in markdown lists.
- Items are named wb-xxxx (e.g. wb-k3f9). When a prompt names one, get_item first: its body and notes are the brief.
- Kinds: task and bug (code), check ({{name}} tries it on a device: write the steps), review (something only {{name}} can judge), decision (a question only {{name}} can answer), setup (accounts, consoles, stores), notice (what changed, for {{name}} to see; it doesn't wait on them), idea. {{owner-defaults}} The owner value for {{name}} is kostas.
- Decide open questions yourself and keep moving: {{name}} has no time to explain. Ask only about money, accounts, stores, anything that can't be undone, or what the product should be. Related questions → one decision with pick "many". Every decision has recommended, and its body opens with it: it goes ahead by itself unless {{name}} objects. Changed something → a notice saying what, never a wording or layout review. Reviews and notices go ahead by themselves after the usual wait.
- When you start work {{name}} gave you: find its item (list_items with q) and start_item it, or add_item one and start it. One item per piece of work {{name}} would recognise.
- finish_item with a note on what changed and where (commit, branch). Everything you leave for {{name}} is its own item.
- Blocked on {{name}}? add_item with blocks: <your item> files the ask and waits on it in one call (or wait_item with on). Your item goes back to todo, with the answer in its history, the moment it's answered or finished: don't poll.
- The board can start an agent on an item itself ({{name}}'s Run or Answer & send): then nobody watches the session, so put questions on the board, not in the chat. Agents never start agents: there is no tool for it, and wb run is {{name}}'s. get_item shows an item's latest run.
- {{name}} doesn't open files: an item makes sense by itself, in plain words, with a screenshot (attach_image) for anything on screen. add_item has how, and warns about what's missing: fix it with update_item.
- Rulings are {{name}}'s standing answers in a project, one line each: project_overview lists them, list_rulings searches them. Read them before you ask, and follow them. An answered decision gets a drafted ruling ("<question>: <answer>"); when you pick one up, rewrite that draft as one clear line with update_ruling. add_ruling for a rule {{name}} states in the conversation; retire_ruling when one no longer holds.
- Every report you publish gets its own icon in colour (publish_report's icon), so the sidebar reads at a glance.
- Status trackers are live readings shown on the board, such as build quotas or CI minutes left. Check list_trackers before something that uses up a quota, refresh_trackers after.
- A goal says what a project's work is for (a release, a milestone), with a target date and the items that serve it (list_goals, project_overview). Give the items you file the goal they serve (add_item's goal), and prefer work on the active goal. Don't create goals unless {{name}} asks: propose one in a decision.
- Secrets (API keys, tokens): never ask {{name}} to paste one into the chat. vault_get asks them in a password window on their computer and hands you a private .env file; vault_list shows the names. When they say no, don't ask again unless they tell you to.
- Tools default to the project of the folder this server runs in; pass project (a slug from list_projects) to work elsewhere.`;

/**
 * Fills {{name}} (Settings → "Your name") and {{owner-defaults}} (who gets each kind) into text agents read, as the
 * settings are at this request: they can change while the board, or a stdio server, runs.
 */
function personal<T>(v: T, c: Conn): T {
	const name = yourName(c.db);
	let defaults: string | undefined;
	const fill = (t: string) =>
		t.replaceAll("{{name}}", () => name).replaceAll("{{owner-defaults}}", () => (defaults ??= ownerDefaultsText(c.db)));
	const walk = (x: unknown): unknown =>
		typeof x === "string"
			? fill(x)
			: Array.isArray(x)
				? x.map(walk)
				: x && typeof x === "object"
					? Object.fromEntries(Object.entries(x).map(([k, y]) => [k, walk(y)]))
					: x;
	return walk(v) as T;
}

/* ---------- JSON-RPC plumbing ---------- */

type Id = string | number;
type Rpc = { jsonrpc?: string; id?: Id | null; method?: unknown; params?: Record<string, unknown> };
type Json = Record<string, unknown>;

class RpcError extends Error {
	constructor(
		readonly code: number,
		message: string,
		readonly data?: unknown,
		/** The HTTP status when this ends a Streamable HTTP request. */
		readonly http = 200,
	) {
		super(message);
	}
}
/** A failure the model can act on: reported as a tool result with isError, not a protocol error. */
class ToolError extends Error {}

const unsupported = (requested: unknown) =>
	new RpcError(-32022, "Unsupported protocol version", { supported: SUPPORTED, requested }, 400);
const mismatch = (message: string) => new RpcError(-32020, `Header mismatch: ${message}`, undefined, 400);

/** One client connection: a stdio process, or a single HTTP request. */
type Conn = {
	transport: "stdio" | "http";
	db: Db;
	/** The default project for tools and prompts. */
	project?: string;
	/** The desktop-app session the client runs in (stdio), so start_item links it. */
	session?: string;
	/** The legacy revision `initialize` picked (stdio). */
	legacy?: string;
	/** The HTTP MCP-Protocol-Version header. */
	header?: string;
};

/** What a request speaks: the revision, and whether results get the 2026-07-28 shape. */
type Era = { version: string; modern: boolean };

function eraOf(m: Rpc, c: Conn): Era {
	const meta = (m.params?._meta ?? {}) as Json;
	const v = meta[`${M}protocolVersion`];
	if (v !== undefined) {
		if (typeof v !== "string" || !SUPPORTED.includes(v)) throw unsupported(v);
		return { version: v, modern: v === MODERN };
	}
	if (c.transport === "stdio") return { version: c.legacy ?? LEGACY[0], modern: false };
	// Without the header, a client older than 2025-06-18 (the spec says to assume 2025-03-26).
	return { version: c.header ?? "2025-03-26", modern: false };
}

const since = (era: Era, v: string) => era.version >= v;

/** The standard result fields of the revision: resultType, caching hints and serverInfo for 2026-07-28. */
function shape(era: Era, result: Json, cache?: { ttlMs: number; scope: "public" | "private" }): Json {
	if (!era.modern) return result;
	return {
		resultType: "complete",
		...result,
		...(cache ? { ttlMs: cache.ttlMs, cacheScope: cache.scope } : {}),
		_meta: { [`${M}serverInfo`]: { name: SERVER_INFO.name, version: VERSION }, ...((result._meta as Json) ?? {}) },
	};
}

function serverInfo(era: Era): Json {
	if (since(era, "2025-11-25")) return SERVER_INFO;
	const { name, title, version } = SERVER_INFO;
	return since(era, "2025-06-18") ? { name, title, version } : { name, version };
}

/* ---------- Argument schemas, checked before a tool runs ---------- */

type Schema = {
	type?: "object" | "string" | "integer" | "number" | "boolean" | "array" | "null";
	description?: string;
	properties?: Record<string, Schema>;
	required?: string[];
	additionalProperties?: boolean;
	enum?: readonly (string | number)[];
	items?: Schema;
	anyOf?: Schema[];
	minLength?: number;
	maxLength?: number;
	minimum?: number;
	maximum?: number;
	minItems?: number;
	maxItems?: number;
};

function check(v: unknown, s: Schema, at: string): string | null {
	if (s.anyOf) {
		const errs = s.anyOf.map((alt) => check(v, alt, at));
		return errs.includes(null) ? null : errs[0];
	}
	const name = at || "arguments";
	switch (s.type) {
		case "object": {
			if (!v || typeof v !== "object" || Array.isArray(v)) return `${name} must be an object`;
			const o = v as Json;
			for (const k of s.required ?? []) if (o[k] === undefined) return `${at ? `${at}.` : ""}${k} is required`;
			for (const [k, x] of Object.entries(o)) {
				const p = s.properties && Object.hasOwn(s.properties, k) ? s.properties[k] : undefined;
				if (!p) {
					if (s.additionalProperties === false) return `${at ? `${at}.` : ""}${k} is not a parameter of this tool`;
					continue;
				}
				if (x === undefined) continue;
				const e = check(x, p, at ? `${at}.${k}` : k);
				if (e) return e;
			}
			return null;
		}
		case "string":
			if (typeof v !== "string") return `${name} must be a string`;
			if (s.minLength !== undefined && v.trim().length < s.minLength) return `${name} can't be empty`;
			if (s.maxLength !== undefined && v.length > s.maxLength) return `${name} is over ${s.maxLength} characters`;
			break;
		case "integer":
		case "number":
			if (typeof v !== "number" || !Number.isFinite(v) || (s.type === "integer" && !Number.isInteger(v)))
				return `${name} must be ${s.type === "integer" ? "an integer" : "a number"}`;
			if (s.minimum !== undefined && v < s.minimum) return `${name} must be at least ${s.minimum}`;
			if (s.maximum !== undefined && v > s.maximum) return `${name} must be at most ${s.maximum}`;
			break;
		case "boolean":
			if (typeof v !== "boolean") return `${name} must be true or false`;
			break;
		case "null":
			if (v !== null) return `${name} must be null`;
			break;
		case "array": {
			if (!Array.isArray(v)) return `${name} must be an array`;
			if (s.minItems !== undefined && v.length < s.minItems) return `${name} needs at least ${s.minItems}`;
			if (s.maxItems !== undefined && v.length > s.maxItems) return `${name} takes at most ${s.maxItems}`;
			for (let i = 0; i < v.length; i++) {
				const e = s.items && check(v[i], s.items, `${name}[${i}]`);
				if (e) return e;
			}
			break;
		}
	}
	if (s.enum && !s.enum.includes(v as string)) return `${name} must be one of ${s.enum.join(", ")}`;
	return null;
}

const str = (description: string, more: Schema = {}): Schema => ({ type: "string", description, ...more });
const PROJECT = str('Project slug (see list_projects). Default: the project of the folder this server runs in.');
const REF = str("The item, e.g. wb-k3f9 (k3f9 works too).", { minLength: 1 });
const TRACKER = str('The tracker: its name, or project/name (e.g. isokratis/eas-builds). Global trackers are just name.', { minLength: 1 });
const obj = (properties: Record<string, Schema>, required: string[] = []): Schema => ({
	type: "object",
	properties,
	required,
	additionalProperties: false,
});

/* ---------- Text for the model ---------- */

const projectOf = (c: Conn, p?: string, required = true): string | undefined => {
	if (p !== undefined && p !== "" && p !== "*") {
		const all = projects(c.db);
		const want = p.trim().toLowerCase();
		const found = all.find((x) => x.slug === p) ?? all.find((x) => x.slug.toLowerCase() === want || x.name.toLowerCase() === want);
		if (!found) throw new ToolError(`no project "${p}"; there are: ${all.map((x) => x.slug).join(", ")}`);
		return found.slug;
	}
	if (p === "*") return undefined;
	if (c.project) return c.project;
	if (required)
		throw new ToolError(`which project? Pass project: one of ${projects(c.db).map((x) => x.slug).join(", ")}`);
	return undefined;
};

const itemId = (c: Conn, ref: string) => {
	const id = resolveItem(c.db, ref);
	if (id === undefined) throw new ToolError(`no item "${ref}" (list_items finds them)`);
	return id;
};

const WHO = (c: Conn, o: string) => (o === "kostas" ? yourName(c.db) : "agent");

function itemLine(c: Conn, i: Item, withProject: boolean) {
	const bits = [
		`wb-${i.ref}`,
		`P${i.priority}`,
		i.kind,
		`for ${WHO(c, i.owner)}`,
		i.status,
		withProject ? `[${i.project}]` : "",
		i.area ? `(${i.area})` : "",
	].filter(Boolean);
	const due = OPEN.includes(i.status) && i.owner === "kostas" ? deadlineText(i) : "";
	const extra = [i.goal_id != null && `goal: ${goalTitle(c.db, i.goal_id)}`, i.branch && `branch ${i.branch}`, i.answer && `answered: ${i.answer}`, due, i.image_count && `${i.image_count} image${i.image_count > 1 ? "s" : ""}`, i.unblocks && `unblocks ${i.unblocks}`, i.stale && staleLabel(i.stale)].filter(Boolean).join(" · ");
	return `${bits.join(" ")}: ${i.title}${extra ? ` · ${extra}` : ""}`;
}

const linkLine = (l: { ref: string; title: string; status: string; answer: string }) =>
	`wb-${l.ref} ${l.answer ? "answered" : l.status}: ${l.title}`;
const linkJson = (l: { ref: string; title: string; status: string; owner: string; kind: string; answer: string }) => ({
	ref: `wb-${l.ref}`,
	title: l.title,
	kind: l.kind,
	owner: l.owner,
	status: l.status,
	answer: l.answer || undefined,
});

/** The latest agent run the board started on it (dispatch.ts), for get_item; undefined when none. */
function runJson(db: Db, id: number) {
	const r = latestRun(db, id);
	return r ? { id: r.id, ...(r.kind === "land" ? { kind: r.kind } : {}), status: r.status, started_at: r.started_at, ended_at: r.ended_at ?? undefined, session: r.session || undefined, cost: r.cost ?? undefined, error: r.error || undefined, result: r.result ? r.result.slice(0, 500) : undefined } : undefined;
}

function itemText(c: Conn, i: NonNullable<ReturnType<typeof getItem>>) {
	const lines = [
		`wb-${i.ref}: ${i.title}`,
		`${i.project} · ${i.kind} · for ${WHO(c, i.owner)} · ${i.status} · P${i.priority}${i.area ? ` · ${i.area}` : ""}`,
	];
	if (i.stale) lines.push(`stale: ${staleLabel(i.stale)} (since ${i.stale.since})`);
	if (i.branch || i.session) lines.push([i.branch && `branch ${i.branch}`, i.session && `session ${i.session}`].filter(Boolean).join(" · "));
	if (i.goal_id != null) lines.push(`goal: #${i.goal_id} ${goalTitle(c.db, i.goal_id)}`);
	if (i.sources) lines.push(`from: ${i.sources}`);
	if (i.body) lines.push("", i.body);
	if (i.images.length) lines.push("", "images (see one with get_image):", ...i.images.map((m) => `  ${imageSummary(m)}`));
	const options = itemOptions(i);
	const rec = itemRecommended(i);
	if (options.length)
		lines.push("", i.pick === "many" ? "options (several can be picked):" : "options:", ...options.map((o, n) => `  ${n + 1}. ${o}${rec.includes(o) ? " (recommended)" : ""}`));
	if (i.default_answer) lines.push("", `if ${yourName(c.db)} says nothing: ${defaultText(i)}`);
	if (deadlineText(i) && OPEN.includes(i.status)) lines.push(`deadline: ${deadlineText(i)}`);
	if (i.answer) lines.push("", `answer: ${i.answer}`);
	const checkRun = runText(c.db, i.id);
	if (checkRun) lines.push("", checkRun);
	if (i.waits_on.length) lines.push("", "waits on:", ...i.waits_on.map((l) => `  ${linkLine(l)}`));
	if (i.blocks.length) lines.push("", "blocks (waiting on this):", ...i.blocks.map((l) => `  ${linkLine(l)}`));
	const rulings = itemRulings(c.db, i.id);
	if (rulings.length) lines.push("", "rulings from it:", ...rulings.map((r) => `  ${rulingLine(r)}`));
	const run = latestRun(c.db, i.id);
	if (run) lines.push("", `latest agent run the board started: ${runLine(run)}`);
	lines.push("", "history:", ...i.notes.map((n) => `  ${n.at} ${n.author ? `${n.author}: ` : ""}${n.text}`));
	return lines.join("\n");
}

const itemJson = (i: Item) => ({
	ref: `wb-${i.ref}`,
	project: i.project,
	goal_id: i.goal_id ?? undefined,
	title: i.title,
	kind: i.kind,
	owner: i.owner,
	status: i.status,
	priority: i.priority,
	area: i.area || undefined,
	branch: i.branch || undefined,
	session: i.session || undefined,
	options: itemOptions(i).length ? itemOptions(i) : undefined,
	answer: i.answer || undefined,
	pick: i.pick === "many" ? "many" : undefined,
	picks: i.picks ? itemPicks(i) : undefined,
	recommended: itemRecommended(i).length ? itemRecommended(i) : undefined,
	default: i.default_answer ? defaultText(i) : undefined,
	decide_by: i.decide_by ?? undefined,
	waits_on_kostas: needsKostas(i),
	images: i.image_count || undefined,
	stale: i.stale ?? null,
	unblocks: i.unblocks || undefined,
	created_at: i.created_at,
	updated_at: i.updated_at,
	done_at: i.done_at ?? undefined,
});

/** "#12 Traditional is the default melisma style (wb-k3f9, 25 Oct; drafted)". */
const rulingLine = (r: Ruling, withProject = false) =>
	`#${r.id}${withProject ? ` [${r.project}]` : ""} ${r.text} (${[rulingSource(r), r.drafted ? "drafted: rewrite it as one clear line" : "", r.retired_at ? `retired ${r.retired_at.slice(0, 10)}` : ""].filter(Boolean).join("; ")})`;

const rulingJson = (r: Ruling) => ({
	id: r.id,
	project: r.project,
	text: r.text,
	item: r.item_ref ? `wb-${r.item_ref}` : undefined,
	question: r.question || undefined,
	drafted: !!r.drafted,
	created_at: r.created_at,
	updated_at: r.updated_at,
	retired_at: r.retired_at ?? undefined,
});

const rulingId = (c: Conn, id: unknown) => {
	const n = Number(String(id).replace(/^#/, ""));
	const r = Number.isInteger(n) ? getRuling(c.db, n) : undefined;
	if (!r) throw new ToolError(`no ruling "${id}" (list_rulings has them)`);
	return r.id;
};

const trackerJson = (t: Tracker) => {
	const { id: _, sort: __, ...rest } = t;
	return { ...rest, source: describeSource(t) };
};

function trackerBlock(t: Tracker) {
	const head = `${t.ref} · ${t.title}${t.project ? "" : " (global)"}: ${trackerText(t)}`;
	const when = t.kind === "manual" ? `recorded ${t.read_at ?? "never"}` : `read ${t.read_at ?? "never"} UTC · ${describeSource(t)}`;
	return `${head}\n  ${when}${t.reading?.url ? ` · ${t.reading.url}` : ""}`;
}

/** A goal for project_overview and list_goals: its line, then what blocks it. */
function goalBlock(c: Conn, g: GoalInfo): string[] {
	const name = yourName(c.db);
	const lines = [`- ${goalLine(g, name)}`];
	if (g.body) lines.push(`  ${g.body.replace(/\s*\n\s*/g, " ").slice(0, 300)}`);
	if (g.stats.blockers.length) {
		lines.push("  blocked by:");
		for (const b of g.stats.blockers.slice(0, 8))
			lines.push(`    wb-${b.ref} ${b.kind} ${b.why === "kostas" ? `for ${name}` : "(agent, waiting)"}: ${b.title}`);
		if (g.stats.blockers.length > 8) lines.push(`    …and ${g.stats.blockers.length - 8} more`);
	}
	return lines;
}

const goalJson = (g: GoalInfo) => ({
	id: g.id,
	project: g.project,
	title: g.title,
	description: g.body || undefined,
	due: g.due || undefined,
	status: g.status,
	active: g.is_active,
	items: g.stats.total,
	done: g.stats.done,
	open: g.stats.open,
	waiting_on_kostas: g.stats.mine,
	blocked_by: g.stats.blockers.map((b) => ({ ref: `wb-${b.ref}`, title: b.title, kind: b.kind, owner: b.owner, status: b.status, why: b.why })),
});

/** The `goal` an add_item or update_item names, as a goal id (null = none). */
function goalArg(c: Conn, goal: string | number | undefined, project?: string): number | null | undefined {
	if (goal === undefined) return undefined;
	if (goal === null || ["none", "no", ""].includes(String(goal).trim().toLowerCase())) return null;
	try {
		return needGoal(c.db, goal, project);
	} catch (e) {
		throw new ToolError((e as Error).message);
	}
}
const GOAL_REF: Schema = {
	anyOf: [{ type: "integer" }, { type: "string" }],
	description: 'The goal this item serves: its number (see list_goals) or its exact title. "none" takes it off its goal.',
};

const SECTION_ORDER = ["decision", "setup", "check", "review", "notice", "bug", "task", "idea"];

async function overview(c: Conn, slug: string) {
	const p = projects(c.db).find((x) => x.slug === slug)!;
	const open = listItems(c.db, { project: slug, status: OPEN });
	// Notices don't wait on Kostas: they count with the agents' side here.
	const mine = open.filter(needsKostas).length;
	const out = [`# ${p.name} (${p.slug})`, p.path ? `Folder: ${p.path}` : "", ""];
	const goals = goalsWithStats(c.db, { project: slug, status: ["open"] });
	if (goals.length) {
		out.push("## Goals", ...goals.flatMap((g) => goalBlock(c, g)), "");
	}
	const notices = open.filter((i) => i.owner === "kostas" && i.kind === "notice").length;
	out.push(`## Open items: ${open.length} (${mine} for ${yourName(c.db)}, ${notices ? `${notices} notices for them to see, ` : ""}${open.length - mine - notices} for agents)`);
	for (const kind of SECTION_ORDER) {
		const list = open.filter((i) => i.kind === kind);
		if (list.length) out.push(`${kind}:`, ...list.map((i) => `- ${itemLine(c, i, false)}`));
	}
	const stale = open.filter((i) => i.stale);
	if (stale.length)
		out.push("", `## Stale: ${stale.length} (agent work doing with no news for ${STALLED_DAYS}+ days, or waiting for ${WAITING_DAYS}+)`, ...stale.map((i) => `- ${itemLine(c, i, false)}`));
	const top = topUnblockers(c.db, slug);
	if (top.length)
		out.push("", `## What ${yourName(c.db)} can unblock (open items that waiting work depends on)`, ...top.map((t) => `- wb-${t.item.ref} ${t.item.kind}: ${t.item.title} · unblocks ${t.waiters.map((w) => `wb-${w.ref} (${w.title})`).join(", ")}`));
	const rulings = listRulings(c.db, { project: slug });
	out.push("", `## Rulings (${rulings.length}): ${yourName(c.db)}'s standing answers. Follow them; read them before you ask anything`);
	out.push(...(rulings.length ? rulings.map((r) => `- ${rulingLine(r)}`) : ["none yet"]));
	const trackers = listTrackers(c.db, slug);
	out.push("", "## Trackers", ...(trackers.length ? trackers.map((t) => `- ${trackerBlock(t)}`) : ["none"]));
	const g = p.path ? await repoState(p) : null;
	out.push("", "## Git");
	if (!g) out.push("no folder");
	else if (!g.ok) out.push(g.error ?? "not a repository");
	else {
		const facts = [
			`branch ${g.branch || "(detached)"}`,
			g.dirty.length ? `${g.dirty.length} uncommitted` : "clean",
			g.ahead ? `${g.ahead} unpushed` : "",
			g.behind ? `${g.behind} behind` : "",
		].filter(Boolean);
		out.push(facts.join(" · "), `last commit: ${g.lastCommit}`);
		if (g.unmerged.length) out.push(`unmerged branches: ${g.unmerged.map((b) => `${b.name} (${b.date})`).join(", ")}`);
		if (g.worktrees.length) out.push(`worktrees: ${g.worktrees.map((w) => `${w.branch} at ${w.path}`).join(", ")}`);
	}
	const reports = listReports(c.db, slug);
	const days = reports.filter((r) => r.name.startsWith("day-"));
	out.push("", `## Reports (${reports.length})`);
	for (const r of reports.filter((r) => !r.name.startsWith("day-")))
		out.push(`- #${r.id} ${r.title}${r.grp ? ` [${r.grp}]` : ""} v${r.version}, updated ${r.updated_at}`);
	if (days.length) {
		const last = [...days].sort((a, b) => b.name.localeCompare(a.name))[0];
		out.push(`- ${days.length} day reports, newest #${last.id} ${last.title}`);
	}
	const links = listLinks(c.db).filter((l) => l.project === slug || !l.project);
	if (links.length) out.push("", "## Links", ...links.map((l) => `- ${l.grp ? `${l.grp} · ` : ""}${l.label}: ${l.url}`));
	const sources = listSources(c.db, slug);
	if (sources.length)
		out.push("", "## Data sources (reports call them with wb.fetch)", ...sources.map((s) => `- ${s.name} (${s.write ? "read/write" : "read"}) ${s.base_url}`));
	return out.filter((l, i, a) => !(l === "" && a[i - 1] === "")).join("\n");
}

/* ---------- Tools ---------- */

type Out = {
	text: string;
	data?: Json;
	links?: { uri: string; name: string; title?: string; mimeType?: string }[];
	/** A picture for the model, after the text. */
	image?: { data: string; mimeType: string };
};
type Tool = {
	name: string;
	title: string;
	description: string;
	input: Schema;
	hints: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
	run(a: Record<string, any>, c: Conn): Out | Promise<Out>;
};

const REPORT_ICON = str("Its icon in the sidebar: one emoji, or SVG markup (at most 8 KB, with a viewBox, in your own colours that read on light and dark; currentColor doesn't work). Every report has one: in colour, showing what the page is about at a glance.");
const RO = { readOnlyHint: true, openWorldHint: false };
const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
const itemLink = (i: Pick<Item, "ref" | "title">) => ({ uri: `wb://item/wb-${i.ref}`, name: `wb-${i.ref}`, title: i.title, mimeType: "text/markdown" });

function changed(c: Conn, id: number, verb: string, warnings: string[] = []): Out {
	const i = getItem(c.db, id)!;
	const said = warnings.length
		? `\n\nIt's saved, but ${yourName(c.db)} may not follow it yet. Fix these with update_item:\n${warnings.map((w) => `- ${w}`).join("\n")}`
		: "";
	return { text: `${verb} ${itemLine(c, i, true)}${said}`, data: { item: itemJson(i), ...(warnings.length ? { warnings } : {}) }, links: [itemLink(i)] };
}

const ATTACH = "attach_image, with a caption saying what to look at";

/** Reads the images an add_item names, before anything is filed: a wrong path shouldn't leave half an item behind. */
const readImages = (list: { path?: string; data?: string; caption: string }[] = []) =>
	Promise.all(
		list.map(async (m) => {
			const { bytes, label } = imageBytes(m);
			return { image: await prepareImage(bytes, label), caption: m.caption };
		}),
	) as Promise<{ image: Prepared; caption: string }[]>;

const IMAGE_SOURCE = {
	path: str("A file on this computer (absolute is safest): PNG, JPEG, WebP or GIF. Your scratchpad is a good place for it; the board keeps its own copy."),
	data: str("The picture as base64, when you have no file (a cloud session). A path is much cheaper."),
};
const CAPTION = str("What this shows and what to look at, for someone who hasn't seen the problem.", { minLength: 1, maxLength: 500 });

function readingFrom(a: { reading: string | Meter[]; note?: string; resets_at?: string }): Reading {
	const r: Reading = typeof a.reading === "string" ? parseReading(a.reading) : { meters: a.reading };
	if (a.note !== undefined) r.note = a.note;
	if (a.resets_at !== undefined) r.resets_at = a.resets_at;
	return cleanReading(r);
}

const METER: Schema = obj(
	{
		label: str('What it counts, e.g. "Android" ("" for a single meter).'),
		value: { type: "number", description: "The reading: how much is used, done or counted." },
		max: { type: "number", description: "The allowance or total the value counts against." },
		unit: str('Unit, e.g. "min", "builds", "%".'),
		text: str('A state in words instead of (or next to) a number, e.g. "In review".'),
		level: { type: "string", enum: ["ok", "warn", "bad"], description: "Overrides the tracker's thresholds." },
	},
	["label"],
);

/** The report a tool's `report` argument names: its id (#12) or its name in the project. */
function reportId(a: Record<string, any>, c: Conn) {
	const id = Number(String(a.report).replace(/^#/, ""));
	if (Number.isInteger(id) && id >= 1) return id;
	const project = projectOf(c, a.project)!;
	const r = listReports(c.db, project).find((r) => r.name === String(a.report).trim().toLowerCase());
	if (!r) throw new ToolError(`no report "${a.report}" in ${project} (list_reports)`);
	return r.id;
}

/** The fields that let an ask go ahead without {{name}} (asks.ts), on add_item and update_item. */
const ASK_PARAMS: Record<string, Schema> = {
	default: {
		anyOf: [{ type: "string" }, { type: "array", items: { type: "string" }, maxItems: 12 }],
		description: 'What happens if {{name}} says nothing (decisions, reviews, notices); it goes ahead at decide_by as if {{name}} had picked it. A decision with options: one of them (pick "many": a list, [] for none). Left out: the recommendation; a review closes with no objections, a notice as seen.',
	},
	decide_by: str('When the default goes ahead: a date (2026-11-14), "in 3 days", or "none". Left out: the usual wait (Settings → You and your day, 3 days).'),
	pick: { type: "string", enum: ["one", "many"], description: 'A decision: answered with one option (default) or several ticked ("many"). Bundle related questions into one this way.' },
	recommended: {
		anyOf: [{ type: "string" }, { type: "array", items: { type: "string" }, maxItems: 12 }],
		description: 'Your pick among the options (pick "many": a list). Without a default, it is the default.',
	},
};
/** The ask fields of a tool call as an item patch. */
const askPatch = (a: Record<string, any>): ItemPatch => ({
	...(a.default !== undefined ? { default_answer: a.default } : {}),
	...(a.decide_by !== undefined ? { decide_by: a.decide_by } : {}),
	...(a.pick !== undefined ? { pick: a.pick } : {}),
	...(a.recommended !== undefined ? { recommended: a.recommended } : {}),
});

const TOOLS: Tool[] = [
	{
		name: "list_projects",
		title: "List projects",
		description: "The projects on the workbench: slug, name, folder, and how many open items wait on {{name}} (notices, which don't wait, counted apart) and on agents.",
		input: obj({}),
		hints: RO,
		run(_, c) {
			const counts = c.db
				.query(
					`SELECT project, SUM(owner = 'kostas' AND kind != 'notice') AS kostas, SUM(owner = 'kostas' AND kind = 'notice') AS notices, SUM(owner = 'agent') AS agent FROM items
					WHERE status IN ('todo', 'doing', 'waiting') GROUP BY project`,
				)
				.all() as { project: string; kostas: number; notices: number; agent: number }[];
			const list = projects(c.db).map((p) => {
				const n = counts.find((x) => x.project === p.slug);
				return { slug: p.slug, name: p.name, path: p.path, open_for_kostas: n?.kostas ?? 0, notices_for_kostas: n?.notices ?? 0, open_for_agents: n?.agent ?? 0, current: p.slug === c.project, archived: !!p.archived_at };
			});
			return {
				text: list
					.map((p) => `${p.slug}${p.current ? " (current)" : ""}${p.archived ? " (archived)" : ""}: ${p.name} · ${p.path || "no folder"} · ${p.open_for_kostas} for ${yourName(c.db)}${p.notices_for_kostas ? ` (+${p.notices_for_kostas} notices)` : ""}, ${p.open_for_agents} for agents`)
					.join("\n"),
				data: { projects: list },
			};
		},
	},
	{
		name: "project_overview",
		title: "Project overview",
		description:
			"Everything about one project at a glance: open items by kind, {{name}}'s rulings (standing answers: read them before you ask anything), stale agent work (stalled doing, long waiting) listed apart, status trackers with their readings, git state (branch, uncommitted files, unpushed commits, unmerged branches, worktrees), reports, links and data sources. A good first call when you start work in a project.",
		input: obj({ project: PROJECT }),
		hints: RO,
		async run(a, c) {
			const slug = projectOf(c, a.project)!;
			return { text: await overview(c, slug), links: [{ uri: `wb://project/${slug}`, name: slug, mimeType: "text/markdown" }] };
		},
	},
	{
		name: "list_goals",
		title: "List goals",
		description:
			"A project's goals: what its work is for. Each with its target date, progress (items done of all), how many items wait on {{name}}, and what blocks it (open items for {{name}}, and agent items in waiting). The active goal comes first. Items serve a goal through add_item and update_item's goal.",
		input: obj({
			project: str('Project slug, or "*" for every project. Default: the current project.'),
			status: { type: "string", enum: ["open", "all", ...GOAL_STATUSES], description: "open (the default), all, or one status." },
		}),
		hints: RO,
		run(a, c) {
			const project = a.project === "*" ? undefined : projectOf(c, a.project, false);
			const status = a.status === "all" ? undefined : [a.status ?? "open"];
			const list = goalsWithStats(c.db, { project, status }).sort((x, y) => x.project.localeCompare(y.project) || Number(y.is_active) - Number(x.is_active));
			const head = `${list.length} goal${list.length === 1 ? "" : "s"}${project ? ` in ${project}` : ""}`;
			return {
				text: [head, ...list.flatMap((g) => goalBlock(c, g).map((l, n) => (n === 0 && !project ? l.replace("- ", `- [${g.project}] `) : l)))].join("\n"),
				data: { goals: list.map(goalJson) },
			};
		},
	},
	{
		name: "add_goal",
		title: "Add a goal",
		description:
			"Adds a goal to a project: a milestone its items serve (a release, a launch). Only when {{name}} asked for one: when you think a project needs a goal, file a decision item proposing it instead. Returns its number, which add_item and update_item take as goal.",
		input: obj(
			{
				title: str('What the work is for, as {{name}} would say it, e.g. "First release".', { minLength: 1, maxLength: 200 }),
				description: str("A few lines in markdown: what done looks like."),
				due: str("Target date, YYYY-MM-DD."),
				active: { type: "boolean", description: "Make it the project's active goal." },
				project: PROJECT,
			},
			["title"],
		),
		hints: WRITE,
		run(a, c) {
			const g = addGoal(c.db, { project: projectOf(c, a.project)!, title: a.title, body: a.description, due: a.due, active: a.active });
			const info = goalsWithStats(c.db, { project: g.project }).find((x) => x.id === g.id)!;
			return { text: `Added goal ${goalLine(info, yourName(c.db))}`, data: { goal: goalJson(info) } };
		},
	},
	{
		name: "update_goal",
		title: "Update a goal",
		description:
			"Changes a goal: title, description, target date, status (done when it's reached, dropped when it's off), whether it's the active goal, or its place among the project's open goals.",
		input: obj(
			{
				goal: { ...GOAL_REF, description: "The goal: its number (see list_goals) or its exact title." },
				title: str("New title.", { minLength: 1, maxLength: 200 }),
				description: str("Replaces the description (markdown)."),
				due: str('Target date, YYYY-MM-DD; "" removes it.'),
				status: { type: "string", enum: GOAL_STATUSES },
				active: { type: "boolean", description: "true makes it the project's active goal." },
				position: { type: "integer", minimum: 1, description: "Its place among the project's open goals, 1 = first." },
				project: PROJECT,
			},
			["goal"],
		),
		hints: { ...WRITE, idempotentHint: true },
		run(a, c) {
			const project = a.project !== undefined ? projectOf(c, a.project) : projectOf(c, undefined, false);
			let id: number;
			try {
				id = needGoal(c.db, a.goal, project);
			} catch (e) {
				throw new ToolError((e as Error).message);
			}
			const g = updateGoal(c.db, id, { title: a.title, body: a.description, due: a.due, status: a.status, active: a.active, position: a.position });
			const info = goalsWithStats(c.db, { project: g.project }).find((x) => x.id === g.id)!;
			return { text: `Updated goal ${goalLine(info, yourName(c.db))}`, data: { goal: goalJson(info) } };
		},
	},
	{
		name: "integration_guide",
		title: "Wire a project into the workbench",
		description:
			"How to set a project up so every agent in it uses the workbench, and what's already done: the project on the board, the standard rules block in its AGENTS.md or CLAUDE.md (versioned, so running it again updates it), and Claude Code's MCP server and permissions. Follow the steps it gives; it says which ones to ask {{name}} about first. Same as `wb integrate`.",
		input: obj({
			folder: str("The project's folder (absolute). Default: the given project's folder, else the folder this server runs in."),
			project: str("Project slug, to use its folder."),
		}),
		hints: RO,
		run(a, c) {
			let dir = a.folder?.trim() || "";
			if (!dir && a.project) dir = projects(c.db).find((p) => p.slug === projectOf(c, a.project))?.path ?? "";
			if (!dir && c.project) dir = projects(c.db).find((p) => p.slug === c.project)?.path ?? "";
			if (!dir && c.transport === "stdio") dir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
			if (!dir) throw new ToolError("which folder? Pass folder (the project's absolute path) or project");
			return { text: integrationGuide(c.db, dir) };
		},
	},
	{
		name: "search",
		title: "Search the workbench",
		description: "Finds items (titles, details, notes, refs), reports (by their text) and links matching words, in one project or all of them.",
		input: obj({ q: str("What to look for.", { minLength: 1 }), project: str('Project slug, or "*" for every project (default: the current project, else all).') }, ["q"]),
		hints: RO,
		run(a, c) {
			const project = projectOf(c, a.project, false);
			const r = search(c.db, a.q.trim(), project);
			const text = [
				`items (${r.items.length}):`,
				...r.items.map((i) => `- ${itemLine(c, i, !project)}`),
				`reports (${r.reports.length}):`,
				...r.reports.map((x) => `- #${x.id} ${x.title} [${x.project}]${x.snippet ? `: ${x.snippet}` : ""}`),
				`links (${r.links.length}):`,
				...(r.links as { label: string; url: string }[]).map((l) => `- ${l.label}: ${l.url}`),
				...(r.goals.length ? [`goals (${r.goals.length}):`, ...r.goals.map((g) => `- #${g.id} ${g.title} [${g.project}]${g.status === "open" ? "" : ` (${g.status})`}${g.due ? ` ${dueText(g.due)}` : ""}`)] : []),
			].join("\n");
			return { text, data: { items: r.items.map(itemJson), reports: r.reports, links: r.links, goals: r.goals.map(({ id, project, title, status, due }) => ({ id, project, title, status, due: due || undefined })) } };
		},
	},
	{
		name: "list_items",
		title: "List items",
		description:
			"Items of a project (default: open ones, the current project), most urgent first: doing, todo, waiting, then by priority, and within that what holds up the most waiting work (unblocks). Filter by who acts, kind, status or words.",
		input: obj({
			project: str('Project slug, or "*" for every project. Default: the current project.'),
			owner: { type: "string", enum: OWNERS, description: "Who has to act: kostas ({{name}}) or agent." },
			kind: { type: "string", enum: KINDS },
			status: {
				anyOf: [
					{ type: "string", enum: ["open", "all", ...STATUSES] },
					{ type: "array", items: { type: "string", enum: STATUSES } },
				],
				description: 'open (todo, doing, waiting; the default), all, one status, or a list.',
			},
			q: str("Words to look for in titles, details and notes, or a ref."),
			goal: { ...GOAL_REF, description: 'Only items on this goal: its number or exact title; "none" for items on no goal.' },
			limit: { type: "integer", minimum: 1, maximum: 500, description: "At most this many (default 50)." },
		}),
		hints: RO,
		run(a, c) {
			const project = a.project === "*" ? undefined : projectOf(c, a.project, false);
			const status: Status[] =
				a.status === undefined || a.status === "open" ? OPEN : a.status === "all" ? [] : ([] as Status[]).concat(a.status);
			let goal: number | "none" | undefined;
			if (a.goal !== undefined) goal = String(a.goal).trim().toLowerCase() === "none" ? "none" : goalArg(c, a.goal, project)!;
			const all = listItems(c.db, { project, owner: a.owner, kind: a.kind, status, q: a.q, goal: goal === null ? undefined : goal });
			const items = all.slice(0, a.limit ?? 50);
			const head = `${all.length} item${all.length === 1 ? "" : "s"}${project ? ` in ${project}` : ""}${all.length > items.length ? ` (first ${items.length})` : ""}`;
			return { text: [head, ...items.map((i) => `- ${itemLine(c, i, !project)}`)].join("\n"), data: { total: all.length, items: items.map(itemJson) } };
		},
	},
	{
		name: "get_item",
		title: "Get an item",
		description: "One item with its details, choices, answer, what it waits on, what waits on it, and full history. When a prompt names an item, read it first: its body and notes are the brief.",
		input: obj({ ref: REF }, ["ref"]),
		hints: RO,
		run(a, c) {
			const i = getItem(c.db, itemId(c, a.ref))!;
			return { text: itemText(c, i), data: { item: { ...itemJson(i), body: i.body, sources: i.sources || undefined, images: i.images.length ? i.images.map(({ id, caption, width, height }) => ({ id, caption, width, height })) : undefined, notes: i.notes.map(({ at, author, text }) => ({ at, author, text })), waits_on: i.waits_on.length ? i.waits_on.map(linkJson) : undefined, blocks: i.blocks.length ? i.blocks.map(linkJson) : undefined, check_run: runData(c.db, i.id), run: runJson(c.db, i.id) } }, links: [itemLink(i)] };
		},
	},
	{
		name: "add_item",
		title: "Add an item",
		description:
			`Files a new item. kind: task or bug (code work), check ({{name}} tries it on a device), review (something only {{name}} can judge), decision (a question only {{name}} can answer), setup (accounts, consoles, stores), notice (what changed; doesn't wait on {{name}}), idea. Returns the new wb-xxxx, what goes ahead if {{name}} says nothing, and warnings.\nAsk only what you can't decide. A decision needs recommended (it becomes the default; no options: give default) unless it's priority 1; related questions → one decision, pick "many". Changed something → a notice, not a review.\n\n${BRIEF_RULES}`,
		input: obj(
			{
				title: str("Short, specific and in plain words: what to do or decide, as {{name}} would say it.", { minLength: 1, maxLength: 300 }),
				kind: { type: "string", enum: KINDS, description: "Default task (decision when options are given)." },
				owner: { type: "string", enum: OWNERS, description: "Who has to act: kostas ({{name}}) or agent. Default by kind: {{owner-defaults}}" },
				project: PROJECT,
				priority: { type: "integer", enum: [1, 2, 3], description: "1 launch blocker, 2 before launch (default), 3 later." },
				area: str("A short area tag, e.g. billing."),
				body: str("The whole brief, in markdown (- and 1. lists, indent to nest, **bold**, # headings, > quotes, `code`, ``` blocks, [links](https://…)). Required for anything {{name}} has to act on: they don't open files."),
				images: {
					type: "array",
					maxItems: 12,
					description: "Screenshots to show on the item, in this order.",
					items: obj({ ...IMAGE_SOURCE, caption: CAPTION }, ["caption"]),
				},
				options: { type: "array", items: { type: "string", minLength: 1 }, maxItems: 12, description: "The choices of a decision; {{name}} answers with one click (or ticks several, with pick many)." },
				...ASK_PARAMS,
				branch: str("The git branch the work is on."),
				source: str('Where it came from, e.g. "src/app.ts:42".'),
				status: { type: "string", enum: STATUSES, description: "Default todo." },
				blocks: str("An item of yours that waits on this new one, e.g. wb-k3f9: it goes to waiting, and back to todo by itself when this is answered, finished or dropped. This is how you file a question or a check for {{name}} and wait on it in one call."),
				waits_on: { type: "array", items: { type: "string", minLength: 1 }, maxItems: 12, description: "Items this new one waits on (wb-xxxx): it is filed as waiting, and goes to todo when they're all answered, finished or dropped." },
				goal: { ...GOAL_REF, description: "The goal this item serves: its number (see list_goals) or its exact title. Attach what you file to the goal it serves." },
			},
			["title"],
		),
		hints: WRITE,
		async run(a, c) {
			const project = projectOf(c, a.project)!;
			const blocked: number | undefined = a.blocks ? itemId(c, a.blocks) : undefined;
			let filed: Filed;
			try {
				filed = await fileItem(c.db, {
					item: {
						title: a.title,
						kind: a.kind,
						// Without one, the board's setting for the kind.
						owner: a.owner,
						project,
						goal_id: goalArg(c, a.goal, project),
						priority: a.priority,
						area: a.area,
						body: a.body,
						options: a.options,
						...askPatch(a),
						branch: a.branch,
						sources: a.source,
						status: a.status,
					},
					author: "agent",
					byAgent: true,
					attach: ATTACH,
					images: { count: a.images?.length ?? 0, read: () => readImages(a.images) },
					waitsOn: (a.waits_on ?? []).map((r: string) => itemId(c, r)),
					blocks: blocked,
				});
			} catch (e) {
				throw new ToolError((e as Error).message);
			}
			const { id, repeats } = filed;
			const out = changed(c, id, blocked !== undefined ? `Added (wb-${getItem(c.db, blocked)!.ref} now waits on it)` : "Added", filed.warnings);
			if (filed.goesAhead) {
				out.text += `\n\n${filed.goesAhead}`;
				out.data = { ...out.data, goes_ahead: filed.goesAhead };
			}
			// An ask that looks like one already answered: saved all the same, with the ruling it may repeat.
			if (repeats.length) {
				out.text += `\n\n${repeatWarning(repeats, yourName(c.db))}`;
				out.data = { ...out.data, already_ruled: repeats.map((m) => ({ ...rulingJson(m.ruling), score: m.score })) };
			}
			return out;
		},
	},
	{
		name: "update_item",
		title: "Update an item",
		description: "Changes an item's fields; the change is recorded in its history. To change status with a reason, prefer start_item, wait_item, finish_item or drop_item.",
		input: obj(
			{
				ref: REF,
				title: str("New title.", { minLength: 1, maxLength: 300 }),
				kind: { type: "string", enum: KINDS },
				owner: { type: "string", enum: OWNERS },
				status: { type: "string", enum: STATUSES },
				priority: { type: "integer", enum: [1, 2, 3] },
				area: str("Area tag."),
				body: str("Replaces the details (markdown)."),
				options: { type: "array", items: { type: "string", minLength: 1 }, maxItems: 12, description: "Replaces a decision's choices." },
				...ASK_PARAMS,
				branch: str("Git branch."),
				project: str("Move it to this project (slug)."),
				goal: GOAL_REF,
				note: str("Also add this note to the history."),
				waits_on: { type: "array", items: { type: "string", minLength: 1 }, maxItems: 12, description: "Items (wb-xxxx) it now also waits on: it becomes waiting, and goes back to todo when all of them are answered, finished or dropped." },
				not_waiting_on: { type: "array", items: { type: "string", minLength: 1 }, maxItems: 12, description: "Items (wb-xxxx) it no longer waits on. Without any left it stays waiting until you change its status." },
			},
			["ref"],
		),
		hints: { ...WRITE, idempotentHint: true },
		run(a, c) {
			const id = itemId(c, a.ref);
			let patch: ItemPatch = askPatch(a);
			for (const k of ["title", "kind", "owner", "status", "priority", "area", "body", "options", "branch"] as const)
				if (a[k] !== undefined) (patch as Json)[k] = a[k];
			if (a.project !== undefined) patch.project = projectOf(c, a.project)!;
			if (a.goal !== undefined) patch.goal_id = goalArg(c, a.goal, patch.project ?? getItem(c.db, id)!.project);
			// Handing an item to {{name}}, or making it an ask, is filing one: the same rules (filing.ts).
			let gave = false;
			try {
				({ patch, gave } = checkChange(c.db, getItem(c.db, id)!, patch, true));
			} catch (e) {
				throw new ToolError((e as Error).message);
			}
			if (a.waits_on?.length) waitOn(c.db, id, a.waits_on.map((r: string) => itemId(c, r)), "agent");
			if (a.not_waiting_on?.length) removeLinks(c.db, id, a.not_waiting_on.map((r: string) => itemId(c, r)));
			updateItem(c.db, id, patch, "agent", a.note ?? "");
			const i = getItem(c.db, id)!;
			// A status change or a note says nothing new about the brief; rewording it does.
			const reworded = a.title !== undefined || a.body !== undefined || a.kind !== undefined || a.owner !== undefined;
			const brief = reworded ? checkBrief(i, { name: yourName(c.db), images: i.images.length, attach: ATTACH }) : { warnings: [] };
			const out = changed(c, id, "Updated", brief.refuse ? [brief.refuse.replace(" Nothing was filed.", "")] : brief.warnings);
			const said = changeText(c.db, id, gave);
			if (said) out.text += `\n\n${said}`;
			return out;
		},
	},
	{
		name: "attach_image",
		title: "Attach a screenshot",
		description:
			"Puts a picture on an item, where {{name}} sees it right under the details. For anything on screen: a bug, a layout, a wording in place, before and after. It needs a file: `adb exec-out screencap -p > shot.png` on Android, Playwright's page.screenshot({ path }) or `chromium --headless --screenshot=shot.png <url>` on the web. A browser tool's screenshot works if its result names a file.",
		input: obj({ ref: REF, ...IMAGE_SOURCE, caption: CAPTION }, ["ref", "caption"]),
		hints: WRITE,
		async run(a, c) {
			const id = itemId(c, a.ref);
			const { bytes, label } = imageBytes(a);
			const image = await prepareImage(bytes, label);
			const n = addImage(c.db, id, image, a.caption, "agent");
			return changed(c, id, `Image ${n} (${Math.round(image.data.length / 1024)} KB) added to`);
		},
	},
	{
		name: "get_image",
		title: "See an item's screenshot",
		description: "Shows you a picture attached to an item. get_item lists them, with their ids and captions.",
		input: obj({ id: { type: "integer", description: "The image's id, from get_item." } }, ["id"]),
		hints: RO,
		run(a, c) {
			const info = imageInfo(c.db, a.id);
			const row = imageData(c.db, a.id);
			if (!info || !row) throw new ToolError(`no image ${a.id}`);
			return { text: imageSummary(info), image: { data: Buffer.from(row.data).toString("base64"), mimeType: row.type } };
		},
	},
	{
		name: "remove_image",
		title: "Remove a screenshot",
		description: "Takes a picture off an item, such as one that's wrong or out of date. Attach the right one with attach_image. The item's history keeps a line saying so.",
		input: obj({ id: { type: "integer", description: "The image's id, from get_item." } }, ["id"]),
		hints: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
		run(a, c) {
			if (!imageInfo(c.db, a.id)) throw new ToolError(`no image ${a.id}`);
			return changed(c, removeImage(c.db, a.id, "agent"), `Image ${a.id} removed from`);
		},
	},
	{
		name: "start_item",
		title: "Start an item",
		description: "Marks an item as being worked on (doing) and links it to this agent session, so the board can point back to it. Do this when you pick up work.",
		input: obj({ ref: REF, branch: str("The branch you work on."), session: str("The desktop-app session id (default: the one this server runs in).") }, ["ref"]),
		hints: { ...WRITE, idempotentHint: true },
		run(a, c) {
			const id = itemId(c, a.ref);
			const session = a.session ?? c.session;
			updateItem(c.db, id, { status: "doing", ...(a.branch ? { branch: a.branch } : {}), ...(session ? { session } : {}) }, "agent");
			return changed(c, id, "Started");
		},
	},
	{
		name: "wait_item",
		title: "Mark an item waiting",
		description:
			"The work is blocked: says on what (a review, an answer, a deploy). It shows as waiting on the board. When it waits on another item (above all something {{name}} has to answer, check or review: file it with add_item, or use add_item's blocks to do both at once), pass it as on: the board puts this item back to todo by itself, with the answer in its history, when that item is answered, finished or dropped. Without on, nothing resumes it: {{name}} or you have to.",
		input: obj(
			{
				ref: REF,
				reason: str("What it waits on, in a few words.", { minLength: 1 }),
				on: { type: "array", items: { type: "string", minLength: 1 }, minItems: 1, maxItems: 12, description: "The items it waits on (wb-xxxx). When there are several it resumes once all of them are dealt with." },
			},
			["ref", "reason"],
		),
		hints: WRITE,
		run(a, c) {
			const id = itemId(c, a.ref);
			if (a.on?.length) waitOn(c.db, id, a.on.map((r: string) => itemId(c, r)), "agent");
			else updateItem(c.db, id, { status: "waiting" }, "agent");
			addNote(c.db, id, a.reason.trim(), "agent");
			return changed(c, id, "Waiting:");
		},
	},
	{
		name: "finish_item",
		title: "Finish an item",
		description: "Marks an item done. The note says what changed and where (commit, branch, PR). File anything left over as new items. Whatever waited on this item goes back to todo, with this note in its history.",
		input: obj({ ref: REF, note: str('What changed and where, e.g. "a1b2c3d on main: …".') }, ["ref"]),
		hints: WRITE,
		run(a, c) {
			const id = itemId(c, a.ref);
			updateItem(c.db, id, { status: "done" }, "agent", a.note ?? "");
			return changed(c, id, "Done:");
		},
	},
	{
		name: "drop_item",
		title: "Drop an item",
		description: "Won't be done: closes the item as dropped, with why. It stays in the history (unless Kostas has the board remove closed items after a while).",
		input: obj({ ref: REF, reason: str("Why it's dropped.") }, ["ref"]),
		hints: WRITE,
		run(a, c) {
			const id = itemId(c, a.ref);
			updateItem(c.db, id, { status: "dropped" }, "agent", a.reason ?? "");
			return changed(c, id, "Dropped:");
		},
	},
	{
		name: "add_note",
		title: "Add a note",
		description: "Adds a line to an item's history: progress, a result, a finding, or {{name}}'s own words when they report or decide something in the conversation.",
		input: obj({ ref: REF, text: str("The note. With more than one line it shows as markdown, so it can hold a list.", { minLength: 1 }) }, ["ref", "text"]),
		hints: WRITE,
		run(a, c) {
			const id = itemId(c, a.ref);
			addNote(c.db, id, a.text.trim(), "agent");
			return changed(c, id, "Noted on");
		},
	},
	{
		name: "answer_decision",
		title: "Record {{name}}'s answer",
		description:
			'Records the answer to a decision and hands it back to the agents. Only with an answer {{name}} gave in the conversation: never decide for them. answer is one of the item\'s options (or its number) or their own words; for a pick-"many" decision, a list of the options they picked ([] for none of them).',
		input: obj(
			{
				ref: REF,
				answer: {
					anyOf: [{ type: "string", minLength: 1 }, { type: "array", items: { type: "string", minLength: 1 }, maxItems: 12 }],
					description: "{{name}}'s answer: an option, its number, their words, or a list of options.",
				},
			},
			["ref", "answer"],
		),
		hints: { ...WRITE, idempotentHint: true },
		run(a, c) {
			const id = itemId(c, a.ref);
			answerItem(c.db, id, a.answer, "agent");
			const out = changed(c, id, "Answered");
			const r = itemRulings(c.db, id).find((x) => x.origin === "answer");
			if (r) out.text += `\n\nIts ruling: ${rulingLine(r)}${r.drafted ? `. Rewrite it as one clear line with update_ruling (id ${r.id}).` : ""}`;
			return out;
		},
	},
	{
		name: "list_rulings",
		title: "List rulings",
		description:
			"{{name}}'s rulings: standing answers in a project, one line each, with the item each came from. Read them before you ask {{name}} anything (a decision, a review), and follow them in your work. Words in q match with or without accents.",
		input: obj({
			project: str('Project slug, or "*" for every project. Default: the current project.'),
			q: str("Words to look for in the rulings and the questions they answer."),
			retired: { type: "boolean", description: "List the retired ones instead (no longer hold)." },
		}),
		hints: RO,
		run(a, c) {
			const project = a.project === "*" ? undefined : projectOf(c, a.project, false);
			const list = listRulings(c.db, { project, q: a.q, retired: a.retired === true });
			const head = `${list.length} ${a.retired ? "retired " : ""}ruling${list.length === 1 ? "" : "s"}${project ? ` in ${project}` : ""}`;
			return { text: [head, ...list.map((r) => `- ${rulingLine(r, !project)}`)].join("\n"), data: { rulings: list.map(rulingJson) } };
		},
	},
	{
		name: "add_ruling",
		title: "Add a ruling",
		description:
			"Writes down one of {{name}}'s standing answers for a project, as one line in plain words (\"Traditional is the default melisma style\"). Only what {{name}} decided, in the conversation or in an answer: never your own preference. item names where it was decided.",
		input: obj(
			{
				text: str("The rule, one line in plain words, as {{name}} would say it.", { minLength: 1, maxLength: 400 }),
				project: PROJECT,
				item: str("The item it was decided in, e.g. wb-k3f9."),
			},
			["text"],
		),
		hints: WRITE,
		run(a, c) {
			const project = projectOf(c, a.project)!;
			const id = addRuling(c.db, { project, text: a.text, item: a.item ? itemId(c, a.item) : undefined }, "agent");
			const r = getRuling(c.db, id)!;
			return { text: `Added ruling ${rulingLine(r)}`, data: { ruling: rulingJson(r) } };
		},
	},
	{
		name: "update_ruling",
		title: "Rewrite a ruling",
		description:
			"Rewrites a ruling (it then no longer counts as a draft), or moves it to another project or item. Use it to turn a drafted ruling (\"<question>: <answer>\") into one clear line that stands by itself, in {{name}}'s meaning: never change what was decided.",
		input: obj(
			{
				id: { type: "integer", minimum: 1, description: "The ruling's id (list_rulings)." },
				text: str("The new line.", { minLength: 1, maxLength: 400 }),
				project: str("Move it to this project (slug)."),
				item: str('The item it came from, e.g. wb-k3f9 ("" for none).'),
			},
			["id"],
		),
		hints: { ...WRITE, idempotentHint: true },
		run(a, c) {
			const id = rulingId(c, a.id);
			const r = updateRuling(
				c.db,
				id,
				{ text: a.text, project: a.project !== undefined ? projectOf(c, a.project) : undefined, item: a.item === undefined ? undefined : a.item.trim() ? itemId(c, a.item) : null },
				"agent",
			);
			return { text: `Updated ruling ${rulingLine(r)}`, data: { ruling: rulingJson(r) } };
		},
	},
	{
		name: "retire_ruling",
		title: "Retire a ruling",
		description: "Takes a ruling out of use when it no longer holds: {{name}} changed their mind, or what it was about is gone. It's kept, with the retired ones.",
		input: obj({ id: { type: "integer", minimum: 1, description: "The ruling's id (list_rulings)." } }, ["id"]),
		hints: { ...WRITE, idempotentHint: true },
		run(a, c) {
			const r = retireRuling(c.db, rulingId(c, a.id), "agent");
			return { text: `Retired ruling ${rulingLine(r)}`, data: { ruling: rulingJson(r) } };
		},
	},
	{
		name: "list_reports",
		title: "List reports",
		description: "Report pages published to the board (HTML pages in a project's sidebar), with versions. Day reports (one per work day) are left out unless asked for.",
		input: obj({ project: str('Project slug, or "*" for every project. Default: the current project.'), include_days: { type: "boolean", description: "Include the day-YYYY-MM-DD pages." } }),
		hints: RO,
		run(a, c) {
			const project = a.project === "*" ? undefined : projectOf(c, a.project, false);
			const list = listReports(c.db, project).filter((r) => a.include_days || !r.name.startsWith("day-"));
			return {
				text: list.length
					? list.map((r) => `#${r.id} ${r.project}/${r.name}: ${r.title}${r.grp ? ` [${r.grp}]` : ""}${r.icon || r.name.startsWith("day-") ? "" : " (no icon: give it one)"} v${r.version}, updated ${r.updated_at} · ${BOARD}/#report/${r.id}`).join("\n")
					: "no reports",
				data: { reports: list.map((r) => ({ ...r, url: `${BOARD}/#report/${r.id}` })) },
			};
		},
	},
	{
		name: "read_report",
		title: "Read a report",
		description: "A report's content: its visible text (default) or its HTML. Pages drawn by script have little text; ask for html then.",
		input: obj(
			{
				report: { anyOf: [{ type: "integer", minimum: 1 }, { type: "string", minLength: 1 }], description: "The report's id (#12) or its name in the project." },
				project: PROJECT,
				version: { type: "integer", minimum: 1, description: "A version (default: the latest)." },
				format: { type: "string", enum: ["text", "html"], description: "Default text." },
			},
			["report"],
		),
		hints: RO,
		run(a, c) {
			const id = reportId(a, c);
			const r = getReport(c.db, id);
			const page = r && reportHtml(c.db, id, a.version);
			if (!r || !page) throw new ToolError(`no report #${id}${a.version ? ` v${a.version}` : ""}`);
			const MAX = 60_000;
			let body = a.format === "html" ? page.html : htmlText(page.html);
			const cut = body.length > MAX;
			if (cut) body = body.slice(0, MAX);
			const head = `#${r.id} ${r.title} · ${r.project} · v${page.n} of ${r.version} · ${BOARD}/#report/${r.id}`;
			const hint = a.format !== "html" && body.length < 200 && /<script/i.test(page.html) ? "\n(the page is drawn by script; read it with format html)" : "";
			return {
				text: `${head}\n\n${body}${cut ? `\n\n[cut at ${MAX} characters]` : ""}${hint}`,
				links: [{ uri: `wb://report/${r.id}`, name: r.name, title: r.title, mimeType: "text/html" }],
			};
		},
	},
	{
		name: "publish_report",
		title: "Publish a report",
		description:
			"Publishes a self-contained HTML page to a project's sidebar; the same name again adds a version. The page runs sandboxed and gets a `wb` object to read the board (wb.items(), wb.trackers(), wb.git(), wb.fetch(source, path), wb.state…). Use var(--wb-bg), --wb-ink, --wb-accent… to match the board. Every report needs its own icon: give one the first time.",
		input: obj(
			{
				name: str("Short name, unique in the project (e.g. release-status).", { minLength: 1, maxLength: 80 }),
				html: str("The whole page.", { minLength: 1 }),
				title: str("Shown in the sidebar (default: the page's <title>)."),
				group: str("A heading in the sidebar to file it under."),
				icon: { ...REPORT_ICON, description: `${REPORT_ICON.description} Needed the first time; left out later, the icon stays as it is.` },
				project: PROJECT,
			},
			["name", "html"],
		),
		hints: { ...WRITE, idempotentHint: true },
		run(a, c) {
			const project = projectOf(c, a.project)!;
			if (reportLeftWithoutIcon(c.db, project, String(a.name), a.icon))
				throw new ToolError("every report needs its own icon in the sidebar: pass icon (one emoji, or a small SVG in its own colours). Nothing was published.");
			const r = publishReport(c.db, { project, name: a.name, html: a.html, title: a.title, grp: a.group, icon: a.icon }, "agent");
			return {
				text: `report #${r.id} v${r.n}${r.changed ? "" : " (unchanged)"} in ${project}: ${BOARD}/#report/${r.id}`,
				data: { id: r.id, version: r.n, changed: r.changed, url: `${BOARD}/#report/${r.id}` },
				links: [{ uri: `wb://report/${r.id}`, name: a.name, mimeType: "text/html" }],
			};
		},
	},
	{
		name: "set_report_icon",
		title: "Set a report's icon",
		description:
			"Sets the icon a published report shows in the sidebar, in place of the usual page glyph: to give one to a report that has none, or a better one. No new version is added.",
		input: obj(
			{
				report: { anyOf: [{ type: "integer", minimum: 1 }, { type: "string", minLength: 1 }], description: "The report's id (#12) or its name in the project." },
				icon: { ...REPORT_ICON, minLength: 1 },
				project: PROJECT,
			},
			["report", "icon"],
		),
		hints: { ...WRITE, idempotentHint: true },
		run(a, c) {
			if (!String(a.icon ?? "").trim()) throw new ToolError("every report keeps an icon: give another one instead of removing it");
			const id = reportId(a, c);
			const icon = setReportIcon(c.db, id, a.icon);
			return { text: `report #${id}: ${icon ? "icon set" : "icon removed"} · ${BOARD}/#report/${id}`, data: { id, icon } };
		},
	},
	{
		name: "add_link",
		title: "Add a link",
		description: "Adds a bookmark to a project's sidebar (or every project's), optionally in a group: a console, a dashboard, a deployed page.",
		input: obj(
			{
				label: str("What it is.", { minLength: 1, maxLength: 120 }),
				url: str("http(s) address.", { minLength: 1 }),
				project: str('Project slug, or "*" for every project. Default: the current project.'),
				group: str("A group to file it under."),
			},
			["label", "url"],
		),
		hints: WRITE,
		run(a, c) {
			const project = a.project === "*" ? "" : projectOf(c, a.project)!;
			const id = addLink(c.db, { label: a.label, url: a.url, project, grp: a.group });
			return { text: `link #${id} added to ${project || "every project"}${a.group ? ` (${a.group})` : ""}: ${a.label}`, data: { id } };
		},
	},
	{
		name: "vault_list",
		title: "List vault secrets",
		description:
			"The names and notes of the secrets in {{name}}'s vault that a project may use (its own and those for every project), never a value. {{name}} has to allow it: a window on their computer shows your reason and asks for the vault password, and this call waits for the answer (up to 2 minutes). Use it to learn a secret's exact name for vault_get, once per session at most. When {{name}} says no, don't ask again unless they tell you to.",
		input: obj(
			{
				reason: str('Why you need them, in one sentence {{name}} reads in the window, e.g. "to find the Cloudflare token for the deploy".', { minLength: 3, maxLength: 300 }),
				project: str('Project slug, or "*" for every project\'s secrets. Default: the current project.'),
			},
			["reason"],
		),
		hints: RO,
		async run(a, c) {
			const project = projectOf(c, a.project, false);
			return listReply(await listForAgent({ db: c.db, project, session: c.session }, a.reason), project);
		},
	},
	{
		name: "vault_get",
		title: "Get vault secrets",
		description:
			"Secrets from {{name}}'s vault, by name (vault_list shows the names), after {{name}} allows it: a window on their computer lists the names you ask for and your reason, and asks for the vault password. This call waits for the answer (up to 2 minutes). Ask for everything one task needs in one call: each call is a new window.\n\nBy default (deliver \"file\") the values go into a private .env file, readable only by this user and deleted after 15 minutes, and you get its path, not the values, so they stay out of this conversation: use it as `set -a; . <path>; set +a` before a command, or a tool's --env-file. Never print, echo, cat or copy the values into files, commits or messages. deliver \"text\" returns the values in the reply instead: only when you must put a value somewhere yourself, and {{name}} sees that in the window.\n\nNever ask {{name}} to paste a secret into the chat: use this. When they say no, don't ask again unless they tell you to.",
		input: obj(
			{
				names: { type: "array", items: str("A secret's name, e.g. CLOUDFLARE_API_TOKEN.", { minLength: 1, maxLength: 200 }), minItems: 1, maxItems: 20, description: "The secrets you need, by name." },
				reason: str('Why you need them, in one sentence {{name}} reads in the window, e.g. "to deploy the worker with wrangler".', { minLength: 3, maxLength: 300 }),
				deliver: { type: "string", enum: ["file", "text"], description: 'file (default): a private .env file, deleted after 15 minutes; you get its path. text: the values in the reply.' },
				project: str('Project slug, or "*" to look in every project. Default: the current project (its own secrets win over those for every project).'),
			},
			["names", "reason"],
		),
		hints: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
		async run(a, c) {
			const project = projectOf(c, a.project, false);
			const deliver: Delivery = a.deliver ?? "file";
			return getReply(await getForAgent({ db: c.db, project, session: c.session }, a.names, a.reason, deliver));
		},
	},
	{
		name: "list_trackers",
		title: "List status trackers",
		description:
			"Status trackers and their current readings: quotas and allowances (e.g. EAS builds used this month per platform, GitHub Actions minutes left) or states. Each meter has a level (ok, warn, bad). A project's trackers come with the global ones.",
		input: obj({ project: str('Project slug, or "*" for every tracker. Default: the current project (else all).') }),
		hints: RO,
		run(a, c) {
			const project = a.project === "*" ? undefined : projectOf(c, a.project, false);
			const list = listTrackers(c.db, project);
			return {
				text: list.length ? list.map(trackerBlock).join("\n") : "no trackers (define_tracker adds one)",
				data: { trackers: list.map(trackerJson) },
			};
		},
	},
	{
		name: "get_tracker",
		title: "Get a tracker",
		description: "One tracker: its reading, levels, how and how often it reads, the last error, and its recent history (each change of reading).",
		input: obj({ tracker: TRACKER, project: PROJECT, history: { type: "integer", minimum: 0, maximum: 500, description: "How many past readings (default 20)." } }, ["tracker"]),
		hints: RO,
		run(a, c) {
			const t = resolveTracker(c.db, a.tracker, projectOf(c, a.project, false));
			const history = a.history === 0 ? [] : trackerHistory(c.db, t.id, a.history ?? 20);
			const lines = [
				trackerBlock(t),
				t.error ? `  last error (${t.checked_at} UTC): ${t.error}` : "",
				t.stale ? "  stale: it hasn't read for three intervals" : "",
				history.length ? "history:" : "",
				...history.map((h) => `  ${h.at}  ${h.reading.meters.map((m) => meterText({ ...m, level: "" })).join(" · ")}${h.author ? ` (${h.author})` : ""}`),
			];
			return { text: lines.filter(Boolean).join("\n"), data: { tracker: trackerJson(t), history } };
		},
	},
	{
		name: "record_tracker",
		title: "Record a tracker reading",
		description:
			'Records a reading of a manual tracker (one that doesn\'t read itself). reading is text like "12/15", one meter per line ("Android 12/15\\niOS 3/15"), "In review", or a list of meters.',
		input: obj(
			{
				tracker: TRACKER,
				project: PROJECT,
				reading: { anyOf: [{ type: "string", minLength: 1 }, { type: "array", items: METER, minItems: 1, maxItems: 12 }] },
				note: str("One short line shown under the meters."),
				resets_at: str("When the allowance starts over (ISO date)."),
			},
			["tracker", "reading"],
		),
		hints: WRITE,
		run(a, c) {
			const t = resolveTracker(c.db, a.tracker, projectOf(c, a.project, false));
			const after = recordReading(c.db, t.id, readingFrom(a as { reading: string | Meter[] }), "agent");
			return { text: trackerBlock(after), data: { tracker: trackerJson(after) } };
		},
	},
	{
		name: "refresh_trackers",
		title: "Refresh trackers",
		description:
			"Reads trackers now instead of at their next interval: one, or every self-reading tracker of a project and the global ones. Takes a few seconds each (they call CLIs and APIs). Do it after something that changes a reading, like an EAS build.",
		input: obj({ tracker: TRACKER, project: str('Project slug, or "*" for every tracker. Default: the current project.') }),
		hints: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
		async run(a, c) {
			const project = a.project === "*" ? undefined : projectOf(c, a.project, false);
			const list = a.tracker ? [resolveTracker(c.db, a.tracker, project)] : listTrackers(c.db, project).filter((t) => t.kind !== "manual");
			if (!list.length) return { text: "no self-reading trackers here (manual ones take record_tracker)" };
			if (list.some((t) => t.kind === "manual")) throw new ToolError(`${list[0].ref} is manual: use record_tracker`);
			const results = await Promise.allSettled(list.map((t) => refreshTracker(c.db, t.id, "agent")));
			const done = results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
			const failed = results.flatMap((r, i) => (r.status === "rejected" ? [`${list[i].ref}: ${(r.reason as Error).message}`] : []));
			return { text: [...done.map(trackerBlock), ...failed].join("\n"), data: { trackers: done.map(trackerJson) } };
		},
	},
	{
		name: "define_tracker",
		title: "Define a tracker",
		description: `Adds a status tracker, or changes the one with that name. How it reads (kind):
- manual: someone records readings (record_tracker).
- command: a shell command the board runs every interval in the project folder; what it prints is the reading ("12/15", "Android 12/15" per line, or JSON {value, max, unit, label} / [meters] / {meters, note, resets_at, url}). It runs on {{name}}'s computer on a schedule: only add one {{name}} asked for.
- ${Object.entries(PRESETS)
			.map(([k, p]) => `${k}: ${p.about}. params: ${Object.entries(p.options).map(([o, d]) => `${o} (${d.about})`).join("; ")}`)
			.join("\n- ")}
Meters with a max warn at 75% and turn bad at 90% unless warn/bad say otherwise ("<20%" or bad below warn when low is bad). Self-reading trackers are read right away.`,
		input: obj(
			{
				name: str("lowercase-with-dashes, unique in its project, e.g. eas-builds.", { minLength: 1, maxLength: 40 }),
				title: str("Shown on the board."),
				project: PROJECT,
				global: { type: "boolean", description: "Shown with every project instead of one." },
				kind: { type: "string", enum: TRACKER_KINDS, description: "Default: command when a command is given, else manual." },
				command: str("For kind command: the shell command."),
				params: { type: "object", additionalProperties: true, description: "A preset's options, as strings." },
				every: { anyOf: [{ type: "string" }, { type: "integer", minimum: 0 }], description: 'How often the board reads it: "15m", "2h", "1d", "off", or seconds. Default 1h.' },
				max: { anyOf: [{ type: "number", minimum: 0 }, { type: "null" }], description: "Default allowance for meters that don't give one." },
				unit: str("Default unit for its meters."),
				warn: str('Where warn starts: "75%" (of max) or a number; "<20%" when low is bad.'),
				bad: str('Where bad starts, same form as warn.'),
				url: str("A page with the details, linked from the board."),
			},
			["name"],
		),
		hints: { ...WRITE, idempotentHint: true, openWorldHint: true },
		async run(a, c) {
			const project = a.global ? "" : projectOf(c, a.project)!;
			const patch: TrackerPatch = {};
			for (const k of ["title", "kind", "command", "unit", "warn", "bad", "url", "max"] as const) if (a[k] !== undefined) (patch as Json)[k] = a[k];
			if (a.params !== undefined) {
				for (const [k, v] of Object.entries(a.params as Json)) if (typeof v !== "string") throw new ToolError(`params.${k} must be a string`);
				patch.options = a.params;
			}
			// A number, or a string of digits, is seconds here (as the schema says); "15m", "2h", "off" as usual.
			if (a.every !== undefined) patch.every = typeof a.every === "number" || /^\d+$/.test(a.every) ? Number(a.every) : parseEvery(a.every);
			const name = String(a.name).trim().toLowerCase();
			const existing = c.db.query("SELECT id FROM trackers WHERE project = ? AND name = ?").get(project, name) as { id: number } | null;
			let t = existing ? updateTracker(c.db, existing.id, patch) : addTracker(c.db, { ...patch, name, project });
			if (t.kind !== "manual" && (!existing || !t.checked_at)) t = await refreshTracker(c.db, t.id, "agent");
			return { text: `${existing ? "Changed" : "Added"} ${trackerBlock(t)}${t.error ? `\n  error: ${t.error}` : ""}`, data: { tracker: trackerJson(t) } };
		},
	},
	{
		name: "remove_tracker",
		title: "Remove a tracker",
		description: "Deletes a tracker and its history. Only when {{name}} asks.",
		input: obj({ tracker: TRACKER, project: PROJECT }, ["tracker"]),
		hints: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
		run(a, c) {
			const t = resolveTracker(c.db, a.tracker, projectOf(c, a.project, false));
			removeTracker(c.db, t.id);
			return { text: `tracker ${t.ref} removed` };
		},
	},
];

const TOOL = new Map(TOOLS.map((t) => [t.name, t]));

function toolDef(t: Tool, era: Era): Json {
	const d: Json = { name: t.name, description: t.description, inputSchema: t.input };
	if (since(era, "2025-06-18")) d.title = t.title;
	if (since(era, "2025-03-26")) d.annotations = { title: t.title, ...t.hints };
	return d;
}

async function callTool(params: Json, c: Conn, era: Era): Promise<Json> {
	const name = params.name;
	const tool = typeof name === "string" ? TOOL.get(name) : undefined;
	if (!tool) throw new RpcError(-32602, `Unknown tool: ${String(name)}`);
	const args = (params.arguments ?? {}) as Json;
	const fail = (text: string) => ({ content: [{ type: "text", text }], isError: true });
	const bad = check(args, tool.input, "");
	if (bad) return fail(bad);
	// A sign of life (alive.ts): a call naming an item, or from the session an item records. After the call, so
	// start_item's own session counts, and whether the call worked or not.
	const alive = () => noteAlive(c.db, { ids: [typeof args.ref === "string" ? resolveItem(c.db, args.ref) : undefined], session: c.session });
	try {
		// Defaults whose deadline passed go ahead first, so what the tool reads or changes is current (asks.ts).
		applyDue(c.db);
		const out = await tool.run(args, c);
		const content: Json[] = [{ type: "text", text: out.text }];
		if (out.image) content.push({ type: "image", ...out.image });
		if (since(era, "2025-06-18")) for (const l of out.links ?? []) content.push({ type: "resource_link", ...l });
		return { content, ...(out.data && since(era, "2025-06-18") ? { structuredContent: out.data } : {}), isError: false };
	} catch (e) {
		if (e instanceof RpcError) throw e;
		// Everything a tool refuses (a bad ref, a validation rule) is something the model can fix.
		return fail((e as Error).message || String(e));
	} finally {
		alive();
	}
}

/* ---------- Resources ---------- */

type Resource = { uri: string; name: string; title?: string; description?: string; mimeType: string };

const TEMPLATES = [
	{ uriTemplate: "wb://item/{ref}", name: "item", title: "Workbench item", description: "An item with its details and history (ref: wb-xxxx).", mimeType: "text/markdown" },
	{ uriTemplate: "wb://project/{project}", name: "project", title: "Project overview", description: "Open items, trackers, git state, reports and links of a project.", mimeType: "text/markdown" },
	{ uriTemplate: "wb://trackers/{project}", name: "project-trackers", title: "Project trackers", description: "A project's status trackers and the global ones, as JSON.", mimeType: "application/json" },
	{ uriTemplate: "wb://report/{id}", name: "report", title: "Report page", description: "A report's latest HTML.", mimeType: "text/html" },
	{ uriTemplate: "wb://rulings/{project}", name: "rulings", title: "Project rulings", description: "A project's standing answers, one line each: read them before asking anything.", mimeType: "text/markdown" },
];

function allResources(c: Conn): Resource[] {
	const out: Resource[] = [
		{ uri: "wb://projects", name: "projects", title: "Projects", description: "Every project with its folder.", mimeType: "application/json" },
		{ uri: "wb://trackers", name: "trackers", title: "Status trackers", description: "Every tracker with its reading.", mimeType: "application/json" },
	];
	for (const p of projects(c.db))
		out.push(
			{ uri: `wb://project/${p.slug}`, name: p.slug, title: `${p.name} overview`, description: `Open items, trackers, git, reports and links of ${p.name}.`, mimeType: "text/markdown" },
			{ uri: `wb://rulings/${p.slug}`, name: `${p.slug}/rulings`, title: `${p.name} rulings`, description: `The standing answers in ${p.name}.`, mimeType: "text/markdown" },
		);
	for (const i of listItems(c.db, { status: OPEN }))
		out.push({ uri: `wb://item/wb-${i.ref}`, name: `wb-${i.ref}`, title: i.title, description: `${i.project} · ${i.kind} for ${WHO(c, i.owner)} · ${i.status}`, mimeType: "text/markdown" });
	for (const r of listReports(c.db).filter((r) => !r.name.startsWith("day-")))
		out.push({ uri: `wb://report/${r.id}`, name: `${r.project}/${r.name}`, title: r.title, description: `Report in ${r.project}, v${r.version}`, mimeType: "text/html" });
	return out;
}

const PAGE = 200;

function listResources(params: Json, c: Conn) {
	const all = allResources(c);
	const start = params.cursor ? Number(Buffer.from(String(params.cursor), "base64url").toString()) : 0;
	if (!Number.isInteger(start) || start < 0 || start > all.length) throw new RpcError(-32602, "Invalid cursor");
	const page = all.slice(start, start + PAGE);
	return { resources: page, ...(start + PAGE < all.length ? { nextCursor: Buffer.from(String(start + PAGE)).toString("base64url") } : {}) };
}

async function readResource(uri: string, c: Conn, era: Era) {
	const notFound = () => new RpcError(era.modern ? -32602 : -32002, `Resource not found: ${uri}`, { uri });
	const text = (t: string, mimeType: string) => ({ contents: [{ uri, mimeType, text: t }] });
	const m = uri.match(/^wb:\/\/([a-z]+)(?:\/(.+))?$/);
	if (!m) throw notFound();
	const [, kind, arg = ""] = m;
	const slug = (s: string) => {
		const p = projects(c.db).find((x) => x.slug === decodeURIComponent(s));
		if (!p) throw notFound();
		return p.slug;
	};
	if (kind === "projects" && !arg) return text(JSON.stringify(projects(c.db), null, 2), "application/json");
	if (kind === "trackers")
		return text(JSON.stringify((arg ? listTrackers(c.db, slug(arg)) : listTrackers(c.db)).map(trackerJson), null, 2), "application/json");
	if (kind === "project" && arg) return text(await overview(c, slug(arg)), "text/markdown");
	if (kind === "rulings" && arg) {
		const list = listRulings(c.db, { project: slug(arg) });
		return text([`# Rulings in ${slug(arg)}`, "", ...(list.length ? list.map((r) => `- ${rulingLine(r)}`) : ["none yet"])].join("\n"), "text/markdown");
	}
	if (kind === "item" && arg) {
		applyDue(c.db);
		const id = resolveItem(c.db, decodeURIComponent(arg));
		if (id === undefined) throw notFound();
		return text(itemText(c, getItem(c.db, id)!), "text/markdown");
	}
	if (kind === "report" && /^\d+$/.test(arg)) {
		const page = reportHtml(c.db, Number(arg));
		if (!page) throw notFound();
		return text(page.html, "text/html");
	}
	throw notFound();
}

/* ---------- Prompts ---------- */

type Prompt = {
	name: string;
	title: string;
	description: string;
	arguments: { name: string; description: string; required?: boolean }[];
	get(a: Record<string, string>, c: Conn): Promise<string> | string;
};

const TRACKING = `Track it on the workbench with this server's tools:
- start_item now (it links this session to the item); add the branch once you have one.
- add_note for what {{name}} should know along the way; wait_item when you're blocked, saying on what. When it's something {{name}} has to answer or do, file it as its own item and wait on it (add_item with blocks: this item, or wait_item with on): the board resumes you when it's answered.
- finish_item with a note on what changed and where (commit, branch, PR).
- Decide what you can yourself. Anything you leave for {{name}} is its own item (add_item): a check, a decision with your recommendation, or a notice of what changed. It makes sense without opening anything else, with a screenshot for anything on screen (attach_image).
- This item's images, if it lists any, are part of the brief: read them with get_image.`;

/** For work-on: the rulings that bear on the item (by its words), and its own drafted one to rewrite. */
function workOnRulings(c: Conn, i: Item) {
	const name = yourName(c.db);
	const own = itemRulings(c.db, i.id).filter((r) => r.drafted && !r.retired_at);
	const near = similarRulings(c.db, i.project, i.title, i.body, { min: RELEVANT, limit: 5, except: i.id });
	const out: string[] = [];
	if (near.length) out.push(`${name}'s rulings in this project that may bear on it (follow them; list_rulings has the rest):`, ...near.map((m) => `- ${rulingLine(m.ruling)}`));
	if (own.length)
		out.push(`${out.length ? "\n" : ""}${name} answered this item, and its ruling is still the automatic draft. Rewrite it as one clear line that stands by itself, in their meaning (update_ruling):`, ...own.map((r) => `- ${rulingLine(r)}`));
	return out.length ? `\n\n${out.join("\n")}` : "";
}

const PROMPTS: Prompt[] = [
	{
		name: "work-on",
		title: "Work on an item",
		description: "Pick up a workbench item: its brief and history, and how to track the work.",
		arguments: [{ name: "ref", description: "The item, e.g. wb-k3f9", required: true }],
		get(a, c) {
			const id = resolveItem(c.db, a.ref);
			if (id === undefined) throw new RpcError(-32602, `no item "${a.ref}"`);
			const i = getItem(c.db, id)!;
			const p = projects(c.db).find((x) => x.slug === i.project);
			return `Work on wb-${i.ref} in ${p?.name ?? i.project}${p?.path ? ` (${p.path})` : ""}. Its body and notes are the brief.\n\n${itemText(c, i)}${workOnRulings(c, i)}\n\n${personal(TRACKING, c)}`;
		},
	},
	{
		name: "next",
		title: "Pick the next task",
		description: "The open agent work in a project, most urgent first, to pick up the next piece.",
		arguments: [{ name: "project", description: "Project slug (default: the current one)" }],
		get(a, c) {
			const slug = projectOrRpc(c, a.project);
			const goal = activeGoal(c.db, slug);
			// In progress first, then todo on the active goal, then the other todo, then what waits: each by priority.
			const rank = (i: Item) => (i.status === "doing" ? 0 : i.status === "waiting" ? 3 : goal && i.goal_id === goal.id ? 1 : 2);
			const items = listItems(c.db, { project: slug, owner: "agent", status: OPEN })
				.map((i, n) => ({ i, n }))
				.sort((x, y) => rank(x.i) - rank(y.i) || x.n - y.n)
				.map((x) => x.i);
			const list = items.length ? items.map((i) => `- ${itemLine(c, i, false)}`).join("\n") : "(nothing open for agents)";
			const focus = goal ? `\nThe active goal is "${goal.title}"${goal.due ? `, ${dueText(goal.due)}` : ""}: prefer work that serves it (those items name it).\n` : "";
			return `Here is the open agent work in ${slug}, most urgent first (doing, then todo${goal ? " on the active goal, then other todo" : ""} by priority, then waiting):\n${focus}\n${list}\n\nPick the item to do next: one already in progress in this session, else the most urgent todo${goal ? ", from the active goal when it has one" : ""}. Read it with get_item, tell me which one you picked and why in a sentence, then do it.\n\n${personal(TRACKING, c)}`;
		},
	},
	{
		name: "integrate",
		title: "Wire this project into the workbench",
		description: "Set a project up so its agents use the board: the project on the board, the rules in its agent file, Claude Code's MCP server.",
		arguments: [{ name: "project", description: "Project slug (default: the current one, or this folder)" }],
		get(a, c) {
			const p = a.project ? projects(c.db).find((x) => x.slug === projectOrRpc(c, a.project)) : undefined;
			const dir = p?.path || projects(c.db).find((x) => x.slug === c.project)?.path || process.env.CLAUDE_PROJECT_DIR || process.cwd();
			return `Set this project up to work with the workbench by following the guide below. Ask me before you add the project to the board, change my Claude Code settings or move any to-do lists.\n\n${integrationGuide(c.db, dir)}`;
		},
	},
	{
		name: "today",
		title: "Today's brief",
		description: "A one-screen brief: what waits on {{name}}, what agents finished, what's stuck, reports updated. Read-only, same as the board's Today.",
		arguments: [
			{ name: "project", description: "Project slug (default: all projects)" },
			{ name: "since", description: "From when, e.g. 2026-11-12 08:00 (UTC; default: the last 24 hours)" },
		],
		get(a, c) {
			if (a.project && !projects(c.db).some((p) => p.slug === a.project)) throw new RpcError(-32602, `no project "${a.project}"`);
			return `Here is today's brief. Tell me in a few plain lines what I should look at first, then what agents got done.\n\n${briefText(c.db, a.project ?? "", a.since)}`;
		},
	},
	{
		name: "status",
		title: "Project status",
		description: "Where a project stands (open items, what waits on {{name}}, trackers, git) for a short status write-up.",
		arguments: [{ name: "project", description: "Project slug (default: the current one)" }],
		async get(a, c) {
			const slug = projectOrRpc(c, a.project);
			return `Write me a short status of ${slug}: what's in progress, what waits on me (decisions first, and which of them hold up the most waiting work), anything blocked, stale agent work to chase, trackers that warn, and git loose ends. A few lines, no preamble.\n\n${await overview(c, slug)}`;
		},
	},
];

function projectOrRpc(c: Conn, p?: string) {
	try {
		return projectOf(c, p)!;
	} catch (e) {
		throw new RpcError(-32602, (e as Error).message);
	}
}

/* ---------- Completions ---------- */

function complete(params: Json, c: Conn) {
	const ref = (params.ref ?? {}) as Json;
	const arg = (params.argument ?? {}) as { name?: string; value?: string };
	const value = String(arg.value ?? "").toLowerCase();
	let pool: string[] = [];
	const refs = () =>
		listItems(c.db, { status: OPEN, project: c.project }).concat(c.project ? listItems(c.db, { status: OPEN }) : []).map((i) => `wb-${i.ref}`);
	const slugs = () => projects(c.db).map((p) => p.slug);
	if (ref.type === "ref/prompt") {
		if (arg.name === "ref") pool = refs();
		else if (arg.name === "project") pool = slugs();
	} else if (ref.type === "ref/resource") {
		const uri = String(ref.uri ?? "");
		if (uri === "wb://item/{ref}") pool = refs();
		else if (uri === "wb://project/{project}" || uri === "wb://trackers/{project}" || uri === "wb://rulings/{project}") pool = slugs();
		else if (uri === "wb://report/{id}") pool = listReports(c.db).filter((r) => !r.name.startsWith("day-")).map((r) => String(r.id));
	} else throw new RpcError(-32602, "ref must be ref/prompt or ref/resource");
	const uniq = [...new Set(pool)];
	const hits = uniq.filter((v) => v.toLowerCase().startsWith(value)).concat(uniq.filter((v) => !v.toLowerCase().startsWith(value) && v.toLowerCase().includes(value)));
	return { completion: { values: hits.slice(0, 100), total: hits.length, hasMore: hits.length > 100 } };
}

/* ---------- Dispatch ---------- */

// The lists carry your name and who gets new items (Settings → You and your day), so clients don't keep them long.
const CACHE_STATIC = { ttlMs: 5 * 60_000, scope: "public" as const };

/**
 * Answers one JSON-RPC message: a response object, or null for a notification. Protocol failures come back as
 * RpcError, which the transport turns into an error response.
 */
async function dispatch(m: Rpc, c: Conn): Promise<Json | null> {
	const method = m.method as string;
	const params = (m.params ?? {}) as Json;
	if (m.id === undefined || m.id === null) return null; // notifications: initialized, cancelled, roots changes
	// The setup guide's live check that agents reach the board (setup.ts): who called, at most once a minute.
	const meta = ((params as Record<string, Json>)._meta ?? {}) as Record<string, Json>;
	const client = ((params as Record<string, Json>).clientInfo ?? meta[`${M}clientInfo`]) as Record<string, Json> | undefined;
	noteMcpContact(c.db, c.transport, typeof client?.name === "string" ? client.name : "");
	if (method === "initialize") {
		// A legacy client: answer with its revision if we have it, else the newest legacy one (it may then hang up).
		const asked = params.protocolVersion;
		const version = typeof asked === "string" && LEGACY.includes(asked) ? asked : LEGACY[0];
		if (c.transport === "stdio") c.legacy = version;
		const era = { version, modern: false };
		return { protocolVersion: version, capabilities: CAPABILITIES, serverInfo: personal(serverInfo(era), c), instructions: personal(INSTRUCTIONS, c) };
	}
	const era = eraOf(m, c);
	switch (method) {
		case "server/discover":
			return shape(
				{ ...era, modern: true },
				personal({ supportedVersions: SUPPORTED, capabilities: CAPABILITIES, instructions: INSTRUCTIONS, _meta: { [`${M}serverInfo`]: SERVER_INFO } }, c),
				CACHE_STATIC,
			);
		case "ping":
			return shape(era, {});
		case "tools/list":
			return shape(era, { tools: personal(TOOLS.map((t) => toolDef(t, era)), c) }, CACHE_STATIC);
		case "tools/call":
			return shape(era, await callTool(params, c, era));
		case "resources/list": {
			const page = listResources(params, c);
			if (!since(era, "2025-06-18")) page.resources = page.resources.map(({ title: _, ...r }) => r);
			return shape(era, page, { ttlMs: 30_000, scope: "private" });
		}
		case "resources/templates/list":
			return shape(
				era,
				{ resourceTemplates: since(era, "2025-06-18") ? TEMPLATES : TEMPLATES.map(({ title: _, ...t }) => t) },
				CACHE_STATIC,
			);
		case "resources/read": {
			if (typeof params.uri !== "string") throw new RpcError(-32602, "uri is required");
			return shape(era, await readResource(params.uri, c, era), { ttlMs: 0, scope: "private" });
		}
		case "prompts/list":
			return shape(
				era,
				{ prompts: personal(PROMPTS.map(({ get: _, title, ...p }) => (since(era, "2025-06-18") ? { ...p, title } : p)), c) },
				CACHE_STATIC,
			);
		case "prompts/get": {
			const p = PROMPTS.find((x) => x.name === params.name);
			if (!p) throw new RpcError(-32602, `Unknown prompt: ${String(params.name)}`);
			const args = (params.arguments ?? {}) as Record<string, string>;
			for (const a of p.arguments) if (a.required && !String(args[a.name] ?? "").trim()) throw new RpcError(-32602, `${a.name} is required`);
			const text = await p.get(args, c);
			return shape(era, { description: personal(p.description, c), messages: [{ role: "user", content: { type: "text", text } }] });
		}
		case "completion/complete":
			return shape(era, complete(params, c));
	}
	throw new RpcError(-32601, `Method not found: ${method}`, undefined, era.modern ? 404 : 200);
}

/** A request or notification: jsonrpc 2.0, a method, and an id that (when there is one) is a string or a number. */
function validRpc(m: unknown): m is Rpc {
	if (!m || typeof m !== "object" || Array.isArray(m)) return false;
	const r = m as Rpc;
	return r.jsonrpc === "2.0" && typeof r.method === "string" && (!("id" in r) || typeof r.id === "string" || typeof r.id === "number");
}

const errorReply = (id: Id | null | undefined, e: RpcError) => ({
	jsonrpc: "2.0",
	id: id ?? null,
	error: { code: e.code, message: e.message, ...(e.data !== undefined ? { data: e.data } : {}) },
});

async function answer(m: unknown, c: Conn): Promise<{ reply: Json | null; status: number }> {
	if (!validRpc(m)) {
		const raw = m && typeof m === "object" ? (m as Rpc).id : null;
		const id = typeof raw === "string" || typeof raw === "number" ? raw : null;
		const why = raw === null && m && typeof m === "object" && "id" in m ? "Invalid Request: id can't be null" : "Invalid Request";
		return { reply: errorReply(id, new RpcError(-32600, why)), status: 400 };
	}
	try {
		const result = await dispatch(m, c);
		if (result === null) return { reply: null, status: 202 };
		return { reply: { jsonrpc: "2.0", id: m.id!, result }, status: 200 };
	} catch (e) {
		const err = e instanceof RpcError ? e : new RpcError(-32603, `Internal error: ${(e as Error).message}`);
		if (!(e instanceof RpcError)) console.error(`wb mcp: ${m.method}:`, e);
		return { reply: m.id === undefined ? null : errorReply(m.id, err), status: err.http };
	}
}

/* ---------- stdio ---------- */

/** The project a stdio client works in: WB_PROJECT, else the folder it was started in (or Claude Code's project). */
function defaultProject(db: Db) {
	const env = process.env.WB_PROJECT;
	if (env && projects(db).some((p) => p.slug === env)) return env;
	for (const dir of [process.env.CLAUDE_PROJECT_DIR, process.cwd()]) {
		const p = dir && projectForPath(db, dir);
		if (p) return p.slug;
	}
	return undefined;
}

export async function serveStdio() {
	const db = open();
	for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const)
		process.on(sig, () => {
			stopRuns(db);
			process.exit(0);
		});
	const conn: Conn = { transport: "stdio", db, project: defaultProject(db), session: process.env.CLAUDE_CODE_HOST_SESSION_ID };
	const write = (msg: Json) => process.stdout.write(`${JSON.stringify(msg)}\n`);
	// Requests still running, so a notifications/cancelled can stop their answer, and open subscriptions/listen.
	const running = new Map<Id, { cancelled: boolean }>();
	const pending = new Set<Promise<unknown>>();

	const onMessage = async (m: unknown) => {
		if (validRpc(m) && m.method === "notifications/cancelled") {
			const r = running.get((m.params?.requestId ?? "") as Id);
			if (r) r.cancelled = true;
			running.delete((m.params?.requestId ?? "") as Id);
			return;
		}
		if (validRpc(m) && m.method === "subscriptions/listen" && m.id != null) {
			// Nothing here changes on its own between requests that a client could watch, so the stream is
			// acknowledged with no notification types and stays quiet until the client cancels it.
			try {
				eraOf(m, conn);
			} catch (e) {
				return write(errorReply(m.id, e as RpcError));
			}
			running.set(m.id, { cancelled: false });
			return write({ jsonrpc: "2.0", method: "notifications/subscriptions/acknowledged", params: { _meta: { [`${M}subscriptionId`]: m.id }, notifications: {} } });
		}
		const id = validRpc(m) ? m.id : undefined;
		const state = { cancelled: false };
		if (id != null) running.set(id, state);
		const { reply } = await answer(m, conn);
		if (id != null) running.delete(id);
		if (reply && !state.cancelled) write(reply);
	};

	const decoder = new TextDecoder();
	let buf = "";
	const take = (line: string) => {
		if (!line.trim()) return;
		let m: unknown;
		try {
			m = JSON.parse(line);
		} catch {
			return write(errorReply(null, new RpcError(-32700, "Parse error")));
		}
		if (!Array.isArray(m)) {
			const p = onMessage(m).catch((e) => console.error("wb mcp:", e));
			pending.add(p);
			p.finally(() => pending.delete(p));
			return;
		}
		// A batch (2025-03-26) gets one array of answers; an empty one is itself an invalid request.
		if (!m.length) return write(errorReply(null, new RpcError(-32600, "Invalid Request: empty batch")));
		const p = Promise.all(m.map((one) => answer(one, conn))).then((rs) => {
			const replies = rs.map((r) => r.reply).filter(Boolean);
			if (replies.length) process.stdout.write(`${JSON.stringify(replies)}\n`);
		});
		pending.add(p);
		p.finally(() => pending.delete(p));
	};
	for await (const chunk of Bun.stdin.stream()) {
		buf += decoder.decode(chunk, { stream: true });
		for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
			take(buf.slice(0, nl));
			buf = buf.slice(nl + 1);
		}
	}
	take(buf);
	// stdin closed: the client is gone, so a tracker read still running is stopped (its process group killed and
	// its lease given back, so the board can read it); quick answers still go out.
	stopRuns(db);
	setTimeout(() => process.exit(0), 3000).unref();
	await Promise.allSettled([...pending]);
}

/* ---------- Streamable HTTP ---------- */

const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;
const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;
const BODY_MAX = 16 * 1024 * 1024;

const httpJson = (body: Json | null, status: number, headers: Record<string, string> = {}) =>
	body === null
		? new Response(null, { status, headers })
		: Response.json(body, { status, headers: { "cache-control": "no-store", ...headers } });

/** `Mcp-Name` may carry `=?base64?…?=` for values that aren't plain ASCII. */
function headerValue(v: string | null) {
	if (v === null) return null;
	const m = v.match(/^=\?base64\?(.*)\?=$/);
	return m ? Buffer.from(m[1], "base64").toString("utf8") : v;
}

/** 2026-07-28 requests mirror their version, method and name into headers; they must match the body. */
function checkHeaders(req: Request, m: Rpc) {
	const meta = (m.params?._meta ?? {}) as Json;
	const v = meta[`${M}protocolVersion`];
	const hv = req.headers.get("mcp-protocol-version");
	if (v === undefined) return;
	if (typeof v !== "string" || !SUPPORTED.includes(v)) throw unsupported(v);
	if (hv !== v) throw mismatch(`MCP-Protocol-Version ${hv === null ? "is missing" : `'${hv}'`} but _meta says '${v}'`);
	if (v !== MODERN) return;
	const method = req.headers.get("mcp-method");
	if (method !== m.method) throw mismatch(`Mcp-Method ${method === null ? "is missing" : `'${method}'`} but the body says '${String(m.method)}'`);
	if (["tools/call", "prompts/get", "resources/read"].includes(String(m.method))) {
		const want = String(m.method === "resources/read" ? m.params?.uri : m.params?.name);
		const name = headerValue(req.headers.get("mcp-name"));
		if (name !== want) throw mismatch(`Mcp-Name ${name === null ? "is missing" : `'${name}'`} but the body says '${want}'`);
	}
}

/**
 * POST /mcp on the board. Answers with application/json (never a session id); notifications get 202. GET and
 * DELETE get 405: there is no standalone stream and no session to end.
 */
export async function mcpHttp(req: Request, db: Db, { loopback, cloud = false }: { loopback: boolean; cloud?: boolean }): Promise<Response> {
	const refuse = (status: number, message: string) => httpJson(errorReply(null, new RpcError(-32600, message)), status);
	const origin = req.headers.get("origin");
	if (cloud) {
		// The cloud board's gate already checked the device token (an Authorization header: `wb mcp` relays to it).
		// No web page calls it: a browser always sends an Origin with a POST.
		if (origin) return refuse(403, `Origin ${origin} may not use this server`);
	} else {
		// The board has no login: MCP is for processes on this computer, and no web page may reach it (DNS rebinding).
		if (!loopback) return refuse(403, "the workbench MCP server answers only on this computer (localhost)");
		if (!LOCAL_HOST.test(req.headers.get("host") ?? "")) return refuse(403, "Host must be localhost");
		if (origin && !LOCAL_ORIGIN.test(origin)) return refuse(403, `Origin ${origin} may not use this server`);
	}
	if (req.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST" } });
	if (!(req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json"))
		return refuse(415, "Content-Type must be application/json");
	if (Number(req.headers.get("content-length")) > BODY_MAX) return refuse(413, "the request is over 16 MB");

	let body: unknown;
	try {
		body = JSON.parse(await req.text());
	} catch {
		return httpJson(errorReply(null, new RpcError(-32700, "Parse error")), 400);
	}
	const url = new URL(req.url);
	const asked = url.searchParams.get("project") ?? undefined;
	const project = asked && projects(db).some((p) => p.slug === asked) ? asked : undefined;
	if (asked && !project) return refuse(400, `no project "${asked}" (?project= takes a slug)`);
	const hv = req.headers.get("mcp-protocol-version");
	// The session `wb mcp`'s relay runs in (relay.ts), as a stdio server has it: start_item links it, alive.ts counts it.
	const session = req.headers.get("x-wb-session")?.trim();
	const conn: Conn = { transport: "http", db, project, header: hv ?? undefined, ...(session && /^[\w.:-]{1,120}$/.test(session) ? { session } : {}) };

	const one = async (m: unknown): Promise<{ reply: Json | null; status: number }> => {
		if (!validRpc(m)) return answer(m, conn);
		try {
			checkHeaders(req, m);
			// A legacy request names its revision in the header only (initialize negotiates it in the body).
			const hasMeta = ((m.params?._meta ?? {}) as Json)[`${M}protocolVersion`] !== undefined;
			if (!hasMeta && m.method !== "initialize" && hv !== null) {
				if (hv === MODERN) throw mismatch(`MCP-Protocol-Version is ${MODERN} but the request has no _meta.${M}protocolVersion`);
				if (!LEGACY.includes(hv)) throw unsupported(hv);
			}
		} catch (e) {
			return { reply: errorReply(m.id, e as RpcError), status: (e as RpcError).http };
		}
		return answer(m, conn);
	};

	if (Array.isArray(body)) {
		if (!body.length) return httpJson(errorReply(null, new RpcError(-32600, "Invalid Request: empty batch")), 400);
		const replies = (await Promise.all(body.map(one))).map((r) => r.reply).filter(Boolean);
		return replies.length ? Response.json(replies) : new Response(null, { status: 202 });
	}
	if (validRpc(body) && body.method === "subscriptions/listen" && body.id != null) return listen(req, body, conn);
	const { reply, status } = await one(body);
	return reply ? httpJson(reply, status) : new Response(null, { status: 202 });
}

/** subscriptions/listen over HTTP: acknowledged with no notification types, then kept open with keep-alives. */
async function listen(req: Request, m: Rpc, c: Conn): Promise<Response> {
	try {
		checkHeaders(req, m);
		eraOf(m, c);
	} catch (e) {
		return httpJson(errorReply(m.id, e as RpcError), (e as RpcError).http);
	}
	const enc = new TextEncoder();
	let timer: ReturnType<typeof setInterval> | undefined;
	const stream = new ReadableStream<Uint8Array>({
		start(ctrl) {
			const ack = { jsonrpc: "2.0", method: "notifications/subscriptions/acknowledged", params: { _meta: { [`${M}subscriptionId`]: m.id }, notifications: {} } };
			ctrl.enqueue(enc.encode(`data: ${JSON.stringify(ack)}\n\n`));
			timer = setInterval(() => {
				try {
					ctrl.enqueue(enc.encode(":\n\n"));
				} catch {
					clearInterval(timer);
				}
			}, 15_000);
			req.signal.addEventListener("abort", () => {
				clearInterval(timer);
				try {
					ctrl.close();
				} catch {}
			});
		},
		cancel() {
			clearInterval(timer);
		},
	});
	return new Response(stream, {
		headers: { "content-type": "text/event-stream", "cache-control": "no-store", "x-accel-buffering": "no" },
	});
}


/* ---------- wb mcp's relay (relay.ts): a tool answered on this computer, shaped as this server shapes it ---------- */

/** The JSON-RPC reply to a tools/call that the relay answered itself (vault_get and vault_list, cloudvault.ts). */
export function relayedToolReply(m: { id?: Id | null; params?: Json }, agreed: string | undefined, out: { text: string; data?: Json } | { error: string }): Json {
	const meta = ((m.params?._meta ?? {}) as Json)[`${M}protocolVersion`];
	const era: Era = typeof meta === "string" ? { version: meta, modern: meta === MODERN } : { version: agreed ?? "2025-03-26", modern: false };
	const result: Json =
		"error" in out
			? { content: [{ type: "text", text: out.error }], isError: true }
			: { content: [{ type: "text", text: out.text }], ...(out.data && since(era, "2025-06-18") ? { structuredContent: out.data } : {}), isError: false };
	return { jsonrpc: "2.0", id: m.id ?? null, result: shape(era, result) };
}
