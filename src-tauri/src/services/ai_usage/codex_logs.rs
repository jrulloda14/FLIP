//! Codex (ChatGPT plan) usage from the Codex CLI's local session logs.
//!
//! The CLI appends `token_count` events to `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`, and
//! those events carry the plan's `rate_limits` (`primary` ≈ 5-hour, `secondary` ≈ weekly, each with
//! `used_percent`, `window_minutes` and a reset time). The format is not a documented API and can
//! change between CLI versions, so this adapter is opt-in, reports LOW confidence, and treats
//! anything it cannot parse as "no data" rather than guessing.
//!
//! Only local files are read; no network access and no credentials.

use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use chrono::{DateTime, Duration, Utc};
use serde_json::Value;

use super::claude_statusline::parse_reset;
use super::{Confidence, FetchError, Reading, UsageProvider, UsageWindow};

/// How much of the end of each log to scan.
const TAIL_BYTES: u64 = 2 * 1024 * 1024;
const MAX_FILES: usize = 8;
const MAX_ENTRIES_WALKED: usize = 20_000;

pub fn default_codex_home() -> Option<PathBuf> {
    if let Some(h) = std::env::var_os("CODEX_HOME").filter(|h| !h.is_empty()) {
        return Some(PathBuf::from(h));
    }
    std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")).map(|h| PathBuf::from(h).join(".codex"))
}

/// `300` → `5H`, `10080` → `7D`, `90` → `90M`.
pub fn window_key(minutes: u64) -> String {
    if minutes > 0 && minutes % 1440 == 0 {
        format!("{}D", minutes / 1440)
    } else if minutes > 0 && minutes % 60 == 0 {
        format!("{}H", minutes / 60)
    } else {
        format!("{minutes}M")
    }
}

fn parse_window(v: &Value, fallback_key: &str, observed: DateTime<Utc>) -> Option<UsageWindow> {
    let o = v.as_object()?;
    let used = o.get("used_percent").and_then(Value::as_f64)?;
    let key = o.get("window_minutes").and_then(Value::as_u64).map(window_key).unwrap_or_else(|| fallback_key.to_string());
    let resets_at = o
        .get("resets_at")
        .and_then(parse_reset)
        .or_else(|| o.get("resets_in_seconds").and_then(Value::as_i64).map(|s| observed + Duration::seconds(s.max(0))));
    UsageWindow::from_percent(&key, used, resets_at)
}

/// Parses one JSONL line. Returns a reading if it is an event carrying `rate_limits`.
pub fn parse_line(line: &str, file_time: DateTime<Utc>) -> Option<Reading> {
    if !line.contains("rate_limits") {
        return None;
    }
    let v: Value = serde_json::from_str(line).ok()?;
    let payload = v.get("payload").unwrap_or(&v);
    let rl = payload.get("rate_limits").or_else(|| payload.get("info").and_then(|i| i.get("rate_limits")))?;
    if rl.is_null() {
        return None;
    }
    let observed = v
        .get("timestamp")
        .and_then(Value::as_str)
        .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
        .map(|d| d.with_timezone(&Utc))
        .unwrap_or(file_time);
    let mut windows = vec![];
    for (name, fallback) in [("primary", "PRI"), ("secondary", "SEC")] {
        if let Some(w) = rl.get(name).and_then(|w| parse_window(w, fallback, observed)) {
            windows.push(w);
        }
    }
    if windows.is_empty() {
        return None;
    }
    Some(Reading { windows, observed_at: observed })
}

