// Phones paired with the board (devices.ts): pairing codes, device tokens, and the gate every request from another
// address goes through. The server part runs a real board under --lan and calls it from 127.0.0.2 (127.0.0.0/8 is all
// this computer on Linux, but the board counts only 127.0.0.1 and ::1 as "this computer"), so nothing is faked.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";
import { addItem, getItem, open, publishReport } from "../src/db";
import {
	addDevice,
	deviceByToken,
	deviceName,
	listDevices,
	Pairing,
	removeAllDevices,
	removeDevice,
	TRIES_PER_ADDRESS,
	TRIES_PER_CODE,
} from "../src/devices";
import { freshDb } from "./helpers";

describe("pairing codes", () => {
	test("a code is 8 unambiguous characters, shown as XXXX-XXXX", () => {
		const p = new Pairing();
		const { code } = p.open();
		expect(code).toMatch(/^[ACDEFGHJKMNPQRTUVWXY34679]{4}-[ACDEFGHJKMNPQRTUVWXY34679]{4}$/);
		expect(p.current()?.code).toBe(code);
	});

	test("works once, typed loosely (lower case, no dash, spaces)", () => {
		const p = new Pairing();
		const { code } = p.open();
		expect(p.redeem(` ${code.toLowerCase().replace("-", " ")} `, "10.0.0.2")).toBe(true);
		expect(p.current()).toBeNull();
		expect(() => p.redeem(code, "10.0.0.2")).toThrow(/No pairing code is open.*Settings → Data/);
	});

	test("expires after 10 minutes", () => {
		const p = new Pairing();
		const t = 1_000_000;
		const { code } = p.open(t);
		expect(p.current(t + 9 * 60e3)).not.toBeNull();
		expect(() => p.redeem(code, "10.0.0.2", t + 10 * 60e3)).toThrow(/No pairing code is open/);
		expect(p.current(t + 10 * 60e3)).toBeNull();
	});

	test("a new code replaces the open one", () => {
		const p = new Pairing();
		const first = p.open().code;
		const second = p.open().code;
		expect(() => p.redeem(first, "10.0.0.2")).toThrow();
		expect(p.redeem(second, "10.0.0.2")).toBe(true);
	});

	test("too many wrong codes from one address: it waits, and others still can", () => {
		const p = new Pairing();
		const t = 5_000_000;
		const { code } = p.open(t);
		for (let i = 0; i < TRIES_PER_ADDRESS; i++) expect(() => p.redeem("AAAA-AAAA", "10.0.0.9", t)).toThrow(/wrong/);
		let err: (Error & { status?: number }) | undefined;
		try {
			p.redeem(code, "10.0.0.9", t);
		} catch (e) {
			err = e as Error;
		}
		expect(err?.status).toBe(429);
		expect(p.redeem(code, "10.0.0.10", t)).toBe(true);
		// 10 minutes later it may try again.
		const next = p.open(t + 10 * 60e3).code;
		expect(p.redeem(next, "10.0.0.9", t + 10 * 60e3)).toBe(true);
	});

	test("too many wrong codes in all close the code", () => {
		const p = new Pairing();
		const { code } = p.open();
		for (let i = 0; i < TRIES_PER_CODE; i++) expect(() => p.redeem("AAAA-AAAA", `10.0.1.${i}`)).toThrow();
		expect(p.current()).toBeNull();
		expect(() => p.redeem(code, "10.0.2.1")).toThrow(/No pairing code is open/);
	});
});

