import { useMemo, useState } from 'react';
import type { ToolInfo, ToolInvokeResult } from '@fbrx/shared';
import { Button, Callout, Card, Empty, Field, Input, JsonEditor, Modal, Page, Select, Status, Table, Tabs, Toggle, formatDate, useAction, useConfirm } from '@fbrx/ui';
import { call, pickFile } from '../client';
import { useCore } from '../hooks';

const RISK_TONE = { read: 'good', network: 'info', write: 'warning', execute: 'serious', sensitive: 'critical' } as const;

function exampleInput(schema: Record<string, any>): string {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries((schema.properties ?? {}) as Record<string, any>)) {
    if (!(schema.required ?? []).includes(k) && v.default === undefined) continue;
    out[k] = v.default ?? (v.type === 'number' || v.type === 'integer' ? 0 : v.type === 'boolean' ? false : v.type === 'object' ? {} : v.type === 'array' ? [] : '');
  }
  return JSON.stringify(out, null, 2);
}

export function ToolsPage() {
  const [tab, setTab] = useState<'tools' | 'plugins'>('tools');
  return (
    <Page title="Tools & plugins" description="Everything the agent can do. Each tool has a risk level; your governance policy decides whether it runs freely, asks first, or is blocked.">
      <Tabs active={tab} onChange={setTab} tabs={[{ id: 'tools', label: 'Tools' }, { id: 'plugins', label: 'Plugins' }]} />
      {tab === 'tools' ? <ToolsTab /> : <PluginsTab />}
    </Page>
  );
}

function ToolsTab() {
  const { data, reload } = useCore('tools.list', undefined, ['tools.changed', 'policy.changed']);
  const [filter, setFilter] = useState('');
  const [source, setSource] = useState('');
  const [runTool, setRunTool] = useState<ToolInfo | null>(null);
  const { run } = useAction();
  const rows = useMemo(
    () => (data ?? []).filter((t) => (!source || t.source === source) && (!filter || `${t.name} ${t.title} ${t.description}`.toLowerCase().includes(filter.toLowerCase()))),
    [data, filter, source],
  );
  return (
    <>
      <div className="fx-row">
        <div style={{ flex: 2, minWidth: 220 }}>
          <Input placeholder="Search tools…" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Search tools" />
        </div>
        <div style={{ width: 200 }}>
          <Select aria-label="Source" value={source} onChange={(e) => setSource(e.target.value)} options={[{ value: '', label: 'All sources' }, { value: 'builtin', label: 'Built-in' }, { value: 'plugin', label: 'Plugins' }, { value: 'connector', label: 'Connections' }]} />
        </div>
      </div>
      <Card flush>
        <Table
          rows={rows}
          rowKey={(t) => t.name}
          empty={<Empty title="No tools match" />}
          columns={[
            { key: 'n', header: 'Tool', render: (t) => (<div><div className="fx-cell-title">{t.title}</div><div className="fx-cell-sub"><span className="mono">{t.name}</span> · {t.description.slice(0, 110)}{t.description.length > 110 ? '…' : ''}</div></div>) },
            { key: 's', header: 'Source', render: (t) => <span className="fx-badge">{t.source}</span> },
            { key: 'r', header: 'Risk', render: (t) => <Status tone={RISK_TONE[t.risk]}>{t.risk}</Status> },
            { key: 'p', header: 'Policy', render: (t) => (t.policyAction === 'allow' ? <Status tone="good">Runs freely</Status> : t.policyAction === 'ask' ? <Status tone="warning">Asks first</Status> : <Status tone="critical">Blocked</Status>) },
            { key: 'e', header: 'Enabled', render: (t) => <Toggle checked={t.enabled} onChange={(v) => void run('t', () => call('tools.setEnabled', { name: t.name, enabled: v }).then(reload))} /> },
            { key: 'x', header: '', render: (t) => <Button size="sm" icon="play" disabled={!t.enabled || t.policyAction === 'deny'} onClick={() => setRunTool(t)}>Run</Button> },
          ]}
        />
      </Card>
      {runTool && <RunToolModal tool={runTool} onClose={() => setRunTool(null)} />}
    </>
  );
}

