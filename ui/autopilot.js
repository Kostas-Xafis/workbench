/* ---------- Autopilot: a project's Next up starts by itself when a slot is free (autopilot.ts) ---------- */
// A switch in each project's header (project.js asks autopilotHtml), with one line on why it starts nothing now; one
// line on the Agents place naming the projects it's on for; its guard rails in Settings → Agents → Limits
// (dispatch.js asks autopilotRows). GET /api/autopilot has every project it's on for, with why it holds; PUT
// /api/projects/:slug/autopilot turns it on or off. The switch itself is the project's `autopilot` (GET /api/projects).

const ap = { list: [], busy: new Set() };
const apOn = (slug) => !!state.allProjects?.find((p) => p.slug === slug)?.autopilot;
const apState = (slug) => ap.list.find((x) => x.slug === slug);

async function apLoad() {
	try {
		const list = await api("/api/autopilot");
		if (JSON.stringify(list) === JSON.stringify(ap.list)) return;
		ap.list = list;
		redraw();
	} catch {}
}
hooks.start.push(apLoad);
hooks.refresh.push(apLoad);

/** The project page's switch and its one line: off, on and what it does, or why it's paused. */
function autopilotHtml(slug) {
	const on = apOn(slug), s = apState(slug);
	const tip = "Autopilot: when a slot is free, the board starts the first item of Next up an agent can run, one at a time, within Settings → Agents.";
	let line = "";
	if (on && s?.run) line = `<a href="#item/wb-${esc(s.run.ref)}">wb-${esc(s.run.ref)}</a> running`;
	else if (on && s?.why) line = esc(s.why);
	else if (on) line = "starts the next item when a slot is free";
	return `<div class="pj-auto${on ? " on" : ""}${on && s?.why ? " held" : ""}" title="${esc(tip)}">
		<label class="pj-auto-sw"><span class="switch sm"><input type="checkbox" role="switch" data-autopilot="${esc(slug)}"${on ? " checked" : ""}${ap.busy.has(slug) ? " disabled" : ""}><span></span></span>
		<span class="pj-auto-t">Autopilot</span></label>${line ? `<span class="pj-auto-why">${line}</span>` : ""}</div>`;
}

async function autopilotSet(slug, on) {
	ap.busy.add(slug);
	redraw();
	try {
		const res = await api(`/api/projects/${encodeURIComponent(slug)}/autopilot`, { method: "PUT", body: JSON.stringify({ on }) });
		const p = state.allProjects.find((x) => x.slug === slug);
		if (p) p.autopilot = on ? 1 : 0;
		ap.list = ap.list.filter((x) => x.slug !== slug).concat(on ? [res.autopilot] : []);
		toast(on ? (res.autopilot?.run ? "Autopilot on: an agent is on the next item" : "Autopilot on") : "Autopilot off");
	} catch (e) {
		toast(e.message);
	}
	ap.busy.delete(slug);
	await Promise.all([loadProjects(), typeof runsLoad === "function" ? runsLoad() : null, loadItems()]);
	redraw();
}
document.addEventListener("change", (e) => {
	const t = e.target.closest?.("[data-autopilot]");
	if (t) autopilotSet(t.dataset.autopilot, t.checked);
});

/* The Agents place: one line under its header, the projects it's on for. */
function apAgentsLine() {
	const head = document.querySelector("#agents-view .ag-head");
	if (!head) return;
	let el = head.parentElement.querySelector(".ag-autopilot");
	const on = (state.allProjects ?? []).filter((p) => p.autopilot && !p.archived_at);
	if (!on.length) { el?.remove(); return; }
	if (!el) { el = document.createElement("p"); el.className = "ag-autopilot"; head.after(el); }
	const whys = new Set(on.map((p) => apState(p.slug)?.why ?? ""));
	const same = whys.size === 1 ? [...whys][0] : "";
	const names = on.map((p) => {
		const s = apState(p.slug);
		return `<a href="#project/${encodeURIComponent(p.slug)}" title="${esc(s?.run ? `wb-${s.run.ref} running` : s?.why || "Starts the next item when a slot is free")}">${esc(p.name)}</a>`;
	}).join(", ");
	const html = `<span>Autopilot:</span> ${names}${same ? ` · ${esc(same)}` : ""}`;
	if (el._html !== html) { el.innerHTML = html; el._html = html; }
}
hooks.redraw.push(apAgentsLine);

/* Settings → Agents → Limits: when it may start agents, and which trackers pause it. */
const AP_HOURS = [["", "Any time"], ["22:00-08:00", "At night, 22:00–08:00"], ["20:00-08:00", "Evenings and night, 20:00–08:00"], ["00:00-07:00", "After midnight, 00:00–07:00"], ["09:00-18:00", "Working hours, 09:00–18:00"]];
function autopilotRows(off) {
	const h = setting("agents.autopilot-hours") ?? "";
	const hours = AP_HOURS.some(([v]) => v === h) ? AP_HOURS : [...AP_HOURS, [h, h.replace("-", "–")]];
	const on = (state.allProjects ?? []).filter((p) => p.autopilot && !p.archived_at).map((p) => p.name);
	const which = on.length ? ` On for ${esc(on.join(", "))}.` : " It's off for every project: turn it on in a project's header.";
	return [
		optRow({ label: "Autopilot starts agents", hint: `A project's <b>Autopilot</b> switch starts the first item of its Next up when a slot is free, one at a time, within the limits above.${which}`, bind: { setting: "agents.autopilot-hours" }, control: ctlSelect({ setting: "agents.autopilot-hours" }, hours, { label: "When autopilot starts agents" }), off }),
		optRow({ label: "Autopilot pauses when a tracker is", hint: "A tracker of the project, or one for the whole board, such as your plan's usage. A tracker that couldn't read doesn't count.", bind: { setting: "agents.autopilot-trackers" }, control: ctlSelect({ setting: "agents.autopilot-trackers" }, [["bad", "Bad (red)"], ["warn", "Warn or bad"], ["off", "Never: trackers don't pause it"]], { label: "Autopilot pauses when a tracker is at" }), off }),
	];
}
// Hours are at this device's clock: its time zone goes with them, so the cloud board counts them the same way.
onSettingsChange((key) => {
	if (key !== "agents.autopilot-hours") return;
	let zone = "";
	try { zone = Intl.DateTimeFormat().resolvedOptions().timeZone || ""; } catch {}
	if (zone && setting("agents.autopilot-zone") !== zone)
		api("/api/settings", { method: "PATCH", body: JSON.stringify({ "agents.autopilot-zone": zone }) }).then((s) => { state.settings = s; }).catch(() => {});
	apLoad();
});
/* ---------- end: Autopilot ---------- */
