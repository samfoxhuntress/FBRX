import { isCidr, isIPv4, parseCidr } from './net';

/**
 * FBRX VPN: this computer's tunnel to an FBRX Gate's VPN, to reach home from anywhere (the FBRX Server, its AI over
 * FBRX Mesh, the network behind it). The gate makes each device's settings (DNS & VPN → Add a device); FBRX keeps them
 * encrypted with the Vault and runs the tunnel with the computer's own VPN driver.
 */

/** The network interface the tunnel gets (one tunnel at a time). */
export const VPN_INTERFACE = 'fbrxvpn';

/** A device's settings from a gate, as FBRX keeps them (the keys stay sealed in the Vault). */
export interface VpnSettings {
  /** This computer's address in the tunnel, with its size (10.99.0.2/32). */
  address: string;
  /** The gate's name server in the tunnel (its own tunnel address), if given. */
  dns: string | null;
  mtu: number | null;
  privateKey: string;
  peer: {
    publicKey: string;
    presharedKey: string | null;
    /** host:port of the gate on the internet. */
    endpoint: string;
    /** What goes through the tunnel: the gate's networks, or 0.0.0.0/0 for everything. */
    allowedIps: string[];
    keepalive: number | null;
  };
}

/** A saved tunnel, without its keys. */
export interface VpnProfile {
  id: string;
  name: string;
  /** The gate on the internet (host:port). */
  endpoint: string;
  address: string;
  /** The gate's own address in the tunnel (what "Check" pings first). */
  gateAddress: string | null;
  networks: string[];
  /** Everything goes through home, not only your networks. */
  fullTunnel: boolean;
  createdAt: string;
  lastConnectedAt: string | null;
}

export interface VpnStatus {
  /** This computer can run the tunnel; else why not, and whether FBRX can install what is missing. */
  driver: { ready: boolean; why: string | null; canInstall: boolean };
  profiles: VpnProfile[];
  /** The profile whose tunnel is up. */
  connected: string | null;
  state: 'off' | 'connecting' | 'on' | 'error';
  message: string | null;
  since: string | null;
  /** Bytes through the tunnel, where the system tells. */
  received: number | null;
  sent: number | null;
}

/** What answers at home through the tunnel. */
export interface VpnCheck {
  gate: { address: string; ok: boolean; ms: number | null } | null;
  /** Paired FBRX computers with an address behind the tunnel (FBRX Server among them). */
  computers: Array<{ id: string; name: string; address: string; ok: boolean; ms: number | null; mesh: boolean; roles: string[] }>;
}

const KEY = /^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw480]=$/;
const HOST = /^(?:[A-Za-z0-9-]{1,63}\.)*[A-Za-z0-9-]{1,63}$|^\[[0-9a-fA-F:]+\]$/;

/** A WireGuard key (32 bytes, base64). */
export const isVpnKey = (s: string) => KEY.test(s);

/**
 * Reads a device's settings file from a gate, strictly: only the settings a tunnel needs. Lines that run commands
 * (PreUp, PostUp, PreDown, PostDown) are refused, since the tunnel starts with administrator rights.
 */
