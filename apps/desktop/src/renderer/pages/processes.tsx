import { useState } from 'react';
import type { ProcessInfo } from '@fbrx/shared';
import { Button, Card, Grid, Input, Page, StatTile, Tabs, formatBytes, useAction, useConfirm, type Column, Table } from '@fbrx/ui';
import { call } from '../client';
import { useCore } from '../hooks';
import { useLive } from './dashboard';

export function ProcessesPage() {
  const [sort, setSort] = useState<'cpu' | 'memory'>('cpu');
  const [filter, setFilter] = useState('');
  const procs = useCore('processes.list', { sort, filter: filter || undefined, limit: 200 }, [], 4000);
  const live = useLive();
  const cur = live[live.length - 1];
  const { run } = useAction();
  const { confirm, dialog } = useConfirm();

  const kill = async (p: ProcessInfo) => {
    if (await confirm({ title: `End ${p.name}?`, body: `Process ${p.pid} will be closed immediately. Unsaved work in it will be lost.`, danger: true, confirmLabel: 'End process' })) {
      await run(String(p.pid), () => call('processes.kill', { pid: p.pid }), `${p.name} ended`);
      procs.reload();
    }
  };

  const columns: Column<ProcessInfo>[] = [
    { key: 'name', header: 'Name', render: (p) => <span title={p.path}>{p.name}</span> },
    { key: 'pid', header: 'PID', render: (p) => <span className="mono">{p.pid}</span>, width: 80 },
    { key: 'cpu', header: 'CPU', render: (p) => `${p.cpu.toFixed(1)}%`, width: 80 },
    { key: 'mem', header: 'Memory', render: (p) => formatBytes(p.memBytes), width: 100 },
    { key: 'user', header: 'User', render: (p) => <span className="fx-muted">{p.user}</span>, width: 140 },
    { key: 'act', header: '', render: (p) => <Button size="sm" variant="ghost" icon="x" aria-label={`End ${p.name}`} onClick={() => void kill(p)} />, width: 50 },
  ];

  return (
    <Page title="Processes" description="What is running on this computer right now. Refreshes every few seconds.">
      <Grid cols={4}>
        <StatTile label="Processor" value={cur ? `${cur.cpu.toFixed(0)}%` : '—'} trend={live.slice(-12).map((p) => p.cpu)} />
        <StatTile label="Memory" value={cur ? formatBytes(cur.memUsed) : '—'} foot={cur ? `of ${formatBytes(cur.memTotal)}` : ''} trend={live.slice(-12).map((p) => p.memUsed)} />
        <StatTile label="Swap" value={cur ? formatBytes(cur.swapUsed) : '—'} foot={cur ? `of ${formatBytes(cur.swapTotal)}` : ''} />
        <StatTile label="Processes" value={procs.data ? String(procs.data.total) : '—'} />
      </Grid>
      <Card
        title="Running processes"
        actions={
          <>
            <Tabs tabs={[{ id: 'cpu', label: 'By CPU' }, { id: 'memory', label: 'By memory' }]} active={sort} onChange={setSort} />
            <div style={{ width: 220 }}>
              <Input placeholder="Filter by name or PID" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter processes" />
            </div>
          </>
        }
        flush
      >
        <Table columns={columns} rows={procs.data?.list ?? []} rowKey={(p) => String(p.pid)} empty="Loading…" />
      </Card>
      {dialog}
    </Page>
  );
}
