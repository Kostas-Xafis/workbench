/* ---------- Times: the one set of formatters every screen uses ---------- */

// Each takes a time as the database writes it ("2026-11-24 17:16:10", UTC), an ISO string, milliseconds or a Date.
//   ago(t)                 "just now", "5 min ago", "3 h ago", "9 d ago", then the day ("3 Nov")
//   ago(t, { short: true }) the same without "ago", for tight places: "just now", "5 min", "3 h", "9 d", "3 mo"
//   when(t)                a moment: "today 14:05", "tomorrow 09:00", "Tue 14:05" (within 6 days), "3 Nov 14:05"
//   day(t, { weekday, relative })  a day: "3 Nov", "Tue 3 Nov"; relative says "today", "tomorrow", "yesterday"
//   inDays(t)              a day ahead, counted: "today", "tomorrow", "in 3 days" (past: "today")
//   took(from, to = now)   how long: "under a minute", "12 min", "1.5 h"
// The year shows only when it isn't this one.
const parseTime = (s) => new Date(s.replace(" ", "T") + "Z");
function toDate(t) {
	if (t instanceof Date) return t;
	if (typeof t === "number") return new Date(t);
	const s = String(t ?? "");
	return /^\d{4}-\d{2}-\d{2} \d/.test(s) ? parseTime(s) : new Date(s);
}
const clockText = (d) => d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const dayDiff = (d) => {
	const a = new Date(d), b = new Date();
	a.setHours(0, 0, 0, 0);
	b.setHours(0, 0, 0, 0);
	return Math.round((a - b) / 86400e3);
};
function day(t, { weekday = false, relative = false } = {}) {
	const d = toDate(t), n = dayDiff(d);
	if (relative && n >= -1 && n <= 1) return ["yesterday", "today", "tomorrow"][n + 1];
	const year = d.getFullYear() !== new Date().getFullYear() ? { year: "numeric" } : {};
	return d.toLocaleDateString([], { ...(weekday ? { weekday: "short" } : {}), day: "numeric", month: "short", ...year });
}
function ago(t, { short = false } = {}) {
	const d = toDate(t), s = (Date.now() - d) / 1000;
	const out = s < 60 ? "" : s < 3600 ? `${Math.floor(s / 60)} min` : s < 86400 ? `${Math.floor(s / 3600)} h`
		: s < 86400 * 30 ? `${Math.floor(s / 86400)} d` : short ? `${Math.floor(s / (86400 * 30))} mo` : null;
	if (out === "") return "just now";
	if (out === null) return day(d);
	return short ? out : `${out} ago`;
}
function when(t) {
	const d = toDate(t), n = dayDiff(d), c = clockText(d);
	if (n >= -1 && n <= 1) return `${["yesterday", "today", "tomorrow"][n + 1]} ${c}`;
	if (Math.abs(n) < 7) return `${d.toLocaleDateString([], { weekday: "short" })} ${c}`;
	return d.getFullYear() !== new Date().getFullYear() ? day(d) : `${day(d)} ${c}`;
}
function inDays(t) {
	const n = dayDiff(toDate(t));
	return n <= 0 ? "today" : n === 1 ? "tomorrow" : `in ${n} days`;
}
function took(from, to) {
	const m = Math.round(((to ? toDate(to) : new Date()) - toDate(from)) / 60e3);
	return m < 1 ? "under a minute" : m < 90 ? `${m} min` : `${(m / 60).toFixed(1)} h`;
}

/** The clock time of a moment in milliseconds: "14:05". */
const clockOf = (ms) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
