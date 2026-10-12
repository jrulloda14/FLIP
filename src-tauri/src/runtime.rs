//! Background work. Three loops, all stopped by `AppState::shutdown`:
//!
//! * clock: wakes on each wall-clock second, emits the clock, ticks the Pomodoro timer, and
//!   does low-frequency housekeeping (placement save, off-screen recovery).
//! * system: a dedicated thread that samples metrics at the configured interval (slower while
//!   the window is hidden).
//! * ai: refreshes usage providers every N minutes or when woken.

use std::sync::atomic::Ordering;
use std::sync::mpsc;
use std::thread::JoinHandle;
use std::time::Duration as StdDuration;

use chrono::Utc;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_notification::NotificationExt;

use crate::commands::{self, EVT_CLOCK, EVT_POMODORO, EVT_SYSTEM};
use crate::services::alerts::AlertEngine;
use crate::services::pomodoro::{self, Completed, Phase};
use crate::services::profiles;
use crate::services::settings::{self, WindowLayer};
use crate::services::system_monitor::SystemMonitor;
use crate::services::{desktop_layer, tray, window};
use crate::state::{lock, AppState};

pub struct Workers {
    system: Option<(mpsc::Sender<()>, JoinHandle<()>)>,
}

impl Workers {
    /// Stops the sampler thread and waits briefly for it.
    pub fn stop(&mut self) {
        if let Some((tx, handle)) = self.system.take() {
            let _ = tx.send(());
            let _ = handle.join();
        }
    }
}

pub fn start(app: &AppHandle) -> Workers {
    tauri::async_runtime::spawn(clock_loop(app.clone()));
    tauri::async_runtime::spawn(ai_loop(app.clone()));
    Workers { system: Some(spawn_system_thread(app.clone())) }
}

fn ms_to_next_second() -> u64 {
    let ms = Utc::now().timestamp_subsec_millis() as u64;
    (1000 - ms).max(1) + 2
}

async fn clock_loop(app: AppHandle) {
    let state = app.state::<AppState>();
    let mut shutdown = state.shutdown.subscribe();
    let mut tick: u64 = 0;
    let mut last_running = false;
    loop {
        tokio::select! {
            _ = tokio::time::sleep(StdDuration::from_millis(ms_to_next_second())) => {}
            _ = shutdown.changed() => break,
        }
        if state.is_shutting_down() {
            break;
        }
        tick += 1;
        let _ = app.emit(EVT_CLOCK, commands::clock_snapshot(&state));

        // Pomodoro: deadline check. A phase that ended during sleep completes here on resume.
        let cfg = state.settings().focus.clone();
        let today = state.today();
        let (completed, view) = {
            let mut t = lock(&state.pomodoro);
            let c = t.tick(Utc::now(), today, &cfg);
            if c.is_some() {
                if let Err(e) = pomodoro::save(&state.paths.pomodoro(), &t) {
                    log::warn!("pomodoro state not saved: {e}");
                }
            }
            (c, t.view(Utc::now(), today, &cfg))
        };
        if let Some(c) = &completed {
            notify_completed(&app, &state, c);
        }
        if view.running || last_running || completed.is_some() {
            let _ = app.emit(EVT_POMODORO, &view);
            tray::sync_pomodoro(&app, &view);
        }
        last_running = view.running;

        // Keep-on-top steps aside while a fullscreen game or presentation runs.
        if state.settings().window.layer == WindowLayer::Top {
            let busy = desktop_layer::is_fullscreen_app_running();
            if state.top_suppressed.swap(busy, Ordering::SeqCst) != busy {
                if let Some(w) = window::main_window(&app) {
                    desktop_layer::set_top_suppressed(&w, busy);
                }
            }
        }

        if tick % 5 == 0 {
            if let Some(w) = window::main_window(&app) {
                // Optional profile auto-switch when displays are added or removed while FLIP runs.
                // The first check only records the count, so the profile restored at launch stays.
                let count = window::display_count(&w);
                if count > 0 {
                    let prev = state.display_count.swap(count, Ordering::SeqCst);
                    if profiles::display_count_changed(prev, count) {
                        commands::auto_switch_profile(&app, &state, count);
                        commands::emit_status(&app);
                    }
                }
                if let Some(notice) = window::check_displays(&w, &state) {
                    *lock(&state.display_notice) = notice;
                    commands::emit_status(&app);
                }
            }
            // Follow changes to the Windows desktop colour or wallpaper.
            let color = desktop_layer::desktop_solid_color();
            let changed = {
                let mut cur = lock(&state.desktop_color);
                let changed = *cur != color;
                *cur = color;
                changed
            };
            if changed {
                commands::emit_status(&app);
            }
            if state.placement_dirty.swap(false, Ordering::SeqCst) {
                let s = state.settings().clone();
                if let Err(e) = settings::save(&state.paths.settings(), &s) {
                    log::warn!("placement not saved: {e}");
                }
            }
        }
    }
    log::info!("clock loop stopped");
}

