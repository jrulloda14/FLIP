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
    /// Device name, e.g. `\\.\DISPLAY2`. Stored in settings.
    pub id: String,
    pub label: String,
    pub width: u32,
    pub height: u32,
    pub scale: f64,
    pub primary: bool,
}

#[derive(Debug, Clone)]
struct Mon {
    id: String,
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
            Mon {
                primary: primary.as_deref() == Some(id.as_str()),
                id,
                work: Rect { x: a.position.x as i64, y: a.position.y as i64, w: a.size.width as i64, h: a.size.height as i64 },
                size: (m.size().width, m.size().height),
                scale: m.scale_factor(),
            }
        })
        .collect()
}

/// Human label: `DISPLAY 2 · 2560×1440 · PRIMARY`.
pub fn display_label(id: &str, size: (u32, u32), primary: bool) -> String {
    let n = id.trim_start_matches(r"\\.\").replace("DISPLAY", "DISPLAY ");
    format!("{} · {}×{}{}", n.trim(), size.0, size.1, if primary { " · PRIMARY" } else { "" })
}

pub fn list_displays<R: Runtime>(w: &WebviewWindow<R>) -> Vec<DisplayInfo> {
    monitors(w)
        .into_iter()
        .map(|m| DisplayInfo {
            label: display_label(&m.id, m.size, m.primary),
            id: m.id,
            width: m.size.0,
            height: m.size.1,
            scale: m.scale,
            primary: m.primary,
        })
        .collect()
}

/// Picks the configured display, or the primary one when it is missing. Returns (index, fell_back).
pub fn choose_display(ids: &[(String, bool)], wanted: Option<&str>) -> Option<(usize, bool)> {
    if ids.is_empty() {
        return None;
    }
    if let Some(w) = wanted {
        if let Some(i) = ids.iter().position(|(id, _)| id == w) {
            return Some((i, false));
        }
    }
    let primary = ids.iter().position(|(_, p)| *p).unwrap_or(0);
    Some((primary, wanted.is_some()))
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
    let ids: Vec<(String, bool)> = mons.iter().map(|m| (m.id.clone(), m.primary)).collect();
    let (idx, fell_back) = choose_display(&ids, s.display.as_deref())?;
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
    let ids: Vec<(String, bool)> = mons.iter().map(|m| (m.id.clone(), m.primary)).collect();
    let Some((idx, _)) = choose_display(&ids, s.display.as_deref()) else { return };
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
    let ids: Vec<(String, bool)> = mons.iter().map(|m| (m.id.clone(), m.primary)).collect();
    let Some((idx, _)) = choose_display(&ids, s.display.as_deref()) else { return false };
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
    let ids: Vec<(String, bool)> = mons.iter().map(|m| (m.id.clone(), m.primary)).collect();
    let (_, fell_back) = choose_display(&ids, s.display.as_deref())?;
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
            matches!(tab, "DISPLAY" | "CLOCK" | "LOCATIONS" | "AI" | "FOCUS" | "MODULES" | "SYSTEM" | "KEYS")
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
        let ids = vec![(r"\\.\DISPLAY1".to_string(), true), (r"\\.\DISPLAY2".to_string(), false)];
        assert_eq!(choose_display(&ids, Some(r"\\.\DISPLAY2")), Some((1, false)));
        assert_eq!(choose_display(&ids, None), Some((0, false)));
        assert_eq!(choose_display(&ids, Some(r"\\.\DISPLAY3")), Some((0, true)), "missing display falls back to primary");
        assert_eq!(choose_display(&[], None), None);
    }

    #[test]
    fn labels_and_defaults() {
        assert_eq!(display_label(r"\\.\DISPLAY2", (2560, 1440), false), "DISPLAY 2 · 2560×1440");
        assert_eq!(display_label(r"\\.\DISPLAY1", (1920, 1080), true), "DISPLAY 1 · 1920×1080 · PRIMARY");
        assert_eq!(default_region(DisplayMode::Ambient), Region::Full);
        assert_eq!(default_region(DisplayMode::Compact), Region::TopRight);
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
}
