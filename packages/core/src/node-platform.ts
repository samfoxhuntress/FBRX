import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FileKeychain, StaticKeyKeychain, defaultSpecialDirs, type KeychainAdapter, type PlatformAdapter } from './platform';

function findPackageJsonVersion(): string {
  if (process.env.FBRX_APP_VERSION) return process.env.FBRX_APP_VERSION;
  try {
    let dir = dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 6; i++) {
      const pj = join(dir, 'package.json');
      if (existsSync(pj)) {
        const v = JSON.parse(readFileSync(pj, 'utf8')).version;
        if (v) return v;
      }
      dir = dirname(dir);
    }
  } catch {
    /* bundled */
  }
  return '1.0.0';
}

export function defaultPluginWorkerPath(): string {
  if (process.env.FBRX_PLUGIN_WORKER) return resolve(process.env.FBRX_PLUGIN_WORKER);
  const here = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [join(here, 'plugin-worker.mjs'), join(here, 'plugins', 'plugin-worker.mjs'), join(here, '..', 'src', 'plugins', 'plugin-worker.mjs')]) {
    if (existsSync(candidate)) return candidate;
  }
  return join(here, 'plugin-worker.mjs');
}

/** FBRX Mobile files (next to a bundle as `mobile/`, or `packages/core/mobile` from source). */
export function defaultMobileDir(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [join(here, 'mobile'), join(here, '..', 'mobile')]) {
    if (existsSync(join(candidate, 'app.js'))) return candidate;
  }
  return null;
}

/** Keychain for headless installs: `FBRX_MASTER_KEY` (base64, 32 bytes) if set, else a 0600 key file. */
export function headlessKeychain(keyFile: string): KeychainAdapter {
  const env = process.env.FBRX_MASTER_KEY;
  if (env) return new StaticKeyKeychain(Buffer.from(env, 'base64'), 'env');
  return new FileKeychain(keyFile);
}

export interface NodePlatformOptions {
  dataDir: string;
  devMode?: boolean;
  appVersion?: string;
  licensePublicKeys?: string[];
  keychain?: KeychainAdapter;
  requestRestart?: (reason: string) => void;
  sandboxPlugins?: boolean;
}

/** Platform adapter for the headless runner, tests, and servers. */
export function createNodePlatform(o: NodePlatformOptions): PlatformAdapter {
  const keys = [...(o.licensePublicKeys ?? [])];
  if (process.env.FBRX_LICENSE_PUBLIC_KEY) keys.push(process.env.FBRX_LICENSE_PUBLIC_KEY.replace(/\\n/g, '\n'));
  return {
    shell: 'headless',
    appVersion: o.appVersion ?? findPackageJsonVersion(),
    devMode: o.devMode ?? process.env.FBRX_DEV_MODE === '1',
    keychain: o.keychain ?? headlessKeychain(join(resolve(o.dataDir), 'keychain.key')),
    resourcesDir: process.env.FBRX_RESOURCES_DIR ?? null,
    pluginWorkerPath: defaultPluginWorkerPath(),
    licensePublicKeys: keys,
    microsoftClientId: process.env.FBRX_MS_CLIENT_ID || null,
    sandboxPlugins: o.sandboxPlugins ?? process.env.FBRX_PLUGIN_SANDBOX !== '0',
    updates: null,
    meshMobileDir: defaultMobileDir(),
    mcpShim: null,
    specialDirs: defaultSpecialDirs,
    notify: (n) => console.log(`[notification] ${n.title}: ${n.body}`),
    requestRestart: o.requestRestart ?? ((reason) => console.log(`[restart requested: ${reason}]`)),
  };
}
