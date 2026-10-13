# Changelog

All notable changes to FLIP. Versions follow [Semantic Versioning](https://semver.org/).

## [0.4.0] - Unreleased (draft)

### Added

- **Timer-completion card.** When a focus session or break ends, FLIP shows its own card instead of a Windows notification: **FOCUS COMPLETE** with *Start break* / *Dismiss*, or **BREAK COMPLETE** with *Resume focus* / *Dismiss*.
  - It appears in the bottom-right corner of the dashboard's screen, above other windows, without taking keyboard focus, and never moves or resizes the dashboard.
  - Enter presses the focused button and Esc dismisses. The heading flips in board-style, with entrance and exit animations that respect Windows' *Animation effects* setting.
  - Shown once per completion. Repeated events and double clicks act once. Dismissing never changes the timer, and changing the timer elsewhere closes the card.
  - Waits while a fullscreen app or presentation runs.
- **Completion sound** (Settings › Focus): plays the Windows notification sound with the card. Off by default.
- **World clocks follow the 12/24-hour setting** and show AM/PM in 12-hour mode.
- **DAY column** in the world clock: each city's weekday and date, lit when it differs from home.
- **Buy me a coffee** button in the Settings footer. It opens `buymeacoffee.com/flipdashboard` in your browser, only when clicked.

### Fixed

- The world clock no longer runs into the bottom status strip when there are more cities than fit (e.g. the Clock preset with eight cities). Rows that don't fit are hidden whole, and the header shows how many (+2).
- Settings rows with a wide control (such as the home time zone) no longer squeeze their hint into one word per line.

### Changed

- Settings › Focus › Notifications is now *When a timer ends*: focus card, break card and sound.
- Timer completion no longer uses Windows notifications. In development builds those appeared under PowerShell's name. High CPU, memory and disk alerts still use Windows notifications.
- README: screenshots refreshed (DAY column, completion card, coffee button), and the acknowledgment now credits Aero's author, Bryl Lim, and notes Aero's CC BY 4.0 license.

## [0.3.0] - 2026-10-13

Windows power features and smart profiles.

### Added

- **Profiles.** Five built-in profiles (Developer, Ambient, Focus, Gaming, Custom) and up to 11 custom ones. A profile stores module visibility and order, layout preset and density, the clock template and its look, appearance, and the target monitor, display mode, layer, regions and window positions. Time zones, cities, AI sources, the focus timer, notifications and shortcuts stay shared.
  - Settings › Profiles: use, duplicate, create from the current layout, rename and delete custom profiles, reset built-in ones.
  - Switch from the tray's new **Profile** submenu, the new `Ctrl+Alt+N` system-wide shortcut, `N` while FLIP has focus, or Settings.
  - The active profile is restored at startup, and the status strip shows its name.
  - Profile switches move and restyle the dashboard without taking focus.
- **Optional profile auto-switch** when the number of connected displays changes while FLIP is running (one display vs two or more). Off by default.
- **Stable monitor identity.** FLIP stores each monitor's Windows device-interface ID and matches it before the `\\.\DISPLAYn` name, so renumbered displays don't move FLIP to the wrong screen. A missing monitor is reported as not connected and FLIP uses the primary monitor until it returns.
- **Disk activity:** total and per-drive read/write throughput with a 60-sample plot.
- **GPU memory:** dedicated memory for discrete GPUs, shared memory for integrated GPUs.
- **Available memory** in the System detail view.
- **N/A vs ERR:** unavailable metrics show N/A; readings that failed and will be retried show an amber ERR. The System detail view lists both groups with reasons.
- **Opt-in alerts** for sustained high CPU, high memory and low disk space, with thresholds and a per-alert cooldown. Notifications only; FLIP never acts on the system.
- Tray: **Move to primary display**.

### Changed

- Settings schema v5. Settings from 0.1.0 and 0.2.0 are migrated automatically; your existing layout becomes the **Custom** profile and stays active.
- The display picker saves the monitor's stable ID as well as its device name.
- The README was rewritten, and its images moved to `docs/assets/`.

### Fixed

- A window placement saved by hand is now also stored in the active profile.

## [0.2.0] - 2026-10-12

### Added

- **Clock Studio** (Settings › Clock): Split Flap, Dot Matrix, Seven Segment, Terminal and Minimal templates; size, digit spacing, digit colour, colon blink; animation on/off at 250, 320 or 400 ms (respects Windows' *Animation effects*); split-flap seam, shadow and panel colour; live preview and a labeled rollover demo.
- The Pomodoro countdown matches the clock style.
- **Offline installer** that includes Microsoft's WebView2 installer.

### Changed

- New-install defaults: On Desktop layer, Windowed in the right half, Balanced preset, Full density, Split Flap clock. Earlier installs keep the dot-matrix clock.
- The selected region is highlighted in Settings › Display and clears after a manual move or resize.
- The date format has its own settings row.

### Fixed

- Layout presets and density in Compact mode and narrow windows.
- Text legibility on translucent backgrounds.

## [0.1.0] - 2026-10-12

First public release.

- Desktop-embedded, borderless airport-board dashboard for Windows: on-desktop (visible on Win+D), normal and always-on-top layers; no taskbar button or Alt+Tab entry.
- Ambient, Windowed and Compact display modes; display picker; region presets; per-mode positions; fallback to the primary monitor when a display is disconnected.
- Dot-matrix clock, date, ISO week and UTC offset; world clocks with IANA time zones.
- Deadline-based Pomodoro timer with notifications and daily history.
- System monitor: CPU (total, per core, history), RAM, disks, network, GPU load, NVIDIA GPU temperature, uptime, processes. Unavailable values show N/A.
- AI usage from Claude Code's status line, Codex CLI local logs (experimental) or manual entry; no credentials, no network requests.
- Tray menu, editable system-wide shortcuts, settings panel, launch on startup.
- Per-user NSIS installer; no administrator rights.

[0.4.0]: https://github.com/jrulloda14/FLIP/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/jrulloda14/FLIP/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/jrulloda14/FLIP/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/jrulloda14/FLIP/releases/tag/v0.1.0
