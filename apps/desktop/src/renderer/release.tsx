import { useState } from 'react';
import { codenameFor, displayVersion, type ReleaseCheck } from '@fbrx/shared';
import { Button, Callout, Card, Icons, KeyValue, Modal, Status, Toggle, timeAgo, useAction } from '@fbrx/ui';
import { call, openExternal } from './client';
import { useCore } from './hooks';

/**
 * New versions published in the FBRX repository: a pill in the top bar, a dialog with what's new, and the panel in
 * Settings → Updates. Updating is always the person's choice.
 */

export function useRelease() {
  return useCore('release.status', undefined, ['release.changed']);
}

const offerable = (r: ReleaseCheck | null | undefined) => !!r && r.state === 'available' && !!r.latest && !r.skipped;

export function UpdatePill() {
  const r = useRelease().data;
  const [open, setOpen] = useState(false);
  if (!offerable(r) && !r?.installing) return null;
  const preparing = r?.installing && !['failed', 'started'].includes(r.installing.phase);
  return (
    <>
      <button className={`update-pill${r?.latest?.importance === 'important' ? ' important' : ''}`} onClick={() => setOpen(true)} title="A new version of FBRX OS is ready">
        <Icons.download size={13} />
        {preparing ? 'Preparing update…' : `Update to ${r?.latest?.version}`}
      </button>
      {open && r && <ReleaseDialog release={r} onClose={() => setOpen(false)} />}
    </>
  );
}

export function ReleaseDialog({ release: r, onClose }: { release: ReleaseCheck; onClose: () => void }) {
  const { run, busy } = useAction();
  const l = r.latest!;
  const inst = r.installing;
  const working = !!inst && !['failed', 'started'].includes(inst.phase);
  return (
    <Modal
      wide
      title={`FBRX OS ${l.stage} ${l.version}${l.codename ? ` · ${l.codename}` : ''}`}
      description={`${l.released ? `Released ${l.released}. ` : ''}You have ${displayVersion(r.currentVersion)}. Your data, settings and license stay as they are.`}
      onClose={onClose}
      footer={
        <>
          {!working && inst?.phase !== 'started' && (
            <Button
              variant="ghost"
              onClick={() =>
                void run('skip', () => call('release.skip', { version: l.version }), `You won't be reminded about ${l.version}`).then(onClose)
              }
            >
              Skip this version
            </Button>
          )}
          <Button onClick={onClose}>{inst?.phase === 'started' ? 'Close' : 'Later'}</Button>
          {r.canInstall ? (
            inst?.phase !== 'started' && (
              <Button variant="primary" icon="download" loading={busy === 'go' || working} onClick={() => void run('go', () => call('release.install'))}>
                {inst?.phase === 'failed' ? 'Try again' : 'Update now'}
              </Button>
            )
          ) : (
            <Button variant="primary" icon="download" onClick={() => openExternal(l.download)}>
              Download
            </Button>
          )}
        </>
      }
    >
      {l.summary && <p style={{ marginTop: 0 }}>{l.summary}</p>}
      {l.notes.length > 0 && (
        <ul className="release-notes">
          {l.notes.map((n, i) => (
            <li key={i}>{n}</li>
          ))}
        </ul>
      )}
      {inst && (
        <Callout tone={inst.phase === 'failed' ? 'critical' : inst.phase === 'started' ? 'good' : 'info'} title={PHASE[inst.phase]}>
          {inst.phase === 'downloading' && inst.pct !== null ? `${inst.pct}%` : inst.message}
        </Callout>
      )}
      {!r.canInstall && (
        <p className="fx-muted" style={{ fontSize: 12.5, marginBottom: 0 }}>
          To update: unzip the download over your FBRX folder (the one you installed from) and run the installer in it again. (Installs made with this version or later can update themselves.)
        </p>
      )}
      <p style={{ marginBottom: 0 }}>
        <a href={l.page} onClick={(e) => (e.preventDefault(), openExternal(l.page))}>
          More about this release
        </a>
      </p>
    </Modal>
  );
}

const PHASE: Record<NonNullable<ReleaseCheck['installing']>['phase'], string> = {
  downloading: 'Downloading',
  unpacking: 'Unpacking into your FBRX folder',
  starting: 'Starting the installer',
  started: 'Installer started',
  failed: 'The update could not be prepared',
};

/** Settings → Updates. */
export function ReleasePanel({ checkRepo, locked, onToggle }: { checkRepo: boolean; locked: boolean; onToggle: (v: boolean) => void }) {
  const r = useRelease().data;
  const { run, busy } = useAction();
  const [open, setOpen] = useState(false);
  if (!r) return null;
  const tone = r.state === 'available' ? 'warning' : r.state === 'current' ? 'good' : r.state === 'error' ? 'critical' : r.state === 'checking' ? 'busy' : 'neutral';
  const label = { idle: 'Not checked yet', checking: 'Checking…', current: 'Up to date', available: r.skipped ? `${r.latest?.version} skipped` : `${r.latest?.version} available`, error: 'Could not check', off: 'Not checking' }[r.state];
  return (
    <Card title="New versions" subtitle="FBRX OS looks for new versions in its online repository and offers them. Nothing is installed unless you choose to.">
      <div className="fx-form">
        <KeyValue
          items={[
            ['This computer', displayVersion(r.currentVersion)],
            ['Latest', r.latest ? `${r.latest.stage} ${r.latest.version}${r.latest.codename ? ` · ${r.latest.codename}` : ''}` : '—'],
            ['Status', <Status tone={tone}>{label}</Status>],
            ['Last checked', r.checkedAt ? timeAgo(r.checkedAt) : 'never'],
          ]}
        />
        {r.state === 'error' && r.message && <Callout tone="warning">{r.message}</Callout>}
        <div className="fx-actions">
          <Button icon="refresh" loading={busy === 'c' || r.state === 'checking'} onClick={() => void run('c', () => call('release.check'))}>
            Check now
          </Button>
          {r.state === 'available' && r.latest && (
            <Button variant="primary" icon="download" onClick={() => setOpen(true)}>
              {r.skipped ? `See ${r.latest.version} anyway` : `See what's new in ${r.latest.version}`}
            </Button>
          )}
        </div>
        <Toggle checked={checkRepo} disabled={locked} onChange={onToggle} label="Check for new versions automatically (every few hours)" />
      </div>
      {open && <ReleaseDialog release={r} onClose={() => setOpen(false)} />}
    </Card>
  );
}

/** The version, as shown in Settings → About. */
export function AboutVersion({ version }: { version: string }) {
  const code = codenameFor(version);
  return (
    <div className="about-version">
      <div className="about-version-name">
        FBRX OS <b>{displayVersion(version)}</b>
      </div>
      {code && (
        <div className="about-codename">
          <span className="about-codename-chip">“{code.name}”</span>
          <span className="fx-muted">{code.meaning}.</span>
        </div>
      )}
    </div>
  );
}
