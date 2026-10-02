import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Button, Callout, FbrxMark, Modal, TextArea } from '@fbrx/ui';
import { call, onEvent } from './client';
import { useAgentName } from './hooks';
import { Markdown } from './markdown';
import { useSlashMenu } from './slash-menu';
import { navigate } from './app';

/**
 * Fabrix beside your work: the code lab, the event viewer and the task manager ask through `ai.quick` (the default
 * model, no tools, nothing it can run) and the answer streams into this panel. Follow-up questions keep the thread.
 */

export interface QuickTurn {
  id: number;
  role: 'user' | 'assistant';
  /** What the thread shows for a question (a button's name or the typed text). */
  label: string;
  /** What was sent (questions) or answered. */
  content: string;
}

let seq = 1;

export function useQuickAi() {
  const [turns, setTurns] = useState<QuickTurn[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const req = useRef<string | null>(null);
  const turnsRef = useRef(turns);
  turnsRef.current = turns;

  useEffect(
    () =>
      onEvent('ai.quick', (e) => {
        if (e.reqId !== req.current) return;
        setTurns((ts) => {
          const last = ts[ts.length - 1];
          return last?.role === 'assistant' ? [...ts.slice(0, -1), { ...last, content: last.content + e.delta }] : ts;
        });
      }),
    [],
  );
  useEffect(
    () => () => {
      if (req.current) void call('ai.quickCancel', { reqId: req.current }).catch(() => undefined);
    },
    [],
  );

  const ask = useCallback(async (label: string, prompt: string, context?: string) => {
    if (req.current) await call('ai.quickCancel', { reqId: req.current }).catch(() => undefined);
    const reqId = `q-${Date.now().toString(36)}-${seq++}`;
    req.current = reqId;
    const history = turnsRef.current
      .filter((t) => t.content.trim())
      .slice(-6)
      .map((t) => ({ role: t.role, content: t.content.slice(0, 8000) }));
    setError(null);
    setBusy(true);
    setTurns((ts) => [...ts, { id: seq++, role: 'user', label, content: prompt }, { id: seq++, role: 'assistant', label: '', content: '' }]);
    try {
      const r = await call('ai.quick', { reqId, prompt, context: context?.slice(0, 60_000), history });
      if (req.current === reqId)
        setTurns((ts) => {
          const last = ts[ts.length - 1];
          return last?.role === 'assistant' ? [...ts.slice(0, -1), { ...last, content: r.answer || last.content }] : ts;
        });
    } catch (e) {
      if (req.current === reqId) {
        setError((e as Error).message);
        setTurns((ts) => (ts[ts.length - 1]?.role === 'assistant' && !ts[ts.length - 1].content ? ts.slice(0, -1) : ts));
      }
    } finally {
      if (req.current === reqId) {
        req.current = null;
        setBusy(false);
      }
    }
  }, []);

  const stop = useCallback(() => {
    if (req.current) void call('ai.quickCancel', { reqId: req.current });
  }, []);
  const clear = useCallback(() => {
    stop();
    turnsRef.current = [];
    setTurns([]);
    setError(null);
  }, [stop]);

  return { turns, busy, error, ask, stop, clear };
}

export type QuickAi = ReturnType<typeof useQuickAi>;

export function QuickAiPanel({
  ai,
  actions,
  onAsk,
  placeholder,
  empty,
  codeActions,
  className,
}: {
  ai: QuickAi;
  /** Buttons for the common questions, shown above the thread. */
  actions?: ReactNode;
  /** A typed question: the page adds its context and calls ai.ask. */
  onAsk: (text: string) => void;
  placeholder?: string;
  empty?: ReactNode;
  codeActions?: (code: string, lang: string) => ReactNode;
  className?: string;
}) {
  const agent = useAgentName();
  const [text, setText] = useState('');
  const box = useRef<HTMLTextAreaElement>(null);
  const thread = useRef<HTMLDivElement>(null);
  const slash = useSlashMenu({ value: text, setValue: setText, inputRef: box, scope: 'chat' });
  const last = ai.turns[ai.turns.length - 1];

  useEffect(() => {
    const el = thread.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 120) el.scrollTop = el.scrollHeight;
  }, [last?.content, ai.turns.length]);

  const send = () => {
    const t = text.trim();
    if (!t || ai.busy) return;
    setText('');
    onAsk(t);
  };

  return (
    <div className={`qa-panel${className ? ` ${className}` : ''}`}>
      <div className="qa-head">
        <FbrxMark size={18} />
        <span className="qa-title">{agent}</span>
        <span className="qa-sub">reads along, can't run anything</span>
        {ai.turns.length > 0 && (
          <Button size="sm" variant="ghost" onClick={ai.clear}>
            Clear
          </Button>
        )}
      </div>
      {actions && <div className="qa-actions">{actions}</div>}
      <div className="qa-thread" ref={thread}>
        {!ai.turns.length && !ai.error && <div className="qa-empty">{empty ?? `Ask ${agent} about what you are looking at.`}</div>}
        {ai.turns.map((t, i) =>
          t.role === 'user' ? (
            <div key={t.id} className="qa-q">
              {t.label}
            </div>
          ) : (
            <div key={t.id} className="qa-a">
              {t.content ? <Markdown text={t.content} codeActions={ai.busy && i === ai.turns.length - 1 ? undefined : codeActions} /> : <span className="typing"><span /><span /><span /></span>}
            </div>
          ),
        )}
        {ai.error && (
          <Callout tone="critical" title={`${agent} could not answer`} actions={/model|runtime|provider|API key/i.test(ai.error) ? <Button size="sm" onClick={() => navigate('runtime')}>AI models</Button> : undefined}>
            {ai.error}
          </Callout>
        )}
      </div>
      <div className="qa-composer">
        {slash.menu}
        <TextArea
          ref={box}
          rows={2}
          value={text}
          placeholder={placeholder ?? `Ask ${agent}… (Enter to send)`}
          aria-label={`Ask ${agent}`}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (slash.onKeyDown(e)) return;
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        {ai.busy ? (
          <Button size="sm" icon="stop" onClick={ai.stop}>
            Stop
          </Button>
        ) : (
          <Button size="sm" variant="primary" icon="send" disabled={!text.trim()} onClick={send} aria-label="Ask" />
        )}
      </div>
    </div>
  );
}

