// Clock Studio faces. Each face only renders the string it is given; the time itself always
// comes from the backend tick (see DigitalClock), so no face keeps or advances time.
import { memo, useEffect, useState, type CSSProperties } from 'react';
import { INK_VAR, fixedWidth } from '../lib/clock';
import type { ClockSettings, ClockTemplate } from '../lib/types';
import { DotMatrix } from './primitives';

export interface FaceProps {
  /** "12:43", " 9:41" or with ';' for the "off" frame of a blinking colon. */
  text: string;
  /** Digit height in 1080p design pixels (scaled by --u). */
  height: number;
  clock: ClockSettings;
  /** Effective animation (already accounts for reduced motion). */
  animate: boolean;
  label?: string;
}

// ---------------------------------------------------------------- split flap

interface FlapState {
  /** Character now showing (the flip target). */
  cur: string;
  /** Character being flipped away from. */
  prev: string;
  /** Increments on every flip; keys the leaves so a new flip restarts their animation. */
  flip: number;
  flipping: boolean;
}

/**
 * One split-flap card. The static top half already shows the new character and the static
 * bottom half keeps the old one until the falling leaves land:
 *   1. leaf A (old top half) rotates 0 → -90° about the hinge, revealing the new top;
 *   2. leaf B (new bottom half) rotates 90° → 0 over the old bottom;
 *   3. on completion the static bottom switches to the new character and the leaves unmount.
 * Only a card whose character changed flips; unchanged cards do not even re-render (memo).
 */
export const SplitFlapDigit = memo(function SplitFlapDigit({ ch, animate, ms }: { ch: string; animate: boolean; ms: number }) {
  const [s, setS] = useState<FlapState>({ cur: ch, prev: ch, flip: 0, flipping: false });

  // Derive the flip from the prop change during render (no effect round-trip, no flash of
  // the new character on the bottom half). A change mid-flip restarts from what is showing.
  if (ch !== s.cur) {
    setS(animate ? { cur: ch, prev: s.cur, flip: s.flip + 1, flipping: true } : { cur: ch, prev: ch, flip: s.flip, flipping: false });
  } else if (!animate && s.flipping) {
    setS({ ...s, prev: s.cur, flipping: false });
  }

  // Fallback in case animationend never fires (window hidden, element detached).
  useEffect(() => {
    if (!s.flipping) return;
    const id = window.setTimeout(() => setS((x) => (x.flip === s.flip ? { ...x, prev: x.cur, flipping: false } : x)), ms + 80);
    return () => window.clearTimeout(id);
  }, [s.flipping, s.flip, ms]);

  const done = () => setS((x) => (x.flip === s.flip ? { ...x, prev: x.cur, flipping: false } : x));
  const glyph = (c: string) => <span className="fl-flap__glyph">{c === ' ' ? '' : c}</span>;
  return (
    <span className={`fl-flap${s.flipping ? ' is-flipping' : ''}`} data-ch={s.cur} data-testid="flap">
      <span className="fl-flap__half fl-flap__top">{glyph(s.cur)}</span>
      <span className="fl-flap__half fl-flap__bottom">{glyph(s.flipping ? s.prev : s.cur)}</span>
      {s.flipping && (
        <>
          <span key={`a${s.flip}`} className="fl-flap__half fl-flap__top fl-flap__leaf-a" data-testid="leaf">
            {glyph(s.prev)}
          </span>
          <span key={`b${s.flip}`} className="fl-flap__half fl-flap__bottom fl-flap__leaf-b" onAnimationEnd={done}>
            {glyph(s.cur)}
          </span>
        </>
      )}
    </span>
  );
});

function Colon({ off, className }: { off: boolean; className: string }) {
  return (
    <span className={`${className}${off ? ' is-off' : ''}`} aria-hidden="true">
      <i />
      <i />
    </span>
  );
}

function SplitFlapFace({ text, animate, clock }: FaceProps) {
  const t = fixedWidth(text);
  const panel = clock.flapPanel === 'black' ? ' is-black' : '';
  return (
    <span className={`fl-flaps${clock.flapSeam ? ' has-seam' : ''}${clock.flapShadow ? ' has-shadow' : ''}${panel}`}>
      {t.split('').map((c, i) =>
        c === ':' || c === ';' ? (
          <Colon key={i} off={c === ';'} className="fl-flaps__colon" />
        ) : (
          <SplitFlapDigit key={i} ch={c} animate={animate} ms={clock.animationMs} />
        ),
      )}
    </span>
  );
}

// ---------------------------------------------------------------- seven segment

