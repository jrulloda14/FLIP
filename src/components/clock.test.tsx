import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { changedIndices, clockScale, digitHeight, fixedWidth, safeTemplate, shouldAnimate } from '../lib/clock';
import type { ClockSettings, ClockTemplate, HomeTime } from '../lib/types';
import { settings } from '../test/fixtures';
import { ClockFace, segmentsFor } from './ClockFace';
import { DigitalClock } from './DigitalClock';

const realMatchMedia = window.matchMedia;
function setReducedMotion(on: boolean) {
  window.matchMedia = vi.fn().mockImplementation((q: string) => ({
    matches: on && q.includes('reduce'),
    media: q,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    onchange: null,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

const clock = (patch: Partial<ClockSettings> = {}): ClockSettings => ({ ...settings().clock, ...patch });
const home = (h: number, m: number, s = 0): HomeTime => ({
  tz: 'UTC',
  year: 2026,
  month: 10,
  day: 12,
  hour: h,
  minute: m,
  second: s,
  weekday: 'MON',
  isoWeek: 42,
  utcOffsetMinutes: 0,
});

const flaps = () => screen.getAllByTestId('flap');
const flipping = () => flaps().flatMap((el, i) => (el.classList.contains('is-flipping') ? [i] : []));
const shown = () => flaps().map((el) => el.getAttribute('data-ch')).join('');

function face(text: string, opts: { animate?: boolean; template?: ClockTemplate; c?: Partial<ClockSettings> } = {}) {
  return <ClockFace template={opts.template ?? 'splitFlap'} text={text} height={84} clock={clock(opts.c)} animate={opts.animate ?? true} />;
}

beforeEach(() => setReducedMotion(false));
afterEach(() => {
  window.matchMedia = realMatchMedia;
  vi.useRealTimers();
});

describe('clock helpers', () => {
  it('detects exactly the changed digits, including multi-digit rollovers', () => {
    expect(changedIndices('12:43', '12:44')).toEqual([4]);
    expect(changedIndices('09:59', '10:00')).toEqual([0, 1, 3, 4]);
    expect(changedIndices('12:59', '13:00')).toEqual([1, 3, 4]);
    expect(changedIndices('23:59', '00:00')).toEqual([0, 1, 3, 4]);
    expect(changedIndices('12:43', '12:43')).toEqual([]);
  });

  it('keeps 12-hour times fixed-width so digit positions (and keys) stay stable', () => {
    expect(fixedWidth('9:41')).toBe(' 9:41');
    expect(fixedWidth('9;41')).toBe(' 9;41');
    expect(fixedWidth('10:00')).toBe('10:00');
    expect(changedIndices(fixedWidth('9:59'), fixedWidth('10:00'))).toEqual([0, 1, 3, 4]);
  });

  it('falls back to the dot-matrix template for unknown ids', () => {
    expect(safeTemplate('splitFlap')).toBe('splitFlap');
    expect(safeTemplate('hologram')).toBe('splitFlap');
    expect(safeTemplate(undefined)).toBe('splitFlap');
  });

  it('caps the clock size on small layouts so digits never clip', () => {
    expect(clockScale('full', 1.3)).toBe(1.3);
    expect(clockScale('compact', 1.4)).toBe(1.15);
    expect(clockScale('mini', 1.3)).toBe(1);
    expect(clockScale('full', Number.NaN)).toBe(1);
    expect(clockScale('full', 0.2)).toBe(0.7);
    expect(digitHeight(17, clockScale('compact', 1.4))).toBe(137);
  });

  it('animates only when enabled, motion is allowed and a duration is set', () => {
    expect(shouldAnimate(true, false, 320)).toBe(true);
    expect(shouldAnimate(false, false, 320)).toBe(false);
    expect(shouldAnimate(true, true, 320)).toBe(false);
    expect(shouldAnimate(true, false, 0)).toBe(false);
  });

  it('maps digits to seven-segment patterns', () => {
    expect(segmentsFor('8')).toBe('abcdefg');
    expect(segmentsFor('1')).toBe('bc');
    expect(segmentsFor(' ')).toBe('');
    expect(segmentsFor('x')).toBe('');
  });
});

describe('split-flap animation', () => {
  it('does not animate on first render', () => {
    render(face('12:43'));
    expect(shown()).toBe('1243');
    expect(flipping()).toEqual([]);
  });

  it('flips only the digits that change, then settles on the new value', () => {
    vi.useFakeTimers();
    const { rerender } = render(face('12:59'));
    rerender(face('13:00'));
    expect(flipping()).toEqual([1, 2, 3]); // cards: 1 2 | 5 9 → 1 3 | 0 0 (colon is not a card)
    expect(screen.getAllByTestId('leaf')).toHaveLength(3);
    expect(shown()).toBe('1300');
    act(() => {
      vi.advanceTimersByTime(320 + 100);
    });
    expect(flipping()).toEqual([]);
    expect(screen.queryAllByTestId('leaf')).toHaveLength(0);
    expect(shown()).toBe('1300');
  });

  it('handles 09:59 → 10:00 and 23:59 → 00:00 rollovers', () => {
    vi.useFakeTimers();
    const { rerender } = render(face('09:59'));
    rerender(face('10:00'));
    expect(flipping()).toEqual([0, 1, 2, 3]);
    act(() => void vi.advanceTimersByTime(500));
    rerender(face('23:59'));
    act(() => void vi.advanceTimersByTime(500));
    rerender(face('00:00'));
    expect(flipping()).toEqual([0, 1, 2, 3]);
    act(() => void vi.advanceTimersByTime(500));
    expect(shown()).toBe('0000');
  });

  it('keeps the old lower half until the new one lands (no overlap or flash)', () => {
    vi.useFakeTimers();
    const { rerender, container } = render(face('12:43'));
    rerender(face('12:44'));
    const card = flaps()[3]!;
    const halves = card.querySelectorAll('.fl-flap__half');
    expect(halves[0]!.textContent).toBe('4'); // static top: new
    expect(halves[1]!.textContent).toBe('3'); // static bottom: still old
    expect(halves[2]!.textContent).toBe('3'); // leaf A: old top falling
    expect(halves[3]!.textContent).toBe('4'); // leaf B: new bottom landing
    act(() => void vi.advanceTimersByTime(500));
    expect(container.querySelectorAll('.fl-flap')[3]!.querySelectorAll('.fl-flap__half')[1]!.textContent).toBe('4');
  });

  it('restarts cleanly when a new value arrives mid-flip', () => {
    vi.useFakeTimers();
    const { rerender } = render(face('12:43'));
    rerender(face('12:44'));
    act(() => void vi.advanceTimersByTime(100));
    rerender(face('12:45'));
    const leaf = flaps()[3]!.querySelector('[data-testid=leaf]')!;
    expect(leaf.textContent).toBe('4'); // flips from the last target, not from a stale value
    expect(screen.getAllByTestId('leaf')).toHaveLength(1);
    act(() => void vi.advanceTimersByTime(500));
    expect(shown()).toBe('1245');
    expect(flipping()).toEqual([]);
  });

  it('after sleep/resume each digit flips once to the current time, without replaying missed minutes', () => {
    vi.useFakeTimers();
    const { rerender } = render(face('10:00'));
    rerender(face('14:37')); // the next backend tick after waking
    expect(flipping()).toEqual([1, 2, 3]);
    expect(screen.getAllByTestId('leaf')).toHaveLength(3);
    act(() => void vi.advanceTimersByTime(500));
    expect(shown()).toBe('1437');
    expect(screen.queryAllByTestId('leaf')).toHaveLength(0);
  });

  it('switches instantly when animation is disabled', () => {
    const { rerender } = render(face('12:43', { animate: false }));
    rerender(face('12:44', { animate: false }));
    expect(flipping()).toEqual([]);
    expect(shown()).toBe('1244');
  });

  it('blinks the colon without touching the digits', () => {
    const { rerender, container } = render(face('12:43'));
    rerender(face('12;43'));
    expect(container.querySelector('.fl-flaps__colon')).toHaveClass('is-off');
    expect(flipping()).toEqual([]);
  });
});

describe('DigitalClock', () => {
  const props = (c: Partial<ClockSettings>, h = home(12, 43)) => ({ home: h, clock: clock(c), pitch: 28, layout: 'full' as const });

  it('renders every template', () => {
    for (const t of ['dotMatrix', 'splitFlap', 'sevenSegment', 'terminal', 'minimal'] as ClockTemplate[]) {
      const { container, unmount } = render(<DigitalClock {...props({ template: t })} />);
      expect(container.querySelector('.fl-clockwrap')).toHaveAttribute('data-template', t);
      expect(container.querySelector(`.fl-clockface--${t}`)).toBeInTheDocument();
      unmount();
    }
  });

  it('falls back to the default split-flap clock for an unknown template', () => {
    const { container } = render(<DigitalClock {...props({ template: 'hologram' as ClockTemplate })} />);
    expect(container.querySelector('.fl-clockface--splitFlap')).toBeInTheDocument();
  });

  it('formats 12-hour time with a fixed-width hour and AM/PM', () => {
    render(<DigitalClock {...props({ template: 'splitFlap', h24: false }, home(9, 41))} />);
    expect(shown()).toBe(' 941');
    expect(screen.getByText('AM')).toBeInTheDocument();
    expect(screen.getByRole('timer')).toHaveAccessibleName('9:41 AM');
  });

  it('respects reduced motion even with animation enabled', () => {
    setReducedMotion(true);
    const { rerender } = render(<DigitalClock {...props({ template: 'splitFlap', animate: true })} />);
    rerender(<DigitalClock {...props({ template: 'splitFlap', animate: true }, home(12, 44))} />);
    expect(flipping()).toEqual([]);
    expect(shown()).toBe('1244');
  });

  it('animates minute changes in real time when allowed', () => {
    vi.useFakeTimers();
    const { rerender } = render(<DigitalClock {...props({ template: 'splitFlap' })} />);
    rerender(<DigitalClock {...props({ template: 'splitFlap' }, home(12, 44))} />);
    expect(flipping()).toEqual([3]);
  });

  it('caps the digit size in compact layout', () => {
    const { container } = render(<DigitalClock home={home(12, 43)} clock={clock({ template: 'splitFlap', scale: 1.4 })} pitch={17} layout="compact" />);
    const faceEl = container.querySelector('.fl-clockface') as HTMLElement;
    expect(faceEl.style.getPropertyValue('--clock-h')).toBe('calc(var(--u, 1) * 137px)');
  });

  it('shows small seconds flaps that flip every second', () => {
    vi.useFakeTimers();
    const { rerender } = render(<DigitalClock {...props({ template: 'splitFlap', seconds: true }, home(12, 43, 9))} />);
    rerender(<DigitalClock {...props({ template: 'splitFlap', seconds: true }, home(12, 43, 10))} />);
    expect(flipping()).toEqual([4, 5]); // 4 main cards + "0","9" → "1","0"
  });
});
