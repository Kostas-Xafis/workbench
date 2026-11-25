/* ---------- The Inbox: what waits on you, as a list beside the reader (#inbox) ---------- */

// Where the board opens. Every project's asks of yours in three tabs, by what you do: Answer (decisions), Errands
// (checks, setup and anything else of yours: done at a device or away from the desk) and Look (reviews and notices,
// which go ahead by themselves). Within a tab, what holds up agents comes first, then One at a time's order, which
// GET /api/queue gives (queue.ts: priority 1, unblocks, the active goal, deadlines, P2 before P3, the oldest;
// notices after the asks). Deferred items stay out, with a line at the end saying until when.
// - The reader (createReader, reader.js) sits beside the list from 1101 px; narrower, a row opens the reader sheet.
//   Focus mode (F or Q; #queue) hides the list and leaves one item at a time, full width.
// - The answers go through the reader, so they go through `act` (answer.js) and its one-at-a-time guard. When one
//   settles (hooks.settled), the list is asked for again and the selection moves to the item that took its place.
// - Addresses: #inbox (every project), #inbox/<slug> (one), #queue and #queue/<slug> (the same in focus mode). The
//   board's own address ("") opens it on the project last picked. The tab and the project are kept in this browser.
// - "Since you were away": your last visit, kept in this browser (inboxSince); finished and stuck come from
//   GET /api/agents.
// - While the setup guide isn't finished, its checklist sits at the top ("Finish setting up", #setup-card, setup.js).
const IB_TABS = [
	["answer", "Answer", "Decisions"],
	["errands", "Errands", "Checks and setup: at a device or away from the desk"],
	["look", "Look", "Reviews and notices: they go ahead by themselves"],
];
const IB_GIVE_BACK = "You decide, with your recommendation.";
const ibTabOf = (i) => (i.kind === "decision" ? "answer" : i.kind === "review" || i.kind === "notice" ? "look" : "errands");
const ib = {
	q: null, agents: null, since: 0, loaded: false,
	tab: IB_TABS.some(([k]) => k === localGet("inbox.tab")) ? localGet("inbox.tab") : "answer",
	project: localGet("inbox.project") || "",
	focus: false,
	// The selected item, and where it was in the list: when it leaves, the one that takes its place is selected.
	sel: null, selAt: 0,
	// What shows now, in order (J and K, the sheet's list), and what was settled from here this visit (focus mode).
	shown: [], cleared: 0,
	// "Accept N recommendations" is on its way: the list waits until it's done.
	accepting: false,
};

const inboxEl = document.createElement("section");
inboxEl.id = "inbox-view";
inboxEl.className = "ib";
inboxEl.setAttribute("aria-label", "Inbox");
inboxEl.hidden = true;
inboxEl.innerHTML = `<div class="ib-col">
		<div id="setup-card"></div>
		<div class="ib-head"></div>
		<div class="ib-tabs" role="tablist" aria-label="What you do"></div>
		<div class="ib-tools"></div>
		<div class="ib-list" role="listbox" aria-label="What waits on you" tabindex="-1"></div>
	</div>
	<div class="ib-pane">
		<div class="ib-focus-head"></div>
		<div class="ib-reader"></div>
		<div class="ib-pane-empty"></div>
	</div>`;
$("#content").append(inboxEl);
const ibOn = () => !inboxEl.hidden;
const ibListEl = $(".ib-list", inboxEl);
const ibPaneEl = $(".ib-reader", inboxEl);
// Wide enough for the list and the reader side by side (inbox.css says the same).
const ibWide = () => matchMedia("(min-width: 1101px)").matches;
const ibPhone = () => matchMedia("(max-width: 760px)").matches;
// The reader shows beside the list, or alone in focus mode; otherwise a row opens the sheet.
const ibPaneShows = () => ib.focus || ibWide();

const ibPane = createReader(ibPaneEl, {
	nav: (dir) => ibMove(dir),
	// Esc in the reader: back to the list.
	close: () => ibListFocus(),
});

/* ---------- What's in it ---------- */

