/* ---------- Answer & send: agents the board starts (dispatch.ts) ---------- */
// Run on an agent's to-do, and "resume the agent" with an answer or an objection (ui/answer.js, { send: true }): the
// board starts Claude Code headless in the project's folder on that item. A card shows a running agent, and Run; the
// reader shows its output live, Stop, and afterwards how it went, what it cost and how to continue the session.
// Settings → Agents turns it on and holds the limits.
// The calls below don't touch the page, so other views (the one-at-a-time queue) can use them: canSend(item),
// sendWhy(item), sendItem(id), stopAgent(runId).
// What the reader (ui/reader.js) asks of this file, its whole contract:
//   runPanel(item) → HTML: the run box for the item ("" for none): its runs, what the agent did, the controls.
//   wireRunPanel(el, item): `el` holds runPanel's HTML; its clicks and, while a run is live, what it does every 2 s,
//     drawn into `el` (with el._html kept in step) until `el` leaves the page or is wired again.
//   runLive(item) → boolean: a run is going, so the reader puts the box near the top.
//   canResume(item) → boolean: the "resume the agent" tick shows next to Answer and Object (a fresh agent).
//   canContinue(item) → boolean, continueAgent(item, text) → item: the reply box's "send to the agent" tick, and
//     sending a note that way (the agent carries on in its session). The conversation is that one box.
// It calls readerRefresh(itemId) when a run starts, ends or is stopped, and readerTellAgent(itemId) for the panel's
// "Tell the agent…" (the reader turns the tick on and puts you in its reply box).

const runs = { info: null, byItem: new Map(), timer: 0, fast: 0, test: null, testing: false, panel: null };
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
const RUN_WORD = { running: "running", done: "done", failed: "failed", stopped: "stopped" };
// What its tokens come to at Claude API list prices: real money on API credits, plan usage on a subscription.
const runCost = (r) => (r.cost != null ? `$${r.cost.toFixed(2)} at API prices` : "");
const runFolder = (i) => state.allProjects.find((p) => p.slug === i.project)?.path ?? "its folder";

/* ---------- On the board ---------- */

