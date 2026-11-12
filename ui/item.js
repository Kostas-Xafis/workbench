/* ---------- Item dialog ---------- */

const form = $("#form");
const dlg = $("#dlg");
setOptions(form.status, STATUSES);
setOptions(form.kind, KINDS);

function showBodyEditor(edit) {
	form.body.hidden = !edit;
	$("#body-view").hidden = edit;
	$("#edit-body").textContent = edit ? "Preview" : "Edit";
	if (!edit) $("#body-view").innerHTML = md(form.body.value);
	else form.body.focus();
}

function openItem(item) {
	state.current = item;
	const isNew = !item.id;
	setOptions(form.project, state.allProjects.filter((p) => !p.archived_at || p.slug === item.project).map((p) => ({ value: p.slug, label: p.name })));
	for (const k of ["title", "status", "owner", "kind", "priority", "project", "area", "branch", "session", "body"]) form[k].value = item[k] ?? "";
	ownerPicked = false;
	labelOwner();
	const options = optionsOf(item);
	form.options.value = options.join("\n");
	showOptionsField();
	showBodyEditor(isNew);
	pendingImages.forEach((p) => URL.revokeObjectURL(p.url));
	pendingImages = [];
	renderImages();
	$("#answer-box").hidden = isNew || item.kind !== "decision";
	$("#answer-opts").innerHTML = options.map((o) => `<button type="button" class="opt ${o === item.answer ? "picked" : ""}" data-choice="${esc(o)}">${esc(o)}</button>`).join("");
	$("#answer-own").value = item.answer && !options.includes(item.answer) ? item.answer : "";
	const code = state.code[item.ref];
	$("#code-box").hidden = !code;
	if (code) $("#code-box ul").innerHTML = [
		...[...code.prs].sort((a, b) => b.number - a.number).map((pr) => `<li><span><a href="${esc(pr.url)}" target="_blank" rel="noreferrer">PR #${pr.number}</a> ${esc(pr.title)}</span>
			<small class="pr ${pr.state}">${pr.draft ? "draft" : pr.state.toLowerCase()}${pr.review ? ` · ${esc(pr.review.toLowerCase().replaceAll("_", " "))}` : ""}${pr.checks ? ` · checks ${pr.checks}<i class="ck ${pr.checks}"></i>` : ""}</small></li>`),
		...code.commits.map((c) => `<li><code>${c.url ? `<a href="${esc(c.url)}" target="_blank" rel="noreferrer">${esc(c.short)}</a>` : esc(c.short)}</code><span>${esc(c.subject)}</span><small>${esc(c.date)}</small></li>`),
	].join("");
	$("#sources").textContent = item.sources ? `From: ${item.sources}` : "";
	$("#dlg-ref").hidden = !item.ref;
	$("#dlg-ref").textContent = item.ref ? `wb-${item.ref}` : "";
	$("#dlg-ref").dataset.copy = item.ref ? `wb-${item.ref}` : "";
	$("#err").textContent = "";
	$("#act-done").hidden = isNew || item.status === "done";
	$("#act-drop").hidden = isNew || item.status === "dropped";
	const href = sessionHref(item.session || "");
	$("#session-link").hidden = !href;
	if (href) $("#session-link").href = href;
	$("#history").hidden = isNew;
	renderHistory();
	$("#note").value = "";
	hookRun(hooks.itemOpen, item, isNew);
	if (!dlg.open) dlg.showModal();
	if (isNew) form.title.focus();
}

function renderHistory() {
	const item = state.current;
	$("#history ol").innerHTML = (item.notes || []).map((n) => `<li><time title="${esc(n.at)} UTC">${ago(n.at)}</time>${n.author ? `<span class="who">${esc(n.author === "kostas" ? setting("name") || "Kostas" : n.author)}</span>` : ""}${n.text.includes("\n") ? `<div class="note-md">${md(n.text)}</div>` : esc(n.text)}</li>`).join("");
}

/* Pictures on an item: the ones agents attach, and yours, from the button, a paste or a drop. A new item holds
   them until it's saved, since an image needs an item to sit on. Captions edit in place. */
