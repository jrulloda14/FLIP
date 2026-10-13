import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from 'react';
import { AIUsageTable } from './components/AIUsageTable';
import { DateDisplay } from './components/DateDisplay';
import { DigitalClock } from './components/DigitalClock';
import { PomodoroPanel, phaseText } from './components/PomodoroPanel';
import { NEXT_LAYER, StatusBar } from './components/StatusBar';
import { SystemMonitor } from './components/SystemMonitor';
import { WorldClockTable } from './components/WorldClockTable';
import { DotMeter } from './components/primitives';
import { focusTotal, mmss, pct, rateShort, temp } from './lib/format';
import { FONTS, PITCH, boardColor, hexToRgb, pickLayout, scaleFor } from './lib/layout';
import { FlipProvider, useFlip, type Surface } from './lib/store';
import type { DisplayMode, Layout, LayoutPreset, ModuleId, Settings } from './lib/types';
import { CompletionToast } from './overlays/CompletionToast';
import { ProviderDetail } from './overlays/ProviderDetail';
import { SettingsWindow } from './overlays/SettingsWindow';
import { SystemDetail } from './overlays/SystemDetail';
import { TimerPopover } from './overlays/TimerPopover';

/** Clock dot pitch for the FULL layout under each preset. */
export const PRESET_PITCH: Record<LayoutPreset, number> = { balanced: 28, clock: 40, ai: 20, system: 22 };
const COMPACT_PITCH: Record<LayoutPreset, number> = { balanced: 17, clock: 26, ai: 13, system: 14 };
const NEXT_PRESET: Record<LayoutPreset, LayoutPreset> = { balanced: 'clock', clock: 'ai', ai: 'system', system: 'balanced' };
const NEXT_MODE: Record<DisplayMode, DisplayMode> = { ambient: 'windowed', windowed: 'compact', compact: 'ambient' };

/** Compact mode always shows a reduced layout; otherwise the density preference applies. */
/** A density chosen in Settings › Modules always wins; AUTO follows the window size, and
 *  COMPACT display mode never auto-picks the full two-column layout. */
export function layoutFor(w: number, h: number, s: Settings): Layout {
  if (s.modules.layout !== 'auto') return s.modules.layout;
  const auto = pickLayout(w, h, 'auto');
  return s.window.mode === 'compact' && auto === 'full' ? 'compact' : auto;
}

/** Presets apply to the FULL and COMPACT layouts; MINI has room for the clock and AI rows only. */
export function presetFor(layout: Layout, preset: LayoutPreset): LayoutPreset {
  return layout === 'mini' ? 'balanced' : preset;
}

/** Clock dot pitch (digit height / 7) per layout and preset, in 1080p design pixels. */
/** The profile after the active one, wrapping around (same order as the tray and the shortcut). */
export function nextProfileId(p: Settings['profiles']): string {
  const i = p.items.findIndex((x) => x.id === p.active);
  return p.items[(i + 1) % p.items.length]?.id ?? p.active;
}

export function clockPitch(layout: Layout, preset: LayoutPreset): number {
  if (layout === 'full') return PRESET_PITCH[preset];
  if (layout === 'compact') return COMPACT_PITCH[preset];
  return PITCH.mini;
}

function useSize(ref: RefObject<HTMLElement | null>) {
  const [size, setSize] = useState({ w: window.innerWidth, h: window.innerHeight });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return size;
}

/** Controls fade after N idle seconds and come back on pointer movement or hover. */
function useIdle(seconds: number) {
  const [idle, setIdle] = useState(false);
  useEffect(() => {
    if (seconds <= 0) {
      setIdle(false);
      return;
    }
    let t = window.setTimeout(() => setIdle(true), seconds * 1000);
    const wake = () => {
      setIdle(false);
      window.clearTimeout(t);
      t = window.setTimeout(() => setIdle(true), seconds * 1000);
    };
    window.addEventListener('mousemove', wake);
    window.addEventListener('keydown', wake);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener('mousemove', wake);
      window.removeEventListener('keydown', wake);
    };
  }, [seconds]);
  return idle;
}

