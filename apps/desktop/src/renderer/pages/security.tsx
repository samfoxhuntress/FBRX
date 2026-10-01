import { useState, type ReactNode } from 'react';
import type { AuditItem, FileReport, LinkReport } from '@fbrx/shared';
import { Button, Callout, Card, Empty, Grid, Input, KeyValue, Page, Select, Spinner, StatTile, Status, Tabs, Toggle, formatBytes, formatDate, timeAgo, useAction, useConfirm, useToast, type Column, Table, advancedLabel } from '@fbrx/ui';
import { call, pickFile } from '../client';
import { useAgentName, useCore } from '../hooks';
import { IS_WINDOWS, navigate } from '../app';
import { AskButton, askAgent } from '../widgets';

type Tab = 'overview' | 'threats' | 'firewall' | 'audit' | 'check' | 'protection';

function WindowsOnly({ what }: { what: string }) {
  return <Callout tone="info">{what} is available on Windows.</Callout>;
}

function Overview({ go }: { go: (t: Tab) => void }) {
  const def = useCore('security.defender');
  const fw = useCore('security.firewall');
  const threats = useCore('security.threats');
  const { run, busy } = useAction();
  const toast = useToast();
  const agent = useAgentName();
  if (!IS_WINDOWS) return <WindowsOnly what="Microsoft Defender and Windows Firewall status" />;
  const d = def.data;
  const active = (threats.data ?? []).filter((t) => t.active);
  const fwOff = (fw.data ?? []).filter((p) => !p.enabled);
  const scan = async (type: 'quick' | 'full') => {
    toast.info(`${type === 'quick' ? 'Quick' : 'Full'} scan started`, type === 'full' ? 'A full scan can take an hour or more.' : 'This usually takes a few minutes.');
    const r = await run(type, () => call('security.scan', { type }));
    if (r) (r.threatsFound ? toast.error : toast.success)(r.threatsFound ? 'Threats found' : 'No threats found', r.output.slice(-200));
    threats.reload();
    def.reload();
  };
  return (
    <>
      {def.error && <Callout tone="warning">{def.error}</Callout>}
      <Grid cols={4}>
        <StatTile label="Real-time protection" value={d ? (d.realtime ? 'On' : 'Off') : '…'} foot={d ? <Status tone={d.realtime ? 'good' : 'critical'}>{d.realtime ? 'Protected' : 'At risk'}</Status> : ''} />
        <StatTile label="Virus definitions" value={d?.signatureAgeDays != null ? (d.signatureAgeDays === 0 ? 'Today' : `${d.signatureAgeDays} day(s) old`) : '…'} foot={d?.signatureVersion} />
        <StatTile label="Firewall" value={fw.data ? (fwOff.length ? `${fwOff.length} profile(s) off` : 'On') : '…'} foot={fw.data ? <Status tone={fwOff.length ? 'critical' : 'good'}>{fwOff.length ? fwOff.map((p) => p.name).join(', ') : 'All profiles'}</Status> : ''} />
        <StatTile label="Active threats" value={threats.data ? String(active.length) : '…'} foot={active.length ? <Status tone="critical">Action needed</Status> : <Status tone="good">None</Status>} />
      </Grid>
      <Card title="Scan" subtitle={d ? `Last quick scan ${d.lastQuickScan ? timeAgo(d.lastQuickScan) : 'never'} · last full scan ${d.lastFullScan ? timeAgo(d.lastFullScan) : 'never'}` : undefined}>
        <div className="fx-actions">
          <Button variant="primary" icon="shield" loading={busy === 'quick'} onClick={() => void scan('quick')}>
            Quick scan
          </Button>
          <Button loading={busy === 'full'} onClick={() => void scan('full')}>
            Full scan
          </Button>
          <Button
            loading={busy === 'custom'}
            onClick={async () => {
              const path = await pickFile({ kind: 'folder', title: 'Folder to scan' });
              if (!path) return;
              const r = await run('custom', () => call('security.scan', { type: 'custom', path }));
              if (r) (r.threatsFound ? toast.error : toast.success)(r.threatsFound ? 'Threats found' : 'No threats found');
            }}
          >
            Scan a folder…
          </Button>
          <Button loading={busy === 'sig'} onClick={() => void run('sig', () => call('security.updateSignatures')).then((r) => r && (r.ok ? toast.success('Definitions updated') : toast.warning('Update did not finish', r.output.slice(-200))))}>
            Update definitions
          </Button>
          <span className="fx-spacer" />
          <Button variant="ghost" icon="external" onClick={() => void call('security.open', { page: 'home' })}>
            Windows Security
          </Button>
        </div>
      </Card>
      {(active.length > 0 || fwOff.length > 0 || (d && !d.realtime)) && (
        <Callout tone="critical" title="Your protection needs attention" actions={<Button size="sm" icon="sparkles" onClick={() => navigate(`agent/ask/${encodeURIComponent('Check my security status (Defender, firewall, threats) and tell me exactly what to do to fix any problem.')}`)}>Ask {agent}</Button>}>
          {[d && !d.realtime && 'Real-time protection is off.', fwOff.length && `Firewall is off for ${fwOff.map((p) => p.name).join(', ')}.`, active.length && `${active.length} active threat(s).`].filter(Boolean).join(' ')}{' '}
          {active.length > 0 && <a href="#" onClick={(e) => (e.preventDefault(), go('threats'))}>See threats</a>}
        </Callout>
      )}
    </>
  );
}

