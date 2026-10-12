//! GPU metrics, isolated from the rest of the monitor because every source here is
//! hardware- or driver-specific.
//!
//! * Utilization: the Windows PDH `GPU Engine` counters (the same source Task Manager uses).
//!   Vendor-neutral, needs WDDM 2.0+ drivers. Reported as the busiest engine type.
//! * Name: DXGI adapter enumeration (largest dedicated-memory hardware adapter).
//! * Temperature: NVIDIA NVML (`nvml.dll`, shipped with NVIDIA drivers), loaded at runtime.
//!   Other vendors have no documented, unelevated temperature API, so they report `None`.

use std::collections::HashMap;

/// One reading. `None` means "not available", never zero.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct GpuReading {
    pub name: Option<String>,
    pub usage: Option<f32>,
    pub temperature_c: Option<f32>,
    pub source: Option<String>,
    pub limitations: Vec<(String, String)>,
}

/// Parses a PDH `GPU Engine` instance name into (adapter luid, engine type).
/// Example: `pid_1234_luid_0x00000000_0x0000D1B5_phys_0_eng_0_engtype_3D`.
pub fn parse_engine_instance(name: &str) -> Option<(String, String)> {
    let luid_at = name.find("luid_")?;
    let rest = &name[luid_at + 5..];
    let phys_at = rest.find("_phys_")?;
    let luid = rest[..phys_at].to_string();
    let eng_at = name.find("engtype_")?;
    let engtype = name[eng_at + 8..].to_string();
    Some((luid, engtype))
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
        GpuReading { limitations: vec![("GPU".into(), "GPU metrics are implemented for Windows only".into())], ..Default::default() }
    }
}

#[cfg(windows)]
mod imp {
    use super::{aggregate_engine_usage, GpuReading};
    use windows::core::{PCWSTR, PWSTR};
    use windows::Win32::Graphics::Dxgi::{CreateDXGIFactory1, IDXGIFactory1, DXGI_ADAPTER_FLAG_SOFTWARE};
    use windows::Win32::System::Performance::{
        PdhAddEnglishCounterW, PdhCloseQuery, PdhCollectQueryData, PdhGetFormattedCounterArrayW, PdhOpenQueryW, PDH_FMT,
        PDH_FMT_COUNTERVALUE_ITEM_W, PDH_FMT_DOUBLE, PDH_HCOUNTER, PDH_HQUERY, PDH_MORE_DATA,
    };

    const PDH_FMT_NOCAP100: u32 = 0x0000_8000;
    const ERROR_SUCCESS: u32 = 0;

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    /// Owns a PDH query for `\GPU Engine(*)\Utilization Percentage`.
    struct EngineQuery {
        query: PDH_HQUERY,
        counter: PDH_HCOUNTER,
        primed: bool,
    }

    // PDH handles are process-wide and not tied to the creating thread. The monitor is only
    // ever used behind a Mutex from one task at a time.
    unsafe impl Send for EngineQuery {}

    impl EngineQuery {
        fn open() -> Result<Self, String> {
            let mut query = PDH_HQUERY::default();
            let mut counter = PDH_HCOUNTER::default();
            let path = wide(r"\GPU Engine(*)\Utilization Percentage");
            unsafe {
                let s = PdhOpenQueryW(PCWSTR::null(), 0, &mut query);
                if s != ERROR_SUCCESS {
                    return Err(format!("PdhOpenQuery failed (0x{s:08X})"));
                }
                let s = PdhAddEnglishCounterW(query, PCWSTR(path.as_ptr()), 0, &mut counter);
                if s != ERROR_SUCCESS {
                    PdhCloseQuery(query);
                    return Err(format!("GPU Engine counters unavailable (0x{s:08X})"));
                }
                PdhCollectQueryData(query);
            }
            Ok(Self { query, counter, primed: false })
        }

