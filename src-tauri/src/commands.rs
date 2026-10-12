//! IPC commands exposed to the webviews. Each one validates its input; none of them accepts paths,
//! shell commands or arbitrary keys. The allow-list lives in build.rs and capabilities/default.json.

use std::collections::BTreeMap;

use chrono::Utc;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_autostart::ManagerExt as _;

use crate::error::{AppError, AppResult};
use crate::services::ai_usage::{self, UsageSnapshot};
use crate::services::pomodoro::{self, Command, View};
use crate::services::settings::{
    self, AppearanceSettings, ClaudeSource, CodexSource, ManualUsage, ManualWindow, ModuleSettings, Settings, WindowSettings,
};
use crate::services::system_monitor::SystemSnapshot;
use crate::services::window::{self, DisplayInfo, Region};
use crate::services::world_clock::{self, ClockSnapshot};
use crate::services::{desktop_layer, shortcuts, tray};
use crate::state::{lock, AppState};

pub const EVT_CLOCK: &str = "flip://clock";
pub const EVT_SYSTEM: &str = "flip://system";
pub const EVT_POMODORO: &str = "flip://pomodoro";
pub const EVT_AI: &str = "flip://ai";
pub const EVT_SETTINGS: &str = "flip://settings";
pub const EVT_STATUS: &str = "flip://status";
pub const EVT_PANEL: &str = "flip://panel";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlatformInfo {
    is_debug: bool,
    app_version: String,
    data_dir: String,
    claude_statusline_command: String,
}

/// Window-environment facts the UI shows but does not own.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeStatus {
    displays: Vec<DisplayInfo>,
    display_notice: Option<String>,
    shortcut_status: BTreeMap<String, String>,
    /// Solid desktop colour to blend with, or None when a wallpaper image is set.
    desktop_color: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Bootstrap {
    settings: Settings,
    settings_notice: Option<String>,
    clock: ClockSnapshot,
    system: Option<SystemSnapshot>,
    pomodoro: View,
    ai: Vec<UsageSnapshot>,
    platform: PlatformInfo,
    time_zones: Vec<String>,
    system_time_zone: String,
    status: RuntimeStatus,
    panel_view: String,
}

pub fn clock_snapshot(state: &AppState) -> ClockSnapshot {
    let s = state.settings();
    world_clock::snapshot(Utc::now(), s.clock.home_time_zone.as_deref(), &s.cities)
}

pub fn pomodoro_view(state: &AppState) -> View {
    let cfg = state.settings().focus.clone();
    let today = state.today();
    lock(&state.pomodoro).view(Utc::now(), today, &cfg)
}

pub fn runtime_status(app: &AppHandle) -> RuntimeStatus {
    let state = app.state::<AppState>();
    let display_notice = lock(&state.display_notice).clone();
    let shortcut_status = lock(&state.shortcut_status).clone();
    let desktop_color = lock(&state.desktop_color).clone();
    RuntimeStatus {
        desktop_color,
        displays: window::main_window(app).map(|w| window::list_displays(&w)).unwrap_or_default(),
        display_notice,
        shortcut_status,
    }
}

pub fn emit_status(app: &AppHandle) {
    let _ = app.emit(EVT_STATUS, runtime_status(app));
}

/// The exact command to paste into Claude Code's `statusLine` setting.
fn statusline_command() -> String {
    let exe = std::env::current_exe().map(|p| p.display().to_string()).unwrap_or_else(|_| "flip.exe".into());
    format!("\"{exe}\" --claude-statusline")
}

#[tauri::command]
pub fn get_bootstrap(app: AppHandle, state: State<'_, AppState>) -> AppResult<Bootstrap> {
    // The settings notice is shown once, by the dashboard.
    let notice = lock(&state.settings_notice).take();
    Ok(Bootstrap {
        settings: state.settings().clone(),
        settings_notice: notice,
        clock: clock_snapshot(&state),
        system: lock(&state.system).clone(),
        pomodoro: pomodoro_view(&state),
        ai: lock(&state.ai).last.clone(),
        platform: PlatformInfo {
            is_debug: state.allow_demo,
            app_version: app.package_info().version.to_string(),
            data_dir: state.paths.dir.display().to_string(),
            claude_statusline_command: statusline_command(),
        },
        time_zones: world_clock::all_zones(),
        system_time_zone: world_clock::system_time_zone(),
        status: runtime_status(&app),
        panel_view: lock(&state.panel_view).clone(),
    })
}

/// Validates, stores, persists and applies new settings, then broadcasts them.
pub fn store_settings(app: &AppHandle, state: &AppState, mut next: Settings) -> AppResult<Settings> {
    let fixes = next.validate(state.allow_demo);
    if !fixes.is_empty() {
        log::info!("settings adjusted on save: {}", fixes.join("; "));
    }
    let prev = {
        let mut cur = state.settings_mut();
        // Saved rectangles are owned by the backend; the webview may hold an older copy.
        next.window.windowed_rect = cur.window.windowed_rect.clone();
        next.window.compact_rect = cur.window.compact_rect.clone();
        std::mem::replace(&mut *cur, next.clone())
    };
    settings::save(&state.paths.settings(), &next)?;
    apply_side_effects(app, state, &prev, &next);
    let _ = app.emit(EVT_SETTINGS, &next);
    Ok(next)
}

