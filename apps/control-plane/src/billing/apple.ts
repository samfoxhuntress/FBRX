import { X509Certificate, createPublicKey, verify as verifySignature } from 'node:crypto';
import type { EntitlementStatus } from '@fbrx/shared';
import type { CloudConfig } from '../config';

/**
 * App Store purchases (StoreKit 2). The iPhone and iPad app sends the signed transaction it got from StoreKit, and the
 * App Store sends Server Notifications V2 when a subscription renews, fails, is refunded or ends. Both are JWS (ES256)
 * signed by a certificate whose chain is in the header (x5c): the leaf (App Store receipt signing), Apple's Worldwide
 * Developer Relations intermediate, and Apple Root CA - G3. FBRX checks the chain against the Apple root it was given
 * (FBRX_APPLE_ROOT_CA, downloaded from apple.com/certificateauthority), Apple's marker extensions on the leaf and the
 * intermediate, and then the signature. Nothing in a payload is trusted before that.
 */
type AppleConfig = NonNullable<CloudConfig['apple']>;

export class AppleError extends Error {}

/** Apple's marker extensions: on the receipt-signing leaf, and on the WWDR intermediate. */
const LEAF_OID = '1.2.840.113635.100.6.11.1';
const INTERMEDIATE_OID = '1.2.840.113635.100.6.2.1';

function oidBytes(dotted: string): Buffer {
  const parts = dotted.split('.').map(Number);
  const out = [40 * parts[0]! + parts[1]!];
  for (const p of parts.slice(2)) {
    const chunk: number[] = [p & 0x7f];
    for (let v = Math.floor(p / 128); v > 0; v = Math.floor(v / 128)) chunk.unshift((v & 0x7f) | 0x80);
    out.push(...chunk);
  }
  return Buffer.from([0x06, out.length, ...out]);
}

const b64url = (s: string) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

/** Verifies an App Store JWS and returns its payload. */
export function verifyAppleJws<T>(jws: string, cfg: AppleConfig, now = new Date()): T {
  const parts = jws.split('.');
  if (parts.length !== 3) throw new AppleError('Not a signed App Store payload');
  let header: { alg?: string; x5c?: string[] };
  try {
    header = JSON.parse(b64url(parts[0]!).toString('utf8'));
  } catch {
    throw new AppleError('Unreadable App Store payload header');
  }
  if (header.alg !== 'ES256' || !Array.isArray(header.x5c) || header.x5c.length !== 3) throw new AppleError('Unexpected App Store signature');
  const [leaf, intermediate, root] = header.x5c.map((c) => new X509Certificate(Buffer.from(c, 'base64')));
  const trusted = cfg.rootCertificates.map((p) => new X509Certificate(p));
  if (!trusted.some((t) => t.raw.equals(root!.raw))) throw new AppleError('The App Store payload is not signed under the Apple root certificate');
  for (const [cert, issuer] of [
    [leaf!, intermediate!],
    [intermediate!, root!],
  ] as const) {
    if (!cert.checkIssued(issuer) || !cert.verify(issuer.publicKey)) throw new AppleError('The App Store certificate chain does not hold together');
    if (new Date(cert.validFrom) > now || new Date(cert.validTo) < now) throw new AppleError('An App Store certificate is out of date');
  }
  if (!leaf!.raw.includes(oidBytes(LEAF_OID)) || !intermediate!.raw.includes(oidBytes(INTERMEDIATE_OID))) throw new AppleError('Not an App Store signing certificate');
  const ok = verifySignature('sha256', Buffer.from(`${parts[0]}.${parts[1]}`), { key: createPublicKey(leaf!.publicKey.export({ type: 'spki', format: 'pem' })), dsaEncoding: 'ieee-p1363' }, b64url(parts[2]!));
  if (!ok) throw new AppleError('The App Store signature does not match');
  return JSON.parse(b64url(parts[1]!).toString('utf8')) as T;
}

/** The fields of a signed transaction FBRX uses (JWSTransactionDecodedPayload). */
export interface AppleTransaction {
  bundleId: string;
  productId: string;
  transactionId: string;
  originalTransactionId: string;
  /** The UUID the app set at purchase: the FBRX account's app account token. */
  appAccountToken?: string;
  expiresDate?: number;
  revocationDate?: number;
  environment?: string;
  type?: string;
}

export interface AppleNotification {
  notificationType: string;
  subtype?: string;
  notificationUUID: string;
  data?: { bundleId?: string; environment?: string; signedTransactionInfo?: string; signedRenewalInfo?: string; status?: number };
}

/** The renewal info's grace period, when a renewal failed and the App Store is still trying (JWSRenewalInfoDecodedPayload). */
export interface AppleRenewal {
  gracePeriodExpiresDate?: number;
}

/** A purchase made in TestFlight, the sandbox or Xcode: nothing was charged. */
export function appleTestPurchase(environment: string | undefined): boolean {
  return !!environment && environment !== 'Production';
}

/** A transaction's state: revoked (refunded) ends it, otherwise it counts until it expires. */
export function appleStatus(t: AppleTransaction, notification?: { type: string; subtype?: string }, renewal?: AppleRenewal, now = Date.now()): { status: EntitlementStatus; periodEnd: string | null } {
  const end = Math.max(t.expiresDate ?? 0, renewal?.gracePeriodExpiresDate ?? 0);
  const periodEnd = end ? new Date(end).toISOString() : null;
  if (t.revocationDate || notification?.type === 'REVOKE' || notification?.type === 'REFUND') return { status: 'expired', periodEnd };
  if (notification?.type === 'EXPIRED' || notification?.type === 'GRACE_PERIOD_EXPIRED') return { status: 'expired', periodEnd };
  if (notification?.type === 'DID_FAIL_TO_RENEW') return { status: renewal?.gracePeriodExpiresDate && renewal.gracePeriodExpiresDate > now ? 'grace' : 'expired', periodEnd };
  if (notification?.type === 'DID_CHANGE_RENEWAL_STATUS' && notification.subtype === 'AUTO_RENEW_DISABLED') return { status: 'canceled', periodEnd };
  return { status: end && end <= now ? 'expired' : 'active', periodEnd };
}
