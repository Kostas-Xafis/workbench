/* ---------- The kit: what every view draws with (kit.css; docs/development.md, "The board's page") ---------- */

// A kind is a small neutral glyph, never a colour: colour is kept for state (--st-*, base.css).
const KIND_GLYPH = {
	decision: '<path d="M8 14.25V8.75L4 4.25M8 8.75l4-4.5M3.75 7.25V4h3.25M12.25 7.25V4H9"/>',
	setup: '<path d="M10.6 2.1a3.4 3.4 0 0 0-3.9 4.5L2.3 11a1.5 1.5 0 0 0 2.1 2.1l4.4-4.4a3.4 3.4 0 0 0 4.5-3.9l-2.1 2.1-1.9-.3-.3-1.9z"/>',
	check: '<rect x="4.25" y="1.75" width="7.5" height="12.5" rx="1.75"/><path d="M6.3 7.9l1.3 1.3 2.2-2.5M7.25 12.1h1.5"/>',
	review: '<path d="M1.75 8S4.25 3.75 8 3.75 14.25 8 14.25 8 11.75 12.25 8 12.25 1.75 8 1.75 8z"/><circle cx="8" cy="8" r="1.9"/>',
	bug: '<path d="M6.2 5.9a1.8 1.8 0 0 1 3.6 0M6.6 4.3 5.7 2.7M9.4 4.3l.9-1.6"/><rect x="4.75" y="5.75" width="6.5" height="8" rx="3.25"/><path d="M8 8.25v5.5M4.75 9.5H2.4M11.25 9.5h2.35M5 7.2 3.4 5.9M11 7.2l1.6-1.3M5.1 12.2l-1.7 1.3M10.9 12.2l1.7 1.3"/>',
	task: '<path d="M5.25 4.5 1.75 8l3.5 3.5M10.75 4.5 14.25 8l-3.5 3.5M9.1 3 6.9 13"/>',
	notice: '<circle cx="8" cy="8" r="6.25"/><path d="M8 7.4v3.85M8 4.9v.05"/>',
	idea: '<path d="M6.25 11.25c0-1.1-.5-1.8-1.2-2.5a4 4 0 1 1 5.9 0c-.7.7-1.2 1.4-1.2 2.5zM6.5 13.75h3"/>',
};
/** The kind's glyph, inline SVG in the muted colour (16 px; `.kg` sizes it). Its title is the kind, for a tooltip. */
const kindGlyph = (kind) => `<span class="kg" title="${esc(kind)}"><svg class="gl" viewBox="0 0 16 16" aria-hidden="true">${KIND_GLYPH[kind] ?? KIND_GLYPH.task}</svg></span>`;
// The older name, still used by files the rework hasn't reached.
const kindIcon = kindGlyph;

/** A small label in a state's colour: state is "yours", "running", "stuck", "failed", "done", or nothing (neutral). */
const chip = (text, state) => `<span class="chip${state ? ` st-${state}` : ""}">${esc(text)}</span>`;

/** What a list says when it has nothing: a title, a line of text, and optionally an action (HTML, e.g. a button). */
const emptyState = (title, text = "", action = "") =>
	`<div class="k-empty"><b>${esc(title)}</b>${text ? `<p>${esc(text)}</p>` : ""}${action ? `<div class="k-empty-act">${action}</div>` : ""}</div>`;

/**
 * The meta line of an item's row: project · area · recommends: X · unblocks N · age. `project: false` leaves the
 * project out (a list of one project's items).
 */
function rowMeta(i, { project = true } = {}) {
	const rec = i.kind === "decision" && typeof askRecommends === "function" ? askRecommends(i) : "";
	return [
		project && i.project ? esc(projectName(i.project)) : "",
		i.area ? esc(i.area) : "",
		rec ? `recommends: <b>${esc(rec)}</b>` : "",
		i.unblocks > 0 ? `unblocks ${i.unblocks}` : "",
		i.created_at ? esc(ago(i.created_at, { short: true })) : "",
	].filter(Boolean).join(" · ");
}
/**
 * One item as a row: its kind's glyph, the title (two lines at most), one meta line, and a slot on the right.
 * Rows, not cards. `meta`: the meta line as HTML (default rowMeta(item)); `right`: HTML for the right slot (a chip,
 * an age, a button); `selected`: drawn as the one picked. The row is an option (role="option") with the item's id and
 * ref on it (data-id, data-ref): put rows in a role="listbox" element and handle clicks and keys in the view.
 */
