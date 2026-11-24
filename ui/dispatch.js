/* ---------- Answer & send: agents the board starts (dispatch.ts) ---------- */
// Run on an agent's to-do, and "resume the agent" with an answer or an objection (ui/answer.js, { send: true }): the
// board starts Claude Code headless in the project's folder on that item. A card shows a running agent, and Run; the
// reader shows its output live, Stop, and afterwards how it went, what it cost and how to continue the session.
// Settings → Agents turns it on and holds the limits.
// The calls below don't touch the page, so other views (the one-at-a-time queue) can use them: canSend(item),
// sendWhy(item), sendItem(id), stopAgent(runId).
// What the reader (ui/reader.js) asks of this file, its whole contract:
//   runPanel(item) → HTML: the run box for the item ("" for none): its newest run, or Run on an agent's to-do.
//   wireRunPanel(el, item): `el` holds runPanel's HTML; its clicks (Stop, Run, Open in Claude Desktop) and, while
//     the run is live, its output every 2 s, drawn into `el` until `el` leaves the page or is wired again.
//   runLive(item) → boolean: a run is going, so the reader puts the box near the top.
//   canResume(item) → boolean: the "resume the agent" tick shows next to Answer and Object.
// When a run ends, this calls readerRefresh(itemId): the item's status and history have changed.

const runs = { info: null, byItem: new Map(), detail: null, timer: 0, fast: 0, test: null, testing: false, panel: null };
const RUN_ASKS = ["decision", "review", "notice"];

async function runsLoad() {
	try {
		const info = await api("/api/runs");
		const before = JSON.stringify(runs.info?.active ?? []) + JSON.stringify(runs.info?.runs?.[0] ?? null);
		runs.info = info;
		// The newest run per item: the ones still going first.
		runs.byItem = new Map();
		for (const r of [...info.active, ...info.runs]) if (!runs.byItem.has(r.item_id)) runs.byItem.set(r.item_id, r);
		if (before !== JSON.stringify(info.active) + JSON.stringify(info.runs[0] ?? null)) {
			if (!$("#board").hidden) renderBoard();
			if (settings.tab === "agents" && !$("#settings-view").hidden) renderSettings();
		}
	} catch {}
	runsWatch();
}
// While an agent runs, look every 3 s (the board's own poll is every 10 s and pauses while a dialog is open).
function runsWatch() {
	clearTimeout(runs.fast);
	if (!runs.info?.running) return;
	runs.fast = setTimeout(() => { if (document.visibilityState === "visible") runsLoad(); else runsWatch(); }, 3000);
}
hooks.start.push(runsLoad);
hooks.refresh.push(runsLoad);

/* The calls. */
const runActive = (id) => { const r = runs.byItem.get(Number(id)); return r && !r.ended_at ? r : null; };
/** How an item would be sent: "run" (an agent's to-do), "answer" (an ask of yours, answered first), or "". */
function sendKind(i) {
	if (!i || !OPEN.includes(i.status)) return "";
	if (i.owner === "kostas") return RUN_ASKS.includes(i.kind) ? "answer" : "";
	return i.status === "todo" && i.kind !== "idea" ? "run" : "";
}
/** Why it can't be sent now, in words; '' when it can. */
function sendWhy(i) {
	const info = runs.info;
	if (!info) return "Loading…";
	if (!info.on) return "The board doesn't start agents: turn it on in Settings → Agents.";
	if (!info.allowed) return info.why || "Agents start only from this computer.";
	if (!sendKind(i)) return i.owner === "agent" && i.status === "doing" ? "It's being worked on already." : "Only an agent's to-do, or a decision, review or notice you answer.";
	if (!info.folders.includes(i.project)) return CLOUD ? "No computer that's online has its project's folder (Settings → Projects)." : "Its project has no folder on this computer (Settings → Projects).";
	if (runActive(i.id)) return "An agent is on it already.";
	if (info.limited) return info.why;
	return "";
}
/** Sending is on and allowed from here, the item can be sent, and no limit is hit. */
const canSend = (i) => !sendWhy(i);
async function runAfter(id, body) {
	touched(id);
	const res = await api("/api/runs", { method: "POST", body: JSON.stringify({ item: Number(id), ...body }) });
	await Promise.all([loadItems(), loadProjects(), runsLoad()]);
	refreshReport();
	return res;
}
/** Starts an agent on an agent's to-do. Returns { run, item }. (Answering and starting: act.answer and act.object
 * with { send: true }, ui/answer.js.) */
