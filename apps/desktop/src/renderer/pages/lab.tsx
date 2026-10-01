import { useState } from 'react';
import type { LabStatus, VmInfo, VmSpec } from '@fbrx/shared';
import { Button, Callout, Card, Empty, Field, Grid, Input, Modal, Page, Select, Spinner, StatTile, Status, Toggle, formatDuration, useAction, useConfirm, useToast, Table } from '@fbrx/ui';
import { call, pickFile } from '../client';
import { useCore } from '../hooks';
import { IS_WINDOWS } from '../app';

const FEATURE: Record<string, { key: keyof LabStatus; label: string; help: string }> = {
  'Microsoft-Hyper-V-All': { key: 'hyperv', label: 'Hyper-V', help: 'Full virtual machines (Windows Pro, Enterprise or Education)' },
  'Containers-DisposableClientVM': { key: 'sandbox', label: 'Windows Sandbox', help: 'Throw-away desktop for trying unknown files and sites' },
  VirtualMachinePlatform: { key: 'vmPlatform', label: 'Virtual Machine Platform', help: 'Needed by WSL 2 and Android apps' },
  'Microsoft-Windows-Subsystem-Linux': { key: 'wsl', label: 'Windows Subsystem for Linux', help: 'Run Linux tools on Windows' },
};

function NewVm({ onClose }: { onClose: () => void }) {
  const [spec, setSpec] = useState<VmSpec>({ name: 'Lab VM', os: 'windows', cpus: 2, memoryGB: 4, diskGB: 64, network: 'isolated', hardened: true });
  const { run, busy } = useAction();
  const toast = useToast();
  return (
    <Modal
      title="New virtual machine"
      description="Created with Hyper-V (generation 2, secure boot, a starting checkpoint)."
      wide
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            loading={busy === 'create'}
            onClick={async () => {
              const r = await run('create', () => call('lab.createVm', spec));
              if (r) {
                (r.ok ? toast.success : toast.warning)(r.ok ? 'VM created' : 'Could not create the VM', r.output.slice(-300));
                if (r.ok) onClose();
              }
            }}
          >
            Create
          </Button>
        </>
      }
    >
      <div className="fx-grid">
        <div className="fx-row">
          <Field label="Name">
            <Input value={spec.name} onChange={(e) => setSpec({ ...spec, name: e.target.value })} />
          </Field>
          <Field label="Operating system">
            <Select value={spec.os} onChange={(e) => setSpec({ ...spec, os: e.target.value as 'windows' })} options={[{ value: 'windows', label: 'Windows (adds a virtual TPM)' }, { value: 'linux', label: 'Linux' }]} />
          </Field>
        </div>
        <div className="fx-row">
          <Field label="Processors">
            <Input type="number" min={1} max={32} value={spec.cpus} onChange={(e) => setSpec({ ...spec, cpus: Number(e.target.value) })} />
          </Field>
          <Field label="Memory (GB)">
            <Input type="number" min={1} max={64} value={spec.memoryGB} onChange={(e) => setSpec({ ...spec, memoryGB: Number(e.target.value) })} />
          </Field>
          <Field label="Disk (GB)">
            <Input type="number" min={10} max={2000} value={spec.diskGB} onChange={(e) => setSpec({ ...spec, diskGB: Number(e.target.value) })} />
          </Field>
        </div>
        <Field label="Network" help="Isolated: the VM can only see other VMs on the FBRX-Isolated switch. Internet: through Hyper-V's Default Switch.">
          <Select value={spec.network} onChange={(e) => setSpec({ ...spec, network: e.target.value as VmSpec['network'] })} options={[{ value: 'isolated', label: 'Isolated (recommended for testing)' }, { value: 'internet', label: 'Internet' }, { value: 'none', label: 'No network' }]} />
        </Field>
        <Field label="Install disc (.iso)">
          <div className="fx-actions">
            <Input value={spec.iso ?? ''} placeholder="Optional" onChange={(e) => setSpec({ ...spec, iso: e.target.value || undefined })} />
            <Button onClick={async () => { const p = await pickFile({ kind: 'file', title: 'Install disc', filters: [{ name: 'Disc image', extensions: ['iso'] }] }); if (p) setSpec({ ...spec, iso: p }); }}>Browse…</Button>
          </div>
        </Field>
        <Toggle checked={!!spec.hardened} onChange={(v) => setSpec({ ...spec, hardened: v })} label="Hardened: no file copy from the guest and no automatic checkpoints" />
      </div>
    </Modal>
  );
}

