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
use tauri::{AppHandle, Builder, RunEvent, Runtime, State, Url};

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

