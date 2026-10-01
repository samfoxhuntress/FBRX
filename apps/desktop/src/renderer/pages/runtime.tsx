import { useEffect, useState } from 'react';
import type { DownloadProgress, ProviderConfig, ProviderStatus } from '@fbrx/shared';
import { Button, Callout, Card, Empty, Field, Grid, Input, KeyValue, Modal, Page, Select, Status, Table, Toggle, formatBytes, useAction, useConfirm } from '@fbrx/ui';
import { call, onEvent, pickFile } from '../client';
import { isLocked, useCore } from '../hooks';
import { navigate } from '../app';

export function RuntimePage() {
  const rt = useCore('runtime.status', undefined, ['runtime.changed', 'settings.changed']);
  const installed = useCore('runtime.installed', undefined, ['runtime.download', 'runtime.changed', 'settings.changed']);
  const catalog = useCore('runtime.catalog');
  const providers = useCore('ai.providers', undefined, ['settings.changed', 'runtime.changed', 'policy.changed', 'vault.changed']);
  const settings = useCore('settings.get', undefined, ['settings.changed']);
  const [downloads, setDownloads] = useState<Record<string, DownloadProgress>>({});
  const [editProvider, setEditProvider] = useState<ProviderConfig | null>(null);
  const { confirm, dialog } = useConfirm();
  const { run, busy } = useAction();
  useEffect(() => onEvent('runtime.download', (p) => setDownloads((d) => ({ ...d, [p.modelId]: p }))), []);
  const r = rt.data;
  const locked = settings.data?.locked ?? [];
  const ai = settings.data?.settings.ai;
  const installedIds = new Set((installed.data ?? []).map((m) => m.id));
  return (
    <Page title="AI models" description="Run the agent fully on this computer with the built-in llama.cpp runtime, use Ollama, or connect cloud models such as Claude. Your governance policy decides which providers are allowed.">
      <Grid cols={2}>
        <Card
          title="Built-in local runtime"
          subtitle="Private by design: listens only on 127.0.0.1 with a per-launch key"
          actions={
            r?.state === 'running' ? (
              <Button size="sm" icon="stop" loading={busy === 'stop'} onClick={() => void run('stop', () => call('runtime.stop'))}>
                Stop
              </Button>
            ) : (
              <Button size="sm" variant="primary" icon="play" loading={busy === 'start' || r?.state === 'starting'} disabled={r?.state === 'not-installed' || r?.state === 'no-model' || r?.state === 'disabled'} onClick={() => void run('start', () => call('runtime.start'), 'Local model ready')}>
                Start
              </Button>
            )
          }
        >
          {r && (
            <div className="fx-form">
              <KeyValue
                items={[
                  ['State', <Status tone={r.state === 'running' ? 'good' : r.state === 'failed' ? 'critical' : r.state === 'starting' ? 'busy' : 'neutral'}>{r.state}</Status>],
                  ['Model', r.modelId ?? 'none selected'],
                  ['Runtime binary', r.binaryPath ? <span className="mono" style={{ fontSize: 12 }}>{r.binaryPath}</span> : 'not found'],
                  ['Endpoint', r.endpoint ?? '—'],
                ]}
              />
              {r.message && r.state !== 'running' && <Callout tone={r.state === 'failed' ? 'critical' : 'info'}>{r.message}</Callout>}
              {r.state === 'not-installed' && (
                <div className="fx-actions">
                  {downloads['llama-runtime'] && ['downloading', 'verifying'].includes(downloads['llama-runtime'].state) ? (
                    <Status tone="busy">
                      {downloads['llama-runtime'].state === 'verifying' ? 'Installing…' : `Downloading runtime ${downloads['llama-runtime'].totalBytes ? Math.round((downloads['llama-runtime'].receivedBytes / downloads['llama-runtime'].totalBytes) * 100) : 0}%`}
                    </Status>
                  ) : (
                    <Button size="sm" variant="primary" icon="download" onClick={() => void run('rt', () => call('runtime.installRuntime'))}>
                      Install runtime (llama.cpp)
                    </Button>
                  )}
                  {downloads['llama-runtime']?.state === 'failed' && <span className="fx-error-text">{downloads['llama-runtime'].error}</span>}
                  <Button
                    size="sm"
                    onClick={async () => {
                      const p = await pickFile({ kind: 'file', title: 'Locate llama-server' });
                      if (p) await run('bin', () => call('settings.update', { patch: { runtime: { binaryPath: p } } }), 'Runtime path saved');
                    }}
                  >
                    Locate llama-server…
                  </Button>
                  <span className="fx-muted" style={{ fontSize: 12 }}>Release builds bundle it automatically.</span>
                </div>
              )}
            </div>
          )}
        </Card>
        <Card title="Installed models" actions={<Button size="sm" icon="upload" onClick={async () => { const p = await pickFile({ kind: 'file', title: 'Import a GGUF model', filters: [{ name: 'GGUF model', extensions: ['gguf'] }] }); if (p) await run('imp', () => call('runtime.importModel', { path: p }), 'Model imported'); }}>Import .gguf</Button>} flush>
          <Table
            rows={installed.data ?? []}
            rowKey={(m) => m.id}
            empty={<Empty title="No models yet">Download one from the catalog below.</Empty>}
            columns={[
              { key: 'n', header: 'Model', render: (m) => (<div><div className="fx-cell-title">{m.name}</div><div className="fx-cell-sub">{m.source}</div></div>) },
              { key: 's', header: 'Size', className: 'num', render: (m) => formatBytes(m.sizeBytes) },
              { key: 'a', header: '', render: (m) => (m.active ? <span className="fx-badge accent">Active</span> : <Button size="sm" disabled={isLocked(locked, 'runtime.modelId')} onClick={() => void run('sel', () => call('runtime.selectModel', { modelId: m.id }), `${m.name} selected`)}>Use</Button>) },
              {
                key: 'd',
                header: '',
                render: (m) =>
                  !m.active && (
                    <Button size="sm" variant="ghost" icon="trash" aria-label={`Delete ${m.name}`} onClick={async () => { if (await confirm({ title: `Delete ${m.name}?`, body: `Frees ${formatBytes(m.sizeBytes)}.`, danger: true, confirmLabel: 'Delete' })) await run('del', () => call('runtime.deleteModel', { modelId: m.id })); }} />
                  ),
              },
            ]}
          />
        </Card>
      </Grid>
      <Card title="Model catalog" subtitle="Open-weight models tested with FBRX OS tool calling. Downloads resume if interrupted and are checksummed.">
        <div className="choice-grid">
          {(catalog.data ?? []).map((m) => {
            const dl = downloads[m.id];
            const active = dl && (dl.state === 'downloading' || dl.state === 'verifying');
            return (
              <div key={m.id} className="choice" style={{ cursor: 'default' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                  <strong>{m.name}</strong>
                  <span className="fx-badge">{m.tier}</span>
                </div>
                <span className="fx-secondary" style={{ fontSize: 12.5 }}>{m.description}</span>
                <span className="fx-muted" style={{ fontSize: 12 }}>
                  {m.parameters} · {m.quantization} · {formatBytes(m.sizeBytes)} · {m.license}
                </span>
                {active ? (
                  <div className="fx-form" style={{ gap: 6 }}>
                    <div className="fx-progress" role="progressbar" aria-valuenow={Math.round((dl.receivedBytes / dl.totalBytes) * 100)}>
                      <div style={{ width: `${(dl.receivedBytes / dl.totalBytes) * 100}%` }} />
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
                      <span className="fx-muted">{dl.state === 'verifying' ? 'Verifying…' : `${formatBytes(dl.receivedBytes)} of ${formatBytes(dl.totalBytes)}`}</span>
                      <Button size="sm" variant="ghost" onClick={() => void call('runtime.cancelDownload', { modelId: m.id })}>Cancel</Button>
                    </div>
                  </div>
                ) : installedIds.has(m.id) ? (
                  <Status tone="good">Installed</Status>
                ) : (
                  <div>
                    {dl?.state === 'failed' && <div className="fx-error-text" style={{ marginBottom: 6 }}>{dl.error}</div>}
                    <Button size="sm" icon="download" onClick={() => void run(`dl:${m.id}`, () => call('runtime.download', { modelId: m.id }))}>
                      Download
                    </Button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </Card>
      <Card title="Providers" subtitle="Where the agent's intelligence comes from" flush>
        <Table
          rows={providers.data ?? []}
          rowKey={(p) => p.id}
          columns={[
            { key: 'n', header: 'Provider', render: (p) => (<div><div className="fx-cell-title">{p.name}{ai?.defaultProvider === p.id && <span className="fx-badge accent" style={{ marginLeft: 6 }}>default</span>}</div><div className="fx-cell-sub">{p.cloud ? 'Cloud' : 'On this machine / network'} · {p.type}</div></div>) },
            { key: 's', header: 'Status', render: (p: ProviderStatus) => (!p.enabled ? <Status tone="neutral">Off</Status> : p.blockedByPolicy ? <Status tone="serious">{p.message}</Status> : p.available ? <Status tone="good">Ready</Status> : <Status tone="warning">{p.message ?? 'Unavailable'}</Status>) },
            { key: 'm', header: 'Model', render: (p) => <span className="mono fx-secondary">{p.defaultModel ?? '—'}</span> },
            {
              key: 'x',
              header: '',
              render: (p) => (
                <div className="fx-actions">
                  {ai?.defaultProvider !== p.id && p.enabled && (
                    <Button size="sm" disabled={isLocked(locked, 'ai.defaultProvider')} onClick={() => void run('def', () => call('settings.update', { patch: { ai: { defaultProvider: p.id, defaultModel: '' } } }), `${p.name} is now the default`)}>
                      Make default
                    </Button>
                  )}
                  <Button size="sm" disabled={isLocked(locked, 'ai.providers')} onClick={() => setEditProvider(settings.data!.settings.ai.providers.find((x) => x.id === p.id)!)}>
                    Configure
                  </Button>
                </div>
              ),
            },
          ]}
        />
      </Card>
      <div>
        <Button
          icon="plus"
          disabled={isLocked(locked, 'ai.providers')}
          onClick={() => setEditProvider({ id: `custom-${Date.now().toString(36)}`, type: 'openai-compatible', name: 'Custom (OpenAI-compatible)', enabled: true, baseUrl: 'http://127.0.0.1:1234/v1', cloud: false })}
        >
          Add OpenAI-compatible endpoint (LM Studio, vLLM, LocalAI…)
        </Button>
      </div>
      {editProvider && settings.data && <ProviderEditor provider={editProvider} all={settings.data.settings.ai.providers} onClose={() => setEditProvider(null)} />}
      {dialog}
    </Page>
  );
}

function ProviderEditor({ provider, all, onClose }: { provider: ProviderConfig; all: ProviderConfig[]; onClose: () => void }) {
  const secrets = useCore('vault.list', undefined, ['vault.changed']);
  const [p, setP] = useState<ProviderConfig>(provider);
  const [key, setKey] = useState('');
  const { run, busy } = useAction();
  const isNew = !all.some((x) => x.id === provider.id);
  const save = () =>
    run(
      's',
      async () => {
        if (key && p.apiKeySecret) await call('vault.set', { name: p.apiKeySecret, value: key, kind: 'api-key', description: `${p.name} API key` });
        const providers = isNew ? [...all, p] : all.map((x) => (x.id === p.id ? p : x));
        await call('settings.update', { patch: { ai: { providers } } });
        onClose();
      },
      'Provider saved',
    );
  const needsKey = p.type === 'anthropic' || p.type === 'openai' || (p.type === 'openai-compatible' && p.cloud);
  return (
    <Modal
      title={isNew ? 'Add provider' : `Configure ${provider.name}`}
      onClose={onClose}
      footer={
        <>
          {!isNew && !['local', 'ollama', 'anthropic', 'openai'].includes(p.id) && (
            <Button variant="danger" style={{ marginRight: 'auto' }} onClick={() => void run('d', () => call('settings.update', { patch: { ai: { providers: all.filter((x) => x.id !== p.id) } } }).then(onClose))}>
              Remove
            </Button>
          )}
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy === 's'} onClick={() => void save()}>
            Save
          </Button>
        </>
      }
    >
      <div className="fx-form">
        <Toggle checked={p.enabled} onChange={(v) => setP({ ...p, enabled: v })} label="Enabled" />
        <Field label="Display name">
          <Input value={p.name} onChange={(e) => setP({ ...p, name: e.target.value })} />
        </Field>
        {p.type !== 'local-runtime' && (
          <Field label="Base URL">
            <Input value={p.baseUrl ?? ''} onChange={(e) => setP({ ...p, baseUrl: e.target.value || undefined })} />
          </Field>
        )}
        {p.type !== 'local-runtime' && (
          <Field label="Default model" help={p.type === 'anthropic' ? 'Recommended: claude-opus-5-5' : p.type === 'ollama' ? 'e.g. qwen3:8b (ollama pull first)' : undefined}>
            <Input value={p.defaultModel ?? ''} onChange={(e) => setP({ ...p, defaultModel: e.target.value || undefined })} />
          </Field>
        )}
        {p.type === 'openai-compatible' && <Toggle checked={p.cloud} onChange={(v) => setP({ ...p, cloud: v })} label="This endpoint is a cloud service (subject to the cloud AI policy)" />}
        {(needsKey || p.apiKeySecret) && (
          <>
            <Field label="API key secret" help="Name of the vault credential holding the key">
              <Select value={p.apiKeySecret ?? ''} onChange={(e) => setP({ ...p, apiKeySecret: e.target.value || undefined })} options={[{ value: '', label: 'None' }, ...Array.from(new Set([...(secrets.data ?? []).map((s) => s.name), ...(p.apiKeySecret ? [p.apiKeySecret] : [])])).map((n) => ({ value: n, label: n }))]} />
            </Field>
            {p.apiKeySecret && !(secrets.data ?? []).find((s) => s.name === p.apiKeySecret)?.managed && (
              <Field label={`Set ${p.apiKeySecret} (optional)`} help="Stored encrypted in your vault, never in settings">
                <Input type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder="Paste the API key" autoComplete="off" />
              </Field>
            )}
          </>
        )}
        {p.cloud && <Callout tone="info">Requests to cloud providers leave this machine. Your organisation can disable cloud AI in the governance policy. <a href="#/governance" onClick={() => navigate('governance')}>Policy</a></Callout>}
      </div>
    </Modal>
  );
}
