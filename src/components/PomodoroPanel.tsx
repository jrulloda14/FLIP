import { focusTotal, hhmmFromIso, mmss, PHASE_LABEL, sessionDots } from '../lib/format';
import type { ClockSettings, PomodoroView } from '../lib/types';
import { DotMatrix, DotMeter, FlipText } from './primitives';

export function phaseText(p: PomodoroView): string {
  if (p.phase === 'idle' || p.running) return PHASE_LABEL[p.phase];
  return `PAUSED · ${PHASE_LABEL[p.phase]}`;
}

export function progress(p: PomodoroView): number {
  if (p.phase === 'idle' || !p.phaseTotalMs) return 0;
  return 1 - p.remainingMs / p.phaseTotalMs;
}

export function endsText(p: PomodoroView, tz: string, focusMinutes: number): string {
  if (p.phase === 'idle') return `${focusMinutes} MIN BLOCK`;
  if (p.running && p.endsAt) return `ENDS ${hhmmFromIso(p.endsAt, tz)}`;
  return `${mmss(p.remainingMs)} LEFT`;
}

interface Props {
  p: PomodoroView;
  clock: ClockSettings;
  tz: string;
  focusMinutes: number;
  compactPitch?: boolean;
  onOpen: () => void;
}

/** Left-panel focus block: phase, countdown (text when idle, dot matrix when active), session dots, meter. */
export function PomodoroPanel({ p, clock, tz, focusMinutes, compactPitch, onOpen }: Props) {
  const active = p.phase !== 'idle';
  return (
    <section
      className="fl-blk fl-blk--focus"
      aria-label="Pomodoro timer"
      title="Timer controls (P)"
      onClick={onOpen}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onOpen();
      }}
    >
      <div className="fl-sec">
        <span>FOCUS · POMODORO</span>
        <span>
          SESSION {p.session} / {p.sessions}
        </span>
      </div>
      <div className="fl-focus">
        <div className="fl-focus__main">
          <div className="fl-focus__phase" data-testid="pomo-phase">
            {phaseText(p)}
          </div>
          {active ? (
            <div className={`fl-focus__matrix${p.running ? '' : ' is-paused'}`}>
              <DotMatrix text={mmss(p.remainingMs)} pitch={compactPitch ? 10 : 14} ghost={clock.ghostDots} shape={clock.dotShape} />
            </div>
          ) : (
            <div className="fl-focus__time" data-testid="pomo-time">
              {mmss(p.remainingMs)}
            </div>
          )}
        </div>
        <div className="fl-focus__side">
          <div className="fl-focus__dots" aria-label={`Session ${p.session} of ${p.sessions}`}>
            {sessionDots(p.session, p.sessions, p.phase)}
          </div>
          <div>
            <FlipText text={endsText(p, tz, focusMinutes)} />
          </div>
        </div>
        <DotMeter value={progress(p)} cells={Math.min(60, Math.max(5, Math.round(p.phaseTotalMs / 60000) || focusMinutes))} square />
        <div className="fl-focus__hint">
          {p.running ? 'SPACE PAUSE' : 'SPACE START'} · R RESET · S SKIP · TODAY {p.today.completedSessions} DONE ·{' '}
          {focusTotal(p.today.focusSeconds)}
        </div>
      </div>
    </section>
  );
}
