/**
 * The board's HTTP API and pages: every route, for both places a board runs. The board on this computer
 * (server.ts, under Bun) and the cloud board (worker/, a Cloudflare Worker with the database in a Durable Object)
 * serve this same table, so they can't drift apart. What differs between them is the BoardHost: how a request
 * from "this computer" is recognised (localRead, boardOnly), the phone gate, the page's files, and the ping.
 * Routes that need the computer itself (git, agents, backups, Usage, sharing through a tunnel, folders) are listed
 * in worker/src/board.ts, which answers them itself in the cloud; here they run as they always have.
 */
import {
	addLink,
	addNote,
	addSecret,
	answerItem,
	backup,
	clearIcon,
	listBackups,
	pruneBackups,
	getItem,
	listItems,
	resolveItem,
	linkIcon,
	listLinks,
	listReports,
	listSecrets,
	rekeyVault,
	removeSecret,
	secretValue,
	setupVault,
	updateSecret,
	vaultAuthOk,
	vaultAccessLog,
	vaultInfo,
	getReport,
	addProject,
	getProject,
	projects,
	projectsWithCounts,
	projectUsage,
	removeProject,
	setProjectOrder,
	updateProject,
	removeLink,
	reportHtml,
	reportState,
	setReportOrder,
	setReportState,
	REPORT_STATE_MAX,
	search,
	storeIcon,
	updateItem,
	updateLink,
	compactDb,
	type Db,
	type ItemFilter,
	type Project,
} from "./db";
import type { Server } from "bun";
import {
	addDevice,
	CODE_MINUTES,
	deviceName,
	listDevices,
	Pairing,
	phoneGate,
	removeAllDevices,
	removeDevice,
} from "./devices";
import { qrSvg } from "./qr";
import { archivedDay, currentDay } from "./day";
import { todayData } from "./today";
import { buildQueue, deferItem, giveBack } from "./queue";
import { resolveAsk } from "./asks";
import { fileItem } from "./filing";
import { codeLinks, repoState, type CodeLinks } from "./git";
import { candidateFolders, checkFolder, folderState, health } from "./health";
import { addGoal, goalsWithStats, itemGoals, moveGoal, updateGoal, type GoalPatch } from "./goals";
import { getSettings, settingDefs, updateSettings } from "./settings";
import { addRuling, getRuling, listRulings, updateRuling } from "./rulings";
import { checkNow, updateInfo } from "./updates";
import {
	BACKUP_DIR,
	backupFile,
	backupsKeep,
	dbStats,
	exportAll,
	restoreSteps,
	shellWord,
	tidy,
	tidyCount,
	tidyKeep,
	type TidyKeep,
} from "./db";
import { startup } from "./health";
import { SETTINGS } from "./settings";
import { findIcon } from "./icons";
import { forgetLogo, projectLogo } from "./logo";
import { REPORT_CSP, withBridge } from "./reports";
import { checkShare, extendShare, listShares, shareLimits, startShare, stopAllShares, stopShare } from "./share";
import { currentKeyring, KEY_PATH, listSources, sourceFetch } from "./sources";
import { existsSync } from "node:fs";
import { etagRoutes, IMMUTABLE, versionedPage } from "./fresh";
import { addStepPhoto, finishRun, removeStepPhoto, runState, saveStep, startOver } from "./checkruns";
import { addImage, imageData, prepareImage, removeImage, setImageCaption } from "./images";
import { mcpHttp } from "./mcp";
import { agentsView, landItem } from "./agents";
import { continueRun, getRun, listRuns, openInDesktop, runEvents, runPrompt, runsInfo, startRun, stopRun, testCommand, type From } from "./dispatch";
import { refreshUsage, usageData } from "./usage";
import { agentFiles, integratePrompt, integrateSummary } from "./integrate";
import { setupStatus } from "./setup";
import { PRESETS } from "./presets";
import {
	addTracker,
	getTracker,
	listTrackers,
	recordReading,
	refreshTracker,
	removeTracker,
	trackerHistory,
	updateTracker,
} from "./trackers";

const SETTINGS_LOCAL = "settings open only on this computer (localhost)";
const COMMAND_LOCAL = "a tracker's command can be set only from the board on this computer (localhost), or with wb tracker";

/**
 * Every write to the API is JSON. A browser sends a write from another site without asking first only as a form or
 * a no-cors text/plain fetch; with application/json it asks first (a CORS preflight), which the board never grants.
 * So no web page, and no sandboxed report page, can change the board, whatever it can reach. The board's own page
 * always sends JSON; the CLI and agents don't use this API.
 */
