async function start() {
	if (solo) {
		document.body.classList.add("solo");
		$("#r-back").hidden = true;
		$("#r-home").hidden = false;
	}
	await Promise.all([loadProjects(), loadSettings()]);
	renderRail();
	await Promise.all([loadItems(), loadLinks(), loadReports(), loadSources(), loadTrackers()]);
	route();
	renderNotify();
	loadRepos();
	loadCode();
	notifyCheck().catch(() => {});
	updLoad().catch(() => {});
	maybeWelcome();
	hookRun(hooks.start);
}
start();
// Agents write through the `wb` CLI, so the page polls; it pauses while a form dialog is open (not the reader, which
// takes what changed: ui/reader.js).
setInterval(() => {
	if (document.visibilityState !== "visible" || linkDlg.open || projDlg.open) return;
	loadSettings();
	if (!$("#settings-view").hidden && !(currentTab().local && !OWNER) && !(currentTab().computer && CLOUD)) currentTab().poll?.();
	loadProjects();
	loadItems();
	loadRepos();
	loadCode();
	loadReports();
	loadSources();
	loadTrackers();
	refreshReport();
	// The setup guide's checks, while something shows them (the guide polls faster by itself on the steps that wait).
	if (setupCardShown() || (Date.now() - setup.at > 30e3 && $("#sections .empty-card"))) setupLoad();
	hookRun(hooks.refresh);
}, 10000);
