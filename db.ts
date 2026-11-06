import { Database } from "bun:sqlite";
import { timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { createTables as createImageTables, itemImages, type ImageInfo } from "./images";
import { createSettingsTable, getSetting, getSettings, ownerFor } from "./settings";
import { createTables as createTrackerTables } from "./trackers";

export const KINDS = ["task", "check", "review", "decision", "setup", "bug", "idea"] as const;
export const STATUSES = ["todo", "doing", "waiting", "done", "dropped"] as const;
export const OWNERS = ["kostas", "agent"] as const;

export type Kind = (typeof KINDS)[number];
export type Status = (typeof STATUSES)[number];
export type Owner = (typeof OWNERS)[number];

export type Item = {
	id: number;
	/** The id people and agents use, shown as `wb-<ref>`. */
	ref: string;
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
	/** JSON array of the choices a decision offers; '' = none. */
	options: string;
	/** What Kostas picked or wrote. */
	answer: string;
	/** How many images it has (listItems and getItem). */
	image_count?: number;
	created_at: string;
	updated_at: string;
	done_at: string | null;
};

export type Note = { id: number; item_id: number; at: string; author: string; text: string };
export type Project = {
	slug: string;
	name: string;
	path: string;
	/** Logo file, relative to `path` or absolute; '' = look for one in the repo. */
	icon: string;
	/** Place on the board's left edge; ties go by name. */
	sort: number;
	/** When it was archived: off the rail and "All", its trackers paused. NULL = active. */
	archived_at: string | null;
};

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
	// project '' = shown with every project.
	db.run(`CREATE TABLE IF NOT EXISTS links (
		id INTEGER PRIMARY KEY,
		project TEXT NOT NULL DEFAULT '',
		label TEXT NOT NULL,
		url TEXT NOT NULL,
		sort INTEGER NOT NULL DEFAULT 0
	)`);
	const itemCols = (db.query("PRAGMA table_info(items)").all() as { name: string }[]).map((c) => c.name);
	if (!itemCols.includes("ref")) {
		db.run("ALTER TABLE items ADD COLUMN ref TEXT");
		for (const { id } of db.query("SELECT id FROM items").all() as { id: number }[])
			db.query("UPDATE items SET ref = ? WHERE id = ?").run(newRef(db), id);
	}
	db.run("CREATE UNIQUE INDEX IF NOT EXISTS items_ref ON items(ref)");
	if (!itemCols.includes("options")) {
		db.run("ALTER TABLE items ADD COLUMN options TEXT NOT NULL DEFAULT ''");
		db.run("ALTER TABLE items ADD COLUMN answer TEXT NOT NULL DEFAULT ''");
	}
	const linkCols = (db.query("PRAGMA table_info(links)").all() as { name: string }[]).map((c) => c.name);
	if (!linkCols.includes("icon_url")) {
		db.run("ALTER TABLE links ADD COLUMN icon_url TEXT NOT NULL DEFAULT ''");
		db.run("ALTER TABLE links ADD COLUMN icon BLOB");
		db.run("ALTER TABLE links ADD COLUMN icon_type TEXT NOT NULL DEFAULT ''");
		db.run("ALTER TABLE links ADD COLUMN icon_checked_at TEXT");
	}
	// `group` is an SQL keyword.
	if (!linkCols.includes("grp")) db.run("ALTER TABLE links ADD COLUMN grp TEXT NOT NULL DEFAULT ''");
	const projectCols = (db.query("PRAGMA table_info(projects)").all() as { name: string }[]).map((c) => c.name);
	if (!projectCols.includes("icon")) db.run("ALTER TABLE projects ADD COLUMN icon TEXT NOT NULL DEFAULT ''");
	if (!projectCols.includes("sort")) db.run("ALTER TABLE projects ADD COLUMN sort INTEGER NOT NULL DEFAULT 0");
	if (!projectCols.includes("archived_at")) db.run("ALTER TABLE projects ADD COLUMN archived_at TEXT");
	// A report is one HTML page; publishing it again under the same name adds a version.
	db.run(`CREATE TABLE IF NOT EXISTS reports (
		id INTEGER PRIMARY KEY,
		project TEXT NOT NULL REFERENCES projects(slug),
		name TEXT NOT NULL,
		title TEXT NOT NULL,
		grp TEXT NOT NULL DEFAULT '',
		created_at TEXT NOT NULL DEFAULT (datetime('now')),
		updated_at TEXT NOT NULL DEFAULT (datetime('now')),
		UNIQUE (project, name)
	)`);
	db.run(`CREATE TABLE IF NOT EXISTS report_versions (
		id INTEGER PRIMARY KEY,
		report_id INTEGER NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
		n INTEGER NOT NULL,
		html TEXT NOT NULL,
		text TEXT NOT NULL DEFAULT '',
		author TEXT NOT NULL DEFAULT '',
		at TEXT NOT NULL DEFAULT (datetime('now')),
		UNIQUE (report_id, n)
	)`);
	// What a report page saved with wb.state.set: by project and name, so it outlives new versions.
	db.run(`CREATE TABLE IF NOT EXISTS report_state (
		project TEXT NOT NULL,
		name TEXT NOT NULL,
		json TEXT NOT NULL,
		updated_at TEXT NOT NULL DEFAULT (datetime('now')),
		PRIMARY KEY (project, name)
	)`);
	// The vault holds only what the browser encrypted. The password never reaches the server: the browser
	// derives a key from it and an auth token, and only a hash of the token is kept here.
	db.run(`CREATE TABLE IF NOT EXISTS vault (
		id INTEGER PRIMARY KEY CHECK (id = 1),
		salt TEXT NOT NULL,
		iterations INTEGER NOT NULL,
		auth_hash TEXT NOT NULL,
		created_at TEXT NOT NULL DEFAULT (datetime('now')),
		changed_at TEXT NOT NULL DEFAULT (datetime('now'))
	)`);
	// meta = {name, note} and value are each `base64(iv).base64(AES-GCM ciphertext)`.
	db.run(`CREATE TABLE IF NOT EXISTS secrets (
		id INTEGER PRIMARY KEY,
		project TEXT NOT NULL DEFAULT '',
		meta TEXT NOT NULL,
		value TEXT NOT NULL,
		created_at TEXT NOT NULL DEFAULT (datetime('now')),
		updated_at TEXT NOT NULL DEFAULT (datetime('now'))
	)`);
	// Data sources a report can call through the board (see sources.ts). `headers` is sealed with a key
	// that lives outside the database, so this table and its backups hold no usable secret.
	db.run(`CREATE TABLE IF NOT EXISTS sources (
		project TEXT NOT NULL REFERENCES projects(slug) ON DELETE CASCADE,
		name TEXT NOT NULL,
		base_url TEXT NOT NULL,
		write INTEGER NOT NULL DEFAULT 0,
		header_names TEXT NOT NULL DEFAULT '',
		headers TEXT NOT NULL,
		created_at TEXT NOT NULL DEFAULT (datetime('now')),
		updated_at TEXT NOT NULL DEFAULT (datetime('now')),
		PRIMARY KEY (project, name)
	)`);
	// Screenshots on items (see images.ts).
	createImageTables(db);
	// Status trackers (see trackers.ts).
	createTrackerTables(db);
	// Board-wide settings (see settings.ts).
	createSettingsTable(db);
	return db;
}

