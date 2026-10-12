import { useEffect, useRef, useState } from 'react';
import { ClockFace } from '../components/ClockFace';
import { Head, OnOff, Row, Seg, Sheet } from '../components/controls';
import { TEMPLATES, safeTemplate, shouldAnimate, useReducedMotion } from '../lib/clock';
import { clockText, dateText } from '../lib/format';
import { useFlip } from '../lib/store';
import type { City, ClockSnapshot, ModuleId, PlatformInfo, Region, RuntimeStatus, Settings, ShortcutSettings } from '../lib/types';

export const TABS = ['DISPLAY', 'CLOCK', 'LOCATIONS', 'AI', 'FOCUS', 'MODULES', 'SYSTEM', 'KEYS'] as const;

/** Suggestions for the add-city form. Any IANA zone can be typed instead. */
export const CITY_PRESETS: City[] = [
  ['MANILA', 'MNL', 'Asia/Manila'],
  ['LONDON', 'LHR', 'Europe/London'],
  ['NEW YORK', 'JFK', 'America/New_York'],
  ['TOKYO', 'HND', 'Asia/Tokyo'],
  ['SYDNEY', 'SYD', 'Australia/Sydney'],
  ['DUBAI', 'DXB', 'Asia/Dubai'],
  ['SAN FRANCISCO', 'SFO', 'America/Los_Angeles'],
  ['SINGAPORE', 'SIN', 'Asia/Singapore'],
  ['PARIS', 'CDG', 'Europe/Paris'],
  ['BERLIN', 'BER', 'Europe/Berlin'],
  ['MUMBAI', 'BOM', 'Asia/Kolkata'],
  ['HONG KONG', 'HKG', 'Asia/Hong_Kong'],
  ['TORONTO', 'YYZ', 'America/Toronto'],
  ['CHICAGO', 'ORD', 'America/Chicago'],
  ['SAO PAULO', 'GRU', 'America/Sao_Paulo'],
  ['AUCKLAND', 'AKL', 'Pacific/Auckland'],
  ['SEOUL', 'ICN', 'Asia/Seoul'],
  ['DENVER', 'DEN', 'America/Denver'],
].map(([name, code, tz]) => ({ name: name!, code: code!, tz: tz! }));

const MAX_CITIES = 8;

type Upd = (fn: (s: Settings) => Settings) => void;

/** Sample times for the rollover demo: each pair crosses a multi-digit boundary. */
export const DEMO_SEQUENCE = ['12:58', '12:59', '13:00', '09:59', '10:00', '23:59', '00:00'];

