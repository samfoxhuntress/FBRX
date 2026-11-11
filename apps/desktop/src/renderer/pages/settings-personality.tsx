import { useEffect, useMemo, useState } from 'react';
import { PERSONALITY_LIMITS, PERSONALITY_OPTIONS, PERSONALITY_OPTION_VALUE_MAX, personalityCommands, personalitySection, withPersonalitySection, type EffectiveInstructions } from '@fbrx/shared';
import { Badge, Button, Card, Field, Input, Select, Status, TextArea, timeAgo, useAction, useConfirm } from '@fbrx/ui';
import { call } from '../client';
import { useAgentName, useCore } from '../hooks';

/**
 * Settings → Personality: personality.md, the AI's persona (who it is, how it talks, the options you set, the commands you can type,
 * its toolkits and its notes). You edit it here; the AI changes it only with your yes (personality.update), and every change
 * keeps the version before it, so Undo goes back. FBRX's core principles are shown too, read-only: they are fixed and
 * not part of the file.
 */
export function PersonalitySettings() {
  const name = useAgentName();
  const personality = useCore('personality.get', undefined, ['personality.changed']);
  const { run, busy } = useAction();
  const { confirm, dialog } = useConfirm();
  const [text, setText] = useState<string | null>(null);
  const [earlier, setEarlier] = useState<string | null>(null);
  const saved = personality.data?.text ?? '';
  // What is on screen follows the file until you start editing.
  useEffect(() => {
    if (text === null && personality.data) setText(personality.data.text);
  }, [personality.data, text]);
  const draft = text ?? saved;
  const changed = draft !== saved;
  const commands = useMemo(() => personalityCommands(draft), [draft]);
  const groups = [...new Set(commands.map((c) => c.group))];

  const save = () => void run('save', () => call('personality.set', { text: draft }).then((s) => setText(s.text)), 'personality.md saved');
  const undo = () => void run('undo', () => call('personality.undo').then((s) => setText(s.text)), 'Back to the version before');
  const reset = async () => {
    if (await confirm({ title: 'Go back to FBRX’s personality.md?', body: 'Your version is kept: Undo brings it back.', confirmLabel: 'Use FBRX’s', danger: true })) void run('reset', () => call('personality.reset').then((s) => setText(s.text)), 'FBRX’s personality.md is back');
  };

  const s = personality.data;
  const showEarlier = () => void run('earlier', () => call('personality.previous').then((r) => setEarlier(r.text ?? 'The earlier version is no longer kept.')));
  const dismiss = () => void run('dismiss', () => call('personality.dismissNotice').then(() => setEarlier(null)));
  return (
    <>
      {s?.notice && (
        <Card title="personality.md changed with this update" subtitle={`FBRX’s core principles are fixed now and come first in everything ${name} is told, so these left your personality.md: ${s.notice.removed.join('; ')}. Your earlier version is kept.`}>
          {earlier !== null && <TextArea code rows={12} value={earlier} readOnly aria-label="The earlier personality.md" />}
          <div className="fx-actions" style={{ marginTop: 10 }}>
            {earlier === null && (
              <Button loading={busy === 'earlier'} onClick={showEarlier}>
                Show the earlier version
              </Button>
            )}
            <Button variant="ghost" loading={busy === 'dismiss'} onClick={dismiss}>
              Got it
            </Button>
          </div>
        </Card>
      )}
      <PersonaPicker onUsed={(t) => setText(t)} disabled={changed} />
      <OptionsEditor text={saved} onSaved={(t) => setText(t)} disabled={changed} />
      <Card
        title="Personality"
        subtitle={`Who ${name} is and how it sounds and works on this computer: personality.md, its persona. It follows the options from your next message, and a command when you start a message with one (/help lists them). ${name} changes it only when you say yes.`}
        actions={
          s && <Badge tone={s.isDefault ? undefined : 'accent'}>{s.isDefault ? 'FBRX’s default' : 'Yours'}</Badge>
        }
      >
        <TextArea code rows={22} value={draft} spellCheck={false} maxLength={PERSONALITY_LIMITS.file} aria-label="personality.md" onChange={(e) => setText(e.target.value)} />
        <div className="fx-actions" style={{ marginTop: 10 }}>
          <Button variant="primary" icon="save" disabled={!changed} loading={busy === 'save'} onClick={save}>
            Save
          </Button>
          {changed && (
            <Button variant="ghost" onClick={() => setText(saved)}>
              Discard changes
            </Button>
          )}
          <Button icon="undo" disabled={!s?.history.length || changed} loading={busy === 'undo'} onClick={undo} title="The version before the last change">
            Undo the last change
          </Button>
          <Button variant="ghost" icon="refresh" disabled={!!s?.isDefault} loading={busy === 'reset'} onClick={() => void reset()}>
            Use FBRX’s
          </Button>
        </div>
        {s && (
          <p className="fx-help">
            {draft.length.toLocaleString()} of {PERSONALITY_LIMITS.file.toLocaleString()} characters · {s.path}
            {s.history[0] && ` · last changed ${timeAgo(s.history[0].at)} by ${s.history[0].by === 'Fabrix' ? name : s.history[0].by}`}
          </p>
        )}
      </Card>
      {s && (
        <Card title="FBRX’s core principles" subtitle={`Fixed: they come with FBRX and come first in everything ${name} is told. No persona, personality.md, setting, skill or memory changes them, so personality.md holds no principles and no options about approvals, secrets or safety (Governance sets approvals). Other words in personality.md ${name} reads as its persona, under these.`}>
          <div className="fx-muted" style={{ whiteSpace: 'pre-wrap' }}>
            {s.core}
          </div>
        </Card>
      )}
      <Card title="Commands" subtitle={`Start a message with one and ${name} does it. Add, change or remove them in the Commands section above.`}>
        {groups.map((g) => (
          <div key={g} className="personality-group">
            <h4>{g}</h4>
            <ul>
              {commands
                .filter((c) => c.group === g)
                .map((c) => (
                  <li key={c.name}>
                    <code>
                      /{c.name}
                      {c.hint ? ` ${c.hint}` : ''}
                    </code>{' '}
                    <span className="fx-muted">{c.does.split(/[:.](\s|$)/)[0]}</span>
                  </li>
                ))}
            </ul>
          </div>
        ))}
        {!commands.length && <p className="fx-muted">No commands: add a Commands section with lines like “- `/name what` — what it does”.</p>}
      </Card>
      <WhatAiReads />
      {dialog}
    </>
  );
}

