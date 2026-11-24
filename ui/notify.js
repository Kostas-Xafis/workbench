/* ---------- Notifications ---------- */

// Off by default. Checked every 20 s even when the tab is in the background; shown only while it's not in front.
// The bell and the switch in Settings → Notifications are the same thing (wb.notify); what pops up, and when, is
// chosen there (prefs notify.*).
const notify = { on: localGet("notify") === "on", items: null, reports: null, trackers: null };
// In the Workbench desktop app (src-tauri/README.md, "Page ↔ app"): notifications go through the app's `notify`
// command, because WebKit there denies `Notification` without asking. A refused call turns appNotify off for good,
// and everything falls back to the web path below.
const app = window.isTauri === true && window.__TAURI__ ? window.__TAURI__ : null;
let appNotify = !!app?.core && !!app?.event;
if (appNotify) {
	app.event.listen("notification-clicked", (e) => openTarget(e.payload?.target)).catch(() => { appNotify = false; renderNotify(); renderSettings(); });
	app.event.listen("download-finished", (e) => {
		const d = e.payload || {};
		toast(d.success ? `Saved to Downloads: ${d.name}` : `Couldn't save ${d.name || "the download"}`);
	}).catch(() => {});
}
/* Zoom in the app (src-tauri/src/zoom.rs): WebKitGTK has no zoom keys there, so Ctrl + / Ctrl − / Ctrl 0 and Ctrl +
   scroll ask the app, which zooms the whole window and keeps the level for the next run. A browser does this itself. */
function zoomStep(e) {
	if (!(e.ctrlKey || e.metaKey) || e.altKey) return null;
	if (e.key === "+" || e.key === "=" || e.code === "NumpadAdd") return 1;
	if (e.key === "-" || e.key === "_" || e.code === "NumpadSubtract") return -1;
	if (e.key === "0" || e.code === "Numpad0" || e.code === "Digit0") return 0;
	return null;
}
// The app's zoom level as last seen (null until asked, or outside the app), shown in Settings → Appearance.
let zoomLevel = null;
function appZoom(step) {
	if (!app?.core || ![1, -1, 0].includes(step)) return;
	app.core.invoke("zoom", { step }).then((z) => {
		zoomLevel = z;
		toast(`${Math.round(z * 100)}%`);
		if (currentTab()?.key === "look") renderSettings();
	}).catch(() => {});
}
if (app?.core) {
	addEventListener("keydown", (e) => {
		const step = zoomStep(e);
		if (step === null) return;
		e.preventDefault();
		appZoom(step);
	}, true);
	// One step per notch of a mouse wheel; a touchpad's many small deltas add up to a step every 100 px.
	let wheel = 0, wheelAt = 0;
	addEventListener("wheel", (e) => {
		if (!e.ctrlKey) return;
		e.preventDefault();
		if (Date.now() - wheelAt > 400) wheel = 0;
		wheelAt = Date.now();
		wheel += e.deltaMode === 1 ? e.deltaY * 40 : e.deltaY;
		if (Math.abs(wheel) < 50) return;
		appZoom(wheel < 0 ? 1 : -1);
		wheel = 0;
	}, { passive: false, capture: true });
}

