import { useCallback, useEffect, useRef, useState } from 'react';
import type { MeshDevice, MeshJob, MeshPermissions } from '@fbrx/shared';
import { funEnabled } from '@fbrx/shared';
import { useTier } from '../edition';
import { Button, Callout, Card, Empty, Field, Grid, Icons, Input, Modal, Page, Select, Status, TextArea, Toggle, timeAgo, useAction, useConfirm, useToast } from '@fbrx/ui';
import { call, onEvent } from '../client';
import { newReqId, useAgentName, useCore } from '../hooks';
import { PointingComputers, useTriplePing } from '../mesh-egg';
import { MeshAssistCard } from './mesh-assist';
import { PreferMeshCard } from './mesh-network';

const PERMS: Array<{ key: keyof MeshPermissions; label: string; help: string }> = [
  { key: 'status', label: 'See status', help: 'Health, performance and service status of this computer' },
  { key: 'chat', label: 'Messages', help: 'Send and receive messages and notifications' },
  { key: 'ask', label: 'Ask the agent', help: 'Ask this computer’s agent to do things (still follows this computer’s policy)' },
  { key: 'approve', label: 'Approve actions', help: 'Approve or deny actions waiting on this computer' },
  { key: 'workspace', label: 'Tasks and notes', help: 'Read and edit tasks and notes' },
  { key: 'alerts', label: 'Alerts', help: 'Receive this computer’s alerts' },
  { key: 'control', label: 'Remote control', help: 'Lock this computer or put it to sleep' },
  { key: 'assist', label: 'Help with AI', help: 'Ask this computer’s AI to help with its own work (Mesh Assist settings above decide whether to ask you)' },
  { key: 'network', label: 'Network protection', help: 'When it is a gate with FBRX MiniDome: it tells this computer about threats it sees coming from it, and sees how this computer is protected.' },
  { key: 'command', label: 'Controller', help: 'When it runs as administrator: its work runs here without asking, may be urgent, and may stop lower-priority help. Still follows this computer’s policy.' },
];
/** Mesh Assist permissions only mean something between computers. */
const permsFor = (d: MeshDevice) => PERMS.filter((p) => d.kind === 'desktop' || (p.key !== 'assist' && p.key !== 'command'));

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
      title="Pair a phone or computer"
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
              <strong>Another FBRX computer:</strong> open Mesh &amp; phone there, choose <em>Join a computer</em> and enter:
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

function Join({ onClose }: { onClose: () => void }) {
  const [code, setCode] = useState('');
  const [host, setHost] = useState('');
  const { run, busy } = useAction();
  const status = useCore('mesh.status', undefined, ['mesh.changed']);
  return (
    <Modal
      title="Join another computer"
      description="On the other computer, open Mesh & phone and choose Pair a device to show a code."
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy === 'pair'} disabled={!code || !host} onClick={() => void run('pair', () => call('mesh.pair', { code, host }), 'Paired').then((r) => r && onClose())}>
            Pair
          </Button>
        </>
      }
    >
      <div className="fx-grid">
        <Field label="Other computer" help="Its name or address as shown under the code (for example 192.168.1.20:47800)">
          <Input value={host} onChange={(e) => setHost(e.target.value)} list="mesh-nearby" />
          <datalist id="mesh-nearby">
            {(status.data?.nearby ?? []).map((n) => (
              <option key={n.id} value={n.addr}>
                {n.name}
              </option>
            ))}
          </datalist>
        </Field>
        <Field label="Pairing code">
          <Input className="mono" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="XXXX-XXXX-XXXX-XXXX-XXXX" />
        </Field>
      </div>
    </Modal>
  );
}

