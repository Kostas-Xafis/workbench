import { Database } from "bun:sqlite";
import { join } from "node:path";

export const KINDS = ["task", "check", "review", "decision", "setup", "bug", "idea"] as const;
export const STATUSES = ["todo", "doing", "waiting", "done", "dropped"] as const;
export const OWNERS = ["kostas", "agent"] as const;

export type Kind = (typeof KINDS)[number];
export type Status = (typeof STATUSES)[number];
export type Owner = (typeof OWNERS)[number];

export type Item = {
	id: number;
	project: string;
	title: string;
	body: string;
	kind: Kind;
	owner: Owner;
	status: Status;
	area: string;
	priority: number;
	branch: string;
	session: string;
	sources: string;
	created_at: string;
	updated_at: string;
	done_at: string | null;
};

export type Note = { id: number; item_id: number; at: string; author: string; text: string };
export type Project = { slug: string; name: string; path: string };

export const DB_PATH = process.env.WB_DB ?? join(import.meta.dir, "workbench.db");

export function open(path = DB_PATH) {
	const db = new Database(path, { create: true, strict: true });
	// The server and any number of `wb` calls from agents write at the same time.
	db.run("PRAGMA journal_mode = WAL");
	db.run("PRAGMA busy_timeout = 5000");
	db.run("PRAGMA foreign_keys = ON");
	db.run(`CREATE TABLE IF NOT EXISTS projects (
		slug TEXT PRIMARY KEY,
		name TEXT NOT NULL,
		path TEXT NOT NULL DEFAULT ''
	)`);
	db.run(`CREATE TABLE IF NOT EXISTS items (
		id INTEGER PRIMARY KEY,
		project TEXT NOT NULL REFERENCES projects(slug),
		title TEXT NOT NULL,
		body TEXT NOT NULL DEFAULT '',
		kind TEXT NOT NULL DEFAULT 'task',
		owner TEXT NOT NULL DEFAULT 'agent',
		status TEXT NOT NULL DEFAULT 'todo',
		area TEXT NOT NULL DEFAULT '',
		priority INTEGER NOT NULL DEFAULT 2,
		branch TEXT NOT NULL DEFAULT '',
		session TEXT NOT NULL DEFAULT '',
		sources TEXT NOT NULL DEFAULT '',
		created_at TEXT NOT NULL DEFAULT (datetime('now')),
		updated_at TEXT NOT NULL DEFAULT (datetime('now')),
		done_at TEXT
	)`);
	db.run(`CREATE TABLE IF NOT EXISTS notes (
		id INTEGER PRIMARY KEY,
		item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
		at TEXT NOT NULL DEFAULT (datetime('now')),
		author TEXT NOT NULL DEFAULT '',
		text TEXT NOT NULL
	)`);
	db.run("CREATE INDEX IF NOT EXISTS items_open ON items(project, status, owner)");
	db.run("CREATE INDEX IF NOT EXISTS notes_item ON notes(item_id)");
	return db;
}

export type Db = ReturnType<typeof open>;

const EDITABLE = [
	"project",
	"title",
	"body",
	"kind",
	"owner",
	"status",
	"area",
	"priority",
	"branch",
	"session",
	"sources",
] as const;
export type ItemPatch = Partial<Pick<Item, (typeof EDITABLE)[number]>>;

export function validate(patch: ItemPatch) {
	if (patch.kind && !KINDS.includes(patch.kind)) throw new Error(`kind must be one of ${KINDS.join(", ")}`);
	if (patch.status && !STATUSES.includes(patch.status)) throw new Error(`status must be one of ${STATUSES.join(", ")}`);
	if (patch.owner && !OWNERS.includes(patch.owner)) throw new Error(`owner must be one of ${OWNERS.join(", ")}`);
	if (patch.priority !== undefined && ![1, 2, 3].includes(Number(patch.priority)))
		throw new Error("priority must be 1, 2 or 3");
	if (patch.title !== undefined && !patch.title.trim()) throw new Error("title can't be empty");
}

export function projects(db: Db): Project[] {
	return db.query("SELECT * FROM projects ORDER BY name").all() as Project[];
}

