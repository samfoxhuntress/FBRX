import { useEffect, useMemo, useState } from 'react';
import { describeSchedule, WEEKDAYS, type BootCheckState, type TimeImage, type TimeJob, type TimeStatus, type TimeTask, type VmSummary } from '@fbrx/shared';
import { Button, Callout, Card, CopyText, Empty, Field, formatBytes, formatDate, Grid, Input, KeyValue, Modal, Page, Select, StatTile, Status, Table, Tabs, timeAgo, Toggle, useAction, useConfirm, useToast, type StatusTone } from '@fbrx/ui';
import { api } from '../api';
import { useApp, usePoll, useRoute } from '../state';

type Tab = 'overview' | 'jobs' | 'images' | 'computers' | 'settings';

const CHECK_TONE: Record<BootCheckState, StatusTone> = { none: 'neutral', queued: 'busy', running: 'busy', passed: 'good', warning: 'warning', failed: 'critical' };
const CHECK_WORDS: Record<BootCheckState, string> = { none: 'Not checked', queued: 'Check waiting', running: 'Checking…', passed: 'Starts', warning: 'Look at it', failed: 'Did not start' };
const KIND_WORDS: Record<TimeTask['kind'], string> = { backup: 'Backup', check: 'Boot check', restore: 'Restore', import: 'Kept from the backup folder' };
const CONSISTENCY: Record<TimeImage['consistency'], string> = {
  offline: 'The machine was off',
  quiesced: 'Consistent (the guest agent paused writes)',
  crash: 'Copied while it ran',
  computer: 'Made by the computer',
};

/**
 * FBRX Time on the server: backups of the virtual machines on a schedule, the images computers send to the backup
 * folder, and boot checks (each image opened as a throwaway machine with no network, confirmed to start, then deleted).
 */
export function TimePage({ tab }: { tab?: string }) {
  const app = useApp();
  const [, go] = useRoute();
  const st = usePoll<TimeStatus | { enabled: false }>('/v1/time', 3000);
  const active: Tab = (['overview', 'jobs', 'images', 'computers', 'settings'] as Tab[]).includes(tab as Tab) ? (tab as Tab) : 'overview';
  if (st.data && !st.data.enabled)
    return (
      <Page title="FBRX Time">
        <Card title="FBRX Time is not on this server">
          <p className="fx-secondary">
            FBRX Time backs up the virtual machines on this server on a schedule, keeps the image backups your computers send it, and checks every image the only way that proves it: it starts the image as a throwaway machine with no network, confirms it comes up, then shuts it down and deletes it.
          </p>
          <div className="fx-actions">
            <Button variant="primary" icon="layers" onClick={() => go('roles')}>
              Add it in Roles
            </Button>
          </div>
        </Card>
      </Page>
    );
  const s = st.data as TimeStatus | null;
  return (
    <Page title="FBRX Time" description="Image backups of the virtual machines and computers, each checked by starting it as a throwaway machine with no network.">
      {!s ? (
        st.error ? <Callout tone="critical" title="FBRX Time does not answer">{st.error}</Callout> : <Empty title="Loading…" />
      ) : (
        <>
          {!s.canBoot && <Callout tone="warning" title="Boot checks cannot run">The hypervisor does not answer, so images cannot be opened to check them (sudo fbrx-server doctor).</Callout>}
          <Tabs<Tab>
            active={active}
            onChange={(t) => go('time', t)}
            tabs={[
              { id: 'overview', label: 'Overview' },
              { id: 'jobs', label: 'Backup jobs' },
              { id: 'images', label: 'Images' },
              { id: 'computers', label: 'Computers' },
              ...(app.can('admin') ? [{ id: 'settings' as Tab, label: 'Settings' }] : []),
            ]}
          />
          {active === 'overview' && <Overview s={s} reload={st.reload} />}
          {active === 'jobs' && <Jobs />}
          {active === 'images' && <Images />}
          {active === 'computers' && <Computers s={s} reload={st.reload} />}
          {active === 'settings' && app.can('admin') && <Settings s={s} reload={st.reload} />}
        </>
      )}
    </Page>
  );
}

