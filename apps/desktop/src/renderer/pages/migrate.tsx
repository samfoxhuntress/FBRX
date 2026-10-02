import { useEffect, useMemo, useRef, useState } from 'react';
import type { MigrateEngine, MigrateJob, MigrateMode, MigrateRequest } from '@fbrx/shared';
import { Button, Callout, Card, Field, Icons, Input, Page, Select, StatTile, Status, Toggle, formatBytes, formatDuration, useConfirm, useToast } from '@fbrx/ui';
import { call, onEvent, pickFile } from '../client';
import { useCore } from '../hooks';
import { IS_WINDOWS } from '../app';
import { AskButton } from '../widgets';

const MODES: Array<{ value: MigrateMode; label: string; help: string }> = [
  { value: 'copy', label: 'Copy', help: 'Copies everything that is new or different. Files already at the destination stay.' },
  { value: 'update', label: 'Copy new and changed only', help: 'Like Copy, but never overwrites a file that is newer at the destination. Good for repeat backups.' },
  { value: 'mirror', label: 'Mirror', help: 'Makes the destination an exact copy: files that are not in the source are deleted there.' },
  { value: 'move', label: 'Move', help: 'Copies everything, then deletes the originals from the source.' },
];

const USER_FOLDERS = ['Desktop', 'Documents', 'Pictures', 'Music', 'Videos', 'Downloads'];

interface Form extends Required<Omit<MigrateRequest, 'excludeFiles' | 'excludeDirs'>> {
  excludeFiles: string;
  excludeDirs: string;
}

const split = (s: string) =>
  s
    .split(/[,;\n]/)
    .map((x) => x.trim())
    .filter(Boolean);

