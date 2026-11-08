import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { Button, Callout, Card, Empty, Page, Status, useToast } from '@fbrx/ui';
import { api } from '../api';
import { useApp, usePoll } from '../state';

interface TerminalState {
  available: boolean;
  reason: string | null;
  hostname: string;
  recorded: boolean;
  keepDays: number;
  open: number;
}

type Phase = 'connecting' | 'open' | 'closed';

/**
 * Server → Terminal: the server's own shell (root bash on Debian), right in the console. Ctrl+C stops what is running
 * (with text selected, it copies instead), and the size follows the window.
 */
export function TerminalPage() {
  const app = useApp();
  const st = usePoll<TerminalState>(app.can('admin') ? '/v1/host/terminal' : null, 60000);
  if (!app.can('admin')) return <Page title="Terminal"><Empty title="For administrators">The server’s shell is for administrators only.</Empty></Page>;
  if (!st.data) return <Page title="Terminal"><Empty title={st.error ?? 'Loading…'} /></Page>;
  const s = st.data;
  return (
    <Page title="Terminal" description={`The shell of ${s.hostname}, as root. Everything you could do at the server’s own keyboard, from here.`}>
      {!s.available ? <Empty title="No terminal here">{s.reason}</Empty> : <Screen state={s} />}
    </Page>
  );
}

function Screen({ state }: { state: TerminalState }) {
  const toast = useToast();
  const box = useRef<HTMLDivElement>(null);
  const term = useRef<Terminal | null>(null);
  const sock = useRef<WebSocket | null>(null);
  const [phase, setPhase] = useState<Phase>('connecting');
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    const t = new Terminal({
      fontFamily: '"JetBrains Mono", "Cascadia Mono", Consolas, Menlo, monospace',
      fontSize: 13,
      cursorBlink: true,
      scrollback: 10000,
      theme: { background: '#0b0b0d', foreground: '#e3e6ea', cursor: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#f4b942', selectionBackground: 'rgba(244,185,66,0.35)' },
    });
    const fit = new FitAddon();
    t.loadAddon(fit);
    t.open(box.current!);
    term.current = t;
    try {
      fit.fit();
    } catch {
      /* not laid out yet */
    }
    const enc = new TextEncoder();
    const send = (b: Uint8Array) => sock.current?.readyState === WebSocket.OPEN && sock.current.send(b);
    // Ctrl+C with text selected copies it (Ctrl+Shift+C too); without, it goes to the shell and stops what is running.
    t.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown' || !(e.ctrlKey || e.metaKey)) return true;
      const k = e.key.toLowerCase();
      if (k === 'c' && (t.hasSelection() || e.shiftKey)) {
        if (t.hasSelection()) void navigator.clipboard?.writeText(t.getSelection()).catch(() => undefined);
        t.clearSelection();
        return false;
      }
      // Ctrl+Shift+V (and Cmd+V): the browser pastes, the terminal types it.
      if (k === 'v' && (e.shiftKey || e.metaKey)) return false;
      return true;
    });
    const typed = t.onData((d) => send(enc.encode(d)));
    const binary = t.onBinary((d) => send(Uint8Array.from(d, (c) => c.charCodeAt(0) & 0xff)));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        return;
      }
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (sock.current?.readyState === WebSocket.OPEN) sock.current.send(JSON.stringify({ type: 'resize', cols: t.cols, rows: t.rows }));
      }, 150);
    });
    ro.observe(box.current!);

    let cancelled = false;
    setPhase('connecting');
    setError(null);
    void (async () => {
      try {
        const k = await api<{ ticket: string; path: string }>('POST', '/v1/host/terminal');
        if (cancelled) return;
        const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${k.path}?ticket=${encodeURIComponent(k.ticket)}&cols=${t.cols}&rows=${t.rows}`;
        const ws = new WebSocket(url);
        ws.binaryType = 'arraybuffer';
        sock.current = ws;
        ws.onopen = () => {
          setPhase('open');
          t.focus();
        };
        ws.onmessage = (e) => t.write(typeof e.data === 'string' ? e.data : new Uint8Array(e.data as ArrayBuffer));
        ws.onclose = (e) => {
          if (cancelled) return;
          setPhase('closed');
          t.write(`\r\n\x1b[33m[${e.reason || 'Disconnected'}]\x1b[0m\r\n`);
        };
      } catch (e) {
        if (cancelled) return;
        setError((e as Error).message);
        setPhase('closed');
      }
    })();
    return () => {
      cancelled = true;
      clearTimeout(timer);
      ro.disconnect();
      typed.dispose();
      binary.dispose();
      sock.current?.close();
      sock.current = null;
      t.dispose();
      term.current = null;
    };
  }, [nonce]);

  const paste = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) term.current?.paste(text);
      term.current?.focus();
    } catch {
      toast.warning('The browser keeps the clipboard to itself here', 'Press Ctrl+Shift+V in the terminal (Cmd+V on a Mac) to paste.');
    }
  };

  return (
    <>
      <Card
        flush
        title={`root@${state.hostname}`}
        subtitle={
          <span className="vt-term-sub">
            {phase === 'open' ? <Status tone="good">Connected</Status> : phase === 'connecting' ? <Status tone="neutral">Connecting…</Status> : <Status tone="warning">Closed</Status>}
            {state.recorded && <span>Sessions are recorded on the server and kept {state.keepDays} days.</span>}
          </span>
        }
        actions={
          <>
            <Button size="sm" icon="clipboard" disabled={phase !== 'open'} onClick={() => void paste()} title="Type the text on your clipboard into the shell">
              Paste
            </Button>
            <Button size="sm" icon="external" onClick={() => void box.current?.parentElement?.requestFullscreen()}>
              Full screen
            </Button>
            {phase === 'open' ? (
              <Button size="sm" icon="x" onClick={() => sock.current?.close()}>
                End session
              </Button>
            ) : (
              <Button size="sm" icon="refresh" variant={phase === 'closed' ? 'primary' : undefined} onClick={() => setNonce((n) => n + 1)}>
                {phase === 'closed' ? 'New session' : 'Reconnect'}
              </Button>
            )}
          </>
        }
      >
        {error && <Callout tone="critical">{error}</Callout>}
        <div className="vt-term-wrap">
          <div ref={box} className="vt-term" onClick={() => term.current?.focus()} />
        </div>
      </Card>
      <p className="fx-help">
        This is a root shell: commands run with full rights over the server and its virtual machines. Ctrl+C stops the running command (with text selected, it copies). Each session is in Users &amp; audit.
      </p>
    </>
  );
}
