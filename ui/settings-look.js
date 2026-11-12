/* ---------- Settings → Appearance (tab "look") ---------- */
// All this browser's (look.*). The theme is also set by the inline script in <head>, before the first paint.
const MAC = /Mac|iPhone|iPad/.test(navigator.userAgentData?.platform || navigator.platform || navigator.userAgent);
const MOD = MAC ? "⌘" : "Ctrl";
const osDark = matchMedia("(prefers-color-scheme: dark)");
const lookTheme = () => { const t = pref("look.theme", "system"); return t === "light" || t === "dark" ? t : "system"; };
// startWho() is in core.js: `state` needs it while it's built.
// SECTIONS in this browser's order; kinds missing from a saved order (a new kind) keep their place at the end.
function sectionOrder() {
	const saved = pref("look.sections", null);
	if (!Array.isArray(saved)) return SECTIONS;
	const by = new Map(SECTIONS.map((s) => [s[0], s]));
	return [...saved.filter((k) => by.has(k)).map((k) => by.get(k)), ...SECTIONS.filter((s) => !saved.includes(s[0]))];
}
// A report in the frame gets the theme on its address (so its first paint is right) and by message when it changes.
function withFrameTheme(src) {
	const u = new URL(src, location.href), t = lookTheme();
	if (t === "system") u.searchParams.delete("wbtheme"); else u.searchParams.set("wbtheme", t);
	// In the app, the report passes its zoom keys up to the board (a browser zooms frames by itself).
	if (app) u.searchParams.set("wbapp", "1");
	return u.pathname + u.search;
}
function applyLook() {
	const t = lookTheme(), root = document.documentElement;
	if (t === "system") delete root.dataset.theme; else root.dataset.theme = t;
	document.body.classList.toggle("compact", pref("look.density", "comfortable") === "compact");
	if (frame.dataset.src) {
		frame.dataset.src = withFrameTheme(frame.dataset.src);
		frame.contentWindow?.postMessage({ wb: 1, event: "theme", theme: t === "system" ? "" : t }, "*");
	}
}
// The board's real shortcuts (see the keydown listeners), as [keys, what]; keys are joined with "+".
const SHORTCUTS = () => [
	[[[MOD, "K"]], "Search, from anywhere"],
	[[["/"]], "Search, when you're not typing"],
	[[["↑"], ["↓"]], "Move through search results"],
	[[["Enter"]], "Open the search result you're on"],
	[[["Esc"]], "Close the search results, then clear the search"],
	[[["Esc"]], "Close a dialog"],
	[[["Enter"]], "In an item: send your own answer, or add the note"],
	[[[MOD, "Enter"]], "In a tracker: record the reading"],
	...(app ? [[[[MOD, "+"], [MOD, "−"]], "Zoom in or out (or hold " + MOD + " and scroll)"], [[[MOD, "0"]], "Back to 100%"]] : []),
];
const kbdKeys = (alts) => alts.map((combo) => combo.map((k) => `<kbd>${esc(k)}</kbd>`).join(`<span class="lk-plus">+</span>`)).join(`<span class="lk-or">or</span>`);
function lookSectionRows() {
	const list = sectionOrder();
	return list.map(([kind, label], i) => `<div class="so lk-sec" data-kind="${kind}">
		<div class="ord">
			<button type="button" class="icon-btn" data-look="up" title="Move up" aria-label="Move ${esc(label)} up"${i ? "" : " disabled"}>${svg16('<path d="m4.5 10 3.5-3.5 3.5 3.5"/>')}</button>
			<button type="button" class="icon-btn" data-look="down" title="Move down" aria-label="Move ${esc(label)} down"${i < list.length - 1 ? "" : " disabled"}>${svg16('<path d="m4.5 6 3.5 3.5 3.5-3.5"/>')}</button></div>
		${kindIcon(kind)}<span class="lk-name">${esc(label)}</span></div>`).join("");
}
function setLookRender() {
	const theme = optRow({
		label: "Theme",
		hint: `System follows your ${narrow() ? "phone" : "computer"}'s setting (${osDark.matches ? "dark" : "light"} now). Reports opened on the board follow the theme too.`,
		bind: { pref: "look.theme", def: "system" },
		control: ctlRadios({ pref: "look.theme", def: "system" }, [["light", "Light"], ["dark", "Dark"], ["system", "System"]], { label: "Theme" }),
	});
	const density = optRow({
		label: "Density",
		hint: "Compact fits more on screen: tighter cards, section headers and side lists.",
		bind: { pref: "look.density", def: "comfortable" },
		control: ctlRadios({ pref: "look.density", def: "comfortable" }, [["comfortable", "Comfortable"], ["compact", "Compact"]], { label: "Density" }),
	});
	const start = optRow({
		label: "The board opens on",
		hint: "Where I left it keeps the last of Everything, Needs you and With agents you picked.",
		bind: { pref: "look.start", def: "last" },
		control: ctlSelect({ pref: "look.start", def: "last" }, [["last", "Where I left it"], ["all", "Everything"], ["kostas", "Needs you"], ["agent", "With agents"]], { label: "The board opens on" }),
	});
	const order = optRow({
		label: "Order of the sections",
		hint: "Done lately and repositories stay at the end. Each section remembers by itself whether it's folded.",
		bind: { pref: "look.sections", def: null },
		control: "",
	});
	// Zoom is the app's own (a browser has its own zoom), kept in the app's settings rather than this page's.
	const pct = zoomLevel === null ? "…" : `${Math.round(zoomLevel * 100)}%`;
	const zoom = app?.core ? optRow({
		label: `Zoom<span class="scope browser" title="Kept by this app, for its window">This app</span>${zoomLevel !== null && Math.abs(zoomLevel - 1) > 1e-3 ? `<button type="button" class="reset-btn" data-zoom="0" title="Back to 100%">Default</button>` : ""}`,
		hint: `How big everything is in the window. Also ${MOD} + and ${MOD} − (or ${MOD} and scroll), and ${MOD} 0 for 100%.`,
		control: `<div class="zoom-ctl" role="group" aria-label="Zoom">
			<button type="button" class="icon-btn" data-zoom="-1" title="Smaller" aria-label="Zoom out"${zoomLevel !== null && zoomLevel <= 0.5 ? " disabled" : ""}>${svg16('<path d="M4 8h8"/>')}</button>
			<output class="zoom-pct" aria-live="polite">${pct}</output>
			<button type="button" class="icon-btn" data-zoom="1" title="Bigger" aria-label="Zoom in"${zoomLevel !== null && zoomLevel >= 2 ? " disabled" : ""}>${svg16('<path d="M4 8h8M8 4v8"/>')}</button></div>`,
	}) : "";
	const keys = `<div class="so-wide"><dl class="lk-keys">${SHORTCUTS().map(([k, what]) => `<dt>${kbdKeys(k)}</dt><dd>${esc(what)}</dd>`).join("")}</dl></div>`;
	return `<p class="set-intro">How the board looks in ${app ? "this app" : "this browser"}. Your phone and your computer can each have their own.</p>
		${optGroup("Look", [theme, density, zoom].filter(Boolean))}
		${optGroup("Board", [start, order, lookSectionRows()])}
		${optGroup("Keyboard shortcuts", [keys], narrow() ? "With a keyboard attached." : "")}`;
}
async function setLookLoad() {
	if (app?.core) zoomLevel = await app.core.invoke("zoom_level").catch(() => zoomLevel);
}
async function setLookPoll() {}
function moveSection(kind, dir) {
	const order = sectionOrder().map((s) => s[0]);
	const i = order.indexOf(kind), j = i + (dir === "up" ? -1 : 1);
	if (i < 0 || j < 0 || j >= order.length) return;
	[order[i], order[j]] = [order[j], order[i]];
	setPref("look.sections", order.join() === SECTIONS.map((s) => s[0]).join() ? null : order);
	// Keep the keyboard on the row that moved, on the other arrow once it reaches an end.
	const row = $(`#settings-view .lk-sec[data-kind="${CSS.escape(kind)}"]`);
	const btn = row?.querySelector(`[data-look="${dir}"]`);
	(btn && !btn.disabled ? btn : row?.querySelector(`[data-look="${dir === "up" ? "down" : "up"}"]`))?.focus();
}
$("#settings-view").addEventListener("click", (e) => {
	const b = e.target.closest("[data-look]");
	if (b) moveSection(b.closest("[data-kind]")?.dataset.kind, b.dataset.look);
	const z = e.target.closest("[data-zoom]");
	if (z) appZoom(Number(z.dataset.zoom));
});
onSettingsChange((key) => {
	if (key === undefined || key.startsWith("look.")) applyLook();
	if (key === "look.sections") renderBoard();
	// Picking a starting filter shows it now, too.
	if (key === "look.start") { state.who = startWho(); renderBoard(); }
});
// Another tab of this browser changed a setting: follow it here.
addEventListener("storage", (e) => {
	if (e.key === "wb.notify") { notify.on = e.newValue === "on"; notify.items = notify.reports = notify.trackers = null; renderNotify(); }
	if (!e.key?.startsWith("wb.pref.") && e.key !== "wb.notify") return;
	applyLook();
	renderBoard();
	renderNotify();
	renderSettings();
});
osDark.addEventListener("change", () => renderSettings());
$(".search-wrap kbd").textContent = `${MOD} K`;
applyLook();
/* ---------- end: Appearance ---------- */
