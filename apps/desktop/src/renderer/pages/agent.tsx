import { useEffect, useMemo, useRef, useState } from 'react';
import type { AgentEvent, ApprovalRequest, ChatMessage, ProviderStatus, ToolCallRecord } from '@fbrx/shared';
import { Button, Callout, Card, Icons, Select, Status, TextArea, timeAgo, useAction, useConfirm, type IconName, FbrxMark } from '@fbrx/ui';
import { call, onEvent } from '../client';
import { useCore } from '../hooks';
import { Markdown } from '../markdown';
import { navigate, routeArg } from '../app';
import { ModelPicker } from '../widgets';

const STARTERS: Array<{ icon: IconName; title: string; prompt: string }> = [
  { icon: 'activity', title: 'Check my PC', prompt: 'Give me a quick health check of this computer: performance right now, storage, security status and any recent errors. Tell me what (if anything) needs attention.' },
  { icon: 'tasks', title: 'Plan my day', prompt: 'Look at my open tasks and projects and suggest a realistic plan for today, most important first.' },
  { icon: 'drive', title: 'Free up space', prompt: 'Find out what is using the most space on my drives and in Downloads, and suggest safe things to clean up. Do not delete anything without asking me.' },
  { icon: 'wifi', title: 'Why is my internet slow?', prompt: 'My internet feels slow. Check my connection step by step (router, DNS, latency to the internet) and explain what you find in plain language.' },
  { icon: 'shield', title: 'Is this link safe?', prompt: 'Check whether this link is safe to open: ' },
  { icon: 'bug', title: 'Explain recent crashes', prompt: 'Look at the errors and crashes Windows recorded in the last few days, explain the important ones and suggest fixes.' },
];

/** Copy, edit and run-again under a message (shown on hover). */
function MessageActions({ text, onRerun, onEdit }: { text: string; onRerun?: () => void; onEdit?: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="msg-actions">
      <button
        className="msg-action"
        title="Copy"
        onClick={() =>
          void navigator.clipboard.writeText(text).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1400);
          })
        }
      >
        {copied ? <Icons.check size={13} /> : <Icons.copy size={13} />} {copied ? 'Copied' : 'Copy'}
      </button>
      {onEdit && (
        <button className="msg-action" title="Put it back in the message box to change it" onClick={onEdit}>
          <Icons.edit size={13} /> Edit
        </button>
      )}
      {onRerun && (
        <button className="msg-action" title="Send it again" onClick={onRerun}>
          <Icons.refresh size={13} /> Run again
        </button>
      )}
    </div>
  );
}

/** A message you sent. Long ones (pasted logs, tables) fold, and text with columns keeps its alignment. */
function UserMessage({ text }: { text: string }) {
  const lines = text.split('\n');
  const long = lines.length > 14 || text.length > 1600;
  const [open, setOpen] = useState(false);
  const tabular = /\t| {3,}/.test(text) && lines.length > 2;
  const shown = long && !open ? `${lines.slice(0, 12).join('\n').slice(0, 1400)}…` : text;
  return (
    <div className={`msg-user${tabular ? ' tabular' : ''}`}>
      {shown}
      {long && (
        <button className="msg-more" onClick={() => setOpen(!open)}>
          {open ? 'Show less' : `Show all ${lines.length} lines`}
        </button>
      )}
    </div>
  );
}

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

