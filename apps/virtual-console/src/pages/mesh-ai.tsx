import { useEffect, useState } from 'react';
import {
  ASSIST_PRIORITIES,
  ASSIST_TERMINAL,
  type ApprovalRequest,
  type AssistMode,
  type AssistOffer,
  type AssistPriority,
  type AssistSession,
  type AssistTools,
  isCidr,
  MESH_TRAFFIC_CLASSES,
  MESH_TRAFFIC_CLASS_WORDS,
  networkOf,
  type MeshDevice,
  type MeshNetworkStatus,
  type MeshPathTest,
  type MeshTrafficClass,
  type MeshPermissions,
  type MeshStatus,
  type ModelInfo,
  type ProviderConfig,
  type ProviderStatus,
  type Settings,
} from '@fbrx/shared';
import { Button, Callout, Card, CopyText, Empty, Field, Grid, Input, KeyValue, Page, Select, Status, Tabs, TextArea, Toggle, timeAgo, useAction, useConfirm, type StatusTone } from '@fbrx/ui';
import { api } from '../api';
import { useApp, usePoll, useRoute } from '../state';

/** The server's FBRX core (the "ai" role), reached through FBRX Virtual. */
interface CoreState {
  installed: boolean;
  running: boolean;
  version: string | null;
  error: string | null;
}
interface CoreSettings {
  settings: { general: { deviceName: string }; ai: Pick<Settings['ai'], 'defaultProvider' | 'defaultModel' | 'agentName' | 'providers'>; mesh: Settings['mesh'] };
  locked: string[];
}
type AssistSettings = Settings['mesh']['assist'];

const coreCall = async <T,>(method: string, params?: unknown): Promise<T> => (await api<{ result: T }>('POST', '/v1/core/call', { method, params })).result;

