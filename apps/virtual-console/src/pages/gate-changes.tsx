import { useState } from 'react';
import { checkConfig, type GateChange, type GateCommit, type GateConfig, type GateState, type NetworkdFile, type QosPlan } from '@fbrx/gate';
import { Button, Callout, Card, Empty, Field, Input, JsonEditor, Modal, Select, Status, Table, Tabs, timeAgo, Toggle, useConfirm, useToast, type StatusTone } from '@fbrx/ui';
import { api } from '../api';
import { useGate } from '../gate-state';
import { useApp, usePoll } from '../state';
import { GatePage, IssueList } from './gate-common';

const KIND_TONE: Record<GateChange['kind'], StatusTone> = { added: 'good', removed: 'critical', changed: 'info' };
const KIND_WORDS: Record<GateChange['kind'], string> = { added: 'Added', removed: 'Removed', changed: 'Changed' };
const STATUS_TONE: Record<GateCommit['status'], StatusTone> = { applied: 'warning', confirmed: 'good', 'rolled-back': 'neutral', failed: 'critical' };
const STATUS_WORDS: Record<GateCommit['status'], string> = { applied: 'On trial', confirmed: 'Kept', 'rolled-back': 'Rolled back', failed: 'Failed' };

/** Where a change is: "networks.guest.dhcp.end" (names may have dots of their own, like the VLAN eno2.30). */
const where = (path: string) => path.replace(/^\./, '') || 'everything';

/** A value in a change, short. */
function brief(v: unknown): string {
  if (v === undefined) return '—';
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const name = o.name ?? o.id ?? o.mac;
    if (typeof name === 'string') return name;
    const s = JSON.stringify(v);
    return s.length > 60 ? `${s.slice(0, 57)}…` : s;
  }
  return String(v);
}

interface Preview {
  nftables: string;
  dnsmasq: string;
  networkd: NetworkdFile[];
  qos: QosPlan | null;
}
type PreviewTab = 'nftables' | 'dnsmasq' | 'networkd' | 'qos';

