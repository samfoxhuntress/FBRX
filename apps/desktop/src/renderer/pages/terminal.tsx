import { useEffect, useMemo, useRef, useState } from 'react';
import type { Note, ProjectSummary, Snippet, TerminalShell } from '@fbrx/shared';
import { Button, Card, Empty, Input, Page, Select, Status, Tabs, TextArea, useAction, useConfirm, useToast } from '@fbrx/ui';
import { bridge, call, onEvent } from '../client';
import { navigate, routeArg } from '../app';
import { useCore } from '../hooks';
import { AskButton, askAgent } from '../widgets';
import { COMMAND_GROUPS, type LibraryCommand } from '../command-library';
import { DeviceConsolesPanel, useConsoleSessions } from '../consoles';
import { summonGoose } from '../fun';

interface Block {
  id: string;
  command: string;
  cwd: string;
  shell: string;
  out: Array<{ stream: 'out' | 'err'; text: string }>;
  code: number | null | undefined;
}

const SHELL_KEY = 'fbrx.terminal.shell';
const IS_WIN = bridge.platform === 'win32';

/** Code blocks and inline code in a note: the parts worth pasting into a terminal. */
function codeIn(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/```[\w-]*\n([\s\S]*?)```/g)) out.push(m[1].trim());
  for (const m of text.replace(/```[\s\S]*?```/g, '').matchAll(/`([^`\n]{3,})`/g)) out.push(m[1].trim());
  return out.filter(Boolean);
}

/** Answers a few commands itself (only with fun extras on). Returns the reply, or null to run the command. */
function easterEgg(command: string): string | 'honk' | 'matrix' | null {
  const c = command.trim().toLowerCase().replace(/\s+/g, ' ');
  if (/^(rm -rf (\/|\/\*|~)|format c:|del \/s \/q c:\\?|remove-item c:\\ -recurse)/.test(c)) return 'Nice try. Fabrix hid the sharp objects. (Not run.)';
  if (c === 'sudo make me a sandwich') return 'Okay.';
  if (c === 'make me a sandwich') return 'What? Make it yourself.';
  if (c === 'honk' || c === 'goose') return 'honk';
  if (c === 'matrix' || c === 'wake up neo') return 'matrix';
  if (c === 'make coffee' || c === 'coffee') return "418 I'm a teapot. Try the kitchen.";
  if (c === 'hello' || c === 'hi' || c === 'hello fabrix') return 'Hello! I run your commands, Fabrix explains them. Try the reference panel on the right.';
  if (c === 'exit' || c === 'quit') return 'There is no exit. Only other pages. (Each command already runs in its own fresh shell.)';
  if (c === 'xyzzy') return 'Nothing happens.';
  return null;
}

/** Green rain for a few seconds (the "matrix" easter egg). */
function MatrixRain({ onDone }: { onDone: () => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = canvas.current!;
    const ctx = c.getContext('2d')!;
    const w = (c.width = c.offsetWidth);
    const h = (c.height = c.offsetHeight);
    const cols = Math.floor(w / 14);
    const drops = Array.from({ length: cols }, () => Math.random() * -40);
    const chars = 'FBRXアカサタナハマヤラワ0123456789';
    const t = setInterval(() => {
      ctx.fillStyle = 'rgba(12,14,17,0.12)';
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = '#3cff7a';
      ctx.font = '14px monospace';
      drops.forEach((y, i) => {
        ctx.fillText(chars[Math.floor(Math.random() * chars.length)], i * 14, y * 16);
        drops[i] = y * 16 > h && Math.random() > 0.97 ? 0 : y + 1;
      });
    }, 45);
    const end = setTimeout(onDone, 6000);
    return () => {
      clearInterval(t);
      clearTimeout(end);
    };
  }, [onDone]);
  return <canvas ref={canvas} className="matrix-rain" aria-hidden />;
}

function Reference({ onInsert, onRun, lastCommand }: { onInsert: (cmd: string) => void; onRun: (cmd: string, changes?: boolean) => void; lastCommand: string | null }) {
  const [tab, setTab] = useState<'commands' | 'snippets' | 'notes' | 'projects'>('commands');
  const [q, setQ] = useState('');
  const [group, setGroup] = useState(COMMAND_GROUPS[0].id);
  const snippets = useCore('snippets.list', undefined, ['workspace.changed']);
  const notes = useCore('notes.list', undefined, ['workspace.changed']);
  const projects = useCore('projects.list', undefined, ['workspace.changed']);
  const [project, setProject] = useState<string>('');
  const [openNote, setOpenNote] = useState<string | null>(null);
  const toast = useToast();
  const s = q.trim().toLowerCase();
  const match = (...t: Array<string | null | undefined>) => !s || t.join(' ').toLowerCase().includes(s);
  const cmds: LibraryCommand[] = s ? COMMAND_GROUPS.flatMap((g) => g.items).filter((c) => match(c.title, c.cmd, c.what)) : (COMMAND_GROUPS.find((g) => g.id === group)?.items ?? []);
  const proj = (projects.data ?? []).find((p) => p.id === project) as ProjectSummary | undefined;
  const snippetList = (snippets.data ?? []).filter((x: Snippet) => (!project || x.projectId === project) && match(x.title, x.content, x.tags.join(' ')));
  const noteList = (notes.data ?? []).filter((n: Note) => (!project || n.projectId === project) && match(n.title, n.content));

  const row = (key: string, title: string, sub: string, cmd: string, extra?: { admin?: boolean; changes?: boolean }) => (
    <div key={key} className="ref-item">
      <button className="ref-text" onClick={() => onInsert(cmd)} title="Put it in the command box">
        <span className="ref-title">
          {title}
          {extra?.admin && <span className="fx-badge" title="Needs an administrator terminal">admin</span>}
        </span>
        <code>{cmd.length > 140 ? `${cmd.slice(0, 140)}…` : cmd}</code>
        {sub && <span className="ref-sub">{sub}</span>}
      </button>
      <div className="ref-actions">
        <Button size="sm" variant="ghost" icon="play" aria-label="Run" title={extra?.changes ? 'Run (asks first)' : 'Run'} onClick={() => onRun(cmd, extra?.changes)} />
        <AskButton iconOnly label="Explain this command" prompt={`Explain this ${IS_WIN ? 'PowerShell' : 'shell'} command line by line in plain language: what it does, whether it changes anything, and anything to watch out for.\n\n${cmd}`} />
      </div>
    </div>
  );

  return (
    <Card className="term-panel" title="Reference" subtitle="Click to put a command in the box; ▶ runs it." flush>
      <div className="term-panel-top">
        <Tabs
          active={tab}
          onChange={setTab}
          tabs={[
            { id: 'commands', label: 'Commands' },
            { id: 'snippets', label: 'Snippets' },
            { id: 'notes', label: 'Notes' },
            { id: 'projects', label: 'Projects' },
          ]}
        />
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={tab === 'commands' ? 'Search commands' : `Search ${tab}`} aria-label="Search the reference" />
        {tab === 'commands' && !s && (
          <div className="chips">
            {COMMAND_GROUPS.map((g) => (
              <button key={g.id} className={`chip${group === g.id ? ' on' : ''}`} onClick={() => setGroup(g.id)}>
                {g.name}
              </button>
            ))}
          </div>
        )}
        {(tab === 'snippets' || tab === 'notes' || tab === 'projects') && (
          <Select aria-label="Project" value={project} onChange={(e) => setProject(e.target.value)} options={[{ value: '', label: 'All projects' }, ...(projects.data ?? []).map((p) => ({ value: p.id, label: p.name }))]} />
        )}
      </div>
      <div className="term-panel-list">
        {tab === 'commands' && (cmds.length ? cmds.map((c) => row(c.cmd, c.title, c.what, c.cmd, c)) : <Empty title="No commands match" />)}
        {tab === 'snippets' &&
          (snippetList.length ? (
            snippetList.map((x) => row(x.id, x.title, x.tags.join(', '), x.content))
          ) : (
            <Empty title="No snippets yet" action={<Button size="sm" onClick={() => navigate('snippets')}>Open Snippets</Button>}>
              Save a command you like with the bookmark next to it, or in Snippets.
            </Empty>
          ))}
        {tab === 'notes' &&
          (noteList.length ? (
            noteList.map((n) => {
              const code = codeIn(n.content);
              return (
                <div key={n.id} className="ref-note">
                  <button className="ref-note-head" onClick={() => setOpenNote(openNote === n.id ? null : n.id)}>
                    <span className="ref-title">{n.title}</span>
                    <span className="ref-sub">{code.length ? `${code.length} command${code.length > 1 ? 's' : ''}` : 'No code in this note'}</span>
                  </button>
                  {openNote === n.id && (
                    <div className="ref-note-body">
                      {code.map((c, i) => row(`${n.id}-${i}`, `From "${n.title}"`, '', c))}
                      <pre className="ref-note-text">{n.content.slice(0, 2000)}</pre>
                    </div>
                  )}
                </div>
              );
            })
          ) : (
            <Empty title="No notes">Commands in `backticks` or ``` code blocks ``` in your notes show up here.</Empty>
          ))}
        {tab === 'projects' &&
          (proj ? (
            <>
              <div className="ref-sub" style={{ padding: '6px 10px' }}>
                {proj.description || 'No description'} · {proj.snippets} snippets · {proj.notes} notes
              </div>
              {lastCommand && (
                <div style={{ padding: '0 10px 8px' }}>
                  <Button
                    size="sm"
                    icon="bookmark"
                    onClick={() =>
                      void call('snippets.save', { title: lastCommand.slice(0, 70), language: IS_WIN ? 'powershell' : 'shell', content: lastCommand, projectId: proj.id }).then(() => toast.success(`Saved to ${proj.name}`))
                    }
                  >
                    Save the last command to {proj.name}
                  </Button>
                </div>
              )}
              {snippetList.map((x) => row(x.id, x.title, 'Snippet', x.content))}
              {noteList.flatMap((n) => codeIn(n.content).map((c, i) => row(`${n.id}-${i}`, n.title, 'From a note', c)))}
              {!snippetList.length && !noteList.some((n) => codeIn(n.content).length) && <Empty title="Nothing to paste yet">This project has no snippets or code in its notes.</Empty>}
            </>
          ) : (projects.data ?? []).length ? (
            (projects.data ?? []).map((p) => (
              <button key={p.id} className="ref-note-head" onClick={() => setProject(p.id)}>
                <span className="ref-title">
                  <span className="proj-dot" style={{ background: p.color }} /> {p.name}
                </span>
                <span className="ref-sub">
                  {p.snippets} snippets · {p.notes} notes · {p.tasks - p.done} open tasks
                </span>
              </button>
            ))
          ) : (
            <Empty title="No projects" action={<Button size="sm" onClick={() => navigate('projects')}>Open Projects</Button>} />
          ))}
      </div>
    </Card>
  );
}

/** A simple command runner: each command runs in a fresh shell; output streams live. Recorded in the audit log. */
export function TerminalPage({ easterEggs }: { easterEggs: boolean }) {
  // The page stays mounted while only the part after "terminal/" changes, so follow the address here.
  const [arg, setArg] = useState(() => routeArg() ?? '');
  useEffect(() => {
    const on = () => setArg(routeArg() ?? '');
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  const [tab, setTab] = useState<'commands' | 'consoles'>(arg.startsWith('console') ? 'consoles' : 'commands');
  const [consoleId, setConsoleId] = useState<string | null>(arg.startsWith('console/') ? arg.slice(8) : null);
  const consoles = useConsoleSessions();
  const openConsoles = (consoles.data ?? []).filter((s) => s.state !== 'closed').length;
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [cmd, setCmd] = useState(() => (arg.startsWith('cmd/') ? decodeURIComponent(arg.slice(4)) : ''));
  const [cwd, setCwd] = useState('');
  const [history, setHistory] = useState<string[]>([]);
  const [hIdx, setHIdx] = useState(-1);
  const [matrix, setMatrix] = useState(false);
  const shells = useCore('terminal.shells');
  const [shellId, setShellId] = useState<TerminalShell['id'] | ''>(() => (localStorage.getItem(SHELL_KEY) as TerminalShell['id']) ?? '');
  const shell = (shells.data ?? []).find((s) => s.id === shellId) ?? (shells.data ?? []).find((s) => s.default);
  const out = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const { run } = useAction();
  const { confirm, dialog } = useConfirm();
  const toast = useToast();

  useEffect(() => {
    const a = arg;
    if (a.startsWith('cmd/')) {
      setTab('commands');
      setCmd(decodeURIComponent(a.slice(4)));
    } else if (a.startsWith('console')) {
      setTab('consoles');
      if (a.startsWith('console/')) setConsoleId(a.slice(8));
    }
  }, [arg]);
  useEffect(() => {
    const offs = [
      onEvent('terminal.output', (e) => setBlocks((bs) => bs.map((b) => (b.id === e.sessionId ? { ...b, out: [...b.out, { stream: e.stream, text: e.text }] } : b)))),
      onEvent('terminal.exit', (e) => setBlocks((bs) => bs.map((b) => (b.id === e.sessionId ? { ...b, code: e.code } : b)))),
    ];
    void call('files.home').then((h) => setCwd((c) => c || h.home));
    return () => offs.forEach((o) => o());
  }, []);
  useEffect(() => {
    out.current?.scrollTo({ top: out.current.scrollHeight });
  }, [blocks]);

  const local = (command: string, text: string) => setBlocks((bs) => [...bs, { id: `local-${Date.now()}`, command, cwd, shell: 'FBRX', out: [{ stream: 'out', text: `${text}\n` }], code: 0 }]);

  const exec = async (raw?: string, askFirst?: boolean) => {
    const command = (raw ?? cmd).trim();
    if (!command) return;
    if (raw === undefined) setCmd('');
    if (command === 'clear' || command === 'cls') {
      setBlocks([]);
      return;
    }
    if (command.startsWith('?')) {
      askAgent(`Write a ${shell?.name ?? 'PowerShell'} command for this, explain it briefly, and say whether it changes anything: ${command.slice(1).trim()}`);
      return;
    }
    if (easterEggs) {
      const egg = easterEgg(command);
      if (egg === 'honk') {
        summonGoose();
        return local(command, 'HONK. (Look at your screen.)');
      }
      if (egg === 'matrix') {
        setMatrix(true);
        return local(command, 'Follow the white rabbit.');
      }
      if (egg) return local(command, egg);
    }
    const m = command.match(/^cd\s+(.+)$/i);
    if (m) {
      const target = m[1].trim().replace(/^["']|["']$/g, '');
      const sep = IS_WIN ? '\\' : '/';
      const next = /^([a-z]:|\/|~)/i.test(target) ? target : `${cwd.replace(/[\\/]$/, '')}${sep}${target}`;
      const ok = await run('cd', () => call('files.list', { path: next }));
      if (ok) setCwd(ok.path);
      return;
    }
    if (askFirst && !(await confirm({ title: 'Run this command?', body: <code style={{ whiteSpace: 'pre-wrap' }}>{command}</code>, confirmLabel: 'Run' }))) return;
    setHistory((h) => [command, ...h.filter((x) => x !== command)].slice(0, 50));
    setHIdx(-1);
    const r = await run('run', () => call('terminal.run', { command, cwd: cwd || undefined, shell: shell?.id }));
    if (r) setBlocks((bs) => [...bs, { id: r.sessionId, command, cwd, shell: shell?.name ?? '', out: [], code: undefined }]);
  };

  const insert = (c: string) => {
    setCmd(c);
    setTimeout(() => box.current?.focus(), 0);
  };
  const running = blocks.filter((b) => b.code === undefined);
  const shellName = shell?.name ?? (IS_WIN ? 'PowerShell' : 'shell');
  const examples = useMemo(() => (IS_WIN ? ['Get-ComputerInfo | Select-Object OsName, OsVersion', '? find the 10 biggest files in Downloads'] : ['uname -a']), []);

  return (
    <Page
      title="Terminal"
      description={
        tab === 'commands'
          ? `Run ${shellName} commands. Each command starts fresh in the folder shown; type “cd folder” to move, or start with ? to ask for a command. Commands are recorded in the audit log.`
          : 'Command lines of switches, firewalls, access points and servers, over SSH or Telnet, with the maker\'s guide alongside.'
      }
    >
      <Tabs
        active={tab}
        onChange={(t) => {
          setTab(t);
          navigate(t === 'consoles' ? `terminal/console${consoleId ? `/${consoleId}` : ''}` : 'terminal');
        }}
        tabs={[
          { id: 'commands', label: shellName },
          { id: 'consoles', label: `Device consoles${openConsoles ? ` (${openConsoles})` : ''}` },
        ]}
      />
      {tab === 'consoles' ? (
        <DeviceConsolesPanel
          selected={consoleId}
          onSelect={(id) => {
            setConsoleId(id);
            if (id && routeArg() !== `console/${id}`) history_replace(`terminal/console/${id}`);
          }}
        />
      ) : (
        <div className="term-layout">
          <Card
            className="term-card"
            title={<span className="mono" style={{ fontSize: 13 }}>{cwd || '…'}</span>}
            actions={
              <>
                {running.length > 0 && <Status tone="busy">{running.length} running</Status>}
                {(shells.data?.length ?? 0) > 1 && (
                  <div style={{ width: 210 }}>
                    <Select
                      aria-label="Shell"
                      value={shell?.id ?? ''}
                      onChange={(e) => {
                        setShellId(e.target.value as TerminalShell['id']);
                        localStorage.setItem(SHELL_KEY, e.target.value);
                      }}
                      options={(shells.data ?? []).map((s) => ({ value: s.id, label: `${s.name}${s.version ? ` (${s.version})` : ''}` }))}
                    />
                  </div>
                )}
                <Button size="sm" variant="ghost" onClick={() => setBlocks([])}>
                  Clear
                </Button>
              </>
            }
            flush
          >
            <div className="term-wrap">
            {matrix && <MatrixRain onDone={() => setMatrix(false)} />}
            <div className="term" ref={out}>
              {!blocks.length && (
                <div className="term-dim">
                  Type a command below, or pick one from the reference on the right. Try “{examples[0]}”{IS_WIN ? <> or “{examples[1]}”</> : null}.
                </div>
              )}
              {blocks.map((b) => (
                <div key={b.id} className="term-block">
                  <div className="term-cmd">
                    <span className="term-prompt">❯</span> {b.command}
                    {b.code === undefined ? (
                      <Button size="sm" variant="ghost" icon="stop" aria-label="Stop" onClick={() => void call('terminal.kill', { sessionId: b.id })} />
                    ) : (
                      <>
                        <span className={b.code === 0 ? 'term-ok' : 'term-err'}>{b.code === null ? 'stopped' : `exit ${b.code}`}</span>
                        {!b.id.startsWith('local-') && (
                          <>
                            <Button
                              size="sm"
                              variant="ghost"
                              icon="bookmark"
                              aria-label="Save as a snippet"
                              title="Save as a snippet"
                              onClick={() => void call('snippets.save', { title: b.command.slice(0, 70), language: IS_WIN ? 'powershell' : 'shell', content: b.command, tags: ['terminal'] }).then(() => toast.success('Saved to Snippets'))}
                            />
                            <AskButton iconOnly label="Explain this output" prompt={`I ran this command in the FBRX OS terminal (${b.shell})${b.code ? ` and it failed (exit code ${b.code})` : ''}. Explain the output in plain language${b.code ? ', what went wrong and how to fix it' : ' and anything I should act on'}.\n\nCommand: ${b.command}`} context={b.out.map((o) => o.text).join('').slice(-8000)} />
                          </>
                        )}
                      </>
                    )}
                  </div>
                  <pre className="term-out">
                    {b.out.map((o, i) => (
                      <span key={i} className={o.stream === 'err' ? 'term-err' : undefined}>
                        {o.text}
                      </span>
                    ))}
                  </pre>
                </div>
              ))}
            </div>
            </div>
            <div className="term-input">
              <span className="term-prompt">❯</span>
              <TextArea
                ref={box}
                className="mono term-box"
                rows={Math.min(6, Math.max(1, cmd.split('\n').length))}
                value={cmd}
                placeholder={`${shellName} command (Shift+Enter for a new line, ? to ask)`}
                aria-label="Command"
                autoFocus
                onChange={(e) => setCmd(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    void exec();
                  } else if (e.key === 'ArrowUp' && history.length && !cmd.includes('\n')) {
                    const i = Math.min(history.length - 1, hIdx + 1);
                    setHIdx(i);
                    setCmd(history[i]);
                    e.preventDefault();
                  } else if (e.key === 'ArrowDown' && !cmd.includes('\n')) {
                    const i = hIdx - 1;
                    setHIdx(Math.max(-1, i));
                    setCmd(i >= 0 ? history[i] : '');
                    e.preventDefault();
                  }
                }}
              />
              <Button variant="primary" icon="play" onClick={() => void exec()}>
                Run
              </Button>
            </div>
          </Card>
          <Reference onInsert={insert} onRun={(c, changes) => void exec(c, changes)} lastCommand={history[0] ?? null} />
        </div>
      )}
      {dialog}
    </Page>
  );
}

/** Updates the address without adding a history entry (selecting a console tab). */
function history_replace(to: string) {
  window.history.replaceState(null, '', `#/${to}`);
}
