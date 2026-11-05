import {
	addItem,
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
	vaultInfo,
	getReport,
	open,
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
	setReportState,
	REPORT_STATE_MAX,
	search,
	storeIcon,
	updateItem,
	updateLink,
	type ItemFilter,
	type Project,
} from "./db";
import type { Server } from "bun";
import { publishDays } from "./day";
import { codeLinks, repoState, type CodeLinks } from "./git";
import { candidateFolders, checkFolder, folderState, health } from "./health";
import { getSettings, settingDefs, updateSettings } from "./settings";
// Settings → Data
import { BACKUP_DIR, backupFile, backupsKeep, compactDb, dbStats, exportAll, restoreSteps, shellWord, tidy, tidyCount, tidyKeep, type TidyKeep } from "./db";
import { startup } from "./health";
import { SETTINGS } from "./settings";
import { findIcon } from "./icons";
import { forgetLogo, projectLogo } from "./logo";
import { REPORT_CSP, withBridge } from "./reports";
import {
	checkShare,
	extendShare,
	listShares,
	resumeShares,
	shareLimits,
	startShare,
	stopAllShares,
	stopShare,
} from "./share";
import { KEY_PATH, listSources, sourceFetch } from "./sources";
import { existsSync } from "node:fs";
import { mcpHttp } from "./mcp";
import { PRESETS } from "./presets";
import {
	addTracker,
	getTracker,
	listTrackers,
	recordReading,
	refreshTracker,
	removeTracker,
	runDue,
	trackerHistory,
	updateTracker,
} from "./trackers";

export const PORT = Number(process.env.WB_PORT ?? 4321);
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

