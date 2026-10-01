import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeKernel, tempDir, USER } from './helpers';

const ROOT = resolve(__dirname, '../../..');

describe('plugin packaging', () => {
  it('packs a plugin folder into a .tgz that installs and runs', async () => {
    const out = tempDir('fbrx-pack-');
    execFileSync(process.execPath, [join(ROOT, 'scripts/pack-plugin.mjs'), join(ROOT, 'plugins/example-toolkit'), '--out', out], { stdio: 'pipe' });
    const [pkg] = readdirSync(out);
    expect(pkg).toBe('com.fbrx.example-toolkit-1.0.0.tgz');

    const { kernel, cleanup } = await makeKernel();
    try {
      const info = (await kernel.call('plugins.install', { path: join(out, pkg) }, USER)) as any;
      expect(info).toMatchObject({ id: 'com.fbrx.example-toolkit', version: '1.0.0', state: 'running' });
      const r = await kernel.gate.invoke('toolkit.text_stats', { text: 'packed and shipped' }, USER);
      expect(r.data).toMatchObject({ words: 3 });
    } finally {
      await cleanup();
    }
  });

  it('rejects an invalid manifest before packing', () => {
    const dir = tempDir('fbrx-bad-plugin-');
    execFileSync('node', ['-e', `require('fs').writeFileSync(${JSON.stringify(join(dir, 'fbrx-plugin.json'))}, JSON.stringify({ id: 'Bad Id', name: 'x', version: '1', namespace: 'X', main: 'index.mjs' }))`]);
    expect(() => execFileSync(process.execPath, [join(ROOT, 'scripts/pack-plugin.mjs'), dir], { stdio: 'pipe' })).toThrow(/reverse-DNS|semver|namespace/);
  });
});
