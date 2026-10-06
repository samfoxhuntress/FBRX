import { useEffect, useRef, useState } from 'react';
import type { HostInfo, HwTopology, IsoImage, VmDetail, VmSnapshot } from '@fbrx/shared';
import { Button, Callout, Card, Empty, Field, formatDate, formatDuration, Grid, Input, KeyValue, Page, Select, Table, Tabs, Toggle, useAction, useConfirm, useToast } from '@fbrx/ui';
import { api } from '../api';
import { useApp, usePoll, useRoute } from '../state';
import { gb, mb, osName, Pct, PowerButtons, VmStateBadge } from './common';
import { DescriptionEditor } from './vms';

type Tab = 'summary' | 'console' | 'snapshots' | 'placement' | 'settings';

export function VmDetailPage({ id, tab }: { id: string; tab?: string }) {
  const [, go] = useRoute();
  const vm = usePoll<VmDetail & { isoName: string | null }>(`/v1/vms/${id}`, 4000);
  const active = (['summary', 'console', 'snapshots', 'placement', 'settings'].includes(tab ?? '') ? tab : 'summary') as Tab;
  const v = vm.data;
  if (vm.error && !v) return <Page title="Virtual machine"><Callout tone="critical">{vm.error}</Callout></Page>;
  if (!v) return <Page title="Virtual machine"><Empty title="Loading…" /></Page>;
  return (
    <Page
      title={
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 12 }}>
          {v.name} <VmStateBadge state={v.state} />
        </span>
      }
      description={v.description || `${osName(v.os)} · ${v.cpus} CPU · ${mb(v.memoryMb)} · ${gb(v.diskGb)}`}
      actions={<PowerButtons vm={v} onDone={() => void vm.reload()} />}
    >
      {v.restartNeeded && <Callout tone="info">Some changes are saved and take effect when this machine next starts (shut it down and start it, a restart inside it is not enough).</Callout>}
      <Tabs<Tab>
        active={active}
        onChange={(t) => go('vm', id, t)}
        tabs={[
          { id: 'summary', label: 'Summary' },
          { id: 'console', label: 'Screen' },
          { id: 'snapshots', label: 'Snapshots' },
          { id: 'placement', label: 'Hardware & placement' },
          { id: 'settings', label: 'Settings' },
        ]}
      />
      {active === 'summary' && <Summary vm={v} reload={vm.reload} />}
      {active === 'console' && <ConsoleTab vm={v} />}
      {active === 'snapshots' && <Snapshots vm={v} />}
      {active === 'placement' && <Placement vm={v} reload={vm.reload} />}
      {active === 'settings' && <Settings vm={v} reload={vm.reload} />}
    </Page>
  );
}