function DeviceCard({ d, onPing }: { d: MeshDevice; onPing?: (d: MeshDevice) => void }) {
  const { run, busy } = useAction();
  const { confirm, dialog } = useConfirm();
  const [ask, setAsk] = useState(false);
  const [info, setInfo] = useState<any>(null);
  const agent = useAgentName();
  const toast = useToast();
  return (
    <Card
      title={
        <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {d.kind === 'mobile' ? <Icons.phone size={16} /> : <Icons.laptop size={16} />}
          {d.name}
        </span>
      }
      subtitle={`${d.platform || d.kind}${d.version ? ` · v${d.version}` : ''}${d.addr ? ` · ${d.addr}` : ''} · paired ${timeAgo(d.pairedAt)}`}
      actions={<Status tone={d.online ? 'good' : 'neutral'}>{d.online ? 'online' : d.lastSeen ? `seen ${timeAgo(d.lastSeen)}` : 'offline'}</Status>}
    >
      <div className="fx-grid" style={{ gap: 12 }}>
        <div>
          <div className="fx-label">What {d.name} may do on this computer</div>
          <div className="perm-grid">
            {permsFor(d).map((p) => (
              <label key={p.key} className="perm" title={p.help}>
                <Toggle checked={d.permissions[p.key]} onChange={(v) => void run(p.key, () => call('mesh.setPermissions', { id: d.id, permissions: { [p.key]: v } }))} />
                <span>{p.label}</span>
              </label>
            ))}
          </div>
        </div>
        <div className="fx-muted" style={{ fontSize: 11.5 }}>
          Fingerprint <span className="mono">{d.fingerprint.slice(0, 16).toUpperCase().match(/.{4}/g)!.join(' ')}</span>
        </div>
        <div className="fx-actions">
          {d.kind === 'desktop' && (
            <>
              <Button size="sm" icon="sparkles" onClick={() => setAsk(true)}>
                Ask its agent
              </Button>
              <Button size="sm" icon="activity" loading={busy === 'info'} onClick={() => void run('info', () => call('mesh.peerInfo', { id: d.id })).then((r) => r && setInfo(r))}>
                Status
              </Button>
              <Button size="sm" variant="ghost" onClick={() => void run('lock', () => call('mesh.action', { id: d.id, action: 'lock' }), 'Lock sent')}>
                Lock
              </Button>
            </>
          )}
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              onPing?.(d);
              void run('n', () => call('mesh.action', { id: d.id, action: 'notify', text: 'Hello from your computer' }), 'Sent');
            }}
          >
            Send a ping
          </Button>
          {d.kind === 'mobile' && (
            <Button size="sm" variant="ghost" onClick={() => void run('loc', () => call('mesh.action', { id: d.id, action: 'locate' }), 'Your phone will ring when FBRX Mobile is open')}>
              Find my phone
            </Button>
          )}
          <span className="fx-spacer" />
          <Button
            size="sm"
            variant="danger"
            icon="trash"
            onClick={async () => {
              if (await confirm({ title: `Remove ${d.name}?`, body: 'It immediately loses access to this computer. Pair it again to reconnect.', danger: true, confirmLabel: 'Remove' })) {
                await call('mesh.removeDevice', { id: d.id });
                toast.success(`${d.name} removed`);
              }
            }}
          >
            Remove
          </Button>
        </div>
        {info && <pre className="fx-code" style={{ maxHeight: 220, margin: 0 }}>{JSON.stringify(info, null, 2)}</pre>}
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

