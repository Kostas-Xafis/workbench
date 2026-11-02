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

/** Projects with the number of open items waiting on Kostas, for the sidebar. */
export function projectsWithCounts(db: Db): (Project & { mine: number })[] {
	return db
		.query(
			`SELECT p.*, (SELECT COUNT(*) FROM items i WHERE i.project = p.slug AND i.owner = 'kostas'
				AND i.status IN ('todo', 'doing', 'waiting')) AS mine FROM projects p ORDER BY name`,
		)
		.all() as (Project & { mine: number })[];
}

export function upsertProject(db: Db, p: Omit<Project, "icon">) {
	db.query(
		"INSERT INTO projects (slug, name, path) VALUES ($slug, $name, $path) ON CONFLICT(slug) DO UPDATE SET name = $name, path = $path",
	).run(p);
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
	const row = Object.fromEntries([...fields.map((k) => [k, item[k]]), ["ref", newRef(db)]]);
	const { id } = db
		.query(
			`INSERT INTO items (${[...fields, "ref"].join(", ")}) VALUES (${[...fields, "ref"].map((k) => "$" + k).join(", ")}) RETURNING id`,
		)
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
	if (!db.query("DELETE FROM reports WHERE id = ?").run(id).changes) throw new Error(`no report #${id}`);
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
