import { ago, pct } from '../lib/format';
import type { UsageSnapshot } from '../lib/types';
import { DotMeter, FlipText } from './primitives';

interface Props {
  providers: UsageSnapshot[];
  warnAt: number;
  nowMs: number;
  /** Dots per meter. */
  cells?: number;
  onOpen: (providerId: string) => void;
}

const healthy = (p: UsageSnapshot) => p.status === 'ok' || p.status === 'stale';

/** Columns are the union of window keys across healthy providers, in first-seen order. */
export function usageColumns(providers: UsageSnapshot[]): string[] {
  const keys: string[] = [];
  for (const p of providers) {
    if (!healthy(p)) continue;
    for (const w of p.windows) if (!keys.includes(w.key)) keys.push(w.key);
  }
  return keys;
}

export function AIUsageTable({ providers, warnAt, nowMs, cells = 22, onOpen }: Props) {
  const keys = usageColumns(providers);
  if (providers.length === 0) {
    return (
      <div className="fl-usage" style={{ gridTemplateColumns: 'auto' }}>
        <div className="fl-usage__span is-dim">AI USAGE · NO PROVIDERS ENABLED</div>
      </div>
    );
  }
  return (
    <div className="fl-usage" role="table" aria-label="AI usage" style={{ gridTemplateColumns: `auto repeat(${Math.max(1, keys.length)}, auto)` }}>
      {providers.map((p) => {
        const open = () => onOpen(p.providerId);
        const hit = { onClick: open, title: `${p.displayName} usage detail`, role: 'button', tabIndex: 0 } as const;
        const name = (
          <div className={`fl-usage__name fl-hit${p.status === 'unavailable' ? ' is-dim' : ''}`} {...hit}>
            {p.displayName}
            {p.isDemo && <span className="fl-tag">DEMO</span>}
          </div>
        );
        const span = { gridColumn: `2 / span ${Math.max(1, keys.length)}` };
        if (p.status === 'loading') {
          return (
            <div className="fl-usage__row" role="row" key={p.providerId}>
              {name}
              <div className="fl-usage__slot fl-usage__span fl-hit" style={span} {...hit}>
                <div className="fl-usage__val fl-ink2">SYNCING</div>
                <DotMeter value={0} cells={22} loading />
              </div>
            </div>
          );
        }
        if (p.status === 'unavailable') {
          return (
            <div className="fl-usage__row" role="row" key={p.providerId}>
              {name}
              <div className="fl-usage__span is-dim fl-hit" style={span} {...hit}>
                {p.note ?? 'NO DATA · NOT CONNECTED'}
              </div>
            </div>
          );
        }
        if (p.status === 'error') {
          return (
            <div className="fl-usage__row" role="row" key={p.providerId}>
              {name}
              <div className="fl-usage__slot fl-usage__span fl-hit" style={span} {...hit}>
                <div className="fl-usage__val fl-warn">ERR · {p.error?.code ?? 'UNKNOWN'}</div>
                <div className="fl-usage__meta">{p.error?.retryAt ? 'RETRYING · CLICK FOR DETAILS' : 'CLICK FOR DETAILS'}</div>
              </div>
            </div>
          );
        }
        return (
          <div className="fl-usage__row" role="row" key={p.providerId}>
            {name}
            {keys.map((k) => {
              const w = p.windows.find((x) => x.key === k);
              if (!w) return <div key={k} />;
              const value = w.expired ? null : w.usedFraction;
              return (
                <div className="fl-usage__slot fl-hit" key={k} {...hit}>
                  <div className={`fl-usage__val${p.status === 'stale' ? ' fl-ink2' : ''}`}>
                    <span>{k}</span>
                    <FlipText text={w.expired ? '--%' : pct(value)} />
                  </div>
                  <DotMeter value={value} cells={cells} warnAt={warnAt} label={`${p.displayName} ${k} used`} />
                </div>
              );
            })}
            {p.status === 'stale' && (
              <div className="fl-usage__meta" style={span}>
                STALE · UPDATED {ago(p.lastSuccessAt, nowMs)}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
