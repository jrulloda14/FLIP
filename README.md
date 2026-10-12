# FLIP

A desktop-embedded airport-board dashboard for Windows. It shows a dot-matrix clock, AI subscription usage, world clocks, a Pomodoro timer and a live system monitor on one continuous black display.

FLIP is not a normal app window. It has no title bar or border in any mode, no taskbar button and no Alt+Tab entry, and by default it sits **on the desktop layer**: under your applications, above the wallpaper, and still visible when you press Win+D. It works as a full-screen ambient board on a second monitor, or as a region of your main monitor that coexists with your apps.

Built with **Tauri 2** (Rust backend, WebView2), **React 19 + TypeScript** and **Vite**. The front end reuses the design system in `design/` (tokens, `flip.css`, dot-matrix primitives, JetBrains Mono).

---

## Download

Grab `FLIP_<version>_x64-setup.exe` from the [Releases](../../releases) page and run it. It installs for the current user only, with no admin rights, and includes an uninstaller. Windows 10 and 11, x64.

Windows SmartScreen may warn on first run because the installer is not code-signed. Choose **More info › Run anyway**, or build from source (below). Each release lists the installer's SHA-256 so you can check what you downloaded:

```powershell
Get-FileHash .\FLIP_0.1.0_x64-setup.exe -Algorithm SHA256
```

## Privacy

Everything FLIP does happens on your PC.

- **No accounts, no telemetry, no analytics, no update checks, no network requests.** The app contains no HTTP client, and its content security policy only allows Tauri's local IPC channel.
- **The one exception is installation:** on Windows 10 machines that lack Microsoft's WebView2 runtime, the installer downloads it from Microsoft. Windows 11 already includes it.
- **What it stores, all in your user profile:**

  | Location | Content |
  |---|---|
  | `%APPDATA%\com.flip.dashboard\` | `settings.json`, Pomodoro history, the last AI usage readings, the Claude status-line capture |
  | `%LOCALAPPDATA%\com.flip.dashboard\` | A small rotating log (`logs\FLIP.log`) and the WebView2 cache |
  | `HKCU\…\CurrentVersion\Run` | Only if you turn on *Launch on startup* |

- **What it reads:** CPU, memory, disk, network and GPU counters via Windows APIs; the Windows time zone and display layout; the desktop colour. It also reads Claude Code's status-line input and, if you opt in, Codex CLI session logs under `%USERPROFILE%\.codex`. Nothing is copied anywhere else.
- **No credentials** are requested or stored.
- **To remove everything,** uninstall FLIP (tick *delete app data*), or delete the two folders above.

## Status

| Area | State |
|---|---|
| Clock, date, ISO week, UTC offset | Working. 12/24h, optional seconds, colon blink, round/square dots. |
| World clock | Working. IANA zones via `chrono-tz`, DST-correct, add/remove/reorder up to 8 cities, day-shift marker. |
| Pomodoro | Working. Deadline-based, survives sleep and restarts, short/long breaks, auto-start, notifications, daily count and total focus time. |
| System monitor | Working. CPU (total, per-core, 60s history), RAM, disks, network rates, process count, top processes, uptime. GPU load via Windows PDH. GPU temperature on NVIDIA only. CPU temperature always shows N/A (see Limitations). |
| AI usage | Real data from Claude Code's status line and, as an opt-in experiment, Codex CLI local logs. Manual entry for both. With no source set up, the rows say NOT CONNECTED. No percentage is ever invented. |
| Desktop embedding | Working. Borderless tool window with three layers: **on desktop** (default; pinned under all apps, raised above the desktop on Show Desktop), **normal**, and **always on top** (steps aside while a fullscreen game or presentation runs). |
| Display modes | **Ambient** (fills the chosen display's work area), **Windowed** (movable, resizable region; default on a single monitor) and **Compact** (small board: clock, AI, focus first). On first run with two monitors, FLIP starts ambient on the secondary one. |
| Placement | Display picker, 8 region presets (full, halves, quarters, centre), drag by the top strip, resize from the edges. Each mode keeps its own position, and FLIP falls back to the primary monitor (and moves back) when the chosen display is unplugged (and replugged). |
| Layout | Presets: balanced, clock-focused, AI-focused, system-focused. Module visibility and order. Background opacity 40–100% with fully opaque text. |
| Controls | Hover-revealed controls, a separate settings/detail panel window, four editable system-wide shortcuts, a tray menu, "reset layout & position", and "restore all defaults" (asks for confirmation). Launch on startup and start hidden. Single instance. |
| Windows installer | NSIS (per-user), `npm run tauri:build`. |

## Quick start

Prerequisites (Windows 10/11 x64):

- Node.js 20+ (tested with 24)
- Rust stable (tested with 1.99) through rustup, MSVC toolchain
- Visual Studio 2022 Build Tools with the **Desktop development with C++** workload
- WebView2 Runtime (built into Windows 11; the installer downloads it on Windows 10 if missing)

```bash
npm install
```

```bash
npm run tauri:dev
```

| Task | Command |
|---|---|
| Run the desktop app in development (hot reload) | `npm run tauri:dev` |
| Front end only, in a browser with mocked data | `npm run dev`, then open `http://localhost:1420/preview.html`. Parameters: `?focus&ai` for active states, `preset=clock\|ai\|system`, `mode=compact`, `bg=0.6`, `panel=settings:DISPLAY` for the panel window. |
| Front-end tests | `npm test` |
| Type check, lint and tests | `npm run check` |
| Rust tests | `cd src-tauri && cargo test` |
| Rust lint and format | `cd src-tauri && cargo clippy --all-targets -- -D warnings && cargo fmt --check` |
| Release build and installer (for publishing) | `npm run release`. Strips local build paths from the binary, checks for leftovers, and prints the installer's SHA-256 |
| Plain release build (for yourself) | `npm run tauri:build` |