function TaskRow({ t }: { t: TimeTask }) {
  const tone: StatusTone = t.state === 'failed' ? 'critical' : t.state === 'done' ? 'good' : 'busy';
  return (
    <div className="time-task">
      <div className="time-task-head">
        <Status tone={tone}>{KIND_WORDS[t.kind]}</Status>
        <b>{t.subject}</b>
        <span className="fx-muted">{t.state === 'queued' ? 'waiting its turn' : t.state === 'running' ? `started ${timeAgo(t.startedAt)}` : timeAgo(t.finishedAt)}</span>
      </div>
      {t.state === 'running' && (
        <div className="time-bar" aria-label={`${t.progress ?? 0}%`}>
          <span style={{ width: `${Math.max(3, t.progress ?? 0)}%` }} />
        </div>
      )}
      {t.detail && <div className={`time-task-detail${t.state === 'failed' ? ' bad' : ''}`}>{t.detail}</div>}
    </div>
  );
}

function Overview({ s, reload }: { s: TimeStatus; reload: () => Promise<void> }) {
  const app = useApp();
  const images = usePoll<{ images: TimeImage[] }>('/v1/time/images', 10000);
  const jobs = usePoll<{ jobs: TimeJob[] }>('/v1/time/jobs', 15000);
  const { run, busy } = useAction();
  const list = images.data?.images ?? [];
  const checked = list.filter((i) => i.check.state === 'passed').length;
  const bad = list.filter((i) => i.check.state === 'failed' || i.check.state === 'warning').length;
  const next = (jobs.data?.jobs ?? []).filter((j) => j.nextRunAt).sort((a, b) => a.nextRunAt!.localeCompare(b.nextRunAt!))[0];
  const live = s.tasks.filter((t) => t.state === 'running' || t.state === 'queued');
  const done = s.tasks.filter((t) => t.state === 'done' || t.state === 'failed').slice(0, 8);
  const checking = live.find((t) => t.state === 'running' && t.kind === 'check');
  return (
    <>
      <Grid cols={4}>
        <StatTile label="Images" value={list.length} foot={list[0] ? `newest ${timeAgo(list[0].createdAt)}` : 'none yet'} />
        <StatTile label="Start when checked" value={`${checked} of ${list.length}`} foot={bad ? `${bad} to look at` : 'every checked one started'} />
        <StatTile label="Next backup" value={next ? new Date(next.nextRunAt!).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' }) : '—'} foot={next ? next.vmName : 'no job scheduled'} />
        <StatTile label="Space" value={formatBytes(s.usedBytes)} foot={s.freeBytes !== null ? `${formatBytes(s.freeBytes)} free in ${s.repository}` : s.repository} />
      </Grid>
      <Card
        title="What FBRX Time is doing"
        subtitle="One thing at a time: copies and checks are heavy. The rest wait their turn."
        actions={
          checking && app.can('operator') ? (
            <Button size="sm" icon="stop" loading={busy === 'stop'} onClick={() => void run('stop', () => api('POST', '/v1/time/cancel').then(reload), 'Check stopped')}>
              Stop the check
            </Button>
          ) : undefined
        }
      >
        {live.length || done.length ? (
          <div className="time-tasks">
            {[...live, ...done].map((t) => (
              <TaskRow key={t.id} t={t} />
            ))}
          </div>
        ) : (
          <Empty title="Nothing yet">Back up a machine (Backup jobs), or connect a computer (Computers).</Empty>
        )}
      </Card>
    </>
  );
}

function JobDialog({ job, vms, onClose, onSaved }: { job: TimeJob | null; vms: VmSummary[]; onClose: () => void; onSaved: () => void }) {
  const [vmId, setVmId] = useState(job?.vmId ?? vms[0]?.id ?? '');
  const [name, setName] = useState(job?.name ?? '');
  const [schedule, setSchedule] = useState<TimeJob['schedule']>(job?.schedule ?? 'daily');
  const [time, setTime] = useState(job?.time ?? '22:00');
  const [day, setDay] = useState(job?.day ?? 6);
  const [verify, setVerify] = useState(job?.verify ?? true);
  const [keep, setKeep] = useState(job?.keep ?? 7);
  const { run, busy } = useAction();
  const save = () =>
    void run(
      'save',
      async () => {
        const body = { name: name || undefined, schedule, time, day, verify, keep };
        if (job) await api('PUT', `/v1/time/jobs/${job.id}`, body);
        else await api('POST', '/v1/time/jobs', { ...body, vmId });
        onSaved();
        onClose();
      },
      job ? 'Job saved' : 'Backup job made',
    );
  return (
    <Modal
      title={job ? `Change ${job.name}` : 'New backup job'}
      description="A virtual machine, backed up on a schedule. A machine that runs is copied from a moment-in-time snapshot and keeps running."
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy === 'save'} disabled={!vmId} onClick={save}>
            {job ? 'Save' : 'Make the job'}
          </Button>
        </>
      }
    >
      <div className="fx-form">
        {!job && (
          <Field label="Virtual machine">
            <Select value={vmId} onChange={(e) => setVmId(e.target.value)} options={vms.map((v) => ({ value: v.id, label: `${v.name} (${v.state === 'running' ? 'running' : 'off'})` }))} />
          </Field>
        )}
        <Field label="Name" help="Optional.">
          <Input value={name} maxLength={80} placeholder={job ? job.name : `Back up ${vms.find((v) => v.id === vmId)?.name ?? 'the machine'}`} onChange={(e) => setName(e.target.value)} />
        </Field>
        <div className="time-when">
          <Field label="When">
            <Select
              value={schedule}
              onChange={(e) => setSchedule(e.target.value as TimeJob['schedule'])}
              options={[
                { value: 'daily', label: 'Every day' },
                { value: 'weekly', label: 'Every week' },
                { value: 'off', label: 'Only when I start it' },
              ]}
            />
          </Field>
          {schedule !== 'off' && (
            <Field label="At">
              <Input type="time" value={time} onChange={(e) => setTime(e.target.value)} />
            </Field>
          )}
          {schedule === 'weekly' && (
            <Field label="On">
              <Select value={String(day)} onChange={(e) => setDay(Number(e.target.value))} options={WEEKDAYS.map((d, i) => ({ value: String(i), label: d }))} />
            </Field>
          )}
        </div>
        <Toggle checked={verify} onChange={setVerify} label="Check each new image by starting it (a throwaway machine with no network, deleted afterwards)" />
        <Field label="Images to keep" help="After a new one is made, older ones beyond this many are deleted.">
          <Input type="number" min={1} max={365} value={keep} onChange={(e) => setKeep(Math.max(1, Math.min(365, Number(e.target.value) || 1)))} style={{ width: 120 }} />
        </Field>
      </div>
    </Modal>
  );
}

