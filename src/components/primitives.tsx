// React ports of design/components/flip.js: DotMatrix, FlipText, DotMeter, DotPlot.
import { memo, useEffect, useRef, useState, type CSSProperties } from 'react';
import type { DotShape } from '../lib/types';

export const GLYPHS: Record<string, string[]> = {
  '0': ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  '2': ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  '3': ['11111', '00010', '00100', '00010', '00001', '10001', '01110'],
  '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  '5': ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  '6': ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  '9': ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
  ':': ['0', '0', '1', '0', '1', '0', '0'],
  ';': ['0', '0', '0', '0', '0', '0', '0'], // colon "off" frame for blinking
  '.': ['0', '0', '0', '0', '0', '0', '1'],
  '-': ['000', '000', '000', '111', '000', '000', '000'],
  ' ': ['000', '000', '000', '000', '000', '000', '000'],
};
const BLANK = GLYPHS[' ']!;

export function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

interface Dot {
  x: number;
  y: number;
  on: boolean;
  delay: number;
}

/** Lays out the dots for a string. Exported for tests. */
export function matrixDots(text: string, gap = 1): { cols: number; dots: Dot[] } {
  const glyphs = text.split('').map((c) => GLYPHS[c] ?? BLANK);
  const dots: Dot[] = [];
  let x = 0;
  glyphs.forEach((g, gi) => {
    const w = g[0]!.length;
    for (let c = 0; c < w; c++) {
      for (let r = 0; r < 7; r++) {
        dots.push({ x: x + c, y: r, on: g[r]!.charAt(c) === '1', delay: (x + c) * 9 + r * 6 });
      }
    }
    x += w + (gi < glyphs.length - 1 ? gap : 0);
  });
  return { cols: x, dots };
}

interface DotMatrixProps {
  text: string;
  pitch: number;
  ghost?: boolean;
  shape?: DotShape;
  warn?: boolean;
  className?: string;
  label?: string;
  /** Empty columns between glyphs (fractional allowed). Default 1. */
  gap?: number;
  /** Switch dots without the fade (animation off). */
  instant?: boolean;
  /** Hide from assistive tech when a parent already labels the time. */
  decorative?: boolean;
}

/** 5×7 dot-matrix text. Dot diameter is 72% of the pitch; sizes scale with --u. */
export const DotMatrix = memo(function DotMatrix({ text, pitch, ghost = true, shape = 'round', warn, className, label, gap = 1, instant, decorative }: DotMatrixProps) {
  const { cols, dots } = matrixDots(text, gap);
  const s = 0.72;
  const style: CSSProperties = {
    width: `calc(var(--u, 1) * ${cols * pitch}px)`,
    height: `calc(var(--u, 1) * ${7 * pitch}px)`,
  };
  const cls = ['fl-matrix', ghost ? '' : 'no-ghost', warn ? 'fl-matrix--warn' : '', instant || prefersReducedMotion() ? 'is-instant' : '', className ?? '']
    .filter(Boolean)
    .join(' ');
  return (
    <svg
      className={cls}
      viewBox={`0 0 ${cols} 7`}
      style={style}
      role={decorative ? undefined : 'img'}
      aria-hidden={decorative ? true : undefined}
      aria-label={decorative ? undefined : (label ?? text.replace(';', ':'))}
    >
      {dots.map((d) =>
        shape === 'square' ? (
          <rect
            key={`${d.x},${d.y}`}
            x={d.x + (1 - s) / 2}
            y={d.y + (1 - s) / 2}
            width={s}
            height={s}
            rx={s * 0.12}
            className={d.on ? 'on' : undefined}
            style={{ transitionDelay: `${d.delay}ms` }}
          />
        ) : (
          <circle
            key={`${d.x},${d.y}`}
            cx={d.x + 0.5}
            cy={d.y + 0.5}
            r={s / 2}
            className={d.on ? 'on' : undefined}
            style={{ transitionDelay: `${d.delay}ms` }}
          />
        ),
      )}
    </svg>
  );
});

const SCRAMBLE = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const FIXED = ' :./%-+·°↓↑×–()';

/** Split-flap text: changed characters scramble, then settle left to right (~250ms). */
export function FlipText({ text, className, title }: { text: string; className?: string; title?: string }) {
  const [shown, setShown] = useState(text);
  const prev = useRef(text);
  useEffect(() => {
    const from = prev.current;
    prev.current = text;
    if (from === text) return;
    if (prefersReducedMotion() || !from) {
      setShown(text);
      return;
    }
    let f = 0;
    const n = text.length;
    const id = window.setInterval(() => {
      f++;
      let s = '';
      for (let i = 0; i < n; i++) {
        const ch = text.charAt(i);
        if (f >= i * 1.1 + 3 || ch === from.charAt(i) || FIXED.includes(ch)) s += ch;
        else s += SCRAMBLE.charAt((Math.random() * 36) | 0);
      }
      setShown(s);
      if (f > n * 1.1 + 3) {
        window.clearInterval(id);
        setShown(text);
      }
    }, 34);
    return () => {
      window.clearInterval(id);
      setShown(text);
    };
  }, [text]);
  return (
    <span className={className} title={title} aria-label={text}>
      {shown}
    </span>
  );
}

interface MeterProps {
  value: number | null;
  cells?: number;
  warnAt?: number;
  loading?: boolean;
  square?: boolean;
  className?: string;
  label?: string;
}

/** Dotted meter: the first round(v × cells) dots are lit. Amber at or above warnAt. */
export const DotMeter = memo(function DotMeter({ value, cells = 24, warnAt = 2, loading, square, className, label }: MeterProps) {
  const v = Math.max(0, Math.min(1, value ?? 0));
  const lit = loading ? 0 : Math.round(v * cells);
  const warn = !loading && value !== null && v >= warnAt;
  const cls = ['fl-meter', square ? 'fl-meter--sq' : '', loading ? 'is-loading' : '', warn ? 'is-warn' : '', className ?? '']
    .filter(Boolean)
    .join(' ');
  return (
    <div
      className={cls}
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={value === null ? undefined : Math.round(v * 100)}
    >
      {Array.from({ length: cells }, (_, i) => (
        <i key={i} className={i < lit ? 'on' : undefined} style={loading ? { animationDelay: `${i * 55}ms` } : undefined} />
      ))}
    </div>
  );
});

/** Dot plot: one column per sample (0..1), `rows` dots tall, lit from the bottom. */
export const DotPlot = memo(function DotPlot({ values, rows = 6, pitch = 8 }: { values: number[]; rows?: number; pitch?: number }) {
  const cols = Math.max(1, values.length);
  const rects = [];
  for (let c = 0; c < values.length; c++) {
    const level = Math.round(Math.max(0, Math.min(1, values[c] ?? 0)) * rows);
    for (let r = 0; r < rows; r++) {
      rects.push(<rect key={`${c},${r}`} x={c + 0.2} y={r + 0.2} width={0.6} height={0.6} className={rows - r <= level ? 'on' : undefined} />);
    }
  }
  return (
    <svg
      className="fl-plot"
      viewBox={`0 0 ${cols} ${rows}`}
      preserveAspectRatio="none"
      aria-hidden="true"
      style={{ height: `calc(var(--u, 1) * ${rows * pitch}px)` }}
    >
      {rects}
    </svg>
  );
});
