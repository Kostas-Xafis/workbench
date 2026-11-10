/**
 * Settings → Health: whether the tools and pieces the board leans on work, what each is for, and the command that
 * fixes it when it doesn't. Every check is read-only and asked on demand (opening Settings, "Check again").
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir, networkInterfaces } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { BACKUP_DIR, backupsKeep, DB_PATH, listBackups, projects, type Db, type Project } from "./db";
import { qrSvg } from "./qr";
import { checkShare } from "./share";
import { KEY_PATH, listSources } from "./sources";
import { capture, listTrackers, shellPath } from "./trackers";

export type Status = "ok" | "warn" | "bad" | "off";
export type Fix = { text: string; cmd?: string };
export type Check = {
	key: string;
	title: string;
	/** What the board uses it for, in a few words. */
	use: string;
	status: Status;
	detail: string;
	fix: Fix[];
	/** Trackers or projects the check is about, for the page to link. */
	trackers?: number[];
	projects?: string[];
};

export type Health = {
	checks: Check[];
	agents: { stdio: string; http: string; configured: string; wb: string | null };
	phone: { lan: boolean; urls: { url: string; qr: string }[] };
	/** The Workbench app started this board (WB_APP=1): login start and phone access are the app's, in its tray menu. */
	app: boolean;
	startup: { supported: boolean; unitPath: string; installed: boolean; enabled: string; active: string; underSystemd: boolean; unit: string; install: string };
	board: { port: number; bun: string; db: string; dbBytes: number; backups: string; startedAt: number };
};

const STARTED = Date.now();
const APP = process.env.WB_APP === "1";

async function run(argv: string[], timeout = 10_000) {
	try {
		const r = await capture(argv, { cwd: homedir(), env: { ...process.env, PATH: await shellPath(), NO_COLOR: "1", GH_PROMPT_DISABLED: "1" }, timeout });
		return { ...r, ok: r.code === 0 };
	} catch (e) {
		return { out: "", err: (e as Error).message, code: -1 as number | "timeout", ok: false };
	}
}

const ago = (ms: number) => {
	const h = (Date.now() - ms) / 3600e3;
	if (h < 1) return `${Math.max(1, Math.round(h * 60))} min ago`;
	if (h < 48) return `${Math.round(h)} h ago`;
	return `${Math.round(h / 24)} days ago`;
};

async function git(): Promise<Check> {
	const use = "Repository state on the board, commits on items";
	const bin = Bun.which("git");
	if (!bin) return { key: "git", title: "git", use, status: "bad", detail: "Not found, so the board shows no repository state or commits.", fix: [{ text: "Install git from your system's packages, e.g.", cmd: "sudo apt install git" }] };
	const r = await run([bin, "--version"]);
	return { key: "git", title: "git", use, status: "ok", detail: r.out.trim().replace(/^git version /, "Version ") || bin, fix: [] };
}

async function gh(db: Db): Promise<Check> {
	const base = { key: "gh", title: "GitHub CLI (gh)", use: "Pull requests on items, the GitHub Actions tracker" };
	const bin = Bun.which("gh", { PATH: await shellPath() });
	if (!bin)
		return { ...base, status: "warn", detail: "Not installed: items show commits but no pull requests.", fix: [{ text: "Install it from cli.github.com (or your system's packages), then sign in:", cmd: "gh auth login" }] };
	const version = (await run([bin, "--version"])).out.match(/gh version (\S+)/)?.[1] ?? "";
	const r = await run([bin, "auth", "status", "--hostname", "github.com"], 15_000);
	// Read only the account and the scopes; the rest of what it prints stays here.
	const text = `${r.out}\n${r.err}`;
	const account = text.match(/Logged in to github\.com (?:account|as) (\S+)/)?.[1] ?? "";
	if (!r.ok || !account)
		return { ...base, status: "warn", detail: r.code === "timeout" ? "gh didn't answer within 15 s." : "Not signed in to github.com: items show commits but no pull requests.", fix: [{ text: "Sign in:", cmd: "gh auth login" }] };
	const scopes: string[] = (text.match(/Token scopes: (.*)/)?.[1] ?? "").match(/[\w:-]+/g) ?? [];
	const actions = listTrackers(db).filter((t) => t.kind === "github-actions");
	const detail = `Signed in as ${account}${version ? ` · ${version}` : ""}`;
	if (actions.length && scopes.length && !scopes.includes("user"))
		return { ...base, status: "warn", detail: `${detail}, without the "user" scope the Actions tracker needs.`, fix: [{ text: "Add the scope:", cmd: "gh auth refresh -h github.com -s user" }], trackers: actions.map((t) => t.id) };
	return { ...base, status: "ok", detail, fix: [] };
}

