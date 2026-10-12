//! GPU metrics, isolated from the rest of the monitor because every source here is
//! hardware- or driver-specific.
//!
//! * Utilization: the Windows PDH `GPU Engine` counters (the same source Task Manager uses).
//!   Vendor-neutral, needs WDDM 2.0+ drivers. Reported as the busiest engine type.
//! * Memory: the PDH `GPU Adapter Memory` counters for the main adapter, against the totals DXGI
//!   reports. Dedicated VRAM for discrete GPUs; shared system memory for integrated GPUs.
//! * Name: DXGI adapter enumeration (largest dedicated-memory hardware adapter).
//! * Temperature: NVIDIA NVML (`nvml.dll`, shipped with NVIDIA drivers), loaded at runtime.
//!   Other vendors have no documented, unelevated temperature API, so they report `None`.

use std::collections::HashMap;

use super::system_monitor::LimitKind;

/// One reading. `None` means "not available", never zero.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct GpuReading {
    pub name: Option<String>,
    pub usage: Option<f32>,
    pub temperature_c: Option<f32>,
    pub memory: Option<GpuMemory>,
    pub source: Option<String>,
    pub limitations: Vec<(String, String, LimitKind)>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct GpuMemory {
    pub used_bytes: u64,
    pub total_bytes: u64,
    /// True when the figure is shared system memory (integrated GPU), not dedicated VRAM.
    pub shared: bool,
}

/// Parses a PDH `GPU Engine` instance name into (adapter luid, engine type).
/// Example: `pid_1234_luid_0x00000000_0x0000D1B5_phys_0_eng_0_engtype_3D`.
pub fn parse_engine_instance(name: &str) -> Option<(String, String)> {
    let luid = parse_luid(name)?;
    let eng_at = name.find("engtype_")?;
    let engtype = name[eng_at + 8..].to_string();
    Some((luid, engtype))
}

/// Adapter luid from a PDH instance name (`…luid_0xHIGH_0xLOW_phys_…`), uppercased.
pub fn parse_luid(name: &str) -> Option<String> {
    let luid_at = name.find("luid_")?;
    let rest = &name[luid_at + 5..];
    let phys_at = rest.find("_phys_")?;
    Some(rest[..phys_at].to_ascii_uppercase())
}

/// The luid key DXGI's `AdapterLuid` maps to in PDH instance names.
pub fn luid_key(high: i32, low: u32) -> String {
    format!("0X{:08X}_0X{:08X}", high as u32, low)
}

/// Task-Manager style aggregation: sum per (adapter, engine type) across processes, then take the max.
/// Input values are percentages (0..100+). Output is 0..1.
pub fn aggregate_engine_usage<'a>(items: impl IntoIterator<Item = (&'a str, f64)>) -> Option<f32> {
    let mut sums: HashMap<(String, String), f64> = HashMap::new();
    let mut any = false;
    for (name, v) in items {
        if !v.is_finite() || v < 0.0 {
            continue;
        }
        if let Some(key) = parse_engine_instance(name) {
            *sums.entry(key).or_default() += v;
            any = true;
        }
    }
    if !any {
        return None;
    }
    let max = sums.values().copied().fold(0.0_f64, f64::max);
    Some((max / 100.0).clamp(0.0, 1.0) as f32)
}

/// Sums `GPU Adapter Memory` instances belonging to one adapter.
pub fn adapter_memory<'a>(items: impl IntoIterator<Item = (&'a str, i64)>, luid: &str) -> Option<u64> {
    let mut total: Option<u64> = None;
    for (name, v) in items {
        if v < 0 {
            continue;
        }
        if parse_luid(name).as_deref() == Some(luid) {
            total = Some(total.unwrap_or(0) + v as u64);
        }
    }
    total
}

