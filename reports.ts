import type { Report } from "./db";

/**
 * Runs first in every report page. The page is sandboxed (no same-origin access to the board),
 * so `window.wb` asks the board that frames it, which answers read-only questions only.
 */
const CLIENT = `(() => {
	const pending = new Map();
	const refresh = new Set();
	let n = 0;
	addEventListener("message", (e) => {
		const m = e.data;
		if (e.source !== parent || !m || m.wb !== 1) return;
		if (m.event === "refresh") return refresh.forEach((f) => { try { f(); } catch (err) { console.error(err); } });
		const p = pending.get(m.id);
		if (!p) return;
		pending.delete(m.id);
		m.error ? p.reject(new Error(m.error)) : p.resolve(m.result);
	});
	const call = (method, ...args) => new Promise((resolve, reject) => {
		if (parent === window) return reject(new Error("open this report from the workbench to read the board"));
		const id = ++n;
		pending.set(id, { resolve, reject });
		parent.postMessage({ wb: 1, id, method, args }, "*");
	});
	window.wb = {
		report: __REPORT__,
		/** Items of this report's project. filter: { status: "open" | [..], kind, owner, q, project: slug | "*" } */
		items: (filter) => call("items", filter),
		/** One item with its notes, by wb-xxxx. */
		item: (ref) => call("item", ref),
		/** Git state of this project (or another, by slug). */
		git: (project) => call("git", project),
		links: (project) => call("links", project),
		projects: () => call("projects"),
		reports: (project) => call("reports", project),
		/** Opens the item's dialog on the board. */
		open: (ref) => call("open", ref),
		/** Called whenever the board refreshes (every 10 s while visible). */
		onRefresh: (f) => { refresh.add(f); return () => refresh.delete(f); },
	};
})();`;

// The board's palette, so a report can match it with var(--wb-…) and still choose its own look.
const THEME = `:root { --wb-bg: #f6f5f2; --wb-card: #ffffff; --wb-ink: #1d1c1a; --wb-muted: #6f6b64; --wb-line: #e3e0da;
	--wb-hover: #efede8; --wb-accent: #3d5afe; --wb-good: #15803d; --wb-warn: #b45309; --wb-bad: #dc2626;
	--wb-font: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; --wb-mono: ui-monospace, SFMono-Regular, Menlo, monospace; }
@media (prefers-color-scheme: dark) { :root { --wb-bg: #151514; --wb-card: #1f1f1d; --wb-ink: #ecebe8; --wb-muted: #a29e96;
	--wb-line: #33322f; --wb-hover: #2a2a27; --wb-accent: #8c9eff; --wb-good: #5fcf86; --wb-warn: #f0b45a; --wb-bad: #ff7b7b; } }`;

/** No same-origin access, even when the page is opened directly. */
export const REPORT_CSP =
	"sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox allow-forms allow-modals allow-downloads";

export function withBridge(html: string, report: Pick<Report, "id" | "project" | "name" | "title">, version: number) {
	const meta = JSON.stringify({ ...report, version }).replace(/</g, "\\u003c");
	const head = `<script>${CLIENT.replace("__REPORT__", meta)}</script><style>${THEME}</style>`;
	const at = html.match(/<head\b[^>]*>/i);
	if (at) return html.slice(0, at.index! + at[0].length) + head + html.slice(at.index! + at[0].length);
	const doctype = html.match(/^\s*<!doctype[^>]*>/i);
	return doctype ? doctype[0] + head + html.slice(doctype[0].length) : head + html;
}
