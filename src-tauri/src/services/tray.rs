//! System-tray icon and menu. Left click shows or hides the dashboard; the menu covers profiles,
//! display mode, stacking, layout, settings, recovery and quitting. The menu is rebuilt when the
//! profile list changes.

use std::sync::Mutex;

use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, Wry};

use super::pomodoro::{Command, Phase, View};
use super::settings::{DisplayMode, WindowLayer};
use super::window;
use crate::commands;
use crate::state::{lock, AppState};

struct Items {
    show: MenuItem<Wry>,
    focus: MenuItem<Wry>,
    ambient: CheckMenuItem<Wry>,
    windowed: CheckMenuItem<Wry>,
    compact: CheckMenuItem<Wry>,
    on_top: CheckMenuItem<Wry>,
    profiles: Vec<(String, CheckMenuItem<Wry>)>,
}

pub struct TrayHandles {
    icon: TrayIcon<Wry>,
    items: Items,
    /// (id, name) list the current menu was built from.
    built_for: Vec<(String, String)>,
}

fn profile_list(app: &AppHandle) -> (Vec<(String, String)>, String) {
    let s = app.state::<AppState>().settings().profiles.clone();
    (s.items.iter().map(|p| (p.id.clone(), p.name.clone())).collect(), s.active)
}

/// The menu, its live items, and the (id, name) profile list it was built from.
type BuiltMenu = (Menu<Wry>, Items, Vec<(String, String)>);

