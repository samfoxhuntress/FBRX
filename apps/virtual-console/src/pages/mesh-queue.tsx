import { useState } from 'react';
import {
  ASSIST_LOG_DAYS,
  ASSIST_PRIORITIES,
  ASSIST_TERMINAL,
  requesterLabel,
  type AssistLogEntry,
  type AssistLogQuery,
  type AssistPriority,
  type AssistQueue,
  type AssistSession,
  type AssistStatus,
  type AssistTally,
} from '@fbrx/shared';
import { Button, Callout, Card, Empty, Field, Grid, Input, Select, StatTile, Status, Table, timeAgo, useAction, useConfirm, type StatusTone } from '@fbrx/ui';
import { coreCall, useCore } from '../core';
import { useApp } from '../state';

/**
 * Mesh & AI → Work queue and Log: what the computers on FBRX Mesh asked this server's AI to do. The queue is live:
 * operators run a request next, change its priority or cancel it; administrators pause the queue. The log keeps every
 * request with the computer and the person who asked, for ASSIST_LOG_DAYS days.
 */

const STATUS: Record<AssistStatus, { label: string; tone: StatusTone }> = {
  'waiting-approval': { label: 'Waiting to be allowed', tone: 'warning' },
  queued: { label: 'Waiting its turn', tone: 'neutral' },
  running: { label: 'Running', tone: 'busy' },
  done: { label: 'Done', tone: 'good' },
  denied: { label: 'Declined', tone: 'warning' },
  error: { label: 'Failed', tone: 'critical' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
};

const PRIORITY: Record<AssistPriority, string> = { background: 'Background', normal: 'Normal', high: 'High', urgent: 'Urgent' };

/** "4 s", "3 min", "1 h 20 min". */
function took(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`;
}

const spent = (from: string | null, to: string | null) => (from ? took(Math.max(0, Date.parse(to ?? new Date().toISOString()) - Date.parse(from))) : '—');

/** The person and the computer they asked from. */
function Who({ s }: { s: Pick<AssistSession, 'requester' | 'peerName'> }) {
  const who = requesterLabel(s.requester);
  return (
    <div>
      <div>{who ?? <span className="fx-muted">Someone</span>}</div>
      <div className="fx-muted" style={{ fontSize: 12 }}>
        {s.requester?.email && s.requester.email !== who ? `${s.requester.email} · ` : ''}
        {s.peerName}
      </div>
    </div>
  );
}

const Goal = ({ text }: { text: string }) => (
  <span title={text} style={{ display: 'inline-block', maxWidth: 420, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', verticalAlign: 'bottom' }}>
    {text}
  </span>
);

export function WorkQueue() {
  const app = useApp();
  const q = useCore<AssistQueue>('mesh.assist.queue', 3000);
  const { busy, run } = useAction();
  const { confirm, dialog } = useConfirm();
  const operator = app.can('operator');
  const manage = (s: AssistSession, action: 'cancel' | 'front' | 'priority', priority?: AssistPriority) =>
    run(`${action}${s.id}`, () => coreCall('mesh.assist.manage', { sessionId: s.id, action, priority }).then(q.reload), action === 'cancel' ? 'Cancelled' : action === 'front' ? 'It runs next' : 'Priority changed');
  const cancel = async (s: AssistSession) => {
    const who = requesterLabel(s.requester) ?? s.peerName;
    if (await confirm({ title: 'Cancel this request?', body: `${who}'s request stops${s.status === 'running' ? ' where it is' : ''}, and ${s.peerName} is told who cancelled it.`, confirmLabel: 'Cancel it', danger: true })) await manage(s, 'cancel');
  };
  if (q.error) return <Callout tone="critical">{q.error}</Callout>;
  const d = q.data;
  if (!d) return <Empty title="Loading…" />;
  const cancelButton = (s: AssistSession) =>
    operator && (
      <Button size="sm" variant="danger" loading={busy === `cancel${s.id}`} onClick={() => void cancel(s)}>
        Cancel
      </Button>
    );
  return (
    <>
      {dialog}
      <Grid cols={3}>
        <StatTile label="Running" value={`${d.running.length} of ${d.capacity}`} foot="At once (Mesh Assist settings)" />
        <StatTile label="Waiting" value={d.waiting.length} foot={d.waiting.length ? `Next: ${requesterLabel(d.waiting[0]!.requester) ?? d.waiting[0]!.peerName}` : 'Nothing waiting'} />
        <StatTile label="Queue" value={d.paused ? 'Paused' : 'Going'} foot={d.paused ? 'Nothing new starts' : 'Requests start as room frees up'} />
      </Grid>
      {d.paused && (
        <Callout tone="warning" title="The queue is paused">
          What runs goes on; nothing new starts until it goes on again. Computers still add requests, and they wait.
        </Callout>
      )}
      <Card
        title="Running"
        subtitle="Requests this server's AI works on now."
        actions={
          app.can('admin') && (
            <Button icon={d.paused ? 'play' : 'stop'} loading={busy === 'pause'} onClick={() => void run('pause', () => coreCall<AssistQueue>('mesh.assist.pause', { paused: !d.paused }).then(q.set), d.paused ? 'The queue goes on' : 'The queue is paused')}>
              {d.paused ? 'Go on' : 'Pause the queue'}
            </Button>
          )
        }
        flush
      >
        <Table
          rows={d.running}
          rowKey={(s) => s.id}
          empty={<Empty title="Nothing runs right now" />}
          columns={[
            { key: 'who', header: 'Who asked', render: (s) => <Who s={s} /> },
            { key: 'what', header: 'What', render: (s) => <Goal text={s.goal} /> },
            { key: 'p', header: 'Priority', render: (s) => PRIORITY[s.priority] },
            { key: 't', header: 'Running for', render: (s) => spent(s.startedAt, null) },
            { key: 'st', header: 'Steps', render: (s) => `${s.steps}${s.tools.length ? ` · ${s.tools.at(-1)}` : ''}` },
            { key: 'a', header: '', render: cancelButton },
          ]}
        />
      </Card>
      <Card title="Waiting" subtitle="In the order they will run: most important first, then first come. Requests waiting to be allowed come last." flush>
        <Table
          rows={d.waiting}
          rowKey={(s) => s.id}
          empty={<Empty title="Nothing waiting" />}
          columns={[
            { key: 'n', header: '#', render: (s) => s.position ?? '—' },
            { key: 'who', header: 'Who asked', render: (s) => <Who s={s} /> },
            { key: 'what', header: 'What', render: (s) => <Goal text={s.goal} /> },
            {
              key: 'p',
              header: 'Priority',
              render: (s) =>
                operator && s.status === 'queued' ? (
                  <Select
                    aria-label={`Priority of ${s.peerName}'s request`}
                    value={s.priority}
                    options={ASSIST_PRIORITIES.map((p) => ({ value: p, label: PRIORITY[p] }))}
                    onChange={(e) => void manage(s, 'priority', e.target.value as AssistPriority)}
                  />
                ) : (
                  PRIORITY[s.priority]
                ),
            },
            { key: 'w', header: 'Waiting', render: (s) => (s.status === 'waiting-approval' ? <Status tone="warning">To be allowed</Status> : spent(s.createdAt, null)) },
            {
              key: 'a',
              header: '',
              render: (s) => (
                <div className="fx-row">
                  {operator && s.status === 'queued' && s.position !== 1 && (
                    <Button size="sm" loading={busy === `front${s.id}`} onClick={() => void manage(s, 'front')}>
                      Run next
                    </Button>
                  )}
                  {cancelButton(s)}
                </div>
              ),
            },
          ]}
        />
      </Card>
    </>
  );
}

