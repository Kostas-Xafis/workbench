/* ---------- What's left of queue mode: ways into the Inbox's focus mode ---------- */

// One at a time is the Inbox's focus mode now (ui/inbox.js): #queue opens it, and so does the Q key there. The
// order still comes from GET /api/queue (queue.ts). What stays here: the way in on the board's Needs you, and
// "deferred to …" on a card.

// On the board's Needs you, over the cards.
hooks.boardTop.push((shown) => {
	if (state.who !== "kostas") return "";
	const asks = shown.filter(needsYou).length, notices = shown.filter((i) => i.kind === "notice" && i.owner === "kostas").length;
	if (!asks && !notices) return "";
	const what = asks ? `${asks} wait${asks === 1 ? "s" : ""} on you${notices ? `, and ${notices} notice${notices === 1 ? "" : "s"}` : ""}` : `${notices} notice${notices === 1 ? "" : "s"}`;
	return `<div class="q-entry"><button type="button" class="primary" data-queue>${asks ? "Go through them one by one" : "Go through the notices"}</button><span>${what}. One at a time, the most useful first.</span><kbd>Q</kbd></div>`;
});
$("#sections").addEventListener("click", (e) => { if (e.target.closest("[data-queue]")) go(`#queue${state.project ? `/${encodeURIComponent(state.project)}` : ""}`); });
// On a card: deferred until a day.
hooks.cardMeta.push((i) => (i.deferred_until && OPEN.includes(i.status) && parseTime(i.deferred_until) > Date.now()
	? `<span class="q-deferred" title="Out of the Inbox until then">deferred to ${esc(day(i.deferred_until, { weekday: true, relative: true }))}</span>` : ""));
