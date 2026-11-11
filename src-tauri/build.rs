fn main() {
    // App commands. Each gets allow-/deny- permissions (e.g. "allow-app-info"), granted at runtime: app_info,
    // notify and update_* to the board's origin (src/lib.rs), retry to the bundled fallback page only (src/server.rs).
    // probe_result exists only in debug builds (src/probe.rs); in release its permission is defined but never
    // granted, and the command isn't registered.
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(
            tauri_build::AppManifest::new().commands(&[
                "app_info",
                "notify",
                "probe_result",
                "retry",
                "update_state",
                "update_check",
                "update_install",
                "update_later",
                "update_skip",
                "update_auto",
                "update_seen",
            ]),
        ),
    )
    .expect("failed to run tauri-build");
}
