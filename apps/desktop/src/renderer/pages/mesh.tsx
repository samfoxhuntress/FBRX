import { useCallback, useEffect, useRef, useState } from 'react';
import type { MeshDevice, MeshJob, MeshPermissions } from '@fbrx/shared';
import { funEnabled } from '@fbrx/shared';
import { useTier } from '../edition';
import { Button, Callout, Card, ChoiceCards, Empty, Field, Grid, Icons, InfoTip, Input, KeyValue, MenuButton, Modal, More, Page, Select, Status, Tabs, TextArea, Toggle, timeAgo, useAction, useConfirm, useToast } from '@fbrx/ui';
import { navigate } from '../app';
import { call, onEvent } from '../client';
import { newReqId, useAgentName, useCore } from '../hooks';
import { PointingComputers, useTriplePing } from '../mesh-egg';
import { MeshAssistCard } from './mesh-assist';
import { PreferMeshCard } from './mesh-network';

const PERMS: Array<{ key: keyof MeshPermissions; label: string; help: string }> = [
  { key: 'status', label: 'See how it is doing', help: 'Its view of this computer’s health: processor, memory, battery, services, alerts waiting. Nothing private (no files, no messages).' },
  { key: 'chat', label: 'Messages', help: 'Send messages to this computer and receive yours. They show in Messages and as notifications.' },
  { key: 'ask', label: 'Ask the agent', help: 'Ask this computer’s agent to do things here. It still follows this computer’s policy, and risky steps still wait for approval.' },
  { key: 'approve', label: 'Approve actions', help: 'Say yes or no to actions waiting for approval on this computer, for example from your phone while you are away.' },
  { key: 'workspace', label: 'Tasks and notes', help: 'Read and edit this computer’s tasks and notes.' },
  { key: 'alerts', label: 'Alerts', help: 'Get this computer’s alerts (low disk, threats, failed backups…) as they happen.' },
  { key: 'control', label: 'Lock and sleep', help: 'Lock this computer or put it to sleep from the other device. Handy when you left it unlocked.' },
  { key: 'assist', label: 'Borrow its AI', help: 'Ask this computer’s AI to help with its own work when it gets stuck. Share AI (above) decides whether you are asked first.' },
];
/** Rarely wanted, never part of a preset: chosen one by one. */
const SPECIAL: Array<{ key: keyof MeshPermissions; label: string; help: string }> = [
  { key: 'network', label: 'Network protection', help: 'Only matters when the other device is an FBRX Server running as your network gate with FBRX MiniDome: it tells this computer about threats it sees coming from it, and sees how this computer is protected (antivirus on or off).' },
  { key: 'command', label: 'Controller', help: 'Lets the other computer hand out AI work that runs here without asking, may be urgent, and may stop less important help. Meant for one main computer you run as administrator. This computer’s policy still applies.' },
];
const relevant = (d: MeshDevice) => PERMS.filter((p) => d.kind === 'desktop' || p.key !== 'assist');

