import {
	addItem,
	addLink,
	addNote,
	clearIcon,
	getItem,
	listItems,
	resolveItem,
	linkIcon,
	listLinks,
	listReports,
	getReport,
	open,
	projects,
	projectsWithCounts,
	removeLink,
	reportHtml,
	search,
	storeIcon,
	updateItem,
	updateLink,
	type ItemFilter,
} from "./db";
import { repoState } from "./git";
import { findIcon } from "./icons";
import { projectLogo } from "./logo";
import { REPORT_CSP, withBridge } from "./reports";

export const PORT = Number(process.env.WB_PORT ?? 4321);

export function serve({ lan = false } = {}) {
	const db = open();
	const page = Bun.file(new URL("./index.html", import.meta.url));
	const icon = Bun.file(new URL("./icon.svg", import.meta.url));
	const json = (data: unknown, status = 200) => Response.json(data, { status });
	const fail = (e: unknown) => json({ error: (e as Error).message }, 400);
	const itemId = (s: string) => {
		const id = resolveItem(db, s);
		if (id === undefined) throw new Error(`no item ${s}`);
		return id;
	};

	const server = Bun.serve({
		port: PORT,
		// Loopback unless asked: there is no login, so anyone who can reach the port can edit.
		hostname: lan ? "0.0.0.0" : "127.0.0.1",
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
	return server;
}

if (import.meta.main) {
	const s = serve({ lan: process.argv.includes("--lan") });
	console.log(`workbench on http://${s.hostname}:${s.port}`);
}
