/* ---------- The nav: one column on the left (a bar at the bottom on a phone) ---------- */

// From the top: the brand, the entries views ask for (defineView's `entry`, router.js), "Projects" with one row per
// project (its logo, name and how many asks wait on Kostas there), a chip for each tracker at warn or worse, and at
// the foot Settings, Usage, Vault and notifications (their markup is index.html's, their clicks the files that own
// them). Between 760 and 1100 px it folds to icons, each with its tooltip. On a phone the bar at the bottom has the
// entries, Projects (a sheet of them) and More (Settings, Usage, Vault, notifications).
// navCount(name, n, state): the count beside a view's entry ("inbox", "agents", …), in a state's colour ("yours",
// "running", "stuck", "failed", "done", or nothing for neutral); 0, "" or null hides it.
const NAV_IC = {
	projects: '<rect x="2.25" y="2.25" width="4.75" height="4.75" rx="1"/><rect x="9" y="2.25" width="4.75" height="4.75" rx="1"/><rect x="2.25" y="9" width="4.75" height="4.75" rx="1"/><rect x="9" y="9" width="4.75" height="4.75" rx="1"/>',
	more: '<circle cx="3.5" cy="8" r=".9"/><circle cx="8" cy="8" r=".9"/><circle cx="12.5" cy="8" r=".9"/>',
	settings: '<path d="M2.5 4.5h6M11.5 4.5h2M2.5 11.5h2M7.5 11.5h6"/><circle cx="10" cy="4.5" r="1.5"/><circle cx="6" cy="11.5" r="1.5"/>',
	usage: '<path d="M2.5 13.5h11M4.5 11V8M8 11V4.5M11.5 11V6.5"/>',
	vault: '<rect x="3" y="7" width="10" height="7" rx="1.5"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"/>',
	bell: '<path d="M4 11V7a4 4 0 0 1 8 0v4l1.5 1.5h-11zM6.5 13.5a1.5 1.5 0 0 0 3 0"/>',
	warn: '<path d="M8 2.25 14.25 13.25H1.75z"/><path d="M8 6.5v3M8 11.4v.1"/>',
};
const navSvg = (d) => `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><g stroke-width="1.5">${d}</g></svg>`;
const navCounts = new Map();
function navCount(name, n, st) {
	navCounts.set(name, { n, st });
	renderNav();
}
// Several at once ([[name, n, state], …]), drawn once.
function navCountMany(list) {
	for (const [name, n, st] of list) navCounts.set(name, { n, st });
	renderNav();
}
// What waits on you in a project (the Inbox's count, inbox.js): the same number in the nav's row, the phone's Projects
// sheet and the project's page.
const navMine = (slug) => navCounts.get(`project:${slug}`)?.n || 0;
const navN = (c) => (c && c.n ? `<i class="nav-n${c.st ? ` st-${c.st}` : ""}">${esc(c.n)}</i>` : "");
const navEntries = () => VIEWS.filter((v) => v.entry).sort((a, b) => (a.entry.order ?? 50) - (b.entry.order ?? 50));
const entryHref = (v) => v.entry.href ?? (v.default ? "#" : `#${v.name}`);

