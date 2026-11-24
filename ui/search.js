/* ---------- Search ---------- */

const search = $("#search");
const results = $("#results");
let searchSeq = 0, searchTimer;

async function runSearch() {
	const q = search.value.trim();
	if (!q) { results.hidden = true; return; }
	const seq = ++searchSeq;
	const data = await api(`/api/search?q=${encodeURIComponent(q)}${state.project ? `&project=${encodeURIComponent(state.project)}` : ""}`);
	if (seq !== searchSeq) return;
	const where = (slug) => !state.project && slug ? ` · ${esc(projectName(slug))}` : "";
	let html = "";
	if (data.items.length) html += `<div class="rgroup">Items</div>` + data.items.map((i) =>
		`<button class="res" data-item="${i.id}">${kindIcon(i.kind)}<span class="rt"><div>${hl(i.title, q)}</div>
		<small>wb-${hl(i.ref, q)} · ${i.kind} · ${i.status} · ${i.owner === "kostas" ? "you" : "agent"}${where(i.project)}</small></span></button>`).join("");
	if (data.goals?.length) html += `<div class="rgroup">Goals</div>` + data.goals.map((g) =>
		`<button class="res" data-goal="${g.id}"><span class="kic" style="--k:var(--accent)">${glyph("goal")}</span><span class="rt"><div>${hl(g.title, q)}</div>
		<small>goal${g.status === "open" ? "" : ` · ${g.status}`}${g.due ? ` · ${esc(g.due)}` : ""}${where(g.project)}</small></span></button>`).join("");
	if (data.reports.length) html += `<div class="rgroup">Reports</div>` + data.reports.map((r) =>
		`<a class="res" href="${reportHref(r)}">${reportMark(r) || DOC}<span class="rt"><div>${hl(r.title, q)}</div><small>${r.snippet ? hl(r.snippet, q) : `v${r.version} · ${ago(r.updated_at)}`}${where(r.project)}</small></span></a>`).join("");
	if (data.links.length) html += `<div class="rgroup">Links</div>` + data.links.map((l) =>
		`<a class="res" href="${esc(l.url)}" target="_blank" rel="noreferrer">${fav(l)}<span class="rt"><div>${hl(l.label, q)}</div><small>${hl(l.url, q)}</small></span></a>`).join("");
	html += hookHtml(hooks.searchResults, data, q);
	results.innerHTML = (html || `<div class="res-none">Nothing matches “${esc(q)}”.</div>`) +
		`<div class="res-foot">${state.project ? `In ${esc(projectName(state.project))} · pick All projects to search everywhere` : "In all projects"} · ↑↓ to move, Enter to open</div>`;
	results.hidden = false;
	select(0);
}
function select(n) {
	const all = [...results.querySelectorAll(".res")];
	all.forEach((el, i) => el.setAttribute("aria-selected", i === n));
	all[n]?.scrollIntoView({ block: "nearest" });
}
function closeSearch() { results.hidden = true; }
search.addEventListener("input", () => { clearTimeout(searchTimer); searchTimer = setTimeout(runSearch, 150); });
search.addEventListener("focus", () => { if (search.value.trim()) runSearch(); });
search.addEventListener("keydown", (e) => {
	const all = [...results.querySelectorAll(".res")];
	const at = all.findIndex((el) => el.getAttribute("aria-selected") === "true");
	if (e.key === "ArrowDown" || e.key === "ArrowUp") {
		e.preventDefault();
		if (all.length) select((at + (e.key === "ArrowDown" ? 1 : -1) + all.length) % all.length);
	} else if (e.key === "Enter" && all[at]) {
		e.preventDefault();
		all[at].click();
	} else if (e.key === "Escape") {
		if (!results.hidden) closeSearch(); else { search.value = ""; search.blur(); }
	}
});
results.addEventListener("click", async (e) => {
	const r = e.target.closest(".res");
	if (!r) return;
	closeSearch();
	if (r.dataset.item) openItemById(r.dataset.item, { list: [...results.querySelectorAll("[data-item]")].map((e) => e.dataset.item) }).catch((err) => toast(err.message));
	if (r.dataset.goal) showGoal(Number(r.dataset.goal));
});
document.addEventListener("pointerdown", (e) => { if (!e.target.closest(".search-wrap")) closeSearch(); });
document.addEventListener("keydown", (e) => {
	const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName) || document.querySelector("dialog[open]");
	if (((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") || (e.key === "/" && !typing)) {
		e.preventDefault();
		search.focus();
		search.select();
	}
});
