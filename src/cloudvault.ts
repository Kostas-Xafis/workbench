/**
 * The vault's password window for agents while this computer syncs (docs/cloud.md, "The computer helper"). `wb mcp`'s
 * relay (relay.ts) answers vault_list and vault_get itself, on this computer: the window opens here, the password is
 * typed here, the secrets are decrypted here and the .env file is written here, where the agent runs. From the
 * cloud board it takes only what the board's own vault page takes: the vault's salt, and the sealed secrets once the
 * password's auth token opens them (/api/secrets, as on a computer). What was asked is logged on the cloud board.
 */
import { cloudFetch, type SyncConfig } from "./sync";
import { getForAgent, getReply, listForAgent, listReply, VaultRefusal, type VaultStore } from "./vaultask";
import type { Secret, VaultInfo } from "./db";

const getJson = async <T>(cfg: SyncConfig, path: string, headers: Record<string, string> = {}): Promise<T> => (await cloudFetch(cfg, path, { headers })).json() as Promise<T>;

/** The vault on the cloud board, as this computer's device reaches it. */
export function cloudVault(cfg: SyncConfig): VaultStore {
	return {
		agentsOn: async () => !!(await getJson<Record<string, unknown>>(cfg, "/api/settings"))["vault.agents"],
		info: () => getJson<VaultInfo | null>(cfg, "/api/vault"),
		open: async (auth) => {
			let secrets: Secret[];
			try {
				secrets = await getJson<Secret[]>(cfg, "/api/secrets", { "x-vault-auth": auth });
			} catch (e) {
				if (/ 401:/.test((e as Error).message)) return null;
				throw e;
			}
			return {
				secrets,
				value: async (id) => (await getJson<{ value?: string }>(cfg, `/api/secrets/${id}`, { "x-vault-auth": auth })).value,
			};
		},
		projectName: async (slug) => (await getJson<{ slug: string; name: string }[]>(cfg, "/api/projects")).find((p) => p.slug === slug)?.name ?? slug,
		log: async (entry) => {
			await cloudFetch(cfg, "/api/helper/vault-log", { method: "POST", body: JSON.stringify({ entry }) }).catch(() => {});
		},
	};
}

/** The vault tools the relay answers here. */
export const VAULT_TOOLS = new Set(["vault_list", "vault_get"]);

/** Runs vault_list or vault_get as the MCP server does (mcp.ts), against the cloud board's vault. */
export async function vaultHere(cfg: SyncConfig, name: string, a: Record<string, unknown>, defaultProject: string | undefined): Promise<{ text: string; data?: Record<string, unknown> } | { error: string }> {
	try {
		const reason = typeof a.reason === "string" ? a.reason : "";
		if (reason.trim().length < 3) throw new VaultRefusal("say why you need it (reason)");
		let project = defaultProject;
		if (typeof a.project === "string" && a.project !== "") {
			if (a.project === "*") project = undefined;
			else {
				const all = await getJson<{ slug: string; name: string }[]>(cfg, "/api/projects");
				const want = a.project.trim().toLowerCase();
				const found = all.find((p) => p.slug === a.project) ?? all.find((p) => p.slug.toLowerCase() === want || p.name.toLowerCase() === want);
				if (!found) throw new VaultRefusal(`no project "${a.project}"; there are: ${all.map((p) => p.slug).join(", ")}`);
				project = found.slug;
			}
		}
		const w = { store: cloudVault(cfg), project };
		if (name === "vault_list") return listReply(await listForAgent(w, reason), project);
		const names = Array.isArray(a.names) ? a.names.map(String) : [];
		if (!names.length || names.length > 20) throw new VaultRefusal("names: the secrets you need, 1 to 20 of them");
		return getReply(await getForAgent(w, names, reason, a.deliver === "text" ? "text" : "file"));
	} catch (e) {
		return { error: (e as Error).message || String(e) };
	}
}
