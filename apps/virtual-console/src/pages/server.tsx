import { useMemo, useState } from 'react';
import type { BiosAttribute, BiosSettings, BmcConfig, BmcLogEntry, BmcProbe, BmcSensor, BmcSystem } from '@fbrx/shared';
import { Button, Callout, Card, Empty, Field, formatDate, Grid, Input, KeyValue, Page, Select, Status, Table, Tabs, Toggle, timeAgo, useAction, useConfirm, useToast } from '@fbrx/ui';
import { api } from '../api';
import { useApp, usePoll, useRoute } from '../state';

type Tab = 'overview' | 'bios' | 'log' | 'connection';

/**
 * The server itself, through its management controller (iDRAC on a Dell PowerEdge): health, sensors, power, the event
 * log, and BIOS settings changed from here instead of at the boot screen.
 */
export function ServerPage({ tab }: { tab?: string }) {
  const [, go] = useRoute();
  const cfg = usePoll<{ config: BmcConfig | null }>('/v1/bmc', 30000);
  const active = (['overview', 'bios', 'log', 'connection'].includes(tab ?? '') ? tab : 'overview') as Tab;
  if (!cfg.data) return <Page title="Server & BIOS"><Empty title="Loading…" /></Page>;
  const c = cfg.data.config;
  return (
    <Page
      title="Server & BIOS"
      description={c ? `Through ${c.kind ?? 'the management controller'} at ${c.host}` : 'Connect the server’s management controller (iDRAC, iLO, XClarity or any Redfish one) to see its health and change BIOS settings from here.'}
    >
      {!c ? (
        <Connect onDone={() => void cfg.reload()} />
      ) : (
        <>
          {c.lastError && <Callout tone="warning" title="The last request to the controller failed">{c.lastError}</Callout>}
          <Tabs<Tab>
            active={active}
            onChange={(t) => go('server', t)}
            tabs={[
              { id: 'overview', label: 'Health & power' },
              { id: 'bios', label: 'BIOS settings' },
              { id: 'log', label: 'Event log' },
              { id: 'connection', label: 'Connection' },
            ]}
          />
          {active === 'overview' && <Overview />}
          {active === 'bios' && <Bios />}
          {active === 'log' && <EventLog />}
          {active === 'connection' && <Connection config={c} onChanged={() => void cfg.reload()} />}
        </>
      )}
    </Page>
  );
}

function Connect({ onDone }: { onDone: () => void }) {
  const app = useApp();
  const { busy, run } = useAction();
  const [host, setHost] = useState('');
  const [probe, setProbe] = useState<BmcProbe | null>(null);
  const [trust, setTrust] = useState(false);
  const [username, setUsername] = useState('root');
  const [password, setPassword] = useState('');
  if (!app.can('admin')) return <Empty title="Not connected">An administrator connects the management controller.</Empty>;
  return (
    <Grid cols={2}>
      <Card title="Connect the management controller" subtitle="The small computer inside the server that runs even when it is off (iDRAC on Dell PowerEdge).">
        <div className="fx-form">
          <Field label="Its address" help="The iDRAC's IP address or name (shown at boot, on the server's LCD, or in your router).">
            <Input value={host} onChange={(e) => { setHost(e.target.value); setProbe(null); setTrust(false); }} placeholder="192.168.1.20" />
          </Field>
          {!probe ? (
            <Button variant="primary" disabled={!host.trim()} loading={busy === 'probe'} onClick={() => void run('probe', async () => setProbe(await api<BmcProbe>('POST', '/v1/bmc/probe', { host })))}>
              Look it up
            </Button>
          ) : (
            <>
              <Callout tone={probe.trusted ? 'good' : 'info'} title={probe.trusted ? 'A trusted certificate' : 'Check this certificate'}>
                <div className="fx-form" style={{ gap: 6 }}>
                  <div>
                    It says it is <b>{probe.subject}</b>, issued by <b>{probe.issuer}</b>.
                  </div>
                  <div className="mono" style={{ fontSize: 12, wordBreak: 'break-all' }}>{probe.fingerprint}</div>
                  {!probe.trusted && <div className="fx-secondary">Controllers come with their own certificate. Compare this fingerprint with the one in the iDRAC web page (Settings → SSL) and trust it once: FBRX Virtual then talks only to this exact controller.</div>}
                </div>
              </Callout>
              {!probe.trusted && <Toggle checked={trust} onChange={setTrust} label="This is my server’s controller: trust this certificate" />}
              <Grid cols={2}>
                <Field label="Username">
                  <Input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" />
                </Field>
                <Field label="Password">
                  <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="off" />
                </Field>
              </Grid>
              <Button
                variant="primary"
                disabled={(!probe.trusted && !trust) || !username || !password}
                loading={busy === 'connect'}
                onClick={() => void run('connect', async () => { await api('PUT', '/v1/bmc', { host: probe.host, username, password, fingerprint: probe.trusted ? null : probe.fingerprint }); onDone(); }, 'Connected')}
              >
                Connect
              </Button>
            </>
          )}
        </div>
      </Card>
      <Card title="What this gives you">
        <ul className="vt-list">
          <li>Temperatures, fans and power use, and the server's own health.</li>
          <li>Turn the server on and off, or restart it, even when the operating system is stuck.</li>
          <li>BIOS settings from this page: turn on virtualization (VT-x, VT-d), SR-IOV and the performance profile without a keyboard on the server.</li>
          <li>The hardware event log (memory errors, power supply problems, fan failures).</li>
        </ul>
        <div className="fx-help">Use a separate iDRAC account for FBRX Virtual (Administrator role) so you can revoke it any time. The password is kept encrypted on this server.</div>
      </Card>
    </Grid>
  );
}

