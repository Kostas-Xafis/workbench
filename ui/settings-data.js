/* ---------- Settings → Data (tab "data") ---------- */
// Backups, an export of everything, the database's size, and how long old things are kept (server.ts /api/data*).
// `info` is GET /api/data: { db: sizes and counts, backups: { dir, list }, keep, tidy: what the settings remove now }.
const dataTab = { info: null, error: "", busy: "", allBackups: false, restore: null, compacted: null };
const DATA_KEEP = {
	"backups.keep": { field: "backups", min: 1, max: 90 },
	"keep.report-versions": { field: "reportVersions", min: 0, max: 500 },
	"keep.tracker-history": { field: "trackerHistory", min: 100, max: 10000 },
	"keep.closed-items-days": { field: "closedItemsDays", min: 0, max: 3650 },
};
const dtN = (n, one, many = `${one}s`) => `${Number(n).toLocaleString()} ${n === 1 ? one : many}`;
const dtWhen = (ms) => new Date(ms).toLocaleString([], { weekday: "short", day: "numeric", month: "short", year: new Date(ms).getFullYear() === new Date().getFullYear() ? undefined : "numeric", hour: "2-digit", minute: "2-digit" });
const dtAgo = (ms) => ago(new Date(ms).toISOString().slice(0, 19));
const DT_IC = {
	backup: '<ellipse cx="8" cy="3.75" rx="5.25" ry="2"/><path d="M2.75 3.75v8.5c0 1.1 2.35 2 5.25 2s5.25-.9 5.25-2v-8.5M2.75 8c0 1.1 2.35 2 5.25 2s5.25-.9 5.25-2"/>',
	down: '<path d="M8 2.5v8M4.75 7.5 8 10.75l3.25-3.25M3 13.5h10"/>',
};
// What a setting's value would remove right now, in words.
function dtRemoves(key, c) {
	const parts = {
		"backups.keep": c.backups ? dtN(c.backups, "older backup") : "",
		"keep.report-versions": c.reportVersions ? dtN(c.reportVersions, "old report version") : "",
		"keep.tracker-history": c.trackerReadings ? dtN(c.trackerReadings, "old tracker reading") : "",
		"keep.closed-items-days": c.items ? `${dtN(c.items, "closed item")}${c.notes ? ` and ${dtN(c.notes, "note")}` : ""}` : "",
	}[key];
	return parts;
}
const dtWould = (key) => {
	const t = dataTab.info?.tidy;
	if (!t) return "";
	const what = dtRemoves(key, t);
	return `<span class="dt-would${what ? " some" : ""}">${what ? `Removes ${esc(what)} tonight` : "Removes nothing right now"}</span>`;
};
// A number for one of the keep settings. It doesn't save itself: a change that would delete something asks first.
function dtKeepInput(key, { unit = "", step = 1, label }) {
	const d = DATA_KEEP[key];
	return `<input type="number" data-data-keep="${esc(key)}" value="${esc(setting(key))}" min="${d.min}" max="${d.max}" step="${step}" aria-label="${esc(label)}"${canChangeBoard() ? "" : " disabled"}>${unit ? `<span class="so-unit">${esc(unit)}</span>` : ""}`;
}

function dtBackupRow(b, i) {
	const open = dataTab.restore?.name === b.name;
	const row = `<div class="so dt-bk${i === 0 ? " newest" : ""}" data-backup="${esc(b.name)}">
		<span class="dt-ic" aria-hidden="true">${svg16(DT_IC.backup, 1.3)}</span>
		<div class="so-main"><div class="so-label">${esc(dtWhen(b.at))}${i === 0 ? `<span class="dt-tag">Newest</span>` : ""}</div><small>${esc(dtAgo(b.at))} · ${fmtBytes(b.bytes)}</small></div>
		<div class="so-ctl">
			<a class="ghost sm" href="/api/data/backups/${encodeURIComponent(b.name)}" download="${esc(b.name)}" aria-label="Download the backup from ${esc(dtWhen(b.at))}">Download</a>
			<button type="button" class="ghost sm" data-data="restore" aria-expanded="${open}" aria-label="Restore the backup from ${esc(dtWhen(b.at))}">Restore…</button>
		</div></div>`;
	return row + (open ? dtRestorePanel(b) : "");
}
function dtRestorePanel(b) {
	const r = dataTab.restore;
	const body = r.error
		? `<p class="error">${esc(r.error)}</p>`
		: !r.steps
			? `<p class="hint">Working out the commands for this computer…</p>`
			: `<ol>${r.steps.steps.map((s) => `<li><span>${esc(s.text)}</span>${cmdRow(s.cmd)}</li>`).join("")}</ol>
				<div class="row"><button type="button" class="ghost sm" data-copy="${esc(r.steps.all)}">Copy all the commands</button><span class="spacer"></span><button type="button" class="ghost sm" data-data="restore-close">Close</button></div>`;
	return `<div class="so-wide dt-restore" role="region" aria-labelledby="dt-restore-h">
		<h4 id="dt-restore-h">Restore the backup from ${esc(dtWhen(b.at))}</h4>
		<p>The board can't swap its database while it runs, so run these in a terminal on this computer, while no agent is working on the board.</p>
		<p class="caution">Anything added or changed after this backup (${esc(dtAgo(b.at))}) is lost from the board. Step 2 keeps today's database next to it, in case you want it back. Vault secrets stay encrypted in backups: the same password opens them.</p>
		${body}</div>`;
}