let pendingImages = [];
function renderImages() {
	const saved = (state.current.images || []).map((m) => `<figure><a href="/api/images/${m.id}" target="_blank" rel="noreferrer" title="Open full size"><img src="/api/images/${m.id}" alt="${esc(m.caption)}"${m.width && m.height ? ` width="${m.width}" height="${m.height}"` : ""}></a>
		<figcaption><input class="cap" data-cap="${m.id}" value="${esc(m.caption)}" placeholder="Add a caption" aria-label="Caption"><button type="button" class="rm" data-image="${m.id}">Remove</button></figcaption></figure>`);
	const pending = pendingImages.map((p, n) => `<figure class="${p.busy ? "pending" : ""}"><a href="${p.url}" target="_blank" rel="noreferrer"><img src="${p.url}" alt=""></a>
		<figcaption><input class="cap" data-pending="${n}" value="${esc(p.caption)}" placeholder="Add a caption" aria-label="Caption">${p.busy ? "" : `<button type="button" class="rm" data-unpend="${n}">Remove</button>`}</figcaption></figure>`);
	$("#images").hidden = !saved.length && !pending.length;
	$("#images").innerHTML = [...saved, ...pending].join("");
}
/** Takes an item back from the server after an image change, keeping what you've typed in the form. */
function imagesChanged(item) {
	state.current = { ...state.current, images: item.images, notes: item.notes, image_count: item.image_count };
	renderImages();
	renderHistory();
	loadItems();
}
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
const asDataUrl = (file) => new Promise((ok, no) => {
	const r = new FileReader();
	r.onload = () => ok(r.result);
	r.onerror = () => no(r.error);
	r.readAsDataURL(file);
});
async function uploadImage(itemId, file, caption = "") {
	return api(`/api/items/${itemId}/images`, { method: "POST", body: JSON.stringify({ data: await asDataUrl(file), caption }) });
}
async function addImages(files) {
	files = [...files].filter((f) => IMAGE_TYPES.includes(f.type));
	if (!files.length) { $("#err").textContent = "Only PNG, JPEG, WebP or GIF pictures can go on an item."; return; }
	$("#err").textContent = "";
	if (!state.current.id) {
		pendingImages.push(...files.map((file) => ({ file, url: URL.createObjectURL(file), caption: "" })));
		renderImages();
		return;
	}
	const id = state.current.id;
	const batch = files.map((file) => ({ file, url: URL.createObjectURL(file), caption: "", busy: true }));
	pendingImages.push(...batch);
	renderImages();
	toast(files.length > 1 ? `Adding ${files.length} images…` : "Adding the image…");
	let last;
	for (const p of batch) {
		try {
			last = await uploadImage(id, p.file);
			// A caption typed while it uploaded goes on with it.
			const m = last.images.at(-1);
			if (p.caption.trim() && m) last = await api(`/api/images/${m.id}`, { method: "PATCH", body: JSON.stringify({ caption: p.caption }) });
		} catch (e) { $("#err").textContent = e.message; }
	}
	batch.forEach((p) => URL.revokeObjectURL(p.url));
	if (state.current.id !== id) return;
	pendingImages = pendingImages.filter((p) => !batch.includes(p));
	if (last) imagesChanged(last);
	else renderImages();
}
/** After a new item is saved: its held images go on it, captions and all. */
async function uploadPending(itemId) {
	for (const p of pendingImages) {
		try { await uploadImage(itemId, p.file, p.caption); }
		catch (e) { toast(`An image didn't go on: ${e.message}`); }
	}
}

function formPatch() {
	const p = {};
	for (const k of ["title", "status", "owner", "kind", "project", "area", "branch", "session", "body"]) p[k] = form[k].value;
	p.priority = Number(form.priority.value);
	p.options = form.options.value.split("\n").map((o) => o.trim()).filter(Boolean);
	hookRun(hooks.itemSave, p);
	return p;
}

async function save(extra = {}) {
	try {
		const patch = { ...formPatch(), ...extra };
		if (state.current.id) touched(state.current.id);
		if (state.current.id) await api(`/api/items/${state.current.id}`, { method: "PATCH", body: JSON.stringify(patch) });
		else {
			const { id } = await api("/api/items", { method: "POST", body: JSON.stringify(patch) });
			await uploadPending(id);
		}
		dlg.close();
		await Promise.all([loadItems(), loadProjects()]);
		refreshReport();
	} catch (e) { $("#err").textContent = e.message; }
}

