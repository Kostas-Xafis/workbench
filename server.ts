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
	projects,
	projectsWithCounts,
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
import { findIcon } from "./icons";
import { projectLogo } from "./logo";
import { REPORT_CSP, withBridge } from "./reports";
import { checkShare, extendShare, listShares, resumeShares, startShare, stopShare } from "./share";

export const PORT = Number(process.env.WB_PORT ?? 4321);

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
		if (!loopback(req, srv)) return json({ error: "the vault opens only on this computer (localhost)" }, 403);
		if (auth && !vaultAuthOk(db, req.headers.get("x-vault-auth") ?? "")) {
			await Bun.sleep(500);
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

	// A backup when the newest is a day old: checked at start and every hour.
	const nightly = () => {
		try {
			const last = listBackups()[0];
			if (last && Date.now() - last.at.getTime() < 23 * 3600e3) return;
			console.log(`backup: ${backup(db)}`);
			pruneBackups();
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
			"/api/projects": () => json(projectsWithCounts(db)),
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
				PUT: async (req) => {
					try {
						if (Number(req.headers.get("content-length")) > REPORT_STATE_MAX) throw new Error("state is too big");
						setReportState(db, Number(req.params.id), await req.text());
						return json({ ok: true });
					} catch (e) {
						return fail(e);
					}
				},
				DELETE: (req) => {
					try {
						setReportState(db, Number(req.params.id), null);
						return json({ ok: true });
					} catch (e) {
						return fail(e);
					}
				},
			},
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
				loopback(req, srv) ? json(await checkShare()) : json({ error: "sharing starts only on this computer" }, 403),
			"/api/shares": (req, srv) =>
				loopback(req, srv) ? json(listShares()) : json({ error: "sharing starts only on this computer" }, 403),
			"/api/reports/:id/share": {
				POST: async (req, srv) => {
					if (!loopback(req, srv)) return json({ error: "sharing starts only on this computer" }, 403);
					try {
						const { version, hours } = await req.json().catch(() => ({}));
						const id = Number(req.params.id);
						return json(await startShare(db, id, Number(version) || undefined, Number(hours) || 1), 201);
					} catch (e) {
						return fail(e);
					}
				},
				DELETE: (req, srv) => {
					if (!loopback(req, srv)) return json({ error: "sharing starts only on this computer" }, 403);
					stopShare(Number(req.params.id));
					return json(listShares());
				},
			},
			"/api/reports/:id/share/extend": {
				POST: (req, srv) => {
					if (!loopback(req, srv)) return json({ error: "sharing starts only on this computer" }, 403);
					try {
						return json(extendShare(Number(req.params.id)));
					} catch (e) {
						return fail(e);
					}
				},
			},
			"/api/links": {
				GET: () => json(listLinks(db)),
				POST: async (req) => {
					try {
						return json({ id: addLink(db, await req.json()) }, 201);
					} catch (e) {
						return fail(e);
					}
				},
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
				POST: () => {
					clearIcon(db);
					return json(listLinks(db));
				},
			},
			"/api/links/:id": {
				PATCH: async (req) => {
					try {
						updateLink(db, Number(req.params.id), await req.json());
						return json(listLinks(db));
					} catch (e) {
						return fail(e);
					}
				},
				DELETE: (req) => {
					try {
						removeLink(db, Number(req.params.id));
						return json(listLinks(db));
					} catch (e) {
						return fail(e);
					}
				},
			},
			"/api/vault": {
				GET: async (req, srv) => (await vaultGate(req, srv, { auth: false })) ?? json(vaultInfo(db)),
				POST: async (req, srv) => {
					const no = await vaultGate(req, srv, { auth: false });
					if (no) return no;
					try {
						setupVault(db, await req.json());
						return json(vaultInfo(db), 201);
					} catch (e) {
						return fail(e);
					}
				},
			},
			"/api/vault/rekey": {
				POST: async (req, srv) => {
					const no = await vaultGate(req, srv);
					if (no) return no;
					try {
						const { secrets, ...v } = await req.json();
						rekeyVault(db, v, secrets);
						return json(vaultInfo(db));
					} catch (e) {
						return fail(e);
					}
				},
			},
			"/api/secrets": {
				GET: async (req, srv) => (await vaultGate(req, srv)) ?? json(listSecrets(db)),
				POST: async (req, srv) => {
					const no = await vaultGate(req, srv);
					if (no) return no;
					try {
						return json({ id: addSecret(db, await req.json()) }, 201);
					} catch (e) {
						return fail(e);
					}
				},
			},
			"/api/secrets/:id": {
				GET: async (req, srv) => {
					const no = await vaultGate(req, srv);
					if (no) return no;
					const value = secretValue(db, Number(req.params.id));
					return value ? json({ value }) : json({ error: "not found" }, 404);
				},
				PATCH: async (req, srv) => {
					const no = await vaultGate(req, srv);
					if (no) return no;
					try {
						updateSecret(db, Number(req.params.id), await req.json());
						return json(listSecrets(db));
					} catch (e) {
						return fail(e);
					}
				},
				DELETE: async (req, srv) => {
					const no = await vaultGate(req, srv);
					if (no) return no;
					try {
						removeSecret(db, Number(req.params.id));
						return json(listSecrets(db));
					} catch (e) {
						return fail(e);
					}
				},
			},
			"/api/git": async (req) => {
				const only = new URL(req.url).searchParams.get("project");
				return json(await Promise.all(projects(db).filter((p) => !only || p.slug === only).map(repoState)));
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
				POST: async (req) => {
					try {
						const body = await req.json();
						return json({ id: addItem(db, body, "web") }, 201);
					} catch (e) {
						return fail(e);
					}
				},
			},
			"/api/items/:id": {
				GET: (req) => {
					const id = resolveItem(db, req.params.id);
					return id === undefined ? json({ error: "not found" }, 404) : json(getItem(db, id));
				},
				PATCH: async (req) => {
					try {
						updateItem(db, itemId(req.params.id), await req.json(), "web");
						return json(getItem(db, itemId(req.params.id)));
					} catch (e) {
						return fail(e);
					}
				},
			},
			"/api/items/:id/answer": {
				POST: async (req) => {
					try {
						const { answer } = await req.json();
						answerItem(db, itemId(req.params.id), String(answer ?? ""), "kostas");
						return json(getItem(db, itemId(req.params.id)));
					} catch (e) {
						return fail(e);
					}
				},
			},
			"/api/code": async (req) => {
				const only = new URL(req.url).searchParams.get("project");
				const all = await Promise.all(projects(db).filter((p) => !only || p.slug === only).map(projectCode));
				return json(Object.assign({}, ...all));
			},
			"/api/items/:id/notes": {
				POST: async (req) => {
					try {
						const { text } = await req.json();
						if (!text?.trim()) throw new Error("empty note");
						addNote(db, itemId(req.params.id), text.trim(), "kostas");
						return json(getItem(db, itemId(req.params.id)));
					} catch (e) {
						return fail(e);
					}
				},
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