function jsonOnly<R extends Request>(handler: (req: R, srv: Server<unknown>) => Response | Promise<Response>) {
	return (req: R, srv: Server<unknown>): Response | Promise<Response> =>
		(req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")
			? handler(req, srv)
			: Response.json({ error: "the board takes writes as JSON only (content-type: application/json)" }, { status: 415 });
}

/** The routes that answer a phone (or, in the cloud, anyone) that isn't paired: the pairing page and what it needs. */
export const PAIR_OPEN = ["/pair", "/api/pair", "/manifest.webmanifest", "/icons/:file", "/favicon.svg"];

/** Types each handler by its route's path (req.params), as Bun.serve would. */
const defineRoutes = <R extends string>(routes: Bun.Serve.Routes<unknown, R>) => routes;

type Check = (req: Request, srv: Server<unknown>) => boolean;
export type BoardFile = "page" | "usage" | "icon" | "pair" | AppIcon;
/** The app's icons, at /icons/<name>: the home screen's (any shape, and maskable for Android's), and the badge
 *  Android shows a notification by in the status bar (white on transparent). */
export const APP_ICONS = ["icon-192.png", "icon-256.png", "icon-512.png", "maskable-192.png", "maskable-512.png", "badge-96.png"] as const;
export type AppIcon = (typeof APP_ICONS)[number];

/** Where the board runs, as the routes need to know it. server.ts makes the one for this computer, worker/ the cloud's. */
export type BoardHost = {
	db: Db;
	/** The cloud board (worker/): every request comes over the network, through its own gate. */
	cloud: boolean;
	port: number;
	/** Answering the network (`wb serve --lan`); always true in the cloud. */
	lan: boolean;
	/** The compiled server (the app's sidecar, the standalone server), for Settings → Updates. */
	compiled: boolean;
	/** A request from this computer itself. Never in the cloud. */
	loopback: Check;
	/** Reads that are the owner's business: settings, health, backups, the vault's info. */
	localRead: Check;
	/** Writes that only the board's own page (or the owner's tools) may make: settings, projects, data sources. */
	boardOnly: Check;
	gate: Gate;
	pairing: Pairing;
	/** The addresses a phone can open the board at, for the pairing QR code. */
	pairUrls: () => string[];
	/** The Set-Cookie value that hands a device its token. */
	cookie: (token: string) => string;
	sleep: (ms: number) => Promise<unknown>;
	file: (name: BoardFile) => BodyInit | null;
	uiFile: (name: string) => Response | Promise<Response>;
	/** Each ui/ file's version (a hash of it), for the page's links to them (fresh.ts). */
	uiVersions: () => Promise<Record<string, string>>;
	/** What GET /api/ping answers: enough for the desktop app to tell a board from anything else. */
	ping: () => Record<string, unknown>;
};

type Gate = ReturnType<typeof phoneGate>;

export function boardRoutes(h: BoardHost) {
	const { db, loopback, localRead, boardOnly, gate, pairing } = h;
	const json = (data: unknown, status = 200) => Response.json(data, { status });
	const fail = (e: unknown) => json({ error: (e as Error).message }, 400);
	// The vault answers only this computer (not `--lan`, where the token would cross the network in the clear),
	// and only with the auth token derived from the password.
	const vaultGate = async (req: Request, srv: Server<unknown>, { auth = true } = {}) => {
		if (!localRead(req, srv)) return json({ error: "the vault opens only on this computer (localhost)" }, 403);
		if (auth && !vaultAuthOk(db, req.headers.get("x-vault-auth") ?? "")) {
			await h.sleep(500);
			return json({ error: "wrong password" }, 401);
		}
		return null;
	};
	// Commits and pull requests per project; gh is slow and rate-limited, so each project is asked at most every 90 s.
	const codeCache = new Map<string, { at: number; links: Promise<CodeLinks> }>();
	const projectCode = (p: Project) => {
		const hit = codeCache.get(p.slug);
		if (hit && Date.now() - hit.at < 90e3) return hit.links;
		const links = codeLinks(p);
		codeCache.set(p.slug, { at: Date.now(), links });
		return links;
	};
	// A new or changed tracker is read right away rather than at the next tick.
	const readSoon = (id: number) => {
		const t = getTracker(db, id);
		if (t && t.kind !== "manual") refreshTracker(db, id).catch(() => {});
	};
	const itemId = (s: string) => {
		const id = resolveItem(db, s);
		if (id === undefined) throw new Error(`no item ${s}`);
		return id;
	};
	// Who is running a check: the paired phone's name, or a name from the browser ("Chrome on Android").
	const deviceOf = (req: Request, srv: Server<unknown>) => gate.device(req, srv)?.name ?? deviceName(req.headers.get("user-agent") ?? "");
	// What Settings shows while a code is open: the code, until when, and the address with it for the QR code.
	const pairingInfo = () => {
		const open = pairing.current();
		if (!open) return null;
		const urls = h.pairUrls().map((u) => `${u}/pair?code=${open.code}`);
		return { ...open, minutes: CODE_MINUTES, urls, qr: urls[0] ? qrSvg(urls[0]) : "" };
	};
	const devicesInfo = () => ({ lan: h.lan, cloud: h.cloud, devices: listDevices(db), pairing: pairingInfo() });
	// Agents the board starts (dispatch.ts). Who asks matters: the board's own page on this computer, or a paired
	// phone, which Settings → Agents has to allow. Anything else starts nothing.
	const runFrom = (req: Request, srv: Server<unknown>): From | null => {
		if (boardOnly(req, srv)) return { where: "local", label: "this computer" };
		const d = loopback(req, srv) ? null : gate.device(req, srv);
		return d ? { where: "phone", label: `phone (${d.name})` } : null;
	};

	// Every GET answers with an ETag, and 304 when the page already has it (fresh.ts).
	return etagRoutes(defineRoutes({
		// no-cache: the browser asks again each time (cheap, it gets 304), so an updated board shows at once. Its files
		// go by their versions, so the browser keeps them and asks for none of them again until one changes.
		// A paired phone gets its cookie again, so it lasts as long as the phone keeps opening the board.
		"/": async (req, srv) => {
			const page = versionedPage(await new Response(h.file("page")).text(), await h.uiVersions());
			const res = new Response(page, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" } });
			const token = gate.token(req);
			if (token && !loopback(req, srv) && gate.device(req, srv)) res.headers.append("set-cookie", h.cookie(token));
			return res;
		},
		// The page's style sheets and scripts (ui.ts). Asked for by version (?v=, from the page), one is kept for good.
		"/ui/:file": async (req) => {
			const res = await h.uiFile(req.params.file);
			if (!res.ok || !new URL(req.url).searchParams.has("v")) return res;
			const kept = new Response(res.body, res);
			kept.headers.set("cache-control", IMMUTABLE);
			return kept;
		},
		// What the desktop app asks to tell a running board from anything else on the port: cheap, no auth, no database.
		"/api/ping": () => Response.json(h.ping(), { headers: { "cache-control": "no-store" } }),
		// Claude usage, from Claude Code's transcripts on this computer (usage.ts). It shows which folders you work in,
		// so like the vault it answers only this computer.
		"/usage": (req, srv) =>
			localRead(req, srv)
				? new Response(h.file("usage"), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" } })
				: json({ error: "usage opens only on this computer (localhost)" }, 403),
		"/api/usage": async (req, srv) => {
			if (!localRead(req, srv)) return json({ error: "usage opens only on this computer (localhost)" }, 403);
			try {
				if (new URL(req.url).searchParams.has("fresh")) await refreshUsage(true);
				return json(await usageData(projects(db)));
			} catch (e) {
				return json({ error: (e as Error).message }, 500);
			}
		},
		"/favicon.svg": () =>
			new Response(h.file("icon"), { headers: { "content-type": "image/svg+xml", "cache-control": "max-age=3600" } }),

		// Phones: pairing, the paired devices, and what makes the board an app on a home screen (devices.ts).
		// The pairing page, its call, the manifest and the app icons answer without a token (PAIR_OPEN): they say
		// nothing about the board.
		"/pair": (req, srv) => {
			// Already paired: on to the board (or where the phone was going).
			if (!loopback(req, srv) && gate.device(req, srv)) {
				const next = new URL(req.url).searchParams.get("next") ?? "";
				return new Response(null, { status: 302, headers: { location: /^\/(?![/\\])/.test(next) ? next : "/", "cache-control": "no-store" } });
			}
			return new Response(h.file("pair"), {
				headers: {
					"content-type": "text/html; charset=utf-8",
					"cache-control": "no-store",
					"content-security-policy": "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-ancestors 'none'",
				},
			});
		},
		"/api/pair": {
			// Whether this phone is paired (the page's own fetch sends the cookie even when a link from another site
			// opened the page without it), and a name to offer for it.
			GET: (req, srv) => {
				const d = gate.device(req, srv);
				return json({ paired: !!d, local: loopback(req, srv), name: d?.name ?? deviceName(req.headers.get("user-agent") ?? "") });
			},
			// A code from Settings, typed or scanned: the phone gets its token as a cookie the page can't read.
			POST: jsonOnly(async (req, srv) => {
				const ip = srv.requestIP(req)?.address ?? "";
				try {
					const { code, name } = await req.json().catch(() => ({}));
					pairing.redeem(String(code ?? ""), ip);
					const { device, token } = addDevice(db, { name: String(name ?? ""), ip, ua: req.headers.get("user-agent") ?? "" });
					console.log(`phone paired: ${device.name} (${device.id}) from ${ip}`);
					return Response.json(
						{ device: { id: device.id, name: device.name } },
						{ status: 201, headers: { "set-cookie": h.cookie(token), "cache-control": "no-store" } },
					);
				} catch (e) {
					// Slows down guessing, on top of the limits in Pairing.redeem.
					await h.sleep(400);
					return json({ error: (e as Error).message }, (e as { status?: number }).status ?? 400);
				}
			}),
		},
		"/manifest.webmanifest": () =>
			Response.json(
				{
					id: "/",
					name: "Workbench",
					short_name: "Workbench",
					description: "Your board of open work across projects",
					start_url: "/",
					scope: "/",
					display: "standalone",
					background_color: "#f6f5f2",
					theme_color: "#f6f5f2",
					categories: ["productivity"],
					// Chrome on Android wants 192 and 512, and a maskable one to fill its own icon shape.
					icons: [
						{ src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
						{ src: "/icons/icon-256.png", sizes: "256x256", type: "image/png", purpose: "any" },
						{ src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
						{ src: "/icons/maskable-192.png", sizes: "192x192", type: "image/png", purpose: "maskable" },
						{ src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
					],
					// A long press on the app's icon.
					shortcuts: [
						{ name: "Today", url: "/#today", icons: [{ src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" }] },
						{ name: "Answer what needs you", short_name: "Queue", url: "/#queue", icons: [{ src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" }] },
					],
				},
				{ headers: { "content-type": "application/manifest+json", "cache-control": "max-age=3600" } },
			),
		"/icons/:file": (req) => {
			const png = (APP_ICONS as readonly string[]).includes(req.params.file) ? h.file(req.params.file as AppIcon) : null;
			return png
				? new Response(png, { headers: { "content-type": "image/png", "cache-control": "max-age=86400" } })
				: new Response("not found", { status: 404 });
		},
		// Settings → Privacy and security → Phones: this computer only, like the rest of Settings.
		"/api/devices": {
			GET: (req, srv) => (localRead(req, srv) ? json(devicesInfo()) : json({ error: SETTINGS_LOCAL }, 403)),
			// Remove all: every phone has to pair again.
			DELETE: jsonOnly((req, srv) => {
				if (!boardOnly(req, srv)) return json({ error: SETTINGS_LOCAL }, 403);
				removeAllDevices(db);
				return json(devicesInfo());
			}),
		},
		"/api/devices/pairing": {
			// A new code (it replaces one still open), good for CODE_MINUTES and one phone.
			POST: jsonOnly((req, srv) => {
				if (!boardOnly(req, srv)) return json({ error: SETTINGS_LOCAL }, 403);
				pairing.open();
				return json(devicesInfo(), 201);
			}),
			DELETE: jsonOnly((req, srv) => {
				if (!boardOnly(req, srv)) return json({ error: SETTINGS_LOCAL }, 403);
				pairing.close();
				return json(devicesInfo());
			}),
		},
		"/api/devices/:id": {
			DELETE: jsonOnly((req, srv) => {
				if (!boardOnly(req, srv)) return json({ error: SETTINGS_LOCAL }, 403);
				if (!removeDevice(db, req.params.id)) return json({ error: "no such device" }, 404);
				return json(devicesInfo());
			}),
		},
		"/api/projects": {
			GET: () => json(projectsWithCounts(db)),
			// Settings → Projects. A folder decides where git and tracker commands run, so projects change only
			// from the board's own page on this computer, like data sources (`wb project` runs as you anyway).
			POST: jsonOnly(async (req, srv) => {
				if (!boardOnly(req, srv)) return json({ error: SETTINGS_LOCAL }, 403);
				try {
					const body = await req.json();
					// In the cloud a folder is on a computer, not here: kept as given, for `wb` there to find the project by.
					return json(addProject(db, { ...body, path: h.cloud ? String(body?.path ?? "").trim() : checkFolder(body?.path) }), 201);
				} catch (e) {
					return fail(e);
				}
			}),
		},
		"/api/projects/:slug": {
			PATCH: jsonOnly(async (req, srv) => {
				if (!boardOnly(req, srv)) return json({ error: SETTINGS_LOCAL }, 403);
				try {
					const body = await req.json();
					const before = getProject(db, req.params.slug);
					if (before && body?.path !== undefined && body.path !== before.path) body.path = h.cloud ? String(body.path ?? "").trim() : checkFolder(body.path);
					const p = updateProject(db, req.params.slug, body ?? {});
					codeCache.delete(p.slug);
					forgetLogo(p.slug);
					return json(p);
				} catch (e) {
					return fail(e);
				}
			}),
			DELETE: jsonOnly((req, srv) => {
				if (!boardOnly(req, srv)) return json({ error: SETTINGS_LOCAL }, 403);
				try {
					removeProject(db, req.params.slug);
					return json({ ok: true });
				} catch (e) {
					return fail(e);
				}
			}),
		},
		"/api/project-order": {
			PUT: jsonOnly(async (req, srv) => {
				if (!boardOnly(req, srv)) return json({ error: SETTINGS_LOCAL }, 403);
				try {
					const { slugs } = await req.json();
					if (!Array.isArray(slugs)) throw new Error("slugs: a list of project slugs");
					setProjectOrder(db, slugs.map(String));
					return json(projectsWithCounts(db));
				} catch (e) {
					return fail(e);
				}
			}),
		},
		// Board-wide settings (settings.ts). Anyone who can open the board reads them (nothing secret); they change
		// only from the board's own page on this computer, like projects.
		"/api/settings": {
			GET: () => json(getSettings(db)),
			PATCH: jsonOnly(async (req, srv) => {
				if (!boardOnly(req, srv)) return json({ error: SETTINGS_LOCAL }, 403);
				try {
					return json(updateSettings(db, await req.json()));
				} catch (e) {
					return fail(e);
				}
			}),
		},
		"/api/settings/defs": () => json(settingDefs()),
		// Settings → Updates (updates.ts): this server's version, how it runs, and the newest release it knows of.
		// Read by anyone who can open the board (the board bar says when there's a newer one); "Check now" calls the
		// internet, so only from this computer.
		"/api/update": () => json(updateInfo(db, h.compiled)),
		"/api/update/check": {
			POST: jsonOnly(async (req, srv) => {
				if (!boardOnly(req, srv)) return json({ error: SETTINGS_LOCAL }, 403);
				await checkNow();
				return json(updateInfo(db, h.compiled));
			}),
		},

		// Settings → You and your day: routes
		// end: You and your day routes

		// Settings → Notifications: routes
		// end: Notifications routes

		// Settings → Data: routes
		...(() => {
			// A backup or an export hands over everything on the board: localRead (above) only.
			const local = () => json({ error: SETTINGS_LOCAL }, 403);
			const overview = () => {
				const keep = tidyKeep(db);
				const list = listBackups().map((b) => ({ name: b.file.slice(b.file.lastIndexOf("/") + 1), at: b.at.getTime(), bytes: b.bytes }));
				return { db: dbStats(db), backups: { dir: BACKUP_DIR, list }, keep, tidy: tidyCount(db, keep) };
			};
			// The tidy settings as they are, with any given in the query string tried instead (for "would remove").
			const keepFrom = (u: URLSearchParams): TidyKeep => {
				const keep = tidyKeep(db);
				const map = { "backups.keep": "backups", "keep.report-versions": "reportVersions", "keep.tracker-history": "trackerHistory", "keep.closed-items-days": "closedItemsDays" } as const;
				for (const [key, field] of Object.entries(map)) {
					const v = u.get(key);
					if (v === null) continue;
					try {
						keep[field] = SETTINGS[key].check(v) as number;
					} catch (e) {
						throw new Error(`${SETTINGS[key].about}: ${(e as Error).message}`);
					}
				}
				return keep;
			};
			const attachment = (name: string, type: string) => ({
				"content-type": type,
				"content-disposition": `attachment; filename="${name}"`,
				"cache-control": "no-store",
				"x-content-type-options": "nosniff",
			});
			return {
				"/api/data": (req: Request, srv: Server<unknown>) => (localRead(req, srv) ? json(overview()) : local()),
				"/api/data/tidy": {
					// What the tidy settings (or the values in the query) would remove right now.
					GET: (req: Request, srv: Server<unknown>) => {
						if (!localRead(req, srv)) return local();
						try {
							const keep = keepFrom(new URL(req.url).searchParams);
							return json({ keep, counts: tidyCount(db, keep) });
						} catch (e) {
							return fail(e);
						}
					},
					// Applies them now (they also run every night after the backup). When rows would go, a backup
					// is made first, so this can always be undone.
					POST: jsonOnly((req, srv) => {
						if (!boardOnly(req, srv)) return local();
						try {
							const { backups: _, ...rows } = tidyCount(db, tidyKeep(db));
							const saved = Object.values(rows).some(Boolean) ? backup(db) : null;
							const removed = tidy(db);
							return json({ removed, backup: saved && saved.slice(saved.lastIndexOf("/") + 1), ...overview() });
						} catch (e) {
							return fail(e);
						}
					}),
				},
				"/api/data/backups": {
					POST: jsonOnly((req, srv) => {
						if (!boardOnly(req, srv)) return local();
						try {
							const file = backup(db);
							const pruned = pruneBackups(backupsKeep(db));
							return json({ name: file.slice(file.lastIndexOf("/") + 1), pruned, ...overview() }, 201);
						} catch (e) {
							return fail(e);
						}
					}),
				},
				"/api/data/backups/:name": (req: Request & { params: { name: string } }, srv: Server<unknown>) => {
					if (!localRead(req, srv)) return local();
					const file = backupFile(req.params.name);
					if (!file) return json({ error: "no such backup" }, 404);
					return new Response(Bun.file(file), { headers: attachment(req.params.name, "application/vnd.sqlite3") });
				},
				// The commands that restore this backup on this computer; the board can't swap its own database.
				"/api/data/backups/:name/restore": async (req: Request & { params: { name: string } }, srv: Server<unknown>) => {
					if (!localRead(req, srv)) return local();
					const file = backupFile(req.params.name);
					if (!file) return json({ error: "no such backup" }, 404);
					const su = await startup();
					const env = ["WB_DB", "WB_PORT", "WB_BACKUPS", "WB_SOURCES_KEY"].filter((k) => process.env[k]).map((k) => `${k}=${shellWord(process.env[k]!)}`);
					const start = [...env, ...(h.compiled ? [process.execPath, ...process.argv.slice(2)] : process.argv).map(shellWord)].join(" ");
					return json(restoreSteps(file, { systemd: su.underSystemd, pid: process.pid, start }));
				},
				"/api/data/export": (req: Request, srv: Server<unknown>) => {
					if (!localRead(req, srv)) return local();
					const d = new Date();
					const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
					return new Response(JSON.stringify(exportAll(db), null, 1), {
						headers: attachment(`workbench-export-${day}.json`, "application/json; charset=utf-8"),
					});
				},
				"/api/data/compact": {
					POST: jsonOnly((req, srv) => {
						if (!boardOnly(req, srv)) return local();
						try {
							return json({ ...compactDb(db), ...overview() });
						} catch (e) {
							return json({ error: (e as Error).message }, /busy/.test((e as Error).message) ? 409 : 400);
						}
					}),
				},
			};
		})(),
		// end: Data routes

		// Settings → Privacy and security: routes
		// What's exposed and how secrets behave, for the tab: never a secret, a header value or the vault's salt.
		// Only for the board's page on this computer (localRead: no other site, no DNS rebinding).
		"/api/settings/privacy": (req, srv) => {
			if (!localRead(req, srv)) return json({ error: SETTINGS_LOCAL }, 403);
			const v = vaultInfo(db);
			return json({
				lan: h.lan,
				port: h.port,
				vault: v ? { changed_at: v.changed_at, secrets: listSecrets(db).length } : null,
				sources: listSources(db),
				// On the cloud board the key comes from its Worker's secrets (sources.ts cloudKeyring), never a file.
				sourcesKey: currentKeyring().prefix === "c1" ? { path: currentKeyring().where, exists: true, cloud: true } : { path: KEY_PATH, exists: existsSync(KEY_PATH) },
				share: shareLimits(db),
			});
		},
		"/api/shares/stop-all": {
			POST: jsonOnly((req, srv) => {
				if (!boardOnly(req, srv)) return json({ error: "sharing is managed only on this computer" }, 403);
				stopAllShares();
				return json(listShares());
			}),
		},
		// end: Privacy and security routes

		// Settings → Appearance: routes
		// end: Appearance routes

		// Settings: projects with their folder and what points at them, folders that could be projects, and health.
		"/api/settings/projects": (req, srv) =>
			localRead(req, srv)
				? json(projectsWithCounts(db).map((p) => ({ ...p, folder: folderState(p.path), usage: projectUsage(db, p.slug), agents: p.path ? { ...agentFiles(p.path), prompt: integratePrompt(p.path) } : null })))
				: json({ error: SETTINGS_LOCAL }, 403),
		"/api/settings/folders": (req, srv) =>
			localRead(req, srv) ? json(candidateFolders(db)) : json({ error: SETTINGS_LOCAL }, 403),
		"/api/settings/health": async (req, srv) =>
			localRead(req, srv) ? json({ ...(await health(db, { port: h.port, lan: h.lan })), integrate: integrateSummary(db), devices: listDevices(db).length }) : json({ error: SETTINGS_LOCAL }, 403),
		// The setup guide (#welcome) and its checklist: what's set up, checked now (setup.ts). This computer only,
		// like Health: it reads Claude Code's config and the projects' folders.
		"/api/setup": async (req, srv) =>
			localRead(req, srv) ? json(await setupStatus(db, { port: h.port })) : json({ error: SETTINGS_LOCAL }, 403),
		"/api/projects/:slug/logo": async (req) => {
			const p = projects(db).find((p) => p.slug === req.params.slug);
			const logo = p && (await projectLogo(p));
			if (!logo) return new Response("no logo", { status: 404, headers: { "cache-control": "no-store" } });
			return new Response(logo.file, {
				headers: {
					"content-type": logo.type,
					"cache-control": "max-age=3600",
					"content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
				},
			});
		},
		"/api/search": (req) => {
			const u = new URL(req.url).searchParams;
			const q = (u.get("q") ?? "").trim();
			return json(q ? search(db, q, u.get("project") || undefined) : { items: [], reports: [], links: [], rulings: [], goals: [] });
		},
		// Rulings, live and retired (rulings.ts): the board's sidebar part and its view.
		"/api/rulings": {
			GET: () => json(listRulings(db, { retired: "all" })),
			POST: jsonOnly(async (req) => {
				try {
					const { project, text, item } = await req.json();
					const id = addRuling(db, { project: String(project ?? ""), text, item: item ? itemId(String(item)) : undefined }, "kostas");
					return json(getRuling(db, id), 201);
				} catch (e) {
					return fail(e);
				}
			}),
		},
		"/api/rulings/:id": {
			PATCH: jsonOnly(async (req) => {
				try {
					const { text, project, retired } = await req.json();
					return json(updateRuling(db, Number(req.params.id), { text, project, retired: retired === undefined ? undefined : !!retired }, "kostas"));
				} catch (e) {
					return fail(e);
				}
			}),
		},
		// The Today view's part the page can't build alone: what agents finished since `since` (with the finishing
		// note's first line) and the reports updated since, day pages left out. ?project= (default all), ?since= (any time).
		"/api/today": (req) => {
			const u = new URL(req.url).searchParams;
			return json(todayData(db, u.get("project") || "", u.get("since")));
		},
		// Queue mode (queue.ts): what waits on you in the order to go through it, notices after; deferred ones apart.
		"/api/queue": (req) => json(buildQueue(db, { project: new URL(req.url).searchParams.get("project") || "" })),
		// Out of the queue until {until}: "tomorrow", a date, "in 3 days"; "none" brings it back.
		"/api/items/:id/defer": {
			POST: jsonOnly(async (req) => {
				try {
					const { until } = await req.json();
					return json(deferItem(db, itemId(req.params.id), until ?? "tomorrow", "kostas"));
				} catch (e) {
					return fail(e);
				}
			}),
		},
		// Back to the agent with your line {text} ("You decide, with your recommendation" when empty).
		"/api/items/:id/give-back": {
			POST: jsonOnly(async (req) => {
				try {
					const { text } = await req.json();
					return json(giveBack(db, itemId(req.params.id), String(text ?? ""), "kostas"));
				} catch (e) {
					return fail(e);
				}
			}),
		},
		// end: Queue routes
		// Goals: routes (goals.ts). Every goal with its progress and what blocks it; changing them is open like items.
		"/api/goals": {
			GET: (req) => {
				const u = new URL(req.url).searchParams;
				return json(goalsWithStats(db, { project: u.get("project") || undefined }));
			},
			POST: jsonOnly(async (req) => {
				try {
					addGoal(db, await req.json());
					return json(goalsWithStats(db), 201);
				} catch (e) {
					return fail(e);
				}
			}),
		},
		// Each item's goal and where it stands among its project's open goals (rank 1 = the active one): for
		// ordering a queue of work by goal. Keyed by the item's ref; items with no open goal aren't listed.
		"/api/goals/items": (req) => json(Object.fromEntries(itemGoals(db, new URL(req.url).searchParams.get("project") || undefined))),
		"/api/goals/:id": {
			PATCH: jsonOnly(async (req) => {
				try {
					const id = Number(req.params.id);
					const { move, ...patch } = (await req.json()) as GoalPatch & { move?: number };
					updateGoal(db, id, patch);
					if (move) moveGoal(db, id, move);
					return json(goalsWithStats(db));
				} catch (e) {
					return fail(e);
				}
			}),
		},
		// end: Goals routes
		"/api/reports": (req) => {
			const today = currentDay(db);
			return json(listReports(db, new URL(req.url).searchParams.get("project") || undefined).map((r) => ({ ...r, archived: archivedDay(r.name, today) })));
		},
		// The order of a project's report groups in the sidebar: a rail convenience, so the phone can change it too.
		"/api/projects/:slug/report-order": {
			PUT: jsonOnly(async (req) => {
				try {
					const { groups } = await req.json();
					return json({ groups: setReportOrder(db, req.params.slug, groups) });
				} catch (e) {
					return fail(e);
				}
			}),
		},
		"/api/reports/:id": (req) => {
			const r = getReport(db, Number(req.params.id));
			return r ? json(r) : json({ error: "not found" }, 404);
		},
		// A report page's saved inputs. The board passes these on for the page in its frame only.
		"/api/reports/:id/state": {
			GET: (req) => {
				const id = Number(req.params.id);
				if (!getReport(db, id)) return json({ error: "not found" }, 404);
				return new Response(reportState(db, id) ?? "null", { headers: { "content-type": "application/json" } });
			},
			PUT: jsonOnly(async (req) => {
				try {
					if (Number(req.headers.get("content-length")) > REPORT_STATE_MAX) throw new Error("state is too big");
					setReportState(db, Number(req.params.id), await req.text());
					return json({ ok: true });
				} catch (e) {
					return fail(e);
				}
			}),
			DELETE: jsonOnly((req) => {
				try {
					setReportState(db, Number(req.params.id), null);
					return json({ ok: true });
				} catch (e) {
					return fail(e);
				}
			}),
		},
		// A report page's `wb.fetch`: its own project's data source, called here with the source's headers.
		"/api/reports/:id/fetch": {
			POST: jsonOnly(async (req, srv) => {
				if (!boardOnly(req, srv))
					return json({ ok: false, status: 0, error: "data sources answer only the board on this computer (localhost)" }, 403);
				const { name, path, opts } = await req.json().catch(() => ({}));
				return json(await sourceFetch(db, Number(req.params.id), name, path, opts ?? {}));
			}),
		},
		// Status trackers (trackers.ts). A command runs on this computer, so setting one is for the board's own
		// page here only, like data sources; reading, recording and refreshing are open like the rest of the board.
		"/api/trackers": {
			GET: (req) => json(listTrackers(db, new URL(req.url).searchParams.get("project") || undefined)),
			POST: jsonOnly(async (req, srv) => {
				try {
					const body = await req.json();
					if (body?.command && !boardOnly(req, srv)) return json({ error: COMMAND_LOCAL }, 403);
					const t = addTracker(db, body);
					readSoon(t.id);
					return json(t, 201);
				} catch (e) {
					return fail(e);
				}
			}),
		},
		"/api/tracker-presets": () =>
			json(Object.fromEntries(Object.entries(PRESETS).map(([k, { read: _, ...p }]) => [k, p]))),
		"/api/trackers/:id": {
			GET: (req) => {
				const t = getTracker(db, Number(req.params.id));
				return t ? json({ ...t, history: trackerHistory(db, t.id, 200) }) : json({ error: "not found" }, 404);
			},
			PATCH: jsonOnly(async (req, srv) => {
				try {
					const id = Number(req.params.id);
					const body = await req.json();
					const before = getTracker(db, id);
					if (before && body?.command !== undefined && body.command !== before.command && !boardOnly(req, srv))
						return json({ error: COMMAND_LOCAL }, 403);
					const t = updateTracker(db, id, body);
					if (!t.checked_at) readSoon(id);
					return json(t);
				} catch (e) {
					return fail(e);
				}
			}),
			DELETE: jsonOnly((req) => {
				try {
					removeTracker(db, Number(req.params.id));
					return json({ ok: true });
				} catch (e) {
					return fail(e);
				}
			}),
		},
		"/api/trackers/:id/refresh": {
			POST: jsonOnly(async (req) => {
				try {
					return json(await refreshTracker(db, Number(req.params.id), "kostas"));
				} catch (e) {
					return fail(e);
				}
			}),
		},
		"/api/trackers/:id/reading": {
			POST: jsonOnly(async (req) => {
				try {
					const { text, reading } = await req.json();
					return json(recordReading(db, Number(req.params.id), reading ?? String(text ?? ""), "kostas"));
				} catch (e) {
					return fail(e);
				}
			}),
		},
		// MCP over Streamable HTTP, for agents on this computer (mcp.ts).
		"/mcp": (req, srv) => mcpHttp(req, db, { loopback: loopback(req, srv), cloud: h.cloud }),
		// Names and base URLs only; header values never leave the server.
		"/api/sources": (req) => json(listSources(db, new URL(req.url).searchParams.get("project") || undefined)),
		// The page itself, sandboxed: it reads the board only through the frame's postMessage bridge.
		"/r/:id": (req) => {
			const r = getReport(db, Number(req.params.id));
			const v = Number(new URL(req.url).searchParams.get("v")) || undefined;
			const page = r && reportHtml(db, r.id, v);
			if (!r || !page) return new Response("no such report", { status: 404 });
			return new Response(withBridge(page.html, r, page.n), {
				headers: {
					"content-type": "text/html; charset=utf-8",
					"content-security-policy": REPORT_CSP,
					"cache-control": "no-store",
				},
			});
		},
		// Sharing a report through a Cloudflare quick tunnel (see share.ts). Started only from this computer.
		"/api/share/check": async (req, srv) =>
			localRead(req, srv) ? json(await checkShare()) : json({ error: "sharing starts only on this computer" }, 403),
		// Links are as good as the report, so a page that rebinds a name to 127.0.0.1 (a non-localhost Host) gets none.
		"/api/shares": (req, srv) =>
			localRead(req, srv) ? json(listShares()) : json({ error: "sharing starts only on this computer" }, 403),
		"/api/reports/:id/share": {
			POST: jsonOnly(async (req, srv) => {
				if (!boardOnly(req, srv)) return json({ error: "sharing starts only on this computer" }, 403);
				try {
					const { version, hours } = await req.json().catch(() => ({}));
					const id = Number(req.params.id);
					return json(
						await startShare(db, id, Number(version) || undefined, hours == null ? undefined : Number(hours)),
						201,
					);
				} catch (e) {
					return fail(e);
				}
			}),
			DELETE: jsonOnly((req, srv) => {
				if (!boardOnly(req, srv)) return json({ error: "sharing starts only on this computer" }, 403);
				stopShare(Number(req.params.id));
				return json(listShares());
			}),
		},
		"/api/reports/:id/share/extend": {
			POST: jsonOnly((req, srv) => {
				if (!boardOnly(req, srv)) return json({ error: "sharing starts only on this computer" }, 403);
				try {
					return json(extendShare(Number(req.params.id)));
				} catch (e) {
					return fail(e);
				}
			}),
		},
		"/api/links": {
			GET: () => json(listLinks(db)),
			POST: jsonOnly(async (req) => {
				try {
					return json({ id: addLink(db, await req.json()) }, 201);
				} catch (e) {
					return fail(e);
				}
			}),
		},
		// Fetched once and kept in the database; a failed lookup is retried after a day.
		"/api/links/:id/icon": async (req) => {
			const id = Number(req.params.id);
			let row = linkIcon(db, id);
			if (!row) return new Response("not found", { status: 404 });
			const checked = row.icon_checked_at ? Date.parse(row.icon_checked_at.replace(" ", "T") + "Z") : 0;
			if (!row.icon && Date.now() - checked > 86400e3) {
				storeIcon(db, id, await findIcon(row.url, row.icon_url));
				row = linkIcon(db, id)!;
			}
			if (!row.icon) return new Response("no icon", { status: 404, headers: { "cache-control": "no-store" } });
			return new Response(new Uint8Array(row.icon), {
				headers: {
					"content-type": row.icon_type,
					"cache-control": "max-age=86400",
					"content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
				},
			});
		},
		"/api/links/icons/refresh": {
			POST: jsonOnly(() => {
				clearIcon(db);
				return json(listLinks(db));
			}),
		},
		"/api/links/:id": {
			PATCH: jsonOnly(async (req) => {
				try {
					updateLink(db, Number(req.params.id), await req.json());
					return json(listLinks(db));
				} catch (e) {
					return fail(e);
				}
			}),
			DELETE: jsonOnly((req) => {
				try {
					removeLink(db, Number(req.params.id));
					return json(listLinks(db));
				} catch (e) {
					return fail(e);
				}
			}),
		},
		"/api/vault": {
			GET: async (req, srv) => (await vaultGate(req, srv, { auth: false })) ?? json(vaultInfo(db)),
			POST: jsonOnly(async (req, srv) => {
				const no = await vaultGate(req, srv, { auth: false });
				if (no) return no;
				try {
					setupVault(db, await req.json());
					return json(vaultInfo(db), 201);
				} catch (e) {
					return fail(e);
				}
			}),
		},
		"/api/vault/rekey": {
			POST: jsonOnly(async (req, srv) => {
				const no = await vaultGate(req, srv);
				if (no) return no;
				try {
					const { secrets, ...v } = await req.json();
					rekeyVault(db, v, secrets);
					return json(vaultInfo(db));
				} catch (e) {
					return fail(e);
				}
			}),
		},
		// What agents asked of the vault (vaultask.ts): secrets by id, which the unlocked page names.
		"/api/vault/access": {
			GET: async (req, srv) => (await vaultGate(req, srv)) ?? json(vaultAccessLog(db)),
		},
		"/api/secrets": {
			GET: async (req, srv) => (await vaultGate(req, srv)) ?? json(listSecrets(db)),
			POST: jsonOnly(async (req, srv) => {
				const no = await vaultGate(req, srv);
				if (no) return no;
				try {
					return json({ id: addSecret(db, await req.json()) }, 201);
				} catch (e) {
					return fail(e);
				}
			}),
		},
		"/api/secrets/:id": {
			GET: async (req, srv) => {
				const no = await vaultGate(req, srv);
				if (no) return no;
				const value = secretValue(db, Number(req.params.id));
				return value ? json({ value }) : json({ error: "not found" }, 404);
			},
			PATCH: jsonOnly(async (req, srv) => {
				const no = await vaultGate(req, srv);
				if (no) return no;
				try {
					updateSecret(db, Number(req.params.id), await req.json());
					return json(listSecrets(db));
				} catch (e) {
					return fail(e);
				}
			}),
			DELETE: jsonOnly(async (req, srv) => {
				const no = await vaultGate(req, srv);
				if (no) return no;
				try {
					removeSecret(db, Number(req.params.id));
					return json(listSecrets(db));
				} catch (e) {
					return fail(e);
				}
			}),
		},
		"/api/git": async (req) => {
			const only = new URL(req.url).searchParams.get("project");
			return json(await Promise.all(projects(db).filter((p) => (only ? p.slug === only : !p.archived_at)).map(repoState)));
		},
		"/api/items": {
			GET: (req) => {
				const u = new URL(req.url).searchParams;
				const f: ItemFilter = {
					project: u.get("project") || undefined,
					owner: (u.get("owner") || undefined) as ItemFilter["owner"],
					kind: (u.get("kind") || undefined) as ItemFilter["kind"],
					q: u.get("q") || undefined,
					status: u.get("status")?.split(",") as ItemFilter["status"],
					goal: u.get("goal") === "none" ? "none" : u.get("goal") ? Number(u.get("goal")) : undefined,
				};
				const items = listItems(db, f);
				// bodies=open: the details of open items only, as the board's page asks. Closed ones are most of a board,
				// and their details load when one is opened.
				if (u.get("bodies") === "open") for (const i of items) if (!["todo", "doing", "waiting"].includes(i.status)) delete (i as { body?: string }).body;
				return json(items);
			},
			POST: jsonOnly(async (req) => {
				try {
					// The one way items are filed (filing.ts). What Kostas files on the page is never checked.
					const body = await req.json();
					return json({ id: (await fileItem(db, { item: body, author: "web", byAgent: false })).id }, 201);
				} catch (e) {
					return fail(e);
				}
			}),
		},
		"/api/items/:id": {
			GET: (req) => {
				const id = resolveItem(db, req.params.id);
				return id === undefined ? json({ error: "not found" }, 404) : json(getItem(db, id));
			},
			PATCH: jsonOnly(async (req) => {
				try {
					updateItem(db, itemId(req.params.id), await req.json(), "web");
					return json(getItem(db, itemId(req.params.id)));
				} catch (e) {
					return fail(e);
				}
			}),
		},
		"/api/items/:id/answer": {
			POST: jsonOnly(async (req) => {
				try {
					const { answer } = await req.json();
					answerItem(db, itemId(req.params.id), Array.isArray(answer) ? answer.map(String) : String(answer ?? ""), "kostas");
					return json(getItem(db, itemId(req.params.id)));
				} catch (e) {
					return fail(e);
				}
			}),
		},
		// A notice: Got it (a review: No objections), or an objection in your words, back to the agent (asks.ts).
		"/api/items/:id/ack": {
			POST: jsonOnly((req) => {
				try {
					return json(resolveAsk(db, itemId(req.params.id), { ack: true }, "kostas"));
				} catch (e) {
					return fail(e);
				}
			}),
		},
		"/api/items/:id/object": {
			POST: jsonOnly(async (req) => {
				try {
					const { text } = await req.json();
					return json(resolveAsk(db, itemId(req.params.id), { object: String(text ?? "") }, "kostas"));
				} catch (e) {
					return fail(e);
				}
			}),
		},
		// Pictures you add on the board: base64 in JSON, like every other write, checked and shrunk like an agent's.
		// Agents the board starts (dispatch.ts): the limits and what's used, whether this client may start one,
		// recent runs; one run with its output; start (on an agent's to-do, or answering an ask first); stop.
		"/api/runs": {
			GET: async (req, srv) => {
				const item = new URL(req.url).searchParams.get("item");
				if (item) return json(listRuns(db, { item: itemId(item), limit: 10 }));
				return json(await runsInfo(db, runFrom(req, srv)));
			},
			POST: jsonOnly(async (req, srv) => {
				const from = runFrom(req, srv);
				if (!from) return json({ error: "agents start only from the board on this computer, or a phone paired with it" }, 403);
				try {
					const { item, answer, object } = await req.json();
					const how = answer !== undefined ? { answer: Array.isArray(answer) ? answer.map(String) : String(answer) } : object !== undefined ? { object: String(object) } : {};
					const run = await startRun(db, itemId(String(item)), from, how);
					return json({ run, item: getItem(db, run.item_id) }, 201);
				} catch (e) {
					return fail(e);
				}
			}),
		},
		// The Agents place (agents.ts): running, ready to land, stuck and finished, in one answer; and Merge it, a run
		// that lands a done item's branch.
		"/api/agents": async (req, srv) => {
			const u = new URL(req.url).searchParams;
			try {
				return json(await agentsView(db, { project: u.get("project") || "*", since: u.get("since") || undefined }, runFrom(req, srv)));
			} catch (e) {
				return fail(e);
			}
		},
		"/api/items/:id/land": {
			POST: jsonOnly(async (req, srv) => {
				const from = runFrom(req, srv);
				if (!from) return json({ error: "agents start only from the board on this computer, or a phone paired with it" }, 403);
				try {
					const run = await landItem(db, itemId(req.params.id), from);
					return json({ run, item: getItem(db, run.item_id) }, 201);
				} catch (e) {
					return fail(e);
				}
			}),
		},
		"/api/runs/test": {
			POST: jsonOnly(async (req, srv) => {
				if (!boardOnly(req, srv)) return json({ error: SETTINGS_LOCAL }, 403);
				const { command } = await req.json().catch(() => ({}));
				return json(await testCommand(String(command || getSettings(db)["agents.command"])));
			}),
		},
		"/api/runs/prompt/:id": (req) => {
			try {
				return json({ prompt: runPrompt(db, getItem(db, itemId(req.params.id))!) });
			} catch (e) {
				return fail(e);
			}
		},
		"/api/runs/:id": (req) => {
			const r = getRun(db, Number(req.params.id));
			return r ? json(r) : json({ error: "no such run" }, 404);
		},
		// What the agent said and did, parsed from its output (dispatch.ts RunEvent), while it runs and after: the run
		// (without its tail) and its events after number `after` (none given: from the start).
		"/api/runs/:id/events": (req) => {
			const r = getRun(db, Number(req.params.id));
			if (!r) return json({ error: "no such run" }, 404);
			const raw = new URL(req.url).searchParams.get("after");
			const after = raw === null || raw === "" || !Number.isFinite(Number(raw)) ? -1 : Number(raw);
			const events = runEvents(db, r.id, after);
			const { tail: _, command: __, ...run } = r;
			return json({ run, events, next: events.at(-1)?.n ?? after });
		},
		// Continue: a new run that resumes this run's Claude Code session with { message } as the prompt.
		"/api/runs/:id/continue": {
			POST: jsonOnly(async (req, srv) => {
				const from = runFrom(req, srv);
				if (!from) return json({ error: "agents start only from the board on this computer, or a phone paired with it" }, 403);
				try {
					const { message } = await req.json();
					const run = await continueRun(db, Number(req.params.id), String(message ?? ""), from);
					return json({ run, item: getItem(db, run.item_id) }, 201);
				} catch (e) {
					return fail(e);
				}
			}),
		},
		"/api/runs/:id/stop": {
			POST: jsonOnly(async (req, srv) => {
				if (!runFrom(req, srv)) return json({ error: "runs stop only from the board on this computer, or a phone paired with it" }, 403);
				try {
					return json(await stopRun(db, Number(req.params.id)));
				} catch (e) {
					return fail(e);
				}
			}),
		},
		"/api/runs/:id/desktop": {
			POST: jsonOnly(async (req, srv) => {
				if (!boardOnly(req, srv)) return json({ error: "a run opens in Claude Desktop only from the board on this computer" }, 403);
				try {
					return json(openInDesktop(db, Number(req.params.id)));
				} catch (e) {
					return fail(e);
				}
			}),
		},
		"/api/items/:id/images": {
			POST: jsonOnly(async (req) => {
				try {
					const id = itemId(req.params.id);
					const { data, caption } = await req.json();
					if (typeof data !== "string" || !data) throw new Error("no image");
					addImage(db, id, await prepareImage(Buffer.from(data.replace(/^data:[^,]*,/, ""), "base64"), "that file"), String(caption ?? ""), "kostas");
					return json(getItem(db, id), 201);
				} catch (e) {
					return fail(e);
				}
			}),
		},
		// Running a check on a device, step by step (checkruns.ts): the steps with the results so far, a step's
		// pass or fail, its photos, finishing (done, or a bug per failed step) and starting over.
		"/api/items/:id/check": { GET: (req) => { try { return json(runState(db, itemId(req.params.id))); } catch (e) { return fail(e); } } },
		"/api/items/:id/check/steps/:n": {
			PUT: jsonOnly(async (req, srv) => {
				try {
					const { result, words } = await req.json();
					return json(saveStep(db, itemId(req.params.id), Number(req.params.n) - 1, { result: String(result ?? ""), words }, deviceOf(req, srv)));
				} catch (e) {
					return fail(e);
				}
			}),
		},
		"/api/items/:id/check/steps/:n/photos": {
			POST: jsonOnly(async (req, srv) => {
				try {
					const { data } = await req.json();
					if (typeof data !== "string" || !data) throw new Error("no image");
					const image = await prepareImage(Buffer.from(data.replace(/^data:[^,]*,/, ""), "base64"), "that file");
					return json(addStepPhoto(db, itemId(req.params.id), Number(req.params.n) - 1, image, deviceOf(req, srv)), 201);
				} catch (e) {
					return fail(e);
				}
			}),
		},
		"/api/items/:id/check/steps/:n/photos/:image": {
			DELETE: jsonOnly((req) => {
				try {
					return json(removeStepPhoto(db, itemId(req.params.id), Number(req.params.n) - 1, Number(req.params.image)));
				} catch (e) {
					return fail(e);
				}
			}),
		},
		"/api/items/:id/check/finish": {
			POST: jsonOnly((req, srv) => {
				try {
					return json(finishRun(db, itemId(req.params.id), deviceOf(req, srv)));
				} catch (e) {
					return fail(e);
				}
			}),
		},
		"/api/items/:id/check/reset": {
			POST: jsonOnly((req) => {
				try {
					return json(startOver(db, itemId(req.params.id)));
				} catch (e) {
					return fail(e);
				}
			}),
		},
		// Pictures on items. The type was checked when it came in; the headers make sure a browser never treats one as a page.
		"/api/images/:id": {
			GET: (req) => {
				const row = imageData(db, Number(req.params.id));
				if (!row) return new Response("not found", { status: 404 });
				return new Response(new Uint8Array(row.data), {
					headers: {
						"content-type": row.type,
						"cache-control": "private, max-age=86400",
						"x-content-type-options": "nosniff",
						"content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
					},
				});
			},
			DELETE: jsonOnly((req) => {
				try {
					return json(getItem(db, removeImage(db, Number(req.params.id), "kostas")));
				} catch (e) {
					return fail(e);
				}
			}),
			PATCH: jsonOnly(async (req) => {
				try {
					const { caption } = await req.json();
					return json(getItem(db, setImageCaption(db, Number(req.params.id), String(caption ?? ""), "kostas")));
				} catch (e) {
					return fail(e);
				}
			}),
		},
		"/api/code": async (req) => {
			const only = new URL(req.url).searchParams.get("project");
			const all = await Promise.all(projects(db).filter((p) => (only ? p.slug === only : !p.archived_at)).map(projectCode));
			return json(Object.assign({}, ...all));
		},
		"/api/items/:id/notes": {
			POST: jsonOnly(async (req) => {
				try {
					const { text } = await req.json();
					if (!text?.trim()) throw new Error("empty note");
					addNote(db, itemId(req.params.id), text.trim(), "kostas");
					return json(getItem(db, itemId(req.params.id)));
				} catch (e) {
					return fail(e);
				}
			}),
		},
	}));
}
