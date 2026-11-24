/* ---------- Goals: what a project's work is for ---------- */

// Above the board's sections: with a project selected, its open goals as a strip (title, target date, progress, what
// waits on you, what blocks it). A click filters the board to that goal's items, and the filter lives in the URL
// hash (#goal/<id>), so a reload keeps it. Under "All", one line per project with an active goal. A goal is added,
// changed, moved, and closed from a small dialog; the reader has a Goal picker; a card names its goal.
// The server side is goals.ts; what blocks a goal (blocksGoal there) is worked out here from the items the board
// already has, so the numbers move the moment an item does.

let goals = [];
let goalsLoaded = false;
const goalById = (id) => goals.find((g) => g.id === Number(id));
// Items that hold their goal back: open and waiting on you, or an agent's item in "waiting" (goals.ts blocksGoal).
const goalBlocks = (i) => OPEN.includes(i.status) && ((i.owner === "kostas" && i.kind !== "notice") || i.status === "waiting");

// The goal the board is filtered to: the one named in the hash. Until the goals have loaded, any id counts (a reload
// shows the filtered board at once); after that, only an open goal of the project on screen.
function goalFilterId() {
	const m = location.hash.match(/^#goal\/(\d+)$/);
	if (!m) return null;
	const id = Number(m[1]);
	if (!goalsLoaded) return id;
	const g = goalById(id);
	return g && g.status === "open" && g.project === state.project ? id : null;
}

function goalNumbers(g) {
	const mine = state.items.filter((i) => i.goal_id === g.id && i.status !== "dropped");
	const open = mine.filter((i) => OPEN.includes(i.status));
	const blockers = open.filter(goalBlocks).sort((a, b) => a.priority - b.priority || (a.owner === "kostas" ? 0 : 1) - (b.owner === "kostas" ? 0 : 1) || a.id - b.id);
	return { total: mine.length, done: mine.length - open.length, open: open.length, mine: open.filter(needsYou).length, blockers };
}

const GOAL_IC = {
	flag: '<path d="M4 14.25V2.25M4 3.25h8.5l-2 2.9 2 2.9H4"/>',
	edit: '<path d="M3 13l.6-2.6L10.8 3.2a1.4 1.4 0 0 1 2 2L5.6 12.4z"/>',
	add: '<path d="M8 3.25v9.5M3.25 8h9.5"/>',
};
GLYPH.goal = GOAL_IC.flag;
const goalIc = (name, w = 1.4) => `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" aria-hidden="true"><g stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round">${GOAL_IC[name]}</g></svg>`;

const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
// "Dec 1 · in 19 d", "Nov 3 · 9 d late", "today"; the class says how close it is.
function goalDue(due) {
	if (!due) return { text: "", cls: "" };
	const days = Math.round((Date.parse(`${due}T00:00:00Z`) - Date.parse(`${todayStr()}T00:00:00Z`)) / 86400e3);
	const date = new Date(`${due}T12:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" });
	const rel = days === 0 ? "today" : days > 0 ? `in ${days} d` : `${-days} d late`;
	return { text: `${date} · ${rel}`, cls: days < 0 ? "late" : days <= 14 ? "soon" : "" };
}

function goalCard(g, picked) {
	const n = goalNumbers(g);
	const due = goalDue(g.due);
	const stuck = n.blockers.length;
	const pct = n.total ? Math.round((n.done / n.total) * 100) : 0;
	const first = n.blockers[0];
	return `<div class="goal${picked ? " on" : ""}${g.is_active ? " active" : ""}" data-goal="${g.id}" role="button" tabindex="0" aria-pressed="${picked}"
		title="${picked ? "Show everything again" : "Show only this goal's items"}">
		<div class="g-top">${g.is_active ? `<span class="g-flag" title="The active goal: agents pick its work first">${glyph("goal")}</span>` : ""}<span class="g-title">${esc(g.title)}</span>
			<button type="button" class="icon-btn g-edit" data-goal-edit="${g.id}" title="Edit this goal" aria-label="Edit ${esc(g.title)}">${goalIc("edit")}</button></div>
		<div class="g-bar" role="img" aria-label="${n.done} of ${n.total} done"><i style="width:${pct}%"></i></div>
		<div class="g-meta"><span>${n.total ? `${n.done} of ${n.total} done` : "no items yet"}</span>
			${due.text ? `<span class="g-due ${due.cls}">${due.text}</span>` : ""}
			${n.mine ? `<span class="g-mine">${n.mine} on you</span>` : ""}</div>
		${first ? `<div class="g-block" title="What blocks it">Blocked by${stuck > 1 ? ` ${stuck}` : ""}: ${esc(first.title)}</div>` : ""}</div>`;
}

// The selected goal in full: what it is for, and every item holding it back.
function goalDetail(g) {
	const n = goalNumbers(g);
	const SHOWN = 6;
	const rows = n.blockers.slice(0, SHOWN).map((i) => `<li><button type="button" class="gd-item" data-goal-item="${i.id}">${kindIcon(i.kind)}<span class="gd-t">${esc(i.title)}</span>
		<small>${i.owner === "kostas" ? "for you" : "agent, waiting"}${i.priority === 1 ? ` · <span class="p1">P1</span>` : ""}</small></button></li>`).join("");
	return `<div class="goal-detail">
		${g.body ? `<div class="gd-body body-view">${md(g.body)}</div>` : ""}
		<div class="gd-block"><h4>${n.blockers.length ? `Blocked by (${n.blockers.length})` : "Nothing blocks it"}</h4>${rows ? `<ul>${rows}</ul>${n.blockers.length > SHOWN ? `<p class="hint">…and ${n.blockers.length - SHOWN} more, below.</p>` : ""}` : `<p class="hint">${n.open ? "Everything open on it is with agents and moving." : n.total ? "Nothing left open on it." : "Nothing is attached to it yet."}</p>`}</div>
		<div class="row"><button type="button" class="ghost sm" data-goal-clear>Show everything</button><span class="spacer"></span>
			<button type="button" class="ghost sm" data-goal-edit="${g.id}">Edit goal</button></div></div>`;
}

function goalsTop() {
	if (!goalsLoaded) return "";
	if (state.project) {
		const mine = goals.filter((g) => g.project === state.project && g.status === "open");
		const picked = goalFilterId();
		if (!mine.length) return `<div class="goals none"><span>${glyph("goal")}No goals yet: say what this project's work is for.</span><button type="button" class="ghost sm" data-goal-add>Add a goal</button></div>`;
		const sel = picked && mine.find((g) => g.id === picked);
		return `<section class="goals" aria-label="Goals"><div class="goals-head"><b>${glyph("goal")}Goals</b><span class="spacer"></span>
			<button type="button" class="icon-btn" data-goal-add title="Add a goal" aria-label="Add a goal">${goalIc("add", 1.6)}</button></div>
			<div class="goal-cards">${mine.map((g) => goalCard(g, g.id === picked)).join("")}</div>${sel ? goalDetail(sel) : ""}</section>`;
	}
	// All projects: the active goal of each, one line.
	const lines = state.projects.map((p) => {
		const g = goals.find((x) => x.project === p.slug && x.is_active);
		if (!g) return "";
		const n = goalNumbers(g);
		const due = goalDue(g.due);
		return `<button type="button" class="goal-line" data-goal-open="${g.id}" title="Open ${esc(p.name)} on this goal">
			<span class="gl-proj">${esc(p.name)}</span><span class="g-title">${esc(g.title)}</span>
			<span class="g-bar" aria-hidden="true"><i style="width:${n.total ? Math.round((n.done / n.total) * 100) : 0}%"></i></span>
			<span class="gl-n">${n.total ? `${n.done}/${n.total}` : "–"}</span><span class="g-due ${due.cls}">${due.text}</span><span class="g-mine">${n.mine ? `${n.mine} on you` : ""}</span></button>`;
	}).join("");
	return lines ? `<section class="goals all" aria-label="Goals"><div class="goals-head"><b>${glyph("goal")}Goals in progress</b></div>${lines}</section>` : "";
}
hooks.boardTop.push(goalsTop);
hooks.boardFilter.push((i) => { const id = goalFilterId(); return id === null || i.goal_id === id; });
hooks.boardEmpty.push((n) => goalFilterId() !== null && !n ? `<div class="empty">Nothing open for this goal.</div>` : "");
// Quiet: the goal's name on a card, unless the board is already filtered to one goal.
hooks.cardMeta.push((i) => {
	if (i.goal_id == null || goalFilterId() !== null || !OPEN.includes(i.status)) return "";
	const g = goalById(i.goal_id);
	// With one goal in the project it says nothing the project doesn't.
	if (g && goals.filter((x) => x.project === g.project && x.status === "open").length < 2) return "";
	return g ? `<span class="goal-tag" title="Goal: ${esc(g.title)}">${glyph("goal")}${esc(g.title)}</span>` : "";
});

/* The filter */

// Filter the board to a goal (switching to its project first), or back to everything.
function showGoal(id) {
	const g = goalById(id);
	if (!g) return;
	useProject(g.project);
	go(`#goal/${g.id}`);
}
function clearGoal() {
	if (goalFilterId() === null && !/^#goal\//.test(location.hash)) return;
	setProject(state.project);
}

async function loadGoals() {
	const list = await api("/api/goals");
	if (list === goals && goalsLoaded) return;
	goals = list;
	goalsLoaded = true;
	// A hash that names a goal that isn't there any more, or is closed: back to everything. (One of another project
	// stays: hooks.start below goes to that project.)
	const m = location.hash.match(/^#goal\/(\d+)$/);
	if (/^#goal\//.test(location.hash) && !(m && goalById(m[1])?.status === "open")) history.replaceState(null, "", location.pathname + location.search);
	renderBoard();
}
const goalsReady = loadGoals().catch(() => { goalsLoaded = true; });

$("#sections").addEventListener("click", (e) => {
	const edit = e.target.closest("[data-goal-edit]");
	if (edit) { e.stopPropagation(); return openGoal(goalById(edit.dataset.goalEdit)); }
	if (e.target.closest("[data-goal-add]")) return openGoal(null);
	if (e.target.closest("[data-goal-clear]")) return clearGoal();
	const it = e.target.closest("[data-goal-item]");
	if (it) return openItemById(it.dataset.goalItem).catch((err) => toast(err.message));
	const open = e.target.closest("[data-goal-open]");
	if (open) return showGoal(open.dataset.goalOpen);
	const c = e.target.closest(".goal[data-goal]");
	if (c) return Number(c.dataset.goal) === goalFilterId() ? clearGoal() : showGoal(c.dataset.goal);
});
$("#sections").addEventListener("keydown", (e) => {
	const c = e.target.closest?.(".goal[data-goal]");
	if (c && e.target === c && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); c.click(); }
});

hooks.start.push(async () => {
	await goalsReady;
	// A reload on #goal/<id> of another project than the one open last: go to that project.
	const m = location.hash.match(/^#goal\/(\d+)$/);
	const g = m && goalById(m[1]);
	if (g && g.status === "open" && g.project !== state.project && state.projects.some((p) => p.slug === g.project)) {
		useProject(g.project);
		retitle();
	}
	renderBoard();
});
hooks.refresh.push(() => { if (!goalDlg.open) loadGoals().catch(() => {}); });

/* The goal dialog */

document.body.insertAdjacentHTML("beforeend", `<dialog id="goal-dlg" class="narrow"><form class="dlg" id="goal-form" autocomplete="off">
	<b id="goal-heading">New goal</b>
	<label class="field-col goal-field">What this work is for<input name="title" required maxlength="200" placeholder="First release"></label>
	<div class="fields">
		<label>Target date (optional)<input name="due" type="date"></label>
		<label class="goal-check"><span><input name="active" type="checkbox"> The active goal</span><small>Agents pick its work first.</small></label>
	</div>
	<label class="field-col goal-field">Short description (markdown)<textarea name="body" rows="4" placeholder="What done looks like"></textarea></label>
	<div class="row goal-order" id="goal-order"><span class="hint">Order</span><button type="button" class="ghost sm" data-move="-1">Earlier</button><button type="button" class="ghost sm" data-move="1">Later</button></div>
	<div class="error" id="goal-err"></div>
	<div class="row">
		<button type="button" class="ghost" id="goal-done">Mark done</button>
		<button type="button" class="ghost" id="goal-drop">Drop</button>
		<span class="spacer"></span>
		<button type="button" class="ghost" id="goal-cancel">Cancel</button>
		<button type="submit" class="primary">Save</button>
	</div>
</form></dialog>`);
const goalDlg = $("#goal-dlg");
const goalForm = $("#goal-form");
let goalEditing = null;

function openGoal(g) {
	goalEditing = g;
	goalForm.reset();
	$("#goal-heading").textContent = g ? "Edit goal" : "New goal";
	goalForm.title.value = g?.title ?? "";
	goalForm.due.value = g?.due ?? "";
	goalForm.body.value = g?.body ?? "";
	// A project's first goal is its active one anyway.
	goalForm.active.checked = g ? g.is_active : false;
	const siblings = goals.filter((x) => x.project === (g?.project ?? state.project) && x.status === "open").length;
	$("#goal-order").hidden = !g || siblings < 2;
	$("#goal-done").hidden = !g;
	$("#goal-drop").hidden = !g;
	$("#goal-err").textContent = "";
	goalDlg.showModal();
	goalForm.title.focus();
}

async function saveGoal(extra = {}) {
	const f = goalForm;
	try {
		const patch = { title: f.title.value, due: f.due.value, body: f.body.value, ...extra };
		// Only what changed about "active": leaving it alone on a goal that wasn't, keeps the project's own pick.
		if (!goalEditing || f.active.checked !== goalEditing.is_active) patch.active = f.active.checked;
		if (goalEditing) goals = await api(`/api/goals/${goalEditing.id}`, { method: "PATCH", body: JSON.stringify(patch) });
		else {
			if (!state.project) throw new Error("Pick a project first: goals belong to one.");
			goals = await api("/api/goals", { method: "POST", body: JSON.stringify({ ...patch, project: state.project }) });
		}
		goalDlg.close();
		// A goal that is closed or gone can't filter the board.
		if (goalFilterId() === null && /^#goal\//.test(location.hash)) clearGoal();
		renderBoard();
	} catch (e) { $("#goal-err").textContent = e.message; }
}
goalForm.addEventListener("submit", (e) => { e.preventDefault(); saveGoal(); });
$("#goal-cancel").onclick = () => goalDlg.close();
$("#goal-done").onclick = () => saveGoal({ status: "done" });
$("#goal-drop").onclick = () => saveGoal({ status: "dropped" });
$("#goal-order").addEventListener("click", async (e) => {
	const b = e.target.closest("[data-move]");
	if (!b || !goalEditing) return;
	try { goals = await api(`/api/goals/${goalEditing.id}`, { method: "PATCH", body: JSON.stringify({ move: Number(b.dataset.move) }) }); renderBoard(); }
	catch (err) { $("#goal-err").textContent = err.message; }
});

/* The reader: a Goal picker after Area, when the item's project has goals. Saved when changed. */

hooks.readerProps.push({
	order: 65,
	html(i, r) {
		// A new item made while the board is filtered to a goal serves that goal.
		const filtered = goalFilterId() !== null && goalById(goalFilterId())?.project === i.project ? goalFilterId() : null;
		const current = r.compose && i.goal_id === undefined ? filtered : i.goal_id ?? null;
		const list = goals.filter((g) => g.project === i.project && (g.status === "open" || g.id === current));
		// A project with no goals has nothing to pick.
		if (!list.length) return "";
		const value = current != null && list.some((g) => g.id === current) ? String(current) : "";
		return readerProp("Goal", `<select class="rd-val" data-goal-pick aria-label="Goal">${[["", "No goal"], ...list.map((g) => [g.id, g.status === "open" ? g.title : `${g.title} (${g.status})`])]
			.map(([v, l]) => `<option value="${esc(v)}"${String(v) === value ? " selected" : ""}>${esc(l)}</option>`).join("")}</select>`);
	},
	wire(el, i, r) {
		const sel = el.querySelector("[data-goal-pick]");
		// A new item takes what the picker shows (another project's goal can't come along).
		if (r.compose) r.draft.goal_id = sel.value ? Number(sel.value) : null;
		sel.addEventListener("change", () => r.set({ goal_id: sel.value ? Number(sel.value) : null }));
	},
});
