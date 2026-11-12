const KINDS = ["task", "check", "review", "decision", "setup", "bug", "idea"];
const STATUSES = ["todo", "doing", "waiting", "done", "dropped"];
const OPEN = ["todo", "doing", "waiting"];
// Board sections, in order; the third value is whether a section starts open.
const SECTIONS = [["decision", "Decisions", true], ["setup", "Setup", true], ["check", "Checks", true], ["review", "Reviews", true],
	["bug", "Bugs", true], ["task", "Tasks", true], ["idea", "Ideas", false]];
// Same line glyphs as the day reports (day.ts).
const RING = '<circle cx="8" cy="8" r="6.25"/>';
const GLYPH = {
	image: '<rect x="2" y="3" width="12" height="10" rx="1.5"/><circle cx="5.75" cy="6.5" r="1"/><path d="m2.5 11.5 3-2.75 2.25 2 2.75-3 3 3.25"/>',
	check: RING + '<path d="M5.2 8.2l1.9 1.9 3.7-4"/>',
	play: RING + '<path d="M6.8 5.6v4.8L10.6 8z"/>',
	pause: RING + '<path d="M6.5 5.8v4.4M9.5 5.8v4.4"/>',
	commit: '<circle cx="8" cy="8" r="2.6"/><path d="M1.5 8h3.9M10.6 8h3.9"/>',
	// One per kind, in the kind's colour: section headers and search results.
	"k-decision": '<path d="M8 14.25V8.75L4 4.25M8 8.75l4-4.5M3.75 7.25V4h3.25M12.25 7.25V4H9"/>',
	"k-setup": '<path d="M10.6 2.1a3.4 3.4 0 0 0-3.9 4.5L2.3 11a1.5 1.5 0 0 0 2.1 2.1l4.4-4.4a3.4 3.4 0 0 0 4.5-3.9l-2.1 2.1-1.9-.3-.3-1.9z"/>',
	"k-check": '<rect x="4.25" y="1.75" width="7.5" height="12.5" rx="1.75"/><path d="M6.3 7.9l1.3 1.3 2.2-2.5M7.25 12.1h1.5"/>',
	"k-review": '<path d="M1.75 8S4.25 3.75 8 3.75 14.25 8 14.25 8 11.75 12.25 8 12.25 1.75 8 1.75 8z"/><circle cx="8" cy="8" r="1.9"/>',
	"k-bug": '<path d="M6.2 5.9a1.8 1.8 0 0 1 3.6 0M6.6 4.3 5.7 2.7M9.4 4.3l.9-1.6"/><rect x="4.75" y="5.75" width="6.5" height="8" rx="3.25"/><path d="M8 8.25v5.5M4.75 9.5H2.4M11.25 9.5h2.35M5 7.2 3.4 5.9M11 7.2l1.6-1.3M5.1 12.2l-1.7 1.3M10.9 12.2l1.7 1.3"/>',
	"k-task": '<path d="M5.25 4.5 1.75 8l3.5 3.5M10.75 4.5 14.25 8l-3.5 3.5M9.1 3 6.9 13"/>',
	"k-idea": '<path d="M6.25 11.25c0-1.1-.5-1.8-1.2-2.5a4 4 0 1 1 5.9 0c-.7.7-1.2 1.4-1.2 2.5zM6.5 13.75h3"/>',
};
const kindIcon = (kind) => `<span class="kic k-${kind}" aria-hidden="true">${glyph(`k-${kind}`)}</span>`;
const glyph = (name) => `<svg class="gl" viewBox="0 0 16 16" aria-hidden="true">${GLYPH[name]}</svg>`;
const WHO = [["all", "Everything"], ["kostas", "Needs you"], ["agent", "With agents"]];
const $ = (s, el = document) => el.querySelector(s);
const solo = new URLSearchParams(location.search).has("solo");
const state = {
	project: localGet("project") || "", who: startWho(), items: [], projects: [], allProjects: [], links: [], reports: [], repos: [],
	code: {}, sources: [], trackers: [], current: null, report: null, reportV: null, collapsed: narrow() || localGet("rail") === "collapsed",
};
// On a phone the rail opens over the page, so it starts folded and its state isn't remembered.
function narrow() { return matchMedia("(max-width: 760px)").matches; }

function localGet(k) { try { return localStorage.getItem("wb." + k); } catch { return null; } }
function localSet(k, v) { try { localStorage.setItem("wb." + k, v); } catch {} }
// A setting kept in this browser (Settings, the "browser" rows; settings.js).
function pref(key, def) {
	const raw = localGet(`pref.${key}`);
	if (raw == null) return def;
	try { return JSON.parse(raw); } catch { return def; }
}
// Settings → Appearance: the board opens on the last filter used ("last"), or always on one. Runs while `state` is
// built, so nothing declared with const below this point can be used here.
function startWho() {
	const START_WHO = ["all", "kostas", "agent"];
	const v = pref("look.start", "last");
	if (START_WHO.includes(v)) return v;
	const last = localGet("who");
	return START_WHO.includes(last) ? last : "all";
}
// Everything is redrawn on every poll, so whether a <details data-key> is open lives here.
const folds = (() => {
	try {
		const f = JSON.parse(localGet("folds") || "null");
		if (f) return f;
		return Object.fromEntries(JSON.parse(localGet("open") || "[]").map((k) => [k, true]));
	} catch { return {}; }
})();
const isOpen = (key, def = false) => ((folds[key] ?? def) ? " open" : "");
document.addEventListener("toggle", (e) => {
	const key = e.target.dataset?.key;
	if (!key) return;
	folds[key] = e.target.open;
	localSet("folds", JSON.stringify(folds));
}, true);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
// Only touches the DOM when the markup changed, so polling doesn't reload icons or reset scroll.
function paint(el, html) {
	if (el._html === html) return;
	el._html = html;
	el.innerHTML = html;
}

