import { useEffect, useState } from 'react';
import { TICKET_CATEGORIES, TICKET_CATEGORY_NAMES, TICKET_PRIORITIES, TICKET_STATUSES, TICKET_STATUS_NAMES, type HelpdeskScope, type TicketDetail, type TicketStatus, type TicketSummary } from '@fbrx/shared';
import { Button, Callout, Card, Empty, Field, Input, Modal, Page, Select, Status, Tabs, TextArea, Toggle, timeAgo, useAction } from '@fbrx/ui';
import { call } from '../client';
import { useCore } from '../hooks';
import { routeArg } from '../app';

/**
 * Help desk (a computer in an organization): send a problem to IT, follow it, and, on computers the organization chose
 * as receivers, work everyone's tickets. FBRX Command keeps the tickets and pushes changes here at once.
 */

const STATUS_TONE: Record<TicketStatus, 'warning' | 'busy' | 'info' | 'good' | 'neutral'> = { open: 'warning', in_progress: 'busy', waiting: 'info', resolved: 'good', closed: 'neutral' };

export function HelpdeskPage({ learner }: { learner: boolean }) {
  const status = useCore('helpdesk.status', undefined, ['fleet.changed', 'helpdesk.changed']);
  const receiver = !!status.data?.receiver;
  const [tab, setTab] = useState<'mine' | 'queue' | 'history'>(() => (routeArg() === 'queue' ? 'queue' : 'mine'));
  const [picked, setPicked] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const scope: HelpdeskScope = tab === 'queue' ? 'queue' : 'mine';
  const state = tab === 'history' ? 'closed' : 'open';
  const list = useCore('helpdesk.tickets', { scope, state }, ['helpdesk.changed', 'fleet.changed']);
  useEffect(() => setPicked(null), [tab]);
  const title = learner ? 'Get help' : 'Help desk';

  if (status.data && !status.data.available) {
    return (
      <Page title={title} description="Send a problem to your IT team and follow it here.">
        <Card>
          <Empty title="No help desk yet">{status.data.message}</Empty>
        </Card>
      </Page>
    );
  }
  const rows = list.data ?? [];
  const current = rows.find((t) => t.id === picked) ?? null;
  return (
    <Page
      title={title}
      description={
        receiver
          ? `Tickets from ${status.data?.organization ?? 'your organization'} arrive here the moment they are sent.`
          : learner
            ? 'Something not working? Tell the IT team here and they will help.'
            : `Send a problem to ${status.data?.organization ?? 'your organization'}'s IT team and follow it here. You will be told when they answer.`
      }
      actions={
        <Button variant="primary" icon="plus" onClick={() => setAsking(true)}>
          {learner ? 'Ask for help' : 'New ticket'}
        </Button>
      }
    >
      {status.data?.message && <Callout tone="warning">{status.data.message}</Callout>}
      {status.data && status.data.receivers === 0 && !receiver && <Callout tone="info">Your IT team reads tickets in FBRX Command. Replies show up here.</Callout>}
      <Tabs
        tabs={[
          { id: 'mine', label: 'My tickets' },
          ...(receiver ? [{ id: 'queue' as const, label: 'Queue' }] : []),
          { id: 'history', label: 'History' },
        ]}
        active={tab}
        onChange={setTab}
      />
      <div className="hd-layout">
        <Card className="hd-list" flush>
          {list.error && <Callout tone="warning">{list.error}</Callout>}
          {!rows.length ? (
            <Empty title={tab === 'queue' ? 'The queue is empty' : tab === 'history' ? 'No closed tickets yet' : 'No open tickets'}>{tab === 'mine' ? 'When something breaks, New ticket sends it to IT with a short summary of this computer.' : undefined}</Empty>
          ) : (
            <div className="private">
              {rows.map((t) => (
                <TicketRow key={t.id} t={t} active={t.id === picked} showFrom={tab === 'queue'} onClick={() => setPicked(t.id)} />
              ))}
            </div>
          )}
        </Card>
        {current ? <TicketView key={current.id} id={current.id} receiver={receiver} /> : <Card className="hd-empty"><Empty title="Pick a ticket">Its conversation and actions show here.</Empty></Card>}
      </div>
      {asking && (
        <NewTicket
          learner={learner}
          onClose={() => setAsking(false)}
          onSent={(t) => {
            setTab('mine');
            setPicked(t.id);
          }}
        />
      )}
    </Page>
  );
}

function TicketRow({ t, active, showFrom, onClick }: { t: TicketSummary; active: boolean; showFrom: boolean; onClick: () => void }) {
  return (
    <button className={`hd-row${active ? ' active' : ''}`} onClick={onClick}>
      <div className="hd-row-top">
        <span className="hd-num">#{t.number}</span>
        <span className="hd-subject">{t.subject}</span>
        {t.priority === 'urgent' || t.priority === 'high' ? <span className={`hd-prio ${t.priority}`}>{t.priority}</span> : null}
      </div>
      <div className="hd-row-sub">
        <Status tone={STATUS_TONE[t.status]}>{TICKET_STATUS_NAMES[t.status]}</Status>
        <span>{showFrom ? `${t.requesterName}${t.deviceName && t.deviceName !== t.requesterName ? ` · ${t.deviceName}` : ''}` : TICKET_CATEGORY_NAMES[t.category]}</span>
        <span className="fx-spacer" />
        <span>{timeAgo(t.updatedAt)}</span>
      </div>
    </button>
  );
}

