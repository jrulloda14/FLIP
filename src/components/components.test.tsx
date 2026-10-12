import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { okClaude, pomodoro, settings, system, unavailable } from '../test/fixtures';
import { AIUsageTable, usageColumns } from './AIUsageTable';
import { PomodoroPanel } from './PomodoroPanel';
import { aiIndicator } from './StatusBar';
import { SystemMonitor } from './SystemMonitor';
import { WorldClockTable } from './WorldClockTable';
import { DotMeter, matrixDots } from './primitives';

const now = Date.parse('2026-10-06T04:43:00Z');

describe('primitives', () => {
  it('lays out 5x7 glyphs with a one-column colon', () => {
    const { cols, dots } = matrixDots('12:43');
    expect(cols).toBe(5 * 4 + 1 + 4); // four digits, colon, four gaps
    expect(dots.length).toBe((5 * 4 + 1) * 7); // gaps hold no dots
  });

  it('meter lights round(v × cells) and turns amber at the threshold', () => {
    const { container, rerender } = render(<DotMeter value={0.5} cells={10} warnAt={0.9} />);
    expect(container.querySelectorAll('i.on')).toHaveLength(5);
    expect(container.firstChild).not.toHaveClass('is-warn');
    rerender(<DotMeter value={0.95} cells={10} warnAt={0.9} />);
    expect(container.firstChild).toHaveClass('is-warn');
    rerender(<DotMeter value={null} cells={10} />);
    expect(container.querySelectorAll('i.on')).toHaveLength(0);
  });
});

describe('AIUsageTable', () => {
  it('shows unavailable providers honestly, with no percentage', () => {
    render(<AIUsageTable providers={[unavailable('claude', 'CLAUDE')]} warnAt={0.9} nowMs={now} onOpen={() => {}} />);
    expect(screen.getByText('NOT CONNECTED · SETTINGS › AI')).toBeInTheDocument();
    expect(screen.queryByText(/%/)).not.toBeInTheDocument();
  });

  it('shows real readings and opens detail on click', async () => {
    const onOpen = vi.fn();
    render(<AIUsageTable providers={[okClaude(), unavailable('codex', 'CODEX')]} warnAt={0.9} nowMs={now} onOpen={onOpen} />);
    expect(screen.getByLabelText('71%')).toBeInTheDocument();
    expect(screen.getByLabelText('24%')).toBeInTheDocument();
    await userEvent.click(screen.getByText('CLAUDE'));
    expect(onOpen).toHaveBeenCalledWith('claude');
  });

  it('marks stale, error, loading and demo rows', () => {
    const stale = { ...okClaude(), status: 'stale' as const };
    const err = { ...unavailable('codex', 'CODEX'), status: 'error' as const, error: { code: 'FORMAT', message: 'x', retryAt: null } };
    const { rerender } = render(<AIUsageTable providers={[stale, err]} warnAt={0.9} nowMs={now} onOpen={() => {}} />);
    expect(screen.getByText(/STALE · UPDATED/)).toBeInTheDocument();
    expect(screen.getByText('ERR · FORMAT')).toBeInTheDocument();
    const loading = { ...unavailable('claude', 'CLAUDE'), status: 'loading' as const };
    const demo = { ...okClaude(), providerId: 'codex', displayName: 'CODEX', isDemo: true };
    rerender(<AIUsageTable providers={[loading, demo]} warnAt={0.9} nowMs={now} onOpen={() => {}} />);
    expect(screen.getByText('SYNCING')).toBeInTheDocument();
    expect(screen.getByText('DEMO')).toBeInTheDocument();
  });

  it('shows -- for a window whose reset has passed', () => {
    const p = okClaude();
    p.windows[0] = { ...p.windows[0]!, expired: true };
    render(<AIUsageTable providers={[p]} warnAt={0.9} nowMs={now} onOpen={() => {}} />);
    expect(screen.getByLabelText('--%')).toBeInTheDocument();
  });

  it('aligns columns on the union of healthy window keys', () => {
    const codex = { ...okClaude(), providerId: 'codex', windows: [okClaude().windows[1]!] };
    expect(usageColumns([okClaude(), codex, unavailable('x', 'X')])).toEqual(['5H', '7D']);
  });

  it('summarises AI state for the status LED', () => {
    expect(aiIndicator([], false, 2).label).toBe('AI OFF');
    expect(aiIndicator([unavailable('a', 'A')], false, 2).label).toBe('AI N/A');
    expect(aiIndicator([okClaude()], true, 2)).toEqual({ state: 'pulse', label: 'AI SYNC' });
    expect(aiIndicator([okClaude()], false, 5).label).toBe('AI 5M');
  });
});

