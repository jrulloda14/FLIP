import { mmss, PHASE_LABEL } from '../lib/format';
import type { Layout, PomodoroView, Settings, SystemSnapshot, UsageSnapshot, WindowLayer } from '../lib/types';
import { StatusIndicator, type LedState } from './StatusIndicator';

interface Props {
  layout: Layout;
  settings: Settings;
  pomodoro: PomodoroView | null;
  system: SystemSnapshot | null;
  ai: UsageSnapshot[];
  aiRefreshing: boolean;
  error: string | null;
  /** E.g. "DISPLAY 2 · 2560×1440". */
  context: string;
  showControls: boolean;
  dragRegion: boolean;
  onLayer: () => void;
  onSettings: () => void;
  onCompact: () => void;
  onHide: () => void;
  onClose: () => void;
  onDismissError: () => void;
}

export const LAYER_LABEL: Record<WindowLayer, string> = { desktop: 'ON DESKTOP', normal: 'NORMAL', top: 'ON TOP' };
export const NEXT_LAYER: Record<WindowLayer, WindowLayer> = { desktop: 'top', top: 'normal', normal: 'desktop' };

export function aiIndicator(ai: UsageSnapshot[], refreshing: boolean, refreshMinutes: number): { state: LedState; label: string } {
  if (ai.length === 0) return { state: 'off', label: 'AI OFF' };
  if (ai.some((p) => p.status === 'error')) return { state: 'warn', label: 'AI ERR' };
  if (refreshing || ai.some((p) => p.status === 'loading')) return { state: 'pulse', label: 'AI SYNC' };
  if (ai.every((p) => p.status === 'unavailable')) return { state: 'off', label: 'AI N/A' };
  if (ai.some((p) => p.status === 'stale')) return { state: 'ok', label: 'AI STALE' };
  return { state: 'ok', label: `AI ${refreshMinutes}M` };
}

/** Top strip: wordmark and context on the left; indicators and discreet controls on the right,
 *  which fade out when idle and return on hover. In movable modes the strip is the drag handle. */
export function StatusBar(p: Props) {
  const pomo = p.pomodoro;
  const context =
    pomo && pomo.phase !== 'idle' ? `${pomo.running ? '●' : '‖'} ${PHASE_LABEL[pomo.phase]} ${mmss(pomo.remainingMs)}` : p.context;
  const ai = aiIndicator(p.ai, p.aiRefreshing, p.settings.ai.refreshMinutes);
  const sysLed: LedState = p.system ? 'ok' : 'pulse';
  const drag = p.dragRegion ? { 'data-tauri-drag-region': true } : {};
  const layer = p.settings.window.layer;
  return (
    <header className={`fl-status${p.showControls ? '' : ' is-idle'}`} {...drag}>
      <div className="fl-status__l" {...drag}>
        <span className="fl-word" {...drag}>
          FLIP
        </span>
        <span {...drag}>{context}</span>
        {p.error && (
          <button className="fl-ctl fl-warn fl-errmsg" onClick={p.onDismissError} title="Dismiss">
            ! {p.error}
          </button>
        )}
      </div>
      <div className="fl-status__r" {...drag}>
        {p.layout !== 'mini' && (
          <>
            <StatusIndicator state={sysLed} label={`SYS ${p.settings.system.sampleSeconds}S`} />
            <StatusIndicator state={ai.state} label={ai.label} />
          </>
        )}
        <button className={`fl-ctl${layer !== 'normal' ? ' is-on' : ''}`} onClick={p.onLayer} title="Window layer (T)" aria-label={`Layer: ${LAYER_LABEL[layer]}`}>
          {LAYER_LABEL[layer]}
        </button>
        <button className="fl-ctl" onClick={p.onSettings} title="Settings (,)">
          SETTINGS
        </button>
        <button className="fl-ctl" onClick={p.onCompact} title="Toggle compact (C)">
          {p.settings.window.mode === 'compact' ? 'EXPAND' : 'COMPACT'}
        </button>
        <button className="fl-ctl" onClick={p.onHide} title="Hide (H) · restore from tray or shortcut" aria-label="Hide">
          —
        </button>
        <button className="fl-ctl" onClick={p.onClose} title={p.settings.window.closeToTray ? 'Hide to tray' : 'Quit FLIP'} aria-label="Close">
          ✕
        </button>
      </div>
    </header>
  );
}
