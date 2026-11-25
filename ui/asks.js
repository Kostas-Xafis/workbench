/* ---------- Asks that don't block: notices, defaults with a deadline, several picks (asks.ts) ---------- */
// In the reader: one quiet line under the title ("If you say nothing, it goes ahead with X on Thu 26 Nov", change the date or remove it), and the default
// with its date among the properties. What an ask is and the calls that answer it are in ui/answer.js.

/* ---------- In the reader ---------- */

const localDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const askShows = (i) => !!i.id && askOpen(i) && ASK_KINDS.includes(i.kind);
// What saying nothing does, in a sentence.
function askNothing(i) {
	const what = askDefaultText(i);
	const at = i.decide_by ? ` ${when(i.decide_by)}` : "";
	if (i.kind === "notice") return `If you say nothing, it closes as seen${at}`;
	if (!what) return "";
	return i.kind === "decision" ? `If you say nothing, it goes ahead with ${what}${at}` : `If you say nothing, it goes ahead: ${what}${at}`;
}
// Under the title: one quiet line, highlighted within a day, with the date to change or remove.
hooks.readerDoc.push({
	slot: "lead",
	html(i, r) {
		if (!askShows(i) || !askGoesAhead(i)) return "";
		const line = askNothing(i);
		if (!line) return "";
		const due = askDue(i);
		const edit = r.askDate === i.id
			? `<input type="date" class="ask-lead-date" data-ask-date value="${i.decide_by ? localDate(parseTime(i.decide_by)) : ""}" min="${localDate(new Date())}" aria-label="Goes ahead on">`
			: `<button type="button" class="rd-link" data-ask-change>${i.decide_by ? "change date" : "set a date"}</button>`;
		return `<p class="ask-lead${due?.soon ? " soon" : ""}">${esc(line)}${i.decide_by ? "." : ", with no date: it waits for you."} ${edit}${i.decide_by ? `<button type="button" class="rd-link" data-ask-nodate>remove</button>` : ""}</p>`;
	},
	wire(el, i, r) {
		el.addEventListener("click", (e) => {
			if (e.target.closest("[data-ask-change]")) { r.askDate = i.id; r.render(); el.ownerDocument.querySelector("[data-ask-date]")?.showPicker?.(); }
			if (e.target.closest("[data-ask-nodate]")) r.set({ decide_by: "none" });
		});
		el.addEventListener("change", (e) => {
			if (!e.target.matches("[data-ask-date]")) return;
			r.askDate = 0;
			r.set({ decide_by: e.target.value || "none" });
		});
	},
});
// In the properties: what goes ahead (one of the choices, or your words), and on which day.
hooks.readerProps.push({
	order: 90,
	html(i) {
		if (!askShows(i)) return "";
		const options = i.kind === "decision" && i.pick !== "many" ? optionsOf(i) : [];
		const what = options.length
			? `<select class="rd-val" data-ask-default aria-label="If you say nothing">${[["", "Nothing: it waits"], ...options.map((o) => [o, o])].map(([v, l]) => `<option value="${esc(v)}"${v === (i.default_answer || "") ? " selected" : ""}>${esc(l)}</option>`).join("")}</select>`
			: i.kind === "notice" ? `<span class="rd-text">It closes as seen</span>`
			: `<input class="rd-val" data-ask-default value="${esc(askDefaultText(i))}" placeholder="Nothing: it waits" aria-label="If you say nothing">`;
		const when = askGoesAhead(i)
			? `<input type="date" class="rd-val" data-ask-when value="${i.decide_by ? localDate(parseTime(i.decide_by)) : ""}" min="${localDate(new Date())}" aria-label="On">${i.decide_by ? `<button type="button" class="rd-link" data-ask-nodate>No date</button>` : ""}`
			: "";
		return readerProp("If you say nothing", what + when);
	},
	wire(el, i, r) {
		el.addEventListener("change", (e) => {
			if (e.target.matches("[data-ask-default]")) r.set({ default_answer: e.target.value });
			if (e.target.matches("[data-ask-when]")) r.set({ decide_by: e.target.value || "none" });
		});
		el.addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target.matches("input")) { e.preventDefault(); e.target.blur(); } });
		el.addEventListener("click", (e) => { if (e.target.closest("[data-ask-nodate]")) r.set({ decide_by: "none" }); });
	},
});
/* ---------- end: Asks ---------- */