describe('WorldClockTable', () => {
  it('renders the board with diffs and day shifts', () => {
    render(
      <WorldClockTable
        cities={[
          { name: 'LONDON', code: 'LHR', tz: 'Europe/London', time: '05:43', diffMinutes: -420, diffLabel: '-7H', dayShift: 0, valid: true },
          { name: 'AUCKLAND', code: 'AKL', tz: 'Pacific/Auckland', time: '03:30', diffMinutes: 240, diffLabel: '+4H', dayShift: 1, valid: true },
          { name: 'BAD', code: 'X', tz: 'Nope/Nope', time: '--:--', diffMinutes: 0, diffLabel: '—', dayShift: 0, valid: false },
        ]}
      />,
    );
    expect(screen.getByText('DESTINATION')).toBeInTheDocument();
    expect(screen.getByLabelText('-7H')).toBeInTheDocument();
    expect(screen.getByText('+1')).toBeInTheDocument();
    expect(screen.getByText('N/A')).toBeInTheDocument();
  });
});

describe('SystemMonitor', () => {
  it('shows a loading state before the first sample', () => {
    render(<SystemMonitor sys={null} cfg={settings().system} condensed={false} onOpen={() => {}} />);
    expect(screen.getByText('WAITING FOR FIRST SAMPLE')).toBeInTheDocument();
  });

  it('shows N/A for unavailable metrics instead of zero', () => {
    render(<SystemMonitor sys={system()} cfg={settings().system} condensed={false} onOpen={() => {}} />);
    expect(screen.getByText('DESKTOP-TEST')).toBeInTheDocument();
    expect(screen.getAllByText('N/A').length).toBeGreaterThanOrEqual(3); // CPU temp, GPU load, GPU temp
    expect(screen.getByText('DISK C:')).toBeInTheDocument();
    expect(screen.getByText(/UP 3D 04H/)).toBeInTheDocument();
  });

  it('drops optional rows while focus is active', () => {
    render(<SystemMonitor sys={system()} cfg={settings().system} condensed onOpen={() => {}} />);
    expect(screen.queryByText('LOAD 60S')).not.toBeInTheDocument();
    expect(screen.queryByText('DISK C:')).not.toBeInTheDocument();
  });
});

describe('PomodoroPanel', () => {
  it('shows ready state and today stats', () => {
    render(<PomodoroPanel p={pomodoro()} clock={settings().clock} tz="UTC" focusMinutes={25} onOpen={() => {}} />);
    expect(screen.getByTestId('pomo-phase')).toHaveTextContent('READY');
    expect(screen.getByTestId('pomo-time')).toHaveTextContent('25:00');
    expect(screen.getByText(/TODAY 2 DONE · 50M/)).toBeInTheDocument();
  });

  it('shows paused state with a dot-matrix countdown', () => {
    render(
      <PomodoroPanel
        p={pomodoro({ phase: 'focus', running: false, remainingMs: 18 * 60_000 + 42_000 })}
        clock={settings().clock}
        tz="UTC"
        focusMinutes={25}
        onOpen={() => {}}
      />,
    );
    expect(screen.getByTestId('pomo-phase')).toHaveTextContent('PAUSED · FOCUS');
    expect(screen.getByRole('img', { name: '18:42 remaining' })).toBeInTheDocument();
  });
});
