//! Desktop notifications for the board page, with click-back.
//!
//! Owner: the "system" agent (phase 2). Phase 1 left a working first version, because the probe needed one.
//!
//! The page calls `notify({ title, body, tag, target })` instead of `new Notification(...)` when it runs in
//! the app. This sends the notification over D-Bus (notify-rust, org.freedesktop.Notifications) with a
//! "default" action. When Kostas clicks it, the window comes to the front and the page gets the event
//! `notification-clicked` with `{ tag, target }`, `target` being whatever the page passed (the board's
//! `openTarget` data, e.g. `{ "item": 12 }`).
//!
//! Left for phase 2:
//! - One D-Bus listener for every notification instead of a thread per notification (each thread waits
//!   until its notification is clicked or closed; GNOME keeps unclicked ones in its list for a long time).
//! - `desktop-entry` hint once the app is installed with a .desktop file (GNOME groups by it).
//! - Raising the window from a click on Wayland: GNOME sends an `ActivationToken` signal just before
//!   `ActionInvoked`; without it `set_focus` may only flag the window as wanting attention.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Builder, Emitter, Manager, Runtime};

/// Event the page gets when a notification is clicked.
pub const CLICKED_EVENT: &str = "notification-clicked";

#[derive(Clone, Serialize)]
pub struct Clicked {
    pub tag: Option<String>,
    pub target: Value,
}

/// The newest notification per tag: (D-Bus id, generation). A notification with a known tag replaces the
/// one on screen, and only the newest one of a tag answers a click.
fn tags() -> &'static Mutex<HashMap<String, (u32, u64)>> {
    static TAGS: OnceLock<Mutex<HashMap<String, (u32, u64)>>> = OnceLock::new();
    TAGS.get_or_init(Default::default)
}
static GENERATION: AtomicU64 = AtomicU64::new(0);
static ICON: OnceLock<Option<PathBuf>> = OnceLock::new();

pub fn init<R: Runtime>(builder: Builder<R>) -> Builder<R> {
    builder
}

/// Writes the app icon where the notification server can read it (it takes a path, not bytes).
pub fn setup<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let path = app.path().app_cache_dir().ok().and_then(|dir| {
        std::fs::create_dir_all(&dir).ok()?;
        let p = dir.join("notification-icon.png");
        std::fs::write(&p, include_bytes!("../icons/128x128.png")).ok()?;
        Some(p)
    });
    let _ = ICON.set(path);
    Ok(())
}

/// The notification server takes body markup (this desktop reports `body-markup`), so a title like
/// "Fix <b> tags" would be swallowed or break the body. The summary is plain text everywhere.
fn escape_markup(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

/// `notify(title, body, tag, target)` → the notification's id. Granted to the board page.
/// async so the D-Bus round trip doesn't run on the main thread.
#[tauri::command]
pub async fn notify<R: Runtime>(
    app: AppHandle<R>,
    title: String,
    body: Option<String>,
    tag: Option<String>,
    target: Option<Value>,
) -> Result<u32, String> {
    let mut n = notify_rust::Notification::new();
    n.appname("Workbench")
        .summary(&title)
        .body(&escape_markup(body.as_deref().unwrap_or("")))
        .action("default", "Open");
    if let Some(Some(icon)) = ICON.get() {
        n.icon(&icon.to_string_lossy());
    }
    let generation = GENERATION.fetch_add(1, Ordering::Relaxed) + 1;
    if let Some(t) = &tag {
        if let Some((id, _)) = tags().lock().unwrap().get(t) {
            n.id(*id);
        }
    }
    let handle = n.show().map_err(|e| e.to_string())?;
    let id = handle.id();
    if let Some(t) = &tag {
        tags().lock().unwrap().insert(t.clone(), (id, generation));
    }
    let target = target.unwrap_or(Value::Null);
    std::thread::spawn(move || {
        handle.wait_for_action(|action| {
            if action != "default" {
                return;
            }
            if let Some(t) = &tag {
                if tags().lock().unwrap().get(t).map(|x| x.1) != Some(generation) {
                    return;
                }
            }
            crate::show_main(&app);
            let _ = app.emit_to(crate::MAIN, CLICKED_EVENT, Clicked { tag, target });
        });
    });
    Ok(id)
}
