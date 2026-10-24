import { useEffect, useMemo, useRef, useState } from 'react';
import type { AgentEvent, ApprovalRequest, AttachmentInfo, ChatMessage, ProviderStatus, StarterAiStatus, ToolCallRecord } from '@fbrx/shared';
import { NATURAL_PREFIX, addressAs, funEnabled, modelSeesImages } from '@fbrx/shared';
import { Button, Callout, Card, Icons, Modal, Select, Status, TextArea, useAction, useConfirm, type IconName, FbrxMark } from '@fbrx/ui';
import { bridge, call, onEvent } from '../client';
import { useCore, useStarterAi } from '../hooks';
import { Markdown } from '../markdown';
import { POPOUT, navigate, routeArg } from '../app';
import { EmergencyStop, ModelPicker } from '../widgets';
import { useSlashMenu } from '../slash-menu';
import { ActivityPanel, ThinkingNote } from '../agent-activity';
import { NEW_CHAT, foldChat, openedChat, type ChatView } from '../chat-state';
import { StreamReader, prefetchSpeech, say, speakable, stopSpeaking, warmNaturalVoice } from '../voice/voice';
import { acknowledgement } from '../voice/acknowledge';
import { startThinkingSound, stopThinkingSound } from '../voice/thinking-sound';
import { useVoiceChat } from '../voice/use-voice-chat';
import { ModelDownload } from './settings-voice';
import { summonGoose } from '../fun';
import { useLearner, useTier } from '../edition';
import { ChatHistory, type ChatFilter } from '../chat-history';
import { AttachmentTray, CreatedFiles, MessageAttachments, useAttachments } from '../attachments';

const STARTERS: Array<{ icon: IconName; title: string; prompt: string }> = [
  { icon: 'activity', title: 'Check my PC', prompt: 'Give me a quick health check of this computer: performance right now, storage, security status and any recent errors. Tell me what (if anything) needs attention.' },
  { icon: 'tasks', title: 'Plan my day', prompt: 'Look at my open tasks and projects and suggest a realistic plan for today, most important first.' },
  { icon: 'drive', title: 'Free up space', prompt: 'Find out what is using the most space on my drives and in Downloads, and suggest safe things to clean up. Do not delete anything without asking me.' },
  { icon: 'wifi', title: 'Why is my internet slow?', prompt: 'My internet feels slow. Check my connection step by step (router, DNS, latency to the internet) and explain what you find in plain language.' },
  { icon: 'shield', title: 'Is this link safe?', prompt: 'Check whether this link is safe to open: ' },
  { icon: 'bug', title: 'Explain recent crashes', prompt: 'Look at the errors and crashes Windows recorded in the last few days, explain the important ones and suggest fixes.' },
];

