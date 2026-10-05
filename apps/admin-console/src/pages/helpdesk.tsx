import { useState } from 'react';
import { TICKET_CATEGORY_NAMES, TICKET_PRIORITIES, TICKET_STATUSES, TICKET_STATUS_NAMES, type TicketDetail, type TicketStatus, type TicketSummary } from '@fbrx/shared';
import { Button, Callout, Card, Empty, Grid, Page, Select, StatTile, Status, Table, TextArea, timeAgo, useAction } from '@fbrx/ui';
import { api } from '../api';
import { useApp, useQuery } from '../state';

const TONE: Record<TicketStatus, 'warning' | 'busy' | 'info' | 'good' | 'neutral'> = { open: 'warning', in_progress: 'busy', waiting: 'info', resolved: 'good', closed: 'neutral' };

/**
 * FBRX Command → Help desk: every ticket people sent from their computers, the conversation, and the computers that
 * receive tickets. Answering here reaches the person's computer at once, like an answer from a receiver.
 */
export function HelpdeskPage() {
  const app = useApp();
  const [state, setState] = useState<'open' | 'closed' | 'all'>('open');
  const [picked, setPicked] = useState<string | null>(null);
  const live = (e: { type: string }) => e.type === 'ticket.updated';
  const tickets = useQuery<TicketSummary[]>(`/v1/admin/helpdesk/tickets?state=${state}`, [], live);
  const info = useQuery<{ enabled: boolean; receivers: Array<{ id: string; name: string; hostname: string; online: boolean }>; open: number; total: number }>(app.tenantId ? '/v1/admin/helpdesk' : null, [], live);
  const rows = tickets.data ?? [];
  return (
    <Page title="Help desk" description="Tickets from your organization's computers. Computers you mark as receivers (Devices → a device → Help desk) get them the moment they are sent; you can answer here too.">
      {info.data && !info.data.enabled && <Callout tone="warning">The help desk is off for this organization (Profiles & groups → Organization defaults).</Callout>}
      {info.data && (
        <Grid cols={3}>
          <StatTile label="Open tickets" value={info.data.open} foot={`${info.data.total} in all`} />
          <StatTile
            label="Receivers"
            value={info.data.receivers.length}
            foot={info.data.receivers.length ? info.data.receivers.map((r) => `${r.name}${r.online ? '' : ' (offline)'}`).join(', ') : 'None yet: tickets wait here'}
          />
          <StatTile label="How it travels" value={<span style={{ fontSize: 16 }}>Live</span>} foot="Over each computer's encrypted connection to FBRX Command" />
        </Grid>
      )}
      <div className="fx-row">
        <div style={{ width: 200 }}>
          <Select aria-label="Which tickets" value={state} onChange={(e) => setState(e.target.value as typeof state)} options={[{ value: 'open', label: 'Open' }, { value: 'closed', label: 'Resolved and closed' }, { value: 'all', label: 'All' }]} />
        </div>
      </div>
      <div className="hd-console">
        <Card flush>
          <Table
            rows={rows}
            rowKey={(t) => t.id}
            onRowClick={(t) => setPicked(t.id)}
            empty={<Empty title={state === 'open' ? 'No open tickets' : 'No tickets'}>When someone sends a problem from FBRX's Help desk tab, it shows up here.</Empty>}
            columns={[
              { key: 'n', header: '#', width: 50, render: (t) => <span className="mono">{t.number}</span> },
              { key: 's', header: 'Ticket', render: (t) => (<div><div className="fx-cell-title">{t.subject}</div><div className="fx-cell-sub">{t.requesterName}{t.deviceName && t.deviceName !== t.requesterName ? ` · ${t.deviceName}` : ''} · {TICKET_CATEGORY_NAMES[t.category]}</div></div>) },
              { key: 'p', header: 'Priority', width: 90, render: (t) => (t.priority === 'urgent' || t.priority === 'high' ? <span className="fx-badge accent">{t.priority}</span> : t.priority) },
              { key: 'st', header: 'Status', width: 130, render: (t) => <Status tone={TONE[t.status]}>{TICKET_STATUS_NAMES[t.status]}</Status> },
              { key: 'a', header: 'With', render: (t) => t.assigneeName ?? <span className="fx-muted">—</span> },
              { key: 'u', header: 'Updated', width: 110, render: (t) => <span className="fx-secondary">{timeAgo(t.updatedAt)}</span> },
            ]}
          />
        </Card>
        {picked ? <TicketPanel key={picked} id={picked} canAnswer={app.can('helpdesk.manage')} /> : <Card><Empty title="Pick a ticket">Its conversation shows here.</Empty></Card>}
      </div>
    </Page>
  );
}

function TicketPanel({ id, canAnswer }: { id: string; canAnswer: boolean }) {
  const t = useQuery<TicketDetail>(`/v1/admin/helpdesk/tickets/${id}`, [], (e: any) => e.type === 'ticket.updated' && e.ticket?.id === id);
  const [reply, setReply] = useState('');
  const { run, busy } = useAction();
  const d = t.data;
  if (!d) return <Card />;
  const patch = (body: Record<string, unknown>) => void run('p', () => api('PATCH', `/v1/admin/helpdesk/tickets/${id}`, body).then(t.reload));
  return (
    <Card title={`#${d.number} ${d.subject}`} subtitle={`${d.requesterName}${d.deviceName ? ` on ${d.deviceName}` : ''} · opened ${timeAgo(d.createdAt)}`} actions={<Status tone={TONE[d.status]}>{TICKET_STATUS_NAMES[d.status]}</Status>}>
      <div className="hd-thread">
        {d.thread.map((m) =>
          m.authorKind === 'system' ? (
            <div key={m.id} className="hd-note">{m.body} · {timeAgo(m.createdAt)}</div>
          ) : (
            <div key={m.id} className={`hd-msg ${m.authorKind}`}>
              <div className="hd-msg-head"><b>{m.authorName}</b> {timeAgo(m.createdAt)}</div>
              <div className="hd-msg-body">{m.body}</div>
            </div>
          ),
        )}
      </div>
      {d.diagnostics && (
        <details className="hd-diag">
          <summary>Computer details</summary>
          <pre className="fx-code">{JSON.stringify(d.diagnostics, null, 2)}</pre>
        </details>
      )}
      {canAnswer && (
        <div className="fx-form" style={{ marginTop: 12 }}>
          <TextArea rows={3} value={reply} placeholder="Answer (it reaches their computer at once)" onChange={(e) => setReply(e.target.value)} />
          <div className="fx-actions">
            <Button variant="primary" icon="send" disabled={!reply.trim()} loading={busy === 'r'} onClick={() => void run('r', () => api('POST', `/v1/admin/helpdesk/tickets/${id}/messages`, { body: reply }).then(() => (setReply(''), t.reload())))}>
              Send
            </Button>
            <span className="fx-spacer" />
            {!d.assigneeName && (
              <Button size="sm" onClick={() => patch({ assignToMe: true })}>
                Take it
              </Button>
            )}
            <div style={{ width: 150 }}>
              <Select aria-label="Status" value={d.status} onChange={(e) => patch({ status: e.target.value })} options={TICKET_STATUSES.map((s) => ({ value: s, label: TICKET_STATUS_NAMES[s] }))} />
            </div>
            <div style={{ width: 110 }}>
              <Select aria-label="Priority" value={d.priority} onChange={(e) => patch({ priority: e.target.value })} options={TICKET_PRIORITIES.map((p) => ({ value: p, label: p }))} />
            </div>
          </div>
        </div>
      )}
    </Card>
  );
}
