//! Tray icon, its count, and window-close behaviour.
//!
//! Owner: the "system" agent.
//! - The tray icon (libayatana-appindicator on Linux, which reports no clicks, only menu items) shows the
//!   board's icon, with the count of what waits on Kostas drawn into it (red dot, the number, `9+` above 9).
//!   There's no badge API, so [`icon_with_count`] paints the PNG and `TrayIcon::set_icon` swaps it.
//! - Menu: Open board / "Needs you: N" (a disabled line) / "Update to 0.2.0…" (only while update.rs has one to
//!   offer; opens the board's update dialog) / Start on login / Phone access (owned server only) / Quit.
//! - The count is polled from `GET <board>/api/projects` every 30 s: the sum of `mine` over the projects
//!   whose `archived_at` is null. The page's own poll pauses while the window is hidden; this one doesn't.
//! - Close to tray: `CloseRequested` on the main window hides it. Quit is in the menu and exits for real.
//! - The board's setup guide reads and sets Start on login with [`autostart`], the same switch as the menu's.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use tauri::image::Image;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{TrayIcon, TrayIconBuilder};
use tauri::{AppHandle, Builder, Manager, Runtime, Window, WindowEvent};
use tauri_plugin_autostart::ManagerExt;

const TRAY_ID: &str = "workbench";
const OPEN: &str = "open";
const AUTOSTART: &str = "autostart";
const LAN: &str = "lan";
const QUIT: &str = "quit";
const UPDATE: &str = "update";

/// How often the board is asked for the count.
const POLL: Duration = Duration::from_secs(30);
/// How soon to try again when the board didn't answer (it may still be starting).
const RETRY: Duration = Duration::from_secs(5);

/// Set once the tray icon exists. Without one, closing the window must really close it: nothing could
/// bring a hidden window back.
static TRAY_UP: AtomicBool = AtomicBool::new(false);

/// Builder-time setup: the autostart plugin, for "Start on login". It is not granted to the page (the
/// board's capability lists only what lib.rs gives it); only this module calls it.
pub fn init<R: Runtime>(builder: Builder<R>) -> Builder<R> {
    builder.plugin(
        tauri_plugin_autostart::Builder::new()
            // A nightly has its own login entry, so trying it never replaces the installed app's.
            .app_name(if crate::NIGHTLY { "Workbench Nightly" } else { "Workbench" })
            // Opens hidden in the tray (lib.rs `started_hidden`).
            .args([crate::HIDDEN_ARG])
            .build(),
    )
}

/// Whether the tray icon exists (see `TRAY_UP`).
pub fn is_up() -> bool {
    TRAY_UP.load(Ordering::Relaxed)
}

/// The menu and its "Update to …" line, which [`set_update`] puts in and takes out (a menu item can't be hidden).
struct UpdateLine<R: Runtime> {
    menu: Menu<R>,
    item: MenuItem<R>,
    shown: std::sync::Mutex<Option<String>>,
}

/// Shows "Update to <version>…" in the menu (under the count), or takes it out with `None`. Any thread.
pub fn set_update<R: Runtime>(app: &AppHandle<R>, version: Option<String>) {
    let Some(line) = app.try_state::<UpdateLine<R>>() else { return };
    let mut shown = line.shown.lock().unwrap_or_else(|e| e.into_inner());
    if *shown == version {
        return;
    }
    *shown = version.clone();
    let (menu, item) = (line.menu.clone(), line.item.clone());
    let _ = app.run_on_main_thread(move || {
        let _ = menu.remove(&item);
        if let Some(v) = version {
            let _ = item.set_text(format!("Update to {v}…"));
            // After "Open board" and the count.
            let _ = menu.insert(&item, 2);
        }
    });
}

/// The menu's "Start on login" item, so [`autostart`] can make it show what the page set.
struct AutostartItem<R: Runtime>(CheckMenuItem<R>);

#[derive(serde::Serialize)]
pub struct Autostart {
    enabled: bool,
}

