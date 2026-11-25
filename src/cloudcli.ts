/**
 * `wb sync …`, and what `wb` does while this computer syncs with the cloud board (sync.ts). Then nothing here may
 * read or write this computer's database, so wb.ts hands over to this before it opens it:
 *
 * - `wb sync on|off|status|pair`: turn sync on or off, see where the board is, pair a phone or a browser.
 * - `wb mcp`: relays the MCP server's stdio to the cloud board's /mcp (relay.ts), so agents keep their tools.
 * - `wb open`: the desktop app when it's installed (it opens the cloud board itself), else the browser, paired.
 * - `wb serve`, `wb run`, `wb runs`, `wb stop`, `wb helper`: the computer helper (helper.ts) and agents on the cloud board.
 * - The commands that read and change the board's data (`wb ls`, `wb add`, `wb done`, `wb report`, …) run on the cloud
 *   board by the same code as here (cli.ts): they send the args, the folder `wb` runs in and the files they name, and
 *   print what comes back, so they print what they would on this computer.
 * - The few that need this computer (backups, `wb day`, `wb integrate`, …) say so and what to use instead.
 */
import { existsSync } from "node:fs";
import { CLI_BODY_MAX, filesNamed, needsComputer, type CliReply, type CliRequest, type Opts } from "./cliargs";
import { imageBytes } from "./images";
import { cloudFetch, cloudLogin, cloudPairing, readSync, resealUp, syncOff, syncOn, type SyncConfig, type TableInfo } from "./sync";
import { exportFileLines, exportKind, importExport, importSummary, toStdout, type ImportTarget } from "./export";
import { resolveHeaderSpecs } from "./sourceheaders";
import { DB_PATH } from "./db";

type Options = Opts;

export const SYNC_HELP = `wb sync on <url> --key <owner key>     this computer uses the cloud board at <url>; an empty one gets this board
         [--name "This laptop"] [--replace]   --replace: send this board up even when the cloud one has items
wb sync on <url> --code <XXXX-XXXX>   the same with a pairing code from a device already on it
wb sync status                        where the board is, and the cloud board's counts
wb sync pair                          a code (and link) to pair a phone or a browser with the cloud board
wb sync sources                       seal this computer's data sources again with the cloud board's key, so
                                      reports' wb.fetch works there (wb sync on does it by itself)
wb sync off [--keep-local]            back to this computer: the cloud board's data comes down first
                                      (--keep-local: back to this computer's board as it was, the cloud one stays as it is)`;

function out(line: string) {
	console.log(line);
}

async function status(cfg: SyncConfig | null, o: Options) {
	if (!cfg) {
		if (o.json) return out(JSON.stringify({ synced: false, db: DB_PATH }));
		return out(`The board is on this computer (${DB_PATH}). wb sync on <url> --key … moves it to the cloud.`);
	}
	let counts: Record<string, number> | null = null;
	let error = "";
	try {
		const tables = (await (await cloudFetch(cfg, "/api/sync/tables")).json()) as { name: string; rows: number }[];
		counts = Object.fromEntries(tables.map((t) => [t.name, t.rows]));
	} catch (e) {
		error = (e as Error).message;
	}
	if (o.json) return out(JSON.stringify({ synced: true, url: cfg.url, device: cfg.device, since: cfg.since, counts, error: error || undefined }));
	out(`The board is in the cloud: ${cfg.url} (since ${cfg.since.slice(0, 16).replace("T", " ")}, this computer is device ${cfg.device}).`);
	if (counts)
		out(`It has ${counts.items ?? 0} items, ${counts.reports ?? 0} reports and ${counts.projects ?? 0} projects. This computer's own board (${DB_PATH}) isn't used while it syncs.`);
	else out(`It doesn't answer right now: ${error}`);
}

