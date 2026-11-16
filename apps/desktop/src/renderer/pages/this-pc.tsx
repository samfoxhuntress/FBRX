import type { ReactNode } from 'react';
import { atLeast, inventoryText, type DeviceReport, type SystemInventory } from '@fbrx/shared';
import { Badge, Button, Callout, Card, Empty, Grid, KeyValue, Meter, Page, Spinner, StatTile, Status, Table, useAction, useToast } from '@fbrx/ui';
import { call, openExternal, writeClipboard } from '../client';
import { EditionHint, useLicenseTier } from '../edition';
import { useAgentName, useCore } from '../hooks';
import { navigate } from '../app';
import { askAgent } from '../widgets';

const gb = (b: number) => (b >= 1024 ** 4 ? `${(b / 1024 ** 4).toFixed(1)} TB` : b >= 1024 ** 3 ? `${Math.round(b / 1024 ** 3)} GB` : `${Math.round(b / 1024 ** 2)} MB`);
const or = (v: ReactNode | null | undefined, empty = 'Not reported') => (v === null || v === undefined || v === '' ? <span className="fx-muted">{empty}</span> : v);

/** A card's link to the FBRX page that does something about it. */
function Go({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Button size="sm" variant="ghost" icon="chevronRight" onClick={() => navigate(to)}>
      {children}
    </Button>
  );
}

/**
 * This PC: what the computer is made of, on one page (the make and model, serial number, BIOS, processor, each memory
 * module, each drive and its health, graphics, screens, network adapters and the battery), each part with a link to the
 * FBRX page that looks after it.
 */
