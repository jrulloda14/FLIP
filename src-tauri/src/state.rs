//! Shared application state. Every lock is held only for short, non-blocking sections.

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, MutexGuard, RwLock, RwLockReadGuard, RwLockWriteGuard};

use chrono::{NaiveDate, Utc};
use tokio::sync::{watch, Notify};

use crate::paths::AppPaths;
use crate::services::ai_usage::{UsageCache, UsageSnapshot};
use crate::services::pomodoro::Timer;
use crate::services::settings::Settings;
use crate::services::system_monitor::SystemSnapshot;
use crate::services::world_clock::resolve_home;

pub struct AiState {
    pub cache: UsageCache,
    pub last: Vec<UsageSnapshot>,
}

pub struct AppState {
    pub paths: AppPaths,
    /// Demo AI data is only allowed in debug builds.
    pub allow_demo: bool,
    pub settings: RwLock<Settings>,
    pub settings_notice: Mutex<Option<String>>,
    pub pomodoro: Mutex<Timer>,
    pub system: Mutex<Option<SystemSnapshot>>,
    pub ai: Mutex<AiState>,
    /// Flipped to true once, on exit. Every background task watches it.
    pub shutdown: watch::Sender<bool>,
    /// Wakes the AI loop early (settings changed, manual refresh).
    pub ai_wake: Notify,
    /// Window placement changed and should be written to disk.
    pub placement_dirty: AtomicBool,
    pub quitting: AtomicBool,
    /// The chosen display is missing and FLIP is on the primary monitor.
    pub display_fallback: AtomicBool,
    /// Shown in the status bar (e.g. display fallback). Empty = none.
    pub display_notice: Mutex<Option<String>>,
    /// Last view requested for the panel window.
    pub panel_view: Mutex<String>,
    /// Per-action global shortcut registration status.
    pub shortcut_status: Mutex<BTreeMap<String, String>>,
    /// Top layer temporarily lowered for a fullscreen app.
    pub top_suppressed: AtomicBool,
    /// Windows solid desktop colour (`#rrggbb`), or None when a wallpaper image is set.
    pub desktop_color: Mutex<Option<String>>,
}

/// Recovers from a poisoned lock instead of propagating a panic from another thread.
pub fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

impl AppState {
    pub fn settings(&self) -> RwLockReadGuard<'_, Settings> {
        self.settings.read().unwrap_or_else(|e| e.into_inner())
    }
    pub fn settings_mut(&self) -> RwLockWriteGuard<'_, Settings> {
        self.settings.write().unwrap_or_else(|e| e.into_inner())
    }

    /// Today's date in the home time zone, used for the daily Pomodoro count.
    pub fn today(&self) -> NaiveDate {
        let tz = resolve_home(self.settings().clock.home_time_zone.as_deref());
        Utc::now().with_timezone(&tz).date_naive()
    }

    pub fn is_shutting_down(&self) -> bool {
        *self.shutdown.borrow()
    }

    pub fn begin_shutdown(&self) {
        self.quitting.store(true, Ordering::SeqCst);
        let _ = self.shutdown.send(true);
    }
}
