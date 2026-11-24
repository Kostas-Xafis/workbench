// The cloud board on a real (local) Worker: `wrangler dev` with its own throwaway Durable Object storage, started
// here and stopped at the end. Run from worker/: `bun test` (CI: .github/workflows/worker.yml).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { addItem, addNote, getItem, listItems, open, publishReport, reportHtml, upsertProject, PART_CHARS, DB_PATH } from "../../src/db";
import { addImage } from "../../src/images";
import { cloudLogin, readSync, syncOff, syncOn, type SyncConfig } from "../../src/sync";
import { deriveVault, dialog, resetCooldown } from "../../src/vaultask";
import { vaultHere } from "../../src/cloudvault";
import { addSource, sourceFetch } from "../../src/sources";

const PORT = Number(process.env.WB_CLOUD_TEST_PORT ?? 8797);
const BASE = `http://127.0.0.1:${PORT}`;
const KEY = "test-owner-key";
const dir = process.env.WB_TEST_DIR!;
let proc: ReturnType<typeof Bun.spawn>;
let token = "";
const helpers: ReturnType<typeof Bun.spawn>[] = [];

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
	for (const h of helpers) h.kill();
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
		const backups = await api("/api/data/backups");
		expect(backups.status).toBe(501);
		expect(((await backups.json()) as { error: string }).error).toContain("point-in-time recovery");
		// What the computer helper does, with no computer online.
		const usage = await api("/api/usage");
		expect(usage.status).toBe(503);
		expect(((await usage.json()) as { error: string }).error).toContain("No computer is online");
		expect(await (await api("/api/git")).json()).toEqual([]);
		expect((await api("/api/runs", { method: "POST", body: JSON.stringify({ item: "x" }) })).status).toBe(503);
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

