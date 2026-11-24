/* ---------- Waiting on another item (links.ts) ---------- */
// The reader lists what the item waits on and what waits on it, among its properties (a ref opens that item); a row
// says how much work answering it frees ("unblocks N", kit.js). The data comes with every item: `waits_on` and `blocks`
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

/* ---------- end: waiting on another item ---------- */
