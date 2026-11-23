/**
 * Agents and the vault: the MCP tools vault_list and vault_get.
 *
 * The vault is encrypted with a password only Kostas knows (ui/vault.js): neither an agent nor the board can read it.
 * When an agent asks, a native window on this computer says which project's agent asks, for what and why, and takes
 * the vault password. It is typed there, into a program this process starts, and never passes through the agent.
 * The password is checked against the vault's auth token, decrypts just what was asked, and is forgotten at once:
 * nothing stays unlocked between requests. Like on the board, the names need the password once and every set of
 * values needs it again, listed by name in the window.
 *
 * Values go by default into a private .env file (this user only, in the runtime folder, deleted after FILE_MINUTES)
 * so they stay out of the agent's conversation and its saved transcript; `deliver: "text"` puts them in the reply.
 * Every request is logged (vault_access, by secret id) and shown in the vault. Settings → Privacy and security can
 * turn agent requests off (vault.agents).
 *
 * What this guards against: an agent taking secrets nobody agreed to, a request that misstates what it takes, and
 * a password typed where the agent can read it. Not against an agent that rewrites the workbench itself, or runs
 * code as this user to watch the screen: no popup can, and the shell those agents have is the real boundary there.
 */
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { listSecrets, logVaultAccess, projects, secretValue, vaultAuthOk, vaultInfo, type Db, type Secret, type VaultAccess, type VaultInfo } from "./db";
import { getSetting } from "./settings";

/** How long a delivered .env file lives. */
export const FILE_MINUTES = 15;
/** How long the window waits for an answer. */
const ANSWER_SECONDS = 120;
/** Wrong passwords before the request fails. */
const TRIES = 3;
/** After a Deny, further requests from this server are refused for this long, so an agent can't nag. */
const COOLDOWN_MS = 60_000;
const MAX_REASON = 300;

/* ---------- Crypto, as the browser does it (ui/vault.js) ---------- */

const te = new TextEncoder();
const td = new TextDecoder();
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export async function deriveVault(password: string, info: Pick<VaultInfo, "salt" | "iterations">) {
	const base = await crypto.subtle.importKey("raw", te.encode(password), "PBKDF2", false, ["deriveBits"]);
	const bits = new Uint8Array(
		await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: unb64(info.salt), iterations: info.iterations }, base, 512),
	);
	return {
		key: await crypto.subtle.importKey("raw", bits.slice(0, 32), "AES-GCM", false, ["encrypt", "decrypt"]),
		auth: Array.from(bits.slice(32), (b) => b.toString(16).padStart(2, "0")).join(""),
	};
}

async function unseal<T>(key: CryptoKey, sealed: string): Promise<T> {
	const [iv, ct] = sealed.split(".");
	return JSON.parse(td.decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(iv!) }, key, unb64(ct!)))) as T;
}

/* ---------- The window ---------- */

export type Ask = { title: string; text: string; ok: string };
/** The password typed, null for Deny (or the window closed), "timeout" when nobody answered. */
export type Answer = string | null | { timeout: true };

// Only these, by full path: a program of the same name earlier on PATH (say, one an agent wrote) is never run.
const ZENITY = "/usr/bin/zenity";

/**
 * zenity's entry text is plain text with mnemonics, read through g_strcompress (src/entry.c): `_` marks a mnemonic
 * and `\` starts an escape, so both are doubled. No markup, so nothing else is special.
 */
export const zenityText = (s: string) => s.replace(/\\/g, "\\\\").replace(/_/g, "__");

async function zenity(a: Ask): Promise<Answer> {
	if (!existsSync(ZENITY)) throw new Error("this computer has no zenity to ask with (sudo apt install zenity)");
	const p = Bun.spawn(
		[ZENITY, "--entry", "--hide-text", `--title=${a.title}`, `--text=${zenityText(a.text)}`, `--ok-label=${a.ok}`, "--cancel-label=Deny", "--width=480", `--timeout=${ANSWER_SECONDS}`],
		{ stdin: "ignore", stdout: "pipe", stderr: "pipe" },
	);
	const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
	if (code === 0) return out.replace(/\n$/, "");
	if (code === 1) return null;
	if (code === 5) return { timeout: true };
	throw new Error(`the password window didn't open (zenity ${code}${err.trim() ? `: ${err.trim().split("\n").pop()}` : ""})`);
}

