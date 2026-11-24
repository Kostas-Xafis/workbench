/* ---------- Queue mode: what waits on you, one item at a time (#queue) ---------- */

// Opens from "Go through them one by one" on the board's Needs you and in Today, or the Q key, for the project on
// the left (or all). The order, the groups of similar asks and the summaries come from GET /api/queue (queue.ts);
// the answers go through the calls in asks.js (answerAsk, ackAsk, objectAsk) and the item API. Each action shows at
// once and is sent a moment later, so the last one can be undone: it goes when you act again, leave, put the
// phone away, or after QUEUE_UNDO_MS. Answer & send (when the board has it) goes at once: it starts an agent.
const QUEUE_UNDO_MS = 10e3;
const QUEUE_GIVE_BACK = "You decide, with your recommendation.";
const qs = {
	list: [], at: 0, cleared: [], deferred: [], pending: null, loaded: false, project: "", full: new Map(),
	open: false, sheet: "", note: "", noticeSeen: false,
};
const queueEl = document.createElement("section");
queueEl.id = "queue-view";
queueEl.setAttribute("aria-label", "Queue: what waits on you, one at a time");
queueEl.hidden = true;
$("#content").append(queueEl);
const queueOn = () => !queueEl.hidden;

/* ---------- What an item asks for ---------- */

const qCurrent = () => qs.list[qs.at];
const qOptions = (i) => (i.kind === "decision" ? optionsOf(i) : []);
const qMany = (i) => i.pick === "many" && qOptions(i).length > 0;
const qRec = (i) => askRecommended(i).filter((o) => qOptions(i).includes(o));
// The one thing a swipe right, Enter or A does: { label, run } or null (a decision with nothing recommended).
function qPrimary(i) {
	if (i.kind === "decision") {
		if (qMany(i)) { const t = [...askTicked(i)]; return { label: t.length ? `Answer (${t.length})` : "Answer: none of them", act: ["answer", t] }; }
		const rec = qRec(i)[0];
		return rec ? { label: `Answer: ${rec}`, act: ["answer", rec] } : null;
	}
	if (i.kind === "review") return { label: "No objections", act: ["ack"] };
	if (i.kind === "notice") return { label: "Got it", act: ["ack"] };
	if (i.kind === "check") return { label: "It works", act: ["done"] };
	return { label: "Done", act: ["done"] };
}
// O: your own words. A decision takes them as the answer; the rest send them back to the agent as an objection.
const qObjectLabel = (i) => ({ decision: "Own words", check: "Didn't work", setup: "Problem" }[i.kind] ?? "Object");
const qCanSend = (i) => typeof answerAndSend === "function" && typeof canSend === "function" && (() => { try { return !!canSend(qs.full.get(i.id) ?? i); } catch { return false; } })();

/* ---------- Loading ---------- */

async function queueLoad() {
	const project = state.project;
	try {
		const q = await api(`/api/queue${project ? `?project=${encodeURIComponent(project)}` : ""}`);
		if (project !== state.project || !queueOn()) return;
		const fresh = !qs.loaded || qs.project !== project;
		qs.project = project;
		qs.deferred = q.deferred;
		if (fresh) {
			Object.assign(qs, { list: [...q.items], at: 0, cleared: [], loaded: true, sheet: "", note: "", noticeSeen: false });
			qs.full.clear();
		} else queueMerge(q.items);
		queueRender();
		queuePrefetch();
	} catch (e) { paint(queueEl, `<div class="q-wrap"><p class="q-empty">Couldn't load the queue: ${esc(e.message)}</p></div>`); }
}
// A poll while you're in it: what was settled elsewhere (the phone, the desk, an agent) leaves; what's new goes at the
// end; nothing moves under you.
function queueMerge(items) {
	const byId = new Map(items.map((i) => [i.id, i]));
	const done = new Set([...qs.cleared.map((c) => c.item.id), qs.pending?.item.id]);
	const cur = qCurrent();
	const kept = qs.list.filter((i) => byId.has(i.id)).map((i) => byId.get(i.id));
	const have = new Set(kept.map((i) => i.id));
	const added = items.filter((i) => !have.has(i.id) && !done.has(i.id));
	// New asks go before the notices; new notices at the very end.
	const firstNotice = kept.findIndex((i) => i.notice);
	const asks = added.filter((i) => !i.notice), notices = added.filter((i) => i.notice);
	if (firstNotice < 0) kept.push(...asks, ...notices);
	else kept.splice(firstNotice, 0, ...asks), kept.push(...notices);
	const at = cur ? kept.findIndex((i) => i.id === cur.id) : -1;
	if (cur && at < 0) qs.note = "That one was settled elsewhere.";
	qs.list = kept;
	qs.at = at >= 0 ? at : Math.min(qs.at, kept.length);
}
// The full brief, its pictures and notes, for "Read all" and the check's run: the item on screen and the next one.
function queuePrefetch() {
	for (const i of [qs.list[qs.at], qs.list[qs.at + 1]]) {
		if (!i || qs.full.has(i.id)) continue;
		qs.full.set(i.id, null);
		api(`/api/items/${i.id}`).then((full) => { qs.full.set(i.id, full); if (qCurrent()?.id === i.id && qs.open) queueRender(); }).catch(() => qs.full.delete(i.id));
	}
}

