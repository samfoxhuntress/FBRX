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
