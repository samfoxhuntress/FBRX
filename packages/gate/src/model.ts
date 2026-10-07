import { z } from 'zod';
import { isIPv4, MESH_TRAFFIC_CLASSES, parseCidr } from '@fbrx/shared';

/**
 * The FBRX Gate configuration: everything the firewall does, in one document. People (the console, the fbrx-gate
 * command) edit a candidate copy; a commit checks it, turns it into nftables, dnsmasq, systemd-networkd and tc
 * settings, applies them and keeps the history (see engine.ts).
 */

/** Network and zone names: short, because they become nftables, dnsmasq and interface identifiers. */
export const NAME = z.string().regex(/^[a-z][a-z0-9-]{0,14}$/, 'Use a short lower-case name (letters, digits, dashes; 15 at most)');
/** A Linux interface name (15 characters at most). */
export const IFNAME = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,14}$/, 'Not an interface name (15 characters at most)');
export const IPV4 = z.string().refine(isIPv4, 'Enter an IPv4 address like 192.168.1.10');
export const CIDR4 = z.string().refine((s) => parseCidr(s)?.family === 4, 'Enter an IPv4 network like 192.168.1.1/24');
export const MAC = z.string().regex(/^([0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}$/, 'Enter a MAC address like aa:bb:cc:dd:ee:ff');
/** Ports: 22, 80,443 or 6000-6100 (a mix is fine). */
export const PORTS = z
  .string()
  .regex(/^\d{1,5}(-\d{1,5})?(,\s*\d{1,5}(-\d{1,5})?)*$/, 'Enter ports like 443, 80,443 or 6000-6100')
  .refine((s) => s.split(',').every((p) => p.split('-').every((n) => Number(n) >= 1 && Number(n) <= 65535)), 'Ports go from 1 to 65535');
export const HOSTNAME = z.string().regex(/^(?=.{1,253}$)([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)*[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/, 'Not a host or domain name');
const ID = z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/);
const TEXT = z.string().max(200);

export const PURPOSES = ['lan', 'guest', 'mesh', 'servers', 'iot', 'management', 'other'] as const;
export type NetworkPurpose = (typeof PURPOSES)[number];
/** What a network may reach on its own (rules add exceptions): everything, the internet only, or nothing outside. */
export const ACCESS = ['full', 'internet', 'isolated'] as const;
/** Names a network may not take: the other zones. */
export const RESERVED_ZONES = ['wan', 'vpn', 'gate', 'any'] as const;

export const InterfaceSchema = z.object({
  name: IFNAME,
  kind: z.enum(['ethernet', 'vlan']),
  /** VLANs: the port they ride on, and their tag. */
  parent: IFNAME.optional(),
  vlanId: z.number().int().min(1).max(4094).optional(),
  /** 1500 normally; 9000 for jumbo frames (a mesh or storage VLAN, say). */
  mtu: z.number().int().min(576).max(9216),
  description: TEXT.default(''),
});
export type GateInterface = z.infer<typeof InterfaceSchema>;

export const WanSchema = z.object({
  interface: IFNAME,
  mode: z.enum(['dhcp', 'static']),
  address: CIDR4.optional(),
  gateway: IPV4.optional(),
  /** Answer pings from the internet. */
  ping: z.boolean(),
});

export const ReservationSchema = z.object({ mac: MAC, address: IPV4, name: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9-]{0,62}$/, 'Use letters, digits and dashes').optional() });

export const NetworkSchema = z.object({
  name: NAME,
  purpose: z.enum(PURPOSES),
  interface: IFNAME,
  /** The gate's own address in the network, with its size (192.168.1.1/24). */
  address: CIDR4,
  access: z.enum(ACCESS),
  /** Devices here may reach the gate's console and SSH. */
  manage: z.boolean(),
  dhcp: z.object({
    enabled: z.boolean(),
    start: IPV4,
    end: IPV4,
    leaseHours: z.number().int().min(1).max(720),
    reservations: z.array(ReservationSchema).max(512),
  }),
  description: TEXT.default(''),
});
export type GateNetwork = z.infer<typeof NetworkSchema>;

/** A zone: a network's name, "wan" (the internet), "vpn" (remote devices), "gate" (the gate itself) or "any". */
export const ZONE = z.string().regex(/^[a-z][a-z0-9-]{0,14}$/);

export const RuleSchema = z.object({
  id: ID,
  name: z.string().min(1).max(80),
  enabled: z.boolean(),
  from: ZONE,
  to: ZONE,
  proto: z.enum(['any', 'tcp', 'udp', 'tcp+udp', 'icmp']),
  /** Destination ports (TCP/UDP rules only). */
  ports: PORTS.optional(),
  source: CIDR4.optional(),
  destination: CIDR4.optional(),
  action: z.enum(['accept', 'drop', 'reject']),
  log: z.boolean(),
});
export type GateRule = z.infer<typeof RuleSchema>;

export const ForwardSchema = z.object({
  id: ID,
  name: z.string().min(1).max(80),
  enabled: z.boolean(),
  proto: z.enum(['tcp', 'udp', 'tcp+udp']),
  /** The port (or range) on the internet side. */
  port: PORTS,
  /** The device inside that receives it. */
  to: IPV4,
  /** Its port, when different (single ports only). */
  toPort: z.number().int().min(1).max(65535).optional(),
  /** Only from this network on the internet. */
  source: CIDR4.optional(),
});
export type GateForward = z.infer<typeof ForwardSchema>;

