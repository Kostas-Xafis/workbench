//! The board's server: find one that's running, else start the bundled one, and keep the window on it.
//!
//! Owner: the "lifecycle" agent. The contract is in src-tauri/README.md ("How the app finds or starts the
//! server"). In short:
//! - [`setup`] starts a supervisor thread and returns at once; the main window opens on the bundled fallback
//!   page (`fallback/index.html`) and the supervisor navigates it to the board once the board answers.
//! - Find: `GET http://127.0.0.1:<port>/api/ping`. A Workbench → attach. Something else → "port N is taken".
//!   Nothing → start the sidecar `workbench-server` (next to the app's binary) and wait until its ping answers
//!   with its own pid.
//! - Owned server exits unexpectedly → restart after 1, 2, 5, 10, 15 s; a 6th exit within a minute → error page.
//! - Attached board stops answering → never start one of our own by ourselves (its launcher, e.g. the systemd
//!   unit with `Restart=on-failure`, is about to bring it back, and we'd take its port). Keep the board page up
//!   for a few seconds, then a "waiting" page that keeps pinging and re-attaches; "Start it here" is offered
//!   only after it has stayed gone for a while.
//! - Quit (`RunEvent::Exit`): owned → SIGTERM, 5 s, SIGKILL. Attached → left running. If the app itself dies,
//!   an owned server gets SIGTERM from the kernel (PR_SET_PDEATHSIG), so no orphan holds the port.
//!
//! All of the supervisor's state lives on its one thread (which is also the thread that forks the server, as
//! PR_SET_PDEATHSIG requires); other threads only send it [`Cmd`]s and read [`Now`].

use std::collections::VecDeque;
use std::fs::{self, File, OpenOptions};
use std::io::{self, BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use tauri::ipc::CapabilityBuilder;
use tauri::{AppHandle, Builder, Manager, RunEvent, Runtime, State, Url};

use crate::MAIN;

const PING_TIMEOUT: Duration = Duration::from_secs(1);
/// The supervisor's tick; also the ready poll while a server starts.
const TICK: Duration = Duration::from_millis(100);
const READY_TIMEOUT: Duration = Duration::from_secs(15);
/// How often an attached board is checked, and how often a lost one is looked for.
const ATTACHED_PING: Duration = Duration::from_secs(2);
const LOST_PING: Duration = Duration::from_secs(1);
/// The board page stays up this long while its server is away (a restart usually takes less).
const GRACE: Duration = Duration::from_secs(3);
/// A lost attached board: "Start it here" appears after this long (the systemd unit restarts after 3 s).
const OFFER_START_AFTER: Duration = Duration::from_secs(15);
/// At launch, when the systemd unit is enabled but not answering yet: wait this long before starting our own.
const SERVICE_WAIT: Duration = Duration::from_secs(10);
/// Delays before restarts 1..=5 of an owned server; a 6th exit within [`RESTART_WINDOW`] shows the error.
const BACKOFF_SECS: [u64; 5] = [1, 2, 5, 10, 15];
const RESTART_WINDOW: Duration = Duration::from_secs(60);
const STOP_WAIT: Duration = Duration::from_secs(5);
/// server.log is moved to server.log.1 when it would pass this size.
const LOG_MAX: u64 = 1 << 20;
const LOG_TAIL_LINES: usize = 40;

/// Where the board is, and who runs it now. Managed state, set in [`setup`].
pub struct Board {
    /// `WB_APP_URL` (default `http://localhost:4321`); doesn't change while the app runs.
    pub url: Url,
    pub port: u16,
    now: Mutex<Now>,
    tx: mpsc::Sender<Cmd>,
}

impl Board {
    fn now(&self) -> Now {
        *self.now.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/// What the rest of the app may know about the server right now (the supervisor keeps it current).
#[derive(Clone, Copy, Default)]
struct Now {
    server: Server,
    /// The owned server's `--lan`.
    lan: bool,
}

#[derive(Clone, Copy, Default, PartialEq)]
enum Server {
    /// Looking, port taken by something else, or failed: nothing to show.
    #[default]
    None,
    /// Someone else's server (it may be away for a moment).
    Attached,
    /// Ours (running, starting, or about to restart).
    Owned,
}

enum Cmd {
    /// The fallback page's Retry / "Start it here": look again, start one if nothing answers.
    Retry,
    /// `lan` changed: restart an owned server with the new setting.
    Lan,
    /// The app is exiting: stop an owned server, then answer.
    Quit(mpsc::Sender<()>),
}

/// Builder-time setup: the single-instance plugin, which has to be the first plugin.
pub fn init<R: Runtime>(builder: Builder<R>) -> Builder<R> {
    builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
        // A second start on login (`--hidden`) has nothing to show.
        if argv.iter().any(|a| a == crate::HIDDEN_ARG) {
            return;
        }
        eprintln!("workbench-app: launched again: bringing this window to the front");
        crate::show_main(app);
    }))
}

