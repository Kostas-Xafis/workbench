/**
 * `wb mcp` while this computer syncs (sync.ts): the MCP server's stdio, relayed to the cloud board's /mcp, so the
 * agents' configuration (`claude mcp add -s user wb -- wb mcp`) stays as it is. Each JSON-RPC message from stdin
 * goes in its own POST with this computer's device token; each answer comes back out on stdout.
 *
 * - The default project is the one whose folder the client started in, as with the local server: the cloud board's
 *   projects keep the folders they had on this computer.
 * - Over HTTP every request names its protocol revision in headers (mcp.ts). A 2026-07-28 request mirrors its
 *   `_meta` into them; a legacy one sends the revision `initialize` agreed.
 * - A picture given as a file (attach_image, add_item's images) is a path on this computer: the relay reads it and
 *   sends its bytes instead, since the cloud board has no files.
 */
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { cloudFetch, type SyncConfig } from "./sync";

const M = "io.modelcontextprotocol/";
const MAX_IMAGE = 20 * 1024 * 1024;
type Msg = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown>; result?: Record<string, unknown> };

const headerValue = (v: string) => (/^[\x20-\x7e]*$/.test(v) ? v : `=?base64?${Buffer.from(v).toString("base64")}?=`);

/** A path to a picture, as the MCP server takes it (images.ts), read here and sent as base64. */
function inlineImage(src: Record<string, unknown>) {
	if (typeof src.path !== "string" || !src.path.trim() || src.data) return src;
	const path = resolve(src.path.trim().replace(/^~(?=\/|$)/, homedir()));
	let size = 0;
	try {
		size = statSync(path).size;
	} catch {
		throw new Error(`no file at ${path}`);
	}
	if (size > MAX_IMAGE) throw new Error(`${path} is over ${MAX_IMAGE / 1024 / 1024} MB`);
	const { path: _, ...rest } = src;
	return { ...rest, data: readFileSync(path).toString("base64") };
}

function withImages(m: Msg): Msg {
	if (m.method !== "tools/call" || !m.params) return m;
	const name = m.params.name;
	const a = m.params.arguments as Record<string, unknown> | undefined;
	if (!a) return m;
	if (name === "attach_image") return { ...m, params: { ...m.params, arguments: inlineImage(a) } };
	if (name === "add_item" && Array.isArray(a.images))
		return { ...m, params: { ...m.params, arguments: { ...a, images: a.images.map((i) => (i && typeof i === "object" ? inlineImage(i as Record<string, unknown>) : i)) } } };
	return m;
}

/** The slug of the project whose folder `dir` is in (the deepest), as projectForPath in db.ts. */
async function projectFor(cfg: SyncConfig, dir: string) {
	try {
		const list = (await (await cloudFetch(cfg, "/api/projects")).json()) as { slug: string; path: string }[];
		return list
			.filter((p) => p.path && (dir === p.path || dir.startsWith(`${p.path}/`)))
			.sort((a, b) => b.path.length - a.path.length)[0]?.slug;
	} catch {
		return undefined;
	}
}

export async function relay(cfg: SyncConfig) {
	const project = await projectFor(cfg, process.cwd());
	const endpoint = `/mcp${project ? `?project=${encodeURIComponent(project)}` : ""}`;
	let agreed: string | undefined;
	const write = (m: unknown) => process.stdout.write(`${JSON.stringify(m)}\n`);
	const failed = (m: Msg, message: string) => {
		if (m.id !== undefined && m.id !== null) write({ jsonrpc: "2.0", id: m.id, error: { code: -32000, message } });
	};

	const send = async (raw: Msg) => {
		let m = raw;
		try {
			m = withImages(raw);
		} catch (e) {
			return failed(raw, (e as Error).message);
		}
		const headers: Record<string, string> = { accept: "application/json, text/event-stream" };
		const meta = ((m.params?._meta ?? {}) as Record<string, unknown>)[`${M}protocolVersion`];
		if (typeof meta === "string") {
			headers["mcp-protocol-version"] = meta;
			if (m.method) headers["mcp-method"] = m.method;
			const target = m.method === "resources/read" ? m.params?.uri : m.params?.name;
			if (["tools/call", "prompts/get", "resources/read"].includes(String(m.method)) && typeof target === "string") headers["mcp-name"] = headerValue(target);
		} else if (agreed && m.method !== "initialize") headers["mcp-protocol-version"] = agreed;
		let res: Response;
		try {
			res = await fetch(new URL(endpoint, cfg.url), {
				method: "POST",
				headers: { ...headers, authorization: `Bearer ${cfg.token}`, "content-type": "application/json" },
				body: JSON.stringify(m),
			});
		} catch (e) {
			return failed(m, `can't reach the cloud board at ${cfg.url}: ${(e as Error).message}`);
		}
		if (res.status === 202) return;
		// The MCP server's own errors come as JSON-RPC with a 4xx: those go back as they are. Anything else is the gate's.
		if (!res.ok && !(res.headers.get("content-type") ?? "").includes("json")) return failed(m, `the cloud board said ${res.status}`);
		if ((res.headers.get("content-type") ?? "").startsWith("text/event-stream")) {
			// subscriptions/listen: every event's data is a message.
			const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
			let buf = "";
			for (;;) {
				const { value, done } = await reader.read();
				if (done) break;
				buf += value;
				for (let i = buf.indexOf("\n\n"); i >= 0; i = buf.indexOf("\n\n")) {
					const event = buf.slice(0, i);
					buf = buf.slice(i + 2);
					const data = event
						.split("\n")
						.filter((l) => l.startsWith("data:"))
						.map((l) => l.slice(5).trimStart())
						.join("\n");
					if (data) write(JSON.parse(data));
				}
			}
			return;
		}
		const body = (await res.json()) as Msg | Msg[] | { error?: string };
		if (!res.ok && !Array.isArray(body) && !("jsonrpc" in body)) return failed(m, `the cloud board said ${res.status}: ${(body as { error?: string }).error ?? ""}`);
		for (const r of (Array.isArray(body) ? body : [body]) as Msg[]) {
			if (m.method === "initialize" && typeof r.result?.protocolVersion === "string") agreed = r.result.protocolVersion;
			write(r);
		}
	};

	const pending = new Set<Promise<void>>();
	const take = (line: string) => {
		if (!line.trim()) return;
		let m: Msg | Msg[];
		try {
			m = JSON.parse(line);
		} catch {
			return write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
		}
		for (const one of Array.isArray(m) ? m : [m]) {
			const p = send(one).catch((e) => failed(one, (e as Error).message));
			pending.add(p);
			p.finally(() => pending.delete(p));
		}
	};
	const decoder = new TextDecoder();
	let buf = "";
	for await (const chunk of Bun.stdin.stream()) {
		buf += decoder.decode(chunk, { stream: true });
		for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
			take(buf.slice(0, nl));
			buf = buf.slice(nl + 1);
		}
	}
	take(buf);
	await Promise.allSettled([...pending]);
}
