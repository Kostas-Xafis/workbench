/* ---------- Waiting on another item (links.ts) ---------- */
// The item dialog lists what the item waits on and what waits on it, and a card for you says how much work answering
// it frees. The data comes with every item: `waits_on` and `blocks` from GET /api/items/<id>, `unblocks` in the lists.
const linksBox = document.createElement("div");
linksBox.className = "links-box";
linksBox.id = "links-box";
linksBox.hidden = true;
$("#code-box").before(linksBox);

const linkState = (l) => (l.answer ? "answered" : l.status);
const linkList = (title, hint, list) => !list.length ? "" : `<h3>${title}</h3><p class="hint">${hint}</p><ul>${list.map((l) =>
	`<li><button type="button" class="ref" data-link-open="${l.id}" title="Open wb-${esc(l.ref)}">wb-${esc(l.ref)}</button><span class="lk-title">${esc(l.title)}</span><small class="lk-st lk-${linkState(l)}">${linkState(l)}${l.owner === "kostas" && linkState(l) !== "answered" ? " · for you" : ""}</small></li>`).join("")}</ul>`;

function fillLinks(item, isNew) {
	const waits = isNew ? [] : item.waits_on || [], blocks = isNew ? [] : item.blocks || [];
	linksBox.hidden = !waits.length && !blocks.length;
	linksBox.innerHTML = linkList("Waits on", "It carries on by itself once these are answered or finished.", waits) +
		linkList("Blocks", `Waiting for this${item.owner === "kostas" ? ": answering or finishing it lets them carry on" : ""}.`, blocks);
}
hooks.itemOpen.push(fillLinks);
hooks.itemLoaded.push((item) => fillLinks(item, false));
linksBox.addEventListener("click", (e) => {
	const b = e.target.closest("[data-link-open]");
	if (b) openItemById(b.dataset.linkOpen).catch((err) => toast(err.message));
});

// On a card: what answering or doing this item lets carry on.
hooks.cardMeta.push((i) => i.owner === "kostas" && i.unblocks > 0 && OPEN.includes(i.status)
	? `<span class="unblocks" title="${i.unblocks} waiting item${i.unblocks > 1 ? "s" : ""} carry on once this is dealt with">${glyph("pause")}unblocks ${i.unblocks}</span>` : "");
/* ---------- end: waiting on another item ---------- */
