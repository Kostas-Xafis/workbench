/* ---------- Running a check on a device (checkruns.ts) ---------- */

// A check is something you try on a device, so it runs here one step at a time: Pass or Fail, a few words, photos.
// Every answer is saved on the server as you give it, so you can start on the phone and finish at the desk. The
// view is #check/<ref> (the overview), #check/<ref>/<n> (step n). When the last step is answered, Finish closes
// the check (all passed) or files a bug per failed step and makes the check wait on them.
// Other views open it with openCheckRun(ref).
const ck = { ref: "", data: null, draft: {}, busy: false, sure: false, need: false };
const ckEl = document.createElement("section");
ckEl.id = "check-view";
ckEl.setAttribute("aria-label", "Run a check");
ckEl.hidden = true;
$("#content").append(ckEl);

const CK_IC = {
	back: '<path d="M10 3.5 5.5 8l4.5 4.5" stroke-width="1.8"/>',
	tick: '<path d="M3.5 8.5l3 3 6-7" stroke-width="2"/>',
	cross: '<path d="M4 4l8 8M12 4l-8 8" stroke-width="2"/>',
	camera: '<path d="M2 5.5h2.2l1-1.7h5.6l1 1.7H14v7.5H2z"/><circle cx="8" cy="9" r="2.3"/>',
	image: '<rect x="2" y="3" width="12" height="10" rx="1.5"/><circle cx="5.75" cy="6.5" r="1"/><path d="m2.5 11.5 3-2.75 2.25 2 2.75-3 3 3.25"/>',
};
const ckIc = (n) => `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${CK_IC[n]}</svg>`;
const ckRef = (ref) => String(ref).replace(/^wb-/i, "");

