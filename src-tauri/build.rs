fn main() {
    // App commands the board page may call. Each gets allow-/deny- permissions (e.g. "allow-app-info"),
    // which src/lib.rs grants to the board's origin at runtime. probe_result exists only in debug builds
    // (src/probe.rs); in release its permission is defined but never granted, and the command isn't registered.
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(
            tauri_build::AppManifest::new().commands(&["app_info", "notify", "probe_result"]),
        ),
    )
    .expect("failed to run tauri-build");
}
