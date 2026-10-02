import { GOLDEN_TROPHY, TROPHIES, TROPHY_IDS, type TrophyState } from '@fbrx/shared';
import { CoreError } from '../errors';
import type { EventBus } from '../events';
import type { MetaStore } from '../storage/meta';

const KEY = 'fun.trophies';

/** The easter-egg trophy case (see TROPHIES). Kept in the database, so it travels with backups. */
export class Trophies {
  constructor(
    private readonly d: {
      meta: MetaStore;
      events: EventBus;
      /** Fun extras switched on (Settings → Appearance); nothing is awarded while they are off. */
      enabled: () => boolean;
    },
  ) {}

  state(): TrophyState {
    return { unlocked: { ...(this.d.meta.get<Record<string, string>>(KEY) ?? {}) } };
  }

  has(id: string): boolean {
    return id in this.state().unlocked;
  }

  /** Awards a trophy; the golden one follows by itself once all the others are found. */
  unlock(id: string): { unlocked: boolean; golden: boolean } {
    if (!TROPHY_IDS.includes(id) || id === GOLDEN_TROPHY.id) throw new CoreError('INVALID_ARGUMENT', 'Unknown trophy');
    const all = this.state().unlocked;
    if (!this.d.enabled() || all[id]) return { unlocked: false, golden: GOLDEN_TROPHY.id in all };
    const at = new Date().toISOString();
    all[id] = at;
    const golden = !all[GOLDEN_TROPHY.id] && TROPHIES.every((t) => all[t.id]);
    if (golden) all[GOLDEN_TROPHY.id] = at;
    this.d.meta.set(KEY, all);
    const t = TROPHIES.find((x) => x.id === id)!;
    this.d.events.emit('fun.trophy', { id, name: t.name, at, golden: false });
    if (golden) this.d.events.emit('fun.trophy', { id: GOLDEN_TROPHY.id, name: GOLDEN_TROPHY.name, at, golden: true });
    return { unlocked: true, golden: GOLDEN_TROPHY.id in all };
  }
}
