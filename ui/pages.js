/* ---------- Pages: reports, links and data sources, as lines (the Pages tab of a project's page, project.js) ---------- */

// What they're drawn with (reportList, reportTools, linkListHtml, linkTools, sourceRow), the clicks on their tools
// (pageTools), their loaders, and the link dialog. They follow state.project, the project whose page shows.

// Links with project '' show everywhere; a project's own links show with it (and under All).
let editingLinks = false;
let editingReports = false;
function linkGroups() {
	const scopes = [["", state.links.filter((l) => !l.project)]];
	for (const p of state.projects) if (!state.project || state.project === p.slug) scopes.push([p.slug, state.links.filter((l) => l.project === p.slug)]);
	const groups = [];
	for (const [slug, ls] of scopes) {
		const prefix = !state.project && slug ? projectName(slug) : "";
		for (const g of [...new Set(ls.map((l) => l.grp))].sort((a, b) => (a === "") - (b === "") || a.localeCompare(b)))
			groups.push({ key: `lg-${slug}-${g}`, label: [prefix, g].filter(Boolean).join(" · "), links: ls.filter((l) => l.grp === g) });
	}
	return groups;
}
const inScope = (r) => state.project ? r.project === state.project : !isArchived(r.project);
function reportOrder(slug) {
	try { return JSON.parse(state.allProjects.find((p) => p.slug === slug)?.report_order || "[]"); } catch { return []; }
}
// A project's report groups as { label, grp, project, reports }: in the order set for them (the rest after those, by
// name), reports without a group last. Under "All", project by project. Archived day pages aren't in here.
function reportGroups() {
	const groups = new Map();
	for (const r of state.reports) {
		if (!inScope(r) || r.archived) continue;
		const key = JSON.stringify([r.project, r.grp]);
		if (!groups.has(key)) groups.set(key, { label: [!state.project ? projectName(r.project) : "", r.grp].filter(Boolean).join(" · "), grp: r.grp, project: r.project, reports: [] });
		groups.get(key).reports.push(r);
	}
	// Day pages newest first (by name, day-YYYY-MM-DD), not by title.
	for (const g of groups.values()) if (g.reports.every(isDay)) g.reports.sort((a, b) => b.name.localeCompare(a.name));
	const projectAt = (slug) => state.allProjects.findIndex((p) => p.slug === slug);
	const at = (g) => { const i = reportOrder(g.project).indexOf(g.grp); return i < 0 ? Infinity : i; };
	return [...groups.values()].sort((a, b) => projectAt(a.project) - projectAt(b.project) || (a.grp === "") - (b.grp === "")
		|| (at(a) === at(b) ? 0 : at(a) - at(b)) || a.grp.localeCompare(b.grp));
}
// Day pages a week or more old, newest first: out of the way, not gone.
const archivedDays = () => state.reports.filter((r) => r.archived && inScope(r)).sort((a, b) => b.name.localeCompare(a.name));
async function moveReportGroup(grp, dir, root) {
	const order = reportGroups().filter((g) => g.grp).map((g) => g.grp);
	const i = order.indexOf(grp), j = i + (dir === "up" ? -1 : 1);
	if (i < 0 || j < 0 || j >= order.length) return;
	[order[i], order[j]] = [order[j], order[i]];
	try {
		const { groups } = await api(`/api/projects/${encodeURIComponent(state.project)}/report-order`, { method: "PUT", body: JSON.stringify({ groups: order }) });
		state.allProjects.find((p) => p.slug === state.project).report_order = JSON.stringify(groups);
		redraw();
		// Keep the keyboard on the heading that moved, on the other arrow once it reaches an end.
		const head = root.querySelector(`[data-group="${CSS.escape(grp)}"]`);
		const btn = head?.querySelector(`[data-move="${dir}"]`);
		(btn && !btn.disabled ? btn : head?.querySelector(`[data-move="${dir === "up" ? "down" : "up"}"]`))?.focus();
	} catch (err) { toast(err.message); }
}
const isDay = (r) => /^day-\d{4}-\d{2}-\d{2}$/.test(r.name);
// Each report group shows this many; the rest fold away.
const GROUP_SHOWN = 2;
// A report's own icon, if it has one: an emoji, or an SVG drawn as a picture so nothing in it can run (see db.ts).
function reportMark(r) {
	if (!r.icon) return "";
	return r.icon.startsWith("<") ? `<img class="rep-ic" alt="" src="data:image/svg+xml,${encodeURIComponent(r.icon)}">` : `<span class="rep-ic">${esc(r.icon)}</span>`;
}
const reportHref = (r) => `#report/${r.id}`;
const isCurrent = (r) => state.report?.id === r.id;

