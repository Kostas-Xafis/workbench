//! Desktop notifications for the board page, with click-back.
//!
//! Owner: the "system" agent.
//!
//! The page calls `notify({ title, body, tag, target })` instead of `new Notification(...)` when it runs in
//! the app. This sends the notification over D-Bus (org.freedesktop.Notifications.Notify) with a "default"
//! action. When Kostas clicks it, the window comes to the front and the page gets the event
//! `notification-clicked` with `{ tag, target }`, `target` being whatever the page passed (the board's
//! `openTarget` data, e.g. `{ "item": 12 }`).
//!
//! One connection does both: the call and the listening. [`setup`] (main thread) subscribes once to the
//! server's signals on the session bus, through GIO, so they are delivered by GTK's own main loop: no thread
//! per notification, nothing that waits for a click that never comes.
//! - `ActivationToken(id, token)`: GNOME sends it just before the click. On Wayland the token is what lets
//!   the window be raised instead of only flagged as wanting attention (see [`raise`]).
//! - `ActionInvoked(id, "default")`: the click. Answered once, for the id we know.
//! - `NotificationClosed(id, reason)`: closed, dismissed or expired. The entry for `id` goes.
//!
//! A notification with the same `tag` as one still known is sent with `replaces_id` set to the old one's id,
//! so the server swaps it in place; the entry (and so the `target`) is the newest one's. The table is also
//! capped, for a server that never says "closed".

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Builder, Emitter, Manager, Runtime};

/// Event the page gets when a notification is clicked.
pub const CLICKED_EVENT: &str = "notification-clicked";

/// How many notifications we remember a click target for. Far more than are ever on screen.
const MAX_KNOWN: usize = 100;
/// Longer titles and bodies are cut (characters, with an ellipsis); the board's are far shorter.
const MAX_TITLE: usize = 200;
const MAX_BODY: usize = 2000;
/// A `target` bigger than this, as JSON, is refused: the board's are `{ "item": 12 }`.
const MAX_TARGET: usize = 4096;
/// The .desktop file's name (Workbench.desktop), for the desktop to put the notification under the app.
const DESKTOP_ENTRY: &str = "Workbench";

#[derive(Clone, Serialize)]
pub struct Clicked {
    pub tag: Option<String>,
    pub target: Value,
}

struct Entry {
    tag: Option<String>,
    target: Value,
    /// Order of sending, to drop the oldest when the table is full.
    generation: u64,
}

#[derive(Default)]
struct Known {
    /// D-Bus notification id → what a click on it means.
    by_id: HashMap<u32, Entry>,
    /// tag → the id of the newest notification with it.
    by_tag: HashMap<String, u32>,
    /// id → activation token announced for it, used by the click that follows.
    tokens: HashMap<u32, String>,
}

impl Known {
    fn forget(&mut self, id: u32) {
        if let Some(e) = self.by_id.remove(&id) {
            if let Some(t) = e.tag {
                if self.by_tag.get(&t) == Some(&id) {
                    self.by_tag.remove(&t);
                }
            }
        }
        self.tokens.remove(&id);
    }

    fn remember(&mut self, id: u32, entry: Entry) {
        // The server gave a new id for a tag (the old one was gone): the old entry can't be clicked any more.
        if let Some(t) = &entry.tag {
            if let Some(old) = self.by_tag.get(t).copied() {
                if old != id {
                    self.forget(old);
                }
            }
            self.by_tag.insert(t.clone(), id);
        }
        self.by_id.insert(id, entry);
        while self.by_id.len() > MAX_KNOWN {
            let Some(oldest) = self.by_id.iter().min_by_key(|(_, e)| e.generation).map(|(id, _)| *id) else {
                break;
            };
            self.forget(oldest);
        }
        self.tokens.retain(|id, _| self.by_id.contains_key(id));
    }
}

fn known() -> &'static Mutex<Known> {
    static K: OnceLock<Mutex<Known>> = OnceLock::new();
    K.get_or_init(Default::default)
}
static GENERATION: AtomicU64 = AtomicU64::new(0);
static ICON: OnceLock<Option<PathBuf>> = OnceLock::new();

pub fn init<R: Runtime>(builder: Builder<R>) -> Builder<R> {
    builder
}

/// Writes the app icon where the notification server can read it (it takes a path, not bytes), and starts
/// listening for clicks. Runs on the main thread (Tauri's setup), which is where the signals are delivered.
pub fn setup<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let path = app.path().app_cache_dir().ok().and_then(|dir| {
        std::fs::create_dir_all(&dir).ok()?;
        let p = dir.join("notification-icon.png");
        std::fs::write(&p, include_bytes!("../icons/128x128.png")).ok()?;
        Some(p)
    });
    let _ = ICON.set(path);
    #[cfg(target_os = "linux")]
    dbus::listen(app);
    Ok(())
}

/// Brings the board's window to the front for a click. `token` is the activation token the notification
/// server announced for it, if any. GNOME on Wayland only raises a window for a request that carries a
/// token (`set_focus` alone just flags it); GTK takes the token through `set_startup_id` and presents the
/// window with it.
pub(crate) fn raise<R: Runtime>(app: &AppHandle<R>, token: Option<&str>) {
    #[cfg(target_os = "linux")]
    if let (Some(token), Some(w)) = (token, app.get_webview_window(crate::MAIN)) {
        use gtk::prelude::GtkWindowExt;
        if let Ok(gw) = w.gtk_window() {
            let _ = w.unminimize();
            let _ = w.show();
            gw.set_startup_id(token);
            gw.present();
            return;
        }
    }
    let _ = token;
    crate::show_main(app);
}