export const PeerSchema = z.object({
  name: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9 ._-]{0,39}$/, 'Use letters, digits, spaces, dots and dashes'),
  /** The device's WireGuard public key (base64, 44 characters). */
  publicKey: z.string().regex(/^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw480]=$/, 'Not a WireGuard public key'),
  address: IPV4,
  keepalive: z.number().int().min(0).max(600).default(25),
});
export type GatePeer = z.infer<typeof PeerSchema>;

export const GateConfigSchema = z.object({
  version: z.literal(1),
  hostname: HOSTNAME,
  interfaces: z.array(InterfaceSchema).min(1).max(64),
  wan: WanSchema,
  networks: z.array(NetworkSchema).max(32),
  firewall: z.object({
    rules: z.array(RuleSchema).max(500),
    forwards: z.array(ForwardSchema).max(200),
  }),
  dns: z.object({
    /** Where the gate sends questions it cannot answer itself. */
    upstream: z.array(IPV4).min(1).max(4),
    /** The local domain: a device named nas is nas.lan. */
    domain: HOSTNAME,
    records: z.array(z.object({ name: HOSTNAME, address: IPV4 })).max(1000),
    block: z.object({
      enabled: z.boolean(),
      /** Blocklists (hosts or plain domain lists) fetched now and then. */
      lists: z.array(z.string().url().max(500)).max(16),
      domains: z.array(HOSTNAME).max(5000),
    }),
    /** Keep a log of questions (FBRX MiniDome reads it to spot threats). */
    logQueries: z.boolean(),
  }),
  vpn: z.object({
    enabled: z.boolean(),
    port: z.number().int().min(1).max(65535),
    /** The gate's address in the tunnel, with its size (10.99.0.1/24). */
    address: CIDR4,
    access: z.enum(['full', 'internet']),
    peers: z.array(PeerSchema).max(250),
  }),
  qos: z.object({
    enabled: z.boolean(),
    /** Your internet line, in megabits per second (a little under what it really does). */
    upload: z.number().min(0.1).max(100_000),
    /** 0 leaves downloads alone (shaping them needs the ifb kernel module). */
    download: z.number().min(0).max(100_000),
    /**
     * Prefer Mesh: traffic between FBRX computers (port 47800, Mesh Assist included) and everything from the mesh
     * networks is marked with the traffic class and goes first.
     */
    preferMesh: z.object({
      enabled: z.boolean(),
      trafficClass: z.enum(MESH_TRAFFIC_CLASSES),
      port: z.number().int().min(1).max(65535),
      networks: z.array(NAME).max(8),
    }),
  }),
  management: z.object({
    ssh: z.boolean(),
    consolePort: z.number().int().min(1).max(65535),
  }),
});
export type GateConfig = z.infer<typeof GateConfigSchema>;

/** A first configuration: the internet on one port (DHCP), your network on another, nothing else open. */
export function starterConfig(o: { hostname?: string; wan: string; lan: string; lanAddress?: string } = { wan: 'eth0', lan: 'eth1' }): GateConfig {
  const lan = o.lanAddress ?? '192.168.1.1/24';
  const base = lan.split('/')[0].split('.').slice(0, 3).join('.');
  return {
    version: 1,
    hostname: o.hostname ?? 'fbrx-gate',
    interfaces: [
      { name: o.wan, kind: 'ethernet', mtu: 1500, description: 'Internet' },
      { name: o.lan, kind: 'ethernet', mtu: 1500, description: 'Your network' },
    ],
    wan: { interface: o.wan, mode: 'dhcp', ping: false },
    networks: [
      {
        name: 'lan',
        purpose: 'lan',
        interface: o.lan,
        address: lan,
        access: 'full',
        manage: true,
        dhcp: { enabled: true, start: `${base}.100`, end: `${base}.199`, leaseHours: 12, reservations: [] },
        description: 'Your network',
      },
    ],
    firewall: { rules: [], forwards: [] },
    dns: { upstream: ['1.1.1.1', '9.9.9.9'], domain: 'lan', records: [], block: { enabled: false, lists: [], domains: [] }, logQueries: true },
    vpn: { enabled: false, port: 51820, address: '10.99.0.1/24', access: 'full', peers: [] },
    qos: { enabled: false, upload: 20, download: 0, preferMesh: { enabled: true, trafficClass: 'af41', port: 47800, networks: [] } },
    management: { ssh: true, consolePort: 9443 },
  };
}

/** Network presets the console offers when adding one (a VLAN on the LAN port). */
export const NETWORK_PRESETS: Record<NetworkPurpose, { access: (typeof ACCESS)[number]; manage: boolean; mtu: number; hint: string }> = {
  lan: { access: 'full', manage: true, mtu: 1500, hint: 'Your own computers: they reach everything.' },
  guest: { access: 'internet', manage: false, mtu: 1500, hint: 'Visitors: the internet only, kept away from your devices.' },
  mesh: { access: 'full', manage: true, mtu: 9000, hint: 'FBRX computers and servers helping each other (Prefer Mesh): priority, and jumbo frames when your switch takes them.' },
  servers: { access: 'full', manage: true, mtu: 1500, hint: 'Servers: reachable from your network, reaching the internet.' },
  iot: { access: 'internet', manage: false, mtu: 1500, hint: 'Cameras, TVs and smart plugs: the internet only.' },
  management: { access: 'full', manage: true, mtu: 1500, hint: 'Switches, iDRACs and access points: only you reach them.' },
  other: { access: 'internet', manage: false, mtu: 1500, hint: 'Anything else.' },
};
