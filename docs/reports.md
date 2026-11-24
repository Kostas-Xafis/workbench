# Reports

A report is one self-contained HTML page, published to a project and opened from the sidebar in place of the board ("New tab ↗" opens it on its own).

```bash
wb report status.html                     # project from the current folder; title from <title>
wb report status.html --group Release     # a heading in the sidebar
wb report status.html --icon 📈           # its own icon in the sidebar (an emoji, or a file.svg)
wb report-icon <id> logo.svg              # change the icon without a new version (none removes it)
wb reports                                # list, with versions
wb unreport <id>
```

**Icons:** every report has its own icon in the sidebar, in colour, in place of the page glyph; the folded sidebar and search show it too. Agents have to give one: `publish_report`, and `wb report` run by an agent, refuse a report that would be left without, and `set_report_icon` changes it but won't remove it. Day pages keep their date. It's one emoji or a small SVG (up to 8 KB, with a viewBox, in its own colours rather than `currentColor`: the board draws it as a picture, so it can't take the theme's).

**Order of the groups:** the pencil in the Reports heading (with a project selected and at least two groups) puts arrows on each heading, to move Days, Release and the rest up and down. The order is kept per project, for every device. A new group starts at the bottom; reports without a group stay below the groups. Under "All", each project's groups follow its own order, the projects in their order down the left edge.

**Day reports:** every project gets a page per work day in its sidebar's "Days": every item of that project that moved that day (added, started, noted, waiting, finished or dropped) grouped by where it ended up, each with that day's history, plus the project's commits and report versions, in a by-item view and a timeline. The board makes them by itself: today's page is brought up to date every 30 minutes, and once a day is over its page gets a last version (also for days it missed while it or the computer was off, up to a week back). A new version is only added when something changed, and only for projects that had something that day; they don't send notifications. In the sidebar, each report group shows 2 (Days its newest) and folds the rest under "Older days" or "N more"; the folded sidebar shows the same 2 per group, a day page as its day of the month. Once 7 days have passed a day page is archived: it leaves "Days" and the count for "Archived days" at the bottom of Reports, where it can still be opened, and search still finds it. Nothing is deleted. A work day runs 05:00 to 05:00 (Settings → You and your day), so a late night counts as the day before. `wb day [YYYY-MM-DD]` does the same by hand (`--project P` for one), and `--out file.html` writes one page of every project without publishing.

Publishing a file with the same name again adds a version; the viewer has a version picker and offers a newer version instead of reloading what you're looking at. `--name` publishes under another name than the file's.

A page can use any HTML, CSS and JS, including libraries from a CDN. It runs sandboxed (its own opaque origin, so no cookies or `localStorage`, and no direct calls to the board's API), and gets a `wb` object instead, read-only apart from its own saved state:

```js
await wb.items()                                    // this project's items, all statuses
await wb.items({ status: "open", kind: "check" })   // also owner, q, status: [..], project: slug | "*"
await wb.item("wb-k3f9")                             // one item with its notes
await wb.git()                                       // branch, uncommitted, unpushed, unmerged, worktrees
await wb.links(); await wb.reports(); await wb.projects()
wb.open("wb-k3f9")                                   // open the item in the reader on the board
await wb.trackers()                                  // this project's status trackers and the global ones ("*": all)
wb.onRefresh(redraw)                                 // the board refreshes every 10 s
wb.report                                            // { id, project, name, title, version }
await wb.state.set({ rate: 3.5 })                    // save this report's inputs (replaces; JSON object/array, ≤ 256 KB)
await wb.state.get()                                 // what was saved, or null; wb.state.clear() forgets it
await wb.fetch("api", "/feedback", { query: { status: "new" } })   // a data source of this project (below)
```

`wb.state` is the one thing a page can write: its own saved object, kept in `workbench.db` by project + report name, so it survives refreshes and new versions; `wb unreport` deletes it. It needs the board around the page (sidebar or "New tab ↗"); on a bare `/r/<id>` page `get` gives `null` and `set` gives `false`.

**Sharing with a link:** "Share" in the report's bar opens a Cloudflare quick tunnel: a random `https://….trycloudflare.com` address, no Cloudflare account needed, that you can paste into a meeting chat. First it checks that `cloudflared` is installed and runs. When it isn't, it shows how to install it on this system first (the package for Debian/Ubuntu, Fedora/RHEL/openSUSE or Arch, Homebrew on macOS, winget on Windows, each with a no-admin way too) and the commands for every other system under "Other systems", and that no `~/.cloudflared/config.yml` is in the way. The link reaches a separate read-only server for that one report, pinned to the version you're viewing. Its `wb` calls get this project's items, notes, git state and its own trackers' readings only (no bookmarks, no other projects, no global trackers), `wb.state.set` changes nothing, `wb.open` refuses, and `wb.fetch` answers `{ ok: false, error }`: data sources are off on a link. The board, its API and the vault are never on the link. The dialog shows the link and a QR code to scan from a phone. A share runs for 1 to 24 hours, as Settings → Privacy and security allows (picked before it starts); "Extend by 1 hour" pushes the end back, up to the longest a link may run (8 hours unless changed). It also stops from "Stop sharing", and at no other time: cloudflared runs outside the board (in its own systemd scope), and the shares are kept in a state file under `$XDG_RUNTIME_DIR`, so a board restart or crash keeps the same link (it shows Cloudflare's error page until the board is back) and the board picks it up again on start. Expiry goes by the clock, checked on every request and every 15 s, so a link whose time ran out while the computer slept closes as soon as it wakes, and one that ran out while the board was down is closed when the board starts. A reboot ends every share. Only offered on localhost.

To match the board's look, use `var(--wb-bg)`, `--wb-card`, `--wb-ink`, `--wb-muted`, `--wb-line`, `--wb-accent`, `--wb-good`, `--wb-warn`, `--wb-bad`, `--wb-font` and `--wb-mono` (they follow light/dark). [examples/overview.html](../examples/overview.html) is a live project overview built this way.


## Data sources

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
- **Where the secret lives:** the headers are sealed (AES-256-GCM) with a key in `~/.config/workbench/sources.key` (made 0600 on the first `wb source add`; `WB_SOURCES_KEY` points elsewhere), so `workbench.db` and its backups hold only ciphertext. Lose the key file and the sources need adding again. On the cloud board the key comes from a secret of its Worker instead ([cloud.md](cloud.md)). Unlike the vault, the board can open them by itself, which is the point; anyone who can read your home directory can too.
- **Who can call them:** the board's own page on this computer only (on the cloud board: the board's own page on a paired device). The server refuses calls from another address (so not from the phone under `wb serve --lan`), from another site, or with a non-localhost Host; share links refuse `wb.fetch`. The sidebar's "Data sources" lists the project's sources (hover for the base URL and header names).
- [examples/data-source.html](../examples/data-source.html) reads and ticks to-dos from a public test API through one.
