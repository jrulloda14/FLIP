# FLIP — Developer Handoff

FLIP is a Windows desktop clock and productivity display, styled like an airport departure board and a monochrome terminal. It is meant to sit on a second monitor all day.

This document covers what the prototype (`prototype/FLIP-prototype.html`) shows: the component tree, tokens, states, responsive behavior, interactions and the platform notes needed to build it for real.

---

## 1. Files

| Path | What |
|---|---|
| `prototype/FLIP-prototype.html` | Single-file, offline, interactive prototype. 11 screens, live clock, working settings. Open it in Edge or Chrome. |
| `prototype/src/` | Source for the prototype: `app.js` (state, renderer, scenes), `app.css` (layouts), `build.py` (assembles the HTML). |
| `design/tokens/tokens.json` | Design tokens. **This is the source of truth.** |
| `design/tokens/tokens.css` | The same tokens compiled to CSS custom properties. |
| `design/components/flip.css` | Component styles (`fl-*` classes). Sizes are expressed as `calc(var(--u) * Npx)`. |
| `design/components/flip.js` | Rendering primitives: `dotMatrix`, `flipText`, `meter`, `dotPlot`. No dependencies. |
| `design/fonts/` | JetBrains Mono 400/500 (SIL OFL 1.1, licence included). |
| `design/screens/*.png` | 1920×1080 renders of every screen, frozen at the brief's sample time (12:43, Tue 06 Oct, home zone Singapore). |

Prototype controls: the top bar switches screens (`[` and `]` also work). **LIVE TIME / SPEC TIME** freezes the clock at 12:43 Singapore, the brief's sample values. Digits and brackets only navigate the prototype; the real app doesn't use them.

---

## 2. Design principles

1. **One continuous display.** The black background never breaks into cards. Grouping comes from alignment, type size and 1px hairlines.
2. **The right side leads.** The clock, AI usage and world clock use `ink` at 26–30px. The left panel uses `ink-1`/`ink-2` at 13–16px and must always read as secondary.
3. **Monochrome by default, amber means something.** `amber` is used only for: usage ≥ the warn threshold, provider errors, and sensor faults. No other colour exists.
4. **Columns align exactly.** All numerals are tabular. Every table has fixed column widths, so values never shift sideways when they change.
5. **Motion is mechanical and brief.** Changed characters do a split-flap scramble (~250ms). Clock dots fade at a 9ms per-column stagger. With `prefers-reduced-motion`, both are instant.

---

## 3. Tokens (summary)

All tokens are in `design/tokens/tokens.json`. CSS names are `--<token>`.

**Colour**

| Token | Value | Use |
|---|---|---|
| `bg` | `#050505` | The display |
| `bg-raised` | `#0b0b0b` | Overlays only (settings, details, menus) |
| `ink` | `#f2f2f2` | Primary text, lit dots (18.2:1) |
| `ink-1` | `#c8c8c8` | Values in the left panel (12.2:1) |
| `ink-2` | `#929292` | Labels, headers (6.6:1) |
| `ink-3` | `#7a7a7a` | Status bar, hints. The lowest contrast allowed for text (4.75:1) |
| `rule` / `rule-strong` | `#292929` / `#5e5e5e` | Hairlines / control and overlay borders |
| `meter-off` | `#333333` | Unlit meter dots |
| `matrix-ghost` | `#0f0f0f` | Unlit clock dots (optional "ghost dots") |
| `amber` / `amber-dim` | `#d9a441` / `#6b5226` | Warning lit / unlit |

**Type.** One family: JetBrains Mono (fallbacks: IBM Plex Mono, Cascadia Mono, Consolas). Always uppercase, with `font-variant-numeric: tabular-nums`.

| Style | Size / line height (1080p) | Use |
|---|---|---|
| `t-date` | 30 / 36, 500, +0.06em | Date under the clock |
| `t-board` | 26 / 36, 500 | AI rows, world-clock rows |
| `t-board-head` | 26 / 36, 400, `ink-2` | Table header |
| `t-countdown` | 34 / 40 | Idle Pomodoro time |
| `t-metric` | 16 / 24 | Left panel rows |
| `t-section` | 13 / 18, +0.14em, `ink-3` | Section headings |
| `t-status` | 13 / 20, +0.10em | Status bar |
| `t-control` | 15 / 22 | Settings, menus, buttons |
| `t-micro` | 12 / 16 | Hints. Never smaller than this |