/** Swapped out by the tests; never by anything an agent reaches. */
export const dialog = { ask: zenity };

// One window at a time from this server: two agents asking at once get theirs one after the other.
let line: Promise<unknown> = Promise.resolve();
function oneAtATime<T>(f: () => Promise<T>): Promise<T> {
	const run = line.then(f, f);
	line = run.catch(() => {});
	return run;
}
let deniedAt = 0;
/** For the tests. */
export function resetCooldown() {
	deniedAt = 0;
}

/* ---------- Requests ---------- */

/** A refusal the agent should read and act on (not a bug). */
export class VaultRefusal extends Error {}

/**
 * Where the vault is: this computer's database, or the cloud board, which `wb mcp`'s relay reaches with this
 * computer's device token (cloudvault.ts). The window, the password and the decrypting stay on this computer either way.
 */
export type VaultStore = {
	/** Settings → Privacy and security → Vault: whether agents may ask at all. */
	agentsOn(): Promise<boolean>;
	info(): Promise<Pick<VaultInfo, "salt" | "iterations"> | null>;
	/** The sealed secrets, when `auth` (from the password) is the vault's; null when it isn't. */
	open(auth: string): Promise<{ secrets: Pick<Secret, "id" | "project" | "meta">[]; value(id: number): Promise<string | undefined> } | null>;
	projectName(slug: string): Promise<string>;
	log(a: Omit<VaultAccess, "id" | "at">): Promise<void>;
};

/** The vault in this computer's database. */
export const dbVault = (db: Db): VaultStore => ({
	agentsOn: async () => getSetting<boolean>(db, "vault.agents"),
	info: async () => vaultInfo(db),
	open: async (auth) => (vaultAuthOk(db, auth) ? { secrets: listSecrets(db), value: async (id) => secretValue(db, id) } : null),
	projectName: async (slug) => projects(db).find((p) => p.slug === slug)?.name ?? slug,
	log: async (a) => logVaultAccess(db, a),
});

type Who = { db?: Db; store?: VaultStore; project?: string; session?: string };
type Found = { id: number; project: string; name: string; note: string };
type Opened = NonNullable<Awaited<ReturnType<VaultStore["open"]>>>;

const storeOf = (w: Who) => w.store ?? dbVault(w.db!);
const who = async (w: Who) => (w.project ? `An agent working on ${await storeOf(w).projectName(w.project)}` : "An agent");
const cleanReason = (r: string) =>
	r.replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]+/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_REASON);

/**
 * Asks Kostas for the vault password in the window, up to TRIES times, and gives back the key and the opened vault.
 * Throws a VaultRefusal (logged) when agent requests are off, there's no vault, or the answer is Deny, no answer,
 * or wrong every time.
 */
async function unlock(w: Who, ask: Omit<Ask, "title">, log: Pick<VaultAccess, "what" | "asked" | "delivery">): Promise<{ key: CryptoKey; vault: Opened }> {
	const store = storeOf(w);
	const entry = (outcome: VaultAccess["outcome"]) =>
		store.log({ project: w.project ?? "", session: w.session ?? "", secrets: [], ...log, outcome });
	if (!(await store.agentsOn())) {
		await entry("off");
		throw new VaultRefusal("agents may not ask for secrets on this board (Settings → Privacy and security → Vault). Ask Kostas to turn it on, or to give you the value another way.");
	}
	const info = await store.info();
	if (!info) throw new VaultRefusal("Kostas has no vault yet (the board's Vault button sets one up).");
	return oneAtATime(async () => {
		if (Date.now() - deniedAt < COOLDOWN_MS) {
			await entry("denied");
			throw new VaultRefusal("Kostas said no to a vault request a moment ago. Don't ask again unless they tell you to.");
		}
		let text = ask.text;
		for (let i = 0; i < TRIES; i++) {
			let answer: Answer;
			try {
				answer = await dialog.ask({ title: "Workbench vault", ...ask, text });
			} catch (e) {
				await entry("failed");
				throw new VaultRefusal(`${(e as Error).message}. Ask Kostas for the value another way.`);
			}
			if (answer === null) {
				deniedAt = Date.now();
				await entry("denied");
				throw new VaultRefusal("Kostas said no. Don't ask again unless they tell you to; carry on without it, or ask them what to do.");
			}
			if (typeof answer === "object") {
				await entry("no-answer");
				throw new VaultRefusal(`nobody answered the password window within ${ANSWER_SECONDS / 60} minutes. Kostas may be away: carry on with other work, or file what you need for them on the board.`);
			}
			const d = await deriveVault(answer, info);
			const vault = await store.open(d.auth);
			if (vault) return { key: d.key, vault };
			text = `Wrong password, try again.\n\n${ask.text}`;
		}
		await entry("wrong-password");
		throw new VaultRefusal("the vault password was wrong every time. Don't ask again unless Kostas tells you to.");
	});
}

