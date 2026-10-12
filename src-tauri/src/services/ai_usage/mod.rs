//! AI subscription usage behind one provider interface.
//!
//! Data sources (see README › AI usage for prerequisites and limitations):
//! * `claude_statusline` — Claude Code's documented status-line input, captured by
//!   `flip.exe --claude-statusline`. Subscriber 5-hour / 7-day percentages. High confidence,
//!   but only as fresh as the last Claude Code turn.
//! * `codex_logs` — rate-limit snapshots that the Codex CLI writes into its local session
//!   logs. The log format is undocumented, so this source is opt-in and marked low confidence.
//! * `manual` — values the user typed in, labeled as such.
//! * `demo` — debug builds only, always labeled DEMO.
//!
//! No adapter calls a network endpoint, and none needs a credential.

pub mod claude_statusline;
pub mod codex_logs;
pub mod demo;
pub mod manual;

use std::collections::HashMap;
use std::fs;
use std::path::Path;

use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};

use super::settings::{AiSettings, ClaudeSource, CodexSource};
use crate::paths::{atomic_write, AppPaths};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Status {
    Ok,
    Stale,
    Loading,
    Unavailable,
    Error,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Confidence {
    High,
    Medium,
    Low,
    UserProvided,
    Demo,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageWindow {
    pub key: String,
    pub label: String,
    pub used_fraction: Option<f64>,
    pub remaining_fraction: Option<f64>,
    pub resets_at: Option<DateTime<Utc>>,
    #[serde(default)]
    pub expired: bool,
}

impl UsageWindow {
    pub fn from_percent(key: &str, used_percent: f64, resets_at: Option<DateTime<Utc>>) -> Option<Self> {
        if !used_percent.is_finite() {
            return None;
        }
        let used = (used_percent / 100.0).clamp(0.0, 1.0);
        Some(Self {
            key: key.to_string(),
            label: window_label(key),
            used_fraction: Some(used),
            remaining_fraction: Some(1.0 - used),
            resets_at,
            expired: false,
        })
    }
}

pub fn window_label(key: &str) -> String {
    match key {
        "5H" => "5-HOUR WINDOW".into(),
        "7D" => "7-DAY WINDOW".into(),
        k => format!("{k} WINDOW"),
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderError {
    pub code: String,
    pub message: String,
    pub retry_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageSnapshot {
    pub provider_id: String,
    pub display_name: String,
    pub status: Status,
    pub windows: Vec<UsageWindow>,
    pub last_success_at: Option<DateTime<Utc>>,
    pub fetched_at: DateTime<Utc>,
    pub source_kind: String,
    pub source_label: String,
    pub confidence: Confidence,
    pub error: Option<ProviderError>,
    pub note: Option<String>,
    pub is_demo: bool,
}

/// A successful read. `observed_at` is when the provider produced the data, not when FLIP read it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Reading {
    pub windows: Vec<UsageWindow>,
    pub observed_at: DateTime<Utc>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum FetchError {
    /// Source switched off or not set up. Shown as unavailable, never as an error.
    NotConfigured(String),
    /// Source is set up but has nothing yet (e.g. Claude Code has not run). Unavailable.
    NoData(String),
    /// Something broke (unreadable file, unexpected format). Shown as an error, with backoff.
    Failed { code: String, message: String },
}

pub trait UsageProvider: Send + Sync {
    fn id(&self) -> &'static str;
    fn display_name(&self) -> &'static str;
    fn source_kind(&self) -> &'static str;
    fn source_label(&self) -> String;
    fn confidence(&self) -> Confidence;
    fn is_demo(&self) -> bool {
        false
    }
    /// Readings older than this are shown with a STALE marker.
    fn stale_after(&self) -> Duration {
        Duration::minutes(15)
    }
    fn fetch(&self, now: DateTime<Utc>) -> Result<Reading, FetchError>;
}

/// A provider that is switched off. It reports why, so the board can say NOT CONNECTED.
pub struct Disabled {
    pub id: &'static str,
    pub name: &'static str,
}

impl UsageProvider for Disabled {
    fn id(&self) -> &'static str {
        self.id
    }
    fn display_name(&self) -> &'static str {
        self.name
    }
    fn source_kind(&self) -> &'static str {
        "none"
    }
    fn source_label(&self) -> String {
        "NOT CONFIGURED".into()
    }
    fn confidence(&self) -> Confidence {
        Confidence::Low
    }
    fn fetch(&self, _now: DateTime<Utc>) -> Result<Reading, FetchError> {
        Err(FetchError::NotConfigured("NOT CONNECTED · SETTINGS › AI".into()))
    }
}

/// Builds the provider list from settings. Order is fixed: Claude, then Codex.
pub fn providers_for(s: &AiSettings, paths: &AppPaths, allow_demo: bool) -> Vec<Box<dyn UsageProvider>> {
    if s.demo && allow_demo {
        return vec![Box::new(demo::Demo::claude()), Box::new(demo::Demo::codex())];
    }
    let claude: Box<dyn UsageProvider> = match s.claude.source {
        ClaudeSource::Off => Box::new(Disabled { id: "claude", name: "CLAUDE" }),
        ClaudeSource::Statusline => Box::new(claude_statusline::ClaudeStatusline::new(paths.claude_statusline())),
        ClaudeSource::Manual => Box::new(manual::Manual::new("claude", "CLAUDE", s.manual.get("claude").cloned())),
    };
    let codex: Box<dyn UsageProvider> = match s.codex.source {
        CodexSource::Off => Box::new(Disabled { id: "codex", name: "CODEX" }),
        CodexSource::LocalLogs => Box::new(codex_logs::CodexLogs::new(s.codex.codex_home.as_deref())),
        CodexSource::Manual => Box::new(manual::Manual::new("codex", "CODEX", s.manual.get("codex").cloned())),
    };
    vec![claude, codex]
}

const BACKOFF_SECS: [i64; 4] = [30, 120, 300, 900];

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheEntry {
    pub reading: Option<Reading>,
    pub last_success_at: Option<DateTime<Utc>>,
    #[serde(skip)]
    pub failures: u32,
    #[serde(skip)]
    pub retry_at: Option<DateTime<Utc>>,
    #[serde(skip)]
    pub last_error: Option<ProviderError>,
}

/// Keeps the last good reading per (provider, source) so a failed refresh shows stale data, not nothing.
#[derive(Debug, Default)]
pub struct UsageCache {
    entries: HashMap<String, CacheEntry>,
}

fn cache_key(p: &dyn UsageProvider) -> String {
    format!("{}:{}", p.id(), p.source_kind())
}

/// Marks windows whose reset time has passed: the old percentage no longer applies.
pub fn mark_expired(windows: &mut [UsageWindow], now: DateTime<Utc>) {
    for w in windows {
        w.expired = w.resets_at.is_some_and(|r| r <= now);
    }
}

impl UsageCache {
    pub fn load(path: &Path) -> Self {
        let entries = fs::read_to_string(path).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
        Self { entries }
    }

    pub fn save(&self, path: &Path) {
        // Only successful readings are persisted. Manual and demo values already live elsewhere.
        let keep: HashMap<_, _> =
            self.entries.iter().filter(|(k, e)| e.reading.is_some() && !k.ends_with(":demo") && !k.ends_with(":manual")).collect();
        if let Ok(bytes) = serde_json::to_vec(&keep) {
            if let Err(e) = atomic_write(path, &bytes) {
                log::warn!("ai cache not saved: {e}");
            }
        }
    }

    /// Fetches one provider (unless it is backing off and `force` is false) and builds its snapshot.
    pub fn refresh(&mut self, p: &dyn UsageProvider, now: DateTime<Utc>, force: bool) -> UsageSnapshot {
        let key = cache_key(p);
        let entry = self.entries.entry(key).or_default();
        let base = UsageSnapshot {
            provider_id: p.id().into(),
            display_name: p.display_name().into(),
            status: Status::Unavailable,
            windows: vec![],
            last_success_at: entry.last_success_at,
            fetched_at: now,
            source_kind: p.source_kind().into(),
            source_label: p.source_label(),
            confidence: p.confidence(),
            error: None,
            note: None,
            is_demo: p.is_demo(),
        };

        let backing_off = !force && entry.retry_at.is_some_and(|r| now < r);
        let result = if backing_off {
            Err(FetchError::Failed {
                code: entry.last_error.as_ref().map(|e| e.code.clone()).unwrap_or_else(|| "RETRYING".into()),
                message: entry.last_error.as_ref().map(|e| e.message.clone()).unwrap_or_default(),
            })
        } else {
            p.fetch(now)
        };

        match result {
            Ok(mut r) => {
                mark_expired(&mut r.windows, now);
                entry.failures = 0;
                entry.retry_at = None;
                entry.last_error = None;
                entry.last_success_at = Some(now);
                entry.reading = Some(r.clone());
                let stale = now - r.observed_at > p.stale_after();
                UsageSnapshot {
                    status: if stale { Status::Stale } else { Status::Ok },
                    windows: r.windows,
                    last_success_at: Some(r.observed_at),
                    note: stale.then(|| "NO NEW DATA FROM THE SOURCE RECENTLY".into()),
                    ..base
                }
            }
            Err(FetchError::NotConfigured(note)) => UsageSnapshot { status: Status::Unavailable, note: Some(note), ..base },
            Err(FetchError::NoData(note)) => match &entry.reading {
                Some(r) => {
                    let mut w = r.windows.clone();
                    mark_expired(&mut w, now);
                    UsageSnapshot { status: Status::Stale, windows: w, last_success_at: Some(r.observed_at), note: Some(note), ..base }
                }
                None => UsageSnapshot { status: Status::Unavailable, note: Some(note), ..base },
            },
            Err(FetchError::Failed { code, message }) => {
                if !backing_off {
                    entry.failures += 1;
                    let delay = BACKOFF_SECS[(entry.failures as usize - 1).min(BACKOFF_SECS.len() - 1)];
                    entry.retry_at = Some(now + Duration::seconds(delay));
                    entry.last_error = Some(ProviderError { code: code.clone(), message: message.clone(), retry_at: entry.retry_at });
                }
                let error = Some(ProviderError { code, message, retry_at: entry.retry_at });
                match &entry.reading {
                    Some(r) => {
                        let mut w = r.windows.clone();
                        mark_expired(&mut w, now);
                        UsageSnapshot { status: Status::Stale, windows: w, last_success_at: Some(r.observed_at), error, ..base }
                    }
                    None => UsageSnapshot { status: Status::Error, error, ..base },
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    struct Fake {
        result: Mutex<Result<Reading, FetchError>>,
    }
    impl Fake {
        fn new(r: Result<Reading, FetchError>) -> Self {
            Self { result: Mutex::new(r) }
        }
        fn set(&self, r: Result<Reading, FetchError>) {
            *self.result.lock().unwrap() = r;
        }
    }
    impl UsageProvider for Fake {
        fn id(&self) -> &'static str {
            "fake"
        }
        fn display_name(&self) -> &'static str {
            "FAKE"
        }
        fn source_kind(&self) -> &'static str {
            "test"
        }
        fn source_label(&self) -> String {
            "TEST".into()
        }
        fn confidence(&self) -> Confidence {
            Confidence::High
        }
        fn fetch(&self, _now: DateTime<Utc>) -> Result<Reading, FetchError> {
            self.result.lock().unwrap().clone()
        }
    }

    fn now() -> DateTime<Utc> {
        "2026-10-12T10:00:00Z".parse().unwrap()
    }
    fn reading(observed: DateTime<Utc>, resets: DateTime<Utc>) -> Reading {
        Reading { windows: vec![UsageWindow::from_percent("5H", 42.0, Some(resets)).unwrap()], observed_at: observed }
    }

    #[test]
    fn fresh_reading_is_ok() {
        let mut c = UsageCache::default();
        let p = Fake::new(Ok(reading(now(), now() + Duration::hours(2))));
        let s = c.refresh(&p, now(), false);
        assert_eq!(s.status, Status::Ok);
        assert_eq!(s.windows[0].used_fraction, Some(0.42));
        assert!(!s.windows[0].expired);
    }

    #[test]
    fn old_reading_is_stale() {
        let mut c = UsageCache::default();
        let p = Fake::new(Ok(reading(now() - Duration::hours(1), now() + Duration::hours(2))));
        assert_eq!(c.refresh(&p, now(), false).status, Status::Stale);
    }

    #[test]
    fn passed_reset_marks_window_expired() {
        let mut c = UsageCache::default();
        let p = Fake::new(Ok(reading(now() - Duration::minutes(1), now() - Duration::seconds(1))));
        let s = c.refresh(&p, now(), false);
        assert!(s.windows[0].expired);
    }

    #[test]
    fn not_configured_is_unavailable_not_error() {
        let mut c = UsageCache::default();
        let s = c.refresh(&Disabled { id: "claude", name: "CLAUDE" }, now(), false);
        assert_eq!(s.status, Status::Unavailable);
        assert!(s.windows.is_empty());
        assert!(s.error.is_none());
    }

    #[test]
    fn failure_without_cache_is_error_with_backoff() {
        let mut c = UsageCache::default();
        let p = Fake::new(Err(FetchError::Failed { code: "PARSE".into(), message: "bad".into() }));
        let s = c.refresh(&p, now(), false);
        assert_eq!(s.status, Status::Error);
        let e = s.error.unwrap();
        assert_eq!(e.code, "PARSE");
        assert_eq!(e.retry_at, Some(now() + Duration::seconds(30)));
        // A second failure inside the backoff window does not advance the backoff.
        let s2 = c.refresh(&p, now() + Duration::seconds(10), false);
        assert_eq!(s2.error.unwrap().retry_at, Some(now() + Duration::seconds(30)));
        // After the window, the next failure backs off further.
        let s3 = c.refresh(&p, now() + Duration::seconds(31), false);
        assert_eq!(s3.error.unwrap().retry_at, Some(now() + Duration::seconds(31 + 120)));
    }

    #[test]
    fn failure_with_cache_shows_stale_values() {
        let mut c = UsageCache::default();
        let p = Fake::new(Ok(reading(now(), now() + Duration::hours(3))));
        c.refresh(&p, now(), false);
        p.set(Err(FetchError::Failed { code: "IO".into(), message: "locked".into() }));
        let s = c.refresh(&p, now() + Duration::minutes(2), false);
        assert_eq!(s.status, Status::Stale);
        assert_eq!(s.windows[0].used_fraction, Some(0.42));
        assert!(s.error.is_some());
        assert_eq!(s.last_success_at, Some(now()));
    }

    #[test]
    fn success_clears_backoff() {
        let mut c = UsageCache::default();
        let p = Fake::new(Err(FetchError::Failed { code: "IO".into(), message: "x".into() }));
        c.refresh(&p, now(), false);
        p.set(Ok(reading(now(), now() + Duration::hours(1))));
        // Still backing off unless forced.
        assert_eq!(c.refresh(&p, now() + Duration::seconds(5), false).status, Status::Error);
        assert_eq!(c.refresh(&p, now() + Duration::seconds(5), true).status, Status::Ok);
    }

    #[test]
    fn no_data_with_cache_is_stale_without_error() {
        let mut c = UsageCache::default();
        let p = Fake::new(Ok(reading(now(), now() + Duration::hours(3))));
        c.refresh(&p, now(), false);
        p.set(Err(FetchError::NoData("NO RECENT SESSION".into())));
        let s = c.refresh(&p, now() + Duration::minutes(1), false);
        assert_eq!(s.status, Status::Stale);
        assert!(s.error.is_none());
    }

    #[test]
    fn default_settings_show_two_unavailable_rows() {
        let dir = tempfile::tempdir().unwrap();
        let paths = AppPaths::new(dir.path().to_path_buf());
        let ps = providers_for(&AiSettings::default(), &paths, true);
        let mut c = UsageCache::default();
        let snaps: Vec<_> = ps.iter().map(|p| c.refresh(p.as_ref(), now(), false)).collect();
        assert_eq!(snaps.iter().map(|s| s.provider_id.as_str()).collect::<Vec<_>>(), ["claude", "codex"]);
        assert!(snaps.iter().all(|s| s.status == Status::Unavailable && s.windows.is_empty() && !s.is_demo));
    }

    #[test]
    fn demo_requires_permission() {
        let dir = tempfile::tempdir().unwrap();
        let paths = AppPaths::new(dir.path().to_path_buf());
        let s = AiSettings { demo: true, ..Default::default() };
        assert!(providers_for(&s, &paths, true).iter().all(|p| p.is_demo()));
        assert!(providers_for(&s, &paths, false).iter().all(|p| !p.is_demo()));
    }

    #[test]
    fn cache_round_trip_skips_manual_and_demo() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("ai-cache.json");
        let mut c = UsageCache::default();
        let p = Fake::new(Ok(reading(now(), now() + Duration::hours(1))));
        c.refresh(&p, now(), false);
        c.refresh(&demo::Demo::claude(), now(), false);
        c.save(&path);
        let loaded = UsageCache::load(&path);
        assert!(loaded.entries.contains_key("fake:test"));
        assert!(!loaded.entries.keys().any(|k| k.ends_with(":demo")));
    }
}
