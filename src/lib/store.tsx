// One store for all live data. A single subscription per event type; components read from context.
// The same store runs in both windows: the dashboard ("main") and the settings/detail panel ("panel").
import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, type ReactNode } from 'react';
import { api, errorMessage, subscribe, type WindowCommand } from './ipc';
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

/** What the panel shows. `null` closes it. */
export type Overlay = null | 'settings' | 'timer' | 'system' | { ai: string };

export type Surface = 'main' | 'panel';

export function currentSurface(): Surface {
  try {
    return new URLSearchParams(window.location.search).get('view') === 'panel' ? 'panel' : 'main';
  } catch {
    return 'main';
  }
}

/** Panel views travel as strings: `settings`, `settings:AI`, `ai:claude`, `system`, `timer`. */
export function toView(o: Exclude<Overlay, null>, tab?: string): string {
  if (typeof o === 'object') return `ai:${o.ai}`;
  if (o === 'settings' && tab) return `settings:${tab}`;
  return o;
}

export function fromView(v: string): { overlay: Exclude<Overlay, null>; tab?: string } {
  const [kind, arg] = v.split(':');
  if (kind === 'ai' && arg) return { overlay: { ai: arg } };
  if (kind === 'system' || kind === 'timer') return { overlay: kind };
  return { overlay: 'settings', tab: arg };
}

export interface State {
  status: 'loading' | 'ready' | 'error';
  fatal: string | null;
  /** Last command error, shown until dismissed or replaced. */
  error: string | null;
  boot: Bootstrap | null;
  settings: Settings | null;
  clock: ClockSnapshot | null;
  system: SystemSnapshot | null;
  pomodoro: PomodoroView | null;
  ai: UsageSnapshot[];
  aiRefreshing: boolean;
  runtime: RuntimeStatus | null;
  /** Panel window only: the view on screen. */
  overlay: Overlay;
  settingsTab: string;
}

type Action =
  | { t: 'boot'; b: Bootstrap; surface: Surface }
  | { t: 'fatal'; msg: string }
  | { t: 'error'; msg: string | null }
  | { t: 'settings'; s: Settings }
  | { t: 'clock'; c: ClockSnapshot }
  | { t: 'system'; s: SystemSnapshot }
  | { t: 'pomodoro'; p: PomodoroView }
  | { t: 'ai'; a: UsageSnapshot[] }
  | { t: 'aiRefreshing'; v: boolean }
  | { t: 'runtime'; r: RuntimeStatus }
  | { t: 'overlay'; o: Overlay; tab?: string }
  | { t: 'tab'; tab: string };

export const initialState: State = {
  status: 'loading',
  fatal: null,
  error: null,
  boot: null,
  settings: null,
  clock: null,
  system: null,
  pomodoro: null,
  ai: [],
  aiRefreshing: false,
  runtime: null,
  overlay: null,
  settingsTab: 'DISPLAY',
};

export function reducer(s: State, a: Action): State {
  switch (a.t) {
    case 'boot': {
      const v = a.surface === 'panel' ? fromView(a.b.panelView) : null;
      return {
        ...s,
        status: 'ready',
        boot: a.b,
        settings: a.b.settings,
        clock: a.b.clock,
        system: a.b.system,
        pomodoro: a.b.pomodoro,
        ai: a.b.ai,
        runtime: a.b.status,
        error: a.surface === 'main' ? a.b.settingsNotice : null,
        overlay: v ? v.overlay : null,
        settingsTab: v?.tab ?? s.settingsTab,
      };
    }
    case 'fatal':
      return { ...s, status: 'error', fatal: a.msg };
    case 'error':
      return { ...s, error: a.msg };
    case 'settings':
      return { ...s, settings: a.s };
    case 'clock':
      return { ...s, clock: a.c };
    case 'system':
      return { ...s, system: a.s };
    case 'pomodoro':
      return { ...s, pomodoro: a.p };
    case 'ai':
      return { ...s, ai: a.a };
    case 'aiRefreshing':
      return { ...s, aiRefreshing: a.v };
    case 'runtime':
      return { ...s, runtime: a.r };
    case 'overlay':
      return { ...s, overlay: a.o, settingsTab: a.tab ?? s.settingsTab };
    case 'tab':
      return { ...s, settingsTab: a.tab };
  }
}

