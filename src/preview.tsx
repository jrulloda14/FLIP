// Dev-only design preview: renders the real UI in a browser with mocked IPC and fixture data.
// Served by `npm run dev` at /preview.html; not part of the production build.
import { emit } from '@tauri-apps/api/event';
import { mockIPC } from '@tauri-apps/api/mocks';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/fonts.css';
import './styles/tokens.css';
import './styles/flip.css';
import './styles/app.css';
import './styles/clock.css';
import App from './App';
import { bootstrap, okClaude, pomodoro, unavailable } from './test/fixtures';
import type { Settings } from './lib/types';

const q = new URLSearchParams(location.search);
const b = bootstrap();
if (q.get('panel')) b.panelView = q.get('panel')!;
if (q.get('tpl')) b.settings.clock.template = q.get('tpl') as Settings['clock']['template'];
if (q.has('sec')) b.settings.clock.seconds = true;
if (q.has('h12')) b.settings.clock.h24 = false;
// ?toast=focus|break|auto: the timer-completion card window with a sample notice.
if (q.get('toast')) {
  const t = q.get('toast');
  b.completion = t === 'break'
    ? { id: 2, finished: 'shortBreak', next: 'focus', nextMs: 25 * 60_000, nextRunning: false, session: 3, sessions: 4, at: new Date().toISOString() }
    : { id: 1, finished: 'focus', next: 'shortBreak', nextMs: 5 * 60_000, nextRunning: t === 'auto', session: 2, sessions: 4, at: new Date().toISOString() };
}
if (q.get('preset')) b.settings.modules.preset = q.get('preset') as Settings['modules']['preset'];
if (q.get('density')) b.settings.modules.layout = q.get('density') as Settings['modules']['layout'];
if (q.get('mode')) b.settings.window.mode = q.get('mode') as Settings['window']['mode'];
if (q.get('bg')) b.settings.appearance.backgroundOpacity = Number(q.get('bg'));
if (q.has('focus')) b.pomodoro = pomodoro({ phase: 'focus', running: true, session: 2, remainingMs: 18 * 60_000 + 42_000, endsAt: new Date(Date.now() + 1122_000).toISOString() });
if (q.get('ai') === 'sample') b.ai = [okClaude(), unavailable('codex', 'CODEX')];
else if (q.has('ai')) b.ai = [okClaude(), { ...unavailable('codex', 'CODEX'), status: 'error', error: { code: 'FORMAT', message: 'unexpected log line', retryAt: null } }];
b.settings.cities = [
  { name: 'MANILA', code: 'MNL', tz: 'Asia/Manila' },
  ...b.settings.cities,
  { name: 'SYDNEY', code: 'SYD', tz: 'Australia/Sydney' },
];
b.clock.cities = [
  { name: 'MANILA', code: 'MNL', tz: 'Asia/Manila', time: '12:43', hour: 12, minute: 43, date: 'TUE 06', diffMinutes: 0, diffLabel: '±0H', dayShift: 0, valid: true },
  ...b.clock.cities,
  { name: 'SYDNEY', code: 'SYD', tz: 'Australia/Sydney', time: '15:43', hour: 15, minute: 43, date: 'TUE 06', diffMinutes: 180, diffLabel: '+3H', dayShift: 0, valid: true },
  { name: 'NEW YORK', code: 'JFK', tz: 'America/New_York', time: '00:43', hour: 0, minute: 43, date: 'TUE 06', diffMinutes: -720, diffLabel: '-12H', dayShift: 0, valid: true },
  { name: 'HONOLULU', code: 'HNL', tz: 'Pacific/Honolulu', time: '18:43', hour: 18, minute: 43, date: 'MON 05', diffMinutes: -1080, diffLabel: '-18H', dayShift: -1, valid: true },
];
// The backend keeps the active profile in step with the live settings; mirror that here.
for (const p of b.settings.profiles.items) if (p.id !== 'gaming') p.clock = { ...p.clock, template: b.settings.clock.template };
// Sample custom profile on a second monitor (preview data only).
b.settings.profiles.items.push({ ...b.settings.profiles.items[0]!, id: 'user-1', name: 'DESK 2', builtin: false, window: { ...b.settings.window, displayId: 'MON-B', display: 'DISPLAY2' } });
// ?many: eight cities, to check that rows which don't fit are hidden rather than overflowing.
if (q.has('many')) {
  const extra = [
    ['DUBAI', 'DXB', 'Asia/Dubai', 8, 'TUE 06', -240, '-4H', 0],
    ['MUMBAI', 'BOM', 'Asia/Kolkata', 10, 'TUE 06', -150, '-2H30', 0],
  ] as const;
  for (const [name, code, tz, hour, date, diff, label, shift] of extra) {
    b.settings.cities.push({ name, code, tz });
    b.clock.cities.push({ name, code, tz, time: `${String(hour).padStart(2, '0')}:13`, hour, minute: 13, date, diffMinutes: diff, diffLabel: label, dayShift: shift, valid: true });
  }
}
let settings: Settings = b.settings;
/** Preview stand-in for the backend's profile switch: copies the profile's layout fields. */
const activate = (id: string): Settings => {
  const p = settings.profiles.items.find((x) => x.id === id);
  if (!p) return settings;
  const clock = { ...p.clock, h24: settings.clock.h24, dateFormat: settings.clock.dateFormat, homeTimeZone: settings.clock.homeTimeZone };
  return (settings = { ...settings, modules: p.modules, clock, appearance: p.appearance, window: { ...settings.window, mode: p.window.mode, layer: p.window.layer }, profiles: { ...settings.profiles, active: id } });
};
mockIPC((cmd, args) => {
  const a = args as Record<string, unknown>;
  if (cmd === 'get_bootstrap') return { ...b, settings };
  if (cmd === 'update_settings') return (settings = a.settings as Settings);
  if (cmd === 'pomodoro_command') return b.pomodoro;
  if (cmd === 'refresh_ai') return b.ai;
  if (cmd === 'completion_action' || cmd === 'open_support_page') return cmd === 'completion_action' ? b.pomodoro : null;
  if (cmd === 'activate_profile') return activate(a.id as string);
  if (cmd === 'create_profile' || cmd === 'rename_profile' || cmd === 'delete_profile' || cmd === 'reset_profile') return settings;
  if (cmd === 'apply_region' || cmd === 'reset_layout' || cmd === 'restore_default_settings') return settings;
  if (cmd.startsWith('plugin:event')) return 0;
  return null;
}, { shouldMockEvents: q.has('live') || q.has('freeze') });

