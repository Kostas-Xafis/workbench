/**
 * Stale work: what has sat too long. One rule, used by everything that returns items (db.ts adds `stale` to them), so
 * the board's badge, `wb ls`, the MCP tools and the Today brief agree. Change the thresholds here.
 */
export const STALLED_DAYS = 2; // doing, with no note or update for this long
export const WAITING_DAYS = 7; // waiting for this long
export const SITTING_DAYS = 14; // open on Kostas for this long

export type Stale = {
	/** "stalled" (doing, no news), "waiting" (waiting a week or more), "sitting" (open on Kostas for two weeks). */
	why: "stalled" | "waiting" | "sitting";
	/** When it went quiet (UTC, "YYYY-MM-DD HH:MM:SS" like the item's own times). */
	since: string;
};

type Fields = { status: string; owner: string; created_at: string; updated_at: string };

const ms = (t: string) => Date.parse(t.replace(" ", "T") + "Z");

/** `lastNote` is the time of the item's newest note (a note also bumps updated_at, so it is only a safeguard). */
export function staleOf(i: Fields, lastNote?: string | null, now = Date.now()): Stale | null {
	if (i.status !== "doing" && i.status !== "waiting" && i.status !== "todo") return null;
	const quiet = lastNote && lastNote > i.updated_at ? lastNote : i.updated_at;
	const days = (t: string) => (now - ms(t)) / 86400e3;
	if (i.status === "doing" && days(quiet) >= STALLED_DAYS) return { why: "stalled", since: quiet };
	if (i.status === "waiting" && days(quiet) >= WAITING_DAYS) return { why: "waiting", since: quiet };
	if (i.owner === "kostas" && days(i.created_at) >= SITTING_DAYS) return { why: "sitting", since: i.created_at };
	return null;
}

/** The short label for a line: "stalled 3 d". */
export function staleLabel(s: Stale, now = Date.now()) {
	return `${s.why} ${Math.floor((now - ms(s.since)) / 86400e3)} d`;
}
