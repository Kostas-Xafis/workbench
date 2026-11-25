# Using the board

What's on the board and how to work it. Settings are in [settings.md](settings.md), agents in [agents.md](agents.md).

## Getting started

- **Setup guide:** a new board opens it by itself (`#welcome`): your name, your first projects, Claude Code's MCP server (with a check that an agent reached the board), the prompt that sets each project up for agents, notifications and start on login. Every step can be skipped. Until each is done or skipped, "Finish setting up" sits at the top of the Inbox. Settings → About brings the guide back.
- **Projects:** add one in Settings → Projects, or `wb project <slug> <path> "Name"`. Items added from inside that path belong to it. The board shows each project's git state: uncommitted files, unpushed commits, unmerged branches, worktrees.
- **Logos** are found in the repo (`icon`, `logo`, `app-icon` or `favicon` files), else the initials. If the one found is wrong: `wb project <slug> --icon path/in/repo.svg` (`--icon ""` looks again).

## The frame

- **The nav**, down the left: **Inbox** (where the board opens; its count is the asks that need you to do something), **Agents** (how many run now), then **Projects**, one row each with its logo and how many asks wait on you there. A tracker that runs low shows as a chip under the projects. At the foot: **Settings**, **Usage**, **Vault** and **Notifications**. Under 1100 px wide the nav keeps only its icons.
- **The top bar:** the place you're in, search and **New**. Search (Ctrl K or `/`) finds items with their notes, goals, reports and links: on a project's page in that project, elsewhere in every project.
- **On a phone:** a bar at the bottom in place of the nav: Inbox, Agents, **Projects** (a sheet of them) and **More** (Settings, Usage, Vault, notifications). Controls are at least 40 px, and nothing hides under the status bar or the home indicator.
- **Notifications:** the bell at the foot of the nav turns on desktop notifications for this browser; Settings → Notifications picks which. Before anything that can't be undone, the board asks in a small box beside the button.

## Inbox

`#inbox`, where the board opens (the T key from anywhere): what waits on you across every project, as a list beside the item you're reading. The old addresses `#board` and `#today` open it too.

- **Since you were away:** how many asks are new, and how many agent items finished and are stuck (an hour away starts a new visit).
- **Projects:** **All**, then a chip for each project with asks for you (`#inbox/<slug>`).
- **Three tabs**, each with its count:
  - **Answer:** decisions.
  - **Errands:** checks, setup, and anything else of yours done at a device or away from the desk.
  - **Look:** reviews and notices, which go ahead by themselves. Each row says when ("goes ahead on Thu", "closes tomorrow"), or "waits for you" with no default and no date.
