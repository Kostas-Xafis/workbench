/**
 * Stale work: agent work that went quiet. One rule, used by everything that returns items (db.ts adds `stale` to
 * them), so the board's badge, `wb ls`, the MCP tools and the Today brief agree. Change the thresholds here.
 * Kostas's own items are never stale: how long an ask has waited on him shows as its age, not as a warning.
 *
 * "Stalled" goes by signs of life (alive.ts): a note, or an agent's MCP or `wb` call about the item (`alive_at`).
 * An item with a live run on it isn't stalled either (db.ts leaves that out).
 */
export const STALLED_DAYS = 1; // doing, with no sign of life (a note, or alive_at) for this long
export const WAITING_DAYS = 7; // waiting for this long

export type Stale = {
	/** "stalled" (doing, no sign of life) or "waiting" (waiting a week or more). */
	why: "stalled" | "waiting";
	/** When it went quiet (UTC, "YYYY-MM-DD HH:MM:SS" like the item's own times). */
	since: string;
};

type Fields = { status: string; owner: string; updated_at: string; kind?: string; created_at?: string; alive_at?: string | null };

const ms = (t: string) => Date.parse(t.replace(" ", "T") + "Z");

/** `lastNote` is the time of the item's newest note (a note also bumps updated_at, so it is only a safeguard). */
export function staleOf(i: Fields, lastNote?: string | null, now = Date.now()): Stale | null {
	if (i.owner === "kostas") return null;
	if (i.status === "doing") {
		// Its newest note (the item's own time when there's none to go by), or an agent's call about it, whichever is later.
		const quiet = [lastNote || i.updated_at, i.alive_at ?? ""].sort().at(-1)!;
		return (now - ms(quiet)) / 86400e3 >= STALLED_DAYS ? { why: "stalled", since: quiet } : null;
	}
	const quiet = lastNote && lastNote > i.updated_at ? lastNote : i.updated_at;
	if (i.status === "waiting" && (now - ms(quiet)) / 86400e3 >= WAITING_DAYS) return { why: "waiting", since: quiet };
	return null;
}

/** The short label for a line: "stalled 3 d". */
export function staleLabel(s: Stale, now = Date.now()) {
	return `${s.why} ${Math.floor((now - ms(s.since)) / 86400e3)} d`;
}
