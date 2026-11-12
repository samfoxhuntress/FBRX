import { useEffect, useState } from 'react';
import { decodeTimeCode, describeSchedule, SCHEDULE_TIME_PATTERN, WEEKDAYS, type DriveInfo, type ImageBackupConfig, type ImageBackupStatus, type Schedule } from '@fbrx/shared';
import { Button, Callout, Card, ChoiceCards, Field, Input, KeyValue, Select, Spinner, Status, formatBytes, formatDate, timeAgo, useAction, useConfirm, useToast } from '@fbrx/ui';
import { call } from '../client';
import { useCore } from '../hooks';
import { menuFor } from '../context-menu';

/**
 * Backup → Whole computer (FBRX Time): an image of Windows, the apps and the files, by hand or on a schedule, to a
 * drive, a network folder or an FBRX Server (its connection code). Setting it up asks for administrator once; after
 * that the images are made in the background and FBRX Command can ask for one too.
 */

type Where = 'drive' | 'folder' | 'server';

const SCHEDULE_OPTIONS: Array<{ value: Schedule; label: string }> = [
  { value: 'off', label: 'Only when I ask' },
  { value: 'daily', label: 'Every day' },
  { value: 'weekly', label: 'Every week' },
];

const whereOf = (c: ImageBackupConfig | null): Where => (!c ? 'drive' : /^[A-Za-z]:$/.test(c.target) ? 'drive' : /\\fbrx-time$/i.test(c.target) ? 'server' : 'folder');

export function WholeComputer() {
  const [poll, setPoll] = useState(60_000);
  const st = useCore('imageBackup.status', undefined, [], poll);
  const s = st.data;
  const [editing, setEditing] = useState(false);
  useEffect(() => setPoll(s?.running ? 5_000 : 60_000), [s?.running]);

  const subtitle = 'An image of Windows, your apps and your files that puts this computer back exactly as it was, even on a new drive.';
  if (!s) return <Card title="Whole computer">{st.error ? <Callout tone="warning">{st.error}</Callout> : <Spinner />}</Card>;
  if (!s.supported)
    return (
      <Card title="Whole computer" subtitle={subtitle}>
        <Callout tone="info">{s.reason}</Callout>
      </Card>
    );
  return editing || !s.configured ? <Setup s={s} onDone={(n) => (st.setData(n), setEditing(false))} onCancel={s.configured ? () => setEditing(false) : null} subtitle={subtitle} /> : <Overview s={s} setS={st.setData} reload={st.reload} onChange={() => setEditing(true)} subtitle={subtitle} />;
}

function Overview({ s, setS, reload, onChange, subtitle }: { s: ImageBackupStatus; setS: (n: ImageBackupStatus) => void; reload: () => void; onChange: () => void; subtitle: string }) {
  const { run, busy } = useAction();
  const { confirm, dialog } = useConfirm();
  const toast = useToast();
  const c = s.config!;
  const last = s.last;
  const now = async () => {
    const n = await run('now', () => call('imageBackup.run'), 'Making an image of this computer');
    if (n) setS(n);
  };
  const stop = async () => {
    const ok = await confirm({
      title: 'Stop image backups?',
      body: 'This computer stops making images. The images already made stay where they are. Windows asks for administrator permission.',
      confirmLabel: 'Stop image backups',
      danger: true,
    });
    if (!ok) return;
    const n = await run('stop', () => call('imageBackup.remove'), 'Image backups stopped');
    if (n) setS(n);
  };
  const tone = s.running ? 'busy' : !last ? 'neutral' : last.ok ? 'good' : 'critical';
  const label = s.running ? 'Making an image' : !last ? 'No image yet' : last.ok ? `Last image ${timeAgo(last.finishedAt ?? last.at)}` : 'The last image failed';
  return (
    <Card
      title="Whole computer"
      subtitle={subtitle}
      actions={<Status tone={tone}>{label}</Status>}
    >
      <div
        onContextMenu={menuFor([
          { label: 'Back up now', icon: 'archive', disabled: s.running, onSelect: () => void now() },
          { label: 'Change where and when…', icon: 'settings', onSelect: onChange },
          { label: 'Copy where images go', icon: 'copy', onSelect: () => void navigator.clipboard.writeText(c.target).then(() => toast.success('Copied')) },
          'separator',
          { label: 'Stop image backups…', icon: 'trash', danger: true, onSelect: () => void stop() },
        ])}
      >
        <KeyValue
          items={[
            ['Where', <span className="mono">{c.target}</span>],
            ['When', c.schedule === 'off' ? 'Only when you ask (or FBRX Command does)' : describeSchedule(c.schedule, c.time, c.day)],
            ...(s.nextAt ? ([['Next image', formatDate(s.nextAt)]] as Array<[string, string]>) : []),
            ['Last image', last ? `${formatDate(last.at)}${last.ok ? '' : ' (failed)'}` : 'None yet'],
            ...(s.versions.length ? ([['Images there', String(s.versions.length)]] as Array<[string, string]>) : []),
          ]}
        />
        {s.running && (
          <Callout tone="info" title="Making an image">
            Started {s.startedAt ? timeAgo(s.startedAt) : 'just now'}. You can keep working: Windows copies a snapshot of the computer in the background. The first image takes longest; later ones are quicker.
          </Callout>
        )}
        {last && !last.ok && !s.running && (
          <Callout tone="critical" title="Windows did not make the image">
            {last.detail || 'Windows did not say why.'}
            {whereOf(c) !== 'drive' && ' Check that the network folder is reachable and the account can write to it.'}
          </Callout>
        )}
        <div className="fx-actions" style={{ marginTop: 12 }}>
          <Button variant="primary" icon="archive" disabled={s.running} loading={busy === 'now'} onClick={() => void now()}>
            Back up now
          </Button>
          <Button icon="settings" onClick={onChange}>
            Change…
          </Button>
          <Button variant="ghost" icon="refresh" aria-label="Check again" onClick={reload} />
          <span style={{ flex: 1 }} />
          <Button variant="ghost" icon="trash" loading={busy === 'stop'} onClick={() => void stop()}>
            Stop image backups
          </Button>
        </div>
        <p className="fx-muted" style={{ marginBottom: 0 }}>
          To put an image back, start the computer from a Windows installer or recovery drive and choose <b>Repair your computer → Troubleshoot → System Image Recovery</b>.
          {whereOf(c) === 'server' && ' Your FBRX Server can also open it as a virtual machine.'}
        </p>
      </div>
      {dialog}
    </Card>
  );
}

