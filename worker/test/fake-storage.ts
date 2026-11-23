/**
 * A Durable Object's ctx.storage for tests, on bun:sqlite: only what the real one allows. Bindings positional and
 * string, number, null or ArrayBuffer (a named parameter or another type throws), BLOBs back as ArrayBuffer,
 * transactionSync. `WB_TEST_SQL=durable-object bun test` runs every test that uses freshDb() through it and the
 * adapter in worker/src/sqlite.ts, the way the cloud board runs the same code.
 */
import { Database } from "bun:sqlite";
import { parseParams, type SqlCursor, type SqlHost } from "../src/sqlite";

type Value = string | number | null | ArrayBuffer;

const toBuffer = (v: unknown) => (v instanceof Uint8Array ? (v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) as ArrayBuffer) : v);

export function fakeDurableStorage(path = ":memory:"): SqlHost {
	const native = new Database(path, { create: true });
	// The real one enforces foreign keys, like D1.
	native.run("PRAGMA foreign_keys = ON");
	return {
		sql: {
			exec(query: string, ...bindings: unknown[]): SqlCursor {
				if (parseParams(query).params.some((p) => p.kind === "named"))
					throw new Error(`a Durable Object takes positional bindings only: ${query.slice(0, 80)}`);
				for (const b of bindings)
					if (!(b === null || typeof b === "string" || typeof b === "number" || b instanceof ArrayBuffer))
						throw new TypeError(`a Durable Object can't bind a ${typeof b}`);
				const args = bindings.map((b) => (b instanceof ArrayBuffer ? new Uint8Array(b) : b)) as (string | number | null | Uint8Array)[];
				// With no bindings it may be several statements (the schema): run() takes them, query() only the first.
				const many = !args.length && !/^\s*(SELECT|WITH|PRAGMA)\b/i.test(query) && !/\bRETURNING\b/i.test(query);
				if (many) {
					native.run(query);
					return { toArray: () => [], raw: () => ({ toArray: () => [] }) };
				}
				const stmt = native.query(query);
				return {
					toArray: () =>
						(stmt.all(...args) as Record<string, unknown>[]).map((r) => {
							for (const k in r) r[k] = toBuffer(r[k]);
							return r as Record<string, Value>;
						}),
					raw: () => ({ toArray: () => (stmt.values(...args) as unknown[][]).map((r) => r.map(toBuffer) as Value[]) }),
				};
			},
			get databaseSize() {
				return 0;
			},
		},
		transactionSync: <T>(fn: () => T) => native.transaction(fn)(),
	};
}
