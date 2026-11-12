// The board's HTTP side, on a real server: a subprocess on port 4401 with its own throwaway database and home folder
// (so it never reads the real board or Claude's transcripts), stopped when the tests end.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";

const PORT = 4401;
const BASE = `http://127.0.0.1:${PORT}`;
const dir = mkdtempSync(join(process.env.WB_TEST_DIR!, "server-"));
let proc: ReturnType<typeof Bun.spawn>;

beforeAll(async () => {
	mkdirSync(join(dir, "home"));
	mkdirSync(join(dir, "run"));
	proc = Bun.spawn(["bun", join(import.meta.dir, "..", "server.ts")], {
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
		expect((await fetch(`${BASE}/api/settings/health`, { headers: { host: "evil.example.com:4401" } })).status).toBe(403);
		// and one that says it's another site's request
		expect((await fetch(`${BASE}/api/settings/folders`, { headers: { "sec-fetch-site": "cross-site" } })).status).toBe(403);
	});

	test("/mcp answers a JSON-RPC call on localhost and refuses another Host", async () => {
		const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" });
		const ok = await fetch(`${BASE}/mcp`, { method: "POST", headers: { "content-type": "application/json", host: `localhost:${PORT}` }, body });
		expect(ok.status).toBe(200);
		const evil = await fetch(`${BASE}/mcp`, { method: "POST", headers: { "content-type": "application/json", host: "evil.example.com" }, body });
		expect(evil.status).toBe(403);
	});
});