/** Polls a core method while the page is open. */
function useCore<T>(method: string | null, ms: number, params?: unknown) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const key = JSON.stringify(params ?? null);
  const load = async () => {
    if (!method) return;
    try {
      setData(await coreCall<T>(method, params));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  useEffect(() => {
    if (!method) return;
    void load();
    const t = setInterval(() => document.visibilityState === 'visible' && void load(), ms);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [method, ms, key]);
  return { data, error, reload: load, set: setData };
}

const MODES: Array<{ value: AssistMode; label: string }> = [
  { value: 'off', label: 'Never' },
  { value: 'ask', label: 'Ask an operator here first' },
  { value: 'auto', label: 'Automatically (policy still applies)' },
];
const PRIORITY_WORDS: Record<AssistPriority, string> = { background: 'Background', normal: 'Normal', high: 'High', urgent: 'Urgent (controllers only)' };
const TOOL_WORDS: Record<AssistTools, string> = { none: 'Think and answer only', read: 'Look things up (changes nothing)', all: 'Anything its policy allows' };
const STATUS_TONE: Record<AssistSession['status'], StatusTone> = { 'waiting-approval': 'warning', queued: 'info', running: 'busy', done: 'good', denied: 'neutral', error: 'critical', cancelled: 'neutral' };
const STATUS_WORDS: Record<AssistSession['status'], string> = { 'waiting-approval': 'waiting for a yes', queued: 'queued', running: 'working', done: 'done', denied: 'declined', error: 'failed', cancelled: 'stopped' };
const TRIGGER_WORDS: Record<AssistSession['trigger'], string> = { agent: 'consulted by the agent', steps: 'ran out of steps', provider: 'AI provider stopped answering', person: 'sent by a person', controller: 'sent by a controller' };
const PERMS: Array<{ key: keyof MeshPermissions; label: string; help: string }> = [
  { key: 'status', label: 'See status', help: 'Health and status of this server' },
  { key: 'chat', label: 'Messages', help: 'Send and receive messages' },
  { key: 'ask', label: 'Ask the agent', help: 'Ask this server’s agent to do things (it still follows this server’s policy)' },
  { key: 'approve', label: 'Approve actions', help: 'Approve or deny actions waiting on this server' },
  { key: 'alerts', label: 'Alerts', help: 'Receive this server’s alerts' },
  { key: 'assist', label: 'Help with AI', help: 'Ask this server’s AI to help with its own work (the Mesh Assist settings decide whether someone here is asked)' },
  { key: 'network', label: 'Network protection', help: 'This server’s FBRX MiniDome may tell it about threats seen coming from this server, and see how this server is protected (rarely needed for a server)' },
  { key: 'command', label: 'Controller', help: 'Its work runs here without asking, may be urgent, and may stop lower-priority help. Still follows this server’s policy.' },
];

type Tab = 'assist' | 'computers' | 'network' | 'provider';

/**
 * Mesh & AI: the FBRX core on this server lends its AI to the other computers on FBRX Mesh and borrows theirs (Mesh
 * Assist), and an administrator decides how. Everything here is the server's own setting, changed only by its
 * administrators; operators answer requests for help and hand out work.
 */
export function MeshAiPage({ tab }: { tab?: string }) {
  const [, go] = useRoute();
  const state = usePoll<CoreState>('/v1/core', 15000);
  const active = (['assist', 'computers', 'network', 'provider'].includes(tab ?? '') ? tab : 'assist') as Tab;
  const s = state.data;
  return (
    <Page title="Mesh & AI" description="This server's AI, the computers it works with on FBRX Mesh, and Mesh Assist: lending AI to each other when one runs out of steps or credits, and handing out work.">
      {!s ? (
        <Empty title="Loading…" />
      ) : !s.installed ? (
        <Card title="The AI role is not installed">
          <p className="fx-secondary">
            FBRX Server's <b>ai</b> role runs the FBRX core next to FBRX Virtual: an AI agent, FBRX Mesh and Mesh Assist. Add it on the server with:
          </p>
          <CopyText value="sudo ./install.sh --roles virtual,ai" />
        </Card>
      ) : !s.running ? (
        <Callout tone="critical" title="The FBRX core is not running">
          {s.error ?? 'It does not answer.'} On the server: <span className="mono">sudo systemctl status fbrx-core</span>
        </Callout>
      ) : (
        <>
          <Tabs<Tab>
            active={active}
            onChange={(t) => go('mesh', t)}
            tabs={[
              { id: 'assist', label: 'Mesh Assist' },
              { id: 'computers', label: 'Computers on the mesh' },
              { id: 'network', label: 'Prefer Mesh' },
              { id: 'provider', label: 'AI provider' },
            ]}
          />
          {active === 'assist' && <Assist />}
          {active === 'computers' && <Computers />}
          {active === 'network' && <PreferMesh />}
          {active === 'provider' && <Provider />}
        </>
      )}
    </Page>
  );
}

// ------------------------------------------------------------------------------------------ Mesh Assist

function Assist() {
  const app = useApp();
  const settings = useCore<CoreSettings>('settings.get', 30000);
  const mesh = useCore<MeshStatus>('mesh.status', 15000);
  const sessions = useCore<AssistSession[]>('mesh.assist.sessions', 4000);
  const approvals = useCore<ApprovalRequest[]>('approvals.list', 4000);
  const [helpers, setHelpers] = useState<AssistOffer[] | null>(null);
  const { run, busy } = useAction();
  const a = settings.data?.settings.mesh.assist;
  const agent = settings.data?.settings.ai.agentName ?? 'The agent';
  const admin = app.can('admin');
  if (settings.error) return <Callout tone="critical">{settings.error}</Callout>;
  if (!a || !mesh.data) return <Empty title="Loading…" />;
  const set = (patch: Partial<AssistSettings>) =>
    void run('set', async () => settings.set(await coreCall<CoreSettings>('settings.update', { patch: { mesh: { assist: patch } } })), 'Saved');
  const computers = mesh.data.devices.filter((d) => d.kind === 'desktop');
  const waiting = (approvals.data ?? []).filter((x) => admin || x.tool === 'mesh.assist');
  return (
    <>
      {!mesh.data.enabled && (
        <Callout tone="warning" title="FBRX Mesh is off on this server">
          Mesh Assist works between paired computers. {admin ? 'Turn the mesh on under Computers on the mesh.' : 'An administrator turns it on.'}
        </Callout>
      )}
      {waiting.length > 0 && (
        <Card title="Waiting for a yes" subtitle="Requests for this server's help (and, for administrators, anything else its agent wants to do).">
          {waiting.map((w) => (
            <div key={w.id} className="vt-approval">
              <div className="vt-approval-what">
                <Status tone="warning">{w.tool === 'mesh.assist' ? 'Mesh Assist' : w.risk}</Status>
                <strong>{w.toolTitle}</strong>
              </div>
              <span className="fx-muted vt-approval-why">
                {w.reason} · {timeAgo(w.requestedAt)}
              </span>
              {app.can('operator') && (
                <span className="fx-row" style={{ gap: 6 }}>
                  <Button size="sm" variant="primary" loading={busy === `y${w.id}`} onClick={() => void run(`y${w.id}`, () => coreCall('approvals.resolve', { id: w.id, decision: 'approve' })).then(() => approvals.reload())}>
                    Yes
                  </Button>
                  <Button size="sm" loading={busy === `n${w.id}`} onClick={() => void run(`n${w.id}`, () => coreCall('approvals.resolve', { id: w.id, decision: 'deny' })).then(() => approvals.reload())}>
                    No
                  </Button>
                </span>
              )}
            </div>
          ))}
        </Card>
      )}

      <Card
        title="How this server works with the others"
        subtitle={`When ${agent} here runs out of steps or its AI provider stops answering (credits, limits, an outage), another computer finishes the task; and this server can take on work for the others.`}
        actions={
          mesh.data.running && (
            <Button size="sm" icon="refresh" loading={busy === 'helpers'} onClick={() => void run('helpers', () => coreCall<AssistOffer[]>('mesh.assist.helpers')).then((h) => h && setHelpers(h))}>
              Who can help?
            </Button>
          )
        }
      >
        {!admin && <Callout tone="info">Only administrators change these.</Callout>}
        <Grid cols={2}>
          <fieldset className="vt-fieldset" disabled={!admin}>
            <div className="fx-label">This server asking for help</div>
            <Field label="Bring another computer's AI in">
              <Select value={a.request} onChange={(e) => set({ request: e.target.value as AssistMode })} options={MODES} />
            </Field>
            <Toggle disabled={!admin} checked={a.onStepLimit} onChange={(v) => set({ onStepLimit: v })} label={`When ${agent} runs out of steps`} />
            <Toggle disabled={!admin} checked={a.onProviderError} onChange={(v) => set({ onProviderError: v })} label="When the AI provider stops answering" />
            <Toggle disabled={!admin} checked={a.agentMayConsult} onChange={(v) => set({ agentMayConsult: v })} label={`${agent} may consult other computers itself`} />
            <Field label="Priority of this server's requests">
              <Select value={a.priority} onChange={(e) => set({ priority: e.target.value as AssistPriority })} options={ASSIST_PRIORITIES.map((p) => ({ value: p, label: PRIORITY_WORDS[p] }))} />
            </Field>
          </fieldset>
          <fieldset className="vt-fieldset" disabled={!admin}>
            <div className="fx-label">This server helping others</div>
            <Field label={`Lend ${agent} to other computers`}>
              <Select value={a.offer} onChange={(e) => set({ offer: e.target.value as AssistMode })} options={MODES} />
            </Field>
            <Field label={`While helping, ${agent} here may`}>
              <Select value={a.tools} onChange={(e) => set({ tools: e.target.value as AssistTools })} options={(['none', 'read', 'all'] as AssistTools[]).map((t) => ({ value: t, label: TOOL_WORDS[t] }))} />
            </Field>
            <Grid cols={2}>
              <Field label="Help at the same time">
                <Input type="number" min={1} max={8} value={a.maxConcurrent} onChange={(e) => set({ maxConcurrent: Math.max(1, Math.min(8, Number(e.target.value) || 1)) })} />
              </Field>
              <Field label="Steps per request">
                <Input type="number" min={1} max={100} value={a.maxSteps} onChange={(e) => set({ maxSteps: Math.max(1, Math.min(100, Number(e.target.value) || 1)) })} />
              </Field>
            </Grid>
            <Toggle disabled={!admin} checked={a.allowPreempt} onChange={(v) => set({ allowPreempt: v })} label="Urgent work from a controller may stop lower-priority help" />
          </fieldset>
        </Grid>
        <div className="vt-controller">
          <Toggle disabled={!admin} checked={a.controller} onChange={(v) => set({ controller: v })} label="This server is a controller" />
          <div className="fx-help">
            A controller hands out work as an administrator would: it runs without asking on computers that gave this server the <em>Controller</em> permission, may be urgent, and may stop lower-priority help there. Computers that did not give that permission treat it like anyone else. Each computer always applies its own policy, and help is never passed along twice.
          </div>
          <div className="fx-muted" style={{ fontSize: 12 }}>
            Roles this server announces: {a.roles.length ? a.roles.join(', ') : 'none'} (set when FBRX Server is installed: <span className="mono">install.sh --roles</span>)
          </div>
        </div>

        {helpers && (
          <div style={{ marginTop: 14 }}>
            <div className="fx-label">Right now</div>
            {helpers.length === 0 && <div className="fx-muted">No paired computer answered.</div>}
            {helpers.map((h) => (
              <div key={h.deviceId} className="fx-list-item">
                <Status tone={h.accepts === 'off' || !h.ai.ready ? 'neutral' : h.accepts === 'auto' ? 'good' : 'warning'}>{h.accepts === 'off' ? 'cannot help' : h.accepts === 'auto' ? 'helps right away' : 'asks first'}</Status>
                <strong>{h.name}</strong>
                <span className="fx-muted" style={{ flex: 1 }}>
                  {h.ai.ready ? `${h.ai.model ?? 'AI ready'}${h.ai.local ? ' (local)' : ''}` : (h.reason ?? 'no AI ready')} · busy {h.busy}/{h.capacity}
                  {h.queued ? `, ${h.queued} waiting` : ''}
                  {h.roles.length ? ` · ${h.roles.join(', ')}` : ''}
                  {h.load.cpu !== null ? ` · processor ${Math.round(h.load.cpu)}%` : ''}
                </span>
              </div>
            ))}
          </div>
        )}
      </Card>

      {app.can('operator') && mesh.data.running && computers.length > 0 && (
        <Card title="Hand out work" subtitle={a.controller ? 'As a controller: computers that made this server a controller start right away.' : 'Each computer asks or helps according to its own Mesh Assist settings.'}>
          <SendWork computers={computers} defaultPriority={a.priority} controller={a.controller} onSent={() => void sessions.reload()} />
        </Card>
      )}

      <Card title="Help asked and given">
        <SessionList sessions={sessions.data ?? []} canAct={app.can('operator')} onChanged={() => void sessions.reload()} />
      </Card>
    </>
  );
}

function SendWork({ computers, defaultPriority, controller, onSent }: { computers: MeshDevice[]; defaultPriority: AssistPriority; controller: boolean; onSent: () => void }) {
  const [goal, setGoal] = useState('');
  const [target, setTarget] = useState('any');
  const [priority, setPriority] = useState<AssistPriority>(defaultPriority);
  const [tools, setTools] = useState<AssistTools>('read');
  const { run, busy } = useAction();
  const priorities = ASSIST_PRIORITIES.filter((p) => controller || p !== 'urgent');
  return (
    <div className="fx-form">
      <TextArea rows={3} value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="For example: check the disks on every server and tell me which have less than 15% free" />
      <Grid cols={3}>
        <Field label="To">
          <Select value={target} onChange={(e) => setTarget(e.target.value)} options={[{ value: 'any', label: 'The best one available' }, { value: 'all', label: 'Every computer' }, ...computers.map((c) => ({ value: c.id, label: c.name }))]} />
        </Field>
        <Field label="Priority">
          <Select value={priority} onChange={(e) => setPriority(e.target.value as AssistPriority)} options={priorities.map((p) => ({ value: p, label: PRIORITY_WORDS[p] }))} />
        </Field>
        <Field label="They may">
          <Select value={tools} onChange={(e) => setTools(e.target.value as AssistTools)} options={(['none', 'read', 'all'] as AssistTools[]).map((t) => ({ value: t, label: TOOL_WORDS[t] }))} />
        </Field>
      </Grid>
      <Button
        variant="primary"
        icon="send"
        loading={busy === 'send'}
        disabled={!goal.trim()}
        onClick={() =>
          void run('send', () => coreCall('mesh.assist.send', { peerIds: target === 'any' ? 'any' : target === 'all' ? computers.map((c) => c.id) : [target], goal, priority, tools }), 'Sent').then((r) => {
            if (!r) return;
            setGoal('');
            onSent();
          })
        }
      >
        Send
      </Button>
    </div>
  );
}

function SessionList({ sessions, canAct, onChanged }: { sessions: AssistSession[]; canAct: boolean; onChanged: () => void }) {
  const [open, setOpen] = useState<string | null>(null);
  const [follow, setFollow] = useState('');
  const { run, busy } = useAction();
  if (!sessions.length) return <div className="fx-muted">No help asked or given yet.</div>;
  return (
    <div>
      {sessions.slice(0, 50).map((s) => {
        const active = !ASSIST_TERMINAL.includes(s.status);
        return (
          <div key={s.id} className="vt-assist-row">
            <button className="vt-assist-head" onClick={() => setOpen(open === s.id ? null : s.id)}>
              <span className="mono fx-muted" title={s.direction === 'out' ? 'Asked from this server' : 'Given by this server'}>
                {s.direction === 'out' ? '→' : '←'}
              </span>
              <strong>{s.peerName}</strong>
              <span className="vt-assist-goal">{s.goal}</span>
              <span className="fx-badge">{s.priority}</span>
              <Status tone={STATUS_TONE[s.status]}>{STATUS_WORDS[s.status]}</Status>
              <span className="fx-muted" style={{ fontSize: 12 }}>{timeAgo(s.createdAt)}</span>
            </button>
            {open === s.id && (
              <div className="vt-assist-body">
                <div className="fx-muted" style={{ fontSize: 12 }}>
                  {s.direction === 'out' ? `Asked from this server, ${TRIGGER_WORDS[s.trigger]}` : `Given here to ${s.peerName}, ${TRIGGER_WORDS[s.trigger]}`}
                  {s.admin && s.trigger !== 'controller' ? ' · as a controller' : ''} · {s.steps} step{s.steps === 1 ? '' : 's'}
                  {s.tools.length ? ` · used ${[...new Set(s.tools)].join(', ')}` : ''}
                </div>
                <div className="fx-secondary" style={{ whiteSpace: 'pre-wrap' }}>{s.goal}</div>
                {s.answer && <div className="vt-assist-answer">{s.answer}</div>}
                {s.error && <Callout tone={s.status === 'error' ? 'critical' : 'info'}>{s.error}</Callout>}
                {canAct && (
                  <div className="fx-actions">
                    {active && (
                      <Button size="sm" variant="danger" loading={busy === `c${s.id}`} onClick={() => void run(`c${s.id}`, () => coreCall('mesh.assist.cancel', { sessionId: s.id })).then(onChanged)}>
                        Stop
                      </Button>
                    )}
                    {!active && s.direction === 'out' && s.status === 'done' && (
                      <>
                        <div style={{ flex: 1 }}>
                          <Input value={follow} onChange={(e) => setFollow(e.target.value)} placeholder={`Ask ${s.peerName} a follow-up`} />
                        </div>
                        <Button
                          size="sm"
                          icon="send"
                          loading={busy === `f${s.id}`}
                          disabled={!follow.trim()}
                          onClick={() =>
                            void run(`f${s.id}`, () => coreCall('mesh.assist.followUp', { sessionId: s.id, text: follow })).then((r) => {
                              if (!r) return;
                              setFollow('');
                              onChanged();
                            })
                          }
                        >
                          Ask
                        </Button>
                      </>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ------------------------------------------------------------------------------------- computers

function Computers() {
  const app = useApp();
  const admin = app.can('admin');
  const mesh = useCore<MeshStatus>('mesh.status', 5000);
  const { run, busy } = useAction();
  const { confirm, dialog } = useConfirm();
  const [code, setCode] = useState('');
  const [host, setHost] = useState('');
  const m = mesh.data;
  if (mesh.error) return <Callout tone="critical">{mesh.error}</Callout>;
  if (!m) return <Empty title="Loading…" />;
  const act = (key: string, method: string, params?: unknown, ok?: string) => void run(key, () => coreCall(method, params), ok).then(() => mesh.reload());
  const setPerm = (d: MeshDevice, key: keyof MeshPermissions, v: boolean) =>
    void run(`p${d.id}${key}`, () => coreCall('mesh.setPermissions', { id: d.id, permissions: { [key]: v } })).then(() => mesh.reload());
  return (
    <>
      {dialog}
      <Grid cols={2}>
        <Card
          title="This server on the mesh"
          actions={admin && <Toggle checked={m.enabled} onChange={(v) => act('enable', 'mesh.setEnabled', { enabled: v }, v ? 'FBRX Mesh is on' : 'FBRX Mesh is off')} label={m.enabled ? 'On' : 'Off'} />}
        >
          <KeyValue
            items={[
              ['Name', m.self.name],
              ['State', <Status key="s" tone={m.running ? 'good' : m.enabled ? 'critical' : 'neutral'}>{m.running ? 'Running' : m.enabled ? 'Not running' : 'Off'}</Status>],
              ['Addresses', m.self.addresses.length ? `${m.self.addresses.join(', ')} (port ${m.port})` : '—'],
              ['Fingerprint', <span key="f" className="mono" style={{ fontSize: 12, wordBreak: 'break-all' }}>{m.self.fingerprint}</span>],
            ]}
          />
          {m.error && <Callout tone="critical">{m.error}</Callout>}
        </Card>
        {admin && m.running && (
          <Card title="Pair a computer" subtitle="Both computers see each other's fingerprint; compare them once.">
            {m.pairing ? (
              <div className="fx-form">
                <div className="fx-secondary">On the other computer, open Mesh &amp; phone, choose <em>Join a computer</em> and enter this server's address and this code:</div>
                <div className="fx-row" style={{ gap: 16 }}>
                  <div className="vt-pair-code mono">{m.pairing.code}</div>
                  {m.pairing.qrDataUrl && <img src={m.pairing.qrDataUrl} alt="Pairing code for a phone" width={104} height={104} className="vt-pair-qr" />}
                </div>
                <div className="fx-muted">
                  {m.self.addresses[0] ?? 'this server'} · until {new Date(m.pairing.expiresAt).toLocaleTimeString()}
                </div>
                <Button onClick={() => act('cancel', 'mesh.cancelPairing')}>Stop pairing</Button>
              </div>
            ) : (
              <div className="fx-form">
                <Button variant="primary" icon="plus" loading={busy === 'pairing'} onClick={() => act('pairing', 'mesh.startPairing')}>
                  Show a pairing code
                </Button>
                <div className="fx-label" style={{ marginTop: 8 }}>Or join another computer's code</div>
                <Grid cols={2}>
                  <Field label="Its address">
                    <Input value={host} onChange={(e) => setHost(e.target.value)} placeholder="192.168.1.30" />
                  </Field>
                  <Field label="Its code">
                    <Input className="mono" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="XXXX-XXXX-XXXX-XXXX-XXXX" />
                  </Field>
                </Grid>
                <Button
                  disabled={!host.trim() || !code.trim()}
                  loading={busy === 'pair'}
                  onClick={() =>
                    void run('pair', () => coreCall<MeshDevice>('mesh.pair', { host: host.trim(), code: code.trim() })).then((d) => {
                      if (!d) return;
                      setHost('');
                      setCode('');
                      void mesh.reload();
                    })
                  }
                >
                  Pair
                </Button>
              </div>
            )}
          </Card>
        )}
      </Grid>

      <Card title="Paired computers" subtitle="What each computer may do here. Help with AI and Controller are Mesh Assist.">
        {m.devices.length === 0 && <div className="fx-muted">No computers paired yet.</div>}
        {m.devices.map((d) => (
          <div key={d.id} className="vt-mesh-device">
            <div className="fx-row" style={{ gap: 10 }}>
              <Status tone={d.online ? 'good' : 'neutral'}>{d.online ? 'online' : 'offline'}</Status>
              <strong>{d.name}</strong>
              <span className="fx-muted" style={{ flex: 1 }}>
                {d.kind === 'mobile' ? 'phone' : d.platform} · FBRX {d.version}
                {d.addr ? ` · ${d.addr}` : ''}
                {d.lastSeen ? ` · seen ${timeAgo(d.lastSeen)}` : ''}
              </span>
              {admin && (
                <Button
                  size="sm"
                  variant="danger"
                  loading={busy === `r${d.id}`}
                  onClick={async () => {
                    if (await confirm({ title: `Unpair ${d.name}?`, body: 'It can no longer reach this server until it pairs again.', confirmLabel: 'Unpair', danger: true })) act(`r${d.id}`, 'mesh.removeDevice', { id: d.id });
                  }}
                >
                  Unpair
                </Button>
              )}
            </div>
            <div className="vt-chips" style={{ marginTop: 8 }}>
              {PERMS.filter((p) => d.kind === 'desktop' || (p.key !== 'assist' && p.key !== 'command')).map((p) => (
                <button key={p.key} className={`vt-chip${d.permissions[p.key] ? ' on' : ''}`} title={p.help} disabled={!admin || busy === `p${d.id}${p.key}`} onClick={() => setPerm(d, p.key, !d.permissions[p.key])}>
                  {p.label}
                </button>
              ))}
            </div>
          </div>
        ))}
      </Card>
    </>
  );
}

// -------------------------------------------------------------------------------------- AI provider

function Provider() {
  const app = useApp();
  const admin = app.can('admin');
  const settings = useCore<CoreSettings>('settings.get', 30000);
  const status = useCore<ProviderStatus[]>('ai.providers', 20000);
  const keys = useCore<Array<{ name: string; updatedAt: string }>>(admin ? 'vault.list' : null, 60000);
  const { run, busy } = useAction();
  const [models, setModels] = useState<Record<string, ModelInfo[]>>({});
  const [keyFor, setKeyFor] = useState<Record<string, string>>({});
  const ai = settings.data?.settings.ai;
  if (settings.error) return <Callout tone="critical">{settings.error}</Callout>;
  if (!ai) return <Empty title="Loading…" />;
  const save = (patch: Partial<CoreSettings['settings']['ai']>, ok = 'Saved') => void run('save', async () => settings.set(await coreCall<CoreSettings>('settings.update', { patch: { ai: patch } })), ok).then(() => status.reload());
  const setProvider = (id: string, patch: Partial<ProviderConfig>) => save({ providers: ai.providers.map((p) => (p.id === id ? { ...p, ...patch } : p)) });
  const enabled = ai.providers.filter((p) => p.enabled);
  const def = ai.providers.find((p) => p.id === ai.defaultProvider);
  return (
    <>
      <Card title="What this server's AI runs on" subtitle="A cloud provider with a key, or a model on your network (Ollama, or any OpenAI-compatible server). When it stops answering, Mesh Assist can hand the work to another computer.">
        {!admin && <Callout tone="info">Only administrators change these.</Callout>}
        <Grid cols={2}>
          <Field label="Provider">
            <Select disabled={!admin} value={ai.defaultProvider} onChange={(e) => save({ defaultProvider: e.target.value, defaultModel: '' })} options={enabled.map((p) => ({ value: p.id, label: p.name }))} />
          </Field>
          <Field label="Model" help={def?.defaultModel ? `Blank uses ${def.defaultModel}` : undefined}>
            <div className="vt-input-row">
              {models[ai.defaultProvider]?.length ? (
                <Select disabled={!admin} value={ai.defaultModel} onChange={(e) => save({ defaultModel: e.target.value })} options={[{ value: '', label: 'Provider default' }, ...models[ai.defaultProvider]!.map((m) => ({ value: m.id, label: m.name }))]} />
              ) : (
                <Input disabled={!admin} defaultValue={ai.defaultModel} key={ai.defaultProvider} onBlur={(e) => e.target.value !== ai.defaultModel && save({ defaultModel: e.target.value.trim() })} placeholder={def?.defaultModel ?? 'Provider default'} />
              )}
              {admin && (
                <Button size="sm" icon="refresh" loading={busy === 'models'} onClick={() => void run('models', () => coreCall<ModelInfo[]>('ai.models', { providerId: ai.defaultProvider })).then((list) => list && setModels((m) => ({ ...m, [ai.defaultProvider]: list })))} title="List the provider's models" aria-label="List models" />
              )}
            </div>
          </Field>
        </Grid>
      </Card>

      <Card title="Providers">
        {ai.providers.map((p) => {
          const st = status.data?.find((x) => x.id === p.id);
          const hasKey = keys.data?.some((k) => k.name === p.apiKeySecret);
          return (
            <div key={p.id} className="vt-mesh-device">
              <div className="fx-row" style={{ gap: 10 }}>
                <Status tone={!p.enabled ? 'neutral' : st?.available ? 'good' : 'warning'}>{!p.enabled ? 'off' : st?.available ? 'ready' : 'not ready'}</Status>
                <strong>{p.name}</strong>
                <span className="fx-muted" style={{ flex: 1 }}>
                  {p.cloud ? 'cloud' : 'on this server or your network'}
                  {st?.message ? ` · ${st.message}` : ''}
                </span>
                {admin && <Toggle checked={p.enabled} onChange={(v) => setProvider(p.id, { enabled: v })} label={p.enabled ? 'On' : 'Off'} />}
              </div>
              {admin && p.enabled && (p.type === 'ollama' || p.type === 'openai-compatible') && (
                <Field label="Address">
                  <Input defaultValue={p.baseUrl ?? ''} onBlur={(e) => e.target.value.trim() !== (p.baseUrl ?? '') && setProvider(p.id, { baseUrl: e.target.value.trim() || undefined })} placeholder="http://192.168.1.40:11434" />
                </Field>
              )}
              {admin && p.enabled && p.apiKeySecret && (
                <div className="fx-row" style={{ gap: 6, marginTop: 6 }}>
                  <div style={{ flex: 1 }}>
                    <Input type="password" autoComplete="off" value={keyFor[p.id] ?? ''} onChange={(e) => setKeyFor((k) => ({ ...k, [p.id]: e.target.value }))} placeholder={hasKey ? 'Key saved (enter a new one to replace it)' : 'API key'} />
                  </div>
                  <Button
                    size="sm"
                    variant="primary"
                    icon="key"
                    disabled={!keyFor[p.id]?.trim()}
                    loading={busy === `k${p.id}`}
                    onClick={() =>
                      void run(`k${p.id}`, () => coreCall('vault.set', { name: p.apiKeySecret, value: keyFor[p.id]!.trim() }), 'Key saved').then((r) => {
                        if (!r) return;
                        setKeyFor((k) => ({ ...k, [p.id]: '' }));
                        void keys.reload();
                        void status.reload();
                      })
                    }
                  >
                    Save key
                  </Button>
                </div>
              )}
            </div>
          );
        })}
        <div className="fx-help">Keys are kept encrypted in this server's FBRX vault and never shown again, here or anywhere else.</div>
      </Card>
    </>
  );
}

// -------------------------------------------------------------------------------------------- Prefer Mesh

function PreferMesh() {
  const app = useApp();
  const admin = app.can('admin');
  const settings = useCore<CoreSettings>('settings.get', 30000);
  const status = usePoll<MeshNetworkStatus>('/v1/core/network', 30000);
  const { run, busy } = useAction();
  const [subnet, setSubnet] = useState('');
  const [paths, setPaths] = useState<MeshPathTest[] | null>(null);
  const n = settings.data?.settings.mesh.network;
  const st = status.data;
  if (settings.error) return <Callout tone="critical">{settings.error}</Callout>;
  if (!n) return <Empty title="Loading…" />;
  const set = (patch: Partial<Settings['mesh']['network']>) =>
    void run('set', async () => settings.set(await coreCall<CoreSettings>('settings.update', { patch: { mesh: { network: patch } } })), 'Saved').then(() => status.reload());
  const add = (c: string) => {
    const v = c.trim();
    if (!isCidr(v) || n.subnets.includes(v)) return;
    set({ subnets: [...n.subnets, v] });
    setSubnet('');
  };
  const suggestions = (st?.local ?? []).map((a) => networkOf(a.cidr)).filter((c, i, all) => all.indexOf(c) === i && !n.subnets.includes(c));
  return (
    <>
      <Card
        title="Prefer Mesh"
        subtitle="Give the traffic between this server and the other computers (Mesh Assist included) its own lane: a network for it (an AI or server VLAN), connections that stay open, and a priority mark switches and FBRX Gate honor."
        actions={<Toggle disabled={!admin} checked={n.preferMesh} onChange={(v) => set({ preferMesh: v })} label={n.preferMesh ? 'On' : 'Off'} />}
      >
        {!admin && <Callout tone="info">Only administrators change these.</Callout>}
        <Grid cols={2}>
          <fieldset className="vt-fieldset" disabled={!admin}>
            <Field label="Mesh networks, in order" help="This server reaches the others through these first; its usual network stays the fallback.">
              <div className="vt-chips">
                {n.subnets.map((c) => (
                  <button key={c} className="vt-chip on mono" title="Remove" onClick={() => set({ subnets: n.subnets.filter((x) => x !== c) })}>
                    {c} ×
                  </button>
                ))}
                {!n.subnets.length && <span className="fx-muted">None yet</span>}
              </div>
            </Field>
            <div className="vt-input-row">
              <Input className="mono" value={subnet} onChange={(e) => setSubnet(e.target.value)} placeholder="10.20.0.0/24" onKeyDown={(e) => e.key === 'Enter' && add(subnet)} />
              <Button size="sm" disabled={!isCidr(subnet.trim())} onClick={() => add(subnet)}>
                Add
              </Button>
            </div>
            {suggestions.length > 0 && (
              <div className="vt-chips">
                <span className="fx-muted" style={{ fontSize: 12 }}>This server is on:</span>
                {suggestions.map((c) => (
                  <button key={c} className="vt-chip mono" onClick={() => add(c)}>
                    + {c}
                  </button>
                ))}
              </div>
            )}
          </fieldset>
          <fieldset className="vt-fieldset" disabled={!admin}>
            <Field label="Priority mark (DSCP)" help="AF41 sits below voice calls, so mesh traffic goes first without drowning out phones.">
              <Select value={n.trafficClass} onChange={(e) => set({ trafficClass: e.target.value as MeshTrafficClass })} options={MESH_TRAFFIC_CLASSES.map((c) => ({ value: c, label: MESH_TRAFFIC_CLASS_WORDS[c] }))} />
            </Field>
            <Toggle disabled={!admin} checked={n.jumbo} onChange={(v) => set({ jumbo: v })} label="The mesh networks use jumbo frames (MTU 9000): check them" />
            <div className="fx-help">Mesh connections are TCP and stay open between requests, with no delay before small packets go out.</div>
          </fieldset>
        </Grid>
      </Card>

      {st && (
        <Card title="This server">
          {st.warnings.map((w) => (
            <Callout key={w} tone="warning">
              {w}
            </Callout>
          ))}
          {st.local.map((a) => (
            <div key={`${a.iface}${a.address}`} className="fx-list-item">
              <Status tone={a.preferred ? 'good' : 'neutral'}>{a.preferred ? 'mesh network' : 'other network'}</Status>
              <strong className="mono">{a.address}</strong>
              <span className="fx-muted" style={{ flex: 1 }}>
                {a.iface} · {a.cidr}
                {a.mtu ? ` · MTU ${a.mtu}` : ''}
              </span>
            </div>
          ))}
          <div className="fx-list-item">
            <Status tone={st.qos.applied ? 'good' : st.qos.applied === false ? 'warning' : 'neutral'}>{st.qos.applied ? 'marked' : st.qos.applied === false ? 'not marked' : 'unknown'}</Status>
            <span style={{ flex: 1 }}>
              Mesh traffic (TCP port {st.port}) marked {st.trafficClass.toUpperCase()} (DSCP {st.dscp}). <span className="fx-muted">{st.qos.detail}</span>
            </span>
            {admin && (
              <>
                <Button size="sm" variant="primary" loading={busy === 'mark'} onClick={() => void run('mark', () => api('POST', '/v1/core/network/mark', {}), 'Mesh traffic is marked').then(() => status.reload())}>
                  {st.qos.applied ? 'Mark again' : 'Mark mesh traffic'}
                </Button>
                {st.qos.applied && (
                  <Button size="sm" loading={busy === 'unmark'} onClick={() => void run('unmark', () => api('POST', '/v1/core/network/mark', { remove: true }), 'Marking removed').then(() => status.reload())}>
                    Stop marking
                  </Button>
                )}
              </>
            )}
          </div>
        </Card>
      )}

      <Card
        title="The way to each computer"
        actions={
          app.can('operator') && (
            <Button size="sm" icon="activity" loading={busy === 'test'} onClick={() => void run('test', () => coreCall<MeshPathTest[]>('mesh.network.test', {})).then((r) => r && setPaths(r))}>
              Test
            </Button>
          )
        }
      >
        {!paths && <div className="fx-muted">Which address each paired computer is reached on, the round trip of a mesh request, and (jumbo frames on) whether 9000-byte packets get through.</div>}
        {paths && paths.length === 0 && <div className="fx-muted">No paired computers to test.</div>}
        {paths?.map((p) => (
          <div key={p.peerId} className="fx-list-item">
            <Status tone={p.error ? 'critical' : p.preferred ? 'good' : 'warning'}>{p.error ? 'unreachable' : p.preferred ? 'mesh network' : 'usual network'}</Status>
            <strong>{p.peerName}</strong>
            <span className="fx-muted" style={{ flex: 1 }}>
              {p.address ?? '—'}
              {p.rttMs !== null ? ` · ${p.rttMs} ms round trip` : ''}
              {p.jumbo.tested ? ` · ${p.jumbo.detail}` : ''}
              {p.error ? ` · ${p.error}` : ''}
            </span>
          </div>
        ))}
      </Card>
    </>
  );
}
