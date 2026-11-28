import { useEffect, useState } from 'react';
import type { AgentAdoptResult, AgentSetupPreview } from '@fbrx/shared';
import { Button, Callout, Empty, Field, Modal, Select, Spinner, Toggle, useAction, useToast } from '@fbrx/ui';
import { call } from '../client';

/** Ticked rows in a list (skills, MCP servers). */
function Picks<T>({ items, keyOf, picked, onChange, render }: { items: T[]; keyOf: (t: T) => string; picked: string[]; onChange: (v: string[]) => void; render: (t: T) => React.ReactNode }) {
  return (
    <div style={{ display: 'grid', gap: 6 }}>
      {items.map((t) => {
        const k = keyOf(t);
        return (
          <label key={k} className="fx-row" style={{ gap: 8, alignItems: 'flex-start', cursor: 'pointer' }}>
            <input type="checkbox" checked={picked.includes(k)} onChange={(e) => onChange(e.target.checked ? [...picked, k] : picked.filter((x) => x !== k))} style={{ marginTop: 3 }} />
            <span>{render(t)}</span>
          </label>
        );
      })}
    </div>
  );
}

/**
 * Takes over Hermes Agent's setup on this computer: its persona, memories, skills and MCP servers, as the person ticks
 * them. Each comes in through FBRX's own checks; what does not is said, with why.
 */
export function AdoptHermes({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const { busy, run } = useAction();
  const [profile, setProfile] = useState('default');
  const [p, setP] = useState<AgentSetupPreview | null | undefined>(undefined);
  const [personality, setPersonality] = useState(true);
  const [memories, setMemories] = useState(true);
  const [aboutYou, setAboutYou] = useState(true);
  const [skills, setSkills] = useState<string[]>([]);
  const [servers, setServers] = useState<string[]>([]);
  const [done, setDone] = useState<AgentAdoptResult | null>(null);

  useEffect(() => {
    setP(undefined);
    void call('aicoord.setup', { profile }).then(
      (r) => {
        setP(r);
        setPersonality(!!r?.personality);
        setSkills(r?.skills.map((s) => s.name) ?? []);
        setServers(r?.servers.map((s) => s.name) ?? []);
      },
      () => setP(null),
    );
  }, [profile]);

  const adopt = () =>
    run('adopt', async () => {
      const r = await call('aicoord.adopt', { profile, personality, memories, aboutYou, skills, servers });
      setDone(r);
      const n = r.brought;
      const parts = [n.personality && 'its persona', n.memories && `${n.memories} memor${n.memories === 1 ? 'y' : 'ies'}`, n.aboutYou && `${n.aboutYou} note${n.aboutYou === 1 ? '' : 's'} about you`, n.skills && `${n.skills} skill${n.skills === 1 ? '' : 's'}`, n.servers && `${n.servers} MCP server${n.servers === 1 ? '' : 's'}`].filter(Boolean);
      toast.success(parts.length ? `Brought over ${parts.join(', ')}` : 'Nothing was brought over');
    });

  const nothing = p && !p.personality && !p.memories.length && !p.aboutYou.length && !p.skills.length && !p.servers.length;
  return (
    <Modal
      wide
      title="Bring Hermes Agent’s setup into FBRX"
      description="FBRX takes over what this computer’s Hermes Agent has made its own. Hermes keeps its copy; nothing there changes."
      onClose={onClose}
      footer={
        done ? (
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        ) : (
          <>
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" icon="download" loading={busy === 'adopt'} disabled={!p || !!nothing || !(personality || memories || aboutYou || skills.length || servers.length)} onClick={() => void adopt()}>
              Bring it over
            </Button>
          </>
        )
      }
    >
      {done ? (
        <div className="fx-form">
          <Callout tone="good" title="It is in FBRX now">
            Personality, Memory, AI skills and Connectors show what came over. The persona that was there before is kept: Settings → Personality → Undo puts it back.
          </Callout>
          {done.notBrought.length > 0 && (
            <Callout tone="warning" title="Not brought over">
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {done.notBrought.map((x, i) => (
                  <li key={i}>{x}</li>
                ))}
              </ul>
            </Callout>
          )}
        </div>
      ) : p === undefined ? (
        <div className="fx-row">
          <Spinner /> <span className="fx-muted">Reading Hermes Agent’s folder…</span>
        </div>
      ) : !p || nothing ? (
        <Empty title="Nothing to bring over">Hermes Agent keeps no persona, memories, skills or MCP servers on this computer{p ? ` (${p.folder})` : ''}.</Empty>
      ) : (
        <div className="fx-form">
          {p.profiles.length > 1 && (
            <Field label="Profile" help="Hermes keeps a setup for each of its profiles.">
              <Select value={profile} onChange={(e) => setProfile(e.target.value)} options={p.profiles.map((x) => ({ value: x, label: x === 'default' ? 'Default' : x }))} />
            </Field>
          )}
          {p.personality && (
            <div>
              <Toggle checked={personality} onChange={setPersonality} label={`Its persona (SOUL.md, ${p.personality.chars.toLocaleString()} characters): becomes Who I am in your Personality`} />
              <blockquote className="fx-muted" style={{ margin: '6px 0 0 44px', fontSize: 12.5, whiteSpace: 'pre-wrap' }}>
                {p.personality.start.replace(/\*\*/g, '')}
                {p.personality.chars > p.personality.start.length ? '…' : ''}
              </blockquote>
            </div>
          )}
          {p.memories.length > 0 && <Toggle checked={memories} onChange={setMemories} label={`What it remembers: ${p.memories.length} note${p.memories.length === 1 ? '' : 's'} (${p.memories.slice(0, 2).join('; ').slice(0, 90)}…)`} />}
          {p.aboutYou.length > 0 && <Toggle checked={aboutYou} onChange={setAboutYou} label={`What it knows about you: ${p.aboutYou.length} note${p.aboutYou.length === 1 ? '' : 's'}`} />}
          {p.skills.length > 0 && (
            <Field label={`Skills (${skills.length} of ${p.skills.length})`} help="They become your own AI skills; Fabrix uses one when its “when” fits.">
              <Picks items={p.skills} keyOf={(s) => s.name} picked={skills} onChange={setSkills} render={(s) => (
                <>
                  <b>{s.name}</b> <span className="fx-muted">· {s.when} · {s.steps} step{s.steps === 1 ? '' : 's'}{s.cut ? ' (its end is left out: longer than a skill holds)' : ''}</span>
                </>
              )} />
            </Field>
          )}
          {p.servers.length > 0 && (
            <Field label={`MCP servers (${servers.length} of ${p.servers.length})`} help="They become connections in Connectors, with their tools for Fabrix (following your approvals). Their keys go into your vault.">
              <Picks items={p.servers} keyOf={(s) => s.name} picked={servers} onChange={setServers} render={(s) => (
                <>
                  <b>{s.name}</b> <span className="fx-muted mono" style={{ fontSize: 12 }}>{s.what}</span>
                  {s.secrets.length > 0 && <span className="fx-muted"> · keys to the vault: {s.secrets.join(', ')}</span>}
                </>
              )} />
            </Field>
          )}
          {p.stays.length > 0 && (
            <div className="fx-help">
              Stays with Hermes: {p.stays.join('; ')}.
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
