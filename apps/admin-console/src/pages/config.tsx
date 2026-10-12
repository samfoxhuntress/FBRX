import { useState } from 'react';
import { AUDIENCE_NAMES, AUTO_UPDATE_MODES, isLearner, AUTO_UPDATE_NAMES, DEFAULT_POLICY, PROFILE_PRESETS, presetApplied, UPDATE_CHANNELS, VERTICALS, VERTICAL_AUDIENCES, VERTICAL_NAMES, type Audience, type AutoUpdateMode, type Vertical } from '@fbrx/shared';
import { Button, Callout, Card, Empty, Field, Grid, Input, JsonEditor, Modal, More, Page, Select, Status, Table, TextArea, Toggle, timeAgo, useAction, useConfirm } from '@fbrx/ui';
import { api } from '../api';
import { useApp, useQuery } from '../state';
import { QUICK_SETUP_TITLE, QuickSetup, quickSetupDone } from './quick-setup';
import { SettingsBuilder, type SettingsDraft } from './settings-builder';

interface Profile {
  id: string;
  name: string;
  description: string;
  settings: Record<string, unknown>;
  locked: string[];
  policy: unknown;
  version: number;
  updatedAt: string;
}
interface Group {
  id: string;
  name: string;
  description: string;
  profileId: string | null;
  updateChannel: string | null;
  pinnedVersion: string | null;
  audience: Audience | null;
  tier: 'basic' | 'ultra' | null;
  autoUpdate: AutoUpdateMode | null;
  deviceCount: number;
}
interface Tenant {
  id: string;
  name: string;
  defaultProfileId: string | null;
  updateChannel: string;
  vertical: Vertical;
  autoUpdate: AutoUpdateMode;
  helpdeskEnabled: boolean;
  chatEnabled: boolean;
}

const VERTICAL_HELP: Record<Vertical, string> = {
  business: 'Staff computers run FBRX Endpoint Basic or Ultra.',
  education: 'Staff computers start in classroom mode (presenter-safe with a projector, chats offline first, no jokes), and student computers run FBRX OS Education.',
  home: "Parents' computers run FBRX Endpoint and get the children's requests for help; children's computers run FBRX OS Home with the same protections as students.",
};


