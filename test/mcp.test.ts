// Drives the MCP server like a client does: JSON-RPC over the same HTTP entry the board serves at /mcp.
import { describe, expect, test } from "bun:test";
import { getItem, resolveItem } from "../db";
import { mcpHttp } from "../mcp";
import { freshDb } from "./helpers";

const db = freshDb();
let nextId = 1;

/** One JSON-RPC request; the reply's `result` (or the whole reply when it is an error). */
async function rpc(method: string, params: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
	const req = new Request("http://localhost:4401/mcp?project=demo", {
		method: "POST",
		headers: { "content-type": "application/json", host: "localhost:4401", "mcp-protocol-version": "2025-06-18", ...headers },
		body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
	});
	const res = await mcpHttp(req, db, { loopback: true });
	return { status: res.status, body: (await res.json()) as any };
}

/** tools/call: the tool's text, its structured data and whether it failed. */
async function call(name: string, args: Record<string, unknown> = {}) {
	const { body } = await rpc("tools/call", { name, arguments: args });
	const r = body.result;
	return { text: r.content[0].text as string, data: r.structuredContent as any, error: r.isError as boolean };
}

const BRIEF = "This is a task for the next agent: add the thing, because the board needs it, and say when done.";

describe("handshake", () => {
	test("initialize answers with a revision, server info and instructions", async () => {
		const { status, body } = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
		expect(status).toBe(200);
		expect(body.result.protocolVersion).toBe("2025-06-18");
		expect(body.result.serverInfo.name).toBeTruthy();
		expect(body.result.capabilities.tools).toBeDefined();
		expect(body.result.instructions).toContain("wb-");
	});
	test("server/discover lists the supported versions", async () => {
		const v = "2026-07-28";
		const { body } = await rpc(
			"server/discover",
			{ _meta: { "io.modelcontextprotocol/protocolVersion": v } },
			{ "mcp-protocol-version": v, "mcp-method": "server/discover" },
		);
		expect(body.result.supportedVersions).toContain(v);
		expect(body.result.supportedVersions).toContain("2025-06-18");
		expect(body.result.resultType).toBe("complete");
	});
	test("an unknown method is an error, a notification gets 202", async () => {
		expect((await rpc("no/such")).body.error.code).toBe(-32601);
		const res = await mcpHttp(
			new Request("http://localhost:4401/mcp", {
				method: "POST",
				headers: { "content-type": "application/json", host: "localhost:4401" },
				body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
			}),
			db,
			{ loopback: true },
		);
		expect(res.status).toBe(202);
	});
	test("a non-JSON write and a foreign Host are refused", async () => {
		const text = await mcpHttp(new Request("http://localhost:4401/mcp", { method: "POST", headers: { "content-type": "text/plain", host: "localhost:4401" }, body: "{}" }), db, { loopback: true });
		expect(text.status).toBe(415);
		const host = await mcpHttp(new Request("http://evil.test/mcp", { method: "POST", headers: { "content-type": "application/json", host: "evil.test" }, body: "{}" }), db, { loopback: true });
		expect(host.status).toBe(403);
		const far = await mcpHttp(new Request("http://localhost:4401/mcp", { method: "POST", headers: { "content-type": "application/json", host: "localhost:4401" }, body: "{}" }), db, { loopback: false });
		expect(far.status).toBe(403);
	});
});

describe("tools/list", () => {
	test("every tool has a schema, and read-only ones say so", async () => {
		const { body } = await rpc("tools/list");
		const tools = body.result.tools as { name: string; description: string; inputSchema: any; annotations?: Record<string, boolean> }[];
		const names = tools.map((t) => t.name);
		for (const n of ["add_item", "get_item", "list_items", "start_item", "finish_item", "answer_decision", "search", "record_tracker"])
			expect(names).toContain(n);
		for (const t of tools) {
			expect(t.description.length).toBeGreaterThan(10);
			expect(t.inputSchema.type).toBe("object");
			expect(typeof t.annotations?.readOnlyHint).toBe("boolean");
		}
		const by = Object.fromEntries(tools.map((t) => [t.name, t]));
		for (const n of ["get_item", "list_items", "search", "list_projects", "list_trackers"]) expect(by[n].annotations!.readOnlyHint).toBe(true);
		for (const n of ["add_item", "start_item", "finish_item", "answer_decision", "drop_item"]) expect(by[n].annotations!.readOnlyHint).toBe(false);
	});
	test("the owner and name placeholders are filled in", async () => {
		const { body } = await rpc("tools/list");
		expect(JSON.stringify(body.result.tools)).not.toContain("{{");
	});
});

