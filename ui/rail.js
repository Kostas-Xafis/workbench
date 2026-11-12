/* ---------- Rail: reports and links ---------- */

// Links with project '' show everywhere; a project's own links show with it (and under All).
let editingLinks = false;
let editingReports = false;
function railLinks() {
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
const inRail = (r) => state.project ? r.project === state.project : !isArchived(r.project);
function reportOrder(slug) {
	try { return JSON.parse(state.allProjects.find((p) => p.slug === slug)?.report_order || "[]"); } catch { return []; }
}
// A project's report groups as { label, grp, project, reports }: in the order set for them (the rest after those, by
// name), reports without a group last. Under "All", project by project. Archived day pages aren't in here.
function railReports() {
	const groups = new Map();
	for (const r of state.reports) {
		if (!inRail(r) || r.archived) continue;
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
const archivedDays = () => state.reports.filter((r) => r.archived && inRail(r)).sort((a, b) => b.name.localeCompare(a.name));
async function moveReportGroup(grp, dir) {
	const order = railReports().filter((g) => g.grp).map((g) => g.grp);
	const i = order.indexOf(grp), j = i + (dir === "up" ? -1 : 1);
	if (i < 0 || j < 0 || j >= order.length) return;
	[order[i], order[j]] = [order[j], order[i]];
	try {
		const { groups } = await api(`/api/projects/${encodeURIComponent(state.project)}/report-order`, { method: "PUT", body: JSON.stringify({ groups: order }) });
		state.allProjects.find((p) => p.slug === state.project).report_order = JSON.stringify(groups);
		renderRail();
		// Keep the keyboard on the heading that moved, on the other arrow once it reaches an end.
		const head = $(`#rail [data-group="${CSS.escape(grp)}"]`);
		const btn = head?.querySelector(`[data-move="${dir}"]`);
		(btn && !btn.disabled ? btn : head?.querySelector(`[data-move="${dir === "up" ? "down" : "up"}"]`))?.focus();
	} catch (err) { toast(err.message); }
}
const isDay = (r) => /^day-\d{4}-\d{2}-\d{2}$/.test(r.name);
// Each report group shows this many; the rest fold away (in the folded rail they're left out).
const GROUP_SHOWN = 2;
// A day page's tile is its day of the month; other reports get their initials.
const tileText = (r) => isDay(r) ? String(Number(r.name.slice(-2))) : initials(r.title);
// A report's own icon, if it has one: an emoji, or an SVG drawn as a picture so nothing in it can run (see db.ts).
function reportMark(r) {
	if (!r.icon) return "";
	return r.icon.startsWith("<") ? `<img class="rep-ic" alt="" src="data:image/svg+xml,${encodeURIComponent(r.icon)}">` : `<span class="rep-ic">${esc(r.icon)}</span>`;
}
const reportHref = (r) => `#report/${r.id}`;
const isCurrent = (r) => state.report?.id === r.id;

function renderRail() {
	document.body.classList.toggle("rail-collapsed", state.collapsed);
	const toggle = `<button class="icon-btn" id="rail-toggle" title="${state.collapsed ? "Show reports and links" : "Fold the sidebar"}" aria-label="Toggle sidebar">
		<svg viewBox="0 0 16 16" fill="none" stroke="currentColor"><g stroke-width="1.5">${state.collapsed ? '<path d="m6 4 4 4-4 4"/>' : '<path d="m10 4-4 4 4 4"/>'}</g></svg></button>`;
	const reports = railReports();
	const links = railLinks();
	let html;
	if (state.collapsed) {
		html = `<div class="rail-head">${toggle}</div>` + railTrackers(true) + hookHtml(hooks.rail, true) +
			// The first few of each group, and the report on screen if it's further down.
			[...reports.flatMap((g) => g.reports.filter((r, i) => i < GROUP_SHOWN || isCurrent(r))), ...archivedDays().filter(isCurrent)]
				.map((r) => `<a class="ritem" href="${reportHref(r)}" title="${esc(r.title)}" aria-current="${isCurrent(r)}"><span class="tile">${reportMark(r) || esc(tileText(r))}</span></a>`).join("") +
			(reports.length && links.length ? `<div class="rail-sep"></div>` : "") +
			links.flatMap((g) => g.links).map((l) => `<a class="ritem link" href="${esc(l.url)}" target="_blank" rel="noreferrer" data-link="${l.id}" title="${esc(l.label)}">${fav(l)}</a>`).join("");
	} else {
		const nReports = reports.reduce((n, g) => n + g.reports.length, 0);
		const ritem = (r) => `<a class="ritem" href="${reportHref(r)}" title="${esc(r.title)} · v${r.version}" aria-current="${isCurrent(r)}">${reportMark(r) || DOC}<span>${esc(r.title)}</span><small>${esc(ago(r.updated_at).replace(" ago", ""))}</small></a>`;
		// Each group shows its first few (a Days group its newest days); the rest fold away, and the fold opens
		// by itself when the report on screen is in it.
		// With the pencil on, a project's group headings get arrows to move them.
		const named = reports.filter((g) => g.grp);
		const canMove = !!state.project && named.length > 1;
		const moving = canMove && editingReports;
		const moveBtn = (g, dir, off) => `<button type="button" class="icon-btn" data-move="${dir}" title="Move ${dir}" aria-label="Move ${esc(g.grp)} ${dir}"${off ? " disabled" : ""}>${svg16(dir === "up" ? '<path d="m4.5 10 3.5-3.5 3.5 3.5"/>' : '<path d="m4.5 6 3.5 3.5 3.5-3.5"/>')}</button>`;
		const heading = (g) => {
			if (!g.label) return "";
			if (!moving || !g.grp) return `<div class="glabel">${esc(g.label)}</div>`;
			const i = named.indexOf(g);
			return `<div class="glabel moving" data-group="${esc(g.grp)}"><span>${esc(g.label)}</span>${moveBtn(g, "up", !i)}${moveBtn(g, "down", i === named.length - 1)}</div>`;
		};
		const reportList = reports.map((g) => {
			const rs = g.reports, label = g.label;
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
		const reportTools = canMove ? `<span class="tools"><button class="icon-btn" id="report-edit" title="${moving ? "Done moving groups" : "Move groups"}" aria-pressed="${moving}" aria-label="Move report groups"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor"><g stroke-width="1.4"><path d="M10.5 2.5l3 3-8 8H2.5v-3z"/></g></svg></button></span>` : "";
		const linkList = links.map((g) => {
			const items = g.links.map((l) => `<a class="ritem link" href="${esc(l.url)}" target="_blank" rel="noreferrer" data-link="${l.id}" title="${esc(l.url)}">${fav(l)}<span>${esc(l.label)}</span></a>`).join("");
			return g.label ? `<details class="lgroup fold" data-key="${esc(g.key)}"${isOpen(g.key, true)}><summary><span>${esc(g.label)}</span></summary>${items}</details>` : items;
		}).join("");
		const tools = `<span class="tools">
			<button class="icon-btn" id="link-new" title="Add a link" aria-label="Add a link"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor"><g stroke-width="1.6"><path d="M8 3v10M3 8h10"/></g></svg></button>
			${state.links.length ? `<button class="icon-btn" id="link-edit" title="${editingLinks ? "Done editing" : "Edit links"}" aria-pressed="${editingLinks}" aria-label="Edit links"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor"><g stroke-width="1.4"><path d="M10.5 2.5l3 3-8 8H2.5v-3z"/></g></svg></button>` : ""}
			${editingLinks ? `<button class="icon-btn" id="link-refresh" title="Look up every site's icon again" aria-label="Refresh icons"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor"><g stroke-width="1.5"><path d="M13 8a5 5 0 1 1-1.6-3.7M13 2.5v2.8h-2.8"/></g></svg></button>` : ""}</span>`;
		const trkNew = `<button class="icon-btn" id="trk-new" title="Add a status tracker" aria-label="Add a status tracker">${TRK_ADD}</button>`;
		html = `<div class="rail-head"><b>${esc(state.project ? projectName(state.project) : "All projects")}</b>${trkNew}${toggle}</div>
			${railTrackers(false)}${hookHtml(hooks.rail, false)}
			<details class="rsec fold" data-key="rail-reports"${isOpen("rail-reports", true)}><summary>Reports <span class="count">${nReports || ""}</span>${reportTools}</summary>
				${reportList + archive || `<div class="rail-empty">None yet. Agents publish pages here, such as a status, a plan or release notes (<code>wb report page.html</code>), and each day with activity gets a page of what moved.</div>`}</details>
			<details class="rsec fold" data-key="rail-links"${isOpen("rail-links", true)}><summary>Links ${tools}</summary>
				${linkList || `<div class="rail-empty">No links${state.project ? " for this project" : ""}.</div>`}</details>` +
			railSources();
	}
	const rail = $("#rail");
	paint(rail, html);
	rail.classList.toggle("editing", editingLinks);
	// A refresh replaces the ring under the pointer: keep its card up to date, or put it away.
	if (popFor != null) {
		const b = state.collapsed && rail.querySelector(`.trk-mini[data-tracker="${popFor}"]`);
		if (b && b.matches(":hover, :focus-visible")) showTrkPop(b); else hideTrkPop(true);
	}
	$("#link-groups").innerHTML = [...new Set(state.links.map((l) => l.grp).filter(Boolean))].sort().map((g) => `<option value="${esc(g)}">`).join("");
}

// Data sources a report can call with wb.fetch (wb source add): names and base URLs, never header values.
const PLUG = `<svg class="doc-ic" viewBox="0 0 16 16" fill="none" stroke="currentColor"><g stroke-width="1.3"><ellipse cx="8" cy="3.75" rx="5" ry="2"/><path d="M3 3.75v8.5c0 1.1 2.24 2 5 2s5-.9 5-2v-8.5M3 8c0 1.1 2.24 2 5 2s5-.9 5-2"/></g></svg>`;
function railSources() {
	const list = state.sources.filter((s) => !state.project || s.project === state.project);
	if (!list.length) return "";
	const row = (s) => `<div class="ritem source" title="${esc(`${s.base_url}\n${s.write ? "read and write" : "read-only (GET)"}${s.header_names.length ? ` · headers: ${s.header_names.join(", ")}` : ""}\nwb.fetch("${s.name}", "/path")`)}">${PLUG}<span>${esc(state.project ? s.name : `${projectName(s.project)} · ${s.name}`)}</span><small>${s.write ? "write" : "read"}</small></div>`;
	return `<details class="rsec fold" data-key="rail-sources"${isOpen("rail-sources", false)}><summary>Data sources <span class="count">${list.length}</span></summary>${list.map(row).join("")}</details>`;
}

function setCollapsed(c) {
	state.collapsed = c;
	if (!narrow()) localSet("rail", c ? "collapsed" : "open");
	renderRail();
}
$("#rail-open").onclick = () => setCollapsed(!state.collapsed);

async function loadLinks() {
	state.links = await api("/api/links");
	renderRail();
}
async function loadSources() {
	const sources = await api("/api/sources");
	if (JSON.stringify(sources) === JSON.stringify(state.sources)) return;
	state.sources = sources;
	renderRail();
}
async function loadReports() {
	state.reports = await api("/api/reports");
	renderRail();
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

$("#rail").addEventListener("click", (e) => {
	if (e.target.closest("#rail-toggle")) return setCollapsed(!state.collapsed);
	if (e.target.closest("#trk-new")) return editTracker({ project: state.project });
	const tb = e.target.closest("[data-tracker]");
	if (tb) { hideTrkPop(true); return openTracker(Number(tb.dataset.tracker)); }
	// The tools sit inside a <summary>: don't fold the section.
	if (e.target.closest("#report-edit")) { e.preventDefault(); editingReports = !editingReports; return renderRail(); }
	const mv = e.target.closest("[data-move]");
	if (mv) return moveReportGroup(mv.closest("[data-group]").dataset.group, mv.dataset.move);
	if (e.target.closest("#link-new")) { e.preventDefault(); return openLink({ project: state.project }); }
	if (e.target.closest("#link-edit")) { e.preventDefault(); editingLinks = !editingLinks; return renderRail(); }
	if (e.target.closest("#link-refresh")) {
		e.preventDefault();
		return api("/api/links/icons/refresh", { method: "POST" }).then((links) => { state.links = links; iconRound++; renderRail(); });
	}
	const a = e.target.closest("[data-link]");
	if (a && editingLinks) {
		e.preventDefault();
		openLink(state.links.find((l) => l.id === Number(a.dataset.link)));
	}
	// On a phone the rail covers the page; picking a report closes it.
	if (e.target.closest('a[href^="#report/"]') && narrow()) setCollapsed(true);
});
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
$("#link-delete").onclick = async () => {
	if (!confirm(`Delete "${currentLink.label}"?`)) return;
	await api(`/api/links/${currentLink.id}`, { method: "DELETE" });
	linkDlg.close();
	await loadLinks();
};
$("#link-cancel").onclick = () => linkDlg.close();