/// Starts finding or starting the board in the background and returns at once. Runs inside Tauri's setup,
/// before the main window (which opens on the fallback page) is created.
pub fn setup<R: Runtime>(app: &AppHandle<R>) -> Result<(), Box<dyn std::error::Error>> {
    let raw = std::env::var("WB_APP_URL").unwrap_or_else(|_| "http://localhost:4321".into());
    let url: Url = raw.parse().map_err(|e| format!("WB_APP_URL {raw:?}: {e}"))?;
    let port = url.port_or_known_default().unwrap_or(4321);
    let (tx, rx) = mpsc::channel();
    app.manage(Board { url: url.clone(), port, now: Mutex::new(Now::default()), tx });

    // The fallback page (the app's own bundled page, never the board's origin or a report) may call `retry`
    // and nothing else. Retry only looks for the board again, and starts the bundled server if none answers.
    app.add_capability(
        CapabilityBuilder::new("fallback")
            .local(true)
            .window(MAIN)
            .permission("allow-retry"),
    )?;

    let log_path = app
        .path()
        .app_log_dir()
        .map(|d| d.join("server.log"))
        .unwrap_or_else(|_| std::env::temp_dir().join("workbench-server.log"));
    let sup = Supervisor {
        app: app.clone(),
        url,
        port,
        agent: ureq::Agent::config_builder()
            .timeout_global(Some(PING_TIMEOUT))
            .http_status_as_error(false)
            .max_redirects(0)
            .build()
            .into(),
        log: Arc::new(Mutex::new(Log::new(log_path))),
        child: None,
        phase: Phase::Looking,
        exits: VecDeque::new(),
        next_ping: Instant::now(),
        view: View::Unknown,
        away_since: None,
        granted: false,
    };
    std::thread::Builder::new()
        .name("board-supervisor".into())
        .spawn(move || sup.run(rx))?;
    #[cfg(debug_assertions)]
    test_ctl::start(app);
    Ok(())
}

/// App-level events: on exit, stop an owned server (an attached one is left running).
pub fn on_run_event<R: Runtime>(app: &AppHandle<R>, event: &RunEvent) {
    if let RunEvent::Exit = event {
        if let Some(board) = app.try_state::<Board>() {
            let (done, wait) = mpsc::channel();
            if board.tx.send(Cmd::Quit(done)).is_ok() {
                let _ = wait.recv_timeout(STOP_WAIT + Duration::from_secs(3));
            }
        }
    }
}

// The interface other modules use (tray.rs, web.rs). The system agent only calls these. Until their calls land,
// release builds have no caller (debug builds do: test_ctl), hence the cfg_attr allows.

/// The board's URL as the app uses it (scheme, host, port; the tray polls `/api/projects` on it). It's
/// `WB_APP_URL` and stays the same while the app runs, whoever runs the server.
#[cfg_attr(not(debug_assertions), allow(dead_code))]
pub fn board_url<R: Runtime>(app: &AppHandle<R>) -> Url {
    app.state::<Board>().url.clone()
}

/// true when this app started the server it shows (and so stops it on quit, and controls `--lan`). Also true
/// while that server starts or restarts.
#[cfg_attr(not(debug_assertions), allow(dead_code))]
pub fn is_owned<R: Runtime>(app: &AppHandle<R>) -> bool {
    app.state::<Board>().now().server == Server::Owned
}

/// Whether the owned server runs with `--lan`. false for an attached server, or when there's none.
#[cfg_attr(not(debug_assertions), allow(dead_code))]
pub fn lan_enabled<R: Runtime>(app: &AppHandle<R>) -> bool {
    let now = app.state::<Board>().now();
    now.server == Server::Owned && now.lan
}

