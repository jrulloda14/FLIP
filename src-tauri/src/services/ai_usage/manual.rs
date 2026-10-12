//! User-entered usage. Shown with a MANUAL source label and the time it was entered.

use chrono::{DateTime, Duration, Utc};

use super::{Confidence, FetchError, Reading, UsageProvider, UsageWindow};
use crate::services::settings::ManualUsage;

pub struct Manual {
    id: &'static str,
    name: &'static str,
    data: Option<ManualUsage>,
}

impl Manual {
    pub fn new(id: &'static str, name: &'static str, data: Option<ManualUsage>) -> Self {
        Self { id, name, data }
    }
}

impl UsageProvider for Manual {
    fn id(&self) -> &'static str {
        self.id
    }
    fn display_name(&self) -> &'static str {
        self.name
    }
    fn source_kind(&self) -> &'static str {
        "manual"
    }
    fn source_label(&self) -> String {
        "MANUAL ENTRY".into()
    }
    fn confidence(&self) -> Confidence {
        Confidence::UserProvided
    }
    fn stale_after(&self) -> Duration {
        Duration::hours(12)
    }
    fn fetch(&self, _now: DateTime<Utc>) -> Result<Reading, FetchError> {
        let Some(d) = &self.data else {
            return Err(FetchError::NotConfigured("NO MANUAL VALUES · CLICK TO ENTER".into()));
        };
        let windows: Vec<UsageWindow> =
            d.windows.iter().filter_map(|w| UsageWindow::from_percent(&w.key, w.used_percent, w.resets_at)).collect();
        if windows.is_empty() {
            return Err(FetchError::NotConfigured("NO MANUAL VALUES · CLICK TO ENTER".into()));
        }
        Ok(Reading { windows, observed_at: d.entered_at })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::settings::ManualWindow;

    #[test]
    fn manual_values_round_trip() {
        let at: DateTime<Utc> = "2026-10-12T08:00:00Z".parse().unwrap();
        let m = Manual::new(
            "claude",
            "CLAUDE",
            Some(ManualUsage { windows: vec![ManualWindow { key: "5H".into(), used_percent: 50.0, resets_at: None }], entered_at: at }),
        );
        let r = m.fetch(at).unwrap();
        assert_eq!(r.windows[0].used_fraction, Some(0.5));
        assert_eq!(r.observed_at, at);
        assert_eq!(m.confidence(), Confidence::UserProvided);
    }

    #[test]
    fn empty_manual_is_not_configured() {
        assert!(matches!(Manual::new("codex", "CODEX", None).fetch(Utc::now()), Err(FetchError::NotConfigured(_))));
    }
}