/** Opens the cloud board in the browser, signed in with a one-time ticket (a browser that already is goes straight on). */
async function openBoard(cfg: SyncConfig) {
	const quiet = { stdio: ["ignore", "ignore", "ignore"] as ["ignore", "ignore", "ignore"] };
	const app = Bun.which("workbench-app");
	if (app) {
		Bun.spawn([app], { ...quiet, detached: true }).unref();
		return;
	}
	let url = `${cfg.url}/`;
	try {
		url = await cloudLogin(cfg);
	} catch {}
	Bun.spawn(["xdg-open", url], quiet).unref();
}

/**
 * What each command that needs this computer says while the board is in the cloud (they're listed in cliargs.ts):
 * why, and what to use instead.
 */
const COMPUTER_ONLY_SAYS: Record<string, string> = {
	backup: "the cloud board keeps 30 days of every change instead of backup files (Cloudflare's point-in-time recovery)",
	backups: "the cloud board keeps 30 days of every change instead of backup files (Cloudflare's point-in-time recovery)",
	day: "wb day reads each project's git history on this computer: the board publishes each day's page by itself, or run it after wb sync off",
	integrate: "wb integrate looks at the project's folder on this computer: run it after wb sync off, or follow wb guide and `claude mcp add -s user wb -- wb mcp` by hand",
};

/** Runs one board command on the cloud board and prints what it printed, as it would here. Returns its exit code. */
async function runOnCloud(cfg: SyncConfig, args: string[], o: Options): Promise<number> {
	const files: CliRequest["files"] = {};
	for (const f of filesNamed(args, o)) {
		if (f.path in files) continue;
		if (f.as === "image") {
			// images.ts reads it with its own limits and words: what it refuses, the board says.
			try {
				const { bytes, label } = imageBytes({ path: f.path });
				files[f.path] = { b64: Buffer.from(bytes).toString("base64"), label };
			} catch (e) {
				files[f.path] = { error: (e as Error).message };
			}
		} else {
			const file = Bun.file(f.path);
			if (await file.exists()) files[f.path] = { b64: Buffer.from(await file.arrayBuffer()).toString("base64") };
		}
	}
	const request: CliRequest = {
		args,
		options: o,
		cwd: process.cwd(),
		author: process.env.WB_AUTHOR ?? (process.env.CLAUDECODE ? "agent" : "kostas"),
		session: process.env.CLAUDE_CODE_HOST_SESSION_ID,
		tty: !!process.stdout.isTTY,
		port: Number(process.env.WB_PORT) || 4400,
		files,
	};
	const body = JSON.stringify(request);
	if (body.length > CLI_BODY_MAX) throw new Error(`the request is over ${CLI_BODY_MAX / 1024 / 1024} MB: the files it sends are too large`);
	const reply = (await (await cloudFetch(cfg, "/api/sync/cli", { method: "POST", body })).json()) as CliReply;
	for (const [stream, line] of reply.lines) (stream === "err" ? console.error : console.log)(line);
	for (const [path, b64] of Object.entries(reply.writes ?? {})) await Bun.write(path, Buffer.from(b64, "base64"));
	return reply.code;
}

/**
 * `wb export` from the cloud board: its GET /api/data/export streams the export (export.ts) as the Durable Object
 * reads it, a page of rows at a time, and it goes to stdout as it comes. A body that ends before the export's last
 * line (the connection dropped) is an error, so a cut-off file is never taken for a whole one.
 */
async function exportFromCloud(cfg: SyncConfig): Promise<number> {
	if (process.stdout.isTTY) throw new Error("wb export writes the whole board: send it to a file, e.g. wb export > workbench-export.jsonl");
	const res = await cloudFetch(cfg, "/api/data/export");
	if (!res.body || !(res.headers.get("content-type") ?? "").startsWith("application/x-ndjson"))
		throw new Error("the cloud board answered the export in the old way: deploy the Worker from this version");
	let tail = "";
	const dec = new TextDecoder();
	async function* chunks() {
		for await (const c of res.body as unknown as AsyncIterable<Uint8Array>) {
			tail = (tail + dec.decode(c.subarray(Math.max(0, c.length - 65536)), { stream: false })).slice(-65536);
			yield c;
		}
	}
	await toStdout(chunks());
	const last = tail.trimEnd().split("\n").pop() ?? "";
	if (!last.startsWith('{"end":')) throw new Error("the export stopped before its end (the connection to the cloud board dropped?): the file isn't whole, run it again");
	return 0;
}