/* ---------- Acting ---------- */

const qPost = (id, path, body) => ({ url: `/api/items/${id}/${path}`, method: "POST", body: JSON.stringify(body) });
const qPatch = (id, patch) => ({ url: `/api/items/${id}`, method: "PATCH", body: JSON.stringify(patch) });
// After a call that isn't one of asks.js's (they reload the board themselves).
const qReload = async () => { await Promise.all([loadItems(), loadProjects()]); refreshReport(); };
const qCall = (req) => async () => { touched(req.url.split("/")[3]); const r = await api(req.url, { method: req.method, body: req.body }); await qReload(); return r; };

// Each action: what it says when done, the call, and the same call as a plain request (sent as the page closes).
function qAction(i, type, arg) {
	const dayWord = (d) => (d === "tomorrow" ? "tomorrow" : /^\d{4}-/.test(d) ? new Date(`${d}T00:00`).toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" }) : d);
	switch (type) {
		case "answer": {
			const text = Array.isArray(arg) ? (arg.length ? arg.join("; ") : "none of them") : arg;
			return { said: `Answered: ${text}`, run: () => answerAsk(i.id, arg), req: qPost(i.id, "answer", { answer: arg }) };
		}
		case "own": return { said: `Answered: ${arg}`, run: () => answerAsk(i.id, arg), req: qPost(i.id, "answer", { answer: arg }) };
		case "ack": return { said: i.kind === "review" ? "No objections" : "Got it", run: () => ackAsk(i.id), req: qPost(i.id, "ack", {}) };
		case "object": return { said: `${qObjectLabel(i)}: ${arg}`, run: () => objectAsk(i.id, arg), req: qPost(i.id, "object", { text: arg }) };
		case "done": { const req = qPatch(i.id, { status: "done" }); return { said: i.kind === "check" ? "It works: done" : "Done", run: qCall(req), req }; }
		case "drop": { const req = qPatch(i.id, { status: "dropped" }); return { said: "Dropped", run: qCall(req), req }; }
		case "defer": { const req = qPost(i.id, "defer", { until: arg }); return { said: `Deferred until ${dayWord(arg)}`, run: qCall(req), req, until: dayWord(arg) }; }
		case "giveback": { const req = qPost(i.id, "give-back", { text: arg }); return { said: "Given back to the agent", run: qCall(req), req }; }
	}
}

function queueAct(type, arg) {
	const i = qCurrent();
	if (!i) return;
	queueFlush();
	const a = qAction(i, type, arg);
	const entry = { item: i, said: a.said, type, until: a.until };
	qs.cleared.push(entry);
	qs.list.splice(qs.at, 1);
	qs.sheet = "";
	qs.note = "";
	qs.pending = { ...a, item: i, index: qs.at, entry, timer: setTimeout(queueFlush, QUEUE_UNDO_MS) };
	queueAfterMove();
}
// Answer & send starts an agent, so it goes at once and can't be undone.
async function queueSend(i, answer) {
	queueFlush();
	const entry = { item: i, said: `Answered and sent: ${Array.isArray(answer) ? answer.join("; ") || "none of them" : answer}`, type: "send" };
	qs.cleared.push(entry);
	qs.list.splice(qs.at, 1);
	qs.sheet = "";
	queueAfterMove();
	try { await answerAndSend(i.id, answer); } catch (err) { queueFailed(entry, qs.at, err); }
}
// Sends the action waiting for its undo now.
function queueFlush() {
	const p = qs.pending;
	if (!p) return;
	qs.pending = null;
	clearTimeout(p.timer);
	p.run().then(() => { if (queueOn()) queueRender(); }).catch((err) => queueFailed(p.entry, p.index, err));
	if (queueOn()) queueRender();
}
function queueFailed(entry, index, err) {
	qs.cleared = qs.cleared.filter((c) => c !== entry);
	qs.list.splice(Math.min(index, qs.list.length), 0, entry.item);
	qs.at = Math.min(index, qs.list.length - 1);
	qs.note = `Didn't go through: ${err.message}`;
	if (queueOn()) queueRender();
}
function queueUndo() {
	const p = qs.pending;
	if (!p) return;
	clearTimeout(p.timer);
	qs.pending = null;
	qs.cleared = qs.cleared.filter((c) => c !== p.entry);
	qs.list.splice(Math.min(p.index, qs.list.length), 0, p.item);
	qs.at = Math.min(p.index, qs.list.length - 1);
	qs.note = "Undone.";
	qs.open = false;
	queueRender();
}
// The page closing or the phone put away: the waiting action goes now (a plain request outlives the page).
function queueBeacon() {
	const p = qs.pending;
	if (!p) return;
	qs.pending = null;
	clearTimeout(p.timer);
	try { fetch(p.req.url, { method: p.req.method, body: p.req.body, keepalive: true, headers: { "content-type": "application/json" } }); } catch {}
}
addEventListener("pagehide", queueBeacon);
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") queueBeacon(); });
addEventListener("hashchange", () => { if (location.hash !== "#queue") queueFlush(); });

function queueAfterMove() {
	qs.open = false;
	if (qs.at >= qs.list.length && qs.list.length && qs.at > 0) qs.at = qs.list.length; // past the end: the skipped ones wait
	queueRender();
	queuePrefetch();
	queueEl.querySelector(".q-scroll")?.scrollTo(0, 0);
}
function queueMove(by) {
	const to = qs.at + by;
	if (to < 0 || to > qs.list.length) return;
	qs.at = to;
	qs.sheet = "";
	qs.note = "";
	queueAfterMove();
}

/* ---------- Drawing ---------- */

const qKey = (k) => `<kbd class="q-k">${esc(k)}</kbd>`;
function qAge(s) {
	const h = (Date.now() - parseTime(s)) / 3600e3;
	return h < 1 ? "just now" : h < 24 ? `${Math.floor(h)} h` : h < 24 * 60 ? `${Math.floor(h / 24)} d` : `${Math.floor(h / 720)} mo`;
}
const qDay = (s) => {
	const d = parseTime(s), t = new Date(Date.now() + 86400e3);
	return d.toDateString() === t.toDateString() ? "tomorrow" : d.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" });
};
const qIcon = (d) => `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><g stroke-width="1.5">${d}</g></svg>`;
const Q_IC = {
	close: '<path d="m4 4 8 8M12 4l-8 8"/>',
	back: '<path d="m10 3.5-4.5 4.5 4.5 4.5"/>',
	skip: '<path d="m6 3.5 4.5 4.5L6 12.5"/>',
	object: '<path d="M2.75 3.25h10.5v7.5h-6l-3 2.5v-2.5h-1.5z"/>',
	defer: '<circle cx="8" cy="8" r="5.75"/><path d="M8 4.75V8l2.25 1.5"/>',
	give: '<path d="M6 4.5 2.75 7.75 6 11M3 7.75h6.25a4 4 0 0 1 4 4v.5"/>',
	drop: '<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5"/>',
};

// How many more of its group follow it now (skips and answers change that).
function qGroupText(i) {
	if (!i.group) return "";
	let n = 0;
	for (let k = qs.at + 1; k < qs.list.length && qs.list[k].group?.id === i.group.id; k++) n++;
	const why = i.group.why === "similar titles" ? "similar titles" : `same area: ${i.group.why}`;
	if (n) return `${n} more like this next · ${why}`;
	return i.group.at > 1 ? `The last one like this · ${why}` : "";
}

// When each deferred item comes back: those deferred before this pass (from the server) and in it (maybe not sent yet).
function qDeferred() {
	const known = new Set(qs.deferred.map((d) => d.id));
	return [...qs.deferred.map((d) => qDay(d.until)), ...qs.cleared.filter((c) => c.until && !known.has(c.item.id)).map((c) => c.until)];
}
function qHead() {
	const n = qs.cleared.length, left = qs.list.length, all = n + left;
	const where = state.project ? projectName(state.project) : "All projects";
	const nd = qDeferred().length;
	const counts = [all ? `<b>${n}</b> cleared · <b>${left}</b> to go` : "", nd ? `${nd} deferred` : ""].filter(Boolean).join(" · ");
	return `<header class="q-head">
		<button type="button" class="icon-btn q-x" data-q="leave" title="Back to the board (Esc)" aria-label="Back to the board">${qIcon(Q_IC.close)}</button>
		<div class="q-where"><b>One at a time</b><small>${esc(where)}</small></div>
		<div class="q-count" aria-live="polite">${counts}</div>
		<span class="spacer"></span>
		${qs.at > 0 && qs.list.length ? `<button type="button" class="icon-btn q-prev" data-q="back" title="The one before (←)" aria-label="The one before">${qIcon(Q_IC.back)}</button>` : ""}
	</header>
	<div class="q-bar" role="progressbar" aria-valuemin="0" aria-valuemax="${all}" aria-valuenow="${n}"><i style="width:${all ? (100 * n) / all : 0}%"></i></div>`;
}

function qMeta(i) {
	const due = askDue(i);
	const bits = [
		`<span class="q-kind k-${i.kind}">${kindIcon(i.kind)}${esc(i.kind)}</span>`,
		state.project ? "" : `<span>${esc(projectName(i.project))}</span>`,
		i.area ? `<span>${esc(i.area)}</span>` : "",
		i.priority === 1 ? `<span class="p1">P1</span>` : "",
		`<span title="Since ${esc(i.created_at)} UTC">waiting ${qAge(i.created_at)}</span>`,
		i.unblocks > 0 ? `<span class="q-tag go" title="Answering this lets agent work go on">unblocks ${i.unblocks}</span>` : "",
		i.goal ? `<span class="q-tag goal" title="${i.goal.active ? "The active goal" : "A goal of this project"}">${glyph("check")}${esc(i.goal.goal)}</span>` : "",
		due ? `<span class="q-tag${due.soon ? " soon" : ""}">${esc(due.text)}</span>` : "",
	].filter(Boolean).join("");
	return `<div class="q-meta">${bits}</div>`;
}

function qFull(i) {
	const full = qs.full.get(i.id);
	if (!full) return `<div class="q-full"><p class="q-muted">Loading the brief…</p></div>`;
	const imgs = (full.images || []).map((m) => `<figure><a href="/api/images/${m.id}" target="_blank" rel="noreferrer"><img src="/api/images/${m.id}" alt="${esc(m.caption)}" loading="lazy"${m.width && m.height ? ` width="${m.width}" height="${m.height}"` : ""}></a>${m.caption ? `<figcaption>${esc(m.caption)}</figcaption>` : ""}</figure>`).join("");
	const notes = (full.notes || []).filter((n) => n.text !== "created").slice(-4);
	return `<div class="q-full">
		<div class="q-md">${md(full.body) || '<p class="q-muted">No details.</p>'}</div>
		${imgs ? `<div class="q-imgs">${imgs}</div>` : ""}
		${notes.length ? `<h4 class="q-h">Latest notes</h4><ol class="q-notes">${notes.map((n) => `<li><span class="q-muted">${esc(n.author || "—")} · ${ago(n.at)}</span><div>${n.text.includes("\n") ? md(n.text) : esc(n.text)}</div></li>`).join("")}</ol>` : ""}
	</div>`;
}

function qCard(i) {
	const group = qGroupText(i);
	const steps = i.steps?.length ? `<h4 class="q-h">Steps</h4><ol class="q-steps">${i.steps.map((s) => `<li>${md(s).replace(/^<p>|<\/p>$/g, "")}</li>`).join("")}</ol>` : "";
	const run = i.kind === "check" && typeof openCheckRun === "function" ? `<button type="button" class="ghost q-run" data-q="run">Run it</button>` : "";
	const noticeHead = i.notice && !qs.list.slice(0, qs.at).some((x) => x.notice)
		? `<p class="q-section">Notices: just so you know. Got it, or object in a line.</p>` : "";
	const hasMore = i.more || i.image_count;
	return `${noticeHead}<article class="q-card" data-id="${i.id}">
		${qMeta(i)}
		<h2 class="q-title">${esc(i.title)}</h2>
		${group ? `<p class="q-group">${esc(group)}</p>` : ""}
		${qs.open ? qFull(i) : `<div class="q-md q-sum">${i.summary ? md(i.summary) : '<p class="q-muted">No details.</p>'}</div>`}
		${qs.open ? "" : steps}
		<div class="q-more">
			${hasMore || qs.open ? `<button type="button" class="ghost sm" data-q="read" aria-expanded="${qs.open}">${qs.open ? "Show the summary" : `Read all${i.image_count ? ` · ${i.image_count} picture${i.image_count > 1 ? "s" : ""}` : ""}`} ${qKey("R")}</button>` : ""}
			${run}
			<button type="button" class="ghost sm" data-q="item" title="Open it in the item dialog">wb-${esc(i.ref)}</button>
		</div>
	</article>`;
}

// The choices and the buttons, at the bottom where a thumb reaches.
function qFoot(i) {
	if (qs.sheet === "defer") return `<div class="q-sheet"><span class="q-sheet-t">Out of the queue until</span>
		<div class="q-row"><button type="button" class="opt q-big" data-defer="tomorrow">Tomorrow ${qKey("D")}</button><button type="button" class="opt" data-defer="in 3 days">In 3 days ${qKey("3")}</button>
		<button type="button" class="opt" data-defer="next week">Next week ${qKey("W")}</button><label class="opt q-date">Another day<input type="date" id="q-date" min="${qLocalDate(new Date(Date.now() + 86400e3))}"></label></div>
		<div class="q-row"><span class="hint">It still counts as waiting on you; the phone and the desk both skip it until then.</span><span class="spacer"></span><button type="button" class="ghost sm" data-q="cancel">Cancel ${qKey("Esc")}</button></div></div>`;
	if (qs.sheet === "object" || qs.sheet === "giveback") {
		const give = qs.sheet === "giveback";
		const ph = give ? QUEUE_GIVE_BACK : i.kind === "decision" ? "Your answer, in your words" : i.kind === "check" ? "What happened (it goes back to the agent)" : "What you'd rather have (it goes back to the agent)";
		return `<div class="q-sheet"><span class="q-sheet-t">${give ? "Back to the agent, with a line" : esc(qObjectLabel(i))}</span>
			<div class="q-row q-say"><input id="q-text" autocomplete="off" placeholder="${esc(ph)}" enterkeyhint="send"><button type="button" class="primary" data-q="say">${give ? "Give back" : i.kind === "decision" ? "Answer" : "Send"}</button></div>
			<div class="q-row">${give ? `<span class="hint">Empty: “${esc(QUEUE_GIVE_BACK)}”</span>` : ""}<span class="spacer"></span><button type="button" class="ghost sm" data-q="cancel">Cancel ${qKey("Esc")}</button></div></div>`;
	}
	const p = qPrimary(i);
	const options = qOptions(i), rec = qRec(i), many = qMany(i);
	let choices = "";
	if (options.length && many) {
		const ticked = askTicked(i);
		choices = `<div class="q-opts many">${options.map((o, k) => `<label class="opt q-opt ask-pick${ticked.has(o) ? " on" : ""}"><input type="checkbox" data-q-tick value="${esc(o)}"${ticked.has(o) ? " checked" : ""}><span>${esc(o)}${rec.includes(o) ? "<small>recommended</small>" : ""}</span>${k < 9 ? qKey(k + 1) : ""}</label>`).join("")}</div>`;
	} else if (options.length)
		choices = `<div class="q-opts">${options.map((o, k) => `<button type="button" class="opt q-opt${rec.includes(o) ? " ask-rec" : ""}" data-q-answer="${esc(o)}"><span>${esc(o)}${rec.includes(o) ? "<small>recommended</small>" : ""}</span>${k < 9 ? qKey(k + 1) : rec.includes(o) ? qKey("↵") : ""}</button>`).join("")}</div>`;
	const send = qCanSend(i) && i.kind === "decision" && (many || rec.length)
		? `<button type="button" class="ghost q-send" data-q="send" title="Answer, and start an agent on it">Answer &amp; send${many ? ` (${askTicked(i).size})` : `: ${esc(rec[0])}`} ${qKey("⇧↵")}</button>` : "";
	const main = p && !(options.length && !many)
		? `<button type="button" class="primary q-primary" data-q="primary">${esc(p.label)} ${qKey("↵")}</button>`
		: i.kind === "decision" && !options.length ? `<button type="button" class="primary q-primary" data-q="primary">Answer in your words ${qKey("↵")}</button>` : "";
	const act = (key, ic, label, k, title = label) => `<button type="button" class="q-act" data-q="${key}" title="${esc(title)} (${k})">${qIcon(ic)}<span>${esc(label)}</span>${qKey(k)}</button>`;
	return `${choices}${main || send ? `<div class="q-row q-main">${main}${send}</div>` : ""}
		<div class="q-acts">
			${act("object", Q_IC.object, qObjectLabel(i), "O")}
			${act("defer", Q_IC.defer, "Defer", "D", "Out of the queue until tomorrow, or a day you pick")}
			${act("giveback", Q_IC.give, "Give back", "G", "Back to the agent: it decides")}
			${act("drop", Q_IC.drop, "Drop", "X", "Drop it (you can undo)")}
			${act("skip", Q_IC.skip, "Skip", "→", "Skip for now (← goes back)")}
		</div>`;
}

function qEnd() {
	const left = qs.list.length;
	const def = qDeferred();
	let head, sub = "";
	if (left) {
		head = `You skipped ${left}.`;
		sub = `<div class="q-row q-center"><button type="button" class="primary" data-q="again">Go through ${left === 1 ? "it" : "them"} again</button></div>`;
	} else if (!def.length) head = "Nothing waits on you.";
	else {
		const days = new Set(def);
		const fromServer = def.length === qs.deferred.length;
		head = days.size === 1 ? `${def.length} deferred until ${def[0]}.` : fromServer ? `${def.length} deferred, the first back ${def[0]}.` : `${def.length} deferred until later.`;
		sub = `<p class="q-muted">Nothing else waits on you for now.</p>`;
	}
	const done = qs.cleared.length
		? `<h4 class="q-h">Cleared this pass · ${qs.cleared.length}</h4><ol class="q-done">${qs.cleared.map((c) => `<li><span class="q-done-t">${esc(c.item.title)}</span><small>${esc(c.said)}</small></li>`).join("")}</ol>` : "";
	return `<div class="q-end"><div class="q-calm">${glyph("check")}</div><h2>${esc(head)}</h2>${sub}${done}
		<div class="q-row q-center"><button type="button" class="ghost" data-q="leave">Back to the board ${qKey("Esc")}</button></div></div>`;
}

function queueRender() {
	if (!qs.loaded) return;
	const i = qCurrent();
	const p = qs.pending;
	const said = p ? `<div class="q-said" role="status">${glyph("check")}<span>${esc(p.entry.said)}</span><button type="button" class="link" data-q="undo">Undo ${qKey("U")}</button></div>`
		: qs.note ? `<div class="q-said" role="status"><span>${esc(qs.note)}</span></div>` : "";
	const body = i ? qCard(i) : qEnd();
	const swipe = i && qPrimary(i) && !qs.sheet ? `<div class="q-swipe" aria-hidden="true"><span class="yes">${esc(qPrimary(i).label)}</span><span class="no">Skip</span></div>` : "";
	// The buttons stay in view: right under a short card, at the bottom edge under a long one (on a phone, always at the bottom).
	paint(queueEl, `${qHead()}<div class="q-scroll"><div class="q-wrap q-body">${said}${swipe}${body}</div>${i ? `<footer class="q-foot"><div class="q-wrap">${qFoot(i)}</div></footer>` : ""}</div>`);
	const t = $("#q-text");
	if (t && document.activeElement !== t) t.focus();
}
const qLocalDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/* ---------- Clicks, keys and swipes ---------- */

function queueDo(what) {
	const i = qCurrent();
	switch (what) {
		case "leave": return goBoard();
		case "undo": return queueUndo();
		case "again": qs.at = 0; qs.note = ""; return queueAfterMove();
		case "read": qs.open = !qs.open; queuePrefetch(); return queueRender();
		case "item": return i && api(`/api/items/${i.id}`).then(openItem).catch((err) => toast(err.message));
		case "run": return i && openCheckRun(i.ref);
		case "skip": return queueMove(1);
		case "back": return queueMove(-1);
		case "cancel": qs.sheet = ""; return queueRender();
		case "object": case "giveback": case "defer": qs.sheet = what; return queueRender();
		case "drop": return queueAct("drop");
		case "primary": {
			if (!i) return;
			const p = qPrimary(i);
			if (p) return queueAct(...p.act);
			if (!qOptions(i).length) { qs.sheet = "object"; return queueRender(); }
			return qHint("Nothing is recommended: pick one of the choices (1–9), or answer in your words (O).");
		}
		case "send": {
			if (!i || !qCanSend(i)) return;
			const answer = qMany(i) ? [...askTicked(i)] : qRec(i)[0];
			return answer === undefined ? qHint("Pick one first.") : queueSend(i, answer);
		}
		case "say": {
			const text = $("#q-text")?.value.trim() ?? "";
			if (qs.sheet === "giveback") return queueAct("giveback", text || QUEUE_GIVE_BACK);
			if (!text) return $("#q-text")?.focus();
			return queueAct(i.kind === "decision" ? "own" : "object", text);
		}
	}
}
function qHint(text) { qs.note = text; queueRender(); }

queueEl.addEventListener("click", (e) => {
	const b = e.target.closest("[data-q], [data-q-answer], [data-defer]");
	if (!b) return;
	if (b.dataset.qAnswer !== undefined) return queueAct("answer", b.dataset.qAnswer);
	if (b.dataset.defer) return queueAct("defer", b.dataset.defer);
	queueDo(b.dataset.q);
});
queueEl.addEventListener("change", (e) => {
	const i = qCurrent();
	if (e.target.matches("[data-q-tick]") && i) { askTick(i, e.target.value, e.target.checked); return queueRender(); }
	if (e.target.id === "q-date" && e.target.value) queueAct("defer", e.target.value);
});
queueEl.addEventListener("keydown", (e) => {
	if (e.target.id !== "q-text") return;
	// Handled here: the box is gone by the time the page's own keys would see this Enter.
	if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); queueDo("say"); }
	if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); queueDo("cancel"); }
});

