import type { Report } from "./db";

/**
 * Runs first in every report page. The page is sandboxed (no same-origin access to the board),
 * so `window.wb` asks the board that frames it, which answers read-only questions only.
 */
const CLIENT = `(() => {
	// The theme picked on the board (Settings → Appearance): ?wbtheme= on the frame's address, so the first paint is
	// right, then "theme" messages. The --wb-* colours follow it, and so do the page's own prefers-color-scheme
	// rules: where the pick differs from the system, their media queries are flipped.
	let theme = "";
	const os = matchMedia("(prefers-color-scheme: dark)");
	const orig = new WeakMap();
	const flip = (t) => t.replace(/prefers-color-scheme: *(dark|light)/g, (_, s) => "prefers-color-scheme: " + (s === "dark" ? "light" : "dark"));
	const fix = (obj, get, set) => {
		if (!orig.has(obj)) orig.set(obj, get());
		const was = orig.get(obj);
		if (!was.includes("prefers-color-scheme")) return;
		const want = theme && (theme === "dark") !== os.matches ? flip(was) : was;
		if (get() !== want) set(want);
	};
	const walk = (rules) => {
		for (const r of rules) {
			if (r instanceof CSSMediaRule) fix(r, () => r.media.mediaText, (t) => { r.media.mediaText = t; });
			if (r.cssRules) walk(r.cssRules);
		}
	};
	const applyTheme = () => {
		const root = document.documentElement;
		if (theme) root.dataset.wbTheme = theme; else delete root.dataset.wbTheme;
		for (const s of document.styleSheets) { try { walk(s.cssRules); } catch {} }
		for (const el of document.querySelectorAll("link[media], style[media], source[media]")) fix(el, () => el.media, (t) => { el.media = t; });
	};
	const setTheme = (t) => { theme = t === "light" || t === "dark" ? t : ""; applyTheme(); };
	setTheme(new URLSearchParams(location.search).get("wbtheme"));
	addEventListener("DOMContentLoaded", applyTheme);
	addEventListener("load", applyTheme);
	os.addEventListener("change", applyTheme);
	const pending = new Map();
	const refresh = new Set();
	let n = 0;
	addEventListener("message", (e) => {
		const m = e.data;
		if (e.source !== parent || !m || m.wb !== 1) return;
		if (m.event === "refresh") return refresh.forEach((f) => { try { f(); } catch (err) { console.error(err); } });
		if (m.event === "theme") return setTheme(m.theme);
		const p = pending.get(m.id);
		if (!p) return;
		pending.delete(m.id);
		m.error ? p.reject(new Error(m.error)) : p.resolve(m.result);
	});
	const call = (method, ...args) => new Promise((resolve, reject) => {
		if (parent === window) return reject(new Error("open this report from the workbench to read the board"));
		const id = ++n;
		pending.set(id, { resolve, reject });
		parent.postMessage({ wb: 1, id, method, args, report: window.wb.report.id }, "*");
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
		/** Status trackers of this project and the global ones ("*": all), with their readings and levels. */
		trackers: (project) => call("trackers", project),
		/** Opens the item's dialog on the board. */
		open: (ref) => call("open", ref),
		/** This report's saved state (kept by project + name, across versions). Outside the board: get → null, set → false. */
		state: {
			get: () => parent === window ? Promise.resolve(null) : call("stateGet"),
			/** Replaces the saved state with obj (an object or array, as JSON, ≤ 256 KB). Resolves true. */
			set: (obj) => parent === window ? Promise.resolve(false) : call("stateSet", JSON.stringify(obj)),
			clear: () => parent === window ? Promise.resolve(false) : call("stateClear"),
		},
		/**
		 * Calls this project's data source \`name\` (wb sources) through the board, which adds its secret headers.
		 * path is joined onto the source's base URL. opts: { method: "GET" | "POST" | …, body, query }.
		 * Resolves { ok, status, type, json | text } (location on a redirect), or { ok: false, status: 0, error }.
		 */
		fetch: (name, path = "", opts = {}) => (parent === window
			? Promise.resolve({ ok: false, status: 0, error: "open this report from the workbench to use its data sources" })
			: call("fetch", name, path, opts)).catch((e) => ({ ok: false, status: 0, error: e.message })),
		/** Called whenever the board refreshes (every 10 s while visible). */
		onRefresh: (f) => { refresh.add(f); return () => refresh.delete(f); },
	};
})();`;

// The board's palette, so a report can match it with var(--wb-…) and still choose its own look.
// Dark follows the system, unless the board that frames the page picked a theme (data-wb-theme, see CLIENT).
const DARK = `--wb-bg: #151514; --wb-card: #1f1f1d; --wb-ink: #ecebe8; --wb-muted: #a29e96;
	--wb-line: #33322f; --wb-hover: #2a2a27; --wb-accent: #8c9eff; --wb-good: #5fcf86; --wb-warn: #f0b45a; --wb-bad: #ff7b7b;`;
const THEME = `:root { --wb-bg: #f6f5f2; --wb-card: #ffffff; --wb-ink: #1d1c1a; --wb-muted: #6f6b64; --wb-line: #e3e0da;
	--wb-hover: #efede8; --wb-accent: #3d5afe; --wb-good: #15803d; --wb-warn: #b45309; --wb-bad: #dc2626;
	--wb-font: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; --wb-mono: ui-monospace, SFMono-Regular, Menlo, monospace; }
@media (prefers-color-scheme: dark) { :root:not([data-wb-theme="light"]) { ${DARK} } }
:root[data-wb-theme="dark"] { ${DARK} }`;

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