/// `autostart` → `{ enabled }`; with `{ on: true | false }` it first turns the app's own login entry on or off,
/// like the tray's "Start on login" (whose tick follows). Granted to the board page, for the setup guide: it only
/// switches this one entry, which always starts this app hidden in the tray.
#[tauri::command]
pub fn autostart<R: Runtime>(app: AppHandle<R>, on: Option<bool>) -> Result<Autostart, String> {
    let manager = app.autolaunch();
    if let Some(want) = on {
        let result = if want { manager.enable() } else { manager.disable() };
        result.map_err(|e| e.to_string())?;
    }
    let enabled = manager.is_enabled().map_err(|e| e.to_string())?;
    if on.is_some() {
        if let Some(item) = app.try_state::<AutostartItem<R>>() {
            let item = item.0.clone();
            let _ = app.run_on_main_thread(move || {
                let _ = item.set_checked(enabled);
            });
        }
    }
    Ok(Autostart { enabled })
}

/// The pieces the poller updates.
struct Parts<R: Runtime> {
    tray: TrayIcon<R>,
    needs: MenuItem<R>,
    lan: CheckMenuItem<R>,
}

/// Creates the tray icon and its menu, and starts polling the count. Runs in Tauri's setup, after the main
/// window exists. A failure to make the tray (no appindicator host) isn't fatal: the app just has no tray.
pub fn setup<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    match build(app) {
        Ok(parts) => {
            TRAY_UP.store(true, Ordering::Relaxed);
            let app = app.clone();
            std::thread::spawn(move || poll_loop(app, parts));
        }
        Err(e) => eprintln!("tray: no tray icon: {e}"),
    }
    Ok(())
}

fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Parts<R>> {
    let open = MenuItem::with_id(app, OPEN, "Open board", true, None::<&str>)?;
    let needs = MenuItem::with_id(app, "needs", needs_text(Some(0)), false, None::<&str>)?;
    let autostart = CheckMenuItem::with_id(
        app,
        AUTOSTART,
        "Start on login",
        true,
        app.autolaunch().is_enabled().unwrap_or(false),
        None::<&str>,
    )?;
    // Always there; enabled only while this app owns the server (an attached one has its own launcher).
    // Ownership is settled after the window shows, so [`refresh_lan`] keeps it current.
    let lan = CheckMenuItem::with_id(
        app,
        LAN,
        "Phone access (on my network)",
        crate::server::is_owned(app),
        crate::server::lan_enabled(app),
        None::<&str>,
    )?;
    let quit = MenuItem::with_id(app, QUIT, "Quit", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let mut items: Vec<&dyn tauri::menu::IsMenuItem<R>> = vec![&open, &needs, &sep, &autostart];
    items.push(&lan);
    items.push(&sep);
    items.push(&quit);
    let menu = Menu::with_items(app, &items)?;
    app.manage(AutostartItem(autostart.clone()));
    let update = MenuItem::with_id(app, UPDATE, "Update…", true, None::<&str>)?;
    app.manage(UpdateLine { menu: menu.clone(), item: update, shown: std::sync::Mutex::new(None) });

    let tray = TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon_with_count(0))
        .tooltip("Workbench")
        .menu(&menu)
        .on_menu_event({
            let autostart = autostart.clone();
            let lan = lan.clone();
            move |app, event| match event.id().as_ref() {
                OPEN => {
                    crate::show_main(app);
                    refresh_lan(app, &lan);
                }
                UPDATE => crate::update::open_dialog(app),
                AUTOSTART => toggle_autostart(app, &autostart),
                LAN => toggle_lan(app, &lan),
                QUIT => app.exit(0),
                _ => {}
            }
        })
        .build(app)?;
    Ok(Parts { tray, needs, lan })
}

