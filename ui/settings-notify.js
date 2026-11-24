/* ---------- Settings → Notifications (tab "notify") ---------- */
// The switch is the bell's (setNotifyOn); the rest are prefs notifyCheck reads each time (notify.*).
const NOTIFY_ONLY_NEEDS = ["needs", "stuck"];
const browserScope = `<span class="scope browser" title="${SCOPE.browser[1]}">${SCOPE.browser[0]}</span>`;
function notifyState() {
	if (appNotify) return notify.on ? ["ok", `On. The app sends them through your system's notifications.${quietAt() ? " Quiet hours now." : ""}`] : ["off", "Off. Turning them on sends them through your system's notifications, which you can silence there."];
	if (!("Notification" in window)) return window.isSecureContext
		? ["bad", "This browser doesn't offer desktop notifications."]
		: ["off", `Notifications need the board at localhost or over https. Opened over plain http, as from a phone on your network (${esc(location.host)}), the browser doesn't offer them.`];
	const p = Notification.permission;
	if (p === "denied") {
		// Installed as an app (push.js), there's no address bar: Android keeps the setting with the app.
		if (matchMedia("(display-mode: standalone)").matches && /Android/.test(navigator.userAgent))
			return ["bad", "Blocked for this app. To allow them, long-press Workbench's icon, tap App info → Notifications and turn them on, then open the app again."];
		return ["bad", "Blocked for this page in the browser. To allow them, click the icon at the left of the address bar, set Notifications to Allow, then reload this page."];
	}
	if (p === "default") return ["off", "The browser hasn't been asked yet: turning them on asks it."];
	// The cloud board's push notifications (push.js).
	if (pushActive()) return ["ok", `On. The board sends them to this device, even with the board closed.${quietAt() ? " Quiet hours now." : ""}`];
	if (notify.on && pushable() && push.busy) return ["ok", "On. Signing this device up with the board…"];
	if (notify.on && pushable() && push.error) return ["warn", `On, but only while the board is open: this device couldn't sign up for them with the board closed (${esc(push.error)}). Turning them off and on again tries once more.`];
	return notify.on ? ["ok", `On, and allowed in this browser.${quietAt() ? " Quiet hours now." : ""}`] : ["off", "Allowed in this browser, and off."];
}
const fmtClock = (hhmm) => {
	const m = minutesOf(hhmm, "00:00");
	return new Date(2000, 0, 1, Math.floor(m / 60), m % 60).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
};
function quietSummary() {
	if (!pref("notify.quiet", false)) return "Off: things pop up at any hour.";
	const from = pref("notify.quiet-from", "22:00"), to = pref("notify.quiet-to", "08:00");
	const wk = pref("notify.quiet-weekend", false);
	const span = minutesOf(from, "22:00") === minutesOf(to, "08:00") ? (wk ? "All weekend" : "Start and end are the same, so never") : `${fmtClock(from)} to ${fmtClock(to)}${minutesOf(from, "22:00") > minutesOf(to, "08:00") ? " the next morning" : ""}${wk ? ", and all weekend" : ""}`;
	return `${span}. ${quietAt() ? "Quiet now." : "Not quiet now."}`;
}
function setNotifyRender() {
	const supported = "Notification" in window;
	const [dot, status] = notifyState();
	const on = notifyOn();
	const blocked = !appNotify && (!supported || Notification.permission === "denied");
	const master = optRow({
		label: `${pushable() ? "Notifications" : "Desktop notifications"}${browserScope}`,
		hint: `<span class="nt-status"><span class="sdot ${dot}"></span><span>${status}</span></span>`,
		control: `<label class="switch"><input type="checkbox" role="switch" data-notify-on${on ? " checked" : ""}${blocked ? " disabled" : ""} aria-label="Desktop notifications"><span></span></label>`,
	});
	const wants = Object.fromEntries(NOTIFY_KINDS.map(([k]) => [k, notifyWants(k)]));
	const isAll = NOTIFY_KINDS.every(([k]) => wants[k]);
	const isNeeds = NOTIFY_KINDS.every(([k]) => wants[k] === NOTIFY_ONLY_NEEDS.includes(k));
	const presets = optRow({
		label: "Quick pick",
		hint: "Only what needs me: new things for you, and agents that got stuck.",
		control: `<div class="radios nt-presets" role="group" aria-label="Quick pick">
			<button type="button" data-notify="all" aria-pressed="${isAll}">Everything</button>
			<button type="button" data-notify="needs" aria-pressed="${isNeeds}">Only what needs me</button></div>`,
	});
	const kinds = NOTIFY_KINDS.map(([k, label, hint]) => optRow({ label, hint, bind: { pref: `notify.${k}`, def: true }, control: ctlToggle({ pref: `notify.${k}`, def: true }, { label }), off: !on }));
	const quiet = pref("notify.quiet", false);
	const quietRows = [
		optRow({ label: "Keep quiet at set hours", hint: quietSummary(), bind: { pref: "notify.quiet", def: false }, control: ctlToggle({ pref: "notify.quiet", def: false }, { label: "Keep quiet at set hours" }) }),
		optRow({ label: "From", bind: { pref: "notify.quiet-from", def: "22:00" }, control: ctlTime({ pref: "notify.quiet-from", def: "22:00" }, { label: "Quiet hours from" }), off: !quiet }),
		optRow({ label: "Until", hint: "When it's earlier than the start, it's the next morning.", bind: { pref: "notify.quiet-to", def: "08:00" }, control: ctlTime({ pref: "notify.quiet-to", def: "08:00" }, { label: "Quiet hours until" }), off: !quiet }),
		optRow({ label: "All weekend too", hint: "Saturday and Sunday, all day.", bind: { pref: "notify.quiet-weekend", def: false }, control: ctlToggle({ pref: "notify.quiet-weekend", def: false }, { label: "All weekend too" }), off: !quiet }),
	];
	const test = optRow({
		label: "Send a test notification",
		hint: !on ? "Turn notifications on first." : "Shows one now, even with the board in front.",
		control: `<button type="button" class="ghost sm" data-notify="test"${on ? "" : " disabled"}>Send a test</button>`,
	});
	// Chrome offers to install the board as an app (push.js): with its own icon, and its notifications as an app's.
	const install = push.install ? optRow({
		label: "Install as an app",
		hint: "On your home screen and in your apps, in its own window.",
		control: `<button type="button" class="ghost sm" data-notify="install">Install</button>`,
	}) : "";
	return `<p class="set-intro">${app ? "This app has its own setting, apart from your browsers." : "Each browser has its own: turn them on wherever you want them."}</p>
		${optGroup("Notifications", [master, test, install].filter(Boolean))}
		${optGroup("What to tell you about", [presets, ...kinds], on ? "" : "Saved now, used once notifications are on.")}
		${optGroup("Quiet hours", quietRows, "When they end, one notification sums up what happened meanwhile.")}`;
}
let notifyPermWatch = false;
async function setNotifyLoad() {
	if (notifyPermWatch || !navigator.permissions || !("Notification" in window)) return;
	notifyPermWatch = true;
	// Allowing or blocking in the browser's own settings shows here without a reload.
	try { (await navigator.permissions.query({ name: "notifications" })).onchange = () => { renderNotify(); renderSettings(); }; } catch {}
}
async function setNotifyPoll() { renderNotify(); renderSettings(); }
$("#settings-view").addEventListener("change", (e) => {
	const t = e.target.closest("[data-notify-on]");
	if (t) setNotifyOn(t.checked);
});
$("#settings-view").addEventListener("click", (e) => {
	const b = e.target.closest("[data-notify]");
	if (!b) return;
	const what = b.dataset.notify;
	if (what === "install") return void pushInstall();
	if (what === "test") {
		if (!notifyOn()) return toast("Turn notifications on first");
		if (pushActive()) return void pushTest();
		if (!ping("Workbench", "Notifications work. They look like this, and clicking one opens what it's about.", "wb-test", null))
			toast("This browser shows notifications only from installed apps");
		return;
	}
	// Everything = every kind back to its default (on); only-needs turns the others off.
	for (const [k] of NOTIFY_KINDS) setPrefQuiet(`notify.${k}`, what === "all" || NOTIFY_ONLY_NEEDS.includes(k) ? null : false);
	runSettingsHooks("notify.kinds");
	renderSettings();
	toast(what === "all" ? "You'll hear about everything" : "Only what needs you");
});
// Like setPref, without re-rendering for each key of a preset.
function setPrefQuiet(key, value) {
	if (value === null) { try { localStorage.removeItem(`wb.pref.${key}`); } catch {} }
	else localSet(`pref.${key}`, JSON.stringify(value));
}
onSettingsChange((key) => { if (key === undefined || key.startsWith("notify.")) renderNotify(); });
/* ---------- end: Notifications ---------- */
