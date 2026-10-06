/**
 * Antivirus: what protects this computer. Microsoft Defender, FBRX Shield (FBRX's own antivirus), or an antivirus
 * already installed (Sophos, ESET, CrowdStrike…), chosen by the person or their organization. FBRX shows its status,
 * runs its scans where it can, and warns when it is off or out of date.
 */

export type ProtectionKind = 'shield' | 'defender' | 'product';
export type ProtectionState = 'protected' | 'attention' | 'at-risk' | 'unknown';

/** An antivirus found on this computer. */
export interface AvProduct {
  /** Catalog id ("sophos", "eset", "defender"…) or a slug of its name. */
  id: string;
  name: string;
  /** Real-time protection on (null when FBRX cannot tell). */
  realtime: boolean | null;
  /** Definitions up to date (null when FBRX cannot tell). */
  upToDate: boolean | null;
  /** FBRX can start its scans (it has a command-line scanner FBRX knows). */
  canScan: boolean;
  /** Where FBRX learned about it: Windows Security Center, or its files on disk. */
  source: 'security-center' | 'installed';
}

export interface ProtectionOption {
  /** "auto", "shield", "defender" or "product:<id>". */
  value: string;
  label: string;
  detail: string;
  available: boolean;
}

export interface ShieldStatus {
  engineVersion: string;
  /** Known-malware fingerprints in the threat database. */
  signatures: number;
  signaturesUpdatedAt: string | null;
  signaturesError: string | null;
  /** Folders checked as soon as something new lands in them. */
  watching: string[];
  quarantined: number;
  /** Detections still waiting for a decision. */
  open: number;
  lastScan: { at: string; type: ScanType; files: number; found: number } | null;
  /** Endpoint Ultra: scheduled scans, extra engines (ClamAV, VirusTotal). */
  full: boolean;
  engines: { clamav: boolean; virustotal: boolean };
}

export interface ProtectionStatus {
  /** The setting: "auto", "shield", "defender" or "product:<id>". */
  choice: string;
  /** Set by the organization (FBRX Command) and locked. */
  managed: boolean;
  /** What protects the computer now (the choice, resolved). */
  active: { kind: ProtectionKind; id: string; name: string };
  state: ProtectionState;
  realtime: boolean | null;
  upToDate: boolean | null;
  definitionsAgeDays: number | null;
  lastScan: string | null;
  /** Threats waiting for action (the active antivirus's, or FBRX Shield's). */
  threats: number;
  problems: string[];
  /** What else to know ("Microsoft Defender keeps running underneath"). */
  notes: string[];
  products: AvProduct[];
  options: ProtectionOption[];
  /** The active antivirus can scan from FBRX. */
  canScan: boolean;
  shield: ShieldStatus;
  checkedAt: string;
}

export type ScanType = 'quick' | 'full' | 'custom';
export type ShieldVerdictKind = 'malware' | 'suspicious' | 'test';
export type ShieldEngine = 'signature' | 'heuristic' | 'eicar' | 'clamav' | 'virustotal';
export type ShieldAction = 'open' | 'quarantined' | 'restored' | 'deleted' | 'allowed';

export interface ShieldVerdict {
  kind: ShieldVerdictKind;
  /** A short threat name ("Disguised program", "EICAR test file", a ClamAV signature…). */
  name: string;
  engine: ShieldEngine;
  /** Why, in plain words. */
  reason: string;
}

export interface ShieldDetection extends ShieldVerdict {
  id: string;
  path: string;
  sha256: string | null;
  size: number | null;
  at: string;
  /** How it was found: a scan, a new download, or a file check. */
  source: 'scan' | 'download' | 'check';
  action: ShieldAction;
  actionAt: string | null;
}

/** A scan run by FBRX Shield, Microsoft Defender or another antivirus. */
export interface ScanJob {
  id: string;
  engine: ProtectionKind;
  engineName: string;
  type: ScanType;
  target: string | null;
  state: 'running' | 'done' | 'failed' | 'cancelled';
  startedAt: string;
  finishedAt: string | null;
  /** Files looked at and skipped (FBRX Shield only). */
  files: number;
  skipped: number;
  current: string | null;
  found: number;
  detections: ShieldDetection[];
  /** What another antivirus printed (the end of it). */
  output: string | null;
  error: string | null;
}

export const PROTECTION_DEFAULT_FEED = 'https://bazaar.abuse.ch/export/txt/sha256/recent/';