The installer is written to `src-tauri/target/release/bundle/nsis/FLIP_<version>_x64-setup.exe`. It installs per user, needs no admin rights, and adds a Start-menu entry and an uninstaller.

No environment variables are required. FLIP reads `CODEX_HOME` only if you enable the Codex local-log source, and only to find Codex's own folder, so there is no `.env.example`.

## Using FLIP

- **Hover** over the top strip to reveal the controls: layer (ON DESKTOP / ON TOP / NORMAL), SETTINGS, COMPACT, hide (—) and ✕. They fade after 3 s, which you can change.
- **Click** the clock for clock settings, an AI row for provider detail, any system row for system detail, and the focus block for timer controls. These open in a separate panel window, so they are never trapped under other apps.
- **Move and resize** in Windowed or Compact mode: drag the top strip and resize from the edges, or pick a region under Settings › Display. Ambient mode is fixed to the display.
- **System-wide shortcuts** work even while FLIP is behind other windows, and you can change them under Settings › Keys:

  | Default | Action |
  |---|---|
  | `Ctrl+Alt+F` | Show / hide |
  | `Ctrl+Alt+S` | Settings |
  | `Ctrl+Alt+L` | Next layout preset |
  | `Ctrl+Alt+P` | Start / pause focus |

- **Keys when FLIP has focus:** `Space` start/pause · `R` reset · `S` skip · `+` add 5 min · `P` timer · `,` settings · `C` compact · `M` next display mode · `L` next layout preset · `T` next layer · `H` hide · `Ctrl+Q` quit.
- **Tray:** left-click shows or hides FLIP. Right-click offers focus controls, ambient/windowed/compact, keep on top, next layout, settings, **reset layout and position**, and **Quit**.
- The ✕ control hides FLIP by default (Settings › Display). **Quit** is always in the tray menu.

## AI usage: sources and prerequisites

Subscription quotas are **not** the same as API usage. Neither Anthropic's nor OpenAI's public API reports consumer-plan limits (Claude Pro/Max 5-hour and weekly windows, ChatGPT-plan Codex limits). An API key reports API billing only. For that reason FLIP does not ask for API keys, passwords or tokens, stores no credentials, and makes **no network requests**.

| Provider | Source | Confidence | Prerequisites | Limitations |
|---|---|---|---|---|
| Claude | **Claude Code status line** | High: Claude Code documents the `rate_limits` field in its status-line input | Claude Code on a Pro/Max plan. Add the snippet from Settings › AI to `%USERPROFILE%\.claude\settings.json`. | Updates only while Claude Code is running and redrawing its status line. The field appears after the first reply in a session. It replaces any status line you already use. Readings older than 15 min show **STALE**, and a window whose reset time has passed shows `--%` until new data arrives. |
| Codex | **Codex CLI local logs** (opt-in) | Low: undocumented format | Codex CLI signed in with a ChatGPT plan. Sessions under `%USERPROFILE%\.codex\sessions` (or `CODEX_HOME`). | Reads `rate_limits` from `token_count` events. The format can change without notice. Data is only as fresh as your last Codex session. |
| Either | **Manual entry** | User provided | Copy the values from the provider's usage page. | Labeled MANUAL, shows when it was entered, and goes stale after 12 h. |
| Either | **Demo** | Demo | Debug builds only | Every row is tagged DEMO. Release builds cannot turn it on. |

How the Claude bridge works: Claude Code runs `"…\flip.exe" --claude-statusline`, passing the status-line JSON on stdin. FLIP keeps **only** the two percentages and reset times. It discards everything else (paths, session IDs, model, cost), writes the result to `%APPDATA%\com.flip.dashboard\claude-statusline.json`, prints a one-line status such as `5H 24% · 7D 41%` back to Claude Code, and exits without opening a window.