const NO_REPORTS = "None yet. Agents publish pages here, such as a status, a plan or release notes (<code>wb report page.html</code>), and each day with activity gets a page of what moved.";
// A report as a line: its icon (or the page glyph), its title and how long ago it changed.
const ritem = (r) => `<a class="ritem" href="${reportHref(r)}" title="${esc(r.title)} · v${r.version}" aria-current="${isCurrent(r)}">${reportMark(r) || DOC}<span>${esc(r.title)}</span><small>${esc(ago(r.updated_at).replace(" ago", ""))}</small></a>`;
const canMoveGroups = (reports) => !!state.project && reports.filter((g) => g.grp).length > 1;
// The report groups (reportGroups()) as lines, then the archived days. Each group shows its first few (a Days group
// its newest days); the rest fold away, and the fold opens by itself when the report on screen is in it. With the
// pencil on, a project's group headings get arrows to move them. `foldDays`: a group of day pages folds whole under
// its label instead (the Projects page).
function reportList(reports = reportGroups(), { foldDays = false } = {}) {
	const named = reports.filter((g) => g.grp);
	const moving = canMoveGroups(reports) && editingReports;
	const moveBtn = (g, dir, off) => `<button type="button" class="icon-btn" data-move="${dir}" title="Move ${dir}" aria-label="Move ${esc(g.grp)} ${dir}"${off ? " disabled" : ""}>${svg16(dir === "up" ? '<path d="m4.5 10 3.5-3.5 3.5 3.5"/>' : '<path d="m4.5 6 3.5 3.5 3.5-3.5"/>')}</button>`;
	const heading = (g) => {
		if (!g.label) return "";
		if (!moving || !g.grp) return `<div class="glabel">${esc(g.label)}</div>`;
		const i = named.indexOf(g);
		return `<div class="glabel moving" data-group="${esc(g.grp)}"><span>${esc(g.label)}</span>${moveBtn(g, "up", !i)}${moveBtn(g, "down", i === named.length - 1)}</div>`;
	};
	const groupsHtml = reports.map((g) => {
		const rs = g.reports, label = g.label;
		if (foldDays && rs.every(isDay)) {
			const key = `days-${g.project}`;
			return `<details class="lgroup fold more days" data-key="${esc(key)}"${rs.some(isCurrent) ? " open" : isOpen(key, false)}><summary><span>${esc(label || "Days")} (${rs.length})</span></summary>${rs.map(ritem).join("")}</details>`;
		}
		const head = heading(g);
		if (rs.length <= GROUP_SHOWN) return head + rs.map(ritem).join("");
		const rest = rs.slice(GROUP_SHOWN);
		const key = `more-${label}`;
		const open = rest.some(isCurrent) ? " open" : isOpen(key, false);
		const what = rs.every(isDay) ? `Older days (${rest.length})` : `${rest.length} more`;
		return head + rs.slice(0, GROUP_SHOWN).map(ritem).join("") +
			`<details class="lgroup fold more" data-key="${esc(key)}"${open}><summary><span>${what}</span></summary>${rest.map(ritem).join("")}</details>`;
	}).join("");
	const archived = archivedDays();
	// Under "All", the archive says whose day each one is.
	const archiveRows = state.project ? archived.map(ritem).join("") : [...new Set(archived.map((r) => r.project))]
		.map((slug) => `<div class="glabel">${esc(projectName(slug))}</div>` + archived.filter((r) => r.project === slug).map(ritem).join("")).join("");
	const archive = archived.length
		? `<details class="lgroup fold more archive" data-key="reports-archive"${archived.some(isCurrent) ? " open" : isOpen("reports-archive", false)}><summary><span>Archived days (${archived.length})</span></summary>${archiveRows}</details>`
		: "";
	return groupsHtml + archive;
}
// The pencil that moves report groups, when a project has groups to move.
function reportTools(reports = reportGroups()) {
	if (!canMoveGroups(reports)) return "";
	return `<span class="tools"><button class="icon-btn" id="report-edit" title="${editingReports ? "Done moving groups" : "Move groups"}" aria-pressed="${editingReports}" aria-label="Move report groups"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor"><g stroke-width="1.4"><path d="M10.5 2.5l3 3-8 8H2.5v-3z"/></g></svg></button></span>`;
}
// The links (linkGroups()) as lines, a named group folded under its label.
function linkListHtml(links = linkGroups()) {
	return links.map((g) => {
		const items = g.links.map((l) => `<a class="ritem link" href="${esc(l.url)}" target="_blank" rel="noreferrer" data-link="${l.id}" title="${esc(l.url)}">${fav(l)}<span>${esc(l.label)}</span></a>`).join("");
		return g.label ? `<details class="lgroup fold" data-key="${esc(g.key)}"${isOpen(g.key, true)}><summary><span>${esc(g.label)}</span></summary>${items}</details>` : items;
	}).join("");
}
// Add a link; the pencil, then a click on one, edits it; while editing, look up every site's icon again.
const linkTools = () => `<span class="tools">
	<button class="icon-btn" id="link-new" title="Add a link" aria-label="Add a link"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor"><g stroke-width="1.6"><path d="M8 3v10M3 8h10"/></g></svg></button>
	${state.links.length ? `<button class="icon-btn" id="link-edit" title="${editingLinks ? "Done editing" : "Edit links"}" aria-pressed="${editingLinks}" aria-label="Edit links"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor"><g stroke-width="1.4"><path d="M10.5 2.5l3 3-8 8H2.5v-3z"/></g></svg></button>` : ""}
	${editingLinks ? `<button class="icon-btn" id="link-refresh" title="Look up every site's icon again" aria-label="Refresh icons"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor"><g stroke-width="1.5"><path d="M13 8a5 5 0 1 1-1.6-3.7M13 2.5v2.8h-2.8"/></g></svg></button>` : ""}</span>`;

// Data sources a report can call with wb.fetch (wb source add): names and base URLs, never header values.
const PLUG = `<svg class="doc-ic" viewBox="0 0 16 16" fill="none" stroke="currentColor"><g stroke-width="1.3"><ellipse cx="8" cy="3.75" rx="5" ry="2"/><path d="M3 3.75v8.5c0 1.1 2.24 2 5 2s5-.9 5-2v-8.5M3 8c0 1.1 2.24 2 5 2s5-.9 5-2"/></g></svg>`;
const sourceList = () => state.sources.filter((s) => !state.project || s.project === state.project);
const sourceRow = (s) => `<div class="ritem source" title="${esc(`${s.base_url}\n${s.write ? "read and write" : "read-only (GET)"}${s.header_names.length ? ` · headers: ${s.header_names.join(", ")}` : ""}\nwb.fetch("${s.name}", "/path")`)}">${PLUG}<span>${esc(state.project ? s.name : `${projectName(s.project)} · ${s.name}`)}</span><small>${s.write ? "write" : "read"}</small></div>`;
async function loadLinks() {
	const links = await api("/api/links");
	if (links === state.links) return;
	state.links = links;
	$("#link-groups").innerHTML = [...new Set(state.links.map((l) => l.grp).filter(Boolean))].sort().map((g) => `<option value="${esc(g)}">`).join("");
	redraw();
}
async function loadSources() {
	const sources = await api("/api/sources");
	if (JSON.stringify(sources) === JSON.stringify(state.sources)) return;
	state.sources = sources;
	redraw();
}
async function loadReports() {
	const reports = await api("/api/reports");
	if (reports === state.reports) return;
	state.reports = reports;
	redraw();
	checkNewerReport();
}

const linkDlg = $("#link-dlg");
const linkForm = $("#link-form");
let currentLink = null;
function setOptions(sel, values) { sel.innerHTML = values.map((v) => `<option value="${esc(v.value ?? v)}">${esc(v.label ?? v)}</option>`).join(""); }

function openLink(link) {
	currentLink = link;
	setOptions(linkForm.project, [{ value: "", label: "Every project" }, ...state.projects.map((p) => ({ value: p.slug, label: p.name }))]);
	linkForm.label.value = link.label ?? "";
	linkForm.url.value = link.url ?? "";
	linkForm.project.value = link.project ?? "";
	linkForm.grp.value = link.grp ?? "";
	linkForm.icon_url.value = link.icon_url ?? "";
	$("#link-title").textContent = link.id ? "Edit link" : "New link";
	$("#link-delete").hidden = !link.id;
	$("#link-err").textContent = "";
	linkDlg.showModal();
	linkForm.label.focus();
}

// The tools of the report and link lists (`root`: the element they're drawn in, the Projects page): true when the
// click was one of them. They sit inside a <summary>, so they don't fold the section.
function pageTools(e, root) {
	if (e.target.closest("#report-edit")) { e.preventDefault(); editingReports = !editingReports; redraw(); return true; }
	const mv = e.target.closest("[data-group] [data-move]");
	if (mv) { moveReportGroup(mv.closest("[data-group]").dataset.group, mv.dataset.move, root); return true; }
	if (e.target.closest("#link-new")) { e.preventDefault(); openLink({ project: state.project }); return true; }
	if (e.target.closest("#link-edit")) { e.preventDefault(); editingLinks = !editingLinks; redraw(); return true; }
	if (e.target.closest("#link-refresh")) {
		e.preventDefault();
		api("/api/links/icons/refresh", { method: "POST" }).then((links) => { state.links = links; iconRound++; redraw(); });
		return true;
	}
	const a = e.target.closest("[data-link]");
	if (a && editingLinks) {
		e.preventDefault();
		openLink(state.links.find((l) => l.id === Number(a.dataset.link)));
		return true;
	}
	return false;
}
linkForm.addEventListener("submit", async (e) => {
	e.preventDefault();
	const body = JSON.stringify({
		label: linkForm.label.value, url: linkForm.url.value.trim(), project: linkForm.project.value,
		grp: linkForm.grp.value.trim(), icon_url: linkForm.icon_url.value.trim(),
	});
	try {
		if (currentLink.id) await api(`/api/links/${currentLink.id}`, { method: "PATCH", body });
		else await api("/api/links", { method: "POST", body });
		linkDlg.close();
		iconRound++;
		await loadLinks();
	} catch (err) { $("#link-err").textContent = err.message; }
});
$("#link-delete").onclick = async (e) => {
	if (!(await confirmIn(e.currentTarget, { text: `Delete "${currentLink.label}"?`, yes: "Delete", danger: true }))) return;
	await api(`/api/links/${currentLink.id}`, { method: "DELETE" });
	linkDlg.close();
	await loadLinks();
};
$("#link-cancel").onclick = () => linkDlg.close();
