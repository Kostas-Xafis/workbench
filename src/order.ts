/**
 * The order of a project's agent work. Kostas drags to-dos into the order he wants on the Projects page and agents
 * pick work in that order: `items.rank` (1 first; NULL = not ordered). listItems (db.ts) sorts by it, within a
 * status and ahead of priority, for agent items only, so every list that picks "next" (MCP list_items, the `next`
 * prompt, project_overview, `wb ls`, /api/items) follows it. Ordered items come before unordered ones; those keep
 * their usual order (priority, then oldest first).
 */
import { getItem, listItems, resolveItem, type Db, type Item } from "./db";

const OPEN = ["todo", "doing", "waiting"] as const;
const OPEN_SQL = "status IN ('todo','doing','waiting')";

/** The project's open agent items as they are listed: the order agents pick in. */
export function agentOrder(db: Db, project: string): Item[] {
	return listItems(db, { project, owner: "agent", status: [...OPEN] });
}

/**
 * Puts these items first, in this order (ranks 1..n); the project's other ordered items follow in the order they had,
 * and unordered ones stay unordered. Each must be an open agent item of the project. Returns the order that results.
 */
export function setOrder(db: Db, project: string, refs: unknown): string[] {
	if (!Array.isArray(refs)) throw new Error('refs is a list of items, e.g. ["wb-k3f9", "wb-m2x7"]');
	const ids: number[] = [];
	for (const r of refs) {
		const id = resolveItem(db, String(r ?? ""));
		const item = id === undefined ? undefined : getItem(db, id);
		if (!item) throw new Error(`no item "${r}"`);
		if (item.project !== project) throw new Error(`wb-${item.ref} is in ${item.project}, not ${project}`);
		if (item.owner !== "agent" || !(OPEN as readonly string[]).includes(item.status))
			throw new Error(`wb-${item.ref} is not open agent work, so it has no place in the order`);
		if (!ids.includes(item.id)) ids.push(item.id);
	}
	const rest = (
		db.query(`SELECT id FROM items WHERE project = ? AND owner = 'agent' AND ${OPEN_SQL} AND rank IS NOT NULL ORDER BY rank, id`).all(project) as { id: number }[]
	)
		.map((r) => r.id)
		.filter((id) => !ids.includes(id));
	const set = db.query("UPDATE items SET rank = ? WHERE id = ?");
	db.transaction(() => [...ids, ...rest].forEach((id, n) => set.run(n + 1, id)))();
	return agentOrder(db, project).map((i) => `wb-${i.ref}`);
}

/** A newly filed agent item goes to the end. Only matters once the project has an order; until then it takes its usual place. */
export function appendToOrder(db: Db, id: number) {
	const item = getItem(db, id);
	if (!item || item.owner !== "agent" || !(OPEN as readonly string[]).includes(item.status)) return;
	const ordered = db
		.query(`SELECT 1 FROM items WHERE project = ? AND id <> ? AND owner = 'agent' AND ${OPEN_SQL} AND rank IS NOT NULL LIMIT 1`)
		.get(item.project, id);
	if (!ordered) return;
	// The unordered ones are ranked in their usual order first, or the new item would land ahead of them.
	const ids = agentOrder(db, item.project)
		.map((i) => i.id)
		.filter((x) => x !== id);
	const set = db.query("UPDATE items SET rank = ? WHERE id = ?");
	db.transaction(() => [...ids, id].forEach((x, n) => set.run(n + 1, x)))();
}

/** Moves one item: to the top or bottom, or before or after another, in the order agents pick in. Returns the new order. */
export function moveInOrder(db: Db, id: number, to: { top: true } | { bottom: true } | { before: number } | { after: number }): string[] {
	const item = getItem(db, id);
	if (!item) throw new Error("no such item");
	const ids = agentOrder(db, item.project).map((i) => i.id);
	if (!ids.includes(id)) throw new Error(`wb-${item.ref} is not open agent work, so it has no place in the order`);
	const rest = ids.filter((x) => x !== id);
	let at: number;
	if ("top" in to) at = 0;
	else if ("bottom" in to) at = rest.length;
	else {
		const other = "before" in to ? to.before : to.after;
		if (other === id) throw new Error("an item can't go before or after itself");
		at = rest.indexOf(other);
		if (at < 0) throw new Error("the other item is not open agent work in the same project");
		if ("after" in to) at++;
	}
	rest.splice(at, 0, id);
	return setOrder(db, item.project, rest.map((x) => getItem(db, x)!.ref));
}
