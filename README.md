# Workbench

One board for every project: tasks agents are doing or will do, and the checks, reviews, decisions and setup steps that wait on Kostas. Bun + SQLite, no dependencies.

```bash
wb open        # start the board if needed and open http://localhost:4321
wb ls --mine   # what waits on me, in the project of the current folder
wb help        # everything else
```

- **Items** are named `wb-xxxx` (e.g. `wb-k3f9`); click one on the board to copy it into a prompt ("Do wb-k3f9"). Commands also take the bare `k3f9` and the old numbers.
- **Data:** `workbench.db` next to this file (gitignored). The board copies it to `backups/` once a day and keeps the newest 14; `wb backup` makes one now and `wb backups` lists them. To restore, stop the board and copy a backup over `workbench.db` (vault secrets stay encrypted in backups).
- **Projects:** add one in Settings (at the bottom of the projects strip on the left), or `wb project <slug> <path> "Name"`. Items added from inside that path belong to it; the board shows each project's git state (uncommitted files, unpushed commits, unmerged branches, worktrees). A finished project can be archived (see Settings below).
- **Layout:** projects down the left edge (each shows its logo, found in the repo: `icon`, `logo`, `app-icon` or `favicon` files, else its initials; the badge counts what waits on you). Next to it, a foldable sidebar with the project's reports and links. Search sits at the top (Ctrl K or `/`): items with their notes, reports' text and links of the selected project, or of everything under "All". The board itself is one section per kind (decisions, setup, checks, …), then "Done lately" and the repository state; every section folds and stays as you left it. "Everything / Needs you / With agents" narrows it to who has to act.
- **Logos:** if the one found is wrong, `wb project <slug> --icon path/in/repo.svg` (`--icon ""` to look again).
- **Bookmarks:** the "Links" part of the sidebar, folded by group. "+" adds one (for one project or every project, optionally in a group), the pencil then a click edits or deletes. The server fetches each site's favicon once and keeps it in the database; paste an icon address in the dialog when the site's own is wrong, or use "Refresh icons" in edit mode. From a terminal: `wb links`, `wb link "Label" <url> [--project P | --all] [--group G] [--icon <url>]`, `wb relink <id> …`, `wb unlink <id>`.
- **Decisions with choices:** `wb add "Sync strategy" --option "CRDT" --option "Last write wins"` files a decision for Kostas with those choices as buttons on its card. One click answers it and hands it back to the agent; `wb show` prints the answer, and `wb ls` shows it after the title. The item's dialog also takes an answer in your own words; `wb answer <ref> "choice"` (or its number) answers from a terminal.
- **Code on items:** commits whose message mentions `wb-xxxx`, and pull requests whose title, body or branch name does, show on the item: a count and the newest PR's state on the card, the list with review and checks in its dialog. Put the ref in commit messages and PR titles. Pull requests come from `gh`, asked at most every 90 s per project.
- **Notifications:** the bell above the board turns on desktop notifications for this browser: something new needs you, an agent finished or got stuck, a report was added or updated. They show only while the board isn't the window in front, and never for changes made in that same tab.
- **Status trackers** sit under the project's name in the sidebar: quotas and states that change on their own, like EAS builds used this month or GitHub Actions minutes left (see below). With the sidebar folded each is a ring; point at one to see it in full.
- **Reports** are HTML pages that open inside the board (see below).
- **Secrets** live in the vault (the lock button at the top; see below).
- **Agents** use the same `wb` command, or the workbench's MCP server (see below); the rules they follow are in each project's AGENTS.md ("Docs and tracking"). `wb start` records the desktop-app session, and the item's dialog links back to it.
- **From the phone:** `wb serve --lan` listens on the LAN. There is no login, so only do that on a network you trust. Settings → Health shows the address and a QR code to scan.
- **Other web pages can't change the board:** every write to its API must be JSON, and a browser won't send that from another site (or from a report page) without asking the board first, which it never allows. Anything else gets 415.
- **Start on login** (optional): a user service. Settings → Health says whether it's set up, and gives the commands below with this computer's paths filled in.

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

## Settings

Settings, at the bottom of the projects strip on the left (or `#settings`), opens the workbench's settings. They open only on this computer, at localhost: under `wb serve --lan` the phone gets a note instead.

