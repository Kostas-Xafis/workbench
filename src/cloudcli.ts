/**
 * `wb sync …`, and what `wb` does while this computer syncs with the cloud board (sync.ts). Then nothing here may
 * read or write this computer's database, so wb.ts hands over to this before it opens it:
 *
 * - `wb sync on|off|status|pair`: turn sync on or off, see where the board is, pair a phone or a browser.
 * - `wb mcp`: relays the MCP server's stdio to the cloud board's /mcp (relay.ts), so agents keep their tools.
 * - `wb open`: the desktop app when it's installed (it opens the cloud board itself), else the browser, paired.
 * - Anything else says the board is in the cloud and what to use instead: the commands that work on the board's
 *   data over the network are the next step (docs/cloud.md).
 */
import { existsSync } from "node:fs";
import { cloudFetch, cloudLogin, cloudPairing, readSync, syncOff, syncOn, type SyncConfig } from "./sync";
import { DB_PATH } from "./db";

type Options = { key?: string; code?: string; name?: string; replace?: boolean; "keep-local"?: boolean; json?: boolean };

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
		case "serve":
			throw new Error(`the board is in the cloud (${cfg.url}), so this computer doesn't serve one. wb sync off brings it back.`);
		case "help":
		case undefined:
			out(`The board is in the cloud: ${cfg.url}. While this computer syncs, wb works with it through:\n`);
			out("wb open                               the board (the desktop app, or the browser)");
			out("wb mcp                                the MCP server for agents, relayed to the cloud board");
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
