import { useEffect, useState } from 'react';
import { Button, Callout, Card, Status, Toggle, formatDate, useAction } from '@fbrx/ui';
import { api } from '../api';
import { useApp, useQuery } from '../state';

/**
 * FBRX Command's own version and new versions of it (Releases page), and the banner the platform operator sees when
 * one is out. FBRX Command checks the FBRX release list by itself every six hours; Update now downloads the new FBRX
 * folder and re-runs "Install FBRX Command" on the FBRX Command computer, keeping all its data.
 */

export interface CommandUpdateStatus {
  state: 'idle' | 'checking' | 'current' | 'available' | 'error' | 'off';
  currentVersion: string;
  latest: { version: string; stage: string; released: string; importance: string; summary: string; notes: string[]; download: string; page: string } | null;
  checkedAt: string | null;
  message: string | null;
  autoCheck: boolean;
  skipped: boolean;
  canInstall: boolean;
  installedFrom: string | null;
  /** What installs its new versions instead ("FBRX Server"), or null. */
  managedBy: string | null;
  installing: { phase: 'downloading' | 'unpacking' | 'starting' | 'started' | 'failed'; pct: number | null; message: string | null } | null;
}

const PHASE: Record<NonNullable<CommandUpdateStatus['installing']>['phase'], string> = {
  downloading: 'Downloading the new version',
  unpacking: 'Unpacking',
  starting: 'Starting the installer',
  started: 'Installer started',
  failed: 'The update did not work',
};

export function CommandUpdateCard() {
  const app = useApp();
  const manage = app.can('command.update');
  const q = useQuery<CommandUpdateStatus>(app.can('command.read') ? '/v1/admin/command/update' : null);
  const { run, busy } = useAction();
  const s = q.data;
  const preparing = !!s?.installing && !['started', 'failed'].includes(s.installing.phase);
  // Follow the download while it runs.
  useEffect(() => {
    if (!preparing) return;
    const t = setInterval(q.reload, 1000);
    return () => clearInterval(t);
  }, [preparing, q.reload]);
  if (!s) return null;
  const post = (path: string, body?: unknown) => api('POST', `/v1/admin/command/update${path}`, body).then(q.reload);
  const newer = s.state === 'available' && s.latest;
  return (
    <Card
      title={`FBRX Command ${s.currentVersion}`}
      subtitle="This server and console. It carries the same version as the FBRX OS release it was installed from."
      actions={
        manage && (
          <Button size="sm" icon="refresh" loading={busy === 'check' || s.state === 'checking'} onClick={() => void run('check', () => post('/check'))}>
            Check now
          </Button>
        )
      }
    >
      <div className="fx-form">
        {newer ? (
          <Callout tone={s.latest!.importance === 'important' ? 'warning' : 'info'} title={`FBRX Command ${s.latest!.stage} ${s.latest!.version} is available${s.skipped ? ' (skipped)' : ''}`}>
            {s.latest!.summary && <p style={{ margin: '0 0 6px' }}>{s.latest!.summary}</p>}
            {s.latest!.notes.length > 0 && (
              <ul style={{ margin: '0 0 6px', paddingLeft: 18 }}>
                {s.latest!.notes.map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
            )}
            <a href={s.latest!.page} target="_blank" rel="noreferrer">
              Release page
            </a>
          </Callout>
        ) : s.state === 'current' ? (
          <Status tone="good">Up to date{s.checkedAt ? ` · checked ${formatDate(s.checkedAt)}` : ''}</Status>
        ) : s.state === 'error' ? (
          <Status tone="warning">Could not check: {s.message}</Status>
        ) : s.state === 'checking' ? (
          <Status tone="busy">Checking…</Status>
        ) : (
          <Status tone="neutral">{s.autoCheck ? 'Not checked yet (it checks a minute and a half after it starts, then every six hours)' : 'Automatic checks are off'}</Status>
        )}

        {s.installing && (
          <Status tone={s.installing.phase === 'failed' ? 'critical' : s.installing.phase === 'started' ? 'good' : 'busy'}>
            {PHASE[s.installing.phase]}
            {s.installing.pct != null && s.installing.phase === 'downloading' ? ` (${s.installing.pct}%)` : ''}
            {s.installing.message ? `: ${s.installing.message}` : ''}
          </Status>
        )}

        {manage && newer && (
          <div className="fx-actions">
            {s.canInstall && (
              <Button variant="primary" icon="download" loading={preparing || busy === 'install'} disabled={s.installing?.phase === 'started'} onClick={() => void run('install', () => post('/install'))}>
                Update now
              </Button>
            )}
            {!s.skipped ? (
              <Button variant="ghost" onClick={() => void run('skip', () => post('/skip', { version: s.latest!.version }))}>
                Skip this version
              </Button>
            ) : (
              <Button variant="ghost" onClick={() => void run('skip', () => post('/skip', { version: null }))}>
                Remind me again
              </Button>
            )}
          </div>
        )}

        {manage && newer && (
          <p className="fx-muted" style={{ fontSize: 12.5, margin: 0 }}>
            {s.canInstall ? (
              <>
                Update now downloads the new FBRX folder into <span className="mono">{s.installedFrom}</span> and runs Install FBRX Command there, on the FBRX Command computer. FBRX Command stops for a few minutes, then starts again with all its devices, settings and data. On a Mac, press Return in the Terminal window that opens.
              </>
            ) : s.managedBy ? (
              <>
                FBRX Command runs as a role of {s.managedBy} and updates with it. On the server: <span className="mono">sudo fbrx-server update check</span>, then <span className="mono">sudo fbrx-server update commit</span>. It keeps all its devices, settings and data.
              </>
            ) : (
              <>
                To update: download the new FBRX zip (Release page), unzip it, and run <b>Install FBRX Command</b> in it on the FBRX Command computer. It updates in place and keeps all its data; from then on Update now works from here.
              </>
            )}
          </p>
        )}

        {manage && <Toggle checked={s.autoCheck} onChange={(v) => void run('auto', () => post('/auto', { on: v }))} label="Check for new versions by itself (every six hours)" />}
      </div>
    </Card>
  );
}

/** A line across the top of the console for the platform operator when a new FBRX Command is out. */
export function CommandUpdateBanner({ onOpen }: { onOpen: () => void }) {
  const operator = useApp().can('command.update');
  const [s, setS] = useState<CommandUpdateStatus | null>(null);
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    if (!operator) return;
    const load = () => api<CommandUpdateStatus>('GET', '/v1/admin/command/update').then(setS).catch(() => undefined);
    void load();
    const t = setInterval(load, 30 * 60_000);
    return () => clearInterval(t);
  }, [operator]);
  if (hidden || !s || s.state !== 'available' || !s.latest || s.skipped) return null;
  return (
    <div
      role="status"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        flexWrap: 'wrap',
        margin: '0 0 16px',
        padding: '8px 12px',
        borderRadius: 'var(--radius)',
        border: '1px solid color-mix(in srgb, var(--accent) 40%, transparent)',
        background: 'var(--accent-wash)',
      }}
    >
      <span style={{ flex: 1, minWidth: 200 }}>
        <b>FBRX Command {s.latest.version}</b> is available (you have {s.currentVersion}).
      </span>
      <Button size="sm" variant="primary" onClick={onOpen}>
        See what is new
      </Button>
      <Button size="sm" variant="ghost" icon="x" aria-label="Hide" onClick={() => setHidden(true)} />
    </div>
  );
}