describe("item round trip", () => {
	test("add_item, get_item, start_item, finish_item", async () => {
		const added = await call("add_item", { title: "Add the thing", body: BRIEF });
		expect(added.error).toBe(false);
		const ref = added.data.item.ref as string;
		expect(ref).toMatch(/^wb-[a-z0-9]{4}$/);
		expect(added.data.item).toMatchObject({ project: "demo", kind: "task", owner: "agent", status: "todo" });
		expect(added.data.warnings).toBeUndefined();

		const got = await call("get_item", { ref });
		expect(got.data.item).toMatchObject({ title: "Add the thing", body: BRIEF });
		expect(got.data.item.notes.map((n: any) => n.text)).toEqual(["created"]);

		const started = await call("start_item", { ref: ref.slice(3), branch: "feat/thing" });
		expect(started.data.item).toMatchObject({ status: "doing", branch: "feat/thing" });

		const done = await call("finish_item", { ref, note: "abc123 on feat/thing: done" });
		expect(done.data.item.status).toBe("done");
		const after = (await call("get_item", { ref })).data.item;
		expect(after.notes.map((n: any) => n.text)).toContain("abc123 on feat/thing: done");
		// and it is in the database the board reads
		expect(getItem(db, resolveItem(db, ref)!)!.status).toBe("done");
	});
	test("a bad ref and a bad argument are tool errors the model can read", async () => {
		const missing = await call("get_item", { ref: "wb-zzzz" });
		expect(missing.error).toBe(true);
		expect(missing.text).toMatch(/zzzz|no item/i);
		const bad = await call("add_item", { title: "x", priority: 7 });
		expect(bad.error).toBe(true);
		const unknown = await rpc("tools/call", { name: "no_such_tool", arguments: {} });
		expect(unknown.body.error.code).toBe(-32602);
	});
	test("list_items and search find it", async () => {
		await call("add_item", { title: "Find me by the word quokka", body: BRIEF });
		const list = await call("list_items", { q: "quokka" });
		expect(list.data.total).toBe(1);
		const found = await call("search", { q: "quokka" });
		expect(found.text).toContain("quokka");
	});
});

describe("add_item's brief checks", () => {
	test("an empty brief for Kostas is refused and nothing is filed", async () => {
		const before = (await call("list_items", { owner: "kostas" })).data.total;
		const r = await call("add_item", { title: "Pick a colour", kind: "decision", options: ["Red", "Blue"] });
		expect(r.error).toBe(true);
		expect(r.text).toContain("Nothing was filed");
		expect((await call("list_items", { owner: "kostas" })).data.total).toBe(before);
	});
	test("a brief that points at a .md file is saved with a warning", async () => {
		const r = await call("add_item", {
			title: "Choose the wording",
			kind: "review",
			body: "Review the wording of the welcome page. See docs/welcome.md for the text and the open questions.",
		});
		expect(r.error).toBe(false);
		expect(r.data.item.owner).toBe("kostas");
		expect(r.data.warnings.some((w: string) => w.includes("docs/welcome.md"))).toBe(true);
		expect(r.text).toContain("It's saved");
	});
	test("a decision without a recommendation gets a warning; options make it a decision", async () => {
		const r = await call("add_item", { title: "Which colour", options: ["Red", "Blue"], body: "We need a colour for the button. Red is loud and blue is calm; pick one." });
		expect(r.data.item.kind).toBe("decision");
		expect(r.data.item.owner).toBe("kostas");
		expect(r.data.warnings.join(" ")).toContain("recommendation");
	});
	test("an internal code in the title gets a warning", async () => {
		const r = await call("add_item", { title: "Do M7 now", body: BRIEF });
		expect(r.data.warnings.join(" ")).toContain("M7");
	});
});

describe("answer_decision", () => {
	test("an option's number picks it and hands the item back to the agent", async () => {
		const added = await call("add_item", {
			title: "Which colour for the button",
			options: ["Red", "Blue"],
			body: "The button needs a colour. Red is loud, blue is calm. I recommend blue because it matches the logo.",
		});
		const ref = added.data.item.ref;
		const r = await call("answer_decision", { ref, answer: "2" });
		expect(r.error).toBe(false);
		const item = (await call("get_item", { ref })).data.item;
		expect(item).toMatchObject({ answer: "Blue", owner: "agent", status: "todo" });
	});
	test("an unknown item is an error", async () => {
		expect((await call("answer_decision", { ref: "wb-zzzz", answer: "x" })).error).toBe(true);
	});
});
