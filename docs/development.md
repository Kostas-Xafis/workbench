# Development

How the repository is laid out, and where to make a change.

| Folder | What's in it |
| --- | --- |
| `src/` | The server, the `wb` command and everything they share, in TypeScript run by Bun: `server.ts` (the board's HTTP server on this computer), `routes.ts` (its routes, which the cloud board serves too), `wb.ts` (the command line), `mcp.ts` (the MCP server), `db.ts` (the SQLite database), `sync.ts` (moving the board to the cloud and back), and one file per feature (`goals.ts`, `rulings.ts`, `trackers.ts`, `vaultask.ts`, …). A file name in these pages with no folder is in `src/`. |
| `ui/` | The board's page: `index.html`, one style sheet and one script per part of the board, the pairing page (`pair.html`), the Usage page (`usage.html`) and the icon. No build step (see below). |
| `test/` | `bun test`, one file per area (see below). |
| `scripts/` | `bun run nightly` and `bun run release`, and the helpers the release build runs. |
| `src-tauri/` | The desktop app, in Rust ([its own README](../src-tauri/README.md)). |
| `worker/` | The cloud board: a Cloudflare Worker that runs the same board from `src/` and `ui/`, with its own `package.json` (wrangler) and tests ([cloud.md](cloud.md)). |
| `examples/` | Report pages to start from ([reports.md](reports.md)). |
| `docs/` | These pages. |

`workbench.db` (and its `-wal` and `-shm` files) and `backups/` at the top are the real board's data, kept out of git. The desktop app looks for the database there, so it stays at the top of the folder.

```bash
bun install                        # the dev tools (TypeScript types, the Tauri CLI); the board itself has no dependencies
bun run serve                      # the board from source, on port 4321
bun run typecheck && bun test      # what CI runs on the TypeScript
```

## The board's page

`ui/index.html` is the markup. Its styles and scripts are the other files in `ui/`, one per part of the board, which the server sends as they are: no build step, no framework.

- **Which file:** `core.js` (constants, `state`, `$`, `esc`, `md`, `api()`, `pref()`), `time.js` (the time formatters, below), `kit.js` (what views draw with, below), `hooks.js` (below), `router.js` (`defineView`, `go`, `route`: below; also the Settings and setup-guide views), `nav.js` (the nav on the left and the phone's bar: below), `projects.js` (loading the projects; `useProject`, `setProject`), `rail.js` (the board's side column: trackers, rulings, reports, links, the link dialog), `trackers.js`, `board.js` (sections and cards; the board view), `answer.js` (every way an item is answered or settled: `act.answer`, `act.ack`, `act.object`, `act.done`, `act.drop`, `act.defer`, `act.giveBack`, `act.note`, `act.update`, and what an ask is), `reader.js` (an item as a document: `createReader`, and the sheet that shows it over the view), `search.js`, `report.js` (the report view), `share.js`, `vault.js` (the vault view, also the Usage button and the toast), `notify.js` (also the app's zoom keys), `settings.js` (the tabs, their controls, Projects and Health), `settings-<tab>.js` for each other tab (`settings-projects.js` is the project dialog), `setup.js` (`#welcome` and its checklist), `copy.js` (copying refs), `updates.js`, and `boot.js`, last, which starts the board and polls every 10 s. The styles go the same way (`base.css` has the design system's tokens, light and dark; `kit.css` the kit's; `nav.css` and `top.css` the frame), with `phone.css` last among them.
- **How it loads:** style sheets in `<head>`, then plain scripts (not modules) at the end of `<body>`, in the order index.html lists them. They share one global scope like one long script: what one file declares at its top level, every other file can use. One difference: a file's functions exist only once it has run, so code that runs while a file loads (not inside a function called later) can use only what earlier files declare.
- **Adding a feature:** its own `ui/<feature>.js` (and `.css`), each named in index.html's `features` blocks and in `ui.ts` (an import and a `UI` entry, in alphabetical order). It plugs in through `hooks.js`: sections at the top or end of the board, more on a card's meta line, its sections of the reader (`readerDoc`, `readerProps`), a block in the board's side column, work on every poll or once at start, entries in the shortcut list, a view of its own (`defineView`, below) and a Settings tab (`addSettingsTab`). Its markup comes from its own script (a dialog appended to `<body>`, a view to `#content`) rather than from index.html, and a hook that throws is logged without stopping the board.
- **Served:** `GET /ui/<name>` sends only the files named in `ui.ts`; under `--lan` and on the cloud board, to paired devices only. The page links each by its version, a hash of the file (`/ui/board.js?v=…`, put in when `/` is served: `src/fresh.ts`), and a file asked for with `?v=` may be kept for a year (`private, max-age=31536000, immutable`). So a page load reads its files from the browser's cache, and a changed file has a new name, which shows on the next load. Without `?v=` a file is `no-cache`, as the page itself is. The board on a computer works the versions out from the files on each load (once, in the compiled server); the cloud board from its assets' ETags, once per Durable Object (`worker/src/assets.ts`). The imports in `ui.ts` (`with { type: "file" }`) are what put the files inside the compiled server. The server's log says when index.html and `ui.ts` don't name the same files.
- **The poll:** every GET answers with an ETag, and with 304 and no body when the request's `If-None-Match` has it (`withEtag`, `src/fresh.ts`, wrapped around the whole route table; the cloud board also wraps what its helper answers). `api()` (core.js) keeps the last answer to each plain GET and sends its ETag, so most of the 10 s poll is a dozen empty 304s, and on one `api()` gives back the very same object: a loader that gets what it already has skips its render (`if (items === before) return`). So don't change what `api()` gives you; copy it first. The answer is still worked out and hashed each time, so it's never stale, whoever wrote. The board asks for `/api/items?bodies=open`: closed items without their details, which are most of a board's bytes.
- **Opening an item:** `openItemById(id or ref)` (reader.js) opens the reader at once from `state.items`, then fills in what the list leaves out (history, pictures, what it waits on, a closed item's details); until a closed item's details are in, they can't be edited. `openNewItem()` opens it in compose mode. The reader draws each part only when its markup changed and never one you're typing in, so the 10 s poll goes on while it's open (`sheet.reload()`, a 304 when nothing changed). A feature adds a section with `hooks.readerDoc` or `hooks.readerProps` ({ html(item, r), wire(el, item, r) }; hooks.js says what `r` offers); the agent's run box is `runPanel` / `wireRunPanel` / `runLive` / `canResume` in dispatch.js.

### The frame: views, the nav and the kit

What the Inbox, Agents and Projects screens are built on. Three places share one frame: the nav on the left (`#nav`; a bar at the bottom on a phone, `#tabbar`), the top bar (`header.top`: the place's title, search, New) and the view under it, one at a time in `#content`.

- **A view registers** with `defineView({...})` (`router.js`), from its own file while it loads:
  - `name`: unique, e.g. `"inbox"`. `el`: its element or a selector; the router shows it while it's current and hides it otherwise (append it to `#content` yourself).
  - `match(hash) → params | null`: `hash` with its `#` (`"#inbox"`, `"#project/isokratis"`), `""` for none. Return an object (the params, `{}` when there are none) to take the address, `null` to pass. Views are asked in the order they registered; the first to take it wins.
  - `default: true`: the view for `""` and for any address nobody takes. One view says so; today that's the board (`board.js`), and the Inbox takes it over by saying so instead (remove it from the board's definition).
  - `show(params, { from })`: called every time it becomes current, and again when the address changes while it is (new params). `from` is the name of the view before it. It may be async.
  - `hide()`: optional, called when another view takes over (the vault locks there, the queue sends its last action).
  - `title`: a string, or `(params) → string`: the top bar's title and the tab's (`"Inbox · Workbench"`). When what it says comes in later (a report's title), call `retitle()`.
  - `nav`: a string, or `(params) → string | null`: what the nav highlights, `"inbox"`, `"agents"`, `"project:<slug>"`, `"settings"`, `"vault"`, or `null` for nothing. With `"project:<slug>"` the top bar shows that project's logo before the title.
  - `entry`: optional, `{ label, icon, order, href }`: the view's own row at the top of the nav and tab in the phone's bar. `icon` is 16×16 SVG path data, drawn stroked in `currentColor` (`'<path d="…"/>'`). `order` sorts the entries (Inbox 10, Agents 20; the board's is 90). `href` defaults to `#<name>` (`#` for the default view).
- **Going somewhere:** `go("#agents")`, `go("")` for the default view, `go(hash, { replace: true })` without a new history step. `goHome()` is `go("")` (`goBoard()` is its older name, which Settings and the setup guide call). Links (`<a href="#agents">`) work as they are: there's one `hashchange` listener, in `router.js`. `router.view` and `router.params` are what shows; `currentNav()` what the nav highlights.
- **The reader is not a view:** `#item/wb-xxxx` opens it over whatever shows (`readerRoute()`, `reader.js`, asked first by `route()`), and a page opened on that address shows the default view under it. Open one with `openItemById(id, { list })`; closing it goes back to the address under it.
- **The project:** `#project/<slug>` is the board for that project until the Projects page exists, and sets `state.project` (`useProject(slug)`, `projects.js`); other views read `state.project` as the project last opened. `setProject(slug)` goes to a project's page.
- **The nav's slots:** `navCount(name, n, state)` puts a count beside the entry of view `name` (also `"project:<slug>"`, which otherwise counts the asks waiting on Kostas there): `n` a number or short text, hidden when it's 0, `""` or `null`; `state` one of `"yours"`, `"running"`, `"stuck"`, `"failed"`, `"done"`, or nothing for a neutral count. Call it whenever the number may have changed: it draws only what changed. `renderNav()` draws the nav again (the router and the loaders call it). The projects come from `state.projects`, the warning chips from `state.trackers` (any at `warn` or `bad`).
- **The kit** (`kit.js`, `kit.css`), what lists share:
  - `row(item, { meta, right, selected })` → HTML: one item as a row, never a card: its kind's glyph, the title (two lines at most), one meta line, a right slot. `meta` replaces the default meta line (`rowMeta(item, { project })`: project · area · recommends: X · unblocks N · age); `right` is HTML (a chip, an age, a button); `selected` draws it as the one picked. A row is `role="option"` with `data-id` and `data-ref`: put rows in a `role="listbox"` element, and handle clicks and keys in the view.
  - `keyedList(el, items, keyFn, renderFn)`: draws `el`'s children from `items`, one element each (`renderFn(item)` → HTML for exactly one element), keyed by `keyFn(item)`. Only children whose HTML changed are replaced (focus moves to the new one), children move only when the order changed, and gone ones are removed; so focus, text selection and scroll stay through the 10 s poll. Group headers go in as items with keys of their own.
  - `chip(text, state)` → HTML: a small label in a state's colour (the states above, or none). `emptyState(title, text, actionHtml)` → HTML: what an empty list says.
  - `confirmIn(anchorOrText, { text, yes, no, danger })` → `Promise<boolean>`: asks in the page in place of `window.confirm()`, which nothing outside Settings uses any more. Pass the question as text (a box in the middle), or the button that asked (the box opens beside it) with the question as `text`. `danger` draws yes in the failed colour. It works over open dialogs, the reader included.
  - `kindGlyph(kind)` → HTML: the kind's small neutral glyph (`kindIcon` is its older name). Kind is never a colour.
- **Times** (`time.js`), the one set of formatters, each taking a database time (`"2026-11-24 17:16:10"`, UTC), an ISO string, milliseconds or a Date: `ago(t)` ("5 min ago", "3 h ago", "9 d ago", then the day), `ago(t, { short: true })` ("5 min", "3 h", "9 d", "3 mo"), `when(t)` ("today 14:05", "tomorrow 09:00", "Tue 14:05", "3 Nov 14:05"), `day(t, { weekday, relative })` ("3 Nov", "Tue 3 Nov", "tomorrow"), `inDays(t)` ("today", "tomorrow", "in 3 days"), `took(from, to)` ("12 min", "1.5 h"). `parseTime(s)` reads a database time.
- **The design system** (`base.css`): use its tokens and nothing else in what you write. Type `--fs-11`, `--fs-12`, `--fs-13`, `--fs-14`, `--fs-16`, `--fs-20`, `--fs-24`; space `--sp-1` … `--sp-8` (4 px steps: 4, 8, 12, 16, 20, 24, 28, 32); corners `--r-sm` (4), `--r-md` (8), `--r-lg` (12); neutrals `--bg`, `--card`, `--sunk`, `--ink`, `--muted`, `--faint`, `--line`, `--hover`, and `--accent` (`--accent-bg`, `--accent-ink`); state `--st-yours`, `--st-running`, `--st-stuck`, `--st-failed`, `--st-done`, each with `--st-…-bg`. Colour marks state only. The older variables (`--decision`, `--review`, `--warn-bg`, …) are still there for the files that use them.

## Tests

```bash
bun test                       # everything, in a second or two
bun test test/mcp.test.ts      # one area
bun test -t "round trip"       # tests whose name matches
```

`test/` has one file per area: `db` (projects, items, decisions, search, reports, settings), `trackers` (the reading parser and levels), `mcp` (a client's JSON-RPC against the same entry the board serves at `/mcp`), `asks` (notices, defaults at their deadline, several picks, the cap) and `server` (the HTTP write guard and the localhost-only routes, on a real server on port 4401). `bun run typecheck` covers them too.

- **On the cloud board's SQLite:** `WB_TEST_SQL=durable-object bun test` runs every test that uses `freshDb()` through `worker/src/sqlite.ts` and a stand-in for a Durable Object's storage that allows only what the real one does (`worker/test/fake-storage.ts`). Code that passes the normal run but not this one won't work on the cloud board.
- **The cloud board itself:** `cd worker && bun test` starts it on a local Worker (`wrangler dev`, port 8797) and tests getting in, the API, MCP and a board going up and coming back down ([cloud.md](cloud.md)). `bun test` at the top runs only `test/` (`root` in bunfig.toml).

- **A fresh board per file:** `bunfig.toml` runs `test/preload.ts` before every file. It points `WB_DB`, `WB_BACKUPS`, `WB_PORT` (4401) and `XDG_RUNTIME_DIR` at a temp folder (`wb-test` in the system temp folder, emptied each run), and stops with an error if the database would be `workbench.db` or anywhere outside the temp folder, so a test can't touch the real board. (They are set there because `db.ts`, `server.ts` and `mcp.ts` read them when imported.)
- **Adding a test:** make `test/<area>.test.ts`, `import { freshDb } from "./helpers"` and call it at the top: it gives a new database with one project, `demo`, that no other file shares. Call the functions in `db.ts` and friends directly, or an MCP tool through `mcpHttp` (see `test/mcp.test.ts`). A test that needs the server starts `server.ts` as a subprocess with its own `WB_DB` and `HOME` (see `test/server.test.ts`) and stops it in `afterAll`.
- **Not covered by `bun test`:** the board's page, and anything that runs a shell command or `gh` (tracker refresh, git). Look at those in a browser or by hand.

## Nightly: try a build before releasing it

`bun run nightly` builds what's in the folder you run it in (any branch or worktree, uncommitted changes too) as a second app, **Workbench Nightly**, and starts it next to the installed one. Try the change in it, and release once it's right.

```bash
bun run nightly                 # build, install, (re)start Workbench Nightly
bun run nightly --fresh-data    # … with a fresh copy of the real board's data
bun run nightly --no-launch     # build and install only
```

- **Apart from the real app:** its own name and orange icon in the launcher and the tray, its own window and settings, and its own board on port 4322 (the real app keeps 4321). Both run at once.
- **Its own data:** a copy of the real board in `~/.local/share/workbench-nightly/`, made the first time and again with `--fresh-data`. What you do in the nightly never reaches the real board; `wb` and the agents keep using the real one. Its trackers and day pages run on the copy too.
- **Version:** the next patch plus the build time and commit, e.g. `0.2.2-nightly.202611112130+5d45c20` (`.dirty` when built with uncommitted changes); Settings → Updates shows it. A nightly has no update check: the next build is the next `bun run nightly`, which stops the running one and starts the new one.
- **Where it goes:** the AppImage at `~/Applications/Workbench-Nightly.AppImage`, its launcher entry in `~/.local/share/applications/workbench-nightly.desktop`. To remove it: delete those two and `~/.local/share/workbench-nightly/`.
- **Faster, for the page alone:** `WB_PORT=4399 WB_DB=<copy> bun src/server.ts` and a browser at `localhost:4399` show a page or server change in seconds, without building the app (see [Development](desktop-app.md) in the desktop app's page).

## Releases

A version tag builds and publishes a release on GitHub (Actions → Release): the desktop app as a `.deb` and an AppImage, the server alone as one executable (`workbench-server_<version>_linux_x86_64`, for running the board without the app, e.g. as the systemd service in [Start on login](board.md#start-on-login)), `SHA256SUMS`, and the signed files the app's update check reads (`*.sig`, `latest.json`). The notes are the commit subjects since the previous tag.

```bash
bun run release 0.2.0 --dry-run   # show the version fields it would change
bun run release 0.2.0             # bump package.json, Cargo.toml and Cargo.lock, commit "Release 0.2.0", tag v0.2.0
git push --atomic origin master v0.2.0   # publish: the tag starts the release build
bun run release 0.2.0 --push      # the same, in one go
```

- **Versions:** `package.json` is the one the server reports (`/api/ping`) and the app shows (tauri.conf.json reads it); `src-tauri/Cargo.toml` and `Cargo.lock` carry the same number. Always bump them with `bun run release`: the build refuses a tag that doesn't match all three. It runs from a clean `master` (`--any-branch` to tag elsewhere) and never pushes unless `--push` is given.
- **Pre-releases:** `bun run release 0.2.0-rc.1` makes a GitHub pre-release. Installed apps don't see it (their update check reads `releases/latest`), so it's the way to try a build before everyone gets it.
- **Signing:** update files are signed with a private key that lives only in the repository's secrets (`TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`) and in `~/.tauri/workbench.key` on Kostas's machine; the app carries its public half (`plugins.updater.pubkey` in `src-tauri/tauri.conf.json`) and refuses an update not signed with it. Losing the key means installed apps can't update any more: they'd need a new version installed by hand.
- **Building a release locally:** `bun run app:build:release` with both variables set builds the same signed files; `bun scripts/release-assets.ts <version>` gathers them into `dist/` with `latest.json` and `SHA256SUMS` (`--unsigned` after a plain `bun run app:build`).
- **The standalone server** needs `WB_DB` (the database's path); `WB_PORT` and `WB_BACKUPS` as for `bun src/server.ts`. For the service: `ExecStart=/path/to/workbench-server_<version>_linux_x86_64` with `Environment=WB_DB=/home/kostas/Projects/workbench/workbench.db`.
- **CI:** three workflows, each run by a push or pull request to master only when its own files change, so a change to one part doesn't run the others' checks, and a change to the docs alone runs nothing:
  - **Server** (`server.yml`): `src/`, `ui/`, `test/`, `scripts/` and the package files. The typecheck, `bun test`, and the compiled server answering `/api/ping`.
  - **Desktop app** (`app.yml`): `src-tauri/`. `cargo check`, `clippy` (warnings fail) and `cargo test`.
  - **Cloud board** (`worker.yml`): `worker/`, and `src/` and `ui/`, which it runs too. Its typecheck, the board's tests on the cloud board's SQLite, its own tests on a local Worker, and the bundle. Deploying is by hand (Run workflow), never on a push.
  - A release commit (`Release X.Y.Z`, which only changes version numbers) runs none of them: its tag builds everything (Release).