export type Db = ReturnType<typeof open>;

// No 0/o, 1/l/i: refs get read aloud and typed into prompts. 31^4 ≈ 920k.
const REF_ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz";

function newRef(db: Db): string {
	for (;;) {
		const ref = Array.from(
			crypto.getRandomValues(new Uint8Array(4)),
			(b) => REF_ALPHABET[b % REF_ALPHABET.length],
		).join("");
		if (!db.query("SELECT 1 FROM items WHERE ref = ?").get(ref)) return ref;
	}
}

/** Accepts `wb-k3f9`, `k3f9`, and the old numbers (`#56`, `56`). */
export function resolveItem(db: Db, s: string | undefined): number | undefined {
	const t = (s ?? "").trim().toLowerCase().replace(/^wb-/, "").replace(/^#/, "");
	if (!t) return undefined;
	const byRef = db.query("SELECT id FROM items WHERE ref = ?").get(t) as { id: number } | null;
	if (byRef) return byRef.id;
	if (/^\d+$/.test(t))
		return (db.query("SELECT id FROM items WHERE id = ?").get(Number(t)) as { id: number } | null)?.id;
	return undefined;
}

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
	"options",
	"answer",
] as const;
/** `options` may also be given as a list. */
export type ItemPatch = Partial<Omit<Pick<Item, (typeof EDITABLE)[number]>, "options">> & {
	options?: string | string[];
};

/** The choices of a decision as a list. */
export function itemOptions(i: Pick<Item, "options">): string[] {
	try {
		const list = JSON.parse(i.options || "[]");
		return Array.isArray(list) ? list.map(String) : [];
	} catch {
		return [];
	}
}

function normalize(patch: ItemPatch): ItemPatch {
	if (patch.options === undefined) return patch;
	const list = Array.isArray(patch.options) ? patch.options : itemOptions({ options: patch.options });
	const clean = list.map((o) => String(o).trim()).filter(Boolean);
	return { ...patch, options: clean.length ? JSON.stringify(clean) : "" };
}

export function validate(patch: ItemPatch) {
	if (patch.kind && !KINDS.includes(patch.kind)) throw new Error(`kind must be one of ${KINDS.join(", ")}`);
	if (patch.status && !STATUSES.includes(patch.status)) throw new Error(`status must be one of ${STATUSES.join(", ")}`);
	if (patch.owner && !OWNERS.includes(patch.owner)) throw new Error(`owner must be one of ${OWNERS.join(", ")}`);
	if (patch.priority !== undefined && ![1, 2, 3].includes(Number(patch.priority)))
		throw new Error("priority must be 1, 2 or 3");
	if (patch.title !== undefined && !patch.title.trim()) throw new Error("title can't be empty");
}

const PROJECT_ORDER = "ORDER BY sort, name COLLATE NOCASE";

/** Every project, archived ones too (check `archived_at`), in the board's order. */
export function projects(db: Db): Project[] {
	return db.query(`SELECT * FROM projects ${PROJECT_ORDER}`).all() as Project[];
}

/** Projects with their open items: `mine` waits on Kostas, `open` is all of them. */
export function projectsWithCounts(db: Db): (Project & { mine: number; open: number })[] {
	return db
		.query(
			`SELECT p.*,
				(SELECT COUNT(*) FROM items i WHERE i.project = p.slug AND i.owner = 'kostas' AND i.status IN ('todo', 'doing', 'waiting')) AS mine,
				(SELECT COUNT(*) FROM items i WHERE i.project = p.slug AND i.status IN ('todo', 'doing', 'waiting')) AS open
			FROM projects p ${PROJECT_ORDER}`,
		)
		.all() as (Project & { mine: number; open: number })[];
}

export const PROJECT_SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** Adds a project at the end of the list, or renames / moves an existing one. */
export function upsertProject(db: Db, p: Pick<Project, "slug" | "name" | "path">) {
	db.query(
		`INSERT INTO projects (slug, name, path, sort) VALUES ($slug, $name, $path, (SELECT COALESCE(MAX(sort), 0) + 1 FROM projects))
		ON CONFLICT(slug) DO UPDATE SET name = $name, path = $path`,
	).run(p);
}

/** A new project from the board: the slug must be free, since items, reports and links point at it. */
export function addProject(db: Db, p: { slug: string; name: string; path: string; icon?: string }) {
	const slug = String(p.slug ?? "").trim();
	if (!PROJECT_SLUG.test(slug)) throw new Error("the slug is lowercase letters, digits and dashes (up to 40), e.g. my-app");
	if (db.query("SELECT 1 FROM projects WHERE slug = ?").get(slug)) throw new Error(`there is already a project "${slug}"`);
	const name = String(p.name ?? "").trim();
	if (!name) throw new Error("the project needs a name");
	upsertProject(db, { slug, name, path: String(p.path ?? "").trim().replace(/(.)\/+$/, "$1") });
	if (p.icon) setProjectIcon(db, slug, p.icon.trim());
	return getProject(db, slug)!;
}

