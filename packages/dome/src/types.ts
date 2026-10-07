/** How bad: info (worth knowing), warning, serious (likely something wrong), critical (act now). */
export const DOME_SEVERITIES = ['info', 'warning', 'serious', 'critical'] as const;
export type DomeSeverity = (typeof DOME_SEVERITIES)[number];

export const DOME_KINDS = ['new-device', 'bad-domain', 'dga', 'dns-tunnel', 'dns-bypass', 'port-scan', 'beaconing', 'arp-spoof'] as const;
export type DomeKind = (typeof DOME_KINDS)[number];

/** open: needs a look; acknowledged: someone is on it; resolved: done (comes back if it happens again); muted: counted, never raised. */
export const DOME_STATUSES = ['open', 'acknowledged', 'resolved', 'muted'] as const;
export type DomeStatus = (typeof DOME_STATUSES)[number];

/** What MiniDome hears from the gate. */
export type DomeEvent =
  /** A name asked of the gate's DNS. */
  | { type: 'dns'; at: number; client: string; name: string; qtype: string }
  /** The answer was "no such name". */
  | { type: 'nxdomain'; at: number; client: string | null; name: string }
  /** A new connection through (or to) the gate. */
  | { type: 'flow'; at: number; proto: 'tcp' | 'udp'; src: string; dst: string; dport: number }
  /** A device's hardware address, from the gate's neighbor table. */
  | { type: 'neighbor'; at: number; ip: string; mac: string; dev: string | null }
  /** A device given an address by the gate. */
  | { type: 'lease'; at: number; ip: string; mac: string; name: string | null; network: string | null };

export interface DomeDeviceRef {
  ip: string | null;
  mac: string | null;
  name: string | null;
  network: string | null;
}

/** Something a detector noticed; findings collect them (one finding per key, counted). */
export interface DomeSignal {
  key: string;
  kind: DomeKind;
  severity: DomeSeverity;
  title: string;
  detail: string;
  /** The device it is about (by address). */
  ip: string | null;
  mac?: string | null;
  /** A domain, an address and port, … */
  subject: string | null;
  evidence: string[];
}

export interface DomeFinding {
  id: number;
  key: string;
  kind: DomeKind;
  severity: DomeSeverity;
  status: DomeStatus;
  title: string;
  detail: string;
  device: DomeDeviceRef;
  subject: string | null;
  /** The latest few lines of what was seen. */
  evidence: string[];
  firstAt: string;
  lastAt: string;
  count: number;
  /** An FBRX computer it is about was told (through FBRX Mesh). */
  notified: string | null;
}

/** A device MiniDome has seen on the gate's networks. */
export interface DomeDevice {
  mac: string;
  ip: string | null;
  name: string | null;
  network: string | null;
  firstSeen: string;
  lastSeen: string;
  /** Paired with this server on FBRX Mesh: its name and how it is protected (when it lets the gate see that). */
  fbrx: { name: string; protection: { name: string; state: string; realtime: boolean | null; threats: number } | null } | null;
}

export interface DomeSettings {
  enabled: boolean;
  /** How readily detectors speak up. */
  sensitivity: 'low' | 'normal' | 'high';
  /** Threat lists (hosts files or one domain per line) fetched twice a day. */
  feeds: string[];
  /** Domains never reported (their subdomains neither). */
  allow: string[];
  /** Tell FBRX computers on FBRX Mesh about what was seen from them (when they allow it). */
  notifyComputers: boolean;
  /** Report devices the gate has not seen before. */
  newDevices: boolean;
}

export const DEFAULT_DOME_SETTINGS: DomeSettings = { enabled: true, sensitivity: 'normal', feeds: [], allow: [], notifyComputers: true, newDevices: true };

export interface DomeSensorStatus {
  name: string;
  ok: boolean;
  detail: string;
}

export interface DomeStats {
  since: string;
  dnsQueries: number;
  flows: number;
  /** Names asked per minute, the last hour (oldest first). */
  dnsPerMinute: number[];
  devices: number;
  feedDomains: number;
  feedUpdatedAt: string | null;
  feedErrors: string[];
  sensors: DomeSensorStatus[];
}

export interface DomeState {
  mode: 'linux' | 'simulated';
  settings: DomeSettings;
  stats: DomeStats;
  /** Open findings by severity. */
  open: Record<DomeSeverity, number>;
  /** Still learning the network: new devices are not reported yet. */
  learningUntil: string | null;
}

/** A name that is always on MiniDome's threat list, to try it out: ask the gate for it from any device. */
export const DOME_TEST_DOMAIN = 'minidome-test.fbrx.invalid';
