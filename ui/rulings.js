/* ---------- Rulings: a project's standing answers (rulings.ts) ---------- */

// A part of the sidebar (folded, like Links), a view of them by project (#rulings, #rulings/<slug>), the ruling an
// answered item made in the reader, and a group in search. Live and retired ones come in one list.
state.rulings = [];
const GAVEL = `<svg class="doc-ic" viewBox="0 0 16 16" fill="none" stroke="currentColor"><g stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="m6.2 2.6 4.2 4.2M4.4 4.4l4.2 4.2M5.3 3.5l-1.8 1.8M10.4 6.8l-1.8 1.8M7.5 5.7l6.25 6.25a.9.9 0 0 1-1.3 1.3L6.2 7"/><path d="M2 14h5"/></g></svg>`;
// The sidebar shows this many; the rest are in the view.
const RULINGS_SHOWN = 4;
let rulingsLoaded = false;

async function loadRulings() {
	try {
		const list = await api("/api/rulings");
		const changed = JSON.stringify(list) !== JSON.stringify(state.rulings);
		state.rulings = list;
		rulingsLoaded = true;
		if (changed) { renderRail(); if (!$("#rulings-view").hidden) renderRulings(); }
	} catch {}
}
hooks.start.push(loadRulings);
hooks.refresh.push(() => { if (!rulingEditing()) loadRulings(); });

const liveRulings = (slug) => state.rulings.filter((r) => !r.retired_at && (slug ? r.project === slug : !isArchived(r.project)));
const rulingDay = (s) => parseTime(s).toLocaleDateString(undefined, { day: "numeric", month: "short" });
const rulingsHref = (slug, id) => `#rulings${slug ? `/${encodeURIComponent(slug)}` : ""}${id ? `/${id}` : ""}`;

/* Sidebar */
hooks.rail.push((collapsed) => {
	const list = liveRulings(state.project);
	if (collapsed) return list.length ? `<a class="ritem" href="${rulingsHref(state.project)}" title="Rulings (${list.length})"><span class="tile">${GAVEL}</span></a>` : "";
	const row = (r) => `<a class="ritem ruling" href="${rulingsHref(r.project, r.id)}" title="${esc(r.text)}${r.drafted ? "\n(drafted from the answer: an agent rewrites it)" : ""}">${GAVEL}<span>${esc(!state.project ? `${projectName(r.project)} · ${r.text}` : r.text)}</span></a>`;
	const rest = list.length - RULINGS_SHOWN;
	const tools = `<span class="tools"><button class="icon-btn" id="ruling-new" title="Add a ruling" aria-label="Add a ruling"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor"><g stroke-width="1.6"><path d="M8 3v10M3 8h10"/></g></svg></button></span>`;
	const body = list.length
		? list.slice(0, RULINGS_SHOWN).map(row).join("") + `<a class="ritem more-link" href="${rulingsHref(state.project)}"><span>${rest > 0 ? `All ${list.length} rulings` : "Search, edit, retire"}</span></a>`
		: `<div class="rail-empty">None yet. When you answer a decision, its answer becomes a ruling here: a standing answer agents read before they ask you again.</div>`;
	return `<details class="rsec fold" data-key="rail-rulings"${isOpen("rail-rulings", false)}><summary>Rulings <span class="count">${list.length || ""}</span>${tools}</summary>${body}</details>`;
});
$("#rail").addEventListener("click", (e) => {
	if (e.target.closest("#ruling-new")) {
		e.preventDefault();
		location.hash = rulingsHref(state.project, "new");
		return;
	}
	if (e.target.closest('a[href^="#rulings"]') && narrow()) setCollapsed(true);
});

/* The view */
const rulingsView = document.createElement("section");
rulingsView.id = "rulings-view";
rulingsView.hidden = true;
rulingsView.setAttribute("aria-label", "Rulings");
$("#content").append(rulingsView);
const rv = { slug: "", focus: 0, q: "", retired: false, editing: 0, adding: false };
const rulingEditing = () => !rulingsView.hidden && (rv.editing || rv.adding || rulingsView.contains(document.activeElement) && document.activeElement.matches("input, textarea, select"));

views.push({
	name: "rulings",
	el: "#rulings-view",
	title: "Rulings · Workbench",
	match: (h) => /^#rulings(\/|$)/.test(h),
	async open(hash) {
		const [, slug = "", id = ""] = hash.split("/").map(decodeURIComponent);
		rv.slug = slug && state.allProjects.some((p) => p.slug === slug) ? slug : "";
		rv.adding = id === "new";
		rv.focus = Number(id) || 0;
		rv.editing = 0;
		if (rv.focus && state.rulings.find((r) => r.id === rv.focus)?.retired_at) rv.retired = true;
		if (!rulingsLoaded) await loadRulings();
		renderRulings();
		const at = rv.focus && rulingsView.querySelector(`[data-ruling="${rv.focus}"]`);
		if (at) at.scrollIntoView({ block: "center" });
		if (rv.adding) rulingsView.querySelector("#ruling-add-text")?.focus();
	},
});

