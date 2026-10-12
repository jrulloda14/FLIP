import { useState } from 'react';
import { Head, OnOff, Row } from '../components/controls';
import { TEMPLATES } from '../lib/clock';
import { useFlip } from '../lib/store';
import type { DisplayInfo, Profile, Settings } from '../lib/types';

type Upd = (fn: (s: Settings) => Settings) => void;

export const MAX_PROFILES = 16;

const MODE_LABEL = { ambient: 'AMBIENT', windowed: 'WINDOWED', compact: 'COMPACT' } as const;

/** The display a saved placement points at: stable id first, then the device name. */
export function displayFor(w: Profile['window'], displays: DisplayInfo[]): DisplayInfo | 'missing' | null {
  if (w.displayId) return displays.find((d) => d.stableId === w.displayId) ?? 'missing';
  if (w.display) return displays.find((d) => d.id === w.display) ?? 'missing';
  return null;
}

/** One line describing what a profile does, e.g. "WINDOWED · SPLIT FLAP · PRIMARY". */
export function profileSummary(p: Profile, displays: DisplayInfo[]): string {
  const template = TEMPLATES.find((t) => t.id === p.clock.template)?.label ?? 'CLOCK';
  const d = displayFor(p.window, displays);
  const where = d === null ? 'PRIMARY' : d === 'missing' ? 'DISPLAY NOT CONNECTED · USES PRIMARY' : (d.name ?? d.label.split(' · ')[0]!).toUpperCase();
  const mods = (['ai', 'world', 'system', 'focus'] as const).filter((m) => p.modules[m]).length;
  return `${MODE_LABEL[p.window.mode]} · ${template} · ${mods} ${mods === 1 ? 'MODULE' : 'MODULES'} · ${where}`;
}

