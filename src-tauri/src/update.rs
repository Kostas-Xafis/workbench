//! Updates of the app itself, with tauri-plugin-updater: check, offer, and install only when asked.
//!
//! - The feed is the updater's `latest.json` (tauri.conf.json `plugins.updater`: endpoints and pubkey, owned by
//!   the release pipeline). A build without that block has no updater: Settings → Updates says so.
//! - Checked 15 s after launch and then every [`EVERY`], while automatic checks are on (app.json
//!   `updates.auto`, on by default). "Check now" in Settings checks whatever the setting. Nothing is ever
//!   downloaded or installed without the page's (or the tray's dialog's) "Update now".
//! - How it installs depends on how the app was installed ([`kind`]):
//!   - AppImage: the plugin replaces the AppImage file in place.
//!   - .deb: the plugin downloads the signed .deb and runs `pkexec dpkg -i` (the desktop's password prompt). It
//!     needs a `linux-x86_64-deb` entry in latest.json; without one, or if the install fails or is cancelled,
//!     the page offers the .deb to download and the `sudo apt install` line instead (`install: "manual"`).
//!   - Anything else (a build from source, `cargo build`): never installed here, the page says how to update.
//! - Update now: download (progress in `update-state`), install, keep the release notes for the next launch,
//!   then [`AppHandle::request_restart`]. That goes through `RunEvent::Exit`, where server.rs stops an owned
//!   server cleanly (SIGTERM, 5 s) before the new version starts its own.
//! - The first launch of a new version has `justUpdated` (from, to, notes) until the page calls `update_seen`.
//!
//! The page talks to this with the `update_*` commands below and listens to `update-state` (the whole state, on
//! every change) and `update-open` (the tray's "Update to …" line: open the update dialog).

use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Builder, Emitter, Manager, Runtime, State};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::server::{save_setting, settings};

/// Automatic checks: this long after the last one.
const EVERY: Duration = Duration::from_secs(6 * 3600);
/// The first automatic check, after launch (the board comes first).
const FIRST_AFTER: Duration = Duration::from_secs(15);
/// "Later" hides the offer this long (Settings and the tray still show it).
const LATER: Duration = Duration::from_secs(24 * 3600);

/// Builder time: the updater plugin, only when tauri.conf.json has its settings (its config needs a `pubkey`,
/// and a missing block would stop the app at start). No updater permission is granted to any page: the board
/// uses this module's commands.
pub fn init<R: Runtime>(builder: Builder<R>, has_feed: bool) -> Builder<R> {
    if has_feed {
        builder.plugin(tauri_plugin_updater::Builder::new().build())
    } else {
        builder
    }
}

/// Managed state.
pub struct Updates {
    has_feed: bool,
    st: Mutex<St>,
}

