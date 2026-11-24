/* ---------- Reports ---------- */

const frame = $("#r-frame");

function showView(name) {
	for (const [id, v] of [["#board", "board"], ["#report-view", "report"], ["#vault-view", "vault"], ["#settings-view", "settings"], ["#welcome-view", "welcome"],
		...views.map((x) => [x.el, x.name])]) $(id).hidden = v !== name;
	$("#vault-btn").setAttribute("aria-pressed", name === "vault");
	renderProjects();
	if (name !== "vault") lockVault();
	if (name !== "report") {
		state.report = null;
		frame.removeAttribute("src");
		delete frame.dataset.src;
	}
}

function route() {
	const m = location.hash.match(/^#report\/(\d+)(?:\/v(\d+))?$/);
	if (m) return showReport(Number(m[1]), m[2] ? Number(m[2]) : null);
	const own = views.find((x) => x.match(location.hash));
	if (own) {
		showView(own.name);
		document.title = own.title ?? "Workbench";
		renderRail();
		return own.open?.(location.hash);
	}
	const view = location.hash === "#vault" ? "vault" : inSettings() ? "settings" : inWelcome() ? "welcome" : "board";
	showView(view);
	document.title = { vault: "Vault · Workbench", settings: "Settings · Workbench", welcome: "Set up · Workbench", board: "Workbench" }[view];
	renderRail();
	if (view === "vault") openVault();
	if (view === "settings") openSettings(location.hash.split("/")[1]);
	if (view === "welcome") openWelcome(location.hash.split("/")[1]);
}

async function showReport(id, v) {
	let r;
	try { r = await api(`/api/reports/${id}`); } catch { history.replaceState(null, "", location.pathname + location.search); return route(); }
	state.report = r;
	state.reportV = v;
	showView("report");
	const shown = v ?? r.version;
	$("#r-title").textContent = r.title;
	$("#r-sub").textContent = `${projectName(r.project)} · updated ${ago(r.updated_at)}`;
	setOptions($("#r-version"), r.versions.map((x) => ({ value: x.n, label: `v${x.n} · ${ago(x.at)}${x.author ? ` · ${x.author}` : ""}${x.n === r.version ? " (latest)" : ""}` })));
	$("#r-version").value = shown;
	$("#r-version").hidden = r.versions.length < 2;
	$("#r-newer").hidden = true;
	const hash = `#report/${id}${v ? `/v${v}` : ""}`;
	$("#r-newtab").href = `/?solo${hash}`;
	$("#r-home").href = `/${hash}`;
	const src = withFrameTheme(`/r/${id}${v ? `?v=${v}` : ""}`);
	if (frame.dataset.src !== src) { frame.dataset.src = src; frame.src = src; }
	frame.dataset.version = shown;
	document.title = `${r.title} · Workbench`;
	renderRail();
	refreshShares();
}

// A newer version is offered, not loaded, so whatever is open in the page isn't thrown away.
function checkNewerReport() {
	if (!state.report || state.reportV) return;
	const r = state.reports.find((x) => x.id === state.report.id);
	if (!r || r.version <= Number(frame.dataset.version)) return;
	$("#r-newer").textContent = `v${r.version} is out · show`;
	$("#r-newer").hidden = false;
}
$("#r-newer").onclick = () => { delete frame.dataset.src; showReport(state.report.id, null); };
$("#r-reload").onclick = () => { frame.src = frame.dataset.src; };
function goBoard() {
	history.pushState(null, "", location.pathname + location.search);
	route();
}
$("#r-back").onclick = goBoard;
$("#r-version").onchange = (e) => {
	const n = Number(e.target.value);
	location.hash = `#report/${state.report.id}${n === state.report.version ? "" : `/v${n}`}`;
};
window.addEventListener("hashchange", route);

// The page runs sandboxed (origin "null") and asks the board through postMessage. Read-only by design:
// nothing here changes the board, except opening an item's dialog for Kostas to act on, and the page's
// own saved state (stateGet/Set/Clear), which is always that of the report shown in the frame.
const bridge = {
	items(f = {}) {
		const p = new URLSearchParams();
		const project = f.project === "*" ? "" : f.project ?? state.report.project;
		if (project) p.set("project", project);
		const status = f.status === "open" ? OPEN : f.status;
		if (status) p.set("status", [].concat(status).join(","));
		for (const k of ["kind", "owner", "q"]) if (f[k]) p.set(k, f[k]);
		return api(`/api/items?${p}`);
	},
	item: (ref) => api(`/api/items/${encodeURIComponent(ref)}`),
	async git(project) {
		const [r] = await api(`/api/git?project=${encodeURIComponent(project ?? state.report.project)}`);
		return r ?? null;
	},
	async links(project = state.report.project) {
		const links = await api("/api/links");
		return project === "*" ? links : links.filter((l) => !l.project || l.project === project);
	},
	projects: () => api("/api/projects"),
	reports: (project = state.report.project) => api(`/api/reports${project === "*" ? "" : `?project=${encodeURIComponent(project)}`}`),
	// This project's status trackers and the global ones ("*": every tracker).
	trackers: (project = state.report.project) => api(`/api/trackers${project === "*" ? "" : `?project=${encodeURIComponent(project)}`}`),
	async open(ref) { await openItemById(ref); return true; },
	stateGet: () => api(`/api/reports/${state.report.id}/state`),
	async stateSet(json) {
		if (typeof json !== "string") throw new Error("wb.state.set takes an object");
		await api(`/api/reports/${state.report.id}/state`, { method: "PUT", body: json });
		return true;
	},
	async stateClear() { await api(`/api/reports/${state.report.id}/state`, { method: "DELETE" }); return true; },
	// A data source of the report's project, called by the server with the source's headers (see sources.ts).
	// Always answers a value: { ok, status, json | text } or { ok: false, status: 0, error }.
	async fetch(name, path, opts) {
		const res = await fetch(`/api/reports/${state.report.id}/fetch`, {
			method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, path, opts }),
		});
		return res.json().catch(() => ({ ok: false, status: 0, error: `the board answered ${res.status}` }));
	},
};
// Calls made as the report in the frame: only for the one the board loaded there, whatever the page claims.
const STATE_METHODS = ["stateGet", "stateSet", "stateClear", "fetch"];
window.addEventListener("message", async (e) => {
	const m = e.data;
	if (e.source === frame.contentWindow && e.origin === "null" && m?.wb === 1 && m.event === "zoom") return appZoom(m.step);
	if (e.source !== frame.contentWindow || e.origin !== "null" || !m || m.wb !== 1 || !Object.hasOwn(bridge, m.method)) return;
	// State only for the report the frame was pointed at: the page names itself, and must be the one loaded.
	if (STATE_METHODS.includes(m.method) && !(state.report && m.report === state.report.id
		&& new URL(frame.dataset.src ?? "", location.href).pathname === `/r/${state.report.id}`)) {
		return e.source.postMessage({ wb: 1, id: m.id, error: m.method === "fetch" ? "not the report the board loaded" : "not this report's state" }, "*");
	}
	try { e.source.postMessage({ wb: 1, id: m.id, result: await bridge[m.method](...(m.args || [])) }, "*"); }
	catch (err) { e.source.postMessage({ wb: 1, id: m.id, error: err.message }, "*"); }
});
