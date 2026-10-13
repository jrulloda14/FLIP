//! Timer-completion notices: the FLIP-styled card shown when a focus session or break ends.
//!
//! The backend owns the notice so it is created exactly once per completion (the timer's
//! `tick` reports each completed phase once) and survives the card's window loading late.
//! Every notice has a unique id; actions and dismissals name the id they answer, so a stale
//! click can never act on a newer notice. Dismissing never touches the timer.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use super::pomodoro::{Completed, Phase, View};
use super::settings::NotificationSettings;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompletionNotice {
    pub id: u64,
    /// The phase that just ended (focus, shortBreak or longBreak).
    pub finished: Phase,
    /// The phase the timer moved to.
    pub next: Phase,
    /// Length of the next phase, in milliseconds.
    pub next_ms: i64,
    /// The next phase is already running (focus auto-start is on).
    pub next_running: bool,
    /// Session number of the next phase, and the session count.
    pub session: u32,
    pub sessions: u32,
    pub at: DateTime<Utc>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CompletionAction {
    /// Start the phase the timer moved to ("Start break" / "Resume focus").
    StartNext,
    /// Close the card. The timer is left exactly as it is.
    Dismiss,
}

#[derive(Debug, Default)]
pub struct Completions {
    last_id: u64,
    pending: Option<CompletionNotice>,
}

/// Whether the user wants a card for this completion (Settings › Focus › Notifications).
pub fn wanted(c: &Completed, n: &NotificationSettings) -> bool {
    match c.phase {
        Phase::Focus => n.focus_complete,
        Phase::ShortBreak | Phase::LongBreak => n.break_complete,
        Phase::Idle => false,
    }
}

impl Completions {
    /// Records a completion and returns its notice. A newer notice replaces an older one.
    pub fn push(&mut self, c: &Completed, after: &View, now: DateTime<Utc>) -> CompletionNotice {
        self.last_id += 1;
        let n = CompletionNotice {
            id: self.last_id,
            finished: c.phase,
            next: after.phase,
            next_ms: after.phase_total_ms,
            next_running: after.running,
            session: after.session,
            sessions: after.sessions,
            at: now,
        };
        self.pending = Some(n.clone());
        n
    }

    pub fn pending(&self) -> Option<&CompletionNotice> {
        self.pending.as_ref()
    }

    /// Takes the pending notice if it is the one named. Stale or repeated ids return `false`,
    /// so a double click or a late event acts at most once.
    pub fn resolve(&mut self, id: u64) -> bool {
        if self.pending.as_ref().is_some_and(|p| p.id == id) {
            self.pending = None;
            true
        } else {
            false
        }
    }

    /// Clears the pending notice (the user changed the timer some other way). Returns whether
    /// there was one.
    pub fn clear(&mut self) -> bool {
        self.pending.take().is_some()
    }
}

/// Optional completion sound: the Windows "Notification" system sound, so it follows the
/// user's sound scheme and volume. Off by default (Settings › Focus).
pub fn play_sound() {
    #[cfg(windows)]
    {
        use windows::core::w;
        use windows::Win32::Media::Audio::{PlaySoundW, SND_ALIAS, SND_ASYNC, SND_NODEFAULT};
        unsafe {
            let _ = PlaySoundW(w!("SystemNotification"), None, SND_ALIAS | SND_ASYNC | SND_NODEFAULT);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::pomodoro::DayStats;

    fn view(phase: Phase, running: bool) -> View {
        View {
            phase,
            running,
            session: 2,
            sessions: 4,
            remaining_ms: 300_000,
            phase_total_ms: 300_000,
            ends_at: None,
            today: DayStats::default(),
            total_focus_seconds: 0,
        }
    }
    fn done(phase: Phase, next: Phase) -> Completed {
        Completed { phase, next, session: 1 }
    }

    #[test]
    fn respects_the_notification_settings() {
        let on = NotificationSettings::default();
        let off = NotificationSettings { focus_complete: false, break_complete: false, ..on.clone() };
        assert!(wanted(&done(Phase::Focus, Phase::ShortBreak), &on));
        assert!(wanted(&done(Phase::LongBreak, Phase::Focus), &on));
        assert!(!wanted(&done(Phase::Focus, Phase::ShortBreak), &off));
        assert!(!wanted(&done(Phase::ShortBreak, Phase::Focus), &off));
        assert!(!wanted(&done(Phase::Idle, Phase::Focus), &on));
    }

    #[test]
    fn each_completion_gets_a_new_id_and_describes_the_next_phase() {
        let mut c = Completions::default();
        let a = c.push(&done(Phase::Focus, Phase::ShortBreak), &view(Phase::ShortBreak, false), Utc::now());
        assert_eq!((a.finished, a.next, a.next_ms, a.next_running), (Phase::Focus, Phase::ShortBreak, 300_000, false));
        let b = c.push(&done(Phase::ShortBreak, Phase::Focus), &view(Phase::Focus, true), Utc::now());
        assert!(b.id > a.id);
        assert_eq!(c.pending().map(|p| p.id), Some(b.id), "newer notice replaces the older one");
    }

    #[test]
    fn resolves_once_and_ignores_stale_ids() {
        let mut c = Completions::default();
        let a = c.push(&done(Phase::Focus, Phase::ShortBreak), &view(Phase::ShortBreak, false), Utc::now());
        let b = c.push(&done(Phase::ShortBreak, Phase::Focus), &view(Phase::Focus, false), Utc::now());
        assert!(!c.resolve(a.id), "stale card");
        assert!(c.resolve(b.id));
        assert!(!c.resolve(b.id), "repeated click acts once");
        assert!(c.pending().is_none());
        assert!(!c.clear());
    }
}
