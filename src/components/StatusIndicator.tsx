export type LedState = 'ok' | 'off' | 'warn' | 'pulse';

/** LED + short label, e.g. "● SYS 1S". */
export function StatusIndicator({ state, label, title }: { state: LedState; label: string; title?: string }) {
  const cls = state === 'off' ? ' is-off' : state === 'warn' ? ' is-warn' : state === 'pulse' ? ' is-pulse' : '';
  return (
    <span className="fl-ind" title={title} role="status">
      <i className={`fl-led${cls}`} aria-hidden="true" />
      <span className={state === 'warn' ? 'fl-warn' : undefined}>{label}</span>
    </span>
  );
}
