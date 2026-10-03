import { useEffect, useMemo, useRef, useState } from 'react';
import type { Snippet } from '@fbrx/shared';
import { Button, Card, Icons, Input, useToast } from '@fbrx/ui';
import { call } from './client';
import { useCore } from './hooks';
import { AskButton } from './widgets';
import { useSlashMenu } from './slash-menu';

/**
 * FBRX/1: the FBRX management console, in the spirit of a network operating system's CLI. "show" reads, "request"
 * acts, "configure" edits settings as a candidate you "commit" (or "rollback"). Tab completes, "?" lists what
 * comes next, and "| match", "| count", "| display set" filter output. It runs only for the person at this
 * computer; everything it changes goes through the same checks and audit log as the rest of FBRX.
 */

export interface Fbrx1Recipe {
  title: string;
  what: string;
  /** One command per line; run in order. */
  lines: string[];
}

export const FBRX1_LIBRARY: Array<{ id: string; name: string; items: Fbrx1Recipe[] }> = [
  {
    id: 'health',
    name: 'Health',
    items: [
      { title: 'System status', what: 'Services, vault, fleet, agent and emergency stop', lines: ['show system status'] },
      { title: 'Resources', what: 'Processor, memory and disks right now', lines: ['show system resources'] },
      { title: 'Services', what: 'Every FBRX service and its state', lines: ['show services'] },
      { title: 'Failing services only', what: 'Filter with a pipe', lines: ['show services | except running'] },
      { title: 'Full health check', what: 'Status, resources, alerts and approvals in one go', lines: ['show system status', 'show system resources', 'show alerts', 'show approvals'] },
      { title: 'Version and license', what: 'What is installed and who it is licensed to', lines: ['show version', 'show license'] },
    ],
  },
  {
    id: 'ai',
    name: 'AI',
    items: [
      { title: 'AI providers', what: 'Which AI providers are set up and ready', lines: ['show ai providers'] },
      { title: 'Emergency stop', what: 'Halt every AI action now (resume with the next one)', lines: ['request ai stop'] },
      { title: 'Resume the AI', what: 'Lift the emergency stop', lines: ['request ai resume'] },
      { title: 'Agent settings', what: 'Name, provider, model and limits', lines: ['show configuration ai'] },
    ],
  },
  {
    id: 'network',
    name: 'Network',
    items: [
      { title: 'Interfaces', what: 'Adapters, addresses and MACs', lines: ['show network interfaces'] },
      { title: 'Devices on the network', what: 'From the last scan', lines: ['show network devices'] },
      { title: 'How many devices', what: 'Count the lines', lines: ['show network devices | count'] },
      { title: 'Scan the network', what: 'About a minute', lines: ['request network scan'] },
      { title: 'Ping Cloudflare', what: 'Is the internet there?', lines: ['ping 1.1.1.1 count 4'] },
      { title: 'MAC vendor registry', what: 'Which IEEE list is in use', lines: ['show network vendors'] },
    ],
  },
  {
    id: 'audit',
    name: 'Audit & logs',
    items: [
      { title: 'Recent audit', what: 'The last 20 audited actions', lines: ['show audit 20'] },
      { title: 'Errors in the log', what: 'Only lines that mention an error', lines: ['show log 200 | match error'] },
      { title: 'Warnings in the log', what: 'Only warnings', lines: ['show log 200 | match warn'] },
      { title: 'Audit as JSON', what: 'For scripts and tickets', lines: ['show audit 5 | display json'] },
    ],
  },
  {
    id: 'config',
    name: 'Configuration',
    items: [
      { title: 'All settings as set commands', what: 'Copy them to another computer', lines: ['show configuration | display set'] },
      { title: 'Neon Grid look', what: 'Switch theme and texture, then commit', lines: ['configure', 'set appearance preset neon', 'set appearance texture theme', 'commit', 'exit'] },
      { title: 'Back to Fabrics', what: 'The default look with its weave', lines: ['configure', 'set appearance preset fabrics', 'set appearance texture theme', 'commit', 'exit'] },
      { title: 'Offline-first agent', what: 'New chats ask before using the internet', lines: ['configure', 'set ai newChatsOffline true', 'commit', 'exit'] },
      { title: 'Try before you commit', what: 'Make a change, compare, then throw it away', lines: ['configure', 'set appearance density compact', 'show | compare', 'rollback', 'exit'] },
      { title: 'No goose visits', what: 'The goose only comes when called', lines: ['configure', 'set appearance gooseVisits false', 'commit', 'exit'] },
    ],
  },
  {
    id: 'care',
    name: 'Care',
    items: [
      { title: 'Back up now', what: 'Uses the saved backup passphrase', lines: ['request backup now'] },
      { title: 'Mark alerts read', what: 'Clear the unread count', lines: ['request alerts mark-read'] },
      { title: 'Open tasks', what: 'What is still to do', lines: ['show tasks'] },
      { title: 'Trophy case', what: 'Easter eggs found so far', lines: ['show trophies'] },
    ],
  },
];

interface Entry {
  id: number;
  prompt: string;
  line: string;
  output: string;
}

const HISTORY_KEY = 'fbrx.fbrx1.history';