function Overview() {
  const app = useApp();
  const toast = useToast();
  const { busy, run } = useAction();
  const { confirm, dialog } = useConfirm();
  const sys = usePoll<BmcSystem>('/v1/bmc/system', 15000);
  const sensors = usePoll<{ sensors: BmcSensor[] }>('/v1/bmc/sensors', 10000);
  const s = sys.data;
  const list = sensors.data?.sensors ?? [];
  const power = async (resetType: string, label: string, danger: string) => {
    if (!(await confirm({ title: `${label}?`, body: danger, confirmLabel: label, danger: true }))) return;
    await run(resetType, async () => {
      await api('POST', '/v1/bmc/power', { resetType });
      toast.success(`${label}: sent to the server`);
      await sys.reload();
    });
  };
  const offWarn = 'This is the server FBRX Virtual runs on: every virtual machine on it stops, and this page goes away until it is back.';
  return (
    <>
      {sys.error && <Callout tone="critical">{sys.error}</Callout>}
      <Grid cols={2}>
        <Card title={s ? [s.manufacturer, s.model].filter(Boolean).join(' ') : 'Server'} subtitle={s?.serviceTag ? `Service tag ${s.serviceTag}` : undefined}>
          {s ? (
            <KeyValue
              items={[
                ['Health', <Status key="h" tone={s.health === 'OK' ? 'good' : s.health === 'Warning' ? 'warning' : s.health ? 'critical' : 'neutral'}>{s.health ?? 'Unknown'}</Status>],
                ['Power', s.powerState],
                ['Processors', s.processors],
                ['Memory', s.memoryGb ? `${s.memoryGb} GB` : null],
                ['BIOS', s.biosVersion],
                ['Controller', s.controller ? `${s.controller.name}${s.controller.firmware ? ` · firmware ${s.controller.firmware}` : ''}` : null],
                ['Serial', s.serial],
              ]}
            />
          ) : (
            <Empty title="Asking the controller…" />
          )}
        </Card>
        <Card title="Power">
          {app.can('admin') && s ? (
            <div className="fx-form">
              <div className="fx-row" style={{ gap: 8, flexWrap: 'wrap' }}>
                {s.resetTypes.includes('On') && s.powerState !== 'On' && (
                  <Button variant="primary" icon="power" loading={busy === 'On'} onClick={() => void run('On', async () => { await api('POST', '/v1/bmc/power', { resetType: 'On' }); await sys.reload(); }, 'Turning on')}>
                    Turn on
                  </Button>
                )}
                {s.resetTypes.includes('GracefulRestart') && <Button icon="refresh" loading={busy === 'GracefulRestart'} onClick={() => void power('GracefulRestart', 'Restart the server', offWarn)}>Restart</Button>}
                {s.resetTypes.includes('GracefulShutdown') && <Button icon="power" loading={busy === 'GracefulShutdown'} onClick={() => void power('GracefulShutdown', 'Shut the server down', offWarn)}>Shut down</Button>}
                {s.resetTypes.includes('ForceRestart') && <Button variant="danger" loading={busy === 'ForceRestart'} onClick={() => void power('ForceRestart', 'Force a restart', `${offWarn} Nothing is shut down cleanly.`)}>Force restart</Button>}
                {s.resetTypes.includes('ForceOff') && <Button variant="danger" loading={busy === 'ForceOff'} onClick={() => void power('ForceOff', 'Force the server off', `${offWarn} Nothing is shut down cleanly.`)}>Force off</Button>}
              </div>
              <div className="fx-help">Shut down and restart ask the operating system first (virtual machines are shut down too). Force skips that.</div>
            </div>
          ) : (
            <div className="fx-muted">Administrators control power.</div>
          )}
        </Card>
      </Grid>
      <Grid cols={3}>
        {(['temperature', 'fan', 'power'] as const).map((kind) => (
          <Card key={kind} title={kind === 'temperature' ? 'Temperatures' : kind === 'fan' ? 'Fans' : 'Power'} flush>
            <Table
              rows={list.filter((x) => x.kind === kind || (kind === 'power' && x.kind === 'voltage'))}
              rowKey={(x) => `${x.kind}:${x.name}`}
              empty={<Empty title={sensors.data ? 'None reported' : 'Loading…'} />}
              columns={[
                { key: 'n', header: 'Sensor', render: (x) => x.name },
                {
                  key: 'r',
                  header: 'Reading',
                  render: (x) => (
                    <span className="vt-sensor">
                      {x.upperCritical && x.reading != null && <span className="vt-sensor-bar" style={{ width: `${Math.min(100, (x.reading / x.upperCritical) * 100)}%` }} />}
                      <span>{x.reading == null ? '—' : `${x.reading} ${x.unit}`}</span>
                    </span>
                  ),
                },
                { key: 'h', header: '', render: (x) => x.health && <Status tone={x.health === 'OK' ? 'good' : x.health === 'Warning' ? 'warning' : 'critical'}>{x.health}</Status> },
              ]}
            />
          </Card>
        ))}
      </Grid>
      {dialog}
    </>
  );
}