export function getProject(db: Db, slug: string): Project | undefined {
	return (db.query("SELECT * FROM projects WHERE slug = ?").get(slug) as Project | null) ?? undefined;
}

export type ProjectPatch = { name?: string; path?: string; icon?: string; archived?: boolean };

export function updateProject(db: Db, slug: string, patch: ProjectPatch): Project {
	const p = getProject(db, slug);
	if (!p) throw new Error(`no project "${slug}"`);
	if (patch.name !== undefined && !String(patch.name).trim()) throw new Error("the project needs a name");
	const next = {
		slug,
		name: patch.name === undefined ? p.name : String(patch.name).trim(),
		path: patch.path === undefined ? p.path : String(patch.path).trim().replace(/(.)\/+$/, "$1"),
		icon: patch.icon === undefined ? p.icon : String(patch.icon).trim(),
	};
	db.query("UPDATE projects SET name = $name, path = $path, icon = $icon WHERE slug = $slug").run(next);
	if (patch.archived !== undefined)
		db.query(
			patch.archived
				? "UPDATE projects SET archived_at = COALESCE(archived_at, datetime('now')) WHERE slug = ?"
				: "UPDATE projects SET archived_at = NULL WHERE slug = ?",
		).run(slug);
	return getProject(db, slug)!;
}

/** The board's order, as a list of slugs; projects left out keep their place after these. */
export function setProjectOrder(db: Db, slugs: string[]) {
	const known = new Set(projects(db).map((p) => p.slug));
	const order = [...new Set(slugs)].filter((s) => known.has(s));
	const rest = projects(db).filter((p) => !order.includes(p.slug)).map((p) => p.slug);
	const set = db.query("UPDATE projects SET sort = ? WHERE slug = ?");
	db.transaction(() => [...order, ...rest].forEach((s, i) => set.run(i + 1, s)))();
}

/** What points at a project. Only one with nothing can be removed; the rest are archived. */
export function projectUsage(db: Db, slug: string) {
	const n = (sql: string) => (db.query(sql).get(slug) as { n: number }).n;
	return {
		items: n("SELECT COUNT(*) AS n FROM items WHERE project = ?"),
		reports: n("SELECT COUNT(*) AS n FROM reports WHERE project = ?"),
		links: n("SELECT COUNT(*) AS n FROM links WHERE project = ?"),
		secrets: n("SELECT COUNT(*) AS n FROM secrets WHERE project = ?"),
		trackers: n("SELECT COUNT(*) AS n FROM trackers WHERE project = ?"),
		sources: n("SELECT COUNT(*) AS n FROM sources WHERE project = ?"),
	};
}

export function removeProject(db: Db, slug: string) {
	if (!getProject(db, slug)) throw new Error(`no project "${slug}"`);
	const used = Object.entries(projectUsage(db, slug)).filter(([, n]) => n);
	if (used.length)
		throw new Error(`${slug} still has ${used.map(([k, n]) => `${n} ${n === 1 ? k.replace(/s$/, "") : k}`).join(", ")}; archive it instead`);
	db.query("DELETE FROM report_state WHERE project = ?").run(slug);
	db.query("DELETE FROM projects WHERE slug = ?").run(slug);
}

export function setProjectIcon(db: Db, slug: string, icon: string) {
	if (!db.query("UPDATE projects SET icon = ? WHERE slug = ?").run(icon, slug).changes)
		throw new Error(`no project "${slug}"`);
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
		where.push(
			"(title LIKE $q OR body LIKE $q OR area LIKE $q OR ref = $ref OR id IN (SELECT item_id FROM notes WHERE text LIKE $q))",
		);
		args.q = `%${f.q}%`;
		args.ref = f.q.trim().toLowerCase().replace(/^wb-/, "");
	}
	const sql = `SELECT *, (SELECT COUNT(*) FROM images WHERE images.item_id = items.id) AS image_count FROM items ${where.length ? "WHERE " + where.join(" AND ") : ""}
		ORDER BY CASE status WHEN 'doing' THEN 0 WHEN 'todo' THEN 1 WHEN 'waiting' THEN 2 ELSE 3 END,
		priority, COALESCE(done_at, '') DESC, id`;
	return db.query(sql).all(args) as Item[];
}

export function getItem(db: Db, id: number): (Item & { notes: Note[]; images: ImageInfo[] }) | undefined {
	const item = db.query("SELECT * FROM items WHERE id = ?").get(id) as Item | null;
	if (!item) return undefined;
	const notes = db.query("SELECT * FROM notes WHERE item_id = ? ORDER BY at, id").all(id) as Note[];
	const images = itemImages(db, id);
	return { ...item, notes, images, image_count: images.length };
}

export function addItem(db: Db, item: ItemPatch & { title: string; project: string }, author = ""): number {
	item = { ...item, ...normalize(item) };
	validate(item);
	// Nobody said who acts: the board's setting for the kind (Settings → You and your day).
	item.owner ||= ownerFor(db, item.kind || "task");
	const fields = EDITABLE.filter((k) => item[k] !== undefined);
	const row = Object.fromEntries([...fields.map((k) => [k, item[k]]), ["ref", newRef(db)]]);
	const { id } = db
		.query(
			`INSERT INTO items (${[...fields, "ref"].join(", ")}) VALUES (${[...fields, "ref"].map((k) => "$" + k).join(", ")}) RETURNING id`,
		)
		.get(row as Record<string, string | number>) as { id: number };
	if (item.status === "done") db.query("UPDATE items SET done_at = datetime('now') WHERE id = ?").run(id);
	// New work for an archived project brings it back, so the item doesn't land somewhere nobody looks.
	if (item.status !== "done" && item.status !== "dropped")
		db.query("UPDATE projects SET archived_at = NULL WHERE slug = ? AND archived_at IS NOT NULL").run(item.project);
	addNote(db, id, "created", author);
	return id;
}

