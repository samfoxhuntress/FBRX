import { useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import type { HwDevice, HwFlows, HwTopology, VmSummary } from '@fbrx/shared';
import { Button, Callout, Card, Empty, Icons, Input, KeyValue, Page, Select, Table, Toggle, useAction, useConfirm, useToast, type IconName } from '@fbrx/ui';
import { api } from '../api';
import { useApp, usePoll } from '../state';

/**
 * The hardware map: the server's processor sockets with their cores on top, the devices plugged into each socket's
 * PCIe lanes below, and live lines for the data moving between them. Dragging a device onto a socket (or a single
 * core) sends its interrupts there, which is where its data is first handled; dragging a virtual machine there pins
 * it to those processors.
 */

const KIND_ICON: Record<HwDevice['kind'], IconName> = { network: 'network', storage: 'drive', display: 'laptop', usb: 'plug', bridge: 'link', other: 'box' };
const KIND_WORD: Record<HwDevice['kind'], string> = { network: 'Network', storage: 'Storage', display: 'Display', usb: 'USB', bridge: 'Bridge', other: 'Device' };

function expand(s: string): number[] {
  const out: number[] = [];
  for (const part of s.split(',')) {
    const m = /^\s*(\d+)(?:-(\d+))?\s*$/.exec(part);
    if (!m) continue;
    for (let i = Number(m[1]); i <= Number(m[2] ?? m[1]) && out.length < 4096; i++) out.push(i);
  }
  return out;
}

function rate(bps: number, kind: 'network' | 'disk' | HwDevice['kind']): string {
  if (kind === 'network') {
    const bits = bps * 8;
    if (bits >= 1e9) return `${(bits / 1e9).toFixed(1)} Gb/s`;
    if (bits >= 1e6) return `${(bits / 1e6).toFixed(1)} Mb/s`;
    if (bits >= 1e3) return `${(bits / 1e3).toFixed(0)} kb/s`;
    return `${Math.round(bits)} b/s`;
  }
  if (bps >= 1e9) return `${(bps / 1e9).toFixed(1)} GB/s`;
  if (bps >= 1e6) return `${(bps / 1e6).toFixed(1)} MB/s`;
  if (bps >= 1e3) return `${(bps / 1e3).toFixed(0)} kB/s`;
  return `${Math.round(bps)} B/s`;
}

interface Line {
  id: string;
  d: string;
  width: number;
  seconds: number;
  dir: 'in' | 'out' | 'irq';
  active: boolean;
}

export function HardwarePage() {
  const app = useApp();
  const toast = useToast();
  const { busy, run } = useAction();
  const { confirm, dialog } = useConfirm();
  const topo = usePoll<HwTopology>('/v1/hardware/topology', 15000);
  const flows = usePoll<HwFlows>('/v1/hardware/flows', 1500);
  const vms = usePoll<{ vms: VmSummary[] }>('/v1/vms', 10000);
  const [selected, setSelected] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [dragging, setDragging] = useState<{ kind: 'device' | 'vm'; id: string } | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const admin = app.can('admin');
  const t = topo.data;

  const devices = useMemo(() => (t?.devices ?? []).filter((d) => showAll || (d.kind !== 'bridge' && (d.kind !== 'other' || d.irqs.length > 0 || d.passthroughVm))), [t, showAll]);
  const byAddress = useMemo(() => new Map((t?.devices ?? []).map((d) => [d.address, d])), [t]);
  const nodeOf = (d: HwDevice) => d.numaNode ?? t?.nodes[0]?.node ?? 0;
  const traffic = useMemo(() => {
    const m = new Map<string, { rx: number; tx: number; kind: 'network' | 'disk' }>();
    for (const i of flows.data?.items ?? []) {
      if (!i.device) continue;
      const cur = m.get(i.device) ?? { rx: 0, tx: 0, kind: i.kind };
      m.set(i.device, { rx: cur.rx + i.rxBps, tx: cur.tx + i.txBps, kind: i.kind });
    }
    return m;
  }, [flows.data]);
  // How many device interrupts each core handles (busy cores glow).
  const coreLoad = useMemo(() => {
    const m = new Map<number, number>();
    for (const d of t?.devices ?? []) for (const i of d.irqs) for (const c of expand(i.effective ?? i.cpus).slice(0, 1)) m.set(c, (m.get(c) ?? 0) + 1);
    return m;
  }, [t]);
  const sel = selected ? (byAddress.get(selected) ?? null) : null;
  const selCores = useMemo(() => new Set(sel ? sel.irqs.flatMap((i) => expand(i.cpus)) : []), [sel]);
  const pinnedVms = (vms.data?.vms ?? []).filter((v) => v.cpuset);

  // ---------------------------------------------------------------------- lines between boxes
  const board = useRef<HTMLDivElement>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = board.current;
    if (!el || !t) return;
    const draw = () => {
      const box = el.getBoundingClientRect();
      setSize({ w: box.width, h: box.height });
      const out: Line[] = [];
      for (const d of devices) {
        const card = el.querySelector<HTMLElement>(`[data-dev="${d.address}"]`);
        const node = el.querySelector<HTMLElement>(`[data-node="${nodeOf(d)}"] .vt-socket-port`);
        if (!card || !node) continue;
        const a = card.getBoundingClientRect();
        const b = node.getBoundingClientRect();
        const x1 = a.left + a.width / 2 - box.left;
        const y1 = a.top - box.top;
        const x2 = b.left + b.width / 2 - box.left;
        const y2 = b.bottom - box.top;
        const tr = traffic.get(d.address);
        const lane = (bps: number) => (bps <= 0 ? 1.5 : Math.min(9, 1.5 + Math.log10(1 + bps / 1e4) * 1.6));
        const speed = (bps: number) => (bps <= 0 ? 0 : Math.max(0.35, 3.2 - Math.log10(1 + bps / 1e4) * 0.55));
        const curve = (dx: number) => `M ${x1 + dx} ${y1} C ${x1 + dx} ${(y1 + y2) / 2}, ${x2 + dx} ${(y1 + y2) / 2}, ${x2 + dx} ${y2}`;
        out.push({ id: `${d.address}-in`, d: curve(-4), width: lane(tr?.rx ?? 0), seconds: speed(tr?.rx ?? 0), dir: 'in', active: !!tr && tr.rx > 0 });
        out.push({ id: `${d.address}-out`, d: curve(4), width: lane(tr?.tx ?? 0), seconds: speed(tr?.tx ?? 0), dir: 'out', active: !!tr && tr.tx > 0 });
      }
      // The selected device's interrupts: dotted lines to the cores that handle them.
      if (sel) {
        const card = el.querySelector<HTMLElement>(`[data-dev="${sel.address}"]`);
        if (card) {
          const a = card.getBoundingClientRect();
          for (const c of [...selCores].slice(0, 64)) {
            const core = el.querySelector<HTMLElement>(`[data-core="${c}"]`);
            if (!core) continue;
            const b = core.getBoundingClientRect();
            const x1 = a.left + a.width / 2 - box.left;
            const y1 = a.top - box.top;
            const x2 = b.left + b.width / 2 - box.left;
            const y2 = b.bottom - box.top;
            out.push({ id: `irq-${c}`, d: `M ${x1} ${y1} C ${x1} ${y1 - 40}, ${x2} ${y2 + 40}, ${x2} ${y2}`, width: 1.2, seconds: 0, dir: 'irq', active: true });
          }
        }
      }
      setLines(out);
    };
    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(el);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t, devices, traffic, sel, selCores]);

  // ------------------------------------------------------------------------------ changes
  const moveIrqs = async (address: string, cpus: string | null, where: string) => {
    const d = byAddress.get(address);
    if (!d) return;
    await run(`irq:${address}`, async () => {
      const r = await api<{ refused: number[]; topology: HwTopology }>('PUT', `/v1/hardware/devices/${address}/irqs`, { cpus });
      await topo.reload();
      if (r.refused.length) toast.warning(`${d.name}: Linux kept interrupts ${r.refused.join(', ')} where they were`);
      else toast.success(cpus ? `${d.interfaces[0] ?? d.name} now handled by ${where}` : `${d.interfaces[0] ?? d.name} back on all processors`);
    });
  };
  const pinVm = async (id: string, cpus: string | null, where: string) => {
    const vm = vms.data?.vms.find((v) => v.id === id);
    if (!vm) return;
    await run(`vm:${id}`, async () => {
      await api('PATCH', `/v1/vms/${id}`, { cpuset: cpus });
      await vms.reload();
      toast.success(cpus ? `${vm.name} now runs on ${where}` : `${vm.name} runs on any processor`);
    });
  };
  const drop = async (e: DragEvent, cpus: string, where: string) => {
    e.preventDefault();
    setOver(null);
    const what = dragging;
    setDragging(null);
    if (!what || !admin) return;
    if (what.kind === 'device') await moveIrqs(what.id, cpus, where);
    else await pinVm(what.id, cpus, where);
  };
  const dropProps = (key: string, cpus: string, where: string) =>
    admin
      ? {
          onDragOver: (e: DragEvent) => {
            if (!dragging) return;
            e.preventDefault();
            e.stopPropagation();
            setOver(key);
          },
          onDragLeave: () => setOver((o) => (o === key ? null : o)),
          onDrop: (e: DragEvent) => {
            e.stopPropagation();
            void drop(e, cpus, where);
          },
        }
      : {};

  if (!t) return <Page title="Hardware map">{topo.error ? <Callout tone="critical">{topo.error}</Callout> : <Empty title="Reading the hardware…" />}</Page>;
  const multi = t.nodes.length > 1;
  return (
    <Page
      title="Hardware map"
      description="Processors on top, the devices on their PCIe lanes below, and the data flowing between them right now. Drag a device onto a socket or a core to choose who handles its data; drag a virtual machine to pin it."
      actions={<Toggle checked={showAll} onChange={setShowAll} label="Show bridges and chipset parts" />}
    >
      {t.source === 'sample' && <Callout tone="info">This computer has no Linux hardware view, so this is a sample server. On FBRX Server you see (and steer) the real one.</Callout>}
      {t.irqbalance && t.source === 'system' && (
        <Callout
          tone="warning"
          title="irqbalance is running"
          actions={admin && <Button size="sm" loading={busy === 'irqb'} onClick={() => void run('irqb', async () => { await api('PUT', '/v1/hardware/irqbalance', { enabled: false }); await topo.reload(); }, 'irqbalance is off')}>Turn it off</Button>}
        >
          It moves interrupts around on its own and can undo placements made here. Turn it off when you place interrupts by hand.
        </Callout>
      )}
      <div className="vt-board-wrap">
        <div className="vt-board" ref={board} style={{ gridTemplateColumns: `repeat(${t.nodes.length}, minmax(260px, 1fr))` }}>
          {/* Data lines run under the boxes; the selected device's interrupt lines run over them, to its cores. */}
          {(['under', 'over'] as const).map((layer) => (
            <svg key={layer} className={`vt-wires ${layer}`} width={size.w} height={size.h} aria-hidden="true">
              {lines
                .filter((l) => (l.dir === 'irq') === (layer === 'over'))
                .map((l) => (
                  <path key={l.id} d={l.d} className={`vt-wire ${l.dir}${l.active ? ' live' : ''}`} style={{ strokeWidth: l.width, animationDuration: l.seconds ? `${l.seconds}s` : undefined }} />
                ))}
            </svg>
          ))}
          {t.nodes.map((n) => {
            const nodeDevices = devices.filter((d) => nodeOf(d) === n.node);
            const where = multi ? `socket ${n.socket ?? n.node} (CPUs ${n.cpus})` : `CPUs ${n.cpus}`;
            return (
              <div key={n.node} className="vt-column" data-node={n.node}>
                <div className={`vt-socket${over === `node-${n.node}` ? ' over' : ''}`} {...dropProps(`node-${n.node}`, n.cpus, where)}>
                  <div className="vt-socket-head">
                    <Icons.cpu size={18} />
                    <div>
                      <b>{multi ? `Socket ${n.socket ?? n.node}` : 'Processor'}</b>
                      <div className="fx-cell-sub">{n.model ?? 'Processor'}</div>
                    </div>
                    <span className="fx-badge">{n.memoryMb ? `${Math.round(n.memoryMb / 1024)} GB local memory` : `${n.cpuCount} CPUs`}</span>
                  </div>
                  <div className="vt-cores">
                    {expand(n.cpus).map((c) => {
                      const load = coreLoad.get(c) ?? 0;
                      const vmsHere = pinnedVms.filter((v) => expand(v.cpuset!).includes(c));
                      return (
                        <div
                          key={c}
                          data-core={c}
                          className={`vt-core${selCores.has(c) ? ' sel' : ''}${over === `core-${c}` ? ' over' : ''}`}
                          style={{ ['--heat' as string]: Math.min(1, load / 6) }}
                          title={`CPU ${c}: ${load} device interrupt${load === 1 ? '' : 's'}${vmsHere.length ? ` · ${vmsHere.map((v) => v.name).join(', ')}` : ''}`}
                          {...dropProps(`core-${c}`, String(c), `CPU ${c}`)}
                        >
                          {c}
                          {vmsHere.length > 0 && <span className="vt-core-vm" />}
                        </div>
                      );
                    })}
                  </div>
                  <div className="vt-vms">
                    {pinnedVms
                      .filter((v) => expand(v.cpuset!).some((c) => expand(n.cpus).includes(c)))
                      .map((v) => (
                        <span key={v.id} className="vt-vm-chip" draggable={admin} onDragStart={() => setDragging({ kind: 'vm', id: v.id })} onDragEnd={() => setDragging(null)} title={`${v.name} runs on CPUs ${v.cpuset}`}>
                          <Icons.layers size={12} /> {v.name} · {v.cpuset}
                        </span>
                      ))}
                  </div>
                  <div className="vt-socket-port">PCIe lanes</div>
                </div>
                <div className="vt-devices">
                  {nodeDevices.length === 0 && <div className="fx-muted" style={{ textAlign: 'center' }}>No devices on this socket</div>}
                  {nodeDevices.map((d) => {
                    const Ico = Icons[KIND_ICON[d.kind]];
                    const tr = traffic.get(d.address);
                    const parent = d.parent ? byAddress.get(d.parent) : null;
                    const slow = d.link?.width && d.link.maxWidth && d.link.width < d.link.maxWidth;
                    return (
                      <button
                        key={d.address}
                        data-dev={d.address}
                        className={`vt-dev ${d.kind}${selected === d.address ? ' sel' : ''}${d.passthroughVm ? ' given' : ''}`}
                        draggable={admin && d.irqs.length > 0}
                        onDragStart={() => setDragging({ kind: 'device', id: d.address })}
                        onDragEnd={() => setDragging(null)}
                        onClick={() => setSelected(selected === d.address ? null : d.address)}
                      >
                        <span className="vt-dev-head">
                          <Ico size={16} />
                          <b>{d.interfaces.length ? d.interfaces.join(' · ') : KIND_WORD[d.kind]}</b>
                          {d.passthroughVm && <span className="fx-badge" title="Given to a virtual machine">{d.passthroughVm}</span>}
                        </span>
                        <span className="vt-dev-name">{d.name}</span>
                        <span className="vt-dev-meta">
                          <span className="mono">{d.address.replace(/^0000:/, '')}</span>
                          {d.link?.width ? <span className={slow ? 'vt-warn' : undefined}>x{d.link.width}{d.link.speed ? ` · ${d.link.speed.replace(' PCIe', '')}` : ''}</span> : null}
                          {parent && parent.kind === 'bridge' && <span title={parent.name}>via {parent.address.replace(/^0000:/, '')}</span>}
                        </span>
                        {tr && (
                          <span className="vt-dev-rate">
                            <span className="in">↑ {rate(tr.rx, tr.kind)}</span>
                            <span className="out">↓ {rate(tr.tx, tr.kind)}</span>
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
        <div className="vt-legend">
          <span><i className="vt-key in" /> Data in (received, read)</span>
          <span><i className="vt-key out" /> Data out (sent, written)</span>
          <span><i className="vt-key irq" /> Interrupts of the selected device</span>
          <span><i className="vt-key heat" /> Core handling many interrupts</span>
          <span><i className="vt-key vm" /> Core with a pinned virtual machine</span>
        </div>
      </div>
      {sel && <DevicePanel d={sel} t={t} traffic={traffic.get(sel.address)} vms={vms.data?.vms ?? []} admin={admin} busy={busy} onMove={moveIrqs} onChanged={() => void topo.reload()} confirm={confirm} />}
      {dialog}
    </Page>
  );
}

function DevicePanel({
  d,
  t,
  traffic,
  vms,
  admin,
  busy,
  onMove,
  onChanged,
  confirm,
}: {
  d: HwDevice;
  t: HwTopology;
  traffic: { rx: number; tx: number; kind: 'network' | 'disk' } | undefined;
  vms: VmSummary[];
  admin: boolean;
  busy: string | null;
  onMove: (address: string, cpus: string | null, where: string) => Promise<void>;
  onChanged: () => void;
  confirm: ReturnType<typeof useConfirm>['confirm'];
}) {
  const { run, busy: localBusy } = useAction();
  const [custom, setCustom] = useState('');
  const [vm, setVm] = useState('');
  useEffect(() => {
    setCustom('');
    setVm('');
  }, [d.address]);
  const node = t.nodes.find((n) => n.node === d.numaNode);
  const pinned = t.pinned[d.address];
  const multi = t.nodes.length > 1;
  const slow = d.link?.width && d.link.maxWidth && d.link.width < d.link.maxWidth;
  return (
    <Card title={d.name} subtitle={`${d.vendor ?? 'Unknown maker'} · ${d.address}`} actions={pinned && <span className="fx-badge" title="Put back after every restart">Placement kept: CPUs {pinned}</span>}>
      <div className="vt-panel">
        <div>
          <KeyValue
            items={[
              ['Kind', KIND_WORD[d.kind]],
              ['Driver', d.driver ?? 'none'],
              ['On', node ? (multi ? `Socket ${node.socket ?? node.node} (CPUs ${node.cpus})` : `CPUs ${node.cpus}`) : 'Unknown'],
              ['Link', d.link ? `${d.link.width ? `x${d.link.width}` : '?'}${d.link.speed ? ` at ${d.link.speed}` : ''}${d.link.maxWidth ? ` (can do x${d.link.maxWidth}${d.link.maxSpeed ? ` at ${d.link.maxSpeed}` : ''})` : ''}` : '—'],
              ['IOMMU group', d.iommuGroup ?? 'none (VT-d off)'],
              ['On it', d.interfaces.length ? d.interfaces.join(', ') : '—'],
              ['Right now', traffic ? `in ${rate(traffic.rx, traffic.kind)} · out ${rate(traffic.tx, traffic.kind)}` : '—'],
              ['Given to', d.passthroughVm ?? 'The server'],
            ]}
          />
          {slow && <Callout tone="warning">This card runs on fewer lanes than it can use (x{d.link!.width} of x{d.link!.maxWidth}). A wider slot may make it faster.</Callout>}
          {node && multi && d.irqs.some((i) => !expand(i.cpus).every((c) => expand(node.cpus).includes(c))) && (
            <Callout tone="info">Some of its interrupts can land on the other socket. Keeping them on socket {node.socket ?? node.node} saves a trip across the processor link for every packet or block.</Callout>
          )}
        </div>
        <div className="fx-form">
          {admin && d.irqs.length > 0 && (
            <>
              <div className="fx-label">Who handles its data</div>
              <div className="vt-chips">
                {t.nodes.map((n) => (
                  <button key={n.node} className={`vt-chip${pinned === n.cpus ? ' on' : ''}`} disabled={!!busy} onClick={() => void onMove(d.address, n.cpus, multi ? `socket ${n.socket ?? n.node}` : `CPUs ${n.cpus}`)}>
                    {multi ? `Socket ${n.socket ?? n.node}` : 'All CPUs'} · {n.cpus}
                  </button>
                ))}
                {pinned && (
                  <button className="vt-chip" disabled={!!busy} onClick={() => void onMove(d.address, null, 'all')}>
                    Back to automatic
                  </button>
                )}
              </div>
              <div className="fx-row" style={{ gap: 8 }}>
                <Input value={custom} onChange={(e) => setCustom(e.target.value.replace(/\s/g, ''))} placeholder="Exact CPUs, like 2-3" className="mono" aria-label="Exact CPUs" />
                <Button disabled={!/^\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*$/.test(custom)} loading={busy === `irq:${d.address}`} onClick={() => void onMove(d.address, custom, `CPUs ${custom}`)}>
                  Apply
                </Button>
              </div>
            </>
          )}
          {admin && d.kind !== 'bridge' && !d.passthroughVm && (
            <>
              <div className="fx-label">Give it to a virtual machine</div>
              <div className="fx-row" style={{ gap: 8 }}>
                <Select value={vm} onChange={(e) => setVm(e.target.value)} options={[{ value: '', label: 'Choose a machine…' }, ...vms.map((v) => ({ value: v.id, label: v.name }))]} aria-label="Virtual machine" />
                <Button
                  disabled={!vm}
                  loading={localBusy === 'give'}
                  onClick={async () => {
                    const name = vms.find((v) => v.id === vm)?.name;
                    if (await confirm({ title: `Give ${d.interfaces[0] ?? d.name} to ${name}?`, body: 'The server stops using it and the machine gets it at its next start. Never give away the port you reach this console through.', confirmLabel: 'Give it', danger: true }))
                      await run('give', async () => { await api('POST', `/v1/vms/${vm}/hostdevs`, { address: d.address }); onChanged(); }, `Given to ${name}`);
                  }}
                >
                  Give
                </Button>
              </div>
            </>
          )}
        </div>
      </div>
      {d.irqs.length > 0 && (
        <Table
          rows={d.irqs}
          rowKey={(i) => String(i.irq)}
          columns={[
            { key: 'i', header: 'Interrupt', render: (i) => <span className="mono">{i.irq}</span> },
            { key: 'n', header: 'Name', render: (i) => <span className="mono">{i.name || '—'}</span> },
            { key: 'c', header: 'Allowed CPUs', render: (i) => <span className="mono">{i.cpus}</span> },
            { key: 'e', header: 'Handled by', render: (i) => <span className="mono">{i.effective ?? '—'}</span> },
          ]}
        />
      )}
    </Card>
  );
}

