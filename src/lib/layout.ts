import type { BackgroundColor, FontChoice, Layout, LayoutPref } from './types';

export const FONTS: Record<FontChoice, string> = {
  jetbrains: '"JetBrains Mono", "Cascadia Mono", Consolas, monospace',
  cascadia: '"Cascadia Mono", "Cascadia Code", Consolas, monospace',
  consolas: 'Consolas, "Cascadia Mono", monospace',
};

export const BASE: Record<Layout, [number, number]> = {
  full: [1920, 1080],
  compact: [1280, 720],
  mini: [600, 260],
};

/** AUTO picks by client size: ≥1150×620 FULL, ≥600×300 COMPACT, else MINI. */
export function pickLayout(w: number, h: number, pref: LayoutPref): Layout {
  if (pref !== 'auto') return pref;
  if (w >= 1150 && h >= 620) return 'full';
  if (w >= 600 && h >= 300) return 'compact';
  return 'mini';
}

/** Every size is a 1080p design pixel times --u, computed from the client size, not DPI. */
export function scaleFor(w: number, h: number, layout: Layout, textScale = 1): number {
  const [bw, bh] = BASE[layout];
  const u = Math.min(w / bw, h / bh) * textScale;
  return Math.max(0.36, Math.min(1.5, u));
}

export const BOARD_BG = '#050505';

/** The board colour to paint: the desktop's solid colour, pure black, or the design token. */
export function boardColor(choice: BackgroundColor, desktopColor: string | null | undefined): string {
  if (choice === 'black') return '#000000';
  if (choice === 'desktop' && desktopColor && /^#[0-9a-f]{6}$/i.test(desktopColor)) return desktopColor.toLowerCase();
  return BOARD_BG;
}

/** "#0a0b0c" → "10, 11, 12" for use inside rgba(). */
export function hexToRgb(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  return `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`;
}

export const PITCH: Record<Layout, number> = { full: 28, compact: 17, mini: 10 };
