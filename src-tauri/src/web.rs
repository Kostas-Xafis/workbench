//! What the board's webview may do besides showing the board: links, navigation, downloads.
//!
//! Owner: the "system" agent (phase 2). What goes here, all on the window's builder in [`attach`]:
//! - Navigation guard (`on_navigation`): the main frame stays on the board's origin. Any other http(s)
//!   URL opens in the default browser instead (tauri-plugin-opener's Rust side, never granted to the page).
//! - New windows (`on_new_window`, for `target="_blank"` links and `window.open`): same, default browser.
//!   Exception: `/?solo#report/...` (the report's "open in a new tab") may open as a second app window.
//! - Downloads (`on_download`): `<a download>` from the server and `blob:` downloads (Export everything,
//!   backups, the vault's .env). Findings and the approach are in src-tauri/README.md.
//! - Permission requests (`on_permission_request`), e.g. deny everything the board doesn't use.
//!
//! Phase 1 attaches nothing: navigation, new windows and downloads behave as WebKitGTK's defaults.

use tauri::{Builder, Manager, Runtime, WebviewWindowBuilder};

/// Builder-time setup (e.g. the opener plugin, without granting it to the page).
pub fn init<R: Runtime>(builder: Builder<R>) -> Builder<R> {
    builder
}

/// Adds the handlers above to the main window's builder.
pub fn attach<'a, R: Runtime, M: Manager<R>>(
    builder: WebviewWindowBuilder<'a, R, M>,
) -> WebviewWindowBuilder<'a, R, M> {
    builder
}
