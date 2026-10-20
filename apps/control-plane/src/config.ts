import { resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { DEFAULT_CONTROL_PLANE_PORT, parseVertical, type Vertical } from '@fbrx/shared';

export interface Config {
  host: string;
  port: number;
  dataDir: string;
  /** Externally reachable base URL (used in provisioning files and update feeds). */
  publicUrl: string;
  trustProxy: boolean;
  /**
   * HTTPS served by FBRX Command itself. "self-signed" makes its own certificate on first start (kept in the data
   * folder; computers trust it by fingerprint), for home and school networks with no domain name. "files" uses a
   * certificate you have. null: plain HTTP (behind a reverse proxy such as Caddy, or for this computer only).
   */
  tls: { mode: 'self-signed'; names: string[] } | { mode: 'files'; certFile: string; keyFile: string } | null;
  /** A second listener on 127.0.0.1 (plain HTTP) for the console on this same computer, with no certificate warning. */
  localPort: number | null;
  adminConsoleDir: string | null;
  /** One-time token required to create the first administrator (printed at startup if not set). */
  setupToken: string | null;
  bootstrapAdmin: { email: string; password: string; name: string; organization: string; kind: Vertical } | null;
  sessionHours: number;
  heartbeatSeconds: number;
  snapshotRetentionPerDevice: number;
  maxUploadBytes: number;
  logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';
  devMode: boolean;
  /** FBRX accounts and payments (FBRX Command in the cloud). */
  cloud: CloudConfig;
}

/**
 * FBRX Command in the cloud: anyone may make an FBRX account (publicSignup), and accounts buy editions through the
 * payment providers that are set up. Each provider is null until its keys are there.
 */
export interface CloudConfig {
  publicSignup: boolean;
  /** Where Checkout and the billing portal send people back to (the website's account page). */
  returnUrl: string;
  /** The website's origins (https://fbrx.example): they may call the account and billing API from the browser. */
  websiteOrigins: string[];
  /** Stripe Checkout (cards, and the Apple Pay and Google Pay wallets where Stripe offers them). */
  stripe: { secretKey: string; webhookSecret: string; apiBase: string } | null;
  /**
   * App Store purchases in the iPhone and iPad app (StoreKit 2 signed transactions, App Store Server Notifications V2).
   * Purchases in test builds (TestFlight, the sandbox) cost nothing, so they turn nothing on unless allowSandbox is set
   * (FBRX_APPLE_SANDBOX=1, for a test FBRX Command only).
   */
  apple: { bundleId: string; rootCertificates: string[]; allowSandbox: boolean } | null;
  /**
   * Google Play purchases in the Android app (Play Developer API, real-time developer notifications). Purchases by
   * license testers cost nothing either: allowTest (FBRX_GOOGLE_TEST_PURCHASES=1) is for a test FBRX Command only.
   */
  google: { packageName: string; serviceAccount: { clientEmail: string; privateKey: string; tokenUri: string }; rtdnToken: string; apiBase: string; allowTest: boolean } | null;
  /**
   * Email for FBRX accounts (confirming an address, resetting a password): an SMTP URL such as
   * smtps://user:password@smtp.example.com:465 (FBRX_SMTP_URL) and who it comes from (FBRX_MAIL_FROM).
   */
  mail: { url: string; from: string } | null;
}

function readPems(paths: string | undefined): string[] {
  return (paths ?? '')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const raw = readFileSync(resolve(p));
      // Apple publishes its root as DER (.cer); PEM works too.
      return raw.includes('-----BEGIN') ? raw.toString('utf8') : `-----BEGIN CERTIFICATE-----\n${raw.toString('base64').match(/.{1,64}/g)!.join('\n')}\n-----END CERTIFICATE-----\n`;
    });
}

