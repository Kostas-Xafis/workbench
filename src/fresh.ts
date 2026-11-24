/**
 * What keeps the board's page quick over the network (the cloud board, a phone on the LAN), and costs nothing on
 * this computer. See docs/development.md, "The board's page".
 *
 * - Reads answer with an ETag, and with 304 and no body when the page already has that answer (If-None-Match). The
 *   page polls every 10 s (ui/boot.js); most of the time nothing changed, so a poll is a handful of tiny 304s
 *   instead of the whole board again. The answer is still worked out each time and hashed, so it can never be
 *   stale, whoever wrote to the database (the server, `wb`, an agent, the cloud board's helper).
 * - The page names each of its files with its content's hash (/ui/board.js?v=…), and a file asked for that way may be
 *   kept for a year: a page load reads them from the browser's cache, and a changed file has a new name.
 */
import { createHash } from "node:crypto";

/** A file under its hashed name: the same name always means the same bytes. Private: the cloud board's files are
 *  only for paired devices, so no shared cache keeps them. */
export const IMMUTABLE = "private, max-age=31536000, immutable";

/** A short hash of some bytes, for an ETag or a file's version. */
export function hashOf(data: string | ArrayBuffer | Uint8Array) {
	return createHash("sha1")
		.update(typeof data === "string" ? data : new Uint8Array(data as ArrayBuffer))
		.digest("base64url")
		.slice(0, 16);
}

const matches = (req: Request, tag: string) =>
	(req.headers.get("if-none-match") ?? "")
		.split(",")
		.map((t) => t.trim().replace(/^W\//, ""))
		.some((t) => t === tag || t === "*");

/**
 * A GET's answer with an ETag, or 304 when the request already has it. Only for JSON (the API) and the page itself;
 * anything else, a failure, or an answer with its own ETag goes out as it is. JSON that says nothing about caching
 * gets no-store: the page keeps the answers it polls itself (ui/core.js), and the browser keeps nothing on disk
 * (some are secrets).
 */
export async function withEtag(req: Request, res: Response): Promise<Response> {
	if ((req.method !== "GET" && req.method !== "HEAD") || res.status !== 200 || res.headers.has("etag")) return res;
	const type = res.headers.get("content-type") ?? "";
	const isJson = type.startsWith("application/json");
	if (!isJson && !type.startsWith("text/html")) return res;
	const body = await res.arrayBuffer();
	const tag = `"${hashOf(body)}"`;
	const headers = new Headers(res.headers);
	headers.set("etag", tag);
	if (isJson && !headers.has("cache-control")) headers.set("cache-control", "no-store");
	if (matches(req, tag)) {
		headers.delete("content-type");
		headers.delete("content-length");
		return new Response(null, { status: 304, headers });
	}
	return new Response(body, { status: 200, headers });
}

/** Wraps every GET of a route table (Bun.serve's shape) in withEtag. */
export function etagRoutes<T extends Record<string, unknown>>(routes: T): T {
	type Handler = (req: Request, srv: unknown) => Response | Promise<Response>;
	const wrap = (h: Handler): Handler => async (req, srv) => withEtag(req, await h(req, srv));
	for (const [path, v] of Object.entries(routes)) {
		if (typeof v === "function") (routes as Record<string, unknown>)[path] = wrap(v as Handler);
		else if (v && typeof v === "object" && !(v instanceof Response) && typeof (v as { GET?: unknown }).GET === "function") {
			const byMethod = v as Record<string, Handler>;
			byMethod.GET = wrap(byMethod.GET);
		}
	}
	return routes;
}

/** The page with each /ui/<file> it loads named by its version (its hash): /ui/board.js?v=…. */
export function versionedPage(html: string, versions: Record<string, string>) {
	return html.replace(/((?:href|src)="\/ui\/)([^"?#]+)"/g, (m, start: string, name: string) =>
		versions[name] ? `${start}${name}?v=${versions[name]}"` : m,
	);
}

/** The /ui/ files a page loads. */
export const pageFiles = (html: string) => [...new Set([...html.matchAll(/(?:href|src)="\/ui\/([^"?#]+)/g)].map((m) => m[1]))];
