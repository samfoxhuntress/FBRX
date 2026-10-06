import { useEffect, useMemo, useState } from 'react';
import type { HostInfo, IsoImage, VirtualNetwork, VmCreateSpec, VmDetail, VmSummary } from '@fbrx/shared';
import { Button, Callout, Card, ChoiceCards, Empty, Field, formatDuration, Grid, Input, Modal, Page, Select, Table, TextArea, Toggle, useAction, useToast } from '@fbrx/ui';
import { api } from '../api';
import { useApp, usePoll, useRoute } from '../state';
import { gb, mb, osName, Pct, PowerButtons, VmStateBadge } from './common';

export function VmsPage() {
  const app = useApp();
  const [route, go] = useRoute();
  const vms = usePoll<{ vms: VmSummary[] }>('/v1/vms', 4000);
  const [filter, setFilter] = useState('');
  const creating = route.id === 'new';
  const list = (vms.data?.vms ?? []).filter((v) => !filter || `${v.name} ${v.description} ${v.ip ?? ''}`.toLowerCase().includes(filter.toLowerCase()));
  return (
    <Page
      title="Virtual machines"
      description="Every machine on this server. Click one for its screen, snapshots and settings."
      actions={
        app.can('operator') && (
          <Button variant="primary" icon="plus" onClick={() => go('vms', 'new')}>
            New virtual machine
          </Button>
        )
      }
    >
      <Card flush>
        <div style={{ padding: 12 }}>
          <Input placeholder="Find by name, description or address" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Find" />
        </div>
        <Table
          rows={list}
          rowKey={(v) => v.id}
          onRowClick={(v) => go('vm', v.id)}
          empty={
            <Empty title={vms.data ? 'No virtual machines yet' : 'Loading…'}>
              {vms.data && 'Make one from an ISO in the library (Storage & ISOs).'}
            </Empty>
          }
          columns={[
            { key: 'name', header: 'Name', render: (v) => <div><div className="fx-cell-title">{v.name}{v.autostart && <span className="fx-badge" style={{ marginLeft: 6 }} title="Starts with the server">auto</span>}</div><div className="fx-cell-sub">{v.description || osName(v.os)}</div></div> },
            { key: 'state', header: 'State', render: (v) => <VmStateBadge state={v.state} /> },
            { key: 'size', header: 'Size', render: (v) => <span>{v.cpus} CPU · {mb(v.memoryMb)} · {gb(v.diskGb)}</span> },
            { key: 'cpu', header: 'Processor', render: (v) => <Pct value={v.cpuPct} /> },
            { key: 'mem', header: 'Memory used', render: (v) => (v.memoryUsedMb == null ? '—' : mb(v.memoryUsedMb)) },
            { key: 'ip', header: 'Address', render: (v) => <span className="mono">{v.ip ?? '—'}</span> },
            { key: 'up', header: 'Up for', render: (v) => (v.uptimeSeconds == null ? '—' : formatDuration(v.uptimeSeconds)) },
            { key: 'power', header: '', render: (v) => <PowerButtons vm={v} size="sm" onDone={() => void vms.reload()} /> },
          ]}
        />
      </Card>
      {creating && (
        <NewVmModal
          onClose={() => go('vms')}
          onCreated={(vm) => {
            void vms.reload();
            go('vm', vm.id);
          }}
        />
      )}
    </Page>
  );
}

const PRESETS: Record<VmCreateSpec['os'], { cpus: number; memoryGb: number; diskGb: number; secureBoot: boolean; tpm: boolean }> = {
  linux: { cpus: 2, memoryGb: 2, diskGb: 20, secureBoot: false, tpm: false },
  windows: { cpus: 4, memoryGb: 8, diskGb: 80, secureBoot: true, tpm: true },
  other: { cpus: 1, memoryGb: 1, diskGb: 8, secureBoot: false, tpm: false },
};