export function ConfigPage() {
  const app = useApp();
  const profiles = useQuery<Profile[]>('/v1/admin/profiles');
  const groups = useQuery<Group[]>('/v1/admin/groups');
  const tenants = useQuery<Tenant[]>('/v1/admin/tenants');
  const releases = useQuery<Array<{ version: string; published: boolean }>>('/v1/admin/releases').data ?? [];
  const tenant = tenants.data?.find((t) => t.id === app.tenantId);
  const [editProfile, setEditProfile] = useState<Partial<Profile> | null>(null);
  const [editGroup, setEditGroup] = useState<Partial<Group> | null>(null);
  const [quickShown, setQuickShown] = useState<string | null>(null);
  const { confirm, dialog } = useConfirm();
  const { busy, run } = useAction();
  const profileName = (id: string | null) => profiles.data?.find((p) => p.id === id)?.name ?? '—';

  return (
    <Page
      title="Profiles & groups"
      description="Profiles bundle settings, locked settings and a governance policy. They apply tenant-wide (default profile) and per group; devices can add overrides. Changes reach online devices within seconds."
    >
      {tenant && groups.data && (!quickSetupDone(tenant.vertical, groups.data.map((g) => g.name)) || quickShown === tenant.id) && (
        <Card title={QUICK_SETUP_TITLE[tenant.vertical]} subtitle={`The usual groups for ${tenant.vertical === 'business' ? 'a company' : tenant.vertical === 'education' ? 'a school' : 'a family'}, each with an enrollment token. Existing groups with the same names are reused.`}>
          <QuickSetup key={`${tenant.id}-${tenant.vertical}`} tenantId={tenant.id} vertical={tenant.vertical} onDone={() => (setQuickShown(tenant.id), groups.reload())} />
        </Card>
      )}
      {tenant && (
        <Card title={tenant.vertical === 'home' ? 'Family defaults' : tenant.vertical === 'education' ? 'School defaults' : 'Organization defaults'}>
          <div className="fx-form">
            <div className="fx-row">
              <Field label="Kind" help={VERTICAL_HELP[tenant.vertical]}>
                <Select value={tenant.vertical} onChange={(e) => void run('t', () => api('PATCH', `/v1/admin/tenants/${tenant.id}`, { vertical: e.target.value }).then(() => (tenants.reload(), app.refreshMe())), 'Kind changed')} options={VERTICALS.map((v) => ({ value: v, label: VERTICAL_NAMES[v] }))} />
              </Field>
              <Field label="New versions" help="Install automatically: computers update themselves when nobody is using them (from FBRX Command's releases or the GitHub repository). Groups can differ.">
                <Select value={tenant.autoUpdate} onChange={(e) => void run('t', () => api('PATCH', `/v1/admin/tenants/${tenant.id}`, { autoUpdate: e.target.value }).then(tenants.reload), 'Update policy changed')} options={AUTO_UPDATE_MODES.map((m) => ({ value: m, label: AUTO_UPDATE_NAMES[m] }))} />
              </Field>
              <Field label="Help desk" help={tenant.vertical === 'home' ? 'Computers get a Help desk tab for asking a parent for help' : 'Computers get a Help desk tab for sending tickets to IT'}>
                <Toggle checked={tenant.helpdeskEnabled} onChange={(v) => void run('t', () => api('PATCH', `/v1/admin/tenants/${tenant.id}`, { helpdeskEnabled: v }).then(tenants.reload), v ? 'Help desk on' : 'Help desk off')} label={tenant.helpdeskEnabled ? 'On' : 'Off'} />
              </Field>
              <Field label="Messages" help={tenant.vertical === 'home' ? 'The family’s computers can message each other (Messages in the sidebar)' : 'Computers can message each other and everyone at once (the No chatting preset turns it off for a group)'}>
                <Toggle checked={tenant.chatEnabled} onChange={(v) => void run('t', () => api('PATCH', `/v1/admin/tenants/${tenant.id}`, { chatEnabled: v }).then(tenants.reload), v ? 'Messages on' : 'Messages off')} label={tenant.chatEnabled ? 'On' : 'Off'} />
              </Field>
            </div>
            <div className="fx-row">
              <Field label="Default profile" help="Applies to every device before group and device layers">
                <Select
                  value={tenant.defaultProfileId ?? ''}
                  onChange={(e) => void run('t', () => api('PATCH', `/v1/admin/tenants/${tenant.id}`, { defaultProfileId: e.target.value || null }).then(tenants.reload), 'Default profile updated')}
                  options={[{ value: '', label: 'None' }, ...(profiles.data ?? []).map((p) => ({ value: p.id, label: p.name }))]}
                />
              </Field>
              <Field label="Default update channel">
                <Select value={tenant.updateChannel} onChange={(e) => void run('t', () => api('PATCH', `/v1/admin/tenants/${tenant.id}`, { updateChannel: e.target.value }).then(tenants.reload), 'Update channel changed')} options={[...UPDATE_CHANNELS]} />
              </Field>
            </div>
          </div>
        </Card>
      )}
      {tenant && <OrgMeshCard />}
      <Grid cols={2}>
        <Card title="Configuration profiles" actions={<Button size="sm" icon="plus" onClick={() => setEditProfile({ name: '', description: '', settings: {}, locked: [], policy: null })}>New profile</Button>} flush>
          <Table
            rows={profiles.data ?? []}
            rowKey={(p) => p.id}
            onRowClick={(p) => setEditProfile(p)}
            empty={<Empty title="No profiles">Create one to standardize settings and governance across devices.</Empty>}
            columns={[
              { key: 'n', header: 'Profile', render: (p) => (<div><div className="fx-cell-title">{p.name}</div><div className="fx-cell-sub">{p.description || `${Object.keys(p.settings).length} setting groups`}</div></div>) },
              { key: 'presets', header: 'Ready-made', render: (p) => PROFILE_PRESETS.filter((x) => presetApplied(x, p.settings, p.locked)).map((x) => x.name).join(', ') || <span className="fx-muted">—</span> },
              { key: 'l', header: 'Locked', className: 'num', render: (p) => p.locked.length },
              { key: 'p', header: 'Policy', render: (p) => (p.policy ? <span className="fx-badge accent">custom</span> : <span className="fx-muted">inherit</span>) },
              { key: 'u', header: 'Updated', render: (p) => <span className="fx-secondary">v{p.version} · {timeAgo(p.updatedAt)}</span> },
            ]}
          />
        </Card>
        <Card title="Device groups" actions={<Button size="sm" icon="plus" onClick={() => setEditGroup({ name: '', description: '', profileId: null, updateChannel: null, pinnedVersion: null })}>New group</Button>} flush>
          <Table
            rows={groups.data ?? []}
            rowKey={(g) => g.id}
            onRowClick={(g) => setEditGroup(g)}
            empty={<Empty title="No groups">Groups let you roll out profiles, channels and pinned versions to sets of devices.</Empty>}
            columns={[
              { key: 'n', header: 'Group', render: (g) => <div className="fx-cell-title">{g.name}</div> },
              { key: 'd', header: 'Devices', className: 'num', render: (g) => g.deviceCount },
              { key: 'p', header: 'Profile', render: (g) => profileName(g.profileId) },
              { key: 'a', header: 'Used by', render: (g) => (g.audience ? <span className={`fx-badge${isLearner(g.audience) ? ' accent' : ''}`}>{AUDIENCE_NAMES[g.audience]}</span> : <span className="fx-muted">inherit</span>) },
              { key: 't', header: 'Edition', render: (g) => (g.audience === 'student' ? 'FBRX OS Education' : g.audience === 'child' ? 'FBRX OS Home' : g.tier === 'basic' ? 'Basic' : <span className="fx-muted">license</span>) },
              { key: 'c', header: 'Channel', render: (g) => g.pinnedVersion ? <span className="fx-badge">pinned {g.pinnedVersion}</span> : g.updateChannel ?? <span className="fx-muted">inherit</span> },
            ]}
          />
        </Card>
      </Grid>
      {editProfile && <ProfileEditor profile={editProfile} onClose={() => setEditProfile(null)} onSaved={() => (setEditProfile(null), profiles.reload())} onDelete={async () => {
        if (editProfile.id && (await confirm({ title: `Delete profile "${editProfile.name}"?`, body: 'Groups using it fall back to the organization default. Devices re-sync immediately.', danger: true, confirmLabel: 'Delete' }))) {
          await run('del', () => api('DELETE', `/v1/admin/profiles/${editProfile.id}`), 'Profile deleted');
          setEditProfile(null);
          profiles.reload();
        }
      }} />}
      {editGroup && (
        <GroupEditor
          group={editGroup}
          vertical={tenant?.vertical ?? 'business'}
          profiles={profiles.data ?? []}
          versions={releases.filter((r) => r.published).map((r) => r.version)}
          onClose={() => setEditGroup(null)}
          onSaved={() => (setEditGroup(null), groups.reload())}
          onDelete={async () => {
            if (editGroup.id && (await confirm({ title: `Delete group "${editGroup.name}"?`, body: 'Its devices stay enrolled and fall back to organization defaults.', danger: true, confirmLabel: 'Delete' }))) {
              await run('delg', () => api('DELETE', `/v1/admin/groups/${editGroup.id}`), 'Group deleted');
              setEditGroup(null);
              groups.reload();
            }
          }}
        />
      )}
      {dialog}
      {busy === 'x' && null}
    </Page>
  );
}