function setDataRender() {
	const d = dataTab.info;
	const intro = "";
	if (!d) return intro + (dataTab.error ? `<p class="error">${esc(dataTab.error)} <button type="button" class="ghost sm" data-data="reload">Try again</button></p>` : `<div class="set-empty">Loading…</div>`);
	const err = dataTab.error ? `<p class="error" role="alert">${esc(dataTab.error)}</p>` : "";
	const busy = (what) => dataTab.busy === what;
	const list = d.backups.list;
	const total = list.reduce((n, b) => n + b.bytes, 0);
	const shown = dataTab.allBackups ? list : list.slice(0, 5);
	const backups = optGroup("Backups", [
		optRow({
			label: "Backups kept",
			hint: `The board makes one every night and removes the oldest beyond this. ${dtWould("backups.keep")}`,
			bind: { setting: "backups.keep" },
			control: dtKeepInput("backups.keep", { label: "Backups kept" }),
		}),
		optRow({
			label: list.length ? `${dtN(list.length, "backup")}, ${fmtBytes(total)}` : "No backups yet",
			hint: `<span class="dt-path" title="Where they are">${esc(d.backups.dir)}</span>`,
			control: `<button type="button" class="primary sm" data-data="backup"${busy("backup") || !canChangeBoard() ? " disabled" : ""}>${busy("backup") ? "Backing up…" : "Back up now"}</button>`,
		}),
		...shown.map(dtBackupRow),
		list.length > 5 ? `<button type="button" class="dt-more" data-data="more" aria-expanded="${dataTab.allBackups}">${dataTab.allBackups ? "Show the newest 5" : `Show all ${list.length}`}</button>` : "",
	]);

	const exp = optGroup("Export", [
		optRow({
			label: "Export everything",
			hint: "One file with everything on the board, a row per line: projects, items with their notes and pictures, links, reports with every version, trackers and their history, goals, rulings, settings, and the vault, still encrypted. <code>wb export &gt; file.jsonl</code> does the same; <code>wb import</code> puts it on an empty board.",
			control: `<a class="ghost sm dt-dl" href="/api/data/export" download>${svg16(DT_IC.down, 1.4)}Download</a>`,
		}),
	]);

	const s = d.db;
	const stat = (label, c, bytes = true) => `<div><dt>${label}</dt><dd>${Number(c.n).toLocaleString()}${bytes && c.bytes ? `<small>${fmtBytes(c.bytes)}</small>` : ""}</dd></div>`;
	const compacted = dataTab.compacted ? ` Last compacted: ${fmtBytes(dataTab.compacted.before)} → ${fmtBytes(dataTab.compacted.after)}.` : "";
	const database = optGroup("Database", [
		optRow({
			label: `${fmtBytes(s.bytes + s.wal)} on disk`,
			hint: `<span class="dt-path">${esc(s.path)}</span>${s.wal ? ` · ${fmtBytes(s.wal)} of it in the write-ahead log, which goes back into the file as the board runs` : ""}`,
			control: "",
		}),
		`<div class="so-wide"><dl class="dt-stats">${stat("Items", s.items)}${stat("Notes", s.notes)}${stat("Report versions", s.reportVersions)}${stat("Tracker readings", s.trackerReadings)}${stat("Images", s.images)}${stat("Link icons", s.linkIcons)}</dl></div>`,
		optRow({
			label: "Compact",
			hint: `Gives back the room that removed things left behind, so the file is no bigger than what it holds.${compacted}`,
			control: `<button type="button" class="ghost sm" data-data="compact"${busy("compact") || !canChangeBoard() ? " disabled" : ""}>${busy("compact") ? "Compacting…" : "Compact"}</button>`,
		}),
	], "Report versions are usually most of it: every day page and every report republished adds one.");

	const tidy = optGroup("Keeping things tidy", [
		optRow({
			label: "Report versions",
			hint: `Versions kept per report. 0 keeps every one; the latest always stays. ${dtWould("keep.report-versions")}`,
			bind: { setting: "keep.report-versions" },
			control: dtKeepInput("keep.report-versions", { unit: "per report", label: "Report versions kept per report, 0 for all" }),
		}),
		optRow({
			label: "Tracker history",
			hint: `Readings kept per tracker, for the trend in its dialog. ${dtWould("keep.tracker-history")}`,
			bind: { setting: "keep.tracker-history" },
			control: dtKeepInput("keep.tracker-history", { unit: "readings", step: 100, label: "Tracker readings kept per tracker" }),
		}),
		optRow({
			label: "Done and dropped items",
			hint: `Removed with their notes this many days after they close. 0 keeps them forever; otherwise 30 to 3650. ${dtWould("keep.closed-items-days")}`,
			bind: { setting: "keep.closed-items-days" },
			control: dtKeepInput("keep.closed-items-days", { unit: "days", label: "Days to keep done and dropped items, 0 for forever" }),
		}),
	], "Applied every night right after the backup, so the backup still has what goes, and as soon as you change one here.");

	return intro + err + backups + exp + database + tidy;
}

