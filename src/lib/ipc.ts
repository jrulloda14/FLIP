// The only module that talks to Tauri. Components go through the store, never through invoke().
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type {
  Bootstrap,
  ClockSnapshot,
  ManualWindow,
  PomodoroCommand,
  PomodoroView,
  Region,
  RuntimeStatus,
  Settings,
  SystemSnapshot,
  UsageSnapshot,
} from './types';

export const EVENTS = {
  clock: 'flip://clock',
  system: 'flip://system',
  pomodoro: 'flip://pomodoro',
  ai: 'flip://ai',
  settings: 'flip://settings',
  status: 'flip://status',
  panel: 'flip://panel',
} as const;

export type WindowCommand = 'hide' | 'quit';

export const api = {
  bootstrap: () => invoke<Bootstrap>('get_bootstrap'),
  updateSettings: (settings: Settings) => invoke<Settings>('update_settings', { settings }),
  restoreDefaults: () => invoke<Settings>('restore_default_settings'),
  resetLayout: () => invoke<Settings>('reset_layout'),
  applyRegion: (region: Region) => invoke<Settings>('apply_region', { region }),
  activateProfile: (id: string) => invoke<Settings>('activate_profile', { id }),
  createProfile: (name: string, from: string | null) => invoke<Settings>('create_profile', { name, from }),
  renameProfile: (id: string, name: string) => invoke<Settings>('rename_profile', { id, name }),
  deleteProfile: (id: string) => invoke<Settings>('delete_profile', { id }),
  resetProfile: (id: string) => invoke<Settings>('reset_profile', { id }),
  pomodoro: (command: PomodoroCommand) => invoke<PomodoroView>('pomodoro_command', { command }),
  refreshAi: () => invoke<UsageSnapshot[]>('refresh_ai'),
  setManualUsage: (providerId: string, windows: ManualWindow[]) =>
    invoke<UsageSnapshot[]>('set_manual_usage', { providerId, windows }),
  clearManualUsage: (providerId: string) => invoke<UsageSnapshot[]>('clear_manual_usage', { providerId }),
  window: (command: WindowCommand) => invoke<void>('window_command', { command }),
  openPanel: (view: string) => invoke<void>('open_panel', { view }),
  closePanel: () => invoke<void>('close_panel'),
};

export interface Handlers {
  clock: (c: ClockSnapshot) => void;
  system: (s: SystemSnapshot) => void;
  pomodoro: (p: PomodoroView) => void;
  ai: (a: UsageSnapshot[]) => void;
  settings: (s: Settings) => void;
  status: (s: RuntimeStatus) => void;
  panel: (view: string) => void;
}

/** Subscribes to every backend event once. Returns a single cleanup function. */
export async function subscribe(h: Handlers): Promise<UnlistenFn> {
  const offs = await Promise.all([
    listen<ClockSnapshot>(EVENTS.clock, (e) => h.clock(e.payload)),
    listen<SystemSnapshot>(EVENTS.system, (e) => h.system(e.payload)),
    listen<PomodoroView>(EVENTS.pomodoro, (e) => h.pomodoro(e.payload)),
    listen<UsageSnapshot[]>(EVENTS.ai, (e) => h.ai(e.payload)),
    listen<Settings>(EVENTS.settings, (e) => h.settings(e.payload)),
    listen<RuntimeStatus>(EVENTS.status, (e) => h.status(e.payload)),
    listen<string>(EVENTS.panel, (e) => h.panel(e.payload)),
  ]);
  return () => offs.forEach((off) => off());
}

export function errorMessage(e: unknown): string {
  if (typeof e === 'string') return e;
  if (e && typeof e === 'object' && 'message' in e) return String((e as { message: unknown }).message);
  return 'UNKNOWN ERROR';
}