function RunToolModal({ tool, onClose }: { tool: ToolInfo; onClose: () => void }) {
  const [input, setInput] = useState(exampleInput(tool.inputSchema));
  const [valid, setValid] = useState(true);
  const [result, setResult] = useState<ToolInvokeResult | null>(null);
  const { run, busy } = useAction();
  return (
    <Modal
      wide
      title={`Run ${tool.title}`}
      description="You are running this directly, so it counts as your approval. Safety constraints in your policy still apply and the call is audited."
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Close</Button>
          <Button variant="primary" icon="play" loading={busy === 'r'} disabled={!valid} onClick={async () => setResult((await run('r', () => call('tools.invoke', { name: tool.name, input: input.trim() ? JSON.parse(input) : {} }))) ?? null)}>
            Run
          </Button>
        </>
      }
    >
      <div className="fx-form">
        <Field label="Input (JSON)" help={<details><summary>Input schema</summary><pre className="fx-code">{JSON.stringify(tool.inputSchema, null, 2)}</pre></details>}>
          <JsonEditor value={input} onChange={setInput} rows={8} onValidity={setValid} />
        </Field>
        {result && (
          <Field label={<span>Result · {result.ok ? <Status tone="good">ok</Status> : <Status tone="critical">failed</Status>} · {result.durationMs} ms</span>}>
            <pre className="fx-code">{result.output}</pre>
          </Field>
        )}
      </div>
    </Modal>
  );
}

function PluginsTab() {
  const { data, reload } = useCore('plugins.list', undefined, ['plugins.changed']);
  const license = useCore('license.status', undefined, ['license.changed']);
  const { confirm, dialog } = useConfirm();
  const { run, busy } = useAction();
  const install = async (kind: 'folder' | 'file') => {
    const path = await pickFile(kind === 'folder' ? { kind: 'folder', title: 'Choose a plugin folder (contains fbrx-plugin.json)' } : { kind: 'file', title: 'Choose a plugin package', filters: [{ name: 'Plugin package', extensions: ['tgz', 'gz'] }] });
    if (!path) return;
    if (!(await confirm({ title: 'Install this plugin?', body: 'Plugins run in a sandboxed process and can only use the permissions their manifest declares. Only install plugins you trust.', confirmLabel: 'Install' }))) return;
    await run('i', () => call('plugins.install', { path }).then(reload), 'Plugin installed');
  };
  const unlicensed = license.data && !license.data.features.includes('plugins');
  return (
    <>
      {unlicensed && <Callout tone="warning" title="Plugins are not included in your license">Upgrade to Pro or Enterprise, or enroll with your organisation, to install plugins.</Callout>}
      <div className="fx-actions">
        <Button icon="file" loading={busy === 'i'} disabled={!!unlicensed} onClick={() => void install('file')}>
          Install package (.tgz)
        </Button>
        <Button icon="plus" disabled={!!unlicensed} onClick={() => void install('folder')}>
          Install from folder
        </Button>
      </div>
      <Card flush>
        <Table
          rows={data ?? []}
          rowKey={(p) => p.id}
          empty={<Empty title="No plugins installed">Build your own with @fbrx/plugin-sdk — see docs/PLUGINS.md — or get them from your organisation.</Empty>}
          columns={[
            { key: 'n', header: 'Plugin', render: (p) => (<div><div className="fx-cell-title">{p.name} <span className="mono fx-muted">{p.version}</span></div><div className="fx-cell-sub">{p.description || p.id}</div></div>) },
            { key: 's', header: 'State', render: (p) => (p.state === 'running' ? <Status tone="good">Running</Status> : p.state === 'failed' ? <Status tone="critical">{p.error ?? 'Failed'}</Status> : p.state === 'incompatible' ? <Status tone="warning">{p.error}</Status> : <Status tone="neutral">Stopped</Status>) },
            { key: 't', header: 'Tools', render: (p) => <span className="fx-secondary">{p.tools.length ? p.tools.join(', ') : '—'}</span> },
            { key: 'p', header: 'Permissions', render: (p) => p.permissions.map((x) => <span key={x} className="fx-badge" style={{ margin: '0 4px 4px 0' }}>{x}</span>) },
            { key: 'i', header: 'Installed', render: (p) => formatDate(p.installedAt) },
            { key: 'e', header: 'Enabled', render: (p) => <Toggle checked={p.enabled} onChange={(v) => void run('e', () => call('plugins.setEnabled', { id: p.id, enabled: v }).then(reload))} /> },
            {
              key: 'x',
              header: '',
              render: (p) => (
                <div className="fx-actions">
                  <Button size="sm" variant="ghost" icon="refresh" aria-label="Reload" onClick={() => void run('r', () => call('plugins.reload', { id: p.id }).then(reload), 'Plugin reloaded')} />
                  <Button
                    size="sm"
                    variant="danger"
                    onClick={async () => {
                      if (await confirm({ title: `Uninstall ${p.name}?`, body: 'Its stored data is removed too.', danger: true, confirmLabel: 'Uninstall' })) await run('u', () => call('plugins.uninstall', { id: p.id }).then(reload), 'Plugin removed');
                    }}
                  >
                    Uninstall
                  </Button>
                </div>
              ),
            },
          ]}
        />
      </Card>
      {dialog}
    </>
  );
}
