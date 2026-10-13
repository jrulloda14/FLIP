//! Dashboard and panel windows: display selection, the three display modes, region presets,
//! remembered rectangles, and recovery when the chosen monitor disappears.
//! Stacking (desktop / normal / top) lives in `desktop_layer`.

use std::sync::atomic::Ordering;

use serde::Serialize;
use tauri::{
    AppHandle, Emitter, LogicalSize, Manager, Monitor, PhysicalPosition, PhysicalSize, Runtime, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};

use super::desktop_layer;
pub use super::settings::Region;
use super::settings::{DisplayMode, Placement, WindowSettings};
use crate::state::AppState;

pub const MAIN: &str = "main";
pub const PANEL: &str = "panel";
/// Small window for the timer-completion card.
pub const TOAST: &str = "toast";
/// Logical size of the completion card window.
const TOAST_SIZE: (f64, f64) = (440.0, 214.0);
/// A saved window must overlap a monitor by at least this much to be restored there.
const MIN_VISIBLE: i64 = 120;
/// Gap between a region preset and the edge of the work area (logical px).
const REGION_MARGIN: f64 = 24.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Rect {
    pub x: i64,
    pub y: i64,
    pub w: i64,
    pub h: i64,
}

impl Rect {
    pub fn overlap(&self, o: &Rect) -> (i64, i64) {
        let w = (self.x + self.w).min(o.x + o.w) - self.x.max(o.x);
        let h = (self.y + self.h).min(o.y + o.h) - self.y.max(o.y);
        (w.max(0), h.max(0))
    }
    fn from_placement(p: &Placement) -> Self {
        Rect { x: p.x as i64, y: p.y as i64, w: p.width as i64, h: p.height as i64 }
    }
}

/// True when enough of the saved rectangle lies on some current monitor to be grabbed and moved.
pub fn placement_visible(p: &Placement, monitors: &[Rect]) -> bool {
    let r = Rect::from_placement(p);
    monitors.iter().any(|m| {
        let (w, h) = r.overlap(m);
        w >= MIN_VISIBLE.min(r.w) && h >= MIN_VISIBLE.min(r.h)
    })
}

/// Rectangle for a region preset inside a work area. `margin` is in physical pixels.
pub fn region_rect(work: &Rect, region: Region, margin: i64) -> Rect {
    let m = if region == Region::Full { 0 } else { margin };
    let (x0, y0, w, h) = (work.x + m, work.y + m, work.w - 2 * m, work.h - 2 * m);
    let half_w = (w - m) / 2;
    let half_h = (h - m) / 2;
    match region {
        Region::Full => Rect { x: work.x, y: work.y, w: work.w, h: work.h },
        Region::LeftHalf => Rect { x: x0, y: y0, w: half_w, h },
        Region::RightHalf => Rect { x: x0 + half_w + m, y: y0, w: half_w, h },
        Region::TopLeft => Rect { x: x0, y: y0, w: half_w, h: half_h },
        Region::TopRight => Rect { x: x0 + half_w + m, y: y0, w: half_w, h: half_h },
        Region::BottomLeft => Rect { x: x0, y: y0 + half_h + m, w: half_w, h: half_h },
        Region::BottomRight => Rect { x: x0 + half_w + m, y: y0 + half_h + m, w: half_w, h: half_h },
        Region::Center => {
            let (cw, ch) = (work.w * 6 / 10, work.h * 6 / 10);
            Rect { x: work.x + (work.w - cw) / 2, y: work.y + (work.h - ch) / 2, w: cw, h: ch }
        }
    }
}

