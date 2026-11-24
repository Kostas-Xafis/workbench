/* ---------- Settings → You and your day (tab "you") ---------- */
// Owned by the "You and your day" section. render returns the tab's HTML; load runs when the tab opens; poll every 10 s.
// Board settings: `name` (what people and agents read for the owner "kostas", which stays as it is in the data),
// `day.start` (the hour a work day turns over, for day pages) and `owner.<kind>` (who gets a new item of that kind).
const YOU_KIND_HINT = {
	decision: "A question only you can answer",
	setup: "Accounts, consoles, stores",
	check: "Trying something on a device",
	review: "Reading a wording or a design",
	notice: "What changed, for you to see",
	bug: "Something broken",
	task: "Code work",
	idea: "Later, maybe",
};
let youError = "";
const youName = () => setting("name") || "Kostas";
const youTime = (t) => t.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
// The work day it is now with this start hour, worked out like day.ts does: before the hour, it's still the day before.
function youToday(hour) {
	const d = new Date(Date.now() - hour * 3600e3);
	const from = new Date(d.getFullYear(), d.getMonth(), d.getDate(), hour);
	const to = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, hour);
	const at = (t) => `${t.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" })}, ${youTime(t)}`;
	return `Today runs from ${at(from)} to ${at(to)}`;
}
function setYouRender() {
	if (!Object.keys(state.settingDefs).length) return youError ? `<p class="error">${esc(youError)}</p>` : `<div class="set-empty">Loading…</div>`;
	const name = youName();
	const hour = Number(setting("day.start"));
	const hours = Array.from({ length: 24 }, (_, h) => [h, youTime(new Date(2000, 0, 1, h))]);
	const owners = SECTIONS.map(([kind, label]) => optRow({
		label: `${kindIcon(kind)}${esc(label)}`,
		hint: esc(YOU_KIND_HINT[kind] ?? ""),
		bind: { setting: `owner.${kind}` },
		control: `<span class="you-owner">${ctlRadios({ setting: `owner.${kind}` }, [["kostas", name], ["agent", "An agent"]], { label: `Who gets a new ${kind}` })}</span>`,
	}));
	return `<div class="you-tab"><p class="set-intro">Who the board is for, when your day turns over, and who new work goes to.</p>
		${optGroup("You", [optRow({
			label: "Your name",
			hint: "What agents, the <code>wb</code> command and day pages call you. In commands you stay <code>--owner kostas</code>.",
			bind: { setting: "name" },
			control: ctlText({ setting: "name" }, { placeholder: "Kostas", maxlength: 40, label: "Your name" }),
		})])}
		${optGroup("Your day", [optRow({
			label: "A work day starts at",
			hint: `Until then, late nights count as the day before. Applies from the next day page on; pages already made keep their hours.<span class="you-today" aria-live="polite">${esc(youToday(hour))}</span>`,
			bind: { setting: "day.start" },
			control: ctlSelect({ setting: "day.start" }, hours, { label: "A work day starts at" }),
		})])}
		${optGroup("Who gets new items", owners, "When nobody says who acts: the New button, agents and <code>wb add</code>. Items already on the board stay with whoever has them.")}
		${optGroup("Asks that don't block", [optRow({
			label: "A default goes ahead after",
			hint: "When an agent leaves a decision, review or notice with what happens if you say nothing, and no date. Then it goes ahead as if you had picked it; a notice closes as seen. 0: only on a date the agent gives.",
			bind: { setting: "asks.days" },
			control: ctlNumber({ setting: "asks.days" }, { min: 0, max: 60, unit: "days", label: "A default goes ahead after this many days (0 to 60)" }),
		}), optRow({
			label: "Open asks per project",
			hint: "At most this many decisions, reviews, checks and setup steps from agents wait on you in a project. Past it, agents are asked to bundle questions, send a notice or decide with a default. Your own items and P1s always go on. 0: no limit.",
			bind: { setting: "asks.cap" },
			control: ctlNumber({ setting: "asks.cap" }, { min: 0, max: 500, unit: "asks", label: "Open asks from agents per project, at most (0 for no limit)" }),
		})], "Agents ask faster than anyone answers: these keep work moving.")}</div>`;
}
async function setYouLoad() {
	youError = "";
	if (Object.keys(state.settingDefs).length) return;
	await loadSettings();
	if (!Object.keys(state.settingDefs).length) youError = "Settings couldn't be loaded. Is the board running?";
	renderSettings();
}
// Keeps "Today runs from …" current across the turn of the day.
async function setYouPoll() {
	if (!Object.keys(state.settingDefs).length) return setYouLoad();
	renderSettings();
}
onSettingsChange((key) => {
	// The reader names you by the name here; a new item's owner follows its kind until you pick one.
	if (readerOpen()) {
		if (sheet.compose && !sheet.ownerPicked) sheet.draft.owner = setting(`owner.${sheet.draft.kind}`) ?? sheet.draft.owner;
		sheet.render();
	}
	// An empty or padded name is refused or trimmed, while the field would keep what was typed.
	const input = $('#settings-view input[data-setting="name"]');
	if (key === "name" && input) input.value = youName();
});
/* ---------- end: You and your day ---------- */
