/* ---------- Status trackers (trackers.ts) ---------- */

// Under the project's name in the rail: its trackers, then the global ones. A tracker is a few meters
// (value of max, or a state in words), each with a level; grey until it warns.
const LOCAL = !CLOUD && ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);
const TRK_ADD = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-linecap="round"><g stroke-width="1.4"><path d="M2 12.5a6 6 0 0 1 9.4-4.95"/><path d="M8 12.5l2.2-3.3"/><path d="M12.5 10v5M10 12.5h5"/></g></svg>`;
const EVERY = [[300, "5 min"], [900, "15 min"], [1800, "30 min"], [3600, "1 hour"], [10800, "3 hours"], [21600, "6 hours"], [43200, "12 hours"], [86400, "1 day"], [0, "Only when asked"]];
const SERIES = ["var(--accent)", "var(--review)", "var(--decision)", "var(--check)", "var(--setup)"];
const fmtNum = (n) => Number(n).toLocaleString("en-US", { maximumFractionDigits: 2 });
const CURRENCY = ["$", "€", "£"];
const unitOf = (u) => !u || CURRENCY.includes(u) ? "" : u === "%" ? "%" : ` ${u}`;
// A number with its unit: "12 builds", "78%", "$1.52".
const withUnit = (n, u) => `${CURRENCY.includes(u) ? u : ""}${fmtNum(n)}`;
const everyText = (s) => !s ? "only when asked" : s % 86400 === 0 ? (s === 86400 ? "every day" : `every ${s / 86400} days`)
	: s % 3600 === 0 ? (s === 3600 ? "every hour" : `every ${s / 3600} h`) : s % 60 === 0 ? `every ${s / 60} min` : `every ${s} s`;
function inDays(iso) {
	const d = Math.ceil((Date.parse(iso) - Date.now()) / 86400e3);
	return d <= 0 ? "today" : d === 1 ? "tomorrow" : `in ${d} days`;
}
const trkName = (t) => !state.project && t.project ? `${projectName(t.project)} · ${t.title}` : t.title;
const shownTrackers = () => state.trackers.filter((t) => !t.project || (state.project ? t.project === state.project : !isArchived(t.project)));
// "12/15 builds" with the number in bold; a state in words as it is.
const valueHtml = (m) => m.value == null ? esc(m.text ?? "")
	: `<b>${esc(withUnit(m.value, m.unit))}</b><small>${m.max != null ? `/${esc(withUnit(m.max, m.unit))}` : ""}${esc(unitOf(m.unit))}</small>`;
const meterPlain = (m) => m.value == null ? `${m.label ? `${m.label}: ` : ""}${m.text ?? ""}`
	: `${m.label ? `${m.label} ` : ""}${withUnit(m.value, m.unit)}${m.max != null ? `/${withUnit(m.max, m.unit)}` : ""}${unitOf(m.unit)}${m.left != null && m.max ? ` (${withUnit(m.left, m.unit)} left)` : ""}`;
const pctOf = (m) => m.value != null && m.max ? Math.max(0, Math.min(100, (m.value / m.max) * 100)) : null;
function trkTip(t) {
	const r = t.reading;
	return [
		trkName(t) + (t.project ? "" : " (every project)"),
		...(r ? r.meters.map(meterPlain) : ["no reading yet"]),
		r?.resets_at ? `resets ${new Date(r.resets_at).toLocaleDateString()} (${inDays(r.resets_at)})` : "",
		r?.note ?? "",
		t.error ? `last read failed: ${t.error}` : "",
		t.stale ? "stale: it hasn't read for a while" : "",
		t.kind === "manual" ? (t.read_at ? `recorded ${ago(t.read_at)}` : "") : t.read_at ? `read ${ago(t.read_at)} · ${everyText(t.every)}` : "",
	].filter(Boolean).join("\n");
}

// card: the same look as a plain block, for the hover card of the folded rail.
function trackerRow(t, card = false) {
	const ms = t.reading?.meters ?? [];
	const flag = t.error ? `<span class="trk-flag" aria-label="Last read failed">!</span>` : "";
	const cls = `trk${t.stale ? " stale" : ""}`;
	const head = (right) => `<div class="trk-top"><span class="trk-name">${esc(trkName(t))}</span>${flag}${right}</div>`;
	const open = (lv, body) => card ? `<div class="${cls}${lv ? ` lv-${lv}` : ""}">${body}</div>`
		: `<button type="button" class="${cls}${lv ? ` lv-${lv}` : ""}" data-tracker="${t.id}" title="${esc(trkTip(t))}">${body}</button>`;
	if (!ms.length) return open("", head(`<small>${t.running ? "reading…" : t.error ? "failed" : "no reading yet"}</small>`));
	if (ms.length === 1) {
		const m = ms[0], p = pctOf(m);
		return open(m.level, head(m.value == null ? `<span class="mt">${esc(m.text ?? "")}</span>` : `<span class="mv">${valueHtml(m)}</span>`) +
			(p == null ? "" : `<span class="bar"><i style="width:${p}%"></i></span>`));
	}
	// Under All the name carries its project, so the reset date stays in the tooltip.
	const resets = t.reading.resets_at && state.project ? `<small>resets ${inDays(t.reading.resets_at)}</small>` : "";
	const rows = ms.map((m) => {
		const p = pctOf(m);
		const cells = m.value == null ? `<span class="mt">${esc(m.text ?? "")}</span>`
			: `${p == null ? "<span></span>" : `<span class="bar"><i style="width:${p}%"></i></span>`}<span class="mv">${valueHtml(m)}</span>`;
		return `<span class="trk-m${m.level ? ` lv-${m.level}` : ""}"><span class="ml">${esc(m.label)}</span>${cells}</span>`;
	}).join("");
	return open("", head(resets) + `<div class="trk-ms">${rows}</div>`);
}

function railTrackers(collapsed) {
	const list = shownTrackers();
	if (!list.length) return "";
	if (collapsed) return `<div class="trackers">${list.map((t) => {
		const ps = (t.reading?.meters ?? []).map(pctOf).filter((p) => p != null);
		const c = t.error ? "var(--bug)" : t.level === "bad" ? "var(--bug)" : t.level === "warn" ? "var(--review)" : "var(--muted)";
		return `<button type="button" class="trk-mini${t.stale ? " stale" : ""}" data-tracker="${t.id}" aria-label="${esc(trkTip(t))}"><span class="trk-ring" style="--c:${c}">${ringSvg(ps.length ? Math.max(...ps) : 100, 22, 3.5)}</span></button>`;
	}).join("")}</div>`;
	return `<div class="trackers">${list.map((t) => trackerRow(t)).join("")}</div>`;
}

// The folded rail's hover card: it lives on <body> because the rail clips what overflows it.
const trkPop = document.createElement("div");
trkPop.id = "trk-pop";
trkPop.setAttribute("aria-hidden", "true");
document.body.append(trkPop);
let popFor = null, popHide = 0;
function showTrkPop(btn) {
	clearTimeout(popHide);
	const t = state.trackers.find((x) => x.id === Number(btn.dataset.tracker));
	if (!t) return hideTrkPop(true);
	popFor = t.id;
	paint(trkPop, trackerRow(t, true));
	// Beside the rail, centred on the ring, kept on screen.
	const r = btn.getBoundingClientRect(), h = trkPop.offsetHeight;
	trkPop.style.left = `${$("#rail").getBoundingClientRect().right + 6}px`;
	trkPop.style.top = `${Math.max(8, Math.min(r.top + r.height / 2 - h / 2, innerHeight - h - 8))}px`;
	trkPop.classList.add("show");
}
// A short wait, so sliding from one ring to the next swaps the card instead of blinking it.
function hideTrkPop(now = false) {
	clearTimeout(popHide);
	const go = () => { trkPop.classList.remove("show"); popFor = null; };
	if (now) go(); else popHide = setTimeout(go, 90);
}
$("#rail").addEventListener("pointerover", (e) => {
	const b = e.target.closest(".trk-mini");
	if (b && e.pointerType !== "touch") showTrkPop(b);
});
$("#rail").addEventListener("pointerout", (e) => {
	const b = e.target.closest(".trk-mini");
	if (b && !b.contains(e.relatedTarget)) hideTrkPop();
});
$("#rail").addEventListener("focusin", (e) => {
	const b = e.target.closest(".trk-mini");
	if (b?.matches(":focus-visible")) showTrkPop(b);
});
$("#rail").addEventListener("focusout", (e) => { if (e.target.closest(".trk-mini")) hideTrkPop(); });
$("#rail").addEventListener("scroll", () => hideTrkPop(true));

async function loadTrackers() {
	const list = await api("/api/trackers");
	if (JSON.stringify(list) === JSON.stringify(state.trackers)) return;
	state.trackers = list;
	renderRail();
}

const trkDlg = $("#trk-dlg");
const trkForm = $("#trk-form");
let trk = null;            // the tracker in the dialog, with its history
let trkEditing = null;     // what the edit form edits ({} fields for a new one)
let trkPresets = null;
let nameTouched = false;
const loadPresets = async () => (trkPresets ??= await api("/api/tracker-presets"));

async function openTracker(id) {
	try { trk = await api(`/api/trackers/${id}`); } catch (e) { return toast(e.message); }
	await loadPresets().catch(() => ({}));
	showTrackerView();
	if (!trkDlg.open) trkDlg.showModal();
}

function trackerChart(t) {
	const pts = (t.history || []).map((h) => ({ at: parseTime(h.at).getTime(), meters: h.reading.meters }));
	if (pts.length < 2) return "";
	const labels = [...new Set(pts.flatMap((p) => p.meters.filter((m) => m.value != null).map((m) => m.label)))].slice(0, SERIES.length);
	if (!labels.length) return "";
	const W = 560, H = 120, L = 30, R = 6, T = 8, B = 18;
	const t0 = pts[0].at, t1 = Math.max(Date.now(), pts.at(-1).at + 1);
	const maxes = [...new Set(pts.flatMap((p) => p.meters.map((m) => m.max ?? t.max)).filter((v) => v != null))];
	const top = Math.max(1, ...maxes, ...pts.flatMap((p) => p.meters.map((m) => m.value ?? 0)));
	const x = (at) => L + ((at - t0) / (t1 - t0)) * (W - L - R);
	const y = (v) => T + (1 - v / top) * (H - T - B);
	const lines = labels.map((label, n) => {
		let d = "";
		for (const p of pts) {
			const m = p.meters.find((m) => m.label === label);
			if (m?.value == null) continue;
			d += d ? ` H${x(p.at).toFixed(1)} V${y(m.value).toFixed(1)}` : `M${x(p.at).toFixed(1)} ${y(m.value).toFixed(1)}`;
		}
		return d ? `<path d="${d} H${x(t1).toFixed(1)}" fill="none" stroke="${SERIES[n]}" stroke-width="1.8" stroke-linejoin="round"/>` : "";
	}).join("");
	const guides = maxes.map((v) => `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="var(--muted)" stroke-dasharray="3 3" stroke-width="1" opacity=".6"/>` +
		`<text class="ax" x="${L - 5}" y="${y(v) + 3}" text-anchor="end">${fmtNum(v)}</text>`).join("");
	const day = (at) => new Date(at).toLocaleDateString([], { month: "short", day: "numeric" });
	const svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Readings over time">
		<line x1="${L}" x2="${W - R}" y1="${y(0)}" y2="${y(0)}" stroke="var(--line)"/>${guides}
		<text class="ax" x="${L - 5}" y="${y(0) + 3}" text-anchor="end">0</text>${lines}
		<text class="ax" x="${L}" y="${H - 3}">${day(t0)}</text><text class="ax" x="${W - R}" y="${H - 3}" text-anchor="end">now</text></svg>`;
	const legend = labels.length > 1 || labels[0] ? `<div class="tv-legend">${labels.map((l, n) => `<span><i style="background:${SERIES[n]}"></i>${esc(l || t.title)}</span>`).join("")}</div>` : "";
	return svg + legend;
}

