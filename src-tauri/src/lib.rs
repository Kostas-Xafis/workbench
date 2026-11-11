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
//! - `update`: updates of the app itself (tauri-plugin-updater), offered on the board and in the tray.
//! - `probe` (debug builds only): answers the phase-1 questions; never compiled into a release.
//!
//! A new command means a line in [`with_commands`], one in build.rs, and a permission in
//! [`BOARD_PERMISSIONS`] if the page may call it. Nothing else here should need to change.

mod notify;
#[cfg(debug_assertions)]
mod probe;
mod server;
mod tray;
mod update;
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
    // Updates of the app (update.rs). Install takes only the version the page showed and installs the update the
    // app found itself, signed with the release key: the page chooses no URL, file or program. The rest read the
    // state, ask the fixed feed, or keep the page's choices (later, skip, automatic checks) in app.json.
    "allow-update-state",
    "allow-update-check",
    "allow-update-install",
    "allow-update-later",
    "allow-update-skip",
    "allow-update-auto",
    "allow-update-seen",
];

pub fn run() {
    let context = tauri::generate_context!();
    // The updater's settings (endpoints, pubkey) come with the release pipeline; a build without them has no updater.
    let has_feed = context.config().plugins.0.contains_key("updater");
    let builder = tauri::Builder::default();
    // Order matters only for server::init: the single-instance plugin has to be registered first.
    let builder = server::init(builder);
    let builder = notify::init(builder);
    let builder = tray::init(builder);
    let builder = web::init(builder);
    let builder = update::init(builder, has_feed);
    let builder = with_commands(builder);

    builder
        .setup(move |app| {
            let handle = app.handle();
            // Returns at once: the window opens on the bundled fallback page, and server.rs grants the board's
            // capability (grant_board) and navigates to the board once it answers.
            server::setup(handle)?;
            main_window(handle)?;
            tray::setup(handle)?;
            // Without a tray there would be no way to bring a hidden window back.
            if started_hidden() && !tray::is_up() {
                show_main(handle);
            }
            notify::setup(handle)?;
            update::setup(handle, has_feed);
            #[cfg(debug_assertions)]
            probe::start(handle);
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                if window.label() == MAIN {
                    save_size(window.app_handle());
                }
            }
            tray::on_window_event(window, event);
        })
        .build(context)
        .expect("error while building the Workbench app")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { .. } = event {
                save_size(app);
            }
            server::on_run_event(app, &event);
        });
}

/// Every command, in one list (Tauri takes one invoke handler).
fn with_commands<R: Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    #[cfg(debug_assertions)]
    {
        builder.invoke_handler(tauri::generate_handler![
            server::app_info,
            server::retry,
            notify::notify,
            update::update_state,
            update::update_check,
            update::update_install,
            update::update_later,
            update::update_skip,
            update::update_auto,
            update::update_seen,
            probe::probe_result
        ])
    }
    #[cfg(not(debug_assertions))]
    {
        builder.invoke_handler(tauri::generate_handler![
            server::app_info,
            server::retry,
            notify::notify,
            update::update_state,
            update::update_check,
            update::update_install,
            update::update_later,
            update::update_skip,
            update::update_auto,
            update::update_seen
        ])
    }
}

/// Grants [`BOARD_PERMISSIONS`] to the board's exact origin (scheme, host and port), in the main window
/// only. server.rs calls it once, before it first navigates the window to the board. Built at runtime because
/// the port comes from `WB_APP_URL`; there are no static capability files (tauri.conf.json sets
/// `app.security.capabilities` to `[]`).
pub(crate) fn grant_board<R: Runtime>(app: &AppHandle<R>, url: &Url) -> tauri::Result<()> {
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

/// Started by "Start on login" (tray.rs registers the autostart entry with this argument).
pub(crate) const HIDDEN_ARG: &str = "--hidden";

fn started_hidden() -> bool {
    std::env::args().any(|a| a == HIDDEN_ARG)
}

fn main_window<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<WebviewWindow<R>> {
    let (width, height, maximized) = saved_size(app).unwrap_or((1280.0, 860.0, false));
    let builder = WebviewWindowBuilder::new(app, MAIN, WebviewUrl::App("index.html".into()))
        .title("Workbench")
        .inner_size(width, height)
        .maximized(maximized)
        .min_inner_size(MIN_SIZE.0, MIN_SIZE.1)
        // Files dropped on the window go to the page as a normal `drop` event (images on an item's dialog), not to
        // Tauri's own drag-drop events, which would swallow them. A drop the page doesn't take would be a
        // navigation to file://, which web.rs refuses.
        .disable_drag_drop_handler()
        // Start on login runs the app with `--hidden`: only the tray and the server come up; Open shows the window.
        .visible(!started_hidden());
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

const MIN_SIZE: (f64, f64) = (480.0, 400.0);

/// The main window's size (logical pixels) and maximized state from the last run: app.json `window`
/// `{ width, height, maximized }`. Only the size: Wayland doesn't tell or take a window's position.
fn saved_size<R: Runtime>(app: &AppHandle<R>) -> Option<(f64, f64, bool)> {
    let all = server::settings(app);
    let w = all.get("window")?;
    let (width, height) = (w.get("width")?.as_f64()?, w.get("height")?.as_f64()?);
    let ok = |v: f64, min: f64| v.is_finite() && (min..=20_000.0).contains(&v);
    (ok(width, MIN_SIZE.0) && ok(height, MIN_SIZE.1)).then(|| {
        (width, height, w.get("maximized").and_then(|m| m.as_bool()).unwrap_or(false))
    })
}

/// Keeps the main window's size for the next run (on close to tray and on quit). A maximized window keeps the
/// size it had before, so un-maximizing next time goes back to it.
fn save_size<R: Runtime>(app: &AppHandle<R>) {
    let Some(window) = app.get_webview_window(MAIN) else { return };
    let maximized = window.is_maximized().unwrap_or(false);
    let mut value = server::settings(app).get("window").cloned().unwrap_or_else(|| serde_json::json!({}));
    if !maximized {
        // The webview's size, which is what `inner_size` sets: the window's own inner size also counts GTK's
        // client-side decorations on Wayland, so it would grow by those at every run.
        let (Ok(size), Ok(scale)) = (window.as_ref().size(), window.scale_factor()) else { return };
        let size = size.to_logical::<f64>(scale);
        if size.width < MIN_SIZE.0 || size.height < MIN_SIZE.1 {
            return;
        }
        value["width"] = serde_json::json!(size.width.round());
        value["height"] = serde_json::json!(size.height.round());
    }
    value["maximized"] = serde_json::json!(maximized);
    if let Err(e) = server::save_setting(app, "window", value) {
        eprintln!("workbench-app: couldn't keep the window's size: {e}");
    }
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