function ClockTab({ s, set, clock, zones, systemZone }: { s: Settings; set: Upd; clock: ClockSnapshot; zones: string[]; systemZone: string }) {
  const c = s.clock;
  const put = (patch: Partial<Settings['clock']>) => set((x) => ({ ...x, clock: { ...x.clock, ...patch } }));
  const reduced = useReducedMotion();
  const animate = shouldAnimate(c.animate, reduced, c.animationMs);
  const template = safeTemplate(c.template);
  // Demo playback: labeled sample times, never presented as the real time.
  const [demo, setDemo] = useState<number | null>(null);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const step = Math.max(900, c.animationMs + 500);
  const playDemo = () => {
    window.clearTimeout(timer.current);
    let i = 0;
    setDemo(0);
    const next = () => {
      i += 1;
      if (i >= DEMO_SEQUENCE.length) {
        timer.current = window.setTimeout(() => setDemo(null), step);
        return;
      }
      setDemo(i);
      timer.current = window.setTimeout(next, step);
    };
    timer.current = window.setTimeout(next, step);
  };
  let live = clockText(clock.home, c.h24);
  if (c.blink && clock.home.second % 2) live = live.replace(':', ';');
  const demoText = demo === null ? null : DEMO_SEQUENCE[demo]!;
  const previewText = demoText ?? live;
  return (
    <div className="fl-two" style={{ gridTemplateColumns: 'minmax(0,3fr) minmax(0,2fr)' }}>
      <div>
        <Head>CLOCK STUDIO · TEMPLATE</Head>
        <div className="fl-studio" role="radiogroup" aria-label="Clock template">
          {TEMPLATES.map((t) => (
            <button
              key={t.id}
              role="radio"
              aria-checked={template === t.id}
              aria-label={t.label}
              title={t.hint}
              className={`fl-studio__tile${template === t.id ? ' is-on' : ''}`}
              onClick={() => put({ template: t.id })}
            >
              <span className="fl-studio__face">
                <ClockFace template={t.id} text="12:34" height={52} clock={c} animate={false} label={`${t.label} preview`} />
              </span>
              <span className="fl-studio__name">{t.label}</span>
            </button>
          ))}
        </div>
        <div className="fl-studio__note">TILES SHOW A FIXED PREVIEW TIME (12:34). THE DASHBOARD ALWAYS SHOWS REAL TIME.</div>
        <Head>FORMAT</Head>
        <Row label="HOURS">
          <Seg value={c.h24} options={[[true, '24H'], [false, '12H']]} onChange={(v) => put({ h24: v })} label="Hours" />
        </Row>
        <Row label="SECONDS" hint="Small digits beside the minutes">
          <OnOff value={c.seconds} onChange={(v) => put({ seconds: v })} label="Seconds" />
        </Row>
        <Row label="DATE">
          <OnOff value={s.modules.date} onChange={(v) => set((x) => ({ ...x, modules: { ...x.modules, date: v } }))} label="Show date" />
          {s.modules.date && (
            <Seg
              value={c.dateFormat}
              options={[
                ['dow', dateText(clock.home, 'dow')],
                ['iso', dateText(clock.home, 'iso')],
                ['eu', dateText(clock.home, 'eu')],
              ]}
              onChange={(v) => put({ dateFormat: v })}
              label="Date format"
            />
          )}
        </Row>
        <Row label="WEEK + UTC LINE">
          <OnOff value={c.metaLine} onChange={(v) => put({ metaLine: v })} label="Week and UTC line" />
        </Row>
        <Head>STYLE</Head>
        <Row label="SIZE" hint="Smaller layouts cap the size so digits never clip">
          <Seg
            value={c.scale}
            options={[
              [0.85, 'S'],
              [1, 'M'],
              [1.15, 'L'],
              [1.3, 'XL'],
            ]}
            onChange={(v) => put({ scale: v })}
            label="Clock size"
          />
        </Row>
        <Row label="DIGIT SPACING">
          <Seg
            value={c.spacing}
            options={[
              [0.6, 'TIGHT'],
              [1, 'NORMAL'],
              [1.4, 'WIDE'],
            ]}
            onChange={(v) => put({ spacing: v })}
            label="Digit spacing"
          />
        </Row>
        <Row label="DIGIT COLOUR" hint="From the FLIP ink ramp; the board stays monochrome">
          <Seg
            value={c.ink}
            options={[
              ['bright', 'BRIGHT'],
              ['soft', 'SOFT'],
              ['dim', 'DIM'],
            ]}
            onChange={(v) => put({ ink: v })}
            label="Digit colour"
          />
        </Row>
        <Row label="COLON BLINK" hint="Off by default: steadier on a second screen">
          <OnOff value={c.blink} onChange={(v) => put({ blink: v })} label="Colon blink" />
        </Row>
        <Head>ANIMATION</Head>
        <Row
          label="ANIMATE DIGITS"
          hint={
            reduced
              ? 'Windows "Animation effects" is off, so digits change instantly'
              : template === 'terminal' || template === 'minimal'
                ? 'This template changes digits instantly'
                : 'Only digits that change are animated'
          }
        >
          <OnOff value={c.animate} onChange={(v) => put({ animate: v })} label="Animate digits" />
        </Row>
        {c.animate && (
          <Row label="SPEED">
            <Seg
              value={c.animationMs}
              options={[
                [250, 'FAST 250MS'],
                [320, 'NORMAL 320MS'],
                [400, 'SLOW 400MS'],
              ]}
              onChange={(v) => put({ animationMs: v })}
              label="Animation speed"
            />
          </Row>
        )}
        {template === 'dotMatrix' && (
          <>
            <Head>DOT MATRIX</Head>
            <Row label="DOT SHAPE">
              <Seg value={c.dotShape} options={[['round', 'ROUND'], ['square', 'SQUARE']]} onChange={(v) => put({ dotShape: v })} label="Dot shape" />
            </Row>
            <Row label="GHOST DOTS" hint="Show unlit dots for an LED panel look">
              <OnOff value={c.ghostDots} onChange={(v) => put({ ghostDots: v })} label="Ghost dots" />
            </Row>
          </>
        )}
        {template === 'splitFlap' && (
          <>
            <Head>SPLIT FLAP</Head>
            <Row label="PANEL SEAM" hint="The hinge line across each card">
              <OnOff value={c.flapSeam} onChange={(v) => put({ flapSeam: v })} label="Panel seam" />
            </Row>
            <Row label="SHADOW" hint="Card depth and shading while a flap turns">
              <OnOff value={c.flapShadow} onChange={(v) => put({ flapShadow: v })} label="Shadow" />
            </Row>
            <Row label="PANEL COLOUR">
              <Seg
                value={c.flapPanel}
                options={[
                  ['graphite', 'GRAPHITE'],
                  ['black', 'BLACK'],
                ]}
                onChange={(v) => put({ flapPanel: v })}
                label="Panel colour"
              />
            </Row>
          </>
        )}
        {template === 'sevenSegment' && (
          <>
            <Head>SEVEN SEGMENT</Head>
            <Row label="UNLIT SEGMENTS" hint="Faint off segments, like a real LED display">
              <OnOff value={c.ghostDots} onChange={(v) => put({ ghostDots: v })} label="Unlit segments" />
            </Row>
          </>
        )}
        <Head>TIME ZONE</Head>
        <Row label="HOME ZONE" hint="DIFF column is relative to this zone">
          <select
            className="fl-select"
            aria-label="Home time zone"
            value={c.homeTimeZone ?? ''}
            onChange={(e) => put({ homeTimeZone: e.target.value || null })}
          >
            <option value="">SYSTEM · {systemZone}</option>
            {zones.map((z) => (
              <option key={z} value={z}>
                {z}
              </option>
            ))}
          </select>
        </Row>
      </div>
      <div style={{ padding: 'calc(var(--u) * 28px)' }}>
        <div className="fl-sec">
          <span>PREVIEW</span>
          <span data-testid="preview-label">{demoText ? `DEMO TIME · ${demoText}` : 'LIVE'}</span>
        </div>
        <div className="fl-studio__preview">
          <ClockFace template={template} text={previewText} height={84} clock={c} animate={animate} label={demoText ? `Demo ${demoText}` : undefined} />
        </div>
        {s.modules.date && (
          <div className="fl-date" style={{ justifyContent: 'flex-end' }}>
            <span>{dateText(clock.home, c.dateFormat)}</span>
          </div>
        )}
        <div className="fl-studio__demo">
          <button className="fl-btn" onClick={playDemo} disabled={demo !== null}>
            {demo !== null ? 'PLAYING DEMO…' : 'PLAY ROLLOVER DEMO'}
          </button>
          <span className="fl-ink3 fl-small fl-case">Steps through 12:58 → 13:00, 09:59 → 10:00 and 23:59 → 00:00 using sample times.</span>
        </div>
      </div>
    </div>
  );
}

