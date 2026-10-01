import { useState } from 'react';
import type { FolderUsage, PhysicalDiskInfo } from '@fbrx/shared';
import { BarList, Button, Callout, Card, Empty, Grid, Input, KeyValue, Meter, Modal, Page, Spinner, Status, Tabs, formatBytes, useAction, useConfirm, useToast } from '@fbrx/ui';
import { call, pickFile } from '../client';
import { useCore } from '../hooks';
import { IS_WINDOWS, navigate } from '../app';

function Analyzer() {
  const home = useCore('files.home');
  const [path, setPath] = useState('');
  const [usage, setUsage] = useState<FolderUsage | null>(null);
  const { run, busy } = useAction();
  const analyze = async (p: string) => {
    setPath(p);
    const r = await run('analyze', () => call('storage.analyze', { path: p }));
    if (r) setUsage(r);
  };
  return (
    <Card title="What is using space?" subtitle="Sizes of the folders inside a folder, and its largest files">
      <div className="fx-actions" style={{ marginBottom: 12 }}>
        <div style={{ flex: 1, minWidth: 240 }}>
          <Input className="fx-input mono" placeholder="Folder to analyse" value={path} onChange={(e) => setPath(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void analyze(path)} />
        </div>
        <Button icon="folder" onClick={async () => { const p = await pickFile({ kind: 'folder', title: 'Folder to analyse' }); if (p) void analyze(p); }}>
          Choose…
        </Button>
        {(home.data?.places ?? []).slice(0, 4).map((p) => (
          <Button key={p.path} size="sm" onClick={() => void analyze(p.path)}>
            {p.name}
          </Button>
        ))}
        <Button variant="primary" loading={busy === 'analyze'} disabled={!path} onClick={() => void analyze(path)}>
          Analyse
        </Button>
      </div>
      {busy === 'analyze' && <Spinner />}
      {usage && busy !== 'analyze' && (
        <Grid cols={2}>
          <div>
            <div className="fx-label">
              {formatBytes(usage.total)} in {usage.files.toLocaleString()} files{usage.partial ? ' (stopped early: very large folder)' : ''}
            </div>
            <BarList items={usage.children.slice(0, 15).map((c) => ({ key: c.path, label: `${c.dir ? '📁 ' : ''}${c.name}`, value: c.size }))} format={formatBytes} />
            <div className="fx-actions" style={{ marginTop: 8 }}>
              {usage.children
                .filter((c) => c.dir)
                .slice(0, 6)
                .map((c) => (
                  <Button key={c.path} size="sm" variant="ghost" onClick={() => void analyze(c.path)}>
                    Open {c.name}
                  </Button>
                ))}
            </div>
          </div>
          <div>
            <div className="fx-label">Largest files</div>
            <div className="fx-list" style={{ maxHeight: 360, overflow: 'auto' }}>
              {usage.largest.map((f) => (
                <div key={f.path} className="fx-list-item" style={{ fontSize: 12.5 }}>
                  <span className="mono" style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={f.path}>
                    {f.path}
                  </span>
                  <span>{formatBytes(f.size)}</span>
                  <Button size="sm" variant="ghost" icon="external" aria-label="Open" onClick={() => void call('files.open', { path: f.path })} />
                </div>
              ))}
            </div>
          </div>
        </Grid>
      )}
    </Card>
  );
}

function Disks() {
  const disks = useCore('storage.disks');
  const { run, busy } = useAction();
  const { confirm, dialog } = useConfirm();
  const toast = useToast();
  const [label, setLabel] = useState<{ letter: string; value: string } | null>(null);
  const action = async (action: 'analyze' | 'optimize' | 'chkdsk' | 'extend', letter: string) => {
    const text: Record<string, string> = {
      analyze: 'Check whether the drive needs optimising.',
      optimize: 'Optimise the drive (TRIM for SSDs, defragment for hard disks). Safe to run while you work.',
      chkdsk: 'Scan the drive for file system errors (read-only scan, no restart needed).',
      extend: 'Grow this partition into the free space right after it.',
    };
    if (!(await confirm({ title: `${action[0].toUpperCase()}${action.slice(1)} ${letter}`, body: `${text[action]} Windows will ask for administrator permission.`, confirmLabel: 'Continue', danger: action === 'extend' }))) return;
    const r = await run(`${action}${letter}`, () => call('storage.maintenance', { action, letter }));
    if (r) (r.ok ? toast.success : toast.warning)(r.ok ? 'Done' : 'Finished with problems', r.output.slice(-400));
  };
  if (disks.error) return <Callout tone="warning">{disks.error}</Callout>;
  if (!disks.data) return <Spinner />;
  return (
    <>
      {disks.data.map((d: PhysicalDiskInfo) => (
        <Card
          key={d.number}
          title={`Disk ${d.number}: ${d.model}`}
          subtitle={`${d.media} · ${d.bus} · ${formatBytes(d.size)} · ${d.partitionStyle}${d.isBoot ? ' · boot disk' : ''}`}
          actions={<Status tone={d.health === 'Healthy' ? 'good' : d.health === 'Warning' ? 'warning' : 'critical'}>{d.health}</Status>}
        >
          <KeyValue
            items={[
              ['Serial', d.serial || '—'],
              ['Temperature', d.temperatureC ? `${d.temperatureC} °C` : 'Not reported'],
              ['Wear', d.wearPercent != null ? `${d.wearPercent}% used` : 'Not reported'],
            ]}
          />
          <div className="partbar" style={{ marginTop: 12 }}>
            {d.partitions.map((p) => (
              <div key={p.number} style={{ flex: Math.max(p.size, d.size * 0.03) }} title={`${p.letter || p.type} · ${formatBytes(p.size)}`} className={p.letter ? 'on' : ''}>
                <span>{p.letter || p.type}</span>
                <small>{formatBytes(p.size)}</small>
              </div>
            ))}
          </div>
          <table className="fx-table" style={{ marginTop: 10 }}>
            <thead>
              <tr>
                <th>#</th>
                <th>Drive</th>
                <th>Type</th>
                <th>File system</th>
                <th>Size</th>
                <th>Free</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {d.partitions.map((p) => (
                <tr key={p.number}>
                  <td>{p.number}</td>
                  <td>{p.letter ? `${p.letter} ${p.label}` : <span className="fx-muted">—</span>}</td>
                  <td>{p.type}</td>
                  <td>{p.fs}</td>
                  <td>{formatBytes(p.size)}</td>
                  <td>{p.free != null ? formatBytes(p.free) : '—'}</td>
                  <td>
                    {p.letter && (
                      <div className="fx-actions">
                        <Button size="sm" loading={busy === `optimize${p.letter}`} onClick={() => void action('optimize', p.letter)}>Optimise</Button>
                        <Button size="sm" loading={busy === `chkdsk${p.letter}`} onClick={() => void action('chkdsk', p.letter)}>Check</Button>
                        <Button size="sm" variant="ghost" onClick={() => setLabel({ letter: p.letter, value: p.label })}>Rename</Button>
                        <Button size="sm" variant="ghost" loading={busy === `extend${p.letter}`} onClick={() => void action('extend', p.letter)}>Extend</Button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      ))}
      {label && (
        <Modal
          title={`Rename ${label.letter}`}
          onClose={() => setLabel(null)}
          footer={
            <>
              <Button onClick={() => setLabel(null)}>Cancel</Button>
              <Button
                variant="primary"
                onClick={async () => {
                  const r = await run('label', () => call('storage.maintenance', { action: 'label', letter: label.letter, value: label.value }));
                  if (r?.ok) toast.success('Drive renamed');
                  setLabel(null);
                  disks.reload();
                }}
              >
                Rename
              </Button>
            </>
          }
        >
          <Input autoFocus maxLength={32} value={label.value} onChange={(e) => setLabel({ ...label, value: e.target.value })} />
        </Modal>
      )}
      {dialog}
    </>
  );
}

export function StoragePage({ advanced }: { advanced: boolean }) {
  const [tab, setTab] = useState<'overview' | 'disks'>('overview');
  const drives = useCore('storage.drives');
  const clean = useCore('storage.cleanupInfo');
  const { run, busy } = useAction();
  const { confirm, dialog } = useConfirm();
  const toast = useToast();
  return (
    <Page title="Storage" description="Drives, clean-up and what is taking up space.">
      {advanced && IS_WINDOWS && (
        <Tabs
          tabs={[
            { id: 'overview', label: 'Overview' },
            { id: 'disks', label: 'Disks & partitions' },
          ]}
          active={tab}
          onChange={setTab}
        />
      )}
      {tab === 'disks' ? (
        <Disks />
      ) : (
        <>
          <Grid cols={3}>
            {(drives.data ?? []).map((d) => (
              <Card key={d.letter} title={`${d.label} (${d.letter})`} subtitle={`${d.fs} · ${d.type}`} actions={<Status tone={d.health === 'Healthy' ? 'good' : 'warning'}>{d.health}</Status>}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 6 }}>
                  <span>{formatBytes(d.free)} free</span>
                  <span className="fx-muted">of {formatBytes(d.size)}</span>
                </div>
                <Meter value={d.size - d.free} max={d.size} label={`${d.letter} used`} />
                {d.bitlocker && (
                  <div style={{ marginTop: 8 }}>
                    <Status tone={d.bitlocker.startsWith('On') ? 'good' : 'neutral'}>BitLocker {d.bitlocker}</Status>
                  </div>
                )}
              </Card>
            ))}
            {!drives.data && <Spinner />}
          </Grid>
          <Card title="Clean up" subtitle="Safe, one-click clean-up">
            {clean.data ? (
              <div className="fx-list">
                {clean.data.temp.map((t) => (
                  <div key={t.path} className="fx-list-item">
                    <div style={{ flex: 1 }}>
                      <div className="fx-cell-title">Temporary files</div>
                      <div className="fx-cell-sub mono">{t.path}</div>
                    </div>
                    <strong>{formatBytes(t.size)}</strong>
                  </div>
                ))}
                <div className="fx-list-item">
                  <div style={{ flex: 1 }}>
                    <div className="fx-cell-title">Clean temporary files</div>
                    <div className="fx-cell-sub">Removes your temporary files older than a day. Files in use are skipped.</div>
                  </div>
                  <Button
                    variant="primary"
                    loading={busy === 'temp'}
                    onClick={async () => {
                      const r = await run('temp', () => call('storage.cleanTemp'));
                      if (r) toast.success(`Freed ${formatBytes(r.freed)}`, `${r.skipped} item(s) skipped`);
                      clean.reload();
                    }}
                  >
                    Clean
                  </Button>
                </div>
                {clean.data.recycleBin != null && (
                  <div className="fx-list-item">
                    <div style={{ flex: 1 }}>
                      <div className="fx-cell-title">Recycle Bin</div>
                      <div className="fx-cell-sub">Permanently delete everything in the Recycle Bin.</div>
                    </div>
                    <strong>{formatBytes(clean.data.recycleBin)}</strong>
                    <Button
                      variant="danger"
                      loading={busy === 'bin'}
                      disabled={!clean.data.recycleBin}
                      onClick={async () => {
                        if (await confirm({ title: 'Empty the Recycle Bin?', body: 'Deleted files cannot be recovered afterwards.', danger: true, confirmLabel: 'Empty' })) {
                          await run('bin', () => call('storage.emptyRecycleBin'), 'Recycle Bin emptied');
                          clean.reload();
                        }
                      }}
                    >
                      Empty
                    </Button>
                  </div>
                )}
                <div className="fx-list-item">
                  <div style={{ flex: 1 }}>
                    <div className="fx-cell-title">Downloads</div>
                    <div className="fx-cell-sub mono">{clean.data.downloads.path}</div>
                  </div>
                  <strong>{formatBytes(clean.data.downloads.size)}</strong>
                  <Button onClick={() => void call('files.open', { path: clean.data!.downloads.path })}>Open</Button>
                </div>
              </div>
            ) : (
              <Spinner />
            )}
          </Card>
          <Analyzer />
          {!IS_WINDOWS && <Callout tone="info">Drive maintenance (optimise, check, partitions, BitLocker) is available on Windows.</Callout>}
          {IS_WINDOWS && !advanced && (
            <Callout tone="info" actions={<Button size="sm" onClick={() => navigate('settings/appearance')}>Settings</Button>}>
              Turn on Advanced mode to see physical disks, partitions, health and drive maintenance.
            </Callout>
          )}
        </>
      )}
      {dialog}
      {!drives.data && drives.error && <Empty title="Could not read drives">{drives.error}</Empty>}
    </Page>
  );
}
