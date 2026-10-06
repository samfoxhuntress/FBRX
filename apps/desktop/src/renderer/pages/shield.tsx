import { useEffect, useState } from 'react';
import type { DeepPartial, ProtectionStatus, ScanJob, ScanType, Settings, ShieldDetection } from '@fbrx/shared';
import { AdvancedTag, Button, Callout, Card, ChoiceCards, Empty, Field, Grid, Input, Page, Select, Spinner, StatTile, Status, Table, Tabs, Toggle, formatBytes, formatDate, timeAgo, useAction, useConfirm, useToast, type IconName } from '@fbrx/ui';
import { call, onEvent, pickFile } from '../client';
import { isLocked, useCore } from '../hooks';
import { IS_WINDOWS, navigate } from '../app';
import { AskButton } from '../widgets';

/**
 * Stronghold → FBRX Shield: FBRX's antivirus, and the choice of what protects this computer (FBRX Shield, Microsoft
 * Defender or an antivirus already installed). Scans run with whichever is active; FBRX Shield can always give a
 * second opinion.
 */

const STATE_LABEL: Record<ProtectionStatus['state'], string> = { protected: 'Protected', attention: 'Needs attention', 'at-risk': 'At risk', unknown: 'Status unknown' };
const STATE_TONE: Record<ProtectionStatus['state'], 'good' | 'warning' | 'critical' | 'neutral'> = { protected: 'good', attention: 'warning', 'at-risk': 'critical', unknown: 'neutral' };
const ACTION_LABEL: Record<ShieldDetection['action'], string> = { open: 'Waiting for you', quarantined: 'In quarantine', restored: 'Restored', deleted: 'Deleted', allowed: 'Allowed' };
const KIND_LABEL: Record<ShieldDetection['kind'], string> = { malware: 'Malware', suspicious: 'Suspicious', test: 'Test file' };

const optionIcon = (value: string): IconName => (value === 'auto' ? 'sparkles' : value === 'shield' ? 'shield' : value === 'defender' ? 'checkCircle' : 'box');
const fileName = (p: string) => p.split(/[\\/]/).pop() ?? p;

export function ShieldPage({ agentName, ultra }: { agentName: string; ultra: boolean }) {
  const status = useCore('protection.status', undefined, ['protection.changed', 'settings.changed', 'shield.detected'], 120_000);
  const st = status.data;
  return (
    <Page
      title="FBRX Shield"
      description="Antivirus for this computer: choose what protects it, scan, and decide what happens to anything that is found."
      actions={
        <AskButton
          label="Check my protection"
          prompt="Check how well this computer is protected against malware: which antivirus is active, whether it is on and up to date, and anything FBRX Shield found. Tell me exactly what to do about any problem."
        />
      }
    >
      {status.error && <Callout tone="warning">{status.error}</Callout>}
      {!st ? (
        <Spinner />
      ) : (
        <>
          <Overview st={st} agentName={agentName} />
          <Grid cols={2}>
            <Choose st={st} />
            <Scan st={st} />
          </Grid>
          <Findings agentName={agentName} />
          <ShieldSettings st={st} ultra={ultra} />
        </>
      )}
    </Page>
  );
}