fn build_menu(app: &AppHandle) -> tauri::Result<BuiltMenu> {
    let (list, active) = profile_list(app);
    let show = MenuItem::with_id(app, "show", "Hide FLIP", true, None::<&str>)?;
    let focus = MenuItem::with_id(app, "focus", "Start focus", true, None::<&str>)?;
    let reset_focus = MenuItem::with_id(app, "resetFocus", "Reset focus", true, None::<&str>)?;
    let mut profiles = Vec::new();
    for (id, name) in &list {
        let item = CheckMenuItem::with_id(app, format!("profile:{id}"), name, true, *id == active, None::<&str>)?;
        profiles.push((id.clone(), item));
    }
    let refs: Vec<&dyn tauri::menu::IsMenuItem<Wry>> = profiles.iter().map(|(_, i)| i as &dyn tauri::menu::IsMenuItem<Wry>).collect();
    let profile_menu = Submenu::with_items(app, "Profile", true, &refs)?;
    let ambient = CheckMenuItem::with_id(app, "ambient", "Ambient (fill display)", true, false, None::<&str>)?;
    let windowed = CheckMenuItem::with_id(app, "windowed", "Windowed", true, false, None::<&str>)?;
    let compact = CheckMenuItem::with_id(app, "compact", "Compact", true, false, None::<&str>)?;
    let on_top = CheckMenuItem::with_id(app, "ontop", "Keep on top", true, false, None::<&str>)?;
    let layout = MenuItem::with_id(app, "layout", "Next layout preset", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "Settings…", true, None::<&str>)?;
    let to_primary = MenuItem::with_id(app, "toPrimary", "Move to primary display", true, None::<&str>)?;
    let reset_layout = MenuItem::with_id(app, "resetLayout", "Reset layout and position", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit FLIP", true, None::<&str>)?;
    let seps: Vec<PredefinedMenuItem<Wry>> = (0..5).map(|_| PredefinedMenuItem::separator(app)).collect::<tauri::Result<_>>()?;
    let menu = Menu::with_items(
        app,
        &[
            &show,
            &seps[0],
            &profile_menu,
            &seps[1],
            &focus,
            &reset_focus,
            &seps[2],
            &ambient,
            &windowed,
            &compact,
            &on_top,
            &layout,
            &seps[3],
            &settings,
            &to_primary,
            &reset_layout,
            &seps[4],
            &quit,
        ],
    )?;
    Ok((menu, Items { show, focus, ambient, windowed, compact, on_top, profiles }, list))
}

pub fn build(app: &AppHandle) -> tauri::Result<Mutex<TrayHandles>> {
    let (menu, items, built_for) = build_menu(app)?;
    let mut builder = TrayIconBuilder::with_id("flip-tray")
        .tooltip("FLIP")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| on_menu(app, event.id().as_ref()))
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                window::toggle_visible(tray.app_handle());
                sync(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    let icon = builder.build(app)?;
    Ok(Mutex::new(TrayHandles { icon, items, built_for }))
}

fn on_menu(app: &AppHandle, id: &str) {
    let state = app.state::<AppState>();
    let set_mode = |m: DisplayMode| {
        window::show(app);
        let _ = commands::mutate_settings(app, &state, |s| s.window.mode = m);
    };
    if let Some(pid) = id.strip_prefix("profile:") {
        if let Err(e) = commands::activate_profile_now(app, &state, pid) {
            log::warn!("profile switch failed: {e}");
        }
        sync(app);
        return;
    }
    match id {
        "show" => window::toggle_visible(app),
        "focus" => {
            let _ = commands::apply_pomodoro(app, &state, Command::Toggle);
        }
        "resetFocus" => {
            let _ = commands::apply_pomodoro(app, &state, Command::Reset);
        }
        "ambient" => set_mode(DisplayMode::Ambient),
        "windowed" => set_mode(DisplayMode::Windowed),
        "compact" => set_mode(DisplayMode::Compact),
        "ontop" => {
            let _ = commands::mutate_settings(app, &state, |s| {
                s.window.layer = if s.window.layer == WindowLayer::Top { WindowLayer::Desktop } else { WindowLayer::Top }
            });
        }
        "layout" => {
            let _ = commands::mutate_settings(app, &state, |s| s.modules.preset = s.modules.preset.next());
        }
        "settings" => commands::show_panel(app, &state, "settings"),
        "toPrimary" => {
            window::show(app);
            let _ = commands::mutate_settings(app, &state, |s| {
                s.window.display = None;
                s.window.display_id = None;
            });
        }
        "resetLayout" => {
            window::show(app);
            let _ = commands::reset_layout_now(app, &state);
        }
        "quit" => commands::quit(app),
        _ => {}
    }
    sync(app);
}

/// Rebuilds the menu when the profile list (ids or names) changed.
pub fn rebuild_if_needed(app: &AppHandle) {
    let Some(h) = app.try_state::<Mutex<TrayHandles>>() else { return };
    let (list, _) = profile_list(app);
    let mut h = lock(&h);
    if h.built_for == list {
        return;
    }
    match build_menu(app) {
        Ok((menu, items, built_for)) => {
            if let Err(e) = h.icon.set_menu(Some(menu)) {
                log::warn!("tray menu not updated: {e}");
                return;
            }
            h.items = items;
            h.built_for = built_for;
        }
        Err(e) => log::warn!("tray menu not rebuilt: {e}"),
    }
}

/// Keeps menu labels and checkmarks in sync with state.
pub fn sync(app: &AppHandle) {
    rebuild_if_needed(app);
    let Some(h) = app.try_state::<Mutex<TrayHandles>>() else { return };
    let h = lock(&h);
    let state = app.state::<AppState>();
    let (mode, layer, active) = {
        let s = state.settings();
        (s.window.mode, s.window.layer, s.profiles.active.clone())
    };
    let i = &h.items;
    let _ = i.ambient.set_checked(mode == DisplayMode::Ambient);
    let _ = i.windowed.set_checked(mode == DisplayMode::Windowed);
    let _ = i.compact.set_checked(mode == DisplayMode::Compact);
    let _ = i.on_top.set_checked(layer == WindowLayer::Top);
    for (id, item) in &i.profiles {
        let _ = item.set_checked(*id == active);
    }
    let visible = window::main_window(app).and_then(|w| w.is_visible().ok()).unwrap_or(false);
    let _ = i.show.set_text(if visible { "Hide FLIP" } else { "Show FLIP" });
}

/// Tooltip and focus item reflect the timer.
pub fn sync_pomodoro(app: &AppHandle, v: &View) {
    let Some(h) = app.try_state::<Mutex<TrayHandles>>() else { return };
    let h = lock(&h);
    let label = if v.running {
        "Pause focus"
    } else if v.phase == Phase::Idle {
        "Start focus"
    } else {
        "Resume focus"
    };
    let _ = h.items.focus.set_text(label);
    let tip = if v.phase == Phase::Idle {
        "FLIP".to_string()
    } else {
        let s = (v.remaining_ms + 999) / 1000;
        let phase = match v.phase {
            Phase::Focus => "Focus",
            Phase::ShortBreak => "Short break",
            Phase::LongBreak => "Long break",
            Phase::Idle => "",
        };
        format!("FLIP · {phase} {:02}:{:02}{}", s / 60, s % 60, if v.running { "" } else { " (paused)" })
    };
    let _ = h.icon.set_tooltip(Some(tip));
}
