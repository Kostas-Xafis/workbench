/**
 * What `wb` takes on its command line, and what travels when the board is in the cloud (cloudcli.ts, cli.ts): the
 * options, which commands need this computer, which files a command reads, and the shape of the call.
 * Nothing here touches the database or the network, so cloudcli.ts can load it before anything else.
 */
import { parseArgs } from "node:util";

export const OPTION_SPEC = {
	kind: { type: "string" },
	owner: { type: "string" },
	project: { type: "string" },
	area: { type: "string" },
	p: { type: "string" },
	body: { type: "string" },
	branch: { type: "string" },
	session: { type: "string" },
	source: { type: "string" },
	status: { type: "string" },
	title: { type: "string" },
	mine: { type: "boolean" },
	agents: { type: "boolean" },
	all: { type: "boolean" },
	lan: { type: "boolean" },
	q: { type: "string", short: "q" },
	group: { type: "string" },
	icon: { type: "string" },
	name: { type: "string" },
	out: { type: "string" },
	yes: { type: "boolean" },
	archive: { type: "boolean" },
	unarchive: { type: "boolean" },
	write: { type: "boolean" },
	goal: { type: "string" },
	due: { type: "string" },
	done: { type: "boolean" },
	drop: { type: "boolean" },
	reopen: { type: "boolean" },
	active: { type: "boolean" },
	position: { type: "string" },
	header: { type: "string", multiple: true },
	command: { type: "string" },
	preset: { type: "string" },
	param: { type: "string", multiple: true },
	every: { type: "string" },
	max: { type: "string" },
	unit: { type: "string" },
	warn: { type: "string" },
	bad: { type: "string" },
	url: { type: "string" },
	note: { type: "string" },
	resets: { type: "string" },
	global: { type: "boolean" },
	json: { type: "boolean" },
	option: { type: "string", multiple: true },
	on: { type: "string", multiple: true },
	"not-on": { type: "string", multiple: true },
	blocks: { type: "string" },
	pick: { type: "string" },
	recommend: { type: "string", multiple: true },
	default: { type: "string", multiple: true },
	"decide-by": { type: "string" },
	image: { type: "string", multiple: true },
	caption: { type: "string", multiple: true },
	item: { type: "string" },
	retired: { type: "boolean" },
	// wb sync (sync.ts, cloudcli.ts)
	key: { type: "string" },
	code: { type: "string" },
	replace: { type: "boolean" },
	"keep-local": { type: "boolean" },
	help: { type: "boolean", short: "h" },
} as const;

export const parseWb = (argv: string[]) => parseArgs({ args: argv, allowPositionals: true, options: OPTION_SPEC });
export type Opts = ReturnType<typeof parseWb>["values"];

/**
 * The commands that need this computer: its folders, its git, its processes, its files and its server. While the
 * board is in the cloud they say so (cloudcli.ts); every other command runs on the board, wherever it is (cli.ts).
 */
export const COMPUTER_ONLY = new Set([
	"integrate",
	"backup",
	"backups",
	"day",
	// wb fills in a data source's {env:…} and {stdin} on the computer first, then runs it here or on the cloud board.
	"source",
	"mcp",
	"run",
	"runs",
	"continue",
	"stop",
	"serve",
	"open",
	"sync",
]);
export const needsComputer = (cmd: string | undefined) => cmd !== undefined && COMPUTER_ONLY.has(cmd);

/** A file a command reads on this computer. `image`: a picture (images.ts reads it, with its own limits and words). */
export type NamedFile = { path: string; as: "file" | "image" };

/** The files `wb <args>` reads (report pages, SVG icons, pictures, a JSON import), which a cloud board has to be sent. */
export function filesNamed(args: string[], o: Opts): NamedFile[] {
	const svg = (p: string | undefined) => (p && /\.svg$/i.test(p) ? [{ path: p, as: "file" as const }] : []);
	switch (args[0]) {
		case "add":
			return (o.image ?? []).map((path) => ({ path, as: "image" as const }));
		case "image":
			return args[1] === "add" && args[3] ? [{ path: args[3], as: "image" }] : [];
		case "import":
			return args[1] ? [{ path: args[1], as: "file" }] : [];
		case "report":
			return [...(args[1] ? [{ path: args[1], as: "file" as const }] : []), ...svg(o.icon)];
		case "report-icon":
			return svg(args[2]);
		default:
			return [];
	}
}

/** What `wb` sends the cloud board for one command (POST /api/sync/cli). */
export type CliRequest = {
	args: string[];
	options: Opts;
	/** The folder `wb` runs in: the board finds the project whose folder holds it, as it does here. */
	cwd: string;
	author: string;
	/** CLAUDE_CODE_HOST_SESSION_ID: the session `wb start` links to. */
	session?: string;
	tty: boolean;
	/** The port a board here would be on, for the one line of `wb help` that says. */
	port: number;
	/** The files the command reads, by the path as typed: their bytes in base64 (and what to call them), or what's wrong with them. */
	files: Record<string, { b64?: string; error?: string; label?: string }>;
};

/** What comes back: the output in the order it was written, the exit code, and files the command writes (`wb image save`). */
export type CliReply = { lines: ["out" | "err", string][]; code: number; writes: Record<string, string> };

/** The most one call carries, as an MCP request does (mcp.ts). */
export const CLI_BODY_MAX = 16 * 1024 * 1024;
