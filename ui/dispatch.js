/* ---------- Answer & send: agents the board starts (dispatch.ts) ---------- */
// Run on an agent's to-do, and Answer & send on a decision (or Object & send on a review or notice): the board starts
// Claude Code headless in the project's folder on that item. A card shows a running agent, and Run; the item dialog
// shows its output live, Stop, and afterwards how it went, what it cost and how to continue the session.
// Settings → Agents turns it on and holds the limits.
// The calls below don't touch the page, so other views (the one-at-a-time queue) can use them: canSend(item),
// sendWhy(item), sendItem(id), answerAndSend(id, answer | picks[]), objectAndSend(id, text), stopAgent(runId).

const runs = { info: null, byItem: new Map(), detail: null, timer: 0, fast: 0, test: null, testing: false, armed: new Set() };
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
	if (typeof askTicks !== "undefined") askTicks.delete(Number(id));
	await Promise.all([loadItems(), loadProjects(), runsLoad()]);
	refreshReport();
	return res;
}
/** Starts an agent on an agent's to-do. Returns { run, item }. */
const sendItem = (id) => runAfter(id, {});
/** Answers a decision (an option, your words, or the ticked options of a pick-many one), then starts an agent on it.
 * Nothing is answered when the agent can't start. Returns { run, item }. */
const answerAndSend = (id, answer) => runAfter(id, { answer });
/** Objects to a review or notice in your words, then starts an agent on it. Returns { run, item }. */
const objectAndSend = (id, text) => runAfter(id, { object: text });
/** Stops a run: the agent and everything it started. */
async function stopAgent(runId) {
	const r = await api(`/api/runs/${runId}/stop`, { method: "POST", body: "{}" });
	await runsLoad();
	return r;
}

/* Words and bits shared by the card, the dialog and Settings. */
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
	const kind = sendKind(i);
	if (kind === "run" && canSend(i))
		out.push(`<button type="button" class="run-go card-act" data-run-send="${i.id}" title="Start Claude Code on it in ${esc(runFolder(i))}">${glyph("play")}Run</button>`);
	// Answer & send on a decision you answer on the card: when on, the answer also starts the agent.
	else if (kind === "answer" && i.kind === "decision" && optionsOf(i).length && canSend(i)) {
		const on = runs.armed.has(i.id);
		out.push(`<button type="button" class="run-arm card-act${on ? " on" : ""}" data-run-arm="${i.id}" aria-pressed="${on}" title="${on ? "Your answer also starts an agent on it" : "Then your answer also starts an agent on it, in " + esc(runFolder(i))}">${on ? "✓ " : ""}Answer &amp; send</button>`);
	}
	return out.join("");
});

// The board's and asks.js's answer buttons, when Answer & send is on for that card: answer and start in one go.
// Capture phase, so their own handlers don't answer it first.
$("#sections").addEventListener("click", async (e) => {
	const b = e.target.closest("[data-answer], [data-ask-answer], [data-ask-send]");
	const id = Number(b?.dataset.answer || b?.dataset.askAnswer || b?.dataset.askSend);
	if (!b || !runs.armed.has(id)) return;
	e.stopPropagation();
	e.preventDefault();
	const i = state.items.find((x) => x.id === id);
	const answer = b.dataset.askSend ? [...askTicked(i)] : b.dataset.choice;
	b.classList.add("picked");
	try {
		await answerAndSend(id, answer);
		runs.armed.delete(id);
		toast("Answered. The agent is on it");
	} catch (err) { b.classList.remove("picked"); toast(err.message); }
}, true);
$("#sections").addEventListener("click", async (e) => {
	const b = e.target.closest("[data-run-send], [data-run-arm]");
	if (!b) return;
	e.stopPropagation();
	if (b.dataset.runArm) {
		const id = Number(b.dataset.runArm);
		if (runs.armed.has(id)) runs.armed.delete(id); else runs.armed.add(id);
		return renderBoard();
	}
	b.disabled = true;
	try { await sendItem(b.dataset.runSend); toast("The agent is on it"); }
	catch (err) { b.disabled = false; toast(err.message); }
});

/* ---------- In the item dialog ---------- */

