/**
 * New releases, as the server sees them: for a board opened in a plain browser, where no desktop app checks.
 *
 * The feed is the desktop app's own (the Tauri updater's latest.json on the GitHub release), read at most once a
 * day and only while the board setting `updates.check` is on. It's off by default: the board makes no call to the
 * internet on its own unless asked to, and the desktop app checks by itself anyway. "Check now" in Settings asks
 * once, whatever the setting.
 *
 * The last answer is kept in `update-check.json` next to the database, so a restart doesn't ask again the same day.
 * How to update depends on how this server runs: from source (git pull, restart), as the standalone binary
 * (download the new one), or started by the desktop app (the app updates it with itself).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import pkg from "./package.json";
import { DB_PATH, type Db } from "./db";
import { getSetting } from "./settings";

export const FEED = process.env.WB_UPDATE_FEED || "https://github.com/Kostas-Xafis/workbench/releases/latest/download/latest.json";
const DAY = 24 * 3600e3;
const STATE_FILE = join(dirname(DB_PATH), "update-check.json");

export type Latest = { version: string; notes: string; date: string | null; page: string | null };
type Saved = { at: number; latest: Latest | null; error: string | null };

let saved: Saved = load();
/** This process runs in the workbench systemd user unit (its cgroup ends in /workbench.service). */
const UNDER_SERVICE = (() => {
	try {
		return /\/workbench\.service$/m.test(readFileSync("/proc/self/cgroup", "utf8"));
	} catch {
		return false;
	}
})();
let inFlight: Promise<Saved> | null = null;

function load(): Saved {
	try {
		if (existsSync(STATE_FILE)) {
			const s = JSON.parse(readFileSync(STATE_FILE, "utf8"));
			if (typeof s?.at === "number") return { at: s.at, latest: s.latest ?? null, error: s.error ?? null };
		}
	} catch {}
	return { at: 0, latest: null, error: null };
}

/** The release page of a version, when the feed is a GitHub release's: github.com/<owner>/<repo>/releases/tag/v<version>. */
export function releasePage(feed: string, version: string): string | null {
	const m = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/releases\//.exec(feed);
	return m ? `https://github.com/${m[1]}/${m[2]}/releases/tag/v${version}` : null;
}

/** -1, 0 or 1, comparing x.y.z (a pre-release such as 0.2.0-rc.1 counts as before 0.2.0). */
export function compareVersions(a: string, b: string): number {
	const parse = (v: string) => {
		const [core, pre = ""] = v.replace(/^v/, "").split("-", 2);
		return { nums: core.split(".").map((n) => Number(n) || 0), pre };
	};
	const x = parse(a), y = parse(b);
	for (let i = 0; i < 3; i++) {
		const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
		if (d) return Math.sign(d);
	}
	if (x.pre === y.pre) return 0;
	if (!x.pre) return 1;
	if (!y.pre) return -1;
	return x.pre < y.pre ? -1 : 1;
}

async function fetchLatest(): Promise<Saved> {
	const at = Date.now();
	try {
		const res = await fetch(FEED, { signal: AbortSignal.timeout(15e3), headers: { accept: "application/json" } });
		if (res.status === 404) return { at, latest: null, error: "No release has been published yet." };
		if (!res.ok) throw new Error(`the release feed answered HTTP ${res.status}`);
		const body = (await res.json()) as { version?: unknown; notes?: unknown; pub_date?: unknown };
		const version = typeof body.version === "string" ? body.version.replace(/^v/, "") : "";
		if (!/^\d+\.\d+\.\d+/.test(version)) throw new Error("the release feed has no version");
		return {
			at,
			latest: {
				version,
				notes: typeof body.notes === "string" ? body.notes.slice(0, 20_000) : "",
				date: typeof body.pub_date === "string" ? body.pub_date : null,
				page: releasePage(FEED, version),
			},
			error: null,
		};
	} catch (e) {
		const msg = (e as Error).name === "TimeoutError" ? "the release feed didn't answer within 15 s" : (e as Error).message;
		return { at, latest: saved.latest, error: `Couldn't check: ${msg}` };
	}
}

/** Asks the feed now (one request at a time) and keeps the answer. */
export function checkNow(): Promise<Saved> {
	inFlight ??= fetchLatest()
		.then((s) => {
			saved = s;
			try {
				writeFileSync(STATE_FILE, JSON.stringify(s) + "\n");
			} catch {}
			return s;
		})
		.finally(() => (inFlight = null));
	return inFlight;
}

/** How this server runs, and so how it's updated. */
export function howRun(compiled: boolean): "app" | "binary" | "source" {
	if (process.env.WB_APP === "1") return "app";
	return compiled ? "binary" : "source";
}

/** What Settings → Updates and the board bar show. */
export function updateInfo(db: Db, compiled: boolean) {
	const skip = getSetting<string>(db, "updates.skip");
	const latest = saved.latest;
	return {
		version: pkg.version,
		how: howRun(compiled),
		// The folder to `git pull` in, for a server run from source; the file to replace, for the standalone binary.
		folder: compiled ? null : import.meta.dir,
		exe: compiled ? process.execPath : null,
		// Run by the workbench user service, so "restart" means systemctl.
		service: UNDER_SERVICE,
		check: getSetting<boolean>(db, "updates.check"),
		checkedAt: saved.at || null,
		error: saved.error,
		latest,
		newer: !!latest && compareVersions(latest.version, pkg.version) > 0,
		skipped: skip || null,
		feed: FEED,
	};
}

/** Checks once a day while `updates.check` is on: a minute after start, then every hour asks whether a day has passed. */
export function startUpdateChecks(db: Db) {
	const tick = () => {
		if (getSetting<boolean>(db, "updates.check") && Date.now() - saved.at >= DAY) checkNow().catch(() => {});
	};
	setTimeout(tick, 60e3).unref?.();
	setInterval(tick, 3600e3).unref?.();
}
