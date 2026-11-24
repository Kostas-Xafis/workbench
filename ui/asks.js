/* ---------- Asks that don't block: notices, defaults with a deadline, several picks (asks.ts) ---------- */
// On a card: Got it / Object… on a notice, ticks and one Answer on a pick-many decision, the recommended option
// marked, and "Goes ahead with X on Fri 14 Nov" when an ask has a default. In the item dialog: the default, its
// date (change it or remove it), and the same answers. The calls below don't touch the page, so other views (a
// one-at-a-time queue) can use them: answerAsk, ackAsk, objectAsk, setDeadline, askDue, askTicked.

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
const askOpen = (i) => i.owner === "kostas" && OPEN.includes(i.status);
const askDay = (d) => {
	const today = new Date(), tomorrow = new Date(Date.now() + 86400e3);
	if (d.toDateString() === today.toDateString()) return `today at ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
	if (d.toDateString() === tomorrow.toDateString()) return "tomorrow";
	return `on ${d.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" })}`;
};
/** When an open ask of yours goes ahead by itself: { at, soon (within a day), text }, or null. */
function askDue(i) {
	if (!askOpen(i) || !i.decide_by || !askGoesAhead(i)) return null;
	const at = parseTime(i.decide_by);
	const what = askDefaultText(i);
	return { at, soon: at - Date.now() < 86400e3, text: what ? `Goes ahead with ${what} ${askDay(at)}` : `Closes as seen ${askDay(at)}` };
}

// The ticks on pick-many decisions, by item: they start as the agent's recommendation and outlive the board's redraws.
const askTicks = new Map();
const askTicked = (i) => askTicks.get(i.id) ?? new Set(askRecommended(i));
function askTick(i, option, on) {
	const set = new Set(askTicked(i));
	if (on) set.add(option); else set.delete(option);
	askTicks.set(i.id, set);
}

/* The calls. Each reloads the board and returns the item as it is now. */
async function askAfter(id, call) {
	touched(id);
	const item = await call();
	askTicks.delete(Number(id));
	await Promise.all([loadItems(), loadProjects()]);
	refreshReport();
	return item;
}
/** An answer: an option, your words, or for a pick-many decision the list of ticked options ([] = none of them). */
const answerAsk = (id, picks) => askAfter(id, () => api(`/api/items/${id}/answer`, { method: "POST", body: JSON.stringify({ answer: picks }) }));
/** Got it (a notice), No objections (a review): closes it. */
const ackAsk = (id) => askAfter(id, () => api(`/api/items/${id}/ack`, { method: "POST", body: "{}" }));
/** Your objection, in your words: it goes back to the agent as a to-do. */
const objectAsk = (id, text) => askAfter(id, () => api(`/api/items/${id}/object`, { method: "POST", body: JSON.stringify({ text }) }));
/** A new deadline: a date (YYYY-MM-DD, the end of that day), "in 3 days", or "none". */
const setDeadline = (id, when) => askAfter(id, () => api(`/api/items/${id}`, { method: "PATCH", body: JSON.stringify({ decide_by: when }) }));

/* ---------- On the board ---------- */

hooks.cardMeta.push((i) => {
	const due = askDue(i);
	return due ? `<span class="ask-due${due.soon ? " soon" : ""}" title="If you say nothing. Open the item to change the date">${esc(due.text)}</span>` : "";
});
hooks.cardActions.push((i) => {
	if (!askOpen(i)) return "";
	if (i.kind === "notice")
		return `<div class="opts card-act"><button type="button" class="opt ask-ok" data-ask-ack="${i.id}">Got it</button><button type="button" class="opt ask-no" data-ask-object="${i.id}">Object…</button></div>`;
	const options = i.kind === "decision" ? optionsOf(i) : [];
	if (!options.length) return "";
	const rec = askRecommended(i);
	if (askMany(i)) {
		const ticked = askTicked(i);
		return `<div class="opts card-act ask-picks">${options.map((o) => `<label class="opt ask-pick${ticked.has(o) ? " on" : ""}"><input type="checkbox" data-ask-tick="${i.id}" value="${esc(o)}"${ticked.has(o) ? " checked" : ""}>${esc(o)}${rec.includes(o) ? `<small>recommended</small>` : ""}</label>`).join("")}
			<button type="button" class="opt ask-send" data-ask-send="${i.id}" title="Send the ticked ones">Answer${ticked.size ? ` (${ticked.size})` : ": none"}</button></div>`;
	}
	// One pick: the board's own buttons, with the agent's pick marked.
	if (!rec.length) return "";
	return `<div class="opts card-act">${options.map((o) => `<button type="button" class="opt${rec.includes(o) ? " ask-rec" : ""}" data-ask-answer="${i.id}" data-choice="${esc(o)}" title="Answer: ${esc(o)}">${esc(o)}${rec.includes(o) ? `<small>recommended</small>` : ""}</button>`).join("")}</div>`;
});
// "Needs you" with only notices left: say that nothing waits.
hooks.boardTop.push((shown) => (state.who === "kostas" && shown.length && !shown.some(needsYou) ? `<div class="empty ask-none">Nothing waits on you. The notices are just so you know.</div>` : ""));

const askItem = (id) => state.items.find((x) => x.id === Number(id));
$("#sections").addEventListener("change", (e) => {
	const box = e.target.closest("[data-ask-tick]");
	const i = box && askItem(box.dataset.askTick);
	if (!i) return;
	askTick(i, box.value, box.checked);
	renderBoard();
});
$("#sections").addEventListener("click", async (e) => {
	const b = e.target.closest("[data-ask-ack], [data-ask-object], [data-ask-send], [data-ask-answer]");
	if (!b) return;
	e.stopPropagation();
	try {
		if (b.dataset.askAck) { b.classList.add("picked"); await ackAsk(b.dataset.askAck); }
		else if (b.dataset.askObject) { askFocus = "object"; await openItemById(b.dataset.askObject); }
		else if (b.dataset.askSend) { b.classList.add("picked"); const i = askItem(b.dataset.askSend); await answerAsk(i.id, [...askTicked(i)]); }
		else { b.classList.add("picked"); await answerAsk(b.dataset.askAnswer, b.dataset.choice); }
	} catch (err) { toast(err.message); }
});

/* ---------- In the item dialog ---------- */

const askBox = document.createElement("div");
askBox.className = "answer-box ask-box";
askBox.id = "ask-box";
askBox.hidden = true;
askBox.innerHTML = `<h3>If you say nothing</h3><p class="ask-what" id="ask-what"></p>
	<div class="ask-when" id="ask-when"><label><span id="ask-whenlabel">Goes ahead on</span> <input type="date" id="ask-date"></label><button type="button" class="ghost sm" id="ask-nodate">No date</button><span class="hint" id="ask-whenhint"></span></div>
	<div id="ask-reply"><div class="opts"><button type="button" class="opt ask-ok" id="ask-ack">Got it</button></div>
	<div class="note-form"><input id="ask-object" placeholder="Object: what you'd rather have (it goes back to the agent)"><button type="button" class="ghost" id="ask-object-send">Object</button></div></div>`;
$("#answer-box").after(askBox);
// What the dialog should put the cursor in when it opens ("object" from a card's Object… button).
let askFocus = "";
const localDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

function askFill(item) {
	const show = item.id && askOpen(item) && ASK_KINDS.includes(item.kind);
	askBox.hidden = !show;
	if (!show) return;
	const what = askDefaultText(item);
	$("#ask-what").textContent = what
		? (item.kind === "decision" ? `It goes ahead with ${what}, handed back to the agent as if you had picked it.` : item.kind === "review" ? `It goes ahead: ${what}. The review closes with no objections.` : `It stays as it is: ${what}. The notice closes as seen.`)
		: item.kind === "notice" ? "It closes as seen." : "Nothing happens by itself: it waits for you.";
	const ahead = askGoesAhead(item);
	$("#ask-when").hidden = !ahead;
	$("#ask-whenlabel").textContent = item.kind === "notice" ? "Closes on" : "Goes ahead on";
	$("#ask-date").value = item.decide_by ? localDate(parseTime(item.decide_by)) : "";
	$("#ask-date").min = localDate(new Date());
	$("#ask-nodate").hidden = !item.decide_by;
	$("#ask-whenhint").textContent = item.decide_by ? "" : "No date: it waits for you.";
	const reply = item.kind === "notice" || item.kind === "review";
	$("#ask-reply").hidden = !reply;
	$("#ask-ack").textContent = item.kind === "review" ? "No objections" : "Got it";
}
// A pick-many decision is answered with ticks and one button; a recommended option is marked.
function askFillAnswers(item) {
	const options = optionsOf(item), rec = askRecommended(item);
	if (!options.length || !askMany(item)) {
		for (const b of $("#answer-opts").querySelectorAll("[data-choice]"))
			if (rec.includes(b.dataset.choice)) { b.classList.add("ask-rec"); b.insertAdjacentHTML("beforeend", "<small>recommended</small>"); }
		return;
	}
	const picked = new Set(item.picks ? askList(item.picks) : askTicked(item));
	$("#answer-opts").innerHTML = options.map((o) => `<label class="opt ask-pick${picked.has(o) ? " on" : ""}"><input type="checkbox" data-ask-dtick value="${esc(o)}"${picked.has(o) ? " checked" : ""}>${esc(o)}${rec.includes(o) ? "<small>recommended</small>" : ""}</label>`).join("")
		+ `<button type="button" class="opt ask-send" id="ask-dsend"></button>`;
	askCount();
}
// The dialog's Answer says how many are ticked, like the card's.
function askCount() {
	const b = $("#ask-dsend");
	const n = $("#answer-opts").querySelectorAll("[data-ask-dtick]:checked").length;
	if (b) b.textContent = n ? `Answer (${n})` : "Answer: none";
}
hooks.itemOpen.push((item, isNew) => {
	askFill(isNew ? {} : item);
	if (!isNew && item.kind === "decision") askFillAnswers(item);
	if (askFocus === "object" && !askBox.hidden) setTimeout(() => $("#ask-object").focus(), 0);
	askFocus = "";
});
$("#answer-opts").addEventListener("change", (e) => {
	if (!e.target.matches("[data-ask-dtick]")) return;
	e.target.closest("label").classList.toggle("on", e.target.checked);
	askCount();
});
$("#answer-opts").addEventListener("click", async (e) => {
	if (!e.target.closest("#ask-dsend") || !state.current?.id) return;
	const picks = [...$("#answer-opts").querySelectorAll("[data-ask-dtick]:checked")].map((b) => b.value);
	try { openItem(await answerAsk(state.current.id, picks)); } catch (err) { $("#err").textContent = err.message; }
});
// A changed date keeps whatever you've typed in the rest of the form.
async function askDeadline(when) {
	if (!state.current?.id) return;
	try {
		const it = await setDeadline(state.current.id, when);
		state.current = { ...state.current, decide_by: it.decide_by, notes: it.notes };
		askFill(state.current);
		renderHistory();
	} catch (err) { $("#err").textContent = err.message; }
}
$("#ask-date").addEventListener("change", (e) => askDeadline(e.target.value || "none"));
$("#ask-nodate").onclick = () => askDeadline("none");
$("#ask-ack").onclick = async () => {
	try { openItem(await ackAsk(state.current.id)); } catch (err) { $("#err").textContent = err.message; }
};
async function askObject() {
	const text = $("#ask-object").value.trim();
	if (!text) return $("#ask-object").focus();
	try { openItem(await objectAsk(state.current.id, text)); toast("Sent back to the agent"); } catch (err) { $("#err").textContent = err.message; }
}
$("#ask-object-send").onclick = askObject;
$("#ask-object").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); askObject(); } });
/* ---------- end: Asks ---------- */
