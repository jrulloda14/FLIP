import { useState } from 'react';
import { DotMatrix, DotMeter } from '../components/primitives';
import { Sheet } from '../components/controls';
import { ago, hhmmFromIso, pct, resetText } from '../lib/format';
import { useFlip } from '../lib/store';
import type { Confidence, ManualWindow, UsageSnapshot } from '../lib/types';

const CONFIDENCE: Record<Confidence, string> = {
  high: 'HIGH · DOCUMENTED SOURCE',
  medium: 'MEDIUM',
  low: 'LOW · UNDOCUMENTED FORMAT',
  userProvided: 'USER PROVIDED',
  demo: 'DEMO · NOT REAL USAGE',
};

const STATUS: Record<UsageSnapshot['status'], string> = {
  ok: 'CONNECTED',
  stale: 'STALE',
  loading: 'SYNCING…',
  unavailable: 'NOT CONNECTED',
  error: 'ERROR',
};

interface Draft {
  key: string;
  used: string;
  resetHours: string;
}

/** Validates the manual-entry form. Exported for tests. */
export function draftToWindows(drafts: Draft[], nowMs: number): { windows: ManualWindow[] } | { error: string } {
  const windows: ManualWindow[] = [];
  for (const d of drafts) {
    if (!d.key.trim() && !d.used.trim()) continue;
    const key = d.key.trim().toUpperCase();
    if (!/^[A-Z0-9]{1,4}$/.test(key)) return { error: 'WINDOW MUST BE 1–4 LETTERS OR DIGITS, E.G. 5H' };
    const used = Number(d.used);
    if (d.used.trim() === '' || !Number.isFinite(used) || used < 0 || used > 100) return { error: 'USED % MUST BE 0–100' };
    let resetsAt: string | null = null;
    if (d.resetHours.trim()) {
      const h = Number(d.resetHours);
      if (!Number.isFinite(h) || h < 0 || h > 24 * 31) return { error: 'RESET MUST BE 0–744 HOURS FROM NOW' };
      resetsAt = new Date(nowMs + h * 3_600_000).toISOString();
    }
    windows.push({ key, usedPercent: used, resetsAt });
  }
  if (windows.length === 0) return { error: 'ENTER AT LEAST ONE WINDOW' };
  return { windows };
}

function ManualForm({ p }: { p: UsageSnapshot }) {
  const { actions } = useFlip();
  const initial: Draft[] =
    p.sourceKind === 'manual' && p.windows.length
      ? p.windows.map((w) => ({ key: w.key, used: w.usedFraction === null ? '' : String(Math.round(w.usedFraction * 100)), resetHours: '' }))
      : [
          { key: '5H', used: '', resetHours: '' },
          { key: '7D', used: '', resetHours: '' },
        ];
  const [drafts, setDrafts] = useState<Draft[]>(initial);
  const [err, setErr] = useState<string | null>(null);
  const edit = (i: number, patch: Partial<Draft>) => setDrafts((d) => d.map((x, k) => (k === i ? { ...x, ...patch } : x)));
  const save = () => {
    const r = draftToWindows(drafts, Date.now());
    if ('error' in r) return setErr(r.error);
    setErr(null);
    void actions.setManualUsage(p.providerId, r.windows);
  };
  return (
    <div className="fl-detail">
      <div className="fl-sec fl-sec--flat">
        <span>MANUAL ENTRY</span>
        <span>COPY FROM YOUR ACCOUNT&apos;S USAGE PAGE</span>
      </div>
      {drafts.map((d, i) => (
        <div className="fl-manual" key={i}>
          <input className="fl-input fl-input--s" aria-label={`Window ${i + 1} key`} value={d.key} maxLength={4} onChange={(e) => edit(i, { key: e.target.value })} />
          <input
            className="fl-input fl-input--s"
            aria-label={`Window ${i + 1} used percent`}
            placeholder="%"
            inputMode="decimal"
            value={d.used}
            onChange={(e) => edit(i, { used: e.target.value })}
          />
          <span className="fl-ink3">% USED · RESETS IN</span>
          <input
            className="fl-input fl-input--s"
            aria-label={`Window ${i + 1} resets in hours`}
            placeholder="H"
            inputMode="decimal"
            value={d.resetHours}
            onChange={(e) => edit(i, { resetHours: e.target.value })}
          />
          <span className="fl-ink3">HOURS</span>
        </div>
      ))}
      {err && (
        <div className="fl-warn" role="alert">
          {err}
        </div>
      )}
      <div className="fl-timer__row">
        <button className="fl-btn fl-btn--primary" onClick={save}>
          SAVE VALUES
        </button>
        {p.sourceKind === 'manual' && (
          <button className="fl-btn" onClick={() => void actions.clearManualUsage(p.providerId)}>
            CLEAR
          </button>
        )}
      </div>
    </div>
  );
}

