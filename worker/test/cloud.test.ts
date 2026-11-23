// The cloud board on a real (local) Worker: `wrangler dev` with its own throwaway Durable Object storage, started
// here and stopped at the end. Run from worker/: `bun test` (CI: .github/workflows/worker.yml).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

// `wb` itself, as a real process, while this computer syncs: the commands run on the cloud board by the board's own
// command code (src/cli.ts), and nothing lands on this computer's database.
describe("wb over the network", () => {
	const proj = join(dir, "proj");
	const png = Buffer.from(
		"89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000001e221bc330000000049454e44ae426082",
		"hex",
	);
	const wbBin = join(import.meta.dir, "..", "..", "src", "wb.ts");
	const wb = async (args: string[], opts: { cwd?: string; env?: Record<string, string> } = {}) => {
		const p = Bun.spawn(["bun", wbBin, ...args], {
			cwd: opts.cwd ?? join(proj, "sub"),
			env: { ...process.env, WB_AUTHOR: "kostas", CLAUDECODE: "", ...opts.env },
			stdout: "pipe",
			stderr: "pipe",
		});
		const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
		return { out, err, code };
	};
	let cfgToken = "";

	beforeAll(async () => {
		mkdirSync(join(proj, "sub"), { recursive: true });
		expect((await api("/api/projects", { method: "POST", body: JSON.stringify({ slug: "cli", name: "CLI", path: proj }) })).status).toBe(201);
		cfgToken = (await syncOn(BASE, { key: KEY, name: "wb commands" })).cfg.token;
	});
	afterAll(async () => {
		await syncOff({ keepLocal: true });
	});

	test("add, ls (with its filters), start, note, show, done and drop, with the project of the current folder", async () => {
		const added = await wb(["add", "From the phone-side wb", "--kind", "check", "--body", "line one\\nline two", "--p", "1"]);
		expect(added).toMatchObject({ code: 0, err: "" });
		const ref = added.out.trim();
		expect(ref).toMatch(/^wb-[a-z0-9]{4}$/);
		// The cloud board has it, in the project of the folder wb ran in.
		const item = (await (await api(`/api/items/${ref.slice(3)}`)).json()) as { project: string; owner: string; body: string; author?: string };
		expect(item).toMatchObject({ project: "cli", owner: "kostas", body: "line one\nline two" });

		const mine = await wb(["ls", "--mine"]);
		expect(mine.out).toContain(`${ref} P1 K CHECK  From the phone-side wb`);
		expect((await wb(["ls", "--agents"])).out).toBe("nothing open\n");
		expect((await wb(["ls", "-q", "phone-side", "--kind", "check"])).out).toContain(ref);
		expect((await wb(["ls", "--project", "demo"])).out).not.toContain("phone-side");

		const t = await wb(["add", "A task for an agent"]);
		const tref = t.out.trim();
		const started = await wb(["start", tref, "--session", "s-1", "--branch", "b-1"]);
		expect(started.out).toBe(`${tref} P2 A task   cli          [doing] A task for an agent  ⎇ b-1  @ s-1\n`);
		expect((await wb(["note", tref, "found", "it"])).code).toBe(0);
		const shown = await wb(["show", tref]);
		expect(shown.out).toContain("cli · task · for an agent · doing · P2");
		expect(shown.out).toContain("kostas: found it");
		expect((await wb(["done", tref, "fixed", "in abc"])).out).toContain("[done] A task for an agent");
		expect((await wb(["ls"])).out).not.toContain(tref);
		expect((await wb(["ls", "--all"])).out).toContain(`${tref} P2 A task   [done] A task for an agent`);

		const d = (await wb(["add", "Not wanted"])).out.trim();
		expect((await wb(["drop", d, "no", "longer"])).out).toContain("[dropped] Not wanted");
		// What's wrong still says so, with the same words and an exit code.
		const bad = await wb(["show", "zzzz"]);
		expect(bad).toMatchObject({ out: "", err: 'wb: no item "zzzz"\n', code: 1 });
		expect((await wb(["add"])).err).toBe('wb: usage: wb add "title" [options]\n');
		expect((await wb(["ls"], { cwd: dir })).out).toContain(ref);
		expect((await wb(["add", "Nowhere"], { cwd: dir })).err).toBe("wb: not inside a known project; pass --project (wb projects)\n");
		expect((await wb(["nonsense"])).err).toBe('wb: unknown command "nonsense" (wb help)\n');
	});

	test("a decision: options, the answer and what's recorded", async () => {
		const ref = (await wb(["add", "Which one?", "--option", "Red", "--option", "Blue", "--recommend", "Blue", "--default", "Blue", "--decide-by", "in 3 days"])).out.trim();
		expect((await wb(["show", ref])).out).toContain("2. Blue  (recommended)");
		const answered = await wb(["answer", ref, "1"]);
		expect(answered.out).toContain("→ Red");
		expect((await wb(["ls", "--mine"])).out).not.toContain(ref);
		// A notice is seen, a review objected to.
		const n = (await wb(["add", "Changed things", "--kind", "notice"])).out.trim();
		expect((await wb(["ls", "--mine"])).out).toContain("and 1 notice to see");
		expect((await wb(["seen", n])).code).toBe(0);
		const r = (await wb(["add", "Wording", "--kind", "review"])).out.trim();
		expect((await wb(["object", r, "too", "long"])).out).toContain("Wording");
	});

	test("wb report publishes the file's page, again as a new version, with its icon; wb reports lists it", async () => {
		const page = join(dir, "page.html");
		writeFileSync(page, "<!doctype html><title>Page</title><h1>Ελληνικά from a file</h1>");
		const first = await wb(["report", page, "--name", "page", "--icon", "📄"]);
		expect(first.code).toBe(0);
		const m = first.out.match(/^report #(\d+) v1  (.*)\/#report\/\1\n$/);
		expect(m).not.toBeNull();
		expect(m![2]).toBe(BASE);
		expect(await (await api(`/r/${m![1]}`)).text()).toContain("Ελληνικά from a file");
		expect((await wb(["report", page, "--name", "page"])).out).toContain("v1 (unchanged)");
		writeFileSync(page, "<!doctype html><title>Page</title><h1>Second</h1>");
		expect((await wb(["report", page, "--name", "page", "--title", "The page"])).out).toContain("v2");
		expect((await wb(["reports"])).out).toMatch(/#\d+\s+cli\s+-\s+v2\s+\S+ \S+  page  The page/);
		// An agent's report needs its own icon, an .svg file is read here and sent.
		const agent = { env: { WB_AUTHOR: "agent" } };
		expect((await wb(["report", page, "--name", "other"], agent)).err).toContain("every report needs its own icon");
		const svg = join(dir, "icon.svg");
		writeFileSync(svg, '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><circle cx="4" cy="4" r="3"/></svg>');
		expect((await wb(["report", page, "--name", "other", "--icon", svg], agent)).code).toBe(0);
		const other = ((await (await api("/api/reports?project=cli")).json()) as { id: number; name: string; icon: string }[]).find((x) => x.name === "other")!;
		expect(other.icon).toContain("<circle");
		expect((await wb(["report-icon", String(other.id), "🧪"])).out).toBe(`report #${other.id}: icon set\n`);
		expect((await wb(["report-icon", String(other.id), svg])).code).toBe(0);
		expect((await wb(["report", join(dir, "missing.html")])).err).toBe(`wb: no file ${join(dir, "missing.html")}\n`);
		expect((await wb(["unreport", String(other.id)])).code).toBe(0);
	});

	test("pictures: added from a file, listed, saved back to a file, removed", async () => {
		const file = join(dir, "shot.png");
		writeFileSync(file, png);
		const ref = (await wb(["add", "With a picture", "--image", file, "--caption", "one pixel"])).out.trim();
		const shown = (await wb(["show", ref])).out;
		expect(shown).toMatch(/image \d+: one pixel \(/);
		const second = await wb(["image", "add", ref, file, "again"]);
		expect(second.out).toMatch(/^image \d+ on wb-/);
		const id = shown.match(/image (\d+):/)![1];
		const saved = join(dir, "saved.png");
		expect((await wb(["image", "save", id, saved])).out).toBe(`${saved} (image/png)\n`);
		expect(new Uint8Array(readFileSync(saved))).toEqual(new Uint8Array(png));
		expect((await wb(["image", "rm", id])).out).toBe(`removed from ${ref}\n`);
		// What isn't a picture, and what isn't there, are refused as they are here.
		const text = join(dir, "notes.txt");
		writeFileSync(text, "not a picture");
		expect((await wb(["image", "add", ref, text, "x"])).err).toBe(`wb: ${text} isn't a PNG, JPEG, WebP or GIF image\n`);
		expect((await wb(["image", "add", ref, join(dir, "gone.png"), "x"])).err).toBe(`wb: no file at ${join(dir, "gone.png")}\n`);
		expect((await wb(["add", "x", "--image", file])).err).toContain("each --image needs its --caption");
	});

	test("goals, rulings, links, trackers, projects, import and export", async () => {
		expect((await wb(["goal", "add", "Ship it", "--due", "2026-12-31"])).out).toContain("Ship it");
		expect((await wb(["goals"])).out).toContain("Ship it");
		const goaled = await wb(["add", "Serves a goal", "--goal", "Ship it"]);
		expect(goaled.code).toBe(0);
		expect((await wb(["show", goaled.out.trim()])).out).toContain("Ship it");
		expect((await wb(["rule", "Always", "ask", "once"])).out).toMatch(/^#\d+\n$/);
		expect((await wb(["rulings"])).out).toContain("Always ask once");
		expect((await wb(["link", "Docs", "https://example.com/docs"])).out).toMatch(/^#\d+\n$/);
		expect((await wb(["links"])).out).toContain("https://example.com/docs");
		expect((await wb(["tracker", "add", "builds", "Builds"])).out).toContain("tracker cli/builds added");
		expect((await wb(["track", "builds", "3/5"])).out).toContain("3/5");
		expect((await wb(["trackers"])).out).toContain("cli/builds");
		expect((await wb(["projects"])).out).toContain(proj);
		expect((await wb(["project", "second", join(dir, "second"), "Second"])).out).toBe(`project second → ${join(dir, "second")}\n`);
		const file = join(dir, "import.json");
		writeFileSync(file, JSON.stringify([{ title: "Imported one" }, { title: "Imported two", kind: "idea" }]));
		expect((await wb(["import", file])).out).toBe("imported 2 items into cli\n");
		const exported = await wb(["export"]);
		expect(exported.code).toBe(0);
		expect(JSON.stringify(JSON.parse(exported.out))).toContain("Imported two");
		expect((await wb(["vault"])).out).toContain("no vault yet");
		expect((await wb(["devices"])).out).toContain("wb commands");
		expect((await wb(["guide"])).out).toContain("Kostas");
	});

	test("wb help is the board's, with what needs a computer; those commands say so", async () => {
		const help = await wb(["help"]);
		expect(help.out).toContain(`The board is in the cloud: ${BASE}`);
		expect(help.out).toContain("wb ls [--mine | --agents]");
		expect(help.out).toContain("wb sync on <url>");
		expect(help.out).toMatch(/need this computer/);
		expect((await wb(["ls", "--help"])).out).toContain("wb ls [--mine");
		for (const cmd of ["run", "runs", "stop", "backup", "backups", "day", "integrate", "source", "serve"]) {
			const r = await wb([cmd, "x"]);
			expect(r.code).toBe(1);
			expect(r.err).toContain(`the board is in the cloud (${BASE})`);
		}
	});

	test("everything went to the cloud board, nothing to this computer's", async () => {
		const local = open(DB_PATH);
		expect(listItems(local, { status: [] }).map((i) => i.title).filter((t) => /phone-side|Imported|picture|Serves a goal/.test(t))).toEqual([]);
		local.close();
		const titles = ((await (await api("/api/items?project=cli&status=todo,doing,waiting,done,dropped")).json()) as { title: string }[]).map((i) => i.title);
		expect(titles).toContain("Imported two");
	});

	test("the call takes only a device token in a header, never from a page, and not too much", async () => {
		const body = JSON.stringify({ args: ["ls"], options: {}, cwd: proj, author: "kostas", tty: false, port: 4400, files: {} });
		const ok = await api("/api/sync/cli", { method: "POST", body }, cfgToken);
		expect(ok.status).toBe(200);
		expect(((await ok.json()) as { code: number }).code).toBe(0);
		expect((await api("/api/sync/cli", { method: "POST", body, headers: { origin: BASE } }, cfgToken)).status).toBe(403);
		expect((await api("/api/sync/cli", { method: "POST", body }, "")).status).toBe(401);
		expect((await api("/api/sync/cli", { method: "POST", body: "{}" }, cfgToken)).status).toBe(400);
		const huge = JSON.stringify({ args: ["ls"], options: {}, files: { x: { b64: "A".repeat(17 * 1024 * 1024) } } });
		expect((await api("/api/sync/cli", { method: "POST", body: huge }, cfgToken)).status).toBe(413);
		// What needs a computer isn't run by the board even if asked straight.
		const run = await api("/api/sync/cli", { method: "POST", body: JSON.stringify({ args: ["run", "x"], options: {} }) }, cfgToken);
		expect(((await run.json()) as { code: number; lines: string[][] }).code).toBe(1);
	});
});
