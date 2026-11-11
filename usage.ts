/**
 * Claude usage, read from Claude Code's own transcripts in ~/.claude/projects (every app writes there: the desktop
 * app, the CLI, the SDK). Each assistant line carries the request's token usage; one response is written as several
 * lines with the same message id, and a resumed or forked session copies earlier lines into its new file, so usage is
 * counted once per message id.
 *
 * Files are append-only, so each one is read from where the last look stopped; a file that shrank is read again.
 * The page gets hourly rows (hour × model × project × session × app × subagent) and slices them itself.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

export const CLAUDE_PROJECTS = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "projects");

/** $ per million tokens: input, output, cache read, cache write (5 min), cache write (1 h). Claude API list prices. */
type Price = [number, number, number, number, number];
const PRICES: [RegExp, Price][] = [
	[/fable-5-2|mythos-5-2/, [8, 40, 0.2, 10, 16]],
	[/fable-5-1|mythos-5-1/, [10, 50, 0.25, 12.5, 20]],
	[/fable-5|mythos-5/, [10, 50, 1, 12.5, 20]],
	[/opus-5-5/, [4, 20, 0.2, 5, 8]],
	[/opus-5|opus-4-[5-9]/, [5, 25, 0.5, 6.25, 10]],
	[/opus/, [15, 75, 1.5, 18.75, 30]],
	[/sonnet-5-5/, [2, 10, 0.1, 2.5, 4]],
	[/sonnet-5/, [2, 10, 0.2, 2.5, 4]],
	[/sonnet/, [3, 15, 0.3, 3.75, 6]],
	[/haiku-5-5/, [0.1, 0.5, 0.01, 0.125, 0.2]],
	[/haiku-4/, [1, 5, 0.1, 1.25, 2]],
	[/haiku/, [0.8, 4, 0.08, 1, 1.6]],
];
const priceCache = new Map<string, Price | null>();
export function priceOf(model: string): Price | null {
	if (!priceCache.has(model)) priceCache.set(model, PRICES.find(([re]) => re.test(model))?.[1] ?? null);
	return priceCache.get(model)!;
}

/** One API response: [time ms, model, cwd, session, app, subagent, input, write 5m, write 1h, cache read, output, fast]. */
type Msg = [number, string, string, string, string, 0 | 1, number, number, number, number, number, 0 | 1];
type FileState = { size: number; offset: number; msgs: Map<string, Msg>; titles: Map<string, string>; branches: Map<string, string> };

const files = new Map<string, FileState>();
let scanning: Promise<void> | null = null;
let lastScan = 0;

function walk(dir: string, out: string[]) {
	let entries;
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const e of entries) {
		const p = join(dir, e.name);
		if (e.isDirectory()) walk(p, out);
		else if (e.name.endsWith(".jsonl")) out.push(p);
	}
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

function readLines(st: FileState, text: string, sidechainFile: boolean) {
	let start = 0;
	while (start < text.length) {
		let end = text.indexOf("\n", start);
		if (end < 0) end = text.length;
		const line = text.slice(start, end);
		start = end + 1;
		if (line.includes('"usage"') && line.includes('"type":"assistant"')) {
			let d;
			try {
				d = JSON.parse(line);
			} catch {
				continue;
			}
			const m = d.message;
			const u = m?.usage;
			if (!u || !m.model || m.model === "<synthetic>") continue;
			const key = m.id ?? d.requestId ?? d.uuid;
			if (!key) continue;
			const cc = u.cache_creation;
			const write = num(u.cache_creation_input_tokens);
			const w1h = cc ? num(cc.ephemeral_1h_input_tokens) : 0;
			const w5m = cc ? num(cc.ephemeral_5m_input_tokens) : write;
			const msg: Msg = [
				Date.parse(d.timestamp) || 0,
				m.model,
				d.cwd ?? "",
				d.sessionId ?? "",
				d.entrypoint ?? "unknown",
				d.isSidechain || sidechainFile ? 1 : 0,
				num(u.input_tokens),
				w5m + Math.max(0, write - w5m - w1h),
				w1h,
				num(u.cache_read_input_tokens),
				num(u.output_tokens),
				u.speed === "fast" ? 1 : 0,
			];
			const prev = st.msgs.get(key);
			// A response's lines repeat its usage; the last one has the final output count.
			if (!prev || msg[10] >= prev[10]) st.msgs.set(key, msg);
		} else if (line.startsWith('{"type":"custom-title"') || line.startsWith('{"type":"ai-title"')) {
			try {
				const d = JSON.parse(line);
				const t = d.customTitle ?? d.aiTitle ?? d.title;
				if (d.sessionId && typeof t === "string" && t.trim()) st.titles.set(d.sessionId, t.trim());
			} catch {}
		}
		if (line.includes('"gitBranch":"')) {
			const b = /"gitBranch":"([^"]*)"/.exec(line)?.[1];
			const s = /"sessionId":"([^"]+)"/.exec(line)?.[1];
			if (b && s && b !== "HEAD") st.branches.set(s, b);
		}
	}
}

