//! Profiles: named snapshots of the layout-related parts of `Settings`.
//!
//! A profile owns the dashboard's *look and placement*: module visibility/order/preset/density,
//! the Clock Studio appearance, appearance (board colour, opacity, typeface) and window placement
//! (display, mode, layer, regions and saved rectangles). Everything else — time zone, 12/24-hour,
//! date format, cities, AI sources, Pomodoro, startup, shortcuts — is shared by all profiles.
//!
//! There is one settings system: the live fields in `Settings` are what FLIP renders, and the
//! active profile mirrors them (every change is written back to it). Switching profile copies a
//! snapshot into the live fields.

use serde::{Deserialize, Serialize};

use super::settings::{
    AppearanceSettings, ClockSettings, ClockTemplate, DisplayMode, LayoutPref, LayoutPreset, ModuleId, ModuleSettings, Region, Settings,
    WindowSettings,
};

pub const MAX_PROFILES: usize = 16;
pub const BUILTIN_IDS: [&str; 5] = ["developer", "ambient", "focus", "gaming", "custom"];

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Profile {
    pub id: String,
    pub name: String,
    pub builtin: bool,
    pub modules: ModuleSettings,
    /// Only the appearance fields are used (see `apply`); time zone and formats are global.
    pub clock: ClockSettings,
    pub appearance: AppearanceSettings,
    /// Only placement fields are used (see `apply`); startup and close behaviour are global.
    pub window: WindowSettings,
}

impl Default for Profile {
    fn default() -> Self {
        builtin("developer")
    }
}

/// Optional automatic switching when the number of connected displays changes
/// (e.g. docking a laptop). Off by default.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct AutoSwitch {
    pub enabled: bool,
    /// Profile to use when only one display is connected.
    pub single_display: Option<String>,
    /// Profile to use when two or more displays are connected.
    pub multi_display: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ProfileSettings {
    pub active: String,
    pub items: Vec<Profile>,
    pub auto_switch: AutoSwitch,
}

impl Default for ProfileSettings {
    fn default() -> Self {
        Self { active: "developer".into(), items: BUILTIN_IDS.iter().map(|id| builtin(id)).collect(), auto_switch: AutoSwitch::default() }
    }
}

/// The factory definition of a built-in profile.
pub fn builtin(id: &str) -> Profile {
    // Built from the component defaults (not Settings::default, which contains profiles).
    let mut p = Profile {
        id: id.to_string(),
        name: id.to_uppercase(),
        builtin: true,
        modules: ModuleSettings::default(),
        clock: ClockSettings::default(),
        appearance: AppearanceSettings::default(),
        window: WindowSettings::default(),
    };
    match id {
        // Large clock with glanceable extras; fills a display.
        "ambient" => {
            p.window.mode = DisplayMode::Ambient;
            p.modules.preset = LayoutPreset::Clock;
            p.modules.keys = false;
            p.clock.scale = 1.15;
        }
        // Clock, focus timer and date only.
        "focus" => {
            p.modules.ai = false;
            p.modules.world = false;
            p.modules.system = false;
            p.modules.keys = false;
            p.modules.order = vec![ModuleId::Focus, ModuleId::System, ModuleId::Ai, ModuleId::World];
        }
        // Small always-visible system readout in a corner.
        "gaming" => {
            p.window.mode = DisplayMode::Compact;
            p.window.compact_region = Some(Region::TopRight);
            p.modules.layout = LayoutPref::Compact;
            p.modules.preset = LayoutPreset::System;
            p.modules.ai = false;
            p.modules.world = false;
            p.modules.focus = false;
            p.modules.keys = false;
            p.clock.template = ClockTemplate::SevenSegment;
        }
        // "developer" and "custom" use the defaults: clock, AI usage, system, focus, world clock.
        _ => {}
    }
    p
}

