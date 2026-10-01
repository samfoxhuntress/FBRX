import { useEffect, useState } from 'react';
import type { BugReport, EventLogEntry, FixInfo } from '@fbrx/shared';
import { AdvancedTag, Button, Callout, Card, Empty, Grid, Page, Select, Spinner, StatTile, Status, formatDate, useAction, useConfirm, useToast, Table } from '@fbrx/ui';
import { call } from '../client';
import { useCore } from '../hooks';
import { IS_WINDOWS, navigate } from '../app';
import { AskButton, askAgent } from '../widgets';

function askAbout(r: BugReport, focus: string) {
  const summary = JSON.stringify({ ...r, events: r.events.slice(0, 15) }).slice(0, 6000);
  navigate(`agent/ask/${encodeURIComponent(`Here is a summary of the problems Windows recorded on this PC (${focus}). Explain what matters in plain language, the likely causes, and the safest fixes in order. Use your tools to look closer if needed.\n\n${summary}`)}`);
}

export function BugsPage({ agentName, advanced }: { agentName: string; advanced: boolean }) {
  const [days, setDays] = useState(3);
  const [showLogs, setShowLogs] = useState(false);
  const [report, setReport] = useState<BugReport | null>(null);
  const fixes = useCore('bugs.fixes');
  const { run, busy } = useAction();
  const { confirm, dialog } = useConfirm();
  const toast = useToast();

  const scan = async () => {
    const r = await run('scan', () => call('bugs.scan', { days }));
    if (r) setReport(r);
  };
  const fix = async (f: FixInfo, target?: string, label?: string) => {
    if (!(await confirm({ title: label ?? f.label, body: f.admin ? 'Windows will ask for administrator permission. Some repairs take several minutes.' : 'This runs now.', confirmLabel: 'Run' }))) return;
    const r = await run(`fix-${f.id}-${target ?? ''}`, () => call('bugs.fix', { id: f.id, target }));
    if (r) (r.ok ? toast.success : toast.warning)(r.ok ? 'Done' : 'Finished with problems', r.output.slice(-400));
  };
  const fixById = (id: string) => fixes.data?.find((f) => f.id === id);

  if (!IS_WINDOWS) {
    return (
      <Page title="Bug catcher" description="Find out what has been going wrong on this PC and fix it.">
        <Callout tone="info">The bug catcher reads the Windows event log and is available on Windows.</Callout>
      </Page>
    );
  }
  return (
    <Page
      title="Bug catcher"
      description={`Collects errors, crashes, blue screens and broken devices from Windows, explains them with ${agentName}, and offers one-click repairs.`}
      actions={
        <>
          <div style={{ width: 150 }}>
            <Select aria-label="Period" value={String(days)} onChange={(e) => setDays(Number(e.target.value))} options={[{ value: '1', label: 'Last 24 hours' }, { value: '3', label: 'Last 3 days' }, { value: '7', label: 'Last week' }, { value: '30', label: 'Last 30 days' }]} />
          </div>
          {advanced && (
            <Button icon="book" onClick={() => setShowLogs(!showLogs)} aria-pressed={showLogs}>
              {showLogs ? 'Hide logs' : 'Show logs'}
            </Button>
          )}
          <Button variant="primary" icon="bug" loading={busy === 'scan'} onClick={() => void scan()}>
            Scan now
          </Button>
        </>
      }
    >
      {advanced && showLogs && <EventLogs days={days} agentName={agentName} />}
      {busy === 'scan' && (
        <Card>
          <Spinner /> <span className="fx-muted">Reading the event log…</span>
        </Card>
      )}
      {report && busy !== 'scan' && (
        <>
          <Grid cols={4}>
            <StatTile label="Error types" value={String(report.events.length)} foot={`in ${report.days} day(s)`} />
            <StatTile label="App crashes" value={String(report.crashes.length)} />
            <StatTile label="Blue screens (90 days)" value={String(report.stopErrors.length)} foot={report.stopErrors[0] ? `last ${formatDate(report.stopErrors[0].time)}` : ''} />
            <StatTile label="Unexpected shutdowns (30 days)" value={String(report.unexpectedShutdowns.length)} />
          </Grid>
          <Callout tone="info" actions={<Button size="sm" icon="sparkles" onClick={() => askAbout(report, `last ${report.days} days`)}>Explain with {agentName}</Button>}>
            {agentName} can read this report, look up details and suggest fixes in plain language.
          </Callout>
          {report.problemDevices.length > 0 && (
            <Card title="Devices with problems" flush>
              <Table
                columns={[
                  { key: 'n', header: 'Device', render: (d) => d.name },
                  { key: 's', header: 'Status', render: (d) => <Status tone="warning">{d.status}</Status> },
                  { key: 'e', header: 'Problem', render: (d) => <span className="fx-muted">{d.error}</span> },
                  { key: 'a', header: '', render: (d) => (<div className="fx-actions" style={{ justifyContent: 'flex-end' }}>{fixById('device') && <Button size="sm" onClick={() => void fix(fixById('device')!, d.id, `Restart ${d.name}`)}>Restart device</Button>}<AskButton iconOnly prompt="This device has a problem on my PC. Explain what the error means and the safest way to fix it." context={d} /></div>) },
                ]}
                rows={report.problemDevices}
                rowKey={(d) => d.id}
              />
            </Card>
          )}
          {report.stoppedServices.length > 0 && (
            <Card title="Services that should be running" flush>
              <Table
                columns={[
                  { key: 'd', header: 'Service', render: (s) => s.display },
                  { key: 'n', header: 'Name', render: (s) => <span className="mono fx-muted">{s.name}</span> },
                  { key: 'a', header: '', render: (s) => (<div className="fx-actions" style={{ justifyContent: 'flex-end' }}>{fixById('service') && <Button size="sm" onClick={() => void fix(fixById('service')!, s.name, `Start ${s.display}`)}>Start</Button>}<AskButton iconOnly prompt="This Windows service should be running but is stopped. What does it do, why might it have stopped, and is it safe to start it?" context={s} /></div>) },
                ]}
                rows={report.stoppedServices}
                rowKey={(s) => s.name}
              />
            </Card>
          )}
          {report.crashes.length > 0 && (
            <Card title="App crashes" flush>
              <Table
                columns={[
                  { key: 'a', header: 'App', render: (c) => c.app },
                  { key: 'm', header: 'Failed in', render: (c) => <span className="mono fx-muted">{c.module}</span> },
                  { key: 't', header: 'When', render: (c) => formatDate(c.time) },
                  { key: 'x', header: '', render: (c) => <AskButton iconOnly prompt="This app crashed on my PC. Explain the likely cause from the failing module and how to stop it happening." context={c} />, width: 50 },
                ]}
                rows={report.crashes.slice(0, 30)}
                rowKey={(c) => `${c.app}${c.time}`}
              />
            </Card>
          )}
          <Card title="Most frequent errors" flush>
            <Table
              columns={[
                { key: 's', header: 'Source', render: (e) => <span>{e.source} <span className="fx-muted">#{e.eventId}</span></span> },
                { key: 'c', header: 'Count', render: (e) => e.count, width: 70 },
                { key: 'm', header: 'Message', render: (e) => <span className="fx-muted" style={{ fontSize: 12 }}>{e.message.slice(0, 220)}</span> },
                { key: 'l', header: 'Last', render: (e) => formatDate(e.last), width: 150 },
                { key: 'x', header: '', render: (e) => <AskButton iconOnly prompt="Windows keeps logging this error on my PC. Explain what it means in plain language, whether it matters, and how to fix it." context={e} />, width: 50 },
              ]}
              rows={report.events}
              rowKey={(e) => `${e.source}${e.eventId}`}
              empty={<Empty title="No errors recorded" />}
            />
          </Card>
        </>
      )}
      {!report && busy !== 'scan' && <Empty title="Scan to see what has been going wrong">Nothing is changed by a scan; it only reads the logs.</Empty>}
      <Card title="Repairs" subtitle="Common Windows fixes, one click each" flush>
        <div className="fx-list">
          {(fixes.data ?? [])
            .filter((f) => f.target === 'none')
            .map((f) => (
              <div key={f.id} className="fx-list-item">
                <span style={{ flex: 1 }}>{f.label}</span>
                {f.admin && <Status tone="neutral">admin</Status>}
                <Button size="sm" loading={busy === `fix-${f.id}-`} onClick={() => void fix(f)}>
                  Run
                </Button>
              </div>
            ))}
        </div>
      </Card>
      {dialog}
    </Page>
  );
}

/** Advanced: the raw Windows event log, newest first, with each entry one click away from the agent. */
function EventLogs({ days, agentName }: { days: number; agentName: string }) {
  const [log, setLog] = useState<'System' | 'Application' | 'Setup'>('System');
  const [level, setLevel] = useState<'error' | 'warning' | 'information'>('warning');
  const [rows, setRows] = useState<EventLogEntry[] | null>(null);
  const { run, busy } = useAction();
  const load = () => void run('logs', () => call('bugs.events', { log, days, minLevel: level, limit: 400 })).then((r) => r && setRows(r));
  useEffect(load, [log, level, days]); // eslint-disable-line react-hooks/exhaustive-deps
  const tone = (l: EventLogEntry['level']) => (l === 'critical' || l === 'error' ? 'critical' : l === 'warning' ? 'warning' : 'neutral');
  return (
    <Card
      title={<>Event log <AdvancedTag /></>}
      subtitle={`Windows ${log} log · last ${days} day(s) · newest first`}
      actions={
        <>
          <div style={{ width: 130 }}>
            <Select aria-label="Log" value={log} onChange={(e) => setLog(e.target.value as typeof log)} options={['System', 'Application', 'Setup']} />
          </div>
          <div style={{ width: 170 }}>
            <Select aria-label="Level" value={level} onChange={(e) => setLevel(e.target.value as typeof level)} options={[{ value: 'error', label: 'Errors' }, { value: 'warning', label: 'Errors and warnings' }, { value: 'information', label: 'Everything' }]} />
          </div>
          <Button size="sm" icon="refresh" loading={busy === 'logs'} onClick={load} aria-label="Reload" />
          <Button size="sm" variant="primary" icon="sparkles" disabled={!rows?.length} onClick={() => askAgent(`Read these Windows ${log} log entries from my PC (newest first). Group them by cause, tell me which ones matter, what they mean in plain language, and the safest fixes in order. Ignore harmless noise.`, rows!.slice(0, 60).map((r) => ({ time: r.time, level: r.level, source: r.source, id: r.eventId, message: r.message.slice(0, 400) })))}>
            Analyze with {agentName}
          </Button>
          <Button size="sm" variant="ghost" icon="external" onClick={() => void call('spotlight.run', { item: { id: 'tool:eventvwr', kind: 'app', title: 'Event Viewer', score: 0, action: { type: 'app', appId: 'tool:eventvwr' } } })}>
            Event Viewer
          </Button>
        </>
      }
      flush
    >
      <Table
        rows={rows ?? []}
        rowKey={(r) => `${r.time}${r.source}${r.eventId}`}
        empty={rows ? <Empty title="Nothing logged">No matching entries in this period.</Empty> : <Empty title="Reading the event log…" />}
        columns={[
          { key: 't', header: 'When', render: (r) => <span style={{ whiteSpace: 'nowrap' }}>{formatDate(r.time)}</span>, width: 150 },
          { key: 'l', header: 'Level', render: (r) => <Status tone={tone(r.level)}>{r.level}</Status>, width: 110 },
          { key: 's', header: 'Source', render: (r) => <span>{r.source} <span className="fx-muted">#{r.eventId}</span></span> },
          { key: 'm', header: 'Message', render: (r) => <span className="fx-muted" style={{ fontSize: 12 }} title={r.message}>{r.message.slice(0, 260)}</span> },
          { key: 'x', header: '', render: (r) => <AskButton iconOnly prompt={`Explain this Windows ${log} log entry from my PC in plain language: what happened, whether it matters, and what to do.`} context={r} />, width: 50 },
        ]}
      />
    </Card>
  );
}