async function scan() {
	const paths: string[] = [];
	walk(CLAUDE_PROJECTS, paths);
	const seen = new Set(paths);
	for (const p of files.keys()) if (!seen.has(p)) files.delete(p);
	for (const p of paths) {
		let size;
		try {
			size = statSync(p).size;
		} catch {
			continue;
		}
		let st = files.get(p);
		if (st && st.size === size) continue;
		if (!st || size < st.offset) {
			st = { size: 0, offset: 0, msgs: new Map(), titles: new Map(), branches: new Map() };
			files.set(p, st);
		}
		st.offset += await readFrom(p, st, size);
		st.size = size;
	}
	lastScan = Date.now();
}

/**
 * Reads a file from where the last look stopped, in the stream's chunks: transcripts run to hundreds of MB, and
 * reading one whole kept gigabytes in the board's memory. Only full lines are read (the app may be halfway
 * through writing the next one); returns how many bytes that was.
 */
async function readFrom(path: string, st: FileState, size: number) {
	const side = path.includes("/subagents/");
	const decoder = new TextDecoder();
	let pending: Uint8Array[] = [];
	let done = 0;
	let pendingBytes = 0;
	for await (const chunk of Bun.file(path).slice(st.offset, size).stream()) {
		const nl = chunk.lastIndexOf(10);
		if (nl < 0) {
			pending.push(chunk);
			pendingBytes += chunk.length;
			continue;
		}
		const head = chunk.subarray(0, nl);
		const block = pending.length ? Buffer.concat([...pending, head]) : head;
		readLines(st, decoder.decode(block), side);
		done += pendingBytes + nl + 1;
		const rest = chunk.subarray(nl + 1);
		pending = rest.length ? [rest.slice()] : [];
		pendingBytes = rest.length;
	}
	return done;
}

/** Read new transcript lines, at most every few seconds; callers share a scan that is already running. */
export async function refreshUsage(force = false) {
	if (scanning) return scanning;
	if (!force && Date.now() - lastScan < 5000) return;
	const first = lastScan === 0;
	scanning = scan()
		.then(() => {
			if (first) Bun.gc(true); // the first read goes through gigabytes; give the memory back
		})
		.finally(() => (scanning = null));
	return scanning;
}

type Project = { slug: string; name: string; path: string };

/** Which board project a folder belongs to (its own folder, or one inside it such as a worktree); else a label for it. */
function placeFolder(cwd: string, list: Project[], home: string): { key: string; name: string; board: boolean } {
	let best: Project | undefined;
	for (const p of list)
		if (p.path && (cwd === p.path || cwd.startsWith(p.path + "/")) && (!best || p.path.length > best.path.length)) best = p;
	if (best) return { key: best.slug, name: best.name, board: true };
	// The desktop app's own folders: chats without a project, side sessions.
	if (cwd.startsWith(join(home, ".config/Claude/")) || cwd.includes("/scratch-workspaces/"))
		return { key: "~desktop", name: "Desktop chats", board: false };
	if (!cwd) return { key: "~unknown", name: "Unknown folder", board: false };
	const wt = cwd.indexOf("/.claude/worktrees/");
	const root = repoRoot(wt >= 0 ? cwd.slice(0, wt) : cwd, home);
	if (root === home) return { key: "~home", name: "Home folder", board: false };
	return { key: "~" + root, name: basename(root), board: false };
}

