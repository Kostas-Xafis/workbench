/**
 * Filing an item, the one way the MCP server (add_item), `wb add` and the board's page (POST /api/items) all do it,
 * and the same rules when a change makes an item an ask (update_item, `wb edit`). Each surface shows the result in
 * its own words; what's checked is the same.
 *
 * Only agents are checked: their brief (brief.ts), the cap on open asks, a way out for every ask (wayOut, asks.ts),
 * and rulings their ask may repeat. What Kostas files for himself always goes on as he wrote it.
 */
import { addItem, getItem, type Db, type Item, type ItemPatch } from "./db";
import { capRefusal, DEFAULT_KINDS, deadlineText, wayOut } from "./asks";
import { checkBrief } from "./brief";
import { addImage, type Prepared } from "./images";
import { waitOn } from "./links";
import { ASKING_KINDS, similarRulings } from "./rulings";
import { ownerFor, yourName } from "./settings";

/** Why something wasn't filed or changed, in words for whoever filed it. Nothing was saved. */
export class Refusal extends Error {}

export type Filing = {
	item: ItemPatch & { title: string; project: string };
	author: string;
	/** An agent files it: checked. Kostas's own (the page, `wb` in his terminal) never are. */
	byAgent: boolean;
	/** How to attach a picture on this surface, for the brief check's hint. */
	attach?: string;
	/** Pictures to put on it: how many, and a reader run only once the checks pass (a wrong path files nothing). */
	images?: { count: number; read: () => Promise<{ image: Prepared; caption: string }[]> };
	/** Items it waits on. */
	waitsOn?: number[];
	/** An item that waits on this new one. */
	blocks?: number;
};

export type Filed = {
	id: number;
	/** What the agent should fix in the brief (saved all the same). */
	warnings: string[];
	/** What happens if Kostas says nothing, when it goes ahead by itself ('' otherwise). */
	goesAhead: string;
	/** Rulings this ask may repeat. */
	repeats: ReturnType<typeof similarRulings>;
};

export async function fileItem(db: Db, f: Filing): Promise<Filed> {
	let item: ItemPatch & { title: string; project: string } = { ...f.item, title: String(f.item.title ?? "").trim() };
	const kind = item.kind || (item.options?.length ? "decision" : "task");
	const owner = item.owner || ownerFor(db, kind);
	let warnings: string[] = [];
	let gave = false;
	if (f.byAgent) {
		const brief = checkBrief(
			{ title: item.title, body: item.body ?? "", kind, owner },
			{ name: yourName(db), images: f.images?.count ?? 0, attach: f.attach ?? "attach a screenshot" },
		);
		if (brief.refuse) throw new Refusal(brief.refuse);
		warnings = brief.warnings;
		const capped = capRefusal(db, { project: item.project, kind, owner, priority: item.priority });
		if (capped) throw new Refusal(capped);
		try {
			({ patch: item, gave } = wayOut(db, { ...item, kind }) as { patch: typeof item; gave: boolean });
		} catch (e) {
			throw new Refusal((e as Error).message);
		}
	}
	const waitsOn = f.waitsOn ?? [];
	if (f.blocks !== undefined) {
		const b = getItem(db, f.blocks);
		if (!b) throw new Refusal(`no item #${f.blocks}`);
		if (b.status === "done" || b.status === "dropped") throw new Refusal(`wb-${b.ref} is ${b.status}: it can't wait on anything`);
		if (waitsOn.includes(f.blocks)) throw new Refusal(`the new item can't both wait on wb-${b.ref} and block it`);
	}
	const images = f.images ? await f.images.read() : [];
	const id = addItem(db, { ...item, kind }, f.author);
	for (const m of images) addImage(db, id, m.image, m.caption, f.author);
	try {
		if (waitsOn.length) waitOn(db, id, waitsOn, f.author);
		if (f.blocks !== undefined) waitOn(db, f.blocks, [id], f.author);
	} catch (e) {
		throw new Error(`${(e as Error).message}. The item is filed as wb-${getItem(db, id)!.ref}; link it again to wait.`);
	}
	const i = getItem(db, id)!;
	return {
		id,
		warnings,
		goesAhead: f.byAgent ? goesAheadText(db, i, gave) : "",
		repeats: f.byAgent && ASKING_KINDS.includes(kind) ? similarRulings(db, i.project, i.title, i.body, { except: id }) : [],
	};
}

/** "It had no default, so it got one: it closes with no objections on Fri 27 Nov unless Kostas says otherwise." */
function goesAheadText(db: Db, i: Item, gave: boolean): string {
	if (i.owner !== "kostas" || !DEFAULT_KINDS.includes(i.kind)) return "";
	const when = deadlineText(i);
	if (!when) return "";
	return `${gave ? "It had no default, so the board gave it one: it" : "It"} ${when} unless ${yourName(db)} says otherwise.`;
}

/**
 * The same rules for a change an agent makes to an item (update_item, `wb edit`): handing it to Kostas is filing an
 * ask (the cap), and an item that becomes an ask gets its way out. Returns the patch to apply.
 */
export function checkChange(db: Db, before: Item, patch: ItemPatch, byAgent: boolean): { patch: ItemPatch; gave: boolean } {
	if (!byAgent) return { patch, gave: false };
	const unchanged = (m: string) => m.replace("Nothing was filed.", "Nothing was changed.");
	const owner = patch.owner ?? before.owner;
	if (owner === "kostas" && before.owner !== "kostas") {
		const capped = capRefusal(db, { project: patch.project ?? before.project, kind: patch.kind ?? before.kind, owner, priority: patch.priority ?? before.priority });
		if (capped) throw new Refusal(unchanged(capped));
	}
	try {
		return wayOut(db, patch, before);
	} catch (e) {
		throw new Refusal(unchanged((e as Error).message));
	}
}

/** After a change: what happens if Kostas says nothing, when the board just gave it a default. */
export function changeText(db: Db, id: number, gave: boolean): string {
	return gave ? goesAheadText(db, getItem(db, id)!, true) : "";
}