/**
 * Ready-made personas: pick one and it becomes Who I am, How I talk and its options in personality.md. Your commands,
 * toolkits and notes stay, and Undo brings back the one before.
 */
function PersonaPicker({ onUsed, disabled }: { onUsed: (text: string) => void; disabled: boolean }) {
  const name = useAgentName();
  const list = useCore('personality.personas', undefined, ['personality.changed']);
  const { run, busy } = useAction();
  const current = list.data?.find((p) => p.current)?.id ?? '';
  const [picked, setPicked] = useState('');
  const shown = list.data?.find((p) => p.id === (picked || current));
  const use = (id: string) => void run('persona', () => call('personality.usePersona', { id }).then((st) => onUsed(st.text)), `${name} is now: ${list.data?.find((p) => p.id === id)?.name ?? id}`);
  if (!list.data) return null;
  return (
    <Card title="Ready-made personas" subtitle={`Pick how ${name} sounds and works. It changes Who I am, How I talk and the options it sets; your commands, toolkits and notes stay, and Undo brings back the one before. FBRX’s core principles are the same in every one.`}>
      <div className="persona-grid" role="radiogroup" aria-label="Personas">
        {list.data.map((p) => (
          <button key={p.id} type="button" role="radio" aria-checked={(picked || current) === p.id} className={`fx-choice${(picked || current) === p.id ? ' active' : ''}`} onClick={() => setPicked(p.id)}>
            <span className="fx-choice-head">
              <b>{p.name}</b>
              {p.current && <Badge tone="accent">In use</Badge>}
            </span>
            <span className="fx-choice-desc">{p.blurb}</span>
          </button>
        ))}
      </div>
      {shown && (
        <div className="persona-preview">
          <p>{shown.who}</p>
          <ul>
            {shown.talk.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>
          <div className="fx-actions">
            {shown.current ? (
              <span className="fx-muted">{name} uses this one now.</span>
            ) : (
              <Button variant="primary" loading={busy === 'persona'} disabled={disabled} onClick={() => use(shown.id)}>
                Use {shown.name}
              </Button>
            )}
            {disabled && !shown.current && <span className="fx-muted">Save or undo your edits below first.</span>}
          </div>
        </div>
      )}
    </Card>
  );
}

/** The options as fields: each `- key: value` line of the Options section, and one to add. */
function OptionsEditor({ text, onSaved, disabled }: { text: string; onSaved: (text: string) => void; disabled: boolean }) {
  const name = useAgentName();
  const { run, busy } = useAction();
  const lines = (personalitySection(text, 'Options')?.body ?? '').split('\n');
  const read = () => {
    const out: Array<[string, string]> = [];
    for (const l of lines) {
      const m = /^-\s*([a-z-]+)\s*:\s*(.*)$/i.exec(l.trim());
      if (m && (PERSONALITY_OPTIONS as readonly string[]).includes(m[1]!.toLowerCase())) out.push([m[1]!.toLowerCase(), m[2]!]);
    }
    return out;
  };
  const [values, setValues] = useState<Array<[string, string]>>(read);
  const [adding, setAdding] = useState('');
  useEffect(() => setValues(read()), [text]); // eslint-disable-line react-hooks/exhaustive-deps
  const unused = PERSONALITY_OPTIONS.filter((k) => !values.some(([v]) => v === k));
  const dirty = JSON.stringify(values) !== JSON.stringify(read());
  const save = () =>
    void run(
      'options',
      () => {
        const kept = lines.filter((l) => !/^-\s*[a-z-]+\s*:/i.test(l.trim()) || !(PERSONALITY_OPTIONS as readonly string[]).includes((/^-\s*([a-z-]+)/i.exec(l.trim())?.[1] ?? '').toLowerCase()));
        const body = [...kept.filter((l) => l.trim()), ...values.filter(([, v]) => v.trim()).map(([k, v]) => `- ${k}: ${v.trim()}`)].join('\n');
        return call('personality.set', { text: withPersonalitySection(text, 'Options', body, 'replace') }).then((st) => onSaved(st.text));
      },
      'Options saved',
    );
  return (
    <Card title="Options" subtitle={`How ${name} sounds and works, one value each. They change its voice and habits, never what it may do; ${name} follows them from your next message.`}>
      <div className="options-grid">
        {values.map(([k, v], i) => (
          <Field key={k} label={k}>
            <div className="options-row">
              <Input value={v} maxLength={PERSONALITY_OPTION_VALUE_MAX} onChange={(e) => setValues(values.map((x, j) => (j === i ? [k, e.target.value] : x)))} />
              <Button size="sm" variant="ghost" icon="x" aria-label={`Remove ${k}`} onClick={() => setValues(values.filter((_x, j) => j !== i))} />
            </div>
          </Field>
        ))}
      </div>
      <div className="fx-actions" style={{ marginTop: 10 }}>
        {unused.length > 0 && (
          <Select
            value={adding}
            aria-label="Add an option"
            options={[{ value: '', label: 'Add an option…' }, ...unused.map((k) => ({ value: k, label: k }))]}
            onChange={(e) => {
              const k = e.target.value;
              if (k) setValues([...values, [k, '']]);
              setAdding('');
            }}
          />
        )}
        <Button variant="primary" disabled={!dirty || disabled} loading={busy === 'options'} onClick={save}>
          Save options
        </Button>
        {disabled && <span className="fx-muted">Save or undo your edits below first.</span>}
      </div>
    </Card>
  );
}

/** What the AI reads before every answer: FBRX's core principles first, then the persona and the rest, as sent. */
function WhatAiReads() {
  const name = useAgentName();
  const { run, busy } = useAction();
  const [offline, setOffline] = useState(false);
  const [r, setR] = useState<EffectiveInstructions | null>(null);
  const load = (off: boolean) => void run('explain', () => call('ai.explain', { offline: off }).then(setR));
  return (
    <Card
      title={`What ${name} reads`}
      subtitle={`Everything ${name} is told before each answer, exactly as it is sent: FBRX’s core principles first and whole, then this personality, then how it works and its tools.`}
      actions={
        <Button loading={busy === 'explain'} onClick={() => load(offline)}>
          {r ? 'Refresh' : 'Show it'}
        </Button>
      }
    >
      {r && (
        <>
          <div className="fx-actions" style={{ marginBottom: 8, flexWrap: 'wrap' }}>
            <Status tone={r.coreFirstAndWhole ? 'good' : 'critical'}>{r.coreFirstAndWhole ? 'Core principles first and whole' : 'Core principles not first: report this'}</Status>
            <span className="fx-muted">
              {r.system.length.toLocaleString()} characters · {r.tools.length} tools · <span className="mono">sha256 {r.sha256.slice(0, 12)}…</span>
            </span>
            <div className="seg" role="group" aria-label="Online or offline chat">
              {[false, true].map((o) => (
                <button type="button" key={String(o)} className={offline === o ? 'on' : ''} onClick={() => { setOffline(o); load(o); }}>
                  {o ? 'Offline chat' : 'Online chat'}
                </button>
              ))}
            </div>
          </div>
          <TextArea code rows={16} value={r.system} readOnly aria-label={`What ${name} reads`} />
        </>
      )}
    </Card>
  );
}