function Threats() {
  const threats = useCore('security.threats');
  const { run, busy } = useAction();
  const toast = useToast();
  if (!IS_WINDOWS) return <WindowsOnly what="Threat history" />;
  return (
    <Card
      title="Threat history"
      subtitle="Everything Microsoft Defender has detected on this PC"
      actions={
        (threats.data ?? []).some((t) => t.active) && (
          <Button variant="danger-solid" loading={busy === 'rm'} onClick={() => void run('rm', () => call('security.removeThreats')).then((r) => (r?.ok && toast.success('Active threats removed'), threats.reload()))}>
            Remove active threats
          </Button>
        )
      }
      flush
    >
      <Table
        columns={[
          { key: 'n', header: 'Threat', render: (t) => <span className="mono">{t.name}</span> },
          { key: 's', header: 'Severity', render: (t) => <Status tone={/severe|high/i.test(t.severity) ? 'critical' : /moderate/i.test(t.severity) ? 'warning' : 'neutral'}>{t.severity}</Status> },
          { key: 'st', header: 'Status', render: (t) => <Status tone={t.active ? 'critical' : 'good'}>{t.active ? 'Active' : t.status}</Status> },
          { key: 'r', header: 'Where', render: (t) => <span className="fx-muted" style={{ fontSize: 12 }}>{t.resources.join(', ')}</span> },
          { key: 't', header: 'When', render: (t) => (t.time ? formatDate(t.time) : '—') },
          { key: 'x', header: '', render: (t) => <AskButton iconOnly prompt="Microsoft Defender detected this threat on my PC. Explain what it is, how serious it is, how it likely got there, and what I should do now." context={t} />, width: 50 },
        ]}
        rows={threats.data ?? []}
        rowKey={(t) => `${t.id}${t.time}`}
        empty={<Empty title={threats.data ? 'No threats detected' : 'Reading…'} />}
      />
    </Card>
  );
}

