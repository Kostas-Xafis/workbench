# Workbench

One board for every project: tasks agents are doing or will do, and the checks, reviews, decisions and setup steps that wait on Kostas. Bun + SQLite, no dependencies.

```bash
wb open        # start the board if needed and open http://localhost:4321
wb ls --mine   # what waits on me, in the project of the current folder
wb help        # everything else
```

- **Items** are named `wb-xxxx` (e.g. `wb-k3f9`); click one on the board to copy it into a prompt ("Do wb-k3f9"). Commands also take the bare `k3f9` and the old numbers.
- **Data:** `workbench.db` next to this file (gitignored). The board copies it to `backups/` once a day and keeps the newest 14; `wb backup` makes one now and `wb backups` lists them. To restore, stop the board and copy a backup over `workbench.db` (vault secrets stay encrypted in backups).
- **Projects:** `wb project <slug> <path> "Name"`. Items added from inside that path belong to it; the board shows each project's git state (uncommitted files, unpushed commits, unmerged branches, worktrees).
- **Layout:** projects down the left edge (each shows its logo, found in the repo: `icon`, `logo`, `app-icon` or `favicon` files, else its initials; the badge counts what waits on you). Next to it, a foldable sidebar with the project's reports and links. Search sits at the top (Ctrl K or `/`): items with their notes, reports' text and links of the selected project, or of everything under "All". The board itself is one section per kind (decisions, setup, checks, …), then "Done lately" and the repository state; every section folds and stays as you left it. "Everything / Needs you / With agents" narrows it to who has to act.
- **Logos:** if the one found is wrong, `wb project <slug> --icon path/in/repo.svg` (`--icon ""` to look again).
- **Bookmarks:** the "Links" part of the sidebar, folded by group. "+" adds one (for one project or every project, optionally in a group), the pencil then a click edits or deletes. The server fetches each site's favicon once and keeps it in the database; paste an icon address in the dialog when the site's own is wrong, or use "Refresh icons" in edit mode. From a terminal: `wb links`, `wb link "Label" <url> [--project P | --all] [--group G] [--icon <url>]`, `wb relink <id> …`, `wb unlink <id>`.
- **Decisions with choices:** `wb add "Sync strategy" --option "CRDT" --option "Last write wins"` files a decision for Kostas with those choices as buttons on its card. One click answers it and hands it back to the agent; `wb show` prints the answer, and `wb ls` shows it after the title. The item's dialog also takes an answer in your own words; `wb answer <ref> "choice"` (or its number) answers from a terminal.
- **Code on items:** commits whose message mentions `wb-xxxx`, and pull requests whose title, body or branch name does, show on the item: a count and the newest PR's state on the card, the list with review and checks in its dialog. Put the ref in commit messages and PR titles. Pull requests come from `gh`, asked at most every 90 s per project.
- **Notifications:** the bell above the board turns on desktop notifications for this browser: something new needs you, an agent finished or got stuck, a report was added or updated. They show only while the board isn't the window in front, and never for changes made in that same tab.
- **Reports** are HTML pages that open inside the board (see below).
- **Secrets** live in the vault (the lock button at the top; see below).
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

**Day reports:** `wb day [YYYY-MM-DD]` publishes `day-<date>` in the sidebar's "Days" group: every item that moved that work day (added, started, noted, waiting, finished or dropped) grouped by where it ended up, each with that day's history, plus commits from every project and report versions, in a by-project view and a timeline. A work day runs 05:00 to 05:00, so a late night counts as the day before; with no date it is the current one. Run it again to add a newer version; `--project P` keeps one project, `--out file.html` writes the page without publishing.

Publishing a file with the same name again adds a version; the viewer has a version picker and offers a newer version instead of reloading what you're looking at. `--name` publishes under another name than the file's.

