# Workbench desktop app (Tauri)

A Tauri 2.12 shell around the existing Bun server. The window loads the board from the server's URL
(`WB_APP_URL`, default `http://localhost:4321`), so the page stays same-origin with its API, the server's
loopback/Host/Origin checks keep working, and reports still open in their sandboxed iframe. The HTTP server
stays as it is: phone on the LAN (`--lan`), MCP over HTTP, share links, `/r/:id`.

## Build and run

Needs Rust, WebKitGTK 4.1 dev, libayatana-appindicator3-dev, librsvg2-dev, libxdo-dev, libssl-dev. The Tauri
CLI is a devDependency (`bun install`).

```bash
bun run app:dev                                # tauri dev: builds src-tauri, opens the window on :4321
WB_APP_URL=http://localhost:4399 bun run app:dev   # against a test board instead
cd src-tauri && cargo build && cargo clippy    # plain cargo works too; the binary is target/debug/workbench-app
bun run app:build                              # tauri build (.deb, AppImage); needs build:server first (phase 2)
```

`cargo build` needs `binaries/workbench-server-x86_64-unknown-linux-gnu` (gitignored; `bun run build:server`):
tauri-build copies it next to the app's binary (`target/debug/workbench-server`) and fails without it. The app
attaches to a board that answers on `WB_APP_URL`'s port, else starts that sidecar, so a run that can start one
sets `WB_APP_DB` (below). Never point a test run at the real board's database; use a copy:

```bash
mkdir -p /tmp/wb-phase1 && cp backups/<latest>.db /tmp/wb-phase1/workbench.db
WB_PORT=4399 WB_DB=/tmp/wb-phase1/workbench.db WB_BACKUPS=/tmp/wb-phase1/backups bun server.ts
```

Debug builds have devtools (right click → Inspect, or `WB_APP_DEVTOOLS=1` to open them at start). The app's
webview keeps its own storage under `~/.local/share/io.github.kostas-xafis.workbench`, so "This browser"
settings (bell, theme, folded sections) start at their defaults in the app.

## Layout and owners

| File | Owner (phase 2) | What goes there |
|---|---|---|
| `src/lib.rs` | shared, rarely edited | Wires every module once; the command list; the board's capability; the main window; `show_main` |
| `src/server.rs` | lifecycle agent | Find a running board (`/api/ping`), else start the bundled server, wait, restart on crash, stop on quit only if owned; single instance; `app_info` |
| `src/tray.rs` | system agent | Tray icon with the count, menu Open / Needs you (N) / Start on login / Quit; close to tray |
| `src/notify.rs` | system agent | `notify` command and click-back (a working first version is there) |
| `src/web.rs` | system agent | External links to the default browser, navigation guard, new windows, downloads, permission requests |
| `src/probe.rs`, `src/probe.js` | phase-3 review | Debug-only probe that produced the findings below |
| `build.rs` | shared | App commands that get `allow-*` permissions |
| `fallback/index.html` | lifecycle agent | Bundled page (`frontendDist`) the window opens on: "Starting the board…", "Waiting for the board…", "port N is taken", "The board stopped" (log tail, Retry) |

Each module has `init(builder)` (builder time: plugins, state) and/or `setup(app)` / `attach(window builder)`,
called once from `lib.rs`. A new command needs a line in `with_commands` (lib.rs), one in build.rs, and, if the
page may call it, its permission in `BOARD_PERMISSIONS`.

**Capability.** There are no static capability files (`app.security.capabilities: []`). `lib.rs` adds one at
runtime: `board`, `local: false`, `remote.urls: ["<board origin>/*"]` (exact scheme, host and port from
`WB_APP_URL`), window `main`, permissions `allow-app-info`, `allow-notify`, `core:event:allow-listen`,
`core:event:allow-unlisten`. Only harmless commands may be added: nothing that runs a program, reads or writes a
file, opens a URL the page picks, or changes the window/app beyond what the board needs. No `core:default` and
no plugin default sets. `probe_result` is debug-only and granted only under `WB_APP_PROBE=1`.

## Findings (this machine: Ubuntu 26.04, GNOME on Wayland, WebKitGTK 4.1, Tauri 2.12.5)

"Verified" = seen in a probe run's output; "inferred" = reasoned from the code or docs, not observed.