export function ProviderDetail({ providerId }: { providerId: string }) {
  const { state, actions } = useFlip();
  const p = state.ai.find((x) => x.providerId === providerId);
  const s = state.settings!;
  const tz = state.clock?.home.tz ?? 'UTC';
  const now = state.clock?.epochMs ?? Date.now();
  const close = () => actions.openOverlay(null);
  if (!p) {
    return (
      <Sheet label="Provider" title="AI USAGE" right={<button className="fl-ctl" onClick={close}>ESC CLOSE</button>}>
        <div className="fl-detail fl-ink3">PROVIDER NOT FOUND</div>
      </Sheet>
    );
  }
  const source = providerId === 'claude' ? s.ai.claude.source : s.ai.codex.source;
  const showManual = source === 'manual' || source === 'off' || p.status === 'unavailable';
  return (
    <Sheet
      label={`${p.displayName} usage`}
      className="fl-ov--ai"
      title={
        <>
          {p.displayName} · USAGE {p.isDemo && <span className="fl-tag">DEMO</span>}
        </>
      }
      right={
        <button className="fl-ctl" onClick={close}>
          ESC CLOSE
        </button>
      }
      footer={
        <>
          <button className="fl-btn" onClick={() => void actions.refreshAi()} disabled={state.aiRefreshing}>
            {state.aiRefreshing ? 'REFRESHING…' : 'REFRESH NOW'}
          </button>
          <button
            className="fl-btn"
            onClick={() => {
              actions.openOverlay('settings', 'AI');
            }}
          >
            SOURCE SETTINGS
          </button>
          <span className="grow" />
          <button className="fl-btn fl-btn--primary" onClick={close}>
            CLOSE <kbd>ESC</kbd>
          </button>
        </>
      }
    >
      <div className="fl-two">
        <div>
          {p.windows.length === 0 && (
            <div className="fl-detail">
              <div className="fl-ink2">{p.note ?? 'NO USAGE DATA'}</div>
              <div className="fl-ink3 fl-small">FLIP shows no percentage until a real source reports one.</div>
            </div>
          )}
          {p.windows.map((w) => {
            const v = w.expired ? null : w.usedFraction;
            return (
              <div className="fl-detail" key={w.key}>
                <div className="fl-sec fl-sec--flat">
                  <span>{w.label}</span>
                  <span>{resetText(w, now)}</span>
                </div>
                <div className="fl-detail__big">
                  {v === null ? (
                    <span className="fl-ink3 fl-big">--</span>
                  ) : (
                    <DotMatrix text={String(Math.round(v * 100))} pitch={11} ghost={s.clock.ghostDots} shape={s.clock.dotShape} />
                  )}
                  <span className="fl-ink2 fl-big">% USED</span>
                </div>
                <DotMeter value={v} cells={48} warnAt={s.ai.warnAt} label={`${w.label} used`} />
                {w.resetsAt && !w.expired && <div className="fl-ink3 fl-small">RESETS AT {hhmmFromIso(w.resetsAt, tz)} · REMAINING {pct(w.remainingFraction)}</div>}
              </div>
            );
          })}
          {showManual && !p.isDemo && <ManualForm p={p} />}
        </div>
        <div>
          <div className="fl-kv">
            <span>STATUS</span>
            <span className={p.status === 'error' ? 'fl-warn' : undefined}>{STATUS[p.status]}</span>
          </div>
          <div className="fl-kv">
            <span>SOURCE</span>
            <span>{p.sourceLabel}</span>
          </div>
          <div className="fl-kv">
            <span>CONFIDENCE</span>
            <span>{CONFIDENCE[p.confidence]}</span>
          </div>
          <div className="fl-kv">
            <span>DATA FROM</span>
            <span>{p.lastSuccessAt ? `${hhmmFromIso(p.lastSuccessAt, tz)} · ${ago(p.lastSuccessAt, now)}` : 'NEVER'}</span>
          </div>
          <div className="fl-kv">
            <span>LAST CHECK</span>
            <span>
              {hhmmFromIso(p.fetchedAt, tz)} · EVERY {s.ai.refreshMinutes} MIN
            </span>
          </div>
          <div className="fl-kv">
            <span>WARN AT</span>
            <span>{pct(s.ai.warnAt)}</span>
          </div>
          {p.note && (
            <div className="fl-kv">
              <span>NOTE</span>
              <span>{p.note}</span>
            </div>
          )}
          {p.error && (
            <div className="fl-kv">
              <span>ERROR</span>
              <span className="fl-warn fl-case">
                {p.error.code} · {p.error.message}
                {p.error.retryAt ? ` · RETRY ${hhmmFromIso(p.error.retryAt, tz)}` : ''}
              </span>
            </div>
          )}
          <div className="fl-detail fl-ink3 fl-small fl-case">
            {providerId === 'claude'
              ? 'Claude subscription limits are not available through the Anthropic API; API keys report API billing, not plan usage. FLIP reads the limits Claude Code already receives and shows them only when a session has reported them.'
              : 'ChatGPT plan limits for Codex are not available through the OpenAI API; API usage and billing are separate. FLIP can read the limits the Codex CLI records locally, an undocumented format that may change.'}
          </div>
        </div>
      </div>
    </Sheet>
  );
}