**Dot matrix.** Glyphs are 5×7 dots with one empty column between glyphs; the colon is one column wide. Dot diameter is 72% of the pitch. Pitch: 28px for the main clock, 14px for the focus countdown, 17px compact, 10px mini.

**Spacing** follows a 4px grid: 4 / 8 / 12 / 16 / 24 / 32 / 56 / 72. **Radius** is 0 everywhere, except 2px on the tray menu and 8px on the outer corner of a windowed-mode window (Windows 11).

---

## 4. Scaling model

Every size is written in 1080p design pixels and multiplied by `--u`. The app computes `--u` from the window's client size, not from DPI:

```
layout = pick(w, h)          // see §6
[bw, bh] = BASE[layout]      // full 1920×1080, compact 1280×720, mini 600×260
u = clamp(0.36, min(w / bw, h / bh), 1.5)
```

At 2560×1440, `u = 1.333`: the clock is 261px tall and table text is 35px. Text stays sharp because nothing is bitmap-scaled.

---

## 5. Component hierarchy

```
App
├─ TrayIcon ─ TrayFlyout (left-click) · TrayMenu (right-click)
└─ FlipWindow                      borderless or windowed; owns --u and layout
   ├─ TitleBar                     windowed mode only: FLIP · LAYOUT · W×H, PIN – ▢ ✕
   └─ Dashboard [data-layout = full | compact | mini]
      ├─ StatusBar
      │  ├─ Wordmark · ContextLabel        "DISPLAY 2 · 2560×1440", or "● FOCUS 18:42" while running
      │  ├─ Indicator(SYS) · Indicator(AI)  LED + text; AI LED pulses while syncing, amber on error
      │  └─ Controls: PIN · SETTINGS · COMPACT/EXPAND · — · ✕   (fade out after N seconds idle)
      ├─ LeftPanel (full layout only)
      │  ├─ SystemBlock
      │  │  ├─ SectionHeader("SYSTEM", hostname)
      │  │  ├─ MetricRow ×n   [label | DotMeter or DotPlot | value | sub-value]
      │  │  └─ MetaLine       uptime · process count
      │  ├─ FocusBlock (Pomodoro)
      │  │  ├─ SectionHeader("FOCUS · POMODORO", "SESSION 2 / 4")
      │  │  ├─ Phase · Countdown (text when idle → DotMatrix when active)
      │  │  ├─ SessionDots · EndsAt
      │  │  ├─ DotMeter (square cells, one per minute)
      │  │  └─ KeyHint
      │  └─ ShortcutHints
      ├─ MainDisplay
      │  ├─ ClockBlock     DotMatrix(hh:mm) [+ DotMatrix(ss)] [+ AM/PM]
      │  ├─ SideBlock
      │  │  ├─ DateLine    [WK nn · UTC±h] DATE
      │  │  ├─ FocusLine   only while a phase is active
      │  │  └─ UsageGrid
      │  │     └─ UsageRow ×providers → Name + UsageSlot ×windowKeys (value + DotMeter)
      │  └─ Board (world clock) → BoardHeader + BoardRow ×cities
      ├─ CompactStrip (compact only)
      └─ Overlay (one at a time)
         ├─ SettingsSheet → Tabs → SettingRow(label | control | hint)
         ├─ ProviderDetail
         ├─ SystemDetail
         └─ TimerPopover
```

**Primitives** (in `flip.js`): `dotMatrix(el, text, {pitch, ghost, shape})`, `flipText(el, text)`, `meter(el, value, {cells, warnAt, loading})`, `dotPlot(el, values, {rows, pitch})`.

### UsageGrid alignment rule
The grid's columns are the union of window keys across all **healthy** providers, in the order they first appear (e.g. `5H`, `7D`). A provider without a given key leaves that cell empty. That is why `CODEX 7D 100%` sits under `CLAUDE 7D 24%`. Rows in loading, unavailable or error state span all the metric columns instead.

---

## 6. Layouts and responsive behavior

| Layout | Chosen when (AUTO) | What changes |
|---|---|---|
| **FULL** | client ≥ 1150 × 620 | Two columns, left 37% / right 63%, 80px gutter. Clock is right-aligned at top, with date, AI rows and board below. |
| **COMPACT** | ≥ 600 × 300 | One column. Clock top-left, date and AI rows top-right. The board becomes a 5-column strip (CODE / TIME / DIFF / city). The whole left panel collapses into one **CompactStrip** line. |
| **MINI** | smaller | Clock and date on row 1, AI rows on row 2. Status bar and controls appear only on hover. Used for the always-on-top widget and the tray flyout. |

