/* ---------- Today: a one-screen brief of what needs you, what agents did and what's stuck ---------- */

// Opens from "Today" in the top bar or the T key, at #today, for the project on the left (or all). What waits on you
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
function todayWhen(ms) {
	const d = new Date(ms), t = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
	if (d.toDateString() === new Date().toDateString()) return `today ${t}`;
	if (Date.now() - ms < 6 * 86400e3) return `${d.toLocaleDateString([], { weekday: "short" })} ${t}`;
	return `${d.toLocaleDateString([], { day: "numeric", month: "short" })} ${t}`;
}
// How long since a database time: "5 h", "9 d", "3 mo".
function todayAge(s) {
	const h = (Date.now() - parseTime(s)) / 3600e3;
	return h < 1 ? "just now" : h < 24 ? `${Math.floor(h)} h` : h < 24 * 60 ? `${Math.floor(h / 24)} d` : `${Math.floor(h / 720)} mo`;
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
	add(mine.filter((i) => i.unblocks > 0).sort((a, b) => b.unblocks - a.unblocks), 3, (i) => todayTag("", todayAge(i.created_at)));
	add([...fresh].reverse(), 4, (i) => todayTag("new", "new") + todayTag("", todayAge(i.created_at)));
	add(mine, 3, (i) => todayTag("", `waiting ${todayAge(i.created_at)}`));
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
	const head = `<div class="td-head"><h2>Today</h2><small>${esc(state.project ? projectName(state.project) : "All projects")} · since ${todayWhen(today.since)}</small><span class="spacer"></span>
		<button type="button" class="ghost sm" id="td-fresh" title="Count only what happens from now on">Start from now</button></div>`;
	paint(todayEl, `${head}${parts.length ? `<div class="td-cols">${parts.join("")}</div>` : `<p class="td-empty">Nothing new since ${todayWhen(today.since)}, and nothing waits on you.</p>`}`);
}

todayEl.addEventListener("click", (e) => {
	const it = e.target.closest("[data-item]");
	if (it) return openItemById(it.dataset.item).catch((err) => toast(err.message));
	if (e.target.closest("#td-fresh")) return todayLoad(true);
	if (e.target.closest("[data-queue]")) return (location.hash = "#queue");
	const b = e.target.closest("[data-board]");
	if (b) {
		state.who = b.dataset.board;
		localSet("who", state.who);
		goBoard();
		renderBoard();
	}
});

const todayBtn = document.createElement("button");
todayBtn.type = "button";
todayBtn.className = "ghost vault-btn";
todayBtn.id = "today-btn";
todayBtn.title = "Today: what needs you, what agents did, what's stuck (T)";
todayBtn.setAttribute("aria-label", "Today");
todayBtn.setAttribute("aria-pressed", "false");
todayBtn.innerHTML = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><g stroke-width="1.5"><rect x="2.5" y="3.5" width="11" height="10" rx="1.5"/><path d="M2.5 6.75h11M5.5 2v3M10.5 2v3"/></g></svg><span>Today</span>`;
$("#usage-btn").before(todayBtn);
const todaySync = () => todayBtn.setAttribute("aria-pressed", String(location.hash === "#today"));
todayBtn.onclick = () => (location.hash === "#today" ? goBoard() : (location.hash = "#today"));
addEventListener("hashchange", todaySync);

document.addEventListener("keydown", (e) => {
	if (e.key.toLowerCase() !== "t" || e.ctrlKey || e.metaKey || e.altKey) return;
	if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName) || document.activeElement?.isContentEditable || document.querySelector("dialog[open]")) return;
	e.preventDefault();
	todayBtn.click();
});
hooks.shortcuts.push([[["T"]], "Today, or back to the board"]);
hooks.refresh.push(() => { if (todayOn()) todayLoad(); });
dlg.addEventListener("close", () => { if (todayOn()) todayLoad(); });

views.push({
	name: "today",
	el: "#today-view",
	match: (h) => h === "#today",
	title: "Today · Workbench",
	open() {
		todaySync();
		today.data = null;
		todayEl.innerHTML = "";
		todayEl._html = "";
		return todayLoad();
	},
});
