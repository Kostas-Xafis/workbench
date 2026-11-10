//! Phase-1 probe: answers "what works in this webview on this desktop" with evidence. Debug builds only
//! (`mod probe` is behind `cfg(debug_assertions)` in lib.rs), and only with `WB_APP_PROBE=1`.
//!
//! It injects probe.js into every frame of the main window, runs a fixed list of steps (Rust drives the
//! window and the desktop, the page reports what it sees), prints one line `WBPROBE-RESULT <json>` to
//! stdout and quits. Kept for the phase-3 review; see "Probe" in src-tauri/README.md for how to run it.
//!
//! Options (env):
//! - `WB_APP_PROBE_STEPS`: comma list of steps (default: all): crypto, clip, webnotif, notify, download,
//!   vis, frame, tray, position. `boot` (IPC, globals, events, no-gesture clipboard) always runs.
//! - `WB_APP_PROBE_PATTERN`: the `remote.urls` pattern granted instead of `<origin>/*`; `none` grants nothing.
//! - `WB_APP_PROBE_NOTIFY_PERM=allow`: answer WebKit's notification permission requests with Allow.
//! - `WB_APP_PROBE_DOWNLOAD=handler`: an `on_download` handler that saves into `<dir>/downloads-handler`.
//! - `WB_APP_PROBE_DIR`: where the probe writes (default /tmp/wb-phase1/probe).
//! - `WB_APP_PROBE_MANUAL=1`: for a person at the screen. No synthetic clicks or forged notification
//!   clicks: the clip step waits 30 s for you to click the orange button (then paste somewhere), the notify
//!   step waits 90 s for you to click the notification, the tray step keeps its icon up for 20 s.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{mpsc, Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::image::Image;
use tauri::ipc::CapabilityBuilder;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::webview::{DownloadEvent, PermissionKind, PermissionResponse};
use tauri::{
    AppHandle, Emitter, LogicalPosition, Manager, Runtime, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};

use crate::MAIN;

const PROBE_JS: &str = include_str!("probe.js");

pub fn enabled() -> bool {
    std::env::var("WB_APP_PROBE").as_deref() == Ok("1")
}

fn opt(name: &str) -> Option<String> {
    std::env::var(format!("WB_APP_PROBE_{name}"))
        .ok()
        .filter(|s| !s.is_empty())
}

fn dir() -> PathBuf {
    opt("DIR").map(PathBuf::from).unwrap_or_else(|| "/tmp/wb-phase1/probe".into())
}

/// The capability pattern to grant instead of the board's exact origin (only while probing).
pub fn pattern_override() -> Option<String> {
    if enabled() {
        opt("PATTERN")
    } else {
        None
    }
}

/// Grants `probe_result` alongside the board's permissions, under the same pattern.
pub fn grant<R: Runtime>(app: &AppHandle<R>, pattern: Option<String>) -> tauri::Result<()> {
    match pattern {
        Some(p) if enabled() => app.add_capability(
            CapabilityBuilder::new("probe")
                .local(false)
                .remote(p)
                .window(MAIN)
                .permission("allow-probe-result"),
        ),
        _ => Ok(()),
    }
}

// ---------- results ----------

#[derive(Default)]
struct Store {
    map: Mutex<(BTreeMap<String, Value>, BTreeMap<String, String>)>,
    cv: Condvar,
}

fn store() -> &'static Store {
    static S: OnceLock<Store> = OnceLock::new();
    S.get_or_init(Store::default)
}

fn put(key: String, value: Value, via: String) {
    // A clipboard write: read what the desktop's clipboard now holds. Never on the main thread, since our
    // own process (the webview) owns the clipboard and has to answer the read.
    let clip = key.starts_with("clip.") && !key.ends_with(".clipboard");
    {
        let mut m = store().map.lock().unwrap();
        m.0.insert(key.clone(), value);
        m.1.insert(key.clone(), via);
    }
    store().cv.notify_all();
    if clip {
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(300));
            let mut v = read_clipboard();
            v["gtk"] = gtk_clipboard();
            put(format!("{key}.clipboard"), v, "rust".into());
        });
    }
}

fn push(key: &str, value: Value) {
    let mut m = store().map.lock().unwrap();
    let e = m.0.entry(key.into()).or_insert_with(|| json!([]));
    if let Some(a) = e.as_array_mut() {
        a.push(value);
    }
    m.1.insert(key.into(), "rust".into());
    drop(m);
    store().cv.notify_all();
}

fn note(key: &str, value: Value) {
    put(key.into(), value, "rust".into());
}

