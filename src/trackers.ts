/**
 * Status trackers: small live readings shown under each project's name in the sidebar: a quota (12 of 15 EAS
 * builds), an allowance (760 GitHub Actions minutes left), a state ("In review"). A tracker belongs to one
 * project or to every project (global), and gets its reading one of three ways:
 *
 * - manual: someone records it (`wb track`, the board, an agent through MCP);
 * - command: a shell command the board runs every `every` seconds, whose output is the reading (parseReading);
 * - a preset: a built-in reader (presets.ts) with a few options.
 *
 * The board runs the due ones (runDue); `wb tracker refresh` and MCP run them on demand. A lease
 * (running_since) keeps the board and a CLI from running the same one at once.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import type { Db } from "./db";
import { PRESETS, type PresetContext } from "./presets";
import { getSetting } from "./settings";

export const TRACKER_KINDS = ["manual", "command", ...Object.keys(PRESETS)] as const;
export type TrackerKind = string;
export type Level = "ok" | "warn" | "bad" | "";

/** One line of a reading: a number against an allowance (value/max), or a state in words (text). */
export type Meter = {
	label: string;
	value?: number;
	max?: number;
	unit?: string;
	text?: string;
	/** Set by the source to override the thresholds. */
	level?: Level;
};
export type Reading = {
	meters: Meter[];
	/** One short line under the meters, e.g. "Free plan". */
	note?: string;
	/** When the allowance starts over (ISO). */
	resets_at?: string;
	/** A page with the details. */
	url?: string;
};
/** A meter as shown: the tracker's unit and max filled in, its level worked out. */
export type MeterView = Meter & { level: Level; pct?: number; left?: number };

type Row = {
	id: number;
	project: string;
	name: string;
	title: string;
	kind: string;
	command: string;
	options: string;
	every: number;
	warn: string;
	bad: string;
	unit: string;
	max: number | null;
	url: string;
	sort: number;
	reading: string | null;
	read_at: string | null;
	checked_at: string | null;
	error: string;
	running_since: string | null;
	rev: number;
	created_at: string;
	updated_at: string;
};

export type Tracker = Omit<Row, "options" | "reading" | "running_since" | "rev"> & {
	/** `project/name`, or just `name` for a global one: what commands and tools take. */
	ref: string;
	options: Record<string, string>;
	reading: (Omit<Reading, "meters"> & { meters: MeterView[] }) | null;
	/** The worst meter's level. */
	level: Level;
	/** Reads itself but hasn't for a good while (three intervals). */
	stale: boolean;
	running: boolean;
	/** When the board runs it next (UTC, like the other times), or null. */
	due_at: string | null;
};

export type TrackerInput = {
	project?: string;
	name: string;
	title?: string;
	kind?: string;
	command?: string;
	options?: Record<string, string>;
	every?: number;
	warn?: string;
	bad?: string;
	unit?: string;
	max?: number | null;
	url?: string;
};
export type TrackerPatch = Partial<Omit<TrackerInput, "name">> & { name?: string; sort?: number };

export const RUN_TIMEOUT_MS = 60_000;
const OUTPUT_MAX = 1024 * 1024;
// Readings kept per tracker: Settings → Data ("keep.tracker-history"), read at each store.
const historyKeep = (db: Db) => getSetting<number>(db, "keep.tracker-history");
/** A run that hasn't finished after this long is taken to have died with its process. */
const LEASE_MINUTES = 5;
export const EVERY_MIN = 60;
export const EVERY_MAX = 30 * 86400;

export function createTables(db: Db) {
	// project '' = shown with every project. `reading` is the last good reading as JSON; a failed run keeps it and
	// sets `error`. `every` is in seconds, 0 = only when asked.
	db.run(`CREATE TABLE IF NOT EXISTS trackers (
		id INTEGER PRIMARY KEY,
		project TEXT NOT NULL DEFAULT '',
		name TEXT NOT NULL,
		title TEXT NOT NULL,
		kind TEXT NOT NULL DEFAULT 'manual',
		command TEXT NOT NULL DEFAULT '',
		options TEXT NOT NULL DEFAULT '{}',
		every INTEGER NOT NULL DEFAULT 3600,
		warn TEXT NOT NULL DEFAULT '',
		bad TEXT NOT NULL DEFAULT '',
		unit TEXT NOT NULL DEFAULT '',
		max REAL,
		url TEXT NOT NULL DEFAULT '',
		sort INTEGER NOT NULL DEFAULT 0,
		reading TEXT,
		read_at TEXT,
		checked_at TEXT,
		error TEXT NOT NULL DEFAULT '',
		running_since TEXT,
		created_at TEXT NOT NULL DEFAULT (datetime('now')),
		updated_at TEXT NOT NULL DEFAULT (datetime('now')),
		UNIQUE (project, name)
	)`);
	// Every reading that differed from the one before, for the trend in the tracker's dialog.
	db.run(`CREATE TABLE IF NOT EXISTS tracker_history (
		id INTEGER PRIMARY KEY,
		tracker_id INTEGER NOT NULL REFERENCES trackers(id) ON DELETE CASCADE,
		at TEXT NOT NULL DEFAULT (datetime('now')),
		reading TEXT NOT NULL,
		author TEXT NOT NULL DEFAULT ''
	)`);
	db.run("CREATE INDEX IF NOT EXISTS tracker_history_at ON tracker_history(tracker_id, at)");
	// Bumped whenever how a tracker reads changes, so a run that started before the edit can't store the old
	// command's reading over the new one (see store).
	const cols = (db.query("PRAGMA table_info(trackers)").all() as { name: string }[]).map((c) => c.name);
	if (!cols.includes("rev")) db.run("ALTER TABLE trackers ADD COLUMN rev INTEGER NOT NULL DEFAULT 0");
}