/** Settings FBRX Virtual wants, by their Dell names (other makers' are matched when their names are the same). */
const RECOMMENDED: Array<{ name: string; value: string; why: string }> = [
  { name: 'ProcVirtualization', value: 'Enabled', why: 'Hardware virtualization (VT-x and VT-d): virtual machines at full speed, and PCI devices for them.' },
  { name: 'SriovGlobalEnable', value: 'Enabled', why: 'Lets network cards split into many virtual ones for virtual machines.' },
  { name: 'SysProfile', value: 'PerfOptimized', why: 'Keeps processors at full speed instead of saving power (snappier virtual machines).' },
  { name: 'BootMode', value: 'Uefi', why: 'Modern boot, needed for Secure Boot and disks over 2 TB.' },
];

function Bios() {
  const app = useApp();
  const toast = useToast();
  const { busy, run } = useAction();
  const { confirm, dialog } = useConfirm();
  const bios = usePoll<BiosSettings>('/v1/bmc/bios', 60000);
  const [edits, setEdits] = useState<Record<string, string | number | boolean>>({});
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const admin = app.can('admin');
  const attrs = bios.data?.attributes ?? [];
  const groups = useMemo(() => {
    const m = new Map<string, BiosAttribute[]>();
    for (const a of attrs) {
      if (q && !`${a.displayName} ${a.name} ${a.help ?? ''}`.toLowerCase().includes(q.toLowerCase())) continue;
      m.set(a.group, [...(m.get(a.group) ?? []), a]);
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [attrs, q]);
  const recommended = RECOMMENDED.map((r) => ({ ...r, attr: attrs.find((a) => a.name === r.name) })).filter((r) => r.attr && r.attr.options.some((o) => o.value === r.value));
  const missing = recommended.filter((r) => (r.attr!.pending ?? r.attr!.value) !== r.value && edits[r.name] !== r.value);
  const count = Object.keys(edits).length;
  const apply = async (restart: boolean) => {
    if (restart && !(await confirm({ title: 'Apply and restart the server now?', body: 'The server restarts, applies the BIOS changes (it may restart twice) and comes back. Every virtual machine on it stops meanwhile.', confirmLabel: 'Apply and restart', danger: true }))) return;
    await run('apply', async () => {
      await api('PATCH', '/v1/bmc/bios', { changes: edits, restart });
      setEdits({});
      await bios.reload();
      toast.success(restart ? 'The server is restarting to apply the changes' : 'Saved for the next restart', restart ? undefined : 'Nothing changes until the server restarts.');
    });
  };
  if (bios.error && !bios.data) return <Callout tone="critical">{bios.error}</Callout>;
  if (!bios.data) return <Empty title="Reading the BIOS settings…" />;
  return (
    <>
      {recommended.length > 0 && (
        <Card
          title="Recommended for FBRX Virtual"
          actions={admin && missing.length > 0 && <Button size="sm" variant="primary" onClick={() => setEdits((e) => ({ ...e, ...Object.fromEntries(missing.map((m) => [m.name, m.value])) }))}>Use all {missing.length}</Button>}
        >
          <div className="vt-reco">
            {recommended.map((r) => {
              const now = r.attr!.pending ?? r.attr!.value;
              const ok = now === r.value || edits[r.name] === r.value;
              const label = r.attr!.options.find((o) => o.value === r.value)?.label ?? r.value;
              return (
                <div key={r.name} className="vt-reco-row">
                  <Status tone={ok ? 'good' : 'warning'}>{ok ? 'Set' : 'Not set'}</Status>
                  <div>
                    <b>{r.attr!.displayName}</b>: {label}
                    <div className="fx-cell-sub">{r.why}</div>
                  </div>
                </div>
              );
            })}
          </div>
        </Card>
      )}
      {(bios.data.pendingCount > 0 || bios.data.jobs.length > 0) && (
        <Card
          title="Waiting for the next restart"
          actions={
            admin &&
            bios.data.pendingCount > 0 && (
              <Button size="sm" variant="danger" loading={busy === 'clear'} onClick={() => void run('clear', async () => { await api('DELETE', '/v1/bmc/bios/pending'); await bios.reload(); }, 'Waiting changes thrown away')}>
                Throw them away
              </Button>
            )
          }
        >
          <div className="fx-form">
            {bios.data.pendingCount > 0 && <div>{bios.data.pendingCount} BIOS change{bios.data.pendingCount === 1 ? '' : 's'} apply when the server restarts.</div>}
            {bios.data.jobs.slice(0, 4).map((j) => (
              <div key={j.id} className="fx-row" style={{ gap: 8 }}>
                <span className="mono">{j.id}</span> {j.name} <Status tone={/fail/i.test(j.state) ? 'critical' : /complete/i.test(j.state) ? 'good' : 'busy'}>{j.state}</Status>
                {j.percent != null && <span className="fx-muted">{j.percent}%</span>}
                {j.message && <span className="fx-secondary">{j.message}</span>}
              </div>
            ))}
          </div>
        </Card>
      )}
      <Card
        title="All BIOS settings"
        subtitle="Changes are staged and applied by the server at its next restart."
        actions={
          admin && (
            <>
              <Button size="sm" loading={busy === 'setup'} onClick={() => void run('setup', async () => { await api('POST', '/v1/bmc/boot-to-setup', { restart: false }); }, 'Next start goes into BIOS setup')}>
                Next start: BIOS setup
              </Button>
            </>
          )
        }
      >
        <div className="fx-form">
          <Input placeholder={`Find among ${attrs.length} settings (virtualization, boot, power…)`} value={q} onChange={(e) => setQ(e.target.value)} aria-label="Find a setting" />
          {groups.map(([group, items]) => {
            const isOpen = !!q || open === group;
            const changed = items.filter((a) => a.name in edits).length;
            return (
              <div key={group} className={`vt-bios-group${isOpen ? ' open' : ''}`}>
                <button className="vt-bios-head" onClick={() => setOpen(isOpen && !q ? null : group)}>
                  <b>{group}</b>
                  <span className="fx-muted">{items.length}</span>
                  {changed > 0 && <span className="fx-badge">{changed} changed</span>}
                  {items.some((a) => a.pending !== null) && <span className="fx-badge">waiting</span>}
                </button>
                {isOpen && (
                  <div className="vt-bios-items">
                    {items.map((a) => (
                      <BiosRow key={a.name} a={a} edit={edits[a.name]} admin={admin} onChange={(v) => setEdits((e) => { const n = { ...e }; if (v === undefined || v === (a.pending ?? a.value)) delete n[a.name]; else n[a.name] = v; return n; })} />
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </Card>
      {admin && count > 0 && (
        <div className="vt-savebar">
          <span>
            <b>{count}</b> change{count === 1 ? '' : 's'}: {Object.keys(edits).map((k) => attrs.find((a) => a.name === k)?.displayName ?? k).join(', ')}
          </span>
          <span className="fx-spacer" />
          <Button onClick={() => setEdits({})}>Discard</Button>
          <Button loading={busy === 'apply'} onClick={() => void apply(false)}>
            Apply at next restart
          </Button>
          <Button variant="primary" loading={busy === 'apply'} onClick={() => void apply(true)}>
            Apply and restart now
          </Button>
        </div>
      )}
      {dialog}
    </>
  );
}

function BiosRow({ a, edit, admin, onChange }: { a: BiosAttribute; edit: string | number | boolean | undefined; admin: boolean; onChange: (v: string | number | boolean | undefined) => void }) {
  const current = edit ?? a.pending ?? a.value;
  const label = (v: unknown) => a.options.find((o) => o.value === v)?.label ?? String(v ?? '—');
  const editable = admin && !a.readOnly && a.type !== 'password' && a.type !== 'unknown';
  return (
    <div className={`vt-bios-row${edit !== undefined ? ' changed' : ''}`}>
      <div>
        <div className="fx-cell-title">{a.displayName}</div>
        {a.help && <div className="fx-cell-sub">{a.help}</div>}
        {a.pending !== null && <div className="fx-cell-sub">Now {label(a.value)} · becomes {label(a.pending)} at the next restart</div>}
      </div>
      <div className="vt-bios-value">
        {!editable ? (
          <span className="fx-secondary">{a.type === 'password' ? '••••' : label(current)}</span>
        ) : a.type === 'enum' ? (
          <Select value={String(current)} onChange={(e) => onChange(e.target.value)} options={a.options.map((o) => ({ value: o.value, label: o.label }))} aria-label={a.displayName} />
        ) : a.type === 'boolean' ? (
          <Toggle checked={!!current} onChange={(v) => onChange(v)} />
        ) : (
          <Input
            type={a.type === 'integer' ? 'number' : 'text'}
            min={a.min ?? undefined}
            max={a.max ?? undefined}
            value={String(current ?? '')}
            onChange={(e) => onChange(a.type === 'integer' ? Number(e.target.value) : e.target.value)}
            aria-label={a.displayName}
          />
        )}
      </div>
    </div>
  );
}

function EventLog() {
  const logs = usePoll<{ entries: BmcLogEntry[] }>('/v1/bmc/logs', 60000);
  return (
    <Card title="Hardware event log" subtitle="What the controller recorded: memory and disk errors, power, temperature and fan events." flush>
      <Table
        rows={logs.data?.entries ?? []}
        rowKey={(e) => e.id}
        empty={<Empty title={logs.data ? 'Nothing recorded' : 'Loading…'} />}
        columns={[
          { key: 'a', header: 'When', render: (e) => (e.at ? <span title={formatDate(e.at)}>{timeAgo(e.at)}</span> : '—') },
          { key: 's', header: 'Severity', render: (e) => <Status tone={e.severity === 'OK' ? 'good' : e.severity === 'Warning' ? 'warning' : e.severity === 'Critical' ? 'critical' : 'neutral'}>{e.severity ?? '—'}</Status> },
          { key: 'm', header: 'Message', render: (e) => e.message },
        ]}
      />
    </Card>
  );
}

function Connection({ config, onChanged }: { config: BmcConfig; onChanged: () => void }) {
  const app = useApp();
  const { busy, run } = useAction();
  const { confirm, dialog } = useConfirm();
  return (
    <Card title="Connection">
      <KeyValue
        items={[
          ['Controller', config.kind ?? 'Redfish'],
          ['Address', <span key="h" className="mono">{config.host}</span>],
          ['Account', config.username],
          ['Trusted certificate', <span key="f" className="mono" style={{ wordBreak: 'break-all' }}>{config.fingerprint ?? 'Signed by a trusted authority'}</span>],
          ['Connected', config.connectedAt ? formatDate(config.connectedAt) : '—'],
        ]}
      />
      {app.can('admin') && (
        <div style={{ marginTop: 14 }}>
          <Button
            variant="danger"
            icon="x"
            loading={busy === 'off'}
            onClick={async () => {
              if (await confirm({ title: 'Disconnect the management controller?', body: 'FBRX Virtual forgets its address and password. The server itself is not touched.', confirmLabel: 'Disconnect', danger: true }))
                await run('off', async () => { await api('DELETE', '/v1/bmc'); onChanged(); });
            }}
          >
            Disconnect
          </Button>
        </div>
      )}
      {dialog}
    </Card>
  );
}

