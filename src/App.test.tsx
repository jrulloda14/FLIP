import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { bootstrap, okClaude, pomodoro } from './test/fixtures';
import type { Settings } from './lib/types';

// Mock the Tauri bridge: invoke() resolves from a table, listen() records handlers.
const handlers = new Map<string, (e: { payload: unknown }) => void>();
const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock('@tauri-apps/api/event', () => ({
  listen: async (name: string, cb: (e: { payload: unknown }) => void) => {
    handlers.set(name, cb);
    return () => handlers.delete(name);
  },
}));

const { default: App, layoutFor } = await import('./App');
const { draftToWindows } = await import('./overlays/ProviderDetail');
const { validShortcut } = await import('./overlays/SettingsWindow');

function emit(name: string, payload: unknown) {
  act(() => handlers.get(name)?.({ payload }));
}
const lastSettings = () => (invoke.mock.calls.filter((c) => c[0] === 'update_settings').at(-1)![1] as { settings: Settings }).settings;

beforeEach(() => {
  handlers.clear();
  invoke.mockReset();
  invoke.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
    switch (cmd) {
      case 'get_bootstrap':
        return bootstrap();
      case 'update_settings':
        return args!.settings as Settings;
      case 'pomodoro_command':
        return pomodoro({ phase: 'focus', running: true, remainingMs: 25 * 60_000 });
      case 'refresh_ai':
        return [okClaude()];
      case 'apply_region':
      case 'reset_layout':
      case 'restore_default_settings':
        return bootstrap().settings;
      case 'window_command':
      case 'open_panel':
      case 'close_panel':
        return undefined;
      default:
        throw new Error(`unexpected ${cmd}`);
    }
  });
  Object.defineProperty(window, 'innerWidth', { value: 1920, configurable: true });
  Object.defineProperty(window, 'innerHeight', { value: 1080, configurable: true });
});

