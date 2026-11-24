/* ---------- Hooks: where a feature in its own file plugs into the board ---------- */

// A feature lives in ui/<feature>.js (and .css), loaded in index.html's features block: after every core file, before
// boot.js starts the board. While its file loads it adds functions to these lists; they all start empty, so the
// page is the same without them. A function that throws is logged and skipped, and the board carries on.
const hooks = {
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
	// (item) → nothing: an item was answered or settled from this page (any `act` call, answer.js), after the board
	// reloaded; `item` is as the server gave it back. For a view that moves on to the next one (the Inbox).
	settled: [],
	// () → nothing: what the board loaded changed (items, reports, links, trackers, goals, rulings, runs): a view that
	// draws from `state` draws again (the Projects page). redraw() runs them; every loader calls it when its answer
	// changed, and so do the dialogs that save.
	redraw: [],
	// () → nothing: every 10 s with the board's own reloads (not while the tab is hidden, or a form dialog is open;
	// the reader doesn't stop it).
	refresh: [],
	// () → nothing: once, when the board has loaded and shown the first view.
	start: [],
	// (data, q) → HTML: more groups in the search results (Ctrl K), after Links; `data` is GET /api/search's answer.
	// Each result is an <a class="res" href="#…"> or a <button class="res"> with your own click handler.
	searchResults: [],
	// [keys, what] entries added to the shortcut list in Settings → About → Look (see SHORTCUTS); the listener is yours.
	shortcuts: [],
};
// A view of its own (a screen at its own address, like the vault): defineView() in router.js. Add its element from
// your file, e.g. $("#content").append(el).
// A tab in Settings, shaped like those in SET_TABS (settings.js), after the tab with key `after` (else last).
// Its icon is TAB_IC[key], 16×16 path data.
function addSettingsTab(tab, after) {
	const i = SET_TABS.findIndex((t) => t.key === after);
	SET_TABS.splice(i < 0 ? SET_TABS.length : i + 1, 0, tab);
}
const hookHtml = (list, ...args) => list.map((fn) => { try { return fn(...args) ?? ""; } catch (e) { console.error(e); return ""; } }).join("");
const hookRun = (list, ...args) => { for (const fn of list) try { fn(...args); } catch (e) { console.error(e); } };
const redraw = () => hookRun(hooks.redraw);
