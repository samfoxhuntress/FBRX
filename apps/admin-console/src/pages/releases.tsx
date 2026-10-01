import { useRef, useState } from 'react';
import { UPDATE_CHANNELS } from '@fbrx/shared';
import { Button, Callout, Card, Empty, Field, Input, Modal, Page, Select, Status, Table, TextArea, Toggle, formatBytes, formatDate, useAction } from '@fbrx/ui';
import { api } from '../api';
import { useApp, useQuery } from '../state';

interface Release {
  id: string;
  version: string;
  channel: string;
  notes: string;
  published: boolean;
  rolloutPct: number;
  createdAt: string;
  publishedAt: string | null;
  files: Array<{ id: string; platform: string; arch: string; kind: string; fileName: string; size: number; sha256: string }>;
}

function guessPlatform(name: string): { platform: string; arch: string } {
  const n = name.toLowerCase();
  const arch = n.includes('arm64') ? 'arm64' : n.includes('universal') ? 'universal' : 'x64';
  if (n.endsWith('.exe') || n.endsWith('.msi') || n.includes('win')) return { platform: 'win32', arch };
  if (n.endsWith('.dmg') || n.endsWith('.zip') || n.includes('mac') || n.includes('darwin')) return { platform: 'darwin', arch };
  return { platform: 'linux', arch };
}

export function ReleasesPage() {
  const app = useApp();
  const manage = app.can('releases.manage');
  const releases = useQuery<Release[]>('/v1/admin/releases');
  const [creating, setCreating] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const current = releases.data?.find((r) => r.id === open) ?? null;
  return (
    <Page
      title="Releases & updates"
      description="Versioned builds of FBRX OS for macOS and Windows. Devices download updates through the control plane according to their channel, pinned version and rollout percentage — snapshot a version, stage it, then roll it out."
      actions={
        manage && (
          <Button variant="primary" icon="plus" onClick={() => setCreating(true)}>
            New release
          </Button>
        )
      }
    >
      {manage && (
        <Callout tone="info" title="Automate from CI">
          The release workflow (<code>.github/workflows/release.yml</code>) builds signed installers on macOS and Windows and runs <code>scripts/publish-release.mjs</code> to upload them here with an API key.
        </Callout>
      )}
      <Card flush>
        <Table
          rows={releases.data ?? []}
          rowKey={(r) => r.id}
          onRowClick={(r) => setOpen(r.id)}
          empty={<Empty title="No releases yet" />}
          columns={[
            { key: 'v', header: 'Version', render: (r) => <span className="fx-cell-title mono">{r.version}</span> },
            { key: 'c', header: 'Channel', render: (r) => <span className="fx-badge">{r.channel}</span> },
            { key: 's', header: 'State', render: (r) => (r.published ? <Status tone="good">Published</Status> : <Status tone="neutral">Draft</Status>) },
            { key: 'r', header: 'Rollout', className: 'num', render: (r) => `${r.rolloutPct}%` },
            { key: 'f', header: 'Files', render: (r) => [...new Set(r.files.map((f) => (f.platform === 'darwin' ? 'macOS' : f.platform === 'win32' ? 'Windows' : 'Linux')))].join(', ') || <span className="fx-muted">none</span> },
            { key: 'd', header: 'Created', render: (r) => formatDate(r.createdAt) },
          ]}
        />
      </Card>
      {creating && <CreateRelease onClose={() => setCreating(false)} onCreated={(id) => (setCreating(false), releases.reload(), setOpen(id))} />}
      {current && <ReleaseDetail r={current} manage={manage} onClose={() => setOpen(null)} onChanged={releases.reload} />}
    </Page>
  );
}

