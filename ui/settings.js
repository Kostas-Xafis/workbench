/* ---------- Settings ---------- */

// The whole workbench's settings (#settings/<tab>). Two kinds of setting, and each row says which:
// - board: kept in the workbench's database (settings.ts), the same in every browser and for the CLI and agents.
//   Read with setting(key), changed with saveSetting(key, value); they change only from this computer.
// - browser: kept in this browser (localStorage), so a phone and a laptop can differ. pref(key, default), setPref.
// Tabs marked `local` need the board on this computer (localhost); the others work from the phone too.
const settings = { tab: "projects", projects: null, folders: [], health: null, checking: false, checkedAt: 0, error: "" };
state.settings = {};
state.settingDefs = {};
const inSettings = () => location.hash === "#settings" || location.hash.startsWith("#settings/");
const setting = (key) => state.settings[key] ?? state.settingDefs[key]?.default;
// pref(key, def) is in core.js: `state` needs it while it's built.
// Code that depends on a setting registers here; it runs with the key that changed, or undefined after a load.
const settingsHooks = [];
const onSettingsChange = (fn) => settingsHooks.push(fn);
function runSettingsHooks(key) {
	for (const fn of settingsHooks) try { fn(key); } catch (e) { console.error(e); }
}
async function loadSettings() {
	try {
		const [values, defs] = await Promise.all([api("/api/settings"), Object.keys(state.settingDefs).length ? state.settingDefs : api("/api/settings/defs")]);
		const changed = JSON.stringify(values) !== JSON.stringify(state.settings);
		state.settingDefs = defs;
		state.settings = values;
		if (changed) { runSettingsHooks(); renderSettings(); }
	} catch {}
}
async function saveSetting(key, value) {
	const before = state.settings;
	state.settings = { ...before, [key]: value ?? state.settingDefs[key]?.default };
	try {
		state.settings = await api("/api/settings", { method: "PATCH", body: JSON.stringify({ [key]: value }) });
		toast(value === null ? "Back to the default" : "Saved");
	} catch (e) {
		state.settings = before;
		toast(e.message);
		// The page's HTML is the same as before the edit, so force a redraw: the field shows the saved value again.
		$("#settings-view")._html = null;
	}
	runSettingsHooks(key);
	renderSettings();
}
function setPref(key, value) {
	if (value === undefined || value === null) { try { localStorage.removeItem(`wb.pref.${key}`); } catch {} }
	else localSet(`pref.${key}`, JSON.stringify(value));
	runSettingsHooks(key);
	renderSettings();
}

