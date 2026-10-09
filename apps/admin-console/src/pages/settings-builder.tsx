import { useState } from 'react';
import { PROFILE_AREAS, PROFILE_PRESETS, PROFILE_SETTINGS, applyPreset, getPath, presetApplied, setPath, type ProfileSetting } from '@fbrx/shared';
import { Field, Icons, InfoTip, Input, JsonEditor, More, Select, TextArea } from '@fbrx/ui';

export interface SettingsDraft {
  settings: Record<string, unknown>;
  locked: string[];
}

const NOT_SET = '';
const listText = (l: string[]) => l.join('\n');
const parseList = (t: string) => [...new Set(t.split(/[\n,]/).map((x) => x.trim()).filter(Boolean))];

/**
 * Settings and locks for a profile or one device, without writing JSON: ready-made presets ("No Fun Extras"…), and the
 * usual settings as switches and lists, each with an (i) that says what it does and a lock. Everything else, and the
 * same settings as text, stay under "Advanced".
 */
export function SettingsBuilder({ value, onChange, disabled, onJsonValidity }: { value: SettingsDraft; onChange: (v: SettingsDraft) => void; disabled?: boolean; onJsonValidity?: (ok: boolean) => void }) {
  const [json, setJson] = useState(() => JSON.stringify(value.settings, null, 2));
  const [lockText, setLockText] = useState(() => listText(value.locked));
  const [find, setFind] = useState('');
  // Areas with something set or locked are open, the others closed, until someone opens or closes one.
  const [shown, setShown] = useState<Record<string, boolean>>({});
  const update = (next: SettingsDraft) => {
    setJson(JSON.stringify(next.settings, null, 2));
    setLockText(listText(next.locked));
    onJsonValidity?.(true);
    onChange(next);
  };
  const setValue = (path: string, v: unknown) => update({ settings: setPath(value.settings, path, v), locked: value.locked });
  const toggleLock = (path: string) => update({ settings: value.settings, locked: value.locked.includes(path) ? value.locked.filter((x) => x !== path) : [...value.locked, path] });
  const q = find.trim().toLowerCase();
  const matches = (s: ProfileSetting) => !q || s.label.toLowerCase().includes(q) || s.help.toLowerCase().includes(q) || s.path.toLowerCase().includes(q);
  const listed = new Set(PROFILE_SETTINGS.map((s) => s.path));
  const setCount = PROFILE_SETTINGS.filter((s) => getPath(value.settings, s.path) !== undefined).length;
  const otherLocks = value.locked.filter((l) => !listed.has(l));

  return (
    <div className="sb">
      <div className="fx-label">Ready-made</div>
      <div className="sb-presets">
        {PROFILE_PRESETS.map((p) => {
          const on = presetApplied(p, value.settings, value.locked);
          return (
            <button key={p.id} type="button" className={`sb-preset${on ? ' on' : ''}`} aria-pressed={on} disabled={disabled} onClick={() => update(applyPreset(p, value.settings, value.locked, !on))}>
              <span className="sb-preset-head">
                <b>{p.name}</b>
                {on ? <Icons.checkCircle size={16} /> : <Icons.plus size={15} />}
              </span>
              <span className="sb-preset-desc">{p.description}</span>
            </button>
          );
        })}
      </div>

      <div className="sb-toolbar">
        <div style={{ flex: 1, maxWidth: 320 }}>
          <Input value={find} onChange={(e) => setFind(e.target.value)} placeholder="Find a setting" aria-label="Find a setting" />
        </div>
        <span className="fx-muted" style={{ fontSize: 12.5 }}>
          {setCount} set · {value.locked.length} locked · the rest is each computer’s own choice
        </span>
      </div>

      {PROFILE_AREAS.map((area) => {
        const rows = PROFILE_SETTINGS.filter((s) => s.area === area.id && matches(s));
        if (!rows.length) return null;
        const n = rows.filter((s) => getPath(value.settings, s.path) !== undefined).length;
        const busy = rows.some((s) => getPath(value.settings, s.path) !== undefined || value.locked.includes(s.path));
        const isOpen = !!q || (shown[area.id] ?? busy);
        return (
          <div key={area.id} className="sb-area">
            <button type="button" className="sb-area-head" aria-expanded={isOpen} onClick={() => setShown((o) => ({ ...o, [area.id]: !isOpen }))}>
              <Icons.chevronRight size={14} className="sb-chev" />
              <b>{area.label}</b>
              {n > 0 && <span className="fx-badge">{n} set</span>}
            </button>
            {isOpen &&
              rows.map((s) => {
                const v = getPath(value.settings, s.path);
                const locked = value.locked.includes(s.path);
                return (
                  <div key={s.path} className={`sb-row${v !== undefined ? ' set' : ''}`}>
                    <span className="sb-label">
                      {s.label}
                      <InfoTip label={`About ${s.label}`}>
                        {s.help}
                        <span className="sb-path mono">{s.path}</span>
                      </InfoTip>
                    </span>
                    <span className="sb-control">
                      <Control s={s} v={v} disabled={disabled} onChange={(x) => setValue(s.path, x)} />
                    </span>
                    <button
                      type="button"
                      className={`sb-lock${locked ? ' on' : ''}`}
                      aria-pressed={locked}
                      disabled={disabled}
                      title={locked ? 'Locked: people cannot change it on their computer' : 'Lock it so people cannot change it on their computer'}
                      onClick={() => toggleLock(s.path)}
                    >
                      {locked ? <Icons.lock size={13} /> : <Icons.unlock size={13} />}
                      {locked ? 'Locked' : 'Lock'}
                    </button>
                  </div>
                );
              })}
          </div>
        );
      })}

      <More label="Advanced: everything as text">
        <Field label="Settings (JSON, partial)" help="Any FBRX OS setting, not only the ones above. The switches above and this text are the same profile.">
          <JsonEditor
            value={json}
            rows={10}
            onChange={(t) => {
              setJson(t);
              try {
                const parsed = t.trim() ? JSON.parse(t) : {};
                if (typeof parsed === 'object' && parsed && !Array.isArray(parsed)) {
                  onJsonValidity?.(true);
                  onChange({ settings: parsed, locked: value.locked });
                  return;
                }
              } catch {
                /* shown by the editor */
              }
              onJsonValidity?.(false);
            }}
          />
        </Field>
        <Field label="Locked settings" help="One dotted path per line, for any setting (the locks above are here too).">
          <TextArea
            code
            rows={4}
            disabled={disabled}
            value={lockText}
            onChange={(e) => {
              setLockText(e.target.value);
              onChange({ settings: value.settings, locked: parseList(e.target.value) });
            }}
            placeholder={'ai.defaultProvider\nbackup.scheduleEnabled'}
          />
        </Field>
        {otherLocks.length > 0 && <div className="fx-muted" style={{ fontSize: 12 }}>Also locked: {otherLocks.join(', ')}</div>}
      </More>
    </div>
  );
}

