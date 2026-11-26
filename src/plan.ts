/**
 * The morning plan's "Start next" (the Inbox's top, ui/plan.js): the first item of each project's Next up that an
 * agent could start, in the board's project order. GET /api/queue carries it as `next`.
 *
 * Next up is a project's open agent to-dos that aren't ideas, in the order Kostas sets (order.ts; listItems sorts by
 * it). An item that waits on an open item, or that a run is on already, is passed over for the one after it. A
 * project whose autopilot is on (a flag another part of the board may add) starts its own work, so it's left out.
 * Whether this client may start agents at all, the folders and the limits are the page's to check (the Run button's
 * checks, ui/dispatch.js sendWhy), so the cloud board and a phone say the same as everywhere else.
 */
import { listItems, projects, type Db, type Item } from "./db";
import { blockersOf } from "./links";

export type NextUp = { id: number; ref: string; project: string; title: string; kind: Item["kind"]; owner: Item["owner"]; status: Item["status"]; priority: number };

const OPEN = ["todo", "doing", "waiting"];

/** A project's autopilot, if the board has one: any truthy `autopilot` field (a column, or a setting carried on it). */
const autopilot = (p: unknown) => !!(p as Record<string, unknown>).autopilot;

/** The first startable item of each active project's Next up (`project`: that one only), at most one per project. */
export function nextUp(db: Db, { project = "" }: { project?: string } = {}): NextUp[] {
	const list = projects(db).filter((p) => !p.archived_at && !autopilot(p) && (!project || p.slug === project));
	if (!list.length) return [];
	const order = new Map(list.map((p, n) => [p.slug, n]));
	const busy = new Set((db.query("SELECT item_id FROM runs WHERE ended_at IS NULL").all() as { item_id: number }[]).map((r) => r.item_id));
	const first = new Map<string, Item>();
	for (const i of listItems(db, { ...(project ? { project } : {}), owner: "agent", status: ["todo"] })) {
		if (!order.has(i.project) || first.has(i.project) || i.kind === "idea" || busy.has(i.id)) continue;
		if (blockersOf(db, i.id).some((b) => OPEN.includes(b.status))) continue;
		first.set(i.project, i);
	}
	return [...first.values()]
		.sort((a, b) => order.get(a.project)! - order.get(b.project)!)
		.map((i) => ({ id: i.id, ref: i.ref, project: i.project, title: i.title, kind: i.kind, owner: i.owner, status: i.status, priority: i.priority }));
}
