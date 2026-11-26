/**
 * Autopilot (docs/agents.md, "Autopilot"): a switch per project. While it's on, whenever a slot is free, the board
 * starts an agent on the first item of the project's Next up that an agent can run, with the item's own model, effort
 * and mode, one at a time per project. Within everything Settings → Agents says (on, at once, per day, a day's usage),
 * and its own guard rails there: the hours it may start agents in, and a tracker of the project (or a board-wide one)
 * at warn or bad pauses it.
 *
 * It's looked at where unblocked work is sent (dispatch.ts sendUnblocked): the local board's 2 s watch and the cloud
 * board's helper tick. startRun makes every check again with nothing awaited before its insert, so two looks at once
 * can't start two runs. An item whose last autopilot run failed or was stopped isn't picked again until something
 * else starts it (Run, a restart from Stuck): a run that breaks doesn't loop.
 */
import { getProject, projects, type Db, type Item, type Project } from "./db";
import { agentOrder } from "./order";
import { blockersOf } from "./links";
import { getSetting } from "./settings";
import { listTrackers, type MeterView } from "./trackers";
import { itemRefusal, latestRun, startRefusal, startRun, type From, type Run } from "./dispatch";

export const AUTOPILOT: From = { where: "auto", label: "autopilot", by: "board" };

/** One project's autopilot as the page shows it: on, and why it starts nothing now ('' when it can, or one runs). */
export type AutopilotState = { slug: string; on: boolean; why: string; run?: { id: number; ref: string } };

const isOn = (p: Pick<Project, "autopilot" | "archived_at">) => !!p.autopilot && !p.archived_at;
const onProjects = (db: Db) => projects(db).filter(isOn);

/** Turns a project's autopilot on or off. */
export function setAutopilot(db: Db, slug: string, on: unknown): Project {
	if (typeof on !== "boolean") throw new Error("on is true or false");
	if (!db.query("UPDATE projects SET autopilot = ? WHERE slug = ?").run(on ? 1 : 0, slug).changes) throw new Error(`no project "${slug}"`);
	return getProject(db, slug)!;
}

/* ---------- Its hours ---------- */

const minutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
/** The hours Settings gives it ("22:00-08:00"), or null for any time. */
export function autopilotHours(db: Db): { from: string; to: string } | null {
	const h = getSetting<string>(db, "agents.autopilot-hours");
	const m = h.match(/^(\d\d:\d\d)-(\d\d:\d\d)$/);
	return m && m[1] !== m[2] ? { from: m[1], to: m[2] } : null;
}
/** The time of day, in minutes, in the zone Settings has (the page saves its own with the hours), else the board's. */
function minuteOfDay(db: Db, now: Date) {
	const zone = getSetting<string>(db, "agents.autopilot-zone");
	if (zone) {
		try {
			const parts = Object.fromEntries(
				new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", hour: "2-digit", minute: "2-digit" }).formatToParts(now).map((x) => [x.type, x.value]),
			);
			return (Number(parts.hour) % 24) * 60 + Number(parts.minute);
		} catch {}
	}
	return now.getHours() * 60 + now.getMinutes();
}
/** Whether now is inside its hours (always, with none set). */
export function inHours(db: Db, now = new Date()): boolean {
	const h = autopilotHours(db);
	if (!h) return true;
	const at = minuteOfDay(db, now), from = minutes(h.from), to = minutes(h.to);
	return from < to ? at >= from && at < to : at >= from || at < to;
}

/* ---------- Trackers ---------- */

const pctText = (m: MeterView) => {
	const p = m.pct ?? (m.value != null && m.max ? (m.value / m.max) * 100 : undefined);
	if (p != null) return `at ${Math.round(p)}%`;
	if (m.text) return m.text;
	return m.value != null ? `at ${m.value}${m.unit ? ` ${m.unit}` : ""}` : `at ${m.level}`;
};
/** Why a tracker holds the project's autopilot: one of its own, or a board-wide one, at the level Settings names.
 * A tracker that couldn't read doesn't count: that's no quota running out. */
export function trackerHold(db: Db, project: string): string {
	const at = getSetting<string>(db, "agents.autopilot-trackers");
	if (at === "off") return "";
	const levels = at === "warn" ? ["warn", "bad"] : ["bad"];
	for (const t of listTrackers(db, project)) {
		if (t.error || !t.reading) continue;
		const m = t.reading.meters.find((x) => x.level === "bad") ?? t.reading.meters.find((x) => levels.includes(x.level));
		if (m && levels.includes(m.level)) return `${t.title}${m.label && t.reading.meters.length > 1 ? ` · ${m.label}` : ""} ${pctText(m)}`;
	}
	return "";
}

/* ---------- What it would start ---------- */

