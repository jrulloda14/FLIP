import { clockScale, digitHeight, safeTemplate, shouldAnimate, useReducedMotion } from '../lib/clock';
import { ampm, clockText, pad2 } from '../lib/format';
import type { ClockSettings, HomeTime, Layout } from '../lib/types';
import { ClockFace } from './ClockFace';

interface Props {
  home: HomeTime;
  clock: ClockSettings;
  /** Dot pitch for the layout; sets the digit height for every template. */
  pitch: number;
  layout: Layout;
  onClick?: () => void;
}

/** The main clock: hh:mm in the Clock Studio template, optional small seconds and AM/PM.
 *  Time comes only from the backend's per-second snapshot (`home`); nothing here counts. */
export function DigitalClock({ home, clock, pitch, layout, onClick }: Props) {
  const reduced = useReducedMotion();
  const template = safeTemplate(clock.template);
  const animate = shouldAnimate(clock.animate, reduced, clock.animationMs);
  const height = digitHeight(pitch, clockScale(layout, clock.scale));
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
      data-template={template}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onClick?.();
      }}
    >
      <ClockFace template={template} text={text} height={height} clock={clock} animate={animate} label={label} />
      {clock.seconds && (
        <ClockFace template={template} text={pad2(home.second)} height={Math.round(height * 0.42)} clock={clock} animate={animate} />
      )}
      {!clock.h24 && <div className="fl-ampm">{ampm(home, false)}</div>}
    </div>
  );
}
