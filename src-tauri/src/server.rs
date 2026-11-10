//! The board's server: find one that's running, else start the bundled one.
//!
//! Owner: the "lifecycle" agent (phase 2). What goes here:
//! - Ask `GET <url>/api/ping` (see the contract in src-tauri/README.md). A Workbench answering → attach to it
//!   (`server: "attached"`). Nothing answering → start the bundled server (a Tauri sidecar built with
//!   `bun build --compile`, see `build:server` in package.json) with `WB_DB`, `WB_BACKUPS`, `WB_PORT`
//!   (and `--lan` when asked), wait until `/api/ping` answers, then load the window (`server: "owned"`).
//!   Something else on the port → say so in the window instead of loading it.
//! - Restart the owned server when it exits unexpectedly; stop it on quit only if we started it.
//! - Single instance: register tauri-plugin-single-instance in [`init`] (it must be the first plugin);
//!   a second launch calls `crate::show_main`.
//! - Keep [`Board`] (managed state) current, since `app_info` reads it.
//!
//! Phase 1 only reads `WB_APP_URL` and reports the board as attached, without checking it answers.

use serde::Serialize;
use tauri::{AppHandle, Builder, Manager, RunEvent, Runtime, State, Url};

/// Where the board is, and whether this app started it. Managed state, set in `setup`.
pub struct Board {
    pub url: Url,
    pub port: u16,
    /// true when this app started the server (and so stops it on quit).
    pub owned: bool,
}

/// Builder-time setup: plugins (single instance first) and state that has to exist before `setup`.
pub fn init<R: Runtime>(builder: Builder<R>) -> Builder<R> {
    builder
}

/// Finds the board (phase 2: or starts it). Runs inside Tauri's setup, before the window is created.
pub fn setup<R: Runtime>(_app: &AppHandle<R>) -> Result<Board, Box<dyn std::error::Error>> {
    let raw = std::env::var("WB_APP_URL").unwrap_or_else(|_| "http://localhost:4321".into());
    let url: Url = raw.parse().map_err(|e| format!("WB_APP_URL {raw:?}: {e}"))?;
    let port = url.port_or_known_default().unwrap_or(4321);
    Ok(Board { url, port, owned: false })
}

/// App-level events (exit requested, exit): stop an owned server here.
pub fn on_run_event<R: Runtime>(_app: &AppHandle<R>, _event: &RunEvent) {}

// The interface other modules use (tray.rs, web.rs). Keep these signatures: the lifecycle agent changes what's
// behind them (e.g. `Board` behind a lock once `owned` changes at runtime), the system agent only calls them.

/// The board's URL as the app uses it now (scheme, host, port; the tray polls `/api/projects` on it).
pub fn board_url<R: Runtime>(app: &AppHandle<R>) -> Url {
    app.state::<Board>().url.clone()
}

/// true when this app started the server it shows (and so stops it on quit, and controls `--lan`).
pub fn is_owned<R: Runtime>(app: &AppHandle<R>) -> bool {
    app.state::<Board>().owned
}

/// Whether the owned server was started with `--lan` (the app setting `lan`). false for an attached server.
pub fn lan_enabled<R: Runtime>(_app: &AppHandle<R>) -> bool {
    false
}

/// Turns `--lan` on or off for the owned server: saves the app setting `lan` and restarts the server.
/// Err for an attached server (its own launcher decides). Phase-1 stub; the lifecycle agent implements it.
pub fn set_lan<R: Runtime>(_app: &AppHandle<R>, _on: bool) -> Result<(), String> {
    Err("not implemented yet".into())
}

#[derive(Serialize)]
pub struct AppInfo {
    /// The app's version (tauri.conf.json `version`), not the server's (that's in `/api/ping`).
    version: String,
    /// "owned": this app started the server; "attached": it was already running.
    server: &'static str,
    port: u16,
}

/// `app_info` → `{ version, server: "owned" | "attached", port }`. Granted to the board page.
#[tauri::command]
pub fn app_info<R: Runtime>(app: AppHandle<R>, board: State<'_, Board>) -> AppInfo {
    AppInfo {
        version: app.package_info().version.to_string(),
        server: if board.owned { "owned" } else { "attached" },
        port: board.port,
    }
}

