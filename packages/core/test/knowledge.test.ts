import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeKernel, USER } from './helpers';
import { runDoctor, type DoctorDeps } from '../src/knowledge/doctor';
import { DEFAULT_SETTINGS, type RuntimeStatus } from '@fbrx/shared';

const ROOT = join(__dirname, '..', '..', '..');
const ctx = { signal: new AbortController().signal } as never;

describe("FBRX's own knowledge", () => {
  it('is generated from the guides, and up to date with them', () => {
    expect(execFileSync(process.execPath, [join(ROOT, 'scripts', 'build-knowledge.mjs'), '--check'], { encoding: 'utf8' })).toMatch(/up to date/);
  });

  it('is a local search database the agent asks with fbrx.help', async () => {
    const { kernel, cleanup } = await makeKernel();
    try {
      expect(kernel.knowledge.count()).toBeGreaterThan(200);
      const slow = await kernel.registry.get('fbrx.help')!.run({ query: 'why is FBRX running so slow', limit: 5 }, ctx);
      expect((slow.data as Array<{ ref: string }>).slice(0, 2).map((h) => h.ref)).toEqual(expect.arrayContaining(['slow-app']));
      const server = await kernel.registry.get('fbrx.help')!.run({ query: 'update fbrx server', limit: 5 }, ctx);
      expect(server.output).toMatch(/fbrx-server update/);
      const cli = await kernel.registry.get('fbrx.help')!.run({ query: 'show version command line', limit: 8 }, ctx);
      expect(cli.output).toMatch(/FBRX\/1/);
      expect((await kernel.registry.get('fbrx.help')!.run({ query: 'xyzzy plugh', limit: 5 }, ctx)).output).toMatch(/Nothing/);
      // Built once; the same version and knowledge keep it.
      expect(kernel.knowledge.build()).toBe(kernel.knowledge.count());
    } finally {
      await cleanup();
    }
  });
});

describe('fbrx.doctor and fbrx.fix', () => {
  const base = (over: Partial<DoctorDeps> = {}): DoctorDeps => ({
    services: () => [],
    logs: () => [],
    runtime: () => ({ state: 'stopped', binaryPath: null, modelId: null, modelFile: null, port: 0, pid: null, endpoint: null, message: null }) as RuntimeStatus,
    modelBytes: () => null,
    settings: () => DEFAULT_SETTINGS,
    scanRunning: () => false,
    shieldWaiting: () => 0,
    databaseBytes: () => 10 * 1024 ** 2,
    diskFreeGb: async () => 200,
    halted: () => false,
    vaultLocked: () => false,
    presenting: () => false,
    updateAvailable: () => null,
    appVersion: '1.9.8',
    rss: () => 300 * 1024 ** 2,
    mem: () => ({ total: 16 * 1024 ** 3, free: 8 * 1024 ** 3 }),
    ...over,
  });

  it('says FBRX looks healthy when it does', async () => {
    expect((await runDoctor(base())).map((f) => f.id)).toEqual(['healthy']);
  });

  it('finds what makes FBRX slow or stuck, each with its fix', async () => {
    const found = await runDoctor(
      base({
        services: () => [{ name: 'mesh', title: 'FBRX Mesh', description: '', state: 'failed', message: 'Port 47860 is in use', startedAt: null, restarts: 4, dependsOn: [] }],
        runtime: () => ({ state: 'running', binaryPath: 'x', modelId: 'big', modelFile: 'big.gguf', port: 1, pid: 1, endpoint: 'x', message: null }) as RuntimeStatus,
        modelBytes: () => 12 * 1024 ** 3,
        mem: () => ({ total: 16 * 1024 ** 3, free: 1 * 1024 ** 3 }),
        settings: () => ({ ...DEFAULT_SETTINGS, runtime: { ...DEFAULT_SETTINGS.runtime, contextSize: 32768 } }),
        scanRunning: () => true,
        shieldWaiting: () => 2034,
        databaseBytes: () => 900 * 1024 ** 2,
        diskFreeGb: async () => 3,
        logs: () => [{ ts: '', level: 'error', scope: 'mesh', message: 'listen EADDRINUSE' }],
        updateAvailable: () => '1.9.9',
      }),
    );
    const byId = Object.fromEntries(found.map((f) => [f.id, f]));
    expect(byId['service:mesh']).toMatchObject({ severity: 'problem', fix: 'restart-service:mesh' });
    expect(byId['model-too-big']).toMatchObject({ severity: 'problem', fix: 'unload-model' });
    expect(byId['memory-low'].fix).toBe('unload-model');
    expect(byId['long-context'].fix).toBe('lower-context');
    expect(byId['scan-running'].fix).toBe('cancel-scan');
    expect(byId['shield-list'].fix).toBe('recheck-shield');
    expect(byId['database'].fix).toBe('compact-database');
    expect(byId['disk'].severity).toBe('problem');
    expect(byId['log-errors'].detail).toMatch(/mesh 1/);
    expect(byId['update'].title).toMatch(/1\.9\.9/);
    expect(byId.healthy).toBeUndefined();
  });

  it('runs on the real FBRX, and its fixes change only what they say, after approval', async () => {
    const { kernel, cleanup } = await makeKernel();
    try {
      const report = await kernel.registry.get('fbrx.doctor')!.run({}, ctx);
      expect(report.output).toMatch(/\[(ok|info|warning|problem)\]/);
      expect(kernel.registry.get('fbrx.fix')!.risk).toBe('write');
      expect(kernel.registry.get('fbrx.doctor')!.risk).toBe('read');
      expect(await kernel.applyFix('cancel-scan')).toBe('No scan is running.');
      expect(await kernel.applyFix('lower-context')).toMatch(/8,192/);
      expect(kernel.settings.get().runtime.contextSize).toBe(8192);
      expect(await kernel.applyFix('compact-database')).toMatch(/Tidied/);
      expect(await kernel.applyFix('recheck-shield')).toMatch(/Cleared 0/);
      await expect(kernel.applyFix('restart-service:nope')).rejects.toThrow(/no service/);
      await expect(kernel.applyFix('format-disk')).rejects.toThrow(/no fix/);
      // The tool only accepts the fixes it knows.
      const denied = await kernel.gate.invoke('fbrx.fix', { fix: 'rm -rf /' }, USER);
      expect(denied.ok).toBe(false);
    } finally {
      await cleanup();
    }
  });
});
