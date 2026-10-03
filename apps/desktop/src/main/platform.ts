import { app, Notification, safeStorage, shell } from 'electron';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { FileKeychain, defaultSpecialDirs, openMacSafeStorage, type KeychainAdapter, type MovedKeychain, type PlatformAdapter, type UpdateController } from '@fbrx/core';
import type { NotificationEvent } from '@fbrx/shared';

declare const __FBRX_LICENSE_PUBKEYS__: string[];

/** Vault key protection via the OS keychain (macOS Keychain, Windows DPAPI, libsecret on Linux). */
export class ElectronKeychain implements KeychainAdapter {
  readonly kind = 'os' as const;
  available() {
    return safeStorage.isEncryptionAvailable() && (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text');
  }
  async protect(data: Buffer) {
    return safeStorage.encryptString(data.toString('base64')).toString('base64');
  }
  async unprotect(blob: string) {
    return Buffer.from(safeStorage.decryptString(Buffer.from(blob, 'base64')), 'base64');
  }
}

export function chooseKeychain(dataDir: string): KeychainAdapter {
  const file = new FileKeychain(join(dataDir, 'keychain.key'));
  // macOS: the Keychain asks for the Mac password whenever an updated (re-signed) FBRX opens its item, which happens
  // after every update of an app that is not notarized. FBRX keeps its key in a file only this user can read instead
  // (and the app runs with Chromium's mock keychain, so nothing else touches the Keychain either). For a password,
  // turn on "Ask for the vault password when FBRX OS starts".
  if (process.platform === 'darwin') return file;
  const os = new ElectronKeychain();
  // Linux desktops without a secret service fall back to a 0600 key file (documented in SECURITY.md).
  return os.available() ? os : file;
}

/**
 * Vault keys that FBRX 1.8.0 and earlier protected with the Mac Keychain (Electron safeStorage). Read with the
 * `security` tool only when the person asks to bring them over: macOS may ask once for the Mac login password.
 */
export function macMovedKeychain(): MovedKeychain | null {
  if (process.platform !== 'darwin') return null;
  return {
    kind: 'os',
    label: 'the Mac Keychain',
    unprotect: async (blob) => {
      const password = await new Promise<string>((resolve, reject) =>
        execFile('/usr/bin/security', ['find-generic-password', '-w', '-s', `${app.getName()} Safe Storage`], { timeout: 120_000 }, (err, out) =>
          err ? reject(new Error(/could not be found/i.test(String(err.message)) ? 'Its item is not in the Keychain.' : 'macOS did not allow it (the request was denied or canceled).')) : resolve(out.trim()),
        ),
      );
      // The vault stored base64(safeStorage.encryptString(base64(key))).
      return Buffer.from(openMacSafeStorage(password, Buffer.from(blob, 'base64')), 'base64');
    },
  };
}

export function createElectronPlatform(o: {
  dataDir: string;
  updates: UpdateController | null;
  onNotify: (n: NotificationEvent) => void;
  requestRestart: (reason: string) => void;
}): PlatformAdapter {
  const resources = app.isPackaged ? process.resourcesPath : join(app.getAppPath(), 'resources');
  const workerDir = app.isPackaged ? join(app.getAppPath().replace(/app\.asar$/, 'app.asar.unpacked'), 'dist', 'main') : join(app.getAppPath(), 'dist', 'main');
  const keys = [...(typeof __FBRX_LICENSE_PUBKEYS__ !== 'undefined' ? __FBRX_LICENSE_PUBKEYS__ : [])];
  if (process.env.FBRX_LICENSE_PUBLIC_KEY && !app.isPackaged) keys.push(process.env.FBRX_LICENSE_PUBLIC_KEY.replace(/\\n/g, '\n'));
  return {
    shell: 'desktop',
    appVersion: app.getVersion(),
    devMode: !app.isPackaged || process.env.FBRX_DEV_MODE === '1',
    keychain: chooseKeychain(o.dataDir),
    movedKeychain: macMovedKeychain(),
    resourcesDir: resources,
    pluginWorkerPath: join(workerDir, 'plugin-worker.mjs'),
    licensePublicKeys: keys,
    sandboxPlugins: process.env.FBRX_PLUGIN_SANDBOX !== '0',
    updates: o.updates,
    meshMobileDir: join(workerDir, 'mobile'),
    vendorDbFile: join(workerDir, 'oui-vendors.tsv.gz'),
    mcpShim: { command: process.execPath, args: [join(workerDir, 'fbrx-mcp.mjs')], env: { ELECTRON_RUN_AS_NODE: '1' } },
    specialDirs: () => {
      const d = defaultSpecialDirs();
      try {
        return { home: app.getPath('home'), documents: app.getPath('documents'), desktop: app.getPath('desktop'), downloads: app.getPath('downloads') };
      } catch {
        return d;
      }
    },
    notify: (n) => {
      o.onNotify(n);
      if (Notification.isSupported()) new Notification({ title: n.title, body: n.body, silent: n.level === 'info' }).show();
    },
    requestRestart: o.requestRestart,
  };
}

export function openExternalSafe(url: string) {
  if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
}
