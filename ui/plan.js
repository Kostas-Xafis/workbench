/* ---------- The morning plan: the top of the Inbox after a while away (inbox.js draws it in its head) ---------- */

// One line most of the time ("Since you were away: 6 new · 15 finished · 13 stuck"). On the first open after a gap
// (PLAN_GAP away, or the first open since the work day turned over at Settings' day.start) it unfolds into a short
// plan, until "Done for now" folds it again; the line's arrow unfolds it by hand. Kept in this browser (pref plan.*).
// - While you were away: what agents finished since your last visit (the Inbox's own "since", the first three by
//   title, each opening the reader), what's stuck and what waits to land, as the Agents place counts them (GET
//   /api/agents, which the Inbox asks for already).
// - Unblock first: the asks of yours that hold up the most agent work, in the queue's order (GET /api/queue's
//   `unblocks`), each with its recommendation as one tap (act.answer, as Enter in the Inbox), else Open.
// - Start next: the first startable item of each project's Next up (GET /api/queue's `next`, plan.ts), as many as
//   the limits leave room for, started one after another through Run's own path (sendItem, dispatch.js), so each
//   starts with its own model, effort and mode. Only where the board may start agents (Run's checks); a project
//   whose autopilot is on is left out (it starts its own).
const PLAN_GAP = 6 * 3600e3;
const PLAN_SHOWN = 3, PLAN_START_MAX = 4;
const plan = { starting: false };
const planSet = (k, v) => localSet(`pref.plan.${k}`, JSON.stringify(v));

// The latest start of a work day (`hour`, this device's time) at or before `now`.
function planDayStart(now, hour) {
	const d = new Date(now);
	d.setHours(Number(hour) || 0, 0, 0, 0);
	if (d.getTime() > now) d.setDate(d.getDate() - 1);
	return d.getTime();
}
// A gap: never seen here, PLAN_GAP away, or the first look since the day turned over.
const planGap = (now, seen, hour) => !seen || now - seen >= PLAN_GAP || seen < planDayStart(now, hour);

// A look at the Inbox (inboxLoad, while it shows and the tab is in front): a gap unfolds the plan.
function planTick(now = Date.now()) {
	if (document.visibilityState !== "visible") return;
	if (planGap(now, Number(pref("plan.seen", 0)), setting("day.start"))) planSet("opened", now);
	planSet("seen", now);
}
const planOpen = () => Number(pref("plan.opened", 0)) > Number(pref("plan.done", 0));

/* ---------- What it says ---------- */

const planCut = (s, n) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const planAuto = (slug) => !!state.allProjects?.find((p) => p.slug === slug)?.autopilot || !!state.projects.find((p) => p.slug === slug)?.autopilot;

// The asks that hold up the most agent work: the queue's order, most unblocked first.
function planUnblock() {
	const list = (ib.q?.items ?? []).filter((i) => (i.unblocks ?? 0) > 0 && !i.notice);
	return list.map((i, n) => [i, n]).sort((a, b) => b[0].unblocks - a[0].unblocks || a[1] - b[1]).map(([i]) => i).slice(0, PLAN_SHOWN);
}
// What Start next would start, and why not more: null where the board doesn't start agents from here.
function planStarts() {
	const info = typeof runs === "object" ? runs.info : null;
	if (!info?.on || !info.allowed) return null;
	const all = (ib.q?.next ?? []).filter((i) => !planAuto(i.project) && (canSend(i) || (info.limited && sendWhy(i) === info.why)));
	const free = info.limited ? 0 : Math.max(0, Math.min(info.atOnce - info.running, info.perDay - info.today));
	const n = Math.min(free, all.length, PLAN_START_MAX);
	const pick = all.slice(0, n || Math.min(all.length, PLAN_START_MAX));
	const why = n ? (all.length > n && free === n ? `${all.length - n} more when a slot is free` : "") : info.why || "No free slot: the limits are reached (Settings → Agents).";
	return { pick, n, why };
}

function planLine() {
	const fresh = ibAll().filter((i) => parseTime(i.created_at) >= ib.since).length;
	const c = ib.agents?.counts;
	return [
		`${fresh} new`,
		c ? `<a href="#agents">${c.finished} finished</a>` : "",
		c?.stuck ? `<a href="#agents" class="ib-stuck">${c.stuck} stuck</a>` : c ? `0 stuck` : "",
	].filter(Boolean).join(" · ");
}
const PLAN_ARROW = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" aria-hidden="true"><path d="m4.5 6.25 3.5 3.5 3.5-3.5" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';