async function cloudflared(): Promise<Check> {
	const base = { key: "cloudflared", title: "cloudflared", use: "Sharing a report through a temporary link" };
	const c = await checkShare();
	if (c.ok) return { ...base, status: "ok", detail: `Version ${c.version}`, fix: [] };
	const guide = c.install[0];
	return {
		...base,
		status: c.cloudflared ? "warn" : "off",
		detail: c.cloudflared ? c.problems.join(" ") : "Not installed. Only needed to share a report with a link.",
		fix: guide ? guide.options.map((o) => ({ text: `${guide.system}: ${o.how}`, cmd: o.cmd })) : [],
	};
}

async function eas(db: Db): Promise<Check | null> {
	const trackers = listTrackers(db).filter((t) => t.kind === "eas-builds");
	const bin = Bun.which("eas", { PATH: await shellPath() });
	if (!bin && !trackers.length) return null;
	const base = { key: "eas", title: "EAS CLI (eas)", use: "The EAS builds tracker", trackers: trackers.map((t) => t.id) };
	if (!bin) {
		const failing = trackers.some((t) => t.error);
		return { ...base, status: failing ? "warn" : "ok", detail: `Not installed, so the tracker runs it through bunx or npx each time${failing ? ", and it's failing" : ""}.`, fix: [{ text: "Install it once and sign in:", cmd: "bun add -g eas-cli && eas login" }] };
	}
	const r = await run([bin, "whoami"], 20_000);
	const who = r.out.trim().split("\n")[0] ?? "";
	if (!r.ok || !who || /not logged in/i.test(who))
		return { ...base, status: "warn", detail: "Installed but not signed in.", fix: [{ text: "Sign in:", cmd: "eas login" }] };
	return { ...base, status: "ok", detail: `Signed in as ${who}`, fix: [] };
}

function backups(db: Db): Check {
	const base = { key: "backups", title: "Backups", use: `A copy of the database every day, the newest ${backupsKeep(db)} kept` };
	const list = listBackups();
	if (!list.length) return { ...base, status: "bad", detail: `None yet in ${BACKUP_DIR}.`, fix: [{ text: "Make one now:", cmd: "wb backup" }] };
	const newest = list[0].at.getTime();
	const stale = Date.now() - newest > 26 * 3600e3;
	return {
		...base,
		status: stale ? "warn" : "ok",
		detail: `Newest ${ago(newest)} · ${list.length} kept in ${BACKUP_DIR}`,
		fix: stale ? [{ text: "The board makes one when it runs; make one now:", cmd: "wb backup" }] : [],
	};
}

function trackers(db: Db, archived: Set<string>): Check | null {
	const all = listTrackers(db).filter((t) => !archived.has(t.project) && t.kind !== "manual");
	if (!all.length) return null;
	const failing = all.filter((t) => t.error);
	const name = (t: (typeof all)[number]) => `${t.title}${t.project ? ` (${t.project})` : ""}`;
	return {
		key: "trackers",
		title: "Status trackers",
		use: "Readings that refresh on their own",
		status: failing.length ? "warn" : "ok",
		detail: failing.length
			? `${failing.length} of ${all.length} can't read: ${failing.map((t) => `${name(t)}: ${t.error}`).join(" · ")}`
			: `All ${all.length} reading`,
		fix: [],
		trackers: failing.map((t) => t.id),
	};
}

export function folderState(path: string) {
	if (!path) return { exists: false, git: false };
	try {
		if (!statSync(path).isDirectory()) return { exists: false, git: false };
	} catch {
		return { exists: false, git: false };
	}
	return { exists: true, git: existsSync(join(path, ".git")) };
}

function folders(list: Project[]): Check {
	const live = list.filter((p) => !p.archived_at);
	const missing = live.filter((p) => !folderState(p.path).exists);
	const noGit = live.filter((p) => folderState(p.path).exists && !folderState(p.path).git);
	const base = { key: "folders", title: "Project folders", use: "Where items, git state and tracker commands come from" };
	if (missing.length)
		return { ...base, status: "bad", detail: missing.map((p) => `${p.name}: ${p.path ? `${p.path} is gone` : "no folder set"}`).join(" · "), fix: [{ text: "Point each one at its new folder under Projects above." }], projects: missing.map((p) => p.slug) };
	if (noGit.length)
		return { ...base, status: "warn", detail: noGit.map((p) => `${p.name}: ${p.path} isn't a git repository, so it has no repository state or commits`).join(" · "), fix: [], projects: noGit.map((p) => p.slug) };
	return { ...base, status: "ok", detail: `All ${live.length} found`, fix: [] };
}

function sourcesKey(db: Db): Check | null {
	const n = listSources(db).length;
	if (!n) return null;
	const base = { key: "sources-key", title: "Data sources key", use: `Opens the ${n} data source${n === 1 ? "" : "s"}' saved headers` };
	if (existsSync(KEY_PATH)) return { ...base, status: "ok", detail: KEY_PATH, fix: [] };
	return { ...base, status: "bad", detail: `${KEY_PATH} is gone, so reports can't call their data sources.`, fix: [{ text: "Add each source again (wb sources lists them); the first one makes a new key." }] };
}

