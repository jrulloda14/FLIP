// Typed mirrors of the Rust models in src-tauri/src/models.rs and the services.
// Field names match the camelCase JSON that serde produces.

export type DateFormat = 'dow' | 'iso' | 'eu';
export type DotShape = 'round' | 'square';
export type LayoutPref = 'auto' | 'full' | 'compact' | 'mini';
export type Layout = 'full' | 'compact' | 'mini';
export type DisplayMode = 'ambient' | 'windowed' | 'compact';
export type WindowLayer = 'desktop' | 'normal' | 'top';
export type LayoutPreset = 'balanced' | 'clock' | 'ai' | 'system';
export type ModuleId = 'ai' | 'world' | 'system' | 'focus';
export type Region = 'full' | 'leftHalf' | 'rightHalf' | 'topLeft' | 'topRight' | 'bottomLeft' | 'bottomRight' | 'center';
export type TempUnit = 'C' | 'F';
export type FontChoice = 'jetbrains' | 'cascadia' | 'consolas';
export type Contrast = 'standard' | 'dim';
export type BackgroundColor = 'desktop' | 'black' | 'board';

export interface City {
  name: string;
  code: string;
  tz: string;
}

export interface ClockSettings {
  h24: boolean;
  seconds: boolean;
  blink: boolean;
  dateFormat: DateFormat;
  metaLine: boolean;
  dotShape: DotShape;
  ghostDots: boolean;
  /** IANA zone; null follows the Windows time zone. */
  homeTimeZone: string | null;
}

export interface AppearanceSettings {
  /** DESKTOP follows the Windows solid desktop colour so the board blends in. */
  background: BackgroundColor;
  font: FontChoice;
  /** Multiplies the layout scale, 0.8–1.25. */
  textScale: number;
  contrast: Contrast;
  /** Background alpha 0.3–1. Text stays opaque. */
  backgroundOpacity: number;
}

export type ClaudeSource = 'off' | 'statusline' | 'manual';
export type CodexSource = 'off' | 'localLogs' | 'manual';

export interface ManualWindow {
  key: string;
  usedPercent: number;
  resetsAt: string | null;
}

export interface ManualUsage {
  windows: ManualWindow[];
  enteredAt: string;
}

export interface AiSettings {
  refreshMinutes: number;
  warnAt: number;
  claude: { source: ClaudeSource };
  codex: { source: CodexSource; codexHome: string | null };
  manual: Record<string, ManualUsage>;
  /** Debug builds only. Always false in release builds. */
  demo: boolean;
}

export interface FocusSettings {
  focusMinutes: number;
  shortMinutes: number;
  longMinutes: number;
  sessions: number;
  autoStart: boolean;
}

export interface ModuleSettings {
  date: boolean;
  ai: boolean;
  world: boolean;
  system: boolean;
  focus: boolean;
  keys: boolean;
  /** Content density; AUTO picks from the window size. */
  layout: LayoutPref;
  preset: LayoutPreset;
  order: ModuleId[];
}

export interface SystemSettings {
  temps: boolean;
  gpu: boolean;
  net: boolean;
  disk: boolean;
  plot: boolean;
  sampleSeconds: number;
  tempUnit: TempUnit;
}

export interface Placement {
  x: number;
  y: number;
  width: number;
  height: number;
  monitor: string | null;
}

export interface WindowSettings {
  mode: DisplayMode;
  layer: WindowLayer;
  /** Monitor device name; null = primary. */
  display: string | null;
  launchOnStartup: boolean;
  startHidden: boolean;
  closeToTray: boolean;
  hideControlsAfter: number;
  windowedRect: Placement | null;
  compactRect: Placement | null;
}

export interface ShortcutSettings {
  toggle: string;
  settings: string;
  layout: string;
  focus: string;
}

export interface NotificationSettings {
  focusComplete: boolean;
  breakComplete: boolean;
}

export interface Settings {
  version: number;
  clock: ClockSettings;
  appearance: AppearanceSettings;
  cities: City[];
  ai: AiSettings;
  focus: FocusSettings;
  modules: ModuleSettings;
  system: SystemSettings;
  window: WindowSettings;
  shortcuts: ShortcutSettings;
  notifications: NotificationSettings;
}