function Firewall({ advanced }: { advanced: boolean }) {
  const fw = useCore('security.firewall');
  const ports = useCore('security.ports');
  const { run, busy } = useAction();
  const { confirm, dialog } = useConfirm();
  return (
    <>
      {IS_WINDOWS ? (
        <Card title="Windows Firewall" flush>
          <div className="fx-list">
            {(fw.data ?? []).map((p) => (
              <div key={p.name} className="fx-list-item">
                <div style={{ flex: 1 }}>
                  <div className="fx-cell-title">{p.name} networks</div>
                  <div className="fx-cell-sub">
                    Incoming: {p.inbound} · Outgoing: {p.outbound}
                  </div>
                </div>
                <Status tone={p.enabled ? 'good' : 'critical'}>{p.enabled ? 'On' : 'Off'}</Status>
                <Toggle
                  checked={p.enabled}
                  disabled={busy === p.name}
                  onChange={async (v) => {
                    if (!v && !(await confirm({ title: `Turn off the firewall for ${p.name} networks?`, body: 'This exposes the services on this PC to other devices on those networks.', danger: true, confirmLabel: 'Turn off' }))) return;
                    await run(p.name, () => call('security.setFirewall', { profile: p.name as 'Public', enabled: v }));
                    fw.reload();
                  }}
                />
              </div>
            ))}
          </div>
        </Card>
      ) : (
        <WindowsOnly what="Firewall control" />
      )}
      <Card title="Listening ports" subtitle="Programs waiting for network connections. “Exposed” ones accept connections from other computers." flush>
        <Table
          columns={[
            { key: 'p', header: 'Port', render: (x) => <span className="mono">{x.protocol} {x.port}</span>, width: 110 },
            { key: 'a', header: 'Address', render: (x) => <span className="mono fx-muted">{x.address}</span> },
            { key: 'pr', header: 'Program', render: (x) => `${x.process || '—'} (${x.pid})` },
            { key: 'e', header: '', render: (x) => (x.exposed ? <Status tone="warning">exposed</Status> : <Status tone="neutral">this PC only</Status>) },
            { key: 'x', header: '', render: (x) => <AskButton iconOnly prompt="A program on my PC is listening on this network port. What is it, does it need to be reachable from other computers, and is it a risk?" context={x} />, width: 50 },
          ]}
          rows={(ports.data ?? []).filter((x) => advanced || x.exposed)}
          rowKey={(x) => `${x.protocol}${x.address}${x.port}`}
          empty={<Empty title={ports.data ? 'Nothing exposed' : 'Reading…'} />}
        />
      </Card>
      {dialog}
    </>
  );
}

function Audit() {
  const [kind, setKind] = useState<'startup' | 'processes'>('startup');
  const startup = useCore('security.startup');
  const procs = useCore('security.processAudit');
  const agent = useAgentName();
  if (!IS_WINDOWS) return <WindowsOnly what="Startup and process audits" />;
  const data = kind === 'startup' ? startup : procs;
  const cols: Column<AuditItem>[] = [
    { key: 'n', header: 'Name', render: (x) => x.name },
    { key: 'd', header: 'Details', render: (x) => <span className="fx-muted" style={{ fontSize: 12 }}>{x.detail}</span> },
    { key: 'p', header: 'Path / command', render: (x) => <span className="mono" style={{ fontSize: 11.5, wordBreak: 'break-all' }}>{x.path}</span> },
    { key: 'f', header: '', render: (x) => (x.flags.length ? x.flags.map((f) => <Status key={f} tone="warning">{f}</Status>) : <Status tone="good">ok</Status>) },
    { key: 'x', header: '', render: (x) => <AskButton iconOnly prompt={kind === 'startup' ? 'This starts automatically with Windows on my PC. What is it, is it trustworthy, and is it safe to disable?' : 'This program is running from a user folder on my PC. What is it and does it look suspicious?'} context={x} />, width: 50 },
  ];
  return (
    <Card
      title={kind === 'startup' ? 'What starts with Windows' : 'Programs running from user folders'}
      subtitle={kind === 'startup' ? 'Startup entries and scheduled tasks from other vendors' : 'Malware often runs from Downloads, Temp or AppData without a valid signature'}
      actions={
        <>
          <Tabs tabs={[{ id: 'startup', label: 'Startup' }, { id: 'processes', label: 'Running' }]} active={kind} onChange={setKind} />
          <Button size="sm" className="ask-btn" icon="sparkles" onClick={() => askAgent(kind === 'startup' ? 'Review what starts with Windows on this PC and flag anything suspicious or unnecessary.' : 'Review the programs running from user folders on this PC and tell me if any look suspicious.', data.data?.slice(0, 40))}>
            Review with {agent}
          </Button>
        </>
      }
      flush
    >
      {data.data ? <Table columns={cols} rows={data.data} rowKey={(x) => `${x.name}${x.path}`} empty={<Empty title="Nothing found" />} /> : data.error ? <Callout tone="warning">{data.error}</Callout> : <div style={{ padding: 18 }}><Spinner /></div>}
    </Card>
  );
}

