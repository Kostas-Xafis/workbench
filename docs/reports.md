# Reports

A report is one self-contained HTML page, published to a project. It shows in the project's Pages tab, opens in place of the board, and "New tab ↗" opens it on its own.

```bash
wb report status.html                     # project from the current folder; title from <title>
wb report status.html --group Release     # a heading in the Pages tab
wb report status.html --icon 📈           # its own icon (an emoji, or a file.svg)
wb report-icon <id> logo.svg              # change the icon without a new version (none removes it)
wb reports                                # list, with versions
wb unreport <id>
```

Publishing a file with the same name again adds a version. The viewer has a version picker and offers a newer version instead of reloading what you're looking at. `--name` publishes under another name than the file's.

- **Icons:** every report has its own icon, in colour. Agents have to give one: `report` with `publish`, and `wb report` run by an agent, refuse a report that would be left without, and the `icon` action changes it but won't remove it. Day pages keep their date. An icon is one emoji or a small SVG (up to 8 KB, with a viewBox, in its own colours rather than `currentColor`).
- **Groups:** the pencil in the Pages tab puts arrows on each group heading. The order is kept per project. A new group starts at the bottom; reports without a group stay below.

## Day pages

Every project gets a page per work day, under "Days": every item that moved that day (added, started, noted, waiting, finished or dropped) grouped by where it ended up, each with that day's history, plus the project's commits and report versions, in a by-item view and a timeline.

- The board makes them by itself: today's page is updated every 30 minutes, and once a day is over its page gets a last version (also for days missed while the board or the computer was off, up to a week back). A version is added only when something changed, only for projects that had something that day, and without notifications.
- A group shows its 2 newest day pages and folds the rest. After 7 days a day page is archived: it leaves "Days" for "Archived days", where it can still be opened, and search still finds it. Nothing is deleted.
- A work day runs 05:00 to 05:00 by default (Settings → About), so a late night counts as the day before.
- `wb day [YYYY-MM-DD]` does it by hand (`--project P` for one); `--out file.html` writes one page of every project without publishing.

## What a page can use

Any HTML, CSS and JS, including libraries from a CDN. A page runs sandboxed (its own opaque origin: no cookies or `localStorage`, no direct calls to the board's API) and gets a `wb` object, read-only apart from its own saved state:

```js
await wb.items()                                    // this project's items, all statuses
await wb.items({ status: "open", kind: "check" })   // also owner, q, status: [..], project: slug | "*"
await wb.item("wb-k3f9")                             // one item with its notes
await wb.git()                                       // branch, uncommitted, unpushed, unmerged, worktrees
await wb.links(); await wb.reports(); await wb.projects()
wb.open("wb-k3f9")                                   // open the item in the reader on the board
await wb.trackers()                                  // this project's trackers and the global ones ("*": all)
wb.onRefresh(redraw)                                 // the board refreshes every 10 s
wb.report                                            // { id, project, name, title, version }
await wb.state.set({ rate: 3.5 })                    // save this report's inputs (replaces; JSON object/array, ≤ 256 KB)
await wb.state.get()                                 // what was saved, or null; wb.state.clear() forgets it
await wb.fetch("api", "/feedback", { query: { status: "new" } })   // a data source of this project (below)
```

`wb.state` is the one thing a page can write. It's kept in the database by project and report name, so it survives refreshes and new versions; `wb unreport` deletes it. It needs the board around the page; on a bare `/r/<id>` page `get` gives `null` and `set` gives `false`.

To match the board's look, use `var(--wb-bg)`, `--wb-card`, `--wb-ink`, `--wb-muted`, `--wb-line`, `--wb-accent`, `--wb-good`, `--wb-warn`, `--wb-bad`, `--wb-font` and `--wb-mono` (they follow light/dark). [examples/overview.html](../examples/overview.html) is a live project overview built this way.

## Sharing with a link

"Share" in the report's bar opens a Cloudflare quick tunnel: a random `https://….trycloudflare.com` address, no Cloudflare account needed. The dialog shows the link and a QR code.

- First it checks that `cloudflared` is installed and runs. If not, it shows how to install it on this system, and that no `~/.cloudflared/config.yml` is in the way.
- The link reaches a separate read-only server for that one report, pinned to the version you're viewing. Its `wb` calls get this project's items, notes, git state and its own trackers' readings only. `wb.state.set` changes nothing, `wb.open` refuses, and `wb.fetch` answers `{ ok: false, error }`. The board, its API and the vault are never on the link.
- A share runs for 1 to 24 hours, as Settings → Data allows (picked before it starts). "Extend by 1 hour" pushes the end back, up to the longest a link may run (8 hours unless changed). It also stops from "Stop sharing", and at no other time.
- cloudflared runs outside the board, so a board restart keeps the same link (Cloudflare's error page shows until the board is back). Expiry goes by the clock, so a link that ran out while the computer slept closes when it wakes. A reboot ends every share. Only offered on localhost.

## Data sources

A report can read (and, when allowed, write to) an API that needs a secret, without the secret being in the page: name the API once as a data source of the project, and the board adds its headers when the page calls it.

```bash
# The value comes from an env var or stdin, so it isn't in your shell history; it is never printed back.
ISO_ADMIN_TOKEN=… wb source add feedback https://worker.example.com/admin --header 'Authorization: Bearer {env:ISO_ADMIN_TOKEN}'
wb source add feedback https://worker.example.com/admin --write --header 'Authorization: Bearer {stdin}'   # asked, hidden
wb sources                       # names, base URLs, read/write, header names (never values)
wb unsource feedback
```

- `--project P` as everywhere. `--header` repeats; a value may mix text and `{env:VAR}` / `{stdin}`. Adding the same name again replaces it, e.g. for a new token.
- GET only, unless added with `--write` (then also POST, PUT, PATCH, DELETE). The base URL must be https, plain http only for localhost.
- In the page:

```js
const r = await wb.fetch("feedback", "/feedback", { query: { status: "new", limit: 50 } });
// → { ok: true, status: 200, type: "application/json", json: [...] }   (text: "…" when it isn't JSON)
await wb.fetch("feedback", "/feedback/42", { method: "PATCH", body: { status: "done" } });
// failures are values, never thrown: { ok: false, status: 0, error: "…is read-only (GET)…" }
```

  `wb.fetch(name, path = "", { method = "GET", body, query })`. Only the report's own project's sources. `path` is joined onto the base URL and can't leave it: no URLs, no `.`/`..` segments, no encoded `/`. `body` is sent as JSON (a string as text/plain), at most 1 MB. A non-2xx answer comes back with `ok: false`. Redirects aren't followed: you get the 3xx and its `location`. 20 s timeout, 5 MB answer cap.
- **Where the secret lives:** the headers are sealed (AES-256-GCM) with a key in `~/.config/workbench/sources.key` (made 0600 on the first `wb source add`; `WB_SOURCES_KEY` points elsewhere), so the database and its backups hold only ciphertext. Lose the key file and the sources need adding again. On the cloud board the key comes from a secret of its Worker ([cloud.md](cloud.md)). Unlike the vault, the board can open them by itself, which is the point; anyone who can read your home directory can too.
- **Who can call them:** the board's own page on this computer only (on the cloud board: a paired device's). The server refuses calls from another address, another site, or a non-localhost Host. Share links refuse `wb.fetch`. The Pages tab lists the project's sources.
- [examples/data-source.html](../examples/data-source.html) reads and ticks to-dos from a public test API through one.