// The items of the project picked (all of them for every project).
const ibInProject = (i) => !ib.project || i.project === ib.project;
const ibAll = () => (ib.q?.items ?? []).filter(ibInProject);
const ibHolds = (i) => (i.unblocks ?? 0) > 0;
// A tab's items in order: what holds up agents first, then the queue's order.
function ibTabItems(tab = ib.tab) {
	const list = ibAll().filter((i) => ibTabOf(i) === tab);
	return [...list.filter(ibHolds), ...list.filter((i) => !ibHolds(i))];
}
const ibCount = (tab) => ibAll().filter((i) => ibTabOf(i) === tab).length;
// Deferred ones of the project picked, in this tab (soonest back first).
const ibDeferred = (tab = ib.tab) => (ib.q?.deferred ?? []).filter((d) => ibInProject(d) && ibTabOf(d) === tab);
// The one choice Enter or a swipe right takes: { label, run(reader or null) } or null.
function ibRecOf(i) {
	if (!i || i.kind !== "decision") return [];
	const options = optionsOf(i);
	const rec = askRecommended(i).filter((o) => options.includes(o));
	return rec.length ? rec : options.filter((o) => /\(recommended\)\s*$/i.test(o)).slice(0, 1);
}
function ibPrimary(i) {
	if (!i) return null;
	if (i.kind === "decision") {
		const rec = ibRecOf(i);
		if (!rec.length) return null;
		if (askMany(i)) { const t = [...askTicked(i)]; return { label: t.length ? `Answer: ${t.join("; ")}` : "Answer: none of them", answer: t }; }
		return { label: `Answer: ${rec[0]}`, answer: rec[0] };
	}
	if (i.kind === "review") return { label: "No objections", ack: true };
	if (i.kind === "notice") return { label: "Got it", ack: true };
	return null;
}

/* ---------- Loading ---------- */

// Counts this as a visit and says from when "since you were away" runs: a new visit starts after an hour away, and
// the first one counts the last day. At most a week back. The stamp is kept (inbox.since) and moves only with a new
// visit, so what's asked with it is the same from poll to poll; the week's limit is rounded down to the hour for the
// same reason.
const IB_GAP = 3600e3, IB_MAX = 7 * 86400e3;
const hourBefore = (ms) => Math.floor((Date.now() - ms) / 3600e3) * 3600e3;
function inboxSince() {
	const now = Date.now(), last = Number(localGet("inbox.last")) || 0;
	let since = Number(localGet("inbox.since")) || 0;
	if (!since || now - last > IB_GAP) since = last || now - 86400e3;
	localSet("inbox.since", String(since));
	localSet("inbox.last", String(now));
	return Math.max(since, hourBefore(IB_MAX));
}

// The queue (GET /api/queue) is asked for while the Inbox shows, and when something outside it may have changed what
// waits on you: at the start, after anything is answered (hooks.settled), and when the projects' own counts moved.
async function inboxLoad() {
	try {
		const q = await api("/api/queue");
		// A visit counts only while the Inbox shows; elsewhere the stamp stays as it was.
		const since = ibOn() ? inboxSince() : ib.since || Number(localGet("inbox.since")) || hourBefore(86400e3);
		const changed = q !== ib.q || since !== ib.since;
		Object.assign(ib, { q, since, loaded: true });
		inboxCount();
		if (changed && ibOn() && !ib.accepting) inboxRender();
	} catch (e) {
		if (ibOn() && !ib.loaded) paint($(".ib-head", inboxEl), `<p class="ib-err">Couldn't load the Inbox: ${esc(e.message)}</p>`);
		return;
	}
	if (ibOn()) ibAgentsLoad();
}
// Finished and stuck, from the Agents place (it reads git, so it can take a moment the first time), for the line
// "Since you were away": once a minute at most, and again when the stamp moved.
const IB_AGENTS_GAP = 60e3;
async function ibAgentsLoad() {
	if (ib.agentsFor === ib.since && Date.now() - ib.agentsAt < IB_AGENTS_GAP) return;
	Object.assign(ib, { agentsFor: ib.since, agentsAt: Date.now() });
	const agents = await api(`/api/agents?since=${encodeURIComponent(new Date(ib.since).toISOString())}`).catch(() => ib.agents);
	if (agents === ib.agents) return;
	ib.agents = agents;
	if (ibOn() && !ib.accepting) paint($(".ib-head", inboxEl), ibHeadHtml());
}
// What waits on you in a project: asks to answer or do (Answer and Errands) and, quietly, the reviews and notices that
// go ahead by themselves (Look). The one count behind the Inbox, the nav's rows, the phone's Projects sheet and the
// project's page.
const ibByProject = new Map();
const inboxAsks = (slug) => ibByProject.get(slug) ?? { mine: 0, look: 0 };
function inboxCount() {
	ibByProject.clear();
	let n = 0;
	for (const i of ib.q?.items ?? []) {
		const c = ibByProject.get(i.project) ?? { mine: 0, look: 0 };
		if (ibTabOf(i) === "look") c.look++; else { c.mine++; n++; }
		ibByProject.set(i.project, c);
	}
	navCountMany([["inbox", n, "yours"], ...state.projects.map((p) => [`project:${p.slug}`, inboxAsks(p.slug).mine, "yours"])]);
	// A project's page shows its own count.
	const sig = [...ibByProject].map(([k, v]) => `${k}:${v.mine}:${v.look}`).sort().join();
	if (sig !== ib.countSig) { ib.countSig = sig; redraw(); }
}