export function LocationsTab({ s, set, clock, zones }: { s: Settings; set: Upd; clock: ClockSnapshot; zones: string[] }) {
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [tz, setTz] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const cities = s.cities;
  const move = (i: number, d: number) =>
    set((x) => {
      const c = [...x.cities];
      const j = i + d;
      if (j < 0 || j >= c.length) return x;
      [c[i], c[j]] = [c[j]!, c[i]!];
      return { ...x, cities: c };
    });
  const remove = (i: number) => set((x) => ({ ...x, cities: x.cities.filter((_, k) => k !== i) }));
  const add = () => {
    const n = name.trim().toUpperCase();
    if (!n) return setErr('ENTER A CITY NAME');
    if (!zones.includes(tz)) return setErr('CHOOSE A VALID IANA TIME ZONE, E.G. EUROPE/PARIS');
    if (cities.length >= MAX_CITIES) return setErr(`MAXIMUM ${MAX_CITIES} CITIES`);
    if (cities.some((c) => c.name === n && c.tz === tz)) return setErr('ALREADY ON THE BOARD');
    setErr(null);
    set((x) => ({ ...x, cities: [...x.cities, { name: n.slice(0, 24), code: code.trim().toUpperCase().slice(0, 4), tz }] }));
    setName('');
    setCode('');
    setTz('');
  };
  const preset = (v: string) => {
    const p = CITY_PRESETS.find((c) => c.tz === v);
    if (p) {
      setName(p.name);
      setCode(p.code);
      setTz(p.tz);
    }
  };
  return (
    <>
      <Head>DESTINATIONS · USE ↑ ↓ TO REORDER · MAX {MAX_CITIES}</Head>
      {cities.map((c, i) => (
        <div className="fl-loc" key={c.tz + c.name}>
          <span className="grip">{String(i + 1).padStart(2, '0')}</span>
          <span>{c.name}</span>
          <span className="fl-ink2">{c.code}</span>
          <span className="fl-ink3 fl-case">{c.tz}</span>
          <span className="fl-ink1">{clock.cities[i]?.diffLabel ?? ''}</span>
          <span>
            <button className="fl-iconbtn" onClick={() => move(i, -1)} aria-label={`Move ${c.name} up`} disabled={i === 0}>
              ↑
            </button>
            <button className="fl-iconbtn" onClick={() => move(i, 1)} aria-label={`Move ${c.name} down`} disabled={i === cities.length - 1}>
              ↓
            </button>
            <button className="fl-iconbtn" onClick={() => remove(i)} aria-label={`Remove ${c.name}`}>
              ✕
            </button>
          </span>
        </div>
      ))}
      {cities.length === 0 && <div className="fl-loc fl-ink3">NO CITIES · ADD ONE BELOW</div>}
      <Head>ADD DESTINATION</Head>
      <div className="fl-addcity">
        <select className="fl-select" aria-label="Preset city" value="" onChange={(e) => preset(e.target.value)}>
          <option value="">PRESET…</option>
          {CITY_PRESETS.filter((p) => !cities.some((c) => c.tz === p.tz)).map((p) => (
            <option key={p.tz} value={p.tz}>
              {p.name} · {p.code}
            </option>
          ))}
        </select>
        <input className="fl-input" aria-label="City name" placeholder="CITY" value={name} maxLength={24} onChange={(e) => setName(e.target.value)} />
        <input className="fl-input fl-input--s" aria-label="Code" placeholder="CODE" value={code} maxLength={4} onChange={(e) => setCode(e.target.value)} />
        <input
          className="fl-input fl-case"
          aria-label="IANA time zone"
          placeholder="Region/City"
          list="fl-tz-list"
          value={tz}
          onChange={(e) => setTz(e.target.value)}
        />
        <datalist id="fl-tz-list">
          {zones.map((z) => (
            <option key={z} value={z} />
          ))}
        </datalist>
        <button className="fl-btn" onClick={add} disabled={cities.length >= MAX_CITIES}>
          ADD
        </button>
      </div>
      {err && (
        <div className="fl-srow fl-warn" role="alert">
          {err}
        </div>
      )}
    </>
  );
}

