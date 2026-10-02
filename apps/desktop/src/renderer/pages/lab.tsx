import { useRef, useState, type ReactNode } from 'react';
import type { LabStatus, VmInfo, VmSpec } from '@fbrx/shared';
import { Button, Callout, Card, Empty, Field, Icons, Input, Modal, Page, Select, Spinner, Status, Tabs, Toggle, formatBytes, formatDuration, useAction, useConfirm, useToast } from '@fbrx/ui';
import { call, openExternal, pickFile } from '../client';
import { useCore } from '../hooks';
import { IS_WINDOWS } from '../app';
import { useLive } from './dashboard';
import { AskButton, askAgent } from '../widgets';

const FEATURE: Record<string, { key: keyof LabStatus; label: string; help: string }> = {
  'Microsoft-Hyper-V-All': { key: 'hyperv', label: 'Hyper-V', help: 'Full virtual machines with checkpoints and private networks (Windows Pro, Enterprise or Education)' },
  'Containers-DisposableClientVM': { key: 'sandbox', label: 'Windows Sandbox', help: 'A disposable Windows desktop that is wiped when closed' },
  VirtualMachinePlatform: { key: 'vmPlatform', label: 'Virtual Machine Platform', help: 'Needed by WSL 2 and Android apps' },
  'Microsoft-Windows-Subsystem-Linux': { key: 'wsl', label: 'Windows Subsystem for Linux', help: 'Run Linux command-line tools natively' },
};

interface Template extends Omit<VmSpec, 'name' | 'iso'> {
  id: string;
  name: string;
  tag: 'Security' | 'Malware lab' | 'General' | 'Custom';
  url: string;
  note: string;
}

/** Ready-made VM shapes. Download pages are the projects' own. */
export const TEMPLATES: Template[] = [
  { id: 'kali', name: 'Kali Linux', tag: 'Security', os: 'linux', cpus: 2, memoryGB: 4, diskGB: 80, network: 'isolated', hardened: true, url: 'https://www.kali.org/get-kali/', note: 'Penetration-testing distribution. Download the 64-bit Installer ISO.' },
  { id: 'remnux', name: 'REMnux', tag: 'Malware lab', os: 'linux', cpus: 2, memoryGB: 4, diskGB: 60, network: 'none', hardened: true, url: 'https://docs.remnux.org/install-distro/get-virtual-appliance', note: 'Malware-analysis toolkit. On Hyper-V: install Ubuntu, then run the REMnux installer.' },
  { id: 'flare', name: 'FLARE-VM', tag: 'Malware lab', os: 'windows', cpus: 4, memoryGB: 8, diskGB: 100, network: 'none', hardened: true, url: 'https://github.com/mandiant/flare-vm', note: 'Reverse-engineering toolkit on Windows. Install Windows, checkpoint, then run the FLARE-VM installer.' },
  { id: 'parrot', name: 'Parrot Security', tag: 'Security', os: 'linux', cpus: 2, memoryGB: 4, diskGB: 60, network: 'isolated', hardened: true, url: 'https://www.parrotsec.org/download/', note: 'Security and privacy distribution (Security edition).' },
  { id: 'ubuntu', name: 'Ubuntu Desktop', tag: 'General', os: 'linux', cpus: 2, memoryGB: 4, diskGB: 60, network: 'internet', hardened: false, url: 'https://ubuntu.com/download/desktop', note: 'General-purpose Linux for development and learning.' },
  { id: 'win11', name: 'Windows 11 test machine', tag: 'General', os: 'windows', cpus: 4, memoryGB: 8, diskGB: 80, network: 'internet', hardened: false, url: 'https://www.microsoft.com/en-us/evalcenter/evaluate-windows-11-enterprise', note: 'Free 90-day Enterprise evaluation from Microsoft. A virtual TPM is added automatically.' },
  { id: 'custom', name: 'Custom VM', tag: 'Custom', os: 'linux', cpus: 2, memoryGB: 4, diskGB: 60, network: 'isolated', hardened: true, url: '', note: 'Any install disc you already have.' },
];