form.addEventListener("submit", (e) => { e.preventDefault(); save(); });
function showOptionsField() { $("#options-field").hidden = form.kind.value !== "decision"; }
form.kind.addEventListener("change", showOptionsField);
// Who acts: the owner "kostas" goes by the name in Settings, and a new item goes to whoever Settings says for its
// kind, following the kind until you pick someone yourself.
let ownerPicked = false;
function labelOwner() { form.owner.querySelector('option[value="kostas"]').textContent = setting("name") || "Kostas"; }
form.owner.addEventListener("change", () => { ownerPicked = true; });
form.kind.addEventListener("change", () => {
	if (!state.current?.id && !ownerPicked) form.owner.value = setting(`owner.${form.kind.value}`) ?? form.owner.value;
});
async function answerFromDialog(text) {
	if (!text.trim() || !state.current?.id) return;
	try { openItem(await answer(state.current.id, text)); } catch (e) { $("#err").textContent = e.message; }
}
$("#answer-opts").addEventListener("click", (e) => {
	const b = e.target.closest("[data-choice]");
	if (b) answerFromDialog(b.dataset.choice);
});
$("#answer-send").onclick = () => answerFromDialog($("#answer-own").value);
$("#answer-own").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); answerFromDialog(e.target.value); } });
$("#cancel").onclick = () => dlg.close();
// Close the task popup on a click outside it. Both press and release must land outside the box,
// so a text selection dragged out of the form doesn't close it.
const outsideDlg = (e) => {
	const r = dlg.getBoundingClientRect();
	return e.target === dlg && (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom);
};
let pressedOutside = false;
dlg.addEventListener("pointerdown", (e) => { pressedOutside = outsideDlg(e); });
dlg.addEventListener("click", (e) => { if (pressedOutside && outsideDlg(e)) dlg.close(); pressedOutside = false; });
$("#edit-body").onclick = () => showBodyEditor(form.body.hidden);
$("#images").addEventListener("click", async (e) => {
	const un = e.target.closest("[data-unpend]");
	if (un) {
		const [p] = pendingImages.splice(Number(un.dataset.unpend), 1);
		URL.revokeObjectURL(p.url);
		return renderImages();
	}
	const b = e.target.closest("[data-image]");
	if (!b || !confirm("Remove this image?")) return;
	try { imagesChanged(await api(`/api/images/${b.dataset.image}`, { method: "DELETE" })); }
	catch (err) { $("#err").textContent = err.message; }
});
$("#images").addEventListener("input", (e) => {
	if (e.target.dataset.pending !== undefined) pendingImages[Number(e.target.dataset.pending)].caption = e.target.value;
});
$("#images").addEventListener("change", async (e) => {
	const id = e.target.dataset.cap;
	if (!id) return;
	try { imagesChanged(await api(`/api/images/${id}`, { method: "PATCH", body: JSON.stringify({ caption: e.target.value }) })); }
	catch (err) { $("#err").textContent = err.message; }
});
// Enter in a caption keeps it, rather than saving and closing the whole item.
$("#images").addEventListener("keydown", (e) => {
	if (e.key === "Enter" && e.target.classList.contains("cap")) { e.preventDefault(); e.target.blur(); }
});
$("#add-image").onclick = () => $("#image-file").click();
$("#image-file").addEventListener("change", (e) => {
	if (e.target.files.length) addImages(e.target.files);
	e.target.value = "";
});
form.addEventListener("paste", (e) => {
	const files = [...(e.clipboardData?.files || [])].filter((f) => IMAGE_TYPES.includes(f.type));
	if (!files.length) return;
	e.preventDefault();
	addImages(files);
});
const dragsFiles = (e) => [...(e.dataTransfer?.types || [])].includes("Files");
form.addEventListener("dragover", (e) => {
	if (!dragsFiles(e)) return;
	e.preventDefault();
	form.classList.add("dropping");
});
form.addEventListener("dragleave", (e) => { if (!form.contains(e.relatedTarget)) form.classList.remove("dropping"); });
form.addEventListener("drop", (e) => {
	form.classList.remove("dropping");
	if (!dragsFiles(e)) return;
	e.preventDefault();
	addImages(e.dataTransfer.files);
});
$("#act-done").onclick = () => save({ status: "done" });
$("#act-drop").onclick = () => save({ status: "dropped" });
async function addNote() {
	const text = $("#note").value.trim();
	if (!text || !state.current?.id) return;
	try { openItem(await api(`/api/items/${state.current.id}/notes`, { method: "POST", body: JSON.stringify({ text }) })); }
	catch (e) { $("#err").textContent = e.message; }
}
$("#add-note").onclick = addNote;
$("#note").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); addNote(); } });

$("#new").onclick = () => openItem({
	title: "", status: "todo", owner: setting("owner.task") ?? "agent", kind: "task", priority: 2,
	project: state.project || state.report?.project || state.projects[0]?.slug || "", area: "", branch: "", session: "", body: "",
});