export function MigratePage() {
  const engines = useCore('migrate.engines');
  const home = useCore('files.home');
  const [f, setF] = useState<Form>({
    engine: IS_WINDOWS ? 'robocopy' : 'builtin',
    mode: 'copy',
    source: '',
    dest: '',
    subfolders: true,
    permissions: false,
    skipJunk: true,
    retries: 2,
    threads: 8,
    dryRun: false,
    excludeFiles: '',
    excludeDirs: '',
  });
  const [plan, setPlan] = useState<{ command: string; warnings: string[] } | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  const [job, setJob] = useState<{ jobId: string; started: number; dryRun: boolean } | null>(null);
  const [progress, setProgress] = useState({ files: 0, bytes: 0, errors: 0 });
  const [result, setResult] = useState<MigrateJob | null>(null);
  const [lines, setLines] = useState<string[]>([]);
  const [queue, setQueue] = useState<Array<{ source: string; dest: string }>>([]);
  const [now, setNow] = useState(Date.now());
  const log = useRef<HTMLDivElement>(null);
  const toast = useToast();
  const { confirm, dialog } = useConfirm();

  const request = (o: Partial<Form> = {}): MigrateRequest => {
    const x = { ...f, ...o };
    return { ...x, excludeFiles: split(x.excludeFiles), excludeDirs: split(x.excludeDirs) };
  };

  // The exact command, refreshed as the form changes.
  const key = JSON.stringify(request());
  useEffect(() => {
    if (!f.source.trim() || !f.dest.trim()) {
      setPlan(null);
      setPlanError(null);
      return;
    }
    let alive = true;
    const t = setTimeout(
      () =>
        void call('migrate.plan', request())
          .then((p) => alive && (setPlan(p), setPlanError(null)))
          .catch((e: Error) => alive && (setPlan(null), setPlanError(e.message))),
      250,
    );
    return () => {
      alive = false;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, result]);

  // Live output, progress and the end of each job (and the next folder in a queue).
  const jobRef = useRef(job);
  jobRef.current = job;
  const queueRef = useRef(queue);
  queueRef.current = queue;
  useEffect(
    () =>
      onEvent('migrate.event', (e) => {
        if (e.jobId !== jobRef.current?.jobId) return;
        if (e.type === 'lines') setLines((l) => [...l, ...e.lines].slice(-600));
        else if (e.type === 'progress') setProgress({ files: e.files, bytes: e.bytes, errors: e.errors });
        else {
          setResult(e.job);
          setJob(null);
          setProgress({ files: e.job.files, bytes: e.job.bytes, errors: e.job.errors });
          const [next, ...rest] = queueRef.current;
          if (next && e.job.state === 'done') {
            setQueue(rest);
            void begin({ ...e.job.request, source: next.source, dest: next.dest }, true);
          } else setQueue([]);
        }
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  useEffect(() => {
    log.current?.scrollTo({ top: log.current.scrollHeight });
  }, [lines]);
  useEffect(() => {
    if (!job) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [job]);

  const begin = async (r: MigrateRequest, continuing = false) => {
    try {
      const s = await call('migrate.start', r);
      if (!continuing) setLines([]);
      setLines((l) => [...l, `> ${s.command}`]);
      setResult(null);
      setProgress({ files: 0, bytes: 0, errors: 0 });
      setJob({ jobId: s.jobId, started: Date.now(), dryRun: !!r.dryRun });
    } catch (e) {
      setQueue([]);
      toast.error('Could not start', (e as Error).message);
    }
  };

  const start = async (dryRun: boolean) => {
    const r = request({ dryRun });
    if (!dryRun && (r.mode === 'mirror' || r.mode === 'move')) {
      const ok = await confirm({
        title: r.mode === 'mirror' ? 'Mirror and delete extras?' : 'Move and delete the originals?',
        body: r.mode === 'mirror' ? `Files in ${r.dest} that are not in ${r.source} will be deleted. Run a preview first if you are not sure.` : `Everything in ${r.source} is copied to ${r.dest}, then deleted from ${r.source}.`,
        danger: true,
        confirmLabel: r.mode === 'mirror' ? 'Mirror' : 'Move',
      });
      if (!ok) return;
    }
    await begin(r);
  };

  /** Recipe: the usual user folders, each into its own folder at the destination, one after another. */
  const userFolders = async () => {
    const h = home.data?.home;
    if (!h) return;
    const dest = await pickFile({ kind: 'folder', title: 'Where should your folders go? (a drive, a share or a folder on the new PC)' });
    if (!dest) return;
    const sep = h.includes('\\') ? '\\' : '/';
    const list = USER_FOLDERS.map((n) => ({ source: `${h}${sep}${n}`, dest: `${dest.replace(/[\\/]+$/, '')}${sep}${n}` }));
    setF({ ...f, mode: 'update', source: list[0].source, dest: list[0].dest, skipJunk: true });
    setQueue(list.slice(1));
    await begin(request({ mode: 'update', source: list[0].source, dest: list[0].dest, skipJunk: true, dryRun: false }));
  };

  const recipes: Array<{ label: string; apply: () => void }> = useMemo(() => {
    const h = home.data?.home ?? '';
    const sep = h.includes('\\') ? '\\' : '/';
    return [
      { label: 'Back up Documents', apply: () => setF((x) => ({ ...x, source: `${h}${sep}Documents`, mode: 'update', skipJunk: true })) },
      { label: 'Mirror a folder to a NAS', apply: () => setF((x) => ({ ...x, mode: 'mirror', dest: IS_WINDOWS ? '\\\\nas\\backup\\' : '/Volumes/backup/', skipJunk: true })) },
      { label: 'Copy a USB stick', apply: () => setF((x) => ({ ...x, mode: 'copy', subfolders: true, skipJunk: false })) },
      { label: 'Move a project to another drive', apply: () => setF((x) => ({ ...x, mode: 'move', skipJunk: true })) },
    ];
  }, [home.data]);

  const browse = async (which: 'source' | 'dest') => {
    const p = await pickFile({ kind: 'folder', title: which === 'source' ? 'Copy from' : 'Copy to' });
    if (p) setF((x) => ({ ...x, [which]: p }));
  };
  const running = !!job;
  const elapsed = job ? (now - job.started) / 1000 : result ? (Date.parse(result.finishedAt ?? result.startedAt) - Date.parse(result.startedAt)) / 1000 : 0;
  const engine = engines.data?.find((e) => e.id === f.engine);

  return (
    <Page
      title="Copy & migrate"
      description="Copy, back up, mirror or move folders between drives, computers and network shares, with Robocopy on Windows, rsync on a Mac or Linux, or FBRX's own copier."
    >
      <div className="chips">
        <button className="chip" disabled={running || !home.data} onClick={() => void userFolders()} title="Desktop, Documents, Pictures, Music, Videos and Downloads, each into its own folder">
          <Icons.users size={13} /> Move my user folders to a new PC
        </button>
        {recipes.map((r) => (
          <button key={r.label} className="chip" disabled={running} onClick={r.apply}>
            {r.label}
          </button>
        ))}
      </div>
      <div className="migrate-layout">
        <Card title="What to copy">
          <div className="fx-form">
            <Field label="From">
              <div className="fx-actions" style={{ flexWrap: 'nowrap' }}>
                <Input value={f.source} placeholder={IS_WINDOWS ? 'C:\\Users\\you\\Documents' : '/Users/you/Documents'} onChange={(e) => setF({ ...f, source: e.target.value })} />
                <Button onClick={() => void browse('source')}>Browse…</Button>
              </div>
            </Field>
            <div className="migrate-swap">
              <Button size="sm" variant="ghost" icon="refresh" disabled={running} onClick={() => setF({ ...f, source: f.dest, dest: f.source })}>
                Swap
              </Button>
            </div>
            <Field label="To" help={IS_WINDOWS ? 'A folder, another drive (E:\\Backup) or a network share (\\\\server\\share\\folder)' : 'A folder, a mounted drive or a network share'}>
              <div className="fx-actions" style={{ flexWrap: 'nowrap' }}>
                <Input value={f.dest} placeholder={IS_WINDOWS ? 'E:\\Backup\\Documents' : '/Volumes/Backup/Documents'} onChange={(e) => setF({ ...f, dest: e.target.value })} />
                <Button onClick={() => void browse('dest')}>Browse…</Button>
              </div>
            </Field>
            <div className="fx-row">
              <Field label="Tool" help={engine?.note}>
                <Select
                  value={f.engine}
                  onChange={(e) => setF({ ...f, engine: e.target.value as MigrateEngine })}
                  options={(engines.data ?? []).map((e) => ({ value: e.id, label: `${e.name}${e.available ? '' : ' (not available)'}`, disabled: !e.available }))}
                />
              </Field>
              <Field label="What to do" help={MODES.find((m) => m.value === f.mode)?.help}>
                <Select value={f.mode} onChange={(e) => setF({ ...f, mode: e.target.value as MigrateMode })} options={MODES.map((m) => ({ value: m.value, label: m.label }))} />
              </Field>
            </div>
            <div className="migrate-options">
              <Toggle checked={f.subfolders} disabled={f.mode === 'mirror'} onChange={(v) => setF({ ...f, subfolders: v })} label="Include subfolders" />
              <Toggle checked={f.skipJunk} onChange={(v) => setF({ ...f, skipJunk: v })} label="Skip clutter (Thumbs.db, desktop.ini, temp and lock files, Recycle Bin)" />
              <Toggle checked={f.permissions} disabled={f.engine === 'builtin' && IS_WINDOWS} onChange={(v) => setF({ ...f, permissions: v })} label="Copy permissions too" />
            </div>
            <div className="fx-row">
              <Field label="Retries on a busy or locked file">
                <Select value={String(f.retries)} onChange={(e) => setF({ ...f, retries: Number(e.target.value) })} options={['0', '1', '2', '5', '10']} />
              </Field>
              {f.engine === 'robocopy' && (
                <Field label="Files at once" help="More is faster for many small files">
                  <Select value={String(f.threads)} onChange={(e) => setF({ ...f, threads: Number(e.target.value) })} options={['1', '4', '8', '16', '32']} />
                </Field>
              )}
            </div>
            <div className="fx-row">
              <Field label="Leave out files" help="Comma-separated, * and ? work: *.iso, *.bak">
                <Input value={f.excludeFiles} onChange={(e) => setF({ ...f, excludeFiles: e.target.value })} />
              </Field>
              <Field label="Leave out folders" help="Names, comma-separated: node_modules, .git">
                <Input value={f.excludeDirs} onChange={(e) => setF({ ...f, excludeDirs: e.target.value })} />
              </Field>
            </div>
            {planError && <Callout tone="warning">{planError}</Callout>}
            {plan && (
              <>
                {plan.warnings.map((w) => (
                  <Callout key={w} tone={/delete/i.test(w) ? 'warning' : 'info'}>
                    {w}
                  </Callout>
                ))}
                <div className="migrate-command">
                  <span className="fx-label">Command</span>
                  <code>{plan.command}</code>
                </div>
              </>
            )}
            <div className="fx-actions">
              <Button icon="eye" disabled={running || !plan} onClick={() => void start(true)} title="Lists what would be copied, moved or deleted, without changing anything">
                Preview
              </Button>
              <Button variant="primary" icon="play" disabled={running || !plan} onClick={() => void start(false)}>
                {f.mode === 'move' ? 'Move' : f.mode === 'mirror' ? 'Mirror' : 'Start copying'}
              </Button>
              {running && (
                <Button variant="danger" icon="stop" onClick={() => void call('migrate.cancel', { jobId: job!.jobId })}>
                  Cancel
                </Button>
              )}
            </div>
          </div>
        </Card>
        <Card
          title="Progress"
          subtitle={running ? (job!.dryRun ? 'Previewing…' : 'Copying…') : result ? (result.request.dryRun ? 'Preview finished' : 'Finished') : 'Nothing running'}
          actions={
            <>
              {running ? <Status tone="busy">{queue.length ? `${queue.length + 1} folders to go` : 'running'}</Status> : result && <Status tone={result.state === 'done' ? 'good' : result.state === 'canceled' ? 'neutral' : 'critical'}>{result.state}</Status>}
              {result && <AskButton iconOnly label="Explain this result" prompt={`I ran a ${result.request.engine} ${result.request.mode} from ${result.request.source} to ${result.request.dest}${result.request.dryRun ? ' as a preview' : ''}. Explain the result in plain language, and if anything failed, why and how to fix it.`} context={[result.summary, ...lines.slice(-80)].join('\n')} />}
            </>
          }
          flush
        >
          <div className="migrate-stats">
            <StatTile label={job?.dryRun || result?.request.dryRun ? 'Files to copy' : 'Files'} value={progress.files.toLocaleString()} />
            <StatTile label="Data" value={formatBytes(progress.bytes)} />
            <StatTile label="Errors" value={String(progress.errors)} />
            <StatTile label="Time" value={elapsed < 60 ? `${Math.round(elapsed)}s` : formatDuration(Math.round(elapsed))} />
          </div>
          {result?.summary && <pre className="migrate-summary">{result.summary}</pre>}
          <div className="term migrate-log" ref={log}>
            {lines.length ? lines.map((l, i) => <div key={i} className={/ERROR|failed/i.test(l) ? 'term-err' : /^\*EXTRA/i.test(l.trim()) ? 'migrate-extra' : l.startsWith('>') ? 'term-prompt' : undefined}>{l}</div>) : <div className="term-dim">Choose two folders, then Preview to see what would happen, or Start.</div>}
          </div>
        </Card>
      </div>
      {dialog}
    </Page>
  );
}
