import { useState } from 'react';
import { AUTOMATION_INTERVAL, AUTOMATION_TEMPLATES, WEEKDAYS, describeAutomationSchedule, type Automation, type AutomationInput, type AutomationNotify, type AutomationRun, type AutomationSchedule } from '@fbrx/shared';
import { Button, Callout, Card, Empty, Field, Icons, Input, Modal, Page, Select, Status, TextArea, Toggle, formatDate, timeAgo, useAction, useConfirm, type IconName } from '@fbrx/ui';
import { call } from '../client';
import { useAgentName, useCore } from '../hooks';
import { navigate } from '../app';
import { KeyRecorder } from './settings-macros';

const NOTIFY_NAMES: Record<AutomationNotify, string> = { always: 'Every time', changes: 'Only when something changed', never: 'Never (it stays in its chat)' };
const INTERVALS = [15, 30, 60, 120, 180, 360, 720, 1440, 10080];
const BLANK: AutomationInput = { name: '', prompt: '', schedule: { kind: 'interval', minutes: 60 }, notify: 'changes', online: true, hotkey: '', enabled: true };

const runTone = (r: AutomationRun) => (r.status === 'failed' ? 'critical' : r.status === 'running' ? 'busy' : r.changed ? 'good' : 'neutral');

/** When it runs: a kind, then what that kind needs (how often; a time and the days). */
function ScheduleField({ value, onChange }: { value: AutomationSchedule; onChange: (s: AutomationSchedule) => void }) {
  const kinds: Array<{ id: AutomationSchedule['kind']; label: string; make: () => AutomationSchedule }> = [
    { id: 'interval', label: 'Every…', make: () => ({ kind: 'interval', minutes: 60 }) },
    { id: 'daily', label: 'At a time', make: () => ({ kind: 'daily', time: '08:00', days: [1, 2, 3, 4, 5] }) },
    { id: 'start', label: 'When FBRX starts', make: () => ({ kind: 'start' }) },
    { id: 'manual', label: 'Only when I run it', make: () => ({ kind: 'manual' }) },
  ];
  return (
    <div className="fx-form">
      <div className="seg" role="group" aria-label="When it runs">
        {kinds.map((k) => (
          <button key={k.id} className={value.kind === k.id ? 'on' : ''} onClick={() => value.kind !== k.id && onChange(k.make())}>
            {k.label}
          </button>
        ))}
      </div>
      {value.kind === 'interval' && (
        <Select
          aria-label="How often"
          value={String(value.minutes)}
          options={INTERVALS.filter((m) => m >= AUTOMATION_INTERVAL.min).map((m) => ({ value: String(m), label: describeAutomationSchedule({ kind: 'interval', minutes: m }) }))}
          onChange={(e) => onChange({ kind: 'interval', minutes: Number(e.target.value) })}
        />
      )}
      {value.kind === 'daily' && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <Input type="time" aria-label="Time" value={value.time} style={{ width: 130 }} onChange={(e) => e.target.value && onChange({ ...value, time: e.target.value })} />
          <div className="seg" role="group" aria-label="Days">
            {WEEKDAYS.map((d, n) => (
              <button key={d} className={value.days.includes(n) ? 'on' : ''} title={d} onClick={() => onChange({ ...value, days: value.days.includes(n) ? value.days.filter((x) => x !== n) : [...value.days, n].sort() })}>
                {d.slice(0, 2)}
              </button>
            ))}
          </div>
          <span className="fx-muted" style={{ fontSize: 12.5 }}>
            {describeAutomationSchedule(value)}
          </span>
        </div>
      )}
    </div>
  );
}