// Option rows. `bind` is { setting: key } or { pref: key, def }; it names what the control saves, labels the row
// "This board" or "This browser", and offers "Default" when the value isn't the default.
const SCOPE = {
	board: ["This board", "Saved in the workbench: the same in every browser, and for the CLI and agents"],
	browser: app ? ["This app", "Saved in this app only, apart from your browsers and your phone"] : ["This browser", "Saved in this browser only, so your phone and laptop can differ"],
};
const bindAttr = (b) => (b.setting ? `data-setting="${esc(b.setting)}"` : `data-pref="${esc(b.pref)}"`);
const bindValue = (b) => (b.setting ? setting(b.setting) : pref(b.pref, b.def));
const bindDefault = (b) => (b.setting ? state.settingDefs[b.setting]?.default : b.def);
function optRow({ label, hint = "", bind, control, off = false, id = "" }) {
	const scope = bind?.setting ? "board" : "browser";
	const changed = bind && JSON.stringify(bindValue(bind)) !== JSON.stringify(bindDefault(bind)) && bindDefault(bind) !== undefined;
	const reset = changed ? `<button type="button" class="reset-btn" data-reset="${bind.setting ? `setting:${esc(bind.setting)}` : `pref:${esc(bind.pref)}`}" title="Back to the default">Default</button>` : "";
	return `<div class="so${off ? " off" : ""}"${id ? ` id="${esc(id)}"` : ""}><div class="so-main"><div class="so-label">${label}${bind ? `<span class="scope ${scope}" title="${SCOPE[scope][1]}">${SCOPE[scope][0]}</span>` : ""}${reset}</div>${hint ? `<small>${hint}</small>` : ""}</div><div class="so-ctl">${control}</div></div>`;
}
const optGroup = (title, rows, note = "") => `<section class="so-group"><h3>${title}</h3>${note ? `<p class="hint">${note}</p>` : ""}<div class="so-list">${rows.join("")}</div></section>`;
// Controls. The page saves them on change (see the listener below); `label` is for screen readers when the row's
// own label isn't next to the control.
function ctlToggle(b, { label = "", disabled = false } = {}) {
	return `<label class="switch"><input type="checkbox" role="switch" ${bindAttr(b)} data-type="bool"${bindValue(b) ? " checked" : ""}${disabled ? " disabled" : ""}${label ? ` aria-label="${esc(label)}"` : ""}><span></span></label>`;
}
function ctlSelect(b, options, { label = "" } = {}) {
	const v = bindValue(b);
	const type = typeof options[0]?.[0] === "number" ? "number" : "string";
	return `<select ${bindAttr(b)} data-type="${type}"${label ? ` aria-label="${esc(label)}"` : ""}>${options.map(([value, text]) => `<option value="${esc(value)}"${value === v ? " selected" : ""}>${esc(text)}</option>`).join("")}</select>`;
}
function ctlRadios(b, options, { label = "" } = {}) {
	const v = bindValue(b);
	const type = typeof options[0]?.[0] === "number" ? "number" : "string";
	const name = `r-${b.setting ?? b.pref}`;
	return `<div class="radios" role="radiogroup"${label ? ` aria-label="${esc(label)}"` : ""}>${options.map(([value, text]) =>
		`<label><input type="radio" name="${esc(name)}" value="${esc(value)}" ${bindAttr(b)} data-type="${type}"${value === v ? " checked" : ""}>${esc(text)}</label>`).join("")}</div>`;
}
function ctlNumber(b, { min, max, step = 1, unit = "", label = "" } = {}) {
	return `<input type="number" ${bindAttr(b)} data-type="number" value="${esc(bindValue(b))}"${min != null ? ` min="${min}"` : ""}${max != null ? ` max="${max}"` : ""} step="${step}"${label ? ` aria-label="${esc(label)}"` : ""}>${unit ? `<span class="so-unit">${esc(unit)}</span>` : ""}`;
}
function ctlText(b, { placeholder = "", maxlength = 80, label = "" } = {}) {
	return `<input type="text" ${bindAttr(b)} data-type="string" value="${esc(bindValue(b))}" placeholder="${esc(placeholder)}" maxlength="${maxlength}"${label ? ` aria-label="${esc(label)}"` : ""}>`;
}
function ctlTime(b, { label = "" } = {}) {
	return `<input type="time" ${bindAttr(b)} data-type="string" value="${esc(bindValue(b))}"${label ? ` aria-label="${esc(label)}"` : ""}>`;
}
function readControl(el) {
	const t = el.dataset.type;
	if (t === "bool") return el.checked;
	if (t === "number") return el.value === "" ? null : Number(el.value);
	if (t === "json") return JSON.parse(el.value);
	return el.value;
}
// Board settings change only from this computer; elsewhere their controls are shown but locked.
const canChangeBoard = () => CAN_SHARE;