function showTrackerView() {
	const t = trk;
	$("#trk-view").hidden = false;
	$("#trk-edit").hidden = true;
	$("#tv-title").textContent = t.title;
	$("#tv-ref").textContent = t.ref;
	$("#tv-ref").dataset.copy = t.ref;
	$("#tv-scope").textContent = t.project ? projectName(t.project) : "Every project";
	const ms = t.reading?.meters ?? [];
	$("#tv-meters").innerHTML = ms.length ? ms.map((m) => {
		const p = pctOf(m);
		const lv = m.level ? ` lv-${m.level}` : "";
		const label = `<span class="ml">${esc(m.label || (ms.length === 1 ? "" : "—"))}</span>`;
		if (m.value == null) return `<span class="trk-m${lv}">${label}<span class="mt">${esc(m.text ?? "")}</span></span>`;
		// Everything that came from a reading is escaped: a unit, a label or a text can carry markup.
		const detail = [m.max != null ? `of ${withUnit(m.max, m.unit)}${unitOf(m.unit)}` : unitOf(m.unit).trim(), m.left != null && m.max ? `${withUnit(m.left, m.unit)} left` : "",
			p != null ? `${Math.round(p)}%` : "", m.text ?? ""].filter(Boolean).map(esc).join(" · ");
		return `<span class="trk-m${lv}">${label}${p == null ? "<span></span>" : `<span class="bar"><i style="width:${p}%"></i></span>`}<span class="mv"><b>${esc(withUnit(m.value, m.unit))}</b> <small>${detail}</small></span></span>`;
	}).join("") : `<span class="hint" style="grid-column:1/-1">${t.kind === "manual" ? "No reading yet: record one below." : t.error ? "No reading yet: the last read failed." : "No reading yet."}</span>`;
	const r = t.reading;
	$("#tv-info").innerHTML = [
		r?.resets_at ? `<span>Resets ${esc(new Date(r.resets_at).toLocaleDateString([], { month: "short", day: "numeric" }))} (${inDays(r.resets_at)})</span>` : "",
		r?.note ? `<span>${esc(r.note)}</span>` : "",
		r?.url ? `<a href="${esc(r.url)}" target="_blank" rel="noreferrer">Details ↗</a>` : "",
	].join("");
	$("#tv-error").hidden = !t.error;
	$("#tv-error").textContent = t.error ? `Last read failed ${ago(t.checked_at)}: ${t.error}` : "";
	$("#tv-chart").innerHTML = trackerChart(t);
	const manual = t.kind === "manual";
	$("#tv-record").hidden = !manual;
	if (manual) $("#tv-reading").value = ms.map((m) => m.value == null ? `${m.label ? `${m.label}: ` : ""}${m.text ?? ""}` : `${m.label ? `${m.label} ` : ""}${m.value}${m.max != null && m.max !== t.max ? `/${m.max}` : ""}`).join("\n");
	const last = t.history?.at(-1);
	const how = manual ? "Manual" : t.kind === "command" ? `Runs <code>${esc(t.command)}</code>` : esc(trkPresets?.[t.kind]?.title ?? t.kind) + (Object.keys(t.options).length ? ` (${esc(Object.entries(t.options).map(([k, v]) => `${k} ${v}`).join(", "))})` : "");
	const when = manual ? (t.read_at ? `recorded ${ago(t.read_at)}${last?.author ? ` by ${esc(last.author)}` : ""}` : "")
		: [everyText(t.every), t.read_at ? `read ${ago(t.read_at)}` : "", t.due_at && t.every ? `next ${parseTime(t.due_at) > Date.now() ? `at ${parseTime(t.due_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : "soon"}` : ""].filter(Boolean).join(" · ");
	$("#tv-source").innerHTML = [how, when].filter(Boolean).join(" · ");
	$("#tv-refresh").hidden = manual;
	$("#tv-err").textContent = "";
}

async function reloadTracker() {
	trk = await api(`/api/trackers/${trk.id}`);
	showTrackerView();
	loadTrackers();
}
async function refreshTrackerNow() {
	const b = $("#tv-refresh");
	b.disabled = true;
	b.textContent = "Reading…";
	try {
		await api(`/api/trackers/${trk.id}/refresh`, { method: "POST" });
		await reloadTracker();
	} catch (e) { $("#tv-err").textContent = e.message; }
	finally { b.disabled = false; b.textContent = "Refresh now"; }
}
$("#tv-refresh").onclick = refreshTrackerNow;
$("#tv-save").onclick = async () => {
	const text = $("#tv-reading").value.trim();
	if (!text) return;
	try {
		await api(`/api/trackers/${trk.id}/reading`, { method: "POST", body: JSON.stringify({ text }) });
		await reloadTracker();
	} catch (e) { $("#tv-err").textContent = e.message; }
};
$("#tv-reading").addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); $("#tv-save").click(); } });
$("#tv-delete").onclick = async () => {
	if (!confirm(`Delete the tracker "${trk.title}" and its history?`)) return;
	try {
		await api(`/api/trackers/${trk.id}`, { method: "DELETE" });
		trkDlg.close();
		loadTrackers();
	} catch (e) { $("#tv-err").textContent = e.message; }
};
$("#tv-edit").onclick = () => editTracker(trk);
$("#tv-close").onclick = () => trkDlg.close();

const slug = (s) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
function everyOptions(current) {
	const opts = EVERY.map(([v, label]) => ({ value: v, label }));
	if (current && !EVERY.some(([v]) => v === current)) opts.unshift({ value: current, label: everyText(current).replace("every ", "") });
	setOptions(trkForm.every, opts);
	trkForm.every.value = String(current ?? 3600);
}

async function editTracker(t) {
	let presets;
	try { presets = await loadPresets(); } catch (e) { return toast(e.message); }
	trkEditing = t;
	nameTouched = !!t.id;
	setOptions(trkForm.project, [{ value: "", label: "Every project" }, ...state.projects.map((p) => ({ value: p.slug, label: p.name }))]);
	setOptions(trkForm.kind, [
		{ value: "manual", label: "By hand: you or an agent record it" },
		{ value: "command", label: "A shell command" },
		...Object.entries(presets).map(([k, p]) => ({ value: k, label: `${p.title} (built in)` })),
	]);
	for (const k of ["title", "name", "unit", "warn", "bad", "url", "command"]) trkForm[k].value = t[k] ?? "";
	trkForm.project.value = t.project ?? "";
	trkForm.kind.value = t.kind ?? "manual";
	trkForm.max.value = t.max ?? "";
	everyOptions(t.id ? t.every : 3600);
	showKind();
	$("#te-heading").textContent = t.id ? `Edit ${t.title}` : "New tracker";
	$("#te-err").textContent = "";
	$("#trk-view").hidden = true;
	$("#trk-edit").hidden = false;
	if (!trkDlg.open) trkDlg.showModal();
	trkForm.title.focus();
}

function showKind() {
	const k = trkForm.kind.value;
	const p = trkPresets?.[k];
	$("#te-command-field").hidden = k !== "command";
	trkForm.command.disabled = k === "command" && !LOCAL;
	trkForm.every.closest("label").hidden = k === "manual";
	$("#te-about").textContent = k === "manual"
		? "Record readings in this dialog, with wb track, or from an agent (record_tracker). Readings look like 12/15, a line per meter (Android 12/15), or a state (In review)."
		: k === "command"
			? (LOCAL ? "It prints 12/15, a line per meter (Android 12/15), a state (In review), or JSON: {value, max, unit} or {meters: [...], note, resets_at, url}. Exit code non-zero = failed."
				: "A command runs on the board's computer, so it can be set only there (localhost) or with wb tracker.")
			: p?.about ?? "";
	$("#te-params").innerHTML = p ? Object.entries(p.options).map(([name, o]) =>
		`<label title="${esc(o.about)}">${esc(name)}<input data-param="${esc(name)}" value="${esc(trkEditing?.kind === k ? (trkEditing.options?.[name] ?? "") : "")}" placeholder="${esc(o.default ?? "automatic")}"><small class="hint">${esc(o.about)}</small></label>`).join("") : "";
}
trkForm.kind.addEventListener("change", () => {
	const p = trkPresets?.[trkForm.kind.value];
	if (!trkEditing.id && p) {
		const titles = Object.values(trkPresets).map((x) => x.title);
		if (!trkForm.title.value.trim() || titles.includes(trkForm.title.value.trim())) trkForm.title.value = p.title;
		if (!nameTouched) trkForm.name.value = slug(trkForm.title.value);
		everyOptions(p.every);
		if (!trkForm.unit.value && p.unit) trkForm.unit.placeholder = p.unit;
	}
	showKind();
});
trkForm.title.addEventListener("input", () => { if (!nameTouched) trkForm.name.value = slug(trkForm.title.value); });
trkForm.name.addEventListener("input", () => { nameTouched = true; });
$("#te-cancel").onclick = () => (trkEditing?.id && trk?.id === trkEditing.id ? showTrackerView() : trkDlg.close());

trkForm.addEventListener("submit", async (e) => {
	e.preventDefault();
	if ($("#trk-edit").hidden) return;
	const kind = trkForm.kind.value;
	const body = {
		title: trkForm.title.value.trim(), name: trkForm.name.value.trim(), project: trkForm.project.value, kind,
		every: kind === "manual" ? 0 : Number(trkForm.every.value),
		max: trkForm.max.value.trim() === "" ? null : Number(trkForm.max.value.replace(/,/g, "")),
		unit: trkForm.unit.value.trim(), warn: trkForm.warn.value.trim(), bad: trkForm.bad.value.trim(), url: trkForm.url.value.trim(),
	};
	if (body.max !== null && !Number.isFinite(body.max)) return ($("#te-err").textContent = "Max is a number.");
	if (kind === "command" && LOCAL) body.command = trkForm.command.value.trim();
	// Empty fields go too: on an edit, "" removes that option (the server merges options into the current ones).
	if (trkPresets[kind]) body.options = Object.fromEntries([...$("#te-params").querySelectorAll("[data-param]")].map((i) => [i.dataset.param, i.value.trim()]));
	try {
		const saved = trkEditing.id
			? await api(`/api/trackers/${trkEditing.id}`, { method: "PATCH", body: JSON.stringify(body) })
			: await api("/api/trackers", { method: "POST", body: JSON.stringify(body) });
		trk = await api(`/api/trackers/${saved.id}`);
		showTrackerView();
		loadTrackers();
		// Read right away, so a wrong command or a missing login shows now rather than in an hour.
		if (kind !== "manual" && !trk.checked_at) refreshTrackerNow();
	} catch (err) { $("#te-err").textContent = err.message; }
});
// Like the item dialog: a click outside closes it (press and release both outside).
let trkPressedOutside = false;
const outsideTrk = (e) => {
	const r = trkDlg.getBoundingClientRect();
	return e.target === trkDlg && (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom);
};
trkDlg.addEventListener("pointerdown", (e) => { trkPressedOutside = outsideTrk(e); });
trkDlg.addEventListener("click", (e) => { if (trkPressedOutside && outsideTrk(e)) trkDlg.close(); trkPressedOutside = false; });

document.addEventListener("error", (e) => {
	const img = e.target;
	if (!(img instanceof HTMLImageElement) || !img.dataset.letter) return;
	const span = document.createElement("span");
	span.className = img.className + " letter";
	span.textContent = img.dataset.letter;
	span.setAttribute("style", img.getAttribute("style") || "");
	img.replaceWith(span);
}, true);
