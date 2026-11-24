/* ---------- Projects, and what the board loads with them: items, repositories, code ---------- */

async function loadProjects() {
	const all = await api("/api/projects");
	if (all === state.allProjects) return;
	state.allProjects = all;
	state.projects = state.allProjects.filter((p) => !p.archived_at);
	if (state.project && !state.projects.some((p) => p.slug === state.project)) state.project = "";
	renderNav();
	retitle();
}

// The project whose page shows last (#project/<slug>), "" for all of them: the items, code and pages loaded are for it,
// and the rulings view, the vault and a new item start from it. The Projects page sets it. True when it changed.
function useProject(slug) {
	if (slug && !state.projects.some((p) => p.slug === slug)) slug = "";
	if (slug === state.project) return false;
	state.project = slug;
	localSet("project", slug);
	redraw();
	loadItems();
	loadCode();
	loadRepos();
	return true;
}
// Goes to a project's page, or to where the board opens.
const setProject = (slug) => go(slug ? `#project/${encodeURIComponent(slug)}` : "");

// Each loader draws again (redraw(), hooks.js) only when its answer changed: api() gives back the same object when
// the board answered 304 (ui/core.js), which is most polls. Closed items come without their details (bodies=open),
// which the reader loads when one is opened.
const drawn = {};
async function loadItems() {
	const items = await api(`/api/items?bodies=open${state.project ? `&project=${encodeURIComponent(state.project)}` : ""}`);
	const archived = state.allProjects.filter((p) => p.archived_at).map((p) => p.slug).join();
	if (drawn.items === items && drawn.archived === archived) return;
	Object.assign(drawn, { items, archived });
	state.items = state.project ? items : items.filter((i) => !isArchived(i.project));
	$("#areas").innerHTML = [...new Set(state.items.map((i) => i.area).filter(Boolean))].sort().map((a) => `<option value="${esc(a)}">`).join("");
	redraw();
}
// Each project's git state (GET /api/git): the Projects page's header line.
async function loadRepos() {
	const repos = await api("/api/git");
	if (repos === state.repos) return;
	state.repos = repos;
	redraw();
}
// Pull requests and commits per item (GET /api/code): the reader's Code.
async function loadCode() {
	const code = await api(`/api/code${state.project ? `?project=${encodeURIComponent(state.project)}` : ""}`);
	if (code === state.code) return;
	state.code = code;
	redraw();
}