function Setup({ s, onDone, onCancel, subtitle }: { s: ImageBackupStatus; onDone: (n: ImageBackupStatus) => void; onCancel: (() => void) | null; subtitle: string }) {
  const c = s.config;
  const drives = useCore('storage.drives');
  const { run, busy } = useAction();
  const [where, setWhere] = useState<Where>(whereOf(c));
  const [drive, setDrive] = useState(c && whereOf(c) === 'drive' ? c.target : '');
  const [folder, setFolder] = useState(c && whereOf(c) === 'folder' ? c.target : '');
  const [user, setUser] = useState(c && whereOf(c) === 'folder' ? c.user : '');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [schedule, setSchedule] = useState<Schedule>(c?.schedule ?? 'weekly');
  const [time, setTime] = useState(c?.time ?? '21:00');
  const [day, setDay] = useState(c?.day ?? 5);

  const all = drives.data ?? [];
  const system = all.find((d) => d.letter.toUpperCase() === 'C:');
  const choices = all.filter((d: DriveInfo) => d.letter.toUpperCase() !== 'C:' && d.size > 0);
  const picked = choices.find((d) => d.letter === drive);
  const decoded = where === 'server' && code.trim() ? decodeTimeCode(code) : null;
  const keepsServer = where === 'server' && !code.trim() && c && whereOf(c) === 'server';

  const target = where === 'drive' ? drive : where === 'folder' ? folder.trim() : (decoded?.share ?? (keepsServer ? c.target : ''));
  const problem =
    where === 'drive'
      ? !drive
        ? 'Pick a drive'
        : null
      : where === 'folder'
        ? !/^\\\\[^\\]+\\[^\\]+/.test(folder.trim())
          ? 'Type the network folder like \\\\server\\folder'
          : null
        : !decoded && !keepsServer
          ? code.trim()
            ? 'That is not an FBRX Time connection code'
            : 'Paste the connection code from your FBRX Server'
          : null;
  const timeProblem = schedule !== 'off' && !SCHEDULE_TIME_PATTERN.test(time) ? 'Pick a time' : null;

  const save = async () => {
    const p =
      where === 'drive'
        ? { target, user: '', password: null }
        : where === 'folder'
          ? { target, user: user.trim(), password: password ? password : user.trim() ? undefined : null }
          : decoded
            ? { target: decoded.share, user: decoded.user, password: decoded.password }
            : { target, user: c?.user ?? '', password: undefined };
    // undefined: keep the password already saved for this folder (the same folder and account as before).
    const same = c && c.target === p.target && c.user === p.user;
    const n = await run(
      'save',
      () => call('imageBackup.configure', { target: p.target, user: p.user, schedule, time, day, password: p.password === undefined ? (same ? undefined : null) : p.password }),
      'Image backups are set up',
    );
    if (n) onDone(n);
  };

  return (
    <Card title={c ? 'Change image backups' : 'Whole computer'} subtitle={subtitle}>
      <div className="fx-form">
        <ChoiceCards<Where>
          label="Where should the images go?"
          value={where}
          onChange={setWhere}
          options={[
            { value: 'drive', icon: 'drive', title: 'A drive', description: 'An external drive plugged into this computer. It keeps several images and only copies what changed.' },
            { value: 'folder', icon: 'folder', title: 'A network folder', description: 'A shared folder on another computer or a storage box. Windows keeps the newest image there.' },
            { value: 'server', icon: 'server', title: 'An FBRX Server', description: 'Its backup folder keeps every image and checks each one by starting it.' },
          ]}
        />
        {where === 'drive' &&
          (drives.data && !choices.length ? (
            <Callout tone="warning">Plug in an external drive (formatted NTFS), then pick it here.</Callout>
          ) : (
            <Field label="Drive" help={picked ? `${formatBytes(picked.free)} free of ${formatBytes(picked.size)}${system ? ` · this computer uses about ${formatBytes(system.size - system.free)}` : ''}` : undefined}>
              <Select
                value={drive}
                onChange={(e) => setDrive(e.target.value)}
                options={[{ value: '', label: drives.data ? 'Pick a drive…' : 'Looking for drives…' }, ...choices.map((d) => ({ value: d.letter, label: `${d.letter} ${d.label} (${formatBytes(d.size)}, ${d.type})` }))]}
              />
            </Field>
          ))}
        {picked && picked.fs && picked.fs.toUpperCase() !== 'NTFS' && <Callout tone="warning">Windows makes images on drives formatted NTFS; {picked.letter} is {picked.fs}.</Callout>}
        {picked && system && picked.free < system.size - system.free && <Callout tone="warning">{picked.letter} may be too small: it has less free space than this computer uses.</Callout>}
        {where === 'folder' && (
          <>
            <Field label="Network folder">
              <Input value={folder} placeholder="\\nas\backups" onChange={(e) => setFolder(e.target.value)} spellCheck={false} />
            </Field>
            <div className="fx-row">
              <Field label="Account (if the folder asks)" help="Like NAS\backup or backup">
                <Input value={user} autoComplete="off" onChange={(e) => setUser(e.target.value)} spellCheck={false} />
              </Field>
              <Field label="Password" help={c && whereOf(c) === 'folder' && c.user ? 'Leave empty to keep the one saved' : undefined}>
                <Input type="password" value={password} autoComplete="new-password" onChange={(e) => setPassword(e.target.value)} />
              </Field>
            </div>
          </>
        )}
        {where === 'server' && (
          <>
            <Field label="Connection code" help="On the server: FBRX Time → Computers → Copy the connection code">
              <Input value={code} placeholder={keepsServer ? 'Leave empty to keep the server you have' : 'fbrx-time:…'} onChange={(e) => setCode(e.target.value)} spellCheck={false} />
            </Field>
            {decoded && (
              <Callout tone="good">
                Images go to <span className="mono">{decoded.share}</span>
                {decoded.server ? ` on ${decoded.server}` : ''}, signed in as <span className="mono">{decoded.user}</span>.
              </Callout>
            )}
          </>
        )}
        <div className="fx-row">
          <Field label="When">
            <Select value={schedule} onChange={(e) => setSchedule(e.target.value as Schedule)} options={SCHEDULE_OPTIONS} />
          </Field>
          {schedule !== 'off' && (
            <Field label="At what time?">
              <Input type="time" value={time} onChange={(e) => setTime(e.target.value)} aria-label="Image time" />
            </Field>
          )}
          {schedule === 'weekly' && (
            <Field label="On">
              <Select value={String(day)} onChange={(e) => setDay(Number(e.target.value))} options={WEEKDAYS.map((d, i) => ({ value: String(i), label: d }))} />
            </Field>
          )}
        </div>
        <p className="fx-muted" style={{ margin: 0 }}>
          Windows asks for administrator permission once. After that the images are made in the background, even when nobody is signed in; a computer that was off at the time makes it when it is next on.
        </p>
        {(problem || timeProblem) && (target || where !== 'drive') && <Callout tone="warning">{problem ?? timeProblem}</Callout>}
        <div className="fx-actions">
          <Button variant="primary" icon="shield" disabled={!!problem || !!timeProblem} loading={busy === 'save'} onClick={() => void save()}>
            {c ? 'Save' : 'Set up image backups'}
          </Button>
          {onCancel && (
            <Button variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
}