describe('dashboard window', () => {
  it('shows a loading state, then the borderless board with its display', async () => {
    render(<App surface="main" />);
    expect(screen.getByText('LOADING…')).toBeInTheDocument();
    expect(await screen.findByRole('timer', { name: '12:43' })).toBeInTheDocument();
    expect(screen.getByText('TUE 06 OCT')).toBeInTheDocument();
    expect(screen.getByText('LONDON')).toBeInTheDocument();
    expect(screen.getByText('DISPLAY 1 · 1920×1080')).toBeInTheDocument();
    expect(screen.getAllByText('NOT CONNECTED · SETTINGS › AI')).toHaveLength(2);
    // No overlay is ever rendered inside the dashboard.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('shows a clear error when the backend is unreachable', async () => {
    invoke.mockRejectedValueOnce('IPC unavailable');
    render(<App surface="main" />);
    expect(await screen.findByRole('alert')).toHaveTextContent('COULD NOT CONNECT TO THE FLIP BACKEND');
  });

  it('starts the timer with Space', async () => {
    render(<App surface="main" />);
    await screen.findByRole('timer');
    await userEvent.keyboard(' ');
    expect(invoke).toHaveBeenCalledWith('pomodoro_command', { command: 'toggle' });
    await waitFor(() => expect(screen.getByTestId('pomo-phase')).toHaveTextContent('FOCUS'));
  });

  it('cycles the window layer from the hover control', async () => {
    render(<App surface="main" />);
    await screen.findByRole('timer');
    await userEvent.click(screen.getByRole('button', { name: 'Layer: ON DESKTOP' }));
    expect(lastSettings().window.layer).toBe('top');
    expect(await screen.findByRole('button', { name: 'Layer: ON TOP' })).toBeInTheDocument();
  });

  it('reverts an optimistic change when the backend rejects it', async () => {
    render(<App surface="main" />);
    await screen.findByRole('timer');
    invoke.mockImplementationOnce(async () => {
      throw 'STORAGE: disk full';
    });
    await userEvent.click(screen.getByRole('button', { name: 'Layer: ON DESKTOP' }));
    expect(await screen.findByText(/STORAGE: disk full/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Layer: ON DESKTOP' })).toBeInTheDocument();
  });

  it('opens settings and details in the separate panel window', async () => {
    render(<App surface="main" />);
    await screen.findByRole('timer');
    await userEvent.keyboard(',');
    expect(invoke).toHaveBeenCalledWith('open_panel', { view: 'settings' });
    await userEvent.click(screen.getAllByText('CLAUDE')[0]!);
    expect(invoke).toHaveBeenCalledWith('open_panel', { view: 'ai:claude' });
    await userEvent.click(screen.getByRole('timer'));
    expect(invoke).toHaveBeenCalledWith('open_panel', { view: 'settings:CLOCK' });
  });

  it('switches mode, preset and visibility from the keyboard', async () => {
    render(<App surface="main" />);
    await screen.findByRole('timer');
    await userEvent.keyboard('c');
    expect(lastSettings().window.mode).toBe('compact');
    await userEvent.keyboard('l');
    expect(lastSettings().modules.preset).toBe('clock');
    await userEvent.keyboard('h');
    expect(invoke).toHaveBeenCalledWith('window_command', { command: 'hide' });
  });

  it('applies preset, module order and background opacity', async () => {
    const b = bootstrap();
    b.settings.modules.preset = 'system';
    b.settings.modules.order = ['world', 'ai', 'focus', 'system'];
    b.settings.appearance.backgroundOpacity = 0.6;
    invoke.mockImplementation(async (cmd: string) => (cmd === 'get_bootstrap' ? b : undefined));
    const { container } = render(<App surface="main" />);
    await screen.findByRole('timer');
    expect(container.querySelector('.fl-dash')).toHaveAttribute('data-preset', 'system');
    expect(container.querySelector('.fl-host')).toHaveStyle({ '--bg-a': '0.6', '--bg-rgb': '0, 0, 0' });
    const order = (sel: string) => (container.querySelector(sel) as HTMLElement).style.getPropertyValue('--order');
    expect(Number(order('.fl-slot--world'))).toBeLessThan(Number(order('.fl-slot--ai')));
    expect(Number(order('.fl-slot--focus'))).toBeLessThan(Number(order('.fl-slot')));
  });

  it('shows the display fallback notice', async () => {
    render(<App surface="main" />);
    await screen.findByRole('timer');
    emit('flip://status', { ...bootstrap().status, displayNotice: 'CHOSEN DISPLAY NOT CONNECTED · SHOWING ON PRIMARY' });
    expect(await screen.findByText(/CHOSEN DISPLAY NOT CONNECTED/)).toBeInTheDocument();
  });

  it('updates live from backend events', async () => {
    render(<App surface="main" />);
    await screen.findByRole('timer');
    emit('flip://ai', [okClaude()]);
    expect(await screen.findByLabelText('71%')).toBeInTheDocument();
    const b = bootstrap();
    emit('flip://clock', { ...b.clock, home: { ...b.clock.home, minute: 44 } });
    expect(await screen.findByRole('timer', { name: '12:44' })).toBeInTheDocument();
  });

  it('compact mode never renders the full layout', () => {
    const s = bootstrap().settings;
    expect(layoutFor(1920, 1080, s)).toBe('full');
    expect(layoutFor(1920, 1080, { ...s, window: { ...s.window, mode: 'compact' } })).toBe('compact');
    expect(layoutFor(500, 240, { ...s, window: { ...s.window, mode: 'compact' } })).toBe('mini');
  });
});

describe('panel window', () => {
  it('opens on the requested view and closes with Escape', async () => {
    render(<App surface="panel" />);
    expect(await screen.findByRole('dialog', { name: 'Settings' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'DISPLAY' })).toHaveAttribute('aria-selected', 'true');
    await userEvent.keyboard('{Escape}');
    expect(invoke).toHaveBeenCalledWith('close_panel');
  });

  it('switches view when the dashboard asks for provider detail', async () => {
    render(<App surface="panel" />);
    await screen.findByRole('dialog', { name: 'Settings' });
    emit('flip://panel', 'ai:claude');
    const dlg = await screen.findByRole('dialog', { name: 'CLAUDE usage' });
    expect(dlg).toHaveTextContent('NOT CONNECTED');
    expect(dlg).toHaveTextContent('FLIP shows no percentage until a real source reports one.');
  });

  it('chooses display, mode, region and layer', async () => {
    render(<App surface="panel" />);
    await screen.findByRole('dialog', { name: 'Settings' });
    await userEvent.selectOptions(screen.getByLabelText('Display'), 'DISPLAY2');
    expect(lastSettings().window.display).toBe('DISPLAY2');
    await userEvent.click(screen.getByRole('radio', { name: 'AMBIENT' }));
    expect(lastSettings().window.mode).toBe('ambient');
    await userEvent.click(screen.getByRole('button', { name: 'TOP RIGHT' }));
    expect(invoke).toHaveBeenCalledWith('apply_region', { region: 'topRight' });
    await userEvent.click(screen.getByRole('radio', { name: 'ALWAYS ON TOP' }));
    expect(lastSettings().window.layer).toBe('top');
    await userEvent.click(screen.getByRole('radio', { name: '60%' }));
    expect(lastSettings().appearance.backgroundOpacity).toBe(0.6);
    expect(screen.getByText('Matches your desktop colour #000000')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('radio', { name: 'BOARD #050505' }));
    expect(lastSettings().appearance.background).toBe('board');
  });

  it('flags a display that is no longer connected', async () => {
    const b = bootstrap();
    b.settings.window.display = 'DISPLAY3';
    invoke.mockImplementation(async (cmd: string) => (cmd === 'get_bootstrap' ? b : undefined));
    render(<App surface="panel" />);
    await screen.findByRole('dialog', { name: 'Settings' });
    expect(screen.getByText('DISPLAY3 · NOT CONNECTED')).toBeInTheDocument();
  });

  it('needs confirmation before restoring all defaults; reset layout is direct', async () => {
    render(<App surface="panel" />);
    await screen.findByRole('dialog', { name: 'Settings' });
    await userEvent.click(screen.getByRole('button', { name: 'RESET LAYOUT & POSITION' }));
    expect(invoke).toHaveBeenCalledWith('reset_layout');
    await userEvent.click(screen.getByRole('button', { name: 'RESTORE ALL DEFAULTS' }));
    expect(invoke).not.toHaveBeenCalledWith('restore_default_settings');
    await userEvent.click(screen.getByRole('button', { name: 'CONFIRM RESTORE' }));
    expect(invoke).toHaveBeenCalledWith('restore_default_settings');
  });

  it('reorders modules and picks a preset', async () => {
    render(<App surface="panel" />);
    await screen.findByRole('dialog', { name: 'Settings' });
    await userEvent.click(screen.getByRole('tab', { name: 'MODULES' }));
    await userEvent.click(screen.getByRole('radio', { name: 'AI' }));
    expect(lastSettings().modules.preset).toBe('ai');
    await userEvent.click(screen.getByLabelText('Move WORLD CLOCK up'));
    expect(lastSettings().modules.order).toEqual(['world', 'ai', 'system', 'focus']);
  });

  it('edits system-wide shortcuts and reports conflicts', async () => {
    render(<App surface="panel" />);
    await screen.findByRole('dialog', { name: 'Settings' });
    await userEvent.click(screen.getByRole('tab', { name: 'KEYS' }));
    expect(screen.getByText('IN USE BY ANOTHER APP')).toBeInTheDocument();
    const input = screen.getByLabelText('NEXT LAYOUT PRESET shortcut');
    await userEvent.clear(input);
    await userEvent.type(input, 'Ctrl+Alt+S{Enter}');
    expect(screen.getByText('ALREADY USED BY ANOTHER FLIP SHORTCUT')).toBeInTheDocument();
    await userEvent.clear(input);
    await userEvent.type(input, 'Ctrl+Shift+F9{Enter}');
    expect(lastSettings().shortcuts.layout).toBe('Ctrl+Shift+F9');
  });

  it('removes and adds a city', async () => {
    render(<App surface="panel" />);
    await screen.findByRole('dialog', { name: 'Settings' });
    await userEvent.click(screen.getByRole('tab', { name: 'LOCATIONS' }));
    await userEvent.click(screen.getByLabelText('Remove LONDON'));
    expect(lastSettings().cities.map((c) => c.name)).toEqual(['TOKYO']);
    await userEvent.type(screen.getByLabelText('City name'), 'paris');
    await userEvent.type(screen.getByLabelText('Code'), 'cdg');
    await userEvent.type(screen.getByLabelText('IANA time zone'), 'Europe/Paris');
    await userEvent.click(screen.getByRole('button', { name: 'ADD' }));
    expect(lastSettings().cities.at(-1)).toEqual({ name: 'PARIS', code: 'CDG', tz: 'Europe/Paris' });
  });

  it('rejects an unknown time zone when adding a city', async () => {
    render(<App surface="panel" />);
    await screen.findByRole('dialog', { name: 'Settings' });
    await userEvent.click(screen.getByRole('tab', { name: 'LOCATIONS' }));
    await userEvent.type(screen.getByLabelText('City name'), 'atlantis');
    await userEvent.type(screen.getByLabelText('IANA time zone'), 'Ocean/Atlantis');
    await userEvent.click(screen.getByRole('button', { name: 'ADD' }));
    expect(screen.getByRole('alert')).toHaveTextContent('CHOOSE A VALID IANA TIME ZONE');
  });

  it('hides demo controls in release builds', async () => {
    render(<App surface="panel" />);
    await screen.findByRole('dialog', { name: 'Settings' });
    await userEvent.click(screen.getByRole('tab', { name: 'AI' }));
    expect(screen.queryByText('DEMO DATA')).not.toBeInTheDocument();
  });
});

describe('validation helpers', () => {
  it('validates shortcuts like the backend', () => {
    for (const ok of ['Ctrl+Alt+F', 'ctrl+shift+F12', 'Alt+Shift+Space']) expect(validShortcut(ok)).toBe(true);
    for (const bad of ['F', 'Ctrl+Alt', 'Ctrl++F', 'Ctrl+Ctrl+F', 'Ctrl+Alt+Hello', 'Ctrl+F99']) expect(validShortcut(bad)).toBe(false);
  });

  const now = Date.parse('2026-10-06T00:00:00Z');
  it('accepts valid manual rows and skips blank ones', () => {
    const r = draftToWindows(
      [
        { key: '5h', used: '40', resetHours: '2' },
        { key: '', used: '', resetHours: '' },
      ],
      now,
    );
    expect(r).toEqual({ windows: [{ key: '5H', usedPercent: 40, resetsAt: '2026-10-06T02:00:00.000Z' }] });
  });
  it('rejects bad manual values', () => {
    expect(draftToWindows([{ key: '5H', used: '140', resetHours: '' }], now)).toHaveProperty('error');
    expect(draftToWindows([{ key: 'TOO-LONG', used: '1', resetHours: '' }], now)).toHaveProperty('error');
    expect(draftToWindows([{ key: '5H', used: '1', resetHours: '-3' }], now)).toHaveProperty('error');
    expect(draftToWindows([], now)).toEqual({ error: 'ENTER AT LEAST ONE WINDOW' });
  });
});
