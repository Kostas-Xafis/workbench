// What a test file needs to start from a clean board. Each call gives a new database file in the temp folder that
// test/preload.ts made, so files (and tests that want it) never share rows.
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { addProject, createSchema, open, type Db } from "../src/db";
import { SqliteDb } from "../worker/src/sqlite";
import { fakeDurableStorage } from "../worker/test/fake-storage";

/** The board's database the way the cloud board has it: a Durable Object's SQLite, through worker/src/sqlite.ts. */
function cloudDb(file: string): Db {
	const db = new SqliteDb(fakeDurableStorage(file), file) as unknown as Db;
	createSchema(db);
	return db;
}

/** A new board. `WB_TEST_SQL=durable-object` gives it the cloud board's SQLite instead (see worker/test/fake-storage.ts). */
export function freshDb(): Db {
	const dir = mkdtempSync(join(process.env.WB_TEST_DIR!, "db-"));
	const file = join(dir, "workbench.db");
	const db = process.env.WB_TEST_SQL === "durable-object" ? cloudDb(file) : open(file);
	// A board starts with no projects; most tests want one.
	addProject(db, { slug: "demo", name: "Demo", path: "/tmp/demo" });
	return db;
}
