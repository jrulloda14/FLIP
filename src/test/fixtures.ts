import type { Bootstrap, PomodoroView, Settings, SystemSnapshot, UsageSnapshot } from '../lib/types';

export const settings = (): Settings => ({
  version: 1,
  clock: { h24: true, seconds: false, blink: false, dateFormat: 'dow', metaLine: true, dotShape: 'round', ghostDots: true, homeTimeZone: 'Asia/Singapore' },
  appearance: { background: 'desktop', font: 'jetbrains', textScale: 1, contrast: 'standard', backgroundOpacity: 1 },
  cities: [
    { name: 'LONDON', code: 'LHR', tz: 'Europe/London' },
    { name: 'TOKYO', code: 'HND', tz: 'Asia/Tokyo' },
  ],
  ai: { refreshMinutes: 2, warnAt: 0.9, claude: { source: 'off' }, codex: { source: 'off', codexHome: null }, manual: {}, demo: false },
  focus: { focusMinutes: 25, shortMinutes: 5, longMinutes: 15, sessions: 4, autoStart: false },
  modules: { date: true, ai: true, world: true, system: true, focus: true, keys: true, layout: 'auto', preset: 'balanced', order: ['ai', 'world', 'system', 'focus'] },
  system: { temps: true, gpu: true, net: true, disk: true, plot: true, sampleSeconds: 1, tempUnit: 'C' },
  window: { mode: 'windowed', layer: 'desktop', display: null, launchOnStartup: false, startHidden: false, closeToTray: true, hideControlsAfter: 3, windowedRect: null, compactRect: null },
  shortcuts: { toggle: 'Ctrl+Alt+F', settings: 'Ctrl+Alt+S', layout: 'Ctrl+Alt+L', focus: 'Ctrl+Alt+P' },
  notifications: { focusComplete: true, breakComplete: true },
});

export const pomodoro = (p: Partial<PomodoroView> = {}): PomodoroView => ({
  phase: 'idle',
  running: false,
  session: 1,
  sessions: 4,
  remainingMs: 25 * 60_000,
  phaseTotalMs: 25 * 60_000,
  endsAt: null,
  today: { completedSessions: 2, focusSeconds: 3000 },
  totalFocusSeconds: 9000,
  ...p,
});

export const unavailable = (id: string, name: string): UsageSnapshot => ({
  providerId: id,
  displayName: name,
  status: 'unavailable',
  windows: [],
  lastSuccessAt: null,
  fetchedAt: '2026-10-06T04:43:00Z',
  sourceKind: 'none',
  sourceLabel: 'NOT CONFIGURED',
  confidence: 'low',
  error: null,
  note: 'NOT CONNECTED · SETTINGS › AI',
  isDemo: false,
});

export const okClaude = (): UsageSnapshot => ({
  ...unavailable('claude', 'CLAUDE'),
  status: 'ok',
  sourceKind: 'claude-statusline',
  sourceLabel: 'CLAUDE CODE STATUS LINE',
  confidence: 'high',
  note: null,
  lastSuccessAt: '2026-10-06T04:42:00Z',
  windows: [
    { key: '5H', label: '5-HOUR WINDOW', usedFraction: 0.71, remainingFraction: 0.29, resetsAt: '2026-10-06T07:00:00Z', expired: false },
    { key: '7D', label: '7-DAY WINDOW', usedFraction: 0.24, remainingFraction: 0.76, resetsAt: '2026-10-12T00:00:00Z', expired: false },
  ],
});

export const system = (): SystemSnapshot => ({
  sampledAt: '2026-10-06T04:43:00Z',
  hostname: 'DESKTOP-TEST',
  cpu: { name: 'Test CPU', threads: 4, usage: 0.34, perCore: [0.1, 0.2, 0.3, 0.4], temperatureC: null },
  memory: { usedBytes: 8 * 1024 ** 3, totalBytes: 16 * 1024 ** 3 },
  disks: [{ mount: 'C:', usedBytes: 100 * 1024 ** 3, totalBytes: 500 * 1024 ** 3 }],
  network: { rxBytesPerSec: 2 * 1024 ** 2, txBytesPerSec: 0.5 * 1024 ** 2 },
  gpu: { name: 'Test GPU', usage: null, temperatureC: null, source: null },
  uptimeSecs: 3 * 86400 + 4 * 3600,
  processCount: 200,
  cpuHistory: Array(60).fill(0.3),
  rxHistory: Array(60).fill(1000),
  txHistory: Array(60).fill(100),
  topProcesses: [{ name: 'FLIP.EXE', cpu: 0.01, memoryBytes: 80 * 1024 ** 2 }],
  limitations: [{ metric: 'CPU TEMP', reason: 'No documented API.' }],
});

export const bootstrap = (over: Partial<Bootstrap> = {}): Bootstrap => ({
  settings: settings(),
  settingsNotice: null,
  clock: {
    epochMs: Date.parse('2026-10-06T04:43:00Z'),
    home: { tz: 'Asia/Singapore', year: 2026, month: 10, day: 6, hour: 12, minute: 43, second: 0, weekday: 'TUE', isoWeek: 41, utcOffsetMinutes: 480 },
    cities: [
      { name: 'LONDON', code: 'LHR', tz: 'Europe/London', time: '05:43', diffMinutes: -420, diffLabel: '-7H', dayShift: 0, valid: true },
      { name: 'TOKYO', code: 'HND', tz: 'Asia/Tokyo', time: '13:43', diffMinutes: 60, diffLabel: '+1H', dayShift: 0, valid: true },
    ],
  },
  system: system(),
  pomodoro: pomodoro(),
  ai: [unavailable('claude', 'CLAUDE'), unavailable('codex', 'CODEX')],
  platform: { isDebug: false, appVersion: '0.1.0', dataDir: 'C:\\Users\\t\\AppData\\Roaming\\com.flip.dashboard', claudeStatuslineCommand: '"C:\\flip.exe" --claude-statusline' },
  timeZones: ['Asia/Singapore', 'Europe/London', 'Asia/Tokyo', 'Europe/Paris', 'UTC'],
  systemTimeZone: 'Asia/Singapore',
  status: {
    displays: [
      { id: 'DISPLAY1', label: 'DISPLAY 1 · 1920×1080 · PRIMARY', width: 1920, height: 1080, scale: 1, primary: true },
      { id: 'DISPLAY2', label: 'DISPLAY 2 · 2560×1440', width: 2560, height: 1440, scale: 1, primary: false },
    ],
    displayNotice: null,
    shortcutStatus: { toggle: 'OK', settings: 'OK', layout: 'IN USE BY ANOTHER APP', focus: 'OK' },
    desktopColor: '#000000',
  },
  panelView: 'settings',
  ...over,
});