/** The secrets an agent in `project` may see: that project's and those for every project (all of them for none). */
async function readNames(vault: Opened, key: CryptoKey, project?: string): Promise<Found[]> {
	const rows = vault.secrets.filter((s) => !project || !s.project || s.project === project);
	return Promise.all(rows.map(async (r) => ({ id: r.id, project: r.project, ...(await unseal<{ name: string; note: string }>(key, r.meta)) })));
}

/** vault_list: the names and notes of the secrets the agent may ask for, never a value. */
export async function listForAgent(w: Who, reason: string) {
	const { key, vault } = await unlock(
		w,
		{
			text: `${await who(w)} asks to see the names of your vault secrets${w.project ? " for that project" : ""} (not their values).\n\nThe agent says: “${cleanReason(reason)}”\n\nEnter the vault password to show it the names.`,
			ok: "Show names",
		},
		{ what: "names", asked: 0, delivery: "" },
	);
	const found = (await readNames(vault, key, w.project)).sort((a, b) => a.name.localeCompare(b.name));
	await storeOf(w).log({ project: w.project ?? "", session: w.session ?? "", what: "names", asked: 0, secrets: [], delivery: "", outcome: "given" });
	return found.map(({ name, note, project }) => ({ name, note, project }));
}

export type Delivery = "file" | "text";
export type Given = { name: string; env: string; project: string; value?: string };

/**
 * vault_get: the named secrets, after a window that lists them. A name matches exactly, else ignoring case or as its
 * .env spelling; the project's own secret wins over one for every project. Names not found are reported back.
 */
export async function getForAgent(w: Who, names: string[], reason: string, deliver: Delivery) {
	const wanted = [...new Set(names.map((n) => n.trim()).filter(Boolean))];
	if (!wanted.length) throw new VaultRefusal("name at least one secret (vault_list shows them)");
	const where =
		deliver === "file"
			? `They go into a private file for the agent to use (deleted after ${FILE_MINUTES} minutes), not into its conversation.`
			: "The agent sees the values, and they stay in its conversation.";
	const { key, vault } = await unlock(
		w,
		{
			text: `${await who(w)} asks for ${wanted.length === 1 ? "this secret" : `these ${wanted.length} secrets`}:\n${wanted.map((n) => `   •  ${n}`).join("\n")}\n\nThe agent says: “${cleanReason(reason)}”\n\n${where}\n\nEnter the vault password to give ${wanted.length === 1 ? "it" : "them"}.`,
			ok: wanted.length === 1 ? "Give it" : "Give them",
		},
		{ what: "values", asked: wanted.length, delivery: deliver },
	);
	const all = await readNames(vault, key, w.project);
	const rank = (s: Found) => (s.project === w.project ? 0 : s.project === "" ? 1 : 2);
	const given: (Found & { value: string })[] = [];
	const missing: string[] = [];
	for (const n of wanted) {
		const hits = [
			(s: Found) => s.name === n,
			(s: Found) => s.name.toLowerCase() === n.toLowerCase(),
			(s: Found) => envName(s.name) === envName(n),
		]
			.map((f) => all.filter(f).sort((a, b) => rank(a) - rank(b)))
			.find((l) => l.length);
		// Two with the same name in different projects (when no project is set) aren't guessed between.
		const s = hits && (hits.length === 1 || rank(hits[0]!) < rank(hits[1]!)) ? hits[0]! : undefined;
		if (!s || given.some((g) => g.id === s.id)) {
			if (!s) missing.push(hits ? `${n} (in more than one project: pass project)` : n);
			continue;
		}
		const sealed = await vault.value(s.id);
		if (!sealed) {
			missing.push(n);
			continue;
		}
		given.push({ ...s, value: (await unseal<{ value: string }>(key, sealed)).value });
	}
	await storeOf(w).log({
		project: w.project ?? "",
		session: w.session ?? "",
		what: "values",
		asked: wanted.length,
		secrets: given.map((g) => g.id),
		delivery: deliver,
		outcome: "given",
	});
	const out: Given[] = given.map((g) => ({ name: g.name, env: envName(g.name), project: g.project, ...(deliver === "text" ? { value: g.value } : {}) }));
	const file = deliver === "file" && given.length ? writeEnvFile(given) : undefined;
	return { given: out, missing, file };
}