// The Inbox's head calls this: the line, or the plan.
function planHtml() {
	const line = planLine();
	if (!planOpen())
		return `<div class="ib-since pl-line" title="Since ${esc(when(ib.since))}"><span>Since you were away: ${line}</span><button type="button" class="pl-unfold" data-pl-unfold title="Show the plan: what finished, what to answer first, what to start" aria-label="Show the plan" aria-expanded="false">${PLAN_ARROW}</button></div>`;
	const a = ib.agents, c = a?.counts;
	const out = [];
	// While you were away.
	const counts = c
		? [
			`<a href="#agents">${c.finished} finished</a>`,
			c.stuck ? `<a href="#agents" class="ib-stuck">${c.stuck} stuck</a>` : "0 stuck",
			c.ready ? `<a href="#agents">${c.ready} to land</a>` : "",
			`${ibAll().filter((i) => parseTime(i.created_at) >= ib.since).length} new asks`,
		].filter(Boolean).join(" · ")
		: "Loading what agents did…";
	const done = (a?.finished ?? []).slice(0, PLAN_SHOWN);
	const more = (c?.finished ?? 0) - done.length;
	out.push(`<div class="pl-sec"><div class="pl-h">While you were away <span title="Since ${esc(when(ib.since))}">${esc(ago(ib.since, { short: true }))}</span>
		<button type="button" class="ghost sm" data-pl-done title="Fold it to one line until your next time away">Done for now</button></div>
		<div class="pl-counts">${counts}</div>
		${done.length ? `<ul class="pl-list">${done.map((f) => `<li><button type="button" class="pl-title" data-pl-open="${f.item.id}" title="${esc(f.note || f.item.title)}"><span class="pl-dot pl-done" aria-hidden="true"></span><span>${esc(f.item.title)}</span></button></li>`).join("")}</ul>` : ""}
		${more > 0 ? `<a class="pl-more" href="#agents">${more} more on Agents</a>` : ""}</div>`);
	// Unblock first.
	const asks = planUnblock();
	if (asks.length)
		out.push(`<div class="pl-sec"><div class="pl-h">Unblock first</div><ul class="pl-list">${asks.map((i) => {
			const p = ibPrimary(i);
			const rec = i.kind === "decision" ? askRecommends(i) : "";
			const btn = p
				? `<button type="button" class="primary sm pl-act" data-pl-answer="${i.id}" title="${esc(p.label)}">${p.ack ? esc(p.label) : "Accept"}</button>`
				: `<button type="button" class="ghost sm pl-act" data-pl-open="${i.id}">Open</button>`;
			const meta = [rec && p ? `recommends <b>${esc(planCut(rec, 40))}</b>` : "", `unblocks ${i.unblocks}`, esc(projectName(i.project))].filter(Boolean).join(" · ");
			return `<li class="pl-ask"><button type="button" class="pl-title" data-pl-open="${i.id}"><span>${esc(i.title)}</span><small>${meta}</small></button>${btn}</li>`;
		}).join("")}</ul></div>`);
	// Start next.
	const s = planStarts();
	if (s && s.pick.length)
		out.push(`<div class="pl-sec"><div class="pl-h">Start next</div><ul class="pl-list">${s.pick.map((i, n) => `<li><button type="button" class="pl-title${n < s.n ? "" : " pl-off"}" data-pl-open="${i.id}"><span class="pl-dot" aria-hidden="true"></span><span>${esc(i.title)}</span><small>${esc(projectName(i.project))}</small></button></li>`).join("")}</ul>
			<div class="pl-start"><button type="button" class="primary sm" data-pl-start${s.n && !plan.starting ? "" : " disabled"}>${plan.starting ? "Starting…" : s.n === 1 ? "Start it" : `Start these ${s.n || s.pick.length}`}</button>${s.why ? `<span class="pl-why">${esc(s.why)}</span>` : ""}</div></div>`);
	return `<section class="pl" aria-label="Morning plan">${out.join("")}</section>`;
}

/* ---------- What it does ---------- */

const planRepaint = () => { if (ibOn() && ib.loaded && !ib.accepting) paint($(".ib-head", inboxEl), ibHeadHtml()); };
// An item: beside the list when it's there (a wide window), else the reader sheet.
function planOpenItem(id) {
	if (ibPaneShows() && !ib.focus && ib.shown.some((i) => i.id === id)) return ibSelect(id);
	openItemById(id).catch((e) => toast(e.message));
}
async function planStart() {
	const s = planStarts();
	if (!s?.n || plan.starting) return;
	const list = s.pick.slice(0, s.n);
	plan.starting = true;
	planRepaint();
	let started = 0;
	const failed = [];
	try {
		for (const i of list) {
			try { await sendItem(i.id); started++; } catch (e) { failed.push(`wb-${i.ref}: ${e.message}`); }
		}
	} finally { plan.starting = false; }
	const rest = (ib.q?.next?.length ?? 0) - list.length;
	toast([
		started ? `Started ${started === list.length ? (started === 1 ? "it" : `all ${started}`) : `${started} of ${list.length}`}` : "None started",
		failed.length ? `${failed.length === 1 ? "one" : failed.length} didn't: ${failed[0]}` : "",
		!failed.length && s.why && rest > 0 ? s.why : "",
	].filter(Boolean).join(". "));
	await inboxLoad();
	planRepaint();
}

$(".ib-head", inboxEl).addEventListener("click", (e) => {
	const t = e.target;
	if (t.closest("[data-pl-unfold]")) { planSet("opened", Date.now()); return planRepaint(); }
	if (t.closest("[data-pl-done]")) { planSet("done", Date.now()); return planRepaint(); }
	if (t.closest("[data-pl-start]")) return planStart();
	const ans = t.closest("[data-pl-answer]");
	if (ans) {
		const i = (ib.q?.items ?? []).find((x) => x.id === Number(ans.dataset.plAnswer));
		const p = ibPrimary(i);
		if (!p) return planOpenItem(Number(ans.dataset.plAnswer));
		ans.disabled = true;
		return (p.ack ? act.ack(i.id) : act.answer(i.id, p.answer)).then(() => toast(p.label)).catch((err) => { ans.disabled = false; toast(err.message); });
	}
	const open = t.closest("[data-pl-open]");
	if (open) planOpenItem(Number(open.dataset.plOpen));
});
// Runs load on their own (dispatch.js): Start next follows what they allow.
hooks.redraw.push(() => { if (planOpen()) planRepaint(); });
