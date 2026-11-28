import { useEffect, useMemo, useState } from 'react';
import { DEFAULT_POLICY, PolicySchema, type Policy } from '@fbrx/shared';
import { Button, Callout, Card, Empty, JsonEditor, Page, Status, useAction, useConfirm } from '@fbrx/ui';
import { api } from '../api';
import { useApp, useQuery, useRoute } from '../state';

/**
 * Governance: what the AI may do on the organization's computers. Each configuration profile can carry a policy (tool
 * rules, the folders it may use, the web, the shell, AI providers, approvals) that replaces each computer's own; the
 * policy is written here as JSON, checked before it is saved, and reaches online computers within seconds. Computers
 * show it read-only (their Governance page says it comes from FBRX Command).
 */

interface Profile {
  id: string;
  name: string;
  description: string;
  policy: Policy | null;
  version: number;
  updatedAt: string;
}
interface Group {
  id: string;
  name: string;
  profileId: string | null;
  deviceCount: number;
}
interface Tenant {
  id: string;
  defaultProfileId: string | null;
}

/** What a policy allows, in a few words, for the list. */
function summary(p: Policy): string[] {
  const out = [p.mode === 'audit' ? 'Audit only' : 'Enforced'];
  out.push(`${p.filesystem.allowedRoots.length} folder${p.filesystem.allowedRoots.length === 1 ? '' : 's'}${p.filesystem.readOnly ? ', read only' : ''}`);
  out.push(p.shell.enabled ? 'Shell allowed' : 'No shell');
  out.push(p.ai.allowCloudProviders ? 'Cloud AI allowed' : 'Local AI only');
  if (p.rules.length) out.push(`${p.rules.length} rule${p.rules.length === 1 ? '' : 's'}`);
  return out;
}

