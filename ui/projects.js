/* ---------- Projects: the list, and which one the board shows ---------- */

async function loadProjects() {
	const all = await api("/api/projects");
	if (all === state.allProjects) return;
	state.allProjects = all;
	state.projects = state.allProjects.filter((p) => !p.archived_at);
	if (state.project && !state.projects.some((p) => p.slug === state.project)) state.project = "";
	renderNav();
	retitle();
}

// The project the board, Today, the queue, rulings and search show ("" for all of them). The address sets it: the
// board view takes #project/<slug> (and "" for all), and the other views keep the one it set last. True when it changed.
function useProject(slug) {
	if (slug && !state.projects.some((p) => p.slug === slug)) slug = "";
	if (slug === state.project) return false;
	state.project = slug;
	localSet("project", slug);
	renderRail();
	loadItems();
	loadCode();
	loadRepos();
	return true;
}
// Goes to a project's page (the board for it, until Projects has pages of its own), or to all of them.
const setProject = (slug) => go(slug ? `#project/${encodeURIComponent(slug)}` : "");