/* ---------- Drawing ---------- */

const ibKey = (k) => `<kbd class="ib-k">${esc(k)}</kbd>`;
function ibHeadHtml() {
	const all = ibAll();
	const fresh = all.filter((i) => parseTime(i.created_at) >= ib.since).length;
	const c = ib.agents?.counts;
	const bits = [
		`${fresh} new`,
		c ? `<a href="#agents">${c.finished} finished</a>` : "",
		c?.stuck ? `<a href="#agents" class="ib-stuck">${c.stuck} stuck</a>` : c ? `0 stuck` : "",
	].filter(Boolean).join(" · ");
	// The projects with asks of yours, and the one picked even when it has none.
	const counts = new Map();
	for (const i of ib.q?.items ?? []) counts.set(i.project, (counts.get(i.project) ?? 0) + 1);
	if (ib.project && !counts.has(ib.project)) counts.set(ib.project, 0);
	const order = state.projects.map((p) => p.slug);
	const slugs = [...counts.keys()].sort((a, b) => ((order.indexOf(a) + 1 || 999) - (order.indexOf(b) + 1 || 999)) || a.localeCompare(b));
	const chip = (slug, label, n) => `<button type="button" class="ib-chip" data-ib-project="${esc(slug)}" aria-pressed="${ib.project === slug}">${esc(label)}${n !== null ? `<i>${n}</i>` : ""}</button>`;
	const chips = slugs.length > 1 || ib.project ? `<div class="ib-chips" role="group" aria-label="Project">${chip("", "All", null)}${slugs.map((s) => chip(s, projectName(s), counts.get(s))).join("")}</div>` : "";
	return `<div class="ib-since" title="Since ${esc(when(ib.since))}">Since you were away: ${bits}</div>${chips}`;
}
function ibTabsHtml() {
	return IB_TABS.map(([key, label, title]) => `<button type="button" class="ib-tab" role="tab" data-ib-tab="${key}" aria-selected="${ib.tab === key}" title="${esc(title)}">${esc(label)}<i>${ibCount(key)}</i></button>`).join("");
}
// "Accept N recommendations", on Answer, when more than one decision in view has one; and the keys, once.
const ibAcceptable = () => (ib.tab === "answer" ? ibTabItems("answer").filter((i) => ibRecOf(i).length) : []);
function ibToolsHtml() {
	const acc = ibAcceptable();
	const accept = acc.length > 1 && !ib.focus ? `<button type="button" class="ib-accept" data-ib-accept title="Answer each of them with what the agent recommends">Accept ${acc.length} recommendations</button>` : "";
	// Each key with its words (and the dot after them), so a line breaks only between them.
	const keys = [["J</b> <b>K", "move"], ["1–9", "pick"], ["Enter", "takes the recommendation"], ["D", "later"], ["G", "give back"], ["X", "drop"], ["F", "one at a time"]]
		.map(([k, what], n, all) => `<span><b>${k}</b> ${what}${n < all.length - 1 ? " ·" : ""}</span>`).join(" ");
	const hint = localGet("inbox.hint") === "off" || ibPhone() ? "" : `<div class="ib-hint"><span class="ib-keys">${keys}</span>
		<button type="button" class="icon-btn" data-ib-hint-off title="Hide the keys (Settings → About → Look lists them all)" aria-label="Hide the keys"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor"><g stroke-width="1.6"><path d="m4.5 4.5 7 7M11.5 4.5l-7 7"/></g></svg></button></div>`;
	return accept || hint ? `${accept}${hint}` : "";
}
// A day ahead, short: "today", "tomorrow", "on Thu" (this week), "on 3 Dec".
function ibDay(t) {
	const n = dayDiff(toDate(t));
	return n <= 0 ? "today" : n === 1 ? "tomorrow" : n < 7 ? `on ${toDate(t).toLocaleDateString([], { weekday: "short" })}` : `on ${day(t)}`;
}
// The meta line: project · recommends X (or how many choices) · goes ahead on Thu · unblocks N.
function ibMeta(i) {
	const rec = i.kind === "decision" ? askRecommends(i) : "";
	const n = i.kind === "decision" ? optionsOf(i).length : 0;
	const due = askDue(i);
	return [
		i.priority === 1 ? `<b class="ib-p1">P1</b>` : "",
		ib.project ? (i.area ? esc(i.area) : "") : esc(projectName(i.project)),
		rec ? `recommends <b>${esc(rec.length > 36 ? `${rec.slice(0, 34).trimEnd()}…` : rec)}</b>` : n ? `${n} choices` : "",
		i.kind === "check" && i.steps?.length ? `${i.steps.length} step${i.steps.length === 1 ? "" : "s"}` : "",
		due ? `<span class="${due.soon ? "ib-soon" : ""}" title="${esc(due.text)}">${esc(`${due.what ? "goes ahead" : "closes"} ${ibDay(due.at)}`)}</span>`
			: ibTabOf(i) === "look" ? `<span title="It has no default and no date: it waits until you look">waits for you</span>` : "",
		i.unblocks > 0 ? `unblocks ${i.unblocks}` : "",
	].filter(Boolean).join(" · ");
}
function ibLines() {
	const items = ibTabItems();
	const holds = items.filter(ibHolds), rest = items.filter((i) => !ibHolds(i));
	const lines = [];
	const head = (key, text) => lines.push({ key: `h:${key}`, html: `<div class="ib-grp" role="presentation">${esc(text)}</div>` });
	const rows = (list) => list.forEach((i) => lines.push({ key: `i:${i.id}`, item: i }));
	if (holds.length) { head("holds", "Holds up agents"); rows(holds); }
	if (ib.tab === "look") {
		const reviews = rest.filter((i) => i.kind !== "notice"), notices = rest.filter((i) => i.kind === "notice");
		if (reviews.length && (holds.length || notices.length)) head("reviews", "Reviews");
		rows(reviews);
		if (notices.length && (holds.length || reviews.length)) head("notices", "Notices · just so you know");
		rows(notices);
	} else {
		if (rest.length && holds.length) head("rest", ib.tab === "answer" ? "Decide" : "To do");
		rows(rest);
	}
	const def = ibDeferred();
	if (!items.length) lines.push({ key: "empty", html: ibEmptyHtml() });
	else if (def.length) lines.push({ key: "deferred", html: `<div class="ib-deferred" role="presentation">${esc(ibDeferredText(def))}</div>` });
	return lines;
}
function ibDeferredText(def) {
	const days = [...new Set(def.map((d) => day(d.until, { weekday: true, relative: true })))];
	return days.length === 1 ? `${def.length} deferred until ${days[0]}` : `${def.length} deferred, the first back ${days[0]}`;
}
// What an empty tab says: nothing waits on you (or nothing of this kind), what's deferred and when it comes back,
// and the tabs that do have something.
const IB_NONE = { answer: "Nothing to answer", errands: "No errands", look: "Nothing to look at" };
function ibEmptyText() {
	const def = ibDeferred();
	const others = IB_TABS.filter(([k]) => k !== ib.tab && ibCount(k));
	const title = others.length ? IB_NONE[ib.tab] : "Nothing waits on you";
	const text = def.length ? `${ibDeferredText(def)}; ${def.length === 1 ? "it comes" : "they come"} back then.` : "Nothing is deferred.";
	const go = others.map(([k, label]) => `<button type="button" class="ghost sm" data-ib-tab="${k}">${esc(label)} · ${ibCount(k)}</button>`).join("");
	return { title, text, go };
}
function ibEmptyHtml() {
	const { title, text, go } = ibEmptyText();
	return `<div class="ib-empty" role="presentation">${emptyState(title, text, go)}</div>`;
}
function ibRowHtml(line) {
	if (!line.item) return line.html;
	const i = line.item;
	return row(i, { meta: ibMeta(i), right: `<span title="Waiting since ${esc(when(i.created_at))}">${esc(ago(i.created_at, { short: true }))}</span>`, selected: i.id === ib.sel });
}