export function GovernancePage() {
  const app = useApp();
  const [route, go] = useRoute();
  const profiles = useQuery<Profile[]>('/v1/admin/profiles');
  const groups = useQuery<Group[]>('/v1/admin/groups');
  const tenants = useQuery<Tenant[]>('/v1/admin/tenants');
  const tenant = tenants.data?.find((t) => t.id === app.tenantId);
  const list = profiles.data ?? [];
  const selected = list.find((p) => p.id === route.id) ?? list.find((p) => p.id === tenant?.defaultProfileId) ?? list[0] ?? null;
  const usedBy = (p: Profile) => {
    const g = (groups.data ?? []).filter((x) => x.profileId === p.id);
    const parts = [...(tenant?.defaultProfileId === p.id ? ['Every computer (the default profile)'] : []), ...g.map((x) => `${x.name} (${x.deviceCount})`)];
    return parts.length ? parts.join(', ') : 'Not used by any group';
  };
  return (
    <Page
      title="Governance"
      description="What the AI may do on your organization's computers: the folders it may use, the web, the shell, AI providers, approvals and tool rules. A profile's policy replaces each computer's own; computers show it, read only."
    >
      {!list.length ? (
        <Empty title="No configuration profiles yet">Make one under Profiles & groups, then give it a policy here.</Empty>
      ) : (
        <div className="gov-layout">
          <Card title="Profiles" flush>
            <div className="fx-list">
              {list.map((p) => (
                <button key={p.id} type="button" className={`fx-list-item gov-profile${selected?.id === p.id ? ' active' : ''}`} onClick={() => go(`governance/${encodeURIComponent(p.id)}`)}>
                  <div style={{ flex: 1, minWidth: 0, textAlign: 'left' }}>
                    <div className="fx-cell-title">{p.name}</div>
                    <div className="fx-cell-sub">{usedBy(p)}</div>
                  </div>
                  {p.policy ? <Status tone="info">Policy</Status> : <span className="fx-muted">Computers' own</span>}
                </button>
              ))}
            </div>
          </Card>
          {selected && <PolicyEditor key={`${selected.id}:${selected.version}`} profile={selected} usedBy={usedBy(selected)} canEdit={app.can('config.manage')} onSaved={profiles.reload} />}
        </div>
      )}
    </Page>
  );
}

function PolicyEditor({ profile, usedBy, canEdit, onSaved }: { profile: Profile; usedBy: string; canEdit: boolean; onSaved: () => void }) {
  const [text, setText] = useState(profile.policy ? JSON.stringify(profile.policy, null, 2) : '');
  const [syntaxOk, setSyntaxOk] = useState(true);
  const { run, busy } = useAction();
  const { confirm, dialog } = useConfirm();
  useEffect(() => setText(profile.policy ? JSON.stringify(profile.policy, null, 2) : ''), [profile.policy]);
  // Checked against the policy's schema as it is typed: the same check FBRX Command makes before saving.
  const check = useMemo(() => {
    if (!text.trim()) return { ok: true as const, policy: null, issues: [] as string[] };
    try {
      const r = PolicySchema.safeParse(JSON.parse(text));
      return r.success ? { ok: true as const, policy: r.data, issues: [] } : { ok: false as const, policy: null, issues: r.error.issues.slice(0, 6).map((i) => `${i.path.join('.') || 'policy'}: ${i.message}`) };
    } catch {
      return { ok: false as const, policy: null, issues: [] };
    }
  }, [text]);
  const changed = text.trim() !== (profile.policy ? JSON.stringify(profile.policy, null, 2) : '').trim();
  const save = (policy: Policy | null) => run('save', () => api('PATCH', `/v1/admin/profiles/${profile.id}`, { policy }).then(onSaved), policy ? 'Policy saved; computers are syncing' : 'Computers use their own policy again');
  const clear = async () => {
    if (await confirm({ title: 'Stop setting a policy for this profile?', body: 'Its computers go back to their own policy (what the people at them choose).', confirmLabel: 'Stop', danger: true })) await save(null);
  };
  return (
    <Card
      title={profile.name}
      subtitle={usedBy}
      actions={check.policy ? <span className="fx-muted">{summary(check.policy).join(' · ')}</span> : undefined}
    >
      {!text.trim() ? (
        <Callout tone="info" title="Each computer uses its own policy">
          Nothing is set for this profile: people decide on each computer (Governance in FBRX Endpoint).
          {canEdit && (
            <div style={{ marginTop: 10 }}>
              <Button size="sm" icon="plus" onClick={() => setText(JSON.stringify(DEFAULT_POLICY, null, 2))}>
                Start from the default policy
              </Button>
            </div>
          )}
        </Callout>
      ) : (
        <>
          <JsonEditor value={text} onChange={(v) => canEdit && setText(v)} rows={28} onValidity={setSyntaxOk} />
          {syntaxOk && !check.ok && (
            <Callout tone="warning" title="FBRX would not accept this policy">
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {check.issues.map((i) => (
                  <li key={i} className="mono">
                    {i}
                  </li>
                ))}
              </ul>
            </Callout>
          )}
          <p className="fx-muted" style={{ marginBottom: 0 }}>
            Folders can use <code>{'${HOME}'}</code>, <code>{'${DOCUMENTS}'}</code>, <code>{'${DESKTOP}'}</code>, <code>{'${DOWNLOADS}'}</code> and <code>{'${WORKSPACE}'}</code>, which each computer fills in. Rules are checked top to bottom before the defaults by risk.
          </p>
        </>
      )}
      {canEdit && text.trim() && (
        <div className="fx-actions" style={{ marginTop: 12 }}>
          <Button variant="primary" icon="check" disabled={!changed || !syntaxOk || !check.ok} loading={busy === 'save'} onClick={() => check.policy && void save(check.policy)}>
            Save policy
          </Button>
          <Button variant="ghost" disabled={!syntaxOk || !check.policy} onClick={() => check.policy && setText(JSON.stringify(check.policy, null, 2))}>
            Tidy up
          </Button>
          {changed && (
            <Button variant="ghost" onClick={() => setText(profile.policy ? JSON.stringify(profile.policy, null, 2) : '')}>
              Undo changes
            </Button>
          )}
          {profile.policy && (
            <Button variant="ghost" icon="trash" style={{ marginLeft: 'auto' }} onClick={() => void clear()}>
              Let computers decide
            </Button>
          )}
        </div>
      )}
      {dialog}
    </Card>
  );
}
