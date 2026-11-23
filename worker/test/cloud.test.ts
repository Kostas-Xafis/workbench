// The cloud board on a real (local) Worker: `wrangler dev` with its own throwaway Durable Object storage, started
// here and stopped at the end. Run from worker/: `bun test` (CI: .github/workflows/worker.yml).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { addItem, addNote, getItem, listItems, open, publishReport, reportHtml, upsertProject, PART_CHARS, DB_PATH } from "../../src/db";
import { addImage } from "../../src/images";
import { cloudLogin, readSync, syncOff, syncOn } from "../../src/sync";

const PORT = Number(process.env.WB_CLOUD_TEST_PORT ?? 8797);
const BASE = `http://127.0.0.1:${PORT}`;
const KEY = "test-owner-key";
const dir = process.env.WB_TEST_DIR!;
let proc: ReturnType<typeof Bun.spawn>;
let token = "";

const api = (path: string, init: RequestInit = {}, auth = token) =>
	fetch(`${BASE}${path}`, {
		...init,
		redirect: "manual",
		headers: { ...(auth ? { authorization: `Bearer ${auth}` } : {}), ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers },
	});

beforeAll(async () => {
	mkdirSync(join(dir, "state"), { recursive: true });
	proc = Bun.spawn(
		[join(import.meta.dir, "..", "node_modules", ".bin", "wrangler"), "dev", "--ip", "127.0.0.1", "--port", String(PORT), "--var", `WB_OWNER_KEY:${KEY}`, "--persist-to", join(dir, "state"), "--show-interactive-dev-session=false"],
		{ cwd: join(import.meta.dir, ".."), env: { ...process.env, WRANGLER_SEND_METRICS: "false" }, stdout: "ignore", stderr: "pipe" },
	);
	for (let i = 0; i < 300; i++) {
		try {
			if ((await fetch(`${BASE}/api/ping`)).ok) return;
		} catch {}
		await Bun.sleep(100);
	}
	throw new Error(`the local Worker didn't start: ${await new Response(proc.stderr as ReadableStream).text()}`);
});

afterAll(() => {
	proc?.kill();
});

describe("getting in", () => {
	test("the ping says it's a cloud board, and nothing else answers without a device", async () => {
		expect(await (await api("/api/ping")).json()).toMatchObject({ app: "workbench", cloud: true, sync: 1, claimed: false });
		expect((await api("/api/items")).status).toBe(401);
		const page = await api("/", { headers: { accept: "text/html" } });
		expect(page.status).toBe(302);
		expect(page.headers.get("location")).toBe("/pair");
		expect((await api("/ui/core.js")).status).toBe(401);
		// What a phone needs to pair answers anyway.
		expect((await api("/pair")).status).toBe(200);
		expect((await api("/icons/icon-256.png")).headers.get("content-type")).toBe("image/png");
	});

	test("the owner key gets the first device; a wrong one gets nothing", async () => {
		expect((await api("/api/sync/claim", { method: "POST", body: JSON.stringify({ key: "nope" }) })).status).toBe(403);
		const res = await api("/api/sync/claim", { method: "POST", body: JSON.stringify({ key: KEY, name: "Test laptop" }) });
		expect(res.status).toBe(201);
		const body = (await res.json()) as { token: string; device: { name: string } };
		expect(body.device.name).toBe("Test laptop");
		token = body.token;
		expect((await api("/api/items")).status).toBe(200);
		expect(((await (await api("/api/ping")).json()) as { claimed: boolean }).claimed).toBe(true);
	});

	test("a pairing code gives a browser its cookie, and the page knows it's the cloud board", async () => {
		const made = (await (await api("/api/devices/pairing", { method: "POST", body: "{}" })).json()) as { pairing: { code: string } };
		const paired = await api("/api/pair", { method: "POST", body: JSON.stringify({ code: made.pairing.code, name: "Phone" }) }, "");
		expect(paired.status).toBe(201);
		const cookie = paired.headers.get("set-cookie") ?? "";
		expect(cookie).toMatch(/^wb_device=[\w-]+;.*HttpOnly; Secure; SameSite=Strict/);
		const page = await api("/", { headers: { cookie: cookie.split(";")[0] } }, "");
		expect(page.status).toBe(200);
		expect(await page.text()).toContain('<html data-cloud="1"');
		// Used up.
		expect((await api("/api/pair", { method: "POST", body: JSON.stringify({ code: made.pairing.code }) }, "")).status).toBe(400);
	});

	test("a login ticket signs a browser in once", async () => {
		const res = await api("/api/sync/ticket", { method: "POST", body: JSON.stringify({ name: "App" }) });
		const { url } = (await res.json()) as { url: string };
		const first = await fetch(`${url}&next=%2F`, { redirect: "manual" });
		expect(first.status).toBe(200);
		expect(first.headers.get("set-cookie")).toMatch(/^wb_device=/);
		expect(await first.text()).toContain('http-equiv="refresh" content="0; url=/"');
		const again = await fetch(url, { redirect: "manual" });
		expect(again.headers.get("location")).toBe("/pair?next=%2F");
		// A page can't make one: it takes the token in a header, and no Origin.
		expect((await api("/api/sync/ticket", { method: "POST", body: "{}", headers: { origin: BASE } })).status).toBe(403);
	});
});