function AutomationEditor({ initial, onClose }: { initial: AutomationInput & { id?: string }; onClose: () => void }) {
  const agentName = useAgentName();
  const [a, setA] = useState(initial);
  const { run, busy } = useAction();
  const save = () =>
    run(
      'save',
      async () => {
        const { id, ...input } = a;
        await (id ? call('automations.update', { id, ...input }) : call('automations.create', input));
        onClose();
      },
      a.id ? 'Automation saved' : 'Automation made',
    );
  const unfilled = /\[[^\]]+\]/.test(a.prompt);
  return (
    <Modal
      wide
      title={a.id ? `Edit ${initial.name}` : 'New automation'}
      description={`${agentName} does this by itself, with the tools it may use without asking, and tells you what it found.`}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy === 'save'} disabled={!a.name.trim() || !a.prompt.trim()} onClick={() => void save()}>
            {a.id ? 'Save' : 'Make it'}
          </Button>
        </>
      }
    >
      <div className="fx-form">
        <Field label="Name">
          <Input value={a.name} maxLength={80} placeholder="New listings" onChange={(e) => setA({ ...a, name: e.target.value })} />
        </Field>
        <Field label={`What ${agentName} does`} help={unfilled ? 'Fill in the parts in [brackets].' : 'Say it as you would in the chat: where to look, what to find, and how to report it.'}>
          <TextArea rows={5} value={a.prompt} maxLength={8000} onChange={(e) => setA({ ...a, prompt: e.target.value })} />
        </Field>
        <Field label="When">
          <ScheduleField value={a.schedule} onChange={(schedule) => setA({ ...a, schedule })} />
        </Field>
        <Field label="Tell me">
          <Select value={a.notify} options={(Object.keys(NOTIFY_NAMES) as AutomationNotify[]).map((n) => ({ value: n, label: NOTIFY_NAMES[n] }))} onChange={(e) => setA({ ...a, notify: e.target.value as AutomationNotify })} />
        </Field>
        <Toggle checked={a.online} onChange={(online) => setA({ ...a, online })} label="May use the internet (web pages, search, quotes)" />
        <Field label="Shortcut" help="Runs it at once from any app. Optional.">
          <KeyRecorder value={a.hotkey} allowOff onChange={(hotkey) => setA({ ...a, hotkey })} />
        </Field>
        <Toggle checked={a.enabled} onChange={(enabled) => setA({ ...a, enabled })} label="On" />
      </div>
    </Modal>
  );
}

function RunHistory({ id }: { id: string }) {
  const runs = useCore('automations.runs', { id, limit: 10 }, ['automations.changed']).data ?? [];
  if (!runs.length) return <p className="fx-muted" style={{ margin: 0 }}>It has not run yet.</p>;
  return (
    <div className="auto-runs">
      {runs.map((r) => (
        <div key={r.id} className="auto-run">
          <Status tone={runTone(r)}>{r.status === 'failed' ? 'Failed' : r.status === 'running' ? 'Running' : r.changed ? 'Found something' : 'Nothing new'}</Status>
          <span className="fx-muted" title={formatDate(r.startedAt)}>
            {timeAgo(r.startedAt)}
          </span>
          <span className="auto-run-summary">{r.summary}</span>
        </div>
      ))}
    </div>
  );
}