/// Dedicated VRAM when the adapter has a meaningful amount (discrete GPU), otherwise the
/// shared system memory an integrated GPU actually uses.
pub fn choose_gpu_memory(dedicated: Option<(u64, u64)>, shared: Option<(u64, u64)>) -> Option<GpuMemory> {
    const MIN_DEDICATED: u64 = 512 * 1024 * 1024;
    if let Some((used, total)) = dedicated {
        if total >= MIN_DEDICATED {
            return Some(GpuMemory { used_bytes: used.min(total), total_bytes: total, shared: false });
        }
    }
    shared.filter(|(_, t)| *t > 0).map(|(used, total)| GpuMemory { used_bytes: used.min(total), total_bytes: total, shared: true })
}

#[cfg(windows)]
pub use imp::GpuMonitor;

#[cfg(not(windows))]
pub struct GpuMonitor;
#[cfg(not(windows))]
impl GpuMonitor {
    pub fn new() -> Self {
        Self
    }
    pub fn sample(&mut self, _want_temp: bool) -> GpuReading {
        GpuReading {
            limitations: vec![("GPU".into(), "GPU metrics are implemented for Windows only".into(), LimitKind::Unsupported)],
            ..Default::default()
        }
    }
}

#[cfg(windows)]
mod imp {
    use super::{adapter_memory, aggregate_engine_usage, choose_gpu_memory, luid_key, GpuReading};
    use crate::services::system_monitor::LimitKind;
    use windows::core::{PCWSTR, PWSTR};
    use windows::Win32::Graphics::Dxgi::{CreateDXGIFactory1, IDXGIFactory1, DXGI_ADAPTER_FLAG_SOFTWARE};
    use windows::Win32::System::Performance::{
        PdhAddEnglishCounterW, PdhCloseQuery, PdhCollectQueryData, PdhGetFormattedCounterArrayW, PdhOpenQueryW, PDH_FMT,
        PDH_FMT_COUNTERVALUE_ITEM_W, PDH_FMT_DOUBLE, PDH_FMT_LARGE, PDH_HCOUNTER, PDH_HQUERY, PDH_MORE_DATA,
    };

    const PDH_FMT_NOCAP100: u32 = 0x0000_8000;
    const ERROR_SUCCESS: u32 = 0;

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    unsafe fn pwstr_to_string(p: PWSTR) -> String {
        if p.is_null() {
            return String::new();
        }
        unsafe { p.to_string().unwrap_or_default() }
    }

    enum Value {
        Double(f64),
        Large(i64),
    }

    /// Reads every instance of a wildcard counter. `Ok(empty)` when no instances exist.
    unsafe fn read_array(counter: PDH_HCOUNTER, large: bool) -> Result<Vec<(String, Value)>, String> {
        let fmt = if large { PDH_FMT(PDH_FMT_LARGE.0) } else { PDH_FMT(PDH_FMT_DOUBLE.0 | PDH_FMT_NOCAP100) };
        let mut size: u32 = 0;
        let mut count: u32 = 0;
        let s = unsafe { PdhGetFormattedCounterArrayW(counter, fmt, &mut size, &mut count, None) };
        if s != PDH_MORE_DATA {
            return Ok(Vec::new());
        }
        // The buffer holds the item array followed by the name strings it points into.
        let item_size = std::mem::size_of::<PDH_FMT_COUNTERVALUE_ITEM_W>();
        let mut buf: Vec<PDH_FMT_COUNTERVALUE_ITEM_W> = Vec::with_capacity((size as usize).div_ceil(item_size) + 1);
        let s = unsafe { PdhGetFormattedCounterArrayW(counter, fmt, &mut size, &mut count, Some(buf.as_mut_ptr())) };
        if s != ERROR_SUCCESS {
            return Err(format!("PdhGetFormattedCounterArray failed (0x{s:08X})"));
        }
        unsafe { buf.set_len(count as usize) };
        let mut out = Vec::with_capacity(buf.len());
        for item in &buf {
            // CStatus 0 = valid, 1 = new data.
            if item.FmtValue.CStatus > 1 {
                continue;
            }
            let name = unsafe { pwstr_to_string(item.szName) };
            let v = unsafe {
                if large {
                    Value::Large(item.FmtValue.Anonymous.largeValue)
                } else {
                    Value::Double(item.FmtValue.Anonymous.doubleValue)
                }
            };
            out.push((name, v));
        }
        Ok(out)
    }

