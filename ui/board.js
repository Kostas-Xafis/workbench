/* ---------- Board ---------- */

const optionsOf = (i) => { try { const l = JSON.parse(i.options || "[]"); return Array.isArray(l) ? l.map(String) : []; } catch { return []; } };
// The newest pull request and the commit count for an item, from /api/code.
function codeMeta(i) {
	const c = state.code[i.ref];
	if (!c) return "";
	const pr = [...c.prs].sort((a, b) => b.number - a.number)[0];
	return (pr ? `<span class="pr ${pr.state}" title="${esc(pr.title)}">PR #${pr.number} ${pr.draft ? "draft" : pr.state.toLowerCase()}${pr.checks ? `<i class="ck ${pr.checks}" title="checks ${pr.checks}"></i>` : ""}</span>` : "") +
		(c.commits.length ? `<span class="code-tag" title="Commits that mention wb-${i.ref}">${glyph("commit")}${c.commits.length} commit${c.commits.length > 1 ? "s" : ""}</span>` : "");
}

function card(i, { tick = i.owner === "kostas" && OPEN.includes(i.status), kind = false } = {}) {
	const closed = !OPEN.includes(i.status);
	const options = !closed && i.owner === "kostas" ? optionsOf(i) : [];
	const meta = [
		`<button class="ref" data-copy="wb-${i.ref}" title="Copy wb-${i.ref}">wb-${i.ref}</button>`,
		kind ? `<span class="kind k-${i.kind}">${i.kind}</span>` : "",
		!closed && state.who === "all" ? `<span class="owner ${i.owner}">${i.owner === "kostas" ? "you" : "agent"}</span>` : "",
		i.priority === 1 && !closed ? `<span class="p1">P1</span>` : "",
		i.status === "doing" || i.status === "waiting" ? `<span class="st-${i.status}">${glyph(i.status === "doing" ? "play" : "pause")}${i.status}</span>` : "",
		i.area ? `<span>${esc(i.area)}</span>` : "",
		!state.project ? `<span>${esc(projectName(i.project))}</span>` : "",
		i.branch ? `<span>⎇ ${esc(i.branch)}</span>` : "",
		i.answer ? `<span class="answered" title="Your answer">→ ${esc(i.answer)}</span>` : "",
		i.image_count ? `<span class="img-tag" title="${i.image_count} image${i.image_count > 1 ? "s" : ""}">${glyph("image")}${i.image_count}</span>` : "",
		codeMeta(i),
		hookHtml(hooks.cardMeta, i),
		closed && i.done_at ? `<span>${ago(i.done_at)}</span>` : "",
	].join("");
	return `<article class="card ${i.status} ${closed ? "closed" : ""}" data-id="${i.id}">
		${tick ? `<button class="tick" data-tick="${i.id}" title="Mark done" aria-label="Mark done">✓</button>` : ""}
		<div class="main"><div class="title">${esc(i.title)}</div><div class="meta">${meta}</div>
		${options.length ? `<div class="opts">${options.map((o) => `<button class="opt" data-answer="${i.id}" data-choice="${esc(o)}" title="Answer: ${esc(o)}">${esc(o)}</button>`).join("")}</div>` : ""}</div></article>`;
}

const section = (key, def, summary, body) =>
	`<details class="sec fold" data-key="${key}"${isOpen(key, def)}><summary>${summary}</summary>${body}</details>`;
const cards = (list, opts) => `<div class="cards">${list.map((i) => card(i, opts)).join("")}</div>`;

