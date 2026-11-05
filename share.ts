import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { basename, delimiter, join } from "node:path";
import type { Server } from "bun";
import {
	DB_PATH,
	getItem,
	getReport,
	listItems,
	listReports,
	projectsWithCounts,
	reportHtml,
	reportState,
	resolveItem,
	type Db,
	type ItemFilter,
} from "./db";
import { repoState } from "./git";
import { listTrackers } from "./trackers";
import { qrSvg } from "./qr";
import { REPORT_CSP, withBridge } from "./reports";

/**
 * Sharing a report through a Cloudflare quick tunnel (a random https://….trycloudflare.com address).
 *
 * The tunnel never reaches the board. Each share gets its own small server on a loopback port that serves
 * that one report, pinned to one version, plus read-only answers for its `wb` calls, limited to the report's
 * project, for 1 to 8 hours. Nothing it serves writes: `wb.state.set` answers false, `wb.open` refuses.
 * cloudflared connects from this computer, so pointing it at the board would also have opened the
 * localhost-only vault.
 *
 * A share ends only when it expires or is stopped. cloudflared runs outside the board (its own systemd scope,
 * else its own session), and the shares are written to a state file, so a board restart or crash keeps the
 * link: the board picks the tunnel back up on start and serves the report on the same port again (while the
 * board is down, the link shows Cloudflare's error page). Expiry goes by the wall clock, checked on every
 * request and every 15 s, so a share whose time ran out while the computer slept ends as soon as it wakes.
 */

/** How long a share can be started for, and the most it can be extended to, in hours. */
export const SHARE_HOURS = [1, 2, 4, 8];
export const SHARE_MAX_HOURS = 8;
const HOUR = 3600e3;
const START_TIMEOUT = 45e3;

export type ShareCheck = {
	ok: boolean;
	cloudflared: string | null;
	version: string;
	problems: string[];
	/** How to install cloudflared, when it's missing: this machine's system first, then the others. */
	install: InstallGuide[];
};

export type InstallGuide = { system: string; here: boolean; options: { how: string; cmd: string }[] };

export type ShareInfo = {
	report: number;
	version: number;
	title: string;
	project: string;
	status: "starting" | "ready" | "failed";
	url: string | null;
	/** Set once the address answered from here; it can take a few seconds to resolve. */
	reachable: boolean;
	error: string;
	startedAt: number;
	expiresAt: number;
	/** The latest it can be extended to. */
	maxAt: number;
	/** SVG of the link, for a phone to scan. */
	qr: string;
};

/** What the state file keeps per share: enough to find the tunnel again after a restart. */
type Saved = Pick<ShareInfo, "report" | "version" | "url" | "startedAt" | "expiresAt" | "maxAt"> & {
	port: number;
	pid: number;
};
type Share = ShareInfo & Saved & { db: Db; server: Server<unknown> | null; poll: Timer | null };
const shares = new Map<number, Share>();

const WINDOWS = process.platform === "win32";

// Runtime state lives in XDG_RUNTIME_DIR (gone at reboot, like the tunnels), one file per database.
const STATE_DIR =
	process.env.WB_SHARE_DIR ??
	join(
		process.env.XDG_RUNTIME_DIR || join(tmpdir(), `workbench-${WINDOWS ? userInfo().username : userInfo().uid}`),
		"workbench-shares",
	);
const STATE_FILE = join(STATE_DIR, `shares-${Bun.hash(DB_PATH).toString(36)}.json`);
const logFile = (report: number) => join(STATE_DIR, `share-${Bun.hash(DB_PATH).toString(36)}-${report}.log`);