A page can use any HTML, CSS and JS, including libraries from a CDN. It runs sandboxed (its own opaque origin, so no cookies or `localStorage`, and no direct calls to the board's API), and gets a `wb` object instead, read-only apart from its own saved state:

```js
await wb.items()                                    // this project's items, all statuses
await wb.items({ status: "open", kind: "check" })   // also owner, q, status: [..], project: slug | "*"
await wb.item("wb-k3f9")                             // one item with its notes
await wb.git()                                       // branch, uncommitted, unpushed, unmerged, worktrees
await wb.links(); await wb.reports(); await wb.projects()
wb.open("wb-k3f9")                                   // open the item's dialog on the board
wb.onRefresh(redraw)                                 // the board refreshes every 10 s
wb.report                                            // { id, project, name, title, version }
await wb.state.set({ rate: 3.5 })                    // save this report's inputs (replaces; JSON object/array, ≤ 256 KB)
await wb.state.get()                                 // what was saved, or null; wb.state.clear() forgets it
```

`wb.state` is the one thing a page can write: its own saved object, kept in `workbench.db` by project + report name, so it survives refreshes and new versions; `wb unreport` deletes it. It needs the board around the page (sidebar or "New tab ↗"); on a bare `/r/<id>` page `get` gives `null` and `set` gives `false`.

**Sharing with a link:** "Share" in the report's bar opens a Cloudflare quick tunnel: a random `https://….trycloudflare.com` address, no Cloudflare account needed, that you can paste into a meeting chat. First it checks that `cloudflared` is installed and runs. When it isn't, it shows how to install it on this system first (the package for Debian/Ubuntu, Fedora/RHEL/openSUSE or Arch, Homebrew on macOS, winget on Windows, each with a no-admin way too) and the commands for every other system under "Other systems", and that no `~/.cloudflared/config.yml` is in the way. The link reaches a separate read-only server for that one report, pinned to the version you're viewing. Its `wb` calls get this project's items, notes and git state only (no bookmarks, no other projects), `wb.state.set` changes nothing and `wb.open` refuses. The board, its API and the vault are never on the link. The dialog shows the link and a QR code to scan from a phone. A share runs for 1, 2, 4 or 8 hours (picked before it starts); "Extend by 1 hour" pushes the end back, up to 8 hours after it started. It also stops from "Stop sharing", and at no other time: cloudflared runs outside the board (in its own systemd scope), and the shares are kept in a state file under `$XDG_RUNTIME_DIR`, so a board restart or crash keeps the same link (it shows Cloudflare's error page until the board is back) and the board picks it up again on start. Expiry goes by the clock, checked on every request and every 15 s, so a link whose time ran out while the computer slept closes as soon as it wakes, and one that ran out while the board was down is closed when the board starts. A reboot ends every share. Only offered on localhost.

To match the board's look, use `var(--wb-bg)`, `--wb-card`, `--wb-ink`, `--wb-muted`, `--wb-line`, `--wb-accent`, `--wb-good`, `--wb-warn`, `--wb-bad`, `--wb-font` and `--wb-mono` (they follow light/dark). [examples/overview.html](examples/overview.html) is a live project overview built this way.

## Secrets vault

The **Vault** button at the top opens the secrets of the selected project, plus those shared with every project. The first time, it asks for a vault password.

- **Two gates:** the password unlocks the vault and shows the names only. Showing, copying or editing a value asks for the password again. A shown value hides after 20 seconds. The vault locks when you leave it, and after 5 idle minutes.
- **Encrypted in the browser:** the page derives a key from the password (PBKDF2-SHA256, 600,000 rounds) and encrypts each name, note and value with AES-GCM. The server and `workbench.db` hold only ciphertext, plus a hash of an auth token derived next to the key. The password itself is never stored or sent.
- **This computer only:** the vault answers only requests from localhost. Under `wb serve --lan` the phone sees the board but not the vault, because over plain HTTP the browser offers no encryption and the token would cross the network in the clear.
- **Export as .env:** pick secrets, enter the password once, and the `.env` block is copied (or downloaded). Names that aren't valid variable names become `UPPER_SNAKE`; notes become comments.
- **No recovery:** forget the password and the secrets are gone. `wb vault` says whether a vault exists. `wb vault reset --yes` deletes it, with every secret, so you can start over. "Change password" in the vault re-encrypts everything under a new one.
- **Not for agents or reports:** the `wb` CLI can't read secrets, and report pages can't reach the vault.
