import { useState, useSyncExternalStore } from 'react';
import type { Settings } from '@fbrx/shared';
import { Button, Callout, Field, Input, Modal, TextArea, Toggle, useAction, useToast } from '@fbrx/ui';
import { call } from './client';
import { useCore } from './hooks';
import { navigate } from './app';
import { KeyRecorder, keyLabel } from './pages/settings-macros';
import { RESERVED_TRIGGERS } from './slash-menu';

/**
 * "Add to macros" from anywhere in FBRX: a command in the Library, FBRX/1 or the Terminal, or text picked with the
 * right-click menu. A macro is a keyboard shortcut that types the text into whatever app you are in; it can also come
 * out of the / menu in the chat, the Terminal and FBRX/1 as a quick snippet.
 */

type KeyMacro = Settings['keyMacros'][number];
export interface MacroDraft {
  name: string;
  text: string;
  /** Editing a macro that exists (Settings → Macros). */
  id?: string;
  /** Offer it in the / menu too, under this name. */
  slash?: boolean;
}

let open: MacroDraft | null = null;
const subs = new Set<() => void>();
const set = (d: MacroDraft | null) => {
  open = d;
  subs.forEach((f) => f());
};

/** Opens the "Add to macros" dialog with this filled in. */
export function addToMacros(d: MacroDraft): void {
  set({ ...d, name: d.name.slice(0, 80), text: d.text.slice(0, 5000) });
}

/** Where the dialog lives: once, at the top of the app. */
export function MacroAddHost() {
  const d = useSyncExternalStore(
    (f) => (subs.add(f), () => subs.delete(f)),
    () => open,
  );
  return d ? <MacroDialog key={`${d.id ?? ''}:${d.text}`} draft={d} onClose={() => set(null)} /> : null;
}

/** A free /name for the quick snippet: from the macro's name, never a built-in or one already used. */
function freeTrigger(name: string, used: string[]): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 20) || 'macro';
  let t = base;
  for (let n = 2; RESERVED_TRIGGERS.includes(t) || used.includes(t); n++) t = `${base}-${n}`;
  return t;
}

function MacroDialog({ draft, onClose }: { draft: MacroDraft; onClose: () => void }) {
  const s = useCore('settings.get', undefined, ['settings.changed']);
  const settings = s.data?.settings;
  const editing = settings?.keyMacros.find((m) => m.id === draft.id);
  const [name, setName] = useState(editing?.name ?? draft.name);
  const [text, setText] = useState(editing?.text ?? draft.text);
  const [hotkey, setHotkey] = useState(editing?.hotkey ?? '');
  const [slash, setSlash] = useState(!editing && !!draft.slash);
  const [trigger, setTrigger] = useState('');
  const { run, busy } = useAction();
  const toast = useToast();
  if (!settings) return null;
  const others = settings.keyMacros.filter((m) => m.id !== draft.id);
  const triggers = settings.macros.map((m) => m.trigger);
  const slashName = trigger || freeTrigger(name, triggers);
  const builtIn: Array<[string, string]> = [
    [settings.spotlight.enabled ? settings.spotlight.hotkey : '', 'Spotlight'],
    [settings.clipboard.hotkey, 'Clipboard history'],
    [settings.presenter.hotkey, 'Presenter-safe mode'],
  ];
  const clash = hotkey ? (builtIn.find(([k]) => k === hotkey)?.[1] ?? others.find((m) => m.hotkey === hotkey)?.name) : undefined;
  const slashProblem = slash && (!/^[a-z0-9][a-z0-9_-]{0,23}$/.test(slashName) ? 'Use lowercase letters, numbers, - or _.' : RESERVED_TRIGGERS.includes(slashName) || triggers.includes(slashName) ? `/${slashName} is taken.` : null);
  const problem = !name.trim() ? 'Give it a name.' : !text.trim() ? 'Add what it types.' : clash ? `${keyLabel(hotkey)} is already ${clash}'s shortcut.` : !hotkey && !slash && !editing ? 'Pick a shortcut, or offer it in the / menu.' : slashProblem || null;

  const save = () =>
    void run('save', async () => {
      const macro: KeyMacro = { id: editing?.id ?? `k-${Date.now().toString(36)}`, name: name.trim(), hotkey, text };
      const keyMacros = editing ? settings.keyMacros.map((m) => (m.id === macro.id ? macro : m)) : [...settings.keyMacros, macro];
      const macros = slash ? [...settings.macros, { id: `m-${Date.now().toString(36)}`, trigger: slashName, description: name.trim().slice(0, 120), text, scope: 'everywhere' as const }] : undefined;
      await call('settings.update', { patch: macros ? { keyMacros, macros } : { keyMacros } });
      onClose();
      const how = [hotkey && keyLabel(hotkey), slash && `/${slashName}`].filter(Boolean).join(' or ');
      toast.success(editing ? 'Macro saved' : 'Added to macros', how ? `${how} types it.` : 'Give it a shortcut in Settings → Macros.', editing ? undefined : { label: 'Open Macros', onClick: () => navigate('settings/macros') });
    });

  return (
    <Modal
      title={editing ? 'Edit macro' : 'Add to macros'}
      description="Press the shortcut in any app and FBRX types this where you are."
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" icon="zap" disabled={!!problem} loading={busy === 'save'} onClick={save}>
            {editing ? 'Save' : 'Add macro'}
          </Button>
        </>
      }
    >
      <div className="fx-form">
        <Field label="Name">
          <Input value={name} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder="Flush DNS" />
        </Field>
        <Field label="It types" help="Placeholders work here: {date}, {time}, {name}, {host}, {clipboard}.">
          <TextArea className="mono" rows={Math.min(8, Math.max(2, text.split('\n').length))} value={text} maxLength={5000} onChange={(e) => setText(e.target.value)} spellCheck={false} />
        </Field>
        <Field label="Shortcut" help="Click, then press the keys, for example Ctrl+Alt+1. It works in every app while FBRX runs.">
          <KeyRecorder value={hotkey} allowOff onChange={setHotkey} />
        </Field>
        {!editing && (
          <div className="macro-slash">
            <Toggle checked={slash} onChange={setSlash} label={<>Also type it with <code>/{slashName}</code> in the chat, the Terminal and FBRX/1</>} />
            {slash && <Input className="mono" value={trigger} placeholder={slashName} maxLength={24} aria-label="Name after the slash" onChange={(e) => setTrigger(e.target.value.toLowerCase())} style={{ width: 200 }} />}
          </div>
        )}
        {problem && (name || text) && <Callout tone={clash || slashProblem ? 'warning' : 'info'}>{problem}</Callout>}
      </div>
    </Modal>
  );
}
