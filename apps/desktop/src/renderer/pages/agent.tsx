import { useEffect, useMemo, useRef, useState } from 'react';
import type { AgentEvent, ApprovalRequest, ChatMessage, ProviderStatus, ToolCallRecord } from '@fbrx/shared';
import { Button, Callout, Card, Icons, Select, Status, TextArea, timeAgo, useAction, useConfirm } from '@fbrx/ui';
import { call, onEvent } from '../client';
import { useCore } from '../hooks';
import { Markdown } from '../markdown';
import { navigate } from '../app';

const SUGGESTIONS = [
  'What is using the most disk space in my Downloads folder?',
  'Summarise the health of this workstation and FBRX OS services.',
  'Create a weekly-report.md in my workspace with a template for status updates.',
  'Remember that our quarterly reports are due on the 5th of each quarter.',
];

function toolTone(s: ToolCallRecord['status']) {
  return s === 'succeeded' ? 'good' : s === 'failed' ? 'critical' : s === 'denied' ? 'serious' : s === 'awaiting-approval' ? 'warning' : s === 'running' ? 'busy' : 'neutral';
}

function ToolCard({ c, approval }: { c: ToolCallRecord; approval: ApprovalRequest | undefined }) {
  const [open, setOpen] = useState(c.status === 'awaiting-approval' || c.status === 'failed' || c.status === 'denied');
  const { run, busy } = useAction();
  useEffect(() => {
    if (c.status === 'awaiting-approval') setOpen(true);
  }, [c.status]);
  return (
    <div className="toolcall">
      <div className="toolcall-head" onClick={() => setOpen(!open)} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && setOpen(!open)} aria-expanded={open}>
        {open ? <Icons.chevronDown size={14} /> : <Icons.chevronRight size={14} />}
        <Icons.wrench size={14} />
        <span className="mono" style={{ flex: 1 }}>
          {c.name}
        </span>
        {c.durationMs !== undefined && <span className="fx-muted" style={{ fontSize: 12 }}>{c.durationMs} ms</span>}
        <Status tone={toolTone(c.status)}>{c.status.replace('-', ' ')}</Status>
      </div>
      {open && (
        <div className="toolcall-body">
          <div>
            <div className="fx-label">Input</div>
            <pre className="fx-code" style={{ maxHeight: 180 }}>{JSON.stringify(c.input, null, 2)}</pre>
          </div>
          {c.findings?.length ? (
            <Callout tone={c.findings.some((f) => f.severity === 'critical') ? 'critical' : 'warning'} title="Guardian findings">
              {c.findings.map((f) => f.message).join(' · ')}
            </Callout>
          ) : null}
          {c.output && (
            <div>
              <div className="fx-label">Result</div>
              <pre className="fx-code" style={{ maxHeight: 260 }}>{c.output}</pre>
            </div>
          )}
        </div>
      )}
      {c.status === 'awaiting-approval' && approval && (
        <div className="toolcall-approval">
          <Icons.shield size={16} style={{ color: 'var(--warning)' }} />
          <span style={{ flex: 1 }}>{approval.reason}</span>
          <Button size="sm" variant="danger" loading={busy === 'deny'} onClick={() => void run('deny', () => call('approvals.resolve', { id: approval.id, decision: 'deny' }))}>
            Deny
          </Button>
          <Button size="sm" loading={busy === 'always'} onClick={() => void run('always', () => call('approvals.resolve', { id: approval.id, decision: 'approve', remember: true }))}>
            Always allow
          </Button>
          <Button size="sm" variant="primary" loading={busy === 'approve'} onClick={() => void run('approve', () => call('approvals.resolve', { id: approval.id, decision: 'approve' }))}>
            Approve
          </Button>
        </div>
      )}
    </div>
  );
}