/// The notification server takes body markup (this desktop reports `body-markup`), so a title like
/// "Fix <b> tags" would be swallowed or break the body. The summary is plain text everywhere.
fn escape_markup(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

/// `s` cut to `max` characters, the last one an ellipsis when it was longer.
fn cap(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let mut out: String = s.chars().take(max.saturating_sub(1)).collect();
    out.push('…');
    out
}

/// What a click does: window to the front, then the page hears `{ tag, target }`.
fn clicked<R: Runtime>(app: &AppHandle<R>, id: u32) {
    let (entry, token) = {
        let mut k = known().lock().unwrap();
        let token = k.tokens.remove(&id);
        match k.by_id.get(&id) {
            Some(e) => (Clicked { tag: e.tag.clone(), target: e.target.clone() }, token),
            None => return,
        }
    };
    raise(app, token.as_deref());
    let _ = app.emit_to(crate::MAIN, CLICKED_EVENT, entry);
}

/// `notify(title, body, tag, target)` → the notification's id. Granted to the board page.
/// async so the D-Bus round trip doesn't run on the main thread.
#[tauri::command]
pub async fn notify<R: Runtime>(
    _app: AppHandle<R>,
    title: String,
    body: Option<String>,
    tag: Option<String>,
    target: Option<Value>,
) -> Result<u32, String> {
    let title = cap(&title, MAX_TITLE);
    let body = body.map(|b| cap(&b, MAX_BODY));
    if let Some(t) = &target {
        let size = serde_json::to_string(t).map_or(usize::MAX, |j| j.len());
        if size > MAX_TARGET {
            return Err(format!("notify: target is {size} bytes as JSON, more than {MAX_TARGET}"));
        }
    }
    #[cfg(target_os = "linux")]
    {
        let replaces = tag.as_ref().and_then(|t| known().lock().unwrap().by_tag.get(t).copied()).unwrap_or(0);
        let icon = ICON.get().cloned().flatten().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default();
        let id = dbus::send(&title, &escape_markup(body.as_deref().unwrap_or("")), &icon, replaces)?;
        let generation = GENERATION.fetch_add(1, Ordering::Relaxed) + 1;
        known().lock().unwrap().remember(id, Entry { tag, target: target.unwrap_or(Value::Null), generation });
        Ok(id)
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (title, body, tag, target, escape_markup(""), &GENERATION, DESKTOP_ENTRY);
        Err("notifications are only implemented on Linux".into())
    }
}

#[cfg(target_os = "linux")]
mod dbus {
    use gtk::gio::{self, BusType, Cancellable, DBusCallFlags, DBusSignalFlags};
    use gtk::glib::{ToVariant, Variant, VariantTy};
    use std::collections::HashMap;
    use tauri::{AppHandle, Runtime};

    const NAME: &str = "org.freedesktop.Notifications";
    const PATH: &str = "/org/freedesktop/Notifications";

    fn connection() -> Result<gio::DBusConnection, String> {
        gio::bus_get_sync(BusType::Session, Cancellable::NONE).map_err(|e| e.to_string())
    }

    /// Notify(app_name, replaces_id, icon, summary, body, actions, hints, timeout) → id. Blocking, short.
    pub fn send(title: &str, body: &str, icon: &str, replaces: u32) -> Result<u32, String> {
        let actions = vec!["default".to_string(), "Open".to_string()];
        let hints: HashMap<String, Variant> = HashMap::from([("desktop-entry".to_string(), super::DESKTOP_ENTRY.to_variant())]);
        let params = ("Workbench", replaces, icon, title, body, actions, hints, -1i32).to_variant();
        let reply = connection()?
            .call_sync(
                Some(NAME),
                PATH,
                NAME,
                "Notify",
                Some(&params),
                Some(VariantTy::new("(u)").map_err(|e| e.to_string())?),
                DBusCallFlags::NONE,
                5000,
                Cancellable::NONE,
            )
            .map_err(|e| e.to_string())?;
        reply.child_value(0).get::<u32>().ok_or_else(|| "no notification id in the reply".to_string())
    }

    /// Subscribes to the server's signals. No sender filter: a signal from any sender is only acted on for
    /// an id we handed out, and the notification server isn't always the well-known name's owner when a
    /// test forges a click with gdbus.
    pub fn listen<R: Runtime>(app: &AppHandle<R>) {
        let conn = match connection() {
            Ok(c) => c,
            Err(e) => return eprintln!("notify: no session bus, clicks won't come back: {e}"),
        };
        let app = app.clone();
        // Never unsubscribed: it lives as long as the process.
        let _ = conn.signal_subscribe(
            None,
            Some(NAME),
            None,
            Some(PATH),
            None,
            DBusSignalFlags::NONE,
            move |_conn, _sender, _path, _iface, signal, params| {
                let id = params.child_value(0).get::<u32>();
                let Some(id) = id else { return };
                match signal {
                    "ActivationToken" => {
                        if let Some(token) = params.child_value(1).get::<String>() {
                            let mut k = super::known().lock().unwrap();
                            if k.by_id.contains_key(&id) {
                                k.tokens.insert(id, token);
                            }
                        }
                    }
                    "ActionInvoked" => {
                        if params.child_value(1).get::<String>().as_deref() == Some("default") {
                            super::clicked(&app, id);
                        }
                    }
                    "NotificationClosed" => super::known().lock().unwrap().forget(id),
                    _ => {}
                }
            },
        );
    }
}

#[cfg(test)]
mod tests {
    use super::cap;

    #[test]
    fn cap_cuts_on_characters_with_an_ellipsis() {
        assert_eq!(cap("short", 200), "short");
        assert_eq!(cap(&"x".repeat(200), 200), "x".repeat(200));
        let cut = cap(&"é".repeat(250), 200);
        assert_eq!(cut.chars().count(), 200);
        assert!(cut.ends_with("é…"));
    }
}
