// The board's HTTP side, on a real server: a subprocess on port 4401 with its own throwaway database and home folder
// (so it never reads the real board or Claude's transcripts), stopped when the tests end.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";

const PORT = Number(process.env.WB_PORT); // from the preload (WB_TEST_PORT, default 4401)
const BASE = `http://127.0.0.1:${PORT}`;
const dir = mkdtempSync(join(process.env.WB_TEST_DIR!, "server-"));
let proc: ReturnType<typeof Bun.spawn>;

beforeAll(async () => {
	mkdirSync(join(dir, "home"));
	mkdirSync(join(dir, "run"));
	proc = Bun.spawn(["bun", join(import.meta.dir, "..", "src", "server.ts")], {
		cwd: dir,
		env: {
			...process.env,
			WB_DB: join(dir, "workbench.db"),
			WB_BACKUPS: join(dir, "backups"),
			WB_PORT: String(PORT),
			HOME: join(dir, "home"),
			XDG_RUNTIME_DIR: join(dir, "run"),
			XDG_CONFIG_HOME: join(dir, "config"),
		},
		stdout: "ignore",
		stderr: "ignore",
	});
	for (let i = 0; i < 100; i++) {
		try {
			if ((await fetch(`${BASE}/api/ping`)).ok) return;
		} catch {}
		await Bun.sleep(100);
	}
	throw new Error("the test server didn't start");
});

afterAll(() => {
	proc?.kill();
});

const post = (path: string, body: string, type?: string) =>
	fetch(BASE + path, { method: "POST", headers: type ? { "content-type": type } : {}, body });

