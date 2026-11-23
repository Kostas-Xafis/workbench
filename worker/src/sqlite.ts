/**
 * The part of bun:sqlite's Database that the board's code uses (db.ts and the feature files), over a Durable
 * Object's SQLite (ctx.storage.sql). Both are synchronous SQLite, so the board's functions run here unchanged:
 *
 * - query(sql) / prepare(sql): a statement with get() (first row or null), all(), values() and run() ({ changes,
 *   lastInsertRowid }). Bindings are positional (?) or, as with `strict: true`, one object whose keys name $params.
 * - run(sql, ...bindings) / exec(sql): runs it, several statements allowed.
 * - transaction(fn): a function that runs fn in one transaction (transactionSync); nested calls join the outer one.
 *
 * Durable Objects take positional bindings only, as string, number, null or ArrayBuffer, so named parameters are
 * rewritten to ? in order, booleans become 1/0, and typed arrays their bytes. BLOBs come back as Uint8Array, as
 * bun:sqlite returns them.
 */

type SqlValue = string | number | null | ArrayBuffer;

/** The SqlStorage cursor, as much as is used here. */
export interface SqlCursor {
	toArray(): Record<string, SqlValue>[];
	raw(): { toArray(): SqlValue[][] };
}

/** ctx.storage.sql and ctx.storage, as much as is used here. */
export interface SqlStorage {
	exec(query: string, ...bindings: unknown[]): SqlCursor;
	readonly databaseSize: number;
}
export interface SqlHost {
	sql: SqlStorage;
	transactionSync<T>(fn: () => T): T;
}

type Param = { kind: "?" } | { kind: "?n"; n: number } | { kind: "named"; name: string };

/**
 * The parameters in `sql`, in order, and the SQL with every named one replaced by `?`. Skips string literals,
 * quoted identifiers and comments, where a `$` or `?` is only text.
 */
export function parseParams(sql: string): { sql: string; params: Param[] } {
	const params: Param[] = [];
	let out = "";
	let i = 0;
	while (i < sql.length) {
		const c = sql[i];
		const quote = c === "'" ? "'" : c === '"' ? '"' : c === "`" ? "`" : c === "[" ? "]" : "";
		if (quote) {
			let j = i + 1;
			for (;;) {
				const k = sql.indexOf(quote, j);
				if (k < 0) {
					j = sql.length;
					break;
				}
				// '' inside a string (and "" inside an identifier) is the quote itself.
				if (quote !== "]" && sql[k + 1] === quote) {
					j = k + 2;
					continue;
				}
				j = k + 1;
				break;
			}
			out += sql.slice(i, j);
			i = j;
			continue;
		}
		if (c === "-" && sql[i + 1] === "-") {
			const k = sql.indexOf("\n", i);
			const j = k < 0 ? sql.length : k;
			out += sql.slice(i, j);
			i = j;
			continue;
		}
		if (c === "/" && sql[i + 1] === "*") {
			const k = sql.indexOf("*/", i + 2);
			const j = k < 0 ? sql.length : k + 2;
			out += sql.slice(i, j);
			i = j;
			continue;
		}
		if (c === "?") {
			const m = /^\?(\d+)/.exec(sql.slice(i));
			if (m) {
				params.push({ kind: "?n", n: Number(m[1]) });
				out += m[0];
				i += m[0].length;
			} else {
				params.push({ kind: "?" });
				out += "?";
				i++;
			}
			continue;
		}
		if ((c === "$" || c === ":" || c === "@") && /[A-Za-z_]/.test(sql[i + 1] ?? "")) {
			const m = /^[$:@][A-Za-z_][A-Za-z0-9_]*/.exec(sql.slice(i))!;
			params.push({ kind: "named", name: m[0].slice(1) });
			out += "?";
			i += m[0].length;
			continue;
		}
		out += c;
		i++;
	}
	return { sql: out, params };
}

function toSql(v: unknown): SqlValue {
	if (v === undefined || v === null) return null;
	if (typeof v === "boolean") return v ? 1 : 0;
	if (typeof v === "bigint") return Number(v);
	if (typeof v === "string" || typeof v === "number") return v;
	if (v instanceof ArrayBuffer) return v;
	if (ArrayBuffer.isView(v)) return v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) as ArrayBuffer;
	throw new TypeError(`can't bind a ${typeof v} to SQL`);
}