export function ThisPcPage() {
  const inv = useCore('pc.inventory', {});
  const pro = atLeast(useLicenseTier(), 'basic');
  const agent = useAgentName();
  const toast = useToast();
  const { run, busy } = useAction();
  const i: SystemInventory | null = inv.data ?? null;
  const refresh = () => void run('refresh', () => call('pc.inventory', { fresh: true }).then(() => inv.reload()));
  const copy = () => i && void writeClipboard(inventoryText(i)).then(() => toast.success('Copied', 'The whole list, as text: paste it into a ticket or a message.'));
  const title = i ? [i.system.manufacturer, i.system.model].filter(Boolean).join(' ') || i.os.hostname : 'This PC';
  const usedMem = i ? Math.round((i.memory.usedBytes / (i.memory.totalBytes || 1)) * 100) : 0;
  const storage = i?.volumes.reduce((a, v) => ({ size: a.size + v.bytes, used: a.used + v.usedBytes }), { size: 0, used: 0 });
  return (
    <Page
      title="This PC"
      description="What this computer is made of, and where to look after each part."
      actions={
        <>
          <Button icon="copy" disabled={!i} onClick={copy}>
            Copy all
          </Button>
          <Button icon="refresh" loading={busy === 'refresh'} onClick={refresh}>
            Refresh
          </Button>
          <Button icon="sparkles" className="ask-btn" disabled={!i} onClick={() => i && askAgent(`Here is this computer's hardware. Tell me in plain words how it is doing, what is worth upgrading first and why, and anything that looks wrong.\n\n${inventoryText(i)}`)}>
            Ask {agent}
          </Button>
        </>
      }
    >
      {!i && (inv.error ? <Empty title="Could not read this computer’s details">{inv.error}</Empty> : <Spinner />)}
      {i && (
        <>
          <Card>
            <div className="thispc-hero">
              <div>
                <div className="thispc-model">{title}</div>
                <div className="fx-muted">
                  {i.system.kind ?? 'Computer'}
                  {i.system.virtual && !/virtual/i.test(title) && <Badge tone="accent">Virtual machine</Badge>} · {i.os.name} {i.os.version ?? ''}
                  {i.os.build ? ` (build ${i.os.build})` : ''} · {i.os.arch}
                </div>
              </div>
              <KeyValue
                items={[
                  ['Serial number', or(i.system.serial && <span className="mono">{i.system.serial}</span>)],
                  ['Computer name', <span className="mono">{i.os.hostname}</span>],
                  ['Running for', `${i.os.uptimeHours} hours`],
                ]}
              />
            </div>
          </Card>
          <Grid cols={4}>
            <StatTile label="Processor" value={i.cpu.cores ? `${i.cpu.cores} cores` : `${i.cpu.threads ?? '?'} threads`} foot={i.cpu.name} />
            <StatTile label="Memory" value={gb(i.memory.totalBytes)} foot={`${usedMem}% in use${i.memory.modules[0]?.type ? ` · ${i.memory.modules[0].type}` : ''}`} />
            <StatTile label="Storage" value={storage ? gb(storage.size) : '—'} foot={storage ? `${gb(storage.size - storage.used)} free` : ''} />
            <StatTile label="Graphics" value={i.graphics[0]?.vramMB ? `${Math.round(i.graphics[0].vramMB / 1024) || i.graphics[0].vramMB} ${i.graphics[0].vramMB >= 1024 ? 'GB' : 'MB'}` : i.displays.length ? `${i.displays.length} screen${i.displays.length === 1 ? '' : 's'}` : '—'} foot={i.graphics[0]?.name ?? 'Not reported'} />
          </Grid>
          <div className="thispc-grid">
            <Card title="Processor" actions={<Go to="processes">Task Manager</Go>}>
              <KeyValue
                items={[
                  ['Model', i.cpu.name],
                  ['Cores and threads', `${or(i.cpu.cores, '?')} cores, ${i.cpu.threads ?? '?'} threads`],
                  ['Speed', i.cpu.maxGHz ? `${i.cpu.baseGHz ?? '?'} GHz, up to ${i.cpu.maxGHz} GHz` : or(i.cpu.baseGHz && `${i.cpu.baseGHz} GHz`)],
                  ['Socket', or(i.cpu.socket)],
                  ['Virtualization', i.cpu.virtualization === null ? or(null) : i.cpu.virtualization ? 'Supported' : 'Off or not supported'],
                ]}
              />
            </Card>
            <Card title="Memory" subtitle={`${gb(i.memory.totalBytes)}${i.memory.slots ? ` · ${i.memory.modules.length} of ${i.memory.slots} slots used` : ''}`} actions={<Go to="processes">What uses it</Go>}>
              <Meter value={usedMem} label={`${usedMem}% in use`} />
              {i.memory.modules.length ? (
                <Table
                  columns={[
                    { key: 'slot', header: 'Slot', render: (m) => or(m.slot, '—') },
                    { key: 'size', header: 'Size', render: (m) => gb(m.bytes) },
                    { key: 'type', header: 'Type', render: (m) => or(m.type, '—') },
                    { key: 'speed', header: 'Speed', render: (m) => (m.mhz ? `${m.mhz} MHz` : '—') },
                    { key: 'maker', header: 'Maker', render: (m) => or(m.manufacturer, '—') },
                  ]}
                  rows={i.memory.modules}
                  rowKey={(m) => `${m.slot}${m.part}${m.bytes}`}
                />
              ) : (
                <p className="fx-muted">The modules are not reported on this computer.</p>
              )}
            </Card>
            <Card title="Storage" actions={<Go to="storage">Storage</Go>}>
              {i.drives.length > 0 && (
                <Table
                  columns={[
                    { key: 'name', header: 'Drive', render: (d) => d.name },
                    { key: 'kind', header: 'Kind', render: (d) => or(d.kind, '—') },
                    { key: 'size', header: 'Size', render: (d) => gb(d.bytes) },
                    { key: 'health', header: 'Health', render: (d) => (d.health ? <Status tone={/ok|good|pass/i.test(d.health) ? 'good' : 'warning'}>{d.health}</Status> : or(null, '—')) },
                    { key: 'temp', header: 'Temp.', render: (d) => (d.temperatureC ? `${d.temperatureC} °C` : '—') },
                  ]}
                  rows={i.drives}
                  rowKey={(d) => `${d.name}${d.serial}`}
                />
              )}
              <div className="thispc-volumes">
                {i.volumes.map((v) => (
                  <div key={v.mount}>
                    <div className="thispc-volume-head">
                      <span className="mono">{v.mount}</span>
                      <span className="fx-muted">
                        {gb(v.bytes - v.usedBytes)} free of {gb(v.bytes)}
                        {v.fs ? ` · ${v.fs}` : ''}
                      </span>
                    </div>
                    <Meter value={v.usedBytes} max={v.bytes} />
                  </div>
                ))}
              </div>
            </Card>
            <Card title="Graphics and screens" actions={<Go to="settings/appearance">Appearance</Go>}>
              <KeyValue items={[...i.graphics.map((g, n): [ReactNode, ReactNode] => [i.graphics.length > 1 ? `Graphics ${n + 1}` : 'Graphics', `${g.name}${g.vramMB ? `, ${g.vramMB >= 1024 ? `${Math.round(g.vramMB / 1024)} GB` : `${g.vramMB} MB`}` : ''}${g.driver ? ` · driver ${g.driver}` : ''}`]), ...i.displays.map((x, n): [ReactNode, ReactNode] => [x.main ? 'Main screen' : `Screen ${n + 1}`, `${x.name}${x.width && x.height ? `, ${x.width}×${x.height}` : ''}${x.hz ? ` at ${x.hz} Hz` : ''}${x.connection ? ` · ${x.connection}` : ''}`])]} />
              {!i.graphics.length && !i.displays.length && <p className="fx-muted">Not reported on this computer.</p>}
            </Card>
            <Card title="Network adapters" actions={<Go to="network">Network Center</Go>}>
              {i.network.length ? (
                <Table
                  columns={[
                    { key: 'name', header: 'Adapter', render: (n) => n.name },
                    { key: 'kind', header: 'Kind', render: (n) => n.kind },
                    { key: 'state', header: 'State', render: (n) => <Status tone={n.connected ? 'good' : 'neutral'}>{n.connected ? (n.ip ?? 'connected') : 'not connected'}</Status> },
                    { key: 'speed', header: 'Speed', render: (n) => (n.speedMbps ? `${n.speedMbps >= 1000 ? `${n.speedMbps / 1000} Gbps` : `${n.speedMbps} Mbps`}` : '—') },
                    { key: 'mac', header: 'MAC', render: (n) => <span className="mono fx-muted">{n.mac}</span> },
                  ]}
                  rows={i.network}
                  rowKey={(n) => n.mac + n.name}
                />
              ) : (
                <p className="fx-muted">No network adapters.</p>
              )}
            </Card>
            <Card title="Battery and power" actions={<Go to="security">Security</Go>}>
              {i.battery ? (
                <KeyValue
                  items={[
                    ['Charge', `${i.battery.percent ?? '?'}%${i.battery.charging ? ', charging' : ''}`],
                    ['Health', i.battery.healthPct ? <Status tone={i.battery.healthPct >= 80 ? 'good' : i.battery.healthPct >= 60 ? 'warning' : 'critical'}>{i.battery.healthPct}% of what it held new</Status> : or(null)],
                    ['Charge cycles', or(i.battery.cycles)],
                    ['Designed for', or(i.battery.designWh && `${i.battery.designWh} Wh`)],
                  ]}
                />
              ) : (
                <p className="fx-muted">No battery: this computer runs on mains power.</p>
              )}
            </Card>
            <Card title="Motherboard and BIOS" actions={<Go to="updates">Updates</Go>}>
              <KeyValue
                items={[
                  ['Motherboard', or([i.board.manufacturer, i.board.model].filter(Boolean).join(' '))],
                  ['Board serial', or(i.board.serial && <span className="mono">{i.board.serial}</span>)],
                  ['BIOS', or([i.bios.vendor, i.bios.version].filter(Boolean).join(' '))],
                  ['BIOS date', or(i.bios.date)],
                  ['Model number', or(i.system.sku)],
                ]}
              />
            </Card>
            <Card title="Look after it" subtitle="Where FBRX keeps this computer in shape">
              <div className="thispc-links">
                <Go to="storage">Free up space</Go>
                <Go to="security">Security settings</Go>
                <Go to="shield">FBRX Shield</Go>
                <Go to="updates">Updates</Go>
                <Go to="processes">Task Manager</Go>
                <Go to="network">Network Center</Go>
                <Go to="backup">Backup and restore</Go>
                <Go to="bugs">Bug catcher</Go>
              </div>
            </Card>
          </div>
          {pro ? <Devices /> : <EditionHint tier="basic">Devices (screens against their best, graphics cards, external drives with Eject, USB and printers, each with what to do) come with FBRX Endpoint Pro.</EditionHint>}
        </>
      )}
    </Page>
  );
}