fn wait(key: &str, secs: u64) -> Option<Value> {
    let deadline = Instant::now() + Duration::from_secs(secs);
    let mut m = store().map.lock().unwrap();
    loop {
        if let Some(v) = m.0.get(key) {
            return Some(v.clone());
        }
        let left = deadline.checked_duration_since(Instant::now())?;
        m = store().cv.wait_timeout(m, left).unwrap().0;
    }
}

/// The page's channel to Rust while probing. Debug builds only; granted only under WB_APP_PROBE=1.
#[tauri::command]
pub async fn probe_result(key: String, value: Value) {
    put(key, value, "ipc".into());
}

// ---------- the window ----------

pub fn attach<'a, R: Runtime, M: Manager<R>>(
    builder: WebviewWindowBuilder<'a, R, M>,
) -> WebviewWindowBuilder<'a, R, M> {
    if !enabled() {
        return builder;
    }
    let mut b = builder
        .initialization_script_for_all_frames(PROBE_JS)
        // Fallback channel when IPC is refused: probe.js sets the title to "wbprobe:" + JSON.
        .on_document_title_changed(|_w, title| {
            let Some(raw) = title.strip_prefix("wbprobe:") else { return };
            let Ok(msg) = serde_json::from_str::<Value>(raw) else { return };
            let key = msg["key"].as_str().unwrap_or("?").to_string();
            let via = format!("title (ipc: {})", msg["ipcError"].as_str().unwrap_or("?"));
            put(key, msg["value"].clone(), via);
        });
    if opt("NOTIFY_PERM").as_deref() == Some("allow") {
        b = b.on_permission_request(|_w, kind| {
            push("permission.requests", json!(format!("{kind:?}")));
            match kind {
                PermissionKind::Notifications => PermissionResponse::Allow,
                _ => PermissionResponse::Default,
            }
        });
    }
    if opt("DOWNLOAD").as_deref() == Some("handler") {
        let to = dir().join("downloads-handler");
        b = b.on_download(move |_w, event| {
            match event {
                DownloadEvent::Requested { url, destination } => {
                    let suggested = destination.clone();
                    let name = suggested
                        .file_name()
                        .map(|n| n.to_owned())
                        .unwrap_or_else(|| "download".into());
                    let _ = std::fs::create_dir_all(&to);
                    *destination = to.join(name);
                    push(
                        "download.events",
                        json!({ "event": "requested", "url": url.as_str(), "suggested": suggested, "destination": destination }),
                    );
                }
                DownloadEvent::Finished { url, path, success } => push(
                    "download.events",
                    json!({ "event": "finished", "url": url.as_str(), "path": path, "success": success }),
                ),
                _ => {}
            }
            true
        });
    }
    b
}

fn step<R: Runtime>(w: &WebviewWindow<R>, name: &str, arg: Value) {
    let _ = w.eval(format!("window.__wbProbe && window.__wbProbe.step({}, {arg})", json!(name)));
}

fn sleep(ms: u64) {
    std::thread::sleep(Duration::from_millis(ms));
}

// ---------- desktop helpers ----------

fn sh(cmd: &str, args: &[&str]) -> String {
    match Command::new("timeout").arg("4").arg(cmd).args(args).output() {
        Ok(o) => {
            let mut s: String = String::from_utf8_lossy(&o.stdout).trim().chars().take(4000).collect();
            let e = String::from_utf8_lossy(&o.stderr).trim().to_string();
            if !o.status.success() {
                s = format!("{s} [exit {:?}{}]", o.status.code(), if e.is_empty() { String::new() } else { format!(": {e}") });
            }
            s
        }
        Err(e) => format!("[{cmd}: {e}]"),
    }
}

fn read_clipboard() -> Value {
    json!({
        "wl-paste": sh("wl-paste", &["--no-newline", "--type", "text"]),
        "wl-types": sh("wl-paste", &["--list-types"]),
        "xclip": sh("xclip", &["-o", "-selection", "clipboard", "-t", "UTF8_STRING"]),
    })
}

/// What GTK's clipboard says in our own process (where WebKit writes), read on the main thread. If this
/// has the text but wl-paste doesn't, the compositor refused our selection (no keyboard focus/serial).
fn gtk_clipboard() -> Value {
    let Some(on_main) = ON_MAIN.get() else { return json!("[no app]") };
    let (tx, rx) = mpsc::channel();
    on_main(Box::new(move || {
        #[cfg(target_os = "linux")]
        let text = gtk::Clipboard::get(&gtk::gdk::SELECTION_CLIPBOARD).wait_for_text().map(|s| s.to_string());
        #[cfg(not(target_os = "linux"))]
        let text: Option<String> = None;
        let _ = tx.send(text);
    }));
    json!(rx.recv_timeout(Duration::from_secs(3)).ok().flatten())
}