function TicketView({ id, receiver }: { id: string; receiver: boolean }) {
  const t = useCore('helpdesk.ticket', { id }, ['helpdesk.changed']);
  const [reply, setReply] = useState('');
  const { run, busy } = useAction();
  const d = t.data;
  if (t.error) return <Callout tone="warning">{t.error}</Callout>;
  if (!d) return <Card className="hd-view" />;
  const done = d.status === 'resolved' || d.status === 'closed';
  const send = () => void run('r', () => call('helpdesk.reply', { id, body: reply })).then((r) => r && setReply(''));
  const update = (change: { status?: TicketStatus; priority?: TicketDetail['priority']; assignToMe?: boolean }, ok?: string) => void run('u', () => call('helpdesk.update', { id, ...change }), ok);
  return (
    <Card
      className="hd-view"
      title={
        <>
          #{d.number} {d.subject}
        </>
      }
      subtitle={`${TICKET_CATEGORY_NAMES[d.category]} · ${d.requesterName}${d.deviceName ? ` on ${d.deviceName}` : ''} · opened ${timeAgo(d.createdAt)}${d.assigneeName ? ` · with ${d.assigneeName}` : ''}`}
      actions={<Status tone={STATUS_TONE[d.status]}>{TICKET_STATUS_NAMES[d.status]}</Status>}
    >
      <div className="hd-thread private">
        {d.thread.map((m) =>
          m.authorKind === 'system' ? (
            <div key={m.id} className="hd-note">
              {m.body} · {timeAgo(m.createdAt)}
            </div>
          ) : (
            <div key={m.id} className={`hd-msg ${m.authorKind}`}>
              <div className="hd-msg-head">
                <b>{m.authorName}</b> <span>{timeAgo(m.createdAt)}</span>
              </div>
              <div className="hd-msg-body">{m.body}</div>
            </div>
          ),
        )}
      </div>
      {receiver && d.diagnostics && (
        <details className="hd-diag">
          <summary>Computer details sent with the ticket</summary>
          <pre className="fx-code">{JSON.stringify(d.diagnostics, null, 2)}</pre>
        </details>
      )}
      <div className="fx-form" style={{ marginTop: 12 }}>
        <TextArea rows={3} value={reply} placeholder={done ? 'Reply to open it again' : 'Write a reply'} onChange={(e) => setReply(e.target.value)} onKeyDown={(e) => (e.ctrlKey || e.metaKey) && e.key === 'Enter' && reply.trim() && send()} />
        <div className="fx-actions">
          <Button variant="primary" icon="send" disabled={!reply.trim()} loading={busy === 'r'} onClick={send}>
            Send
          </Button>
          <span className="fx-spacer" />
          {receiver ? (
            <>
              {!d.assigneeName && (
                <Button size="sm" icon="check" onClick={() => update({ assignToMe: true }, `You took #${d.number}`)}>
                  Take it
                </Button>
              )}
              <div style={{ width: 160 }}>
                <Select aria-label="Status" value={d.status} onChange={(e) => update({ status: e.target.value as TicketStatus })} options={TICKET_STATUSES.map((s) => ({ value: s, label: TICKET_STATUS_NAMES[s] }))} />
              </div>
              <div style={{ width: 120 }}>
                <Select aria-label="Priority" value={d.priority} onChange={(e) => update({ priority: e.target.value as TicketDetail['priority'] })} options={TICKET_PRIORITIES.map((p) => ({ value: p, label: p }))} />
              </div>
            </>
          ) : done ? (
            <Button size="sm" onClick={() => update({ status: 'open' }, 'Opened again')}>
              Still not working
            </Button>
          ) : (
            <Button size="sm" icon="check" onClick={() => update({ status: 'resolved' }, 'Glad it is fixed')}>
              It's fixed
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
}

function NewTicket({ learner, onClose, onSent }: { learner: boolean; onClose: () => void; onSent: (t: TicketDetail) => void }) {
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [category, setCategory] = useState<(typeof TICKET_CATEGORIES)[number]>('computer');
  const [urgent, setUrgent] = useState(false);
  const [details, setDetails] = useState(true);
  const { run, busy } = useAction();
  const send = async () => {
    const t = await run('s', () => call('helpdesk.create', { subject, body, category, priority: urgent ? 'urgent' : 'normal', attachDiagnostics: details }), 'Sent to IT');
    if (t) {
      onSent(t);
      onClose();
    }
  };
  return (
    <Modal
      title={learner ? 'Ask IT for help' : 'Send a problem to IT'}
      description="Say what is wrong and what you already tried. IT answers here."
      onClose={onClose}
      footer={
        <>
          <span className="fx-spacer" />
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" icon="send" disabled={subject.trim().length < 3 || !body.trim()} loading={busy === 's'} onClick={() => void send()}>
            Send
          </Button>
        </>
      }
    >
      <div className="fx-form">
        <Field label="What is wrong, in a few words">
          <Input value={subject} maxLength={200} placeholder={learner ? 'My laptop will not connect to Wi-Fi' : 'The projector in Room 12 shows no signal'} onChange={(e) => setSubject(e.target.value)} />
        </Field>
        <Field label="What is it about">
          <Select value={category} onChange={(e) => setCategory(e.target.value as typeof category)} options={TICKET_CATEGORIES.map((c) => ({ value: c, label: TICKET_CATEGORY_NAMES[c] }))} />
        </Field>
        <Field label="Details" help="What happened, since when, and what you already tried">
          <TextArea rows={5} value={body} maxLength={10000} onChange={(e) => setBody(e.target.value)} />
        </Field>
        {!learner && <Toggle checked={urgent} onChange={setUrgent} label="Urgent: a class or meeting cannot go on" />}
        <Toggle checked={details} onChange={setDetails} label="Include a short summary of this computer (name, system, free space, network)" />
      </div>
    </Modal>
  );
}