function Jobs() {
  const app = useApp();
  const jobs = usePoll<{ jobs: TimeJob[] }>('/v1/time/jobs', 5000);
  const vms = usePoll<{ vms: VmSummary[] }>('/v1/vms', 30000);
  const [editing, setEditing] = useState<TimeJob | 'new' | null>(null);
  const [once, setOnce] = useState('');
  const { run, busy } = useAction();
  const { confirm, dialog } = useConfirm();
  const list = jobs.data?.jobs ?? [];
  const machines = vms.data?.vms ?? [];
  return (
    <>
      <Card
        title="Backup jobs"
        subtitle="Each job backs up one virtual machine on its schedule. A machine that was off at the time is backed up when FBRX Time next can."
        actions={
          app.can('admin') ? (
            <Button size="sm" variant="primary" icon="plus" disabled={!machines.length} onClick={() => setEditing('new')}>
              New job
            </Button>
          ) : undefined
        }
        flush
      >
        <Table<TimeJob>
          rows={list}
          rowKey={(j) => j.id}
          columns={[
            { key: 'n', header: 'Job', render: (j) => <span className="time-job-name"><b>{j.name}</b><small className="fx-muted">{j.vmName}</small></span> },
            { key: 's', header: 'When', render: (j) => (j.enabled ? describeSchedule(j.schedule, j.time, j.day) : 'paused') },
            { key: 'c', header: 'Check', render: (j) => (j.verify ? 'Starts each image' : '—') },
            { key: 'k', header: 'Keeps', render: (j) => j.keep },
            { key: 'l', header: 'Last run', render: (j) => (j.lastRunAt ? <span title={formatDate(j.lastRunAt)}>{j.lastOk === false ? <Status tone="critical">failed</Status> : j.lastOk ? <Status tone="good">done</Status> : null} {timeAgo(j.lastRunAt)}</span> : 'not yet') },
            { key: 'x', header: 'Next', render: (j) => (j.nextRunAt ? new Date(j.nextRunAt).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—') },
            {
              key: 'a',
              header: '',
              width: 240,
              render: (j) => (
                <div className="fx-actions" style={{ justifyContent: 'flex-end', flexWrap: 'nowrap' }}>
                  {app.can('operator') && (
                    <Button size="sm" icon="play" loading={busy === `run:${j.id}`} onClick={() => void run(`run:${j.id}`, () => api('POST', `/v1/time/jobs/${j.id}/run`).then(() => jobs.reload()), 'Backup started')}>
                      Back up now
                    </Button>
                  )}
                  {app.can('admin') && (
                    <>
                      <Button size="sm" variant="ghost" icon="edit" aria-label={`Change ${j.name}`} onClick={() => setEditing(j)} />
                      <Button size="sm" variant="ghost" icon={j.enabled ? 'stop' : 'play'} aria-label={j.enabled ? 'Pause' : 'Resume'} title={j.enabled ? 'Pause the schedule' : 'Resume the schedule'} onClick={() => void run(`p:${j.id}`, () => api('PUT', `/v1/time/jobs/${j.id}`, { enabled: !j.enabled }).then(() => jobs.reload()))} />
                      <Button
                        size="sm"
                        variant="ghost"
                        icon="trash"
                        aria-label={`Delete ${j.name}`}
                        onClick={async () => {
                          if (await confirm({ title: `Delete ${j.name}?`, body: 'Its images stay (delete them under Images).', confirmLabel: 'Delete the job', danger: true })) void run(`d:${j.id}`, () => api('DELETE', `/v1/time/jobs/${j.id}`).then(() => jobs.reload()), 'Job deleted');
                        }}
                      />
                    </>
                  )}
                </div>
              ),
            },
          ]}
          empty={<Empty title="No backup jobs yet">{machines.length ? 'Make one for each machine worth keeping.' : 'There are no virtual machines on this server yet.'}</Empty>}
        />
      </Card>
      {app.can('operator') && machines.length > 0 && (
        <Card title="Back up a machine once" subtitle="Without a job: one image now, kept until you delete it.">
          <div className="fx-actions">
            <div style={{ width: 260 }}>
              <Select value={once} onChange={(e) => setOnce(e.target.value)} aria-label="Machine to back up" options={[{ value: '', label: 'Pick a machine…' }, ...machines.map((v) => ({ value: v.id, label: v.name }))]} />
            </div>
            <Button icon="download" disabled={!once} loading={busy === 'once'} onClick={() => void run('once', () => api('POST', '/v1/time/backup', { vmId: once }), 'Backup started')}>
              Back up now
            </Button>
          </div>
        </Card>
      )}
      {editing && <JobDialog job={editing === 'new' ? null : editing} vms={machines} onClose={() => setEditing(null)} onSaved={() => void jobs.reload()} />}
      {dialog}
    </>
  );
}

function ScreenDialog({ image, onClose }: { image: TimeImage; onClose: () => void }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    void api<{ dataUrl: string | null }>('GET', `/v1/time/images/${image.id}/screenshot`).then((r) => setSrc(r.dataUrl));
  }, [image.id]);
  return (
    <Modal title={`${image.subject}: its screen at the boot check`} description={image.check.detail} onClose={onClose} wide footer={<Button onClick={onClose}>Close</Button>}>
      {src ? <img className="time-shot" src={src} alt={`The screen of ${image.subject} during its boot check`} /> : <Empty title={image.check.screenshot ? 'Loading…' : 'No picture from this check'} />}
    </Modal>
  );
}