    /// One PDH query holding the GPU counters. Memory counters are optional (older drivers).
    struct GpuQuery {
        query: PDH_HQUERY,
        engine: PDH_HCOUNTER,
        dedicated: Option<PDH_HCOUNTER>,
        shared: Option<PDH_HCOUNTER>,
        primed: bool,
    }

    // PDH handles are process-wide and not tied to the creating thread. The monitor is only
    // ever used from the sampler thread.
    unsafe impl Send for GpuQuery {}

    struct Sample {
        usage: Option<f32>,
        dedicated: Vec<(String, i64)>,
        shared: Vec<(String, i64)>,
    }

    impl GpuQuery {
        fn open() -> Result<Self, String> {
            let mut query = PDH_HQUERY::default();
            let add = |q: PDH_HQUERY, path: &str| -> Option<PDH_HCOUNTER> {
                let mut c = PDH_HCOUNTER::default();
                let p = wide(path);
                (unsafe { PdhAddEnglishCounterW(q, PCWSTR(p.as_ptr()), 0, &mut c) } == ERROR_SUCCESS).then_some(c)
            };
            unsafe {
                let s = PdhOpenQueryW(PCWSTR::null(), 0, &mut query);
                if s != ERROR_SUCCESS {
                    return Err(format!("PdhOpenQuery failed (0x{s:08X})"));
                }
            }
            let Some(engine) = add(query, r"\GPU Engine(*)\Utilization Percentage") else {
                unsafe { PdhCloseQuery(query) };
                return Err("GPU Engine counters are not available (driver older than WDDM 2.0?)".into());
            };
            let dedicated = add(query, r"\GPU Adapter Memory(*)\Dedicated Usage");
            let shared = add(query, r"\GPU Adapter Memory(*)\Shared Usage");
            unsafe { PdhCollectQueryData(query) };
            Ok(Self { query, engine, dedicated, shared, primed: false })
        }

        fn sample(&mut self) -> Result<Sample, String> {
            unsafe {
                let s = PdhCollectQueryData(self.query);
                if s != ERROR_SUCCESS {
                    return Err(format!("PdhCollectQueryData failed (0x{s:08X})"));
                }
            }
            let large = |c: Option<PDH_HCOUNTER>| -> Vec<(String, i64)> {
                c.and_then(|c| unsafe { read_array(c, true) }.ok())
                    .unwrap_or_default()
                    .into_iter()
                    .filter_map(|(n, v)| match v {
                        Value::Large(x) => Some((n, x)),
                        Value::Double(_) => None,
                    })
                    .collect()
            };
            let dedicated = large(self.dedicated);
            let shared = large(self.shared);
            // Utilization is a rate: the first collection has no baseline.
            if !self.primed {
                self.primed = true;
                return Ok(Sample { usage: None, dedicated, shared });
            }
            let values = unsafe { read_array(self.engine, false)? };
            let usage = aggregate_engine_usage(values.iter().filter_map(|(n, v)| match v {
                Value::Double(x) => Some((n.as_str(), *x)),
                Value::Large(_) => None,
            }));
            Ok(Sample { usage, dedicated, shared })
        }
    }

    impl Drop for GpuQuery {
        fn drop(&mut self) {
            unsafe {
                PdhCloseQuery(self.query);
            }
        }
    }

    struct Adapter {
        name: String,
        luid: String,
        dedicated: u64,
        shared: u64,
    }