function inboxRender() {
	if (!ib.loaded) return;
	inboxEl.classList.toggle("ib-focus", ib.focus);
	const lines = ibLines();
	ib.shown = lines.filter((l) => l.item).map((l) => l.item);
	ibKeepSelection();
	paint($(".ib-head", inboxEl), ibHeadHtml());
	paint($(".ib-tabs", inboxEl), ibTabsHtml());
	paint($(".ib-tools", inboxEl), ibToolsHtml());
	const hadFocus = ibListEl.contains(document.activeElement);
	keyedList(ibListEl, lines, (l) => l.key, ibRowHtml);
	if (hadFocus) ibListFocus();
	ibRenderPane();
}
// The selection stays on its item; when that item has gone (answered here or elsewhere), the one that took its place.
function ibKeepSelection() {
	const at = ib.shown.findIndex((i) => i.id === ib.sel);
	if (at >= 0) { ib.selAt = at; return; }
	// The sheet went on to another item of the list (J and K there): follow it.
	if (readerOpen() && ib.shown.some((i) => i.id === sheet.item?.id)) { ib.sel = sheet.item.id; ib.selAt = ib.shown.findIndex((i) => i.id === ib.sel); return; }
	const next = ib.shown[Math.min(ib.selAt, ib.shown.length - 1)];
	ib.sel = next?.id ?? null;
}
function ibRenderPane() {
	const i = ib.shown.find((x) => x.id === ib.sel);
	const empty = $(".ib-pane-empty", inboxEl);
	ibPaneEl.hidden = !i;
	empty.hidden = !!i;
	if (!i) {
		const { title, text, go } = ibEmptyText();
		paint(empty, ib.shown.length ? "" : `<div class="ib-calm">${glyph("check")}</div>${emptyState(ib.cleared ? `${ib.cleared} cleared. ${title}.` : title, text, go)}`);
	}
	const left = ib.shown.length, all = left + ib.cleared;
	paint($(".ib-focus-head", inboxEl), !ib.focus ? "" : `<div class="ib-fh">
		<b>${esc(IB_TABS.find(([k]) => k === ib.tab)[1])}</b><span class="ib-fh-n" aria-live="polite">${ib.cleared} cleared · ${left} to go</span><span class="spacer"></span>
		<button type="button" class="ghost sm" data-ib-focus title="Show the list again (F)">Show the list ${ibKey("F")}</button></div>
		<div class="ib-bar" role="progressbar" aria-valuemin="0" aria-valuemax="${all}" aria-valuenow="${ib.cleared}"><i style="width:${all ? (100 * ib.cleared) / all : 0}%"></i></div>`);
	if (!i) return;
	// The reader shows the selected item: from the board's list at once (with its brief), then all of it.
	if (ibPane.item?.id !== i.id) {
		const known = state.items.find((x) => x.id === i.id);
		ibPane.show({ ...(known ?? i), loading: true });
	}
}

