//! IPC commands exposed to the webviews. Each one validates its input; none of them accepts paths,
//! shell commands or arbitrary keys. The allow-list lives in build.rs and capabilities/default.json.

use std::collections::BTreeMap;

use chrono::Utc;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_autostart::ManagerExt as _;

use crate::error::{AppError, AppResult};
use crate::services::ai_usage::{self, UsageSnapshot};
use crate::services::completion::{CompletionAction, CompletionNotice};
use crate::services::pomodoro::{self, Command, View};
use crate::services::profiles::{self, Profile};
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
/// Timer-completion card: the pending notice, or null when it is answered or cleared.
pub const EVT_COMPLETION: &str = "flip://completion";

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
    /// A timer-completion card waiting to be answered (for a window that loads late).
    completion: Option<CompletionNotice>,
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
        completion: lock(&state.completions).pending().cloned(),
    })
}

/// Who produced a settings update.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Origin {
    /// The settings panel. It may hold stale copies of backend-owned fields.
    Ui,
    /// The backend itself (tray, shortcuts, profile switches), starting from the current state.
    Backend,
}

/// Validates, stores, persists and applies settings from the settings panel, then broadcasts them.
pub fn store_settings(app: &AppHandle, state: &AppState, next: Settings) -> AppResult<Settings> {
    store_settings_from(app, state, next, Origin::Ui)
}

pub fn store_settings_from(app: &AppHandle, state: &AppState, mut next: Settings, origin: Origin) -> AppResult<Settings> {
    let prev = {
        let mut cur = state.settings_mut();
        if origin == Origin::Ui {
            // Saved rectangles, regions and the profile list are owned by the backend; the
            // webview may hold an older copy. Profiles change only through the profile commands.
            next.window.windowed_rect = cur.window.windowed_rect.clone();
            next.window.compact_rect = cur.window.compact_rect.clone();
            next.window.windowed_region = cur.window.windowed_region;
            next.window.compact_region = cur.window.compact_region;
            next.profiles.items = cur.profiles.items.clone();
            next.profiles.active = cur.profiles.active.clone();
        }
        // Validation also writes the live layout back into the active profile.
        let fixes = next.validate(state.allow_demo);
        if !fixes.is_empty() {
            log::info!("settings adjusted on save: {}", fixes.join("; "));
        }
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
    store_settings_from(app, state, s, Origin::Backend)
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
    // Placement changes (mode, display, or a profile switch that brings its own rectangles).
    let placement_changed = pw.mode != nw.mode
        || pw.display != nw.display
        || pw.display_id != nw.display_id
        || pw.windowed_rect != nw.windowed_rect
        || pw.compact_rect != nw.compact_rect
        || pw.windowed_region != nw.windowed_region
        || pw.compact_region != nw.compact_region;
    if placement_changed {
        // Moves and resizes only; never activates or focuses the window.
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
    // "Everything": defaults including the profile list.
    let s = store_settings_from(&app, &state, Settings::default(), Origin::Backend)?;
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
    // Changing the timer from anywhere answers an open completion card.
    clear_completion(app, state);
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

/// The project's support page. The only web address FLIP ever opens, and only on a click.
pub const SUPPORT_URL: &str = "https://buymeacoffee.com/flipdashboard";

/// Opens the Buy Me a Coffee page in the default browser. Takes no arguments, so the
/// webview cannot use it to open anything else.
#[tauri::command]
pub fn open_support_page() -> AppResult<()> {
    #[cfg(windows)]
    {
        use windows::core::{w, HSTRING};
        use windows::Win32::UI::Shell::ShellExecuteW;
        use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
        let r = unsafe { ShellExecuteW(None, w!("open"), &HSTRING::from(SUPPORT_URL), None, None, SW_SHOWNORMAL) };
        // ShellExecuteW reports success with a value greater than 32.
        if r.0 as isize <= 32 {
            return Err(AppError::Invalid("could not open the browser".into()));
        }
    }
    Ok(())
}

/// Shows the completion card's window unless a fullscreen app or presentation is running
/// (then it waits; the clock loop retries every second).
pub fn show_completion_if_ready(app: &AppHandle, state: &AppState) {
    use std::sync::atomic::Ordering;
    if lock(&state.completions).pending().is_none() || state.toast_visible.load(Ordering::SeqCst) {
        return;
    }
    if desktop_layer::is_fullscreen_app_running() {
        return;
    }
    state.toast_visible.store(true, Ordering::SeqCst);
    window::show_toast(app);
}

fn hide_completion_window(app: &AppHandle, state: &AppState) {
    state.toast_visible.store(false, std::sync::atomic::Ordering::SeqCst);
    window::hide_toast(app);
}

/// Removes an open completion card that the user answered some other way (tray, shortcut,
/// dashboard). The card animates out before its window hides.
pub fn clear_completion(app: &AppHandle, state: &AppState) {
    if !lock(&state.completions).clear() {
        return;
    }
    let _ = app.emit(EVT_COMPLETION, None::<CompletionNotice>);
    let app = app.clone();
    let _ = std::thread::Builder::new().name("flip-toast-hide".into()).spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(260));
        let state = app.state::<AppState>();
        if lock(&state.completions).pending().is_none() {
            hide_completion_window(&app, &state);
        }
    });
}

