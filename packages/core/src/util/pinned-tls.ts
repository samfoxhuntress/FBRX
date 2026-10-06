import type { Agent } from 'node:https';
import * as pin from '@fbrx/shared/node';
import { CoreError } from '../errors';

/** Certificate pinning (see @fbrx/shared/node pinned-tls), throwing FBRX Endpoint's own errors. */

export { formatFingerprint, normalizeFingerprint, sameFingerprint, type PresentedCertificate } from '@fbrx/shared/node';

const err: pin.PinErrorFactory = (code, message) => new CoreError(code, message);

export function pinnedAgent(fingerprint: string, mismatch?: string): Agent {
  return pin.pinnedAgent(fingerprint, mismatch, err);
}

export function peerCertificate(url: string, timeoutMs?: number): Promise<pin.PresentedCertificate> {
  return pin.peerCertificate(url, timeoutMs, err);
}

export function pinnedFetch(url: string, init: RequestInit & { duplex?: 'half' }, agent: Agent): Promise<Response> {
  return pin.pinnedFetch(url, init, agent, err);
}
