# Development

How the repository is laid out, and where to make a change.

| Folder | What's in it |
| --- | --- |
| `src/` | The server, the `wb` command and everything they share, in TypeScript run by Bun: `server.ts` (the board's HTTP server on this computer), `routes.ts` (its routes, which the cloud board serves too), `wb.ts` (the command line), `mcp.ts` (the MCP server), `db.ts` (the SQLite database), `sync.ts` (moving the board to the cloud and back), and one file per feature (`goals.ts`, `rulings.ts`, `trackers.ts`, `dispatch.ts`, `agents.ts`, `vaultask.ts`, …). A file name in these pages with no folder is in `src/`. |
| `ui/` | The board's page: `index.html`, one style sheet and one script per part, the pairing page (`pair.html`), the Usage page (`usage.html`) and the icon. No build step. |
| `test/` | `bun test`, one file per area. |
| `scripts/` | `bun run nightly` and `bun run release`, and the helpers the release build runs. |
| `src-tauri/` | The desktop app, in Rust ([its own README](../src-tauri/README.md)). |
| `worker/` | The cloud board: a Cloudflare Worker that runs the same board from `src/` and `ui/` ([cloud.md](cloud.md)). |
| `examples/` | Report pages to start from ([reports.md](reports.md)). |
| `docs/` | These pages. |

`workbench.db` (and its `-wal` and `-shm` files) and `backups/` at the top are the real board's data, kept out of git. The desktop app looks for the database there.

```bash
bun install                        # the dev tools (TypeScript types, the Tauri CLI); the board itself has no dependencies
bun run serve                      # the board from source, on port 4321
bun run typecheck && bun test      # what CI runs on the TypeScript
```

## The board's page

`ui/index.html` is the markup. Its styles and scripts are the other files in `ui/`, one per part of the board, which the server sends as they are: no build step, no framework.

- **Which file:** `core.js` (constants, `state`, `$`, `esc`, `md`, `api()`, `pref()`), `time.js` (the time formatters, below), `kit.js` (what views draw with, below), `hooks.js`, `router.js` (`defineView`, `go`, `route`: below; also the Settings and setup-guide views), `nav.js` (the nav and the phone's bar), `projects.js` (loading projects, items, repositories and code; `useProject`, `setProject`), `pages.js` (a project's reports, links and data sources, for the Pages tab), `project.js` (a project's page), `inbox.js`, `agents.js`, `trackers.js`, `answer.js` (every way an item is answered or settled: `act.answer`, `act.ack`, `act.object`, `act.done`, `act.drop`, `act.defer`, `act.giveBack`, `act.note`, `act.update`), `reader.js` (an item as a document: `createReader`, and the sheet that shows it over the view), `dispatch.js` (the agent session in the reader), `search.js`, `report.js`, `share.js`, `vault.js` (the vault view, the Usage button, the toast), `notify.js` (also the app's zoom keys), `settings.js` and `settings-<tab>.js`, `setup.js` (`#welcome`, and its checklist at the top of the Inbox), `copy.js`, `updates.js`, and `boot.js`, last, which starts the board and polls every 10 s. The styles go the same way: `base.css` has the design system's tokens (light and dark), `kit.css` the kit's, `nav.css` and `top.css` the frame, and `phone.css` comes last (touch targets and safe areas; the page uses `viewport-fit=cover`).
- **How it loads:** style sheets in `<head>`, then plain scripts (not modules) at the end of `<body>`, in the order index.html lists them. They share one global scope: what one file declares at its top level, every other file can use. A file's functions exist only once it has run, so code that runs while a file loads can use only what earlier files declare.
- **Adding a feature:** its own `ui/<feature>.js` (and `.css`), named in index.html's `features` blocks and in `ui.ts` (an import and a `UI` entry, in alphabetical order). It plugs in through `hooks.js`: its sections of the reader (`readerDoc`, `readerProps`), work on every poll or once at start, drawing again when what the board loaded changed (`redraw`), entries in the shortcut list, a view of its own (`defineView`) and a Settings tab (`addSettingsTab`). Its markup comes from its own script rather than from index.html, and a hook that throws is logged without stopping the board.
- **Served:** `GET /ui/<name>` sends only the files named in `ui.ts`; under `--lan` and on the cloud board, to paired devices only. The page links each by a hash of the file (`/ui/core.js?v=…`, put in when `/` is served: `src/fresh.ts`), and a file asked for with `?v=` is kept for a year (`immutable`). A changed file has a new name, which shows on the next load. Without `?v=` a file is `no-cache`. The imports in `ui.ts` (`with { type: "file" }`) put the files inside the compiled server. The server's log says when index.html and `ui.ts` don't name the same files.
- **The poll:** every GET answers with an ETag, and with 304 and no body when `If-None-Match` has it (`withEtag`, `src/fresh.ts`). `api()` keeps the last answer to each plain GET and sends its ETag, so most of the 10 s poll is empty 304s, and on one `api()` gives back the very same object: a loader that gets what it already has skips its render (`if (items === before) return`). So don't change what `api()` gives you; copy it first. The board asks for `/api/items?bodies=open`: closed items without their details, which are most of a board's bytes.
- **Opening an item:** `openItemById(id or ref)` (reader.js) opens the reader at once from `state.items`, then fills in what the list leaves out (history, pictures, what it waits on, a closed item's details). `openNewItem()` opens it in compose mode. The reader draws each part only when its markup changed and never one you're typing in, so the poll goes on while it's open. A feature adds a section with `hooks.readerDoc` or `hooks.readerProps` (`{ html(item, r), wire(el, item, r) }`; hooks.js says what `r` offers). The agent session is `runPanel` / `wireRunPanel` / `runLive` / `canResume` in dispatch.js.


### The frame: views, the nav and the kit

What the Inbox, Agents and Projects screens are built on. Three places share one frame: the nav on the left (`#nav`; a bar at the bottom on a phone, `#tabbar`), the top bar (`header.top`: the place's title, search, New) and the view under it, one at a time in `#content`.

- **A view registers** with `defineView({...})` (`router.js`), from its own file while it loads:
  - `name`: unique, e.g. `"inbox"`. `el`: its element or a selector; the router shows it while it's current and hides it otherwise (append it to `#content` yourself).
  - `match(hash) → params | null`: `hash` with its `#` (`"#inbox"`, `"#project/isokratis"`), `""` for none. Return an object (the params, `{}` when there are none) to take the address, `null` to pass. Views are asked in the order they registered; the first to take it wins.
  - `default: true`: the view for `""` and for any address nobody takes. One view says so: the Inbox (`inbox.js`), which also takes the old addresses `#board` and `#today`.
  - `show(params, { from, fromHash })`: called every time it becomes current, and again when the address changes while it is (new params). `from` is the name of the view before it, `fromHash` its address (the report's ← Back goes there). It may be async.
  - `hide()`: optional, called when another view takes over (the vault locks there).
  - `title`: a string, or `(params) → string`: the top bar's title and the tab's (`"Inbox · Workbench"`). When what it says comes in later (a report's title), call `retitle()`.
  - `nav`: a string, or `(params) → string | null`: what the nav highlights, `"inbox"`, `"agents"`, `"project:<slug>"`, `"settings"`, `"vault"`, or `null` for nothing. With `"project:<slug>"` the top bar shows that project's logo before the title.
  - `entry`: optional, `{ label, icon, order, href }`: the view's own row at the top of the nav and tab in the phone's bar. `icon` is 16×16 SVG path data, drawn stroked in `currentColor` (`'<path d="…"/>'`). `order` sorts the entries (Inbox 10, Agents 20). `href` defaults to `#<name>` (`#` for the default view).
- **Going somewhere:** `go("#agents")`, `go("")` for the default view, `go(hash, { replace: true })` without a new history step. `goHome()` is `go("")`. Links (`<a href="#agents">`) work as they are: there's one `hashchange` listener, in `router.js`. `router.view` and `router.params` are what shows; `currentNav()` what the nav highlights.
- **When something is answered:** every `act` call (answer.js) runs `hooks.settled(item)` once the board has reloaded, wherever it came from (the reader, a swipe, Accept N). The Inbox moves its selection on there.
- **The reader is not a view:** `#item/wb-xxxx` opens it over whatever shows (`readerRoute()`, `reader.js`, asked first by `route()`), and a page opened on that address shows the default view under it. Open one with `openItemById(id, { list })`; closing it goes back to the address under it.
- **The project:** `#project/<slug>` is the project's page (`project.js`), and sets `state.project` (`useProject(slug)`, `projects.js`); other views read `state.project` as the project last opened. `setProject(slug)` goes to a project's page.
- **The nav's slots:** `navCount(name, n, state)` puts a count beside the entry of view `name` (also `"project:<slug>"`, which otherwise shows the Inbox's count for that project: its Answer and Errands asks): `n` a number or short text, hidden when it's 0, `""` or `null`; `state` one of `"yours"`, `"running"`, `"stuck"`, `"failed"`, `"done"`, or nothing for a neutral count. Call it whenever the number may have changed: it draws only what changed. `renderNav()` draws the nav again (the router and the loaders call it). The projects come from `state.projects`, the warning chips from `state.trackers` (any at `warn` or `bad`).
- **The kit** (`kit.js`, `kit.css`), what lists share:
  - `row(item, { meta, right, selected })` → HTML: one item as a row, never a card: its kind's glyph, the title (two lines at most), one meta line, a right slot. `meta` replaces the default meta line (`rowMeta(item, { project })`: project · area · recommends: X · unblocks N · age); `right` is HTML (a chip, an age, a button); `selected` draws it as the one picked. A row is `role="option"` with `data-id` and `data-ref`: put rows in a `role="listbox"` element, and handle clicks and keys in the view.
  - `keyedList(el, items, keyFn, renderFn)`: draws `el`'s children from `items`, one element each (`renderFn(item)` → HTML for exactly one element), keyed by `keyFn(item)`. Only children whose HTML changed are replaced (focus moves to the new one), children move only when the order changed, and gone ones are removed; so focus, text selection and scroll stay through the 10 s poll. Group headers go in as items with keys of their own.
  - `chip(text, state)` → HTML: a small label in a state's colour (the states above, or none). `emptyState(title, text, actionHtml)` → HTML: what an empty list says.
  - `confirmIn(anchorOrText, { text, yes, no, danger })` → `Promise<boolean>`: asks in the page in place of `window.confirm()`, which nothing uses any more. Pass the question as text (a box in the middle), or the button that asked (the box opens beside it) with the question as `text`. `danger` draws yes in the failed colour. It works over open dialogs, the reader included.
  - `kindGlyph(kind)` → HTML: the kind's small neutral glyph. Kind is never a colour.
  - `rowMeta` marks stale work ("stalled 3 d", `staleMark`) and what's deferred ("deferred to Thu", `deferredMark`).
- **Drawing again:** every loader (`loadItems`, `loadReports`, `loadLinks`, `loadTrackers`, `loadGoals`, …) calls `redraw()` when its answer changed, and so do the dialogs that save; a view that draws from `state` adds itself to `hooks.redraw` (the Projects page does).
- **Times** (`time.js`), the one set of formatters, each taking a database time (`"2026-11-24 17:16:10"`, UTC), an ISO string, milliseconds or a Date: `ago(t)` ("5 min ago", "3 h ago", "9 d ago", then the day), `ago(t, { short: true })` ("5 min", "3 h", "9 d", "3 mo"), `when(t)` ("today 14:05", "tomorrow 09:00", "Tue 14:05", "3 Nov 14:05"), `day(t, { weekday, relative })` ("3 Nov", "Tue 3 Nov", "tomorrow"), `inDays(t)` ("today", "tomorrow", "in 3 days"), `took(from, to)` ("12 min", "1.5 h"). `parseTime(s)` reads a database time; `clockOf(ms)` is a clock time ("14:05").
- **The design system** (`base.css`): use its tokens and nothing else in what you write. Type `--fs-11`, `--fs-12`, `--fs-13`, `--fs-14`, `--fs-16`, `--fs-20`, `--fs-24`; space `--sp-1` … `--sp-8` (4 px steps: 4, 8, 12, 16, 20, 24, 28, 32); corners `--r-sm` (4), `--r-md` (8), `--r-lg` (12); neutrals `--bg`, `--card`, `--sunk`, `--ink`, `--muted`, `--faint`, `--line`, `--hover`, and `--accent` (`--accent-bg`, `--accent-ink`); state `--st-yours`, `--st-running`, `--st-stuck`, `--st-failed`, `--st-done`, each with `--st-…-bg`. Colour marks state only. The older variables (`--decision`, `--review`, `--warn-bg`, …) are still there for the files that use them.


## HTTP endpoints behind the places

The page and `wb` are clients of one API (`routes.ts`). The ones the places lean on: `GET /api/agents?project=<slug|*>&since=<ISO time>` (the Agents place: `running`, `ready`, `stuck`, `finished`, `counts`, `start`, `limits`; `agents.ts`), `GET /api/queue` (the Inbox's order; `queue.ts`), `POST /api/items/:id/defer {until}` and `/give-back {text}`, `PUT /api/projects/:slug/order {refs}`, `GET /api/runs/<n>/events?after=<k>` (a run's numbered events; the last 500 are kept), `POST /api/runs/<n>/continue {message}`, `POST /api/items/<ref>/land` (Merge it), and `GET|PATCH /api/settings` (this computer only), and `GET /api/data/export` (the whole board as JSON Lines, streamed a page of rows at a time: `src/export.ts`; its format is in [board.md](board.md#your-data)).

## Tests

```bash
bun test                       # everything, in a second or two
bun test test/mcp.test.ts      # one area
bun test -t "round trip"       # tests whose name matches
```

`test/` has one file per area (`db`, `trackers`, `mcp`, `asks`, `server`, …). `bun run typecheck` covers them too.

- **A fresh board per file:** `test/preload.ts` points `WB_DB`, `WB_BACKUPS`, `WB_PORT` (4401) and `XDG_RUNTIME_DIR` at a temp folder and stops with an error if the database would be anywhere else, so a test can't touch the real board.
- **Adding a test:** make `test/<area>.test.ts`, `import { freshDb } from "./helpers"` and call it at the top: a new database with one project, `demo`. Call the functions in `db.ts` and friends directly, or an MCP tool through `mcpHttp` (see `test/mcp.test.ts`). A test that needs the server starts `server.ts` as a subprocess with its own `WB_DB` and `HOME` (see `test/server.test.ts`).
- **On the cloud board's SQLite:** `WB_TEST_SQL=durable-object bun test` runs every `freshDb()` test through `worker/src/sqlite.ts`. Code that passes the normal run but not this one won't work on the cloud board. `cd worker && bun test` runs the cloud board on a local Worker (port 8797).
- **Not covered:** the board's page, and anything that runs a shell command or `gh` (tracker refresh, git). Look at those in a browser.

## Nightly: try a build before releasing it

`bun run nightly` builds what's in the folder you run it in (any branch or worktree, uncommitted changes too) as a second app, **Workbench Nightly**, and starts it next to the installed one.

```bash
bun run nightly                 # build, install, (re)start Workbench Nightly
bun run nightly --fresh-data    # … with a fresh copy of the real board's data
bun run nightly --no-launch     # build and install only
```

- It has its own name and orange icon, window and settings, and its own board on port 4322 (the real app keeps 4321), on a copy of the real board in `~/.local/share/workbench-nightly/` (made the first time, again with `--fresh-data`). What you do in it never reaches the real board.
- Its version is the next patch plus build time and commit (`0.2.2-nightly.202611112130+5d45c20`, `.dirty` with uncommitted changes). It has no update check.
- To remove it: delete `~/Applications/Workbench-Nightly.AppImage`, `~/.local/share/applications/workbench-nightly.desktop` and `~/.local/share/workbench-nightly/`.
- **Faster, for the page alone:** `WB_PORT=4399 WB_DB=<copy> bun src/server.ts` and a browser at `localhost:4399` show a change in seconds. [The desktop app page](desktop-app.md#development) has the app's own dev variables.

## Releases

A version tag builds and publishes a release on GitHub (Actions → Release): the desktop app as a `.deb` and an AppImage, the server alone as one executable (`workbench-server_<version>_linux_x86_64`), `SHA256SUMS`, and the signed files the app's update check reads (`*.sig`, `latest.json`). The notes are the commit subjects since the previous tag.

```bash
bun run release 0.2.0 --dry-run   # show the version fields it would change
bun run release 0.2.0             # bump package.json, Cargo.toml and Cargo.lock, commit "Release 0.2.0", tag v0.2.0
git push --atomic origin master v0.2.0   # publish: the tag starts the release build
bun run release 0.2.0 --push      # the same, in one go
```

- **Versions:** `package.json` is the one the server reports (`/api/ping`) and the app shows; `src-tauri/Cargo.toml` and `Cargo.lock` carry the same number. Bump them only with `bun run release`: the build refuses a tag that doesn't match all three. It runs from a clean `master` (`--any-branch` to tag elsewhere) and never pushes unless `--push`.
- **Pre-releases:** `bun run release 0.2.0-rc.1` makes a GitHub pre-release. Installed apps don't see it, so it's the way to try a build first.
- **Signing:** update files are signed with a private key kept only in the repository's secrets (`TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`) and in `~/.tauri/workbench.key`. The app carries the public half (`plugins.updater.pubkey` in `src-tauri/tauri.conf.json`) and refuses an unsigned update. Losing the key means installed apps can't update: a new version has to be installed by hand.
- **Building locally:** `bun run app:build:release` with both variables set; `bun scripts/release-assets.ts <version>` gathers the files into `dist/` (`--unsigned` after a plain `bun run app:build`).
- **The standalone server** needs `WB_DB` (the database's path); `WB_PORT` and `WB_BACKUPS` as for `bun src/server.ts`. As the service: `ExecStart=/path/to/workbench-server_<version>_linux_x86_64` with `Environment=WB_DB=/home/kostas/Projects/workbench/workbench.db`.
- **CI:** three workflows, each run only when its own files change (docs alone run nothing): **Server** (`src/`, `ui/`, `test/`, `scripts/`: typecheck, `bun test`, the compiled server answering `/api/ping`), **Desktop app** (`src-tauri/`: `cargo check`, `clippy`, `cargo test`) and **Cloud board** (`worker/`, `src/`, `ui/`: typecheck, the board's tests on the cloud SQLite, its own tests, the bundle; deploying is by hand). A release commit runs none of them: its tag builds everything.