describe("devices", () => {
	test("the board keeps only the token's hash; the token finds the device", () => {
		const db = freshDb();
		const { device, token } = addDevice(db, { name: "  Kostas's   phone ", ip: "10.0.0.2", ua: "x" });
		expect(device.name).toBe("Kostas's phone");
		expect(token.length).toBeGreaterThanOrEqual(43);
		const row = db.query("SELECT * FROM devices").get() as Record<string, string>;
		expect(Object.values(row)).not.toContain(token);
		expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/);
		expect(deviceByToken(db, token)?.id).toBe(device.id);
		expect(deviceByToken(db, token + "x")).toBeNull();
		expect(deviceByToken(db, "")).toBeNull();
	});

	test("remove one, remove all", () => {
		const db = freshDb();
		const a = addDevice(db, { name: "A" });
		const b = addDevice(db, { name: "B" });
		addDevice(db, { name: "C" });
		expect(removeDevice(db, a.device.id.toUpperCase())).toBe(true);
		expect(removeDevice(db, a.device.id)).toBe(false);
		expect(deviceByToken(db, a.token)).toBeNull();
		expect(listDevices(db).map((d) => d.name).sort()).toEqual(["B", "C"]);
		expect(removeAllDevices(db)).toBe(2);
		expect(deviceByToken(db, b.token)).toBeNull();
	});

	test("a name from the user agent when none is given", () => {
		const iphone = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
		const android = "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36";
		expect(deviceName(iphone)).toBe("Safari on iPhone");
		expect(deviceName(android)).toBe("Chrome on Android");
		expect(deviceName("Mozilla/5.0 (Android 14; Mobile; rv:132.0) Gecko/132.0 Firefox/132.0")).toBe("Firefox on Android");
		expect(deviceName("")).toBe("Phone");
		expect(addDevice(freshDb(), { name: "", ua: iphone }).device.name).toBe("Safari on iPhone");
	});
});

/* ---------- The gate, on a real server ---------- */

const PORT = Number(process.env.WB_PORT);
const dir = mkdtempSync(join(process.env.WB_TEST_DIR!, "devices-"));
const DB_FILE = join(dir, "workbench.db");
let proc: ReturnType<typeof Bun.spawn>;

type Res = { status: number; headers: Record<string, string>; setCookie: string[]; body: string; json: () => any };

