import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { VIRTUAL_DEFAULT_PORT } from '@fbrx/shared';

export interface VirtualConfig {
  host: string;
  port: number;
  dataDir: string;
  /** "libvirt" runs real virtual machines; "simulated" pretends (development, demos, tests). */
  driver: 'libvirt' | 'simulated';
  libvirtUri: string;
  imagesDir: string;
  isosDir: string;
  /**
   * HTTPS: "self-signed" makes FBRX Virtual's own certificate on first start (kept in the data folder), "files" uses
   * one you have, null serves plain HTTP (behind a reverse proxy, or for this computer only).
   */
  tls: { mode: 'self-signed'; names: string[] } | { mode: 'files'; certFile: string; keyFile: string } | null;
  consoleDir: string | null;
  /** One-time token for creating the first administrator (printed at startup when not set). */
  setupToken: string | null;
  bootstrapAdmin: { username: string; password: string; name: string } | null;
  sessionHours: number;
  maxUploadBytes: number;
  /** Where the hardware view reads sysfs and procfs (a test folder in tests). */
  sysRoot: string;
  logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';
  trustProxy: boolean;
}

function hasVirsh(): boolean {
  try {
    execFileSync('sh', ['-c', 'command -v virsh'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function findConsoleDir(env: NodeJS.ProcessEnv): string | null {
  if (env.FBRX_V_CONSOLE_DIR) return resolve(env.FBRX_V_CONSOLE_DIR);
  for (const c of [resolve(process.cwd(), 'virtual-console'), resolve(process.cwd(), '../virtual-console/dist'), resolve(process.cwd(), 'apps/virtual-console/dist')]) {
    if (existsSync(resolve(c, 'index.html'))) return c;
  }
  return null;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, overrides: Partial<VirtualConfig> = {}): VirtualConfig {
  const dataDir = resolve(env.FBRX_V_DATA_DIR ?? '.fbrx-virtual-data');
  const driver = env.FBRX_V_DRIVER === 'simulated' || env.FBRX_V_DRIVER === 'libvirt' ? env.FBRX_V_DRIVER : hasVirsh() ? 'libvirt' : 'simulated';
  const tlsMode = env.FBRX_V_TLS ?? 'self-signed';
  return {
    host: env.FBRX_V_HOST ?? '0.0.0.0',
    port: Number(env.FBRX_V_PORT ?? VIRTUAL_DEFAULT_PORT),
    dataDir,
    driver,
    libvirtUri: env.FBRX_V_LIBVIRT_URI ?? 'qemu:///system',
    imagesDir: resolve(env.FBRX_V_IMAGES_DIR ?? resolve(dataDir, 'images')),
    isosDir: resolve(env.FBRX_V_ISOS_DIR ?? resolve(dataDir, 'isos')),
    tls:
      env.FBRX_V_TLS_CERT && env.FBRX_V_TLS_KEY
        ? { mode: 'files', certFile: resolve(env.FBRX_V_TLS_CERT), keyFile: resolve(env.FBRX_V_TLS_KEY) }
        : tlsMode === 'off'
          ? null
          : { mode: 'self-signed', names: (env.FBRX_V_TLS_NAMES ?? '').split(',').map((n) => n.trim()).filter(Boolean) },
    consoleDir: findConsoleDir(env),
    setupToken: env.FBRX_V_SETUP_TOKEN ?? null,
    bootstrapAdmin: env.FBRX_V_ADMIN_USER && env.FBRX_V_ADMIN_PASSWORD ? { username: env.FBRX_V_ADMIN_USER, password: env.FBRX_V_ADMIN_PASSWORD, name: env.FBRX_V_ADMIN_NAME ?? 'Administrator' } : null,
    sessionHours: Number(env.FBRX_V_SESSION_HOURS ?? 12),
    maxUploadBytes: Number(env.FBRX_V_MAX_UPLOAD_GB ?? 32) * 1024 ** 3,
    sysRoot: env.FBRX_V_SYS_ROOT ?? '/',
    logLevel: (env.FBRX_V_LOG_LEVEL as VirtualConfig['logLevel']) ?? 'info',
    trustProxy: env.FBRX_V_TRUST_PROXY === '1',
    ...overrides,
  };
}