/// Turns `--lan` on or off: saves the app setting `lan` (app.json) and restarts an owned server with it, in
/// the background (returns at once; the window shows "Starting the board…" if it takes more than a moment).
/// With no server at all (port taken, failed) it's only saved, for the next start. Err for an attached server
/// (its own launcher decides) or when app.json can't be written.
#[cfg_attr(not(debug_assertions), allow(dead_code))]
pub fn set_lan<R: Runtime>(app: &AppHandle<R>, on: bool) -> Result<(), String> {
    let board = app.state::<Board>();
    if board.now().server == Server::Attached {
        return Err(format!(
            "The board on port {} was started outside the app; its own launcher decides --lan.",
            board.port
        ));
    }
    save_setting(app, "lan", Value::Bool(on))?;
    let _ = board.tx.send(Cmd::Lan);
    Ok(())
}

#[derive(Serialize)]
pub struct AppInfo {
    /// The app's version (tauri.conf.json `version`), not the server's (that's in `/api/ping`).
    version: String,
    /// "owned": this app started the server; "attached": it was already running.
    server: &'static str,
    port: u16,
}

/// `app_info` → `{ version, server: "owned" | "attached", port }`. Granted to the board page.
#[tauri::command]
pub fn app_info<R: Runtime>(app: AppHandle<R>, board: State<'_, Board>) -> AppInfo {
    AppInfo {
        version: app.package_info().version.to_string(),
        server: if board.now().server == Server::Owned { "owned" } else { "attached" },
        port: board.port,
    }
}

/// `retry`: the fallback page's Retry and "Start it here". Granted only to the fallback page.
#[tauri::command]
pub fn retry(board: State<'_, Board>) {
    let _ = board.tx.send(Cmd::Retry);
}

// ---------- the supervisor ----------

enum Phase {
    /// At launch, before the first ping.
    Looking,
    /// At launch: the systemd unit is enabled but its board doesn't answer yet; give it until `until`.
    Waiting { until: Instant },
    /// Our server is starting; ready when its ping answers with its pid.
    Starting { since: Instant },
    /// The window shows the board.
    Connected { owned: bool },
    /// Our server exited; restart `n` (1..=5) at `until`.
    Backoff { until: Instant, n: usize },
    /// The attached board stopped answering at `since`; looking for it every second.
    Lost { since: Instant },
    /// Something that isn't a Workbench answers on the port.
    Taken { what: String },
    /// Our server didn't come up, or kept stopping. `log` is server.log's tail at that moment.
    Failed { why: String, log: String },
}

#[derive(PartialEq)]
enum View {
    Unknown,
    Board,
    /// The fallback page with this state (the JSON in its URL's fragment).
    Fallback(String),
}

struct Owned {
    child: Child,
    lan: bool,
}

enum Ping {
    Board { pid: u32 },
    Other(String),
    Nothing,
}

#[derive(Deserialize)]
struct PingBody {
    app: String,
    #[serde(default)]
    pid: u32,
}

struct Supervisor<R: Runtime> {
    app: AppHandle<R>,
    url: Url,
    port: u16,
    agent: ureq::Agent,
    log: Arc<Mutex<Log>>,
    child: Option<Owned>,
    phase: Phase,
    /// When our server exited unexpectedly, within the last [`RESTART_WINDOW`].
    exits: VecDeque<Instant>,
    next_ping: Instant,
    view: View,
    /// When the board stopped being reachable (for [`GRACE`]).
    away_since: Option<Instant>,
    /// The board's capability is added once, before the first navigation to the board.
    granted: bool,
}

