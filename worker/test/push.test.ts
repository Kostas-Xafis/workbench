// Push notifications end to end (worker/src/push.ts): a local Worker sends them to a Bun server standing in for the
// push service, and the test decrypts them with the "browser's" keys. Its own Worker and storage, like cloud.test.ts.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { b64u, decrypt, publicJwk, unb64u } from "../src/webpush";

// A test that times out has its processes killed, the local Worker among them.
setDefaultTimeout(30000);

const PORT = Number(process.env.WB_CLOUD_TEST_PORT ?? 8797);
const BASE = `http://127.0.0.1:${PORT}`;
const KEY = "test-owner-key";
const dir = process.env.WB_TEST_DIR!;
let proc: ReturnType<typeof Bun.spawn>;

const api = (path: string, token: string, init: RequestInit = {}) =>
	fetch(`${BASE}${path}`, {
		...init,
		redirect: "manual",
		headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers },
	});
const post = (path: string, token: string, body: unknown = {}, method = "POST") => api(path, token, { method, body: JSON.stringify(body) });

/* ---------- The push service: records what comes, answers what a test sets ---------- */

type Got = { path: string; headers: Headers; body: Uint8Array<ArrayBuffer> };
const got: Got[] = [];
const waiters: { path: string; done: (g: Got) => void }[] = [];
const answer = new Map<string, number>();
const service = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	async fetch(req) {
		const g = { path: new URL(req.url).pathname, headers: req.headers, body: new Uint8Array(await req.arrayBuffer()) };
		const w = waiters.findIndex((x) => x.path === g.path);
		if (w >= 0) waiters.splice(w, 1)[0].done(g);
		else got.push(g);
		return new Response(null, { status: answer.get(g.path) ?? 201 });
	},
});
const PUSH = `http://127.0.0.1:${service.port}`;
/** The next push to `path`. */
function next(path: string, ms = 5000) {
	const i = got.findIndex((g) => g.path === path);
	if (i >= 0) return Promise.resolve(got.splice(i, 1)[0]);
	return new Promise<Got>((done, fail) => {
		const w = { path, done };
		waiters.push(w);
		setTimeout(() => {
			const at = waiters.indexOf(w);
			if (at >= 0) waiters.splice(at, 1);
			fail(new Error(`no push to ${path} within ${ms} ms`));
		}, ms);
	});
}
const none = (path: string) => expect(got.filter((g) => g.path === path)).toEqual([]);

/* ---------- A browser: its keys, its subscription ---------- */

type Browser = { token: string; path: string; publicKey: Uint8Array<ArrayBuffer>; privateKey: CryptoKey; auth: Uint8Array<ArrayBuffer> };
async function browser(token: string, path: string): Promise<Browser> {
	const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
	return { token, path, publicKey: new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)), privateKey: pair.privateKey, auth: crypto.getRandomValues(new Uint8Array(16)) };
}
const subscribe = (b: Browser, prefs: unknown = {}, tz = "UTC") =>
	post("/api/push/subscribe", b.token, { subscription: { endpoint: `${PUSH}${b.path}`, keys: { p256dh: b64u(b.publicKey), auth: b64u(b.auth) } }, prefs, tz });
async function read(b: Browser, g: Got) {
	return JSON.parse(new TextDecoder().decode(await decrypt(g.body, b))) as { title: string; body: string; tag: string; target: unknown; always?: boolean };
}

let computer = ""; // the device the owner key gave: where "agents" make their changes
let phone: Browser;
let laptop: Browser;
let phoneId = "";
async function item(title: string, more: Record<string, unknown> = {}, token = computer) {
	const { id } = (await (await post("/api/items", token, { project: "demo", title, kind: "decision", options: ["A", "B"], ...more })).json()) as { id: number };
	return (await (await api(`/api/items/${id}`, computer)).json()) as { id: number; ref: string };
}

beforeAll(async () => {
	// cloud.test.ts's Worker may still be letting go of the port.
	for (let i = 0; i < 100; i++) {
		try {
			await fetch(`${BASE}/api/ping`);
			await Bun.sleep(100);
		} catch {
			break;
		}
	}
	mkdirSync(join(dir, "state-push"), { recursive: true });
	proc = Bun.spawn(
		[join(import.meta.dir, "..", "node_modules", ".bin", "wrangler"), "dev", "--ip", "127.0.0.1", "--port", String(PORT), "--var", `WB_OWNER_KEY:${KEY}`, "--persist-to", join(dir, "state-push"), "--show-interactive-dev-session=false"],
		{ cwd: join(import.meta.dir, ".."), env: { ...process.env, WRANGLER_SEND_METRICS: "false" }, stdout: "ignore", stderr: "pipe" },
	);
	for (let i = 0; i < 300; i++) {
		try {
			if ((await fetch(`${BASE}/api/ping`)).ok) break;
		} catch {}
		await Bun.sleep(100);
	}
	computer = ((await (await post("/api/sync/claim", "", { key: KEY, name: "Computer" })).json()) as { token: string }).token;
	expect(computer).toBeTruthy();
	const pairOne = async (name: string) => {
		const made = (await (await post("/api/devices/pairing", computer)).json()) as { pairing: { code: string } };
		const res = await post("/api/pair", "", { code: made.pairing.code, name });
		const body = (await res.json()) as { device: { id: string } };
		return { id: body.device.id, token: /wb_device=([\w-]+)/.exec(res.headers.get("set-cookie") ?? "")![1] };
	};
	const p = await pairOne("Phone");
	phoneId = p.id;
	phone = await browser(p.token, "/push/phone");
	laptop = await browser((await pairOne("Laptop")).token, "/push/laptop");
	expect((await post("/api/projects", computer, { slug: "demo", name: "Demo", path: "" })).status).toBe(201);
});

