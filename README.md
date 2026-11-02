# Workbench

One board for every project: tasks agents are doing or will do, and the checks, reviews, decisions and setup steps that wait on Kostas. Bun + SQLite, no dependencies.

```bash
wb open        # start the board if needed and open http://localhost:4321
wb ls --mine   # what waits on me, in the project of the current folder
wb help        # everything else
```

- **Items** are named `wb-xxxx` (e.g. `wb-k3f9`); click one on the board to copy it into a prompt ("Do wb-k3f9"). Commands also take the bare `k3f9` and the old numbers.
- **Data:** `workbench.db` next to this file (gitignored). Back it up by copying it (`sqlite3 workbench.db ".backup backup.db"` while the server runs).
- **Projects:** `wb project <slug> <path> "Name"`. Items added from inside that path belong to it; the board shows each project's git state (uncommitted files, unpushed commits, unmerged branches, worktrees).
- **Layout:** projects down the left edge (each shows its logo, found in the repo: `icon`, `logo`, `app-icon` or `favicon` files, else its initials; the badge counts what waits on you). Next to it, a foldable sidebar with the project's reports and links. Search sits at the top (Ctrl K or `/`): items with their notes, reports' text and links of the selected project, or of everything under "All". The board itself is one section per kind (decisions, setup, checks, …), then "Done lately" and the repository state; every section folds and stays as you left it. "Everything / Needs you / With agents" narrows it to who has to act.
- **Logos:** if the one found is wrong, `wb project <slug> --icon path/in/repo.svg` (`--icon ""` to look again).
- **Bookmarks:** the "Links" part of the sidebar, folded by group. "+" adds one (for one project or every project, optionally in a group), the pencil then a click edits or deletes. The server fetches each site's favicon once and keeps it in the database; paste an icon address in the dialog when the site's own is wrong, or use "Refresh icons" in edit mode. From a terminal: `wb links`, `wb link "Label" <url> [--project P | --all] [--group G] [--icon <url>]`, `wb relink <id> …`, `wb unlink <id>`.
- **Reports** are HTML pages that open inside the board (see below).
- **Agents** use the same `wb` command; the rules they follow are in each project's AGENTS.md ("Docs and tracking"). `wb start` records the desktop-app session, and the item's dialog links back to it.
- **From the phone:** `wb serve --lan` listens on the LAN. There is no login, so only do that on a network you trust.
- **Start on login** (optional): a user service.

```ini
# ~/.config/systemd/user/workbench.service
[Unit]
Description=Workbench board

[Service]
ExecStart=/home/kostas/.bun/bin/bun /home/kostas/Projects/workbench/server.ts
Restart=on-failure

[Install]
WantedBy=default.target
```

Then `systemctl --user enable --now workbench`.

## Reports

A report is one self-contained HTML page, published to a project and opened from the sidebar in place of the board ("New tab ↗" opens it on its own).

```bash
wb report status.html                     # project from the current folder; title from <title>
wb report status.html --group Release     # a heading in the sidebar
wb reports                                # list, with versions
wb unreport <id>
```

Publishing a file with the same name again adds a version; the viewer has a version picker and offers a newer version instead of reloading what you're looking at. `--name` publishes under another name than the file's.

A page can use any HTML, CSS and JS, including libraries from a CDN. It runs sandboxed (its own opaque origin, so no cookies or `localStorage`, and no direct calls to the board's API), and gets a read-only `wb` object instead:

```js
await wb.items()                                    // this project's items, all statuses
await wb.items({ status: "open", kind: "check" })   // also owner, q, status: [..], project: slug | "*"
await wb.item("wb-k3f9")                             // one item with its notes
await wb.git()                                       // branch, uncommitted, unpushed, unmerged, worktrees
await wb.links(); await wb.reports(); await wb.projects()
wb.open("wb-k3f9")                                   // open the item's dialog on the board
wb.onRefresh(redraw)                                 // the board refreshes every 10 s
wb.report                                            // { id, project, name, title, version }
```

To match the board's look, use `var(--wb-bg)`, `--wb-card`, `--wb-ink`, `--wb-muted`, `--wb-line`, `--wb-accent`, `--wb-good`, `--wb-warn`, `--wb-bad`, `--wb-font` and `--wb-mono` (they follow light/dark). [examples/overview.html](examples/overview.html) is a live project overview built this way.
