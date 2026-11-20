/**
 * Built-in tracker readers: the ones that need more than a one-line command. Each turns what a CLI the user is
 * already logged into (gh, eas) reports into a Reading. They run like command trackers: in the tracker's
 * project folder, with the user's shell PATH, one minute at most.
 */
import type { Reading } from "./trackers";

export type PresetContext = {
	/** The tracker's project folder (home for a global tracker). */
	cwd: string;
	/** The tracker's options, defaults filled in. */
	options: Record<string, string>;
	/** Runs a shell command there; resolves stdout, rejects with the exit code and its last lines. */
	run(cmd: string): Promise<string>;
};

export type Preset = {
	title: string;
	/** One line: what it reads and what it needs. */
	about: string;
	unit?: string;
	/** Default interval, seconds. */
	every: number;
	options: Record<string, { about: string; default?: string }>;
	read(ctx: PresetContext): Promise<Reading>;
};

const SAFE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const q = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

function json<T>(text: string, what: string): T {
	try {
		return JSON.parse(text) as T;
	} catch {
		throw new Error(`${what} didn't answer JSON: ${text.trim().slice(0, 120)}`);
	}
}

const startOfNextMonthUtc = (now = new Date()) =>
	new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();

/* ---------- GitHub Actions ---------- */

// GitHub bills hosted runners by the minute at a per-SKU rate and takes the cost out of the plan's monthly
// included compute: $12 on GitHub Free, $18 on Pro (docs.github.com/en/billing/concepts/product-billing/
// github-actions). Public repositories and self-hosted runners don't draw from it. A standard Linux minute
// costs $0.006, which is how dollars become "minutes" here.
const LINUX_MINUTE_USD = 0.006;

type UsageItem = {
	date: string;
	product: string;
	sku: string;
	quantity: number;
	unitType: string;
	grossAmount: number;
	netAmount: number;
	repositoryName?: string;
};

async function githubActions({ options, run }: PresetContext): Promise<Reading> {
	const gh = async (args: string) => {
		try {
			return await run(`gh ${args}`);
		} catch (e) {
			const msg = (e as Error).message;
			if (/not found|command not found|exit 127/i.test(msg) && /gh: (command )?not found|exit 127/.test(msg))
				throw new Error("gh isn't installed (https://cli.github.com)");
			if (/auth login|not logged/i.test(msg)) throw new Error("gh isn't logged in: run gh auth login");
			if (/billing/.test(args) && /404|scope|user/i.test(msg))
				throw new Error(`gh's token can't read billing (it needs the "user" scope): run gh auth refresh -h github.com -s user`);
			throw e;
		}
	};
	const login = (options.account || (await gh("api user --jq .login"))).trim();
	if (!SAFE.test(login)) throw new Error(`"${login}" is not a GitHub account name`);
	const included = Number(options.included || 12);
	if (!(included > 0)) throw new Error("included is the plan's monthly compute in USD, e.g. 12 (Free) or 18 (Pro)");
	const now = new Date();
	const [usage, publicRepos] = await Promise.all([
		gh(`api ${q(`users/${login}/settings/billing/usage?year=${now.getUTCFullYear()}&month=${now.getUTCMonth() + 1}`)}`),
		gh(`repo list ${q(login)} --visibility public --limit 1000 --json nameWithOwner --jq '.[].nameWithOwner'`),
	]);
	const items = json<{ usageItems?: UsageItem[] }>(usage, "GitHub's billing API").usageItems ?? [];
	const pub = new Set(
		publicRepos
			.split("\n")
			.map((s) => s.trim().toLowerCase())
			.filter(Boolean)
			.flatMap((full) => [full, full.split("/").pop()!]),
	);
	const counted = items.filter(
		(i) =>
			/actions/i.test(i.product) &&
			/^minutes?$/i.test(i.unitType) &&
			!/self/i.test(i.sku) &&
			!pub.has((i.repositoryName ?? "").toLowerCase()),
	);
	const usd = counted.reduce((n, i) => n + (Number(i.grossAmount) || 0), 0);
	// Minutes per runner type, for the note: "linux 230 min · macos 4 min".
	const perSku = new Map<string, number>();
	for (const i of counted) {
		const os = i.sku.toLowerCase().replace(/^actions[_ ]/, "").replace(/[_ ]/g, " ");
		perSku.set(os, (perSku.get(os) ?? 0) + (Number(i.quantity) || 0));
	}
	const breakdown = [...perSku].sort((a, b) => b[1] - a[1]).map(([os, n]) => `${os} ${Math.round(n)} min`);
	const dollars = options.show === "dollars";
	const money = (n: number) => `$${n.toFixed(2).replace(/\.00$/, "")}`;
	return {
		meters: [
			dollars
				? { label: "", value: Math.round(usd * 100) / 100, max: included, unit: "USD" }
				: { label: "", value: Math.round(usd / LINUX_MINUTE_USD), max: Math.round(included / LINUX_MINUTE_USD), unit: "min" },
		],
		note: [
			dollars ? "" : `${money(usd)} of ${money(included)}`,
			breakdown.length > 1 || (breakdown.length && !/^linux/.test(breakdown[0])) ? breakdown.join(", ") : "",
			usd > included ? `${money(usd - included)} over` : "",
		]
			.filter(Boolean)
			.join(" · ")
			.slice(0, 200),
		resets_at: startOfNextMonthUtc(now),
		url: "https://github.com/settings/billing/usage",
	};
}

