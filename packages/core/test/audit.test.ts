import { describe, expect, it } from 'vitest';
import { makeKernel } from './helpers';

describe('audit log', () => {
  it('builds a verifiable hash chain and detects tampering', async () => {
    const { kernel, cleanup } = await makeKernel();
    try {
      for (let i = 0; i < 20; i++) kernel.audit.append({ category: 'test', action: `a${i}`, actor: 'me', outcome: 'success', details: { i } });
      const ok = kernel.audit.verify();
      expect(ok.ok).toBe(true);
      expect(ok.checked).toBeGreaterThanOrEqual(20);

      const target = kernel.audit.query({ category: 'test', limit: 1 })[0];
      kernel.db.run('UPDATE audit_log SET details = ? WHERE seq = ?', JSON.stringify({ i: 999 }), target.seq);
      const broken = kernel.audit.verify();
      expect(broken.ok).toBe(false);
      expect(broken.brokenAtSeq).toBe(target.seq);
    } finally {
      await cleanup();
    }
  });

  it('detects deleted entries', async () => {
    const { kernel, cleanup } = await makeKernel();
    try {
      for (let i = 0; i < 5; i++) kernel.audit.append({ category: 'test', action: `a${i}`, actor: 'me', outcome: 'success' });
      const mid = kernel.audit.query({ category: 'test' })[2];
      kernel.db.run('DELETE FROM audit_log WHERE seq = ?', mid.seq);
      expect(kernel.audit.verify().ok).toBe(false);
    } finally {
      await cleanup();
    }
  });

  it('keeps verifying after pruning thanks to the anchor', async () => {
    const { kernel, cleanup } = await makeKernel();
    try {
      for (let i = 0; i < 5; i++) kernel.audit.append({ category: 'test', action: `old${i}`, actor: 'me', outcome: 'success' });
      kernel.db.run("UPDATE audit_log SET ts = '2000-01-01T00:00:00.000Z'");
      // Rewriting ts breaks hashes; re-seal the chain as if those entries were genuinely old.
      const { AuditLog } = await import('../src/audit/audit-log');
      let prev = '0'.repeat(64);
      for (const r of kernel.db.all<any>('SELECT * FROM audit_log ORDER BY seq')) {
        const hash = AuditLog.computeHash(prev, { ...r, details: r.details ? JSON.parse(r.details) : null });
        kernel.db.run('UPDATE audit_log SET prev_hash = ?, hash = ? WHERE seq = ?', prev, hash, r.seq);
        prev = hash;
      }
      (kernel.audit as any).head = null;
      kernel.audit.append({ category: 'test', action: 'new', actor: 'me', outcome: 'success' });
      const removed = kernel.audit.prune(30);
      expect(removed).toBeGreaterThan(0);
      expect(kernel.audit.verify().ok).toBe(true);
    } finally {
      await cleanup();
    }
  });
});