type OnMain = Box<dyn Fn(Box<dyn FnOnce() + Send>) + Send + Sync>;
static ON_MAIN: OnceLock<OnMain> = OnceLock::new();

/// A synthetic left click on the webview (GDK press + release, sent to the WebKit widget). WebKit handles
/// it like a real one, so the page sees a trusted click with a user gesture.
fn click<R: Runtime>(w: &WebviewWindow<R>, x: f64, y: f64) -> Value {
    let (tx, rx) = mpsc::channel();
    let _ = w.with_webview(move |pw| {
        #[cfg(target_os = "linux")]
        let r = unsafe { gdk_click(&pw.inner(), x, y) };
        #[cfg(not(target_os = "linux"))]
        let r: Result<Value, String> = {
            let _ = pw;
            Err("linux only".into())
        };
        let _ = tx.send(r);
    });
    match rx.recv_timeout(Duration::from_secs(3)) {
        Ok(Ok(v)) => v,
        Ok(Err(e)) => json!({ "error": e }),
        Err(_) => json!({ "error": "timeout" }),
    }
}

#[cfg(target_os = "linux")]
unsafe fn gdk_click(wv: &webkit2gtk::WebView, x: f64, y: f64) -> Result<Value, String> {
    use gtk::gdk::ffi as gdk;
    use gtk::glib::translate::ToGlibPtr;
    use gtk::prelude::*;
    let widget: &gtk::Widget = wv.upcast_ref();
    let window = widget.window().ok_or("no GdkWindow")?;
    let own = widget.has_window();
    let a = widget.allocation();
    let (x, y) = if own { (x, y) } else { (x + a.x() as f64, y + a.y() as f64) };
    let pointer = WidgetExt::display(widget).default_seat().and_then(|s| s.pointer());
    let time = (std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis()
        & 0xffff_ffff) as u32;
    let motion = gdk::gdk_event_new(gdk::GDK_MOTION_NOTIFY);
    {
        let m = &mut (*motion).motion;
        m.window = window.to_glib_full();
        m.time = time;
        m.x = x;
        m.y = y;
    }
    if let Some(p) = &pointer {
        gdk::gdk_event_set_device(motion, p.to_glib_none().0);
    }
    gtk::ffi::gtk_widget_event(widget.to_glib_none().0, motion);
    gdk::gdk_event_free(motion);
    for (ty, state, dt) in [
        (gdk::GDK_BUTTON_PRESS, 0, 0),
        (gdk::GDK_BUTTON_RELEASE, gdk::GDK_BUTTON1_MASK, 60),
    ] {
        let ev = gdk::gdk_event_new(ty);
        {
            let b = &mut (*ev).button;
            b.window = window.to_glib_full();
            b.time = time + dt;
            b.x = x;
            b.y = y;
            b.button = 1;
            b.state = state;
        }
        if let Some(p) = &pointer {
            gdk::gdk_event_set_device(ev, p.to_glib_none().0);
        }
        gtk::ffi::gtk_widget_event(widget.to_glib_none().0, ev);
        gdk::gdk_event_free(ev);
    }
    Ok(json!({ "ownGdkWindow": own, "at": [x, y], "pointer": pointer.is_some() }))
}

/// Watches the session bus for notification traffic (calls, replies, signals) into a file.
fn monitor(path: &PathBuf) -> Option<Child> {
    let out = std::fs::File::create(path).ok()?;
    Command::new("dbus-monitor")
        .args([
            "--session",
            "interface='org.freedesktop.Notifications'",
            "interface='org.gtk.Notifications'",
            "interface='org.freedesktop.portal.Notification'",
            "type='method_return'",
            "type='error'",
        ])
        .stdout(out)
        .stderr(Stdio::null())
        .spawn()
        .ok()
}

/// dbus-monitor's output as (header, body) blocks.
fn blocks(text: &str) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = vec![];
    for line in text.lines() {
        if !line.starts_with(' ') && !line.starts_with('\t') {
            out.push((line.to_string(), String::new()));
        } else if let Some(last) = out.last_mut() {
            last.1.push_str(line.trim());
            last.1.push('\n');
        }
    }
    out
}

