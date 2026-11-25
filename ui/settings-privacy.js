/* ---------- Settings → Data → Vault, Sharing, Phones, Who can reach what, Data sources ---------- */
// What's exposed and how secrets behave: the vault's timers and password, share links (their lengths and every live
// one), who can reach the board, and every project's data sources. /api/settings/privacy never carries a secret.
const privacy = {
	info: null,
	shares: null,
	error: "",
	unsource: "",
	// Separate so it can be swapped for a stub while trying the list out (never start a real share for that).
	// Shares run a tunnel on the computer: the cloud board has none (CAN_SHARE is false there).
	fetchShares: () => (CAN_SHARE ? api("/api/shares") : Promise.resolve([])),
};
async function setPrivacyLoad() {
	const [info, shares] = await Promise.allSettled([api("/api/settings/privacy"), privacy.fetchShares(), phonesLoad()]);
	if (info.status === "fulfilled") privacy.info = info.value;
	if (shares.status === "fulfilled") privacy.shares = shares.value;
	const failed = [info, shares].find((r) => r.status === "rejected");
	privacy.error = failed ? failed.reason.message : "";
	renderSettings();
}
function setPrivacyPoll() { return setPrivacyLoad(); }

const pvMin = (n) => `${n} minute${n === 1 ? "" : "s"}`;
function pvLeft(ms) {
	const m = Math.ceil(ms / 60e3);
	if (m <= 1) return "under a minute left";
	return m < 60 ? `${m} min left` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ""} left`;
}
const pvFact = (status, mark, title, text) =>
	`<div class="pv-fact"><span class="sdot ${status}" aria-hidden="true"></span><div><b>${title}</b><small>${text}</small></div><span class="st ${status === "off" ? "" : status}">${mark}</span></div>`;

function pvVault(info) {
	const v = info?.vault;
	const status = !info
		? optRow({ label: "Vault", hint: "Loading…", control: "" })
		: v
			? optRow({
				label: `<span class="sdot ok" aria-hidden="true"></span>Set up`,
				hint: `${v.secrets} secret${v.secrets === 1 ? "" : "s"} · password last set ${esc(ago(v.changed_at))}`,
				control: `<button type="button" class="ghost sm" data-privacy="open-vault">Open vault</button><button type="button" class="ghost sm" data-privacy="rekey">Change password</button>`,
			})
			: optRow({
				label: `<span class="sdot off" aria-hidden="true"></span>Not set up`,
				hint: "Keep API keys and passwords here, encrypted with a password only you know.",
				control: `<button type="button" class="primary sm" data-privacy="open-vault">Set up the vault</button>`,
			});
	const lock = setting("vault.lock-minutes"), show = setting("vault.show-seconds");
	const rows = [
		status,
		optRow({
			label: "Lock after",
			hint: `Locks after ${pvMin(lock)} without a click or key press in the vault. Leaving the vault always locks it.`,
			bind: { setting: "vault.lock-minutes" },
			control: ctlNumber({ setting: "vault.lock-minutes" }, { min: 1, max: 60, unit: "idle minutes", label: "Lock the vault after this many idle minutes (1 to 60)" }),
		}),
		optRow({
			label: "Hide a shown value after",
			hint: `A value you show stays on screen ${show} seconds, then hides again.`,
			bind: { setting: "vault.show-seconds" },
			control: ctlNumber({ setting: "vault.show-seconds" }, { min: 5, max: 120, unit: "seconds", label: "Hide a shown value after this many seconds (5 to 120)" }),
		}),
	];
	if (v)
		rows.push(`<div class="so-wide pv-reset"><div class="so-label">Forgot the password?</div>
			<p class="caution">Nobody can recover the secrets: not the board, not this computer. This command deletes the vault and <b>every secret in it</b>, for good, so you can set it up again.</p>
			${cmdRow("wb vault reset --yes")}</div>`);
	return optFold("Vault", rows, { key: "set-data-vault", meta: v ? `${v.secrets} secret${v.secrets === 1 ? "" : "s"}` : info ? "Not set up" : "", note: "Encrypted in your browser with your password; the board keeps only the encrypted text." });
}

function pvShareRow(s) {
	const now = Date.now();
	const atCap = s.expiresAt >= s.maxAt;
	const head = `<div class="pv-share-head"><b>${esc(s.title)}</b><small>${esc(projectName(s.project))} · v${s.version}</small></div>`;
	if (s.status === "failed")
		return `<div class="so-wide pv-share" data-report="${s.report}"><span class="sdot bad" aria-hidden="true"></span><div class="pv-share-main">${head}
			<small class="pv-err">Failed: ${esc(s.error)}</small></div>
			<div class="pv-share-tools"><button type="button" class="ghost sm" data-privacy="stop" data-report="${s.report}">Clear</button></div></div>`;
	const link = s.url
		? `<a class="pv-url" href="${esc(s.url)}" target="_blank" rel="noreferrer" title="Open the link">${esc(s.url.replace(/^https:\/\//, ""))}</a>`
		: `<span class="pv-url muted">Starting…</span>`;
	return `<div class="so-wide pv-share" data-report="${s.report}"><span class="sdot ${s.status === "ready" ? "ok" : "warn"}" aria-hidden="true"></span>
		<div class="pv-share-main">${head}${link}
			<small>Ends at ${esc(clockOf(s.expiresAt))} · ${pvLeft(s.expiresAt - now)}${atCap ? " · at the limit" : ""}</small></div>
		<div class="pv-share-tools">
			${s.url ? `<button type="button" class="ghost sm" data-copy="${esc(s.url)}" aria-label="Copy the link to ${esc(s.title)}">Copy</button><a class="ghost sm" href="${esc(s.url)}" target="_blank" rel="noreferrer" aria-label="Open the link to ${esc(s.title)}">Open ↗</a>` : ""}
			<button type="button" class="ghost sm" data-privacy="extend" data-report="${s.report}"${atCap || s.status !== "ready" ? " disabled" : ""} title="${atCap ? esc(`A link runs at most ${hoursText(shareMax())}`) : `Until ${esc(clockOf(Math.min(s.expiresAt + 3600e3, s.maxAt)))}`}">Extend by 1 hour</button>
			<button type="button" class="ghost sm danger" data-privacy="stop" data-report="${s.report}">Stop</button></div></div>`;
}

function pvSharing() {
	const max = shareMax();
	const lengths = shareLengths().map((h) => [h, hoursText(h)]);
	const live = privacy.shares;
	const running = live ? live.filter((s) => s.status !== "failed").length : 0;
	const rows = [
		optRow({
			label: "Longest a link can run",
			hint: "Counting extensions. Lowering it doesn't cut a running link short; it just can't be extended past it.",
			bind: { setting: "share.max-hours" },
			control: ctlSelect({ setting: "share.max-hours" }, SHARE_LENGTHS.map((h) => [h, hoursText(h)]), { label: "Longest a share link can run" }),
		}),
		optRow({
			label: "New links start at",
			hint: "What the share dialog picks first; you can change it there before starting.",
			bind: { setting: "share.default-hours" },
			control: ctlSelect({ setting: "share.default-hours" }, lengths, { label: "Length a new share link starts at" }),
		}),
		optRow({
			label: `Live links${running ? ` <span class="pv-count">${running}</span>` : ""}`,
			hint: "Every report shared right now. Anyone with a link sees that one report, read-only.",
			control: live?.length ? `<button type="button" class="ghost sm danger" data-privacy="stop-all">Stop all</button>` : "",
		}),
		...(!live
			? [`<div class="so-wide set-empty">Loading…</div>`]
			: live.length
				? live.map(pvShareRow)
				: [`<div class="so-wide set-empty">Nothing is shared right now.</div>`]),
	];
	return optFold("Sharing", rows, { key: "set-data-sharing", meta: running ? `${running} live` : "", note: `A report's Share opens a temporary public link to a read-only copy, for up to ${hoursText(max)}.` });
}

function pvReach(info) {
	const live = (privacy.shares ?? []).filter((s) => s.status !== "failed").length;
	const facts = [
		!info
			? pvFact("off", "", "The board", "Loading…")
			: info.lan
				? pvFact("warn", "Paired phones", "The board: items, reports, links, trackers", `Listens on your network (<code>wb serve --lan</code>): phones paired under Phones above open and change it; anything else gets only the pairing page. Over plain http, so only on a network you trust.`)
				: pvFact("ok", "This computer", "The board: items, reports, links, trackers", `Listens on this computer only (localhost:${esc(info.port)}). <code>wb serve --lan</code> would open it to phones you pair.`),
		pvFact("ok", "This computer", "Vault", "Answers only this computer, and only with the password. Nothing in it is readable without the password, not even by the board."),
		pvFact("ok", "This computer", "Data sources", "Called only by the board's own page on this computer: not from the phone, other websites or share links."),
		pvFact("ok", "This computer", "Settings and starting shares", "Changing settings, projects and tracker commands, and starting or stopping a share, work only on this computer."),
		pvFact("ok", "Sandboxed", "Reports", "Each runs in a sandbox: it reads the board only through <code>wb</code>, can't reach the vault, and changes nothing on the board but its own saved state."),
		pvFact("ok", "Blocked", "Other websites", "Every change to the board must be sent as JSON, which a browser won't do from another site, so no other page can change the board."),
		live
			? pvFact("warn", `${live} public link${live === 1 ? "" : "s"}`, "Share links", "Each shows one report, read-only, to anyone with the link, until it ends. See Sharing above.")
			: pvFact("off", "None", "Share links", "Nothing is shared. A link shows one report, read-only, to anyone who has it, and nothing else."),
	];
	return optFold("Who can reach what", [`<div class="so-wide pv-facts">${facts.join("")}</div>`], { key: "set-data-reach", meta: info?.lan ? "On your network" : "This computer only" });
}

function pvSources(info) {
	if (!info) return optFold("Data sources", [`<div class="so-wide set-empty">Loading…</div>`], { key: "set-data-sources" });
	const list = info.sources, key = info.sourcesKey;
	const keyRow = key.cloud ? optRow({
		label: `<span class="sdot ok" aria-hidden="true"></span>Key`,
		hint: "Kept as a secret of the cloud board's Worker, outside its database. Sources a computer added are sealed again with it by wb sync sources.",
		control: `<span class="st ok">In the cloud</span>`,
	}) : optRow({
		label: `<span class="sdot ${key.exists ? "ok" : list.length ? "bad" : "off"}" aria-hidden="true"></span>Key file`,
		hint: `<code class="pv-path">${esc(key.path)}</code> ·${key.exists ? "Seals their headers. Anyone who can read your home folder can use the sources." : list.length ? "Missing: the sources below can't be opened. Add them again with wb source add." : "Made by the first wb source add."}`,
		control: `<span class="st ${key.exists ? "ok" : list.length ? "bad" : ""}">${key.exists ? "Present" : "Missing"}</span>`,
	});
	const row = (s) => {
		const id = `${s.project}/${s.name}`;
		const open = privacy.unsource === id;
		return `<div class="so-wide pv-src"><div class="pv-src-main">
			<div class="pv-src-head"><b>${esc(s.name)}</b><span class="pv-proj">${esc(projectName(s.project))}</span><span class="pv-mode ${s.write ? "rw" : ""}">${s.write ? "Read and write" : "Read-only"}</span></div>
			<code class="pv-base">${esc(s.base_url)}</code>
			<small>${s.header_names.length ? `Sends ${s.header_names.map((h) => `<code>${esc(h)}</code>`).join(", ")} (values hidden)` : "No headers"}</small></div>
			<button type="button" class="ghost sm" data-privacy="unsource" data-src="${esc(id)}" aria-expanded="${open}">Remove…</button>
			${open ? `<div class="pv-src-rm"><span class="muted">Remove it in a terminal (its sealed headers go with it; reports that call it get an error):</span>${cmdRow(`wb unsource ${s.name} --project ${s.project}`)}</div>` : ""}</div>`;
	};
	const rows = [
		keyRow,
		...(list.length
			? list.map(row)
			: [`<div class="so-wide set-empty">No data sources. A report can call an API that needs a secret through one, added with <code>wb source add</code> (<code>wb help</code> shows how).</div>`]),
	];
	return optFold("Data sources", rows, { key: "set-data-sources", meta: list.length ? String(list.length) : "", note: "APIs that reports call through the board, which adds the secret headers itself. A page never sees them." });
}

function setPrivacyRender() {
	const info = privacy.info;
	return `${privacy.error ? `<p class="error">${esc(privacy.error)}</p>` : ""}${pvVault(info)}${pvSharing()}${pvPhones()}${pvReach(info)}${pvSources(info)}`;
}

// The Data tab: the database and its copies (settings-data.js), then what's kept private and who can reach the board.
const setDataTabRender = () => setDataRender() + setPrivacyRender();
const setDataTabLoad = () => Promise.allSettled([setDataLoad(), setPrivacyLoad()]);
const setDataTabPoll = () => Promise.allSettled([setDataPoll(), setPrivacyLoad()]);

onSettingsChange(async (key) => {
	// The vault's hint shows the current times.
	if ((!key || key.startsWith("vault.")) && vault.key && !$("#vault-view").hidden) renderVault();
	// Lowering the most below where new links start moves the start down with it.
	if (key === "share.max-hours" && canChangeBoard() && setting("share.default-hours") > shareMax()) {
		try {
			state.settings = await api("/api/settings", { method: "PATCH", body: JSON.stringify({ "share.default-hours": shareMax() }) });
			toast(`Saved. New links now start at ${hoursText(shareMax())}`);
		} catch (e) { toast(e.message); }
		renderSettings();
	}
	// A refused value (out of range) puts the field back: the page is otherwise unchanged, so it wouldn't repaint.
	const el = key && settings.tab === "data" && $(`#settings-view input[data-setting="${CSS.escape(key)}"]`);
	if (el && String(el.value) !== String(setting(key))) $("#settings-view")._html = "";
});

$("#settings-view").addEventListener("click", async (e) => {
	const b = e.target.closest("[data-privacy]");
	if (!b) return;
	const act = b.dataset.privacy;
	const id = Number(b.dataset.report);
	const s = privacy.shares?.find((x) => x.report === id);
	if (act === "open-vault") return void (location.hash = "#vault");
	if (act === "rekey") {
		// Through the vault's own unlock: it asks the current password once, then the new one.
		vault.then = "rekey";
		return void (location.hash = "#vault");
	}
	if (act === "unsource") {
		privacy.unsource = privacy.unsource === b.dataset.src ? "" : b.dataset.src;
		return renderSettings();
	}
	try {
		if (act === "extend") {
			b.disabled = true;
			const r = await api(`/api/reports/${id}/share/extend`, { method: "POST" });
			toast(`Sharing until ${clockOf(r.expiresAt)}`);
		} else if (act === "stop") {
			if (s && s.status !== "failed" && !(await confirmIn(b, { text: `Stop sharing “${s.title}”? The link stops working at once, for everyone who has it.`, yes: "Stop sharing", danger: true }))) return;
			await api(`/api/reports/${id}/share`, { method: "DELETE" });
			if (s?.status !== "failed") toast("Stopped sharing");
		} else if (act === "stop-all") {
			const n = privacy.shares?.length ?? 0;
			if (!(await confirmIn(b, { text: `Stop all ${n} share link${n === 1 ? "" : "s"}? They stop working at once, for everyone who has them.`, yes: "Stop all", danger: true }))) return;
			await api("/api/shares/stop-all", { method: "POST" });
			toast("Stopped every share");
		} else return;
	} catch (err) { toast(err.message); }
	await setPrivacyLoad();
	if (state.report) refreshShares();
});
/* ---------- end: Data → Vault, Sharing, Phones, Who can reach what, Data sources ---------- */
