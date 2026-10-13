// Typed mirrors of the Rust models in src-tauri/src/models.rs and the services.
// Field names match the camelCase JSON that serde produces.

export type DateFormat = 'dow' | 'iso' | 'eu';
export type DotShape = 'round' | 'square';
export type ClockTemplate = 'dotMatrix' | 'splitFlap' | 'sevenSegment' | 'terminal' | 'minimal';
export type ClockInk = 'bright' | 'soft' | 'dim';
export type FlapPanel = 'graphite' | 'black';
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
  /** Clock Studio. */
  template: ClockTemplate;
  animate: boolean;
  /** 150–600 ms. */
  animationMs: number;
  /** 0.7–1.4, clamped further on small layouts. */
  scale: number;
  /** 0.5–1.6 × the template's natural digit gap. */
  spacing: number;
  ink: ClockInk;
  flapSeam: boolean;
  flapShadow: boolean;
  flapPanel: FlapPanel;
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
  /** Monitor device name; null = primary. Used only when no stable id is saved. */
  display: string | null;
  /** Stable monitor id (survives re-plugging); preferred over `display`. */
  displayId: string | null;
  launchOnStartup: boolean;
  startHidden: boolean;
  closeToTray: boolean;
  hideControlsAfter: number;
  windowedRect: Placement | null;
  compactRect: Placement | null;
  /** Region preset each movable mode currently fills; null after a manual move/resize. */
  windowedRegion: Region | null;
  compactRegion: Region | null;
}

export interface ShortcutSettings {
  toggle: string;
  settings: string;
  layout: string;
  focus: string;
  /** Cycle to the next profile. */
  profile: string;
}

export interface NotificationSettings {
  /** Show the FOCUS COMPLETE card. */
  focusComplete: boolean;
  /** Show the BREAK COMPLETE card. */
  breakComplete: boolean;
  /** Play the Windows notification sound with the card. Off by default. */
  sound: boolean;
}

/** Opt-in threshold notifications. FLIP only notifies; it never acts on the system. */
export interface AlertSettings {
  cpu: boolean;
  cpuPercent: number;
  cpuMinutes: number;
  memory: boolean;
  memoryPercent: number;
  disk: boolean;
  diskFreePercent: number;
  cooldownMinutes: number;
}

/** A named snapshot of the layout: modules, clock look, appearance and window placement. */
export interface Profile {
  id: string;
  name: string;
  builtin: boolean;
  modules: ModuleSettings;
  clock: ClockSettings;
  appearance: AppearanceSettings;
  window: WindowSettings;
}

export interface AutoSwitch {
  enabled: boolean;
  singleDisplay: string | null;
  multiDisplay: string | null;
}

export interface ProfileSettings {
  active: string;
  items: Profile[];
  autoSwitch: AutoSwitch;
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
  alerts: AlertSettings;
  profiles: ProfileSettings;
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
  /** 24-hour "HH:MM"; `hour`/`minute` let the UI follow the 12/24-hour setting. */
  time: string;
  hour: number;
  minute: number;
  /** Local weekday and day of month, e.g. "WED 14". Empty when the zone is invalid. */
  date: string;
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
  /** null until two samples exist, or when Windows reports no activity counters. */
  readBytesPerSec: number | null;
  writeBytesPerSec: number | null;
}

/** `unsupported`: this PC cannot provide the metric. `error`: a reading failed and will be retried. */
export type LimitKind = 'unsupported' | 'error';

export interface Limitation {
  metric: string;
  reason: string;
  kind: LimitKind;
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
  memory: { usedBytes: number; totalBytes: number; availableBytes: number };
  disks: DiskInfo[];
  network: { rxBytesPerSec: number | null; txBytesPerSec: number | null };
  diskIo: { readBytesPerSec: number | null; writeBytesPerSec: number | null };
  gpu: {
    name: string | null;
    usage: number | null;
    temperatureC: number | null;
    memoryUsedBytes: number | null;
    memoryTotalBytes: number | null;
    /** True for integrated GPUs that use shared system memory. */
    memoryShared: boolean;
    source: string | null;
  };
  uptimeSecs: number;
  processCount: number;
  cpuHistory: number[];
  rxHistory: number[];
  txHistory: number[];
  /** Combined disk read + write bytes/s. */
  diskHistory: number[];
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

/** A timer phase ended. Shown once, as FLIP's completion card (never a Windows message box). */
export interface CompletionNotice {
  /** Unique per completion; actions name the id they answer. */
  id: number;
  /** The phase that ended. */
  finished: Phase;
  /** The phase the timer moved to. */
  next: Phase;
  nextMs: number;
  /** The next phase already started (auto-start is on). */
  nextRunning: boolean;
  session: number;
  sessions: number;
  at: string;
}

/** `startNext` starts the phase the timer moved to; `dismiss` only closes the card. */
export type CompletionAction = 'startNext' | 'dismiss';

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
  /** A completion card waiting to be answered. */
  completion: CompletionNotice | null;
}

export interface DisplayInfo {
  /** Device name such as DISPLAY2; can change when monitors are re-plugged. */
  id: string;
  /** Stable monitor id, or null when Windows does not report one. */
  stableId: string | null;
  name: string | null;
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
