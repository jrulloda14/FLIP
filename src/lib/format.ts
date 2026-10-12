// Pure display formatters. Everything the board prints is uppercase and fixed-width where possible.
import type { DateFormat, HomeTime, Phase, TempUnit, UsageWindow } from './types';

export const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

export const pad2 = (n: number) => String(Math.trunc(n)).padStart(2, '0');

export function clockText(h: HomeTime, h24: boolean): string {
  if (h24) return `${pad2(h.hour)}:${pad2(h.minute)}`;
  return `${h.hour % 12 || 12}:${pad2(h.minute)}`;
}

export function ampm(h: HomeTime, h24: boolean): string {
  return h24 ? '' : h.hour < 12 ? 'AM' : 'PM';
}

export function dateText(h: HomeTime, fmt: DateFormat): string {
  if (fmt === 'iso') return `${h.year}-${pad2(h.month)}-${pad2(h.day)}`;
  if (fmt === 'eu') return `${pad2(h.day)}.${pad2(h.month)}.${h.year}`;
  return `${h.weekday.slice(0, 3).toUpperCase()} ${pad2(h.day)} ${MONTHS[h.month - 1] ?? ''}`;
}

/** "+8", "-3:30", "+0". */
export function utcOffset(minutes: number): string {
  const sign = minutes < 0 ? '-' : '+';
  const a = Math.abs(minutes);
  const m = a % 60;
  return `${sign}${Math.floor(a / 60)}${m ? ':' + pad2(m) : ''}`;
}

export function dateMeta(h: HomeTime): string {
  return `WK ${pad2(h.isoWeek)} · UTC${utcOffset(h.utcOffsetMinutes)}`;
}

export function mmss(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${pad2(Math.floor(s / 60))}:${pad2(s % 60)}`;
}

export function hhmmFromIso(iso: string, tz: string): string {
  try {
    return new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(
      new Date(iso),
    );
  } catch {
    return '--:--';
  }
}

export function pct(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return 'N/A';
  return `${Math.round(v * 100)}%`;
}

export function temp(c: number | null | undefined, unit: TempUnit): string {
  if (c === null || c === undefined || !Number.isFinite(c)) return 'N/A';
  return unit === 'F' ? `${Math.round((c * 9) / 5 + 32)}°F` : `${Math.round(c)}°C`;
}

const GB = 1024 ** 3;
export function gb(bytes: number, digits = 1): string {
  return (bytes / GB).toFixed(digits);
}

/** Network rate in MB/s with one decimal, or KB/s below 0.1 MB/s. */
export function rate(bytesPerSec: number | null | undefined): string {
  if (bytesPerSec === null || bytesPerSec === undefined || !Number.isFinite(bytesPerSec)) return 'N/A';
  const mb = bytesPerSec / 1024 ** 2;
  if (mb >= 0.1) return `${mb.toFixed(1)} MB/S`;
  return `${Math.round(bytesPerSec / 1024)} KB/S`;
}

export function rateShort(bytesPerSec: number | null | undefined): string {
  if (bytesPerSec === null || bytesPerSec === undefined || !Number.isFinite(bytesPerSec)) return 'N/A';
  return (bytesPerSec / 1024 ** 2).toFixed(1);
}

export function uptime(secs: number): string {
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  return `UP ${d}D ${pad2(h)}H`;
}

/** "2D 3H 4M", "45M", "0M". */
export function duration(ms: number): string {
  const min = Math.max(0, Math.round(ms / 60000));
  const d = Math.floor(min / 1440);
  const h = Math.floor((min % 1440) / 60);
  const m = min % 60;
  return `${d ? d + 'D ' : ''}${h || d ? h + 'H ' : ''}${m}M`;
}

export function focusTotal(secs: number): string {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  return h ? `${h}H ${pad2(m)}M` : `${m}M`;
}

export const PHASE_LABEL: Record<Phase, string> = {
  idle: 'READY',
  focus: 'FOCUS',
  shortBreak: 'SHORT BREAK',
  longBreak: 'LONG BREAK',
};

/** ■ done, ▣ current, □ upcoming. */
export function sessionDots(session: number, sessions: number, phase: Phase): string {
  let s = '';
  for (let i = 1; i <= sessions; i++) {
    const inBreak = phase === 'shortBreak' || phase === 'longBreak';
    if (i < session || (i === session && inBreak)) s += '■';
    else if (i === session) s += '▣';
    else s += '□';
  }
  return s;
}

/** "RESETS IN 2H 15M", "RESET · AWAITING NEW DATA", or "". */
export function resetText(w: UsageWindow, nowMs: number): string {
  if (w.expired) return 'RESET · AWAITING NEW DATA';
  if (!w.resetsAt) return '';
  const ms = Date.parse(w.resetsAt) - nowMs;
  if (!Number.isFinite(ms)) return '';
  if (ms <= 0) return 'RESET · AWAITING NEW DATA';
  return `RESETS IN ${duration(ms)}`;
}

export function ago(iso: string | null, nowMs: number): string {
  if (!iso) return 'NEVER';
  const ms = nowMs - Date.parse(iso);
  if (!Number.isFinite(ms)) return 'UNKNOWN';
  if (ms < 60_000) return 'JUST NOW';
  return `${duration(ms)} AGO`;
}
