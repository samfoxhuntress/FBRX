import { useEffect, useRef, useState } from 'react';
import type { ApprovalRequest, AttachmentInfo, ChatMessage, ConversationSummary, OpenConversation, StarterAiStatus, ToolCallRecord } from '@fbrx/shared';
import {
  AttachmentTray,
  Button,
  Callout,
  Card,
  CopyText,
  CreatedFiles,
  Empty,
  Markdown,
  MessageAttachments,
  Page,
  Spinner,
  Status,
  TextArea,
  Toggle,
  downloadFile,
  formatBytes,
  timeAgo,
  useAction,
  useAttachments,
  useConfirm,
  type PictureData,
  type StatusTone,
} from '@fbrx/ui';
import { coreCall, useCore, type CoreState } from '../core';
import { useApp, usePoll, useRoute } from '../state';

const TOOL_STATUS: Record<ToolCallRecord['status'], { tone: StatusTone; word: string }> = {
  pending: { tone: 'neutral', word: 'about to run' },
  'awaiting-approval': { tone: 'warning', word: 'waiting for a yes' },
  running: { tone: 'busy', word: 'running' },
  succeeded: { tone: 'good', word: 'done' },
  failed: { tone: 'critical', word: 'failed' },
  denied: { tone: 'neutral', word: 'not allowed' },
};
const STEP_WORDS: Record<NonNullable<StarterAiStatus['step']>, string> = { runtime: 'Downloading the AI runtime', model: 'Downloading', starting: 'Starting' };

// Files for a chat go to the server's core, which reads them; what it makes stays on the server and comes here to be
// shown or downloaded.
const ATTACHMENTS = { add: (p: { name: string; data: string; mime?: string }) => coreCall<AttachmentInfo>('ai.attachments.add', p), remove: (id: string) => coreCall('ai.attachments.remove', { id }) };
const readAttachment = (id: string) => coreCall<PictureData>('ai.attachments.read', { id });
const previewFile = (path: string) => coreCall<PictureData>('ai.files.preview', { path });
const download = async (path: string) => downloadFile(await coreCall<{ name: string; mime: string; data: string }>('ai.files.read', { path }));

/** Downloads a file from the server: one Fabrix made, or one attached to a chat. */
function DownloadButton({ path, name }: { path: string; name: string }) {
  const { run, busy } = useAction();
  return (
    <Button size="sm" variant="ghost" icon="download" loading={busy === 'dl'} aria-label={`Download ${name}`} onClick={() => void run('dl', () => download(path))}>
      Download
    </Button>
  );
}

/** Things to ask a server's AI, for an empty chat. */
const IDEAS = ['How is this server doing? Memory, disks and load.', 'Which virtual machines are running, and how much do they use?', 'What filled the disk lately?', 'Explain the last errors in the system log.'];

/** The server's AI getting itself ready (it picks the best model the server runs well, on the ai role's first start). */
function Readiness({ name }: { name: string }) {
  const app = useApp();
  const [ms, setMs] = useState(30000);
  const starter = useCore<StarterAiStatus>('ai.starter', ms);
  const { run, busy } = useAction();
  const s = starter.data;
  useEffect(() => setMs(s?.state === 'preparing' ? 2000 : 30000), [s?.state]);
  if (!s || s.state === 'ready' || s.state === 'not-needed') return null;
  if (s.state === 'preparing')
    return (
      <Callout tone="info" title={`Getting ${name} ready`}>
        {s.step ? STEP_WORDS[s.step] : 'Preparing'} {s.step === 'model' ? s.modelName : ''}
        {s.totalBytes > 0 && s.step !== 'starting' ? ` · ${formatBytes(s.receivedBytes)} of ${formatBytes(s.totalBytes)}` : ''}. It picked the best model this server runs well; chats work once it is ready.
        {s.totalBytes > 0 && <progress className="vt-chat-progress" value={s.receivedBytes} max={s.totalBytes} />}
      </Callout>
    );
  return (
    <Callout tone={s.state === 'failed' ? 'warning' : 'info'} title={s.state === 'failed' ? `${name} could not get ready` : `${name} has no model yet`}>
      {s.message ?? 'Pick one under Mesh & AI → Models on this server, or let it choose.'}{' '}
      {app.can('admin') && (
        <Button size="sm" loading={busy === 'prep'} onClick={() => void run('prep', () => coreCall('ai.prepareStarter')).then(() => starter.reload())}>
          {s.state === 'failed' ? 'Try again' : 'Choose and download for me'}
        </Button>
      )}
    </Callout>
  );
}