//   a
// f   b
//   g
// e   c
//   d
const SEGMENTS: Record<string, string> = {
  '0': 'abcdef',
  '1': 'bc',
  '2': 'abged',
  '3': 'abgcd',
  '4': 'fgbc',
  '5': 'afgcd',
  '6': 'afgedc',
  '7': 'abc',
  '8': 'abcdefg',
  '9': 'abcdfg',
  '-': 'g',
  ' ': '',
};

/** Segments lit for a character; unknown characters light nothing. */
export function segmentsFor(ch: string): string {
  return SEGMENTS[ch] ?? '';
}

// Segment polygons in a 10 × 18 box (slanted 6°, bevelled ends).
const SEG_PATHS: Record<string, string> = {
  a: 'M2.2,0.6 L7.8,0.6 L8.8,1.6 L7.8,2.6 L2.2,2.6 L1.2,1.6 Z',
  b: 'M8.4,2.2 L9.4,3.2 L9.4,8.0 L8.4,9.0 L7.4,8.0 L7.4,3.2 Z',
  c: 'M8.4,9.0 L9.4,10.0 L9.4,14.8 L8.4,15.8 L7.4,14.8 L7.4,10.0 Z',
  d: 'M2.2,15.4 L7.8,15.4 L8.8,16.4 L7.8,17.4 L2.2,17.4 L1.2,16.4 Z',
  e: 'M1.6,9.0 L2.6,10.0 L2.6,14.8 L1.6,15.8 L0.6,14.8 L0.6,10.0 Z',
  f: 'M1.6,2.2 L2.6,3.2 L2.6,8.0 L1.6,9.0 L0.6,8.0 L0.6,3.2 Z',
  g: 'M2.2,8.0 L7.8,8.0 L8.8,9.0 L7.8,10.0 L2.2,10.0 L1.2,9.0 Z',
};

const SevenDigit = memo(function SevenDigit({ ch }: { ch: string }) {
  const on = segmentsFor(ch);
  return (
    <svg className="fl-seg7__digit" viewBox="0 0 10 18" aria-hidden="true">
      <g transform="skewX(-6) translate(1 0)">
        {Object.entries(SEG_PATHS).map(([k, d]) => (
          <path key={k} d={d} className={on.includes(k) ? 'on' : undefined} />
        ))}
      </g>
    </svg>
  );
});

function SevenSegmentFace({ text, clock }: FaceProps) {
  const t = fixedWidth(text);
  return (
    <span className={`fl-seg7${clock.ghostDots ? '' : ' no-ghost'}`}>
      {t.split('').map((c, i) =>
        c === ':' || c === ';' ? <Colon key={i} off={c === ';'} className="fl-seg7__colon" /> : <SevenDigit key={i} ch={c} />,
      )}
    </span>
  );
}

// ---------------------------------------------------------------- terminal + minimal

function TextFace({ text, kind }: { text: string; kind: 'terminal' | 'minimal' }) {
  const parts = text.split(/([:;])/);
  return (
    <span className={kind === 'terminal' ? 'fl-term' : 'fl-minimal'}>
      {kind === 'terminal' && <span className="fl-term__prompt">&gt;</span>}
      {parts.map((p, i) =>
        p === ':' || p === ';' ? (
          <span key={i} className={`fl-textcolon${p === ';' ? ' is-off' : ''}`}>
            :
          </span>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </span>
  );
}

// ---------------------------------------------------------------- face switch

/** Renders the clock text in the chosen Clock Studio template. */
export function ClockFace(props: FaceProps & { template: ClockTemplate }) {
  const { template, text, height, clock, animate, label } = props;
  const style = {
    '--clock-h': `calc(var(--u, 1) * ${height}px)`,
    '--clock-gap': String(clock.spacing),
    '--clock-ms': `${clock.animationMs}ms`,
    '--clock-ink': INK_VAR[clock.ink],
  } as CSSProperties;
  const cls = `fl-clockface fl-clockface--${template}${animate ? '' : ' is-static'}`;
  return (
    <span className={cls} style={style} role="img" aria-label={label ?? text.replace(';', ':')}>
      {template === 'dotMatrix' && (
        <DotMatrix
          text={text}
          pitch={height / 7}
          ghost={clock.ghostDots}
          shape={clock.dotShape}
          gap={clock.spacing}
          instant={!animate}
          label={label}
        />
      )}
      {template === 'splitFlap' && <SplitFlapFace {...props} />}
      {template === 'sevenSegment' && <SevenSegmentFace {...props} />}
      {(template === 'terminal' || template === 'minimal') && <TextFace text={text} kind={template} />}
    </span>
  );
}