export function AiTab({ s, set, platform }: { s: Settings; set: Upd; platform: PlatformInfo }) {
  const ai = s.ai;
  const put = (patch: Partial<Settings['ai']>) => set((x) => ({ ...x, ai: { ...x.ai, ...patch } }));
  const [copied, setCopied] = useState(false);
  const snippet = JSON.stringify({ statusLine: { type: 'command', command: platform.claudeStatuslineCommand } }, null, 2);
  const copy = () => {
    navigator.clipboard?.writeText(snippet).then(
      () => setCopied(true),
      () => setCopied(false),
    );
  };
  return (
    <>
      <Head>CLAUDE · SUBSCRIPTION LIMITS</Head>
      <Row label="SOURCE" hint="No account login; FLIP never asks for passwords or keys">
        <Seg
          value={ai.claude.source}
          options={[
            ['off', 'OFF'],
            ['statusline', 'CLAUDE CODE STATUS LINE'],
            ['manual', 'MANUAL'],
          ]}
          onChange={(v) => put({ claude: { source: v } })}
          label="Claude source"
        />
      </Row>
      {ai.claude.source === 'statusline' && (
        <div className="fl-note">
          <p>
            Claude Code passes your plan&apos;s 5-hour and 7-day usage to its status-line command (Pro/Max plans, after the first reply in a
            session). Add this to <code>%USERPROFILE%\.claude\settings.json</code>. If you already use a status line, this replaces it.
          </p>
          <pre className="fl-code">{snippet}</pre>
          <button className="fl-btn" onClick={copy}>
            {copied ? 'COPIED' : 'COPY SNIPPET'}
          </button>
          <p className="fl-ink3">FLIP keeps only the two percentages and reset times. Values update whenever Claude Code redraws its status line.</p>
        </div>
      )}
      <Head>CODEX · CHATGPT PLAN LIMITS</Head>
      <Row label="SOURCE" hint="Local logs use an undocumented format and may break after Codex updates">
        <Seg
          value={ai.codex.source}
          options={[
            ['off', 'OFF'],
            ['localLogs', 'CODEX CLI LOGS (EXPERIMENTAL)'],
            ['manual', 'MANUAL'],
          ]}
          onChange={(v) => put({ codex: { ...ai.codex, source: v } })}
          label="Codex source"
        />
      </Row>
      {ai.codex.source === 'localLogs' && (
        <Row label="CODEX HOME" hint="Blank uses CODEX_HOME or %USERPROFILE%\.codex">
          <input
            className="fl-input fl-case"
            aria-label="Codex home folder"
            placeholder="C:\Users\you\.codex"
            defaultValue={ai.codex.codexHome ?? ''}
            onBlur={(e) => put({ codex: { ...ai.codex, codexHome: e.target.value.trim() || null } })}
          />
        </Row>
      )}
      <Head>BEHAVIOUR</Head>
      <Row label="REFRESH EVERY" hint="Failures back off 30s → 2m → 5m → 15m">
        <Seg value={ai.refreshMinutes} options={[[1, '1M'], [2, '2M'], [5, '5M'], [15, '15M']]} onChange={(v) => put({ refreshMinutes: v })} label="Refresh" />
      </Row>
      <Row label="WARN AT" hint="Meter turns amber at or above this">
        <Seg value={ai.warnAt} options={[[0.8, '80%'], [0.9, '90%'], [1, '100%']]} onChange={(v) => put({ warnAt: v })} label="Warn at" />
      </Row>
      {platform.isDebug && (
        <Row label="DEMO DATA" hint="Debug builds only. Rows are labeled DEMO. Never available in release builds.">
          <OnOff value={ai.demo} onChange={(v) => put({ demo: v })} label="Demo data" />
        </Row>
      )}
    </>
  );
}

