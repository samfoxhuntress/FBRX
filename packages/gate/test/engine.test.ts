import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { starterConfig, type GateConfig } from '../src/index';
import { GateEngine, GateError, GateStore, SimulatedApplier } from '../src/node/index';

// Engines stop and stores close before their folder goes (Windows keeps open files from being deleted).
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanups.splice(0).reverse()) fn();
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'fbrx-gate-engine-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const store = new GateStore(join(dir, 'gate.db'));
  cleanups.push(() => store.close());
  const applier = new SimulatedApplier();
  const make = () => {
    const e = new GateEngine({ store, applier, paths: { varDir: dir, logDir: dir, etcDir: dir }, initial: () => starterConfig({ wan: 'eno1', lan: 'eno2' }) });
    cleanups.push(() => e.stop());
    return e;
  };
  return { store, applier, engine: make(), make, dir };
}

const edit = (e: GateEngine, fn: (c: GateConfig) => void) => {
  const c = structuredClone(e.candidate());
  fn(c);
  return e.setCandidate(c, 'sam');
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('FBRX Gate commits', () => {
  it('starts from the starter configuration and commits it', async () => {
    const { engine, applier } = setup();
    const s = engine.state();
    expect(s.running).toBeNull();
    expect(s.candidate.networks[0].name).toBe('lan');
    expect(s.changes.length).toBeGreaterThan(0);
    const c = await engine.commit({ by: 'sam', comment: 'First light' });
    expect(c).toMatchObject({ id: 1, by: 'sam', comment: 'First light', status: 'confirmed' });
    expect(applier.applied).toBe(1);
    expect(engine.state().changes).toEqual([]);
    await expect(engine.commit({ by: 'sam' })).rejects.toThrow(/Nothing to commit/);
  });

  it('refuses a configuration with problems, and keeps it to fix', async () => {
    const { engine, applier } = setup();
    const check = edit(engine, (c) => {
      c.networks[0].dhcp.start = '10.0.0.5';
    });
    expect(check.ok).toBe(false);
    expect(engine.state().errors[0].path).toBe('networks.lan.dhcp');
    const err = await engine.commit({ by: 'sam' }).catch((e) => e as GateError);
    expect(err).toBeInstanceOf(GateError);
    expect((err as GateError).issues[0].message).toMatch(/must be inside/);
    expect(applier.applied).toBe(0);
    expect(() => engine.setCandidate({ version: 2 }, 'sam')).toThrow(/wrong shape/);
  });

  it('puts the previous configuration back when applying fails', async () => {
    const { engine, applier } = setup();
    await engine.commit({ by: 'sam' });
    edit(engine, (c) => {
      c.dns.upstream = ['9.9.9.9'];
    });
    applier.failNext = 'dnsmasq would not start';
    await expect(engine.commit({ by: 'sam' })).rejects.toThrow(/could not be applied, so nothing changed: dnsmasq would not start/);
    // The previous configuration was applied again.
    expect(applier.last?.dnsmasq).toContain('server=1.1.1.1');
    expect(engine.running()?.dns.upstream).toEqual(['1.1.1.1', '9.9.9.9']);
    expect(engine.history()[0]).toMatchObject({ status: 'failed', error: 'dnsmasq would not start' });
  });

  it('rolls a commit back unless it is confirmed in time', async () => {
    const { engine, applier } = setup();
    await engine.commit({ by: 'sam' });
    edit(engine, (c) => {
      c.firewall.rules.push({ id: 'lockout', name: 'Oops', enabled: true, from: 'lan', to: 'gate', proto: 'tcp', ports: '9443', action: 'drop', log: false });
    });
    const c = await engine.commit({ by: 'sam', confirmMinutes: 0.01 });
    expect(c.status).toBe('applied');
    expect(engine.state().confirm?.commitId).toBe(c.id);
    expect(applier.last?.nftables).toContain('rule:lockout');
    await expect(engine.commit({ by: 'sam' })).rejects.toThrow(/waiting to be confirmed/);
    await wait(900);
    expect(engine.state().confirm).toBeNull();
    expect(engine.history()[0]).toMatchObject({ id: c.id, status: 'rolled-back', error: 'It was not confirmed in time' });
    expect(applier.last?.nftables).not.toContain('rule:lockout');
    // The candidate still has the change, to fix and try again.
    expect(engine.candidate().firewall.rules[0].id).toBe('lockout');

    // Confirmed in time, it stays.
    const again = await engine.commit({ by: 'sam', confirmMinutes: 0.01 });
    expect(engine.confirm('sam')).toMatchObject({ id: again.id, status: 'confirmed' });
    await wait(900);
    expect(applier.last?.nftables).toContain('rule:lockout');
    engine.stop();
  });

  it('rolls back at start when the gate restarted before a confirmation', async () => {
    const { engine, applier, make } = setup();
    await engine.commit({ by: 'sam' });
    edit(engine, (c) => {
      c.wan.ping = true;
    });
    await engine.commit({ by: 'sam', confirmMinutes: 10 });
    engine.stop();
    const after = make();
    await after.start();
    expect(after.state().confirm).toBeNull();
    expect(after.running()?.wan.ping).toBe(false);
    expect(after.history()[0].error).toMatch(/restarted before it was confirmed/);
    expect(applier.last?.nftables).not.toContain('wan-ping');
  });

  it('goes back to any earlier commit', async () => {
    const { engine } = setup();
    await engine.commit({ by: 'sam' });
    edit(engine, (c) => {
      c.hostname = 'gate-two';
    });
    await engine.commit({ by: 'sam' });
    const back = await engine.rollback({ to: 1, by: 'sam' });
    expect(back.comment).toBe('Back to commit 1');
    expect(engine.running()?.hostname).toBe('fbrx-gate');
    expect(engine.history().map((c) => c.id)).toEqual([3, 2, 1]);
    edit(engine, (c) => {
      c.hostname = 'gate-three';
    });
    expect(engine.reset('sam').candidate.hostname).toBe('fbrx-gate');
  });
});
