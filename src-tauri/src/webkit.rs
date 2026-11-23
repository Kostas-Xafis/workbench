//! Keeps WebKitGTK's web process from running out of file descriptors, which freezes the window.
//!
//! WebKitGTK's DMA-BUF renderer leaks a GPU fence (an `anon_inode:sync_file` descriptor) on many of the frames it
//! paints, at least with NVIDIA's driver (580) on Wayland. After about a day the web process reached its limit of
//! 1024 open files: the driver could no longer make a fence (the kernel logged "Attempt to wait on invalid sync FD:
//! -24", EMFILE), and it busy-waited on the missing one forever. The window froze with the web process's main thread
//! at 100% of a core. In a test, the DMA-BUF renderer left 46 fences open after 80 s, and none with it turned off.
//!
//! Both steps run first in `run()`, before WebKit or any other thread starts: the environment and the limits are
//! inherited by the web and network processes that WebKit starts later.

/// Turns WebKit's DMA-BUF renderer off, unless `WEBKIT_DISABLE_DMABUF_RENDERER` is already set (to anything: `0`
/// turns it back on for a test), and raises the soft limit on open files to the hard limit, so that a leak like this
/// one has a much longer way to go.
#[cfg(target_os = "linux")]
pub fn prepare() {
    const VAR: &str = "WEBKIT_DISABLE_DMABUF_RENDERER";
    if std::env::var_os(VAR).is_none() {
        // No other thread exists yet, so nothing reads the environment while it changes.
        std::env::set_var(VAR, "1");
    }
    raise_open_files();
}

#[cfg(not(target_os = "linux"))]
pub fn prepare() {}

#[cfg(target_os = "linux")]
fn raise_open_files() {
    let mut lim = libc::rlimit { rlim_cur: 0, rlim_max: 0 };
    // SAFETY: getrlimit/setrlimit only read and write the struct passed to them.
    unsafe {
        if libc::getrlimit(libc::RLIMIT_NOFILE, &mut lim) != 0 || lim.rlim_cur >= lim.rlim_max {
            return;
        }
        let was = lim.rlim_cur;
        lim.rlim_cur = lim.rlim_max;
        if libc::setrlimit(libc::RLIMIT_NOFILE, &lim) != 0 {
            eprintln!("workbench-app: couldn't raise the open-files limit from {was}");
        }
    }
}
