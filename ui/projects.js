/* ---------- Projects ---------- */

function renderProjects() {
	const total = state.projects.reduce((n, p) => n + p.mine, 0);
	const btn = (p) => `<button class="pbtn" data-project="${esc(p.slug)}" aria-current="${p.slug === state.project}"
		title="${esc(p.name)}${p.mine ? ` · ${p.mine} waiting on you` : ""}${p.notices ? ` · ${p.notices} notice${p.notices > 1 ? "s" : ""}` : ""}">${logo(p)}<span class="pname">${esc(p.slug ? p.name : "All")}</span>${p.mine ? `<span class="badge">${p.mine}</span>` : ""}</button>`;
	const settingsBtn = `<button type="button" class="pbtn set-pbtn" id="settings-btn" title="Settings" aria-label="Settings" aria-pressed="${inSettings()}">
		<span class="set-ic"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor"><g stroke-width="1.4"><path d="M2.5 4.5h6M11.5 4.5h2M2.5 11.5h2M7.5 11.5h6"/><circle cx="10" cy="4.5" r="1.5"/><circle cx="6" cy="11.5" r="1.5"/></g></svg></span><span class="pname">Settings</span></button>`;
	paint($("#prail"), btn({ slug: "", name: "All projects", mine: total }) + `<div class="prail-sep"></div>` + state.projects.map(btn).join("") + settingsBtn);
	const p = state.projects.find((p) => p.slug === state.project);
	paint($("#here"), `<span class="here" style="gap:10px">${logo(p ?? { slug: "" })}<div><b>${esc(p ? p.name : "All projects")}</b>
		<small>${esc(p ? p.path : `${state.projects.length} projects`)}</small></div></span>`);
}

async function loadProjects() {
	state.allProjects = await api("/api/projects");
	state.projects = state.allProjects.filter((p) => !p.archived_at);
	if (state.project && !state.projects.some((p) => p.slug === state.project)) state.project = "";
	renderProjects();
}

function setProject(slug) {
	state.project = slug;
	localSet("project", slug);
	renderProjects();
	renderRail();
	// The vault stays open (showing the new project's secrets); a report goes back to the board.
	if (location.hash && location.hash !== "#vault") history.pushState(null, "", location.pathname + location.search);
	route();
	loadItems();
	loadCode();
	loadRepos();
}
$("#prail").addEventListener("click", (e) => {
	if (e.target.closest("#settings-btn")) return inSettings() ? goBoard() : (location.hash = "#settings");
	const b = e.target.closest("[data-project]");
	if (b) setProject(b.dataset.project);
});