async function setDataLoad() {
	try {
		dataTab.info = await api("/api/data");
		dataTab.error = "";
	} catch (e) { dataTab.error = e.message; }
	renderSettings();
}
// Not while something runs: its own answer brings the new numbers.
async function setDataPoll() { if (!dataTab.busy) await setDataLoad(); }

// Runs a slow or destructive action once: the button shows it's working, then a toast says what happened.
async function dtRun(what, fn) {
	if (dataTab.busy) return;
	dataTab.busy = what;
	dataTab.error = "";
	renderSettings();
	try { await fn(); }
	catch (e) { dataTab.error = e.message; toast(e.message); }
	dataTab.busy = "";
	renderSettings();
}
const dtPost = (path) => api(path, { method: "POST", body: "{}" });
function dtRemovedText(r) {
	const parts = [
		r.backups && dtN(r.backups, "old backup"),
		r.reportVersions && dtN(r.reportVersions, "report version"),
		r.trackerReadings && dtN(r.trackerReadings, "tracker reading"),
		r.items && dtN(r.items, "closed item"),
		r.notes && dtN(r.notes, "note"),
	].filter(Boolean);
	return parts.length ? `Removed ${parts.join(", ")}` : "Nothing to remove";
}

// A keep setting changed (typed, or "Default"): say what it would delete, ask, save, then apply it right away.
async function dtChangeKeep(key, value, anchor) {
	const d = DATA_KEEP[key];
	// Puts the typed value back to the saved one: paint() skips HTML it has already drawn.
	const back = () => { $("#settings-view")._html = ""; renderSettings(); };
	if (!canChangeBoard()) { back(); return toast("Board settings change only on this computer"); }
	if (value !== null && (!Number.isInteger(value) || value < d.min || value > d.max || (key === "keep.closed-items-days" && value > 0 && value < 30))) {
		back();
		return toast(key === "keep.closed-items-days" ? "0 (keep them), or 30 to 3650 days" : `A whole number from ${d.min} to ${d.max}`);
	}
	const v = value ?? state.settingDefs[key]?.default;
	let counts;
	try { ({ counts } = await api(`/api/data/tidy?${encodeURIComponent(key)}=${encodeURIComponent(v)}`)); }
	catch (e) { back(); return toast(e.message); }
	const what = dtRemoves(key, counts);
	if (what) {
		const backupFirst = key !== "backups.keep";
		const which = key === "keep.closed-items-days" ? ` (done or dropped more than ${v} days ago)` : "";
		if (!(await confirmIn(anchor, { text: `This removes ${what}${which} right away${backupFirst ? ", after making a backup that still has them" : ""}. Go ahead?`, yes: "Remove them", danger: true }))) return back();
	}
	await saveSetting(key, value);
	if (setting(key) !== v) return;
	if (!what) return setDataLoad();
	await dtRun("tidy", async () => {
		const r = await dtPost("/api/data/tidy");
		const { removed, backup, ...info } = r;
		dataTab.info = info;
		toast(`${dtRemovedText(removed)}${backup ? " (backed up first)" : ""}`);
	});
}