impl<R: Runtime> Supervisor<R> {
    fn run(mut self, rx: mpsc::Receiver<Cmd>) {
        self.find_or_start(true);
        loop {
            self.render();
            match rx.recv_timeout(TICK) {
                Ok(Cmd::Quit(done)) => {
                    self.stop_child("the app quits");
                    let _ = done.send(());
                    return;
                }
                Ok(Cmd::Retry) => self.retry(),
                Ok(Cmd::Lan) => self.lan_changed(),
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    self.stop_child("the app is gone");
                    return;
                }
            }
            self.step();
        }
    }

    fn ping(&self) -> Ping {
        let url = format!("http://127.0.0.1:{}/api/ping", self.port);
        match self.agent.get(&url).call() {
            Ok(mut resp) => {
                let status = resp.status().as_u16();
                let body = resp.body_mut().with_config().limit(64 * 1024).read_to_string();
                match body.ok().and_then(|b| serde_json::from_str::<PingBody>(&b).ok()) {
                    Some(p) if status == 200 && p.app == "workbench" => Ping::Board { pid: p.pid },
                    _ => Ping::Other(format!("It answers /api/ping with HTTP {status}, not as a Workbench does.")),
                }
            }
            Err(ureq::Error::Io(e)) if e.kind() == io::ErrorKind::ConnectionRefused => Ping::Nothing,
            Err(ureq::Error::ConnectionFailed) => Ping::Nothing,
            Err(e) => Ping::Other(format!("It doesn't answer /api/ping as a Workbench does ({e}).")),
        }
    }

    fn find_or_start(&mut self, at_launch: bool) {
        match self.ping() {
            Ping::Board { pid } => {
                self.note(&format!("a Workbench answers on port {} (pid {pid}): attached", self.port));
                self.set(Phase::Connected { owned: false });
            }
            Ping::Other(what) => {
                self.note(&format!("port {} is taken. {what}", self.port));
                self.set(Phase::Taken { what });
            }
            Ping::Nothing if at_launch && service_enabled() => {
                self.note("nothing answers yet, but the workbench systemd unit is enabled: waiting for it");
                self.set(Phase::Waiting { until: Instant::now() + SERVICE_WAIT });
            }
            Ping::Nothing => self.start(),
        }
    }

    fn start(&mut self) {
        match self.spawn() {
            Ok(()) => self.set(Phase::Starting { since: Instant::now() }),
            Err(why) => {
                self.note(&why);
                let log = self.tail();
                self.set(Phase::Failed { why, log });
            }
        }
    }

    fn step(&mut self) {
        let exited = match self.child.as_mut().map(|c| c.child.try_wait()) {
            Some(Ok(Some(status))) => Some(status),
            _ => None,
        };
        if let Some(status) = exited {
            self.child = None;
            self.crashed(status);
        }
        let now = Instant::now();
        match self.phase {
            Phase::Starting { since } => {
                let ours = self.child.as_ref().map(|c| c.child.id());
                match self.ping() {
                    Ping::Board { pid } if Some(pid) == ours => {
                        self.note(&format!("server pid {pid} is ready"));
                        self.set(Phase::Connected { owned: true });
                    }
                    Ping::Board { pid } => {
                        // Someone else's board got the port first (e.g. the systemd unit): use it.
                        self.stop_child(&format!("another Workbench (pid {pid}) answers on the port"));
                        self.set(Phase::Connected { owned: false });
                    }
                    _ if since.elapsed() > READY_TIMEOUT => {
                        self.stop_child("it didn't answer within 15 s");
                        let log = self.tail();
                        self.set(Phase::Failed {
                            why: format!("The board didn't answer on port {} within 15 seconds.", self.port),
                            log,
                        });
                    }
                    _ => {}
                }
            }
            Phase::Connected { owned: false } if now >= self.next_ping => {
                self.next_ping = now + ATTACHED_PING;
                if !matches!(self.ping(), Ping::Board { .. }) {
                    self.note("the attached board stopped answering: waiting for it to come back");
                    self.set(Phase::Lost { since: now });
                }
            }
            Phase::Lost { since } if now >= self.next_ping => {
                self.next_ping = now + LOST_PING;
                if let Ping::Board { pid } = self.ping() {
                    self.note(&format!(
                        "the board is back (pid {pid}) after {} s: re-attached",
                        since.elapsed().as_secs()
                    ));
                    self.set(Phase::Connected { owned: false });
                }
            }
            Phase::Backoff { until, .. } if now >= until => self.find_or_start(false),
            Phase::Waiting { until } if now >= self.next_ping => {
                self.next_ping = now + Duration::from_millis(500);
                match self.ping() {
                    Ping::Board { pid } => {
                        self.note(&format!("the service's board answers (pid {pid}): attached"));
                        self.set(Phase::Connected { owned: false });
                    }
                    Ping::Other(what) => self.set(Phase::Taken { what }),
                    Ping::Nothing if now >= until => {
                        self.note("the service didn't start a board: starting our own");
                        self.start();
                    }
                    Ping::Nothing => {}
                }
            }
            _ => {}
        }
    }

    fn crashed(&mut self, status: ExitStatus) {
        let now = Instant::now();
        while self.exits.front().is_some_and(|t| now.duration_since(*t) > RESTART_WINDOW) {
            self.exits.pop_front();
        }
        self.exits.push_back(now);
        let n = self.exits.len();
        if n > BACKOFF_SECS.len() {
            self.note(&format!("server exited ({status}), {n} times in a minute: giving up"));
            let log = self.tail();
            self.set(Phase::Failed {
                why: format!("The board stopped {n} times in a minute ({status})."),
                log,
            });
        } else {
            let secs = BACKOFF_SECS[n - 1];
            self.note(&format!("server exited unexpectedly ({status}): restart {n} of 5 in {secs} s"));
            self.set(Phase::Backoff { until: now + Duration::from_secs(secs), n });
        }
    }

    fn retry(&mut self) {
        match self.phase {
            Phase::Taken { .. } | Phase::Failed { .. } | Phase::Lost { .. } | Phase::Waiting { .. } | Phase::Backoff { .. } => {
                self.note("retry from the window");
                self.exits.clear();
                self.find_or_start(false);
            }
            _ => {}
        }
    }

    fn lan_changed(&mut self) {
        let on = lan_setting(&self.app);
        if self.child.as_ref().is_some_and(|c| c.lan != on) {
            self.stop_child(&format!("restarting with lan {}", if on { "on" } else { "off" }));
            self.start();
        }
    }

    fn spawn(&mut self) -> Result<(), String> {
        let exe = std::env::current_exe().map_err(|e| format!("Can't find the app's own binary: {e}"))?;
        let bin = exe.with_file_name(if cfg!(windows) { "workbench-server.exe" } else { "workbench-server" });
        if !bin.exists() {
            return Err(format!("The bundled server isn't there: {}", bin.display()));
        }
        let db = db_path(&self.app)?;
        let backups = db.parent().unwrap_or(Path::new("/")).join("backups");
        let home = self.app.path().home_dir().unwrap_or_else(|_| PathBuf::from("/"));
        let lan = lan_setting(&self.app);
        let (reader, writer) = io::pipe().map_err(|e| format!("Can't make a pipe for the server's log: {e}"))?;
        let writer2 = writer.try_clone().map_err(|e| e.to_string())?;

        let mut cmd = Command::new(&bin);
        if lan {
            cmd.arg("--lan");
        }
        cmd.env("WB_DB", &db)
            .env("WB_BACKUPS", &backups)
            .env("WB_PORT", self.port.to_string())
            .env("WB_APP", "1")
            .current_dir(&home)
            .stdin(Stdio::null())
            .stdout(writer)
            .stderr(writer2);
        for (key, value) in without_appimage_env() {
            match value {
                Some(v) => cmd.env(key, v),
                None => cmd.env_remove(key),
            };
        }
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            // Its own process group: Ctrl-C in the app's terminal reaches the app, not the server.
            cmd.process_group(0);
            #[cfg(target_os = "linux")]
            {
                let parent = std::process::id();
                // SAFETY: only async-signal-safe calls between fork and exec.
                unsafe {
                    cmd.pre_exec(move || {
                        // The kernel sends SIGTERM when the forking thread (this supervisor, which lives as long
                        // as the app) dies, so a killed app doesn't leave an unsupervised server on the port.
                        if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGTERM) != 0 {
                            return Err(io::Error::last_os_error());
                        }
                        if libc::getppid() as u32 != parent {
                            return Err(io::Error::other("the app exited while starting the server"));
                        }
                        Ok(())
                    });
                }
            }
        }
        let child = cmd.spawn().map_err(|e| format!("Can't start {}: {e}", bin.display()))?;
        drop(cmd); // closes our copies of the pipe's write end, so the reader sees EOF when the server exits
        let log = self.log.clone();
        let _ = std::thread::Builder::new().name("server-log".into()).spawn(move || {
            let mut r = BufReader::new(reader);
            let mut line = Vec::new();
            while matches!(r.read_until(b'\n', &mut line), Ok(n) if n > 0) {
                lock(&log).write(&line);
                line.clear();
            }
        });
        self.note(&format!(
            "started {} (pid {}) on port {}{}, WB_DB={}",
            bin.display(),
            child.id(),
            self.port,
            if lan { " with --lan" } else { "" },
            db.display()
        ));
        self.child = Some(Owned { child, lan });
        Ok(())
    }

    /// SIGTERM, up to 5 s, then SIGKILL.
    fn stop_child(&mut self, why: &str) {
        let Some(mut owned) = self.child.take() else { return };
        let pid = owned.child.id();
        self.note(&format!("stopping server pid {pid}: {why}"));
        #[cfg(unix)]
        // SAFETY: plain kill(2) on our own child's pid (not yet reaped, so it can't have been reused).
        unsafe {
            libc::kill(pid as libc::pid_t, libc::SIGTERM);
        }
        #[cfg(not(unix))]
        let _ = owned.child.kill();
        let deadline = Instant::now() + STOP_WAIT;
        let status = loop {
            match owned.child.try_wait() {
                Ok(Some(status)) => break status.to_string(),
                Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(50)),
                _ => {
                    let _ = owned.child.kill();
                    break format!("killed after 5 s ({:?})", owned.child.wait().map(|s| s.to_string()));
                }
            }
        };
        self.note(&format!("server pid {pid} stopped: {status}"));
        self.publish();
    }

    fn set(&mut self, phase: Phase) {
        let was_connected = matches!(self.phase, Phase::Connected { .. });
        match phase {
            Phase::Connected { .. } => self.away_since = None,
            _ if was_connected => self.away_since = Some(Instant::now()),
            _ => {}
        }
        if let Phase::Lost { .. } | Phase::Connected { owned: false } = phase {
            self.next_ping = Instant::now() + if matches!(phase, Phase::Lost { .. }) { LOST_PING } else { ATTACHED_PING };
        }
        self.phase = phase;
        self.publish();
    }

    /// Updates [`Now`] from the phase and the child.
    fn publish(&self) {
        let server = match self.phase {
            Phase::Connected { owned: true } | Phase::Starting { .. } | Phase::Backoff { .. } => Server::Owned,
            Phase::Connected { owned: false } | Phase::Lost { .. } => Server::Attached,
            _ => Server::None,
        };
        let lan = self.child.as_ref().is_some_and(|c| c.lan);
        *self.app.state::<Board>().now.lock().unwrap_or_else(|e| e.into_inner()) = Now { server, lan };
    }

    /// Puts the window on the board, or on the fallback page with the current state.
    fn render(&mut self) {
        let Some(window) = self.app.get_webview_window(MAIN) else { return };
        let want = match &self.phase {
            Phase::Connected { .. } => View::Board,
            Phase::Taken { .. } | Phase::Failed { .. } => View::Fallback(self.fallback_state()),
            // Away for a moment (a restart): keep the board page up for GRACE, it reconnects by itself.
            _ if self.view == View::Board && self.away_since.is_some_and(|t| t.elapsed() < GRACE) => return,
            _ => View::Fallback(self.fallback_state()),
        };
        if want == self.view {
            return;
        }
        let result = match &want {
            View::Board => {
                if !self.granted {
                    if let Err(e) = crate::grant_board(&self.app, &self.url) {
                        self.note(&format!("couldn't grant the board's capability: {e}"));
                    }
                    self.granted = true;
                }
                window.navigate(self.url.clone())
            }
            View::Fallback(state) => {
                let mut url = fallback_url();
                url.set_fragment(Some(&encode_fragment(state)));
                window.navigate(url)
            }
            View::Unknown => Ok(()),
        };
        match result {
            Ok(()) => self.view = want,
            Err(e) => self.note(&format!("couldn't navigate the window: {e}")),
        }
    }

    /// The fallback page's state, as JSON: `{ state, port, detail, log, canStart }`.
    fn fallback_state(&self) -> String {
        let port = self.port;
        let restart = |n: usize| format!("It stopped; starting it again (restart {n} of 5)…");
        let v = match &self.phase {
            Phase::Looking | Phase::Connected { .. } => json!({ "state": "starting", "port": port }),
            Phase::Waiting { .. } => json!({ "state": "starting", "port": port,
                "detail": "Waiting for the workbench service to start it." }),
            Phase::Starting { .. } if self.exits.is_empty() => json!({ "state": "starting", "port": port }),
            Phase::Starting { .. } => json!({ "state": "starting", "port": port, "detail": restart(self.exits.len()) }),
            Phase::Backoff { n, .. } => json!({ "state": "starting", "port": port, "detail": restart(*n) }),
            Phase::Lost { since } => json!({ "state": "waiting", "port": port,
                "canStart": since.elapsed() >= OFFER_START_AFTER }),
            Phase::Taken { what } => json!({ "state": "taken", "port": port, "detail": what }),
            Phase::Failed { why, log } => json!({ "state": "stopped", "port": port, "detail": why, "log": log }),
        };
        v.to_string()
    }

    fn note(&self, msg: &str) {
        eprintln!("workbench-app: {msg}");
        lock(&self.log).write(format!("{} [app] {msg}\n", stamp()).as_bytes());
    }

    fn tail(&self) -> String {
        let path = lock(&self.log).path.clone();
        log_tail(&path, LOG_TAIL_LINES)
    }
}