const runBox = document.createElement("div");
runBox.className = "answer-box run-box";
runBox.id = "run-box";
runBox.hidden = true;
$("#code-box").before(runBox);
// "Then start the agent" next to a decision's answer, and next to an objection to a review or notice.
const runArmRow = (where) => `<label class="run-arm-row" data-run-where="${where}"><input type="checkbox" data-run-dlg> <span><b>Answer &amp; send</b> <small></small></span></label>`;
$("#answer-box").insertAdjacentHTML("beforeend", runArmRow("answer"));
$("#ask-reply")?.insertAdjacentHTML("beforeend", runArmRow("object"));

function runArmFill(item) {
	const ok = !!item.id && sendKind(item) === "answer" && canSend(item);
	for (const row of document.querySelectorAll("#dlg .run-arm-row")) {
		const object = row.dataset.runWhere === "object";
		row.hidden = !ok || (object && item.kind === "decision");
		row.querySelector("input").checked = runs.armed.has(item.id);
		row.querySelector("b").textContent = object ? "Object & send" : "Answer & send";
		row.querySelector("small").textContent = `then start an agent on it in ${runFolder(item)}`;
	}
}

function runBoxFill(item) {
	clearTimeout(runs.timer);
	const r = item.id ? (runs.detail?.item_id === item.id ? runs.detail : runs.byItem.get(item.id)) : null;
	const kind = sendKind(item);
	const offer = item.id && runs.info?.on && kind === "run";
	runBox.hidden = !r && !offer;
	if (runBox.hidden) return;
	let html = `<h3>Agent</h3>`;
	if (r && !r.ended_at)
		html += `<div class="run-head"><span class="run-chip running">running</span><span>for ${esc(runFor(r.started_at))} · started from ${esc(r.started_from)}</span><span class="spacer"></span><button type="button" class="ghost sm danger" data-run-stop="${r.id}">Stop</button></div>`;
	else if (r)
		html += `<div class="run-head"><span class="run-chip ${r.status}">${RUN_WORD[r.status]}</span><span>${esc([`after ${runFor(r.started_at, r.ended_at)}`, runCost(r), `${ago(r.started_at)} from ${r.started_from}`].filter(Boolean).join(" · "))}</span></div>`
			+ (r.error ? `<p class="run-err">${esc(r.error)}</p>` : "")
			+ (r.refused ? `<p class="run-err">Its permissions refused ${esc(r.refused)}. What a run may do is in Settings → Agents → The command.</p>` : "")
			+ (r.result ? `<div class="run-result">${md(r.result)}</div>` : "");
	if (r?.tail !== undefined) {
		const tail = `<pre class="run-tail" id="run-tail">${esc(r.tail || "No output yet.")}</pre>`;
		html += r.ended_at ? `<details class="run-out"><summary>Output (the last ${Math.min(200, (r.tail || "").split("\n").length)} lines)</summary>${tail}</details>` : tail;
	}
	if (r?.session) {
		const cmd = `claude --resume ${r.session}`;
		const desk = r.ended_at && runs.info?.desktop ? `<button type="button" class="ghost sm" data-run-desktop="${r.id}">Open in Claude Desktop</button>` : "";
		html += `<div class="run-resume"><span class="run-muted">${r.ended_at ? "Carry on in Claude Code, in" : "Its session, in"} <code>${esc(runFolder(item))}</code>:</span><div class="row"><code class="cmd">${esc(cmd)}</code><button type="button" class="ghost sm" data-copy="${esc(cmd)}">Copy</button></div>${desk ? `<div class="row">${desk}<small class="run-muted">It shows in Claude Desktop's sidebar from then on.</small></div>` : ""}</div>`;
	}
	if (offer && !(r && !r.ended_at)) {
		const why = sendWhy(item);
		html += `<div class="run-offer"><button type="button" class="primary sm" data-run-start${why ? " disabled" : ""}>${glyph("play")}${r ? "Run again" : "Run"}</button><small>${esc(why || `Starts Claude Code on it in ${runFolder(item)}, headless. It reads the item, works it and finishes or waits, as an agent you started would.`)}</small></div>`;
	}
	runBox.innerHTML = html;
	const t = $("#run-tail");
	if (t && !r.ended_at) t.scrollTop = t.scrollHeight;
	// The output, live, while the dialog shows it.
	if (r && !r.ended_at) runs.timer = setTimeout(() => runDetail(item.id, r.id), 2000);
}
async function runDetail(itemId, runId) {
	if (!dlg.open || state.current?.id !== itemId) return;
	try {
		const r = await api(`/api/runs/${runId}`);
		const ended = r.ended_at && !runs.detail?.ended_at;
		runs.detail = r;
		if (ended) {
			// It's over: the item has changed too (its history, maybe its status).
			await runsLoad();
			const fresh = await api(`/api/items/${itemId}`);
			if (dlg.open && state.current?.id === itemId) { state.current = { ...state.current, status: fresh.status, owner: fresh.owner, notes: fresh.notes }; renderHistory(); }
		}
		const t = $("#run-tail");
		const atEnd = !t || t.scrollHeight - t.scrollTop - t.clientHeight < 30;
		runBoxFill(state.current);
		if (!atEnd && $("#run-tail")) $("#run-tail").scrollTop = t.scrollTop;
	} catch { runs.timer = setTimeout(() => runDetail(itemId, runId), 4000); }
}
hooks.itemOpen.push(async (item, isNew) => {
	runs.detail = null;
	runArmFill(isNew ? {} : item);
	runBoxFill(isNew ? {} : item);
	// The newest run with its output.
	const r = !isNew && runs.byItem.get(item.id);
	if (r) {
		try {
			runs.detail = await api(`/api/runs/${r.id}`);
			if (state.current?.id === item.id) runBoxFill(state.current);
		} catch {}
	}
});
dlg.addEventListener("close", () => clearTimeout(runs.timer));
runBox.addEventListener("click", async (e) => {
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
	const item = state.current;
	try {
		if (stop) {
			stop.disabled = true;
			stop.textContent = "Stopping…";
			runs.detail = await stopAgent(stop.dataset.runStop);
		} else {
			start.disabled = true;
			const { run } = await sendItem(item.id);
			runs.detail = { ...run };
			toast("The agent is on it");
		}
		const fresh = await api(`/api/items/${item.id}`);
		if (state.current?.id === item.id) { state.current = { ...state.current, status: fresh.status, notes: fresh.notes }; renderHistory(); runBoxFill(state.current); }
	} catch (err) { $("#err").textContent = err.message; runBoxFill(item); }
});
$("#dlg").addEventListener("change", (e) => {
	if (!e.target.matches("[data-run-dlg]") || !state.current?.id) return;
	if (e.target.checked) runs.armed.add(state.current.id); else runs.armed.delete(state.current.id);
	runArmFill(state.current);
	renderBoard();
});
// The dialog's answers and objection, with Answer & send ticked: answer (or object) and start in one go. Capture
// phase, so item.js and asks.js don't send it first.
async function runDlgSend(e, how) {
	const id = state.current?.id;
	if (!id || !runs.armed.has(id)) return;
	e.stopPropagation();
	e.preventDefault();
	try {
		const { item } = how.object !== undefined ? await objectAndSend(id, how.object) : await answerAndSend(id, how.answer);
		runs.armed.delete(id);
		toast("Sent. The agent is on it");
		openItem(item);
	} catch (err) { $("#err").textContent = err.message; }
}
$("#dlg").addEventListener("click", (e) => {
	const choice = e.target.closest("#answer-opts [data-choice]");
	if (choice) return runDlgSend(e, { answer: choice.dataset.choice });
	if (e.target.closest("#answer-send") && $("#answer-own").value.trim()) return runDlgSend(e, { answer: $("#answer-own").value.trim() });
	if (e.target.closest("#ask-dsend")) return runDlgSend(e, { answer: [...$("#answer-opts").querySelectorAll("[data-ask-dtick]:checked")].map((b) => b.value) });
	if (e.target.closest("#ask-object-send") && $("#ask-object").value.trim()) return runDlgSend(e, { object: $("#ask-object").value.trim() });
}, true);
$("#dlg").addEventListener("keydown", (e) => {
	if (e.key !== "Enter") return;
	if (e.target.id === "answer-own" && e.target.value.trim()) runDlgSend(e, { answer: e.target.value.trim() });
	else if (e.target.id === "ask-object" && e.target.value.trim()) runDlgSend(e, { object: e.target.value.trim() });
}, true);

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
