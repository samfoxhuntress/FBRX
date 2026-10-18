import { ALL_FEATURES, EDITION_PLANS, FEATURES, FREE_GRACE_DAYS, LEARNER_TIER, formatPrice, isLearner, maxTier, minTier, narrowTier, parseSemver, parseTier, TIER_NAMES, TIER_SHORT, tierRank, type CeilingReason, type DeviceEdition, type Feature, type LicenseStatus, type Tier } from '@fbrx/shared';
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
    // A free spell of Standard (after an update from before 2.0) ends by itself: look again once it is over.
    if (this.cached && !(this.cached.graceUntil && Date.parse(this.cached.graceUntil) <= Date.now())) return this.cached;
    const major = parseSemver(this.appVersion)?.major ?? 1;
    const managed = this.meta.get<string>('license.managed');
    const local = this.meta.get<string>('license.local');
    const account = this.meta.get<string>('license.account');
    // The organization's license wins; otherwise the fuller of a key typed in and the FBRX account's.
    let status = managed ? licenseStatusFrom(managed, this.publicKeys, 'managed', major) : licenseStatusFrom(local, this.publicKeys, 'local', major);
    if (!managed && account) {
      const fromAccount = licenseStatusFrom(account, this.publicKeys, 'account', major);
      if (fromAccount.state === 'valid' && (status.state !== 'valid' || tierRank(fromAccount.tier) > tierRank(status.tier))) status = fromAccount;
    }
    // Development builds may run Black Hole with everything on, unless FBRX_EDITION asks to try a lighter edition
    // (then they start there, like a computer on its own that may run it).
    const asked = this.devMode ? parseTier(process.env.FBRX_EDITION) : null;
    const tryTier = asked === 'blackhole' ? null : asked;
    if (this.devMode && status.state !== 'valid' && !tryTier) {
      status = {
        ...status,
        state: 'development',
        edition: 'enterprise',
        tier: 'blackhole',
        features: [...ALL_FEATURES],
        source: 'development',
        message: 'Development build: all features unlocked',
      };
    }
    // The most this computer may run.
    // - In an organization: what its license allows, held lower by FBRX Command for the computer or its group.
    // - On its own: Essentials, unless something was bought: a license key (or a purchase on the person's FBRX
    //   account) goes up to Ultra. A license that belongs to an organization (it names its FBRX Command) counts only
    //   there. Black Hole comes only through an organization.
    // - A computer set up before 2.0 keeps Standard, free, for a while after it updates (see beginGrace).
    // Student and child computers always run the learner edition, on Standard (LEARNER_TIER).
    const ed = this.meta.get<DeviceEdition>('fleet.edition');
    const enrolled = !!this.meta.get<string>('fleet.deviceId');
    let ceiling: Tier = status.tier;
    let reason: CeilingReason = 'license';
    let graceUntil: string | null = null;
    if (status.source === 'development') reason = 'development';
    else if (!enrolled) {
      const bought = status.state === 'valid' && !status.commandUrl;
      const grace = this.meta.get<{ tier: Tier; until: string }>('edition.grace');
      ceiling = bought ? minTier(status.tier, 'ultra') : 'essentials';
      reason = bought ? 'license' : 'standalone';
      if (grace && Date.parse(grace.until) > Date.now() && tierRank(grace.tier) > tierRank(ceiling)) {
        ceiling = grace.tier;
        reason = 'grace';
        graceUntil = grace.until;
      }
      if (tryTier) ceiling = maxTier(ceiling, tryTier);
    }
    if (ed?.tier && tierRank(ed.tier) < tierRank(ceiling)) {
      ceiling = narrowTier(ceiling, ed.tier);
      reason = 'organization';
    }
    if (ed && isLearner(ed.audience)) return (this.cached = { ...status, tier: LEARNER_TIER, chosen: LEARNER_TIER, ceiling: LEARNER_TIER, ceilingReason: 'learner', graceUntil: null });
    // What the person chose (Essentials on a new computer; see Kernel's first start), never above the ceiling.
    const chosen = this.meta.get<Tier>('edition.chosen') ?? (this.devMode ? (tryTier ?? 'blackhole') : 'essentials');
    this.cached = { ...status, tier: minTier(chosen, ceiling), chosen, ceiling, ceilingReason: reason, graceUntil };
    return this.cached;
  }

  /**
   * Standard is no longer free on a computer on its own from 2.0. A computer that ran FBRX before keeps it, free, for
   * FREE_GRACE_DAYS after it first starts 2.0 (once; a new computer gets no grace).
   */
  beginGrace(setUpBefore: boolean): void {
    if (this.meta.get<boolean>('edition.v2')) return;
    if (setUpBefore) this.meta.set('edition.grace', { tier: 'basic', until: new Date(Date.now() + FREE_GRACE_DAYS * 86_400_000).toISOString() });
    this.meta.set('edition.v2', true);
    this.cached = null;
  }

  /** The edition the person wants (Settings → Edition): anything up to what this computer may run. */
  choose(tier: Tier): LicenseStatus {
    const now = this.status();
    if (now.ceilingReason === 'learner') throw new CoreError('FORBIDDEN', 'This computer runs the learner edition chosen by your organization');
    if (now.ceiling && tierRank(tier) > tierRank(now.ceiling)) throw new CoreError('FORBIDDEN', this.whyNot(tier, now));
    this.meta.set('edition.chosen', tier);
    return this.changed();
  }

  /** Why this computer cannot run `tier`, and how it could. */
  private whyNot(tier: Tier, now: LicenseStatus): string {
    const ceiling = now.ceiling ?? now.tier;
    if (now.ceilingReason === 'organization') return `Your organization holds this computer to ${TIER_NAMES[ceiling]} (in FBRX Command)`;
    const enrolled = !!this.meta.get<string>('fleet.deviceId');
    if (enrolled) return `Your organization's license allows up to ${TIER_NAMES[ceiling]}`;
    const plan = EDITION_PLANS[tier];
    if (plan.monthly == null) return `${TIER_NAMES[tier]} comes only through an organization's FBRX Command: once it adds this computer and gives it ${TIER_SHORT[tier]}, it unlocks here`;
    return `${TIER_NAMES[tier]} is ${formatPrice(plan.monthly)} a month on your FBRX account (or with a license key in Settings → License)`;
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

  /** The license the person's FBRX account gives this computer (null when they sign out or bought nothing). */
  applyAccount(key: string | null): LicenseStatus {
    if (key) this.meta.set('license.account', key);
    else this.meta.delete('license.account');
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