/* ---------- Time ---------- */

const sqlTime = (d: Date) => d.toISOString().slice(0, 19).replace("T", " ");
const fromSql = (s: string) => new Date(s.replace(" ", "T") + "Z");

/** "15m", "2h", "1d", "90s", a bare number (minutes), or "off" / "0" (only when asked). In seconds. */
export function parseEvery(s: string | number): number {
	if (typeof s === "number") return s;
	const t = s.trim().toLowerCase();
	if (["off", "never", "manual", "0", ""].includes(t)) return 0;
	const m = t.match(/^(\d+(?:\.\d+)?)\s*(s|sec|secs|seconds?|m|min|mins|minutes?|h|hr|hrs|hours?|d|days?)?$/);
	if (!m) throw new Error(`"${s}" is not an interval (like 15m, 2h, 1d, or off)`);
	const n = Number(m[1]);
	const unit = (m[2] ?? "m")[0];
	return Math.round(n * { s: 1, m: 60, h: 3600, d: 86400 }[unit as "s"]);
}

export function formatEvery(sec: number): string {
	if (!sec) return "only when asked";
	if (sec % 86400 === 0) return sec === 86400 ? "every day" : `every ${sec / 86400} days`;
	if (sec % 3600 === 0) return sec === 3600 ? "every hour" : `every ${sec / 3600} h`;
	if (sec % 60 === 0) return `every ${sec / 60} min`;
	return `every ${sec} s`;
}

/* ---------- Thresholds and levels ---------- */

type Threshold = { at: number; pct: boolean; dir?: "<" | ">" };

/** "90%", "14", ">90%", "<10%": a level starts at this value (or share of max); "<" means low is bad. */
function parseThreshold(s: string): Threshold | null {
	const t = s.trim();
	if (!t) return null;
	const m = t.match(/^([<>])?\s*(-?\d+(?:\.\d+)?)\s*(%)?$/);
	if (!m) throw new Error(`"${s}" is not a threshold (like 90%, 14, or <10%)`);
	return { at: Number(m[2]), pct: !!m[3], dir: m[1] as Threshold["dir"] };
}

const RANK: Record<Level, number> = { "": 0, ok: 1, warn: 2, bad: 3 };
export const worst = (levels: Level[]) => levels.reduce<Level>((a, b) => (RANK[b] > RANK[a] ? b : a), "");

/** Throws when warn and bad can't both be read, or point opposite ways ("<20%" with ">90%"). */
export function checkThresholds(warn: string, bad: string) {
	const w = parseThreshold(warn);
	const b = parseThreshold(bad);
	if (w?.dir && b?.dir && w.dir !== b.dir) throw new Error(`warn ${warn} and bad ${bad} point opposite ways`);
}

/**
 * A meter's level. Without thresholds, a meter with a max warns at 75% and is bad at 90% (a quota running out).
 * A "<" on either says low is bad; so does bad sitting below warn (warn 20%, bad 10%), compared on one scale:
 * a share of max is turned into a value first, so warn 80% with bad 14 (of 15) still means high is bad.
 */
export function meterLevel(m: Meter, warn: string, bad: string): Level {
	if (m.level) return m.level;
	if (m.value === undefined) return "";
	let w = parseThreshold(warn);
	let b = parseThreshold(bad);
	if (!w && !b) {
		if (!m.max) return "";
		w = { at: 75, pct: true };
		b = { at: 90, pct: true };
	}
	// In the meter's own units; a share of max needs a max.
	const at = (t: Threshold | null) => (!t ? undefined : t.pct ? (m.max ? (t.at / 100) * m.max : undefined) : t.at);
	const [wa, ba] = [at(w), at(b)];
	const dir = b?.dir ?? w?.dir ?? (wa !== undefined && ba !== undefined && ba < wa ? "<" : ">");
	const past = (v: number | undefined) => v !== undefined && (dir === ">" ? m.value! >= v : m.value! <= v);
	return past(ba) ? "bad" : past(wa) ? "warn" : "ok";
}

/* ---------- Readings ---------- */

const num = (s: string) => Number(s.replace(/,/g, ""));
const NUM = String.raw`-?\d[\d,]*(?:\.\d+)?`;
// A unit word: letters and a few symbols, "/" only between letters ("req/s", "MB/s"), so "45G/100G" splits.
const WORD = String.raw`[A-Za-z%°µ$€£](?:[A-Za-z%°µ$€£_.-]|\/(?=[A-Za-z]))*`;
// One meter per line: an optional label (ending at ":", "=" or a space), the value with an optional unit, an
// optional "/ max" or "of max" with its unit, and an optional "(…)" kept as the meter's text:
// "Android 12/15" · "iOS: 3 of 15 builds" · "1,240 / 2,000 min" · "Disk 45G/100G" · "Free: 12.5 GB of 50 GB" ·
// "$1.52 / $12" · "Coverage 78%" · "Open PRs: 3 (2 drafts)" · "42". A line that doesn't fit ("Version: v1.2.3",
// "Last deploy 2026-11-05") is a state in words.
const LINE = new RegExp(
	// The label is tried last (??), so "1,240 / 2,000" isn't read as a label "1,240 /" before a value.
	String.raw`^(?:(?<label>[^:=]*?)\s*[:=]\s*|(?<label2>.*?\S)\s+)??` +
		String.raw`(?<cur>[$€£])?(?<value>${NUM})(?:\s*(?<u1>${WORD}(?:\s+${WORD})*?))??` +
		String.raw`(?:\s*(?:\/|\bof\b)\s*[$€£]?(?<max>${NUM})(?:\s*(?<u2>${WORD}(?:\s+${WORD})*))?)?` +
		String.raw`\s*(?:\((?<paren>[^()]*)\))?$`,
);

