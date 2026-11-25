/* ---------- Settings → About: the look (theme, zoom, shortcuts) ---------- */
// All this browser's (look.theme, look.keys). Both are also set by the inline script in <head>, before the first paint.
const MAC = /Mac|iPhone|iPad/.test(navigator.userAgentData?.platform || navigator.platform || navigator.userAgent);
const MOD = MAC ? "⌘" : "Ctrl";
const osDark = matchMedia("(prefers-color-scheme: dark)");
const lookTheme = () => { const t = pref("look.theme", "system"); return t === "light" || t === "dark" ? t : "system"; };
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
	root.classList.toggle("no-keys", pref("look.keys", false) !== true);
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
	[[["Esc"]], "Close a dialog, or the item you're reading"],
	[[["J"], ["K"]], "In an item: the next or previous one in the list you opened it from"],
	[[["1"], ["9"]], "In an item: answer with that choice (tick it, when several can be picked)"],
	[[["E"]], "In an item: edit its details (" + MOD + " Enter saves)"],
	[[["Enter"]], "In an item's reply box: answer, object or add the note (Shift Enter for a new line)"],
	[[["M"], ["X"], ["D"], ["G"]], "In an item: done, drop, later, give back"],
	[[[MOD, "Enter"]], "In a tracker: record the reading"],
	...(app ? [[[[MOD, "+"], [MOD, "−"]], "Zoom in or out (or hold " + MOD + " and scroll)"], [[[MOD, "0"]], "Back to 100%"]] : []),
	...hooks.shortcuts,
];
const kbdKeys = (alts) => alts.map((combo) => combo.map((k) => `<kbd>${esc(k)}</kbd>`).join(`<span class="lk-plus">+</span>`)).join(`<span class="lk-or">or</span>`);
function setLookRender() {
	const theme = optRow({
		label: "Theme",
		hint: `System follows your ${narrow() ? "phone" : "computer"}'s setting (${osDark.matches ? "dark" : "light"} now). Reports follow it too.`,
		bind: { pref: "look.theme", def: "system" },
		control: ctlRadios({ pref: "look.theme", def: "system" }, [["light", "Light"], ["dark", "Dark"], ["system", "System"]], { label: "Theme" }),
	});
	// Zoom is the app's own (a browser has its own zoom), kept in the app's settings rather than this page's.
	const pct = zoomLevel === null ? "…" : `${Math.round(zoomLevel * 100)}%`;
	const zoom = app?.core ? optRow({
		label: `Zoom<span class="scope browser" title="Kept by this app, for its window">This app</span>${zoomLevel !== null && Math.abs(zoomLevel - 1) > 1e-3 ? `<button type="button" class="reset-btn" data-zoom="0" title="Back to 100%">Default</button>` : ""}`,
		hint: `Also ${MOD} + and ${MOD} − (or ${MOD} and scroll), and ${MOD} 0 for 100%.`,
		control: `<div class="zoom-ctl" role="group" aria-label="Zoom">
			<button type="button" class="icon-btn" data-zoom="-1" title="Smaller" aria-label="Zoom out"${zoomLevel !== null && zoomLevel <= 0.5 ? " disabled" : ""}>${svg16('<path d="M4 8h8"/>')}</button>
			<output class="zoom-pct" aria-live="polite">${pct}</output>
			<button type="button" class="icon-btn" data-zoom="1" title="Bigger" aria-label="Zoom in"${zoomLevel !== null && zoomLevel >= 2 ? " disabled" : ""}>${svg16('<path d="M4 8h8M8 4v8"/>')}</button></div>`,
	}) : "";
	// The keys beside buttons and in hint lines (base.css hides them under html.no-keys). A phone never shows them.
	const hints = narrow() ? "" : optRow({
		label: "Show key hints",
		hint: "The keys on buttons and in hint lines, like Done M in an item. Off, the shortcuts still work; the list below has them all.",
		bind: { pref: "look.keys", def: false },
		control: ctlToggle({ pref: "look.keys", def: false }, { label: "Show key hints" }),
	});
	const keys = `<div class="so-wide"><dl class="lk-keys">${SHORTCUTS().map(([k, what]) => `<dt>${kbdKeys(k)}</dt><dd>${esc(what)}</dd>`).join("")}</dl></div>`;
	return optGroup("Look", [theme, hints, zoom].filter(Boolean)) + (narrow() ? "" : optFold("Keyboard shortcuts", [keys], { key: "set-about-keys" }));
}
async function setLookLoad() {
	if (app?.core) zoomLevel = await app.core.invoke("zoom_level").catch(() => zoomLevel);
}
async function setLookPoll() {}
$("#settings-view").addEventListener("click", (e) => {
	const z = e.target.closest("[data-zoom]");
	if (z) appZoom(Number(z.dataset.zoom));
});
onSettingsChange((key) => {
	if (key === undefined || key.startsWith("look.")) applyLook();
});
// Another tab of this browser changed a setting: follow it here.
addEventListener("storage", (e) => {
	if (e.key === "wb.notify") { notify.on = e.newValue === "on"; notify.items = notify.reports = notify.trackers = null; renderNotify(); }
	if (!e.key?.startsWith("wb.pref.") && e.key !== "wb.notify") return;
	applyLook();
	redraw();
	renderNotify();
	renderSettings();
});
osDark.addEventListener("change", () => renderSettings());
$(".search-wrap kbd").textContent = `${MOD} K`;
applyLook();
/* ---------- end: the look ---------- */
