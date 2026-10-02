import { useEffect, useMemo, useState } from 'react';
import type { Settings } from '@fbrx/shared';
import { MACRO_PLACEHOLDERS, expandMacro, textOp } from '@fbrx/shared';
import { Button, Callout, Card, Empty, Field, Icons, Input, Select, TextArea, Toggle, useAction, useConfirm } from '@fbrx/ui';
import { call } from '../client';
import { isLocked, useCore } from '../hooks';
import { navigate } from '../app';
import { RESERVED_TRIGGERS } from '../slash-menu';

type Macro = Settings['macros'][number];
const TRIGGER = /^[a-z0-9][a-z0-9_-]{0,23}$/;
const SCOPES: Array<{ value: Macro['scope']; label: string }> = [
  { value: 'everywhere', label: 'Everywhere' },
  { value: 'chat', label: 'Chat only' },
  { value: 'terminal', label: 'Terminal and FBRX/1 only' },
];

const BUILTINS: Array<[string, string]> = [
  ['/snip', 'Lists your saved snippets; keep typing to search (“/snip dns”)'],
  ['/clip', 'Pastes what is on the clipboard'],
  ['/date, /time, /now', 'Today’s date, the time, or both'],
  ['/macros', 'Opens this page'],
];

function problem(m: Macro, all: Macro[]): string | null {
  if (!TRIGGER.test(m.trigger)) return 'Use lowercase letters, numbers, - or _ (up to 24), starting with a letter or number.';
  if (RESERVED_TRIGGERS.includes(m.trigger)) return `/${m.trigger} is built in. Pick another name.`;
  if (all.filter((x) => x.trigger === m.trigger).length > 1) return `/${m.trigger} is used twice.`;
  if (!m.text.trim()) return 'Add the text it types.';
  return null;
}