// ---------- settings, paths, log ----------

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn settings_path<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("app.json"))
}

fn settings<R: Runtime>(app: &AppHandle<R>) -> Map<String, Value> {
    settings_path(app)
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

/// Writes one key of app.json, keeping the others.
fn save_setting<R: Runtime>(app: &AppHandle<R>, key: &str, value: Value) -> Result<(), String> {
    let path = settings_path(app).ok_or("No config folder for the app")?;
    let mut all = settings(app);
    all.insert(key.into(), value);
    let text = serde_json::to_string_pretty(&all).map_err(|e| e.to_string())? + "\n";
    let tmp = path.with_extension("json.tmp");
    fs::create_dir_all(path.parent().unwrap_or(Path::new(".")))
        .and_then(|()| fs::write(&tmp, text))
        .and_then(|()| fs::rename(&tmp, &path))
        .map_err(|e| format!("Can't save {}: {e}", path.display()))
}

/// The `lan` setting (app.json), or `WB_APP_LAN=1` for dev.
fn lan_setting<R: Runtime>(app: &AppHandle<R>) -> bool {
    std::env::var("WB_APP_LAN").as_deref() == Ok("1") || settings(app).get("lan") == Some(&Value::Bool(true))
}

/// `WB_APP_DB`, else `~/Projects/workbench/workbench.db` if it exists, else `$XDG_DATA_HOME/workbench/workbench.db`.
fn db_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let db = match std::env::var_os("WB_APP_DB").filter(|v| !v.is_empty()) {
        Some(v) => std::path::absolute(PathBuf::from(v)).map_err(|e| e.to_string())?,
        None => {
            let home = app.path().home_dir().map_err(|e| e.to_string())?;
            let dev = home.join("Projects/workbench/workbench.db");
            if dev.exists() {
                dev
            } else {
                app.path().data_dir().map_err(|e| e.to_string())?.join("workbench/workbench.db")
            }
        }
    };
    if let Some(dir) = db.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("Can't create {}: {e}", dir.display()))?;
    }
    Ok(db)
}

