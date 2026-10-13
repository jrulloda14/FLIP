import { useEffect, useRef, useState } from 'react';
import { mmss, PHASE_LABEL } from '../lib/format';
import type { CompletionNotice } from '../lib/types';
import { FlipText } from './primitives';

export interface CompletionCopy {
  heading: string;
  detail: string;
  /** null when the next phase already runs (auto-start), so there is nothing to start. */
  primary: string | null;
}

/** The words on the card for a notice. */
export function completionCopy(n: CompletionNotice): CompletionCopy {
  const next = `${PHASE_LABEL[n.next]} · ${mmss(n.nextMs)}`;
  if (n.finished === 'focus') {
    return {
      heading: 'FOCUS COMPLETE',
      detail: n.nextRunning ? `${next} · STARTED` : `NEXT · ${next}`,
      primary: n.nextRunning ? null : 'START BREAK',
    };
  }
  return {
    heading: 'BREAK COMPLETE',
    detail: n.nextRunning ? `${next} · STARTED` : `NEXT · ${next} · SESSION ${n.session}/${n.sessions}`,
    primary: n.nextRunning ? null : 'RESUME FOCUS',
  };
}

interface Props {
  notice: CompletionNotice;
  /** Plays the exit animation. */
  leaving: boolean;
  onPrimary: () => void;
  onDismiss: () => void;
}

/** FLIP's timer-completion card: an airport-board heading that flips in, what comes next,
 *  and two actions. Non-modal; Esc dismisses, Enter/Space press the focused button. */
export function TimerCompletion({ notice, leaving, onPrimary, onDismiss }: Props) {
  const copy = completionCopy(notice);
  // Start blank so the heading flips letter by letter into place, like a departures board.
  const [heading, setHeading] = useState(' '.repeat(copy.heading.length));
  useEffect(() => {
    const id = window.setTimeout(() => setHeading(copy.heading), 60);
    return () => window.clearTimeout(id);
  }, [copy.heading]);
  const primary = useRef<HTMLButtonElement>(null);
  const dismiss = useRef<HTMLButtonElement>(null);
  // Focus inside the card (this never activates the window or takes focus from other apps).
  useEffect(() => {
    (primary.current ?? dismiss.current)?.focus({ preventScroll: true });
  }, [notice.id]);
  return (
    <div
      className={`fl-done${leaving ? ' is-leaving' : ''}${notice.finished === 'focus' ? ' is-focus' : ' is-break'}`}
      role="alertdialog"
      aria-modal="false"
      aria-labelledby={`fl-done-h-${notice.id}`}
      aria-describedby={`fl-done-d-${notice.id}`}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          onDismiss();
        }
      }}
    >
      <div className="fl-done__bar">
        <span className="fl-word">FLIP</span>
        <span>POMODORO · {PHASE_LABEL[notice.finished]} DONE</span>
      </div>
      <h1 className="fl-done__h" id={`fl-done-h-${notice.id}`}>
        <span className="sr-only">{copy.heading}</span>
        <span aria-hidden="true">
          <FlipText text={heading} />
        </span>
      </h1>
      <p className="fl-done__d" id={`fl-done-d-${notice.id}`}>
        {copy.detail}
      </p>
      <div className="fl-done__act">
        {copy.primary && (
          <button ref={primary} className="fl-btn fl-btn--primary" onClick={onPrimary}>
            {copy.primary} <kbd>↵</kbd>
          </button>
        )}
        <button ref={dismiss} className="fl-btn" onClick={onDismiss}>
          DISMISS <kbd>ESC</kbd>
        </button>
      </div>
    </div>
  );
}
