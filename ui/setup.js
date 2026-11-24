/* ---------- Setup guide (#welcome, #welcome/<step>) and its checklist ---------- */
// A first run for a new board, and the way back to it: Settings → About, and the "Finish setting up"
// checklist at the top of the Inbox. Every step can be skipped. Whether one is done is checked now, never taken from
// a click: GET /api/setup (setup.ts) for the board's side, and here in the page for notifications and the app's start
// on login, which are per device. What the guide remembers (when it was first shown, skipped steps, the checklist
// dismissed or finished) is the board setting `setup`. It opens on this computer only, like Settings.
const inWelcome = () => location.hash === "#welcome" || location.hash.startsWith("#welcome/");
const WL_STEPS = [
	{ key: "name", title: "Who you are", short: "Your name" },
	{ key: "projects", title: "Your projects", short: "Projects" },
	{ key: "agents", title: "Connect your agents", short: "Agents" },
	{ key: "rules", title: "Set up each project for agents", short: "Agent rules" },
	{ key: "notify", title: app ? "Notifications and start on login" : "Notifications", short: "Notifications" },
	{ key: "board", title: "How the board works", short: "How it works" },
];
const WL_KIND = {
	decision: "A question only you can answer, with the options and the agent's pick. Often one click.",
	setup: "Something only you can do: an account, a console, a store. Each click is spelled out.",
	check: "Trying something on a device: numbered steps, and what right and wrong look like.",
	review: "Reading a wording or looking at a design, with the exact words or a picture.",
	notice: "What an agent changed, just so you know. Got it closes it, Object… sends it back. It doesn't wait on you.",
	bug: "Something broken, for an agent to fix.",
	task: "Code work for an agent.",
	idea: "Later, maybe. Folded away at the bottom.",
};
const WL_TRY = "List my workbench projects with the wb MCP tools.";
const setup = { data: null, at: 0, err: "", step: "name", loading: null, folders: null, adding: new Set(), autostart: undefined, nameDraft: null, picked: false };
const SETUP_DEF = { seen: "", steps: {}, dismissed: false, finished: false };
const setupSaved = () => ({ ...SETUP_DEF, ...(setting("setup") ?? {}) });

async function setupLoad() {
	if (!CAN_SHARE) return;
	if (setup.loading) return setup.loading;
	setup.loading = (async () => {
		try {
			setup.data = await api("/api/setup");
			setup.at = Date.now();
			setup.err = "";
		} catch (e) { setup.err = `Couldn't check: ${e.message}`; }
		// An older app has no such command: then start on login can't be checked from here (null).
		if (app?.core) { try { setup.autostart = (await app.core.invoke("autostart", {})).enabled; } catch { setup.autostart = null; } }
	})();
	try { await setup.loading; } finally { setup.loading = null; }
	const s = setupSaved();
	if (s.seen && !s.finished && setup.data && setupComplete()) setupSave({ finished: true });
	renderWelcome();
	renderSetupCard();
	renderSettings();
}
async function setupSave(patch) {
	const cur = setupSaved();
	const next = { ...cur, ...patch, steps: { ...cur.steps, ...(patch.steps ?? {}) } };
	state.settings = { ...state.settings, setup: next };
	try { state.settings = await api("/api/settings", { method: "PATCH", body: JSON.stringify({ setup: next }) }); }
	catch (e) { toast(e.message); }
	renderWelcome();
	renderSetupCard();
	renderSettings();
}

