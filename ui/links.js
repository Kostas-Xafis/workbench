/* ---------- Waiting on another item (links.ts) ---------- */
// The reader lists what the item waits on and what waits on it, among its properties (a ref opens that item), and
// a card for you says how much work answering it frees. The data comes with every item: `waits_on` and `blocks`
// from GET /api/items/<id>, `unblocks` in the lists.

const linkState = (l) => (l.answer ? "answered" : l.status);
const linkList = (title, list) => !list.length ? "" : readerProp(title, `<ul class="rd-reflist">${list.map((l) =>
	`<li><button type="button" data-link-open="${l.id}" title="Open wb-${esc(l.ref)}: ${esc(l.title)}">${esc(l.title)}</button><small>wb-${esc(l.ref)} · <span class="lk-${linkState(l)}">${linkState(l)}${l.owner === "kostas" && linkState(l) !== "answered" ? " · for you" : ""}</span></small></li>`).join("")}</ul>`);

hooks.readerProps.push({
	order: 100,
	html: (i, r) => r.compose ? "" : linkList("Waits on", i.waits_on || []) + linkList("Blocks", i.blocks || []),
	wire(el, i, r) {
		el.addEventListener("click", (e) => {
			const b = e.target.closest("[data-link-open]");
			if (b) r.open(b.dataset.linkOpen);
		});
	},
});

// On a card: what answering or doing this item lets carry on.
hooks.cardMeta.push((i) => i.owner === "kostas" && i.unblocks > 0 && OPEN.includes(i.status)
	? `<span class="unblocks" title="${i.unblocks} waiting item${i.unblocks > 1 ? "s" : ""} carry on once this is dealt with">${glyph("pause")}unblocks ${i.unblocks}</span>` : "");
/* ---------- end: waiting on another item ---------- */