function RestoreDialog({ image, onClose }: { image: TimeImage; onClose: () => void }) {
  const [name, setName] = useState(`${image.subject}-restored`.slice(0, 63));
  const { run, busy } = useAction();
  const vm = image.source === 'vm';
  return (
    <Modal
      title={`Restore ${image.subject}`}
      description={vm ? `A new virtual machine from the image of ${formatDate(image.createdAt)}: its disks copied, the same size of machine, stopped, on the default network. The original stays as it is.` : `The image of ${formatDate(image.createdAt)} goes back in the backup folder under Restore. On ${image.subject}, start from a Windows recovery drive, choose System Image Recovery, and point it at that network folder.`}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy === 'r'} onClick={() => void run('r', () => api('POST', `/v1/time/images/${image.id}/restore`, { name }).then(onClose), vm ? 'Restoring as a new machine' : 'Putting it in the backup folder')}>
            {vm ? 'Make the machine' : 'Put it back'}
          </Button>
        </>
      }
    >
      {vm && (
        <Field label="The new machine's name">
          <Input value={name} maxLength={63} onChange={(e) => setName(e.target.value)} />
        </Field>
      )}
    </Modal>
  );
}

function Images() {
  const app = useApp();
  const [subject, setSubject] = useState('');
  const images = usePoll<{ images: TimeImage[] }>('/v1/time/images', 4000);
  const [look, setLook] = useState<TimeImage | null>(null);
  const [restore, setRestore] = useState<TimeImage | null>(null);
  const { run, busy } = useAction();
  const { confirm, dialog } = useConfirm();
  const all = images.data?.images ?? [];
  const subjects = useMemo(() => [...new Set(all.map((i) => i.subject))].sort(), [all]);
  const list = subject ? all.filter((i) => i.subject === subject) : all;
  return (
    <Card
      title="Images"
      subtitle="Newest first. Boot check: the image started as a throwaway machine with no network, looked at, then deleted (the image itself is only read)."
      actions={
        <div style={{ width: 220 }}>
          <Select value={subject} onChange={(e) => setSubject(e.target.value)} aria-label="Machine" options={[{ value: '', label: 'Every machine' }, ...subjects]} />
        </div>
      }
      flush
    >
      <Table<TimeImage>
        rows={list}
        rowKey={(i) => i.id}
        columns={[
          { key: 's', header: 'Machine', render: (i) => <span className="time-job-name"><b>{i.subject}</b><small className="fx-muted">{i.source === 'vm' ? 'virtual machine' : 'computer'} · {i.os === 'windows' ? 'Windows' : i.os === 'linux' ? 'Linux' : 'other'}</small></span> },
          { key: 'w', header: 'Made', render: (i) => <span title={formatDate(i.createdAt)}>{timeAgo(i.createdAt)}</span> },
          { key: 'b', header: 'Size', render: (i) => <span title={CONSISTENCY[i.consistency]}>{formatBytes(i.bytes)}</span> },
          {
            key: 'c',
            header: 'Boot check',
            render: (i) => (
              <span className="time-check" title={i.check.detail}>
                <Status tone={CHECK_TONE[i.check.state]}>{CHECK_WORDS[i.check.state]}</Status>
                {i.check.at && <small className="fx-muted">{timeAgo(i.check.at)}</small>}
              </span>
            ),
          },
          {
            key: 'a',
            header: '',
            width: 300,
            render: (i) => (
              <div className="fx-actions" style={{ justifyContent: 'flex-end', flexWrap: 'nowrap' }}>
                {i.check.screenshot && (
                  <Button size="sm" variant="ghost" icon="eye" onClick={() => setLook(i)}>
                    Screen
                  </Button>
                )}
                {app.can('operator') && (
                  <Button size="sm" icon="play" disabled={i.check.state === 'queued' || i.check.state === 'running'} loading={busy === `c:${i.id}`} onClick={() => void run(`c:${i.id}`, () => api('POST', `/v1/time/images/${i.id}/check`).then(() => images.reload()), 'Boot check started')}>
                    Check
                  </Button>
                )}
                {app.can('admin') && (
                  <>
                    <Button size="sm" variant="ghost" icon="history" onClick={() => setRestore(i)}>
                      Restore
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      icon="trash"
                      aria-label="Delete the image"
                      onClick={async () => {
                        if (await confirm({ title: `Delete this image of ${i.subject}?`, body: `Made ${formatDate(i.createdAt)}, ${formatBytes(i.bytes)}. It cannot be brought back.`, confirmLabel: 'Delete it', danger: true })) void run(`d:${i.id}`, () => api('DELETE', `/v1/time/images/${i.id}`).then(() => images.reload()), 'Image deleted');
                      }}
                    />
                  </>
                )}
              </div>
            ),
          },
        ]}
        empty={<Empty title="No images yet">Back up a machine, or connect a computer to the backup folder.</Empty>}
      />
      {look && <ScreenDialog image={look} onClose={() => setLook(null)} />}
      {restore && <RestoreDialog image={restore} onClose={() => setRestore(null)} />}
      {dialog}
    </Card>
  );
}