function rulingFolded(s) { return s.normalize("NFD").replace(/\p{M}/gu, "").replace(/ς/g, "σ").toLowerCase(); }

function renderRulings() {
	const q = rulingFolded(rv.q.trim());
	const shown = state.rulings.filter((r) => (rv.slug ? r.project === rv.slug : !isArchived(r.project))
		&& !!r.retired_at === rv.retired
		&& (!q || rulingFolded(`${r.text} ${r.question} wb-${r.item_ref}`).includes(q)));
	const retiredN = state.rulings.filter((r) => r.retired_at && (!rv.slug || r.project === rv.slug)).length;
	const slugs = [...new Set(shown.map((r) => r.project))].sort((a, b) => state.allProjects.findIndex((p) => p.slug === a) - state.allProjects.findIndex((p) => p.slug === b));
	const projectOpts = [`<option value="">All projects</option>`, ...state.projects.map((p) => `<option value="${esc(p.slug)}"${p.slug === rv.slug ? " selected" : ""}>${esc(p.name)}</option>`)].join("");
	const row = (r) => {
		if (rv.editing === r.id) return `<div class="ruling-row editing" data-ruling="${r.id}"><form class="ruling-edit" data-edit="${r.id}">
			<textarea name="text" rows="3" maxlength="400" required aria-label="The ruling">${esc(r.text)}</textarea>
			<div class="ruling-btns"><button class="primary sm" type="submit">Save</button><button class="ghost sm" type="button" data-cancel>Cancel</button></div>
			<p class="error" data-err></p></form></div>`;
		const from = r.item_ref ? `<button type="button" class="ruling-ref" data-open-item="${esc(r.item_ref)}" title="${esc(r.question)}">wb-${esc(r.item_ref)}</button>` : "";
		const meta = [from, esc(rulingDay(r.created_at)), r.drafted ? `<span class="ruling-draft" title="Drafted from the question and its answer. The next agent that picks the item up rewrites it as one clear line; you can too.">draft</span>` : "", r.retired_at ? `retired ${esc(rulingDay(r.retired_at))}` : ""].filter(Boolean).join(" · ");
		return `<div class="ruling-row${rv.focus === r.id ? " focus" : ""}" data-ruling="${r.id}">
			<div class="ruling-main"><div class="ruling-text">${esc(r.text)}</div>
			${r.question && !r.drafted ? `<div class="ruling-q">${esc(r.question)}</div>` : ""}
			<small>${meta}</small></div>
			<div class="ruling-btns">${r.retired_at
				? `<button class="ghost sm" type="button" data-unretire="${r.id}">Bring back</button>`
				: `<button class="ghost sm" type="button" data-edit-ruling="${r.id}">Edit</button><button class="ghost sm" type="button" data-retire="${r.id}" title="It no longer holds: agents stop reading it">Retire</button>`}</div></div>`;
	};
	const groups = slugs.map((s) => `${rv.slug ? "" : `<div class="v-group ruling-group">${esc(projectName(s))}</div>`}${shown.filter((r) => r.project === s).map(row).join("")}`).join("");
	const addSlug = rv.slug || state.project || state.projects[0]?.slug || "";
	const add = rv.retired ? "" : rv.adding
		? `<form class="ruling-add" id="ruling-add">
			<textarea id="ruling-add-text" name="text" rows="2" maxlength="400" required placeholder="One line in plain words, e.g. “Traditional is the default melisma style”"></textarea>
			<div class="ruling-btns">${rv.slug ? "" : `<select name="project" aria-label="Project">${state.projects.map((p) => `<option value="${esc(p.slug)}"${p.slug === addSlug ? " selected" : ""}>${esc(p.name)}</option>`).join("")}</select>`}
			<button class="primary sm" type="submit">Add</button><button class="ghost sm" type="button" data-cancel>Cancel</button></div><p class="error" data-err></p></form>`
		: `<button class="ghost sm" type="button" id="ruling-add-open">Add a ruling</button>`;
	const empty = rv.q ? `Nothing matches “${esc(rv.q)}”.` : rv.retired ? "No retired rulings." :
		"None yet. When you answer a decision, its answer becomes a ruling: a standing answer agents read before they start, and before they ask you anything.";
	paint(rulingsView, `<div class="rulings-wrap">
		<div class="vault-head"><h2>Rulings</h2><small>${rv.retired ? "Retired: no longer hold" : "What you already decided. Agents read these before they ask you again"}</small></div>
		<div class="rulings-bar">
			<input type="search" id="ruling-q" placeholder="Search rulings" value="${esc(rv.q)}" aria-label="Search rulings">
			<select id="ruling-project" aria-label="Project">${projectOpts}</select>
			<button class="ghost sm" type="button" id="ruling-retired" aria-pressed="${rv.retired}">${rv.retired ? "Live ones" : `Retired${retiredN ? ` (${retiredN})` : ""}`}</button>
		</div>
		<div class="ruling-addbox">${add}</div>
		${groups || `<p class="rail-empty ruling-none">${empty}</p>`}
	</div>`);
}

