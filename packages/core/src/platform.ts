import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { openBytes, sealString } from '@fbrx/shared/node';
import type { NotificationEvent, UpdateStatus, UpdateChannel } from '@fbrx/shared';

/**
 * Protects the vault's data-encryption key with something bound to this machine/user:
 * macOS Keychain / Windows DPAPI (Electron safeStorage), an injected master key, or a key file.
 */
export interface KeychainAdapter {
  readonly kind: 'os' | 'env' | 'file' | 'memory';
  available(): boolean;
  protect(data: Buffer): Promise<string>;
  unprotect(blob: string): Promise<Buffer>;
}

export interface UpdateFeedConfig {
  feedUrl: string | null;
  channel: UpdateChannel;
  headers: Record<string, string>;
  allowDowngrade: boolean;
}

export interface UpdateController {
  status(): UpdateStatus;
  check(): Promise<UpdateStatus>;
  install(opts?: { restartNow?: boolean }): Promise<UpdateStatus>;
  configure(cfg: UpdateFeedConfig): void;
  onStatus(cb: (s: UpdateStatus) => void): void;
}

export interface SpecialDirs {
  home: string;
  documents: string;
  desktop: string;
  downloads: string;
}

export interface PlatformAdapter {
  shell: 'desktop' | 'headless';
  appVersion: string;
  devMode: boolean;
  keychain: KeychainAdapter;
  /** Directory with bundled resources (e.g. the local model runtime). */
  resourcesDir: string | null;
  /** Absolute path to plugin-worker.mjs. */
  pluginWorkerPath: string;
  /** Ed25519 public keys (PEM) trusted to sign licenses. Embedded at build time. */
  licensePublicKeys: string[];
  /** Run plugins under the Node permission model. Disable only for debugging. */
  sandboxPlugins: boolean;
  updates: UpdateController | null;
  /** Folder with the FBRX Mobile web app served to paired phones. */
  meshMobileDir?: string | null;
  /** How AI apps start the FBRX MCP bridge (the app executable in Node mode plus the bridge script). */
  mcpShim?: { command: string; args: string[]; env?: Record<string, string> } | null;
  specialDirs(): SpecialDirs;
  notify(n: NotificationEvent): void;
  /** Ask the shell to restart the core (after restore, update, remote `app.restart`). */
  requestRestart(reason: string): void;
}

export class FileKeychain implements KeychainAdapter {
  readonly kind = 'file' as const;
  private key: Buffer | null = null;

  constructor(private readonly file: string) {}

  available() {
    return true;
  }

  private load(): Buffer {
    if (this.key) return this.key;
    if (existsSync(this.file)) {
      this.key = Buffer.from(readFileSync(this.file, 'utf8').trim(), 'base64');
    } else {
      this.key = randomBytes(32);
      writeFileSync(this.file, this.key.toString('base64'), { mode: 0o600 });
      try {
        chmodSync(this.file, 0o600);
      } catch {
        /* windows */
      }
    }
    if (this.key.length !== 32) throw new Error(`Keychain file ${this.file} is corrupt`);
    return this.key;
  }

  async protect(data: Buffer) {
    return sealString(this.load(), data, 'fbrx-keychain');
  }
  async unprotect(blob: string) {
    return openBytes(this.load(), blob, 'fbrx-keychain');
  }
}

export class StaticKeyKeychain implements KeychainAdapter {
  readonly kind: 'env' | 'memory';
  constructor(
    private readonly key: Buffer,
    kind: 'env' | 'memory' = 'env',
  ) {
    if (key.length !== 32) throw new Error('Master key must be 32 bytes (base64-encoded)');
    this.kind = kind;
  }
  available() {
    return true;
  }
  async protect(data: Buffer) {
    return sealString(this.key, data, 'fbrx-keychain');
  }
  async unprotect(blob: string) {
    return openBytes(this.key, blob, 'fbrx-keychain');
  }
}

export function defaultSpecialDirs(): SpecialDirs {
  const home = homedir();
  return {
    home,
    documents: join(home, 'Documents'),
    desktop: join(home, 'Desktop'),
    downloads: join(home, 'Downloads'),
  };
}
