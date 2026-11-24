/* ---------- Updates ---------- */
// Moving between releases. In the app (src-tauri/src/update.rs) the app checks its own feed and installs only when
// asked: the page shows its state (`update_state`, and the `update-state` event on every change) and asks it
// (`update_install`, `update_later`, `update_skip`, `update_auto`, `update_seen`); the tray's "Update to …" line
// sends `update-open`. In a plain browser (or an app without those commands) the server checks the same feed once a
// day when the board setting `updates.check` allows (updates.ts, /api/update), and the page says how to update.
// In the app, a board server started outside it (the systemd service, from source) that runs another version than
// the app says so in the board bar too, with what to do.
const upd = { app: null, srv: null, info: null, view: "offer", err: "", checking: false, srvJust: null, noteClosed: false };
const updDlg = $("#upd-dlg");
const appCall = (cmd, args) => app.core.invoke(cmd, args);
// -1, 0 or 1 for x.y.z versions; a pre-release (0.2.0-rc.1) comes before its release (as in updates.ts).
function verCmp(a, b) {
	const parse = (v) => { const [core, pre = ""] = String(v).replace(/^v/, "").split("-", 2); return { n: core.split(".").map((x) => Number(x) || 0), pre }; };
	const x = parse(a), y = parse(b);
	for (let i = 0; i < 3; i++) if ((x.n[i] ?? 0) !== (y.n[i] ?? 0)) return Math.sign((x.n[i] ?? 0) - (y.n[i] ?? 0));
	return x.pre === y.pre ? 0 : !x.pre ? 1 : !y.pre ? -1 : x.pre < y.pre ? -1 : 1;
}
const updFromApp = () => !!upd.app?.enabled;
function updLaterLocal() {
	try { const l = JSON.parse(localGet("update.later") || "null"); return l && l.until > Date.now() ? l.version : null; } catch { return null; }
}
async function updLoad() {
	const [srv, st, info] = await Promise.allSettled([
		api("/api/update"),
		app ? appCall("update_state") : Promise.resolve(null),
		app && !upd.info ? appCall("app_info") : Promise.resolve(upd.info),
	]);
	if (srv.status === "fulfilled") upd.srv = srv.value;
	if (st.status === "fulfilled" && st.value) upd.app = st.value;
	if (info.status === "fulfilled" && info.value) upd.info = info.value;
	// In a browser: the board itself moved to a newer version since this browser last saw it (once).
	const s = upd.srv;
	if (s && !upd.app) {
		const seen = localGet("update.seen");
		if (!seen) localSet("update.seen", s.version);
		else if (verCmp(s.version, seen) > 0 && !upd.srvJust) {
			const same = s.latest?.version === s.version;
			upd.srvJust = { from: seen, to: s.version, notes: same ? s.latest.notes : "", page: same ? s.latest.page : null };
		}
	}
	renderUpd();
}
// What's on offer, from the app's own check or the server's: null when there's nothing newer.
function updOffer() {
	if (updFromApp()) {
		const a = upd.app.available;
		if (!a) return null;
		return { ...a, current: upd.app.version, from: "app", skipped: upd.app.skipped === a.version, later: upd.app.later === a.version };
	}
	const s = upd.srv;
	if (!s?.latest || !s.newer) return null;
	const v = s.latest.version;
	return { version: v, notes: s.latest.notes, date: s.latest.date ? Date.parse(s.latest.date) : null, page: s.latest.page, install: "manual", deb: null,
		current: s.version, from: "server", skipped: s.skipped === v, later: updLaterLocal() === v };
}
// In the app, attached to a board server of another version: { server, app, older } (older = the server is).
function updMismatch() {
	if (!upd.info || upd.info.server !== "attached" || !upd.srv) return null;
	const c = verCmp(upd.srv.version, upd.info.version);
	return c ? { server: upd.srv.version, app: upd.info.version, older: c < 0 } : null;
}
const updBusyText = (b) => ({ download: "Downloading", install: "Installing", restart: "Restarting" })[b] ?? "Updating";
function renderUpd() {
	const pill = $("#upd-pill");
	const o = updOffer(), m = updMismatch(), busy = upd.app?.busy;
	let html = "", title = "", view = "offer", quiet = false;
	if (busy) {
		const pct = busy === "download" && upd.app.total ? Math.min(100, Math.round((upd.app.done / upd.app.total) * 100)) : null;
		html = `${updBusyText(busy)} ${esc(o?.version ?? "")}${pct != null ? ` <span class="pct">${pct}%</span>` : "…"}`;
		title = "Show the update";
	} else if (o && !o.skipped && !o.later) {
		html = `Update available: ${esc(o.version)}`;
		title = "See what's new, and update";
	} else if (m && localGet("update.mismatch") !== `${m.server}|${m.app}`) {
		html = m.older ? "Board server is older than the app" : "App is older than the board server";
		title = `App ${m.app}, board server ${m.server}: what to do`;
		view = "server";
		quiet = true;
	}
	pill.hidden = !html;
	if (pill._html !== html) { pill._html = html; pill.innerHTML = html; }
	pill.title = title;
	pill.dataset.view = view;
	pill.classList.toggle("quiet", quiet);
	if (updDlg.open) renderUpdDlg();
	renderUpdNote();
	if (!$("#settings-view").hidden && settings.tab === "updates") renderSettings();
}
function openUpd(view) {
	upd.view = view ?? (updOffer() || upd.app?.busy ? "offer" : updMismatch() ? "server" : "offer");
	upd.err = "";
	renderUpdDlg();
	if (!updDlg.open) updDlg.showModal();
}
function updProgress() {
	const a = upd.app;
	if (!a?.busy) return "";
	const pct = a.busy === "download" && a.total ? Math.min(100, Math.round((a.done / a.total) * 100)) : null;
	const label = a.busy === "download" ? `Downloading… ${a.total ? `${fmtBytes(a.done)} of ${fmtBytes(a.total)}` : fmtBytes(Math.max(a.done, 1))}`
		: a.busy === "install" ? (a.kind === "deb" ? "Installing… the system asks for your password in its own window." : "Installing…")
		: "Restarting the app…";
	return `<div class="upd-bar${pct == null ? " wait" : ""}" role="progressbar" aria-label="${esc(label)}"${pct != null ? ` aria-valuenow="${pct}"` : ""}><i style="width:${pct ?? 30}%"></i></div><small class="upd-sub">${esc(label)}</small>`;
}
// How to get the new version from here, when Update now can't do it.
function updHowServer() {
	const s = upd.srv;
	if (!s) return "";
	if (s.how === "source")
		return `<p>This board runs from source${s.folder ? ` in <code>${esc(s.folder)}</code>` : ""}. Pull the new version, then restart it:</p>
			${cmdRow(`git -C ${s.folder ? shellArg(s.folder) : "."} pull`)}${s.service ? cmdRow("systemctl --user restart workbench") : `<p>Then stop the board and start it again (<code>wb serve</code>).</p>`}`;
	if (s.how === "binary")
		return `<p>Download the new <b>workbench-server</b> from the release page, put it in place of <code>${esc(s.exe || "this one")}</code>, and start it again.</p>`;
	return "<p>This board runs inside the Workbench app: open the app, and it offers the update itself.</p>";
}
const shellArg = (p) => (/^[\w@%+=:,./-]+$/.test(p) ? p : `'${p.replace(/'/g, `'\\''`)}'`);
function updHow(o) {
	const a = upd.app, port = upd.info?.port;
	const attached = upd.info?.server === "attached"
		? `<p class="upd-sub">The board server on port ${port} runs outside the app and keeps running: it's updated on its own (Settings → Updates).</p>` : "";
	if (o.from === "app" && o.install === "app") {
		const what = a.kind === "deb"
			? "Update now downloads it, asks for your password to install the package, and restarts the app"
			: "Update now downloads it, replaces this AppImage, and restarts the app";
		return `<p>${what}${upd.info?.server === "owned" ? " and its board" : ""}.</p>${attached}`;
	}
	if (o.from === "app" && a.kind === "deb") {
		const file = (o.deb || "").split("/").pop() || `Workbench_${o.version}_amd64.deb`;
		return `<p>${a.error ? "Install it from a terminal instead" : "This app was installed from a .deb package and can't install this release by itself. Download it, then install it from a terminal"}:</p>
			${cmdRow(`sudo apt install ~/Downloads/${file}`)}<p class="upd-sub">Then quit Workbench from its tray menu and open it again.</p>${attached}`;
	}
	if (o.from === "app")
		return `<p>This copy of the app was built from source, so it can't update itself. Pull and build it again:</p>${cmdRow("git pull && bun run app:build")}${attached}`;
	if (app) return `<p>Download the new app from the release page${o.page ? "" : " on GitHub"}, and open it in place of this one.</p>`;
	return updHowServer();
}
function renderUpdDlg() {
	const body = $("#upd-body"), actions = $("#upd-actions");
	const o = updOffer(), m = updMismatch(), busy = upd.app?.busy;
	let b = "", act = "";
	if (upd.view === "server" && m) {
		b = `<div class="upd-head"><b id="upd-title">${m.older ? "The board server is older than the app" : "The app is older than the board server"}</b>
			<small>App ${esc(m.app)} · board server ${esc(m.server)} on port ${esc(upd.info.port)}, started outside the app</small></div>
			<div class="upd-how">${m.older
				? `<p>The app is up to date, but the board it shows runs on its own${upd.srv.service ? " (the workbench service)" : ""}, so it stays at ${esc(m.server)} until it's updated too. Until then the board may miss what's new.</p>${updHowServer()}`
				: `<p>The board server was updated and the app not yet. The board works; the app's own parts (tray, notifications, updates) are from ${esc(m.app)}.</p>
					${o ? "" : `<p>Check for a new app in Settings → Updates.</p>`}`}</div>`;
		act = `<button type="button" class="ghost" data-upd="mismatch-hide" title="Don't show this in the board bar for these two versions">Not now</button><span class="spacer"></span>
			${!m.older && o ? `<button type="button" class="primary" data-upd="to-offer">See the app update</button>` : `<button type="button" class="primary" data-upd="close">Close</button>`}`;
	} else if (!o && !busy) {
		b = `<div class="upd-head"><b id="upd-title">You have the newest version</b><small>Workbench ${esc(upd.app?.version ?? upd.srv?.version ?? "")}</small></div>`;
		act = `<span class="spacer"></span><button type="button" class="primary" data-upd="close">Close</button>`;
	} else {
		const date = o?.date ? new Date(o.date).toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" }) : "";
		const notes = o?.notes?.trim() ? `<div class="body-view upd-notes">${md(o.notes)}</div>`
			: `<p class="upd-sub">This release has no notes.${o?.page ? ` <a href="${esc(o.page)}" target="_blank" rel="noreferrer">Its page</a> may say more.` : ""}</p>`;
		const err = upd.err || (o?.from === "app" && !busy ? upd.app.error : "");
		b = `<div class="upd-head"><b id="upd-title">Workbench ${esc(o?.version ?? "")}</b>
			<small>You have ${esc(o?.current ?? upd.app?.version ?? "")}${date ? ` · released ${esc(date)}` : ""}${o?.skipped ? " · you skipped it" : ""}</small></div>
			${notes}${busy ? updProgress() : `<div class="upd-how">${o ? updHow(o) : ""}</div>`}${err ? `<p class="error">${esc(err)}</p>` : ""}`;
		const page = o?.page ? `<a class="ghost" href="${esc(o.page)}" target="_blank" rel="noreferrer">Release page ↗</a>` : "";
		if (busy) act = `<span class="spacer"></span><button type="button" class="ghost" data-upd="close">Hide</button>`;
		else {
			const skip = o.skipped ? `<button type="button" class="ghost" data-upd="unskip">Stop skipping</button>` : `<button type="button" class="ghost" data-upd="skip" title="Not offered again until a newer version comes">Skip this version</button>`;
			const main = o.from === "app" && o.install === "app" ? `<button type="button" class="primary" data-upd="install">Update now</button>`
				: o.from === "app" && upd.app.kind === "deb" && o.deb ? `${page}<a class="primary" href="${esc(o.deb)}" target="_blank" rel="noreferrer">Download the .deb</a>`
				: page;
			act = `${skip}<span class="spacer"></span><button type="button" class="ghost" data-upd="later" title="Hide it from the board bar for a day">Later</button>${main}`;
		}
	}
	paint(body, b);
	paint(actions, act);
}
function renderUpdNote() {
	const el = $("#upd-note");
	const j = upd.app?.justUpdated ?? upd.srvJust;
	if (!j || upd.noteClosed) { el.hidden = true; return; }
	paint(el, `<div class="row"><b>Updated to ${esc(j.to)}</b><small class="upd-sub">from ${esc(j.from)}</small><span class="spacer"></span>
		<button type="button" class="icon-btn" data-upd="note-close" aria-label="Close">${svg16('<path d="m4.5 4.5 7 7M11.5 4.5l-7 7"/>')}</button></div>
		${j.notes?.trim() ? `<div class="body-view upd-notes">${md(j.notes)}</div>` : `<p class="upd-sub" style="margin:0">${j.page ? "Its release page says what's new." : "No release notes came with it."}</p>`}
		<div class="row"><span class="spacer"></span>${j.page ? `<a class="ghost sm" href="${esc(j.page)}" target="_blank" rel="noreferrer">Release page ↗</a>` : ""}<button type="button" class="primary" data-upd="note-close">OK</button></div>`);
	el.hidden = false;
}
async function updAct(what, btn) {
	const o = updOffer(), v = o?.version;
	try {
		if (what === "close") updDlg.close();
		else if (what === "to-offer") { upd.view = "offer"; renderUpdDlg(); }
		else if (what === "install") {
			upd.err = "";
			btn.disabled = true;
			await appCall("update_install", { version: v });
		} else if (what === "later") {
			if (o.from === "app") upd.app = await appCall("update_later", { version: v });
			else localSet("update.later", JSON.stringify({ version: v, until: Date.now() + 864e5 }));
			updDlg.close();
			toast("Hidden for a day. Settings → Updates still has it.");
		} else if (what === "skip" || what === "unskip") {
			const version = what === "skip" ? (v ?? btn.dataset.version) : null;
			if (updFromApp()) upd.app = await appCall("update_skip", { version });
			else await saveSetting("updates.skip", version);
			if (what === "skip") { updDlg.close(); toast(`${version} skipped. A newer version will be offered.`); }
			await updLoad();
		} else if (what === "check") {
			upd.checking = true;
			renderUpd();
			if (updFromApp()) upd.app = await appCall("update_check");
			else upd.srv = await api("/api/update/check", { method: "POST", body: "{}" });
			upd.checking = false;
			const o2 = updOffer(), err = updFromApp() ? upd.app.error : upd.srv.error;
			toast(err ? err : o2 ? `${o2.version} is available` : "You have the newest version");
		} else if (what === "auto") {
			upd.app = await appCall("update_auto", { on: btn.checked });
			toast(btn.checked ? "Checks automatically" : "Checks only when you ask");
		} else if (what === "mismatch-hide") {
			const m = updMismatch();
			if (m) localSet("update.mismatch", `${m.server}|${m.app}`);
			updDlg.close();
		} else if (what === "note-close") {
			upd.noteClosed = true;
			if (upd.app?.justUpdated) appCall("update_seen").catch(() => {});
			if (upd.srvJust) localSet("update.seen", upd.srvJust.to);
		} else if (what === "open") openUpd(btn.dataset.view);
	} catch (e) {
		upd.checking = false;
		upd.err = String(e?.message ?? e);
		if (updDlg.open) renderUpdDlg(); else toast(upd.err);
	}
	renderUpd();
}
document.addEventListener("click", (e) => {
	const b = e.target.closest("[data-upd]");
	if (b && b.type !== "checkbox") updAct(b.dataset.upd, b);
});
document.addEventListener("change", (e) => {
	const b = e.target.closest("input[data-upd]");
	if (b) updAct(b.dataset.upd, b);
});
$("#upd-pill").onclick = () => openUpd($("#upd-pill").dataset.view);
if (app?.event) {
	app.event.listen("update-state", (e) => { upd.app = e.payload; renderUpd(); }).catch(() => {});
	app.event.listen("update-open", () => updLoad().then(() => openUpd("offer"))).catch(() => {});
}