export function MacroSettings() {
  const s = useCore('settings.get', undefined, ['settings.changed']);
  const settings = s.data?.settings;
  const locked = isLocked(s.data?.locked, 'macros');
  const { run } = useAction();
  const { confirm, dialog } = useConfirm();
  const [draft, setDraft] = useState<Macro[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const macros = draft ?? settings?.macros ?? [];
  const dirty = draft !== null && JSON.stringify(draft) !== JSON.stringify(settings?.macros);
  const errors = useMemo(() => new Map(macros.map((m) => [m.id, problem(m, macros)])), [macros]);
  const valid = [...errors.values()].every((e) => !e);

  useEffect(() => {
    if (draft && settings && JSON.stringify(draft) === JSON.stringify(settings.macros)) setDraft(null);
  }, [settings, draft]);

  if (!settings) return null;
  const edit = (id: string, p: Partial<Macro>) => setDraft(macros.map((m) => (m.id === id ? { ...m, ...p } : m)));
  const add = () => {
    const id = `m-${Date.now().toString(36)}`;
    let n = 1;
    while (macros.some((m) => m.trigger === `macro${n}`)) n++;
    setDraft([...macros, { id, trigger: `macro${n}`, description: '', text: '', scope: 'everywhere' }]);
    setOpen(id);
  };
  const save = () => run('save', () => call('settings.update', { patch: { macros } }), 'Macros saved');
  const preview = (m: Macro) => expandMacro(m.text, { name: settings.profile.name, callMe: settings.profile.callMe, host: 'THIS-PC', clipboard: '(clipboard)' });

  const clipMacros = settings.clipboard.macros;
  const removeClip = async (id: string, name: string) => {
    if (await confirm({ title: `Delete “${name}”?`, body: 'The saved clipboard macro is removed. Your clipboard is not touched.', danger: true, confirmLabel: 'Delete' }))
      await run('del', () => call('settings.update', { patch: { clipboard: { macros: clipMacros.filter((m) => m.id !== id) } } }), 'Deleted');
  };

  return (
    <>
      <Card
        title="Slash macros"
        subtitle="Type / in the chat, the Terminal, FBRX/1 or the Clipboard editor and pick a macro: it types the text for you."
        actions={
          <>
            {dirty && (
              <Button size="sm" variant="ghost" onClick={() => setDraft(null)}>
                Undo changes
              </Button>
            )}
            <Button size="sm" icon="plus" onClick={add} disabled={locked}>
              New macro
            </Button>
            <Button size="sm" variant="primary" disabled={!dirty || !valid || locked} onClick={() => void save()}>
              Save
            </Button>
          </>
        }
      >
        {locked && <Callout tone="info">Your organization manages the macros on this computer.</Callout>}
        {!macros.length ? (
          <Empty title="No macros yet" action={<Button size="sm" icon="plus" onClick={add}>New macro</Button>}>
            A macro is a shortcut for text you type often: a sign-off, a ticket template, a command.
          </Empty>
        ) : (
          <div className="macro-list">
            {macros.map((m) => {
              const err = errors.get(m.id);
              const expanded = open === m.id;
              return (
                <div key={m.id} className={`macro-row${expanded ? ' open' : ''}${err ? ' invalid' : ''}`}>
                  <button className="macro-head" onClick={() => setOpen(expanded ? null : m.id)} aria-expanded={expanded}>
                    <span className="macro-trigger mono">/{m.trigger}</span>
                    <span className="macro-desc">{m.description || m.text.split('\n')[0].slice(0, 80) || 'New macro'}</span>
                    <span className="macro-scope">{SCOPES.find((x) => x.value === m.scope)?.label}</span>
                    {err ? <Icons.alert size={14} className="macro-warn" /> : null}
                    <Icons.chevronDown size={14} className="macro-chev" />
                  </button>
                  {expanded && (
                    <div className="macro-edit">
                      <div className="macro-fields">
                        <Field label="Type" error={err && /letters|built in|twice/.test(err) ? err : undefined}>
                          <div className="macro-trigger-input">
                            <span className="mono">/</span>
                            <Input className="mono" value={m.trigger} disabled={locked} maxLength={24} onChange={(e) => edit(m.id, { trigger: e.target.value.toLowerCase().replace(/\s+/g, '-') })} aria-label="Trigger" />
                          </div>
                        </Field>
                        <Field label="What it does">
                          <Input value={m.description} disabled={locked} maxLength={120} placeholder="Shown in the / menu" onChange={(e) => edit(m.id, { description: e.target.value })} />
                        </Field>
                        <Field label="Where">
                          <Select value={m.scope} disabled={locked} onChange={(e) => edit(m.id, { scope: e.target.value as Macro['scope'] })} options={SCOPES} />
                        </Field>
                      </div>
                      <Field label="Text it types" error={err && /Add the text/.test(err) ? err : undefined} help="Placeholders like {date} or {name} are filled in when you use it; {cursor} is where the cursor lands.">
                        <TextArea code rows={Math.min(10, Math.max(3, m.text.split('\n').length + 1))} value={m.text} disabled={locked} maxLength={5000} onChange={(e) => edit(m.id, { text: e.target.value })} />
                      </Field>
                      {m.text && (
                        <div className="macro-preview">
                          <div className="fx-muted">Preview</div>
                          <pre className="mono">{preview(m).text}</pre>
                        </div>
                      )}
                      <div className="fx-actions">
                        <Button size="sm" variant="ghost" icon="trash" disabled={locked} onClick={() => setDraft(macros.filter((x) => x.id !== m.id))}>
                          Delete
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
        {dirty && <div className="fx-help" style={{ marginTop: 10 }}>{valid ? 'Unsaved changes.' : 'Fix the marked macros to save.'}</div>}
      </Card>

      <div className="macro-help">
        <Card title="Placeholders">
          <div className="kv-mini">
            {MACRO_PLACEHOLDERS.map(([k, v]) => (
              <div key={k}>
                <code>{k}</code>
                <span>{v}</span>
              </div>
            ))}
          </div>
        </Card>
        <Card title="Built in">
          <div className="kv-mini">
            {BUILTINS.map(([k, v]) => (
              <div key={k}>
                <code>{k}</code>
                <span>{v}</span>
              </div>
            ))}
          </div>
        </Card>
      </div>

      <Card
        title="Clipboard macros"
        subtitle="Saved clean-up steps for copied text. Build them on the Clipboard page; run one there in a single click."
        actions={
          <Button size="sm" icon="copy" onClick={() => navigate('clipboard')}>
            Open Clipboard
          </Button>
        }
      >
        {!clipMacros.length ? (
          <Empty title="No clipboard macros">On the Clipboard page, add steps (trim, remove duplicates, Find and replace…) and choose Save as macro.</Empty>
        ) : (
          <div className="macro-list">
            {clipMacros.map((m) => (
              <div key={m.id} className="macro-row">
                <div className="macro-head static">
                  <span className="macro-trigger">{m.name}</span>
                  <span className="macro-desc">{m.steps.map((x) => textOp(x.op)?.label ?? x.op).join(' → ')}</span>
                  <Button size="sm" variant="ghost" onClick={() => navigate(`clipboard/${m.id}`)}>
                    Open
                  </Button>
                  <Button size="sm" variant="ghost" icon="trash" aria-label={`Delete ${m.name}`} onClick={() => void removeClip(m.id, m.name)} />
                </div>
              </div>
            ))}
          </div>
        )}
        <div style={{ marginTop: 12 }}>
          <Toggle
            checked={settings.clipboard.history}
            disabled={isLocked(s.data?.locked, 'clipboard.history')}
            onChange={(v) => void run('hist', () => call('settings.update', { patch: { clipboard: { history: v } } }))}
            label="Keep a clipboard history while FBRX is running (memory only, never saved to disk; password managers' copies are skipped)"
          />
        </div>
      </Card>
      {dialog}
    </>
  );
}
