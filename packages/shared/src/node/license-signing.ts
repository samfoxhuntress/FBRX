import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import { canonicalJson } from '../json';
import {
  LICENSE_PREFIX,
  LicensePayloadSchema,
  base64UrlDecode,
  base64UrlEncode,
  featuresFor,
  tierFor,
  type LicensePayload,
  type LicenseStatus,
} from '../license';

export interface SigningKeyPair {
  publicKeyPem: string;
  privateKeyPem: string;
}

export function generateSigningKeyPair(): SigningKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}

export function publicKeyFromPrivate(privateKeyPem: string): string {
  return createPublicKey(createPrivateKey(privateKeyPem)).export({ type: 'spki', format: 'pem' }).toString();
}

export function signLicense(payload: LicensePayload, privateKeyPem: string): string {
  const valid = LicensePayloadSchema.parse(payload);
  const body = base64UrlEncode(new TextEncoder().encode(canonicalJson(valid)));
  const signingInput = `${LICENSE_PREFIX}.${body}`;
  const sig = sign(null, Buffer.from(signingInput), createPrivateKey(privateKeyPem));
  return `${signingInput}.${base64UrlEncode(sig)}`;
}

export type LicenseVerification =
  | { ok: true; payload: LicensePayload; expired: boolean }
  | { ok: false; error: string };

export function verifyLicense(key: string, publicKeysPem: readonly string[], now = new Date()): LicenseVerification {
  const parts = key.trim().split('.');
  if (parts.length !== 3 || parts[0] !== LICENSE_PREFIX) return { ok: false, error: 'Malformed license key' };
  const signingInput = `${parts[0]}.${parts[1]}`;
  let sig: Uint8Array;
  try {
    sig = base64UrlDecode(parts[2]);
  } catch {
    return { ok: false, error: 'Malformed license signature' };
  }
  const trusted = publicKeysPem.filter(Boolean).some((pem) => {
    try {
      return verify(null, Buffer.from(signingInput), createPublicKey(pem), sig);
    } catch {
      return false;
    }
  });
  if (!trusted) return { ok: false, error: 'License signature is not trusted by this build' };
  let payload: LicensePayload;
  try {
    payload = LicensePayloadSchema.parse(JSON.parse(new TextDecoder().decode(base64UrlDecode(parts[1]))));
  } catch {
    return { ok: false, error: 'License payload is invalid' };
  }
  const expired = payload.expiresAt !== null && new Date(payload.expiresAt).getTime() < now.getTime();
  return { ok: true, payload, expired };
}

export function licenseStatusFrom(
  key: string | null,
  publicKeysPem: readonly string[],
  source: LicenseStatus['source'],
  appMajorVersion: number,
): LicenseStatus {
  const base: LicenseStatus = {
    state: 'unlicensed',
    edition: 'community',
    tier: 'basic',
    customer: null,
    tenantId: null,
    licenseId: null,
    seats: null,
    expiresAt: null,
    features: featuresFor({ edition: 'community', features: [] }),
    message: null,
    source: 'none',
    commandUrl: null,
    vertical: null,
  };
  if (!key) return base;
  const v = verifyLicense(key, publicKeysPem);
  if (!v.ok) return { ...base, state: 'invalid', message: v.error, source };
  const p = v.payload;
  const info = {
    customer: p.customer,
    tenantId: p.tenantId,
    licenseId: p.lid,
    seats: p.seats,
    expiresAt: p.expiresAt,
    source,
    commandUrl: p.command?.url ?? null,
    vertical: p.vertical ?? null,
  };
  if (v.expired) return { ...base, ...info, state: 'expired', message: 'License has expired; running with Community features' };
  if (p.maxMajorVersion !== null && appMajorVersion > p.maxMajorVersion) {
    return { ...base, ...info, state: 'invalid', message: `License covers versions up to ${p.maxMajorVersion}.x` };
  }
  return { ...base, ...info, state: 'valid', edition: p.edition, tier: tierFor(p.edition, p.tier), features: featuresFor(p), message: null };
}