// What each step's check found: st is the dot (ok / warn / off), done whether it counts as done.
function wlCheck(key) {
	const d = setup.data;
	if (!d) return { st: "off", done: false, text: setup.err || "Checking…" };
	const n = (k, one, many = `${one}s`) => `${k} ${k === 1 ? one : many}`;
	if (key === "name") return d.name.set
		? { st: "ok", done: true, text: `Saved: the board calls you ${d.name.value}.` }
		: { st: "off", done: false, text: `Not set yet, so the board calls you ${d.name.value}.` };
	if (key === "projects") return d.projects.active
		? { st: "ok", done: true, text: `${n(d.projects.active, "project")} on the board.` }
		: { st: "off", done: false, text: "No projects on the board yet." };
	if (key === "agents") {
		const c = d.mcp.contacts[0];
		if (c) return { st: "ok", done: true, text: `It works: an agent called the board ${ago(c.at)}${c.client ? `, from ${c.client}` : ""}, ${c.transport === "http" ? "through this board" : "with wb mcp"}.` };
		if (d.mcp.configured) return { st: "warn", done: false, text: `Claude Code has the MCP server (${d.mcp.configured.how}), but no agent has called the board yet.`, sub: "Try it as step 2 says: this turns green on the first call." };
		return { st: "off", done: false, text: "Claude Code doesn't have the workbench's MCP server yet, and no agent has called the board." };
	}
	if (key === "rules") {
		if (!d.projects.active) return { st: "off", done: false, text: "Add a project first." };
		const ps = d.rules.projects.filter((p) => p.folder);
		if (!ps.length) return { st: "warn", done: false, text: "None of your projects' folders can be found, so their rules can't be read." };
		const ok = ps.filter((p) => p.state === "current").length;
		if (ok === ps.length) return { st: "ok", done: true, text: ps.length === 1 ? `${ps[0].name} has the latest rules for agents (v${d.rules.version}).` : `All ${ps.length} projects have the latest rules for agents (v${d.rules.version}).` };
		return { st: ok ? "warn" : "off", done: false, text: `${ok} of ${n(ps.length, "project")} ${ps.length === 1 ? "has" : "have"} the latest rules for agents.` };
	}
	if (key === "notify") {
		const on = notifyOn(), login = app ? setup.autostart : true;
		const where = app ? "in this app" : "in this browser";
		const text = [`Notifications are ${on ? "on" : "off"} ${where}.`,
			app ? (login === true ? "The app starts when you log in." : login === false ? "The app doesn't start when you log in." : "Whether the app starts on login can't be read from here: the tray menu shows it.") : ""].filter(Boolean).join(" ");
		const st = !app ? (on ? "ok" : "off") : on && login !== false ? "ok" : on || login === true ? "warn" : "off";
		return { st, done: on && login !== false, text };
	}
	if (key === "board") return setupSaved().steps.board === "done" ? { st: "ok", done: true, text: "Read." } : { st: "off", done: false, text: "Not read yet." };
	return { st: "off", done: false, text: "" };
}
const wlStatus = (key) => (wlCheck(key).done ? "done" : setupSaved().steps[key] === "skipped" ? "skipped" : "todo");
const setupComplete = () => WL_STEPS.every((s) => wlStatus(s.key) !== "todo");
const wlFirstTodo = () => WL_STEPS.find((s) => wlStatus(s.key) === "todo")?.key ?? WL_STEPS[0].key;

async function openWelcome(step) {
	const el = $("#welcome-view");
	if (!CAN_SHARE) {
		return paint(el, `<div class="vault-card"><div class="vault-ic">${svg16(TAB_IC.about, 1.4)}</div><h2>The setup guide opens on this computer</h2>
			<p>It adds projects and reads how Claude Code is set up there, so it opens only where the board runs, at <a href="http://localhost:${esc(location.port)}/#welcome">localhost</a>.</p>
			<button type="button" class="ghost" data-wl="close">← Board</button></div>`);
	}
	const known = WL_STEPS.some((s) => s.key === step);
	setup.step = known ? step : setup.data ? wlFirstTodo() : "name";
	if (!known) history.replaceState(null, "", `#welcome/${setup.step}`);
	if (!setupSaved().seen) setupSave({ seen: new Date().toISOString().slice(0, 19) });
	renderWelcome();
	if (setup.step === "projects") wlFolders();
	await setupLoad();
	// Opened without a step: start where there's something left to do.
	if (!known && setup.data && inWelcome() && setup.step === "name" && wlStatus("name") !== "todo") {
		setup.step = wlFirstTodo();
		history.replaceState(null, "", `#welcome/${setup.step}`);
		renderWelcome();
	}
}
async function wlFolders() {
	try { setup.folders = await api("/api/settings/folders"); } catch { setup.folders = []; }
	renderWelcome();
}