function ToolCalls({ calls }: { calls: ToolCallRecord[] }) {
  return (
    <div className="vt-chat-tools">
      {calls.map((c) => (
        <span key={c.id} title={c.error ?? undefined}>
          <Status tone={TOOL_STATUS[c.status]?.tone ?? 'neutral'}>{c.name}</Status> <span className="fx-muted">{TOOL_STATUS[c.status]?.word ?? c.status}</span>
        </span>
      ))}
    </div>
  );
}

function Message({ m }: { m: ChatMessage }) {
  if (m.role === 'user')
    return (
      <>
        {m.attachments?.length ? <MessageAttachments files={m.attachments} read={readAttachment} open={{ title: (a) => `Download ${a.name}`, run: (a) => void download(a.path) }} /> : null}
        <div className="vt-chat-msg user">{m.content}</div>
      </>
    );
  const made = (m.toolCalls ?? []).flatMap((c) => c.files ?? []);
  return (
    <div className="vt-chat-msg">
      {m.toolCalls?.length ? <ToolCalls calls={m.toolCalls} /> : null}
      {made.length ? <CreatedFiles files={made} preview={previewFile} actions={(f) => <DownloadButton path={f.path} name={f.name} />} /> : null}
      {m.content && <Markdown text={m.content} />}
    </div>
  );
}

