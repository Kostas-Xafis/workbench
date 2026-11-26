/**
 * The computer helper (docs/cloud.md, "The computer helper"): while this computer syncs with the cloud board, it does
 * what the cloud board can't do without a computer. It runs in the local server's process (serveMoved in server.ts),
 * so `wb serve`, the service and the desktop app's sidecar all carry it.
 *
 * - It holds a WebSocket to the cloud board (worker/src/helper.ts) with this computer's device token, and polls over
 *   https while it can't. The cloud board sends it jobs; it answers each one.
 * - Jobs: start an agent (and follow its output, and stop it), read a tracker, git state, commits and pull requests,
 *   a project's logo, Usage, what sessions cost, project folders. Each is the board's own code for it, run here.
 * - **New commands wait for an OK here.** On the cloud board any paired device may change a tracker's command or
 *   Settings → Agents' command, which on a computer only its own board may. So this computer runs a command only
 *   once it's allowed here: the ones the board had when the helper first started, and each new one after a yes in
 *   a window on this computer (or `wb helper allow`). Kept in `<database>.helper.json`.
 */
import { createHash } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import pkg from "../package.json";
import { DB_PATH, type Project } from "./db";
import { alive, ASK_WAIT_MS, closeInput, exitCode, flushLog, forgetLog, launchCwd, launchRun, madeFrom, readLog, sendInput, terminate, testCommand, userLine, type Launch, type Live } from "./dispatch";
import { codeLinks, repoState } from "./git";
import { candidatesNear, folderState } from "./health";
import { agentFiles, integratePrompt } from "./integrate";
import { projectLogo } from "./logo";
import { cloudFetch, type SyncConfig } from "./sync";
import { readTracker, type Tracker } from "./trackers";
import { refreshUsage, sessionsCost, usageData } from "./usage";

type Msg = { t: string; [k: string]: unknown };
type Wire = Omit<Live, "partial">;
/** A run this helper started (or took over after a restart): followed until the cloud board has how it ended. */
type Mine = { id: number; tag: string; pid: number; unit: string; sent: number; sentEvents?: number; ending?: { code: number | null; live: Wire } };

/** What goes to the cloud board: everything read, but only the events after `after` (all of them at the end, so
 * one that a lost message missed gets there too). */
/** The most JSON one message about a run carries, whatever the run did: far under what a Durable Object takes in a
 * WebSocket message (32 MiB, Cloudflare's limit for received messages) and under what goes over the WebSocket here
 * (512 KB; more goes over https). */
export const WIRE_MAX = 256 * 1024;
/**
 * What goes to the cloud board about a run, within `max` bytes of JSON: everything read, the tail cut from its start
 * to half of it at most, then the events after `after` (the ones the board doesn't have yet), newest first, and with
 * `fill` (the last message, which also fills what a lost one missed) the older ones in the room that's left.
 */
export function wire({ partial: _, ...l }: Live, after = 0, { fill = false, max = WIRE_MAX } = {}): Wire {
	const lines = [...l.lines];
	const base = { ...l, lines, events: [] as Live["events"] };
	let size = JSON.stringify(base).length;
	while (lines.length && size > max / 2) size -= JSON.stringify(lines.shift()).length + 1;
	if (size > max / 2) base.result = base.result.slice(0, 1000);
	size = JSON.stringify(base).length;
	const fresh = l.events.filter((e) => e.n > after).reverse();
	const old = fill ? l.events.filter((e) => e.n <= after).reverse() : [];
	const picked: Live["events"] = [];
	for (const e of [...fresh, ...old]) {
		const s = JSON.stringify(e).length + 1;
		if (size + s > max) continue;
		picked.push(e);
		size += s;
	}
	return { ...base, events: picked.sort((a, b) => a.n - b.n) };
}

/* ---------- Commands allowed on this computer ---------- */

type Allowed = { allowed: string[]; denied: string[]; asked: Record<string, { what: string; text: string; tracker?: number; at: string }> };
export const allowFile = (dbPath = DB_PATH) => `${dbPath}.helper.json`;
const hashOf = (text: string) => createHash("sha256").update(text).digest("hex");