#[derive(Default)]
struct St {
    checking: bool,
    /// "download" (with done/total bytes), "install", "restart".
    busy: Option<&'static str>,
    done: u64,
    total: Option<u64>,
    checked_at: Option<u64>,
    error: Option<String>,
    found: Option<Found>,
    /// The plugin's update object for `found`, when it can be installed here.
    pending: Option<Update>,
    just_updated: Option<Value>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Found {
    version: String,
    notes: String,
    /// Unix ms, when the feed gives it.
    date: Option<i64>,
    /// "app": Update now installs it here. "manual": the page says how (download the .deb, or update from source).
    install: &'static str,
    /// The release's page, for a feed on GitHub releases.
    page: Option<String>,
    /// The .deb to download, for a .deb install updated by hand.
    deb: Option<String>,
}

/// How this copy of the app was installed: "appimage", "deb", "rpm", or "other" (built from source, a plain
/// `cargo build`, …: nothing to update in place).
pub fn kind() -> &'static str {
    use tauri::utils::config::BundleType;
    if std::env::var_os("APPIMAGE").is_some() && std::env::var_os("APPDIR").is_some() {
        return "appimage";
    }
    match tauri::utils::platform::bundle_type() {
        Some(BundleType::AppImage) => "appimage",
        Some(BundleType::Deb) => "deb",
        Some(BundleType::Rpm) => "rpm",
        _ => "other",
    }
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

/// app.json `updates`: `{ auto, skipped, later: { version, until }, checkedAt, seen, notes: { version, notes } }`.
fn saved<R: Runtime>(app: &AppHandle<R>) -> Value {
    settings(app).get("updates").cloned().filter(Value::is_object).unwrap_or_else(|| json!({}))
}

fn save<R: Runtime>(app: &AppHandle<R>, f: impl FnOnce(&mut Value)) -> Result<(), String> {
    let mut v = saved(app);
    f(&mut v);
    save_setting(app, "updates", v)
}

fn auto_on<R: Runtime>(app: &AppHandle<R>) -> bool {
    saved(app).get("auto").and_then(Value::as_bool).unwrap_or(true)
}

/// Runs in Tauri's setup: notes a new version (for the "Updated to" note) and starts the automatic checks.
pub fn setup<R: Runtime>(app: &AppHandle<R>, has_feed: bool) {
    let current = app.package_info().version.to_string();
    let u = saved(app);
    let seen = u.get("seen").and_then(Value::as_str).map(str::to_owned);
    let mut just_updated = None;
    if let Some(from) = seen.as_deref().filter(|s| *s != current) {
        // Only forward: a downgrade (or a different build of the same version) gets no note.
        if newer(&current, from) {
            let notes = u.get("notes").filter(|n| n["version"].as_str() == Some(current.as_str()));
            just_updated = Some(json!({
                "from": from,
                "to": current,
                "notes": notes.and_then(|n| n["notes"].as_str()).unwrap_or(""),
                "page": release_page(app, &current),
            }));
        }
    }
    if seen.as_deref() != Some(current.as_str()) {
        let c = current.clone();
        let _ = save(app, |v| {
            v["seen"] = json!(c);
            if let Some(o) = v.as_object_mut() {
                o.remove("notes");
            }
        });
    }
    app.manage(Updates {
        has_feed,
        st: Mutex::new(St {
            checked_at: u.get("checkedAt").and_then(Value::as_u64),
            just_updated,
            ..St::default()
        }),
    });
    if has_feed {
        let app = app.clone();
        std::thread::Builder::new()
            .name("update-checks".into())
            .spawn(move || {
                std::thread::sleep(FIRST_AFTER);
                let mut last = None::<Instant>;
                loop {
                    if auto_on(&app) && last.is_none_or(|t| t.elapsed() >= EVERY) {
                        last = Some(Instant::now());
                        tauri::async_runtime::block_on(check(&app));
                    }
                    std::thread::sleep(Duration::from_secs(600));
                }
            })
            .ok();
    }
}

/// a > b, for x.y.z versions (semver's order).
fn newer(a: &str, b: &str) -> bool {
    match (semver::Version::parse(a), semver::Version::parse(b)) {
        (Ok(a), Ok(b)) => a > b,
        _ => false,
    }
}

fn first_endpoint<R: Runtime>(app: &AppHandle<R>) -> Option<String> {
    app.config().plugins.0.get("updater")?.get("endpoints")?.get(0)?.as_str().map(str::to_owned)
}

/// `https://github.com/<owner>/<repo>/releases`, when the feed is a GitHub release's latest.json (tags are `v<version>`).
fn github_releases<R: Runtime>(app: &AppHandle<R>) -> Option<String> {
    let feed = first_endpoint(app)?;
    let rest = feed.strip_prefix("https://github.com/")?;
    let mut parts = rest.split('/');
    let (owner, repo, releases) = (parts.next()?, parts.next()?, parts.next()?);
    (releases == "releases").then(|| format!("https://github.com/{owner}/{repo}/releases"))
}

/// The GitHub release page of a version.
fn release_page<R: Runtime>(app: &AppHandle<R>, version: &str) -> Option<String> {
    github_releases(app).map(|r| format!("{r}/tag/v{version}"))
}

/// The .deb of a version on its GitHub release, under the bundler's name (`Workbench_0.2.0_amd64.deb`).
fn github_deb<R: Runtime>(app: &AppHandle<R>, version: &str) -> Option<String> {
    let arch = match std::env::consts::ARCH {
        "x86_64" => "amd64",
        "aarch64" => "arm64",
        other => other,
    };
    let name = &app.package_info().name;
    github_releases(app).map(|r| format!("{r}/download/v{version}/{name}_{version}_{arch}.deb"))
}

/// The page's view of everything (`update_state`, and the `update-state` event).
fn snapshot<R: Runtime>(app: &AppHandle<R>) -> Value {
    let u = saved(app);
    let state = app.state::<Updates>();
    let st = state.st.lock().unwrap_or_else(|e| e.into_inner());
    let later = u
        .get("later")
        .filter(|l| l["until"].as_u64().is_some_and(|t| t > now_ms()))
        .and_then(|l| l["version"].as_str())
        .map(str::to_owned);
    json!({
        "enabled": state.has_feed,
        "version": app.package_info().version.to_string(),
        "kind": kind(),
        "auto": auto_on(app),
        "checking": st.checking,
        "checkedAt": st.checked_at,
        "error": st.error,
        "available": st.found,
        "skipped": u.get("skipped").and_then(Value::as_str),
        "later": later,
        "busy": st.busy,
        "done": st.done,
        "total": st.total,
        "justUpdated": st.just_updated,
    })
}

/// Tells the page (and the tray) what changed.
fn changed<R: Runtime>(app: &AppHandle<R>) {
    let snap = snapshot(app);
    let offer = snap["available"]["version"]
        .as_str()
        .filter(|v| snap["skipped"].as_str() != Some(*v) && snap["busy"].is_null())
        .map(str::to_owned);
    crate::tray::set_update(app, offer);
    let _ = app.emit_to(crate::MAIN, "update-state", snap);
}

fn with<R: Runtime, T>(app: &AppHandle<R>, f: impl FnOnce(&mut St) -> T) -> T {
    let state = app.state::<Updates>();
    let mut st = state.st.lock().unwrap_or_else(|e| e.into_inner());
    f(&mut st)
}

/// The tray's "Update to …": show the window and open the board's update dialog.
pub fn open_dialog<R: Runtime>(app: &AppHandle<R>) {
    crate::show_main(app);
    let _ = app.emit_to(crate::MAIN, "update-open", ());
}

/// Asks the feed once. For a .deb whose release has no .deb entry, and for builds that can't update in place,
/// it still learns the version and notes (from the AppImage's entry) and offers the manual way.
async fn check<R: Runtime>(app: &AppHandle<R>) {
    let state = app.state::<Updates>();
    if !state.has_feed || with(app, |st| std::mem::replace(&mut st.checking, true) || st.busy.is_some()) {
        return;
    }
    changed(app);
    let appimage_target = format!("linux-{}-appimage", std::env::consts::ARCH);
    let kind = kind();
    let in_place = matches!(kind, "appimage" | "deb");
    let ask = |target: Option<&str>| {
        let target = target.map(str::to_owned);
        let app = app.clone();
        async move {
            let mut b = app.updater_builder().timeout(Duration::from_secs(60));
            if let Some(t) = target {
                b = b.target(t);
            }
            b.build()?.check().await
        }
    };
    let mut result = ask(if in_place { None } else { Some(&appimage_target) }).await.map(|u| (u, in_place));
    if kind == "deb" && matches!(result, Err(tauri_plugin_updater::Error::TargetsNotFound(_))) {
        result = ask(Some(&appimage_target)).await.map(|u| (u, false));
    }
    let at = now_ms();
    with(app, |st| {
        st.checking = false;
        st.checked_at = Some(at);
        match result {
            Ok((Some(update), here)) => {
                let deb = update.raw_json["platforms"][format!("linux-{}-deb", std::env::consts::ARCH)]["url"]
                    .as_str()
                    .map(str::to_owned)
                    .or_else(|| (kind == "deb").then(|| github_deb(app, &update.version)).flatten());
                st.found = Some(Found {
                    version: update.version.clone(),
                    notes: update.body.clone().unwrap_or_default(),
                    date: update.date.map(|d| d.unix_timestamp() * 1000),
                    install: if here { "app" } else { "manual" },
                    page: release_page(app, &update.version),
                    deb,
                });
                st.pending = here.then_some(update);
                st.error = None;
            }
            Ok((None, _)) => {
                st.found = None;
                st.pending = None;
                st.error = None;
            }
            Err(e) => st.error = Some(check_error(&e)),
        }
    });
    let _ = save(app, |v| v["checkedAt"] = json!(at));
    changed(app);
}

fn check_error(e: &tauri_plugin_updater::Error) -> String {
    use tauri_plugin_updater::Error as E;
    match e {
        E::TargetsNotFound(_) => "The newest release has no build for this computer.".into(),
        E::ReleaseNotFound => "Couldn't read the newest release.".into(),
        E::Reqwest(r) if r.is_connect() || r.is_timeout() => "Couldn't reach the release feed: offline?".into(),
        other => format!("Couldn't check: {other}"),
    }
}

// ---------- commands (granted to the board page, see lib.rs) ----------

#[tauri::command]
pub fn update_state<R: Runtime>(app: AppHandle<R>) -> Value {
    snapshot(&app)
}

/// "Check now". Returns the state after the check.
#[tauri::command]
pub async fn update_check<R: Runtime>(app: AppHandle<R>) -> Result<Value, String> {
    check(&app).await;
    Ok(snapshot(&app))
}

/// "Update now": installs the update this app found itself, only if it's still `version` (what the page showed).
/// The page picks nothing else: no URL, no file, no other version; the plugin checks the download's signature
/// against the release key in tauri.conf.json. Returns once the download starts; progress comes as `update-state`.
#[tauri::command]
pub fn update_install<R: Runtime>(app: AppHandle<R>, version: String) -> Result<(), String> {
    let update = with(&app, |st| {
        if st.busy.is_some() {
            return Err("An update is already being installed.".to_string());
        }
        match &st.pending {
            Some(u) if u.version == version => {
                st.busy = Some("download");
                st.done = 0;
                st.total = None;
                st.error = None;
                Ok(u.clone())
            }
            _ => Err(format!("Version {version} isn't on offer any more. Check again.")),
        }
    })?;
    changed(&app);
    tauri::async_runtime::spawn(async move { install(app, update).await });
    Ok(())
}

async fn install<R: Runtime>(app: AppHandle<R>, update: Update) {
    let mut last_emit = Instant::now();
    let downloaded = update
        .download(
            |chunk, total| {
                with(&app, |st| {
                    st.done += chunk as u64;
                    st.total = total;
                });
                if last_emit.elapsed() >= Duration::from_millis(150) {
                    last_emit = Instant::now();
                    changed(&app);
                }
            },
            || {},
        )
        .await;
    let bytes = match downloaded {
        Ok(b) => b,
        Err(e) => return failed(&app, format!("The download failed: {e}"), false),
    };
    with(&app, |st| st.busy = Some("install"));
    changed(&app);
    // Kept for the "Updated to" note of the next launch.
    let (version, notes) = (update.version.clone(), update.body.clone().unwrap_or_default());
    let _ = save(&app, |v| v["notes"] = json!({ "version": version, "notes": notes }));
    // pkexec (for a .deb) waits for the password prompt: off the async workers.
    let result = tauri::async_runtime::spawn_blocking({
        let update = update.clone();
        move || update.install(bytes)
    })
    .await;
    match result {
        Ok(Ok(())) => {
            with(&app, |st| st.busy = Some("restart"));
            changed(&app);
            // A moment for the page to show "Restarting…".
            std::thread::sleep(Duration::from_millis(600));
            // RunEvent::Exit stops an owned server (server.rs) before the new version starts.
            app.request_restart();
        }
        Ok(Err(e)) => {
            let _ = save(&app, |v| {
                if let Some(o) = v.as_object_mut() {
                    o.remove("notes");
                }
            });
            eprintln!("workbench-app: update: install: {e}");
            let why = if kind() == "deb" {
                "The package wasn't installed: the password prompt was closed, or the install failed.".to_string()
            } else {
                format!("Couldn't install it: {e}")
            };
            failed(&app, why, kind() == "deb")
        }
        Err(e) => failed(&app, format!("Couldn't install it: {e}"), kind() == "deb"),
    }
}

/// Back to the offer, with the error. A .deb that couldn't be installed here (password prompt cancelled, no
/// pkexec) is offered the manual way.
fn failed<R: Runtime>(app: &AppHandle<R>, why: String, manual: bool) {
    eprintln!("workbench-app: update: {why}");
    with(app, |st| {
        st.busy = None;
        st.error = Some(why);
        if manual {
            if let Some(f) = st.found.as_mut() {
                f.install = "manual";
            }
        }
    });
    changed(app);
}

/// "Later": hides the offer of `version` for a day (Settings → Updates and the tray still show it).
#[tauri::command]
pub fn update_later<R: Runtime>(app: AppHandle<R>, version: String) -> Result<Value, String> {
    let until = now_ms() + LATER.as_millis() as u64;
    save(&app, |v| v["later"] = json!({ "version": version, "until": until }))?;
    changed(&app);
    Ok(snapshot(&app))
}

/// "Skip this version" (`Some`) or "Stop skipping" (`None`). A newer version is offered again.
#[tauri::command]
pub fn update_skip<R: Runtime>(app: AppHandle<R>, version: Option<String>) -> Result<Value, String> {
    save(&app, |v| v["skipped"] = json!(version))?;
    changed(&app);
    Ok(snapshot(&app))
}

/// Settings → Updates: automatic checks on or off.
#[tauri::command]
pub fn update_auto<R: Runtime>(app: AppHandle<R>, on: bool) -> Result<Value, String> {
    save(&app, |v| v["auto"] = json!(on))?;
    changed(&app);
    Ok(snapshot(&app))
}

/// The page showed the "Updated to" note.
#[tauri::command]
pub fn update_seen<R: Runtime>(app: AppHandle<R>, state: State<'_, Updates>) {
    state.st.lock().unwrap_or_else(|e| e.into_inner()).just_updated = None;
    let _ = app;
}
