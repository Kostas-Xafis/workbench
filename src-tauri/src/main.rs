// Keeps a console window from opening on Windows in release; harmless elsewhere.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    workbench_app_lib::run()
}
