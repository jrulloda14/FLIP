//! FLIP backend: wires services, background workers, tray and window into the Tauri app.

mod commands;
mod error;
mod paths;
mod runtime;
mod services;
mod state;

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use tauri::{Manager, RunEvent, WindowEvent};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt as _};

use crate::paths::AppPaths;
use crate::services::ai_usage::UsageCache;
use crate::services::{desktop_layer, pomodoro, settings, shortcuts, tray, window};
use crate::state::{lock, AiState, AppState};

pub use services::ai_usage::claude_statusline::run_bridge as run_claude_statusline_bridge;

const AUTOSTART_ARG: &str = "--autostart";

pub fn run() {
    let allow_demo = cfg!(debug_assertions);

    let app = tauri::Builder::default()
        // Must be first: a second launch focuses the running instance instead.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| window::show(app)))
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                .max_file_size(512 * 1024)
                .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepOne)
                .build(),
        )
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, Some(vec![AUTOSTART_ARG])))
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .setup(move |app| {
            let dir = app.path().app_config_dir()?;
            let paths = AppPaths::new(dir);
            let loaded = settings::load(&paths.settings(), allow_demo);
            let timer = pomodoro::load(&paths.pomodoro(), &loaded.settings.focus);
            let cache = UsageCache::load(&paths.ai_cache());
            let (shutdown, _) = tokio::sync::watch::channel(false);
            let s = loaded.settings.clone();
            app.manage(AppState {
                paths,
                allow_demo,
                settings: std::sync::RwLock::new(loaded.settings),
                settings_notice: Mutex::new(loaded.notice),
                pomodoro: Mutex::new(timer),
                system: Mutex::new(None),
                ai: Mutex::new(AiState { cache, last: Vec::new() }),
                shutdown,
                ai_wake: tokio::sync::Notify::new(),
                placement_dirty: AtomicBool::new(false),
                quitting: AtomicBool::new(false),
                display_fallback: AtomicBool::new(false),
                display_notice: Mutex::new(None),
                panel_view: Mutex::new("settings".into()),
                shortcut_status: Mutex::new(BTreeMap::new()),
                top_suppressed: AtomicBool::new(false),
                desktop_color: Mutex::new(desktop_layer::desktop_solid_color()),
                display_count: std::sync::atomic::AtomicUsize::new(0),
            });

            // Keep the OS autostart entry in line with the saved preference.
            let al = app.autolaunch();
            if al.is_enabled().unwrap_or(false) != s.window.launch_on_startup {
                let r = if s.window.launch_on_startup { al.enable() } else { al.disable() };
                if let Err(e) = r {
                    log::warn!("could not sync launch-on-startup: {e}");
                }
            }

            shortcuts::register(app.handle(), &s.shortcuts);

            if let Some(w) = app.get_webview_window(window::MAIN) {
                // No taskbar button, no Alt+Tab entry, and the desktop-layer hooks. Must run
                // before the first show; setup runs on the UI thread.
                desktop_layer::install(&w, true);
                let state = app.state::<AppState>();
                commands::apply_window(app.handle(), &state, &s.window);
                if !s.window.start_hidden {
                    let _ = w.show();
                    desktop_layer::apply_layer(&w, s.window.layer);
                }
            }
            window::create_panel(app.handle())?;

            let handles = tray::build(app.handle())?;
            app.manage(handles);
            tray::sync(app.handle());

            let workers = runtime::start(app.handle());
            app.manage(Mutex::new(workers));
            Ok(())
        })
        .on_window_event(|w, event| {
            let app = w.app_handle();
            let state = app.state::<AppState>();
            match event {
                WindowEvent::CloseRequested { api, .. } => {
                    if state.quitting.load(Ordering::SeqCst) {
                        return;
                    }
                    if w.label() == window::PANEL {
                        // The panel is reused; never destroy it.
                        api.prevent_close();
                        window::close_panel(app);
                    } else if state.settings().window.close_to_tray {
                        api.prevent_close();
                        window::hide(app);
                        tray::sync(app);
                    }
                }
                WindowEvent::Moved(_) | WindowEvent::Resized(_) if w.label() == window::MAIN => {
                    if let Some(ww) = app.get_webview_window(window::MAIN) {
                        window::capture_placement(&ww, &state);
                    }
                }
                _ => {}
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_bootstrap,
            commands::update_settings,
            commands::restore_default_settings,
            commands::pomodoro_command,
            commands::refresh_ai,
            commands::set_manual_usage,
            commands::clear_manual_usage,
            commands::window_command,
            commands::open_panel,
            commands::close_panel,
            commands::apply_region,
            commands::reset_layout,
            commands::activate_profile,
            commands::create_profile,
            commands::rename_profile,
            commands::delete_profile,
            commands::reset_profile,
        ])
        .build(tauri::generate_context!())
        .expect("failed to build FLIP");

    app.run(|app, event| match event {
        RunEvent::ExitRequested { code, api, .. } => {
            // Closing the last window must not exit while FLIP lives in the tray.
            let state = app.state::<AppState>();
            if code.is_none() && !state.quitting.load(Ordering::SeqCst) {
                api.prevent_exit();
            }
        }
        RunEvent::Exit => {
            let state = app.state::<AppState>();
            state.begin_shutdown();
            desktop_layer::stop();
            runtime::persist_on_exit(app);
            if let Some(w) = app.try_state::<Mutex<runtime::Workers>>() {
                lock(&w).stop();
            }
            log::info!("FLIP exited cleanly");
        }
        _ => {}
    });
}
