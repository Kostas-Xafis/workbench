/**
 * Board-wide settings: one value per key, kept in the `settings` table as JSON, the same for the board page, the
 * CLI and agents. Every key is declared below with its default and a check that cleans a value or explains what's
 * wrong; a key that isn't declared can't be stored. Settings that differ per device (theme, notifications, …) live
 * in the browser instead (`pref` in index.html), never here.
 *
 * Each section of Settings declares its keys in its own block. Key names are flat, with dots for grouping
 * (`owner.check`), and never change once shipped: the database keeps them.
 */
import type { Db } from "./db";

export type Json = string | number | boolean | null | Json[] | { [k: string]: Json };
export type Def = {
	/** What it is, in a few words; error messages start with it. */
	about: string;
	default: Json;
	/** Returns the value to store, or throws an Error that says what a good value looks like. */
	check: (v: unknown) => Json;
};
export type Defs = Record<string, Def>;

/* ---------- Checks ---------- */

export const int =
	(min: number, max: number) =>
	(v: unknown): number => {
		const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
		if (typeof n !== "number" || !Number.isInteger(n) || n < min || n > max) throw new Error(`a whole number from ${min} to ${max}`);
		return n;
	};
export const oneOf =
	<T extends Json>(...values: T[]) =>
	(v: unknown): T => {
		if (!values.includes(v as T)) throw new Error(`one of ${values.map((x) => JSON.stringify(x)).join(", ")}`);
		return v as T;
	};
export const text =
	(max: number, { empty = true } = {}) =>
	(v: unknown): string => {
		if (typeof v !== "string") throw new Error("text");
		const s = v.trim().replace(/\s+/g, " ");
		if (!empty && !s) throw new Error("can't be empty");
		if (s.length > max) throw new Error(`at most ${max} characters`);
		return s;
	};
export const bool = (v: unknown): boolean => {
	if (typeof v !== "boolean") throw new Error("true or false");
	return v;
};
/** "HH:MM", 24-hour. */
export const clock = (v: unknown): string => {
	const m = typeof v === "string" && v.trim().match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
	if (!m) throw new Error("a time like 22:00");
	return `${m[1].padStart(2, "0")}:${m[2]}`;
};

/* ---------- You and your day ---------- */
const YOU: Defs = {
};
/* ---------- end: You and your day ---------- */

/* ---------- Notifications ---------- */
// Notifications are this browser's own (prefs in index.html); declare a key here only for a board-wide one.
const NOTIFY: Defs = {
};
/* ---------- end: Notifications ---------- */

/* ---------- Data ---------- */
const DATA: Defs = {
};
/* ---------- end: Data ---------- */

/* ---------- Privacy and security ---------- */
/** The lengths a share link can be started for, in hours; the most it may run (counting extensions) is one of them too. */
export const SHARE_HOURS = [1, 2, 4, 8, 12, 24];
const PRIVACY: Defs = {
	// Used by the vault in the page (index.html), read whenever one of its timers starts.
	"vault.lock-minutes": { about: "Vault locks after this many idle minutes", default: 5, check: int(1, 60) },
	"vault.show-seconds": { about: "A shown secret hides after this many seconds", default: 20, check: int(5, 120) },
	// share.ts. The start length is capped by the most at the moment of use, so the two never disagree.
	"share.default-hours": { about: "Share links start at this many hours", default: 1, check: oneOf(...SHARE_HOURS) },
	"share.max-hours": { about: "A share link runs at most this many hours", default: 8, check: oneOf(...SHARE_HOURS) },
};
/* ---------- end: Privacy and security ---------- */

/* ---------- Appearance ---------- */
// Appearance is this browser's own (prefs in index.html); declare a key here only for a board-wide one.
const LOOK: Defs = {
};
/* ---------- end: Appearance ---------- */

export const SETTINGS: Defs = { ...YOU, ...NOTIFY, ...DATA, ...PRIVACY, ...LOOK };

/* ---------- Storage ---------- */

export function createSettingsTable(db: Db) {
	db.run(`CREATE TABLE IF NOT EXISTS settings (
		key TEXT PRIMARY KEY,
		value TEXT NOT NULL,
		updated_at TEXT NOT NULL DEFAULT (datetime('now'))
	)`);
}

/** Every declared setting: the stored value, or its default. A stored value that no longer passes its check
 * (e.g. a range that narrowed) reads as the default. */
export function getSettings(db: Db): Record<string, Json> {
	const stored = new Map(
		(db.query("SELECT key, value FROM settings").all() as { key: string; value: string }[]).map((r) => [r.key, r.value]),
	);
	const out: Record<string, Json> = {};
	for (const [key, def] of Object.entries(SETTINGS)) {
		out[key] = def.default;
		const raw = stored.get(key);
		if (raw === undefined) continue;
		try {
			out[key] = def.check(JSON.parse(raw));
		} catch {}
	}
	return out;
}

export function getSetting<T extends Json = Json>(db: Db, key: string): T {
	const def = SETTINGS[key];
	if (!def) throw new Error(`no setting "${key}"`);
	const row = db.query("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | null;
	if (!row) return def.default as T;
	try {
		return def.check(JSON.parse(row.value)) as T;
	} catch {
		return def.default as T;
	}
}

/** Sets several at once, all or none; `null` puts a key back to its default. Returns every setting. */
export function updateSettings(db: Db, patch: Record<string, unknown>): Record<string, Json> {
	if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new Error("settings: an object of key: value");
	const writes: [string, string | null][] = [];
	for (const [key, v] of Object.entries(patch)) {
		const def = SETTINGS[key];
		if (!def) throw new Error(`no setting "${key}"`);
		if (v === null) {
			writes.push([key, null]);
			continue;
		}
		let value: Json;
		try {
			value = def.check(v);
		} catch (e) {
			throw new Error(`${def.about}: ${(e as Error).message}`);
		}
		writes.push([key, JSON.stringify(value)]);
	}
	const set = db.query(
		"INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')",
	);
	const del = db.query("DELETE FROM settings WHERE key = ?");
	db.transaction(() => {
		for (const [key, value] of writes) value === null ? del.run(key) : set.run(key, value);
	})();
	return getSettings(db);
}

/** What the page needs to offer "back to default" and explain a key: about and default, per key. */
export function settingDefs() {
	return Object.fromEntries(Object.entries(SETTINGS).map(([k, d]) => [k, { about: d.about, default: d.default }]));
}