export function updateItem(db: Db, id: number, patch: ItemPatch, author = ""): void {
	patch = normalize(patch);
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
	const changes = fields
		.filter((k) => k !== "body" && k !== "options")
		.map((k) => `${k}: ${before[k] || "—"} → ${patch[k] || "—"}`);
	if (fields.includes("body")) changes.push("body edited");
	if (fields.includes("options")) changes.push(`options: ${itemOptions(patch as Item).join(" | ") || "—"}`);
	addNote(db, id, changes.join(" · "), author);
}

export function addNote(db: Db, itemId: number, text: string, author = "") {
	db.query("INSERT INTO notes (item_id, text, author) VALUES (?, ?, ?)").run(itemId, text, author);
	db.query("UPDATE items SET updated_at = datetime('now') WHERE id = ?").run(itemId);
}

export type Link = {
	id: number;
	project: string;
	label: string;
	url: string;
	sort: number;
	/** The box it's drawn in on the board; '' = no box. */
	grp: string;
	/** Where to take the icon from; '' = find the site's own favicon. */
	icon_url: string;
	has_icon: number;
};
export type LinkPatch = Partial<Pick<Link, "project" | "label" | "url" | "sort" | "icon_url" | "grp">>;

function validateLink(l: LinkPatch) {
	if (l.label !== undefined && !l.label.trim()) throw new Error("label can't be empty");
	if (l.url !== undefined && !/^(https?|claude|file):\/\//.test(l.url))
		throw new Error("url must start with http:// or https://");
	if (l.icon_url && !/^https?:\/\//.test(l.icon_url))
		throw new Error("icon address must start with http:// or https://");
}

export function listLinks(db: Db): Link[] {
	return db
		.query(
			"SELECT id, project, label, url, sort, grp, icon_url, icon IS NOT NULL AS has_icon FROM links ORDER BY project != '', project, grp, sort, id",
		)
		.all() as Link[];
}

export function addLink(
	db: Db,
	l: { label: string; url: string; project?: string; icon_url?: string; grp?: string },
): number {
	validateLink(l);
	const { next } = db
		.query("SELECT COALESCE(MAX(sort), 0) + 1 AS next FROM links WHERE project = ?")
		.get(l.project ?? "") as { next: number };
	const { id } = db
		.query("INSERT INTO links (project, label, url, sort, icon_url, grp) VALUES (?, ?, ?, ?, ?, ?) RETURNING id")
		.get(l.project ?? "", l.label.trim(), l.url.trim(), next, (l.icon_url ?? "").trim(), (l.grp ?? "").trim()) as {
		id: number;
	};
	return id;
}

export function updateLink(db: Db, id: number, patch: LinkPatch) {
	validateLink(patch);
	const fields = (["project", "label", "url", "sort", "icon_url", "grp"] as const).filter(
		(k) => patch[k] !== undefined,
	);
	if (!fields.length) return;
	const row = Object.fromEntries(
		fields.map((k) => [k, typeof patch[k] === "string" ? (patch[k] as string).trim() : patch[k]]),
	);
	const res = db
		.query(`UPDATE links SET ${fields.map((k) => `${k} = $${k}`).join(", ")} WHERE id = $id`)
		.run({ ...row, id } as Record<string, string | number>);
	if (!res.changes) throw new Error(`no link #${id}`);
	// A different page or icon address means the stored icon may be wrong: fetch again.
	if (fields.includes("url") || fields.includes("icon_url")) clearIcon(db, id);
}

export function linkIcon(db: Db, id: number) {
	return db.query("SELECT url, icon_url, icon, icon_type, icon_checked_at FROM links WHERE id = ?").get(id) as {
		url: string;
		icon_url: string;
		icon: Uint8Array | null;
		icon_type: string;
		icon_checked_at: string | null;
	} | null;
}

export function storeIcon(db: Db, id: number, icon: { data: Uint8Array; type: string } | null) {
	db.query("UPDATE links SET icon = ?, icon_type = ?, icon_checked_at = datetime('now') WHERE id = ?").run(
		icon?.data ?? null,
		icon?.type ?? "",
		id,
	);
}

export function clearIcon(db: Db, id?: number) {
	const sql = "UPDATE links SET icon = NULL, icon_type = '', icon_checked_at = NULL";
	if (id === undefined) db.run(sql);
	else db.query(`${sql} WHERE id = ?`).run(id);
}

export function removeLink(db: Db, id: number) {
	if (!db.query("DELETE FROM links WHERE id = ?").run(id).changes) throw new Error(`no link #${id}`);
}

export type Report = {
	id: number;
	project: string;
	/** Unique in the project; publishing the same name again adds a version. */
	name: string;
	title: string;
	grp: string;
	created_at: string;
	updated_at: string;
	/** Latest version number. */
	version: number;
};
export type ReportVersion = { n: number; at: string; author: string; bytes: number };

const REPORT_COLS = `r.*, (SELECT MAX(n) FROM report_versions v WHERE v.report_id = r.id) AS version`;

export function listReports(db: Db, project?: string): Report[] {
	return db
		.query(
			`SELECT ${REPORT_COLS} FROM reports r ${project ? "WHERE project = $project" : ""} ORDER BY project, grp, title COLLATE NOCASE`,
		)
		.all(project ? { project } : {}) as Report[];
}

export function getReport(db: Db, id: number): (Report & { versions: ReportVersion[] }) | undefined {
	const r = db.query(`SELECT ${REPORT_COLS} FROM reports r WHERE id = ?`).get(id) as Report | null;
	if (!r) return undefined;
	const versions = db
		.query("SELECT n, at, author, length(html) AS bytes FROM report_versions WHERE report_id = ? ORDER BY n DESC")
		.all(id) as ReportVersion[];
	return { ...r, versions };
}

/** The page of version `n`, or the latest. */
export function reportHtml(db: Db, id: number, n?: number) {
	return db
		.query(
			`SELECT html, n FROM report_versions WHERE report_id = $id ${n ? "AND n = $n" : ""} ORDER BY n DESC LIMIT 1`,
		)
		.get(n ? { id, n } : { id }) as { html: string; n: number } | null;
}

/** Visible text of a page, for search. */
export function htmlText(html: string) {
	return html
		.replace(/<(script|style|template|svg)\b[\s\S]*?<\/\1>/gi, " ")
		.replace(/<!--[\s\S]*?-->/g, " ")
		.replace(/<[^>]+>/g, " ")
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/\s+/g, " ")
		.trim();
}

export function htmlTitle(html: string) {
	const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) ?? html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
	return m ? htmlText(m[1]) : "";
}