async function saveRuling(id, body) {
	return api(`/api/rulings/${id}`, { method: "PATCH", body: JSON.stringify(body) });
}
rulingsView.addEventListener("input", (e) => {
	if (e.target.id !== "ruling-q") return;
	rv.q = e.target.value;
	const at = e.target.selectionStart;
	renderRulings();
	const box = $("#ruling-q");
	box.focus();
	box.setSelectionRange(at, at);
});
rulingsView.addEventListener("change", (e) => {
	if (e.target.id === "ruling-project") location.hash = rulingsHref(e.target.value);
});
rulingsView.addEventListener("click", async (e) => {
	const t = e.target;
	if (t.closest("#ruling-retired")) { rv.retired = !rv.retired; rv.editing = 0; return renderRulings(); }
	if (t.closest("#ruling-add-open")) { rv.adding = true; renderRulings(); return $("#ruling-add-text").focus(); }
	if (t.closest("[data-cancel]")) { rv.adding = false; rv.editing = 0; return renderRulings(); }
	const ed = t.closest("[data-edit-ruling]");
	if (ed) {
		rv.editing = Number(ed.dataset.editRuling);
		renderRulings();
		const box = rulingsView.querySelector(`[data-edit="${rv.editing}"] textarea`);
		box.focus();
		box.setSelectionRange(box.value.length, box.value.length);
		return;
	}
	const ret = t.closest("[data-retire], [data-unretire]");
	if (ret) {
		const id = Number(ret.dataset.retire ?? ret.dataset.unretire);
		try {
			await saveRuling(id, { retired: !!ret.dataset.retire });
			toast(ret.dataset.retire ? "Retired. It's under Retired if you need it back." : "Back in use.");
		} catch (err) { toast(err.message); }
		return loadRulings();
	}
	const it = t.closest("[data-open-item]");
	if (it) {
		try { await openItemById(it.dataset.openItem); } catch { toast(`wb-${it.dataset.openItem} isn't on the board any more (closed items are tidied away).`); }
	}
});
rulingsView.addEventListener("submit", async (e) => {
	e.preventDefault();
	const f = e.target;
	const err = f.querySelector("[data-err]");
	try {
		if (f.id === "ruling-add") {
			await api("/api/rulings", { method: "POST", body: JSON.stringify({ text: f.text.value, project: f.project?.value || rv.slug }) });
			rv.adding = false;
		} else {
			await saveRuling(Number(f.dataset.edit), { text: f.text.value });
			rv.editing = 0;
		}
		await loadRulings();
		renderRulings();
	} catch (ex) { if (err) err.textContent = ex.message; }
});
// Enter saves, Shift+Enter is a new line (a ruling is one line anyway), Escape puts it away.
rulingsView.addEventListener("keydown", (e) => {
	const f = e.target.closest?.("form");
	if (!f || e.target.tagName !== "TEXTAREA") return;
	if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); f.requestSubmit(); }
	if (e.key === "Escape") { e.preventDefault(); rv.adding = false; rv.editing = 0; renderRulings(); }
});

/* The reader: the ruling an answer made, among the item's properties. A link to it in Rulings (which closes the
   reader, as any view does). */
const rulingAsked = new Set();
hooks.readerProps.push({
	order: 120,
	html(i, r) {
		if (r.compose || !i.id) return "";
		const mine = state.rulings.filter((x) => x.item_id === i.id && !x.retired_at);
		// Just answered: its ruling is new, so look again (once per answer).
		const key = `${i.id}:${i.answer}`;
		if (i.answer && !mine.length && !rulingAsked.has(key)) { rulingAsked.add(key); loadRulings().then(() => r.render()); }
		return mine.length ? readerProp("Ruling", mine.map((x) => `<a class="item-ruling" href="${rulingsHref(x.project, x.id)}" title="Open in Rulings">${esc(x.text)}${x.drafted ? ` <small>(draft)</small>` : ""}</a>`).join("")) : "";
	},
});

/* Search */
hooks.searchResults.push((data, q) => (data.rulings?.length
	? `<div class="rgroup">Rulings</div>` + data.rulings.map((r) => `<a class="res" href="${rulingsHref(r.project, r.id)}">${GAVEL}<span class="rt"><div>${hl(r.text, q)}</div><small>${[r.item_ref ? `wb-${esc(r.item_ref)}` : "", esc(rulingDay(r.created_at)), !state.project ? esc(projectName(r.project)) : ""].filter(Boolean).join(" · ")}</small></span></a>`).join("")
	: ""));