function AutomationCard({ a, onEdit }: { a: Automation; onEdit: () => void }) {
  const [history, setHistory] = useState(false);
  const { run, busy } = useAction();
  const { confirm, dialog } = useConfirm();
  return (
    <Card
      className={`auto-card${a.enabled ? '' : ' off'}`}
      title={
        <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
          <Icons.repeat size={15} style={{ color: 'var(--accent)' }} /> {a.name}
        </span>
      }
      subtitle={`${describeAutomationSchedule(a.schedule)} · tells you ${NOTIFY_NAMES[a.notify].toLowerCase()}${a.online ? '' : ' · offline'}${a.hotkey ? ` · ${a.hotkey.replace('CommandOrControl', 'Ctrl')}` : ''}`}
      actions={<Toggle checked={a.enabled} onChange={(enabled) => void run('on', () => call('automations.update', { id: a.id, enabled }))} label={a.enabled ? 'On' : 'Off'} />}
    >
      <p className="auto-prompt">{a.prompt}</p>
      {a.lastRun && (
        <div className="auto-last">
          <Status tone={runTone(a.lastRun)}>{a.running ? 'Running now' : a.lastRun.status === 'failed' ? 'Last run failed' : a.lastRun.changed ? 'Found something' : 'Nothing new'}</Status>
          <span className="fx-muted">{timeAgo(a.lastRun.startedAt)}</span>
          {!a.running && <span className="auto-run-summary">{a.lastRun.summary}</span>}
        </div>
      )}
      {a.enabled && a.nextRunAt && !a.running && <p className="fx-muted" style={{ margin: '6px 0 0', fontSize: 12.5 }}>Next run {formatDate(a.nextRunAt)}</p>}
      <div className="fx-actions" style={{ marginTop: 10 }}>
        <Button size="sm" icon="play" loading={busy === 'run' || a.running} disabled={a.running} onClick={() => void run('run', () => call('automations.run', { id: a.id }), `${a.name} is running`)}>
          {a.running ? 'Running' : 'Run now'}
        </Button>
        {a.conversationId && (
          <Button size="sm" variant="ghost" icon="message" onClick={() => navigate(`agent/chat/${encodeURIComponent(a.conversationId!)}`)}>
            Its chat
          </Button>
        )}
        <Button size="sm" variant="ghost" icon="history" aria-expanded={history} onClick={() => setHistory(!history)}>
          History
        </Button>
        <Button size="sm" variant="ghost" icon="edit" onClick={onEdit}>
          Edit
        </Button>
        <Button
          size="sm"
          variant="ghost"
          icon="trash"
          aria-label={`Delete ${a.name}`}
          onClick={async () => {
            if (await confirm({ title: `Delete ${a.name}?`, body: 'Its chat stays in Conversations.', danger: true, confirmLabel: 'Delete' })) void run('rm', () => call('automations.remove', { id: a.id }), 'Automation deleted');
          }}
        />
      </div>
      {history && (
        <div style={{ marginTop: 10 }}>
          <RunHistory id={a.id} />
        </div>
      )}
      {dialog}
    </Card>
  );
}

/** Automations: jobs the agent does by itself, and the ready-made ones to start from. */
export function AutomationsPage() {
  const agentName = useAgentName();
  const list = useCore('automations.list', undefined, ['automations.changed']);
  const [editing, setEditing] = useState<(AutomationInput & { id?: string }) | null>(null);
  const automations = list.data ?? [];
  return (
    <Page
      title="Automations"
      description={`Jobs ${agentName} does by itself: on a schedule, when FBRX starts, or with a shortcut. It tells you what it found, every time or only when something changed, and keeps each one's results in its own chat.`}
      actions={
        <Button variant="primary" icon="plus" onClick={() => setEditing(BLANK)}>
          New automation
        </Button>
      }
    >
      {list.error && <Callout tone="warning">{list.error}</Callout>}
      {automations.length > 0 && (
        <div className="auto-grid">
          {automations.map((a) => (
            <AutomationCard key={a.id} a={a} onEdit={() => setEditing(a)} />
          ))}
        </div>
      )}
      <Card title={automations.length ? 'Start from an idea' : undefined} subtitle={automations.length ? undefined : undefined}>
        {!automations.length && <Empty title="No automations yet">Pick an idea to start from, or make your own. Nobody needs to be at the computer while they run.</Empty>}
        <div className="choice-grid">
          {AUTOMATION_TEMPLATES.map((t) => {
            const Ico = Icons[t.icon as IconName] ?? Icons.repeat;
            return (
              <button key={t.id} className="choice" onClick={() => setEditing({ ...t.input, hotkey: '', enabled: true })}>
                <span style={{ display: 'flex', gap: 8, alignItems: 'center', fontWeight: 600 }}>
                  <Ico size={16} style={{ color: 'var(--accent)' }} />
                  {t.title}
                </span>
                <span className="fx-muted" style={{ fontSize: 12.5 }}>
                  {t.description} {describeAutomationSchedule(t.input.schedule)}.
                </span>
              </button>
            );
          })}
        </div>
      </Card>
      {editing && <AutomationEditor initial={editing} onClose={() => setEditing(null)} />}
    </Page>
  );
}
