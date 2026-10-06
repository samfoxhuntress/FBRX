import type { FastifyBaseLogger, FastifyReply, FastifyRequest } from 'fastify';
import type { VirtualRole, VirtualUser } from '@fbrx/shared';
import type { Db } from '@fbrx/shared/node';
import type { VirtualConfig } from './config';
import type { Hypervisor } from './drivers/types';
import type { Audit } from './audit';
import type { Auth } from './auth';
import type { IsoLibrary } from './isos';
import type { HardwareService } from './hardware/service';
import type { BmcService } from './bmc/service';
import type { ConsoleTickets } from './console-proxy';
import { allows } from './auth';
import { forbidden, unauthorized } from './errors';

export interface VirtualContext {
  config: VirtualConfig;
  version: string;
  db: Db;
  hv: Hypervisor;
  auth: Auth;
  audit: Audit;
  isos: IsoLibrary;
  hardware: HardwareService;
  bmc: BmcService;
  tickets: ConsoleTickets;
  log: FastifyBaseLogger;
  tls: { fingerprint: string; selfSigned: boolean; notAfter: string } | null;
}

declare module 'fastify' {
  interface FastifyRequest {
    user: VirtualUser | null;
    token: string | null;
  }
}

export function bearer(req: FastifyRequest): string | null {
  const h = req.headers.authorization;
  return h?.startsWith('Bearer ') ? h.slice(7).trim() : null;
}

/** The signed-in person, who must have at least this role. */
export function need(req: FastifyRequest, role: VirtualRole): VirtualUser {
  if (!req.user) throw unauthorized();
  if (!allows(req.user.role, role)) throw forbidden(role === 'admin' ? 'Only administrators can do this' : 'Viewers can look but not change things');
  return req.user;
}

/** Runs a change and writes it to the audit log, failures included. */
export async function audited<T>(ctx: VirtualContext, req: FastifyRequest, action: string, target: string | null, fn: () => Promise<T> | T, details?: unknown): Promise<T> {
  const actor = req.user?.username ?? 'anonymous';
  try {
    const out = await fn();
    ctx.audit.record(actor, action, target, 'success', details ?? null);
    return out;
  } catch (e) {
    ctx.audit.record(actor, action, target, 'failure', { error: e instanceof Error ? e.message : String(e), ...(details && typeof details === 'object' ? details : {}) });
    throw e;
  }
}

export type Reply = FastifyReply;