const orderOf = (order: ModuleId[], id: ModuleId) => ({ '--order': order.indexOf(id) + 3 }) as CSSProperties;

export function Dashboard() {
  const { state, actions } = useFlip();
  const host = useRef<HTMLDivElement>(null);
  const { w, h } = useSize(host);
  const s = state.settings!;
  const clock = state.clock!;
  const pomo = state.pomodoro!;
  const layout = layoutFor(w, h, s);
  const preset = presetFor(layout, s.modules.preset);
  const u = scaleFor(w, h, layout, s.appearance.textScale);
  const idle = useIdle(s.window.hideControlsAfter);
  const active = pomo.phase !== 'idle';
  const m = s.modules;
  const movable = s.window.mode !== 'ambient';

  const set = actions.updateSettings;
  const cycleLayer = useCallback(() => void set((x) => ({ ...x, window: { ...x.window, layer: NEXT_LAYER[x.window.layer] } })), [set]);
  const toggleCompact = useCallback(
    () => void set((x) => ({ ...x, window: { ...x.window, mode: x.window.mode === 'compact' ? 'windowed' : 'compact' } })),
    [set],
  );
  const close = useCallback(() => void actions.window(s.window.closeToTray ? 'hide' : 'quit'), [actions, s.window.closeToTray]);

  // In-window keys (when FLIP has focus). System-wide shortcuts are registered by the backend.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;
      const k = e.key;
      if (e.ctrlKey && (k === 'q' || k === 'Q')) return void actions.window('quit');
      if (e.ctrlKey || e.altKey || e.metaKey) return;
      if (k === ' ') {
        e.preventDefault();
        void actions.pomodoro('toggle');
      } else if (k === 'r' || k === 'R') void actions.pomodoro('reset');
      else if (k === 's' || k === 'S') void actions.pomodoro('skip');
      else if (k === '+') void actions.pomodoro('addFive');
      else if (k === 'p' || k === 'P') actions.openOverlay('timer');
      else if (k === ',') actions.openOverlay('settings');
      else if (k === 'c' || k === 'C') toggleCompact();
      else if (k === 't' || k === 'T') cycleLayer();
      else if (k === 'l' || k === 'L') void set((x) => ({ ...x, modules: { ...x.modules, preset: NEXT_PRESET[x.modules.preset] } }));
      else if (k === 'm' || k === 'M') void set((x) => ({ ...x, window: { ...x.window, mode: NEXT_MODE[x.window.mode] } }));
      else if (k === 'h' || k === 'H') void actions.window('hide');
      else if (k === 'n' || k === 'N') {
        void actions.activateProfile(nextProfileId(s.profiles));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [actions, toggleCompact, cycleLayer, set, s.profiles]);

  const bg = boardColor(s.appearance.background, state.runtime?.desktopColor);
  const style = {
    '--u': u.toFixed(4),
    '--font-mono': FONTS[s.appearance.font],
    '--bg-a': String(s.appearance.backgroundOpacity),
    '--bg': bg,
    '--bg-rgb': hexToRgb(bg),
  } as CSSProperties;
  const cls = [
    'fl-dash',
    pomo.running ? 'is-running' : active ? 'is-paused' : '',
    s.appearance.contrast === 'dim' ? 'is-dim' : '',
    s.appearance.backgroundOpacity < 1 ? 'is-translucent' : '',
    idle ? 'is-idle' : '',
    movable ? 'is-movable' : '',
  ]
    .filter(Boolean)
    .join(' ');
  const showLeft = layout === 'full' && preset !== 'clock' && (m.system || m.focus || m.keys);
  const showStrip = layout === 'compact' || (layout === 'full' && preset === 'clock');
  const sys = state.system;
  const nowMs = clock.epochMs;
  const pitch = clockPitch(layout, preset);
  const displays = state.runtime?.displays ?? [];
  const saved = s.window.displayId ? displays.find((d) => d.stableId === s.window.displayId) : displays.find((d) => d.id === s.window.display);
  const here = saved ?? displays.find((d) => d.primary);
  const profile = s.profiles.items.find((p) => p.id === s.profiles.active);
  const notice = state.runtime?.displayNotice ?? null;
  const leftStyle = preset === 'system' ? ({ '--u': (u * 1.2).toFixed(4) } as CSSProperties) : undefined;
  const meterCells = preset === 'ai' ? 32 : 22;

  return (
    <div ref={host} className="fl-display fl-host" style={style}>
      <div className={cls} data-layout={layout} data-preset={preset} data-mode={s.window.mode}>
        <StatusBar
          layout={layout}
          settings={s}
          pomodoro={pomo}
          system={sys}
          ai={state.ai}
          aiRefreshing={state.aiRefreshing}
          error={state.error ?? notice}
          context={[profile?.name, here ? here.label.replace(' · PRIMARY', '') : ''].filter(Boolean).join(' · ')}
          showControls={!idle}
          dragRegion={movable}
          onLayer={cycleLayer}
          onSettings={() => actions.openOverlay('settings')}
          onCompact={toggleCompact}
          onHide={() => void actions.window('hide')}
          onClose={close}
          onDismissError={actions.dismissError}
        />
        {showLeft && (
          <aside className="fl-left" style={leftStyle}>
            {m.system && (
              <div className="fl-slot" style={orderOf(m.order, 'system')}>
                <SystemMonitor sys={sys} cfg={s.system} condensed={active} onOpen={() => actions.openOverlay('system')} />
              </div>
            )}
            {m.focus && (
              <div className="fl-slot fl-slot--focus" style={orderOf(m.order, 'focus')}>
                <PomodoroPanel p={pomo} clock={s.clock} tz={clock.home.tz} focusMinutes={s.focus.focusMinutes} onOpen={() => actions.openOverlay('timer')} />
              </div>
            )}
            {m.keys && (
              <div className="fl-keys" aria-label="Keyboard shortcuts">
                <span>
                  <kbd>{s.shortcuts.toggle.toUpperCase()}</kbd> SHOW/HIDE
                </span>
                <span>
                  <kbd>{s.shortcuts.settings.toUpperCase()}</kbd> SETTINGS
                </span>
                <span>
                  <kbd>{s.shortcuts.layout.toUpperCase()}</kbd> LAYOUT
                </span>
                <span>
                  <kbd>{s.shortcuts.focus.toUpperCase()}</kbd> FOCUS
                </span>
                <span>
                  <kbd>{s.shortcuts.profile.toUpperCase()}</kbd> PROFILE
                </span>
              </div>
            )}
          </aside>
        )}
        <main className="fl-right">
          <DigitalClock home={clock.home} clock={s.clock} pitch={pitch} layout={layout} onClick={() => actions.openOverlay('settings', 'CLOCK')} />
          <div className="fl-side">
            {m.date && <DateDisplay home={clock.home} clock={s.clock} />}
            {m.focus && active && layout === 'full' && (
              <div className="fl-focusline fl-hit" onClick={() => actions.openOverlay('timer')} role="button" tabIndex={0}>
                <span>
                  {phaseText(pomo)} {pomo.session}/{pomo.sessions} · {mmss(pomo.remainingMs)}
                </span>
                <DotMeter value={pomo.phaseTotalMs ? 1 - pomo.remainingMs / pomo.phaseTotalMs : 0} cells={12} />
              </div>
            )}
            {m.ai && (
              <div className="fl-slot fl-slot--ai" style={orderOf(m.order, 'ai')}>
                <AIUsageTable providers={state.ai} warnAt={s.ai.warnAt} nowMs={nowMs} cells={meterCells} onOpen={(id) => actions.openOverlay({ ai: id })} />
              </div>
            )}
          </div>
          {m.world && layout !== 'mini' && (
            <div className="fl-slot fl-slot--world" style={orderOf(m.order, 'world')}>
              <WorldClockTable cities={clock.cities} h24={s.clock.h24} />
            </div>
          )}
        </main>
        {showStrip && (
          <div className="fl-cstrip">
            {m.system && sys && (
              <>
                <span className="fl-hit" onClick={() => actions.openOverlay('system')}>
                  CPU {pct(sys.cpu.usage)}
                  {s.system.temps && sys.cpu.temperatureC !== null ? ' ' + temp(sys.cpu.temperatureC, s.system.tempUnit) : ''}
                </span>
                <span className="fl-hit" onClick={() => actions.openOverlay('system')}>
                  RAM {pct(sys.memory.totalBytes ? sys.memory.usedBytes / sys.memory.totalBytes : null)}
                </span>
                {s.system.gpu && (
                  <span className="fl-hit" onClick={() => actions.openOverlay('system')}>
                    GPU {pct(sys.gpu.usage)}
                  </span>
                )}
                {s.system.net && (
                  <span className="fl-hit" onClick={() => actions.openOverlay('system')}>
                    ↓ {rateShort(sys.network.rxBytesPerSec)} ↑ {rateShort(sys.network.txBytesPerSec)} MB/S
                  </span>
                )}
              </>
            )}
            {m.focus && (
              <b className="fl-hit" onClick={() => actions.openOverlay('timer')}>
                {active ? `${phaseText(pomo)} ${mmss(pomo.remainingMs)}` : `FOCUS READY · TODAY ${focusTotal(pomo.today.focusSeconds)}`}
              </b>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** The separate settings/detail window. Borderless; its header is the drag handle. */
export function Panel() {
  const { state, actions } = useFlip();
  const host = useRef<HTMLDivElement>(null);
  const { w, h } = useSize(host);
  const o = state.overlay ?? 'settings';
  const base = o === 'timer' ? [640, 470] : [1180, 800];
  const u = Math.max(0.7, Math.min(1.25, Math.min(w / base[0]!, h / base[1]!)));
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') actions.openOverlay(null);
      const t = e.target as HTMLElement | null;
      if (o === 'timer' && !(t && (t.tagName === 'INPUT' || t.tagName === 'SELECT'))) {
        if (e.key === ' ') {
          e.preventDefault();
          void actions.pomodoro('toggle');
        } else if (e.key === 'r' || e.key === 'R') void actions.pomodoro('reset');
        else if (e.key === 's' || e.key === 'S') void actions.pomodoro('skip');
        else if (e.key === '+') void actions.pomodoro('addFive');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [actions, o]);
  const s = state.settings!;
  const style = { '--u': u.toFixed(4), '--font-mono': FONTS[s.appearance.font] } as CSSProperties;
  return (
    <div ref={host} className="fl-display fl-host fl-panel" style={style}>
      {o === 'settings' && <SettingsWindow />}
      {o === 'system' && <SystemDetail />}
      {o === 'timer' && <TimerPopover />}
      {typeof o === 'object' && <ProviderDetail providerId={o.ai} />}
    </div>
  );
}

function Shell() {
  const { state, surface } = useFlip();
  if (state.status === 'error') {
    return (
      <div className="fl-display fl-fatal" role="alert">
        <div className="fl-word">FLIP</div>
        <div className="fl-warn">COULD NOT CONNECT TO THE FLIP BACKEND</div>
        <div className="fl-ink3 fl-case">{state.fatal}</div>
        <div className="fl-ink3">RESTART FLIP. IF THIS PERSISTS, SEE README › TROUBLESHOOTING.</div>
      </div>
    );
  }
  if (state.status === 'loading' || !state.settings || !state.clock || !state.pomodoro) {
    return (
      <div className="fl-display fl-fatal" aria-busy="true">
        <div className="fl-word">FLIP</div>
        <div className="fl-ink3">LOADING…</div>
      </div>
    );
  }
  if (surface === 'toast') return <CompletionToast />;
  return surface === 'panel' ? <Panel /> : <Dashboard />;
}

export default function App({ surface }: { surface?: Surface }) {
  return (
    <FlipProvider surface={surface}>
      <Shell />
    </FlipProvider>
  );
}