function ProfileEditor({ profile, onClose, onSaved, onDelete }: { profile: Partial<Profile>; onClose: () => void; onSaved: () => void; onDelete: () => void }) {
  const [name, setName] = useState(profile.name ?? '');
  const [description, setDescription] = useState(profile.description ?? '');
  const [draft, setDraft] = useState<SettingsDraft>({ settings: profile.settings ?? {}, locked: profile.locked ?? [] });
  const [policy, setPolicy] = useState(profile.policy ? JSON.stringify(profile.policy, null, 2) : '');
  const [ok, setOk] = useState({ s: true, p: true });
  const { busy, run } = useAction();
  const save = () =>
    run(
      'save',
      () =>
        api(profile.id ? 'PATCH' : 'POST', profile.id ? `/v1/admin/profiles/${profile.id}` : '/v1/admin/profiles', {
          name,
          description,
          settings: draft.settings,
          locked: draft.locked,
          policy: policy.trim() ? JSON.parse(policy) : null,
        }).then(onSaved),
      'Profile saved; devices are syncing',
    );
  return (
    <Modal
      wide
      title={profile.id ? `Edit ${profile.name}` : 'New configuration profile'}
      onClose={onClose}
      footer={
        <>
          {profile.id && (
            <Button variant="danger" onClick={onDelete} style={{ marginRight: 'auto' }}>
              Delete
            </Button>
          )}
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy === 'save'} disabled={!name.trim() || !ok.s || !ok.p} onClick={() => void save()}>
            Save profile
          </Button>
        </>
      }
    >
      <div className="fx-form">
        <div className="fx-row">
          <Field label="Name">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Standard workstation" />
          </Field>
          <Field label="Description">
            <Input value={description} onChange={(e) => setDescription(e.target.value)} />
          </Field>
        </div>
        <SettingsBuilder value={draft} onChange={setDraft} onJsonValidity={(v) => setOk((o) => (o.s === v ? o : { ...o, s: v }))} />
        <More label="Governance policy (what the agent may do)">
          <Field label="Governance policy (JSON)" help="Replaces the computer's own policy: tool rules, folders, network, shell, AI providers, approvals. Empty keeps each computer's own.">
            <JsonEditor value={policy} onChange={setPolicy} rows={10} onValidity={(v) => setOk((o) => (o.p === v ? o : { ...o, p: v }))} />
          </Field>
          {!policy.trim() && (
            <div>
              <Button size="sm" onClick={() => setPolicy(JSON.stringify(DEFAULT_POLICY, null, 2))}>
                Start from the default policy
              </Button>
            </div>
          )}
        </More>
      </div>
    </Modal>
  );
}