// A service started at login gets a short PATH, so look where the installers below put cloudflared too.
const LOCAL_APP_DATA = process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
const SEARCH_PATH = [
	process.env.PATH ?? "",
	...(WINDOWS
		? [
				join(LOCAL_APP_DATA, "cloudflared"),
				join(LOCAL_APP_DATA, "Microsoft", "WinGet", "Links"),
				join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "cloudflared"),
				join(process.env.ProgramFiles || "C:\\Program Files", "cloudflared"),
			]
		: [join(homedir(), ".local/bin"), join(homedir(), "bin"), "/usr/local/bin", "/usr/bin", "/opt/homebrew/bin"]),
].join(delimiter);

const RELEASES = "https://github.com/cloudflare/cloudflared/releases/latest/download";

/** Install steps for every system cloudflared ships for, this one first (and its usual way first). */
export function installGuides(): InstallGuide[] {
	// Which system this machine is.
	let here = WINDOWS ? "Windows" : process.platform === "darwin" ? "macOS" : "Any Linux";
	if (process.platform === "linux") {
		let os = "";
		try {
			os = readFileSync("/etc/os-release", "utf8");
		} catch {}
		const ids = (os.match(/^ID(?:_LIKE)?=.*$/gm) ?? []).join(" ").toLowerCase();
		if (/debian|ubuntu|raspbian/.test(ids) || Bun.which("dpkg")) here = "deb";
		else if (/fedora|rhel|centos|rocky|suse|almalinux/.test(ids)) here = "rpm";
		else if (/arch|manjaro|endeavouros/.test(ids)) here = "arch";
	}
	// Release file names spell the architecture differently per package type. For this machine it's
	// known; the other systems' commands work it out themselves when run.
	const a = process.arch as string;
	const known = (map: Record<string, string>, fallback: string) => map[a] ?? fallback;
	const uname = (...subs: [string, string][]) =>
		`$(uname -m | sed${subs.map(([from, to]) => ` -e 's/${from}/${to}/'`).join("")})`;
	const isLinux = process.platform === "linux";
	const linux = isLinux
		? known({ x64: "amd64", arm64: "arm64", arm: "armhf", ia32: "386" }, "amd64")
		: uname(["x86_64", "amd64"], ["aarch64", "arm64"], ["armv7l", "armhf"], ["i.86", "386"]);
	const deb = isLinux ? linux : "$(dpkg --print-architecture | sed -e 's/i386/386/')";
	const rpm = isLinux
		? known({ x64: "x86_64", arm64: "aarch64", arm: "armhf", ia32: "386" }, "x86_64")
		: uname(["armv7l", "armhf"], ["i.86", "386"]);
	const mac = process.platform === "darwin" ? (a === "arm64" ? "arm64" : "amd64") : uname(["x86_64", "amd64"]);
	const win = WINDOWS && a === "ia32" ? "386" : "amd64"; // Windows on ARM runs the amd64 build
	const local = "mkdir -p ~/.local/bin";
	const all: (Omit<InstallGuide, "here"> & { key: string })[] = [
		{
			key: "deb",
			system: "Debian, Ubuntu, Mint, Raspberry Pi OS",
			options: [
				{
					how: "Package (needs sudo)",
					cmd: `curl -fsSLo /tmp/cloudflared.deb ${RELEASES}/cloudflared-linux-${deb}.deb && sudo dpkg -i /tmp/cloudflared.deb`,
				},
			],
		},
		{
			key: "rpm",
			system: "Fedora, RHEL, CentOS, Rocky, openSUSE",
			options: [
				{
					how: "Package (needs sudo)",
					cmd: `curl -fsSLo /tmp/cloudflared.rpm ${RELEASES}/cloudflared-linux-${rpm}.rpm && sudo rpm -Uvh /tmp/cloudflared.rpm`,
				},
			],
		},
		{
			key: "arch",
			system: "Arch, Manjaro, EndeavourOS",
			options: [{ how: "Package (needs sudo)", cmd: "sudo pacman -S cloudflared" }],
		},
		{
			key: "Any Linux",
			system: "Any Linux",
			options: [
				{
					how: "Just the program, for your user only (no sudo)",
					cmd: `${local} && curl -fsSLo ~/.local/bin/cloudflared ${RELEASES}/cloudflared-linux-${linux} && chmod +x ~/.local/bin/cloudflared`,
				},
			],
		},
		{
			key: "macOS",
			system: "macOS",
			options: [
				{ how: "With Homebrew", cmd: "brew install cloudflared" },
				{
					how: "Without Homebrew, for your user only",
					cmd: `${local} && curl -fsSL ${RELEASES}/cloudflared-darwin-${mac}.tgz | tar -xz -C ~/.local/bin`,
				},
			],
		},
		{
			key: "Windows",
			system: "Windows",
			options: [
				{ how: "With winget (PowerShell or Command Prompt)", cmd: "winget install --id Cloudflare.cloudflared" },
				{
					how: "Without winget, for your user only (PowerShell)",
					cmd: `New-Item -ItemType Directory -Force "$env:LOCALAPPDATA\\cloudflared" | Out-Null; Invoke-WebRequest ${RELEASES}/cloudflared-windows-${win}.exe -OutFile "$env:LOCALAPPDATA\\cloudflared\\cloudflared.exe"`,
				},
			],
		},
	];
	// The no-sudo way works on any Linux, so it's offered next to the package there.
	const guides = all.map(({ key, ...g }) => ({ ...g, key, here: key === here || (isLinux && key === "Any Linux") }));
	const first = guides.filter((g) => g.here);
	return [...first, ...guides.filter((g) => !first.includes(g))].map(({ key, ...g }) => g);
}

