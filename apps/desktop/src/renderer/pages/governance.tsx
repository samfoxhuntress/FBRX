import { useEffect, useState } from 'react';
import { POLICY_ACTIONS, RISK_LEVELS, type AuditEntry, type Policy } from '@fbrx/shared';
import { Button, Callout, Card, Empty, Field, Grid, Input, JsonEditor, Modal, Page, Select, Status, Table, Tabs, TextArea, Toggle, formatDate, useAction } from '@fbrx/ui';
import { call } from '../client';
import { useCore } from '../hooks';

const ACTION_LABEL = { allow: 'Run freely', ask: 'Ask me first', deny: 'Block' } as const;

export function GovernancePage() {
  const [tab, setTab] = useState<'policy' | 'audit'>('policy');
  return (
    <Page title="Governance" description="The rules every tool call must pass: your policy, an independent guardian reviewer, human approvals, rate limits and a tamper-evident audit log.">
      <Tabs active={tab} onChange={setTab} tabs={[{ id: 'policy', label: 'Policy' }, { id: 'audit', label: 'Audit log' }]} />
      {tab === 'policy' ? <PolicyTab /> : <AuditTab />}
    </Page>
  );
}

function PolicyTab() {
  const eff = useCore('governance.policy', undefined, ['policy.changed']);
  const [draft, setDraft] = useState<Policy | null>(null);
  const [json, setJson] = useState<string | null>(null);
  const [jsonOk, setJsonOk] = useState(true);
  const { run, busy } = useAction();
  useEffect(() => {
    if (eff.data) setDraft(structuredClone(eff.data.policy));
  }, [eff.data]);
  if (!eff.data || !draft) return null;
  const managed = eff.data.source === 'managed';
  const p = draft;
  const upd = (fn: (x: Policy) => void) => {
    const next = structuredClone(p);
    fn(next);
    setDraft(next);
  };
  const dirty = JSON.stringify(p) !== JSON.stringify(eff.data.policy);
  const save = (policy: Policy) => run('save', () => call('governance.updatePolicy', { policy }), 'Policy saved');
  const lines = (v: string[]) => v.join('\n');
  const parse = (v: string) => v.split('\n').map((x) => x.trim()).filter(Boolean);
  return (
    <>
      {managed && <Callout tone="info" title="Managed by your organization">This policy comes from your control plane and can only be changed by an administrator.</Callout>}
      <Grid cols={2}>
        <Card title="Defaults by risk" subtitle="What happens when no specific rule matches">
          <div className="fx-form">
            <Field label="Mode" help="Audit mode records rule violations without blocking (safety limits still apply)">
              <Select disabled={managed} value={p.mode} onChange={(e) => upd((x) => (x.mode = e.target.value as Policy['mode']))} options={[{ value: 'enforce', label: 'Enforce' }, { value: 'audit', label: 'Audit only' }]} />
            </Field>
            {RISK_LEVELS.map((r) => (
              <Field key={r} label={`${r[0].toUpperCase()}${r.slice(1)} tools`}>
                <Select disabled={managed} value={p.riskDefaults[r]} onChange={(e) => upd((x) => (x.riskDefaults[r] = e.target.value as Policy['defaultAction']))} options={POLICY_ACTIONS.map((a) => ({ value: a, label: ACTION_LABEL[a] }))} />
              </Field>
            ))}
          </div>
        </Card>
        <Card title="Files, network and shell">
          <div className="fx-form">
            <Field label="Folders the agent may use" help="One per line. ${HOME}, ${DOCUMENTS}, ${DESKTOP}, ${DOWNLOADS}, ${WORKSPACE} expand per machine">
              <TextArea code rows={3} disabled={managed} value={lines(p.filesystem.allowedRoots)} onChange={(e) => upd((x) => (x.filesystem.allowedRoots = parse(e.target.value)))} />
            </Field>
            <Toggle disabled={managed} checked={p.filesystem.readOnly} onChange={(v) => upd((x) => (x.filesystem.readOnly = v))} label="Read-only filesystem" />
            <Field label="Allowed web domains" help="One per line; * allows all, *.example.com allows subdomains">
              <TextArea code rows={2} disabled={managed} value={lines(p.network.allowedDomains)} onChange={(e) => upd((x) => (x.network.allowedDomains = parse(e.target.value)))} />
            </Field>
            <Field label="Blocked web domains">
              <TextArea code rows={2} disabled={managed} value={lines(p.network.blockedDomains)} onChange={(e) => upd((x) => (x.network.blockedDomains = parse(e.target.value)))} />
            </Field>
            <Toggle disabled={managed} checked={p.network.allowPrivateNetworks} onChange={(v) => upd((x) => (x.network.allowPrivateNetworks = v))} label="Allow private network addresses (intranet, localhost)" />
            <Toggle disabled={managed} checked={p.shell.enabled} onChange={(v) => upd((x) => (x.shell.enabled = v))} label="Allow shell commands" />
          </div>
        </Card>
        <Card title="AI and approvals">
          <div className="fx-form">
            <Toggle disabled={managed} checked={p.ai.allowCloudProviders} onChange={(v) => upd((x) => (x.ai.allowCloudProviders = v))} label="Allow cloud AI providers" />
            <Toggle disabled={managed} checked={p.ai.guardianModelReview} onChange={(v) => upd((x) => (x.ai.guardianModelReview = v))} label="Guardian also asks an AI model to review risky calls" />
            <Toggle disabled={managed} checked={p.data.redactSecrets} onChange={(v) => upd((x) => (x.data.redactSecrets = v))} label="Redact credentials from tool output" />
            <Toggle disabled={managed} checked={p.approvals.allowRemember} onChange={(v) => upd((x) => (x.approvals.allowRemember = v))} label='Allow "Always allow" on approvals' />
            <div className="fx-row">
              <Field label="Max steps per task">
                <Input type="number" disabled={managed} value={p.ai.maxStepsPerRun} onChange={(e) => upd((x) => (x.ai.maxStepsPerRun = Number(e.target.value)))} />
              </Field>
              <Field label="Approval timeout (s)">
                <Input type="number" disabled={managed} value={p.approvals.timeoutSeconds} onChange={(e) => upd((x) => (x.approvals.timeoutSeconds = Number(e.target.value)))} />
              </Field>
              <Field label="Tool calls / minute">
                <Input type="number" disabled={managed} value={p.rateLimits.toolCallsPerMinute} onChange={(e) => upd((x) => (x.rateLimits.toolCallsPerMinute = Number(e.target.value)))} />
              </Field>
            </div>
          </div>
        </Card>
        <Card title="Rules" subtitle="Evaluated first, top to bottom" actions={!managed && <Button size="sm" onClick={() => setJson(JSON.stringify(p, null, 2))}>Edit as JSON</Button>} flush>
          <Table
            rows={[...p.rules, ...eff.data.rememberedRules]}
            rowKey={(r) => r.id}
            empty={<Empty title="No rules" />}
            columns={[
              { key: 'm', header: 'Matches', render: (r) => <span className="mono">{[r.match.tool ?? '*', r.match.source, r.match.risk].filter(Boolean).join(' · ')}</span> },
              { key: 'a', header: 'Action', render: (r) => (r.action === 'allow' ? <Status tone="good">Allow</Status> : r.action === 'ask' ? <Status tone="warning">Ask</Status> : <Status tone="critical">Block</Status>) },
              { key: 'd', header: 'Note', render: (r) => <span className="fx-secondary">{r.description ?? ''}</span> },
              {
                key: 'x',
                header: '',
                render: (r) => (eff.data!.rememberedRules.some((x) => x.id === r.id) ? <Button size="sm" variant="ghost" onClick={() => void run('rr', () => call('governance.removeRememberedRule', { id: r.id }), 'Rule removed')}>Forget</Button> : null),
              },
            ]}
          />
        </Card>
      </Grid>
      {!managed && (
        <div className="fx-actions">
          <Button variant="primary" loading={busy === 'save'} disabled={!dirty} onClick={() => void save(p)}>
            Save policy
          </Button>
          <Button disabled={!dirty} onClick={() => setDraft(structuredClone(eff.data!.policy))}>
            Discard changes
          </Button>
        </div>
      )}
      {json !== null && (
        <Modal
          wide
          title="Edit policy JSON"
          onClose={() => setJson(null)}
          footer={
            <>
              <Button onClick={() => setJson(null)}>Cancel</Button>
              <Button variant="primary" disabled={!jsonOk} onClick={async () => (await save(JSON.parse(json))) && setJson(null)}>
                Save
              </Button>
            </>
          }
        >
          <JsonEditor value={json} onChange={setJson} rows={24} onValidity={setJsonOk} />
        </Modal>
      )}
    </>
  );
}

