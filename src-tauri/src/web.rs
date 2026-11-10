//! What the board's webview may do besides showing the board: links, navigation, downloads, permissions.
//!
//! Owner: the "system" agent. Everything is attached to the main window's builder in [`attach`]:
//! - Navigation guard (`on_navigation`): the main frame stays on the board's origin (or the app's own
//!   fallback page). Any other http(s) URL opens in the default browser instead, through
//!   tauri-plugin-opener's Rust function. The plugin itself is not registered, so the page can't call it.
//! - New windows (`on_new_window`: `target="_blank"`, `window.open`): never a second app window; the URL
//!   goes to the default browser. That includes the report's "New tab ↗" (a plain localhost URL).
//! - Both go through [`open_external`], which acts like a popup blocker: 3 opens, then 1 every 5 s, no repeat
//!   of a URL within 3 s, no loopback address but the board's own origin.
//! - Downloads (`on_download`): saved into the download folder under a name that doesn't exist yet
//!   (`name (1).ext`), then the page gets `download-finished` `{ url, path, name, success }`.
//! - Permission requests (`on_permission_request`): everything denied. The board uses none: copying writes
//!   to the clipboard without a permission, notifications go through the `notify` command (notify.rs).

use std::collections::HashSet;
use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

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
    let win_app = app.clone();
    builder
        .on_navigation(move |url| {
            if stays_in_app(&nav_app, url) {
                return true;
            }
            open_external(&nav_app, url);
            false
        })
        .on_new_window(move |url, _features| {
            open_external(&win_app, &url);
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
        // blob:http://localhost:4321/uuid belongs to the page that made it; only the board's own. A report runs in a
        // sandboxed frame (opaque origin), so its blobs are blob:null/uuid: its downloads ("Download CSV") are
        // navigations to those. A document there has an opaque origin, so no capability matches it.
        "blob" => {
            url.path().starts_with("null/")
                || Url::parse(url.path()).map(|inner| same_origin(&inner, &board)).unwrap_or(false)
        }
        "http" | "https" => url.host_str() == Some("tauri.localhost"),
        _ => false,
    }
}

fn same_origin(a: &Url, b: &Url) -> bool {
    a.scheme() == b.scheme() && a.host_str() == b.host_str() && a.port_or_known_default() == b.port_or_known_default()
}

/// Opens http(s) and mailto links in the default browser/mail app, like a browser's popup blocker would let
/// them through: the hooks can't tell a click from a script, or the board from a report's frame (a report
/// can navigate its own frame, and has no popup blocker in the app), so the limits are on volume and target.
/// Anything else (file:, javascript:, custom schemes) is dropped, and so is a loopback address other than the
/// board's own origin, a URL opened less than [`DEDUPE`] ago, and anything past the [`Bucket`]'s rate.
fn open_external<R: Runtime>(app: &AppHandle<R>, url: &Url) {
    if !matches!(url.scheme(), "http" | "https" | "mailto") {
        return;
    }
    if is_loopback(url) && !same_board(url, &crate::server::board_url(app)) {
        eprintln!("web: not opening {url}: a local address other than the board's");
        return;
    }
    if let Err(why) = opens().lock().unwrap_or_else(|e| e.into_inner()).admit(url.as_str(), Instant::now()) {
        eprintln!("web: not opening {url}: {why}");
        return;
    }
    // In an AppImage the browser would start with the image's LD_LIBRARY_PATH, GTK_PATH, PYTHONHOME...: open it
    // the way the opener would (xdg-open, else gio open), with the desktop's environment (server.rs).
    if !crate::server::without_appimage_env().is_empty() {
        return open_with_host_env(url);
    }
    if let Err(e) = tauri_plugin_opener::open_url(url.as_str(), None::<&str>) {
        eprintln!("web: could not open {url}: {e}");
    }
}

/// `xdg-open <url>` (or `gio open <url>` without xdg-open) with [`crate::server::host_env`], reaped on a thread.
/// The URL is http(s) or mailto, so it can't be taken for an option.
fn open_with_host_env(url: &Url) {
    for launcher in [&["xdg-open"][..], &["gio", "open"][..]] {
        let mut cmd = std::process::Command::new(launcher[0]);
        cmd.args(&launcher[1..])
            .arg(url.as_str())
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        crate::server::host_env(&mut cmd);
        match cmd.spawn() {
            Ok(mut child) => {
                std::thread::spawn(move || child.wait());
                return;
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => return eprintln!("web: could not open {url}: {e}"),
        }
    }
    eprintln!("web: could not open {url}: neither xdg-open nor gio is there");
}

// ---------- what open_external lets through ----------

/// At most this many opens in a row...
const BURST: f64 = 3.0;
/// ...then one more every this long.
const REFILL: Duration = Duration::from_secs(5);
/// The same URL again within this long is a repeat, not a new open.
const DEDUPE: Duration = Duration::from_secs(3);

/// A token bucket shared by navigations and new windows, plus the URLs opened in the last [`DEDUPE`].
struct Bucket {
    tokens: f64,
    at: Instant,
    recent: Vec<(String, Instant)>,
}

impl Bucket {
    fn admit(&mut self, url: &str, now: Instant) -> Result<(), &'static str> {
        self.recent.retain(|(_, t)| now.duration_since(*t) < DEDUPE);
        if self.recent.iter().any(|(u, _)| u == url) {
            return Err("opened less than 3 s ago");
        }
        self.tokens = (self.tokens + now.duration_since(self.at).as_secs_f64() / REFILL.as_secs_f64()).min(BURST);
        self.at = now;
        if self.tokens < 1.0 {
            return Err("too many links opened at once (3, then 1 every 5 s)");
        }
        self.tokens -= 1.0;
        self.recent.push((url.to_string(), now));
        Ok(())
    }
}