function navEntryRow(v, on) {
	const c = navCounts.get(v.name);
	return `<a class="nav-row" href="${esc(entryHref(v))}" data-nav="${esc(v.name)}" title="${esc(v.entry.label)}${c?.n ? ` · ${esc(c.n)}` : ""}"${on === v.name ? ' aria-current="page"' : ""}>
		<span class="nav-ic">${navSvg(v.entry.icon ?? "")}</span><span class="nav-t">${esc(v.entry.label)}</span>${navN(c)}</a>`;
}
function navProjectRow(p, on) {
	const key = `project:${p.slug}`;
	const c = navCounts.get(key);
	return `<a class="nav-row" href="#project/${encodeURIComponent(p.slug)}" data-nav="${esc(key)}" title="${esc(p.name)}${c?.n ? ` · ${c.n} waiting on you` : ""}"${on === key ? ' aria-current="page"' : ""}>
		<span class="nav-ic">${logo(p)}</span><span class="nav-t">${esc(p.name)}</span>${navN(c)}</a>`;
}
// Trackers at warn or worse, worst first: "Isokratis · Uploads 10/10". One for every project links to the board.
function navWarnings() {
	const lv = { bad: 2, warn: 1 };
	return state.trackers.filter((t) => lv[t.level] && !isArchived(t.project)).sort((a, b) => lv[b.level] - lv[a.level]).map((t) => {
		const ms = t.reading?.meters ?? [];
		const m = ms.find((x) => x.level === t.level) ?? ms[0];
		const reading = !m ? "" : m.value == null ? m.text ?? "" : `${withUnit(m.value, m.unit)}${m.max != null ? `/${withUnit(m.max, m.unit)}` : ""}`;
		const what = [t.project ? projectName(t.project) : t.title, ms.length > 1 && m?.label ? m.label : t.project ? t.title : ""].filter(Boolean).join(" · ");
		const text = `${what}${reading ? ` ${reading}` : ""}`;
		return `<a class="nav-warn st-${t.level === "bad" ? "failed" : "stuck"}" href="${t.project ? `#project/${encodeURIComponent(t.project)}` : "#"}" title="${esc(trkTip(t))}">
			<span class="nav-ic">${navSvg(NAV_IC.warn)}</span><span class="nav-t">${esc(text)}</span></a>`;
	}).join("");
}

function renderNav() {
	const on = currentNav();
	paint($("#nav-entries"), navEntries().map((v) => navEntryRow(v, on)).join(""));
	paint($("#nav-projects"), state.projects.map((p) => navProjectRow(p, on)).join("") || `<div class="nav-none">No projects yet</div>`);
	paint($("#nav-warn"), navWarnings());
	for (const b of document.querySelectorAll("#nav .nav-foot [data-nav]")) {
		if (b.dataset.nav === on) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current");
	}
	const foot = ["settings", "vault", "usage"].includes(on);
	const tab = (attrs, icon, label, current, n = "") => `<${attrs.startsWith("href") ? "a" : "button type=\"button\""} class="tab" ${attrs}${current ? ' aria-current="page"' : ""}>
		<span class="nav-ic">${icon}</span><span class="nav-t">${esc(label)}</span>${n}</${attrs.startsWith("href") ? "a" : "button"}>`;
	const mine = state.projects.reduce((n, p) => n + navMine(p.slug), 0);
	paint($("#tabbar"), navEntries().map((v) => tab(`href="${esc(entryHref(v))}"`, navSvg(v.entry.icon ?? ""), v.entry.label, on === v.name, navN(navCounts.get(v.name)))).join("")
		+ tab('data-sheet="projects"', navSvg(NAV_IC.projects), "Projects", on?.startsWith("project:"), navN(mine ? { n: mine, st: "yours" } : null))
		+ tab('data-sheet="more"', navSvg(NAV_IC.more), "More", foot));
	if (navSheet.open) navSheetFill(navSheet.dataset.what);
}
// The older name, from when the projects were a strip.
const renderProjects = () => renderNav();

/* The phone's sheets: Projects and More. */
const navSheet = document.createElement("dialog");
navSheet.id = "nav-sheet";
navSheet.className = "nav-sheet";
document.body.append(navSheet);
function navSheetFill(what) {
	const on = currentNav();
	const row = (attrs, icon, label) => `<${attrs.startsWith("href") ? "a" : "button type=\"button\""} class="nav-row" ${attrs}><span class="nav-ic">${icon}</span><span class="nav-t">${esc(label)}</span></${attrs.startsWith("href") ? "a" : "button"}>`;
	const body = what === "projects"
		? `<div class="nav-label">Projects</div><div class="nav-list">${state.projects.map((p) => navProjectRow(p, on)).join("")}</div>${navWarnings()}`
		: `<div class="nav-list">${row('href="#settings"', navSvg(NAV_IC.settings), "Settings")}${row('data-more="usage"', navSvg(NAV_IC.usage), "Usage")}
			${row('data-more="vault"', navSvg(NAV_IC.vault), "Vault")}${$("#notify").hidden ? "" : row('data-more="notify"', navSvg(NAV_IC.bell), notifyOn() ? "Notifications: on" : "Notifications: off")}</div>`;
	navSheet.dataset.what = what;
	paint(navSheet, `<div class="nav-sheet-in">${body}</div>`);
}
$("#tabbar").addEventListener("click", (e) => {
	const b = e.target.closest("[data-sheet]");
	if (!b) return;
	navSheetFill(b.dataset.sheet);
	navSheet.showModal();
});
navSheet.addEventListener("click", (e) => {
	if (e.target === navSheet) return navSheet.close();
	const more = e.target.closest("[data-more]")?.dataset.more;
	if (more) $(`#${more === "usage" ? "usage-btn" : more === "vault" ? "vault-btn" : "notify"}`).click();
	if (more || e.target.closest("a")) navSheet.close();
});
