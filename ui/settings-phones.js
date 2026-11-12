/* ---------- Settings → Privacy and security → Phones ---------- */
// Phones paired with the board for `--lan` (devices.ts): "Pair a phone" opens a one-time code with its QR code, and
// the list of paired phones has Remove and Remove all. /api/devices answers this computer only.
const phones = { info: null, error: "", busy: false, timer: 0, count: -1 };

async function phonesLoad() {
	if (!CAN_SHARE) return;
	try {
		const info = await api("/api/devices");
		// A phone that paired while the code was showing.
		const before = phones.info?.devices ?? [];
		const added = phones.info?.pairing && info.devices.find((d) => !before.some((b) => b.id === d.id));
		if (added) toast(`Paired: ${added.name}`);
		phones.info = info;
		phones.error = "";
	} catch (e) { phones.error = e.message; }
	phonesWatch();
}
// While a code is open, look every 2 s, so a phone that just paired shows at once.
function phonesWatch() {
	clearTimeout(phones.timer);
	if (!phones.info?.pairing) return;
	phones.timer = setTimeout(async () => {
		if (settings.tab !== "privacy" || $("#settings-view").hidden) return;
		await phonesLoad();
		renderSettings();
	}, 2000);
}

const phLeft = (ms) => { const m = Math.max(0, Math.ceil(ms / 60e3)); return m <= 1 ? "under a minute left" : `${m} min left`; };

function pvPhones() {
	const info = phones.info;
	if (!info) return optGroup("Phones", [`<div class="so-wide set-empty">${phones.error ? esc(phones.error) : "Loading…"}</div>`]);
	const rows = [];
	const p = info.pairing;
	if (!info.lan)
		rows.push(optRow({
			label: `<span class="sdot off" aria-hidden="true"></span>Phone access is off`,
			hint: app
				? "The board answers this computer only. Turn on <b>Phone access (on my network)</b> in the app's tray menu, then pair a phone here."
				: "The board answers this computer only. Start it with <code>wb serve --lan</code> (Settings → Health says how for the service), then pair a phone here.",
			control: `<button type="button" class="primary sm" disabled>Pair a phone</button>`,
		}));
	else if (p)
		rows.push(`<div class="so-wide ph-pair">
			${p.qr ? `<div class="set-qr ph-qr" title="Scan with the phone's camera">${p.qr}</div>` : ""}
			<div class="ph-pair-main">
				<b>Scan this with the phone's camera</b>
				<small>Or open <code>${esc((p.urls[0] ?? "").replace(/\/pair\?.*$/, ""))}</code> on the phone and type the code:</small>
				<div class="ph-code" aria-label="Pairing code">${esc(p.code)}</div>
				<small>For one phone, ${esc(phLeft(p.expires - Date.now()))} (until ${esc(clockOf(p.expires))}).</small>
				${p.urls.length > 1 ? `<small>Other addresses of this computer: ${p.urls.slice(1).map((u) => `<code>${esc(u.replace(/\/pair\?.*$/, ""))}</code>`).join(", ")}</small>` : ""}
				<small class="ph-plain">Phones reach the board over plain http, without encryption: pair only on a network you trust.</small>
				<div class="row"><button type="button" class="ghost sm" data-phones="new">New code</button><button type="button" class="ghost sm" data-phones="cancel">Cancel</button></div>
			</div></div>`);
	else
		rows.push(optRow({
			label: "Pair a phone",
			hint: "Shows a QR code and a code that work once, for 10 minutes. The phone then stays paired until you remove it.",
			control: `<button type="button" class="primary sm" data-phones="pair"${phones.busy ? " disabled" : ""}>Pair a phone</button>`,
		}));
	const list = info.devices;
	rows.push(optRow({
		label: `Paired phones${list.length ? ` <span class="pv-count">${list.length}</span>` : ""}`,
		hint: "Each one can open and change the board until you remove it. Removing one stops it at once.",
		control: list.length > 1 ? `<button type="button" class="ghost sm danger" data-phones="remove-all">Remove all</button>` : "",
	}));
	if (!list.length) rows.push(`<div class="so-wide set-empty">No phones paired yet.</div>`);
	for (const d of list)
		rows.push(`<div class="so-wide ph-dev"><div class="ph-dev-main"><b>${esc(d.name)}</b>
			<small>Paired ${esc(ago(d.paired_at))} · last seen ${d.last_seen_at ? esc(ago(d.last_seen_at)) : "never"}${d.last_ip ? ` from ${esc(d.last_ip)}` : ""}</small></div>
			<button type="button" class="ghost sm danger" data-phones="remove" data-id="${esc(d.id)}" aria-label="Remove ${esc(d.name)}">Remove</button></div>`);
	return optGroup("Phones", rows, "Under <code>--lan</code>, only phones paired here get in. Anything else on the network gets the pairing page and nothing more.");
}

$("#settings-view").addEventListener("click", async (e) => {
	const b = e.target.closest("[data-phones]");
	if (!b) return;
	const act = b.dataset.phones;
	try {
		if (act === "pair" || act === "new") {
			// From Health's Phone card too: over to this tab with the code showing.
			if (settings.tab !== "privacy") location.hash = "#settings/privacy";
			phones.busy = true;
			phones.info = await api("/api/devices/pairing", { method: "POST" });
		} else if (act === "cancel") {
			phones.info = await api("/api/devices/pairing", { method: "DELETE" });
		} else if (act === "remove") {
			const d = phones.info?.devices.find((x) => x.id === b.dataset.id);
			if (!confirm(`Remove “${d?.name ?? "this phone"}”? It stops reaching the board at once, and has to pair again to come back.`)) return;
			phones.info = await api(`/api/devices/${encodeURIComponent(b.dataset.id)}`, { method: "DELETE" });
			toast("Removed");
		} else if (act === "remove-all") {
			const n = phones.info?.devices.length ?? 0;
			if (!confirm(`Remove all ${n} phones? They stop reaching the board at once, and each has to pair again.`)) return;
			phones.info = await api("/api/devices", { method: "DELETE" });
			toast("Removed every phone");
		} else return;
	} catch (err) { toast(err.message); }
	phones.busy = false;
	phonesWatch();
	renderSettings();
});
/* ---------- end: Phones ---------- */