/** Opens the check for running: its overview, or where you left off. Queue mode and others call this. */
function openCheckRun(ref) {
	const h = `#check/${encodeURIComponent(ckRef(ref))}`;
	// From the reader: the check takes its place in the history, so Back goes to where you were before it.
	if (readerOpen()) {
		closeSheet({ nav: false });
		if (/^#item\//.test(location.hash)) { history.replaceState(null, "", location.pathname + location.search + h); return route(); }
	}
	location.hash = h;
}

const ckPlain = (md1) => md(md1).replace(/^<p>|<\/p>$/g, "");
const ckStepAt = () => { const n = Number(location.hash.split("/")[2]); return Number.isInteger(n) && n >= 1 && n <= ck.data.steps.length ? n - 1 : -1; };
const ckFirstOpen = () => { const i = ck.data.results.findIndex((r) => !r.result); return i < 0 ? 0 : i; };
const ckAllDone = () => ck.data.results.every((r) => r.result);
const ckFailed = () => ck.data.results.filter((r) => r.result === "fail");
// The hash moves without the router looking again; the view is drawn from `ck.data`.
function ckGo(seg, replace = false) {
	const h = `#check/${encodeURIComponent(ck.ref)}${seg ? `/${seg}` : ""}`;
	history[replace ? "replaceState" : "pushState"](null, "", location.pathname + location.search + h);
	ck.sure = false;
	ck.need = false;
	ckRender();
	ckMain()?.scrollTo(0, 0);
}
const ckMain = () => ckEl.querySelector(".ck-main");

async function ckLoad(ref) {
	ck.ref = ref;
	ck.draft = {};
	ck.sure = false;
	ck.need = false;
	ckEl.innerHTML = '<div class="ck-wrap"><div class="ck-main"><p class="ck-intro">Loading…</p></div></div>';
	try { ck.data = await api(`/api/items/${encodeURIComponent(ref)}/check`); }
	catch (e) { ck.data = null; toast(e.message); return goBoard(); }
	ckRender();
}

// A call that changes the run: the answer is the run's new state.
async function ckCall(path, method = "POST", body) {
	if (ck.busy) return null;
	ck.busy = true;
	try {
		ck.data = await api(`/api/items/${ck.data.item.id}/check${path}`, { method, ...(body ? { body: JSON.stringify(body) } : {}) });
		return ck.data;
	} catch (e) { toast(e.message); return null; }
	finally { ck.busy = false; }
}

/* ---------- Drawing ---------- */

function ckTop() {
	const d = ck.data, at = ckStepAt();
	const dots = d.finished ? "" : `<div class="ck-dots" role="group" aria-label="Steps">${d.results.map((r, i) =>
		`<button type="button" class="ck-dot ${r.result}${i === at ? " here" : ""}" data-ck-step="${i + 1}" aria-label="Step ${i + 1}${r.result ? `: ${r.result === "pass" ? "passed" : "failed"}` : ""}"></button>`).join("")}</div>`;
	return `<header class="ck-top"><button type="button" class="ck-back" data-ck-back title="Back to the board" aria-label="Back to the board">${ckIc("back")}</button>
		<div class="ck-ttl"><small>wb-${esc(d.item.ref)} · ${esc(projectName(d.item.project))}</small><b>${esc(d.item.title)}</b></div></header>${dots}`;
}

function ckExpect(open) {
	const d = ck.data;
	return (d.right ? `<details class="ck-exp right"${open ? " open" : ""}><summary>What right looks like</summary><div>${md(d.right)}</div></details>` : "") +
		(d.wrong ? `<details class="ck-exp wrong"${open ? " open" : ""}><summary>What wrong looks like</summary><div>${md(d.wrong)}</div></details>` : "");
}

const ckState = (r) => r.result === "pass" ? ckIc("tick") : r.result === "fail" ? ckIc("cross") : "";
const ckWhy = (r) => [r.words, r.images.length ? `${r.images.length} photo${r.images.length > 1 ? "s" : ""}` : ""].filter(Boolean).join(" · ");

function ckOverview() {
	const d = ck.data, closed = d.item.status === "done" || d.item.status === "dropped" || d.item.status === "waiting";
	const n = d.steps.length, answered = d.results.filter((r) => r.result).length, failed = ckFailed().length;
	let group = null;
	const rows = d.results.map((r, i) => {
		const head = r.group && r.group !== group ? `<div class="ck-grp">${esc(r.group)}</div>` : "";
		group = r.group ?? group;
		return `${head}<button type="button" class="ck-row ${r.result}" data-ck-step="${i + 1}"><span class="ck-badge">${ckState(r) || r.n}</span>
			<span class="ck-rt"><span class="t">${ckPlain(r.title)}</span>${ckWhy(r) ? `<small>${esc(ckWhy(r))}</small>` : ""}</span></button>`;
	}).join("");
	const intro = d.item.status === "waiting" ? "This check is waiting on something, so there is nothing to run yet."
		: closed ? "This check is closed."
		: !d.started ? `${n === 1 && !d.steps[0].detail ? "One step" : `${n} step${n > 1 ? "s" : ""}`}. Each one: try it, then Pass or Fail. Your answers are saved as you go, so you can carry on at another device.`
		: `${answered} of ${n} done${failed ? `, ${failed} failed` : ""}. Saved: you can carry on at another device.`;
	let bar = "";
	if (!closed) {
		const go = !d.started ? `<button type="button" class="ck-go" data-ck-step="1">Start</button>`
			: !ckAllDone() ? `<button type="button" class="ck-go" data-ck-step="${ckFirstOpen() + 1}">Continue at step ${ckFirstOpen() + 1}</button>`
			: `<button type="button" class="ck-go${failed ? " fail" : ""}" data-ck-finish>${failed ? `Finish and file ${failed} bug${failed > 1 ? "s" : ""}` : "Finish: all passed"}</button>`;
		const note = ckAllDone() ? `<p class="ck-note">${failed ? "Each failed step becomes a bug for an agent, with your words and photos. This check then waits on them." : "The check is marked done."}</p>` : "";
		bar = `<footer class="ck-bar">${note}${go}${d.started ? `<button type="button" class="ck-link${ck.sure ? " sure" : ""}" data-ck-reset>${ck.sure ? "Tap again to clear every answer" : "Start over"}</button>` : ""}</footer>`;
	}
	return `<div class="ck-wrap">${ckTop()}<div class="ck-main"><p class="ck-intro">${esc(intro)}</p>${ckExpect(false)}<div class="ck-list">${rows}</div></div>${bar}</div>`;
}

function ckStep(at) {
	const d = ck.data, s = d.steps[at], r = d.results[at], n = d.steps.length;
	const words = ck.draft[at] ?? r.words;
	const photos = r.images.map((m) => `<div class="ck-ph"><a href="/api/images/${m.id}" target="_blank" rel="noreferrer"><img src="/api/images/${m.id}" alt="${esc(m.caption)}"></a>
		<button type="button" data-ck-rm="${m.id}" aria-label="Remove this photo">×</button></div>`).join("");
	const last = at === n - 1;
	const detail = s.detail ? `<div class="ck-detail">${md(s.detail)}</div>` : "";
	const need = ck.need && !words.trim() && !r.images.length;
	return `<div class="ck-wrap">${ckTop()}<div class="ck-main">
		<div class="ck-eyebrow"><span>Step ${at + 1} of ${n}</span>${s.group ? `<span class="grp">${esc(s.group)}</span>` : ""}</div>
		<div class="ck-step">${ckPlain(s.title)}</div>${detail}${ckExpect(last)}
		<textarea class="ck-words${need ? " need" : ""}" data-ck-words rows="2" placeholder="A few words (needed if it fails)" aria-label="A few words about this step">${esc(words)}</textarea>
		${need ? '<p class="ck-need">Say what went wrong, or add a photo.</p>' : ""}
		<div class="ck-photos">${photos}<label class="ck-add">${ckIc("camera")}<span>Add photo</span><input type="file" accept="image/*" capture="environment" data-ck-photo></label><label class="ck-add ck-pick">${ckIc("image")}<span>From gallery</span><input type="file" accept="image/*" data-ck-photo></label></div>
	</div>
	<footer class="ck-bar"><div class="ck-nav"><button type="button" data-ck-step="${at}" ${at ? "" : "disabled hidden"}>← Step ${at}</button><button type="button" class="mid" data-ck-over>All steps</button>
		<button type="button" data-ck-step="${at + 2}" ${last ? "disabled hidden" : ""}>Step ${at + 2} →</button></div>
		<div class="ck-btns"><button type="button" class="ck-btn ck-fail${r.result === "pass" ? " off" : ""}" data-ck-set="fail" aria-pressed="${r.result === "fail"}">${ckIc("cross")}Fail</button>
		<button type="button" class="ck-btn ck-pass${r.result === "fail" ? " off" : ""}" data-ck-set="pass" aria-pressed="${r.result === "pass"}">${ckIc("tick")}Pass</button></div></footer></div>`;
}

function ckEnd() {
	const d = ck.data, failed = d.outcome === "failed";
	const bugs = d.bugs.map((b) => `<button type="button" class="ck-bug" data-ck-open="${esc(b.ref)}"><span class="ref">wb-${esc(b.ref)}</span><span>${esc(b.title)}</span></button>`).join("");
	const body = failed
		? `<h2>${d.bugs.length} bug${d.bugs.length > 1 ? "s" : ""} filed</h2><p>${esc(d.summary)} out of ${d.steps.length}.</p>
			<div class="ck-bugs">${bugs}</div>
			<div class="ck-what">Each bug has the step, what should happen, your words and your photos, and is with an agent. This check now waits on them: when they are all finished it comes back to your to-do by itself, to run again.</div>`
		: `<h2>All ${d.steps.length} step${d.steps.length > 1 ? "s" : ""} passed</h2><p>${esc(d.summary)}.</p><div class="ck-what">The check is done.</div>`;
	return `<div class="ck-wrap">${ckTop()}<div class="ck-main"><div class="ck-end"><div class="big${failed ? " fail" : ""}">${ckIc(failed ? "cross" : "tick")}</div>${body}</div></div>
		<footer class="ck-bar"><button type="button" class="ck-go" data-ck-back>Back to the board</button></footer></div>`;
}

function ckRender() {
	if (!ck.data) return;
	const d = ck.data, at = ckStepAt();
	const closedRun = d.finished && d.item.status !== "todo";
	ckEl.innerHTML = closedRun ? ckEnd() : at >= 0 && d.item.status !== "waiting" && d.item.status !== "done" ? ckStep(at) : ckOverview();
}

/* ---------- Doing things ---------- */

const ckStore = () => {
	// What's in the words box isn't sent until Pass or Fail; keep it while you move around.
	const t = ckEl.querySelector("[data-ck-words]");
	const at = ckStepAt();
	if (t && at >= 0) ck.draft[at] = t.value;
};

// Pass or Fail for the step on screen, then on to the next one.
async function ckSet(result) {
	const at = ckStepAt(), words = (ckEl.querySelector("[data-ck-words]")?.value ?? "").trim();
	ck.draft[at] = words;
	if (result === "fail" && !words && !ck.data.results[at].images.length) {
		ck.need = true;
		ckRender();
		ckEl.querySelector("[data-ck-words]")?.focus();
		return;
	}
	if (!await ckCall(`/steps/${at + 1}`, "PUT", { result, words })) return;
	delete ck.draft[at];
	ck.need = false;
	if (at < ck.data.steps.length - 1 && !ck.data.results.slice(at + 1).every((r) => r.result)) ckGo(String(at + 2), true);
	else ckGo("", true);
}

// A photo from the phone's camera or gallery, shrunk here first when it's large (a phone photo is several MB).
const CK_LONG = 2000, CK_KEEP = 1.5 * 1024 * 1024;
async function ckShrink(file) {
	if (file.size <= CK_KEEP && file.type !== "image/heic") return file;
	try {
		const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
		const k = Math.min(1, CK_LONG / Math.max(bmp.width, bmp.height));
		const c = document.createElement("canvas");
		c.width = Math.round(bmp.width * k);
		c.height = Math.round(bmp.height * k);
		c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
		const blob = await new Promise((ok) => c.toBlob(ok, "image/jpeg", 0.85));
		return blob && blob.size < file.size ? blob : file;
	} catch { return file; }
}
const ckRead = (blob) => new Promise((ok, no) => { const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = () => no(r.error); r.readAsDataURL(blob); });

async function ckPhoto(input) {
	const file = input.files?.[0];
	input.value = "";
	if (!file) return;
	const at = ckStepAt();
	ckStore();
	for (const b of ckEl.querySelectorAll(".ck-add")) b.classList.add("busy");
	try {
		const data = await ckRead(await ckShrink(file));
		await ckCall(`/steps/${at + 1}/photos`, "POST", { data });
	} catch (e) { toast(e.message); }
	if (ckStepAt() === at) ckRender();
}

ckEl.addEventListener("click", async (e) => {
	const t = e.target;
	const step = t.closest("[data-ck-step]");
	if (step) { ckStore(); return ckGo(step.dataset.ckStep); }
	if (t.closest("[data-ck-back]")) return goBoard();
	if (t.closest("[data-ck-over]")) { ckStore(); return ckGo(""); }
	const set = t.closest("[data-ck-set]");
	if (set) return ckSet(set.dataset.ckSet);
	const rm = t.closest("[data-ck-rm]");
	if (rm) { ckStore(); if (await ckCall(`/steps/${ckStepAt() + 1}/photos/${rm.dataset.ckRm}`, "DELETE")) ckRender(); return; }
	const open = t.closest("[data-ck-open]");
	if (open) return openItemById(open.dataset.ckOpen).catch((err) => toast(err.message));
	if (t.closest("[data-ck-reset]")) {
		if (!ck.sure) { ck.sure = true; ckRender(); return; }
		ck.sure = false;
		if (await ckCall("/reset")) { ck.draft = {}; ckGo(""); }
		return;
	}
	if (t.closest("[data-ck-finish]")) {
		if (await ckCall("/finish")) { ckGo("", true); loadItems(); }
	}
});
ckEl.addEventListener("change", (e) => { if (e.target.matches("[data-ck-photo]")) ckPhoto(e.target); });
ckEl.addEventListener("input", (e) => {
	if (!e.target.matches("[data-ck-words]")) return;
	ck.draft[ckStepAt()] = e.target.value;
	if (ck.need && e.target.value.trim()) { ck.need = false; e.target.classList.remove("need"); ckEl.querySelector(".ck-need")?.remove(); }
});

views.push({
	name: "check",
	el: "#check-view",
	match: (h) => /^#check\/[^/]+/.test(h),
	title: "Run a check · Workbench",
	async open(hash) {
		const ref = ckRef(decodeURIComponent(hash.split("/")[1] ?? ""));
		if (ref !== ck.ref || !ck.data) await ckLoad(ref);
		else {
			// Back or forward: the run may have moved on at another device.
			try { ck.data = await api(`/api/items/${encodeURIComponent(ref)}/check`); } catch {}
			ckRender();
		}
	},
});

/* ---------- Where it starts ---------- */

// A check for you that can be run now gets "Run it" on its card. In the reader, a check lists its steps with how
// the latest run went on each, and Run it (or Continue) opens the run.
const ckRunnable = (i) => i.kind === "check" && i.owner === "kostas" && (i.status === "todo" || i.status === "doing");
hooks.cardActions.push((i) => ckRunnable(i) && !optionsOf(i).length
	? `<div class="opts card-act"><button type="button" class="opt ck-run" data-ck-run="${esc(i.ref)}" title="Try it step by step: Pass or Fail, photos">Run it</button></div>` : "");
document.addEventListener("click", (e) => {
	const b = e.target.closest("[data-ck-run]");
	if (b) openCheckRun(b.dataset.ckRun);
});

// The latest run of each check the reader showed, by item and its last change: asked for once per change.
const ckSeen = new Map();
const ckFirstOpenOf = (d) => { const n = d.results.findIndex((x) => !x.result); return n < 0 ? 0 : n; };
function ckReaderList(d) {
	let group = null;
	return d.steps.map((s, n) => {
		const r = d.results[n] ?? {};
		const head = s.group && s.group !== group ? `<li class="ck-r-grp">${esc(s.group)}</li>` : "";
		group = s.group ?? group;
		const why = [r.words, r.images?.length ? `${r.images.length} photo${r.images.length > 1 ? "s" : ""}` : ""].filter(Boolean).join(" · ");
		return `${head}<li class="ck-r ${r.result || ""}"><span class="ck-r-mark" aria-label="${r.result === "pass" ? "passed" : r.result === "fail" ? "failed" : "not tried"}">${r.result ? ckIc(r.result === "pass" ? "tick" : "cross") : ""}</span>
			<span class="ck-r-t">${ckPlain(s.title)}${why ? `<small>${esc(why)}</small>` : ""}</span></li>`;
	}).join("");
}
hooks.readerDoc.push({
	slot: "action",
	html(i, r) {
		if (i.kind !== "check" || !i.id || r.compose) return "";
		const key = `${i.id}:${i.updated_at}`;
		const d = ckSeen.get(key);
		if (d === undefined) {
			ckSeen.set(key, null);
			api(`/api/items/${i.id}/check`).then((data) => { ckSeen.set(key, data); r.render(); }).catch(() => ckSeen.set(key, false));
		}
		if (!d) return d === false ? "" : `<div class="ck-read"><span class="rd-label">Steps</span><p class="rd-muted">Loading…</p></div>`;
		const done = d.results.filter((x) => x.result).length, failed = d.results.filter((x) => x.result === "fail").length;
		const said = d.finished ? (d.outcome === "passed" ? "Last run: all passed." : `Last run: ${d.summary}.`)
			: done ? `${done} of ${d.steps.length} done${failed ? `, ${failed} failed` : ""}. Saved: you can carry on at another device.` : "";
		const go = ckRunnable(i) ? `<button type="button" class="ghost" data-ck-run="${esc(i.ref)}">${done && !d.finished ? `Continue at step ${ckFirstOpenOf(d) + 1}` : "Run it"}</button><span class="rd-muted">Step by step: Pass or Fail, a few words, photos. A failed step becomes a bug.</span>` : "";
		return `<div class="ck-read"><span class="rd-label">Steps</span>${said ? `<p class="rd-muted ck-r-state">${esc(said)}</p>` : ""}<ol class="ck-r-list">${ckReaderList(d)}</ol>${go ? `<div class="rd-act-foot">${go}</div>` : ""}</div>`;
	},
});