/// In an AppImage, its AppRun points PATH, LD_LIBRARY_PATH, PYTHONHOME, GTK_*, GIO_MODULE_DIR… at the image's
/// own files, and the server passes its environment on to what it runs for Kostas (trackers' commands, git,
/// cloudflared): python3 doesn't even start with that PYTHONHOME. So the server gets the desktop's
/// environment back: every variable loses the parts inside the image (`$APPDIR`), and goes if nothing is left.
/// Empty outside an AppImage.
fn without_appimage_env() -> Vec<(std::ffi::OsString, Option<std::ffi::OsString>)> {
    #[cfg(unix)]
    {
        use std::ffi::OsString;
        use std::os::unix::ffi::{OsStrExt, OsStringExt};
        let (Some(appdir), Some(_)) = (std::env::var_os("APPDIR"), std::env::var_os("APPIMAGE")) else {
            return Vec::new();
        };
        let appdir = appdir.as_bytes().to_vec();
        if appdir.len() < 2 {
            return Vec::new();
        }
        let inside = |part: &[u8]| part.starts_with(&appdir);
        std::env::vars_os()
            .filter(|(_, v)| v.as_bytes().windows(appdir.len()).any(|w| w == appdir.as_slice()))
            .map(|(k, v)| {
                let kept: Vec<&[u8]> = v.as_bytes().split(|b| *b == b':').filter(|p| !p.is_empty() && !inside(p)).collect();
                let value = (!kept.is_empty()).then(|| OsString::from_vec(kept.join(&b':')));
                (k, value)
            })
            .collect()
    }
    #[cfg(not(unix))]
    Vec::new()
}