/** Adds the report, or a new version of the one with this name. An unchanged page adds nothing. */
export function publishReport(
	db: Db,
	r: { project: string; name: string; html: string; title?: string; grp?: string },
	author = "",
): { id: number; n: number; changed: boolean } {
	const name = r.name.trim().toLowerCase();
	if (!name) throw new Error("report needs a name");
	if (!r.html.trim()) throw new Error("the page is empty");
	if (!db.query("SELECT 1 FROM projects WHERE slug = ?").get(r.project)) throw new Error(`no project "${r.project}"`);
	return db.transaction(() => {
		let row = db.query("SELECT id FROM reports WHERE project = ? AND name = ?").get(r.project, name) as {
			id: number;
		} | null;
		const title = r.title?.trim() || htmlTitle(r.html) || name;
		if (!row) {
			row = db
				.query("INSERT INTO reports (project, name, title, grp) VALUES (?, ?, ?, ?) RETURNING id")
				.get(r.project, name, title, (r.grp ?? "").trim()) as { id: number };
		} else {
			const sets = ["title = $title"];
			if (r.grp !== undefined) sets.push("grp = $grp");
			db.query(`UPDATE reports SET ${sets.join(", ")} WHERE id = $id`).run({
				id: row.id,
				title,
				...(r.grp !== undefined ? { grp: r.grp.trim() } : {}),
			});
		}
		const latest = reportHtml(db, row.id);
		if (latest?.html === r.html) return { id: row.id, n: latest.n, changed: false };
		const n = (latest?.n ?? 0) + 1;
		db.query("INSERT INTO report_versions (report_id, n, html, text, author) VALUES (?, ?, ?, ?, ?)").run(
			row.id,
			n,
			r.html,
			htmlText(r.html),
			author,
		);
		db.query("UPDATE reports SET updated_at = datetime('now') WHERE id = ?").run(row.id);
		return { id: row.id, n, changed: true };
	})();
}

export function removeReport(db: Db, id: number) {
	db.transaction(() => {
		db.query("DELETE FROM report_state WHERE (project, name) IN (SELECT project, name FROM reports WHERE id = ?)").run(id);
		if (!db.query("DELETE FROM reports WHERE id = ?").run(id).changes) throw new Error(`no report #${id}`);
	})();
}

export const REPORT_STATE_MAX = 256 * 1024;

/** What the report's page saved, as JSON text, or null. */
export function reportState(db: Db, id: number): string | null {
	const row = db
		.query("SELECT s.json FROM report_state s JOIN reports r USING (project, name) WHERE r.id = ?")
		.get(id) as { json: string } | null;
	return row?.json ?? null;
}

/** Replaces the saved state with `json` (an object or array), or clears it when `json` is null. */
export function setReportState(db: Db, id: number, json: string | null) {
	const r = db.query("SELECT project, name FROM reports WHERE id = ?").get(id) as { project: string; name: string } | null;
	if (!r) throw new Error(`no report #${id}`);
	if (json === null) return void db.query("DELETE FROM report_state WHERE project = ? AND name = ?").run(r.project, r.name);
	if (Buffer.byteLength(json) > REPORT_STATE_MAX) throw new Error(`state is over ${REPORT_STATE_MAX / 1024} KB`);
	let v: unknown;
	try {
		v = JSON.parse(json);
	} catch {
		throw new Error("state must be JSON");
	}
	if (typeof v !== "object" || v === null) throw new Error("state must be an object or array");
	db.query(
		`INSERT INTO report_state (project, name, json) VALUES (?, ?, ?)
		ON CONFLICT (project, name) DO UPDATE SET json = excluded.json, updated_at = datetime('now')`,
	).run(r.project, r.name, JSON.stringify(v));
}

/** Everything matching `q` in a project (or all of them): items, reports with a snippet, links. */
export function search(db: Db, q: string, project?: string) {
	const like = `%${q}%`;
	const items = listItems(db, { project, q }).slice(0, 15);
	const reports = (
		db
			.query(
				`SELECT ${REPORT_COLS}, (SELECT text FROM report_versions v WHERE v.report_id = r.id ORDER BY n DESC LIMIT 1) AS text
				FROM reports r WHERE ($project = '' OR project = $project)
				AND (title LIKE $q OR name LIKE $q OR id IN (SELECT report_id FROM report_versions v
					WHERE v.n = (SELECT MAX(n) FROM report_versions w WHERE w.report_id = v.report_id) AND text LIKE $q))
				ORDER BY updated_at DESC LIMIT 10`,
			)
			.all({ project: project ?? "", q: like }) as (Report & { text: string })[]
	).map(({ text, ...r }) => {
		const at = text.toLowerCase().indexOf(q.toLowerCase());
		const snippet = at < 0 ? "" : (at > 60 ? "…" : "") + text.slice(Math.max(0, at - 60), at + q.length + 80);
		return { ...r, snippet };
	});
	const links = db
		.query(
			`SELECT id, project, label, url, grp, icon_url FROM links WHERE ($project = '' OR project IN ('', $project))
			AND (label LIKE $q OR url LIKE $q OR grp LIKE $q) ORDER BY label LIMIT 10`,
		)
		.all({ project: project ?? "", q: like });
	return { items, reports, links };
}

export type VaultInfo = { salt: string; iterations: number; changed_at: string };
export type Secret = { id: number; project: string; meta: string; created_at: string; updated_at: string };
export type SecretPatch = { project?: string; meta?: string; value?: string };