1. **Remote IPC: yes.** The page at `http://localhost:4399` invokes `app_info` and `event.listen` under a runtime
   `remote.urls` capability. Patterns that worked: `http://localhost:4399/*`, `http://localhost:4399`,
   `http://localhost:*/*`, `http://localhost:*`, `http://*:4399/*`. Refused: `http://localhost:4321/*` (other
   port), `http://127.0.0.1:4399/*` (other host name), no capability. Still allowed after `#report/34` in the URL.
   Not granted → refused (`window.is_visible not allowed`). `window.__TAURI__` (withGlobalTauri) and
   `window.isTauri` exist in the page. **Report iframe: no IPC.** `/r/34` renders inside the app (2,595 chars of
   text), its origin is opaque (messages come from `"null"`), `wb.items()` over the bridge answers (403 items).
   It has no `__TAURI_INTERNALS__`, `__TAURI__` or `isTauri`, and can't reach the top frame. It *does* see
   `window.webkit.messageHandlers.ipc` (WebKit gives it to every frame), but a forged message is dropped for the
   wrong invoke key (logged `__TAURI_INVOKE_KEY__ expected … but received guess`), and `fetch("ipc://localhost/…")`
   is refused (`Origin header is not a valid URL`, 500). → Grant the exact origin (`<origin>/*`, what lib.rs
   does), only to window `main`, only harmless commands: the invoke key is the one thing between a report page
   and the board's permissions, and any script that runs in the board page has them all.
2. **Notifications.** Our own command works: `notify` sent `Notify` over D-Bus with actions `["default","Open"]`,
   our icon, and the body's `<b>`/`&` escaped (the server takes body markup). A forged `ActionInvoked(id,
   "default")` (gdbus) came back to Rust, which showed the hidden window (visible and focused afterwards) and
   delivered `notification-clicked` `{ tag: "wbprobe-own", target: { item: 1 } }` to the page. Not verified: a real
   click on GNOME's banner (a person has to; see below). **The board's own `new Notification` without a polyfill:**
   `Notification` exists with `permission: "default"`, but `requestPermission()` resolves `"denied"` without a
   prompt, with or without a click, so the bell reports "blocked" and nothing shows. With an
   `on_permission_request` that allows Notifications, WebKit shows them itself (app name `workbench-app`,
   desktop-entry `org.webkit.app-<hash>`, action "Acknowledge", `onshow` fires), but a forged click didn't reach
   `onclick` (inferred: WebKit only listens to the notification server's own signals) and WebKitGTK doesn't keep
   the permission across launches (inferred), so `notifyOn()` would turn off at every restart. → In the app, the
   page uses `notify` + `notification-clicked`; leave WebKit's permission at its default (denied).
3. **Downloads.** No handler: WebKit saves silently into the XDG download folder (`~/Downloads`), named from
   `Content-Disposition` (`workbench-2026-11-10-151803.db`, `workbench-export-2026-11-10.json`) or the `download`
   attribute for `blob:` (`wbprobe.env`); no prompt and nothing in the page. With `on_download`: `Requested` gives
   the suggested path (download folder + that name); replacing `destination` saves there; `Finished` gives path and
   success. All three (backup, Export everything, blob .env) landed in the chosen temp folder. → Save into the
   download folder under a unique name (WebKit won't overwrite an existing file: inferred), then tell the page
   (`download-finished`, below) and/or show a notification that opens the folder.
4. **Clipboard.** Without a user gesture: `navigator.clipboard.writeText` is refused (`NotAllowedError`) and
   `execCommand("copy")` returns false. From a click (a synthetic GDK click, `isTrusted: true`) and from Rust's
   `eval`: `writeText` resolves and `execCommand` returns true, and the board's own `copyText` returns true. Under
   XWayland (`GDK_BACKEND=x11`) the text reaches the desktop clipboard (wl-paste and xclip show it). Under native
   Wayland it didn't in 4 runs (the clipboard kept what it held before; copies now carry a per-run marker), not even in
   GTK's in-process clipboard: inferred that the compositor refuses a selection set without a real input serial
   (synthetic events have none) or keyboard focus (the window didn't have it at those clicks). → Keep the
   page's code; a person confirms a real click copies (below). Fallback if it doesn't: a write-only
   `copy_text(text)` command on tauri-plugin-clipboard-manager's Rust side. Worth checking too: the vault's .env
   copy runs after the password dialog and an await, maybe outside the gesture.
5. **Visibility.** `hide()` (close to tray): `visibilityState` → `"hidden"` with `visibilitychange`; `show()` →
   `"visible"`. Minimized or behind another window: stays `"visible"` on Wayland, and Tauri's `is_minimized()`
   says false (Wayland doesn't tell). `document.hasFocus()` was true when the window had focus, false after `blur`,
   and false while minimized or behind (the probe window rarely got focus on this desktop, so "false while in front
   and focused" wasn't tested). Timers keep running while hidden, throttled to about 1/s (the board's 20 s
   notification check still runs; its 10 s poll pauses by design). Under X11, minimizing does set `"hidden"`. → The
   board's `away = visibilityState !== "visible" || !hasFocus()` works as is; confirm minimize by hand.
6. **WebCrypto: yes.** `http://localhost` is a secure context; PBKDF2-SHA256 at 600,000 rounds took 113 ms, AES-GCM
   round trip fine, `canVault()` true. The report renders in the iframe and its `wb` bridge answers (see 1).
