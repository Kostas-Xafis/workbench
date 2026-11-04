import { projects, type Db, type Item, type Project } from "./db";
import { githubWeb } from "./git";

/** A work day runs from this hour to the same hour next morning, so late nights count as the day they belong to. */
export const DAY_START_HOUR = 5;

type DayNote = { at: string; author: string; text: string };
type DayItem = Pick<Item, "ref" | "title" | "kind" | "owner" | "priority" | "branch"> & {
	/** Status when the day ended. */
	status: Item["status"];
	statusNow: Item["status"];
	created: boolean;
	notes: DayNote[];
};
type DayCommit = { hash: string; short: string; at: string; author: string; subject: string; branch: string; url: string };
type DayReport = { id: number; title: string; n: number; at: string };
type DayProject = { slug: string; name: string; items: DayItem[]; commits: DayCommit[]; reports: DayReport[]; error?: string };
export type DayData = { day: string; from: string; to: string; generated: string; projects: DayProject[] };

const sqlTime = (d: Date) => d.toISOString().slice(0, 19).replace("T", " ");
const isoFromSql = (s: string) => `${s.replace(" ", "T")}Z`;
const localDate = (d: Date) =>
	`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** The work day that `now` falls in: before DAY_START_HOUR it is still yesterday. */
export function currentDay(now = new Date()) {
	return localDate(new Date(now.getTime() - DAY_START_HOUR * 3600_000));
}

export function dayWindow(day: string) {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error(`"${day}" is not a date (YYYY-MM-DD)`);
	const [y, m, d] = day.split("-").map(Number);
	const from = new Date(y, m - 1, d, DAY_START_HOUR);
	const to = new Date(y, m - 1, d + 1, DAY_START_HOUR);
	if (Number.isNaN(from.getTime()) || localDate(from) !== day) throw new Error(`no such date ${day}`);
	return { from, to };
}

const STATUS_CHANGE = /(?:^| · )status: (\w+) → (\w+)/;

async function commits(p: Project, from: Date, to: Date): Promise<DayCommit[]> {
	const run = async (...args: string[]) => {
		const proc = Bun.spawn(["git", ...args], { cwd: p.path, stdout: "pipe", stderr: "pipe" });
		const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
		if (code !== 0) throw new Error((await new Response(proc.stderr).text()).trim() || `git ${args[0]} failed`);
		return out;
	};
	let web = "";
	try {
		web = githubWeb(await run("remote", "get-url", "origin"));
	} catch {}
	const log = await run(
		"log",
		"--all",
		"--source",
		`--since=${from.toISOString()}`,
		"--format=%H%x1f%h%x1f%aI%x1f%an%x1f%S%x1f%s%x1e",
	);
	// Dated by author time: a rebase moves the commit date of older work into the day.
	const out: DayCommit[] = [];
	for (const rec of log.split("\x1e")) {
		const [hash, short, at, author, source, subject] = rec.trim().split("\x1f");
		if (!hash) continue;
		const t = new Date(at);
		if (t < from || t >= to) continue;
		const branch = source.replace(/^refs\/(heads|remotes)\//, "");
		out.push({ hash, short, at: t.toISOString(), author, subject, branch, url: web && `${web}/commit/${hash}` });
	}
	return out.sort((a, b) => a.at.localeCompare(b.at));
}

/** Everything that moved in the work day: items added, started, noted, waiting, finished or dropped, commits, reports. */
export async function dayData(db: Db, day: string, only?: string): Promise<DayData> {
	const { from, to } = dayWindow(day);
	const range = { $from: sqlTime(from), $to: sqlTime(to) };
	const touched = db
		.query(
			`SELECT DISTINCT i.* FROM items i JOIN notes n ON n.item_id = i.id
			 WHERE n.at >= $from AND n.at < $to ${only ? "AND i.project = $project" : ""}`,
		)
		.all(only ? { ...range, $project: only } : range) as Item[];
	const notesOf = db.query("SELECT at, author, text FROM notes WHERE item_id = ? AND at < ? ORDER BY at, id");
	const items = new Map<string, DayItem[]>();
	for (const i of touched) {
		const all = notesOf.all(i.id, range.$to) as DayNote[];
		let status = i.status;
		const changes = all.map((n) => n.text.match(STATUS_CHANGE)).filter(Boolean);
		if (changes.length) status = changes.at(-1)![2] as Item["status"];
		else if (all.length) {
			const later = db.query("SELECT text FROM notes WHERE item_id = ? AND at >= ? ORDER BY at, id").all(i.id, range.$to) as DayNote[];
			const first = later.map((n) => n.text.match(STATUS_CHANGE)).find(Boolean);
			if (first) status = first[1] as Item["status"];
		}
		const today = all.filter((n) => n.at >= range.$from).map((n) => ({ ...n, at: isoFromSql(n.at) }));
		const list = items.get(i.project) ?? [];
		list.push({
			ref: i.ref,
			title: i.title,
			kind: i.kind,
			owner: i.owner,
			priority: i.priority,
			branch: i.branch,
			status,
			statusNow: i.status,
			created: today.some((n) => n.text === "created"),
			notes: today,
		});
		items.set(i.project, list);
	}
	const reports = db
		.query(
			`SELECT r.id, r.project, r.title, v.n, v.at FROM report_versions v JOIN reports r ON r.id = v.report_id
			 WHERE v.at >= $from AND v.at < $to AND r.name NOT LIKE 'day-%' ORDER BY v.at`,
		)
		.all(range) as (DayReport & { project: string })[];

	const out: DayProject[] = [];
	for (const p of projects(db)) {
		if (only && p.slug !== only) continue;
		let list: DayCommit[] = [];
		let error: string | undefined;
		if (p.path)
			try {
				list = await commits(p, from, to);
			} catch (e) {
				error = (e as Error).message;
			}
		const dp: DayProject = {
			slug: p.slug,
			name: p.name,
			items: (items.get(p.slug) ?? []).sort((a, b) => a.notes[0].at.localeCompare(b.notes[0].at)),
			commits: list,
			reports: reports
				.filter((r) => r.project === p.slug)
				.map(({ id, title, n, at }) => ({ id, title, n, at: isoFromSql(at) })),
			...(error ? { error } : {}),
		};
		if (dp.items.length || dp.commits.length || dp.reports.length || error) out.push(dp);
	}
	return { day, from: from.toISOString(), to: to.toISOString(), generated: new Date().toISOString(), projects: out };
}

export function dayTitle(day: string) {
	const { from } = dayWindow(day);
	return `Day · ${from.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric" })}`;
}