function md(src) {
	const inline = (s) => esc(s)
		.replace(/`([^`]+)`/g, "<code>$1</code>")
		.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
		.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
	const out = []; const lists = []; let fence = null;
	const closeList = () => out.push(`</li></${lists.pop().tag}>`);
	const closeLists = () => { while (lists.length) closeList(); };
	const openList = (tag, indent, n) => {
		// A list interrupted by a quote or a paragraph carries on from its own number, instead of starting over at 1.
		out.push(n && n !== "1" ? `<ol start="${n}">` : `<${tag}>`);
		lists.push({ tag, indent });
	};
	for (const line of String(src || "").split("\n")) {
		if (/^\s*```/.test(line)) {
			if (fence) { out.push(`<pre>${esc(fence.join("\n"))}</pre>`); fence = null; }
			else { closeLists(); fence = []; }
			continue;
		}
		if (fence) { fence.push(line); continue; }
		const m = line.match(/^(\s*)(?:([-*])|(\d+)[.)])\s+(.*)$/);
		if (m) {
			const tag = m[2] ? "ul" : "ol";
			const indent = m[1].replace(/\t/g, "    ").length;
			while (lists.length > 1 && lists.at(-1).indent > indent) closeList();
			const top = lists.at(-1);
			if (!top) openList(tag, indent, m[3]);
			else if (indent >= top.indent + 2) openList(tag, indent, m[3]); // inside the open item
			else if (top.tag !== tag) { closeList(); openList(tag, indent, m[3]); }
			else out.push("</li>");
			out.push(`<li>${inline(m[4])}`);
			continue;
		}
		// Between items a blank line changes nothing, and an indented line goes on with the item above.
		if (lists.length && !line.trim()) continue;
		if (lists.length && /^\s+\S/.test(line)) { out.push(`<br>${inline(line.trim())}`); continue; }
		closeLists();
		const heading = line.match(/^#{1,6}\s+(.*)$/);
		const quote = line.match(/^>\s?(.*)$/);
		if (heading) out.push(`<h4>${inline(heading[1])}</h4>`);
		else if (quote) out.push(`<blockquote>${inline(quote[1])}</blockquote>`);
		else if (line.trim()) out.push(`<p>${inline(line)}</p>`);
	}
	if (fence) out.push(`<pre>${esc(fence.join("\n"))}</pre>`);
	closeLists();
	return out.join("");
}

function hl(text, q) {
	text = String(text ?? "");
	if (!q) return esc(text);
	const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
	let out = "", last = 0;
	for (const m of text.matchAll(re)) {
		out += esc(text.slice(last, m.index)) + `<mark>${esc(m[0])}</mark>`;
		last = m.index + m[0].length;
	}
	return out + esc(text.slice(last));
}

const parseTime = (s) => new Date(s.replace(" ", "T") + "Z");
function ago(s) {
	const d = (Date.now() - parseTime(s)) / 1000;
	if (d < 60) return "just now";
	if (d < 3600) return `${Math.floor(d / 60)} min ago`;
	if (d < 86400) return `${Math.floor(d / 3600)} h ago`;
	if (d < 86400 * 30) return `${Math.floor(d / 86400)} d ago`;
	return parseTime(s).toLocaleDateString();
}
const sessionHref = (s) => /^local_[0-9a-f-]+$/.test(s) ? `claude://claude.ai/epitaxy/${s}` : null;
const projectName = (slug) => state.allProjects.find((p) => p.slug === slug)?.name ?? slug;
// Archived projects stay out of the rail and "All", but their names still resolve (search, old items).
const isArchived = (slug) => !!slug && state.allProjects.some((p) => p.slug === slug && p.archived_at);
const initials = (name) => name.split(/[\s_-]+|(?<=[a-z])(?=[A-Z])/).filter((w) => /^[\p{L}\p{N}]/u.test(w)).slice(0, 2).map((w) => w[0]).join("").toUpperCase() || "?";
const hue = (s) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
// Changes with the project's folder and logo setting, so the browser doesn't keep showing the old one.
const logoV = (p) => [...`${p.path ?? ""}|${p.icon ?? ""}`].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7).toString(36);
// A logo or icon that fails to load is replaced by its letters (see the error listener).
const logo = (p) => p.slug
	? `<img class="plogo" alt="" data-letter="${esc(initials(p.name))}" style="--hue:${hue(p.slug)}" src="/api/projects/${encodeURIComponent(p.slug)}/logo?v=${logoV(p)}">`
	: `<img class="plogo" alt="" src="/favicon.svg">`;
let iconRound = 0;
const fav = (l) => `<img class="fav" alt="" data-letter="${esc((l.label.trim()[0] || "?").toUpperCase())}" src="/api/links/${l.id}/icon?v=${encodeURIComponent(l.icon_url || l.url)}-${iconRound}">`;
const DOC = `<svg class="doc-ic" viewBox="0 0 16 16" fill="none" stroke="currentColor"><g stroke-width="1.3"><path d="M3.75 1.75h5.5l3 3v9.5h-8.5z"/><path d="M9.25 1.75v3h3M6 8.25h4M6 10.75h4"/></g></svg>`;

async function api(path, opts = {}) {
	const res = await fetch(path, { ...opts, headers: { "content-type": "application/json", ...opts.headers } });
	const data = await res.json();
	if (!res.ok) throw new Error(data.error || res.statusText);
	return data;
}
