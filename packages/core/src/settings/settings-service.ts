import {
  DEFAULT_SETTINGS,
  SettingsSchema,
  deepMerge,
  isPathLocked,
  leafPaths,
  type DeepPartial,
  type EffectiveSettings,
  type Settings,
} from '@fbrx/shared';
import { CoreError } from '../errors';
import type { Db } from '../storage/db';
import type { EventBus } from '../events';

type Layer = 'local' | 'managed';

/**
 * Layered configuration: built-in defaults ← local (user) ← managed (control plane).
 * Managed values win and any path the organization locks is read-only on the workstation.
 */
export class SettingsService {
  private cache: EffectiveSettings | null = null;
  private listeners = new Set<(s: EffectiveSettings, prev: Settings | null) => void>();

  constructor(
    private readonly db: Db,
    private readonly events?: EventBus,
  ) {}

  private layer(layer: Layer): { data: Record<string, unknown>; locked: string[] } {
    const row = this.db.get<{ data: string; locked: string }>('SELECT data, locked FROM settings_layers WHERE layer = ?', layer);
    return row ? { data: JSON.parse(row.data), locked: JSON.parse(row.locked) } : { data: {}, locked: [] };
  }

  private writeLayer(layer: Layer, data: unknown, locked: string[]) {
    this.db.run(
      `INSERT INTO settings_layers (layer, data, locked, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(layer) DO UPDATE SET data = excluded.data, locked = excluded.locked, updated_at = excluded.updated_at`,
      layer,
      JSON.stringify(data),
      JSON.stringify(locked),
      new Date().toISOString(),
    );
  }

  effective(): EffectiveSettings {
    if (this.cache) return this.cache;
    const local = this.migrate(this.layer('local'));
    const managed = this.layer('managed');
    let merged = deepMerge(structuredClone(DEFAULT_SETTINGS), local.data);
    merged = deepMerge(merged, managed.data);
    const parsed = SettingsSchema.safeParse(merged);
    // A corrupt layer must never brick the app: fall back to defaults + managed.
    const settings = parsed.success ? parsed.data : SettingsSchema.parse(deepMerge(structuredClone(DEFAULT_SETTINGS), managed.data));
    this.cache = { settings, locked: managed.locked };
    return this.cache;
  }

  /** One-time upgrades of values saved by older versions. */
  private migrate(local: { data: Record<string, unknown>; locked: string[] }) {
    // Upgrades already applied are listed in the local layer (the schema ignores the key).
    const done = new Set(Array.isArray(local.data._migrated) ? (local.data._migrated as string[]) : []);
    if (done.has('agent-name-1.4')) return local;
    const ai = local.data.ai as { agentName?: string } | undefined;
    // The agent was called Fabric before 1.4.0; a saved old default becomes the new one (once).
    if (ai?.agentName === 'Fabric') ai.agentName = 'Fabrix';
    local.data._migrated = [...done, 'agent-name-1.4'];
    this.writeLayer('local', local.data, local.locked);
    return local;
  }

  get(): Settings {
    return this.effective().settings;
  }

  /** Applies a user/local change. Rejects edits to locked paths. */
  update(patch: DeepPartial<Settings>): EffectiveSettings {
    const { locked } = this.effective();
    const touched = leafPaths(patch);
    const blocked = touched.filter((p) => isPathLocked(p, locked));
    if (blocked.length) {
      throw new CoreError('MANAGED', `These settings are managed by your organization: ${blocked.join(', ')}`);
    }
    const local = this.layer('local');
    const nextLocal = deepMerge(local.data, patch);
    const candidate = deepMerge(deepMerge(structuredClone(DEFAULT_SETTINGS), nextLocal), this.layer('managed').data);
    const parsed = SettingsSchema.safeParse(candidate);
    if (!parsed.success) throw parsed.error;
    const ids = parsed.data.ai.providers.map((p) => p.id);
    if (new Set(ids).size !== ids.length) throw new CoreError('INVALID_ARGUMENT', 'Provider ids must be unique');
    this.writeLayer('local', nextLocal, []);
    return this.invalidate();
  }

  /** Replaces the managed layer (from the control plane). */
  applyManaged(data: Record<string, unknown>, locked: string[]): EffectiveSettings {
    const candidate = deepMerge(deepMerge(structuredClone(DEFAULT_SETTINGS), this.layer('local').data), data);
    const parsed = SettingsSchema.safeParse(candidate);
    if (!parsed.success) throw new CoreError('INVALID_ARGUMENT', `Managed settings rejected: ${parsed.error.message}`);
    this.writeLayer('managed', data, locked);
    return this.invalidate();
  }

  clearManaged(): EffectiveSettings {
    this.db.run("DELETE FROM settings_layers WHERE layer = 'managed'");
    return this.invalidate();
  }

  onChange(cb: (s: EffectiveSettings, prev: Settings | null) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private invalidate(): EffectiveSettings {
    const prev = this.cache?.settings ?? null;
    this.cache = null;
    const next = this.effective();
    for (const l of this.listeners) l(next, prev);
    this.events?.emit('settings.changed', next);
    return next;
  }
}