function Computers({ s, reload }: { s: TimeStatus; reload: () => Promise<void> }) {
  const app = useApp();
  const { run, busy } = useAction();
  const toast = useToast();
  return (
    <>
      <Card title="The backup folder for computers" subtitle="Computers save their whole-computer image here (FBRX Endpoint: Backup → Whole computer, or Windows' own system image). FBRX Time keeps a copy of each one that finishes, and checks it by starting it.">
        {s.share ? (
          <div className="fx-form">
            <KeyValue
              items={[
                ['Folder', <code key="p">{s.share.path}</code>],
                ['Account', <code key="u">{s.share.user}</code>],
              ]}
            />
            {s.share.password ? (
              <>
                <Field label="Password">
                  <CopyText value={s.share.password} secret />
                </Field>
                <Field label="Connection code" help="Paste it into FBRX Endpoint (Backup → Whole computer → An FBRX Server): the folder, account and password in one line.">
                  <CopyText value={s.share.code!} secret />
                </Field>
              </>
            ) : (
              <p className="fx-muted">An administrator sees the password and the connection code.</p>
            )}
            <Callout tone="info">If a computer’s edition of Windows will not save an image to a network folder (some Home editions), it can save to a drive instead. On a gate, let your network reach the folder: a firewall rule for TCP 445 to the gate.</Callout>
          </div>
        ) : (
          <Callout tone="warning" title="The backup folder is not set up">Run the installer again with the time role (Roles), or sudo fbrx-server doctor to see what is missing.</Callout>
        )}
      </Card>
      <Card
        title="Computers"
        subtitle="Each computer that has sent an image. A backup counts as finished when nothing in it changed for ten minutes."
        actions={
          app.can('operator') ? (
            <Button size="sm" icon="refresh" loading={busy === 'scan'} onClick={() => void run('scan', async () => {
              const r = await api<{ kept: number }>('POST', '/v1/time/computers/scan');
              toast.info(r.kept ? `${r.kept} new backup${r.kept === 1 ? '' : 's'} found` : 'Nothing new', r.kept ? 'Kept and queued for its boot check.' : 'No computer finished a backup since the last look.');
              await reload();
            })}>
              Look now
            </Button>
          ) : undefined
        }
        flush
      >
        <Table
          rows={s.computers}
          rowKey={(c) => c.name}
          columns={[
            { key: 'n', header: 'Computer', render: (c) => <b>{c.name}</b> },
            { key: 'i', header: 'Images kept', render: (c) => c.images },
            { key: 'l', header: 'Newest', render: (c) => (c.lastImageAt ? <span title={formatDate(c.lastImageAt)}>{timeAgo(c.lastImageAt)}</span> : '—') },
            { key: 'r', header: '', render: (c) => (c.receiving ? <Status tone="busy">Receiving a backup</Status> : null) },
          ]}
          empty={<Empty title="No computer has sent an image yet" />}
        />
      </Card>
    </>
  );
}

