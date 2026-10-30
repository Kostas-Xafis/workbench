import { addItem, addNote, getItem, listItems, open, projects, updateItem, type ItemFilter } from "./db";
import { repoState } from "./git";

export const PORT = Number(process.env.WB_PORT ?? 4321);

export function serve({ lan = false } = {}) {
	const db = open();
	const page = Bun.file(new URL("./index.html", import.meta.url));
	const json = (data: unknown, status = 200) => Response.json(data, { status });
	const fail = (e: unknown) => json({ error: (e as Error).message }, 400);

	const server = Bun.serve({
		port: PORT,
		// Loopback unless asked: there is no login, so anyone who can reach the port can edit.
		hostname: lan ? "0.0.0.0" : "127.0.0.1",
		routes: {
			"/": () => new Response(page, { headers: { "content-type": "text/html; charset=utf-8" } }),
			"/api/projects": () => json(projects(db)),
			"/api/git": async () => json(await Promise.all(projects(db).map(repoState))),
			"/api/items": {
				GET: (req) => {
					const u = new URL(req.url).searchParams;
					const f: ItemFilter = {
						project: u.get("project") || undefined,
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
					const item = getItem(db, Number(req.params.id));
					return item ? json(item) : json({ error: "not found" }, 404);
				},
				PATCH: async (req) => {
					try {
						updateItem(db, Number(req.params.id), await req.json(), "web");
						return json(getItem(db, Number(req.params.id)));
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
						addNote(db, Number(req.params.id), text.trim(), "kostas");
						return json(getItem(db, Number(req.params.id)));
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