/// The workbench systemd user unit is enabled, so a board is expected on login without us.
fn service_enabled() -> bool {
    let config = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config")));
    config.is_some_and(|c| c.join("systemd/user/default.target.wants/workbench.service").exists())
}

/// The bundled fallback page (`build.frontendDist`).
fn fallback_url() -> Url {
    let raw = if cfg!(windows) { "http://tauri.localhost/index.html" } else { "tauri://localhost/index.html" };
    Url::parse(raw).expect("a valid URL")
}

/// Percent-encodes everything but unreserved characters (the page reads it with decodeURIComponent).
fn encode_fragment(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 2);
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// server.log: the server's stdout and stderr and the app's own notes. Moved to server.log.1 (replacing the
/// one before) when it would pass [`LOG_MAX`], so the two together stay under 2 MiB.
struct Log {
    path: PathBuf,
    file: Option<File>,
    size: u64,
}

impl Log {
    fn new(path: PathBuf) -> Log {
        Log { path, file: None, size: 0 }
    }

    fn write(&mut self, bytes: &[u8]) {
        if self.file.is_none() {
            if let Some(dir) = self.path.parent() {
                let _ = fs::create_dir_all(dir);
            }
            self.file = OpenOptions::new().create(true).append(true).open(&self.path).ok();
            self.size = self.file.as_ref().and_then(|f| f.metadata().ok()).map_or(0, |m| m.len());
        }
        if self.size > 0 && self.size + bytes.len() as u64 > LOG_MAX {
            self.file = None;
            let _ = fs::rename(&self.path, self.path.with_extension("log.1"));
            self.file = OpenOptions::new().create(true).write(true).truncate(true).open(&self.path).ok();
            self.size = 0;
        }
        if let Some(f) = self.file.as_mut() {
            if f.write_all(bytes).is_ok() {
                self.size += bytes.len() as u64;
            }
        }
    }
}