function meterFrom(x: unknown, label = ""): Meter {
	if (typeof x === "number") return { label, value: x };
	if (typeof x === "string") return { label, text: x };
	if (!x || typeof x !== "object" || Array.isArray(x)) throw new Error("a meter is a number, a string or an object");
	const o = x as Record<string, unknown>;
	const pick = (...keys: string[]) => keys.map((k) => o[k]).find((v) => v !== undefined && v !== null);
	const m: Meter = { label: String(pick("label", "name") ?? label) };
	const value = pick("value", "used");
	const max = pick("max", "total", "limit");
	const left = pick("left", "remaining");
	if (value !== undefined) m.value = Number(value);
	if (max !== undefined) m.max = Number(max);
	// { left, max } reads as used = max - left, so every meter means the same thing.
	if (m.value === undefined && left !== undefined && m.max !== undefined) m.value = m.max - Number(left);
	if (pick("unit") !== undefined) m.unit = String(pick("unit"));
	if (pick("text", "status") !== undefined) m.text = String(pick("text", "status"));
	if (pick("level") !== undefined) m.level = String(pick("level")) as Level;
	return m;
}

/**
 * What a command printed, as a reading. JSON: a number, a string, a meter object ({ value, max, unit, label,
 * text, level }), an array of them, or { meters: [...], note, resets_at, url }. Otherwise each line is a meter:
 * "Android 12/15", "1,240 / 2,000 min", "Status: In review".
 */
