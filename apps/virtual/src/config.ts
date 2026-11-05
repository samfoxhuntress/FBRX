import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { DEFAULT_LOCAL_API_PORT, isCidr, isIPv4, networkOf, parseCidr, VIRTUAL_DEFAULT_PORT } from '@fbrx/shared';

/** An IPv4 address with its network size (192.168.50.1/24), or null. */
const cidr4 = (s: string | undefined): string | null => (s && s.includes('/') && parseCidr(s)?.family === 4 ? s : null);

export interface VirtualConfig {
  host: string;
  port: number;
  dataDir: string;
  /** "libvirt" runs real virtual machines; "simulated" pretends (development, demos, tests); "none": no virtual role. */
  driver: 'libvirt' | 'simulated' | 'none';
  /** What this server does (FBRX Server roles): virtual, ai, gate, minidome, time. The console shows what is there. */
  roles: string[];
  /**
   * FBRX Gate (the gate role): "linux" applies to this system, "simulated" pretends (development). The ports it
   * starts with on a new gate.
   */
  gate: {
    mode: 'linux' | 'simulated';
    wan: string;
    lan: string;
    /** "commit": put the starter configuration in place at the first start (the installer sets this up). */
    first: 'commit' | 'wait';
    /** A private network on the internet side allowed to manage the gate (so an install over that side keeps working). */
    manageFromWan: string | null;
    /** The gate's address in your network, when the installer chose it (else one clear of the internet side's). */
    lanAddress: string | null;
    /** A fixed internet address (FBRX_V_GATE_WAN_ADDRESS + FBRX_V_GATE_WAN_GATEWAY), else DHCP. */
    wanStatic: { address: string; gateway: string } | null;
  };
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
  /**
   * The FBRX core on this server (FBRX Server's "ai" role: the agent, FBRX Mesh and Mesh Assist), reached on its Local
   * API with the console token it writes at every start. Not installed when the token file is missing.
   */
  core: { url: string; tokenFile: string };
  /**
   * FBRX Time (the time role): the repository folder for images, the backup folder computers send theirs to (an SMB
   * share the installer sets up, its sign-in in shareFile), and "simulated" to pretend (development, demos, tests).
   */
  time: { dir: string; shareFile: string; mode: 'libvirt' | 'simulated' };
  /**
   * Changing this server's roles from the console: fbrx-server (roles set …) runs the copy of the installer the server
   * keeps (bundleDir), in a job of its own (systemd-run) so it carries on while this console restarts. It writes how it
   * went to stateDir/roles.env and logFile.
   */
  server: { command: string; bundleDir: string; stateDir: string; logFile: string; spawn: 'systemd-run' | 'direct' };
  /**
   * FBRX Command on this server (the command role): the settings the installer wrote for it (its address) and its
   * root-only secrets (the setup token), the certificate it made for itself, and its local-only address, where this
   * console checks on it.
   */
  command: { envFile: string; secretsFile: string; certFile: string; localUrl: string };
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
  const roles = [...new Set((env.FBRX_V_ROLES ?? 'virtual').split(',').map((r) => r.trim()).filter((r) => /^[a-z][a-z0-9-]{0,31}$/.test(r)))];
  const driver = !roles.includes('virtual') ? 'none' : env.FBRX_V_DRIVER === 'simulated' || env.FBRX_V_DRIVER === 'libvirt' ? env.FBRX_V_DRIVER : hasVirsh() ? 'libvirt' : 'simulated';
  const tlsMode = env.FBRX_V_TLS ?? 'self-signed';
  return {
    host: env.FBRX_V_HOST ?? '0.0.0.0',
    port: Number(env.FBRX_V_PORT ?? VIRTUAL_DEFAULT_PORT),
    dataDir,
    driver,
    roles,
    gate: {
      mode: env.FBRX_V_GATE === 'linux' || env.FBRX_V_GATE === 'simulated' ? env.FBRX_V_GATE : env.FBRX_V_DRIVER === 'simulated' ? 'simulated' : 'linux',
      wan: env.FBRX_V_GATE_WAN ?? 'eth0',
      lan: env.FBRX_V_GATE_LAN ?? 'eth1',
      first: env.FBRX_V_GATE_FIRST === 'commit' ? 'commit' : 'wait',
      manageFromWan: env.FBRX_V_GATE_MANAGE_WAN && isCidr(env.FBRX_V_GATE_MANAGE_WAN) && parseCidr(env.FBRX_V_GATE_MANAGE_WAN)?.family === 4 ? networkOf(env.FBRX_V_GATE_MANAGE_WAN) : null,
      lanAddress: cidr4(env.FBRX_V_GATE_LAN_ADDRESS),
      wanStatic: cidr4(env.FBRX_V_GATE_WAN_ADDRESS) && isIPv4(env.FBRX_V_GATE_WAN_GATEWAY ?? '') ? { address: env.FBRX_V_GATE_WAN_ADDRESS!, gateway: env.FBRX_V_GATE_WAN_GATEWAY! } : null,
    },
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
    core: { url: (env.FBRX_V_CORE_URL ?? `http://127.0.0.1:${DEFAULT_LOCAL_API_PORT}`).replace(/\/+$/, ''), tokenFile: resolve(env.FBRX_V_CORE_TOKEN_FILE ?? '/var/lib/fbrx-core/console.token') },
    time: {
      dir: resolve(env.FBRX_V_TIME_DIR ?? (driver === 'libvirt' ? '/var/lib/fbrx-time' : resolve(dataDir, 'time'))),
      shareFile: resolve(env.FBRX_V_TIME_SHARE_FILE ?? '/etc/fbrx-time/share.env'),
      mode: env.FBRX_V_TIME === 'simulated' || env.FBRX_V_TIME === 'libvirt' ? env.FBRX_V_TIME : driver === 'libvirt' ? 'libvirt' : 'simulated',
    },
    server: {
      command: resolve(env.FBRX_V_SERVER_CMD ?? '/usr/local/sbin/fbrx-server'),
      bundleDir: resolve(env.FBRX_V_BUNDLE_DIR ?? '/opt/fbrx-server/bundle'),
      stateDir: resolve(env.FBRX_V_SERVER_STATE_DIR ?? '/var/lib/fbrx-server-update'),
      logFile: resolve(env.FBRX_V_ROLES_LOG ?? '/var/log/fbrx-server-roles.log'),
      spawn: env.FBRX_V_SPAWN === 'direct' ? 'direct' : 'systemd-run',
    },
    command: {
      envFile: resolve(env.FBRX_V_COMMAND_ENV ?? '/etc/fbrx-command/fbrx-command.env'),
      secretsFile: resolve(env.FBRX_V_COMMAND_SECRETS ?? '/etc/fbrx-command/secrets.env'),
      certFile: resolve(env.FBRX_V_COMMAND_CERT ?? '/var/lib/fbrx-command/tls/command.crt'),
      localUrl: (env.FBRX_V_COMMAND_URL ?? 'http://127.0.0.1:8788').replace(/\/+$/, ''),
    },
    ...overrides,
  };
}
