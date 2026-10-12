import type { ReactNode } from 'react';
import { gb, pct, rate, rateShort, temp, uptime } from '../lib/format';
import type { SystemSettings, SystemSnapshot } from '../lib/types';
import { DotMeter, DotPlot, FlipText } from './primitives';

interface Props {
  sys: SystemSnapshot | null;
  cfg: SystemSettings;
  /** Focus active: drop the optional rows (plot, disks, meta). */
  condensed: boolean;
  onOpen: () => void;
}

/** Scales a history to 0..1 against its own peak, so the plot shows shape rather than absolute rate. */
export function normalizeHistory(values: number[]): number[] {
  const peak = Math.max(...values, 1);
  return values.map((v) => v / peak);
}

function Val({ v, className = 'r' }: { v: string; className?: string }) {
  return <span className={`${className}${v === 'N/A' ? ' fl-ink3' : ''}`}>{v === 'N/A' ? v : <FlipText text={v} />}</span>;
}

export function SystemMonitor({ sys, cfg, condensed, onOpen }: Props) {
  const row = (label: string, meter: ReactNode, value: string, sub: string, key?: string, opt = false) => (
    <div className={`fl-mrow fl-hit${opt ? ' fl-opt' : ''}`} key={key ?? label} onClick={onOpen} role="row">
      <span>{label}</span>
      {meter}
      <b className="r">
        <Val v={value} className="" />
      </b>
      <Val v={sub} />
    </div>
  );
  if (!sys) {
    return (
      <section className="fl-blk fl-blk--sys" aria-label="System monitor">
        <div className="fl-sec">
          <span>SYSTEM</span>
          <span>SAMPLING…</span>
        </div>
        <div className="fl-mrow">
          <span className="fl-ink3">WAITING FOR FIRST SAMPLE</span>
        </div>
      </section>
    );
  }
  const memFrac = sys.memory.totalBytes ? sys.memory.usedBytes / sys.memory.totalBytes : null;
  return (
    <section className="fl-blk fl-blk--sys" aria-label="System monitor" title="System monitor detail">
      <div className="fl-sec">
        <span>SYSTEM</span>
        <span>{sys.hostname}</span>
      </div>
      {row('CPU', <DotMeter value={sys.cpu.usage} cells={30} />, pct(sys.cpu.usage), cfg.temps ? temp(sys.cpu.temperatureC, cfg.tempUnit) : '')}
      {cfg.plot && !condensed && (
        <div className="fl-mrow fl-mrow--plot fl-opt">
          <span>LOAD 60S</span>
          <DotPlot values={sys.cpuHistory} rows={5} pitch={7} />
        </div>
      )}
      {row(
        'RAM',
        <DotMeter value={memFrac} cells={30} />,
        `${gb(sys.memory.usedBytes)} / ${gb(sys.memory.totalBytes)} GB`,
        pct(memFrac),
      )}
      {cfg.gpu &&
        row(
          'GPU',
          <DotMeter value={sys.gpu.usage} cells={30} />,
          pct(sys.gpu.usage),
          cfg.temps ? temp(sys.gpu.temperatureC, cfg.tempUnit) : '',
        )}
      {cfg.net &&
        row(
          'NET',
          <DotPlot values={normalizeHistory(sys.rxHistory)} rows={3} pitch={7} />,
          sys.network.rxBytesPerSec === null ? 'N/A' : `↓ ${rate(sys.network.rxBytesPerSec)}`,
          sys.network.txBytesPerSec === null ? 'N/A' : `↑ ${rateShort(sys.network.txBytesPerSec)}`,
        )}
      {cfg.disk &&
        !condensed &&
        sys.disks.slice(0, 4).map((d) =>
          row(
            `DISK ${d.mount}`,
            <DotMeter value={d.totalBytes ? d.usedBytes / d.totalBytes : null} cells={30} />,
            `${gb(d.usedBytes, 0)} / ${gb(d.totalBytes, 0)} GB`,
            pct(d.totalBytes ? d.usedBytes / d.totalBytes : null),
            d.mount,
            true,
          ),
        )}
      {!condensed && (
        <div className="fl-meta fl-opt">
          {uptime(sys.uptimeSecs)} · {sys.processCount} PROCS
        </div>
      )}
    </section>
  );
}