/** The `wb` MCP server as Claude Code has it, from ~/.claude.json (user scope only). */
function claudeConfig(): string {
	try {
		const cfg = JSON.parse(readFileSync(join(homedir(), ".claude.json"), "utf8"));
		const s = cfg?.mcpServers?.wb;
		if (!s) return "";
		return s.type === "http" || s.url ? `HTTP · ${s.url}` : `stdio · ${[s.command, ...(s.args ?? [])].join(" ")}`;
	} catch {
		return "";
	}
}

function lanUrls(port: number) {
	const out: string[] = [];
	for (const list of Object.values(networkInterfaces()))
		for (const a of list ?? []) if (a.family === "IPv4" && !a.internal) out.push(`http://${a.address}:${port}`);
	return out;
}

async function systemctl(...args: string[]) {
	if (!Bun.which("systemctl")) return "";
	const r = await run(["systemctl", "--user", ...args], 5000);
	return r.out.trim().split("\n")[0] ?? "";
}

export async function startup(): Promise<Health["startup"]> {
	// Started by the app: its own start on login replaces the unit, whose path (in a compiled binary) isn't real.
	const app = APP;
	const supported = !app && process.platform === "linux" && !!Bun.which("systemctl");
	const unitPath = join(homedir(), ".config/systemd/user/workbench.service");
	const server = app ? "" : resolve(import.meta.dir, "server.ts");
	const unit = app ? "" : `[Unit]\nDescription=Workbench board\n\n[Service]\nExecStart=${process.execPath} ${server}\nRestart=on-failure\n\n[Install]\nWantedBy=default.target\n`;
	const install = app ? "" : `mkdir -p ${dirname(unitPath)} && cat > ${unitPath} <<'EOF'\n${unit}EOF\nsystemctl --user daemon-reload && systemctl --user enable --now workbench`;
	const installed = existsSync(unitPath);
	return {
		supported,
		unitPath,
		installed,
		enabled: supported && installed ? await systemctl("is-enabled", "workbench") : "",
		active: supported && installed ? await systemctl("is-active", "workbench") : "",
		// This board is the service's process, rather than one started by hand.
		underSystemd: supported && installed && (await systemctl("show", "-p", "MainPID", "--value", "workbench")) === String(process.pid),
		unit,
		install,
	};
}

export async function health(db: Db, { port, lan }: { port: number; lan: boolean }): Promise<Health> {
	const list = projects(db);
	const archived = new Set(list.filter((p) => p.archived_at).map((p) => p.slug));
	const checks = (
		await Promise.all([git(), gh(db), cloudflared(), eas(db), backups(db), trackers(db, archived), folders(list), sourcesKey(db)])
	).filter((c): c is Check => !!c);
	const wbBin = Bun.which("wb", { PATH: await shellPath() });
	const urls = lan ? lanUrls(port) : [];
	let dbBytes = 0;
	try {
		dbBytes = statSync(DB_PATH).size;
	} catch {}
	return {
		checks,
		agents: {
			stdio: "claude mcp add -s user wb -- wb mcp",
			http: `claude mcp add -s user --transport http wb http://localhost:${port}/mcp`,
			configured: claudeConfig(),
			wb: wbBin,
		},
		app: APP,
		phone: { lan, urls: urls.map((url, i) => ({ url, qr: i === 0 ? qrSvg(url) : "" })) },
		startup: await startup(),
		board: { port, bun: Bun.version, db: DB_PATH, dbBytes, backups: BACKUP_DIR, startedAt: STARTED },
	};
}

/**
 * Folders that look like projects but aren't on the board yet: git repositories next to the projects it has
 * (and in ~/Projects), for "Add project" to offer with one click.
 */
export function candidateFolders(db: Db): { path: string; name: string; slug: string }[] {
	const list = projects(db);
	const taken = new Set(list.map((p) => p.path));
	const roots = new Set([...list.filter((p) => p.path).map((p) => dirname(p.path)), join(homedir(), "Projects")]);
	const out = new Map<string, { path: string; name: string; slug: string }>();
	for (const root of roots) {
		let names: string[] = [];
		try {
			names = readdirSync(root);
		} catch {
			continue;
		}
		for (const n of names) {
			if (n.startsWith(".")) continue;
			const path = join(root, n);
			if (taken.has(path) || out.has(path) || !folderState(path).git) continue;
			out.set(path, { path, name: n, slug: slugFor(n) });
		}
	}
	return [...out.values()].sort((a, b) => a.name.localeCompare(b.name)).slice(0, 60);
}

export const slugFor = (name: string) =>
	name
		.replace(/([a-z0-9])([A-Z])/g, "$1-$2")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40) || "project";

/** A folder typed into the board: `~` expanded, absolute, and there. */
export function checkFolder(path: string): string {
	let p = String(path ?? "").trim();
	if (!p) throw new Error("pick the project's folder");
	if (p === "~" || p.startsWith("~/")) p = join(homedir(), p.slice(1));
	if (!isAbsolute(p)) throw new Error("give the folder's full path, e.g. ~/Projects/my-app");
	p = resolve(p);
	if (!folderState(p).exists) throw new Error(`there's no folder ${p}`);
	return p;
}