function Settings({ s, reload }: { s: TimeStatus; reload: () => Promise<void> }) {
  const [seconds, setSeconds] = useState(s.settings.checkSeconds);
  const [keep, setKeep] = useState(s.settings.keepComputer);
  const { run } = useAction();
  const save = (p: Partial<TimeStatus['settings']>) => void run('s', () => api('PUT', '/v1/time/settings', p).then(reload), 'Saved');
  return (
    <Card title="Settings">
      <div className="fx-form">
        <Toggle checked={s.settings.verifyComputers} onChange={(v) => save({ verifyComputers: v })} label="Check computers' images when they arrive (start each one as a throwaway machine)" />
        <Field label="How long a boot check lets the machine run" help="Then it looks at the machine: still running, its screen, and (when the machine has one) its guest agent. Windows can need a few minutes.">
          <div className="fx-actions">
            <Input type="number" min={30} max={1800} value={seconds} style={{ width: 120 }} onChange={(e) => setSeconds(Number(e.target.value))} onBlur={() => seconds !== s.settings.checkSeconds && save({ checkSeconds: seconds })} />
            <span className="fx-muted">seconds</span>
          </div>
        </Field>
        <Field label="Images kept of each computer">
          <Input type="number" min={1} max={365} value={keep} style={{ width: 120 }} onChange={(e) => setKeep(Number(e.target.value))} onBlur={() => keep !== s.settings.keepComputer && save({ keepComputer: keep })} />
        </Field>
        <KeyValue items={[['Images are kept in', <code key="r">{s.repository}</code>]]} />
      </div>
    </Card>
  );
}
