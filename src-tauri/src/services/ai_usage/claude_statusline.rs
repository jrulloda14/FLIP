//! Claude subscription usage from Claude Code's status line.
//!
//! Claude Code pipes a JSON document to the configured `statusLine` command on every update.
//! For Pro/Max subscribers it includes `rate_limits.five_hour` and `rate_limits.seven_day`,
//! each with `used_percentage` (0–100) and `resets_at`. FLIP registers itself as that command
//! (`flip.exe --claude-statusline`): the bridge keeps only the rate limits, writes them to
//! `claude-statusline.json` in FLIP's data directory, and prints a one-line status back to Claude Code.
//!
//! Nothing else from the status-line input (paths, session ids, model, cost) is stored.

use std::fs;
use std::io::Read;
use std::path::PathBuf;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::{Confidence, FetchError, Reading, UsageProvider, UsageWindow};
use crate::paths::{atomic_write, AppPaths};

/// Upper bound on stdin we are willing to read from Claude Code.
const MAX_INPUT: u64 = 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LimitRecord {
    pub used_percentage: f64,
    pub resets_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeRecord {
    pub captured_at: DateTime<Utc>,
    pub five_hour: Option<LimitRecord>,
    pub seven_day: Option<LimitRecord>,
}

/// `resets_at` has been seen both as Unix seconds and as an ISO-8601 string.
pub fn parse_reset(v: &Value) -> Option<DateTime<Utc>> {
    match v {
        Value::Number(n) => {
            let secs = n.as_f64()?;
            // Treat very large values as milliseconds.
            let secs = if secs > 1e11 { secs / 1000.0 } else { secs };
            DateTime::from_timestamp(secs as i64, 0)
        }
        Value::String(s) => {
            if let Ok(d) = DateTime::parse_from_rfc3339(s) {
                return Some(d.with_timezone(&Utc));
            }
            s.parse::<f64>().ok().and_then(|n| parse_reset(&Value::from(n)))
        }
        _ => None,
    }
}

fn parse_limit(v: Option<&Value>) -> Option<LimitRecord> {
    let o = v?.as_object()?;
    let used = o.get("used_percentage").or_else(|| o.get("usedPercentage")).and_then(Value::as_f64)?;
    if !used.is_finite() {
        return None;
    }
    let resets_at = o.get("resets_at").or_else(|| o.get("resetsAt")).and_then(parse_reset);
    Some(LimitRecord { used_percentage: used.clamp(0.0, 100.0), resets_at })
}

/// Extracts the rate limits from Claude Code's status-line JSON. `None` when the input has no
/// `rate_limits` (API-key users, or before the first response of a session).
pub fn parse_statusline_input(input: &str, now: DateTime<Utc>) -> Result<Option<BridgeRecord>, String> {
    let v: Value = serde_json::from_str(input).map_err(|e| format!("status-line input is not JSON: {e}"))?;
    let Some(rl) = v.get("rate_limits") else { return Ok(None) };
    let five_hour = parse_limit(rl.get("five_hour"));
    let seven_day = parse_limit(rl.get("seven_day"));
    if five_hour.is_none() && seven_day.is_none() {
        return Ok(None);
    }
    Ok(Some(BridgeRecord { captured_at: now, five_hour, seven_day }))
}

pub fn status_text(r: Option<&BridgeRecord>) -> String {
    let Some(r) = r else { return "FLIP · NO LIMIT DATA".into() };
    let mut parts = vec![];
    if let Some(f) = &r.five_hour {
        parts.push(format!("5H {:.0}%", f.used_percentage));
    }
    if let Some(s) = &r.seven_day {
        parts.push(format!("7D {:.0}%", s.used_percentage));
    }
    parts.join(" · ")
}

/// Entry point for `flip.exe --claude-statusline`. Never panics and always prints a line,
/// so a problem here cannot break Claude Code's prompt.
pub fn run_bridge() -> i32 {
    let mut input = String::new();
    if std::io::stdin().take(MAX_INPUT).read_to_string(&mut input).is_err() {
        println!("FLIP · STDIN ERROR");
        return 0;
    }
    let record = match parse_statusline_input(&input, Utc::now()) {
        Ok(r) => r,
        Err(_) => {
            println!("FLIP · BAD INPUT");
            return 0;
        }
    };
    if let (Some(r), Some(paths)) = (&record, AppPaths::from_env()) {
        if let Ok(bytes) = serde_json::to_vec(r) {
            // Keep the last good reading when the input has no limits, so it is not overwritten.
            let _ = atomic_write(&paths.claude_statusline(), &bytes);
        }
    }
    println!("{}", status_text(record.as_ref()));
    0
}

pub struct ClaudeStatusline {
    path: PathBuf,
}

impl ClaudeStatusline {
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }
}

