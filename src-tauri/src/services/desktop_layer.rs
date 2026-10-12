//! Keeps the dashboard on the desktop layer.
//!
//! FLIP is a borderless top-level window with three stacking behaviours:
//!
//! * **Desktop**: pinned to the bottom of the window stack. A window subclass rewrites every
//!   z-order change to `HWND_BOTTOM`, so clicking FLIP never brings it over other apps. When
//!   Show Desktop (Win+D) brings the desktop forward, a foreground-change hook raises FLIP above
//!   it and drops it back as soon as another app takes the foreground. Clicks and hover still reach
//!   FLIP, unlike a window parented behind the desktop icons.
//! * **Normal**: an ordinary window.
//! * **Top**: always on top, but stepped back while Windows reports a fullscreen app or presentation
//!   (`SHQueryUserNotificationState`).
//!
//! All windows are tool windows (`WS_EX_TOOLWINDOW`): no taskbar button and no Alt+Tab entry.
//! Only documented Win32 calls are used; nothing is injected into Explorer.

use super::settings::WindowLayer;

/// What to do when the foreground window changes, in desktop layer. Pure, so it is testable.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Raise {
    /// The desktop came forward (Show Desktop): lift FLIP above it.
    Up,
    /// Another app came forward: return to the bottom.
    Down,
    Stay,
}

pub fn on_foreground(class: &str, is_ours: bool, raised: bool) -> Raise {
    let desktop = matches!(class, "WorkerW" | "Progman");
    if desktop && !raised {
        Raise::Up
    } else if !desktop && !is_ours && raised {
        Raise::Down
    } else {
        Raise::Stay
    }
}

/// `SHQueryUserNotificationState` values that mean a fullscreen app or presentation is running.
pub fn fullscreen_busy(quns: i32) -> bool {
    // QUNS_BUSY = 2, QUNS_RUNNING_D3D_FULL_SCREEN = 3, QUNS_PRESENTATION_MODE = 4
    matches!(quns, 2..=4)
}

/// `COLORREF` (0x00BBGGRR) to `#rrggbb`.
pub fn colorref_to_hex(c: u32) -> String {
    format!("#{:02x}{:02x}{:02x}", c & 0xff, (c >> 8) & 0xff, (c >> 16) & 0xff)
}

pub fn layer_code(l: WindowLayer) -> u8 {
    match l {
        WindowLayer::Desktop => 0,
        WindowLayer::Normal => 1,
        WindowLayer::Top => 2,
    }
}

#[cfg(windows)]
pub use imp::{apply_layer, desktop_solid_color, install, is_fullscreen_app_running, set_top_suppressed, stop};

#[cfg(not(windows))]
mod fallback {
    use super::*;
    pub fn install<R: tauri::Runtime>(_w: &tauri::WebviewWindow<R>, _main: bool) {}
    pub fn apply_layer<R: tauri::Runtime>(w: &tauri::WebviewWindow<R>, layer: WindowLayer) {
        let _ = w.set_always_on_top(layer == WindowLayer::Top);
    }
    pub fn is_fullscreen_app_running() -> bool {
        false
    }
    pub fn set_top_suppressed<R: tauri::Runtime>(_w: &tauri::WebviewWindow<R>, _s: bool) {}
    pub fn desktop_solid_color() -> Option<String> {
        None
    }
    pub fn stop() {}
}
#[cfg(not(windows))]
pub use fallback::{apply_layer, desktop_solid_color, install, is_fullscreen_app_running, set_top_suppressed, stop};

#[cfg(windows)]
mod imp {
    use std::sync::atomic::{AtomicBool, AtomicIsize, AtomicU8, Ordering};

    use tauri::{Runtime, WebviewWindow};
    use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
    use windows::Win32::Graphics::Gdi::{GetSysColor, COLOR_DESKTOP};
    use windows::Win32::UI::Accessibility::{SetWinEventHook, HWINEVENTHOOK};
    use windows::Win32::UI::Shell::{DefSubclassProc, SHQueryUserNotificationState, SetWindowSubclass};
    use windows::Win32::UI::WindowsAndMessaging::{
        GetClassNameW, GetForegroundWindow, GetWindow, GetWindowLongPtrW, GetWindowThreadProcessId, SetWindowLongPtrW, SetWindowPos,
        SystemParametersInfoW, EVENT_SYSTEM_FOREGROUND, GWL_EXSTYLE, GW_HWNDPREV, HWND_BOTTOM, HWND_NOTOPMOST, HWND_TOPMOST,
        SPI_GETDESKWALLPAPER, STYLESTRUCT, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER, SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS,
        WINDOWPOS, WINEVENT_OUTOFCONTEXT, WM_STYLECHANGING, WM_WINDOWPOSCHANGING, WS_EX_APPWINDOW, WS_EX_TOOLWINDOW,
    };

