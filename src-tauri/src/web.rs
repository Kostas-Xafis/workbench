//! What the board's webview may do besides showing the board: links, navigation, downloads, permissions.
//!
//! Owner: the "system" agent. Everything is attached to the main window's builder in [`attach`]:
//! - Navigation guard (`on_navigation`): the main frame stays on the board's origin (or the app's own
//!   fallback page). Any other http(s) URL opens in the default browser instead, through
//!   tauri-plugin-opener's Rust function. The plugin itself is not registered, so the page can't call it.
//! - New windows (`on_new_window`: `target="_blank"`, `window.open`): never a second app window; the URL
//!   goes to the default browser. That includes the report's "New tab ↗" (a plain localhost URL).
//! - Downloads (`on_download`): saved into the download folder under a name that doesn't exist yet
//!   (`name (1).ext`), then the page gets `download-finished` `{ url, path, name, success }`.
//! - Permission requests (`on_permission_request`): everything denied. The board uses none: copying writes
//!   to the clipboard without a permission, notifications go through the `notify` command (notify.rs).

use std::collections::HashSet;
use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use serde_json::json;
use tauri::webview::{DownloadEvent, NewWindowResponse, PermissionResponse};
use tauri::{AppHandle, Builder, Emitter, Manager, Runtime, Url, WebviewWindowBuilder};

/// Event the page gets after the app saved a download: `{ url, path: string | null, name, success }`.
pub const DOWNLOAD_EVENT: &str = "download-finished";

/// Builder-time setup. Nothing to register: the opener plugin's Rust functions need no plugin.
pub fn init<R: Runtime>(builder: Builder<R>) -> Builder<R> {
    builder
}

/// Adds the handlers above to the main window's builder.
pub fn attach<'a, R: Runtime, M: Manager<R>>(
    app: &AppHandle<R>,
    builder: WebviewWindowBuilder<'a, R, M>,
) -> WebviewWindowBuilder<'a, R, M> {
    let nav_app = app.clone();
    builder
        .on_navigation(move |url| {
            if stays_in_app(&nav_app, url) {
                return true;
            }
            open_external(url);
            false
        })
        .on_new_window(|url, _features| {
            open_external(&url);
            NewWindowResponse::Deny
        })
        .on_download(|webview, event| {
            on_download(webview.app_handle(), event);
            true
        })
        .on_permission_request(|_webview, kind| {
            #[cfg(debug_assertions)]
            eprintln!("web: permission request {kind:?} denied");
            #[cfg(not(debug_assertions))]
            let _ = kind;
            PermissionResponse::Deny
        })
}

/// The board's origin, and the app's own bundled page (`tauri://localhost`, `http://tauri.localhost`),
/// plus the schemes a page uses for itself (blob: for the vault's download, about:/data: for frames).
fn stays_in_app<R: Runtime>(app: &AppHandle<R>, url: &Url) -> bool {
    let board = crate::server::board_url(app);
    if same_origin(url, &board) {
        return true;
    }
    match url.scheme() {
        "tauri" | "ipc" | "about" | "data" => true,
        // blob:http://localhost:4321/uuid belongs to the page that made it; only the board's own.
        "blob" => Url::parse(url.path()).map(|inner| same_origin(&inner, &board)).unwrap_or(false),
        "http" | "https" => url.host_str() == Some("tauri.localhost"),
        _ => false,
    }
}

fn same_origin(a: &Url, b: &Url) -> bool {
    a.scheme() == b.scheme() && a.host_str() == b.host_str() && a.port_or_known_default() == b.port_or_known_default()
}

/// Opens http(s) and mailto links in the default browser/mail app; anything else (file:, javascript:,
/// custom schemes) is dropped.
fn open_external(url: &Url) {
    if !matches!(url.scheme(), "http" | "https" | "mailto") {
        return;
    }
    if let Err(e) = tauri_plugin_opener::open_url(url.as_str(), None::<&str>) {
        eprintln!("web: could not open {url}: {e}");
    }
}

// ---------- downloads ----------

#[derive(Default)]
struct Downloads {
    /// Destinations handed out and not finished yet, so two downloads of the same name get different files.
    reserved: HashSet<PathBuf>,
    /// (url, destination) of the downloads in flight, to name the finished event.
    pending: Vec<(String, PathBuf)>,
}

fn downloads() -> &'static Mutex<Downloads> {
    static D: OnceLock<Mutex<Downloads>> = OnceLock::new();
    D.get_or_init(Default::default)
}

fn on_download<R: Runtime>(app: &AppHandle<R>, event: DownloadEvent<'_>) {
    match event {
        DownloadEvent::Requested { url, destination } => {
            let name = destination
                .file_name()
                .map(|n| n.to_owned())
                .unwrap_or_else(|| "download".into());
            let dir = destination.parent().map(Path::to_path_buf).unwrap_or_default();
            let _ = std::fs::create_dir_all(&dir);
            let mut d = downloads().lock().unwrap();
            let target = unique_path(&dir, &name, &d.reserved);
            d.reserved.insert(target.clone());
            d.pending.push((url.to_string(), target.clone()));
            *destination = target;
        }
        DownloadEvent::Finished { url, path, success } => {
            let mut d = downloads().lock().unwrap();
            let at = d
                .pending
                .iter()
                .position(|(u, p)| path.as_ref() == Some(p) || (path.is_none() && u == url.as_str()));
            let Some(at) = at else { return };
            let (_, dest) = d.pending.remove(at);
            d.reserved.remove(&dest);
            drop(d);
            let name = dest.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            let payload = json!({
                "url": url.as_str(),
                "path": path.as_ref().map(|p| p.to_string_lossy().into_owned()),
                "name": name,
                "success": success,
            });
            let _ = app.emit_to(crate::MAIN, DOWNLOAD_EVENT, payload);
        }
        _ => {}
    }
}

/// `dir/name`, or `dir/stem (1).ext`, `(2)`... when that exists or is already promised to another download.
fn unique_path(dir: &Path, name: &OsStr, reserved: &HashSet<PathBuf>) -> PathBuf {
    let first = dir.join(name);
    if !first.exists() && !reserved.contains(&first) {
        return first;
    }
    let as_path = Path::new(name);
    let stem = as_path.file_stem().unwrap_or(name).to_string_lossy().into_owned();
    let ext = as_path.extension().map(|e| e.to_string_lossy().into_owned());
    (1u32..)
        .map(|n| match &ext {
            Some(e) => dir.join(format!("{stem} ({n}).{e}")),
            None => dir.join(format!("{stem} ({n})")),
        })
        .find(|p| !p.exists() && !reserved.contains(p))
        .expect("an unused name")
}
