import { describe, expect, it } from 'vitest';
import { ago, bytes, cityClock, clockText, dateMeta, dateText, duration, missing, mmss, orMissing, pct, rate, resetText, sessionDots, temp, utcOffset } from './format';
import { boardColor, hexToRgb, pickLayout, scaleFor } from './layout';
import type { HomeTime } from './types';

const home: HomeTime = { tz: 'Asia/Singapore', year: 2026, month: 10, day: 6, hour: 12, minute: 43, second: 7, weekday: 'TUE', isoWeek: 41, utcOffsetMinutes: 480 };

describe('format', () => {
  it('formats the clock in 24h and 12h', () => {
    expect(clockText(home, true)).toBe('12:43');
    expect(clockText({ ...home, hour: 0 }, false)).toBe('12:43');
    expect(clockText({ ...home, hour: 15 }, false)).toBe('3:43');
    expect(clockText({ ...home, hour: 7 }, true)).toBe('07:43');
  });

  it('formats dates', () => {
    expect(dateText(home, 'dow')).toBe('TUE 06 OCT');
    expect(dateText(home, 'iso')).toBe('2026-10-06');
    expect(dateText(home, 'eu')).toBe('06.10.2026');
    expect(dateMeta(home)).toBe('WK 41 · UTC+8');
    expect(utcOffset(-210)).toBe('-3:30');
    expect(utcOffset(0)).toBe('+0');
  });

  it('never prints a number for missing values', () => {
    expect(pct(null)).toBe('N/A');
    expect(pct(Number.NaN)).toBe('N/A');
    expect(temp(null, 'C')).toBe('N/A');
    expect(rate(null)).toBe('N/A');
    expect(pct(0.345)).toBe('35%');
    expect(temp(50, 'F')).toBe('122°F');
  });

  it('formats rates and durations', () => {
    expect(rate(12.4 * 1024 * 1024)).toBe('12.4 MB/S');
    expect(rate(20 * 1024)).toBe('20 KB/S');
    expect(mmss(25 * 60_000)).toBe('25:00');
    expect(mmss(59_001)).toBe('01:00');
    expect(duration((2 * 1440 + 3 * 60 + 4) * 60_000)).toBe('2D 3H 4M');
    expect(duration(45 * 60_000)).toBe('45M');
  });

  it('shows session dots', () => {
    expect(sessionDots(2, 4, 'focus')).toBe('■▣□□');
    expect(sessionDots(2, 4, 'shortBreak')).toBe('■■□□');
    expect(sessionDots(1, 4, 'idle')).toBe('▣□□□');
  });

  it('describes resets and data age', () => {
    const now = Date.parse('2026-10-06T04:43:00Z');
    const w = { key: '5H', label: '', usedFraction: 0.5, remainingFraction: 0.5, resetsAt: '2026-10-06T07:00:00Z', expired: false };
    expect(resetText(w, now)).toBe('RESETS IN 2H 17M');
    expect(resetText({ ...w, expired: true }, now)).toBe('RESET · AWAITING NEW DATA');
    expect(resetText({ ...w, resetsAt: null }, now)).toBe('');
    expect(ago(null, now)).toBe('NEVER');
    expect(ago('2026-10-06T04:42:30Z', now)).toBe('JUST NOW');
    expect(ago('2026-10-06T01:43:00Z', now)).toBe('3H 0M AGO');
  });
});

describe('board colour', () => {
  it('matches the desktop, falls back to the board token, or uses pure black', () => {
    expect(boardColor('desktop', '#000000')).toBe('#000000');
    expect(boardColor('desktop', '#1E3A5F')).toBe('#1e3a5f');
    expect(boardColor('desktop', null)).toBe('#050505'); // wallpaper image: nothing solid to match
    expect(boardColor('desktop', 'bogus')).toBe('#050505');
    expect(boardColor('black', '#123456')).toBe('#000000');
    expect(boardColor('board', '#000000')).toBe('#050505');
    expect(hexToRgb('#050505')).toBe('5, 5, 5');
    expect(hexToRgb('#1e3a5f')).toBe('30, 58, 95');
  });
});

describe('layout', () => {
  it('picks layouts by size unless forced', () => {
    expect(pickLayout(1920, 1080, 'auto')).toBe('full');
    expect(pickLayout(1080, 608, 'auto')).toBe('compact');
    expect(pickLayout(520, 236, 'auto')).toBe('mini');
    expect(pickLayout(1920, 1080, 'mini')).toBe('mini');
  });

  it('scales from the client size and clamps', () => {
    expect(scaleFor(1920, 1080, 'full')).toBe(1);
    expect(scaleFor(2560, 1440, 'full')).toBeCloseTo(1.333, 2);
    expect(scaleFor(100, 100, 'full')).toBe(0.36);
    expect(scaleFor(9999, 9999, 'full')).toBe(1.5);
    expect(scaleFor(1920, 1080, 'full', 1.1)).toBeCloseTo(1.1);
  });
});

describe('missing values', () => {
  const lim = [
    { metric: 'GPU LOAD', reason: 'x', kind: 'error' as const },
    { metric: 'CPU TEMP', reason: 'y', kind: 'unsupported' as const },
  ];
  it('labels failures ERR and unsupported metrics N/A', () => {
    expect(missing(lim, 'GPU LOAD')).toBe('ERR');
    expect(missing(lim, 'CPU TEMP')).toBe('N/A');
    expect(missing(lim, 'DISK I/O')).toBe('N/A');
    expect(missing(lim, 'GPU LOAD', 'GPU')).toBe('ERR');
  });
  it('only replaces the placeholder, never a real value', () => {
    expect(orMissing('N/A', 'ERR')).toBe('ERR');
    expect(orMissing('0%', 'ERR')).toBe('0%');
  });
  it('formats byte counts', () => {
    expect(bytes(512 * 1024 ** 2)).toBe('512 MB');
    expect(bytes(1.5 * 1024 ** 3)).toBe('1.5 GB');
  });
});

describe('cityClock', () => {
  it('formats world-clock times in 24 or 12 hours', () => {
    expect(cityClock(13, 48, true)).toBe('13:48');
    expect(cityClock(1, 5, true)).toBe('01:05');
    expect(cityClock(13, 48, false)).toBe(' 1:48 PM');
    expect(cityClock(0, 7, false)).toBe('12:07 AM');
    expect(cityClock(12, 0, false)).toBe('12:00 PM');
    expect(cityClock(23, 59, false)).toBe('11:59 PM');
  });
});