/// Answers the completion card `id`. `startNext` starts the phase the timer already moved to;
/// `dismiss` only closes the card. A stale or repeated id does nothing.
#[tauri::command]
pub fn completion_action(app: AppHandle, state: State<'_, AppState>, id: u64, action: CompletionAction) -> View {
    let resolved = lock(&state.completions).resolve(id);
    if resolved {
        let _ = app.emit(EVT_COMPLETION, None::<CompletionNotice>);
        hide_completion_window(&app, &state);
        if action == CompletionAction::StartNext {
            return apply_pomodoro(&app, &state, Command::Start);
        }
    }
    pomodoro_view(&state)
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

// ------------------------------------------------------------------ profiles

/// Switches to a profile: copies its snapshot into the live settings and re-places the window
/// (without focusing it). Global preferences are untouched.
pub fn activate_profile_now(app: &AppHandle, state: &AppState, id: &str) -> AppResult<Settings> {
    let cur = state.settings().clone();
    let p = cur.profiles.items.iter().find(|p| p.id == id).cloned().ok_or_else(|| AppError::Invalid("unknown profile".into()))?;
    let mut next = cur;
    profiles::apply(&mut next, &p);
    next.profiles.active = p.id.clone();
    let s = store_settings_from(app, state, next, Origin::Backend)?;
    log::info!("profile switched to {}", p.name);
    Ok(s)
}

#[tauri::command]
pub fn activate_profile(app: AppHandle, state: State<'_, AppState>, id: String) -> AppResult<Settings> {
    activate_profile_now(&app, &state, &id)
}

/// Creates a custom profile from another profile (`from`) or from the current layout, and
/// switches to it.
#[tauri::command]
pub fn create_profile(app: AppHandle, state: State<'_, AppState>, name: String, from: Option<String>) -> AppResult<Settings> {
    let cur = state.settings().clone();
    if cur.profiles.items.len() >= profiles::MAX_PROFILES {
        return Err(AppError::Invalid(format!("up to {} profiles", profiles::MAX_PROFILES)));
    }
    let id = profiles::new_id(&cur.profiles.items, Utc::now().timestamp_millis());
    let name = profiles::unique_name(&cur.profiles.items, &name);
    let mut p = match from.as_deref() {
        Some(src) => cur.profiles.items.iter().find(|p| p.id == src).cloned().ok_or_else(|| AppError::Invalid("unknown profile".into()))?,
        None => profiles::capture(&cur, "", "", false),
    };
    p.id = id.clone();
    p.name = name;
    p.builtin = false;
    let mut next = cur;
    next.profiles.items.push(p);
    store_settings_from(&app, &state, next, Origin::Backend)?;
    activate_profile_now(&app, &state, &id)
}

#[tauri::command]
pub fn rename_profile(app: AppHandle, state: State<'_, AppState>, id: String, name: String) -> AppResult<Settings> {
    let cur = state.settings().clone();
    let clean = profiles::clean_name(&name);
    if clean.is_empty() {
        return Err(AppError::Invalid("enter a name".into()));
    }
    let others: Vec<_> = cur.profiles.items.iter().filter(|p| p.id != id).cloned().collect();
    if others.iter().any(|p| p.name == clean) {
        return Err(AppError::Invalid("another profile already has that name".into()));
    }
    let mut next = cur;
    let p = next.profiles.items.iter_mut().find(|p| p.id == id).ok_or_else(|| AppError::Invalid("unknown profile".into()))?;
    if p.builtin {
        return Err(AppError::Invalid("built-in profiles cannot be renamed; duplicate it instead".into()));
    }
    p.name = clean;
    store_settings_from(&app, &state, next, Origin::Backend)
}

#[tauri::command]
pub fn delete_profile(app: AppHandle, state: State<'_, AppState>, id: String) -> AppResult<Settings> {
    let cur = state.settings().clone();
    let p = cur.profiles.items.iter().find(|p| p.id == id).ok_or_else(|| AppError::Invalid("unknown profile".into()))?;
    if p.builtin {
        return Err(AppError::Invalid("built-in profiles cannot be deleted".into()));
    }
    let was_active = cur.profiles.active == id;
    let mut next = cur;
    next.profiles.items.retain(|p| p.id != id);
    if was_active {
        // Move to CUSTOM first so the deleted layout is not written back anywhere.
        next.profiles.active = "custom".into();
        if let Some(c) = next.profiles.items.iter().find(|p| p.id == "custom").cloned() {
            profiles::apply(&mut next, &c);
        }
    }
    store_settings_from(&app, &state, next, Origin::Backend)
}

/// Restores a built-in profile to its factory layout (applied immediately if it is active).
#[tauri::command]
pub fn reset_profile(app: AppHandle, state: State<'_, AppState>, id: String) -> AppResult<Settings> {
    if !profiles::BUILTIN_IDS.contains(&id.as_str()) {
        return Err(AppError::Invalid("only built-in profiles can be reset".into()));
    }
    let cur = state.settings().clone();
    let fresh = profiles::builtin(&id);
    let mut next = cur;
    let is_active = next.profiles.active == id;
    if let Some(p) = next.profiles.items.iter_mut().find(|p| p.id == id) {
        *p = Profile { name: p.name.clone(), ..fresh.clone() };
    }
    if is_active {
        profiles::apply(&mut next, &fresh);
    }
    store_settings_from(&app, &state, next, Origin::Backend)
}

/// Optional automatic switching when the number of connected displays changes.
pub fn auto_switch_profile(app: &AppHandle, state: &AppState, display_count: usize) {
    let (rules, active) = {
        let s = state.settings();
        (s.profiles.auto_switch.clone(), s.profiles.active.clone())
    };
    if let Some(target) = profiles::auto_switch_target(&rules, display_count, &active) {
        match activate_profile_now(app, state, &target) {
            Ok(_) => log::info!("auto-switched profile after a display change ({display_count} display(s))"),
            Err(e) => log::warn!("auto-switch failed: {e}"),
        }
    }
}

/// Cycles to the next profile in list order (shortcut).
pub fn next_profile(app: &AppHandle, state: &AppState) {
    let (ids, active) = {
        let s = state.settings();
        (s.profiles.items.iter().map(|p| p.id.clone()).collect::<Vec<_>>(), s.profiles.active.clone())
    };
    let i = ids.iter().position(|id| *id == active).unwrap_or(0);
    if let Some(next) = ids.get((i + 1) % ids.len().max(1)) {
        let _ = activate_profile_now(app, state, next);
    }
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
