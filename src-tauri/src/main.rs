// Hide the console window in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // `flip.exe --claude-statusline` is the Claude Code status-line bridge: it reads stdin,
    // stores the rate limits, prints one line and exits without starting the UI.
    if std::env::args().nth(1).as_deref() == Some("--claude-statusline") {
        std::process::exit(flip_lib::run_claude_statusline_bridge());
    }
    flip_lib::run();
}
