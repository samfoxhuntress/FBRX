import { ALL_FEATURES, FEATURES, parseSemver, type Feature, type LicenseStatus } from '@fbrx/shared';
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
    // Development builds run as Ultra with everything on, unless FBRX_EDITION=basic asks to try Endpoint Basic.
    if (this.devMode && status.state !== 'valid' && process.env.FBRX_EDITION !== 'basic') {
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
    this.cached = status;
    return status;
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
