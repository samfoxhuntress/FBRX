import { useMemo, useState } from 'react';
import { TOOLKIT_INPUT_KINDS, TOOLKIT_LIMITS, TOOLKIT_SYSTEMS, TOOLKIT_SYSTEM_NAMES, toolkitPlaceholders, type ToolkitAction, type ToolkitInput, type ToolkitInputKind, type ToolkitSystem } from '@fbrx/shared';
import { Badge, Button, Callout, Card, Empty, Field, Input, Modal, Page, Select, Tabs, TextArea, Toggle, timeAgo, useAction, useConfirm } from '@fbrx/ui';
import { call } from '../client';
import { useAgentName, useCore } from '../hooks';
import { SkillsSettings } from './settings-skills';

/**
 * AI Toolkit: the ready-made actions the AI runs for you, each a command for this computer. FBRX's library, the ones
 * the AI built (each kept only when you approved it) and your own, in toolkits. Change any of them to make it do the
 * job your way: what it runs, whether it asks first, when it is used.
 */

const KIND_LABEL: Record<ToolkitInputKind, string> = { host: 'A host or address', ip: 'An IPv4 address', number: 'A number', name: 'A name', text: 'Some text' };

type Filter = 'all' | 'library' | 'built' | 'yours' | 'changed';

interface Draft {
  id?: string;
  source?: ToolkitAction['source'];
  changed?: boolean;
  name: string;
  kit: string;
  when: string;
  commands: Record<ToolkitSystem, string>;
  inputs: ToolkitInput[];
  ask: boolean;
  admin: ToolkitSystem[];
  undoOn: boolean;
  undoSeconds: number;
  undo: Record<ToolkitSystem, string>;
}

const empty = (): Record<ToolkitSystem, string> => ({ windows: '', mac: '', linux: '' });
const toDraft = (a: ToolkitAction): Draft => ({
  id: a.id,
  source: a.source,
  changed: a.changed,
  name: a.name,
  kit: a.kit,
  when: a.when,
  commands: { ...empty(), ...a.commands },
  inputs: a.inputs.map((i) => ({ ...i })),
  ask: a.ask,
  admin: [...a.admin],
  undoOn: !!a.undo,
  undoSeconds: a.undo?.seconds ?? 60,
  undo: { ...empty(), ...(a.undo?.commands ?? {}) },
});

export function ToolkitPage() {
  const agent = useAgentName();
  const [tab, setTab] = useState<'toolkits' | 'skills'>('toolkits');
  const [draft, setDraft] = useState<Draft | null>(null);
  const kit = useCore('toolkit.list', undefined, ['toolkit.changed']);
  return (
    <Page
      title="AI Toolkit"
      description={`Ready-made actions ${agent} runs for you, each a command for this computer: FBRX's library, the ones ${agent} built, and your own. Change any of them to make ${agent} do it your way.`}
      actions={
        tab === 'toolkits' && (
          <Button icon="plus" onClick={() => setDraft({ name: '', kit: 'Mine', when: '', commands: empty(), inputs: [], ask: true, admin: [], undoOn: false, undoSeconds: 60, undo: empty() })}>
            New action
          </Button>
        )
      }
    >
      <Tabs
        active={tab}
        onChange={setTab}
        tabs={[
          { id: 'toolkits', label: 'Toolkits' },
          { id: 'skills', label: 'Skills' },
        ]}
      />
      {tab === 'skills' ? <SkillsSettings /> : kit.data ? <Toolkits actions={kit.data.actions} system={kit.data.system} onEdit={(a) => setDraft(toDraft(a))} /> : <Empty title="Loading…" />}
      {draft && kit.data && <EditAction draft={draft} setDraft={setDraft} system={kit.data.system} kits={[...new Set(kit.data.actions.map((a) => a.kit))]} onClose={() => setDraft(null)} />}
    </Page>
  );
}

