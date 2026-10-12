//! System-tray icon and menu. Left click shows or hides the dashboard; the menu covers display
//! mode, stacking, layout, settings, recovery and quitting.

use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, Wry};

use super::pomodoro::{Command, Phase, View};
use super::settings::{DisplayMode, WindowLayer};
use super::window;
use crate::commands;
use crate::state::AppState;

pub struct TrayHandles {
    pub icon: TrayIcon<Wry>,
    pub show: MenuItem<Wry>,
    pub focus: MenuItem<Wry>,
    pub ambient: CheckMenuItem<Wry>,
    pub windowed: CheckMenuItem<Wry>,
    pub compact: CheckMenuItem<Wry>,
    pub on_top: CheckMenuItem<Wry>,
}

pub fn build(app: &AppHandle) -> tauri::Result<TrayHandles> {
    let show = MenuItem::with_id(app, "show", "Hide FLIP", true, None::<&str>)?;
    let focus = MenuItem::with_id(app, "focus", "Start focus", true, None::<&str>)?;
    let reset_focus = MenuItem::with_id(app, "resetFocus", "Reset focus", true, None::<&str>)?;
    let ambient = CheckMenuItem::with_id(app, "ambient", "Ambient (fill display)", true, false, None::<&str>)?;
    let windowed = CheckMenuItem::with_id(app, "windowed", "Windowed", true, false, None::<&str>)?;
    let compact = CheckMenuItem::with_id(app, "compact", "Compact", true, false, None::<&str>)?;
    let on_top = CheckMenuItem::with_id(app, "ontop", "Keep on top", true, false, None::<&str>)?;
    let layout = MenuItem::with_id(app, "layout", "Next layout preset", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "Settings…", true, None::<&str>)?;
    let reset_layout = MenuItem::with_id(app, "resetLayout", "Reset layout and position", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit FLIP", true, None::<&str>)?;
    let seps: Vec<PredefinedMenuItem<Wry>> = (0..4).map(|_| PredefinedMenuItem::separator(app)).collect::<tauri::Result<_>>()?;
    let menu = Menu::with_items(
        app,
        &[
            &show,
            &seps[0],
            &focus,
            &reset_focus,
            &seps[1],
            &ambient,
            &windowed,
            &compact,
            &on_top,
            &layout,
            &seps[2],
            &settings,
            &reset_layout,
            &seps[3],
            &quit,
        ],
    )?;

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
    Ok(TrayHandles { icon, show, focus, ambient, windowed, compact, on_top })
}

fn on_menu(app: &AppHandle, id: &str) {
    let state = app.state::<AppState>();
    let set_mode = |m: DisplayMode| {
        window::show(app);
        let _ = commands::mutate_settings(app, &state, |s| s.window.mode = m);
    };
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
        "resetLayout" => {
            window::show(app);
            let _ = commands::reset_layout_now(app, &state);
        }
        "quit" => commands::quit(app),
        _ => {}
    }
    sync(app);
}

/// Keeps menu labels and checkmarks in sync with state.
pub fn sync(app: &AppHandle) {
    let Some(h) = app.try_state::<TrayHandles>() else { return };
    let state = app.state::<AppState>();
    let (mode, layer) = {
        let s = state.settings();
        (s.window.mode, s.window.layer)
    };
    let _ = h.ambient.set_checked(mode == DisplayMode::Ambient);
    let _ = h.windowed.set_checked(mode == DisplayMode::Windowed);
    let _ = h.compact.set_checked(mode == DisplayMode::Compact);
    let _ = h.on_top.set_checked(layer == WindowLayer::Top);
    let visible = window::main_window(app).and_then(|w| w.is_visible().ok()).unwrap_or(false);
    let _ = h.show.set_text(if visible { "Hide FLIP" } else { "Show FLIP" });
}

/// Tooltip and focus item reflect the timer.
pub fn sync_pomodoro(app: &AppHandle, v: &View) {
    let Some(h) = app.try_state::<TrayHandles>() else { return };
    let label = if v.running {
        "Pause focus"
    } else if v.phase == Phase::Idle {
        "Start focus"
    } else {
        "Resume focus"
    };
    let _ = h.focus.set_text(label);
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