/* ---------- Moving and acting ---------- */

function ibSelect(id, { open = false, scroll = true } = {}) {
	if (id == null) return;
	ib.sel = id;
	ib.selAt = Math.max(0, ib.shown.findIndex((i) => i.id === id));
	inboxRender();
	const el = ibListEl.querySelector(`[data-id="${id}"]`);
	if (scroll) el?.scrollIntoView({ block: "nearest" });
	if (open && !ibPaneShows()) ibOpenSheet(id);
}
function ibMove(dir) {
	if (!ib.shown.length) return;
	const at = ib.shown.findIndex((i) => i.id === ib.sel);
	const to = at < 0 ? 0 : Math.max(0, Math.min(ib.shown.length - 1, at + dir));
	ibSelect(ib.shown[to].id);
}
function ibListFocus() {
	const el = ibListEl.querySelector(".k-row.is-sel") ?? ibListEl;
	if (ib.focus || !el.getClientRects().length) return ibPane.focus();
	el.focus({ preventScroll: true });
}
const ibSheetList = () => ib.shown.map((i) => i.id);
function ibOpenSheet(id) {
	openItemById(id, { list: ibSheetList }).catch((e) => toast(e.message));
}
// Something was answered or settled on this page: the list again, and the selection moves on when the item left.
hooks.settled.push((item) => {
	if (!item || ib.accepting) return;
	const was = ib.shown.some((i) => i.id === item.id);
	const stays = OPEN.includes(item.status) && item.owner === "kostas" && !(item.deferred_until && parseTime(item.deferred_until) > Date.now());
	if (was && !stays) ib.cleared++;
	inboxLoad().then(() => {
		// The sheet, opened from here on a narrow window, goes on to the next one too (and closes after the last).
		if (!ibOn() || stays || !readerOpen() || sheet.item?.id !== item.id || ibPaneShows()) return;
		if (ib.sel != null && ib.sel !== item.id) ibOpenSheet(ib.sel);
		else closeSheet();
	});
});
// A key the reader knows (1–9, D, G, X, E, O, A, M), sent to it: the pane's, or the sheet opened for it.
function ibForward(key) {
	const i = ib.shown.find((x) => x.id === ib.sel);
	if (!i) return;
	const send = (host) => $(".rd-scroll", host)?.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
	if (ibPaneShows()) return send(ibPaneEl);
	openItemById(i.id, { list: ibSheetList }).then(() => send(sheetDlg)).catch((e) => toast(e.message));
}
// Enter: the recommended answer, No objections or Got it.
function ibTakePrimary() {
	const i = ib.shown.find((x) => x.id === ib.sel);
	const p = ibPrimary(i);
	if (!p) return toast(i?.kind === "decision" ? "Nothing is recommended: pick one with 1–9, or answer in your words (O)." : "Open it to do it: R, or Enter on a check's Run it.");
	const r = ibPaneShows() ? ibPane : null;
	if (r && r.item?.id === i.id) return p.ack ? r.ack() : r.answer(p.answer);
	const call = p.ack ? act.ack(i.id) : act.answer(i.id, p.answer);
	call.then(() => toast(p.label)).catch((e) => toast(e.message));
}
async function ibAcceptAll(btn) {
	const list = ibAcceptable();
	if (list.length < 2) return;
	const what = (i) => (askMany(i) ? [...askTicked(i)] : ibRecOf(i)[0]);
	const shown = list.slice(0, 12).map((i) => `• ${i.title} → ${Array.isArray(what(i)) ? what(i).join("; ") || "none of them" : what(i)}`);
	const more = list.length > 12 ? `\n… and ${list.length - 12} more` : "";
	const asked = confirmIn(btn, { text: `Answer these ${list.length} decisions with what the agent recommends?\n\n${shown.join("\n")}${more}`, yes: `Answer ${list.length}` });
	// Wider, for the list: placed again under the button, now that it's its own size.
	const dlg = document.querySelector("dialog.k-confirm:last-of-type");
	if (dlg) {
		dlg.classList.add("ib-confirm");
		const a = btn.getBoundingClientRect();
		dlg.style.left = `${Math.max(8, Math.min(a.left, innerWidth - dlg.offsetWidth - 8))}px`;
		dlg.style.top = `${Math.max(8, Math.min(a.bottom + 6, innerHeight - dlg.offsetHeight - 8))}px`;
	}
	if (!(await asked)) return;
	ib.accepting = true;
	let done = 0;
	const failed = [];
	try {
		for (const i of list) {
			toast(`Answering ${done + 1} of ${list.length}…`);
			try { await act.answer(i.id, what(i)); done++; ib.cleared++; } catch (e) { failed.push(`wb-${i.ref}: ${e.message}`); }
		}
	} finally { ib.accepting = false; }
	toast(failed.length ? `Answered ${done}; ${failed.length} didn't go: ${failed[0]}` : `Answered ${done} with the recommendation`);
	await inboxLoad();
	inboxRender();
}