export function GateChangesPage() {
  const app = useApp();
  const g = useGate();
  const toast = useToast();
  const { confirm, dialog } = useConfirm();
  const history = usePoll<{ commits: GateCommit[] }>(app.has('gate') ? '/v1/gate/history' : null, 15000);
  const [comment, setComment] = useState('');
  const [trial, setTrial] = useState(true);
  const [minutes, setMinutes] = useState(5);
  const [busy, setBusy] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewTab, setPreviewTab] = useState<PreviewTab>('nftables');
  const [text, setText] = useState(false);
  const [viewing, setViewing] = useState<GateCommit | null>(null);
  const admin = app.can('admin');

  const act = async (key: string, fn: () => Promise<{ state: GateState; notes?: string[] }>, done: string) => {
    setBusy(key);
    try {
      const r = await fn();
      g.setState(r.state, r.notes);
      toast.success(done, r.notes?.length ? r.notes.join(' · ') : undefined);
      void history.reload();
      return true;
    } catch (e) {
      toast.error('Not done', (e as Error).message);
      void g.reload();
      return false;
    } finally {
      setBusy(null);
    }
  };

  return (
    <GatePage title="Changes" description="Edits wait here until you commit them. A trial commit undoes itself unless you keep it, so a change that cuts you off puts the old configuration back on its own. Every commit is kept, to go back to.">
      {(info) => {
        const s = info.state;
        const pending = !!s.confirm;
        const canCommit = admin && !pending && s.errors.length === 0 && (s.changes.length > 0 || !s.running);
        // Every commit that applied runs until the next one does, so the newest of those is what runs.
        const runningId = s.running ? history.data?.commits.find((c) => c.status === 'confirmed' || c.status === 'applied')?.id : undefined;
        return (
          <>
            <Card
              title={!s.running ? 'The first configuration' : s.changes.length ? `${s.changes.length} change${s.changes.length === 1 ? '' : 's'} not on the network yet` : 'Everything is on the network'}
              subtitle={s.running ? 'Between what runs and what is being edited' : 'Nothing runs yet: this is everything a first commit puts in place'}
              actions={
                admin && (
                  <>
                    <Button size="sm" icon="braces" onClick={() => setText(true)}>
                      Edit as text
                    </Button>
                    {s.running && s.changes.length > 0 && (
                      <Button
                        size="sm"
                        icon="history"
                        loading={busy === 'reset'}
                        onClick={async () => {
                          if (await confirm({ title: 'Throw the edits away?', body: <p className="fx-secondary">What is being edited goes back to what runs now.</p>, confirmLabel: 'Throw away', danger: true }))
                            await act('reset', () => api('POST', '/v1/gate/candidate/reset', {}), 'Edits thrown away');
                        }}
                      >
                        Throw edits away
                      </Button>
                    )}
                  </>
                )
              }
              flush
            >
              {s.running ? (
                <Table
                  rows={s.changes}
                  rowKey={(c) => `${c.kind}${c.path}`}
                  empty={<Empty title="Nothing to commit: what is being edited is what runs" />}
                  columns={[
                    { key: 'k', header: '', width: 110, render: (c) => <Status tone={KIND_TONE[c.kind]}>{KIND_WORDS[c.kind]}</Status> },
                    { key: 'p', header: 'Where', render: (c) => <span className="mono">{where(c.path)}</span> },
                    { key: 'f', header: 'Was', render: (c) => <span className="mono fx-muted">{c.kind === 'added' ? '—' : brief(c.from)}</span> },
                    { key: 't', header: 'Becomes', render: (c) => <span className="mono">{c.kind === 'removed' ? '—' : brief(c.to)}</span> },
                  ]}
                />
              ) : (
                <div className="gt-pad">
                  <p className="fx-secondary" style={{ margin: 0 }}>
                    The internet on <b className="mono">{s.candidate.wan.interface}</b>, {s.candidate.networks.length} network{s.candidate.networks.length === 1 ? '' : 's'} ({s.candidate.networks.map((n) => `${n.name} on ${n.interface}`).join(', ') || 'none'}), {s.candidate.firewall.rules.length} firewall rule{s.candidate.firewall.rules.length === 1 ? '' : 's'}. Preview the files below to see exactly what it does.
                  </p>
                </div>
              )}
            </Card>
            {(s.errors.length > 0 || s.warnings.length > 0) && (
              <Card title={s.errors.length ? `${s.errors.length} problem${s.errors.length === 1 ? '' : 's'} to fix before a commit` : 'Worth a look'}>
                <IssueList errors={s.errors} warnings={s.warnings} />
              </Card>
            )}
            {admin && (
              <Card title="Commit">
                {pending ? (
                  <Callout tone="warning">Commit {s.confirm!.commitId} is on trial: keep it or roll it back (the banner at the top) before committing again.</Callout>
                ) : (
                  <div className="gt-commit">
                    <Field label="What and why (for the history)">
                      <Input value={comment} maxLength={200} onChange={(e) => setComment(e.target.value)} placeholder="Guest Wi-Fi on VLAN 20" />
                    </Field>
                    <div className="fx-row" style={{ gap: 12, flexWrap: 'wrap' }}>
                      <Toggle checked={trial} onChange={setTrial} label="Trial: undo by itself unless I keep it within" />
                      <Select value={String(minutes)} disabled={!trial} onChange={(e) => setMinutes(Number(e.target.value))} options={['2', '5', '10', '30'].map((m) => ({ value: m, label: `${m} minutes` }))} />
                    </div>
                    <div className="fx-row" style={{ gap: 8 }}>
                      <Button
                        variant="primary"
                        icon="check"
                        disabled={!canCommit}
                        loading={busy === 'commit'}
                        onClick={async () => {
                          if (await act('commit', () => api('POST', '/v1/gate/commit', { comment, confirmMinutes: trial ? minutes : 0 }), trial ? `Committed on trial: keep it within ${minutes} minutes` : 'Committed')) setComment('');
                        }}
                      >
                        Commit
                      </Button>
                      <Button
                        icon="file"
                        onClick={async () => {
                          try {
                            setPreview(await api<Preview>('GET', '/v1/gate/preview'));
                          } catch (e) {
                            toast.error('No preview', (e as Error).message);
                          }
                        }}
                      >
                        Preview the files
                      </Button>
                    </div>
                    {!trial && <p className="fx-secondary gt-hint">Without a trial, a change that cuts you off stays until someone fixes it from the gate's own screen.</p>}
                  </div>
                )}
              </Card>
            )}
            {preview && (
              <Card title="What it turns into" actions={<Button size="sm" variant="ghost" icon="x" aria-label="Close the preview" onClick={() => setPreview(null)} />}>
                <Tabs<PreviewTab>
                  active={previewTab}
                  onChange={setPreviewTab}
                  tabs={[
                    { id: 'nftables', label: 'Firewall (nftables)' },
                    { id: 'dnsmasq', label: 'Addresses & names (dnsmasq)' },
                    { id: 'networkd', label: 'Ports & VLANs (systemd-networkd)' },
                    { id: 'qos', label: 'Traffic priority (tc)' },
                  ]}
                />
                <pre className="gt-pre">
                  {previewTab === 'nftables'
                    ? preview.nftables
                    : previewTab === 'dnsmasq'
                      ? preview.dnsmasq
                      : previewTab === 'networkd'
                        ? preview.networkd.map((f) => `# /etc/systemd/network/${f.name}\n${f.content}`).join('\n')
                        : preview.qos
                          ? `# cake (four lanes)\n${preview.qos.cake.map((c) => `tc ${c.join(' ')}`).join('\n')}\n\n# HTB, where the kernel has no cake\n${preview.qos.htb.commands.map((c) => `tc ${c.join(' ')}`).join('\n')}`
                          : 'Traffic priority is off.'}
                </pre>
              </Card>
            )}
            <Card title="History" subtitle="Every commit, newest first" flush>
              <Table
                rows={history.data?.commits ?? []}
                rowKey={(c) => String(c.id)}
                onRowClick={(c) => setViewing(c)}
                empty={<Empty title="No commits yet" />}
                columns={[
                  { key: 'i', header: '', width: 50, render: (c) => <span className="mono">{c.id}</span> },
                  { key: 'c', header: 'Commit', render: (c) => <div><div className="fx-cell-title">{c.comment || `${c.changes} change${c.changes === 1 ? '' : 's'}`}</div><div className="fx-cell-sub">{c.by} · {timeAgo(c.at)}{c.error ? ` · ${c.error}` : ''}</div></div> },
                  { key: 's', header: 'State', render: (c) => <Status tone={c.id === s.confirm?.commitId ? 'warning' : STATUS_TONE[c.status]}>{STATUS_WORDS[c.status]}</Status> },
                  { key: 'r', header: '', render: (c) => (c.id === runningId ? <span className="fx-badge">Running</span> : null) },
                ]}
              />
            </Card>
            {viewing && (
              <CommitModal
                commit={viewing}
                canRollback={admin && !pending}
                onClose={() => setViewing(null)}
                onRollback={async (m) => {
                  if (await act('rollback', () => api('POST', '/v1/gate/rollback', { to: viewing.id, confirmMinutes: m }), `Back to commit ${viewing.id}${m ? ` (on trial for ${m} minutes)` : ''}`)) setViewing(null);
                }}
              />
            )}
            {text && <TextEditor config={s.candidate} onClose={() => setText(false)} />}
            {dialog}
          </>
        );
      }}
    </GatePage>
  );
}

