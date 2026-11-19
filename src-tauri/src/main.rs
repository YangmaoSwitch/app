// Prevents an extra console window on Windows in release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Called by the uninstaller when the user chooses to delete app data.
    if std::env::args().any(|a| a == "--purge") {
        yangmao_switch_lib::purge_keys();
        return;
    }
    yangmao_switch_lib::run()
}