describe("the board", () => {
	test("projects, items and notes, with the board's own rules", async () => {
		expect((await api("/api/projects", { method: "POST", body: JSON.stringify({ slug: "demo", name: "Demo", path: "/home/me/demo" }) })).status).toBe(201);
		const added = await api("/api/items", { method: "POST", body: JSON.stringify({ project: "demo", title: "From the cloud", kind: "decision", options: ["A", "B"] }) });
		expect(added.status).toBe(201);
		const items = (await (await api("/api/items?project=demo")).json()) as { ref: string; owner: string }[];
		expect(items).toHaveLength(1);
		expect(items[0].owner).toBe("kostas");
		const answered = await api(`/api/items/${items[0].ref}/answer`, { method: "POST", body: JSON.stringify({ answer: "2" }) });
		expect(((await answered.json()) as { answer: string; owner: string }).answer).toBe("B");
		// Writes are JSON only, as on a computer.
		expect((await api("/api/items", { method: "POST", body: "x", headers: { "content-type": "text/plain" } })).status).toBe(415);
	});

	test("what needs a computer says so; what the page polls for comes back empty", async () => {
		const usage = await api("/api/usage");
		expect(usage.status).toBe(501);
		expect(((await usage.json()) as { error: string }).error).toContain("needs a computer");
		expect(await (await api("/api/git")).json()).toEqual([]);
		expect((await api("/api/runs", { method: "POST", body: JSON.stringify({ item: "x" }) })).status).toBe(501);
		expect(((await (await api("/api/runs")).json()) as { allowed: boolean }).allowed).toBe(false);
		expect((await api("/api/projects/demo/logo")).status).toBe(404);
	});

	test("MCP over HTTP with the device token; never from a page", async () => {
		const call = (body: unknown, headers: Record<string, string> = {}) =>
			api("/mcp?project=demo", { method: "POST", body: JSON.stringify(body), headers: { accept: "application/json, text/event-stream", ...headers } });
		const init = await call({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
		expect(((await init.json()) as { result: { serverInfo: { name: string } } }).result.serverInfo.name).toBe("workbench");
		const list = await call({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list_items", arguments: { status: "all" } } }, { "mcp-protocol-version": "2025-06-18" });
		expect(JSON.stringify(await list.json())).toContain("From the cloud");
		expect((await call({ jsonrpc: "2.0", id: 3, method: "tools/list" }, { origin: "https://example.com" })).status).toBe(403);
		expect((await api("/mcp", { method: "POST", body: "{}" }, "")).status).toBe(401);
	});
});

describe("sync on and off", () => {
	test("a board goes up whole (ids, notes, a long page in parts, a picture), and comes back with what changed", async () => {
		// This computer's board: its own project, items, a page longer than a cloud row, a picture.
		const db = open();
		upsertProject(db, { slug: "mine", name: "Mine", path: "/home/me/mine" });
		const id = addItem(db, { project: "mine", title: "Made on this computer" }, "kostas");
		addNote(db, id, "a note from here", "kostas");
		const long = `<!doctype html><title>Long</title><p>${"Ελληνικά καὶ English. ".repeat(Math.ceil((PART_CHARS * 2.5) / 22))}</p>`;
		publishReport(db, { project: "mine", name: "long", html: long });
		const png = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000", "hex");
		addImage(db, id, { data: new Uint8Array(png), type: "image/png", width: 1, height: 1 }, "one pixel", "kostas");
		const ref = getItem(db, id)!.ref;
		db.close();

		// The cloud board has items already (the tests above), so this computer's board goes up only when asked.
		const joined = await syncOn(BASE, { key: KEY, name: "Second computer" });
		expect(joined.uploaded).toBe(false);
		await syncOff({ keepLocal: true });
		const { uploaded, cfg } = await syncOn(BASE, { key: KEY, name: "This computer", replace: true });
		expect(uploaded).toBe(true);
		expect(readSync()?.url).toBe(BASE);

		const item = (await (await api(`/api/items/${ref}`, {}, cfg.token)).json()) as { title: string; notes: { text: string }[]; images: { id: number }[] };
		expect(item.title).toBe("Made on this computer");
		expect(item.notes.map((n) => n.text)).toContain("a note from here");
		const pic = await api(`/api/images/${item.images[0].id}`, {}, cfg.token);
		expect(new Uint8Array(await pic.arrayBuffer())).toEqual(new Uint8Array(png));
		const reports = (await (await api("/api/reports?project=mine", {}, cfg.token)).json()) as { id: number }[];
		expect(await (await api(`/r/${reports[0].id}`, {}, cfg.token)).text()).toContain(long.slice(-200));
		// The demo project from before is gone: replaced by this computer's board.
		expect(((await (await api("/api/projects", {}, cfg.token)).json()) as { slug: string }[]).map((p) => p.slug)).toEqual(["mine"]);

		// Done in the cloud, then sync off brings it down.
		await api(`/api/items/${ref}/notes`, { method: "POST", body: JSON.stringify({ text: "a note from the cloud" }) }, cfg.token);
		const { kept } = await syncOff();
		expect(readSync()).toBeNull();
		expect(kept && existsSync(kept)).toBeTruthy();
		const back = open(DB_PATH);
		const mine = getItem(back, listItems(back, { project: "mine" })[0].id)!;
		// With the board's own history notes in between ("created", "image added: …").
		expect(mine.notes.map((n) => n.text).filter((t) => t.startsWith("a note"))).toEqual(["a note from here", "a note from the cloud"]);
		expect(reportHtml(back, reports[0].id)?.html).toBe(long);
		back.close();
		// This computer's device on the cloud board went with it.
		expect((await api("/api/items", {}, cfg.token)).status).toBe(401);
	});

	test("a ticket for `wb open` comes from this computer's token", async () => {
		const { cfg } = await syncOn(BASE, { key: KEY, name: "Again" });
		const url = await cloudLogin(cfg, "Browser");
		expect(url).toStartWith(`${BASE}/login?ticket=`);
		await syncOff({ keepLocal: true });
	});
});