type ConsoleApi = { run: (lines: string[]) => void; insert: (text: string) => void };

/** The console with its library beside it. */
export function Fbrx1Panel() {
  const api = useRef<ConsoleApi | null>(null);
  return (
    <div className="term-layout">
      <Fbrx1Console apiRef={api} />
      <Fbrx1Library onRun={(l) => api.current?.run(l)} onInsert={(t) => api.current?.insert(t)} />
    </div>
  );
}

function Fbrx1Console({ apiRef }: { apiRef: { current: ConsoleApi | null } }) {
  const session = useMemo(() => `ui-${Math.random().toString(36).slice(2, 10)}`, []);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [prompt, setPrompt] = useState('');
  const [line, setLine] = useState('');
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem(HISTORY_KEY) ?? '[]') as string[];
    } catch {
      return [];
    }
  });
  const [hIdx, setHIdx] = useState(-1);
  const ids = useRef(1);
  const out = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLInputElement>(null);
  const slash = useSlashMenu({ value: line, setValue: setLine, inputRef: box, scope: 'terminal' });
  const toast = useToast();

  useEffect(() => {
    void call('cli.exec', { session, line: '' }).then((r) => setPrompt(r.prompt));
  }, [session]);
  useEffect(() => {
    out.current?.scrollTo({ top: out.current.scrollHeight });
  }, [entries]);

  const push = (e: Omit<Entry, 'id'>) => setEntries((xs) => [...xs.slice(-300), { ...e, id: ids.current++ }]);

  const run = async (lines: string[]) => {
    setBusy(true);
    let p = prompt;
    try {
      for (const l of lines) {
        const r = await call('cli.exec', { session, line: l });
        if (r.clear) setEntries([]);
        else push({ prompt: p, line: l, output: r.output });
        p = r.prompt;
        setPrompt(r.prompt);
      }
    } catch (e) {
      push({ prompt: p, line: lines.join('; '), output: `error: ${(e as Error).message}` });
    } finally {
      setBusy(false);
      box.current?.focus();
    }
  };

  const submit = () => {
    const l = line;
    setLine('');
    setHIdx(-1);
    if (l.trim()) {
      const h = [l, ...history.filter((x) => x !== l)].slice(0, 100);
      setHistory(h);
      try {
        localStorage.setItem(HISTORY_KEY, JSON.stringify(h));
      } catch {
        /* history is a convenience */
      }
    }
    void run([l]);
  };

  const complete = async () => {
    const r = await call('cli.complete', { session, line });
    const c = r.completions;
    if (!c.length) return;
    const lastWord = /\s$/.test(line) ? '' : (line.split(/\s+/).pop() ?? '');
    const base = line.slice(0, line.length - lastWord.length);
    if (c.length === 1) {
      setLine(`${base}${c[0]} `);
      return;
    }
    // Several: extend to what they share, and list them.
    let common = c[0];
    for (const x of c) while (!x.startsWith(common)) common = common.slice(0, -1);
    if (common.length > lastWord.length) setLine(`${base}${common}`);
    else push({ prompt, line, output: `Possible completions:\n${c.map((x) => `  ${x}`).join('\n')}` });
  };

  apiRef.current = {
    run: (l) => void run(l),
    insert: (t) => {
      setLine(t);
      box.current?.focus();
    },
  };

  const [editLine, promptLine] = prompt.includes('\n') ? prompt.split('\n') : [null, prompt];
  const save = (l: string) => void call('snippets.save', { title: l.slice(0, 70), language: 'fbrx1', content: l, tags: ['fbrx1'] }).then(() => toast.success('Saved to Snippets', 'It is in the FBRX/1 library under My snippets.'));

  return (
    <Card
      className="term-card cli-card"
      title={
        <span className="cli-title">
          <span className="cli-badge">FBRX/1</span> management console
        </span>
      }
      actions={
        <>
          <Button size="sm" variant="ghost" icon="info" onClick={() => void run(['help'])}>
            Commands
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setEntries([])}>
            Clear
          </Button>
        </>
      }
      flush
    >
      <div className="term cli" ref={out} onClick={() => window.getSelection()?.isCollapsed && box.current?.focus()}>
        <div className="term-dim">
          FBRX/1 — type <b>help</b>, press <kbd className="kbd">Tab</kbd> to complete and <kbd className="kbd">?</kbd> for what comes next. <b>show</b> reads, <b>request</b> acts, <b>configure</b> → <b>set</b> → <b>commit</b> changes settings. Pipes: <code>| match</code>, <code>| except</code>, <code>| count</code>, <code>| display set</code>.
        </div>
        {entries.map((e) => (
          <div key={e.id} className="cli-entry">
            <div className="cli-cmd">
              <span className="cli-prompt">{e.prompt.split('\n').pop()}</span> {e.line}
              {e.line.trim() && !/^(configure|exit|commit|rollback|help|clear)\b/.test(e.line.trim()) && (
                <span className="cli-entry-actions">
                  <Button size="sm" variant="ghost" icon="bookmark" aria-label="Save as a snippet" title="Save as a snippet" onClick={() => save(e.line)} />
                  <AskButton iconOnly label="Explain this output" prompt={`I ran "${e.line}" in FBRX/1, the FBRX management console. Explain the output in plain language and anything I should act on.`} context={e.output.slice(-6000)} />
                </span>
              )}
            </div>
            {e.output && <pre className={`term-out${e.output.startsWith('error:') ? ' term-err' : ''}`}>{e.output}</pre>}
          </div>
        ))}
      </div>
      <div className="term-input cli-input">
        {slash.menu}
        <div className="cli-input-prompt">
          {editLine && <span className="cli-edit">{editLine}</span>}
          <span className="cli-prompt">{promptLine || '…'}</span>
        </div>
        <Input
          ref={box}
          className="mono"
          value={line}
          disabled={busy}
          aria-label="FBRX/1 command"
          placeholder={busy ? 'Working…' : 'show system status'}
          autoFocus
          spellCheck={false}
          onChange={(e) => setLine(e.target.value)}
          onKeyDown={(e) => {
            if (slash.onKeyDown(e)) return;
            if (e.key === 'Enter') {
              e.preventDefault();
              submit();
            } else if (e.key === 'Tab') {
              e.preventDefault();
              void complete();
            } else if (e.key === '?' && (line.match(/"/g)?.length ?? 0) % 2 === 0) {
              e.preventDefault();
              void run([`${line.trimEnd()} ?`]);
            } else if (e.key === 'ArrowUp' && history.length) {
              e.preventDefault();
              const i = Math.min(history.length - 1, hIdx + 1);
              setHIdx(i);
              setLine(history[i]);
            } else if (e.key === 'ArrowDown') {
              e.preventDefault();
              const i = hIdx - 1;
              setHIdx(Math.max(-1, i));
              setLine(i >= 0 ? history[i] : '');
            } else if (e.key === 'l' && e.ctrlKey) {
              e.preventDefault();
              setEntries([]);
            }
          }}
        />
        <Button variant="primary" icon="play" disabled={busy} onClick={submit}>
          Run
        </Button>
      </div>
    </Card>
  );
}