function repoWarnings(r) {
	return [
		r.dirty.length && `${r.dirty.length} uncommitted`,
		r.ahead && `${r.ahead} unpushed`,
		r.behind && `${r.behind} behind`,
		r.unmerged.length && `${r.unmerged.length} unmerged branch${r.unmerged.length > 1 ? "es" : ""}`,
		r.worktrees.length && `${r.worktrees.length} worktree${r.worktrees.length > 1 ? "s" : ""}`,
	].filter(Boolean);
}
function repoCard(r) {
	if (!r.ok) return `<div class="repo"><b>${esc(projectName(r.project))}</b><span class="facts">${esc(r.error)}</span></div>`;
	const warns = repoWarnings(r);
	const detail = [
		r.dirty.length ? "Uncommitted:\n" + r.dirty.join("\n") : "",
		r.unmerged.length ? "Unmerged:\n" + r.unmerged.map((b) => `${b.name}  (${b.date})`).join("\n") : "",
		r.worktrees.length ? "Worktrees:\n" + r.worktrees.map((w) => `${w.branch}  ${w.path}`).join("\n") : "",
	].filter(Boolean).join("\n\n");
	return `<div class="repo"><div><b>${esc(projectName(r.project))}</b><span class="facts">⎇ ${esc(r.branch || "detached")}</span>
		${warns.length ? warns.map((w) => `<span class="warn">${w}</span>`).join("") : `<span class="facts"> · clean</span>`}</div>
		<div class="last">${esc(r.lastCommit)}</div>
		${detail ? `<details data-key="repo-${r.project}"${isOpen(`repo-${r.project}`)}><summary class="facts">details</summary><pre>${esc(detail)}</pre></details>` : ""}</div>`;
}

function renderBoard() {
	const open = state.items.filter((i) => OPEN.includes(i.status));
	const counts = { all: open.length, kostas: open.filter((i) => i.owner === "kostas").length, agent: open.filter((i) => i.owner === "agent").length };
	paint($("#who"), WHO.map(([k, label]) => `<button data-who="${k}" aria-pressed="${k === state.who}">${label}<span class="n">${counts[k]}</span></button>`).join(""));
	const mineOnly = (i) => state.who === "all" || i.owner === state.who;
	const shown = open.filter(mineOnly);

	let html = sectionOrder().map(([kind, label, def]) => {
		const list = shown.filter((i) => i.kind === kind);
		if (!list.length) return "";
		const mine = list.filter((i) => i.owner === "kostas").length;
		const doing = list.filter((i) => i.status === "doing").length;
		const p1 = list.filter((i) => i.priority === 1).length;
		const sub = [state.who === "all" && mine ? `${mine} on you` : "", doing ? `${doing} in progress` : "", p1 ? `<span class="p1">${p1} P1</span>` : ""].filter(Boolean).join(" · ");
		// Later (P3) items fold away so what matters now stays on screen.
		const later = list.filter((i) => i.priority === 3);
		return section(`sec-${kind}`, def, `${kindIcon(kind)}${label}<span class="count">${list.length}</span>${sub ? `<span class="sub">${sub}</span>` : ""}${hookHtml(hooks.sectionMeta, kind, list)}`,
			cards(list.filter((i) => i.priority < 3)) +
			(later.length ? `<details class="later fold" data-key="later-${kind}"${isOpen(`later-${kind}`)}><summary>${later.length} later</summary>${cards(later)}</details>` : ""));
	}).join("") || boardEmpty(open.length);
	html = hookHtml(hooks.boardTop, shown) + html + hookHtml(hooks.boardEnd, shown);

	const cutoff = Date.now() - 14 * 86400e3;
	const done = state.items.filter((i) => !OPEN.includes(i.status) && mineOnly(i) && i.done_at && parseTime(i.done_at) > cutoff)
		.sort((a, b) => b.done_at.localeCompare(a.done_at));
	if (done.length) html += section("sec-done", false, `<span class="k-done">${glyph("check")}</span>Done lately<span class="count">${done.length}</span><span class="sub">last 14 days</span>`,
		cards(done.slice(0, 12), { kind: true }) +
		(done.length > 12 ? `<details class="more fold" data-key="done-more"${isOpen("done-more")}><summary>${done.length - 12} more</summary>${cards(done.slice(12), { kind: true })}</details>` : ""));

	const repos = state.repos.filter((r) => !state.project || r.project === state.project);
	if (repos.length) {
		const one = state.project && repos.length === 1 ? repos[0] : null;
		const attention = repos.filter((r) => !r.ok || repoWarnings(r).length).length;
		const sub = one
			? (one.ok ? `⎇ ${esc(one.branch || "detached")}${repoWarnings(one).map((w) => `<span class="warn">${w}</span>`).join("") || " · clean"}` : esc(one.error))
			: attention ? `${attention} need attention` : "all clean";
		html += section("sec-repo", false, `<span class="k-repo">${glyph("commit")}</span>${one ? "Repository" : "Repositories"}${one ? "" : `<span class="count">${repos.length}</span>`}<span class="sub">${sub}</span>`,
			`<div class="repos">${repos.map(repoCard).join("")}</div>`);
	}
	paint($("#sections"), html);
	renderSetupCard();
	syncFoldToggle();
	$("#areas").innerHTML = [...new Set(state.items.map((i) => i.area).filter(Boolean))].sort().map((a) => `<option value="${esc(a)}">`).join("");
}

