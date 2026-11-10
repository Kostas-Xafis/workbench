//! Workbench desktop app: a Tauri shell around the Bun board server.
//!
//! The main window (label `main`) loads the board from its server's URL (`WB_APP_URL`, default
//! `http://localhost:4321`), not from bundled files: the page's relative `/api/...` fetches, the server's
//! loopback/Host/Origin checks and the report iframe all need the page to be same-origin with the server.
//!
//! This file wires each module once; the modules belong to the phase-2 agents (see src-tauri/README.md):
//! - `server` (lifecycle agent): find or start the board, single instance, `app_info`.
//! - `tray`, `notify`, `web` (system agent): tray icon and menu, notifications with click-back,
//!   links/navigation/downloads.
//! - `probe` (debug builds only): answers the phase-1 questions; never compiled into a release.
//!
//! A new command means a line in [`with_commands`], one in build.rs, and a permission in
//! [`BOARD_PERMISSIONS`] if the page may call it. Nothing else here should need to change.

mod notify;
#[cfg(debug_assertions)]
mod probe;
mod server;
mod tray;
mod web;

use tauri::ipc::CapabilityBuilder;
use tauri::{AppHandle, Manager, Runtime, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

/// Label of the board's window. Events for the page go to this label.
pub const MAIN: &str = "main";

/// What the board page (and only the page at the board's own origin) may call. Nothing here runs a
/// program, reads or writes a file, or opens a URL the page chooses. Do not add core:default or any
/// plugin's default set here: those include commands a page should never have.
const BOARD_PERMISSIONS: &[&str] = &[
    "allow-app-info",
    "allow-notify",
    // window.__TAURI__.event.listen / unlisten, for `notification-clicked`. Not emit: the page has nothing to tell Rust.
    "core:event:allow-listen",
    "core:event:allow-unlisten",
];

pub fn run() {
    let builder = tauri::Builder::default();
    // Order matters only for server::init: the single-instance plugin has to be registered first.
    let builder = server::init(builder);
    let builder = notify::init(builder);
    let builder = tray::init(builder);
    let builder = web::init(builder);
    let builder = with_commands(builder);

    builder
        .setup(|app| {
            let handle = app.handle();
            let board = server::setup(handle)?;
            grant_board(handle, &board.url)?;
            let url = board.url.clone();
            app.manage(board);
            main_window(handle, url)?;
            tray::setup(handle)?;
            notify::setup(handle)?;
            #[cfg(debug_assertions)]
            probe::start(handle);
            Ok(())
        })
        .on_window_event(|window, event| {
            tray::on_window_event(window, event);
        })
        .build(tauri::generate_context!())
        .expect("error while building the Workbench app")
        .run(|app, event| {
            server::on_run_event(app, &event);
        });
}

/// Every command, in one list (Tauri takes one invoke handler).
fn with_commands<R: Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    #[cfg(debug_assertions)]
    {
        builder.invoke_handler(tauri::generate_handler![
            server::app_info,
            notify::notify,
            probe::probe_result
        ])
    }
    #[cfg(not(debug_assertions))]
    {
        builder.invoke_handler(tauri::generate_handler![server::app_info, notify::notify])
    }
}

/// Grants [`BOARD_PERMISSIONS`] to the board's exact origin (scheme, host and port), in the main window
/// only. Built at runtime because the port comes from `WB_APP_URL`; there are no static capability files
/// (tauri.conf.json sets `app.security.capabilities` to `[]`).
fn grant_board<R: Runtime>(app: &AppHandle<R>, url: &Url) -> tauri::Result<()> {
    let pattern = format!("{}/*", url.origin().ascii_serialization());
    #[cfg(debug_assertions)]
    let pattern = match probe::pattern_override() {
        Some(p) if p == "none" => return probe::grant(app, None),
        Some(p) => p,
        None => pattern,
    };
    // local(false): CapabilityBuilder also grants to the app's own bundled pages unless told not to.
    let mut cap = CapabilityBuilder::new("board")
        .local(false)
        .remote(pattern.clone())
        .window(MAIN);
    for p in BOARD_PERMISSIONS {
        cap = cap.permission(*p);
    }
    app.add_capability(cap)?;
    #[cfg(debug_assertions)]
    probe::grant(app, Some(pattern))?;
    Ok(())
}

fn main_window<R: Runtime>(app: &AppHandle<R>, url: Url) -> tauri::Result<WebviewWindow<R>> {
    let builder = WebviewWindowBuilder::new(app, MAIN, WebviewUrl::External(url))
        .title("Workbench")
        .inner_size(1280.0, 860.0)
        .min_inner_size(480.0, 400.0);
    let builder = web::attach(app, builder);
    #[cfg(debug_assertions)]
    let builder = probe::attach(builder);
    let window = builder.build()?;
    // Devtools are available in debug builds (right click → Inspect); WB_APP_DEVTOOLS=1 opens them at start.
    #[cfg(debug_assertions)]
    if std::env::var("WB_APP_DEVTOOLS").as_deref() == Ok("1") {
        window.open_devtools();
    }
    Ok(window)
}

/// Brings the board's window to the front (from the tray, a notification click, a second launch).
/// On Wayland, GNOME may only flag the window as wanting attention instead of raising it.
pub(crate) fn show_main<R: Runtime>(app: &AppHandle<R>) {
    if let Some(w) = app.get_webview_window(MAIN) {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}
