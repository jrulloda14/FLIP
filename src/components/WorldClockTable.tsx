import type { CityTime } from '../lib/types';
import { FlipText } from './primitives';

/** Airport board: DESTINATION · CODE · TIME · DIFF. Always 24-hour. */
export function WorldClockTable({ cities }: { cities: CityTime[] }) {
  return (
    <div className="fl-board" role="table" aria-label="World clock">
      <div className="fl-board__r fl-board__h" role="row">
        <span role="columnheader">DESTINATION</span>
        <span role="columnheader">CODE</span>
        <span role="columnheader" className="r">
          TIME
        </span>
        <span role="columnheader" className="r">
          DIFF
        </span>
      </div>
      {cities.map((c) => (
        <div className="fl-board__r" role="row" key={c.tz + c.name} title={c.tz}>
          <span role="cell">{c.name}</span>
          <span role="cell">{c.code}</span>
          <span role="cell" className="r">
            {c.valid ? <FlipText text={c.time} /> : 'N/A'}
            {c.valid && c.dayShift !== 0 && <sup className="fl-dayshift">{c.dayShift > 0 ? '+1' : '-1'}</sup>}
          </span>
          <span role="cell" className="r">
            <FlipText text={c.valid ? c.diffLabel : '—'} />
          </span>
        </div>
      ))}
    </div>
  );
}