async function loadItems() {
	const items = await api(`/api/items${state.project ? `?project=${encodeURIComponent(state.project)}` : ""}`);
	state.items = state.project ? items : items.filter((i) => !isArchived(i.project));
	renderBoard();
}
async function loadRepos() {
	state.repos = await api("/api/git");
	renderBoard();
}
async function loadCode() {
	state.code = await api(`/api/code${state.project ? `?project=${encodeURIComponent(state.project)}` : ""}`);
	renderBoard();
}

// Items this tab just changed, so it doesn't notify about its own doing.
const localChanges = new Map();
const touched = (id) => localChanges.set(Number(id), Date.now());
async function answer(id, text) {
	touched(id);
	const item = await api(`/api/items/${id}/answer`, { method: "POST", body: JSON.stringify({ answer: text }) });
	await Promise.all([loadItems(), loadProjects()]);
	refreshReport();
	return item;
}

$("#who").addEventListener("click", (e) => {
	const b = e.target.closest("[data-who]");
	if (!b) return;
	state.who = b.dataset.who;
	localSet("who", state.who);
	renderBoard();
});
// One button for every section: it folds them all while any is open, and opens them all once all are folded.
const FOLD_IC = { fold: '<path d="m4.5 2.5 3.5 3.5 3.5-3.5M4.5 13.5 8 10l3.5 3.5"/>', open: '<path d="m4.5 6 3.5-3.5L11.5 6M4.5 10l3.5 3.5 3.5-3.5"/>' };
const anySectionOpen = () => [...document.querySelectorAll("#sections details.sec")].some((d) => d.open);
function syncFoldToggle() {
	const b = $("#fold-toggle");
	const fold = anySectionOpen();
	const label = fold ? "Fold all sections" : "Open all sections";
	if (b.title === label) return;
	b.title = label;
	b.setAttribute("aria-label", label);
	b.querySelector("svg g").innerHTML = FOLD_IC[fold ? "fold" : "open"];
}
$("#fold-toggle").onclick = () => {
	const open = !anySectionOpen();
	for (const d of document.querySelectorAll("#sections details.sec")) d.open = open;
	syncFoldToggle();
};
// A section folded or opened by hand changes what the button does next.
document.addEventListener("toggle", (e) => { if (e.target.matches?.("#sections details.sec")) syncFoldToggle(); }, true);

$("#sections").addEventListener("click", async (e) => {
	const opt = e.target.closest("[data-answer]");
	if (opt) {
		e.stopPropagation();
		opt.classList.add("picked");
		return answer(opt.dataset.answer, opt.dataset.choice).catch((err) => toast(err.message));
	}
	const tick = e.target.closest("[data-tick]");
	if (tick) {
		e.stopPropagation();
		touched(tick.dataset.tick);
		await api(`/api/items/${tick.dataset.tick}`, { method: "PATCH", body: JSON.stringify({ status: "done" }) });
		return Promise.all([loadItems(), loadProjects()]);
	}
	const c = e.target.closest(".card");
	if (c) openItem(await api(`/api/items/${c.dataset.id}`));
});