/* Settings → Updates (tab "updates"). In the app: the app's own version, checks and skipped version (kept by the
 * app, "This app"), and the board server it shows. In a browser: this board's version, the daily check (a board
 * setting) and how to update. */
function updStatusText() {
	const fromApp = updFromApp(), at = fromApp ? upd.app.checkedAt : upd.srv?.checkedAt;
	if (upd.checking || upd.app?.checking) return "Checking…";
	const err = fromApp ? upd.app.error : upd.srv?.error, o = updOffer();
	const res = err || (o ? `${o.version} is available${o.skipped ? " (skipped)" : o.later ? " (put off until tomorrow)" : ""}` : at ? "You have the newest version." : "");
	return `${at ? `Checked ${when(at)}` : "Not checked yet"}${res ? ` · ${res}` : ""}`;
}
const UPD_KIND = {
	appimage: "An AppImage: Update now replaces it in place.",
	deb: "Installed from a .deb package: Update now asks for your password to install the new one.",
	rpm: "Installed from an .rpm package: updates are installed by hand.",
	other: "Built from source: it doesn't update itself; pull and build it again.",
};
function updServerText() {
	const s = upd.srv;
	if (!s) return "";
	if (s.how === "app" || upd.info?.server === "owned") return "Started by the app from inside it, so it updates with the app.";
	const where = s.how === "source" ? `Runs from source in ${s.folder}${s.service ? ", as the workbench service" : ""}` : `The standalone server, ${s.exe}`;
	return `${where}${app ? ", outside the app" : ""}.`;
}
function setUpdRender() {
	const s = upd.srv, a = upd.app, o = updOffer(), m = updMismatch();
	const checkBtn = (disabled = false) => `<button type="button" class="ghost sm" data-upd="check"${upd.checking || a?.checking || disabled ? " disabled" : ""}>Check now</button>`;
	const seeBtn = o ? `<button type="button" class="ghost sm" data-upd="open" data-view="offer">See what's new</button>` : "";
	const status = optRow({ label: "Newest release", hint: esc(updStatusText()), control: seeBtn });
	if (updFromApp() || (a && !a.enabled)) {
		const chip = `<span class="scope browser" title="${SCOPE.browser[1]}">${SCOPE.browser[0]}</span>`;
		const rows = [
			optRow({ label: `Workbench app ${esc(a.version)}`, hint: esc(a.enabled ? UPD_KIND[a.kind] ?? "" : "This build of the app has no release feed, so it doesn't check for updates."), control: checkBtn(!a.enabled) }),
			...(a.enabled ? [status,
				optRow({ label: `Check automatically${chip}`, hint: "At launch and every 6 hours. It never downloads or installs without asking.",
					control: `<label class="switch"><input type="checkbox" role="switch" data-upd="auto"${a.auto ? " checked" : ""} aria-label="Check automatically"><span></span></label>` }),
				a.skipped ? optRow({ label: `Skipped version${chip}`, hint: `${esc(a.skipped)} isn't offered in the board bar or the tray. A newer one will be.`,
					control: `<button type="button" class="ghost sm" data-upd="unskip">Stop skipping</button>` }) : ""] : []),
		].filter(Boolean);
		const server = s ? [optRow({ label: `Board server ${esc(s.version)}`, hint: esc(updServerText()) + (m ? ` <b>${m.older ? "It's older than the app." : "It's newer than the app."}</b>` : ""),
			control: m ? `<button type="button" class="ghost sm" data-upd="open" data-view="server">${m.older ? "How to update it" : "What this means"}</button>` : "" })] : [];
		return `<p class="set-intro">The Workbench app checks for new releases on GitHub and installs one only when you say so.</p>
			${optGroup("This app", rows)}${server.length ? optGroup("The board it shows", server) : ""}`;
	}
	if (!s) return `<div class="set-empty">Loading…</div>`;
	const rows = [
		optRow({ label: `Workbench ${esc(s.version)}`, hint: esc(updServerText()), control: checkBtn() }),
		status,
		optRow({ label: "Check for new releases once a day", hint: "Asks GitHub for the newest release's version and notes. Off, the board never goes online by itself; Check now still works.",
			bind: { setting: "updates.check" }, control: ctlToggle({ setting: "updates.check" }, { label: "Check for new releases once a day", disabled: !canChangeBoard() }) }),
		s.skipped ? optRow({ label: "Skipped release", hint: `${esc(s.skipped)} isn't offered in the board bar. A newer one will be.`, bind: { setting: "updates.skip" },
			control: `<button type="button" class="ghost sm" data-upd="unskip">Stop skipping</button>` }) : "",
	].filter(Boolean);
	return `<p class="set-intro">New releases of the Workbench, and how to move to one. ${app ? "" : "In the desktop app, the app checks and updates itself."}</p>
		${optGroup("This board", rows)}${optGroup("How to update", [`<div class="so-wide upd-how">${updHowServer()}</div>`])}`;
}
async function setUpdLoad() { await updLoad(); }
async function setUpdPoll() { await updLoad(); }
// The server's daily check can find something while the page is open; in the app, `update-state` says it at once.
setInterval(() => { if (document.visibilityState === "visible") updLoad().catch(() => {}); }, 15 * 60e3);