const wlCheckSvg = svg16('<path d="m3.5 8.5 3 3 6-6.5"/>', 2);
const wlRows = (rows) => (rows.length ? `<div class="wl-rows">${rows.join("")}</div>` : "");
const wlRow = (lead, title, sub, ctl = "") => `<div class="wl-row">${lead}<div class="main"><b>${title}</b>${sub ? `<small>${sub}</small>` : ""}</div><div class="so-ctl">${ctl}</div></div>`;
const wlIcon = (d) => `<span class="dt-ic">${svg16(d, 1.4)}</span>`;
const WL_BODY = {
	name() {
		const d = setup.data;
		const value = setup.nameDraft ?? (d?.name.set ? d.name.value : "");
		return `<p class="wl-lede">The board is yours: it's where agents leave what waits on you. They call you by name in what they write for you, and so do day pages and the <code>wb</code> command.</p>
			<div class="wl-body"><label class="wl-field"><span class="hint">Your name</span><input id="wl-name" value="${esc(value)}" placeholder="${esc(d?.name.value ?? "Your name")}" maxlength="40" autocomplete="given-name" spellcheck="false"></label>
			<p class="hint">Only the words change: in commands, items for you keep the owner <code>kostas</code> whatever your name. When your work day starts is in Settings → About; who gets new items, in Settings → Agents.</p></div>`;
	},
	projects() {
		const rows = state.projects.map((p) => wlRow(logo(p), esc(p.name), `<span title="${esc(p.path)}">${esc(p.path || "No folder")}</span>`));
		const f = setup.folders;
		const chips = f === null ? `<span class="hint">Looking for folders…</span>`
			: f.length ? `<div class="chips">${f.map((x, i) => `<button type="button" class="chip" data-wl-add="${i}" title="Add ${esc(x.path)}"${setup.adding.has(x.path) ? " disabled" : ""}>${esc(x.name)}</button>`).join("")}</div>`
			: `<span class="hint">No other git repositories next to your projects or in ~/Projects. Pick a folder with “Another folder”.</span>`;
		return `<p class="wl-lede">A project is a folder you work in, usually a git repository. Its items, reports and links sit under it down the left edge, with its git state on the board: uncommitted files, unpushed commits, branches. What an agent adds from inside the folder lands in it.</p>
			<div class="wl-body">${wlRows(rows)}
			<h4>${state.projects.length ? "Add more with one click" : "Git repositories that could be projects: one click puts one on the board"}</h4>
			<div class="wl-suggest">${chips}</div>
			<div class="row"><button type="button" class="ghost sm" data-wl="add-other">Another folder…</button><span class="hint">Names, logos and order can change later, in Settings → Projects.</span></div></div>`;
	},
	agents() {
		const m = setup.data?.mcp;
		const has = !!m?.configured;
		const cmds = `${cmdRow(m?.stdio ?? "claude mcp add -s user wb -- wb mcp")}
			${m && !m.wb ? `<p class="caution">The <code>wb</code> command isn't on your PATH, so Claude Code couldn't start it. Use the other one, which goes through this board while it runs, or put <code>wb</code> on your PATH (the README says how).</p>` : ""}
			<details class="wl-more fold" data-key="wl-http"${isOpen("wl-http")}><summary>Or through this board, while it runs</summary>${cmdRow(m?.http ?? `claude mcp add -s user --transport http wb http://localhost:${location.port}/mcp`)}</details>`;
		return `<p class="wl-lede">Agents do the board's tasks and leave you what needs you. With the workbench's MCP server, Claude Code works the board with tools: add an item, start it, finish it, attach a screenshot, publish a report.</p>
			<div class="wl-body">
			<h4>1. Give Claude Code the MCP server, once for this computer</h4>
			${has ? `<p>Claude Code has it already (${esc(m.configured.how)}${m.configured.scope === "project" ? ", for one project" : ""}).</p><details class="wl-more fold" data-key="wl-cmds"${isOpen("wl-cmds")}><summary>The commands, to add it again</summary>${cmds}</details>`
				: `<p>Run this in a terminal. Claude Code starts the server itself whenever a session needs it, so it works even when the board isn't open.</p>${cmds}`}
			<h4>2. Check that it works</h4>
			<div class="wl-try"><ol>
				<li>Start a new Claude Code session, in any folder. A session that was already open doesn't see a server added after it started.</li>
				<li><span>Ask it: <b>${esc(WL_TRY)}</b></span> <button type="button" class="ghost sm" data-copy="${esc(WL_TRY)}">Copy</button></li>
				<li>The line below turns green when its first call reaches the board.</li></ol></div>
			<p class="hint">Another agent that speaks MCP takes the same server: <code>wb mcp</code> on stdio, or <code>http://localhost:${esc(location.port)}/mcp</code>. One that doesn't uses the <code>wb</code> command, and <code>wb guide</code> tells it how to write an item.</p></div>`;
	},
	rules() {
		const d = setup.data;
		const ps = d?.rules.projects ?? [];
		const rows = ps.map((p) => {
			const proj = state.projects.find((x) => x.slug === p.slug) ?? p;
			const [st, label] = p.folder ? AGENT_STATE[p.state] : ["bad", "Folder not found"];
			const where = p.folder && p.state !== "none" ? ` in ${p.file}${p.version ? ` (v${p.version})` : ""}` : "";
			const ctl = !p.folder ? "" : p.state === "current" ? `<span class="st ok">Done</span>`
				: `<button type="button" class="ghost sm" data-copy="${esc(p.prompt)}" title="A prompt for an agent in ${esc(p.path)}: it runs wb integrate and follows it">Copy the prompt</button>`;
			return wlRow(logo(proj), esc(p.name), `<span class="sdot ${st}"></span><span>${esc(label + where)}</span>`, ctl);
		});
		return `<p class="wl-lede">Each project gets the board's rules for agents: a short block in its AGENTS.md or CLAUDE.md, which every session reads. It tells them to keep open work on the board, to start and finish their items, and to file what needs you as items that make sense on their own.</p>
			<div class="wl-body"><p>Copy a project's prompt and paste it into a Claude Code session started in that project. The agent runs <code>wb integrate</code>, which:</p>
			<ul style="margin:0;padding-left:20px;display:flex;flex-direction:column;gap:3px"><li>puts the project on the board, if it isn't yet,</li><li>writes the rules into AGENTS.md or CLAUDE.md, between markers, so running it again brings them up to date,</li><li>gives Claude Code the MCP server and lets <code>wb</code> run without asking each time,</li><li>moves any to-do lists it finds in the project's files onto the board.</li></ul>
			<p class="hint">It asks you before it adds the project, changes your Claude Code settings or moves a to-do list, and it commits nothing unless you ask.</p>
			${ps.length ? wlRows(rows) : `<p class="set-empty">No projects yet. <a href="#welcome/projects">Add one first</a>, or use the prompt below in any project's folder.</p>`}
			<details class="wl-more fold" data-key="wl-anyprompt"${isOpen("wl-anyprompt", !ps.length)}><summary>For a project that isn't on the board yet</summary><span class="hint">Paste it into a session started in that folder:</span>${cmdRow(d?.rules.prompt ?? "")}</details></div>`;
	},
	notify() {
		const [dot, status] = notifyState();
		const on = notifyOn();
		const blocked = !appNotify && (!("Notification" in window) || Notification.permission === "denied");
		const bell = '<path d="M4 11V7a4 4 0 0 1 8 0v4l1.5 1.5h-11zM6.5 13.5a1.5 1.5 0 0 0 3 0"/>';
		const power = '<path d="M8 2v5.5M4.6 4.2a5 5 0 1 0 6.8 0"/>';
		const rows = [wlRow(wlIcon(bell), "Desktop notifications", `<span class="sdot ${dot}"></span><span>${status}</span>`,
			on ? `<button type="button" class="ghost sm" data-wl="notify-test">Send a test</button>` : blocked ? "" : `<button type="button" class="primary" data-wl="notify-on">Turn on</button>`)];
		if (app) {
			const a = setup.autostart;
			rows.push(wlRow(wlIcon(power), "Start on login", a == null ? "<span>This app can't say from here: use <b>Start on login</b> in its tray menu.</span>"
				: `<span class="sdot ${a ? "ok" : "off"}"></span><span>${a ? "On: the app starts hidden in the tray when you log in, with the board." : "Off: the board runs while the app is open."}</span>`,
				a == null ? "" : `<label class="switch"><input type="checkbox" role="switch" data-wl-autostart${a ? " checked" : ""} aria-label="Start on login"><span></span></label>`));
		} else {
			const su = setup.data?.startup;
			const ok = su?.installed && su.enabled === "enabled" && su.active === "active";
			const sub = !su ? "<span>Checking…</span>" : ok ? `<span class="sdot ok"></span><span>Runs as a user service: it starts when you log in.</span>`
				: !su.supported ? "<span>Set up here only on Linux with systemd. Elsewhere, start the board from your login items.</span>"
				: `<span class="sdot off"></span><span>${su.installed ? `The service is there but ${su.enabled !== "enabled" ? "not enabled" : "not running"}.` : "Not set up: the board runs only while you keep it open."}</span>`;
			rows.push(wlRow(wlIcon(power), "Start on login <span class=\"hint\">optional</span>", sub));
			if (su?.supported && !ok) rows.push(`<div class="wl-row" style="display:block"><details class="wl-more fold" data-key="wl-service"${isOpen("wl-service")}><summary>How to set it up</summary>
				${su.installed ? cmdRow("systemctl --user enable --now workbench") : `<span class="hint">Stop the board you started by hand first (they'd share a port), then:</span>${cmdRow(su.install, true)}`}
				<p class="hint" style="margin-top:6px">Or install the Workbench app: it starts on login from its tray menu.</p></details></div>`);
		}
		return `<p class="wl-lede">The board tells you when something needs you, so you don't have to keep it open in front of you.</p>
			<div class="wl-body">${wlRows(rows)}
			<p class="hint">They pop up while the board isn't the window in front: something new needs you, an agent finished or got stuck, a report changed. ${app ? "This app has its own switch, apart from your browsers." : "Each browser has its own switch: the bell above the board."} Settings → Notifications picks which, and quiet hours.</p></div>`;
	},
	board() {
		const p = state.projects[0];
		const sample = card({ id: 0, ref: "k3f9", title: "Try the new sign-up screen on your phone", kind: "check", owner: "kostas", status: "todo", priority: 2, project: p?.slug ?? "", area: "", image_count: 1 }, { kind: true });
		return `<p class="wl-lede">A minute on how to read it.</p>
			<div class="wl-body">
			<h4>Who acts</h4>
			<div class="wl-who"><div><b><span class="owner kostas">you</span>${esc(youName())}</b><p>Decisions, setup steps, checks and reviews: what only you can do. The red number on a project counts them, and <b>Needs you</b> above the board shows only these.</p></div>
				<div><b><span class="owner">agent</span>Agents</b><p>Tasks, bugs and ideas. An agent starts one when it picks it up (it shows as <span class="st-doing">doing</span>), then finishes it, or marks it <span class="st-waiting">waiting</span> when it's stuck. <b>With agents</b> shows these.</p></div></div>
			<h4>Kinds of item</h4>
			<dl class="wl-kinds">${KIND_NAMES.map(([k, label]) => `<dt class="k-${k}">${kindGlyph(k)}${esc(label.replace(/s$/, ""))}</dt><dd>${esc(WL_KIND[k])}</dd>`).join("")}</dl>
			<h4>Refs: wb-xxxx</h4>
			<div class="wl-sample" aria-hidden="true">${sample}</div>
			<p>Every item has a short name like <code>wb-k3f9</code>. Click it on a card to copy it, and tell an agent “Do wb-k3f9”: it reads the item and works on it. Put it in commit messages and pull request titles, and they show on the item.</p>
			<h4>Also on the board</h4>
			<ul style="margin:0;padding-left:20px;display:flex;flex-direction:column;gap:3px"><li><b>Reports</b> in the sidebar: pages agents publish (a status, a plan, release notes), and a page for each day of what moved.</li>
				<li><b>Search</b> with ${esc(MOD)} K: items and their notes, reports, links.</li><li><b>Vault</b> (the lock at the top): secrets, encrypted in your browser.</li>
				<li>This guide comes back from Settings → About.</li></ul></div>`;
	},
};

function renderWelcome() {
	const el = $("#welcome-view");
	if (el.hidden || !CAN_SHARE) return;
	const i = Math.max(0, WL_STEPS.findIndex((s) => s.key === setup.step));
	const s = WL_STEPS[i];
	const nav = WL_STEPS.map((x, j) => {
		const st = wlStatus(x.key);
		return `<li><a href="#welcome/${x.key}"${x.key === s.key ? ' aria-current="step"' : ""} title="${esc(x.title)}${st === "done" ? " · done" : st === "skipped" ? " · skipped" : ""}"><span class="wl-num ${st}">${st === "done" ? wlCheckSvg : j + 1}</span><span>${esc(x.short)}</span></a></li>`;
	}).join("");
	const c = wlCheck(s.key);
	const check = s.key === "board" ? "" : `<div class="wl-check" aria-live="polite"><span class="sdot ${c.st}"></span><span>${esc(c.text)}${c.sub ? `<small>${esc(c.sub)}</small>` : ""}${setup.at ? `<small>Checked at ${clockOf(setup.at)}</small>` : ""}</span><button type="button" class="ghost sm" data-wl="recheck">Check again</button></div>`;
	const last = i === WL_STEPS.length - 1;
	const nameChanged = s.key === "name" && setup.nameDraft !== null && setup.nameDraft.trim() && setup.nameDraft.trim() !== setup.data?.name.value;
	const next = last ? "Go to the board" : s.key === "name" && (nameChanged || !setup.data?.name.set) ? "Save and continue" : "Continue";
	const foot = `<div class="wl-foot">${i ? `<button type="button" class="ghost" data-wl="back">Back</button>` : ""}<span class="spacer"></span>
		${c.done ? "" : `<button type="button" class="ghost quiet" data-wl="skip">${last ? "Skip" : "Skip this step"}</button>`}<button type="button" class="primary" data-wl="next">${next}</button></div>`;
	// Polling redraws the step: keep the keyboard where it was (the name field, say).
	const a = document.activeElement, focusId = el.contains(a) ? a.id : "", caret = focusId ? a.selectionStart : null;
	paint(el, `<div class="wl-wrap"><div class="wl-head"><img class="plogo" src="/favicon.svg" alt=""><div><h2>Set up the Workbench</h2><small>Step ${i + 1} of ${WL_STEPS.length}<span class="wl-later">. Skip any of them: Settings → About brings this back.</span></small></div><span class="spacer"></span><button type="button" class="ghost sm" data-wl="close">${setupComplete() ? "Close" : "Finish later"}</button></div>
		<div class="wl-layout"><nav aria-label="Setup steps"><ol class="wl-steps">${nav}</ol></nav><div class="wl-panel"><h3>${esc(s.title)}</h3>${WL_BODY[s.key]()}${check}${foot}</div></div></div>`);
	if (focusId && document.activeElement !== document.getElementById(focusId)) {
		const n = document.getElementById(focusId);
		n?.focus();
		if (caret != null) try { n.setSelectionRange(caret, caret); } catch {}
	}
}

function wlGo(key) { location.hash = `#welcome/${key}`; }
async function wlNext() {
	const i = WL_STEPS.findIndex((s) => s.key === setup.step);
	if (setup.step === "name") {
		const v = (setup.nameDraft ?? "").trim();
		if (v) {
			try { state.settings = await api("/api/settings", { method: "PATCH", body: JSON.stringify({ name: v }) }); }
			catch (e) { return toast(e.message); }
			runSettingsHooks("name");
			setup.nameDraft = null;
			toast(`Hello, ${setting("name")}`);
			setupLoad();
		} else if (!setup.data?.name.set) {
			$("#wl-name")?.focus();
			return toast("Type your name, or skip this step");
		}
	}
	if (setup.step === "board") await setupSave({ steps: { board: "done" } });
	if (i < WL_STEPS.length - 1) return wlGo(WL_STEPS[i + 1].key);
	wlFinish();
}
function wlFinish() {
	if (setupComplete()) { setupSave({ finished: true }); toast("You're set up"); }
	else toast("“Finish setting up” on the board keeps what's left");
	goHome();
}
$("#welcome-view").addEventListener("input", (e) => {
	if (e.target.id !== "wl-name") return;
	setup.nameDraft = e.target.value;
	// Only the button's words follow the field; the rest stays as it is while typing.
	const b = $('#welcome-view [data-wl="next"]');
	if (b) b.textContent = setup.nameDraft.trim() && setup.nameDraft.trim() !== setup.data?.name.value || !setup.data?.name.set ? "Save and continue" : "Continue";
});
$("#welcome-view").addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target.id === "wl-name") { e.preventDefault(); wlNext(); } });
$("#welcome-view").addEventListener("change", async (e) => {
	const t = e.target.closest("[data-wl-autostart]");
	if (!t || !app?.core) return;
	try {
		setup.autostart = (await app.core.invoke("autostart", { on: t.checked })).enabled;
		toast(setup.autostart ? "The app starts when you log in" : "The app won't start on login");
	} catch (err) { toast(`Couldn't change it: ${err}`); }
	renderWelcome();
	renderSetupCard();
});
$("#welcome-view").addEventListener("click", async (e) => {
	const add = e.target.closest("[data-wl-add]");
	if (add) {
		const f = setup.folders?.[Number(add.dataset.wlAdd)];
		if (!f || setup.adding.has(f.path)) return;
		setup.adding.add(f.path);
		renderWelcome();
		try {
			await api("/api/projects", { method: "POST", body: JSON.stringify({ path: f.path, name: f.name, slug: f.slug }) });
			toast(`${f.name} is on the board`);
			await afterProjectChange();
		} catch (err) { toast(err.message); }
		setup.adding.delete(f.path);
		return;
	}
	const b = e.target.closest("[data-wl]");
	if (!b) return;
	const what = b.dataset.wl;
	const i = WL_STEPS.findIndex((s) => s.key === setup.step);
	if (what === "next") wlNext();
	else if (what === "back" && i > 0) wlGo(WL_STEPS[i - 1].key);
	else if (what === "skip") {
		await setupSave({ steps: { [setup.step]: "skipped" } });
		if (i < WL_STEPS.length - 1) wlGo(WL_STEPS[i + 1].key); else wlFinish();
	}
	else if (what === "close") goHome();
	else if (what === "recheck") { b.disabled = true; await setupLoad(); }
	else if (what === "add-other") openProjectDlg(null);
	else if (what === "notify-on") { await setNotifyOn(true); renderWelcome(); renderSetupCard(); }
	else if (what === "notify-test") {
		if (!ping("Workbench", "Notifications work. They look like this, and clicking one opens what it's about.", "wb-test", null))
			toast("This browser shows notifications only from installed apps");
	}
});
// While a step waits on something done elsewhere (a session, a terminal, a tray menu), look again every few seconds.
setInterval(() => {
	if (document.visibilityState === "visible" && !$("#welcome-view").hidden && ["agents", "rules", "notify", "projects"].includes(setup.step)) setupLoad();
}, 4000);