function GroupEditor({ group, vertical, profiles, versions, onClose, onSaved, onDelete }: { group: Partial<Group>; vertical: Vertical; profiles: Profile[]; versions: string[]; onClose: () => void; onSaved: () => void; onDelete: () => void }) {
  const [f, setF] = useState({ name: group.name ?? '', description: group.description ?? '', profileId: group.profileId ?? '', updateChannel: group.updateChannel ?? '', pinnedVersion: group.pinnedVersion ?? '', audience: group.audience ?? '', tier: group.tier ?? '', autoUpdate: group.autoUpdate ?? '' });
  const { busy, run } = useAction();
  const save = () =>
    run(
      'save',
      () =>
        api(group.id ? 'PATCH' : 'POST', group.id ? `/v1/admin/groups/${group.id}` : '/v1/admin/groups', {
          name: f.name,
          description: f.description,
          profileId: f.profileId || null,
          updateChannel: f.updateChannel || null,
          pinnedVersion: f.pinnedVersion || null,
          audience: f.audience || null,
          tier: f.tier || null,
          autoUpdate: f.autoUpdate || null,
        }).then(onSaved),
      'Group saved',
    );
  return (
    <Modal
      title={group.id ? `Edit ${group.name}` : 'New device group'}
      onClose={onClose}
      footer={
        <>
          {group.id && (
            <Button variant="danger" onClick={onDelete} style={{ marginRight: 'auto' }}>
              Delete
            </Button>
          )}
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy === 'save'} disabled={!f.name.trim()} onClick={() => void save()}>
            Save group
          </Button>
        </>
      }
    >
      <div className="fx-form">
        <Field label="Name">
          <Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Finance laptops" />
        </Field>
        <Field label="Description">
          <Input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
        </Field>
        <Field label="Profile">
          <Select value={f.profileId} onChange={(e) => setF({ ...f, profileId: e.target.value })} options={[{ value: '', label: 'Organization default only' }, ...profiles.map((p) => ({ value: p.id, label: p.name }))]} />
        </Field>
        <div className="fx-row">
          <Field label="Used by" help={vertical === 'education' ? 'Student computers run FBRX OS Education' : vertical === 'home' ? "Children's computers run FBRX OS Home" : undefined}>
            <Select value={f.audience} onChange={(e) => setF({ ...f, audience: e.target.value as Audience | '' })} options={[{ value: '', label: 'Organization default' }, ...VERTICAL_AUDIENCES[vertical].map((a) => ({ value: a, label: AUDIENCE_NAMES[a] }))]} />
          </Field>
          <Field label="Edition" help={vertical === 'home' ? "Hold parents' computers to Endpoint Basic if they don't need the IT tools" : 'Hold the group to Endpoint Basic, e.g. teachers on Basic and IT on Ultra'}>
            <Select value={f.tier} disabled={isLearner((f.audience || null) as Audience | null)} onChange={(e) => setF({ ...f, tier: e.target.value as 'basic' | '' })} options={[{ value: '', label: 'What the license gives' }, { value: 'basic', label: 'Endpoint Basic' }]} />
          </Field>
          <Field label="New versions">
            <Select value={f.autoUpdate} onChange={(e) => setF({ ...f, autoUpdate: e.target.value as AutoUpdateMode | '' })} options={[{ value: '', label: 'Organization default' }, ...AUTO_UPDATE_MODES.map((m) => ({ value: m, label: AUTO_UPDATE_NAMES[m] }))]} />
          </Field>
        </div>
        <div className="fx-row">
          <Field label="Update channel">
            <Select value={f.updateChannel} onChange={(e) => setF({ ...f, updateChannel: e.target.value })} options={[{ value: '', label: 'Inherit' }, ...UPDATE_CHANNELS.map((c) => ({ value: c, label: c }))]} />
          </Field>
          <Field label="Pinned version" help="Snapshot this group on a specific release">
            <Select value={f.pinnedVersion} onChange={(e) => setF({ ...f, pinnedVersion: e.target.value })} options={[{ value: '', label: 'Not pinned' }, ...versions.map((v) => ({ value: v, label: v }))]} />
          </Field>
        </div>
      </div>
    </Modal>
  );
}