function FocusTab({ s, set }: { s: Settings; set: Upd }) {
  const f = s.focus;
  const put = (patch: Partial<Settings['focus']>) => set((x) => ({ ...x, focus: { ...x.focus, ...patch } }));
  const putN = (patch: Partial<Settings['notifications']>) => set((x) => ({ ...x, notifications: { ...x.notifications, ...patch } }));
  return (
    <>
      <Head>POMODORO</Head>
      <Row label="FOCUS" hint="Minutes">
        <Seg value={f.focusMinutes} options={[[15, '15'], [25, '25'], [45, '45'], [50, '50'], [90, '90']]} onChange={(v) => put({ focusMinutes: v })} label="Focus minutes" />
      </Row>
      <Row label="SHORT BREAK">
        <Seg value={f.shortMinutes} options={[[3, '3'], [5, '5'], [10, '10']]} onChange={(v) => put({ shortMinutes: v })} label="Short break" />
      </Row>
      <Row label="LONG BREAK">
        <Seg value={f.longMinutes} options={[[15, '15'], [20, '20'], [30, '30']]} onChange={(v) => put({ longMinutes: v })} label="Long break" />
      </Row>
      <Row label="SESSIONS" hint="Focus blocks before a long break">
        <Seg value={f.sessions} options={[[2, '2'], [3, '3'], [4, '4'], [6, '6']]} onChange={(v) => put({ sessions: v })} label="Sessions" />
      </Row>
      <Row label="AUTO-START NEXT" hint="Start the next phase automatically">
        <OnOff value={f.autoStart} onChange={(v) => put({ autoStart: v })} label="Auto-start" />
      </Row>
      <Head>NOTIFICATIONS</Head>
      <Row label="FOCUS COMPLETE" hint="Windows notification">
        <OnOff value={s.notifications.focusComplete} onChange={(v) => putN({ focusComplete: v })} label="Focus complete notification" />
      </Row>
      <Row label="BREAK COMPLETE">
        <OnOff value={s.notifications.breakComplete} onChange={(v) => putN({ breakComplete: v })} label="Break complete notification" />
      </Row>
    </>
  );
}

const MODULE_LABEL: Record<ModuleId, string> = { ai: 'AI USAGE', world: 'WORLD CLOCK', system: 'SYSTEM MONITOR', focus: 'POMODORO' };

export function ModulesTab({ s, set }: { s: Settings; set: Upd }) {
  const m = s.modules;
  const put = (patch: Partial<Settings['modules']>) => set((x) => ({ ...x, modules: { ...x.modules, ...patch } }));
  const putA = (patch: Partial<Settings['appearance']>) => set((x) => ({ ...x, appearance: { ...x.appearance, ...patch } }));
  const mod = (label: string, key: keyof Omit<Settings['modules'], 'layout' | 'preset' | 'order'>) => (
    <Row label={label}>
      <OnOff value={m[key]} onChange={(v) => put({ [key]: v })} label={label} />
    </Row>
  );
  const move = (i: number, d: number) =>
    set((x) => {
      const o = [...x.modules.order];
      const j = i + d;
      if (j < 0 || j >= o.length) return x;
      [o[i], o[j]] = [o[j]!, o[i]!];
      return { ...x, modules: { ...x.modules, order: o } };
    });
  return (
    <>
      <Head>LAYOUT PRESET</Head>
      <Row label="PRESET" hint="L in FLIP, or the layout shortcut, cycles presets">
        <Seg
          value={m.preset}
          options={[
            ['balanced', 'BALANCED'],
            ['clock', 'CLOCK'],
            ['ai', 'AI'],
            ['system', 'SYSTEM'],
          ]}
          onChange={(v) => put({ preset: v })}
          label="Layout preset"
        />
      </Row>
      <Row label="DENSITY" hint="AUTO picks by window size: ≥1150×620 FULL, ≥600×300 COMPACT">
        <Seg value={m.layout} options={[['auto', 'AUTO'], ['full', 'FULL'], ['compact', 'COMPACT'], ['mini', 'MINI']]} onChange={(v) => put({ layout: v })} label="Density" />
      </Row>
      <Head>MODULES</Head>
      <Row label="CLOCK">
        <span className="fl-ink3">ALWAYS ON</span>
      </Row>
      {mod('DATE', 'date')}
      {mod('AI USAGE', 'ai')}
      {mod('WORLD CLOCK', 'world')}
      {mod('SYSTEM MONITOR', 'system')}
      {mod('POMODORO', 'focus')}
      {mod('SHORTCUT HINTS', 'keys')}
      <Head>ORDER · AI AND WORLD CLOCK SHARE THE BOARD SIDE; SYSTEM AND POMODORO SHARE THE PANEL SIDE</Head>
      {m.order.map((id, i) => (
        <div className="fl-loc fl-loc--order" key={id}>
          <span className="grip">{String(i + 1).padStart(2, '0')}</span>
          <span>{MODULE_LABEL[id]}</span>
          <span>
            <button className="fl-iconbtn" onClick={() => move(i, -1)} aria-label={`Move ${MODULE_LABEL[id]} up`} disabled={i === 0}>
              ↑
            </button>
            <button className="fl-iconbtn" onClick={() => move(i, 1)} aria-label={`Move ${MODULE_LABEL[id]} down`} disabled={i === m.order.length - 1}>
              ↓
            </button>
          </span>
        </div>
      ))}
      <Head>APPEARANCE</Head>
      <Row label="TYPEFACE">
        <Seg
          value={s.appearance.font}
          options={[['jetbrains', 'JETBRAINS MONO'], ['cascadia', 'CASCADIA'], ['consolas', 'CONSOLAS']]}
          onChange={(v) => putA({ font: v })}
          label="Typeface"
        />
      </Row>
      <Row label="TEXT SIZE" hint="Multiplies the automatic scale">
        <Seg value={s.appearance.textScale} options={[[0.9, 'S'], [1, 'M'], [1.1, 'L'], [1.25, 'XL']]} onChange={(v) => putA({ textScale: v })} label="Text size" />
      </Row>
      <Row label="CONTRAST" hint="DIM lowers white to 60% for dark rooms">
        <Seg value={s.appearance.contrast} options={[['standard', 'STANDARD'], ['dim', 'DIM']]} onChange={(v) => putA({ contrast: v })} label="Contrast" />
      </Row>
    </>
  );
}

