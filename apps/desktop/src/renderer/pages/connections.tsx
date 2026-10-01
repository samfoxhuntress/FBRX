import { useState } from 'react';
import type { ConnectorInfo, ConnectorTypeInfo } from '@fbrx/shared';
import { Button, Callout, Card, Empty, Field, Grid, Input, JsonEditor, Modal, Page, Select, Status, Table, Toggle, timeAgo, useAction, useConfirm } from '@fbrx/ui';
import { call } from '../client';
import { useCore } from '../hooks';
import { navigate } from '../app';

const TYPE_ICON: Record<string, string> = { rest: 'REST', 'mcp-stdio': 'MCP', 'mcp-http': 'MCP', webhook: 'HOOK', 'fbrx-peer': 'PEER' };

export function ConnectionsPage() {
  const { data, reload } = useCore('connectors.list', undefined, ['connectors.changed']);
  const types = useCore('connectors.types');
  const [edit, setEdit] = useState<{ type: ConnectorTypeInfo; existing?: ConnectorInfo } | null>(null);
  const [choosing, setChoosing] = useState(false);
  const { confirm, dialog } = useConfirm();
  const { run, busy } = useAction();
  return (
    <Page
      title="Connections"
      description="Connect FBRX to your other applications. Each connection becomes a set of governed tools for the agent: REST APIs, Model Context Protocol (MCP) servers, outgoing webhooks, and other FBRX OS workstations."
      actions={
        <Button variant="primary" icon="plus" onClick={() => setChoosing(true)}>
          New connection
        </Button>
      }
    >
      <Card flush>
        <Table
          rows={data ?? []}
          rowKey={(c) => c.id}
          empty={<Empty title="No connections yet" action={<Button onClick={() => setChoosing(true)}>Connect an app</Button>}>Credentials stay in your vault; connections only reference them by name.</Empty>}
          columns={[
            { key: 'n', header: 'Connection', render: (c) => (<div><div className="fx-cell-title">{c.name}</div><div className="fx-cell-sub">{types.data?.find((t) => t.type === c.type)?.title ?? c.type}</div></div>) },
            { key: 's', header: 'State', render: (c) => (c.state === 'connected' ? <Status tone="good">Connected</Status> : c.state === 'error' ? <Status tone="critical">{c.message ?? 'Error'}</Status> : c.enabled ? <Status tone="neutral">Disconnected</Status> : <Status tone="neutral">Off</Status>) },
            { key: 't', header: 'Tools', render: (c) => (c.tools.length ? <span className="fx-secondary">{c.tools.length} · {c.tools.slice(0, 3).join(', ')}{c.tools.length > 3 ? '…' : ''}</span> : '—') },
            { key: 'u', header: 'Updated', render: (c) => timeAgo(c.updatedAt) },
            { key: 'e', header: 'Enabled', render: (c) => <Toggle checked={c.enabled} onChange={(v) => void run('e', () => call('connectors.update', { id: c.id, patch: { enabled: v } }).then(reload))} /> },
            {
              key: 'x',
              header: '',
              render: (c) => (
                <div className="fx-actions">
                  <Button
                    size="sm"
                    loading={busy === `test:${c.id}`}
                    onClick={async () => {
                      const r = await run(`test:${c.id}`, () => call('connectors.test', { id: c.id }));
                      if (r) await confirm({ title: r.ok ? 'Connection works' : 'Connection failed', body: <div><p>{r.message}</p>{r.tools.length > 0 && <p className="fx-secondary">Tools: {r.tools.join(', ')}</p>}</div>, confirmLabel: 'OK' });
                    }}
                  >
                    Test
                  </Button>
                  <Button size="sm" onClick={() => setEdit({ type: types.data!.find((t) => t.type === c.type)!, existing: c })}>
                    Edit
                  </Button>
                  <Button
                    size="sm"
                    variant="danger"
                    onClick={async () => {
                      if (await confirm({ title: `Remove ${c.name}?`, body: 'Its tools disappear from the agent immediately.', danger: true, confirmLabel: 'Remove' })) await run('d', () => call('connectors.delete', { id: c.id }).then(reload), 'Connection removed');
                    }}
                  >
                    Remove
                  </Button>
                </div>
              ),
            },
          ]}
        />
      </Card>
      {choosing && types.data && (
        <Modal wide title="What do you want to connect?" onClose={() => setChoosing(false)} footer={<Button onClick={() => setChoosing(false)}>Cancel</Button>}>
          <div className="choice-grid">
            {types.data.map((t) => (
              <button
                key={t.type}
                className="choice"
                onClick={() => {
                  setChoosing(false);
                  setEdit({ type: t });
                }}
              >
                <span className="fx-badge accent" style={{ alignSelf: 'flex-start' }}>{TYPE_ICON[t.type]}</span>
                <strong>{t.title}</strong>
                <span className="fx-secondary" style={{ fontSize: 13 }}>{t.description}</span>
              </button>
            ))}
          </div>
        </Modal>
      )}
      {edit && <ConnectorEditor type={edit.type} existing={edit.existing} onClose={() => setEdit(null)} onSaved={() => (setEdit(null), reload())} />}
      {dialog}
    </Page>
  );
}

