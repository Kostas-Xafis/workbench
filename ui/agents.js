/* ---------- Agents: what every project's agents are doing, what's ready to land, what's stuck, what finished ---------- */

// A view at #agents (#agents/<slug> for one project), from GET /api/agents (agents.ts; docs/agents.md, "The Agents
// place"). It asks for every project and filters here, so the nav's count stays the whole board's whichever project
// shows. While it shows it asks every 5 s; hidden, with the board's own poll (for the nav's count). Each lane is a
// keyedList, so a card that didn't change isn't drawn again. "Finished" runs from your last visit here (kept per
// browser: a new visit starts after an hour away), 24 hours the first time.
const AG_POLL = 5000, AG_GAP = 3600e3, AG_MAX = 7 * 86400e3;
const ag = { data: null, project: "", since: 0, timer: 0, busy: new Set(), loading: null, all: new Set() };
// A lane shows this many cards until "Show all".
const AG_SHOWN = 6;
// Stuck, worst first: what broke, then what waits on you, then what went quiet.
const AG_STUCK_ORDER = ["failed", "land-failed", "stopped", "land-stopped", "waits-on-you", "no-sign-of-life", "waiting"];
const agEl = document.createElement("section");
agEl.id = "agents-view";
agEl.setAttribute("aria-label", "Agents");
agEl.hidden = true;
agEl.innerHTML = `<div class="ag-wrap">
	<header class="ag-head"><span class="ag-counts" aria-live="polite"></span><nav class="ag-filters" aria-label="Project"></nav></header>
	<div class="ag-limits" hidden></div>
	<div class="ag-lanes">
		<section class="ag-lane" data-lane="running" aria-label="Running now"><h2><span class="ag-dot" aria-hidden="true"></span>Running now <i></i></h2><div class="ag-list" role="listbox" aria-label="Running now"></div></section>
		<section class="ag-lane" data-lane="ready" aria-label="Ready to land"><h2>Ready to land <i></i></h2><div class="ag-list" role="listbox" aria-label="Ready to land"></div></section>
		<section class="ag-lane" data-lane="stuck" aria-label="Stuck"><h2>Stuck <i></i></h2><div class="ag-list" role="listbox" aria-label="Stuck"></div></section>
	</div>
	<section class="ag-log" aria-label="Finished"><h2>Finished <i></i></h2><div class="ag-list" role="listbox" aria-label="Finished"></div></section>
</div>`;
$("#content").append(agEl);
const agOn = () => !agEl.hidden;
const agLane = (name) => agEl.querySelector(`[data-lane="${name}"] .ag-list`);

/* ---------- Since when: your last visit ---------- */
function agSince() {
	const now = Date.now(), last = Number(localGet("agents.last")) || 0;
	let since = Number(localGet("agents.since")) || 0;
	if (!since || now - last > AG_GAP) since = last || now - 86400e3;
	localSet("agents.since", String(since));
	localSet("agents.last", String(now));
	return Math.max(since, now - AG_MAX);
}

/* ---------- Loading ---------- */
async function agLoad() {
	if (ag.loading) return ag.loading;
	const since = ag.since || Date.now() - 86400e3;
	ag.loading = (async () => {
		try {
			const data = await api(`/api/agents?project=*&since=${encodeURIComponent(new Date(since).toISOString())}`);
			// Running in the nav; stuck, quietly, when nothing runs.
			const stuck = data.counts.stuck;
			if (data.counts.running) navCount("agents", data.counts.running, "running");
			else navCount("agents", stuck ? stuck : "", stuck ? "stuck" : undefined);
			if (data === ag.data) return;
			ag.data = data;
			if (agOn()) agRender();
		} catch (e) {
			if (agOn() && !ag.data) agLane("running").innerHTML = emptyState("Couldn't load the agents", e.message);
		} finally {
			ag.loading = null;
		}
	})();
	return ag.loading;
}
function agWatch() {
	clearTimeout(ag.timer);
	if (!agOn()) return;
	ag.timer = setTimeout(async () => {
		if (document.visibilityState === "visible") await agLoad();
		agWatch();
	}, AG_POLL);
}
hooks.start.push(() => { if (!agOn()) agLoad(); });
hooks.refresh.push(() => { if (!agOn()) agLoad(); });
hooks.readerClosed.push(() => { if (agOn()) agLoad(); });