/** Pre-configured FBRX/1 commands and recipes, plus snippets saved from the console. */
function Fbrx1Library({ onRun, onInsert }: { onRun: (lines: string[]) => void; onInsert: (text: string) => void }) {
  const [group, setGroup] = useState(FBRX1_LIBRARY[0].id);
  const [q, setQ] = useState('');
  const snippets = useCore('snippets.list', undefined, ['workspace.changed']);
  const mine = (snippets.data ?? []).filter((x: Snippet) => x.language === 'fbrx1' || x.tags.includes('fbrx1'));
  const s = q.trim().toLowerCase();
  const items = s ? FBRX1_LIBRARY.flatMap((g) => g.items).filter((r) => `${r.title} ${r.what} ${r.lines.join(' ')}`.toLowerCase().includes(s)) : group === 'mine' ? [] : (FBRX1_LIBRARY.find((g) => g.id === group)?.items ?? []);
  const row = (key: string, title: string, what: string, lines: string[]) => (
    <div key={key} className="ref-item">
      <button className="ref-text" onClick={() => onInsert(lines[0])} title={lines.length > 1 ? 'A recipe: ▶ runs every line in order' : 'Put it in the command line'}>
        <span className="ref-title">
          {title}
          {lines.length > 1 && <span className="fx-badge">{lines.length} lines</span>}
        </span>
        <code>{lines.join('\n')}</code>
        {what && <span className="ref-sub">{what}</span>}
      </button>
      <div className="ref-actions">
        <Button size="sm" variant="ghost" icon="play" aria-label="Run" title="Run" onClick={() => onRun(lines)} />
      </div>
    </div>
  );
  return (
    <Card className="term-panel" title="FBRX/1 library" subtitle="Pre-configured commands and recipes. Click to edit; ▶ runs." flush>
      <div className="term-panel-top">
        <Input placeholder="Search commands" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search FBRX/1 commands" />
        {!s && (
          <div className="chips ref-chips">
            {FBRX1_LIBRARY.map((g) => (
              <button key={g.id} className={`chip${group === g.id ? ' on' : ''}`} onClick={() => setGroup(g.id)}>
                {g.name}
              </button>
            ))}
            <button className={`chip${group === 'mine' ? ' on' : ''}`} onClick={() => setGroup('mine')}>
              <Icons.bookmark size={12} /> My snippets{mine.length ? ` (${mine.length})` : ''}
            </button>
          </div>
        )}
      </div>
      <div className="term-panel-list">
        {items.map((r) => row(r.title, r.title, r.what, r.lines))}
        {(group === 'mine' || s) && mine.filter((x) => !s || `${x.title} ${x.content}`.toLowerCase().includes(s)).map((x) => row(x.id, x.title, 'Saved snippet', x.content.split('\n').filter((l) => l.trim())))}
        {group === 'mine' && !s && !mine.length && <div className="fx-muted" style={{ padding: 12, fontSize: 12.5 }}>Save a command from the console with its bookmark button, or add a snippet with the language "fbrx1" in Snippets.</div>}
      </div>
    </Card>
  );
}