// ?freeze=<ms>: change 12:43 → 12:44 once, then pause every animation <ms> in (for stills).
if (q.has('freeze')) {
  window.setTimeout(() => {
    void emit('flip://clock', { ...b.clock, home: { ...b.clock.home, minute: 44 } });
    window.setTimeout(() => {
      const st = document.createElement('style');
      st.textContent = '*,*::after{animation-play-state:paused!important}';
      document.head.appendChild(st);
    }, Number(q.get('freeze')) || 0);
  }, 800);
}

// ?live: drive the clock from this browser's real time (preview only; the app gets ticks from Rust).
if (q.has('live')) {
  const tick = () => {
    const d = new Date();
    const home = { ...b.clock.home, hour: d.getHours(), minute: d.getMinutes(), second: d.getSeconds() };
    void emit('flip://clock', { ...b.clock, epochMs: d.getTime(), home });
    window.setTimeout(tick, 1000 - (Date.now() % 1000) + 5);
  };
  window.setTimeout(tick, 600);
}

// ?frame: draw the card inside its real 440×214 window size (headless browsers have a minimum width).
if (q.has('frame')) Object.assign(document.getElementById('root')!.style, { width: '440px', height: '214px', position: 'relative', outline: '1px dashed #333' });

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App surface={q.get('toast') ? 'toast' : q.get('panel') ? 'panel' : 'main'} />
  </StrictMode>,
);