function CreateRelease({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const [f, setF] = useState({ version: '', channel: 'stable', notes: '' });
  const { busy, run } = useAction();
  return (
    <Modal
      title="New release"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            loading={busy === 'c'}
            disabled={!/^\d+\.\d+\.\d+/.test(f.version)}
            onClick={async () => {
              const r = await run('c', () => api<Release>('POST', '/v1/admin/releases', f), 'Release created');
              if (r) onCreated(r.id);
            }}
          >
            Create draft
          </Button>
        </>
      }
    >
      <div className="fx-form">
        <div className="fx-row">
          <Field label="Version">
            <Input value={f.version} onChange={(e) => setF({ ...f, version: e.target.value })} placeholder="1.2.0" autoFocus />
          </Field>
          <Field label="Channel">
            <Select value={f.channel} onChange={(e) => setF({ ...f, channel: e.target.value })} options={[...UPDATE_CHANNELS]} />
          </Field>
        </div>
        <Field label="Release notes">
          <TextArea rows={5} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} />
        </Field>
      </div>
    </Modal>
  );
}

function ReleaseDetail({ r, manage, onClose, onChanged }: { r: Release; manage: boolean; onClose: () => void; onChanged: () => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [rollout, setRollout] = useState(r.rolloutPct);
  const [uploading, setUploading] = useState<string | null>(null);
  const { run } = useAction();
  const patch = (body: unknown, msg: string) => run('p', () => api('PATCH', `/v1/admin/releases/${r.id}`, body).then(onChanged), msg);
  const upload = async (files: FileList | null) => {
    for (const file of Array.from(files ?? [])) {
      const { platform, arch } = guessPlatform(file.name);
      setUploading(file.name);
      await run('u', () => api('POST', `/v1/admin/releases/${r.id}/files?platform=${platform}&arch=${arch}&fileName=${encodeURIComponent(file.name)}`, undefined, { raw: file }), `Uploaded ${file.name}`);
    }
    setUploading(null);
    onChanged();
  };
  return (
    <Modal wide title={`FBRX OS ${r.version}`} description={`${r.channel} channel · ${r.published ? `published ${formatDate(r.publishedAt)}` : 'draft'}`} onClose={onClose} footer={<Button onClick={onClose}>Close</Button>}>
      <div className="fx-form">
        {r.notes && <pre className="fx-code">{r.notes}</pre>}
        <Card title="Artifacts" subtitle="Windows: NSIS .exe · macOS: .zip (updates) and .dmg (install) · include .blockmap files for delta updates" actions={manage && <Button size="sm" icon="upload" loading={!!uploading} onClick={() => fileRef.current?.click()}>{uploading ? `Uploading ${uploading}` : 'Upload files'}</Button>} flush>
          <input ref={fileRef} type="file" multiple hidden onChange={(e) => void upload(e.target.files)} />
          <Table
            rows={r.files}
            rowKey={(f) => f.id}
            empty={<Empty title="No artifacts uploaded" />}
            columns={[
              { key: 'n', header: 'File', render: (f) => <span className="mono">{f.fileName}</span> },
              { key: 'p', header: 'Platform', render: (f) => `${f.platform} · ${f.arch}` },
              { key: 'k', header: 'Use', render: (f) => <span className="fx-badge">{f.kind}</span> },
              { key: 's', header: 'Size', className: 'num', render: (f) => formatBytes(f.size) },
              { key: 'h', header: 'SHA-256', render: (f) => <span className="mono fx-muted" title={f.sha256}>{f.sha256.slice(0, 12)}…</span> },
            ]}
          />
        </Card>
        {manage && (
          <div className="fx-row" style={{ alignItems: 'center' }}>
            <Toggle checked={r.published} onChange={(v) => void patch({ published: v }, v ? 'Release published' : 'Release unpublished')} label={r.published ? 'Published' : 'Publish to devices'} disabled={!r.files.length} />
            <Field label={`Staged rollout: ${rollout}% of devices`}>
              <input type="range" min={0} max={100} step={5} value={rollout} onChange={(e) => setRollout(Number(e.target.value))} onMouseUp={() => void patch({ rolloutPct: rollout }, `Rollout set to ${rollout}%`)} onKeyUp={() => void patch({ rolloutPct: rollout }, `Rollout set to ${rollout}%`)} />
            </Field>
            <Field label="Channel">
              <Select value={r.channel} onChange={(e) => void patch({ channel: e.target.value }, 'Channel changed')} options={[...UPDATE_CHANNELS]} />
            </Field>
          </div>
        )}
      </div>
    </Modal>
  );
}