    use super::{layer_code, on_foreground, Raise};
    use crate::services::settings::WindowLayer;

    static MAIN_HWND: AtomicIsize = AtomicIsize::new(0);
    static LAYER: AtomicU8 = AtomicU8::new(0);
    /// Lifted above the desktop during Show Desktop.
    static RAISED: AtomicBool = AtomicBool::new(false);
    static HOOKED: AtomicBool = AtomicBool::new(false);
    static STOP: AtomicBool = AtomicBool::new(false);
    /// How often the foreground is re-checked, in case a hook event arrives late or not at all.
    const POLL: std::time::Duration = std::time::Duration::from_millis(250);
    const SUBCLASS_ID: usize = 0xF11F;

    fn main_hwnd() -> Option<HWND> {
        let h = MAIN_HWND.load(Ordering::SeqCst);
        (h != 0).then_some(HWND(h as *mut _))
    }

    fn set_z(hwnd: HWND, after: HWND) {
        unsafe {
            let _ = SetWindowPos(hwnd, Some(after), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
        }
    }

    /// Keeps the tool-window style (the windowing layer rebuilds extended styles on every
    /// resizable/topmost change) and, for the dashboard in desktop layer, rewrites z-order
    /// changes to the bottom unless it is raised for Show Desktop.
    unsafe extern "system" fn subclass_proc(hwnd: HWND, msg: u32, wp: WPARAM, lp: LPARAM, _id: usize, _data: usize) -> LRESULT {
        if msg == WM_STYLECHANGING && wp.0 as i32 == GWL_EXSTYLE.0 && lp.0 != 0 {
            let st = unsafe { &mut *(lp.0 as *mut STYLESTRUCT) };
            st.styleNew = (st.styleNew | WS_EX_TOOLWINDOW.0) & !WS_EX_APPWINDOW.0;
        }
        let is_main = main_hwnd() == Some(hwnd);
        if is_main && msg == WM_WINDOWPOSCHANGING && LAYER.load(Ordering::SeqCst) == 0 && !RAISED.load(Ordering::SeqCst) && lp.0 != 0 {
            let pos = unsafe { &mut *(lp.0 as *mut WINDOWPOS) };
            if pos.flags & SWP_NOZORDER == Default::default() {
                pos.hwndInsertAfter = HWND_BOTTOM;
            }
        }
        unsafe { DefSubclassProc(hwnd, msg, wp, lp) }
    }

    fn class_of(hwnd: HWND) -> String {
        let mut buf = [0u16; 64];
        let n = unsafe { GetClassNameW(hwnd, &mut buf) };
        String::from_utf16_lossy(&buf[..n.max(0) as usize])
    }

    fn is_ours(hwnd: HWND) -> bool {
        let mut pid = 0u32;
        unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
        pid == std::process::id()
    }

    /// Puts FLIP directly above the desktop window. During Show Desktop the desktop sits above
    /// every app, so FLIP shows on top of it; after a plain click on the desktop it stays at the
    /// bottom, so FLIP does not jump over open apps.
    fn place_above_desktop(main: HWND, desktop: HWND) {
        let prev = unsafe { GetWindow(desktop, GW_HWNDPREV) }.unwrap_or_default();
        if prev == main {
            return; // already in place
        }
        if prev.0.is_null() {
            set_z(main, windows::Win32::UI::WindowsAndMessaging::HWND_TOP);
        } else {
            set_z(main, prev);
        }
    }

    /// Brings the dashboard's position in line with the current foreground window. Called from
    /// the foreground hook and from a 250 ms poll; idempotent.
    fn reconcile() {
        let Some(main) = main_hwnd() else { return };
        if LAYER.load(Ordering::SeqCst) != 0 {
            return;
        }
        let fg = unsafe { GetForegroundWindow() };
        if fg.0.is_null() {
            return;
        }
        let class = class_of(fg);
        let raised = RAISED.load(Ordering::SeqCst);
        match on_foreground(&class, is_ours(fg), raised) {
            Raise::Up => {
                RAISED.store(true, Ordering::SeqCst);
                log::debug!("desktop layer: desktop has the foreground; staying above it");
                place_above_desktop(main, fg);
            }
            Raise::Down => {
                RAISED.store(false, Ordering::SeqCst);
                set_z(main, HWND_NOTOPMOST);
                set_z(main, HWND_BOTTOM);
            }
            Raise::Stay => {
                // Still on the desktop: Show Desktop may re-order after our first move.
                if raised && matches!(class.as_str(), "WorkerW" | "Progman") {
                    place_above_desktop(main, fg);
                }
            }
        }
    }

    unsafe extern "system" fn on_event(_h: HWINEVENTHOOK, _ev: u32, _hwnd: HWND, _o: i32, _c: i32, _t: u32, _ms: u32) {
        reconcile();
    }

    /// Stops the foreground poll (called on exit).
    pub fn stop() {
        STOP.store(true, Ordering::SeqCst);
    }

    fn make_tool_window(hwnd: HWND) {
        unsafe {
            let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
            let ex = (ex | WS_EX_TOOLWINDOW.0 as isize) & !(WS_EX_APPWINDOW.0 as isize);
            SetWindowLongPtrW(hwnd, GWL_EXSTYLE, ex);
        }
    }

    /// Call on the main (UI) thread before the window is first shown.
    pub fn install<R: Runtime>(w: &WebviewWindow<R>, main: bool) {
        let Ok(hwnd) = w.hwnd() else { return };
        if main {
            MAIN_HWND.store(hwnd.0 as isize, Ordering::SeqCst);
        }
        unsafe {
            let _ = SetWindowSubclass(hwnd, Some(subclass_proc), SUBCLASS_ID, 0);
        }
        make_tool_window(hwnd);
        if !main {
            return;
        }
        if !HOOKED.swap(true, Ordering::SeqCst) {
            // Out-of-context hooks are delivered through this thread's message loop.
            let hook = unsafe {
                SetWinEventHook(EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_FOREGROUND, None, Some(on_event), 0, 0, WINEVENT_OUTOFCONTEXT)
            };
            if hook.0.is_null() {
                log::warn!("desktop layer: foreground hook unavailable; relying on polling");
            }
            let spawned = std::thread::Builder::new().name("flip-desktop-layer".into()).spawn(|| {
                while !STOP.load(Ordering::SeqCst) {
                    reconcile();
                    std::thread::sleep(POLL);
                }
            });
            if let Err(e) = spawned {
                log::warn!("desktop layer: poll thread not started: {e}");
            }
        }
    }

    pub fn apply_layer<R: Runtime>(w: &WebviewWindow<R>, layer: WindowLayer) {
        LAYER.store(layer_code(layer), Ordering::SeqCst);
        RAISED.store(false, Ordering::SeqCst);
        let Ok(hwnd) = w.hwnd() else { return };
        match layer {
            WindowLayer::Desktop => {
                set_z(hwnd, HWND_NOTOPMOST);
                set_z(hwnd, HWND_BOTTOM);
            }
            WindowLayer::Normal => set_z(hwnd, HWND_NOTOPMOST),
            WindowLayer::Top => set_z(hwnd, HWND_TOPMOST),
        }
    }

    /// The desktop's solid colour, or `None` when a wallpaper image covers it (nothing to match).
    pub fn desktop_solid_color() -> Option<String> {
        let mut buf = [0u16; 520];
        let ok = unsafe {
            SystemParametersInfoW(
                SPI_GETDESKWALLPAPER,
                buf.len() as u32,
                Some(buf.as_mut_ptr().cast()),
                SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS(0),
            )
        };
        let has_image = ok.is_ok() && buf[0] != 0;
        if has_image {
            return None;
        }
        Some(super::colorref_to_hex(unsafe { GetSysColor(COLOR_DESKTOP) }))
    }

    pub fn is_fullscreen_app_running() -> bool {
        unsafe { SHQueryUserNotificationState() }.map(|s| super::fullscreen_busy(s.0)).unwrap_or(false)
    }

    /// In the Top layer, steps aside for fullscreen apps and returns afterwards.
    pub fn set_top_suppressed<R: Runtime>(w: &WebviewWindow<R>, suppressed: bool) {
        if LAYER.load(Ordering::SeqCst) != 2 {
            return;
        }
        if let Ok(hwnd) = w.hwnd() {
            set_z(hwnd, if suppressed { HWND_NOTOPMOST } else { HWND_TOPMOST });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn show_desktop_raises_and_other_apps_lower() {
        assert_eq!(on_foreground("WorkerW", false, false), Raise::Up);
        assert_eq!(on_foreground("Progman", false, false), Raise::Up);
        assert_eq!(on_foreground("WorkerW", false, true), Raise::Stay);
        // Clicking FLIP itself (or its settings panel) while raised keeps it raised.
        assert_eq!(on_foreground("Tauri Window", true, true), Raise::Stay);
        assert_eq!(on_foreground("Chrome_WidgetWin_1", false, true), Raise::Down);
        assert_eq!(on_foreground("Chrome_WidgetWin_1", false, false), Raise::Stay);
    }

    #[test]
    fn colorref_conversion() {
        assert_eq!(colorref_to_hex(0), "#000000");
        assert_eq!(colorref_to_hex(0x00336699), "#996633");
        assert_eq!(colorref_to_hex(0x00ffffff), "#ffffff");
    }

    #[test]
    fn fullscreen_states() {
        assert!(fullscreen_busy(3));
        assert!(fullscreen_busy(4));
        assert!(fullscreen_busy(2));
        assert!(!fullscreen_busy(5));
        assert!(!fullscreen_busy(1));
    }
}