/** Copy, edit and run-again under a message (shown on hover). */
function MessageActions({ text, onRerun, onEdit, onSpeak }: { text: string; onRerun?: () => void; onEdit?: () => void; onSpeak?: () => void }) {
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
      {onSpeak && (
        <button className="msg-action" title="Read it aloud" onClick={onSpeak}>
          <Icons.speaker size={13} /> Read aloud
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
      {!!c.files?.length && <CreatedFiles files={c.files} />}
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

const mb = (n: number) => `${Math.round(n / 1024 ** 2)} MB`;

/** The AI getting ready on a new computer (the starter model, downloaded once), or what stopped it. */
function StarterAiCard({ st }: { st: StarterAiStatus | null }) {
  const { run, busy } = useAction();
  if (!st || (st.state !== 'preparing' && st.state !== 'failed')) return null;
  if (st.state === 'failed') {
    return (
      <div className="starter-ai" role="status">
        <b>Your AI is not ready yet</b>
        <span className="fx-secondary">
          {st.modelName} could not be downloaded{st.message ? ` (${st.message})` : ''}. Check the internet connection and try again, or pick another AI under AI models.
        </span>
        <div className="fx-actions" style={{ justifyContent: 'center' }}>
          <Button size="sm" variant="primary" icon="refresh" loading={busy === 'retry'} onClick={() => void run('retry', () => call('ai.prepareStarter'))}>
            Try again
          </Button>
          <Button size="sm" variant="ghost" onClick={() => navigate('runtime')}>
            AI models
          </Button>
        </div>
      </div>
    );
  }
  const pct = st.totalBytes ? Math.min(100, Math.round((st.receivedBytes / st.totalBytes) * 100)) : 0;
  return (
    <div className="starter-ai" role="status">
      <b>Getting your AI ready</b>
      <span className="fx-secondary">
        {st.step === 'runtime'
          ? 'Setting up the part that runs AI on this computer…'
          : st.step === 'model'
            ? `Downloading ${st.modelName}, a small AI that runs right here on this computer (about 1 GB, only once).`
            : 'Starting your AI…'}
      </span>
      {st.step !== 'starting' && (
        <div className="voice-dl" style={{ width: '100%' }}>
          <div className="voice-dl-bar">
            <div style={{ width: `${pct}%` }} />
          </div>
          <span className="fx-muted">{st.totalBytes ? `${mb(st.receivedBytes)} of ${mb(st.totalBytes)}` : `${pct}%`}</span>
        </div>
      )}
      <span className="fx-muted" style={{ fontSize: 12.5 }}>
        You can look around meanwhile; the chat answers as soon as this is done.
      </span>
    </div>
  );
}

const OPEN_CHAT_KEY = 'fbrx.chat.open';

/** The chat that was open when you left the page, so coming back opens it again (in this window). */
function rememberedChat(): string | null {
  try {
    return sessionStorage.getItem(OPEN_CHAT_KEY);
  } catch {
    return null;
  }
}

function rememberChat(id: string | null) {
  try {
    if (id) sessionStorage.setItem(OPEN_CHAT_KEY, id);
    else sessionStorage.removeItem(OPEN_CHAT_KEY);
  } catch {
    /* storage unavailable */
  }
}

export function AgentPage({ agentName }: { agentName: string }) {
  const convs = useCore('ai.conversations.list', undefined, []);
  const providers = useCore('ai.providers', undefined, ['settings.changed', 'runtime.changed', 'policy.changed']);
  const settings = useCore('settings.get', undefined, ['settings.changed']);
  const starter = useStarterAi();
  const tier = useTier();
  // Student computers: just the conversation (the school picks the model; the helper has no internet tools).
  const learner = useLearner();
  const [selected, setSelected] = useState<string | null>(null);
  // Which chats the history shows; a new chat started while a project is shown goes into that project.
  const [chatFilter, setChatFilter] = useState<ChatFilter>('all');
  const filterRef = useRef(chatFilter);
  filterRef.current = chatFilter;
  // The open chat's messages and the agent's live activity in it (chat-state.ts).
  const [chat, setChat] = useState<ChatView>(NEW_CHAT);
  const run = chat.run;
  // A message is on its way (until the chat shows the agent's run for it).
  const [sending, setSending] = useState(false);
  const busy = sending || !!run;
  const busyRef = useRef(busy);
  busyRef.current = busy;
  // Every chat the agent is answering in, to mark them in the history.
  const [busyChats, setBusyChats] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const slash = useSlashMenu({ value: input, setValue: setInput, inputRef: composerRef, scope: 'chat' });
  // Files and pictures for the next message (the paperclip, dropped on the chat, or pasted).
  const files = useAttachments();
  const filesRef = useRef(files);
  filesRef.current = files;
  const picker = useRef<HTMLInputElement>(null);
  const [dropping, setDropping] = useState(false);
  const [providerId, setProviderId] = useState('');
  const [model, setModel] = useState('');
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([]);
  const [offline, setOffline] = useState(true);
  const thread = useRef<HTMLDivElement>(null);
  // The chat on screen (or being opened), for the event handler; set as soon as a chat is picked.
  const shown = useRef<string | null>(null);
  // While a chat opens, its events wait here and fold in on top of what the core answered.
  const opening = useRef<{ id: string; events: AgentEvent[] } | null>(null);
  const { confirm, dialog } = useConfirm();
  const s = settings.data?.settings;
  const showThinking = s?.ai.showThinking ?? true;
  // Voice: replies read aloud as they stream in, and the microphone / hands-free conversation in the composer.
  const voiceRef = useRef(s?.voice);
  voiceRef.current = s?.voice;
  const reader = useRef(new StreamReader(() => voiceRef.current ?? { voiceName: '', wpm: 210, pitch: 1 }));
  const streamText = useRef<{ id: string; text: string }>({ id: '', text: '' });
  const speakRef = useRef(false);
  // A spoken message gets a spoken "I heard you", then a soft thinking sound until the answer starts.
  const thinkingWanted = useRef(false);
  const stopThinking = () => {
    thinkingWanted.current = false;
    stopThinkingSound();
  };
  const nextAck = useRef<string | null>(null);
  const acknowledge = () => {
    const v = voiceRef.current;
    if (!v) return;
    thinkingWanted.current = v.thinkingSound;
    if (v.acknowledge) say(nextAck.current ?? acknowledgement(v.voiceName, addressAs(settings.data?.settings) || null), v);
    nextAck.current = null;
    // The soft thinking sound starts straight away (quietly, under the "I heard you") and stops when the answer does.
    setTimeout(() => thinkingWanted.current && busyRef.current && startThinkingSound(), 300);
  };
  const voice = useVoiceChat({
    settings: s,
    onText: (text, send_) => {
      if (send_ && !busyRef.current) {
        acknowledge();
        void send(text);
      } else setInput((cur) => (cur.trim() ? `${cur.trimEnd()} ${text}` : text));
    },
  });
  useEffect(() => () => stopThinkingSound(), []);
  // While you talk, prepare what it will say when you stop, so a natural voice answers without a pause.
  useEffect(() => {
    const v = voiceRef.current;
    if (voice.state !== 'listening' || !v?.acknowledge) return;
    if (v.voiceName.startsWith(NATURAL_PREFIX)) warmNaturalVoice();
    nextAck.current = acknowledgement(v.voiceName, addressAs(settings.data?.settings) || null);
    prefetchSpeech(nextAck.current, v);
  }, [voice.state]); // eslint-disable-line react-hooks/exhaustive-deps
  speakRef.current = !!s?.voice.readReplies || voice.handsFree;
  const replyFinishedRef = useRef(voice.replyFinished);
  replyFinishedRef.current = voice.replyFinished;
  const toggleReadAloud = () => {
    if (!s) return;
    if (s.voice.readReplies) stopSpeaking();
    void call('settings.update', { patch: { voice: { readReplies: !s.voice.readReplies } } });
  };

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

  /** Opens a chat (null: a new one) with its messages and whatever the agent is doing in it right now. */
  const openChat = async (id: string | null) => {
    setSelected(id);
    shown.current = id;
    rememberChat(id);
    setError(null);
    opening.current = null;
    if (!id) {
      setChat(NEW_CHAT);
      setOffline(defaultOffline);
      return;
    }
    const pending = { id, events: [] as AgentEvent[] };
    opening.current = pending;
    try {
      const c = await call('ai.conversations.get', { id });
      if (opening.current !== pending) return;
      setChat(pending.events.reduce(foldChat, openedChat(c)));
      setOffline(c.offline);
      if (c.providerId) setProviderId(c.providerId);
    } catch {
      // Deleted in the meantime: a new chat instead.
      if (opening.current === pending) void openChat(null);
    } finally {
      if (opening.current === pending) opening.current = null;
    }
  };

  useEffect(() => {
    void call('approvals.list').then(setApprovals);
    const markBusy = (runs: Array<{ conversationId: string }>) => setBusyChats(new Set(runs.map((r) => r.conversationId)));
    void call('ai.runs').then(markBusy);
    const offs = [
      // A run started or ended: the history shows which chats are busy, and the chats in their new order.
      onEvent('agent.runs', (runs) => {
        markBusy(runs);
        convs.reload();
      }),
      onEvent('approval.requested', (r) => setApprovals((a) => [...a, r])),
      onEvent('approval.resolved', (r) => setApprovals((a) => a.filter((x) => x.id !== r.id))),
      onEvent('agent', (e: AgentEvent) => {
        if (e.type === 'mode.changed') {
          if (e.conversationId === shown.current) setOffline(e.offline);
          return;
        }
        const waiting = opening.current;
        if (waiting?.id === e.conversationId) waiting.events.push(e);
        else setChat((v) => (v.conversationId === e.conversationId ? foldChat(v, e) : v));
        if (e.conversationId !== shown.current) return;
        const ended = e.type === 'run.completed' || e.type === 'run.failed' || e.type === 'run.cancelled';
        // The thinking sound stops when the answer starts, when it needs your approval, or when it ends.
        if (e.type === 'message.delta' || (e.type === 'run.progress' && (e.phase === 'writing' || e.phase === 'approval')) || ended) stopThinking();
        if (e.type === 'message.delta') {
          if (streamText.current.id !== e.messageId) {
            streamText.current = { id: e.messageId, text: '' };
            reader.current.reset();
          }
          streamText.current.text += e.delta;
          if (speakRef.current) reader.current.update(streamText.current.text);
        } else if (e.type === 'message.completed') {
          if (speakRef.current && e.message.role === 'assistant') {
            if (streamText.current.id !== e.message.id) reader.current.reset();
            reader.current.finish(e.message.content);
          }
          streamText.current = { id: '', text: '' };
        } else if (e.type === 'run.completed') replyFinishedRef.current();
        else if (e.type === 'run.failed') setError(e.error);
      }),
    ];
    return () => offs.forEach((o) => o());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // New messages glide into view; streamed text follows instantly, and only while you are at the bottom (so
  // scrolling up to read something earlier isn't interrupted).
  const reply = run?.reply ?? null;
  useEffect(() => {
    thread.current?.scrollTo({ top: thread.current.scrollHeight, behavior: 'smooth' });
  }, [chat.messages]);
  useEffect(() => {
    const el = thread.current;
    if (el && reply && el.scrollHeight - el.scrollTop - el.clientHeight < 160) el.scrollTop = el.scrollHeight;
  }, [reply]);

  // Prompts handed over by other pages (sessionStorage) or by Spotlight (#/agent/ask/<text>).
  const sendRef = useRef<(t: string) => void>(() => undefined);
  useEffect(() => {
    const draft = sessionStorage.getItem('fbrx.agentDraft');
    if (draft) {
      sessionStorage.removeItem('fbrx.agentDraft');
      setInput(draft);
    }
    // first: the page has just opened, so with nothing asked for it reopens the chat you left.
    const pick = (first: boolean) => {
      const arg = routeArg();
      // From Projects: show that project's chats.
      if (arg?.startsWith('project/')) {
        setChatFilter(decodeURIComponent(arg.slice(8)));
        navigate('agent');
        void openChat(null);
      } else if (arg?.startsWith('ask/')) {
        const text = decodeURIComponent(arg.slice(4));
        navigate('agent');
        void openChat(null).then(() => setTimeout(() => sendRef.current(text), 50));
      } else if (arg?.startsWith('chat/')) {
        navigate('agent');
        void openChat(decodeURIComponent(arg.slice(5)));
      } else if (first) void openChat(rememberedChat());
    };
    pick(true);
    const onHash = () => pick(false);
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Sends a message: what is in the composer (with what is attached), or a message again with what it had attached. */
  const send = async (text = input, again?: AttachmentInfo[]) => {
    const message = text.trim();
    const pending = filesRef.current;
    const attached = again ?? pending.items.flatMap((i) => (i.info ? [i.info] : []));
    if ((!message && !attached.length) || busyRef.current || (!again && pending.reading)) return;
    setError(null);
    setInput('');
    setSending(true);
    const local: ChatMessage = { id: `local-${Date.now()}`, role: 'user', content: message, createdAt: new Date().toISOString(), ...(attached.length ? { attachments: attached } : {}) };
    setChat((v) => ({ ...v, messages: [...v.messages, local] }));
    if (!again) pending.clear();
    try {
      const r = await call('ai.chat', { conversationId: selected ?? undefined, message, providerId: providerId || undefined, model: model || undefined, offline: selected ? undefined : offline, ...(attached.length ? { attachments: attached.map((a) => a.id) } : {}) });
      // Your wingman shows up in person, too.
      if (/^talk\s+to\s+me,?\s+goose\W*$/i.test(message) && funEnabled(settings.data?.settings, tier)) summonGoose();
      // The chat as it is now, with the agent already at work in it (a new chat gets its id here).
      await openChat(r.conversationId);
      if (!selected) {
        const f = filterRef.current;
        if (f !== 'all' && f !== 'none' && !learner) await call('ai.conversations.setProject', { id: r.conversationId, projectId: f }).catch(() => undefined);
        convs.reload();
      }
    } catch (err) {
      setChat((v) => ({ ...v, messages: v.messages.filter((x) => x.id !== local.id) }));
      setInput(message);
      // What was attached stays attached, to send again.
      if (!again) pending.restore(attached);
      setError((err as Error).message);
    } finally {
      setSending(false);
    }
  };

  sendRef.current = (t: string) => void send(t);
  const visible = useMemo(() => chat.messages.filter((m) => m.role === 'user' || m.role === 'assistant'), [chat.messages]);
  const usable = (providers.data ?? []).filter((p) => p.enabled && !p.blockedByPolicy);
  const currentProvider = usable.find((p) => p.id === providerId) as ProviderStatus | undefined;
  const currentModel = model || (currentProvider?.id === s?.ai.defaultProvider && s?.ai.defaultModel) || currentProvider?.defaultModel || '';
  const blindToImages = !!currentProvider && files.items.some((i) => i.kind === 'image') && !modelSeesImages(currentProvider.type, currentModel);

  return (
    <div className="agent">
      <Card
        className="agent-list"
        title="Conversations"
        actions={
          <>
            {bridge.popOut && !POPOUT && <Button size="sm" variant="ghost" icon="external" aria-label="Open the chat in its own window" title="Open the chat in its own window, to keep it beside your work" onClick={() => void bridge.popOut?.(selected ? `agent/chat/${encodeURIComponent(selected)}` : 'agent')} />}
            <Button size="sm" icon="plus" onClick={() => void openChat(null)} aria-label="New conversation" />
          </>
        }
        flush
      >
        <ChatHistory
          chats={convs.data ?? []}
          reload={convs.reload}
          selected={selected}
          busy={busyChats}
          learner={learner}
          filter={chatFilter}
          setFilter={setChatFilter}
          onOpen={(id) => void openChat(id)}
        />
        {!learner && (
          <div className="agent-list-foot">
            <EmergencyStop compact />
          </div>
        )}
      </Card>
      <Card className="agent-main" flush>
        <div
          className={`agent-drop${dropping ? ' on' : ''}`}
          onDragOver={(e) => {
            if (!e.dataTransfer.types.includes('Files')) return;
            e.preventDefault();
            setDropping(true);
          }}
          onDragLeave={(e) => e.currentTarget.contains(e.relatedTarget as Node) || setDropping(false)}
          onDrop={(e) => {
            if (!e.dataTransfer.files.length) return;
            e.preventDefault();
            setDropping(false);
            files.add(e.dataTransfer.files);
          }}
        >
        {dropping && (
          <div className="agent-drop-hint">
            <Icons.paperclip size={22} /> Drop to attach for {agentName}
          </div>
        )}
        <div className="agent-thread" ref={thread} aria-live="polite">
          {!!visible.length && <StarterAiCard st={starter} />}
          {!visible.length && !reply && (
            <div className="msg" style={{ marginTop: '8vh', alignItems: 'center', textAlign: 'center' }}>
              <FbrxMark className="fx-brand-mark" size={48} />
              <h2>
                Hi{addressAs(settings.data?.settings) ? ` ${addressAs(settings.data?.settings)}` : ''}, I'm {agentName}. What should we do?
              </h2>
              <StarterAiCard st={starter} />
              <p className="fx-secondary" style={{ maxWidth: 560 }}>
                I work with your computer. Ask me anything! Every action can be checked and governed within the FBRX app.
                {offline ? ' Chats start offline, I will ask before using the internet.' : ' This chat is online: I may use internet tools.'} Let’s start with something simple:
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
                {!!m.attachments?.length && <MessageAttachments files={m.attachments} />}
                {m.content && <UserMessage text={m.content} />}
                <MessageActions text={m.content} onEdit={() => setInput(m.content)} onRerun={busy ? undefined : () => void send(m.content, m.attachments ?? [])} />
              </div>
            ) : (
              <div key={m.id} className="msg">
                {showThinking && m.thinking && <ThinkingNote text={m.thinking} agentName={agentName} />}
                {m.content && <Markdown text={m.content} />}
                {(m.toolCalls ?? []).map((c) => (
                  <ToolCard key={c.id} c={c} approval={approvals.find((a) => a.runId === run?.runId && a.tool === c.name)} />
                ))}
                <div className="msg-meta">
                  {m.model && <span>{m.model}</span>}
                  {m.content && <MessageActions text={m.content} onSpeak={() => (stopSpeaking(), s && say(speakable(m.content), s.voice))} />}
                </div>
              </div>
            ),
          )}
          {reply && (
            <div className="msg">
              <Markdown text={reply.text} />
            </div>
          )}
          {run && (
            <div className="msg">
              <ActivityPanel activity={run} agentName={agentName} showThinking={showThinking} />
            </div>
          )}
          {sending && !run && (
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
          {slash.menu}
          {voice.error && (
            <div className="voice-error">
              <Icons.mic size={14} />
              <span>{voice.error}</span>
              <button aria-label="Dismiss" onClick={() => voice.setError(null)}>
                <Icons.x size={13} />
              </button>
            </div>
          )}
          {voice.state !== 'idle' && (
            <div className={`voice-live ${voice.state}`}>
              <span className="voice-live-dot" style={{ transform: `scale(${1 + voice.level * 1.6})` }} />
              {voice.state === 'listening'
                ? voice.handsFree
                  ? 'Listening… just talk; I stop when you pause.'
                  : 'Listening… click the microphone (or pause) when you are done.'
                : 'Writing down what you said…'}
              {voice.state === 'listening' && (
                <button className="voice-live-cancel" onClick={voice.cancel}>
                  Cancel
                </button>
              )}
            </div>
          )}
          <AttachmentTray items={files.items} onRemove={files.remove} />
          {blindToImages && (
            <div className="attach-warn">
              <Icons.eyeOff size={13} /> {currentModel || currentProvider?.name} can’t see pictures: {agentName} gets their names only. Pick a model that can see (a cloud model, or one with “vision” or “vl” in its name).
            </div>
          )}
          <TextArea
            ref={composerRef}
            value={input}
            onPaste={(e) => {
              if (!e.clipboardData.files.length) return;
              e.preventDefault();
              files.add(e.clipboardData.files);
            }}
            placeholder={busy ? `${agentName} is working…` : learner ? `Ask ${agentName} a question — Enter to send` : `Ask ${agentName} to do something — Enter to send, Shift+Enter for a new line, / for snippets`}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (slash.onKeyDown(e)) return;
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            rows={2}
            aria-label="Message"
          />
          <div className="composer-bar">
            {learner ? <div className="composer-opts" /> : <div className="composer-opts">
              <div className="seg" role="group" aria-label="Internet access for this chat">
                <button className={offline ? 'on' : ''} onClick={() => void toggleOffline(true)} title={`Offline: ${agentName} asks before using the internet in this chat`}>
                  <Icons.offline size={14} /> Offline
                </button>
                <button className={!offline ? 'on' : ''} onClick={() => void toggleOffline(false)} title={`Online: ${agentName} may use internet tools in this chat`}>
                  <Icons.globe size={14} /> Online
                </button>
              </div>
              <div className="composer-provider">
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
                <div className="composer-model">
                  <ModelPicker
                    providerId={currentProvider.id}
                    value={model}
                    onChange={setModel}
                    defaultLabel={`Default: ${(currentProvider.id === settings.data?.settings.ai.defaultProvider && settings.data.settings.ai.defaultModel) || currentProvider.defaultModel || 'automatic'}`}
                  />
                </div>
              )}
              {currentProvider && !currentProvider.available && <span className="fx-muted" style={{ fontSize: 12 }}>{currentProvider.message}</span>}
            </div>}
            <div className="composer-actions">
              {selected && !busy && (
                <Button
                  size="sm"
                  variant="ghost"
                  icon="trash"
                  aria-label="Delete conversation"
                  onClick={async () => {
                    if (await confirm({ title: 'Delete this conversation?', danger: true, confirmLabel: 'Delete' })) {
                      await call('ai.conversations.delete', { id: selected });
                      void openChat(null);
                      convs.reload();
                    }
                  }}
                />
              )}
              <input
                ref={picker}
                type="file"
                multiple
                hidden
                onChange={(e) => {
                  if (e.target.files) files.add(e.target.files);
                  e.target.value = '';
                }}
              />
              <button className="voice-btn" title={files.full ? 'That is as many files as one message takes' : 'Attach files or pictures (or drop them on the chat, or paste)'} aria-label="Attach files" disabled={files.full} onClick={() => picker.current?.click()}>
                <Icons.paperclip size={16} />
              </button>
              <div className="voice-buttons" role="group" aria-label="Voice">
                <button
                  className={`voice-btn${s?.voice.readReplies || voice.handsFree ? ' on' : ''}`}
                  title={s?.voice.readReplies ? 'Replies are read aloud (click to stop)' : 'Read replies aloud'}
                  aria-pressed={!!s?.voice.readReplies}
                  onClick={toggleReadAloud}
                >
                  {s?.voice.readReplies || voice.handsFree ? <Icons.speaker size={16} /> : <Icons.speakerOff size={16} />}
                </button>
                <button className={`voice-btn${voice.handsFree ? ' on live' : ''}`} title={voice.handsFree ? 'Hands-free conversation is on (click to end)' : 'Hands-free conversation: talk, listen, repeat'} aria-pressed={voice.handsFree} onClick={voice.toggleHandsFree}>
                  <Icons.headset size={16} />
                </button>
                <button
                  className={`voice-btn mic${voice.state === 'listening' ? ' on live' : ''}`}
                  title={voice.state === 'listening' ? 'Stop and write it down' : `Talk to ${agentName}`}
                  aria-label={voice.state === 'listening' ? 'Stop listening' : 'Speak'}
                  disabled={voice.state === 'transcribing'}
                  onClick={voice.toggle}
                >
                  <Icons.mic size={17} />
                </button>
              </div>
              {run ? (
                <Button
                  icon="stop"
                  onClick={() => {
                    stopSpeaking();
                    stopThinking();
                    void call('ai.cancel', { runId: run.runId });
                  }}
                >
                  Stop
                </Button>
              ) : (
                <Button variant="primary" icon="send" disabled={(!input.trim() && !files.ids.length) || files.reading} title={files.reading ? 'Reading the attached files…' : undefined} onClick={() => void send()}>
                  Send
                </Button>
              )}
            </div>
          </div>
        </div>
        </div>
      </Card>
      {voice.needsModel && (
        <Modal
          title="Voice needs a one-time download"
          description={`${agentName} turns speech into text on this computer with Whisper (${voice.needsModel.name.toLowerCase()}, ${voice.needsModel.sizeMB} MB). It is downloaded once and nothing you say leaves the computer.`}
          onClose={() => voice.setNeedsModel(null)}
          footer={
            <>
              <Button variant="ghost" onClick={() => navigate('settings/voice')}>
                Voice settings
              </Button>
              <Button onClick={() => voice.setNeedsModel(null)}>Close</Button>
            </>
          }
        >
          <div className="voice-setup">
            <ModelDownload
              model={voice.needsModel}
              onDone={() => {
                voice.setNeedsModel(null);
                void voice.start();
              }}
            />
          </div>
        </Modal>
      )}
      {dialog}
    </div>
  );
}