fn notify_completed(app: &AppHandle, state: &AppState, c: &Completed) {
    let n = state.settings().notifications.clone();
    let (title, body, enabled) = match c.phase {
        Phase::Focus => (
            "Focus session complete",
            match c.next {
                Phase::LongBreak => "Time for a long break.".to_string(),
                _ => "Time for a short break.".to_string(),
            },
            n.focus_complete,
        ),
        Phase::ShortBreak | Phase::LongBreak => ("Break over", "Ready for the next focus session.".to_string(), n.break_complete),
        Phase::Idle => return,
    };
    if !enabled {
        return;
    }
    if let Err(e) = app.notification().builder().title(title).body(body).show() {
        log::warn!("notification failed: {e}");
    }
}

fn spawn_system_thread(app: AppHandle) -> (mpsc::Sender<()>, JoinHandle<()>) {
    let (tx, rx) = mpsc::channel::<()>();
    let handle = std::thread::Builder::new()
        .name("flip-system-monitor".into())
        .spawn(move || {
            let mut monitor = SystemMonitor::new();
            let mut alerts = AlertEngine::new();
            loop {
                let state = app.state::<AppState>();
                if state.is_shutting_down() {
                    break;
                }
                let cfg = state.settings().system.clone();
                let snap = monitor.sample(cfg.gpu, cfg.temps);
                *lock(&state.system) = Some(snap.clone());
                // Opt-in threshold alerts (notify only; FLIP never acts on the system).
                let alert_cfg = state.settings().alerts.clone();
                if alert_cfg.cpu || alert_cfg.memory || alert_cfg.disk {
                    for a in alerts.evaluate(Utc::now(), &snap, &alert_cfg) {
                        if let Err(e) = app.notification().builder().title(&a.title).body(&a.body).show() {
                            log::warn!("alert notification failed: {e}");
                        }
                    }
                }
                let visible = window::main_window(&app).and_then(|w| w.is_visible().ok()).unwrap_or(true);
                if visible {
                    let _ = app.emit(EVT_SYSTEM, &snap);
                }
                // Hidden in the tray: keep a slow heartbeat so the first frame after showing is current.
                let secs = if visible { u64::from(cfg.sample_seconds) } else { 10 };
                match rx.recv_timeout(StdDuration::from_secs(secs)) {
                    Err(mpsc::RecvTimeoutError::Timeout) => continue,
                    _ => break,
                }
            }
            log::info!("system monitor stopped");
        })
        .expect("spawn system monitor thread");
    (tx, handle)
}

async fn ai_loop(app: AppHandle) {
    let state = app.state::<AppState>();
    let mut shutdown = state.shutdown.subscribe();
    loop {
        if state.is_shutting_down() {
            break;
        }
        commands::refresh_ai_now(&app, false).await;
        let minutes = u64::from(state.settings().ai.refresh_minutes);
        tokio::select! {
            _ = tokio::time::sleep(StdDuration::from_secs(minutes * 60)) => {}
            _ = state.ai_wake.notified() => {}
            _ = shutdown.changed() => break,
        }
    }
    log::info!("ai loop stopped");
}

/// Final writes before the process exits.
pub fn persist_on_exit(app: &AppHandle) {
    let state = app.state::<AppState>();
    if let Some(w) = window::main_window(app) {
        window::capture_placement(&w, &state);
    }
    let s = state.settings().clone();
    if let Err(e) = settings::save(&state.paths.settings(), &s) {
        log::warn!("settings not saved on exit: {e}");
    }
    if let Err(e) = pomodoro::save(&state.paths.pomodoro(), &lock(&state.pomodoro)) {
        log::warn!("pomodoro not saved on exit: {e}");
    }
    lock(&state.ai).cache.save(&state.paths.ai_cache());
}
