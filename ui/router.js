/* ---------- The router: one place that decides which view shows (docs/development.md, "The board's page") ---------- */

// Every screen is a view that registers here with defineView(); one hashchange listener (below) shows the view whose
// match() takes the address. #item/wb-xxxx is not a view: the reader opens over whatever shows (readerRoute,
// reader.js), and a page opened on it shows the default view under it.
//
// defineView({
//   name: "agents",                      unique; also what navCount() and a nav entry go by
//   el: "#agents-view",                  the view's element (or a selector): shown while it's current, hidden otherwise
//   match: (hash) => params | null,      hash with its "#" ("" for none); an object of params takes it, null passes
//   default: true,                       optional: shown for "" and for any address nobody takes (one view says so)
//   show(params, { from, fromHash }),    each time it's shown, also again with new params (from: the view before,
//                                        fromHash: its address)
//   hide(),                              optional: another view took over
//   title: (params) => "Agents",         the top bar's title, and the tab's ("Agents · Workbench"); a string works too
//   nav: (params) => "inbox" | "agents" | "project:<slug>" | "settings" | "vault" | null,   what the nav highlights
//   entry: { label: "Inbox", icon: "<path …/>", order: 10 },   optional: a row of its own at the top of the nav (and a
//                                        tab in the phone's bar); icon is 16×16 SVG path data, stroked
// })
// go(hash) goes to an address ("" for the default view), go(hash, { replace: true }) without a new history step.
// retitle() draws the title and the nav's highlight again, for a view whose title came in later (a report).
const VIEWS = [];
const router = { view: null, params: null, hash: null };

function defineView(v) {
	if (VIEWS.some((x) => x.name === v.name)) throw new Error(`defineView: "${v.name}" is already a view`);
	VIEWS.push(v);
	if (typeof renderNav === "function" && v.entry) renderNav();
	return v;
}
const viewEl = (v) => (typeof v.el === "string" ? $(v.el) : v.el);
const defaultView = () => VIEWS.find((v) => v.default) ?? VIEWS[0];
const viewOf = (name) => VIEWS.find((v) => v.name === name);
// What the nav highlights now ("project:isokratis", "settings", …), or null.
function currentNav() {
	const v = router.view;
	if (!v) return null;
	try { return (typeof v.nav === "function" ? v.nav(router.params) : v.nav) ?? null; } catch (e) { console.error(e); return null; }
}

function go(hash, { replace = false } = {}) {
	hash = !hash || hash === "#" ? "" : hash.startsWith("#") ? hash : `#${hash}`;
	if (location.hash === hash && !replace) return route();
	const url = location.pathname + location.search + hash;
	if (replace) { history.replaceState(null, "", url); return route(); }
	if (hash) location.hash = hash; // the hashchange below routes
	else { history.pushState(null, "", url); route(); }
}
// Back to where the board opens (the default view, the Inbox).
const goHome = () => go("");

function route() {
	const hash = location.hash === "#" ? "" : location.hash;
	// #item/wb-xxxx: the reader opens over whatever shows (ui/reader.js), the default view when nothing does yet.
	if (readerRoute()) {
		if (!router.view) showView(defaultView(), {});
		return;
	}
	let view = null, params = null;
	if (hash) for (const v of VIEWS) {
		let p = null;
		try { p = v.match?.(hash) ?? null; } catch (e) { console.error(e); }
		if (p) { view = v; params = p === true ? {} : p; break; }
	}
	if (!view) { view = defaultView(); params = view.match?.(hash) || {}; }
	showView(view, params);
}

function showView(view, params) {
	const from = router.view, fromHash = router.hash ?? "";
	if (from && from !== view) try { from.hide?.(); } catch (e) { console.error(e); }
	for (const v of VIEWS) { const el = viewEl(v); if (el) el.hidden = v !== view; }
	Object.assign(router, { view, params, hash: location.hash });
	retitle();
	try {
		const shown = view.show?.(params, { from: from?.name ?? null, fromHash });
		if (shown?.catch) shown.catch((e) => console.error(e));
	} catch (e) { console.error(e); }
	retitle();
}

function retitle() {
	const v = router.view;
	if (!v) return;
	let t = "";
	try { t = (typeof v.title === "function" ? v.title(router.params) : v.title) ?? ""; } catch (e) { console.error(e); }
	document.title = t ? `${t} · Workbench` : "Workbench";
	const nav = currentNav();
	const p = nav?.startsWith("project:") ? state.allProjects.find((x) => x.slug === nav.slice(8)) : null;
	paint($("#here"), `${p ? logo(p) : ""}<b>${esc(t || "Workbench")}</b>`);
	if (typeof renderNav === "function") renderNav();
}

window.addEventListener("hashchange", route);

/* Views whose own files predate the router: Settings (settings.js) and the setup guide (setup.js). */
defineView({
	name: "settings",
	el: "#settings-view",
	match: (h) => { const m = h.match(/^#settings(?:\/(.*))?$/); return m ? { tab: m[1] } : null; },
	show: (p) => openSettings(p.tab),
	title: "Settings",
	nav: "settings",
});
defineView({
	name: "welcome",
	el: "#welcome-view",
	match: (h) => { const m = h.match(/^#welcome(?:\/(.*))?$/); return m ? { step: m[1] } : null; },
	show: (p) => openWelcome(p.step),
	title: "Set up",
	nav: null,
});