type Access = 'messages' | 'usual' | 'full' | 'none';
/** Presets for the everyday permissions: what most people want, in one choice. */
const ACCESS: Array<{ id: Access; label: string; hint: (d: MeshDevice) => string; perms: (d: MeshDevice) => Array<keyof MeshPermissions> }> = [
  {
    id: 'usual',
    label: 'The usual',
    hint: (d) => (d.kind === 'mobile' ? 'Alerts, approvals, messages, tasks and notes, and asking the agent: everything the phone app is for.' : 'See how this computer is doing, send messages, and borrow its AI when stuck.'),
    perms: (d) => (d.kind === 'mobile' ? ['status', 'chat', 'ask', 'approve', 'workspace', 'alerts'] : ['status', 'chat', 'assist']),
  },
  { id: 'full', label: 'Full trust', hint: () => 'Everything above, including locking this computer or putting it to sleep.', perms: (d) => relevant(d).map((p) => p.key) },
  { id: 'messages', label: 'Messages only', hint: () => 'It can send this computer messages and nothing else.', perms: () => ['chat'] },
  { id: 'none', label: 'Paused', hint: () => 'Stays paired but can do nothing, until you choose again.', perms: () => [] },
];
const accessOf = (d: MeshDevice): Access | 'custom' => {
  const on = new Set(relevant(d).filter((p) => d.permissions[p.key]).map((p) => p.key));
  const match = ACCESS.find((a) => {
    const want = a.perms(d);
    return want.length === on.size && want.every((k) => on.has(k)) && (a.id !== 'none' || SPECIAL.every((x) => !d.permissions[x.key]));
  });
  return match?.id ?? 'custom';
};
const accessPatch = (d: MeshDevice, a: Access): Partial<MeshPermissions> => {
  const want = new Set(ACCESS.find((x) => x.id === a)!.perms(d));
  const patch: Partial<MeshPermissions> = Object.fromEntries(relevant(d).map((p) => [p.key, want.has(p.key)]));
  if (a === 'none') for (const x of SPECIAL) patch[x.key] = false;
  return patch;
};

const fingerprint = (f: string) => f.slice(0, 16).toUpperCase().match(/.{4}/g)!.join(' ');

function Pairing({ onClose }: { onClose: () => void }) {
  const status = useCore('mesh.status', undefined, ['mesh.changed']);
  const [left, setLeft] = useState(0);
  const p = status.data?.pairing;
  useEffect(() => {
    const t = setInterval(() => setLeft(p ? Math.max(0, Math.round((Date.parse(p.expiresAt) - Date.now()) / 1000)) : 0), 500);
    return () => clearInterval(t);
  }, [p]);
  useEffect(() => {
    if (status.data && !status.data.pairing) onClose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status.data?.pairing]);
  return (
    <Modal
      title="Add your phone or a computer"
      onClose={() => void call('mesh.cancelPairing').finally(onClose)}
      footer={<Button onClick={() => void call('mesh.cancelPairing').finally(onClose)}>Cancel</Button>}
    >
      {p ? (
        <div className="pair">
          {p.qrDataUrl && <img src={p.qrDataUrl} alt="Pairing QR code" width={220} height={220} />}
          <div className="pair-steps">
            <p>
              <strong>Phone:</strong> on the same Wi-Fi, scan the code with the camera and open the link. FBRX Mobile opens and pairs itself.
            </p>
            <p>
              <strong>Another FBRX computer:</strong> open Mesh &amp; phone there, choose <em>Add a device → Enter a code</em>, and type:
            </p>
            <div className="pair-code mono">{p.code}</div>
            <div className="fx-muted" style={{ fontSize: 12.5 }}>
              Address: <span className="mono">{p.url.replace(/^http:\/\//, '').split('/')[0]}</span> · expires in {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}
            </div>
            <p className="fx-muted" style={{ fontSize: 12.5 }}>
              The code works once. Both sides prove they know it before keys are exchanged, so nobody else on the network can slip in.
            </p>
          </div>
        </div>
      ) : (
        <Empty title="Pairing finished" />
      )}
    </Modal>
  );
}

function Join({ onClose, host: initialHost = '' }: { onClose: () => void; host?: string }) {
  const [code, setCode] = useState('');
  const status = useCore('mesh.status', undefined, ['mesh.changed']);
  const nearby = status.data?.nearby ?? [];
  // A computer from the list, or one typed in.
  const [pick, setPick] = useState(initialHost);
  const [typed, setTyped] = useState(initialHost);
  const host = nearby.length && pick !== '__typed' ? pick : typed;
  const { run, busy } = useAction();
  return (
    <Modal
      title="Join another computer"
      description="On the other computer, open Mesh & phone, choose Add a device, then Show a code on this computer."
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy === 'pair'} disabled={!code || !host.trim()} onClick={() => void run('pair', () => call('mesh.pair', { code, host: host.trim() }), 'Paired').then((r) => r && onClose())}>
            Pair
          </Button>
        </>
      }
    >
      <div className="fx-grid">
        {nearby.length > 0 ? (
          <Field label="Other computer" info="FBRX computers on your network announce themselves. If yours is not listed, pick Type its address and enter what the other computer shows under its code.">
            <Select
              value={pick}
              onChange={(e) => setPick(e.target.value)}
              options={[{ value: '', label: 'Choose a computer…', disabled: true }, ...nearby.map((n) => ({ value: n.addr, label: `${n.name} (${n.addr})` })), { value: '__typed', label: 'Type its address…' }]}
            />
            {pick === '__typed' && <Input autoFocus value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="192.168.1.20:47800" />}
          </Field>
        ) : (
          <Field label="Other computer" help="Its address, as shown under the code (for example 192.168.1.20:47800)">
            <Input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="192.168.1.20:47800" />
          </Field>
        )}
        <Field label="Pairing code" info="The code works once and for five minutes. Both computers prove they know it before they swap keys, so nobody else on the network can join in.">
          <Input className="mono" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="XXXX-XXXX-XXXX-XXXX-XXXX" />
        </Field>
      </div>
    </Modal>
  );
}