describe("server", () => {
	test("ping says which database it uses", async () => {
		const r = (await (await fetch(`${BASE}/api/ping`)).json()) as { app: string; db: string };
		expect(r.app).toBe("workbench");
		expect(r.db).toBe(join(dir, "workbench.db"));
	});

	test("a write as JSON works, and the item shows in the list", async () => {
		const made = await post("/api/projects", JSON.stringify({ slug: "demo", name: "Demo", path: dir }), "application/json");
		expect(made.status).toBe(201);
		const res = await post("/api/items", JSON.stringify({ title: "From a test", project: "demo" }), "application/json");
		expect(res.status).toBe(201);
		const items = (await (await fetch(`${BASE}/api/items?project=demo`)).json()) as { title: string }[];
		expect(items.map((i) => i.title)).toEqual(["From a test"]);
	});

	test("a poll that finds nothing new gets 304 and no body; a change gets the new answer", async () => {
		const first = await fetch(`${BASE}/api/items?project=demo`);
		const tag = first.headers.get("etag")!;
		expect(tag).toMatch(/^"[\w-]+"$/);
		expect(first.headers.get("cache-control")).toBe("no-store");
		const same = await fetch(`${BASE}/api/items?project=demo`, { headers: { "if-none-match": tag } });
		expect(same.status).toBe(304);
		expect(await same.text()).toBe("");
		await post("/api/items", JSON.stringify({ title: "Another", project: "demo" }), "application/json");
		const changed = await fetch(`${BASE}/api/items?project=demo`, { headers: { "if-none-match": tag } });
		expect(changed.status).toBe(200);
		expect(changed.headers.get("etag")).not.toBe(tag);
		expect(((await changed.json()) as unknown[]).length).toBe(2);
	});

	test("bodies=open leaves out the details of closed items only", async () => {
		const [a, b] = (await (await fetch(`${BASE}/api/items?project=demo`)).json()) as { id: number }[];
		const patch = (id: number, p: object) => fetch(`${BASE}/api/items/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(p) });
		await patch(a.id, { body: "open details" });
		await patch(b.id, { body: "closed details", status: "done" });
		const items = (await (await fetch(`${BASE}/api/items?project=demo&bodies=open`)).json()) as { id: number; body?: string }[];
		expect(items.find((i) => i.id === a.id)!.body).toBe("open details");
		expect("body" in items.find((i) => i.id === b.id)!).toBe(false);
		expect(((await (await fetch(`${BASE}/api/items/${b.id}`)).json()) as { body: string }).body).toBe("closed details");
	});

	test("the page names its files by version, and a versioned file is kept for good", async () => {
		const page = await fetch(`${BASE}/`);
		expect(page.headers.get("cache-control")).toBe("no-cache");
		const html = await page.text();
		const m = html.match(/src="\/ui\/router\.js\?v=([\w-]+)"/);
		expect(m).not.toBeNull();
		expect(html).not.toMatch(/(?:href|src)="\/ui\/[^"?]+"/);
		const again = await fetch(`${BASE}/`, { headers: { "if-none-match": page.headers.get("etag")! } });
		expect(again.status).toBe(304);
		const kept = await fetch(`${BASE}/ui/router.js?v=${m![1]}`);
		expect(kept.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
		expect(await kept.text()).toContain("function defineView");
		expect((await fetch(`${BASE}/ui/router.js`)).headers.get("cache-control")).toBe("no-cache");
	});

	test("the write guard: a write that isn't JSON gets 415 and changes nothing", async () => {
		const body = JSON.stringify({ title: "Sneaky", project: "demo" });
		for (const type of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x", undefined]) {
			const res = await post("/api/items", body, type);
			expect(res.status).toBe(415);
			expect(((await res.json()) as { error: string }).error).toContain("JSON");
		}
		const items = (await (await fetch(`${BASE}/api/items?project=demo`)).json()) as { title: string }[];
		expect(items.map((i) => i.title)).not.toContain("Sneaky");
		const patch = await fetch(`${BASE}/api/settings`, { method: "PATCH", headers: { "content-type": "text/plain" }, body: "{}" });
		expect(patch.status).toBe(415);
	});

	test("a localhost-only route answers localhost and refuses another Host", async () => {
		const ok = await fetch(`${BASE}/api/settings/folders`);
		expect(ok.status).toBe(200);
		// A page on another name that points at this computer (DNS rebinding) sends its own Host.
		const evil = await fetch(`${BASE}/api/settings/folders`, { headers: { host: "evil.example.com" } });
		expect(evil.status).toBe(403);
		expect(((await evil.json()) as { error: string }).error).toContain("localhost");
		expect((await fetch(`${BASE}/api/settings/health`, { headers: { host: `evil.example.com:${PORT}` } })).status).toBe(403);
		// and one that says it's another site's request
		expect((await fetch(`${BASE}/api/settings/folders`, { headers: { "sec-fetch-site": "cross-site" } })).status).toBe(403);
	});

	test("queue mode: the queue, deferring and giving back, as JSON only", async () => {
		const add = async (title: string) =>
			((await (await post("/api/items", JSON.stringify({ title, project: "demo", kind: "review", owner: "kostas" }), "application/json")).json()) as { id: number }).id;
		const a = await add("Queue: first"), b = await add("Queue: second");
		const queue = async () => (await (await fetch(`${BASE}/api/queue?project=demo`)).json()) as { items: { id: number }[]; deferred: { id: number }[] };
		expect((await queue()).items.map((i) => i.id)).toEqual(expect.arrayContaining([a, b]));
		expect((await post(`/api/items/${a}/defer`, JSON.stringify({ until: "tomorrow" }), "text/plain")).status).toBe(415);
		const d = await post(`/api/items/${a}/defer`, JSON.stringify({ until: "tomorrow" }), "application/json");
		expect(((await d.json()) as { deferred_until: string }).deferred_until).toBeTruthy();
		const g = await post(`/api/items/${b}/give-back`, JSON.stringify({ text: "" }), "application/json");
		expect(((await g.json()) as { owner: string }).owner).toBe("agent");
		const q = await queue();
		expect(q.items.map((i) => i.id)).not.toContain(a);
		expect(q.items.map((i) => i.id)).not.toContain(b);
		expect(q.deferred.map((i) => i.id)).toEqual([a]);
		expect((await post(`/api/items/${a}/defer`, JSON.stringify({ until: "someday" }), "application/json")).status).toBe(400);
	});

	test("a run's events, and Continue, over HTTP (a fake agent: nothing runs the real claude)", async () => {
		const fake = join(dir, "fake-agent");
		const { writeFileSync, chmodSync } = await import("node:fs");
		writeFileSync(
			fake,
			`#!/usr/bin/env bash
sid="\${WB_RESUME:-$WB_SESSION}"
echo '{"type":"system","subtype":"init","session_id":"'"$sid"'","model":"m","cwd":"'"$PWD"'"}'
echo '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Edit","input":{"file_path":"'"$PWD"'/a.ts"}}]}}'
echo '{"type":"result","subtype":"success","is_error":false,"total_cost_usd":0.1,"duration_ms":10,"result":"ok","session_id":"'"$sid"'"}'
`,
		);
		chmodSync(fake, 0o755);
		const json = (b: unknown) => JSON.stringify(b);
		const patch = await fetch(`${BASE}/api/settings`, {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: json({ "agents.on": true, "agents.command": `${fake} -p "$WB_PROMPT" --session-id "$WB_SESSION"` }),
		});
		expect(patch.status).toBe(200);
		const item = (await (await post("/api/items", json({ title: "Run me", project: "demo", owner: "agent" }), "application/json")).json()) as { id: number };
		type Run = { id: number; ended_at: string | null; session: string; desktop: string; continues: number | null; cwd: string };
		type Events = { run: Run; events: { n: number; kind: string; text: string }[]; next: number };
		const started = await post("/api/runs", json({ item: String(item.id) }), "application/json");
		expect(started.status).toBe(201);
		const { run } = (await started.json()) as { run: Run };
		let got: Events | undefined;
		for (let n = 0; n < 100 && !got?.run.ended_at; n++) {
			await Bun.sleep(100);
			got = (await (await fetch(`${BASE}/api/runs/${run.id}/events`)).json()) as Events;
		}
		expect(got!.events.map((e) => [e.kind, e.text])).toEqual([
			["start", `Started with m in ${dir}`],
			["tool", "Edit a.ts"],
			["result", "ok"],
		]);
		expect(got!.next).toBe(3);
		expect(got!.run.desktop).toBe(`claude://resume?session=${run.session}`);
		expect(((await (await fetch(`${BASE}/api/runs/${run.id}/events?after=3`)).json()) as Events).events).toEqual([]);
		expect((await fetch(`${BASE}/api/runs/99999/events`)).status).toBe(404);
		// Continue: JSON only, a message needed, then a new run on the same session.
		expect((await post(`/api/runs/${run.id}/continue`, json({ message: "more" }), "text/plain")).status).toBe(415);
		expect((await post(`/api/runs/${run.id}/continue`, json({ message: "" }), "application/json")).status).toBe(400);
		const c = await post(`/api/runs/${run.id}/continue`, json({ message: "And the docs." }), "application/json");
		expect(c.status).toBe(201);
		const next = ((await c.json()) as { run: Run }).run;
		expect(next).toMatchObject({ continues: run.id, session: run.session });
		let after: Events | undefined;
		for (let n = 0; n < 100 && !after?.run.ended_at; n++) {
			await Bun.sleep(100);
			after = (await (await fetch(`${BASE}/api/runs/${next.id}/events`)).json()) as Events;
		}
		expect(after!.events.map((e) => e.kind)).toEqual(["message", "start", "tool", "result"]);
		expect(after!.events[0].text).toBe("And the docs.");
		// An item whose session is a Claude Code session carries its Desktop link.
		expect((await fetch(`${BASE}/api/items/${item.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: json({ session: run.session }) })).status).toBe(200);
		const i = (await (await fetch(`${BASE}/api/items/${item.id}`)).json()) as { session: string; desktop?: string };
		expect(i.desktop).toBe(`claude://resume?session=${run.session}`);
	});

	test("/mcp answers a JSON-RPC call on localhost and refuses another Host", async () => {
		const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" });
		const ok = await fetch(`${BASE}/mcp`, { method: "POST", headers: { "content-type": "application/json", host: `localhost:${PORT}` }, body });
		expect(ok.status).toBe(200);
		const evil = await fetch(`${BASE}/mcp`, { method: "POST", headers: { "content-type": "application/json", host: "evil.example.com" }, body });
		expect(evil.status).toBe(403);
	});
});

describe("the order of a project's agent work", () => {
	const put = (path: string, body: unknown) =>
		fetch(BASE + path, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
	test("PUT /api/projects/:slug/order sets it, and /api/items lists in it", async () => {
		await post("/api/projects", JSON.stringify({ slug: "ord", name: "Ord", path: dir }), "application/json");
		const refs: string[] = [];
		for (const t of ["first", "second", "third"]) {
			const r = await post("/api/items", JSON.stringify({ title: t, project: "ord", kind: "task", owner: "agent" }), "application/json");
			const id = ((await r.json()) as { id: number }).id;
			refs.push("wb-" + ((await (await fetch(`${BASE}/api/items/${id}`)).json()) as { ref: string }).ref);
		}
		const r = await put("/api/projects/ord/order", { refs: [refs[2], refs[0]] });
		expect(r.status).toBe(200);
		expect(((await r.json()) as { refs: string[] }).refs).toEqual([refs[2], refs[0], refs[1]]);
		const items = (await (await fetch(`${BASE}/api/items?project=ord&owner=agent`)).json()) as { title: string }[];
		expect(items.map((i) => i.title)).toEqual(["third", "first", "second"]);
		expect((await put("/api/projects/ord/order", { refs: ["wb-nope"] })).status).toBe(400);
		expect((await put("/api/projects/nowhere/order", { refs: [] })).status).toBe(404);
		expect((await fetch(BASE + "/api/projects/ord/order", { method: "PUT", body: "{}" })).status).toBe(415);
	});
});