function ProfileRow({ p, active, displays, canAdd }: { p: Profile; active: boolean; displays: DisplayInfo[]; canAdd: boolean }) {
  const { actions } = useFlip();
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(p.name);
  const [confirm, setConfirm] = useState<null | 'delete' | 'reset'>(null);
  const rename = async () => {
    const n = name.trim();
    if (!n || n.toUpperCase() === p.name) return setRenaming(false);
    if (await actions.renameProfile(p.id, n)) setRenaming(false);
  };
  return (
    <div className={`fl-prof${active ? ' is-on' : ''}`} data-testid={`profile-${p.id}`}>
      <div className="fl-prof__main">
        {renaming ? (
          <input
            className="fl-input"
            aria-label={`New name for ${p.name}`}
            value={name}
            maxLength={24}
            autoFocus
            onChange={(e) => setName(e.target.value)}
            onBlur={() => void rename()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void rename();
              if (e.key === 'Escape') {
                e.stopPropagation();
                setName(p.name);
                setRenaming(false);
              }
            }}
          />
        ) : (
          <span className="fl-prof__name">
            {p.name}
            {active && <span className="fl-prof__badge">ACTIVE</span>}
            {!p.builtin && <span className="fl-prof__badge fl-prof__badge--dim">CUSTOM</span>}
          </span>
        )}
        <span className="fl-ink3 fl-small">{profileSummary(p, displays)}</span>
      </div>
      <div className="fl-prof__act">
        {confirm ? (
          <>
            <button
              className="fl-btn fl-btn--primary"
              onClick={() => {
                setConfirm(null);
                void (confirm === 'delete' ? actions.deleteProfile(p.id) : actions.resetProfile(p.id));
              }}
            >
              {confirm === 'delete' ? 'CONFIRM DELETE' : 'CONFIRM RESET'}
            </button>
            <button className="fl-btn" onClick={() => setConfirm(null)}>
              CANCEL
            </button>
          </>
        ) : (
          <>
            <button className={`fl-btn${active ? ' is-on' : ''}`} aria-pressed={active} disabled={active} onClick={() => void actions.activateProfile(p.id)} aria-label={`Use ${p.name}`}>
              {active ? 'IN USE' : 'USE'}
            </button>
            <button className="fl-btn" disabled={!canAdd} onClick={() => void actions.createProfile(`${p.name} COPY`, p.id)} aria-label={`Duplicate ${p.name}`}>
              DUPLICATE
            </button>
            {p.builtin ? (
              <button className="fl-btn" onClick={() => setConfirm('reset')} aria-label={`Reset ${p.name}`}>
                RESET
              </button>
            ) : (
              <>
                <button className="fl-btn" onClick={() => setRenaming(true)} aria-label={`Rename ${p.name}`}>
                  RENAME
                </button>
                <button className="fl-btn" onClick={() => setConfirm('delete')} aria-label={`Delete ${p.name}`}>
                  DELETE
                </button>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export function ProfilesTab({ s, set, displays }: { s: Settings; set: Upd; displays: DisplayInfo[] }) {
  const { actions } = useFlip();
  const [name, setName] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const pr = s.profiles;
  const canAdd = pr.items.length < MAX_PROFILES;
  const auto = pr.autoSwitch;
  const putAuto = (patch: Partial<Settings['profiles']['autoSwitch']>) =>
    set((x) => ({ ...x, profiles: { ...x.profiles, autoSwitch: { ...x.profiles.autoSwitch, ...patch } } }));
  const create = async () => {
    const n = name.trim();
    if (!n) return setErr('ENTER A NAME');
    if (!canAdd) return setErr(`UP TO ${MAX_PROFILES} PROFILES`);
    setErr(null);
    if (await actions.createProfile(n, null)) setName('');
  };
  const target = (value: string | null, onChange: (v: string | null) => void, label: string) => (
    <select className="fl-select" aria-label={label} value={value ?? ''} onChange={(e) => onChange(e.target.value || null)}>
      <option value="">DON&apos;T SWITCH</option>
      {pr.items.map((p) => (
        <option key={p.id} value={p.id}>
          {p.name}
        </option>
      ))}
    </select>
  );
  return (
    <>
      <Head>PROFILES · {pr.items.length} OF {MAX_PROFILES} · SWITCH FROM THE TRAY OR WITH {s.shortcuts.profile.toUpperCase()}</Head>
      <div className="fl-note fl-ink2">
        A profile remembers the dashboard&apos;s modules and order, clock style, appearance, display, mode and position. Time zones, cities, AI
        sources, focus timer and shortcuts are shared by all profiles. Changes you make are saved to the active profile.
      </div>
      {pr.items.map((p) => (
        <ProfileRow key={p.id + p.name} p={p} active={p.id === pr.active} displays={displays} canAdd={canAdd} />
      ))}
      <Head>NEW PROFILE FROM THE CURRENT LAYOUT</Head>
      <div className="fl-addcity">
        <input
          className="fl-input"
          aria-label="New profile name"
          placeholder="NAME"
          value={name}
          maxLength={24}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void create();
          }}
        />
        <button className="fl-btn" onClick={() => void create()} disabled={!canAdd}>
          CREATE
        </button>
      </div>
      {err && (
        <div className="fl-srow fl-warn" role="alert">
          {err}
        </div>
      )}
      <Head>AUTO-SWITCH WHEN DISPLAYS CHANGE</Head>
      <Row label="AUTO-SWITCH" hint="Optional. Checked every few seconds; FLIP never takes focus when it switches">
        <OnOff value={auto.enabled} onChange={(v) => putAuto({ enabled: v })} label="Auto-switch profiles" />
      </Row>
      {auto.enabled && (
        <>
          <Row label="ONE DISPLAY" hint="E.g. a laptop on its own">
            {target(auto.singleDisplay, (v) => putAuto({ singleDisplay: v }), 'Profile for one display')}
          </Row>
          <Row label="TWO OR MORE" hint="E.g. docked with external monitors">
            {target(auto.multiDisplay, (v) => putAuto({ multiDisplay: v }), 'Profile for two or more displays')}
          </Row>
        </>
      )}
    </>
  );
}
