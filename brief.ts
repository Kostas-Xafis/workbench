/**
 * What makes an item readable on the board, in one place: the rules agents read (MCP instructions and add_item,
 * `wb guide`) and the check that answers them when they file something that doesn't follow them.
 */
import type { Item } from "./db";

/** Fits a tool description (Claude Code cuts those at 2048 characters). {{name}} is filled in by whoever shows it. */
export const BRIEF_RULES = `{{name}} reads items on the board, often on a phone, with no repo open, no memory of the work and no time to open files. An item has to make sense by itself:
- Title: what to do or decide, in plain words. No internal codes (M7, R50, DBS-3).
- First lines: what this is, why it's here, what you need from {{name}}.
- Put the content in the item. Never point at a file or section to explain it (docs/x.md, PLAN §3): copy in the wording, the choices, the numbers that matter. A path may follow at the end, for the next agent.
- Break it up: numbered lists for steps or anything in order, bullets for the rest (indent to nest). No walls of text.
- Say where things are as a user finds them (Settings → Reader → Toolbar), not by source file.
- Anything visible on screen gets a screenshot, with a caption saying what to look at; two for before and after.
- check: where to go, numbered steps, what right looks like, what wrong looks like.
- review: quote the exact words (lines starting with >) or show a picture; what to judge; what happens if {{name}} says nothing.
- decision: what's being decided and why now; for each option, what changes for the user; your recommendation and why.
- setup: the exact address, each click, what to copy back and where it goes, why it's needed.
- bug: what happens, what should happen, how to make it happen.
Test: could {{name}} act on this from their phone without opening anything else?`;

/** The longer form, for `wb guide`: how to get a picture, and how the rules look in practice. */
export const WRITING_GUIDE = `Writing items for {{name}}

${BRIEF_RULES}

Screenshots
  wb image add <ref> shot.png "What to look at"    or --image shot.png --caption "…" on wb add
  (MCP: attach_image, or images on add_item.) It takes a file: PNG, JPEG, WebP or GIF. Keep it in your scratchpad or
  /tmp, not the repo: the board keeps its own copy, and shrinks large ones.
  - Android phone or emulator: adb exec-out screencap -p > shot.png
  - Web page or Electron: Playwright's page.screenshot({ path }), or chromium --headless --screenshot=shot.png <url>
  - A browser tool's screenshot: attach the file its result names. If it names none, use one of the above.
  Show the state you describe, cropped or zoomed so the thing in question is easy to find.
  Reading one someone attached: wb image save <id> shot.png, then open the file (MCP: get_image).

Instead of
  "Review the version history spec (M6). See docs/specs/version-history.md, 41 acceptance items, DVH-1…DVH-20."
Write
  Title: Choose how long old versions of a document are kept
  Version history is built and these are the defaults; each stays unless you say otherwise.
  1. How long: every version from the last day, one an hour for a week, one a day for a month.
     A heavy user ends up with about 550 versions, roughly 32 MB, a fraction of a cent a month.
  2. Where you find it: File → Version history…, no shortcut. (picture: the menu, with the new entry)
  Details for the next agent: docs/specs/version-history.md`;

export type Draft = Pick<Item, "title" | "body" | "kind" | "owner"> & { options?: string | string[] };

/** A body shorter than this can't have said what it is, why it's here and what's needed. */
const TOO_SHORT = 60;
/** A paragraph longer than this is hard going on a phone. */
const WALL = 500;
const DOC = /[\w./*-]+\.md\b|\bPLAN\s*§|§\s*\d/g;
const CODE = /\b[A-Z]{2,5}-\d+\b/g;
const SOURCE = /[\w.-]+\/[\w./*-]+\.(?:tsx?|jsx?|mjs|py|go|rs|kt|java|swift|css|scss|html|vue|svelte)\b/g;
const TITLE_CODE = /\b[MR]\d{1,3}\b|\b[A-Z]{2,5}-\d+\b/;
const ON_SCREEN = /\b(?:screens?|buttons?|menus?|toolbar|dialogs?|layout|icons?|sidebar|toasts?|popups?|modal|onboarding|UI)\b/i;

const unique = (matches: Iterable<RegExpMatchArray>) => [...new Set([...matches].map((m) => m[0]))];

/**
 * What in a draft {{name}} won't be able to follow. `refuse` means it shouldn't be filed at all (an item for them with
 * nothing in it); `warnings` go back to the agent to fix. Guesses, so only an empty brief is ever refused: a wording
 * review may have good reason to name a legal page's .md file.
 */
export function checkBrief(d: Draft, { name, images, attach }: { name: string; images: number; attach: string }): { refuse?: string; warnings: string[] } {
	const body = (d.body ?? "").trim();
	const forThem = d.owner === "kostas" && d.kind !== "idea";
	const warnings: string[] = [];
	if (forThem && body.length < TOO_SHORT)
		return { refuse: `This is for ${name}, who needs it to make sense without opening anything else. Write the body: what this is, why it's here, and what you need from ${name} (\`wb guide\` has more). Nothing was filed.`, warnings };
	if (!body && d.kind !== "idea") warnings.push(`It has no body. ${name} reads these too: say in a line or two what this is and why.`);
	if (TITLE_CODE.test(d.title)) warnings.push(`The title has an internal code (${d.title.match(TITLE_CODE)![0]}). Say what it's about in plain words.`);
	const docs = unique(body.matchAll(DOC));
	if (docs.length) warnings.push(`It points at ${docs.slice(0, 3).join(", ")}. ${name} won't open that: copy what they need into the body. A path is fine at the end, for the next agent, as long as the item makes sense without it.`);
	const codes = unique(body.matchAll(CODE));
	const repeated = codes.filter((c, _, all) => all.some((x) => x !== c && x.split("-")[0] === c.split("-")[0]));
	if (repeated.length) warnings.push(`It uses internal codes (${repeated.slice(0, 3).join(", ")}…). Say what each one means, or leave it out.`);
	const sources = unique(body.matchAll(SOURCE));
	if (forThem && sources.length >= 3) warnings.push(`It names source files (${sources.slice(0, 2).join(", ")}…). Say where each thing is in the app, and quote the wording, instead.`);
	if (forThem && body.split("\n").some((line) => line.length > WALL)) warnings.push("It has a long paragraph. Break it into a list: numbered for steps or anything in order, bullets for the rest.");
	if (d.kind === "check" && !/^\s*1[.)]\s/m.test(body)) warnings.push("A check needs numbered steps: where to go, what to do, what right and wrong look like.");
	if (d.kind === "decision" && !/recommend/i.test(body)) warnings.push("A decision needs your recommendation and why.");
	if (!images && (forThem || d.kind === "bug") && ["check", "review", "bug"].includes(d.kind)) {
		const hint = `${d.title}\n${body}`.match(ON_SCREEN);
		if (hint) warnings.push(`This seems to be about something on screen ("${hint[0]}"). Show it: ${attach}.`);
	}
	return { warnings };
}