hooks.cardMeta.push((i) => {
	const r = runs.byItem.get(i.id);
	const out = [];
	if (r && !r.ended_at) out.push(`<span class="run-chip running" title="An agent the board started is on it. Open the item to watch it">agent running · ${esc(took(r.started_at))}</span>`);
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

/* ---------- In the reader: the agent's side of the item (the contract is at the top of this file) ---------- */
// The run box: a header (state, how long, what it cost, where it ran, a switcher between the item's runs), what the
// agent said and did (GET /api/runs/:id/events, followed every 2 s while it runs), and the controls: Stop, Open in
// Claude Desktop (a claude:// link the page opens itself, so the cloud board's too), Copy the resume command, Tell
// the agent… (which turns on "send to the agent" in the reader's reply box: the conversation is that one box) and
// Run again.

Object.assign(GLYPH, {
	"ev-edit": '<path d="M3 13l.6-2.6L10.4 3.6a1.3 1.3 0 0 1 1.9 0l.1.1a1.3 1.3 0 0 1 0 1.9L5.6 12.4z"/>',
	"ev-run": '<rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="m4.75 6.25 1.75 1.5-1.75 1.5M8 9.5h2.75"/>',
	"ev-read": '<path d="M4 2.5h5l3 3v8H4z"/><path d="M9 2.5v3h3"/>',
	"ev-search": '<circle cx="7" cy="7" r="3.75"/><path d="m10 10 3 3"/>',
	"ev-wb": '<rect x="2.5" y="2.5" width="11" height="11" rx="2"/><path d="M5.5 6h5M5.5 8.5h3"/>',
	"ev-tool": '<circle cx="8" cy="8" r="2"/>',
});
const RUN_SHOWN = 12;
const RUN_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// What the panel knows about the item it shows: its runs (newest first), the one picked, each one's events.
const runView = { item: 0, list: null, sel: 0, ev: new Map(), all: new Set(), busy: false };
function rvFor(id) {
	if (runView.item !== id) Object.assign(runView, { item: id, list: null, sel: 0, ev: new Map(), all: new Set() });
	return runView;
}
/** The item's runs, newest first: what the panel loaded, else the newest the board knows of. */
function runsOf(item) {
	const v = runView.item === item.id ? runView : null;
	const known = runs.byItem.get(item.id);
	const list = v?.list ? [...v.list] : known ? [known] : [];
	// The board's list may know of a newer one (started elsewhere) before the panel looks again.
	if (known && !list.some((r) => r.id === known.id)) list.unshift(known);
	return list.sort((a, b) => b.id - a.id);
}
const runOf = (item) => {
	if (!item?.id) return null;
	const list = runsOf(item);
	return (runView.item === item.id && list.find((r) => r.id === runView.sel)) || list[0] || null;
};
/** Puts what the server said of a run into the panel's list. */
function rvTake(r) {
	if (!r || runView.item !== r.item_id) return;
	const list = runView.list ?? [];
	const at = list.findIndex((x) => x.id === r.id);
	if (at < 0) list.unshift(r); else list[at] = { ...list[at], ...r };
	runView.list = list;
	// The board's newest-run map follows, so the card and the "live" check agree with the panel.
	const known = runs.byItem.get(r.item_id);
	if (!known || known.id <= r.id) runs.byItem.set(r.item_id, { ...(known?.id === r.id ? known : {}), ...r });
}
/** A run is going on the item. */
const runLive = (item) => !!(item?.id && (runActive(item.id) || runsOf(item).some((r) => !r.ended_at)));
/** The "resume the agent" tick shows: an ask of yours that the board can start an agent on now. */
const canResume = (item) => !!item?.id && sendKind(item) === "answer" && canSend(item);
/** Why the item's agent can't be sent a message now ('' when it can): it continues the newest run's session. */
function continueWhy(item) {
	const info = runs.info;
	if (!item?.id || !info) return "Loading…";
	const r = runsOf(item)[0];
	if (!r || !RUN_UUID.test(r.session || "")) return "No agent session on it to continue.";
	if (runLive(item)) return "The agent is still working: wait for it to finish, or stop it.";
	if (!info.on) return "The board doesn't start agents: turn it on in Settings → Agents.";
	if (!info.allowed) return info.why || "Agents start only from this computer.";
	if (!info.folders.includes(item.project)) return "No computer that's online has its project's folder.";
	if (info.continueCommand === "") return "The board can't make a continue command from yours: set one in Settings → Agents.";
	if (info.limited) return info.why;
	return "";
}
/** The reader's reply box may send to the agent: its last run ended with a session it can carry on. */
const canContinue = (item) => !continueWhy(item);
/** Sends the agent `text`: a new run carries on in its session (POST /api/runs/:id/continue). Returns the item. */
async function continueAgent(item, text) {
	const r = runsOf(item)[0];
	if (!r) throw new Error("No agent session on it to continue.");
	touched(item.id);
	const res = await api(`/api/runs/${r.id}/continue`, { method: "POST", body: JSON.stringify({ message: text }) });
	rvFor(item.id);
	rvTake(res.run);
	runView.sel = res.run.id;
	await Promise.all([loadItems(), runsLoad()]);
	return res.item;
}
/** Run again: an agent's to-do, or one whose last run failed or was stopped, or that stalled while doing. */
function restartKind(i) {
	if (!i?.id || i.owner !== "agent" || i.kind === "idea" || !OPEN.includes(i.status) || runLive(i)) return "";
	if (i.status === "todo") return "run";
	const last = runsOf(i)[0];
	const broke = !!last?.ended_at && ["failed", "stopped"].includes(last.status);
	if (i.status === "doing" && (broke || i.stale?.why === "stalled")) return "restart";
	if (i.status === "waiting" && broke && !(i.waits_on?.length ?? i.waiting_on)) return "restart";
	return "";
}
function restartWhy(i) {
	const info = runs.info;
	if (!info) return "Loading…";
	if (!info.on) return "The board doesn't start agents: turn it on in Settings → Agents.";
	if (!info.allowed) return info.why || "Agents start only from this computer.";
	if (!info.folders.includes(i.project)) return CLOUD ? "No computer that's online has its project's folder (Settings → Projects)." : "Its project has no folder on this computer (Settings → Projects).";
	if (info.limited) return info.why;
	return "";
}

/* What it said and did. */
const runWhere = (r) => {
	const c = r.cwd || "";
	const wt = c.match(/\/\.claude\/worktrees\/([^/]+)\/?$/);
	return wt ? wt[1] : c ? c.split("/").filter(Boolean).at(-1) ?? c : "";
};
const evGlyph = (tool = "") =>
	/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(tool) ? "ev-edit" : /^(Bash|PowerShell)$/.test(tool) ? "ev-run" : tool === "Read" ? "ev-read"
		: /^(Grep|Glob|WebSearch|WebFetch)$/.test(tool) ? "ev-search" : tool.startsWith("mcp__wb__") ? "ev-wb" : "ev-tool";
const evTool = (e) => (e.tool?.startsWith("mcp__wb__") ? e.text.replace(/^mcp__wb__/, "wb ") : e.text);
const minsOf = (ms) => { const m = Math.round(ms / 60e3); return m < 1 ? "under a minute" : m < 90 ? `${m} min` : `${(m / 60).toFixed(1)} h`; };
function evHtml(e) {
	switch (e.kind) {
		case "message": return `<div class="ev ev-msg"><span class="ev-who">${esc(typeof rdName === "function" ? rdName() : "You")}</span>${md(e.text)}</div>`;
		case "start": return `<div class="ev ev-start">${esc(e.text)}</div>`;
		case "text": return `<div class="ev ev-text">${md(e.text)}</div>`;
		case "tool": return `<div class="ev ev-tool" title="${esc(e.text)}">${glyph(evGlyph(e.tool))}<span>${esc(evTool(e))}</span></div>`;
		case "error": return `<div class="ev ev-err">${e.refused ? `<b>refused${e.tool ? ` ${esc(e.tool)}` : ""}</b> ` : e.tool ? `<b>${esc(e.tool)}</b> ` : ""}${esc(e.text)}</div>`;
		case "result": {
			const facts = [e.is_error ? "ended with an error" : "finished", e.turns != null && `${e.turns} turn${e.turns === 1 ? "" : "s"}`, e.duration_ms != null && minsOf(e.duration_ms), e.cost != null && `$${e.cost.toFixed(2)} at API prices`].filter(Boolean).join(" · ");
			return `<div class="ev ev-result${e.is_error ? " bad" : ""}"><div class="ev-facts">${esc(facts)}</div>${e.text ? md(e.text) : ""}</div>`;
		}
		default: return `<div class="ev ev-out">${esc(e.text)}</div>`;
	}
}
function feedHtml(r) {
	const got = runView.ev.get(r.id);
	if (!got) return `<div class="run-feed"><p class="run-muted">Loading what it did…</p></div>`;
	// Older runs (and an old helper's) have no events: their last lines of output.
	if (!got.events.length) return r.tail ? `<pre class="run-tail">${esc(r.tail)}</pre>` : `<div class="run-feed"><p class="run-muted">${r.ended_at ? "It left no output." : "Nothing yet."}</p></div>`;
	const all = runView.all.has(r.id), n = got.events.length;
	const shown = all ? got.events : got.events.slice(-RUN_SHOWN);
	const more = n > shown.length ? `<button type="button" class="rd-link run-all" data-run-all>Show all ${n}</button>` : "";
	return `<div class="run-feed${r.ended_at ? "" : " live"}" aria-live="polite">${more}${shown.map(evHtml).join("")}</div>`;
}
function headHtml(item, r, list) {
	const live = !r.ended_at;
	const state = live ? `<span class="run-chip running">running · ${esc(took(r.started_at))}</span>`
		: `<span class="run-chip ${r.status}">${r.status === "done" ? "finished" : RUN_WORD[r.status]}</span>`;
	const facts = [!live && took(r.started_at, r.ended_at), runCost(r)].filter(Boolean).join(" · ");
	const where = runWhere(r);
	const pick = list.length > 1 ? `<span class="run-pick" role="group" aria-label="The item's runs">${list.slice(0, 6).map((x) => `<button type="button" class="${x.id === r.id ? "on" : ""}${x.ended_at ? "" : " live"}" data-run-pick="${x.id}" title="${esc(`${RUN_WORD[x.status]} · ${ago(x.started_at)}`)}"${x.id === r.id ? ' aria-current="true"' : ""}>#${x.id}</button>`).join("")}</span>` : "";
	return `<div class="run-top"><h3>Agent</h3>${state}${facts ? `<span class="run-muted">${esc(facts)}</span>` : ""}${where ? `<code class="run-where" title="${esc(r.cwd)}">${esc(where)}</code>` : ""}<span class="spacer"></span>${pick}</div>
		<div class="run-sub">${esc([`#${r.id}`, r.continues && `continues #${r.continues}`, `${ago(r.started_at)} from ${r.started_from}`].filter(Boolean).join(" · "))}</div>`;
}
function actsHtml(item, r) {
	const b = [];
	const live = r && !r.ended_at;
	if (live) b.push(`<button type="button" class="ghost sm danger" data-run-stop="${r.id}">Stop</button>`);
	const newest = r && runsOf(item)[0]?.id === r.id;
	if (r && newest && !live && RUN_UUID.test(r.session || "")) {
		const why = continueWhy(item);
		b.push(`<button type="button" class="${why ? "ghost" : "primary"} sm" data-run-tell${why ? ` disabled title="${esc(why)}"` : ' title="Write to the agent in the box below: it carries on in the same session"'}>Tell the agent…</button>`);
	}
	if (r?.desktop) b.push(`<a class="ghost sm btn" href="${esc(r.desktop)}" title="Opens the session in Claude Desktop on this computer (it shows in its sidebar from then on)">Open in Claude Desktop</a>`);
	if (r?.session) b.push(`<button type="button" class="ghost sm" data-run-copy="${esc(`${r.cwd ? `cd ${shq(r.cwd)} && ` : ""}claude --resume ${r.session}`)}" title="To carry on in a terminal">Copy resume command</button>`);
	const again = restartKind(item);
	if (again) {
		const why = restartWhy(item);
		b.push(`<button type="button" class="${r ? "ghost" : "primary"} sm" data-run-start${why ? ` disabled title="${esc(why)}"` : ` title="${esc(`A fresh agent on it in ${runFolder(item)}: it reads the item and works it`)}"`}>${glyph("play")}${r ? "Run again" : "Run"}</button>`);
	}
	return b.length ? `<div class="run-acts">${b.join("")}</div>` : "";
}
const shq = (s) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

/** The run box for an item, as HTML ("" when there's no run and nothing to start). */
function runPanel(item) {
	if (!item?.id) return "";
	const r = runOf(item);
	if (!r) {
		if (!runs.info?.on || !restartKind(item)) return "";
		const why = restartWhy(item);
		return `<div class="run-box"><div class="run-top"><h3>Agent</h3></div>${actsHtml(item, null)}<p class="run-muted run-hint">${esc(why || `Starts Claude Code on it in ${runFolder(item)}, headless: it reads the item, works it, and finishes it or files what it needs from you and waits.`)}</p></div>`;
	}
	const list = runsOf(item);
	return `<div class="run-box">${headHtml(item, r, list)}
		${r.error ? `<p class="run-err">${esc(r.error)}</p>` : ""}
		${r.refused ? `<p class="run-err">Its permissions refused ${esc(r.refused)}. What a run may do is in Settings → Agents → The command.</p>` : ""}
		${feedHtml(r)}${actsHtml(item, r)}</div>`;
}

/* Drawing it again in place, following what it does while it runs. */
function runPanelDraw() {
	const p = runs.panel;
	if (!p || !p.el.isConnected) return;
	const old = p.el.querySelector(".run-feed, .run-tail");
	const atEnd = !old || old.scrollHeight - old.scrollTop - old.clientHeight < 30;
	const top = old?.scrollTop ?? 0;
	const html = runPanel(p.item);
	if (p.el._html !== html) { p.el.innerHTML = html; p.el._html = html; }
	const feed = p.el.querySelector(".run-feed, .run-tail");
	// It follows the bottom, unless you scrolled up in it.
	if (feed) feed.scrollTop = atEnd ? feed.scrollHeight : top;
}
async function runEventsLoad(id) {
	const got = runView.ev.get(id) ?? { events: [], next: -1 };
	const res = await api(`/api/runs/${id}/events${got.next >= 0 ? `?after=${got.next}` : ""}`);
	const events = got.next >= 0 ? [...got.events, ...res.events.filter((e) => e.n > got.next)] : res.events;
	runView.ev.set(id, { events, next: res.next });
	return res.run;
}
/** Looks again: the picked run's events (and the newest's while it runs), every 2 s while one runs. */
async function runPanelPoll(p) {
	clearTimeout(runs.timer);
	if (runs.panel !== p || !p.el.isConnected) return;
	const wasLive = runLive(p.item);
	try {
		const r = runOf(p.item);
		const ids = new Set([r?.id, ...runsOf(p.item).filter((x) => !x.ended_at).map((x) => x.id)].filter(Boolean));
		for (const id of ids) {
			const was = runsOf(p.item).find((x) => x.id === id);
			if (was?.ended_at && runView.ev.has(id)) continue;
			const run = await runEventsLoad(id);
			// Without events (an old helper), the output's last lines are on the run itself.
			const full = !runView.ev.get(id).events.length ? await api(`/api/runs/${id}`) : run;
			if (runs.panel !== p) return;
			rvTake(full);
		}
		runPanelDraw();
		// It's over: the item has changed too (its history, maybe its status).
		if (wasLive && !runLive(p.item)) {
			await runsLoad();
			runPanelDraw();
			// The box moves below the brief now, and the reply box may send to the agent.
			if (typeof readerRedraw === "function") readerRedraw(p.item.id);
			if (typeof readerRefresh === "function") readerRefresh(p.item.id);
		}
	} catch {}
	if (runs.panel === p && runLive(p.item)) runs.timer = setTimeout(() => runPanelPoll(p), 2000);
}
/** Wires the panel in `el` (which holds runPanel(item)): its buttons, and its output while the run goes on. */
function wireRunPanel(el, item) {
	const p = { el, item };
	runs.panel = p;
	clearTimeout(runs.timer);
	const v = rvFor(item.id);
	el.addEventListener("click", (e) => runPanelClick(e, p));
	runPanelDraw();
	// The item's runs (with their output), once per item; then what they did.
	// (A copy: api() hands back the very object it cached.)
	(v.list ? Promise.resolve() : api(`/api/runs?item=${item.id}`).then((list) => {
		if (runView.item !== item.id) return;
		runView.list = list.map((x) => ({ ...x }));
		if (typeof readerRedraw === "function") readerRedraw(item.id);
	}))
		.catch(() => {})
		.then(() => runPanelPoll(p));
}
async function runPanelClick(e, p) {
	const q = (s) => e.target.closest(s);
	const pick = q("[data-run-pick]");
	if (pick) { runView.sel = Number(pick.dataset.runPick); runPanelDraw(); return runPanelPoll(p); }
	if (q("[data-run-all]")) { runView.all.add(runOf(p.item)?.id); return runPanelDraw(); }
	const copy = q("[data-run-copy]");
	if (copy) {
		toast((await copyText(copy.dataset.runCopy)) ? "Copied: paste it in a terminal on the computer it ran on" : `Couldn't copy it: ${copy.dataset.runCopy}`);
		return;
	}
	if (q("[data-run-tell]")) { if (typeof readerTellAgent === "function") readerTellAgent(p.item.id); return; }
	const stop = q("[data-run-stop]");
	const start = q("[data-run-start]");
	if (!stop && !start) return;
	try {
		if (stop) {
			stop.disabled = true;
			stop.textContent = "Stopping…";
			rvTake(await stopAgent(stop.dataset.runStop));
		} else {
			start.disabled = true;
			const { run } = await sendItem(p.item.id);
			rvTake(run);
			runView.sel = run.id;
			toast("The agent is on it");
		}
		if (typeof readerRefresh === "function") readerRefresh(p.item.id);
		runPanelDraw();
		runPanelPoll(p);
	} catch (err) { toast(err.message); runPanelDraw(); }
}
hooks.readerClosed.push(() => { clearTimeout(runs.timer); runs.panel = null; });

/* ---------- Settings → Agents ---------- */

TAB_IC.agents = '<rect x="2.25" y="3" width="11.5" height="9.5" rx="1.75"/><path d="m5 6.25 2 1.75-2 1.75M8.5 9.75h2.5"/>';
addSettingsTab({ key: "agents", label: "Agents", local: true, render: () => runsSettings(), load: () => runsLoad(), poll: () => runsLoad() }, "you");

function runRow(r) {
	const howLong = r.ended_at ? `after ${took(r.started_at, r.ended_at)}` : `for ${took(r.started_at)}`;
	return `<div class="so-wide run-row"><div class="run-row-main">
		<button type="button" class="run-link" data-run-item="${r.item_id}"><code>wb-${esc(r.ref)}</code> ${esc(r.title)}</button>
		<small>${esc([`#${r.id}`, ago(r.started_at), `from ${r.started_from}`, howLong, runCost(r), r.error, r.refused && `refused ${r.refused}`].filter(Boolean).join(" · "))}</small></div>
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
