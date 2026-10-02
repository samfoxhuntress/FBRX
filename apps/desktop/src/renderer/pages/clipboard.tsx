import { useEffect, useMemo, useRef, useState } from 'react';
import type { Settings, TextStep } from '@fbrx/shared';
import { TEXT_OPS, applySteps, textOp } from '@fbrx/shared';
import { Button, Callout, Card, Empty, Icons, Input, Page, TextArea, Toggle, timeAgo, useAction, useToast } from '@fbrx/ui';
import { bridge, call, clipHistory, readClipboard, writeClipboard, type ClipEntry } from '../client';
import { isLocked, useCore } from '../hooks';
import { navigate, routeArg } from '../app';
import { AskButton } from '../widgets';
import { useSlashMenu } from '../slash-menu';

type ClipMacro = Settings['clipboard']['macros'][number];
const GROUPS = [...new Set(TEXT_OPS.map((o) => o.group))];
const INPUT_KEY = 'fbrx.clipboard.input';

function stats(t: string) {
  if (!t) return 'Empty';
  const lines = t.split('\n').length;
  const words = t.trim() ? t.trim().split(/\s+/).length : 0;
  return `${t.length.toLocaleString()} characters · ${words.toLocaleString()} words · ${lines.toLocaleString()} line${lines === 1 ? '' : 's'}`;
}

function useClipHistory() {
  const [state, setState] = useState<{ enabled: boolean; entries: ClipEntry[] } | null>(null);
  useEffect(() => {
    void clipHistory().then(setState);
    const off = bridge.onClips?.((entries) => setState((s) => ({ enabled: s?.enabled ?? true, entries: entries as ClipEntry[] })));
    return () => off?.();
  }, []);
  return { state, refresh: () => void clipHistory().then(setState), act: (a: 'remove' | 'pin' | 'clear', id?: number, on?: boolean) => void clipHistory(a, id, on).then(setState) };
}

function StepEditor({ step, index, count, error, onChange, onMove, onRemove }: { step: TextStep; index: number; count: number; error?: string; onChange: (s: TextStep) => void; onMove: (d: -1 | 1) => void; onRemove: () => void }) {
  const op = textOp(step.op);
  return (
    <div className={`clip-step${error ? ' invalid' : ''}`}>
      <div className="clip-step-head">
        <span className="clip-step-n">{index + 1}</span>
        <span className="clip-step-title">{op?.label ?? step.op}</span>
        <Button size="sm" variant="ghost" icon="chevronDown" className="flip" aria-label="Move up" disabled={index === 0} onClick={() => onMove(-1)} />
        <Button size="sm" variant="ghost" icon="chevronDown" aria-label="Move down" disabled={index === count - 1} onClick={() => onMove(1)} />
        <Button size="sm" variant="ghost" icon="x" aria-label="Remove step" onClick={onRemove} />
      </div>
      {(op?.a || op?.b || op?.flag) && (
        <div className="clip-step-args">
          {op.a && <Input className="mono" value={step.a ?? ''} placeholder={op.a.placeholder} aria-label={op.a.label} title={op.a.label} onChange={(e) => onChange({ ...step, a: e.target.value })} />}
          {op.b && <Input className="mono" value={step.b ?? ''} placeholder={op.b.placeholder} aria-label={op.b.label} title={op.b.label} onChange={(e) => onChange({ ...step, b: e.target.value })} />}
          {op.flag && <Toggle checked={!!step.flag} onChange={(v) => onChange({ ...step, flag: v })} label={op.flag} />}
        </div>
      )}
      {error && <div className="fx-error-text">{error}</div>}
    </div>
  );
}