/// Default region for each mode when nothing has been saved.
pub fn default_region(mode: DisplayMode) -> Region {
    match mode {
        DisplayMode::Ambient => Region::Full,
        DisplayMode::Windowed => Region::RightHalf,
        DisplayMode::Compact => Region::TopRight,
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DisplayInfo {
    /// Device name, e.g. `\\.\DISPLAY2`. Can change when monitors are re-plugged.
    pub id: String,
    /// Stable monitor id (Windows device-interface path); preferred for matching.
    pub stable_id: Option<String>,
    /// Monitor model name when Windows reports one (e.g. "DELL U2723QE").
    pub name: Option<String>,
    pub label: String,
    pub width: u32,
    pub height: u32,
    pub scale: f64,
    pub primary: bool,
}

#[derive(Debug, Clone)]
struct Mon {
    id: String,
    stable: Option<String>,
    name: Option<String>,
    work: Rect,
    size: (u32, u32),
    scale: f64,
    primary: bool,
}

fn monitors<R: Runtime>(w: &WebviewWindow<R>) -> Vec<Mon> {
    let primary = w.primary_monitor().ok().flatten().and_then(|m| m.name().cloned());
    w.available_monitors()
        .unwrap_or_default()
        .iter()
        .enumerate()
        .map(|(i, m): (usize, &Monitor)| {
            let a = m.work_area();
            let id = m.name().cloned().unwrap_or_else(|| format!("DISPLAY{}", i + 1));
            let (stable, name) = identity::monitor_identity(&id);
            Mon {
                primary: primary.as_deref() == Some(id.as_str()),
                stable,
                name,
                id,
                work: Rect { x: a.position.x as i64, y: a.position.y as i64, w: a.size.width as i64, h: a.size.height as i64 },
                size: (m.size().width, m.size().height),
                scale: m.scale_factor(),
            }
        })
        .collect()
}

/// Human label: `DISPLAY 2 · DELL U2723QE · 2560×1440 · PRIMARY` (model only when known).
pub fn display_label(id: &str, name: Option<&str>, size: (u32, u32), primary: bool) -> String {
    let n = id.trim_start_matches(r"\\.\").replace("DISPLAY", "DISPLAY ");
    let model = name.map(|m| format!(" · {}", m.to_uppercase())).unwrap_or_default();
    format!("{}{model} · {}×{}{}", n.trim(), size.0, size.1, if primary { " · PRIMARY" } else { "" })
}

pub fn list_displays<R: Runtime>(w: &WebviewWindow<R>) -> Vec<DisplayInfo> {
    monitors(w)
        .into_iter()
        .map(|m| DisplayInfo {
            label: display_label(&m.id, m.name.as_deref(), m.size, m.primary),
            stable_id: m.stable,
            name: m.name,
            id: m.id,
            width: m.size.0,
            height: m.size.1,
            scale: m.scale,
            primary: m.primary,
        })
        .collect()
}

/// What `choose_display` needs to know about a connected monitor.
#[derive(Debug, Clone, PartialEq)]
pub struct DisplayKey {
    pub device: String,
    pub stable: Option<String>,
    pub primary: bool,
}

/// Picks the configured display, or the primary one when it is missing. Returns (index, fell_back).
///
/// A stable id (monitor device-interface path) is matched first. The device name
/// (`\\.\DISPLAYn`) is only used when no stable id was saved (settings from before 0.3.0),
/// because device names can be reassigned to a different monitor after re-plugging.
pub fn choose_display(keys: &[DisplayKey], wanted_id: Option<&str>, wanted_device: Option<&str>) -> Option<(usize, bool)> {
    if keys.is_empty() {
        return None;
    }
    let found = match (wanted_id, wanted_device) {
        (Some(id), _) => keys.iter().position(|k| k.stable.as_deref() == Some(id)),
        (None, Some(dev)) => keys.iter().position(|k| k.device == dev),
        (None, None) => None,
    };
    if let Some(i) = found {
        return Some((i, false));
    }
    let primary = keys.iter().position(|k| k.primary).unwrap_or(0);
    Some((primary, wanted_id.is_some() || wanted_device.is_some()))
}

fn keys(mons: &[Mon]) -> Vec<DisplayKey> {
    mons.iter().map(|m| DisplayKey { device: m.id.clone(), stable: m.stable.clone(), primary: m.primary }).collect()
}

/// The monitor a window setting targets, and whether FLIP fell back to the primary one.
fn target(mons: &[Mon], s: &WindowSettings) -> Option<(usize, bool)> {
    choose_display(&keys(mons), s.display_id.as_deref(), s.display.as_deref())
}

/// Number of connected displays (for profile auto-switching).
pub fn display_count<R: Runtime>(w: &WebviewWindow<R>) -> usize {
    w.available_monitors().map(|m| m.len()).unwrap_or(0)
}

mod identity {
    /// (stable device-interface id, model name) for a GDI device name such as `\\.\DISPLAY2`.
    #[cfg(windows)]
    pub fn monitor_identity(device: &str) -> (Option<String>, Option<String>) {
        use windows::core::PCWSTR;
        use windows::Win32::Graphics::Gdi::{EnumDisplayDevicesW, DISPLAY_DEVICEW};
        use windows::Win32::UI::WindowsAndMessaging::EDD_GET_DEVICE_INTERFACE_NAME;
        let wide: Vec<u16> = device.encode_utf16().chain(std::iter::once(0)).collect();
        let text = |b: &[u16]| {
            let n = b.iter().position(|&c| c == 0).unwrap_or(b.len());
            let t = String::from_utf16_lossy(&b[..n]).trim().to_string();
            (!t.is_empty()).then_some(t)
        };
        // Index 0 is the first monitor attached to this display output.
        let mut dd = DISPLAY_DEVICEW { cb: std::mem::size_of::<DISPLAY_DEVICEW>() as u32, ..Default::default() };
        let ok = unsafe { EnumDisplayDevicesW(PCWSTR(wide.as_ptr()), 0, &mut dd, EDD_GET_DEVICE_INTERFACE_NAME) }.as_bool();
        if !ok {
            return (None, None);
        }
        let name = text(&dd.DeviceString).filter(|n| !n.to_ascii_lowercase().contains("generic"));
        (text(&dd.DeviceID), name)
    }

    #[cfg(not(windows))]
    pub fn monitor_identity(_device: &str) -> (Option<String>, Option<String>) {
        (None, None)
    }
}

pub fn main_window<R: Runtime>(app: &AppHandle<R>) -> Option<WebviewWindow<R>> {
    app.get_webview_window(MAIN)
}

fn set_rect<R: Runtime>(w: &WebviewWindow<R>, r: Rect) {
    let _ = w.set_size(PhysicalSize::new(r.w.max(1) as u32, r.h.max(1) as u32));
    let _ = w.set_position(PhysicalPosition::new(r.x as i32, r.y as i32));
}

/// Places the dashboard for its mode on the chosen display. Returns a notice when the chosen
/// display is missing and FLIP fell back to the primary monitor.
pub fn place<R: Runtime>(w: &WebviewWindow<R>, s: &WindowSettings) -> Option<String> {
    let mons = monitors(w);
    let (idx, fell_back) = target(&mons, s)?;
    let mon = &mons[idx];
    let margin = (REGION_MARGIN * mon.scale) as i64;
    let saved = match s.mode {
        DisplayMode::Ambient => None,
        DisplayMode::Windowed => s.windowed_rect.as_ref(),
        DisplayMode::Compact => s.compact_rect.as_ref(),
    };
    // A saved rectangle is reused only if it is on the display we are placing on.
    let rect = match saved {
        Some(p) if !fell_back && placement_visible(p, std::slice::from_ref(&mon.work)) => Rect::from_placement(p),
        _ => region_rect(&mon.work, s.region().unwrap_or_else(|| default_region(s.mode)), margin),
    };
    let movable = s.mode != DisplayMode::Ambient;
    let _ = w.set_resizable(movable);
    let _ = w.set_minimizable(false);
    let _ = w.set_maximizable(false);
    if w.is_fullscreen().unwrap_or(false) {
        let _ = w.set_fullscreen(false);
    }
    set_rect(w, rect);
    fell_back.then(|| "CHOSEN DISPLAY NOT CONNECTED · SHOWING ON PRIMARY".to_string())
}

/// Applies a region preset to the current movable mode and stores it.
pub fn apply_region<R: Runtime>(w: &WebviewWindow<R>, state: &AppState, region: Region) {
    let s = state.settings().window.clone();
    let mons = monitors(w);
    let Some((idx, _)) = target(&mons, &s) else { return };
    let mon = &mons[idx];
    let r = region_rect(&mon.work, region, (REGION_MARGIN * mon.scale) as i64);
    {
        let mut st = state.settings_mut();
        match st.window.mode {
            DisplayMode::Compact => st.window.compact_region = Some(region),
            _ => st.window.windowed_region = Some(region),
        }
    }
    set_rect(w, r);
    capture_placement(w, state);
}

/// True when two rectangles are the same within a few pixels (DPI rounding).
fn same_rect(a: &Rect, b: &Rect) -> bool {
    (a.x - b.x).abs() <= 4 && (a.y - b.y).abs() <= 4 && (a.w - b.w).abs() <= 4 && (a.h - b.h).abs() <= 4
}

/// Whether the window still fills its recorded region on the current display.
fn still_in_region<R: Runtime>(w: &WebviewWindow<R>, s: &WindowSettings, current: &Rect) -> bool {
    let Some(region) = s.region() else { return false };
    let mons = monitors(w);
    let Some((idx, _)) = target(&mons, s) else { return false };
    let mon = &mons[idx];
    same_rect(current, &region_rect(&mon.work, region, (REGION_MARGIN * mon.scale) as i64))
}

/// Records the current geometry for the current movable mode.
pub fn capture_placement<R: Runtime>(w: &WebviewWindow<R>, state: &AppState) {
    let mode = state.settings().window.mode;
    if mode == DisplayMode::Ambient || w.is_minimized().unwrap_or(false) || !w.is_visible().unwrap_or(false) {
        return;
    }
    let (Ok(pos), Ok(size)) = (w.outer_position(), w.outer_size()) else { return };
    if size.width < 320 || size.height < 180 {
        return;
    }
    let monitor = w.current_monitor().ok().flatten().and_then(|m| m.name().cloned());
    let p = Placement { x: pos.x, y: pos.y, width: size.width, height: size.height, monitor };
    let win = state.settings().window.clone();
    let in_region = still_in_region(w, &win, &Rect::from_placement(&p));
    let region_cleared = {
        let mut s = state.settings_mut();
        let win = &mut s.window;
        let (slot, region) = if mode == DisplayMode::Compact {
            (&mut win.compact_rect, &mut win.compact_region)
        } else {
            (&mut win.windowed_rect, &mut win.windowed_region)
        };
        if slot.as_ref() != Some(&p) {
            *slot = Some(p);
            state.placement_dirty.store(true, Ordering::SeqCst);
        }
        // Moved or resized by hand: no preset region is selected any more.
        let cleared = !in_region && region.is_some();
        if cleared {
            *region = None;
        }
        // The active profile remembers where its window is.
        super::profiles::sync_active(&mut s);
        cleared
    };
    if region_cleared {
        let s = state.settings().clone();
        let _ = w.app_handle().emit(crate::commands::EVT_SETTINGS, &s);
    }
}

/// Called every few seconds: handles a monitor being unplugged or plugged back in.
/// Returns a notice to show (or clear with `Some(String::new())`) when the display situation changed.
pub fn check_displays<R: Runtime>(w: &WebviewWindow<R>, state: &AppState) -> Option<Option<String>> {
    let s = state.settings().window.clone();
    let mons = monitors(w);
    let (_, fell_back) = target(&mons, &s)?;
    let was = state.display_fallback.swap(fell_back, Ordering::SeqCst);
    let off_screen = {
        let (Ok(pos), Ok(size)) = (w.outer_position(), w.outer_size()) else { return None };
        let p = Placement { x: pos.x, y: pos.y, width: size.width, height: size.height, monitor: None };
        let works: Vec<Rect> = mons.iter().map(|m| m.work).collect();
        !works.is_empty() && !placement_visible(&p, &works)
    };
    if was != fell_back || off_screen {
        log::info!("display change: fallback={fell_back}, off_screen={off_screen}; re-placing");
        let notice = place(w, &s);
        desktop_layer::apply_layer(w, s.layer);
        return Some(notice);
    }
    None
}

pub fn show<R: Runtime>(app: &AppHandle<R>) {
    if let Some(w) = main_window(app) {
        let _ = w.show();
        let layer = app.state::<AppState>().settings().window.layer;
        desktop_layer::apply_layer(&w, layer);
        let _ = w.set_focus();
    }
}

pub fn hide<R: Runtime>(app: &AppHandle<R>) {
    if let Some(w) = main_window(app) {
        let _ = w.hide();
    }
    if let Some(p) = app.get_webview_window(PANEL) {
        let _ = p.hide();
    }
}

pub fn toggle_visible<R: Runtime>(app: &AppHandle<R>) {
    if let Some(w) = main_window(app) {
        if w.is_visible().unwrap_or(false) {
            hide(app);
        } else {
            show(app);
        }
    }
}

// ------------------------------------------------------------------ panel window

/// Valid panel views: `settings`, `settings:<TAB>`, `ai:<provider>`, `system`, `timer`.
pub fn valid_panel_view(v: &str) -> bool {
    match v.split_once(':') {
        None => matches!(v, "settings" | "system" | "timer"),
        Some(("settings", tab)) => {
            matches!(tab, "DISPLAY" | "PROFILES" | "CLOCK" | "LOCATIONS" | "AI" | "FOCUS" | "MODULES" | "SYSTEM" | "KEYS")
        }
        Some(("ai", id)) => matches!(id, "claude" | "codex"),
        _ => false,
    }
}

/// Logical size of the panel per view.
pub fn panel_size(view: &str) -> (f64, f64) {
    match view.split(':').next().unwrap_or("") {
        "timer" => (640.0, 470.0),
        "ai" => (1040.0, 720.0),
        "system" => (1240.0, 800.0),
        _ => (1180.0, 800.0),
    }
}

pub fn create_panel<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<WebviewWindow<R>> {
    let w = WebviewWindowBuilder::new(app, PANEL, WebviewUrl::App("index.html?view=panel".into()))
        .title("FLIP")
        .decorations(false)
        .resizable(true)
        .visible(false)
        .skip_taskbar(true)
        .min_inner_size(520.0, 360.0)
        .inner_size(1180.0, 800.0)
        .background_color(tauri::window::Color(11, 11, 11, 255))
        .theme(Some(tauri::Theme::Dark))
        .build()?;
    desktop_layer::install(&w, false);
    Ok(w)
}

/// Shows the panel centred on the dashboard's monitor, clamped to the work area.
pub fn open_panel<R: Runtime>(app: &AppHandle<R>, view: &str) {
    let Some(panel) = app.get_webview_window(PANEL) else { return };
    let (lw, lh) = panel_size(view);
    let target = main_window(app).and_then(|m| m.current_monitor().ok().flatten()).or_else(|| panel.primary_monitor().ok().flatten());
    if let Some(m) = target {
        let a = m.work_area();
        let s = m.scale_factor();
        let w = ((lw * s) as i64).min(a.size.width as i64 - 32);
        let h = ((lh * s) as i64).min(a.size.height as i64 - 32);
        let x = a.position.x as i64 + (a.size.width as i64 - w) / 2;
        let y = a.position.y as i64 + (a.size.height as i64 - h) / 2;
        set_rect(&panel, Rect { x, y, w, h });
    } else {
        let _ = panel.set_size(LogicalSize::new(lw, lh));
    }
    let _ = panel.show();
    let _ = panel.set_always_on_top(true);
    let _ = panel.set_focus();
}

// ------------------------------------------------------------------ completion card window

/// The card window is created *shown* (off-screen, without focus) so Tauri and WebView2 treat
/// it as visible and keep its page rendering, then hidden straight away. From then on it is
/// shown and hidden only with `desktop_layer::show_at_without_focus` / `hide_window`, which do
/// not activate it; Tauri's own show/hide would take focus from the user's app.
pub fn create_toast<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<WebviewWindow<R>> {
    let w = WebviewWindowBuilder::new(app, TOAST, WebviewUrl::App("index.html?view=toast".into()))
        .title("FLIP")
        .decorations(false)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .visible(true)
        .focused(false)
        .skip_taskbar(true)
        .shadow(false)
        .position(-32000.0, -32000.0)
        .inner_size(TOAST_SIZE.0, TOAST_SIZE.1)
        .background_color(tauri::window::Color(11, 11, 11, 255))
        .theme(Some(tauri::Theme::Dark))
        .build()?;
    desktop_layer::install(&w, false);
    desktop_layer::hide_window(&w);
    Ok(w)
}

/// Bottom-right of the work area, inset by a margin.
pub fn toast_rect(work: &Rect, w: i64, h: i64, margin: i64) -> Rect {
    let w = w.min(work.w - 2 * margin).max(1);
    let h = h.min(work.h - 2 * margin).max(1);
    Rect { x: work.x + work.w - w - margin, y: work.y + work.h - h - margin, w, h }
}

/// Shows the completion card in the bottom-right corner of the dashboard's monitor (or the
/// primary monitor while the dashboard is hidden), above other windows, without taking focus.
/// The dashboard window itself is never moved or resized.
pub fn show_toast<R: Runtime>(app: &AppHandle<R>) {
    let Some(t) = app.get_webview_window(TOAST) else { return };
    let monitor = main_window(app)
        .filter(|m| m.is_visible().unwrap_or(false))
        .and_then(|m| m.current_monitor().ok().flatten())
        .or_else(|| t.primary_monitor().ok().flatten());
    let Some(m) = monitor else { return };
    let a = m.work_area();
    let s = m.scale_factor();
    let work = Rect { x: a.position.x as i64, y: a.position.y as i64, w: a.size.width as i64, h: a.size.height as i64 };
    let r = toast_rect(&work, (TOAST_SIZE.0 * s) as i64, (TOAST_SIZE.1 * s) as i64, (REGION_MARGIN * s) as i64);
    desktop_layer::show_at_without_focus(&t, r.x, r.y, r.w, r.h);
}

pub fn hide_toast<R: Runtime>(app: &AppHandle<R>) {
    if let Some(t) = app.get_webview_window(TOAST) {
        desktop_layer::hide_window(&t);
    }
}

pub fn close_panel<R: Runtime>(app: &AppHandle<R>) {
    if let Some(p) = app.get_webview_window(PANEL) {
        let _ = p.set_always_on_top(false);
        let _ = p.hide();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(x: i32, y: i32, w: u32, h: u32) -> Placement {
        Placement { x, y, width: w, height: h, monitor: None }
    }
    const PRIMARY: Rect = Rect { x: 0, y: 0, w: 1920, h: 1040 };
    const RIGHT: Rect = Rect { x: 1920, y: 0, w: 2560, h: 1400 };

    #[test]
    fn visible_on_secondary_only_when_connected() {
        let on_second = p(2200, 100, 1280, 720);
        assert!(placement_visible(&on_second, &[PRIMARY, RIGHT]));
        assert!(!placement_visible(&on_second, &[PRIMARY]), "second monitor unplugged");
    }

    #[test]
    fn sliver_is_not_enough() {
        assert!(!placement_visible(&p(1880, 100, 1280, 720), &[PRIMARY]));
        let left = Rect { x: -1920, y: 0, w: 1920, h: 1040 };
        assert!(placement_visible(&p(-1500, 50, 1280, 720), &[left, PRIMARY]));
    }

    #[test]
    fn regions_tile_the_work_area() {
        let full = region_rect(&PRIMARY, Region::Full, 24);
        assert_eq!(full, PRIMARY);
        let l = region_rect(&PRIMARY, Region::LeftHalf, 24);
        let r = region_rect(&PRIMARY, Region::RightHalf, 24);
        assert_eq!((l.x, l.y), (24, 24));
        assert_eq!(r.x + r.w, 1920 - 24, "right edge keeps the margin");
        assert_eq!(r.x - (l.x + l.w), 24, "gutter between halves");
        let br = region_rect(&RIGHT, Region::BottomRight, 24);
        assert_eq!((br.x + br.w, br.y + br.h), (1920 + 2560 - 24, 1400 - 24));
        let c = region_rect(&PRIMARY, Region::Center, 24);
        assert_eq!((c.w, c.h), (1152, 624));
        for reg in [Region::TopLeft, Region::TopRight, Region::BottomLeft, Region::BottomRight] {
            let r = region_rect(&RIGHT, reg, 24);
            let (ow, oh) = r.overlap(&RIGHT);
            assert_eq!((ow, oh), (r.w, r.h), "{reg:?} stays inside the work area");
        }
    }

    #[test]
    fn display_choice_and_fallback() {
        let k = |d: &str, st: Option<&str>, p: bool| DisplayKey { device: d.into(), stable: st.map(Into::into), primary: p };
        let keys = vec![k(r"\\.\DISPLAY1", Some("MON-A"), true), k(r"\\.\DISPLAY2", Some("MON-B"), false)];
        assert_eq!(choose_display(&keys, Some("MON-B"), None), Some((1, false)));
        assert_eq!(choose_display(&keys, None, Some(r"\\.\DISPLAY2")), Some((1, false)), "legacy device-name match");
        assert_eq!(choose_display(&keys, None, None), Some((0, false)));
        assert_eq!(choose_display(&keys, Some("MON-C"), None), Some((0, true)), "missing monitor falls back to primary");
        assert_eq!(choose_display(&[], None, None), None);
    }

    #[test]
    fn stable_id_beats_reassigned_device_names() {
        // After re-plugging, Windows swapped the device names: MON-B is now DISPLAY1.
        let keys = vec![
            DisplayKey { device: r"\\.\DISPLAY1".into(), stable: Some("MON-B".into()), primary: false },
            DisplayKey { device: r"\\.\DISPLAY2".into(), stable: Some("MON-A".into()), primary: true },
        ];
        assert_eq!(choose_display(&keys, Some("MON-B"), Some(r"\\.\DISPLAY2")), Some((0, false)));
    }

    #[test]
    fn labels_and_defaults() {
        assert_eq!(display_label(r"\\.\DISPLAY2", None, (2560, 1440), false), "DISPLAY 2 · 2560×1440");
        assert_eq!(display_label(r"\\.\DISPLAY1", None, (1920, 1080), true), "DISPLAY 1 · 1920×1080 · PRIMARY");
        assert_eq!(display_label(r"\\.\DISPLAY2", Some("Dell U2723QE"), (2560, 1440), false), "DISPLAY 2 · DELL U2723QE · 2560×1440");
        assert_eq!(default_region(DisplayMode::Ambient), Region::Full);
        assert_eq!(default_region(DisplayMode::Compact), Region::TopRight);
    }

    #[test]
    fn toast_sits_in_the_bottom_right_corner_and_fits_small_screens() {
        let work = Rect { x: 1920, y: 0, w: 2560, h: 1400 };
        assert_eq!(toast_rect(&work, 440, 214, 24), Rect { x: 1920 + 2560 - 440 - 24, y: 1400 - 214 - 24, w: 440, h: 214 });
        let tiny = Rect { x: 0, y: 0, w: 400, h: 200 };
        let r = toast_rect(&tiny, 440, 214, 24);
        assert!(r.x >= 0 && r.y >= 0 && r.x + r.w <= 400 && r.y + r.h <= 200);
    }

    #[test]
    fn panel_views_are_allow_listed() {
        for ok in ["settings", "settings:DISPLAY", "ai:claude", "system", "timer"] {
            assert!(valid_panel_view(ok), "{ok}");
        }
        for bad in ["", "settings:../../x", "ai:openai", "file", "timer:1"] {
            assert!(!valid_panel_view(bad), "{bad}");
        }
    }

    #[test]
    #[cfg(windows)]
    fn live_monitor_identity_is_stable_and_not_a_bare_index() {
        let (id, _name) = identity::monitor_identity(r"\\.\DISPLAY1");
        if let Some(id) = id {
            assert!(!id.contains("DISPLAY1"), "the stable id must not be the GDI device name");
            assert!(id.len() > 20);
            assert_eq!(identity::monitor_identity(r"\\.\DISPLAY1").0.as_deref(), Some(id.as_str()), "repeatable");
        }
        assert_eq!(identity::monitor_identity(r"\\.\DISPLAY99"), (None, None));
    }
}
