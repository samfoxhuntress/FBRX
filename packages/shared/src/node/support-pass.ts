import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { canonicalJson } from '../json';
import { base64UrlDecode, base64UrlEncode } from '../license';
import { SUPPORT_PASS_PREFIX, SupportPassSchema, type SupportPass } from '../support';

/**
 * Support passes are signed and verified exactly like license keys (Ed25519, the same control-plane key), so no new
 * trust root is introduced: a build already carries the public keys it needs. A pass is a different token type
 * (`FBRXSUP1`) so it can never be mistaken for a license or join a tenant.
 */

export function signSupportPass(payload: SupportPass, privateKeyPem: string): string {
  const valid = SupportPassSchema.parse(payload);
  const body = base64UrlEncode(new TextEncoder().encode(canonicalJson(valid)));
  const signingInput = `${SUPPORT_PASS_PREFIX}.${body}`;
  const sig = sign(null, Buffer.from(signingInput), createPrivateKey(privateKeyPem));
  return `${signingInput}.${base64UrlEncode(sig)}`;
}

export type SupportPassVerification =
  | { ok: true; payload: SupportPass; expired: boolean }
  | { ok: false; error: string };

export function verifySupportPass(pass: string, publicKeysPem: readonly string[], now = new Date()): SupportPassVerification {
  const parts = pass.trim().split('.');
  if (parts.length !== 3 || parts[0] !== SUPPORT_PASS_PREFIX) return { ok: false, error: 'This is not an FBRX support pass' };
  const signingInput = `${parts[0]}.${parts[1]}`;
  let sig: Uint8Array;
  try {
    sig = base64UrlDecode(parts[2]);
  } catch {
    return { ok: false, error: 'Malformed support pass signature' };
  }
  const trusted = publicKeysPem.filter(Boolean).some((pem) => {
    try {
      return verify(null, Buffer.from(signingInput), createPublicKey(pem), sig);
    } catch {
      return false;
    }
  });
  if (!trusted) return { ok: false, error: 'This support pass is not signed by FBRX' };
  let payload: SupportPass;
  try {
    payload = SupportPassSchema.parse(JSON.parse(new TextDecoder().decode(base64UrlDecode(parts[1]))));
  } catch {
    return { ok: false, error: 'Support pass is invalid' };
  }
  const expired = new Date(payload.expiresAt).getTime() < now.getTime();
  return { ok: true, payload, expired };
}
