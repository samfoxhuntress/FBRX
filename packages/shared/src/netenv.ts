/**
 * Network environments: the managed networks an FBRX Endpoint Ultra can attach to (Network Center → Environments),
 * so the person and the agent can see and act on the whole network, not just this computer.
 *
 * The first kind is a UniFi console (Cloud Key, Dream Machine, Cloud Gateway, or UniFi OS Server) through its
 * local UniFi Network API with an API key. The list leaves room for other vendors.
 */

export const NETENV_KINDS = ['unifi'] as const;
export type NetEnvKind = (typeof NETENV_KINDS)[number];
export const NETENV_KIND_NAMES: Record<NetEnvKind, string> = { unifi: 'UniFi Network' };

/** How the console's HTTPS certificate is trusted: by the usual certificate authorities, or by its fingerprint. */
export type NetEnvTrust = 'system' | 'pinned';

export interface NetEnvironment {
  id: string;
  kind: NetEnvKind;
  name: string;
  /** The console's address, e.g. https://192.168.1.1 */
  url: string;
  /** SHA-256 fingerprint of the console's certificate when trust is "pinned". */
  fingerprint: string | null;
  trust: NetEnvTrust;
  /** The site most actions use; null until the first connection lists the sites. */
  defaultSiteId: string | null;
  createdAt: string;
  lastOkAt: string | null;
  lastError: string | null;
  /** Whether an API key is saved in the vault for it. */
  hasKey: boolean;
}

export interface NetEnvInput {
  id?: string;
  kind: NetEnvKind;
  name: string;
  url: string;
  /** Saved in the vault; leave out to keep the saved key. */
  apiKey?: string;
  /** Trust this certificate fingerprint (from a test that met a certificate no authority vouches for). */
  fingerprint?: string | null;
  defaultSiteId?: string | null;
}

/** What "Test connection" found. */
export interface NetEnvProbe {
  ok: boolean;
  /** The console's certificate when no certificate authority vouches for it: confirm the fingerprint to trust it. */
  certificate: { fingerprint: string; subject: string; issuer: string; validTo: string } | null;
  version: string | null;
  sites: NetEnvSite[];
  message: string | null;
}

export interface NetEnvSite {
  id: string;
  name: string;
}

export type NetDeviceState = 'online' | 'offline' | 'updating' | 'pending' | 'other';

export interface NetEnvDevice {
  id: string;
  name: string;
  model: string;
  mac: string;
  ip: string | null;
  state: NetDeviceState;
  /** What it does: gateway, switching, access point… */
  roles: string[];
  firmware: string | null;
  firmwareUpdatable: boolean;
}

export interface NetEnvDeviceStats {
  uptimeSec: number | null;
  cpuPct: number | null;
  memPct: number | null;
  load1: number | null;
  txBps: number | null;
  rxBps: number | null;
  lastHeartbeatAt: string | null;
}

export interface NetEnvClient {
  id: string;
  name: string;
  type: 'wired' | 'wireless' | 'vpn' | 'other';
  ip: string | null;
  mac: string | null;
  connectedAt: string | null;
  uplinkDeviceId: string | null;
}

export interface NetEnvOverview {
  environment: NetEnvironment;
  site: NetEnvSite;
  sites: NetEnvSite[];
  devices: NetEnvDevice[];
  clients: NetEnvClient[];
  fetchedAt: string;
}

export const NETENV_DEVICE_ACTIONS = ['restart'] as const;
export type NetEnvDeviceAction = (typeof NETENV_DEVICE_ACTIONS)[number];

export interface NetEnvVoucher {
  id: string;
  code: string;
  name: string;
  timeLimitMinutes: number | null;
  guestLimit: number | null;
  expired: boolean;
  createdAt: string | null;
}