interface OrgMeshView {
  meshAuto: boolean;
  hive: { groups: 'all' | string[] };
  groups: Array<{ id: string; name: string }>;
  computers: Array<{ deviceId: string; name: string; group: string | null; online: boolean; meshOn: boolean; roles: string[]; addresses: string[]; lastSeenAt: string | null }>;
  servers: Array<{ deviceId: string; name: string; group: string | null; online: boolean; meshOn: boolean; roles: string[] }>;
}

/**
 * The organization's FBRX Mesh: its computers meet each other without pairing codes (FBRX Command vouches for their
 * keys), and the organization picks which groups may use its servers' AI (the hive).
 */
function OrgMeshCard() {
  const app = useApp();
  const mesh = useQuery<OrgMeshView>('/v1/admin/mesh');
  const { busy, run } = useAction();
  const m = mesh.data;
  if (!m) return null;
  const canEdit = app.can('config.manage');
  const save = (body: Partial<Pick<OrgMeshView, 'meshAuto' | 'hive'>>, ok: string) => void run('mesh', () => api('PUT', '/v1/admin/mesh', body).then(() => mesh.reload()), ok);
  const chosen = m.hive.groups === 'all' ? null : new Set(m.hive.groups);
  const meshed = m.computers.filter((c) => c.meshOn).length;
  return (
    <Card
      title="FBRX Mesh"
      subtitle="The organization's computers find and trust each other on FBRX Mesh without pairing codes. They see each other, message each other, and borrow a server's AI when theirs is too small, out of steps or not answering."
      actions={canEdit && <Toggle checked={m.meshAuto} disabled={busy === 'mesh'} onChange={(v) => save({ meshAuto: v }, v ? 'The computers mesh together' : 'The computers no longer mesh together')} label={m.meshAuto ? 'On' : 'Off'} />}
    >
      <div className="fx-form">
        <div className="fx-muted" style={{ fontSize: 12.5 }}>
          {m.meshAuto ? `${meshed} of ${m.computers.length} computers are on the mesh. Turning this on turns FBRX Mesh on at each computer (unless a profile keeps it off).` : 'Off: computers keep only the ones paired by hand.'}
        </div>
        <Field label="Who may use the servers' AI (the hive)" help="Servers with the ai role lend their AI to these groups through Mesh Assist; each server's own Mesh Assist settings still decide whether someone there approves first.">
          <div className="fx-row" style={{ gap: 6, flexWrap: 'wrap' }}>
            <Button size="sm" variant={chosen ? 'ghost' : 'primary'} disabled={!canEdit} onClick={() => save({ hive: { groups: 'all' } }, 'Every group may use the hive')}>
              Every group
            </Button>
            {m.groups.map((g) => {
              const on = !!chosen?.has(g.id);
              return (
                <Button
                  key={g.id}
                  size="sm"
                  variant={on ? 'primary' : 'ghost'}
                  icon={on ? 'check' : undefined}
                  disabled={!canEdit}
                  onClick={() => {
                    const next = new Set(chosen ?? []);
                    if (on) next.delete(g.id);
                    else next.add(g.id);
                    save({ hive: { groups: [...next] } }, `${g.name} ${on ? 'no longer uses' : 'may use'} the hive`);
                  }}
                >
                  {g.name}
                </Button>
              );
            })}
          </div>
        </Field>
        {chosen && chosen.size === 0 && <Callout tone="warning">No group is chosen: nobody may use the servers' AI.</Callout>}
        {m.servers.length ? (
          <div className="fx-form" style={{ gap: 4 }}>
            <div style={{ fontWeight: 600, fontSize: 13 }}>Servers in the hive</div>
            {m.servers.map((s) => (
              <div key={s.deviceId} className="fx-row" style={{ gap: 8 }}>
                <Status tone={s.online && s.meshOn ? 'good' : 'neutral'}>{s.online ? (s.meshOn ? 'on the mesh' : 'mesh off') : 'offline'}</Status>
                <strong>{s.name}</strong>
                <span className="fx-muted">{s.roles.join(', ')}</span>
              </div>
            ))}
          </div>
        ) : (
          <div className="fx-muted" style={{ fontSize: 12.5 }}>
            No server with the ai role has joined yet. On FBRX Server, install the ai role and enroll it in this organization (its Mesh & AI page, or sudo fbrx-server ai).
          </div>
        )}
      </div>
    </Card>
  );
}
