import { SignJWT, importPKCS8 } from 'jose';
import type { EntitlementStatus } from '@fbrx/shared';
import type { CloudConfig } from '../config';

/**
 * Google Play purchases. The Android app sends the purchase token Play Billing gave it; FBRX asks the Play Developer
 * API (purchases.subscriptionsv2) what that purchase is, with a service account, and acknowledges it (Play refunds
 * purchases nobody acknowledges within three days). Real-time developer notifications arrive through Cloud Pub/Sub
 * push, to a URL with a secret token in it; FBRX never trusts what a notification says, it asks the API again.
 */
type GoogleConfig = NonNullable<CloudConfig['google']>;

export class GoogleError extends Error {}

const SCOPE = 'https://www.googleapis.com/auth/androidpublisher';

/** What purchases.subscriptionsv2.get answers (the fields FBRX uses). */
export interface PlaySubscription {
  subscriptionState: string;
  acknowledgementState?: string;
  linkedPurchaseToken?: string;
  lineItems: Array<{ productId: string; expiryTime?: string }>;
  externalAccountIdentifiers?: { obfuscatedExternalAccountId?: string };
}

export class GooglePlay {
  private token: { value: string; until: number } | null = null;

  constructor(private readonly cfg: GoogleConfig) {}

  /** An OAuth access token for the service account (JWT bearer grant), reused until a minute before it ends. */
  private async accessToken(): Promise<string> {
    if (this.token && this.token.until > Date.now() + 60_000) return this.token.value;
    const sa = this.cfg.serviceAccount;
    const key = await importPKCS8(sa.privateKey, 'RS256');
    const assertion = await new SignJWT({ scope: SCOPE })
      .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
      .setIssuer(sa.clientEmail)
      .setAudience(sa.tokenUri)
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(key);
    const res = await fetch(sa.tokenUri, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
      signal: AbortSignal.timeout(20_000),
    });
    const json = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error_description?: string };
    if (!res.ok || !json.access_token) throw new GoogleError(`Google sign-in for the Play Developer API failed: ${json.error_description ?? `HTTP ${res.status}`}`);
    this.token = { value: json.access_token, until: Date.now() + (json.expires_in ?? 3600) * 1000 };
    return json.access_token;
  }

  private async call<T>(method: 'GET' | 'POST', path: string): Promise<T> {
    const res = await fetch(`${this.cfg.apiBase}/androidpublisher/v3/applications/${encodeURIComponent(this.cfg.packageName)}${path}`, {
      method,
      headers: { authorization: `Bearer ${await this.accessToken()}`, ...(method === 'POST' ? { 'content-type': 'application/json' } : {}) },
      body: method === 'POST' ? '{}' : undefined,
      signal: AbortSignal.timeout(20_000),
    });
    const json = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    if (!res.ok) throw new GoogleError(`Google Play: ${json.error?.message ?? `HTTP ${res.status}`}`);
    return json as T;
  }

  subscription(purchaseToken: string): Promise<PlaySubscription> {
    return this.call('GET', `/purchases/subscriptionsv2/tokens/${encodeURIComponent(purchaseToken)}`);
  }

  async acknowledge(productId: string, purchaseToken: string): Promise<void> {
    await this.call('POST', `/purchases/subscriptions/${encodeURIComponent(productId)}/tokens/${encodeURIComponent(purchaseToken)}:acknowledge`);
  }
}

/** A Play subscription's state: canceled ones count until they expire; on hold or paused ones do not. */
export function playStatus(state: string): EntitlementStatus {
  switch (state) {
    case 'SUBSCRIPTION_STATE_ACTIVE':
      return 'active';
    case 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD':
      return 'grace';
    case 'SUBSCRIPTION_STATE_CANCELED':
      return 'canceled';
    case 'SUBSCRIPTION_STATE_PENDING':
      return 'pending';
    default:
      // ON_HOLD, PAUSED, EXPIRED, PENDING_PURCHASE_CANCELED
      return 'expired';
  }
}