function ibSetTab(tab) {
	if (!IB_TABS.some(([k]) => k === tab) || tab === ib.tab) return;
	ib.tab = tab;
	localSet("inbox.tab", tab);
	ib.sel = null;
	ib.selAt = 0;
	inboxRender();
}
const ibHash = (focus = ib.focus, project = ib.project) => `#${focus ? "queue" : "inbox"}${project ? `/${encodeURIComponent(project)}` : ""}`;
function ibSetProject(slug) {
	localSet("inbox.project", slug);
	go(ibHash(ib.focus, slug), { replace: true });
}
function ibToggleFocus() { go(ibHash(!ib.focus), { replace: true }); }

/* ---------- Clicks, keys and swipes ---------- */

inboxEl.addEventListener("click", (e) => {
	if (ibPaneEl.contains(e.target)) return;
	const t = e.target;
	const tab = t.closest("[data-ib-tab]");
	if (tab) return ibSetTab(tab.dataset.ibTab);
	const p = t.closest("[data-ib-project]");
	if (p) return ibSetProject(p.dataset.ibProject);
	if (t.closest("[data-ib-focus]")) return ibToggleFocus();
	const acc = t.closest("[data-ib-accept]");
	if (acc) return ibAcceptAll(acc);
	if (t.closest("[data-ib-hint-off]")) { localSet("inbox.hint", "off"); return inboxRender(); }
	const r = t.closest(".k-row");
	if (r && !ibSwiped) ibSelect(Number(r.dataset.id), { open: true, scroll: false });
});

