//! System metrics through `sysinfo` (CPU, memory, disks, network, processes) plus the
//! Windows-specific GPU module. Values that cannot be measured are `None` and listed in
//! `limitations`; nothing is estimated or filled with zeros.

use std::collections::VecDeque;
use std::time::Instant;

use chrono::{DateTime, Utc};
use serde::Serialize;
use sysinfo::{CpuRefreshKind, Disks, MemoryRefreshKind, Networks, ProcessRefreshKind, ProcessesToUpdate, RefreshKind, System};

use super::gpu::GpuMonitor;

pub const HISTORY_LEN: usize = 60;
/// Process lists are comparatively expensive, so they refresh at most this often.
const PROCESS_REFRESH_SECS: u64 = 5;
const DISK_REFRESH_SECS: u64 = 30;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CpuInfo {
    pub name: String,
    pub threads: usize,
    pub usage: Option<f32>,
    pub per_core: Vec<f32>,
    pub temperature_c: Option<f32>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MemoryInfo {
    pub used_bytes: u64,
    pub total_bytes: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DiskInfo {
    pub mount: String,
    pub used_bytes: u64,
    pub total_bytes: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NetworkInfo {
    pub rx_bytes_per_sec: Option<f64>,
    pub tx_bytes_per_sec: Option<f64>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GpuInfo {
    pub name: Option<String>,
    pub usage: Option<f32>,
    pub temperature_c: Option<f32>,
    pub source: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProcessInfo {
    pub name: String,
    pub cpu: f32,
    pub memory_bytes: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Limitation {
    pub metric: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SystemSnapshot {
    pub sampled_at: DateTime<Utc>,
    pub hostname: String,
    pub cpu: CpuInfo,
    pub memory: MemoryInfo,
    pub disks: Vec<DiskInfo>,
    pub network: NetworkInfo,
    pub gpu: GpuInfo,
    pub uptime_secs: u64,
    pub process_count: usize,
    pub cpu_history: Vec<f32>,
    pub rx_history: Vec<f64>,
    pub tx_history: Vec<f64>,
    pub top_processes: Vec<ProcessInfo>,
    pub limitations: Vec<Limitation>,
}

// ------------------------------------------------------------------ normalization (pure, tested)

/// sysinfo reports percentages (0..100). NaN or negative readings become None.
pub fn normalize_percent(p: f32) -> Option<f32> {
    if !p.is_finite() || p < 0.0 {
        return None;
    }
    Some((p / 100.0).clamp(0.0, 1.0))
}

/// Bytes per second from a byte delta. None when elapsed is too small to be meaningful.
pub fn rate(delta_bytes: u64, elapsed_secs: f64) -> Option<f64> {
    if !elapsed_secs.is_finite() || elapsed_secs < 0.05 {
        return None;
    }
    Some(delta_bytes as f64 / elapsed_secs)
}

/// Per-process CPU from sysinfo is relative to one core (0..100 × cores); scale to the whole machine.
pub fn process_cpu_share(raw_percent: f32, threads: usize) -> f32 {
    if !raw_percent.is_finite() || threads == 0 {
        return 0.0;
    }
    (raw_percent / 100.0 / threads as f32).clamp(0.0, 1.0)
}

/// `C:\` → `C:`; anything else is returned trimmed.
pub fn mount_label(mount: &str) -> String {
    let m = mount.trim_end_matches(['\\', '/']);
    if m.is_empty() {
        "/".into()
    } else {
        m.to_uppercase()
    }
}

pub fn push_history<T>(h: &mut VecDeque<T>, v: T) {
    if h.len() == HISTORY_LEN {
        h.pop_front();
    }
    h.push_back(v);
}

fn padded<T: Copy + Default>(h: &VecDeque<T>) -> Vec<T> {
    let mut v = vec![T::default(); HISTORY_LEN - h.len()];
    v.extend(h.iter().copied());
    v
}

// ------------------------------------------------------------------ monitor

pub struct SystemMonitor {
    sys: System,
    networks: Networks,
    disks: Disks,
    gpu: GpuMonitor,
    last_sample: Option<Instant>,
    last_processes: Option<Instant>,
    last_disks: Instant,
    cpu_history: VecDeque<f32>,
    rx_history: VecDeque<f64>,
    tx_history: VecDeque<f64>,
    top: Vec<ProcessInfo>,
    hostname: String,
}

impl SystemMonitor {
    pub fn new() -> Self {
        let mut sys = System::new_with_specifics(
            RefreshKind::nothing()
                .with_cpu(CpuRefreshKind::nothing().with_cpu_usage())
                .with_memory(MemoryRefreshKind::nothing().with_ram()),
        );
        sys.refresh_cpu_usage();
        Self {
            sys,
            networks: Networks::new_with_refreshed_list(),
            disks: Disks::new_with_refreshed_list(),
            gpu: GpuMonitor::new(),
            last_sample: None,
            last_processes: None,
            last_disks: Instant::now(),
            cpu_history: VecDeque::with_capacity(HISTORY_LEN),
            rx_history: VecDeque::with_capacity(HISTORY_LEN),
            tx_history: VecDeque::with_capacity(HISTORY_LEN),
            top: Vec::new(),
            hostname: System::host_name().unwrap_or_else(|| "THIS PC".into()).to_uppercase(),
        }
    }

    pub fn sample(&mut self, want_gpu: bool, want_temps: bool) -> SystemSnapshot {
        let now = Instant::now();
        let elapsed = self.last_sample.map(|t| now.duration_since(t).as_secs_f64());
        self.last_sample = Some(now);
        let mut limitations = Vec::new();

        // CPU: usage needs two refreshes; the first sample reports None rather than a fake 0%.
        self.sys.refresh_cpu_usage();
        let threads = self.sys.cpus().len();
        let usage = if elapsed.is_some() { normalize_percent(self.sys.global_cpu_usage()) } else { None };
        let per_core: Vec<f32> = if elapsed.is_some() {
            self.sys.cpus().iter().map(|c| normalize_percent(c.cpu_usage()).unwrap_or(0.0)).collect()
        } else {
            Vec::new()
        };
        if let Some(u) = usage {
            push_history(&mut self.cpu_history, u);
        }
        let cpu_name = self.sys.cpus().first().map(|c| c.brand().trim().to_string()).unwrap_or_default();
        if want_temps {
            limitations.push(Limitation {
                metric: "CPU TEMP".into(),
                reason: "Windows has no documented, unelevated CPU temperature API. The ACPI thermal zone \
                         (WMI) is not the CPU die temperature and needs admin rights, so FLIP shows N/A rather \
                         than a misleading value."
                    .into(),
            });
        }

        // Memory.
        self.sys.refresh_memory_specifics(MemoryRefreshKind::nothing().with_ram());
        let memory = MemoryInfo { used_bytes: self.sys.used_memory(), total_bytes: self.sys.total_memory() };

        // Network: sysinfo's received()/transmitted() are deltas since the previous refresh.
        self.networks.refresh(true);
        let (rx, tx) = self
            .networks
            .list()
            .values()
            .fold((0u64, 0u64), |(r, t), n| (r.saturating_add(n.received()), t.saturating_add(n.transmitted())));
        let network = match elapsed {
            Some(e) => NetworkInfo { rx_bytes_per_sec: rate(rx, e), tx_bytes_per_sec: rate(tx, e) },
            None => NetworkInfo { rx_bytes_per_sec: None, tx_bytes_per_sec: None },
        };
        if let (Some(r), Some(t)) = (network.rx_bytes_per_sec, network.tx_bytes_per_sec) {
            push_history(&mut self.rx_history, r);
            push_history(&mut self.tx_history, t);
        }

        // Disks: space changes slowly, and the list refresh notices drives being added/removed.
        if now.duration_since(self.last_disks).as_secs() >= DISK_REFRESH_SECS {
            self.disks.refresh(true);
            self.last_disks = now;
        }
        let mut disks: Vec<DiskInfo> = self
            .disks
            .list()
            .iter()
            .filter(|d| d.total_space() > 0)
            .map(|d| DiskInfo {
                mount: mount_label(&d.mount_point().to_string_lossy()),
                used_bytes: d.total_space().saturating_sub(d.available_space()),
                total_bytes: d.total_space(),
            })
            .collect();
        disks.sort_by(|a, b| a.mount.cmp(&b.mount));
        disks.dedup_by(|a, b| a.mount == b.mount);

        // Processes.
        if self.last_processes.is_none_or(|t| now.duration_since(t).as_secs() >= PROCESS_REFRESH_SECS) {
            self.sys.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::nothing().with_cpu().with_memory());
            self.last_processes = Some(now);
            let mut procs: Vec<ProcessInfo> = self
                .sys
                .processes()
                .values()
                .map(|p| ProcessInfo {
                    name: p.name().to_string_lossy().to_uppercase(),
                    cpu: process_cpu_share(p.cpu_usage(), threads),
                    memory_bytes: p.memory(),
                })
                .collect();
            procs.sort_by(|a, b| b.cpu.total_cmp(&a.cpu).then(b.memory_bytes.cmp(&a.memory_bytes)));
            procs.truncate(8);
            self.top = procs;
        }

        // GPU.
        let gpu = if want_gpu {
            let g = self.gpu.sample(want_temps);
            for (metric, reason) in g.limitations {
                limitations.push(Limitation { metric, reason });
            }
            GpuInfo { name: g.name, usage: g.usage, temperature_c: g.temperature_c, source: g.source }
        } else {
            GpuInfo { name: None, usage: None, temperature_c: None, source: None }
        };

        SystemSnapshot {
            sampled_at: Utc::now(),
            hostname: self.hostname.clone(),
            cpu: CpuInfo { name: cpu_name, threads, usage, per_core, temperature_c: None },
            memory,
            disks,
            network,
            gpu,
            uptime_secs: System::uptime(),
            process_count: self.sys.processes().len(),
            cpu_history: padded(&self.cpu_history),
            rx_history: padded(&self.rx_history),
            tx_history: padded(&self.tx_history),
            top_processes: self.top.clone(),
            limitations,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn percent_normalization() {
        assert_eq!(normalize_percent(34.0), Some(0.34));
        assert_eq!(normalize_percent(150.0), Some(1.0));
        assert_eq!(normalize_percent(-1.0), None);
        assert_eq!(normalize_percent(f32::NAN), None);
    }

    #[test]
    fn network_rate() {
        assert_eq!(rate(2_000_000, 2.0), Some(1_000_000.0));
        assert_eq!(rate(10, 0.0), None);
        assert_eq!(rate(10, f64::INFINITY), None);
    }

    #[test]
    fn process_share_scales_by_threads() {
        assert!((process_cpu_share(200.0, 16) - 0.125).abs() < 1e-6);
        assert_eq!(process_cpu_share(5000.0, 4), 1.0);
        assert_eq!(process_cpu_share(10.0, 0), 0.0);
    }

    #[test]
    fn mount_labels() {
        assert_eq!(mount_label("C:\\"), "C:");
        assert_eq!(mount_label("d:\\"), "D:");
        assert_eq!(mount_label("/"), "/");
    }

    #[test]
    fn history_is_bounded_and_padded() {
        let mut h = VecDeque::new();
        for i in 0..100 {
            push_history(&mut h, i as f32);
        }
        assert_eq!(h.len(), HISTORY_LEN);
        assert_eq!(*h.front().unwrap(), 40.0);
        let mut short = VecDeque::new();
        push_history(&mut short, 1.0_f32);
        let p = padded(&short);
        assert_eq!(p.len(), HISTORY_LEN);
        assert_eq!(p[HISTORY_LEN - 1], 1.0);
        assert_eq!(p[0], 0.0);
    }

    #[test]
    fn live_sample_is_sane() {
        let mut m = SystemMonitor::new();
        let first = m.sample(false, false);
        assert!(first.cpu.usage.is_none(), "first sample has no usage baseline");
        assert!(first.network.rx_bytes_per_sec.is_none());
        std::thread::sleep(std::time::Duration::from_millis(300));
        let s = m.sample(false, true);
        assert!(s.memory.total_bytes > 0);
        assert!(s.memory.used_bytes <= s.memory.total_bytes);
        let u = s.cpu.usage.expect("cpu usage after two samples");
        assert!((0.0..=1.0).contains(&u));
        assert!(s.network.rx_bytes_per_sec.is_some());
        assert!(s.cpu.temperature_c.is_none());
        assert!(s.limitations.iter().any(|l| l.metric == "CPU TEMP"));
        assert!(s.disks.iter().all(|d| d.used_bytes <= d.total_bytes));
        assert_eq!(s.cpu_history.len(), HISTORY_LEN);
    }
}