const NET_LABEL: Record<VmSpec['network'], string> = { isolated: 'Isolated (VMs only, no host or internet)', internet: 'Internet (through the Default Switch)', none: 'No network (air-gapped)' };

/** What this PC has spare right now, for sizing VMs. */
interface Capacity {
  cores: number;
  memTotal: number;
  memFree: number;
  cpu: number;
  diskFree: number;
  diskSize: number;
  diskMount: string;
}

function useCapacity(): Capacity | null {
  const live = useLive();
  const info = useCore('sysinfo.static');
  const cur = live[live.length - 1];
  if (!cur || !info.data) return null;
  const disks = info.data.disks;
  const sys = disks.find((d) => /^c:?\\?$/i.test(d.mount) || d.mount === '/') ?? disks[0];
  return { cores: info.data.cpu.cores, memTotal: cur.memTotal, memFree: cur.memTotal - cur.memUsed, cpu: cur.cpu, diskFree: sys ? sys.size - sys.used : 0, diskSize: sys?.size ?? 0, diskMount: sys?.mount ?? '' };
}

const GB = 1024 ** 3;
/** Whether a VM of this size fits next to what is running now (keeps 2 GB and a core for Windows itself). */
export function vmFit(c: Capacity, t: Pick<VmSpec, 'cpus' | 'memoryGB' | 'diskGB'>): { level: 'good' | 'tight' | 'no'; why: string } {
  const memLeft = c.memFree / GB - t.memoryGB;
  const diskNeed = Math.min(t.diskGB, 25);
  if (memLeft < 0.5) return { level: 'no', why: `needs ${t.memoryGB} GB memory, ${(c.memFree / GB).toFixed(1)} GB free` };
  if (c.diskFree / GB < diskNeed) return { level: 'no', why: `needs about ${diskNeed} GB disk to start, ${(c.diskFree / GB).toFixed(0)} GB free` };
  if (t.cpus > c.cores) return { level: 'no', why: `asks for ${t.cpus} processors, this PC has ${c.cores}` };
  if (memLeft < 2 || t.cpus >= c.cores || c.cpu > 75) return { level: 'tight', why: memLeft < 2 ? `leaves ${memLeft.toFixed(1)} GB for Windows` : c.cpu > 75 ? 'the processor is busy right now' : 'uses every processor' };
  return { level: 'good', why: `leaves ${memLeft.toFixed(1)} GB memory free` };
}

/** A half-circle gauge with a needle. */
function MiniGauge({ label, pct, value, sub }: { label: string; pct: number; value: string; sub: string }) {
  const p = Math.max(0, Math.min(100, pct));
  const tone = p >= 90 ? 'var(--critical)' : p >= 75 ? 'var(--warning)' : 'var(--good)';
  const r = 52;
  const len = Math.PI * r;
  return (
    <div className="mini-gauge">
      <svg viewBox="0 0 130 78" width="100%" aria-label={`${label}: ${value}`} role="img">
        <path d="M13 70 A52 52 0 0 1 117 70" fill="none" stroke="currentColor" strokeOpacity="0.12" strokeWidth="11" strokeLinecap="round" />
        <path d="M13 70 A52 52 0 0 1 117 70" fill="none" stroke={tone} strokeWidth="11" strokeLinecap="round" strokeDasharray={`${(len * p) / 100} ${len}`} style={{ transition: 'stroke-dasharray 0.6s ease' }} />
        <g style={{ transform: `rotate(${-90 + (180 * p) / 100}deg)`, transformOrigin: '65px 70px', transition: 'transform 0.6s cubic-bezier(0.34, 1.4, 0.64, 1)' }}>
          <path d="M63 70 L65 26 L67 70 Z" fill="currentColor" opacity="0.8" />
        </g>
        <circle cx="65" cy="70" r="5" fill="currentColor" opacity="0.85" />
      </svg>
      <div className="mini-gauge-value">{value}</div>
      <div className="mini-gauge-label">{label}</div>
      <div className="mini-gauge-sub">{sub}</div>
    </div>
  );
}