const IB_FORWARD = new Set(["1", "2", "3", "4", "5", "6", "7", "8", "9", "d", "g", "x", "e", "o", "a", "m"]);
document.addEventListener("keydown", (e) => {
	if (e.altKey || e.ctrlKey || e.metaKey || e.defaultPrevented) return;
	if (document.querySelector("dialog[open]") || rdTyping()) return;
	const k = e.key, low = k.length === 1 ? k.toLowerCase() : k;
	// From anywhere: T opens the Inbox, and Q (the old key for One at a time) the Inbox in focus mode.
	if (!ibOn()) {
		if (low === "q" && !e.shiftKey) { e.preventDefault(); go(ibHash(true)); }
		else if (low === "t" && !e.shiftKey) { e.preventDefault(); goHome(); }
		return;
	}
	if (e.shiftKey && k !== "Enter") return;
	const inPane = ibPaneEl.contains(e.target);
	const key = (fn) => { e.preventDefault(); fn(); };
	// A held key repeats: only moving may.
	if (e.repeat && !/^(j|k|ArrowDown|ArrowUp)$/.test(low)) { e.preventDefault(); return; }
	if (low === "f" || low === "q") return key(ibToggleFocus);
	// In the reader, its own keys work as they do anywhere (J and K come back here through its nav).
	if (inPane) {
		if (k === "Enter" && !ibPane.later && !e.target.closest("button, a, label, input, select, textarea")) return key(ibTakePrimary);
		return;
	}
	// The reader beside the list is asking something of its own (Later's days, Give back's words): the keys go to it, so
	// Enter means what the reader says and never answers the decision.
	const busy = ibPaneShows() && ib.sel != null && ibPane.item?.id === ib.sel ? ibPane.collecting() : "";
	if (busy === "later" && (k === "Enter" || k === "Escape" || low === "w" || low === "d" || k === "3")) return key(() => ibForward(k === "Enter" || k === "Escape" ? k : low));
	if (busy === "reply" && k === "Enter" && !e.target.closest?.("button, a, input, select, textarea")) return key(() => ibPane.focusReply());
	if (low === "j" || k === "ArrowDown") return key(() => ibMove(1));
	if (low === "k" || k === "ArrowUp") return key(() => ibMove(-1));
	if (e.target.closest?.("button, a, input, select, textarea") && k === "Enter") return;
	if (k === "Enter" && e.shiftKey) return;
	if (k === "Enter") return key(ibTakePrimary);
	if (low === "r") return key(() => (ibPaneShows() ? ibPane.focus() : ib.sel != null && ibOpenSheet(ib.sel)));
	if (IB_FORWARD.has(low)) return key(() => ibForward(low));
});

// On a phone: swipe a row right for the recommendation (or No objections, Got it), left for later (tomorrow). Only a
// mostly sideways move counts; up and down still scroll. (One at a time's swipe, on a row.)
let ibTouch = null, ibSwiped = false;
ibListEl.addEventListener("pointerdown", (e) => {
	const r = e.target.closest(".k-row");
	if (e.pointerType === "mouse" || !r) return;
	ibSwiped = false;
	ibTouch = { x: e.clientX, y: e.clientY, id: e.pointerId, side: false, row: r, item: ib.shown.find((i) => i.id === Number(r.dataset.id)) };
});
ibListEl.addEventListener("pointermove", (e) => {
	const s = ibTouch;
	if (!s || e.pointerId !== s.id) return;
	const dx = e.clientX - s.x, dy = e.clientY - s.y;
	if (!s.side) {
		if (Math.abs(dy) > 12 && Math.abs(dy) > Math.abs(dx)) { ibTouch = null; return; }
		if (Math.abs(dx) < 12) return;
		s.side = true;
		const p = ibPrimary(s.item);
		s.can = !!p;
		s.under = document.createElement("div");
		s.under.className = "ib-swipe";
		s.under.innerHTML = `<span class="yes">${esc(p ? p.label : "Nothing recommended")}</span><span class="no">Later: tomorrow</span>`;
		s.under.style.top = `${s.row.offsetTop}px`;
		s.under.style.height = `${s.row.offsetHeight}px`;
		ibListEl.append(s.under);
	}
	const go = dx > 0 && !s.can ? dx / 6 : dx;
	s.row.style.transition = "none";
	s.row.style.translate = `${go}px 0`;
	s.under.classList.toggle("ib-yes", dx > 40 && s.can);
	s.under.classList.toggle("ib-no", dx < -40);
	s.under.dataset.dir = dx > 0 ? "right" : "left";
});
function ibTouchEnd(e) {
	const s = ibTouch;
	if (!s || e.pointerId !== s.id) return;
	ibTouch = null;
	if (!s.side) return;
	ibSwiped = true;
	setTimeout(() => { ibSwiped = false; }, 400);
	const dx = e.clientX - s.x;
	s.under?.remove();
	s.row.style.transition = "";
	s.row.style.translate = "";
	if (e.type === "pointercancel" || !s.item) return;
	if (dx > 90 && s.can) {
		const p = ibPrimary(s.item);
		(p.ack ? act.ack(s.item.id) : act.answer(s.item.id, p.answer)).then(() => toast(p.label)).catch((err) => toast(err.message));
	} else if (dx < -90) act.defer(s.item.id, "tomorrow").then(() => toast("Later: back tomorrow")).catch((err) => toast(err.message));
}
ibListEl.addEventListener("pointerup", ibTouchEnd);
ibListEl.addEventListener("pointercancel", ibTouchEnd);