The last good reading per source is cached in `ai-cache.json`. When a refresh fails, the row keeps showing the cached values marked STALE, along with the error. Retries back off 30s → 2m → 5m → 15m.

To add a provider later, implement `UsageProvider` in `src-tauri/src/services/ai_usage/` and add it to `providers_for`.

## Architecture

```
src/                         React UI
  components/                DigitalClock, DateDisplay, AIUsageTable, WorldClockTable, SystemMonitor,
                             PomodoroPanel, StatusBar, StatusIndicator, primitives (DotMatrix, DotMeter, DotPlot, FlipText)
  overlays/                  SettingsWindow, ProviderDetail, SystemDetail, TimerPopover (rendered in the panel window)
  lib/                       types.ts (mirrors Rust models), ipc.ts (only file that calls Tauri), store.tsx, format.ts, layout.ts
  styles/                    tokens.css + flip.css (from design/), app.css (layouts)
  preview.tsx                dev-only browser preview with mocked IPC
src-tauri/src/
  main.rs                    entry point; `--claude-statusline` bridge mode
  lib.rs                     plugin wiring, setup, window events, shutdown
  commands.rs                IPC commands (validated inputs)
  runtime.rs                 background loops: clock + Pomodoro tick, system sampler thread, AI refresher
  state.rs, paths.rs, error.rs
  services/
    settings.rs              schema, defaults, validation, v0→v1 migration, corrupt-file recovery
    world_clock.rs           home time, city times, DIFF labels, zone list
    pomodoro.rs              deadline-based state machine + history
    system_monitor.rs        sysinfo sampling and normalization
    gpu.rs                   PDH GPU Engine counters, DXGI adapter name, NVML temperature
    ai_usage/                provider trait, cache/backoff, claude_statusline, codex_logs, manual, demo
    desktop_layer.rs         Win32: tool-window style, bottom-of-stack pinning (window subclass),
                             Show Desktop handling (foreground event hook), fullscreen-app detection
    window.rs                displays, display modes, region presets, saved rectangles, fallback, panel window
    shortcuts.rs             system-wide shortcuts
    tray.rs                  tray menu
src-tauri/capabilities/default.json   least-privilege permissions
```

Data flow: the backend pushes events (`flip://clock` every wall-clock second, `flip://system` every sample, `flip://pomodoro`, `flip://ai`, `flip://settings`, `flip://status` for displays and shortcut status, and `flip://panel` for the panel view). The front end subscribes once in `store.tsx` and runs no timers of its own for live data. Commands such as `update_settings` and `pomodoro_command` return the validated state, and the backend broadcasts it.