afterAll(() => {
	proc?.kill();
	service.stop(true);
});

describe("push notifications", () => {
	test("a change reaches a subscribed phone, encrypted for it and signed by the board", async () => {
		const info = (await (await api("/api/push", phone.token)).json()) as { key: string; subscribed: boolean };
		expect(info.subscribed).toBe(false);
		expect(unb64u(info.key)).toHaveLength(65);
		expect((await subscribe(phone)).status).toBe(201);
		expect(((await (await api("/api/push", phone.token)).json()) as { subscribed: boolean }).subscribed).toBe(true);
		// The keys stay the board's: asked again, the same.
		expect(((await (await api("/api/push", laptop.token)).json()) as { key: string }).key).toBe(info.key);

		const it = await item("Pick a colour");
		const g = await next(phone.path);
		expect(await read(phone, g)).toEqual({ title: "Needs you · Demo", body: "decision: Pick a colour", tag: `wb-${it.ref}`, target: { item: it.id } });
		expect(g.headers.get("content-encoding")).toBe("aes128gcm");
		expect(Number(g.headers.get("ttl"))).toBeGreaterThan(0);
		expect(g.headers.get("urgency")).toBe("high");
		// VAPID: a JWT for the push service's origin, signed with the key the page subscribed with.
		const m = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/.exec(g.headers.get("authorization") ?? "")!;
		expect(m[4]).toBe(info.key);
		expect(JSON.parse(Buffer.from(m[2], "base64url").toString()).aud).toBe(PUSH);
		const key = await crypto.subtle.importKey("jwk", publicJwk(unb64u(info.key)), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
		expect(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, unb64u(m[3]), new TextEncoder().encode(`${m[1]}.${m[2]}`))).toBe(true);
	});

	test("never to the device that made the change", async () => {
		expect((await subscribe(laptop)).status).toBe(201);
		const mine = await item("Made on the phone", {}, phone.token);
		expect((await read(laptop, await next(laptop.path))).target).toEqual({ item: mine.id });
		const theirs = await item("Made on the computer");
		// The phone's next push is the computer's change: its own never came.
		expect((await read(phone, await next(phone.path))).target).toEqual({ item: theirs.id });
		expect((await read(laptop, await next(laptop.path))).target).toEqual({ item: theirs.id });
		none(phone.path);
	});

	test("a wb command on the computer is a change like any other (POST /api/sync/cli)", async () => {
		const body = { args: ["add", "Try it from the terminal"], options: { kind: "check", project: "demo" }, cwd: "/", author: "kostas", tty: false, port: 4400, files: {} };
		const res = await post("/api/sync/cli", computer, body);
		expect(((await res.json()) as { code: number }).code).toBe(0);
		for (const b of [phone, laptop]) expect(await read(b, await next(b.path))).toMatchObject({ title: "Needs you · Demo", body: "check: Try it from the terminal" });
	});

	test("an agent finishing, getting stuck, carrying on; each kind as the phone chose", async () => {
		expect((await subscribe(phone, { kinds: { needs: false } })).status).toBe(201);
		await item("Not wanted on the phone");
		const work = await item("Some work", { kind: "task", options: undefined });
		await post(`/api/items/${work.ref}`, computer, { status: "waiting" }, "PATCH");
		expect(await read(phone, await next(phone.path))).toMatchObject({ title: "Agent waiting · Demo", body: "Some work" });
		await post(`/api/items/${work.ref}`, computer, { status: "done" }, "PATCH");
		expect(await read(phone, await next(phone.path))).toMatchObject({ title: "Done · Demo", body: "Some work", target: { item: work.id } });
		// The laptop wants everything, so it had all of them; the phone had no "needs you".
		for (const title of ["Needs you · Demo", "Agent waiting · Demo", "Done · Demo"]) expect((await read(laptop, await next(laptop.path))).title).toBe(title);
		none(phone.path);
	});

	test("quiet hours hold them, and one notification sums them up when they end", async () => {
		const h = new Date().getUTCHours();
		const hh = (n: number) => `${String((n + 24) % 24).padStart(2, "0")}:00`;
		expect((await subscribe(phone, { quiet: true, from: hh(h - 1), to: hh(h + 2) })).status).toBe(201);
		await item("Held one");
		await item("Held two");
		await next(laptop.path);
		await next(laptop.path);
		none(phone.path);
		// Quiet hours turned off on the phone: what waited comes at once, summed up.
		expect((await subscribe(phone, { quiet: false })).status).toBe(201);
		const sum = await read(phone, await next(phone.path));
		expect(sum).toMatchObject({ title: "While you were away", tag: "wb-away", target: { today: 1 } });
		expect(sum.body).toBe("2 things need you\ndecision: Held one");
		// In the phone's own time zone: 23:00–07:00 at UTC+14 is never "now" in UTC's quiet hours above.
		expect((await subscribe(phone, { quiet: true, from: hh(h - 1), to: hh(h + 2) }, "Pacific/Kiritimati")).status).toBe(201);
		await item("Not held at UTC+14");
		expect((await read(phone, await next(phone.path))).body).toBe("decision: Not held at UTC+14");
		await next(laptop.path);
	});

	test("Send a test is a real push, to this device only, shown even with the board in front", async () => {
		expect((await subscribe(phone)).status).toBe(201);
		expect((await post("/api/push/test", phone.token)).status).toBe(200);
		expect(await read(phone, await next(phone.path))).toMatchObject({ title: "Workbench", tag: "wb-test", always: true });
		none(laptop.path);
		// Only the board's own page (JSON, no other site) changes a subscription.
		expect((await api("/api/push/test", phone.token, { method: "POST", body: "{}", headers: { "content-type": "text/plain" } })).status).toBe(403);
		expect((await api("/api/push", "")).status).toBe(401);
	});

	test("a subscription the push service says is gone is dropped (a new one after two more tries)", async () => {
		answer.set(laptop.path, 410);
		await item("To a gone browser");
		await next(phone.path);
		const first = await next(laptop.path);
		const again = [await next(laptop.path, 8000), await next(laptop.path, 12000)];
		expect(again.every((g) => g.body.length === first.body.length)).toBe(true);
		await Bun.sleep(300);
		expect(((await (await api("/api/push", laptop.token)).json()) as { subscribed: boolean }).subscribed).toBe(false);
		answer.delete(laptop.path);
	});

	test("removing a device removes its subscription", async () => {
		expect((await subscribe(laptop)).status).toBe(201);
		expect((await post(`/api/devices/${phoneId}`, computer, {}, "DELETE")).status).toBe(200);
		expect((await api("/api/push", phone.token)).status).toBe(401);
		const last = await item("After the phone went");
		expect((await read(laptop, await next(laptop.path))).target).toEqual({ item: last.id });
		await Bun.sleep(200);
		none(phone.path);
	});

	test("the push tables stay on the cloud board when a board moves", async () => {
		const tables = ((await (await api("/api/sync/tables", computer)).json()) as { name: string }[]).map((t) => t.name);
		expect(tables).toContain("items");
		expect(tables).not.toContain("push_keys");
		expect(tables).not.toContain("push_subscriptions");
	});
});

