import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { bootstrap, okClaude, pomodoro } from './test/fixtures';
import type { CompletionNotice, Settings } from './lib/types';

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

const { default: App, layoutFor, presetFor, clockPitch, nextProfileId } = await import('./App');
const { profileSummary, displayFor } = await import('./overlays/ProfilesTab');
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
      case 'apply_region': {
        const b = bootstrap().settings;
        return { ...b, window: { ...b.window, mode: 'windowed', windowedRegion: args!.region } };
      }
      case 'reset_layout':
      case 'restore_default_settings':
        return bootstrap().settings;
      case 'window_command':
      case 'open_panel':
      case 'close_panel':
      case 'open_support_page':
        return undefined;
      case 'completion_action':
        return pomodoro({ phase: 'shortBreak', running: args!.action === 'startNext', remainingMs: 5 * 60_000, phaseTotalMs: 5 * 60_000 });
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
    expect(screen.getByText('DEVELOPER · DISPLAY 1 · 1920×1080')).toBeInTheDocument(); // active profile + display
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
    const b0 = bootstrap().settings;
    const s = { ...b0, modules: { ...b0.modules, layout: 'auto' as const } };
    expect(layoutFor(1920, 1080, s)).toBe('full');
    expect(layoutFor(1920, 1080, { ...s, window: { ...s.window, mode: 'compact' } })).toBe('compact');
    expect(layoutFor(500, 240, { ...s, window: { ...s.window, mode: 'compact' } })).toBe('mini');
  });
});