const SEALED = /^[A-Za-z0-9+/]+={0,2}\.[A-Za-z0-9+/]+={0,2}$/;
const AUTH = /^[0-9a-f]{64}$/;
const sha256 = (s: string) => new Bun.CryptoHasher("sha256").update(s).digest("hex");

export function vaultInfo(db: Db): VaultInfo | null {
	return db.query("SELECT salt, iterations, changed_at FROM vault WHERE id = 1").get() as VaultInfo | null;
}

function validateVault(v: { salt: string; iterations: number; auth: string }) {
	if (!/^[A-Za-z0-9+/]{16,}={0,2}$/.test(v.salt ?? "")) throw new Error("bad salt");
	if (!Number.isInteger(v.iterations) || v.iterations < 100_000) throw new Error("too few iterations");
	if (!AUTH.test(v.auth ?? "")) throw new Error("bad auth token");
}

export function setupVault(db: Db, v: { salt: string; iterations: number; auth: string }) {
	validateVault(v);
	if (vaultInfo(db)) throw new Error("the vault already has a password");
	db.query("INSERT INTO vault (id, salt, iterations, auth_hash) VALUES (1, ?, ?, ?)").run(
		v.salt,
		v.iterations,
		sha256(v.auth),
	);
}

export function vaultAuthOk(db: Db, auth: string): boolean {
	const row = db.query("SELECT auth_hash FROM vault WHERE id = 1").get() as { auth_hash: string } | null;
	if (!row || !AUTH.test(auth)) return false;
	return timingSafeEqual(Buffer.from(sha256(auth)), Buffer.from(row.auth_hash));
}

function validateSecret(s: SecretPatch) {
	if (s.meta !== undefined && !SEALED.test(s.meta)) throw new Error("meta must be encrypted");
	if (s.value !== undefined && !SEALED.test(s.value)) throw new Error("value must be encrypted");
}

function checkProject(db: Db, project: string) {
	if (project && !db.query("SELECT 1 FROM projects WHERE slug = ?").get(project))
		throw new Error(`no project "${project}"`);
}

/** Names and notes only (still encrypted); a value is fetched one at a time. */
export function listSecrets(db: Db): Secret[] {
	return db.query("SELECT id, project, meta, created_at, updated_at FROM secrets ORDER BY id").all() as Secret[];
}

export function secretValue(db: Db, id: number): string | undefined {
	return (db.query("SELECT value FROM secrets WHERE id = ?").get(id) as { value: string } | null)?.value;
}

export function addSecret(db: Db, s: { project?: string; meta: string; value: string }): number {
	validateSecret(s);
	if (!s.meta || !s.value) throw new Error("a secret needs a name and a value");
	checkProject(db, s.project ?? "");
	const { id } = db
		.query("INSERT INTO secrets (project, meta, value) VALUES (?, ?, ?) RETURNING id")
		.get(s.project ?? "", s.meta, s.value) as { id: number };
	return id;
}

export function updateSecret(db: Db, id: number, s: SecretPatch) {
	validateSecret(s);
	if (s.project !== undefined) checkProject(db, s.project);
	const fields = (["project", "meta", "value"] as const).filter((k) => s[k] !== undefined);
	if (!fields.length) return;
	const res = db
		.query(
			`UPDATE secrets SET ${fields.map((k) => `${k} = $${k}`).join(", ")}, updated_at = datetime('now') WHERE id = $id`,
		)
		.run({ ...Object.fromEntries(fields.map((k) => [k, s[k]!])), id });
	if (!res.changes) throw new Error(`no secret #${id}`);
}

export function removeSecret(db: Db, id: number) {
	if (!db.query("DELETE FROM secrets WHERE id = ?").run(id).changes) throw new Error(`no secret #${id}`);
}

/** New password: every secret re-encrypted by the browser, swapped in at once. */
export function rekeyVault(
	db: Db,
	v: { salt: string; iterations: number; auth: string },
	secrets: { id: number; meta: string; value: string }[],
) {
	validateVault(v);
	for (const s of secrets) validateSecret(s);
	db.transaction(() => {
		const ids = listSecrets(db)
			.map((s) => s.id)
			.sort((a, b) => a - b);
		const got = secrets.map((s) => s.id).sort((a, b) => a - b);
		if (ids.join() !== got.join()) throw new Error("the secrets changed meanwhile; try again");
		for (const s of secrets)
			db.query("UPDATE secrets SET meta = ?, value = ? WHERE id = ?").run(s.meta, s.value, s.id);
		db.query(
			"UPDATE vault SET salt = ?, iterations = ?, auth_hash = ?, changed_at = datetime('now') WHERE id = 1",
		).run(v.salt, v.iterations, sha256(v.auth));
	})();
}

/** Forgotten password: the only way back is starting over. */
export function resetVault(db: Db): number {
	return db.transaction(() => {
		const n = db.query("DELETE FROM secrets").run().changes;
		db.run("DELETE FROM vault");
		return n;
	})();
}

/** Kostas answers a decision: it goes back to the agent, to act on. A number picks that option (1-based). */
export function answerItem(db: Db, id: number, answer: string, author = "kostas") {
	const item = getItem(db, id);
	if (!item) throw new Error(`no item #${id}`);
	const options = itemOptions(item);
	let text = answer.trim();
	if (/^\d+$/.test(text) && !options.includes(text) && options[Number(text) - 1]) text = options[Number(text) - 1];
	if (!text) throw new Error("empty answer");
	updateItem(db, id, { answer: text, owner: "agent", status: item.status === "doing" ? "doing" : "todo" }, author);
}

// Backups: whole-database copies next to it, the newest `backups.keep` kept (Settings → Data; 14 unless changed).
// VACUUM INTO is safe while others write.
export const BACKUP_DIR = process.env.WB_BACKUPS ?? join(dirname(DB_PATH), "backups");
export const BACKUP_NAME = /^workbench-\d{4}-\d{2}-\d{2}-\d{6}\.db$/;