function SystemTab({ s, set }: { s: Settings; set: Upd }) {
  const y = s.system;
  const put = (patch: Partial<Settings['system']>) => set((x) => ({ ...x, system: { ...x.system, ...patch } }));
  return (
    <>
      <Head>METRICS</Head>
      <Row label="TEMPERATURES" hint="GPU temperature needs an NVIDIA driver; CPU temperature is N/A on Windows">
        <OnOff value={y.temps} onChange={(v) => put({ temps: v })} label="Temperatures" />
      </Row>
      <Row label="GPU" hint="Windows GPU Engine counters (WDDM 2.0+)">
        <OnOff value={y.gpu} onChange={(v) => put({ gpu: v })} label="GPU" />
      </Row>
      <Row label="NETWORK">
        <OnOff value={y.net} onChange={(v) => put({ net: v })} label="Network" />
      </Row>
      <Row label="DISKS">
        <OnOff value={y.disk} onChange={(v) => put({ disk: v })} label="Disks" />
      </Row>
      <Row label="CPU HISTORY">
        <OnOff value={y.plot} onChange={(v) => put({ plot: v })} label="CPU history" />
      </Row>
      <Head>SAMPLING</Head>
      <Row label="SAMPLE EVERY" hint="Longer = less CPU for FLIP itself. Hidden: every 10s">
        <Seg value={y.sampleSeconds} options={[[1, '1S'], [2, '2S'], [5, '5S']]} onChange={(v) => put({ sampleSeconds: v })} label="Sample interval" />
      </Row>
      <Row label="TEMPERATURE">
        <Seg value={y.tempUnit} options={[['C', '°C'], ['F', '°F']]} onChange={(v) => put({ tempUnit: v })} label="Temperature unit" />
      </Row>
    </>
  );
}

export const REGIONS: [Region, string][] = [
  ['full', 'FULL'],
  ['leftHalf', 'LEFT HALF'],
  ['rightHalf', 'RIGHT HALF'],
  ['topLeft', 'TOP LEFT'],
  ['topRight', 'TOP RIGHT'],
  ['bottomLeft', 'BOTTOM LEFT'],
  ['bottomRight', 'BOTTOM RIGHT'],
  ['center', 'CENTRE'],
];

