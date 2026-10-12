import { ALL_FEATURES, FEATURES, isLearner, minTier, narrowTier, parseSemver, parseTier, TIER_NAMES, tierRank, type DeviceEdition, type Feature, type LicenseStatus, type Tier } from '@fbrx/shared';
import { licenseStatusFrom, verifyLicense } from '@fbrx/shared/node';
import { CoreError } from '../errors';
import type { MetaStore } from '../storage/meta';
import type { EventBus } from '../events';

/**
 * Offline license verification. Keys are Ed25519-signed by the vendor's control plane; the public key is
 * embedded in each build, so licenses cannot be forged by running a private server.
 */
export class LicenseService {
  private cached: LicenseStatus | null = null;

  constructor(
    private readonly meta: MetaStore,
    private readonly publicKeys: string[],
    private readonly appVersion: string,
    private readonly devMode: boolean,
    private readonly events?: EventBus,
  ) {}

  status(): LicenseStatus {
    if (this.cached) return this.cached;
    const major = parseSemver(this.appVersion)?.major ?? 1;
    const managed = this.meta.get<string>('license.managed');
    const local = this.meta.get<string>('license.local');
    let status = managed
      ? licenseStatusFrom(managed, this.publicKeys, 'managed', major)
      : licenseStatusFrom(local, this.publicKeys, 'local', major);
    // Development builds may run Ultra with everything on, unless FBRX_EDITION asks to try a lighter edition (then
    // they start there, like a computer on its own).
    const asked = this.devMode ? parseTier(process.env.FBRX_EDITION) : null;
    const tryTier = asked === 'ultra' ? null : asked;
    if (this.devMode && status.state !== 'valid' && !tryTier) {
      status = {
        ...status,
        state: 'development',
        edition: 'enterprise',
        tier: 'ultra',
        features: [...ALL_FEATURES],
        source: 'development',
        message: 'Development build: all features unlocked',
      };
    }
    // The most this computer may run. On its own: Standard (Ultra comes only through FBRX Command). In an organization:
    // what its license allows, held lower by FBRX Command for the computer or its group. Student and child computers
    // always run the learner edition on Standard.
    const ed = this.meta.get<DeviceEdition>('fleet.edition');
    const enrolled = !!this.meta.get<string>('fleet.deviceId');
    let ceiling: Tier = status.tier;
    let reason: NonNullable<LicenseStatus['ceilingReason']> = status.source === 'development' ? 'development' : enrolled ? 'license' : 'standalone';
    if (!enrolled && status.source !== 'development') ceiling = minTier(ceiling, 'basic');
    if (ed?.tier && tierRank(ed.tier) < tierRank(ceiling)) {
      ceiling = narrowTier(ceiling, ed.tier);
      reason = 'organization';
    }
    if (ed && isLearner(ed.audience)) return (this.cached = { ...status, tier: 'basic', chosen: 'basic', ceiling: 'basic', ceilingReason: 'learner' });
    // What the person chose (Essentials on a new computer; see Kernel's first start), never above the ceiling.
    const chosen = this.meta.get<Tier>('edition.chosen') ?? (this.devMode ? (tryTier ?? 'ultra') : 'essentials');
    this.cached = { ...status, tier: minTier(chosen, ceiling), chosen, ceiling, ceilingReason: reason };
    return this.cached;
  }

  /** The edition the person wants (Settings → Edition): Essentials or Standard any time, Ultra when it is allowed. */
  choose(tier: Tier): LicenseStatus {
    const now = this.status();
    if (now.ceilingReason === 'learner') throw new CoreError('FORBIDDEN', 'This computer runs the learner edition chosen by your organization');
    if (now.ceiling && tierRank(tier) > tierRank(now.ceiling)) {
      throw new CoreError(
        'FORBIDDEN',
        now.ceilingReason === 'standalone'
          ? `${TIER_NAMES[tier]} comes through FBRX Command: once your organization adds this computer and allows it, it unlocks here`
          : now.ceilingReason === 'organization'
            ? `Your organization holds this computer to ${TIER_NAMES[now.ceiling]} (in FBRX Command)`
            : `Your organization's license allows up to ${TIER_NAMES[now.ceiling]}`,
      );
    }
    this.meta.set('edition.chosen', tier);
    return this.changed();
  }

  /** Re-reads the license and edition (after FBRX Command changed what this computer is). */
  refresh(): LicenseStatus {
    return this.changed();
  }

  has(feature: Feature): boolean {
    return this.status().features.includes(feature);
  }

  require(feature: Feature): void {
    if (!this.has(feature)) {
      throw new CoreError('FEATURE_UNAVAILABLE', `"${FEATURES[feature]}" is not included in your ${this.status().edition} license`);
    }
  }

  activate(key: string): LicenseStatus {
    const v = verifyLicense(key, this.publicKeys);
    if (!v.ok) throw new CoreError('INVALID_ARGUMENT', v.error);
    if (v.expired) throw new CoreError('INVALID_ARGUMENT', 'This license has expired');
    this.meta.set('license.local', key.trim());
    return this.changed();
  }

  remove(): LicenseStatus {
    this.meta.delete('license.local');
    return this.changed();
  }

  applyManaged(key: string | null): LicenseStatus {
    if (key) this.meta.set('license.managed', key);
    else this.meta.delete('license.managed');
    return this.changed();
  }

  private changed(): LicenseStatus {
    this.cached = null;
    const s = this.status();
    this.events?.emit('license.changed', s);
    return s;
  }
}
