fn main() {
    // `WB_CHANNEL=nightly` (scripts/nightly.ts) builds the nightly: its own port, data, icon (lib.rs NIGHTLY).
    println!("cargo:rerun-if-env-changed=WB_CHANNEL");
    println!("cargo::rustc-check-cfg=cfg(wb_nightly)");
    if std::env::var("WB_CHANNEL").as_deref() == Ok("nightly") {
        println!("cargo:rustc-cfg=wb_nightly");
    }
    // App commands. Each gets allow-/deny- permissions (e.g. "allow-app-info"), granted at runtime: app_info,
    // notify, update_*, zoom and autostart to the board's origin (src/lib.rs), retry to the bundled fallback page only (src/server.rs).
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
                "zoom",
                "autostart",
            ]),
        ),
    )
    .expect("failed to run tauri-build");
}