export function loadCloudConfig(env: NodeJS.ProcessEnv, publicUrl: string): CloudConfig {
  const sa = env.FBRX_GOOGLE_SERVICE_ACCOUNT ? JSON.parse(readFileSync(resolve(env.FBRX_GOOGLE_SERVICE_ACCOUNT), 'utf8')) : null;
  return {
    publicSignup: env.FBRX_CP_PUBLIC_SIGNUP === '1',
    returnUrl: (env.FBRX_CP_ACCOUNT_URL ?? `${publicUrl}/account`).replace(/\/+$/, ''),
    websiteOrigins: (env.FBRX_CP_WEBSITE_ORIGINS ?? '').split(',').map((o) => o.trim().replace(/\/+$/, '')).filter(Boolean),
    stripe:
      env.FBRX_STRIPE_SECRET_KEY && env.FBRX_STRIPE_WEBHOOK_SECRET
        ? { secretKey: env.FBRX_STRIPE_SECRET_KEY, webhookSecret: env.FBRX_STRIPE_WEBHOOK_SECRET, apiBase: (env.FBRX_STRIPE_API_BASE ?? 'https://api.stripe.com').replace(/\/+$/, '') }
        : null,
    apple: env.FBRX_APPLE_BUNDLE_ID && env.FBRX_APPLE_ROOT_CA ? { bundleId: env.FBRX_APPLE_BUNDLE_ID, rootCertificates: readPems(env.FBRX_APPLE_ROOT_CA), allowSandbox: env.FBRX_APPLE_SANDBOX === '1' } : null,
    google:
      env.FBRX_GOOGLE_PACKAGE_NAME && sa && env.FBRX_GOOGLE_RTDN_TOKEN
        ? {
            packageName: env.FBRX_GOOGLE_PACKAGE_NAME,
            serviceAccount: { clientEmail: sa.client_email, privateKey: sa.private_key, tokenUri: sa.token_uri ?? 'https://oauth2.googleapis.com/token' },
            rtdnToken: env.FBRX_GOOGLE_RTDN_TOKEN,
            apiBase: (env.FBRX_GOOGLE_API_BASE ?? 'https://androidpublisher.googleapis.com').replace(/\/+$/, ''),
            allowTest: env.FBRX_GOOGLE_TEST_PURCHASES === '1',
          }
        : null,
    mail: env.FBRX_SMTP_URL ? { url: env.FBRX_SMTP_URL, from: env.FBRX_MAIL_FROM ?? `FBRX <no-reply@${new URL(publicUrl).hostname}>` } : null,
  };
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
    tls:
      env.FBRX_CP_TLS_CERT && env.FBRX_CP_TLS_KEY
        ? { mode: 'files', certFile: resolve(env.FBRX_CP_TLS_CERT), keyFile: resolve(env.FBRX_CP_TLS_KEY) }
        : env.FBRX_CP_TLS === 'self-signed'
          ? { mode: 'self-signed', names: (env.FBRX_CP_TLS_NAMES ?? '').split(',').map((n) => n.trim()).filter(Boolean) }
          : null,
    localPort: env.FBRX_CP_LOCAL_PORT ? Number(env.FBRX_CP_LOCAL_PORT) : null,
    adminConsoleDir: findConsoleDir(),
    setupToken: env.FBRX_CP_SETUP_TOKEN ?? null,
    bootstrapAdmin:
      env.FBRX_CP_ADMIN_EMAIL && env.FBRX_CP_ADMIN_PASSWORD
        ? {
            email: env.FBRX_CP_ADMIN_EMAIL,
            password: env.FBRX_CP_ADMIN_PASSWORD,
            name: env.FBRX_CP_ADMIN_NAME ?? 'Administrator',
            organization: env.FBRX_CP_ORGANIZATION ?? 'My Organization',
            // work, school or home (or business, education)
            kind: parseVertical(env.FBRX_CP_ORGANIZATION_KIND) ?? 'business',
          }
        : null,
    sessionHours: Number(env.FBRX_CP_SESSION_HOURS ?? 12),
    heartbeatSeconds: Number(env.FBRX_CP_HEARTBEAT_SECONDS ?? 30),
    snapshotRetentionPerDevice: Number(env.FBRX_CP_SNAPSHOT_RETENTION ?? 10),
    maxUploadBytes: Number(env.FBRX_CP_MAX_UPLOAD_MB ?? 4096) * 1024 * 1024,
    logLevel: (env.FBRX_CP_LOG_LEVEL as Config['logLevel']) ?? 'info',
    devMode: env.FBRX_DEV_MODE === '1',
    cloud: loadCloudConfig(env, (env.FBRX_CP_PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/+$/, '')),
    ...overrides,
  };
  return cfg;
}