/// Flips what's really on disk (not the check item's own state: it isn't reliably updated yet when the
/// click event arrives), then makes the item show it.
fn toggle_autostart<R: Runtime>(app: &AppHandle<R>, item: &CheckMenuItem<R>) {
    let manager = app.autolaunch();
    let want = !manager.is_enabled().unwrap_or(false);
    let result = if want { manager.enable() } else { manager.disable() };
    if let Err(e) = result {
        eprintln!("tray: start on login: {e}");
    }
    let _ = item.set_checked(manager.is_enabled().unwrap_or(false));
}

/// Restarting the server can take seconds: off the menu's thread. On an Err (an attached server, or the
/// restart failed) the box goes back to what the server really does.
fn toggle_lan<R: Runtime>(app: &AppHandle<R>, item: &CheckMenuItem<R>) {
    let want = !crate::server::lan_enabled(app);
    let (app, item) = (app.clone(), item.clone());
    std::thread::spawn(move || {
        match crate::server::set_lan(&app, want) {
            // set_lan returns before the restart: wait until the new server runs (or 20 s), or the box would show
            // the old state until the next poll, up to 30 s later.
            Ok(()) => {
                let until = std::time::Instant::now() + Duration::from_secs(20);
                while crate::server::lan_enabled(&app) != want
                    && crate::server::is_owned(&app)
                    && std::time::Instant::now() < until
                {
                    std::thread::sleep(Duration::from_millis(200));
                }
            }
            Err(e) => eprintln!("tray: phone access: {e}"),
        }
        refresh_lan(&app, &item);
    });
}

/// Enabled and checked as the server is right now (owned, started with --lan). Any thread.
fn refresh_lan<R: Runtime>(app: &AppHandle<R>, item: &CheckMenuItem<R>) {
    let (owned, on) = (crate::server::is_owned(app), crate::server::lan_enabled(app));
    let item = item.clone();
    let _ = app.run_on_main_thread(move || {
        let _ = item.set_enabled(owned);
        let _ = item.set_checked(on);
    });
}

fn poll_loop<R: Runtime>(app: AppHandle<R>, parts: Parts<R>) {
    let mut shown: Option<Option<u32>> = None;
    loop {
        let count = fetch_count(&app);
        refresh_lan(&app, &parts.lan);
        if shown != Some(count) {
            shown = Some(count);
            update(&app, &parts, count);
        }
        std::thread::sleep(if count.is_some() { POLL } else { RETRY });
    }
}

/// Puts the count in the menu line and the icon. `None`: the board didn't answer.
fn update<R: Runtime>(app: &AppHandle<R>, parts: &Parts<R>, count: Option<u32>) {
    let (tray, needs) = (parts.tray.clone(), parts.needs.clone());
    let _ = app.run_on_main_thread(move || {
        let _ = needs.set_text(needs_text(count));
        let _ = tray.set_icon(Some(icon_with_count(count.unwrap_or(0))));
        let _ = tray.set_tooltip(Some(match count {
            Some(n) if n > 0 => format!("Workbench: {n} wait on you"),
            _ => "Workbench".to_string(),
        }));
    });
}

fn needs_text(count: Option<u32>) -> String {
    match count {
        None => "Board not reachable".to_string(),
        Some(0) => "Nothing waits on you".to_string(),
        Some(n) => format!("Needs you: {n}"),
    }
}

/// Sum of `mine` over the projects that aren't archived (the badges on the board's left edge).
fn fetch_count<R: Runtime>(app: &AppHandle<R>) -> Option<u32> {
    let url = crate::server::board_url(app).join("/api/projects").ok()?;
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(5)))
        .build()
        .into();
    let body = agent.get(url.as_str()).call().ok()?.body_mut().read_to_string().ok()?;
    let projects: serde_json::Value = serde_json::from_str(&body).ok()?;
    let sum = projects
        .as_array()?
        .iter()
        .filter(|p| p["archived_at"].is_null())
        .map(|p| p["mine"].as_u64().unwrap_or(0))
        .sum::<u64>();
    Some(sum.min(u32::MAX as u64) as u32)
}