/// Scans a log's tail from the end and returns the newest rate-limit reading in it.
pub fn latest_in_file(path: &Path) -> std::io::Result<Option<Reading>> {
    let mut f = File::open(path)?;
    let meta = f.metadata()?;
    let file_time = meta.modified().ok().map(DateTime::<Utc>::from).unwrap_or_else(Utc::now);
    let start = meta.len().saturating_sub(TAIL_BYTES);
    f.seek(SeekFrom::Start(start))?;
    let mut buf = Vec::new();
    f.take(TAIL_BYTES).read_to_end(&mut buf)?;
    let text = String::from_utf8_lossy(&buf);
    let mut lines = text.lines().collect::<Vec<_>>();
    if start > 0 && !lines.is_empty() {
        lines.remove(0); // first line is probably cut in half
    }
    Ok(lines.iter().rev().find_map(|l| parse_line(l, file_time)))
}

/// Newest `.jsonl` files under `sessions/`, most recently modified first.
pub fn recent_session_files(sessions: &Path) -> Vec<PathBuf> {
    let mut found: Vec<(SystemTime, PathBuf)> = vec![];
    let mut stack = vec![(sessions.to_path_buf(), 0usize)];
    let mut walked = 0usize;
    while let Some((dir, depth)) = stack.pop() {
        let Ok(rd) = fs::read_dir(&dir) else { continue };
        for e in rd.flatten() {
            walked += 1;
            if walked > MAX_ENTRIES_WALKED {
                break;
            }
            let p = e.path();
            let Ok(ft) = e.file_type() else { continue };
            if ft.is_dir() && depth < 4 {
                stack.push((p, depth + 1));
            } else if ft.is_file() && p.extension().is_some_and(|x| x == "jsonl") {
                if let Ok(m) = e.metadata().and_then(|m| m.modified()) {
                    found.push((m, p));
                }
            }
        }
    }
    found.sort_by_key(|f| std::cmp::Reverse(f.0));
    found.into_iter().take(MAX_FILES).map(|(_, p)| p).collect()
}

pub struct CodexLogs {
    home: Option<PathBuf>,
}

impl CodexLogs {
    pub fn new(override_home: Option<&str>) -> Self {
        Self { home: override_home.map(PathBuf::from).or_else(default_codex_home) }
    }
}