function Check() {
  const [url, setUrl] = useState('');
  const [link, setLink] = useState<LinkReport | null>(null);
  const [file, setFile] = useState<FileReport | null>(null);
  const [sandboxNet, setSandboxNet] = useState(true);
  const { run, busy } = useAction();
  const vt = useCore('vault.list');
  const hasVt = vt.data?.some((s) => s.name === 'VIRUSTOTAL_API_KEY');
  return (
    <>
      <Card title="Is this link safe?" subtitle="Inspect a link without opening it: look-alike domains, redirects, domain age, certificate and reputation. No page code runs.">
        <div className="fx-actions">
          <div style={{ flex: 1, minWidth: 260 }}>
            <Input placeholder="Paste a link from an e-mail or message" value={url} onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && url && void run('link', () => call('security.linkCheck', { url })).then((r) => r && setLink(r))} />
          </div>
          <Button variant="primary" loading={busy === 'link'} disabled={!url} onClick={() => void run('link', () => call('security.linkCheck', { url })).then((r) => r && setLink(r))}>
            Check link
          </Button>
          {IS_WINDOWS && (
            <Button disabled={!url} loading={busy === 'sb'} onClick={() => void run('sb', () => call('security.sandbox', { url, networking: true }), 'Opening Windows Sandbox…')}>
              Open in Sandbox
            </Button>
          )}
        </div>
        {link && (
          <div className="fx-grid" style={{ marginTop: 14, gap: 10 }}>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
              <Status tone={link.verdict === 'dangerous' ? 'critical' : link.verdict === 'caution' ? 'warning' : 'good'}>{link.verdict === 'safe' ? 'Looks safe' : link.verdict === 'caution' ? 'Be careful' : 'Dangerous'}</Status>
              <span className="fx-muted">Risk score {link.score}/100 · {link.domain}</span>
            </div>
            <div className="mono" style={{ fontSize: 12.5, wordBreak: 'break-all' }}>Lands on {link.finalUrl}</div>
            <div>
              <AskButton label="Explain this result" prompt="I checked this link with FBRX OS. Explain the findings in plain language and tell me whether I should open it." context={link} />
            </div>
            <div className="fx-list">
              {link.findings.map((f, i) => (
                <div key={i} className="fx-list-item" style={{ fontSize: 13 }}>
                  <Status tone={f.severity === 'critical' ? 'critical' : f.severity === 'warning' ? 'warning' : 'info'}>{f.severity}</Status>
                  <span>{f.text}</span>
                </div>
              ))}
            </div>
            {link.redirects.length > 1 && (
              <div className="fx-muted" style={{ fontSize: 12 }}>
                Redirect chain: {link.redirects.map((r) => `${r.status ?? '×'} ${new URL(r.url).host}`).join(' → ')}
              </div>
            )}
          </div>
        )}
      </Card>
      <Grid cols={2}>
        <Card title="Check a file" subtitle="Fingerprint, digital signature and VirusTotal verdict">
          <Button
            icon="file"
            loading={busy === 'file'}
            onClick={async () => {
              const path = await pickFile({ kind: 'file', title: 'File to check' });
              if (path) {
                const r = await run('file', () => call('security.fileReport', { path }));
                if (r) setFile(r);
              }
            }}
          >
            Choose a file…
          </Button>
          {!hasVt && (
            <p className="fx-muted" style={{ fontSize: 12.5 }}>
              Optional: save a free VirusTotal API key in <a href="#/vault">Credentials</a> as <code>VIRUSTOTAL_API_KEY</code> to also check reputation.
            </p>
          )}
          {file && (
            <div style={{ marginTop: 12 }}>
              <div style={{ marginBottom: 8 }}>
                <AskButton label="Explain this result" prompt="I checked this file with FBRX OS. Explain the signature, reputation and other findings in plain language and tell me whether it is safe to open." context={file} />
              </div>
              <KeyValue
                items={[
                  ['File', <span className="mono" style={{ fontSize: 12 }}>{file.path}</span>],
                  ['Size', formatBytes(file.size)],
                  ['SHA-256', <span className="mono" style={{ fontSize: 11, wordBreak: 'break-all' }}>{file.sha256}</span>],
                  ['Signature', file.signature ? <Status tone={file.signature.status === 'Valid' ? 'good' : 'warning'}>{`${file.signature.status}${file.signature.signer ? ` · ${file.signature.signer}` : ''}`}</Status> : '—'],
                  [
                    'VirusTotal',
                    !file.virustotal ? 'Not checked' : 'error' in file.virustotal ? file.virustotal.error : !file.virustotal.known ? 'Never seen before (be careful with unknown programs)' : (
                      <Status tone={file.virustotal.malicious ? 'critical' : file.virustotal.suspicious ? 'warning' : 'good'}>{`${file.virustotal.malicious} malicious · ${file.virustotal.suspicious} suspicious`}</Status>
                    ),
                  ],
                ]}
              />
            </div>
          )}
        </Card>
        <Card title="Windows Sandbox" subtitle="A throw-away copy of Windows that is wiped when you close it. Try unknown programs and sites safely.">
          {IS_WINDOWS ? (
            <div className="fx-grid" style={{ gap: 10 }}>
              <Toggle checked={sandboxNet} onChange={setSandboxNet} label="Allow internet inside the sandbox" />
              <div className="fx-actions">
                <Button icon="box" loading={busy === 'sb2'} onClick={() => void run('sb2', () => call('security.sandbox', { networking: sandboxNet }), 'Opening Windows Sandbox…')}>
                  Open empty sandbox
                </Button>
                <Button
                  onClick={async () => {
                    const folder = await pickFile({ kind: 'folder', title: 'Folder to share (read-only)' });
                    if (folder) await run('sb3', () => call('security.sandbox', { folder, networking: sandboxNet }), 'Opening Windows Sandbox…');
                  }}
                >
                  With a folder (read-only)…
                </Button>
              </div>
              <p className="fx-muted" style={{ fontSize: 12.5, margin: 0 }}>
                Needs Windows Pro or Enterprise with Windows Sandbox turned on (Virtual lab).
              </p>
            </div>
          ) : (
            <WindowsOnly what="Windows Sandbox" />
          )}
        </Card>
      </Grid>
    </>
  );
}