function row(i, { meta, right = "", selected = false } = {}) {
	return `<div class="k-row${selected ? " is-sel" : ""}" role="option" aria-selected="${selected}" tabindex="${selected ? 0 : -1}" data-id="${i.id}" data-ref="${esc(i.ref ?? "")}">
		${kindGlyph(i.kind)}<div class="k-main"><div class="k-title">${esc(i.title)}</div><div class="k-meta">${meta ?? rowMeta(i)}</div></div>${right ? `<div class="k-right">${right}</div>` : ""}</div>`;
}

/**
 * Draws a list in `el` that changes only where it must: one child per item, keyed by keyFn(item) (a string), each
 * drawn by renderFn(item) → HTML for exactly one element. A child whose HTML is the same as last time is left as it
 * is, so focus, a text selection and the scroll position stay; one whose HTML changed is replaced (and gets the focus
 * back if it had it); children are moved only when the order changed, and the ones whose item went are removed.
 * Headers and other lines go in as items of their own, with their own keys. Returns `el`.
 */
function keyedList(el, items, keyFn, renderFn) {
	const old = new Map();
	for (const c of [...el.children]) {
		if (c.dataset.key !== undefined) old.set(c.dataset.key, c);
		else c.remove();
	}
	let at = el.firstElementChild;
	const seen = new Set();
	for (const item of items) {
		const key = String(keyFn(item));
		if (seen.has(key)) { console.warn("keyedList: two items with the key", key); continue; }
		seen.add(key);
		const html = renderFn(item);
		let node = old.get(key);
		if (!node || node._html !== html) {
			const t = document.createElement("template");
			t.innerHTML = html.trim();
			const fresh = t.content.firstElementChild ?? document.createElement("div");
			fresh.dataset.key = key;
			fresh._html = html;
			if (node) {
				const hadFocus = node.contains(document.activeElement);
				node.replaceWith(fresh);
				if (hadFocus) (fresh.matches("[tabindex], a, button, input, textarea, select") ? fresh : fresh.querySelector("[tabindex], a, button, input, textarea, select") ?? fresh).focus({ preventScroll: true });
				if (at === node) at = fresh;
			}
			old.set(key, fresh);
			node = fresh;
		}
		if (node !== at) el.insertBefore(node, at);
		else at = at.nextElementSibling;
	}
	for (const [key, node] of old) if (!seen.has(key)) node.remove();
	return el;
}

/**
 * Asks yes or no in the page, in place of the browser's confirm(): resolves true for yes, false for no, Escape or a
 * click outside. `anchorOrText` is the question as text (a box in the middle of the window), or an element the
 * question sits beside (then the question is `text`). `yes` and `no` are the buttons' words; `danger` draws yes in
 * the failed colour. It goes over open dialogs too (the reader), being one itself.
 *   if (!(await confirmIn(`Delete "${l.label}"?`, { yes: "Delete", danger: true }))) return;
 *   if (!(await confirmIn(button, { text: "Remove this picture?", yes: "Remove" }))) return;
 */
function confirmIn(anchorOrText, { text, yes = "OK", no = "Cancel", danger = false } = {}) {
	const anchor = anchorOrText instanceof Element ? anchorOrText : null;
	const question = anchor ? text ?? "Are you sure?" : String(anchorOrText);
	const dlg = document.createElement("dialog");
	dlg.className = `k-confirm${anchor ? " k-anchored" : ""}`;
	dlg.innerHTML = `<form method="dialog"><p>${esc(question)}</p><div class="k-confirm-row"><button type="submit" class="ghost" value="no">${esc(no)}</button>
		<button type="submit" class="primary${danger ? " k-danger" : ""}" value="yes">${esc(yes)}</button></div></form>`;
	document.body.append(dlg);
	return new Promise((resolve) => {
		// Settled from the click itself: the dialog's own close event can come late (or not at all in a page the app hides).
		let done = false;
		const finish = (answer) => {
			if (done) return;
			done = true;
			if (dlg.open) dlg.close();
			dlg.remove();
			resolve(answer);
		};
		dlg.querySelector("form").addEventListener("submit", (e) => { e.preventDefault(); finish(e.submitter?.value === "yes"); });
		dlg.addEventListener("cancel", (e) => { e.preventDefault(); finish(false); });
		dlg.addEventListener("click", (e) => { if (e.target === dlg) finish(false); });
		dlg.addEventListener("close", () => finish(false));
		dlg.showModal();
		if (anchor) {
			const a = anchor.getBoundingClientRect(), w = dlg.offsetWidth, h = dlg.offsetHeight;
			const below = a.bottom + 6 + h < innerHeight;
			dlg.style.left = `${Math.max(8, Math.min(a.right - w, innerWidth - w - 8))}px`;
			dlg.style.top = `${below ? a.bottom + 6 : Math.max(8, a.top - h - 6)}px`;
		}
		dlg.querySelector('[value="yes"]').focus();
	});
}
