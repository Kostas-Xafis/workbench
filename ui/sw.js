/* The cloud board's service worker (worker/src/push.ts, docs/cloud.md): it shows the board's push notifications and
   opens what one is about when it's tapped. It has no fetch handler and caches nothing, so the board's pages and API
   always come from the network and an update shows at once. Served at /sw.js by the cloud board only. */

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

const boardWindows = () => self.clients.matchAll({ type: "window", includeUncontrolled: true });

self.addEventListener("push", (e) => {
	let d = {};
	try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data?.text() ?? "" }; }
	e.waitUntil((async () => {
		// The board in front shows what changed itself, as notifications on the page never pop up then either.
		// A test always shows.
		const front = (await boardWindows()).some((c) => c.focused && c.visibilityState === "visible");
		if (front && !d.always) return;
		await self.registration.showNotification(d.title || "Workbench", {
			body: d.body || "",
			tag: d.tag || undefined,
			renotify: !!d.tag,
			icon: "/icons/icon-192.png",
			badge: "/icons/badge-96.png",
			data: { target: d.target ?? null },
		});
	})());
});

// Where a target opens when no board window is open (ui/push.js reads ?open=).
function targetUrl(t) {
	if (t?.report) return `/#report/${t.report}`;
	if (t?.inbox || t?.today) return "/#inbox";
	if (t?.item) return `/?open=item:${t.item}`;
	if (t?.tracker) return `/?open=tracker:${t.tracker}`;
	return "/";
}

self.addEventListener("notificationclick", (e) => {
	e.notification.close();
	const target = e.notification.data?.target ?? null;
	e.waitUntil((async () => {
		const wins = await boardWindows();
		const win = wins.find((c) => c.visibilityState === "visible") ?? wins[0];
		if (win) {
			await win.focus().catch(() => {});
			win.postMessage({ wb: "open", target });
			return;
		}
		await self.clients.openWindow(targetUrl(target));
	})());
});
