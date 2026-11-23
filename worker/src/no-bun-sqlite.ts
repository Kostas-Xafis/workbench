// What `bun:sqlite` resolves to in the cloud board's bundle (wrangler.jsonc, "alias"). db.ts imports Database for
// open(), which only the board on a computer calls; the cloud board's database is worker/src/sqlite.ts.
export class Database {
	constructor() {
		throw new Error("bun:sqlite isn't in the cloud board: its database is the Durable Object's (worker/src/sqlite.ts)");
	}
}
