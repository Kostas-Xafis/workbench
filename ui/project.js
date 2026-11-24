/* ---------- Projects: one page per project, where Kostas plans its work (docs/board.md, "Projects") ---------- */

// #project/<slug> (and #project/<slug>/goal/<id>, its Work filtered to a goal). A header (logo, name, the repository
// in one line, how many asks wait in the Inbox, the active goal, the project's trackers), then four tabs:
// - Work: a box to write the next piece of work (Enter files it as an agent's task, Ctrl+Enter files it and starts an
//   agent), In progress, Next up in the order Kostas sets (drag, or Alt+↑/↓; PUT /api/projects/:slug/order), Waiting
//   with why and on what, and Ideas, folded. Kostas's own asks are the Inbox's: one line says how many.
// - Pages: the project's reports, links and data sources, drawn with pages.js's renderers and dialogs.
// - Rulings: rulings.js's list for this project (wireRulings, renderRulings).
// - Done: what agents finished lately, with the finishing note's first line (GET /api/today).
// It reads what the board already loads (state.items for state.project, which it sets with useProject; the repos,
// trackers, reports, links, goals and runs), and draws again whenever that changes (hooks.redraw, at the end).

const projectView = document.createElement("section");
projectView.id = "project-view";
projectView.hidden = true;
projectView.setAttribute("aria-label", "Project");
$("#content").append(projectView);
// Made once and kept, so each pane keeps its listeners and what's typed in it; projectDraw() fills them.
projectView.innerHTML = `<div class="pj" id="pj">
	<header class="pj-head" id="pj-head"></header>
	<div class="pj-tabs" role="tablist" id="pj-tabs"></div>
	${[["work"], ["pages"], ["rulings"], ["done"]].map(([k]) => `<section class="pj-pane" id="pj-pane-${k}" role="tabpanel" aria-labelledby="pj-tab-${k}" data-pane="${k}" hidden></section>`).join("")}</div>
	<div id="pj-missing" hidden></div>`;

const PJ_TABS = [["work", "Work"], ["pages", "Pages"], ["rulings", "Rulings"], ["done", "Done"]];
const PJ_KINDS = [["task", "Task"], ["bug", "Bug"], ["idea", "Idea"]];
const PJ_DONE_STEP = 20;
const pv = {
	slug: "", goal: null, tab: localGet("project.tab") || "work", kind: "task", sel: null,
	// While a drag or a save of the order is under way: the ids of Next up as shown, so a poll doesn't put them back.
	order: null, dragging: false,
	// Waiting items' why and blockers, from their full item: id → { at: updated_at, why, on: [{ ref, title }], since }.
	waits: new Map(),
	done: null, doneFor: "", doneShown: PJ_DONE_STEP,
	rulings: { slug: "", focus: 0, q: "", retired: false, editing: 0, adding: false, embedded: true },
};
if (!PJ_TABS.some(([k]) => k === pv.tab)) pv.tab = "work";