pub fn mutate_settings(app: &AppHandle, state: &AppState, f: impl FnOnce(&mut Settings)) -> AppResult<Settings> {
    let mut s = state.settings().clone();
    f(&mut s);
    store_settings(app, state, s)
}

/// Positions the dashboard for its mode and display, applies the layer, and reports fallback.
pub fn apply_window(app: &AppHandle, state: &AppState, w: &WindowSettings) {
    let Some(win) = window::main_window(app) else { return };
    let notice = window::place(&win, w);
    state.display_fallback.store(notice.is_some(), std::sync::atomic::Ordering::SeqCst);
    *lock(&state.display_notice) = notice;
    desktop_layer::apply_layer(&win, w.layer);
    emit_status(app);
}

fn apply_side_effects(app: &AppHandle, state: &AppState, prev: &Settings, next: &Settings) {
    let (pw, nw) = (&prev.window, &next.window);
    if pw.mode != nw.mode || pw.display != nw.display {
        apply_window(app, state, nw);
    } else if pw.layer != nw.layer {
        if let Some(win) = window::main_window(app) {
            desktop_layer::apply_layer(&win, nw.layer);
        }
    }
    if pw.launch_on_startup != nw.launch_on_startup {
        let al = app.autolaunch();
        let r = if nw.launch_on_startup { al.enable() } else { al.disable() };
        if let Err(e) = r {
            log::warn!("launch-on-startup change failed: {e}");
        }
    }
    if prev.shortcuts != next.shortcuts {
        shortcuts::register(app, &next.shortcuts);
        emit_status(app);
    }
    if prev.focus != next.focus {
        lock(&state.pomodoro).apply_settings(&next.focus);
        let _ = app.emit(EVT_POMODORO, pomodoro_view(state));
    }
    if prev.ai != next.ai {
        state.ai_wake.notify_one();
    }
    if prev.cities != next.cities || prev.clock.home_time_zone != next.clock.home_time_zone {
        let _ = app.emit(EVT_CLOCK, clock_snapshot(state));
    }
    tray::sync(app);
}

#[tauri::command]
pub fn update_settings(app: AppHandle, state: State<'_, AppState>, settings: Settings) -> AppResult<Settings> {
    store_settings(&app, &state, settings)
}

#[tauri::command]
pub fn restore_default_settings(app: AppHandle, state: State<'_, AppState>) -> AppResult<Settings> {
    let s = store_settings(&app, &state, Settings::default())?;
    reset_rects(&app, &state);
    Ok(s)
}

fn reset_rects(app: &AppHandle, state: &AppState) {
    let w = {
        let mut s = state.settings_mut();
        s.window.windowed_rect = None;
        s.window.compact_rect = None;
        s.window.clone()
    };
    if let Err(e) = settings::save(&state.paths.settings(), &state.settings()) {
        log::warn!("settings not saved: {e}");
    }
    apply_window(app, state, &w);
}

/// Restores display mode, layer, regions, layout and appearance; keeps clocks, AI, focus and startup.
pub fn reset_layout_now(app: &AppHandle, state: &AppState) -> AppResult<Settings> {
    let s = mutate_settings(app, state, |s| {
        let keep = (s.window.launch_on_startup, s.window.start_hidden, s.window.close_to_tray);
        s.window = WindowSettings::default();
        (s.window.launch_on_startup, s.window.start_hidden, s.window.close_to_tray) = keep;
        s.modules = ModuleSettings::default();
        s.appearance = AppearanceSettings::default();
    })?;
    reset_rects(app, state);
    Ok(s)
}

#[tauri::command]
pub fn reset_layout(app: AppHandle, state: State<'_, AppState>) -> AppResult<Settings> {
    reset_layout_now(&app, &state)
}

#[tauri::command]
pub fn apply_region(app: AppHandle, state: State<'_, AppState>, region: Region) -> AppResult<Settings> {
    // Regions only make sense for a movable window; switch out of ambient first.
    if state.settings().window.mode == settings::DisplayMode::Ambient {
        mutate_settings(&app, &state, |s| s.window.mode = settings::DisplayMode::Windowed)?;
    }
    let win = window::main_window(&app).ok_or_else(|| AppError::Window("main window missing".into()))?;
    window::apply_region(&win, &state, region);
    let s = state.settings().clone();
    settings::save(&state.paths.settings(), &s)?;
    let _ = app.emit(EVT_SETTINGS, &s);
    Ok(s)
}

pub fn apply_pomodoro(app: &AppHandle, state: &AppState, cmd: Command) -> View {
    let cfg = state.settings().focus.clone();
    let today = state.today();
    let view = {
        let mut t = lock(&state.pomodoro);
        t.command(cmd, Utc::now(), today, &cfg);
        if let Err(e) = pomodoro::save(&state.paths.pomodoro(), &t) {
            log::warn!("pomodoro state not saved: {e}");
        }
        t.view(Utc::now(), today, &cfg)
    };
    tray::sync_pomodoro(app, &view);
    let _ = app.emit(EVT_POMODORO, &view);
    view
}