/** One button for both directions of pairing, so nobody has to know which side "pairs" and which "joins". */
function AddDevice({ onShowCode, onEnterCode, onClose }: { onShowCode: () => void; onEnterCode: () => void; onClose: () => void }) {
  const [how, setHow] = useState<'show' | 'enter'>('show');
  return (
    <Modal
      title="Add a device"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={how === 'show' ? onShowCode : onEnterCode}>
            Continue
          </Button>
        </>
      }
    >
      <ChoiceCards
        label="How to add it"
        value={how}
        onChange={setHow}
        options={[
          { value: 'show', icon: 'qr', title: 'Show a code on this computer', description: 'For your phone (scan it with the camera), or another FBRX computer that will enter it.' },
          { value: 'enter', icon: 'laptop', title: 'Enter a code from another computer', description: 'The other FBRX computer is showing a code already.' },
        ]}
      />
    </Modal>
  );
}

const pct = (n: number | null | undefined) => (typeof n === 'number' ? `${Math.round(n)}%` : '—');
const upFor = (sec: number | null | undefined) => {
  if (typeof sec !== 'number') return '—';
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  return d ? `${d} day${d === 1 ? '' : 's'}, ${h} h` : `${h} h ${Math.floor((sec % 3600) / 60)} min`;
};

/** What "See how it is doing" returns, in words instead of JSON. */
function PeerStatus({ info, onClose }: { info: any; onClose: () => void }) {
  const alerts = info?.alerts && typeof info.alerts === 'object' ? (info.alerts as Record<string, number>) : null;
  const items: Array<[string, string]> = [];
  if ('cpu' in (info ?? {})) items.push(['Processor', pct(info.cpu)]);
  if ('memUsedPct' in (info ?? {})) items.push(['Memory in use', pct(info.memUsedPct)]);
  if (info?.battery) items.push(['Battery', `${pct(info.battery.percent ?? info.battery.level)}${info.battery.charging ? ', charging' : ''}`]);
  if (typeof info?.tempC === 'number') items.push(['Temperature', `${Math.round(info.tempC)} °C`]);
  if ('uptimeSeconds' in (info ?? {})) items.push(['On for', upFor(info.uptimeSeconds)]);
  if (alerts) items.push(['Unread alerts', String(alerts.unread ?? 0)]);
  if (typeof info?.pendingApprovals === 'number') items.push(['Waiting for approval', String(info.pendingApprovals)]);
  if (typeof info?.openTasks === 'number') items.push(['Open tasks', String(info.openTasks)]);
  if (info?.vault) items.push(['Credential vault', String(info.vault)]);
  if (typeof info?.online === 'boolean') items.push(['Phone app', info.online ? 'open recently' : info.lastSeen ? `last seen ${timeAgo(info.lastSeen)}` : 'not seen yet']);
  const services: Array<{ name: string; state: string }> = Array.isArray(info?.services) ? info.services : [];
  return (
    <div className="mesh-peer-status">
      <div className="fx-row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <div className="fx-label">How it is doing</div>
        <Button size="sm" variant="ghost" icon="x" aria-label="Close" onClick={onClose} />
      </div>
      <KeyValue items={items} />
      {services.length > 0 && (
        <div className="fx-row" style={{ gap: 6, flexWrap: 'wrap' }}>
          {services.map((x) => (
            <Status key={x.name} tone={x.state === 'running' || x.state === 'ok' ? 'good' : x.state === 'disabled' || x.state === 'off' ? 'neutral' : 'warning'}>
              {x.name}
            </Status>
          ))}
        </div>
      )}
    </div>
  );
}