// Under systemd, a restart of the board's service stops every process in it; a scope of its own keeps
// cloudflared out of that. Asked once.
let scopeOk: Promise<boolean> | null = null;
function canScope() {
	scopeOk ??= (async () => {
		if (process.platform !== "linux" || !Bun.which("systemd-run")) return false;
		const p = Bun.spawn(["systemd-run", "--user", "--scope", "--quiet", "true"], {
			stdout: "ignore",
			stderr: "ignore",
		});
		return (await p.exited) === 0;
	})();
	return scopeOk;
}

/** Everything a quick tunnel needs, checked before starting one. */
export async function checkShare(): Promise<ShareCheck> {
	const problems: string[] = [];
	const bin = process.env.WB_CLOUDFLARED || Bun.which("cloudflared", { PATH: SEARCH_PATH });
	let version = "";
	if (!bin) problems.push("cloudflared isn't installed (or isn't on the PATH).");
	else {
		try {
			const p = Bun.spawn([bin, "--version"], { stdout: "pipe", stderr: "pipe" });
			const out = (await new Response(p.stdout).text()) + (await new Response(p.stderr).text());
			if ((await p.exited) !== 0) throw new Error(out.trim() || "it exited with an error");
			version = out.match(/version\s+(\S+)/i)?.[1] ?? out.trim().split("\n")[0];
		} catch (e) {
			problems.push(`cloudflared is installed at ${bin} but doesn't run: ${(e as Error).message}`);
		}
	}
	// Cloudflare's docs: quick tunnels aren't supported while a config file sits in ~/.cloudflared.
	for (const f of ["config.yml", "config.yaml"]) {
		const path = join(homedir(), ".cloudflared", f);
		if (existsSync(path))
			problems.push(`${path} exists, and quick tunnels don't run while it does. Rename it while sharing.`);
	}
	return { ok: !problems.length, cloudflared: bin, version, problems, install: bin ? [] : installGuides() };
}

const info = (s: Share): ShareInfo => ({
	report: s.report,
	version: s.version,
	title: s.title,
	project: s.project,
	status: s.status,
	url: s.url,
	reachable: s.reachable,
	error: s.error,
	startedAt: s.startedAt,
	expiresAt: s.expiresAt,
	maxAt: s.maxAt,
	qr: s.qr,
});

export function listShares(): ShareInfo[] {
	sweep();
	return [...shares.values()].map(info);
}

