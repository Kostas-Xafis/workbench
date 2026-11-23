import type { Server } from "bun";
// Embedded when compiled (bun build --compile), plain file paths under `bun server.ts`. (bun's types call an .html import a bundle.)
import pagePath from "../ui/index.html" with { type: "file" };
import usagePath from "../ui/usage.html" with { type: "file" };
import iconPath from "../ui/icon.svg" with { type: "file" };
// Pairing a phone (devices.ts): its page, and the app icons a phone puts on its home screen.
import pairPath from "../ui/pair.html" with { type: "file" };
import icon256Path from "../src-tauri/icons/256x256.png" with { type: "file" };
import icon512Path from "../src-tauri/icons/icon.png" with { type: "file" };
import pkg from "../package.json";
import { backup, DB_PATH, listBackups, open, tidy } from "./db";
import { deviceCookie, Pairing, phoneGate } from "./devices";
import { checkUi, uiFile } from "./ui";
import { publishDays } from "./day";
import { applyDue } from "./asks";
import { lanUrls } from "./health";
import { startUpdateChecks } from "./updates";
import { resumeShares } from "./share";
import { pollRuns, sendUnblocked } from "./dispatch";
import { refreshUsage } from "./usage";
import { runDue } from "./trackers";
import { boardRoutes, PAIR_OPEN, type BoardFile, type BoardHost } from "./routes";
import { readSync, type SyncConfig } from "./sync";
import { startHelper } from "./helper";

export const PORT = Number(process.env.WB_PORT ?? 4321);
// The compiled binary (bun build --compile) runs from bun's embedded file system.
const COMPILED = Bun.main.startsWith("/$bunfs/") || Bun.main.includes("~BUN");

/** The board on this computer: the routes (routes.ts) under Bun.serve, and the jobs that keep it current. */
export function serve({ lan = false } = {}) {
	const db = open();
	checkUi().catch(() => {});
	// The first read of Claude's transcripts takes seconds, so it starts now rather than when the page is opened.
	refreshUsage().catch(() => {});
	const loopback = (req: Request, srv: Server<unknown>) =>
		["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(srv.requestIP(req)?.address ?? "");
	// Calls that act with a stored secret (data sources) come only from the board's own page on this computer:
	// a loopback peer, a localhost Host (no DNS rebinding), and a same-origin JSON request (no other site's form).
	const boardOnly = (req: Request, srv: Server<unknown>) => {
		const host = req.headers.get("host") ?? "";
		const site = req.headers.get("sec-fetch-site");
		const origin = req.headers.get("origin");
		return (
			loopback(req, srv) &&
			/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host) &&
			(!site || site === "same-origin") &&
			(!origin || origin === `http://${host}`) &&
			(req.headers.get("content-type") ?? "").startsWith("application/json")
		);
	};
	// Reads that are this computer's business (settings, health, backups, shares, the vault's info): a loopback peer, a
	// localhost Host, and not another site's page — not even one that points its own name at 127.0.0.1 (DNS
	// rebinding). Opening such a link from the board, or typing it in, is fine.
	const localRead = (req: Request, srv: Server<unknown>) => {
		const site = req.headers.get("sec-fetch-site");
		return (
			loopback(req, srv) &&
			/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(req.headers.get("host") ?? "") &&
			(!site || site === "same-origin" || site === "none")
		);
	};

	// A backup when the newest is a day old: checked at start and every hour. Right after it, what Settings → Data
	// says not to keep goes (old backups, report versions, tracker readings, closed items), so the backup still has it.
	const nightly = () => {
		try {
			const last = listBackups()[0];
			if (last && Date.now() - last.at.getTime() < 23 * 3600e3) return;
			console.log(`backup: ${backup(db)}`);
			const gone = tidy(db);
			if (Object.values(gone).some(Boolean)) console.log(`tidy: ${JSON.stringify(gone)}`);
		} catch (e) {
			console.error(`backup failed: ${(e as Error).message}`);
		}
	};
	nightly();
	setInterval(nightly, 3600e3);

	// Every project's day pages ("Days" in its sidebar): today's kept current every 30 min, and the last week's
	// finished once their day is over (also after the board or the computer was off).
	let daysRunning = false;
	const days = async () => {
		if (daysRunning) return;
		daysRunning = true;
		try {
			for (const d of await publishDays(db)) console.log(`day: ${d.project} ${d.day} v${d.n}`);
		} catch (e) {
			console.error(`day pages failed: ${(e as Error).message}`);
		} finally {
			daysRunning = false;
		}
	};
	setTimeout(days, 10e3);
	setInterval(days, 30 * 60e3);

	// Status trackers that read themselves: every half minute, the ones whose interval has passed (trackers.ts).
	let trackersRunning = false;
	const trackers = async () => {
		if (trackersRunning) return;
		trackersRunning = true;
		try {
			for (const t of await runDue(db)) if (t.error) console.error(`tracker ${t.ref}: ${t.error}`);
		} catch (e) {
			console.error(`trackers failed: ${(e as Error).message}`);
		} finally {
			trackersRunning = false;
		}
	};
	setTimeout(trackers, 5e3);
	setInterval(trackers, 30e3);

	// Asks whose deadline passed with no answer: their default goes ahead (asks.ts). Every minute, and at start.
	const due = () => {
		for (const ref of applyDue(db)) console.log(`ask: wb-${ref} went ahead with its default`);
	};
	due();
	setInterval(due, 60e3);

	// Phones (devices.ts): a request from another address needs a paired device's token, except on the routes that
	// pair one (PAIR_OPEN). The page and its scripts, the API, reports, images: everything else.
	const pairing = new Pairing();
	const gate = phoneGate(db, { port: PORT, loopback, open: PAIR_OPEN });

	// Every 2 s: new output into the runs' tails, and the end of those whose process is gone (also the ones that ended
	// while the board was off: the first look is now). Unblocked work is sent from here when Settings says so.
	let runsBusy = false;
	const watchRuns = async () => {
		if (runsBusy) return;
		runsBusy = true;
		try {
			pollRuns(db);
			await sendUnblocked(db);
		} catch (e) {
			console.error(`agents: ${(e as Error).message}`);
		} finally {
			runsBusy = false;
		}
	};
	watchRuns();
	setInterval(watchRuns, 2000);

	const files: Record<BoardFile, string> = {
		page: pagePath as unknown as string,
		usage: usagePath as unknown as string,
		icon: iconPath,
		pair: pairPath as unknown as string,
		"icon-256.png": icon256Path,
		"icon-512.png": icon512Path,
	};
	const host: BoardHost = {
		db,
		cloud: false,
		port: PORT,
		lan,
		compiled: COMPILED,
		loopback,
		localRead,
		boardOnly,
		gate,
		pairing,
		pairUrls: () => lanUrls(PORT),
		cookie: (token) => deviceCookie(PORT, token),
		sleep: Bun.sleep,
		file: (name) => Bun.file(files[name]),
		uiFile,
		ping: () => ({ app: "workbench", version: pkg.version, db: DB_PATH, pid: process.pid, lan }),
	};

	const server = Bun.serve({
		port: PORT,
		// Loopback unless asked. On the network, only phones paired in Settings get in (the gate above).
		hostname: lan ? "0.0.0.0" : "127.0.0.1",
		// The first look at pull requests per project can take gh several seconds.
		idleTimeout: 30,
		routes: gate.routes(boardRoutes(host)),
		fetch: (req, srv) => gate.check(req, srv) ?? new Response("not found", { status: 404 }),
	});
	// Shares outlive the board (see share.ts): take back the ones still running, close the expired ones.
	resumeShares(db);
	startUpdateChecks(db);
	return server;
}

