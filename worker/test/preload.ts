// Runs before the cloud board's tests (worker/bunfig.toml). The sync client (src/sync.ts) reads WB_DB when it's
// imported, so it points at a throwaway folder here, as test/preload.ts does for the board's own tests.
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const dir = join(tmpdir(), "wb-cloud-test");
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
process.env.WB_DB = join(dir, "workbench.db");
process.env.WB_BACKUPS = join(dir, "backups");
process.env.WB_TEST_DIR = dir;
process.env.XDG_RUNTIME_DIR = join(dir, "run");
if (!resolve(process.env.WB_DB).startsWith(resolve(tmpdir()))) throw new Error("the cloud board's tests must use a database in the temp folder");