fn log_tail(path: &Path, lines: usize) -> String {
    let Ok(mut f) = File::open(path) else { return String::new() };
    let len = f.metadata().map_or(0, |m| m.len());
    let _ = f.seek(SeekFrom::Start(len.saturating_sub(16 * 1024)));
    let mut buf = Vec::new();
    let _ = f.read_to_end(&mut buf);
    let text = String::from_utf8_lossy(&buf);
    let all: Vec<&str> = text.lines().collect();
    all[all.len().saturating_sub(lines)..].join("\n")
}

/// UTC time as `2026-11-10 15:18:03Z`.
fn stamp() -> String {
    let secs = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs()) as i64;
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    // Days to civil date (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y}-{m:02}-{d:02} {:02}:{:02}:{:02}Z", rem / 3600, rem % 3600 / 60, rem % 60)
}

// ---------- test control (debug builds only) ----------

/// For lifecycle tests without clicks: with `WB_APP_TEST_CTL=<fifo>`, each line written to that FIFO is a
/// command: `text` (prints the page's text), `eval <js>` (prints its result), `lan on|off` (calls `set_lan`),
/// `info` (prints `is_owned`, `lan_enabled`, `board_url`), `exit` (calls `app.exit(0)`, as tray Quit does).
/// Output lines start with `WBTEST`. Not compiled into release builds.
#[cfg(debug_assertions)]
mod test_ctl {
    use std::io::BufRead;
    use tauri::{AppHandle, Manager, Runtime};

    pub fn start<R: Runtime>(app: &AppHandle<R>) {
        let Some(path) = std::env::var_os("WB_APP_TEST_CTL") else { return };
        let app = app.clone();
        std::thread::spawn(move || loop {
            let Ok(f) = std::fs::File::open(&path) else { return };
            for line in std::io::BufReader::new(f).lines().map_while(Result::ok) {
                run(&app, line.trim());
            }
        });
    }

    fn run<R: Runtime>(app: &AppHandle<R>, line: &str) {
        let (cmd, arg) = line.split_once(' ').unwrap_or((line, ""));
        let Some(w) = app.get_webview_window(crate::MAIN) else { return };
        match cmd {
            "text" | "eval" => {
                let js = if cmd == "text" {
                    "location.href + ' | ' + document.body.innerText.replace(/\\s+/g, ' ')".to_string()
                } else {
                    arg.to_string()
                };
                let _ = w.eval_with_callback(js, |r| println!("WBTEST {r}"));
            }
            "lan" => println!("WBTEST set_lan {:?}", super::set_lan(app, arg == "on")),
            "info" => println!(
                "WBTEST is_owned={} lan_enabled={} board_url={}",
                super::is_owned(app),
                super::lan_enabled(app),
                super::board_url(app)
            ),
            "exit" => app.exit(0),
            _ => println!("WBTEST unknown command {line:?}"),
        }
    }
}