/* ---------- The view ---------- */

hooks.refresh.push(() => {
	if (ibOn()) {
		inboxLoad();
		if (ibPaneShows() && ibPane.item && !ibPane.compose) ibPane.reload();
		return;
	}
	// Elsewhere the queue is asked for only when the projects' own counts moved (a new ask, or one an agent settled).
	const sig = state.projects.map((p) => `${p.slug}:${p.mine}:${p.notices}`).join();
	if (ib.loaded && ib.projectsSig !== undefined && sig !== ib.projectsSig) inboxLoad();
	else if (ib.loaded) inboxCount();
	ib.projectsSig = sig;
});
hooks.start.push(() => { if (!ib.loaded) inboxLoad(); });
hooks.readerClosed.push(() => { if (ibOn()) { inboxLoad(); ibListFocus(); } });
// The phone turned, or the window went narrow or wide: the reader beside the list or not.
matchMedia("(min-width: 1101px)").addEventListener("change", () => { if (ibOn()) inboxRender(); });
hooks.shortcuts.push([[["T"], ["Q"]], "The Inbox (Q: one at a time)"]);
hooks.shortcuts.push([[["J"], ["K"]], "In the Inbox: the next or previous item, open beside the list"]);
hooks.shortcuts.push([[["Enter"]], "In the Inbox: the recommended answer, No objections or Got it"]);
hooks.shortcuts.push([[["1"], ["9"]], "In the Inbox: answer with that choice"]);
hooks.shortcuts.push([[["D"], ["G"], ["X"], ["E"], ["R"]], "In the Inbox: later, give back, drop, edit the brief, read (into the reader)"]);
hooks.shortcuts.push([[["F"]], "In the Inbox: one item at a time, without the list"]);

defineView({
	name: "inbox",
	el: "#inbox-view",
	default: true,
	// #inbox, #inbox/<slug>; #queue, #queue/<slug> in focus mode. "" (the board's own address) comes here too, and so
	// do the old addresses of what the Inbox took over: #board (every project's open work) and #today (Today's brief,
	// which the "While you were away" notification opened).
	match(h) {
		if (h === "#board" || h === "#today") return {};
		const m = h.match(/^#(inbox|queue)(?:\/([^/]+))?$/);
		return m ? { focus: m[1] === "queue", project: m[2] ? decodeURIComponent(m[2]) : "" } : null;
	},
	show(p, { from }) {
		// The board's own address: the project last picked, said in the address.
		if (p.focus === undefined) {
			// (Not under an item opened by its address: the reader keeps that address.)
			if (!/^#item\//.test(location.hash) && (ib.project || location.hash)) return go(ibHash(false, ib.project), { replace: true });
			p = { focus: false, project: "" };
		}
		const entering = from !== "inbox" || p.focus !== ib.focus;
		if (from !== "inbox") ib.cleared = 0;
		ib.project = p.project;
		localSet("inbox.project", ib.project);
		ib.focus = p.focus;
		inboxRender();
		inboxLoad();
		if (entering) requestAnimationFrame(() => ibListFocus());
	},
	title: "Inbox",
	nav: "inbox",
	entry: { label: "Inbox", order: 10, icon: '<path d="M2.25 9.25 4 3.75h8l1.75 5.5v3.5a.5.5 0 0 1-.5.5h-10.5a.5.5 0 0 1-.5-.5z"/><path d="M2.25 9.25h3.25l.75 1.5h3.5l.75-1.5h3.25"/>' },
});