// The checklist at the top of the Inbox (#setup-card, inbox.js): once the guide was opened, until every step is done or
// skipped, or dismissed.
function setupCardShown() {
	if (!CAN_SHARE || solo || !setup.data) return false;
	const s = setupSaved();
	return !!s.seen && !s.dismissed && !s.finished && !setupComplete();
}
function renderSetupCard() {
	const el = $("#setup-card");
	if (!el) return;
	if (!setupCardShown()) return paint(el, "");
	const n = WL_STEPS.filter((s) => wlStatus(s.key) !== "todo").length;
	const chips = WL_STEPS.map((s) => {
		const st = wlStatus(s.key);
		return `<a href="#welcome/${s.key}" class="${st}" title="${esc(s.title)}: ${st === "done" ? "done" : st === "skipped" ? "skipped" : esc(wlCheck(s.key).text)}">${esc(s.short)}</a>`;
	}).join("");
	paint(el, `<div class="setup-card" role="region" aria-label="Finish setting up"><span class="setup-ring" aria-hidden="true">${ringSvg((n / WL_STEPS.length) * 100, 34, 4.5)}<span>${n}/${WL_STEPS.length}</span></span>
		<b>Finish setting up</b><div class="setup-chips">${chips}</div>
		<div class="tools"><button type="button" class="primary" data-setup="go">Continue</button><button type="button" class="icon-btn" data-setup="dismiss" title="Hide this checklist (Settings → About keeps it)" aria-label="Hide the checklist">${svg16('<path d="m4.5 4.5 7 7M11.5 4.5l-7 7"/>')}</button></div></div>`);
}
document.addEventListener("click", (e) => {
	const b = e.target.closest("#setup-card [data-setup]");
	if (!b) return;
	if (b.dataset.setup === "go") wlGo(wlFirstTodo());
	else { setupSave({ dismissed: true }); toast("Hidden. Settings → About has the setup guide"); }
});