const TAB_IC = {
	start: '<path d="M3.75 14.25V2.25M3.75 2.75h8.5l-2 3 2 3h-8.5"/>',
	projects: '<path d="M2 4.25a1 1 0 0 1 1-1h3.2l1.5 1.5H13a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z"/>',
	notify: '<path d="M4 11V7a4 4 0 0 1 8 0v4l1.5 1.5h-11zM6.5 13.5a1.5 1.5 0 0 0 3 0"/>',
	health: '<path d="M1.5 8.5h3l1.5-4 3 8 1.5-4h4"/>',
	you: '<circle cx="8" cy="5.5" r="2.75"/><path d="M2.75 14a5.25 5.25 0 0 1 10.5 0"/>',
	data: '<ellipse cx="8" cy="3.75" rx="5.25" ry="2"/><path d="M2.75 3.75v8.5c0 1.1 2.35 2 5.25 2s5.25-.9 5.25-2v-8.5M2.75 8c0 1.1 2.35 2 5.25 2s5.25-.9 5.25-2"/>',
	privacy: '<path d="M8 1.75 2.75 3.75v4c0 3.2 2.2 5.6 5.25 6.5 3.05-.9 5.25-3.3 5.25-6.5v-4z"/><path d="m5.9 8 1.5 1.5 2.8-3"/>',
	look: '<circle cx="8" cy="8" r="6.25"/><path d="M8 1.75v12.5a6.25 6.25 0 0 0 0-12.5z" fill="currentColor" stroke="none"/>',
	updates: '<circle cx="8" cy="8" r="6.25"/><path d="M8 4.75v6M5.5 8.5 8 11l2.5-2.5"/>',
};
// In order. render() returns the tab's HTML; load() runs when the tab opens; poll() runs every 10 s while it's open.
// A tab whose code is in a later file (settings-*.js, setup.js, updates.js) is called through an arrow: that file
// hasn't run yet when this list is made.
const SET_TABS = [
	{ key: "start", label: "Getting started", local: true, render: () => setStartRender(), load: () => setupLoad(), poll: () => setupLoad() },
	{ key: "projects", label: "Projects", local: true, render: projectsTab, load: loadSettingsProjects, poll: loadSettingsProjects },
	{ key: "notify", label: "Notifications", local: false, render: () => setNotifyRender(), load: () => setNotifyLoad(), poll: () => setNotifyPoll() },
	{ key: "health", label: "Health", local: true, render: healthTab, load: () => (Date.now() - settings.checkedAt > 30e3 ? checkHealth() : null), poll: () => {} },
	{ key: "you", label: "You and your day", local: true, render: () => setYouRender(), load: () => setYouLoad(), poll: () => setYouPoll() },
	{ key: "data", label: "Data", local: true, render: () => setDataRender(), load: () => setDataLoad(), poll: () => setDataPoll() },
	{ key: "privacy", label: "Privacy and security", local: true, render: () => setPrivacyRender(), load: () => setPrivacyLoad(), poll: () => setPrivacyPoll() },
	{ key: "look", label: "Appearance", local: false, render: () => setLookRender(), load: () => setLookLoad(), poll: () => setLookPoll() },
	{ key: "updates", label: "Updates", local: true, render: () => setUpdRender(), load: () => setUpdLoad(), poll: () => setUpdPoll() },
];
const currentTab = () => SET_TABS.find((t) => t.key === settings.tab) ?? SET_TABS[0];
const localOnlyCard = (what) => `<div class="vault-card" style="margin-top:0"><div class="vault-ic">${svg16(SLIDERS)}</div><h2>${esc(what)} opens on this computer</h2>
	<p>It changes the board for every device, so it opens only where the board runs, at <a href="http://localhost:${esc(location.port)}/#settings/${esc(settings.tab)}">localhost</a>. Notifications and Appearance work here.</p></div>`;
const projDlg = $("#proj-dlg");
const projForm = $("#proj-form");
let currentProj = null;
const ST_LABEL = { ok: "OK", warn: "Needs a look", bad: "Broken", off: "Not set up" };
// The width goes on a <g>, not the <svg>: WebKitGTK zooms an outer <svg>'s stroke-width (see .gl in the styles).
const svg16 = (d, w = 1.5) => `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor"><g stroke-width="${w}">${d}</g></svg>`;
const SLIDERS = '<path d="M2.5 4.5h6M11.5 4.5h2M2.5 11.5h2M7.5 11.5h6"/><circle cx="10" cy="4.5" r="1.5"/><circle cx="6" cy="11.5" r="1.5"/>';
const cmdRow = (cmd, multi = false) => `<div class="row">${multi ? `<pre class="cmd">${esc(cmd)}</pre>` : `<code class="cmd">${esc(cmd)}</code>`}<button type="button" class="ghost sm" data-copy="${esc(cmd)}">Copy</button></div>`;
const fmtBytes = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`);
const slugify = (s) => s.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
const clockOf = (ms) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
function runningFor(ms) {
	const m = Math.round((Date.now() - ms) / 60e3);
	return m < 60 ? `${m} min` : m < 2880 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} days`;
}

async function openSettings(tab) {
	const known = SET_TABS.find((t) => t.key === tab);
	// On the phone, start on a tab that works there.
	settings.tab = known ? known.key : CAN_SHARE ? "projects" : "notify";
	if (!known && tab !== undefined) history.replaceState(null, "", `#settings/${settings.tab}`);
	settings.error = "";
	renderSettings();
	const t = currentTab();
	if (t.local && !CAN_SHARE) return;
	await Promise.all([loadSettings(), CAN_SHARE ? loadSettingsProjects() : null, t.load?.()]);
	renderSettings();
}
async function loadSettingsProjects() {
	if (!CAN_SHARE) return;
	try {
		settings.projects = await api("/api/settings/projects");
		settings.error = "";
	} catch (e) { settings.error = e.message; }
	renderSettings();
}
async function checkHealth() {
	settings.checking = true;
	renderSettings();
	try {
		settings.health = await api("/api/settings/health");
		settings.checkedAt = Date.now();
		settings.error = "";
	} catch (e) { settings.error = e.message; }
	settings.checking = false;
	renderSettings();
}

