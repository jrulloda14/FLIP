fn main() {
    // Declaring the app's commands generates one `allow-<command>` permission per command, so
    // capabilities/default.json can grant them explicitly instead of exposing everything.
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(&[
        "get_bootstrap",
        "update_settings",
        "restore_default_settings",
        "pomodoro_command",
        "refresh_ai",
        "set_manual_usage",
        "clear_manual_usage",
        "window_command",
        "open_panel",
        "close_panel",
        "apply_region",
        "reset_layout",
        "completion_action",
        "open_support_page",
        "activate_profile",
        "create_profile",
        "rename_profile",
        "delete_profile",
        "reset_profile",
    ])))
    .expect("failed to run tauri-build");
}