export function backup(db: Db, dir = BACKUP_DIR): string {
	mkdirSync(dir, { recursive: true });
	const stamp = new Date().toISOString().slice(0, 19).replace("T", "-").replaceAll(":", "");
	const file = join(dir, `workbench-${stamp}.db`);
	// Names go by the second: one made this very second is as current as a new one would be.
	if (existsSync(file)) return file;
	db.run(`VACUUM INTO '${file.replaceAll("'", "''")}'`);
	return file;
}

export function listBackups(dir = BACKUP_DIR): { file: string; at: Date; bytes: number }[] {
	let names: string[] = [];
	try {
		names = readdirSync(dir).filter((n) => BACKUP_NAME.test(n));
	} catch {
		return [];
	}
	return names
		.map((n) => {
			const st = statSync(join(dir, n));
			return { file: join(dir, n), at: st.mtime, bytes: st.size };
		})
		.sort((a, b) => b.at.getTime() - a.at.getTime());
}

/** How many backups to keep: the board's setting. */
export const backupsKeep = (db: Db) => getSetting<number>(db, "backups.keep");

/** Removes all but the newest `keep` (at least one stays). Callers pass backupsKeep(db). */
export function pruneBackups(keep: number, dir = BACKUP_DIR): number {
	const old = listBackups(dir).slice(Math.max(1, keep));
	for (const b of old) rmSync(b.file);
	return old.length;
}

/** A backup's file by its name only (never a path), or undefined when there's no such backup. */
export function backupFile(name: string, dir = BACKUP_DIR): string | undefined {
	if (!BACKUP_NAME.test(name)) return undefined;
	const file = join(dir, name);
	try {
		return statSync(file).isFile() ? file : undefined;
	} catch {
		return undefined;
	}
}

/* ---------- Settings → Data: size, compacting, tidying, export ---------- */

const fileSize = (f: string) => {
	try {
		return statSync(f).size;
	} catch {
		return 0;
	}
};

/** The database's size on disk, and the counts that explain it. */
export function dbStats(db: Db) {
	const one = (sql: string) => db.query(sql).get() as { n: number; bytes: number };
	return {
		path: DB_PATH,
		bytes: fileSize(DB_PATH),
		wal: fileSize(`${DB_PATH}-wal`),
		items: one("SELECT COUNT(*) AS n, COALESCE(SUM(length(title) + length(body)), 0) AS bytes FROM items"),
		notes: one("SELECT COUNT(*) AS n, COALESCE(SUM(length(text)), 0) AS bytes FROM notes"),
		reportVersions: one("SELECT COUNT(*) AS n, COALESCE(SUM(length(html) + length(text)), 0) AS bytes FROM report_versions"),
		trackerReadings: one("SELECT COUNT(*) AS n, COALESCE(SUM(length(reading)), 0) AS bytes FROM tracker_history"),
		images: one("SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes FROM images"),
		linkIcons: one("SELECT COUNT(icon) AS n, COALESCE(SUM(length(icon)), 0) AS bytes FROM links"),
	};
}

/**
 * Writes the WAL back into the database and rebuilds it without its free pages, so the file shrinks to what it
 * holds. VACUUM needs a moment when nobody else writes; when an agent or `wb` keeps it busy past the busy timeout,
 * it says so in words.
 */
export function compactDb(db: Db): { before: number; after: number } {
	const size = () => fileSize(DB_PATH) + fileSize(`${DB_PATH}-wal`);
	const before = size();
	try {
		db.run("PRAGMA wal_checkpoint(TRUNCATE)");
		db.run("VACUUM");
		// VACUUM writes the rebuilt pages through the WAL; this moves them into the file and empties the WAL.
		db.run("PRAGMA wal_checkpoint(TRUNCATE)");
	} catch (e) {
		if (/busy|locked/i.test((e as Error).message))
			throw new Error("the database is busy (an agent or wb is using it): try again in a moment");
		throw e;
	}
	return { before, after: size() };
}

export type TidyKeep = { backups: number; reportVersions: number; trackerHistory: number; closedItemsDays: number };
export type TidyCounts = { backups: number; reportVersions: number; trackerReadings: number; items: number; notes: number };

/** What Settings → Data → "Keeping things tidy" keeps now. */
export function tidyKeep(db: Db): TidyKeep {
	return {
		backups: backupsKeep(db),
		reportVersions: getSetting<number>(db, "keep.report-versions"),
		trackerHistory: getSetting<number>(db, "keep.tracker-history"),
		closedItemsDays: getSetting<number>(db, "keep.closed-items-days"),
	};
}

// Rows past the newest N of their report or tracker. N ≥ 1, so a report's latest version is never one of them.
const OLD_VERSIONS =
	"SELECT id FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY report_id ORDER BY n DESC) AS k FROM report_versions) WHERE k > $keep";
const OLD_READINGS =
	"SELECT id FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY tracker_id ORDER BY id DESC) AS k FROM tracker_history) WHERE k > $keep";
// Closed longer ago than N days. done_at is set when an item closes; updated_at stands in for a row without it.
const OLD_ITEMS =
	"SELECT id FROM items WHERE status IN ('done', 'dropped') AND COALESCE(done_at, updated_at) < datetime('now', '-' || $days || ' days')";

/** What tidying with `keep` would remove right now. Changes nothing. */
export function tidyCount(db: Db, keep: TidyKeep): TidyCounts {
	const count = (sql: string, p: Record<string, number>) =>
		(db.query(`SELECT COUNT(*) AS n FROM (${sql})`).get(p) as { n: number }).n;
	const days = keep.closedItemsDays;
	return {
		backups: Math.max(0, listBackups().length - Math.max(1, keep.backups)),
		reportVersions: keep.reportVersions ? count(OLD_VERSIONS, { keep: keep.reportVersions }) : 0,
		trackerReadings: count(OLD_READINGS, { keep: keep.trackerHistory }),
		items: days ? count(OLD_ITEMS, { days }) : 0,
		notes: days ? count(`SELECT id FROM notes WHERE item_id IN (${OLD_ITEMS})`, { days }) : 0,
	};
}