/**
 * This PC → Devices (2.5.0, Pro and up): each kind of device with what it reports, what looks wrong and what to do,
 * and Eject for an external drive. Fabrix reads the same through pc.devices.
 */
function Devices() {
  const r = useCore('pc.deviceReport', {});
  const toast = useToast();
  const { run, busy } = useAction();
  const d: DeviceReport | null = r.data ?? null;
  const eject = (device: string) =>
    void run(`eject-${device}`, () =>
      call('pc.ejectDrive', { device }).then((x) => {
        toast.success('Ejected', x.message);
        r.reload();
      }),
    );
  if (!d) return r.error ? <Empty title="Could not read the devices">{r.error}</Empty> : <Spinner />;
  return (
    <div className="thispc-devices">
      <h2 className="thispc-section">Devices</h2>
      {d.findings.map((f, n) => (
        <Callout key={n} tone={f.level === 'warning' ? 'warning' : 'info'} title={f.title} actions={f.link ? (f.link.startsWith('http') ? <Button size="sm" variant="ghost" icon="external" onClick={() => openExternal(f.link!)}>Driver</Button> : <Button size="sm" variant="ghost" onClick={() => navigate(f.link!)}>Open</Button>) : undefined}>
          {f.detail}
        </Callout>
      ))}
      <div className="thispc-grid">
        <Card title="Screens" actions={<Go to="settings/appearance">Appearance</Go>}>
          {d.monitors.length ? (
            <KeyValue
              items={d.monitors.map((m, n): [ReactNode, ReactNode] => [
                m.builtin ? 'Built-in screen' : m.main ? 'Main screen' : `Screen ${n + 1}`,
                <>
                  {[m.vendor, m.model ?? m.name].filter(Boolean).join(' ')}
                  {m.width && m.height ? `, ${m.width}×${m.height}` : ''}
                  {m.hz ? ` at ${m.hz} Hz` : ''}
                  {m.bestWidth && m.bestHeight && m.width !== m.bestWidth ? ` (best ${m.bestWidth}×${m.bestHeight})` : ''}
                  <span className="fx-muted">{[m.connection, m.year ? `made ${m.year}` : null, m.serial ? `serial ${m.serial}` : null].filter(Boolean).map((x) => ` · ${x}`).join('')}</span>
                </>,
              ])}
            />
          ) : (
            <p className="fx-muted">No screen reported.</p>
          )}
        </Card>
        <Card title="Graphics">
          {d.graphics.length ? (
            d.graphics.map((g) => (
              <div key={g.name} className="thispc-device">
                <KeyValue items={[['Card', g.name], ['Driver', or(g.driver)], ...(g.vramMB ? [['Memory', g.vramMB >= 1024 ? `${Math.round(g.vramMB / 1024)} GB` : `${g.vramMB} MB`] as [ReactNode, ReactNode]] : []), ...(g.temperatureC !== null ? [['Temperature', `${g.temperatureC} °C`] as [ReactNode, ReactNode]] : []), ...(g.loadPct !== null ? [['Busy', `${g.loadPct}%`] as [ReactNode, ReactNode]] : [])]} />
                {g.driverPage && (
                  <Button size="sm" variant="ghost" icon="external" onClick={() => openExternal(g.driverPage!)}>
                    The maker’s drivers
                  </Button>
                )}
              </div>
            ))
          ) : (
            <p className="fx-muted">No graphics card reported.</p>
          )}
        </Card>
        <Card title="External drives" actions={<Go to="backup">Back up to one</Go>}>
          {d.externalDrives.length ? (
            d.externalDrives.map((x) => (
              <div key={x.device} className="thispc-device fx-row" style={{ justifyContent: 'space-between' }}>
                <div>
                  <strong>{x.name}</strong> <span className="fx-muted">{gb(x.bytes)}{x.interface ? ` · ${x.interface}` : ''}{x.health ? ` · ${x.health}` : ''}</span>
                  <div className="fx-muted">{x.mounts.length ? x.mounts.map((m) => `${m.label ? `${m.label} ` : ''}${m.mount}${m.fs ? ` (${m.fs})` : ''}`).join(', ') : 'Not opened'}</div>
                </div>
                <Button size="sm" icon="upload" loading={busy === `eject-${x.device}`} onClick={() => eject(x.device)}>
                  Eject
                </Button>
              </div>
            ))
          ) : (
            <p className="fx-muted">No USB or other external drive is plugged in.</p>
          )}
        </Card>
        <Card title="USB" subtitle={`${d.usb.length} device${d.usb.length === 1 ? '' : 's'}`}>
          {d.usb.length ? <KeyValue items={d.usb.slice(0, 30).map((u, n): [ReactNode, ReactNode] => [u.name || `Device ${n + 1}`, [u.vendor, u.kind, u.maxPowerMa ? `${u.maxPowerMa} mA` : null].filter(Boolean).join(' · ') || '—'])} /> : <p className="fx-muted">No USB devices reported.</p>}
        </Card>
        <Card title="Printers" actions={<Go to="network/printers">Printers</Go>}>
          {d.printers.length ? <KeyValue items={d.printers.map((p): [ReactNode, ReactNode] => [`${p.name}${p.isDefault ? ' (default)' : ''}`, [p.model, p.status, p.local ? 'on this computer' : 'on the network'].filter(Boolean).join(' · ')])} /> : <p className="fx-muted">No printers set up.</p>}
        </Card>
      </div>
    </div>
  );
}