export function parseReading(out: string): Reading {
	const text = out.trim();
	if (!text) throw new Error("it printed nothing");
	let json: unknown;
	let isJson = false;
	if (/^[[{"\d-]/.test(text) || text === "true" || text === "false") {
		try {
			json = JSON.parse(text);
			isJson = true;
		} catch {}
	}
	if (isJson) {
		if (Array.isArray(json)) return { meters: json.map((x) => meterFrom(x)) };
		if (json && typeof json === "object" && Array.isArray((json as Reading).meters)) {
			const r = json as Record<string, unknown>;
			return {
				meters: (r.meters as unknown[]).map((x) => meterFrom(x)),
				note: r.note as string | undefined,
				resets_at: r.resets_at as string | undefined,
				url: r.url as string | undefined,
			};
		}
		if (typeof json === "boolean") return { meters: [{ label: "", text: json ? "yes" : "no" }] };
		const m = meterFrom(json);
		const o = (json && typeof json === "object" ? json : {}) as Record<string, unknown>;
		return { meters: [m], note: o.note as string | undefined, resets_at: o.resets_at as string | undefined, url: o.url as string | undefined };
	}
	const meters = text
		.split(/\r?\n/)
		.map((l) => l.trim())
		.filter(Boolean)
		.map((line): Meter => {
			const g = line.match(LINE)?.groups;
			if (g) {
				const meter: Meter = { label: (g.label ?? g.label2 ?? "").trim(), value: num(g.value) };
				if (g.max !== undefined) meter.max = num(g.max);
				const unit = (g.u2 ?? g.u1 ?? g.cur ?? "").trim();
				if (unit) meter.unit = unit;
				if (g.paren?.trim()) meter.text = g.paren.trim();
				return meter;
			}
			const at = line.indexOf(":");
			return at > 0 && at < 40 ? { label: line.slice(0, at).trim(), text: line.slice(at + 1).trim() } : { label: "", text: line };
		});
	return { meters };
}

const LEVELS = new Set(["ok", "warn", "bad", ""]);

/** Checks and trims a reading before it's stored, so the board and agents can trust its shape. */
export function cleanReading(r: Reading): Reading {
	if (!r || !Array.isArray(r.meters) || !r.meters.length) throw new Error("a reading needs at least one meter");
	if (r.meters.length > 12) throw new Error("a reading has at most 12 meters");
	const str = (v: unknown, max: number, what: string) => {
		const s = String(v ?? "").trim();
		if (s.length > max) throw new Error(`${what} is over ${max} characters`);
		return s;
	};
	const meters = r.meters.map((m) => {
		const out: Meter = { label: str(m.label, 40, "a meter label") };
		for (const k of ["value", "max"] as const)
			if (m[k] !== undefined) {
				if (!Number.isFinite(m[k])) throw new Error(`${out.label || "the meter"}: ${k} is not a number`);
				out[k] = m[k];
			}
		if (out.max !== undefined && out.max < 0) throw new Error("max can't be below 0");
		if (m.unit) out.unit = str(m.unit, 16, "a unit");
		if (m.text) out.text = str(m.text, 120, "a meter's text");
		if (out.value === undefined && !out.text) throw new Error(`${out.label || "a meter"} has neither a value nor a text`);
		if (m.level) {
			if (!LEVELS.has(m.level)) throw new Error(`level must be ok, warn or bad, not "${m.level}"`);
			out.level = m.level;
		}
		return out;
	});
	const labels = meters.map((m) => m.label);
	if (new Set(labels).size !== labels.length) throw new Error("two meters have the same label");
	const out: Reading = { meters };
	if (r.note) out.note = str(r.note, 200, "the note");
	if (r.resets_at) {
		const d = new Date(String(r.resets_at));
		if (Number.isNaN(d.getTime())) throw new Error(`resets_at "${r.resets_at}" is not a date`);
		out.resets_at = d.toISOString();
	}
	if (r.url) {
		if (!/^https?:\/\//.test(String(r.url))) throw new Error("url must start with http:// or https://");
		out.url = str(r.url, 500, "the url");
	}
	return out;
}

/* ---------- Storage ---------- */

const NAME = /^[a-z0-9][a-z0-9_-]{0,39}$/;
// `wb tracker <name>` shows one, so a tracker can't be named like a subcommand.
const RESERVED = new Set(["add", "edit", "show", "refresh", "rm", "remove", "set", "help"]);

function view(row: Row): Tracker {
	const { options, reading, running_since, rev: _rev, ...rest } = row;
	let parsed: Reading | null = null;
	try {
		parsed = reading ? (JSON.parse(reading) as Reading) : null;
	} catch {}
	const meters: MeterView[] = (parsed?.meters ?? []).map((m) => {
		const mv: MeterView = { ...m, level: "" };
		if (mv.unit === undefined && row.unit) mv.unit = row.unit;
		if (mv.max === undefined && row.max !== null && mv.value !== undefined) mv.max = row.max;
		try {
			mv.level = meterLevel(mv, row.warn, row.bad);
		} catch {}
		if (mv.value !== undefined && mv.max) mv.pct = Math.round((mv.value / mv.max) * 1000) / 10;
		if (mv.value !== undefined && mv.max !== undefined) mv.left = Math.round((mv.max - mv.value) * 100) / 100;
		return mv;
	});
	const reads = row.kind !== "manual" && row.every > 0;
	const now = Date.now();
	const stale =
		reads && !!row.read_at && now - fromSql(row.read_at).getTime() > Math.max(3 * row.every, row.every + 600) * 1000;
	const leased = !!running_since && now - fromSql(running_since).getTime() < LEASE_MINUTES * 60e3;
	let opts: Record<string, string> = {};
	try {
		opts = JSON.parse(options || "{}");
	} catch {}
	return {
		...rest,
		ref: row.project ? `${row.project}/${row.name}` : row.name,
		options: opts,
		reading: parsed ? { ...parsed, meters, url: parsed.url || row.url || undefined } : null,
		level: worst(meters.map((m) => m.level)),
		stale,
		running: leased,
		due_at: reads ? (row.checked_at ? sqlTime(new Date(fromSql(row.checked_at).getTime() + row.every * 1000)) : sqlTime(new Date())) : null,
	};
}

const ORDER = "ORDER BY project = '', project, sort, title COLLATE NOCASE, id";

/** A project's trackers and the global ones (global last), or every tracker when no project is given. */
export function listTrackers(db: Db, project?: string): Tracker[] {
	const rows = project
		? db.query(`SELECT * FROM trackers WHERE project IN ('', ?) ${ORDER}`).all(project)
		: db.query(`SELECT * FROM trackers ${ORDER}`).all();
	return (rows as Row[]).map(view);
}

export function getTracker(db: Db, id: number): Tracker | undefined {
	const row = db.query("SELECT * FROM trackers WHERE id = ?").get(id) as Row | null;
	return row ? view(row) : undefined;
}

/**
 * A tracker by `project/name`, `name` or id. A bare name means the project's own tracker first (when a project
 * is given), then the global one, then the only tracker anywhere with that name.
 */
export function resolveTracker(db: Db, ref: string, project?: string): Tracker {
	const s = String(ref ?? "").trim();
	if (!s) throw new Error("which tracker? (wb trackers)");
	if (/^\d+$/.test(s)) {
		const t = getTracker(db, Number(s));
		if (t) return t;
	}
	const at = s.indexOf("/");
	const [p, name] = at > 0 ? [s.slice(0, at), s.slice(at + 1)] : [undefined, s];
	const one = (pr: string) => db.query("SELECT * FROM trackers WHERE project = ? AND name = ?").get(pr, name.toLowerCase()) as Row | null;
	if (p !== undefined) {
		const row = one(p === "global" || p === "*" ? "" : p);
		if (!row) throw new Error(`no tracker "${s}" (wb trackers)`);
		return view(row);
	}
	const row = (project ? one(project) : null) ?? one("");
	if (row) return view(row);
	const any = db.query("SELECT * FROM trackers WHERE name = ?").all(name.toLowerCase()) as Row[];
	if (any.length === 1) return view(any[0]);
	if (any.length > 1)
		throw new Error(`"${name}" is in ${any.map((r) => r.project).join(", ")}: say which, e.g. ${any[0].project}/${name}`);
	throw new Error(`no tracker "${s}"${project ? ` in ${project} or global` : ""} (wb trackers)`);
}

function checkFields(db: Db, t: TrackerPatch, kind: string) {
	if (t.project !== undefined && t.project && !db.query("SELECT 1 FROM projects WHERE slug = ?").get(t.project))
		throw new Error(`no project "${t.project}"`);
	if (t.name !== undefined) {
		if (!NAME.test(t.name)) throw new Error("a tracker name is lowercase letters, digits, - and _ (up to 40), e.g. eas-builds");
		if (RESERVED.has(t.name)) throw new Error(`"${t.name}" is a wb tracker subcommand; pick another name`);
		if (/^\d+$/.test(t.name)) throw new Error("a tracker name needs a letter (a bare number reads as an id)");
	}
	if (t.title !== undefined && (!t.title.trim() || t.title.length > 80)) throw new Error("a title is 1 to 80 characters");
	if (!TRACKER_KINDS.includes(kind as never))
		throw new Error(`kind must be one of ${TRACKER_KINDS.join(", ")}`);
	if (t.command !== undefined && (t.command.length > 4000 || t.command.includes("\0")))
		throw new Error("the command is too long");
	if (t.every !== undefined && (!Number.isInteger(t.every) || (t.every !== 0 && (t.every < EVERY_MIN || t.every > EVERY_MAX))))
		throw new Error("the interval is 1 minute to 30 days (or off)");
	if (t.warn !== undefined) parseThreshold(t.warn);
	if (t.bad !== undefined) parseThreshold(t.bad);
	if (t.unit !== undefined && t.unit.length > 16) throw new Error("a unit is up to 16 characters");
	if (t.max !== undefined && t.max !== null && (!Number.isFinite(t.max) || t.max < 0)) throw new Error("max is a number, 0 or more");
	if (t.url && !/^https?:\/\//.test(t.url)) throw new Error("url must start with http:// or https://");
	if (t.sort !== undefined && !Number.isInteger(t.sort)) throw new Error("sort is a whole number");
	if (t.options !== undefined) {
		const preset = PRESETS[kind];
		for (const [k, v] of Object.entries(t.options)) {
			if (!preset || !Object.hasOwn(preset.options, k))
				throw new Error(
					preset
						? `${kind} takes the options ${Object.keys(preset.options).join(", ") || "(none)"}, not "${k}"`
						: `only presets take options (${Object.keys(PRESETS).join(", ")})`,
				);
			if (typeof v !== "string" || v.length > 200) throw new Error(`option ${k} is a string up to 200 characters`);
		}
	}
}

export function addTracker(db: Db, t: TrackerInput): Tracker {
	const kind = t.kind ?? (t.command ? "command" : "manual");
	const preset = PRESETS[kind];
	const input: TrackerInput = {
		...t,
		project: t.project ?? "",
		name: (t.name ?? "").trim().toLowerCase(),
		title: (t.title ?? "").trim() || preset?.title || t.name,
		kind,
		command: (t.command ?? "").trim(),
		options: Object.fromEntries(Object.entries(t.options ?? {}).filter(([, v]) => v !== "")),
		every: t.every ?? (kind === "manual" ? 0 : (preset?.every ?? 3600)),
		warn: (t.warn ?? "").trim(),
		bad: (t.bad ?? "").trim(),
		unit: (t.unit ?? preset?.unit ?? "").trim(),
		max: t.max ?? null,
		url: (t.url ?? "").trim(),
	};
	checkFields(db, input, kind);
	checkThresholds(input.warn!, input.bad!);
	if (kind === "command" && !input.command) throw new Error("a command tracker needs --command");
	if (kind !== "command" && input.command) throw new Error("only a command tracker takes a command");
	if (db.query("SELECT 1 FROM trackers WHERE project = ? AND name = ?").get(input.project!, input.name))
		throw new Error(`there is already a tracker "${input.name}" ${input.project ? `in ${input.project}` : "(global)"}`);
	const { next } = db
		.query("SELECT COALESCE(MAX(sort), 0) + 1 AS next FROM trackers WHERE project = ?")
		.get(input.project!) as { next: number };
	const { id } = db
		.query(
			`INSERT INTO trackers (project, name, title, kind, command, options, every, warn, bad, unit, max, url, sort)
			VALUES ($project, $name, $title, $kind, $command, $options, $every, $warn, $bad, $unit, $max, $url, $sort) RETURNING id`,
		)
		.get({
			project: input.project!,
			name: input.name,
			title: input.title!,
			kind,
			command: input.command!,
			options: JSON.stringify(input.options),
			every: input.every!,
			warn: input.warn!,
			bad: input.bad!,
			unit: input.unit!,
			max: input.max ?? null,
			url: input.url!,
			sort: next,
		}) as { id: number };
	return getTracker(db, id)!;
}

/**
 * Changes a tracker. Options are merged into the current ones ("" removes one) unless the kind changes. A change to
 * how it reads (kind, command, options) clears the error, makes it due now, and outdates a run in progress.
 */
export function updateTracker(db: Db, id: number, patch: TrackerPatch): Tracker {
	const before = db.query("SELECT * FROM trackers WHERE id = ?").get(id) as Row | null;
	if (!before) throw new Error(`no tracker #${id}`);
	// A command given to a tracker of another kind makes it a command tracker.
	const kind = patch.kind ?? (patch.command?.trim() && before.kind !== "command" ? "command" : before.kind);
	const kindChanged = kind !== before.kind;
	const p: TrackerPatch = { ...patch };
	for (const k of ["name", "title", "command", "warn", "bad", "unit", "url"] as const)
		if (typeof p[k] === "string") p[k] = (p[k] as string).trim();
	if (p.name) p.name = p.name.toLowerCase();
	if (kindChanged) {
		// Drop what only the old kind used, and give a tracker that starts reading itself an interval.
		if (kind !== "command") p.command = "";
		p.options ??= {};
		if (p.every === undefined) {
			if (kind === "manual") p.every = 0;
			else if (before.every === 0) p.every = PRESETS[kind]?.every ?? 3600;
		}
	}
	checkFields(db, p, kind);
	checkThresholds(p.warn ?? before.warn, p.bad ?? before.bad);
	if (p.options !== undefined) {
		let base: Record<string, string> = {};
		try {
			if (!kindChanged) base = JSON.parse(before.options || "{}");
		} catch {}
		const merged = { ...base, ...p.options };
		for (const [k, v] of Object.entries(merged)) if (v === "") delete merged[k];
		p.options = merged;
	}
	const command = p.command ?? before.command;
	if (kind === "command" && !command) throw new Error("a command tracker needs a command");
	if (kind !== "command" && command) throw new Error("only a command tracker takes a command");
	const project = p.project ?? before.project;
	const name = p.name ?? before.name;
	if ((project !== before.project || name !== before.name) && db.query("SELECT 1 FROM trackers WHERE project = ? AND name = ?").get(project, name))
		throw new Error(`there is already a tracker "${name}" ${project ? `in ${project}` : "(global)"}`);
	const cols: Record<string, string | number | null> = {};
	for (const k of ["project", "name", "title", "kind", "command", "every", "warn", "bad", "unit", "url", "sort"] as const)
		if (p[k] !== undefined) cols[k] = p[k] as string | number;
	if (p.max !== undefined) cols.max = p.max;
	if (p.options !== undefined) cols.options = JSON.stringify(p.options);
	if (kindChanged) cols.kind = kind;
	else delete cols.kind;
	const keys = Object.keys(cols);
	if (!keys.length) return view(before);
	const rereads =
		(cols.kind !== undefined && cols.kind !== before.kind) ||
		(cols.command !== undefined && cols.command !== before.command) ||
		(cols.options !== undefined && cols.options !== before.options);
	db.query(
		`UPDATE trackers SET ${keys.map((k) => `${k} = $${k}`).join(", ")}, updated_at = datetime('now')
		${rereads ? ", checked_at = NULL, error = '', rev = rev + 1" : ""} WHERE id = $id`,
	).run({ ...cols, id });
	return getTracker(db, id)!;
}

export function removeTracker(db: Db, id: number) {
	if (!db.query("DELETE FROM trackers WHERE id = ?").run(id).changes) throw new Error(`no tracker #${id}`);
}

/**
 * Keeps a reading: the tracker's current one, and in its history when it differs from the one before. With `rev`
 * (a run's), only if the tracker still reads the way it did when the run started; otherwise the run's lease is
 * just let go and false comes back.
 */
function store(db: Db, id: number, reading: Reading, author: string, rev?: number): boolean {
	const json = JSON.stringify(reading);
	return db.transaction(() => {
		const prev = db.query("SELECT reading, rev FROM trackers WHERE id = ?").get(id) as { reading: string | null; rev: number } | null;
		if (!prev) return false;
		if (rev !== undefined && prev.rev !== rev) {
			db.query("UPDATE trackers SET running_since = NULL WHERE id = ?").run(id);
			return false;
		}
		db.query(
			`UPDATE trackers SET reading = ?, read_at = datetime('now'), checked_at = datetime('now'), error = '',
			running_since = NULL WHERE id = ?`,
		).run(json, id);
		if (prev.reading === json) return true;
		db.query("INSERT INTO tracker_history (tracker_id, reading, author) VALUES (?, ?, ?)").run(id, json, author);
		db.query(
			`DELETE FROM tracker_history WHERE tracker_id = $id AND id <= (SELECT id FROM tracker_history WHERE tracker_id = $id
			ORDER BY id DESC LIMIT 1 OFFSET ${historyKeep(db)})`,
		).run({ id });
		return true;
	})();
}

/** A failed run: the error next to the last good reading, under the same rule as store. */
function storeError(db: Db, id: number, error: string, rev: number): boolean {
	const msg = error.replace(/\s+/g, " ").slice(0, 500);
	if (db.query("UPDATE trackers SET checked_at = datetime('now'), error = ?, running_since = NULL WHERE id = ? AND rev = ?").run(msg, id, rev).changes)
		return true;
	db.query("UPDATE trackers SET running_since = NULL WHERE id = ?").run(id);
	return false;
}

/**
 * Records a reading of a manual tracker: a Reading, or text as a command would print it ("12/15",
 * "Android 12/15\niOS 3/15", JSON).
 */
export function recordReading(db: Db, id: number, reading: Reading | string, author = ""): Tracker {
	const t = getTracker(db, id);
	if (!t) throw new Error(`no tracker #${id}`);
	if (t.kind !== "manual")
		throw new Error(`${t.ref} reads itself (${t.kind}): refresh it instead of recording a reading`);
	store(db, id, cleanReading(typeof reading === "string" ? parseReading(reading) : reading), author);
	return getTracker(db, id)!;
}

export type HistoryPoint = { at: string; reading: Reading; author: string };

export function trackerHistory(db: Db, id: number, limit = 200): HistoryPoint[] {
	const rows = db
		.query("SELECT at, reading, author FROM tracker_history WHERE tracker_id = ? ORDER BY id DESC LIMIT ?")
		.all(id, Math.max(1, Math.min(limit, historyKeep(db)))) as { at: string; reading: string; author: string }[];
	return rows.reverse().flatMap((r) => {
		try {
			return [{ at: r.at, reading: JSON.parse(r.reading) as Reading, author: r.author }];
		} catch {
			return [];
		}
	});
}

/* ---------- Running ---------- */

export type Captured = { out: string; err: string; code: number | "timeout" };

/**
 * Runs argv in its own process group (setsid) and collects its output. It ends at `timeout`: then the group is
 * killed and the pipes are let go, even when something it started left the group and still holds them open.
 * After the command exits, whatever it left running gets a second to finish writing, then the group is killed.
 */
export async function capture(
	argv: string[],
	{ cwd, env, timeout, signal }: { cwd: string; env: Record<string, string | undefined>; timeout: number; signal?: AbortSignal },
): Promise<Captured> {
	const p = Bun.spawn(Bun.which("setsid") ? ["setsid", ...argv] : argv, { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
	const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
	let total = 0;
	const drain = async (s: ReadableStream<Uint8Array>) => {
		const r = s.getReader();
		readers.push(r);
		const parts: Uint8Array[] = [];
		for (;;) {
			const { done, value } = await r.read();
			if (done) break;
			total += value.length;
			if (total > OUTPUT_MAX) throw new Error("it printed over 1 MB");
			parts.push(value);
		}
		return Buffer.concat(parts).toString("utf8");
	};
	const stop = () => {
		try {
			process.kill(-p.pid, "SIGKILL");
		} catch {
			try {
				p.kill("SIGKILL");
			} catch {}
		}
		// A cancelled reader ends its pending read as done, so drain returns what came so far.
		for (const r of readers) r.cancel().catch(() => {});
	};
	const output = Promise.all([drain(p.stdout), drain(p.stderr)]);
	output.catch(() => {});
	const timers: ReturnType<typeof setTimeout>[] = [];
	const after = <T>(ms: number, v: T) => new Promise<T>((res) => timers.push(setTimeout(() => res(v), ms)));
	const aborted = new Promise<"timeout">((res) => signal?.addEventListener("abort", () => res("timeout"), { once: true }));
	try {
		const code = await Promise.race([p.exited, after(timeout, "timeout" as const), aborted, output.then(() => p.exited)]);
		if (code === "timeout") {
			stop();
			const [out, err] = await output.catch(() => ["", ""]);
			return { out, err, code };
		}
		if ((await Promise.race([output.then(() => "done" as const), after(1000, "late" as const)])) === "late") stop();
		const [out, err] = await output;
		return { out, err, code };
	} catch (e) {
		stop();
		throw e;
	} finally {
		for (const t of timers) clearTimeout(t);
	}
}

let loginPath: Promise<string> | undefined;

/**
 * The PATH of the user's own shell. The board usually runs as a systemd service with a short PATH, without
 * ~/.bun/bin, nvm's node and the like, where `eas` or `gh` may live; commands should find what the terminal finds.
 */
export function shellPath(): Promise<string> {
	loginPath ??= (async () => {
		let found = "";
		try {
			const { out } = await capture([process.env.SHELL || "/bin/bash", "-ilc", 'printf "\\n__WB_PATH__%s__WB_END__\\n" "$PATH"'], {
				cwd: homedir(),
				env: { ...process.env, TERM: "dumb" },
				timeout: 5000,
			});
			found = out.match(/__WB_PATH__(.*?)__WB_END__/)?.[1] ?? "";
		} catch {}
		const parts = [...found.split(":"), ...(process.env.PATH ?? "").split(":")].filter(Boolean);
		return [...new Set(parts)].join(":");
	})();
	return loginPath;
}

/** Runs `cmd` with bash; resolves stdout, rejects with the exit code and the last lines it printed. */
export async function runShell(
	cmd: string,
	{ cwd, env = {}, timeout = RUN_TIMEOUT_MS, signal }: { cwd: string; env?: Record<string, string>; timeout?: number; signal?: AbortSignal },
): Promise<string> {
	const { out, err, code } = await capture(["bash", "-c", cmd], {
		cwd,
		env: { ...process.env, PATH: await shellPath(), NO_COLOR: "1", ...env },
		timeout,
		signal,
	});
	if (signal?.aborted) throw new Error("stopped");
	if (code === "timeout") throw new Error(`no answer within ${timeout / 1000} s`);
	if (code !== 0) {
		const tail = (err.trim() || out.trim()).split("\n").slice(-3).join(" · ").slice(0, 300);
		throw new Error(`exit ${code}${tail ? `: ${tail}` : ""}`);
	}
	return out;
}

/** Where a tracker's command runs: its project's folder, or home for a global one. */
function workDir(db: Db, project: string) {
	const p = project ? (db.query("SELECT path FROM projects WHERE slug = ?").get(project) as { path: string } | null) : null;
	return p?.path && existsSync(p.path) ? p.path : homedir();
}

async function read(db: Db, t: Tracker, signal: AbortSignal): Promise<Reading> {
	const cwd = workDir(db, t.project);
	const env = { WB_TRACKER: t.name, WB_PROJECT: t.project };
	if (t.kind === "command") return parseReading(await runShell(t.command, { cwd, env, signal }));
	const preset = PRESETS[t.kind];
	if (!preset) throw new Error(`unknown kind ${t.kind}`);
	const ctx: PresetContext = {
		cwd,
		options: Object.fromEntries(Object.entries(preset.options).map(([k, o]) => [k, t.options[k] || o.default || ""])),
		run: (cmd) => runShell(cmd, { cwd, env, signal }),
	};
	return preset.read(ctx);
}

/** Takes the tracker's lease; its rev when it got it, null when another run holds it. */
function lease(db: Db, id: number): number | null {
	const row = db
		.query(
			`UPDATE trackers SET running_since = datetime('now') WHERE id = ?
			AND (running_since IS NULL OR running_since < datetime('now', '-${LEASE_MINUTES} minutes')) RETURNING rev`,
		)
		.get(id) as { rev: number } | null;
	return row ? row.rev : null;
}

// Runs of this process, so a process that's shutting down can stop them and give their leases back.
const runs = new Map<number, AbortController>();
let stopping = false;

/** Stops this process's runs (their process groups too) and lets go of their leases. For a clean exit. */
export function stopRuns(db: Db) {
	stopping = true;
	for (const [id, ac] of runs) {
		ac.abort();
		db.query("UPDATE trackers SET running_since = NULL WHERE id = ?").run(id);
	}
}

/**
 * Reads a tracker now and keeps the result: the new reading, or the error next to the last good one. When
 * another process is already reading it, waits for that run instead; when an edit outdated a run, reads again.
 */
export async function refreshTracker(db: Db, id: number, author = "workbench"): Promise<Tracker> {
	const gone = () => new Error(`no tracker #${id} (it was removed)`);
	for (let attempt = 0; ; attempt++) {
		const first = getTracker(db, id);
		if (!first) throw gone();
		if (first.kind === "manual") throw new Error(`${first.ref} is manual: record a reading with wb track ${first.ref} <value>`);
		const rev = lease(db, id);
		if (rev === null) {
			for (let i = 0; i < (RUN_TIMEOUT_MS + 15_000) / 500 && getTracker(db, id)?.running; i++) await Bun.sleep(500);
			const now = getTracker(db, id);
			if (!now) throw gone();
			// That run's reading stands, unless an edit made it moot (then checked_at was cleared): read again, once.
			if (now.checked_at || attempt > 0) return now;
			continue;
		}
		const t = getTracker(db, id)!;
		const ac = new AbortController();
		runs.set(id, ac);
		let kept: boolean;
		try {
			kept = store(db, id, cleanReading(await read(db, t, ac.signal)), author, rev);
		} catch (e) {
			if (stopping) throw e;
			kept = storeError(db, id, String((e as Error).message || e), rev);
		} finally {
			runs.delete(id);
		}
		const after = getTracker(db, id);
		if (!after) throw gone();
		if (kept || attempt > 0) return after;
	}
}

/** Trackers whose interval has passed since they were last tried, oldest first. */
export function dueTrackers(db: Db): number[] {
	return (
		db
			.query(
				`SELECT id FROM trackers WHERE kind != 'manual' AND every > 0
				AND project NOT IN (SELECT slug FROM projects WHERE archived_at IS NOT NULL)
				AND (checked_at IS NULL OR checked_at <= datetime('now', '-' || every || ' seconds'))
				AND (running_since IS NULL OR running_since < datetime('now', '-${LEASE_MINUTES} minutes'))
				ORDER BY checked_at IS NOT NULL, checked_at`,
			)
			.all() as { id: number }[]
	).map((r) => r.id);
}

/** Reads every due tracker, a few at a time. What the board does every half minute. */
export async function runDue(db: Db, concurrency = 3): Promise<Tracker[]> {
	const queue = dueTrackers(db);
	const done: Tracker[] = [];
	await Promise.all(
		Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
			for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
				// Removed or made manual since it was found due: nothing to do.
				try {
					done.push(await refreshTracker(db, id));
				} catch {}
			}
		}),
	);
	return done;
}

/* ---------- Text, for the CLI and agents ---------- */

export const fmtNum = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 2 });

export function meterText(m: MeterView): string {
	if (m.value === undefined) return m.label ? `${m.label}: ${m.text ?? ""}` : (m.text ?? "");
	const label = m.label ? `${m.label} ` : "";
	const cur = ["$", "€", "£"].includes(m.unit ?? "") ? m.unit! : "";
	const n = (x: number) => `${cur}${fmtNum(x)}`;
	const unit = !m.unit || cur ? "" : m.unit === "%" ? "%" : ` ${m.unit}`;
	const of = m.max !== undefined ? `/${n(m.max)}` : "";
	const left = m.left !== undefined && m.max ? `, ${n(m.left)} left` : "";
	const level = m.level && m.level !== "ok" ? ` [${m.level}]` : "";
	return `${label}${n(m.value)}${of}${unit}${left}${level}${m.text ? ` · ${m.text}` : ""}`;
}

const day = (iso: string) => iso.slice(0, 10);

export function trackerText(t: Tracker): string {
	const meters = t.reading ? t.reading.meters.map(meterText).join(" · ") : "no reading yet";
	const extra = [
		t.reading?.resets_at ? `resets ${day(t.reading.resets_at)}` : "",
		t.reading?.note ?? "",
		t.error ? `ERROR: ${t.error}` : "",
		t.stale ? "stale" : "",
	].filter(Boolean);
	return `${meters}${extra.length ? ` · ${extra.join(" · ")}` : ""}`;
}

export function describeSource(t: Pick<Tracker, "kind" | "command" | "every" | "options">): string {
	if (t.kind === "manual") return "manual (wb track)";
	const how = t.kind === "command" ? `command: ${t.command}` : `${PRESETS[t.kind]?.title ?? t.kind}${Object.keys(t.options).length ? ` (${Object.entries(t.options).map(([k, v]) => `${k}=${v}`).join(", ")})` : ""}`;
	return `${how} · ${formatEvery(t.every)}`;
}
