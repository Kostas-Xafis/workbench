/**
 * Whether an agent is alive on an item (docs/agents.md, "Is it running?"). Two signs:
 *
 * - **A live run** the board started on it (dispatch.ts: a `runs` row with no `ended_at`).
 * - **A call about it** in the last few minutes: an MCP tool call naming its ref (get_item, start_item, add_note,
 *   update_item, finish_item, wait_item, attach_image, …), any MCP call from the session the item records
 *   (start_item records `session`), or a `wb` command an agent ran on it. Both transports and `wb` land here, on a
 *   computer and on the cloud board alike: there `wb mcp` relays each call to the cloud board's /mcp with the
 *   session it runs in (relay.ts), and `wb` runs its commands there (cli.ts), so the same code sees them.
 *
 * A call is kept as the item's `alive_at`, at most once a minute per item: a busy agent costs one write a minute.
 * Items carry `alive` (a live run, or `alive_at` under ALIVE_MS old) and `alive_at` (db.ts).
 */
import type { Db } from "./db";

/** How long a call counts as a sign of life. */
export const ALIVE_MS = 5 * 60_000;
/** The least time between two writes of one item's alive_at. */
export const TOUCH_EVERY = 60_000;

/** Last write per item in this process (per database), so most calls don't even ask SQLite. */
const touched = new WeakMap<Db, { ids: Map<number, number>; sessions: Map<string, number> }>();

const SESSION = /^[\w.:-]{1,120}$/;

/**
 * An agent called the board about these items, or from this session. Writes alive_at on each (and on the open items
 * that record the session), unless it was written in the last minute. Never throws: the call goes on either way.
 */
export function noteAlive(db: Db, { ids = [], session }: { ids?: (number | undefined)[]; session?: string }, now = Date.now()) {
	try {
		let seen = touched.get(db);
		if (!seen) touched.set(db, (seen = { ids: new Map(), sessions: new Map() }));
		const { ids: byId, sessions } = seen;
		const due = [...new Set(ids.filter((id): id is number => typeof id === "number"))].filter((id) => now - (byId.get(id) ?? 0) >= TOUCH_EVERY);
		const fresh = "(alive_at IS NULL OR alive_at <= datetime('now', '-60 seconds'))";
		for (const id of due) {
			db.query(`UPDATE items SET alive_at = datetime('now') WHERE id = ? AND ${fresh}`).run(id);
			byId.set(id, now);
		}
		if (session && SESSION.test(session)) {
			if (now - (sessions.get(session) ?? 0) >= TOUCH_EVERY) {
				db.query(`UPDATE items SET alive_at = datetime('now') WHERE session = ? AND status IN ('doing', 'waiting') AND ${fresh}`).run(session);
				sessions.set(session, now);
			}
		}
	} catch {}
}

/** Forgets what this process wrote (tests). */
export const forgetAlive = (db: Db) => touched.delete(db);

/** Whether alive_at (UTC 'YYYY-MM-DD HH:MM:SS') is recent enough to count. */
export const recent = (aliveAt: string | null | undefined, now = Date.now()) =>
	!!aliveAt && now - Date.parse(aliveAt.replace(" ", "T") + "Z") < ALIVE_MS;

/** The items that have a live run the board started on them. */
export const liveRunItems = (db: Db): Set<number> => {
	try {
		return new Set((db.query("SELECT DISTINCT item_id FROM runs WHERE ended_at IS NULL").all() as { item_id: number }[]).map((r) => r.item_id));
	} catch {
		return new Set();
	}
};