function Summary({ vm, reload }: { vm: VmDetail & { isoName: string | null }; reload: () => Promise<void> }) {
  const app = useApp();
  const { run } = useAction();
  const live = vm.state === 'running' || vm.state === 'paused';
  return (
    <Grid cols={2}>
      <Card title="Now">
        <KeyValue
          items={[
            ['State', <VmStateBadge key="s" state={vm.state} />],
            ['Processor', live ? <Pct value={vm.cpuPct} /> : '—'],
            ['Memory used', vm.memoryUsedMb == null ? '—' : `${mb(vm.memoryUsedMb)} of ${mb(vm.memoryMb)}`],
            ['Address', <span key="ip" className="mono">{vm.ip ?? (live ? 'Not known yet (the guest agent or DHCP tells us)' : '—')}</span>],
            ['Up for', vm.uptimeSeconds == null ? '—' : formatDuration(vm.uptimeSeconds)],
            ['Starts with the server', vm.autostart ? 'Yes' : 'No'],
            ['Made', vm.createdAt ? formatDate(vm.createdAt) : '—'],
          ]}
        />
      </Card>
      <Card title="Machine">
        <KeyValue
          items={[
            ['Operating system', osName(vm.os)],
            ['Firmware', vm.firmware === 'uefi' ? `UEFI${vm.secureBoot ? ' with Secure Boot' : ''}` : 'BIOS'],
            ['TPM', vm.tpm ? 'Virtual TPM 2.0' : 'None'],
            ['Chipset', vm.machine || '—'],
            ['Runs on processors', vm.cpuset ?? 'Any'],
            ['CD drive', vm.isoName ?? (vm.iso ? vm.iso : 'Empty')],
          ]}
        />
      </Card>
      <Card title="Disks" flush>
        <Table
          rows={vm.disks}
          rowKey={(d) => d.target}
          columns={[
            { key: 't', header: 'Drive', render: (d) => <span className="mono">{d.target}</span> },
            { key: 'k', header: 'Kind', render: (d) => (d.device === 'cdrom' ? 'CD / DVD' : `Disk (${d.bus})`) },
            { key: 's', header: 'Size', render: (d) => (d.device === 'cdrom' ? '—' : `${gb(d.sizeGb)} (${gb(d.allocatedGb)} used on the server)`) },
            { key: 'p', header: 'File', render: (d) => <span className="mono fx-cell-sub">{d.path ?? 'empty'}</span> },
          ]}
        />
      </Card>
      <Card title="Network" flush>
        <Table
          rows={vm.nics}
          rowKey={(n) => n.mac}
          columns={[
            { key: 'm', header: 'MAC', render: (n) => <span className="mono">{n.mac}</span> },
            { key: 's', header: 'Connected to', render: (n) => `${n.source} (${n.kind === 'bridge' ? 'bridge' : 'network'})` },
            { key: 'mo', header: 'Card', render: (n) => n.model },
            { key: 'ip', header: 'Address', render: (n) => <span className="mono">{n.ip ?? '—'}</span> },
          ]}
        />
      </Card>
      {app.can('operator') && (
        <Card title="Description">
          <DescriptionEditor value={vm.description} onSave={(d) => run('desc', async () => { await api('PATCH', `/v1/vms/${vm.id}`, { description: d }); await reload(); }, 'Saved')} />
        </Card>
      )}
    </Grid>
  );
}