document.addEventListener("keydown", (e) => {
	const mod = e.ctrlKey || e.metaKey;
	if (e.altKey || (mod && e.key.toLowerCase() !== "z")) return;
	const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName) || document.activeElement?.isContentEditable;
	if (typing || document.querySelector("dialog[open]")) return;
	const k = e.key, low = k.length === 1 ? k.toLowerCase() : k;
	if (!queueOn()) {
		if (low === "q" && !mod && !e.shiftKey) { e.preventDefault(); location.hash = "#queue"; }
		return;
	}
	const i = qCurrent();
	const key = (fn) => { e.preventDefault(); fn(); };
	if (mod) return key(queueUndo);
	if (qs.sheet === "defer") {
		if (low === "d" || k === "Enter") return key(() => queueAct("defer", "tomorrow"));
		if (k === "3") return key(() => queueAct("defer", "in 3 days"));
		if (low === "w") return key(() => queueAct("defer", "next week"));
		if (k === "Escape") return key(() => queueDo("cancel"));
		return;
	}
	if (k === "Escape") return key(() => (qs.sheet ? queueDo("cancel") : qs.open ? queueDo("read") : goBoard()));
	if (low === "u") return key(queueUndo);
	if (!i) { if (k === "Enter" && qs.list.length) key(() => queueDo("again")); return; }
	if (k === "ArrowRight" || low === "s") return key(() => queueMove(1));
	if (k === "ArrowLeft") return key(() => queueMove(-1));
	if (k === "Enter" && e.shiftKey) return key(() => queueDo("send"));
	if (k === "Enter" || low === "a") return key(() => queueDo("primary"));
	if (low === "o") return key(() => queueDo("object"));
	if (low === "d") return key(() => queueDo("defer"));
	if (low === "g") return key(() => queueDo("giveback"));
	if (low === "x") return key(() => queueDo("drop"));
	if (low === "r") return key(() => queueDo("read"));
	if (/^[1-9]$/.test(k)) {
		const o = qOptions(i)[Number(k) - 1];
		if (!o) return;
		if (qMany(i)) return key(() => { askTick(i, o, !askTicked(i).has(o)); queueRender(); });
		return key(() => queueAct("answer", o));
	}
});