impl UsageProvider for CodexLogs {
    fn id(&self) -> &'static str {
        "codex"
    }
    fn display_name(&self) -> &'static str {
        "CODEX"
    }
    fn source_kind(&self) -> &'static str {
        "codex-local-logs"
    }
    fn source_label(&self) -> String {
        "CODEX CLI LOCAL LOGS (UNOFFICIAL FORMAT)".into()
    }
    fn confidence(&self) -> Confidence {
        Confidence::Low
    }
    fn fetch(&self, _now: DateTime<Utc>) -> Result<Reading, FetchError> {
        let Some(home) = &self.home else {
            return Err(FetchError::NotConfigured("CODEX HOME NOT FOUND".into()));
        };
        let sessions = home.join("sessions");
        if !sessions.is_dir() {
            return Err(FetchError::NoData("NO CODEX SESSIONS FOUND".into()));
        }
        let mut last_err = None;
        for f in recent_session_files(&sessions) {
            match latest_in_file(&f) {
                Ok(Some(r)) => return Ok(r),
                Ok(None) => {}
                Err(e) => last_err = Some(e),
            }
        }
        match last_err {
            Some(e) => Err(FetchError::Failed { code: "READ".into(), message: e.to_string() }),
            None => Err(FetchError::NoData("NO RATE-LIMIT DATA IN RECENT CODEX SESSIONS".into())),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn t(s: &str) -> DateTime<Utc> {
        s.parse().unwrap()
    }

    const LINE_IN_SECONDS: &str = r#"{"timestamp":"2026-10-12T09:58:00.000Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":10}},"rate_limits":{"primary":{"used_percent":12.0,"window_minutes":300,"resets_in_seconds":3600},"secondary":{"used_percent":22.5,"window_minutes":10080,"resets_in_seconds":86400}}}}"#;
    const LINE_RESETS_AT: &str = r#"{"timestamp":"2026-10-12T09:59:00Z","type":"event_msg","payload":{"type":"token_count","rate_limits":{"primary":{"used_percent":40,"window_minutes":300,"resets_at":1791802800},"secondary":null}}}"#;

    #[test]
    fn window_keys() {
        assert_eq!(window_key(300), "5H");
        assert_eq!(window_key(10080), "7D");
        assert_eq!(window_key(1440), "1D");
        assert_eq!(window_key(90), "90M");
    }

    #[test]
    fn parses_resets_in_seconds() {
        let r = parse_line(LINE_IN_SECONDS, Utc::now()).unwrap();
        assert_eq!(r.observed_at, t("2026-10-12T09:58:00Z"));
        assert_eq!(r.windows.len(), 2);
        assert_eq!(r.windows[0].key, "5H");
        assert_eq!(r.windows[0].used_fraction, Some(0.12));
        assert_eq!(r.windows[0].resets_at, Some(t("2026-10-12T10:58:00Z")));
        assert_eq!(r.windows[1].key, "7D");
        assert_eq!(r.windows[1].used_fraction, Some(0.225));
    }

    #[test]
    fn parses_resets_at_and_null_secondary() {
        let r = parse_line(LINE_RESETS_AT, Utc::now()).unwrap();
        assert_eq!(r.windows.len(), 1);
        assert_eq!(r.windows[0].resets_at, DateTime::from_timestamp(1791802800, 0));
    }

    #[test]
    fn ignores_unrelated_and_malformed_lines() {
        let now = Utc::now();
        assert!(parse_line(r#"{"type":"response_item","payload":{}}"#, now).is_none());
        assert!(parse_line(r#"{"payload":{"rate_limits":null}}"#, now).is_none());
        assert!(parse_line(r#"{"payload":{"rate_limits":{"primary":{"window_minutes":300}}}}"#, now).is_none());
        assert!(parse_line("{rate_limits broken", now).is_none());
    }

    #[test]
    fn missing_window_minutes_uses_neutral_key() {
        let r = parse_line(r#"{"payload":{"rate_limits":{"primary":{"used_percent":5}}}}"#, t("2026-01-01T00:00:00Z")).unwrap();
        assert_eq!(r.windows[0].key, "PRI");
        assert_eq!(r.observed_at, t("2026-01-01T00:00:00Z"), "falls back to file time");
    }

    #[test]
    fn finds_newest_reading_across_files() {
        let dir = tempfile::tempdir().unwrap();
        let day = dir.path().join("sessions").join("2026").join("10").join("12");
        fs::create_dir_all(&day).unwrap();
        let mut old = File::create(day.join("rollout-old.jsonl")).unwrap();
        writeln!(old, "{LINE_IN_SECONDS}").unwrap();
        drop(old);
        std::thread::sleep(std::time::Duration::from_millis(30));
        let mut new = File::create(day.join("rollout-new.jsonl")).unwrap();
        writeln!(new, "{LINE_IN_SECONDS}").unwrap();
        writeln!(new, "{LINE_RESETS_AT}").unwrap();
        writeln!(new, r#"{{"type":"response_item","payload":{{"type":"message"}}}}"#).unwrap();
        drop(new);

        let p = CodexLogs::new(Some(dir.path().to_str().unwrap()));
        let r = p.fetch(Utc::now()).unwrap();
        assert_eq!(r.observed_at, t("2026-10-12T09:59:00Z"), "latest event in newest file");
        assert_eq!(r.windows[0].used_fraction, Some(0.40));
    }

    #[test]
    fn no_sessions_is_no_data() {
        let dir = tempfile::tempdir().unwrap();
        let p = CodexLogs::new(Some(dir.path().to_str().unwrap()));
        assert!(matches!(p.fetch(Utc::now()), Err(FetchError::NoData(_))));
        fs::create_dir_all(dir.path().join("sessions")).unwrap();
        fs::write(dir.path().join("sessions").join("a.jsonl"), "{}\n").unwrap();
        assert!(matches!(p.fetch(Utc::now()), Err(FetchError::NoData(_))));
    }
}
