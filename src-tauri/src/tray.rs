//! Tray icon and window-close behaviour.
//!
//! Owner: the "system" agent (phase 2). What goes here:
//! - A tray icon (Tauri `TrayIconBuilder`, libayatana-appindicator on Linux) whose icon shows the count of
//!   what waits on Kostas (swap it with `TrayIcon::set_icon`; findings in src-tauri/README.md).
//! - Its menu: Open / Needs you (N) / Start on login / Quit. Open and a left click call `crate::show_main`.
//!   On Linux the appindicator never reports clicks, only menu items, so Open has to be in the menu.
//! - Close to tray: in [`on_window_event`], `CloseRequested` on `crate::MAIN` → `api.prevent_close()` and
//!   hide the window. Quit (menu) exits for real (the lifecycle agent stops an owned server on exit).
//!
//! The count comes from the board (e.g. polling `GET /api/items` from Rust, or a command the page calls);
//! settle that with the lifecycle agent, who owns the server URL ([`crate::server::Board`]).

use tauri::{AppHandle, Builder, Runtime, Window, WindowEvent};

/// Builder-time setup (plugins such as autostart for "Start on login").
pub fn init<R: Runtime>(builder: Builder<R>) -> Builder<R> {
    builder
}

/// Creates the tray icon and its menu. Runs in Tauri's setup, after the main window exists.
pub fn setup<R: Runtime>(_app: &AppHandle<R>) -> tauri::Result<()> {
    Ok(())
}

/// Window events of every window (close to tray goes here).
pub fn on_window_event<R: Runtime>(_window: &Window<R>, _event: &WindowEvent) {}
