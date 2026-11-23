/**
 * `wb sync …`, and what `wb` does while this computer syncs with the cloud board (sync.ts). Then nothing here may
 * read or write this computer's database, so wb.ts hands over to this before it opens it:
 *
 * - `wb sync on|off|status|pair`: turn sync on or off, see where the board is, pair a phone or a browser.
 * - `wb mcp`: relays the MCP server's stdio to the cloud board's /mcp (relay.ts), so agents keep their tools.
 * - `wb open`: the desktop app when it's installed (it opens the cloud board itself), else the browser, paired.
 * - `wb serve`, `wb run`, `wb runs`, `wb stop`, `wb helper`: the computer helper (helper.ts) and agents on the cloud board.
 * - Anything else says the board is in the cloud and what to use instead: the commands that work on the board's
 *   data over the network are the next step (docs/cloud.md).
 */
import { existsSync } from "node:fs";
import { cloudFetch, cloudLogin, cloudPairing, readSync, syncOff, syncOn, type SyncConfig } from "./sync";
import { DB_PATH } from "./db";

type Options = { key?: string; code?: string; name?: string; replace?: boolean; "keep-local"?: boolean; json?: boolean; all?: boolean };

export const SYNC_HELP = `wb sync on <url> --key <owner key>     this computer uses the cloud board at <url>; an empty one gets this board
         [--name "This laptop"] [--replace]   --replace: send this board up even when the cloud one has items
wb sync on <url> --code <XXXX-XXXX>   the same with a pairing code from a device already on it
wb sync status                        where the board is, and the cloud board's counts
wb sync pair                          a code (and link) to pair a phone or a browser with the cloud board
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
		case "runs": {
			const { runLine } = await import("./dispatch");
			const info = (await (await cloudFetch(cfg, "/api/runs")).json()) as { runs: Parameters<typeof runLine>[0][]; active: Parameters<typeof runLine>[0][]; computers?: string[] };
			const seen = new Set<number>();
			const list = [...info.active, ...info.runs].filter((r) => !seen.has(r.id) && seen.add(r.id)).slice(0, o.all ? 100 : 15);
			if (!list.length) out("no agent runs yet (wb run <ref>, or Run on the board)");
			for (const r of list) out(`wb-${r.ref}  ${r.title}\n  ${runLine(r)}`);
			out(info.computers?.length ? `\nOnline to run agents: ${info.computers.join(", ")}` : "\nNo computer is online to run agents: wb serve, or the desktop app, runs the helper here.");
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
		case "help":
		case undefined:
			out(`The board is in the cloud: ${cfg.url}. While this computer syncs, wb works with it through:\n`);
			out("wb open                               the board (the desktop app, or the browser)");
			out("wb mcp                                the MCP server for agents, relayed to the cloud board");
			out("wb serve                              the computer helper: agents, trackers' commands, git for the cloud board");
			out("wb run <ref> · wb runs · wb stop <n>  start, list and stop agents (on a computer whose helper is online)");
			out("wb helper [allow]                     which computers are online; allow the new commands that wait here");
			out(SYNC_HELP);
			out("\nThe board's other commands work on this computer's board, which isn't used while it syncs: use the board, or the MCP tools.");
			return 0;
		default:
			throw new Error(
				`the board is in the cloud (${cfg.url}), and wb ${cmd} doesn't work over the network yet. Use the board (wb open) or the MCP tools (wb mcp); wb help says what works.`,
			);
	}
}

/** Whether `wb` should hand over to cloudCommand: `wb sync …`, or anything while this computer syncs. */
export const cloudFirst = (cmd: string | undefined) => cmd === "sync" || (existsSync(`${DB_PATH}.sync.json`) && !!readSync());
