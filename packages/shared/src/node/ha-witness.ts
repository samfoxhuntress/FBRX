import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { HaLeaseRequestSchema, type HaLeaseAnswer, type HaLeaseRequest } from '../ha';

/**
 * The third vote of an FBRX Server pair. The pair's active server holds a lease from it and renews it several times a
 * second; the standby may take over only once that lease has run out, and an active server that can reach neither
 * its partner nor the third vote stops serving before its lease would run out. So the two are never active at once,
 * whatever breaks between them.
 *
 * FBRX Command (for the organization's pairs) and FBRX Server (for another pair) both host it: they keep the keys,
 * this keeps the leases. Requests are signed with the key's secret (the FBRX-Signature header, as FBRX Alerts'
 * webhooks are) and come over HTTPS.
 */

export const HA_WITNESS_SIGNATURE = 'FBRX-Signature';
/** Signed requests travel as text of this type, so the receiver checks the signature over exactly what was sent. */
export const HA_SIGNED_TYPE = 'application/fbrx-signed+json';
/** Signed requests older (or newer) than this are refused. */
const TOLERANCE_S = 30;
/** After a lease runs out, a moment more before someone else may have it (clocks on two machines run apart). */
const GRACE_MS = 250;

export function signHaRequest(body: string, secret: string, at = Math.floor(Date.now() / 1000)): string {
  return `t=${at},v1=${createHmac('sha256', secret).update(`${at}.${body}`).digest('hex')}`;
}

export function verifyHaRequest(body: string, header: string | null | undefined, secret: string, nowS = Math.floor(Date.now() / 1000)): boolean {
  if (!header || !secret) return false;
  const parts = Object.fromEntries(header.split(',').map((p) => p.trim().split('=', 2) as [string, string]));
  const t = Number(parts.t);
  if (!Number.isInteger(t) || !/^[a-f0-9]{64}$/.test(parts.v1 ?? '') || Math.abs(nowS - t) > TOLERANCE_S) return false;
  const want = Buffer.from(createHmac('sha256', secret).update(`${t}.${body}`).digest('hex'));
  const got = Buffer.from(parts.v1!);
  return want.length === got.length && timingSafeEqual(want, got);
}

/** A new third-vote key: its id, its secret, and both as the one string a person pastes into the pair. */
export function newWitnessKey(): { id: string; secret: string; key: string } {
  const id = randomBytes(9).toString('base64url');
  const secret = randomBytes(32).toString('base64url');
  return { id, secret, key: `fbrxw1.${id}.${secret}` };
}

/** What the host keeps of a lease when its holder changes (so a restart does not forget who holds it). */
export interface StoredLease {
  id: string;
  holder: string | null;
  term: number;
  leaseMs: number;
}

export interface HaWitnessOptions {
  /** The secret of a key, or null when there is no such key. */
  secretOf: (id: string) => string | null;
  /** The leases kept before a restart. */
  load?: () => StoredLease[];
  /** Keep a lease whose holder or term changed. */
  save?: (lease: StoredLease) => void;
  /** A key was used (its "last used" time). */
  used?: (id: string) => void;
  /** A monotonic clock in milliseconds (tests). */
  now?: () => number;
}

interface Lease extends StoredLease {
  until: number;
}

export class HaWitnessError extends Error {
  constructor(
    readonly status: 400 | 401,
    message: string,
  ) {
    super(message);
  }
}

export class HaWitness {
  private readonly leases = new Map<string, Lease>();
  private readonly now: () => number;

  constructor(private readonly o: HaWitnessOptions) {
    this.now = o.now ?? (() => performance.now());
    // A lease kept from before a restart counts as just renewed: its holder may still be serving.
    for (const l of o.load?.() ?? []) this.leases.set(l.id, { ...l, until: l.holder ? this.now() + l.leaseMs : 0 });
  }

  /** A signed request from a pair: who may serve. */
  handle(body: string, signature: string | null | undefined): HaLeaseAnswer {
    let req: HaLeaseRequest;
    try {
      req = HaLeaseRequestSchema.parse(JSON.parse(body));
    } catch {
      throw new HaWitnessError(400, 'That is not a request from an FBRX Server pair');
    }
    const secret = this.o.secretOf(req.id);
    if (!secret || !verifyHaRequest(body, signature, secret)) throw new HaWitnessError(401, 'That third-vote key is not right, or it was removed');
    this.o.used?.(req.id);
    return this.decide(req);
  }

  /** The lease rules, once the request is known to come from the pair. */
  decide(req: HaLeaseRequest): HaLeaseAnswer {
    const now = this.now();
    const l = this.leases.get(req.id) ?? { id: req.id, holder: null, term: 0, leaseMs: req.leaseMs, until: 0 };
    const answer = (granted: boolean): HaLeaseAnswer => ({ granted, holder: l.holder, term: l.term, remainingMs: l.holder && !granted ? Math.max(0, Math.round(l.until - now)) : 0 });
    if (req.release) {
      if (l.holder === req.node) {
        l.holder = null;
        l.until = 0;
        this.keep(l, true);
      }
      return answer(false);
    }
    if (l.holder === req.node) {
      // The holder renews (a term it raised is kept).
      l.until = now + req.leaseMs;
      l.leaseMs = req.leaseMs;
      const raised = req.term > l.term;
      if (raised) l.term = req.term;
      this.keep(l, raised);
      return answer(true);
    }
    if (!l.holder || now > l.until + GRACE_MS) {
      // Free, or its holder went quiet: it changes hands, and its term goes up.
      l.holder = req.node;
      l.term = Math.max(l.term + 1, req.term);
      l.leaseMs = req.leaseMs;
      l.until = now + req.leaseMs;
      this.keep(l, true);
      return answer(true);
    }
    return answer(false);
  }

  /** Who holds each pair's lease (for the host's page). */
  holders(): Array<{ id: string; holder: string | null; term: number; remainingMs: number }> {
    const now = this.now();
    return [...this.leases.values()].map((l) => ({ id: l.id, holder: l.holder && now <= l.until ? l.holder : null, term: l.term, remainingMs: Math.max(0, Math.round(l.until - now)) }));
  }

  /** A key was removed: its lease goes too. */
  forget(id: string): void {
    this.leases.delete(id);
  }

  private keep(l: Lease, changed: boolean) {
    this.leases.set(l.id, l);
    if (changed) this.o.save?.({ id: l.id, holder: l.holder, term: l.term, leaseMs: l.leaseMs });
  }
}