// Swipe the card: right does what the big button says, left skips. Only a mostly sideways move counts; up and down
// still scroll.
let qTouch = null;
queueEl.addEventListener("pointerdown", (e) => {
	if (e.pointerType === "mouse" || !e.target.closest(".q-card") || e.target.closest("a, button, input, label")) return;
	qTouch = { x: e.clientX, y: e.clientY, id: e.pointerId, side: false };
});
queueEl.addEventListener("pointermove", (e) => {
	if (!qTouch || e.pointerId !== qTouch.id) return;
	const dx = e.clientX - qTouch.x, dy = e.clientY - qTouch.y;
	if (!qTouch.side) {
		if (Math.abs(dy) > 12 && Math.abs(dy) > Math.abs(dx)) { qTouch = null; return; }
		if (Math.abs(dx) < 12) return;
		qTouch.side = true;
	}
	const card = queueEl.querySelector(".q-card");
	if (!card) return;
	const can = dx > 0 ? !!qPrimary(qCurrent()) : true;
	card.style.transition = "none";
	card.style.translate = `${can ? dx : dx / 6}px 0`;
	card.style.rotate = `${(can ? dx : 0) / 60}deg`;
	queueEl.classList.toggle("q-yes", dx > 40 && can);
	queueEl.classList.toggle("q-no", dx < -40);
});
function qTouchEnd(e) {
	if (!qTouch || e.pointerId !== qTouch.id) return;
	const dx = e.clientX - qTouch.x, side = qTouch.side;
	qTouch = null;
	queueEl.classList.remove("q-yes", "q-no");
	const card = queueEl.querySelector(".q-card");
	if (card) { card.style.transition = ""; card.style.translate = ""; card.style.rotate = ""; }
	if (!side || e.type === "pointercancel") return;
	if (dx > 90 && qPrimary(qCurrent())) queueDo("primary");
	else if (dx < -90) queueMove(1);
}
queueEl.addEventListener("pointerup", qTouchEnd);
queueEl.addEventListener("pointercancel", qTouchEnd);

