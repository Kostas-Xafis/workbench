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
	// (item) → HTML: a button under an open card's title that starts something (never an answer: those are in the
	// reader). Wrap it in an element with class card-act: the board then leaves its clicks to you.
	cardActions: [],
	// The reader (ui/reader.js), an item shown as a document. A feature adds its own sections, each an object
	// { html(item, r) → HTML ("" for none), wire?(el, item, r) }: `el` is the section's own element, made afresh
	// whenever its HTML changes, so wire its listeners on it. `r` is the reader: r.item, r.compose (a new item being
	// written; r.draft holds its fields), r.set(patch) saves fields (or changes the draft), r.render() draws again,
	// r.reload() asks the server again, r.take(item) shows an item the server gave back, r.error(text), r.open(id).
	// `item` may be one from the board's list, still loading (item.loading): no notes, pictures or links yet.
	// In the document: { slot: "lead" (under the title), "action" (where it's answered), …section }.
	readerDoc: [],
	// In the properties column: { order (status 10, who acts 20, kind 30, priority 40, project 50, area 60, branch
	// 70, session 80, code 110), …section }. Use readerProp(label, valueHtml) for a label above its value.
	readerProps: [],
	// () → nothing: the reader sheet closed (to reload a view that shows what it may have changed).
	readerClosed: [],
	// (collapsed) → HTML: in the sidebar, under the trackers (the folded rail when `collapsed`).
	rail: [],
	// () → nothing: every 10 s with the board's own reloads (not while the tab is hidden, or a form dialog is open;
	// the reader doesn't stop it).
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