function AuditTab() {
  const [category, setCategory] = useState('');
  const [outcome, setOutcome] = useState('');
  const [search, setSearch] = useState('');
  const q = { limit: 300, ...(category ? { category } : {}), ...(outcome ? { outcome: outcome as AuditEntry['outcome'] } : {}), ...(search ? { search } : {}) };
  const entries = useCore('audit.query', q, ['audit.appended']);
  const stats = useCore('audit.stats', undefined, ['audit.appended']);
  const [verify, setVerify] = useState<{ ok: boolean; checked: number; message: string } | null>(null);
  const [view, setView] = useState<AuditEntry | null>(null);
  const { run, busy } = useAction();
  return (
    <>
      {verify && <Callout tone={verify.ok ? 'good' : 'critical'} title={verify.ok ? 'Audit log intact' : 'Tampering detected'}>{verify.message}</Callout>}
      <div className="fx-row">
        <div style={{ width: 200 }}>
          <Select aria-label="Category" value={category} onChange={(e) => setCategory(e.target.value)} options={[{ value: '', label: 'All categories' }, ...Object.keys(stats.data?.byCategory ?? {}).map((c) => ({ value: c, label: c }))]} />
        </div>
        <div style={{ width: 170 }}>
          <Select aria-label="Outcome" value={outcome} onChange={(e) => setOutcome(e.target.value)} options={[{ value: '', label: 'Any outcome' }, 'success', 'denied', 'failure', 'info']} />
        </div>
        <div style={{ flex: 1, minWidth: 200 }}>
          <Input placeholder="Search…" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <Button icon="shield" loading={busy === 'v'} onClick={async () => setVerify((await run('v', () => call('audit.verify'))) ?? null)}>
          Verify integrity
        </Button>
      </div>
      <Card flush>
        <Table
          rows={entries.data ?? []}
          rowKey={(e) => String(e.seq)}
          onRowClick={setView}
          empty={<Empty title="No entries" />}
          columns={[
            { key: 's', header: '#', className: 'num', render: (e) => e.seq },
            { key: 't', header: 'When', render: (e) => formatDate(e.ts) },
            { key: 'c', header: 'Event', render: (e) => <span className="mono">{e.category}/{e.action}</span> },
            { key: 'a', header: 'Actor', render: (e) => e.actor },
            { key: 'o', header: 'Outcome', render: (e) => <Status tone={e.outcome === 'success' ? 'good' : e.outcome === 'denied' ? 'serious' : e.outcome === 'failure' ? 'critical' : 'neutral'}>{e.outcome}</Status> },
          ]}
        />
      </Card>
      {view && (
        <Modal wide title={`#${view.seq} ${view.category}/${view.action}`} onClose={() => setView(null)} footer={<Button onClick={() => setView(null)}>Close</Button>}>
          <pre className="fx-code">{JSON.stringify(view, null, 2)}</pre>
        </Modal>
      )}
    </>
  );
}