const fromSql = (v: SqlValue) => (v instanceof ArrayBuffer ? new Uint8Array(v) : v);

function rowFromSql(row: Record<string, SqlValue>) {
	for (const k in row) if (row[k] instanceof ArrayBuffer) (row as Record<string, unknown>)[k] = new Uint8Array(row[k] as ArrayBuffer);
	return row;
}

const isNamedArgs = (args: unknown[]) =>
	args.length === 1 &&
	typeof args[0] === "object" &&
	args[0] !== null &&
	!(args[0] instanceof ArrayBuffer) &&
	!ArrayBuffer.isView(args[0]) &&
	!Array.isArray(args[0]);

export class Statement {
	private readonly sql: string;
	private readonly params: Param[];
	private readonly named: boolean;

	constructor(
		private readonly db: SqliteDb,
		source: string,
	) {
		const parsed = parseParams(source);
		this.params = parsed.params;
		this.named = parsed.params.some((p) => p.kind === "named");
		// Without named parameters the SQL goes as written: ?NNN and ? keep their own numbering.
		this.sql = this.named ? parsed.sql : source;
	}

	/** The bindings in the order the rewritten SQL takes them. */
	private bind(args: unknown[]): SqlValue[] {
		if (!this.named) {
			if (isNamedArgs(args)) {
				if (this.params.length) throw new Error("this statement takes ? parameters, not names");
				return [];
			}
			return args.map(toSql);
		}
		if (!isNamedArgs(args)) throw new Error("this statement takes named parameters: pass one object");
		const values = args[0] as Record<string, unknown>;
		return this.params.map((p) => {
			if (p.kind !== "named") throw new Error("a statement can't mix ? and named parameters");
			if (Object.hasOwn(values, p.name)) return toSql(values[p.name]);
			if (Object.hasOwn(values, `$${p.name}`)) return toSql(values[`$${p.name}`]);
			// bun:sqlite with strict: true refuses a missing one too.
			throw new Error(`missing parameter $${p.name}`);
		});
	}

	private exec(args: unknown[]) {
		return this.db.storage.sql.exec(this.sql, ...this.bind(args));
	}

	all(...args: unknown[]): Record<string, unknown>[] {
		return this.exec(args).toArray().map(rowFromSql);
	}

	get(...args: unknown[]): Record<string, unknown> | null {
		return this.all(...args)[0] ?? null;
	}

	values(...args: unknown[]): unknown[][] {
		return this.exec(args)
			.raw()
			.toArray()
			.map((r) => r.map(fromSql));
	}

	run(...args: unknown[]): { changes: number; lastInsertRowid: number } {
		this.exec(args).toArray();
		const r = this.db.storage.sql.exec("SELECT changes() AS changes, last_insert_rowid() AS id").toArray()[0];
		return { changes: Number(r.changes), lastInsertRowid: Number(r.id) };
	}

	finalize() {}
}

export class SqliteDb {
	private readonly cache = new Map<string, Statement>();
	private depth = 0;

	/** `filename` is what db.filename says: nothing reads a file, but dispatch.ts tags runs with it. */
	constructor(
		readonly storage: SqlHost,
		readonly filename = ":durable-object:",
	) {}

	query(sql: string): Statement {
		let s = this.cache.get(sql);
		if (!s) {
			s = new Statement(this, sql);
			// Statements are built from a fixed set of strings; this only keeps a runaway caller from growing it.
			if (this.cache.size > 2000) this.cache.clear();
			this.cache.set(sql, s);
		}
		return s;
	}

	prepare(sql: string): Statement {
		return this.query(sql);
	}

	run(sql: string, ...args: unknown[]) {
		return new Statement(this, sql).run(...args);
	}

	exec(sql: string, ...args: unknown[]) {
		return this.run(sql, ...args);
	}

	/**
	 * Like bun:sqlite's, with .deferred, .immediate and .exclusive too. They're all the same here: a Durable Object
	 * runs one request at a time, so nothing else writes between BEGIN and COMMIT anyway.
	 */
	transaction<A extends unknown[], T>(fn: (...args: A) => T) {
		const run = (...args: A): T => {
			if (this.depth > 0) return fn(...args);
			this.depth++;
			try {
				return this.storage.transactionSync(() => fn(...args));
			} finally {
				this.depth--;
			}
		};
		return Object.assign(run, { deferred: run, immediate: run, exclusive: run });
	}

	close() {}
}
