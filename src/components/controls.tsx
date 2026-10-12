// Settings-sheet building blocks: segmented control, ON/OFF, rows and section heads.
import type { ReactNode } from 'react';

interface SegProps<T> {
  value: T;
  options: [T, string][];
  onChange: (v: T) => void;
  label?: string;
}

export function Seg<T extends string | number | boolean | null>({ value, options, onChange, label }: SegProps<T>) {
  return (
    <div className="fl-seg" role="radiogroup" aria-label={label}>
      {options.map(([v, text]) => {
        const on = v === value;
        return (
          <button key={String(v)} role="radio" aria-checked={on} className={on ? 'is-on' : undefined} onClick={() => onChange(v)}>
            {text}
          </button>
        );
      })}
    </div>
  );
}

export function OnOff({ value, onChange, label }: { value: boolean; onChange: (v: boolean) => void; label?: string }) {
  return (
    <Seg
      value={value}
      label={label}
      options={[
        [true, 'ON'],
        [false, 'OFF'],
      ]}
      onChange={onChange}
    />
  );
}

export function Row({ label, children, hint }: { label: ReactNode; children: ReactNode; hint?: ReactNode }) {
  return (
    <div className="fl-srow">
      <div className="fl-srow__l">{label}</div>
      <div className="fl-srow__c">{children}</div>
      <div className="fl-srow__hint">{hint}</div>
    </div>
  );
}

export function Head({ children }: { children: ReactNode }) {
  return <div className="fl-srow fl-srow--head">{children}</div>;
}

export function Sheet({
  title,
  right,
  children,
  footer,
  className,
  label,
}: {
  title: ReactNode;
  right?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
  label: string;
}) {
  return (
    <div className={`fl-ov ${className ?? ''}`} role="dialog" aria-modal="true" aria-label={label} onClick={(e) => e.stopPropagation()}>
      <div className="fl-sheet">
        <div className="fl-sheet__h" data-tauri-drag-region>
          <span data-tauri-drag-region>{title}</span>
          {right}
        </div>
        <div className="fl-sheet__b">{children}</div>
        {footer && <div className="fl-sheet__f">{footer}</div>}
      </div>
    </div>
  );
}