**Projects:** every project in the order they sit down the left edge.

- **Add project:** a folder, a name and a slug. Git repositories next to the projects you have (and in `~/Projects`) that aren't on the board yet are offered with one click. The folder must exist.
- **Edit** (the pencil): name, folder (when a repo moves) and logo (a file in the repo; empty = look for one). The slug can't change, because items, reports and links point at it.
- **Order:** the arrows on each row move it up or down the left edge.
- **Archive:** a finished project leaves the left edge and "All" (its items, reports, links and repository), and its trackers stop reading by themselves. Search still finds its items and reports, and its secrets stay in the vault. It waits under "Archived", where Unarchive brings it back; so does any new open item for it (from `wb add`, an agent or the board), so new work never goes somewhere nobody looks. From a terminal: `wb project <slug> --archive` / `--unarchive`.
- **Remove:** only for a project nothing points at (no items, reports, links, secrets, trackers or data sources), e.g. one added by mistake. Its folder isn't touched.

Adding, editing, reordering and removing projects are accepted only from the board's own page on this computer, like data sources: a project's folder decides where git and tracker commands run.

**Health:** checked when Settings opens and with "Check again". Each line says what the board uses it for, whether it works, and the command that fixes it when it doesn't:

- **git** (repository state, commits on items), **GitHub CLI** (pull requests on items; signed in, and the `user` scope when there's a GitHub Actions tracker), **cloudflared** (sharing a report; the install steps for this system when it's missing), **EAS CLI** (only when there's an EAS builds tracker or `eas` is installed).
- **Backups** (the newest one's age), **status trackers** that can't read (with a button to open each), **project folders** that are gone or aren't git repositories, and the **data sources key** when there are data sources.
- **Agents (MCP):** whether Claude Code has the workbench's MCP server (user scope, from `~/.claude.json`), and both `claude mcp add` commands to copy.
- **Phone:** whether the board listens on the network; when it does, its addresses and a QR code. When it doesn't, how to turn it on (for the user service: add `--lan` to its `ExecStart`).
- **Start on login:** whether the user service is installed, enabled and running; the unit and the commands to install it when it isn't, and the restart command when it is.
- **This board:** port, how long it's been running, Bun's version, where the database and backups are.

Tools are looked up on your shell's PATH (like tracker commands), so the board finds what your terminal finds even when it runs as a service. Pull requests on items are read with that PATH too.

## Reports

A report is one self-contained HTML page, published to a project and opened from the sidebar in place of the board ("New tab ↗" opens it on its own).

```bash
wb report status.html                     # project from the current folder; title from <title>
wb report status.html --group Release     # a heading in the sidebar
wb reports                                # list, with versions
wb unreport <id>
```

**Day reports:** every project gets a page per work day in its sidebar's "Days": every item of that project that moved that day (added, started, noted, waiting, finished or dropped) grouped by where it ended up, each with that day's history, plus the project's commits and report versions, in a by-item view and a timeline. The board makes them by itself: today's page is brought up to date every 30 minutes, and once a day is over its page gets a last version (also for days it missed while it or the computer was off, up to a week back). A new version is only added when something changed, and only for projects that had something that day; they don't send notifications. In the sidebar, each report group shows 2 (Days its newest) and folds the rest under "Older days" or "N more"; the folded sidebar shows the same 2 per group, a day page as its day of the month. A work day runs 05:00 to 05:00, so a late night counts as the day before. `wb day [YYYY-MM-DD]` does the same by hand (`--project P` for one), and `--out file.html` writes one page of every project without publishing.

Publishing a file with the same name again adds a version; the viewer has a version picker and offers a newer version instead of reloading what you're looking at. `--name` publishes under another name than the file's.

A page can use any HTML, CSS and JS, including libraries from a CDN. It runs sandboxed (its own opaque origin, so no cookies or `localStorage`, and no direct calls to the board's API), and gets a `wb` object instead, read-only apart from its own saved state:

```js
await wb.items()                                    // this project's items, all statuses
await wb.items({ status: "open", kind: "check" })   // also owner, q, status: [..], project: slug | "*"
await wb.item("wb-k3f9")                             // one item with its notes
await wb.git()                                       // branch, uncommitted, unpushed, unmerged, worktrees
await wb.links(); await wb.reports(); await wb.projects()
wb.open("wb-k3f9")                                   // open the item's dialog on the board
await wb.trackers()                                  // this project's status trackers and the global ones ("*": all)
wb.onRefresh(redraw)                                 // the board refreshes every 10 s
wb.report                                            // { id, project, name, title, version }
await wb.state.set({ rate: 3.5 })                    // save this report's inputs (replaces; JSON object/array, ≤ 256 KB)
await wb.state.get()                                 // what was saved, or null; wb.state.clear() forgets it
await wb.fetch("api", "/feedback", { query: { status: "new" } })   // a data source of this project (below)
```

`wb.state` is the one thing a page can write: its own saved object, kept in `workbench.db` by project + report name, so it survives refreshes and new versions; `wb unreport` deletes it. It needs the board around the page (sidebar or "New tab ↗"); on a bare `/r/<id>` page `get` gives `null` and `set` gives `false`.

**Sharing with a link:** "Share" in the report's bar opens a Cloudflare quick tunnel: a random `https://….trycloudflare.com` address, no Cloudflare account needed, that you can paste into a meeting chat. First it checks that `cloudflared` is installed and runs. When it isn't, it shows how to install it on this system first (the package for Debian/Ubuntu, Fedora/RHEL/openSUSE or Arch, Homebrew on macOS, winget on Windows, each with a no-admin way too) and the commands for every other system under "Other systems", and that no `~/.cloudflared/config.yml` is in the way. The link reaches a separate read-only server for that one report, pinned to the version you're viewing. Its `wb` calls get this project's items, notes, git state and its own trackers' readings only (no bookmarks, no other projects, no global trackers), `wb.state.set` changes nothing, `wb.open` refuses, and `wb.fetch` answers `{ ok: false, error }`: data sources are off on a link. The board, its API and the vault are never on the link. The dialog shows the link and a QR code to scan from a phone. A share runs for 1, 2, 4 or 8 hours (picked before it starts); "Extend by 1 hour" pushes the end back, up to 8 hours after it started. It also stops from "Stop sharing", and at no other time: cloudflared runs outside the board (in its own systemd scope), and the shares are kept in a state file under `$XDG_RUNTIME_DIR`, so a board restart or crash keeps the same link (it shows Cloudflare's error page until the board is back) and the board picks it up again on start. Expiry goes by the clock, checked on every request and every 15 s, so a link whose time ran out while the computer slept closes as soon as it wakes, and one that ran out while the board was down is closed when the board starts. A reboot ends every share. Only offered on localhost.

To match the board's look, use `var(--wb-bg)`, `--wb-card`, `--wb-ink`, `--wb-muted`, `--wb-line`, `--wb-accent`, `--wb-good`, `--wb-warn`, `--wb-bad`, `--wb-font` and `--wb-mono` (they follow light/dark). [examples/overview.html](examples/overview.html) is a live project overview built this way.

### Data sources

A report can read (and, when allowed, write to) an API that needs a secret, without the secret being in the page: you name the API once as a data source of the project, and the board adds its headers when the page calls it.

```bash
# The value comes from an env var or stdin, so it isn't in your shell history; it is never printed back.
ISO_ADMIN_TOKEN=… wb source add feedback https://worker.example.com/admin --header 'Authorization: Bearer {env:ISO_ADMIN_TOKEN}'
wb source add feedback https://worker.example.com/admin --write --header 'Authorization: Bearer {stdin}'   # asked, hidden
wb sources                       # names, base URLs, read/write, header names (never values)
wb unsource feedback
```

- `--project P` as everywhere (default: the project of the current folder). `--header` repeats; a value may mix text and `{env:VAR}` / `{stdin}` (one hidden prompt each, or one line each from a pipe). Adding the same name again replaces it, e.g. for a new token.
- GET only, unless added with `--write` (then also POST, PUT, PATCH, DELETE). The base URL must be https, plain http only for localhost.
- In the page:

```js
const r = await wb.fetch("feedback", "/feedback", { query: { status: "new", limit: 50 } });
// → { ok: true, status: 200, type: "application/json", json: [...] }   (text: "…" when it isn't JSON)
await wb.fetch("feedback", "/feedback/42", { method: "PATCH", body: { status: "done" } });
// failures are values, never thrown: { ok: false, status: 0, error: "…is read-only (GET)…" }
```

  `wb.fetch(name, path = "", { method = "GET", body, query })`. Only the report's own project's sources. `path` is joined onto the base URL and can't leave it: no URLs, no `.`/`..` segments, no encoded `/`. `body` is sent as JSON (a string as text/plain), at most 1 MB. A non-2xx answer comes back with `ok: false` and its status and body. Redirects aren't followed (the headers could go elsewhere): you get the 3xx and its `location`. 20 s timeout, 5 MB answer cap.
- **Where the secret lives:** the headers are sealed (AES-256-GCM) with a key in `~/.config/workbench/sources.key` (made 0600 on the first `wb source add`; `WB_SOURCES_KEY` points elsewhere), so `workbench.db` and its backups hold only ciphertext. Lose the key file and the sources need adding again. Unlike the vault, the board can open them by itself, which is the point; anyone who can read your home directory can too.
- **Who can call them:** the board's own page on this computer only. The server refuses calls from another address (so not from the phone under `wb serve --lan`), from another site, or with a non-localhost Host; share links refuse `wb.fetch`. The sidebar's "Data sources" lists the project's sources (hover for the base URL and header names).
- [examples/data-source.html](examples/data-source.html) reads and ticks to-dos from a public test API through one.

## Status trackers

A tracker is a live reading shown under the project's name in the sidebar: one or more meters, each a number against an allowance (Android 1/15) or a state in words (In review). A tracker belongs to one project, or to every project (global, like a GitHub account's allowance). Bars stay grey and turn amber (warn) or red (bad) as a meter fills. Click one for its dialog: the meters, when it resets, the trend of its readings, the last error, and Refresh, Record, Edit or Delete. The gauge button next to the project's name adds one.

It gets its reading one of three ways:

- **By hand:** you record it in the dialog, with `wb track`, or an agent does (`record_tracker`).
- **A shell command** the board runs on the tracker's interval, in the project's folder (home for a global one), with your shell's PATH. What it prints is the reading: `12/15` · one meter per line (`Android 12/15`, `iOS: 3 of 15 builds`, `1,240 / 2,000 min`) · a state (`Status: In review`) · or JSON: a number, `{ value, max, unit, label, text, level }` (`used`/`total`/`limit`/`left` work too), a list of those, or `{ meters: [...], note, resets_at, url }`. A non-zero exit or 60 s without an answer counts as a failed read; the last good reading stays and the error shows next to it. Don't put secrets in the command: use the tool's own login (gh, eas) or an env var your shell sets.
- **Built in:** `eas-builds` (EAS builds used this billing period against the Expo plan, Android and iOS, from `eas account:usage`; needs `eas login`) and `github-actions` (the month's free Actions compute on your GitHub account, as Linux-minute equivalents of the $12 that GitHub Free includes; private repos only, since public ones are free; needs gh's `user` scope: `gh auth refresh -h github.com -s user`).

```bash
wb tracker add eas-builds --preset eas-builds                     # in the project's folder, or --project isokratis
wb tracker add gh-actions --global --preset github-actions --every 6h
wb tracker add play-review "Play review" --url https://play.google.com/console   # by hand
wb track play-review "Status: In review" --note "submitted Nov 4"
wb tracker add disk "Disk" --global --command "df -BG --output=used,size / | tail -1 | tr -d G | awk '{print \$1 \"/\" \$2}'" --unit GB
wb trackers                      # this project's and the global ones, with readings
wb tracker eas-builds            # one, how it reads, its history; --json for scripts
wb tracker edit eas-builds --every 15m --warn 60% --bad 90%
wb tracker refresh               # read every self-reading one here now (or name one)
wb untrack disk                  # delete it and its history
```

- **Refresh interval:** `--every 15m|1h|6h|1d|off` (default 1 hour, at least 1 minute; `off` reads only when asked). The board checks every 30 s which ones are due; the dialog's Refresh, `wb tracker refresh` and agents read one at once. Two readers never run the same tracker together.
- **Levels:** a meter with a max warns at 75% and is bad at 90% unless `--warn`/`--bad` say otherwise: a share of max (`80%`) or a number (`14`). When low is bad (minutes left, coverage), put bad below warn (`--warn 20% --bad 10%`) or prefix `<`. A command's JSON can set a meter's `level` itself. `--max` and `--unit` fill in what a reading leaves out.
- **Names:** lowercase with dashes, unique in the project. Commands and agents take `name` (the current project's first, then the global one) or `project/name`.
- **History:** every reading that differs from the one before is kept (the last 2,000), for the trend in the dialog. Desktop notifications (the bell) also say when a tracker starts to warn, turns bad, or stops reading.
- **Who can set a command:** a command runs on this computer, so the board accepts one only from its own page here (like data sources), never from the phone under `--lan`; `wb tracker` and the MCP server run as you anyway.

## MCP server

The workbench is also an MCP server, so agents can work the board with tools instead of shelling out to `wb`. It runs two ways, with the same tools:

```bash
claude mcp add -s user wb -- wb mcp                               # stdio: Claude Code starts `wb mcp` itself
claude mcp add -s user --transport http wb http://localhost:4321/mcp   # or through the running board
```

- **stdio** (`wb mcp`) works without the board running. Its default project is the one whose folder the client starts it in (`WB_PROJECT=slug` to pin one); `start_item` links the desktop-app session it runs in.
- **HTTP** is `POST /mcp` on the board, for this computer only: it refuses other addresses (so not the phone under `--lan`), a Host other than localhost, and any web page's Origin. `?project=slug` sets the default project.
- **Tools:** `list_projects`, `project_overview` (open items, trackers, git state, reports, links and data sources of a project), `search`, `list_items`, `get_item`, `add_item`, `update_item`, `start_item`, `wait_item`, `finish_item`, `drop_item`, `add_note`, `answer_decision` (only with an answer you gave in the conversation), `list_reports`, `read_report`, `publish_report`, `add_link`, `list_trackers`, `get_tracker`, `record_tracker`, `refresh_trackers`, `define_tracker`, `remove_tracker`. Read-only tools are marked as such, so a client can let them run without asking.
- **Resources:** `wb://projects`, `wb://project/{slug}`, `wb://item/{wb-xxxx}`, `wb://report/{id}`, `wb://trackers` and `wb://trackers/{slug}`; open items and reports are listed, so `@` in Claude Code can attach one.
- **Prompts** (slash commands in Claude Code): `/mcp__wb__work-on wb-k3f9` (the item's brief and how to track it), `/mcp__wb__next` (pick the next agent task) and `/mcp__wb__status` (a short status of the project). Item refs and project slugs complete as you type.
- **Not on MCP:** the vault, data sources' secrets, and deleting items, reports or links.
- **Protocol:** MCP 2026-07-28 (stateless, `server/discover`) and the earlier revisions down to 2024-11-05 (the `initialize` handshake), on both transports, written by hand like the rest of the board.

## Secrets vault

The **Vault** button at the top opens the secrets of the selected project, plus those shared with every project. The first time, it asks for a vault password.

- **Two gates:** the password unlocks the vault and shows the names only. Showing, copying or editing a value asks for the password again. A shown value hides after 20 seconds. The vault locks when you leave it, and after 5 idle minutes.
- **Encrypted in the browser:** the page derives a key from the password (PBKDF2-SHA256, 600,000 rounds) and encrypts each name, note and value with AES-GCM. The server and `workbench.db` hold only ciphertext, plus a hash of an auth token derived next to the key. The password itself is never stored or sent.
- **This computer only:** the vault answers only requests from localhost. Under `wb serve --lan` the phone sees the board but not the vault, because over plain HTTP the browser offers no encryption and the token would cross the network in the clear.
- **Export as .env:** pick secrets, enter the password once, and the `.env` block is copied (or downloaded). Names that aren't valid variable names become `UPPER_SNAKE`; notes become comments.
- **No recovery:** forget the password and the secrets are gone. `wb vault` says whether a vault exists. `wb vault reset --yes` deletes it, with every secret, so you can start over. "Change password" in the vault re-encrypts everything under a new one.
- **Not for agents or reports:** the `wb` CLI can't read secrets, and report pages can't reach the vault. For a report that needs an API token, use a data source (above).