defineView({
	name: "project",
	el: projectView,
	match(h) {
		const m = h.match(/^#project\/([^/]+)(?:\/goal\/(\d+))?$/);
		return m ? { slug: decodeURIComponent(m[1]), goal: m[2] ? Number(m[2]) : null } : null;
	},
	show(p) {
		if (pv.slug !== p.slug) { pv.sel = null; pv.order = null; pv.waits.clear(); pv.done = null; pv.doneShown = PJ_DONE_STEP; }
		pv.slug = p.slug;
		pv.goal = p.goal;
		pv.rulings.slug = p.slug;
		useProject(p.slug);
		projectDraw();
		if (typeof runsLoad === "function") runsLoad().then(projectDraw);
		if (pv.tab === "done") loadProjectDone();
	},
	title: (p) => projectName(p.slug),
	nav: (p) => `project:${p.slug}`,
});

const pjHref = (goal = null) => `#project/${encodeURIComponent(pv.slug)}${goal ? `/goal/${goal}` : ""}`;
const pjProject = () => state.projects.find((p) => p.slug === pv.slug);
const pjItems = () => state.items.filter((i) => i.project === pv.slug);
// The goal Work is filtered to, while it's one of this project's open goals.
const pjGoal = () => (pv.goal && goals.find((g) => g.id === pv.goal && g.project === pv.slug && g.status === "open")) || null;
const pjActiveGoal = () => {
	const open = goals.filter((g) => g.project === pv.slug && g.status === "open");
	return open.find((g) => g.is_active) ?? open[0] ?? null;
};

/* ---------- The header ---------- */

function pjRepoLine() {
	const r = state.repos.find((x) => x.project === pv.slug);
	if (!r) return "";
	if (!r.ok) return `<span title="${esc(r.error)}">no repository</span>`;
	const detail = [
		r.lastCommit ? `Last commit: ${r.lastCommit}` : "",
		r.dirty.length ? "Uncommitted:\n" + r.dirty.slice(0, 20).join("\n") : "",
		r.unmerged.length ? "Unmerged:\n" + r.unmerged.map((b) => `${b.name}  (${b.date})`).join("\n") : "",
		r.worktrees.length ? "Worktrees:\n" + r.worktrees.map((w) => `${w.branch}  ${w.path}`).join("\n") : "",
	].filter(Boolean).join("\n\n");
	const warns = [
		r.dirty.length && `${r.dirty.length} uncommitted`,
		r.ahead && `${r.ahead} unpushed`,
		r.behind && `${r.behind} behind`,
		r.unmerged.length && `${r.unmerged.length} unmerged branch${r.unmerged.length > 1 ? "es" : ""}`,
		r.worktrees.length && `${r.worktrees.length} worktree${r.worktrees.length > 1 ? "s" : ""}`,
	].filter(Boolean);
	return `<span class="pj-git" title="${esc(detail)}">⎇ ${esc(r.branch || "detached")}${warns.length ? warns.map((w) => ` · ${esc(w)}`).join("") : " · clean"}</span>`;
}

function pjGoalHtml() {
	const g = pjActiveGoal();
	if (!g) return `<button type="button" class="ghost sm pj-goal-add" data-goal-add title="Say what this project's work is for: agents pick its items first">${glyph("goal")}Add a goal</button>`;
	const n = goalNumbers(g);
	const due = goalDue(g.due);
	const on = pv.goal === g.id;
	const pct = n.total ? Math.round((n.done / n.total) * 100) : 0;
	return `<div class="pj-goal${on ? " on" : ""}">
		<button type="button" class="pj-goal-main" data-goal-filter="${g.id}" aria-pressed="${on}" title="${on ? "Show all the work again" : "Show only this goal's work"}">
			<span class="pj-goal-t">${glyph("goal")}<b>${esc(g.title)}</b></span>
			<span class="pj-bar" aria-hidden="true"><i style="width:${pct}%"></i></span>
			<span class="pj-goal-m">${n.total ? `${n.done} of ${n.total} done` : "nothing on it yet"}${due.text ? ` · <span class="${due.cls === "late" ? "pj-late" : ""}">${esc(due.text)}</span>` : ""}</span>
		</button>
		<button type="button" class="icon-btn" data-goal-edit="${g.id}" title="Edit this goal" aria-label="Edit ${esc(g.title)}">${goalIc("edit")}</button></div>`;
}

// One meter per tracker: the one that warns most (or the fullest), the rest in its tooltip. A click opens it.
function pjMeters() {
	const list = state.trackers.filter((t) => t.project === pv.slug);
	const lv = { bad: 2, warn: 1 };
	const meters = list.map((t) => {
		const ms = t.reading?.meters ?? [];
		const m = [...ms].sort((a, b) => (lv[b.level] ?? 0) - (lv[a.level] ?? 0) || (pctOf(b) ?? -1) - (pctOf(a) ?? -1))[0];
		const level = t.error ? "bad" : m?.level ?? "";
		const p = m ? pctOf(m) : null;
		const value = !m ? (t.error ? "failed" : "no reading") : m.value == null ? esc(m.text ?? "") : `${esc(withUnit(m.value, m.unit))}${m.max != null ? `/${esc(withUnit(m.max, m.unit))}` : ""}`;
		const name = ms.length > 1 && m?.label ? `${t.title} · ${m.label}` : t.title;
		return `<button type="button" class="pj-meter${level ? ` lv-${level}` : ""}${t.stale ? " stale" : ""}" data-tracker="${t.id}" title="${esc(trkTip(t))}">
			<span class="pj-meter-t"><span>${esc(name)}</span><b>${value}</b></span>${p == null ? "" : `<span class="pj-bar"><i style="width:${p}%"></i></span>`}</button>`;
	}).join("");
	return `<div class="pj-meters">${meters}<button type="button" class="icon-btn" data-tracker-new title="Add a status tracker" aria-label="Add a status tracker">${TRK_ADD}</button></div>`;
}

function pjHeader() {
	const p = pjProject();
	const inbox = p?.mine ?? 0;
	const line = [pjRepoLine(), inbox ? `<a href="#inbox/${encodeURIComponent(pv.slug)}">${inbox} in your inbox</a>` : ""].filter(Boolean).join(" · ");
	return `<div class="pj-id">${logo(p)}<div class="pj-name"><h1>${esc(p.name)}</h1>${line ? `<div class="pj-line">${line}</div>` : ""}</div></div>
		<div class="pj-side">${pjGoalHtml()}${pjMeters()}</div>`;
}

/* ---------- The tabs ---------- */

function pjCounts() {
	const items = pjItems();
	return {
		pages: state.reports.filter((r) => r.project === pv.slug && !r.archived).length,
		rulings: liveRulings(pv.slug).length,
		done: pv.doneFor === pv.slug && pv.done ? pv.done.length : items.filter((i) => i.status === "done" && i.owner !== "kostas").length,
	};
}
function pjTabs() {
	const n = pjCounts();
	return PJ_TABS.map(([k, label]) => `<button type="button" role="tab" id="pj-tab-${k}" data-tab="${k}" aria-selected="${pv.tab === k}" aria-controls="pj-pane-${k}" tabindex="${pv.tab === k ? 0 : -1}">${label}${n[k] ? ` <span class="pj-n">${n[k]}</span>` : ""}</button>`).join("");
}

/* ---------- Work ---------- */

// What Ctrl+Enter does with a new item of this kind: start an agent, or (why not) only file it.
function pjRunWhy(kind = pv.kind) {
	if (kind === "idea") return "An idea isn't started: make it a task first.";
	if (typeof sendWhy !== "function") return "This board doesn't start agents.";
	return sendWhy({ id: -1, project: pv.slug, owner: "agent", status: "todo", kind });
}
function pjComposeHint() {
	const why = pjRunWhy();
	return `<kbd>Enter</kbd> files it · ${why ? `<kbd>Ctrl Enter</kbd> files it, no agent: ${esc(why)}` : `<kbd>Ctrl Enter</kbd> files it and starts an agent`}`;
}
function pjComposer() {
	return `<form class="pj-compose" id="pj-compose" autocomplete="off">
		<textarea id="pj-new" rows="1" maxlength="4000" placeholder="Write what needs doing…" aria-label="Write what needs doing"></textarea>
		<div class="pj-compose-bar">
			<div class="pj-kinds" role="radiogroup" aria-label="Kind">${PJ_KINDS.map(([k, l]) => `<button type="button" role="radio" data-kind="${k}" aria-checked="${pv.kind === k}">${kindGlyph(k)}${l}</button>`).join("")}</div>
			<span class="pj-hint" id="pj-hint">${pjComposeHint()}</span>
			<button type="button" class="ghost sm" id="pj-full" title="The full form: details, pictures, who acts, priority">More…</button>
			<button type="submit" class="primary sm pj-send">File it</button>
		</div></form>`;
}

const pjAge = (t) => (t ? esc(ago(t, { short: true })) : "");
const pjLive = (i) => (i.alive ? `<span class="pj-live" title="An agent is on it now"></span>` : "");
function pjRunState(i) {
	const r = typeof runActive === "function" ? runActive(i.id) : null;
	return r ? chip(`agent running · ${took(r.started_at)}`, "running") : "";
}
function pjRunBtn(i) {
	if (typeof canSend !== "function" || !runs.info?.on || runActive(i.id)) return "";
	if (!canSend(i)) return "";
	return `<button type="button" class="ghost sm pj-run" data-run="${i.id}" title="Start Claude Code on it in ${esc(runFolder(i))}">${glyph("play")}Run</button>`;
}
const pjMeta = (i, extra = []) => [rowMeta(i, { project: false }), ...extra].filter(Boolean).join(" · ");

// Why a waiting item waits: its newest note that says something (not "Waits on …", not a field change).
function pjWaitWhy(notes) {
	for (const n of [...notes].reverse()) {
		const line = n.text.split("\n").map((l) => l.trim().replace(/^([-*]|\d+\.)\s+/, "").replace(/\*\*|`/g, "")).find(Boolean) ?? "";
		if (!line || line === "created" || /^Waits on /.test(line) || /^Unblocked:/.test(line) || (/^[a-z_]+: .+ → .+$/.test(line) && !n.text.includes("\n"))) continue;
		return line.length > 160 ? `${line.slice(0, 159)}…` : line;
	}
	return "";
}
function pjLoadWaits(list) {
	for (const i of list) {
		const had = pv.waits.get(i.id);
		if (had && had.at === i.updated_at) continue;
		pv.waits.set(i.id, { at: i.updated_at, why: had?.why ?? "", on: had?.on ?? [], since: had?.since ?? null });
		api(`/api/items/${i.id}`).then((full) => {
			const since = [...full.notes].reverse().find((n) => /→ waiting$/.test(n.text) || /^Waits on /.test(n.text))?.at ?? null;
			pv.waits.set(i.id, { at: i.updated_at, why: pjWaitWhy(full.notes), on: full.waits_on ?? [], since });
			projectDraw();
		}).catch(() => {});
	}
}

function pjSection(key, title, n, extra = "") {
	return { key: `h-${key}`, html: `<div class="pj-h" data-key="h-${key}"><h2>${title}</h2>${n ? `<span class="pj-n">${n}</span>` : ""}${extra}</div>` };
}
function pjRow(i, kind) {
	const sel = pv.sel === i.id;
	if (kind === "doing") return row(i, { meta: pjMeta(i, [pjRunState(i)]), right: pjLive(i), selected: sel });
	if (kind === "next") {
		const r = pjRunState(i);
		return `<div class="pj-item" role="none" data-id="${i.id}"><span class="pj-grip" title="Drag to reorder (or Alt+↑/↓)" aria-hidden="true"><svg viewBox="0 0 8 14" width="8" height="14"><g fill="currentColor"><circle cx="2" cy="3" r="1.1"/><circle cx="6" cy="3" r="1.1"/><circle cx="2" cy="7" r="1.1"/><circle cx="6" cy="7" r="1.1"/><circle cx="2" cy="11" r="1.1"/><circle cx="6" cy="11" r="1.1"/></g></svg></span>${row(i, { meta: pjMeta(i), right: (r || pjLive(i)) + pjRunBtn(i), selected: sel })}</div>`;
	}
	if (kind === "waiting") {
		const w = pv.waits.get(i.id);
		const on = w?.on?.length ? `waits on ${w.on.map((b) => `<b>${esc(b.title)}</b>`).join(", ")}` : "";
		const meta = [w?.why ? esc(w.why) : "", on, i.area ? esc(i.area) : ""].filter(Boolean).join(" · ") || esc(rowMeta(i, { project: false }));
		return row(i, { meta, right: pjAge(w?.since ?? i.updated_at), selected: sel });
	}
	if (kind === "idea") return row(i, { meta: pjMeta(i), right: `<button type="button" class="ghost sm" data-task="${i.id}">Make it a task</button>`, selected: sel });
	return row(i, { meta: pjMeta(i), selected: sel });
}

function pjWorkLists() {
	const g = pjGoal();
	const all = pjItems().filter((i) => OPEN.includes(i.status) && (!g || i.goal_id === g.id));
	const agent = all.filter((i) => i.owner === "agent");
	const doing = agent.filter((i) => i.status === "doing");
	let next = agent.filter((i) => i.status === "todo" && i.kind !== "idea");
	if (pv.order) {
		const at = new Map(pv.order.map((id, n) => [id, n]));
		next = [...next].sort((a, b) => (at.get(a.id) ?? 1e9) - (at.get(b.id) ?? 1e9));
	}
	const waiting = agent.filter((i) => i.status === "waiting");
	const ideas = all.filter((i) => i.kind === "idea" && i.status !== "doing");
	// The Inbox's own count (asks that wait on Kostas), or under a goal the ones on it.
	const mine = g ? all.filter(needsYou).length : pjProject()?.mine ?? 0;
	return { g, doing, next, waiting, ideas, mine };
}

function pjWork() {
	const { g, doing, next, waiting, ideas, mine } = pjWorkLists();
	pjLoadWaits(waiting);
	const out = [];
	if (g) out.push({ key: "goal", html: `<div class="pj-filter" data-key="goal">${glyph("goal")}Only <b>${esc(g.title)}</b><a class="ghost sm" href="${pjHref()}">Show all the work</a></div>` });
	if (mine) out.push({ key: "mine", html: `<a class="pj-mine" data-key="mine" href="#inbox/${encodeURIComponent(pv.slug)}">${mine === 1 ? "One ask of yours waits" : `${mine} asks of yours wait`} in the Inbox →</a>` });
	if (doing.length) {
		out.push(pjSection("doing", "In progress", doing.length));
		out.push({ key: "l-doing", html: `<div class="pj-list" role="listbox" aria-label="In progress" data-key="l-doing" data-list="doing"></div>`, items: doing, kind: "doing" });
	}
	out.push(pjSection("next", "Next up", next.length, next.length > 1 ? `<span class="pj-sub">in this order · drag to change it</span>` : ""));
	out.push(next.length
		? { key: "l-next", html: `<div class="pj-list" role="listbox" aria-label="Next up" data-key="l-next" data-list="next"></div>`, items: next, kind: "next" }
		: { key: "e-next", html: `<div data-key="e-next">${emptyState(g ? "Nothing next for this goal" : "Nothing next", "Write the next piece of work in the box above: Enter files it for an agent.")}</div>` });
	if (waiting.length) {
		out.push(pjSection("waiting", "Waiting", waiting.length));
		out.push({ key: "l-waiting", html: `<div class="pj-list" role="listbox" aria-label="Waiting" data-key="l-waiting" data-list="waiting"></div>`, items: waiting, kind: "waiting" });
	}
	if (ideas.length) {
		const key = `pj-ideas-${pv.slug}`;
		out.push({ key: "l-ideas", html: `<details class="pj-fold" data-key="${esc(key)}"${isOpen(key, false)}><summary><h2>Ideas</h2><span class="pj-n">${ideas.length}</span></summary><div class="pj-list" role="listbox" aria-label="Ideas" data-list="idea"></div></details>`, items: ideas, kind: "idea" });
	}
	return out;
}

function pjDrawWork(pane) {
	if (!pane.querySelector("#pj-compose")) {
		pane.innerHTML = `${pjComposer()}<div class="pj-lists" id="pj-lists"></div>`;
		pjFit(pane.querySelector("#pj-new"));
	}
	paint(pane.querySelector("#pj-hint"), pjComposeHint());
	for (const b of pane.querySelectorAll("[data-kind]")) b.setAttribute("aria-checked", String(b.dataset.kind === pv.kind));
	const blocks = pjWork();
	const lists = pane.querySelector("#pj-lists");
	// keyedList keeps each block (and a folded Ideas, its toggle) as it is when its frame didn't change.
	keyedList(lists, blocks, (b) => b.key, (b) => b.html);
	for (const b of blocks) {
		if (!b.items) continue;
		const node = lists.querySelector(`[data-key="${CSS.escape(b.key)}"]`);
		const box = node.matches("[data-list]") ? node : node.querySelector("[data-list]");
		keyedList(box, b.items, (i) => i.id, (i) => pjRow(i, b.kind));
	}
	pjRoving(pane);
}
// One row of the page takes Tab: the selected one, else the first.
function pjRoving(pane) {
	const rows = [...pane.querySelectorAll(".k-row")];
	if (!rows.length) return;
	const on = rows.find((r) => Number(r.dataset.id) === pv.sel) ?? rows[0];
	for (const r of rows) r.tabIndex = r === on ? 0 : -1;
}
const pjFit = (ta) => { if (!ta) return; ta.style.height = "auto"; ta.style.height = `${Math.min(ta.scrollHeight, 220)}px`; ta.style.overflowY = ta.scrollHeight > 220 ? "auto" : "hidden"; };

/* ---------- Pages, Rulings, Done ---------- */

function pjPages() {
	// Day pages, folded under their label, go after the pages people wrote.
	const all = reportGroups(), days = (g) => g.reports.every(isDay);
	const reports = [...all.filter((g) => !days(g)), ...all.filter(days)];
	const sources = sourceList();
	const reportsHtml = reportList(reports, { foldDays: true });
	return `<div class="pj-pages">
		<section class="pj-col"><div class="pj-h"><h2>Pages</h2>${reportTools(reports)}</div>
			<div class="pj-plain">${reportsHtml || `<p class="pj-none">${NO_REPORTS}</p>`}</div></section>
		<section class="pj-col"><div class="pj-h"><h2>Links</h2>${linkTools()}</div>
			<div class="pj-plain">${linkListHtml() || `<p class="pj-none">No links for this project yet: + adds one (for this project or every project).</p>`}</div>
			${sources.length ? `<div class="pj-h"><h2>Data sources</h2><span class="pj-n">${sources.length}</span></div><div class="pj-plain">${sources.map(sourceRow).join("")}</div>` : ""}</section></div>`;
}

async function loadProjectDone() {
	const slug = pv.slug;
	try {
		const t = await api(`/api/today?project=${encodeURIComponent(slug)}&since=2000-01-01`);
		if (slug !== pv.slug) return;
		pv.done = t.done;
		pv.doneFor = slug;
		projectDraw();
	} catch (e) { toast(e.message); }
}
function pjDone() {
	if (pv.doneFor !== pv.slug || !pv.done) return `<p class="pj-none">Loading…</p>`;
	if (!pv.done.length) return emptyState("Nothing done yet", "What agents finish here shows in this list, with the first line of their note.");
	const shown = pv.done.slice(0, pv.doneShown);
	const rows = shown.map((d) => row({ id: d.ref, ref: d.ref, kind: d.kind, title: d.title }, {
		meta: d.note ? esc(d.note) : `<span class="pj-faint">no note</span>`, right: pjAge(d.done_at),
	})).join("");
	const more = pv.done.length - shown.length;
	return `<div class="pj-list" role="listbox" aria-label="Done">${rows}</div>${more > 0 ? `<div class="pj-more"><button type="button" class="ghost sm" id="pj-done-more">Show ${Math.min(more, PJ_DONE_STEP)} more</button><span class="pj-faint">${more} older</span></div>` : ""}`;
}

/* ---------- Drawing ---------- */

function projectDraw() {
	if (projectView.hidden || pv.dragging) return;
	const p = pjProject();
	$("#pj").hidden = !p;
	$("#pj-missing").hidden = !!p;
	if (!p) {
		paint($("#pj-missing"), state.projects.length ? emptyState("No such project", `There's no project "${pv.slug}" on the board (it may be archived).`, `<a class="ghost sm" href="#inbox">The Inbox</a>`) : "");
		return;
	}
	$("#pj-tabs").setAttribute("aria-label", p.name);
	paint($("#pj-head"), pjHeader());
	paint($("#pj-tabs"), pjTabs());
	for (const pane of projectView.querySelectorAll("[data-pane]")) pane.hidden = pane.dataset.pane !== pv.tab;
	const pane = $(`#pj-pane-${pv.tab}`);
	if (pv.tab === "work") pjDrawWork(pane);
	else if (pv.tab === "pages") { paint(pane, pjPages()); pane.classList.toggle("editing", editingLinks); }
	else if (pv.tab === "rulings") { if (!rulingEditing()) renderRulings(pane, pv.rulings); }
	else if (pv.tab === "done") paint(pane, pjDone());
}

function pjSetTab(tab) {
	if (pv.tab === tab) return;
	pv.tab = tab;
	localSet("project.tab", tab);
	projectDraw();
	if (tab === "done") loadProjectDone();
	if (tab === "rulings") loadRulings();
}

/* ---------- Filing ---------- */

async function pjFile(run) {
	const ta = $("#pj-new");
	const text = ta.value.trim();
	if (!text) return;
	const [first, ...rest] = text.split("\n");
	const kind = pv.kind;
	const why = run ? pjRunWhy(kind) : "";
	const g = pjGoal();
	ta.disabled = true;
	try {
		const { id } = await api("/api/items", { method: "POST", body: JSON.stringify({
			title: first.trim(), body: rest.join("\n").trim(), kind, owner: "agent", project: pv.slug, ...(g ? { goal_id: g.id } : {}),
		}) });
		ta.value = "";
		pjFit(ta);
		if (run && !why) {
			try { await sendItem(id); toast("Filed, and an agent is on it"); }
			catch (e) { toast(`Filed, but the agent didn't start: ${e.message}`); await loadItems(); }
		} else {
			await loadItems();
			toast(run && why ? `Filed. ${why}` : kind === "idea" ? "Filed under Ideas" : "Filed under Next up");
		}
		pv.sel = id;
		projectDraw();
	} catch (e) { toast(e.message); }
	finally { ta.disabled = false; ta.focus(); }
}

/* ---------- The order ---------- */

const pjNextIds = () => [...projectView.querySelectorAll('[data-list="next"] > .pj-item')].map((n) => Number(n.dataset.id));
async function pjSaveOrder(ids) {
	pv.order = ids;
	const refs = ids.map((id) => state.items.find((i) => i.id === id)?.ref).filter(Boolean).map((r) => `wb-${r}`);
	try {
		await api(`/api/projects/${encodeURIComponent(pv.slug)}/order`, { method: "PUT", body: JSON.stringify({ refs }) });
		await loadItems();
	} catch (e) { toast(e.message); }
	pv.order = null;
	projectDraw();
}
// Alt+↑/↓ on a row of Next up: one place up or down, saved at once; the focus stays on it.
function pjMove(id, dir) {
	const ids = pjNextIds();
	const at = ids.indexOf(id), to = at + dir;
	if (at < 0 || to < 0 || to >= ids.length) return;
	[ids[at], ids[to]] = [ids[to], ids[at]];
	const box = projectView.querySelector('[data-list="next"]');
	const node = box.querySelector(`:scope > [data-id="${id}"]`);
	const other = box.querySelector(`:scope > [data-id="${ids[at]}"]`);
	if (dir < 0) box.insertBefore(node, other); else box.insertBefore(other, node);
	node.querySelector(".k-row").focus();
	pjSaveOrder(ids);
}

// Dragging by the grip (mouse, pen or touch): the row follows the pointer among its siblings; dropping saves.
let pjDrag = null;
projectView.addEventListener("pointerdown", (e) => {
	const grip = e.target.closest(".pj-grip");
	if (!grip || e.button > 0) return;
	const node = grip.closest(".pj-item");
	e.preventDefault();
	grip.setPointerCapture(e.pointerId);
	pjDrag = { node, box: node.parentElement, before: pjNextIds().join(), id: e.pointerId };
	pv.dragging = true;
	node.classList.add("is-drag");
});
projectView.addEventListener("pointermove", (e) => {
	if (!pjDrag || e.pointerId !== pjDrag.id) return;
	const { node, box } = pjDrag;
	const others = [...box.children].filter((c) => c !== node);
	const after = others.find((c) => { const r = c.getBoundingClientRect(); return e.clientY < r.top + r.height / 2; });
	if (after) { if (node.nextElementSibling !== after) box.insertBefore(node, after); }
	else if (box.lastElementChild !== node) box.append(node);
});
function pjDrop(e) {
	if (!pjDrag || e.pointerId !== pjDrag.id) return;
	const { node, before } = pjDrag;
	node.classList.remove("is-drag");
	pjDrag = null;
	pv.dragging = false;
	const ids = pjNextIds();
	if (ids.join() !== before) pjSaveOrder(ids); else projectDraw();
}
projectView.addEventListener("pointerup", pjDrop);
projectView.addEventListener("pointercancel", pjDrop);

/* ---------- Clicks and keys ---------- */

projectView.addEventListener("click", async (e) => {
	const t = e.target;
	const tab = t.closest("[data-tab]");
	if (tab) return pjSetTab(tab.dataset.tab);
	// The header
	const gf = t.closest("[data-goal-filter]");
	if (gf) return go(pv.goal === Number(gf.dataset.goalFilter) ? pjHref() : pjHref(Number(gf.dataset.goalFilter)));
	const ge = t.closest("[data-goal-edit]");
	if (ge) return openGoal(goalById(ge.dataset.goalEdit));
	if (t.closest("[data-goal-add]")) return openGoal(null);
	if (t.closest("[data-tracker-new]")) return editTracker({ project: pv.slug });
	const tr = t.closest("[data-tracker]");
	if (tr) return openTracker(Number(tr.dataset.tracker));
	// The composer
	const k = t.closest("[data-kind]");
	if (k) { pv.kind = k.dataset.kind; projectDraw(); return $("#pj-new").focus(); }
	if (t.closest("#pj-full")) return openNewItem();
	// Pages: pages.js's tools (add, edit and refresh links, move report groups)
	if (pv.tab === "pages" && pageTools(e, projectView)) return;
	if (t.closest("#pj-done-more")) { pv.doneShown += PJ_DONE_STEP; return projectDraw(); }
	// Rows
	const run = t.closest("[data-run]");
	if (run) {
		run.disabled = true;
		try { await sendItem(run.dataset.run); toast("The agent is on it"); }
		catch (err) { run.disabled = false; toast(err.message); }
		return;
	}
	const task = t.closest("[data-task]");
	if (task) {
		task.disabled = true;
		try { await act.update(task.dataset.task, { kind: "task" }); toast("Now a task, under Next up"); }
		catch (err) { task.disabled = false; toast(err.message); }
		return;
	}
	const r = t.closest(".k-row");
	if (r && projectView.contains(r)) pjOpen(r);
});
function pjOpen(r) {
	const list = [...r.closest('[role="listbox"]').querySelectorAll(".k-row")].map((x) => x.dataset.id);
	if (!isNaN(Number(r.dataset.id))) pv.sel = Number(r.dataset.id);
	openItemById(r.dataset.id, { list }).catch((err) => toast(err.message));
}

// A phone has no Ctrl+Enter, and its Enter may be a new line: its own button files it.
projectView.addEventListener("submit", (e) => { if (e.target.id === "pj-compose") { e.preventDefault(); pjFile(false); } });
projectView.addEventListener("input", (e) => { if (e.target.id === "pj-new") pjFit(e.target); });
projectView.addEventListener("keydown", (e) => {
	const t = e.target;
	if (t.id === "pj-new") {
		if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); pjFile(e.ctrlKey || e.metaKey); }
		else if (e.key === "Escape" && t.value) { e.preventDefault(); t.value = ""; pjFit(t); }
		return;
	}
	const tab = t.closest?.('[role="tab"]');
	if (tab && (e.key === "ArrowRight" || e.key === "ArrowLeft")) {
		e.preventDefault();
		const at = PJ_TABS.findIndex(([k]) => k === pv.tab);
		pjSetTab(PJ_TABS[(at + (e.key === "ArrowRight" ? 1 : PJ_TABS.length - 1)) % PJ_TABS.length][0]);
		return $(`#pj-tab-${pv.tab}`)?.focus();
	}
	const r = t.closest?.(".k-row");
	if (!r || t !== r) return;
	if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
		if (r.closest('[data-list="next"]')) { e.preventDefault(); pjMove(Number(r.dataset.id), e.key === "ArrowUp" ? -1 : 1); }
		return;
	}
	if (e.key === "ArrowDown" || e.key === "ArrowUp") {
		e.preventDefault();
		const rows = [...r.closest("[data-pane]").querySelectorAll(".k-row")].filter((x) => x.offsetParent);
		const next = rows[rows.indexOf(r) + (e.key === "ArrowDown" ? 1 : -1)];
		if (next) { r.tabIndex = -1; next.tabIndex = 0; next.focus(); }
	} else if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pjOpen(r); }
});

wireRulings($("#pj-pane-rulings"), pv.rulings);

/* ---------- Drawing again when what it shows changed ---------- */

// Every loader calls redraw() when what it loaded changed, and so do the goal and link dialogs when they save.
hooks.redraw.push(() => projectDraw());
// The run box and the tracker dialog change what a row or a meter shows.
hooks.readerClosed.push(() => projectDraw());
hooks.refresh.push(() => { if (!projectView.hidden && pv.tab === "done") loadProjectDone(); });