function CapacityCard({ c }: { c: Capacity | null }) {
  if (!c) {
    return (
      <Card title="Room for a VM">
        <Spinner />
      </Card>
    );
  }
  const memPct = ((c.memTotal - c.memFree) / c.memTotal) * 100;
  const diskPct = c.diskSize ? ((c.diskSize - c.diskFree) / c.diskSize) * 100 : 0;
  const sizes = [
    { label: 'Small Linux VM', cpus: 2, memoryGB: 2, diskGB: 30 },
    { label: 'Linux desktop', cpus: 2, memoryGB: 4, diskGB: 60 },
    { label: 'Windows 11 VM', cpus: 4, memoryGB: 8, diskGB: 80 },
    { label: 'Two VMs at once', cpus: 4, memoryGB: 12, diskGB: 120 },
  ];
  return (
    <Card
      title="Room for a VM"
      subtitle="Live: what this PC is using now and what a virtual machine would leave for Windows"
      actions={<AskButton label="What can I run?" prompt="Here is how much processor, memory and disk this PC has free right now. Which virtual machines can I comfortably run in Hyper-V at the same time, how should I size them, and what should I close first if it's tight?" context={{ cores: c.cores, memoryFreeGB: +(c.memFree / GB).toFixed(1), memoryTotalGB: +(c.memTotal / GB).toFixed(1), cpuBusyPct: Math.round(c.cpu), systemDriveFreeGB: Math.round(c.diskFree / GB) }} />}
    >
      <div className="cap-layout">
        <div className="cap-gauges">
          <MiniGauge label="Processor" pct={c.cpu} value={`${c.cpu.toFixed(0)}%`} sub={`${c.cores} logical processors`} />
          <MiniGauge label="Memory" pct={memPct} value={`${(c.memFree / GB).toFixed(1)} GB free`} sub={`of ${formatBytes(c.memTotal)}`} />
          <MiniGauge label={`Drive ${c.diskMount}`} pct={diskPct} value={`${formatBytes(c.diskFree)} free`} sub={`of ${formatBytes(c.diskSize)}`} />
        </div>
        <div className="cap-fits">
          {sizes.map((z) => {
            const f = vmFit(c, z);
            return (
              <div key={z.label} className={`cap-fit ${f.level}`}>
                <span className="cap-dot" aria-hidden />
                <div>
                  <b>{z.label}</b>
                  <span>
                    {z.cpus} vCPU · {z.memoryGB} GB · {f.level === 'good' ? 'fits' : f.level === 'tight' ? 'tight' : "won't fit now"}: {f.why}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </Card>
  );
}

function Check({ ok, title, sub, action }: { ok: boolean | null; title: string; sub?: string; action?: ReactNode }) {
  return (
    <div className="fx-list-item">
      <span className={`check-dot ${ok ? 'ok' : ok === false ? 'warn' : ''}`}>{ok ? <Icons.check size={14} /> : <Icons.alert size={14} />}</span>
      <div style={{ flex: 1 }}>
        <div className="fx-cell-title">{title}</div>
        {sub && <div className="fx-cell-sub">{sub}</div>}
      </div>
      {action}
    </div>
  );
}

function Readiness({ s, c, reload }: { s: LabStatus; c: Capacity | null; reload: () => void }) {
  const { run, busy } = useAction();
  const toast = useToast();
  const home = /home/i.test(s.edition);
  const ramGB = c ? c.memTotal / GB : 0;
  return (
    <div className="lab-two">
      <Card title="This PC" flush>
        <div className="fx-list">
          <Check ok={!home} title={`Windows edition: ${s.edition.replace('Microsoft ', '')}`} sub={home ? 'Hyper-V and Windows Sandbox need Windows Pro, Enterprise or Education. On Home, use WSL, or upgrade in Settings → Activation.' : 'Supports Hyper-V and Windows Sandbox.'} action={home ? <Button size="sm" onClick={() => void call('spotlight.run', { item: { id: 'ms-settings:activation', kind: 'command', title: 'Activation', score: 0, action: { type: 'url', url: 'ms-settings:activation' } } })}>Activation</Button> : undefined} />
          <Check ok={s.virtualizationFirmware !== false} title={`Virtualization in firmware: ${s.virtualizationFirmware == null ? (s.hyperv === 'enabled' ? 'in use by Windows' : 'unknown') : s.virtualizationFirmware ? 'on' : 'off'}`} sub={s.virtualizationFirmware === false ? 'Turn on Intel VT-x or AMD SVM in the BIOS/UEFI setup (usually under Advanced or CPU configuration).' : 'Intel VT-x / AMD-V is available.'} />
          <Check ok={c ? ramGB >= 12 : null} title={`Memory: ${c ? `${ramGB.toFixed(0)} GB` : '…'}`} sub={ramGB >= 12 ? 'Enough for one or two VMs at a time.' : 'With less than 12 GB, run one small VM at a time and close big apps first.'} />
          <Check ok={c ? c.cores >= 4 : null} title={`Processors: ${c?.cores ?? '…'}`} sub={c && c.cores < 4 ? 'Give each VM 1–2 processors.' : 'Give most VMs 2 processors, Windows VMs 4.'} />
          <Check ok={s.admin} title={s.admin ? 'Running as administrator' : 'Standard account'} sub={s.admin ? undefined : 'VM actions show a Windows permission prompt. Joining the "Hyper-V Administrators" group avoids most of them.'} />
        </div>
      </Card>
      <Card title="Windows features" actions={<Button size="sm" variant="ghost" icon="external" onClick={() => openExternal('https://learn.microsoft.com/windows-server/virtualization/hyper-v/get-started/install-hyper-v')}>Microsoft guide</Button>} flush>
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
                      if (r) (r.ok ? toast.success : toast.warning)(f.label, r.ok ? 'Restart Windows to finish.' : r.output.slice(-200));
                      reload();
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
    </div>
  );
}

function VmCards({ c, onNew }: { c: Capacity | null; onNew: () => void }) {
  const vms = useCore('lab.vms');
  const [elevatedList, setElevatedList] = useState<{ vms: VmInfo[]; error: string | null } | null>(null);
  const [checkpointFor, setCheckpointFor] = useState<VmInfo | null>(null);
  const [cpName, setCpName] = useState('');
  const alsoDisk = useRef(true);
  const { run, busy } = useAction();
  const { confirm, dialog } = useConfirm();
  const toast = useToast();
  const list = elevatedList ?? vms.data;
  const act = async (vm: VmInfo, action: 'start' | 'stop' | 'off' | 'save' | 'checkpoint' | 'revert' | 'isolate' | 'internet' | 'disconnect' | 'delete', arg?: string) => {
    if (action === 'revert' && !(await confirm({ title: `Revert ${vm.name}?`, body: 'Goes back to the latest checkpoint. Changes since then are lost.', danger: true, confirmLabel: 'Revert' }))) return;
    if (action === 'delete') {
      alsoDisk.current = true;
      const ok = await confirm({
        title: `Delete ${vm.name}?`,
        body: (
          <>
            The VM and its checkpoints are removed.
            <label style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 10 }}>
              <input type="checkbox" defaultChecked onChange={(e) => (alsoDisk.current = e.target.checked)} /> Also delete its virtual hard disk
            </label>
          </>
        ),
        danger: true,
        confirmLabel: 'Delete',
      });
      if (!ok) return;
    }
    const r = await run(`${vm.name}${action}`, () => call('lab.vmAction', { name: vm.name, action, arg: action === 'delete' ? (alsoDisk.current ? 'disks' : undefined) : arg }));
    if (r) (r.ok ? toast.success : toast.warning)(vm.name, r.output.slice(-200));
    setElevatedList(null);
    vms.reload();
  };
  if (list?.error === 'not-installed') return <Empty title="Hyper-V is not turned on">Turn it on in the Readiness tab, then restart Windows.</Empty>;
  return (
    <>
      <div className="fx-actions" style={{ marginBottom: 4 }}>
        <b>{list ? `${list.vms.length} virtual machine${list.vms.length === 1 ? '' : 's'}` : 'Reading…'}</b>
        <span className="fx-spacer" />
        {list?.error === 'needs-admin' && (
          <Button size="sm" icon="shield" loading={busy === 'elev'} onClick={() => void run('elev', () => call('lab.vms', { elevated: true })).then((r) => r && setElevatedList(r))}>
            Show with administrator rights
          </Button>
        )}
        <Button size="sm" icon="refresh" onClick={() => (setElevatedList(null), vms.reload())}>
          Refresh
        </Button>
        <Button size="sm" variant="primary" icon="plus" onClick={onNew}>
          New safe VM
        </Button>
      </div>
      {list?.error === 'needs-admin' && <Callout tone="info">Your account isn't in "Hyper-V Administrators", so seeing virtual machines needs a Windows permission prompt.</Callout>}
      {list && list.vms.length ? (
        <div className="vm-grid">
          {list.vms.map((v) => {
            const running = v.state === 'Running';
            const net = v.network === 'FBRX-Isolated' ? 'isolated' : v.network === 'Not connected' ? 'unplugged' : v.network;
            return (
              <Card key={v.name} className="vm-card">
                <div className="vm-head">
                  <span className="vm-icon">
                    <Icons.box size={18} />
                  </span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="fx-cell-title">{v.name}</div>
                    <div className="fx-cell-sub">
                      {v.cpus} vCPU · {v.memoryMB ? `${(v.memoryMB / 1024).toFixed(1)} GB` : 'memory not assigned'}
                      {running ? ` · ${v.cpuUsage}% CPU · up ${formatDuration(v.uptimeSeconds)}` : ''} · Gen {v.generation} · {v.checkpoints} checkpoint{v.checkpoints === 1 ? '' : 's'}
                    </div>
                  </div>
                  <Status tone={running ? 'good' : v.state === 'Saved' ? 'info' : 'neutral'}>{v.state}</Status>
                </div>
                <div className="vm-net">
                  Network <Status tone={net === 'isolated' ? 'good' : net === 'unplugged' ? 'neutral' : 'warning'}>{net}</Status>
                  <select
                    className="fx-select vm-net-select"
                    aria-label={`Network for ${v.name}`}
                    value=""
                    onChange={(e) => e.target.value && void act(v, e.target.value as 'isolate')}
                  >
                    <option value="">Change…</option>
                    <option value="isolate">Isolate (VMs only)</option>
                    <option value="internet">Internet (NAT)</option>
                    <option value="disconnect">Unplug</option>
                  </select>
                </div>
                <div className="fx-actions vm-actions">
                  {running ? (
                    <>
                      <Button size="sm" icon="external" onClick={() => void run(`${v.name}c`, () => call('lab.openConsole', { name: v.name }))}>
                        Console
                      </Button>
                      <Button size="sm" loading={busy === `${v.name}stop`} onClick={() => void act(v, 'stop')}>
                        Shut down
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => void act(v, 'save')}>
                        Save
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => void act(v, 'off')}>
                        Power off
                      </Button>
                    </>
                  ) : (
                    <Button
                      size="sm"
                      variant="primary"
                      icon="play"
                      loading={busy === `${v.name}start`}
                      onClick={() => void act(v, 'start')}
                    >
                      Start
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" onClick={() => (setCpName(`Before ${new Date().toLocaleString()}`), setCheckpointFor(v))}>
                    Checkpoint
                  </Button>
                  {v.checkpoints > 0 && (
                    <Button size="sm" variant="ghost" onClick={() => void act(v, 'revert')}>
                      Revert
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" icon="trash" aria-label={`Delete ${v.name}`} onClick={() => void act(v, 'delete')} />
                </div>
              </Card>
            );
          })}
        </div>
      ) : list ? (
        <Empty title="No virtual machines yet" action={<Button icon="plus" onClick={onNew}>New safe VM</Button>}>
          Start from a template: security tools, a malware lab, or a clean Windows test machine.
        </Empty>
      ) : (
        <Spinner />
      )}
      {checkpointFor && (
        <Modal
          title={`Checkpoint ${checkpointFor.name}`}
          onClose={() => setCheckpointFor(null)}
          footer={
            <>
              <Button onClick={() => setCheckpointFor(null)}>Cancel</Button>
              <Button
                variant="primary"
                onClick={() => {
                  const v = checkpointFor;
                  setCheckpointFor(null);
                  void act(v, 'checkpoint', cpName.trim());
                }}
              >
                Create checkpoint
              </Button>
            </>
          }
        >
          <Field label="Name" help="A checkpoint saves the VM exactly as it is now; Revert goes back to the latest one.">
            <Input value={cpName} maxLength={100} onChange={(e) => setCpName(e.target.value)} />
          </Field>
        </Modal>
      )}
      {dialog}
    </>
  );
}

function NewVm({ t, c, onClose, onCreated }: { t: Template; c: Capacity | null; onClose: () => void; onCreated: () => void }) {
  const [spec, setSpec] = useState<VmSpec>({ name: `FBRX-${t.id === 'custom' ? 'Lab' : t.name.split(' ')[0]}`, os: t.os, cpus: t.cpus, memoryGB: t.memoryGB, diskGB: t.diskGB, network: t.network, hardened: t.hardened });
  const { run, busy } = useAction();
  const { confirm, dialog } = useConfirm();
  const toast = useToast();
  const fit = c ? vmFit(c, spec) : null;
  return (
    <Modal
      title={t.name}
      description={t.note}
      wide
      onClose={onClose}
      footer={
        <>
          <AskButton label="Setup guide" prompt={`Give me a step-by-step guide to set up a ${t.name} VM in Hyper-V for safe experimentation: where to download it (${t.url || 'my own install disc'}), installation tips for a Generation 2 VM (Secure Boot template, display resolution, enhanced session), hardening after the install, and safety rules. ${t.note}`} />
          <span className="fx-spacer" />
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            icon="plus"
            loading={busy === 'create'}
            onClick={async () => {
              if (!spec.iso && !(await confirm({ title: 'No install disc', body: 'The VM is created without an install disc. You can attach one later in Hyper-V Manager.', confirmLabel: 'Create anyway' }))) return;
              const r = await run('create', () => call('lab.createVm', spec));
              if (r) {
                (r.ok ? toast.success : toast.warning)(r.ok ? 'VM created' : 'Could not create the VM', r.output.slice(-300));
                if (r.ok) onCreated();
              }
            }}
          >
            Create VM
          </Button>
        </>
      }
    >
      <div className="fx-grid">
        {fit && (
          <Callout tone={fit.level === 'good' ? 'good' : fit.level === 'tight' ? 'warning' : 'critical'} title={fit.level === 'good' ? 'Fits comfortably right now' : fit.level === 'tight' ? 'It will be tight' : "This won't fit right now"}>
            {fit.why[0].toUpperCase() + fit.why.slice(1)}.
          </Callout>
        )}
        <div className="fx-row">
          <Field label="VM name">
            <Input value={spec.name} maxLength={60} onChange={(e) => setSpec({ ...spec, name: e.target.value })} />
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
          <Field label="Disk (GB, grows as needed)">
            <Input type="number" min={10} max={2000} value={spec.diskGB} onChange={(e) => setSpec({ ...spec, diskGB: Number(e.target.value) })} />
          </Field>
        </div>
        <Field label="Network">
          <Select value={spec.network} onChange={(e) => setSpec({ ...spec, network: e.target.value as VmSpec['network'] })} options={(['isolated', 'internet', 'none'] as const).map((n) => ({ value: n, label: NET_LABEL[n] }))} />
        </Field>
        <Field label="Install disc (.iso)">
          <div className="fx-actions">
            <Input value={spec.iso ?? ''} placeholder="C:\Users\you\Downloads\….iso" onChange={(e) => setSpec({ ...spec, iso: e.target.value || undefined })} />
            <Button
              onClick={async () => {
                const p = await pickFile({ kind: 'file', title: 'Install disc', filters: [{ name: 'Disc image', extensions: ['iso'] }] });
                if (p) setSpec({ ...spec, iso: p });
              }}
            >
              Browse…
            </Button>
            {t.url && (
              <Button variant="ghost" icon="external" onClick={() => openExternal(t.url)}>
                Get it
              </Button>
            )}
          </div>
        </Field>
        <Toggle checked={!!spec.hardened} onChange={(v) => setSpec({ ...spec, hardened: v })} label="Hardened: no guest file copy and no automatic checkpoints (recommended for malware)" />
        <div className="fx-muted" style={{ fontSize: 12.5 }}>
          FBRX creates a Generation 2 VM with Secure Boot {spec.os === 'linux' ? '(Linux UEFI template)' : 'and a virtual TPM'}, dynamic memory and a first checkpoint. Windows asks for permission.
        </div>
      </div>
      {dialog}
    </Modal>
  );
}

function Templates({ c, onPick }: { c: Capacity | null; onPick: (t: Template) => void }) {
  return (
    <div className="lib-grid">
      {TEMPLATES.map((t) => {
        const f = c ? vmFit(c, t) : null;
        return (
          <button key={t.id} className="choice vm-template" onClick={() => onPick(t)}>
            <span className="vm-template-head">
              <span className="vm-template-logo">{t.name.slice(0, 2)}</span>
              <span style={{ flex: 1 }}>
                <b>{t.name}</b>
                <span className="fx-muted" style={{ display: 'block', fontSize: 11.5 }}>
                  {t.tag} · {t.os === 'windows' ? 'Windows' : 'Linux'}
                </span>
              </span>
              {f && <span className={`cap-pill ${f.level}`}>{f.level === 'good' ? 'Fits' : f.level === 'tight' ? 'Tight' : 'Too big now'}</span>}
            </span>
            <span className="fx-muted" style={{ fontSize: 12.5 }}>
              {t.note}
            </span>
            <span className="fx-muted" style={{ fontSize: 11.5 }}>
              {t.cpus} vCPU · {t.memoryGB} GB · {t.diskGB} GB · {t.network === 'none' ? 'air-gapped' : t.network}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function SandboxTab({ s }: { s: LabStatus }) {
  const [url, setUrl] = useState('');
  const [folder, setFolder] = useState('');
  const [networking, setNetworking] = useState(true);
  const { run, busy } = useAction();
  const toast = useToast();
  return (
    <div className="lab-two">
      <Card title="Windows Sandbox" subtitle="A clean, disposable copy of Windows that starts in seconds. Everything inside is deleted when you close it.">
        {s.sandbox !== 'enabled' ? (
          <Callout tone="info">Turn on Windows Sandbox in the Readiness tab (Windows Pro or better), then restart Windows.</Callout>
        ) : (
          <div className="fx-form">
            <Field label="Open a link inside (optional)">
              <Input value={url} placeholder="https://…" onChange={(e) => setUrl(e.target.value)} />
            </Field>
            <Field label="Share a folder, read-only (optional)">
              <div className="fx-actions">
                <Input value={folder} placeholder="C:\Users\you\Downloads" onChange={(e) => setFolder(e.target.value)} />
                <Button
                  onClick={async () => {
                    const p = await pickFile({ kind: 'folder', title: 'Folder to share' });
                    if (p) setFolder(p);
                  }}
                >
                  Browse…
                </Button>
              </div>
            </Field>
            <Toggle checked={networking} onChange={setNetworking} label="Networking (turn off to test a file with no internet)" />
            <div>
              <Button variant="primary" icon="play" loading={busy === 'sb'} onClick={() => void run('sb', () => call('security.sandbox', { url: url.trim() || undefined, folder: folder.trim() || undefined, networking })).then((r) => r && toast.info('Windows Sandbox is starting…'))}>
                Launch sandbox
              </Button>
            </div>
          </div>
        )}
      </Card>
      <Card title="What's locked down">
        <div className="fx-list">
          {['Everything is wiped when it closes', 'Shared folder is read-only', 'Clipboard and printers stay outside', 'Microphone and camera off', 'Separate from your files and accounts'].map((x) => (
            <div key={x} className="fx-list-item" style={{ fontSize: 13 }}>
              <span className="check-dot ok">
                <Icons.check size={14} />
              </span>
              {x}
            </div>
          ))}
        </div>
        <p className="fx-muted" style={{ fontSize: 12.5, marginBottom: 0 }}>
          Good for a suspicious download or link. For longer experiments, use a VM with checkpoints.
        </p>
      </Card>
    </div>
  );
}

export function LabPage() {
  const status = useCore('lab.status');
  const c = useCapacity();
  const [tab, setTab] = useState<'ready' | 'vms' | 'new' | 'sandbox'>('vms');
  const [tpl, setTpl] = useState<Template | null>(null);
  const { run } = useAction();
  if (!IS_WINDOWS) {
    return (
      <Page title="Virtual lab" description="Virtual machines and Windows Sandbox for safe testing.">
        <CapacityCard c={c} />
        <Callout tone="info">The virtual lab uses Hyper-V and is available on Windows.</Callout>
      </Page>
    );
  }
  const s = status.data;
  return (
    <Page
      title="Virtual lab"
      description="Safe, isolated virtual machines for security tools, malware analysis and experiments, plus Windows Sandbox. Nothing you do in them touches this PC."
      actions={
        <>
          <Button icon="external" onClick={() => void run('m', () => call('lab.openManager'))}>
            Hyper-V Manager
          </Button>
          <Button
            className="ask-btn"
            icon="sparkles"
            onClick={() =>
              askAgent(
                `Help me plan a safe home lab in Hyper-V on this PC. Recommend which VMs to create (for example Kali, REMnux, FLARE-VM, a Windows test machine), how to size them for this PC, how to network them (isolated vs internet), when to take checkpoints, and safety rules for handling malware samples.`,
                { edition: s?.edition, hyperv: s?.hyperv, cores: c?.cores, memoryFreeGB: c ? +(c.memFree / GB).toFixed(1) : undefined, memoryTotalGB: c ? +(c.memTotal / GB).toFixed(1) : undefined, diskFreeGB: c ? Math.round(c.diskFree / GB) : undefined },
              )
            }
          >
            Plan a lab
          </Button>
        </>
      }
    >
      <CapacityCard c={c} />
      {status.error && <Callout tone="warning">{status.error}</Callout>}
      {!s && !status.error && <Spinner />}
      {s && (
        <>
          {s.hyperv !== 'enabled' && tab === 'vms' && (
            <Callout tone="info" title="Hyper-V is not turned on" actions={<Button size="sm" onClick={() => setTab('ready')}>Readiness</Button>}>
              Check what this PC supports and turn Hyper-V on in Readiness.
            </Callout>
          )}
          <Tabs
            active={tab}
            onChange={setTab}
            tabs={[
              { id: 'vms', label: 'My VMs' },
              { id: 'new', label: 'New safe VM' },
              { id: 'sandbox', label: 'Windows Sandbox' },
              { id: 'ready', label: 'Readiness' },
            ]}
          />
          {tab === 'ready' && <Readiness s={s} c={c} reload={status.reload} />}
          {tab === 'vms' && s.hyperv === 'enabled' && <VmCards c={c} onNew={() => setTab('new')} />}
          {tab === 'new' && (s.hyperv === 'enabled' ? <Templates c={c} onPick={setTpl} /> : <Callout tone="info">Turn on Hyper-V in Readiness first.</Callout>)}
          {tab === 'sandbox' && <SandboxTab s={s} />}
        </>
      )}
      {tpl && (
        <NewVm
          t={tpl}
          c={c}
          onClose={() => setTpl(null)}
          onCreated={() => {
            setTpl(null);
            setTab('vms');
          }}
        />
      )}
    </Page>
  );
}