// Settings → About → Setup guide: every step with what its check found, and the way back into the guide.
function setStartRender() {
	const saved = setupSaved();
	if (!setup.data) return `<details class="so-fold fold" data-key="set-about-setup"${isOpen("set-about-setup")}><summary><span>Setup guide</span></summary><div class="set-empty">${esc(setup.err || "Checking…")}</div></details>`;
	const rows = WL_STEPS.map((s) => {
		const c = wlCheck(s.key), st = wlStatus(s.key);
		return optRow({
			label: `<span class="sdot ${st === "done" ? "ok" : c.st === "warn" ? "warn" : "off"}"></span>${esc(s.title)}${st === "skipped" ? `<span class="scope">Skipped</span>` : ""}`,
			hint: esc(c.text),
			control: `<a class="ghost sm" href="#welcome/${s.key}">${st === "done" || s.key === "board" ? "Open" : "Set up"}</a>`,
		});
	});
	const complete = setupComplete();
	const card = optRow({
		label: "“Finish setting up” in the Inbox",
		hint: complete ? "Hidden: every step is done or skipped." : saved.dismissed ? "Hidden." : saved.seen ? "At the top of the Inbox, until every step is done or skipped." : "Shows once you've opened the guide.",
		control: `<label class="switch"><input type="checkbox" role="switch" data-setup-card${!saved.dismissed && !complete ? " checked" : ""}${complete ? " disabled" : ""} aria-label="Show the checklist in the Inbox"><span></span></label>`,
	});
	const n = WL_STEPS.filter((s) => wlStatus(s.key) === "done").length;
	const open = `<div class="set-fold-bar"><button type="button" class="primary sm" data-act="welcome">${saved.seen ? "Open the setup guide" : "Start the setup guide"}</button></div>`;
	return `<details class="so-fold fold" data-key="set-about-setup"${isOpen("set-about-setup")}><summary><span>Setup guide</span><small>${n} of ${WL_STEPS.length} done</small></summary>${open}<div class="so-list">${rows.join("")}${card}</div></details>`;
}
$("#settings-view").addEventListener("change", (e) => {
	const t = e.target.closest("[data-setup-card]");
	if (t) setupSave({ dismissed: !t.checked, seen: setupSaved().seen || new Date().toISOString().slice(0, 19) });
});
$("#settings-view").addEventListener("click", (e) => { if (e.target.closest('[data-act="welcome"]')) location.hash = "#welcome"; });

// A new board opens the guide by itself, once; a board already in use (projects and its own items) never does.
async function maybeWelcome() {
	if (!CAN_SHARE || solo) return;
	await setupLoad();
	const d = setup.data;
	if (!d || setupSaved().seen || location.hash) return;
	if (d.projects.total === 0 || d.items < 10) location.hash = "#welcome";
}

/* ---------- end: Setup guide ---------- */