function readAllowed(): Allowed | null {
	try {
		const a = JSON.parse(readFileSync(allowFile(), "utf8"));
		return { allowed: a.allowed ?? [], denied: a.denied ?? [], asked: a.asked ?? {} };
	} catch {
		return null;
	}
}
function writeAllowed(a: Allowed) {
	writeFileSync(allowFile(), `${JSON.stringify(a, null, 1)}\n`, { mode: 0o600 });
	chmodSync(allowFile(), 0o600);
}

/** What a tracker runs, as allowed: its command, or its preset with the options it's given. */
const trackerText = (t: Pick<Tracker, "kind" | "command" | "options">) => (t.kind === "command" ? t.command : `${t.kind} ${JSON.stringify(t.options ?? {})}`);
const agentText = (command: string) => command;

/** The commands waiting for an OK here (`wb helper`). */
export const pendingCommands = () => Object.values(readAllowed()?.asked ?? {});

/** `wb helper allow`: every waiting command is allowed. Returns them. */
export function allowPending() {
	const a = readAllowed() ?? { allowed: [], denied: [], asked: {} };
	const out = Object.entries(a.asked);
	for (const [h] of out) {
		if (!a.allowed.includes(h)) a.allowed.push(h);
		a.denied = a.denied.filter((d) => d !== h);
	}
	a.asked = {};
	writeAllowed(a);
	return out.map(([, v]) => v);
}

/** Swapped by nothing but tests: the window that asks whether a new command may run here. */
export const confirm = {
	ask: async (title: string, text: string): Promise<boolean | null> => {
		const zenity = "/usr/bin/zenity";
		// Tests answer for the window: "yes" / "no" a moment later, "0" never.
		if (process.env.WB_HELPER_ASK === "yes" || process.env.WB_HELPER_ASK === "no") return new Promise((r) => setTimeout(() => r(process.env.WB_HELPER_ASK === "yes"), 300));
		if (process.env.WB_HELPER_ASK === "0" || !existsSync(zenity) || !(process.env.DISPLAY || process.env.WAYLAND_DISPLAY)) return null;
		const p = Bun.spawn([zenity, "--question", `--title=${title}`, "--no-markup", `--text=${text.replace(/\\/g, "\\\\")}`, "--ok-label=Allow", "--cancel-label=Deny", "--width=520", "--timeout=300"], {
			stdin: "ignore",
			stdout: "ignore",
			stderr: "ignore",
		});
		const code = await p.exited;
		return code === 0 ? true : code === 1 ? false : null;
	},
};

/* ---------- The helper ---------- */

export type HelperOptions = { log?: (line: string) => void; name?: string; tickMs?: number; followMs?: number };