/* ---------- EAS builds ---------- */

// `eas account:usage <account> --json` (eas-cli 16.32+) reports the billing period's builds per platform against
// the plan: on Free, 15 Android and 15 iOS a month, from the 1st (paid plans run from the subscription date, and
// may have no per-platform split). It needs the account name when it can't ask, and the login eas-cli keeps in
// ~/.expo/state.json (or EXPO_TOKEN).
type PlanUse = { used?: number; limit?: number };
type EasUsage = {
	account?: { name?: string; plan?: string; billingPeriod?: { start?: string; end?: string } };
	builds?: {
		plan?: PlanUse;
		ios?: { plan?: PlanUse };
		android?: { plan?: PlanUse };
		overage?: { count?: number; costCents?: number };
	};
	billingUrl?: string;
};

// eas itself when it's installed, else through bunx or npx: the shell picks whichever it finds.
const EAS = `{ if command -v eas >/dev/null 2>&1; then eas "$@"; elif command -v bunx >/dev/null 2>&1; then bunx eas-cli "$@"; else npx --yes eas-cli "$@"; fi; }`;

async function easAccount({ cwd, options, run }: PresetContext): Promise<string> {
	if (options.account) return options.account;
	// The project's own owner, as in app.json; a dynamic app.config can't be read without running it.
	try {
		const app = (await Bun.file(`${cwd}/app.json`).json()) as { expo?: { owner?: string }; owner?: string };
		const owner = app.expo?.owner ?? app.owner;
		if (owner) return owner;
	} catch {}
	const who = (await run(`eas_() ${EAS}; eas_ whoami --non-interactive`)).trim().split("\n")[0]?.trim() ?? "";
	if (!who) throw new Error("no Expo account: set the account option, or log in with eas login");
	return who;
}

async function easBuilds(ctx: PresetContext): Promise<Reading> {
	const account = await easAccount(ctx);
	if (!SAFE.test(account)) throw new Error(`"${account}" is not an Expo account name`);
	let out: string;
	try {
		out = await ctx.run(`eas_() ${EAS}; eas_ account:usage ${q(account)} --json --non-interactive`);
	} catch (e) {
		const msg = (e as Error).message;
		if (/account is required|not logged in|log in/i.test(msg)) throw new Error("eas-cli isn't logged in: run eas login (or set EXPO_TOKEN)");
		if (/account:usage.*(not|isn't) a|command account:usage not found|unknown command/i.test(msg))
			throw new Error("this eas-cli has no account:usage; update it (npm i -g eas-cli, or bunx eas-cli@latest)");
		throw e;
	}
	const u = json<EasUsage>(out.slice(out.indexOf("{")), "eas account:usage");
	const b = u.builds ?? {};
	const meter = (label: string, p?: PlanUse) =>
		p && typeof p.used === "number" ? [{ label, value: p.used, ...(typeof p.limit === "number" ? { max: p.limit } : {}) }] : [];
	const split = [...meter("Android", b.android?.plan), ...meter("iOS", b.ios?.plan)];
	const meters = ctx.options.show !== "total" && split.length ? split : meter("Builds", b.plan);
	if (!meters.length) throw new Error("eas account:usage reported no build numbers");
	const over = b.overage?.count ? `${b.overage.count} over plan ($${((b.overage.costCents ?? 0) / 100).toFixed(2)})` : "";
	return {
		meters,
		note: [u.account?.plan ? `${u.account.plan} plan` : "", over, account].filter(Boolean).join(" · "),
		resets_at: u.account?.billingPeriod?.end,
		url: `https://expo.dev/accounts/${account}/settings/usage`,
	};
}

/* ---------- The list ---------- */

export const PRESETS: Record<string, Preset> = {
	"github-actions": {
		title: "GitHub Actions",
		about:
			"free Actions compute used this month on your GitHub account (private repos; public ones are free), via gh. " +
			'Needs gh\'s "user" scope: gh auth refresh -h github.com -s user',
		unit: "min",
		every: 3600,
		options: {
			account: { about: "GitHub user (default: the one gh is logged in as)" },
			included: { about: "monthly included compute in USD: 12 on Free, 18 on Pro", default: "12" },
			show: { about: '"minutes" (Linux-minute equivalent, default) or "dollars"', default: "minutes" },
		},
		read: githubActions,
	},
	"eas-builds": {
		title: "EAS builds",
		about:
			"EAS builds used this billing period against the Expo plan, per platform (Free: 15 Android + 15 iOS a month), " +
			"via eas-cli account:usage. Needs eas login (or EXPO_TOKEN)",
		unit: "",
		every: 3600,
		options: {
			account: { about: "Expo account (default: owner in the project's app.json, else the one eas is logged in as)" },
			show: { about: '"platforms" (Android and iOS, default) or "total"', default: "platforms" },
		},
		read: easBuilds,
	},
};
