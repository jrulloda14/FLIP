// Pure helpers for Clock Studio. Time itself always comes from the backend tick; nothing here
// keeps or advances time.
import { useSyncExternalStore } from 'react';
import type { ClockInk, ClockTemplate, Layout } from './types';

export const TEMPLATES: { id: ClockTemplate; label: string; hint: string }[] = [
  { id: 'dotMatrix', label: 'DOT MATRIX', hint: 'The FLIP board: 5×7 LED dots' },
  { id: 'splitFlap', label: 'SPLIT FLAP', hint: 'Mechanical airport flaps; only changing digits flip' },
  { id: 'sevenSegment', label: 'SEVEN SEGMENT', hint: 'Digital LED segments' },
  { id: 'terminal', label: 'TERMINAL', hint: 'Monospaced console text' },
  { id: 'minimal', label: 'MINIMAL', hint: 'Large, clean numerals' },
];

const KNOWN = new Set<ClockTemplate>(TEMPLATES.map((t) => t.id));

/** Unknown or missing template ids fall back to the original dot-matrix clock. */
export function safeTemplate(t: string | null | undefined): ClockTemplate {
  return t && KNOWN.has(t as ClockTemplate) ? (t as ClockTemplate) : 'dotMatrix';
}

/**
 * Fixed-width clock text for per-digit faces: 12-hour times get a leading blank ("9:41" →
 * " 9:41") so every digit keeps the same position, and therefore the same component key,
 * when the hour goes from 9 to 10.
 */
export function fixedWidth(text: string): string {
  return /^\d[:;]/.test(text) ? ' ' + text : text;
}

/** Indices whose character changed. Strings of different length count every position. */
export function changedIndices(prev: string, next: string): number[] {
  const out: number[] = [];
  const n = Math.max(prev.length, next.length);
  for (let i = 0; i < n; i++) if (prev.charAt(i) !== next.charAt(i)) out.push(i);
  return out;
}

/** Largest clock scale each layout can take without the digits clipping. */
export const MAX_SCALE: Record<Layout, number> = { full: 1.4, compact: 1.15, mini: 1.0 };

export function clockScale(layout: Layout, scale: number): number {
  const s = Number.isFinite(scale) ? scale : 1;
  return Math.max(0.7, Math.min(MAX_SCALE[layout], s));
}

/** Digit height in 1080p design pixels: the dot-matrix height (7 dots) at the layout's pitch. */
export function digitHeight(pitch: number, scale: number): number {
  return Math.round(7 * pitch * scale);
}

export const INK_VAR: Record<ClockInk, string> = { bright: 'var(--ink)', soft: 'var(--ink-1)', dim: 'var(--ink-2)' };

/** Effective animation: off when disabled, when the OS asks for reduced motion, or with no duration. */
export function shouldAnimate(enabled: boolean, reducedMotion: boolean, ms: number): boolean {
  return enabled && !reducedMotion && ms > 0;
}

// ---------------------------------------------------------------- reduced motion (shared, one listener)

const QUERY = '(prefers-reduced-motion: reduce)';

function subscribe(cb: () => void): () => void {
  let mql: MediaQueryList | null = null;
  try {
    mql = window.matchMedia(QUERY);
  } catch {
    return () => {};
  }
  mql.addEventListener?.('change', cb);
  return () => mql?.removeEventListener?.('change', cb);
}

function snapshot(): boolean {
  try {
    return window.matchMedia(QUERY).matches;
  } catch {
    return false;
  }
}

/** Live `prefers-reduced-motion`; re-renders when Windows' animation setting changes. */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, snapshot, () => false);
}