/**
 * `wb import <export>` while the board is in the cloud: the file is read here line by line and its rows go up in
 * batches, as `wb sync on` sends a board (/api/sync/wipe, /api/sync/rows), so a file of any size goes in.
 */
async function importToCloud(cfg: SyncConfig, file: string, o: Options): Promise<number> {
	const { open } = await import("./db");
	// This version's schema, for the order of the tables and their foreign keys: a board in memory, never this computer's.
	const schema = open(":memory:");
	const target: ImportTarget = {
		tables: async () => (await (await cloudFetch(cfg, "/api/sync/tables")).json()) as TableInfo[],
		wipe: (tables) => cloudFetch(cfg, "/api/sync/wipe", { method: "POST", body: JSON.stringify({ tables }) }),
		write: async (table, columns, rows) =>
			((await (await cloudFetch(cfg, "/api/sync/rows", { method: "POST", body: JSON.stringify({ table, columns, rows }) })).json()) as { rows: number }).rows,
	};
	let r: Awaited<ReturnType<typeof importExport>>;
	try {
		r = await importExport(await exportFileLines(Bun.file(file), schema), target, { schema, replace: o.replace, log: out });
	} catch (e) {
		const msg = (e as Error).message;
		// Refused before anything changed, or stopped part way: the cloud board can't take it all in one transaction.
		if (/already has|isn't a board export|newer than/.test(msg)) throw e;
		throw new Error(`${msg}. The cloud board may hold part of the export now: fix the file and run wb import --replace again`);
	} finally {
		schema.close();
	}
	for (const line of importSummary(r)) out(line);
	// Data sources sealed with this computer's key file go back to the cloud board's key, as wb sync on does.
	try {
		const s = await resealUp(cfg);
		if (s.resealed.length) out(`Data sources sealed again with the cloud board's key: ${s.resealed.length}.`);
	} catch {}
	return 0;
}

/** Runs `wb <cmd>` against the cloud board, or `wb sync …` either way. Returns the exit code. */
export async function cloudCommand(cmd: string, args: string[], o: Options): Promise<number> {
	const cfg = readSync();
	if (cmd === "sync") {
		const sub = args[1] ?? "status";
		if (sub === "help") out(SYNC_HELP);
		else if (sub === "status") await status(cfg, o);
		else if (sub === "on") {
			if (!args[2]) throw new Error("usage: wb sync on <url> --key <owner key> | --code <XXXX-XXXX>");
			const { cfg: now, uploaded } = await syncOn(args[2], { key: o.key, code: o.code, name: o.name, replace: o.replace, log: out });
			out(`Sync is on: this computer uses ${now.url}${uploaded ? ", which now has this board" : ""}.`);
			out("Restart the desktop app (or the board's service) so it opens the cloud board. wb sync pair pairs a phone.");
		} else if (sub === "off") {
			const { kept } = await syncOff({ keepLocal: o["keep-local"], log: out });
			out(`Sync is off: the board is on this computer again (${DB_PATH}).`);
			if (kept) out(`The board as it was before sync went on is kept as ${kept}.`);
			out("Restart the desktop app (or the board's service) so it uses this computer's board.");
		} else if (sub === "pair") {
			if (!cfg) throw new Error("this computer doesn't sync (wb sync on first)");
			const p = await cloudPairing(cfg);
			out(`Pairing code ${p.code}, for ${p.minutes} minutes and one device. On the phone or browser open:\n  ${p.url}`);
		} else if (sub === "sources") {
			if (!cfg) throw new Error("this computer doesn't sync (wb sync on first)");
			const r = await resealUp(cfg);
			out(r.resealed.length ? `Sealed again with the cloud board's key: ${r.resealed.map((x) => `${x.project}/${x.name}`).join(", ")}.` : "No data source sealed with a computer's key is left on the cloud board.");
			for (const f of r.failed) out(`Not opened with this computer's key: ${f.project}/${f.name} (${f.error}). Run wb sync sources on the computer that added it, or wb source add it again.`);
			return r.failed.length ? 1 : 0;
		} else throw new Error(`usage:\n${SYNC_HELP}`);
		return 0;
	}
	if (!cfg) throw new Error("cloudCommand without sync");
	switch (cmd) {
		case "mcp": {
			const { relay } = await import("./relay");
			await relay(cfg);
			return 0;
		}
		case "open":
			await openBoard(cfg);
			return 0;
		// ---- The computer helper (helper.ts) and agents on the cloud board ----
		case "serve": {
			const { serveMoved } = await import("./server");
			const s = serveMoved(cfg);
			out(`The board is in the cloud (${cfg.url}): http://${s.hostname}:${s.port} says so, and the computer helper runs here until you stop it.`);
			await new Promise(() => {});
			return 0;
		}
		case "run": {
			// Agents don't start agents, here as on a computer's board.
			if (process.env.WB_RUN || process.env.CLAUDECODE) throw new Error("agents don't start agents: leave it for the board (Run, or Answer & send)");
			if (!args[1]) throw new Error("usage: wb run <ref>");
			const res = await cloudFetch(cfg, "/api/runs", { method: "POST", body: JSON.stringify({ item: args[1].replace(/^wb-/i, ""), from: "cli" }) });
			const { run } = (await res.json()) as { run: { id: number; ref: string } };
			out(`run #${run.id} started on wb-${run.ref}, on a computer that syncs with ${cfg.url}. wb runs shows how it goes; wb stop ${run.id} stops it`);
			return 0;
		}
		case "land": {
			if (process.env.WB_RUN || process.env.CLAUDECODE) throw new Error("agents don't start agents: leave it for the board (Merge it)");
			if (!args[1]) throw new Error("usage: wb land <ref>");
			const res = await cloudFetch(cfg, `/api/items/${encodeURIComponent(args[1].replace(/^wb-/i, ""))}/land`, { method: "POST", body: JSON.stringify({ from: "cli" }) });
			const { run } = (await res.json()) as { run: { id: number; ref: string } };
			out(`run #${run.id} merges wb-${run.ref}'s branch, on a computer that syncs with ${cfg.url}. wb runs shows how it goes; wb stop ${run.id} stops it`);
			return 0;
		}
		case "runs": {
			const { runsText } = await import("./dispatch");
			const info = (await (await cloudFetch(cfg, "/api/runs")).json()) as { runs: Parameters<typeof runsText>[0]; active: Parameters<typeof runsText>[0]; computers?: string[] };
			const seen = new Set<number>();
			out(runsText([...info.active, ...info.runs].filter((r) => !seen.has(r.id) && seen.add(r.id)).slice(0, o.all ? 100 : 15)));
			out(info.computers?.length ? `\nOnline to run agents: ${info.computers.join(", ")}` : "\nNo computer is online to run agents: wb serve, or the desktop app, runs the helper here.");
			return 0;
		}
		case "continue": {
			if (process.env.WB_RUN || process.env.CLAUDECODE) throw new Error("agents don't start agents: leave it for the board (Continue on the run)");
			const n = Number(String(args[1] ?? "").replace(/^#/, ""));
			const message = args.slice(2).join(" ").trim();
			if (!Number.isInteger(n) || n < 1 || !message) throw new Error('usage: wb continue <run> "message" (its number from wb runs)');
			const res = await cloudFetch(cfg, `/api/runs/${n}/continue`, { method: "POST", body: JSON.stringify({ message, from: "cli" }) });
			const { run } = (await res.json()) as { run: { id: number; ref: string; cwd: string } };
			out(`run #${run.id} continues run #${n}'s session on wb-${run.ref}, on a computer that syncs with ${cfg.url}. wb runs shows how it goes; wb stop ${run.id} stops it`);
			return 0;
		}
		case "stop": {
			const n = Number(String(args[1] ?? "").replace(/^#/, ""));
			if (!Number.isInteger(n) || n < 1) throw new Error("usage: wb stop <run> (its number from wb runs)");
			const r = (await (await cloudFetch(cfg, `/api/runs/${n}/stop`, { method: "POST", body: "{}" })).json()) as { id: number; ref: string; status: string };
			out(`run #${r.id} on wb-${r.ref}: ${r.status}`);
			return 0;
		}
		case "helper": {
			const { allowPending, pendingCommands } = await import("./helper");
			if (args[1] === "allow") {
				const done = allowPending();
				out(done.length ? `Allowed on this computer:\n${done.map((c) => `  ${c.what}: ${c.text}`).join("\n")}` : "No command waits for an OK here.");
				return 0;
			}
			const { computers } = (await (await cloudFetch(cfg, "/api/helper")).json()) as { computers: { name: string; via: string; version: string; folders: number }[] };
			out(computers.length ? `Computers online for the cloud board:\n${computers.map((c) => `  ${c.name} (${c.via === "ws" ? "connected" : "polling"}, ${c.folders} project folders, ${c.version})`).join("\n")}` : "No computer is online for the cloud board. wb serve (or the desktop app) runs the helper here.");
			const waiting = pendingCommands();
			if (waiting.length) out(`\nNew commands waiting for an OK on this computer (wb helper allow allows them all):\n${waiting.map((c) => `  ${c.what}: ${c.text}`).join("\n")}`);
			return 0;
		}
		// ---- end of the computer helper ----
		case "export":
			return exportFromCloud(cfg);
		case "import":
			if (args[1] && (await Bun.file(args[1]).exists()) && exportKind(await Bun.file(args[1]).slice(0, 4096).text()) !== "other") return importToCloud(cfg, args[1], o);
			return runOnCloud(cfg, args, o);
		case "source":
			// The headers' {env:…} and {stdin} are filled in here; the cloud board seals them with its own key.
			return runOnCloud(cfg, args, { ...o, header: await resolveHeaderSpecs(o.header ?? []) });
		case "help":
		case undefined: {
			out(`The board is in the cloud: ${cfg.url}. Every board command below runs on it; wb mcp is relayed to it.\n`);
			const code = await runOnCloud(cfg, ["help"], {});
			out(SYNC_HELP);
			out("\nwb open opens the cloud board (the desktop app, or the browser) and wb mcp relays the MCP server to it.");
			out("wb serve                              the computer helper: agents, trackers' commands, git for the cloud board");
			out("wb run <ref> · wb runs · wb stop <n>  start, list and stop agents (on a computer whose helper is online)");
			out("wb land <ref>                          start an agent that merges a done item's branch by the project's rules");
			out('wb continue <n> "message"             send a run\'s agent a message: it carries on in the same session');
			out("wb helper [allow]                     which computers are online; allow the new commands that wait here");
			out(`While this computer syncs, wb ${Object.keys(COMPUTER_ONLY_SAYS).join(", ")} need this computer: they say so and what to use instead (wb sync off brings the board back).`);
			return code;
		}
		default:
			if (needsComputer(cmd)) throw new Error(`the board is in the cloud (${cfg.url}), and ${COMPUTER_ONLY_SAYS[cmd] ?? `wb ${cmd} needs this computer`}.`);
			return runOnCloud(cfg, args, o);
	}
}

/** Whether `wb` should hand over to cloudCommand: `wb sync …`, or anything while this computer syncs. */
export const cloudFirst = (cmd: string | undefined) => cmd === "sync" || (existsSync(`${DB_PATH}.sync.json`) && !!readSync());