    fn primary_adapter() -> Option<Adapter> {
        unsafe {
            let factory: IDXGIFactory1 = CreateDXGIFactory1().ok()?;
            let mut best: Option<Adapter> = None;
            let mut i = 0;
            while let Ok(adapter) = factory.EnumAdapters1(i) {
                i += 1;
                let Ok(desc) = adapter.GetDesc1() else { continue };
                if desc.Flags & (DXGI_ADAPTER_FLAG_SOFTWARE.0 as u32) != 0 {
                    continue;
                }
                let len = desc.Description.iter().position(|&c| c == 0).unwrap_or(desc.Description.len());
                let a = Adapter {
                    name: String::from_utf16_lossy(&desc.Description[..len]).trim().to_string(),
                    luid: luid_key(desc.AdapterLuid.HighPart, desc.AdapterLuid.LowPart),
                    dedicated: desc.DedicatedVideoMemory as u64,
                    shared: desc.SharedSystemMemory as u64,
                };
                if best.as_ref().is_none_or(|b| a.dedicated > b.dedicated) {
                    best = Some(a);
                }
            }
            best
        }
    }

    struct Nvidia {
        nvml: nvml_wrapper::Nvml,
    }

    impl Nvidia {
        fn init() -> Option<Self> {
            nvml_wrapper::Nvml::init().ok().map(|nvml| Self { nvml })
        }
        fn temperature(&self) -> Option<f32> {
            use nvml_wrapper::enum_wrappers::device::TemperatureSensor;
            let d = self.nvml.device_by_index(0).ok()?;
            d.temperature(TemperatureSensor::Gpu).ok().map(|t| t as f32)
        }
    }

    pub struct GpuMonitor {
        query: Result<GpuQuery, String>,
        adapter: Option<Adapter>,
        nvidia: Option<Nvidia>,
        nvidia_checked: bool,
    }

    impl GpuMonitor {
        pub fn new() -> Self {
            let query = GpuQuery::open();
            if let Err(e) = &query {
                log::info!("gpu: {e}");
            }
            Self { query, adapter: primary_adapter(), nvidia: None, nvidia_checked: false }
        }