function Overview({ st, agentName }: { st: ProtectionStatus; agentName: string }) {
  const shield = st.active.kind === 'shield';
  const defs = shield
    ? st.shield.signatures
      ? `${st.shield.signatures.toLocaleString()} known threats`
      : 'Empty'
    : st.definitionsAgeDays !== null
      ? st.definitionsAgeDays === 0
        ? 'Today'
        : `${st.definitionsAgeDays} day${st.definitionsAgeDays === 1 ? '' : 's'} old`
      : st.upToDate === null
        ? 'Unknown'
        : st.upToDate
          ? 'Up to date'
          : 'Out of date';
  return (
    <>
      <div className={`shield-hero ${st.state}`}>
        <div className="shield-badge" aria-hidden>
          <svg viewBox="0 0 24 24" width="34" height="34" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 2 4 5v6c0 5 3.4 9.4 8 11 4.6-1.6 8-6 8-11V5l-8-3z" />
            {st.state === 'protected' ? <path d="m8.5 12 2.5 2.5 4.5-5" /> : st.state === 'unknown' ? <path d="M12 8v4M12 16h.01" /> : <path d="M12 7.5v5M12 16h.01" />}
          </svg>
        </div>
        <div className="shield-hero-text">
          <h2>{STATE_LABEL[st.state]}</h2>
          <p>
            Protected by <b>{st.active.name}</b>
            {st.choice === 'auto' ? ' (chosen automatically)' : ''}
            {st.managed ? ' · set by your organization' : ''}
          </p>
          {st.problems.length > 0 && (
            <ul className="shield-problems">
              {st.problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          )}
        </div>
        {st.problems.length > 0 && (
          <Button icon="sparkles" onClick={() => navigate(`agent/ask/${encodeURIComponent('Look at my antivirus status and tell me exactly how to fix each problem.')}`)}>
            Fix it with {agentName}
          </Button>
        )}
      </div>
      <Grid cols={4}>
        <StatTile label={shield ? 'Download checks' : 'Real-time protection'} value={st.realtime === null ? 'Unknown' : st.realtime ? 'On' : 'Off'} foot={<Status tone={st.realtime === null ? 'neutral' : st.realtime ? 'good' : 'critical'}>{st.realtime === null ? 'Not reported' : st.realtime ? 'Watching' : 'Not watching'}</Status>} />
        <StatTile label={shield ? 'Threat database' : 'Definitions'} value={defs} foot={shield && st.shield.signaturesUpdatedAt ? `Updated ${timeAgo(st.shield.signaturesUpdatedAt)}` : st.upToDate === false ? <Status tone="warning">Update needed</Status> : undefined} />
        <StatTile label="Last scan" value={st.lastScan ? timeAgo(st.lastScan) : st.active.kind === 'product' ? 'Not reported' : 'Never'} foot={st.shield.lastScan && shield ? `${st.shield.lastScan.files.toLocaleString()} files, ${st.shield.lastScan.found} found` : undefined} />
        <StatTile label="Threats" value={String(st.threats)} foot={st.threats ? <Status tone="critical">Action needed</Status> : <Status tone="good">None</Status>} />
      </Grid>
    </>
  );
}

function Choose({ st }: { st: ProtectionStatus }) {
  const { run } = useAction();
  const toast = useToast();
  const options = st.options.filter((o) => o.available);
  const missing = st.options.filter((o) => !o.available);
  return (
    <Card title="Protected by" subtitle={st.managed ? 'Your organization chooses the antivirus on this computer.' : 'Choose what protects this computer. FBRX shows its status, runs its scans and warns you when it slips.'}>
      <div className={st.managed ? 'shield-choice managed' : 'shield-choice'}>
        <ChoiceCards<string>
          label="Antivirus"
          value={st.choice}
          onChange={(v) => {
            if (st.managed || v === st.choice) return;
            void run('pick', async () => {
              const s = await call('protection.setProvider', { provider: v });
              toast.success(`Protected by ${s.active.name}`);
            });
          }}
          options={options.map((o) => ({ value: o.value, title: o.label, description: o.detail, icon: optionIcon(o.value) }))}
        />
      </div>
      {missing.length > 0 && <p className="fx-muted shield-note">{missing.map((o) => `${o.label}: ${o.detail}`).join(' ')}</p>}
      {st.notes.map((n) => (
        <p key={n} className="fx-muted shield-note">
          {n}
        </p>
      ))}
    </Card>
  );
}

function Scan({ st }: { st: ProtectionStatus }) {
  const [job, setJob] = useState<ScanJob | null>(null);
  const { run, busy } = useAction();
  const toast = useToast();
  useEffect(() => {
    void call('protection.job').then(setJob);
    return onEvent('protection.scan', (j) => {
      setJob(j);
      if (j.state === 'done') (j.found ? toast.warning : toast.success)(j.found ? `${j.engineName} found ${j.found === 1 && j.engine !== 'shield' ? 'threats' : `${j.found} item${j.found === 1 ? '' : 's'}`}` : `${j.engineName}: nothing found`);
      else if (j.state === 'failed') toast.error('The scan did not finish', j.error ?? undefined);
    });
  }, [toast]);
  const running = job?.state === 'running';
  const start = (type: ScanType, engine: 'active' | 'shield', path?: string) => void run(`scan-${engine}`, async () => setJob(await call('protection.scan', { type, engine, path })));
  const pickAndScan = async (engine: 'active' | 'shield') => {
    const path = await pickFile({ kind: 'folder', title: 'Folder to scan' });
    if (path) start('custom', engine, path);
  };
  const shieldActive = st.active.kind === 'shield';
  return (
    <Card title="Scan" subtitle={st.canScan ? `With ${st.active.name}` : `${st.active.name} does its own scans`}>
      <div className="fx-grid">
        {running && job ? (
          <div className="shield-progress">
            <div className="shield-progress-head">
              <Spinner />
              <b>
                {job.engineName}: {job.type === 'quick' ? 'quick scan' : job.type === 'full' ? 'full scan' : 'scanning a folder'}
              </b>
              <span className="fx-spacer" />
              <Button size="sm" variant="ghost" onClick={() => void call('protection.cancelScan')}>
                Stop
              </Button>
            </div>
            {job.engine === 'shield' ? (
              <>
                <div className="shield-progress-bar" aria-hidden>
                  <span />
                </div>
                <small>
                  {job.files.toLocaleString()} files checked{job.found ? ` · ${job.found} found` : ''}
                </small>
                {job.current && <small className="mono shield-current private">{job.current}</small>}
              </>
            ) : (
              <small>This can take a while. You can keep working.</small>
            )}
          </div>
        ) : (
          job &&
          job.finishedAt && (
            <p className="fx-muted" style={{ margin: 0 }}>
              Last scan with {job.engineName} {timeAgo(job.finishedAt)}: {job.state === 'cancelled' ? 'stopped' : job.state === 'failed' ? `failed (${job.error})` : job.engine === 'shield' ? `${job.files.toLocaleString()} files, ${job.found} found` : job.found ? 'threats found' : 'nothing found'}.
            </p>
          )
        )}
        <div className="fx-actions">
          <Button variant="primary" icon="shield" disabled={running || !st.canScan} loading={busy === 'scan-active'} onClick={() => start('quick', 'active')}>
            Quick scan
          </Button>
          <Button disabled={running || !st.canScan} onClick={() => start('full', 'active')}>
            Full scan
          </Button>
          <Button disabled={running || !st.canScan} onClick={() => void pickAndScan('active')}>
            Scan a folder…
          </Button>
        </div>
        {!shieldActive && (
          <div className="fx-actions">
            <Button size="sm" variant="ghost" icon="shield" disabled={running} loading={busy === 'scan-shield'} onClick={() => start('quick', 'shield')}>
              Second opinion: quick scan with FBRX Shield
            </Button>
            <Button size="sm" variant="ghost" disabled={running} onClick={() => void pickAndScan('shield')}>
              A folder with FBRX Shield…
            </Button>
          </div>
        )}
        <div className="fx-actions">
          {shieldActive ? (
            <Button size="sm" icon="download" loading={busy === 'sig'} onClick={() => void run('sig', async () => {
              const r = await call('shield.updateSignatures');
              toast.success('Threat database updated', `${r.added.toLocaleString()} new, ${r.total.toLocaleString()} in all.`);
            })}>
              Update the threat database
            </Button>
          ) : (
            st.active.kind === 'defender' &&
            IS_WINDOWS && (
              <Button size="sm" icon="download" loading={busy === 'sig'} onClick={() => void run('sig', () => call('security.updateSignatures')).then((r) => r && (r.ok ? toast.success('Definitions updated') : toast.warning('Update did not finish', r.output.slice(-200))))}>
                Update definitions
              </Button>
            )
          )}
          {st.active.kind === 'defender' && IS_WINDOWS && (
            <Button size="sm" variant="ghost" onClick={() => navigate('security/threats')}>
              Defender's threat history
            </Button>
          )}
          {IS_WINDOWS && (
            <Button size="sm" variant="ghost" icon="external" onClick={() => void call('security.open', { page: 'home' })}>
              Windows Security
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
}

function Findings({ agentName }: { agentName: string }) {
  const [view, setView] = useState<'waiting' | 'quarantine' | 'all'>('waiting');
  const list = useCore('shield.detections', { limit: 500 }, ['shield.detected', 'protection.changed', 'protection.scan']);
  const { run, busy } = useAction();
  const { confirm, dialog } = useConfirm();
  const all = list.data ?? [];
  const rows = view === 'waiting' ? all.filter((d) => d.action === 'open') : view === 'quarantine' ? all.filter((d) => d.action === 'quarantined') : all;
  const act = async (d: ShieldDetection, action: 'quarantine' | 'restore' | 'delete' | 'allow') => {
    if (action === 'delete' && !(await confirm({ title: `Delete ${fileName(d.path)}?`, body: 'It is deleted for good.', danger: true, confirmLabel: 'Delete' }))) return;
    if (action === 'restore' && d.kind !== 'suspicious' && !(await confirm({ title: `Put ${fileName(d.path)} back?`, body: `FBRX Shield thinks this is ${d.kind === 'test' ? 'the antivirus test file' : 'malware'}. Restore it only if you are sure it is safe; FBRX Shield will trust it from now on.`, danger: true, confirmLabel: 'Restore' }))) return;
    if (action === 'allow' && !(await confirm({ title: `Trust ${fileName(d.path)}?`, body: 'FBRX Shield leaves it where it is and stops reporting it.', confirmLabel: 'Trust it' }))) return;
    await run(`${d.id}:${action}`, () => call('shield.act', { id: d.id, action }));
    list.reload();
  };
  return (
    <Card
      title="Found by FBRX Shield"
      subtitle="Malware goes into quarantine, where it cannot run. Suspicious files wait for you."
      actions={
        <Tabs
          tabs={[
            { id: 'waiting', label: `Waiting (${all.filter((d) => d.action === 'open').length})` },
            { id: 'quarantine', label: `Quarantine (${all.filter((d) => d.action === 'quarantined').length})` },
            { id: 'all', label: 'History' },
          ]}
          active={view}
          onChange={setView}
        />
      }
      flush
    >
      <Table
        columns={[
          {
            key: 'w',
            header: 'What',
            render: (d) => (
              <div>
                <div className="fx-cell-title">{d.name}</div>
                <Status tone={d.kind === 'suspicious' ? 'warning' : d.kind === 'test' ? 'info' : 'critical'}>{KIND_LABEL[d.kind]}</Status>
              </div>
            ),
          },
          {
            key: 'f',
            header: 'File',
            render: (d) => (
              <div className="shield-file">
                <span className="mono private" title={d.path}>
                  {d.path}
                </span>
                <small className="fx-muted">{d.reason}</small>
              </div>
            ),
          },
          { key: 't', header: 'Found', render: (d) => <span title={formatDate(d.at)}>{`${d.source === 'download' ? 'New download' : d.source === 'check' ? 'File check' : 'Scan'} · ${timeAgo(d.at)}`}{d.size !== null ? ` · ${formatBytes(d.size)}` : ''}</span> },
          { key: 's', header: 'Status', render: (d) => <Status tone={d.action === 'open' ? 'warning' : d.action === 'quarantined' ? 'good' : 'neutral'}>{ACTION_LABEL[d.action]}</Status> },
          {
            key: 'a',
            header: '',
            render: (d) => (
              <div className="fx-actions" style={{ justifyContent: 'flex-end', flexWrap: 'nowrap' }}>
                {d.action === 'open' && (
                  <>
                    <Button size="sm" variant={d.kind === 'suspicious' ? undefined : 'primary'} loading={busy === `${d.id}:quarantine`} onClick={() => void act(d, 'quarantine')}>
                      Quarantine
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => void act(d, 'allow')}>
                      Trust
                    </Button>
                  </>
                )}
                {d.action === 'quarantined' && (
                  <Button size="sm" variant="ghost" loading={busy === `${d.id}:restore`} onClick={() => void act(d, 'restore')}>
                    Restore
                  </Button>
                )}
                {(d.action === 'open' || d.action === 'quarantined') && <Button size="sm" variant="ghost" icon="trash" aria-label="Delete" title="Delete for good" onClick={() => void act(d, 'delete')} />}
                <AskButton iconOnly prompt={`FBRX Shield flagged this file. Explain what "${d.name}" means here, how worried I should be, and what I should do. Do not open or run the file.`} context={{ file: d.path, finding: d.name, kind: d.kind, reason: d.reason, sha256: d.sha256, source: d.source, status: d.action, assistant: agentName }} />
              </div>
            ),
            width: 260,
          },
        ]}
        rows={rows}
        rowKey={(d) => d.id}
        empty={<Empty title={list.data ? (view === 'waiting' ? 'Nothing waiting' : view === 'quarantine' ? 'Quarantine is empty' : 'Nothing found yet') : 'Reading…'} />}
      />
      {dialog}
    </Card>
  );
}

function ShieldSettings({ st, ultra }: { st: ProtectionStatus; ultra: boolean }) {
  const s = useCore('settings.get', undefined, ['settings.changed']);
  const { run, busy } = useAction();
  const toast = useToast();
  const locked = s.data?.locked;
  const L = (p: string) => isLocked(locked, `protection.shield.${p}`);
  const sh = s.data?.settings.protection.shield;
  const patch = (p: DeepPartial<Settings['protection']['shield']>) => void run('patch', () => call('settings.update', { patch: { protection: { shield: p } } }));
  const [feed, setFeed] = useState<string | null>(null);
  const vt = useVirusTotalKey();
  if (!sh) return null;
  return (
    <Card title="FBRX Shield settings" subtitle="These apply to FBRX Shield whichever antivirus protects the computer: download checks and second opinions use it too.">
      <div className="fx-grid">
        <Toggle checked={sh.watchDownloads} disabled={L('watchDownloads')} onChange={(v) => patch({ watchDownloads: v })} label="Check new files in Downloads and on the desktop as soon as they arrive" />
        <Toggle checked={sh.autoQuarantine} disabled={L('autoQuarantine')} onChange={(v) => patch({ autoQuarantine: v })} label="Move malware into quarantine straight away" />
        <Toggle checked={sh.heuristics} disabled={L('heuristics')} onChange={(v) => patch({ heuristics: v })} label="Report suspicious files (disguised programs, scripts that download and run code, macros from the internet…)" />
        <div className="shield-row">
          <Toggle checked={sh.updateSignatures} disabled={L('updateSignatures')} onChange={(v) => patch({ updateSignatures: v })} label="Keep the threat database up to date (every day)" />
          <span className="fx-muted">
            {st.shield.signatures.toLocaleString()} known threats{st.shield.signaturesUpdatedAt ? `, updated ${timeAgo(st.shield.signaturesUpdatedAt)}` : ''}
          </span>
        </div>
        {st.shield.signaturesError && <Callout tone="warning">{st.shield.signaturesError}</Callout>}

        <div className="shield-ultra">
          <div className="shield-row">
            <span>
              Scheduled scan <AdvancedTag />
            </span>
            <div style={{ width: 200 }}>
              <Select
                value={sh.schedule}
                disabled={!ultra || L('schedule')}
                onChange={(e) => patch({ schedule: e.target.value as 'off' | 'daily' | 'weekly' })}
                options={[
                  { value: 'off', label: 'Off' },
                  { value: 'daily', label: 'Quick scan every day' },
                  { value: 'weekly', label: 'Quick scan every week' },
                ]}
              />
            </div>
          </div>
          <Toggle checked={sh.useClamAV} disabled={!ultra || L('useClamAV')} onChange={(v) => patch({ useClamAV: v })} label={<>Also scan with ClamAV {st.products.some((p) => p.id === 'clamav') ? '(installed)' : '(when installed)'} <AdvancedTag /></>} />
          <Toggle checked={sh.useVirusTotal} disabled={!ultra || L('useVirusTotal')} onChange={(v) => patch({ useVirusTotal: v })} label={<>Ask VirusTotal about suspicious files {vt ? '' : '(add a VIRUSTOTAL_API_KEY in Credentials)'} <AdvancedTag /></>} />
          {!ultra && <p className="fx-muted shield-note">FBRX Endpoint Ultra adds scheduled scans and second engines. Everything else in FBRX Shield is in every edition.</p>}
        </div>

        <Field label="Skip these folders" help="FBRX Shield does not scan or watch them. Use sparingly.">
          <div className="fx-grid" style={{ gap: 6 }}>
            {sh.exclusions.map((x) => (
              <div key={x} className="shield-row">
                <span className="mono">{x}</span>
                <Button size="sm" variant="ghost" icon="x" aria-label={`Stop skipping ${x}`} disabled={L('exclusions')} onClick={() => patch({ exclusions: sh.exclusions.filter((y) => y !== x) })} />
              </div>
            ))}
            <div className="fx-actions">
              <Button
                size="sm"
                icon="plus"
                disabled={L('exclusions')}
                onClick={async () => {
                  const path = await pickFile({ kind: 'folder', title: 'Folder FBRX Shield should skip' });
                  if (path && !sh.exclusions.includes(path)) patch({ exclusions: [...sh.exclusions, path] });
                }}
              >
                Add a folder
              </Button>
            </div>
          </div>
        </Field>

        <details className="cal-howto">
          <summary>Threat database source</summary>
          <div className="fx-grid" style={{ marginTop: 8 }}>
            <Field label="Feed address" help="A list of SHA-256 fingerprints of known malware, one per line. The default is abuse.ch MalwareBazaar's recent additions; if it asks for a key, add your free abuse.ch Auth-Key in Credentials as ABUSECH_AUTH_KEY.">
              <Input value={feed ?? sh.feedUrl} disabled={L('feedUrl')} onChange={(e) => setFeed(e.target.value)} onBlur={() => feed !== null && feed.trim() !== sh.feedUrl && patch({ feedUrl: feed.trim() })} />
            </Field>
            <div className="fx-actions">
              <Button
                size="sm"
                loading={busy === 'import'}
                onClick={async () => {
                  const path = await pickFile({ kind: 'file', title: 'A list of SHA-256 fingerprints' });
                  if (!path) return;
                  const r = await run('import', () => call('shield.importSignatures', { path }));
                  if (r) toast.success('Fingerprints added', `${r.added.toLocaleString()} new, ${r.total.toLocaleString()} in all.`);
                }}
              >
                Import a list…
              </Button>
            </div>
          </div>
        </details>
      </div>
    </Card>
  );
}

function useVirusTotalKey(): boolean {
  const secrets = useCore('vault.list', undefined, ['vault.changed']);
  return (secrets.data ?? []).some((x) => x.name === 'VIRUSTOTAL_API_KEY');
}
