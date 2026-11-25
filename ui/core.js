// The cloud board (worker/, docs/cloud.md) says so on its page: <html data-cloud="1">. Paired devices are its owner
// there, but whatever needs a computer (sharing, Usage, agents, folders) isn't on it.
const CLOUD = document.documentElement.dataset.cloud === "1";
const KINDS = ["task", "check", "review", "decision", "setup", "bug", "idea", "notice"];
const STATUSES = ["todo", "doing", "waiting", "done", "dropped"];
const OPEN = ["todo", "doing", "waiting"];
// Waits on you: yours, open, and not a notice (notices are just so you know; asks.ts has the same rule). Every
// "needs you" count goes by this.
const needsYou = (i) => i.owner === "kostas" && OPEN.includes(i.status) && i.kind !== "notice";
// The kinds with their names, in the order lists of them go (Settings → Agents, the setup guide).
const KIND_NAMES = [["decision", "Decisions"], ["setup", "Setup"], ["check", "Checks"], ["review", "Reviews"],
	["notice", "Notices"], ["bug", "Bugs"], ["task", "Tasks"], ["idea", "Ideas"]];
// Same line glyphs as the day reports (day.ts).
const RING = '<circle cx="8" cy="8" r="6.25"/>';
const GLYPH = {
	image: '<rect x="2" y="3" width="12" height="10" rx="1.5"/><circle cx="5.75" cy="6.5" r="1"/><path d="m2.5 11.5 3-2.75 2.25 2 2.75-3 3 3.25"/>',
	check: RING + '<path d="M5.2 8.2l1.9 1.9 3.7-4"/>',
	play: RING + '<path d="M6.8 5.6v4.8L10.6 8z"/>',
	pause: RING + '<path d="M6.5 5.8v4.4M9.5 5.8v4.4"/>',
	commit: '<circle cx="8" cy="8" r="2.6"/><path d="M1.5 8h3.9M10.6 8h3.9"/>',
};
const glyph = (name) => `<svg class="gl" viewBox="0 0 16 16" aria-hidden="true">${GLYPH[name]}</svg>`;
const $ = (s, el = document) => el.querySelector(s);
const solo = new URLSearchParams(location.search).has("solo");
const state = {
	project: localGet("project") || "", items: [], projects: [], allProjects: [], links: [], reports: [], repos: [],
	code: {}, sources: [], trackers: [], current: null, report: null, reportV: null,
};
// A phone-sized window (phone.css's width).
function narrow() { return matchMedia("(max-width: 760px)").matches; }

function localGet(k) { try { return localStorage.getItem("wb." + k); } catch { return null; } }
function localSet(k, v) { try { localStorage.setItem("wb." + k, v); } catch {} }
// A setting kept in this browser (Settings, the "browser" rows; settings.js).
function pref(key, def) {
	const raw = localGet(`pref.${key}`);
	if (raw == null) return def;
	try { return JSON.parse(raw); } catch { return def; }
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
// Once, what only the board sorted by kind, its side column and Today kept in this browser goes: the who-switch, the
// folded side column, the old list of open sections, the sections' and the side column's folds, and the "board opens
// on" setting. The Inbox's last visit, which Today kept, moves to keys of its own (inbox.since, inbox.last).
(function tidy() {
	if (localGet("tidy") === "board") return;
	try {
		for (const [from, to] of [["today.since", "inbox.since"], ["today.last", "inbox.last"]]) {
			const v = localGet(from);
			if (v != null && localGet(to) == null) localSet(to, v);
		}
		for (const k of ["who", "rail", "open", "today.since", "today.last", "pref.look.start", "pref.look.sections", "pref.look.density"]) localStorage.removeItem(`wb.${k}`);
		const gone = (k) => /^(sec-|later-|repo-|rail-)/.test(k) || k === "done-more";
		for (const k of Object.keys(folds)) if (gone(k)) delete folds[k];
		localSet("folds", JSON.stringify(folds));
		localSet("tidy", "board");
	} catch {}
})();
document.addEventListener("toggle", (e) => {
	const key = e.target.dataset?.key;
	if (!key) return;
	folds[key] = e.target.open;
	localSet("folds", JSON.stringify(folds));
}, true);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
/** A progress ring, p 0–100 filled clockwise from the top, `size` px across with a `width` px band. Drawn as SVG strokes,
 *  which are anti-aliased: a CSS conic gradient cut out by a mask has jagged edges (worst in the app's WebKitGTK).
 *  Colours come from CSS: `.ring-track` and `.ring-fill` take `stroke`. */
function ringSvg(p, size, width) {
	const c = size / 2, r = c - width / 2, fill = Math.max(0, Math.min(100, Number(p) || 0));
	const circle = (cls, more = "") => `<circle class="${cls}" cx="${c}" cy="${c}" r="${r}" pathLength="100" fill="none" stroke-width="${width}"${more}/>`;
	return `<svg class="ring" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" aria-hidden="true">${circle("ring-track")}${fill ? circle("ring-fill", ` stroke-dasharray="${fill} 100" transform="rotate(-90 ${c} ${c})"`) : ""}</svg>`;
}
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

// Times (ago, when, day, inDays, took, parseTime) are in time.js.
const sessionHref = (s) => /^local_[0-9a-f-]+$/.test(s) ? `claude://claude.ai/epitaxy/${s}` : null;
const projectName = (slug) => state.allProjects.find((p) => p.slug === slug)?.name ?? slug;
// Archived projects stay out of the nav and "All", but their names still resolve (search, old items).
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

// The last answer to each plain GET, by its ETag (src/fresh.ts). Asked again, the board answers 304 with no body when
// nothing changed, and api() gives back the very same object: a loader that gets what it already has can skip its
// render (`data === before`). Most of the 10 s poll is this. Don't change what api() gives you; copy it first.
const kept = new Map();
async function api(path, opts = {}) {
	const plain = !opts.method && !opts.body && !opts.headers;
	const last = plain ? kept.get(path) : null;
	const res = await fetch(path, {
		...opts,
		...(plain ? { cache: "no-store" } : {}),
		headers: { "content-type": "application/json", ...(last ? { "if-none-match": last.tag } : {}), ...opts.headers },
	});
	if (res.status === 304 && last) {
		kept.delete(path);
		kept.set(path, last);
		return last.data;
	}
	// A phone that was removed in Settings (devices.ts): back to the pairing page, keeping where it was.
	if (res.status === 401 && res.headers.get("x-wb-pair")) location.replace(`/pair${location.hash}`);
	const data = await res.json();
	if (!res.ok) throw new Error(data.error || res.statusText);
	const tag = plain && res.headers.get("etag");
	if (tag) {
		kept.delete(path);
		kept.set(path, { tag, data });
		// Searches and items opened one by one add up: the oldest go.
		if (kept.size > 100) kept.delete(kept.keys().next().value);
	}
	return data;
}
