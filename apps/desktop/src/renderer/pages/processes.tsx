import { useEffect, useMemo, useState } from 'react';
import type { ProcessInfo } from '@fbrx/shared';
import { Button, Card, Grid, Input, KeyValue, LineChart, Meter, Page, StatTile, Tabs, formatBytes, formatDuration, timeAgo, useAction, useConfirm, type Column, Table } from '@fbrx/ui';
import { call } from '../client';
import { useCore } from '../hooks';
import { navigate, routeArg } from '../app';
import { useLive } from './dashboard';
import { QuickAiPanel, useQuickAi } from '../quick-ai';
import { EventViewer } from './event-viewer';

type TabId = 'processes' | 'performance' | 'events';
const tabFromRoute = (): TabId => (routeArg() === 'events' ? 'events' : routeArg() === 'performance' ? 'performance' : 'processes');

/** Task Manager: what is running, how hard the computer is working, and what Windows (or the system) logged. */
export function ProcessesPage() {
  const [tab, setTab] = useState<TabId>(tabFromRoute);
  useEffect(() => {
    const on = () => setTab(tabFromRoute());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return (
    <Page
      title="Task Manager"
      description={
        tab === 'events'
          ? 'What Windows and your apps logged: errors, warnings and crashes, with Fabrix to explain them.'
          : tab === 'performance'
            ? 'How hard this computer is working, live.'
            : 'What is running on this computer right now. Refreshes every few seconds.'
      }
    >
      <Tabs
        active={tab}
        onChange={(t) => {
          setTab(t);
          navigate(t === 'processes' ? 'processes' : `processes/${t}`);
        }}
        tabs={[
          { id: 'processes', label: 'Processes' },
          { id: 'performance', label: 'Performance' },
          { id: 'events', label: 'Event Viewer' },
        ]}
      />
      {tab === 'processes' ? <Processes /> : tab === 'performance' ? <Performance /> : <EventViewer />}
    </Page>
  );
}

function Processes() {
  const [sort, setSort] = useState<'cpu' | 'memory'>('cpu');
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState<ProcessInfo | null>(null);
  const procs = useCore('processes.list', { sort, filter: filter || undefined, limit: 200 }, [], 4000);
  const live = useLive();
  const cur = live[live.length - 1];
  const ai = useQuickAi();
  const { run } = useAction();
  const { confirm, dialog } = useConfirm();
  // Keep the selected row's numbers fresh as the list refreshes.
  const sel = selected ? (procs.data?.list.find((p) => p.pid === selected.pid) ?? selected) : null;

  const kill = async (p: ProcessInfo) => {
    if (await confirm({ title: `End ${p.name}?`, body: `Process ${p.pid} will be closed immediately. Unsaved work in it will be lost.`, danger: true, confirmLabel: 'End task' })) {
      await run(String(p.pid), () => call('processes.kill', { pid: p.pid }), `${p.name} ended`);
      if (selected?.pid === p.pid) setSelected(null);
      procs.reload();
    }
  };
  const describe = (p: ProcessInfo) => `Process: ${p.name}\nPID: ${p.pid}\nPath: ${p.path || 'unknown'}\nCPU: ${p.cpu.toFixed(1)}%\nMemory: ${formatBytes(p.memBytes)}\nUser: ${p.user || 'unknown'}\nStarted: ${p.started || 'unknown'}`;
  const top = () =>
    (procs.data?.list ?? [])
      .slice(0, 30)
      .map((p) => `${p.name} (PID ${p.pid}) · CPU ${p.cpu.toFixed(1)}% · ${formatBytes(p.memBytes)} · ${p.path || 'no path'}`)
      .join('\n');
  const machine = cur ? `CPU ${cur.cpu.toFixed(0)}% · memory ${formatBytes(cur.memUsed)} of ${formatBytes(cur.memTotal)}` : '';

  const columns: Column<ProcessInfo>[] = [
    { key: 'name', header: 'Name', render: (p) => <span title={p.path}>{p.name}</span> },
    { key: 'pid', header: 'PID', render: (p) => <span className="mono">{p.pid}</span>, width: 80 },
    { key: 'cpu', header: 'CPU', render: (p) => <span className={p.cpu >= 50 ? 'tm-hot' : undefined}>{p.cpu.toFixed(1)}%</span>, width: 80 },
    { key: 'mem', header: 'Memory', render: (p) => formatBytes(p.memBytes), width: 100 },
    { key: 'user', header: 'User', render: (p) => <span className="fx-muted">{p.user}</span>, width: 140 },
  ];

  return (
    <>
      <Grid cols={4}>
        <StatTile label="Processor" value={cur ? `${cur.cpu.toFixed(0)}%` : '—'} trend={live.slice(-12).map((p) => p.cpu)} />
        <StatTile label="Memory" value={cur ? formatBytes(cur.memUsed) : '—'} foot={cur ? `of ${formatBytes(cur.memTotal)}` : ''} trend={live.slice(-12).map((p) => p.memUsed)} />
        <StatTile label="Swap" value={cur ? formatBytes(cur.swapUsed) : '—'} foot={cur ? `of ${formatBytes(cur.swapTotal)}` : ''} />
        <StatTile label="Processes" value={procs.data ? String(procs.data.total) : '—'} />
      </Grid>
      <div className="tm-layout">
        <Card
          title="Running processes"
          actions={
            <>
              <Tabs tabs={[{ id: 'cpu', label: 'By CPU' }, { id: 'memory', label: 'By memory' }]} active={sort} onChange={setSort} />
              <div style={{ width: 200 }}>
                <Input placeholder="Filter by name or PID" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter processes" />
              </div>
            </>
          }
          flush
        >
          <div className="tm-table">
            <Table columns={columns} rows={procs.data?.list ?? []} rowKey={(p) => String(p.pid)} onRowClick={(p) => setSelected(p)} empty="Loading…" />
          </div>
        </Card>
        <div className="tm-side">
          {sel && (
            <Card
              title={sel.name}
              subtitle={`PID ${sel.pid}`}
              actions={
                <>
                  <Button size="sm" className="ask-btn" icon="sparkles" disabled={ai.busy} onClick={() => void ai.ask(`What is ${sel.name}?`, 'What is this process on my computer? Say what it belongs to, whether it is normal and safe, whether its CPU and memory use look normal, and whether I can safely end it.', describe(sel))}>
                    What is this?
                  </Button>
                  <Button size="sm" variant="danger" onClick={() => void kill(sel)}>
                    End task
                  </Button>
                  <Button size="sm" variant="ghost" icon="x" aria-label="Close details" onClick={() => setSelected(null)} />
                </>
              }
            >
              <KeyValue
                items={[
                  ['CPU', `${sel.cpu.toFixed(1)}%`],
                  ['Memory', formatBytes(sel.memBytes)],
                  ['User', sel.user || '—'],
                  ['Started', sel.started ? timeAgo(sel.started) : '—'],
                  ['Path', <span key="p" className="mono tm-path">{sel.path || '—'}</span>],
                ]}
              />
            </Card>
          )}
          <QuickAiPanel
            ai={ai}
            className="tm-ai"
            onAsk={(t) => void ai.ask(t, t, `${machine}\n\nBusiest processes right now:\n${top()}${sel ? `\n\nSelected:\n${describe(sel)}` : ''}`)}
            empty="Click a process for its details, or ask what is slowing the computer down."
            actions={
              <>
                <Button size="sm" disabled={!procs.data || ai.busy} onClick={() => void ai.ask('What is using my computer?', 'Here are the busiest processes on my computer right now. Tell me what is using the most CPU and memory, whether that is normal, and what I can safely close to speed things up.', `${machine}\n\n${top()}`)}>
                  What's using my PC?
                </Button>
                <Button size="sm" disabled={!procs.data || ai.busy} onClick={() => void ai.ask('Anything suspicious?', 'Look at these running processes. Is anything unusual, unknown or possibly malicious (odd names, odd locations like Temp or AppData, imitations of Windows processes)? Explain why, and what to check.', top())}>
                  Anything suspicious?
                </Button>
              </>
            }
          />
        </div>
      </div>
      {dialog}
    </>
  );
}

function Performance() {
  const live = useLive();
  const stat = useCore('sysinfo.static');
  const cur = live[live.length - 1];
  const t = (sel: (p: (typeof live)[number]) => number) => live.map((p) => ({ t: p.ts, v: sel(p) }));
  const cpuSeries = useMemo(() => [{ key: 'cpu', label: 'Processor', slot: 0, points: t((p) => Math.round(p.cpu * 10) / 10) }], [live]); // eslint-disable-line react-hooks/exhaustive-deps
  const memSeries = useMemo(() => [{ key: 'mem', label: 'Memory in use', slot: 1, points: t((p) => Math.round((p.memUsed / (p.memTotal || 1)) * 1000) / 10) }], [live]); // eslint-disable-line react-hooks/exhaustive-deps
  const netSeries = useMemo(
    () => [
      { key: 'rx', label: 'Download', slot: 0, points: t((p) => p.netRx) },
      { key: 'tx', label: 'Upload', slot: 2, points: t((p) => p.netTx) },
    ],
    [live], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const rate = (b: number) => `${formatBytes(b)}/s`;
  return (
    <>
      <Grid cols={4}>
        <StatTile label="Processor" value={cur ? `${cur.cpu.toFixed(0)}%` : '—'} foot={stat.data ? `${stat.data.cpu.cores} cores · ${stat.data.cpu.threads} threads` : ''} />
        <StatTile label="Memory" value={cur ? `${Math.round((cur.memUsed / (cur.memTotal || 1)) * 100)}%` : '—'} foot={cur ? `${formatBytes(cur.memUsed)} of ${formatBytes(cur.memTotal)}` : ''} />
        <StatTile label="Network" value={cur ? rate(cur.netRx + cur.netTx) : '—'} foot={cur ? `↓ ${rate(cur.netRx)} · ↑ ${rate(cur.netTx)}` : ''} />
        <StatTile label="Up for" value={cur ? formatDuration(cur.uptime) : '—'} foot={cur?.tempC ? `${cur.tempC.toFixed(0)} °C` : cur?.battery ? `Battery ${cur.battery.percent}%${cur.battery.charging ? ' (charging)' : ''}` : ''} />
      </Grid>
      <Grid cols={2}>
        <Card title="Processor" subtitle={stat.data?.cpu.model}>
          <LineChart series={cpuSeries} yMax={100} yFormat={(n) => `${n}%`} area height={180} />
        </Card>
        <Card title="Memory" subtitle={stat.data ? `${formatBytes(stat.data.memoryTotal)} installed` : undefined}>
          <LineChart series={memSeries} yMax={100} yFormat={(n) => `${n}%`} area height={180} />
        </Card>
        <Card title="Each processor core" subtitle="Right now">
          <div className="tm-cores">
            {(cur?.cores ?? []).map((c, i) => (
              <div key={i} className="tm-core">
                <span className="tm-core-n">{i}</span>
                <Meter value={c} label={`Core ${i}`} />
                <span className="tm-core-v">{c.toFixed(0)}%</span>
              </div>
            ))}
            {!cur && <div className="fx-muted">Measuring…</div>}
          </div>
        </Card>
        <Card title="Network">
          <LineChart series={netSeries} yFormat={(n) => rate(n)} height={180} />
        </Card>
      </Grid>
    </>
  );
}