function NewVmModal({ onClose, onCreated }: { onClose: () => void; onCreated: (vm: VmDetail) => void }) {
  const toast = useToast();
  const { busy, run } = useAction();
  const host = usePoll<HostInfo>('/v1/host', 60000);
  const isos = usePoll<{ isos: IsoImage[] }>('/v1/isos', 60000);
  const nets = usePoll<{ networks: VirtualNetwork[] }>('/v1/networks', 60000);
  const [os, setOs] = useState<VmCreateSpec['os']>('linux');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [cpus, setCpus] = useState(2);
  const [memoryGb, setMemoryGb] = useState(2);
  const [diskGb, setDiskGb] = useState(20);
  const [iso, setIso] = useState('');
  const [firmware, setFirmware] = useState<'uefi' | 'bios'>('uefi');
  const [secureBoot, setSecureBoot] = useState(false);
  const [tpm, setTpm] = useState(false);
  const [network, setNetwork] = useState('network:default');
  const [startNow, setStartNow] = useState(true);
  const [autostart, setAutostart] = useState(false);

  useEffect(() => {
    const p = PRESETS[os];
    setCpus(p.cpus);
    setMemoryGb(p.memoryGb);
    setDiskGb(p.diskGb);
    setSecureBoot(p.secureBoot);
    setTpm(p.tpm);
    if (os === 'windows') setFirmware('uefi');
  }, [os]);

  const h = host.data;
  const threads = h?.cpu.threads ?? 8;
  const freeGb = h ? Math.max(1, Math.floor((h.memory.totalMb - h.memory.usedMb) / 1024)) : null;
  const netOptions = useMemo(
    () =>
      (nets.data?.networks ?? [])
        .filter((n) => n.active && n.kind !== 'other')
        .map((n) => ({ value: `${n.managed ? 'network' : 'bridge'}:${n.name}`, label: n.managed ? `${n.name} (${n.kind === 'nat' ? 'private, internet through the server' : n.kind === 'isolated' ? 'machines only' : 'bridge'}${n.subnet ? `, ${n.subnet}` : ''})` : `${n.name} (straight onto the network${n.ports.length ? ` via ${n.ports.join(', ')}` : ''})` })),
    [nets.data],
  );
  const validName = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/.test(name);
  const create = () =>
    run('create', async () => {
      const [kind, source] = network.split(':') as ['network' | 'bridge', string];
      const spec: VmCreateSpec = { name, os, cpus, memoryMb: Math.round(memoryGb * 1024), diskGb, iso: iso || null, network: { kind, source }, firmware, secureBoot: firmware === 'uefi' && secureBoot, tpm, startNow, autostart, description: description.trim() || undefined };
      const vm = await api<VmDetail>('POST', '/v1/vms', spec);
      toast.success(`${vm.name} is ready`, startNow ? 'Open its screen to install the operating system.' : undefined);
      onCreated(vm);
    });

  return (
    <Modal
      wide
      title="New virtual machine"
      description="A machine with a fresh disk. Put an installer ISO in its CD drive and open its screen to install."
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" icon="plus" loading={busy === 'create'} disabled={!validName || !network} onClick={() => void create()}>
            Create{startNow ? ' and start' : ''}
          </Button>
        </>
      }
    >
      <div className="fx-form">
        <ChoiceCards
          label="Operating system"
          value={os}
          onChange={setOs}
          options={[
            { value: 'linux', title: 'Linux', description: 'Fast virtual disk and network (virtio).', icon: 'terminal' },
            { value: 'windows', title: 'Windows', description: 'Installs without extra drivers; Secure Boot and TPM for Windows 11.', icon: 'laptop' },
            { value: 'other', title: 'Something else', description: 'Firewalls, appliances, older systems.', icon: 'box' },
          ]}
        />
        <Grid cols={2}>
          <Field label="Name" error={name && !validName ? 'Letters, digits, dots, dashes and underscores' : undefined}>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={os === 'windows' ? 'win11-desk' : 'files-01'} autoFocus />
          </Field>
          <Field label="Description">
            <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What it is for" />
          </Field>
        </Grid>
        <Grid cols={3}>
          <Field label="Processors" help={`This server has ${threads} threads.`}>
            <Select value={String(cpus)} onChange={(e) => setCpus(Number(e.target.value))} options={Array.from({ length: Math.min(64, threads) }, (_, i) => String(i + 1))} />
          </Field>
          <Field label="Memory (GB)" help={freeGb !== null ? `About ${freeGb} GB free now.` : undefined}>
            <Input type="number" min={0.25} step={0.25} value={memoryGb} onChange={(e) => setMemoryGb(Number(e.target.value))} />
          </Field>
          <Field label="Disk (GB)" help="Grows as it fills (thin).">
            <Input type="number" min={1} value={diskGb} onChange={(e) => setDiskGb(Math.max(1, Math.round(Number(e.target.value))))} />
          </Field>
        </Grid>
        <Grid cols={2}>
          <Field label="Install from" help={(isos.data?.isos.length ?? 0) === 0 ? 'The ISO library is empty: add installers in Storage & ISOs.' : 'Put in the virtual CD drive.'}>
            <Select value={iso} onChange={(e) => setIso(e.target.value)} options={[{ value: '', label: 'Nothing (empty CD drive)' }, ...(isos.data?.isos ?? []).map((i) => ({ value: i.name, label: i.name }))]} />
          </Field>
          <Field label="Network">
            <Select value={network} onChange={(e) => setNetwork(e.target.value)} options={netOptions.length ? netOptions : [{ value: 'network:default', label: 'default' }]} />
          </Field>
        </Grid>
        <Grid cols={2}>
          <Field label="Firmware" help="UEFI for anything modern; BIOS for old systems.">
            <Select value={firmware} onChange={(e) => setFirmware(e.target.value as 'uefi' | 'bios')} options={[{ value: 'uefi', label: 'UEFI' }, { value: 'bios', label: 'BIOS (legacy)' }]} />
          </Field>
          <div style={{ display: 'grid', gap: 8, alignContent: 'end' }}>
            <Toggle checked={firmware === 'uefi' && secureBoot} disabled={firmware !== 'uefi'} onChange={setSecureBoot} label="Secure Boot" />
            <Toggle checked={tpm} onChange={setTpm} disabled={h ? !h.hypervisor.tpm : false} label={h && !h.hypervisor.tpm ? 'Virtual TPM (not installed on this server)' : 'Virtual TPM'} />
          </div>
        </Grid>
        <div className="fx-row" style={{ gap: 18 }}>
          <Toggle checked={startNow} onChange={setStartNow} label="Start it now" />
          <Toggle checked={autostart} onChange={setAutostart} label="Start with the server" />
        </div>
        {firmware === 'uefi' && <div className="fx-help">UEFI machines are snapshotted while turned off (their firmware settings live outside the disk).</div>}
        {h && !h.hypervisor.kvm && h.hypervisor.driver === 'libvirt' && <Callout tone="warning">Without processor virtualization this machine runs in slow software emulation. Turn it on under Server & BIOS.</Callout>}
      </div>
    </Modal>
  );
}

export function DescriptionEditor({ value, onSave }: { value: string; onSave: (v: string) => Promise<void> }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return (
    <div className="fx-form">
      <TextArea rows={2} value={v} onChange={(e) => setV(e.target.value)} />
      {v !== value && (
        <Button size="sm" onClick={() => void onSave(v)}>
          Save description
        </Button>
      )}
    </div>
  );
}