/** One chat: its messages, the answer being written, and what waits for a yes. */
function Thread({ id, name, onSent }: { id: string | null; name: string; onSent: (conversationId: string) => void }) {
  const app = useApp();
  const [fast, setFast] = useState(false);
  const conv = useCore<OpenConversation>(id ? 'ai.conversations.get' : null, fast ? 700 : 5000, { id });
  const approvals = useCore<ApprovalRequest[]>(fast ? 'approvals.list' : null, 1500);
  const [text, setText] = useState('');
  const [online, setOnline] = useState(false);
  const files = useAttachments(ATTACHMENTS);
  const picker = useRef<HTMLInputElement>(null);
  const { run, busy } = useAction();
  const end = useRef<HTMLDivElement>(null);
  const live = id && conv.data?.id === id ? conv.data.run : null;
  useEffect(() => setFast(!!live), [live]);
  useEffect(() => end.current?.scrollIntoView({ block: 'end' }), [conv.data?.messages.length, live?.reply?.text.length]);

  const send = () => {
    const message = text.trim();
    if (!message || busy === 'send' || live || files.reading) return;
    void run('send', async () => {
      const r = await coreCall<{ runId: string; conversationId: string }>('ai.chat', { message, ...(files.ids.length ? { attachments: files.ids } : {}), ...(id ? { conversationId: id } : { offline: !online }) });
      setText('');
      files.clear();
      setFast(true);
      if (r.conversationId !== id) onSent(r.conversationId);
      else await conv.reload();
    });
  };
  const waiting = (approvals.data ?? []).filter((a) => live && a.runId === live.runId);
  const messages = id && conv.data?.id === id ? conv.data.messages.filter((m) => m.role === 'user' || m.role === 'assistant') : [];
  const step = live?.steps.at(-1);
  return (
    <div
      className="vt-chat-thread"
      onDragOver={(e) => e.dataTransfer.types.includes('Files') && e.preventDefault()}
      onDrop={(e) => {
        if (!e.dataTransfer.files.length) return;
        e.preventDefault();
        files.add(e.dataTransfer.files);
      }}
    >
      <div className="vt-chat-messages">
        {!id ? (
          <div className="vt-chat-hello">
            <h3>Ask {name} about this server</h3>
            <p className="fx-muted">It works on this server under its policy: it looks things up freely, and asks an administrator before it changes anything. Attach files or pictures for it to read; what it makes can be downloaded here.</p>
            <div className="vt-chat-ideas">
              {IDEAS.map((i) => (
                <button key={i} onClick={() => setText(i)}>
                  {i}
                </button>
              ))}
            </div>
          </div>
        ) : !conv.data ? (
          <Spinner />
        ) : (
          messages.map((m) => <Message key={m.id} m={m} />)
        )}
        {live && (
          <div className="vt-chat-msg">
            {step && (
              <div className="vt-chat-step">
                <Spinner /> {step.detail}
              </div>
            )}
            {live.reply?.text && <Markdown text={live.reply.text} />}
          </div>
        )}
        {waiting.map((w) => (
          <div key={w.id} className="vt-approval">
            <div className="vt-approval-what">
              <Status tone="warning">{w.risk}</Status>
              <strong>{w.toolTitle}</strong>
            </div>
            <span className="fx-muted vt-approval-why">{w.reason}</span>
            {app.can('admin') ? (
              <span className="fx-row" style={{ gap: 6 }}>
                <Button size="sm" variant="primary" loading={busy === `y${w.id}`} onClick={() => void run(`y${w.id}`, () => coreCall('approvals.resolve', { id: w.id, decision: 'approve' })).then(() => approvals.reload())}>
                  Yes
                </Button>
                <Button size="sm" loading={busy === `n${w.id}`} onClick={() => void run(`n${w.id}`, () => coreCall('approvals.resolve', { id: w.id, decision: 'deny' })).then(() => approvals.reload())}>
                  No
                </Button>
              </span>
            ) : (
              <span className="fx-muted">An administrator answers this.</span>
            )}
          </div>
        ))}
        <div ref={end} />
      </div>
      <div className="vt-chat-composer">
        <AttachmentTray items={files.items} onRemove={files.remove} />
        <TextArea
          rows={3}
          value={text}
          maxLength={20000}
          placeholder={`Ask ${name}… (Enter sends, Shift+Enter for a new line)`}
          onChange={(e) => setText(e.target.value)}
          onPaste={(e) => {
            if (!e.clipboardData.files.length) return;
            e.preventDefault();
            files.add(e.clipboardData.files);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        <div className="vt-chat-actions">
          <input
            ref={picker}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              files.add(e.target.files ?? []);
              e.target.value = '';
            }}
          />
          <Button icon="paperclip" variant="ghost" disabled={files.full} onClick={() => picker.current?.click()}>
            Attach
          </Button>
          {!id && <Toggle checked={online} onChange={setOnline} label="May use the internet" />}
          <span className="fx-spacer" />
          {live ? (
            <Button icon="stop" loading={busy === 'stop'} onClick={() => void run('stop', () => coreCall('ai.cancel', { runId: live.runId }))}>
              Stop
            </Button>
          ) : (
            <Button variant="primary" icon="send" loading={busy === 'send'} disabled={!text.trim() || files.reading} onClick={send}>
              Send
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Fabrix in the server console: a chat with this server's own agent (the FBRX core of the ai role). Operators chat with
 * it; what it wants to do that needs a yes waits for an administrator, here or under Mesh & AI.
 */
export function FabrixPage({ id }: { id?: string }) {
  const app = useApp();
  const [, go] = useRoute();
  const core = usePoll<CoreState>('/v1/core', 15000);
  const ready = !!core.data?.installed && core.data.running;
  const name = useCore<{ settings: { ai: { agentName: string } } }>(ready ? 'settings.get' : null, 60000).data?.settings.ai.agentName ?? 'Fabrix';
  const chats = useCore<ConversationSummary[]>(ready && app.can('operator') ? 'ai.conversations.list' : null, 5000);
  const { run } = useAction();
  const { confirm, dialog } = useConfirm();
  const open = id ?? null;
  return (
    <Page title={name} description={`This server's own AI. Ask it about the server and its virtual machines, or hand it a job; it follows this server's policy.`}>
      {!core.data ? (
        <Empty title="Loading…" />
      ) : !core.data.installed ? (
        <Card title="The AI role is not installed">
          <p className="fx-secondary">{name} runs in FBRX Server's ai role. Add it on the server with:</p>
          <CopyText value="sudo ./install.sh --roles virtual,ai" />
        </Card>
      ) : !core.data.running ? (
        <Callout tone="critical" title="The FBRX core is not running">
          {core.data.error ?? 'It does not answer.'} On the server: <span className="mono">sudo systemctl status fbrx-core</span>
        </Callout>
      ) : !app.can('operator') ? (
        <Callout tone="info">Chatting with {name} is for operators and administrators of this console.</Callout>
      ) : (
        <>
          <Readiness name={name} />
          <div className="vt-chat">
            <div className="vt-chat-list">
              <Button variant="primary" icon="plus" onClick={() => go('fabrix')}>
                New chat
              </Button>
              {(chats.data ?? []).map((c) => (
                <div key={c.id} className={`vt-chat-item${c.id === open ? ' active' : ''}`}>
                  <button className="vt-chat-open" onClick={() => go('fabrix', c.id)}>
                    <span className="vt-chat-title">{c.title}</span>
                    <span className="fx-muted">
                      {timeAgo(c.updatedAt)} · {c.messageCount} messages
                    </span>
                  </button>
                  {app.can('admin') && (
                    <Button
                      size="sm"
                      variant="ghost"
                      icon="trash"
                      aria-label={`Delete ${c.title}`}
                      onClick={async () => {
                        if (!(await confirm({ title: `Delete “${c.title}”?`, danger: true, confirmLabel: 'Delete' }))) return;
                        await run('rm', () => coreCall('ai.conversations.delete', { id: c.id }), 'Chat deleted');
                        if (c.id === open) go('fabrix');
                        await chats.reload();
                      }}
                    />
                  )}
                </div>
              ))}
            </div>
            <Thread
              key={open ?? 'new'}
              id={open}
              name={name}
              onSent={(conversationId) => {
                go('fabrix', conversationId);
                void chats.reload();
              }}
            />
          </div>
        </>
      )}
      {dialog}
    </Page>
  );
}