impl UsageProvider for ClaudeStatusline {
    fn id(&self) -> &'static str {
        "claude"
    }
    fn display_name(&self) -> &'static str {
        "CLAUDE"
    }
    fn source_kind(&self) -> &'static str {
        "claude-statusline"
    }
    fn source_label(&self) -> String {
        "CLAUDE CODE STATUS LINE".into()
    }
    fn confidence(&self) -> Confidence {
        Confidence::High
    }
    fn fetch(&self, _now: DateTime<Utc>) -> Result<Reading, FetchError> {
        let raw = match fs::read_to_string(&self.path) {
            Ok(s) => s,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Err(FetchError::NoData("WAITING FOR CLAUDE CODE".into()));
            }
            Err(e) => return Err(FetchError::Failed { code: "READ".into(), message: e.to_string() }),
        };
        let r: BridgeRecord = serde_json::from_str(&raw)
            .map_err(|e| FetchError::Failed { code: "FORMAT".into(), message: format!("bridge file unreadable: {e}") })?;
        let windows: Vec<UsageWindow> = [("5H", &r.five_hour), ("7D", &r.seven_day)]
            .into_iter()
            .filter_map(|(k, l)| l.as_ref().and_then(|l| UsageWindow::from_percent(k, l.used_percentage, l.resets_at)))
            .collect();
        if windows.is_empty() {
            return Err(FetchError::NoData("NO LIMIT DATA IN STATUS LINE".into()));
        }
        Ok(Reading { windows, observed_at: r.captured_at })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn now() -> DateTime<Utc> {
        "2026-10-12T10:00:00Z".parse().unwrap()
    }

    #[test]
    fn parses_documented_shape_with_epoch_seconds() {
        let input = r#"{
            "session_id": "abc", "cwd": "C:\\secret\\project",
            "model": { "id": "claude-opus-5-5", "display_name": "Opus" },
            "rate_limits": {
                "five_hour": { "used_percentage": 23.5, "resets_at": 1791799200 },
                "seven_day": { "used_percentage": 41, "resets_at": 1792300000 }
            }
        }"#;
        let r = parse_statusline_input(input, now()).unwrap().unwrap();
        assert_eq!(r.five_hour.as_ref().unwrap().used_percentage, 23.5);
        assert_eq!(r.five_hour.as_ref().unwrap().resets_at, DateTime::from_timestamp(1791799200, 0));
        assert_eq!(r.seven_day.as_ref().unwrap().used_percentage, 41.0);
        // Nothing but limits is kept.
        let stored = serde_json::to_string(&r).unwrap();
        assert!(!stored.contains("secret") && !stored.contains("abc"));
        assert_eq!(status_text(Some(&r)), "5H 24% · 7D 41%");
    }

    #[test]
    fn accepts_iso_reset_times_and_partial_windows() {
        let input = r#"{ "rate_limits": { "seven_day": { "used_percentage": 12, "resets_at": "2026-10-15T08:00:00Z" } } }"#;
        let r = parse_statusline_input(input, now()).unwrap().unwrap();
        assert!(r.five_hour.is_none());
        assert_eq!(r.seven_day.unwrap().resets_at, Some("2026-10-15T08:00:00Z".parse().unwrap()));
    }

    #[test]
    fn missing_rate_limits_is_none_not_zero() {
        assert_eq!(parse_statusline_input(r#"{ "model": {} }"#, now()).unwrap(), None);
        assert_eq!(parse_statusline_input(r#"{ "rate_limits": {} }"#, now()).unwrap(), None);
        assert_eq!(parse_statusline_input(r#"{ "rate_limits": { "five_hour": { "used_percentage": "x" } } }"#, now()).unwrap(), None);
        assert_eq!(status_text(None), "FLIP · NO LIMIT DATA");
    }

    #[test]
    fn rejects_non_json() {
        assert!(parse_statusline_input("hello", now()).is_err());
    }

    #[test]
    fn clamps_out_of_range_percentages() {
        let input = r#"{ "rate_limits": { "five_hour": { "used_percentage": 140 } } }"#;
        let r = parse_statusline_input(input, now()).unwrap().unwrap();
        assert_eq!(r.five_hour.unwrap().used_percentage, 100.0);
    }

    #[test]
    fn reset_parsing_variants() {
        assert_eq!(parse_reset(&Value::from(1_791_799_200_000_i64)), DateTime::from_timestamp(1_791_799_200, 0));
        assert_eq!(parse_reset(&Value::from("1791799200")), DateTime::from_timestamp(1_791_799_200, 0));
        assert_eq!(parse_reset(&Value::Null), None);
        assert_eq!(parse_reset(&Value::from("soon")), None);
    }

    #[test]
    fn provider_reads_bridge_file() {
        let dir = tempfile::tempdir().unwrap();
        let p = ClaudeStatusline::new(dir.path().join("claude-statusline.json"));
        assert!(matches!(p.fetch(now()), Err(FetchError::NoData(_))));
        let rec = BridgeRecord {
            captured_at: now(),
            five_hour: Some(LimitRecord { used_percentage: 71.0, resets_at: None }),
            seven_day: Some(LimitRecord { used_percentage: 24.0, resets_at: None }),
        };
        fs::write(dir.path().join("claude-statusline.json"), serde_json::to_vec(&rec).unwrap()).unwrap();
        let r = p.fetch(now()).unwrap();
        assert_eq!(r.windows.iter().map(|w| w.key.as_str()).collect::<Vec<_>>(), ["5H", "7D"]);
        assert_eq!(r.windows[0].used_fraction, Some(0.71));
        assert_eq!(r.observed_at, now());
    }

    #[test]
    fn provider_reports_corrupt_bridge_file_as_error() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("claude-statusline.json");
        fs::write(&path, "{").unwrap();
        assert!(matches!(ClaudeStatusline::new(path).fetch(now()), Err(FetchError::Failed { .. })));
    }
}