/// Copies a profile's snapshot into the live settings. Global preferences are untouched.
pub fn apply(s: &mut Settings, p: &Profile) {
    s.modules = p.modules.clone();
    s.appearance = p.appearance.clone();
    let c = &p.clock;
    let l = &mut s.clock;
    l.template = c.template;
    l.seconds = c.seconds;
    l.blink = c.blink;
    l.scale = c.scale;
    l.spacing = c.spacing;
    l.ink = c.ink;
    l.animate = c.animate;
    l.animation_ms = c.animation_ms;
    l.flap_seam = c.flap_seam;
    l.flap_shadow = c.flap_shadow;
    l.flap_panel = c.flap_panel;
    l.dot_shape = c.dot_shape;
    l.ghost_dots = c.ghost_dots;
    let w = &p.window;
    let lw = &mut s.window;
    lw.mode = w.mode;
    lw.layer = w.layer;
    lw.display = w.display.clone();
    lw.display_id = w.display_id.clone();
    lw.windowed_rect = w.windowed_rect.clone();
    lw.compact_rect = w.compact_rect.clone();
    lw.windowed_region = w.windowed_region;
    lw.compact_region = w.compact_region;
}

/// Captures the live settings into a profile with the given identity.
pub fn capture(s: &Settings, id: &str, name: &str, builtin: bool) -> Profile {
    Profile {
        id: id.to_string(),
        name: name.to_string(),
        builtin,
        modules: s.modules.clone(),
        clock: s.clock.clone(),
        appearance: s.appearance.clone(),
        window: s.window.clone(),
    }
}

/// Writes the live settings back into the active profile (the active profile always mirrors
/// what is on screen).
pub fn sync_active(s: &mut Settings) {
    let active = s.profiles.active.clone();
    let snapshot = s.clone();
    if let Some(p) = s.profiles.items.iter_mut().find(|p| p.id == active) {
        *p = capture(&snapshot, &p.id, &p.name, p.builtin);
    }
}

/// Upgrade from settings v4 and earlier: the user's current layout becomes the CUSTOM profile
/// and stays active, so nothing on screen changes.
pub fn upgrade_from_pre_profiles(s: &mut Settings) {
    s.profiles = ProfileSettings::default();
    s.profiles.active = "custom".into();
    sync_active(s);
}

pub fn clean_name(name: &str) -> String {
    name.chars().filter(|c| !c.is_control()).collect::<String>().trim().to_uppercase().chars().take(24).collect()
}

/// Repairs the profile list: built-ins present and first, unique ids and names, a valid active id,
/// a bounded count, valid auto-switch targets, and each snapshot validated like live settings.
pub fn validate(s: &mut Settings, allow_demo: bool, fixes: &mut Vec<String>) {
    let mut seen: Vec<String> = Vec::new();
    let mut items: Vec<Profile> = Vec::new();
    // Built-ins first, in fixed order, keeping the user's edits to them.
    for id in BUILTIN_IDS {
        let p = s.profiles.items.iter().find(|p| p.id == id).cloned().unwrap_or_else(|| builtin(id));
        items.push(Profile {
            builtin: true,
            id: id.into(),
            name: if p.name.trim().is_empty() { id.to_uppercase() } else { clean_name(&p.name) },
            ..p
        });
        seen.push(id.into());
    }
    for p in s.profiles.items.iter() {
        if seen.contains(&p.id) {
            continue;
        }
        let ok_id = !p.id.is_empty() && p.id.len() <= 40 && p.id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-');
        if !ok_id || items.len() >= MAX_PROFILES {
            fixes.push("removed an invalid profile".into());
            continue;
        }
        let name = clean_name(&p.name);
        items.push(Profile { builtin: false, name: if name.is_empty() { "PROFILE".into() } else { name }, ..p.clone() });
        seen.push(p.id.clone());
    }
    // Validate each snapshot by round-tripping it through the live-settings validator.
    for p in items.iter_mut() {
        let mut tmp = Settings::default();
        apply(&mut tmp, p);
        let sub = tmp.validate_core(allow_demo);
        if !sub.is_empty() {
            fixes.push(format!("profile {} repaired", p.name));
        }
        *p = capture(&tmp, &p.id, &p.name, p.builtin);
    }
    s.profiles.items = items;
    if !seen.contains(&s.profiles.active) {
        fixes.push("active profile missing; using CUSTOM".into());
        s.profiles.active = "custom".into();
    }
    let a = &mut s.profiles.auto_switch;
    for target in [&mut a.single_display, &mut a.multi_display] {
        if target.as_ref().is_some_and(|t| !seen.contains(t)) {
            *target = None;
        }
    }
}

/// Which profile to activate when the display count changes, if any.
pub fn auto_switch_target(a: &AutoSwitch, display_count: usize, active: &str) -> Option<String> {
    if !a.enabled || display_count == 0 {
        return None;
    }
    let target = if display_count > 1 { a.multi_display.as_ref() } else { a.single_display.as_ref() }?;
    (target != active).then(|| target.clone())
}