/** Whether the item's last run was autopilot's and broke: it waits for Kostas (Stuck shows it), not for another try. */
const brokeOnAutopilot = (db: Db, i: Item) => {
	const r = latestRun(db, i.id);
	return !!r?.ended_at && !r.moved && r.started_from === AUTOPILOT.label && (r.status === "failed" || r.status === "stopped");
};
/** The first item of the project's Next up an agent can run, or why there's none. */
export function autopilotPick(db: Db, project: string): { item?: Item; why: string } {
	const next = agentOrder(db, project).filter((i) => i.status === "todo" && i.kind !== "idea" && !blockersOf(db, i.id).length && !brokeOnAutopilot(db, i));
	let first = "";
	for (const i of next) {
		const why = itemRefusal(db, i);
		if (!why) return { item: i, why: "" };
		first ||= why;
	}
	return { why: first && !/^an agent is on/.test(first) ? cap(first) : "Nothing in Next up an agent can run" };
}
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** The run going on the project (any: Run, autopilot, a merge), so autopilot starts one at a time per project. */
const projectRun = (db: Db, project: string) =>
	db.query("SELECT r.id, i.ref FROM runs r JOIN items i ON i.id = r.item_id WHERE r.project = ? AND r.ended_at IS NULL ORDER BY r.id LIMIT 1").get(project) as
		| { id: number; ref: string }
		| null;

/** Why the project's autopilot starts nothing now, without the day's usage (which reads transcripts), or ''. */
function holdOf(db: Db, project: string, now: Date): { why: string; run?: { id: number; ref: string } } {
	if (!getSetting<boolean>(db, "agents.on")) return { why: "Paused: the board doesn't start agents (Settings → Agents)" };
	if (!inHours(db, now)) {
		const h = autopilotHours(db)!;
		return { why: `Waits for its hours: ${h.from}–${h.to}` };
	}
	const held = trackerHold(db, project);
	if (held) return { why: `Paused: ${held}` };
	const run = projectRun(db, project);
	if (run) return { why: "", run };
	const pick = autopilotPick(db, project);
	return { why: pick.why };
}

/** Every project's autopilot that's on, for the page: the project page's line and the Agents place's. */
export async function autopilotStates(db: Db, now = new Date()): Promise<AutopilotState[]> {
	const out: AutopilotState[] = [];
	let limit: string | undefined;
	for (const p of onProjects(db)) {
		const h = holdOf(db, p.slug, now);
		if (!h.why && !h.run) {
			limit ??= (await startRefusal(db, AUTOPILOT, now))?.why ?? "";
			if (limit) h.why = `Paused: ${limit.replace(/\.$/, "")}`;
		}
		out.push({ slug: p.slug, on: true, ...h });
	}
	return out;
}

/* ---------- Starting ---------- */

const quiet = new Map<string, string>();
const capped = new Map<string, { cap: number; until: number }>();
const CAPPED_MS = 60e3;
/** Says why a project's autopilot holds, once per reason, in the board's log. */
function tell(slug: string, why: string) {
	if (quiet.get(slug) === why) return;
	quiet.set(slug, why);
	if (why) console.log(`autopilot: ${slug}: ${why}`);
}

/**
 * Starts what autopilot may start now: for each project whose switch is on (the one that started least lately first,
 * so one project doesn't take every slot), its first runnable Next up item, while a slot is free. Returns the runs.
 */
export async function runAutopilot(db: Db, now = new Date()): Promise<Run[]> {
	const on = onProjects(db);
	if (!on.length || !getSetting<boolean>(db, "agents.on")) return [];
	const lately = new Map(
		(db.query("SELECT project, MAX(id) AS last FROM runs WHERE started_from = ? GROUP BY project").all(AUTOPILOT.label) as { project: string; last: number }[]).map((r) => [r.project, r.last]),
	);
	on.sort((a, b) => (lately.get(a.slug) ?? 0) - (lately.get(b.slug) ?? 0));
	const out: Run[] = [];
	for (const p of on) {
		const h = holdOf(db, p.slug, now);
		if (h.why || h.run) {
			tell(p.slug, h.why);
			continue;
		}
		// The day's usage reads transcripts: once it holds, it's asked again after a while, not every look.
		// A cap changed in Settings is looked at again at once.
		const cap = getSetting<number>(db, "agents.day-dollars");
		const held = capped.get(db.filename);
		if (held && held.cap === cap && held.until > Date.now()) break;
		const no = await startRefusal(db, AUTOPILOT, now);
		if (no) {
			tell(p.slug, no.why);
			if (/^Today's agents used/.test(no.why)) capped.set(db.filename, { cap, until: Date.now() + CAPPED_MS });
			break; // a limit holds every project alike
		}
		const { item } = autopilotPick(db, p.slug);
		if (!item) continue;
		try {
			const r = await startRun(db, item.id, AUTOPILOT);
			out.push(r);
			tell(p.slug, "");
			console.log(`autopilot: started run #${r.id} on wb-${item.ref} (${p.slug})`);
		} catch (e) {
			// Refused after all (a click got there first) or couldn't start: the run, if any, shows how it ended.
			tell(p.slug, (e as Error).message);
		}
	}
	return out;
}

/** Whether any project's autopilot is on, so the cloud board's helper ticks often enough. */
export const autopilotAny = (db: Db) => !!db.query("SELECT 1 FROM projects WHERE autopilot = 1 AND archived_at IS NULL LIMIT 1").get();