/* ---------- Drawing ---------- */
const agIn = (x) => !ag.project || x.item.project === ag.project;
function agView() {
	const d = ag.data;
	const pick = (list) => (list ?? []).filter(agIn);
	const stuck = pick(d?.stuck).sort((a, b) => AG_STUCK_ORDER.indexOf(a.reason) - AG_STUCK_ORDER.indexOf(b.reason));
	return { running: pick(d?.running), ready: pick(d?.ready), stuck, finished: pick(d?.finished) };
}
// The order J and K follow in the reader: the lanes left to right (as many as they show), then Finished.
const agShown = (lane, list) => (ag.all.has(lane) ? list : list.slice(0, AG_SHOWN));
const agOrder = () => { const v = agView(); return [...agShown("running", v.running), ...agShown("ready", v.ready), ...agShown("stuck", v.stuck), ...v.finished].map((x) => x.item.id); };

const agRef = (i) => `<span class="ag-ref">wb-${esc(i.ref)}</span>`;
const agMeta = (...bits) => `<div class="ag-meta">${bits.filter(Boolean).join('<span class="ag-sep" aria-hidden="true">·</span>')}</div>`;
const agBranch = (b) => (b ? `<span class="ag-branch" title="${esc(b)}">${esc(b)}</span>` : "");
const agBtn = (act, id, label, { primary = false, why = "", title = "" } = {}) =>
	`<button type="button" class="${primary ? "primary" : "ghost"} sm" data-act="${act}" data-id="${id}"${why ? ` disabled title="${esc(why)}"` : title ? ` title="${esc(title)}"` : ""}>${esc(label)}</button>`;
const agCard = (x, cls, body) => `<div class="ag-card ${cls}" role="option" tabindex="0" aria-selected="false" data-id="${x.item.id}" data-ref="${esc(x.item.ref)}">${body}</div>`;
const agTitle = (i) => `<div class="ag-title">${esc(i.title)}</div>`;

