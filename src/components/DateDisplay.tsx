import { dateMeta, dateText } from '../lib/format';
import type { ClockSettings, HomeTime } from '../lib/types';
import { FlipText } from './primitives';

/** Date under the clock, with the optional "WK nn · UTC+h" meta line. */
export function DateDisplay({ home, clock }: { home: HomeTime; clock: ClockSettings }) {
  return (
    <div className="fl-date">
      {clock.metaLine && (
        <small>
          <FlipText text={dateMeta(home)} />
        </small>
      )}
      <FlipText text={dateText(home, clock.dateFormat)} />
    </div>
  );
}
