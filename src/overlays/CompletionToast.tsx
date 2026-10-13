import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { TimerCompletion } from '../components/TimerCompletion';
import { FONTS } from '../lib/layout';
import { useFlip } from '../lib/store';
import type { CompletionAction, CompletionNotice } from '../lib/types';

/** Exit animation length; the backend hides the window right after the action arrives. */
export const LEAVE_MS = 180;

/** Root of the completion window: shows the pending notice, animates it out, and answers it
 *  exactly once. The timer is changed only by "Start break" / "Resume focus". */
export function CompletionToast() {
  const { state, actions } = useFlip();
  const pending = state.completion;
  // Keep the last notice on screen while it animates out.
  const [shown, setShown] = useState<CompletionNotice | null>(pending);
  const [leaving, setLeaving] = useState(false);
  const answered = useRef<number | null>(null);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    window.clearTimeout(timer.current);
    if (pending) {
      setShown(pending);
      setLeaving(false);
      return;
    }
    // Cleared elsewhere (tray, shortcut, dashboard): animate out, then empty.
    setLeaving(true);
    timer.current = window.setTimeout(() => setShown(null), LEAVE_MS);
  }, [pending]);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const answer = (a: CompletionAction) => {
    if (!shown || answered.current === shown.id) return; // double clicks act once
    answered.current = shown.id;
    const id = shown.id;
    setLeaving(true);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void actions.completionAction(id, a), LEAVE_MS);
  };

  const style = { '--u': '1', '--font-mono': FONTS[state.settings!.appearance.font] } as CSSProperties;
  return (
    <div className="fl-toastwin" style={style}>
      {shown && (
        <TimerCompletion
          key={shown.id}
          notice={shown}
          leaving={leaving}
          onPrimary={() => answer('startNext')}
          onDismiss={() => answer('dismiss')}
        />
      )}
    </div>
  );
}
