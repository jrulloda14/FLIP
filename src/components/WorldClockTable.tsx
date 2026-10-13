import { useLayoutEffect, useRef, useState } from 'react';
import { cityClock } from '../lib/format';
import type { CityTime } from '../lib/types';
import { FlipText } from './primitives';

const SHIFT: Record<number, string> = { [-1]: 'Previous day', 1: 'Next day' };

/** Indexes of rows that don't fit entirely inside `box` (1px tolerance for rounding). */
export function rowsOutside(box: DOMRect, rows: DOMRect[]): number[] {
  return rows.flatMap((r, i) => (r.bottom > box.bottom + 1 || r.right > box.right + 1 ? [i] : []));
}

/** Hides whole rows that don't fit the space the layout gives the board, instead of letting
 *  them run into other modules or cutting one in half. Rows stay in the layout (invisible),
 *  so the measurement is stable as the window resizes. */
function useFitRows(count: number) {
  const ref = useRef<HTMLDivElement>(null);
  const [cut, setCut] = useState<number[]>([]);
  useLayoutEffect(() => {
    const board = ref.current;
    const box = board?.closest('.fl-slot') ?? board?.parentElement;
    if (!board || !box) return;
    const measure = () => {
      const rows = Array.from(board.querySelectorAll<HTMLElement>('[data-city]'));
      const next = rowsOutside(
        box.getBoundingClientRect(),
        rows.map((r) => r.getBoundingClientRect()),
      );
      setCut((prev) => (prev.length === next.length && prev.every((v, i) => v === next[i]) ? prev : next));
    };
    measure();
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    ro?.observe(box);
    window.addEventListener('resize', measure);
    return () => {
      ro?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [count]);
  return { ref, cut };
}

/** Airport board: DESTINATION · CODE · DAY · TIME · DIFF. Times follow the main clock's
 *  12/24-hour setting. The day is dimmed when it matches home and lit when it doesn't. */
export function WorldClockTable({ cities, h24 }: { cities: CityTime[]; h24: boolean }) {
  const { ref, cut } = useFitRows(cities.length);
  return (
    <div ref={ref} className={`fl-board fl-board--world${h24 ? '' : ' is-12h'}`} role="table" aria-label="World clock">
      <div className="fl-board__r fl-board__h" role="row">
        <span role="columnheader">
          DESTINATION
          {cut.length > 0 && (
            <span
              className="fl-board__more"
              title={`${cut.length} more ${cut.length === 1 ? 'city' : 'cities'} don't fit here. Enlarge FLIP, pick a larger region, or remove cities in Settings › Locations`}
            >
              {' '}+{cut.length}
              <span className="sr-only"> more cities not shown</span>
            </span>
          )}
        </span>
        <span role="columnheader">CODE</span>
        <span role="columnheader">DAY</span>
        <span role="columnheader" className="r">
          TIME
        </span>
        <span role="columnheader" className="r">
          DIFF
        </span>
      </div>
      {cities.map((c, i) => (
        <div
          className={`fl-board__r${cut.includes(i) ? ' is-cut' : ''}`}
          role="row"
          key={c.tz + c.name}
          title={c.tz}
          data-city
          aria-hidden={cut.includes(i) || undefined}
        >
          <span role="cell">{c.name}</span>
          <span role="cell">{c.code}</span>
          <span
            role="cell"
            className={`fl-day${c.valid && c.dayShift !== 0 ? ' is-shift' : ''}`}
            title={c.valid && c.dayShift !== 0 ? SHIFT[c.dayShift] : 'Same day as home'}
          >
            {c.valid ? <FlipText text={c.date} /> : '—'}
          </span>
          <span role="cell" className="r">
            {c.valid ? <FlipText text={cityClock(c.hour, c.minute, h24)} /> : 'N/A'}
          </span>
          <span role="cell" className="r">
            <FlipText text={c.valid ? c.diffLabel : '—'} />
          </span>
        </div>
      ))}
    </div>
  );
}