fn field<'a>(header: &'a str, name: &str) -> Option<&'a str> {
    header
        .split_whitespace()
        .find_map(|p| p.strip_prefix(&format!("{name}=")))
        .map(|v| v.trim_end_matches(';'))
}

/// Every notification call whose body mentions `needle`, with the server's reply.
fn notification_calls(text: &str, needle: &str) -> Vec<Value> {
    let bs = blocks(text);
    let mut out = vec![];
    for (h, body) in &bs {
        if !h.starts_with("method call") || !body.contains(needle) {
            continue;
        }
        let sender = field(h, "sender").unwrap_or("");
        let serial = field(h, "serial").unwrap_or("");
        let reply = bs.iter().find(|(rh, _)| {
            (rh.starts_with("method return") || rh.starts_with("error"))
                && field(rh, "destination") == Some(sender)
                && field(rh, "reply_serial") == Some(serial)
        });
        let id = reply.and_then(|(_, b)| b.lines().next()?.strip_prefix("uint32 ")?.parse::<u32>().ok());
        out.push(json!({
            "call": h, "body": body.chars().take(1200).collect::<String>(),
            "reply": reply.map(|(rh, rb)| format!("{rh}\n{rb}")), "id": id,
        }));
    }
    out
}

fn fake_click(id: u32) -> String {
    sh(
        "gdbus",
        &[
            "emit", "--session", "--object-path", "/org/freedesktop/Notifications",
            "--signal", "org.freedesktop.Notifications.ActionInvoked", &format!("uint32 {id}"), "'default'",
        ],
    )
}

fn close_notification(id: u32) -> String {
    sh(
        "gdbus",
        &[
            "call", "--session", "--dest", "org.freedesktop.Notifications", "--object-path",
            "/org/freedesktop/Notifications", "--method", "org.freedesktop.Notifications.CloseNotification", &id.to_string(),
        ],
    )
}

fn sni_items() -> String {
    sh(
        "gdbus",
        &[
            "call", "--session", "--dest", "org.kde.StatusNotifierWatcher", "--object-path", "/StatusNotifierWatcher",
            "--method", "org.freedesktop.DBus.Properties.Get", "org.kde.StatusNotifierWatcher", "RegisteredStatusNotifierItems",
        ],
    )
}

/// Properties of one StatusNotifierItem, from an entry like ":1.42/org/ayatana/NotificationItem/x".
fn sni_props(entry: &str) -> String {
    let Some(slash) = entry.find('/') else { return format!("[bad entry {entry}]") };
    let (dest, path) = entry.split_at(slash);
    let dest = dest.trim_end_matches('@');
    sh(
        "gdbus",
        &["call", "--session", "--dest", dest, "--object-path", path, "--method", "org.freedesktop.DBus.Properties.GetAll", "org.kde.StatusNotifierItem"],
    )
}

fn entries(list: &str) -> Vec<String> {
    list.split('\'').skip(1).step_by(2).map(String::from).collect()
}

fn listing(p: &PathBuf) -> Value {
    match std::fs::read_dir(p) {
        Ok(rd) => json!(rd
            .flatten()
            .map(|e| format!("{} ({} bytes)", e.file_name().to_string_lossy(), e.metadata().map(|m| m.len()).unwrap_or(0)))
            .collect::<Vec<_>>()),
        Err(e) => json!(format!("[{}: {e}]", p.display())),
    }
}

/// The 32 px icon with a red dot in its top right corner, as a count badge would sit.
fn badge_icon() -> Option<Image<'static>> {
    let base = Image::from_bytes(include_bytes!("../icons/32x32.png")).ok()?;
    let (w, h) = (base.width(), base.height());
    let mut rgba = base.rgba().to_vec();
    for y in 0..h {
        for x in 0..w {
            let (dx, dy) = (x as i32 - (w as i32 - 9), y as i32 - 9);
            if dx * dx + dy * dy <= 64 {
                let i = ((y * w + x) * 4) as usize;
                rgba[i..i + 4].copy_from_slice(&[220, 38, 38, 255]);
            }
        }
    }
    Some(Image::new_owned(rgba, w, h))
}

// ---------- the run ----------

pub fn start<R: Runtime>(app: &AppHandle<R>) {
    if !enabled() {
        return;
    }
    let app = app.clone();
    let handle = app.clone();
    let _ = ON_MAIN.set(Box::new(move |f| {
        let _ = handle.run_on_main_thread(f);
    }));
    std::thread::spawn(move || {
        let t0 = Instant::now();
        run(&app);
        note("probe.seconds", json!(t0.elapsed().as_secs_f32()));
        let m = store().map.lock().unwrap();
        let out = json!({ "results": m.0, "via": m.1 });
        println!("WBPROBE-RESULT {out}");
        drop(m);
        app.exit(0);
    });
}