/// True when a display check should trigger auto-switching: the count changed since the last
/// check. `prev == 0` is the first check after launch, which never switches (the saved profile is
/// restored instead).
pub fn display_count_changed(prev: usize, now: usize) -> bool {
    prev != 0 && now != 0 && prev != now
}

/// A new unique id for a custom profile.
pub fn new_id(existing: &[Profile], now_ms: i64) -> String {
    let mut n = now_ms.max(0);
    loop {
        let id = format!("user-{n:x}");
        if !existing.iter().any(|p| p.id == id) {
            return id;
        }
        n += 1;
    }
}

/// A unique display name ("DEVELOPER COPY", "DEVELOPER COPY 2", …).
pub fn unique_name(existing: &[Profile], wanted: &str) -> String {
    let base = clean_name(wanted);
    let base = if base.is_empty() { "PROFILE".to_string() } else { base };
    if !existing.iter().any(|p| p.name == base) {
        return base;
    }
    (2..).map(|i| format!("{} {i}", base.chars().take(21).collect::<String>())).find(|n| !existing.iter().any(|p| &p.name == n)).unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::settings::{migrate, ClockInk, WindowLayer};
    use serde_json::json;

    #[test]
    fn auto_switch_only_on_a_change_after_launch() {
        assert!(!display_count_changed(0, 2), "first check after launch keeps the restored profile");
        assert!(!display_count_changed(2, 2));
        assert!(display_count_changed(2, 1), "laptop undocked");
        assert!(display_count_changed(1, 3), "docked");
        assert!(!display_count_changed(2, 0), "transient zero while displays reconfigure");
    }

    #[test]
    fn builtins_are_distinct_and_sensible() {
        let dev = builtin("developer");
        assert_eq!(dev.window.mode, DisplayMode::Windowed);
        assert_eq!(dev.window.windowed_region, Some(Region::RightHalf));
        assert!(dev.modules.ai && dev.modules.system && dev.modules.focus);
        assert_eq!(dev.clock.template, ClockTemplate::SplitFlap);
        let amb = builtin("ambient");
        assert_eq!(amb.window.mode, DisplayMode::Ambient);
        assert_eq!(amb.modules.preset, LayoutPreset::Clock);
        let focus = builtin("focus");
        assert!(focus.modules.focus && !focus.modules.ai && !focus.modules.system && !focus.modules.world);
        let gaming = builtin("gaming");
        assert_eq!(gaming.window.mode, DisplayMode::Compact);
        assert!(gaming.modules.system && !gaming.modules.ai);
        assert_eq!(gaming.window.layer, WindowLayer::Desktop, "never forced on top of games");
    }

    #[test]
    fn apply_changes_only_profile_fields() {
        let mut s = Settings::default();
        s.clock.h24 = false;
        s.clock.home_time_zone = Some("Asia/Manila".into());
        s.window.launch_on_startup = true;
        s.focus.focus_minutes = 50;
        apply(&mut s, &builtin("gaming"));
        assert_eq!(s.window.mode, DisplayMode::Compact);
        assert_eq!(s.clock.template, ClockTemplate::SevenSegment);
        assert!(!s.clock.h24, "12/24h is global");
        assert_eq!(s.clock.home_time_zone.as_deref(), Some("Asia/Manila"), "time zone is global");
        assert!(s.window.launch_on_startup, "startup is global");
        assert_eq!(s.focus.focus_minutes, 50, "Pomodoro is global");
    }

    #[test]
    fn capture_then_apply_round_trips() {
        let mut s = Settings::default();
        s.clock.template = ClockTemplate::Terminal;
        s.clock.ink = ClockInk::Dim;
        s.modules.world = false;
        s.window.display = Some(r"\\.\DISPLAY2".into());
        s.window.display_id = Some("MONITOR-B".into());
        let p = capture(&s, "user-1", "DESK", false);
        let mut t = Settings::default();
        apply(&mut t, &p);
        assert_eq!(capture(&t, "user-1", "DESK", false), p, "profile fields round-trip exactly");
        assert_eq!(t.window.display_id.as_deref(), Some("MONITOR-B"));
    }

    #[test]
    fn active_profile_mirrors_live_changes() {
        let mut s = Settings::default();
        s.modules.world = false;
        sync_active(&mut s);
        let dev = s.profiles.items.iter().find(|p| p.id == "developer").unwrap();
        assert!(!dev.modules.world);
        let amb = s.profiles.items.iter().find(|p| p.id == "ambient").unwrap();
        assert!(amb.modules.world, "other profiles are untouched");
    }

    #[test]
    fn upgrade_keeps_the_current_layout_as_custom() {
        let v4 = json!({
            "version": 4,
            "clock": { "template": "dotMatrix", "h24": false },
            "modules": { "preset": "ai", "layout": "auto", "world": false },
            "window": { "mode": "compact", "layer": "top", "display": r"\\.\DISPLAY2" },
            "appearance": { "backgroundOpacity": 0.6 }
        });
        let mut s: Settings = serde_json::from_value(migrate(v4)).unwrap();
        crate::services::settings::finish_migration(&mut s, 4);
        assert_eq!(s.profiles.active, "custom");
        let custom = s.profiles.items.iter().find(|p| p.id == "custom").unwrap();
        assert_eq!(custom.clock.template, ClockTemplate::DotMatrix);
        assert_eq!(custom.modules.preset, LayoutPreset::Ai);
        assert_eq!(custom.window.mode, DisplayMode::Compact);
        assert_eq!(custom.window.layer, WindowLayer::Top);
        assert_eq!(custom.appearance.background_opacity, 0.6);
        // Live settings unchanged.
        assert_eq!(s.clock.template, ClockTemplate::DotMatrix);
        assert!(!s.clock.h24);
        assert_eq!(s.profiles.items.len(), BUILTIN_IDS.len());
    }

    #[test]
    fn validation_repairs_profile_lists() {
        let mut s = Settings::default();
        s.profiles.items.retain(|p| p.id != "focus"); // a built-in went missing
        let mut bad = builtin("developer");
        bad.id = "../evil".into();
        s.profiles.items.push(bad);
        let mut dup = builtin("developer");
        dup.id = "user-1".into();
        dup.name = "  my desk  ".into();
        dup.builtin = true; // cannot claim to be built-in
        dup.clock.scale = 9.0; // invalid snapshot value
        s.profiles.items.push(dup);
        s.profiles.active = "nope".into();
        s.profiles.auto_switch.multi_display = Some("ghost".into());
        let fixes = s.validate(false);
        assert!(!fixes.is_empty());
        let ids: Vec<_> = s.profiles.items.iter().map(|p| p.id.as_str()).collect();
        assert_eq!(&ids[..5], &BUILTIN_IDS);
        assert_eq!(ids.len(), 6);
        let user = &s.profiles.items[5];
        assert_eq!(user.name, "MY DESK");
        assert!(!user.builtin);
        assert_eq!(user.clock.scale, 1.4, "snapshot validated like live settings");
        assert_eq!(s.profiles.active, "custom");
        assert_eq!(s.profiles.auto_switch.multi_display, None);
    }

    #[test]
    fn auto_switch_decisions() {
        let a = AutoSwitch { enabled: true, single_display: Some("focus".into()), multi_display: Some("ambient".into()) };
        assert_eq!(auto_switch_target(&a, 2, "focus"), Some("ambient".into()));
        assert_eq!(auto_switch_target(&a, 1, "ambient"), Some("focus".into()));
        assert_eq!(auto_switch_target(&a, 1, "focus"), None, "already active");
        assert_eq!(auto_switch_target(&a, 0, "focus"), None, "no displays reported: do nothing");
        let off = AutoSwitch { enabled: false, ..a.clone() };
        assert_eq!(auto_switch_target(&off, 2, "focus"), None);
        let partial = AutoSwitch { enabled: true, single_display: None, multi_display: Some("ambient".into()) };
        assert_eq!(auto_switch_target(&partial, 1, "ambient"), None);
    }

    #[test]
    fn ids_and_names_are_unique() {
        let items = ProfileSettings::default().items;
        assert_eq!(unique_name(&items, "developer"), "DEVELOPER 2");
        assert_eq!(unique_name(&items, "  desk "), "DESK");
        let id = new_id(&items, 255);
        assert_eq!(id, "user-ff");
        let mut more = items.clone();
        more.push(Profile { id: "user-ff".into(), ..builtin("custom") });
        assert_eq!(new_id(&more, 255), "user-100");
    }
}