function DeviceCard({ d, onPing }: { d: MeshDevice; onPing?: (d: MeshDevice) => void }) {
  const { run, busy } = useAction();
  const { confirm, dialog } = useConfirm();
  const [ask, setAsk] = useState(false);
  const [info, setInfo] = useState<any>(null);
  const agent = useAgentName();
  const toast = useToast();
  const access = accessOf(d);
  const preset = ACCESS.find((a) => a.id === access);
  const setPerms = (permissions: Partial<MeshPermissions>) => void run('perm', () => call('mesh.setPermissions', { id: d.id, permissions }));
  const remove = async () => {
    if (await confirm({ title: `Remove ${d.name}?`, body: 'It loses access to this computer right away. Pair it again to reconnect.', danger: true, confirmLabel: 'Remove' })) {
      await call('mesh.removeDevice', { id: d.id });
      toast.success(`${d.name} removed`);
    }
  };
  return (
    <Card
      title={
        <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {d.kind === 'mobile' ? <Icons.phone size={16} /> : <Icons.laptop size={16} />}
          {d.name}
        </span>
      }
      subtitle={`${d.kind === 'mobile' ? 'Phone' : d.platform || 'Computer'}${d.version ? ` · FBRX ${d.version}` : ''} · paired ${timeAgo(d.pairedAt)}`}
      actions={<Status tone={d.online ? 'good' : 'neutral'}>{d.online ? 'online' : d.lastSeen ? `seen ${timeAgo(d.lastSeen)}` : 'offline'}</Status>}
    >
      <div className="fx-grid" style={{ gap: 12 }}>
        <Field
          label={`What ${d.name} may do here`}
          info="Pick a level of trust. You can change it at any time, and Choose one by one lets you set each permission yourself."
          help={preset ? preset.hint(d) : 'Chosen one by one (below).'}
        >
          <Select
            value={access}
            disabled={busy === 'perm'}
            onChange={(e) => e.target.value !== 'custom' && setPerms(accessPatch(d, e.target.value as Access))}
            options={[...ACCESS.map((a) => ({ value: a.id, label: a.label })), ...(access === 'custom' ? [{ value: 'custom', label: 'Custom' }] : [])]}
          />
        </Field>
        <More label="Choose one by one" defaultOpen={access === 'custom'}>
          <div className="perm-grid">
            {relevant(d).map((p) => (
              <Toggle key={p.key} checked={d.permissions[p.key]} onChange={(v) => setPerms({ [p.key]: v })} label={p.label} info={p.help} />
            ))}
          </div>
          {d.kind === 'desktop' && (
            <>
              <div className="fx-label">Special</div>
              <div className="perm-grid">
                {SPECIAL.map((p) => (
                  <Toggle key={p.key} checked={d.permissions[p.key]} onChange={(v) => setPerms({ [p.key]: v })} label={p.label} info={p.help} />
                ))}
              </div>
            </>
          )}
          <div className="fx-muted" style={{ fontSize: 11.5 }}>
            Fingerprint <span className="mono">{fingerprint(d.fingerprint)}</span>
          </div>
        </More>
        <div className="fx-actions">
          <Button size="sm" icon="message" onClick={() => navigate(`messages/mesh:${d.id}`)}>
            Message
          </Button>
          {d.kind === 'desktop' && (
            <Button size="sm" icon="sparkles" onClick={() => setAsk(true)}>
              Ask its agent
            </Button>
          )}
          <Button size="sm" icon="activity" loading={busy === 'info'} onClick={() => void run('info', () => call('mesh.peerInfo', { id: d.id })).then((r) => r && setInfo(r))}>
            How is it doing?
          </Button>
          <span className="fx-spacer" />
          <MenuButton
            items={[
              {
                label: 'Send a ping',
                icon: 'bell',
                hint: 'A small “hello” notification over there',
                onSelect: () => {
                  onPing?.(d);
                  void run('n', () => call('mesh.action', { id: d.id, action: 'notify', text: 'Hello from your computer' }), 'Sent');
                },
              },
              d.kind === 'mobile' && { label: 'Find my phone', icon: 'phone', hint: 'It rings when FBRX Mobile is open', onSelect: () => void run('loc', () => call('mesh.action', { id: d.id, action: 'locate' }), 'Your phone will ring when FBRX Mobile is open') },
              d.kind === 'desktop' && { label: 'Lock it', icon: 'lock', hint: 'Needs Lock and sleep on that computer', onSelect: () => void run('lock', () => call('mesh.action', { id: d.id, action: 'lock' }), 'Lock sent') },
              d.kind === 'desktop' && { label: 'Put it to sleep', icon: 'moon', hint: 'Needs Lock and sleep on that computer', onSelect: () => void run('sleep', () => call('mesh.action', { id: d.id, action: 'sleep' }), 'Sleep sent') },
              { label: 'Remove', icon: 'trash', danger: true, hint: 'Unpair it from this computer', onSelect: () => void remove() },
            ]}
          />
        </div>
        {info && <PeerStatus info={info} onClose={() => setInfo(null)} />}
      </div>
      {ask && <AskPeer device={d} agentName={agent} onClose={() => setAsk(false)} />}
      {dialog}
    </Card>
  );
}