export function AgentPage() {
  const convs = useCore('ai.conversations.list', undefined, []);
  const providers = useCore('ai.providers', undefined, ['settings.changed', 'runtime.changed', 'policy.changed']);
  const settings = useCore('settings.get', undefined, ['settings.changed']);
  const [selected, setSelected] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streaming, setStreaming] = useState<{ messageId: string; text: string } | null>(null);
  const [activeRun, setActiveRun] = useState<{ runId: string; conversationId: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [providerId, setProviderId] = useState('');
  const [model, setModel] = useState('');
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([]);
  const thread = useRef<HTMLDivElement>(null);
  const runRef = useRef(activeRun);
  runRef.current = activeRun;
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  // Events can arrive before ai.chat's reply; adopt the run while a send is in flight.
  const sending = useRef(false);
  const activeRunDone = useRef(new Set<string>());
  const { confirm, dialog } = useConfirm();

  useEffect(() => {
    if (settings.data && !providerId) setProviderId(settings.data.settings.ai.defaultProvider);
  }, [settings.data, providerId]);

  const loadConversation = async (id: string | null) => {
    setSelected(id);
    setStreaming(null);
    setError(null);
    if (!id) return setMessages([]);
    const c = await call('ai.conversations.get', { id });
    setMessages(c.messages);
    if (c.providerId) setProviderId(c.providerId);
  };

  useEffect(() => {
    void call('approvals.list').then(setApprovals);
    const offs = [
      onEvent('approval.requested', (r) => setApprovals((a) => [...a, r])),
      onEvent('approval.resolved', (r) => setApprovals((a) => a.filter((x) => x.id !== r.id))),
      onEvent('agent', (e: AgentEvent) => {
        if (sending.current && !runRef.current) {
          runRef.current = { runId: e.runId, conversationId: e.conversationId };
          setActiveRun(runRef.current);
        }
        const mine = runRef.current?.runId === e.runId || e.conversationId === selectedRef.current;
        if (!mine) {
          if (e.type === 'run.completed' || e.type === 'run.failed') convs.reload();
          return;
        }
        switch (e.type) {
          case 'run.started':
            setActiveRun({ runId: e.runId, conversationId: e.conversationId });
            break;
          case 'message.delta':
            setStreaming((s) => (s && s.messageId === e.messageId ? { ...s, text: s.text + e.delta } : { messageId: e.messageId, text: e.delta }));
            break;
          case 'message.completed':
            setStreaming(null);
            setMessages((m) => [...m.filter((x) => x.id !== e.message.id), e.message]);
            break;
          case 'tool.updated':
            setMessages((m) => m.map((x) => (x.id === e.messageId ? { ...x, toolCalls: (x.toolCalls ?? []).map((c) => (c.id === e.call.id ? e.call : c)) } : x)));
            break;
          case 'run.completed':
          case 'run.cancelled':
            activeRunDone.current.add(e.runId);
            setActiveRun(null);
            setStreaming(null);
            convs.reload();
            break;
          case 'run.failed':
            activeRunDone.current.add(e.runId);
            setActiveRun(null);
            setStreaming(null);
            setError(e.error);
            convs.reload();
            break;
        }
      }),
    ];
    return () => offs.forEach((o) => o());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    thread.current?.scrollTo({ top: thread.current.scrollHeight, behavior: 'smooth' });
  }, [messages, streaming]);

  const send = async (text = input) => {
    const message = text.trim();
    if (!message || activeRun) return;
    setError(null);
    setInput('');
    const optimistic: ChatMessage = { id: `local-${Date.now()}`, role: 'user', content: message, createdAt: new Date().toISOString() };
    setMessages((m) => [...m, optimistic]);
    sending.current = true;
    try {
      const r = await call('ai.chat', { conversationId: selected ?? undefined, message, providerId: providerId || undefined, model: model || undefined });
      // A fast run may already have finished before this reply arrived.
      if (!activeRunDone.current.has(r.runId)) setActiveRun(r);
      if (!selected) {
        setSelected(r.conversationId);
        convs.reload();
      }
    } catch (err) {
      setMessages((m) => m.filter((x) => x.id !== optimistic.id));
      setInput(message);
      setError((err as Error).message);
    } finally {
      sending.current = false;
    }
  };

  const visible = useMemo(() => messages.filter((m) => m.role === 'user' || m.role === 'assistant'), [messages]);
  const usable = (providers.data ?? []).filter((p) => p.enabled && !p.blockedByPolicy);
  const currentProvider = usable.find((p) => p.id === providerId) as ProviderStatus | undefined;

  return (
    <div className="agent">
      <Card className="agent-list" title="Conversations" actions={<Button size="sm" icon="plus" onClick={() => void loadConversation(null)} aria-label="New conversation" />} flush>
        <div className="agent-list-items">
          {(convs.data ?? []).map((c) => (
            <button key={c.id} className={`agent-conv${selected === c.id ? ' active' : ''}`} onClick={() => void loadConversation(c.id)}>
              <div className="agent-conv-title">{c.title}</div>
              <div className="agent-conv-sub">
                {timeAgo(c.updatedAt)} · {c.messageCount} messages{c.origin === 'remote' ? ' · remote' : ''}
              </div>
            </button>
          ))}
          {!convs.data?.length && <div className="fx-muted" style={{ padding: 12, fontSize: 13 }}>No conversations yet.</div>}
        </div>
      </Card>
      <Card className="agent-main" flush>
        <div className="agent-thread" ref={thread} aria-live="polite">
          {!visible.length && !streaming && (
            <div className="msg" style={{ marginTop: '8vh', alignItems: 'center', textAlign: 'center' }}>
              <div className="fx-brand-mark" style={{ width: 44, height: 44, fontSize: 16 }}>FX</div>
              <h2>What should FBRX do?</h2>
              <p className="fx-secondary" style={{ maxWidth: 520 }}>
                The agent works with your files, apps and connected systems. Every action is checked by your governance policy, and anything that changes something waits for your approval.
              </p>
              <div className="choice-grid" style={{ width: '100%', marginTop: 8 }}>
                {SUGGESTIONS.map((s) => (
                  <button key={s} className="choice" onClick={() => void send(s)}>
                    <span style={{ fontSize: 13 }}>{s}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
          {visible.map((m) =>
            m.role === 'user' ? (
              <div key={m.id} className="msg">
                <div className="msg-user">{m.content}</div>
              </div>
            ) : (
              <div key={m.id} className="msg">
                {m.content && <Markdown text={m.content} />}
                {(m.toolCalls ?? []).map((c) => (
                  <ToolCard key={c.id} c={c} approval={approvals.find((a) => a.runId === activeRun?.runId && a.tool === c.name)} />
                ))}
                {m.model && <div className="msg-meta">{m.model}</div>}
              </div>
            ),
          )}
          {streaming && (
            <div className="msg">
              <Markdown text={streaming.text} />
            </div>
          )}
          {activeRun && !streaming && (
            <div className="msg">
              <span className="typing" aria-label="Agent is working">
                <span />
                <span />
                <span />
              </span>
            </div>
          )}
          {error && (
            <div className="msg">
              <Callout tone="critical" title="The agent could not finish" actions={error.includes('runtime') || error.includes('model') || error.includes('API key') ? <Button size="sm" onClick={() => navigate('runtime')}>AI models</Button> : undefined}>
                {error}
              </Callout>
            </div>
          )}
        </div>
        <div className="composer">
          <TextArea
            value={input}
            placeholder={activeRun ? 'The agent is working…' : 'Ask FBRX to do something — Enter to send, Shift+Enter for a new line'}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            rows={2}
            aria-label="Message"
          />
          <div className="composer-bar">
            <div style={{ width: 200 }}>
              <Select aria-label="AI provider" value={providerId} onChange={(e) => setProviderId(e.target.value)} options={usable.map((p) => ({ value: p.id, label: `${p.name}${p.available ? '' : ' (unavailable)'}` }))} />
            </div>
            {currentProvider && currentProvider.type !== 'local-runtime' && (
              <div style={{ width: 200 }}>
                <input className="fx-input" aria-label="Model" placeholder={currentProvider.defaultModel ?? (settings.data?.settings.ai.defaultModel || 'model')} value={model} onChange={(e) => setModel(e.target.value)} />
              </div>
            )}
            {currentProvider && !currentProvider.available && <span className="fx-muted" style={{ fontSize: 12 }}>{currentProvider.message}</span>}
            <span className="fx-spacer" />
            {selected && !activeRun && (
              <Button
                size="sm"
                variant="ghost"
                icon="trash"
                aria-label="Delete conversation"
                onClick={async () => {
                  if (await confirm({ title: 'Delete this conversation?', danger: true, confirmLabel: 'Delete' })) {
                    await call('ai.conversations.delete', { id: selected });
                    void loadConversation(null);
                    convs.reload();
                  }
                }}
              />
            )}
            {activeRun ? (
              <Button icon="stop" onClick={() => void call('ai.cancel', { runId: activeRun.runId })}>
                Stop
              </Button>
            ) : (
              <Button variant="primary" icon="send" disabled={!input.trim()} onClick={() => void send()}>
                Send
              </Button>
            )}
          </div>
        </div>
      </Card>
      {dialog}
    </div>
  );
}