describe('density and presets (fix: ignored in compact mode)', () => {
  it('a fixed density applies in every display mode', () => {
    const s = bootstrap().settings;
    const compactMode = { ...s, window: { ...s.window, mode: 'compact' as const } };
    expect(layoutFor(1080, 608, { ...compactMode, modules: { ...s.modules, layout: 'full' } })).toBe('full');
    expect(layoutFor(1920, 1080, { ...s, modules: { ...s.modules, layout: 'compact' } })).toBe('compact');
    expect(layoutFor(924, 992, { ...s, modules: { ...s.modules, layout: 'auto' } })).toBe('compact'); // windowed half-screen, AUTO
    expect(layoutFor(924, 992, s)).toBe('full'); // new default density: FULL
  });

  it('presets apply to the compact layout too', () => {
    expect(presetFor('compact', 'clock')).toBe('clock');
    expect(presetFor('mini', 'clock')).toBe('balanced');
    expect(clockPitch('compact', 'clock')).toBeGreaterThan(clockPitch('compact', 'balanced'));
    expect(clockPitch('compact', 'ai')).toBeLessThan(clockPitch('compact', 'balanced'));
  });

  it('renders the chosen preset in compact mode and marks a translucent board', async () => {
    const b = bootstrap();
    b.settings.window.mode = 'compact';
    b.settings.modules.layout = 'auto';
    b.settings.modules.preset = 'clock';
    b.settings.appearance.backgroundOpacity = 0.4;
    invoke.mockImplementation(async (cmd: string) => (cmd === 'get_bootstrap' ? b : undefined));
    const { container } = render(<App surface="main" />);
    await screen.findByRole('timer');
    const dash = container.querySelector('.fl-dash')!;
    expect(dash).toHaveAttribute('data-layout', 'compact');
    expect(dash).toHaveAttribute('data-preset', 'clock');
    expect(dash).toHaveClass('is-translucent');
  });

  it('the Pomodoro countdown uses the clock template', async () => {
    const b = bootstrap();
    b.settings.clock.template = 'splitFlap';
    b.pomodoro = pomodoro({ phase: 'focus', running: true, remainingMs: 18 * 60_000 + 42_000 });
    invoke.mockImplementation(async (cmd: string) => (cmd === 'get_bootstrap' ? b : undefined));
    const { container } = render(<App surface="main" />);
    await screen.findByRole('timer');
    const countdown = container.querySelector('.fl-focus__matrix')!;
    expect(countdown.querySelector('.fl-clockface--splitFlap')).toBeInTheDocument();
    expect(within(countdown as HTMLElement).getAllByTestId('flap').map((f) => f.getAttribute('data-ch')).join('')).toBe('1842');
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
    expect(screen.getByRole('radio', { name: 'RIGHT HALF' })).toHaveAttribute('aria-checked', 'true'); // default region
    expect(screen.getByRole('radio', { name: 'RIGHT HALF' })).toHaveClass('is-on');
    await userEvent.selectOptions(screen.getByLabelText('Display'), 'MON-B');
    // Saved by stable monitor id, with the device name as a fallback.
    expect(lastSettings().window.displayId).toBe('MON-B');
    expect(lastSettings().window.display).toBe('DISPLAY2');
    await userEvent.click(screen.getByRole('radio', { name: 'AMBIENT' }));
    expect(lastSettings().window.mode).toBe('ambient');
    expect(screen.getByRole('radio', { name: 'RIGHT HALF' })).toHaveAttribute('aria-checked', 'false'); // ambient fills the display
    await userEvent.click(screen.getByRole('radio', { name: 'TOP RIGHT' }));
    expect(invoke).toHaveBeenCalledWith('apply_region', { region: 'topRight' });
    expect(await screen.findByRole('radio', { name: 'TOP RIGHT' })).toHaveClass('is-on');
    expect(screen.getByRole('radio', { name: 'RIGHT HALF' })).toHaveAttribute('aria-checked', 'false');
    await userEvent.click(screen.getByRole('radio', { name: 'ALWAYS ON TOP' }));
    expect(lastSettings().window.layer).toBe('top');
    await userEvent.click(screen.getByRole('radio', { name: '60%' }));
    expect(lastSettings().appearance.backgroundOpacity).toBe(0.6);
    expect(screen.getByText('Matches your desktop colour #000000')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('radio', { name: 'BOARD #050505' }));
    expect(lastSettings().appearance.background).toBe('board');
  });

  it('shows no region selected after a manual move', async () => {
    const b = bootstrap();
    b.settings.window.windowedRegion = null;
    invoke.mockImplementation(async (cmd: string) => (cmd === 'get_bootstrap' ? b : undefined));
    render(<App surface="panel" />);
    await screen.findByRole('dialog', { name: 'Settings' });
    expect(within(screen.getByRole('radiogroup', { name: 'Region' })).getAllByRole('radio').every((r) => r.getAttribute('aria-checked') === 'false')).toBe(true);
    expect(screen.getByText(/Custom position/)).toBeInTheDocument();
  });

  it('flags a display that is no longer connected', async () => {
    const b = bootstrap();
    b.settings.window.display = 'DISPLAY1';
    b.settings.window.displayId = 'MON-GONE'; // stable id wins over a reassigned device name
    invoke.mockImplementation(async (cmd: string) => (cmd === 'get_bootstrap' ? b : undefined));
    render(<App surface="panel" />);
    await screen.findByRole('dialog', { name: 'Settings' });
    expect(screen.getByLabelText('Display')).toHaveValue('__missing');
    expect(screen.getByText('SAVED DISPLAY · NOT CONNECTED')).toBeInTheDocument();
    expect(screen.getByText(/showing on primary until it returns/)).toBeInTheDocument();
  });

  it('lists profiles and switches, creates, duplicates, renames, deletes and resets them', async () => {
    const b = bootstrap();
    b.settings.profiles.items.push({ ...b.settings.profiles.items[0]!, id: 'user-1', name: 'DESK', builtin: false });
    b.panelView = 'settings:PROFILES';
    invoke.mockImplementation(async (cmd: string) => (cmd === 'get_bootstrap' ? b : b.settings));
    render(<App surface="panel" />);
    await screen.findByRole('dialog', { name: 'Settings' });
    const dev = screen.getByTestId('profile-developer');
    expect(within(dev).getByText('ACTIVE')).toBeInTheDocument();
    expect(within(dev).getByText('WINDOWED · DOT MATRIX · 4 MODULES · PRIMARY')).toBeInTheDocument();
    expect(within(screen.getByTestId('profile-gaming')).getByText(/COMPACT · SEVEN SEGMENT/)).toBeInTheDocument();
    // Built-ins can be reset (with confirmation) but not renamed or deleted.
    expect(screen.queryByRole('button', { name: 'Delete GAMING' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Reset GAMING' }));
    await userEvent.click(screen.getByRole('button', { name: 'CONFIRM RESET' }));
    expect(invoke).toHaveBeenCalledWith('reset_profile', { id: 'gaming' });
    await userEvent.click(screen.getByRole('button', { name: 'Use AMBIENT' }));
    expect(invoke).toHaveBeenCalledWith('activate_profile', { id: 'ambient' });
    await userEvent.click(screen.getByRole('button', { name: 'Duplicate FOCUS' }));
    expect(invoke).toHaveBeenCalledWith('create_profile', { name: 'FOCUS COPY', from: 'focus' });
    await userEvent.type(screen.getByLabelText('New profile name'), 'Laptop{Enter}');
    expect(invoke).toHaveBeenCalledWith('create_profile', { name: 'Laptop', from: null });
    await userEvent.click(screen.getByRole('button', { name: 'Rename DESK' }));
    const input = screen.getByLabelText('New name for DESK');
    await userEvent.clear(input);
    await userEvent.type(input, 'Studio{Enter}');
    expect(invoke).toHaveBeenCalledWith('rename_profile', { id: 'user-1', name: 'Studio' });
    await userEvent.click(screen.getByRole('button', { name: 'Delete DESK' }));
    expect(invoke).not.toHaveBeenCalledWith('delete_profile', expect.anything());
    await userEvent.click(screen.getByRole('button', { name: 'CONFIRM DELETE' }));
    expect(invoke).toHaveBeenCalledWith('delete_profile', { id: 'user-1' });
  });

  it('sets auto-switch rules for display changes (off by default)', async () => {
    const b = bootstrap();
    b.panelView = 'settings:PROFILES';
    invoke.mockImplementation(async (cmd: string, args?: Record<string, unknown>) =>
      cmd === 'get_bootstrap' ? b : cmd === 'update_settings' ? (args!.settings as Settings) : undefined,
    );
    render(<App surface="panel" />);
    await screen.findByRole('dialog', { name: 'Settings' });
    expect(screen.queryByLabelText('Profile for one display')).not.toBeInTheDocument();
    await userEvent.click(within(screen.getByRole('radiogroup', { name: 'Auto-switch profiles' })).getByRole('radio', { name: 'ON' }));
    expect(lastSettings().profiles.autoSwitch.enabled).toBe(true);
    await userEvent.selectOptions(screen.getByLabelText('Profile for one display'), 'focus');
    await userEvent.selectOptions(screen.getByLabelText('Profile for two or more displays'), 'developer');
    expect(lastSettings().profiles.autoSwitch).toEqual({ enabled: true, singleDisplay: 'focus', multiDisplay: 'developer' });
  });

  it('configures opt-in alerts on the SYSTEM tab', async () => {
    const b = bootstrap();
    b.panelView = 'settings:SYSTEM';
    invoke.mockImplementation(async (cmd: string, args?: Record<string, unknown>) =>
      cmd === 'get_bootstrap' ? b : cmd === 'update_settings' ? (args!.settings as Settings) : undefined,
    );
    render(<App surface="panel" />);
    await screen.findByRole('dialog', { name: 'Settings' });
    expect(screen.getByText(/never closes apps/)).toBeInTheDocument();
    expect(screen.queryByRole('radiogroup', { name: 'CPU threshold' })).not.toBeInTheDocument();
    await userEvent.click(within(screen.getByRole('radiogroup', { name: 'High CPU alert' })).getByRole('radio', { name: 'ON' }));
    await userEvent.click(within(screen.getByRole('radiogroup', { name: 'CPU threshold' })).getByRole('radio', { name: '95%' }));
    await userEvent.click(within(screen.getByRole('radiogroup', { name: 'CPU duration' })).getByRole('radio', { name: '5 MIN' }));
    await userEvent.click(within(screen.getByRole('radiogroup', { name: 'Low disk space alert' })).getByRole('radio', { name: 'ON' }));
    await userEvent.click(within(screen.getByRole('radiogroup', { name: 'Alert cooldown' })).getByRole('radio', { name: '1 H' }));
    expect(lastSettings().alerts).toMatchObject({ cpu: true, cpuPercent: 95, cpuMinutes: 5, disk: true, memory: false, cooldownMinutes: 60 });
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

  it('Clock Studio: date format has its own row and hides when the date is off', async () => {
    render(<App surface="panel" />);
    await screen.findByRole('dialog', { name: 'Settings' });
    await userEvent.click(screen.getByRole('tab', { name: 'CLOCK' }));
    await userEvent.click(screen.getByRole('radio', { name: '2026-10-06' }));
    expect(lastSettings().clock.dateFormat).toBe('iso');
    await userEvent.click(within(screen.getByRole('radiogroup', { name: 'Show date' })).getByRole('radio', { name: 'OFF' }));
    expect(lastSettings().modules.date).toBe(false);
    expect(screen.queryByRole('radiogroup', { name: 'Date format' })).not.toBeInTheDocument();
  });

  it('Clock Studio: choosing Split Flap changes only the clock template', async () => {
    render(<App surface="panel" />);
    await screen.findByRole('dialog', { name: 'Settings' });
    await userEvent.click(screen.getByRole('tab', { name: 'CLOCK' }));
    const before = bootstrap().settings;
    await userEvent.click(screen.getByRole('radio', { name: 'SPLIT FLAP' }));
    const after = lastSettings();
    expect(after.clock.template).toBe('splitFlap');
    expect(after.window).toEqual(before.window);
    expect(after.modules).toEqual(before.modules);
    expect(after.appearance).toEqual(before.appearance);
    expect({ ...after.clock, template: before.clock.template }).toEqual(before.clock);
    // Split-flap options appear once it is selected.
    expect(await screen.findByLabelText('Panel seam')).toBeInTheDocument();
  });

  it('Clock Studio: animation toggle, speed and labeled demo time', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      render(<App surface="panel" />);
      await screen.findByRole('dialog', { name: 'Settings' });
      await userEvent.click(screen.getByRole('tab', { name: 'CLOCK' }));
      expect(screen.getByTestId('preview-label')).toHaveTextContent('LIVE');
      await userEvent.click(screen.getByRole('radio', { name: 'SLOW 400MS' }));
      expect(lastSettings().clock.animationMs).toBe(400);
      await userEvent.click(screen.getByRole('button', { name: 'PLAY ROLLOVER DEMO' }));
      expect(screen.getByTestId('preview-label')).toHaveTextContent('DEMO TIME · 12:58');
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      expect(screen.getByTestId('preview-label')).toHaveTextContent('DEMO TIME · 12:59');
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      expect(screen.getByTestId('preview-label')).toHaveTextContent('LIVE');
      await userEvent.click(within(screen.getByRole('radiogroup', { name: 'Animate digits' })).getByRole('radio', { name: 'OFF' }));
      expect(lastSettings().clock.animate).toBe(false);
      expect(screen.queryByRole('radiogroup', { name: 'Animation speed' })).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
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

describe('profiles helpers', () => {
  it('cycles to the next profile and wraps around', () => {
    const p = bootstrap().settings.profiles;
    expect(nextProfileId(p)).toBe('ambient');
    expect(nextProfileId({ ...p, active: 'custom' })).toBe('developer');
  });

  it('finds a profile display by stable id and reports a missing one', () => {
    const displays = bootstrap().status.displays;
    const w = bootstrap().settings.window;
    expect(displayFor(w, displays)).toBeNull();
    expect(displayFor({ ...w, displayId: 'MON-B', display: 'DISPLAY1' }, displays)).toMatchObject({ id: 'DISPLAY2' });
    expect(displayFor({ ...w, displayId: 'MON-X', display: 'DISPLAY1' }, displays)).toBe('missing');
    const p = bootstrap().settings.profiles.items[0]!;
    expect(profileSummary({ ...p, window: { ...p.window, displayId: 'MON-B' } }, displays)).toMatch(/· TEST 27$/);
    expect(profileSummary({ ...p, window: { ...p.window, displayId: 'MON-X' } }, displays)).toMatch(/DISPLAY NOT CONNECTED/);
  });
});

describe('system detail', () => {
  it('shows disk activity, GPU memory, available RAM and groups limitations by kind', async () => {
    const b = bootstrap({ panelView: 'system' });
    b.system!.limitations = [
      { metric: 'CPU TEMP', reason: 'No documented API.', kind: 'unsupported' },
      { metric: 'GPU LOAD', reason: 'Temporary read failure', kind: 'error' },
    ];
    invoke.mockImplementation(async (cmd: string) => (cmd === 'get_bootstrap' ? b : undefined));
    render(<App surface="panel" />);
    await screen.findByRole('dialog', { name: 'System monitor detail' });
    expect(screen.getByText('DISK ACTIVITY · ALL VOLUMES')).toBeInTheDocument();
    expect(screen.getByText('512 MB / 4.0 GB · 13%')).toBeInTheDocument();
    expect(screen.getByText('MEMORY AVAILABLE')).toBeInTheDocument();
    expect(within(screen.getByTestId('limits-error')).getByText('GPU LOAD')).toBeInTheDocument();
    expect(within(screen.getByTestId('limits-unsupported')).getByText('CPU TEMP')).toBeInTheDocument();
  });
});

describe('timer completion card', () => {
  const focusDone = (over: Partial<CompletionNotice> = {}): CompletionNotice => ({
    id: 7,
    finished: 'focus',
    next: 'shortBreak',
    nextMs: 5 * 60_000,
    nextRunning: false,
    session: 2,
    sessions: 4,
    at: '2026-10-13T05:00:00Z',
    ...over,
  });
  const breakDone = (over: Partial<CompletionNotice> = {}): CompletionNotice =>
    focusDone({ id: 8, finished: 'shortBreak', next: 'focus', nextMs: 25 * 60_000, session: 3, ...over });
  const calls = (cmd: string) => invoke.mock.calls.filter((c) => c[0] === cmd);
  const renderToast = async (n: CompletionNotice | null) => {
    const b = bootstrap({ completion: n });
    const base = invoke.getMockImplementation()!;
    invoke.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => (cmd === 'get_bootstrap' ? b : base(cmd, args)));
    render(<App surface="toast" />);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('get_bootstrap'));
  };

  it('shows FOCUS COMPLETE with START BREAK and DISMISS, focused for the keyboard', async () => {
    await renderToast(focusDone());
    const card = await screen.findByRole('alertdialog', { name: 'FOCUS COMPLETE' });
    expect(card).toHaveAccessibleDescription('NEXT · SHORT BREAK · 05:00');
    const start = within(card).getByRole('button', { name: /START BREAK/ });
    expect(start).toHaveFocus();
    expect(within(card).getByRole('button', { name: /DISMISS/ })).toBeInTheDocument();
  });

  it('shows BREAK COMPLETE with RESUME FOCUS', async () => {
    await renderToast(breakDone());
    const card = await screen.findByRole('alertdialog', { name: 'BREAK COMPLETE' });
    expect(card).toHaveAccessibleDescription('NEXT · FOCUS · 25:00 · SESSION 3/4');
    expect(within(card).getByRole('button', { name: /RESUME FOCUS/ })).toBeInTheDocument();
  });

  it('starts the next phase once, even when clicked twice', async () => {
    await renderToast(focusDone());
    const start = await screen.findByRole('button', { name: /START BREAK/ });
    await userEvent.click(start);
    await userEvent.click(start);
    await waitFor(() => expect(calls('completion_action')).toHaveLength(1));
    expect(calls('completion_action')[0]![1]).toEqual({ id: 7, action: 'startNext' });
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(calls('pomodoro_command')).toHaveLength(0); // the backend applies the start
  });

  it('dismisses with Esc without touching the timer', async () => {
    await renderToast(focusDone());
    await screen.findByRole('alertdialog');
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(calls('completion_action')).toHaveLength(1));
    expect(calls('completion_action')[0]![1]).toEqual({ id: 7, action: 'dismiss' });
    expect(calls('pomodoro_command')).toHaveLength(0);
  });

  it('ignores a repeated event for the same completion and replaces it with a newer one', async () => {
    await renderToast(null);
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    emit('flip://completion', focusDone());
    emit('flip://completion', focusDone());
    expect(await screen.findAllByRole('alertdialog')).toHaveLength(1);
    emit('flip://completion', breakDone());
    expect(await screen.findByRole('alertdialog', { name: 'BREAK COMPLETE' })).toBeInTheDocument();
    expect(screen.getAllByRole('alertdialog')).toHaveLength(1);
  });

  it('leaves when the timer is changed elsewhere (event null)', async () => {
    await renderToast(focusDone());
    await screen.findByRole('alertdialog');
    emit('flip://completion', null);
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(calls('completion_action')).toHaveLength(0);
  });

  it('with auto-start, says the next phase started and offers only DISMISS', async () => {
    await renderToast(focusDone({ nextRunning: true }));
    const card = await screen.findByRole('alertdialog', { name: 'FOCUS COMPLETE' });
    expect(card).toHaveAccessibleDescription('SHORT BREAK · 05:00 · STARTED');
    expect(within(card).getAllByRole('button')).toHaveLength(1);
    expect(within(card).getByRole('button', { name: /DISMISS/ })).toHaveFocus();
  });

  it('a card waiting while the window was hidden appears when it loads (bootstrap)', async () => {
    await renderToast(breakDone());
    expect(await screen.findByRole('alertdialog', { name: 'BREAK COMPLETE' })).toBeInTheDocument();
  });

  it('the dashboard never renders the card', async () => {
    invoke.mockImplementation(async (cmd: string) => (cmd === 'get_bootstrap' ? bootstrap({ completion: focusDone() }) : undefined));
    render(<App surface="main" />);
    await screen.findByRole('timer', { name: '12:43' });
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });
});

describe('support link', () => {
  it('opens the Buy Me a Coffee page through the backend', async () => {
    render(<App surface="panel" />);
    await screen.findByRole('dialog', { name: 'Settings' });
    await userEvent.click(screen.getByRole('button', { name: /Buy me a coffee/ }));
    expect(invoke).toHaveBeenCalledWith('open_support_page');
  });

  it('timer-end settings: cards on, sound off by default', async () => {
    const b = bootstrap({ panelView: 'settings:FOCUS' });
    invoke.mockImplementation(async (cmd: string, args?: Record<string, unknown>) =>
      cmd === 'get_bootstrap' ? b : cmd === 'update_settings' ? (args!.settings as Settings) : undefined,
    );
    render(<App surface="panel" />);
    await screen.findByRole('dialog', { name: 'Settings' });
    const sound = screen.getByRole('radiogroup', { name: 'Completion sound' });
    expect(within(sound).getByRole('radio', { name: 'OFF' })).toHaveAttribute('aria-checked', 'true');
    await userEvent.click(within(sound).getByRole('radio', { name: 'ON' }));
    expect(lastSettings().notifications.sound).toBe(true);
  });
});