/** The question behind every "What if?" button: what running this would do, before you run it. */
export function whatIfPrompt(kind: string): string {
  return [
    `What if I run this ${kind}? Before I run it, tell me what it will do:`,
    '1. In one or two sentences, what it does.',
    '2. Step by step, what happens when it runs.',
    '3. What it touches: files it reads, creates, changes or deletes; network or internet access; settings, the registry, services, accounts or other programs it changes; and whether it needs administrator rights.',
    '4. On its own line, a verdict: **Safe to run**, **Changes things** or **Risky**, and why.',
    'Be concrete and quote the parts that matter. If it is incomplete or would fail, say so.',
  ].join('\n');
}

/** "What if?" for a command: the AI's preview of what it would do, without running it. */
export function WhatIfButton({ command, kind, disabled }: { command: string; kind: string; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const ai = useQuickAi();
  const agent = useAgentName();
  const { stop } = ai;
  const close = useCallback(() => {
    stop();
    setOpen(false);
  }, [stop]);
  const go = () => {
    if (!command.trim()) return;
    ai.clear();
    setOpen(true);
    void ai.ask('What if I run this?', whatIfPrompt(kind), `${kind}:\n\`\`\`\n${command}\n\`\`\``);
  };
  return (
    <>
      <Button icon="sparkles" className="ask-btn" disabled={disabled || !command.trim()} onClick={go} title={`${agent} explains what this would do, without running it`}>
        What if?
      </Button>
      {open && (
        <Modal title="What if I run this?" description={`${agent}'s preview. Nothing has been run.`} onClose={close} wide footer={<Button onClick={close}>Close</Button>}>
          <pre className="whatif-cmd mono">{command}</pre>
          <QuickAiPanel ai={ai} className="qa-modal" onAsk={(t) => void ai.ask(t, t, `${kind}:\n\`\`\`\n${command}\n\`\`\``)} placeholder="Ask a follow-up…" />
        </Modal>
      )}
    </>
  );
}