/* ---------- Ways in ---------- */

// On the board's Needs you, over the cards.
hooks.boardTop.push((shown) => {
	if (state.who !== "kostas") return "";
	const asks = shown.filter(needsYou).length, notices = shown.filter((i) => i.kind === "notice" && i.owner === "kostas").length;
	if (!asks && !notices) return "";
	const what = asks ? `${asks} wait${asks === 1 ? "s" : ""} on you${notices ? `, and ${notices} notice${notices === 1 ? "" : "s"}` : ""}` : `${notices} notice${notices === 1 ? "" : "s"}`;
	return `<div class="q-entry"><button type="button" class="primary" data-queue>${asks ? "Go through them one by one" : "Go through the notices"}</button><span>${what}. One at a time, the most useful first.</span><kbd>Q</kbd></div>`;
});
$("#sections").addEventListener("click", (e) => { if (e.target.closest("[data-queue]")) location.hash = "#queue"; });
// On a card: deferred in queue mode until a day.
hooks.cardMeta.push((i) => (i.deferred_until && OPEN.includes(i.status) && parseTime(i.deferred_until) > Date.now()
	? `<span class="q-deferred" title="Out of queue mode until then">deferred to ${esc(qDay(i.deferred_until))}</span>` : ""));
hooks.shortcuts.push([[["Q"]], "Go through what waits on you, one at a time"]);
hooks.shortcuts.push([[["1"], ["9"]], "In the queue: answer with that choice (tick it, when several can be picked)"]);
hooks.shortcuts.push([[["Enter"], ["A"]], "In the queue: the recommended answer, No objections, Got it or Done"]);
hooks.shortcuts.push([[["O"], ["D"], ["G"], ["X"]], "In the queue: object or answer in your words, defer, give back, drop"]);
hooks.shortcuts.push([[["→"], ["←"], ["U"]], "In the queue: skip, back, undo the last"]);
hooks.refresh.push(() => { if (queueOn() && !qs.sheet) queueLoad(); });
dlg.addEventListener("close", () => { if (queueOn()) queueLoad(); });

views.push({
	name: "queue",
	el: "#queue-view",
	match: (h) => h === "#queue",
	title: "One at a time · Workbench",
	// A new pass each time you come in (and when you pick another project on the left).
	open() {
		queueFlush();
		qs.loaded = false;
		qs.list = [];
		queueEl.innerHTML = "";
		queueEl._html = "";
		return queueLoad();
	},
});