function AskPeer({ device, onClose, agentName }: { device: MeshDevice; onClose: () => void; agentName: string }) {
  const [prompt, setPrompt] = useState('');
  const [job, setJob] = useState<MeshJob | null>(null);
  const reqRef = useRef<string>('');
  const { run, busy } = useAction();
  useEffect(() => onEvent('mesh.job', (e) => e.reqId === reqRef.current && setJob(e.job)), []);
  return (
    <Modal title={`Ask ${device.name}`} description={`Its agent works under ${device.name}’s own policy and approvals.`} wide onClose={onClose}>
      <div className="fx-grid">
        <TextArea rows={3} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="For example: how much free space do you have, and what is using it?" />
        <div className="fx-actions">
          <Button
            variant="primary"
            icon="send"
            loading={busy === 'ask'}
            disabled={!prompt.trim() || job?.status === 'running' || job?.status === 'waiting-approval'}
            onClick={() => {
              reqRef.current = newReqId();
              setJob(null);
              void run('ask', () => call('mesh.ask', { id: device.id, prompt, reqId: reqRef.current })).then((j) => j && setJob(j));
            }}
          >
            Send
          </Button>
          {job && <Status tone={job.status === 'done' ? 'good' : job.status === 'error' || job.status === 'denied' ? 'critical' : 'busy'}>{job.status.replace('-', ' ')}</Status>}
        </div>
        {job?.status === 'waiting-approval' && <Callout tone="info">Waiting for someone at {device.name} to approve the request.</Callout>}
        {job?.tools.length ? <div className="fx-muted" style={{ fontSize: 12.5 }}>Used: {job.tools.join(', ')}</div> : null}
        {job?.text && <div className="md" style={{ whiteSpace: 'pre-wrap' }}>{job.text}</div>}
        {job?.error && <Callout tone="critical">{job.error}</Callout>}
        <span className="fx-muted" style={{ fontSize: 12 }}>Answers come from {device.name}’s agent, not {agentName} on this computer.</span>
      </div>
    </Modal>
  );
}