/**
 * While this computer syncs with the cloud board (sync.ts), the board isn't here: whatever starts the server (the
 * service, the desktop app's sidecar) gets one that says where it went, and never opens the database. It also runs
 * the computer helper (helper.ts), which does for the cloud board what needs this computer: one per computer, the
 * process that has the port.
 */
export function serveMoved(cfg: SyncConfig, { helper = true } = {}) {
	const page = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Workbench</title>
<style>body{font:15px/1.5 system-ui,sans-serif;max-width:34rem;margin:15vh auto;padding:0 16px;color:#1d1c1a;background:#f6f5f2}@media(prefers-color-scheme:dark){body{color:#e8e6e1;background:#1b1a18}a{color:#8fa2ff}}</style>
<h1>The board is in the cloud</h1><p>This computer syncs with the cloud board, so the board isn't here. Open it at <a href="${cfg.url}/">${cfg.url}</a>.</p>
<p><code>wb sync off</code> brings it back to this computer.</p>`;
	const server = Bun.serve({
		port: PORT,
		hostname: "127.0.0.1",
		routes: {
			"/api/ping": () => Response.json({ app: "workbench", version: pkg.version, moved: cfg.url, pid: process.pid, helper: !!running?.connected() }, { headers: { "cache-control": "no-store" } }),
		},
		fetch: (req) =>
			new URL(req.url).pathname.startsWith("/api/") || req.method !== "GET"
				? Response.json({ error: `the board is in the cloud: ${cfg.url}`, moved: cfg.url }, { status: 409 })
				: new Response(page, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } }),
	});
	const running = helper ? startHelper(cfg) : null;
	return server;
}

if (import.meta.main) {
	// A compiled binary has no source folder to keep a database in: it needs to be told (the app does).
	if (COMPILED && !process.env.WB_DB) {
		console.error("WB_DB is not set: the compiled server needs the path of the database to use.");
		process.exit(1);
	}
	const synced = readSync();
	if (synced) {
		const s = serveMoved(synced);
		console.log(`workbench: the board is in the cloud (${synced.url}); http://${s.hostname}:${s.port} says so, and the computer helper runs here`);
	} else {
		const s = serve({ lan: process.argv.includes("--lan") });
		console.log(`workbench on http://${s.hostname}:${s.port}`);
	}
}