function ConnectorEditor({ type, existing, onClose, onSaved }: { type: ConnectorTypeInfo; existing?: ConnectorInfo; onClose: () => void; onSaved: () => void }) {
  const secrets = useCore('vault.list', undefined, ['vault.changed']);
  const [name, setName] = useState(existing?.name ?? '');
  const [values, setValues] = useState<Record<string, unknown>>(() => {
    const v: Record<string, unknown> = { ...(existing?.config ?? {}) };
    for (const f of type.fields) {
      if (f.kind === 'json' && v[f.key] !== undefined && typeof v[f.key] !== 'string') v[f.key] = JSON.stringify(v[f.key], null, 2);
      if (f.kind === 'select' && v[f.key] === undefined) v[f.key] = f.options?.[0];
    }
    return v;
  });
  const [jsonOk, setJsonOk] = useState<Record<string, boolean>>({});
  const { run, busy } = useAction();
  const set = (k: string, v: unknown) => setValues((x) => ({ ...x, [k]: v }));
  const save = () => {
    const config: Record<string, unknown> = {};
    for (const f of type.fields) {
      const v = values[f.key];
      if (v === undefined || v === '') continue;
      config[f.key] = f.kind === 'json' && typeof v === 'string' ? JSON.parse(v) : v;
    }
    return run('s', () => (existing ? call('connectors.update', { id: existing.id, patch: { name, config } }) : call('connectors.create', { name, type: type.type, config })).then(onSaved), existing ? 'Connection updated' : 'Connection added');
  };
  const missing = type.fields.some((f) => f.required && (values[f.key] === undefined || values[f.key] === ''));
  return (
    <Modal
      wide
      title={existing ? `Edit ${existing.name}` : `Connect: ${type.title}`}
      description={type.description}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy === 's'} disabled={!name.trim() || missing || Object.values(jsonOk).includes(false)} onClick={() => void save()}>
            {existing ? 'Save' : 'Connect'}
          </Button>
        </>
      }
    >
      <div className="fx-form">
        <Field label="Name" help="Also becomes the tool prefix the agent sees (e.g. crm.get)">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="CRM" autoFocus />
        </Field>
        <Grid cols={2}>
          {type.fields.map((f) => (
            <div key={f.key} style={{ gridColumn: f.kind === 'json' || f.kind === 'textarea' ? '1 / -1' : undefined }}>
              <Field label={`${f.label}${f.required ? '' : ' (optional)'}`} help={f.help}>
                {f.kind === 'boolean' ? (
                  <Toggle checked={!!values[f.key]} onChange={(v) => set(f.key, v)} />
                ) : f.kind === 'select' ? (
                  <Select value={String(values[f.key] ?? '')} onChange={(e) => set(f.key, e.target.value)} options={f.options ?? []} />
                ) : f.kind === 'secret-ref' ? (
                  <div style={{ display: 'flex', gap: 8 }}>
                    <Select value={String(values[f.key] ?? '')} onChange={(e) => set(f.key, e.target.value)} options={[{ value: '', label: 'None' }, ...(secrets.data ?? []).map((s) => ({ value: s.name, label: s.name }))]} />
                    <Button size="sm" onClick={() => navigate('vault')}>Vault</Button>
                  </div>
                ) : f.kind === 'json' ? (
                  <JsonEditor value={String(values[f.key] ?? '')} onChange={(v) => set(f.key, v)} rows={5} onValidity={(ok) => setJsonOk((j) => (j[f.key] === ok ? j : { ...j, [f.key]: ok }))} />
                ) : (
                  <Input value={String(values[f.key] ?? '')} onChange={(e) => set(f.key, e.target.value)} placeholder={f.placeholder} />
                )}
              </Field>
            </div>
          ))}
        </Grid>
        {type.type === 'mcp-stdio' && <Callout tone="warning">Local MCP servers run as programs on this computer with your permissions. Their tools default to "write" risk so the agent asks before using them.</Callout>}
      </div>
    </Modal>
  );
}
