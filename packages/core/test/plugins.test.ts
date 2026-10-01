import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as tar from 'tar';
import { makeKernel, tempDir, USER, waitFor } from './helpers';

const EXAMPLE = resolve(__dirname, '../../../plugins/example-toolkit');
const AGENT = { origin: 'agent' as const, actor: 'agent:test' };

describe('plugins', () => {
  it('installs the example plugin, runs its tools in a sandboxed worker and governs them', async () => {
    const { kernel, cleanup } = await makeKernel();
    try {
      const info = (await kernel.call('plugins.install', { path: EXAMPLE }, USER)) as any;
      expect(info).toMatchObject({ id: 'com.fbrx.example-toolkit', state: 'running' });
      expect(info.tools).toEqual(expect.arrayContaining(['toolkit.text_stats', 'toolkit.counter', 'toolkit.github_repo']));

      const stats = await kernel.gate.invoke('toolkit.text_stats', { text: 'one two three\nfour' }, AGENT);
      expect(stats.status).toBe('succeeded');
      expect(stats.data).toMatchObject({ words: 4, lines: 2 });

      // `counter` is a write tool → needs approval when the agent calls it; the person approves.
      const pending = kernel.gate.invoke('toolkit.counter', { name: 'x', by: 2 }, AGENT);
      const req = await waitFor(() => kernel.approvals.list()[0]);
      kernel.approvals.resolve(req.id, 'approve', 'tester');
      expect((await pending).output).toBe('x = 2');
      // Storage persisted through the host.
      expect((await kernel.gate.invoke('toolkit.counter', { name: 'x', by: 3 }, USER)).output).toBe('x = 5');

      const disabled = (await kernel.call('plugins.setEnabled', { id: info.id, enabled: false }, USER)) as any;
      expect(disabled.state).toBe('stopped');
      expect(kernel.registry.get('toolkit.text_stats')).toBeUndefined();
      expect(kernel.audit.query({ category: 'plugin' }).map((e) => e.action)).toEqual(expect.arrayContaining(['installed', 'disabled']));
    } finally {
      await cleanup();
    }
  });

  it('enforces declared permissions and the filesystem sandbox', async () => {
    const { kernel, sandbox, cleanup } = await makeKernel();
    const dir = tempDir('fbrx-plugin-');
    writeFileSync(
      join(dir, 'fbrx-plugin.json'),
      JSON.stringify({ id: 'com.test.nosy', name: 'Nosy', version: '0.1.0', namespace: 'nosy', main: 'index.mjs', permissions: [] }),
    );
    writeFileSync(
      join(dir, 'index.mjs'),
      `import { readFileSync } from 'node:fs';
export default {
  tools: [
    { name: 'secret', title: 'secret', description: 'd', risk: 'read', inputSchema: { type: 'object', properties: {} },
      async run(_i, ctx) { return { output: String(await ctx.secrets.get('TOP_SECRET')) }; } },
    { name: 'readfile', title: 'readfile', description: 'd', risk: 'read', inputSchema: { type: 'object', properties: { p: { type: 'string' } } },
      run(i) { return readFileSync(i.p, 'utf8'); } },
    { name: 'net', title: 'net', description: 'd', risk: 'read', inputSchema: { type: 'object', properties: {} },
      async run(_i, ctx) { return (await ctx.http.fetch('https://example.com/')).body; } },
  ],
};`,
    );
    try {
      kernel.vault.set({ name: 'TOP_SECRET', value: 'the-crown-jewels' });
      writeFileSync(join(sandbox, 'private.txt'), 'private data');
      await kernel.call('plugins.install', { path: dir }, USER);
      const s = await kernel.gate.invoke('nosy.secret', {}, USER);
      expect(s.status).toBe('failed');
      expect(s.output).toMatch(/lacks the "secrets:TOP_SECRET" permission/);
      const f = await kernel.gate.invoke('nosy.readfile', { p: join(sandbox, 'private.txt') }, USER);
      expect(f.status).toBe('failed');
      expect(f.output).toMatch(/ERR_ACCESS_DENIED|permission/i);
      const n = await kernel.gate.invoke('nosy.net', {}, USER);
      expect(n.status).toBe('failed');
      expect(n.output).toMatch(/network:example.com/);
    } finally {
      await cleanup();
    }
  });

  it('installs from a .tgz package and rejects invalid manifests', async () => {
    const { kernel, cleanup } = await makeKernel();
    const out = tempDir('fbrx-pkg-');
    try {
      const pkg = join(out, 'toolkit.tgz');
      await tar.c({ gzip: true, file: pkg, cwd: resolve(EXAMPLE, '..'), prefix: 'package' }, ['example-toolkit/fbrx-plugin.json', 'example-toolkit/index.mjs']);
      const info = (await kernel.call('plugins.install', { path: pkg }, USER)) as any;
      expect(info.state).toBe('running');

      const bad = tempDir('fbrx-bad-');
      mkdirSync(bad, { recursive: true });
      writeFileSync(join(bad, 'fbrx-plugin.json'), JSON.stringify({ id: 'nope', name: '', version: 'x', namespace: '1', main: '../escape.js' }));
      await expect(kernel.call('plugins.install', { path: bad }, USER)).rejects.toThrow(/Invalid plugin manifest/);
    } finally {
      await cleanup();
    }
  });
});
