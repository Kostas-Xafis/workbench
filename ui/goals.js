/* ---------- Goals: what a project's work is for ---------- */

// A project's active goal shows in its page's header (project.js), with its progress; a click there shows only its
// work (#project/<slug>/goal/<id>). A goal is added, changed, moved, and closed from a small dialog here; the reader
// has a Goal picker. The server side is goals.ts; what blocks a goal (blocksGoal there) is worked out here from the
// items the board already has, so the numbers move the moment an item does.

let goals = [];
let goalsLoaded = false;
const goalById = (id) => goals.find((g) => g.id === Number(id));
// Items that hold their goal back: open and waiting on you, or an agent's item in "waiting" (goals.ts blocksGoal).
const goalBlocks = (i) => OPEN.includes(i.status) && ((i.owner === "kostas" && i.kind !== "notice") || i.status === "waiting");

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

// A goal's own page: its project's page showing only its work.
function showGoal(id) {
	const g = goalById(id);
	if (g) go(`#project/${encodeURIComponent(g.project)}/goal/${g.id}`);
}

async function loadGoals() {
	const list = await api("/api/goals");
	if (list === goals && goalsLoaded) return;
	goals = list;
	goalsLoaded = true;
	redraw();
}
const goalsReady = loadGoals().catch(() => { goalsLoaded = true; });

// #goal/<id>, the board's old address for a goal: its project's page, on that goal.
defineView({
	name: "goal",
	el: null,
	match: (h) => { const m = h.match(/^#goal\/(\d+)$/); return m ? { id: Number(m[1]) } : null; },
	async show(p) {
		await goalsReady;
		const g = goalById(p.id);
		go(g ? `#project/${encodeURIComponent(g.project)}/goal/${g.id}` : "", { replace: true });
	},
	title: "Goal",
	nav: null,
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
		redraw();
	} catch (e) { $("#goal-err").textContent = e.message; }
}
goalForm.addEventListener("submit", (e) => { e.preventDefault(); saveGoal(); });
$("#goal-cancel").onclick = () => goalDlg.close();
$("#goal-done").onclick = () => saveGoal({ status: "done" });
$("#goal-drop").onclick = () => saveGoal({ status: "dropped" });
$("#goal-order").addEventListener("click", async (e) => {
	const b = e.target.closest("[data-move]");
	if (!b || !goalEditing) return;
	try { goals = await api(`/api/goals/${goalEditing.id}`, { method: "PATCH", body: JSON.stringify({ move: Number(b.dataset.move) }) }); redraw(); }
	catch (err) { $("#goal-err").textContent = err.message; }
});

/* The reader: a Goal picker after Area, when the item's project has goals. Saved when changed. */

hooks.readerProps.push({
	order: 65,
	html(i, r) {
		// A new item made while a project's page shows only one goal's work serves that goal.
		const shown = router.view?.name === "project" ? pjGoal() : null;
		const filtered = shown && shown.project === i.project ? shown.id : null;
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