function agRunningCard(x) {
	const i = x.item, r = x.run;
	const ev = x.event;
	const said = ev ? (ev.kind === "tool" ? (ev.tool?.startsWith("mcp__wb__") ? ev.text.replace(/^mcp__wb__/, "wb ") : ev.text) : ev.text) : x.note;
	const live = r && !r.ended_at;
	const desk = r?.desktop || i.desktop;
	const acts = [
		live ? agBtn("stop", r.id, ag.busy.has(`stop:${r.id}`) ? "Stopping…" : "Stop") : "",
		desk ? `<a class="ghost sm btn" href="${esc(desk)}" data-act="desktop" title="Opens the session in Claude Desktop">Open in Claude Desktop</a>` : "",
		agBtn("open", i.id, "Open"),
	].join("");
	return agCard(x, "is-running", `${agTitle(i)}
		${agMeta(esc(projectName(i.project)), agRef(i), agBranch(x.branch), `<span class="ag-live" title="${live ? "A run the board started" : "It called the board in the last few minutes"}"><span class="ag-dot" aria-hidden="true"></span>${esc(took(x.started_at))}</span>`, r?.kind === "land" ? "merging" : "")}
		${said ? `<div class="ag-said${ev?.kind === "tool" ? " is-tool" : ""}" title="${esc(said)}">${esc(said)}</div>` : ""}
		<div class="ag-acts">${acts}</div>`);
}
function agPr(pr) {
	if (!pr) return "";
	const st = pr.state === "MERGED" ? "done" : pr.checks === "failing" ? "failed" : pr.state === "OPEN" ? "" : "";
	const words = `PR #${pr.number} ${pr.state === "OPEN" ? (pr.draft ? "draft" : pr.checks === "failing" ? "checks failing" : pr.checks === "pending" ? "checks running" : "open") : pr.state.toLowerCase()}`;
	return pr.url ? `<a class="ag-pr" href="${esc(pr.url)}" target="_blank" rel="noreferrer" data-act="link">${chip(words, st)}</a>` : chip(words, st);
}
function agReadyCard(x) {
	const i = x.item;
	const busy = ag.busy.has(`land:${i.id}`);
	const ahead = x.ahead == null ? "not merged" : `${x.ahead} commit${x.ahead === 1 ? "" : "s"} ahead`;
	return agCard(x, "is-ready", `${agTitle(i)}
		${agMeta(esc(projectName(i.project)), agBranch(x.branch), esc(ahead), agPr(x.pr))}
		${x.note ? `<div class="ag-said" title="${esc(x.note)}">${esc(x.note)}</div>` : ""}
		<div class="ag-acts">${agBtn("land", i.id, busy ? "Starting…" : "Merge it", { primary: true, why: busy ? "Starting…" : x.land.why, title: `An agent merges ${x.branch} into ${x.base || "the main branch"} by the project's own rules` })}${agBtn("open", i.id, "See the note")}</div>`);
}
const AG_FAILED = new Set(["failed", "land-failed"]);
function agStuckCard(x) {
	const i = x.item, st = AG_FAILED.has(x.reason) ? "failed" : "stuck";
	const busy = ag.busy.has(`again:${i.id}`);
	const label = x.again.kind === "land" ? "Merge it again" : "Run again";
	const act = x.again.allowed
		? agBtn(x.again.kind === "land" ? "land" : "run", i.id, busy ? "Starting…" : label, { why: busy ? "Starting…" : "" })
		: x.again.why && x.reason !== "waits-on-you" ? `<span class="ag-why-not" title="${esc(x.again.why)}">${esc(x.again.why)}</span>` : "";
	return agCard(x, `is-${st}`, `${agTitle(i)}
		${agMeta(esc(projectName(i.project)), agRef(i), `<span class="ag-why st-${st}">${esc(x.why)}</span>`)}
		<div class="ag-acts">${act}${agBtn("open", i.id, "Open")}</div>`);
}
function agLogRow(x) {
	const i = x.item;
	const merged = x.merged === true ? chip("merged", "done") : x.merged === false ? chip("not merged") : "";
	return `<div class="ag-logrow" role="option" tabindex="0" aria-selected="false" data-id="${i.id}" data-ref="${esc(i.ref)}">
		<span class="ag-when" title="${esc(when(x.done_at))}">${esc(when(x.done_at))}</span><span class="ag-proj">${esc(projectName(i.project))}</span>
		<span class="ag-what"><span class="ag-t">${esc(i.title)}</span>${x.note ? `<span class="ag-note">${esc(x.note)}</span>` : ""}</span><span class="ag-m">${merged}</span></div>`;
}

function agFilters() {
	const d = ag.data;
	const slugs = new Set(["running", "ready", "stuck"].flatMap((k) => (d?.[k] ?? []).map((x) => x.item.project)));
	const list = state.projects.filter((p) => slugs.has(p.slug) || p.slug === ag.project);
	const one = (href, label, on) => `<a class="ag-filter" href="${href}"${on ? ' aria-current="true"' : ""}>${esc(label)}</a>`;
	return [one("#agents", "All projects", !ag.project), ...list.map((p) => one(`#agents/${encodeURIComponent(p.slug)}`, p.name, ag.project === p.slug))].join("");
}

function agRender() {
	const d = ag.data;
	if (!d) return;
	const v = agView();
	const since = new Date(ag.since || Date.now() - 86400e3);
	const sinceWords = Date.now() - since.getTime() <= 86400e3 + 60e3 ? "in the last day" : `since ${when(since)}`;
	paint(agEl.querySelector(".ag-counts"), esc([`${v.running.length} running`, `${v.ready.length} to land`, `${v.stuck.length} stuck`, `${v.finished.length} finished ${sinceWords}`].join(" · ")));
	paint(agEl.querySelector(".ag-filters"), agFilters());
	const lim = agEl.querySelector(".ag-limits");
	lim.hidden = !d.limits.length;
	paint(lim, d.limits.map((l) => `<p>${esc(l)}</p>`).join(""));
	for (const [lane, list] of Object.entries({ running: v.running, ready: v.ready, stuck: v.stuck })) {
		const h = agEl.querySelector(`[data-lane="${lane}"] h2 i`);
		h.textContent = list.length || "";
	}
	agEl.querySelector(".ag-log h2 i").textContent = v.finished.length || "";
	const empty = {
		running: ["No agent is running", "Run an agent's to-do from its item, or send one with your answer."],
		ready: ["Nothing to land", "Finished work whose branch isn't merged shows here."],
		stuck: ["Nothing is stuck", ""],
	};
	const draw = (el, list, card, [title, text], lane) => {
		if (!list.length) return keyedList(el, [{ empty: true }], () => "empty", () => emptyState(title, text));
		const shown = lane ? agShown(lane, list) : list;
		const more = shown.length < list.length ? [{ more: list.length - shown.length }] : [];
		keyedList(el, [...shown, ...more], (x) => (x.more ? "more" : `${x.item.id}`), (x) =>
			x.more ? `<button type="button" class="ag-more" data-act="more" data-lane="${lane}">Show ${x.more} more</button>` : card(x));
	};
	draw(agLane("running"), v.running, agRunningCard, empty.running, "running");
	draw(agLane("ready"), v.ready, agReadyCard, empty.ready, "ready");
	draw(agLane("stuck"), v.stuck, agStuckCard, empty.stuck, "stuck");
	draw(agEl.querySelector(".ag-log .ag-list"), v.finished, agLogRow, [`Nothing finished ${sinceWords}`, ""]);
}

/* ---------- Acting ---------- */
async function agAct(key, call, ok) {
	ag.busy.add(key);
	agRender();
	try {
		await call();
		if (ok) toast(ok);
	} catch (e) {
		toast(e.message);
	} finally {
		ag.busy.delete(key);
		await Promise.all([agLoad(), typeof runsLoad === "function" ? runsLoad() : null]);
		agRender();
	}
}
agEl.addEventListener("click", async (e) => {
	const b = e.target.closest("[data-act]");
	if (b) {
		const act = b.dataset.act, id = Number(b.dataset.id);
		if (act === "desktop" || act === "link") return; // the link opens by itself
		e.stopPropagation();
		if (act === "open") return agOpen(id);
		if (act === "more") { ag.all.add(b.dataset.lane); return agRender(); }
		if (act === "stop") {
			if (!(await confirmIn(b, { text: "Stop this agent, and everything it started?", yes: "Stop", danger: true }))) return;
			return agAct(`stop:${id}`, () => stopAgent(id), "Stopped");
		}
		if (act === "land") {
			const again = !!b.closest(".is-failed, .is-stuck");
			return agAct(again ? `again:${id}` : `land:${id}`, () => api(`/api/items/${id}/land`, { method: "POST", body: "{}" }), "An agent is merging it");
		}
		if (act === "run") return agAct(`again:${id}`, () => sendItem(id), "The agent is on it");
		return;
	}
	const card = e.target.closest("[data-id][role=option]");
	if (card && !e.target.closest("a")) agOpen(Number(card.dataset.id));
});
agEl.addEventListener("keydown", (e) => {
	const card = e.target.closest?.("[role=option][data-id]");
	if (!card || e.target !== card) return;
	if (e.key === "Enter" || e.key === " ") { e.preventDefault(); agOpen(Number(card.dataset.id)); }
});
const agOpen = (id) => openItemById(id, { list: agOrder }).catch((err) => toast(err.message));

/* ---------- The view ---------- */
defineView({
	name: "agents",
	el: agEl,
	match: (h) => {
		const m = h.match(/^#agents(?:\/([^/]+))?$/);
		return m ? { project: m[1] ? decodeURIComponent(m[1]) : "" } : null;
	},
	title: (p) => (p?.project ? `Agents · ${projectName(p.project)}` : "Agents"),
	nav: "agents",
	entry: { label: "Agents", order: 20, icon: '<rect x="2.25" y="3" width="11.5" height="9.5" rx="1.75"/><path d="m5 6.25 2 1.75-2 1.75M8.5 9.75h2.5"/>' },
	show(params, { from }) {
		ag.project = params.project || "";
		// A new visit (not a project picked in the view): Finished starts from the last one.
		if (from !== "agents" || !ag.since) ag.since = agSince();
		if (ag.data) agRender();
		agLoad();
		agWatch();
	},
	hide() {
		clearTimeout(ag.timer);
		localSet("agents.last", String(Date.now()));
	},
});