/* ---------- What the tools answer (mcp.ts, and relay.ts on a computer that syncs) ---------- */

export function listReply(list: Awaited<ReturnType<typeof listForAgent>>, project: string | undefined) {
	const scope = (p: string) => (p ? p : "every project");
	return {
		text: list.length
			? `${list.length} secret${list.length === 1 ? "" : "s"} ${project ? `for ${project} (and every project)` : "in the vault"}:\n${list.map((s) => `- ${s.name} (${scope(s.project)})${s.note ? `: ${s.note}` : ""}`).join("\n")}\n\nvault_get gives the values, after {{name}} allows it again.`
			: `No secrets ${project ? `for ${project} or every project ` : ""}in the vault.`,
		data: { secrets: list },
	};
}

export function getReply(r: Awaited<ReturnType<typeof getForAgent>>) {
	const missing = r.missing.length ? `\nNot found: ${r.missing.join(", ")} (vault_list shows the names).` : "";
	if (!r.given.length) return { text: `None of those are in the vault.${missing}`, data: { given: [] as Given[], missing: r.missing } };
	const text = r.file
		? `${r.given.length} secret${r.given.length === 1 ? "" : "s"} written to ${r.file} (deleted in ${FILE_MINUTES} minutes), as ${r.given.map((g) => g.env).join(", ")}.\nUse: set -a; . ${r.file}; set +a; <command>. Don't print the values.${missing}`
		: `${r.given.map((g) => `${g.env}=${g.value}`).join("\n")}\n\nKeep these out of files, commits and messages.${missing}`;
	return { text, data: { given: r.given, missing: r.missing, ...(r.file ? { file: r.file, expires_minutes: FILE_MINUTES } : {}) } };
}

/* ---------- The .env file ---------- */

/** As the vault's .env export (ui/vault.js) spells a name. */
export const envName = (name: string) =>
	/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : name.trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^(?=\d)/, "_");
export function envValue(v: string) {
	if (/^[A-Za-z0-9_.\-\/:@+=,]*$/.test(v)) return v;
	if (!/['\n]/.test(v)) return `'${v}'`;
	return `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\$/g, "\\$").replace(/`/g, "\\`").replace(/\n/g, "\\n")}"`;
}

/** The runtime folder (tmpfs, this user's only, emptied at logout) when there is one. */
export const fileDir = () => join(process.env.XDG_RUNTIME_DIR || tmpdir(), "workbench-vault");

function writeEnvFile(given: { name: string; note: string; value: string }[]): string {
	const dir = fileDir();
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	chmodSync(dir, 0o700);
	sweep(dir);
	const path = join(dir, `${randomBytes(9).toString("hex")}.env`);
	const text = given.map((g) => `${g.note ? `# ${g.note.replace(/\n/g, " ")}\n` : ""}${envName(g.name)}=${envValue(g.value)}`).join("\n") + "\n";
	writeFileSync(path, text, { mode: 0o600, flag: "wx" });
	setTimeout(() => rmSync(path, { force: true }), FILE_MINUTES * 60e3).unref();
	return path;
}

/** Files left by a server that stopped before its timer ran. */
function sweep(dir: string) {
	const old = Date.now() - FILE_MINUTES * 60e3;
	for (const f of readdirSync(dir))
		try {
			if (f.endsWith(".env") && statSync(join(dir, f)).mtimeMs < old) rmSync(join(dir, f), { force: true });
		} catch {}
}
