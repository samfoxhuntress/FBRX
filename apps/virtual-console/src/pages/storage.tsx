import { useRef, useState } from 'react';
import type { IsoDownload, IsoImage, StoragePool, StorageVolume } from '@fbrx/shared';
import { Button, Callout, Card, Empty, Field, formatBytes, formatDate, Grid, Input, Meter, Modal, Page, Table, Tabs, useAction, useConfirm, useToast } from '@fbrx/ui';
import { api, upload } from '../api';
import { useApp, usePoll } from '../state';
import { gb } from './common';

export function StoragePage() {
  const [tab, setTab] = useState<'isos' | 'pools'>('isos');
  return (
    <Page title="Storage & ISOs" description="Installer images for virtual CD drives, and the storage that holds virtual disks.">
      <Tabs active={tab} onChange={setTab} tabs={[{ id: 'isos', label: 'ISO library' }, { id: 'pools', label: 'Storage pools' }]} />
      {tab === 'isos' ? <IsoLibrary /> : <Pools />}
    </Page>
  );
}

function IsoLibrary() {
  const app = useApp();
  const toast = useToast();
  const { busy, run } = useAction();
  const { confirm, dialog } = useConfirm();
  const data = usePoll<{ isos: Array<IsoImage & { usedBy: string[] }>; downloads: IsoDownload[] }>('/v1/isos', 3000);
  const file = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState<{ name: string; fraction: number; abort: AbortController } | null>(null);
  const [fetchOpen, setFetchOpen] = useState(false);
  const op = app.can('operator');
  const pick = async (f: File) => {
    const name = f.name.replace(/[^A-Za-z0-9._+()-]/g, '-').replace(/^[^A-Za-z0-9]+/, '');
    if (!/\.(iso|img)$/i.test(name)) return toast.error('Choose an .iso or .img file');
    const abort = new AbortController();
    setUploading({ name, fraction: 0, abort });
    try {
      await upload(`/v1/isos/${encodeURIComponent(name)}`, f, (fraction) => setUploading((u) => (u ? { ...u, fraction } : u)), abort.signal);
      toast.success(`${name} added to the library`);
      await data.reload();
    } catch (e) {
      toast.error('Upload failed', (e as Error).message);
    } finally {
      setUploading(null);
    }
  };
  const running = (data.data?.downloads ?? []).filter((d) => d.state === 'running' || d.state === 'failed');
  return (
    <>
      <Card
        title="ISO library"
        subtitle="Operating system installers and tool disks."
        flush
        actions={
          op && (
            <>
              <input ref={file} type="file" accept=".iso,.img" hidden onChange={(e) => e.target.files?.[0] && void pick(e.target.files[0])} />
              <Button icon="upload" disabled={!!uploading} onClick={() => file.current?.click()}>
                Upload
              </Button>
              <Button variant="primary" icon="download" onClick={() => setFetchOpen(true)}>
                Download from the web
              </Button>
            </>
          )
        }
      >
        {uploading && (
          <div style={{ padding: 12 }} className="fx-row">
            <div style={{ flex: 1 }}>
              <Meter label={`Uploading ${uploading.name}`} value={Math.round(uploading.fraction * 100)} />
            </div>
            <Button size="sm" onClick={() => uploading.abort.abort()}>
              Cancel
            </Button>
          </div>
        )}
        {running.map((d) => (
          <div key={d.id} style={{ padding: 12 }} className="fx-row">
            <div style={{ flex: 1 }}>
              {d.state === 'failed' ? (
                <Callout tone="critical" title={`${d.name} did not download`}>
                  {d.error}
                </Callout>
              ) : (
                <Meter label={`Downloading ${d.name} · ${formatBytes(d.received)}${d.total ? ` of ${formatBytes(d.total)}` : ''}`} value={d.total ? Math.round((d.received / d.total) * 100) : 0} />
              )}
            </div>
            {op && (
              <Button size="sm" onClick={() => void run(d.id, async () => { await api('DELETE', `/v1/isos/downloads/${d.id}`); await data.reload(); })}>
                {d.state === 'running' ? 'Cancel' : 'Dismiss'}
              </Button>
            )}
          </div>
        ))}
        <Table
          rows={data.data?.isos ?? []}
          rowKey={(i) => i.name}
          empty={<Empty title={data.data ? 'The library is empty' : 'Loading…'}>{data.data && 'Upload an installer, or have the server download one (Debian, Ubuntu, Windows evaluation…).'}</Empty>}
          columns={[
            { key: 'n', header: 'Name', render: (i) => <span className="fx-cell-title">{i.name}</span> },
            { key: 's', header: 'Size', render: (i) => formatBytes(i.sizeBytes) },
            { key: 'm', header: 'Added', render: (i) => formatDate(i.modifiedAt) },
            { key: 'u', header: 'In the CD drive of', render: (i) => (i.usedBy.length ? i.usedBy.join(', ') : '—') },
            {
              key: 'x',
              header: '',
              render: (i) =>
                op && (
                  <Button
                    size="sm"
                    variant="danger"
                    icon="trash"
                    aria-label={`Delete ${i.name}`}
                    disabled={i.usedBy.length > 0}
                    title={i.usedBy.length ? 'Eject it first' : undefined}
                    loading={busy === i.name}
                    onClick={async () => {
                      if (await confirm({ title: `Delete ${i.name}?`, confirmLabel: 'Delete', danger: true })) await run(i.name, async () => { await api('DELETE', `/v1/isos/${encodeURIComponent(i.name)}`); await data.reload(); });
                    }}
                  />
                ),
            },
          ]}
        />
      </Card>
      {fetchOpen && <FetchIso onClose={() => setFetchOpen(false)} onStarted={() => void data.reload()} />}
      {dialog}
    </>
  );
}

