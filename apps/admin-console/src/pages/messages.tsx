import { useEffect, useRef, useState } from 'react';
import { MESSAGE_MAX_CHARS, type OrgChatMessage } from '@fbrx/shared';
import { Button, Callout, Card, Empty, Page, TextArea, timeAgo, useAction, useConfirm } from '@fbrx/ui';
import { api } from '../api';
import { useApp, useQuery } from '../state';

/**
 * FBRX Command → Messages: the conversation everyone in the organization sees in Messages on their computer. Post to
 * it (an announcement, "pizza night!") and remove what does not belong. Conversations between two computers stay
 * between those two.
 */
export function MessagesPage() {
  const app = useApp();
  const live = (e: { type: string }) => e.type === 'chat.message';
  const q = useQuery<{ enabled: boolean; messages: OrgChatMessage[] }>('/v1/admin/chat/messages', [], live);
  const [text, setText] = useState('');
  const { run, busy } = useAction();
  const { confirm, dialog } = useConfirm();
  const end = useRef<HTMLDivElement>(null);
  const manage = app.can('messages.manage');
  const rows = q.data?.messages ?? [];
  useEffect(() => end.current?.scrollIntoView({ block: 'end' }), [rows.length]);
  const send = () =>
    void run('send', () => api('POST', '/v1/admin/chat/messages', { text: text.trim() }).then(() => (setText(''), q.reload()))).catch(() => undefined);
  return (
    <Page title="Messages" description="What everyone in the organization sees under Everyone in Messages. Messages between two computers stay between them.">
      {q.data && !q.data.enabled && <Callout tone="warning">Messages are off for this organization (Profiles &amp; groups → Organization defaults).</Callout>}
      {q.error && <Callout tone="warning">{q.error}</Callout>}
      <Card title="Everyone" subtitle="Kept for 180 days. Computers get new messages at once over their connection to FBRX Command.">
        <div className="hd-thread" style={{ maxHeight: '55vh' }}>
          {rows.length === 0 ? (
            <Empty title="No messages yet">{manage ? 'Write the first one below: every computer sees it in Messages.' : 'Messages people send to everyone show here.'}</Empty>
          ) : (
            rows.map((m) => (
              <div key={m.id} className={`hd-msg ${m.fromKind === 'admin' ? 'requester' : 'helpdesk'}`}>
                <div className="hd-msg-head">
                  <b>{m.fromName}</b> <span>{m.fromKind === 'admin' ? 'FBRX Command · ' : ''}{timeAgo(m.at)}</span>
                  {manage && (
                    <Button
                      size="sm"
                      variant="ghost"
                      loading={busy === m.id}
                      style={{ marginLeft: 6, padding: '0 6px', minHeight: 0, fontSize: 11.5 }}
                      onClick={async () => {
                        if (await confirm({ title: 'Remove this message?', body: 'It disappears from Everyone on every computer the next time Messages is opened.', confirmLabel: 'Remove', danger: true }))
                          await run(m.id, () => api('DELETE', `/v1/admin/chat/messages/${m.id}`).then(q.reload), 'Removed');
                      }}
                    >
                      Remove
                    </Button>
                  )}
                </div>
                <div className="hd-msg-body">{m.text}</div>
              </div>
            ))
          )}
          <div ref={end} />
        </div>
        {manage && q.data?.enabled && (
          <div className="fx-form" style={{ marginTop: 12 }}>
            <TextArea rows={2} value={text} placeholder="Write to everyone" onChange={(e) => setText(e.target.value)} onKeyDown={(e) => (e.ctrlKey || e.metaKey) && e.key === 'Enter' && text.trim() && send()} />
            <div className="fx-actions">
              <span className="fx-muted" style={{ fontSize: 12 }}>
                {text.length > MESSAGE_MAX_CHARS ? `Up to ${MESSAGE_MAX_CHARS} characters` : 'Ctrl+Enter sends'}
              </span>
              <span className="fx-spacer" />
              <Button variant="primary" icon="send" disabled={!text.trim() || text.length > MESSAGE_MAX_CHARS} loading={busy === 'send'} onClick={send}>
                Send to everyone
              </Button>
            </div>
          </div>
        )}
      </Card>
      {dialog}
    </Page>
  );
}