export function dayPage(data: DayData) {
	const json = JSON.stringify(data).replace(/</g, "\\u003c");
	return PAGE.replace("__TITLE__", dayTitle(data.day)).replace("__DATA__", json);
}

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>__TITLE__</title>
<style>
body { margin: 0; background: var(--wb-bg, #f6f5f2); color: var(--wb-ink, #1d1c1a); font: 14px/1.5 var(--wb-font, system-ui, sans-serif); }
.page { max-width: 1000px; margin: 0 auto; padding: 24px 16px 56px; }
h1 { font-size: 22px; margin: 0; }
.sub { color: var(--wb-muted, #6f6b64); margin: 2px 0 18px; font-size: 13px; }
h2 { font-size: 17px; margin: 30px 0 4px; }
h3 { font-size: 11.5px; text-transform: uppercase; letter-spacing: .6px; color: var(--wb-muted, #6f6b64); margin: 18px 0 8px; font-weight: 600; }
.pick { display: flex; flex-wrap: wrap; gap: 6px; margin: 0 0 14px; }
.pick button { font: inherit; font-size: 13px; background: var(--wb-card, #fff); color: var(--wb-ink, #1d1c1a); border: 1px solid var(--wb-line, #e3e0da); border-radius: 999px; padding: 4px 12px; cursor: pointer; }
.pick button:hover { background: var(--wb-hover, #efede8); }
.pick button[aria-pressed="true"] { border-color: var(--wb-accent, #3d5afe); color: var(--wb-accent, #3d5afe); font-weight: 600; }
.pick button span { color: var(--wb-muted, #6f6b64); font-weight: 400; margin-left: 4px; font-variant-numeric: tabular-nums; }
.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(100px, 1fr)); gap: 10px; }
.tile { background: var(--wb-card, #fff); border: 1px solid var(--wb-line, #e3e0da); border-radius: 12px; padding: 10px 14px; }
.tile b { display: block; font-size: 26px; line-height: 1.15; font-variant-numeric: tabular-nums; }
.tile span { color: var(--wb-muted, #6f6b64); font-size: 12.5px; }
.tabs { display: flex; gap: 4px; margin: 22px 0 0; border-bottom: 1px solid var(--wb-line, #e3e0da); }
.tabs button { font: inherit; background: none; border: 0; border-bottom: 2px solid transparent; padding: 6px 12px; color: var(--wb-muted, #6f6b64); cursor: pointer; margin-bottom: -1px; }
.tabs button[aria-selected="true"] { color: var(--wb-ink, #1d1c1a); border-bottom-color: var(--wb-accent, #3d5afe); font-weight: 600; }
.panel { background: var(--wb-card, #fff); border: 1px solid var(--wb-line, #e3e0da); border-radius: 12px; overflow: hidden; }
.item { border-top: 1px solid var(--wb-line, #e3e0da); }
.item:first-child { border-top: 0; }
.item > summary { list-style: none; cursor: pointer; padding: 9px 14px; display: grid; grid-template-columns: auto 1fr auto; gap: 4px 10px; align-items: baseline; }
.item > summary::-webkit-details-marker { display: none; }
.item > summary:hover { background: var(--wb-hover, #efede8); }
.item[open] > summary { background: var(--wb-hover, #efede8); }
.title { min-width: 0; }
.events { grid-column: 2 / 4; display: flex; flex-wrap: wrap; gap: 4px; }
.ref { font: 600 11.5px var(--wb-mono, monospace); background: var(--wb-hover, #efede8); color: var(--wb-muted, #6f6b64); border: 0; border-radius: 5px; padding: 1px 5px; cursor: pointer; white-space: nowrap; }
.ref:hover { color: var(--wb-accent, #3d5afe); }
.chip { font-size: 11px; border-radius: 999px; padding: 0 7px; border: 1px solid var(--wb-line, #e3e0da); color: var(--wb-muted, #6f6b64); white-space: nowrap; }
.chip.done { color: var(--wb-good, #15803d); border-color: currentColor; }
.chip.doing { color: var(--wb-accent, #3d5afe); border-color: currentColor; }
.chip.waiting { color: var(--wb-warn, #b45309); border-color: currentColor; }
.chip.dropped { color: var(--wb-muted, #6f6b64); text-decoration: line-through; }
.chip.kostas { color: var(--wb-bad, #dc2626); border-color: currentColor; }
.kind { font-size: 11px; color: var(--wb-muted, #6f6b64); text-transform: uppercase; letter-spacing: .4px; margin-right: 6px; }
.right { display: flex; gap: 6px; align-items: baseline; }
.time { font: 12px var(--wb-mono, monospace); color: var(--wb-muted, #6f6b64); white-space: nowrap; font-variant-numeric: tabular-nums; }
ol.notes { list-style: none; margin: 0; padding: 4px 14px 12px 14px; }
ol.notes li { display: grid; grid-template-columns: 46px 1fr; gap: 10px; padding: 5px 0; border-top: 1px dashed var(--wb-line, #e3e0da); }
ol.notes li:first-child { border-top: 0; }
.text { white-space: pre-wrap; overflow-wrap: anywhere; }
.text.meta { color: var(--wb-muted, #6f6b64); font-size: 12.5px; }
.who { font-size: 11px; color: var(--wb-muted, #6f6b64); margin-right: 6px; }
.who.kostas { color: var(--wb-bad, #dc2626); }
ul.rows { list-style: none; margin: 0; padding: 0; }
ul.rows li { display: grid; grid-template-columns: 46px auto 1fr; gap: 10px; padding: 7px 14px; border-top: 1px solid var(--wb-line, #e3e0da); align-items: baseline; }
ul.rows li:first-child { border-top: 0; }
a { color: var(--wb-accent, #3d5afe); text-decoration: none; }
a:hover { text-decoration: underline; }
code { font: 12px var(--wb-mono, monospace); }
.hour { padding: 6px 14px; font: 600 11.5px var(--wb-mono, monospace); color: var(--wb-muted, #6f6b64); background: var(--wb-hover, #efede8); border-top: 1px solid var(--wb-line, #e3e0da); }
.hour:first-child { border-top: 0; }
.tl { display: grid; grid-template-columns: 46px 110px 1fr; gap: 10px; padding: 6px 14px; border-top: 1px solid var(--wb-line, #e3e0da); align-items: baseline; }
.tl .what { min-width: 0; }
.proj { font-size: 12px; color: var(--wb-muted, #6f6b64); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.empty { color: var(--wb-muted, #6f6b64); padding: 12px 14px; }
.err { color: var(--wb-bad, #dc2626); font-size: 13px; }
@media (max-width: 640px) {
	.tl { grid-template-columns: 46px 1fr; }
	.tl .proj { grid-column: 2; }
	.tl .what { grid-column: 1 / 3; }
	ul.rows li { grid-template-columns: 46px 1fr; }
	ul.rows li > :nth-child(3) { grid-column: 1 / 3; }
}
</style>
</head>
<body>
<div class="page">
	<h1 id="title"></h1>
	<p class="sub" id="sub"></p>
	<div class="pick" id="pick" role="group" aria-label="Project"></div>
	<div class="tiles" id="tiles"></div>
	<div class="tabs" role="tablist">
		<button role="tab" data-tab="projects" aria-selected="true">By project</button>
		<button role="tab" data-tab="timeline" aria-selected="false">Timeline</button>
	</div>
	<div id="body"></div>
</div>
<script>
const D = __DATA__;
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const hm = (iso) => new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
const from = new Date(D.from), to = new Date(D.to);
const STATUS = /(?:^| · )status: (\\w+) → (\\w+)/;
const LABEL = { doing: "started", waiting: "waiting", done: "done", dropped: "dropped", todo: "back to to-do" };
const GROUPS = [["done", "Finished"], ["doing", "In progress"], ["waiting", "Waiting"], ["todo", "Open"], ["dropped", "Dropped"]];

function events(it) {
	const out = [];
	for (const n of it.notes) {
		const m = n.text.match(STATUS);
		if (n.text === "created") out.push(["added", ""]);
		else if (m) out.push([LABEL[m[2]] || m[2], m[2]]);
		else if (/^answer: /.test(n.text) || / · answer: /.test(n.text)) out.push(["answered", ""]);
	}
	const plain = it.notes.filter((n) => isPlain(n.text)).length;
	if (plain) out.push([plain + (plain > 1 ? " notes" : " note"), ""]);
	return out;
}
const pretty = (t) => t.replace(/session: [^·]*?→ (local_\\S+|—)/g, (_, s) => s === "—" ? "session cleared" : "session linked");
const isPlain = (t) => t !== "created" && !/^(\\w+: .* → .*|body edited|options: .*)( · .*)?$/.test(t);
const refBtn = (ref) => \`<button class="ref" data-ref="\${ref}" title="Open on the board">wb-\${ref}</button>\`;
const who = (a) => a ? \`<span class="who \${a === "kostas" ? "kostas" : ""}">\${esc(a)}</span>\` : "";

function itemRow(it) {
	const ev = events(it).map(([t, cls]) => \`<span class="chip \${cls}">\${esc(t)}</span>\`).join("");
	const owner = it.owner === "kostas" && it.status !== "done" && it.status !== "dropped" ? '<span class="chip kostas">needs Kostas</span>' : "";
	const notes = it.notes.map((n) => \`<li><span class="time">\${hm(n.at)}</span><span class="text \${isPlain(n.text) ? "" : "meta"}">\${who(n.author)}\${esc(pretty(n.text))}</span></li>\`).join("");
	const span = it.notes.length > 1 ? \`\${hm(it.notes[0].at)}–\${hm(it.notes.at(-1).at)}\` : hm(it.notes[0].at);
	return \`<details class="item"><summary>\${refBtn(it.ref)}<span class="title"><span class="kind">\${esc(it.kind)}</span>\${esc(it.title)}</span>
		<span class="right">\${owner}<span class="time">\${span}</span></span><span class="events">\${ev}</span></summary><ol class="notes">\${notes}</ol></details>\`;
}

function commitRow(c) {
	const hash = c.url ? \`<a href="\${esc(c.url)}" target="_blank" rel="noopener"><code>\${esc(c.short)}</code></a>\` : \`<code>\${esc(c.short)}</code>\`;
	const branch = c.branch && !/^(origin\\/)?(master|main|HEAD)$/.test(c.branch) ? \` <span class="chip">\${esc(c.branch)}</span>\` : "";
	return \`<li><span class="time">\${hm(c.at)}</span>\${hash}<span>\${esc(c.subject)}\${branch}</span></li>\`;
}

let project = "*", tab = "projects";
const shown = () => D.projects.filter((p) => project === "*" || p.slug === project);
const activity = (ps) => ps.reduce((n, p) => n + p.items.length, 0);
function count(fn) { return shown().reduce((n, p) => n + fn(p), 0); }

function pick() {
	const el = document.getElementById("pick");
	if (D.projects.length < 2) return el.remove();
	const btn = (slug, name, n) => \`<button data-project="\${slug}" aria-pressed="\${project === slug}">\${esc(name)}<span>\${n}</span></button>\`;
	el.innerHTML = btn("*", "All projects", activity(D.projects)) + D.projects.map((p) => btn(p.slug, p.name, activity([p]))).join("");
}

function tiles() {
	const all = shown().flatMap((p) => p.items);
	const t = [
		[all.length, "items touched"],
		[all.filter((i) => i.status === "done").length, "finished"],
		[all.filter((i) => i.notes.some((n) => (n.text.match(STATUS) || [])[2] === "doing")).length, "started"],
		[all.filter((i) => i.created).length, "added"],
		[all.reduce((n, i) => n + i.notes.length, 0), "history entries"],
		[count((p) => p.commits.length), "commits"],
		[count((p) => p.reports.length), "report versions"],
	];
	document.getElementById("tiles").innerHTML = t.map(([v, l]) => \`<div class="tile"><b>\${v}</b><span>\${l}</span></div>\`).join("");
}

function byProject() {
	if (!D.projects.length) return '<p class="empty">Nothing was recorded on this day.</p>';
	return shown().map((p) => {
		let h = project === "*" ? \`<h2>\${esc(p.name)}</h2>\` : "";
		if (p.error) h += \`<p class="err">git: \${esc(p.error)}</p>\`;
		for (const [status, label] of GROUPS) {
			const list = p.items.filter((i) => i.status === status);
			if (list.length) h += \`<h3>\${label} · \${list.length}</h3><div class="panel">\${list.map(itemRow).join("")}</div>\`;
		}
		if (p.commits.length) h += \`<h3>Commits · \${p.commits.length}</h3><div class="panel"><ul class="rows">\${p.commits.map(commitRow).join("")}</ul></div>\`;
		if (p.reports.length) h += \`<h3>Reports · \${p.reports.length}</h3><div class="panel"><ul class="rows">\${p.reports.map((r) =>
			\`<li><span class="time">\${hm(r.at)}</span><span class="chip">v\${r.n}</span><span>\${esc(r.title)}</span></li>\`).join("")}</ul></div>\`;
		return h;
	}).join("");
}

function timeline() {
	const rows = [];
	for (const p of shown()) {
		for (const it of p.items) for (const n of it.notes) rows.push({ at: n.at, p, html: \`\${refBtn(it.ref)} <span class="text \${isPlain(n.text) ? "" : "meta"}">\${who(n.author)}\${esc(pretty(n.text))}</span> <span class="proj">· \${esc(it.title)}</span>\` });
		for (const c of p.commits) rows.push({ at: c.at, p, html: \`<span class="chip">commit</span> <code>\${esc(c.short)}</code> \${esc(c.subject)}\` });
		for (const r of p.reports) rows.push({ at: r.at, p, html: \`<span class="chip">report v\${r.n}</span> \${esc(r.title)}\` });
	}
	if (!rows.length) return '<p class="empty">Nothing was recorded on this day.</p>';
	rows.sort((a, b) => a.at.localeCompare(b.at));
	let h = "", hour = "";
	for (const r of rows) {
		const hh = hm(r.at).slice(0, 2);
		if (hh !== hour) { hour = hh; h += \`<div class="hour">\${hh}:00</div>\`; }
		h += \`<div class="tl"><span class="time">\${hm(r.at)}</span><span class="proj">\${esc(r.p.name)}</span><span class="what">\${r.html}</span></div>\`;
	}
	return \`<div class="panel" style="margin-top:16px">\${h}</div>\`;
}

function show() {
	pick();
	tiles();
	document.querySelectorAll(".tabs button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === tab)));
	document.getElementById("body").innerHTML = tab === "timeline" ? timeline() : byProject();
}

const day = from.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
document.getElementById("title").textContent = day;
const stamps = D.projects.flatMap((p) => [...p.items.flatMap((i) => i.notes.map((n) => n.at)), ...p.commits.map((c) => c.at)]).sort();
const last = stamps.length ? \` · last activity \${hm(stamps.at(-1))}\` : "";
const partial = new Date(D.generated) < to ? \` · generated \${new Date(D.generated).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}, the day was not over yet\` : "";
document.getElementById("sub").textContent =
	\`Work day \${from.toLocaleDateString("en-GB", { weekday: "short" })} \${hm(D.from)} → \${to.toLocaleDateString("en-GB", { weekday: "short" })} \${hm(D.to)}\${last}\${partial}. Everything that moved, not only what finished.\`;
show();
document.querySelector(".tabs").addEventListener("click", (e) => { const b = e.target.closest("button[data-tab]"); if (b) { tab = b.dataset.tab; show(); } });
document.getElementById("pick")?.addEventListener("click", (e) => { const b = e.target.closest("button[data-project]"); if (b) { project = b.dataset.project; show(); } });
document.addEventListener("click", (e) => {
	const b = e.target.closest(".ref");
	if (!b) return;
	e.preventDefault();
	window.wb?.open("wb-" + b.dataset.ref).catch(() => {});
});
</script>
</body>
</html>
`;