fn run<R: Runtime>(app: &AppHandle<R>) {
    let steps = opt("STEPS").unwrap_or_else(|| "all".into());
    let manual = opt("MANUAL").as_deref() == Some("1");
    let want = |s: &str| steps == "all" || steps.split(',').any(|x| x.trim() == s);
    let _ = std::fs::create_dir_all(dir());
    let Some(w) = app.get_webview_window(MAIN) else {
        return note("error", json!("no main window"));
    };
    note("env", json!({
        "WB_APP_URL": std::env::var("WB_APP_URL").ok(), "pattern": opt("PATTERN"), "steps": steps,
        "notifyPerm": opt("NOTIFY_PERM"), "download": opt("DOWNLOAD"),
        "XDG_SESSION_TYPE": std::env::var("XDG_SESSION_TYPE").ok(), "GDK_BACKEND": std::env::var("GDK_BACKEND").ok(),
    }));
    if wait("boot.done", 40).is_none() {
        note("error.boot", json!("boot.done never came"));
        return;
    }

    if want("crypto") {
        step(&w, "crypto", Value::Null);
        wait("crypto", 60);
    }

    if want("clip") {
        step(&w, "evalClip", Value::Null);
        wait("clip.eval.writeText.clipboard", 8);
        if manual {
            step(&w, "target", json!("boardCopy"));
            wait("clip.click.boardCopy.clipboard", 30);
        } else {
            for mode in ["writeText", "execCommand", "boardCopy"] {
                step(&w, "target", json!(mode));
                wait(&format!("target.{mode}"), 5);
                sleep(300);
                let focused = w.is_focused().ok();
                let mut c = click(&w, 100.0, 40.0);
                c["windowFocusedBefore"] = json!(focused);
                note(&format!("click.{mode}"), c);
                wait(&format!("clip.click.{mode}.clipboard"), 8);
            }
        }
        step(&w, "untarget", Value::Null);
    }

    let mon_path = dir().join("dbus-monitor.txt");
    let mut mon = if want("webnotif") || want("notify") { monitor(&mon_path) } else { None };
    sleep(500);

    if want("webnotif") {
        step(&w, "target", json!("notifPerm"));
        wait("target.notifPerm", 5);
        sleep(300);
        note("click.notifPerm", click(&w, 100.0, 40.0));
        wait("webnotif.click", 6);
        step(&w, "untarget", Value::Null);
        step(&w, "webNotification", Value::Null);
        wait("webnotif.construct", 5);
        sleep(2000);
        let text = std::fs::read_to_string(&mon_path).unwrap_or_default();
        let calls = notification_calls(&text, "wbprobe web");
        let id = calls.iter().find_map(|c| c["id"].as_u64()).map(|i| i as u32);
        note("webnotif.dbus", json!(calls));
        if let Some(id) = id {
            note("webnotif.fakeClick", json!(fake_click(id)));
            wait("webnotif.onclick", 4);
            note("webnotif.close", json!(close_notification(id)));
        }
        step(&w, "closeWebNotification", Value::Null);
    }

    if want("notify") {
        // Hidden first, so the click has to bring the window back.
        let _ = w.hide();
        sleep(500);
        step(&w, "notify", Value::Null);
        let id = wait("notify.invoke", 6).and_then(|v| v["ok"].as_u64()).map(|i| i as u32);
        sleep(1500);
        let text = std::fs::read_to_string(&mon_path).unwrap_or_default();
        note("notify.dbus", json!(notification_calls(&text, "Workbench probe")));
        if let Some(id) = id {
            let got = if manual {
                wait("event.notification-clicked", 90)
            } else {
                note("notify.fakeClick", json!(fake_click(id)));
                wait("event.notification-clicked", 6)
            };
            sleep(500);
            note("notify.afterClick", json!({
                "eventReceived": got.is_some(), "visible": w.is_visible().ok(), "focused": w.is_focused().ok(),
                "minimized": w.is_minimized().ok(),
            }));
            note("notify.close", json!(close_notification(id)));
        }
        let _ = w.show();
        // The same event straight from Rust, to separate "event path works" from "D-Bus click arrives".
        let _ = app.emit_to(MAIN, "wbprobe-ping", json!({ "from": "rust" }));
        wait("event.wbprobe-ping", 3);
        sleep(500);
    }
    if let Some(m) = mon.as_mut() {
        let _ = m.kill();
        let _ = m.wait();
    }

    if want("download") {
        let xdg = sh("xdg-user-dir", &["DOWNLOAD"]);
        let before = listing(&PathBuf::from(&xdg));
        for what in ["backup", "export", "blob"] {
            step(&w, "download", json!(what));
            wait(&format!("download.{what}"), 6);
            sleep(2500);
        }
        note("download.dirs", json!({
            "xdgDownloadDir": xdg, "xdgBefore": before, "xdgAfter": listing(&PathBuf::from(&xdg)),
            "handlerDir": listing(&dir().join("downloads-handler")),
        }));
    }

    if want("vis") {
        let _ = w.show();
        let _ = w.set_focus();
        sleep(800);
        let state = |label: &str| {
            step(&w, "vis", json!(label));
            wait(&format!("vis.{label}"), 4);
            note(&format!("vis.{label}.rust"), json!({
                "isFocused": w.is_focused().ok(), "isVisible": w.is_visible().ok(), "isMinimized": w.is_minimized().ok(),
            }));
        };
        state("start");
        let _ = w.hide();
        sleep(1500);
        state("hidden");
        let _ = w.show();
        let _ = w.set_focus();
        sleep(1200);
        state("shownAgain");
        let _ = w.minimize();
        sleep(1500);
        state("minimized");
        let _ = w.unminimize();
        let _ = w.set_focus();
        sleep(1200);
        state("unminimized");
        match WebviewWindowBuilder::new(app, "probe-front", WebviewUrl::External("about:blank".parse().unwrap()))
            .title("Workbench probe: window in front")
            .inner_size(700.0, 500.0)
            .focused(true)
            .build()
        {
            Ok(front) => {
                let _ = front.set_focus();
                sleep(1500);
                state("behindOther");
                note("vis.behindOther.front", json!({ "frontFocused": front.is_focused().ok() }));
                let _ = front.close();
                sleep(1200);
                state("otherClosed");
            }
            Err(e) => note("vis.behindOther", json!({ "error": e.to_string() })),
        }
    }

    if want("frame") {
        let _ = w.show();
        step(&w, "report", Value::Null);
        if wait("frame.opened", 6).is_some() {
            wait("frame.bridge", 10);
            sleep(500);
        }
        step(&w, "ipcAgain", json!("withHash"));
        wait("ipc.app_info.withHash", 4);
    }

    if want("tray") {
        let before = sni_items();
        let menu = Menu::with_items(app, &[&MenuItem::with_id(app, "probe-open", "Open", true, None::<&str>).unwrap()]).ok();
        let mut tb = TrayIconBuilder::with_id("probe")
            .icon(Image::from_bytes(include_bytes!("../icons/32x32.png")).unwrap())
            .tooltip("Workbench probe");
        if let Some(m) = &menu {
            tb = tb.menu(m);
        }
        match tb.build(app) {
            Ok(tray) => {
                sleep(1500);
                let after = sni_items();
                let new: Vec<String> = entries(&after).into_iter().filter(|e| !entries(&before).contains(e)).collect();
                let props = new.first().map(|e| sni_props(e));
                let swapped = tray.set_icon(badge_icon()).map_err(|e| e.to_string());
                sleep(1000);
                let props2 = new.first().map(|e| sni_props(e));
                if manual {
                    sleep(20_000);
                }
                note("tray", json!({
                    "watcherBefore": before, "watcherAfter": after, "newItems": new,
                    "props": props, "setIcon": format!("{swapped:?}"), "propsAfterSwap": props2,
                    "iconChanged": props.is_some() && props != props2,
                }));
                let _ = app.remove_tray_by_id("probe");
            }
            Err(e) => note("tray", json!({ "error": e.to_string(), "watcher": before })),
        }
    }

    if want("position") {
        let before = w.outer_position().map(|p| (p.x, p.y)).map_err(|e| e.to_string());
        let set = w.set_position(LogicalPosition::new(120.0, 120.0)).map_err(|e| e.to_string());
        sleep(1000);
        let after = w.outer_position().map(|p| (p.x, p.y)).map_err(|e| e.to_string());
        note("position", json!({
            "before": format!("{before:?}"), "set": format!("{set:?}"), "after": format!("{after:?}"),
            "innerSize": format!("{:?}", w.inner_size().ok()), "scale": w.scale_factor().ok(),
        }));
    }
}
