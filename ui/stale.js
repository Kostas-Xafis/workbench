/* ---------- Stale work: a badge on a card, a count in a kind's header (rule and thresholds: stale.ts) ---------- */

const staleDays = (s) => Math.max(0, Math.floor((Date.now() - parseTime(s.since)) / 86400e3));
const STALE_TIP = {
	stalled: "In progress with no sign of life for a day: no note, and no call to the board about it",
	waiting: "Waiting for a week or more",
};

hooks.cardMeta.push((i) =>
	i.stale ? `<span class="stale" title="${STALE_TIP[i.stale.why]} (since ${esc(i.stale.since)})">${i.stale.why} ${staleDays(i.stale)} d</span>` : "");

hooks.sectionMeta.push((kind, items) => {
	const n = items.filter((i) => i.stale).length;
	return n ? `<span class="sub stale" title="Agent work that stalled, or has waited a week or more">${n} stale</span>` : "";
});