export function DisplayTab({ s, set, status }: { s: Settings; set: Upd; status: RuntimeStatus | null }) {
  const { actions } = useFlip();
  const [confirmAll, setConfirmAll] = useState(false);
  const w = s.window;
  const put = (patch: Partial<Settings['window']>) => set((x) => ({ ...x, window: { ...x.window, ...patch } }));
  const displays = status?.displays ?? [];
  const missing = w.display !== null && !displays.some((d) => d.id === w.display);
  return (
    <>
      <Head>PLACEMENT</Head>
      <Row label="DISPLAY" hint={missing ? 'Chosen display is not connected · showing on primary' : 'Which monitor FLIP lives on'}>
        <select className="fl-select" aria-label="Display" value={w.display ?? ''} onChange={(e) => put({ display: e.target.value || null })}>
          <option value="">PRIMARY MONITOR</option>
          {displays.map((d) => (
            <option key={d.id} value={d.id}>
              {d.label}
            </option>
          ))}
          {missing && <option value={w.display!}>{w.display} · NOT CONNECTED</option>}
        </select>
      </Row>
      <Row label="MODE" hint="AMBIENT fills the display · WINDOWED shares it with apps · COMPACT is a small board">
        <Seg
          value={w.mode}
          options={[
            ['ambient', 'AMBIENT'],
            ['windowed', 'WINDOWED'],
            ['compact', 'COMPACT'],
          ]}
          onChange={(v) => put({ mode: v })}
          label="Display mode"
        />
      </Row>
      <Row label="REGION" hint={w.mode === 'ambient' ? 'Choosing a region switches to WINDOWED' : 'Or drag the top strip and resize from the edges'}>
        <div className="fl-regions">
          {REGIONS.map(([r, label]) => (
            <button key={r} className="fl-btn" onClick={() => void actions.applyRegion(r)}>
              {label}
            </button>
          ))}
        </div>
      </Row>
      <Row
        label="LAYER"
        hint={
          w.layer === 'desktop'
            ? 'Sits under your apps like part of the desktop; stays visible on Show Desktop (Win+D)'
            : w.layer === 'top'
              ? 'Above other windows; steps aside for fullscreen games and presentations'
              : 'Stacks like an ordinary window'
        }
      >
        <Seg
          value={w.layer}
          options={[
            ['desktop', 'ON DESKTOP'],
            ['normal', 'NORMAL'],
            ['top', 'ALWAYS ON TOP'],
          ]}
          onChange={(v) => put({ layer: v })}
          label="Window layer"
        />
      </Row>
      <Head>APPEARANCE</Head>
      <Row
        label="BOARD COLOUR"
        hint={
          s.appearance.background !== 'desktop'
            ? s.appearance.background === 'black'
              ? '#000000'
              : '#050505 · the design token'
            : status?.desktopColor
              ? `Matches your desktop colour ${status.desktopColor.toUpperCase()}`
              : 'Wallpaper image detected · using #050505; lower the opacity to blend'
        }
      >
        <Seg
          value={s.appearance.background}
          options={[
            ['desktop', 'MATCH DESKTOP'],
            ['black', 'PURE BLACK'],
            ['board', 'BOARD #050505'],
          ]}
          onChange={(v) => set((x) => ({ ...x, appearance: { ...x.appearance, background: v } }))}
          label="Board colour"
        />
      </Row>
      <Row label="OPACITY" hint="Lets the wallpaper show through; text stays fully opaque">
        <Seg
          value={s.appearance.backgroundOpacity}
          options={[
            [1, '100%'],
            [0.85, '85%'],
            [0.6, '60%'],
            [0.4, '40%'],
          ]}
          onChange={(v) => set((x) => ({ ...x, appearance: { ...x.appearance, backgroundOpacity: v } }))}
          label="Background opacity"
        />
      </Row>
      <Row label="HOVER CONTROLS" hint="Top-right controls fade when the mouse is still">
        <Seg value={w.hideControlsAfter} options={[[3, 'HIDE AFTER 3S'], [10, '10S'], [0, 'ALWAYS SHOW']]} onChange={(v) => put({ hideControlsAfter: v })} label="Hover controls" />
      </Row>
      <Head>BEHAVIOUR</Head>
      <Row label="✕ CONTROL" hint="Quit is always in the tray menu">
        <Seg value={w.closeToTray} options={[[true, 'HIDE'], [false, 'QUIT']]} onChange={(v) => put({ closeToTray: v })} label="Close control" />
      </Row>
      <Row label="LAUNCH ON STARTUP" hint="Adds a Run entry for the current user">
        <OnOff value={w.launchOnStartup} onChange={(v) => put({ launchOnStartup: v })} label="Launch on startup" />
      </Row>
      <Row label="START HIDDEN" hint="Show it later from the tray or the toggle shortcut">
        <OnOff value={w.startHidden} onChange={(v) => put({ startHidden: v })} label="Start hidden" />
      </Row>
      <Head>RECOVERY</Head>
      <Row label="LAYOUT" hint="Mode, layer, display, position, preset, modules and appearance. Keeps clocks, AI and focus settings.">
        <button className="fl-btn" onClick={() => void actions.resetLayout()}>
          RESET LAYOUT &amp; POSITION
        </button>
      </Row>
      <Row label="EVERYTHING" hint="Every setting back to default">
        {confirmAll ? (
          <>
            <button
              className="fl-btn fl-btn--primary"
              onClick={() => {
                setConfirmAll(false);
                void actions.restoreDefaults();
              }}
            >
              CONFIRM RESTORE
            </button>
            <button className="fl-btn" onClick={() => setConfirmAll(false)}>
              CANCEL
            </button>
          </>
        ) : (
          <button className="fl-btn" onClick={() => setConfirmAll(true)}>
            RESTORE ALL DEFAULTS
          </button>
        )}
      </Row>
    </>
  );
}

/** Mirrors the backend check: at least one modifier plus a letter, digit, F-key or named key. */
export function validShortcut(v: string): boolean {
  const parts = v.split('+').map((p) => p.trim().toLowerCase());
  if (parts.length < 2 || parts.some((p) => !p)) return false;
  const mods = parts.slice(0, -1);
  const key = parts.at(-1)!;
  const isMod = (m: string) => ['ctrl', 'control', 'alt', 'shift', 'super', 'win', 'cmdorctrl'].includes(m);
  if (!mods.every(isMod) || isMod(key) || new Set(mods).size !== mods.length) return false;
  return (
    /^[a-z0-9]$/.test(key) ||
    (/^f\d{1,2}$/.test(key) && +key.slice(1) >= 1 && +key.slice(1) <= 24) ||
    ['space', 'home', 'end', 'pageup', 'pagedown', 'insert', 'comma', 'period'].includes(key)
  );
}

