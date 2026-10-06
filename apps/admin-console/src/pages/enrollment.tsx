import { useState } from 'react';
import { compareSemver, isLearner, macProfile, windowsScript, type Audience } from '@fbrx/shared';
import { Button, Callout, Card, CopyText, Empty, Field, Input, Modal, Page, Select, Status, Table, formatDate, timeAgo, useAction, useConfirm } from '@fbrx/ui';
import { api, saveBlob } from '../api';
import { useApp, useQuery } from '../state';
import { LearnerBadge, audienceHelp, audienceOptions } from './common';

const uuid = () => (globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`).toUpperCase();

interface Token {
  id: string;
  label: string;
  prefix: string;
  groupId: string | null;
  maxUses: number | null;
  uses: number;
  expiresAt: string | null;
  createdAt: string;
  revokedAt: string | null;
  templateSnapshotId: string | null;
  audience: Audience | null;
}
interface Created extends Token {
  token: string;
  provisioning: Record<string, unknown>;
}
interface Release {
  id: string;
  version: string;
  channel: string;
  published: boolean;
  files: Array<{ platform: string; fileName: string; kind: string; size: number }>;
}

export function EnrollmentPage() {
  const app = useApp();
  const organization = app.me.tenants.find((t) => t.id === app.tenantId)?.name ?? 'Your organization';
  const tokens = useQuery<Token[]>('/v1/admin/enrollment-tokens');
  const groups = useQuery<Array<{ id: string; name: string }>>('/v1/admin/groups').data ?? [];
  const snapshots = useQuery<Array<{ id: string; deviceName: string; label: string | null; createdAt: string }>>('/v1/admin/snapshots').data ?? [];
  const releases = useQuery<Release[]>('/v1/admin/releases').data ?? [];
  const system = useQuery<{ publicUrl: string; certificate: { fingerprint: string; selfSigned: boolean } | null }>('/v1/admin/system').data;
  // The address other computers use (this page may be open on FBRX Command's own computer at 127.0.0.1).
  const address = system?.publicUrl ?? location.origin;
  const pin = system?.certificate?.selfSigned ? system.certificate.fingerprint : null;
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<Created | null>(null);
  const { confirm, dialog } = useConfirm();
  const { run } = useAction();
  const latest = releases.filter((r) => r.published && r.channel === 'stable').sort((a, b) => compareSemver(b.version, a.version))[0];
  const latestWin = latest?.files.find((f) => f.platform === 'win32' && f.fileName.endsWith('.exe'))?.fileName ?? null;

  const state = (t: Token) => {
    if (t.revokedAt) return <Status tone="neutral">Revoked</Status>;
    if (t.expiresAt && t.expiresAt < new Date().toISOString()) return <Status tone="warning">Expired</Status>;
    if (t.maxUses !== null && t.uses >= t.maxUses) return <Status tone="neutral">Used up</Status>;
    return <Status tone="good">Active</Status>;
  };

  return (
    <Page
      title="Deploy & enroll"
      description="Create an enrollment token, then install FBRX OS on any Mac or Windows computer. A device manager can do it for you (Mac profile, Windows script), or drop the provisioning file next to the installer, or paste the token in FBRX → Organization."
      actions={
        <Button variant="primary" icon="plus" onClick={() => setCreating(true)}>
          New enrollment token
        </Button>
      }
    >
      <Card title="Address for computers" subtitle={pin ? 'FBRX Command uses its own certificate. Computers check this fingerprint when they join, and trust nothing else.' : 'What computers connect to when they join.'}>
        <div className="fx-form">
          <Field label="FBRX Command address">
            <CopyText value={address} />
          </Field>
          {pin && (
            <Field label="Certificate fingerprint (SHA-256)" help="Provisioning files, Mac profiles, Windows scripts and license keys made here carry it. When someone joins by hand, FBRX shows this fingerprint: it must match.">
              <CopyText value={pin} />
            </Field>
          )}
        </div>
      </Card>
      <Card title="Installers" subtitle={latest ? `Latest stable release: ${latest.version}` : 'No stable release has been published yet'}>
        {latest ? (
          <div className="fx-list">
            {latest.files
              .filter((f) => f.kind !== 'blockmap')
              .map((f) => (
                <div className="fx-list-item" key={f.fileName} style={{ paddingLeft: 0 }}>
                  <span className="fx-badge">{f.platform === 'darwin' ? 'macOS' : f.platform === 'win32' ? 'Windows' : 'Linux'}</span>
                  <span className="mono" style={{ flex: 1 }}>{f.fileName}</span>
                  <span className="fx-muted">Download links with a token appear after you create one.</span>
                </div>
              ))}
          </div>
        ) : (
          <div className="fx-secondary">Publish a release under Releases, or distribute installers built by CI.</div>
        )}
      </Card>
      <Card title="Enrollment tokens" flush>
        <Table
          rows={tokens.data ?? []}
          rowKey={(t) => t.id}
          empty={<Empty title="No tokens yet">Tokens are shown once at creation and stored hashed.</Empty>}
          columns={[
            { key: 'l', header: 'Label', render: (t) => (<div><div className="fx-cell-title">{t.label}</div><div className="fx-cell-sub mono">{t.prefix}…</div></div>) },
            { key: 's', header: 'Status', render: state },
            { key: 'g', header: 'Group', render: (t) => (<>{groups.find((g) => g.id === t.groupId)?.name ?? '—'}<LearnerBadge audience={t.audience} plural /></>) },
            { key: 'u', header: 'Uses', className: 'num', render: (t) => `${t.uses}${t.maxUses !== null ? ` / ${t.maxUses}` : ''}` },
            { key: 'tpl', header: 'Template', render: (t) => (t.templateSnapshotId ? <span className="fx-badge accent">golden image</span> : '—') },
            { key: 'e', header: 'Expires', render: (t) => (t.expiresAt ? formatDate(t.expiresAt) : 'never') },
            { key: 'c', header: 'Created', render: (t) => timeAgo(t.createdAt) },
            {
              key: 'x',
              header: '',
              render: (t) =>
                !t.revokedAt && (
                  <Button
                    size="sm"
                    variant="danger"
                    onClick={async () => {
                      if (await confirm({ title: `Revoke "${t.label}"?`, body: 'Machines that have not enrolled yet will not be able to use it. Enrolled devices are unaffected.', danger: true, confirmLabel: 'Revoke' })) {
                        await run('rev', () => api('DELETE', `/v1/admin/enrollment-tokens/${t.id}`), 'Token revoked');
                        tokens.reload();
                      }
                    }}
                  >
                    Revoke
                  </Button>
                ),
            },
          ]}
        />
      </Card>
      {creating && (
        <CreateTokenModal
          groups={groups}
          snapshots={snapshots}
          onClose={() => setCreating(false)}
          onCreated={(c) => {
            setCreating(false);
            setCreated(c);
            tokens.reload();
          }}
        />
      )}
      {created && (
        <Modal
          wide
          title="Enrollment token created"
          description="This is the only time the token is shown. Download the provisioning file now."
          onClose={() => setCreated(null)}
          footer={
            <>
              <Button icon="download" onClick={() => saveBlob(new Blob([JSON.stringify(created.provisioning, null, 2)], { type: 'application/json' }), 'fbrx-provision.json')}>
                fbrx-provision.json
              </Button>
              <Button
                icon="download"
                title="A configuration profile for Jamf, Mosyle, Kandji, Intune or another Mac device manager"
                onClick={() =>
                  saveBlob(
                    new Blob([macProfile({ organization, label: created.label, serverUrl: String(created.provisioning.serverUrl), enrollmentToken: created.token, audience: created.audience, serverFingerprint: (created.provisioning.serverFingerprint as string | undefined) ?? null, uuids: [uuid(), uuid()] })], { type: 'application/x-apple-aspen-config' }),
                    `FBRX-${created.label.replace(/[^\w-]+/g, '-')}.mobileconfig`,
                  )
                }
              >
                Mac profile
              </Button>
              <Button
                icon="download"
                title="A PowerShell script for Intune (Win32 app) or another Windows device manager"
                onClick={() =>
                  saveBlob(
                    new Blob([windowsScript({ organization, label: created.label, serverUrl: String(created.provisioning.serverUrl), enrollmentToken: created.token, audience: created.audience, serverFingerprint: (created.provisioning.serverFingerprint as string | undefined) ?? null, installerUrl: latestWin ? `${address}/v1/downloads/${latest!.id}/${encodeURIComponent(latestWin)}?et=${created.token}` : null })], { type: 'text/plain' }),
                    'Install-FBRX.ps1',
                  )
                }
              >
                Windows script
              </Button>
              <Button variant="primary" onClick={() => setCreated(null)}>
                Done
              </Button>
            </>
          }
        >
          <div className="fx-form">
            <Field label="Enrollment token">
              <CopyText value={created.token} secret />
            </Field>
            {latest && (
              <Field label="Installer links (valid while the token is active)">
                <div className="fx-form" style={{ gap: 8 }}>
                  {latest.files
                    .filter((f) => f.kind !== 'blockmap')
                    .map((f) => (
                      <CopyText key={f.fileName} value={`${address}/v1/downloads/${latest.id}/${encodeURIComponent(f.fileName)}?et=${created.token}`} />
                    ))}
                </div>
              </Field>
            )}
            <Callout tone="info" title="Ways to enroll a computer">
              <ol style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                <li>Mac device manager (Jamf, Mosyle, Kandji, Intune…): upload the <b>Mac profile</b>; FBRX joins on its next start.</li>
                <li>Intune on Windows: package the <b>Windows script</b> with the installer as a Win32 app; it installs for all users and joins.</li>
                <li>No device manager: put <code>fbrx-provision.json</code> next to the installer, or in <code>/Library/Application Support/FBRX OS</code> (Mac) or <code>%ProgramData%\FBRX OS</code> (Windows).</li>
                <li>By hand: open FBRX → Organization, paste the address and token{pin ? ' and check the certificate fingerprint it shows' : ''}{isLearner(created.audience) ? '' : app.kind === 'home' ? ' (tick "for a child" on the children\'s computers)' : app.kind === 'business' ? '' : ' (tick "for a student" on student laptops)'}.</li>
                <li>Headless/servers: <code>fbrx-headless enroll {address} &lt;token&gt;{pin ? ` --fingerprint ${pin}` : ''}</code></li>
              </ol>
            </Callout>
            <Field label="Provisioning file">
              <pre className="fx-code">{JSON.stringify({ ...created.provisioning, enrollmentToken: `${created.token.slice(0, 14)}…`, ...(created.provisioning.templateSnapshotPassphrase ? { templateSnapshotPassphrase: '••••••' } : {}) }, null, 2)}</pre>
            </Field>
          </div>
        </Modal>
      )}
      {dialog}
    </Page>
  );
}

function CreateTokenModal({ groups, snapshots, onClose, onCreated }: { groups: Array<{ id: string; name: string }>; snapshots: Array<{ id: string; deviceName: string; label: string | null; createdAt: string }>; onClose: () => void; onCreated: (c: Created) => void }) {
  const kind = useApp().kind;
  const [f, setF] = useState({ label: '', groupId: '', maxUses: '25', expiresInDays: '30', templateSnapshotId: '', templatePassphrase: '', deviceName: '', audience: '' as Audience | '' });
  const { busy, run } = useAction();
  const create = async () => {
    const r = await run('create', () =>
      api<Created>('POST', '/v1/admin/enrollment-tokens', {
        label: f.label,
        groupId: f.groupId || null,
        maxUses: f.maxUses ? Number(f.maxUses) : null,
        expiresInDays: f.expiresInDays ? Number(f.expiresInDays) : null,
        templateSnapshotId: f.templateSnapshotId || null,
        audience: f.audience || null,
        templatePassphrase: f.templatePassphrase || undefined,
        deviceName: f.deviceName || undefined,
      }),
    );
    if (r) onCreated(r);
  };
  return (
    <Modal
      title="New enrollment token"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy === 'create'} disabled={!f.label.trim() || (!!f.templateSnapshotId && f.templatePassphrase.length < 10)} onClick={() => void create()}>
            Create token
          </Button>
        </>
      }
    >
      <div className="fx-form">
        <Field label="Label">
          <Input value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} placeholder="Q4 laptop refresh" autoFocus />
        </Field>
        <Field label="Group" help="New devices join this group automatically">
          <Select value={f.groupId} onChange={(e) => setF({ ...f, groupId: e.target.value })} options={[{ value: '', label: 'No group' }, ...groups.map((g) => ({ value: g.id, label: g.name }))]} />
        </Field>
        <Field label="Computers are used by" help={kind === 'business' ? undefined : `${audienceHelp(kind)}, whatever the group says`}>
          <Select value={f.audience} onChange={(e) => setF({ ...f, audience: e.target.value as Audience | '' })} options={[{ value: '', label: 'Their group (or the organization default)' }, ...audienceOptions(kind)]} />
        </Field>
        <div className="fx-row">
          <Field label="Max uses">
            <Input type="number" min={1} value={f.maxUses} onChange={(e) => setF({ ...f, maxUses: e.target.value })} placeholder="Unlimited" />
          </Field>
          <Field label="Expires in (days)">
            <Input type="number" min={1} value={f.expiresInDays} onChange={(e) => setF({ ...f, expiresInDays: e.target.value })} placeholder="Never" />
          </Field>
        </div>
        <Field label="Golden image (optional)" help="Restore this backup onto each new machine before it enrolls: same plugins, connections, settings and workspace">
          <Select
            value={f.templateSnapshotId}
            onChange={(e) => setF({ ...f, templateSnapshotId: e.target.value })}
            options={[{ value: '', label: 'None — start from a clean install' }, ...snapshots.map((s) => ({ value: s.id, label: `${s.deviceName} · ${s.label ?? 'backup'} · ${new Date(s.createdAt).toLocaleDateString()}` }))]}
          />
        </Field>
        {f.templateSnapshotId && (
          <Field label="Snapshot passphrase" help="Embedded in the provisioning file so new machines can decrypt the image; treat the file as a secret">
            <Input type="password" value={f.templatePassphrase} onChange={(e) => setF({ ...f, templatePassphrase: e.target.value })} />
          </Field>
        )}
      </div>
    </Modal>
  );
}
