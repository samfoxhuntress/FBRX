import type { HostInfo, StoragePool, VmSummary } from '@fbrx/shared';
import { Callout, Card, Empty, formatDuration, Grid, KeyValue, Meter, StatTile, Table, Button } from '@fbrx/ui';
import { usePoll, useRoute } from '../state';
import { gb, mb, osName, Pct, PowerButtons, VmStateBadge } from './common';

export function OverviewPage() {
  const [, go] = useRoute();
  const host = usePoll<HostInfo>('/v1/host', 5000);
  const vms = usePoll<{ vms: VmSummary[] }>('/v1/vms', 5000);
  const pools = usePoll<{ pools: StoragePool[] }>('/v1/storage/pools', 30000);
  const h = host.data;
  const list = vms.data?.vms ?? [];
  const running = list.filter((v) => v.state === 'running').length;
  const images = pools.data?.pools.find((p) => p.role === 'images');
  const vcpus = list.filter((v) => v.state === 'running').reduce((n, v) => n + v.cpus, 0);
  const vmem = list.filter((v) => v.state === 'running').reduce((n, v) => n + v.memoryMb, 0);
  return (
    <div className="fx-page">
      <div className="fx-page-header">
        <div>
          <h1>{h?.hostname ?? 'This server'}</h1>
          <p>{h ? `${h.product} ${h.version} on ${h.os}` : 'Loading…'}</p>
        </div>
        <div className="fx-actions">
          <Button variant="primary" icon="plus" onClick={() => go('vms', 'new')}>
            New virtual machine
          </Button>
        </div>
      </div>
      {h?.warnings.map((w) => (
        <Callout key={w} tone={w.startsWith('Simulated') ? 'info' : 'warning'}>
          {w}
        </Callout>
      ))}
      <Grid cols={4}>
        <StatTile label="Virtual machines running" value={vms.data ? String(running) : '—'} foot={`${list.length} on this server`} hero />
        <StatTile label="Processor" value={h ? `${h.cpuPct.toFixed(0)}%` : '—'} foot={h ? `${vcpus} of ${h.cpu.threads} threads given to running machines` : ''} />
        <StatTile label="Memory" value={h ? mb(h.memory.usedMb) : '—'} foot={h ? `of ${mb(h.memory.totalMb)} · ${mb(vmem)} given to machines` : ''} />
        <StatTile label="Disk space for machines" value={images ? gb(images.availableGb) : '—'} foot={images ? `free of ${gb(images.capacityGb)}` : ''} />
      </Grid>
      <Grid cols={2}>
        <Card title="Server">
          {h ? (
            <>
              <KeyValue
                items={[
                  ['Model', [h.vendor, h.model].filter(Boolean).join(' ') || '—'],
                  ['Service tag / serial', h.serial],
                  ['Processor', `${h.cpu.model} · ${h.cpu.cores} cores, ${h.cpu.threads} threads`],
                  ['BIOS', [h.bios.vendor, h.bios.version, h.bios.date].filter(Boolean).join(' · ') || '—'],
                  ['Up for', formatDuration(h.uptimeSeconds)],
                  ['Load', h.load.join(' · ')],
                ]}
              />
              <div style={{ display: 'grid', gap: 10, marginTop: 14 }}>
                <Meter label="Processor" value={h.cpuPct} />
                <Meter label="Memory" value={h.memory.usedMb} max={h.memory.totalMb} />
              </div>
            </>
          ) : (
            <Empty title="Loading…" />
          )}
        </Card>
        <Card title="Hypervisor">
          {h && (
            <KeyValue
              items={[
                ['Runs', h.hypervisor.driver === 'libvirt' ? `KVM through libvirt (${h.hypervisor.version ?? 'unknown version'})` : 'Simulated (nothing really runs)'],
                ['Hardware acceleration', h.hypervisor.kvm ? 'On (VT-x / AMD-V)' : 'Off: software emulation'],
                ['Direct device access', h.iommu ? 'On (VT-d / AMD-Vi): PCI devices can be given to machines' : 'Off'],
                ['UEFI firmware', h.hypervisor.uefi ? 'Installed' : 'Not installed'],
                ['Virtual TPM (Windows 11)', h.hypervisor.tpm ? 'Available' : 'Not installed'],
              ]}
            />
          )}
        </Card>
      </Grid>
      <Card title="Virtual machines" actions={<Button onClick={() => go('vms')}>All machines</Button>} flush>
        <Table
          rows={list}
          rowKey={(v) => v.id}
          onRowClick={(v) => go('vm', v.id)}
          empty={<Empty title="No virtual machines yet" action={<Button variant="primary" icon="plus" onClick={() => go('vms', 'new')}>New virtual machine</Button>} />}
          columns={[
            { key: 'name', header: 'Name', render: (v) => <div><div className="fx-cell-title">{v.name}</div><div className="fx-cell-sub">{osName(v.os)} · {v.cpus} CPU · {mb(v.memoryMb)}</div></div> },
            { key: 'state', header: 'State', render: (v) => <VmStateBadge state={v.state} /> },
            { key: 'cpu', header: 'Processor', render: (v) => <Pct value={v.cpuPct} /> },
            { key: 'ip', header: 'Address', render: (v) => <span className="mono">{v.ip ?? '—'}</span> },
            { key: 'power', header: '', render: (v) => <PowerButtons vm={v} size="sm" onDone={() => void vms.reload()} /> },
          ]}
        />
      </Card>
    </div>
  );
}
