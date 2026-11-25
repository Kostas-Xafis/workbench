#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { backup, BACKUP_DIR, backupsKeep, listBackups, open, projects, pruneBackups } from "./db";
import { applyDue } from "./asks";
import { currentDay, dayData, dayPage, publishDay } from "./day";
import { PORT } from "./server";
import { cloudCommand, cloudFirst } from "./cloudcli";
import { parseWb, needsComputer } from "./cliargs";
import { cliHelpers, runCli, type CliCtx } from "./cli";
import { resolveHeaderSpecs } from "./sourceheaders";
import { continueRun, startRun, listRuns, pollRuns, runsText, stopRun } from "./dispatch";
import { integrationGuide } from "./integrate";
import { imageBytes } from "./images";
import { exportFileLines, exportKind, exportLines, importExport, importSummary, localTarget, toStdout } from "./export";

const { values: o, positionals: args } = parseWb(Bun.argv.slice(2));

// `wb sync …`, and every command while the board is in the cloud: then this computer's database stays closed.
if (cloudFirst(args[0])) {
	try {
		process.exit(await cloudCommand(o.help ? "help" : args[0], args, o));
	} catch (e) {
		console.error(`wb: ${(e as Error).message}`);
		process.exit(1);
	}
}

const db = open();
// Defaults whose deadline passed go ahead before anything is read or changed, board running or not (asks.ts).
applyDue(db);

const author = process.env.WB_AUTHOR ?? (process.env.CLAUDECODE ? "agent" : "kostas");

// The commands that read and change the board's data are cli.ts's, which the cloud board runs too.
const ctx: CliCtx = {
	db,
	args,
	o,
	cwd: process.cwd(),
	author,
	session: process.env.CLAUDE_CODE_HOST_SESSION_ID,
	tty: !!process.stdout.isTTY,
	base: `http://localhost:${PORT}`,
	port: PORT,
	out: (line) => console.log(line),
	err: (line) => console.error(line),
	read: async (path, as) => {
		if (as === "image") return imageBytes({ path });
		const file = Bun.file(path);
		if (!(await file.exists())) throw new Error(`no file ${path}`);
		return { bytes: new Uint8Array(await file.arrayBuffer()), label: path };
	},
	write: async (path, bytes) => void (await Bun.write(path, bytes)),
};
const { currentProject, idArg } = cliHelpers(ctx);

function die(msg: string): never {
	console.error(`wb: ${msg}`);
	process.exit(1);
}

async function serverUp() {
	try {
		await fetch(`http://127.0.0.1:${PORT}/api/projects`, { signal: AbortSignal.timeout(500) });
		return true;
	} catch {
		return false;
	}
}

const cmd = args[0];
// The export, and importing one, go a row at a time (export.ts): a board can be more than one string holds. A file
// that isn't an export (wb import's list of items) is cli.ts's.
const exportFile = cmd === "import" && args[1] && (await Bun.file(args[1]).exists()) && exportKind(await Bun.file(args[1]).slice(0, 4096).text()) !== "other";
if (cmd === "export" || exportFile)
	try {
		if (cmd === "export") {
			if (ctx.tty) die("wb export writes the whole board: send it to a file, e.g. wb export > workbench-export.jsonl");
			// One read transaction on this process's own connection: the file is the board as it was at one moment.
			db.run("BEGIN");
			try {
				await toStdout(exportLines(db));
			} finally {
				db.run("COMMIT");
			}
		} else {
			const r = await importExport(await exportFileLines(Bun.file(args[1]), db), localTarget(db), { schema: db, replace: o.replace, log: console.log });
			for (const line of importSummary(r)) console.log(line);
		}
	} catch (e) {
		die((e as Error).message);
	}
