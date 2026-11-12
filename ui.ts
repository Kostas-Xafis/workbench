/**
 * The board's page is index.html (the markup) plus the style sheets and scripts in ui/, which it loads in order (see
 * README, "The board's page"). Every file in ui/ is listed here: imported `with { type: "file" }` so `bun build
 * --compile` embeds it (the app's sidecar and the standalone server have no folder to read from), and named in UI,
 * the only files GET /ui/<name> sends. A new file needs its import and its UI entry, each in alphabetical order.
 */
import pagePath from "./index.html" with { type: "file" };
import asksCss from "./ui/asks.css" with { type: "file" };
import asksJs from "./ui/asks.js" with { type: "file" };
import baseCss from "./ui/base.css" with { type: "file" };
import boardCss from "./ui/board.css" with { type: "file" };
import boardJs from "./ui/board.js" with { type: "file" };
import bootJs from "./ui/boot.js" with { type: "file" };
import copyJs from "./ui/copy.js" with { type: "file" };
import coreJs from "./ui/core.js" with { type: "file" };
import dialogsCss from "./ui/dialogs.css" with { type: "file" };
import dispatchCss from "./ui/dispatch.css" with { type: "file" };
import dispatchJs from "./ui/dispatch.js" with { type: "file" };
import goalsCss from "./ui/goals.css" with { type: "file" };
import goalsJs from "./ui/goals.js" with { type: "file" };
import hooksJs from "./ui/hooks.js" with { type: "file" };
import itemJs from "./ui/item.js" with { type: "file" };
import linksCss from "./ui/links.css" with { type: "file" };
import linksJs from "./ui/links.js" with { type: "file" };
import notifyJs from "./ui/notify.js" with { type: "file" };
import phoneCss from "./ui/phone.css" with { type: "file" };
import phonesCss from "./ui/phones.css" with { type: "file" };
import projectsCss from "./ui/projects.css" with { type: "file" };
import projectsJs from "./ui/projects.js" with { type: "file" };
import railCss from "./ui/rail.css" with { type: "file" };
import railJs from "./ui/rail.js" with { type: "file" };
import reportCss from "./ui/report.css" with { type: "file" };
import reportJs from "./ui/report.js" with { type: "file" };
import rulingsCss from "./ui/rulings.css" with { type: "file" };
import rulingsJs from "./ui/rulings.js" with { type: "file" };
import searchJs from "./ui/search.js" with { type: "file" };
import settingsDataJs from "./ui/settings-data.js" with { type: "file" };
import settingsLookJs from "./ui/settings-look.js" with { type: "file" };
import settingsNotifyJs from "./ui/settings-notify.js" with { type: "file" };
import settingsPhonesJs from "./ui/settings-phones.js" with { type: "file" };
import settingsPrivacyJs from "./ui/settings-privacy.js" with { type: "file" };
import settingsProjectsJs from "./ui/settings-projects.js" with { type: "file" };
import settingsYouJs from "./ui/settings-you.js" with { type: "file" };
import settingsCss from "./ui/settings.css" with { type: "file" };
import settingsJs from "./ui/settings.js" with { type: "file" };
import setupCss from "./ui/setup.css" with { type: "file" };
import setupJs from "./ui/setup.js" with { type: "file" };
import shareJs from "./ui/share.js" with { type: "file" };
import staleCss from "./ui/stale.css" with { type: "file" };
import staleJs from "./ui/stale.js" with { type: "file" };
import todayCss from "./ui/today.css" with { type: "file" };
import todayJs from "./ui/today.js" with { type: "file" };
import topCss from "./ui/top.css" with { type: "file" };
import trackersCss from "./ui/trackers.css" with { type: "file" };
import trackersJs from "./ui/trackers.js" with { type: "file" };
import updatesCss from "./ui/updates.css" with { type: "file" };
import updatesJs from "./ui/updates.js" with { type: "file" };
import vaultCss from "./ui/vault.css" with { type: "file" };
import vaultJs from "./ui/vault.js" with { type: "file" };

/** ui/<name> → the file's path (a path inside the binary when compiled). */
export const UI: Record<string, string> = {
	"asks.css": asksCss,
	"asks.js": asksJs,
	"base.css": baseCss,
	"board.css": boardCss,
	"board.js": boardJs,
	"boot.js": bootJs,
	"copy.js": copyJs,
	"core.js": coreJs,
	"dialogs.css": dialogsCss,
	"dispatch.css": dispatchCss,
	"dispatch.js": dispatchJs,
	"goals.css": goalsCss,
	"goals.js": goalsJs,
	"hooks.js": hooksJs,
	"item.js": itemJs,
	"links.css": linksCss,
	"links.js": linksJs,
	"notify.js": notifyJs,
	"phone.css": phoneCss,
	"phones.css": phonesCss,
	"projects.css": projectsCss,
	"projects.js": projectsJs,
	"rail.css": railCss,
	"rail.js": railJs,
	"report.css": reportCss,
	"report.js": reportJs,
	"rulings.css": rulingsCss,
	"rulings.js": rulingsJs,
	"search.js": searchJs,
	"settings-data.js": settingsDataJs,
	"settings-look.js": settingsLookJs,
	"settings-notify.js": settingsNotifyJs,
	"settings-phones.js": settingsPhonesJs,
	"settings-privacy.js": settingsPrivacyJs,
	"settings-projects.js": settingsProjectsJs,
	"settings-you.js": settingsYouJs,
	"settings.css": settingsCss,
	"settings.js": settingsJs,
	"setup.css": setupCss,
	"setup.js": setupJs,
	"share.js": shareJs,
	"stale.css": staleCss,
	"stale.js": staleJs,
	"today.css": todayCss,
	"today.js": todayJs,
	"top.css": topCss,
	"trackers.css": trackersCss,
	"trackers.js": trackersJs,
	"updates.css": updatesCss,
	"updates.js": updatesJs,
	"vault.css": vaultCss,
	"vault.js": vaultJs,
};

const TYPES: Record<string, string> = { css: "text/css; charset=utf-8", js: "text/javascript; charset=utf-8" };

/** GET /ui/<name>. no-cache like the page itself: the browser asks again on every load, so a new version shows at once. */
export function uiFile(name: string): Response {
	const path = Object.hasOwn(UI, name) ? UI[name] : undefined;
	if (!path) return new Response("not found", { status: 404 });
	return new Response(Bun.file(path), { headers: { "content-type": TYPES[name.split(".").pop()!], "cache-control": "no-cache" } });
}

/** Says in the server's log when index.html loads a ui/ file that isn't listed above (it would get a 404), or the other way round. */
export async function checkUi() {
	const html = await Bun.file(pagePath as unknown as string).text();
	const used = new Set([...html.matchAll(/(?:href|src)="\/ui\/([^"?#]+)/g)].map((m) => m[1]));
	for (const name of used) if (!Object.hasOwn(UI, name)) console.error(`page: index.html loads /ui/${name}, which isn't in ui.ts (it gets a 404)`);
	for (const name of Object.keys(UI)) if (!used.has(name)) console.error(`page: ui/${name} is in ui.ts but index.html doesn't load it`);
}
