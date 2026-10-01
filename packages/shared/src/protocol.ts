import { z } from 'zod';
import { PLATFORMS } from './constants';
import { PolicySchema } from './policy';
import type { DeviceCommand } from './commands';

/** Hardware/OS facts a device reports at enrollment and in heartbeats. */
export const DeviceFactsSchema = z.object({
  name: z.string().max(200),
  hostname: z.string().max(255),
  platform: z.enum(PLATFORMS),
  arch: z.string().max(32),
  osVersion: z.string().max(200),
  appVersion: z.string().max(64),
  /** Stable, non-reversible fingerprint of the hardware (sha256 of machine identifiers). */
  machineId: z.string().max(128),
});
export type DeviceFacts = z.infer<typeof DeviceFactsSchema>;

export const EnrollRequestSchema = z.object({
  token: z.string().min(10),
  protocolVersion: z.number().int(),
  device: DeviceFactsSchema,
  /** Present when a restored snapshot re-attaches to an existing identity. */
  previousDeviceId: z.string().optional(),
});
export type EnrollRequest = z.infer<typeof EnrollRequestSchema>;

export interface EnrollResponse {
  deviceId: string;
  deviceToken: string;
  tenantId: string;
  tenantName: string;
  groupId: string | null;
  heartbeatSeconds: number;
  serverTime: string;
}

export const ServiceHealthSchema = z.object({
  name: z.string(),
  state: z.enum(['stopped', 'starting', 'running', 'degraded', 'failed', 'disabled']),
  message: z.string().nullable().optional(),
});

export const HeartbeatSchema = z.object({
  facts: DeviceFactsSchema,
  configVersion: z.number().int(),
  status: z.object({
    uptimeSeconds: z.number(),
    cpuLoad: z.number(),
    memUsedPct: z.number(),
    memTotalMb: z.number(),
    diskFreeGb: z.number().nullable(),
    services: z.array(ServiceHealthSchema),
    vaultState: z.string(),
    licenseEdition: z.string(),
    licenseState: z.string(),
    activeAgentRuns: z.number().int(),
    pendingApprovals: z.number().int(),
    agentRuns24h: z.number().int(),
    toolCalls24h: z.number().int(),
    policyDenials24h: z.number().int(),
    errors24h: z.number().int(),
    lastBackupAt: z.string().nullable(),
    plugins: z.array(z.object({ id: z.string(), version: z.string(), enabled: z.boolean() })),
    runtimeModel: z.string().nullable(),
    /** Head of the device's hash-chained audit log; anchoring it server-side makes local tampering evident. */
    auditHead: z.object({ seq: z.number().int(), hash: z.string() }),
  }),
});
export type Heartbeat = z.infer<typeof HeartbeatSchema>;

export interface HeartbeatResponse {
  serverTime: string;
  configVersion: number;
  heartbeatSeconds: number;
  commands: DeviceCommand[];
}

export interface ManagedSecret {
  name: string;
  value: string;
  version: number;
  description: string | null;
}

/** The fully-resolved configuration a control plane hands to a device. */
export interface DeviceConfig {
  version: number;
  tenantId: string;
  tenantName: string;
  groupId: string | null;
  groupName: string | null;
  settings: Record<string, unknown>;
  lockedSettings: string[];
  policy: z.infer<typeof PolicySchema> | null;
  license: string | null;
  secrets: ManagedSecret[];
  updateChannel: string;
  pinnedVersion: string | null;
}

export const CommandResultSchema = z.object({
  status: z.enum(['running', 'succeeded', 'failed']),
  result: z.unknown().optional(),
  error: z.string().max(10000).optional(),
});
export type CommandResult = z.infer<typeof CommandResultSchema>;

export const DeviceEventSchema = z.object({
  kind: z.enum(['audit', 'alert', 'state']),
  severity: z.enum(['info', 'warning', 'critical']),
  message: z.string().max(2000),
  data: z.unknown().optional(),
  at: z.string(),
});
export type DeviceEvent = z.infer<typeof DeviceEventSchema>;

/** Messages flowing over the device WebSocket. */
export type ServerToDeviceMessage =
  | { type: 'hello'; serverTime: string; configVersion: number }
  | { type: 'command'; command: DeviceCommand }
  | { type: 'config.changed'; version: number }
  | { type: 'ping'; at: string };

export type DeviceToServerMessage =
  | { type: 'heartbeat'; heartbeat: Heartbeat }
  | { type: 'command.result'; commandId: string; result: CommandResult }
  | { type: 'event'; event: DeviceEvent }
  | { type: 'pong'; at: string };

/** Provisioning file dropped next to an installer (or passed via CLI) for zero-touch enrollment. */
export const ProvisioningFileSchema = z.object({
  fbrxProvisioning: z.literal(1),
  serverUrl: z.string().url(),
  enrollmentToken: z.string().min(10),
  deviceName: z.string().optional(),
  /** Optional golden snapshot to restore before enrolling (cloned, never migrated). */
  templateSnapshotUrl: z.string().url().optional(),
  templateSnapshotPassphrase: z.string().optional(),
});
export type ProvisioningFile = z.infer<typeof ProvisioningFileSchema>;
