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
if (q.get('preset')) b.settings.modules.preset = q.get('preset') as Settings['modules']['preset'];
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
  { name: 'MANILA', code: 'MNL', tz: 'Asia/Manila', time: '12:43', diffMinutes: 0, diffLabel: '±0H', dayShift: 0, valid: true },
  ...b.clock.cities,
  { name: 'SYDNEY', code: 'SYD', tz: 'Australia/Sydney', time: '15:43', diffMinutes: 180, diffLabel: '+3H', dayShift: 0, valid: true },
];
let settings: Settings = b.settings;
mockIPC((cmd, args) => {
  const a = args as Record<string, unknown>;
  if (cmd === 'get_bootstrap') return { ...b, settings };
  if (cmd === 'update_settings') return (settings = a.settings as Settings);
  if (cmd === 'pomodoro_command') return b.pomodoro;
  if (cmd === 'refresh_ai') return b.ai;
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

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App surface={q.get('panel') ? 'panel' : 'main'} />
  </StrictMode>,
);
