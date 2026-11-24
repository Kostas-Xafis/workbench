/* ---------- Today: a one-screen brief of what needs you, what agents did and what's stuck ---------- */

// At #today (the T key opens the Inbox now, which says what came since your last visit), for the project the board showed last (or all). What waits on you
// comes from the open items; what agents finished (with the finishing note) and the updated reports come from
// /api/today (today.ts). "Since" is your last visit: kept per browser, a new visit starts after an hour away, a
// day ago the first time. Staleness (item.stale), what an answer unblocks (item.unblocks) and deadlines
// (item.decide_by) are read when items carry them; nothing here works them out.
const TODAY_GAP = 3600e3, TODAY_MAX = 7 * 86400e3, TODAY_SOON = 3 * 86400e3;
const today = { data: null, items: [], since: 0 };
const todayEl = document.createElement("section");
todayEl.id = "today-view";
todayEl.setAttribute("aria-label", "Today");
todayEl.hidden = true;
$("#content").append(todayEl);

// Counts this as a visit and says from when the brief runs.
function todaySince(fresh = false) {
	const now = Date.now(), last = Number(localGet("today.last")) || 0;
	let since = Number(localGet("today.since")) || 0;
	if (fresh) since = now;
	else if (!since || now - last > TODAY_GAP) since = last || now - 86400e3;
	localSet("today.since", String(since));
	localSet("today.last", String(now));
	return Math.max(since, now - TODAY_MAX);
}
const todayOn = () => !todayEl.hidden;

async function todayLoad(fresh = false) {
	const since = todaySince(fresh), project = state.project;
	const q = project ? `&project=${encodeURIComponent(project)}` : "";
	try {
		const [data, items] = await Promise.all([api(`/api/today?since=${encodeURIComponent(new Date(since).toISOString())}${q}`), api(`/api/items?status=${OPEN.join(",")}${q}`)]);
		if (project !== state.project || !todayOn()) return;
		today.data = data;
		today.items = project ? items : items.filter((i) => !isArchived(i.project));
		today.since = since;
		todayRender();
	} catch (e) { todayEl.innerHTML = `<p class="td-empty">Couldn't load Today: ${esc(e.message)}</p>`; }
}

const todayWhere = (i) => (state.project ? "" : `<span>${esc(projectName(i.project))}</span>`);
const todayTag = (cls, text, title = "") => `<span class="td-tag ${cls}"${title ? ` title="${esc(title)}"` : ""}>${esc(text)}</span>`;
function todayLine(i, tags = "") {
	const stale = i.stale ? todayTag("stale", "stale", typeof i.stale === "string" ? i.stale : "No news for a while") : "";
	return `<button type="button" class="td-line" data-item="${esc(i.ref ?? i.id)}">${kindIcon(i.kind)}<span class="td-t">${esc(i.title)}</span>
		<span class="td-m">${todayWhere(i)}${i.priority === 1 ? '<span class="p1">P1</span>' : ""}${i.unblocks > 0 ? todayTag("go", `unblocks ${i.unblocks}`, "Answering this lets agent work go on") : ""}${stale}${tags}</span></button>`;
}
const todaySec = (title, n, body, more = "", sub = "") => `<section class="td-sec"><h3>${title}${n ? `<span class="td-n">${n}</span>` : ""}${sub}</h3>${body}${more}</section>`;

function todayNeeds() {
	const mine = today.items.filter(needsYou).sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id - b.id);
	if (!mine.length) return "";
	const fresh = mine.filter((i) => parseTime(i.created_at) >= today.since);
	const shown = new Set(), rows = [];
	const add = (list, n, tag) => list.filter((i) => !shown.has(i.id)).slice(0, n).forEach((i) => { shown.add(i.id); rows.push(todayLine(i, tag(i))); });
	add(mine.filter((i) => i.unblocks > 0).sort((a, b) => b.unblocks - a.unblocks), 3, (i) => todayTag("", ago(i.created_at, { short: true })));
	add([...fresh].reverse(), 4, (i) => todayTag("new", "new") + todayTag("", ago(i.created_at, { short: true })));
	add(mine, 3, (i) => todayTag("", `waiting ${ago(i.created_at, { short: true })}`));
	const rest = mine.length - shown.size;
	// Queue mode (ui/queue.js): all of them, one at a time.
	const queue = `<button type="button" class="td-more td-queue" data-queue>Go through them one by one</button>`;
	return todaySec("Needs you", mine.length, rows.join(""), (rest > 0 ? `<button type="button" class="td-more" data-board="kostas">and ${rest} more on the board</button>` : "") + queue,
		fresh.length ? `<span class="td-n new">${fresh.length} new</span>` : "");
}