export function startHelper(cfg: SyncConfig, o: HelperOptions = {}) {
	const log = o.log ?? ((line: string) => console.log(`helper: ${line}`));
	// Its device's name on the cloud board, once the welcome says it.
	let name = (o.name ?? hostname()).trim() || "a computer";
	const mine = new Map<number, Mine>();
	let folders: string[] = [];
	let ws: WebSocket | null = null;
	let open = false;
	let stopped = false;
	let polling = false;
	let failures = 0;
	let lastPong = 0;
	// The windows open now, by command hash: what each answers (true, false, or null when nobody did).
	const asking = new Map<string, Promise<boolean | null>>();
	const timers: ReturnType<typeof setInterval>[] = [];

	// caps: what this helper can do that its version may not say (a nightly's version is the last release's next patch).
	// "ask": its runs ask the board for permissions; "tell": messages reach a running one (not on Windows: no named pipes).
	const hello = () => ({ t: "hello", name, version: pkg.version, folders, caps: ["continue", "ask", ...(process.platform === "win32" ? [] : ["tell"])] });

	/** Sends a message: over the WebSocket when it's up (and the message isn't big), else over https, whose answer is read here. */
	async function send(m: Msg) {
		const text = JSON.stringify(m);
		if (open && ws && text.length < 512 * 1024)
			try {
				ws.send(text);
				return;
			} catch {}
		const res = await cloudFetch(cfg, "/api/helper/call", { method: "POST", body: JSON.stringify({ msgs: [m] }) });
		const { msgs } = (await res.json()) as { msgs?: Msg[] };
		for (const r of msgs ?? []) await onMessage(r);
	}

	async function onMessage(m: Msg) {
		switch (m.t) {
			case "welcome":
				if (typeof m.name === "string" && m.name) name = m.name;
				for (const r of (m.runs as (Omit<Mine, "sent"> & { started_at: string })[]) ?? []) {
					// Being started right now (no pid yet): it's added once it has one.
					if (mine.has(r.id) || (!r.pid && Date.now() - new Date(`${r.started_at.replace(" ", "T")}Z`).getTime() < 30e3)) continue;
					mine.set(r.id, { id: r.id, tag: r.tag, pid: r.pid, unit: r.unit, sent: -1 });
				}
				// Runs nobody follows (started before sync went on): this computer's, when their process or log is here.
				for (const r of (m.orphans as Omit<Mine, "sent">[]) ?? []) {
					if (mine.has(r.id) || !(alive(r) || exitCode(r) !== null || readLog(r).offset > 0)) continue;
					mine.set(r.id, { id: r.id, tag: r.tag, pid: r.pid, unit: r.unit, sent: -1 });
					await send({ t: "adopt", id: r.id }).catch(() => {});
					log(`run #${r.id} was going here before: following it`);
				}
				return;
			case "job":
				void job(m as { t: "job"; id: number; kind: string; payload: unknown });
				return;
			case "stop": {
				const r = mine.get(Number(m.id));
				if (r) await stopMine(r);
				return;
			}
			case "next":
				schedule(Number(m.ms) || 60e3);
				return;
			case "ack": {
				const r = mine.get(Number(m.id));
				if (r?.ending) {
					forgetLog(r);
					mine.delete(r.id);
				}
				return;
			}
		}
	}

	/* What it does for the cloud board, by job. */
	const JOBS: Record<string, (p: any) => Promise<unknown> | unknown> = {
		run: async (l: Launch) => {
			// A continue command made from the start command (dispatch.ts resumeCommand), or a command with a model, an
			// effort or a safe mode put in (withChoices), is allowed as the command it was made from: madeFrom checks
			// it's exactly that. Bypass permissions, or anything else, is its own command text, which waits for an OK.
			const what = l.resume ? "the command that continues agents (Settings → Agents)" : "the command that starts agents (Settings → Agents)";
			// A run waits for the window's answer (it closes itself after 5 min), so a yes starts it rather than failing it.
			// The flags that let the board reach it while it runs (permission prompts, messages: withLive) are allowed the
			// same way, as those words only.
			if (l.base && madeFrom(l.base, l.command, l.choices, l.live)) await allowed(agentText(l.base), what, undefined, ASK_WAIT_MS);
			else await allowed(agentText(l.command), l.choices?.mode === "bypassPermissions" ? `${what}, in Bypass permissions mode (chosen on the board)` : what, undefined, ASK_WAIT_MS);
			if (!launchCwd(l)) throw new Error(`there's no folder ${l.cwd || l.folder} on ${name}`);
			const out = await launchRun(l, (e) => log(`run #${l.id} couldn't start: ${e}`));
			mine.set(l.id, { id: l.id, tag: l.tag, pid: out.pid, unit: out.unit, sent: -1 });
			log(`run #${l.id} ${l.resume ? "continues a session" : "started"} (${l.vars.WB_ITEM ?? ""}) in ${out.cwd ?? l.cwd}`);
			return out;
		},
		// A message to a run it follows, on that run's stdin. Only the text comes from the board: the line is made here
		// (a raw line could be a control request that changes what the agent may do).
		tell: ({ id, text }: { id: number; text: string }) => {
			const r = mine.get(Number(id));
			if (!r || r.ending) return "gone";
			if (typeof text !== "string" || !text.trim() || text.length > 20000) throw new Error("no message to send");
			return sendInput(r, userLine(text));
		},
		stop: async (r: Pick<Mine, "id" | "pid" | "tag" | "unit">) => {
			await stopMine(mine.get(r.id) ?? { ...r, sent: -1 });
			return { ok: true };
		},
		tracker: async ({ tracker, folder }: { tracker: Tracker; folder: string }) => {
			await allowed(trackerText(tracker), `the tracker ${tracker.project ? `${tracker.project}/` : ""}${tracker.name}`, tracker.id);
			return readTracker(tracker, folder, new AbortController().signal);
		},
		git: ({ projects }: { projects: Project[] }) => Promise.all(projects.map(repoState)),
		code: async ({ projects }: { projects: Project[] }) => Object.assign({}, ...(await Promise.all(projects.map(codeLinks)))),
		logo: async ({ project }: { project: Project }) => {
			const l = await projectLogo(project);
			return l ? { type: l.type, b64: Buffer.from(await l.file.arrayBuffer()).toString("base64") } : null;
		},
		usage: async ({ projects, fresh }: { projects: Project[]; fresh?: boolean }) => {
			if (fresh) await refreshUsage(true);
			return usageData(projects);
		},
		costs: async ({ sessions, since }: { sessions: string[]; since: number }) => Object.fromEntries(await sessionsCost(sessions, since)),
		folders: ({ projects }: { projects: Project[] }) => candidatesNear(projects),
		projects: ({ paths }: { paths: string[] }) =>
			Object.fromEntries(paths.map((p) => [p, { folder: folderState(p), agents: { ...agentFiles(p), prompt: integratePrompt(p) } }])),
		// Only `<program> --version` and `--help`: nothing that starts an agent.
		test: ({ command }: { command: string }) => testCommand(command),
	};

	async function job(m: { id: number; kind: string; payload: unknown }) {
		let reply: Msg;
		try {
			foldersSoon();
			const run = JOBS[m.kind];
			if (!run) throw new Error(`${name}'s Workbench (${pkg.version}) doesn't know "${m.kind}": update it`);
			reply = { t: "done", id: m.id, ok: (await run(m.payload)) ?? null };
		} catch (e) {
			reply = { t: "done", id: m.id, error: (e as Error).message || String(e) };
		}
		await send(reply).catch((e) => log(`couldn't answer job ${m.id}: ${(e as Error).message}`));
	}

	/** Throws unless `text` may run here; a new one is asked about in a window on this computer, once. With `wait`,
	 * it waits up to that long for the window's answer: a yes goes on, a no throws as a refusal. */
	async function allowed(text: string, what: string, tracker?: number, wait = 0) {
		const h = hashOf(text);
		const a = readAllowed() ?? { allowed: [], denied: [], asked: {} };
		if (a.allowed.includes(h)) return;
		const how = `allow it in the window on ${name}, or run wb helper allow there`;
		if (a.denied.includes(h)) throw new Error(`${name} said no to running ${what}'s new command. To allow it after all: wb helper allow on ${name}.`);
		if (!a.asked[h]) {
			a.asked[h] = { what, text, tracker, at: new Date().toISOString() };
			writeAllowed(a);
		}
		let answer = asking.get(h);
		if (!answer) {
			answer = confirm
				.ask("Workbench: a new command", `The cloud board asks ${name} to run a new command, for ${what}:\n\n${text}\n\nAny device paired with the cloud board can change it. Allow it to run on this computer?`)
				.then(async (yes) => {
					if (yes === null) return null;
					const now = readAllowed() ?? a;
					delete now.asked[h];
					(yes ? now.allowed : now.denied).push(h);
					writeAllowed(now);
					log(`${yes ? "allowed" : "refused"}: ${what}`);
					if (yes && tracker) await cloudFetch(cfg, `/api/trackers/${tracker}/refresh`, { method: "POST", body: "{}" }).catch(() => {});
					return yes;
				})
				.catch(() => null)
				.finally(() => asking.delete(h));
			asking.set(h, answer);
		}
		if (wait > 0) {
			const yes = await Promise.race([answer, new Promise<null>((r) => setTimeout(() => r(null), wait))]);
			if (yes === true) return;
			if (yes === false) throw new Error(`${name} said no to running ${what}'s new command. To allow it after all: wb helper allow on ${name}.`);
		}
		throw new Error(`${what} has a new command, which waits for an OK on ${name}: ${how}.`);
	}

	/** The commands the cloud board has when the helper first starts here are allowed: they're the board's own. */
	async function firstStart() {
		if (readAllowed()) return;
		const allowed: string[] = [];
		const trackers = (await (await cloudFetch(cfg, "/api/trackers")).json()) as Tracker[];
		for (const t of trackers) if (t.kind !== "manual") allowed.push(hashOf(trackerText(t)));
		const settings = (await (await cloudFetch(cfg, "/api/settings")).json()) as Record<string, unknown>;
		if (typeof settings["agents.command"] === "string") allowed.push(hashOf(agentText(settings["agents.command"])));
		if (typeof settings["agents.continue-command"] === "string" && settings["agents.continue-command"]) allowed.push(hashOf(agentText(settings["agents.continue-command"])));
		writeAllowed({ allowed, denied: [], asked: {} });
		log(`first start: the ${allowed.length} command${allowed.length === 1 ? "" : "s"} the board has now may run here; new ones wait for an OK`);
	}

	/* Runs: their output as it comes, and how they ended. */

	async function follow(r: Mine, force = false) {
		if (r.ending) return send({ t: "ended", id: r.id, ...r.ending });
		const l = readLog(r);
		// Its turn ended: its stdin closes, so it finishes (a run that takes messages: dispatch.ts closeInput).
		closeInput(r, l);
		let code = exitCode(r);
		const done = force || (code === null ? !alive(r) : true);
		if (!done) {
			if (l.offset !== r.sent) {
				const after = r.sentEvents ?? 0;
				r.sent = l.offset;
				await send({ t: "run", id: r.id, live: wire(l, after) });
				r.sentEvents = l.seq;
			}
			return;
		}
		code ??= exitCode(r);
		const last = readLog(r);
		flushLog(last);
		// Bounded (wire): the events it hasn't sent first. Sent again on each look until the board says it has it.
		r.ending = { code, live: wire(last, r.sentEvents ?? 0, { fill: true }) };
		log(`run #${r.id} ended${code === null ? "" : ` (exit ${code})`}`);
		await send({ t: "ended", id: r.id, ...r.ending });
	}

	async function stopMine(r: Mine) {
		mine.set(r.id, r);
		await terminate(r);
		await follow(r, true);
	}

	let following = false;
	async function followAll() {
		if (following) return;
		following = true;
		try {
			for (const r of [...mine.values()]) await follow(r).catch(() => {});
		} finally {
			following = false;
		}
	}

	/* The project folders on this computer, so jobs that need one come here. */
	async function refreshFolders() {
		try {
			const list = (await (await cloudFetch(cfg, "/api/projects")).json()) as { path: string }[];
			const now = [...new Set(list.map((p) => p.path).filter((p) => p && existsSync(p)))].sort();
			if (now.join("\n") === folders.join("\n")) return;
			folders = now;
			if (open && ws) ws.send(JSON.stringify(hello()));
		} catch (e) {
			log(`couldn't read the projects: ${(e as Error).message}`);
		}
	}

	/* Getting through: the WebSocket, and polling while it's down. */

	function connect() {
		if (stopped) return;
		// WB_HELPER_WS=0: polling only (a network that won't keep a WebSocket open; the tests of the fallback).
		if (process.env.WB_HELPER_WS === "0") return void poll();
		const url = `${cfg.url.replace(/^http/, "ws")}/api/helper/ws`;
		let sock: WebSocket;
		try {
			sock = new WebSocket(url, { headers: { authorization: `Bearer ${cfg.token}`, "user-agent": `workbench-helper/${pkg.version}` } } as unknown as string[]);
		} catch (e) {
			log(`no WebSocket: ${(e as Error).message}`);
			return later();
		}
		ws = sock;
		sock.onopen = () => {
			open = true;
			failures = 0;
			lastPong = Date.now();
			sock.send(JSON.stringify(hello()));
			log(`connected to ${cfg.url}`);
			schedule(2000);
		};
		sock.onmessage = (e) => {
			const text = typeof e.data === "string" ? e.data : new TextDecoder().decode(e.data as ArrayBuffer);
			if (text === "pong") {
				lastPong = Date.now();
				return;
			}
			try {
				void onMessage(JSON.parse(text));
			} catch {}
		};
		sock.onerror = () => {};
		sock.onclose = (e) => {
			const was = open;
			open = false;
			if (ws === sock) ws = null;
			if (stopped) return;
			if (e.code === 4001) log("this computer's device was removed from the cloud board: wb sync status says more");
			else if (was) log(`disconnected (${e.code}${e.reason ? ` ${e.reason}` : ""}): trying again`);
			later();
		};
	}
	function later() {
		failures++;
		void poll();
		const t = setTimeout(connect, Math.min(60e3, 1000 * 2 ** Math.min(failures, 6)));
		timers.push(t as unknown as ReturnType<typeof setInterval>);
	}
	/** While there's no WebSocket: long polls, which also say this computer is online. */
	async function poll() {
		if (polling) return;
		polling = true;
		try {
			while (!open && !stopped) {
				try {
					const res = await cloudFetch(cfg, "/api/helper/poll", { method: "POST", body: JSON.stringify({ hello: hello(), wait: 25 }) });
					const { msgs } = (await res.json()) as { msgs?: Msg[] };
					for (const m of msgs ?? []) await onMessage(m);
				} catch {
					await Bun.sleep(10e3);
				}
			}
		} finally {
			polling = false;
		}
	}

	// Ticks: the cloud board reads due trackers and sends unblocked work then. It says when the next one is worth
	// it ("next"), so an idle board isn't woken every few seconds; a minute when it doesn't say.
	let tickTimer: ReturnType<typeof setTimeout> | undefined;
	function schedule(ms: number) {
		clearTimeout(tickTimer);
		tickTimer = setTimeout(tick, Math.max(1000, ms));
	}
	function tick() {
		if (stopped) return;
		schedule(o.tickMs ?? 60e3);
		if (!open && !polling) return;
		send({ t: "tick" }).catch(() => {});
	}
	/** The folders again after a job (the board is awake then anyway), at most every 30 s; else every 10 minutes. */
	let foldersAt = 0;
	function foldersSoon() {
		if (Date.now() - foldersAt < 30e3) return;
		foldersAt = Date.now();
		setTimeout(() => void refreshFolders(), 1000);
	}

	(async () => {
		try {
			await firstStart();
		} catch (e) {
			log(`couldn't read the board's commands yet: ${(e as Error).message}`);
		}
		await refreshFolders();
		connect();
	})();
	timers.push(setInterval(() => void followAll(), o.followMs ?? 2000));
	schedule(o.tickMs ?? 15e3);
	timers.push(setInterval(() => void refreshFolders(), 600e3));
	timers.push(
		setInterval(() => {
			if (!open || !ws) return;
			// The cloud board answers "pong" without waking up; a socket that stopped answering is closed and made again.
			if (Date.now() - lastPong > 75e3) ws.close(4000, "no pong");
			else ws.send("ping");
		}, 30e3),
	);

	return {
		/** Whether its WebSocket is up. */
		connected: () => open,
		/** The runs it follows. */
		runs: () => [...mine.keys()],
		async stop() {
			stopped = true;
			for (const t of timers) clearInterval(t);
			clearTimeout(tickTimer);
			ws?.close(1000, "the helper stops");
		},
	};
}
