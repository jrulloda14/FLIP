//! Pomodoro timer. Deadline-based: a running phase stores the wall-clock instant it ends, and
//! remaining time is always `deadline - now`. Nothing is decremented, so the timer cannot drift,
//! and a phase that ended while the machine slept completes on the first tick after resume.
//!
//! All functions take `now` explicitly so the state machine is testable without waiting.

use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

use chrono::{DateTime, Duration, NaiveDate, Utc};
use serde::{Deserialize, Serialize};

use super::settings::FocusSettings;
use crate::paths::atomic_write;

/// Days of history kept on disk.
const HISTORY_DAYS: i64 = 120;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum Phase {
    #[default]
    Idle,
    Focus,
    ShortBreak,
    LongBreak,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Command {
    Toggle,
    Start,
    Pause,
    Reset,
    Skip,
    AddFive,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DayStats {
    pub completed_sessions: u32,
    pub focus_seconds: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Timer {
    pub phase: Phase,
    pub session: u32,
    pub phase_total_ms: i64,
    /// Set while running.
    pub deadline: Option<DateTime<Utc>>,
    /// Set while paused (or idle/ready).
    pub remaining_ms: i64,
    /// Local calendar day → stats.
    pub history: BTreeMap<NaiveDate, DayStats>,
    pub total_focus_seconds: u64,
}

impl Default for Timer {
    fn default() -> Self {
        Self::new(&FocusSettings::default())
    }
}

/// Emitted when a phase runs out, so the caller can notify.
#[derive(Debug, Clone, PartialEq)]
pub struct Completed {
    pub phase: Phase,
    pub next: Phase,
    pub session: u32,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct View {
    pub phase: Phase,
    pub running: bool,
    pub session: u32,
    pub sessions: u32,
    pub remaining_ms: i64,
    pub phase_total_ms: i64,
    pub ends_at: Option<DateTime<Utc>>,
    pub today: DayStats,
    pub total_focus_seconds: u64,
}

fn phase_ms(phase: Phase, cfg: &FocusSettings) -> i64 {
    let min = match phase {
        Phase::Idle | Phase::Focus => cfg.focus_minutes,
        Phase::ShortBreak => cfg.short_minutes,
        Phase::LongBreak => cfg.long_minutes,
    };
    i64::from(min) * 60_000
}

impl Timer {
    pub fn new(cfg: &FocusSettings) -> Self {
        let ms = phase_ms(Phase::Focus, cfg);
        Self {
            phase: Phase::Idle,
            session: 1,
            phase_total_ms: ms,
            deadline: None,
            remaining_ms: ms,
            history: BTreeMap::new(),
            total_focus_seconds: 0,
        }
    }

    pub fn running(&self) -> bool {
        self.deadline.is_some()
    }

    pub fn remaining(&self, now: DateTime<Utc>) -> i64 {
        match self.deadline {
            Some(d) => (d - now).num_milliseconds().max(0),
            None => self.remaining_ms,
        }
    }

    fn start(&mut self, now: DateTime<Utc>, cfg: &FocusSettings) {
        if self.phase == Phase::Idle {
            self.phase = Phase::Focus;
            self.phase_total_ms = phase_ms(Phase::Focus, cfg);
            self.remaining_ms = self.phase_total_ms;
        }
        if self.deadline.is_none() {
            self.deadline = Some(now + Duration::milliseconds(self.remaining_ms));
        }
    }

    fn pause(&mut self, now: DateTime<Utc>) {
        if let Some(_d) = self.deadline {
            self.remaining_ms = self.remaining(now);
            self.deadline = None;
        }
    }

    /// Records focus time actually spent, whether the phase completed or was skipped.
    fn record_focus(&mut self, seconds: u64, completed: bool, day: NaiveDate) {
        let e = self.history.entry(day).or_default();
        e.focus_seconds += seconds;
        if completed {
            e.completed_sessions += 1;
        }
        self.total_focus_seconds += seconds;
        if let Some(cutoff) = day.checked_sub_signed(Duration::days(HISTORY_DAYS)) {
            self.history.retain(|d, _| *d > cutoff);
        }
    }

    fn next_phase(&self, cfg: &FocusSettings) -> (Phase, u32) {
        match self.phase {
            Phase::Idle | Phase::Focus => {
                if self.session >= cfg.sessions {
                    (Phase::LongBreak, self.session)
                } else {
                    (Phase::ShortBreak, self.session)
                }
            }
            Phase::ShortBreak => (Phase::Focus, self.session + 1),
            Phase::LongBreak => (Phase::Focus, 1),
        }
    }

    /// Moves to the next phase. `keep_running` starts it immediately from `now`.
    fn advance(&mut self, now: DateTime<Utc>, cfg: &FocusSettings, keep_running: bool) {
        let (phase, session) = self.next_phase(cfg);
        self.phase = phase;
        self.session = session.clamp(1, cfg.sessions.max(1));
        self.phase_total_ms = phase_ms(phase, cfg);
        self.remaining_ms = self.phase_total_ms;
        self.deadline = keep_running.then(|| now + Duration::milliseconds(self.phase_total_ms));
    }

    /// `today` is the user's local calendar date, used for the daily count.
    pub fn command(&mut self, cmd: Command, now: DateTime<Utc>, today: NaiveDate, cfg: &FocusSettings) {
        match cmd {
            Command::Start => self.start(now, cfg),
            Command::Pause => self.pause(now),
            Command::Toggle => {
                if self.running() {
                    self.pause(now)
                } else {
                    self.start(now, cfg)
                }
            }
            Command::Reset => {
                let history = std::mem::take(&mut self.history);
                let total = self.total_focus_seconds;
                *self = Timer::new(cfg);
                self.history = history;
                self.total_focus_seconds = total;
            }
            Command::Skip => {
                if self.phase == Phase::Focus {
                    let spent = (self.phase_total_ms - self.remaining(now)).max(0) / 1000;
                    self.record_focus(spent as u64, false, today);
                }
                let was_running = self.running();
                self.advance(now, cfg, was_running || cfg.auto_start);
            }
            Command::AddFive => {
                if self.phase == Phase::Idle {
                    return;
                }
                let add = 5 * 60_000;
                self.phase_total_ms += add;
                match self.deadline.as_mut() {
                    Some(d) => *d += Duration::milliseconds(add),
                    None => self.remaining_ms += add,
                }
            }
        }
    }

    /// Call once per second (and on resume). Completes at most one phase per call.
    pub fn tick(&mut self, now: DateTime<Utc>, today: NaiveDate, cfg: &FocusSettings) -> Option<Completed> {
        let deadline = self.deadline?;
        if now < deadline {
            return None;
        }
        let finished = self.phase;
        let session = self.session;
        if finished == Phase::Focus {
            self.record_focus((self.phase_total_ms / 1000) as u64, true, today);
        }
        // After a long sleep, the next phase starts from now rather than from the missed deadline.
        self.advance(now, cfg, cfg.auto_start);
        Some(Completed { phase: finished, next: self.phase, session })
    }

    /// Applies new durations. A ready (idle) timer picks up the new focus length; a phase in
    /// progress keeps its length; the session counter is clamped to the new session count.
    pub fn apply_settings(&mut self, cfg: &FocusSettings) {
        if self.phase == Phase::Idle {
            self.phase_total_ms = phase_ms(Phase::Focus, cfg);
            self.remaining_ms = self.phase_total_ms;
        }
        self.session = self.session.clamp(1, cfg.sessions.max(1));
    }

    pub fn view(&self, now: DateTime<Utc>, today: NaiveDate, cfg: &FocusSettings) -> View {
        View {
            phase: self.phase,
            running: self.running(),
            session: self.session,
            sessions: cfg.sessions,
            remaining_ms: self.remaining(now),
            phase_total_ms: self.phase_total_ms,
            ends_at: self.deadline,
            today: self.history.get(&today).cloned().unwrap_or_default(),
            total_focus_seconds: self.total_focus_seconds,
        }
    }
}

pub fn load(path: &Path, cfg: &FocusSettings) -> Timer {
    match fs::read_to_string(path).ok().and_then(|s| serde_json::from_str::<Timer>(&s).ok()) {
        Some(mut t) => {
            if t.phase_total_ms <= 0 || t.remaining_ms < 0 {
                let history = std::mem::take(&mut t.history);
                let total = t.total_focus_seconds;
                t = Timer::new(cfg);
                t.history = history;
                t.total_focus_seconds = total;
            }
            t.apply_settings(cfg);
            t
        }
        None => Timer::new(cfg),
    }
}

pub fn save(path: &Path, t: &Timer) -> std::io::Result<()> {
    let bytes = serde_json::to_vec(t).map_err(std::io::Error::other)?;
    atomic_write(path, &bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg() -> FocusSettings {
        FocusSettings { focus_minutes: 25, short_minutes: 5, long_minutes: 15, sessions: 4, auto_start: false }
    }
    fn t0() -> DateTime<Utc> {
        "2026-10-12T09:00:00Z".parse().unwrap()
    }
    fn day() -> NaiveDate {
        NaiveDate::from_ymd_opt(2026, 10, 12).unwrap()
    }
    fn secs(n: i64) -> Duration {
        Duration::seconds(n)
    }

    #[test]
    fn starts_idle_ready() {
        let t = Timer::new(&cfg());
        let v = t.view(t0(), day(), &cfg());
        assert_eq!(v.phase, Phase::Idle);
        assert!(!v.running);
        assert_eq!(v.remaining_ms, 25 * 60_000);
    }

    #[test]
    fn start_pause_resume_uses_deadline() {
        let c = cfg();
        let mut t = Timer::new(&c);
        t.command(Command::Toggle, t0(), day(), &c);
        assert_eq!(t.phase, Phase::Focus);
        assert_eq!(t.remaining(t0() + secs(60)), 24 * 60_000);
        t.command(Command::Pause, t0() + secs(60), day(), &c);
        // Paused time does not count.
        assert_eq!(t.remaining(t0() + secs(3600)), 24 * 60_000);
        t.command(Command::Start, t0() + secs(3600), day(), &c);
        assert_eq!(t.remaining(t0() + secs(3600 + 30)), 24 * 60_000 - 30_000);
    }

    #[test]
    fn no_drift_with_irregular_ticks() {
        let c = cfg();
        let mut t = Timer::new(&c);
        t.command(Command::Start, t0(), day(), &c);
        // Ticks arrive late and unevenly; remaining is still exact.
        for s in [1, 3, 4, 10, 11, 600, 601] {
            assert!(t.tick(t0() + Duration::milliseconds(s * 1000 + 370), day(), &c).is_none());
        }
        assert_eq!(t.remaining(t0() + secs(601)), (25 * 60 - 601) * 1000);
    }

    #[test]
    fn completes_focus_and_counts_session() {
        let c = cfg();
        let mut t = Timer::new(&c);
        t.command(Command::Start, t0(), day(), &c);
        let done = t.tick(t0() + secs(25 * 60), day(), &c).expect("completed");
        assert_eq!(done, Completed { phase: Phase::Focus, next: Phase::ShortBreak, session: 1 });
        assert_eq!(t.phase, Phase::ShortBreak);
        assert!(!t.running(), "auto-start is off");
        let v = t.view(t0(), day(), &c);
        assert_eq!(v.today.completed_sessions, 1);
        assert_eq!(v.today.focus_seconds, 25 * 60);
        assert_eq!(v.total_focus_seconds, 25 * 60);
    }

    #[test]
    fn full_cycle_with_auto_start() {
        let c = FocusSettings { auto_start: true, sessions: 2, ..cfg() };
        let mut t = Timer::new(&c);
        let mut now = t0();
        t.command(Command::Start, now, day(), &c);
        let mut seen = vec![];
        for _ in 0..5 {
            now = t.deadline.unwrap();
            let d = t.tick(now, day(), &c).unwrap();
            seen.push((d.phase, d.next, t.session));
            assert!(t.running());
        }
        assert_eq!(
            seen,
            vec![
                (Phase::Focus, Phase::ShortBreak, 1),
                (Phase::ShortBreak, Phase::Focus, 2),
                (Phase::Focus, Phase::LongBreak, 2),
                (Phase::LongBreak, Phase::Focus, 1),
                (Phase::Focus, Phase::ShortBreak, 1),
            ]
        );
        assert_eq!(t.history[&day()].completed_sessions, 3);
    }

    #[test]
    fn resume_after_sleep_completes_once_and_restarts_from_now() {
        let c = FocusSettings { auto_start: true, ..cfg() };
        let mut t = Timer::new(&c);
        t.command(Command::Start, t0(), day(), &c);
        // Machine slept for 3 hours.
        let wake = t0() + secs(3 * 3600);
        let d = t.tick(wake, day(), &c).unwrap();
        assert_eq!(d.phase, Phase::Focus);
        assert_eq!(t.phase, Phase::ShortBreak);
        assert_eq!(t.remaining(wake), 5 * 60_000, "break starts at wake, not at the missed deadline");
        assert!(t.tick(wake + secs(1), day(), &c).is_none());
    }

    #[test]
    fn skip_records_partial_focus_without_counting_session() {
        let c = cfg();
        let mut t = Timer::new(&c);
        t.command(Command::Start, t0(), day(), &c);
        t.command(Command::Skip, t0() + secs(600), day(), &c);
        assert_eq!(t.phase, Phase::ShortBreak);
        assert!(t.running(), "skip keeps a running timer running");
        let s = &t.history[&day()];
        assert_eq!((s.completed_sessions, s.focus_seconds), (0, 600));
    }

    #[test]
    fn reset_keeps_history() {
        let c = cfg();
        let mut t = Timer::new(&c);
        t.command(Command::Start, t0(), day(), &c);
        t.tick(t0() + secs(25 * 60), day(), &c);
        t.command(Command::Reset, t0() + secs(25 * 60 + 5), day(), &c);
        assert_eq!(t.phase, Phase::Idle);
        assert_eq!(t.session, 1);
        assert_eq!(t.history[&day()].completed_sessions, 1);
    }

    #[test]
    fn add_five_extends_running_and_paused() {
        let c = cfg();
        let mut t = Timer::new(&c);
        t.command(Command::AddFive, t0(), day(), &c);
        assert_eq!(t.remaining(t0()), 25 * 60_000, "no-op while idle");
        t.command(Command::Start, t0(), day(), &c);
        t.command(Command::AddFive, t0(), day(), &c);
        assert_eq!(t.remaining(t0()), 30 * 60_000);
        t.command(Command::Pause, t0(), day(), &c);
        t.command(Command::AddFive, t0(), day(), &c);
        assert_eq!(t.remaining(t0()), 35 * 60_000);
        assert_eq!(t.phase_total_ms, 35 * 60_000);
    }

    #[test]
    fn settings_change_updates_ready_timer_only() {
        let mut c = cfg();
        let mut t = Timer::new(&c);
        c.focus_minutes = 50;
        t.apply_settings(&c);
        assert_eq!(t.remaining(t0()), 50 * 60_000);
        t.command(Command::Start, t0(), day(), &c);
        c.focus_minutes = 10;
        t.apply_settings(&c);
        assert_eq!(t.remaining(t0()), 50 * 60_000, "phase in progress keeps its length");
    }

    #[test]
    fn persisted_running_timer_recovers_and_completes() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("pomodoro.json");
        let c = cfg();
        let mut t = Timer::new(&c);
        t.command(Command::Start, t0(), day(), &c);
        save(&p, &t).unwrap();
        // App restarted 30 minutes later.
        let mut r = load(&p, &c);
        assert!(r.running());
        assert!(r.tick(t0() + secs(30 * 60), day(), &c).is_some());
        assert_eq!(r.history[&day()].completed_sessions, 1);
    }

    #[test]
    fn corrupt_state_file_starts_fresh() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("pomodoro.json");
        fs::write(&p, "garbage").unwrap();
        let t = load(&p, &cfg());
        assert_eq!(t.phase, Phase::Idle);
    }

    #[test]
    fn history_is_pruned() {
        let c = cfg();
        let mut t = Timer::new(&c);
        let old = day() - Duration::days(200);
        t.record_focus(60, true, old);
        t.record_focus(60, true, day());
        assert!(!t.history.contains_key(&old));
        assert_eq!(t.total_focus_seconds, 120);
    }
}