The user can force a layout under Settings › Modules › Layout. `C` toggles between compact and auto.

**While focus is active (FULL):** the Focus block moves to the top of the left panel and its countdown switches to the dot matrix. The System block drops its optional rows (load plot, disks, uptime). A FocusLine appears under the date, and the status bar shows `● FOCUS mm:ss`.

**Planned for later:** modules carry an `order` and a `visible` flag. v1 supports visibility only; drag-to-rearrange is reserved for a later release.

---

## 7. States

### AI provider row
| State | Rendering |
|---|---|
| `ok` | `NAME  5H 71%  7D 24%`, each with a 22-dot meter underneath. The meter turns amber at or above the warn threshold (default 90%). Text stays white. |
| `loading` | `SYNCING` in `ink-2`, and the meter runs a scanning dot (1.3s loop). The status LED pulses. |
| `unavailable` | Name and `NO DATA · NOT CONNECTED` in `ink-3`. No meter. |
| `error` | `ERR · <reason>` in amber, with a micro line `RETRY IN 30S · CLICK TO RECONNECT`. The status LED turns amber and reads `AI ERR`. Retries back off 30s → 2m → 5m → 15m. |

### Pomodoro
`idle (READY 25:00)` → `focus` → `short break` ×(n−1) → `long break` → `focus`…
Paused shows `PAUSED · FOCUS`, the dot matrix dims to 45%, and the status bar shows `‖`. Session dots: `■` done, `▣` current, `□` upcoming.

### Sensors
If a temperature or GPU value is unavailable, show `N/A` in `ink-3`, never `0`. If a sensor driver fails, the SystemDetail SENSOR row turns amber.

### Interactive elements
- Hover: a 3.5% white wash (`.fl-hit`), or the text brightens to `ink`.
- Focus: a 1px dotted `ink` outline, offset 3px.
- Selected (segmented control): inverted, with `bg-invert` fill and `bg` text.
- Disabled: `ink-3`, no hover.

---

## 8. Interactions and shortcuts

| Target | Click | Opens |
|---|---|---|
| Clock | ✓ | Settings › Clock |
| AI provider name or value | ✓ | ProviderDetail: per-window big %, 48-dot meter, reset countdown, pace, projection, 24h hourly plot, source and sync info |
| Pomodoro block / FocusLine / strip | ✓ | TimerPopover: start/pause, reset, skip, +5 min, block length |
| Any system row | ✓ | SystemDetail: per-core meters, 60s plot, network plot, memory, GPU, disks, top processes |
| Scrim or `ESC` | | Closes the overlay |

| Key | Action |
|---|---|
| `Space` | Start / pause focus |
| `R` / `S` / `+` | Reset / skip phase / add 5 min |
| `P` | Timer controls |
| `,` | Settings |
| `C` | Toggle compact |
| `T` | Always on top |
| `F11` | Fullscreen ↔ windowed |
| `Esc` | Close overlay, then exit fullscreen |
| `Ctrl+Alt+F` | Show FLIP (global hotkey) |
| `Ctrl+M` / `Ctrl+Q` | Minimize to tray / Quit |

Window controls in fullscreen fade to 0 after 3s idle (configurable) and come back on mouse move. Exiting fullscreen goes to windowed mode, not to quitting.

---

## 9. Settings model (`%APPDATA%\FLIP\settings.json`)

```jsonc
{
  "clock":  { "h24": true, "seconds": false, "blink": false, "dateFormat": "dow", "metaLine": true,
              "dotShape": "round", "ghostDots": true, "homeTimeZone": "Asia/Singapore" },
  "cities": [ { "name": "LONDON", "code": "LHR", "tz": "Europe/London" } ],   // max 8, IANA zones
  "ai":     { "refreshMinutes": 2, "warnAt": 0.9, "notifyOnReset": false,
              "providers": [ { "id": "claude", "enabled": true, "adapter": "…" } ] },
  "focus":  { "focus": 25, "short": 5, "long": 15, "sessions": 4, "autoStart": false, "sound": "chime" },
  "modules":{ "date": true, "ai": true, "world": true, "system": true, "focus": true, "keys": true, "layout": "auto" },
  "system": { "temps": true, "gpu": true, "net": true, "disk": true, "plot": true, "sampleSeconds": 1, "tempUnit": "C" },
  "window": { "alwaysOnTop": true, "launchOnStartup": true, "startInTray": false, "mode": "fullscreen",
              "display": "\\\\.\\DISPLAY2", "fallback": "compact", "clickThrough": false,
              "hideControlsAfter": 3, "pixelShift": true, "dim": "off" }
}
```

