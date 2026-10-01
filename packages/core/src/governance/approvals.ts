import { newId, type ApprovalRequest } from '@fbrx/shared';
import type { EventBus } from '../events';

type Decision = 'approve' | 'deny';

interface Pending {
  request: ApprovalRequest;
  resolve: (d: { decision: Decision | 'expired'; remember: boolean; by: string }) => void;
  timer: NodeJS.Timeout;
}

/** Human-in-the-loop queue. Requests surface in the desktop UI (and to the Local API) until resolved or expired. */
export class ApprovalQueue {
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly events?: EventBus) {}

  request(
    input: Omit<ApprovalRequest, 'id' | 'requestedAt' | 'expiresAt'>,
    timeoutSeconds: number,
    signal?: AbortSignal,
  ): Promise<{ decision: Decision | 'expired'; remember: boolean; by: string }> {
    const id = newId('apr');
    const now = Date.now();
    const request: ApprovalRequest = {
      ...input,
      id,
      requestedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + timeoutSeconds * 1000).toISOString(),
    };
    return new Promise((resolve) => {
      const finish = (d: { decision: Decision | 'expired'; remember: boolean; by: string }) => {
        const p = this.pending.get(id);
        if (!p) return;
        clearTimeout(p.timer);
        this.pending.delete(id);
        signal?.removeEventListener('abort', onAbort);
        this.events?.emit('approval.resolved', { id, decision: d.decision, by: d.by });
        resolve(d);
      };
      const onAbort = () => finish({ decision: 'deny', remember: false, by: 'cancelled' });
      const timer = setTimeout(() => finish({ decision: 'expired', remember: false, by: 'timeout' }), timeoutSeconds * 1000);
      this.pending.set(id, { request, resolve: finish, timer });
      signal?.addEventListener('abort', onAbort, { once: true });
      this.events?.emit('approval.requested', request);
    });
  }

  resolve(id: string, decision: Decision, by: string, remember = false): boolean {
    const p = this.pending.get(id);
    if (!p) return false;
    p.resolve({ decision, remember, by });
    return true;
  }

  list(): ApprovalRequest[] {
    return [...this.pending.values()].map((p) => p.request);
  }

  get size(): number {
    return this.pending.size;
  }

  denyAll(by: string): void {
    for (const id of [...this.pending.keys()]) this.resolve(id, 'deny', by);
  }
}
