# Desktop app

The board in its own window instead of a browser tab. It's the same board, and the browser keeps working too.

```bash
sudo apt install ./Workbench_<version>_amd64.deb # install a .deb from https://github.com/Kostas-Xafis/workbench/releases
sudo apt remove workbench                        # remove
bun install && bun run app:build                 # build from source: the .deb and an AppImage, in src-tauri/target/release/bundle/
```

Building needs Rust and the usual Tauri libraries (WebKitGTK 4.1, libayatana-appindicator, librsvg, libxdo, libssl; see [src-tauri/README.md](../src-tauri/README.md)). `bun run app:build` compiles the server into the app first. `wb open` starts the app when it's installed, and otherwise opens the browser.

- **What it adds:** its own window; a tray icon with the number of items that wait on you and a menu (Open board, Start on login, Phone access, Quit); system notifications (clicking one brings the window back on that item, report or tracker); links to other sites open in your browser; downloads land in `~/Downloads`. Closing the window hides it to the tray; Quit stops the app.
- **Zoom:** Ctrl + / Ctrl − / Ctrl 0 and Ctrl + scroll (also inside a report), 50% to 200%, or Settings → About → Look. The app keeps the level.
- **How it finds the board:** it looks for a running board on port 4321 (the systemd service, say) and uses that one. If nothing answers, it starts its own server, on `~/Projects/workbench/workbench.db` if that exists. It never takes the port from the service: if something else holds 4321, the window says so, and if the service stops, the window waits for it (with a button to start the app's own). The app stops a server only when it started it.
- **Start on login:** in the tray menu (the app opens hidden in the tray), or the systemd service ([Start on login](board.md#start-on-login)). The service keeps the board running with no app open, for agents and the browser all day. With both, the service wins the port and the app attaches to it.
- **Phone access:** the tray item turns on `--lan`; phones then pair in Settings → Data ([From the phone](board.md#from-the-phone)). It's available only when the app started the board itself. With the service running, use `wb serve --lan` or the service.
- **Where things are:** settings in `~/.config/io.github.kostas-xafis.workbench/app.json`; the window's browser data in `~/.local/share/io.github.kostas-xafis.workbench`; the server's log (the one to read when the window says the board stopped) in `~/.local/share/io.github.kostas-xafis.workbench/logs/server.log`. The window has its own browser storage, so "This browser" settings (bell, theme, folded sections) start fresh there.
- **With the board in the cloud** ([cloud.md](cloud.md), `wb sync on`): the app finds `workbench.db.sync.json` next to the database and opens the cloud board instead of finding or starting a server. It signs the window in with a one-time ticket from this computer's device token and asks the cloud board for the tray's count. `WB_APP_URL` and the nightly always use a board on this computer.

## Updates

The app checks GitHub for a new release when it starts and every 6 hours (Settings → About → Updates turns that off), and never installs one without asking.

- When there is one, the board shows "Update available: 0.2.0" and the tray menu "Update to 0.2.0…". Either opens the release notes with **Update now**, **Later** (hidden for a day) and **Skip this version**.
- Update now downloads it with a progress bar, installs it and restarts the app. A board server the app started is stopped first and comes back with the new version. An AppImage is replaced in place. A .deb install asks for your password in the system's own window, and if it can't install that way it offers the .deb to download with the one `sudo apt install` line.
- The first launch of the new version shows "Updated to 0.2.0" with what's new.
- When the app shows a board it didn't start (the service, run from source) and that board is older or newer than the app, the board says so, with what to do (`git pull`, then restart the service).

## Linux notes

- **Wayland (GNOME):** the window's position isn't remembered (only its size), and clicking the tray icon itself does nothing: use its menu.
- **WebKit's DMA-BUF renderer is off:** with NVIDIA's driver it leaked a GPU fence on many frames, and after about a day the window froze with a CPU core at 100%. The app sets `WEBKIT_DISABLE_DMABUF_RENDERER=1` (`WEBKIT_DISABLE_DMABUF_RENDERER=0 workbench-app` turns it back on for a test) and raises its open-files limit. To check a running app: `ls -l /proc/$(pgrep -P $(pgrep -x workbench-app) -f WebKitWebProcess)/fd | grep -c sync_file` should stay near 0.

## Development

`bun run app:dev` builds the server and opens the app on the board at `http://localhost:4321`. `WB_APP_URL=http://localhost:4399` points it at a test board instead; `WB_APP_DB=<file>` is the database the app's own server uses (always set it for tests).