/** The git repository a folder is in, so a session started in a subfolder counts with its repository. */
function repoRoot(dir: string, home: string) {
	for (let d = dir; d.length > home.length && d !== "/"; d = dirname(d)) if (existsSync(join(d, ".git"))) return d;
	return dir;
}

/**
 * Everything the usage page needs, dictionary-coded: rows are
 * [hour (ms), model, project, session, app, subagent, requests, input, write 5m, write 1h, cache read, output, cost $].
 */
export async function usageData(list: Project[]) {
	await refreshUsage();
	const home = homedir();
	const all = new Map<string, Msg>();
	const titles = new Map<string, string>();
	const branches = new Map<string, string>();
	for (const st of files.values()) {
		for (const [k, m] of st.msgs) {
			const prev = all.get(k);
			if (!prev || m[10] > prev[10]) all.set(k, m);
		}
		for (const [s, t] of st.titles) titles.set(s, t);
		for (const [s, b] of st.branches) if (!branches.has(s)) branches.set(s, b);
	}

	const dict = () => {
		const ids = new Map<string, number>();
		const values: string[] = [];
		return {
			values,
			id(v: string) {
				let i = ids.get(v);
				if (i === undefined) ids.set(v, (i = values.push(v) - 1));
				return i;
			},
		};
	};
	const models = dict(), apps = dict(), sessions = dict();
	const projectIds = new Map<string, number>();
	const projectsOut: { key: string; name: string; board: boolean }[] = [];
	const placeCache = new Map<string, number>();
	const projectOf = (cwd: string) => {
		let i = placeCache.get(cwd);
		if (i === undefined) {
			const pl = placeFolder(cwd, list, home);
			i = projectIds.get(pl.key);
			if (i === undefined) projectIds.set(pl.key, (i = projectsOut.push(pl) - 1));
			placeCache.set(cwd, i);
		}
		return i;
	};

	const HOUR = 3_600_000;
	const rows = new Map<string, number[]>();
	const sessionInfo = new Map<number, { first: number; last: number; project: number; app: number }>();
	const unpriced = new Set<string>();
	for (const m of all.values()) {
		const [ts, model, cwd, session, app, side, inp, w5, w1, cr, out, fast] = m;
		if (!ts) continue;
		const price = priceOf(model);
		if (!price) unpriced.add(model);
		const [pi, po, pr, pw5, pw1] = price ?? [0, 0, 0, 0, 0];
		const cost = ((inp * pi + out * po + cr * pr + w5 * pw5 + w1 * pw1) / 1e6) * (fast ? 2 : 1);
		const hour = Math.floor(ts / HOUR) * HOUR;
		const mi = models.id(model), pj = projectOf(cwd), si = sessions.id(session), ai = apps.id(app);
		const key = `${hour}|${mi}|${pj}|${si}|${ai}|${side}`;
		let r = rows.get(key);
		if (!r) rows.set(key, (r = [hour, mi, pj, si, ai, side, 0, 0, 0, 0, 0, 0, 0]));
		r[6]++;
		r[7] += inp;
		r[8] += w5;
		r[9] += w1;
		r[10] += cr;
		r[11] += out;
		r[12] += cost;
		const info = sessionInfo.get(si);
		if (!info) sessionInfo.set(si, { first: ts, last: ts, project: pj, app: ai });
		else {
			if (ts < info.first) info.first = ts;
			if (ts > info.last) info.last = ts;
			if (!side) info.project = pj;
		}
	}
	return {
		generated: Date.now(),
		source: CLAUDE_PROJECTS,
		files: files.size,
		models: models.values.map((id) => ({ id, price: priceOf(id) })),
		apps: apps.values,
		projects: projectsOut,
		sessions: sessions.values.map((id, i) => {
			const s = sessionInfo.get(i)!;
			return { id, title: titles.get(id) ?? "", branch: branches.get(id) ?? "", first: s.first, last: s.last, project: s.project, app: s.app };
		}),
		unpriced: [...unpriced],
		rows: [...rows.values()].map((r) => {
			r[12] = Math.round(r[12] * 1e6) / 1e6;
			return r;
		}),
	};
}