export function AgentPage({ agentName }: { agentName: string }) {
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
  const [offline, setOffline] = useState(true);
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
  const defaultOffline = settings.data?.settings.ai.newChatsOffline ?? true;
  useEffect(() => {
    if (!selected) setOffline(defaultOffline);
  }, [defaultOffline, selected]);

  const toggleOffline = async (next: boolean) => {
    setOffline(next);
    if (selected) await call('ai.conversations.setOffline', { id: selected, offline: next }).catch(() => setOffline(!next));
  };

  const loadConversation = async (id: string | null) => {
    setSelected(id);
    setStreaming(null);
    setError(null);
    if (!id) {
      setOffline(defaultOffline);
      return setMessages([]);
    }
    const c = await call('ai.conversations.get', { id });
    setMessages(c.messages);
    setOffline(c.offline);
    if (c.providerId) setProviderId(c.providerId);
  };

  useEffect(() => {
    void call('approvals.list').then(setApprovals);
    const offs = [
      onEvent('approval.requested', (r) => setApprovals((a) => [...a, r])),
      onEvent('approval.resolved', (r) => setApprovals((a) => a.filter((x) => x.id !== r.id))),
      onEvent('agent', (e: AgentEvent) => {
        if (e.type === 'mode.changed') {
          if (e.conversationId === selectedRef.current) setOffline(e.offline);
          return;
        }
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

  // Prompts handed over by other pages (sessionStorage) or by Spotlight (#/agent/ask/<text>).
  const sendRef = useRef<(t: string) => void>(() => undefined);
  useEffect(() => {
    const draft = sessionStorage.getItem('fbrx.agentDraft');
    if (draft) {
      sessionStorage.removeItem('fbrx.agentDraft');
      setInput(draft);
    }
    const pick = () => {
      const arg = routeArg();
      if (arg?.startsWith('ask/')) {
        const text = decodeURIComponent(arg.slice(4));
        navigate('agent');
        void loadConversation(null).then(() => setTimeout(() => sendRef.current(text), 50));
      }
    };
    pick();
    window.addEventListener('hashchange', pick);
    return () => window.removeEventListener('hashchange', pick);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const send = async (text = input) => {
    const message = text.trim();
    if (!message || activeRun) return;
    setError(null);
    setInput('');
    const optimistic: ChatMessage = { id: `local-${Date.now()}`, role: 'user', content: message, createdAt: new Date().toISOString() };
    setMessages((m) => [...m, optimistic]);
    sending.current = true;
    try {
      const r = await call('ai.chat', { conversationId: selected ?? undefined, message, providerId: providerId || undefined, model: model || undefined, offline: selected ? undefined : offline });
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

  sendRef.current = (t: string) => void send(t);
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
              <FbrxMark className="fx-brand-mark" size={48} />
              <h2>Hi, I'm {agentName}. What should we do?</h2>
              <p className="fx-secondary" style={{ maxWidth: 560 }}>
                I work with your files, apps, PC and network. Every action is checked by your governance policy, and anything that changes something waits for your approval.
                {offline ? ' This chat is offline: I will ask before using the internet.' : ' This chat is online: I may use internet tools.'}
              </p>
              <div className="choice-grid" style={{ width: '100%', marginTop: 8 }}>
                {STARTERS.map((st) => {
                  const Ico = Icons[st.icon];
                  return (
                    <button
                      key={st.title}
                      className="choice"
                      onClick={() => {
                        if (st.prompt.endsWith(': ')) setInput(st.prompt);
                        else void send(st.prompt);
                      }}
                    >
                      <span style={{ display: 'flex', gap: 8, alignItems: 'center', fontWeight: 600 }}>
                        <Ico size={16} style={{ color: 'var(--accent)' }} />
                        {st.title}
                      </span>
                      <span className="fx-muted" style={{ fontSize: 12.5 }}>
                        {st.prompt.length > 90 ? `${st.prompt.slice(0, 90)}…` : st.prompt}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
          {visible.map((m) =>
            m.role === 'user' ? (
              <div key={m.id} className="msg msg-mine">
                <UserMessage text={m.content} />
                <MessageActions text={m.content} onEdit={() => setInput(m.content)} onRerun={activeRun ? undefined : () => void send(m.content)} />
              </div>
            ) : (
              <div key={m.id} className="msg">
                {m.content && <Markdown text={m.content} />}
                {(m.toolCalls ?? []).map((c) => (
                  <ToolCard key={c.id} c={c} approval={approvals.find((a) => a.runId === activeRun?.runId && a.tool === c.name)} />
                ))}
                <div className="msg-meta">
                  {m.model && <span>{m.model}</span>}
                  {m.content && <MessageActions text={m.content} />}
                </div>
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
              <Callout tone="critical" title={`${agentName} could not finish`} actions={error.includes('runtime') || error.includes('model') || error.includes('API key') ? <Button size="sm" onClick={() => navigate('runtime')}>AI models</Button> : undefined}>
                {error}
              </Callout>
            </div>
          )}
        </div>
        <div className="composer">
          <TextArea
            value={input}
            placeholder={activeRun ? `${agentName} is working…` : `Ask ${agentName} to do something — Enter to send, Shift+Enter for a new line`}
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
            <div className="seg" role="group" aria-label="Internet access for this chat">
              <button className={offline ? 'on' : ''} onClick={() => void toggleOffline(true)} title={`Offline: ${agentName} asks before using the internet in this chat`}>
                <Icons.offline size={14} /> Offline
              </button>
              <button className={!offline ? 'on' : ''} onClick={() => void toggleOffline(false)} title={`Online: ${agentName} may use internet tools in this chat`}>
                <Icons.globe size={14} /> Online
              </button>
            </div>
            <div style={{ width: 190 }}>
              <Select
                aria-label="AI provider"
                value={providerId}
                onChange={(e) => {
                  setProviderId(e.target.value);
                  setModel('');
                }}
                options={usable.map((p) => ({ value: p.id, label: `${p.name}${p.available ? '' : ' (unavailable)'}` }))}
              />
            </div>
            {currentProvider && currentProvider.type !== 'local-runtime' && (
              <div style={{ width: 260 }}>
                <ModelPicker
                  providerId={currentProvider.id}
                  value={model}
                  onChange={setModel}
                  defaultLabel={`Default: ${(currentProvider.id === settings.data?.settings.ai.defaultProvider && settings.data.settings.ai.defaultModel) || currentProvider.defaultModel || 'automatic'}`}
                />
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