function todayDone() {
	const done = today.data.done;
	if (!done.length) return "";
	const by = new Map();
	for (const d of done) (by.get(d.project) ?? by.set(d.project, []).get(d.project)).push(d);
	const body = [...by].map(([project, list]) => {
		const rows = list.slice(0, 4).map((d) => {
			const c = state.code[d.ref]?.commits.length;
			return `<button type="button" class="td-line two" data-item="${esc(d.ref)}">${kindIcon(d.kind)}<span class="td-t">${esc(d.title)}${d.note ? `<small>${esc(d.note)}</small>` : ""}</span>
				<span class="td-m">${c ? `<span class="code-tag">${glyph("commit")}${c}</span>` : ""}<span>${ago(d.done_at)}</span></span></button>`;
		}).join("");
		return `${state.project ? "" : `<div class="td-grp">${esc(projectName(project))}</div>`}${rows}${list.length > 4 ? `<div class="td-rest">and ${list.length - 4} more</div>` : ""}`;
	}).join("");
	return todaySec("Done by agents", done.length, body);
}

function todayStuck() {
	const list = today.items.filter((i) => i.owner !== "kostas" && (i.status === "waiting" || i.stale));
	if (!list.length) return "";
	const rows = list.slice(0, 5).map((i) => todayLine(i, i.status === "waiting" ? todayTag("wait", "waiting") : "")).join("");
	return todaySec("Stuck", list.length, rows, list.length > 5 ? `<div class="td-rest">and ${list.length - 5} more</div>` : "");
}

// Coming up: the open items with a deadline (item.decide_by, added by default answers, wb-bkux) in the next days, or
// already past. Without that field on any item this renders nothing.
function todayComingUp() {
	const at = (i) => (i.decide_by ? parseTime(String(i.decide_by).replace("T", " ").replace("Z", "")).getTime() : NaN);
	const soon = today.items.filter((i) => at(i) < Date.now() + TODAY_SOON).sort((a, b) => at(a) - at(b));
	if (!soon.length) return "";
	const left = (i) => { const h = Math.round((at(i) - Date.now()) / 3600e3); return h < 0 ? "overdue" : h < 36 ? `in ${Math.max(h, 1)} h` : `in ${Math.round(h / 24)} d`; };
	return todaySec("Coming up", soon.length, soon.slice(0, 5).map((i) => todayLine(i, todayTag(at(i) < Date.now() ? "stale" : "", left(i), `Decide by ${i.decide_by}`))).join(""));
}

function todayReports() {
	const list = today.data.reports;
	if (!list.length) return "";
	const rows = list.slice(0, 5).map((r) => `<a class="td-line" href="#report/${r.id}"><span class="td-t">${esc(r.title)}</span>
		<span class="td-m">${state.project ? "" : `<span>${esc(projectName(r.project))}</span>`}<span>${ago(r.updated_at)}</span></span></a>`).join("");
	return todaySec("Reports updated", list.length, rows, list.length > 5 ? `<div class="td-rest">and ${list.length - 5} more</div>` : "");
}

function todayRender() {
	if (!today.data) return;
	const parts = [todayNeeds(), todayComingUp(), todayDone(), todayStuck(), todayReports()].filter(Boolean);
	const head = `<div class="td-head"><h2>Today</h2><small>${esc(state.project ? projectName(state.project) : "All projects")} · since ${when(today.since)}</small><span class="spacer"></span>
		<button type="button" class="ghost sm" id="td-fresh" title="Count only what happens from now on">Start from now</button></div>`;
	paint(todayEl, `${head}${parts.length ? `<div class="td-cols">${parts.join("")}</div>` : `<p class="td-empty">Nothing new since ${when(today.since)}, and nothing waits on you.</p>`}`);
}

todayEl.addEventListener("click", (e) => {
	const it = e.target.closest("[data-item]");
	if (it) return openItemById(it.dataset.item, { list: () => [...todayEl.querySelectorAll("[data-item]")].map((e) => e.dataset.item) }).catch((err) => toast(err.message));
	if (e.target.closest("#td-fresh")) return todayLoad(true);
	if (e.target.closest("[data-queue]")) return go("#queue");
	const b = e.target.closest("[data-board]");
	if (b) {
		state.who = b.dataset.board;
		localSet("who", state.who);
		go("#board");
		renderBoard();
	}
});


document.addEventListener("keydown", (e) => {
	if (e.key.toLowerCase() !== "t" || e.ctrlKey || e.metaKey || e.altKey) return;
	if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName) || document.activeElement?.isContentEditable || document.querySelector("dialog[open]")) return;
	e.preventDefault();
	// The Inbox (ui/inbox.js) took over what Today was for: T opens it. Today itself stays at #today.
	if (router.view?.name !== "inbox") goHome();
});
hooks.refresh.push(() => { if (todayOn()) todayLoad(); });
hooks.readerClosed.push(() => { if (todayOn()) todayLoad(); });

defineView({
	name: "today",
	el: "#today-view",
	match: (h) => (h === "#today" ? {} : null),
	title: "Today",
	nav: null,
	show() {
		today.data = null;
		todayEl.innerHTML = "";
		todayEl._html = "";
		return todayLoad();
	},
});
