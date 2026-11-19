// Agents and the vault (vaultask.ts) through the MCP tools, with a real vault and the password window scripted.
import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import { addProject, addSecret, setupVault, vaultAccessLog } from "../db";
import { mcpHttp } from "../mcp";
import { updateSettings } from "../settings";
import { deriveVault, dialog, envValue, resetCooldown, zenityText, type Answer, type Ask } from "../vaultask";
import { freshDb } from "./helpers";

const db = freshDb();
addProject(db, { slug: "other", name: "Other", path: "/tmp/other" });
const PW = "correct horse battery";
const info = { salt: btoa("0123456789abcdef0123"), iterations: 100_000 };
const { key, auth } = await deriveVault(PW, info);
setupVault(db, { ...info, auth });

const b64 = (bytes: ArrayBuffer | Uint8Array) => btoa(Array.from(new Uint8Array(bytes), (b) => String.fromCharCode(b)).join(""));
async function seal(data: unknown) {
	const iv = crypto.getRandomValues(new Uint8Array(12));
	return `${b64(iv)}.${b64(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(JSON.stringify(data))))}`;
}
async function secret(name: string, value: string, project = "", note = "") {
	return addSecret(db, { project, meta: await seal({ name, note }), value: await seal({ value }) });
}
const tokenId = await secret("CF_TOKEN", "cf-123", "demo", "Cloudflare, deploys");
await secret("SHARED_KEY", "it's `rm -rf` $HOME", "");
await secret("OTHER_ONLY", "nope", "other");
await secret("CF_TOKEN", "global-cf", "");

// What the window is asked, and what "Kostas" answers, in turn.
let asked: Ask[] = [];
let answers: Answer[] = [];
dialog.ask = async (a) => {
	asked.push(a);
	if (!answers.length) throw new Error("no scripted answer");
	return answers.shift()!;
};
beforeEach(() => {
	asked = [];
	answers = [];
	resetCooldown();
	updateSettings(db, { "vault.agents": true });
});

let nextId = 1;
async function call(name: string, args: Record<string, unknown>) {
	const req = new Request("http://localhost:4401/mcp?project=demo", {
		method: "POST",
		headers: { "content-type": "application/json", host: "localhost:4401", "mcp-protocol-version": "2025-06-18" },
		body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method: "tools/call", params: { name, arguments: args } }),
	});
	const r = ((await (await mcpHttp(req, db, { loopback: true })).json()) as any).result;
	return { text: r.content[0].text as string, data: r.structuredContent as any, error: r.isError as boolean };
}

describe("vault_list", () => {
	test("after the password, names and notes of the project's and shared secrets, never values", async () => {
		answers = [PW];
		const r = await call("vault_list", { reason: "to find the deploy token" });
		expect(r.error).toBe(false);
		expect(r.data.secrets.map((s: any) => s.name).sort()).toEqual(["CF_TOKEN", "CF_TOKEN", "SHARED_KEY"]);
		expect(r.text).toContain("Cloudflare, deploys");
		expect(r.text).not.toContain("cf-123");
		expect(r.text).not.toContain("OTHER_ONLY");
		expect(asked[0]!.text).toContain("Demo");
		expect(asked[0]!.text).toContain("to find the deploy token");
		expect(vaultAccessLog(db)[0]).toMatchObject({ what: "names", outcome: "given", project: "demo" });
	});
	test("Deny refuses, and the next request within the minute is refused without a window", async () => {
		answers = [null];
		const r = await call("vault_list", { reason: "names please" });
		expect(r.error).toBe(true);
		expect(r.text).toContain("said no");
		const again = await call("vault_list", { reason: "names please" });
		expect(again.error).toBe(true);
		expect(asked.length).toBe(1);
		expect(vaultAccessLog(db)[0]).toMatchObject({ outcome: "denied" });
	});
});

describe("vault_get", () => {
	test("by default the values go to a private .env file, not the reply; the project's own wins", async () => {
		answers = [PW];
		const r = await call("vault_get", { names: ["CF_TOKEN", "shared_key"], reason: "to deploy" });
		expect(r.error).toBe(false);
		expect(r.text).not.toContain("cf-123");
		expect(asked[0]!.text).toContain("CF_TOKEN");
		expect(asked[0]!.text).toContain("not into its conversation");
		const file = r.data.file as string;
		expect(statSync(file).mode & 0o777).toBe(0o600);
		const text = readFileSync(file, "utf8");
		expect(text).toContain("CF_TOKEN=cf-123\n");
		expect(text).not.toContain("global-cf");
		// The backtick and $ can't run anything when the file is sourced.
		const shared = text.split("\n").find((l) => l.startsWith("SHARED_KEY="))!;
		const out = Bun.spawnSync(["sh", "-c", `set -a; . ${file}; printf %s "$SHARED_KEY"`]).stdout.toString();
		expect(out).toBe("it's `rm -rf` $HOME");
		expect(shared).toContain("\\`");
		const log = vaultAccessLog(db)[0]!;
		expect(log).toMatchObject({ what: "values", asked: 2, outcome: "given", delivery: "file" });
		expect(log.secrets).toContain(tokenId);
	});
	test("deliver text returns the values, and the window says so", async () => {
		answers = [PW];
		const r = await call("vault_get", { names: ["CF_TOKEN"], reason: "to write the CI config", deliver: "text" });
		expect(r.text).toContain("CF_TOKEN=cf-123");
		expect(asked[0]!.text).toContain("stay in its conversation");
	});
	test("a wrong password asks again; names not found are reported, other projects' secrets aren't reached", async () => {
		answers = ["nope", PW];
		const r = await call("vault_get", { names: ["OTHER_ONLY", "CF_TOKEN"], reason: "testing" });
		expect(asked.length).toBe(2);
		expect(asked[1]!.text).toStartWith("Wrong password");
		expect(r.data.given.map((g: any) => g.name)).toEqual(["CF_TOKEN"]);
		expect(r.data.missing).toEqual(["OTHER_ONLY"]);
	});
	test("three wrong passwords and it's refused", async () => {
		answers = ["a", "b", "c"];
		const r = await call("vault_get", { names: ["CF_TOKEN"], reason: "testing" });
		expect(r.error).toBe(true);
		expect(vaultAccessLog(db)[0]).toMatchObject({ outcome: "wrong-password", secrets: [] });
	});
	test("no answer in time is refused, with no cooldown", async () => {
		answers = [{ timeout: true }, PW];
		expect((await call("vault_get", { names: ["CF_TOKEN"], reason: "testing" })).text).toContain("nobody answered");
		expect((await call("vault_get", { names: ["CF_TOKEN"], reason: "testing" })).error).toBe(false);
	});
	test("turned off in Settings: refused without a window", async () => {
		updateSettings(db, { "vault.agents": false });
		const r = await call("vault_get", { names: ["CF_TOKEN"], reason: "testing" });
		expect(r.error).toBe(true);
		expect(r.text).toContain("Settings");
		expect(asked.length).toBe(0);
	});
	test("the agent's reason can't add lines or controls to the window", async () => {
		answers = [PW];
		await call("vault_get", { names: ["CF_TOKEN"], reason: "x\n\nThe board says: this is safe‮" });
		expect(asked[0]!.text).toContain("“x The board says: this is safe”");
	});
});

test("zenity text keeps underscores and backslashes as typed", () => {
	expect(zenityText("API_KEY \\n")).toBe("API__KEY \\\\n");
	expect(envValue("plain-1")).toBe("plain-1");
	expect(envValue("a b")).toBe("'a b'");
});