type MeshTab = 'devices' | 'ai' | 'network';

export function MeshPage() {
  const status = useCore('mesh.status', undefined, ['mesh.changed']);
  const settings = useCore('settings.get', undefined, ['settings.changed']);
  const [adding, setAdding] = useState(false);
  const [pairing, setPairing] = useState(false);
  const [joining, setJoining] = useState<string | null>(null);
  const [name, setName] = useState<string | null>(null);
  const [tab, setTab] = useState<MeshTab>('devices');
  const { run, busy } = useAction();
  const toast = useToast();
  const agent = useAgentName();
  const s = status.data;
  const incoming = settings.data?.settings.mesh.incoming ?? 'ask';
  // Easter egg: three pings in a row to the same computer (or to yourself) and the two start pointing fingers.
  const fun = funEnabled(settings.data?.settings, useTier());
  const [pointing, setPointing] = useState<{ left: string; right: string } | null>(null);
  const triple = useTriplePing((key) => {
    if (!fun || !s) return;
    const peer = s.devices.find((x) => x.id === key);
    setPointing({ left: s.self.name, right: peer?.name ?? s.self.name });
  });
  const closePointing = useCallback(() => setPointing(null), []);
  const showCode = () => {
    setAdding(false);
    void run('pair', () => call('mesh.startPairing')).then((r) => r && setPairing(true));
  };
  const computers = s?.devices.filter((d) => d.kind === 'desktop').length ?? 0;
  return (
    <Page
      title="Mesh & phone"
      description="Link your FBRX computers and your phone so they can message each other, check in and share AI. Everything between them is encrypted, and each device can do only what you allow."
      actions={
        s?.running && (
          <>
            <Button icon="message" onClick={() => navigate('messages')}>
              Messages
            </Button>
            <Button variant="primary" icon="plus" loading={busy === 'pair'} onClick={() => setAdding(true)}>
              Add a device
            </Button>
          </>
        )
      }
    >
      {s && (
        <Card
          title={
            <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              This computer
              <Status tone={s.running ? 'good' : s.enabled ? 'critical' : 'neutral'}>{s.running ? 'mesh on' : s.enabled ? 'not running' : 'mesh off'}</Status>
            </span>
          }
          actions={
            <Toggle
              checked={s.enabled}
              onChange={(v) => void run('en', () => call('mesh.setEnabled', { enabled: v }))}
              label={s.enabled ? 'On' : 'Off'}
              info={`While on, FBRX listens on port ${s.port} on your local network. Only devices you pair can do anything, and only what you allow each one.`}
            />
          }
        >
          {s.error && <Callout tone="critical">{s.error}</Callout>}
          <Grid cols={3}>
            <Field label="Name on the mesh" info="What your other devices call this computer.">
              <div className="fx-actions">
                <Input value={name ?? s.self.name} onChange={(e) => setName(e.target.value)} />
                {name !== null && name !== s.self.name && (
                  <Button size="sm" onClick={() => void run('rn', () => call('mesh.rename', { name: name! }), 'Renamed').then(() => setName(null))}>
                    Save
                  </Button>
                )}
              </div>
            </Field>
            <Field label={`When a device asks ${agent} to do something`} info={`Applies to devices allowed to Ask the agent. ${agent} always follows this computer’s policy; risky steps still wait for approval.`}>
              <Select
                value={incoming}
                onChange={(e) => void run('in', () => call('settings.update', { patch: { mesh: { incoming: e.target.value as 'ask' } } }))}
                options={[
                  { value: 'ask', label: 'Ask me first' },
                  { value: 'allow', label: 'Go ahead (policy still applies)' },
                  { value: 'deny', label: 'Never' },
                ]}
              />
            </Field>
            <Field label="Reachable at" info="The address other devices use. Your phone needs to be on the same network (or reach it through FBRX Gate’s VPN).">
              {fun && s.self.addresses.length ? (
                <button
                  className="link-btn mono mesh-self-ping"
                  title="Ping this computer"
                  onClick={() => {
                    toast.info(`Reply from ${s.self.addresses[0]}: time<1ms`, 'This computer answers itself. Very reliable.');
                    triple('self');
                  }}
                >
                  {s.self.addresses.map((a) => `${a}:${s.port}`).join(', ')}
                </button>
              ) : (
                <div className="mono" style={{ fontSize: 13, paddingTop: 8 }}>
                  {s.self.addresses.map((a) => `${a}:${s.port}`).join(', ') || 'No network'}
                </div>
              )}
            </Field>
          </Grid>
          <div className="fx-row" style={{ gap: 6, alignItems: 'center', marginTop: 8 }}>
            <span className="fx-muted" style={{ fontSize: 11.5 }}>
              Fingerprint <span className="mono">{fingerprint(s.self.fingerprint)}</span>
            </span>
            <InfoTip>When you pair, the other device shows this computer’s fingerprint. If the two match, you paired with the right computer and nobody is in between.</InfoTip>
          </div>
          {!s.enabled && (
            <Callout tone="info" title="Turn the mesh on to add devices">
              Windows may ask once whether to let FBRX through the firewall: choose private networks.
            </Callout>
          )}
        </Card>
      )}
      {s?.enabled && (
        <Tabs<MeshTab>
          active={tab}
          onChange={setTab}
          tabs={[
            { id: 'devices', label: `Devices${s.devices.length ? ` (${s.devices.length})` : ''}` },
            { id: 'ai', label: 'Share AI' },
            { id: 'network', label: 'Network' },
          ]}
        />
      )}
      {s?.enabled && tab === 'ai' && (computers > 0 ? <MeshAssistCard devices={s.devices} running={s.running} /> : <Empty title="Add another FBRX computer first">Share AI lets your computers finish each other’s work when one gets stuck. Pair a second computer to use it.</Empty>)}
      {s?.enabled && tab === 'network' && <PreferMeshCard />}
      {s?.enabled && tab === 'devices' && (
        <>
          {s.devices.length > 0 ? (
            <Grid cols={2}>
              {s.devices.map((d) => (
                <DeviceCard key={d.id} d={d} onPing={(x) => triple(x.id)} />
              ))}
            </Grid>
          ) : (
            s.running && (
              <Empty title="No devices yet" action={<Button variant="primary" icon="plus" onClick={() => setAdding(true)}>Add a device</Button>}>
                Add your phone to get alerts, approve actions and talk to your agent from anywhere in the house. Add your other FBRX computers to message them, check on them and share AI.
              </Empty>
            )
          )}
          {s.nearby.length > 0 && (
            <Card title="FBRX computers nearby" subtitle="On your network, not paired yet">
              {s.nearby.map((n) => (
                <div key={n.id} className="fx-list-item">
                  <Icons.laptop size={14} />
                  <span style={{ flex: 1 }}>{n.name}</span>
                  <span className="mono fx-muted">{n.addr}</span>
                  <Button size="sm" onClick={() => setJoining(n.addr)}>
                    Join
                  </Button>
                </div>
              ))}
            </Card>
          )}
        </>
      )}
      {adding && (
        <AddDevice
          onClose={() => setAdding(false)}
          onShowCode={showCode}
          onEnterCode={() => {
            setAdding(false);
            setJoining('');
          }}
        />
      )}
      {pairing && <Pairing onClose={() => setPairing(false)} />}
      {joining !== null && <Join host={joining} onClose={() => setJoining(null)} />}
      {pointing && <PointingComputers left={pointing.left} right={pointing.right} onClose={closePointing} />}
    </Page>
  );
}