export function MeshPage() {
  const status = useCore('mesh.status', undefined, ['mesh.changed']);
  const messages = useCore('mesh.messages', undefined, ['mesh.message']);
  const settings = useCore('settings.get', undefined, ['settings.changed']);
  const [pairing, setPairing] = useState(false);
  const [joining, setJoining] = useState(false);
  const [text, setText] = useState('');
  const [name, setName] = useState<string | null>(null);
  const { run, busy } = useAction();
  const toast = useToast();
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
  return (
    <Page
      title="Mesh & phone"
      description="Connect your other FBRX computers and your phone. Every request between devices is encrypted, signed and limited by the permissions you give each device."
      actions={
        s?.running && (
          <>
            <Button icon="laptop" onClick={() => setJoining(true)}>
              Join a computer
            </Button>
            <Button variant="primary" icon="qr" loading={busy === 'pair'} onClick={() => void run('pair', () => call('mesh.startPairing')).then((r) => r && setPairing(true))}>
              Pair a device
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
          actions={<Toggle checked={s.enabled} onChange={(v) => void run('en', () => call('mesh.setEnabled', { enabled: v }))} label={s.enabled ? 'On' : 'Off'} />}
        >
          {s.error && <Callout tone="critical">{s.error}</Callout>}
          <Grid cols={3}>
            <Field label="Name on the mesh">
              <div className="fx-actions">
                <Input value={name ?? s.self.name} onChange={(e) => setName(e.target.value)} />
                {name !== null && name !== s.self.name && (
                  <Button size="sm" onClick={() => void run('rn', () => call('mesh.rename', { name: name! }), 'Renamed').then(() => setName(null))}>
                    Save
                  </Button>
                )}
              </div>
            </Field>
            <Field label="Reachable at">
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
            <Field label="When another computer asks this computer's agent">
              <Select
                value={incoming}
                onChange={(e) => void run('in', () => call('settings.update', { patch: { mesh: { incoming: e.target.value as 'ask' } } }))}
                options={[
                  { value: 'ask', label: 'Ask me first' },
                  { value: 'allow', label: 'Allow (policy still applies)' },
                  { value: 'deny', label: 'Never' },
                ]}
              />
            </Field>
          </Grid>
          <div className="fx-muted" style={{ fontSize: 11.5, marginTop: 8 }}>
            Fingerprint <span className="mono">{s.self.fingerprint.slice(0, 16).toUpperCase().match(/.{4}/g)!.join(' ')}</span> · compare it with what the other device shows.
          </div>
          {!s.enabled && (
            <Callout tone="info" title="Turn the mesh on to pair devices">
              FBRX listens on port {s.port} on your local network. Only devices you pair can do anything; Windows may ask once whether to allow FBRX through the firewall (choose private networks).
            </Callout>
          )}
        </Card>
      )}
      {s?.enabled && <MeshAssistCard devices={s.devices} running={s.running} />}
      {s?.enabled && <PreferMeshCard />}
      {s && s.devices.length > 0 ? (
        <Grid cols={2}>
          {s.devices.map((d) => (
            <DeviceCard key={d.id} d={d} onPing={(x) => triple(x.id)} />
          ))}
        </Grid>
      ) : (
        s?.running && (
          <Empty title="No paired devices yet" action={<Button variant="primary" icon="qr" onClick={() => void run('pair', () => call('mesh.startPairing')).then((r) => r && setPairing(true))}>Pair your phone</Button>}>
            Pair your phone to get alerts, approve actions and talk to your agent from anywhere in the house. Pair other FBRX computers to check on them and send messages.
          </Empty>
        )
      )}
      {s && s.nearby.length > 0 && (
        <Card title="Nearby FBRX computers" subtitle="Seen on your network but not paired">
          {s.nearby.map((n) => (
            <div key={n.id} className="fx-list-item">
              <Icons.laptop size={14} />
              <span style={{ flex: 1 }}>{n.name}</span>
              <span className="mono fx-muted">{n.addr}</span>
            </div>
          ))}
        </Card>
      )}
      {s?.running && (
        <Card title="Messages" subtitle="Between your devices">
          <div className="mesh-chat">
            {(messages.data ?? []).map((m) => (
              <div key={m.id} className={`mesh-msg${m.fromId === s.self.id ? ' mine' : ''}`}>
                <div className="fx-muted" style={{ fontSize: 11.5 }}>
                  {m.fromName} · {timeAgo(m.at)}
                </div>
                <div>{m.text}</div>
              </div>
            ))}
            {!messages.data?.length && <div className="fx-muted">No messages yet.</div>}
          </div>
          <div className="fx-actions" style={{ marginTop: 10 }}>
            <div style={{ flex: 1 }}>
              <Input value={text} placeholder="Message all your devices" onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && text.trim() && void run('msg', () => call('mesh.message', { text })).then((r) => r && setText(''))} />
            </div>
            <Button icon="send" loading={busy === 'msg'} disabled={!text.trim()} onClick={() => void run('msg', () => call('mesh.message', { text })).then((r) => r && setText(''))}>
              Send
            </Button>
          </div>
        </Card>
      )}
      {pairing && <Pairing onClose={() => setPairing(false)} />}
      {joining && <Join onClose={() => setJoining(false)} />}
      {pointing && <PointingComputers left={pointing.left} right={pointing.right} onClose={closePointing} />}
    </Page>
  );
}