/// Window events of every window: closing the main one hides it (close to tray).
pub fn on_window_event<R: Runtime>(window: &Window<R>, event: &WindowEvent) {
    if let WindowEvent::CloseRequested { api, .. } = event {
        if window.label() == crate::MAIN && TRAY_UP.load(Ordering::Relaxed) {
            api.prevent_close();
            let _ = window.hide();
        }
    }
}

// ---------- the icon ----------

/// The board's icon with the count on it: a red dot in the top right corner with the number in white,
/// `9+` above 9, nothing for 0.
fn icon_with_count(count: u32) -> Image<'static> {
    let png: &[u8] = if crate::NIGHTLY { include_bytes!("../icons/nightly/128x128.png") } else { include_bytes!("../icons/128x128.png") };
    let base = Image::from_bytes(png).expect("the app icon is a PNG");
    let (w, h) = (base.width(), base.height());
    let mut rgba = base.rgba().to_vec();
    if count > 0 {
        paint_badge(&mut rgba, w, h, count);
    }
    Image::new_owned(rgba, w, h)
}

/// 3 × 5 pixel digits and `+`, one string of 15 cells per glyph, row by row.
const GLYPHS: [&str; 11] = [
    "111101101101111", // 0
    "010110010010111", // 1
    "111001111100111", // 2
    "111001111001111", // 3
    "101101111001001", // 4
    "111100111001111", // 5
    "111100111101111", // 6
    "111001001001001", // 7
    "111101111101111", // 8
    "111101111001111", // 9
    "000010111010000", // +
];

fn paint_badge(rgba: &mut [u8], w: u32, h: u32, count: u32) {
    let s = (w as f32 / 16.0).round().max(1.0) as i32; // pixel size of the digits
    let radius = w as f32 * 0.28;
    let (cx, cy) = (w as f32 - radius - 1.0, radius + 1.0);
    // Anti-aliased disc: 4 × 4 samples per pixel.
    for y in 0..h as i32 {
        for x in 0..w as i32 {
            let mut inside = 0;
            for sy in 0..4 {
                for sx in 0..4 {
                    let (px, py) = (x as f32 + (sx as f32 + 0.5) / 4.0, y as f32 + (sy as f32 + 0.5) / 4.0);
                    if (px - cx).powi(2) + (py - cy).powi(2) <= radius * radius {
                        inside += 1;
                    }
                }
            }
            if inside > 0 {
                blend(rgba, w, x, y, [220, 38, 38], inside as f32 / 16.0);
            }
        }
    }
    let glyphs: Vec<usize> = if count > 9 { vec![9, 10] } else { vec![count as usize] };
    let text_w = glyphs.len() as i32 * 3 * s + (glyphs.len() as i32 - 1) * s;
    let (x0, y0) = (cx.round() as i32 - text_w / 2, cy.round() as i32 - 5 * s / 2);
    for (gi, g) in glyphs.iter().enumerate() {
        for (i, cell) in GLYPHS[*g].bytes().enumerate() {
            if cell != b'1' {
                continue;
            }
            let (col, row) = ((i % 3) as i32, (i / 3) as i32);
            for dy in 0..s {
                for dx in 0..s {
                    let (x, y) = (x0 + gi as i32 * 4 * s + col * s + dx, y0 + row * s + dy);
                    blend(rgba, w, x, y, [255, 255, 255], 1.0);
                }
            }
        }
    }
}

/// Mixes `color` over the pixel at (x, y) with `alpha`; the pixel's own alpha takes the larger.
fn blend(rgba: &mut [u8], w: u32, x: i32, y: i32, color: [u8; 3], alpha: f32) {
    if x < 0 || y < 0 || x >= w as i32 {
        return;
    }
    let i = ((y as u32 * w + x as u32) * 4) as usize;
    if i + 3 >= rgba.len() {
        return;
    }
    for c in 0..3 {
        rgba[i + c] = (rgba[i + c] as f32 * (1.0 - alpha) + color[c] as f32 * alpha).round() as u8;
    }
    rgba[i + 3] = rgba[i + 3].max((alpha * 255.0).round() as u8);
}