function save() {
	mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
	const live = [...shares.values()].filter((s) => s.status !== "failed");
	const saved: Saved[] = live.map(({ report, version, url, startedAt, expiresAt, maxAt, port, pid }) => ({
		report,
		version,
		url,
		startedAt,
		expiresAt,
		maxAt,
		port,
		pid,
	}));
	writeFileSync(STATE_FILE, JSON.stringify(saved, null, 1), { mode: 0o600 });
}

function load(): Saved[] {
	try {
		return JSON.parse(readFileSync(STATE_FILE, "utf8"));
	} catch {
		return [];
	}
}

/** True while that pid is still our cloudflared for that port (not a reused pid, not a zombie). */
function tunnelAlive(pid: number, port: number) {
	if (!pid) return false;
	try {
		process.kill(pid, 0);
	} catch {
		return false;
	}
	if (WINDOWS) {
		// tasklist names the program but not its arguments; the pid and program name have to do there.
		const row = Bun.spawnSync(["tasklist", "/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"]).stdout.toString();
		return /cloudflared/i.test(row);
	}
	const args = Bun.spawnSync(["ps", "-o", "args=", "-p", String(pid)]).stdout.toString();
	return args.includes("cloudflared") && args.includes(`127.0.0.1:${port}`);
}

function killTunnel(pid: number, port: number) {
	if (!tunnelAlive(pid, port)) return;
	try {
		process.kill(pid, "SIGTERM");
	} catch {}
	setTimeout(() => {
		if (tunnelAlive(pid, port))
			try {
				process.kill(pid, "SIGKILL");
			} catch {}
	}, 3000);
}

function readLog(report: number) {
	try {
		return readFileSync(logFile(report), "utf8");
	} catch {
		return "";
	}
}

function lastLines(report: number) {
	const errs = readLog(report)
		.split("\n")
		.filter((l) => /\b(ERR|error|failed)\b/i.test(l))
		.slice(-2);
	return errs.length ? `Last: ${errs.map((l) => l.replace(/^\S+\s+/, "")).join(" · ")}` : "";
}

/** Ends a share: the tunnel, its server, its log. Only on expiry or when asked. */
export function stopShare(report: number) {
	const s = shares.get(report);
	if (!s) return false;
	shares.delete(report);
	if (s.poll) clearInterval(s.poll);
	killTunnel(s.pid, s.port);
	s.server?.stop(true);
	rmSync(logFile(report), { force: true });
	save();
	return true;
}

function fail(s: Share, msg: string) {
	if (shares.get(s.report) !== s || s.status === "failed") return;
	s.status = "failed";
	s.error = msg;
	if (s.poll) clearInterval(s.poll);
	killTunnel(s.pid, s.port);
	s.server?.stop(true);
	save();
}

/** Ends what has expired (by the wall clock, so time asleep counts) and notices tunnels that died. */
function sweep() {
	const now = Date.now();
	for (const s of [...shares.values()]) {
		if (s.status === "failed") continue;
		if (now >= s.expiresAt) stopShare(s.report);
		else if (s.status === "ready" && !tunnelAlive(s.pid, s.port))
			fail(s, `cloudflared stopped. ${lastLines(s.report)}`);
	}
}
setInterval(sweep, 15e3).unref?.();

/** Pushes the end back by an hour, up to SHARE_MAX_HOURS after it started. */
export function extendShare(report: number): ShareInfo {
	sweep();
	const s = shares.get(report);
	if (!s || s.status === "failed") throw new Error("this report isn't being shared");
	if (s.expiresAt >= s.maxAt) throw new Error(`a share lasts at most ${SHARE_MAX_HOURS} hours`);
	s.expiresAt = Math.min(s.expiresAt + HOUR, s.maxAt);
	save();
	return info(s);
}