        /// Returns None on the first call (rates need two samples) or when no engines report.
        fn sample(&mut self) -> Result<Option<f32>, String> {
            unsafe {
                let s = PdhCollectQueryData(self.query);
                if s != ERROR_SUCCESS {
                    return Err(format!("PdhCollectQueryData failed (0x{s:08X})"));
                }
                if !self.primed {
                    self.primed = true;
                    return Ok(None);
                }
                let fmt = PDH_FMT(PDH_FMT_DOUBLE.0 | PDH_FMT_NOCAP100);
                let mut size: u32 = 0;
                let mut count: u32 = 0;
                let s = PdhGetFormattedCounterArrayW(self.counter, fmt, &mut size, &mut count, None);
                if s != PDH_MORE_DATA {
                    // No GPU engine instances at all (e.g. basic display driver).
                    return Ok(None);
                }
                // The buffer holds the item array followed by the name strings it points into.
                let item_size = std::mem::size_of::<PDH_FMT_COUNTERVALUE_ITEM_W>();
                let mut buf: Vec<PDH_FMT_COUNTERVALUE_ITEM_W> = Vec::with_capacity((size as usize).div_ceil(item_size) + 1);
                let s = PdhGetFormattedCounterArrayW(self.counter, fmt, &mut size, &mut count, Some(buf.as_mut_ptr()));
                if s != ERROR_SUCCESS {
                    return Err(format!("PdhGetFormattedCounterArray failed (0x{s:08X})"));
                }
                buf.set_len(count as usize);
                let mut values = Vec::with_capacity(buf.len());
                for item in &buf {
                    // CStatus 0 = valid, 1 = new data.
                    if item.FmtValue.CStatus > 1 {
                        continue;
                    }
                    let name = pwstr_to_string(item.szName);
                    values.push((name, item.FmtValue.Anonymous.doubleValue));
                }
                Ok(aggregate_engine_usage(values.iter().map(|(n, v)| (n.as_str(), *v))))
            }
        }
    }

    unsafe fn pwstr_to_string(p: PWSTR) -> String {
        if p.is_null() {
            return String::new();
        }
        unsafe { p.to_string().unwrap_or_default() }
    }

    impl Drop for EngineQuery {
        fn drop(&mut self) {
            unsafe {
                PdhCloseQuery(self.query);
            }
        }
    }

    fn primary_adapter_name() -> Option<String> {
        unsafe {
            let factory: IDXGIFactory1 = CreateDXGIFactory1().ok()?;
            let mut best: Option<(usize, String)> = None;
            let mut i = 0;
            while let Ok(adapter) = factory.EnumAdapters1(i) {
                i += 1;
                let Ok(desc) = adapter.GetDesc1() else { continue };
                if desc.Flags & (DXGI_ADAPTER_FLAG_SOFTWARE.0 as u32) != 0 {
                    continue;
                }
                let len = desc.Description.iter().position(|&c| c == 0).unwrap_or(desc.Description.len());
                let name = String::from_utf16_lossy(&desc.Description[..len]).trim().to_string();
                if best.as_ref().is_none_or(|(mem, _)| desc.DedicatedVideoMemory > *mem) {
                    best = Some((desc.DedicatedVideoMemory, name));
                }
            }
            best.map(|(_, n)| n)
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
        engines: Result<EngineQuery, String>,
        name: Option<String>,
        nvidia: Option<Nvidia>,
        nvidia_checked: bool,
    }

    impl GpuMonitor {
        pub fn new() -> Self {
            let engines = EngineQuery::open();
            if let Err(e) = &engines {
                log::info!("gpu: {e}");
            }
            Self { engines, name: primary_adapter_name(), nvidia: None, nvidia_checked: false }
        }

        pub fn sample(&mut self, want_temp: bool) -> GpuReading {
            let mut r = GpuReading { name: self.name.clone(), ..Default::default() };
            match &mut self.engines {
                Ok(q) => match q.sample() {
                    Ok(u) => {
                        r.usage = u;
                        r.source = Some("WINDOWS PDH · GPU ENGINE".into());
                    }
                    Err(e) => r.limitations.push(("GPU LOAD".into(), e)),
                },
                Err(e) => r.limitations.push(("GPU LOAD".into(), e.clone())),
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
                    r.limitations.push((
                        "GPU TEMP".into(),
                        "Only NVIDIA GPUs expose temperature through a documented, unelevated API (NVML). \
                         Other vendors show N/A."
                            .into(),
                    ));
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
        assert_eq!(parse_engine_instance(n), Some(("0x00000000_0x0000D1B5".into(), "3D".into())));
        assert_eq!(parse_engine_instance("garbage"), None);
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
}