        pub fn sample(&mut self, want_temp: bool) -> GpuReading {
            let mut r = GpuReading { name: self.adapter.as_ref().map(|a| a.name.clone()), ..Default::default() };
            match &mut self.query {
                Ok(q) => match q.sample() {
                    Ok(s) => {
                        r.usage = s.usage;
                        r.source = Some("WINDOWS PDH · GPU ENGINE".into());
                        if let Some(a) = &self.adapter {
                            let ded = adapter_memory(s.dedicated.iter().map(|(n, v)| (n.as_str(), *v)), &a.luid).map(|u| (u, a.dedicated));
                            let sh = adapter_memory(s.shared.iter().map(|(n, v)| (n.as_str(), *v)), &a.luid).map(|u| (u, a.shared));
                            r.memory = choose_gpu_memory(ded, sh);
                        }
                        if r.memory.is_none() {
                            r.limitations.push((
                                "GPU MEMORY".into(),
                                "The driver does not publish GPU Adapter Memory counters for this adapter.".into(),
                                LimitKind::Unsupported,
                            ));
                        }
                    }
                    Err(e) => r.limitations.push(("GPU LOAD".into(), format!("Temporary read failure: {e}"), LimitKind::Error)),
                },
                Err(e) => r.limitations.push(("GPU LOAD".into(), e.clone(), LimitKind::Unsupported)),
            }
            if want_temp {
                if !self.nvidia_checked {
                    self.nvidia_checked = true;
                    self.nvidia = Nvidia::init();
                    if self.nvidia.is_none() {
                        log::info!("gpu: NVML not available; GPU temperature disabled");
                    }
                }
                r.temperature_c = self.nvidia.as_ref().and_then(Nvidia::temperature);
                if r.temperature_c.is_none() {
                    let (reason, kind) = if self.nvidia.is_some() {
                        ("NVML is loaded but did not return a temperature this time.", LimitKind::Error)
                    } else {
                        (
                            "Only NVIDIA GPUs expose temperature through a documented, unelevated API (NVML). Other vendors show N/A.",
                            LimitKind::Unsupported,
                        )
                    };
                    r.limitations.push(("GPU TEMP".into(), reason.into(), kind));
                }
            }
            r
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_instance_names() {
        let n = "pid_1234_luid_0x00000000_0x0000D1B5_phys_0_eng_0_engtype_3D";
        assert_eq!(parse_engine_instance(n), Some(("0X00000000_0X0000D1B5".into(), "3D".into())));
        assert_eq!(parse_engine_instance("garbage"), None);
        assert_eq!(parse_luid("luid_0x00000000_0x0000d1b5_phys_0"), Some("0X00000000_0X0000D1B5".into()));
        assert_eq!(luid_key(0, 0xD1B5), "0X00000000_0X0000D1B5");
    }

    #[test]
    fn aggregates_like_task_manager() {
        let items = [
            ("pid_1_luid_0x0_0x1_phys_0_eng_0_engtype_3D", 20.0),
            ("pid_2_luid_0x0_0x1_phys_0_eng_0_engtype_3D", 15.0),
            ("pid_2_luid_0x0_0x1_phys_0_eng_3_engtype_VideoDecode", 30.0),
            ("pid_3_luid_0x0_0x2_phys_0_eng_0_engtype_3D", 5.0),
            ("bogus", 99.0),
        ];
        let u = aggregate_engine_usage(items.iter().map(|(n, v)| (*n, *v))).unwrap();
        assert!((u - 0.35).abs() < 1e-6, "{u}");
    }

    #[test]
    fn clamps_and_ignores_bad_values() {
        let items = [("pid_1_luid_a_phys_0_eng_0_engtype_3D", 180.0), ("pid_2_luid_a_phys_0_eng_0_engtype_3D", f64::NAN)];
        assert_eq!(aggregate_engine_usage(items.iter().map(|(n, v)| (*n, *v))), Some(1.0));
        assert_eq!(aggregate_engine_usage(std::iter::empty()), None);
    }

    #[test]
    fn sums_memory_for_the_chosen_adapter_only() {
        let items = [
            ("luid_0x00000000_0x0000D1B5_phys_0", 1_000_i64),
            ("luid_0x00000000_0x0000D1B5_phys_1", 500),
            ("luid_0x00000000_0x0000AAAA_phys_0", 9_999),
            ("luid_0x00000000_0x0000D1B5_phys_2", -5),
        ];
        assert_eq!(adapter_memory(items.iter().map(|(n, v)| (*n, *v)), "0X00000000_0X0000D1B5"), Some(1_500));
        assert_eq!(adapter_memory(items.iter().map(|(n, v)| (*n, *v)), "0X00000000_0X0000FFFF"), None, "no instance: unknown, not zero");
    }

    #[test]
    fn picks_dedicated_for_discrete_and_shared_for_integrated() {
        const GB: u64 = 1024 * 1024 * 1024;
        let discrete = choose_gpu_memory(Some((3 * GB, 12 * GB)), Some((GB / 10, 16 * GB))).unwrap();
        assert!(!discrete.shared);
        assert_eq!((discrete.used_bytes, discrete.total_bytes), (3 * GB, 12 * GB));
        let integrated = choose_gpu_memory(Some((10, 128 * 1024 * 1024)), Some((GB, 8 * GB))).unwrap();
        assert!(integrated.shared);
        assert_eq!(integrated.total_bytes, 8 * GB);
        assert_eq!(choose_gpu_memory(None, None), None);
        assert_eq!(choose_gpu_memory(None, Some((5, 0))), None);
        let over = choose_gpu_memory(Some((20 * GB, 12 * GB)), None).unwrap();
        assert_eq!(over.used_bytes, 12 * GB, "used never exceeds total");
    }
}
