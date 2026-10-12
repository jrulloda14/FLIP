import { ampm, clockText, pad2 } from '../lib/format';
import type { ClockSettings, HomeTime } from '../lib/types';
import { DotMatrix } from './primitives';

interface Props {
  home: HomeTime;
  clock: ClockSettings;
  pitch: number;
  onClick?: () => void;
}

/** Large dot-matrix clock: hh:mm, optional small seconds and AM/PM. */
export function DigitalClock({ home, clock, pitch, onClick }: Props) {
  let text = clockText(home, clock.h24);
  if (clock.blink && home.second % 2) text = text.replace(':', ';');
  const label = `${clockText(home, clock.h24)}${clock.seconds ? ':' + pad2(home.second) : ''} ${ampm(home, clock.h24)}`.trim();
  return (
    <div
      className="fl-clockwrap"
      role="timer"
      aria-label={label}
      tabIndex={0}
      title="Clock settings"
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onClick?.();
      }}
    >
      <DotMatrix text={text} pitch={pitch} ghost={clock.ghostDots} shape={clock.dotShape} label={label} />
      {clock.seconds && (
        <DotMatrix text={pad2(home.second)} pitch={Math.round(pitch * 0.42)} ghost={clock.ghostDots} shape={clock.dotShape} />
      )}
      {!clock.h24 && <div className="fl-ampm">{ampm(home, false)}</div>}
    </div>
  );
}