export function serve({ lan = false } = {}) {
	const db = open();
	const page = Bun.file(new URL("./index.html", import.meta.url));
	const icon = Bun.file(new URL("./icon.svg", import.meta.url));
	const json = (data: unknown, status = 200) => Response.json(data, { status });
	const fail = (e: unknown) => json({ error: (e as Error).message }, 400);
	// The vault answers only this computer (not `--lan`, where the token would cross the network in the clear),
	// and only with the auth token derived from the password.
	const loopback = (req: Request, srv: Server<unknown>) =>
		["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(srv.requestIP(req)?.address ?? "");
	const vaultGate = async (req: Request, srv: Server<unknown>, { auth = true } = {}) => {
		if (!localRead(req, srv)) return json({ error: "the vault opens only on this computer (localhost)" }, 403);
		if (auth && !vaultAuthOk(db, req.headers.get("x-vault-auth") ?? "")) {
			await Bun.sleep(500);
			return json({ error: "wrong password" }, 401);
		}
		return null;
	};
	// Calls that act with a stored secret (data sources) come only from the board's own page on this computer:
	// a loopback peer, a localhost Host (no DNS rebinding), and a same-origin JSON request (no other site's form).
	const boardOnly = (req: Request, srv: Server<unknown>) => {
		const host = req.headers.get("host") ?? "";
		const site = req.headers.get("sec-fetch-site");
		const origin = req.headers.get("origin");
		return (
			loopback(req, srv) &&
			/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host) &&
			(!site || site === "same-origin") &&
			(!origin || origin === `http://${host}`) &&
			(req.headers.get("content-type") ?? "").startsWith("application/json")
		);
	};
	// Reads that are this computer's business (settings, health, backups, shares, the vault's info): a loopback peer, a
	// localhost Host, and not another site's page — not even one that points its own name at 127.0.0.1 (DNS
	// rebinding). Opening such a link from the board, or typing it in, is fine.
	const localRead = (req: Request, srv: Server<unknown>) => {
		const site = req.headers.get("sec-fetch-site");
		return (
			loopback(req, srv) &&
			/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(req.headers.get("host") ?? "") &&
			(!site || site === "same-origin" || site === "none")
		);
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

	// A backup when the newest is a day old: checked at start and every hour. Right after it, what Settings → Data
	// says not to keep goes (old backups, report versions, tracker readings, closed items), so the backup still has it.
	const nightly = () => {
		try {
			const last = listBackups()[0];
			if (last && Date.now() - last.at.getTime() < 23 * 3600e3) return;
			console.log(`backup: ${backup(db)}`);
			const gone = tidy(db);
			if (Object.values(gone).some(Boolean)) console.log(`tidy: ${JSON.stringify(gone)}`);
		} catch (e) {
			console.error(`backup failed: ${(e as Error).message}`);
		}
	};
	nightly();
	setInterval(nightly, 3600e3);

	// Every project's day pages ("Days" in its sidebar): today's kept current every 30 min, and the last week's
	// finished once their day is over (also after the board or the computer was off).
	let daysRunning = false;
	const days = async () => {
		if (daysRunning) return;
		daysRunning = true;
		try {
			for (const d of await publishDays(db)) console.log(`day: ${d.project} ${d.day} v${d.n}`);
		} catch (e) {
			console.error(`day pages failed: ${(e as Error).message}`);
		} finally {
			daysRunning = false;
		}
	};
	setTimeout(days, 10e3);
	setInterval(days, 30 * 60e3);

	// Status trackers that read themselves: every half minute, the ones whose interval has passed (trackers.ts).
	let trackersRunning = false;
	const trackers = async () => {
		if (trackersRunning) return;
		trackersRunning = true;
		try {
			for (const t of await runDue(db)) if (t.error) console.error(`tracker ${t.ref}: ${t.error}`);
		} catch (e) {
			console.error(`trackers failed: ${(e as Error).message}`);
		} finally {
			trackersRunning = false;
		}
	};
	setTimeout(trackers, 5e3);
	setInterval(trackers, 30e3);
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

	const server = Bun.serve({
		port: PORT,
		// Loopback unless asked: there is no login, so anyone who can reach the port can edit.
		hostname: lan ? "0.0.0.0" : "127.0.0.1",
		// The first look at pull requests per project can take gh several seconds.
		idleTimeout: 30,
		routes: {
			"/": () => new Response(page, { headers: { "content-type": "text/html; charset=utf-8" } }),
			"/favicon.svg": () =>
				new Response(icon, { headers: { "content-type": "image/svg+xml", "cache-control": "max-age=3600" } }),
			"/api/projects": {
				GET: () => json(projectsWithCounts(db)),
				// Settings → Projects. A folder decides where git and tracker commands run, so projects change only
				// from the board's own page on this computer, like data sources (`wb project` runs as you anyway).
				POST: jsonOnly(async (req, srv) => {
					if (!boardOnly(req, srv)) return json({ error: SETTINGS_LOCAL }, 403);
					try {
						const body = await req.json();
						return json(addProject(db, { ...body, path: checkFolder(body?.path) }), 201);
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
						if (before && body?.path !== undefined && body.path !== before.path) body.path = checkFolder(body.path);
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
						const start = [...env, ...process.argv.map(shellWord)].join(" ");
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
					lan,
					port: PORT,
					vault: v ? { changed_at: v.changed_at, secrets: listSecrets(db).length } : null,
					sources: listSources(db),
					sourcesKey: { path: KEY_PATH, exists: existsSync(KEY_PATH) },
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
					? json(projectsWithCounts(db).map((p) => ({ ...p, folder: folderState(p.path), usage: projectUsage(db, p.slug) })))
					: json({ error: SETTINGS_LOCAL }, 403),
			"/api/settings/folders": (req, srv) =>
				localRead(req, srv) ? json(candidateFolders(db)) : json({ error: SETTINGS_LOCAL }, 403),
			"/api/settings/health": async (req, srv) =>
				localRead(req, srv) ? json(await health(db, { port: PORT, lan })) : json({ error: SETTINGS_LOCAL }, 403),
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
				return json(q ? search(db, q, u.get("project") || undefined) : { items: [], reports: [], links: [] });
			},
			"/api/reports": (req) => json(listReports(db, new URL(req.url).searchParams.get("project") || undefined)),
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
			"/mcp": (req, srv) => mcpHttp(req, db, { loopback: loopback(req, srv) }),
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
					};
					return json(listItems(db, f));
				},
				POST: jsonOnly(async (req) => {
					try {
						const body = await req.json();
						return json({ id: addItem(db, body, "web") }, 201);
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
						answerItem(db, itemId(req.params.id), String(answer ?? ""), "kostas");
						return json(getItem(db, itemId(req.params.id)));
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
		},
		fetch: () => new Response("not found", { status: 404 }),
	});
	// Shares outlive the board (see share.ts): take back the ones still running, close the expired ones.
	resumeShares(db);
	return server;
}

if (import.meta.main) {
	const s = serve({ lan: process.argv.includes("--lan") });
	console.log(`workbench on http://${s.hostname}:${s.port}`);
}