function FetchIso({ onClose, onStarted }: { onClose: () => void; onStarted: () => void }) {
  const { busy, run } = useAction();
  const [url, setUrl] = useState('');
  const [name, setName] = useState('');
  const guess = (u: string) => {
    try {
      const last = decodeURIComponent(new URL(u).pathname.split('/').pop() ?? '');
      if (/\.(iso|img)$/i.test(last)) setName(last.replace(/[^A-Za-z0-9._+()-]/g, '-'));
    } catch {
      /* not yet a URL */
    }
  };
  return (
    <Modal
      title="Download an ISO"
      description="The server downloads it straight into the library (faster than uploading from your computer)."
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" icon="download" loading={busy === 'go'} disabled={!url || !/\.(iso|img)$/i.test(name)} onClick={() => void run('go', async () => { await api('POST', '/v1/isos/download', { url, name }); onStarted(); onClose(); })}>
            Download
          </Button>
        </>
      }
    >
      <div className="fx-form">
        <Field label="Web address of the ISO" help="For example a Debian netinst image from debian.org.">
          <Input value={url} onChange={(e) => { setUrl(e.target.value); guess(e.target.value); }} placeholder="https://…/debian-13-amd64-netinst.iso" />
        </Field>
        <Field label="Save as">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="debian-13-netinst.iso" />
        </Field>
      </div>
    </Modal>
  );
}

function Pools() {
  const app = useApp();
  const pools = usePoll<{ pools: StoragePool[] }>('/v1/storage/pools', 15000);
  const [open, setOpen] = useState<string | null>(null);
  return (
    <>
      <Grid cols={2}>
        {(pools.data?.pools ?? []).map((p) => (
          <Card
            key={p.name}
            title={p.role === 'images' ? 'Virtual disks' : p.role === 'isos' ? 'ISO library' : p.name}
            subtitle={<span className="mono">{p.path ?? p.type}</span>}
            actions={<Button size="sm" onClick={() => setOpen(open === p.name ? null : p.name)}>{open === p.name ? 'Hide files' : 'Files'}</Button>}
          >
            {!p.active && <Callout tone="warning">This pool is not active.</Callout>}
            <Meter label={`${gb(p.allocationGb)} used of ${gb(p.capacityGb)} · ${gb(p.availableGb)} free`} value={p.allocationGb} max={p.capacityGb || 1} />
          </Card>
        ))}
      </Grid>
      {open && <Volumes pool={open} admin={app.can('admin')} />}
    </>
  );
}

function Volumes({ pool, admin }: { pool: string; admin: boolean }) {
  const { busy, run } = useAction();
  const { confirm, dialog } = useConfirm();
  const vols = usePoll<{ volumes: StorageVolume[] }>(`/v1/storage/pools/${encodeURIComponent(pool)}/volumes`, 15000);
  return (
    <Card title={`Files in ${pool}`} flush>
      <Table
        rows={vols.data?.volumes ?? []}
        rowKey={(v) => v.name}
        empty={<Empty title="Empty" />}
        columns={[
          { key: 'n', header: 'Name', render: (v) => <span className="mono">{v.name}</span> },
          { key: 'f', header: 'Format', render: (v) => v.format },
          { key: 's', header: 'Size', render: (v) => `${gb(v.capacityGb)} (${gb(v.allocationGb)} on disk)` },
          { key: 'u', header: 'Used by', render: (v) => (v.usedBy.length ? v.usedBy.join(', ') : <span className="fx-muted">Nothing (orphaned)</span>) },
          {
            key: 'x',
            header: '',
            render: (v) =>
              admin &&
              !v.usedBy.length && (
                <Button
                  size="sm"
                  variant="danger"
                  icon="trash"
                  aria-label={`Delete ${v.name}`}
                  loading={busy === v.name}
                  onClick={async () => {
                    if (await confirm({ title: `Delete ${v.name}?`, body: 'Nothing uses it. It is removed for good.', confirmLabel: 'Delete', danger: true }))
                      await run(v.name, async () => { await api('DELETE', `/v1/storage/pools/${encodeURIComponent(pool)}/volumes/${encodeURIComponent(v.name)}`); await vols.reload(); });
                  }}
                />
              ),
          },
        ]}
      />
      {dialog}
    </Card>
  );
}