describe("the computer helper", () => {
	const ROOT = join(import.meta.dir, "..", "..");
	const repo = join(dir, "helper-repo");
	const fake = join(dir, "fake-claude");
	const command = `${fake} -p "$WB_PROMPT" --output-format stream-json --verbose`;
	type RunRow = { id: number; status: string; ended_at: string | null; tail: string; pid: number; cost: number | null; result: string; started_from: string };
	const json = async <T>(res: Response | Promise<Response>) => (await res) .json() as Promise<T>;
	const get = <T>(path: string) => json<T>(api(path));
	const post = (path: string, body: unknown = {}) => api(path, { method: "POST", body: JSON.stringify(body) });
	const until = async <T>(what: string, f: () => Promise<T | undefined | null | false>, ms = 30e3): Promise<T> => {
		for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(200)) {
			const v = await f();
			if (v) return v;
		}
		throw new Error(`timed out waiting for ${what}`);
	};
	/** A helper as a computer runs it: the local server's process, synced with the cloud board through its own device. */
	async function startHelper(name: string, via: "ws" | "poll" = "ws") {
		const claimed = await json<{ token: string; device: { id: string } }>(api("/api/sync/claim", { method: "POST", body: JSON.stringify({ key: KEY, name }) }, ""));
		const home = join(dir, `computer-${name.replace(/\W+/g, "-")}`);
		mkdirSync(home, { recursive: true });
		const cfg: SyncConfig = { url: BASE, token: claimed.token, device: claimed.device.id, since: new Date().toISOString() };
		writeFileSync(join(home, "workbench.db.sync.json"), JSON.stringify(cfg), { mode: 0o600 });
		let out = "";
		const p = Bun.spawn(["bun", join(ROOT, "src", "server.ts")], {
			cwd: home,
			env: {
				...process.env,
				WB_DB: join(home, "workbench.db"),
				WB_PORT: "0",
				XDG_RUNTIME_DIR: join(home, "run"),
				WB_RUNS_SCOPE: "0",
				WB_HELPER_ASK: "0",
				CLAUDE_CONFIG_DIR: join(home, "claude"),
				...(via === "poll" ? { WB_HELPER_WS: "0" } : {}),
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		helpers.push(p);
		(async () => {
			for await (const chunk of p.stdout as ReadableStream<Uint8Array>) out += new TextDecoder().decode(chunk);
		})();
		await until(`${name} online`, async () =>
			(await get<{ computers: { name: string; via: string }[] }>("/api/helper")).computers.some((c) => c.name === name && c.via === via),
		);
		return { cfg, log: () => out, proc: p };
	}
	let item = { id: 0, ref: "" };
	let slow = { id: 0, ref: "" };
	let tracker = 0;

	test("with no computer online, the board says so in words", async () => {
		// A real repository, with a commit that names an item and a logo.
		mkdirSync(join(repo, "assets"), { recursive: true });
		writeFileSync(fake, `#!/usr/bin/env bash
echo '{"type":"system","subtype":"init","session_id":"s-'"$WB_RUN"'","model":"fake-model","cwd":"'"$PWD"'"}'
echo '{"type":"assistant","message":{"content":[{"type":"text","text":"Reading '"$WB_ITEM"'"}]}}'
case "$WB_TITLE" in *slow*) sleep 30;; esac
echo '{"type":"result","subtype":"success","is_error":false,"num_turns":1,"total_cost_usd":0.25,"result":"All done.","session_id":"s-'"$WB_RUN"'"}'
`);
		chmodSync(fake, 0o755);
		expect((await post("/api/projects", { slug: "repo", name: "Repo", path: repo })).status).toBe(201);
		const id = (await json<{ id: number }>(post("/api/items", { project: "repo", title: "Build it", owner: "agent" }))).id;
		item = { id, ref: (await get<{ ref: string }>(`/api/items/${id}`)).ref };
		const sid = (await json<{ id: number }>(post("/api/items", { project: "repo", title: "A slow one", owner: "agent" }))).id;
		slow = { id: sid, ref: (await get<{ ref: string }>(`/api/items/${sid}`)).ref };
		writeFileSync(join(repo, "assets", "logo.svg"), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="8" height="8"/></svg>');
		const git = (...a: string[]) => Bun.spawnSync(["git", "-c", "user.name=T", "-c", "user.email=t@example.com", ...a], { cwd: repo });
		git("init", "-q", "-b", "main");
		git("add", ".");
		git("commit", "-q", "-m", `Start the thing (wb-${item.ref})`);
		expect((await api("/api/settings", { method: "PATCH", body: JSON.stringify({ "agents.on": true, "agents.command": command, "agents.per-day": 50 }) })).status).toBe(200);
		const t = await json<{ id: number }>(post("/api/trackers", { project: "repo", name: "count", command: "echo 7/10", every: 3600 }));
		tracker = t.id;

		const panel = await get<{ allowed: boolean; why: string; on: boolean }>("/api/runs");
		expect(panel.on).toBe(true);
		expect(panel.allowed).toBe(false);
		expect(panel.why).toContain("No computer is online");
		const refused = await post("/api/runs", { item: item.ref });
		expect(refused.status).toBe(503);
		expect(((await refused.json()) as { error: string }).error).toContain("No computer is online");
		expect((await post(`/api/trackers/${tracker}/refresh`)).status).toBe(503);
		expect(await get("/api/git")).toEqual([]);
		// The tracker that was read as it was made says why it has no reading.
		expect((await get<{ error: string }>(`/api/trackers/${tracker}`)).error).toContain("No computer is online");
	}, 60e3);

	let a: Awaited<ReturnType<typeof startHelper>>;
	test("a helper connects; command trackers read on it, by themselves", async () => {
		a = await startHelper("Computer A");
		// Its first tick reads what's due: the tracker that couldn't read while no computer was online.
		const t = await until("the tracker's reading", async () => {
			const t = await get<{ reading: unknown; error: string }>(`/api/trackers/${tracker}`);
			return t.reading ? t : null;
		});
		expect(t.error).toBe("");
		expect(JSON.stringify(t.reading)).toContain("7");
		const again = await json<{ error: string; reading: unknown }>(post(`/api/trackers/${tracker}/refresh`));
		expect(again.error).toBe("");
	}, 60e3);

	test("git state, commits that name an item, and the project's logo come from the computer", async () => {
		const repos = await until("git state", async () => {
			const r = await get<{ project: string; ok: boolean; branch: string }[]>("/api/git?project=repo");
			return r.length ? r : null;
		});
		expect(repos[0]).toMatchObject({ project: "repo", ok: true, branch: "main" });
		const code = await until("commits", async () => {
			const c = await get<Record<string, { commits: { subject: string }[] }>>("/api/code?project=repo");
			return c[item.ref] ? c : null;
		});
		expect(code[item.ref].commits[0].subject).toContain(`wb-${item.ref}`);
		const logo = await until("the logo", async () => {
			const r = await api("/api/projects/repo/logo");
			return r.status === 200 ? r : null;
		});
		expect(logo.headers.get("content-type")).toBe("image/svg+xml");
		expect(await logo.text()).toContain("<rect");
		// Settings → Projects sees the folder as the computer does.
		const tab = await get<{ slug: string; folder: { exists: boolean; git: boolean } }[]>("/api/settings/projects");
		expect(tab.find((p) => p.slug === "repo")?.folder).toEqual({ exists: true, git: true });
	}, 60e3);

	test("Run starts the agent on the computer; its output comes back, and how it ended", async () => {
		const panel = await get<{ allowed: boolean; folders: string[]; computers: string[] }>("/api/runs");
		expect(panel.allowed).toBe(true);
		expect(panel.folders).toContain("repo");
		expect(panel.computers).toEqual(["Computer A"]);
		const res = await post("/api/runs", { item: item.ref });
		expect(res.status).toBe(201);
		const { run } = (await res.json()) as { run: RunRow };
		expect(run.status).toBe("running");
		expect(run.pid).toBeGreaterThan(0);
		const done = await until("the run's end", async () => {
			const r = await get<RunRow>(`/api/runs/${run.id}`);
			return r.ended_at ? r : null;
		});
		expect(done).toMatchObject({ status: "done", cost: 0.25, result: "All done." });
		expect(done.tail).toContain(`Reading wb-${item.ref}`);
		const notes = (await get<{ notes: { text: string }[] }>(`/api/items/${item.ref}`)).notes.map((n) => n.text);
		expect(notes.some((n) => n.startsWith(`Agent run #${run.id} finished`))).toBe(true);
		expect(a.log()).toContain(`run #${run.id} started`);
	}, 60e3);

	test("Answer & send and Stop: the output streams while it runs, and Stop ends it on the computer", async () => {
		const res = await post("/api/runs", { item: slow.ref });
		expect(res.status).toBe(201);
		const { run } = (await res.json()) as { run: RunRow };
		const live = await until("output while it runs", async () => {
			const r = await get<RunRow>(`/api/runs/${run.id}`);
			return r.tail.includes(`Reading wb-${slow.ref}`) ? r : null;
		});
		expect(live.ended_at).toBeNull();
		const stopped = await json<RunRow>(post(`/api/runs/${run.id}/stop`));
		expect(stopped.status).toBe("stopped");
		expect(stopped.ended_at).not.toBeNull();
		expect(() => process.kill(run.pid, 0)).toThrow();
	}, 60e3);

	test("a command changed from the board waits for an OK on the computer", async () => {
		await api("/api/settings", { method: "PATCH", body: JSON.stringify({ "agents.command": `${command} --something-new` }) });
		const res = await post("/api/runs", { item: slow.ref });
		expect(res.status).toBe(400);
		expect(((await res.json()) as { error: string }).error).toContain("waits for an OK on Computer A");
		expect(readFileSync(join(dir, "computer-Computer-A", "workbench.db.helper.json"), "utf8")).toContain("--something-new");
		await api("/api/settings", { method: "PATCH", body: JSON.stringify({ "agents.command": command }) });
	}, 60e3);

	test("with two computers online, each job goes to one of them", async () => {
		const b = await startHelper("Computer B");
		expect((await get<{ computers: string[] }>("/api/runs")).computers.sort()).toEqual(["Computer A", "Computer B"]);
		const ids: number[] = [];
		for (const title of ["One", "Two", "Three"]) {
			const id = (await json<{ id: number }>(post("/api/items", { project: "repo", title, owner: "agent" }))).id;
			const res = await post("/api/runs", { item: String(id) });
			expect(res.status).toBe(201);
			const { run } = (await res.json()) as { run: RunRow };
			ids.push(run.id);
			await until("the run's end", async () => (await get<RunRow>(`/api/runs/${run.id}`)).ended_at);
		}
		for (const id of ids) {
			const where = [a.log(), b.log()].filter((l) => l.includes(`run #${id} started`));
			expect(where).toHaveLength(1);
		}
		b.proc.kill();
		await until("B gone", async () => !(await get<{ computers: { name: string }[] }>("/api/helper")).computers.some((c) => c.name === "Computer B"), 10e3).catch(() => {});
	}, 60e3);

	test("vault_get through wb mcp's relay: the window and the .env file on this computer, the vault in the cloud", async () => {
		const PW = "correct horse battery";
		const info = { salt: btoa("0123456789abcdef0123"), iterations: 100_000 };
		const { key, auth } = await deriveVault(PW, info);
		expect((await post("/api/vault", { ...info, auth })).status).toBe(201);
		const b64 = (bytes: ArrayBuffer | Uint8Array) => btoa(Array.from(new Uint8Array(bytes), (x) => String.fromCharCode(x)).join(""));
		const seal = async (data: unknown) => {
			const iv = crypto.getRandomValues(new Uint8Array(12));
			return `${b64(iv)}.${b64(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(JSON.stringify(data))))}`;
		};
		const added = await api("/api/secrets", {
			method: "POST",
			headers: { "x-vault-auth": auth },
			body: JSON.stringify({ project: "repo", meta: await seal({ name: "CF_TOKEN", note: "deploys" }), value: await seal({ value: "cf-123" }) }),
		});
		expect(added.status).toBe(201);
		await api("/api/settings", { method: "PATCH", body: JSON.stringify({ "vault.agents": true }) });
		resetCooldown();
		const asked: string[] = [];
		const answers = ["wrong one", PW];
		dialog.ask = async (q) => {
			asked.push(q.text);
			return answers.shift() ?? null;
		};
		const cfg: SyncConfig = { url: BASE, token, device: "", since: "" };
		const r = await vaultHere(cfg, "vault_get", { names: ["CF_TOKEN"], reason: "to deploy the worker" }, "repo");
		if ("error" in r) throw new Error(r.error);
		expect(asked[0]).toContain("An agent working on Repo");
		expect(asked[1]).toContain("Wrong password");
		const file = (r.data as { file: string }).file;
		expect(readFileSync(file, "utf8")).toContain("CF_TOKEN=cf-123");
		expect(r.text).not.toContain("cf-123");
		const log = await json<{ what: string; outcome: string; project: string }[]>(api("/api/vault/access", { headers: { "x-vault-auth": auth } }));
		expect(log[0]).toMatchObject({ what: "values", outcome: "given", project: "repo" });
		const listed = await vaultHere(cfg, "vault_list", { reason: "names" }, "repo");
		expect("error" in listed && listed.error).toContain("Kostas said no");
	}, 60e3);

	test("a computer that can't keep a WebSocket polls, and gets its jobs all the same", async () => {
		a.proc.kill();
		const c = await startHelper("Computer C", "poll");
		await until("A gone", async () => {
			const list = (await get<{ computers: { name: string }[] }>("/api/helper")).computers.map((x) => x.name);
			return list.length === 1 && list[0] === "Computer C";
		}, 100e3);
		const id = (await json<{ id: number }>(post("/api/items", { project: "repo", title: "Polled", owner: "agent" }))).id;
		const res = await post("/api/runs", { item: String(id) });
		expect(res.status).toBe(201);
		const { run } = (await res.json()) as { run: RunRow };
		const done = await until("the run's end", async () => {
			const r = await get<RunRow>(`/api/runs/${run.id}`);
			return r.ended_at ? r : null;
		});
		expect(done.status).toBe("done");
		expect(c.log()).toContain(`run #${run.id} started`);
	}, 150e3);
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
		// The helper's tests above may have made a vault on this board: either way it's the board's own line.
		expect((await wb(["vault"])).out).toMatch(/^(no vault yet|vault set up)/);
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
		// run, runs, stop and serve go to the computer helper (its tests above).
		for (const cmd of ["backup", "backups", "day", "integrate"]) {
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

describe("data sources (live data in reports)", () => {
	// An API that wants a secret header, standing in for the one a report reads.
	const seen: (string | null)[] = [];
	const apiServer = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch: (req) => {
			seen.push(req.headers.get("authorization") ?? req.headers.get("x-key"));
			return Response.json({ path: new URL(req.url).pathname });
		},
	});
	const base = `http://127.0.0.1:${apiServer.port}/v1`;
	afterAll(() => apiServer.stop(true));
	const call = (id: number, auth: string, name = "feed") =>
		api(`/api/reports/${id}/fetch`, { method: "POST", body: JSON.stringify({ name, path: "/things" }) }, auth).then((r) => r.json()) as Promise<{ ok: boolean; json?: unknown; error?: string }>;

	test("a source added on this computer goes up sealed again with the cloud board's key, works there, and comes back down working", async () => {
		const db = open();
		upsertProject(db, { slug: "live", name: "Live", path: join(dir, "live") });
		addSource(db, { project: "live", name: "feed", base_url: base, write: false, headers: { Authorization: "Bearer from-this-computer" } });
		const report = publishReport(db, { project: "live", name: "live", html: "<title>Live</title>" });
		db.close();

		const { cfg } = await syncOn(BASE, { key: KEY, name: "Sources", replace: true });
		const rows = (await (await api("/api/sync/rows?table=sources", {}, cfg.token)).json()) as { rows: unknown[][] };
		expect(JSON.stringify(rows)).toContain('"c1.');
		expect(await call(report.id, cfg.token)).toMatchObject({ ok: true, json: { path: "/v1/things" } });
		expect(seen.at(-1)).toBe("Bearer from-this-computer");
		// Already sealed for the cloud board: nothing is left to do.
		expect((await (await api("/api/sync/sources/reseal", { method: "POST", body: JSON.stringify({ key: Buffer.alloc(32).toString("base64") }) }, cfg.token)).json()) as object).toEqual({ resealed: [], failed: [] });
		// Never from a page.
		expect((await api("/api/sync/sources/export", { method: "POST", body: "{}", headers: { origin: BASE } }, cfg.token)).status).toBe(403);

		await syncOff();
		const back = open(DB_PATH);
		expect(await sourceFetch(back, report.id, "feed", "/again")).toMatchObject({ ok: true, json: { path: "/v1/again" } });
		back.close();
		expect(seen.at(-1)).toBe("Bearer from-this-computer");
	});

	test("wb source add while syncing: its {env:…} is filled in here, the cloud board seals it", async () => {
		const { cfg } = await syncOn(BASE, { key: KEY, name: "Add" });
		mkdirSync(join(dir, "live"), { recursive: true });
		const p = Bun.spawn(["bun", join(import.meta.dir, "..", "..", "src", "wb.ts"), "source", "add", "other", base, "--header", "X-Key: {env:TEST_KEY}"], {
			cwd: join(dir, "live"),
			env: { ...process.env, WB_AUTHOR: "kostas", CLAUDECODE: "", TEST_KEY: "typed-nowhere" },
			stdout: "pipe",
			stderr: "pipe",
		});
		const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
		expect({ code, err }).toEqual({ code: 0, err: "" });
		expect(out).toContain("source other added in live");
		expect(out).not.toContain("typed-nowhere");
		const reports = (await (await api("/api/reports?project=live", {}, cfg.token)).json()) as { id: number }[];
		expect(await call(reports[0].id, cfg.token, "other")).toMatchObject({ ok: true });
		expect(seen.at(-1)).toBe("typed-nowhere");
		await syncOff({ keepLocal: true });
	});
});
