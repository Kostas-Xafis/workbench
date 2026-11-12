async function afterProjectChange() {
	await Promise.all([loadSettingsProjects(), loadProjects()]);
	if (!$("#welcome-view").hidden) { wlFolders(); setupLoad(); }
	renderRail();
	loadItems();
	loadRepos();
	loadCode();
}
async function saveProject(slug, patch) {
	try {
		await api(`/api/projects/${encodeURIComponent(slug)}`, { method: "PATCH", body: JSON.stringify(patch) });
		await afterProjectChange();
		return true;
	} catch (err) {
		toast(err.message);
		return false;
	}
}
async function moveProject(slug, dir) {
	const order = settings.projects.filter((p) => !p.archived_at).map((p) => p.slug);
	const i = order.indexOf(slug), j = i + (dir === "up" ? -1 : 1);
	if (i < 0 || j < 0 || j >= order.length) return;
	[order[i], order[j]] = [order[j], order[i]];
	try {
		await api("/api/project-order", { method: "PUT", body: JSON.stringify({ slugs: order }) });
		await afterProjectChange();
		// Keep the keyboard on the row that moved, on the other arrow once it reaches an end.
		const row = $(`#settings-view [data-slug="${CSS.escape(slug)}"]`);
		const btn = row?.querySelector(`[data-act="${dir}"]`);
		(btn && !btn.disabled ? btn : row?.querySelector(`[data-act="${dir === "up" ? "down" : "up"}"]`))?.focus();
	} catch (err) { toast(err.message); }
}

let projNameTouched = false, projSlugTouched = false;
async function openProjectDlg(p) {
	currentProj = p;
	const isNew = !p;
	$("#proj-title").textContent = isNew ? "Add a project" : `Edit ${p.name}`;
	projForm.path.value = p?.path ?? "";
	projForm.name.value = p?.name ?? "";
	projForm.slug.value = p?.slug ?? "";
	projForm.slug.readOnly = !isNew;
	projForm.icon.value = p?.icon ?? "";
	projNameTouched = projSlugTouched = !isNew;
	$("#proj-icon-field").hidden = isNew;
	$("#proj-hint").textContent = isNew
		? "The slug names the project in commands (wb ls --project my-app) and can't change later. Items you add from inside the folder belong to it."
		: "The slug stays as it is: items, reports and links point at it. For the logo, give a file in the repo, or leave it empty to have one found.";
	$("#proj-archive").hidden = isNew;
	$("#proj-archive").textContent = p?.archived_at ? "Unarchive" : "Archive";
	$("#proj-remove").hidden = isNew || Object.values(p.usage).some(Boolean);
	$("#proj-err").textContent = "";
	$("#proj-suggest").hidden = true;
	projDlg.showModal();
	(isNew ? projForm.path : projForm.name).focus();
	if (!isNew) return;
	try { settings.folders = await api("/api/settings/folders"); } catch { settings.folders = []; }
	if (!projDlg.open || currentProj) return;
	$("#proj-suggest .chips").innerHTML = settings.folders.map((f, i) => `<button type="button" class="chip" data-folder="${i}" title="${esc(f.path)}">${esc(f.name)}</button>`).join("");
	$("#proj-suggest").hidden = !settings.folders.length;
}
$("#proj-suggest").addEventListener("click", (e) => {
	const f = settings.folders[Number(e.target.closest("[data-folder]")?.dataset.folder)];
	if (!f) return;
	projForm.path.value = f.path;
	projForm.name.value = f.name;
	projForm.slug.value = f.slug;
	projNameTouched = projSlugTouched = false;
	projForm.name.focus();
	projForm.name.select();
});
// A new project's name follows its folder, and its slug its name, until either is typed in.
projForm.path.addEventListener("input", () => {
	if (currentProj || projNameTouched) return;
	projForm.name.value = projForm.path.value.trim().replace(/\/+$/, "").split("/").pop() ?? "";
	if (!projSlugTouched) projForm.slug.value = slugify(projForm.name.value);
});
projForm.name.addEventListener("input", () => {
	projNameTouched = true;
	if (!currentProj && !projSlugTouched) projForm.slug.value = slugify(projForm.name.value);
});
projForm.slug.addEventListener("input", () => { projSlugTouched = true; });
projForm.addEventListener("submit", async (e) => {
	e.preventDefault();
	const p = currentProj;
	const body = { name: projForm.name.value.trim(), path: projForm.path.value.trim() };
	if (p) body.icon = projForm.icon.value.trim();
	else body.slug = projForm.slug.value.trim();
	try {
		if (p) await api(`/api/projects/${encodeURIComponent(p.slug)}`, { method: "PATCH", body: JSON.stringify(body) });
		else await api("/api/projects", { method: "POST", body: JSON.stringify(body) });
		projDlg.close();
		await afterProjectChange();
		if (!p) toast(`${body.name} is on the board`);
		if (!p || body.path !== p.path) checkHealth();
	} catch (err) { $("#proj-err").textContent = err.message; }
});
$("#proj-archive").onclick = async () => {
	const p = currentProj;
	if (!p.archived_at && p.open && !confirm(`Archive ${p.name}? Its ${p.open} open item${p.open === 1 ? "" : "s"} leave the board with it (search still finds them), and its trackers stop reading. New work for it brings it back.`)) return;
	if (!(await saveProject(p.slug, { archived: !p.archived_at }))) return;
	projDlg.close();
	toast(p.archived_at ? `${p.name} is back on the board` : `${p.name} archived`);
};
$("#proj-remove").onclick = async () => {
	const p = currentProj;
	if (!confirm(`Remove ${p.name} from the workbench? Nothing points at it, and its folder isn't touched.`)) return;
	try {
		await api(`/api/projects/${encodeURIComponent(p.slug)}`, { method: "DELETE" });
		projDlg.close();
		await afterProjectChange();
	} catch (err) { $("#proj-err").textContent = err.message; }
};
$("#proj-cancel").onclick = () => projDlg.close();
// Every control with data-setting / data-pref saves itself when it changes.
$("#settings-view").addEventListener("change", (e) => {
	const el = e.target.closest("[data-setting], [data-pref]");
	if (!el) return;
	let v;
	try { v = readControl(el); } catch { return toast("That value doesn't read right"); }
	if (el.dataset.setting) {
		if (!canChangeBoard()) { renderSettings(); return toast("Board settings change only on this computer"); }
		saveSetting(el.dataset.setting, v);
	} else setPref(el.dataset.pref, v);
});
$("#settings-view").addEventListener("click", (e) => {
	const r = e.target.closest("[data-reset]");
	if (r) {
		const [kind, key] = r.dataset.reset.split(/:(.*)/s);
		return kind === "setting" ? saveSetting(key, null) : setPref(key, null);
	}
});
$("#settings-view").addEventListener("click", (e) => {
	const b = e.target.closest("[data-act], [data-tracker]");
	if (!b) return;
	if (b.dataset.tracker) return openTracker(Number(b.dataset.tracker));
	const slug = b.closest("[data-slug]")?.dataset.slug;
	const p = settings.projects?.find((x) => x.slug === slug);
	if (b.dataset.act === "board") goBoard();
	else if (b.dataset.act === "add") openProjectDlg(null);
	else if (b.dataset.act === "edit" && p) openProjectDlg(p);
	else if (b.dataset.act === "check") checkHealth();
	else if (b.dataset.act === "unarchive") saveProject(slug, { archived: false }).then((ok) => ok && toast(`${p?.name ?? slug} is back on the board`));
	else if (b.dataset.act === "up" || b.dataset.act === "down") moveProject(slug, b.dataset.act);
});