/** Removes what the board's settings say not to keep (see tidyCount), backups included. Returns what went. */
export function tidy(db: Db): TidyCounts {
	const keep = tidyKeep(db);
	const days = keep.closedItemsDays;
	const run = (sql: string, p: Record<string, number>) => db.query(sql).run(p).changes;
	const out = db.transaction(() => ({
		backups: 0,
		reportVersions: keep.reportVersions ? run(`DELETE FROM report_versions WHERE id IN (${OLD_VERSIONS})`, { keep: keep.reportVersions }) : 0,
		trackerReadings: run(`DELETE FROM tracker_history WHERE id IN (${OLD_READINGS})`, { keep: keep.trackerHistory }),
		// Notes first: counted here, rather than left to ON DELETE CASCADE.
		notes: days ? run(`DELETE FROM notes WHERE item_id IN (${OLD_ITEMS})`, { days }) : 0,
		items: days ? run(`DELETE FROM items WHERE id IN (${OLD_ITEMS})`, { days }) : 0,
	}))();
	out.backups = pruneBackups(keep.backups);
	return out;
}

export const EXPORT_FORMAT = 1;

/**
 * Everything on the board as plain JSON, to keep or to take elsewhere. Left out: the vault and its secrets
 * (ciphertext only your password opens), data sources' header values, and link icons (fetched again by themselves).
 */
export function exportAll(db: Db) {
	const all = (sql: string) => db.query(sql).all() as Record<string, unknown>[];
	const parse = (s: unknown) => {
		try {
			return typeof s === "string" ? JSON.parse(s) : s;
		} catch {
			return s;
		}
	};
	const byParent = (rows: Record<string, unknown>[], key: string) => {
		const m = new Map<unknown, Record<string, unknown>[]>();
		for (const { [key]: parent, ...rest } of rows) m.set(parent, [...(m.get(parent) ?? []), rest]);
		return m;
	};
	const notes = byParent(all("SELECT item_id, at, author, text FROM notes ORDER BY at, id"), "item_id");
	const images = byParent(
		all("SELECT item_id, caption, type, author, at, data FROM images ORDER BY id").map((m) => ({ ...m, data: Buffer.from(m.data as Uint8Array).toString("base64") })),
		"item_id",
	);
	const versions = byParent(all("SELECT report_id, n, at, author, html FROM report_versions ORDER BY report_id, n"), "report_id");
	const history = byParent(
		all("SELECT tracker_id, at, reading, author FROM tracker_history ORDER BY tracker_id, id").map((h) => ({ ...h, reading: parse(h.reading) })),
		"tracker_id",
	);
	return {
		format: EXPORT_FORMAT,
		exported_at: new Date().toISOString(),
		projects: all("SELECT * FROM projects ORDER BY sort, name"),
		items: all("SELECT * FROM items ORDER BY id").map((i) => ({ ...i, notes: notes.get(i.id) ?? [], images: images.get(i.id) ?? [] })),
		links: all("SELECT id, project, grp, label, url, icon_url, sort FROM links ORDER BY project, grp, sort, id"),
		reports: all("SELECT * FROM reports ORDER BY project, name").map((r) => ({ ...r, versions: versions.get(r.id) ?? [] })),
		report_state: all("SELECT project, name, json, updated_at FROM report_state ORDER BY project, name").map(({ json, ...r }) => ({
			...r,
			state: parse(json),
		})),
		trackers: all("SELECT * FROM trackers ORDER BY project, sort, name").map(({ running_since: _, rev: __, ...t }) => ({
			...t,
			options: parse(t.options),
			reading: parse(t.reading),
			history: history.get(t.id) ?? [],
		})),
		settings: getSettings(db),
		sources: all("SELECT project, name, base_url, write, header_names, created_at, updated_at FROM sources ORDER BY project, name").map(
			(s) => ({ ...s, write: !!s.write, header_names: String(s.header_names || "").split("\n").filter(Boolean) }),
		),
	};
}

/** A word for the shell, quoted when it needs to be. */
export const shellWord = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replaceAll("'", `'\\''`)}'`);

/**
 * The commands that put backup `file` in place of the database on this computer, step by step. The board can't
 * swap its own database while it runs, so a person runs these: stop the board, keep the current database next to
 * it, copy the backup over it, drop the old WAL, start the board again.
 */
export function restoreSteps(file: string, how: { systemd: boolean; pid: number; start: string }) {
	const stamp = new Date().toISOString().slice(0, 19).replace("T", "-").replaceAll(":", "");
	const keep = DB_PATH.replace(/(\.db)?$/, `-before-restore-${stamp}.db`);
	const steps = [
		how.systemd
			? { text: "Stop the board (it runs as the workbench user service):", cmd: "systemctl --user stop workbench" }
			: // Waits until it's gone, so the copies below don't race its last write.
				{ text: "Stop the board you started (Ctrl+C where it runs, or this):", cmd: `kill ${how.pid} && while kill -0 ${how.pid} 2>/dev/null; do sleep 0.2; done` },
		{
			text: "Keep a copy of the database as it is now, next to it:",
			cmd: `cp ${shellWord(DB_PATH)} ${shellWord(keep)} && { [ ! -f ${shellWord(`${DB_PATH}-wal`)} ] || cp ${shellWord(`${DB_PATH}-wal`)} ${shellWord(`${keep}-wal`)}; }`,
		},
		{ text: "Copy the backup over the database:", cmd: `cp ${shellWord(file)} ${shellWord(DB_PATH)}` },
		{ text: "Remove the old database's WAL files, so they aren't replayed into the backup:", cmd: `rm -f ${shellWord(`${DB_PATH}-wal`)} ${shellWord(`${DB_PATH}-shm`)}` },
		how.systemd
			? { text: "Start the board again:", cmd: "systemctl --user start workbench" }
			: { text: "Start the board again, the way it was started:", cmd: how.start },
	];
	return { db: DB_PATH, backup: file, keep, steps, all: steps.map((s) => s.cmd).join("\n") };
}