const sendItem = (id) => runAfter(id, {});
/** Stops a run: the agent and everything it started. */
async function stopAgent(runId) {
	const r = await api(`/api/runs/${runId}/stop`, { method: "POST", body: "{}" });
	await runsLoad();
	return r;
}

/* Words and bits shared by the card, the reader and Settings. */
const runFor = (from, to) => {
	const m = Math.round(((to ? parseTime(to) : new Date()) - parseTime(from)) / 60e3);
	return m < 1 ? "under a minute" : m < 90 ? `${m} min` : `${(m / 60).toFixed(1)} h`;
};
const RUN_WORD = { running: "running", done: "done", failed: "failed", stopped: "stopped" };
// What its tokens come to at Claude API list prices: real money on API credits, plan usage on a subscription.
const runCost = (r) => (r.cost != null ? `$${r.cost.toFixed(2)} at API prices` : "");
const runFolder = (i) => state.allProjects.find((p) => p.slug === i.project)?.path ?? "its folder";

/* ---------- On the board ---------- */

hooks.cardMeta.push((i) => {
	const r = runs.byItem.get(i.id);
	const out = [];
	if (r && !r.ended_at) out.push(`<span class="run-chip running" title="An agent the board started is on it. Open the item to watch it">agent running · ${esc(runFor(r.started_at))}</span>`);
	else if (r && OPEN.includes(i.status) && ["failed", "stopped"].includes(r.status) && Date.now() - parseTime(r.ended_at) < 2 * 86400e3)
		out.push(`<span class="run-chip ${r.status}" title="${esc(r.error || `The agent was ${r.status}`)}">agent ${RUN_WORD[r.status]}</span>`);
	// It ended, but couldn't do everything: its permissions refused it tools. Open the item for which.
	else if (r && OPEN.includes(i.status) && r.refused && Date.now() - parseTime(r.ended_at) < 2 * 86400e3)
		out.push(`<span class="run-chip failed" title="${esc(`The agent's permissions refused ${r.refused}`)}">agent refused tools</span>`);
	if (!runs.info?.on || !OPEN.includes(i.status)) return out.join("");
	if (sendKind(i) === "run" && canSend(i))
		out.push(`<button type="button" class="run-go card-act" data-run-send="${i.id}" title="Start Claude Code on it in ${esc(runFolder(i))}">${glyph("play")}Run</button>`);
	return out.join("");
});

$("#sections").addEventListener("click", async (e) => {
	const b = e.target.closest("[data-run-send]");
	if (!b) return;
	e.stopPropagation();
	b.disabled = true;
	try { await sendItem(b.dataset.runSend); toast("The agent is on it"); }
	catch (err) { b.disabled = false; toast(err.message); }
});

/* ---------- In the reader: the run box (the contract is at the top of this file) ---------- */

const runOf = (item) => (item?.id ? (runs.detail?.item_id === item.id ? runs.detail : runs.byItem.get(item.id)) ?? null : null);
/** A run is going on the item. */
const runLive = (item) => !!(item?.id && runActive(item.id));
/** The "resume the agent" tick shows: an ask of yours that the board can start an agent on now. */
const canResume = (item) => !!item?.id && sendKind(item) === "answer" && canSend(item);
/** The run box for an item, as HTML ("" when there's no run and nothing to start). */
function runPanel(item) {
	const r = runOf(item);
	const offer = !!item?.id && runs.info?.on && sendKind(item) === "run";
	if (!r && !offer) return "";
	let html = `<h3>Agent</h3>`;
	if (r && !r.ended_at)
		html += `<div class="run-head"><span class="run-chip running">running</span><span>for ${esc(runFor(r.started_at))} · started from ${esc(r.started_from)}</span><span class="spacer"></span><button type="button" class="ghost sm danger" data-run-stop="${r.id}">Stop</button></div>`;
	else if (r)
		html += `<div class="run-head"><span class="run-chip ${r.status}">${RUN_WORD[r.status]}</span><span>${esc([`after ${runFor(r.started_at, r.ended_at)}`, runCost(r), `${ago(r.started_at)} from ${r.started_from}`].filter(Boolean).join(" · "))}</span></div>`
			+ (r.error ? `<p class="run-err">${esc(r.error)}</p>` : "")
			+ (r.refused ? `<p class="run-err">Its permissions refused ${esc(r.refused)}. What a run may do is in Settings → Agents → The command.</p>` : "")
			+ (r.result ? `<div class="run-result">${md(r.result)}</div>` : "");
	if (r?.tail !== undefined) {
		const tail = `<pre class="run-tail">${esc(r.tail || "No output yet.")}</pre>`;
		html += r.ended_at ? `<details class="run-out"><summary>Output (the last ${Math.min(200, (r.tail || "").split("\n").length)} lines)</summary>${tail}</details>` : tail;
	}
	if (r?.session) {
		const cmd = `claude --resume ${r.session}`;
		const desk = r.ended_at && runs.info?.desktop ? `<button type="button" class="ghost sm" data-run-desktop="${r.id}">Open in Claude Desktop</button>` : "";
		html += `<div class="run-resume"><span class="run-muted">${r.ended_at ? "Carry on in Claude Code, in" : "Its session, in"} <code>${esc(runFolder(item))}</code>:</span><div class="row"><code class="cmd">${esc(cmd)}</code><button type="button" class="ghost sm" data-copy="${esc(cmd)}">Copy</button></div>${desk ? `<div class="row">${desk}<small class="run-muted">It shows in Claude Desktop's sidebar from then on.</small></div>` : ""}</div>`;
	}
	if (offer && !(r && !r.ended_at)) {
		const why = sendWhy(item);
		html += `<div class="run-offer"><button type="button" class="ghost sm" data-run-start${why ? " disabled" : ""}>${glyph("play")}${r ? "Run again" : "Run"}</button><small>${esc(why || `Starts Claude Code on it in ${runFolder(item)}, headless. It reads the item, works it and finishes or waits, as an agent you started would.`)}</small></div>`;
	}
	return `<div class="run-box">${html}</div>`;
}
// Draws the panel again in place (keeping where the output was scrolled), and looks again in 2 s while it runs.
function runPanelDraw() {
	const p = runs.panel;
	clearTimeout(runs.timer);
	if (!p || !p.el.isConnected) return;
	const old = p.el.querySelector(".run-tail");
	const atEnd = !old || old.scrollHeight - old.scrollTop - old.clientHeight < 30;
	const html = runPanel(p.item);
	if (p.el._html !== html) { p.el.innerHTML = html; p.el._html = html; }
	const t = p.el.querySelector(".run-tail");
	if (t) t.scrollTop = atEnd ? t.scrollHeight : old.scrollTop;
	const r = runOf(p.item);
	if (r && !r.ended_at) runs.timer = setTimeout(() => runPanelPoll(p, r.id), 2000);
}
async function runPanelPoll(p, runId) {
	if (runs.panel !== p || !p.el.isConnected) return;
	try {
		const r = await api(`/api/runs/${runId}`);
		const ended = r.ended_at && !runs.detail?.ended_at;
		runs.detail = r;
		// It's over: the item has changed too (its history, maybe its status).
		if (ended) { await runsLoad(); if (typeof readerRefresh === "function") readerRefresh(p.item.id); }
		runPanelDraw();
	} catch { if (runs.panel === p) runs.timer = setTimeout(() => runPanelPoll(p, runId), 4000); }
}
/** Wires the panel in `el` (which holds runPanel(item)): its buttons, and its output while the run goes on. */
function wireRunPanel(el, item) {
	const p = { el, item };
	runs.panel = p;
	if (runs.detail && runs.detail.item_id !== item.id) runs.detail = null;
	el.addEventListener("click", (e) => runPanelClick(e, p));
	runPanelDraw();
	// The newest run with its output.
	const r = runs.byItem.get(item.id);
	if (r && runs.detail?.id !== r.id) api(`/api/runs/${r.id}`).then((d) => { if (runs.panel === p) { runs.detail = d; runPanelDraw(); } }).catch(() => {});
}
async function runPanelClick(e, p) {
	const stop = e.target.closest("[data-run-stop]");
	const start = e.target.closest("[data-run-start]");
	const desk = e.target.closest("[data-run-desktop]");
	if (desk) {
		desk.disabled = true;
		try {
			await api(`/api/runs/${desk.dataset.runDesktop}/desktop`, { method: "POST", body: "{}" });
			toast("Opening it in Claude Desktop");
		} catch (err) { toast(err.message); }
		desk.disabled = false;
		return;
	}
	if (!stop && !start) return;
	try {
		if (stop) {
			stop.disabled = true;
			stop.textContent = "Stopping…";
			runs.detail = await stopAgent(stop.dataset.runStop);
		} else {
			start.disabled = true;
			const { run } = await sendItem(p.item.id);
			runs.detail = { ...run };
			toast("The agent is on it");
		}
		if (typeof readerRefresh === "function") readerRefresh(p.item.id);
		runPanelDraw();
	} catch (err) { toast(err.message); runPanelDraw(); }
}
hooks.readerClosed.push(() => { clearTimeout(runs.timer); runs.panel = null; });

/* ---------- Settings → Agents ---------- */

TAB_IC.agents = '<rect x="2.25" y="3" width="11.5" height="9.5" rx="1.75"/><path d="m5 6.25 2 1.75-2 1.75M8.5 9.75h2.5"/>';
addSettingsTab({ key: "agents", label: "Agents", local: true, render: () => runsSettings(), load: () => runsLoad(), poll: () => runsLoad() }, "you");

function runRow(r) {
	const took = r.ended_at ? `after ${runFor(r.started_at, r.ended_at)}` : `for ${runFor(r.started_at)}`;
	return `<div class="so-wide run-row"><div class="run-row-main">
		<button type="button" class="run-link" data-run-item="${r.item_id}"><code>wb-${esc(r.ref)}</code> ${esc(r.title)}</button>
		<small>${esc([`#${r.id}`, ago(r.started_at), `from ${r.started_from}`, took, runCost(r), r.error, r.refused && `refused ${r.refused}`].filter(Boolean).join(" · "))}</small></div>
		<span class="run-chip ${r.status}">${RUN_WORD[r.status]}</span>
		${r.ended_at ? "" : `<button type="button" class="ghost sm danger" data-run-stop-set="${r.id}">Stop</button>`}</div>`;
}
function runsSettings() {
	const info = runs.info;
	if (!info || !Object.keys(state.settingDefs).length) return `<div class="set-empty">Loading…</div>`;
	const t = runs.test;
	const testOut = runs.testing ? `<small>Checking…</small>`
		: t ? `<small class="${t.ok ? "run-ok" : "run-bad"}">${t.ok ? `Found ${esc(t.path)}: ${esc(t.version)}. Every flag is one it knows.` : esc(t.problem)}${!t.ok && t.version ? ` (${esc(t.version)})` : ""}</small>` : "";
	const spent = info.cap ? `$${info.spent.toFixed(2)} of $${info.cap} so far today` : info.spent ? `$${info.spent.toFixed(2)} so far today` : "";
	const off = !setting("agents.on");
	return `<div class="agents-tab"><p class="set-intro">The board can start a Claude Code agent on an item: <b>Run</b> on an agent's to-do, <b>Answer &amp; send</b> on a decision (and <b>Object &amp; send</b> on a review or notice). It runs headless in the project's folder, with your Claude account, so it uses your plan's limits (or API credits) as any session does, and nobody watches it while it works: it reads the item, does it, then finishes it or files what it needs from you and waits. Off until you turn it on.</p>
		${optGroup("Starting agents", [
			optRow({ label: "Let the board start agents", hint: "Off: Run and Answer &amp; send don't show, and nothing starts by itself.", bind: { setting: "agents.on" }, control: ctlToggle({ setting: "agents.on" }, { label: "Let the board start agents" }) }),
			optRow({ label: "From a paired phone too", hint: "Off: a phone can answer, but only this computer starts agents.", bind: { setting: "agents.phone" }, control: ctlToggle({ setting: "agents.phone" }, { label: "A paired phone may start agents" }), off }),
			optRow({ label: "When an agent's work is unblocked", hint: "Work that waited on your answer, or on another item, can carry on. <b>Tell me</b>: a notification (Notifications → An agent can carry on), and Run on its card. <b>Send it</b>: the board starts the agent on it by itself, within the limits below.", bind: { setting: "agents.unblocked" }, control: ctlRadios({ setting: "agents.unblocked" }, [["tell", "Tell me"], ["send", "Send it"]], { label: "When an agent's work is unblocked" }), off }),
		])}
		${optGroup("Limits", [
			optRow({ label: "At once, at most", hint: `${info.running} running now.`, bind: { setting: "agents.at-once" }, control: ctlNumber({ setting: "agents.at-once" }, { min: 1, max: 10, unit: "agents", label: "Agents running at once, at most" }), off }),
			optRow({ label: "Per day, at most", hint: `${info.today} started today. A day starts at ${String(setting("day.start")).padStart(2, "0")}:00 (You and your day).`, bind: { setting: "agents.per-day" }, control: ctlNumber({ setting: "agents.per-day" }, { min: 1, max: 200, unit: "agents", label: "Agents started per day, at most" }), off }),
			optRow({ label: "A day's usage, at most", hint: `No new agent once the ones started today come to this much at Claude API list prices, as <a href="/usage">Usage</a> counts their sessions (or what they reported, if more). On a subscription you don't pay it: it's a measure of how much of your plan's limits they take. A run already going isn't stopped. 0: no cap.${spent ? ` <b>${esc(spent)}</b> at API prices.` : ""}`, bind: { setting: "agents.day-dollars" }, control: ctlNumber({ setting: "agents.day-dollars" }, { min: 0, max: 10000, unit: "dollars", label: "No new agent once today's runs come to this many dollars at API prices (0 for no cap)" }), off }),
		])}
		${optGroup("The command", [`<div class="so-wide run-cmd">
			<textarea data-setting="agents.command" data-type="string" rows="3" spellcheck="false" aria-label="The command that starts an agent">${esc(setting("agents.command"))}</textarea>
			<div class="row"><button type="button" class="ghost sm" data-run-test${runs.testing ? " disabled" : ""}>Test the command</button>${JSON.stringify(setting("agents.command")) !== JSON.stringify(state.settingDefs["agents.command"]?.default) ? `<button type="button" class="ghost sm" data-reset="setting:agents.command">Back to the default</button>` : ""}${testOut}</div>
			<p class="hint">Runs with bash in the project's folder, with your shell's PATH, and gets <code>$WB_PROMPT</code> (what the agent is told, below), <code>$WB_ITEM</code> (wb-xxxx), <code>$WB_TITLE</code>, <code>$WB_PROJECT</code> and <code>$WB_SESSION</code> (a new session id, so you can carry on with <code>claude --resume</code>). Test the command only asks the program its version and its flags: no agent starts.</p>
			<p class="hint"><b>What it may do unattended.</b> <code>--permission-mode auto</code>: it edits files and runs commands, and Claude Code's own checks refuse what looks risky, since nobody is there to ask. The board's tools are always allowed (<code>--allowedTools mcp__wb</code>). <code>-w</code>: it works in a git worktree of its own, on a new branch, so your checkout isn't touched; the branch stays until it's merged. To let it do less, use <code>--permission-mode dontAsk</code> in place of <code>auto</code>: then only what your Claude Code settings already allow (<code>permissions.allow</code> in <code>~/.claude/settings.json</code> and the project's <code>.claude/settings.json</code>) runs, and the rest is refused. A run whose tools were refused says so on its card. <code>--max-budget-usd 5</code> caps one run's cost.</p>
			<details class="fold run-prompt" data-key="run-prompt"${isOpen("run-prompt")}><summary>What the agent is told</summary><pre>${esc(info.prompt)}</pre></details></div>`],
			"The default is Claude Code's print mode with streaming output, so the board can show what the agent does as it goes.")}
		${optGroup("Recent runs", info.runs.length ? info.runs.map(runRow) : [`<div class="so-wide set-empty">No agent has been started yet.</div>`])}
	</div>`;
}
$("#settings-view").addEventListener("click", async (e) => {
	const test = e.target.closest("[data-run-test]");
	const stop = e.target.closest("[data-run-stop-set]");
	const open = e.target.closest("[data-run-item]");
	if (test) {
		runs.testing = true;
		renderSettings();
		const command = $('#settings-view textarea[data-setting="agents.command"]')?.value;
		try { runs.test = await api("/api/runs/test", { method: "POST", body: JSON.stringify({ command }) }); }
		catch (err) { runs.test = { ok: false, problem: err.message }; }
		runs.testing = false;
		renderSettings();
	} else if (stop) {
		stop.disabled = true;
		try { await stopAgent(stop.dataset.runStopSet); } catch (err) { toast(err.message); }
		renderSettings();
	} else if (open) {
		try { await openItemById(open.dataset.runItem); } catch (err) { toast(err.message); }
	}
});
onSettingsChange((key) => {
	if (key === "agents.command") runs.test = null;
	if (!key || key.startsWith("agents.")) runsLoad();
});
/* ---------- end: Answer & send ---------- */
