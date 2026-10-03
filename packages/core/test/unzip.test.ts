import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { unzip } from '../src/util/unzip';
import { makeZip } from './helpers';
import { pickRelease, selectRuntimeAsset } from '../src/ai/runtime/runtime-installer';


describe('runtime installer', () => {
  it('extracts zip archives and preserves executable bits', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fbrx-zip-'));
    const zip = join(dir, 'a.zip');
    writeFileSync(zip, makeZip([{ name: 'build/bin/llama-server', data: '#!/bin/sh\necho hi\n'.repeat(100), mode: 0o755 }, { name: 'README.md', data: 'hello' }]));
    unzip(zip, join(dir, 'out'));
    expect(readFileSync(join(dir, 'out/README.md'), 'utf8')).toBe('hello');
    if (process.platform !== 'win32') expect(statSync(join(dir, 'out/build/bin/llama-server')).mode & 0o111).toBeTruthy();
  });

  it('refuses archive entries that escape the destination', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fbrx-zip-'));
    const zip = join(dir, 'evil.zip');
    writeFileSync(zip, makeZip([{ name: '../../escape.txt', data: 'x' }]));
    expect(() => unzip(zip, join(dir, 'out'))).toThrow(/Unsafe path/);
  });

  it('selects the right llama.cpp build per platform', () => {
    const assets = ['llama-b6600-bin-macos-arm64.zip', 'llama-b6600-bin-macos-x64.zip', 'llama-b6600-bin-win-cpu-x64.zip', 'llama-b6600-bin-win-vulkan-x64.zip', 'llama-b6600-bin-win-cuda-12.4-x64.zip', 'llama-b6600-bin-ubuntu-x64.tar.gz'].map((name) => ({ name, browser_download_url: `https://x/${name}`, size: 1 }));
    expect(selectRuntimeAsset(assets, 'darwin', 'arm64')?.name).toBe('llama-b6600-bin-macos-arm64.zip');
    expect(selectRuntimeAsset(assets, 'win32', 'x64')?.name).toBe('llama-b6600-bin-win-cpu-x64.zip');
    expect(selectRuntimeAsset(assets, 'win32', 'x64', 'vulkan')?.name).toBe('llama-b6600-bin-win-vulkan-x64.zip');
    expect(selectRuntimeAsset(assets, 'linux', 'x64')?.name).toBe('llama-b6600-bin-ubuntu-x64.tar.gz');
    expect(selectRuntimeAsset(assets, 'linux', 'arm64')).toBeNull();
  });

  it('skips releases without binaries, such as the old tag GitHub calls "latest"', () => {
    const a = (name: string) => ({ name, browser_download_url: `https://x/${name}`, size: 1 });
    const releases = [
      { tag_name: 'b11147', draft: true, assets: [a('llama-b11147-bin-win-cpu-x64.zip')] },
      { tag_name: 'b11146', assets: [a('llama-b11146-bin-win-cpu-x64.zip'), a('llama-b11146-bin-win-vulkan-x64.zip'), a('cudart-llama-bin-win-cuda-12.4-x64.zip')] },
      { tag_name: 'v0.5.0', assets: [] },
    ];
    expect(pickRelease(releases, 'win32', 'x64', 'vulkan')?.asset.name).toBe('llama-b11146-bin-win-vulkan-x64.zip');
    expect(pickRelease([releases[2]], 'win32', 'x64')).toBeNull();
  });
});