// ---------------------------------------------------------------- clock

export interface HomeTime {
  tz: string;
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: string;
  isoWeek: number;
  utcOffsetMinutes: number;
}

export interface CityTime {
  name: string;
  code: string;
  tz: string;
  /** Always 24-hour, as on an airport board. */
  time: string;
  diffMinutes: number;
  diffLabel: string;
  /** -1, 0 or +1 day relative to home. */
  dayShift: number;
  valid: boolean;
}

export interface ClockSnapshot {
  epochMs: number;
  home: HomeTime;
  cities: CityTime[];
}

// ---------------------------------------------------------------- system

export interface DiskInfo {
  mount: string;
  usedBytes: number;
  totalBytes: number;
}

export interface Limitation {
  metric: string;
  reason: string;
}

export interface ProcessInfo {
  name: string;
  cpu: number;
  memoryBytes: number;
}

export interface SystemSnapshot {
  sampledAt: string;
  hostname: string;
  cpu: {
    name: string;
    threads: number;
    usage: number | null;
    perCore: number[];
    temperatureC: number | null;
  };
  memory: { usedBytes: number; totalBytes: number };
  disks: DiskInfo[];
  network: { rxBytesPerSec: number | null; txBytesPerSec: number | null };
  gpu: {
    name: string | null;
    usage: number | null;
    temperatureC: number | null;
    source: string | null;
  };
  uptimeSecs: number;
  processCount: number;
  cpuHistory: number[];
  rxHistory: number[];
  txHistory: number[];
  topProcesses: ProcessInfo[];
  limitations: Limitation[];
}

// ---------------------------------------------------------------- pomodoro

export type Phase = 'idle' | 'focus' | 'shortBreak' | 'longBreak';

export interface PomodoroView {
  phase: Phase;
  running: boolean;
  session: number;
  sessions: number;
  remainingMs: number;
  phaseTotalMs: number;
  /** Wall-clock deadline when running. */
  endsAt: string | null;
  today: { completedSessions: number; focusSeconds: number };
  totalFocusSeconds: number;
}

export type PomodoroCommand = 'toggle' | 'start' | 'pause' | 'reset' | 'skip' | 'addFive';

// ---------------------------------------------------------------- AI usage

export type UsageStatus = 'ok' | 'stale' | 'loading' | 'unavailable' | 'error';
export type Confidence = 'high' | 'medium' | 'low' | 'userProvided' | 'demo';

export interface UsageWindow {
  key: string;
  label: string;
  /** 0..1, or null when unknown. */
  usedFraction: number | null;
  remainingFraction: number | null;
  resetsAt: string | null;
  /** The reset time has passed since this reading was taken. */
  expired: boolean;
}

export interface UsageSnapshot {
  providerId: string;
  displayName: string;
  status: UsageStatus;
  windows: UsageWindow[];
  lastSuccessAt: string | null;
  fetchedAt: string;
  sourceKind: string;
  sourceLabel: string;
  confidence: Confidence;
  error: { code: string; message: string; retryAt: string | null } | null;
  note: string | null;
  isDemo: boolean;
}

// ---------------------------------------------------------------- bootstrap

export interface PlatformInfo {
  isDebug: boolean;
  appVersion: string;
  dataDir: string;
  claudeStatuslineCommand: string;
}

export interface Bootstrap {
  settings: Settings;
  settingsNotice: string | null;
  clock: ClockSnapshot;
  system: SystemSnapshot | null;
  pomodoro: PomodoroView;
  ai: UsageSnapshot[];
  platform: PlatformInfo;
  timeZones: string[];
  systemTimeZone: string;
  status: RuntimeStatus;
  /** Last view requested for the panel window. */
  panelView: string;
}

export interface DisplayInfo {
  id: string;
  label: string;
  width: number;
  height: number;
  scale: number;
  primary: boolean;
}

export interface RuntimeStatus {
  displays: DisplayInfo[];
  displayNotice: string | null;
  /** Per shortcut action: "OK" or why registration failed. */
  shortcutStatus: Record<string, string>;
  /** Windows solid desktop colour (#rrggbb), or null when a wallpaper image is set. */
  desktopColor: string | null;
}
