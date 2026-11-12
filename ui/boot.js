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
}
start();
// Agents write through the `wb` CLI, so the page polls; it pauses while a dialog is open.
setInterval(() => {
	if (document.visibilityState !== "visible" || dlg.open || linkDlg.open || projDlg.open) return;
	loadSettings();
	if (!$("#settings-view").hidden && !(currentTab().local && !CAN_SHARE)) currentTab().poll?.();
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
}, 10000);
