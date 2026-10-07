import type { GateConfig } from './model';
import type { GateIssue } from './validate';
import type { GateChange } from './diff';

export type GateCommitStatus = 'applied' | 'confirmed' | 'rolled-back' | 'failed';

export interface GateCommit {
  id: number;
  at: string;
  by: string;
  comment: string;
  status: GateCommitStatus;
  /** A commit that rolls itself back unless confirmed by then. */
  confirmBy: string | null;
  error: string | null;
  /** How many things it changed. */
  changes: number;
}

export interface GateState {
  /** What runs now (null until the first commit). */
  running: GateConfig | null;
  /** What is being edited. */
  candidate: GateConfig;
  /** Differences between them (what a commit would do). */
  changes: GateChange[];
  errors: GateIssue[];
  warnings: GateIssue[];
  /** A commit waiting to be confirmed: it rolls back at the deadline. */
  confirm: { commitId: number; deadline: string } | null;
  lastCommit: GateCommit | null;
  /** The VPN's public key (made on the first commit with the VPN on). */
  vpnPublicKey: string | null;
}

export interface GateInterfaceLive {
  name: string;
  up: boolean;
  mtu: number;
  mac: string | null;
  addresses: string[];
  rxBytes: number;
  txBytes: number;
  rxPackets: number;
  txPackets: number;
}

export interface GateLease {
  expires: string | null;
  mac: string;
  address: string;
  name: string | null;
  network: string | null;
}

export interface GateLive {
  at: string;
  interfaces: GateInterfaceLive[];
  wan: { address: string | null; gateway: string | null };
  leases: GateLease[];
  /** Packet counters of the firewall rules, by rule id (and "default:input", "default:forward", "forward:<id>"). */
  counters: Record<string, { packets: number; bytes: number }>;
  qos: { kind: 'cake' | 'htb' | null; detail: string | null };
  dns: { running: boolean };
  conntrack: number | null;
  vpn: Array<{ publicKey: string; endpoint: string | null; latestHandshake: string | null; rxBytes: number; txBytes: number }>;
  problems: string[];
}
