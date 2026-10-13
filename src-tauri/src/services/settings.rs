//! Persistent user settings: `settings.json` in the app data directory.
//!
//! * Every field has a default, so partial files load.
//! * `validate` clamps or replaces out-of-range values instead of failing.
//! * `migrate` upgrades older layouts (v0 is the schema in docs/HANDOFF.md).
//! * A corrupt file is moved aside and defaults are used, so the app always starts.

use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

use chrono::{DateTime, Utc};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;

use super::profiles::{self, ProfileSettings};
use crate::paths::atomic_write;

pub const SETTINGS_VERSION: u32 = 5;
pub const MAX_CITIES: usize = 8;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum DateFormat {
    #[default]
    Dow,
    Iso,
    Eu,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum DotShape {
    #[default]
    Round,
    Square,
}

/// Reads a field, or its default when the stored value has the wrong type or an unknown
/// variant, so one bad value never discards the rest of the settings file.
fn lenient<'de, D, T>(d: D) -> Result<T, D::Error>
where
    D: Deserializer<'de>,
    T: DeserializeOwned + Default,
{
    let v = Value::deserialize(d)?;
    Ok(serde_json::from_value(v).unwrap_or_default())
}

/// Visual style of the main clock (Clock Studio).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum ClockTemplate {
    DotMatrix,
    /// The default: FLIP is named after the split-flap board.
    #[default]
    SplitFlap,
    SevenSegment,
    Terminal,
    Minimal,
}

/// Digit colour, from the design system's ink ramp. Monochrome by design.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum ClockInk {
    #[default]
    Bright,
    Soft,
    Dim,
}

/// Split-flap card colour.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum FlapPanel {
    #[default]
    Graphite,
    Black,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ClockSettings {
    pub h24: bool,
    pub seconds: bool,
    pub blink: bool,
    pub date_format: DateFormat,
    pub meta_line: bool,
    pub dot_shape: DotShape,
    pub ghost_dots: bool,
    /// IANA zone. `None` follows the Windows time zone.
    pub home_time_zone: Option<String>,
    #[serde(deserialize_with = "lenient")]
    pub template: ClockTemplate,
    /// Animate digit changes (also off when Windows asks for reduced motion).
    #[serde(deserialize_with = "lenient")]
    pub animate: bool,
    /// Digit animation length, 150–600 ms.
    #[serde(deserialize_with = "lenient")]
    pub animation_ms: u32,
    /// Clock size multiplier, 0.7–1.4. Clamped further on small layouts.
    #[serde(deserialize_with = "lenient")]
    pub scale: f64,
    /// Gap between digits, 0.5–1.6 × the template's natural gap.
    #[serde(deserialize_with = "lenient")]
    pub spacing: f64,
    #[serde(deserialize_with = "lenient")]
    pub ink: ClockInk,
    #[serde(deserialize_with = "lenient")]
    pub flap_seam: bool,
    #[serde(deserialize_with = "lenient")]
    pub flap_shadow: bool,
    #[serde(deserialize_with = "lenient")]
    pub flap_panel: FlapPanel,
}

pub const ANIMATION_MS_DEFAULT: u32 = 320;

