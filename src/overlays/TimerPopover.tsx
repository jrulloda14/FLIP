import { DotMatrix, DotMeter } from '../components/primitives';
import { Seg } from '../components/controls';
import { endsText, phaseText, progress } from '../components/PomodoroPanel';
import { focusTotal, mmss, sessionDots } from '../lib/format';
import { useFlip } from '../lib/store';

/** Pomodoro controls: start/pause, reset, skip, +5 min and block length. */
export function TimerPopover() {
  const { state, actions } = useFlip();
  const p = state.pomodoro!;
  const s = state.settings!;
  const tz = state.clock?.home.tz ?? 'UTC';
  return (
    <div className="fl-timer" role="dialog" aria-modal="true" aria-label="Timer controls" onClick={(e) => e.stopPropagation()}>
      <div className="fl-sheet">
        <div className="fl-sheet__h" data-tauri-drag-region>
          <span data-tauri-drag-region>{phaseText(p)}</span>
          <button className="fl-ctl" onClick={() => actions.openOverlay(null)}>
            ESC CLOSE
          </button>
        </div>
        <div className="fl-sheet__b">
          <div className="fl-timer__top">
            <DotMatrix text={mmss(p.remainingMs)} pitch={13} ghost={s.clock.ghostDots} shape={s.clock.dotShape} />
            <div className="fl-focus__side">
              <div className="fl-focus__dots">{sessionDots(p.session, p.sessions, p.phase)}</div>
              <div>{endsText(p, tz, s.focus.focusMinutes)}</div>
            </div>
          </div>
          <DotMeter value={progress(p)} cells={Math.min(60, Math.max(5, Math.round(p.phaseTotalMs / 60000)))} square />
          <div className="fl-timer__row">
            <button className="fl-btn fl-btn--primary" onClick={() => void actions.pomodoro('toggle')}>
              {p.running ? 'PAUSE' : p.phase === 'idle' ? 'START' : 'RESUME'} <kbd>SPACE</kbd>
            </button>
            <button className="fl-btn" onClick={() => void actions.pomodoro('reset')}>
              RESET <kbd>R</kbd>
            </button>
            <button className="fl-btn" onClick={() => void actions.pomodoro('skip')}>
              SKIP <kbd>S</kbd>
            </button>
            <button className="fl-btn" onClick={() => void actions.pomodoro('addFive')} disabled={p.phase === 'idle'}>
              +5 MIN <kbd>+</kbd>
            </button>
          </div>
          <div className="fl-timer__row fl-timer__row--between">
            <span className="fl-ink3 fl-small">BLOCK</span>
            <Seg
              value={s.focus.focusMinutes}
              options={[
                [25, 'FOCUS 25'],
                [45, 'FOCUS 45'],
                [50, 'FOCUS 50'],
              ]}
              onChange={(v) => void actions.updateSettings((x) => ({ ...x, focus: { ...x.focus, focusMinutes: v } }))}
              label="Focus length"
            />
          </div>
          <div className="fl-ink3 fl-small">
            TODAY {p.today.completedSessions} SESSIONS · {focusTotal(p.today.focusSeconds)} FOCUSED · ALL TIME {focusTotal(p.totalFocusSeconds)}
          </div>
        </div>
      </div>
    </div>
  );
}