fn opens() -> &'static Mutex<Bucket> {
    static B: OnceLock<Mutex<Bucket>> = OnceLock::new();
    B.get_or_init(|| Mutex::new(Bucket { tokens: BURST, at: Instant::now(), recent: Vec::new() }))
}

/// localhost, *.localhost, 127.0.0.0/8, ::1, 0.0.0.0 (and ::). LAN addresses are not: Health links to the
/// board's own LAN URLs.
fn is_loopback(url: &Url) -> bool {
    let Some(host) = url.host_str() else { return false };
    let host = host.trim_start_matches('[').trim_end_matches(']').trim_end_matches('.').to_ascii_lowercase();
    match host.parse::<std::net::IpAddr>() {
        Ok(std::net::IpAddr::V4(ip)) => ip.is_loopback() || ip.is_unspecified(),
        Ok(std::net::IpAddr::V6(ip)) => {
            ip.is_loopback()
                || ip.is_unspecified()
                || ip.to_ipv4_mapped().is_some_and(|v4| v4.is_loopback() || v4.is_unspecified())
        }
        Err(_) => host == "localhost" || host.ends_with(".localhost"),
    }
}

/// The board's own origin (scheme, host, port), localhost and 127.0.0.1 counting as the same host: the
/// report's "New tab ↗" opens the board in the browser.
fn same_board(url: &Url, board: &Url) -> bool {
    let host = |u: &Url| match u.host_str() {
        Some("localhost") | Some("127.0.0.1") => Some("127.0.0.1".to_string()),
        h => h.map(str::to_ascii_lowercase),
    };
    url.scheme() == board.scheme() && host(url) == host(board) && url.port_or_known_default() == board.port_or_known_default()
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
            // The folder is ours to pick, not the proposed path's: for a suggested name like ".." (a
            // Content-Disposition or a `download` attribute) wry proposes `Downloads/../ (1)..`, one level up.
            let dir = app
                .path()
                .download_dir()
                .or_else(|_| app.path().home_dir())
                .unwrap_or_else(|_| destination.parent().map(Path::to_path_buf).unwrap_or_default());
            let name = safe_name(destination.file_name());
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

/// The proposed file name as a plain, visible file name: no leading dots (no `.bashrc`, `..`), no path
/// separators, at most 200 bytes (a longer one fails to save), `download` if nothing is left.
fn safe_name(name: Option<&OsStr>) -> OsString {
    const MAX: usize = 200;
    let raw = name.map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let mut s: String = raw.trim().trim_start_matches('.').replace(['/', '\\', '\0'], "_");
    if s.len() > MAX {
        // Keep a short extension ("….csv"), cut the rest on a character boundary.
        let ext = Path::new(&s).extension().map(|e| e.to_string_lossy().into_owned()).filter(|e| e.len() <= 16);
        let keep = MAX - ext.as_ref().map_or(0, |e| e.len() + 1);
        let mut cut = keep;
        while !s.is_char_boundary(cut) {
            cut -= 1;
        }
        s.truncate(cut);
        if let Some(e) = ext {
            s = format!("{s}.{e}");
        }
    }
    if s.trim().is_empty() {
        "download".into()
    } else {
        s.into()
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bucket_bursts_three_then_one_per_five_seconds_and_drops_repeats() {
        let t0 = Instant::now();
        let mut b = Bucket { tokens: BURST, at: t0, recent: Vec::new() };
        let at = |ms: u64| t0 + Duration::from_millis(ms);
        assert!(b.admit("https://a/1", at(0)).is_ok());
        assert!(b.admit("https://a/1", at(100)).is_err(), "repeat within 3 s");
        assert!(b.admit("https://a/2", at(200)).is_ok());
        assert!(b.admit("https://a/3", at(300)).is_ok());
        assert!(b.admit("https://a/4", at(400)).is_err(), "bucket empty");
        assert!(b.admit("https://a/4", at(5_400)).is_ok(), "one token after 5 s");
        assert!(b.admit("https://a/5", at(5_500)).is_err());
        assert!(b.admit("https://a/1", at(10_500)).is_ok(), "an old URL again, after 3 s");
    }

    #[test]
    fn loopback_targets_and_the_board() {
        let u = |s: &str| Url::parse(s).unwrap();
        for s in ["http://localhost:8080/", "http://LOCALHOST./", "http://x.localhost/", "http://127.0.0.1/", "http://127.1:9/",
            "http://2130706433/", "http://0.0.0.0:22/", "http://[::1]:80/", "http://[::ffff:127.0.0.1]/", "http://[::]/"] {
            assert!(is_loopback(&u(s)), "{s}");
        }
        for s in ["http://192.168.1.5:4321/", "https://github.com/x", "mailto:a@b.c", "http://10.0.0.1/"] {
            assert!(!is_loopback(&u(s)), "{s}");
        }
        let board = u("http://localhost:4321/");
        assert!(same_board(&u("http://127.0.0.1:4321/?solo#report/3"), &board));
        assert!(same_board(&u("http://localhost:4321/r/3"), &board));
        assert!(!same_board(&u("http://localhost:8080/"), &board));
        assert!(!same_board(&u("https://localhost:4321/"), &board));
        assert!(!same_board(&u("http://[::1]:4321/"), &board));
    }
}
