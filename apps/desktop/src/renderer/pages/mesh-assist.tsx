import { useEffect, useState } from 'react';
import { ASSIST_PRIORITIES, ASSIST_TERMINAL, type AssistMode, type AssistOffer, type AssistPriority, type AssistSession, type AssistTools, type MeshDevice, type Settings } from '@fbrx/shared';
import { Button, Callout, Card, Field, Grid, Input, Select, Status, TextArea, Toggle, timeAgo, useAction, type StatusTone } from '@fbrx/ui';
import { call, onEvent } from '../client';
import { useAgentName, useCore } from '../hooks';

type AssistSettings = Settings['mesh']['assist'];

const MODES = (what: string): Array<{ value: AssistMode; label: string }> => [
  { value: 'off', label: 'Never' },
  { value: 'ask', label: `Ask me first` },
  { value: 'auto', label: `Automatically${what}` },
];
const PRIORITY_WORDS: Record<AssistPriority, string> = { background: 'Background', normal: 'Normal', high: 'High', urgent: 'Urgent (controllers only)' };
const TOOL_WORDS: Record<AssistTools, string> = { none: 'Think and answer only', read: 'Look things up (changes nothing)', all: 'Anything its policy allows' };
const STATUS_TONE: Record<AssistSession['status'], StatusTone> = { 'waiting-approval': 'warning', queued: 'info', running: 'busy', done: 'good', denied: 'neutral', error: 'critical', cancelled: 'neutral' };
const STATUS_WORDS: Record<AssistSession['status'], string> = { 'waiting-approval': 'waiting for a yes', queued: 'queued', running: 'working', done: 'done', denied: 'declined', error: 'failed', cancelled: 'stopped' };
const TRIGGER_WORDS: Record<AssistSession['trigger'], string> = { agent: 'consulted by the agent', steps: 'ran out of steps', provider: 'AI provider stopped answering', person: 'sent by a person', controller: 'sent by a controller' };

/**
 * Mesh Assist on the Mesh & phone page: whether this computer brings other computers' AI in (and when), whether it
 * lends its own, who could help right now, handing work out with a priority, and the help asked and given.
 */
