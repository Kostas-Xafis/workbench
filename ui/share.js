/* ---------- Sharing a report (Cloudflare quick tunnel, see share.ts) ---------- */

// Only from this computer: the server refuses anyone else, so the button isn't offered there.
const CAN_SHARE = !CLOUD && ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);
// Who may change the board (settings, projects, the vault): the page on this computer, or any device paired with the cloud board.
const OWNER = CAN_SHARE || CLOUD;
const shareDlg = $("#share-dlg");
let shares = [];
let shareCheck = null;
let sharePoll = 0;
let shareHours = 1;
// The lengths share.ts allows (SHARE_HOURS in settings.ts). Settings → Privacy and security picks the most a link
// runs (counting extensions) and the one the dialog starts on; read when used, like the server does.
const SHARE_LENGTHS = [1, 2, 4, 8, 12, 24];
const shareMax = () => setting("share.max-hours") ?? 8;
const shareLengths = () => SHARE_LENGTHS.filter((h) => h <= shareMax());
const shareStartHours = () => Math.min(setting("share.default-hours") ?? 1, shareMax());
const hoursText = (h) => `${h} hour${h === 1 ? "" : "s"}`;
const shareOf = (id) => shares.find((s) => s.report === id);

async function refreshShares() {
	$("#r-share").hidden = !CAN_SHARE || !state.report;
	if (!CAN_SHARE) return;
	try { shares = await api("/api/shares"); } catch { shares = []; }
	const live = state.report && shareOf(state.report.id);
	const on = !!live && live.status !== "failed";
	$("#r-share").setAttribute("aria-pressed", on);
	$("#r-share").textContent = on ? (live.status === "ready" ? "Sharing" : "Starting…") : "Share";
	if (shareDlg.open) renderShare();
}

async function openShare() {
	if (!state.report) return;
	$("#share-err").textContent = "";
	shareCheck = null;
	shareHours = shareStartHours();
	renderShare();
	shareDlg.showModal();
	await refreshShares();
	if (!shareOf(state.report.id) || shareOf(state.report.id).status === "failed") {
		try { shareCheck = await api("/api/share/check"); } catch (err) { $("#share-err").textContent = err.message; }
	}
	renderShare();
}