export function upsertProject(db: Db, p: Project) {
	db.query(
		"INSERT INTO projects (slug, name, path) VALUES ($slug, $name, $path) ON CONFLICT(slug) DO UPDATE SET name = $name, path = $path",
	).run(p);
}

export function projectForPath(db: Db, dir: string): Project | undefined {
	return projects(db)
		.filter((p) => p.path && (dir === p.path || dir.startsWith(p.path + "/")))
		.sort((a, b) => b.path.length - a.path.length)[0];
}

export type ItemFilter = { project?: string; owner?: Owner; status?: Status[]; kind?: Kind; q?: string };

export function listItems(db: Db, f: ItemFilter = {}): Item[] {
	const where: string[] = [];
	const args: Record<string, string> = {};
	if (f.project) {
		where.push("project = $project");
		args.project = f.project;
	}
	if (f.owner) {
		where.push("owner = $owner");
		args.owner = f.owner;
	}
	if (f.kind) {
		where.push("kind = $kind");
		args.kind = f.kind;
	}
	if (f.status?.length) {
		where.push(`status IN (${f.status.map((_, i) => `$s${i}`).join(", ")})`);
		f.status.forEach((s, i) => (args[`s${i}`] = s));
	}
	if (f.q) {
		where.push("(title LIKE $q OR body LIKE $q OR area LIKE $q)");
		args.q = `%${f.q}%`;
	}
	const sql = `SELECT * FROM items ${where.length ? "WHERE " + where.join(" AND ") : ""}
		ORDER BY CASE status WHEN 'doing' THEN 0 WHEN 'todo' THEN 1 WHEN 'waiting' THEN 2 ELSE 3 END,
		priority, COALESCE(done_at, '') DESC, id`;
	return db.query(sql).all(args) as Item[];
}

export function getItem(db: Db, id: number): (Item & { notes: Note[] }) | undefined {
	const item = db.query("SELECT * FROM items WHERE id = ?").get(id) as Item | null;
	if (!item) return undefined;
	const notes = db.query("SELECT * FROM notes WHERE item_id = ? ORDER BY at, id").all(id) as Note[];
	return { ...item, notes };
}

export function addItem(db: Db, item: ItemPatch & { title: string; project: string }, author = ""): number {
	validate(item);
	const fields = EDITABLE.filter((k) => item[k] !== undefined);
	const row = Object.fromEntries(fields.map((k) => [k, item[k]]));
	const { id } = db
		.query(`INSERT INTO items (${fields.join(", ")}) VALUES (${fields.map((k) => "$" + k).join(", ")}) RETURNING id`)
		.get(row as Record<string, string | number>) as { id: number };
	if (item.status === "done") db.query("UPDATE items SET done_at = datetime('now') WHERE id = ?").run(id);
	addNote(db, id, "created", author);
	return id;
}

export function updateItem(db: Db, id: number, patch: ItemPatch, author = ""): void {
	validate(patch);
	const before = getItem(db, id);
	if (!before) throw new Error(`no item #${id}`);
	const fields = EDITABLE.filter((k) => patch[k] !== undefined && patch[k] !== before[k]);
	if (!fields.length) return;
	const row = Object.fromEntries(fields.map((k) => [k, patch[k]])) as Record<string, string | number>;
	let doneAt = "";
	if (patch.status && patch.status !== before.status)
		doneAt = patch.status === "done" || patch.status === "dropped" ? ", done_at = datetime('now')" : ", done_at = NULL";
	db.query(
		`UPDATE items SET ${fields.map((k) => `${k} = $${k}`).join(", ")}, updated_at = datetime('now')${doneAt} WHERE id = $id`,
	).run({ ...row, id });
	const changes = fields.filter((k) => k !== "body").map((k) => `${k}: ${before[k] || "—"} → ${patch[k] || "—"}`);
	if (fields.includes("body")) changes.push("body edited");
	addNote(db, id, changes.join(" · "), author);
}

export function addNote(db: Db, itemId: number, text: string, author = "") {
	db.query("INSERT INTO notes (item_id, text, author) VALUES (?, ?, ?)").run(itemId, text, author);
	db.query("UPDATE items SET updated_at = datetime('now') WHERE id = ?").run(itemId);
}