#[tauri::command]
pub fn pomodoro_command(app: AppHandle, state: State<'_, AppState>, command: Command) -> View {
    apply_pomodoro(&app, &state, command)
}

/// Refreshes every provider. File reads run off the async runtime.
pub async fn refresh_ai_now(app: &AppHandle, force: bool) -> Vec<UsageSnapshot> {
    let app2 = app.clone();
    let res = tauri::async_runtime::spawn_blocking(move || {
        let state = app2.state::<AppState>();
        let s = state.settings().ai.clone();
        let providers = ai_usage::providers_for(&s, &state.paths, state.allow_demo);
        let now = Utc::now();
        let mut ai = lock(&state.ai);
        let snaps: Vec<UsageSnapshot> = providers.iter().map(|p| ai.cache.refresh(p.as_ref(), now, force)).collect();
        ai.last = snaps.clone();
        ai.cache.save(&state.paths.ai_cache());
        snaps
    })
    .await;
    match res {
        Ok(snaps) => {
            let _ = app.emit(EVT_AI, &snaps);
            snaps
        }
        Err(e) => {
            log::error!("ai refresh task failed: {e}");
            lock(&app.state::<AppState>().ai).last.clone()
        }
    }
}

#[tauri::command]
pub async fn refresh_ai(app: AppHandle) -> AppResult<Vec<UsageSnapshot>> {
    Ok(refresh_ai_now(&app, true).await)
}

fn check_provider(id: &str) -> AppResult<()> {
    match id {
        "claude" | "codex" => Ok(()),
        _ => Err(AppError::Invalid("unknown provider".into())),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManualWindowInput {
    key: String,
    used_percent: f64,
    resets_at: Option<chrono::DateTime<Utc>>,
}

#[tauri::command]
pub async fn set_manual_usage(
    app: AppHandle,
    state: State<'_, AppState>,
    provider_id: String,
    windows: Vec<ManualWindowInput>,
) -> AppResult<Vec<UsageSnapshot>> {
    check_provider(&provider_id)?;
    if windows.is_empty() || windows.len() > 4 {
        return Err(AppError::Invalid("enter between 1 and 4 windows".into()));
    }
    let mut clean = Vec::with_capacity(windows.len());
    for w in windows {
        let key = w.key.trim().to_uppercase();
        if key.is_empty() || key.chars().count() > 4 || !key.chars().all(|c| c.is_ascii_alphanumeric()) {
            return Err(AppError::Invalid("window key must be 1–4 letters or digits, e.g. 5H".into()));
        }
        if !w.used_percent.is_finite() || !(0.0..=100.0).contains(&w.used_percent) {
            return Err(AppError::Invalid("used percent must be 0–100".into()));
        }
        clean.push(ManualWindow { key, used_percent: w.used_percent, resets_at: w.resets_at });
    }
    let id = provider_id.clone();
    mutate_settings(&app, &state, move |s| {
        s.ai.manual.insert(id.clone(), ManualUsage { windows: clean, entered_at: Utc::now() });
        match id.as_str() {
            "claude" => s.ai.claude.source = ClaudeSource::Manual,
            _ => s.ai.codex.source = CodexSource::Manual,
        }
    })?;
    Ok(refresh_ai_now(&app, true).await)
}

#[tauri::command]
pub async fn clear_manual_usage(app: AppHandle, state: State<'_, AppState>, provider_id: String) -> AppResult<Vec<UsageSnapshot>> {
    check_provider(&provider_id)?;
    mutate_settings(&app, &state, |s| {
        s.ai.manual.remove(&provider_id);
    })?;
    Ok(refresh_ai_now(&app, true).await)
}

/// Opens the settings/detail panel on a given view.
pub fn show_panel(app: &AppHandle, state: &AppState, view: &str) {
    *lock(&state.panel_view) = view.to_string();
    let _ = app.emit_to(window::PANEL, EVT_PANEL, view);
    window::open_panel(app, view);
}

#[tauri::command]
pub fn open_panel(app: AppHandle, state: State<'_, AppState>, view: String) -> AppResult<()> {
    if !window::valid_panel_view(&view) {
        return Err(AppError::Invalid("unknown panel view".into()));
    }
    show_panel(&app, &state, &view);
    Ok(())
}

#[tauri::command]
pub fn close_panel(app: AppHandle) {
    window::close_panel(&app);
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WindowCommand {
    /// Hide the dashboard (restore from the tray or the toggle shortcut).
    Hide,
    Quit,
}

pub fn quit(app: &AppHandle) {
    app.state::<AppState>().begin_shutdown();
    app.exit(0);
}

#[tauri::command]
pub fn window_command(app: AppHandle, command: WindowCommand) {
    match command {
        WindowCommand::Hide => window::hide(&app),
        WindowCommand::Quit => quit(&app),
    }
    tray::sync(&app);
}