7. **Tray: yes, as far as D-Bus shows.** `ubuntu-appindicators@ubuntu.com` is enabled; the tray icon registers
   with `org.kde.StatusNotifierWatcher` (`…/org/ayatana/NotificationItem/tray_icon_tray_app_probe`), and `set_icon`
   swaps it at runtime (its `IconName` goes from `/run/user/1000/tray-icon/tray-icon-probe-0.png` to `-1.png`). Not
   seen on screen. The appindicator sends no clicks, only menu items, so Open has to be in the menu; there's no
   badge API, so draw the count into the PNG. libayatana warns it's deprecated (harmless). **Wayland:**
   `outer_position()` is always (0, 0) and `set_position` does nothing (under X11 both work), so only size and
   maximized can be restored; `set_focus` may not raise a window (GNOME's focus-stealing prevention: a second
   window the probe opened didn't get focus).

### For Kostas to confirm by hand

From `src-tauri` with a test server on 4399 (see above), `WB_APP_PROBE_MANUAL=1` waits for a person instead of
faking clicks:

```bash
WB_APP_URL=http://localhost:4399 WB_APP_PROBE=1 WB_APP_PROBE_MANUAL=1 WB_APP_PROBE_STEPS=clip,notify,tray \
  ./target/debug/workbench-app | grep WBPROBE-RESULT
```

1. Click the orange "probe: boardCopy" button at the top left, then paste somewhere: you should get
   `wbprobe-click-boardCopy-` and five letters.
2. A "Workbench probe" notification appears while the window is hidden: click it. The window comes back, and
   `event.notification-clicked` shows in the output.
3. The Workbench icon shows in the top bar, then gets a red dot; it goes after 20 s.
4. Minimize the app while it's in front (any run): the board should still notify then.

## Contract for phase 2

### `GET /api/ping` (server agent)

`200`, `content-type: application/json`, `cache-control: no-store`, no auth, cheap (no database scan):

```json
{ "app": "workbench", "version": "0.1.0", "db": "/home/kostas/Projects/workbench/workbench.db", "pid": 12345, "lan": false }
```

- `app`: always `"workbench"`; the app attaches only when it sees this.
- `version`: `package.json` `version` (tauri.conf.json reads the same field, so app and server match).
- `db`: absolute path of the database in use (`DB_PATH`). `pid`: the server's `process.pid`. `lan`: started with `--lan`.

### How the app finds or starts the server (lifecycle agent)

1. `GET http://127.0.0.1:<port>/api/ping`, port from `WB_APP_URL` (default 4321), timeout 1 s.
   - JSON with `app: "workbench"` → attach: load `WB_APP_URL`, `server: "attached"`, never stop it.
   - Anything else answering → don't start one; show "port <port> is taken by something else" in the window.
   - Nothing (connection refused) → start the bundled server.
2. Start: the sidecar `binaries/workbench-server` (Tauri `externalBin`, file
   `src-tauri/binaries/workbench-server-x86_64-unknown-linux-gnu`, built by `bun run build:server`), with
   - `WB_DB`: `~/Projects/workbench/workbench.db` if it exists, else `$XDG_DATA_HOME/workbench/workbench.db`
     (`~/.local/share/workbench/workbench.db`; create the folder);
   - `WB_BACKUPS`: `backups/` next to that database (the server's own default, set explicitly);
   - `WB_PORT`: the port above;
   - argument `--lan` only when the app's "open to the network" setting is on (app setting `lan`; `WB_APP_LAN=1`
     for dev);
   - cwd: the home folder; stdout/stderr to `~/.local/share/io.github.kostas-xafis.workbench/logs/server.log`.
3. Ready when `/api/ping` answers with the child's `pid` (poll every 100 ms, give up after 15 s and show the log's
   tail). Then load the window, `server: "owned"`.