else if (!needsComputer(cmd)) process.exitCode = await runCli(ctx);
else
	try {
		switch (cmd) {
			case "integrate": {
				let dir = args[1] ? resolvePath(args[1]) : process.cwd();
				if (o.project) {
					const p = projects(db).find((p) => p.slug === o.project);
					if (!p) die(`unknown project "${o.project}" (wb projects)`);
					if (!p.path) die(`project ${p.slug} has no folder; set one with wb project ${p.slug} <path>`);
					dir = p.path;
				}
				console.log(integrationGuide(db, dir));
				break;
			}
			case "backup": {
				console.log(backup(db));
				const pruned = pruneBackups(backupsKeep(db));
				if (pruned)
					console.log(`removed ${pruned} older backup${pruned > 1 ? "s" : ""} (keeping the newest ${backupsKeep(db)})`);
				break;
			}
			case "backups": {
				const list = listBackups();
				if (!list.length) console.log(`no backups yet in ${BACKUP_DIR}`);
				for (const b of list)
					console.log(
						`${b.at.toISOString().slice(0, 16).replace("T", " ")}  ${(b.bytes / 1024).toFixed(0).padStart(6)} KB  ${b.file}`,
					);
				if (list.length) console.log(`${list.length} of at most ${backupsKeep(db)} kept (Settings → Data)`);
				break;
			}
			case "day": {
				const day = args[1] ?? currentDay(db);
				if (o.out) {
					await Bun.write(o.out, dayPage(await dayData(db, day, o.project)));
					console.log(o.out);
					break;
				}
				// One page per project, in its own "Days" (the board also does this by itself every 30 min).
				let any = false;
				for (const slug of o.project ? [o.project] : projects(db).map((p) => p.slug)) {
					const r = await publishDay(db, day, slug, author, true);
					if (!r) continue;
					any = true;
					console.log(
						`${slug.padEnd(14)} report #${r.id} v${r.n}${r.changed ? "" : " (unchanged)"}  ${r.items} items, ${r.commits} commits  http://localhost:${PORT}/#report/${r.id}`,
					);
				}
				if (!any) console.log(`nothing new for ${day}`);
				break;
			}
			case "source": {
				// The {env:…} and {stdin} in the headers are filled in here; the command itself is cli.ts's.
				process.exitCode = await runCli({ ...ctx, o: { ...o, header: await resolveHeaderSpecs(o.header ?? []) } });
				break;
			}
			case "mcp": {
				const { serveStdio } = await import("./mcp");
				await serveStdio();
				break;
			}
			case "run": {
				// Agents don't start agents: a run's own process, or an agent's shell, gets told so.
				if (process.env.WB_RUN || process.env.CLAUDECODE)
					die("agents don't start agents: leave it for the board (Run, or Answer & send)");
				const r = await startRun(db, idArg(), { where: "cli", label: "wb run" });
				console.log(
					`run #${r.id} started on wb-${r.ref} in ${projects(db).find((p) => p.slug === r.project)?.path}. wb runs shows how it goes; wb stop ${r.id} stops it`,
				);
				break;
			}
			case "land": {
				// Agents don't start agents: merging is the board's (Merge it), or yours.
				if (process.env.WB_RUN || process.env.CLAUDECODE)
					die("agents don't start agents: leave it for the board (Merge it)");
				const { landItem } = await import("./agents");
				const r = await landItem(db, idArg(), { where: "cli", label: "wb land" });
				console.log(`run #${r.id} merges wb-${r.ref}'s branch, in ${projects(db).find((p) => p.slug === r.project)?.path}. wb runs shows how it goes; wb stop ${r.id} stops it`);
				break;
			}
			case "runs": {
				pollRuns(db);
				console.log(runsText(listRuns(db, { limit: o.all ? 100 : 15 })));
				break;
			}
			case "continue": {
				// Agents don't start agents, and don't continue one either.
				if (process.env.WB_RUN || process.env.CLAUDECODE)
					die("agents don't start agents: leave it for the board (Continue on the run)");
				const n = Number(String(args[1] ?? "").replace(/^#/, ""));
				const message = args.slice(2).join(" ").trim();
				if (!Number.isInteger(n) || n < 1 || !message) die('usage: wb continue <run> "message" (its number from wb runs)');
				pollRuns(db);
				const r = await continueRun(db, n, message, { where: "cli", label: "wb continue" });
				console.log(`run #${r.id} continues run #${n}'s session on wb-${r.ref}${r.cwd ? ` in ${r.cwd}` : ""}. wb runs shows how it goes; wb stop ${r.id} stops it`);
				break;
			}
			case "stop": {
				const n = Number(String(args[1] ?? "").replace(/^#/, ""));
				if (!Number.isInteger(n) || n < 1) die("usage: wb stop <run> (its number from wb runs)");
				const r = await stopRun(db, n);
				console.log(`run #${r.id} on wb-${r.ref}: ${r.status}`);
				break;
			}
			case "serve": {
				const { serve } = await import("./server");
				const s = serve({ lan: o.lan });
				console.log(`workbench on http://${s.hostname}:${s.port}`);
				break;
			}
			case "open": {
				// The desktop app, when installed: it attaches to a running board or starts its own, and a second
				// launch just brings up the window that's already open.
				const quiet = { stdio: ["ignore", "ignore", "ignore"] as ["ignore", "ignore", "ignore"] };
				const app = Bun.which("workbench-app");
				const launcher = Bun.which("gtk-launch");
				const entry = [
					process.env.XDG_DATA_HOME || `${process.env.HOME}/.local/share`,
					...(process.env.XDG_DATA_DIRS || "/usr/local/share:/usr/share").split(":"),
				].some((d) => existsSync(`${d}/applications/Workbench.desktop`));
				if (app) {
					Bun.spawn([app], { ...quiet, detached: true }).unref();
					break;
				}
				if (launcher && entry) {
					Bun.spawn([launcher, "Workbench"], quiet).unref();
					break;
				}
				if (!(await serverUp())) {
					Bun.spawn(["bun", new URL("./server.ts", import.meta.url).pathname], {
						stdio: ["ignore", "ignore", "ignore"],
					}).unref();
					for (let i = 0; i < 20 && !(await serverUp()); i++) await Bun.sleep(100);
				}
				Bun.spawn(["xdg-open", `http://localhost:${PORT}`], { stdio: ["ignore", "ignore", "ignore"] }).unref();
				break;
			}
			default:
				die(`unknown command "${cmd}" (wb help)`);
		}
	} catch (e) {
		die((e as Error).message);
	}