export interface Actions {
  updateSettings: (fn: (s: Settings) => Settings) => Promise<void>;
  restoreDefaults: () => Promise<void>;
  resetLayout: () => Promise<void>;
  applyRegion: (r: Region) => Promise<void>;
  pomodoro: (c: PomodoroCommand) => Promise<void>;
  refreshAi: () => Promise<void>;
  setManualUsage: (providerId: string, windows: ManualWindow[]) => Promise<void>;
  clearManualUsage: (providerId: string) => Promise<void>;
  window: (c: WindowCommand) => Promise<void>;
  /** Dashboard: opens the panel window. Panel: switches view; `null` closes the panel. */
  openOverlay: (o: Overlay, tab?: string) => void;
  setTab: (tab: string) => void;
  dismissError: () => void;
}

const Ctx = createContext<{ state: State; actions: Actions; surface: Surface } | null>(null);

export function FlipProvider({ children, surface = currentSurface() }: { children: ReactNode; surface?: Surface }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const settingsRef = useRef<Settings | null>(null);
  settingsRef.current = state.settings;

  useEffect(() => {
    let off: (() => void) | undefined;
    let cancelled = false;
    subscribe({
      clock: (c) => dispatch({ t: 'clock', c }),
      system: (s) => dispatch({ t: 'system', s }),
      pomodoro: (p) => dispatch({ t: 'pomodoro', p }),
      ai: (a) => dispatch({ t: 'ai', a }),
      settings: (s) => dispatch({ t: 'settings', s }),
      status: (r) => dispatch({ t: 'runtime', r }),
      panel: (v) => {
        const p = fromView(v);
        dispatch({ t: 'overlay', o: p.overlay, tab: p.tab });
      },
    })
      .then((unlisten) => {
        if (cancelled) unlisten();
        else off = unlisten;
        return api.bootstrap();
      })
      .then((b) => {
        if (!cancelled) dispatch({ t: 'boot', b, surface });
      })
      .catch((e) => {
        if (!cancelled) dispatch({ t: 'fatal', msg: errorMessage(e) });
      });
    return () => {
      cancelled = true;
      off?.();
    };
  }, [surface]);

  const run = useCallback(async <T,>(p: Promise<T>): Promise<T | undefined> => {
    try {
      return await p;
    } catch (e) {
      dispatch({ t: 'error', msg: errorMessage(e) });
      return undefined;
    }
  }, []);

  const updateSettings = useCallback(
    async (fn: (s: Settings) => Settings) => {
      const cur = settingsRef.current;
      if (!cur) return;
      const next = fn(cur);
      dispatch({ t: 'settings', s: next }); // optimistic; the backend echoes the validated value
      const saved = await run(api.updateSettings(next));
      dispatch({ t: 'settings', s: saved ?? cur });
    },
    [run],
  );

  const actions = useMemo<Actions>(
    () => ({
      updateSettings,
      restoreDefaults: async () => {
        const s = await run(api.restoreDefaults());
        if (s) dispatch({ t: 'settings', s });
      },
      resetLayout: async () => {
        const s = await run(api.resetLayout());
        if (s) dispatch({ t: 'settings', s });
      },
      applyRegion: async (r) => {
        const s = await run(api.applyRegion(r));
        if (s) dispatch({ t: 'settings', s });
      },
      pomodoro: async (c) => {
        const p = await run(api.pomodoro(c));
        if (p) dispatch({ t: 'pomodoro', p });
      },
      refreshAi: async () => {
        dispatch({ t: 'aiRefreshing', v: true });
        const a = await run(api.refreshAi());
        if (a) dispatch({ t: 'ai', a });
        dispatch({ t: 'aiRefreshing', v: false });
      },
      setManualUsage: async (id, windows) => {
        const a = await run(api.setManualUsage(id, windows));
        if (a) dispatch({ t: 'ai', a });
      },
      clearManualUsage: async (id) => {
        const a = await run(api.clearManualUsage(id));
        if (a) dispatch({ t: 'ai', a });
      },
      window: async (c) => {
        await run(api.window(c));
      },
      openOverlay: (o, tab) => {
        if (surface === 'panel') {
          if (o === null) void run(api.closePanel());
          else dispatch({ t: 'overlay', o, tab });
        } else if (o !== null) {
          void run(api.openPanel(toView(o, tab)));
        }
      },
      setTab: (tab) => dispatch({ t: 'tab', tab }),
      dismissError: () => dispatch({ t: 'error', msg: null }),
    }),
    [run, updateSettings, surface],
  );

  const value = useMemo(() => ({ state, actions, surface }), [state, actions, surface]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useFlip() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useFlip must be used inside FlipProvider');
  return v;
}