function projectRow(p, i, list) {
	const where = !p.path ? "no folder" : !p.folder.exists ? "folder is gone" : !p.folder.git ? "not a git repository" : "";
	const n = p.usage.reports;
	const meta = p.archived_at ? `archived ${ago(p.archived_at)}` : [p.open ? `${p.open} open` : "nothing open", n ? `${n} report${n === 1 ? "" : "s"}` : ""].filter(Boolean).join(" · ");
	const order = p.archived_at ? "<span></span>" : `<div class="ord">
		<button type="button" class="icon-btn" data-act="up" title="Move up" aria-label="Move ${esc(p.name)} up"${i ? "" : " disabled"}>${svg16('<path d="m4.5 10 3.5-3.5 3.5 3.5"/>')}</button>
		<button type="button" class="icon-btn" data-act="down" title="Move down" aria-label="Move ${esc(p.name)} down"${i < list.length - 1 ? "" : " disabled"}>${svg16('<path d="m4.5 6 3.5 3.5 3.5-3.5"/>')}</button></div>`;
	return `<div class="set-row${p.archived_at ? " archived" : ""}" data-slug="${esc(p.slug)}">${order}${logo(p)}
		<div class="main"><div class="nm"><b>${esc(p.name)}</b><code>${esc(p.slug)}</code></div><small title="${esc(p.path)}">${esc(p.path || "No folder")}${where ? `<span class="warn">${where}</span>` : ""}</small>${agentLine(p)}</div>
		<span class="meta">${esc(meta)}</span>
		<div class="tools">${p.archived_at ? `<button type="button" class="ghost sm" data-act="unarchive">Unarchive</button>` : agentButton(p)}
			<button type="button" class="icon-btn" data-act="edit" title="Edit" aria-label="Edit ${esc(p.name)}">${icon("edit")}</button></div></div>`;
}

/* Whether a project's agents have the workbench rules (wb integrate), and the prompt that sets them up. */
const AGENT_STATE = {
	current: ["ok", "Agent rules up to date"],
	outdated: ["warn", "Agent rules out of date"],
	manual: ["warn", "Agent rules written by hand"],
	none: ["off", "No agent rules yet"],
};
function agentLine(p) {
	const a = p.agents;
	if (p.archived_at || !a || !p.folder?.exists) return "";
	const [st, label] = AGENT_STATE[a.state];
	const where = a.state === "none" ? "" : ` in ${a.file}${a.version ? ` (v${a.version})` : ""}`;
	return `<small class="ag" title="${esc(label + where)}"><span class="sdot ${st}"></span><span>${esc(label + where)}</span></small>`;
}
function agentButton(p) {
	const a = p.agents;
	if (!a || a.state === "current" || !p.folder?.exists) return "";
	const label = a.state === "none" ? "Set up agents" : "Update agents";
	return `<button type="button" class="ghost sm" data-copy="${esc(a.prompt)}" title="Copy a prompt for an agent in this project: it runs wb integrate and follows it">${label}</button>`;
}

function checkRow(c) {
	const trackers = c.status !== "ok" ? (c.trackers ?? []) : [];
	const projects = c.projects ?? [];
	const fix = c.fix.map((f) => `<span>${esc(f.text)}</span>${f.cmd ? cmdRow(f.cmd) : ""}`).join("") +
		(trackers.length ? `<div class="row">${trackers.map((id) => `<button type="button" class="ghost sm" data-tracker="${id}">Open ${esc(state.trackers.find((t) => t.id === id)?.title ?? "tracker")}</button>`).join("")}</div>` : "") +
		(projects.length ? `<div class="row">${projects.map((s) => `<button type="button" class="ghost sm" data-act="edit" data-slug="${esc(s)}">Edit ${esc(projectName(s))}</button>`).join("")}</div>` : "");
	return `<div class="set-row chk"><span class="sdot ${c.status}"></span>
		<div class="main"><b>${esc(c.title)}</b><small>${esc(c.use)}</small><p>${esc(c.detail)}</p>${fix ? `<div class="fix">${fix}</div>` : ""}</div>
		<span class="st ${c.status}">${ST_LABEL[c.status]}</span></div>`;
}

