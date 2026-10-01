import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { DEFAULT_CONTROL_PLANE_PORT } from '@fbrx/shared';

export interface Config {
  host: string;
  port: number;
  dataDir: string;
  /** Externally reachable base URL (used in provisioning files and update feeds). */
  publicUrl: string;
  trustProxy: boolean;
  adminConsoleDir: string | null;
  /** One-time token required to create the first administrator (printed at startup if not set). */
  setupToken: string | null;
  bootstrapAdmin: { email: string; password: string; name: string; organization: string } | null;
  sessionHours: number;
  heartbeatSeconds: number;
  snapshotRetentionPerDevice: number;
  maxUploadBytes: number;
  logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';
  devMode: boolean;
}

function findConsoleDir(): string | null {
  if (process.env.FBRX_ADMIN_CONSOLE_DIR) return resolve(process.env.FBRX_ADMIN_CONSOLE_DIR);
  for (const c of [resolve(process.cwd(), 'admin-console'), resolve(process.cwd(), '../admin-console/dist'), resolve(process.cwd(), 'apps/admin-console/dist')]) {
    if (existsSync(resolve(c, 'index.html'))) return c;
  }
  return null;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, overrides: Partial<Config> = {}): Config {
  const port = Number(env.FBRX_CP_PORT ?? env.PORT ?? DEFAULT_CONTROL_PLANE_PORT);
  const cfg: Config = {
    host: env.FBRX_CP_HOST ?? '0.0.0.0',
    port,
    dataDir: resolve(env.FBRX_CP_DATA_DIR ?? '.fbrx-cp-data'),
    publicUrl: (env.FBRX_CP_PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/+$/, ''),
    trustProxy: env.FBRX_CP_TRUST_PROXY === '1',
    adminConsoleDir: findConsoleDir(),
    setupToken: env.FBRX_CP_SETUP_TOKEN ?? null,
    bootstrapAdmin:
      env.FBRX_CP_ADMIN_EMAIL && env.FBRX_CP_ADMIN_PASSWORD
        ? {
            email: env.FBRX_CP_ADMIN_EMAIL,
            password: env.FBRX_CP_ADMIN_PASSWORD,
            name: env.FBRX_CP_ADMIN_NAME ?? 'Administrator',
            organization: env.FBRX_CP_ORGANIZATION ?? 'My Organization',
          }
        : null,
    sessionHours: Number(env.FBRX_CP_SESSION_HOURS ?? 12),
    heartbeatSeconds: Number(env.FBRX_CP_HEARTBEAT_SECONDS ?? 30),
    snapshotRetentionPerDevice: Number(env.FBRX_CP_SNAPSHOT_RETENTION ?? 10),
    maxUploadBytes: Number(env.FBRX_CP_MAX_UPLOAD_MB ?? 4096) * 1024 * 1024,
    logLevel: (env.FBRX_CP_LOG_LEVEL as Config['logLevel']) ?? 'info',
    devMode: env.FBRX_DEV_MODE === '1',
    ...overrides,
  };
  return cfg;
}