function Toolkits({ actions, system, onEdit }: { actions: ToolkitAction[]; system: ToolkitSystem; onEdit: (a: ToolkitAction) => void }) {
  const agent = useAgentName();
  const { run } = useAction();
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [trying, setTrying] = useState<ToolkitAction | null>(null);
  const shown = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    return actions.filter(
      (a) =>
        (filter === 'all' || (filter === 'changed' ? a.changed : a.source === filter)) &&
        words.every((w) => `${a.name} ${a.when} ${a.kit} ${a.tool} ${a.commands[system] ?? ''}`.toLowerCase().includes(w)),
    );
  }, [actions, q, filter, system]);
  const kits = [...new Set(shown.map((a) => a.kit))];
  const source = (a: ToolkitAction) => (a.source === 'built' ? `Built by ${agent}` : a.source === 'yours' ? 'Yours' : a.changed ? 'Changed by you' : null);
  return (
    <>
      <div className="fx-row">
        <div style={{ flex: 1, minWidth: 220 }}>
          <Input placeholder="Find an action or a command…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div style={{ width: 210 }}>
          <Select
            aria-label="Show"
            value={filter}
            onChange={(e) => setFilter(e.target.value as Filter)}
            options={[
              { value: 'all', label: 'Every action' },
              { value: 'library', label: "FBRX's library" },
              { value: 'built', label: `Built by ${agent}` },
              { value: 'yours', label: 'Yours' },
              { value: 'changed', label: 'Changed by you' },
            ]}
          />
        </div>
      </div>
      {!shown.length && <Empty title="No actions match">{filter === 'built' ? `When ${agent} works out a command you may need again, it offers to keep it here.` : 'Try other words.'}</Empty>}
      {kits.map((k) => (
        <Card key={k} title={k} subtitle={`${shown.filter((a) => a.kit === k).length} action${shown.filter((a) => a.kit === k).length === 1 ? '' : 's'}`}>
          <div className="fx-list">
            {shown
              .filter((a) => a.kit === k)
              .map((a) => (
                <div key={a.id} className="fx-list-item kit-item">
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="fx-cell-title">
                      {a.name} {a.ask ? <Badge>Asks first</Badge> : <Badge tone="accent">Only looks</Badge>}
                      {a.admin.includes(system) && <Badge>Administrator</Badge>}
                      {a.undo && <Badge>Puts itself back</Badge>}
                      {source(a) && <Badge>{source(a)}</Badge>}
                    </div>
                    <div className="fx-cell-sub">
                      {a.when}
                      {a.uses ? ` · used ${a.uses} time${a.uses === 1 ? '' : 's'}${a.lastUsedAt ? `, last ${timeAgo(a.lastUsedAt)}` : ''}` : ''}
                    </div>
                    {a.commands[system] ? <code className="kit-cmd">{a.commands[system]}</code> : <div className="fx-cell-sub">No command for {TOOLKIT_SYSTEM_NAMES[system]} yet: edit it to add one.</div>}
                  </div>
                  <Button size="sm" variant="ghost" icon="play" disabled={!a.enabled || !a.commands[system]} onClick={() => setTrying(a)}>
                    Try
                  </Button>
                  <Button size="sm" variant="ghost" icon="edit" aria-label={`Edit ${a.name}`} onClick={() => onEdit(a)} />
                  <Toggle checked={a.enabled} title={a.enabled ? `On: ${agent} can run it` : 'Off'} onChange={(on) => void run(`on:${a.id}`, () => call('toolkit.setEnabled', { id: a.id, enabled: on }))} />
                </div>
              ))}
          </div>
        </Card>
      ))}
      {trying && <TryAction action={trying} system={system} onClose={() => setTrying(null)} />}
    </>
  );
}

/** Runs an action here and now, as you (no approval: you are the one asking), and shows what it printed. */
function TryAction({ action, system, onClose }: { action: ToolkitAction; system: ToolkitSystem; onClose: () => void }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [out, setOut] = useState<{ ok: boolean; text: string } | null>(null);
  const { run, busy } = useAction();
  const go = async () => {
    const r = await run('try', () => call('tools.invoke', { name: action.tool, input: values }));
    if (r) setOut({ ok: r.ok, text: r.ok ? r.output : (r.error ?? r.output) });
  };
  return (
    <Modal
      wide
      title={`Try: ${action.name}`}
      description={action.undo ? `It puts the change back after ${action.undo.seconds} seconds unless you keep it (FBRX asks).` : undefined}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
          <Button variant="primary" icon="play" loading={busy === 'try'} disabled={action.inputs.some((i) => !values[i.name]?.trim())} onClick={() => void go()}>
            Run it
          </Button>
        </>
      }
    >
      <code className="kit-cmd">{action.commands[system]}</code>
      {action.inputs.map((i) => (
        <Field key={i.name} label={i.label}>
          <Input value={values[i.name] ?? ''} onChange={(e) => setValues({ ...values, [i.name]: e.target.value })} />
        </Field>
      ))}
      {out && (out.ok ? <pre className="fx-code kit-out">{out.text}</pre> : <Callout tone="critical" title="It did not run">{out.text}</Callout>)}
    </Modal>
  );
}