/** One HTTP request over a socket from `from` (an address of this computer), so the board sees that peer address. */
function call(from: string, path: string, { method = "GET", headers = {}, body = "" }: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Res> {
	return new Promise((resolve, reject) => {
		const sock = net.connect({ host: "127.0.0.1", port: PORT, localAddress: from });
		const chunks: Buffer[] = [];
		sock.on("data", (d: Buffer) => chunks.push(d));
		sock.on("error", reject);
		sock.on("end", () => {
			const raw = Buffer.concat(chunks);
			const split = raw.indexOf("\r\n\r\n");
			const [line, ...lines] = raw.subarray(0, split).toString().split("\r\n");
			const h: Record<string, string> = {};
			const setCookie: string[] = [];
			for (const l of lines) {
				const i = l.indexOf(":");
				const k = l.slice(0, i).toLowerCase();
				const v = l.slice(i + 1).trim();
				if (k === "set-cookie") setCookie.push(v);
				h[k] = v;
			}
			let rest = raw.subarray(split + 4);
			if (h["transfer-encoding"] === "chunked") {
				const parts: Buffer[] = [];
				for (;;) {
					const nl = rest.indexOf("\r\n");
					const n = parseInt(rest.subarray(0, nl).toString(), 16);
					if (!n) break;
					parts.push(rest.subarray(nl + 2, nl + 2 + n));
					rest = rest.subarray(nl + 2 + n + 2);
				}
				rest = Buffer.concat(parts);
			}
			const text = rest.toString();
			resolve({ status: Number(line.split(" ")[1]), headers: h, setCookie, body: text, json: () => JSON.parse(text) });
		});
		const all = { host: `${from === "127.0.0.1" ? "localhost" : "192.168.1.20"}:${PORT}`, connection: "close", "content-length": String(Buffer.byteLength(body)), ...headers };
		sock.write(`${method} ${path} HTTP/1.1\r\n${Object.entries(all).map(([k, v]) => `${k}: ${v}`).join("\r\n")}\r\n\r\n${body}`);
	});
}
const PHONE = "127.0.0.2";
const LOCAL = "127.0.0.1";
const asJson = (body: unknown, more: Record<string, string> = {}) => ({ body: JSON.stringify(body), headers: { "content-type": "application/json", ...more } });

let item = "";
let image = 0;
let report = 0;

beforeAll(async () => {
	mkdirSync(join(dir, "home"));
	mkdirSync(join(dir, "run"));
	// The board's data before it starts: a project, an item with a picture, a report.
	const db = open(DB_FILE);
	db.run("INSERT INTO projects (slug, name, path) VALUES ('demo', 'Demo', ?)", [dir]);
	const id = addItem(db, { title: "Answer me on the phone", project: "demo", kind: "decision" }, "test");
	item = `wb-${getItem(db, id)!.ref}`;
	report = publishReport(db, { project: "demo", name: "status", html: "<h1>Status</h1>" }).id;
	db.close();
	proc = Bun.spawn(["bun", join(import.meta.dir, "..", "src", "server.ts"), "--lan"], {
		cwd: dir,
		env: {
			...process.env,
			WB_DB: DB_FILE,
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
			// This test's board, not one still going from another test file.
			const r = await call(LOCAL, "/api/ping");
			if (r.status === 200 && r.json().db === DB_FILE) return;
		} catch {}
		await Bun.sleep(100);
	}
	throw new Error("the test server didn't start");
});

afterAll(async () => {
	proc?.kill();
	await proc?.exited;
});

describe("the gate", () => {
	test("an unpaired phone gets nothing from any kind of route", async () => {
		const routes = [
			"/ui/core.js",
			"/api/ping",
			"/api/items",
			`/api/items/${item}`,
			"/api/projects",
			"/api/settings",
			"/api/reports",
			`/api/reports/${report}`,
			`/r/${report}`,
			"/api/images/1",
			"/api/links",
			"/api/trackers",
			"/api/projects/demo/logo",
			"/api/vault",
			"/api/devices",
			"/api/settings/health",
			"/usage",
			"/mcp",
			"/no/such/page",
		];
		for (const path of routes) {
			const r = await call(PHONE, path);
			expect([path, r.status]).toEqual([path, 401]);
			expect(r.headers["x-wb-pair"]).toBe("1");
			expect(r.body).not.toContain("Answer me");
		}
		// Writes too.
		const w = await call(PHONE, "/api/items", { method: "POST", ...asJson({ title: "Sneaky", project: "demo" }) });
		expect(w.status).toBe(401);
		const local = await call(LOCAL, "/api/items?project=demo");
		expect(local.json().map((i: { title: string }) => i.title)).not.toContain("Sneaky");
	});

	test("opening the board as a page sends an unpaired phone to the pairing page, keeping where it was going", async () => {
		const home = await call(PHONE, "/", { headers: { "sec-fetch-dest": "document" } });
		expect(home.status).toBe(302);
		expect(home.headers.location).toBe("/pair");
		const deep = await call(PHONE, "/?solo", { headers: { accept: "text/html" } });
		expect(deep.headers.location).toBe("/pair?next=%2F%3Fsolo");
		// A report in the board's frame isn't a page of its own: no redirect inside the frame.
		expect((await call(PHONE, `/r/${report}`, { headers: { "sec-fetch-dest": "iframe" } })).status).toBe(401);
	});

	test("the pairing page and what it needs answer without a token", async () => {
		const page = await call(PHONE, "/pair");
		expect(page.status).toBe(200);
		expect(page.body).toContain("Pair this phone");
		expect(page.body).toContain("only on a network you trust");
		expect((await call(PHONE, "/api/pair")).json()).toMatchObject({ paired: false, local: false });
		const manifest = await call(PHONE, "/manifest.webmanifest");
		expect(manifest.headers["content-type"]).toContain("application/manifest+json");
		expect(manifest.json()).toMatchObject({ display: "standalone", start_url: "/" });
		const png = await call(PHONE, "/icons/icon-512.png");
		expect([png.status, png.headers["content-type"]]).toEqual([200, "image/png"]);
		expect((await call(PHONE, "/favicon.svg")).status).toBe(200);
	});

	test("this computer works as before, with no token", async () => {
		expect((await call(LOCAL, "/", { headers: { "sec-fetch-dest": "document" } })).status).toBe(200);
		expect((await call(LOCAL, "/ui/core.js")).status).toBe(200);
		expect((await call(LOCAL, `/api/items/${item}`)).json().title).toBe("Answer me on the phone");
		expect((await call(LOCAL, "/api/settings/health")).status).toBe(200);
		expect((await call(LOCAL, `/r/${report}`)).body).toContain("<h1>Status</h1>");
	});

	test("pairing: a code from Settings, then the phone is a normal client of the board", async () => {
		// Only Settings on this computer opens a code.
		expect((await call(PHONE, "/api/devices/pairing", { method: "POST", ...asJson({}) })).status).toBe(401);
		const opened = await call(LOCAL, "/api/devices/pairing", { method: "POST", ...asJson({}) });
		expect(opened.status).toBe(201);
		const { code, urls, qr } = opened.json().pairing;
		expect(code).toMatch(/^\w{4}-\w{4}$/);
		expect(qr).toContain("<svg");
		for (const u of urls) expect(u).toMatch(new RegExp(`^http://[\\d.]+:${PORT}/pair\\?code=${code}$`));

		const wrong = await call(PHONE, "/api/pair", { method: "POST", ...asJson({ code: "AAAA-AAAA", name: "x" }) });
		expect(wrong.status).toBe(400);
		expect(wrong.setCookie).toEqual([]);
		// Not JSON: refused like every other write.
		expect((await call(PHONE, "/api/pair", { method: "POST", body: JSON.stringify({ code }), headers: { "content-type": "text/plain" } })).status).toBe(415);

		const paired = await call(PHONE, "/api/pair", { method: "POST", ...asJson({ code, name: "Test phone" }) });
		expect(paired.status).toBe(201);
		expect(paired.json().device.name).toBe("Test phone");
		const cookie = paired.setCookie[0];
		expect(cookie).toMatch(new RegExp(`^wb_phone_${PORT}=[\\w-]{43}; Path=/; Max-Age=34560000; HttpOnly; SameSite=Strict$`));
		const jar = { cookie: cookie.split(";")[0] };

		// Single use.
		const again = await call("127.0.0.4", "/api/pair", { method: "POST", ...asJson({ code, name: "Another" }) });
		expect(again.status).toBe(400);

		// The phone now reads and writes like the board's own page did under --lan.
		expect((await call(PHONE, "/api/pair", { headers: jar })).json()).toMatchObject({ paired: true, name: "Test phone" });
		const home = await call(PHONE, "/", { headers: { ...jar, "sec-fetch-dest": "document" } });
		expect(home.status).toBe(200);
		expect(home.setCookie[0]).toStartWith(`wb_phone_${PORT}=`);
		expect((await call(PHONE, "/pair?next=%2F%23report%2F1", { headers: jar })).headers.location).toBe("/#report/1");
		expect((await call(PHONE, "/pair?next=%2F%2Fevil.example", { headers: jar })).headers.location).toBe("/");
		expect((await call(PHONE, "/ui/core.js", { headers: jar })).status).toBe(200);
		expect((await call(PHONE, `/r/${report}`, { headers: { ...jar, "sec-fetch-dest": "iframe" } })).body).toContain("<h1>Status</h1>");
		const answered = await call(PHONE, `/api/items/${item}/answer`, { method: "POST", ...asJson({ answer: "Yes" }, jar) });
		expect([answered.status, answered.json().answer]).toEqual([200, "Yes"]);
		const added = await call(PHONE, "/api/items", { method: "POST", ...asJson({ title: "Filed from the phone", project: "demo" }, jar) });
		expect(added.status).toBe(201);
		// A photo from the phone's camera, on an item.
		const png = readFileSync(join(import.meta.dir, "..", "src-tauri", "icons", "32x32.png")).toString("base64");
		const up = await call(PHONE, `/api/items/${item}/images`, { method: "POST", ...asJson({ data: `data:image/png;base64,${png}`, caption: "From the camera" }, jar) });
		expect(up.status).toBe(201);
		image = up.json().images[0].id;
		const img = await call(PHONE, `/api/images/${image}`, { headers: jar });
		expect([img.status, img.headers["content-type"]]).toEqual([200, "image/png"]);

		// What stays on this computer still does, token or not.
		for (const path of ["/api/settings/health", "/api/devices", "/api/vault", "/api/data", "/usage"])
			expect([path, (await call(PHONE, path, { headers: jar })).status]).toEqual([path, 403]);
		expect((await call(PHONE, "/api/settings", { method: "PATCH", ...asJson({ "setup.name": "x" }, jar) })).status).toBe(403);
		expect((await call(PHONE, "/api/devices/pairing", { method: "POST", ...asJson({}, jar) })).status).toBe(403);
		expect((await call(PHONE, "/mcp", { method: "POST", ...asJson({ jsonrpc: "2.0", id: 1, method: "ping" }, jar) })).status).toBe(403);

		// Settings lists it, with where it was last seen from.
		const list = (await call(LOCAL, "/api/devices")).json();
		expect(list.lan).toBe(true);
		expect(list.pairing).toBeNull();
		expect(list.devices).toHaveLength(1);
		expect(list.devices[0]).toMatchObject({ name: "Test phone", last_ip: PHONE });

		// Remove: refused from the phone, and at once from this computer.
		const id = list.devices[0].id;
		expect((await call(PHONE, `/api/devices/${id}`, { method: "DELETE", ...asJson({}, jar) })).status).toBe(403);
		const removed = await call(LOCAL, `/api/devices/${id}`, { method: "DELETE", ...asJson({}) });
		expect(removed.json().devices).toEqual([]);
		const after = await call(PHONE, "/api/items", { headers: jar });
		expect(after.status).toBe(401);
		expect(after.headers["x-wb-pair"]).toBe("1");
	});

	test("Remove all, and a removed phone pairs again with a new code", async () => {
		const pairOne = async (from: string, name: string) => {
			const { code } = (await call(LOCAL, "/api/devices/pairing", { method: "POST", ...asJson({}) })).json().pairing;
			const r = await call(from, "/api/pair", { method: "POST", ...asJson({ code, name }) });
			expect(r.status).toBe(201);
			return { cookie: r.setCookie[0].split(";")[0] };
		};
		const a = await pairOne("127.0.0.5", "A");
		const b = await pairOne("127.0.0.6", "B");
		expect((await call("127.0.0.5", "/api/items", { headers: a })).status).toBe(200);
		expect((await call(LOCAL, "/api/devices")).json().devices).toHaveLength(2);
		expect((await call(LOCAL, "/api/devices", { method: "DELETE", ...asJson({}) })).json().devices).toEqual([]);
		expect((await call("127.0.0.5", "/api/items", { headers: a })).status).toBe(401);
		expect((await call("127.0.0.6", "/api/items", { headers: b })).status).toBe(401);
	});

	test("rate limit: an address with too many wrong codes has to wait", async () => {
		await call(LOCAL, "/api/devices/pairing", { method: "POST", ...asJson({}) });
		const from = "127.0.0.7";
		for (let i = 0; i < TRIES_PER_ADDRESS; i++)
			expect((await call(from, "/api/pair", { method: "POST", ...asJson({ code: "AAAA-AAAA" }) })).status).toBe(400);
		const { code } = (await call(LOCAL, "/api/devices")).json().pairing;
		const blocked = await call(from, "/api/pair", { method: "POST", ...asJson({ code }) });
		expect(blocked.status).toBe(429);
		expect(blocked.json().error).toContain("Wait");
		// Another phone still pairs with it.
		expect((await call("127.0.0.8", "/api/pair", { method: "POST", ...asJson({ code }) })).status).toBe(201);
	});
});