function renderShare() {
	const r = state.report;
	if (!r) return;
	const s = shareOf(r.id);
	const viewing = Number(frame.dataset.version) || r.version;
	const project = esc(projectName(r.project));
	const body = $("#share-body"), actions = $("#share-actions");
	clearTimeout(sharePoll);
	if (s && s.status !== "failed") {
		const atCap = s.expiresAt >= s.maxAt;
		if (s.status === "starting") {
			body.innerHTML = `<p>Opening a Cloudflare quick tunnel for v${s.version}… This takes a few seconds.</p>`;
		} else {
			// The QR code is SVG the server drew from the link (qr.ts), black on white so phones read it in dark mode too.
			body.innerHTML = `<div class="share-live">${s.qr ? `<div class="share-qr" title="Scan to open the link">${s.qr}</div>` : ""}<div>
				<div class="share-cmd"><input class="share-url" readonly value="${esc(s.url)}" aria-label="Link"></div>
				<div class="row"><button type="button" class="ghost sm" data-act="copy-url">Copy link</button><a class="ghost sm" href="${esc(s.url)}" target="_blank" rel="noreferrer">Open ↗</a></div>
				<p class="hint">${s.reachable ? "The link answers." : "Checking that the link answers (a new address can take a few seconds to work)…"}</p>
				<p>Sharing v${s.version}${s.version !== viewing ? ` (you're looking at v${viewing})` : ""} until <b>${when(s.expiresAt)}</b>.</p>
				<p class="hint">${atCap ? `That's the limit: a link runs at most ${hoursText(shareMax())}.` : `It can be extended up to ${when(s.maxAt)}.`}</p>
			</div></div>`;
		}
		actions.innerHTML = `${s.status === "ready" && !atCap ? `<button type="button" class="ghost" data-act="extend">Extend by 1 hour</button>` : ""}<button type="button" class="primary" data-act="stop">Stop sharing</button>`;
		if (s.status === "starting" || !s.reachable) sharePoll = setTimeout(refreshShares, 1500);
		return;
	}
	if (!shareCheck) {
		body.innerHTML = `<p>Checking that cloudflared is ready…</p>`;
		actions.innerHTML = "";
		return;
	}
	if (!shareCheck.ok) {
		body.innerHTML = `<div class="caution">${shareCheck.problems.map(esc).join("<br>")}</div>
			${shareCheck.install.length ? `<p>Install it with one of these, in a terminal, then check again:</p>
			${shareCheck.install.filter((g) => g.here).map(installGuide).join("")}
			<details class="share-others"><summary>Other systems</summary>${shareCheck.install.filter((g) => !g.here).map(installGuide).join("")}
				<p class="hint">Or download it from <a href="https://github.com/cloudflare/cloudflared/releases/latest" target="_blank" rel="noreferrer">cloudflared's releases</a>.</p></details>
			<p class="hint">cloudflared is Cloudflare's tunnel client, free, and quick tunnels need no Cloudflare account. If it's installed somewhere unusual, put it on the board's PATH.</p>` : ""}`;
		actions.innerHTML = `<button type="button" class="primary" data-act="recheck">Check again</button>`;
		return;
	}
	if (!shareLengths().includes(shareHours)) shareHours = shareStartHours();
	body.innerHTML = `${s?.status === "failed" ? `<div class="caution">The last attempt failed: ${esc(s.error)}</div>` : ""}
		<p>Opens a temporary public link (a random <code>trycloudflare.com</code> address) to a read-only copy of this report. Anyone with the link can see:</p>
		<ul><li>v${viewing} of this report</li><li>the ${project} items, notes and git state the report reads</li></ul>
		<p>Nothing they do changes the board. The board itself, other projects, bookmarks and the vault stay off the link.
		It ends at the time you pick (you can extend it while it runs, up to ${hoursText(shareMax())} in all) or when you stop it. Restarting the board or closing the laptop doesn't end it early, and it never outlives its time: a link that runs out while the computer sleeps closes as soon as it wakes.</p>
		<label class="share-hours">Keep it up for <select id="share-hours">${shareLengths().map((h) => `<option value="${h}"${h === shareHours ? " selected" : ""}>${hoursText(h)}</option>`).join("")}</select></label>
		<p class="hint">cloudflared ${esc(shareCheck.version)}</p>`;
	$("#share-hours").onchange = (e) => { shareHours = Number(e.target.value); };
	actions.innerHTML = `<button type="button" class="primary" data-act="start">Start sharing</button>`;
}

function installGuide(g) {
	return `<div class="share-guide"><b>${esc(g.system)}</b>${g.options.map((o) => `<small>${esc(o.how)}</small>
		<div class="share-cmd"><code>${esc(o.cmd)}</code><button type="button" class="ghost sm" data-copy="${esc(o.cmd)}">Copy</button></div>`).join("")}</div>`;
}

shareDlg.addEventListener("click", async (e) => {
	const act = e.target.closest("[data-act]")?.dataset.act;
	if (!act || !state.report) return;
	const id = state.report.id;
	$("#share-err").textContent = "";
	try {
		if (act === "recheck") { shareCheck = null; renderShare(); shareCheck = await api("/api/share/check"); }
		else if (act === "start") {
			e.target.disabled = true;
			await api(`/api/reports/${id}/share`, { method: "POST", body: JSON.stringify({ version: Number(frame.dataset.version) || null, hours: shareHours }) });
		} else if (act === "extend") {
			const s = await api(`/api/reports/${id}/share/extend`, { method: "POST" });
			toast(`Sharing until ${when(s.expiresAt)}`);
		} else if (act === "stop") {
			await api(`/api/reports/${id}/share`, { method: "DELETE" });
			shareCheck = await api("/api/share/check");
		} else if (act === "copy-url") {
			const s = shareOf(id);
			if (s?.url && (await copyText(s.url))) toast("Link copied");
			return;
		}
	} catch (err) { $("#share-err").textContent = err.message; }
	await refreshShares();
	renderShare();
});
$("#r-share").onclick = openShare;
$("#share-close").onclick = () => shareDlg.close();
shareDlg.addEventListener("close", () => clearTimeout(sharePoll));

function refreshReport() {
	if (state.report) frame.contentWindow?.postMessage({ wb: 1, event: "refresh" }, "*");
}