// Kinds of event, each a switch in Settings → Notifications, on by default: [key, label, hint].
const NOTIFY_KINDS = [
	["needs", "Something new needs you", "An item handed to you: a decision, a check, a review or a setup step"],
	["done", "An agent finished", "Work an agent marked done"],
	["stuck", "An agent got stuck", "An agent is waiting on something"],
	["resumed", "An agent can carry on", "Work that waited on an answer or another item is unblocked"],
	["reports", "Reports", "A new report, or a new version of one"],
	["trackers", "Status trackers", "One starts to warn, turns bad or stops reading"],
];
const notifyWants = (kind) => pref(`notify.${kind}`, true) !== false;
const notifyOn = () => notify.on && (appNotify || window.Notification?.permission === "granted");
// Quiet hours: from–to wraps past midnight when from is later than to; "All weekend too" adds Saturday and Sunday.
const minutesOf = (hhmm, def) => {
	const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm || "") || /^(\d{1,2}):(\d{2})$/.exec(def);
	return Number(m[1]) * 60 + Number(m[2]);
};
function quietAt(d = new Date()) {
	if (!pref("notify.quiet", false)) return false;
	if (pref("notify.quiet-weekend", false) && (d.getDay() === 0 || d.getDay() === 6)) return true;
	const from = minutesOf(pref("notify.quiet-from", "22:00"), "22:00"), to = minutesOf(pref("notify.quiet-to", "08:00"), "08:00");
	const now = d.getHours() * 60 + d.getMinutes();
	if (from === to) return false;
	return from < to ? now >= from && now < to : now >= from || now < to;
}
function renderNotify() {
	const b = $("#notify");
	b.hidden = !(appNotify || "Notification" in window);
	const on = notifyOn();
	b.setAttribute("aria-pressed", on);
	b.title = on ? `${pushActive() ? "Notifications on, even with the board closed" : "Desktop notifications on"}${quietAt() ? ", quiet hours now" : ""}. Settings → Notifications chooses which` : "Turn on notifications";
}
async function setNotifyOn(on) {
	if (on && !appNotify && Notification.permission !== "granted" && (await Notification.requestPermission()) !== "granted") {
		renderNotify();
		renderSettings();
		return toast(Notification.permission === "denied" ? "Notifications are blocked for this page in the browser settings" : "Notifications stay off: the browser wasn't allowed to show them");
	}
	notify.on = on;
	localSet("notify", on ? "on" : "off");
	notify.items = notify.reports = notify.trackers = null;
	// The cloud board sends them as push notifications instead (push.js); if that fails, the page pops them up itself.
	if (pushable() && on && !(await pushSubscribe())) {
		renderNotify();
		renderSettings();
		return toast("On, but only while the board is open: this device couldn't sign up for them with the board closed");
	}
	if (pushable() && !on) await pushUnsubscribe();
	renderNotify();
	renderSettings();
	toast(on ? "Notifications on" : "Notifications off");
}
$("#notify").onclick = () => setNotifyOn(!notifyOn());
// Desktops show a Notification right away; Chrome on Android only from an installed app, so it throws there.
function ping(title, body, tag, open, target) {
	if (appNotify) {
		app.core.invoke("notify", { title, body, tag, target: target ?? null }).catch((e) => { console.warn(e); appNotify = false; ping(title, body, tag, open); renderNotify(); renderSettings(); });
		return true;
	}
	try {
		const n = new Notification(title, { body, tag, icon: "/favicon.svg" });
		n.onclick = () => { window.focus(); open?.(); n.close(); };
		return true;
	} catch (e) {
		console.warn(e);
		return false;
	}
}
// What a notification opens, kept as data so events held through quiet hours can still open it later.
function openTarget(o) {
	if (o?.item) api(`/api/items/${o.item}`).then(openItem).catch((e) => toast(e.message));
	else if (o?.report) location.hash = `#report/${o.report}`;
	else if (o?.tracker) openTracker(o.tracker);
	else if (o?.today) location.hash = "#today";
}
// Events that happened during quiet hours, newest per item/report/tracker, until one summary when they end.
function heldGet() { try { return JSON.parse(localGet("notify.held") || "[]"); } catch { return []; } }
function heldSet(list) {
	if (list.length) localSet("notify.held", JSON.stringify(list.slice(-50)));
	else try { localStorage.removeItem("wb.notify.held"); } catch {}
}
function summarise(held) {
	if (!held.length) return;
	if (held.length === 1) return ping(held[0].title, held[0].body, held[0].tag, () => openTarget(held[0].open), held[0].open);
	const n = (k) => held.filter((h) => h.kind === k).length;
	const s = (c) => (c === 1 ? "" : "s");
	const parts = [
		n("needs") && (n("needs") === 1 ? "1 thing needs you" : `${n("needs")} things need you`),
		n("done") && (n("done") === 1 ? "1 finished by an agent" : `${n("done")} finished by agents`),
		n("stuck") && (n("stuck") === 1 ? "1 agent is waiting" : `${n("stuck")} agents are waiting`),
		n("resumed") && (n("resumed") === 1 ? "1 agent can carry on" : `${n("resumed")} agents can carry on`),
		n("reports") && `${n("reports")} report${s(n("reports"))} added or updated`,
		n("trackers") && `${n("trackers")} tracker${s(n("trackers"))} to look at`,
	].filter(Boolean);
	const first = held.find((h) => h.kind === "needs");
	ping("While you were away", parts.join(" · ") + (first ? `\n${first.body}` : ""), "wb-away", () => openTarget({ today: 1 }), { today: 1 });
}
async function notifyCheck() {
	// Push notifications come from the board itself (push.js): none from here as well.
	if (pushActive()) notify.items = notify.reports = notify.trackers = null;
	if (!notifyOn() || pushActive()) return;
	const [items, reports, trackers] = await Promise.all([api("/api/items"), api("/api/reports"), api("/api/trackers")]);
	const away = document.visibilityState !== "visible" || !document.hasFocus();
	const mine = (i) => i && needsYou(i);
	for (const [id, at] of localChanges) if (Date.now() - at > 60e3) localChanges.delete(id);
	const events = [];
	const ev = (kind, title, body, tag, open) => events.push({ kind, title, body, tag, open });
	if (notify.items && away) {
		for (const i of items) {
			const was = notify.items.get(i.id);
			if (localChanges.has(i.id) || (was && was.updated_at === i.updated_at)) continue;
			const where = projectName(i.project);
			if (mine(i) && !mine(was)) ev("needs", `Needs you · ${where}`, `${i.kind}: ${i.title}`, `wb-${i.ref}`, { item: i.id });
			else if (i.owner === "agent" && i.status === "done" && was && was.status !== "done") ev("done", `Done · ${where}`, i.title, `wb-${i.ref}`, { item: i.id });
			// Back to todo from waiting on another item: the answer or the finished work it waited for came in (links.ts).
			else if (i.owner === "agent" && i.status === "todo" && was && was.status === "waiting" && was.waiting_on > 0) ev("resumed", `Can carry on · ${where}`, i.title, `wb-${i.ref}`, { item: i.id });
			else if (i.owner === "agent" && i.status === "waiting" && was && was.status !== "waiting") ev("stuck", `Agent waiting · ${where}`, i.title, `wb-${i.ref}`, { item: i.id });
		}
		// Day pages are made by the board itself every 30 min, so they don't ping.
		// A tracker that starts to warn, turns bad, or stops reading.
		const RANK = { "": 0, ok: 1, warn: 2, bad: 3 };
		for (const t of trackers) {
			const was = notify.trackers?.get(t.id);
			if (!was) continue;
			const where = t.project ? projectName(t.project) : "every project";
			const worst = t.reading?.meters.filter((m) => m.level === t.level).map(meterPlain).join(" · ") ?? "";
			if (RANK[t.level] > RANK[was.level] && RANK[t.level] >= 2) ev("trackers", `${t.level === "bad" ? "Tracker bad" : "Tracker warning"} · ${where}`, `${t.title}: ${worst}`, `trk-${t.id}`, { tracker: t.id });
			else if (t.error && !was.error) ev("trackers", `Tracker failing · ${where}`, `${t.title}: ${t.error}`, `trk-${t.id}`, { tracker: t.id });
		}
		for (const r of reports.filter((r) => !r.name.startsWith("day-"))) {
			const was = notify.reports.get(r.id);
			if (was !== undefined && r.version > was) ev("reports", `Report updated · ${projectName(r.project)}`, `${r.title} (v${r.version})`, `report-${r.id}`, { report: r.id });
			else if (was === undefined) ev("reports", `New report · ${projectName(r.project)}`, r.title, `report-${r.id}`, { report: r.id });
		}
	}
	notifyEmit(events.filter((e) => notifyWants(e.kind)), away);
	notify.items = new Map(items.map((i) => [i.id, i]));
	notify.reports = new Map(reports.map((r) => [r.id, r.version]));
	notify.trackers = new Map(trackers.map((t) => [t.id, { level: t.level, error: t.error }]));
}
// During quiet hours nothing pops up: events wait, and the first check after they end sums them up in one
// notification (if the board still isn't in front; if it is, you're already looking at them).
function notifyEmit(events, away, now = new Date()) {
	if (quietAt(now)) {
		if (events.length) heldSet([...heldGet().filter((h) => !events.some((e) => e.tag === h.tag)), ...events]);
		return;
	}
	const held = heldGet();
	if (held.length) {
		heldSet([]);
		if (away) summarise(held.filter((h) => notifyWants(h.kind)));
	}
	for (const e of events) ping(e.title, e.body, e.tag, () => openTarget(e.open), e.open);
}
setInterval(() => { renderNotify(); notifyCheck().catch(() => {}); }, 20000);
