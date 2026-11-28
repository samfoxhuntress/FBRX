import { z } from 'zod';

/**
 * FBRX Server high availability: two FBRX Servers (virtual machines or hosts) as one pair. The active one serves; the
 * standby keeps a copy and takes over when the active one stops answering. They hear each other on up to two paths (a
 * dedicated link between them, and the network) and a third vote (FBRX Command, or another FBRX Server) makes sure
 * the two are never active at once.
 */

/** The UDP port the pair's heartbeat uses. */
export const HA_HEARTBEAT_PORT = 9454;
/** How often each server says it is there. */
export const HA_HEARTBEAT_MS = 200;
/** How long without a word before the standby takes over (adjustable). */
export const HA_TAKEOVER_MS = 1000;

/** Which one the pair prefers to serve: the primary, unless it is down. */
export type HaPreference = 'primary' | 'standby';

/**
 * What a server does in its pair: single (not paired), starting (listening before it decides), active (serving),
 * standby (keeping its copy, ready), stopped (it lost its partner and the third vote, so it stopped serving rather
 * than risk two active servers).
 */
export type HaState = 'single' | 'starting' | 'active' | 'standby' | 'stopped';

export const HA_STATE_NAMES: Record<HaState, string> = {
  single: 'Not paired',
  starting: 'Starting',
  active: 'Active',
  standby: 'Standby',
  stopped: 'Stopped (no partner, no third vote)',
};

/** A way the two hear each other: the dedicated link, or the network. */
export interface HaPath {
  name: 'link' | 'network';
  /** The partner's address on it (host:port of its heartbeat). */
  address: string;
  up: boolean;
  lastHeardAt: string | null;
}

export interface HaPartner {
  name: string;
  url: string;
  fingerprint: string;
  version: string;
  preference: HaPreference;
  /** What it last said it was doing (null: not heard since this server started). */
  state: HaState | null;
  term: number;
  heard: boolean;
  lastHeardAt: string | null;
}

export interface HaWitnessView {
  url: string;
  fingerprint: string | null;
  ok: boolean;
  lastAt: string | null;
  /** Who holds the pair's lease, as the third vote last said. */
  holder: 'me' | 'partner' | null;
  error: string | null;
}

export type HaEventKind = 'paired' | 'unpaired' | 'takeover' | 'switchover' | 'handback' | 'stopped' | 'resumed' | 'partner-lost' | 'partner-back' | 'both-active' | 'third-vote';

export interface HaStep {
  at: string;
  text: string;
}

export interface HaEvent {
  id: number;
  at: string;
  kind: HaEventKind;
  text: string;
  steps: HaStep[];
}

export const HaSettingsSchema = z.object({
  /** How long without a word before the standby takes over, in milliseconds. */
  takeoverMs: z.number().int().min(600).max(30_000),
  /** Hand the work back to the primary by itself once it is back and has caught up. */
  autoHandBack: z.boolean(),
  /** This server's address on a dedicated link to its partner (a cable between the two), when there is one. */
  linkAddress: z.string().trim().max(64).nullable(),
});
export type HaSettings = z.infer<typeof HaSettingsSchema>;

export const HA_DEFAULT_SETTINGS: HaSettings = { takeoverMs: HA_TAKEOVER_MS, autoHandBack: false, linkAddress: null };

/** How a role's copy stands: on the active server how far behind the standby is, on the standby how current it is. */
export interface HaCopyView {
  name: string;
  label: string;
  /** waiting: not heard from the other yet; full-copy: everything is being copied again; copying: changes on the way. */
  state: 'caught-up' | 'copying' | 'full-copy' | 'waiting';
  /** Changes the standby does not have yet, and for how long the oldest has waited (ms). */
  behind: number;
  behindMs: number | null;
  /** On the standby: its copy is current as of then. */
  currentAt: string | null;
}

export interface HaStatus {
  /** Whether this server can be paired (it needs HTTPS). */
  available: boolean;
  reason: string | null;
  me: { name: string; preference: HaPreference | null; state: HaState; term: number; since: string };
  partner: HaPartner | null;
  paths: HaPath[];
  witness: HaWitnessView | null;
  /** The roles' data: how it is copied, role by role. */
  copy: HaCopyView[];
  settings: HaSettings;
  /** A pairing code this server made, while it is open. */
  code: { expiresAt: string } | null;
  /** The keys this server hands out as a third vote for other pairs. */
  witnessKeys: Array<{ id: string; label: string; createdAt: string; lastUsedAt: string | null }>;
  events: HaEvent[];
  lastDrill: HaEvent | null;
  /** What could go wrong with this setup, in words. */
  warnings: string[];
}

/** What a heartbeat carries (signed with the pair's secret). */
export interface HaBeat {
  /** The pair. */
  p: string;
  /** The sender. */
  n: string;
  /** The sender's run (a new one each start), and its count within the run. */
  b: string;
  s: number;
  /** Its term (raised at each takeover), state and preference. */
  t: number;
  st: HaState;
  pr: HaPreference;
  /** Whether it hears the receiver. */
  h: boolean;
  /** When it was sent (ms since 1970). */
  ts: number;
}

/** A pairing code, as people type it: no letters that read like others. */
export const HA_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const haNormalCode = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '');

/** A third-vote key: what a pair needs to ask a third vote (its id and secret, in one string to paste). */
export const HA_WITNESS_KEY = /^fbrxw1\.([A-Za-z0-9_-]{8,40})\.([A-Za-z0-9_-]{32,64})$/;

/** What a pair asks its third vote: hold (or keep) the pair's lease for a while, or give it up. */
export const HaLeaseRequestSchema = z.object({
  /** The third-vote key's id. */
  id: z.string().min(8).max(40),
  /** The server asking (its node id in the pair). */
  node: z.string().min(8).max(64),
  term: z.number().int().min(0),
  leaseMs: z.number().int().min(500).max(30_000),
  release: z.boolean().optional(),
});
export type HaLeaseRequest = z.infer<typeof HaLeaseRequestSchema>;

export interface HaLeaseAnswer {
  granted: boolean;
  /** Who holds it now, and its term. */
  holder: string | null;
  term: number;
  /** For how long more the holder has it (when someone else holds it). */
  remainingMs: number;
}