export function parseVpnSettings(text: string): VpnSettings {
  const sections: Array<{ name: string; values: Map<string, string> }> = [];
  for (const raw of text.replace(/\r/g, '').split('\n')) {
    const line = raw.replace(/[#;].*$/, '').trim();
    if (!line) continue;
    const head = /^\[(\w+)\]$/.exec(line);
    if (head) {
      sections.push({ name: head[1]!.toLowerCase(), values: new Map() });
      continue;
    }
    const kv = /^([A-Za-z]+)\s*=\s*(.+)$/.exec(line);
    if (!kv || !sections.length) throw new Error(`Not a VPN settings file (at "${raw.trim().slice(0, 40)}")`);
    const key = kv[1]!.toLowerCase();
    if (/^(pre|post)(up|down)$/.test(key)) throw new Error(`The settings run a command (${kv[1]}): FBRX does not use those`);
    sections.at(-1)!.values.set(key, kv[2]!.trim());
  }
  const iface = sections.filter((s) => s.name === 'interface');
  const peers = sections.filter((s) => s.name === 'peer');
  if (iface.length !== 1) throw new Error('The settings need one [Interface] section');
  if (peers.length !== 1) throw new Error('The settings need one [Peer] section (the gate)');
  const i = iface[0]!.values;
  const p = peers[0]!.values;
  const allowed = { interface: ['privatekey', 'address', 'dns', 'mtu', 'listenport'], peer: ['publickey', 'presharedkey', 'endpoint', 'allowedips', 'persistentkeepalive'] };
  for (const k of i.keys()) if (!allowed.interface.includes(k)) throw new Error(`FBRX does not use the setting ${k} in [Interface]`);
  for (const k of p.keys()) if (!allowed.peer.includes(k)) throw new Error(`FBRX does not use the setting ${k} in [Peer]`);

  const privateKey = i.get('privatekey') ?? '';
  if (!isVpnKey(privateKey)) throw new Error('The settings have no private key (the gate shows it only once, when it makes the device)');
  const address = (i.get('address') ?? '').split(',')[0]!.trim();
  const withSize = address.includes('/') ? address : `${address}/32`;
  if (!isCidr(withSize) || parseCidr(withSize)?.family !== 4) throw new Error('The settings have no IPv4 address for this computer');
  const dns = (i.get('dns') ?? '').split(',')[0]!.trim() || null;
  if (dns && !isIPv4(dns)) throw new Error(`The name server ${dns} is not an IPv4 address`);
  const mtu = i.has('mtu') ? Number(i.get('mtu')) : null;
  if (mtu !== null && !(mtu >= 1280 && mtu <= 9000)) throw new Error('The MTU must be between 1280 and 9000');

  const publicKey = p.get('publickey') ?? '';
  if (!isVpnKey(publicKey)) throw new Error("The settings have no key for the gate");
  const presharedKey = p.get('presharedkey') ?? null;
  if (presharedKey !== null && !isVpnKey(presharedKey)) throw new Error('The preshared key is not a valid key');
  const endpoint = p.get('endpoint') ?? '';
  const ep = /^(.+):(\d{1,5})$/.exec(endpoint);
  if (!ep || !HOST.test(ep[1]!) || Number(ep[2]) < 1 || Number(ep[2]) > 65535) throw new Error('The settings have no address for the gate (Endpoint = host:port)');
  if (/^YOUR-/i.test(ep[1]!)) throw new Error("The gate did not know its internet address: put yours (or its name) after Endpoint =");
  const allowedIps = (p.get('allowedips') ?? '').split(',').map((a) => a.trim()).filter(Boolean);
  if (!allowedIps.length || allowedIps.some((a) => !isCidr(a) || parseCidr(a)?.family !== 4)) throw new Error('The settings must say which IPv4 networks go through the tunnel (AllowedIPs)');
  const keepalive = p.has('persistentkeepalive') ? Number(p.get('persistentkeepalive')) : null;
  if (keepalive !== null && !(keepalive >= 0 && keepalive <= 3600)) throw new Error('PersistentKeepalive must be between 0 and 3600 seconds');
  return { address: withSize, dns, mtu, privateKey, peer: { publicKey, presharedKey, endpoint, allowedIps, keepalive } };
}

/** The settings file the tunnel runs from: rebuilt from what was read, so nothing else slips in. */
export function renderVpnSettings(s: VpnSettings, o: { dns: boolean }): string {
  return [
    '[Interface]',
    `PrivateKey = ${s.privateKey}`,
    `Address = ${s.address}`,
    ...(o.dns && s.dns ? [`DNS = ${s.dns}`] : []),
    ...(s.mtu ? [`MTU = ${s.mtu}`] : []),
    '',
    '[Peer]',
    `PublicKey = ${s.peer.publicKey}`,
    ...(s.peer.presharedKey ? [`PresharedKey = ${s.peer.presharedKey}`] : []),
    `Endpoint = ${s.peer.endpoint}`,
    `AllowedIPs = ${s.peer.allowedIps.join(', ')}`,
    ...(s.peer.keepalive ? [`PersistentKeepalive = ${s.peer.keepalive}`] : []),
    '',
  ].join('\n');
}