Persistence, all in `%APPDATA%\com.flip.dashboard\`:

| File | Content |
|---|---|
| `settings.json` | Preferences and window placement. Written atomically. A corrupt file is renamed `settings.corrupt-<time>.json` and defaults are used. |
| `pomodoro.json` | Timer state (including a running deadline) and 120 days of daily history. |
| `ai-cache.json` | Last successful reading per AI source. |
| `claude-statusline.json` | Written by the bridge. |

Logs go to `%LOCALAPPDATA%\com.flip.dashboard\logs\FLIP.log` (512 KB, one rotation). Logs contain no credentials, usage values or file contents.

There is no database: settings, timer history and the AI cache are small documents, and nothing queries them.

## Security

- The dashboard and panel windows get only `core:event` listen/unlisten, `core:window:allow-start-dragging` (for dragging the borderless windows) and FLIP's twelve commands, each allow-listed through `build.rs`. There is no filesystem, shell, HTTP, opener or clipboard-plugin permission. Panel views and region names are allow-listed.
- Desktop embedding uses documented Win32 calls on FLIP's own windows only (`SetWindowPos`, `SetWindowSubclass`, `SetWinEventHook` with `WINEVENT_OUTOFCONTEXT`, `SHQueryUserNotificationState`). Nothing is injected into Explorer, and FLIP is not reparented into the desktop.
- Commands validate every input. City count, label lengths, time zones, percentages and window keys are all checked, and window placement is backend-owned. Provider IDs are allow-listed.
- CSP: `default-src 'self'`, no remote scripts, `connect-src` limited to Tauri IPC.
- The only files FLIP reads outside its own data directory are Codex session logs, and only when you enable that source.

## Limitations

- **CPU temperature is always N/A.** Windows has no documented, unelevated API for CPU die temperature. The WMI ACPI thermal zone needs admin rights and is not the CPU temperature, and vendor sensor drivers (e.g. LibreHardwareMonitor's kernel driver) need elevation. FLIP shows N/A and explains why in the System detail view.
- **GPU temperature** needs NVIDIA's `nvml.dll` (installed with NVIDIA drivers). AMD and Intel GPUs show N/A.
- **GPU load** needs WDDM 2.0+ drivers. The first sample is N/A because rates need two readings.
- **AI usage** is only as fresh as the source. See the table above.
- **Desktop layer, not wallpaper layer.** FLIP stays under your apps and stays clickable. It is not drawn behind the desktop icons the way Wallpaper Engine does it: that needs undocumented Explorer internals, and it would block hover and clicks. So in Ambient mode on your *main* monitor, FLIP covers the desktop icons. Use Windowed or Compact with a region there.
- **Show Desktop (Win+D):** FLIP lifts itself above the desktop when the desktop takes the foreground, and drops back when you switch to an app. This was verified with unit tests of the decision logic and a live check of the window's style and position in the stack. The Win+D keypress itself was not exercised end to end in the build environment.
- **Virtual desktops:** FLIP stays on the virtual desktop where it was started. Showing it on every virtual desktop would need an undocumented Windows interface.
- **Opacity:** a see-through background is supported, not a see-through window. At low opacity, unlit "ghost" dots can look muddy over bright wallpapers; turn them off under Settings › Clock.
- **Placement** is stored in physical pixels per mode. If the chosen display disappears, FLIP shows on the primary monitor within 5 s and returns when the display does.
- **Not built yet:** click-through, pixel shift, night dimming, the 24-hour AI usage history chart, drag-and-drop ordering (↑/↓ buttons instead) and the tray flyout window (a native menu instead).
- **Memory:** the Rust process uses about 35 MB and under 1% of a core. WebView2 helper processes add roughly 150–350 MB of working set depending on GPU and driver, so the 120 MB target in `docs/HANDOFF.md` is not met.
- Development builds show notifications under PowerShell's name. The installed build uses FLIP's identity.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `link.exe not found` / MSVC errors during build | Install VS 2022 Build Tools with the C++ workload, then open a new terminal. |
| FLIP doesn't appear | It may be hidden (Start hidden, ✕ or H). Click the tray icon or press `Ctrl+Alt+F`. In the ON DESKTOP layer it is *under* your apps: minimise them or press Win+D. |
| FLIP is in the wrong place or the wrong size | Tray › **Reset layout and position**, or Settings › Display › Recovery. |
| Can't find FLIP in Alt+Tab or the taskbar | By design. Use the tray icon or `Ctrl+Alt+F`. |
| Claude row says WAITING FOR CLAUDE CODE | Check the `statusLine` snippet in `%USERPROFILE%\.claude\settings.json` points to the current `flip.exe` path (it changes between dev and installed builds), and that you're on a Pro/Max plan with at least one reply in the session. |
| Codex row says NO RATE-LIMIT DATA | Run a Codex CLI session signed in with a ChatGPT plan. If Codex has changed its log format, use Manual. |
| A shortcut does nothing | Another app owns it. Settings › Keys marks it IN USE BY ANOTHER APP; pick a different one. |
| Settings reset unexpectedly | The file was unreadable. Look for `settings.corrupt-*.json` next to it. Older (v1) files are migrated automatically. |
| Blank window | WebView2 Runtime is missing or broken. Reinstall it from Microsoft. |

## Publishing a release

1. Run `npm run check` and `cd src-tauri && cargo test`.
2. Run `npm run release`. Rust normally embeds absolute source paths, including your Windows user profile, in the binary. The script remaps them and **fails if your user name, profile path or project path is still inside `flip.exe`**.
3. Upload `src-tauri/target/release/bundle/nsis/FLIP_<version>_x64-setup.exe` to a GitHub release and paste the SHA-256 it printed into the release notes.

Never publish a build from plain `npm run tauri:build`; it keeps those local paths.

## License

[MIT](LICENSE) © FLIP contributors. Free to use, modify and redistribute.

Bundled third-party assets: JetBrains Mono ([SIL Open Font License 1.1](src/fonts/OFL.txt)). Rust and npm dependencies keep their own licences (MIT / Apache-2.0 and compatible).

Claude and Codex are trademarks of their respective owners. FLIP is an independent project, not affiliated with or endorsed by Anthropic or OpenAI.

## Design assets

The original design package is kept unchanged:

- `prototype/FLIP-prototype.html`: interactive single-file prototype. Its sample values are illustrative.
- `design/screens/`: 1920×1080 renders of the 11 screens.
- `design/tokens/`, `design/components/`, `design/fonts/`: tokens, component CSS and JS, JetBrains Mono (SIL OFL 1.1).
- `docs/HANDOFF.md`: developer handoff (component hierarchy, states, shortcuts, Windows notes).