/** The machine's screen in the browser (noVNC over FBRX Virtual's relay). */
function ConsoleTab({ vm }: { vm: VmDetail }) {
  const app = useApp();
  const box = useRef<HTMLDivElement>(null);
  const rfbRef = useRef<import('@novnc/novnc').default | null>(null);
  const [status, setStatus] = useState<'idle' | 'connecting' | 'connected' | 'closed'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const live = vm.state === 'running' || vm.state === 'paused';
  const simulated = app.me.driver === 'simulated';

  useEffect(() => {
    if (!live || simulated || !app.can('operator') || !box.current) return;
    let cancelled = false;
    setStatus('connecting');
    setError(null);
    void (async () => {
      try {
        const [{ default: RFB }, t] = await Promise.all([import('@novnc/novnc'), api<{ ticket: string; path: string }>('POST', `/v1/vms/${vm.id}/console`)]);
        if (cancelled || !box.current) return;
        const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${t.path}?ticket=${encodeURIComponent(t.ticket)}`;
        const rfb = new RFB(box.current, url);
        rfb.scaleViewport = true;
        rfb.background = 'transparent';
        rfb.addEventListener('connect', () => setStatus('connected'));
        rfb.addEventListener('disconnect', () => setStatus('closed'));
        rfbRef.current = rfb;
      } catch (e) {
        setError((e as Error).message);
        setStatus('closed');
      }
    })();
    return () => {
      cancelled = true;
      rfbRef.current?.disconnect();
      rfbRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vm.id, live, nonce]);

  if (simulated) return <Empty title="Simulated machines have no screen">On FBRX Server, each running machine's screen shows here.</Empty>;
  if (!app.can('operator')) return <Empty title="Viewers cannot use the screen">Ask an administrator for the operator role.</Empty>;
  if (!live) return <Empty title={`${vm.name} is off`}>Start it to see its screen.</Empty>;
  return (
    <Card
      flush
      title="Screen"
      subtitle={status === 'connected' ? 'Click into the screen to type. Your keyboard goes to the machine.' : status === 'connecting' ? 'Connecting…' : 'Not connected'}
      actions={
        <>
          <Button size="sm" icon="zap" disabled={status !== 'connected'} onClick={() => rfbRef.current?.sendCtrlAltDel()}>
            Ctrl+Alt+Del
          </Button>
          <Button size="sm" icon="external" disabled={status !== 'connected'} onClick={() => void box.current?.requestFullscreen()}>
            Full screen
          </Button>
          <Button size="sm" icon="refresh" onClick={() => setNonce((n) => n + 1)}>
            Reconnect
          </Button>
        </>
      }
    >
      {error && <Callout tone="critical">{error}</Callout>}
      <div ref={box} className="vt-screen" />
    </Card>
  );
}

function Snapshots({ vm }: { vm: VmDetail }) {
  const app = useApp();
  const toast = useToast();
  const { busy, run } = useAction();
  const { confirm, dialog } = useConfirm();
  const snaps = usePoll<{ snapshots: VmSnapshot[] }>(`/v1/vms/${vm.id}/snapshots`, 15000);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const uefiRunning = vm.firmware === 'uefi' && vm.state !== 'stopped';
  const take = () =>
    run('take', async () => {
      await api('POST', `/v1/vms/${vm.id}/snapshots`, { name, description });
      setName('');
      setDescription('');
      await snaps.reload();
      toast.success(`Snapshot ${name} taken`);
    });
  return (
    <Grid cols={2}>
      <Card title="Snapshots" subtitle="A saved moment you can go back to (disk, and memory for running BIOS machines)." flush>
        <Table
          rows={snaps.data?.snapshots ?? []}
          rowKey={(s) => s.name}
          empty={<Empty title="No snapshots yet" />}
          columns={[
            { key: 'n', header: 'Name', render: (s) => <div><div className="fx-cell-title">{s.name}{s.current && <span className="fx-badge" style={{ marginLeft: 6 }}>current</span>}</div><div className="fx-cell-sub">{s.description}</div></div> },
            { key: 'a', header: 'Taken', render: (s) => formatDate(s.createdAt) },
            { key: 's', header: 'Was', render: (s) => <VmStateBadge state={s.state} /> },
            {
              key: 'x',
              header: '',
              render: (s) =>
                app.can('operator') && (
                  <span className="fx-row" style={{ gap: 6 }}>
                    <Button
                      size="sm"
                      icon="history"
                      loading={busy === `r:${s.name}`}
                      onClick={async () => {
                        if (await confirm({ title: `Go back to ${s.name}?`, body: `${vm.name} returns to how it was when the snapshot was taken. Anything since then is lost unless you take a snapshot first.`, confirmLabel: 'Go back', danger: true }))
                          await run(`r:${s.name}`, async () => { await api('POST', `/v1/vms/${vm.id}/snapshots/${encodeURIComponent(s.name)}/revert`); await snaps.reload(); }, `Back to ${s.name}`);
                      }}
                    >
                      Go back
                    </Button>
                    <Button
                      size="sm"
                      variant="danger"
                      icon="trash"
                      aria-label="Delete snapshot"
                      loading={busy === `d:${s.name}`}
                      onClick={async () => {
                        if (await confirm({ title: `Delete snapshot ${s.name}?`, body: 'The machine stays as it is now; you just cannot go back to this moment any more.', confirmLabel: 'Delete', danger: true }))
                          await run(`d:${s.name}`, async () => { await api('DELETE', `/v1/vms/${vm.id}/snapshots/${encodeURIComponent(s.name)}`); await snaps.reload(); });
                      }}
                    />
                  </span>
                ),
            },
          ]}
        />
      </Card>
      {app.can('operator') && (
        <Card title="Take a snapshot">
          <div className="fx-form">
            {uefiRunning && <Callout tone="info">UEFI machines are snapshotted while off. Shut {vm.name} down first.</Callout>}
            <Field label="Name" help="Letters, digits, dots, dashes, underscores.">
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="before-updates" />
            </Field>
            <Field label="Note">
              <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What state it is in" />
            </Field>
            <Button variant="primary" icon="archive" disabled={!/^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/.test(name) || uefiRunning} loading={busy === 'take'} onClick={() => void take()}>
              Take snapshot
            </Button>
          </div>
        </Card>
      )}
      {dialog}
    </Grid>
  );
}

/** Where the machine runs (which processors) and hardware handed to it (PCI passthrough). */
function Placement({ vm, reload }: { vm: VmDetail; reload: () => Promise<void> }) {
  const app = useApp();
  const { busy, run } = useAction();
  const topo = usePoll<HwTopology>('/v1/hardware/topology', 30000);
  const [cpuset, setCpuset] = useState(vm.cpuset ?? '');
  const [device, setDevice] = useState('');
  useEffect(() => setCpuset(vm.cpuset ?? ''), [vm.cpuset]);
  const t = topo.data;
  const devices = (t?.devices ?? []).filter((d) => d.kind !== 'bridge' && !d.passthroughVm);
  const near = vm.hostdevs.map((h) => t?.devices.find((d) => d.address === h.address)?.numaNode).find((n) => n != null);
  const nearNode = near != null ? t?.nodes.find((n) => n.node === near) : null;
  const admin = app.can('admin');
  return (
    <Grid cols={2}>
      <Card title="Processors it runs on" subtitle="Pinning keeps a machine on chosen processors: next to the hardware it uses, and away from other busy machines.">
        <div className="fx-form">
          <div className="vt-chips">
            <button className={`vt-chip${!cpuset ? ' on' : ''}`} disabled={!admin} onClick={() => setCpuset('')}>
              Any processor
            </button>
            {t?.nodes.map((n) => (
              <button key={n.node} className={`vt-chip${cpuset === n.cpus ? ' on' : ''}`} disabled={!admin} onClick={() => setCpuset(n.cpus)} title={n.model ?? undefined}>
                {t.nodes.length > 1 ? `Socket ${n.socket ?? n.node}` : 'All'} · CPUs {n.cpus}
              </button>
            ))}
          </div>
          <Field label="Or exactly these processors" help="Like 0-3 or 2,4,6. Moves a running machine right away.">
            <Input value={cpuset} onChange={(e) => setCpuset(e.target.value.replace(/\s/g, ''))} placeholder="Any" disabled={!admin} className="mono" />
          </Field>
          {nearNode && t && t.nodes.length > 1 && cpuset !== nearNode.cpus && <Callout tone="info">Its passthrough device sits on socket {nearNode.socket ?? nearNode.node}: running on CPUs {nearNode.cpus} keeps its data local.</Callout>}
          {admin && (
            <Button variant="primary" disabled={(cpuset || null) === vm.cpuset || (!!cpuset && !/^\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*$/.test(cpuset))} loading={busy === 'pin'} onClick={() => void run('pin', async () => { await api('PATCH', `/v1/vms/${vm.id}`, { cpuset: cpuset || null }); await reload(); }, 'Placement saved')}>
              Save placement
            </Button>
          )}
        </div>
      </Card>
      <Card title="Hardware given to it" subtitle="A PCI device (network card, disk controller, graphics) used directly by the machine, at full speed. Takes effect at its next start.">
        <div className="fx-form">
          {vm.hostdevs.length === 0 && <div className="fx-muted">Nothing yet.</div>}
          {vm.hostdevs.map((h) => (
            <div key={h.address} className="fx-row" style={{ justifyContent: 'space-between' }}>
              <span>
                <span className="mono">{h.address}</span> {h.name !== h.address && <span className="fx-secondary">{h.name}</span>}
              </span>
              {admin && (
                <Button size="sm" variant="danger" icon="x" loading={busy === h.address} onClick={() => void run(h.address, async () => { await api('DELETE', `/v1/vms/${vm.id}/hostdevs/${h.address}`); await reload(); }, 'Given back to the server')}>
                  Give back
                </Button>
              )}
            </div>
          ))}
          {admin && (
            <>
              <Field label="Give it a device" help={t?.source === 'sample' ? 'Sample hardware: this computer has no hardware map.' : 'Devices in the same IOMMU group go together.'}>
                <Select value={device} onChange={(e) => setDevice(e.target.value)} options={[{ value: '', label: 'Choose a device…' }, ...devices.map((d) => ({ value: d.address, label: `${d.address} · ${d.name}${d.interfaces.length ? ` (${d.interfaces.join(', ')})` : ''}` }))]} />
              </Field>
              <Button disabled={!device} loading={busy === 'attach'} onClick={() => void run('attach', async () => { await api('POST', `/v1/vms/${vm.id}/hostdevs`, { address: device }); setDevice(''); await reload(); }, 'Device given to the machine')}>
                Give device
              </Button>
              <div className="fx-help">The server stops using a device it gives away: never give away the network port you reach this console through.</div>
            </>
          )}
        </div>
      </Card>
    </Grid>
  );
}

function Settings({ vm, reload }: { vm: VmDetail & { isoName: string | null }; reload: () => Promise<void> }) {
  const app = useApp();
  const [, go] = useRoute();
  const toast = useToast();
  const { busy, run } = useAction();
  const { confirm, dialog } = useConfirm();
  const host = usePoll<HostInfo>('/v1/host', 60000);
  const isos = usePoll<{ isos: IsoImage[] }>('/v1/isos', 60000);
  const [cpus, setCpus] = useState(vm.cpus);
  const [memoryGb, setMemoryGb] = useState(vm.memoryMb / 1024);
  const [diskGb, setDiskGb] = useState(Math.round(vm.diskGb));
  const [deleteDisks, setDeleteDisks] = useState(true);
  const threads = host.data?.cpu.threads ?? 64;
  const op = app.can('operator');
  const changed = cpus !== vm.cpus || Math.round(memoryGb * 1024) !== vm.memoryMb || diskGb > Math.round(vm.diskGb);
  const save = () =>
    run('save', async () => {
      const body: Record<string, number> = {};
      if (cpus !== vm.cpus) body.cpus = cpus;
      if (Math.round(memoryGb * 1024) !== vm.memoryMb) body.memoryMb = Math.round(memoryGb * 1024);
      if (diskGb > Math.round(vm.diskGb)) body.diskGb = diskGb;
      await api('PATCH', `/v1/vms/${vm.id}`, body);
      await reload();
      toast.success('Saved', vm.state === 'running' ? 'Processors and memory change at its next start; the disk grows now (grow the partition inside it too).' : undefined);
    });
  return (
    <Grid cols={2}>
      <Card title="Size">
        <div className="fx-form">
          <Grid cols={3}>
            <Field label="Processors">
              <Select value={String(cpus)} disabled={!op} onChange={(e) => setCpus(Number(e.target.value))} options={Array.from({ length: Math.min(64, threads) }, (_, i) => String(i + 1))} />
            </Field>
            <Field label="Memory (GB)">
              <Input type="number" min={0.25} step={0.25} disabled={!op} value={memoryGb} onChange={(e) => setMemoryGb(Number(e.target.value))} />
            </Field>
            <Field label="Disk (GB)" help="Grows only.">
              <Input type="number" min={Math.round(vm.diskGb)} disabled={!op} value={diskGb} onChange={(e) => setDiskGb(Math.round(Number(e.target.value)))} />
            </Field>
          </Grid>
          {op && (
            <Button variant="primary" disabled={!changed} loading={busy === 'save'} onClick={() => void save()}>
              Save
            </Button>
          )}
        </div>
      </Card>
      <Card title="CD drive and start-up">
        <div className="fx-form">
          <Field label="In the CD drive">
            <Select
              value={vm.isoName ?? ''}
              disabled={!op}
              onChange={(e) => void run('iso', async () => { await api('PATCH', `/v1/vms/${vm.id}`, { iso: e.target.value || null }); await reload(); }, e.target.value ? `${e.target.value} inserted` : 'Ejected')}
              options={[{ value: '', label: 'Empty' }, ...(isos.data?.isos ?? []).map((i) => ({ value: i.name, label: i.name }))]}
            />
          </Field>
          <Toggle checked={vm.autostart} disabled={!op} onChange={(on) => void run('auto', async () => { await api('PATCH', `/v1/vms/${vm.id}`, { autostart: on }); await reload(); })} label="Start with the server" />
        </div>
      </Card>
      {app.can('admin') && (
        <Card title="Delete">
          <div className="fx-form">
            <Toggle checked={deleteDisks} onChange={setDeleteDisks} label="Delete its disks too" />
            <Button
              variant="danger-solid"
              icon="trash"
              disabled={vm.state !== 'stopped'}
              title={vm.state !== 'stopped' ? 'Turn it off first' : undefined}
              loading={busy === 'delete'}
              onClick={async () => {
                if (await confirm({ title: `Delete ${vm.name}?`, body: deleteDisks ? 'The machine, its snapshots and its disks are removed for good.' : 'The machine and its snapshots are removed; its disks stay in storage.', confirmLabel: 'Delete', danger: true }))
                  await run('delete', async () => { await api('DELETE', `/v1/vms/${vm.id}?disks=${deleteDisks ? 1 : 0}`); toast.success(`${vm.name} deleted`); go('vms'); });
              }}
            >
              Delete virtual machine
            </Button>
            {vm.state !== 'stopped' && <div className="fx-help">Turn it off first.</div>}
          </div>
        </Card>
      )}
      {dialog}
    </Grid>
  );
}