/** The log: everything asked of this server's AI, by computer and by person. */
export function RequestLog() {
  const [direction, setDirection] = useState<'in' | 'out'>('in');
  const [filter, setFilter] = useState<AssistLogQuery>({});
  const [text, setText] = useState('');
  const query: AssistLogQuery = { ...filter, direction, text: text.trim() || undefined, limit: 300 };
  const log = useCore<AssistLogEntry[]>('mesh.assist.log', 10000, query);
  const devices = useCore<AssistTally[]>('mesh.assist.tally', 30000, { by: 'device', direction });
  const people = useCore<AssistTally[]>('mesh.assist.tally', 30000, { by: 'person', direction });
  const pick = (patch: AssistLogQuery) => setFilter((f) => ({ ...f, ...patch }));
  const here = direction === 'in';
  const tally = (rows: AssistTally[] | null, by: 'device' | 'person') => (
    <Table
      rows={rows ?? []}
      rowKey={(t) => t.key}
      onRowClick={(t) => pick(by === 'device' ? { peerId: t.key, person: undefined } : { person: t.key, peerId: undefined })}
      empty={<Empty title="No requests yet" />}
      columns={[
        { key: 'l', header: by === 'device' ? 'Computer' : 'Person', render: (t) => (t.detail ? <div><div>{t.label}</div><div className="fx-muted" style={{ fontSize: 12 }}>{t.detail}</div></div> : t.label) },
        { key: 'j', header: 'Requests', render: (t) => t.jobs },
        { key: 'd', header: 'Done', render: (t) => t.done },
        { key: 'f', header: 'Failed', render: (t) => t.failed || '—' },
        { key: 'c', header: 'Cancelled', render: (t) => t.cancelled || '—' },
        { key: 't', header: 'Working time', render: (t) => took(t.runMs) },
        { key: 'w', header: 'Last', render: (t) => timeAgo(t.lastAt) },
      ]}
    />
  );
  const rows = log.data ?? [];
  return (
    <>
      <Card
        title={here ? 'Asked of this server' : 'Asked by this server'}
        subtitle={`Every request, with the computer and the person who asked, kept ${ASSIST_LOG_DAYS} days. The computer is proven by its pairing; the person is who that computer says is signed in. Click a computer or a person to see only theirs.`}
        actions={
          <Select
            aria-label="Which requests"
            style={{ minWidth: 210 }}
            value={direction}
            options={[
              { value: 'in', label: 'Help given here' },
              { value: 'out', label: 'Help asked from here' },
            ]}
            onChange={(e) => (setDirection(e.target.value as 'in' | 'out'), setFilter({}))}
          />
        }
      >
        <div className="fx-form">
          <h4 style={{ margin: 0 }}>By person</h4>
          {tally(people.data, 'person')}
          <h4 style={{ margin: '6px 0 0' }}>By computer</h4>
          {tally(devices.data, 'device')}
        </div>
      </Card>
      <Card
        title="Requests"
        subtitle="Newest first. What was asked is kept; the answer stays in this server's conversation with it."
        actions={
          <Button icon="download" size="sm" disabled={!rows.length} onClick={() => download(rows)}>
            Export CSV
          </Button>
        }
        flush
      >
        <div className="fx-row" style={{ padding: '10px 14px', flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <Field label="Computer">
            <Select value={filter.peerId ?? ''} options={[{ value: '', label: 'Every computer' }, ...(devices.data ?? []).map((t) => ({ value: t.key, label: t.label }))]} onChange={(e) => pick({ peerId: e.target.value || undefined })} />
          </Field>
          <Field label="Person">
            <Select value={filter.person ?? ''} options={[{ value: '', label: 'Everyone' }, ...(people.data ?? []).map((t) => ({ value: t.key, label: t.detail ? `${t.label} (${t.detail})` : t.label }))]} onChange={(e) => pick({ person: e.target.value || undefined })} />
          </Field>
          <Field label="Status">
            <Select value={filter.status ?? ''} options={[{ value: '', label: 'Any' }, ...(Object.keys(STATUS) as AssistStatus[]).map((s) => ({ value: s, label: STATUS[s].label }))]} onChange={(e) => pick({ status: (e.target.value || undefined) as AssistStatus | undefined })} />
          </Field>
          <Field label="Words in the request">
            <Input value={text} onChange={(e) => setText(e.target.value)} placeholder="Search" style={{ maxWidth: 200 }} />
          </Field>
          {(filter.peerId || filter.person || filter.status || text) && (
            <Button size="sm" variant="ghost" onClick={() => (setFilter({}), setText(''))}>
              Show everything
            </Button>
          )}
        </div>
        {log.error ? (
          <div style={{ padding: 14 }}>
            <Callout tone="critical">{log.error}</Callout>
          </div>
        ) : (
          <Table
            rows={rows}
            rowKey={(r) => r.id}
            empty={<Empty title="No requests match" />}
            columns={[
              { key: 'w', header: 'When', render: (r) => <span title={new Date(r.createdAt).toLocaleString()}>{timeAgo(r.createdAt)}</span> },
              { key: 'who', header: here ? 'Who asked' : 'Asked by · of', render: (r) => <Who s={r} /> },
              { key: 'what', header: 'What', render: (r) => <Goal text={r.goal} /> },
              { key: 'p', header: 'Priority', render: (r) => PRIORITY[r.priority] },
              {
                key: 's',
                header: 'Status',
                render: (r) => (
                  <span title={r.error ?? undefined}>
                    <Status tone={STATUS[r.status].tone}>{STATUS[r.status].label}</Status>
                    {r.cancelledBy && <div className="fx-muted" style={{ fontSize: 12 }}>by {r.cancelledBy}</div>}
                  </span>
                ),
              },
              { key: 't', header: 'Took', render: (r) => (ASSIST_TERMINAL.includes(r.status) ? spent(r.startedAt, r.finishedAt) : spent(r.startedAt, null)) },
            ]}
          />
        )}
      </Card>
    </>
  );
}

/** The requests shown, as a CSV file. */
function download(rows: AssistLogEntry[]) {
  const cell = (v: unknown) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const head = ['when', 'direction', 'computer', 'person', 'email', 'system user', 'request', 'priority', 'status', 'started', 'finished', 'steps', 'cancelled by', 'error'];
  const lines = rows.map((r) =>
    [r.createdAt, r.direction, r.peerName, r.requester?.name, r.requester?.email, r.requester?.user, r.goal, r.priority, r.status, r.startedAt, r.finishedAt, r.steps, r.cancelledBy, r.error].map(cell).join(','),
  );
  const url = URL.createObjectURL(new Blob([[head.join(','), ...lines].join('\n')], { type: 'text/csv' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `mesh-assist-requests-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
