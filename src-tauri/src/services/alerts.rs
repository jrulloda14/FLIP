//! Opt-in threshold notifications (high CPU, high memory, low disk space).
//!
//! FLIP only notifies; it never acts on the system. Unknown readings never trigger an alert,
//! CPU must stay high for a sustained period, and each alert type has a cooldown so the user is
//! not notified repeatedly.

use std::collections::HashMap;

use chrono::{DateTime, Duration, Utc};

use super::settings::AlertSettings;
use super::system_monitor::SystemSnapshot;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum AlertKind {
    Cpu,
    Memory,
    Disk,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Alert {
    pub kind: AlertKind,
    pub title: String,
    pub body: String,
}

#[derive(Debug, Default)]
pub struct AlertEngine {
    cpu_high_since: Option<DateTime<Utc>>,
    last_fired: HashMap<AlertKind, DateTime<Utc>>,
}

impl AlertEngine {
    pub fn new() -> Self {
        Self::default()
    }

    fn cooled_down(&self, kind: AlertKind, now: DateTime<Utc>, cfg: &AlertSettings) -> bool {
        self.last_fired.get(&kind).is_none_or(|t| now - *t >= Duration::minutes(i64::from(cfg.cooldown_minutes)))
    }

    fn fire(&mut self, out: &mut Vec<Alert>, now: DateTime<Utc>, cfg: &AlertSettings, kind: AlertKind, title: String, body: String) {
        if self.cooled_down(kind, now, cfg) {
            self.last_fired.insert(kind, now);
            out.push(Alert { kind, title, body });
        }
    }

    /// Checks one sample. Returns the alerts to show now (possibly none).
    pub fn evaluate(&mut self, now: DateTime<Utc>, snap: &SystemSnapshot, cfg: &AlertSettings) -> Vec<Alert> {
        let mut out = Vec::new();

        // CPU: sustained, not momentary.
        let cpu_high = cfg.cpu && snap.cpu.usage.is_some_and(|u| u * 100.0 >= cfg.cpu_percent as f32);
        if cpu_high {
            let since = *self.cpu_high_since.get_or_insert(now);
            if now - since >= Duration::minutes(i64::from(cfg.cpu_minutes)) {
                let pct = (snap.cpu.usage.unwrap_or(0.0) * 100.0).round();
                self.fire(
                    &mut out,
                    now,
                    cfg,
                    AlertKind::Cpu,
                    "High CPU usage".into(),
                    format!("CPU has been at or above {}% for {} min (now {pct}%).", cfg.cpu_percent, cfg.cpu_minutes),
                );
            }
        } else {
            self.cpu_high_since = None;
        }

        // Memory.
        if cfg.memory && snap.memory.total_bytes > 0 {
            let used = snap.memory.used_bytes as f64 / snap.memory.total_bytes as f64 * 100.0;
            if used >= f64::from(cfg.memory_percent) {
                self.fire(
                    &mut out,
                    now,
                    cfg,
                    AlertKind::Memory,
                    "High memory usage".into(),
                    format!("Memory is {used:.0}% used (alert at {}%).", cfg.memory_percent),
                );
            }
        }

        // Disk space.
        if cfg.disk {
            let low: Vec<String> = snap
                .disks
                .iter()
                .filter(|d| d.total_bytes > 0)
                .filter_map(|d| {
                    let free = (d.total_bytes - d.used_bytes.min(d.total_bytes)) as f64 / d.total_bytes as f64 * 100.0;
                    (free < f64::from(cfg.disk_free_percent)).then(|| format!("{} {free:.0}% free", d.mount))
                })
                .collect();
            if !low.is_empty() {
                self.fire(&mut out, now, cfg, AlertKind::Disk, "Low disk space".into(), low.join(", "));
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::system_monitor::{CpuInfo, DiskInfo, DiskIo, GpuInfo, MemoryInfo, NetworkInfo};

    const GB: u64 = 1024 * 1024 * 1024;

    fn snap(cpu: Option<f32>, mem_used: u64, disk_used: u64) -> SystemSnapshot {
        SystemSnapshot {
            sampled_at: Utc::now(),
            hostname: "TEST".into(),
            cpu: CpuInfo { name: String::new(), threads: 4, usage: cpu, per_core: vec![], temperature_c: None },
            memory: MemoryInfo { used_bytes: mem_used * GB, total_bytes: 16 * GB, available_bytes: (16 - mem_used) * GB },
            disks: vec![DiskInfo {
                mount: "C:".into(),
                used_bytes: disk_used * GB,
                total_bytes: 100 * GB,
                read_bytes_per_sec: None,
                write_bytes_per_sec: None,
            }],
            network: NetworkInfo { rx_bytes_per_sec: None, tx_bytes_per_sec: None },
            disk_io: DiskIo { read_bytes_per_sec: None, write_bytes_per_sec: None },
            gpu: GpuInfo {
                name: None,
                usage: None,
                temperature_c: None,
                memory_used_bytes: None,
                memory_total_bytes: None,
                memory_shared: false,
                source: None,
            },
            uptime_secs: 0,
            process_count: 0,
            cpu_history: vec![],
            rx_history: vec![],
            tx_history: vec![],
            disk_history: vec![],
            top_processes: vec![],
            limitations: vec![],
        }
    }
    fn t(min: i64) -> DateTime<Utc> {
        "2026-10-13T10:00:00Z".parse::<DateTime<Utc>>().unwrap() + Duration::minutes(min)
    }
    fn all_on() -> AlertSettings {
        AlertSettings { cpu: true, memory: true, disk: true, ..AlertSettings::default() }
    }

    #[test]
    fn nothing_fires_when_disabled() {
        let mut e = AlertEngine::new();
        assert!(e.evaluate(t(0), &snap(Some(1.0), 16, 100), &AlertSettings::default()).is_empty());
    }

    #[test]
    fn cpu_must_stay_high() {
        let mut e = AlertEngine::new();
        let cfg = all_on(); // 90% for 2 min
        assert!(e.evaluate(t(0), &snap(Some(0.95), 1, 1), &cfg).is_empty());
        assert!(e.evaluate(t(1), &snap(Some(0.95), 1, 1), &cfg).is_empty());
        let a = e.evaluate(t(2), &snap(Some(0.97), 1, 1), &cfg);
        assert_eq!(a.len(), 1);
        assert_eq!(a[0].kind, AlertKind::Cpu);
        // A dip resets the timer.
        let mut e2 = AlertEngine::new();
        e2.evaluate(t(0), &snap(Some(0.95), 1, 1), &cfg);
        e2.evaluate(t(1), &snap(Some(0.20), 1, 1), &cfg);
        assert!(e2.evaluate(t(2), &snap(Some(0.95), 1, 1), &cfg).is_empty());
    }

    #[test]
    fn unknown_cpu_never_fires_and_resets() {
        let mut e = AlertEngine::new();
        let cfg = all_on();
        e.evaluate(t(0), &snap(Some(0.99), 1, 1), &cfg);
        assert!(e.evaluate(t(1), &snap(None, 1, 1), &cfg).is_empty());
        assert!(e.evaluate(t(2), &snap(Some(0.99), 1, 1), &cfg).is_empty(), "timer restarted after the unknown sample");
    }

    #[test]
    fn memory_and_disk_with_cooldown() {
        let mut e = AlertEngine::new();
        let cfg = all_on(); // memory 90%, disk < 10% free, 30 min cooldown
        let s = snap(Some(0.1), 15, 95); // 94% memory, 5% free
        let first = e.evaluate(t(0), &s, &cfg);
        let kinds: Vec<_> = first.iter().map(|a| a.kind).collect();
        assert_eq!(kinds, [AlertKind::Memory, AlertKind::Disk]);
        assert!(first[1].body.contains("C: 5% free"));
        assert!(e.evaluate(t(10), &s, &cfg).is_empty(), "cooldown");
        assert_eq!(e.evaluate(t(30), &s, &cfg).len(), 2, "after cooldown");
        assert!(e.evaluate(t(31), &snap(Some(0.1), 4, 40), &cfg).is_empty(), "back to normal");
    }
}