const SHORTCUT_LABEL: Record<keyof ShortcutSettings, string> = {
  toggle: 'SHOW / HIDE',
  settings: 'SETTINGS',
  layout: 'NEXT LAYOUT PRESET',
  focus: 'START / PAUSE FOCUS',
};

function ShortcutInput({ id, s, set, status }: { id: keyof ShortcutSettings; s: Settings; set: Upd; status: string | undefined }) {
  const [v, setV] = useState(s.shortcuts[id]);
  const [err, setErr] = useState<string | null>(null);
  const commit = () => {
    const val = v.trim();
    if (val === s.shortcuts[id]) return;
    if (!validShortcut(val)) return setErr('USE MODIFIERS + ONE KEY, E.G. CTRL+ALT+F');
    const taken = (Object.keys(s.shortcuts) as (keyof ShortcutSettings)[]).some((k) => k !== id && s.shortcuts[k].toLowerCase() === val.toLowerCase());
    if (taken) return setErr('ALREADY USED BY ANOTHER FLIP SHORTCUT');
    setErr(null);
    set((x) => ({ ...x, shortcuts: { ...x.shortcuts, [id]: val } }));
  };
  const bad = !!err || (!!status && status !== 'OK');
  const hint = err ?? (status && status !== 'OK' ? status : 'Works even when FLIP is behind other windows');
  return (
    <Row label={SHORTCUT_LABEL[id]} hint={<span className={bad ? 'fl-warn' : undefined}>{hint}</span>}>
      <input
        className="fl-input"
        aria-label={`${SHORTCUT_LABEL[id]} shortcut`}
        value={v}
        onChange={(e) => setV(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
        }}
      />
    </Row>
  );
}

const KEYS: [string, string][] = [
  ['SPACE', 'Start / pause focus'],
  ['R', 'Reset focus timer'],
  ['S', 'Skip to next phase'],
  ['+', 'Add 5 minutes'],
  ['P', 'Timer controls'],
  [',', 'Settings'],
  ['C', 'Toggle compact'],
  ['M', 'Next display mode'],
  ['L', 'Next layout preset'],
  ['T', 'Next window layer'],
  ['H', 'Hide'],
  ['CTRL+Q', 'Quit'],
];

export function SettingsWindow() {
  const { state, actions } = useFlip();
  const s = state.settings!;
  const boot = state.boot!;
  const clock = state.clock!;
  const tab = (TABS as readonly string[]).includes(state.settingsTab) ? state.settingsTab : 'DISPLAY';
  const set: Upd = (fn) => void actions.updateSettings(fn);
  const sc = state.runtime?.shortcutStatus ?? {};
  return (
    <Sheet
      label="Settings"
      title="SETTINGS"
      right={
        <button className="fl-ctl" onClick={() => actions.openOverlay(null)}>
          ESC CLOSE
        </button>
      }
      footer={
        <>
          <span className="fl-ink3 grow fl-small">CHANGES APPLY LIVE · SAVED TO {boot.platform.dataDir.toUpperCase()}\SETTINGS.JSON</span>
          {state.error && (
            <button className="fl-ctl fl-warn" onClick={actions.dismissError}>
              ! {state.error}
            </button>
          )}
          <button className="fl-btn fl-btn--primary" onClick={() => actions.openOverlay(null)}>
            DONE <kbd>ESC</kbd>
          </button>
        </>
      }
    >
      <div className="fl-tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t} role="tab" aria-selected={t === tab} className={t === tab ? 'is-on' : undefined} onClick={() => actions.setTab(t)}>
            {t}
          </button>
        ))}
      </div>
      <div role="tabpanel" aria-label={tab}>
        {tab === 'DISPLAY' && <DisplayTab s={s} set={set} status={state.runtime} />}
        {tab === 'CLOCK' && <ClockTab s={s} set={set} clock={clock} zones={boot.timeZones} systemZone={boot.systemTimeZone} />}
        {tab === 'LOCATIONS' && <LocationsTab s={s} set={set} clock={clock} zones={boot.timeZones} />}
        {tab === 'AI' && <AiTab s={s} set={set} platform={boot.platform} />}
        {tab === 'FOCUS' && <FocusTab s={s} set={set} />}
        {tab === 'MODULES' && <ModulesTab s={s} set={set} />}
        {tab === 'SYSTEM' && <SystemTab s={s} set={set} />}
        {tab === 'KEYS' && (
          <>
            <Head>SYSTEM-WIDE SHORTCUTS</Head>
            {(['toggle', 'settings', 'layout', 'focus'] as const).map((id) => (
              <ShortcutInput key={id + s.shortcuts[id]} id={id} s={s} set={set} status={sc[id]} />
            ))}
            <Head>WHEN FLIP HAS FOCUS</Head>
            {KEYS.map(([k, d]) => (
              <Row key={k} label={<span className="fl-kbd fl-kbd--l">{k}</span>}>
                <span className="fl-ink1 fl-case">{d}</span>
              </Row>
            ))}
          </>
        )}
      </div>
    </Sheet>
  );
}