4. Owned server exits unexpectedly → restart (1 s, 2 s, 5 s…, at most 5 in a minute), then show the error.
5. Quit (tray Quit, not window close): owned → SIGTERM, wait 5 s, SIGKILL. Attached → leave it running.
6. Single instance: a second launch brings the first one's window to the front (`show_main`).

Settled in phase 2 (server.rs):

- **The window opens on the fallback page** (`tauri://localhost/index.html`) and `server::setup` returns at
  once; a supervisor thread finds or starts the board, then grants the board's capability (`grant_board`, once)
  and navigates the window to `WB_APP_URL`. Its state is in the fallback URL's fragment (JSON). So **web.rs's
  navigation guard has to let the main frame go to the app's own `tauri://localhost/…` page as well as the
  board's origin** (both are navigations Rust starts with `WebviewWindow::navigate`).
- **Fallback capability:** `fallback`, `local: true` (the app's own page only, never a remote origin or the report
  iframe), window `main`, one permission: `allow-retry`. `retry` looks again and starts the bundled server if
  nothing answers (Retry, "Start it here"); the board's origin is refused it.
- **Away for a moment:** while the board isn't reachable (a restart, `set_lan`), the board page stays up for 3 s,
  then the fallback page shows; back on the board when it answers again (no reload if it never left).
- **Restarts** after 1, 2, 5, 10, 15 s; a 6th unexpected exit within 60 s → "The board stopped" with the last
  40 lines of server.log. Retry starts over. Not answering within 15 s of starting → killed, same page.
- **An attached board that stops answering is never replaced on our own:** its launcher (the systemd unit,
  `Restart=on-failure`, `RestartSec=3`) is about to bring it back, and a server of ours would take its port and
  leave the unit failing to bind in a loop. Pinged every 2 s; once gone, every 1 s; when it answers again →
  re-attached. "Waiting for the board…" after 3 s, and "Start it here" (= `retry`) after 15 s. Never automatic: it
  may be stopped on purpose (e.g. to restore a backup).
- **At launch, with the unit enabled** (`$XDG_CONFIG_HOME/systemd/user/default.target.wants/workbench.service`)
  and nothing answering yet (login, both starting): wait up to 10 s for it before starting our own.
- **If the app is killed** (crash, SIGKILL, logout), an owned server gets SIGTERM from the kernel
  (`PR_SET_PDEATHSIG`, set in the child between fork and exec; the forking thread is the supervisor, which lives
  as long as the app). Nothing would supervise an orphan (no crash restart, no Quit, `--lan` unchangeable, and the
  next launch would see it as "attached"), and starting a fresh one takes well under a second. The server runs
  in its own process group, so Ctrl-C in the app's terminal reaches only the app.
- **server.log** gets the server's stdout/stderr (through a pipe) and the app's own notes (`… [app] …`, UTC
  times). At 1 MiB it moves to `server.log.1` (replacing the previous one), so the two stay under 2 MiB.
- **Interface:** `is_owned` is also true while our server starts or restarts. `lan_enabled` is the running owned
  server's `--lan` (false when attached or none). `set_lan` returns at once (the restart runs in the background);
  Err only when attached or app.json can't be written; with no server (port taken, failed) it's only saved.
  `app.json` keeps keys it doesn't know. `WB_APP_LAN=1` forces `--lan` on.
- **Single instance:** tauri-plugin-single-instance (D-Bus name from the identifier), so a dev run doesn't start
  while the installed app runs; quit that one first.
- **Test hook** (debug builds only): `WB_APP_TEST_CTL=<fifo>`, one command per line: `text`, `eval <js>`,
  `lan on|off`, `info`, `exit` (as tray Quit). Output lines start with `WBTEST`. See the end of server.rs.