$("#settings-view").addEventListener("change", (e) => {
	const el = e.target.closest("[data-data-keep]");
	if (el) dtChangeKeep(el.dataset.dataKeep, el.value === "" ? null : Number(el.value), el);
});
// While a number is typed, its row says what that number would remove right now.
let dtPreview;
$("#settings-view").addEventListener("input", (e) => {
	const el = e.target.closest("[data-data-keep]");
	if (!el) return;
	clearTimeout(dtPreview);
	dtPreview = setTimeout(async () => {
		const key = el.dataset.dataKeep, out = el.closest(".so")?.querySelector(".dt-would");
		if (!out || el.value === "") return;
		const n = Number(el.value), d = DATA_KEEP[key];
		if (!Number.isInteger(n) || n < d.min || n > d.max || (key === "keep.closed-items-days" && n > 0 && n < 30)) {
			out.textContent = key === "keep.closed-items-days" ? "0 (keep them), or 30 to 3650 days" : `A whole number from ${d.min} to ${d.max}`;
			return out.classList.add("some");
		}
		try {
			const { counts } = await api(`/api/data/tidy?${encodeURIComponent(key)}=${encodeURIComponent(el.value)}`);
			const what = dtRemoves(key, counts);
			out.textContent = what ? `${el.value} would remove ${what} right away` : `${el.value} removes nothing right now`;
			out.classList.toggle("some", !!what);
		} catch (err) {
			out.textContent = err.message.replace(/^[^:]*: /, "");
			out.classList.add("some");
		}
	}, 300);
});
$("#settings-view").addEventListener("click", async (e) => {
	// "Default" on a keep setting can delete things too: it goes through the same question.
	const reset = e.target.closest("[data-reset]");
	const resetKey = reset?.dataset.reset.startsWith("setting:") && reset.dataset.reset.slice(8);
	if (resetKey && DATA_KEEP[resetKey]) {
		e.stopImmediatePropagation();
		return dtChangeKeep(resetKey, null, reset);
	}
	const b = e.target.closest("[data-data]");
	if (!b) return;
	const act = b.dataset.data;
	if (act === "reload") { dataTab.error = ""; renderSettings(); setDataLoad(); }
	else if (act === "more") { dataTab.allBackups = !dataTab.allBackups; renderSettings(); }
	else if (act === "backup")
		dtRun("backup", async () => {
			const { name, pruned, ...info } = await dtPost("/api/data/backups");
			dataTab.info = info;
			toast(`Backed up${pruned ? `, and removed ${dtN(pruned, "older backup")}` : ""}`);
		});
	else if (act === "compact") {
		if (!(await confirmIn(b, { text: "Compact the database? It can take a moment, and the board waits until it's done.", yes: "Compact", danger: true }))) return;
		dtRun("compact", async () => {
			const { before, after, ...info } = await dtPost("/api/data/compact");
			dataTab.info = info;
			dataTab.compacted = { before, after };
			toast(before - after > 1024 ? `Compacted: ${fmtBytes(before)} → ${fmtBytes(after)}` : `Already compact (${fmtBytes(after)})`);
		});
	}
	else if (act === "restore") {
		const name = b.closest("[data-backup]").dataset.backup;
		if (dataTab.restore?.name === name) { dataTab.restore = null; return renderSettings(); }
		dataTab.restore = { name, steps: null, error: "" };
		renderSettings();
		api(`/api/data/backups/${encodeURIComponent(name)}/restore`)
			.then((steps) => { if (dataTab.restore?.name === name) dataTab.restore.steps = steps; })
			.catch((err) => { if (dataTab.restore?.name === name) dataTab.restore.error = err.message; })
			.finally(() => { renderSettings(); $(`#settings-view .dt-restore`)?.scrollIntoView({ block: "nearest", behavior: "smooth" }); });
	}
	else if (act === "restore-close") {
		const name = dataTab.restore?.name;
		dataTab.restore = null;
		renderSettings();
		$(`#settings-view [data-backup="${CSS.escape(name ?? "")}"] [data-data="restore"]`)?.focus();
	}
});
/* ---------- end: Data ---------- */