function Control({ s, v, disabled, onChange }: { s: ProfileSetting; v: unknown; disabled?: boolean; onChange: (v: unknown) => void }) {
  if (s.kind === 'toggle') {
    const cur = v === true ? 'on' : v === false ? 'off' : NOT_SET;
    return (
      <span className="sb-seg" role="radiogroup" aria-label={s.label}>
        {[
          { id: NOT_SET, label: 'Not set', title: 'Each computer keeps its own choice' },
          { id: 'on', label: 'On', title: 'On for every computer here' },
          { id: 'off', label: 'Off', title: 'Off for every computer here' },
        ].map((o) => (
          <button key={o.id || 'unset'} type="button" role="radio" aria-checked={cur === o.id} className={cur === o.id ? 'on' : ''} title={o.title} disabled={disabled} onClick={() => onChange(o.id === NOT_SET ? undefined : o.id === 'on')}>
            {o.label}
          </button>
        ))}
      </span>
    );
  }
  if (s.kind === 'select') {
    return (
      <Select
        value={typeof v === 'string' ? v : NOT_SET}
        disabled={disabled}
        aria-label={s.label}
        onChange={(e) => onChange(e.target.value === NOT_SET ? undefined : e.target.value)}
        options={[{ value: NOT_SET, label: 'Not set (each computer decides)' }, ...(s.options ?? [])]}
      />
    );
  }
  if (s.kind === 'number') {
    return (
      <span className="sb-num">
        <Input
          type="number"
          min={s.min}
          max={s.max}
          disabled={disabled}
          aria-label={s.label}
          value={typeof v === 'number' ? v : ''}
          placeholder="Not set"
          onChange={(e) => {
            const raw = e.target.value;
            if (raw === '') return onChange(undefined);
            const n = Math.round(Number(raw));
            if (Number.isFinite(n)) onChange(Math.min(s.max ?? n, Math.max(s.min ?? n, n)));
          }}
        />
        {s.unit && <span className="fx-muted">{s.unit}</span>}
      </span>
    );
  }
  return <Input value={typeof v === 'string' ? v : ''} disabled={disabled} aria-label={s.label} placeholder="Not set" onChange={(e) => onChange(e.target.value === '' ? undefined : e.target.value)} />;
}