/** Watches cloudflared's log until the tunnel is up (or gives up), then checks the link answers. */
function watchStart(s: Share, since: number) {
	s.poll = setInterval(() => {
		if (shares.get(s.report) !== s || s.status !== "starting") return clearInterval(s.poll!);
		const log = readLog(s.report);
		const url = log.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)?.[0];
		if (url && !s.url) {
			s.url = url;
			s.qr = qrSvg(url);
			save();
		}
		if (s.url && /Registered tunnel connection/i.test(log)) {
			clearInterval(s.poll!);
			s.poll = null;
			s.status = "ready";
			probe(s);
		} else if (!tunnelAlive(s.pid, s.port)) fail(s, `cloudflared stopped. ${lastLines(s.report)}`);
		else if (Date.now() - since > START_TIMEOUT)
			fail(s, `cloudflared didn't connect within ${START_TIMEOUT / 1000} s. ${lastLines(s.report)}`);
	}, 500);
}

/** Starts sharing the report (pinned to `version`, else the latest); resolves once it's starting. */
export async function startShare(db: Db, reportId: number, version?: number, hours = 1): Promise<ShareInfo> {
	sweep();
	const existing = shares.get(reportId);
	if (existing && existing.status !== "failed") return info(existing);
	if (existing) shares.delete(reportId);

	const r = getReport(db, reportId);
	if (!r) throw new Error("no such report");
	const n = version ?? r.version;
	if (!reportHtml(db, r.id, n)) throw new Error(`report has no version ${n}`);
	if (!SHARE_HOURS.includes(hours)) throw new Error(`share for ${SHARE_HOURS.join(", ")} hours`);
	const check = await checkShare();
	if (!check.ok) throw new Error(check.problems.join(" "));

	const now = Date.now();
	const s: Share = {
		db,
		report: r.id,
		version: n,
		title: r.title,
		project: r.project,
		status: "starting",
		url: null,
		reachable: false,
		error: "",
		startedAt: now,
		expiresAt: now + hours * HOUR,
		maxAt: now + SHARE_MAX_HOURS * HOUR,
		qr: "",
		port: 0,
		pid: 0,
		server: null,
		poll: null,
	};
	s.server = shareServer(s, 0);
	s.port = s.server.port!;

	// Detached, with its output in a log file: it has to outlive the board.
	mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
	const fd = openSync(logFile(r.id), "w", 0o600);
	const cmd = [check.cloudflared!, "tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${s.port}`];
	const argv = (await canScope())
		? ["systemd-run", "--user", "--scope", "--quiet", `--unit=wb-share-${r.id}-${now}`, ...cmd]
		: cmd;
	const child = spawn(argv[0], argv.slice(1), { detached: true, windowsHide: true, stdio: ["ignore", fd, fd] });
	closeSync(fd);
	child.on("error", (e) => fail(s, `couldn't start cloudflared: ${e.message}`));
	child.unref();
	s.pid = child.pid ?? 0;
	shares.set(r.id, s);
	save();
	watchStart(s, now);
	return info(s);
}

/** On the board's start: takes back the tunnels still running, ends those that expired meanwhile. */
export function resumeShares(db: Db) {
	const now = Date.now();
	for (const saved of load()) {
		const r = getReport(db, saved.report);
		if (!r || now >= saved.expiresAt || !tunnelAlive(saved.pid, saved.port)) {
			killTunnel(saved.pid, saved.port);
			rmSync(logFile(saved.report), { force: true });
			if (r) console.log(`share of "${r.title}" ${now >= saved.expiresAt ? "expired" : "had stopped"}; closed it`);
			continue;
		}
		const s: Share = {
			...saved,
			db,
			title: r.title,
			project: r.project,
			status: saved.url ? "ready" : "starting",
			reachable: false,
			error: "",
			qr: saved.url ? qrSvg(saved.url) : "",
			server: null,
			poll: null,
		};
		try {
			s.server = shareServer(s, saved.port);
		} catch (e) {
			killTunnel(saved.pid, saved.port);
			console.error(`share of "${r.title}": port ${saved.port} is taken (${(e as Error).message}); closed it`);
			continue;
		}
		shares.set(s.report, s);
		console.log(
			`share of "${r.title}" picked up: ${s.url ?? "starting"}, until ${new Date(s.expiresAt).toLocaleString()}`,
		);
		if (s.status === "starting") watchStart(s, now);
		else probe(s);
	}
	save();
}

/** The new address takes a few seconds to resolve; mark it reachable once it answers from here. */
async function probe(s: Share) {
	for (let i = 0; i < 20 && shares.get(s.report) === s && s.status === "ready"; i++) {
		try {
			const res = await fetch(`${s.url}/health`, { signal: AbortSignal.timeout(4000) });
			if (res.ok) return void (s.reachable = true);
		} catch {}
		await Bun.sleep(1500);
	}
}

const OPEN = ["todo", "doing", "waiting"];

/** The one server the tunnel reaches: one report, one version, read-only data from its project. */
function shareServer(share: Share, port: number) {
	const { db, report: reportId, version } = share;
	const report = () => {
		const r = getReport(db, reportId);
		if (!r) throw new Error("this report was removed");
		return r;
	};
	const project = () => projectsWithCounts(db).find((p) => p.slug === report().project);
	const json = (data: unknown, status = 200) =>
		Response.json(data, { status, headers: { "cache-control": "no-store" } });
	const headers = { "x-robots-tag": "noindex", "referrer-policy": "no-referrer", "cache-control": "no-store" };

	// What the page's `wb` calls get. Other projects ("*" or another slug) are answered as this one.
	const data: Record<string, (args: unknown[]) => unknown> = {
		items([f = {}]) {
			const q = f as Record<string, unknown>;
			const filter: ItemFilter = { project: report().project };
			const status = q.status === "open" ? OPEN : q.status;
			if (status) filter.status = ([] as unknown[]).concat(status).map(String) as ItemFilter["status"];
			for (const k of ["kind", "owner", "q"] as const) if (typeof q[k] === "string" && q[k]) filter[k] = q[k] as never;
			return listItems(db, filter);
		},
		item([ref]) {
			const id = resolveItem(db, String(ref ?? ""));
			const item = id === undefined ? undefined : getItem(db, id);
			if (!item || item.project !== report().project) throw new Error(`no item ${ref}`);
			return item;
		},
		async git() {
			const p = project();
			if (!p) return null;
			const g = await repoState(p);
			return { ...g, worktrees: g.worktrees.map((w) => ({ ...w, path: basename(w.path) })) };
		},
		links() {
			return []; // bookmarks stay private
		},
		projects() {
			const p = project();
			return p ? [{ slug: p.slug, name: p.name, mine: p.mine, path: "", icon: "" }] : [];
		},
		reports() {
			const r = report();
			return listReports(db, r.project).filter((x) => x.id === r.id);
		},
		// The project's own trackers, their meters only: no global ones, and nothing about how each reads or for which
		// account (commands, options, notes, links and errors can name accounts and plans).
		trackers() {
			const project = report().project;
			return listTrackers(db, project)
				.filter((t) => t.project === project)
				.map((t) => ({
					project: t.project,
					name: t.name,
					ref: t.ref,
					title: t.title,
					level: t.level,
					stale: t.stale,
					read_at: t.read_at,
					reading: t.reading && { meters: t.reading.meters, resets_at: t.reading.resets_at },
				}));
		},
		open() {
			throw new Error("this is a read-only shared copy");
		},
		stateGet() {
			const s = reportState(db, reportId);
			return s ? JSON.parse(s) : null;
		},
		stateSet: () => false,
		// Data sources call an API with a stored secret: never for someone holding the link.
		fetch: () => ({ ok: false, status: 0, error: "data sources are off on shared links" }),
		stateClear: () => false,
	};

	const pages: Record<string, () => Response> = {
		"/": () => {
			const r = report();
			const p = project();
			return new Response(wrapper(r.title, p?.name ?? r.project, version), {
				headers: {
					...headers,
					"content-type": "text/html; charset=utf-8",
					"content-security-policy":
						"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-src 'self'; connect-src 'self'; img-src data:",
				},
			});
		},
		"/r": () => {
			const r = report();
			const page = reportHtml(db, r.id, version);
			if (!page) return new Response("gone", { status: 404, headers });
			return new Response(withBridge(page.html, r, page.n), {
				headers: { ...headers, "content-type": "text/html; charset=utf-8", "content-security-policy": REPORT_CSP },
			});
		},
		"/health": () => new Response("ok", { headers }),
	};
	const call = async (req: Request) => {
		try {
			const { method, args } = (await req.json()) as { method: string; args?: unknown[] };
			if (!Object.hasOwn(data, method)) throw new Error(`unknown call ${method}`);
			return json({ result: await data[method](Array.isArray(args) ? args : []) });
		} catch (e) {
			return json({ error: (e as Error).message }, 400);
		}
	};

	return Bun.serve({
		port,
		hostname: "127.0.0.1",
		idleTimeout: 30,
		fetch(req) {
			// Nothing is served past the end, even before the sweep has run (say, in the first seconds after waking).
			if (shares.get(reportId) !== share || share.status === "failed" || Date.now() >= share.expiresAt) {
				setTimeout(sweep, 200); // after this answer has gone out
				return new Response("This shared link has ended.", {
					status: 410,
					headers: { ...headers, "content-type": "text/plain; charset=utf-8" },
				});
			}
			const path = new URL(req.url).pathname;
			if (path === "/data") return req.method === "POST" ? call(req) : new Response("", { status: 405, headers });
			if (req.method !== "GET" && req.method !== "HEAD") return new Response("", { status: 405, headers });
			return Object.hasOwn(pages, path) ? pages[path]() : new Response("not found", { status: 404, headers });
		},
	});
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** The page coworkers open: a thin bar, the report in a sandboxed frame, and the `wb` bridge answered read-only. */
function wrapper(title: string, project: string, version: number) {
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(title)}</title>
<style>
:root { --bg: #f6f5f2; --ink: #1d1c1a; --muted: #6f6b64; --line: #e3e0da; color-scheme: light dark; }
@media (prefers-color-scheme: dark) { :root { --bg: #151514; --ink: #ecebe8; --muted: #a29e96; --line: #33322f; } }
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; background: var(--bg); color: var(--ink); font: 14px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
body { display: flex; flex-direction: column; }
header { display: flex; gap: 10px; align-items: baseline; padding: 8px 16px; border-bottom: 1px solid var(--line); min-width: 0; }
header b { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
header small { color: var(--muted); white-space: nowrap; }
header span { flex: 1; }
iframe { flex: 1; width: 100%; border: 0; background: var(--bg); }
</style></head><body>
<header><b>${esc(title)}</b><small>${esc(project)} · v${version}</small><span></span><small>Read-only copy, shared from Workbench</small></header>
<iframe id="f" src="/r" title="${esc(title)}"></iframe>
<script>
const frame = document.getElementById("f");
addEventListener("message", async (e) => {
	const m = e.data;
	if (e.source !== frame.contentWindow || e.origin !== "null" || !m || m.wb !== 1 || typeof m.method !== "string") return;
	let reply;
	try {
		const res = await fetch("/data", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ method: m.method, args: m.args || [] }) });
		const d = await res.json();
		reply = d.error ? { error: d.error } : { result: d.result };
	} catch (err) { reply = { error: "the share has ended" }; }
	e.source.postMessage({ wb: 1, id: m.id, ...reply }, "*");
});
setInterval(() => { if (document.visibilityState === "visible") frame.contentWindow?.postMessage({ wb: 1, event: "refresh" }, "*"); }, 10000);
</script></body></html>`;
}