impl Default for ClockSettings {
    fn default() -> Self {
        Self {
            h24: true,
            seconds: false,
            blink: false,
            date_format: DateFormat::Dow,
            meta_line: true,
            dot_shape: DotShape::Round,
            ghost_dots: true,
            home_time_zone: None,
            template: ClockTemplate::SplitFlap,
            animate: true,
            animation_ms: ANIMATION_MS_DEFAULT,
            scale: 1.0,
            spacing: 1.0,
            ink: ClockInk::Bright,
            flap_seam: true,
            flap_shadow: true,
            flap_panel: FlapPanel::Graphite,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum FontChoice {
    #[default]
    Jetbrains,
    Cascadia,
    Consolas,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum BackgroundColor {
    /// The Windows solid desktop colour; the board colour when a wallpaper image is set.
    #[default]
    Desktop,
    /// #000000.
    Black,
    /// #050505, the design token.
    Board,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum Contrast {
    #[default]
    Standard,
    Dim,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AppearanceSettings {
    /// Board colour. `Desktop` follows the Windows solid desktop colour so FLIP blends in.
    pub background: BackgroundColor,
    pub font: FontChoice,
    pub text_scale: f64,
    pub contrast: Contrast,
    /// Background alpha, 0.3–1.0. Text stays fully opaque; the desktop shows through behind it.
    pub background_opacity: f64,
}

impl Default for AppearanceSettings {
    fn default() -> Self {
        Self {
            background: BackgroundColor::Desktop,
            font: FontChoice::Jetbrains,
            text_scale: 1.0,
            contrast: Contrast::Standard,
            background_opacity: 1.0,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct City {
    pub name: String,
    pub code: String,
    pub tz: String,
}

impl City {
    fn new(name: &str, code: &str, tz: &str) -> Self {
        Self { name: name.into(), code: code.into(), tz: tz.into() }
    }
}

pub fn default_cities() -> Vec<City> {
    vec![
        City::new("MANILA", "MNL", "Asia/Manila"),
        City::new("LONDON", "LHR", "Europe/London"),
        City::new("NEW YORK", "JFK", "America/New_York"),
        City::new("TOKYO", "HND", "Asia/Tokyo"),
        City::new("SYDNEY", "SYD", "Australia/Sydney"),
        City::new("DUBAI", "DXB", "Asia/Dubai"),
    ]
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum ClaudeSource {
    #[default]
    Off,
    Statusline,
    Manual,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum CodexSource {
    #[default]
    Off,
    LocalLogs,
    Manual,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ClaudeProviderSettings {
    pub source: ClaudeSource,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct CodexProviderSettings {
    pub source: CodexSource,
    /// Overrides `CODEX_HOME` / `%USERPROFILE%\.codex`.
    pub codex_home: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManualWindow {
    pub key: String,
    pub used_percent: f64,
    pub resets_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManualUsage {
    pub windows: Vec<ManualWindow>,
    pub entered_at: DateTime<Utc>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AiSettings {
    pub refresh_minutes: u32,
    pub warn_at: f64,
    pub claude: ClaudeProviderSettings,
    pub codex: CodexProviderSettings,
    /// User-entered readings, keyed by provider id.
    pub manual: BTreeMap<String, ManualUsage>,
    /// Labeled demo data. Only honoured in debug builds.
    pub demo: bool,
}

impl Default for AiSettings {
    fn default() -> Self {
        Self {
            refresh_minutes: 2,
            warn_at: 0.9,
            claude: ClaudeProviderSettings::default(),
            codex: CodexProviderSettings::default(),
            manual: BTreeMap::new(),
            demo: false,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct FocusSettings {
    pub focus_minutes: u32,
    pub short_minutes: u32,
    pub long_minutes: u32,
    pub sessions: u32,
    pub auto_start: bool,
}

impl Default for FocusSettings {
    fn default() -> Self {
        Self { focus_minutes: 25, short_minutes: 5, long_minutes: 15, sessions: 4, auto_start: false }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum LayoutPref {
    #[default]
    Auto,
    Full,
    Compact,
    Mini,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ModuleSettings {
    pub date: bool,
    pub ai: bool,
    pub world: bool,
    pub system: bool,
    pub focus: bool,
    pub keys: bool,
    /// Content density. AUTO picks from the window size.
    pub layout: LayoutPref,
    pub preset: LayoutPreset,
    /// Order of the movable modules: `ai`/`world` on the board side, `system`/`focus` on the panel side.
    pub order: Vec<ModuleId>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum LayoutPreset {
    #[default]
    Balanced,
    Clock,
    Ai,
    System,
}

impl LayoutPreset {
    pub fn next(self) -> Self {
        match self {
            Self::Balanced => Self::Clock,
            Self::Clock => Self::Ai,
            Self::Ai => Self::System,
            Self::System => Self::Balanced,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ModuleId {
    Ai,
    World,
    System,
    Focus,
}

pub const DEFAULT_ORDER: [ModuleId; 4] = [ModuleId::Ai, ModuleId::World, ModuleId::System, ModuleId::Focus];

impl Default for ModuleSettings {
    fn default() -> Self {
        Self {
            date: true,
            ai: true,
            world: true,
            system: true,
            focus: true,
            keys: true,
            layout: LayoutPref::Full,
            preset: LayoutPreset::Balanced,
            order: DEFAULT_ORDER.to_vec(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
pub enum TempUnit {
    #[default]
    C,
    F,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SystemSettings {
    pub temps: bool,
    pub gpu: bool,
    pub net: bool,
    pub disk: bool,
    pub plot: bool,
    pub sample_seconds: u32,
    pub temp_unit: TempUnit,
}

impl Default for SystemSettings {
    fn default() -> Self {
        Self { temps: true, gpu: true, net: true, disk: true, plot: true, sample_seconds: 1, temp_unit: TempUnit::C }
    }
}

/// Where and how big the dashboard is. FLIP never shows a title bar or border in any mode.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum DisplayMode {
    /// Fills the chosen display's work area. For a dedicated second monitor.
    Ambient,
    /// A movable, resizable region of a display. For the main monitor.
    #[default]
    Windowed,
    /// A small region showing clock, AI usage and focus first.
    Compact,
}

/// Screen region presets for the movable modes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Region {
    Full,
    LeftHalf,
    RightHalf,
    TopLeft,
    TopRight,
    BottomLeft,
    BottomRight,
    Center,
}

/// Where the dashboard sits in the window stack.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum WindowLayer {
    /// Below all other windows, like part of the desktop. Stays visible through Show Desktop (Win+D).
    #[default]
    Desktop,
    /// An ordinary window.
    Normal,
    /// Above other windows, except while a fullscreen app or presentation is running.
    Top,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Placement {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    /// Monitor the rectangle was saved on.
    pub monitor: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct WindowSettings {
    pub mode: DisplayMode,
    pub layer: WindowLayer,
    /// Monitor device name (e.g. `\\.\DISPLAY2`). `None` = primary monitor. Can change when
    /// monitors are re-plugged, so `display_id` is matched first.
    pub display: Option<String>,
    /// Stable monitor id (Windows monitor device-interface path), matched before `display`.
    #[serde(deserialize_with = "lenient")]
    pub display_id: Option<String>,
    pub launch_on_startup: bool,
    pub start_hidden: bool,
    /// The ✕ control hides FLIP instead of quitting.
    pub close_to_tray: bool,
    /// Seconds before hover controls fade. 0 = always visible.
    pub hide_controls_after: u32,
    /// Saved rectangles, one per movable mode (physical pixels).
    pub windowed_rect: Option<Placement>,
    pub compact_rect: Option<Placement>,
    /// Region preset currently filled in each movable mode; `None` after a manual move/resize.
    #[serde(deserialize_with = "lenient")]
    pub windowed_region: Option<Region>,
    #[serde(deserialize_with = "lenient")]
    pub compact_region: Option<Region>,
}

impl WindowSettings {
    /// The region recorded for the current mode (ambient always fills the display).
    pub fn region(&self) -> Option<Region> {
        match self.mode {
            DisplayMode::Ambient => Some(Region::Full),
            DisplayMode::Windowed => self.windowed_region,
            DisplayMode::Compact => self.compact_region,
        }
    }
}

impl Default for WindowSettings {
    fn default() -> Self {
        Self {
            mode: DisplayMode::Windowed,
            layer: WindowLayer::Desktop,
            display: None,
            display_id: None,
            launch_on_startup: false,
            start_hidden: false,
            close_to_tray: true,
            hide_controls_after: 3,
            windowed_rect: None,
            compact_rect: None,
            windowed_region: Some(Region::RightHalf),
            compact_region: Some(Region::TopRight),
        }
    }
}

/// System-wide shortcuts. They work while FLIP is behind other windows and unfocused.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ShortcutSettings {
    pub toggle: String,
    pub settings: String,
    pub layout: String,
    pub focus: String,
    /// Next profile.
    pub profile: String,
}

impl Default for ShortcutSettings {
    fn default() -> Self {
        Self {
            toggle: "Ctrl+Alt+F".into(),
            settings: "Ctrl+Alt+S".into(),
            layout: "Ctrl+Alt+L".into(),
            focus: "Ctrl+Alt+P".into(),
            profile: "Ctrl+Alt+N".into(),
        }
    }
}

impl ShortcutSettings {
    pub fn entries(&self) -> [(&'static str, &str); 5] {
        [
            ("toggle", &self.toggle),
            ("settings", &self.settings),
            ("layout", &self.layout),
            ("focus", &self.focus),
            ("profile", &self.profile),
        ]
    }
}

/// Opt-in threshold notifications. Off by default; FLIP never acts on the system, it only notifies.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AlertSettings {
    pub cpu: bool,
    /// Alert when total CPU stays at or above this percentage…
    pub cpu_percent: u32,
    /// …for this many minutes in a row.
    pub cpu_minutes: u32,
    pub memory: bool,
    pub memory_percent: u32,
    pub disk: bool,
    /// Alert when any fixed disk has less free space than this percentage.
    pub disk_free_percent: u32,
    /// Minimum minutes between two alerts of the same kind.
    pub cooldown_minutes: u32,
}

impl Default for AlertSettings {
    fn default() -> Self {
        Self {
            cpu: false,
            cpu_percent: 90,
            cpu_minutes: 2,
            memory: false,
            memory_percent: 90,
            disk: false,
            disk_free_percent: 10,
            cooldown_minutes: 30,
        }
    }
}

/// Checks a shortcut string such as `Ctrl+Alt+F`: at least one modifier plus one key, no duplicates.
pub fn is_valid_shortcut(s: &str) -> bool {
    let parts: Vec<String> = s.split('+').map(|p| p.trim().to_ascii_lowercase()).collect();
    if parts.len() < 2 || parts.iter().any(String::is_empty) {
        return false;
    }
    let (mods, key) = parts.split_at(parts.len() - 1);
    let modifier = |m: &str| matches!(m, "ctrl" | "control" | "alt" | "shift" | "super" | "win" | "cmdorctrl");
    if !mods.iter().all(|m| modifier(m)) || modifier(&key[0]) {
        return false;
    }
    let mut uniq = mods.to_vec();
    uniq.sort();
    uniq.dedup();
    if uniq.len() != mods.len() {
        return false;
    }
    let k = key[0].as_str();
    (k.len() == 1 && k.chars().all(|c| c.is_ascii_alphanumeric()))
        || (k.starts_with('f') && k[1..].parse::<u8>().is_ok_and(|n| (1..=24).contains(&n)))
        || matches!(k, "space" | "home" | "end" | "pageup" | "pagedown" | "insert" | "comma" | "period")
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct NotificationSettings {
    /// Show the FOCUS COMPLETE card when a focus session ends.
    pub focus_complete: bool,
    /// Show the BREAK COMPLETE card when a break ends.
    pub break_complete: bool,
    /// Play the Windows notification sound with the card. Off by default.
    pub sound: bool,
}

impl Default for NotificationSettings {
    fn default() -> Self {
        Self { focus_complete: true, break_complete: true, sound: false }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub version: u32,
    pub clock: ClockSettings,
    pub appearance: AppearanceSettings,
    pub cities: Vec<City>,
    pub ai: AiSettings,
    pub focus: FocusSettings,
    pub modules: ModuleSettings,
    pub system: SystemSettings,
    pub window: WindowSettings,
    pub shortcuts: ShortcutSettings,
    pub alerts: AlertSettings,
    pub profiles: ProfileSettings,
    pub notifications: NotificationSettings,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            version: SETTINGS_VERSION,
            clock: ClockSettings::default(),
            appearance: AppearanceSettings::default(),
            cities: default_cities(),
            ai: AiSettings::default(),
            focus: FocusSettings::default(),
            modules: ModuleSettings::default(),
            system: SystemSettings::default(),
            window: WindowSettings::default(),
            shortcuts: ShortcutSettings::default(),
            alerts: AlertSettings::default(),
            profiles: ProfileSettings::default(),
            notifications: NotificationSettings::default(),
        }
    }
}

pub fn is_valid_tz(tz: &str) -> bool {
    tz.parse::<chrono_tz::Tz>().is_ok()
}

fn clean_label(s: &str, max: usize) -> String {
    s.chars().filter(|c| !c.is_control()).collect::<String>().trim().to_uppercase().chars().take(max).collect()
}

fn snap_u32(v: u32, allowed: &[u32], fallback: u32) -> u32 {
    if allowed.contains(&v) {
        v
    } else {
        fallback
    }
}

impl Settings {
    /// Repairs invalid values in place. Returns a list of what was changed, for logging and the UI notice.
    pub fn validate(&mut self, allow_demo: bool) -> Vec<String> {
        let mut fixes = self.validate_core(allow_demo);
        profiles::validate(self, allow_demo, &mut fixes);
        // The active profile always mirrors the live layout.
        profiles::sync_active(self);
        fixes
    }

    /// Validates everything except the profile list.
    pub fn validate_core(&mut self, allow_demo: bool) -> Vec<String> {
        let mut fixes = Vec::new();
        self.version = SETTINGS_VERSION;

        let al = &mut self.alerts;
        for (v, lo, hi, def) in [
            (&mut al.cpu_percent, 50, 100, 90),
            (&mut al.cpu_minutes, 1, 60, 2),
            (&mut al.memory_percent, 50, 99, 90),
            (&mut al.disk_free_percent, 1, 50, 10),
            (&mut al.cooldown_minutes, 5, 1440, 30),
        ] {
            if !(lo..=hi).contains(v) {
                *v = if *v == 0 { def } else { (*v).clamp(lo, hi) };
                fixes.push("alert threshold reset".into());
            }
        }
        if let Some(id) = &self.window.display_id {
            if id.trim().is_empty() || id.len() > 512 {
                self.window.display_id = None;
            }
        }

        let c = &mut self.clock;
        if !(150..=600).contains(&c.animation_ms) {
            // 0 means the stored value was unreadable (lenient default): use the normal default.
            c.animation_ms = if c.animation_ms == 0 { ANIMATION_MS_DEFAULT } else { c.animation_ms.clamp(150, 600) };
            fixes.push("clock animation length reset".into());
        }
        for (v, lo, hi, name) in [(&mut c.scale, 0.7, 1.4, "clock size"), (&mut c.spacing, 0.5, 1.6, "digit spacing")] {
            if !v.is_finite() || !(lo..=hi).contains(v) {
                // 0.0 is the unreadable-value default; anything else is clamped.
                *v = if !v.is_finite() || *v == 0.0 { 1.0 } else { v.clamp(lo, hi) };
                fixes.push(format!("{name} reset"));
            }
        }

        if let Some(tz) = &self.clock.home_time_zone {
            if !is_valid_tz(tz) {
                fixes.push(format!("unknown home time zone '{tz}', using the system zone"));
                self.clock.home_time_zone = None;
            }
        }

        let a = &mut self.appearance;
        if !a.text_scale.is_finite() || !(0.8..=1.25).contains(&a.text_scale) {
            a.text_scale = a.text_scale.clamp(0.8, 1.25);
            if !a.text_scale.is_finite() {
                a.text_scale = 1.0;
            }
            fixes.push("text scale clamped to 0.8–1.25".into());
        }
        if !a.background_opacity.is_finite() || !(0.3..=1.0).contains(&a.background_opacity) {
            a.background_opacity = if a.background_opacity.is_finite() { a.background_opacity.clamp(0.3, 1.0) } else { 1.0 };
            fixes.push("background opacity clamped to 30–100%".into());
        }

        // Module order must be a permutation of the four movable modules.
        let m = &mut self.modules;
        let mut order: Vec<ModuleId> = Vec::new();
        for id in m.order.iter().copied() {
            if !order.contains(&id) {
                order.push(id);
            }
        }
        for id in DEFAULT_ORDER {
            if !order.contains(&id) {
                order.push(id);
            }
        }
        if order != m.order {
            m.order = order;
        }

        let defaults = ShortcutSettings::default();
        let sc = &mut self.shortcuts;
        for (field, fallback) in [
            (&mut sc.toggle, defaults.toggle),
            (&mut sc.settings, defaults.settings),
            (&mut sc.layout, defaults.layout),
            (&mut sc.focus, defaults.focus),
            (&mut sc.profile, defaults.profile),
        ] {
            if !is_valid_shortcut(field) {
                fixes.push(format!("invalid shortcut '{field}' reset to {fallback}"));
                *field = fallback;
            }
        }
        let mut seen_keys: Vec<String> = self.shortcuts.entries().iter().map(|(_, s)| s.to_ascii_lowercase().replace(' ', "")).collect();
        let n = seen_keys.len();
        seen_keys.sort();
        seen_keys.dedup();
        if seen_keys.len() != n {
            fixes.push("duplicate shortcuts reset to defaults".into());
            self.shortcuts = ShortcutSettings::default();
        }

        let before = self.cities.len();
        let mut seen = Vec::new();
        self.cities.retain_mut(|c| {
            c.name = clean_label(&c.name, 24);
            c.code = clean_label(&c.code, 4);
            let ok = !c.name.is_empty() && is_valid_tz(&c.tz) && !seen.contains(&(c.tz.clone(), c.name.clone()));
            if ok {
                seen.push((c.tz.clone(), c.name.clone()));
            }
            ok
        });
        if self.cities.len() > MAX_CITIES {
            self.cities.truncate(MAX_CITIES);
        }
        if self.cities.len() != before {
            fixes.push("removed invalid or duplicate cities".into());
        }

        let ai = &mut self.ai;
        let r = snap_u32(ai.refresh_minutes, &[1, 2, 5, 15], 2);
        if r != ai.refresh_minutes {
            ai.refresh_minutes = r;
            fixes.push("AI refresh interval reset".into());
        }
        if !ai.warn_at.is_finite() || !(0.5..=1.0).contains(&ai.warn_at) {
            ai.warn_at = 0.9;
            fixes.push("AI warn threshold reset".into());
        }
        ai.manual.retain(|id, m| {
            m.windows.retain(|w| w.used_percent.is_finite() && (0.0..=100.0).contains(&w.used_percent) && !w.key.trim().is_empty());
            for w in &mut m.windows {
                w.key = clean_label(&w.key, 4);
            }
            m.windows.truncate(4);
            (id == "claude" || id == "codex") && !m.windows.is_empty()
        });
        if ai.demo && !allow_demo {
            ai.demo = false;
        }
        if let Some(h) = &ai.codex.codex_home {
            if h.trim().is_empty() {
                ai.codex.codex_home = None;
            }
        }

        let f = &mut self.focus;
        let clamp = |v: &mut u32, lo: u32, hi: u32, name: &str, fixes: &mut Vec<String>| {
            if !(lo..=hi).contains(v) {
                *v = (*v).clamp(lo, hi);
                fixes.push(format!("{name} clamped to {lo}–{hi}"));
            }
        };
        clamp(&mut f.focus_minutes, 1, 180, "focus minutes", &mut fixes);
        clamp(&mut f.short_minutes, 1, 60, "short break minutes", &mut fixes);
        clamp(&mut f.long_minutes, 1, 90, "long break minutes", &mut fixes);
        clamp(&mut f.sessions, 1, 12, "sessions", &mut fixes);

        let s = snap_u32(self.system.sample_seconds, &[1, 2, 5], 1);
        if s != self.system.sample_seconds {
            self.system.sample_seconds = s;
            fixes.push("sample interval reset to 1s".into());
        }

        let w = &mut self.window;
        if w.hide_controls_after > 60 {
            w.hide_controls_after = 3;
        }
        for rect in [&mut w.windowed_rect, &mut w.compact_rect] {
            if let Some(p) = rect {
                if p.width < 320 || p.height < 180 || p.width > 16384 || p.height > 16384 {
                    *rect = None;
                    fixes.push("discarded invalid window placement".into());
                }
            }
        }
        if let Some(d) = &w.display {
            if d.trim().is_empty() || d.len() > 64 {
                w.display = None;
            }
        }
        fixes
    }
}

/// Upgrades an older settings document to the current layout.
pub fn migrate(mut v: Value) -> Value {
    let version = v.get("version").and_then(Value::as_u64).unwrap_or(0);
    if version < 1 {
        // v0 is the handoff schema: focus.{focus,short,long}, cities as-is, window.mode lowercase.
        if let Some(focus) = v.get_mut("focus").and_then(Value::as_object_mut) {
            for (old, new) in [("focus", "focusMinutes"), ("short", "shortMinutes"), ("long", "longMinutes")] {
                if let Some(x) = focus.remove(old) {
                    focus.entry(new).or_insert(x);
                }
            }
        }
        if let Some(win) = v.get_mut("window").and_then(Value::as_object_mut) {
            if let Some(mode) = win.get("mode").and_then(Value::as_str) {
                let m = match mode.to_ascii_lowercase().as_str() {
                    "fullscreen" => "fullscreen",
                    "compact" | "windowed" => "windowed",
                    _ => "borderless",
                };
                win.insert("mode".into(), Value::String(m.into()));
            }
            // These v0 fields have no equivalent. `display` carries over (v2 has display selection).
            for k in ["fallback", "clickThrough", "pixelShift", "dim"] {
                win.remove(k);
            }
        }
        if let Some(sys) = v.get_mut("system").and_then(Value::as_object_mut) {
            if let Some(u) = sys.get("tempUnit").and_then(Value::as_str) {
                let u = if u.eq_ignore_ascii_case("f") { "F" } else { "C" };
                sys.insert("tempUnit".into(), Value::String(u.into()));
            }
        }
        if let Some(ai) = v.get_mut("ai").and_then(Value::as_object_mut) {
            ai.remove("providers");
            ai.remove("notifyOnReset");
        }
        if let Some(obj) = v.as_object_mut() {
            obj.insert("version".into(), Value::from(1));
        }
    }
    if version < 2 {
        // v1 had one `mode` (windowed/borderless/fullscreen with a native title bar), a boolean
        // always-on-top and a single placement. v2 is always borderless and splits mode from layer.
        if let Some(win) = v.get_mut("window").and_then(Value::as_object_mut) {
            let mode = match win.get("mode").and_then(Value::as_str) {
                Some("fullscreen") => "ambient",
                _ => "windowed",
            };
            win.insert("mode".into(), Value::String(mode.into()));
            let on_top = win.remove("alwaysOnTop").and_then(|x| x.as_bool()).unwrap_or(false);
            win.insert("layer".into(), Value::String(if on_top { "top" } else { "desktop" }.into()));
            if let Some(x) = win.remove("startInTray") {
                win.entry("startHidden").or_insert(x);
            }
            if let Some(p) = win.remove("placement") {
                win.entry("windowedRect").or_insert(p);
            }
        }
        if let Some(obj) = v.as_object_mut() {
            obj.insert("version".into(), Value::from(2));
        }
    }
    if version < 4 {
        // v4 records the region preset per mode. Installs that already saved a hand-placed
        // rectangle get no region (nothing is highlighted), instead of a wrong one.
        if let Some(win) = v.get_mut("window").and_then(Value::as_object_mut) {
            for (rect, region) in [("windowedRect", "windowedRegion"), ("compactRect", "compactRegion")] {
                if win.get(rect).is_some_and(|r| !r.is_null()) && !win.contains_key(region) {
                    win.insert(region.into(), Value::Null);
                }
            }
        }
    }
    if version < 3 {
        // v3 adds Clock Studio. Existing installs keep the dot-matrix clock they already had,
        // even if a future default changes.
        if let Some(obj) = v.as_object_mut() {
            let clock = obj.entry("clock").or_insert_with(|| Value::Object(Default::default()));
            if let Some(c) = clock.as_object_mut() {
                c.entry("template").or_insert(Value::String("dotMatrix".into()));
            }
            obj.insert("version".into(), Value::from(3));
        }
    }
    if let Some(obj) = v.as_object_mut() {
        obj.insert("version".into(), Value::from(SETTINGS_VERSION));
    }
    v
}

/// Migration steps that need the typed settings. `from_version` is the file's original version.
pub fn finish_migration(s: &mut Settings, from_version: u64) {
    if from_version < 5 {
        profiles::upgrade_from_pre_profiles(s);
    }
}

pub struct Loaded {
    pub settings: Settings,
    /// Shown once in the UI when something had to be repaired.
    pub notice: Option<String>,
}

pub fn load(path: &Path, allow_demo: bool) -> Loaded {
    let raw = match fs::read_to_string(path) {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Loaded { settings: Settings::default(), notice: None };
        }
        Err(e) => {
            log::warn!("settings unreadable: {e}");
            return Loaded { settings: Settings::default(), notice: Some("SETTINGS UNREADABLE · USING DEFAULTS".into()) };
        }
    };
    let mut from_version = SETTINGS_VERSION as u64;
    let parsed = serde_json::from_str::<Value>(&raw)
        .map(|v| {
            from_version = v.get("version").and_then(Value::as_u64).unwrap_or(0);
            migrate(v)
        })
        .and_then(serde_json::from_value::<Settings>);
    match parsed {
        Ok(mut s) => {
            finish_migration(&mut s, from_version);
            let fixes = s.validate(allow_demo);
            if !fixes.is_empty() {
                log::warn!("settings repaired: {}", fixes.join("; "));
            }
            let notice = (!fixes.is_empty()).then(|| "SOME SETTINGS WERE INVALID AND WERE RESET".to_string());
            Loaded { settings: s, notice }
        }
        Err(e) => {
            let backup = path.with_extension(format!("corrupt-{}.json", Utc::now().format("%Y%m%d%H%M%S")));
            let _ = fs::rename(path, &backup);
            log::warn!("settings corrupt ({e}); moved to {}", backup.display());
            Loaded { settings: Settings::default(), notice: Some("SETTINGS FILE WAS CORRUPT · BACKED UP · USING DEFAULTS".into()) }
        }
    }
}

pub fn save(path: &Path, s: &Settings) -> std::io::Result<()> {
    let bytes = serde_json::to_vec_pretty(s).map_err(std::io::Error::other)?;
    atomic_write(path, &bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn defaults_are_valid_and_include_required_cities() {
        let mut s = Settings::default();
        assert!(s.validate(false).is_empty());
        let names: Vec<_> = s.cities.iter().map(|c| c.name.as_str()).collect();
        for n in ["MANILA", "LONDON", "NEW YORK", "TOKYO", "SYDNEY", "DUBAI"] {
            assert!(names.contains(&n), "{n} missing");
        }
    }

    #[test]
    fn partial_file_fills_defaults() {
        let s: Settings = serde_json::from_value(json!({ "version": 1, "clock": { "h24": false } })).unwrap();
        assert!(!s.clock.h24);
        assert!(s.clock.ghost_dots);
        assert_eq!(s.focus.focus_minutes, 25);
    }

    #[test]
    fn validate_repairs_bad_values() {
        let mut s = Settings::default();
        s.clock.home_time_zone = Some("Mars/Olympus".into());
        s.cities.push(City::new("ATLANTIS", "ATL", "Ocean/Atlantis"));
        s.cities.push(City::new("london", "lhr", "Europe/London")); // duplicate after uppercasing
        s.focus.focus_minutes = 0;
        s.focus.sessions = 99;
        s.system.sample_seconds = 3;
        s.ai.warn_at = f64::NAN;
        s.ai.refresh_minutes = 7;
        s.ai.demo = true;
        let fixes = s.validate(false);
        assert!(!fixes.is_empty());
        assert_eq!(s.clock.home_time_zone, None);
        assert_eq!(s.cities.len(), 6);
        assert_eq!(s.focus.focus_minutes, 1);
        assert_eq!(s.focus.sessions, 12);
        assert_eq!(s.system.sample_seconds, 1);
        assert_eq!(s.ai.warn_at, 0.9);
        assert_eq!(s.ai.refresh_minutes, 2);
        assert!(!s.ai.demo, "demo must be forced off when not allowed");
    }

    #[test]
    fn validate_caps_city_count() {
        let mut s = Settings::default();
        for tz in ["Europe/Paris", "Europe/Berlin", "Asia/Seoul", "America/Chicago"] {
            s.cities.push(City::new(tz, "X", tz));
        }
        s.validate(false);
        assert_eq!(s.cities.len(), MAX_CITIES);
    }

    #[test]
    fn manual_usage_is_sanitised() {
        let mut s = Settings::default();
        s.ai.manual.insert(
            "claude".into(),
            ManualUsage {
                windows: vec![
                    ManualWindow { key: "5h".into(), used_percent: 40.0, resets_at: None },
                    ManualWindow { key: "7d".into(), used_percent: 140.0, resets_at: None },
                ],
                entered_at: Utc::now(),
            },
        );
        s.ai.manual.insert(
            "evil".into(),
            ManualUsage { windows: vec![ManualWindow { key: "X".into(), used_percent: 1.0, resets_at: None }], entered_at: Utc::now() },
        );
        s.validate(false);
        let m = &s.ai.manual["claude"];
        assert_eq!(m.windows.len(), 1);
        assert_eq!(m.windows[0].key, "5H");
        assert!(!s.ai.manual.contains_key("evil"));
    }

    #[test]
    fn migrates_v0_handoff_schema() {
        let v0 = json!({
            "clock": { "h24": true, "homeTimeZone": "Asia/Singapore" },
            "focus": { "focus": 50, "short": 10, "long": 20, "sessions": 4, "autoStart": true, "sound": "chime" },
            "window": { "alwaysOnTop": true, "mode": "fullscreen", "display": "\\\\.\\DISPLAY2", "pixelShift": true },
            "system": { "tempUnit": "f", "sampleSeconds": 2 },
            "ai": { "refreshMinutes": 5, "providers": [ { "id": "claude" } ] }
        });
        let s: Settings = serde_json::from_value(migrate(v0)).unwrap();
        assert_eq!(s.version, 5);
        assert_eq!(s.focus.focus_minutes, 50);
        assert_eq!(s.focus.short_minutes, 10);
        assert_eq!(s.focus.long_minutes, 20);
        assert!(s.focus.auto_start);
        assert_eq!(s.window.mode, DisplayMode::Ambient);
        assert_eq!(s.window.layer, WindowLayer::Top);
        assert_eq!(s.window.display.as_deref(), Some(r"\\.\DISPLAY2"));
        assert_eq!(s.system.temp_unit, TempUnit::F);
        assert_eq!(s.ai.refresh_minutes, 5);
        assert_eq!(s.clock.home_time_zone.as_deref(), Some("Asia/Singapore"));
    }

    #[test]
    fn corrupt_file_falls_back_and_is_backed_up() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("settings.json");
        fs::write(&p, "{ not json").unwrap();
        let l = load(&p, false);
        assert_eq!(l.settings, Settings::default());
        assert!(l.notice.is_some());
        assert!(!p.exists(), "corrupt file should be moved aside");
        let backups = fs::read_dir(dir.path()).unwrap().count();
        assert_eq!(backups, 1);
    }

    #[test]
    fn wrong_types_fall_back_instead_of_crashing() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("settings.json");
        fs::write(&p, r#"{ "version": 1, "focus": { "focusMinutes": "lots" } }"#).unwrap();
        let l = load(&p, false);
        assert_eq!(l.settings.focus.focus_minutes, 25);
        assert!(l.notice.is_some());
    }

    #[test]
    fn missing_file_is_silent_defaults() {
        let dir = tempfile::tempdir().unwrap();
        let l = load(&dir.path().join("nope.json"), false);
        assert!(l.notice.is_none());
        assert_eq!(l.settings, Settings::default());
    }

    #[test]
    fn save_then_load_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("settings.json");
        let mut s = Settings::default();
        s.clock.seconds = true;
        s.cities.truncate(2);
        // The app always validates before saving (which also syncs the active profile).
        assert!(s.validate(false).is_empty());
        save(&p, &s).unwrap();
        let l = load(&p, false);
        assert_eq!(l.settings, s);
        assert!(l.notice.is_none());
    }

    #[test]
    fn migrates_v1_window_settings() {
        let v1 = json!({
            "version": 1,
            "window": { "alwaysOnTop": false, "mode": "windowed", "startInTray": true,
                        "placement": { "x": 10, "y": 20, "width": 1280, "height": 720, "monitor": null } },
            "appearance": { "font": "cascadia" }
        });
        let s: Settings = serde_json::from_value(migrate(v1)).unwrap();
        assert_eq!(s.version, 5);
        assert_eq!(s.window.mode, DisplayMode::Windowed);
        assert_eq!(s.window.layer, WindowLayer::Desktop);
        assert!(s.window.start_hidden);
        assert_eq!(s.window.windowed_rect.as_ref().map(|p| (p.x, p.width)), Some((10, 1280)));
        assert_eq!(s.appearance.font, FontChoice::Cascadia);
        assert_eq!(s.appearance.background_opacity, 1.0);
        assert_eq!(s.modules.order, DEFAULT_ORDER.to_vec());
        let v1_full = json!({ "version": 1, "window": { "alwaysOnTop": true, "mode": "fullscreen" } });
        let s: Settings = serde_json::from_value(migrate(v1_full)).unwrap();
        assert_eq!((s.window.mode, s.window.layer), (DisplayMode::Ambient, WindowLayer::Top));
    }

    #[test]
    fn shortcut_validation() {
        for ok in ["Ctrl+Alt+F", "ctrl+shift+F12", "Alt+Shift+Space", "Super+Alt+1"] {
            assert!(is_valid_shortcut(ok), "{ok}");
        }
        for bad in ["F", "Ctrl+Alt", "Ctrl++F", "Ctrl+Ctrl+F", "Ctrl+Alt+Hello", "Ctrl+F99", ""] {
            assert!(!is_valid_shortcut(bad), "{bad}");
        }
        let mut s = Settings::default();
        s.shortcuts.toggle = "nonsense".into();
        assert!(!s.validate(false).is_empty());
        assert_eq!(s.shortcuts.toggle, "Ctrl+Alt+F");
        s.shortcuts.layout = "ctrl+alt+s".into(); // duplicates the settings shortcut
        s.validate(false);
        assert_eq!(s.shortcuts, ShortcutSettings::default());
    }

    #[test]
    fn module_order_and_opacity_are_repaired() {
        let mut s = Settings::default();
        s.modules.order = vec![ModuleId::Focus, ModuleId::Focus, ModuleId::World];
        s.appearance.background_opacity = 0.05;
        s.validate(false);
        assert_eq!(s.modules.order, vec![ModuleId::Focus, ModuleId::World, ModuleId::Ai, ModuleId::System]);
        assert_eq!(s.appearance.background_opacity, 0.3);
        assert_eq!(LayoutPreset::System.next(), LayoutPreset::Balanced);
    }

    #[test]
    fn migrates_v2_and_keeps_dot_matrix_clock() {
        let v2 = json!({
            "version": 2,
            "clock": { "h24": false, "seconds": true, "dotShape": "square", "ghostDots": false },
            "window": { "mode": "ambient", "layer": "top", "display": "DISPLAY2" },
            "modules": { "preset": "clock" }
        });
        let s: Settings = serde_json::from_value(migrate(v2)).unwrap();
        assert_eq!(s.version, 5);
        assert_eq!(s.clock.template, ClockTemplate::DotMatrix);
        assert!(!s.clock.h24 && s.clock.seconds && !s.clock.ghost_dots);
        assert_eq!(s.clock.dot_shape, DotShape::Square);
        assert!(s.clock.animate);
        assert_eq!(s.clock.animation_ms, ANIMATION_MS_DEFAULT);
        // Unrelated preferences survive.
        assert_eq!(s.window.mode, DisplayMode::Ambient);
        assert_eq!(s.window.layer, WindowLayer::Top);
        assert_eq!(s.window.display.as_deref(), Some("DISPLAY2"));
        assert_eq!(s.modules.preset, LayoutPreset::Clock);
    }

    #[test]
    fn unknown_clock_values_fall_back_without_losing_other_settings() {
        let raw = json!({
            "version": 3,
            "clock": { "template": "hologram", "ink": 7, "flapPanel": "neon", "animate": "yes", "animationMs": "fast",
                       "scale": "huge", "h24": false },
            "window": { "layer": "top" }
        });
        let mut s: Settings = serde_json::from_value(raw).unwrap();
        s.validate(false);
        assert_eq!(s.clock.template, ClockTemplate::SplitFlap, "unknown template falls back to the default");
        assert_eq!(s.clock.ink, ClockInk::Bright);
        assert_eq!(s.clock.flap_panel, FlapPanel::Graphite);
        assert_eq!(s.clock.animation_ms, ANIMATION_MS_DEFAULT);
        assert_eq!(s.clock.scale, 1.0);
        assert!(!s.clock.animate, "an unreadable bool falls back to false, never errors");
        assert!(!s.clock.h24, "valid sibling fields are kept");
        assert_eq!(s.window.layer, WindowLayer::Top);
    }

    #[test]
    fn clock_ranges_are_clamped() {
        let mut s = Settings::default();
        s.clock.animation_ms = 5000;
        s.clock.scale = 3.0;
        s.clock.spacing = 0.1;
        s.validate(false);
        assert_eq!(s.clock.animation_ms, 600);
        assert_eq!(s.clock.scale, 1.4);
        assert_eq!(s.clock.spacing, 0.5);
    }

    #[test]
    fn clock_studio_round_trips_and_defaults_restore() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("settings.json");
        let mut s = Settings::default();
        s.clock.template = ClockTemplate::SplitFlap;
        s.clock.animation_ms = 400;
        s.clock.flap_seam = false;
        s.clock.ink = ClockInk::Soft;
        save(&p, &s).unwrap();
        let l = load(&p, false);
        assert_eq!(l.settings.clock.template, ClockTemplate::SplitFlap);
        assert_eq!(l.settings.clock.animation_ms, 400);
        assert!(!l.settings.clock.flap_seam);
        assert!(l.notice.is_none());
        let d = Settings::default();
        assert_eq!(d.clock.template, ClockTemplate::SplitFlap, "new installs default to split flap");
        assert!(d.clock.animate && d.clock.flap_seam && d.clock.flap_shadow);
    }

    #[test]
    fn new_install_defaults() {
        let s = Settings::default();
        assert_eq!(s.window.layer, WindowLayer::Desktop);
        assert_eq!(s.window.mode, DisplayMode::Windowed);
        assert_eq!(s.window.windowed_region, Some(Region::RightHalf));
        assert_eq!(s.window.region(), Some(Region::RightHalf));
        assert_eq!(s.modules.preset, LayoutPreset::Balanced);
        assert_eq!(s.modules.layout, LayoutPref::Full);
    }

    #[test]
    fn migrates_v3_regions() {
        // A hand-placed window keeps no region; an untouched one keeps the default.
        let placed = json!({ "version": 3, "window": { "windowedRect": { "x": 5, "y": 5, "width": 900, "height": 700, "monitor": null } },
                             "modules": { "layout": "auto" } });
        let s: Settings = serde_json::from_value(migrate(placed)).unwrap();
        assert_eq!(s.version, 5);
        assert_eq!(s.window.windowed_region, None);
        assert_eq!(s.modules.layout, LayoutPref::Auto, "existing density choice is kept");
        let fresh: Settings = serde_json::from_value(migrate(json!({ "version": 3, "window": {} }))).unwrap();
        assert_eq!(fresh.window.windowed_region, Some(Region::RightHalf));
        let bad: Settings = serde_json::from_value(json!({ "version": 4, "window": { "windowedRegion": "sideways" } })).unwrap();
        assert_eq!(bad.window.windowed_region, None, "unknown region falls back to none, not an error");
    }

    #[test]
    fn v4_file_upgrades_to_profiles_without_changing_the_layout() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("settings.json");
        let v4 = json!({
            "version": 4,
            "clock": { "template": "minimal", "seconds": true },
            "modules": { "preset": "system", "layout": "compact" },
            "window": { "mode": "compact", "layer": "top", "compactRegion": "bottomRight" },
            "shortcuts": { "toggle": "Ctrl+Alt+F", "settings": "Ctrl+Alt+S", "layout": "Ctrl+Alt+L", "focus": "Ctrl+Alt+P" }
        });
        fs::write(&p, v4.to_string()).unwrap();
        let l = load(&p, false);
        let s = l.settings;
        assert_eq!(s.version, 5);
        assert_eq!(s.clock.template, ClockTemplate::Minimal);
        assert_eq!(s.window.mode, DisplayMode::Compact);
        assert_eq!(s.window.compact_region, Some(Region::BottomRight));
        assert_eq!(s.profiles.active, "custom");
        let custom = s.profiles.items.iter().find(|x| x.id == "custom").unwrap();
        assert_eq!(custom.clock.template, ClockTemplate::Minimal);
        assert_eq!(custom.modules.preset, LayoutPreset::System);
        assert_eq!(s.shortcuts.profile, "Ctrl+Alt+N", "new shortcut gets its default");
        assert!(!s.alerts.cpu && !s.alerts.memory && !s.alerts.disk, "alerts stay opt-in");
    }

    #[test]
    fn v5_round_trip_keeps_active_profile() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("settings.json");
        let mut s = Settings::default();
        profiles::apply(&mut s, &profiles::builtin("ambient"));
        s.profiles.active = "ambient".into();
        s.validate(false);
        save(&p, &s).unwrap();
        let l = load(&p, false);
        assert_eq!(l.settings.profiles.active, "ambient");
        assert_eq!(l.settings.window.mode, DisplayMode::Ambient);
        assert!(l.notice.is_none());
    }

    #[test]
    fn alert_thresholds_are_clamped() {
        let mut s = Settings::default();
        s.alerts.cpu_percent = 5;
        s.alerts.disk_free_percent = 0;
        s.alerts.cooldown_minutes = 99999;
        s.validate(false);
        assert_eq!(s.alerts.cpu_percent, 50);
        assert_eq!(s.alerts.disk_free_percent, 10);
        assert_eq!(s.alerts.cooldown_minutes, 1440);
    }

    #[test]
    fn completion_sound_defaults_off_and_older_files_keep_their_choices() {
        assert!(!Settings::default().notifications.sound);
        // A 0.3.0 file has no `sound` key: it loads as off, and the other choices are kept.
        let n: NotificationSettings = serde_json::from_str(r#"{"focusComplete":false,"breakComplete":true}"#).unwrap();
        assert_eq!(n, NotificationSettings { focus_complete: false, break_complete: true, sound: false });
    }
}
