//! Page zoom in the app, like a browser's: WebKitGTK has a zoom level, but nothing in a Tauri window turns it on.
//!
//! The page catches Ctrl + / Ctrl − / Ctrl 0 and Ctrl + scroll (and a report's, which its bridge passes up) and
//! calls [`zoom`] with a step. The level moves along fixed stops, is set on the webview (WebKit's own zoom, so
//! text stays sharp), and is kept in app.json `zoom` for the next run, where [`restore`] sets it again.

use tauri::{AppHandle, Manager, Runtime, WebviewWindow};

use crate::server;

/// The stops Ctrl + and Ctrl − move along, as in a browser.
const LEVELS: [f64; 11] = [0.5, 0.67, 0.75, 0.8, 0.9, 1.0, 1.1, 1.25, 1.5, 1.75, 2.0];

fn saved<R: Runtime>(app: &AppHandle<R>) -> f64 {
    server::settings(app)
        .get("zoom")
        .and_then(|z| z.as_f64())
        .filter(|z| z.is_finite())
        .map(|z| z.clamp(LEVELS[0], LEVELS[LEVELS.len() - 1]))
        .unwrap_or(1.0)
}

/// The next stop from `now`: `step` > 0 bigger, < 0 smaller, 0 back to 100%.
fn next(now: f64, step: i32) -> f64 {
    const EPS: f64 = 1e-3;
    match step.signum() {
        0 => 1.0,
        1 => LEVELS.iter().copied().find(|&l| l > now + EPS).unwrap_or(LEVELS[LEVELS.len() - 1]),
        _ => LEVELS.iter().rev().copied().find(|&l| l < now - EPS).unwrap_or(LEVELS[0]),
    }
}

/// Zooms the board's window one stop in (`step` 1), out (-1) or back to 100% (0). Returns the new level.
#[tauri::command]
pub fn zoom<R: Runtime>(window: WebviewWindow<R>, step: i32) -> Result<f64, String> {
    let app = window.app_handle();
    let level = next(saved(app), step);
    window.set_zoom(level).map_err(|e| e.to_string())?;
    server::save_setting(app, "zoom", serde_json::json!(level))?;
    Ok(level)
}

/// The current zoom level (1.0 = 100%), for Settings → Appearance.
#[tauri::command]
pub fn zoom_level<R: Runtime>(window: WebviewWindow<R>) -> f64 {
    saved(window.app_handle())
}

/// Sets the zoom kept from the last run on a newly built window.
pub fn restore<R: Runtime>(window: &WebviewWindow<R>) {
    let level = saved(window.app_handle());
    if (level - 1.0).abs() > 1e-3 {
        if let Err(e) = window.set_zoom(level) {
            eprintln!("workbench-app: couldn't set the zoom: {e}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::next;

    #[test]
    fn steps_along_the_stops() {
        assert_eq!(next(1.0, 1), 1.1);
        assert_eq!(next(1.0, -1), 0.9);
        assert_eq!(next(1.3, 1), 1.5);
        assert_eq!(next(1.3, -1), 1.25);
        assert_eq!(next(2.0, 1), 2.0);
        assert_eq!(next(0.5, -1), 0.5);
        assert_eq!(next(1.75, 0), 1.0);
    }
}
