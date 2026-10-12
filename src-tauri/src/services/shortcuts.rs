//! System-wide shortcuts. FLIP usually sits behind other windows without keyboard focus, so
//! show/hide, settings, layout switching and the focus timer are registered globally.

use std::collections::BTreeMap;

use tauri::{AppHandle, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

use super::settings::ShortcutSettings;
use crate::commands;
use crate::services::pomodoro::Command;
use crate::state::{lock, AppState};

/// Re-registers every shortcut. Returns per-action status: "OK" or why it failed.
pub fn register(app: &AppHandle, s: &ShortcutSettings) -> BTreeMap<String, String> {
    let gs = app.global_shortcut();
    let _ = gs.unregister_all();
    let mut status = BTreeMap::new();
    for (action, keys) in s.entries() {
        let action_owned = action.to_string();
        let result = gs.on_shortcut(keys, move |app, _sc, ev| {
            if ev.state == ShortcutState::Pressed {
                run(app, &action_owned);
            }
        });
        let st = match result {
            Ok(()) => "OK".to_string(),
            Err(e) => {
                log::warn!("shortcut {keys} for {action} unavailable: {e}");
                "IN USE BY ANOTHER APP".to_string()
            }
        };
        status.insert(action.to_string(), st);
    }
    *lock(&app.state::<AppState>().shortcut_status) = status.clone();
    status
}

fn run(app: &AppHandle, action: &str) {
    let state = app.state::<AppState>();
    match action {
        "toggle" => super::window::toggle_visible(app),
        "settings" => commands::show_panel(app, &state, "settings"),
        "layout" => {
            let _ = commands::mutate_settings(app, &state, |s| s.modules.preset = s.modules.preset.next());
        }
        "focus" => {
            let _ = commands::apply_pomodoro(app, &state, Command::Toggle);
        }
        "profile" => commands::next_profile(app, &state),
        _ => {}
    }
}
