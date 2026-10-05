import {
  AUDIENCES,
  AUTO_UPDATE_MODES,
  EDUCATION_STAFF_DEFAULTS,
  LEARNER_DEFAULTS,
  LEARNER_LOCKED,
  TIERS,
  VERTICALS,
  deepMerge,
  isLearner,
  resolveAudience,
  type Audience,
  type AutoUpdateMode,
  type DeviceConfig,
  type DeviceEdition,
  type Policy,
  type Tier,
  type Vertical,
} from '@fbrx/shared';
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

  const edition = deviceEdition(db, d, t, g);
  // Classroom defaults come first, so the organization's own profiles can change them.
  let settings: Record<string, unknown> = isLearner(edition.audience)
    ? structuredClone(LEARNER_DEFAULTS) as Record<string, unknown>
    : edition.vertical === 'education'
      ? structuredClone(EDUCATION_STAFF_DEFAULTS) as Record<string, unknown>
      : {};
  const locked = new Set<string>(isLearner(edition.audience) ? LEARNER_LOCKED : []);
  // Automatic updates, as the organization (or group) decided: from FBRX Command's releases or the repository.
  settings = deepMerge(settings, { updates: AUTO_UPDATE_SETTINGS[edition.autoUpdate] });
  if (edition.autoUpdate !== 'notify') for (const l of ['updates.autoInstall', 'updates.checkRepo']) locked.add(l);
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
    edition,
  };
}

const AUTO_UPDATE_SETTINGS: Record<AutoUpdateMode, Record<string, boolean>> = {
  off: { autoDownload: false, autoInstall: false, checkRepo: false },
  notify: { checkRepo: true },
  install: { autoDownload: true, autoInstall: true, checkRepo: true },
};

const oneOf = <T extends string>(list: readonly T[], v: unknown): T | null => (typeof v === 'string' && (list as readonly string[]).includes(v) ? (v as T) : null);

/** Who uses the computer and what it may be: the device's own setting, else its group's, else the organization's. */
export function deviceEdition(db: Db, d: any, t: any, g: any): DeviceEdition {
  const vertical = oneOf<Vertical>(VERTICALS, t.vertical) ?? 'business';
  const assigned = oneOf<Audience>(AUDIENCES, d.audience) ?? oneOf<Audience>(AUDIENCES, g?.audience);
  const receivers = Number(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM devices WHERE tenant_id = ? AND helpdesk_receiver = 1 AND status = 'active'", t.id)?.n ?? 0);
  return {
    vertical,
    audience: resolveAudience(vertical, assigned),
    tier: oneOf<Tier>(TIERS, g?.tier),
    helpdesk: { enabled: Number(t.helpdesk_enabled ?? 1) === 1, receiver: Number(d.helpdesk_receiver ?? 0) === 1 && receivers > 0 },
    autoUpdate: oneOf<AutoUpdateMode>(AUTO_UPDATE_MODES, g?.auto_update) ?? oneOf<AutoUpdateMode>(AUTO_UPDATE_MODES, t.auto_update) ?? 'notify',
  };
}
