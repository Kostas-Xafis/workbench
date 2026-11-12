/* ---------- Hooks: where a feature in its own file plugs into the board ---------- */

// A feature lives in ui/<feature>.js (and .css), loaded in index.html's features block: after every core file, before
// boot.js starts the board. While its file loads it adds functions to these lists; they all start empty, so the
// board is the same without them. A function that throws is logged and skipped, and the board carries on.
const hooks = {
	// (shown) → HTML: sections above the kinds' sections on the board; `shown` is the open items the filter shows.
	boardTop: [],
	// (shown) → HTML: sections after the kinds' sections, before "Done lately".
	boardEnd: [],
	// (item) → boolean: false keeps an item off the board's sections (and its counts); for a filter such as a goal.
	boardFilter: [],
	// (openCount) → HTML: what the board shows instead of its empty card when `openCount` (what the filter lets
	// through) is 0 and you have something to say about it; "" lets the usual empty card show.
	boardEmpty: [],
	// (item) → HTML: more on a card's meta line, after the code count.
	cardMeta: [],
	// (kind, items) → HTML: more in a kind section's header, after its counts; `items` are the open ones it lists.
	sectionMeta: [],
	// (item) → HTML: buttons under an open card's title, in place of a decision's answer buttons when any returns
	// some. Wrap them in an element with class card-act: the board then leaves their clicks to you.
	cardActions: [],
	// (item, isNew) → nothing: the item dialog is filled and about to open; show or fill your own part of it.
	itemOpen: [],
	// (patch) → nothing: Save is about to send `patch` (an item's fields); add your own part of the form to it.
	itemSave: [],
	// (collapsed) → HTML: in the sidebar, under the trackers (the folded rail when `collapsed`).
	rail: [],
	// () → nothing: every 10 s with the board's own reloads (not while a dialog is open or the tab is hidden).
	refresh: [],
	// () → nothing: once, when the board has loaded and shown the first view.
	start: [],
	// (data, q) → HTML: more groups in the search results (Ctrl K), after Links; `data` is GET /api/search's answer.
	// Each result is an <a class="res" href="#…"> or a <button class="res"> with your own click handler.
	searchResults: [],
	// [keys, what] entries added to the shortcut list in Settings → Appearance (see SHORTCUTS); the listener is yours.
	shortcuts: [],
};
// Views of their own, like the vault: { name, el: "#x-view", match: (hash) => boolean, title, open(hash) }. route()
// shows the first whose match() is true (after reports, before the built-in views); showView() hides it otherwise.
// Add its element from your file, e.g. $("#content").append(el).
const views = [];
// A tab in Settings, shaped like those in SET_TABS (settings.js), after the tab with key `after` (else last).
// Its icon is TAB_IC[key], 16×16 path data.
function addSettingsTab(tab, after) {
	const i = SET_TABS.findIndex((t) => t.key === after);
	SET_TABS.splice(i < 0 ? SET_TABS.length : i + 1, 0, tab);
}
const hookHtml = (list, ...args) => list.map((fn) => { try { return fn(...args) ?? ""; } catch (e) { console.error(e); return ""; } }).join("");
// Every hook answers true (or nothing): false from any of them is a no.
const hookPass = (list, ...args) => list.every((fn) => { try { return fn(...args) !== false; } catch (e) { console.error(e); return true; } });
const hookRun = (list, ...args) => { for (const fn of list) try { fn(...args); } catch (e) { console.error(e); } };
