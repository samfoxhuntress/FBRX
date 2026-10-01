import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { unzip } from '../src/util/unzip';
import { selectRuntimeAsset } from '../src/ai/runtime/runtime-installer';

function crc32(buf: Buffer) {
  let c = -1;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return (c ^ -1) >>> 0;
}

/** Builds a zip with deflated entries (mode stored in external attributes). */
function makeZip(entries: Array<{ name: string; data: string; mode?: number }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const raw = Buffer.from(e.data);
    const comp = deflateRawSync(raw);
    const name = Buffer.from(e.name);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(crc32(raw), 14);
    lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(name.length, 26);
    const local = Buffer.concat([lh, name, comp]);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(0x0314, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(crc32(raw), 16);
    ch.writeUInt32LE(comp.length, 20);
    ch.writeUInt32LE(raw.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(((e.mode ?? 0o644) << 16) >>> 0, 38);
    ch.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([ch, name]));
    locals.push(local);
    offset += local.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

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
});