- **The order:** first **Holds up agents** (what an agent's waiting item waits on: "unblocks N"). Then priority 1, what unblocks the most, the active goal's items, deadlines in the next three days, P2 before P3, the oldest, with similar asks together. Notices come last. Deferred items aren't listed; a quiet line says how many and until when.
- **A row:** the kind's glyph, the title, and one line: project · what the agent recommends · when it goes ahead · unblocks N. Its age is on the right. Rows have no buttons: you answer in the item.
- **The reader beside it:** wider than 1100 px the selected item shows beside the list; narrower, a row opens it as a sheet. Whatever you do there, the selection moves on to the next item.
- **Keys:** J/K or ↓/↑ move; 1–9 pick a choice; Enter takes the recommended answer (or No objections, Got it) when you're not typing; D later, G give back, X drop, E edit the brief, R read, O your own words, M done; `/` searches. Settings → About lists them all.
- **Focus mode** (F or Q; `#queue`): the list goes and one item fills the width, with "12 cleared · 30 to go" and a thin bar. F again, or **Show the list**, brings the list back.
- **Accept N recommendations:** on Answer, when more than one decision in view has a recommended choice, one quiet button answers each with it, after listing them and asking once.
- **On a phone:** a row opens the item full screen. Swipe a row right to take the recommendation (or No objections, Got it), left for later (back tomorrow).

## Agents

`#agents` (`#agents/<project>`): what every project's agents are doing, in three lanes side by side (stacked on a phone) with a log under them. It looks again every 5 seconds and draws only what changed.

- **Running now:** every run the board started that's still going, and every agent that called the board about its item in the last few minutes ([Is it running?](agents.md#is-it-running)). A card has the title, project, ref, branch, how long it's been going, a live dot and the last thing it said or did. **Stop** asks first, then stops the agent and what it started. **Open in Claude Desktop** shows when the session can be opened there. **Open** shows the item with its agent session.
- **Ready to land:** agents' work finished in the last 14 days whose branch isn't merged into the project's main branch, nor into the branch the project's folder is on (an integration branch such as `overnight` counts as landed). A card has the branch, how many commits it's ahead, its pull request's state, and the first line of the finishing note. **Merge it** starts an agent that merges the branch the way the project's rules say ([Merge it](agents.md#merge-it)); the card then moves to Running now. **See the note** opens the item.
- **Stuck:** what broke first (a run that failed or was stopped), then what waits on you, then what went quiet (doing with no sign of life for a day, or waiting a week). Each says why, with **Run again** (or **Merge it again**) when the board would start one, or why not.
- **Finished**, under the lanes: what agents finished since your last visit, newest first: when, the project, the title, the first line of the finishing note, and whether its branch is merged.
- A lane shows its first six cards (three on a phone), with "Show N more". J/K go through the cards in the order shown. The chips at the top pick a project. When the board couldn't read something (on the cloud board, git as a computer last sent it), a quiet line says so.

## Projects

`#project/<slug>`: where you plan a project's work: write the next piece, put it in order, start agents on it.

- **The header:** the logo and name; a quiet line with the repository (branch, uncommitted files, unpushed commits, unmerged branches, worktrees; point at it for the list) and "N in your inbox"; the active goal with its progress and target date; and the project's trackers as small meters ([trackers.md](trackers.md)).
- **Tabs:** Work · Pages · Rulings · Done, with their counts. The page opens on the tab you used last.
- **Work:**
  - **The composer:** "Write what needs doing…". Enter files it as an agent's task in this project (the first line is the title, Shift+Enter starts the details). Ctrl+Enter files it and starts an agent on it, when the board starts agents (Settings → Agents); when it can't, it only files it and the line under the box says why. Task, Bug or Idea picks the kind; **More…** opens the full form (details, pictures, who acts, priority). On a phone, **File it**.
  - **In progress:** agents' items being worked on, with a pulsing dot while an agent is alive on one.
  - **Next up:** the open agent to-dos, in your order. Drag one by its handle, or Alt+↑/↓ on a row; it's saved at once. Agents pick work in that order. **Run** starts an agent on it, when the board can.
  - **Waiting:** agents' items that wait, with why (their newest note), what they wait on, and for how long.
  - **Ideas**, folded, each with **Make it a task**.
  - Your own asks aren't listed here: they're in the Inbox, and one line says how many.
- **Pages:** the project's reports in their groups, day pages under "Days" and older ones under "Archived days" ([reports.md](reports.md)), then its links and data sources.
- **Rulings:** this project's rulings ([Rulings](#rulings)).
- **Done:** what agents finished here, newest first, each with the first line of its finishing note; "Show more" goes further back.

**Order of agent work:** from a terminal, `wb order <ref> [--before R | --after R | --top | --bottom]`. A new agent item goes to the end; closing an item or giving it to Kostas takes it out. Unordered items follow the ordered ones, by priority and age. `list_items`, `project_overview`, `wb ls` and the `next` prompt all follow the order.

**Links** (Pages tab): "+" adds one (for one project or every project, optionally in a group), the pencil then a click edits or deletes. The server fetches each site's favicon once; paste an icon address in the dialog when the site's own is wrong. From a terminal: `wb links`, `wb link "Label" <url> [--project P | --all] [--group G] [--icon <url>]`, `wb relink <id> …`, `wb unlink <id>`.

## Items and the reader

An item is named `wb-xxxx` (e.g. `wb-k3f9`). Click the ref to copy it into a prompt ("Do wb-k3f9"). Commands also take the bare `k3f9`.

**The reader:** a click on a row, a search result or a ref opens the item as a document, in a sheet from the right with the board dimmed behind it (full screen on a phone; beside the list in the Inbox in a wide window). Its address is `#item/wb-k3f9`. Closing it (Esc, ×, a click on the board) goes back to where you were. J/K open the next and previous item in the list you came from. From the top:

- one line of context: the ref, the kind, the project, who filed it and when, its status when it isn't to do; then the title, which you click to change;
- for an ask with a default, a quiet line: "If you say nothing, it goes ahead with X on Thu 26 Nov", with **change date** and **remove**;
- the brief, with its pictures. **Edit** (or E) opens it as markdown; Ctrl+Enter or clicking away saves, Esc puts it back;
- what it asks of you:
  - a decision: its choices as big buttons numbered 1–9, the recommended one outlined; one click answers it. When several can be picked: ticks, then one **Answer**. **Or answer in your own words** goes to the reply box;
  - a review or notice: **No objections** / **Got it** (A) and **Object…** (O);
  - a check: its steps and **Run it** ([Checks on the phone](#checks-on-the-phone));
  - on a phone the choices stay docked at the bottom, under your thumb;
- **Done** (M), **Drop** (X), and for what's yours **Later** (D: tomorrow, in 3 days, next week or a day; out of the Inbox until then) and **Give back** (G: back to the agent with a line, or "You decide, with your recommendation" when empty);
- the agent session, when there is one ([agents.md](agents.md#agents-the-board-starts));
- the history as a thread, oldest first: agents' notes, and yours set apart. Field changes are small grey lines, folded together. Long threads show the last few, with "Show N earlier";
- one reply box: on an ask, Enter answers in your words (a decision) or objects (a review or notice); otherwise it adds a note. Shift+Enter is a new line. When the board starts agents and one can start now, **resume the agent** sends your answer and starts the agent in one go.

**Properties**, beside it (under it on a phone, folded), each changed in place and saved at once: status, who acts, kind, priority, project, area, goal, branch, session, a decision's choices, what happens if you say nothing and when, what it waits on and what waits on it, its code, and the ruling its answer made. While the reader is open the item updates as agents write, never in a box you're typing in.

**A new item** (New): the same page with the title and brief open, and kind, project, who acts (it follows the kind until you pick) and priority beside them. A decision also takes its choices. **Create** (or Ctrl+Enter) files it.

**Pictures:** agents attach screenshots (`attach_image`, `wb image add <ref> shot.png "What to look at"`). You add yours with **Add image** under the brief, by pasting one, or by dropping files on the item. Captions are edited in place; a click opens one full size. PNG, JPEG, WebP and GIF only, checked by their contents, at most 20 MB; over 500 KB is shrunk to 2000 px on the longer side. An agent reads one with the `image` tool or `wb image save <id> <file>`.

**Items you can follow:** every item for you has to make sense without opening anything else (the rules are in the MCP server's instructions and `wb guide`). An empty brief is refused. An item that points at a .md file or PLAN section, uses internal codes or source paths, or talks about something on screen with no picture is saved, and the agent is told what to fix. Items you file yourself are never checked.

**Decisions with choices:** `wb add "Sync strategy" --option "CRDT" --option "Last write wins"`. `wb answer <ref> "choice"` (or its number) answers from a terminal; `--pick many` allows several (`wb answer <ref> 1 3`, or `none`); `wb show` prints the answer.

**Code on items:** commits whose message mentions `wb-xxxx`, and pull requests whose title, body or branch name does, show among the properties, with review and checks (pull requests come from `gh`).

**Stale work:** an agent's item is flagged when it's doing with no sign of life for a day ("stalled": no note, and no MCP or `wb` call about it; never while a run the board started is on it), or waiting for 7 days. Your own items never are. A row says "stalled 3 d" in amber, Agents lists them under Stuck, and `wb ls` marks them ⚠.

### Waiting on another item

An item that's blocked says what it waits on, so answering that item lets the work carry on by itself.

- `wb wait <ref> "why" --on wb-xxxx` (repeat `--on` for more; `wait_item` takes `on`) marks it waiting and links it. When an agent needs something from you, `wb add "…" --kind decision --blocks <its item>` (or `add_item` with `blocks`) files your item and makes its own wait on it in one go.
- When the item waited on is answered, finished or dropped, whatever waited only on it goes back to **todo**, with a note in its history. One that waits on several carries on when all are dealt with. An item that leaves waiting any other way waits on nothing.
- The item lists "Waits on" and "Blocks" among its properties. A row for you says "unblocks N", and what unblocks the most comes first within a priority.
- `wb edit <ref> --on wb-xxxx` / `--not-on wb-xxxx` and `update_item`'s `waits_on` / `not_waiting_on` add and remove links. An item can't wait on itself, on something already dealt with, or round a circle.

## Asks that don't block

Agents ask faster than anyone answers, so most of what they leave for you doesn't stop their work.

- **Notices** (kind `notice`): "here's what changed, object if you want". They're yours by default but never count as waiting on you: not in the badges, the Inbox's count, the tray count, notifications or `wb ls --mine`. **Got it** closes one; **Object…** sends your line back to the agent as a to-do. `wb seen <ref>` and `wb object <ref> "why"` do the same from a terminal; a review has them too.
- **A default and a deadline** on decisions, reviews and notices: what happens if you say nothing (`--default`, MCP `default`; for a decision with options, one of them), and by when (`--decide-by 2026-11-14` or `"in 3 days"`). With a default and no date, Settings → Agents' wait applies (3 days). When the time passes, the default goes ahead as if you had clicked it: a decision is answered with it and handed back, a review closes with no objections, a notice closes as seen, and the history says so. The board checks every minute, and `wb` and the MCP server before they read anything, so it happens with the board off too. Without a default nothing goes ahead by itself.
- **Every ask from an agent has a way out.** A review filed without a default gets one (it closes with no objections at the usual wait), and so does a notice. A decision's recommendation becomes its default (pick many: the recommended list). A decision with neither is refused unless it's priority 1, and the agent is told to give a recommendation, or file it as priority 1 if it can't go ahead without you (money, accounts, something that can't be undone). The same holds when `update_item` or `wb edit` turns an item into one of these asks. Checks and setup don't change, nor do asks already on the board, nor anything you file yourself.
- **Pick several:** a decision with `--pick many` is answered with ticks and one Answer button; the agent's recommended options start ticked.
- **A cap:** a project takes at most 20 open asks (decisions, reviews, checks, setup) that agents filed for you. Past it, `add_item` and `wb add` are refused, with what to do instead: bundle into one pick-many decision, send a notice, decide with a default, or drop one. Notices, priority 1 and your own items always go on. Settings → Agents changes the number (0: no cap).

## Rulings

What you already decided, one line each ("Traditional is the default melisma style"), so agents read it instead of asking again. They sit in a project's Rulings tab: search, Edit, Retire (it no longer holds; Retired brings it back), Add a ruling. The item shows the ruling its answer made.

- **Drafts:** answering a decision drafts a ruling from its question and answer, marked "draft". The next agent that picks the item up rewrites it as one clear line.
- **Agents read them** in `project_overview`, the `work-on` prompt (the ones that bear on the item), `list_rulings` and `wb://rulings/{slug}`, and write them with `add_ruling` and `update_ruling` (which also retires).
- **Repeat questions:** when an agent files a decision or review that looks like one already ruled on, it's saved and the agent gets the ruling back: "Kostas already ruled: … If this is answered by that, drop the item." The match is by shared words (accents and case don't matter), tuned to fire rarely.
- **From a terminal:** `wb rulings`, `wb rule "text" [--item <ref>]`, `wb rule <id> "text"`, `wb unrule <id>`.

## Goals

A goal says what a project's work is for (a release, a launch): a title, a description, an optional target date, and the items that serve it. A project's header shows its active goal with progress (done of all) and the target date; a click shows only its work (`#project/<slug>/goal/<id>`), a click again everything. The pencil on a goal, or "+", opens a dialog: title, date, description, "The active goal" (agents pick its work first; with none marked, the first goal is), Earlier/Later to reorder, Mark done, Drop. An item has a Goal picker among its properties.

Agents have the `goal` tool (list, add, update) and a `goal` on `add_item`, `update_item` and `list_items` (its number or exact title). `project_overview` lists goals with progress and blockers, and the `next` prompt prefers work on the active goal. Agents don't create goals for you: they propose one as a decision. From a terminal: `wb goals`, `wb goal add "First release" --due 2026-12-01`, `wb goal 3 --done` (or `--drop`, `--active`, `--title`, `--due`), `wb add "…" --goal 3`, `wb edit <ref> --goal none`, `wb ls --goal 3`.

## Checks on the phone

A check is something you try on a device, so it runs one step at a time. **Run it** in the item opens `#check/<ref>`.

- **Steps:** the brief's numbered list (nested bullets stay with their step; several lists such as "Setup" and "What to check" are all of them, under their headings; no list is one step, the whole brief). "What right looks like" and "What wrong looks like" show above the steps.
- **Each step** has big **Pass** / **Fail** buttons, a few words (needed on Fail unless there's a photo), and **Add photo** (the phone's camera or gallery; shrunk, captioned with the step and your words, and kept on the item).
- Every answer is saved as you give it, so you can start on the phone and finish at the desk. **Start over** clears the run and its photos.
- **Finish** when every step has an answer. All passed: the check is done, with a note ("All 6 steps passed on Safari on iPhone"). Any failed: a **bug** for an agent per failed step in the same project ("<check>: step 2 fails", with the step, what should happen, your words and the photos), and the check **waits on those bugs**. It comes back to your to-do by itself when they're finished, to run again.
- `get_item` and `wb show` give agents the latest run's results per step.

## Usage

Usage, at the foot of the nav (`/usage`): what Claude has used, for the project you're on or all of them: cost at Claude API list prices, tokens by type, charts by project, model or app, and breakdowns by session and day. It reads Claude Code's transcripts in `~/.claude/projects` and opens only on this computer. A worktree counts with its project; other folders are under "Other folders".

## From the phone

`wb serve --lan` (or the app's tray item Phone access) listens on your network too, and only phones you pair get in.

- **Pairing:** Settings → Data → Phones → **Pair a phone** shows a QR code and a code (`XXXX-XXXX`) that work once, for 10 minutes. Scan it, or open the board's address on the phone and type the code. Name the phone and it stays paired.
- **The token:** the phone keeps a random token in an HttpOnly cookie (400 days, renewed on each visit); the board keeps only its hash. Anything else on the network gets the pairing page and the icons. After 5 wrong codes from one address it waits 10 minutes; after 10 in all, the code stops working.
- **What a phone can do:** use the board like this computer does (answers, notes, new items, pictures), except what answers only this computer: the vault, data sources, changing settings, shares, usage and MCP.
- **Paired phones** are listed in Settings → Data; **Remove** shuts one out at once. `wb devices` and `wb unpair <id|all>` do the same.
- **Plain http:** the token and everything the phone reads and sends cross the network unencrypted, so use `--lan` only on a network you trust. That's also why the vault never opens from the phone.
- **As an app:** "Add to Home Screen" gives the board its own icon. Over plain http there's no offline use and no notifications. An iPhone's home-screen app keeps its own cookies: if it opens on the pairing page, pair it once more.
- **Other web pages can't change the board:** every write must be JSON, which a browser won't send from another site. Anything else gets 415.

## Your data

`workbench.db` next to the README (gitignored). The board copies it to `backups/` once a day and keeps the newest 14. `wb backup` makes one now, `wb backups` lists them. To restore, Settings → Data → Restore gives the exact commands for this computer. Vault secrets stay encrypted in backups.

- **Export:** `wb export > workbench-export.jsonl` writes everything on the board to one file, however big, a row at a time (Settings → Data → Export downloads the same file). While this computer syncs it's the cloud board's, streamed from it: the cloud board has no backup files, so this is the way to keep a copy of it. `wb` says so, and exits with an error, if the connection drops before the end.
- **What's in it:** every table a move to the cloud board carries, row for row with its ids: projects, items, notes, pictures, links and their icons, what waits on what, reports with every version, saved report inputs, trackers and their history, goals, rulings, settings, data sources, runs, checks and the vault (encrypted: only your password opens it). Data sources' header values stay sealed with the key of the board that exported them. Not in it: paired devices.
- **Import:** `wb import workbench-export.jsonl` puts an export in place of an empty board, the one `wb` talks to (this computer's, or the cloud board while it syncs), reading it line by line. A board with items or reports refuses unless `--replace`, which empties it first. It checks every table's count against the file's last line, so a cut-off file is refused; on this computer nothing changes then. It also reads the old one-JSON export (format 1, what 0.6.0 and earlier wrote) of a board small enough to be one string; that never had the vault, data sources' headers, link icons or runs.
- **Day pages' history:** `wb tidy --day-pages` removes day pages' older versions now and says how many it removed and kept (the newest 3 of each). Each day page trims itself as it's written; the board on this computer also trims the rest after its startup backup. The cloud board never does it by itself: `wb export` first, then `wb tidy --day-pages`.

**The export's format** (`src/export.ts`) is JSON Lines, one JSON value per line:

```
{"workbench":"export","format":2,"app":"0.6.0","exported_at":"2026-11-25T01:00:00.000Z","tables":[{"name":"projects","columns":["slug","name",…]},…]}
{"t":"projects","r":["demo","Demo",…]}      a row: its table, and its values in the header's columns
{"t":"images","r":[1,7,…,{"b64":"iVBOR…"},…]}  a BLOB as base64
{"end":{"rows":{"projects":3,"items":1200,…}}}   last: each table's row count
```

Tables come parents first (by their foreign keys), rows in rowid order. A page longer than a million characters is its `report_versions` row and the rest in `report_parts`, as the database keeps it. On this computer the file is the board at one moment; the cloud board can be written to while it exports, and a row whose parent went meanwhile is left out on import, which says so.

## Start on login

Optional: a user service. Settings → About → Health says whether it's set up and gives the commands with this computer's paths filled in.

```ini
# ~/.config/systemd/user/workbench.service
[Unit]
Description=Workbench board

[Service]
ExecStart=/home/kostas/.bun/bin/bun /home/kostas/Projects/workbench/src/server.ts
Restart=on-failure

[Install]
WantedBy=default.target
```

Then `systemctl --user enable --now workbench`.