export function MeshAssistCard({ devices, running }: { devices: MeshDevice[]; running: boolean }) {
  const agent = useAgentName();
  const settings = useCore('settings.get', undefined, ['settings.changed']);
  const sessions = useCore('mesh.assist.sessions', undefined, []);
  const [live, setLive] = useState<AssistSession[] | null>(null);
  const [helpers, setHelpers] = useState<AssistOffer[] | null>(null);
  const { run, busy } = useAction();
  useEffect(() => setLive(sessions.data ?? null), [sessions.data]);
  useEffect(
    () =>
      onEvent('mesh.assist', (s) =>
        setLive((cur) => {
          const list = cur ?? [];
          const i = list.findIndex((x) => x.id === s.id);
          return i === -1 ? [s, ...list] : list.map((x) => (x.id === s.id ? s : x));
        }),
      ),
    [],
  );
  const a = settings.data?.settings.mesh.assist;
  const managed = settings.data?.locked.some((k) => k.startsWith('mesh.assist') || k === 'mesh') ?? false;
  if (!a) return null;
  const set = (patch: Partial<AssistSettings>) => void run('set', () => call('settings.update', { patch: { mesh: { assist: patch } } }));
  const computers = devices.filter((d) => d.kind === 'desktop');

  return (
    <Card
      title="Mesh Assist"
      subtitle={`Your computers lend each other their AI: when ${agent} runs out of steps or its AI provider stops answering (credits, limits, an outage), another computer finishes the task. ${agent} can also consult another computer mid-task.`}
      actions={
        running && (
          <Button size="sm" icon="refresh" loading={busy === 'helpers'} onClick={() => void run('helpers', () => call('mesh.assist.helpers')).then((h) => h && setHelpers(h))}>
            Who can help?
          </Button>
        )
      }
    >
      {managed && <Callout tone="info">Your organization sets some of these.</Callout>}
      <Grid cols={2}>
        <div className="fx-grid">
          <div className="fx-label">This computer asking for help</div>
          <Field label={`Bring another computer's AI in`}>
            <Select value={a.request} onChange={(e) => set({ request: e.target.value as AssistMode })} options={MODES('')} />
          </Field>
          <Toggle checked={a.onStepLimit} onChange={(v) => set({ onStepLimit: v })} label={`When ${agent} runs out of steps`} />
          <Toggle checked={a.onProviderError} onChange={(v) => set({ onProviderError: v })} label="When the AI provider stops answering (credits, limits, outage)" />
          <Toggle checked={a.agentMayConsult} onChange={(v) => set({ agentMayConsult: v })} label={`${agent} may consult other computers itself`} />
          <Field label="Priority of this computer's requests">
            <Select value={a.priority} onChange={(e) => set({ priority: e.target.value as AssistPriority })} options={ASSIST_PRIORITIES.map((p) => ({ value: p, label: PRIORITY_WORDS[p] }))} />
          </Field>
        </div>
        <div className="fx-grid">
          <div className="fx-label">This computer helping others</div>
          <Field label={`Lend ${agent} to other computers`}>
            <Select value={a.offer} onChange={(e) => set({ offer: e.target.value as AssistMode })} options={MODES(' (policy still applies)')} />
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
          <Toggle checked={a.allowPreempt} onChange={(v) => set({ allowPreempt: v })} label="Urgent work from a controller may stop lower-priority help" />
        </div>
      </Grid>
      <div className="fx-muted" style={{ fontSize: 12, marginTop: 8 }}>
        Which computers may ask, and which are controllers, is set on each computer below (<em>Help with AI</em>, <em>Controller</em>). A controller running as administrator hands out work without asking. Help always runs under the helping computer’s policy, and help is never passed along twice.
      </div>

      {helpers && (
        <div style={{ marginTop: 14 }}>
          <div className="fx-label">Right now</div>
          {helpers.length === 0 && <div className="fx-muted">No paired computer answered.</div>}
          {helpers.map((h) => (
            <div key={h.deviceId} className="fx-list-item">
              <Status tone={h.accepts === 'off' || !h.ai.ready ? 'neutral' : h.accepts === 'auto' ? 'good' : 'warning'}>{h.accepts === 'off' ? 'cannot help' : h.accepts === 'auto' ? 'helps right away' : 'asks its person'}</Status>
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

      {running && computers.length > 0 && <SendWork computers={computers} defaultPriority={a.priority} />}
      <SessionList sessions={live ?? []} />
    </Card>
  );
}

function SendWork({ computers, defaultPriority }: { computers: MeshDevice[]; defaultPriority: AssistPriority }) {
  const [goal, setGoal] = useState('');
  const [target, setTarget] = useState('any');
  const [priority, setPriority] = useState<AssistPriority>(defaultPriority);
  const [tools, setTools] = useState<AssistTools>('read');
  const { run, busy } = useAction();
  return (
    <div className="fx-grid" style={{ marginTop: 16 }}>
      <div className="fx-label">Hand work to other computers</div>
      <TextArea rows={2} value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="For example: check the backups on your disks and tell me which are older than a week" />
      <Grid cols={3}>
        <Field label="To">
          <Select value={target} onChange={(e) => setTarget(e.target.value)} options={[{ value: 'any', label: 'The best one available' }, { value: 'all', label: 'Every computer' }, ...computers.map((c) => ({ value: c.id, label: c.name }))]} />
        </Field>
        <Field label="Priority">
          <Select value={priority} onChange={(e) => setPriority(e.target.value as AssistPriority)} options={ASSIST_PRIORITIES.map((p) => ({ value: p, label: PRIORITY_WORDS[p] }))} />
        </Field>
        <Field label="They may">
          <Select value={tools} onChange={(e) => setTools(e.target.value as AssistTools)} options={(['none', 'read', 'all'] as AssistTools[]).map((t) => ({ value: t, label: TOOL_WORDS[t] }))} />
        </Field>
      </Grid>
      <div className="fx-actions">
        <Button
          variant="primary"
          icon="send"
          loading={busy === 'send'}
          disabled={!goal.trim()}
          onClick={() =>
            void run('send', () => call('mesh.assist.send', { peerIds: target === 'any' ? 'any' : target === 'all' ? computers.map((c) => c.id) : [target], goal, priority, tools }), 'Sent').then((r) => r && setGoal(''))
          }
        >
          Send
        </Button>
      </div>
    </div>
  );
}

function SessionList({ sessions }: { sessions: AssistSession[] }) {
  const [open, setOpen] = useState<string | null>(null);
  const [follow, setFollow] = useState('');
  const { run, busy } = useAction();
  if (!sessions.length) return <div className="fx-muted" style={{ marginTop: 14 }}>No help asked or given yet.</div>;
  return (
    <div style={{ marginTop: 16 }}>
      <div className="fx-label">Help asked and given</div>
      {sessions.slice(0, 30).map((s) => {
        const active = !ASSIST_TERMINAL.includes(s.status);
        return (
          <div key={s.id} className="assist-row">
            <button className="assist-head" onClick={() => setOpen(open === s.id ? null : s.id)}>
              <span className="mono fx-muted" title={s.direction === 'out' ? 'Asked from here' : 'Given here'}>
                {s.direction === 'out' ? '→' : '←'}
              </span>
              <strong>{s.peerName}</strong>
              <span className="assist-goal">{s.goal}</span>
              <span className="fx-badge">{s.priority}</span>
              <Status tone={STATUS_TONE[s.status]}>{STATUS_WORDS[s.status]}</Status>
              <span className="fx-muted" style={{ fontSize: 12 }}>{timeAgo(s.createdAt)}</span>
            </button>
            {open === s.id && (
              <div className="assist-body">
                <div className="fx-muted" style={{ fontSize: 12 }}>
                  {s.direction === 'out' ? `Asked from here, ${TRIGGER_WORDS[s.trigger]}` : `Given here to ${s.peerName}, ${TRIGGER_WORDS[s.trigger]}`}
                  {s.admin && s.trigger !== 'controller' ? ' · as a controller' : ''} · {s.steps} step{s.steps === 1 ? '' : 's'}
                  {s.tools.length ? ` · used ${[...new Set(s.tools)].join(', ')}` : ''}
                </div>
                {s.answer && <div className="md" style={{ whiteSpace: 'pre-wrap' }}>{s.answer}</div>}
                {s.error && <Callout tone={s.status === 'error' ? 'critical' : 'info'}>{s.error}</Callout>}
                <div className="fx-actions">
                  {active && (
                    <Button size="sm" variant="danger" loading={busy === `c${s.id}`} onClick={() => void run(`c${s.id}`, () => call('mesh.assist.cancel', { sessionId: s.id }))}>
                      Stop
                    </Button>
                  )}
                  {!active && s.direction === 'out' && s.status === 'done' && (
                    <>
                      <div style={{ flex: 1 }}>
                        <Input value={follow} onChange={(e) => setFollow(e.target.value)} placeholder={`Ask ${s.peerName} a follow-up`} />
                      </div>
                      <Button size="sm" icon="send" loading={busy === `f${s.id}`} disabled={!follow.trim()} onClick={() => void run(`f${s.id}`, () => call('mesh.assist.followUp', { sessionId: s.id, text: follow })).then((r) => r && setFollow(''))}>
                        Ask
                      </Button>
                    </>
                  )}
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
