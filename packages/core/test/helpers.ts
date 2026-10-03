import { deflateRawSync } from 'node:zlib';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { DEFAULT_POLICY, type Policy } from '@fbrx/shared';
import { Kernel } from '../src/kernel';
import { createNodePlatform } from '../src/node-platform';
import { StaticKeyKeychain, type KeychainAdapter } from '../src/platform';

export const USER = { origin: 'user' as const, actor: 'test-user' };

export function tempDir(prefix = 'fbrx-test-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function memoryKeychain(): KeychainAdapter {
  return new StaticKeyKeychain(randomBytes(32), 'memory');
}

export interface TestKernelOptions {
  dataDir?: string;
  keychain?: KeychainAdapter;
  devMode?: boolean;
  licensePublicKeys?: string[];
  start?: boolean;
  localApiPort?: number;
  onRestart?: (reason: string) => void;
}

/** Boots an isolated kernel in a temp folder with tools confined to a sandbox directory. */
export async function makeKernel(o: TestKernelOptions = {}): Promise<{ kernel: Kernel; dataDir: string; sandbox: string; keychain: KeychainAdapter; cleanup: () => Promise<void> }> {
  const dataDir = o.dataDir ?? tempDir();
  const sandbox = tempDir('fbrx-sandbox-');
  const keychain = o.keychain ?? memoryKeychain();
  const kernel = await Kernel.create({
    dataDir,
    platform: createNodePlatform({
      dataDir,
      devMode: o.devMode ?? true,
      keychain,
      licensePublicKeys: o.licensePublicKeys,
      requestRestart: o.onRestart,
    }),
  });
  kernel.settings.update({
    localApi: { enabled: o.localApiPort !== undefined, port: o.localApiPort ?? 47999 },
    runtime: { enabled: false },
  });
  const policy: Policy = structuredClone(DEFAULT_POLICY);
  policy.filesystem.allowedRoots = [sandbox, '${WORKSPACE}'];
  kernel.policy.updateLocal(policy);
  if (o.start !== false) await kernel.start();
  return {
    kernel,
    dataDir,
    sandbox,
    keychain,
    cleanup: async () => {
      await kernel.stop();
      rmSync(sandbox, { recursive: true, force: true });
      if (!o.dataDir) rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

export async function waitFor<T>(fn: () => T | Promise<T>, timeoutMs = 10_000, intervalMs = 50): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (err) {
      last = err;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`waitFor timed out${last ? `: ${(last as Error).message}` : ''}`);
}

function crc32(buf: Buffer) {
  let c = -1;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return (c ^ -1) >>> 0;
}

/** Builds a zip with deflated entries (mode stored in external attributes). */
export function makeZip(entries: Array<{ name: string; data: string; mode?: number }>): Buffer {
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