function healthCards(h) {
	const a = h.agents, ph = h.phone, su = h.startup, b = h.board;
	const card = (status, title, body) => `<div class="set-card"><h4>${status ? `<span class="sdot ${status}"></span>` : ""}${title}</h4>${body}</div>`;
	const agents = card(a.configured ? "ok" : "off", "Agents (MCP)",
		`<p>${a.configured ? `Claude Code has the workbench's MCP server (<code>${esc(a.configured)}</code>).` : "Claude Code doesn't have the workbench's MCP server yet."} With it, agents work the board with tools instead of the <code>wb</code> command.</p>
		<span class="muted">Started by Claude Code, works without the board running:</span>${cmdRow(a.stdio)}
		<span class="muted">Or through this board while it runs:</span>${cmdRow(a.http)}
		${a.wb ? "" : `<p class="caution">wb isn't on your PATH, so the first one can't start. The README shows how to put it there.</p>`}`);
	const ig = h.integrate;
	const n = ig ? ig.counts.current + ig.counts.outdated + ig.counts.manual + ig.counts.none : 0;
	const behind = ig ? ig.behind.length : 0;
	const integrate = ig ? card(behind ? "warn" : "ok", "Help your agents use the Workbench",
		`<p>Paste this into a session in a project. The agent runs <code>wb integrate</code>, which puts the project on the board, writes the board's rules into its AGENTS.md or CLAUDE.md, and sets up Claude Code, asking you first where it matters. Running it again brings the rules up to date.</p>
		${cmdRow(ig.prompt)}
		<p class="hint">${behind ? `${behind} of ${n} projects ${behind === 1 ? "needs" : "need"} it: ${esc(ig.behind.join(", "))}. In the Projects tab, each one has a button that copies the prompt with its folder.` : `All ${n} projects have the latest rules (v${ig.version}).`}</p>`) : "";
	const restart = su.underSystemd
		? `<span class="muted">Add <code>--lan</code> to the end of the <code>ExecStart</code> line in <code>${esc(su.unitPath)}</code>, then:</span>${cmdRow("systemctl --user daemon-reload && systemctl --user restart workbench")}`
		: `<span class="muted">Stop this board, then start it with:</span>${cmdRow("wb serve --lan")}`;
	// Phones pair in Privacy and security (settings-phones.js); the button here takes you there with a code showing.
	const paired = h.devices ?? 0;
	const phone = card(ph.lan ? "ok" : "off", "Phone", ph.lan
		? `<p>On: phones you pair open and change the board; anything else on your network gets only the pairing page. ${paired ? `${paired} phone${paired === 1 ? "" : "s"} paired.` : "No phone paired yet."}</p>
			<div style="display:flex;flex-direction:column;align-items:flex-start;gap:4px;min-width:0">${ph.urls.map((u) => `<code>${esc(u.url)}</code>`).join("") || `<span class="muted">No network address found.</span>`}</div>
			<div class="row"><button type="button" class="primary sm" data-phones="pair">Pair a phone</button></div>
			<p class="hint">Over plain http, without encryption: only on a network you trust. The vault, data sources and Settings stay on this computer.</p>`
		: `<p>Off: the board answers this computer only. To open it from your phone, it has to listen on the network; phones then pair once with a code from Privacy and security. It's plain http, so do that only on a network you trust.</p>${h.app ? `<p>In the Workbench app, switch it on in the tray menu: <b>Phone access (on my network)</b>.</p>` : restart}`);
	let startup;
	if (h.app) startup = card("", "Start on login", "<p>The Workbench app handles this itself. Switch it in the app's tray menu: <b>Start on login</b>.</p>");
	else if (!su.supported) startup = card("off", "Start on login", "<p>Set up here only on Linux with systemd. Elsewhere, start the board from your login items (the README has the command).</p>");
	else if (su.installed && su.enabled === "enabled" && su.active === "active")
		startup = card("ok", "Start on login", `<p>Runs as a user service: it starts when you log in and comes back if it stops.${su.underSystemd ? "" : " This board was started separately, on its own."}</p>
			<span class="muted">After updating the workbench, restart it:</span>${cmdRow("systemctl --user restart workbench")}`);
	else if (su.installed)
		startup = card("warn", "Start on login", `<p>The service file is there (<code>${esc(su.unitPath)}</code>) but it's ${su.enabled !== "enabled" ? "not enabled" : `not running (${esc(su.active || "unknown")})`}.</p>${cmdRow("systemctl --user enable --now workbench")}`);
	else
		startup = card("off", "Start on login", `<p>Not set up: the board runs only while you keep it open. As a user service it starts when you log in and comes back if it stops.</p>
			<span class="muted">Stop the board you started by hand first (they'd share a port), then:</span>${cmdRow(su.install, true)}`);
	const about = card("", "This board", `${h.app ? "<p>Runs inside the Workbench app.</p>" : ""}<dl>
		<dt>Address</dt><dd>localhost:${b.port}</dd>
		<dt>Running for</dt><dd>${runningFor(b.startedAt)}</dd>
		<dt>Bun</dt><dd>${esc(b.bun)}</dd>
		<dt>Database</dt><dd>${esc(b.db)} · ${fmtBytes(b.dbBytes)}</dd>
		<dt>Backups</dt><dd>${esc(b.backups)}</dd></dl>`);
	return `<div class="set-grid">${integrate}${agents}${phone}${startup}${about}</div>`;
}

function projectsTab() {
	const ps = settings.projects;
	const active = ps ? ps.filter((p) => !p.archived_at) : [];
	const archived = ps ? ps.filter((p) => p.archived_at) : [];
	return `<section class="set-sec" aria-labelledby="set-projects-h">
		<div class="set-sec-head"><h3 id="set-projects-h">Projects</h3><small>Their order down the left edge, names and folders. Archive one when it's finished.</small>
			<span class="spacer"></span><button type="button" class="primary sm" data-act="add">+ Add project</button></div>
		${!ps ? `<div class="set-empty">Loading…</div>` : active.map(projectRow).join("") || `<div class="set-empty">No projects yet. Add the folder of one you work on.</div>`}
		${archived.length ? `<details class="set-archived fold" data-key="set-archived"${isOpen("set-archived")}><summary>Archived (${archived.length})</summary>${archived.map(projectRow).join("")}</details>` : ""}
	</section>`;
}

const healthProblems = () => (settings.health ? settings.health.checks.filter((c) => c.status === "warn" || c.status === "bad").length : 0);
function healthTab() {
	const h = settings.health, problems = healthProblems();
	const status = settings.checking ? "Checking…" : h ? `${problems ? `${problems} need${problems === 1 ? "s" : ""} a look` : "All good"} · checked at ${clockOf(settings.checkedAt)}` : "";
	return `<section class="set-sec" aria-labelledby="set-health-h">
		<div class="set-sec-head"><h3 id="set-health-h">Health</h3><small>${esc(status)}</small>
			<span class="spacer"></span><button type="button" class="ghost sm" data-act="check"${settings.checking ? " disabled" : ""}>Check again</button></div>
		${h ? h.checks.map(checkRow).join("") + healthCards(h) : `<div class="set-empty">${settings.checking ? "Checking the tools the board uses…" : ""}</div>`}
	</section>`;
}

function renderSettings() {
	const el = $("#settings-view");
	if (el.hidden) return;
	const t = currentTab();
	const nav = SET_TABS.map((x) => {
		const n = x.key === "health" ? healthProblems() : 0;
		return `<a href="#settings/${x.key}"${x.key === t.key ? ' aria-current="page"' : ""}>${svg16(TAB_IC[x.key] ?? "", 1.4)}<span>${esc(x.label)}</span>${n ? `<span class="tab-n" title="${n} need a look">${n}</span>` : ""}</a>`;
	}).join("");
	let body;
	try { body = t.local && !CAN_SHARE ? localOnlyCard(t.label) : t.render(); }
	catch (e) { console.error(e); body = `<p class="error">This tab couldn't be drawn: ${esc(e.message)}</p>`; }
	// On a phone the tabs scroll sideways: a redraw keeps where they were, and a newly opened tab comes into view.
	const scrolled = el.querySelector(".set-tabs")?.scrollLeft ?? 0;
	paint(el, `<div class="set-wrap">
		<div class="vault-head"><button type="button" class="ghost sm" data-act="board">← Board</button><div><h2>Settings</h2><small>For the whole workbench</small></div></div>
		<div class="set-layout"><nav class="set-tabs" aria-label="Settings sections">${nav}</nav>
		<div class="set-panel">${settings.error ? `<p class="error">${esc(settings.error)}</p>` : ""}${body}</div></div></div>`);
	const tabs = el.querySelector(".set-tabs");
	if (tabs) tabs.scrollLeft = scrolled;
	if (settings.shownTab !== t.key) {
		settings.shownTab = t.key;
		tabs?.querySelector("[aria-current]")?.scrollIntoView({ block: "nearest", inline: "nearest" });
	}
}
