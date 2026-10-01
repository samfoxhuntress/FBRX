import { deepMerge, type DeviceConfig, type Policy } from '@fbrx/shared';
import { openString, type Db } from '@fbrx/shared/node';

interface ProfileRow {
  id: string;
  settings: string;
  locked: string;
  policy: string | null;
}

/**
 * Resolves what a device should run with: tenant default profile ← group profile ← device overrides,
 * plus the tenant license, scoped secrets (tenant → group → device) and the update channel/pin.
 */
export function resolveDeviceConfig(db: Db, master: Buffer, deviceId: string): DeviceConfig {
  const d = db.get<any>('SELECT * FROM devices WHERE id = ?', deviceId);
  if (!d) throw new Error('Unknown device');
  const t = db.get<any>('SELECT * FROM tenants WHERE id = ?', d.tenant_id);
  const g = d.group_id ? db.get<any>('SELECT * FROM groups WHERE id = ?', d.group_id) : null;
  const profile = (id: string | null | undefined) => (id ? db.get<ProfileRow>('SELECT id, settings, locked, policy FROM profiles WHERE id = ?', id) : undefined);
  const layers = [profile(t.default_profile_id), profile(g?.profile_id)].filter(Boolean) as ProfileRow[];

  let settings: Record<string, unknown> = {};
  const locked = new Set<string>();
  let policy: Policy | null = null;
  for (const p of layers) {
    settings = deepMerge(settings, JSON.parse(p.settings));
    for (const l of JSON.parse(p.locked) as string[]) locked.add(l);
    if (p.policy) policy = JSON.parse(p.policy);
  }
  settings = deepMerge(settings, JSON.parse(d.settings_override));
  for (const l of JSON.parse(d.locked_override) as string[]) locked.add(l);
  if (d.policy_override) policy = JSON.parse(d.policy_override);

  const lic = db.get<{ key_text: string }>(
    "SELECT key_text FROM licenses WHERE tenant_id = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?) ORDER BY issued_at DESC LIMIT 1",
    d.tenant_id,
    new Date().toISOString(),
  );

  const secretRows = db.all<{ id: string; scope: string; name: string; value_enc: string; version: number; description: string }>(
    `SELECT id, scope, name, value_enc, version, description FROM secrets WHERE tenant_id = ? AND (
       (scope = 'tenant') OR (scope = 'group' AND scope_id = ?) OR (scope = 'device' AND scope_id = ?))`,
    d.tenant_id,
    d.group_id ?? '',
    d.id,
  );
  const rank = { tenant: 0, group: 1, device: 2 } as Record<string, number>;
  const byName = new Map<string, (typeof secretRows)[number]>();
  for (const s of secretRows.sort((a, b) => rank[a.scope] - rank[b.scope])) byName.set(s.name, s);
  const secrets = [...byName.values()].map((s) => ({
    name: s.name,
    value: openString(master, s.value_enc, `secret:${s.id}`),
    version: Number(s.version) * 10 + rank[s.scope],
    description: s.description || null,
  }));

  return {
    version: Number(t.config_version),
    tenantId: t.id,
    tenantName: t.name,
    groupId: g?.id ?? null,
    groupName: g?.name ?? null,
    settings,
    lockedSettings: [...locked].sort(),
    policy,
    license: lic?.key_text ?? null,
    secrets,
    updateChannel: d.update_channel ?? g?.update_channel ?? t.update_channel ?? 'stable',
    pinnedVersion: d.pinned_version ?? g?.pinned_version ?? null,
  };
}
