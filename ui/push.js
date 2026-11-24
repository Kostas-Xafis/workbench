/* ---------- Push notifications (the cloud board) ---------- */

// On the cloud board (worker/src/push.ts) notifications come as Web Push: the board sends them to each device that
// turned them on, so they arrive with the board closed, and the page stops popping up its own (notifyCheck). The
// switch, the kinds and quiet hours are Settings → Notifications' own (notify.*): they go to the board with the
// subscription, and again whenever they change. The desktop app keeps its own path (appNotify), and a board on a
// computer keeps polling. Where push can't work here (no service worker, a subscription refused), polling stays.
const push = { ok: false, busy: false, error: "", reg: null, install: null };

function pushable() {
	return CLOUD && !appNotify && window.isSecureContext && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}
// This device gets pushes: notifyCheck leaves the notifications to them.
function pushActive() {
	return push.ok && notify.on && Notification.permission === "granted";
}
function pushPrefs() {
	return {
		kinds: Object.fromEntries(NOTIFY_KINDS.map(([k]) => [k, notifyWants(k)])),
		quiet: pref("notify.quiet", false) === true,
		from: pref("notify.quiet-from", "22:00"),
		to: pref("notify.quiet-to", "08:00"),
		weekend: pref("notify.quiet-weekend", false) === true,
	};
}
async function pushReg() {
	push.reg ??= await navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" });
	return navigator.serviceWorker.ready;
}
const b64uBytes = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=")), (c) => c.charCodeAt(0));
const bytesB64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

// Subscribes this device (or refreshes its subscription and choices on the board). True when pushes will come.
async function pushSubscribe() {
	if (!pushable() || push.busy) return push.ok;
	push.busy = true;
	try {
		const reg = await pushReg();
		const { key } = await api("/api/push");
		let sub = await reg.pushManager.getSubscription();
		// One made with other keys (a board that started over) can't be used.
		const had = sub?.options?.applicationServerKey;
		if (sub && had && bytesB64u(had) !== key) { await sub.unsubscribe(); sub = null; }
		sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uBytes(key) });
		await api("/api/push/subscribe", {
			method: "POST",
			body: JSON.stringify({ subscription: sub.toJSON(), prefs: pushPrefs(), tz: Intl.DateTimeFormat().resolvedOptions().timeZone }),
		});
		push.ok = true;
		push.error = "";
	} catch (e) {
		console.warn(e);
		push.ok = false;
		push.error = e.message || String(e);
	} finally {
		push.busy = false;
	}
	renderNotify();
	renderSettings();
	return push.ok;
}
async function pushUnsubscribe() {
	push.ok = false;
	try { await api("/api/push/subscribe", { method: "DELETE", body: "{}" }); } catch {}
	try { await (await (await navigator.serviceWorker.getRegistration("/"))?.pushManager.getSubscription())?.unsubscribe(); } catch {}
}
// A real push to this device, through the push service, for Settings → Notifications' Send a test.
async function pushTest() {
	try {
		await api("/api/push/test", { method: "POST", body: "{}" });
		toast("Sent. It comes through this device's notifications in a moment");
	} catch (e) {
		toast(e.message);
	}
}

// The kinds or quiet hours changed: the board hears about it (once, for a preset that sets several).
let pushPrefsTimer = 0;
onSettingsChange((key) => {
	if (!pushActive() || (key !== undefined && !key.startsWith("notify."))) return;
	clearTimeout(pushPrefsTimer);
	pushPrefsTimer = setTimeout(pushSubscribe, 500);
});

// A notification tapped while a board window is open: the service worker hands its target over (ui/sw.js).
navigator.serviceWorker?.addEventListener("message", (e) => {
	if (e.data?.wb === "open") openTarget(e.data.target);
});

hooks.start.push(() => {
	// Opened from a notification with no board window: /?open=item:12 (ui/sw.js), once the board is loaded.
	const open = /^(item|tracker):(\d+)$/.exec(new URLSearchParams(location.search).get("open") ?? "");
	if (open) {
		history.replaceState(null, "", location.pathname + location.hash);
		openTarget({ [open[1]]: Number(open[2]) });
	}
	if (!pushable()) return;
	// The service worker is there from the first visit, so Chrome can offer to install the board as an app.
	pushReg().catch((e) => console.warn(e));
	// On, from before: refresh the subscription, which also moves it to this device if it was paired again.
	if (notify.on && Notification.permission === "granted") pushSubscribe();
});

// Chrome's own Install app, offered in Settings → Notifications too, where a phone turns notifications on.
addEventListener("beforeinstallprompt", (e) => {
	e.preventDefault();
	push.install = e;
	renderSettings();
});
addEventListener("appinstalled", () => {
	push.install = null;
	renderSettings();
	toast("Installed: Workbench is in your apps");
});
async function pushInstall() {
	const e = push.install;
	if (!e) return;
	push.install = null;
	await e.prompt();
	renderSettings();
}
/* ---------- end: Push notifications ---------- */
