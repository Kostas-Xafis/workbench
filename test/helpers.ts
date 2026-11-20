// What a test file needs to start from a clean board. Each call gives a new database file in the temp folder that
// test/preload.ts made, so files (and tests that want it) never share rows.
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { addProject, open, type Db } from "../src/db";

export function freshDb(): Db {
	const dir = mkdtempSync(join(process.env.WB_TEST_DIR!, "db-"));
	const db = open(join(dir, "workbench.db"));
	// A board starts with no projects; most tests want one.
	addProject(db, { slug: "demo", name: "Demo", path: "/tmp/demo" });
	return db;
}