export function ClipboardPage() {
  const s = useCore('settings.get', undefined, ['settings.changed']);
  const settings = s.data?.settings;
  const macros = settings?.clipboard.macros ?? [];
  const [input, setInputRaw] = useState(() => {
    try {
      return sessionStorage.getItem(INPUT_KEY) ?? '';
    } catch {
      return '';
    }
  });
  const setInput = (v: string) => {
    setInputRaw(v);
    try {
      sessionStorage.setItem(INPUT_KEY, v.slice(0, 200_000));
    } catch {
      /* private window */
    }
  };
  const [steps, setSteps] = useState<TextStep[]>([]);
  const [loaded, setLoaded] = useState<ClipMacro | null>(null);
  const [saveName, setSaveName] = useState<string | null>(null);
  const [histQ, setHistQ] = useState('');
  const box = useRef<HTMLTextAreaElement>(null);
  const slash = useSlashMenu({ value: input, setValue: setInput, inputRef: box, scope: 'text' });
  const history = useClipHistory();
  const { run } = useAction();
  const toast = useToast();

  // clipboard/<macro id> opens that macro (from Settings → Macros).
  useEffect(() => {
    const id = routeArg();
    const m = id ? macros.find((x) => x.id === id) : undefined;
    if (m && loaded?.id !== m.id) {
      setLoaded(m);
      setSteps(m.steps);
    }
  }, [macros]); // eslint-disable-line react-hooks/exhaustive-deps

  const result = useMemo(() => applySteps(input, steps), [input, steps]);
  const changed = JSON.stringify(steps) !== JSON.stringify(loaded?.steps ?? null);

  const addStep = (op: string) => op && setSteps((xs) => [...xs, { op }]);
  const move = (i: number, d: -1 | 1) =>
    setSteps((xs) => {
      const next = [...xs];
      [next[i], next[i + d]] = [next[i + d], next[i]];
      return next;
    });
  const load = (m: ClipMacro) => {
    setLoaded(m);
    setSteps(m.steps);
  };
  const saveMacros = (next: ClipMacro[], msg: string) => run('save', () => call('settings.update', { patch: { clipboard: { macros: next } } }), msg);
  const saveAs = async () => {
    const name = (saveName ?? '').trim();
    if (!name) return;
    const m: ClipMacro = { id: `c-${Date.now().toString(36)}`, name: name.slice(0, 60), steps };
    if (await saveMacros([...macros, m], `Saved “${m.name}”`)) {
      setLoaded(m);
      setSaveName(null);
    }
  };
  const update = () => loaded && void saveMacros(macros.map((m) => (m.id === loaded.id ? { ...m, steps } : m)), `Updated “${loaded.name}”`).then((ok) => ok && setLoaded({ ...loaded, steps }));
  const runOnClipboard = async (m: ClipMacro) => {
    const text = await readClipboard();
    if (!text) return toast.info('The clipboard is empty', 'Copy some text first.');
    const r = applySteps(text, m.steps);
    if (r.errors.length) return toast.error(`“${m.name}” could not finish`, r.errors[0].message);
    await writeClipboard(r.text);
    toast.success(`Clipboard cleaned with “${m.name}”`, stats(r.text));
  };
  const copyResult = async () => {
    await writeClipboard(result.text);
    toast.success('Copied', stats(result.text));
  };

  const hist = history.state;
  const entries = (hist?.entries ?? []).filter((e) => !histQ || e.text.toLowerCase().includes(histQ.toLowerCase()));
  const histLocked = isLocked(s.data?.locked, 'clipboard.history');

  return (
    <Page title="Clipboard" description="Clean up, convert and reuse copied text. Build the steps once, save them as a macro, then run it on whatever you copied in one click.">
      <Card title="Clipboard macros" subtitle="Click a macro to load its steps. ▶ runs it straight on the clipboard: copy, click, paste." flush={false}>
        <div className="clip-macros">
          {macros.map((m) => (
            <div key={m.id} className={`clip-macro${loaded?.id === m.id ? ' active' : ''}`}>
              <button className="clip-macro-name" onClick={() => load(m)} title={m.steps.map((x) => textOp(x.op)?.label ?? x.op).join(' → ')}>
                {m.name}
              </button>
              <button className="clip-macro-run" aria-label={`Run ${m.name} on the clipboard`} title="Run on the clipboard" onClick={() => void runOnClipboard(m)}>
                <Icons.play size={13} />
              </button>
            </div>
          ))}
          {!macros.length && <span className="fx-muted">No macros yet. Add steps below and save them.</span>}
          <Button size="sm" variant="ghost" icon="settings" onClick={() => navigate('settings/macros')}>
            Manage
          </Button>
        </div>
      </Card>

      <div className="clip-grid">
        <Card
          title="Text"
          actions={
            <>
              <Button size="sm" icon="download" onClick={() => void readClipboard().then((t) => (t ? setInput(t) : toast.info('The clipboard is empty')))}>
                Paste
              </Button>
              <Button size="sm" variant="ghost" disabled={!input} onClick={() => setInput('')}>
                Clear
              </Button>
            </>
          }
        >
          <div className="clip-editor">
            {slash.menu}
            <TextArea
              ref={box}
              code
              rows={14}
              value={input}
              placeholder="Paste or type text here. Type / for your macros and snippets."
              aria-label="Text to process"
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => void slash.onKeyDown(e)}
            />
          </div>
          <div className="clip-stats">{stats(input)}</div>
        </Card>

        <Card
          title={loaded ? `Steps · ${loaded.name}` : 'Steps'}
          actions={
            steps.length ? (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setSteps([]);
                  setLoaded(null);
                }}
              >
                Clear
              </Button>
            ) : undefined
          }
        >
          <div className="clip-steps">
            {steps.map((st, i) => (
              <StepEditor
                key={i}
                step={st}
                index={i}
                count={steps.length}
                error={result.errors.find((e) => e.index === i)?.message}
                onChange={(n) => setSteps((xs) => xs.map((x, j) => (j === i ? n : x)))}
                onMove={(d) => move(i, d)}
                onRemove={() => setSteps((xs) => xs.filter((_x, j) => j !== i))}
              />
            ))}
            {!steps.length && <div className="fx-muted clip-hint">Add steps and watch the result update as you go. They run top to bottom.</div>}
            <select className="fx-select" value="" aria-label="Add a step" onChange={(e) => addStep(e.target.value)}>
              <option value="">+ Add a step…</option>
              {GROUPS.map((g) => (
                <optgroup key={g} label={g}>
                  {TEXT_OPS.filter((o) => o.group === g).map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.label}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </div>
          {steps.length > 0 && (
            <div className="clip-save">
              {saveName === null ? (
                <>
                  {loaded && changed && (
                    <Button size="sm" variant="primary" onClick={update}>
                      Update “{loaded.name}”
                    </Button>
                  )}
                  <Button size="sm" icon="bookmark" onClick={() => setSaveName('')}>
                    Save as macro
                  </Button>
                </>
              ) : (
                <>
                  <Input autoFocus value={saveName} placeholder="Name, like “Clean up a ticket”" maxLength={60} onChange={(e) => setSaveName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void saveAs()} aria-label="Macro name" />
                  <Button size="sm" variant="primary" disabled={!saveName.trim()} onClick={() => void saveAs()}>
                    Save
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setSaveName(null)}>
                    Cancel
                  </Button>
                </>
              )}
            </div>
          )}
        </Card>

        <Card
          title="Result"
          actions={
            <>
              <AskButton iconOnly label="Ask about this text" prompt="Here is some text from my clipboard. Tell me what it is and anything I should notice or do with it." context={result.text.slice(0, 20_000)} />
              <Button size="sm" variant="ghost" disabled={!steps.length || result.text === input} onClick={() => setInput(result.text)} title="Make the result the new text">
                Use as text
              </Button>
              <Button size="sm" variant="primary" icon="copy" disabled={!result.text} onClick={() => void copyResult()}>
                Copy
              </Button>
            </>
          }
        >
          <TextArea code readOnly rows={14} value={result.text} aria-label="Result" placeholder="The result shows here." />
          <div className="clip-stats">{stats(result.text)}</div>
        </Card>
      </div>

      <Card
        title="History"
        subtitle="What you copied while FBRX was running. Kept in memory only: never saved to disk, gone when FBRX quits."
        actions={
          hist?.enabled ? (
            <>
              <div style={{ width: 200 }}>
                <Input value={histQ} onChange={(e) => setHistQ(e.target.value)} placeholder="Search history" aria-label="Search clipboard history" />
              </div>
              <Button size="sm" variant="ghost" disabled={!hist.entries.length} onClick={() => history.act('clear')}>
                Clear (keeps pinned)
              </Button>
              <Toggle checked label="On" disabled={histLocked} onChange={() => void run('hist', () => call('settings.update', { patch: { clipboard: { history: false } } }), 'Clipboard history off').then(() => setTimeout(history.refresh, 300))} />
            </>
          ) : undefined
        }
      >
        {!bridge.clip ? (
          <Callout tone="info">Clipboard history is available in the FBRX OS desktop app.</Callout>
        ) : !hist?.enabled ? (
          <Empty
            title="Clipboard history is off"
            action={
              <Button size="sm" variant="primary" disabled={histLocked} onClick={() => void run('hist', () => call('settings.update', { patch: { clipboard: { history: true } } }), 'Clipboard history on').then(() => setTimeout(history.refresh, 300))}>
                Turn on
              </Button>
            }
          >
            Turn it on to keep the last 50 things you copy, so you can paste any of them again. Copies that password managers mark as secret are skipped.
          </Empty>
        ) : !entries.length ? (
          <Empty title={histQ ? 'Nothing matches' : 'Nothing copied yet'}>{histQ ? 'Try another word.' : 'Copy some text anywhere and it shows up here.'}</Empty>
        ) : (
          <div className="clip-history">
            {entries.map((e) => (
              <div key={e.id} className={`clip-hist${e.pinned ? ' pinned' : ''}`}>
                <pre className="clip-hist-text">{e.text.length > 600 ? `${e.text.slice(0, 600)}…` : e.text}</pre>
                <div className="clip-hist-bar">
                  <span className="fx-muted">
                    {timeAgo(e.at)} · {e.text.length.toLocaleString()} chars
                  </span>
                  <Button size="sm" variant="ghost" onClick={() => setInput(e.text)}>
                    Edit
                  </Button>
                  <Button size="sm" variant="ghost" icon="copy" aria-label="Copy again" onClick={() => void writeClipboard(e.text).then(() => toast.success('Copied'))} />
                  <Button size="sm" variant="ghost" icon="bookmark" aria-label={e.pinned ? 'Unpin' : 'Pin'} title={e.pinned ? 'Unpin' : 'Pin (kept when you clear)'} className={e.pinned ? 'on' : undefined} onClick={() => history.act('pin', e.id, !e.pinned)} />
                  <Button size="sm" variant="ghost" icon="x" aria-label="Remove" onClick={() => history.act('remove', e.id)} />
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </Page>
  );
}
