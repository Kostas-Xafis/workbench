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

- **Which file:** `core.js` (constants, `state`, `$`, `esc`, `md`, `api()`, `pref()`), `hooks.js` (below), `projects.js` (the strip on the left), `rail.js` (the sidebar: reports, links, the link dialog), `trackers.js`, `board.js` (sections and cards), `item.js` (the item dialog), `search.js`, `report.js` (the report viewer, and the routes: `showView`, `route`, `goBoard`), `share.js`, `vault.js` (also the Usage button and the toast), `notify.js` (also the app's zoom keys), `settings.js` (the tabs, their controls, Projects and Health), `settings-<tab>.js` for each other tab (`settings-projects.js` is the project dialog), `setup.js` (`#welcome` and its checklist), `copy.js` (copying refs), `updates.js`, and `boot.js`, last, which starts the board and polls every 10 s. The styles go the same way (`base.css` has the colours, light and dark), with `phone.css` last among them.
- **How it loads:** style sheets in `<head>`, then plain scripts (not modules) at the end of `<body>`, in the order index.html lists them. They share one global scope like one long script: what one file declares at its top level, every other file can use. One difference: a file's functions exist only once it has run, so code that runs while a file loads (not inside a function called later) can use only what earlier files declare.
- **Adding a feature:** its own `ui/<feature>.js` (and `.css`), each named in index.html's `features` blocks and in `ui.ts` (an import and a `UI` entry, in alphabetical order). It plugs in through `hooks.js`: sections at the top or end of the board, more on a card's meta line, its part of the item dialog, a block in the sidebar, work on every poll or once at start, entries in the shortcut list, a view of its own (`views`, with its hash route) and a Settings tab (`addSettingsTab`). Its markup comes from its own script (a dialog appended to `<body>`, a view to `#content`) rather than from index.html, and a hook that throws is logged without stopping the board.
- **Served:** `GET /ui/<name>` sends only the files named in `ui.ts`, with `no-cache` like the page, so a new version shows on the next load; under `--lan`, to paired phones only. The imports in `ui.ts` (`with { type: "file" }`) are what put the files inside the compiled server. The server's log says when index.html and `ui.ts` don't name the same files.

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