function CommitModal({ commit, canRollback, onClose, onRollback }: { commit: GateCommit; canRollback: boolean; onClose: () => void; onRollback: (minutes: number) => void }) {
  const cfg = usePoll<{ config: GateConfig }>(`/v1/gate/history/${commit.id}`, 600_000);
  const [trial, setTrial] = useState(true);
  return (
    <Modal
      wide
      title={`Commit ${commit.id}${commit.comment ? `: ${commit.comment}` : ''}`}
      description={`${STATUS_WORDS[commit.status]} · by ${commit.by} ${timeAgo(commit.at)} · ${commit.changes} change${commit.changes === 1 ? '' : 's'}`}
      onClose={onClose}
      footer={
        <>
          {canRollback && commit.status !== 'failed' && (
            <>
              <Toggle checked={trial} onChange={setTrial} label="On trial (5 minutes)" />
              <Button variant="primary" icon="history" onClick={() => onRollback(trial ? 5 : 0)} style={{ marginLeft: 'auto' }}>
                Go back to this
              </Button>
            </>
          )}
          <Button onClick={onClose}>Close</Button>
        </>
      }
    >
      {commit.error && <Callout tone="critical">{commit.error}</Callout>}
      {cfg.data ? <pre className="gt-pre">{JSON.stringify(cfg.data.config, null, 2)}</pre> : <Empty title="Loading…" />}
    </Modal>
  );
}

/** The whole candidate as JSON, for people who prefer that (the fbrx-gate command line works the same way). */
function TextEditor({ config, onClose }: { config: GateConfig; onClose: () => void }) {
  const g = useGate();
  const [value, setValue] = useState(() => JSON.stringify(config, null, 2));
  const [ok, setOk] = useState(true);
  let issues: ReturnType<typeof checkConfig> | null = null;
  try {
    issues = ok ? checkConfig(JSON.parse(value)) : null;
  } catch {
    issues = null;
  }
  return (
    <Modal
      wide
      title="Edit as text"
      description="The whole configuration being edited. On the server, fbrx-gate edit does the same in your editor."
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!ok || !issues?.config} onClick={async () => (await g.save(JSON.parse(value), 'Configuration saved')) && onClose()}>
            Save
          </Button>
        </>
      }
    >
      <JsonEditor value={value} onChange={setValue} rows={22} onValidity={setOk} />
      {issues && <IssueList errors={issues.errors} warnings={issues.warnings} />}
    </Modal>
  );
}
