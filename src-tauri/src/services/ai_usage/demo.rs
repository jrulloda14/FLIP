//! Demo readings for layout work. Only constructed when `cfg!(debug_assertions)`; every snapshot
//! carries `is_demo = true` and the UI labels it DEMO.

use chrono::{DateTime, Duration, Utc};

use super::{Confidence, FetchError, Reading, UsageProvider, UsageWindow};

pub struct Demo {
    id: &'static str,
    name: &'static str,
    windows: &'static [(&'static str, f64, i64)],
}

impl Demo {
    pub fn claude() -> Self {
        Self { id: "claude", name: "CLAUDE", windows: &[("5H", 71.0, 135), ("7D", 24.0, 7 * 1440)] }
    }
    pub fn codex() -> Self {
        Self { id: "codex", name: "CODEX", windows: &[("7D", 100.0, 2 * 1440)] }
    }
}

impl UsageProvider for Demo {
    fn id(&self) -> &'static str {
        self.id
    }
    fn display_name(&self) -> &'static str {
        self.name
    }
    fn source_kind(&self) -> &'static str {
        "demo"
    }
    fn source_label(&self) -> String {
        "DEMO DATA · DEBUG BUILD ONLY".into()
    }
    fn confidence(&self) -> Confidence {
        Confidence::Demo
    }
    fn is_demo(&self) -> bool {
        true
    }
    fn fetch(&self, now: DateTime<Utc>) -> Result<Reading, FetchError> {
        let windows = self
            .windows
            .iter()
            .filter_map(|(k, used, reset_min)| UsageWindow::from_percent(k, *used, Some(now + Duration::minutes(*reset_min))))
            .collect();
        Ok(Reading { windows, observed_at: now })
    }
}