describe("installing the board", () => {
	test("the service worker answers at the root without a device, and is never cached", async () => {
		const sw = await fetch(`${BASE}/sw.js`);
		expect(sw.status).toBe(200);
		expect(sw.headers.get("content-type")).toStartWith("text/javascript");
		expect(sw.headers.get("cache-control")).toBe("no-cache");
		const code = await sw.text();
		expect(code).toContain("showNotification");
		// No fetch handler: the board's pages and API never come from a cache.
		expect(code).not.toMatch(/addEventListener\(\s*["']fetch/);
	});

	test("the manifest has what Chrome needs to install it as an app", async () => {
		const res = await fetch(`${BASE}/manifest.webmanifest`);
		const m = (await res.json()) as { id: string; start_url: string; display: string; icons: { src: string; sizes: string; purpose: string }[]; shortcuts: { url: string }[] };
		expect(m).toMatchObject({ id: "/", start_url: "/", display: "standalone" });
		for (const [size, purpose] of [["192x192", "any"], ["512x512", "any"], ["192x192", "maskable"], ["512x512", "maskable"]])
			expect(m.icons.some((i) => i.sizes === size && i.purpose === purpose)).toBe(true);
		for (const icon of [...m.icons, { src: "/icons/badge-96.png", sizes: "96x96" }]) {
			const png = await fetch(`${BASE}${icon.src}`);
			expect(png.headers.get("content-type")).toBe("image/png");
			const b = new DataView(await png.arrayBuffer());
			// The PNG's own width and height (IHDR) are what the manifest says.
			expect(`${b.getUint32(16)}x${b.getUint32(20)}`).toBe(icon.sizes);
		}
		expect(m.shortcuts.map((s) => s.url)).toEqual(["/#inbox", "/#agents"]);
	});
});
