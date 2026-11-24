/* ---------- Answering: every way an item is answered or settled, in one place ---------- */
// The reader (ui/reader.js) and the queue (ui/queue.js) both answer through `act`: answer, ack, object, done, drop,
// defer, give back, note, update. Each call reloads the board and gives back the item as it is now. With
// { send: true }, an answer or objection also starts an agent on the item in one go (POST /api/runs, dispatch.ts):
// nothing is answered when the agent can't start, and the call throws the reason.
// Also here: what an ask is and says (its choices, the recommended ones, its default and deadline), shared by the
// cards (ui/asks.js), the reader and the queue.

const ASK_KINDS = ["decision", "review", "notice"];
const askList = (s) => { try { const v = JSON.parse(s || "[]"); return Array.isArray(v) ? v.map(String) : []; } catch { return []; } };
const askRecommended = (i) => askList(i.recommended);
const askMany = (i) => i.pick === "many" && optionsOf(i).length > 0;
// What happens if you say nothing, in words ('' = nothing happens by itself). Same as defaultText in asks.ts.
function askDefaultText(i) {
	if (!i.default_answer) return "";
	if (i.pick === "many" && i.default_answer.startsWith("[")) { const l = askList(i.default_answer); return l.length ? l.join("; ") : "none of them"; }
	return i.default_answer;
}
const askGoesAhead = (i) => ASK_KINDS.includes(i.kind) && (!!i.default_answer || i.kind === "notice");
// Yours and open: answering is up to you.
const askOpen = (i) => i.owner === "kostas" && OPEN.includes(i.status);
const askDay = (d) => {
	const today = new Date(), tomorrow = new Date(Date.now() + 86400e3);
	if (d.toDateString() === today.toDateString()) return `today at ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
	if (d.toDateString() === tomorrow.toDateString()) return "tomorrow";
	return `on ${d.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" })}`;
};
/** When an open ask of yours goes ahead by itself: { at, soon (within a day), what, text }, or null. */
function askDue(i) {
	if (!askOpen(i) || !i.decide_by || !askGoesAhead(i)) return null;
	const at = parseTime(i.decide_by);
	const what = askDefaultText(i);
	return { at, soon: at - Date.now() < 86400e3, what, text: what ? `Goes ahead with ${what} ${askDay(at)}` : `Closes as seen ${askDay(at)}` };
}
/** What the agent recommends, in words: its recommended options, else an option marked "(recommended)", else the default. */
function askRecommends(i) {
	const rec = askRecommended(i);
	if (rec.length) return rec.join("; ");
	const marked = optionsOf(i).find((o) => /\(recommended\)\s*$/i.test(o));
	if (marked) return marked.replace(/\s*\(recommended\)\s*$/i, "");
	return askDefaultText(i);
}

// The ticks on pick-many decisions, by item: they start as the agent's recommendation and outlive redraws.
const askTicks = new Map();
const askTicked = (i) => askTicks.get(i.id) ?? new Set(askRecommended(i));
function askTick(i, option, on) {
	const set = new Set(askTicked(i));
	if (on) set.add(option); else set.delete(option);
	askTicks.set(i.id, set);
}

// Items this tab just changed, so it doesn't notify about its own doing.
const localChanges = new Map();
const touched = (id) => localChanges.set(Number(id), Date.now());

/* The calls. */
async function settled(id, call) {
	touched(id);
	const item = await call();
	askTicks.delete(Number(id));
	await Promise.all([loadItems(), loadProjects()]);
	refreshReport();
	return item;
}
const itemPost = (id, path, body = {}) => api(`/api/items/${id}/${path}`, { method: "POST", body: JSON.stringify(body) });
// Answer or object, and start an agent on it (dispatch.ts): POST /api/runs answers first, then starts.
const answerRun = (id, body) => settled(id, async () => {
	const res = await api("/api/runs", { method: "POST", body: JSON.stringify({ item: Number(id), ...body }) });
	if (typeof runsLoad === "function") await runsLoad();
	return res.item;
});
const act = {
	/** An option, your own words, or for a pick-many decision the ticked options ([] = none of them). */
	answer: (id, answer, { send = false } = {}) => send ? answerRun(id, { answer }) : settled(id, () => itemPost(id, "answer", { answer })),
	/** No objections (a review), Got it (a notice): closes it. */
	ack: (id) => settled(id, () => itemPost(id, "ack")),
	/** Your objection, in your words: back to the agent as a to-do. */
	object: (id, text, { send = false } = {}) => send ? answerRun(id, { object: text }) : settled(id, () => itemPost(id, "object", { text })),
	done: (id) => act.update(id, { status: "done" }),
	drop: (id) => act.update(id, { status: "dropped" }),
	/** Out of the queue until "tomorrow", "in 3 days", "next week" or a date (YYYY-MM-DD); "none" brings it back. */
	defer: (id, until) => settled(id, () => itemPost(id, "defer", { until })),
	/** Back to the agent with your line (empty: "You decide, with your recommendation."). */
	giveBack: (id, text = "") => settled(id, () => itemPost(id, "give-back", { text })),
	/** A line in its history, from you. */
	note: (id, text) => settled(id, () => itemPost(id, "notes", { text })),
	/** Any of the item's fields: { status }, { title }, { body }, { goal_id }, { decide_by: "2026-11-30" | "none" }… */
	update: (id, patch) => settled(id, () => api(`/api/items/${id}`, { method: "PATCH", body: JSON.stringify(patch) })),
};
/* ---------- end: Answering ---------- */
