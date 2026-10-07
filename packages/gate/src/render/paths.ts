/** Where FBRX Gate keeps what it makes (tests point these into a temporary folder). */
export interface GatePaths {
  /** Leases, the downloaded blocklist. */
  varDir: string;
  /** dnsmasq's question log (FBRX MiniDome reads it). */
  logDir: string;
  /** The firewall file loaded at boot, the VPN key. */
  etcDir: string;
}

export const DEFAULT_PATHS: GatePaths = { varDir: '/var/lib/fbrx-gate', logDir: '/var/log/fbrx-gate', etcDir: '/etc/fbrx-gate' };
