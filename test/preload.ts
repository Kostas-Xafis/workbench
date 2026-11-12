// Runs before every test file (bunfig.toml). db.ts, server.ts and mcp.ts read these at import time, so they are set
// here, to a throwaway folder, before any of them loads. Never point them at the real board.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "wb-test-"));
process.env.WB_DB = join(dir, "workbench.db");
process.env.WB_BACKUPS = join(dir, "backups");
process.env.WB_PORT = "4401";
process.env.WB_TEST_DIR = dir;
process.env.XDG_RUNTIME_DIR = join(dir, "run");
process.env.WB_SOURCES_KEY = join(dir, "sources.key");

// The real board's database is live: a test must never open it. Everything here lives in the temp folder.
const real = [resolve(import.meta.dir, "..", "workbench.db"), "/home/kostas/Projects/workbench/workbench.db"];
if (real.includes(resolve(process.env.WB_DB)) || !resolve(process.env.WB_DB).startsWith(resolve(tmpdir())))
	throw new Error(`the tests must not use ${process.env.WB_DB}: WB_DB has to be a file in the temp folder`);
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
