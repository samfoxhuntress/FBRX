import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const afterPack = require('../scripts/after-pack.cjs') as { default: (c: { electronPlatformName: string; appOutDir: string }) => Promise<void> };
const root = join(__dirname, '../../..');
const dirs: string[] = [];
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), 'fbrx-linux-pkg-'));
  dirs.push(d);
  return d;
};
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const mode = (p: string) => lstatSync(p).mode & 0o7777;

describe.runIf(process.platform === 'linux')('Linux packages', () => {
  it('get normal file modes before they are made: 0755 for programs and folders, 0644 for the rest', async () => {
    // Electron's own files arrive like this (2.3.2's .deb installed them so).
    const out = temp();
    mkdirSync(join(out, 'locales'));
    writeFileSync(join(out, 'fbrx-os'), 'program');
    writeFileSync(join(out, 'resources.pak'), 'data');
    writeFileSync(join(out, 'locales', 'it.pak'), 'data');
    symlinkSync('fbrx-os', join(out, 'link'));
    chmodSync(join(out, 'fbrx-os'), 0o777);
    chmodSync(join(out, 'resources.pak'), 0o666);
    chmodSync(join(out, 'locales', 'it.pak'), 0o666);
    chmodSync(join(out, 'locales'), 0o777);
    await afterPack.default({ electronPlatformName: 'linux', appOutDir: out });
    expect([mode(join(out, 'fbrx-os')), mode(join(out, 'resources.pak')), mode(join(out, 'locales')), mode(join(out, 'locales', 'it.pak'))]).toEqual([0o755, 0o644, 0o755, 0o644]);
    expect(lstatSync(join(out, 'link')).isSymbolicLink()).toBe(true);
    // Other systems' packages are left alone.
    chmodSync(join(out, 'resources.pak'), 0o666);
    await afterPack.default({ electronPlatformName: 'darwin', appOutDir: out });
    expect(mode(join(out, 'resources.pak'))).toBe(0o666);
  });

  it('repair older installs on upgrade, and keep electron-builder’s own install steps', () => {
    const script = readFileSync(join(root, 'apps/desktop/build/linux/after-install.tpl'), 'utf8');
    expect(script).toMatch(/^#!\/bin\/bash/);
    expect(script).toContain("chmod -R go-w '/opt/${sanitizedProductName}'");
    expect(script).toContain('chrome-sandbox');
    expect(script).toContain('update-alternatives --install');
    // electron-builder replaces ${name} and stops on a name it does not know.
    expect([...new Set(script.match(/\$\{([a-zA-Z]+)\}/g))].sort()).toEqual(['${executable}', '${sanitizedProductName}']);
    for (const f of ['apps/desktop/electron-builder.yml', 'apps/desktop/electron-builder.digger.yml']) {
      const yml = readFileSync(join(root, f), 'utf8');
      expect(yml).toMatch(/^afterPack: scripts\/after-pack\.cjs$/m);
      expect(yml).toMatch(/^ {2}afterInstall: build\/linux\/after-install\.tpl$/m);
    }
  });

  it.runIf(existsSync('/usr/bin/dpkg-deb'))('fail the release when a package installs a file others may write to', () => {
    const build = (fileMode: number) => {
      const d = temp();
      mkdirSync(join(d, 'pkg/DEBIAN'), { recursive: true });
      mkdirSync(join(d, 'pkg/opt/FBRX OS'), { recursive: true });
      writeFileSync(join(d, 'pkg/DEBIAN/control'), 'Package: fbrx-test\nVersion: 1.0\nArchitecture: all\nMaintainer: FBRX\nDescription: test\n');
      writeFileSync(join(d, 'pkg/opt/FBRX OS/fbrx-os'), 'program');
      chmodSync(join(d, 'pkg/opt/FBRX OS/fbrx-os'), fileMode);
      mkdirSync(join(d, 'out'));
      expect(spawnSync('dpkg-deb', ['--root-owner-group', '--build', join(d, 'pkg'), join(d, 'out/fbrx-test.deb')]).status).toBe(0);
      return spawnSync('bash', [join(root, 'scripts/check-linux-packages.sh'), join(d, 'out')], { encoding: 'utf8' });
    };
    const bad = build(0o777);
    expect(bad.status).toBe(1);
    expect(bad.stdout).toMatch(/fbrx-test\.deb installs 1 files or folders that others may write to/);
    const good = build(0o755);
    expect(good.status, good.stdout + good.stderr).toBe(0);
  });
});