export function LabPage() {
  const status = useCore('lab.status');
  const [elevatedList, setElevatedList] = useState<{ vms: VmInfo[]; error: string | null } | null>(null);
  const vms = useCore('lab.vms');
  const [creating, setCreating] = useState(false);
  const { run, busy } = useAction();
  const { confirm, dialog } = useConfirm();
  const toast = useToast();
  if (!IS_WINDOWS) {
    return (
      <Page title="Virtual lab" description="Virtual machines and Windows Sandbox for safe testing.">
        <Callout tone="info">The virtual lab uses Hyper-V and is available on Windows.</Callout>
      </Page>
    );
  }
  const s = status.data;
  const list = elevatedList ?? vms.data;
  const act = async (vm: VmInfo, action: 'start' | 'stop' | 'off' | 'save' | 'checkpoint' | 'revert' | 'isolate' | 'internet' | 'disconnect' | 'delete', arg?: string) => {
    if (action === 'delete' && !(await confirm({ title: `Delete ${vm.name}?`, body: 'The VM and its checkpoints are removed. Its virtual disk is deleted too.', danger: true, confirmLabel: 'Delete' }))) return;
    if (action === 'revert' && !(await confirm({ title: `Revert ${vm.name}?`, body: 'Goes back to the latest checkpoint. Changes since then are lost.', danger: true, confirmLabel: 'Revert' }))) return;
    const r = await run(`${vm.name}${action}`, () => call('lab.vmAction', { name: vm.name, action, arg: action === 'delete' ? 'disks' : arg }));
    if (r) (r.ok ? toast.success : toast.warning)(vm.name, r.output.slice(-200));
    setElevatedList(null);
    vms.reload();
  };
  return (
    <Page
      title="Virtual lab"
      description="Hyper-V virtual machines with isolated networking and checkpoints, plus Windows Sandbox."
      actions={
        <>
          <Button icon="external" onClick={() => void run('m', () => call('lab.openManager'))}>
            Hyper-V Manager
          </Button>
          <Button variant="primary" icon="plus" disabled={s?.hyperv !== 'enabled'} onClick={() => setCreating(true)}>
            New VM
          </Button>
        </>
      }
    >
      {status.error && <Callout tone="warning">{status.error}</Callout>}
      {s && (
        <>
          <Grid cols={4}>
            <StatTile label="Edition" value={s.edition.replace('Microsoft ', '')} foot={s.admin ? 'Running as administrator' : 'Standard user'} />
            <StatTile label="Virtualization in firmware" value={s.virtualizationFirmware == null ? 'Unknown' : s.virtualizationFirmware ? 'On' : 'Off'} foot={s.virtualizationFirmware === false ? 'Turn on VT-x / AMD-V in the BIOS' : ''} />
          </Grid>
          <Card title="Windows features" flush>
            <div className="fx-list">
              {Object.entries(FEATURE).map(([id, f]) => {
                const st = s[f.key] as LabStatus['hyperv'];
                return (
                  <div key={id} className="fx-list-item">
                    <div style={{ flex: 1 }}>
                      <div className="fx-cell-title">{f.label}</div>
                      <div className="fx-cell-sub">{f.help}</div>
                    </div>
                    <Status tone={st === 'enabled' ? 'good' : st === 'disabled' ? 'neutral' : 'warning'}>{st === 'unavailable' ? 'not available' : st}</Status>
                    {st === 'disabled' && (
                      <Button
                        size="sm"
                        loading={busy === id}
                        onClick={async () => {
                          const r = await run(id, () => call('lab.enableFeature', { feature: id as 'VirtualMachinePlatform' }));
                          if (r) (r.ok ? toast.success : toast.warning)(`${f.label}`, 'Restart Windows to finish.');
                          status.reload();
                        }}
                      >
                        Turn on
                      </Button>
                    )}
                  </div>
                );
              })}
            </div>
          </Card>
        </>
      )}
      {!s && !status.error && <Spinner />}
      {s?.hyperv === 'enabled' && (
        <Card
          title="Virtual machines"
          actions={
            list?.error === 'needs-admin' && (
              <Button size="sm" loading={busy === 'elev'} onClick={() => void run('elev', () => call('lab.vms', { elevated: true })).then((r) => r && setElevatedList(r))}>
                Show with administrator rights
              </Button>
            )
          }
          flush
        >
          {list?.error === 'needs-admin' ? (
            <Callout tone="info">Seeing virtual machines needs administrator rights (or membership of the Hyper-V Administrators group).</Callout>
          ) : (
            <Table
              columns={[
                { key: 'n', header: 'Name', render: (v) => <strong>{v.name}</strong> },
                { key: 's', header: 'State', render: (v) => <Status tone={v.state === 'Running' ? 'good' : v.state === 'Saved' ? 'info' : 'neutral'}>{v.state}</Status> },
                { key: 'r', header: 'Resources', render: (v) => <span className="fx-muted">{v.cpus} vCPU · {v.memoryMB ? `${(v.memoryMB / 1024).toFixed(1)} GB` : '—'}{v.state === 'Running' ? ` · ${v.cpuUsage}% CPU · up ${formatDuration(v.uptimeSeconds)}` : ''}</span> },
                { key: 'net', header: 'Network', render: (v) => <Status tone={v.network === 'FBRX-Isolated' ? 'good' : v.network === 'Not connected' ? 'neutral' : 'warning'}>{v.network}</Status> },
                { key: 'c', header: 'Checkpoints', render: (v) => v.checkpoints, width: 100 },
                {
                  key: 'a',
                  header: '',
                  render: (v) => (
                    <div className="fx-actions">
                      {v.state === 'Running' ? (
                        <>
                          <Button size="sm" onClick={() => void act(v, 'stop')}>Shut down</Button>
                          <Button size="sm" variant="ghost" onClick={() => void act(v, 'save')}>Save</Button>
                        </>
                      ) : (
                        <Button size="sm" variant="primary" onClick={() => void act(v, 'start')}>Start</Button>
                      )}
                      <Button size="sm" variant="ghost" onClick={() => void act(v, 'checkpoint')}>Checkpoint</Button>
                      {v.checkpoints > 0 && <Button size="sm" variant="ghost" onClick={() => void act(v, 'revert')}>Revert</Button>}
                      {v.network !== 'FBRX-Isolated' ? <Button size="sm" variant="ghost" onClick={() => void act(v, 'isolate')}>Isolate</Button> : <Button size="sm" variant="ghost" onClick={() => void act(v, 'internet')}>Internet</Button>}
                      <Button size="sm" variant="ghost" icon="trash" aria-label={`Delete ${v.name}`} onClick={() => void act(v, 'delete')} />
                    </div>
                  ),
                },
              ]}
              rows={list?.vms ?? []}
              rowKey={(v) => v.name}
              empty={<Empty title={list ? 'No virtual machines yet' : 'Reading…'} action={<Button icon="plus" onClick={() => setCreating(true)}>Create one</Button>} />}
            />
          )}
        </Card>
      )}
      {creating && <NewVm onClose={() => (setCreating(false), vms.reload())} />}
      {dialog}
    </Page>
  );
}