const PREFS: Array<{ name: string; label: string; invert?: boolean; kind: 'bool' | 'select'; options?: Array<{ value: string; label: string }> }> = [
  { name: 'DisableRealtimeMonitoring', label: 'Real-time protection', invert: true, kind: 'bool' },
  { name: 'DisableBehaviorMonitoring', label: 'Behavior monitoring', invert: true, kind: 'bool' },
  { name: 'DisableIOAVProtection', label: 'Scan downloads and attachments', invert: true, kind: 'bool' },
  { name: 'DisableScriptScanning', label: 'Scan scripts', invert: true, kind: 'bool' },
  { name: 'DisableRemovableDriveScanning', label: 'Scan USB drives during full scans', invert: true, kind: 'bool' },
  { name: 'PUAProtection', label: 'Block potentially unwanted apps', kind: 'select', options: [{ value: '0', label: 'Off' }, { value: '1', label: 'Block' }, { value: '2', label: 'Audit only' }] },
  { name: 'EnableNetworkProtection', label: 'Network protection (block dangerous sites)', kind: 'select', options: [{ value: '0', label: 'Off' }, { value: '1', label: 'Block' }, { value: '2', label: 'Audit only' }] },
  { name: 'EnableControlledFolderAccess', label: 'Ransomware protection (controlled folder access)', kind: 'select', options: [{ value: '0', label: 'Off' }, { value: '1', label: 'On' }, { value: '2', label: 'Audit only' }] },
  { name: 'MAPSReporting', label: 'Cloud-delivered protection', kind: 'select', options: [{ value: '0', label: 'Off' }, { value: '1', label: 'Basic' }, { value: '2', label: 'Advanced' }] },
];

