/**
 * The setup guide (index.html, `#welcome`) and its "Finish setting up" checklist: everything it shows is checked
 * here, live, rather than taken from what the guide was told.
 *
 * - Whether your name was ever set, how many projects there are and which folders could be one.
 * - Agents: whether Claude Code has the workbench's MCP server (in ~/.claude.json, at user scope or for one of the
 *   board's folders) and, the part that says it really works, when an MCP client last called the board. Both
 *   transports note that call (mcp.ts → noteMcpContact), in the table `mcp_contact` (made in db.ts), at most
 *   once a minute each.
 * - Each project's agent rules (integrate.ts), with the prompt that sets them up.
 * - Start on login for a board in a browser (the systemd unit, as Settings → Health has it).
 *
 * What the guide remembers (seen, steps done or skipped, dismissed) is the board setting `setup` (settings.ts).
 * Notifications and the app's own start on login are per device: the page checks those itself.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { projects, type Db } from "./db";
import { candidateFolders, folderState, startup } from "./health";
import { agentFiles, integratePrompt, RULES_VERSION } from "./integrate";
import { getSetting, yourName } from "./settings";
import { shellPath } from "./trackers";

/** Last write per transport in this process, so a busy session costs one write a minute, not one per call. */
const noted = new Map<string, number>();
const NOTE_EVERY = 60_000;

/** An MCP client called the board (any request but a notification). Never throws: MCP answers either way. */
export function noteMcpContact(db: Db, transport: "stdio" | "http", client = "") {
	const last = noted.get(transport) ?? 0;
	if (Date.now() - last < NOTE_EVERY) return;
	noted.set(transport, Date.now());
	try {
		db.query(
			"INSERT INTO mcp_contact (transport, client, at) VALUES (?, ?, datetime('now')) ON CONFLICT(transport) DO UPDATE SET client = CASE WHEN excluded.client = '' THEN mcp_contact.client ELSE excluded.client END, at = excluded.at",
		).run(transport, client.slice(0, 80));
	} catch {}
}

export type McpContact = { transport: string; client: string; at: string };
export function mcpContacts(db: Db): McpContact[] {
	try {
		return db.query("SELECT transport, client, at FROM mcp_contact ORDER BY at DESC").all() as McpContact[];
	} catch {
		return [];
	}
}

/** The `wb` MCP server as Claude Code has it: at user scope, or for one of these folders (`claude mcp add` without -s). */
function claudeMcp(folders: string[]): { how: string; scope: "user" | "project" } | null {
	let cfg: { mcpServers?: Record<string, McpCfg>; projects?: Record<string, { mcpServers?: Record<string, McpCfg> }> };
	try {
		cfg = JSON.parse(readFileSync(join(homedir(), ".claude.json"), "utf8"));
	} catch {
		return null;
	}
	const how = (s: McpCfg) => (s.type === "http" || s.url ? `HTTP · ${s.url}` : `stdio · ${[s.command, ...(s.args ?? [])].join(" ")}`);
	if (cfg?.mcpServers?.wb) return { how: how(cfg.mcpServers.wb), scope: "user" };
	for (const f of folders) {
		const s = cfg?.projects?.[f]?.mcpServers?.wb;
		if (s) return { how: how(s), scope: "project" };
	}
	return null;
}
type McpCfg = { type?: string; url?: string; command?: string; args?: string[] };

export async function setupStatus(db: Db, { port }: { port: number }) {
	const all = projects(db);
	const live = all.filter((p) => !p.archived_at);
	const nameSet = !!db.query("SELECT 1 FROM settings WHERE key = 'name'").get();
	const items = (db.query("SELECT COUNT(*) AS n FROM items").get() as { n: number }).n;
	const rules = live.map((p) => {
		const folder = folderState(p.path);
		const a = folder.exists ? agentFiles(p.path) : null;
		return { slug: p.slug, name: p.name, path: p.path, folder: folder.exists, state: a?.state ?? null, file: a?.file ?? "", version: a?.version ?? null, prompt: integratePrompt(p.path) };
	});
	return {
		name: { value: yourName(db), set: nameSet },
		projects: { active: live.length, total: all.length, suggestions: candidateFolders(db).length },
		items,
		mcp: {
			configured: claudeMcp(live.map((p) => p.path)),
			contacts: mcpContacts(db),
			wb: Bun.which("wb", { PATH: await shellPath() }),
			stdio: "claude mcp add -s user wb -- wb mcp",
			http: `claude mcp add -s user --transport http wb http://localhost:${port}/mcp`,
		},
		rules: { version: RULES_VERSION, prompt: integratePrompt(), projects: rules },
		startup: await startup(),
		app: process.env.WB_APP === "1",
		state: getSetting(db, "setup"),
	};
}