function EditAction({ draft, setDraft, system, kits, onClose }: { draft: Draft; setDraft: (d: Draft) => void; system: ToolkitSystem; kits: string[]; onClose: () => void }) {
  const agent = useAgentName();
  const { run, busy } = useAction();
  const { confirm, dialog } = useConfirm();
  const d = draft;
  const set = (p: Partial<Draft>) => setDraft({ ...d, ...p });
  const systems = [system, ...TOOLKIT_SYSTEMS.filter((s) => s !== system)];
  const used = new Set([...Object.values(d.commands), ...(d.undoOn ? Object.values(d.undo) : [])].flatMap((c) => toolkitPlaceholders(c)));
  const missing = [...used].filter((u) => !d.inputs.some((i) => i.name === u));
  const save = async () => {
    const r = await run(
      'save',
      () =>
        call('toolkit.save', {
          ...(d.id ? { id: d.id } : {}),
          name: d.name,
          kit: d.kit,
          when: d.when,
          commands: d.commands,
          inputs: d.inputs,
          ask: d.ask,
          admin: d.admin,
          undo: d.undoOn ? { seconds: d.undoSeconds, commands: d.undo } : null,
        }),
      'Action saved',
    );
    if (r) onClose();
  };
  const reset = async () => {
    if (await confirm({ title: `Put "${d.name}" back as FBRX wrote it?`, body: 'Your changes to it are forgotten.', confirmLabel: 'Reset' })) {
      if (await run('reset', () => call('toolkit.reset', { id: d.id! }), 'Back as FBRX wrote it')) onClose();
    }
  };
  const remove = async () => {
    if (await confirm({ title: `Delete "${d.name}"?`, body: `${agent} can no longer run it.`, confirmLabel: 'Delete', danger: true })) {
      if (await run('rm', () => call('toolkit.remove', { id: d.id! }))) onClose();
    }
  };
  return (
    <Modal
      wide
      title={d.id ? `Edit: ${d.name}` : 'New action'}
      description={`${agent} runs it when a request fits its name or "when". Write {{name}} in a command where an input goes.`}
      onClose={onClose}
      footer={
        <>
          {d.source === 'library' && d.changed && (
            <Button variant="ghost" loading={busy === 'reset'} onClick={() => void reset()}>
              Reset to FBRX's
            </Button>
          )}
          {d.id && d.source !== 'library' && (
            <Button variant="ghost" icon="trash" loading={busy === 'rm'} onClick={() => void remove()}>
              Delete
            </Button>
          )}
          <span className="fx-spacer" />
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy === 'save'} disabled={!d.name.trim() || !Object.values(d.commands).some((c) => c.trim()) || missing.length > 0} onClick={() => void save()}>
            Save
          </Button>
        </>
      }
    >
      <div className="fx-form">
      <div className="fx-row">
        <div style={{ flex: 2, minWidth: 220 }}>
          <Field label="Name">
            <Input value={d.name} maxLength={TOOLKIT_LIMITS.name} placeholder="My IP address" onChange={(e) => set({ name: e.target.value })} />
          </Field>
        </div>
        <div style={{ flex: 1, minWidth: 160 }}>
          <Field label="Toolkit">
            <Input value={d.kit} maxLength={TOOLKIT_LIMITS.kit} list="kit-names" onChange={(e) => set({ kit: e.target.value })} />
            <datalist id="kit-names">
              {kits.map((k) => (
                <option key={k} value={k} />
              ))}
            </datalist>
          </Field>
        </div>
      </div>
      <Field label="When to use it">
        <Input value={d.when} maxLength={TOOLKIT_LIMITS.when} placeholder="The person asks for their IP address" onChange={(e) => set({ when: e.target.value })} />
      </Field>
      {systems.map((s) => (
        <Field key={s} label={`Command on ${TOOLKIT_SYSTEM_NAMES[s]}${s === system ? ' (this computer)' : ''}`} help={s === 'windows' ? 'PowerShell' : undefined}>
          <TextArea code rows={s === system ? 3 : 2} value={d.commands[s]} onChange={(e) => set({ commands: { ...d.commands, [s]: e.target.value } })} />
        </Field>
      ))}
      <Field label="Inputs" help="What the command needs each time. FBRX checks each value and puts it in quoted, so it can never become a command of its own.">
        {d.inputs.map((inp, n) => (
          <div key={n} className="fx-row kit-input">
            <Input aria-label="Name" value={inp.name} placeholder="host" style={{ width: 120 }} onChange={(e) => set({ inputs: d.inputs.map((x, i) => (i === n ? { ...x, name: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '') } : x)) })} />
            <Input aria-label="What it is" value={inp.label} placeholder="The device to check" style={{ flex: 1 }} onChange={(e) => set({ inputs: d.inputs.map((x, i) => (i === n ? { ...x, label: e.target.value } : x)) })} />
            <Select aria-label="Kind" value={inp.kind} style={{ width: 170 }} onChange={(e) => set({ inputs: d.inputs.map((x, i) => (i === n ? { ...x, kind: e.target.value as ToolkitInputKind } : x)) })} options={TOOLKIT_INPUT_KINDS.map((k) => ({ value: k, label: KIND_LABEL[k] }))} />
            <Button size="sm" variant="ghost" icon="x" aria-label="Remove the input" onClick={() => set({ inputs: d.inputs.filter((_, i) => i !== n) })} />
          </div>
        ))}
        {d.inputs.length < TOOLKIT_LIMITS.inputs && (
          <div>
            <Button size="sm" icon="plus" onClick={() => set({ inputs: [...d.inputs, { name: missing[0] ?? '', label: '', kind: 'text' }] })}>
              Add an input
            </Button>
          </div>
        )}
      </Field>
      {missing.length > 0 && <Callout tone="warning">A command uses {missing.map((m) => `{{${m}}}`).join(', ')}: add {missing.length === 1 ? 'that input' : 'those inputs'}.</Callout>}
      <Toggle checked={d.ask} onChange={(v) => set({ ask: v })} label="Ask me before each run" info={`Turn off only for commands that just look. Your policy and the guardian still check every run, and ${agent} asks again after it changes the action.`} />
      <div className="kit-admin">
        <span className="fx-secondary">Needs administrator rights on</span>
        {TOOLKIT_SYSTEMS.map((s) => (
          <Toggle key={s} checked={d.admin.includes(s)} onChange={(v) => set({ admin: v ? [...d.admin, s] : d.admin.filter((x) => x !== s) })} label={TOOLKIT_SYSTEM_NAMES[s]} />
        ))}
      </div>
      <Toggle checked={d.undoOn} onChange={(v) => set({ undoOn: v, ask: v ? true : d.ask })} label="Put it back unless I keep the change" info="For a change that could cut you off (an address, a firewall rule): FBRX asks whether to keep it, and puts it back by itself when you do not answer." />
      {d.undoOn && (
        <div className="kit-undo">
          <Field label="Put it back after (seconds)">
            <Input type="number" min={TOOLKIT_LIMITS.undoSeconds.min} max={TOOLKIT_LIMITS.undoSeconds.max} value={d.undoSeconds} style={{ width: 120 }} onChange={(e) => set({ undoSeconds: Number(e.target.value) })} />
          </Field>
          {systems.map((s) => (
            <Field key={s} label={`What puts it back on ${TOOLKIT_SYSTEM_NAMES[s]}`}>
              <TextArea code rows={2} value={d.undo[s]} onChange={(e) => set({ undo: { ...d.undo, [s]: e.target.value } })} />
            </Field>
          ))}
        </div>
      )}
      </div>
      {dialog}
    </Modal>
  );
}