function Protection() {
  const prefs = useCore('security.defenderPrefs');
  const { run, busy } = useAction();
  const toast = useToast();
  const [ex, setEx] = useState<{ kind: 'path' | 'ext' | 'process'; value: string }>({ kind: 'path', value: '' });
  if (!IS_WINDOWS) return <WindowsOnly what="Defender settings" />;
  const p = prefs.data as Record<string, any> | null;
  const set = async (name: string, value: boolean | number) => {
    const r = await run(name, () => call('security.setDefenderPref', { name, value }));
    if (r) (r.ok ? toast.success : toast.warning)('Defender', r.output.slice(-200) || 'Updated');
    prefs.reload();
  };
  return (
    <>
      <Callout tone="warning">These change Microsoft Defender directly. Windows asks for administrator permission each time. Tamper Protection may block some changes.</Callout>
      <Card title="Protection settings" flush>
        <div className="fx-list">
          {PREFS.map((x) => (
            <div key={x.name} className="fx-list-item">
              <span style={{ flex: 1 }}>{x.label}</span>
              {!p ? (
                <Spinner />
              ) : x.kind === 'bool' ? (
                <Toggle checked={x.invert ? !p[x.name] : !!p[x.name]} disabled={busy === x.name} onChange={(v) => void set(x.name, x.invert ? !v : v)} />
              ) : (
                <div style={{ width: 160 }}>
                  <Select value={String(p[x.name] ?? 0)} onChange={(e) => void set(x.name, Number(e.target.value))} options={x.options!} disabled={busy === x.name} />
                </div>
              )}
            </div>
          ))}
        </div>
      </Card>
      <Card title="Exclusions" subtitle="Files, file types or programs Defender should skip. Use sparingly.">
        <div className="fx-grid" style={{ gap: 8 }}>
          {(['ExclusionPath', 'ExclusionExtension', 'ExclusionProcess'] as const).map((k) =>
            ([] as string[]).concat(p?.[k] ?? []).map((v) => (
              <div key={`${k}${v}`} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
                <Status tone="neutral">{k.replace('Exclusion', '')}</Status>
                <span className="mono" style={{ flex: 1 }}>{v}</span>
                <Button size="sm" variant="ghost" icon="x" aria-label="Remove exclusion" onClick={() => void run(`rm${v}`, () => call('security.exclusion', { kind: k === 'ExclusionPath' ? 'path' : k === 'ExclusionExtension' ? 'ext' : 'process', value: v, remove: true })).then(() => prefs.reload())} />
              </div>
            )),
          )}
          <div className="fx-actions">
            <div style={{ width: 140 }}>
              <Select value={ex.kind} onChange={(e) => setEx({ ...ex, kind: e.target.value as 'path' })} options={[{ value: 'path', label: 'Folder or file' }, { value: 'ext', label: 'File type' }, { value: 'process', label: 'Program' }]} />
            </div>
            <div style={{ flex: 1 }}>
              <Input value={ex.value} placeholder={ex.kind === 'ext' ? '.log' : ex.kind === 'process' ? 'myapp.exe' : 'C:\\Projects\\build'} onChange={(e) => setEx({ ...ex, value: e.target.value })} />
            </div>
            <Button disabled={!ex.value} loading={busy === 'ex'} onClick={() => void run('ex', () => call('security.exclusion', ex)).then(() => (setEx({ ...ex, value: '' }), prefs.reload()))}>
              Add exclusion
            </Button>
          </div>
        </div>
      </Card>
    </>
  );
}

export function SecurityPage({ advanced }: { advanced: boolean }) {
  const [tab, setTab] = useState<Tab>('overview');
  const tabs: Array<{ id: Tab; label: ReactNode }> = [
    { id: 'overview', label: 'Overview' },
    { id: 'threats', label: 'Threats' },
    { id: 'firewall', label: 'Firewall & ports' },
    { id: 'audit', label: 'Startup & processes' },
    { id: 'check', label: 'Check a link or file' },
    ...(advanced ? [{ id: 'protection' as const, label: advancedLabel('Defender settings') }] : []),
  ];
  return (
    <Page title="Security" description="Antivirus, firewall, what runs on this PC, and safe checks for suspicious links and files.">
      <Tabs tabs={tabs} active={tab} onChange={setTab} />
      {tab === 'overview' && <Overview go={setTab} />}
      {tab === 'threats' && <Threats />}
      {tab === 'firewall' && <Firewall advanced={advanced} />}
      {tab === 'audit' && <Audit />}
      {tab === 'check' && <Check />}
      {tab === 'protection' && <Protection />}
    </Page>
  );
}