World times must be computed from IANA zones on every tick, never stored as fixed offsets, so DST changes are handled correctly. DIFF is `offset(city) − offset(home)`, formatted as `+1H`, `-7H` or `+5H30`. The board always shows 24-hour time, even when the main clock is set to 12-hour.

---

## 10. Provider adapter contract

Every AI source sits behind one interface so new providers don't touch the UI:

```ts
interface UsageWindow { key: string; label: string; used: number /* 0..1 */; resetsAt?: string /* ISO */ }
interface UsageSnapshot { provider: string; state: 'ok'|'loading'|'unavailable'|'error';
                          windows: UsageWindow[]; error?: { code: string; message: string; retryAt?: string };
                          fetchedAt: string; source: string }
interface UsageAdapter { id: string; name: string; fetch(signal: AbortSignal): Promise<UsageSnapshot> }
```

Each provider's data source (an official usage API, an account page, or local CLI logs) must be chosen and checked against that provider's terms before implementation. The prototype's values are illustrative only. Store credentials in Windows Credential Manager, never in `settings.json`.

---

## 11. Windows implementation notes

- **Shell:** the prototype is plain HTML/CSS/JS, so a WebView2 shell (Tauri 2 or WinUI 3 + WebView2) can reuse `flip.css` and `flip.js` unchanged. A fully native WinUI build should re-implement the dot matrix as a single `Canvas`/Win2D draw rather than thousands of elements.
- **Always on top:** `SetWindowPos(HWND_TOPMOST)`. **Click-through:** `WS_EX_LAYERED | WS_EX_TRANSPARENT`, always undoable from the tray.
- **Launch on startup:** `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`, or a StartupTask for MSIX packages.
- **Tray:** `Shell_NotifyIcon`. Left-click opens the flyout (mini dashboard + focus controls); right-click opens the menu.
- **Multi-monitor:** per-monitor DPI awareness v2. Remember position per monitor configuration (key = sorted list of monitor device IDs and resolutions). Handle `WM_DISPLAYCHANGE`: if the target display disappears, apply `fallback`, and restore when it comes back.
- **Metrics:** CPU and per-core load through PDH `\Processor Information(*)\% Processor Utility`; memory through `GlobalMemoryStatusEx`; network through `GetIfTable2` deltas; disks through `GetDiskFreeSpaceEx`; GPU load through the PDH `GPU Engine` counters (NVML optional). CPU and GPU temperatures need a sensor library such as LibreHardwareMonitor, which may need elevation, so treat them as optional and show `N/A` when they're missing.
- **Do Not Disturb:** Windows has no public API to toggle it, so v1 only offers to open the setting.
- **Screen care:** pixel shift moves the content 1–2px every 10 minutes (for OLED monitors). The dim option drops `ink` to 60% while idle or during night hours.
- **Performance:** keep 1s ticks aligned to wall-clock seconds (`setTimeout(1000 - ms % 1000)`). Redraw only the elements whose values changed. Target < 1% CPU and < 120 MB RAM.

---

## 12. Screen list

| # | Screen | Shows |
|---|---|---|
| 01 | Dashboard | Main fullscreen display (brief deliverable 1) |
| 02 | Focus active | Pomodoro-active state |
| 03 | AI states | ok / loading / unavailable / error rows |
| 04 | Windowed | Resizable window with title bar; layout switches live as you resize |
| 05 | Compact + Mini | Compact variant (deliverable 2) and the always-on-top widget |
| 06 | Settings | Settings sheet, 8 tabs (deliverable 3) |
| 07 | Tray | Flyout and context menu |
| 08 | Multi-monitor | Display placement and disconnect fallback |
| 09 | AI detail | Provider drill-down |
| 10 | System detail | Monitor drill-down |
| 11 | Timer controls | Pomodoro popover |