The server reads `index.html` and `icon.svg` next to itself (`new URL("./index.html", import.meta.url)`); a
`bun build --compile` binary has to embed them (inferred, not tried).

### Page ↔ app (exact names)

Detection in the page: `const app = window.isTauri === true && window.__TAURI__ ? window.__TAURI__ : null;`.
It's true only in the app's main window, at the board's origin. Never in a browser, never in a report iframe.
Every call can still be refused (wrong origin, older app), so the page falls back to its web path on a rejected
promise.

| Name | Kind | Payload → result |
|---|---|---|
| `app_info` | command | `app.core.invoke("app_info")` → `{ version: string, server: "owned" \| "attached", port: number }` |
| `notify` | command | `app.core.invoke("notify", { title: string, body?: string, tag?: string, target?: any })` → `number` (notification id). Body is plain text (the app escapes markup). A notification with the same `tag` replaces the previous one. |
| `notification-clicked` | event (app → page) | `app.event.listen("notification-clicked", (e) => …)`, `e.payload` = `{ tag: string \| null, target: any \| null }`, the `target` given to `notify`. The app has already shown and focused the window. Only the newest notification of a tag answers. |
| `download-finished` | event (app → page) | `{ url: string, path: string \| null, name: string, success: boolean }` after a download the app saved (into the download folder); the page may toast "Saved to Downloads: name". |

In the app the page should: send notifications with `notify` instead of `new Notification` (`ping()` in
index.html), with `target` = its `openTarget` data (`{ item }`, `{ report }`, `{ tracker }`), and open it on
`notification-clicked`; treat notifications as allowed (`notifyOn()` = `notify.on`, no `Notification.permission`;
the bell shows). Everything else (clipboard, `<a download>`, vault crypto, report iframe) stays as it is.

Tray count (no page change): the sum of `mine` over the projects in `GET /api/projects` whose `archived_at` is
null (the badges on the left edge), polled by Rust (the page's own poll pauses while the window is hidden).

### Added before phase 2

- **`WB_APP=1`** is in the environment of every server the app starts (owned), so the server (health.ts) can
  speak of the app's own start on login and phone setting instead of the systemd unit. An attached server
  doesn't have it; the page knows it's in the app from `window.isTauri` either way.
- **`WB_APP_DB`** (dev and tests): the database the app gives an owned server, in place of the default. The
  default is the real `~/Projects/workbench/workbench.db`, so **every test run that can start a server sets
  `WB_APP_DB`** (and `WB_APP_URL` to a test port). Never let a test start a server on the real database.
- **Rust interface between modules** (server.rs; the lifecycle agent implements, the others only call):
  `server::board_url(app) -> Url`, `server::is_owned(app) -> bool`, `server::lan_enabled(app) -> bool`,
  `server::set_lan(app, on) -> Result<(), String>` (saves the app setting `lan`, restarts an owned server; Err when
  attached). Tray Quit calls `app.exit(0)`; `server::on_run_event` stops an owned server on exit.
- **HTTP from Rust:** `ureq` 3 (blocking, small), for both the ping (server.rs) and the tray's count (tray.rs).
  Not a second HTTP crate. Added with `default-features = false` (no TLS or gzip; everything is plain HTTP on
  loopback).
- **App settings** (`lan`, and anything else the app keeps): `app.json` in the app's config folder
  (`~/.config/io.github.kostas-xafis.workbench/app.json`), owned by server.rs.

## Probe

Debug builds only (`mod probe` is `cfg(debug_assertions)`); release builds have neither the code nor the
command. Options are in the doc comment at the top of `src/probe.rs`. Example (prints one `WBPROBE-RESULT
{json}` line and quits after ~40 s; keep XDG dirs in /tmp so nothing touches the real ones):

```bash
XDG_DATA_HOME=/tmp/wb-phase1/xdg-data XDG_CACHE_HOME=/tmp/wb-phase1/xdg-cache XDG_CONFIG_HOME=/tmp/wb-phase1/xdg-config \
WB_APP_URL=http://localhost:4399 WB_APP_PROBE=1 ./target/debug/workbench-app | grep WBPROBE-RESULT
```

(`XDG_CONFIG_HOME` with a `user-dirs.dirs` setting `XDG_DOWNLOAD_DIR` keeps handler-less downloads out of
`~/Downloads`.) It writes to the clipboard (save yours first) and briefly shows two notifications and a tray icon.
