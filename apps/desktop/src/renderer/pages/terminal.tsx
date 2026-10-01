import { useEffect, useRef, useState } from 'react';
import { Button, Card, Input, Page, Status, useAction } from '@fbrx/ui';
import { bridge, call, onEvent } from '../client';
import { AskButton } from '../widgets';

interface Block {
  id: string;
  command: string;
  cwd: string;
  out: Array<{ stream: 'out' | 'err'; text: string }>;
  code: number | null | undefined;
}

const SHELL = bridge.platform === 'win32' ? 'PowerShell' : 'shell';

/** A simple command runner: each command runs in a fresh shell; output streams live. Recorded in the audit log. */
export function TerminalPage() {
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [cmd, setCmd] = useState('');
  const [cwd, setCwd] = useState('');
  const [history, setHistory] = useState<string[]>([]);
  const [hIdx, setHIdx] = useState(-1);
  const out = useRef<HTMLDivElement>(null);
  const { run } = useAction();

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

  const exec = async () => {
    const command = cmd.trim();
    if (!command) return;
    if (command === 'clear' || command === 'cls') {
      setBlocks([]);
      setCmd('');
      return;
    }
    const m = command.match(/^cd\s+(.+)$/i);
    if (m) {
      const target = m[1].trim().replace(/^["']|["']$/g, '');
      const sep = bridge.platform === 'win32' ? '\\' : '/';
      const next = /^([a-z]:|\/|~)/i.test(target) ? target : `${cwd.replace(/[\\/]$/, '')}${sep}${target}`;
      const ok = await run('cd', () => call('files.list', { path: next }));
      if (ok) setCwd(ok.path);
      setCmd('');
      return;
    }
    setHistory((h) => [command, ...h.filter((x) => x !== command)].slice(0, 50));
    setHIdx(-1);
    setCmd('');
    const r = await run('run', () => call('terminal.run', { command, cwd: cwd || undefined }));
    if (r) setBlocks((bs) => [...bs, { id: r.sessionId, command, cwd, out: [], code: undefined }]);
  };

  const running = blocks.filter((b) => b.code === undefined);
  return (
    <Page title="Terminal" description={`Run ${SHELL} commands. Each command starts fresh in the folder shown; type “cd folder” to move. Commands are recorded in the audit log.`}>
      <Card
        className="term-card"
        title={<span className="mono" style={{ fontSize: 13 }}>{cwd || '…'}</span>}
        actions={
          <>
            {running.length > 0 && <Status tone="busy">{running.length} running</Status>}
            <Button size="sm" variant="ghost" onClick={() => setBlocks([])}>
              Clear
            </Button>
          </>
        }
        flush
      >
        <div className="term" ref={out}>
          {!blocks.length && <div className="term-dim">Type a command below. Try “{bridge.platform === 'win32' ? 'Get-ComputerInfo | Select-Object OsName, OsVersion' : 'uname -a'}”.</div>}
          {blocks.map((b) => (
            <div key={b.id} className="term-block">
              <div className="term-cmd">
                <span className="term-prompt">❯</span> {b.command}
                {b.code === undefined ? (
                  <Button size="sm" variant="ghost" icon="stop" aria-label="Stop" onClick={() => void call('terminal.kill', { sessionId: b.id })} />
                ) : (
                  <>
                    <span className={b.code === 0 ? 'term-ok' : 'term-err'}>{b.code === null ? 'stopped' : `exit ${b.code}`}</span>
                    <AskButton iconOnly label="Explain this output" prompt={`I ran this command in the FBRX OS terminal${b.code ? ` and it failed (exit code ${b.code})` : ''}. Explain the output in plain language${b.code ? ', what went wrong and how to fix it' : ' and anything I should act on'}.\n\nCommand: ${b.command}`} context={b.out.map((o) => o.text).join('').slice(-8000)} />
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
        <div className="term-input">
          <span className="term-prompt">❯</span>
          <Input
            className="fx-input mono"
            value={cmd}
            placeholder={`${SHELL} command`}
            aria-label="Command"
            autoFocus
            onChange={(e) => setCmd(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void exec();
              else if (e.key === 'ArrowUp' && history.length) {
                const i = Math.min(history.length - 1, hIdx + 1);
                setHIdx(i);
                setCmd(history[i]);
                e.preventDefault();
              } else if (e.key === 'ArrowDown') {
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
    </Page>
  );
}
